import { describe, expect, it } from 'vitest'
import { fetchCandidate, fetchCandidates, HARVEST_CONCURRENCY, HARVEST_KEYWORDS, PEERS_MAX_COUNT, searchByKeywords, toCandidate } from '../src/npm-client.ts'

describe('HARVEST_KEYWORDS', () => {
  it('leads with the ecosystem keyword and adds the harness keyword, neither branded', () => {
    expect(HARVEST_KEYWORDS).toEqual(['dsh-plugin', 'deepseek-harness'])
  })
})

describe('toCandidate', () => {
  const packument = {
    name: 'dsh-hello-plugin',
    'dist-tags': { latest: '1.2.0' },
    time: { '1.2.0': '2026-08-01T12:00:00.000Z' },
    versions: {
      '1.2.0': {
        dist: { integrity: 'sha512-hello' },
        license: 'MIT',
        repository: { url: 'git+https://github.com/you/hello-plugin.git' },
        description: 'Says hello.',
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
        },
      },
    },
  }

  it('never takes the publisher from the unverified author field', () => {
    // `author` is free text the publisher writes, and a clone inherits it
    // verbatim: `dsh-agent-squad`, published by the account `shenzhsjtu`,
    // carries the name and email of the author of the package it copied.
    // Presenting that as the publisher would print the original author's name
    // on the clone — the exact opposite of what the row is for.
    const withAuthor = {
      ...packument,
      maintainers: [{ name: 'realauthor' }],
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          _npmUser: { name: 'realauthor', email: 'real@example.com' },
          author: { name: 'Someone Else', email: 'someone@else.test' },
        },
      },
    }
    expect(toCandidate(withAuthor)?.publisher).toBe('realauthor')
  })

  it('carries no publisher when there is no maintainer account to name', () => {
    // With no maintainers there is nothing corroborating `_npmUser`, and an
    // uncorroborated value can be the CI robot. No answer beats a wrong one.
    const orphan = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'GitHub Actions' } } },
    }
    expect(toCandidate(orphan)?.publisher).toBeUndefined()
  })

  it('falls back to the owning account when the publish came from CI', () => {
    // Measured on 250 live npm entries: 30 of them report `_npmUser` as the
    // literal robot identity "GitHub Actions" — the trusted-publisher path a
    // well-run project uses. Showing that would name no one, and it would
    // read WORSE for the original than for a clone: `@nanmicoder/dsh-agent-
    // teams` publishes from CI while the clone `dsh-agent-squad` was pushed
    // by hand, so the clone would be the one showing a human account. A
    // `_npmUser` that is not among the maintainers is not an identity.
    const ci = {
      ...packument,
      maintainers: [{ name: 'realauthor' }, { name: 'second' }],
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'GitHub Actions' } },
      },
    }
    expect(toCandidate(ci)?.publisher).toBe('realauthor')
  })

  it('prefers the publishing account when it IS one of the maintainers', () => {
    // 220 of those 250 publish under their own account; that account is both
    // the owner and the one npm recorded for this version, so it is the
    // strongest single answer even when the package has several maintainers.
    const own = {
      ...packument,
      maintainers: [{ name: 'first' }, { name: 'realauthor' }],
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'realauthor' } },
      },
    }
    expect(toCandidate(own)?.publisher).toBe('realauthor')
  })

  it('carries no publisher when npm records no account at all', () => {
    // Older packages predate `_npmUser`; the field stays absent rather than
    // falling back to the unverified `author`.
    expect(toCandidate(packument)?.publisher).toBeUndefined()
  })

  it('never carries the publisher email into the candidate', () => {
    const withUser = {
      ...packument,
      maintainers: [{ name: 'realauthor', email: 'real@example.com' }],
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], _npmUser: { name: 'realauthor', email: 'real@example.com' } },
      },
    }
    // npm publishes the address; our artifact has no use for it and must not
    // republish it. The publisher IS resolved here, so the assertion bites.
    expect(toCandidate(withUser)?.publisher).toBe('realauthor')
    expect(JSON.stringify(toCandidate(withUser))).not.toContain('real@example.com')
  })

  it('reads the latest version', () => {
    expect(toCandidate(packument)?.version).toBe('1.2.0')
  })

  it('projects the npm description onto the candidate', () => {
    expect(toCandidate(packument)?.description).toBe('Says hello.')
  })

  it('reports a missing description as null, not undefined', () => {
    const noDescription = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], description: undefined },
      },
    }
    expect(toCandidate(noDescription)?.description).toBeNull()
  })

  it('normalizes a git repository url to https', () => {
    expect(toCandidate(packument)?.repository).toBe('https://github.com/you/hello-plugin')
  })

  it('reads the publication time of that version', () => {
    expect(toCandidate(packument)?.publishedAt).toBe('2026-08-01T12:00:00.000Z')
  })

  it('reports the presence of dsh.bundle', () => {
    expect(toCandidate(packument)?.hasBundle).toBe(true)
  })

  it('carries dsh.catalog through unvalidated', () => {
    expect(toCandidate(packument)?.catalog).toMatchObject({ category: 'tool' })
  })

  it('marks a deprecated version', () => {
    const deprecated = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], deprecated: 'do not use' },
      },
    }
    expect(toCandidate(deprecated)?.deprecated).toBe(true)
  })

  it('returns null when the latest tag names a missing version', () => {
    expect(toCandidate({ ...packument, 'dist-tags': { latest: '9.9.9' } })).toBeNull()
  })

  it('returns null for a packument with no name', () => {
    expect(toCandidate({ 'dist-tags': { latest: '1.0.0' } })).toBeNull()
  })

  it('extracts keywords from the manifest', () => {
    const doc = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], keywords: ['dsh-plugin', 'files', 'git'] },
      },
    }
    const candidate = toCandidate(doc)
    expect(candidate?.keywords).toEqual(['dsh-plugin', 'files', 'git'])
  })

  it('uses an empty keyword list when the manifest has none', () => {
    const candidate = toCandidate(packument)
    expect(candidate?.keywords).toEqual([])
  })

  it('keeps only string keywords', () => {
    const doc = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], keywords: ['ok', 42, null, 'also-ok'] },
      },
    }
    const candidate = toCandidate(doc)
    expect(candidate?.keywords).toEqual(['ok', 'also-ok'])
  })

  it('keeps the names of the peer dependencies, dropping the ranges', () => {
    // Shape copied from dsh-timeline@0.1.4, the package whose peer on
    // @deepseek-ai/dsh-client-store broke a user's harness: every range there
    // is "*", which is why ranges are not recorded. Declared out of
    // alphabetical order (react first) so this assertion cannot pass against
    // an implementation that sorts peers instead of preserving manifest order.
    const withPeers = {
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: {
            react: '^18.2.0',
            '@deepseek-ai/cordis': '*',
            '@deepseek-ai/dsh-client-store': '*',
          },
        },
      },
    }
    expect(toCandidate(withPeers)?.peers).toEqual([
      'react',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
    ])
  })

  it('reads no peers when the manifest declares none', () => {
    expect(toCandidate(packument)?.peers).toEqual([])
  })

  it('reads no peers when peerDependencies is not an object', () => {
    const hostile = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: 'everything' } },
    }
    expect(toCandidate(hostile)?.peers).toEqual([])
  })

  it('reads no peers when peerDependencies is an array, not a plain object', () => {
    // Object.keys on an array yields index strings ('0', '1', ...) rather than
    // throwing, so without this guard those indices would be recorded as peer
    // names and later reported to a user as peers the harness does not provide
    // — a false accusation manufactured from hostile input. An array is refused
    // outright rather than read.
    const hostileArray = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: ['react', 'vue'] } },
    }
    expect(toCandidate(hostileArray)?.peers).toEqual([])
  })

  it('reads no peers when peerDependencies is null', () => {
    // typeof null === 'object' in JS, which is exactly why the guard checks
    // `!== null` before checking `typeof === 'object'`. Without that clause,
    // Object.keys(null) throws TypeError, uncaught by fetchCandidate or the
    // batch in fetchCandidates — one package publishing this legal JSON would
    // take down the whole harvest instead of becoming one fetch-failed entry.
    const hostileNull = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: null } },
    }
    expect(toCandidate(hostileNull)?.peers).toEqual([])
  })

  it('caps the number of recorded peers, dropping the rest rather than rejecting the package', () => {
    // peerDependencies keys are hostile npm input with no size limit of
    // their own; a manifest declaring far more than any real dependency
    // list needs must not inflate the published catalog or hand every
    // reader's host that many resolutions to attempt on each catalog load.
    const many = Object.fromEntries(
      Array.from({ length: PEERS_MAX_COUNT + 50 }, (_, i) => [`peer-${i}`, '*']),
    )
    const hostile = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: many } },
    }
    const candidate = toCandidate(hostile)
    expect(candidate?.peers).toHaveLength(PEERS_MAX_COUNT)
    expect(candidate?.peers).toEqual(Object.keys(many).slice(0, PEERS_MAX_COUNT))
  })

  it('drops a peer name past the length bound, the way it drops the count tail', () => {
    // 200 peer names are recorded and each reaches every reader's plugins.json
    // verbatim with no bound of its own. The documented policy for this field
    // is "the excess is dropped, never rejected" — an oversized manifest costs
    // the author the tail, not the listing.
    const result = toCandidate({
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: { ok: '*', ['x'.repeat(215)]: '*' },
        },
      },
    })
    expect(result?.peers).toEqual(['ok'])
  })

  it('drops an empty peer name, which is no package at all', () => {
    // JSON permits "" as a key. It is not a resolvable package, and recording
    // it hands every reader's host a blank requirement to render and resolve.
    const result = toCandidate({
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: { '': '*', ok: '*' },
        },
      },
    })
    expect(result?.peers).toEqual(['ok'])
  })
})

