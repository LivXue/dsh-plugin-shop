import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { DEFAULT_CATALOG_URL, catalogOrigins, loadCatalog, type CatalogFs } from '../../src/host/catalog.ts'
import { TransportError, type CatalogOrigin, type OriginHandle } from '../../src/host/origin.ts'
import { npmOrigin } from '../../src/host/npm-origin.ts'
import { npmrcRegistry } from '../../src/host/npmrc.ts'

function dataJson(plugins: unknown[] = [], denied: unknown[] = [], schemaVersion = 2): string {
  return JSON.stringify({ schemaVersion, plugins, denied })
}

function pointerFor(data: string, builtAt: string, stars?: { url: string; sha256: string }, schemaVersion = 2): { pointer: string; url: string; sha: string } {
  const sha = createHash('sha256').update(data).digest('hex')
  const url = `plugins.${sha}.json`
  return {
    pointer: JSON.stringify({
      schemaVersion, builtAt, count: 0,
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

  it('parses a v4 catalog whose entries carry no added field (the live pre-v5 shape)', async () => {
    // 0.5.0 shipped with `added` REQUIRED in the consumer schema, which
    // refused the still-live v4 catalog (no `added` on any entry) and the
    // shop showed its generic error state. The field is optional on the
    // consumer: our own builds always carry it (E9), foreign/cached v4 data
    // does not, and the client never renders it.
    const v4entry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
    }
    const data = dataJson([v4entry], [], 4)
    const { pointer, url, sha } = pointerFor(data, '2026-08-25T00:00:00Z', undefined, 4)
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.stale).toBe(false)
    expect(result.snapshot.entries).toHaveLength(1)
    expect(result.snapshot.entries[0]?.added).toBeUndefined()
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
      JSON.stringify({ schemaVersion: 7, builtAt: '', count: 0, plugins: { url: 'x.json', sha256: '0'.repeat(64) } }),
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
      JSON.stringify({ schemaVersion: 7, builtAt: '', count: 0, plugins: { url: 'x.json', sha256: '0'.repeat(64) } }),
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

describe('peers (schemaVersion 6)', () => {
  // The file has no shared cross-describe fixture (each block above defines
  // its own minimal entry — `entry`, `subEntry`, `v5Entry`); this one follows
  // that same pattern rather than inventing a helper.
  const baseEntry = {
    name: 'dsh-timeline', version: '0.1.4', integrity: 'sha512-x', publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
  }

  it('parses a v6 entry carrying peers', async () => {
    // Names copied from dsh-timeline@0.1.4's real manifest.
    const data = dataJson(
      [{ ...baseEntry, peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react'] }],
      [], 6,
    )
    const { pointer } = pointerFor(data, '2026-09-01T00:00:00Z', undefined, 6)
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.entries[0]?.peers).toEqual([
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react',
    ])
  })

  it('parses the live v5 shape, which has no peers field at all', async () => {
    // The 0.5.0 regression, in the shape that caused it: a required new field
    // made the client refuse the still-published older catalog outright.
    const data = dataJson([baseEntry], [], 5)
    const { pointer } = pointerFor(data, '2026-09-01T00:00:00Z', undefined, 5)
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch

    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.entries[0]?.peers).toBeUndefined()
    expect(result.snapshot.entries).toHaveLength(1)
  })
})

describe('origin racing', () => {
  const entry = {
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
    added: '2026-08-25',
  }

  /** An origin that resolves its probe after `delay` microtask turns. */
  function fakeOrigin(id: string, opts: {
    delay?: number
    probeFails?: 'transport' | 'loud'
    /** Fails when the loader asks for the pointer — still inside the race,
     * so the loader may still fall through to another origin. */
    pointerFails?: 'transport' | 'loud'
    /** Never settles — simulates a stalled bulk transfer (npmOrigin
     * downloading its tarball on `pointer()`) so the commit-transfer timeout
     * can be exercised without a real 30-second stall. */
    pointerHangs?: boolean
    /** Fails on the bulk fetch, after the winner is committed to. */
    dataFails?: 'transport' | 'loud'
    /** Never settles on the data file. */
    dataHangs?: boolean
    /** Never settles on the stars sidecar. */
    starsHangs?: boolean
    data?: string
    pointer?: string
  }): CatalogOrigin {
    return {
      id,
      async probe() {
        for (let i = 0; i < (opts.delay ?? 0); i += 1) await Promise.resolve()
        if (opts.probeFails === 'transport') throw new TransportError(`${id} down`)
        if (opts.probeFails === 'loud') throw new Error(`${id} corrupt`)
        return {
          id,
          pointer: async () => {
            if (opts.pointerHangs === true) return new Promise<string>(() => {})
            if (opts.pointerFails === 'transport') throw new TransportError(`${id} pointer down`)
            if (opts.pointerFails === 'loud') throw new Error(`${id} pointer corrupt`)
            return opts.pointer ?? ''
          },
          file: async (url) => {
            if (opts.dataHangs === true && url.startsWith('plugins.')) return new Promise<string>(() => {})
            if (opts.starsHangs === true && url.startsWith('stars.')) return new Promise<string>(() => {})
            if (opts.dataFails === 'transport') throw new TransportError(`${id} data down`)
            if (opts.dataFails === 'loud') throw new Error(`${id} data corrupt`)
            return opts.data ?? ''
          },
        }
      },
    }
  }

  it('takes the first origin to answer, not the first listed', async () => {
    const slowData = dataJson([entry])
    const fastData = dataJson([entry, { ...entry, name: 'dsh-second-plugin' }])
    const slow = pointerFor(slowData, '2026-08-25T00:00:00Z')
    const fast = pointerFor(fastData, '2026-08-25T00:00:00Z')
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('slow', { delay: 8, pointer: slow.pointer, data: slowData }),
        fakeOrigin('fast', { delay: 0, pointer: fast.pointer, data: fastData }),
      ],
    })
    // Two entries can only have come from `fast`, which is listed SECOND.
    expect(result.snapshot.entries).toHaveLength(2)
  })

  it('falls through to the next origin when the winner is a transport failure', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('broken', { delay: 0, probeFails: 'transport' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })
    expect(result.snapshot.entries).toHaveLength(1)
    expect(result.stale).toBe(false)
  })

  it('falls through when the winner answers its probe but cannot serve the pointer', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('half-up', { delay: 0, pointerFails: 'transport' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })
    expect(result.snapshot.entries).toHaveLength(1)
  })

  it('falls through to a healthy origin when the committed winner stalls past the commit budget', async () => {
    vi.useFakeTimers()
    try {
      const data = dataJson([entry])
      const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
      const pending = loadCatalog({
        cacheDir: '/cache', fsImpl: memFs(),
        origins: [
          fakeOrigin('hangs', { delay: 0, pointerHangs: true }),
          fakeOrigin('working', { delay: 4, pointer, data }),
        ],
      })
      // `hangs`' pointer() never settles on its own; only the commit-transfer
      // budget moves the race past it and on to `working`.
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await pending
      expect(result.snapshot.entries).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to the cache — not to another origin — when the committed winner fails its bulk fetch', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.files.set('/cache/index.json', pointer)
    fs.files.set(`/cache/${url}`, data)
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
      origins: [
        fakeOrigin('half-up', { delay: 0, pointer, dataFails: 'transport' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })
    expect(result.stale).toBe(true)
  })

  it('does NOT fall through on a loud failure — a corrupt origin is reported, not papered over', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    // Seed a cache a broken guard could serve instead of throwing: the point
    // of this test is that correct code throws even though a stale answer is
    // sitting right there, not merely that it throws when nothing else exists.
    const fs = memFs()
    fs.files.set('/cache/index.json', pointer)
    fs.files.set(`/cache/${url}`, data)
    await expect(loadCatalog({
      cacheDir: '/cache', fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
      origins: [
        fakeOrigin('corrupt', { delay: 0, pointer, dataFails: 'loud' }),
        fakeOrigin('working', { delay: 4, pointer, data }),
      ],
    })).rejects.toThrow(/data corrupt/)
  })

  it('reports a loud probe failure rather than masking it with a healthy origin', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    await expect(loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('corrupt', { delay: 0, probeFails: 'loud' }),
        fakeOrigin('healthy', { delay: 4, pointer, data }),
      ],
    })).rejects.toThrow(/corrupt corrupt/)
  })

  it('reports a loud pointer failure rather than masking it with a healthy origin', async () => {
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    await expect(loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('corrupt', { delay: 0, pointerFails: 'loud' }),
        fakeOrigin('healthy', { delay: 4, pointer, data }),
      ],
    })).rejects.toThrow(/pointer corrupt/)
  })

  it('throws when every origin is a transport failure and there is no cache', async () => {
    await expect(loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        fakeOrigin('a', { probeFails: 'transport' }),
        fakeOrigin('b', { probeFails: 'transport' }),
      ],
    })).rejects.toThrow()
  })

  it('serves the stale cache when every origin is a transport failure', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.files.set('/cache/index.json', pointer)
    fs.files.set(`/cache/${url}`, data)
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
      origins: [fakeOrigin('a', { probeFails: 'transport' })],
    })
    expect(result.stale).toBe(true)
    expect(result.snapshot.entries).toHaveLength(1)
  })

  it('throws rather than silently serving a stale cache when origins is empty', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.files.set('/cache/index.json', pointer)
    fs.files.set(`/cache/${url}`, data)
    await expect(loadCatalog({
      cacheDir: '/cache', fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
      origins: [],
    })).rejects.toThrow('loadCatalog: no origins')
  })
  describe('the commit budget covers the bulk reads (G-2)', () => {
    it('degrades to the cache when the committed origin answers the pointer and never the data file', async () => {
      vi.useFakeTimers()
      try {
        const data = dataJson([entry])
        const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
        const fs = memFs()
        fs.files.set('/cache/index.json', pointer)
        fs.files.set(`/cache/${url}`, data)
        const pending = loadCatalog({
          cacheDir: '/cache', fsImpl: fs,
          now: () => new Date('2026-09-01T00:00:00Z'),
          origins: [fakeOrigin('stalls-on-data', { delay: 0, pointer, dataHangs: true })],
        })
        await vi.advanceTimersByTimeAsync(30_000)
        const result = await pending
        expect(result.stale).toBe(true)
        expect(result.snapshot.entries).toHaveLength(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('throws, naming the budget, when the data file stalls and there is no cache', async () => {
      vi.useFakeTimers()
      try {
        const data = dataJson([entry])
        const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
        const pending = loadCatalog({
          cacheDir: '/cache', fsImpl: memFs(),
          origins: [fakeOrigin('stalls-on-data', { delay: 0, pointer, dataHangs: true })],
        })
        const settled = pending.catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(30_000)
        const failure = await settled
        expect(String(failure)).toMatch(new RegExp(`did not serve ${url.replace(/\./g, '\\.')} within 30000 ms`))
      } finally {
        vi.useRealTimers()
      }
    })

    it('completes with no stars when the sidecar stalls', async () => {
      vi.useFakeTimers()
      try {
        const data = dataJson([entry])
        const stars = starsFile({ 'dsh-hello-plugin': 7 })
        const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', { url: stars.url, sha256: stars.sha256 })
        const pending = loadCatalog({
          cacheDir: '/cache', fsImpl: memFs(),
          origins: [fakeOrigin('stalls-on-stars', { delay: 0, pointer, data, starsHangs: true })],
        })
        await vi.advanceTimersByTimeAsync(30_000)
        const result = await pending
        expect(result.snapshot.entries).toHaveLength(1)
        expect(result.snapshot.stars).toEqual({})
      } finally {
        vi.useRealTimers()
      }
    })

    it('aborts the data fetch itself, not merely the wait', async () => {
      vi.useFakeTimers()
      try {
        const data = dataJson([entry])
        const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
        let aborted = false
        const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
          if (String(input).endsWith('/index.json')) return new Response(pointer, { status: 200 })
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              aborted = true
              reject(new Error('aborted'))
            })
          })
        }) as unknown as typeof fetch
        const settled = loadCatalog({
          baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs(),
        }).catch((error: unknown) => error)
        await vi.advanceTimersByTimeAsync(30_000)
        await settled
        expect(aborted).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('a broken npm origin does not mask a healthy one', () => {
  // Two distinct TransportError sources, both exercised through the real
  // npmOrigin (never fakeOrigin — a hand stub that already claims to throw
  // TransportError proves nothing about npm-origin.ts's own throw sites):
  // a probe()-level unparsable manifest, and a pointer()-level cross-host
  // tarball guard (item 1, 2026-09 review). Both must fall through to a
  // healthy second origin rather than fail the whole load.

  /** A single ustar file entry. Our own tar.ts reader ignores the checksum
   * field entirely, so it is left blank rather than computed. */
  function tarEntry(path: string, content: Buffer): Buffer {
    const header = Buffer.alloc(512)
    header.write(path, 0, 'ascii')
    header.write('0000644\0', 100, 'ascii')
    header.write('0000000\0', 108, 'ascii')
    header.write('0000000\0', 116, 'ascii')
    header.write(`${content.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
    header.write('00000000000\0', 136, 'ascii')
    header[156] = '0'.charCodeAt(0) // typeflag: regular file
    const pad = Buffer.alloc((512 - (content.length % 512)) % 512)
    return Buffer.concat([header, content, pad])
  }

  /** A minimal, self-consistent gzipped tarball: real ustar bytes readTar
   * can parse, holding exactly the pointer + data pair the caller gives it —
   * so the pointer's plugins.sha256 always matches the packaged data,
   * unlike a fixture built for a narrower purpose. */
  function buildCatalogTarball(pointer: string, dataUrl: string, data: string): Buffer {
    const entries = Buffer.concat([
      tarEntry('package/v1/index.json', Buffer.from(pointer, 'utf8')),
      tarEntry(`package/v1/${dataUrl}`, Buffer.from(data, 'utf8')),
      Buffer.alloc(1024), // two zero blocks: end of archive
    ])
    return gzipSync(entries)
  }

  /** Wraps an origin so the test can see the order the race loop actually
   * settled and consumed them in.
   *
   * Both fall-through tests below only test anything if the broken origin
   * leads, and neither of them controls that: the ordering comes from the
   * argument order `loadCatalog` starts the probes in, reinforced by a
   * microtask head start in the healthy fake. Measured — deleting that head
   * start does not flip it; adding a longer one to the broken fake does.
   * Either way it is incidental to the code under test, so it is asserted
   * rather than assumed. Without these assertions a flip lets the healthy
   * origin win the race outright and BOTH tests still pass on entry count
   * and staleness, proving nothing about the fall-through they exist for
   * (item F, 2026-09 review; verified by flipping the order and watching
   * only these assertions fail). */
  function recording(label: string, origin: CatalogOrigin, log: string[]): CatalogOrigin {
    return {
      id: origin.id,
      probe: async (signal) => {
        let handle: OriginHandle
        try {
          handle = await origin.probe(signal)
        } catch (error) {
          log.push(`${label}:probe-failed`)
          throw error
        }
        log.push(`${label}:probe-ok`)
        return {
          id: handle.id,
          pointer: async () => { log.push(`${label}:pointer`); return handle.pointer() },
          file: async (url) => handle.file(url),
        }
      },
    }
  }

  it('serves the healthy origin\'s catalog even though a broken mirror answers 200 with junk, first', async () => {
    const entry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
      added: '2026-08-25',
    }
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const tarball = buildCatalogTarball(pointer, url, data)
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`

    const brokenRegistry = (async (input: string | URL) => {
      const reqUrl = String(input)
      if (reqUrl.endsWith('/latest')) return new Response(JSON.stringify({ error: 'not found' }), { status: 200 })
      throw new Error('should not reach the tarball fetch — the manifest never resolved')
    }) as unknown as typeof fetch

    const healthyRegistry = (async (input: string | URL) => {
      // A few microtask turns, reinforcing the lead the broken mirror
      // already has from argument order, so it is guaranteed to settle —
      // and be processed by the race loop — first. That ordering is exactly
      // what this test exists to rule out as a way to fail the whole load,
      // and `recording` above asserts it actually held.
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
      const reqUrl = String(input)
      if (reqUrl.endsWith('/latest')) {
        return new Response(JSON.stringify({
          name: 'dsh-plugin-shop-catalog', version: '2026.901.0',
          dist: { tarball: 'https://healthy.test/x.tgz', integrity },
        }), { status: 200 })
      }
      return new Response(new Uint8Array(tarball), { status: 200 })
    }) as unknown as typeof fetch

    const log: string[] = []
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        recording('broken', npmOrigin('https://broken.test/', 'dsh-plugin-shop-catalog', brokenRegistry), log),
        recording('healthy', npmOrigin('https://healthy.test/', 'dsh-plugin-shop-catalog', healthyRegistry), log),
      ],
    })
    // Asserted, not assumed: the broken origin's probe must have settled —
    // and been consumed by the race loop — before the healthy one served
    // anything. `recording` above says why this cannot be left implicit.
    expect(log).toEqual(['broken:probe-failed', 'healthy:probe-ok', 'healthy:pointer'])
    // Only the healthy origin can produce a validated snapshot at all — the
    // broken one fails inside probe() before it ever returns a handle.
    expect(result.snapshot.entries).toHaveLength(1)
    expect(result.stale).toBe(false)
  })

  it('serves the healthy origin\'s catalog even though a broken mirror\'s tarball names a foreign host, first', async () => {
    // registry.npm.taobao.org is still named in countless ~/.npmrc files; it
    // redirects to registry.npmmirror.com and hands back a manifest whose
    // dist.tarball points at npmmirror's own host — an origin that can win
    // this race on measured speed (design §2) and must not then kill the
    // load (item 1, 2026-09 review).
    const entry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
      added: '2026-08-25',
    }
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const tarball = buildCatalogTarball(pointer, url, data)
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`

    const redirectingRegistry = (async (input: string | URL) => {
      const reqUrl = String(input)
      if (reqUrl.endsWith('/latest')) {
        return new Response(JSON.stringify({
          name: 'dsh-plugin-shop-catalog', version: '2026.901.0',
          // A foreign host relative to this origin's OWN registryUrl below —
          // exactly what the taobao-to-npmmirror redirect produces.
          dist: { tarball: 'https://registry.npmmirror.com/dsh-plugin-shop-catalog/-/x.tgz', integrity },
        }), { status: 200 })
      }
      throw new Error('should not reach the tarball fetch — the host guard must refuse first')
    }) as unknown as typeof fetch

    const healthyRegistry = (async (input: string | URL) => {
      // A few microtask turns, reinforcing the lead the redirecting origin
      // already has from argument order, so it is guaranteed to settle its
      // probe — and be processed by the race loop — first. That ordering is
      // exactly what this test exists to rule out as a way to fail the
      // whole load, and `recording` above asserts it actually held.
      for (let i = 0; i < 4; i += 1) await Promise.resolve()
      const reqUrl = String(input)
      if (reqUrl.endsWith('/latest')) {
        return new Response(JSON.stringify({
          name: 'dsh-plugin-shop-catalog', version: '2026.901.0',
          dist: { tarball: 'https://healthy.test/x.tgz', integrity },
        }), { status: 200 })
      }
      return new Response(new Uint8Array(tarball), { status: 200 })
    }) as unknown as typeof fetch

    const log: string[] = []
    const result = await loadCatalog({
      cacheDir: '/cache', fsImpl: memFs(),
      origins: [
        recording('taobao', npmOrigin('https://registry.npm.taobao.org/', 'dsh-plugin-shop-catalog', redirectingRegistry), log),
        recording('healthy', npmOrigin('https://healthy.test/', 'dsh-plugin-shop-catalog', healthyRegistry), log),
      ],
    })
    // Asserted, not assumed. `pointer()` calls are strictly sequential — the
    // loop awaits each one before moving to the next finisher — so this pins
    // exactly the claim the test rests on: the redirecting origin was
    // committed to FIRST, and the load fell through to the healthy one only
    // after it refused. If the ordering ever flips the log becomes
    // ['healthy:pointer'] alone and this fails, instead of the test quietly
    // passing on the wrong path.
    expect(log.filter(line => line.endsWith(':pointer'))).toEqual(['taobao:pointer', 'healthy:pointer'])
    expect(log[0]).toBe('taobao:probe-ok')
    // Only the healthy origin can produce a validated snapshot at all — the
    // redirecting one fails inside pointer(), after probe() already
    // returned it a handle, which is exactly why this is a DIFFERENT
    // discrimination than the probe()-level test above.
    expect(result.snapshot.entries).toHaveLength(1)
    expect(result.stale).toBe(false)
  })
})

describe('entry grammar at the boundary (G-6 / F-3)', () => {
  const base = {
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
    added: '2026-08-25',
  }

  /** Serve one hand-built data file and its pointer, and return the load. */
  function loadWith(plugins: unknown[], schemaVersion = 5): Promise<unknown> {
    const data = JSON.stringify({ schemaVersion, plugins, denied: [] })
    const { pointer } = pointerFor(data, '2026-09-03T00:00:00Z', undefined, schemaVersion)
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch
    return loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
  }

  it('refuses an npm name outside npm\'s own package-name grammar', async () => {
    await expect(loadWith([{ ...base, name: 'dsh-x@npm:some-other-package', source: 'npm' }]))
      .rejects.toThrow(/npm package-name grammar/)
    await expect(loadWith([{ ...base, name: 'dsh x', source: 'npm' }]))
      .rejects.toThrow(/npm package-name grammar/)
  })

  it('refuses an npm version that is not a plain semver version', async () => {
    await expect(loadWith([{ ...base, version: '1.0.0 & calc.exe', source: 'npm' }]))
      .rejects.toThrow(/plain semver version/)
    await expect(loadWith([{ ...base, version: 'v1.2.0', source: 'npm' }]))
      .rejects.toThrow(/plain semver version/)
  })

  it('keeps every shape the live catalog actually publishes', async () => {
    const result = await loadWith([
      { ...base, name: '@scope/dsh-plugin', version: '0.1.4-alpha.2', source: 'npm' },
      { ...base, name: 'dsh.dot_under-name', version: '1.0.0+build.7', source: 'npm' },
      { ...base, name: 'sub-plugin', version: 'd'.repeat(40), source: 'github', repo: 'someone/monorepo', subdir: 'packages/sub-plugin' },
      { ...base, name: '{{PKG_NAME}}', version: 'e'.repeat(40), source: 'github', repo: 'someone/template' },
      {
        ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
        tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
      },
    ]) as { snapshot: { entries: unknown[] } }
    expect(result.snapshot.entries).toHaveLength(5)
  })

  it('refuses a repo that is not owner/slug', async () => {
    await expect(loadWith([{ ...base, version: 'd'.repeat(40), source: 'github', repo: 'a/b?x' }]))
      .rejects.toThrow(/owner\/slug/)
    await expect(loadWith([{ ...base, version: 'd'.repeat(40), source: 'github', repo: 'a/b/c' }]))
      .rejects.toThrow(/owner\/slug/)
  })

  it('refuses a github entry with no repo, which has no installable identity', async () => {
    await expect(loadWith([{ ...base, version: 'd'.repeat(40), source: 'github' }]))
      .rejects.toThrow(/must carry its repo/)
  })

  it('refuses a github version that is neither a commit nor a release tag', async () => {
    await expect(loadWith([{ ...base, version: `${'d'.repeat(40)} & calc.exe`, source: 'github', repo: 'owner/slug' }]))
      .rejects.toThrow(/neither a 40-character commit sha nor a release tag/)
    await expect(loadWith([{ ...base, version: 'refs/heads/main;calc', source: 'github', repo: 'owner/slug' }]))
      .rejects.toThrow(/neither a 40-character commit sha nor a release tag/)
  })

  it('keeps a release tag, with or without a tarball beside it', async () => {
    const result = await loadWith([
      {
        ...base, name: 'dsh-plugin-tui', version: 'v0.2.1', source: 'github', repo: 'ablemind/dsh-plugin-tui',
        tarball: { url: 'https://github.com/ablemind/dsh-plugin-tui/releases/download/v0.2.1/p.tgz', sha256: 'b'.repeat(64) },
      },
      { ...base, name: 'dsh-tagged', version: 'release/1.0', source: 'github', repo: 'owner/tagged' },
    ]) as { snapshot: { entries: unknown[] } }
    expect(result.snapshot.entries).toHaveLength(2)
  })

  it('refuses a tarball url carrying a query or a fragment', async () => {
    await expect(loadWith([{
      ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/p.tgz?a=1&calc', sha256: 'a'.repeat(64) },
    }])).rejects.toThrow(/no query or fragment/)
    await expect(loadWith([{
      ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/p.tgz#x', sha256: 'a'.repeat(64) },
    }])).rejects.toThrow(/no query or fragment/)
  })

  it('refuses a tarball sha256 that is not 64 hex characters', async () => {
    await expect(loadWith([{
      ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/p.tgz', sha256: 'not-a-hash' },
    }])).rejects.toThrow()
  })
})

describe('the stars sidecar carries no prototype (G-8)', () => {
  it('hands the client a null-prototype map', async () => {
    const entry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
      added: '2026-08-25',
    }
    const data = dataJson([entry])
    const stars = starsFile({ 'dsh-hello-plugin': 7 })
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', { url: stars.url, sha256: stars.sha256 })
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/index.json')) return new Response(pointer, { status: 200 })
      if (url.endsWith(stars.url)) return new Response(stars.text, { status: 200 })
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch
    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.stars['dsh-hello-plugin']).toBe(7)
    expect(Object.getPrototypeOf(result.snapshot.stars)).toBeNull()
  })
})

describe('a truncated body degrades to the cache (G-3)', () => {
  it('serves the cached snapshot when the data body dies after ten bytes', async () => {
    const entry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
      added: '2026-08-25',
    }
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith('/index.json')) return new Response(pointer, { status: 200 })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10))
          controller.error(new TypeError('terminated'))
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
    })
    expect(result.stale).toBe(true)
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
  })
})

describe('catalogOrigins', () => {
  const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch

  it('races npm and Pages when the row carries the built-in default', () => {
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, null).map(o => o.id)
    expect(ids).toContain('npm:https://registry.npmmirror.com/')
    expect(ids).toContain('npm:https://registry.npmjs.org/')
    expect(ids).toContain(`http:${DEFAULT_CATALOG_URL}`)
  })

  it('uses an explicit override alone, with no race', () => {
    const origins = catalogOrigins('http://127.0.0.1:9/v1/', fetchImpl, null)
    expect(origins.map(o => o.id)).toEqual(['http:http://127.0.0.1:9/v1/'])
  })

  it('adds the user configured registry as a candidate', () => {
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, 'https://corp.test/npm/').map(o => o.id)
    expect(ids).toContain('npm:https://corp.test/npm/')
  })

  it('does not list the configured registry twice when it is already a default', () => {
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, 'https://registry.npmmirror.com/').map(o => o.id)
    expect(ids.filter(id => id === 'npm:https://registry.npmmirror.com/')).toHaveLength(1)
  })

  it('does not list the configured registry twice when it matches a default but lacks a trailing slash', () => {
    // `npm config get registry` prints exactly this shape, with no trailing
    // slash — byte-different from the default above, and would otherwise
    // race npmmirror twice under two different origin ids (item 10, 2026-09
    // review).
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, 'https://registry.npmmirror.com').map(o => o.id)
    expect(ids.filter(id => id === 'npm:https://registry.npmmirror.com/')).toHaveLength(1)
  })

  it('normalises a path-carrying registry to a trailing slash before racing it', () => {
    // A corporate registry with no trailing slash — e.g.
    // `https://artifactory.corp/api/npm/npm-repo` — must reach the race
    // normalised, or relative URL resolution inside npmOrigin would drop
    // its last path segment on every request (item 10, 2026-09 review).
    const ids = catalogOrigins(DEFAULT_CATALOG_URL, fetchImpl, 'https://artifactory.corp/api/npm/npm-repo').map(o => o.id)
    expect(ids).toContain('npm:https://artifactory.corp/api/npm/npm-repo/')
  })

  it("still loads the catalog when the user's ~/.npmrc names a registry that is not a url", async () => {
    // The whole chain, because no half of it proves the property alone:
    // npmrcRegistry must reject the value, catalogOrigins must therefore
    // race only the built-in defaults, and loadCatalog must still serve a
    // snapshot from a surviving origin.
    //
    // `registry=${NPM_REGISTRY}/` is npm's own documented env expansion —
    // it works perfectly for npm, and a reader that does not expand it
    // captures the literal. Unvalidated, that literal reached npmOrigin's
    // `new URL(pkg + '/latest', registryUrl)` and threw a raw TypeError;
    // catalog.ts's race loop rethrows anything that is not a
    // TransportError, so the load died with npmmirror, npmjs and Pages all
    // healthy and no cache fallback — falsifying the design's own claim
    // that a wrongly guessed registry "loses a 400-byte request and nothing
    // else" (design §3, item A of the 2026-09 review).
    const entry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
      repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
      added: '2026-08-25',
    }
    const data = dataJson([entry])
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
    // Every npm origin is down, so only Pages can serve — the interesting
    // shape: one unusable preference must not be able to take the load down
    // while a healthy origin is standing.
    const serving = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/latest')) return new Response('', { status: 503 })
      return new Response(url.endsWith('/index.json') ? pointer : data, { status: 200 })
    }) as unknown as typeof fetch

    const registry = npmrcRegistry(() => 'registry=${NPM_REGISTRY}/\n', '/home/u')
    const origins = catalogOrigins(DEFAULT_CATALOG_URL, serving, registry)
    const result = await loadCatalog({ cacheDir: '/cache', fsImpl: memFs(), origins })
    expect(result.snapshot.entries).toHaveLength(1)
    expect(result.stale).toBe(false)
    // And the unusable value is dropped rather than raced: nothing gains a
    // fourth origin whose every request is guaranteed to fail.
    expect(origins.map(o => o.id)).toEqual([
      'npm:https://registry.npmmirror.com/',
      'npm:https://registry.npmjs.org/',
      `http:${DEFAULT_CATALOG_URL}`,
    ])
  })
})
