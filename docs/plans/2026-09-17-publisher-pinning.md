# Publisher Pinning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the npm harvest's publisher axis a per-keyword memory of which maintainer cells are worth probing, and seed that memory from data the harvest already holds, before `keywords:dsh-plugin` crosses the search window.

**Architecture:** All policy goes in the pure module `registry/scripts/src/publisher-state.ts` — which names are at risk, who gets pinned, what order the budget is spent in. `registry/scripts/src/npm-client.ts` keeps every request and none of the decisions; its paging loop starts reading the `keywords` field it already fetches, and its cell selection calls the pure chooser instead of walking the vocabulary itself. State rides in `registry/publisher-state.json` as a new `pinned` map, keyed by harvest keyword.

**Tech Stack:** TypeScript (ESM, `--experimental-strip-types`), vitest, pnpm.

**Spec:** [`docs/design/2026-09-17-publisher-pinning.md`](../design/2026-09-17-publisher-pinning.md)

## Global Constraints

Copied from `CLAUDE.md` and the spec. Every task's requirements implicitly include this section.

- **ESM everywhere.** Local relative imports carry the `.ts` extension: `import { x } from './publisher-state.ts'`.
- **`strict` and `noUncheckedIndexedAccess` are on.** Guard every index access; never assert it away with `!`.
- **Pure core, impure shell.** `publisher-state.ts` is pure: no clock, no network, no filesystem, no environment, **and no locale**. Sort with `compareStrings` from `./identity.ts`, never `localeCompare`. `npm-client.ts` is the shell. A policy decision that migrates into the shell becomes untestable.
- **Files end with exactly one trailing newline.**
- **Everything from npm is hostile.** Package names, keywords, and maintainer arrays are registry-controlled and reach a published artifact. Validate at that boundary; bound every array read off a search object.
- **Tests describe behavior.** Prefer a fixture over a mock; never mock the module under test. If a change makes a test obsolete, change it and say why in the commit.
- **Verify test-data arithmetic.** A fixture asserting a count must actually have that count.
- **The spec is the authority.** If implementation disagrees with `docs/design/2026-09-17-publisher-pinning.md`, either the code changes or the spec is amended in the same commit.
- **Commit messages: English, ASCII-only**, ending with the trailer `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- **Before every commit:** `pnpm test` and `pnpm typecheck` both green. Capture the exit code inside any redirect (`{ pnpm test 2>&1; echo "EXIT=$?"; } > log`) — a bare pipe reports 0 over a red run.
- **Never run `pnpm build:catalog` to check that a change compiles.** It is thousands of live requests and ~50 minutes. The tests cover every policy decision without a network.
- **Do not push to `main` without asking.** A push touching `registry/**` triggers a full catalog build that publishes to npm and GitHub Pages.

### Existing surface this plan builds on

Read before starting. Exact, as of `199e417`:

```ts
// registry/scripts/src/publisher-state.ts
import { compareStrings } from './identity.ts'
export const MAINTAINER_MAX_LENGTH = 64
export const MAX_PUBLISHERS = 20_000
export function isMaintainerName(value: unknown): value is string
export interface PublisherState {
  readonly publishers: readonly string[]
  readonly cursor?: number
}
export function parsePublisherState(raw: string): PublisherState
export function serializePublisherState(state: PublisherState): string
export function nextCursor(state: PublisherState, budget: number): number
export function mergePublishers(state: PublisherState, seen: readonly string[]): PublisherState

// registry/scripts/src/npm-client.ts
export const MAINTAINERS_MAX_COUNT = 128
export const PUBLISHER_PROBE_BUDGET_DEFAULT = 500
export const SEARCH_WINDOW = 5250
export const PARTITION_KEYWORDS: readonly string[]   // 27 entries
export const HARVEST_KEYWORDS: readonly string[]     // ['dsh-plugin', 'deepseek-harness']
export function maintainersOf(pkg: unknown): string[]
export async function searchByKeywords(
  fetchImpl?, sleep?, token?, backupRegistry?, timeoutMs?,
  onShortfall?: (s: KeywordShortfall) => void,
  onPublishers?: (usernames: readonly string[]) => void,
  publishers?: readonly string[],
  publisherProbeBudget?: number,
  publisherProbeOffset?: number,
): Promise<string[]>
```

`interface SearchBody` at `npm-client.ts:973`. The paging loop reads `maintainersOf(object?.package)` at `npm-client.ts:1719`. `selectPublisherCells` is a closure at `npm-client.ts:1791`. `build.ts:349` writes the cursor.

### File structure

| File | Responsibility | Change |
|---|---|---|
| `registry/scripts/src/publisher-state.ts` | All pinning policy, state shape, parse/serialize | Modify — grows `pinned`, `atRiskOwners`, `pinFor`, `unpinFor`, `probeOrder` |
| `registry/scripts/src/npm-client.ts` | Requests; reads `keywords`; calls the pure chooser | Modify — `keywordsOf`, `SearchBody`, seeding, selection, reporting |
| `registry/scripts/src/build.ts` | Persists state, writes the report | Modify — persist `pinned`, fix cursor advance, print the axis line |
| `registry/scripts/src/classify.ts` | Reads state for the CI harvest | Modify — print the axis line |
| `registry/scripts/tests/publisher-state.test.ts` | Pure policy tests | Modify |
| `registry/scripts/tests/npm-client.test.ts` | Harvest wiring tests | Modify |

---

### Task 1: Read `keywords` off a search object

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (`SearchBody` at :973, new `keywordsOf` beside `maintainersOf` at :1009)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export const KEYWORDS_MAX_COUNT = 128` and `export function keywordsOf(pkg: unknown): string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `registry/scripts/tests/npm-client.test.ts`, and add `KEYWORDS_MAX_COUNT, keywordsOf` to the existing import from `../src/npm-client.ts`:

```ts
describe('keywordsOf', () => {
  it('reads the keywords array off a search object', () => {
    expect(keywordsOf({ keywords: ['dsh-plugin', 'agent'] })).toEqual(['dsh-plugin', 'agent'])
  })

  it('is empty for anything that is not an object with an array', () => {
    expect(keywordsOf(null)).toEqual([])
    expect(keywordsOf('dsh-plugin')).toEqual([])
    expect(keywordsOf({})).toEqual([])
    // npm serves this: a single keyword as a bare string, not an array.
    expect(keywordsOf({ keywords: 'dsh-plugin' })).toEqual([])
  })

  it('drops entries that are not non-empty strings, keeping the rest', () => {
    expect(keywordsOf({ keywords: ['dsh', 42, null, '', { a: 1 }, 'mcp'] })).toEqual(['dsh', 'mcp'])
  })

  it('de-duplicates', () => {
    expect(keywordsOf({ keywords: ['dsh', 'dsh', 'mcp'] })).toEqual(['dsh', 'mcp'])
  })

  it('bounds the count, because the array is registry-controlled', () => {
    const many = Array.from({ length: KEYWORDS_MAX_COUNT + 50 }, (_, i) => `k${i}`)
    expect(keywordsOf({ keywords: many })).toHaveLength(KEYWORDS_MAX_COUNT)
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "keywordsOf"`
Expected: FAIL — `keywordsOf is not a function` / import error.

- [ ] **Step 3: Implement**

In `registry/scripts/src/npm-client.ts`, extend `SearchBody` (:973):

```ts
interface SearchBody {
  objects?: ({ package?: { name?: unknown; maintainers?: unknown; keywords?: unknown } | null } | null)[]
  total?: unknown
}
```

Add beside `maintainersOf`:

```ts
/**
 * Maximum keywords read off one search object, for the same reason as {@link
 * MAINTAINERS_MAX_COUNT}: the array is registry-controlled and one page is
 * bounded only by {@link MAX_SEARCH_BODY_BYTES}, which admits far more entries
 * than any real package carries.
 */
