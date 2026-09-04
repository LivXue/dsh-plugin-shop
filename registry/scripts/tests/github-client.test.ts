import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BUNDLE_NAME_MAX_LENGTH, BUNDLE_NAME_RE, GITHUB_REQUEST_TIMEOUT_MS, MAX_MANIFEST_BYTES, MAX_TARBALL_BYTES, MAX_THROWN_FRACTION, MIN_THROWN_TO_BOUND, TARBALL_REQUEST_TIMEOUT_MS, fetchRepoCandidate, harvestRepos, isBundleName, partitionTopic, searchReposByTopic } from '../src/github-client.ts'
import { parseRepoState, serializeRepoState } from '../src/repo-state.ts'
import type { RepoState } from '../src/repo-state.ts'
import type { RepoCandidate } from '../src/types.ts'
import { FetchTimeoutError } from '../src/npm-client.ts'
import { headersThenBodyError, headersThenSlowBody, headersThenStalledBody, slowBodyBytes } from './stalling-fetch.ts'

const sleep = async (_ms: number) => {}
const commit = 'b'.repeat(40)

/** A fetch stub routing by URL: search API, commits API, raw manifests. */
function stubFetch(routes: Record<string, Response>): typeof fetch {
  const impl = (async (url: string | URL) => {
    for (const [prefix, response] of Object.entries(routes)) {
      if (String(url).startsWith(prefix)) return response
    }
    throw new Error(`unrouted url: ${String(url)}`)
  }) as unknown as typeof fetch
  return impl
}

/** A search stub that answers total probes (per_page=1) and page fetches. */
function stubSearch(pages: Record<string, Array<{ full_name: string }>>, totals?: Record<string, number>): typeof fetch {
  const impl = (async (url: string | URL) => {
    const text = String(url)
    if (new URL(text).searchParams.get('per_page') === '1') {
      const q = new URL(text).searchParams.get('q') ?? ''
      const total = totals?.[q] ?? 0
      return new Response(JSON.stringify({ total_count: total }), { status: 200 })
    }
    const q = new URL(text).searchParams.get('q') ?? ''
    const items = (pages[q] ?? []).map(full_name => ({
      full_name,
      default_branch: 'main',
      description: `description of ${full_name}`,
      license: { spdx_id: 'MIT' },
      pushed_at: '2026-08-01T00:00:00Z',
    }))
    return new Response(JSON.stringify({ items }), { status: 200 })
  }) as unknown as typeof fetch
  return impl
}

describe('partitionTopic', () => {
  it('keeps a small pool as one window', async () => {
    const probes: string[] = []
    const windows = await partitionTopic('dsh-plugin', async q => { probes.push(q); return 500 })
    expect(windows).toEqual([{}])
    expect(probes).toEqual(['topic:dsh-plugin'])
  })

  it('splits an oversized pool by stars, then by created date, and throws when exhausted', async () => {
    const totals: Record<string, number> = {
      'topic:dsh-plugin': 3000,
      'topic:dsh-plugin stars:0': 1500,
      'topic:dsh-plugin stars:>=1': 1500,
      'topic:dsh-plugin stars:0 created:2008-01-01..2099-01-01': 1500,
    }
    const probe = async (q: string) => totals[q] ?? 0
    const windows = await partitionTopic('dsh-plugin', probe)
    // every window probed at or under the cap
    for (const w of windows) {
      const q = `topic:dsh-plugin${w.stars ? ` stars:${w.stars}` : ''}${w.created ? ` created:${w.created}` : ''}${w.size ? ` size:${w.size}` : ''}`
      expect(totals[q] ?? 0).toBeLessThanOrEqual(1000)
    }
    // stars split happened: no window lacks the stars qualifier
    expect(windows.every(w => w.stars !== undefined)).toBe(true)
  })

  it('throws rather than truncating when every split dimension is exhausted', async () => {
    const probe = async () => 5000
    await expect(partitionTopic('dsh-plugin', probe)).rejects.toThrow(/still exceeds/)
  })
})

describe('searchReposByTopic', () => {
  it('searches both topics through the windows, deduplicates, and sorts', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      urls.push(text)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (decodeURIComponent(new URL(text).searchParams.get('q') ?? '').includes('topic:dsh-plugin')) {
        return new Response(JSON.stringify({ items: ['zeta/plugin', 'alpha/plugin'].map(full_name => ({ full_name, default_branch: 'main', description: null, license: null, pushed_at: '2026-08-01T00:00:00Z' })) }), { status: 200 })
      }
      return new Response(JSON.stringify({ items: ['alpha/plugin', 'beta/plugin'].map(full_name => ({ full_name, default_branch: 'main', description: null, license: null, pushed_at: '2026-08-01T00:00:00Z' })) }), { status: 200 })
    }) as unknown as typeof fetch
    const { seen, metas, windowCount } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(seen.map(s => s.repo)).toEqual(['alpha/plugin', 'beta/plugin', 'zeta/plugin'])
    expect(metas.has('alpha/plugin')).toBe(true)
    expect(windowCount).toBeGreaterThanOrEqual(2)
    expect(urls.some(u => decodeURIComponent(u).includes('topic:dsh-plugin'))).toBe(true)
    expect(urls.some(u => decodeURIComponent(u).includes('topic:deepseek-harness'))).toBe(true)
  })

  it('drops search items the schema cannot trust', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (new URL(String(url)).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      return new Response(JSON.stringify({
        items: [{ full_name: 'ok/repo', default_branch: 'main', pushed_at: '2026-08-01T00:00:00Z' }, { full_name: 42 }],
      }), { status: 200 })
    }) as unknown as typeof fetch
    const { seen } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(seen.map(s => s.repo)).toEqual(['ok/repo'])
  })

  it('fails loudly when the search API answers with an error status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    await expect(searchReposByTopic(fetchImpl, sleep, 'token')).rejects.toThrow(/403/)
  })
})

