# Audit fixes A — stop the bleeding (registry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight WP0 findings that are live or days away in the registry pipeline — the search window that is 155 names from breaking every daily build, the single transport failure that aborts a 5,600-packument harvest, the token forwarded to a third-party mirror, the uncommitted `first-seen.yml` that re-stamps half the shelf daily, the unescaped names that will make the bot write YAML nobody can read back, the pushes that are rejected and reported as success, the unbounded strings that put a 222 MB `plugins.json` in front of every reader, and the three network clients with no deadline.

**Architecture:** Every fix stays on the side of the boundary it belongs to. Policy decisions — length bounds with author-readable details, the coverage rule for a partitioned search, the name grammar — go in the pure core (`gate.ts`, `schema.ts`) or in a pure exported function driven by an injected probe (`partitionKeyword`); transport concerns — timeouts, failover, the token, capped body reads — stay in the impure shell (`npm-client.ts`, `github-client.ts`, `llm-client.ts`, `github-stars.ts`). Two of the fixes are workflow-shaped and get a vitest guard that reads `.github/workflows/daily.yml` as data, so the next forgotten `git add` or missing rebase fails the suite instead of the publish.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), zod 4, yaml 2.9, vitest 2, Node 24, GitHub Actions.

**Spec:** [docs/plans/2026-09-03-debug-audit.md](2026-09-03-debug-audit.md) — findings D-1, D-2/A-5, D-6, C-1/A-6/E-1, A-3/E-3, E-2, A-1, D-5

## Global Constraints

- **A pure core, an impure shell.** Pure: `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`, `types.ts` — no clock, no network, no filesystem, no environment. Impure: `npm-client.ts`, `llm-client.ts`, `github-stars.ts`, `github-client.ts`, `build.ts`, `config.ts`, `emit-schema.ts`. A policy decision that migrates into the shell becomes untestable.
- **`builtAt` never enters the hashed content.** It belongs to `index.json` alone. A determinism test in `pipeline.test.ts` enforces it; if you edit that test to pass, you have broken the property it protects.
- **Entries sort by package name before emit.** Output must not depend on the order npm returned them in.
- **Every rejection carries an author-readable `detail`.** Those strings are published and a plugin author reads them to find out why their package is not listed — a wrong or misattributed reason is a defect, not a wording nit.
- **Everything from npm and GitHub is hostile** — package names, descriptions, `dsh.catalog` contents, and the field names inside it. Validate at that boundary; escape anything rendered into the build report.
- **Fail loudly.** A malformed registry file throws. Hitting the search page bound throws rather than truncating. A package that cannot be fetched becomes a `fetch-failed` rejection in the build report — nothing disappears without a reason attached to its name.
- **ESM everywhere** (`"type": "module"`); `.ts` extensions in local relative imports.
- **`strict` and `noUncheckedIndexedAccess` are on.** Guard index access; never assert it away.
- **Files end with exactly one trailing newline.**
- **`registry/schema/plugin-entry.schema.json` is GENERATED.** Regenerate with `pnpm emit:schema`; never hand-edit. `schema.test.ts:41` freshness-tests it.
- **Never run `pnpm build:catalog` to check that a change compiles.** It makes thousands of live npm requests and takes minutes; the tests cover every policy decision without a network.
- **The search window is 5000 and `PAGE_SIZE` is 250** (`npm-client.ts:13`). `HARVEST_CONCURRENCY` is 8 (`npm-client.ts:355`). `HARVEST_KEYWORDS` is `['dsh-plugin', 'deepseek-harness']` (`npm-client.ts:10`).
- **Baseline at HEAD `49db942`:** `pnpm test` = 22 files / 334 tests green in ~3.4 s; `pnpm typecheck` clean.
- **Mutation-check every new test** the way audit H did: copy the module under test to the scratchpad, inject the bug the test claims to catch, point the test at the copy, watch it fail. A test that stays green under its own mutation is not a test.

### Measured API facts this plan depends on (probed live 2026-09-03, `registry.npmjs.org/-/v1/search`)

These were probed before the plan was written because the audit's suggested D-1 partition does not work. Re-probe before changing the constants.

| Probe | Result |
|---|---|
| `text=keywords:dsh-plugin&size=1` | `total` 3698 |
| `text=keywords:deepseek-harness&size=1` | `total` 5095 |
| `text=keywords:deepseek-harness&size=250&from=5000` | 95 objects — the exact tail; the window ends here |
| `text=keywords:deepseek-harness&size=250&from=5001` | 250 objects **identical to `from=0`** — the wrap |
| `text=keywords:deepseek-harness&size=1000` | 250 objects — `size` is capped at 250 |
| `text=keywords:deepseek-harness,dsh-plugin` | `total` 3178 — a comma is an **intersection**, and it filters |
| `text=keywords:deepseek-harness+dsh-plugin` | `total` 0 — `+` is not API syntax |
| `text=keywords:deepseek-harness,-dsh-plugin` | `total` 0 — **there is no negation** |
| `text=keywords:deepseek-harness a` / `z` / `0` / `dsh` | `total` 5095, first page unchanged — **a free text term does not filter** |
| `text=keywords:deepseek-harness scope:deepseek-ai` | `total` 5095 — `scope:` does not filter |
| `text=author:nanmicoder`, `text=maintainer:nanmicoder` | `total` 0 — not honored |
| `text=keywords:deepseek-harness not:unstable` / `is:unstable` | `total` 5095 — not honored |
| `&quality=0&popularity=1&maintenance=0` vs `&quality=1&popularity=0` | identical totals **and identical first page** — the weights do not re-slice |

**Consequence:** the audit's proposed partition ("an added `text` term per initial letter") does not partition anything — the total and the ordering are unchanged by a text term. The only filtering dimension the API offers is `keywords:a,b` intersection, and with no negation a cell's complement cannot be expressed. So the partition in Task 1 is **safe by check, not by construction**: it splits on intersections and then *measures* its own coverage against the keyword's total and throws on a shortfall.

Co-keyword totals against `keywords:deepseek-harness` (2026-09-03), which is what `PARTITION_KEYWORDS` is ordered by: `dsh` 4255, `dsh-plugin` 3178, `plugin` 1604, `deepseek` 949, `agent` 498, `mcp` 213, `cli` 72, `harness` 41, `claude` 35, `ai` 31, `tool` 29.

---

### Task 1: D-1 — read `total`, throw correctly at the window, partition the query, and stop ending a keyword on a short page

