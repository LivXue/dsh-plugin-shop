import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { loadCatalog, type CatalogFs } from '../../src/host/catalog.ts'

function dataJson(plugins: unknown[] = [], denied: unknown[] = []): string {
  return JSON.stringify({ schemaVersion: 2, plugins, denied })
}

function pointerFor(data: string, builtAt: string, stars?: { url: string; sha256: string }): { pointer: string; url: string; sha: string } {
  const sha = createHash('sha256').update(data).digest('hex')
  const url = `plugins.${sha}.json`
  return {
    pointer: JSON.stringify({
      schemaVersion: 2, builtAt, count: 0,
      plugins: { url, sha256: sha },
      ...(stars === undefined ? {} : { stars }),
    }),
    url,
    sha,
  }
}

/** A publishable stars sidecar: content-addressed bytes whose sha the pointer
 * must name, mirroring the plugins file's binding. */
function starsFile(stars: Record<string, number>): { url: string; sha256: string; text: string } {
  const text = JSON.stringify({ stars })
  const sha256 = createHash('sha256').update(text).digest('hex')
  return { url: `stars.${sha256}.json`, sha256, text }
}

function memFs(): CatalogFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    exists: p => files.has(p),
    read: p => files.get(p) ?? '',
    write: (p, data) => { files.set(p, data) },
  }
}