describe('fetchRepoCandidate', () => {
  const meta = { fullName: 'someone/dsh-repo-plugin', defaultBranch: 'main', description: 'A repo plugin.', license: 'MIT', pushedAt: '2026-08-01T00:00:00Z', stars: null as number | null }

  it('projects a repository into a candidate with the pinned commit', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
        name: 'dsh-repo-plugin',
        description: 'From the manifest.',
        dsh: { bundle: { patch: './cordis.patch.yml' }, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.name).toBe('dsh-repo-plugin')
      expect(result.candidates[0]?.repo).toBe('someone/dsh-repo-plugin')
      expect(result.candidates[0]?.commit).toBe(commit)
      expect(result.candidates[0]?.requiresBuild).toBe(false)
    }
  })

  it('reports no-manifest when the repo has no package.json', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response('404: Not Found', { status: 404 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no-manifest')
  })

  it('rejects a package.json of exactly `null` instead of taking the build down', async () => {
    // Four bytes -- `null` -- is legal JSON, so readManifest returns it as a
    // parsed manifest, and projectCandidate's `manifest as {...}` cast then
    // read `.scripts` off it and threw. harvestRepos has no per-repo try, and
    // build.ts retries the whole harvest once and rethrows, so any public repo
    // the keyword search finds could stop the entire daily catalog. Every
    // other odd body -- 123, "a string", true, [] -- was already handled; only
    // null threw, because only null survives `typeof x === 'object'`.
    for (const body of ['null', '123', '"a string"', 'true', '[]']) {
      const fetchImpl = stubFetch({
        'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(body, { status: 200 }),
        'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
          sha: commit,
          commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
        }), { status: 200 }),
      })
      const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
      expect(result.ok, `body ${body}`).toBe(false)
      if (!result.ok) expect(result.code, `body ${body}`).toBe('no-manifest')
    }
  })

  it('reports fetch-failed when the head commit cannot be resolved', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({ name: 'dsh-repo-plugin', dsh: { bundle: {} } }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response('nope', { status: 404 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('fetch-failed')
  })

  it('rejects a manifest name outside the package-name grammar, with its own detail', async () => {
    // `projectCandidate` accepted any non-empty string and `gateRepo` never
    // checked the shape, so `Skills Manager` and `{{PKG_NAME}}` are already in
    // the committed repo-state. A name carrying a quote, a newline, a space or
    // a backslash is what breaks the two bot-written YAML files.
    for (const name of ['dsh-"quote', 'dsh-a"\n  category: tool', 'dsh-trailing\\', 'dsh-b" # comment', 'Skills Manager', '{{PKG_NAME}}']) {
      const fetchImpl = stubFetch({
        'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
          name,
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }), { status: 200 }),
        'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
          sha: commit,
          commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
        }), { status: 200 }),
      })
      const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('no-manifest')
        expect(result.detail).toContain('is not a usable package name')
      }
    }
  })

  it('refuses a grammar-legal name past the length bound, which the manifest cap alone would admit', async () => {
    // BUNDLE_NAME_RE has no length limit of its own — `a+` matches a million
    // of them — and the only other bound on this value is MAX_MANIFEST_BYTES,
    // which admits about a megabyte. So the length clause in isBundleName is
    // the ONLY thing standing between a hostile manifest and a 300 KB name in
    // first-seen.yml, categories.yml, markets.yml, manifest.lock, the
    // published entry and the build report — the six artifacts that clause's
    // own comment names. Nothing asserted it: removing it left the suite
    // green.
    expect(isBundleName('a'.repeat(BUNDLE_NAME_MAX_LENGTH))).toBe(true)
    expect(isBundleName('a'.repeat(BUNDLE_NAME_MAX_LENGTH + 1))).toBe(false)
    expect(isBundleName(`@${'s'.repeat(BUNDLE_NAME_MAX_LENGTH)}/p`)).toBe(false)

    // …and end to end, at a size the manifest cap really does let through.
    const huge = 'a'.repeat(300_000)
    expect(huge.length).toBeLessThan(MAX_MANIFEST_BYTES) // the cap would not have caught it
    expect(BUNDLE_NAME_RE.test(huge)).toBe(true) // nor would the grammar
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
        name: huge,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no-manifest')
  })

  it('echoes only the head of an unusable name into the published rejection detail', async () => {
    // The detail is published: it reaches report.md on Pages, which is where
    // an author reads why their repository is not listed. The manifest cap
    // admits about a megabyte, so without the echo cap a name that long is
    // copied verbatim into that page — and into every row that quotes it.
    // Nothing asserted the cap either.
    const badName = `${'a'.repeat(40)} ${'b'.repeat(5_000)}` // the space is what fails the grammar
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
        name: badName,
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.detail).toContain(badName.slice(0, 80)) // enough to recognise the name
      expect(result.detail).not.toContain(badName.slice(0, 81)) // and not one character more
      expect(result.detail.length).toBeLessThan(300) // the whole row, not just the echo
    }
  })

  it('still accepts an uppercase manifest name — a bundle name is not an npm publication', async () => {
    // npm forbids uppercase in a NEW publication; a GitHub bundle name is not
    // one, and rejecting DSH-FS-TOOL would drop a repository that installs
    // fine. Case folding on the repo channel is B-8's job, not this gate's.
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
        name: 'DSH-FS-TOOL',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates[0]?.name).toBe('DSH-FS-TOOL')
  })

  it('refuses a manifest body past the cap instead of holding it in memory', async () => {
    // The raw manifest name and the raw, unvalidated dsh.catalog value are
    // stored verbatim in the committed repo-state.json even when the gate
    // later rejects them, and the body was read with no cap at all — unlike
    // the tarball reader's 32 MB one.
    const huge = JSON.stringify({ name: 'dsh-repo-plugin', dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } } })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json':
        new Response(huge, { status: 200, headers: { 'content-length': String(huge.length) } }),
      // Routed so the refusal is what this test observes: without the cap the
      // body parses, the head commit resolves, and the candidate comes back ok
      // — a clean assertion failure rather than an unrouted-url throw.
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('no-manifest')
      expect(result.detail).toContain('larger than 1048576 bytes')
    }
  })

  it('refuses an over-cap body that arrived with no length to read it from', async () => {
    // A chunked response carries no content-length, so the declared-length
    // refusal above never fires and the cap has to be applied to what actually
    // arrived. Without this case neither branch is pinned: each catches what
    // the other would, so removing either one leaves every test green.
    const huge = JSON.stringify({ name: 'dsh-repo-plugin', dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } } })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json':
        new Response(huge, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('no-manifest')
      expect(result.detail).toContain('larger than 1048576 bytes')
      // This branch runs AFTER the body has been read, so the reason must
      // not claim it went unread — the author is told what actually happened.
      expect(result.detail).toContain('discarded without being parsed')
    }
  })

  it('refuses on the declared length alone, before the body is read', async () => {
    // The counterpart: a small body behind a content-length past the cap. The
    // refusal is by design not a measurement of what arrived — an over-cap
    // manifest must cost nothing to decline — so this pins the branch that
    // the body-length check would otherwise silently cover for.
    const small = JSON.stringify({ name: 'dsh-repo-plugin', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json':
        new Response(small, { status: 200, headers: { 'content-length': String(2 * 1024 * 1024) } }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('no-manifest')
      expect(result.detail).toContain('larger than 1048576 bytes')
      // Nothing was read on this path, and the reason says so.
      expect(result.detail).toContain('so it is not read')
    }
  })
})

describe('release-tarball rescue probe', () => {
  const meta = { fullName: 'someone/dsh-repo-plugin', defaultBranch: 'main', description: 'A repo plugin.', license: 'MIT', pushedAt: '2026-08-01T00:00:00Z', stars: null as number | null }
  const assetUrl = 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/dsh-repo-plugin.tgz'
  const tarballBytes = new TextEncoder().encode('fake tarball bytes')
  const expectedSha256 = createHash('sha256').update(tarballBytes).digest('hex')
  const buildManifest = JSON.stringify({
    name: 'dsh-repo-plugin',
    scripts: { prepare: 'npm run build' },
    dsh: { bundle: {}, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
  })
  // A factory: a Response body is readable once, and every test needs its own.
  const headResponse = () => new Response(JSON.stringify({
    sha: commit,
    commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
  }), { status: 200 })

  it('rescues a requires-build repo by attaching its release tarball', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: assetUrl }],
      }), { status: 200 }),
      [assetUrl]: new Response(tarballBytes, { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      const candidate = result.candidates[0]
      expect(candidate?.requiresBuild).toBe(true)
      expect(candidate?.release).toEqual({ tag: 'v1.0.0', url: assetUrl, sha256: expectedSha256 })
      expect(expectedSha256).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('leaves no release when the repository has none', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response('no releases', { status: 404 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.release).toBeUndefined()
      // The unrescued candidate keeps its class: no release, still
      // requires-build, still rejected by the gate.
      expect(result.candidates[0]?.requiresBuild).toBe(true)
    }
  })

  it('leaves no release when the latest release has no tarball asset', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/plugin.zip' }],
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.release).toBeUndefined()
      // The unrescued candidate keeps its class: no release, still
      // requires-build, still rejected by the gate.
      expect(result.candidates[0]?.requiresBuild).toBe(true)
    }
  })

  it('does not probe releases for a repo without a build script', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (text.includes('/releases/latest')) throw new Error('the release endpoint must not be called')
      if (text.includes('/package.json')) {
        return new Response(JSON.stringify({ name: 'dsh-repo-plugin', dsh: { bundle: {} } }), { status: 200 })
      }
      if (text.includes('/commits/main')) return headResponse()
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.requiresBuild).toBe(false)
      expect(result.candidates[0]?.release).toBeUndefined()
    }
  })

  it('rescues a .TGZ asset — the asset-name match is case-insensitive', async () => {
    const upperAssetUrl = 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/dsh-repo-plugin.TGZ'
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: upperAssetUrl }],
      }), { status: 200 }),
      [upperAssetUrl]: new Response(tarballBytes, { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.release).toEqual({ tag: 'v1.0.0', url: upperAssetUrl, sha256: expectedSha256 })
    }
  })

  it('caps tarballs at 32 MB — the value the fixtures below are written against', () => {
    // The fixtures use literals so they cannot drift with the constant; this
    // is what makes the constant itself a tested fact rather than an
    // assumption both sides of the test happen to share.
    expect(MAX_TARBALL_BYTES).toBe(32 * 1024 * 1024)
  })

  it('refuses a tarball whose content-length exceeds the cap — the probe degrades, never throws', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: assetUrl }],
      }), { status: 200 }),
      // A literal, not MAX_TARBALL_BYTES + 1: a fixture derived from the
      // constant moves with it, so raising the cap to 64 MB stayed invisible
      // to every test in this file — and raising it is the dangerous
      // direction. The constant is pinned by its own assertion below.
      [assetUrl]: new Response('x', { status: 200, headers: { 'content-length': String(32 * 1024 * 1024 + 1) } }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.release).toBeUndefined()
      // The unrescued candidate keeps its class: over the cap, still
      // requires-build, still rejected by the gate.
      expect(result.candidates[0]?.requiresBuild).toBe(true)
    }
  })

  it('refuses a streamed tarball that exceeds the cap mid-download — the probe degrades, never throws', async () => {
    // A chunked body (no content-length) larger than the cap: the read must
    // stop at the cap and leave the probe null instead of buffering it all.
    const chunkSize = 1024 * 1024
    const overCapStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i <= 32; i += 1) controller.enqueue(new Uint8Array(chunkSize))
        controller.close()
      },
    })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: assetUrl }],
      }), { status: 200 }),
      [assetUrl]: new Response(overCapStream, { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.release).toBeUndefined()
      expect(result.candidates[0]?.requiresBuild).toBe(true)
    }
  })

  it('still hashes an asset whose content-length is under the cap', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: assetUrl }],
      }), { status: 200 }),
      [assetUrl]: new Response(tarballBytes, { status: 200, headers: { 'content-length': String(tarballBytes.byteLength) } }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.release).toEqual({ tag: 'v1.0.0', url: assetUrl, sha256: expectedSha256 })
    }
  })

  it('degrades to no release when the tarball body cannot be read — the probe never throws', async () => {
    // The response's body read is where a connection drop mid-download lands
    // (the arrayBuffer is OUTSIDE fetchRobust's retry loop); it must leave
    // the probe null, not crash the harvest.
    const droppedMidDownload = {
      ok: true,
      status: 200,
      headers: new Headers(),
      arrayBuffer: async () => { throw new Error('connection dropped mid-download') },
    } as unknown as Response
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: assetUrl }],
      }), { status: 200 }),
      [assetUrl]: droppedMidDownload,
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.requiresBuild).toBe(true)
      expect(result.candidates[0]?.release).toBeUndefined()
    }
  })

  it('degrades to no release when the releases call dies on transport — the probe never throws', async () => {
    // The releases/latest request itself can throw on transport failure
    // (fetchRobust's budget runs out, then the outer catch swallows).
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (text.includes('/releases/latest')) throw new Error('UND_ERR_HEADERS_TIMEOUT')
      if (text.includes('/package.json')) return new Response(buildManifest, { status: 200 })
      if (text.includes('/commits/main')) return headResponse()
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.requiresBuild).toBe(true)
      expect(result.candidates[0]?.release).toBeUndefined()
    }
  })
})