export const KEYWORDS_MAX_COUNT = 128

/**
 * The keywords one search object declares. The bytes are already fetched and
 * parsed — the paging loop reads {@link maintainersOf} off this same object —
 * so reading this field costs no request. It is what decides whether a name is
 * reachable by any refinement cell at all; see `atRiskOwners`.
 */
export function keywordsOf(pkg: unknown): string[] {
  if (typeof pkg !== 'object' || pkg === null) return []
  const raw = (pkg as { keywords?: unknown }).keywords
  if (!Array.isArray(raw)) return []
  const out = new Set<string>()
  for (const entry of raw.slice(0, KEYWORDS_MAX_COUNT)) {
    if (typeof entry === 'string' && entry.length > 0) out.add(entry)
  }
  return [...out]
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "keywordsOf"`
Expected: PASS, 5 tests.

- [ ] **Step 5: Full gate and commit**

```bash
{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="
pnpm typecheck
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(harvest): read the keywords a search object already carries

The paging loop reads maintainersOf off each search object and discards the
rest. keywords is in that same parsed object -- verified live 2026-09-17,
whose objects expose date, description, keywords, license, links,
maintainers, name, publisher, sanitized_name, version -- and it is what
decides whether a name is reachable by any refinement cell. SearchBody simply
did not name the field.

Bounded at 128 like MAINTAINERS_MAX_COUNT, for the same reason: the array is
registry-controlled and one page is capped only by MAX_SEARCH_BODY_BYTES.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The at-risk rule

**Files:**
- Modify: `registry/scripts/src/publisher-state.ts`
- Test: `registry/scripts/tests/publisher-state.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (this is pure and takes already-extracted arrays).
- Produces: `export interface HarvestedName { readonly keywords: readonly string[]; readonly maintainers: readonly string[] }` and `export function atRiskOwners(names: readonly HarvestedName[], harvestKeyword: string, refinements: readonly string[]): string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `registry/scripts/tests/publisher-state.test.ts`, extending the existing import:

```ts
const REFINEMENTS = ['dsh', 'dsh-plugin', 'deepseek-harness', 'agent', 'mcp']

describe('atRiskOwners', () => {
  it('returns the owners of names carrying no refinement beyond the harvest keyword', () => {
    const names = [
      { keywords: ['dsh-plugin'], maintainers: ['huanlin'] },
      { keywords: ['dsh-plugin', 'agent'], maintainers: ['covered'] },
    ]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['huanlin'])
  })

  it('does not count the other harvest keyword as bare: its intersection cell reaches the name', () => {
    const names = [{ keywords: ['dsh-plugin', 'deepseek-harness'], maintainers: ['reachable'] }]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual([])
  })

  it('ignores keywords that are not refinements, because no cell is built from them', () => {
    // `typescript` is not in PARTITION_KEYWORDS, so it buys no reachability.
    const names = [{ keywords: ['dsh-plugin', 'typescript'], maintainers: ['still-at-risk'] }]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['still-at-risk'])
  })

  it('returns every owner of an at-risk name, sorted and unique', () => {
    const names = [
      { keywords: ['dsh-plugin'], maintainers: ['zoe', 'adam'] },
      { keywords: ['dsh-plugin'], maintainers: ['adam'] },
    ]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['adam', 'zoe'])
  })

  it('drops owners that are not maintainer usernames', () => {
    const names = [{ keywords: ['dsh-plugin'], maintainers: ['ok', '', 'a'.repeat(200)] }]
    expect(atRiskOwners(names, 'dsh-plugin', REFINEMENTS)).toEqual(['ok'])
  })

  it('is empty when a name carries no keywords at all, which cannot be attributed', () => {
    // A name with no keywords did not reach the harvest through a keyword
    // search, so treating it as at-risk for this keyword is unfounded.
    expect(atRiskOwners([{ keywords: [], maintainers: ['x'] }], 'dsh-plugin', REFINEMENTS)).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run registry/scripts/tests/publisher-state.test.ts -t "atRiskOwners"`
Expected: FAIL — `atRiskOwners is not a function`.

- [ ] **Step 3: Implement**

Add to `registry/scripts/src/publisher-state.ts`:

```ts
/** One harvested name, reduced to the two fields the at-risk rule reads. */
export interface HarvestedName {
  readonly keywords: readonly string[]
  readonly maintainers: readonly string[]
}

/**
 * The maintainers of names that no refinement cell can reach.
 *
 * A `keywords:<harvest>,<refinement>` cell selects a name only if the name
 * carries that refinement. A name whose only listed refinement is the harvest
 * keyword itself is therefore reachable ONLY while its rank sits inside the
 * keyword's window, and passes permanently out of reach when the keyword
 * outgrows `SEARCH_WINDOW`. Those names are what the publisher axis exists
 * for, and their owners are what it has to know.
 *
 * RANK IS NOT PART OF THIS RULE. A name carrying a refinement is reachable at
 * any rank, so rank decides WHEN a name leaves reach and never WHICH names
 * can. Selecting by rank would also mean predicting future ranks, where the
 * rate-times-tail model over-predicted fivefold
 * (`docs/plans/2026-09-08-publisher-partition.md`); this rule is exact and
 * measurable while the keyword is still enumerable.
 *
 * A name carrying no keywords at all yields nothing: it did not reach the
 * harvest through a keyword search, so attributing it to this keyword's
 * residue is unfounded.
 */
export function atRiskOwners(
  names: readonly HarvestedName[],
  harvestKeyword: string,
  refinements: readonly string[],
): string[] {
  const refinementSet = new Set(refinements)
  const out = new Set<string>()
  for (const name of names) {
    if (name.keywords.length === 0) continue
    let covered = false
    for (const keyword of name.keywords) {
      if (keyword !== harvestKeyword && refinementSet.has(keyword)) {
        covered = true
        break
      }
    }
    if (covered) continue
    for (const owner of name.maintainers) {
      if (isMaintainerName(owner)) out.add(owner)
    }
  }
  return [...out].sort(compareStrings)
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run registry/scripts/tests/publisher-state.test.ts -t "atRiskOwners"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Full gate and commit**

```bash
{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="
pnpm typecheck
git add registry/scripts/src/publisher-state.ts registry/scripts/tests/publisher-state.test.ts
git commit -m "feat(harvest): name the owners no refinement cell can reach

A name whose only listed refinement is the harvest keyword itself is
reachable only while its rank is inside the window, and passes permanently
out of reach at the crossing. 81 of keywords:dsh-plugin's names are that
shape, held by 38 maintainers, one of whom holds 21.

Rank stays out of the rule: a name carrying a refinement is reachable at any
rank, so rank decides when a name leaves reach, never which names can.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `pinned` in the committed state

**Files:**
- Modify: `registry/scripts/src/publisher-state.ts` (`PublisherState`, `parsePublisherState`, `serializePublisherState`, `mergePublishers`)
- Test: `registry/scripts/tests/publisher-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PublisherState.pinned?: Readonly<Record<string, readonly string[]>>`, round-tripped, sorted, validated.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the pinned map in the committed state', () => {
  it('round-trips, sorted by keyword and by username', () => {
    const raw = JSON.stringify({
      publishers: ['a'], cursor: 0,
      pinned: { 'dsh-plugin': ['zoe', 'adam'], 'deepseek-harness': ['bob'] },
    })
    const state = parsePublisherState(raw)
    expect(state.pinned).toEqual({ 'deepseek-harness': ['bob'], 'dsh-plugin': ['adam', 'zoe'] })
    expect(JSON.parse(serializePublisherState(state)).pinned)
      .toEqual({ 'deepseek-harness': ['bob'], 'dsh-plugin': ['adam', 'zoe'] })
    // Key order is committed bytes, so assert the order and not just the value.
    expect(Object.keys(JSON.parse(serializePublisherState(state)).pinned))
      .toEqual(['deepseek-harness', 'dsh-plugin'])
  })

  it('reads a file written before pinned existed as having none', () => {
    expect(parsePublisherState(JSON.stringify({ publishers: ['a'] })).pinned).toEqual({})
  })

  it('throws on a pinned that is not an object of arrays', () => {
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: ['a'] })))
      .toThrow(/pinned must be an object/)
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: { k: 'a' } })))
      .toThrow(/pinned\["k"\] must be an array/)
  })

  it('throws on a pinned username outside the grammar, like publishers does', () => {
    expect(() => parsePublisherState(JSON.stringify({ publishers: [], pinned: { k: ['ok', ''] } })))
      .toThrow(/pinned\["k"\]\[1\] is not a maintainer username/)
  })

  it('de-duplicates within a keyword', () => {
    const state = parsePublisherState(JSON.stringify({ publishers: [], pinned: { k: ['a', 'a'] } }))
    expect(state.pinned).toEqual({ k: ['a'] })
  })

  it('serializes an empty pinned as an empty object, so the key is always present', () => {
    expect(JSON.parse(serializePublisherState({ publishers: [], cursor: 0 })).pinned).toEqual({})
  })

  it('rides through mergePublishers untouched', () => {
    const state: PublisherState = { publishers: ['a'], cursor: 3, pinned: { k: ['pinned-one'] } }
    expect(mergePublishers(state, ['b']).pinned).toEqual({ k: ['pinned-one'] })
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run registry/scripts/tests/publisher-state.test.ts -t "pinned map"`
Expected: FAIL — `state.pinned` is `undefined`.

- [ ] **Step 3: Implement**

In `publisher-state.ts`, extend the interface:

```ts
  /**
   * Maintainers pinned for one harvest keyword: probed on every run rather
   * than waited for by rotation.
   *
   * Keyed by harvest keyword because the cells are `{keywords: [K],
   * maintainer}` and so the verdict is per keyword — a maintainer pinned for
   * `dsh-plugin` must not be dropped because its `deepseek-harness` cell
   * supplied nothing. Optional because a file written before this existed
   * carries none, and absent means empty rather than malformed.
   */
  readonly pinned?: Readonly<Record<string, readonly string[]>>
```

Add a shared reader used by `parsePublisherState`:

```ts
function readPinned(parsed: unknown): Record<string, string[]> {
  const pinned = (parsed as { pinned?: unknown }).pinned
  if (pinned === undefined) return {}
  if (typeof pinned !== 'object' || pinned === null || Array.isArray(pinned)) {
    throw new Error('publisher-state.json: pinned must be an object')
  }
  const out: Record<string, string[]> = {}
  for (const keyword of Object.keys(pinned).sort(compareStrings)) {
    const users = (pinned as Record<string, unknown>)[keyword]
    if (!Array.isArray(users)) {
      throw new Error(`publisher-state.json: pinned[${JSON.stringify(keyword)}] must be an array`)
    }
    const kept = new Set<string>()
    users.forEach((user, i) => {
      if (!isMaintainerName(user)) {
        throw new Error(`publisher-state.json: pinned[${JSON.stringify(keyword)}][${i}] is not a maintainer username`)
      }
      kept.add(user)
    })
    out[keyword] = [...kept].sort(compareStrings)
  }
  return out
}
```

In `parsePublisherState`, return `{ publishers: [...out].sort(compareStrings), cursor: cursor ?? 0, pinned: readPinned(parsed) }`.

In `serializePublisherState`, build the map in sorted key order and emit it:

```ts
export function serializePublisherState(state: PublisherState): string {
  const publishers = [...state.publishers].sort(compareStrings)
  const pinned: Record<string, string[]> = {}
  for (const keyword of Object.keys(state.pinned ?? {}).sort(compareStrings)) {
    pinned[keyword] = [...(state.pinned?.[keyword] ?? [])].sort(compareStrings)
  }
  return `${JSON.stringify({ publishers, cursor: state.cursor ?? 0, pinned }, null, 2)}\n`
}
```

In `mergePublishers`, carry it: `return { publishers: ..., cursor: state.cursor ?? 0, pinned: state.pinned ?? {} }`.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run registry/scripts/tests/publisher-state.test.ts -t "pinned map"`
Expected: PASS, 7 tests.

- [ ] **Step 5: Full gate and commit**

```bash
{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="
pnpm typecheck
git add registry/scripts/src/publisher-state.ts registry/scripts/tests/publisher-state.test.ts
git commit -m "feat(harvest): carry a per-keyword pinned map in the committed state

Keyed by harvest keyword because a cell is {keywords: [K], maintainer}: a
maintainer pinned for dsh-plugin must not be dropped because its
deepseek-harness cell supplied nothing.

Sorted on both axes and always emitted, so the committed bytes do not depend
on insertion order and a diff shows a real change. Malformed shapes throw
with the keyword and index named, like publishers already does -- a file this
module refuses to read is a stop one run away from its cause.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Pin, unpin, and the probe order

**Files:**
- Modify: `registry/scripts/src/publisher-state.ts`
- Test: `registry/scripts/tests/publisher-state.test.ts`

**Interfaces:**
- Consumes: `PublisherState.pinned` from Task 3.
- Produces:
  - `export const MAX_PINNED_PER_KEYWORD: number` — half `PUBLISHER_PROBE_BUDGET_DEFAULT`, defined here as the literal `250` to keep this module free of an `npm-client.ts` import cycle, with a guard test tying the two together.
  - `export function pinFor(state, keyword, users): PublisherState`
  - `export function unpinFor(state, keyword, users): PublisherState`
  - `export function probeOrder(state, keyword, budget): { pinned: string[]; rotated: string[] }`

- [ ] **Step 1: Write the failing tests**

```ts
describe('MAX_PINNED_PER_KEYWORD', () => {
  it('is half the probe budget, so rotation always keeps half a run', () => {
    // Asserted as the relation, not the literal: the bound exists to stop
    // pinned probes starving rotation, and that property is what must hold if
    // the budget ever moves.
    expect(MAX_PINNED_PER_KEYWORD * 2).toBe(PUBLISHER_PROBE_BUDGET_DEFAULT)
  })
})

describe('pinFor and unpinFor', () => {
  it('adds, sorted and unique, without touching another keyword', () => {
    const state: PublisherState = { publishers: [], cursor: 0, pinned: { other: ['keepme'] } }
    const next = pinFor(state, 'dsh-plugin', ['zoe', 'adam', 'zoe'])
    expect(next.pinned).toEqual({ 'dsh-plugin': ['adam', 'zoe'], other: ['keepme'] })
  })

  it('refuses to grow a keyword past MAX_PINNED_PER_KEYWORD, keeping what it has', () => {
    const full = Array.from({ length: MAX_PINNED_PER_KEYWORD }, (_, i) => `u${String(i).padStart(5, '0')}`)
    const next = pinFor({ publishers: [], pinned: { k: full } }, 'k', ['newcomer'])
    expect(next.pinned?.k).toHaveLength(MAX_PINNED_PER_KEYWORD)
    expect(next.pinned?.k).not.toContain('newcomer')
  })

  it('drops names outside the grammar rather than committing a file it cannot read', () => {
    expect(pinFor({ publishers: [] }, 'k', ['ok', '']).pinned).toEqual({ k: ['ok'] })
  })

  it('unpins only the named users, and only for that keyword', () => {
    const state: PublisherState = { publishers: [], pinned: { k: ['a', 'b'], other: ['a'] } }
    expect(unpinFor(state, 'k', ['a']).pinned).toEqual({ k: ['b'], other: ['a'] })
  })

  it('drops a keyword whose last pin is removed, rather than leaving an empty array', () => {
    expect(unpinFor({ publishers: [], pinned: { k: ['a'] } }, 'k', ['a']).pinned).toEqual({})
  })
})

describe('probeOrder', () => {
  const vocabulary = Array.from({ length: 10 }, (_, i) => `u${i}`)

  it('puts the pinned first and rotates the rest from the cursor', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 2, pinned: { k: ['u7'] } }
    const order = probeOrder(state, 'k', 4)
    expect(order.pinned).toEqual(['u7'])
    // 4 budget minus 1 pinned leaves 3 rotated, starting at index 2.
    expect(order.rotated).toEqual(['u2', 'u3', 'u4'])
  })

  it('does not rotate to a publisher it already pinned, which would probe it twice', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 2, pinned: { k: ['u3'] } }
    const order = probeOrder(state, 'k', 4)
    expect(order.pinned).toEqual(['u3'])
    expect(order.rotated).toEqual(['u2', 'u4', 'u5'])
  })

  it('wraps the rotation past the end of the vocabulary', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 8 }
    expect(probeOrder(state, 'k', 4).rotated).toEqual(['u8', 'u9', 'u0', 'u1'])
  })

  it('ignores another keyword\'s pins', () => {
    const state: PublisherState = { publishers: vocabulary, cursor: 0, pinned: { other: ['u5'] } }
    const order = probeOrder(state, 'k', 2)
    expect(order.pinned).toEqual([])
    expect(order.rotated).toEqual(['u0', 'u1'])
  })

  it('never spends more than the budget in total', () => {
    const pinned = vocabulary.slice(0, 6)
    const order = probeOrder({ publishers: vocabulary, cursor: 0, pinned: { k: pinned } }, 'k', 4)
    expect(order.pinned.length + order.rotated.length).toBeLessThanOrEqual(4)
  })

  it('is empty on an empty vocabulary rather than looping', () => {
    expect(probeOrder({ publishers: [], cursor: 0 }, 'k', 5)).toEqual({ pinned: [], rotated: [] })
  })
})
```

Add `MAX_PINNED_PER_KEYWORD, pinFor, probeOrder, unpinFor` and the type `PublisherState` to the imports.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run registry/scripts/tests/publisher-state.test.ts -t "probeOrder"`
Expected: FAIL — `probeOrder is not a function`.

