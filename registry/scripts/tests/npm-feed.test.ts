import { describe, expect, it } from 'vitest'
import type { FeedState } from '../src/feed-state.ts'
import { confirmCarriers, FEED_FETCH_ATTEMPTS, FEED_MAX_SELECTED, FEED_PACKUMENT_MAX_BYTES, FEED_PAGE_LIMIT, harvestFeed } from '../src/npm-feed.ts'

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
/** Where a run reads a selected id: its FULL packument, which carries today's
 * owners (`/latest` carries the publish's) and which a CI runner fetched ~75x
 * faster than `/latest` on the PR #74 dry run. */
const isPackument = (name: string) => (url: string): boolean =>
  url === `https://registry.npmjs.org/${encodeURIComponent(name)}`
const page = (rows: readonly { seq: number; id: string; deleted?: boolean }[], lastSeq: number): Response =>
  json({
    results: rows.map(r => ({ seq: r.seq, id: r.id, changes: [{ rev: '1-a' }], ...(r.deleted === true ? { deleted: true } : {}) })),
    last_seq: lastSeq,
  })
/** A full packument whose latest version lists `keywords`, owned by alice. */
const packumentOf = (name: string, keywords: readonly string[] = ['dsh-plugin'], latest: Record<string, unknown> = {}): Response =>
  json({
    name,
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name, version: '1.0.0', keywords, maintainers: [{ name: 'alice' }], ...latest } },
    maintainers: [{ name: 'alice' }],
  })
const at = (seq: number, carriers: Record<string, string[]> = {}, pending: string[] = []): FeedState => ({
  seq,
  carriers: new Map(Object.entries(carriers).map(([name, keywords]) => [name, { owner: 'alice', keywords }])),
  pending,
})
const fullPage = (from: number, idAt: (i: number) => string = i => `pkg-${i}`) =>
  Array.from({ length: FEED_PAGE_LIMIT }, (_, i) => ({ seq: from + 1 + i, id: idAt(i) }))

/** Answers every request from one function of its URL. */
const routeByUrl = (answer: (url: string) => Response): typeof fetch =>
  (async (input: string | URL) => answer(String(input))) as unknown as typeof fetch
const REGISTRY_PREFIX = 'https://registry.npmjs.org/'
const packumentName = (url: string): string => decodeURIComponent(url.slice(REGISTRY_PREFIX.length))

