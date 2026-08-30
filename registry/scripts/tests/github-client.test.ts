import { describe, expect, it } from 'vitest'
import { fetchRepoCandidate, harvestRepos, searchReposByTopic } from '../src/github-client.ts'

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

function searchPage(names: string[]): Response {
  return new Response(JSON.stringify({
    items: names.map(full_name => ({
      full_name,
      default_branch: 'main',
      description: `description of ${full_name}`,
      license: { spdx_id: 'MIT' },
    })),
  }), { status: 200 })
}

describe('searchReposByTopic', () => {
  it('searches both topics, deduplicates, and sorts', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      if (String(url).includes('topic:dsh-plugin')) return searchPage(['zeta/plugin', 'alpha/plugin'])
      return searchPage(['alpha/plugin', 'beta/plugin'])
    }) as unknown as typeof fetch
    const { repos, capped } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(repos.map(r => r.fullName)).toEqual(['alpha/plugin', 'beta/plugin', 'zeta/plugin'])
    expect(capped).toBe(false)
    expect(urls.some(u => u.includes('topic:dsh-plugin'))).toBe(true)
    expect(urls.some(u => u.includes('topic:deepseek-harness'))).toBe(true)
  })

  it('drops search items the schema cannot trust', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      items: [{ full_name: 'ok/repo', default_branch: 'main', description: null, license: null }, { full_name: 42 }],
    }), { status: 200 })) as unknown as typeof fetch
    const { repos } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(repos).toHaveLength(1)
    expect(repos[0]?.fullName).toBe('ok/repo')
  })

  it('reports when a topic hits the 1000-result platform cap', async () => {
    const fetchImpl = (async (url: string | URL) => {
      // A full tenth page of the cap: 100 items.
      return searchPage(Array.from({ length: 100 }, (_, i) => `cap/repo-${i}`))
    }) as unknown as typeof fetch
    const { capped } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(capped).toBe(true)
  })

  it('fails loudly when the search API answers with an error status', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    await expect(searchReposByTopic(fetchImpl, sleep, 'token')).rejects.toThrow(/403/)
  })
})

describe('fetchRepoCandidate', () => {
  const meta = { fullName: 'someone/dsh-repo-plugin', defaultBranch: 'main', description: 'A repo plugin.', license: 'MIT' }

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
      expect(result.candidate.name).toBe('dsh-repo-plugin')
      expect(result.candidate.repo).toBe('someone/dsh-repo-plugin')
      expect(result.candidate.commit).toBe(commit)
      expect(result.candidate.repository).toBe('https://github.com/someone/dsh-repo-plugin')
      expect(result.candidate.hasBundle).toBe(true)
      expect(result.candidate.requiresBuild).toBe(false)
      expect(result.candidate.publishedAt).toBe('2026-08-01T12:00:00.000Z')
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

  it('reports no-manifest for an unreadable or nameless manifest', async () => {
    const unreadable = await fetchRepoCandidate(meta, stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response('{oops', { status: 200 }),
    }), sleep, 'token')
    expect(unreadable.ok).toBe(false)
    if (!unreadable.ok) expect(unreadable.code).toBe('no-manifest')

    const nameless = await fetchRepoCandidate(meta, stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({ dsh: { bundle: {} } }), { status: 200 }),
    }), sleep, 'token')
    expect(nameless.ok).toBe(false)
    if (!nameless.ok) expect(nameless.code).toBe('no-manifest')
  })

  it('marks a manifest declaring a prepare script as requiring a build', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
        name: 'dsh-repo-plugin', scripts: { prepare: 'npm run build' }, dsh: { bundle: {} },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-01T00:00:00.000Z' } } }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidate.requiresBuild).toBe(true)
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
})

describe('harvestRepos', () => {
  it('skips loudly (report note) when no token is present', async () => {
    const result = await harvestRepos((async () => { throw new Error('never called') }) as unknown as typeof fetch, sleep, undefined)
    expect(result.skipped).toBe(true)
    expect(result.candidates).toHaveLength(0)
  })

  it('unions candidates and keeps failures with their reasons', async () => {
    const search = (async (url: string | URL) => {
      if (String(url).includes('topic:dsh-plugin')) {
        return new Response(JSON.stringify({ items: [{ full_name: 'ok/repo', default_branch: 'main', description: 'x', license: { spdx_id: 'MIT' } }, { full_name: 'bad/repo', default_branch: 'main', description: 'x', license: { spdx_id: 'MIT' } }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('/search/repositories')) return search(url)
      for (const [prefix, response] of Object.entries({
        'https://raw.githubusercontent.com/ok/repo/main/package.json': new Response(JSON.stringify({ name: 'ok-repo', dsh: { bundle: {} } }), { status: 200 }),
        'https://api.github.com/repos/ok/repo/commits/main': new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-01T00:00:00.000Z' } } }), { status: 200 }),
        'https://raw.githubusercontent.com/bad/repo/main/package.json': new Response('missing', { status: 404 }),
        'https://api.github.com/repos/bad/repo/commits/main': new Response(JSON.stringify({ sha: commit }), { status: 200 }),
      })) {
        if (String(url).startsWith(prefix)) return response
      }
      throw new Error(`unrouted: ${String(url)}`)
    }) as unknown as typeof fetch

    const result = await harvestRepos(fetchImpl, sleep, 'token')
    expect(result.skipped).toBe(false)
    expect(result.candidates.map(c => c.repo)).toEqual(['ok/repo'])
    expect(result.failures).toEqual([{ repo: 'bad/repo', code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }])
  })
})

describe('fetch robustness', () => {
  it('retries a transient network throw and succeeds when the connection recovers', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async (url: string | URL) => {
      call += 1
      if (call === 1) throw new Error('UND_ERR_HEADERS_TIMEOUT')
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const { repos } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(repos).toEqual([])
    expect(call).toBe(3) // the throw, its retry, then the second topic's clean page
    expect(delays).toEqual([2000])
  })

  it('gives up after four attempts and throws the network error', async () => {
    const sleep = async (_ms: number) => {}
    const fetchImpl = (async () => { throw new Error('UND_ERR_HEADERS_TIMEOUT') }) as unknown as typeof fetch
    await expect(searchReposByTopic(fetchImpl, sleep, 'token')).rejects.toThrow(/UND_ERR_HEADERS_TIMEOUT/)
  })
})