describe('harvestRepos', () => {
  function candidateOf(repo: string): RepoCandidate {
    return {
      name: repo.split('/')[1] ?? repo,
      repo,
      commit,
      version: commit,
      publishedAt: null,
      repository: `https://github.com/${repo}`,
      license: 'MIT',
      hasBundle: true,
      requiresBuild: false,
      hasWorkspaceDeps: false,
      catalog: null,
      description: 'x',
    }
  }
  function entryOf(repo: string): RepoState[string] {
    return { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [candidateOf(repo)] }
  }

  it('skips loudly (report note) when no token is present', async () => {
    const result = await harvestRepos({ state: {}, budget: 10, fetchImpl: (async () => { throw new Error('never called') }) as unknown as typeof fetch, sleep, token: undefined })
    expect(result.skipped).toBe(true)
    expect(result.candidates).toHaveLength(0)
  })

  it('fetches new and changed repos, carries the untouched, defers past the budget, and drops gone ones', async () => {
    const state: RepoState = {
      'a/unchanged': entryOf('a/unchanged'),
      'b/changed': { ...entryOf('b/changed'), pushedAt: '2026-07-01T00:00:00Z' },
      'c/gone': entryOf('c/gone'),
    }
    const seen = [
      { repo: 'a/unchanged', pushedAt: '2026-08-01T00:00:00Z' },
      { repo: 'b/changed', pushedAt: '2026-08-02T00:00:00Z' },
      { repo: 'd/new', pushedAt: '2026-08-02T00:00:00Z' },
      { repo: 'e/deferred', pushedAt: '2026-08-02T00:00:00Z' },
    ]
    // budget 2: b/changed and d/new fetch; e/deferred defers.
    const routes: Record<string, Response> = {}
    for (const repo of ['b/changed', 'd/new']) {
      routes[`https://raw.githubusercontent.com/${repo}/main/package.json`] = new Response(JSON.stringify({ name: repo.split('/')[1], dsh: { bundle: {} } }), { status: 200 })
      routes[`https://api.github.com/repos/${repo}/commits/main`] = new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
    }
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        const q = new URL(text).searchParams.get('q') ?? ''
        const items = (q.includes('topic:dsh-plugin') ? seen : []).map(s => ({ full_name: s.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: s.pushedAt }))
        return new Response(JSON.stringify({ items }), { status: 200 })
      }
      for (const [prefix, response] of Object.entries(routes)) {
        if (text.startsWith(prefix)) return response
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch

    const result = await harvestRepos({ state, budget: 2, fetchImpl, sleep, token: 't' })
    expect(result.skipped).toBe(false)
    expect(result.fetched).toBe(2)
    expect(result.carried).toBe(1)
    expect(result.deferred).toBe(1)
    expect(result.gone).toEqual(['c/gone'])
    expect(result.candidates.map(c => c.repo).sort()).toEqual(['a/unchanged', 'b/changed', 'd/new'])
    expect(result.nextState['a/unchanged']?.candidates[0]?.repo).toBe('a/unchanged')
    expect(Object.keys(result.nextState).sort()).toEqual(['a/unchanged', 'b/changed', 'd/new'])
  })

  it('exposes the star counts the search items carry as a free byproduct', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({
          items: [
            { full_name: 's/with-stars', default_branch: 'main', description: null, license: null, pushed_at: '2026-08-02T00:00:00Z', stargazers_count: 42 },
            { full_name: 's/no-stars', default_branch: 'main', description: null, license: null, pushed_at: '2026-08-02T00:00:00Z' },
          ],
        }), { status: 200 })
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    // budget 0: the search still runs and its star counts still surface;
    // the item without `stargazers_count` falls back to the GraphQL fetch.
    const result = await harvestRepos({ state: {}, budget: 0, fetchImpl, sleep, token: 't' })
    expect(result.searchStars.get('s/with-stars')).toBe(42)
    expect(result.searchStars.has('s/no-stars')).toBe(false)
  })

  it('keeps a failure as a reason and carries the recorded candidate for that repo', async () => {
    const state: RepoState = { 'x/broken': { ...entryOf('x/broken'), pushedAt: '2026-07-01T00:00:00Z' } }
    const seen = [{ repo: 'x/broken', pushedAt: '2026-08-02T00:00:00Z' }]
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(s => ({ full_name: s.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: s.pushedAt })) }), { status: 200 })
      }
      return new Response('missing', { status: 404 })
    }) as unknown as typeof fetch
    const result = await harvestRepos({ state, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.failures).toEqual([{ repo: 'x/broken', code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }])
    // The carried candidate survives the failed refetch, and the recorded
    // pushedAt is kept — the mismatch schedules the retry again next run.
    expect(result.candidates.map(c => c.repo)).toEqual(['x/broken'])
    expect(result.nextState['x/broken']?.pushedAt).toBe('2026-07-01T00:00:00Z')
  })

  it('threads a subpackage name failure into the report as its own repo#subdir rejection', async () => {
    // A monorepo whose only qualifying subpackage declares dsh.bundle but
    // fails the name grammar must not vanish: fetchRepoCandidate's
    // subpackageFailures rides the ok branch, and harvestRepos must drain
    // it into the same `failures` array build.ts turns into rejections.
    const seen = [{ repo: 'someone/monorepo', pushedAt: '2026-08-02T00:00:00Z' }]
    const rootManifest = JSON.stringify({ private: true, workspaces: ['packages/*'] })
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(s => ({ full_name: s.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: s.pushedAt })) }), { status: 200 })
      }
      if (text === 'https://raw.githubusercontent.com/someone/monorepo/main/package.json') return new Response(rootManifest, { status: 200 })
      if (text === 'https://api.github.com/repos/someone/monorepo/commits/main') {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      }
      if (text === 'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1') {
        return new Response(JSON.stringify({ tree: [{ path: 'package.json' }, { path: 'packages/bad-name/package.json' }] }), { status: 200 })
      }
      if (text === 'https://raw.githubusercontent.com/someone/monorepo/main/packages/bad-name/package.json') {
        return new Response(JSON.stringify({ name: '{{PKG_NAME}}', dsh: { bundle: {} } }), { status: 200 })
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await harvestRepos({ state: {}, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.failures).toEqual([{
      repo: 'someone/monorepo#packages/bad-name',
      code: 'no-manifest',
      detail: expect.stringContaining('is not a usable package name'),
    }])
    expect(result.candidates).toEqual([])
  })

  it('turns an unexpected throw on one repo into a row, not a dead harvest', async () => {
    const stderr: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write
    try {
      await runIt()
    } finally {
      process.stderr.write = write
    }

    async function runIt() {
    // The design intent everywhere else in this file is that one bad package
    // becomes a row. The per-repo fetch had no try, so any unguarded throw --
    // the `null` manifest above was one, and it will not be the last -- took
    // the whole build with it, through build.ts's one retry into the same
    // deterministic throw. fetch-failed rather than no-manifest on purpose: it
    // is not persisted as a dead end, so the repo is retried next run instead
    // of being written off over what may be our own bug.
    const seen = [{ repo: 'a/boom', pushedAt: '2026-08-02T00:00:00Z' }, { repo: 'b/fine', pushedAt: '2026-08-02T00:00:00Z' }]
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(sr => ({ full_name: sr.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: sr.pushedAt })) }), { status: 200 })
      }
      if (text.startsWith('https://raw.githubusercontent.com/a/boom/')) throw new TypeError('Cannot read properties of null (reading \'scripts\')')
      if (text === 'https://raw.githubusercontent.com/b/fine/main/package.json') {
        return new Response(JSON.stringify({ name: 'b-fine', dsh: { bundle: {} } }), { status: 200 })
      }
      if (text === 'https://api.github.com/repos/b/fine/commits/main') {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await harvestRepos({ state: {}, budget: 5, fetchImpl, sleep, token: 't' })
    // The good repo still lands, and the bad one is accounted for by name.
    expect(result.candidates.map(c => c.repo)).toEqual(['b/fine'])
    const boom = result.failures.find(f => f.repo === 'a/boom')
    expect(boom?.code).toBe('fetch-failed')
    // The PUBLISHED reason is ours to write. This assertion used to require
    // the raw exception text in the row, which put
    // "Cannot read properties of null (reading 'scripts')" on Pages under the
    // repository's name — blaming an author for what the code beside it calls
    // our own defect. The diagnostic moved to stderr, asserted below.
    expect(boom?.detail).not.toContain('scripts')
    expect(boom?.detail).toContain('not a judgement on the repository')
    expect(stderr.join('')).toContain("Cannot read properties of null (reading 'scripts')")
    expect(stderr.join('')).toContain('a/boom')
    }
  })

  it('stops the build when the throws are systematic rather than isolated', async () => {
    // The per-repo isolation, unbounded, turns a total failure into a green
    // publish: every repo throwing for ONE shared reason -- a CI egress
    // allowlist, a revoked token, an API shape change -- returns normally, and
    // the build ships zero GitHub entries (empty state) or yesterday's plus
    // hundreds of rejections naming innocent repos (populated state), every
    // day, since fetch-failed is never persisted and the same repos retry.
    // This is the hole build.ts:82-88 describes on the npm half in its own
    // words; the GitHub half must not reopen it. Safe by CHECK, the way
    // searchByKeywords is, not by construction.
    const seen = Array.from({ length: 40 }, (_, i) => ({ repo: `owner/repo-${i}`, pushedAt: '2026-08-02T00:00:00Z' }))
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(sr => ({ full_name: sr.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: sr.pushedAt })) }), { status: 200 })
      }
      throw new TypeError('fetch failed: egress blocked')
    }) as unknown as typeof fetch
    await expect(harvestRepos({ state: {}, budget: 100, fetchImpl, sleep, token: 't' }))
      .rejects.toThrow(/threw/)
  })

  it('still degrades an isolated throw to a row, well under the bound', async () => {
    // The other side: the bound must not undo the isolation it guards. One
    // bad repo in a healthy run is a row, and the run publishes.
    const seen = Array.from({ length: 40 }, (_, i) => ({ repo: `owner/repo-${i}`, pushedAt: '2026-08-02T00:00:00Z' }))
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(sr => ({ full_name: sr.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: sr.pushedAt })) }), { status: 200 })
      }
      if (text.startsWith('https://raw.githubusercontent.com/owner/repo-7/')) throw new TypeError('only this one')
      if (text.endsWith('/main/package.json')) {
        const name = new URL(text).pathname.split('/')[2] ?? 'x'
        return new Response(JSON.stringify({ name, dsh: { bundle: {} } }), { status: 200 })
      }
      if (text.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await harvestRepos({ state: {}, budget: 100, fetchImpl, sleep, token: 't' })
    expect(result.candidates).toHaveLength(39)
    const row = result.failures.find(f => f.repo === 'owner/repo-7')
    expect(row?.code).toBe('fetch-failed')
    // F-4: the published reason is ours to write, not the exception's. The
    // raw message goes to stderr; a report.md row on Pages must not blame a
    // repository for what the comment beside it calls our own defect.
    expect(row?.detail).not.toContain('only this one')
    expect(row?.detail).toMatch(/retried/i)
    expect(result.thrown).toBe(1)
  })

  it('trips at exactly the floor, not one throw later', async () => {
    // The floor's VALUE, and the `>=`. Twenty throws in a forty-repo queue is
    // the boundary from both directions: exactly MIN_THROWN_TO_BOUND, and 50%,
    // well over the share. Raising the floor to 26 leaves every other test in
    // this file green -- verified by mutation -- because none of them lands
    // between 20 and 25. Literals, so the fixture cannot drift with the
    // constant it is meant to pin.
    const seen = Array.from({ length: 40 }, (_, i) => ({ repo: `owner/repo-${i}`, pushedAt: '2026-08-02T00:00:00Z' }))
    const throwing = new Set(Array.from({ length: 20 }, (_, i) => `owner/repo-${i}`))
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(sr => ({ full_name: sr.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: sr.pushedAt })) }), { status: 200 })
      }
      const parts = new URL(text).pathname.split('/').filter(Boolean)
      const repo = text.startsWith('https://raw.') ? `${parts[0]}/${parts[1]}` : `${parts[1]}/${parts[2]}`
      if (throwing.has(repo)) throw new TypeError('this one only')
      if (text.endsWith('/main/package.json')) return new Response(JSON.stringify({ name: (parts[1] ?? 'x'), dsh: { bundle: {} } }), { status: 200 })
      if (text.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    expect(MIN_THROWN_TO_BOUND).toBe(20)
    expect(MAX_THROWN_FRACTION).toBe(0.1)
    await expect(harvestRepos({ state: {}, budget: 400, fetchImpl, sleep, token: 't' }))
      .rejects.toThrow(/20 of 40 repositories threw/)
  })

  it('publishes a big run whose throws clear the floor but stay under the share', async () => {
    // Both halves of the bound are load-bearing, and each needs a case the
    // other cannot cover. The floor is pinned by the two-repo run above, where
    // one throw is 50%. This is the fraction's: 25 throws in a 300-repo queue
    // clears the 20-failure floor and is still 8.3% -- a partial fault, not a
    // pool-wide one, and the 275 repositories that answered must still ship.
    // With the floor alone this run would fail the build.
    const seen = Array.from({ length: 300 }, (_, i) => ({ repo: `owner/repo-${i}`, pushedAt: '2026-08-02T00:00:00Z' }))
    const throwing = new Set(Array.from({ length: 25 }, (_, i) => `owner/repo-${i}`))
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(sr => ({ full_name: sr.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: sr.pushedAt })) }), { status: 200 })
      }
      const owner = new URL(text).pathname.split('/').filter(Boolean)
      const repo = text.startsWith('https://raw.') ? `${owner[0]}/${owner[1]}` : `${owner[1]}/${owner[2]}`
      if (throwing.has(repo)) throw new TypeError('this one only')
      if (text.endsWith('/main/package.json')) {
        return new Response(JSON.stringify({ name: (owner[1] ?? 'x'), dsh: { bundle: {} } }), { status: 200 })
      }
      if (text.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await harvestRepos({ state: {}, budget: 400, fetchImpl, sleep, token: 't' })
    expect(result.thrown).toBe(25)
    expect(result.fetched).toBe(300)
    expect(result.candidates).toHaveLength(275)
  })

  it('carries a subpackage failure across runs instead of reporting it once and going quiet', async () => {
    // Moving the size refusal onto the ok branch moved it out of the branch
    // that persists a failure, and subpackageFailures were explicitly not
    // stored — so the corrected reason was published on the run that fetched
    // the repo and never again: the next run sees an unchanged pushedAt, does
    // not re-fetch, and the entry carries candidates: [] with no failure.
    // Against "nothing disappears without a reason attached to its name",
    // silence is worse than the wrong reason it replaced: the author has
    // nothing at all to act on.
    const seen = [{ repo: 'someone/monorepo', pushedAt: '2026-08-02T00:00:00Z' }]
    const huge = JSON.stringify({ name: 'the-plugin', dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } } })
    const namedRoot = JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['packages/*'] })
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(sr => ({ full_name: sr.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: sr.pushedAt })) }), { status: 200 })
      }
      if (text === 'https://raw.githubusercontent.com/someone/monorepo/main/package.json') return new Response(namedRoot, { status: 200 })
      if (text === 'https://api.github.com/repos/someone/monorepo/commits/main') {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      }
      if (text === 'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1') {
        return new Response(JSON.stringify({ tree: [{ path: 'package.json' }, { path: 'packages/the-plugin/package.json' }] }), { status: 200 })
      }
      if (text === 'https://raw.githubusercontent.com/someone/monorepo/main/packages/the-plugin/package.json') {
        return new Response(huge, { status: 200 })
      }
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch

    const first = await harvestRepos({ state: {}, budget: 5, fetchImpl, sleep, token: 't' })
    expect(first.failures.map(f => f.repo)).toEqual(['someone/monorepo#packages/the-plugin'])
    // Persisted, so the reason survives a run that does not re-fetch.
    expect(first.nextState['someone/monorepo']?.subpackageFailures?.[0]?.repo)
      .toBe('someone/monorepo#packages/the-plugin')

    const second = await harvestRepos({ state: first.nextState, budget: 5, fetchImpl, sleep, token: 't' })
    expect(second.fetched).toBe(0)
    expect(second.carried).toBe(1)
    expect(second.failures).toEqual(first.failures)
    // And it keeps carrying, rather than surviving exactly one extra run.
    const third = await harvestRepos({ state: second.nextState, budget: 5, fetchImpl, sleep, token: 't' })
    expect(third.failures).toEqual(first.failures)
  })

  it('round-trips a persisted subpackage failure through repo-state.json', () => {
    // It only carries if it survives serialize -> parse, which is how the
    // state actually reaches the next run: through a committed file.
    const state: RepoState = {
      'someone/monorepo': {
        pushedAt: '2026-08-02T00:00:00Z',
        commit,
        candidates: [],
        subpackageFailures: [{ repo: 'someone/monorepo#packages/p', code: 'no-manifest', detail: 'too big' }],
      },
    }
    expect(parseRepoState(serializeRepoState(state))).toEqual(state)
  })
})

