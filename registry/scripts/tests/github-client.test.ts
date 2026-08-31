import { describe, expect, it } from 'vitest'
import { fetchRepoCandidate, harvestRepos, partitionTopic, searchReposByTopic } from '../src/github-client.ts'
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
      expect(result.candidate.name).toBe('dsh-repo-plugin')
      expect(result.candidate.repo).toBe('someone/dsh-repo-plugin')
      expect(result.candidate.commit).toBe(commit)
      expect(result.candidate.requiresBuild).toBe(false)
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
      catalog: null,
      description: 'x',
    }
  }
  function entryOf(repo: string): RepoState[string] {
    return { pushedAt: '2026-08-01T00:00:00Z', commit, candidate: candidateOf(repo) }
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
    expect(result.nextState['a/unchanged']?.candidate.repo).toBe('a/unchanged')
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