describe('loadCatalog', () => {
  const entry = {
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
    added: '2026-08-25',
  }

  it('fetches the pointer, verifies the data hash, and returns the entries', async () => {
    const data = dataJson([entry])
    const { pointer, url, sha } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.stale).toBe(false)
    expect(result.snapshot.entries).toHaveLength(1)
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
  })

  it('serves the cache with stale: true and the snapshot builtAt when the network fails', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    const fetchImpl = (async () => { throw new Error('offline') }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs, now: () => new Date('2026-08-25T10:00:00Z') })
    expect(result.stale).toBe(true)
    // builtAt is the consumer's only freshness signal: pin the value, not just
    // the stale flag, so a fallback that drops it cannot pass silently.
    expect(result.snapshot.builtAt).toBe('2026-08-25T00:00:00Z')
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
  })

  it('serves the cache with stale: true and the snapshot builtAt when only the data fetch fails', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    // The pointer fetch succeeds; the data fetch is the transport failure. The
    // second fallback site (catalog.ts data-fetch catch) must carry the same
    // stale signal as the pointer-fetch one.
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith('/index.json')) return new Response(pointer, { status: 200 })
      throw new Error('data offline')
    }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs, now: () => new Date('2026-08-25T10:00:00Z') })
    expect(result.stale).toBe(true)
    expect(result.snapshot.builtAt).toBe('2026-08-25T00:00:00Z')
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
  })

  it('throws when the data file does not match the pointer hash', async () => {
    const data = dataJson([entry])
    const tampered = data.replace('dsh-hello-plugin', 'dsh-evil-plugin')
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : tampered, { status: 200 },
    )) as unknown as typeof fetch

    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/integrity/)
  })

  it('throws on an integrity mismatch even when a cache exists', async () => {
    const data = dataJson([entry])
    const tampered = data.replace('dsh-hello-plugin', 'dsh-evil-plugin')
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : tampered, { status: 200 },
    )) as unknown as typeof fetch

    await expect(loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs,
      now: () => new Date('2026-08-25T10:00:00Z'),
    })).rejects.toThrow(/integrity/)
  })

  it('throws when the schemaVersion is newer than this build supports', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ schemaVersion: 6, builtAt: '', count: 0, plugins: { url: 'x.json', sha256: '0'.repeat(64) } }),
      { status: 200 },
    )) as unknown as typeof fetch

    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/newer/)
  })

  it('throws on a newer schemaVersion even when a cache exists', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    const fetchImpl = (async () => new Response(
      JSON.stringify({ schemaVersion: 6, builtAt: '', count: 0, plugins: { url: 'x.json', sha256: '0'.repeat(64) } }),
      { status: 200 },
    )) as unknown as typeof fetch

    await expect(loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs,
      now: () => new Date('2026-08-25T10:00:00Z'),
    })).rejects.toThrow(/newer/)
  })

  it('throws when offline with no cache at all', async () => {
    const fetchImpl = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/offline/)
  })

  it('serves a fresh cache without touching the network', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    let calls = 0
    const fetchImpl = (async () => { calls += 1; throw new Error('should not be called') }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs, now: () => new Date('2026-08-25T00:03:00Z') })
    expect(result.stale).toBe(false)
    expect(calls).toBe(0)
  })

  it('serves a fresh cache via the sidecar without touching the network', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    fs.write('/cache/index.meta.json', JSON.stringify({ fetchedAt: '2026-08-25T00:00:00Z' }))
    let calls = 0
    const fetchImpl = (async () => { calls += 1; throw new Error('should not be called') }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs, now: () => new Date('2026-08-25T00:03:00Z') })
    expect(result.stale).toBe(false)
    expect(calls).toBe(0)
  })

  it('refetches the pointer when the sidecar says the cache is stale', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    fs.write('/cache/index.meta.json', JSON.stringify({ fetchedAt: '2026-08-25T00:00:00Z' }))
    let pointerCalls = 0
    let dataCalls = 0
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith('/index.json')) pointerCalls += 1
      else dataCalls += 1
      return new Response(String(input).endsWith('/index.json') ? pointer : data, { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs, now: () => new Date('2026-08-25T10:00:00Z') })
    expect(result.stale).toBe(false)
    expect(pointerCalls).toBe(1)
    expect(dataCalls).toBe(1)
  })

  it('passes the denied list through', async () => {
    const data = dataJson([entry], [{ name: 'dsh-blocked', detail: 'matched the denylist' }])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.denied).toEqual([{ name: 'dsh-blocked', detail: 'matched the denylist' }])
  })

  it('treats a tampered cached data file as absent when the network is down', async () => {
    const data = dataJson([entry])
    const tampered = data.replace('dsh-hello-plugin', 'dsh-evil-plugin')
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, tampered)
    fs.write('/cache/index.meta.json', JSON.stringify({ fetchedAt: '2026-08-25T00:00:00Z' }))
    const fetchImpl = (async () => { throw new Error('offline') }) as unknown as typeof fetch

    await expect(loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs,
      now: () => new Date('2026-08-25T00:03:00Z'),
    })).rejects.toThrow(/offline/)
  })

  it('ignores a tampered cached data file and serves the fresh fetch', async () => {
    const data = dataJson([entry])
    const tampered = data.replace('dsh-hello-plugin', 'dsh-evil-plugin')
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, tampered)
    fs.write('/cache/index.meta.json', JSON.stringify({ fetchedAt: '2026-08-25T00:00:00Z' }))
    let pointerCalls = 0
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith('/index.json')) pointerCalls += 1
      return new Response(String(input).endsWith('/index.json') ? pointer : data, { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs,
      now: () => new Date('2026-08-25T00:03:00Z'),
    })
    expect(result.stale).toBe(false)
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
    expect(pointerCalls).toBe(1)
  })

  it('refuses an absolute data url before fetching it', async () => {
    const data = dataJson([entry])
    const sha = createHash('sha256').update(data).digest('hex')
    const pointer = JSON.stringify({
      schemaVersion: 2, builtAt: '2026-08-25T00:00:00Z', count: 0,
      plugins: { url: 'http://169.254.169.254/latest', sha256: sha },
    })
    let dataCalls = 0
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith('/index.json')) return new Response(pointer, { status: 200 })
      dataCalls += 1
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch

    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/must be relative/)
    expect(dataCalls).toBe(0)
  })

  it('refuses a data url whose leading whitespace hides an absolute fetch', async () => {
    // WHATWG URL normalization strips the leading space before the raw string
    // could be inspected; the origin comparison must catch it.
    const data = dataJson([entry])
    const sha = createHash('sha256').update(data).digest('hex')
    const pointer = JSON.stringify({
      schemaVersion: 2, builtAt: '2026-08-25T00:00:00Z', count: 0,
      plugins: { url: ' http://169.254.169.254/latest', sha256: sha },
    })
    const fetched: string[] = []
    const fetchImpl = (async (input: string | URL) => {
      fetched.push(String(input))
      return new Response(String(input).endsWith('/index.json') ? pointer : data, { status: 200 })
    }) as unknown as typeof fetch

    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/must be relative/)
    expect(fetched.filter(h => h.includes('169.254.169.254'))).toHaveLength(0)
  })

  it('resolves a relative data url against the catalog base', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    let dataUrl = ''
    const fetchImpl = (async (input: string | URL) => {
      const text = String(input)
      if (text.endsWith('/index.json')) return new Response(pointer, { status: 200 })
      dataUrl = text
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(dataUrl).toBe(`https://shop.test/v1/${url}`)
    expect(result.stale).toBe(false)
  })

  it('loads the stars sidecar when the pointer names one', async () => {
    const data = dataJson([entry])
    const stars = starsFile({ 'dsh-hello-plugin': 42 })
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', stars)
    const fetchImpl = (async (input: string | URL) => {
      const text = String(input)
      if (text.endsWith('/index.json')) return new Response(pointer, { status: 200 })
      if (text.endsWith(stars.url)) return new Response(stars.text, { status: 200 })
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.stars).toEqual({ 'dsh-hello-plugin': 42 })
    expect(result.stale).toBe(false)
  })

  it('degrades to an empty stars map when the sidecar fetch fails', async () => {
    const data = dataJson([entry])
    const stars = starsFile({ 'dsh-hello-plugin': 42 })
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', stars)
    const fetchImpl = (async (input: string | URL) => {
      const text = String(input)
      if (text.endsWith('/index.json')) return new Response(pointer, { status: 200 })
      if (text.endsWith(stars.url)) return new Response('not found', { status: 404 })
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.stars).toEqual({})
    expect(result.stale).toBe(false)
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
  })

  it('degrades to an empty stars map when the stars url is absolute', async () => {
    // Unlike the plugins data url — which is refused loudly — the stars
    // sidecar is advisory: a cross-origin stars url must never throw the
    // loader, and must never reach the network (spec §5, §9.2).
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', {
      url: 'http://169.254.169.254/latest', sha256: '0'.repeat(64),
    })
    const fetched: string[] = []
    const fetchImpl = (async (input: string | URL) => {
      const text = String(input)
      fetched.push(text)
      if (text.endsWith('/index.json')) return new Response(pointer, { status: 200 })
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.stars).toEqual({})
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
    expect(result.stale).toBe(false)
    expect(fetched.filter(h => h.includes('169.254.169.254'))).toHaveLength(0)
  })

  it('degrades to an empty stars map on a sha256 mismatch', async () => {
    const data = dataJson([entry])
    const stars = starsFile({ 'dsh-hello-plugin': 42 })
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', stars)
    // Serve bytes that do not bind to the pointer's stars sha.
    const tampered = JSON.stringify({ stars: { 'dsh-hello-plugin': 999 } })
    const fetchImpl = (async (input: string | URL) => {
      const text = String(input)
      if (text.endsWith('/index.json')) return new Response(pointer, { status: 200 })
      if (text.endsWith(stars.url)) return new Response(tampered, { status: 200 })
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.stars).toEqual({})
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
    expect(result.stale).toBe(false)
  })

  it('ignores unknown pointer keys so old hosts keep working', async () => {
    const data = dataJson([entry])
    const sha = createHash('sha256').update(data).digest('hex')
    // A future index may carry keys this build does not know; the non-strict
    // pointer schema must strip them, not refuse the catalog.
    const pointer = JSON.stringify({
      schemaVersion: 2, builtAt: '2026-08-25T00:00:00Z', count: 0,
      plugins: { url: `plugins.${sha}.json`, sha256: sha },
      futureField: true,
    })
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.stale).toBe(false)
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
  })

  it('serves cached stars without touching the network', async () => {
    const data = dataJson([entry])
    const stars = starsFile({ 'dsh-hello-plugin': 42 })
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z', stars)
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    fs.write(`/cache/${stars.url}`, stars.text)
    fs.write('/cache/index.meta.json', JSON.stringify({ fetchedAt: '2026-08-25T00:00:00Z' }))
    let calls = 0
    const fetchImpl = (async () => { calls += 1; throw new Error('should not be called') }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs, now: () => new Date('2026-08-25T00:03:00Z') })
    expect(result.stale).toBe(false)
    expect(result.snapshot.stars).toEqual({ 'dsh-hello-plugin': 42 })
    expect(calls).toBe(0)
  })

  it('degrades cached stars on a sha mismatch without invalidating the catalog cache', async () => {
    const data = dataJson([entry])
    const stars = starsFile({ 'dsh-hello-plugin': 42 })
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z', stars)
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    fs.write(`/cache/${stars.url}`, JSON.stringify({ stars: { 'dsh-hello-plugin': 999 } }))
    fs.write('/cache/index.meta.json', JSON.stringify({ fetchedAt: '2026-08-25T00:00:00Z' }))
    let calls = 0
    const fetchImpl = (async () => { calls += 1; throw new Error('should not be called') }) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs, now: () => new Date('2026-08-25T00:03:00Z') })
    expect(result.stale).toBe(false)
    expect(result.snapshot.stars).toEqual({})
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
    expect(calls).toBe(0)
  })
})

