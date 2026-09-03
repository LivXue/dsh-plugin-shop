import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MAX_TARBALL_BYTES, fetchRepoCandidate, harvestRepos, partitionTopic, searchReposByTopic } from '../src/github-client.ts'
import type { RepoState } from '../src/repo-state.ts'
import type { RepoCandidate } from '../src/types.ts'

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

  it('refuses a tarball whose content-length exceeds the cap — the probe degrades, never throws', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(buildManifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': headResponse(),
      'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest': new Response(JSON.stringify({
        tag_name: 'v1.0.0',
        assets: [{ browser_download_url: assetUrl }],
      }), { status: 200 }),
      [assetUrl]: new Response('x', { status: 200, headers: { 'content-length': String(MAX_TARBALL_BYTES + 1) } }),
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
        for (let i = 0; i <= MAX_TARBALL_BYTES / chunkSize; i += 1) controller.enqueue(new Uint8Array(chunkSize))
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
    // Skipped exactly the way an unreadable subpackage body is skipped: a
    // manifest we decline to read never got to claim it was a plugin, so it is
    // not recorded as a failure either. The bundle-less root is what remains.
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.candidates.map(c => c.name)).toEqual(['monorepo-root'])
      expect(result.subpackageFailures).toBeUndefined()
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
    snippet: 'const body = await response.json() as { total_count?: unknown }',
    reason: "api.github.com search: reads GitHub's own total_count number, not repository-authored text",
  },
  {
    snippet: 'const body = await response.json() as { items?: unknown }',
    reason: 'api.github.com search: a page of repo metadata GitHub composes, bounded by SEARCH_PAGE_SIZE',
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

/** Every `await <receiver>.json()` / `.text()` in the module, with the
 * top-level function it sits in. */
function findBodyReads(source: string): { line: string; lineNumber: number; enclosing: string }[] {
  const found: { line: string; lineNumber: number; enclosing: string }[] = []
  let enclosing = '(module scope)'
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    const declaration = /^(?:export )?(?:async )?function (\w+)/.exec(line)
    if (declaration?.[1] !== undefined) enclosing = declaration[1]
    if (/await\s+\w+\.(?:json|text)\(\)/.test(line)) {
      found.push({ line: line.trim(), lineNumber: index + 1, enclosing })
    }
  }
  return found
}

describe('every response body read in github-client.ts is capped or excused', () => {
  it('finds the reads at all, so the scan cannot pass by matching nothing', () => {
    // Without this, a regex that stops matching turns the exhaustiveness check
    // below into a loop over an empty list — green, and guarding nothing.
    const reads = findBodyReads(githubClientSource)
    expect(reads.length).toBeGreaterThanOrEqual(EXCUSED_BODY_READS.length + 1)
    expect(reads.some(r => r.enclosing === 'readManifest')).toBe(true)
  })

  it('is readManifest, or an excused non-manifest read, for every one of them', () => {
    for (const read of findBodyReads(githubClientSource)) {
      if (read.enclosing === 'readManifest') continue
      const excused = EXCUSED_BODY_READS.some(e => read.line.includes(e.snippet))
      expect(
        excused,
        `github-client.ts:${read.lineNumber} (in ${read.enclosing}) reads a response body outside `
          + 'readManifest. A manifest body must go through readManifest, which is where '
          + 'MAX_MANIFEST_BYTES is enforced; anything else needs a reasoned entry in '
          + `EXCUSED_BODY_READS saying why it is not a manifest. Line: ${read.line}`,
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
        `EXCUSED_BODY_READS carries a snippet that is no longer in github-client.ts, so its reason `
          + `("${excused.reason}") no longer applies to anything: ${excused.snippet}`,
      ).toBe(true)
    }
  })
})
