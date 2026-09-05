import { describe, expect, it } from 'vitest'
import { MAX_BODY_BYTES, TransportError, httpOrigin, readCappedText, resolveDataUrl } from '../../src/host/origin.ts'

const ok = (body: string): Response => new Response(body, { status: 200 })

describe('resolveDataUrl', () => {
  it('resolves a relative name against the base', () => {
    expect(resolveDataUrl('https://shop.test/v1/', 'plugins.abc.json'))
      .toBe('https://shop.test/v1/plugins.abc.json')
  })

  it('refuses an absolute url on another origin', () => {
    expect(() => resolveDataUrl('https://shop.test/v1/', 'https://evil.test/x.json'))
      .toThrow(/must be relative to the catalog base/)
  })

  it('refuses a protocol-relative url', () => {
    expect(() => resolveDataUrl('https://shop.test/v1/', '//evil.test/x.json'))
      .toThrow(/must be relative to the catalog base/)
  })
})

describe('httpOrigin', () => {
  it('probes index.json and serves the pointer without a second request', async () => {
    const seen: string[] = []
    const fetchImpl = (async (input: string | URL) => {
      seen.push(String(input))
      return ok('{"pointer":true}')
    }) as unknown as typeof fetch
    const handle = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal)
    expect(await handle.pointer()).toBe('{"pointer":true}')
    expect(await handle.pointer()).toBe('{"pointer":true}')
    expect(seen).toEqual(['https://shop.test/v1/index.json'])
  })

  it('raises TransportError on a non-2xx probe', async () => {
    const fetchImpl = (async () => new Response('', { status: 503 })) as unknown as typeof fetch
    await expect(httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('raises TransportError when the network throws', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    await expect(httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('refuses a cross-origin file url loudly, not as a TransportError', async () => {
    const fetchImpl = (async (input: string | URL) =>
      String(input).endsWith('index.json') ? ok('{}') : ok('data')) as unknown as typeof fetch
    const handle = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal)
    const failure = await handle.file('https://evil.test/x.json').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(TransportError)
  })
})

/** A 200 whose body delivers a prefix and then errors, as a truncated socket
 * does after fetch has already resolved its headers. */
function dying(head: Uint8Array): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head)
      controller.error(new TypeError('terminated'))
    },
  }), { status: 200 })
}

describe('httpOrigin body reads (G-3, F-2/G-10)', () => {
  it('converts a body that dies mid-stream into a TransportError', async () => {
    const fetchImpl = (async (input: string | URL) =>
      String(input).endsWith('index.json') ? ok('{}') : dying(new Uint8Array(10))) as unknown as typeof fetch
    const handle = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal)
    const failure = await handle.file('plugins.abc.json').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/body read failed/)
  })

  it('converts a pointer body that dies mid-stream the same way', async () => {
    const fetchImpl = (async () => dying(new Uint8Array(10))) as unknown as typeof fetch
    await expect(httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('refuses a body over the cap instead of buffering it', async () => {
    const over = new Uint8Array(64)
    const failure = await readCappedText(new Response(over, { status: 200 }), 'probe', 32).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/exceeded the 32-byte cap/)
  })

  it('refuses a 2xx with no body at all', async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    const failure = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/returned no body/)
  })

  it('caps catalog bodies at 64 MiB', () => {
    expect(MAX_BODY_BYTES).toBe(64 * 1024 * 1024)
  })
})