describe('v4 subdir entries', () => {
  const subEntry = {
    name: 'sub-plugin', version: 'd'.repeat(40), integrity: 'd'.repeat(40), publishedAt: null,
    repository: 'https://github.com/someone/monorepo', license: 'MIT',
    tier: 'community', metadata: 'declared', source: 'github', repo: 'someone/monorepo',
    subdir: 'packages/sub-plugin',
    catalog: { category: 'tool', summary: { en: 'A subpackage plugin.', zh: '一个子包插件。' }, capabilities: [] },
    added: '2026-08-01',
  }

  it('parses a v4 entry and keeps its subdir', async () => {
    const data = JSON.stringify({ schemaVersion: 4, plugins: [subEntry], denied: [] })
    const { pointer, url } = pointerFor(data, '2026-08-31T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    const catalog = await loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache',
      fetchImpl: (async () => { throw new Error('must be served from cache') }) as unknown as typeof fetch,
      fsImpl: fs, now: () => new Date('2026-08-31T00:01:00Z'),
    })
    expect(catalog.snapshot.entries[0]?.subdir).toBe('packages/sub-plugin')
  })

  it('refuses a subdir that is not relative directory segments', async () => {
    const data = JSON.stringify({ schemaVersion: 4, plugins: [{ ...subEntry, subdir: '../escape' }], denied: [] })
    const { pointer, url } = pointerFor(data, '2026-08-31T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    await expect(loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache',
      fetchImpl: (async () => { throw new Error('unreachable') }) as unknown as typeof fetch,
      fsImpl: fs, now: () => new Date('2026-08-31T00:01:00Z'),
    })).rejects.toThrow()
  })
})