describe('the search path survives a body it did not expect', () => {
  // The `null`-manifest guard closed the class on the FETCH path, which sits
  // inside the per-repo try. These three are on the SEARCH path, outside it,
  // so each still ends harvestRepos -> build.ts's one retry -> a dead build.
  // parseRepoMeta in particular has exactly the contract stated in
  // subpackage-select.ts ("a function taking `unknown` must be total for
  // `unknown`") and did not meet it.
  //
  // A failed SEARCH still fails loudly, and deliberately: harvesting only the
  // pages that answered would silently shrink the pool, which is
  // indistinguishable from an empty ecosystem. What changes is that the error
  // names the query and what arrived, instead of surfacing a raw TypeError
  // from a property read.
  const seen = [{ repo: 'a/b', pushedAt: '2026-08-02T00:00:00Z' }]

  function searchStub(pageBody: string, probeBody = JSON.stringify({ total_count: 1 })): typeof fetch {
    return (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(probeBody, { status: 200 })
      if (text.includes('/search/repositories')) return new Response(pageBody, { status: 200 })
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
  }

  it('names the query when a search page answers 200 with HTML', async () => {
    await expect(harvestRepos({ state: {}, budget: 5, fetchImpl: searchStub('<!doctype html><h1>502</h1>'), sleep, token: 't' }))
      .rejects.toThrow(/not JSON/)
  })

  it('names the query when a search probe answers 200 with HTML', async () => {
    await expect(harvestRepos({ state: {}, budget: 5, fetchImpl: searchStub(JSON.stringify({ items: [] }), '<!doctype html>'), sleep, token: 't' }))
      .rejects.toThrow(/not JSON/)
  })

  it('treats a search body of `null` as a body that is not JSON', async () => {
    // `null` parses, so .json() succeeds and every property read below it
    // throws — the same four bytes as the manifest case, on the other path.
    await expect(harvestRepos({ state: {}, budget: 5, fetchImpl: searchStub('null'), sleep, token: 't' }))
      .rejects.toThrow(/not JSON/)
    await expect(harvestRepos({ state: {}, budget: 5, fetchImpl: searchStub(JSON.stringify({ items: [] }), 'null'), sleep, token: 't' }))
      .rejects.toThrow(/not JSON/)
  })

  it('skips an unusable search item instead of throwing on it', async () => {
    // parseRepoMeta's own contract: an item it cannot read is skipped, the
    // same as one missing full_name. Only `null` ever threw.
    const items = [null, 'a string', 42, { full_name: 'a/b', default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: seen[0]?.pushedAt }]
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 1 }), { status: 200 })
      if (text.includes('/search/repositories')) return new Response(JSON.stringify({ items }), { status: 200 })
      if (text === 'https://raw.githubusercontent.com/a/b/main/package.json') return new Response(JSON.stringify({ name: 'a-b', dsh: { bundle: {} } }), { status: 200 })
      if (text === 'https://api.github.com/repos/a/b/commits/main') return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await harvestRepos({ state: {}, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.seen.map(sr => sr.repo)).toEqual(['a/b'])
  })
})