> **Amendment (2026-09-03, after Task 1's review).** Three defects in this task's text, all found by
> reviewing what it produced:
>
> 1. `const cellTotal = typeof body.total === 'number' ? body.total : 0` (this task's step 3c, and
>    `npm-client.ts:443` as shipped) makes `from + objects.length >= cellTotal` true on the
>    FIRST page, so a page carrying no numeric `total` ends the cell silently — where the
>    `MAX_SEARCH_PAGES` guard this task deletes was loud on exactly that input. The registry really
>    does serve 200s with `<!doctype html>` bodies. A missing `total` must THROW:
>    `if (typeof body.total !== 'number') throw new Error(...)`. The coverage check must also run for
>    unpartitioned keywords, which additionally catches a mid-stream empty page.
> 2. `PARTITION_KEYWORDS` as listed below covers 5,059 of `keywords:deepseek-harness`'s 5,103 names —
>    a 44-name shortfall, so the partition throws its coverage error on the day the keyword crosses the
>    window. Add `cordis` (20), `codex` (10), `claude-code` (10) and `desktop-pet` (7), measured
>    2026-09-03. A cell is always `keywords:<harvest-keyword>,<refinement>`, so a refinement can only
>    narrow the net.
> 3. The doc comment's claim that a bare text term "left both the total and the first page unchanged"
>    is false — it re-ranks the head completely. The conclusion holds for a different reason: the TAIL
>    is score-stable, so no text term moves a name into the reachable window.

**Files:**
- Modify: `registry/scripts/src/npm-client.ts:91-99` (delete `MAX_SEARCH_PAGES`), `:265-310` (rewrite `searchByKeywords`), and insert the new constants and helpers after `:13`
- Test: `registry/scripts/tests/npm-client.test.ts` (rewrite the obsolete test at `:430-440`, add five)

**Interfaces:**
- Consumes: `fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs): Promise<Response>` (existing, `npm-client.ts:61`); `PAGE_SIZE = 250` (`:13`); `REQUEST_TIMEOUT_MS = 30_000` (`:21`); `HARVEST_KEYWORDS` (`:10`)
- Produces:
  - `export const MAX_SEARCH_FROM = 5000`
  - `export const SEARCH_WINDOW: number` (= 5250)
  - `export const PARTITION_KEYWORDS: readonly string[]`
  - `export function keywordQuery(keywords: readonly string[]): string`
  - `export async function partitionKeyword(keyword: string, probe: (keywords: readonly string[]) => Promise<number>): Promise<{ cells: string[][]; total: number; partitioned: boolean }>`
  - `searchByKeywords` keeps its exact signature `(fetchImpl?, sleep?, token?, backupRegistry?, timeoutMs?) => Promise<string[]>`

- [ ] **Step 1: Write the failing test**

Replace the obsolete page-bound test (`npm-client.test.ts:430-440`, quoted in Step 3 below) and append the rest inside the existing `describe('searchByKeywords', …)` block.

```ts
  // A search stub built from per-query totals and pages. `size=1` is the
  // total probe, anything else is a page fetch; both answer `total` the way
  // the live registry does, so the loop under test reads it.
  function stubSearch(
    totals: Record<string, number>,
    pages: (query: string, from: number) => string[],
    pagedTotals: Record<string, number> = {},
  ): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      urls.push(text)
      const params = new URL(text).searchParams
      const query = params.get('text') ?? ''
      const total = totals[query] ?? 0
      if (params.get('size') === '1') {
        return new Response(JSON.stringify({ total, objects: [] }), { status: 200 })
      }
      const from = Number(params.get('from') ?? '0')
      const names = pages(query, from)
      return new Response(JSON.stringify({
        total: pagedTotals[query] ?? total,
        objects: names.map(name => ({ package: { name } })),
      }), { status: 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, urls }
  }

  it('does not end a keyword on a short non-final page — it reads the total', async () => {
    // Live shape: npm served a 249-object page of a 600-name result set. The
    // old `objects.length < PAGE_SIZE` break dropped pages 1 and 2 in silence.
    const totals = { 'keywords:dsh-plugin': 600, 'keywords:deepseek-harness': 0 }
    const { fetchImpl } = stubSearch(totals, (query, from) => {
      if (query !== 'keywords:dsh-plugin') return []
      if (from === 0) return Array.from({ length: 249 }, (_, i) => `a${i}`)
      if (from === 250) return Array.from({ length: 250 }, (_, i) => `b${i}`)
      if (from === 500) return Array.from({ length: 101 }, (_, i) => `c${i}`)
      return []
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(600)
    expect(names).toContain('c100')
  })

  it('throws, naming the reachable window, when a keyword is past it and nothing splits it', async () => {
    // Every query — the keyword and every refinement cell — reports 6000, so
    // no cell fits. The message must name the window and the cap, not blame
    // "100 pages" the way the old bound did.
    const everythingOversized = new Proxy({} as Record<string, number>, { get: () => 6000 })
    const { fetchImpl, urls } = stubSearch(everythingOversized, () => [])
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin,\S+ reports more than the 5250 names one query can reach \(from is capped at 5000\) and no refinement keyword splits it/,
    )
    // Every request is a size=1 probe: not one wasted page fetch.
    expect(urls.every(url => new URL(url).searchParams.get('size') === '1')).toBe(true)
  })

  it('partitions an over-window keyword into refinement cells and unions them', async () => {
    // A self-consistent fixture: the keyword is 5,300 names, two refinement
    // cells hold 5,000 and 300, and the pages actually serve them — so the
    // coverage check below passes on the same arithmetic the cells report.
    const totals: Record<string, number> = {
      'keywords:dsh-plugin': 5300,
      'keywords:dsh-plugin,dsh': 5000,
      'keywords:dsh-plugin,deepseek-harness': 300,
      'keywords:deepseek-harness': 0,
    }
    const { fetchImpl } = stubSearch(totals, (query, from) => {
      const total = totals[query] ?? 0
      const prefix = query === 'keywords:dsh-plugin,dsh' ? 'd' : 'h'
      if (query !== 'keywords:dsh-plugin,dsh' && query !== 'keywords:dsh-plugin,deepseek-harness') return []
      return Array.from(
        { length: Math.max(0, Math.min(250, total - from)) },
        (_, i) => `${prefix}${from + i}`,
      )
    })
    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(5300)
    expect(names).toContain('d0')
    expect(names).toContain('d4999')
    expect(names).toContain('h299')
  })

  it('throws when the refinement cells do not cover the keyword', async () => {
    // No negation qualifier exists, so a partition is never covering by
    // construction — the shortfall must be measured and refused, never
    // published as a short harvest.
    const totals: Record<string, number> = {
      'keywords:dsh-plugin': 5300,
      'keywords:dsh-plugin,dsh': 10,
      'keywords:deepseek-harness': 0,
    }
    const { fetchImpl } = stubSearch(totals, (query, from) =>
      query === 'keywords:dsh-plugin,dsh' && from === 0
        ? Array.from({ length: 10 }, (_, i) => `n${i}`)
        : [])
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin enumerated 10 of 5300 names across 1 partition cell\(s\); the refinement keywords do not cover the keyword/,
    )
  })

  it('refuses to ask for a from past the window instead of paging into the wrap', async () => {
    // The probe says the keyword fits, the pages say it does not. `from=5250`
    // would silently return page 0 (measured live), so the loop must throw.
    const { fetchImpl, urls } = stubSearch(
      { 'keywords:dsh-plugin': 5250, 'keywords:deepseek-harness': 0 },
      () => Array.from({ length: 250 }, (_, i) => `p${i}`),
      { 'keywords:dsh-plugin': 9999 },
    )
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(
      /npm search for keywords:dsh-plugin needs from=5250, past the 5000 the registry honors \(a larger from silently returns page 0\)/,
    )
    expect(urls).toHaveLength(22) // one size=1 probe plus from=0..5000
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "does not end a keyword on a short non-final page"`
Expected: FAIL — `AssertionError: expected [ 'a0', 'a1', …249 items ] to have a length of 600 but got 249`. The other four fail with `TypeError: searchByKeywords is not reading total` style assertion errors; specifically the window test fails as `expected [Function] to throw error matching /…reports more than the 5250 names…/ but got 'npm search for keywords:dsh-plugin exceeded 100 pages (25000 names) without completing; harvest is incomplete'`.

- [ ] **Step 3: Write the implementation**

Three edits in `registry/scripts/src/npm-client.ts`.

**3a.** Insert after line 13 (`const PAGE_SIZE = 250`):

```ts
/**
 * The largest `from` the npm search API honors. A `from` past it silently
 * returns page 0 rather than an error — measured 2026-09-03:
 * `keywords:deepseek-harness&size=250&from=5000` returned the 95-name tail of
 * a 5,095-name result set, and `from=5001` returned the same 250 objects as
 * `from=0`. `size` is capped at 250 (a `size=1000` request returned 250), so
 * the window cannot be widened from the caller's side either.
 */
export const MAX_SEARCH_FROM = 5000

/**
 * How many names ONE search query can enumerate: the last reachable page plus
 * its size. Past it the registry has no way to serve the tail, so the harvest
 * must partition the query rather than page into the wrap. Harvesting a subset
 * would be indistinguishable from an ecosystem that shrank.
 */
export const SEARCH_WINDOW = MAX_SEARCH_FROM + PAGE_SIZE

/**
 * Refinement keywords the harvest ANDs onto an over-window keyword to split it
 * into reachable cells, most-covering first.
 *
 * `keywords:a,b` is an INTERSECTION on `/-/v1/search`, and it is the ONLY
 * filtering qualifier the API honors. Probed 2026-09-03 against
 * `keywords:deepseek-harness` (total 5,095): `scope:`, `author:`,
 * `maintainer:`, `not:unstable`, `is:unstable`, a bare text term, and the
 * `quality`/`popularity`/`maintenance` weights each left both the total and
 * the first page unchanged — none of them can split or re-slice the window.
 * The intersections do: `dsh` 4,255, `dsh-plugin` 3,178, `plugin` 1,604,
 * `deepseek` 949, `agent` 498, `mcp` 213, `cli` 72, `harness` 41,
 * `claude` 35, `tool` 29.
 *
 * There is no negation qualifier (`keywords:a,-b` returns total 0), so a
 * cell's complement cannot be expressed and this partition is NOT covering by
 * construction. {@link searchByKeywords} therefore MEASURES its coverage
 * against the keyword's own total and throws on a shortfall: safe by check,
 * not by construction. Adding a keyword here is the documented response to
 * that throw.
 */
export const PARTITION_KEYWORDS: readonly string[] = [
  'dsh', 'dsh-plugin', 'deepseek-harness', 'plugin', 'deepseek',
  'agent', 'mcp', 'cli', 'claude', 'tool',
]

/** One query's `text` value: the keyword, plus any refinements ANDed on. */
export function keywordQuery(keywords: readonly string[]): string {
  return `keywords:${keywords.join(',')}`
}

/**
 * Split one harvest keyword into queries whose totals each fit
 * {@link SEARCH_WINDOW}.
 * @param keyword - the harvest keyword.
 * @param probe - reads one query's `total`; injected so tests need no network.
 * @returns the cells to page, the keyword's own total, and whether a split
 *   happened (an unsplit keyword needs no coverage check: paging to its
 *   answered total already enumerates all of it).
 * @throws when a cell is past the window and no refinement keyword splits it.
 */
export async function partitionKeyword(
  keyword: string,
  probe: (keywords: readonly string[]) => Promise<number>,
): Promise<{ cells: string[][]; total: number; partitioned: boolean }> {
  const total = await probe([keyword])
  if (total <= SEARCH_WINDOW) return { cells: [[keyword]], total, partitioned: false }
  const cells: string[][] = []
  const oversized: string[][] = []
  for (const refinement of PARTITION_KEYWORDS) {
    if (refinement === keyword) continue
    const cell = [keyword, refinement]
    const cellTotal = await probe(cell)
    if (cellTotal === 0) continue
    if (cellTotal <= SEARCH_WINDOW) cells.push(cell)
    else oversized.push(cell)
  }
  for (const cell of oversized) {
    let split = false
    for (const refinement of PARTITION_KEYWORDS) {
      if (cell.includes(refinement)) continue
      const deeperTotal = await probe([...cell, refinement])
      if (deeperTotal === 0 || deeperTotal > SEARCH_WINDOW) continue
      cells.push([...cell, refinement])
      split = true
    }
    if (!split) {
      throw new Error(
        `npm search for ${keywordQuery(cell)} reports more than the ${SEARCH_WINDOW} names one query can reach (from is capped at ${MAX_SEARCH_FROM}) and no refinement keyword splits it; add one to PARTITION_KEYWORDS`,
      )
    }
  }
  if (cells.length === 0) {
    throw new Error(
      `npm search for ${keywordQuery([keyword])} reports more than the ${SEARCH_WINDOW} names one query can reach (from is capped at ${MAX_SEARCH_FROM}) and no refinement keyword splits it; add one to PARTITION_KEYWORDS`,
    )
  }
  return { cells, total, partitioned: true }
}

/** The two fields the harvest reads off a search response. */
interface SearchBody {
  objects?: { package?: { name?: unknown } }[]
  total?: unknown
}

/**
 * Parse one search response, naming the query on a body that is not JSON.
 * Observed live: page 13 of `keywords:dsh-plugin` answered 200 with
 * `<!doctype html>`, and the bare `SyntaxError` named no keyword.
 */
async function readSearchBody(response: Response, query: string, from: number): Promise<SearchBody> {
  try {
    return await response.json() as SearchBody
  } catch {
    throw new Error(`npm search for ${query} at from=${from} answered 200 with a body that is not JSON`)
  }
}

/** Read one query's `total` with a single-object request. */
async function searchTotal(
  keywords: readonly string[],
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  backupRegistry: string | undefined,
  timeoutMs: number,
): Promise<number> {
  const query = keywordQuery(keywords)
  const path = `-/v1/search?text=${encodeURIComponent(query)}&size=1&from=0`
  const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
  if (!response.ok) throw new Error(`npm search for ${query} failed: ${response.status}`)
  const body = await readSearchBody(response, query, 0)
  return typeof body.total === 'number' ? body.total : 0
}
```

**3b.** Delete lines 91-99 entirely — the `MAX_SEARCH_PAGES` doc comment and constant:

```ts
/**
 * Upper bound on the number of search pages fetched per keyword by {@link searchByKeywords}.
 * Guards against an unbounded loop issuing endless requests against a public
 * API if the registry ever kept returning full pages: at `PAGE_SIZE` names
 * per page this bound covers catalog sizes far beyond the ecosystem's current
 * scale, so hitting it means the harvest is broken, not that the ecosystem
 * grew.
 */
const MAX_SEARCH_PAGES = 100
```

The window bound replaces it: `MAX_SEARCH_FROM` is what the registry actually enforces, so the loop can no longer reach a page bound without first tripping a correct diagnosis.

**3c.** Replace the body of `searchByKeywords` (`:282-310`). Before:

```ts
export async function searchByKeywords(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string[]> {
  const seen = new Set<string>()
  for (const keyword of HARVEST_KEYWORDS) {
    for (let page = 0; ; page += 1) {
      if (page >= MAX_SEARCH_PAGES) {
        throw new Error(
          `npm search for keywords:${keyword} exceeded ${MAX_SEARCH_PAGES} pages (${MAX_SEARCH_PAGES * PAGE_SIZE} names) without completing; harvest is incomplete`,
        )
      }
      const from = page * PAGE_SIZE
      const path = `-/v1/search?text=keywords:${keyword}&size=${PAGE_SIZE}&from=${from}`
      const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
      if (!response.ok) throw new Error(`npm search for keywords:${keyword} failed: ${response.status}`)
      const body = await response.json() as { objects?: { package?: { name?: unknown } }[] }
      const objects = body.objects ?? []
      for (const object of objects) {
        if (typeof object.package?.name === 'string') seen.add(object.package.name)
      }
      if (objects.length < PAGE_SIZE) break
    }
  }
  return [...seen].sort()
}
```

After:

```ts
export async function searchByKeywords(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<string[]> {
  const seen = new Set<string>()
  const probe = (keywords: readonly string[]): Promise<number> =>
    searchTotal(keywords, fetchImpl, sleep, token, backupRegistry, timeoutMs)
  for (const keyword of HARVEST_KEYWORDS) {
    const { cells, total, partitioned } = await partitionKeyword(keyword, probe)
    const forKeyword = new Set<string>()
    for (const cell of cells) {
      const query = keywordQuery(cell)
      for (let from = 0; ; from += PAGE_SIZE) {
        if (from > MAX_SEARCH_FROM) {
          throw new Error(
            `npm search for ${query} needs from=${from}, past the ${MAX_SEARCH_FROM} the registry honors (a larger from silently returns page 0); the partition is wrong`,
          )
        }
        const path = `-/v1/search?text=${encodeURIComponent(query)}&size=${PAGE_SIZE}&from=${from}`
        const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
        if (!response.ok) throw new Error(`npm search for ${query} failed: ${response.status}`)
        const body = await readSearchBody(response, query, from)
        const objects = body.objects ?? []
        for (const object of objects) {
          if (typeof object.package?.name === 'string') {
            seen.add(object.package.name)
            forKeyword.add(object.package.name)
          }
        }
        // Stop on the total the registry answered, NEVER on a short page: npm
        // has served a 249-object page of a 600-name result set, and breaking
        // there dropped every later page of that keyword in silence.
        const cellTotal = typeof body.total === 'number' ? body.total : 0
        if (objects.length === 0 || from + objects.length >= cellTotal) break
      }
    }
    if (partitioned) {
      // The API has no complement operator, so a partition's coverage is
      // measured rather than assumed. `min` of the totals before and after
      // absorbs a package published or unpublished during the run; a genuine
      // partition gap is hundreds of names and still throws.
      const after = await probe([keyword])
      const required = Math.min(total, after)
      if (forKeyword.size < required) {
        throw new Error(
          `npm search for ${keywordQuery([keyword])} enumerated ${forKeyword.size} of ${required} names across ${cells.length} partition cell(s); the refinement keywords do not cover the keyword, so the harvest would be silently short`,
        )
      }
    }
  }
  return [...seen].sort()
}
```

Also update the `@throws` line of the `searchByKeywords` doc comment (`:278-281`). Before:

```ts
 * @throws when the registry answers with a non-OK status after the 429
 *   retries are exhausted, or when more than {@link MAX_SEARCH_PAGES} pages
 *   are fetched for one keyword without its search completing.
```

After:

```ts
 * @throws when the registry answers with a non-OK status after the 429
 *   retries are exhausted; when a keyword's total is past {@link
 *   SEARCH_WINDOW} and no refinement keyword splits it; when a cell would
 *   need a `from` past {@link MAX_SEARCH_FROM}; or when a partition's cells
 *   enumerate fewer names than the keyword's own total.
```

Finally, rewrite the now-obsolete test at `npm-client.test.ts:430-440`. It asserted the removed page bound; the window bound replaces it with a message that names the real cause. Before:

```ts
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
```

After (the `MAX_SEARCH_PAGES` bound is gone; a body with no `total` reads as `total: 0`, which now ends the cell on the first page, so the endless-page case is reached through the window instead — covered by "refuses to ask for a from past the window" above):

```ts
  it('ends a cell rather than paging forever when the registry answers no total', async () => {
    // The old MAX_SEARCH_PAGES bound is gone: a response carrying no `total`
    // reads as 0, which is `from + objects.length >= 0` on the first page, so
    // the loop cannot run away. Paging past the window is the case that
    // throws, and it is pinned by "refuses to ask for a from past the window".
    let call = 0
    const fetchImpl = (async () => {
      call += 1
      const body = { objects: Array.from({ length: 250 }, (_, i) => ({ package: { name: `dsh-forever-${i}` } })) }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch

    const names = await searchByKeywords(fetchImpl)
    expect(names).toHaveLength(250)
    expect(call).toBe(4) // one probe plus one page, per keyword
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts`
Expected: PASS

Then: `pnpm test` (expected 22 files, 339 tests green — 334 plus the five new ones; the rewritten page-bound test replaces one in place and does not change the count) and `pnpm typecheck` (clean).

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "fix(registry): read the search total, partition past the window, never end a keyword on a short page

The registry silently resets from>5000 to page 0, so the old loop received
full duplicate pages, deduplicated them, and died at MAX_SEARCH_PAGES with
the wrong diagnosis after 100 wasted requests. keywords:deepseek-harness is
at 5,095 of the 5,250 one query can reach.

searchByKeywords now reads body.total, partitions an over-window keyword on
keywords:a,b intersections (the only filtering qualifier the API honors --
probed: no negation, no scope/author/maintainer, a text term and the ranking
weights change neither the total nor the ordering), measures the partition's
coverage against the keyword's total and throws on a shortfall, and breaks a
cell on the answered total instead of on a short page."
```

---

### Task 2: D-2 / A-5 with H-2 — one unreachable packument becomes a `fetch-failed` row, and the classify harvest gets its backup registry

**Files:**
- Modify: `registry/scripts/src/npm-client.ts:332-378` (`fetchCandidate`, `fetchCandidates`)
- Modify: `registry/scripts/src/classify.ts:40-45`
- Test: `registry/scripts/tests/npm-client.test.ts` (two obsolete tests rewritten at `:585-598`, four added)

**Interfaces:**
- Consumes: `keywordQuery`, `MAX_SEARCH_FROM`, `SEARCH_WINDOW` from Task 1 (unused here, but Task 1's file must be in place); `CandidateResult = { ok: true; candidate: Candidate } | { ok: false; detail: string }` (`npm-client.ts:318`); `Rejection` (`types.ts:132`)
- Produces:
  - `fetchCandidate` keeps its signature and **never throws** on a transport failure — it returns `{ ok: false, detail }`
  - `fetchCandidates(names, fetchImpl?, token?, backupRegistry?, sleep?, timeoutMs?)` — two optional parameters appended, so the existing positional call sites in `build.ts:62` and `classify.ts:45` are unaffected

- [ ] **Step 1: Write the failing test**

Append a new `describe` block to `registry/scripts/tests/npm-client.test.ts`, and rewrite the two failover tests quoted in Step 3. Add `fetchCandidates` to the import on line 2, which currently reads:

```ts
import { fetchCandidate, HARVEST_KEYWORDS, PEERS_MAX_COUNT, searchByKeywords, toCandidate } from '../src/npm-client.ts'
```

```ts
describe('fetchCandidates', () => {
  const noSleep = async (_ms: number) => {}
  const packument = {
    name: 'good',
    'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': '2026-08-01T12:00:00.000Z' },
    versions: { '1.0.0': { dist: { integrity: 'sha512-x' }, license: 'MIT' } },
  }

  it('records a 500 as a fetch-failed row and still returns the other candidate', async () => {
    // H-2: no test ever called fetchCandidates, so mislabelling the code and
    // dropping the rejection entirely both survived the suite.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) return new Response('server error', { status: 500 })
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(['good', 'bad'], fetchImpl, undefined, undefined, noSleep)
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toEqual([
      { name: 'bad', code: 'fetch-failed', detail: 'npm registry returned 500 fetching bad' },
    ])
  })

  it('records a network throw as a fetch-failed row naming the cause', async () => {
    // D-2: Promise.all over a throwing fetchCandidate rejected the whole
    // harvest of ~5,600 packuments on one ECONNRESET.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) throw new Error('read ECONNRESET')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(['good', 'bad'], fetchImpl, undefined, undefined, noSleep)
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.code).toBe('fetch-failed')
    expect(rejections[0]?.detail).toBe('bad: could not reach the npm registry (read ECONNRESET)')
  })

  it('records a stalled connection as a fetch-failed row naming the timeout', async () => {
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).endsWith('/bad')) return new Promise<Response>(() => {})
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(['good', 'bad'], fetchImpl, undefined, undefined, noSleep, 50)
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections[0]?.detail).toBe('bad: the npm registry did not answer within 50ms')
  })

  it('fetches through the backup registry when one is configured', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const { candidates, rejections } = await fetchCandidates(
      ['good'], fetchImpl, undefined, 'https://registry.npmmirror.com', noSleep,
    )
    expect(candidates.map(c => c.name)).toEqual(['good'])
    expect(rejections).toEqual([])
    expect(urls[1]).toContain('registry.npmmirror.com')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "fetchCandidates"`
Expected: FAIL — the first test fails to compile/import nothing, but the second fails at runtime with `Error: read ECONNRESET` propagating out of `fetchCandidates` (the `Promise.all` rejects), and the third hangs to the 30 s default and then throws `FetchTimeoutError: registry request exceeded 30000ms` because `fetchCandidates` accepts no `timeoutMs`. Expect a TypeScript error too: `Expected 4 arguments, but got 6.`

- [ ] **Step 3: Write the implementation**

**3a.** `registry/scripts/src/npm-client.ts` — catch in `fetchCandidate`. Before (`:339-341`):

```ts
): Promise<CandidateResult> {
  const response = await fetchWithFailover(encodeURIComponent(name), fetchImpl, sleep, token, backupRegistry, timeoutMs)
  if (!response.ok) return { ok: false, detail: `npm registry returned ${response.status} fetching ${name}` }
```

After:

```ts
): Promise<CandidateResult> {
  let response: Response
  try {
    response = await fetchWithFailover(encodeURIComponent(name), fetchImpl, sleep, token, backupRegistry, timeoutMs)
  } catch (error) {
    // One unreachable packument must never abort a harvest of thousands.
    // CLAUDE.md: "a package that cannot be fetched becomes a fetch-failed
    // rejection in the build report. Nothing disappears without a reason
    // attached to its name." Before this catch that held only for HTTP-status
    // failures: one ECONNRESET or one 30s stall rejected the whole harvest.
    // The detail names the TRUE cause, because an author reads it to find out
    // why their package is missing.
    const detail = error instanceof FetchTimeoutError
      ? `${name}: the npm registry did not answer within ${timeoutMs}ms`
      : `${name}: could not reach the npm registry (${error instanceof Error ? error.message : String(error)})`
    return { ok: false, detail }
  }
  if (!response.ok) return { ok: false, detail: `npm registry returned ${response.status} fetching ${name}` }
```

Also update `fetchCandidate`'s `@returns` (`:328-330`). Before:

```ts
 * @returns the candidate, or the reason none could be produced. A 429 is
 *   retried a bounded number of times before it becomes a rejection, so a
 *   rate-limited runner does not reject the whole ecosystem at once.
```

After:

```ts
 * @returns the candidate, or the reason none could be produced. NEVER throws:
 *   a 429 is retried a bounded number of times, and a transport failure
 *   (network error, stall, or an exhausted failover) becomes a rejection whose
 *   detail names that cause — one dead packument out of thousands must not
 *   take the daily catalog down with it.
```

**3b.** `registry/scripts/src/npm-client.ts` — `fetchCandidates` gains `sleep` and `timeoutMs`. Before (`:361-378`):

```ts
export async function fetchCandidates(
  names: string[],
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
): Promise<{ candidates: Candidate[]; rejections: Rejection[] }> {
  const candidates: Candidate[] = []
  const rejections: Rejection[] = []
  for (let i = 0; i < names.length; i += HARVEST_CONCURRENCY) {
    const batch = names.slice(i, i + HARVEST_CONCURRENCY)
    const results = await Promise.all(batch.map(async name => ({ name, result: await fetchCandidate(name, fetchImpl, undefined, token, backupRegistry) })))
    for (const { name, result } of results) {
      if (result.ok) candidates.push(result.candidate)
      else rejections.push({ name, code: 'fetch-failed', detail: result.detail })
    }
  }
  return { candidates, rejections }
}
```

After:

```ts
export async function fetchCandidates(
  names: string[],
  fetchImpl: typeof fetch = fetch,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ candidates: Candidate[]; rejections: Rejection[] }> {
  const candidates: Candidate[] = []
  const rejections: Rejection[] = []
  for (let i = 0; i < names.length; i += HARVEST_CONCURRENCY) {
    const batch = names.slice(i, i + HARVEST_CONCURRENCY)
    // `fetchCandidate` never throws, so `Promise.all` can no longer reject:
    // every name lands as a candidate or as a rejection carrying its reason.
    const results = await Promise.all(batch.map(async name => ({
      name,
      result: await fetchCandidate(name, fetchImpl, sleep, token, backupRegistry, timeoutMs),
    })))
    for (const { name, result } of results) {
      if (result.ok) candidates.push(result.candidate)
      else rejections.push({ name, code: 'fetch-failed', detail: result.detail })
    }
  }
  return { candidates, rejections }
}
```

**3c.** `registry/scripts/src/classify.ts` — give the production harvest the backup registry it was designed with. Before (`:40-45`):

```ts
const npmToken = process.env.NPM_TOKEN

const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeywords(fetch, undefined, npmToken)
process.stderr.write(`classify: harvested ${names.length} candidate(s)\n`)
const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken)
```

After:

```ts
const npmToken = process.env.NPM_TOKEN