describe('harvestFeed', () => {
  it('reads forward from the cursor to a short page, then reads the manifests it selected', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ db_name: 'registry', update_seq: 300 })],
      [isPage(100), () => page([{ seq: 150, id: 'dsh-a' }, { seq: 160, id: 'react' }], 160)],
      [isPackument('dsh-a'), () => packumentOf('dsh-a')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.seq).toBe(160)
    expect(next.carriers.get('dsh-a')).toEqual({ owner: 'alice', keywords: ['dsh-plugin'] })
    expect(calls.some(c => c.url === 'https://registry.npmjs.org/react')).toBe(false)
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
      [isPackument('dsh-last'), () => packumentOf('dsh-last')],
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
      [isPackument('dsh-first'), () => packumentOf('dsh-first')],
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

  it('retries a thrown head request before calling the feed unavailable', async () => {
    // fetchWithRetry retries statuses, never throws: without this, one
    // connection reset on the head makes the feed unavailable for the day.
    let heads = 0
    const { fetchImpl } = route([
      [isHead, () => {
        heads += 1
        if (heads === 1) throw new TypeError('fetch failed')
        return json({ update_seq: 300 })
      }],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-a' }], 101)],
      [isPackument('dsh-a'), () => packumentOf('dsh-a')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(heads).toBe(2)
    expect(report.available).toBe(true)
    expect(next.carriers.has('dsh-a')).toBe(true)
  })

  it('retries a thrown feed page, so one reset does not end the read', async () => {
    let asked = 0
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => {
        asked += 1
        if (asked === 1) throw new TypeError('fetch failed')
        return page([{ seq: 101, id: 'dsh-a' }], 101)
      }],
      [isPackument('dsh-a'), () => packumentOf('dsh-a')],
    ])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(asked).toBe(2)
    expect(report).toMatchObject({ available: true, pages: 1, note: '' })
  })

  it('retries a feed page that answers a body that is not JSON: an edge answering in npm\'s place', async () => {
    let asked = 0
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => {
        asked += 1
        return asked === 1 ? new Response('<!doctype html>', { status: 200 }) : page([{ seq: 101, id: 'dsh-a' }], 101)
      }],
      [isPackument('dsh-a'), () => packumentOf('dsh-a')],
    ])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(asked).toBe(2)
    expect(report.available).toBe(true)
  })

  it('calls the feed unavailable once every attempt at the head has thrown', async () => {
    let heads = 0
    const { fetchImpl } = route([[isHead, () => {
      heads += 1
      throw new TypeError('fetch failed')
    }]])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(FEED_FETCH_ATTEMPTS).toBeGreaterThan(1)
    expect(heads).toBe(FEED_FETCH_ATTEMPTS)
    expect(report.available).toBe(false)
    expect(report.note).toMatch(/feed head could not be read: fetch failed/)
  })

  it('never asks an answer twice: a 404 on the head is one request', async () => {
    let heads = 0
    const { fetchImpl } = route([[isHead, () => {
      heads += 1
      return json('Not Found', 404)
    }]])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(heads).toBe(1)
    expect(report.available).toBe(false)
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
      [isPackument('dsh-early'), () => packumentOf('dsh-early')],
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
      [isPackument('@scope/dsh-x'), () => packumentOf('@scope/dsh-x')],
    ])
    const { next } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(calls.map(c => c.url)).toContain('https://registry.npmjs.org/%40scope%2Fdsh-x')
    expect(next.carriers.has('@scope/dsh-x')).toBe(true)
  })

  it.each([
    // Only an answer ABOUT THE PACKAGE drops it: a 404, or a packument that
    // was read and is not a carrier. Everything else is a statement about the
    // request -- CLAUDE.md: `no-manifest` means the manifest was read, or a
    // 404 answered for it, never that a request failed -- so the carrier
    // keeps its status, is read again next run, and is counted as failed.
    ['a 404 removes a held carrier', () => json('Not Found', 404), false, false],
    ['a packument whose latest version lacks the keyword removes it', () => packumentOf('dsh-held', ['tool']), false, false],
    ['a deprecated latest version removes it', () => packumentOf('dsh-held', ['dsh-plugin'], { deprecated: 'Use dsh-y.' }), false, false],
    ['a 403 keeps it, pending: a blocking edge says nothing about the package', () => json({}, 403), true, true],
    ['a 200 that is not JSON keeps it, pending: an edge answering in npm\'s place',
      () => new Response('<!doctype html>', { status: 200 }), true, true],
    // A body past the cap is the author's own content -- CLAUDE.md lists
    // "refused for its size" as no-manifest -- and calling it a failure
    // would let any author keep a name pending, and the cursor waiting on
    // it, forever (2026-10-05 security review).
    ['a body over the cap removes it: its size is the author\'s own content',
      () => new Response('{}', { status: 200, headers: { 'content-length': String(FEED_PACKUMENT_MAX_BYTES + 1) } }), false, false],
    ['a 200 whose JSON is null keeps it, pending', () => json(null), true, true],
    ['a 503 after retries keeps it, pending', () => json({}, 503), true, true],
    ['the packument of another package keeps it, pending', () => packumentOf('dsh-other'), true, true],
  ] as const)('%s', async (_what, respond, held, pending) => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-held' }], 101)],
      [isPackument('dsh-held'), respond],
    ])
    const { next, report } = await harvestFeed(at(100, { 'dsh-held': ['dsh-plugin'] }), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.carriers.has('dsh-held')).toBe(held)
    expect(next.pending.includes('dsh-held')).toBe(pending)
    expect(report.failed).toBe(pending ? 1 : 0)
  })

  it('removes a held carrier the feed marks deleted, without a read', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-held', deleted: true }], 101)],
    ])
    const { next } = await harvestFeed(at(100, { 'dsh-held': ['dsh-plugin'] }), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.carriers.has('dsh-held')).toBe(false)
    expect(calls.some(c => c.url.startsWith(REGISTRY_PREFIX))).toBe(false)
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

  it('reads every pending name within two runs when the read budget covers only half of them', async () => {
    // The 2026-10-05 security review's starvation case: four pending names
    // that fail every run, and a budget that starts two reads a run. In a
    // fixed order the same two are read forever and the other two never.
    const asked = new Set<string>()
    const run = async (prior: FeedState, head: number) => {
      let tick = 0
      return harvestFeed(prior, {
        harvestKeywords: KEYWORDS, sleep: instant, now: () => tick++, readBudgetMs: 2.5,
        fetchImpl: routeByUrl(url => {
          if (isHead(url)) return json({ update_seq: head })
          if (url.includes('/_changes?')) return page([], 100)
          asked.add(packumentName(url))
          return json({}, 403)
        }),
      })
    }
    const first = await run(at(100, {}, ['dsh-p0', 'dsh-p1', 'dsh-p2', 'dsh-p3']), 300)
    expect(first.report).toMatchObject({ read: 2, unreached: 2, pending: 4 })
    await run(first.next, 302)
    expect([...asked].sort()).toEqual(['dsh-p0', 'dsh-p1', 'dsh-p2', 'dsh-p3'])
  })

  it('leaves a page for the next run, cursor and all, when it would take the run past the selection bound', async () => {
    const second = 100 + FEED_PAGE_LIMIT
    const { next, report } = await harvestFeed(at(100), {
      harvestKeywords: KEYWORDS, sleep: instant, maxSelected: 4,
      fetchImpl: routeByUrl(url => {
        if (isHead(url)) return json({ update_seq: 99_999 })
        if (isPage(100)(url)) return page(fullPage(100, i => (i < 3 ? `dsh-a${i}` : `pkg-${i}`)), second)
        if (isPage(second)(url)) return page(fullPage(second, i => (i < 3 ? `dsh-b${i}` : `pkg-${i}`)), second + FEED_PAGE_LIMIT)
        return packumentOf(packumentName(url))
      }),
    })
    // The first page's 3 ids fit under 4; the second page's 3 more would not.
    expect(report).toMatchObject({ pages: 1, selected: 3 })
    expect(report.note).toBe('stopped after 1 page(s): the next page would take this run past 4 selected ids')
    expect(next.seq).toBe(second)
    expect([...next.carriers.keys()].sort()).toEqual(['dsh-a0', 'dsh-a1', 'dsh-a2'])
  })

  it('counts pending names toward the bound for every page after the first', async () => {
    // Replaces "a backlog holds the cursor back until it drains": holding the
    // FIRST page back let a backlog of failing reads stop the feed for good
    // (2026-10-05 security review). Pending still counts toward the bound,
    // so it is the second page that waits here: 3 pending and 1 new fit
    // under 4, one more would not.
    const second = 100 + FEED_PAGE_LIMIT
    const { next, report } = await harvestFeed(at(100, {}, ['dsh-p0', 'dsh-p1', 'dsh-p2']), {
      harvestKeywords: KEYWORDS, sleep: instant, maxSelected: 4,
      fetchImpl: routeByUrl(url => {
        if (isHead(url)) return json({ update_seq: 99_999 })
        if (isPage(100)(url)) return page(fullPage(100, i => (i === 0 ? 'dsh-new0' : `pkg-${i}`)), second)
        if (isPage(second)(url)) return page([{ seq: second + 1, id: 'dsh-new1' }], second + 1)
        return packumentOf(packumentName(url))
      }),
    })
    expect(report).toMatchObject({ pages: 1, selected: 4, toSeq: second })
    expect(report.note).toBe('stopped after 1 page(s): the next page would take this run past 4 selected ids')
    expect([...next.carriers.keys()].sort()).toEqual(['dsh-new0', 'dsh-p0', 'dsh-p1', 'dsh-p2'])
  })

  it('always takes the first page, so a backlog can slow the cursor but never stop it', async () => {
    // Five pending names that fail every run, already past a bound of 4: had
    // the bound held the first page back, nothing but the backlog would ever
    // be read again and the cursor would never move.
    const { next, report } = await harvestFeed(at(100, {}, ['dsh-p0', 'dsh-p1', 'dsh-p2', 'dsh-p3', 'dsh-p4']), {
      harvestKeywords: KEYWORDS, sleep: instant, maxSelected: 4,
      fetchImpl: routeByUrl(url => {
        if (isHead(url)) return json({ update_seq: 300 })
        if (isPage(100)(url)) return page([{ seq: 101, id: 'dsh-new0' }], 101)
        const name = packumentName(url)
        return name === 'dsh-new0' ? packumentOf(name) : json({}, 503)
      }),
    })
    expect(report).toMatchObject({ pages: 1, toSeq: 101, selected: 6, failed: 5 })
    expect(next.seq).toBe(101)
    expect(next.carriers.has('dsh-new0')).toBe(true)
  })

  it('bounds a run high enough to take the measured bootstrap in one run', () => {
    // 17,779 ids selected from FEED_BOOTSTRAP_SEQ to the head (spec section 2).
    expect(FEED_MAX_SELECTED).toBeGreaterThanOrEqual(17_779)
  })

  it('sends the npm token to the registry and never to the feed host', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-a' }], 101)],
      [isPackument('dsh-a'), () => packumentOf('dsh-a')],
    ])
    await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, token: 'secret' })
    expect(calls.length).toBe(3)
    for (const call of calls) {
      expect(call.auth).toBe(call.url.startsWith('https://registry.npmjs.org/') ? 'Bearer secret' : null)
    }
  })
})

