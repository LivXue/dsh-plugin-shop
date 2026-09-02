import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TransportError } from '../../src/host/origin.ts'
import { npmOrigin } from '../../src/host/npm-origin.ts'

/** The same real `npm pack` output Task 1 uses. Its inner paths are
 * package/v1/index.json and package/v1/plugins.abc.json. */
const TARBALL = readFileSync(join(import.meta.dirname, '../fixtures/catalog-package.tgz'))
const INTEGRITY = `sha512-${createHash('sha512').update(TARBALL).digest('base64')}`

function registry(options: {
  tarball?: Buffer
  integrity?: string
  tarballUrl?: string
  latestStatus?: number
}): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input)
    if (url.endsWith('/latest')) {
      if (options.latestStatus !== undefined) return new Response('', { status: options.latestStatus })
      return new Response(JSON.stringify({
        name: 'dsh-plugin-shop-catalog',
        version: '2026.901.0',
        dist: {
          tarball: options.tarballUrl ?? 'https://reg.test/dsh-plugin-shop-catalog/-/x-2026.901.0.tgz',
          integrity: options.integrity ?? INTEGRITY,
        },
      }), { status: 200 })
    }
    // Wrapped in Uint8Array: fs.readFileSync's Buffer<ArrayBufferLike> is not
    // assignable to lib.dom's BodyInit (which wants the concrete
    // Uint8Array<ArrayBuffer>), a TS 5.7+ split with no effect on the bytes.
    return new Response(new Uint8Array(options.tarball ?? TARBALL), { status: 200 })
  }) as unknown as typeof fetch
}

const signal = (): AbortSignal => new AbortController().signal