// The daily harvest runs HERE, not in build.ts: the workflow passes
// `--harvest-from dist/v1/harvest.json` so the ecosystem is fetched once. That
// made the mirror failover from the 2026-08-31 hub-borrowings design (C) dead
// code in production — build.ts had it and this path did not. Same default and
// same disable value as build.ts; an empty string means no backup.
const npmBackupRegistry = process.env.NPM_BACKUP_REGISTRY ?? 'https://registry.npmmirror.com'

const config = loadRegistryConfig(REGISTRY_DIR)
const names = await searchByKeywords(fetch, undefined, npmToken, npmBackupRegistry)
process.stderr.write(`classify: harvested ${names.length} candidate(s)\n`)
const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken, npmBackupRegistry)
```

**3d.** Rewrite the two now-obsolete failover tests. They pinned exactly the behavior D-2 removes: a throw where the invariant requires a `fetch-failed` row. Before (`npm-client.test.ts:585-598`):

```ts
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
```

After:

```ts
  it('reports the primary failure in the detail when the backup also fails', async () => {
    // Changed with D-2: this asserted a THROW, which is what took the whole
    // harvest down on one dead packument. The primary's failure is still what
    // is reported — a mirror's opinion must never masquerade as npm's — but it
    // now arrives as the row CLAUDE.md requires instead of as an abort.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response('not found', { status: 404 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, 'https://registry.npmmirror.com')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })

  it('reports the throw as a rejection when no backup registry is configured', async () => {
    // Same change of shape, same reason: a rejection with a truthful cause,
    // not an abort. searchByKeywords still THROWS on a failed search — a
    // partial keyword list is indistinguishable from a shrunken ecosystem.
    const fetchImpl = (async () => { throw new Error('primary down') }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts`
Expected: PASS

Then: `pnpm test` and `pnpm typecheck`.

Mutation check (required): copy `npm-client.ts` to the scratchpad, change `code: 'fetch-failed'` to `code: 'no-bundle'`, point a copy of the new test at it, and confirm the first test fails. Then delete the `else rejections.push(...)` line and confirm it fails again. Both mutations survived the suite at HEAD.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/src/classify.ts registry/scripts/tests/npm-client.test.ts
git commit -m "fix(registry): a dead packument becomes a fetch-failed row, not an aborted harvest

fetchWithFailover rethrows when there is no backup or the backup also fails;
fetchCandidate did not catch it and fetchCandidates uses Promise.all, so one
ECONNRESET or one 30s stall on one of ~5,600 packuments rejected the whole
build with no row for the name. CLAUDE.md's fetch-failed guarantee held only
for HTTP-status failures.

fetchCandidate now returns { ok: false, detail } naming the true cause
(timeout, network, status), fetchCandidates takes sleep and timeoutMs so the
path is testable, and classify.ts -- the harvest the daily workflow actually
runs -- gets the backup registry that until now only build.ts had.

Closes the H-2 test gap: fetchCandidates had no test at all."
```

---

### Task 3: D-6 — the npm token stops at the primary, and an empty `NPM_BACKUP_REGISTRY` disables the backup instead of crashing

**Files:**
- Modify: `registry/scripts/src/npm-client.ts:61-89` (`fetchWithFailover`)
- Modify: `registry/scripts/src/build.ts:46-51` (comment only)
- Test: `registry/scripts/tests/npm-client.test.ts` (two added, inside `describe('registry failover', …)`)

**Interfaces:**
- Consumes: `fetchCandidate` from Task 2 — the empty-string test asserts a `{ ok: false }` result, which only exists after Task 2
- Produces: `fetchWithFailover` unchanged in signature; `backupRegistry === ''` now behaves exactly as `undefined`, and the backup call carries no `Authorization` header

**Scope note.** D-6's third sub-fix — "never fail over a paged search" — is deliberately **not** in this task. It contradicts the passing test at `npm-client.test.ts:600` ("searches through the failover too"), and Task 1's coverage check now makes a mid-pagination source switch loud rather than silent (a mixed index enumerates fewer distinct names than the keyword's total and throws). Deferred to WP3 with that reason.

- [ ] **Step 1: Write the failing test**

```ts
  it('never sends the npm token to the backup registry', async () => {
    // The token is an npmjs.org credential. Forwarding it to a third-party
    // mirror hands that mirror a Bearer token it was never issued; the fixture
    // recorded `registry.npmmirror.com auth=Bearer npm_...` going out.
    const seen: { url: string; auth: string | null }[] = []
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({ url: String(url), auth: headers.get('authorization') })
      if (String(url).startsWith('https://registry.npmjs.org')) throw new Error('primary down')
      return new Response(JSON.stringify(packument), { status: 200 })
    }) as unknown as typeof fetch
    const result = await fetchCandidate(
      'dsh-failover', fetchImpl, noSleep, 'npm_readonly_token', 'https://registry.npmmirror.com',
    )
    expect(result.ok).toBe(true)
    expect(seen[0]?.auth).toBe('Bearer npm_readonly_token') // the primary gets it
    expect(seen[1]?.url).toContain('registry.npmmirror.com')
    expect(seen[1]?.auth).toBe(null) // the backup does not
  })

  it('treats an empty backup registry as disabled rather than building /name', async () => {
    // The documented disable value is an empty string, but the guard tested
    // for `undefined`: registryUrl('', 'x') is '/x', and the first primary
    // failure died with `Failed to parse URL` instead of reporting the
    // primary's own failure.
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      throw new Error('primary down')
    }) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-failover', fetchImpl, noSleep, undefined, '')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toBe('dsh-failover: could not reach the npm registry (primary down)')
    expect(urls).toEqual(['https://registry.npmjs.org/dsh-failover'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "never sends the npm token to the backup registry"`
Expected: FAIL — `AssertionError: expected 'Bearer npm_readonly_token' to be null`. The second test fails with `TypeError: Failed to parse URL from /dsh-failover`.

- [ ] **Step 3: Write the implementation**

`registry/scripts/src/npm-client.ts`. Before (`:52-89`):

```ts
/**
 * Fetch a registry path with a backup registry absorbing ONLY
 * unavailability: a network throw, a stalled connection (the per-attempt
 * timeout), or a 5xx. A 4xx answer from the primary is authoritative and is
 * returned as-is — a 404 is never re-litigated against a mirror, and an
 * exhausted 429 reports the throttle rather than quietly switching source.
 * When the backup also fails, the primary's failure is what propagates: a
 * mirror's opinion must never masquerade as npm's.
 */
async function fetchWithFailover(
  path: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  backupRegistry: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timed = withTimeout(fetchImpl, timeoutMs)
  let primary: Response | null = null
  let primaryError: unknown = undefined
  try {
    primary = await fetchWithRetry(registryUrl(REGISTRY, path), timed, sleep, token)
    if (primary.ok || primary.status < 500) return primary
    primaryError = new Error(`npm registry returned ${primary.status}`)
  } catch (error) {
    primaryError = error
  }
  if (backupRegistry === undefined) {
    // No backup configured: behave exactly as before — the 5xx response
    // returns to the caller (whose contextual error names the keyword), a
    // network throw propagates.
    if (primary !== null) return primary
    throw primaryError
  }
  const backup = await fetchWithRetry(registryUrl(backupRegistry, path), timed, sleep, token)
  if (!backup.ok) throw primaryError
  return backup
}
```

After:

```ts
/**
 * Fetch a registry path with a backup registry absorbing ONLY
 * unavailability: a network throw, a stalled connection (the per-attempt
 * timeout), or a 5xx. A 4xx answer from the primary is authoritative and is
 * returned as-is — a 404 is never re-litigated against a mirror, and an
 * exhausted 429 reports the throttle rather than quietly switching source.
 * When the backup also fails, the primary's failure is what propagates: a
 * mirror's opinion must never masquerade as npm's.
 *
 * The token reaches {@link REGISTRY} and nowhere else. It is an npmjs.org
 * credential; `NPM_BACKUP_REGISTRY` may be any URL, so forwarding it would
 * hand a third party a Bearer token it was never issued. The backup is a
 * read-only public mirror and needs none.
 *
 * An EMPTY backup registry is disabled, not a registry at the filesystem
 * root: `registryUrl('', 'x')` is `/x`, and the documented disable value (an
 * empty string, build.ts) used to die with `Failed to parse URL` on the first
 * primary failure instead of reporting that failure.
 */
async function fetchWithFailover(
  path: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  backupRegistry: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  const timed = withTimeout(fetchImpl, timeoutMs)
  const backup = backupRegistry === undefined || backupRegistry.trim() === '' ? undefined : backupRegistry
  let primary: Response | null = null
  let primaryError: unknown = undefined
  try {
    primary = await fetchWithRetry(registryUrl(REGISTRY, path), timed, sleep, token)
    if (primary.ok || primary.status < 500) return primary
    primaryError = new Error(`npm registry returned ${primary.status}`)
  } catch (error) {
    primaryError = error
  }
  if (backup === undefined) {
    // No backup configured: behave exactly as before — the 5xx response
    // returns to the caller (whose contextual error names the keyword), a
    // network throw propagates.
    if (primary !== null) return primary
    throw primaryError
  }
  const backupResponse = await fetchWithRetry(registryUrl(backup, path), timed, sleep, undefined)
  if (!backupResponse.ok) throw primaryError
  return backupResponse
}
```

`registry/scripts/src/build.ts` — make the comment say what the code now does. Before (`:46-51`):

```ts
// The backup registry the fetch layer fails over to on unavailability only
// (network throw, stalled connection, 5xx — never a 404). Read-only: the
// install path still runs through the user's own pnpm and registry config.
// Default-on per the 2026-08-31 hub-borrowings design (C); set
// NPM_BACKUP_REGISTRY to an empty string to disable.
const npmBackupRegistry = process.env.NPM_BACKUP_REGISTRY ?? 'https://registry.npmmirror.com'
```

After:

```ts
// The backup registry the fetch layer fails over to on unavailability only
// (network throw, stalled connection, 5xx — never a 404). Read-only: the
// install path still runs through the user's own pnpm and registry config, and
// NPM_TOKEN never travels here — it is an npmjs.org credential and this URL is
// operator-supplied. Default-on per the 2026-08-31 hub-borrowings design (C);
// an empty string disables it, which fetchWithFailover now honors.
const npmBackupRegistry = process.env.NPM_BACKUP_REGISTRY ?? 'https://registry.npmmirror.com'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts`
Expected: PASS

Then: `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/src/build.ts registry/scripts/tests/npm-client.test.ts
git commit -m "fix(registry): keep the npm token off the backup mirror, honor the empty-string disable

fetchWithFailover forwarded NPM_TOKEN to NPM_BACKUP_REGISTRY, an
operator-supplied URL that defaults to a third party. The token reaches
registry.npmjs.org and nowhere else now.

The documented disable value is an empty string, but the guard tested for
undefined: registryUrl('', 'x') is '/x', so NPM_BACKUP_REGISTRY= died with
'Failed to parse URL' on the first primary failure instead of reporting it.
An empty or whitespace value is now disabled.

Not included: the paged-search failover ban, which contradicts a passing test
and is made loud by the new coverage check -- deferred to WP3."
```

---

### Task 4: A-3 / E-3 — JSON-escape every name the bot writes, and validate a GitHub manifest name at the boundary

**Files:**
- Modify: `registry/scripts/src/categories.ts:29-42` (`serializeCategoryRows`)
- Modify: `registry/scripts/src/config.ts:183-198` (`serializeFirstSeen`)
- Modify: `registry/scripts/src/github-client.ts:418-451` (`projectCandidate`), `:511-562` (`fetchRepoCandidate`)
- Test: `registry/scripts/tests/categories.test.ts`, `registry/scripts/tests/config.test.ts`, `registry/scripts/tests/github-client.test.ts`

**Interfaces:**
- Consumes: `serializeCategoryRows(rows: ReadonlyMap<string, Category>): string`; `serializeFirstSeen(rows: ReadonlyMap<string, string>): string`; `RepoFetchResult = { ok: true; candidates: RepoCandidate[] } | { ok: false; code: 'no-manifest' | 'fetch-failed'; detail: string }` (`github-client.ts:69`)
- Produces:
  - `export const BUNDLE_NAME_MAX_LENGTH = 214`
  - `export const BUNDLE_NAME_RE: RegExp`
  - `export function isBundleName(value: unknown): value is string`
  - Both serializers emit `- name: <JSON.stringify(name)>`; signatures unchanged

**Ship-together rule.** This task and Task 5 must land in the same push. Task 5 starts committing `first-seen.yml`, and `first-seen.yml` receives **every repo candidate name, gated or not** (`build.ts:215`) — so committing it before this task commits whatever name the next hostile repository chooses, and every later build throws on the file it wrote itself. Do not push Task 5's commit unless this task's commit precedes it in the same push.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/categories.test.ts` (inside `describe('serializeCategoryRows', …)`):

```ts
  it('round-trips the four hostile-name probes through serialise then parse', () => {
    // GitHub manifest names are unrestricted and reach BOTH bot-written files.
    // The comment justifying `- name: "${name}"` claimed npm names never carry
    // `"` or `\` — true for npm, false for a repo manifest. Each probe below
    // was run against the real serialiser: the first is a YAMLParseError, the
    // second forges a second row and throws `duplicate entry for dsh-victim`,
    // the third parses with the name silently altered, the fourth parses as
    // `dsh-b` and overwrites another package's row.
    const probes = [
      'dsh-"quote',
      'dsh-a"\n  category: tool\n- name: "dsh-victim',
      'dsh-trailing\\',
      'dsh-b" # comment',
    ]
    const rows = new Map<string, 'tool'>(probes.map(name => [name, 'tool' as const]))
    const parsed = parse(serializeCategoryRows(rows)) as { name: string; category: string }[]
    expect(parsed).toHaveLength(4)
    expect(parsed.map(row => row.name).sort()).toEqual([...probes].sort())
    expect(parsed.every(row => row.category === 'tool')).toBe(true)
  })
```

Append to `registry/scripts/tests/config.test.ts` (inside `describe('serializeFirstSeen', …)`), and add `import { parse } from 'yaml'` to that file's imports:

```ts
  it('round-trips the four hostile-name probes through serialise then parse', () => {
    // first-seen.yml receives EVERY harvested repo candidate name, gated or
    // not (build.ts), so it is the first of the two bot-written files a
    // hostile manifest name reaches. An unescaped `"` made every subsequent
    // build throw in loadRegistryConfig until a human edited the file.
    const probes = [
      'dsh-"quote',
      'dsh-a"\n  added: 2026-01-01\n- name: "dsh-victim',
      'dsh-trailing\\',
      'dsh-b" # comment',
    ]
    const rows = new Map(probes.map(name => [name, '2026-09-03']))
    const text = serializeFirstSeen(rows)
    const parsed = parse(text) as { name: string; added: string }[]
    expect(parsed).toHaveLength(4)
    expect(parsed.map(row => row.name).sort()).toEqual([...probes].sort())
    // And the loader accepts what the serialiser wrote — the property that
    // actually broke: the next build reads this file.
    const config = parseRegistryConfig({ ...empty, firstSeen: text })
    expect(config.firstSeen.size).toBe(4)
  })
```

Append to `registry/scripts/tests/github-client.test.ts` (inside `describe('fetchRepoCandidate', …)`):

```ts
  it('rejects a manifest name outside the package-name grammar, with its own detail', async () => {
    // `projectCandidate` accepted any non-empty string and `gateRepo` never
    // checked the shape, so `Skills Manager` and `{{PKG_NAME}}` are already in
    // the committed repo-state. A name carrying a quote, a newline, a space or
    // a backslash is what breaks the two bot-written YAML files.
    for (const name of ['dsh-"quote', 'dsh-a"\n  category: tool', 'dsh-trailing\\', 'dsh-b" # comment', 'Skills Manager', '{{PKG_NAME}}']) {
      const fetchImpl = stubFetch({
        'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
          name,
          dsh: { bundle: { patch: './cordis.patch.yml' } },
        }), { status: 200 }),
        'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
          sha: commit,
          commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
        }), { status: 200 }),
      })
      const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe('no-manifest')
        expect(result.detail).toContain('is not a usable package name')
      }
    }
  })

  it('still accepts an uppercase manifest name — a bundle name is not an npm publication', async () => {
    // npm forbids uppercase in a NEW publication; a GitHub bundle name is not
    // one, and rejecting DSH-FS-TOOL would drop a repository that installs
    // fine. Case folding on the repo channel is B-8's job, not this gate's.
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(JSON.stringify({
        name: 'DSH-FS-TOOL',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      }), { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit,
        commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.candidates[0]?.name).toBe('DSH-FS-TOOL')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/categories.test.ts registry/scripts/tests/config.test.ts registry/scripts/tests/github-client.test.ts`
Expected: FAIL — the categories probe fails with `YAMLParseError: Unexpected scalar at node end at line 4, column 15`; the first-seen probe fails with `Error: first-seen.yml: duplicate entry for dsh-victim`; the github grammar test fails with `expected true to be false` (the hostile names are accepted).

- [ ] **Step 3: Write the implementation**

**3a.** `registry/scripts/src/categories.ts`. Before (`:29-36`):

```ts
/** Serialize rows to the file text: header, sorted rows, trailing newline. */
export function serializeCategoryRows(rows: ReadonlyMap<string, Category>): string {
  // Names are ALWAYS double-quoted: npm scoped names start with `@`, which
  // YAML forbids at the start of a plain scalar — an unquoted `@scope/pkg`
  // row parses as YAMLParseError, so the file this step writes could not be
  // read back by the loader (regression: the backfill's own output). npm
  // names never contain `"` or `\`, so double quotes need no escaping.
  const rowsText = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, category]) => `- name: "${name}"\n  category: ${category}`)
```

After:

```ts
/** Serialize rows to the file text: header, sorted rows, trailing newline. */
export function serializeCategoryRows(rows: ReadonlyMap<string, Category>): string {
  // Names are ALWAYS JSON-quoted: npm scoped names start with `@`, which YAML
  // forbids at the start of a plain scalar — an unquoted `@scope/pkg` row
  // parses as YAMLParseError, so the file this step writes could not be read
  // back by the loader (regression: the backfill's own output).
  //
  // JSON syntax, not bare double quotes: the previous comment claimed npm
  // names never contain `"` or `\`, which is true of npm and false of a GITHUB
  // manifest name, and both kinds reach this file. `dsh-"quote` produced
  // `Unexpected scalar at node end`; `dsh-a"\n  category: tool\n- name:
  // "dsh-victim` forged a second row and threw `duplicate entry for
  // dsh-victim` on every later build; `dsh-b" # comment` silently overwrote
  // another package's row. JSON string syntax is valid YAML and handles all of
  // it, exactly as markets.ts already does.
  const rowsText = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([name, category]) => `- name: ${JSON.stringify(name)}\n  category: ${category}`)
```

**3b.** `registry/scripts/src/config.ts`. Before (`:183-191`):

```ts
/**
 * Serialize the first-seen file: header, sorted rows, trailing newline.
 * Names are always double-quoted because scoped names start with `@`, which
 * YAML would otherwise read as a tag.
 */
export function serializeFirstSeen(rows: ReadonlyMap<string, string>): string {
  const rowsText = [...rows]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, added]) => `- name: "${name}"\n  added: ${added}`)
