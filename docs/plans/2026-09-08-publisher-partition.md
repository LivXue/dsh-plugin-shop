# Publisher partition axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the npm harvest a second partition axis keyed on `maintainer:`, seeded from every search result it already reads and persisted across runs, so a publisher releasing a family of packages past the search window is recovered without a human noticing a shared tag.

**Architecture:** npm's search API caps `from` at 5,000, so ranks past 5,250 are unaddressable by any query for a keyword. The shipped answer is a hand-maintained refinement list (`PARTITION_KEYWORDS`) whose cells are `keywords:<harvest>,<refinement>` — a different query, in which a name ranked 5,300 lands at rank 5 and becomes addressable. That axis has a permanent blind spot: a package carrying only the harvest keyword falls in no cell. `maintainer:` is a filter the API honours (measured) and every package has one, so a `keywords:<harvest> maintainer:<user>` cell has no such blind spot — but it can only be built for a maintainer already SEEN, which is why it supplements the refinement list rather than replacing it. The vocabulary is free (search responses already carry `maintainers`) and is persisted like `repo-state.json` so coverage accumulates monotonically instead of being re-derived each run from a window that is a shrinking fraction of the whole.

**Tech Stack:** TypeScript (ESM, `.ts` extensions in local relative imports), Node ≥ 20 built-in `fetch`, vitest.

**Spec:** `docs/design/2026-08-18-dsh-plugin-shop-design.md` — the **Amendment (2026-09-08)** and its **Amendment (2026-09-08, follow-up)**. Read both before starting; every number this plan quotes is recorded there with the measurement that produced it.

**Base:** branch `fix/harvest-shortfall-split` / PR #26, which split the single shortfall bound into `MAX_SEARCH_SHORTFALL`, `MIN_UNREACHABLE_RECOVERY` and `MAX_UNREACHABLE_RESIDUAL`, and gave `KeywordShortfall` its `unreachable` / `recovered` fields. **Do not start this plan until PR #26 is merged** — Task 5 changes the very arithmetic that PR introduced, and rebasing that change is worse than waiting.

## Global Constraints

`CLAUDE.md`'s conventions and invariants apply in full and are not restated here — it is loaded for every agent working in this repo, and a second copy is a second authority that disagrees the first time one of them is amended. Only what is specific to THIS plan is below.

- **The dependency runs core ← shell and never the other way.** `npm-client.ts` is shell (it reaches the network); `publisher-state.ts` is PURE. No pure module in this repo imports from an impure one (`repo-state.ts` imports only `types.ts`), which is why the username grammar lives in the pure module and `npm-client.ts` imports it, not the reverse. `CLAUDE.md` states the pure/impure split but not this direction.
- **A maintainer username reaches a URL here.** `CLAUDE.md`'s "everything from npm is hostile" therefore has a concrete boundary in this plan: validate the username against the grammar before it is interpolated into a search query.

**Commands:** `pnpm exec vitest run registry/scripts/tests/<file>` for one suite, `pnpm exec vitest run` for the registry suite, `pnpm typecheck` for types. Never run `pnpm build:catalog` to check that a change compiles — it makes thousands of live requests.

## Measured facts this plan is sized against

The follow-up amendment in `docs/design/2026-08-18-dsh-plugin-shop-design.md` is the authority for every figure below; this table is a convenience copy and must not disagree with it. Re-measure rather than trusting either if more than a week has passed — `PARTITION_KEYWORDS`' comment in `registry/scripts/src/npm-client.ts` owns the keyword totals and the tail, per `CLAUDE.md`.

| | |
|---|---|
| `keywords:deepseek-harness` total | 5,407 (2026-09-08), growing ~83/day |
| Window (`MAX_SEARCH_FROM` + `PAGE_SIZE`) | 5,250 — so **157 names unreachable** |
| Refinement cells recover | **156 of 157 (99.4%)** |
| Publisher cells recover, window-seeded | **95 of 157 (60.5%)** — measured 2026-09-08 |
| Distinct maintainers in the window | 3,041 |
| Maintainers `keywords:dsh-plugin` adds | **349** (it is fully enumerable today) |
| `keywords:dsh-plugin` total | 3,952 — crosses the window ~2026-10-01 |

An earlier draft of this table read 5,410 / 160 / "159 of 160" / 3,042 while citing the amendment's 5,407 / 157 / "156 of 157" / 3,041 as its source, and measured the publisher row against 157 in the same table. Both ratios round to 99.4%, which is how it went unnoticed. Keep the numbers identical to the amendment's or drop the table.

**Read that 60.5% correctly.** Publisher cells recover *less* than the refinement list, and this plan does not claim otherwise. Their value is the failure mode refinements cannot reach: the `sayedev` event was 20 packages released together, 7 of them past the window with no shared refinement, and 14 of them already visible — so `maintainer:sayedev` was derivable from what the harvest had already read and its cell recovers all 20. A refinement list reaches that family only if a human adds the tag after the build has gone red.

---

## File Structure

