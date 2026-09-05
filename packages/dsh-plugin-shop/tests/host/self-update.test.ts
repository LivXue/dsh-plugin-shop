import { describe, expect, it, vi } from 'vitest'
import { VERSION_CHECK_TIMEOUT_MS, fetchLatestVersion } from '../../src/host/self-update.ts'

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  }) as unknown as typeof fetch
}

describe('fetchLatestVersion', () => {
  it('returns the latest dist-tag of the shop packument, under a deadline', async () => {
    const fetchFn = fetchReturning({ 'dist-tags': { latest: '0.4.4' } })
    expect(await fetchLatestVersion(fetchFn)).toBe('0.4.4')
    expect(fetchFn).toHaveBeenCalledWith(
      'https://registry.npmjs.org/dsh-plugin-shop',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('degrades to null on a non-ok response', async () => {
    expect(await fetchLatestVersion(fetchReturning({}, false))).toBeNull()
  })

  it('degrades to null on an unexpected payload', async () => {
    expect(await fetchLatestVersion(fetchReturning({}))).toBeNull()
    expect(await fetchLatestVersion(fetchReturning({ 'dist-tags': {} }))).toBeNull()
    expect(await fetchLatestVersion(fetchReturning({ 'dist-tags': { latest: 42 } }))).toBeNull()
  })

  it('degrades to null when the fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    expect(await fetchLatestVersion(fetchFn)).toBeNull()
  })

  it('gives up on a socket that never answers', async () => {
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    expect(await fetchLatestVersion(fetchFn, { timeoutMs: 50 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it("asks the user's own registry first, then npmjs", async () => {
    const urls: string[] = []
    const fetchFn = vi.fn(async (input: string | URL) => {
      urls.push(String(input))
      if (urls.length === 1) return { ok: false, json: async () => ({}) } as unknown as Response
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.9.0' } }) } as unknown as Response
    }) as unknown as typeof fetch
    expect(await fetchLatestVersion(fetchFn, { registry: 'https://registry.npmmirror.com' })).toBe('0.9.0')
    expect(urls).toEqual([
      'https://registry.npmmirror.com/dsh-plugin-shop',
      'https://registry.npmjs.org/dsh-plugin-shop',
    ])
  })

  it('asks once when the configured registry IS npmjs', async () => {
    const fetchFn = fetchReturning({ 'dist-tags': { latest: '1.0.0' } })
    expect(await fetchLatestVersion(fetchFn, { registry: 'https://registry.npmjs.org/' })).toBe('1.0.0')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('bounds the check at five seconds by default', () => {
    expect(VERSION_CHECK_TIMEOUT_MS).toBe(5000)
  })
})