describe('fetch robustness', () => {
  it('retries a transient network throw and succeeds when the connection recovers', async () => {
    const delays: number[] = []
    const sleepImpl = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) throw new Error('UND_ERR_HEADERS_TIMEOUT')
      return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
    }) as unknown as typeof fetch
    const { seen } = await searchReposByTopic(fetchImpl, sleepImpl, 'token')
    expect(seen).toEqual([])
    expect(call).toBeGreaterThanOrEqual(2)
    expect(delays[0]).toBe(2000)
  })
})

describe('split regression', () => {
  it('splits a two-day oversized window into single days instead of exhausting', async () => {
    // totals: the whole topic fits; the stars:0 side is 1500, spread over two
    // days 797+703, each under the cap — the 2-day range must split.
    const totals: Record<string, number> = {
      'topic:dsh-plugin': 1600,
      'topic:dsh-plugin stars:0': 1500,
      'topic:dsh-plugin stars:>=1': 100,
      'topic:dsh-plugin stars:0 created:2008-01-01..2099-01-01': 1500,
    }
    let dayCalls = 0
    const probe = async (q: string) => {
      if (q.includes('created:') && !q.includes('2099')) dayCalls += 1
      return totals[q] ?? 0
    }
    const windows = await partitionTopic('dsh-plugin', probe)
    expect(dayCalls).toBeGreaterThan(0)
    for (const w of windows) {
      const q = `topic:dsh-plugin${w.stars ? ` stars:${w.stars}` : ''}${w.created ? ` created:${w.created}` : ''}${w.size ? ` size:${w.size}` : ''}`
      expect(totals[q] ?? 0).toBeLessThanOrEqual(1000)
    }
  })
})