```

After:

```ts
/**
 * Serialize the first-seen file: header, sorted rows, trailing newline.
 *
 * Names are always JSON-quoted. Quoting at all is because a scoped name starts
 * with `@`, which YAML would otherwise read as a tag; JSON escaping rather
 * than bare double quotes is because this file receives EVERY harvested repo
 * candidate name, gated or not (build.ts), and a GitHub manifest name is
 * unrestricted. An unescaped `"` in one made `loadRegistryConfig` throw on
 * every subsequent build until a human edited the file by hand.
 */
export function serializeFirstSeen(rows: ReadonlyMap<string, string>): string {
  const rowsText = [...rows]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, added]) => `- name: ${JSON.stringify(name)}\n  added: ${added}`)
```

**3c.** `registry/scripts/src/github-client.ts` — add the grammar next to `MAX_TARBALL_BYTES` (after `:40`):

```ts
/**
 * The longest bundle name accepted from a repository manifest, npm's own
 * limit. A name reaches `first-seen.yml`, `categories.yml`, `markets.yml`,
 * `manifest.lock`, the published entry and the build report, so an unbounded
 * one is a bloat vector in six places at once.
 */
export const BUNDLE_NAME_MAX_LENGTH = 214

/**
 * The package-name grammar a repository's manifest `name` must satisfy: an
 * optional `@scope/`, then url-safe characters, never leading with a dot or an
 * underscore. This is npm's grammar minus its lowercase-only rule for a NEW
 * publication — a GitHub bundle name is not an npm publication, and rejecting
 * `DSH-FS-TOOL` would drop a repository that installs fine (case folding on
 * this channel is repo-gate's job; see B-8). Everything the grammar excludes
 * is what broke the bot-written YAML: whitespace, quotes, backslashes,
 * newlines, `#`, and braces. `Skills Manager` and `{{PKG_NAME}}` are both
 * already in the committed repo-state.
 */
