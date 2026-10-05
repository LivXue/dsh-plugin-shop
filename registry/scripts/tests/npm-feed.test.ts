import { describe, expect, it } from 'vitest'
import type { FeedState } from '../src/feed-state.ts'
import { FEED_MANIFEST_MAX_BYTES, FEED_PAGE_LIMIT, harvestFeed } from '../src/npm-feed.ts'

const KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']
const instant = async (_ms: number): Promise<void> => {}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

type Handler = readonly [match: (url: string) => boolean, respond: () => Response]

/** Routes each request by URL; an unmatched URL is a fixture bug and throws. */
function route(handlers: readonly Handler[]): { fetchImpl: typeof fetch; calls: { url: string; auth: string | null }[] } {
  const calls: { url: string; auth: string | null }[] = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    for (const [match, respond] of handlers) if (match(url)) return respond()
    throw new Error(`unexpected request ${url}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const isHead = (url: string): boolean => url === 'https://replicate.npmjs.com/registry/'
const isPage = (since: number) => (url: string): boolean =>
  url === `https://replicate.npmjs.com/registry/_changes?since=${since}&limit=${FEED_PAGE_LIMIT}`
const isLatest = (name: string) => (url: string): boolean =>
  url === `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`
const page = (rows: readonly { seq: number; id: string; deleted?: boolean }[], lastSeq: number): Response =>
  json({
    results: rows.map(r => ({ seq: r.seq, id: r.id, changes: [{ rev: '1-a' }], ...(r.deleted === true ? { deleted: true } : {}) })),
    last_seq: lastSeq,
  })
const manifest = (name: string, keywords: readonly string[] = ['dsh-plugin']): Response =>
  json({ name, version: '1.0.0', keywords, maintainers: [{ name: 'alice' }] })
const at = (seq: number, carriers: Record<string, string[]> = {}, pending: string[] = []): FeedState => ({
  seq,
  carriers: new Map(Object.entries(carriers).map(([name, keywords]) => [name, { owner: 'alice', keywords }])),
  pending,
})
const fullPage = (from: number, idAt: (i: number) => string = i => `pkg-${i}`) =>
  Array.from({ length: FEED_PAGE_LIMIT }, (_, i) => ({ seq: from + 1 + i, id: idAt(i) }))

describe('harvestFeed', () => {
  it('reads forward from the cursor to a short page, then reads the manifests it selected', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ db_name: 'registry', update_seq: 300 })],
      [isPage(100), () => page([{ seq: 150, id: 'dsh-a' }, { seq: 160, id: 'react' }], 160)],
      [isLatest('dsh-a'), () => manifest('dsh-a')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.seq).toBe(160)
    expect(next.carriers.get('dsh-a')).toEqual({ owner: 'alice', keywords: ['dsh-plugin'] })
    expect(calls.some(c => c.url.includes('/react/latest'))).toBe(false)
    expect(report).toEqual({
      available: true, note: '', fromSeq: 100, toSeq: 160, pages: 1, selected: 1, read: 1, failed: 0,
      unreached: 0, refused: 0, pending: 0, carriers: { 'dsh-plugin': 1, 'deepseek-harness': 0 },
    })
  })

  it('keeps paging while pages come back full', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 99_999 })],
      [isPage(100), () => page(fullPage(100), 100 + FEED_PAGE_LIMIT)],
      [isPage(100 + FEED_PAGE_LIMIT), () => page([{ seq: 100 + FEED_PAGE_LIMIT + 1, id: 'dsh-last' }], 100 + FEED_PAGE_LIMIT + 1)],
      [isLatest('dsh-last'), () => manifest('dsh-last')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report.pages).toBe(2)
    expect(next.seq).toBe(100 + FEED_PAGE_LIMIT + 1)
    expect(next.carriers.has('dsh-last')).toBe(true)
  })

  it('stops at the page budget, keeping what it read', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 99_999 })],
      [isPage(100), () => page(fullPage(100, i => (i === 0 ? 'dsh-first' : `pkg-${i}`)), 100 + FEED_PAGE_LIMIT)],
      [isLatest('dsh-first'), () => manifest('dsh-first')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, pageBudget: 1 })
    expect(report.note).toBe('stopped at the 1-page budget')
    expect(next.seq).toBe(100 + FEED_PAGE_LIMIT)
    expect(next.carriers.has('dsh-first')).toBe(true)
  })

  it('is unavailable when the head cannot be read, and leaves the state exactly as it was', async () => {
    const prior = at(100, { 'dsh-held': ['dsh-plugin'] })
    const { fetchImpl, calls } = route([[isHead, () => json({ error: 'down' }, 503)]])
    const { next, report } = await harvestFeed(prior, { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next).toBe(prior)
    expect(report).toMatchObject({ available: false, fromSeq: 100, toSeq: 100, pages: 0, selected: 0 })
    expect(report.note).toMatch(/feed head could not be read/)
    expect(calls.some(c => c.url.includes('_changes'))).toBe(false)
  })

  it('is unavailable when the stored cursor is past the head, naming the re-seed', async () => {
    const { fetchImpl } = route([[isHead, () => json({ update_seq: 50 })]])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report.available).toBe(false)
    expect(report.note).toMatch(/cursor 100 is past the feed head 50.*re-seeded/)
  })

  it('is unavailable when the first page has a shape it does not know', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => json({ results: [], last_seq: '160-g1AAAA' })],
    ])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report).toMatchObject({ available: false, note: 'the first feed page has an unexpected shape' })
  })

  it('keeps the pages already read when a later page fails', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 99_999 })],
      [isPage(100), () => page(fullPage(100, i => (i === 5 ? 'dsh-early' : `pkg-${i}`)), 100 + FEED_PAGE_LIMIT)],
      [isPage(100 + FEED_PAGE_LIMIT), () => json({}, 500)],
      [isLatest('dsh-early'), () => manifest('dsh-early')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report.available).toBe(true)
    expect(report.note).toMatch(/^stopped after 1 page\(s\): /)
    expect(next.seq).toBe(100 + FEED_PAGE_LIMIT)
    expect(next.carriers.has('dsh-early')).toBe(true)
  })

  it('reads a scoped name with its scope and slash encoded', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: '@scope/dsh-x' }], 101)],
      [isLatest('@scope/dsh-x'), () => manifest('@scope/dsh-x')],
    ])
    const { next } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(calls.map(c => c.url)).toContain('https://registry.npmjs.org/%40scope%2Fdsh-x/latest')
    expect(next.carriers.has('@scope/dsh-x')).toBe(true)
  })

  it.each([
    ['a 404 removes a held carrier', () => json('Not Found', 404), false, false],
    ['a 403 removes it: an answer about the resource', () => json({}, 403), false, false],
    ['a manifest that is not JSON removes it', () => new Response('<!doctype html>', { status: 200 }), false, false],
    ['a manifest over the cap removes it',
      () => new Response('{}', { status: 200, headers: { 'content-length': String(FEED_MANIFEST_MAX_BYTES + 1) } }), false, false],
    ['a manifest without the keyword removes it', () => manifest('dsh-held', ['tool']), false, false],
    ['a 503 after retries keeps it, pending', () => json({}, 503), true, true],
    ['the manifest of another package keeps it, pending', () => manifest('dsh-other'), true, true],
  ] as const)('%s', async (_what, respond, held, pending) => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-held' }], 101)],
      [isLatest('dsh-held'), respond],
    ])
    const { next } = await harvestFeed(at(100, { 'dsh-held': ['dsh-plugin'] }), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.carriers.has('dsh-held')).toBe(held)
    expect(next.pending.includes('dsh-held')).toBe(pending)
  })

  it('removes a held carrier the feed marks deleted, without a read', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-held', deleted: true }], 101)],
    ])
    const { next } = await harvestFeed(at(100, { 'dsh-held': ['dsh-plugin'] }), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.carriers.has('dsh-held')).toBe(false)
    expect(calls.some(c => c.url.endsWith('/latest'))).toBe(false)
  })

  it('leaves what it could not start within the read budget pending, and still advances the cursor', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-a' }, { seq: 102, id: 'dsh-b' }], 102)],
    ])
    const { next, report } = await harvestFeed(at(100), {
      harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, now: () => 0, readBudgetMs: 0,
    })
    expect(report).toMatchObject({ selected: 2, read: 0, unreached: 2, pending: 2 })
    expect(next.pending).toEqual(['dsh-a', 'dsh-b'])
    expect(next.seq).toBe(102)
  })

  it('sends the npm token to the registry and never to the feed host', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-a' }], 101)],
      [isLatest('dsh-a'), () => manifest('dsh-a')],
    ])
    await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, token: 'secret' })
    expect(calls.length).toBe(3)
    for (const call of calls) {
      expect(call.auth).toBe(call.url.startsWith('https://registry.npmjs.org/') ? 'Bearer secret' : null)
    }
  })
})