describe('subpackage probe', () => {
  const meta = { fullName: 'someone/monorepo', defaultBranch: 'main', description: 'A monorepo.', license: 'MIT', pushedAt: '2026-08-01T00:00:00Z', stars: null as number | null }
  const rootManifest = JSON.stringify({ private: true, workspaces: ['packages/*'] })

  it('projects bundle-carrying subpackages when the bundle-less root signals a monorepo', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(rootManifest, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [
          { path: 'package.json' },
          { path: 'packages/core/package.json' },
          { path: 'packages/the-plugin/package.json' },
        ],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/core/package.json': new Response(JSON.stringify({ name: 'core' }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/the-plugin/package.json': new Response(JSON.stringify({
        name: 'the-plugin',
        dsh: { bundle: {}, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates.map(c => c.name)).toEqual(['the-plugin'])
      expect(result.candidates[0]?.subdir).toBe('packages/the-plugin')
      expect(result.candidates[0]?.repo).toBe('someone/monorepo')
    }
  })

  it('refuses an over-cap subpackage manifest, the same as the root one', async () => {
    // The subpackage read is the SECOND manifest read in this file, and it was
    // uncapped while the root read had both checks. It is the worse of the two
    // to leave open: projectCandidate stores `dsh.catalog` raw, mergeRepoState
    // puts it in `candidates`, and build.ts writes registry/repo-state.json —
    // which the workflow git-adds and pushes. 597 of the 13,120 candidates in
    // that tracked 10.5 MB file arrived through this path, so an unbounded
    // manifest here lands in git history permanently, where no rebuild can
    // remove it.
    const huge = JSON.stringify({
      name: 'the-plugin',
      dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } },
    })
    // A NAMED root, as in the sibling test above: it survives as the
    // bundle-less candidate, so a refused subpackage is visible as one missing
    // name rather than as the whole repository failing.
    const namedRoot = JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['packages/*'] })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(namedRoot, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/the-plugin/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/the-plugin/package.json':
        new Response(huge, { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    // The subpackage is not listed — and it is REPORTED, keyed by its path.
    // The previous revision of this test asserted `subpackageFailures` stayed
    // undefined, on the reasoning that a body we declined to read never gave
    // us a name to attach a reason to. That reasoning was wrong: failures here
    // are keyed by `owner/slug#dir`, and the dir is known at the refusal. An
    // unparseable body genuinely is not a manifest; an over-cap body may be a
    // perfectly good one we chose not to read, and the author has to be told
    // which, or "nothing disappears without a reason attached to its name"
    // fails on this path.
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates.map(c => c.name)).toEqual(['monorepo-root'])
      expect(result.subpackageFailures).toEqual([{
        repo: 'someone/monorepo#packages/the-plugin',
        code: 'no-manifest',
        // The body-length branch, not the declared-length one: this stub sends
        // no content-length, so the reason says discarded rather than unread.
        detail: 'package.json is larger than 1048576 bytes, so it was discarded without being parsed.',
      }])
    }
  })

  it('stays silent about a subpackage whose body is not JSON at all', async () => {
    // The noise policy this module already states: "rejecting each one would
    // drown the report in noise the author already knows". A template repo
    // matched by `packages/*` whose package.json holds {{ handlebars }}
    // placeholders is not making a claim to be a plugin -- it is not a
    // manifest -- and it would otherwise publish one no-manifest row per
    // subdirectory, every run. An over-cap body is the opposite case: it may
    // be a perfectly good manifest we chose not to read, which is why the two
    // are now distinguished at the read rather than lumped together.
    const template = '{ "name": "{{PKG_NAME}}", "version": {{VERSION}} }'
    const namedRoot = JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['packages/*'] })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(namedRoot, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/tpl/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/tpl/package.json':
        new Response(template, { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates.map(c => c.name)).toEqual(['monorepo-root'])
      expect(result.subpackageFailures).toBeUndefined()
    }
  })

  it('keeps the root\'s own rejection when a subpackage was only refused for size', async () => {
    // A size refusal is a choice we made about a body we never read, not a
    // claim by the subpackage -- so it must not suppress a fact we do know and
    // can state. Here the root declares an unusable name, and describeBadName
    // is the precise reason; before this fix the size row replaced it and the
    // bad name was never mentioned. A subpackage that DOES claim to be a
    // plugin (declares dsh.bundle, fails the grammar) still takes precedence,
    // which is the pre-existing design and the test below it.
    const huge = JSON.stringify({
      name: 'the-plugin',
      dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } },
    })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json':
        new Response(JSON.stringify({ name: 'Bad Name!!', private: true, workspaces: ['packages/*'] }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/the-plugin/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/the-plugin/package.json':
        new Response(huge, { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.detail).toContain('is not a usable package name')
      expect(result.detail).toContain('Bad Name!!')
      // And the subpackage row rides alongside rather than replacing it.
      expect(result.subpackageFailures?.[0]?.repo).toBe('someone/monorepo#packages/the-plugin')
      expect(result.subpackageFailures?.[0]?.detail).toContain('larger than 1048576 bytes')
    }
  })

  it('publishes a bare failure row beside usable candidates, with no internal field on it', async () => {
    // The path with BOTH candidates and a failure row had no test, which is
    // how the `claimed` tag reached the published shape from this return while
    // the two returns below it were field-picked. TypeScript allows it: the
    // tagged type extends RepoFetchFailure and it is a variable, so no
    // excess-property check fires. The consequence is not cosmetic --
    // harvestRepos persists these rows into the COMMITTED repo-state.json,
    // and parseRepoState rebuilds {repo, code, detail} on the way back in, so
    // an extra key makes the round-trip non-idempotent and the file churns
    // every day with no input change: the builtAt invariant through a side
    // door.
    const namelessRoot = JSON.stringify({ private: true, workspaces: ['packages/*'] })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(namelessRoot, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [
          { path: 'package.json' },
          { path: 'packages/good/package.json' },
          { path: 'packages/claiming/package.json' },
          { path: 'packages/huge/package.json' },
        ],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/good/package.json': new Response(JSON.stringify({
        name: 'the-plugin',
        dsh: { bundle: {}, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/claiming/package.json':
        new Response(JSON.stringify({ name: '{{PKG_NAME}}', dsh: { bundle: {} } }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/huge/package.json':
        new Response(JSON.stringify({ name: 'the-plugin', dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } } }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.candidates.map(c => c.name)).toEqual(['the-plugin'])
    expect(result.subpackageFailures).toHaveLength(2)
    for (const row of result.subpackageFailures ?? []) {
      expect(Object.keys(row).sort()).toEqual(['code', 'detail', 'repo'])
    }
  })

  it('round-trips its published failure rows through repo-state unchanged', () => {
    // The idempotence the churn above breaks, stated directly: whatever shape
    // a row has when published must survive serialize -> parse identically, or
    // the committed file differs from itself on the next run.
    const row = { repo: 'someone/monorepo#packages/huge', code: 'no-manifest' as const, detail: 'too big' }
    const state: RepoState = {
      'someone/monorepo': { pushedAt: '2026-08-02T00:00:00Z', commit, candidates: [], subpackageFailures: [row] },
    }
    const once = serializeRepoState(state)
    expect(serializeRepoState(parseRepoState(once))).toBe(once)
  })

  it('still prefers a claiming subpackage over the root\'s bad name, as it did before', async () => {
    // The complement of the case above, and the pre-existing design this
    // change must not disturb: a subpackage that DECLARED dsh.bundle and then
    // failed the name grammar made a claim, and that claim is the more
    // specific fact — it is reported instead of the root's own name problem.
    // Same root as the size case above, so the only difference is the kind of
    // subpackage failure, which is precisely what `claimed` distinguishes.
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json':
        new Response(JSON.stringify({ name: 'Bad Name!!', private: true, workspaces: ['packages/*'] }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/bad-name/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/bad-name/package.json':
        new Response(JSON.stringify({ name: '{{PKG_NAME}}', dsh: { bundle: {} } }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates).toEqual([])
      expect(result.subpackageFailures?.[0]?.repo).toBe('someone/monorepo#packages/bad-name')
      expect(result.subpackageFailures?.[0]?.detail).toContain('is not a usable package name')
    }
  })

  it('never tells a nameless root it has no installable subpackage when one was refused for size', async () => {
    // The control below proves the statement false: the SAME repository with a
    // readable subpackage yields a candidate. Before this fix the over-cap
    // variant published `no-manifest` / "package.json declares no name and no
    // installable subpackage, so dsh has nothing to register." There is an
    // installable subpackage; we declined to read it for size, and a
    // misattributed published reason is a defect, not a wording nit.
    const huge = JSON.stringify({
      name: 'the-plugin',
      dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } },
    })
    const namelessRoot = JSON.stringify({ private: true, workspaces: ['packages/*'] })
    const routes = (sub: string) => ({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(namelessRoot, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/the-plugin/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/the-plugin/package.json':
        new Response(sub, { status: 200 }),
    })

    const control = await fetchRepoCandidate(meta, stubFetch(routes(JSON.stringify({
      name: 'the-plugin',
      dsh: { bundle: {}, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
    }))), sleep, 'token')
    expect(control.ok).toBe(true)
    if (control.ok) expect(control.candidates.map(c => c.name)).toEqual(['the-plugin'])

    const refused = await fetchRepoCandidate(meta, stubFetch(routes(huge)), sleep, 'token')
    expect(refused.ok).toBe(true)
    if (refused.ok) {
      expect(refused.candidates).toEqual([])
      expect(refused.subpackageFailures?.[0]?.repo).toBe('someone/monorepo#packages/the-plugin')
      expect(refused.subpackageFailures?.[0]?.detail).toContain('larger than 1048576 bytes')
      // Specifically NOT the claim the control just disproved.
      expect(JSON.stringify(refused)).not.toContain('no installable subpackage')
    }
  })

  it('keeps the repo-level no-bundle path when no subpackage qualifies', async () => {
    const namedRoot = JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['packages/*'] })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(namedRoot, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/core/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/core/package.json': new Response(JSON.stringify({ name: 'core' }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    // The bundle-less root candidate survives for the gate's no-bundle rule;
    // the bundle-less subpackage was never a plugin candidate.
    if (result.ok) {
      expect(result.candidates.map(c => c.name)).toEqual(['monorepo-root'])
      expect(result.candidates[0]?.hasBundle).toBe(false)
    }
  })

  it('a nameless private root still lists its subpackages', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(JSON.stringify({ private: true, workspaces: ['packages/*'] }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/the-plugin/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/the-plugin/package.json': new Response(JSON.stringify({
        name: 'the-plugin',
        dsh: { bundle: {} },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates[0]?.subdir).toBe('packages/the-plugin')
  })

  it('skips the probe entirely when probing is disabled — the flag keeps v3 behavior', async () => {
    const namedRoot = JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['packages/*'] })
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (text.includes('/git/trees/')) throw new Error('tree must not be fetched when probing is off')
      if (text.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-01T12:00:00.000Z' } } }), { status: 200 })
      }
      if (text.includes('/package.json')) return new Response(namedRoot, { status: 200 })
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token', false)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.subdir).toBeUndefined()
      expect(result.candidates[0]?.name).toBe('monorepo-root')
    }
  })

  it('a bad root name does not swallow a valid subpackage', async () => {
    // Regression: the root-name check used to return before the subpackage
    // probe ever ran, so a monorepo whose container had an unusable name
    // lost every valid plugin inside it — exactly the shape of the
    // committed jiweiyeah/Skills-Manager entry (repo-state.json).
    const badRoot = JSON.stringify({ name: 'Skills Manager', private: true, workspaces: ['packages/*'] })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(badRoot, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/dsh-good/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/dsh-good/package.json': new Response(JSON.stringify({
        name: 'dsh-good',
        dsh: { bundle: {}, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates.map(c => c.name)).toEqual(['dsh-good'])
      expect(result.candidates[0]?.subdir).toBe('packages/dsh-good')
    }
  })

  it('a subpackage that declares dsh.bundle but fails the name grammar gets its own repo#subdir failure', async () => {
    // Regression: projectCandidate returning null for a bad-name subpackage
    // discarded the fact that it had declared dsh.bundle — the repo still
    // returned ok:true with zero relevant candidates, so no rejection row,
    // no denied entry, nothing named it. This is the live shape behind the
    // five `{{PKG_NAME}}` rows carried in manifest.lock for
    // whyihaveyou/dsh-suite.
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json': new Response(rootManifest, { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
        tree: [{ path: 'package.json' }, { path: 'packages/bad-name/package.json' }],
      }), { status: 200 }),
      'https://raw.githubusercontent.com/someone/monorepo/main/packages/bad-name/package.json': new Response(JSON.stringify({
        name: '{{PKG_NAME}}',
        dsh: { bundle: {} },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates).toEqual([])
      expect(result.subpackageFailures).toEqual([{
        repo: 'someone/monorepo#packages/bad-name',
        code: 'no-manifest',
        detail: expect.stringContaining('is not a usable package name'),
      }])
    }
  })
})

// ---------------------------------------------------------------------------
// The structural guard.
//
// This branch has now been bitten three times by the same shape: a second
// pushing step, a second committing step, and a second manifest read. Each
// time the fix was written for the site someone happened to be looking at,
// and each time an identical uncapped/unguarded twin survived a few lines
// away. A test that names ONE site cannot catch the fourth; this one reads
// the module's own source and requires every response-body read in it to be
// either `readManifest` — the single place the cap lives — or an entry in a
// table that says, in words, why that read is not a manifest.
//
// Excuses are keyed by SNIPPET, not line number, following the idiom in
// workflow.test.ts: if a future edit rewrites the line an excuse was written
// for, the excuse stops matching and this test fails until a human re-confirms
// it, rather than quietly covering a line it was never reasoned about.
// ---------------------------------------------------------------------------

const githubClientSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'github-client.ts'),
  'utf8',
)

interface ExcusedBodyRead {
  readonly snippet: string
  readonly reason: string
}

const EXCUSED_BODY_READS: readonly ExcusedBodyRead[] = [
  {
    snippet: 'parsed = await response.json()',
    reason: 'readSearchBody: the single reader for api.github.com search bodies (the total_count probe and '
      + "the result pages) — GitHub's own JSON, bounded by SEARCH_PAGE_SIZE, and shape-checked there so a "
      + 'proxy error page or a bare `null` becomes a named error instead of a raw property-access throw',
  },
  {
    snippet: 'const body = await response.json() as { sha?: unknown; commit?: { author?: { date?: unknown } } }',
    reason: 'api.github.com commits: a sha and a date, both shape-checked before use',
  },
  {
    snippet: 'body = await response.json() as typeof body',
    reason: 'api.github.com releases: a tag name and an asset list GitHub composes; the tarball it points at '
      + 'is separately capped at MAX_TARBALL_BYTES',
  },
  {
    snippet: 'const parsed = await treeResponse.json() as unknown',
    reason: 'api.github.com git/trees: GitHub caps this at 100k entries and truncates, and only the `path` '
      + 'strings are read out of it — no repository-authored value is carried forward from this body',
  },
]

/**
 * One logical line: a source line with any method-chain continuations folded
 * into it, so `await res\n  .json()` is one region to scan and to excuse
 * rather than two lines that each look harmless. Whitespace is collapsed so a
 * snippet written on one line still matches a wrapped occurrence.
 */
interface LogicalLine {
  readonly text: string
  readonly lineNumber: number
}

function logicalLines(source: string): LogicalLine[] {
  const raw = source.split('\n')
  const out: LogicalLine[] = []
  for (const [index, line] of raw.entries()) {
    // A comment is not a call site. `.json()` appears in the prose that
    // explains these reads, and treating that as one would force an excuse
    // for a sentence. Only a line that OPENS with a comment marker is skipped,
    // so a real read with a trailing comment is still scanned.
    const opener = line.trim()
    if (opener.startsWith('*') || opener.startsWith('//') || opener.startsWith('/*')) continue
    if (out.length > 0 && line.trimStart().startsWith('.')) {
      const previous = out[out.length - 1]
      if (previous !== undefined) {
        out[out.length - 1] = { text: `${previous.text} ${line.trim()}`, lineNumber: previous.lineNumber }
        continue
      }
    }
    out.push({ text: line.trim(), lineNumber: index + 1 })
  }
  return out.map(l => ({ text: l.text.replace(/\s+/g, ' '), lineNumber: l.lineNumber }))
}

/**
 * The line range a top-level function occupies, by its LEXICAL extent.
 *
 * The first version of this scanner tracked the enclosing function with a
 * sticky variable that only changed at the next `function` line, so everything
 * between `readManifest` and the next declaration inherited its name and was
 * waved through — an arrow-const `const readSidecar = async (r) => r.json()`
 * placed just below it left all 41 tests green with an uncapped reader in the
 * file. Matching `const <name> =` as well would have fixed that one spelling;
 * bounding the region fixes the class, whatever the next twin is spelled like.
 */
function functionRegion(source: string, name: string): { first: number; last: number } {
  const lines = source.split('\n')
  const declaration = lines.findIndex(line =>
    new RegExp(`^(?:export )?(?:async )?function ${name}\\b`).test(line))
  if (declaration === -1) return { first: -1, last: -1 }
  // Every top-level function in this module closes on a lone `}` at column 0.
  const close = lines.findIndex((line, index) => index > declaration && line === '}')
  return { first: declaration + 1, last: close === -1 ? lines.length : close + 1 }
}

/** Every response-body read in the module. Deliberately matches the call and
 * not its receiver: `(await x).json()` and a wrapped `.json()` are reads too,
 * and a receiver pattern would miss both. */
function findBodyReads(source: string): LogicalLine[] {
  return logicalLines(source).filter(line => /\.\s*(?:json|text)\s*\(\s*\)/.test(line.text))
}

describe('every response body read in github-client.ts is capped or excused', () => {
  const region = functionRegion(githubClientSource, 'readManifest')

  it('locates readManifest, so the region check cannot pass by excusing everything', () => {
    expect(region.first).toBeGreaterThan(0)
    expect(region.last).toBeGreaterThan(region.first)
  })

  it('finds the reads at all, so the scan cannot pass by matching nothing', () => {
    // Without this, a regex that stops matching turns the exhaustiveness check
    // below into a loop over an empty list — green, and guarding nothing.
    const reads = findBodyReads(githubClientSource)
    expect(reads.length).toBeGreaterThanOrEqual(EXCUSED_BODY_READS.length + 1)
    expect(reads.some(r => r.lineNumber >= region.first && r.lineNumber <= region.last)).toBe(true)
  })

  it('is inside readManifest, or an excused non-manifest read, for every one of them', () => {
    for (const read of findBodyReads(githubClientSource)) {
      if (read.lineNumber >= region.first && read.lineNumber <= region.last) continue
      const excused = EXCUSED_BODY_READS.some(e => read.text.includes(e.snippet.replace(/\s+/g, ' ')))
      expect(
        excused,
        `github-client.ts:${read.lineNumber} reads a response body outside readManifest `
          + `(lines ${region.first}-${region.last}). A manifest body must go through readManifest, `
          + 'which is where MAX_MANIFEST_BYTES is enforced; anything else needs a reasoned entry in '
          + `EXCUSED_BODY_READS saying why it is not a manifest. Line: ${read.text}`,
      ).toBe(true)
    }
  })

  it('excuses nothing that is no longer there, so a stale reason cannot linger', () => {
    // The other direction: an excuse whose snippet has been edited away is a
    // reason nobody is reading any more, and it would silently cover whatever
    // line happened to contain that text next.
    for (const excused of EXCUSED_BODY_READS) {
      expect(
        githubClientSource.includes(excused.snippet),
        'EXCUSED_BODY_READS carries a snippet that is no longer in github-client.ts, so its reason '
          + `("${excused.reason}") no longer applies to anything: ${excused.snippet}`,
      ).toBe(true)
    }
  })
})