- **`registry/scripts/src/publisher-state.ts`** (new, pure) — the username grammar and bound, plus the persisted vocabulary: parse, serialize, merge. Mirrors `repo-state.ts` in shape and in failure posture.
- **`registry/scripts/tests/publisher-state.test.ts`** (new) — its unit tests.
- **`registry/scripts/src/npm-client.ts`** (modify) — search pages surface `maintainers`; cells become query descriptors; publisher cells join the partition under a probe budget.
- **`registry/scripts/tests/npm-client.test.ts`** (modify) — cell-descriptor and publisher-cell behaviour.
- **`registry/scripts/src/build.ts`** (modify) — read and write `registry/publisher-state.json`. `existsSync`, `readFileSync` and `writeFileSync` are already imported there (line 15); no import change needed.
- **`registry/scripts/src/classify.ts`** (modify) — read prior publishers and carry newly observed usernames in `dist/harvest.json` for the build to persist.
- **`registry/publisher-state.json`** (new, committed daily) — the vocabulary itself.
- **`.github/workflows/daily.yml`** (modify) — stage the publisher vocabulary in the snapshot commit after the build writes it.
- **`registry/scripts/tests/publisher-handoff.test.ts`** (new) — exercise both entry points and the next run's use of the persisted vocabulary with fixture fetches.
- **`registry/scripts/tests/workflow.test.ts`**, **`registry/scripts/tests/repo-guards.test.ts`** (modify) — cover the new registry write and extended handoff.
- **`docs/design/2026-08-18-dsh-plugin-shop-design.md`** (modify, Task 6 only) — the amendment recording what shipped.

---

### Task 1: The pure publisher module — grammar, bound, and persisted vocabulary

The username grammar is a policy decision, so it lives in the pure core and the shell imports it. Doing this first is what lets Task 2 stay one direction.

**Files:**
- Create: `registry/scripts/src/publisher-state.ts`
- Test: `registry/scripts/tests/publisher-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const MAINTAINER_MAX_LENGTH = 64`
  - `export function isMaintainerName(value: unknown): value is string`
  - `export interface PublisherState { readonly publishers: readonly string[] }`
  - `export function parsePublisherState(raw: string): PublisherState`
  - `export function serializePublisherState(state: PublisherState): string`
  - `export function mergePublishers(state: PublisherState, seen: Iterable<string>): PublisherState`

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  MAINTAINER_MAX_LENGTH, isMaintainerName, mergePublishers,
  parsePublisherState, serializePublisherState,
} from '../src/publisher-state.ts'

describe('isMaintainerName', () => {
  it('accepts npm account grammar and nothing else', () => {
    // This value is interpolated into a search `text=`, so the grammar IS the
    // boundary that keeps it safe. npm usernames are lowercase letters,
    // digits, hyphen, underscore and dot.
    expect(isMaintainerName('ok-name_1.2')).toBe(true)
    expect(isMaintainerName('a b')).toBe(false)
    expect(isMaintainerName('UPPER')).toBe(false)
    expect(isMaintainerName('has:colon')).toBe(false)
    expect(isMaintainerName('')).toBe(false)
    expect(isMaintainerName(7)).toBe(false)
    expect(isMaintainerName(null)).toBe(false)
  })

  it('bounds the length', () => {
    expect(isMaintainerName('x'.repeat(MAINTAINER_MAX_LENGTH))).toBe(true)
    expect(isMaintainerName('x'.repeat(MAINTAINER_MAX_LENGTH + 1))).toBe(false)
  })
})

