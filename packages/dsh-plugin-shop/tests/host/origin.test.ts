import { describe, expect, it } from 'vitest'
import { TransportError, httpOrigin, resolveDataUrl } from '../../src/host/origin.ts'

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