describe('searchByKeywords', () => {
  it('pages every harvest keyword until the answered total is reached', async () => {
    // Every keyword costs a leading total-probe, the pages themselves, and a
    // trailing re-probe (round 2: the unpartitioned branch re-probes too, so
    // churn is tolerated symmetrically with the partitioned branch) — so
    // dsh-plugin costs 4 requests (probe, two pages, re-probe) and
    // deepseek-harness costs 3 (probe, one already-empty page, re-probe).
    const pages = [
      { total: 251, objects: [] }, // dsh-plugin: pre-paging probe
      { total: 251, objects: Array.from({ length: 250 }, (_, i) => ({ package: { name: `dsh-p${i}` } })) },
      { total: 251, objects: [{ package: { name: 'dsh-last' } }] },
      { total: 251, objects: [] }, // dsh-plugin: post-paging re-probe
      { total: 0, objects: [] }, // deepseek-harness: pre-paging probe
      { total: 0, objects: [] }, // deepseek-harness: one page, already empty
      { total: 0, objects: [] }, // deepseek-harness: post-paging re-probe
    ]
    const urls: string[] = []
    let call = 0
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      const body = pages[call] ?? { total: 0, objects: [] }
      call += 1
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(251)
    expect(names).toContain('dsh-last') // the union is sorted, so it cannot anchor the tail
    expect(call).toBe(7)
    // `keywords:` is percent-encoded ahead of the name now (partition cells
    // need to carry a comma safely); decode before matching so this proves a
    // KEYWORD query, not just a substring anywhere in the URL — a bare,
    // unfiltered `text=dsh-plugin` would satisfy a loose `.includes`.
    expect(urls.some(url => decodeURIComponent(url).includes('keywords:dsh-plugin'))).toBe(true)
    expect(urls.some(url => decodeURIComponent(url).includes('keywords:deepseek-harness'))).toBe(true)
  })

  it('unions the keywords, deduplicates, and sorts', async () => {
    // Matches past the colon: `text=keywords:dsh-plugin` is now sent
    // percent-encoded (`keywords%3Adsh-plugin`), so the literal `keywords:`
    // prefix no longer appears in the URL — route on the decoded query so a
    // loose substring match cannot also route an unfiltered text search.
    // Both the probe and the page fetch land on the same branch, which is
    // harmless here: each response carries the total that matches its own
    // object count, so every cell still ends on its first (only) page.
    const fetchImpl = (async (url: string | URL) => {
      const text = decodeURIComponent(String(url))
      if (text.includes('keywords:dsh-plugin')) {
        return new Response(JSON.stringify({ total: 2, objects: [{ package: { name: 'b' } }, { package: { name: 'a' } }] }), { status: 200 })
      }
      if (text.includes('keywords:deepseek-harness')) {
        return new Response(JSON.stringify({ total: 2, objects: [{ package: { name: 'b' } }, { package: { name: 'c' } }] }), { status: 200 })
      }
      throw new Error(`unexpected url: ${text}`)
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).resolves.toEqual(['a', 'b', 'c'])
  })

  it('throws when the registry answers with an error status, naming the keyword', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(/keywords:dsh-plugin.*503/)
  })

  it('aborts when a later keyword search fails, rather than harvesting a subset', async () => {
    // Matches past the colon — see the comment in the union test above.
    const fetchImpl = (async (url: string | URL) => {
      if (decodeURIComponent(String(url)).includes('keywords:deepseek-harness')) return new Response('nope', { status: 503 })
      return new Response(JSON.stringify({ total: 1, objects: [{ package: { name: 'fine' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(/keywords:deepseek-harness.*503/)
  })

  it('retries a rate-limited search and succeeds when the registry recovers', async () => {
    const sleep = async (_ms: number) => {}
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const names = await searchByKeywords(fetchImpl, sleep)
    expect(names).toHaveLength(0)
    // dsh-plugin's total-probe: the 429, then its retry (2); dsh-plugin's one
    // empty page (3); dsh-plugin's post-paging re-probe (4); deepseek-harness's
    // probe (5), one empty page (6), and its own post-paging re-probe (7).
    expect(call).toBe(7)
  })

  it('gives up after bounded retries and throws the final 429', async () => {
    const sleep = async (_ms: number) => {}
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      return new Response('rate limited', { status: 429 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl, sleep)).rejects.toThrow(/429/)
    expect(call).toBe(6)
  })

  it('honors Retry-After when backing off a rate-limited search', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '3' } })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(delays).toEqual([3000])
  })

  it('backs off exponentially when a 429 carries no Retry-After', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call < 6) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000])
  })

  it('spends about a minute of backoff before giving up on a rate limit', async () => {
    // The budget is the point of the retry: an IP-level throttle takes minutes
    // to clear, and the 7s this used to spend never outlived one. Pinned as a
    // total so a change to either the count or the base has to be deliberate.
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl, sleep)).rejects.toThrow(/429/)
    expect(delays.reduce((a, b) => a + b, 0)).toBe(62_000)
  })

  it('clamps an absurd Retry-After to the maximum delay', async () => {
    const delays: number[] = []
    const sleep = async (ms: number) => { delays.push(ms) }
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '3600' } })
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(delays).toEqual([60_000])
  })

  it('sends an Authorization header when a token is given', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep, 'npm_readonly_token')
    expect(headersSeen).toHaveLength(6) // a pre-paging probe, one page, and a post-paging re-probe, per keyword
    expect(headersSeen.every(headers => headers?.Authorization === 'Bearer npm_readonly_token')).toBe(true)
  })

  it('sends no Authorization header without a token', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(headersSeen).toHaveLength(6) // a pre-paging probe, one page, and a post-paging re-probe, per keyword
    expect(headersSeen.every(headers => headers === undefined)).toBe(true)
  })

  // A search stub built from per-query totals and pages. `size=1` is the
  // total probe, anything else is a page fetch; both answer `total` the way
  // the live registry does, so the loop under test reads it.
  function stubSearch(
    totals: Record<string, number> | ((query: string) => number),
    pages: (query: string, from: number) => string[],
    pagedTotals: Record<string, number> = {},
  ): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = []
    // A function lets a fixture answer a different total on a later call —
    // static totals can never move, so `before === after` in every prior
    // fixture, which left the coverage check's churn tolerance untested.
    const readTotal = (query: string): number =>
      typeof totals === 'function' ? totals(query) : (totals[query] ?? 0)
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      urls.push(text)
      const params = new URL(text).searchParams
      const query = params.get('text') ?? ''
      const total = readTotal(query)
      if (params.get('size') === '1') {
        return new Response(JSON.stringify({ total, objects: [] }), { status: 200 })
      }
      const from = Number(params.get('from') ?? '0')
      const names = pages(query, from)
      return new Response(JSON.stringify({
        total: pagedTotals[query] ?? total,
        objects: names.map(name => ({ package: { name } })),
      }), { status: 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, urls }
  }

  it('does not end a keyword on a short non-final page — it reads the total', async () => {
    // Live shape: npm served a 249-object page of a 600-name result set. The
    // old `objects.length < PAGE_SIZE` break dropped pages 1 and 2 in silence.
    const totals = { 'keywords:dsh-plugin': 600, 'keywords:deepseek-harness': 0 }
    const { fetchImpl } = stubSearch(totals, (query, from) => {
      if (query !== 'keywords:dsh-plugin') return []
      if (from === 0) return Array.from({ length: 249 }, (_, i) => `a${i}`)
      if (from === 250) return Array.from({ length: 250 }, (_, i) => `b${i}`)
      if (from === 500) return Array.from({ length: 101 }, (_, i) => `c${i}`)
      return []
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(600)
    expect(names).toContain('c100')
  })

  it('throws, naming the reachable window, when a keyword is past it and nothing splits it', async () => {
    // Every query — the keyword and every refinement cell — reports 6000, so
    // no cell fits. The message must name the window and the cap, not blame
    // "100 pages" the way the old bound did.
    const everythingOversized = new Proxy({} as Record<string, number>, { get: () => 6000 })
    const { fetchImpl, urls } = stubSearch(everythingOversized, () => [])
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin,\S+ reports more than the 5250 names one query can reach \(from is capped at 5000\) and no refinement keyword splits it/,
    )
    // Every request is a size=1 probe: not one wasted page fetch.
    expect(urls.every(url => new URL(url).searchParams.get('size') === '1')).toBe(true)
  })

  it('partitions an over-window keyword into refinement cells and unions them', async () => {
    // A self-consistent fixture: the keyword is 5,300 names, two refinement
    // cells hold 5,000 and 300, and the pages actually serve them — so the
    // coverage check below passes on the same arithmetic the cells report.
    const totals: Record<string, number> = {
      'keywords:dsh-plugin': 5300,
      'keywords:dsh-plugin,dsh': 5000,
      'keywords:dsh-plugin,deepseek-harness': 300,
      'keywords:deepseek-harness': 0,
    }
    const { fetchImpl } = stubSearch(totals, (query, from) => {
      const total = totals[query] ?? 0
      const prefix = query === 'keywords:dsh-plugin,dsh' ? 'd' : 'h'
      if (query !== 'keywords:dsh-plugin,dsh' && query !== 'keywords:dsh-plugin,deepseek-harness') return []
      return Array.from(
        { length: Math.max(0, Math.min(250, total - from)) },
        (_, i) => `${prefix}${from + i}`,
      )
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(5300)
    expect(names).toContain('d0')
    expect(names).toContain('d4999')
    expect(names).toContain('h299')
  })

  it('throws when the refinement cells do not cover the keyword', async () => {
    // No negation qualifier exists, so a partition is never covering by
    // construction — the shortfall must be measured and refused, never
    // published as a short harvest.
    const totals: Record<string, number> = {
      'keywords:dsh-plugin': 5300,
      'keywords:dsh-plugin,dsh': 10,
      'keywords:deepseek-harness': 0,
    }
    const { fetchImpl } = stubSearch(totals, (query, from) =>
      query === 'keywords:dsh-plugin,dsh' && from === 0
        ? Array.from({ length: 10 }, (_, i) => `n${i}`)
        : [])
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin enumerated 10 of 5300 names across 1 partition cell\(s\); the refinement keywords do not cover the keyword/,
    )
  })

  it('tolerates a partition total that shrinks between the pre- and post-paging probe', async () => {
    // Ordinary publish/unpublish churn during a run must not fail a harvest
    // that is otherwise complete: `min(before, after)` is the tolerance. Every
    // fixture above uses a static `totals` map, so `before === after` always
    // held — swapping `Math.min` for `Math.max`, or deleting the second probe
    // entirely, left every one of them green.
    let dshPluginProbes = 0
    const totals = (query: string): number => {
      if (query === 'keywords:dsh-plugin') {
        dshPluginProbes += 1
        // Before paging: 5,300 (over the window, so it partitions). After
        // paging: 5,297 — three names unpublished mid-run.
        return dshPluginProbes === 1 ? 5300 : 5297
      }
      if (query === 'keywords:dsh-plugin,dsh') return 5000
      if (query === 'keywords:dsh-plugin,deepseek-harness') return 297
      return 0 // deepseek-harness itself, and every other refinement cell
    }
    const { fetchImpl } = stubSearch(totals, (query, from) => {
      if (query !== 'keywords:dsh-plugin,dsh' && query !== 'keywords:dsh-plugin,deepseek-harness') return []
      const total = query === 'keywords:dsh-plugin,dsh' ? 5000 : 297
      const prefix = query === 'keywords:dsh-plugin,dsh' ? 'd' : 'h'
      return Array.from(
        { length: Math.max(0, Math.min(250, total - from)) },
        (_, i) => `${prefix}${from + i}`,
      )
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(5297)
    expect(dshPluginProbes).toBe(2) // the pre-partition probe, then the post-paging recheck
  })

  it('tolerates churn on the unpartitioned branch too', async () => {
    // Round 1 reused the stale pre-paging `total` as `after` for an
    // unpartitioned keyword, so `required = min(total, total) = total` — zero
    // tolerance for any churn at all: an ordinary unpublish between the probe
    // and the page landing looked identical to a truncated harvest. The churn
    // test above never caught this — dsh-plugin there is always over the
    // window, so it only exercises the partitioned branch, which already
    // re-probed under round 1.
    let calls = 0
    const totals = (query: string): number => {
      if (query !== 'keywords:dsh-plugin') return 0 // deepseek-harness stays empty
      calls += 1
      // Touch 1: the pre-paging probe, answering 10. Touch 2: the page
      // itself, self-consistent at 8 objects of 8. Touch 3: the post-paging
      // re-probe, confirming 8 — two names unpublished between touch 1 and 3.
      return calls === 1 ? 10 : 8
    }
    const { fetchImpl } = stubSearch(totals, (query) =>
      query === 'keywords:dsh-plugin' ? Array.from({ length: 8 }, (_, i) => `p${i}`) : [])

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(8)
    expect(calls).toBe(3) // pre-paging probe, the one page, and the post-paging re-probe
  })

  it('refuses to ask for a from past the window instead of paging into the wrap', async () => {
    // The probe says the keyword fits, the pages say it does not. `from=5250`
    // would silently return page 0 (measured live), so the loop must throw.
    const { fetchImpl, urls } = stubSearch(
      { 'keywords:dsh-plugin': 5250, 'keywords:deepseek-harness': 0 },
      () => Array.from({ length: 250 }, (_, i) => `p${i}`),
      { 'keywords:dsh-plugin': 9999 },
    )
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin needs from=5250, past the 5000 the registry honors \(a larger from silently returns page 0\)/,
    )
    expect(urls).toHaveLength(22) // one size=1 probe plus from=0..5000
  })

  it('throws when a page answers no total, rather than ending the cell silently', async () => {
    // A response carrying no `total` cannot be told apart from a truncated
    // page: defaulting it to 0 made `from + objects.length >= 0` true on the
    // very first page, so a full 250-object page silently ended the cell and
    // the harvest returned a quarter of a keyword's actual names without
    // complaint. Live shape: the registry has served a 200 with
    // `<!doctype html>` and a 429 with a 7 KB HTML body on ordinary search
    // pages, so a missing total is not hypothetical. The probe answers a
    // real total here — searchTotal's own missing-total throw is pinned
    // separately below — so this isolates the page loop's own check.
    let call = 0
    const fetchImpl = (async (url: string | URL) => {
      call += 1
      const params = new URL(String(url)).searchParams
      if (params.get('size') === '1') {
        return new Response(JSON.stringify({ total: 300, objects: [] }), { status: 200 })
      }
      const body = { objects: Array.from({ length: 250 }, (_, i) => ({ package: { name: `dsh-forever-${i}` } })) }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered no total; a truncated page cannot be told from a complete one/,
    )
    expect(call).toBe(2) // the probe, then the one page that trips the throw
  })

  it('throws when the total probe itself answers no total', async () => {
    // searchTotal's own soft `?? 0` default made a malformed probe body read
    // as an empty keyword: partitionKeyword would return `{ total: 0,
    // partitioned: false }`, and the coverage floor above becomes
    // `min(0, 0) = 0` — silently disabled, never tripping regardless of what
    // the harvest actually finds. A missing total on the probe now throws
    // immediately, before any page is ever fetched.
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin at from=0 answered no total; a keyword's size cannot be measured without it/,
    )
    expect(call).toBe(1) // the probe itself trips the throw; no page is ever fetched
  })
})

describe('fetchCandidate', () => {
  const packument = {
    name: 'dsh-hello-plugin',
    'dist-tags': { latest: '1.2.0' },
    time: { '1.2.0': '2026-08-01T12:00:00.000Z' },
    versions: {
      '1.2.0': {
        dist: { integrity: 'sha512-hello' },
        license: 'MIT',
        repository: { url: 'git+https://github.com/you/hello-plugin.git' },
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
        },
      },
    },
  }

  it('returns the candidate for a readable packument', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(packument), { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.ok && result.candidate.name).toBe('dsh-hello-plugin')
  })

  it('retries a rate-limited packument fetch and succeeds when the registry recovers', async () => {
    const sleep = async (_ms: number) => {}
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl, sleep)
    expect(result.ok).toBe(true)
    expect(call).toBe(2)
  })

  it('sends an Authorization header when a token is given', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch

    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl, sleep, 'npm_readonly_token')
    expect(result.ok).toBe(true)
    expect(headersSeen[0]?.Authorization).toBe('Bearer npm_readonly_token')
  })

  it('reports the HTTP status when the registry answers with a non-OK status', async () => {
    // The 429 is retried a bounded number of times; when the registry never
    // recovers, the last response's status still reaches the rejection detail.
    const sleep = async (_ms: number) => {}
    const fetchImpl = (async () => new Response('nope', { status: 429 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-rate-limited', fetchImpl, sleep)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('429')
  })

  it('reports an unusable packument distinctly from an HTTP failure', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-no-name', fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).not.toContain('200')
  })

  it('reports a body that cannot be parsed as JSON as a rejection, not a thrown error', async () => {
    const fetchImpl = (async () => new Response('not valid json{{{', { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-malformed-body', fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('unreadable')
  })
})

describe('registry failover', () => {
  const noSleep = async (_ms: number) => {}
  const packument = { name: 'dsh-failover', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { dist: { integrity: 'sha512-x' }, license: 'MIT' } } }

  it('falls back to the backup registry when the primary throws, and uses the backup answer', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('UND_ERR_HEADERS_TIMEOUT')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidate.name).toBe('dsh-failover')
    expect(urls[0]).toContain('registry.npmjs.org')
    expect(urls[1]).toContain('registry.npmmirror.com')
  })

  it('falls back on a primary 5xx', async () => {
    let calls = 0
    const fetchImpl = (async (url: string | URL) => {
      calls += 1
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('bad gateway', { status: 502 })
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('falls back on a stalled primary — the timeout bounds the hang', async () => {
    let backupCalled = false
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Promise<Response>(() => {})
      backupCalled = true
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com', 50)
    expect(result.ok).toBe(true)
    expect(backupCalled).toBe(true)
  })

  it('never falls back on a 404 — the primary answer is authoritative', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('not found', { status: 404 })
      throw new Error('backup must not be consulted for a 404')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-missing', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('404')
  })

  it('does not fall back on an exhausted 429', async () => {
    let backupCalls = 0
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('throttled', { status: 429 })
      backupCalls += 1
      return new Response('unexpected', { status: 500 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-throttled', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('429')
    expect(backupCalls).toBe(0)
  })

  it('reports the primary failure in the detail when the backup also fails', async () => {
    // Changed with D-2: this asserted a THROW, which is what took the whole
    // harvest down on one dead packument. The primary's failure is still what
    // is reported — a mirror's opinion must never masquerade as npm's — but it
    // now arrives as the row CLAUDE.md requires instead of as an abort.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })

  it('reports the primary cause, not the backup\'s own error, when the backup also throws', async () => {
    // The backup call inside fetchWithFailover used to be unwrapped: a
    // throwing backup escaped in place of primaryError, so a caller heard
    // the mirror's own failure instead of npm's — exactly what the function's
    // own doc comment forbids ("a mirror's opinion must never masquerade as
    // npm's"). A primary throw plus a throwing (or stalled) backup used to
    // surface the backup's own message; it must still surface the primary's.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      throw new Error('mirror down')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })

  it('reports the primary status, not a wrapped message, when a primary 5xx survives a failed backup', async () => {
    // The same 500 produced two different, self-contradicting details
    // depending on whether a backup was configured and also failed: no
    // backup (or a healthy backup) reports "npm registry returned 500
    // fetching x"; a backup that ALSO failed used to wrap that same fact as
    // "could not reach the npm registry (npm registry returned 500)" — a
    // second, invented-sounding cause for the identical failure.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) return new Response('bad gateway', { status: 500 })
      return new Response('also down', { status: 500 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('npm registry returned 500 fetching dsh-failover')
  })

  it('reports the throw as a rejection when no backup registry is configured', async () => {
    // Same change of shape, same reason: a rejection with a truthful cause,
    // not an abort. searchByKeywords still THROWS on a failed search — a
    // partial keyword list is indistinguishable from a shrunken ecosystem.
    const fetchImpl = (async () => { throw new Error('primary down') }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })

  it('searches through the failover too', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify({ total: 1, objects: [{ package: { name: 'dsh-from-backup' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const names = await searchByKeywords(fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(names).toContain('dsh-from-backup')
  })

  it('never sends the npm token to the backup registry', async () => {
    // The token is an npmjs.org credential. Forwarding it to a third-party
    // mirror hands that mirror a Bearer token it was never issued; the fixture
    // recorded `registry.npmmirror.com auth=Bearer npm_...` going out.
    const seen: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(url), auth: headers.get('authorization') })
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate(
      'dsh-failover', fetchImpl, noSleep, 'npm_readonly_token', 'https://registry.npmmirror.com',
    )
    expect(result.ok).toBe(true)
    expect(seen[0]?.auth).toBe('Bearer npm_readonly_token') // the primary gets it
    expect(seen[1]?.url).toContain('registry.npmmirror.com')
    expect(seen[1]?.auth).toBe(null) // the backup does not
  })

  it('treats an empty backup registry as disabled rather than building /name', async () => {
    // The documented disable value is an empty string, but the guard tested
    // for `undefined`: registryUrl('', 'x') is '/x', and the first primary
    // failure died with `Failed to parse URL` instead of reporting the
    // primary's own failure.
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      throw new Error('primary down')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, '')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
    expect(urls).toEqual(['https://registry.npmjs.org/dsh-failover'])
  })

  it('treats a whitespace-only backup registry as disabled too', async () => {
    // Same guard, the other shape an operator might actually type: a stray
    // space left behind by NPM_BACKUP_REGISTRY='' under a shell that quotes
    // it loosely. `backupRegistry.trim() === ''` catches '   ' exactly like
    // the empty string above — neither builds a backup URL.
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      throw new Error('primary down')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, '   ')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
    expect(urls).toEqual(['https://registry.npmjs.org/dsh-failover'])
  })
})

describe('fetchCandidates', () => {
  const noSleep = async (_ms: number) => {}
  const packument = {
    name: 'good',
    'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': '2026-08-01T12:00:00.000Z' },
    versions: { '1.0.0': { dist: { integrity: 'sha512-x' }, license: 'MIT' } },
  }

  it('records a 500 as a fetch-failed row and still returns the other candidates', async () => {
    // H-2: no test ever called fetchCandidates, so mislabelling the code and
    // dropping the rejection entirely both survived the suite. Eight good
    // names plus one bad one cross HARVEST_CONCURRENCY's batch boundary: a
    // mutation that drops the batch's upper bound (`names.slice(i)` with no
    // end) fetches everything in one pass, then loops a second time over the
    // tail and double-processes 'bad' — invisible on a 2-name fixture, where
    // the single batch already covers the whole array either way.
    const goodNames = Array.from({ length: HARVEST_CONCURRENCY }, (_, i) => `good-${i}`)
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) return new Response('server error', { status: 500 })
      const name = decodeURIComponent(String(url).split('/').pop() ?? '')
      return new Response(JSON.stringify({ ...packument, name }), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates([...goodNames, 'bad'], fetchImpl, undefined, undefined, noSleep)
    expect(candidates.map(c => c.name).sort()).toEqual(goodNames)
    expect(rejections).toEqual([
      { name: 'bad', code: 'fetch-failed', detail: 'npm registry returned 500 fetching bad' },
    ])
  })

  it('records a network throw as a fetch-failed row naming the cause', async () => {
    // D-2: Promise.all over a throwing fetchCandidate rejected the whole
    // harvest of ~5,600 packuments on one ECONNRESET.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) throw new Error('read ECONNRESET')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(['good', 'bad'], fetchImpl, undefined, undefined, noSleep)
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.code).toBe('fetch-failed')
    expect(rejections[0]?.detail).toBe('bad: could not reach the npm registry (read ECONNRESET)')
  })

  it('records a stalled connection as a fetch-failed row naming the timeout', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) return new Promise<Response>(() => {})
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(['good', 'bad'], fetchImpl, undefined, undefined, noSleep, 50)
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.detail).toBe('bad: the npm registry did not answer within 50ms')
  })

  it('fetches through the backup registry when one is configured', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(
      ['good'], fetchImpl, undefined, 'https://registry.npmmirror.com', noSleep,
    )
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toEqual([])
    expect(urls[1]).toContain('registry.npmmirror.com')
  })
})
