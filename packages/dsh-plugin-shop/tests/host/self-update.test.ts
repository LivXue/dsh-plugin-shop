import { describe, expect, it, vi } from 'vitest'
import { fetchLatestVersion } from '../../src/host/self-update.ts'

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  }) as unknown as typeof fetch
}

describe('fetchLatestVersion', () => {
  it('returns the latest dist-tag of the shop packument', async () => {
    const fetchFn = fetchReturning({ 'dist-tags': { latest: '0.4.4' } })
    expect(await fetchLatestVersion(fetchFn)).toBe('0.4.4')
    expect(fetchFn).toHaveBeenCalledWith('https://registry.npmjs.org/dsh-plugin-shop')
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
})