- [ ] **Step 3: Implement**

```ts
/**
 * How many maintainers one keyword may pin.
 *
 * Half {@link PUBLISHER_PROBE_BUDGET_DEFAULT}, so pinned probes can never take
 * more than half a run and rotation always keeps the other half: the axis
 * degrades under a large pinned set, it never starves. Written as a literal
 * rather than imported from `npm-client.ts`, which would make this pure module
 * depend on the shell; `publisher-state.test.ts` asserts the relation instead.
 *
 * At-risk names are ~2% of a keyword's names and the keyword grows ~70 a day,
 * so a pinned set grows by roughly one owner a day and this bound is months
 * out. It is here so that horizon is a bound and not a cliff, and a set AT the
 * bound is reported (see `describePublisherAxis`) because at that point new
 * residue owners are being refused.
 */
export const MAX_PINNED_PER_KEYWORD = 250

/** The state plus `users` pinned for `keyword`; filtered, unique, sorted, bounded. */
export function pinFor(state: PublisherState, keyword: string, users: readonly string[]): PublisherState {
  const pinned: Record<string, string[]> = {}
  for (const key of Object.keys(state.pinned ?? {})) pinned[key] = [...(state.pinned?.[key] ?? [])]
  const kept = new Set(pinned[keyword] ?? [])
  for (const user of users) {
    if (kept.size >= MAX_PINNED_PER_KEYWORD) break
    if (isMaintainerName(user)) kept.add(user)
  }
  // Re-bounded after the merge: a state handed in already over the bound must
  // not be grown by this call, and `Set` insertion cannot be relied on to stop
  // at the limit when the incoming names were already present.
  pinned[keyword] = [...kept].sort(compareStrings).slice(0, MAX_PINNED_PER_KEYWORD)
  return { ...state, pinned }
}

/** The state with `users` no longer pinned for `keyword`. */
export function unpinFor(state: PublisherState, keyword: string, users: readonly string[]): PublisherState {
  const pinned: Record<string, string[]> = {}
  for (const key of Object.keys(state.pinned ?? {})) pinned[key] = [...(state.pinned?.[key] ?? [])]
  const drop = new Set(users)
  const kept = (pinned[keyword] ?? []).filter(user => !drop.has(user))
  if (kept.length === 0) delete pinned[keyword]
  else pinned[keyword] = kept
  return { ...state, pinned }
}

/**
 * Which publishers this run probes for `keyword`, in order.
 *
 * Pinned first and always; the rotation spends what is left of the budget,
 * starting at the cursor and skipping anyone already pinned — probing one
 * publisher twice in a run would spend budget to learn nothing.
 *
 * The rotation length is what the cursor must advance by. Advancing by the
 * BUDGET instead would skip `pinned.length` publishers every snapshot,
 * permanently and silently: the vocabulary grows, every build is green, and a
 * band of the vocabulary is never rotated to.
 */
export function probeOrder(
  state: PublisherState, keyword: string, budget: number,
): { pinned: string[]; rotated: string[] } {
  const size = state.publishers.length
  if (size === 0 || budget <= 0) return { pinned: [], rotated: [] }
  const pinnedAll = state.pinned?.[keyword] ?? []
  const pinned = [...pinnedAll].slice(0, Math.min(budget, MAX_PINNED_PER_KEYWORD))
  const already = new Set(pinned)
  const rotated: string[] = []
  const start = (state.cursor ?? 0) % size
  let stepped = 0
  while (pinned.length + rotated.length < budget && stepped < size) {
    const candidate = state.publishers[(start + stepped) % size]
    stepped++
    if (candidate === undefined || already.has(candidate)) continue
    already.add(candidate)
    rotated.push(candidate)
  }
  return { pinned, rotated }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run registry/scripts/tests/publisher-state.test.ts`