describe('v5 (market borrowings) entries', () => {
  const v5Entry = {
    name: 'dsh-v5-plugin', version: '1.3.0', integrity: 'sha512-x', publishedAt: null,
    repository: 'https://github.com/you/v5-plugin', license: 'MIT',
    tier: 'verified', metadata: 'declared', source: 'npm',
    added: '2026-08-01',
    catalog: { category: 'theme', summary: { en: 'A theme.', zh: '一个主题。' }, capabilities: [] },
  }
  const rescued = {
    name: 'dsh-rescued', version: 'v1.0.0', integrity: 'a'.repeat(64), publishedAt: null,
    repository: 'https://github.com/owner/slug', license: 'MIT',
    tier: 'community', metadata: 'declared', source: 'github', repo: 'owner/slug',
    added: '2026-08-01',
    tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
  }

  function catalogFromCache(data: string, fs: ReturnType<typeof memFs>): Promise<import('../../src/host/catalog.ts').CatalogResult> {
    const { pointer, url } = pointerFor(data, '2026-08-31T00:00:00Z')
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    return loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache',
      fetchImpl: (async () => { throw new Error('must be served from cache') }) as unknown as typeof fetch,
      fsImpl: fs, now: () => new Date('2026-08-31T00:01:00Z'),
    })
  }

  it('parses a v5 catalog with added, a theme entry, and a denied replacement', async () => {
    const data = JSON.stringify({
      schemaVersion: 5,
      plugins: [v5Entry, rescued],
      denied: [{ name: 'dsh-blocked', detail: 'matched the denylist', replacement: 'dsh-good' }],
    })
    const catalog = await catalogFromCache(data, memFs())
    expect(catalog.snapshot.entries[0]?.added).toBe('2026-08-01')
    expect(catalog.snapshot.entries[0]?.catalog?.category).toBe('theme')
    expect(catalog.snapshot.entries[1]?.tarball).toEqual({
      url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz',
      sha256: 'a'.repeat(64),
    })
    expect(catalog.snapshot.denied).toEqual([
      { name: 'dsh-blocked', detail: 'matched the denylist', replacement: 'dsh-good' },
    ])
  })

  it('matches the tarball owner against the repo case-insensitively', async () => {
    const upper = {
      ...rescued,
      tarball: { url: 'https://github.com/Owner/Slug/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
    }
    const data = JSON.stringify({ schemaVersion: 5, plugins: [upper], denied: [] })
    const catalog = await catalogFromCache(data, memFs())
    expect(catalog.snapshot.entries[0]?.tarball?.url).toContain('/Owner/Slug/')
  })

  it('refuses a tarball url that is not the entry\'s own repo release, from the wire', async () => {
    const evil = {
      ...rescued,
      tarball: { url: 'https://github.com/other/repo/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
    }
    const data = JSON.stringify({ schemaVersion: 5, plugins: [evil], denied: [] })
    const { pointer } = pointerFor(data, '2026-08-31T00:00:00Z')
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch
    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/not a release of owner\/slug/)
  })

  it('refuses a tarball url bound to another repo, from the cache, without touching the wire', async () => {
    const evil = {
      ...rescued,
      tarball: { url: 'https://github.com/other/repo/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
    }
    const data = JSON.stringify({ schemaVersion: 5, plugins: [evil], denied: [] })
    const fs = memFs()
    const { pointer, url } = pointerFor(data, '2026-08-31T00:00:00Z')
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return new Response(pointer, { status: 200 }) }) as unknown as typeof fetch
    await expect(loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs,
      now: () => new Date('2026-08-31T00:01:00Z'),
    })).rejects.toThrow(/not a release of owner\/slug/)
    expect(calls).toBe(0)
  })

  it('refuses a tarball url on a non-github entry', async () => {
    const npmTarball = {
      ...v5Entry,
      tarball: { url: 'https://github.com/you/v5-plugin/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
    }
    const data = JSON.stringify({ schemaVersion: 5, plugins: [npmTarball], denied: [] })
    const { pointer } = pointerFor(data, '2026-08-31T00:00:00Z')
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch
    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/tarball requires a github entry with a repo/)
  })

  it('refuses a non-https tarball url', async () => {
    const httpTarball = {
      ...rescued,
      tarball: { url: 'http://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
    }
    const data = JSON.stringify({ schemaVersion: 5, plugins: [httpTarball], denied: [] })
    const { pointer } = pointerFor(data, '2026-08-31T00:00:00Z')
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch
    await expect(loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() }))
      .rejects.toThrow(/must be https on github\.com/)
  })
})