export const BUNDLE_NAME_RE = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Whether an untrusted manifest `name` is a usable bundle name. */
export function isBundleName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= BUNDLE_NAME_MAX_LENGTH
    && BUNDLE_NAME_RE.test(value)
}
```

Then in `projectCandidate`, before (`:434-437`):

```ts
  const scripts = typeof m.scripts === 'object' && m.scripts !== null ? m.scripts : {}
  if (typeof m.name !== 'string' || m.name === '') return null
  return {
    name: m.name,
```

After:

```ts
  const scripts = typeof m.scripts === 'object' && m.scripts !== null ? m.scripts : {}
  // The shape check is HERE, at the projection boundary, so no candidate with
  // an unusable name ever exists — not in the gate, not in repo-state.json,
  // not in the two bot-written YAML files. A subpackage with a bad name is
  // dropped silently, the same way a bundle-less subpackage is; the ROOT gets
  // an author-readable rejection in fetchRepoCandidate below.
  if (!isBundleName(m.name)) return null
  return {
    name: m.name,
```

And in `fetchRepoCandidate`, before (`:541-558`):

```ts
  const root = projectCandidate(meta, manifest, head, undefined)
  // The rescue probe: only a `requires-build` root can be rescued, so only it
  // is probed. The release rides the candidate through the state file, so a
  // repo with no release does not re-consume this budget daily.
  if (root !== null && root.requiresBuild) {
    const release = await fetchLatestReleaseTarball(owner, slug, fetchImpl, sleep, token)
    if (release !== null) root.release = release
  }
  if (root !== null && root.hasBundle) {
    return { ok: true, candidates: [root] }
  }
  if (probeSubpackages && monorepoSignal(manifest)) {
    const subs = await probeSubpackageCandidates(owner, slug, meta, manifest, head, fetchImpl, sleep, token)
    if (subs.length > 0) return { ok: true, candidates: subs }
  }
  if (root === null) {
    return { ok: false, code: 'no-manifest', detail: 'package.json declares no name and no installable subpackage, so dsh has nothing to register.' }
  }
```

After:

```ts
  // A root name outside the grammar gets its OWN detail: "declares no name" is
  // a different and misattributed fact, and a wrong published reason is a
  // defect. The check runs before the release probe so a bad name costs no
  // extra request.
  const rawRootName = (manifest as { name?: unknown } | null)?.name
  if (rawRootName !== undefined && rawRootName !== null && !isBundleName(rawRootName)) {
    const shown = typeof rawRootName === 'string'
      ? JSON.stringify(rawRootName.slice(0, 80))
      : `a ${typeof rawRootName}`
    return {
      ok: false,
      code: 'no-manifest',
      detail: `package.json declares ${shown}, which is not a usable package name (an optional @scope/, then letters, digits, ".", "-" or "_", at most ${BUNDLE_NAME_MAX_LENGTH} characters), so dsh cannot register it.`,
    }
  }
  const root = projectCandidate(meta, manifest, head, undefined)
  // The rescue probe: only a `requires-build` root can be rescued, so only it
  // is probed. The release rides the candidate through the state file, so a
  // repo with no release does not re-consume this budget daily.
  if (root !== null && root.requiresBuild) {
    const release = await fetchLatestReleaseTarball(owner, slug, fetchImpl, sleep, token)
    if (release !== null) root.release = release
  }
  if (root !== null && root.hasBundle) {
    return { ok: true, candidates: [root] }
  }
  if (probeSubpackages && monorepoSignal(manifest)) {
    const subs = await probeSubpackageCandidates(owner, slug, meta, manifest, head, fetchImpl, sleep, token)
    if (subs.length > 0) return { ok: true, candidates: subs }
  }
  if (root === null) {
    return { ok: false, code: 'no-manifest', detail: 'package.json declares no name and no installable subpackage, so dsh has nothing to register.' }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/categories.test.ts registry/scripts/tests/config.test.ts registry/scripts/tests/github-client.test.ts`
Expected: PASS

Then: `pnpm test` and `pnpm typecheck`.

Mutation check (required): revert `JSON.stringify(name)` to `"${name}"` in one serializer at a time in a scratchpad copy and confirm the matching probe test fails; change `isBundleName` to `typeof value === 'string' && value.length > 0` and confirm the grammar test fails.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/categories.ts registry/scripts/src/config.ts registry/scripts/src/github-client.ts registry/scripts/tests/categories.test.ts registry/scripts/tests/config.test.ts registry/scripts/tests/github-client.test.ts
git commit -m "fix(registry): JSON-escape bot-written names and validate a repo manifest name at the boundary

Both serialisers emitted '- name: \"\${name}\"' unescaped, justified by a
comment that npm names never contain a quote or a backslash -- true of npm,
false of a GitHub manifest name, and both reach these files. Probed:
'dsh-\"quote' is a YAMLParseError, 'dsh-a\"\\n  category: tool\\n- name:
\"dsh-victim' forges a row and throws duplicate-entry on every later build,
'dsh-trailing\\\\' alters the name, 'dsh-b\" # comment' overwrites another
package's row. categories.yml and first-seen.yml are build INPUTS, so any of
those wedges the pipeline until a human edits the file.

Fixed at both ends: JSON.stringify in both serialisers (as markets.ts already
does), and a package-name grammar at projectCandidate so no candidate with an
unusable name is ever created. The root gets its own author-readable detail;
uppercase stays legal, since a bundle name is not an npm publication.

MUST ship together with the first-seen.yml commit fix (C-1)."
```

---

### Task 5: C-1 / A-6 / E-1 — commit `first-seen.yml`, guard the `git add` line with a test, and re-run the backfill once

**Files:**
- Modify: `.github/workflows/daily.yml:133`
- Create: `registry/scripts/tests/workflow.test.ts`
- Modify: `registry/first-seen.yml` (regenerated by the one-off backfill)
- Test: `registry/scripts/tests/workflow.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at the type level; **requires Task 4's commit in the same push** (see the ship-together rule below)
- Produces: `registry/scripts/tests/workflow.test.ts` exporting nothing — a guard suite. Task 6 extends the same file.

**Ship-together rule.** `first-seen.yml` receives every harvested repo candidate name, gated or not (`build.ts:215`). Committing it before Task 4 commits whatever name the next hostile repository chooses, and every later build then throws in `loadRegistryConfig` on the file the bot wrote itself. **Task 4's commit must precede this one in the same push.**

- [ ] **Step 1: Write the failing test**

Create `registry/scripts/tests/workflow.test.ts`:

```ts
/** The daily workflow's commit steps, read as data.
 *
 * `build.ts` writes four files back into the repository and a bot commits
 * them. `registry/first-seen.yml` was written every build (build.ts) and never
 * added (daily.yml), so every name absent from the committed file was stamped
 * `added: <today>` again the next day: on 2026-09-03 the live catalog had
 * 4,842 of 9,422 entries carrying `added: "2026-09-03"`, 3,197 entries
 * differed from the previous build in `added` ALONE, the content hash churned
 * daily for packages whose content had not changed, publish-catalog's
 * "unchanged, skip" path could never fire (six catalog versions published in
 * one day), and `added` was fiction for half the shelf. That is the `builtAt`
 * invariant broken through a side door.
 *
 * These tests exist so the NEXT such file cannot be forgotten: they read the
 * writers' own source, not a hand-maintained list.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'daily.yml'), 'utf8')

/** Every path under `registry/` that one module writes with writeFileSync. */
function registryWrites(source: string): string[] {
  const out = new Set<string>()
  // `writeFileSync(join(REGISTRY_DIR, 'x/y.ext'), …)` — the literal form.
  for (const match of source.matchAll(/writeFileSync\(\s*join\(REGISTRY_DIR,\s*'([^']+)'\)/g)) {
    if (match[1] !== undefined) out.add(match[1])
  }
  // `const p = join(REGISTRY_DIR, 'x.json')` … `writeFileSync(p, …)` — the
  // variable form build.ts uses for repo-state.json.
  for (const match of source.matchAll(/const (\w+) = join\(REGISTRY_DIR, '([^']+)'\)/g)) {
    const [, variable, file] = match
    if (variable !== undefined && file !== undefined
      && new RegExp(`writeFileSync\\(${variable}\\b`).test(source)) out.add(file)
  }
  return [...out].sort()
}

/** Every path the workflow's `git add` lines stage. */
function stagedPaths(): Set<string> {
  const staged = new Set<string>()
  for (const match of workflow.matchAll(/^\s*git add ([^\n]+)$/gm)) {
    for (const token of (match[1] ?? '').trim().split(/\s+/)) staged.add(token)
  }
  return staged
}

describe('the daily workflow stages every registry file the build writes', () => {
  const staged = stagedPaths()

  it('finds the writers, so the extraction itself is not silently empty', () => {
    // If a refactor changes how the writes are spelled, this fails rather than
    // letting the guard below pass vacuously.
    const build = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'build.ts'), 'utf8')
    const classify = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'classify.ts'), 'utf8')
    expect(registryWrites(build)).toEqual(['first-seen.yml', 'repo-state.json', 'snapshots/manifest.lock'])
    expect(registryWrites(classify)).toEqual(['categories.yml', 'markets.yml'])
  })

  it('stages every file build.ts writes under registry/', () => {
    const build = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'build.ts'), 'utf8')
    for (const file of registryWrites(build)) {
      expect(staged, `daily.yml must git add registry/${file}`).toContain(`registry/${file}`)
    }
  })

  it('stages every file classify.ts writes under registry/', () => {
    const classify = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'classify.ts'), 'utf8')
    for (const file of registryWrites(classify)) {
      expect(staged, `daily.yml must git add registry/${file}`).toContain(`registry/${file}`)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/workflow.test.ts -t "stages every file build.ts writes"`
Expected: FAIL — `AssertionError: daily.yml must git add registry/first-seen.yml: expected Set{ 'registry/categories.yml', 'registry/markets.yml', 'registry/snapshots/manifest.lock', 'registry/repo-state.json' } to contain 'registry/first-seen.yml'`

- [ ] **Step 3: Write the implementation**

`.github/workflows/daily.yml`. Before (`:125-136`):

```yaml
      - name: Commit the snapshot
        # push included: the repo-state.json backfill memory must persist
        # across push-triggered runs, or every run restarts from empty.
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/snapshots/manifest.lock registry/repo-state.json
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): daily catalog snapshot"
          git push
```

After (Task 6 replaces the `git push` line in this same step; keep the `git add` change here):

```yaml
      - name: Commit the snapshot
        # push included: the repo-state.json backfill memory must persist
        # across push-triggered runs, or every run restarts from empty.
        #
        # first-seen.yml is staged too. It is written every build and was never
        # added, so every name absent from the committed file was re-stamped
        # `added: <today>` the next day: 4,842 of 9,422 live entries carried
        # `added: "2026-09-03"`, 3,197 entries differed from the previous build
        # in `added` alone, the "stable" content hash churned daily, and
        # publish-catalog's unchanged-skip path could never fire. Adding a new
        # registry write without adding it here now fails workflow.test.ts.
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/snapshots/manifest.lock registry/repo-state.json registry/first-seen.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): daily catalog snapshot"
          git push
```

Then run the one-off backfill so the rowless names get their real dates back from the `manifest.lock` history. `registry/first-seen.yml` holds 4,424 rows against 9,422 lock lines at HEAD, so about 5,000 names are currently re-stamped every day.

```bash
node --experimental-strip-types registry/scripts/src/backfill-first-seen.ts
```

It reads only committed `manifest.lock` snapshots (no network) and throws rather than writing if it produces a version-string key — the guard added after the 2026-08-31 backfill shipped 187 of them. Check the result before staging:

```bash
grep -c '^- name:' registry/first-seen.yml   # expect roughly the 9,422 lock lines, not 4,424
git diff --stat registry/first-seen.yml
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/workflow.test.ts`
Expected: PASS

Then: `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

Push this together with Task 4's commit, never alone.

```bash
git add .github/workflows/daily.yml registry/scripts/tests/workflow.test.ts registry/first-seen.yml
git commit -m "fix(ci): commit first-seen.yml, and guard the git add line with a test

The snapshot step added manifest.lock and repo-state.json only, so
first-seen.yml -- written every build -- was never committed. Every absent
name was stamped 'first seen today' again the next day: 4,842 of 9,422 live
entries carried added: 2026-09-03, 3,197 entries differed from the previous
build in 'added' alone, the cache-stable content hash changed daily for
packages whose content had not, publish-catalog's unchanged-skip path could
never fire (six catalog versions published in one day), and 'added' was
fiction for half the shelf. The builtAt invariant, broken through a side door.

workflow.test.ts now reads build.ts and classify.ts for their own
writeFileSync targets and asserts each one appears in a git add line, so the
next such file cannot be forgotten. backfill-first-seen.ts re-run once to
recover the real dates from the committed manifest.lock history."
```

---

### Task 6: E-2 — fetch and rebase before each bot push, with one retry, and make a rejection visible

**Files:**
- Modify: `.github/workflows/daily.yml:57-70` (the classifier commit step), `:125-136` (the snapshot commit step)
- Test: `registry/scripts/tests/workflow.test.ts` (created in Task 5; three tests added)