Expected: PASS, all cases including the pre-existing ones.

- [ ] **Step 5: Full gate and commit**

```bash
{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="
pnpm typecheck
git add registry/scripts/src/publisher-state.ts registry/scripts/tests/publisher-state.test.ts
git commit -m "feat(harvest): choose the probe order in the pure module

Pinned first and always, rotation spending what is left and skipping anyone
already pinned. The rotation length is the number the cursor must advance by;
advancing by the budget would skip pinned.length publishers every snapshot,
permanently and invisibly.

MAX_PINNED_PER_KEYWORD is half the probe budget so pinned probes can never
take more than half a run. It is a literal here rather than an import,
because this module is pure and npm-client.ts is the shell; the test asserts
the relation between the two instead.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Seed the at-risk owners during the harvest

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (paging loop at :1719, `searchByKeywords` signature)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `keywordsOf` (Task 1), `atRiskOwners`, `HarvestedName` (Task 2).
- Produces: `export interface PublisherAxisReport { keyword: string; vocabulary: number; pinnedProbed: number; pinnedSupplied: number; rotatedProbed: number; rotatedSupplied: number; suppliedNames: number; seeded: readonly string[]; atRiskNames: number; pinnedFull: boolean }` and an `onPublisherAxis: (report: PublisherAxisReport) => void` parameter appended to `searchByKeywords`.

- [ ] **Step 1: Write the failing test**

```ts
describe('the publisher axis seeds at-risk owners while a keyword is enumerable', () => {
  it('reports the owners of names carrying only the harvest keyword', async () => {
    const reports: PublisherAxisReport[] = []
    // Under the window, so no partition and no probing: seeding is the only
    // thing the axis does here, which is the state dsh-plugin is in today.
    const fetchImpl = stubSearchWithPackages({
      'keywords:dsh-plugin': [
        { name: 'bare', keywords: ['dsh-plugin'], maintainers: ['huanlin'] },
        { name: 'covered', keywords: ['dsh-plugin', 'agent'], maintainers: ['other'] },
      ],
      'keywords:deepseek-harness': [],
    })
    await searchByKeywords(
      fetchImpl, undefined, undefined, undefined, undefined,
      () => {}, () => {}, [], PUBLISHER_PROBE_BUDGET_DEFAULT, 0,
      r => reports.push(r),
    )
    const dshPlugin = reports.find(r => r.keyword === 'dsh-plugin')
    expect(dshPlugin?.seeded).toEqual(['huanlin'])
    expect(dshPlugin?.atRiskNames).toBe(1)
  })
})
```

Add a `stubSearchWithPackages` helper beside the existing `stubSearch` in the same file, so a fixture can carry keywords and maintainers rather than bare names:

```ts
/**
 * Like `stubSearch`, but each page carries whole package objects so a fixture
 * can exercise the keywords and maintainers the at-risk rule reads. `total`
 * answers the full list, so paging terminates the way production does.
 */