describe('confirmCarriers', () => {
  /** A full packument whose latest version recorded `former` at publish, and
   * whose owners today are `owners`. */
  const full = (name: string, owners: readonly string[], latest: Record<string, unknown> = {}): Response => json({
    name,
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name, version: '1.0.0', keywords: ['dsh-plugin'], maintainers: [{ name: 'former' }], ...latest } },
    maintainers: owners.map(owner => ({ name: owner })),
  })

  it('reads each full packument, with the token, and reports the current owner', async () => {
    const { fetchImpl, calls } = route([[isPackument('@scope/dsh-x'), () => full('@scope/dsh-x', ['bob'])]])
    const reads = await confirmCarriers(['@scope/dsh-x'], { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, token: 'secret' })
    expect(reads.get('@scope/dsh-x')).toEqual({ kind: 'carrier', name: '@scope/dsh-x', carrier: { owner: 'bob', keywords: ['dsh-plugin'] } })
    expect(calls).toEqual([{ url: 'https://registry.npmjs.org/%40scope%2Fdsh-x', auth: 'Bearer secret' }])
  })

  it.each([
    ['a 404 is gone', () => json('Not Found', 404), 'gone'],
    ['a deprecated latest version is not a carrier', () => full('dsh-x', ['bob'], { deprecated: 'Use dsh-y.' }), 'not-carrier'],
    ['a 503 after retries is failed', () => json({}, 503), 'failed'],
    ['a body that is not JSON is failed', () => new Response('<!doctype html>', { status: 200 }), 'failed'],
  ] as const)('%s', async (_what, respond, kind) => {
    const { fetchImpl } = route([[isPackument('dsh-x'), respond]])
    const reads = await confirmCarriers(['dsh-x'], { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(reads.get('dsh-x')?.kind).toBe(kind)
  })

  it('reports a thrown request as failed rather than throwing', async () => {
    const { fetchImpl } = route([[isPackument('dsh-x'), () => {
      throw new TypeError('fetch failed')
    }]])
    const reads = await confirmCarriers(['dsh-x'], { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(reads.get('dsh-x')).toMatchObject({ kind: 'failed' })
  })
})