describe('request deadlines', () => {
  const meta = { fullName: 'someone/dsh-repo-plugin', defaultBranch: 'main', description: 'A repo plugin.', license: 'MIT', pushedAt: '2026-08-01T00:00:00Z', stars: null as number | null }

  const manifestUrl = 'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json'
  const commitUrl = 'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main'

  it('has a per-request deadline at all', () => {
    // A literal, not a re-export of the constant: a fixture computed from the
    // value it tests can never detect that value moving.
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('bounds a socket that accepts and never answers', async () => {
    // Only npm-client passed an AbortSignal. Against a socket that accepts and
    // never writes, npm-client rejected after 2s and github-client was still
    // pending at 8s; the only bound was undici's 300s headers timeout, after
    // which fetchRobust retried three more times — so a stalled GitHub ended
    // in the six-hour Actions kill with no report and no state commit.
    //
    // It REJECTS rather than returning a row: harvestRepos is the one place
    // that decides what a throw from here means, and the test below drives it.
    const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    // probeSubpackages false, then the 50ms deadline: four bounded attempts.
    await expect(fetchRepoCandidate(meta, fetchImpl, sleep, 'token', false, 50))
      .rejects.toThrow('github request exceeded 50ms')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('does not fire early: a slow but healthy repository still becomes a candidate', async () => {
    // The other side of the bound. A deadline the caller cannot set, or one
    // wired to the wrong number, passes the stall test above and then kills
    // every healthy repository behind a slow CDN.
    // Under 10x on purpose: at the 50x this started with, `ms / 10` survived
    // green — and `ms / 10` in production is this client at 3s.
    const SLOW_MS = 50
    const DEADLINE_MS = 400
    const base = stubFetch({
      [manifestUrl]: new Response(JSON.stringify({
        name: 'dsh-repo-plugin',
        dsh: { bundle: { patch: './cordis.patch.yml' }, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
      }), { status: 200 }),
      [commitUrl]: new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-01T12:00:00.000Z' } } }), { status: 200 }),
    })
    const slow = (async (url: string | URL) => {
      await new Promise(resolve => setTimeout(resolve, SLOW_MS))
      return base(url)
    }) as unknown as typeof fetch
    const result = await fetchRepoCandidate(meta, slow, sleep, 'token', false, DEADLINE_MS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates[0]?.name).toBe('dsh-repo-plugin')
  })

  it('carries the deadline into the harvest, so one stalled repository is a row and not the run', async () => {
    // RepoHarvestOptions is the seam build.ts actually uses: a deadline the
    // per-repo fetch honors but the harvest cannot set is one no production
    // caller can reach. The detail naming 50ms is what proves the INJECTED
    // number is honored rather than the 30s default quietly standing in.
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({
          items: [{ full_name: 's/stalled', default_branch: 'main', description: null, license: null, pushed_at: '2026-08-02T00:00:00Z' }],
        }), { status: 200 })
      }
      // raw.githubusercontent.com: accepts and never answers.
      return new Promise<Response>(() => {})
    }) as unknown as typeof fetch
    const started = Date.now()
    const result = await harvestRepos({ state: {}, budget: 5, fetchImpl, sleep, token: 't', timeoutMs: 50 })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.repo).toBe('s/stalled')
    expect(result.failures[0]?.code).toBe('fetch-failed')
    // The published reason stays the one WE wrote: a raw "github request
    // exceeded 50ms" under the repository's name would blame an author for a
    // stall on our side, the misattribution the throw-isolation test above
    // exists to prevent.
    expect(result.failures[0]?.detail).toContain('not a judgement on the repository')
    expect(result.failures[0]?.detail).not.toContain('exceeded')
    // Counted, so a GitHub that stalls for EVERY repo trips the systematic-
    // failure bound and stops the build instead of publishing a catalog that
    // blames three hundred innocent repositories by name.
    expect(result.thrown).toBe(1)
    // The whole proof that the INJECTED deadline is honored: on the 30s
    // default these four attempts take two minutes and vitest kills the test.
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('body deadlines', () => {
  const meta = { fullName: 'someone/dsh-repo-plugin', defaultBranch: 'main', description: 'A repo plugin.', license: 'MIT', pushedAt: '2026-08-01T00:00:00Z', stars: null as number | null }
  const assetUrl = 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/dsh-repo-plugin.tgz'
  const buildManifest = JSON.stringify({
    name: 'dsh-repo-plugin',
    scripts: { prepare: 'npm run build' },
    dsh: { bundle: {}, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
  })

  /** Routes one URL to a body-producing impl (which needs the signal, so the
   * init is forwarded) and everything else to a plain canned response. */
  function routeBody(bodyUrl: string, bodyImpl: typeof fetch, routes: Record<string, Response>): typeof fetch {
    return (async (url: string | URL, init?: RequestInit) => {
      const text = String(url)
      if (text.startsWith(bodyUrl)) return bodyImpl(text, init)
      for (const [prefix, response] of Object.entries(routes)) {
        if (text.startsWith(prefix)) return response
      }
      throw new Error(`unrouted url: ${text}`)
    }) as unknown as typeof fetch
  }

  function releaseRoutes(): Record<string, Response> {
    return {
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit, commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0', assets: [{ browser_download_url: assetUrl }],
      }), { status: 200 }),
    }
  }

  it('gives the 32 MB tarball read a deadline of its own, larger than the metadata one', () => {
    // Literals on both: the tarball bound exists precisely BECAUSE it must not
    // be the metadata bound, and a test computing one from the other could not
    // see them collapse back together.
    expect(TARBALL_REQUEST_TIMEOUT_MS).toBe(300_000)
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(30_000)
    expect(TARBALL_REQUEST_TIMEOUT_MS).toBeGreaterThan(GITHUB_REQUEST_TIMEOUT_MS)
  })

  it('bounds a tarball that sends headers and then stalls its body', async () => {
    // The case a header-phase deadline cannot see, on the one path that reads
    // up to MAX_TARBALL_BYTES. The rescue probe is advisory, so the bounded
    // failure degrades to "no release" — the repo itself still lists.
    const fetchImpl = routeBody(assetUrl, headersThenStalledBody(), releaseRoutes())
    const started = Date.now()
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token', true, 2000, 60)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.requiresBuild).toBe(true)
      expect(result.candidates[0]?.release).toBeUndefined()
    }
    // Between the two deadlines on purpose: the metadata bound handed in above
    // is 2000ms, so a tarball read that ignored its own 60ms bound and fell
    // back on the metadata one would still finish — just not this fast.
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('does not kill a large tarball body that is slow but healthy', async () => {
    // The other side. A 32 MB asset is slow by nature; killing a healthy one
    // costs the repo its prebuilt tarball until its next push, because the
    // release rides through the state file rather than being re-probed daily.
    const CHUNKS = 5
    const GAP_MS = 10
    const fetchImpl = routeBody(assetUrl, headersThenSlowBody(CHUNKS, GAP_MS), releaseRoutes())
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token', true, 2000, 400)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates[0]?.release?.tag).toBe('v1.0.0')
      expect(result.candidates[0]?.release?.sha256)
        .toBe(createHash('sha256').update(slowBodyBytes(CHUNKS)).digest('hex'))
    }
  })

  it('still calls a genuinely unreadable manifest body unreadable', async () => {
    // The other side of the readManifest rethrow: only a DEADLINE is rethrown.
    // A body that really did arrive broken is still the author's `no-manifest`
    // — widening that rethrow to every error would silently turn a real
    // verdict into a transient retry, forever.
    const fetchImpl = routeBody(
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json',
      headersThenBodyError(new Error('socket hang up')),
      releaseRoutes(),
    )
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token', false, 2000)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('no-manifest')
      expect(result.detail).toBe('package.json was unreadable.')
    }
  })

  it('does not multiply the tarball deadline by the retry ladder', async () => {
    // 300s is defensible for ONE attempt and indefensible for four. fetchRobust
    // retries a throw four times with backoff, so a stalled asset HOST -- the
    // CI egress allowlist this module's own catch comment names, where
    // api.github.com is permitted and the asset's separate redirect host is
    // not -- cost 4 x 300s + 14s backoff = 21 minutes per repository. Measured
    // against the live state file: 303 of 13,120 candidates carry a release,
    // so a 2000-repo run puts ~46 on this path, ~243 minutes at
    // REPO_CONCURRENCY 4 -- twice the whole job bound, spent on an advisory
    // rescue probe that degrades to "no release" anyway.
    let assetCalls = 0
    const routes = releaseRoutes()
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (text.startsWith(assetUrl)) {
        assetCalls += 1
        return new Promise<Response>(() => {})
      }
      for (const [prefix, response] of Object.entries(routes)) {
        if (text.startsWith(prefix)) return response
      }
      throw new Error(`unrouted url: ${text}`)
    }) as unknown as typeof fetch
    const started = Date.now()
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token', true, 2000, 60)
    expect(assetCalls).toBe(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates[0]?.release).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('never turns a stalled subpackage-tree BODY into a permanent no-manifest verdict', async () => {
    // The same trap one function over. A swallowed deadline on the git/trees
    // read makes a monorepo look like it has no subpackages, and a root with
    // no bundle of its own then earns "declares no name and no installable
    // subpackage" — persisted, published, and false.
    const treeUrl = 'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1'
    const monorepoMeta = { ...meta, fullName: 'someone/monorepo' }
    const fetchImpl = routeBody(treeUrl, headersThenStalledBody(), {
      'https://raw.githubusercontent.com/someone/monorepo/main/package.json':
        new Response(JSON.stringify({ private: true, workspaces: ['packages/*'] }), { status: 200 }),
      'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
        sha: commit, commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const started = Date.now()
    await expect(fetchRepoCandidate(monorepoMeta, fetchImpl, sleep, 'token', true, 60))
      .rejects.toThrow('github request exceeded 60ms')
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('never turns a stalled manifest BODY into a permanent no-manifest verdict', async () => {
    // The deadline now reaches the body, and readManifest's catch used to call
    // every unreadable body "package.json was unreadable" — a `no-manifest`,
    // which harvestRepos PERSISTS in repo-state.json as a dead end and
    // publishes under the repository's name. For a stall on OUR side that is a
    // false and durable accusation, so the deadline is rethrown instead and
    // lands where every other transient failure does.
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({
          items: [{ full_name: 's/stalled', default_branch: 'main', description: null, license: null, pushed_at: '2026-08-02T00:00:00Z' }],
        }), { status: 200 })
      }
      return headersThenStalledBody()(text, init)
    }) as unknown as typeof fetch
    const started = Date.now()
    const result = await harvestRepos({ state: {}, budget: 5, fetchImpl, sleep, token: 't', timeoutMs: 60 })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.repo).toBe('s/stalled')
    expect(result.failures[0]?.code).toBe('fetch-failed')
    expect(result.failures[0]?.detail).toContain('not a judgement on the repository')
    expect(result.thrown).toBe(1)
    // Not written off: nothing about this repo is recorded, so the next run
    // fetches it again rather than carrying a verdict it never earned.
    expect(result.nextState['s/stalled']).toBeUndefined()
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('a deadline is never relabelled as a malformed body', () => {
  it('says the search stalled, not that GitHub sent something that is not JSON', async () => {
    // Before the deadline reached bodies this could not happen; now it can.
    // Throwing is right — a search that cannot complete must abort the harvest
    // rather than publish a short ecosystem — but "answered 200 with a body
    // that is not JSON" sends an operator hunting a proxy error page while the
    // truth is that GitHub stalled and our own clock ran out.
    const expiry = new FetchTimeoutError('github request exceeded 30000ms')
    const fetchImpl = headersThenBodyError(expiry)
    await expect(searchReposByTopic(fetchImpl, sleep, 'token')).rejects.toThrow('exceeded 30000ms')
    await expect(searchReposByTopic(fetchImpl, sleep, 'token')).rejects.not.toThrow('not JSON')
  })
})
