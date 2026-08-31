import { describe, expect, it } from 'vitest'
import { fetchCandidate, HARVEST_KEYWORDS, searchByKeywords, toCandidate } from '../src/npm-client.ts'

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
})

describe('searchByKeywords', () => {
  it('pages every harvest keyword until the registry returns fewer objects than requested', async () => {
    const pages = [
      { objects: Array.from({ length: 250 }, (_, i) => ({ package: { name: `dsh-p${i}` } })) },
      { objects: [{ package: { name: 'dsh-last' } }] },
    ]
    const urls: string[] = []
    let call = 0
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      const body = pages[call] ?? { objects: [] }
      call += 1
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(251)
    expect(names).toContain('dsh-last') // the union is sorted, so it cannot anchor the tail
    expect(call).toBe(3) // two pages for the primary keyword, one empty for the second
    expect(urls.some(url => url.includes('keywords:dsh-plugin'))).toBe(true)
    expect(urls.some(url => url.includes('keywords:deepseek-harness'))).toBe(true)
  })

  it('unions the keywords, deduplicates, and sorts', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (text.includes('keywords:dsh-plugin')) {
        return new Response(JSON.stringify({ objects: [{ package: { name: 'b' } }, { package: { name: 'a' } }] }), { status: 200 })
      }
      if (text.includes('keywords:deepseek-harness')) {
        return new Response(JSON.stringify({ objects: [{ package: { name: 'b' } }, { package: { name: 'c' } }] }), { status: 200 })
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
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('keywords:deepseek-harness')) return new Response('nope', { status: 503 })
      return new Response(JSON.stringify({ objects: [{ package: { name: 'fine' } }] }), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(/keywords:deepseek-harness.*503/)
  })

  it('retries a rate-limited search and succeeds when the registry recovers', async () => {
    const sleep = async (_ms: number) => {}
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      if (call === 1) return new Response('rate limited', { status: 429 })
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const names = await searchByKeywords(fetchImpl, sleep)
    expect(names).toHaveLength(0)
    expect(call).toBe(3) // the 429, its retry, then the second keyword's clean page
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
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
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
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
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
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(delays).toEqual([60_000])
  })

  it('sends an Authorization header when a token is given', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep, 'npm_readonly_token')
    expect(headersSeen).toHaveLength(2) // one search per keyword
    expect(headersSeen.every(headers => headers?.Authorization === 'Bearer npm_readonly_token')).toBe(true)
  })

  it('sends no Authorization header without a token', async () => {
    const sleep = async (_ms: number) => {}
    const headersSeen: Array<Record<string, string> | undefined> = []
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      headersSeen.push(init?.headers as Record<string, string> | undefined)
      return new Response(JSON.stringify({ objects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await searchByKeywords(fetchImpl, sleep)
    expect(headersSeen).toHaveLength(2) // one search per keyword
    expect(headersSeen.every(headers => headers === undefined)).toBe(true)
  })

  it('throws instead of paging forever when every page comes back full', async () => {
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      const body = { objects: Array.from({ length: 250 }, (_, i) => ({ package: { name: `dsh-forever-${i}` } })) }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(/keywords:dsh-plugin.*100 pages/)
    expect(call).toBe(100) // the bound is per keyword; the primary one trips it
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

  it('reports the primary failure when the backup also fails', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    await expect(
      fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com'),
    ).rejects.toThrow('primary down')
  })

  it('propagates the throw when no backup registry is configured', async () => {
    const fetchImpl = (async () => { throw new Error('primary down') }) as unknown as typeof fetch
    await expect(fetchCandidate('dsh-failover', fetchImpl, noSleep)).rejects.toThrow('primary down')
  })

  it('searches through the failover too', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify({ objects: [{ package: { name: 'dsh-from-backup' } }] }), { status: 200 })
    }) as unknown as typeof fetch
    const names = await searchByKeywords(fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(names).toContain('dsh-from-backup')
  })
})