function stubSearchWithPackages(
  pages: Record<string, { name: string; keywords: string[]; maintainers: string[] }[]>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const text = url.searchParams.get('text') ?? ''
    const from = Number(url.searchParams.get('from') ?? '0')
    const all = pages[text] ?? []
    const objects = all.slice(from, from + 250).map(pkg => ({
      package: {
        name: pkg.name,
        keywords: pkg.keywords,
        maintainers: pkg.maintainers.map(username => ({ username })),
      },
    }))
    return new Response(JSON.stringify({ objects, total: all.length }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "seeds at-risk owners"`
Expected: FAIL — `searchByKeywords` takes no eleventh argument; `PublisherAxisReport` is not exported.

- [ ] **Step 3: Implement**

Add the report type near `KeywordShortfall`:

```ts
/**
 * What the publisher axis did for one keyword in one run.
 *
 * The INPUTS are carried, not only the results. An empty vocabulary is a legal
 * no-op — 0.8.1 shipped one and CI was green while the axis did nothing — so
 * `vocabulary: 0` has to be reportable as a value rather than as an absent
 * line.
 */
export interface PublisherAxisReport {
  readonly keyword: string
  readonly vocabulary: number
  readonly pinnedProbed: number
  readonly pinnedSupplied: number
  readonly rotatedProbed: number
  readonly rotatedSupplied: number
  readonly suppliedNames: number
  /** At-risk owners observed this run, for the caller to pin. */
  readonly seeded: readonly string[]
  readonly atRiskNames: number
  readonly pinnedFull: boolean
}
```

Append the parameter to `searchByKeywords`:

```ts
  onPublisherAxis: (report: PublisherAxisReport) => void = () => {},
  pinned: Readonly<Record<string, readonly string[]>> = {},
```

In the paging loop at :1719, collect the package shape alongside the owners. Declare `const harvested: HarvestedName[] = []` in the same scope as `forKeyword`, and inside the `for (const object of objects)` loop, after `const owners = maintainersOf(object?.package)`:

```ts
        // The at-risk rule reads these two fields off the object the loop
        // already holds; `keywordsOf` starts no request.
        harvested.push({ keywords: keywordsOf(object?.package), maintainers: owners })
```

After `enumerate()` completes for the keyword and before `onShortfall` is called, compute and report:

```ts
    const seeded = atRiskOwners(harvested, keyword, PARTITION_KEYWORDS)
    onPublisherAxis({
      keyword,
      vocabulary: publishers.length,
      pinnedProbed: 0, pinnedSupplied: 0, rotatedProbed: 0, rotatedSupplied: 0, suppliedNames: 0,
      seeded,
      atRiskNames: harvested.filter(n => atRiskOwners([n], keyword, PARTITION_KEYWORDS).length > 0).length,
      pinnedFull: (pinned[keyword] ?? []).length >= MAX_PINNED_PER_KEYWORD,
    })
```

The probe counts stay zero here and are filled in by Task 6, which is the task that does the probing.

- [ ] **Step 4: Run the test and verify it passes**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "seeds at-risk owners"`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="
pnpm typecheck
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(harvest): seed at-risk owners from the pages already fetched

The productivity signal the publisher axis selects on cannot exist before a
keyword crosses the window: under it the sweep serves every name, so
cellTotal > servedFor.size is false for everyone and selectPublisherCells is
not even called. So the set of owners the axis will need is learned here
instead, from the keywords field on pages the harvest already pages in full.

No request is added. The seeding half is available to a keyword exactly once,
in the interval before it crosses.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Probe the pinned first, and pin by outcome

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (`selectPublisherCells` at :1791)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `probeOrder` (Task 4), `PublisherAxisReport` (Task 5).
- Produces: `PublisherAxisReport` with real probe counts, plus `evicted: readonly string[]` added to that interface.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the publisher axis probes its pinned set first', () => {
  it('probes a pinned publisher the rotation would not have reached', async () => {
    const probed: string[] = []
    const reports: PublisherAxisReport[] = []
    const vocabulary = Array.from({ length: 100 }, (_, i) => `u${String(i).padStart(3, '0')}`)
    const fetchImpl = recordingProbeStub(probed)
    await searchByKeywords(
      fetchImpl, undefined, undefined, undefined, undefined,
      () => {}, () => {}, vocabulary, 3, 0,
      r => reports.push(r),
      { 'deepseek-harness': ['u099'] },
    )
    // Cursor 0 and a budget of 3 reaches u000..u001 by rotation; u099 is
    // reached only because it is pinned.
    expect(probed).toContain('u099')
    const report = reports.find(r => r.keyword === 'deepseek-harness')
    expect(report?.pinnedProbed).toBe(1)
    expect(report?.rotatedProbed).toBe(2)
  })

  it('evicts a pinned publisher whose cell total is zero, and only that one', async () => {
    const reports: PublisherAxisReport[] = []
    const fetchImpl = probeStubWithTotals({ 'u001': 0, 'u002': 4 })
    await searchByKeywords(
      fetchImpl, undefined, undefined, undefined, undefined,
      () => {}, () => {}, ['u001', 'u002'], 2, 0,
      r => reports.push(r),
      { 'deepseek-harness': ['u001', 'u002'] },
    )
    expect(reports.find(r => r.keyword === 'deepseek-harness')?.evicted).toEqual(['u001'])
  })

  it('does not evict a pinned publisher that merely supplied nothing', async () => {
    // The seeded set supplies nothing on every run until the crossing. A rule
    // that evicted on "supplied nothing" would empty the pinned set during
    // exactly the days it exists to prepare for.
    const reports: PublisherAxisReport[] = []
    const fetchImpl = probeStubWithTotals({ 'u001': 4 })
    await searchByKeywords(
      fetchImpl, undefined, undefined, undefined, undefined,
      () => {}, () => {}, ['u001'], 2, 0,
      r => reports.push(r),
      { 'deepseek-harness': ['u001'] },
    )
    expect(reports.find(r => r.keyword === 'deepseek-harness')?.evicted).toEqual([])
  })
})
```

Write `recordingProbeStub(probed: string[])` and `probeStubWithTotals(totals: Record<string, number>)` beside the other stubs: both answer any `keywords:*` window query with a total past `SEARCH_WINDOW` so the keyword partitions, and answer a `maintainer:<user>` query by recording the user and returning the given total (default `0`).

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "probes its pinned set first"`
Expected: FAIL — `searchByKeywords` ignores the pinned argument; `report.evicted` is undefined.

- [ ] **Step 3: Implement**

Add `readonly evicted: readonly string[]` to `PublisherAxisReport`.

Replace the vocabulary walk in `selectPublisherCells` with the pure chooser, keeping every existing filter:

```ts
    const selectPublisherCells = async (): Promise<Cell[]> => {
      const selected: Cell[] = []
      const order = probeOrder({ publishers, cursor: publisherProbeOffset, pinned }, keyword, publisherProbeBudget)
      rotatedProbed = order.rotated.length
      pinnedProbed = order.pinned.length
      for (const [source, users] of [['pinned', order.pinned], ['rotated', order.rotated]] as const) {
        for (const maintainer of users) {
          const cell: Cell = { keywords: [keyword], maintainer }
          const cellTotal = await probe(cell)
          // Exit is this and nothing else: the publisher no longer publishes
          // under this keyword. A cell that merely supplied nothing is not
          // evicted, because a seeded cell supplies nothing on every run until
          // the keyword crosses.
          if (cellTotal === 0) {
            if (source === 'pinned') evicted.push(maintainer)
            continue
          }
          if (cellTotal > SEARCH_WINDOW) continue
          if (cellTotal <= (servedFor.get(maintainer)?.size ?? 0)) continue
          selected.push(cell)
          if (source === 'rotated') earned.push(maintainer)
        }
      }
      return selected
    }
```

Declare `let pinnedProbed = 0`, `let rotatedProbed = 0`, `const evicted: string[] = []` and `const earned: string[] = []` in the enclosing per-keyword scope, and carry `evicted` plus `earned` (merged into `seeded`) and the two probe counts into the `onPublisherAxis` call added in Task 5.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts`
Expected: PASS, including every pre-existing publisher-axis case.

- [ ] **Step 5: Full gate and commit**

```bash
{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="
pnpm typecheck
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(harvest): probe the pinned set first, and pin what the rotation earns

selectPublisherCells walked the vocabulary itself, which made its selection
reachable only through a stubbed searchByKeywords and is why no measurement
of how many cells it selects exists anywhere. It now calls the pure chooser
and keeps every filter it had.

Eviction is cellTotal === 0 and nothing else. A rule evicting on 'supplied
nothing' would empty the seeded set during exactly the days before a
crossing, and would pass every fixture written past the window.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Persist the pins, and advance the cursor by what rotated

**Files:**
- Modify: `registry/scripts/src/publisher-state.ts` (`nextCursor`), `registry/scripts/src/build.ts:349`, `registry/scripts/src/classify.ts`
- Test: `registry/scripts/tests/publisher-state.test.ts`, `registry/scripts/tests/publisher-handoff.test.ts`

**Interfaces:**
- Consumes: `PublisherAxisReport` (Tasks 5-6), `pinFor`/`unpinFor` (Task 4).
- Produces: `nextCursor(state, rotated)` documented as taking the rotation count; `build.ts` writing `pinned`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('the cursor advances by what actually rotated', () => {
  it('advances by the rotation count, not by the budget', () => {
    const publishers = Array.from({ length: 100 }, (_, i) => `u${String(i).padStart(3, '0')}`)
    const state: PublisherState = { publishers, cursor: 0, pinned: { k: ['u099'] } }
    const order = probeOrder(state, 'k', 10)
    expect(order.rotated).toHaveLength(9)
    // Advancing by the budget would land on 10 and skip u009 forever.
    expect(nextCursor(state, order.rotated.length)).toBe(9)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npx vitest run registry/scripts/tests/publisher-state.test.ts -t "advances by what actually rotated"`
Expected: FAIL — `probeOrder` is fine but `nextCursor` is still called with a budget at the only call site; this test pins the relation and will pass once the call site is corrected in Step 3. If it passes immediately, the assertion is wrong — check that `order.rotated` really is 9.

- [ ] **Step 3: Implement**

Rename the parameter and rewrite the doc comment in `publisher-state.ts`:

```ts
/**
 * Where the next run should start, given how many publishers this one
 * ROTATED to — not how large its budget was.
 *
 * Pinned probes do not advance the rotation: they are probed every run by
 * definition, so counting them here would step the cursor past
 * `pinned.length` publishers per snapshot, permanently and silently. The
 * vocabulary would grow, every build would stay green, and a band of it would
 * never be probed.
 */
export function nextCursor(state: PublisherState, rotated: number): number {
  const size = state.publishers.length
  if (size <= rotated || rotated <= 0) return 0
  return ((state.cursor ?? 0) + rotated) % size
}
```

In `build.ts`, collect the reports (`const axis: PublisherAxisReport[] = []`, passed as the `onPublisherAxis` argument), then replace the write at :349:

```ts
  let nextState = mergePublishers(priorPublishers, [...sawPublishers])
  let rotated = 0
  for (const report of axis) {
    nextState = pinFor(nextState, report.keyword, report.seeded)
    nextState = unpinFor(nextState, report.keyword, report.evicted)
    rotated = Math.max(rotated, report.rotatedProbed)
  }
  writeFileSync(publisherStatePath, serializePublisherState({
    ...nextState,
    cursor: nextCursor(nextState, rotated),
  }))
```

`Math.max` and not a sum: the cursor is one position in one shared vocabulary, and each keyword rotates its own slice from it, so the furthest any keyword walked is what the next run must start past.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="`
Expected: PASS. `publisher-handoff.test.ts` and `publisher-state.test.ts` both exercise this file; if a pre-existing case asserted `nextCursor(state, PUBLISHER_PROBE_BUDGET_DEFAULT)`, update it to pass a rotation count and say so in the commit.

- [ ] **Step 5: Full gate and commit**

```bash
pnpm typecheck
git add registry/scripts/src/publisher-state.ts registry/scripts/src/build.ts registry/scripts/src/classify.ts registry/scripts/tests/
git commit -m "fix(harvest): advance the rotation by what rotated, and persist the pins

nextCursor took a budget, and the only call site passed
PUBLISHER_PROBE_BUDGET_DEFAULT. With a pinned set that is wrong by
pinned.length every snapshot: pinned publishers are probed every run by
definition and do not consume rotation, so counting them steps the cursor
past a band of the vocabulary that is then never probed -- silently, with
every build green.

The parameter is renamed to rotated so the call site has to say what it
means. build.ts takes the furthest distance any keyword rotated, because the
cursor is one position in one shared vocabulary.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Report what the axis did, and prove the crossing

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (new `describePublisherAxis`), `registry/scripts/src/build.ts`, `registry/scripts/src/classify.ts`
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `PublisherAxisReport` (Tasks 5-6).
- Produces: `export function describePublisherAxis(report: PublisherAxisReport): string`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('describePublisherAxis', () => {
  it('names the inputs, not only the results, so an inert axis is visible', () => {
    const line = describePublisherAxis({
      keyword: 'dsh-plugin', vocabulary: 0,
      pinnedProbed: 0, pinnedSupplied: 0, rotatedProbed: 0, rotatedSupplied: 0,
      suppliedNames: 0, seeded: [], atRiskNames: 0, evicted: [], pinnedFull: false,
    })
    // 0.8.1 shipped an empty vocabulary and CI was green while the axis did
    // nothing. `vocabulary 0` has to be a printed value, not an absent line.
    expect(line).toContain('vocabulary 0')
  })

  it('reports a full pinned set, because new residue owners are then refused', () => {
    const line = describePublisherAxis({
      keyword: 'dsh-plugin', vocabulary: 3775,
      pinnedProbed: 250, pinnedSupplied: 4, rotatedProbed: 250, rotatedSupplied: 1,
      suppliedNames: 9, seeded: [], atRiskNames: 81, evicted: [], pinnedFull: true,
    })
    expect(line).toMatch(/pinned set is FULL/)
  })
})

describe('the crossing', () => {
  it('keeps a seeded owner pinned and probed after the keyword crosses the window', async () => {
    // The case the whole design exists for, and the only one that catches a
    // miss-counting eviction rule: a fixture written entirely past the window
    // agrees with the wrong rule.
    const under = stubSearchWithPackages({
      'keywords:dsh-plugin': [{ name: 'bare', keywords: ['dsh-plugin'], maintainers: ['huanlin'] }],
      'keywords:deepseek-harness': [],
    })
    const seedReports: PublisherAxisReport[] = []
    await searchByKeywords(under, undefined, undefined, undefined, undefined,
      () => {}, () => {}, [], 500, 0, r => seedReports.push(r), {})
    const seeded = seedReports.find(r => r.keyword === 'dsh-plugin')?.seeded ?? []
    expect(seeded).toEqual(['huanlin'])

    // Same owner, now past the window: it must still be probed.
    const probed: string[] = []
    const over = recordingProbeStub(probed)
    await searchByKeywords(over, undefined, undefined, undefined, undefined,
      () => {}, () => {}, ['zzz-unrelated'], 1, 0,
      () => {}, { 'dsh-plugin': [...seeded] })
    expect(probed).toContain('huanlin')
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "describePublisherAxis"`
Expected: FAIL — `describePublisherAxis is not a function`.

- [ ] **Step 3: Implement**

```ts
/**
 * One skimmable line naming what the publisher axis did for one keyword.
 *
 * The inputs are printed beside the results. An empty vocabulary is a legal
 * no-op and shipped once as one, green, proving nothing; a reader has to be
 * able to tell "did nothing because there was nothing to do" from "did nothing
 * because it is broken", and only the inputs answer that.
 */
export function describePublisherAxis(report: PublisherAxisReport): string {
  const parts = [
    `vocabulary ${report.vocabulary}`,
    `${report.pinnedProbed} pinned probed (${report.pinnedSupplied} supplied)`,
    `${report.rotatedProbed} rotated (${report.rotatedSupplied} supplied)`,
    `${report.suppliedNames} name(s) recovered`,
  ]
  if (report.seeded.length > 0) parts.push(`seeded ${report.seeded.length} owner(s) from ${report.atRiskNames} at-risk name(s)`)
  if (report.evicted.length > 0) parts.push(`unpinned ${report.evicted.length} with no package left`)
  if (report.pinnedFull) parts.push(`pinned set is FULL at ${MAX_PINNED_PER_KEYWORD} — new residue owners are being refused`)
  return `${keywordQuery([report.keyword])} publisher axis — ${parts.join(', ')}`
}
```

In `classify.ts`, beside the existing shortfall loop:

```ts
  for (const report of axis) {
    process.stderr.write(`classify: ${describePublisherAxis(report)}\n`)
  }
```

In `build.ts`, do the same with the `npm:` prefix and push each line into `npmParts` so it reaches the published build report.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate and commit**

```bash
{ pnpm test 2>&1; echo "EXIT=$?"; } | grep -E "Tests |EXIT="
pnpm typecheck
git add registry/scripts/src/npm-client.ts registry/scripts/src/build.ts registry/scripts/src/classify.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(harvest): report what the publisher axis did, and test the crossing

The axis emitted one line, the vocabulary size before and after, and said
nothing about how many cells it selected or what they contributed -- which is
why no measurement of its effect exists. It now reports its inputs beside its
results, so an inert axis reads as 'vocabulary 0' rather than as an absent
line, and a full pinned set is named because at that point new residue owners
are refused.

The crossing case exercises one seeded owner under the window and then past
it. It is the only case that catches a miss-counting eviction rule: any
fixture written entirely past the window agrees with the wrong rule.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## After the last task

- [ ] Amend `docs/design/2026-09-17-publisher-pinning.md`'s status line from `specified (2026-09-17), not implemented` to `implemented (<date>)`, and record anything the implementation learned that the spec got wrong. Amend, never overwrite.
- [ ] Update `docs/plans/2026-08-18-remaining-work.md` item 5 to point at this work.
- [ ] Comment on [#38](https://github.com/LivXue/dsh-plugin-shop/issues/38) with the axis report line from a real run.
- [ ] **Ask before pushing.** Landing on `main` triggers a ~50-minute catalog build that publishes to npm and Pages. A PR runs the same harvest with every write gated off, which is the way to see this work against live data without publishing.

## Self-review record

Checked against the spec, 2026-09-17:

- **Spec coverage.** §2 at-risk rule → Tasks 1-2. §3 lifecycle → Tasks 4, 6. §4 budget and cursor → Tasks 4, 7. §5 module placement and state → Tasks 2-4. §6 observability → Task 8. §7 testing: the crossing → Task 8; cursor advance → Task 7; empty-vocabulary reporting → Task 8; the rest distributed across Tasks 2-6. §8 deliberately-not-built items have no task, by design.
- **Type consistency.** `PublisherAxisReport` gains `evicted` in Task 6 and every later use carries it; `nextCursor`'s parameter is `rotated` from Task 7 onward and no earlier task calls it; `probeOrder` returns `{ pinned, rotated }` in Tasks 4, 6 and 7 alike.
- **Known gap, deliberate.** `pinnedSupplied`, `rotatedSupplied` and `suppliedNames` are declared in Task 5 and populated in Task 6 from the cells that passed the `servedFor` filter. Task 6's tests assert the probe counts and eviction; the supplied counts are covered by Task 8's report tests, which construct the record directly. No task leaves them at a literal zero in shipped code.