describe('npmOrigin', () => {
  it('resolves latest, verifies integrity, and serves the packed pointer', async () => {
    const handle = await npmOrigin('https://reg.test/', 'dsh-plugin-shop-catalog', registry({})).probe(signal())
    expect(JSON.parse(await handle.pointer())).toMatchObject({ schemaVersion: 5, count: 1 })
  })

  it('serves a file the pointer names, from inside the tarball', async () => {
    const handle = await npmOrigin('https://reg.test/', 'dsh-plugin-shop-catalog', registry({})).probe(signal())
    expect(await handle.file('plugins.abc.json')).toBe('{"schemaVersion":5,"plugins":[],"denied":[]}\n')
  })

  it('downloads the tarball once for repeated reads', async () => {
    let tarballFetches = 0
    const counting = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({
          name: 'c', version: '2026.901.0',
          dist: { tarball: 'https://reg.test/c/-/c-1.tgz', integrity: INTEGRITY },
        }), { status: 200 })
      }
      tarballFetches += 1
      return new Response(new Uint8Array(TARBALL), { status: 200 })
    }) as unknown as typeof fetch
    const handle = await npmOrigin('https://reg.test/', 'c', counting).probe(signal())
    await handle.pointer()
    await handle.file('plugins.abc.json')
    await handle.file('plugins.abc.json')
    expect(tarballFetches).toBe(1)
  })

  it('disqualifies a mirror whose tarball bytes do not match dist.integrity', async () => {
    const wrong = `sha512-${createHash('sha512').update('not the tarball').digest('base64')}`
    const handle = await npmOrigin('https://reg.test/', 'c', registry({ integrity: wrong })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).toMatch(/integrity/)
    // `dist.integrity` is the digest the MIRROR computed over the MIRROR's own
    // tarball, not an independent signature we hold. A mismatch therefore says
    // only that this mirror's manifest and its own tarball disagree with each
    // other — the mirror is broken — and says nothing about whether the catalog
    // is genuine. A mirror that wanted to forge content would simply publish a
    // digest over the forgery and pass, which is the case the two
    // unparsable-tarball tests below cover.
    //
    // So it disqualifies the mirror and the race moves on. Being loud here let
    // one broken mirror close a shop that another origin could have opened —
    // and it ran BEFORE the gunzip, so it was the first thing a mirror serving
    // anything unexpected would trip.
    expect(failure).toBeInstanceOf(TransportError)
    // Attributed, so a four-origin race names the mirror at fault.
    expect(String(failure)).toMatch(/reg\.test/)
  })

  it('refuses a tarball url on a different host than the registry', async () => {
    const handle = await npmOrigin('https://reg.test/', 'c',
      registry({ tarballUrl: 'https://evil.test/c-1.tgz' })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    // A registry answering with a foreign tarball host is the origin failing
    // to speak the protocol, not corrupt catalog content (item 1, 2026-09
    // review): registry.npm.taobao.org still redirects countless ~/.npmrc
    // files to registry.npmmirror.com's own tarball host today, and that
    // origin must fall through to a healthy one rather than fail the load.
    expect(failure).toBeInstanceOf(TransportError)
  })

  it('refuses a pointer-named file that is a path rather than a name', async () => {
    const handle = await npmOrigin('https://reg.test/', 'c', registry({})).probe(signal())
    await expect(handle.file('../package.json')).rejects.toThrow(/must be a plain file name/)
  })

  it('raises TransportError when the registry is unreachable', async () => {
    const dead = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    await expect(npmOrigin('https://reg.test/', 'c', dead).probe(signal()))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('raises TransportError on a non-2xx latest', async () => {
    await expect(npmOrigin('https://reg.test/', 'c', registry({ latestStatus: 502 })).probe(signal()))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('reports a missing file inside the tarball by name, as a transport failure', async () => {
    const handle = await npmOrigin('https://reg.test/', 'c', registry({})).probe(signal())
    const failure = await handle.file('stars.nope.json').catch((e: unknown) => e)
    // A tarball published without a file the pointer or the package itself
    // should carry is a version-skewed or malformed PACKAGE, not corrupt
    // catalog content (item 2(a), 2026-09 review) — it must fall through to
    // another origin, not fail the whole load.
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/stars\.nope\.json/)
  })

  it('raises TransportError when a 200 response is not a valid abbreviated manifest', async () => {
    // A broken mirror, or a corporate proxy answering a registry URL from the
    // user's own .npmrc with an HTML login page instead of JSON — either way
    // this is "not npm", not corrupt catalog content, so it must fall
    // through rather than fail the whole load.
    const brokenMirror = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/latest')) return new Response(JSON.stringify({ error: 'not found' }), { status: 200 })
      throw new Error('should not reach the tarball fetch')
    }) as unknown as typeof fetch
    await expect(npmOrigin('https://reg.test/', 'c', brokenMirror).probe(signal()))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('raises TransportError when dist.tarball is not a valid url', async () => {
    // latestSchema only requires a string, so a mirror answering 200 with
    // junk-but-schema-valid JSON reaches the unguarded `new URL(...)` call
    // with something that cannot parse at all (item 2(b), 2026-09 review).
    const handle = await npmOrigin('https://reg.test/', 'c', registry({ tarballUrl: '' })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/dist\.tarball is not a valid url/)
  })

  it('raises TransportError when dist.integrity names an algorithm this build does not implement', async () => {
    // Nothing has been verified yet at this point, so an algorithm outside
    // the sha512/sha256 this build checks is a transport-layer
    // disqualification, not a claim about content (item 2(c), 2026-09
    // review) — contrast the mismatch test above, which stays a loud,
    // non-retried Error because those bytes provably fail their own claimed
    // digest.
    const md5 = `md5-${createHash('md5').update(TARBALL).digest('base64')}`
    const handle = await npmOrigin('https://reg.test/', 'c', registry({ integrity: md5 })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/unsupported dist\.integrity algorithm/)
  })

  it('raises TransportError when the registry url cannot even be resolved against', async () => {
    // Defence in depth behind npmrc.ts's validation (item A, 2026-09
    // review). `new URL('c/latest', 'localhost:4873/')` throws a raw
    // TypeError, and catalog.ts's race loop rethrows anything that is not a
    // TransportError — so an unvalidated registry from ANY future caller
    // would fail the whole load with every other origin healthy. A registry
    // we cannot address is this origin disqualifying itself.
    const unused = (async () => { throw new Error('should not reach the network') }) as unknown as typeof fetch
    const failure = await npmOrigin('localhost:4873/', 'c', unused).probe(signal()).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/is not a usable registry url/)
  })

  it('raises TransportError when the tarball body is not gzip at all', async () => {
    // A mirror that answers 200 with a login page where the tarball should
    // be — with a dist.integrity it computed over that same page, which is
    // what makes this reachable past verifyIntegrity. gunzipSync throws a
    // plain Error (Z_DATA_ERROR) that escapes the race loop (item B,
    // 2026-09 review). An unparsable tarball is the same statement about
    // the same mirror as an unparsable manifest: it does not speak the
    // protocol.
    const notGzip = Buffer.from('<html><body>login required</body></html>')
    const integrity = `sha512-${createHash('sha512').update(notGzip).digest('base64')}`
    const handle = await npmOrigin('https://reg.test/', 'c',
      registry({ tarball: notGzip, integrity })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/unparsable tarball/)
    // Attributed, so a four-origin race names the mirror at fault (item D).
    expect(String(failure)).toMatch(/reg\.test/)
  })

  it('raises TransportError when the gzip unpacks to bytes that are not a tar', async () => {
    // Valid gzip, garbage inside: readTar throws a plain Error from tar.ts
    // on the unparseable size field. tar.ts's "refuses everything else
    // loudly" was written when the tarball came from one trusted publisher;
    // it now arrives from a raced mirror, so loud must mean "disqualify this
    // mirror", not "fail the load".
    const header = Buffer.alloc(512)
    header.write('package/v1/index.json', 0, 'ascii')
    header.write('zzzzzzzzzzz\0', 124, 'ascii') // size field: not octal at all
    header[156] = '0'.charCodeAt(0) // typeflag: regular file
    const corrupt = gzipSync(header)
    const integrity = `sha512-${createHash('sha512').update(corrupt).digest('base64')}`
    const handle = await npmOrigin('https://reg.test/', 'c',
      registry({ tarball: corrupt, integrity })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/unparsable tarball/)
  })

  it('raises TransportError when the tarball body dies mid-download', async () => {
    // fetch resolves its Response as soon as the headers arrive, so a
    // truncated or reset stream rejects at the BODY read, not at the fetch
    // call — which was wrapped while the body read next to it was not (item
    // C, 2026-09 review). The purest transport failure of the set.
    const truncating = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({
          version: '2026.901.0',
          dist: { tarball: 'https://reg.test/c/-/c-1.tgz', integrity: INTEGRITY },
        }), { status: 200 })
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: () => Promise.reject(new TypeError('fetch failed')),
      } as unknown as Response
    }) as unknown as typeof fetch
    const handle = await npmOrigin('https://reg.test/', 'c', truncating).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/tarball body read failed/)
  })

  it('names the origin on a non-2xx tarball response', async () => {
    // An unattributed message tells an operator nothing in a four-origin
    // race (item D, 2026-09 review).
    const notFound = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({
          version: '2026.901.0',
          dist: { tarball: 'https://reg.test/c/-/c-1.tgz', integrity: INTEGRITY },
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const handle = await npmOrigin('https://reg.test/', 'c', notFound).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/npm origin https:\/\/reg\.test\/ tarball returned 404/)
  })

  it("keeps a registry url's path when resolving the probe request, even with no trailing slash", async () => {
    let requestedUrl = ''
    const pathedRegistry = (async (input: string | URL) => {
      requestedUrl = String(input)
      return new Response(JSON.stringify({
        version: '1.0.0',
        dist: { tarball: 'https://artifactory.corp/api/npm/npm-repo/c/-/c-1.0.0.tgz', integrity: INTEGRITY },
      }), { status: 200 })
    }) as unknown as typeof fetch
    // No trailing slash: this is exactly how `npm config get registry` prints
    // a path-carrying registry (item 10, 2026-09 review). Without
    // normalizing it first, WHATWG relative-URL resolution treats the
    // registry's last path segment as a filename and replaces it instead of
    // appending, dropping `npm-repo` from the request entirely.
    await npmOrigin('https://artifactory.corp/api/npm/npm-repo', 'c', pathedRegistry).probe(signal())
    expect(requestedUrl).toBe('https://artifactory.corp/api/npm/npm-repo/c/latest')
  })
})