describe('publisher state', () => {
  it('round-trips a sorted vocabulary', () => {
    const raw = serializePublisherState({ publishers: ['sayedev', 'bowenliang123'] })
    // Sorted by code unit, like every other artifact this repo writes, so the
    // committed file does not churn on the order npm happened to answer in.
    expect(raw).toBe('{\n  "publishers": [\n    "bowenliang123",\n    "sayedev"\n  ]\n}\n')
    expect(parsePublisherState(raw).publishers).toEqual(['bowenliang123', 'sayedev'])
  })

  it('accumulates monotonically — a publisher seen once is never forgotten', () => {
    // The whole point of persisting. Today `sayedev` is discoverable because
    // 14 of that family's 20 packages sit inside the window; when the window
    // is a smaller fraction of the keyword they may all fall outside it, and
    // the cell has to keep working.
    const first = mergePublishers({ publishers: [] }, ['sayedev'])
    const second = mergePublishers(first, ['bowenliang123'])
    expect(second.publishers).toEqual(['bowenliang123', 'sayedev'])
  })

  it('de-duplicates and re-sorts on merge', () => {
    expect(mergePublishers({ publishers: ['b'] }, ['a', 'b', 'a']).publishers).toEqual(['a', 'b'])
  })

  it('throws on a malformed file rather than harvesting with an empty vocabulary', () => {
    // Same posture as repo-state.ts: silently losing the memory would look
    // exactly like a first run, and quietly halve the partition.
    expect(() => parsePublisherState('not json')).toThrow(/not valid JSON/)
    expect(() => parsePublisherState('[]')).toThrow(/must be an object/)
    expect(() => parsePublisherState('{}')).toThrow(/publishers/)
    expect(() => parsePublisherState('{"publishers": "a"}')).toThrow(/publishers/)
    expect(() => parsePublisherState('{"publishers": [7]}')).toThrow(/publishers\[0\]/)
  })

  it('throws on a username it would not have written itself', () => {
    // The file is a build INPUT. A hand-edited or tampered entry reaches a
    // query, so the grammar is enforced on read as well as on write.
    expect(() => parsePublisherState('{"publishers": ["a b"]}')).toThrow(/publishers\[0\]/)
    expect(() => parsePublisherState(`{"publishers": ["${'x'.repeat(65)}"]}`)).toThrow(/publishers\[0\]/)
  })

  it('carries an unknown key through rather than refusing the file', () => {
    // Two entry points read this file and may be different versions mid-
    // deploy. An older reader must not refuse a newer file over a key it does
    // not know; it reads `publishers` and ignores the rest.
    const raw = '{\n  "publishers": [\n    "alice"\n  ],\n  "note": "hand-written"\n}\n'
    expect(parsePublisherState(raw).publishers).toEqual(['alice'])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run registry/scripts/tests/publisher-state.test.ts`
Expected: FAIL — cannot resolve `../src/publisher-state.ts`.

- [ ] **Step 3: Implement the minimal code to make the test pass**

```ts
/**
 * The committed memory of the npm harvest's PUBLISHER axis: every maintainer
 * username the harvest has seen on a search result, plus the grammar that
 * decides what may be one.
 *
 * `keywords:<harvest>,<refinement>` cells cannot reach a package that carries
 * only the harvest keyword; `keywords:<harvest> maintainer:<user>` cells have
 * no such blind spot, because every package has a maintainer. What they DO
 * need is to have seen the maintainer, which is why this file exists: the
 * vocabulary accumulates monotonically across runs instead of being re-derived
 * each time from a window that is a shrinking fraction of the keyword.
 *
 * A deterministic build input like `verified.yml` and `repo-state.json`:
 * committed daily, sorted by code unit, and a malformed one throws rather than
 * silently harvesting with half a partition.
 *
 * PURE, and the grammar lives here rather than in `npm-client.ts` for that
 * reason: it is a policy decision, the core owns those, and no pure module in
 * this repo imports from the shell.
 */

/**
 * Bound on a maintainer username. npm's own limit is smaller, but this value
 * is interpolated into a search `text=` parameter, so the bound is ours and
 * {@link isMaintainerName}'s grammar is what actually keeps it safe.
 */
export const MAINTAINER_MAX_LENGTH = 64

/** npm account grammar: lowercase letters, digits, hyphen, underscore, dot. */
const MAINTAINER_NAME = /^[a-z0-9._-]+$/

/** Whether `value` may be put in a query as a `maintainer:` argument. */
export function isMaintainerName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAINTAINER_MAX_LENGTH
    && MAINTAINER_NAME.test(value)
}

/** Every maintainer username the harvest has seen, sorted, unique. */
export interface PublisherState {
  readonly publishers: readonly string[]
}

/**
 * Parse the committed file.
 * @throws when it is not an object with a `publishers` array of usernames this
 *   module would itself have written. Unknown keys are ignored, so an older
 *   reader does not refuse a newer file.
 */
export function parsePublisherState(raw: string): PublisherState {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Named, not swallowed: JSON.parse throws here for exactly one reason and
    // the caller needs the file named, not a bare SyntaxError.
    throw new Error('publisher-state.json is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('publisher-state.json must be an object')
  }
  const publishers = (parsed as { publishers?: unknown }).publishers
  if (!Array.isArray(publishers)) {
    throw new Error('publisher-state.json: publishers must be an array')
  }
  const out: string[] = []
  publishers.forEach((name, i) => {
    if (!isMaintainerName(name)) {
      throw new Error(`publisher-state.json: publishers[${i}] is not a maintainer username`)
    }
    out.push(name)
  })
  return { publishers: out.sort() }
}

/** Serialize, sorted by code unit and newline-terminated. */
export function serializePublisherState(state: PublisherState): string {
  return `${JSON.stringify({ publishers: [...state.publishers].sort() }, null, 2)}\n`
}

/** The state plus everything in `seen`, unique and sorted. Never removes. */
export function mergePublishers(state: PublisherState, seen: Iterable<string>): PublisherState {
  return { publishers: [...new Set([...state.publishers, ...seen])].sort() }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm exec vitest run registry/scripts/tests/publisher-state.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/publisher-state.ts registry/scripts/tests/publisher-state.test.ts
git commit -m "feat(harvest): the pure publisher module — grammar and persisted vocabulary

Shaped like repo-state.ts: sorted, committed, and a malformed file throws
rather than harvesting with half a partition. Monotonic by construction —
a publisher seen once is kept, because the window that discovered them is
a shrinking fraction of the keyword. The username grammar lives here, in
the core, because it is a policy decision and the shell imports the core."
```

---

### Task 2: Search pages surface their maintainers

`SearchBody` models only `{ package: { name } }`, so the vocabulary the response already carries is parsed away.

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (the `SearchBody` interface, ~line 440)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `isMaintainerName` from `publisher-state.ts` (Task 1).
- Produces: `interface SearchBody { objects?: ({ package?: { name?: unknown; maintainers?: unknown } | null } | null)[]; total?: unknown }` and `export function maintainersOf(pkg: unknown): string[]`.

- [ ] **Step 1: Write the failing test**

```ts
describe('maintainersOf', () => {
  it('reads the usernames a search object carries', () => {
    expect(maintainersOf({ maintainers: [{ username: 'sayedev', email: 'a@b.c' }] })).toEqual(['sayedev'])
  })

  it('answers empty for every shape npm can legally serve instead', () => {
    // Hostile by default: this value reaches a URL. Anything that is not a
    // string username in the grammar is not a username.
    expect(maintainersOf(null)).toEqual([])
    expect(maintainersOf({})).toEqual([])
    expect(maintainersOf({ maintainers: 'sayedev' })).toEqual([])
    expect(maintainersOf({ maintainers: [null, 7, { username: 3 }, { name: 'x' }] })).toEqual([])
  })

  it('drops a username outside the grammar rather than putting it in a query', () => {
    expect(maintainersOf({ maintainers: [{ username: 'a b' }, { username: 'UPPER' }, { username: 'ok-name_1.2' }] }))
      .toEqual(['ok-name_1.2'])
  })

  it('de-duplicates, because one object can name a maintainer twice', () => {
    expect(maintainersOf({ maintainers: [{ username: 'a' }, { username: 'a' }] })).toEqual(['a'])
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts -t maintainersOf`
Expected: FAIL — `maintainersOf is not defined`.

- [ ] **Step 3: Implement the minimal code to make the test pass**

Add the import at the top of `npm-client.ts`:

```ts
import { isMaintainerName } from './publisher-state.ts'
```

Widen the interface and add the reader beside it:

```ts
interface SearchBody {
  objects?: ({ package?: { name?: unknown; maintainers?: unknown } | null } | null)[]
  total?: unknown
}

/**
 * The usernames one search object names, filtered to what may be put in a
 * query. Dropping is right rather than throwing: a malformed maintainer costs
 * one publisher cell, while the window and the refinement cells still
 * enumerate the package itself.
 */
export function maintainersOf(pkg: unknown): string[] {
  if (typeof pkg !== 'object' || pkg === null) return []
  const raw = (pkg as { maintainers?: unknown }).maintainers
  if (!Array.isArray(raw)) return []
  const out = new Set<string>()
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const username = (entry as { username?: unknown }).username
    if (isMaintainerName(username)) out.add(username)
  }
  return [...out]
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts && pnpm typecheck`
Expected: PASS, all of them. The `SearchBody` widening is additive, so no existing test moves.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(harvest): read maintainer usernames off search pages

The vocabulary a publisher partition needs is already in every search
response — objects[].package.maintainers — and was being parsed away.
Filtered through the core's grammar, because a username is interpolated
into a query text= and everything from npm is hostile."
```

---

### Task 3: Cells become query descriptors

A cell is `string[]` today, rendered by `keywordQuery(cell)`. A publisher cell cannot be expressed that way. This task is a **pure refactor with no behaviour change** — the reviewer's gate is exactly that.

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (`partitionKeyword`, `pageCell`, `searchTotal` and their call sites)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces:
  - `export interface Cell { readonly keywords: readonly string[]; readonly maintainer?: string }`
  - `export function cellQuery(cell: Cell): string`
  - `partitionKeyword` now returns `Promise<{ cells: Cell[]; total: number; partitioned: boolean }>` and its `probe` parameter becomes `(cell: Cell) => Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
describe('cellQuery', () => {
  it('renders a keyword-only cell exactly as keywordQuery did', () => {
    // The published behaviour must not move: this is the query string the
    // harvest has always sent, and every fixture assumes it.
    expect(cellQuery({ keywords: ['dsh-plugin'] })).toBe('keywords:dsh-plugin')
    expect(cellQuery({ keywords: ['deepseek-harness', 'dsh'] })).toBe('keywords:deepseek-harness,dsh')
    expect(cellQuery({ keywords: ['dsh-plugin'] })).toBe(keywordQuery(['dsh-plugin']))
  })

  it('renders a publisher cell as the keyword ANDed with the maintainer', () => {
    expect(cellQuery({ keywords: ['deepseek-harness'], maintainer: 'sayedev' }))
      .toBe('keywords:deepseek-harness maintainer:sayedev')
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts -t cellQuery`
Expected: FAIL — `cellQuery is not defined`.

- [ ] **Step 3: Implement the minimal code to make the test pass**

```ts
/**
 * One query the harvest pages: `keywords:` plus, optionally, one
 * `maintainer:` — the two qualifiers the API actually honours. Measured
 * 2026-09-08: `is:`/`not:`/`scope:` are ignored entirely and return the
 * unfiltered total, while a nonexistent maintainer returns 0.
 */
export interface Cell {
  readonly keywords: readonly string[]
  readonly maintainer?: string
}

/** The `text=` value for a cell. */
export function cellQuery(cell: Cell): string {
  const keywords = keywordQuery(cell.keywords)
  return cell.maintainer === undefined ? keywords : `${keywords} maintainer:${cell.maintainer}`
}
```

Keep `keywordQuery` exported and unchanged — the `partitionKeyword` throw messages name a keyword rather than a cell, and tests use it. Then thread the type through:

- `partitionKeyword`: `probe: (cell: Cell) => Promise<number>`, returns `Promise<{ cells: Cell[]; … }>`. Inside, `[keyword]` → `{ keywords: [keyword] }`, `[keyword, refinement]` → `{ keywords: [keyword, refinement] }`, `[...cell, refinement]` → `{ keywords: [...cell.keywords, refinement] }`, `cell.includes(refinement)` → `cell.keywords.includes(refinement)`, and the `deeper` map key `[...deeperCell].sort().join(',')` → `[...deeperCell.keywords].sort().join(',')`.
- Its two `throw` messages keep `keywordQuery(cell.keywords)` and `keywordQuery([keyword])`, so the published wording does not move.
- `pageCell(cell: readonly string[], …)` → `pageCell(cell: Cell, …)`, and its `const query = keywordQuery(cell)` → `const query = cellQuery(cell)`.
- `searchTotal(keywords: readonly string[], …)` → `searchTotal(cell: Cell, …)`, with its path built from `encodeURIComponent(cellQuery(cell))`.
- In `searchByKeywords`: `probe` becomes `(cell: Cell) => searchTotal(cell, fetchImpl, sleep, token, backupRegistry, timeoutMs)`; `pageCell([keyword], windowNames, 'stop')` → `pageCell({ keywords: [keyword] }, windowNames, 'stop')`; both `probe([keyword])` calls → `probe({ keywords: [keyword] })`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts && pnpm typecheck`
Expected: PASS, **with no other test edited**. If a test needed changing, the refactor changed behaviour and is wrong — every keyword-only cell must send a byte-identical `text=`.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "refactor(harvest): cells are query descriptors, not keyword tuples

A cell was string[] rendered by keywordQuery, which cannot express a
maintainer: cell. No behaviour change: every keyword-only cell renders the
byte-identical text= it always did, and no existing test moved."
```

---

### Task 4: The harvest reports the publishers it saw

`searchByKeywords` has to hand back the vocabulary it observed, or the persisted file can never grow.

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (`searchByKeywords`, `pageCell`)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `maintainersOf` (Task 2), `Cell`/`cellQuery` (Task 3).
- Produces: `searchByKeywords` gains a **seventh** parameter
  `onPublishers: (usernames: readonly string[]) => void = () => {}`, called once per page that carried any. Its return type stays `Promise<string[]>` — **do not** change it to a tuple; every existing call site and test reads the array directly.

- [ ] **Step 1: Write the failing test**

```ts
it('reports the maintainers every page carried, so the vocabulary can grow', async () => {
  const fetchImpl = (async (url: string | URL) => {
    const params = new URL(String(url)).searchParams
    const query = params.get('text') ?? ''
    if (!query.includes('dsh-plugin')) return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 })
    if (params.get('size') === '1') return new Response(JSON.stringify({ total: 2, objects: [] }), { status: 200 })
    return new Response(JSON.stringify({
      total: 2,
      objects: [
        { package: { name: 'dsh-a', maintainers: [{ username: 'alice' }] } },
        { package: { name: 'dsh-b', maintainers: [{ username: 'alice' }, { username: 'bob' }] } },
      ],
    }), { status: 200 })
  }) as unknown as typeof fetch
  const seen: string[] = []
  const names = await searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined, () => {},
    users => seen.push(...users))
  expect(names).toEqual(['dsh-a', 'dsh-b'])
  // Reported as observed, duplicates and all: de-duplication is
  // mergePublishers' job, and doing it here would make a page that carried
  // nothing indistinguishable from one that repeated a name.
  expect([...new Set(seen)].sort()).toEqual(['alice', 'bob'])
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts -t "vocabulary can grow"`
Expected: FAIL — `seen` is empty; the seventh argument is ignored.

- [ ] **Step 3: Implement the minimal code to make the test pass**

Add the parameter to `searchByKeywords`, after `onShortfall`:

```ts
  /**
   * Every maintainer username a page carried, called once per page that had
   * any. The vocabulary is free — the response already holds it — and this is
   * the only way it reaches `publisher-state.json`.
   */
  onPublishers: (usernames: readonly string[]) => void = () => {},
```

and inside `pageCell`'s object loop:

```ts
      const publishers: string[] = []
      for (const object of objects) {
        const found = object?.package?.name
        if (typeof found === 'string') {
          seen.add(found)
          into.add(found)
        }
        publishers.push(...maintainersOf(object?.package))
      }
      if (publishers.length > 0) onPublishers(publishers)
```

Collected for **every** cell, not only the window: `keywords:dsh-plugin` is fully enumerable today and contributes 349 maintainers the `deepseek-harness` window never shows.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts && pnpm typecheck`
Expected: PASS. The parameter is optional and last, so no existing call site moves.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(harvest): report the maintainers each search page carried

Collected from EVERY cell, not just the over-window one: keywords:dsh-plugin
is fully enumerable today and contributes 349 maintainers the
deepseek-harness window never shows."
```

---

### Task 5: Publisher cells join the partition, under a budget

The behaviour change. For a keyword past the window, build a cell per known publisher, probe it, page the ones that fit.

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (`partitionKeyword`, `searchByKeywords`)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `Cell`/`cellQuery` (Task 3).
- Produces:
  - `export const PUBLISHER_PROBE_BUDGET_DEFAULT = 4000`
  - `partitionKeyword(keyword, probe, publishers: readonly string[] = [], budget: number = PUBLISHER_PROBE_BUDGET_DEFAULT)`
  - `searchByKeywords` gains an **eighth** parameter `publishers: readonly string[] = []` and a **ninth** `publisherProbeBudget: number = PUBLISHER_PROBE_BUDGET_DEFAULT`

- [ ] **Step 1: Write the failing test**

```ts
describe('publisher cells', () => {
  /** A keyword past the window whose tail is one publisher's family, which no
   * refinement cell reaches — the shape of the sayedev event. */
  const familyPastWindow = (total: number, family: number) => stubSearch(
    query => (query === 'keywords:deepseek-harness' ? total
      : query === 'keywords:deepseek-harness maintainer:sayedev' ? family
      : query === 'keywords:deepseek-harness,dsh' ? 1
      : 0),
    (query, from) => {
      const beyond = Array.from({ length: total - SEARCH_WINDOW }, (_, i) => `beyond${i}`)
      if (query === 'keywords:deepseek-harness') {
        return from > MAX_SEARCH_FROM ? [] : Array.from({ length: 250 }, (_, i) => `w${from + i}`)
      }
      if (query === 'keywords:deepseek-harness maintainer:sayedev') {
        return beyond.slice(0, family).slice(from, from + 250)
      }
      // A live refinement cell that reaches nothing past the window.
      if (query === 'keywords:deepseek-harness,dsh') return ['w0'].slice(from, from + 250)
      return []
    },
  ).fetchImpl

  it('recovers a publisher family the refinement cells cannot reach', async () => {
    // 5410 names, 160 past the window, all of them one publisher's. The
    // refinement cell reaches none of them; maintainer:sayedev reaches all.
    const names = await searchByKeywords(
      familyPastWindow(5410, 160), undefined, undefined, undefined, undefined,
      () => {}, () => {}, ['sayedev'])
    expect(names).toHaveLength(5410)
  })

  it('fails exactly as before when the vocabulary is empty', async () => {
    // The axis is a supplement. With no publishers known the shipped
    // behaviour is unchanged, which is what makes this safe to land.
    await expect(searchByKeywords(familyPastWindow(5410, 160)))
      .rejects.toThrow(/under the 0\.9 floor/)
  })

  it('spends no probes on a keyword that fits the window', async () => {
    // 3042 probes is a real cost. A keyword inside the window needs no
    // partition at all, so it must buy none.
    const { fetchImpl, urls } = stubSearch(
      { 'keywords:dsh-plugin': 10, 'keywords:deepseek-harness': 0 },
      (query, from) => (query === 'keywords:dsh-plugin' && from === 0
        ? Array.from({ length: 10 }, (_, i) => `p${i}`) : []),
    )
    await searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined,
      () => {}, () => {}, ['alice', 'bob'])
    expect(urls.filter(u => u.includes('maintainer'))).toEqual([])
  })

  it('stops probing at the budget rather than spending the whole vocabulary', async () => {
    // The vocabulary grows monotonically and forever; the per-run probe cost
    // must not. Same posture as REPO_BACKFILL_BUDGET on the GitHub half.
    const { fetchImpl, urls } = stubSearch(
      query => (query === 'keywords:deepseek-harness' ? 5410 : 0),
      (query, from) => (query === 'keywords:deepseek-harness' && from <= MAX_SEARCH_FROM
        ? Array.from({ length: 250 }, (_, i) => `w${from + i}`) : []),
    )
    const many = Array.from({ length: 50 }, (_, i) => `u${i}`)
    await expect(searchByKeywords(fetchImpl, undefined, undefined, undefined, undefined,
      () => {}, () => {}, many, 10)).rejects.toThrow()
    expect(urls.filter(u => u.includes('maintainer')).length).toBe(10)
  })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts -t "publisher cells"`
Expected: FAIL — the first case rejects with the recovery-floor error, and no URL carries `maintainer`.

- [ ] **Step 3: Implement the minimal code to make the test pass**

Add the budget constant beside `PARTITION_KEYWORDS`:

```ts
/**
 * How many publisher cells one run may PROBE. The vocabulary accumulates
 * forever and the probe cost must not: 3,041 maintainers were in the window on
 * 2026-09-08 and each costs one `size=1` request. Sized above today's
 * vocabulary so nothing is skipped yet, and bounded so a year of accumulation
 * cannot quietly turn one run into fifty thousand requests. Same posture as
 * REPO_BACKFILL_BUDGET on the GitHub half.
 *
 * A run that hits this ceiling is partial, not wrong: the window and the
 * refinement cells are unaffected, and the coverage arithmetic from the
 * 2026-09-08 split still decides whether the result may publish.
 */
export const PUBLISHER_PROBE_BUDGET_DEFAULT = 4000
```

**This bounds the probes, not the run — size the paging half before shipping
Step 3.** Every maintainer in the vocabulary was read out of a
`keywords:<harvest>` result, so `keywords:<harvest> maintainer:<user>` is
non-zero for very nearly all of them, and the loop below pushes every non-zero
cell into `cells`. `searchByKeywords` then PAGES each cell, sequentially, and
pages them all again whenever `enumerate()` retries — which the 2026-09-08
split records as the steady state for `deepseek-harness`. At today's
vocabulary that is ~3,041 probes plus ~3,041 page requests plus another
~3,041 on the retry, roughly tripling the npm half of a run that `CLAUDE.md`
sizes at ~5,975 packuments plus 26 cells. None of the four tests in this task
observes it: the budget test's cells all probe 0, so none is ever paged.
Either bound the cells that get PAGED (keep the highest-total cells, or only
those whose probe suggests they straddle the window), or measure the run cost
and raise the ceiling deliberately. Do not raise
`PUBLISHER_PROBE_BUDGET_DEFAULT` believing it caps the run.

In `partitionKeyword`, after the refinement-cell loop and before the `oversized` deepening loop:

```ts
  // The publisher axis. Only for a keyword past the window — inside it every
  // rank is addressable and a partition buys nothing — and only for publishers
  // already SEEN, which is this axis's one limitation and why it supplements
  // the refinement list rather than replacing it (measured 2026-09-08:
  // publisher cells recover 95 of 157 where refinements recover 156).
  //
  // What it uniquely reaches is a family: one publisher releasing together,
  // ranking together at the bottom, sharing no refinement tag. That is the
  // only shape that has actually broken a build.
  let spent = 0
  for (const maintainer of publishers) {
    if (spent >= budget) break
    const cell: Cell = { keywords: [keyword], maintainer }
    spent++
    const cellTotal = await probe(cell)
    if (cellTotal === 0) continue
    // A publisher cell is bounded by one account's output under one keyword,
    // so it fits the window in every case measured. One that does not is left
    // to the refinement cells rather than throwing: an account with more than
    // SEARCH_WINDOW packages is beyond this axis, not a partition failure.
    if (cellTotal <= SEARCH_WINDOW) cells.push(cell)
  }
```

and thread the parameters:

```ts
export async function partitionKeyword(
  keyword: string,
  probe: (cell: Cell) => Promise<number>,
  publishers: readonly string[] = [],
  budget: number = PUBLISHER_PROBE_BUDGET_DEFAULT,
): Promise<{ cells: Cell[]; total: number; partitioned: boolean }> {
```

In `searchByKeywords`, add the two parameters after `onPublishers` and pass them down:

```ts
  publishers: readonly string[] = [],
  publisherProbeBudget: number = PUBLISHER_PROBE_BUDGET_DEFAULT,
```

```ts
    const { cells, total, partitioned } = await partitionKeyword(keyword, probe, publishers, publisherProbeBudget)
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `pnpm exec vitest run && pnpm typecheck`
Expected: PASS, whole registry suite. Then confirm the new rules bite — a guard that cannot fail is not a guard:

```bash
# Neuter the axis: the family test must go red.
sed -i 's/if (spent >= budget) break/if (true) break/' registry/scripts/src/npm-client.ts
pnpm exec vitest run registry/scripts/tests/npm-client.test.ts   # expect: failures
git checkout registry/scripts/src/npm-client.ts

# Remove the budget: the budget test must go red.
sed -i 's/if (spent >= budget) break/if (false) break/' registry/scripts/src/npm-client.ts
pnpm exec vitest run registry/scripts/tests/npm-client.test.ts   # expect: failures
git checkout registry/scripts/src/npm-client.ts
```

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(harvest): publisher cells join the partition, under a probe budget

A supplement, not a replacement: with an empty vocabulary the behaviour is
identical to before. What it reaches that refinements cannot is the family
event — one publisher releasing together past the window with no shared
tag, which is the only shape that has broken a build."
```

---

### Task 6: The pipeline persists the vocabulary

Wire the file through both entry points and the snapshot commit, so the vocabulary survives the run that discovered it. CI runs `classify.ts` followed by `build.ts --harvest-from dist/harvest.json`; the build's direct npm-search branch does not execute there. The handoff must therefore carry publisher observations, and the writer must run after either branch.

**Files:**
- Modify: `registry/scripts/src/build.ts` (read before the harvest branch; merge and write in the common artifact block)
- Modify: `registry/scripts/src/classify.ts` (read prior state, collect observations and serialize them in the handoff)
- Modify: `.github/workflows/daily.yml` (the snapshot commit's staged files)
- Create: `registry/publisher-state.json`
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md`
- Create: `registry/scripts/tests/publisher-handoff.test.ts`
- Modify: `registry/scripts/tests/workflow.test.ts`, `registry/scripts/tests/repo-guards.test.ts`

**Interfaces:**
- Consumes: `parsePublisherState`, `serializePublisherState`, `mergePublishers` (Task 1); `onPublishers` (Task 4); `publishers` (Task 5).
- Produces: the handoff field `publishers: string[]`, containing sorted, unique usernames observed in this harvest, plus the merged `registry/publisher-state.json` that the next run reads.

- [ ] **Step 1: Write integration tests for the actual CI path**

Use a temporary registry and the existing subprocess-test patterns from `config.test.ts` and `strip-types.test.ts`. Run the real entry points with a fetch fixture loaded before the entry point using Node's `--import`; reject every unexpected URL. Disable LLM classification and GitHub harvesting through their existing configuration, with no live credentials or requests. Assert the files the entry points write, rather than mocking their modules or checking only source strings.

- Start with an empty vocabulary. Give classifier search responses maintainers `bob`, `alice`, `bob`. Run `classify.ts` and assert `dist/harvest.json.publishers` is `['alice', 'bob']`, while the persistent vocabulary is still empty.
- Feed that exact handoff to `build.ts --harvest-from`. Reject every npm fetch in the build fixture, proving that the handoff path ran. Assert the persistent vocabulary is now `['alice', 'bob']` and the log reports `publisher vocabulary 0 -> 2`.
- Run the classifier again from that persisted state with an over-window keyword fixture and no new username observations. Assert it probes the seeded `maintainer:alice` and `maintainer:bob` cells. Pass its handoff through the build and assert neither old username is lost.
- As a control, run the build's direct harvest from the same initial state and search fixtures. Its persisted vocabulary must match the classifier/handoff path byte for byte.
- An older handoff with no `publishers` field preserves prior state. A present field that is `null`, a string, or an array containing an invalid username throws before any registry artifact is written.
- Extend the workflow test so the new write is discovered and staged in **Commit the snapshot**, after `build:catalog`. Include the publisher file in the existing local Git fixture to verify its changed bytes reach the snapshot commit.

The empty-state parse/merge test from Task 1 remains useful, but it cannot establish any of these entry-point or persistence properties.

- [ ] **Step 2: Run it to make sure it fails**

Run: `NODE_DISABLE_COMPILE_CACHE=1 pnpm exec vitest run registry/scripts/tests/publisher-handoff.test.ts registry/scripts/tests/workflow.test.ts --no-cache`
Expected: FAIL — the classifier drops its observations, the handoff build has no publisher writer, and the snapshot does not stage the file. A test that only round-trips an empty `PublisherState` will already pass and is insufficient here.

- [ ] **Step 3: Write the wiring**

Create `registry/publisher-state.json`:

```json
{
  "publishers": []
}
```

In `build.ts`, read state and initialize observations **before** `if (harvestFrom === undefined)`, so both branches share them:

```ts
const publisherStatePath = join(REGISTRY_DIR, 'publisher-state.json')
const priorPublishers = existsSync(publisherStatePath)
  ? parsePublisherState(readFileSync(publisherStatePath, 'utf8'))
  : { publishers: [] }
const sawPublishers = new Set<string>()
```

The direct-harvest branch passes its observations and seed into the search:

```ts
const names = await searchByKeywords(
  fetch, undefined, npmToken, undefined, undefined,
  s => shortfalls.push(s),
  users => { for (const u of users) sawPublishers.add(u) },
  priorPublishers.publishers,
)
```

In the handoff branch, add `publishers?: unknown` to the parsed shape and validate a present field with the same parser used for persisted state. Absence supports older handoffs and means there are no new observations; a malformed present value must not silently become an empty list:

```ts
if (parsed.publishers !== undefined) {
  const observed = parsePublisherState(JSON.stringify({ publishers: parsed.publishers }))
  for (const username of observed.publishers) sawPublishers.add(username)
}
```

In the **common successful artifact block**, beside the `first-seen.yml` write, merge and persist once. Keep this outside both harvest branches:

```ts
const nextPublishers = mergePublishers(priorPublishers, sawPublishers)
writeFileSync(publisherStatePath, serializePublisherState(nextPublishers))
process.stderr.write(
  `npm: publisher vocabulary ${priorPublishers.publishers.length} -> ${nextPublishers.publishers.length}\n`)
```

Import `mergePublishers`, `parsePublisherState` and `serializePublisherState` into `build.ts` from `./publisher-state.ts`.

In `classify.ts`, import `parsePublisherState`, read the same prior state and collect `sawPublishers` with the search call above. It owns the observations in the handoff; `build.ts` owns the persistent file. Extend the existing handoff write, retaining candidates, rejections and shortfalls:

```ts
const publishers = [...sawPublishers].sort()
writeFileSync(join(DIST_DIR, 'harvest.json'),
  `${JSON.stringify({ candidates, rejections, shortfalls, publishers })}\n`)
```

Update the existing handoff assertion in `repo-guards.test.ts` for the extended payload, retaining its check that shortfalls survive. The integration tests above must verify both shortfalls and publishers in the real handoff and build output.

Finally, add `registry/publisher-state.json` to **Commit the snapshot** in `.github/workflows/daily.yml`:

```bash
git add registry/snapshots/manifest.lock registry/repo-state.json registry/first-seen.yml registry/publisher-state.json
```

Keep the existing event/ref guard, step ordering, scoped credentials and rebase conflict checks. The classifier commit must leave the publisher file for the snapshot commit, just as it leaves `first-seen.yml`. Ensure `workflow.test.ts` discovers the new `publisherStatePath` write; if its source parser does not recognize this shape, extend the parser and its fixture rather than exempting the file. A PR run proves the handoff and file write; persistence across GitHub runs is verified after merge, when the existing snapshot step is allowed to commit to `main`.

Add the amendment to the design doc, after the 2026-09-08 follow-up:

```markdown
**Amendment (2026-09-08, publisher axis): `maintainer:` cells supplement the refinement list, seeded from every page the harvest reads and persisted across runs.**

A `keywords:<harvest>,<refinement>` cell cannot reach a package carrying only the harvest keyword; `keywords:<harvest> maintainer:<user>` has no such blind spot, because every package has a maintainer. It has a different limitation — a cell can only be built for a publisher already SEEN — so it is a supplement, and the measurement says so: window-seeded publisher cells recover 95 of 157 where the refinement list recovers 156 of 157. What they uniquely reach is the family event: one publisher releasing together, ranking together at the bottom, sharing no tag. The `sayedev` incident was exactly that, and 14 of its 20 packages were already visible, so the cell was derivable from what the harvest had already read.

The vocabulary is free (search responses carry `maintainers`), collected from EVERY cell rather than only the over-window one (`keywords:dsh-plugin` is fully enumerable today and adds 349 maintainers the harness window never shows), and persisted in `registry/publisher-state.json` — a committed, sorted, deterministic build input in the shape of `repo-state.json`, monotonic because the window that discovers a publisher is a shrinking fraction of the keyword. Probes are bounded by `PUBLISHER_PROBE_BUDGET_DEFAULT`; a run that hits the ceiling is partial, not wrong, and the 2026-09-08 coverage arithmetic still decides whether it may publish.

CI carries observed usernames in the classifier's `dist/harvest.json`. The build merges them with prior state after either its direct harvest or the handoff branch, and the snapshot commit stages the vocabulary after the build writes it. Thus the next run receives the publishers discovered by the previous one even though CI never executes the build's direct npm search.
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `NODE_DISABLE_COMPILE_CACHE=1 pnpm exec vitest run --no-cache` and `pnpm typecheck`.
Expected: PASS, whole registry suite. Mutation-check the handoff field, the common writer placement and the workflow staging independently: dropping the field, moving the writer into the direct-harvest branch, or removing the staged path must fail the corresponding test. Save the working source before each mutation and restore those exact bytes in a `finally` block; do not restore from HEAD while the implementation is uncommitted. Keep Vitest and Node compile caches disabled, clear any experiment cache, and restore before the next run. Do **not** run `pnpm build:catalog` locally — the PR's `build` job provides the live dry run.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/build.ts registry/scripts/src/classify.ts \
        registry/publisher-state.json registry/scripts/tests/publisher-handoff.test.ts \
        registry/scripts/tests/workflow.test.ts registry/scripts/tests/repo-guards.test.ts \
        .github/workflows/daily.yml \
        docs/design/2026-08-18-dsh-plugin-shop-design.md
git commit -m "feat(harvest): persist the publisher vocabulary across runs

classify.ts carries publisher observations in the harvest handoff. build.ts
merges and writes them after either harvest path, and the snapshot commit
records the vocabulary for the next run."
```

---

## What this plan deliberately does NOT do

Recorded so a later reader does not mistake an omission for an oversight.

- **It does not iterate to a fixpoint.** Recovered packages name maintainers the vocabulary lacks, and re-probing with them would recover more. One pass plus persistence reaches the same place over days at a fraction of the per-run cost.
- **It does not touch the GitHub half.** `harvestRepos` has its own windowed search with its own splitting; nothing here applies to it.
- **It does not replace `PARTITION_KEYWORDS`.** The refinement list recovers 99.4% and this axis 60.5%; removing it would make coverage worse.
- **It does not pursue the replication feed.** `replicate.npmjs.com` is alive and is the only provably complete route, at 165,689 changes/day — two orders of magnitude above an npm-side run today. That is its own project, and the follow-up amendment records the price so the next discussion starts from it.

## Verification the whole plan is done

- `pnpm exec vitest run` — registry suite green.
- `pnpm typecheck` — clean.
- The PR's `build` job completes its handoff build and writes a non-empty `registry/publisher-state.json`; the log shows `publisher vocabulary 0 -> N` with N in the thousands for the initial empty state.
- After merge, the first successful `main` run commits that non-empty file. The next run reads it and probes publisher cells; a PR dry run does not exercise the guarded snapshot push.
- The build report's npm line still distinguishes the two shortfall causes (PR #26's `describeShortfall`), and `recovered` has risen against the same `unreachable`.