**Interfaces:**
- Consumes: `registry/scripts/tests/workflow.test.ts` and its `workflow` / `stagedPaths` helpers from Task 5
- Produces: no new exports; the workflow's two push steps gain a `push_with_rebase` shell function

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/workflow.test.ts`:

```ts
describe('the daily workflow pushes safely', () => {
  /** The `run:` block of each step that pushes. */
  const pushSteps = workflow
    .split(/\n      - /)
    .filter(step => /^\s*git push|\n\s*git push|push_with_rebase/.test(step))

  it('has exactly the two bot commit steps', () => {
    // If a third push appears, it must be reviewed against these rules rather
    // than inherit them by accident.
    expect(pushSteps).toHaveLength(2)
  })

  it('fetches and rebases before every push', () => {
    // Both pushes went out with no fetch and no rebase under
    // continue-on-error: true. Run 33731280504 (schedule, 2026-09-03,
    // conclusion `success`): `! [rejected] main -> main (fetch first)` at
    // 08:24 for the classifier commit and 08:53 for the snapshot commit; run
    // 33623131511 (2026-09-02, `success`): the same twice. Each occurrence
    // silently discarded that day's LLM verdicts and the repo-state backfill
    // memory. A human push during the ~50-minute run makes main
    // non-fast-forward even when it does not trigger the workflow.
    for (const step of pushSteps) {
      expect(step).toContain('git fetch origin main')
      expect(step).toContain('git rebase origin/main')
    }
  })

  it('retries a rejected push once and then reports the failure', () => {
    for (const step of pushSteps) {
      // One retry, then loud: a swallowed rejection is what made two runs in a
      // row report success while landing nothing.
      expect(step).toContain('push_with_rebase')
      expect(step).toMatch(/::error::|::warning::/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/workflow.test.ts -t "fetches and rebases before every push"`
Expected: FAIL — `AssertionError: expected '…git add registry/categories.yml…git push' to contain 'git fetch origin main'`

- [ ] **Step 3: Write the implementation**

`.github/workflows/daily.yml` — both commit steps. Before (`:57-70`):

```yaml
      - name: Commit the classifier's output
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        # markets.yml as well as categories.yml. The classify step writes both,
        # and a market verdict that is not committed is not a memory: the name
        # would be re-asked every run, which is the flip-flop the file exists to
        # prevent — and one bad roll would then be recorded forever.
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/categories.yml registry/markets.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): llm classifier update"
          git push
```

After:

```yaml
      - name: Commit the classifier's output
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        # markets.yml as well as categories.yml. The classify step writes both,
        # and a market verdict that is not committed is not a memory: the name
        # would be re-asked every run, which is the flip-flop the file exists to
        # prevent — and one bad roll would then be recorded forever.
        #
        # The push fetches and rebases first, with one retry. Without it both
        # pushes were rejected `(fetch first)` on 2026-09-02 and 2026-09-03
        # while the run reported success, discarding each day's verdicts. The
        # step stays continue-on-error (a failed commit must not skip the Pages
        # deploy below), so the rejection is surfaced as ::error:: instead.
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          push_with_rebase() {
            for attempt in 1 2; do
              git fetch origin main || true
              git rebase origin/main || { git rebase --abort || true; }
              if git push origin HEAD:main; then return 0; fi
              echo "::warning::push attempt $attempt was rejected; refetching"
            done
            echo "::error::could not push $1 after two attempts; this run's changes were not recorded"
            return 1
          }
          git add registry/categories.yml registry/markets.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): llm classifier update"
          push_with_rebase "the classifier's output"
```

And the snapshot step, whose `git add` line Task 5 already changed. Before:

```yaml
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/snapshots/manifest.lock registry/repo-state.json registry/first-seen.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): daily catalog snapshot"
          git push
```

After:

```yaml
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          push_with_rebase() {
            for attempt in 1 2; do
              git fetch origin main || true
              git rebase origin/main || { git rebase --abort || true; }
              if git push origin HEAD:main; then return 0; fi
              echo "::warning::push attempt $attempt was rejected; refetching"
            done
            echo "::error::could not push $1 after two attempts; this run's changes were not recorded"
            return 1
          }
          git add registry/snapshots/manifest.lock registry/repo-state.json registry/first-seen.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): daily catalog snapshot"
          push_with_rebase "the daily snapshot"
```

The function is repeated in both steps because each `run:` block is its own shell — there is no shared state between steps.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/workflow.test.ts`
Expected: PASS

Then: `pnpm test` and `pnpm typecheck`.

**Live verification (no vitest equivalent exists).** After merge, read the next scheduled run's log for both commit steps and confirm no `[rejected]` line and no `::error::` annotation:

```bash
gh run list --workflow catalog --event schedule --limit 1 --json databaseId --jq '.[0].databaseId'
gh run view <id> --log | grep -nE '\[rejected\]|::error::|::warning::|rebase'
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/daily.yml registry/scripts/tests/workflow.test.ts
git commit -m "fix(ci): fetch and rebase before each bot push, retry once, report a rejection

Both bot pushes ran with no fetch and no rebase under continue-on-error.
Run 33731280504 (schedule, 2026-09-03, conclusion success) logged
'! [rejected] main -> main (fetch first)' at 08:24 for the classifier commit
and 08:53 for the snapshot; run 33623131511 (2026-09-02, success) the same
twice. Each occurrence silently discarded that day's LLM verdicts and the
repo-state backfill memory, and the run said it had succeeded.

push_with_rebase fetches, rebases, pushes, retries once, and annotates
::warning:: per attempt and ::error:: on final failure. continue-on-error
stays, because a failed commit must not skip the Pages deploy; the annotation
is what makes it visible. workflow.test.ts pins both properties."
```

---

### Task 7: A-1 — bound every free-text field that reaches a published artifact

**Files:**
- Modify: `registry/scripts/src/schema.ts:11-18` (`catalogSectionSchema`)
- Modify: `registry/schema/plugin-entry.schema.json` (regenerated by `pnpm emit:schema` — never hand-edited)
- Modify: `registry/scripts/src/gate.ts:14-20` (constants), `:82-88` (license and repository checks)
- Modify: `registry/scripts/src/npm-client.ts:173-183` (`PEERS_MAX_COUNT` neighborhood), `:259-261` (the peers projection)
- Modify: `registry/scripts/src/github-client.ts:511-534` (`fetchRepoCandidate`'s manifest read)
- Test: `registry/scripts/tests/schema.test.ts`, `registry/scripts/tests/gate.test.ts`, `registry/scripts/tests/npm-client.test.ts`, `registry/scripts/tests/github-client.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `gate(candidate, config)` (`gate.ts:60`); `toCandidate(packument): Candidate | null` (`npm-client.ts:214`); `isBundleName` and `BUNDLE_NAME_MAX_LENGTH` from Task 4 (they already cap a GitHub manifest `name` at 214); `runPipeline(candidates, repoCandidates, config, builtAt, rejections?, stars?, schemaVersion?)` (`pipeline.ts`)
- Produces:
  - `schema.ts`: `export const CAPABILITY_MAX_LENGTH = 64`
  - `gate.ts`: `export const LICENSE_MAX_LENGTH = 128`, `export const REPOSITORY_MAX_LENGTH = 512`
  - `npm-client.ts`: `export const PEER_NAME_MAX_LENGTH = 214`
  - `github-client.ts`: `export const MAX_MANIFEST_BYTES = 1024 * 1024`

**Chosen bounds and why.** `CAPABILITY_MAX_LENGTH = 64` — a capability names a dsh service; the longest real one is under 20. `LICENSE_MAX_LENGTH = 128` — the longest SPDX expression in use is well under it (`Apache-2.0 WITH LLVM-exception` is 30), and a value past it is not an SPDX identifier. `REPOSITORY_MAX_LENGTH = 512` — a GitHub URL is under 100; 512 leaves room for a self-hosted path. `PEER_NAME_MAX_LENGTH = 214` — npm's own name limit, matching `BUNDLE_NAME_MAX_LENGTH`. `MAX_MANIFEST_BYTES = 1 MB` — the largest real `package.json` observed is around 100 KB; the tarball reader's cap is 32 MB and a manifest needs three orders of magnitude less.

**Where each bound lives.** `capabilities` and `summary` in the pure schema, so an over-long value is an `invalid-catalog` rejection carrying zod's exact path (`dsh.catalog.capabilities.0: …`). `license` and `repository` in the pure gate, with their own details — routing them through `toCandidate` as `null` would publish "Declares no license." for a package that declared a 1 MB one, and a misattributed reason is a defect. Peer names in `toCandidate`, beside the existing `PEERS_MAX_COUNT` slice, because that field's documented policy is already "the excess is dropped, never rejected". The manifest body cap in the shell, where the bytes are.

- [ ] **Step 1: Write the failing test**

`registry/scripts/tests/schema.test.ts`:

```ts
  it('rejects a capability item past the published bound', () => {
    // `capabilities` capped the COUNT at 20 and not the item length, so one
    // package with 20 one-megabyte strings is 20 MB of a file every reader
    // downloads. Through the real toCandidate -> gate -> emit path, 1 MB
    // strings produced a 222 MB plugins.json.
    const result = parseCatalogSection({ ...valid, capabilities: ['x'.repeat(65)] })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('capabilities')
  })

  it('accepts a capability item at the bound', () => {
    expect(parseCatalogSection({ ...valid, capabilities: ['x'.repeat(64)] }).ok).toBe(true)
  })
```

`registry/scripts/tests/gate.test.ts`:

```ts
describe('field length bounds', () => {
  it('rejects an over-long license with a reason that is about its length', () => {
    // Not "Declares no license." — the author declared one and it is 1 MB. A
    // wrong published reason is a defect, not a wording nit.
    const result = gate(candidate({ license: 'M'.repeat(129) }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-license')
      expect(result.rejection.detail).toBe('Declares a license string longer than 128 characters, so it is not an SPDX identifier.')
    }
  })

  it('rejects an over-long repository with a reason that is about its length', () => {
    const result = gate(candidate({ repository: `https://github.com/you/${'x'.repeat(512)}` }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-repository')
      expect(result.rejection.detail).toBe('Declares a repository URL longer than 512 characters, so it cannot be audited as a source location.')
    }
  })

  it('accepts a license and a repository at the bounds', () => {
    expect(gate(candidate({ license: 'M'.repeat(128) }), config).ok).toBe(true)
    expect(gate(candidate({ repository: `https://h/${'x'.repeat(502)}` }), config).ok).toBe(true)
  })
})
```

`registry/scripts/tests/npm-client.test.ts`, inside `describe('toCandidate', …)`:

```ts
  it('drops a peer name past the length bound, the way it drops the count tail', () => {
    // 200 peer names are recorded and each reaches every reader's plugins.json
    // verbatim with no bound of its own. The documented policy for this field
    // is "the excess is dropped, never rejected" — an oversized manifest costs
    // the author the tail, not the listing.
    const result = toCandidate({
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: { ok: '*', ['x'.repeat(215)]: '*' },
        },
      },
    })
    expect(result?.peers).toEqual(['ok'])
  })
```

`registry/scripts/tests/github-client.test.ts`, inside `describe('fetchRepoCandidate', …)`:

```ts
  it('refuses a manifest body past the cap instead of holding it in memory', async () => {
    // The raw manifest name and the raw, unvalidated dsh.catalog value are
    // stored verbatim in the committed repo-state.json even when the gate
    // later rejects them, and the body was read with no cap at all — unlike
    // the tarball reader's 32 MB one.
    const huge = JSON.stringify({ name: 'dsh-repo-plugin', dsh: { bundle: {}, catalog: { note: 'z'.repeat(2 * 1024 * 1024) } } })
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json':
        new Response(huge, { status: 200, headers: { 'content-length': String(huge.length) } }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('no-manifest')
      expect(result.detail).toContain('larger than 1048576 bytes')
    }
  })
```

`registry/scripts/tests/pipeline.test.ts` — the end-to-end assertion the audit asked for:

```ts
  it('keeps plugins.json bounded when a candidate carries megabyte strings', () => {
    // The real toCandidate -> gate -> assignTier -> emit path produced a
    // 222 MB plugins.json from ONE package with 1 MB strings. Every reader
    // downloads that file.
    const hostile: Candidate = {
      name: 'dsh-hostile-plugin',
      version: '1.0.0',
      integrity: 'sha512-x',
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: `https://github.com/you/${'x'.repeat(1024 * 1024)}`,
      license: 'M'.repeat(1024 * 1024),
      deprecated: false,
      hasBundle: true,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: ['c'.repeat(1024 * 1024)] },
      description: 'A hostile plugin.',
      keywords: [],
      peers: Array.from({ length: 200 }, () => 'p'.repeat(1024 * 1024)),
    }
    const { pluginsJson, report } = runPipeline([...candidates, hostile], [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).not.toContain('dsh-hostile-plugin')
    expect(report).toContain('| dsh-hostile-plugin | no-license |')
    expect(pluginsJson.length).toBeLessThan(64 * 1024)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/schema.test.ts registry/scripts/tests/gate.test.ts registry/scripts/tests/pipeline.test.ts`
Expected: FAIL — the schema test fails as `expected false to be false` inverted (`result.ok` is `true`); the gate tests fail with `expected true to be false`; the pipeline test fails with `AssertionError: expected 2098176 to be less than 65536`.

- [ ] **Step 3: Write the implementation**

**3a.** `registry/scripts/src/schema.ts`. Before (`:1-18`):

```ts
import { z } from 'zod'
import { CATEGORIES, type CatalogSection } from './types.ts'

/** Closed category enum; adding a member is a schema change. */
export const categorySchema = z.enum(CATEGORIES)

/**
 * The `dsh.catalog` section. Both summary languages are required and neither
 * is synthesized by the build: a missing translation is a missing translation.
 */
export const catalogSectionSchema = z.object({
  category: categorySchema,
  summary: z.object({
    en: z.string().min(1).max(200),
    zh: z.string().min(1).max(200),
  }),
  capabilities: z.array(z.string().min(1)).max(20),
}).strict()
```

After:

```ts
import { z } from 'zod'
import { CATEGORIES, type CatalogSection } from './types.ts'

/** Closed category enum; adding a member is a schema change. */
export const categorySchema = z.enum(CATEGORIES)

/**
 * Maximum length of one `capabilities` item. The count was capped at 20 and
 * the item length was not, so a manifest declaring 20 one-megabyte strings
 * put 20 MB into a file every reader downloads — measured through the real
 * `toCandidate → gate → assignTier → emit` path, one package with 1 MB
 * strings produced a 222 MB `plugins.json`. A capability names a dsh service;
 * the longest real one is under twenty characters.
 */
export const CAPABILITY_MAX_LENGTH = 64

/**
 * The `dsh.catalog` section. Both summary languages are required and neither
 * is synthesized by the build: a missing translation is a missing translation.
 * Every free-text field is length-bounded, because a declared section reaches
 * a published artifact verbatim.
 */
export const catalogSectionSchema = z.object({
  category: categorySchema,
  summary: z.object({
    en: z.string().min(1).max(200),
    zh: z.string().min(1).max(200),
  }),
  capabilities: z.array(z.string().min(1).max(CAPABILITY_MAX_LENGTH)).max(20),
}).strict()
```

Then regenerate the published schema — never hand-edit it:

```bash
pnpm emit:schema
git diff registry/schema/plugin-entry.schema.json   # expect one added "maxLength": 64 under capabilities.items
```

**3b.** `registry/scripts/src/gate.ts` — add the constants after `DERIVED_SUMMARY_MAX_LENGTH` (`:20`):

```ts
/**
 * Maximum length of a `license` string. npm takes the field verbatim and it
 * reaches every published entry; a value past this is not an SPDX identifier
 * (the longest expression in use, `Apache-2.0 WITH LLVM-exception`, is 30
 * characters). Bounded HERE and not in `toCandidate`, so the rejection can say
 * what is actually wrong: nulling the field in the shell would publish
 * "Declares no license." for a package that declared a one-megabyte one.
 */
export const LICENSE_MAX_LENGTH = 128

/**
 * Maximum length of a `repository` URL. A GitHub URL is under 100 characters;
 * the headroom covers a self-hosted path. Same reasoning as
 * {@link LICENSE_MAX_LENGTH} for why the bound is a gate rule.
 */
export const REPOSITORY_MAX_LENGTH = 512
```

And the two checks. Before (`:82-88`):

```ts
  if (candidate.license === null || candidate.license === '') {
    return reject(name, 'no-license', 'Declares no license.')
  }
  if (candidate.repository === null || candidate.repository === '') {
    return reject(name, 'no-repository',
      'Declares no repository, so the published code cannot be audited.')
  }
```

After:

```ts
  if (candidate.license === null || candidate.license === '') {
    return reject(name, 'no-license', 'Declares no license.')
  }
  if (candidate.license.length > LICENSE_MAX_LENGTH) {
    return reject(name, 'no-license',
      `Declares a license string longer than ${LICENSE_MAX_LENGTH} characters, so it is not an SPDX identifier.`)
  }
  if (candidate.repository === null || candidate.repository === '') {
    return reject(name, 'no-repository',
      'Declares no repository, so the published code cannot be audited.')
  }
  if (candidate.repository.length > REPOSITORY_MAX_LENGTH) {
    return reject(name, 'no-repository',
      `Declares a repository URL longer than ${REPOSITORY_MAX_LENGTH} characters, so it cannot be audited as a source location.`)
  }
```

**3c.** `registry/scripts/src/npm-client.ts` — add after `PEERS_MAX_COUNT` (`:183`):

```ts
/**
 * Maximum length of one recorded peer name — npm's own name limit. Each of the
 * {@link PEERS_MAX_COUNT} names reaches every reader's `plugins.json`
 * verbatim, and `peerDependencies` keys carry no bound of their own. Dropped
 * rather than rejected, the same policy the count cap already states: an
 * oversized manifest costs the author the tail of the list, not the listing.
 */
export const PEER_NAME_MAX_LENGTH = 214
```

And the projection. Before (`:259-261`):

```ts
    peers: manifest.peerDependencies !== null && typeof manifest.peerDependencies === 'object' && !Array.isArray(manifest.peerDependencies)
      ? Object.keys(manifest.peerDependencies).slice(0, PEERS_MAX_COUNT)
      : [],
```

After:

```ts
    peers: manifest.peerDependencies !== null && typeof manifest.peerDependencies === 'object' && !Array.isArray(manifest.peerDependencies)
      ? Object.keys(manifest.peerDependencies)
        .filter(peer => peer.length > 0 && peer.length <= PEER_NAME_MAX_LENGTH)
        .slice(0, PEERS_MAX_COUNT)
      : [],
```

**3d.** `registry/scripts/src/github-client.ts` — add beside `MAX_TARBALL_BYTES` (after `:40`):

```ts
/**
 * The largest `package.json` the harvest will read. The manifest body had no
 * cap at all, unlike the tarball reader's 32 MB one, and both the raw manifest
 * `name` and the raw, unvalidated `dsh.catalog` value are stored verbatim in
 * the COMMITTED `repo-state.json` even when the gate later rejects the
 * candidate. The largest real dsh manifest observed is about 100 KB.
 */
export const MAX_MANIFEST_BYTES = 1024 * 1024
```

And the manifest read in `fetchRepoCandidate`. Before (`:523-534`):

```ts
  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  const manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token)
  if (!manifestResponse.ok) {
    return { ok: false, code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }
  }
  let manifest: unknown
  try {
    manifest = await manifestResponse.json()
  } catch {
    // Same rule as npm: an unreadable body is a rejection, not a crash.
    return { ok: false, code: 'no-manifest', detail: 'package.json was unreadable.' }
  }
```

After:

```ts
  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  const manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token)
  if (!manifestResponse.ok) {
    return { ok: false, code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }
  }
  const declaredLength = Number(manifestResponse.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MANIFEST_BYTES) {
    // Refused before a byte is read. An over-cap manifest is not an
    // installable plugin unit, and its raw `catalog` value would otherwise be
    // committed to repo-state.json whether or not the gate accepts it.
    return {
      ok: false,
      code: 'no-manifest',
      detail: `package.json is larger than ${MAX_MANIFEST_BYTES} bytes, so it is not read.`,
    }
  }
  let manifestText: string
  try {
    manifestText = await manifestResponse.text()
  } catch {
    // Same rule as npm: an unreadable body is a rejection, not a crash.
    return { ok: false, code: 'no-manifest', detail: 'package.json was unreadable.' }
  }
  if (manifestText.length > MAX_MANIFEST_BYTES) {
    // No content-length (a chunked response): the cap is applied to what
    // arrived rather than trusted from a header a third party wrote.
    return {
      ok: false,
      code: 'no-manifest',
      detail: `package.json is larger than ${MAX_MANIFEST_BYTES} bytes, so it is not read.`,
    }
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestText)
  } catch {
    return { ok: false, code: 'no-manifest', detail: 'package.json was unreadable.' }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/schema.test.ts registry/scripts/tests/gate.test.ts registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts registry/scripts/tests/pipeline.test.ts`
Expected: PASS — including `schema.test.ts`'s existing "matches the committed file", which fails until `pnpm emit:schema` has been run.

Then: `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

The author-facing prose for these bounds is Task 9's deliverable; **Tasks 7 and 9 must be in the same pull request**, or `docs/schema.md` documents a limit the validator no longer has.

```bash
pnpm emit:schema
git add registry/scripts/src/schema.ts registry/schema/plugin-entry.schema.json registry/scripts/src/gate.ts registry/scripts/src/npm-client.ts registry/scripts/src/github-client.ts registry/scripts/tests/schema.test.ts registry/scripts/tests/gate.test.ts registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts registry/scripts/tests/pipeline.test.ts
git commit -m "fix(registry): bound every free-text field that reaches a published artifact

capabilities capped the COUNT at 20 and never the item length; license,
repository and each of the 200 peer names were taken verbatim with no bound;
the GitHub manifest body was read with no cap at all, unlike the tarball
reader's 32 MB one. Through the real toCandidate -> gate -> assignTier ->
emit path, ONE package with 1 MB strings produced a 222 MB plugins.json --
the file every reader downloads.

capabilities items cap at 64 in the pure schema, so an over-long value is an
invalid-catalog rejection with zod's exact path. license (128) and repository
(512) cap in the pure gate with details about their length -- nulling them in
the shell would have published 'Declares no license.' for a package that
declared a megabyte one. Peer names cap at 214 and are dropped, the policy
that field's count cap already states. A GitHub manifest over 1 MB is refused
before it is read, which also keeps its raw dsh.catalog out of the committed
repo-state.json.

plugin-entry.schema.json regenerated with pnpm emit:schema. Author-facing
prose lands in the docs commit of this same PR."
```

---

### Task 8: D-5 — a deadline on the other three network clients, and one on the build job

**Files:**
- Modify: `registry/scripts/src/npm-client.ts:23-50` (export `withTimeout`, name the subject in the message)
- Modify: `registry/scripts/src/github-client.ts:42-62` (`fetchRobust`)
- Modify: `registry/scripts/src/llm-client.ts:115-156` (`runBatches`)
- Modify: `registry/scripts/src/github-stars.ts:28-49` (`fetchStarCounts`)
- Modify: `.github/workflows/daily.yml:28-31` (the build job)
- Test: `registry/scripts/tests/github-client.test.ts`, `registry/scripts/tests/llm-client.test.ts`, `registry/scripts/tests/github-stars.test.ts`, `registry/scripts/tests/workflow.test.ts`

**Interfaces:**
- Consumes: `registry/scripts/tests/workflow.test.ts` and its `workflow` helper from Task 5
- Produces:
  - `npm-client.ts`: `export function withTimeout(fetchImpl: typeof fetch, ms: number, subject?: string): typeof fetch` — the third parameter defaults to `'registry'`, so every existing call site keeps its message
  - `npm-client.ts`: `export class FetchTimeoutError extends Error {}` (already the class at `:24`, now exported)
  - `github-client.ts`: `export const GITHUB_REQUEST_TIMEOUT_MS = 30_000`
  - `llm-client.ts`: `export const GATEWAY_REQUEST_TIMEOUT_MS = 120_000`
  - `github-stars.ts`: `export const STARS_REQUEST_TIMEOUT_MS = 30_000`

- [ ] **Step 1: Write the failing test**

`registry/scripts/tests/github-client.test.ts` — append a new `describe`, and add `GITHUB_REQUEST_TIMEOUT_MS` to the import list on line 3:

```ts
describe('request deadlines', () => {
  const meta = { fullName: 'someone/dsh-repo-plugin', defaultBranch: 'main', description: 'A repo plugin.', license: 'MIT', pushedAt: '2026-08-01T00:00:00Z', stars: null as number | null }

  it('has a per-request deadline at all', () => {
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBe(30_000)
  })

  it('bounds a socket that accepts and never answers', async () => {
    // Only npm-client passed an AbortSignal. Against a socket that accepts and
    // never writes, npm-client rejected after 2 s and github-client was still
    // pending at 8 s; the only bound was undici's 300 s headers timeout, after
    // which fetchRobust retried three more times — so a stalled GitHub ended
    // in the six-hour Actions kill with no report and no state commit.
    const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    // probeSubpackages false, then the 50 ms deadline: four bounded attempts.
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token', false, 50)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('fetch-failed')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
```

`fetchRobust` rethrows after four attempts, and `fetchRepoCandidate` has no `catch` around the manifest fetch, so the throw propagates today. Wrap the manifest fetch so the deadline becomes a rejection rather than an abort — the same rule as `fetchCandidate` in Task 2. In `fetchRepoCandidate`, before:

```ts
  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  const manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token)
```

After:

```ts
  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  let manifestResponse: Response
  try {
    manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token, timeoutMs)
  } catch (error) {
    // A stall or a network failure on ONE repository is transient and its own
    // rejection code — `fetch-failed`, never `no-manifest`, which would record
    // a false permanent reason in repo-state.json (that misclassification is
    // D-3's separate finding; this catch must not add to it).
    return {
      ok: false,
      code: 'fetch-failed',
      detail: `Could not read package.json of ${meta.fullName} (${error instanceof Error ? error.message : String(error)}).`,
    }
  }
```

`registry/scripts/tests/github-stars.test.ts` — append, reusing the file's own `options` and `repo` helpers (`:4-5`):

```ts
describe('request deadlines', () => {
  it('skips a batch whose request never answers instead of hanging the build', async () => {
    // Stars are advisory and every failure mode already ends in `skipped`; the
    // deadline is what makes a stalled GraphQL endpoint one of those failure
    // modes rather than the job's six-hour kill.
    const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    const result = await fetchStarCounts([repo(0)], {
      ...options, fetchImpl, sleep: async (_ms: number) => {}, timeoutMs: 50,
    })
    expect(result.stars.size).toBe(0)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]).toContain('owner0/repo0')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
```

`registry/scripts/tests/llm-client.test.ts` — append, reusing the file's own `options` and `item` helpers (`:4-6`):

```ts
describe('request deadlines', () => {
  it('discards a batch whose gateway request never answers', async () => {
    // The classifier is advisory, so a stall must degrade to a discard the
    // next build retries — not to the six-hour Actions kill. The gateway is
    // plaintext to a bare IP, so an on-path stall is not hypothetical.
    const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    const result = await classifyPackages([item(0)], {
      ...options, fetchImpl, sleep: async (_ms: number) => {}, timeoutMs: 50,
    })
    expect(result.classified.size).toBe(0)
    expect(result.discarded).toHaveLength(1)
    expect(result.discarded[0]?.name).toBe('dsh-pkg-0')
    expect(Date.now() - started).toBeLessThan(5000)
  })
})
```

Both advisory clients already route a throw correctly, verified at HEAD: `llm-client.ts:183-188` pushes `gateway unreachable: <message>` for every name in the batch, and `github-stars.ts:98-104` pushes the same shape into `skipped`. The timeout rejection lands in those handlers, so neither client needs a new `catch` — only the wrapped `fetchImpl`.

Match the existing option and item shapes in `llm-client.test.ts` and `github-stars.test.ts` when writing these — read those two files first and copy the fixture shape they already use, adding only `timeoutMs`.

`registry/scripts/tests/workflow.test.ts`:

```ts
describe('the build job is bounded', () => {
  it('sets timeout-minutes on the build job', () => {
    // The publish job has one; the build job -- the harvest, the plaintext LLM
    // step and the stars fetch -- had none, so a stalled dependency ran to the
    // six-hour Actions kill with no report and no state commit.
    const buildJob = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  publish:'))
    expect(buildJob).toMatch(/^\s{4}timeout-minutes: \d+$/m)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/workflow.test.ts -t "sets timeout-minutes on the build job"`
Expected: FAIL — `AssertionError: expected '  build:\n    runs-on: ubuntu-latest\n…' to match /^\s{4}timeout-minutes: \d+$/m`. The three client tests fail to compile first: `Object literal may only specify known properties, and 'timeoutMs' does not exist in type …`, and `Expected 5 arguments, but got 6` for `fetchRepoCandidate`.

- [ ] **Step 3: Write the implementation**

**3a.** `registry/scripts/src/npm-client.ts` — export the helper and let it name its subject. Before (`:23-50`):

```ts
/** A request that outlived {@link REQUEST_TIMEOUT_MS}; a failover trigger. */
class FetchTimeoutError extends Error {}

function registryUrl(registry: string, path: string): string {
  return `${registry.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Wrap a fetch so no request can outlive `ms`: the timer aborts the
 * request's own signal and rejects the returned promise, whichever a given
 * implementation honors. */
function withTimeout(fetchImpl: typeof fetch, ms: number): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      return await Promise.race([
        fetchImpl(input, { ...init, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new FetchTimeoutError(`registry request exceeded ${ms}ms`))
          }, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
```

After:

```ts
/** A request that outlived its deadline; a failover trigger. Exported so the
 * other three network modules can classify their own stalls the same way. */
export class FetchTimeoutError extends Error {}

function registryUrl(registry: string, path: string): string {
  return `${registry.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

/** Wrap a fetch so no request can outlive `ms`: the timer aborts the
 * request's own signal and rejects the returned promise, whichever a given
 * implementation honors.
 *
 * Lives here and is exported because npm-client was the ONLY module passing an
 * AbortSignal. Against a socket that accepts and never writes, npm-client
 * rejected after 2 s while github-client was still pending at 8 s: the only
 * bound anywhere else was undici's 300 s headers timeout, after which the
 * GitHub client's own retry ladder ran three more times, so a stalled GitHub
 * or gateway ended in the six-hour Actions kill with no report, no state
 * commit and no catalog.
 * @param subject - names the stalled counterpart in the error message.
 */
export function withTimeout(fetchImpl: typeof fetch, ms: number, subject = 'registry'): typeof fetch {
  return async (input, init) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    try {
      return await Promise.race([
        fetchImpl(input, { ...init, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new FetchTimeoutError(`${subject} request exceeded ${ms}ms`))
          }, { once: true })
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }
}
```

**3b.** `registry/scripts/src/github-client.ts` — wrap `fetchRobust`'s implementation, and thread the deadline through `fetchRepoCandidate` and `harvestRepos`. Add the constant beside `MAX_MANIFEST_BYTES`:

```ts
/** Per-attempt bound on a GitHub request (API or raw). Matches npm-client's:
 * a run makes thousands of these and a stalled one must not consume the job's
 * whole budget. */
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000
```

Then, before (`:48-62`):

```ts
async function fetchRobust(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchWithRetry(url, fetchImpl, sleep, token)
    } catch (error) {
      if (attempt >= 3) throw error
      await sleep(2000 * 2 ** attempt)
    }
  }
}
```

After:

```ts
async function fetchRobust(
  url: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  // The deadline wraps the impl INSIDE the retry ladder, so each of the four
  // attempts is bounded rather than the ladder multiplying undici's 300 s
  // default by four.
  const timed = withTimeout(fetchImpl, timeoutMs, 'github')
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchWithRetry(url, timed, sleep, token)
    } catch (error) {
      if (attempt >= 3) throw error
      await sleep(2000 * 2 ** attempt)
    }
  }
}
```

Change the import at `:18` from `import { fetchWithRetry } from './npm-client.ts'` to `import { fetchWithRetry, withTimeout } from './npm-client.ts'`. Add a trailing `timeoutMs: number = GITHUB_REQUEST_TIMEOUT_MS` parameter to `fetchRepoCandidate` (`:511-517`) and pass it to every `fetchRobust` call in that function and in `probeSubpackageCandidates`; add `timeoutMs?: number` to `RepoHarvestOptions` (`:568-580`), default it in the destructure at `:613-619`, and pass it into `fetchRepoCandidate` at `:638`.

**3c.** `registry/scripts/src/llm-client.ts` — add the constant near the other bounds and wrap the impl. Add to the `Options` interface a `timeoutMs?: number`, then before (`:124-125`):

```ts
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
```

After:

```ts
  // The gateway is the slowest counterpart here — a full batch completion is
  // seconds — so its deadline is generous, but it exists: a gateway that
  // accepts and never answers used to run to undici's 300 s default per
  // attempt, times the retry ladder, times the concurrency window.
  const fetchImpl = withTimeout(options.fetchImpl ?? fetch, options.timeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS, 'llm gateway')
  const sleep = options.sleep ?? defaultSleep
```

with, above `runBatches`:

```ts
import { withTimeout } from './npm-client.ts'

/** Per-attempt bound on a gateway completion. Generous — a batch completion
 * takes seconds — but bounded: the classify step is advisory and a stall must
 * become a discard the next build retries, not the six-hour Actions kill. */
export const GATEWAY_REQUEST_TIMEOUT_MS = 120_000
```

The existing `try` around the fetch at `:147` already turns a throw into per-name discards, so no other change is needed for the advisory contract to hold.

**3d.** `registry/scripts/src/github-stars.ts` — add `timeoutMs?: number` to the options parameter at `:30` and wrap. Before (`:32, :44-48`):

```ts
  const { token, fetchImpl = fetch, sleep = defaultSleep } = options
```

```ts
      const request = (): Promise<Response> => fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
```

After:

```ts
  const { token, fetchImpl = fetch, sleep = defaultSleep, timeoutMs = STARS_REQUEST_TIMEOUT_MS } = options
  // Stars are advisory and every failure mode already ends in `skipped`; the
  // deadline is what makes a stalled GraphQL endpoint one of those failure
  // modes rather than the job's six-hour kill.
  const timed = withTimeout(fetchImpl, timeoutMs, 'github graphql')
```

```ts
      const request = (): Promise<Response> => timed(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
```

with, near `ENDPOINT` (`:15`):

```ts
import { withTimeout } from './npm-client.ts'

/** Per-attempt bound on a stars GraphQL request. */
export const STARS_REQUEST_TIMEOUT_MS = 30_000
```

The `try` at `:41` already routes a throw to `skipped`, so the advisory contract holds.

**3e.** `.github/workflows/daily.yml`. Before (`:28-32`):

```yaml
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
```

After:

```yaml
  build:
    runs-on: ubuntu-latest
    # Bounded because a stalled counterpart used to run to the six-hour Actions
    # kill: only npm-client passed an AbortSignal, so a GitHub or LLM-gateway
    # socket that accepted and never answered fell back on undici's 300 s
    # default, times each client's own retry ladder. The three clients now carry
    # per-request deadlines; this is the outer bound. A full run -- install,
    # tests, classify, harvest, stars, emit -- takes about 50 minutes, so 120 is
    # generous and still fails hours before the platform limit.
    timeout-minutes: 120
    permissions:
      contents: write
    env:
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts registry/scripts/tests/llm-client.test.ts registry/scripts/tests/github-stars.test.ts registry/scripts/tests/workflow.test.ts`
Expected: PASS

Then: `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/src/github-client.ts registry/scripts/src/llm-client.ts registry/scripts/src/github-stars.ts .github/workflows/daily.yml registry/scripts/tests/github-client.test.ts registry/scripts/tests/llm-client.test.ts registry/scripts/tests/github-stars.test.ts registry/scripts/tests/workflow.test.ts
git commit -m "fix(registry): give github, llm and stars requests a deadline; bound the build job

Only npm-client passed an AbortSignal. Against a socket that accepts and never
writes, npm-client rejected after 2 s and github-client was still pending at
8 s: the only bound elsewhere was undici's 300 s headers timeout, after which
fetchRobust retried three more times -- so a stalled GitHub or gateway ended
in the six-hour Actions kill with no report, no state commit and no catalog.

withTimeout is exported from npm-client and reused in all three, wrapping the
impl INSIDE each retry ladder so every attempt is bounded rather than the
ladder multiplying the default. github 30 s, gateway 120 s, stars 30 s -- the
existing catch in each advisory client already turns a throw into a discard or
a skip. timeout-minutes: 120 on the build job is the outer bound."
```

---

### Task 9: Spec and documentation amendments WP0 requires

**Files:**
- Modify: `CLAUDE.md:34`, `:37`, `:58-68` ("Failing loudly")
- Modify: `docs/schema.md:28`, `:34`, `:42-48`
- Modify: `docs/schema.zh.md:28`, `:34`, `:42-48`
- Modify: `README.md:262`, `README.zh.md:239`
- Test: `registry/scripts/tests/schema.test.ts` (the existing freshness test is the mechanical guard; the prose has none)

**Interfaces:**
- Consumes: `CAPABILITY_MAX_LENGTH = 64`, `LICENSE_MAX_LENGTH = 128`, `REPOSITORY_MAX_LENGTH = 512`, `PEER_NAME_MAX_LENGTH = 214`, `MAX_MANIFEST_BYTES = 1024 * 1024` from Task 7; `SEARCH_WINDOW = 5250` and `MAX_SEARCH_FROM = 5000` from Task 1
- Produces: nothing importable. **Must be in the same pull request as Task 7**, or `docs/schema.md` documents a limit the validator no longer has.

- [ ] **Step 1: Write the failing test**

The prose has no automated guard, so the check is a mechanical grep that fails at HEAD. Run it before editing and record the output:

```bash
# Every place that repeats the stale ~1390 figure. Expect 4 hits before, 0 after
# (the .github/ comments are updated too, since they cite the same number).
grep -rn '1390' CLAUDE.md README.md README.zh.md .github/workflows/daily.yml

# The published field bounds. Expect 0 hits before, one per language after.
grep -rn 'CAPABILITY_MAX_LENGTH\|64 characters\|64 字符' docs/schema.md docs/schema.zh.md

# The search window in Failing loudly. Expect 0 hits before, 1 after.
grep -n '5250\|reachable window' CLAUDE.md
```

Expected before the edits: `1390` appears at `CLAUDE.md:34`, `CLAUDE.md:37`, `README.md:262`, `README.zh.md:239` and three times in `.github/workflows/daily.yml`; the two bound greps and the window grep return nothing.

Re-measure the real figure rather than trusting either number in this plan — the audit says ~8,800 and this plan measures 5,615, and the two differ because 8,800 is the un-deduplicated sum of the two keyword totals while the harvest fetches the deduplicated union:

```bash
# Exact totals, one request each. 2026-09-03: 3698, 5095, 3178 -> union 5,615.
for q in 'keywords:dsh-plugin' 'keywords:deepseek-harness' 'keywords:dsh-plugin,deepseek-harness'; do
  printf '%-42s ' "$q"
  curl -s "https://registry.npmjs.org/-/v1/search?text=$(printf %s "$q" | jq -sRr @uri)&size=1" | jq .total
done
# Cross-check against the committed artifacts: 9,422 lock lines = 3,514 npm
# entries + 5,908 repo entries, so the npm harvest fetches on the order of
# 5,600 packuments to list 3,514.
wc -l < registry/snapshots/manifest.lock
```

- [ ] **Step 2: Run test to verify it fails**

Run: `grep -rn '1390' CLAUDE.md README.md README.zh.md .github/workflows/daily.yml && grep -n 'reachable window' CLAUDE.md`
Expected: FAIL — the first grep prints seven lines (the stale figure is still there); the second exits 1 with no output (the window bound is not in "Failing loudly").

- [ ] **Step 3: Write the implementation**

**3a.** `CLAUDE.md:34` and `:37`. Before:

```markdown
pnpm build:catalog  # ~1390 live npm requests, several minutes — see below
```

```markdown
**`build:catalog` hits the public npm registry roughly 1390 times and takes minutes.** Do not run it to check that a change compiles; the tests cover every policy decision without a network. Run it when you have changed the fetching or writing layer and need to see it work end to end.
```

After:

```markdown
pnpm build:catalog  # thousands of live npm requests, several minutes — see below
```

```markdown
**`build:catalog` makes one packument request per harvested name — on the order of 5,600 today — plus a paged search per keyword, and takes minutes.** The old "~1390" figure was the `dsh-plugin` keyword's size in August 2026 and it is three years of ecosystem growth out of date: measured 2026-09-03, `keywords:dsh-plugin` reports 3,698 names and `keywords:deepseek-harness` 5,095, their intersection is 3,178, so the deduplicated union the harvest fetches is 5,615. (The 2026-09-03 audit's "~8,800" is the un-deduplicated sum of the two totals; the harvest fetches the union.) The number tracks the ecosystem, so re-measure with one `size=1` search per keyword rather than trusting any figure written down here. Do not run the build to check that a change compiles; the tests cover every policy decision without a network. Run it when you have changed the fetching or writing layer and need to see it work end to end.
```

**3b.** `CLAUDE.md` — the "Failing loudly" list. Before (`:65`):

```markdown
- Hitting the search page bound throws rather than truncating.
```

After:

```markdown
- Hitting the search page bound throws rather than truncating.
- **A keyword past the search window throws, and a partition that does not cover it throws.** One npm search query can enumerate 5,250 names (`from` is capped at 5,000, `size` at 250) and a `from` past that silently returns page 0 — so the harvest reads `body.total`, partitions the query on `keywords:a,b` intersections, and then measures its own coverage against the keyword's total. `keywords:a,b` is the only filtering qualifier the API honors: there is no negation, so a partition is never covering by construction and the measurement is the guarantee. `keywords:deepseek-harness` was 155 names short of the window on 2026-09-03.
```

**3c.** `docs/schema.md`. Before (`:28`, `:34`):

```markdown
| `capabilities` | yes | Up to 20 free-form strings naming the dsh services the plugin uses |
```

```markdown
**`capabilities` is self-declared and unenforced.** dsh does not sandbox plugins, so this field describes what the author says the plugin touches. It is displayed, never checked. Do not read it as a permission grant.
```

After:

```markdown
| `capabilities` | yes | Up to 20 free-form strings, each at most 64 characters, naming the dsh services the plugin uses |
```

```markdown
**`capabilities` is self-declared and unenforced.** dsh does not sandbox plugins, so this field describes what the author says the plugin touches. It is displayed, never checked. Do not read it as a permission grant.

**Every field the catalog publishes is length-bounded.** A declared section reaches a file every reader downloads, so a value past its bound is rejected with the field named rather than published: `summary.en` and `summary.zh` at 200 characters, each `capabilities` item at 64. The build bounds the npm manifest fields it reads the same way — `license` at 128 characters (a value past it is not an SPDX identifier) and `repository` at 512 — and records at most 200 `peerDependencies` names, each at most 214 characters, dropping the rest. A repository listed from GitHub must keep its root `package.json` under 1 MB and declare a `name` in the package-name grammar (an optional `@scope/`, then letters, digits, `.`, `-` or `_`, at most 214 characters); a name outside it cannot be registered and the build report says so.
```

**3d.** `docs/schema.zh.md` — the same facts in its own register, not a word-for-word translation. Before (`:28`, `:34`):

```markdown
| `capabilities` | 是 | 至多 20 个自由字符串，说明插件用到的 dsh 服务 |
```

```markdown
**`capabilities` 是作者自述，不被强制执行。** dsh 不对插件做沙箱隔离，因此该字段只是作者声称插件会碰什么。它只用于展示，不会被校验。**不要把它当成权限授予来读。**
```

After:

```markdown
| `capabilities` | 是 | 至多 20 个自由字符串，每个不超过 64 字符，说明插件用到的 dsh 服务 |
```

```markdown
**`capabilities` 是作者自述，不被强制执行。** dsh 不对插件做沙箱隔离，因此该字段只是作者声称插件会碰什么。它只用于展示，不会被校验。**不要把它当成权限授予来读。**

**所有会被发布的字段都有长度上限。** 声明的内容会原样进入每位读者都要下载的数据文件，所以超限的值会被拒绝并指名字段，而不是照发：`summary.en` 与 `summary.zh` 各 200 字符，`capabilities` 每项 64 字符。构建读取的 npm 清单字段同样有上限——`license` 128 字符（超过它就不可能是 SPDX 标识符），`repository` 512 字符——`peerDependencies` 最多记录 200 个名字，每个不超过 214 字符，其余丢弃。从 GitHub 上架的仓库，根目录 `package.json` 必须小于 1 MB，且 `name` 要符合包名文法（可选的 `@scope/`，然后是字母、数字、`.`、`-` 或 `_`，总长不超过 214 字符）；不符合的名字无法被注册，构建报告会指出这一点。
```

**3e.** The derived table, both languages. Before (`docs/schema.md:48`, `docs/schema.zh.md:48`):

```markdown
| `capabilities` | your list | empty |
```

```markdown
| `capabilities` | 你的列表 | 空列表 |
```

After:

```markdown
| `capabilities` | your list (≤ 20 items, ≤ 64 characters each) | empty |
```

```markdown
| `capabilities` | 你的列表（≤ 20 项，每项 ≤ 64 字符） | 空列表 |
```

**3f.** `README.md:262` and `README.zh.md:239`. Before:

```markdown
1390 requests and several minutes. The tests cover every policy decision without a
```

```markdown
`pnpm build:catalog` 会对公共 npm registry 跑真实采集——大约 1390 次请求、数分钟。所有策略判断
```

After:

```markdown
thousands of requests and several minutes. The tests cover every policy decision without a
```

```markdown
`pnpm build:catalog` 会对公共 npm registry 跑真实采集——数千次请求、数分钟。所有策略判断
```

**3g.** `.github/workflows/daily.yml` — three comments cite the same stale figure (`:8`, `:98`, `:152`). Replace `~1390 live npm requests` with `thousands of live npm requests`, `another ~1390 npm requests` with `another full harvest`, and `the ~1390-request harvest` with `the full harvest`. These are comments only; no step changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `grep -rn '1390' CLAUDE.md README.md README.zh.md .github/workflows/daily.yml; grep -c 'reachable window' CLAUDE.md; grep -c '64 characters' docs/schema.md; grep -c '64 字符' docs/schema.zh.md`
Expected: PASS — the first grep exits 1 with no output; the three counts are `1`, `2`, `2`.

Then: `pnpm test` (338+ tests green, `schema.test.ts`'s freshness guard included) and `pnpm typecheck`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md README.zh.md docs/schema.md docs/schema.zh.md .github/workflows/daily.yml
git commit -m "docs: correct the harvest size, add the search window to Failing loudly, publish the field bounds

The ~1390 figure was the dsh-plugin keyword's size in August 2026 and it is
repeated in four files. Measured 2026-09-03: keywords:dsh-plugin 3,698,
keywords:deepseek-harness 5,095, intersection 3,178, so the deduplicated
union the harvest fetches is 5,615 -- against 9,422 committed lock lines
(3,514 npm entries + 5,908 repo entries). The audit's ~8,800 is the
un-deduplicated sum of the two totals; both figures are recorded with their
provenance and the reader is told to re-measure.

The search-window bound joins the page bound in Failing loudly: one query
enumerates 5,250 names, a from past 5,000 silently returns page 0, and a
partition on keywords:a,b intersections has no negation to build on so its
coverage is measured rather than assumed.

docs/schema.md and its Chinese sibling now state every published length
bound: summary 200, capabilities item 64, license 128, repository 512, peer
name 214, GitHub manifest 1 MB plus the package-name grammar."
```

---

## Verification, in order

Run before every commit step, never `pnpm build:catalog`:

```bash
npx vitest run registry/scripts/tests/<the task's file>   # the focused test
pnpm test                                                  # 334 at HEAD; each task adds to it
pnpm typecheck                                             # tsc --noEmit, must be clean
```

After the whole set, before opening the pull request:

```bash
pnpm test && pnpm typecheck
pnpm emit:schema && git diff --exit-code registry/schema/plugin-entry.schema.json   # generated file is current
git log --oneline main..HEAD                               # nine commits, in plan order
```

**Ordering and pairing rules.**

- Task 2 must land after Task 1 (Task 1's file is the one Task 2 edits) and before Task 3 (Task 3's empty-string test asserts the `{ ok: false }` shape Task 2 introduces).
- Task 4 must precede Task 5 **in the same push**. Committing `first-seen.yml` before the names in it are escaped commits whatever name the next hostile repository chooses, and every later build then throws reading the file the bot wrote.
- Task 5 must precede Task 6 (Task 6 edits the same two workflow steps and extends the same test file).
- Task 7 and Task 9 must be in the same pull request, or `docs/schema.md` documents a limit the validator no longer has.
- Every registry-side change here ships on the next daily build and needs no package release. Nothing in WP0 touches `packages/`, so no `beta` promotion is involved.

## What this plan does not close

Named so the next reader does not go looking:

- **D-6's third sub-fix, "never fail over a paged search."** It contradicts the passing test at `npm-client.test.ts:600` and Task 1's coverage check now makes a mixed-index enumeration loud (fewer distinct names than the keyword's total → throw). Deferred to WP3 with that reason.
- **D-9's body-size cap** on packument and search JSON. Task 1 takes the free half — naming the query on a body that is not JSON — and leaves the cap to WP3, where it sits beside the other body-read bounds.
- **The `javascript:` scheme** on a `repository` value that A-1 observed. Task 7 bounds the length; validating the scheme is G-6 / F-3's boundary work in WP4, and the client already builds an `href` only for `https?://` values.
- **The market judge (D-7), the identity key (WP1), and trust semantics (WP2).** Out of WP0 by the audit's own ordering.
- **Live confirmation of E-2.** No vitest equivalent exists; Task 6 pins the workflow's shape and the next scheduled run's log is the proof.
