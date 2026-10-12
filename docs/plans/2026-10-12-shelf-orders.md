# Shelf orders: newest listed and recently updated — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The shop's shelf gains two orders beside the star order — newest
listed (`added`) and recently updated (`publishedAt`) — behind a three-way
toggle, with a date label on the card under either date order.

**Architecture:** Three pure functions in `present.ts` (`shelfTime`,
`utcDay`, `orderShelf`) plus a locale-key map; `ShopTab.tsx` keeps the star
order in its own memo and derives the displayed order from it, so both date
orders are stable re-sorts of the star order and the tie-break is defined in
one place. Client only: the host already parses `added` and `publishedAt`.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), React 18,
vitest + @testing-library/react, CSS modules (`ShopTab.module.css`).

**Spec:** `docs/design/2026-10-12-shelf-orders.md` — the plan argues from it,
so read it alongside this file. Line numbers below are from `e617c46`, the
base commit; shift them as edits land.

## Global Constraints

- **Client only.** No behaviour change in `src/host/`, the catalog schema,
  the RPC shapes, or `registry/`. `added` and `publishedAt` are already parsed
  by `host/catalog.ts` and returned whole. The one `src/host/` edit allowed is
  Task 3's correction of a stale COMMENT in `host/catalog.ts`, which the spec's
  §8 table mandates.
- **English** for code, comments, commit messages and documents. the user
  reads chat in Chinese; the repo is English.
- ESM with `.ts` extensions in relative imports; every file ends with exactly
  one trailing newline.
- `strict` and `noUncheckedIndexedAccess` are on: guard an index access, never
  assert it away in `src/`. (Tests already use `!` in places; prefer a guard.)
- Every `css.X` the component reads needs a rule in `ShopTab.module.css` —
  `css-tokens.client.spec.ts` fails the build otherwise.
- `zh` in `locales.ts` is the key source of truth; `en` is
  `satisfies Record<ShopLocaleKey, string>`, so every key added to one must be
  added to the other.
- Every `.categoryButton` state rule stays **colour-only** (`css-tokens`
  allowlist). Never add a length there: it reflows a wrapping bar.
- Commit messages: ASCII, one per green step, ending with the trailer
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` as
  its own final paragraph — every commit command below passes it as a second
  `-m`. The repository's configured identity
  (`Dizhan Xue <xuedizhan17@mails.ucas.ac.cn>`) is the author; do not override it.
- **Do not** touch the READMEs, `package.json`'s version, or publish anything.
  The version and the channel are the maintainer's call on release day.
- **Shell discipline in this worktree session.** Use `/usr/bin/git -C <abs>`
  for git; a command whose text contains `git` anywhere (including a path with
  `github` in it) is refused, as is one with a computed variable where an
  option may stand. Write scripts to files and run `bash <literal path>` when a
  command needs pipes, loops or a captured exit code. Never `cd` at the top
  level of a command: it moves the session's working directory out from under
  everyone. Use `pnpm -C <dir>` and absolute paths instead.
- Run tests with `pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run <files>`
  from the worktree root. Never `npx vitest`: under npx a `dsh` from an
  ancestor `node_modules/.bin` overrides the one on `PATH`.

## Review Focus

Five inputs the spec implies but no task's happy path exercises. Each has its
test in the task that owns the code.

1. **A `publishedAt` later than the catalog's `builtAt`** — a github commit's
   author date is whatever the author wrote, so an entry dated 2099 would hold
   the top of 「最近更新」 for good. → Task 1 (`shelfTime` refuses it, and
   `orderShelf` ranks it with the undated entries).
2. **A `+HH:MM` instant, and a reader whose machine is not UTC** — a date
   label built from local getters shows the reader's calendar day, not the
   catalog's. → Task 1 (`utcDay`) and Task 3 (the label on the card).
3. **An entry with no `added`** — the cached pre-v5 catalog case. It must
   still render, sort last under the date order that reads the missing field,
   and show no label — never disappear and never throw. → Tasks 1, 2 and 3.
4. **Changing the order while a category, a query or the Installed view is
   active, and while the visible window is open past the first batch** — the
   order must apply to the filtered list, keep the filter, and reset the
   window to `SHOP_VISIBLE_BATCH`. → Task 2.
5. **A narrow window** — the stats row gains a third control and must wrap
   rather than overflow. → Task 2 (a `css-tokens` case).

---

### Task 0: Make the worktree runnable, and commit this plan

The worktree was created from `e617c46` and its branch is named
`worktree-shelf-orders`; the design calls it `feat/shelf-orders`.

**Run by the controller, not an implementer:** this task is environment setup
and produces no code, so it has no task review.

**Files:** none (environment only), plus this plan's own commit.

- [ ] **Step 1: Rename the branch to the name the design names**

```sh
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders branch -m worktree-shelf-orders feat/shelf-orders
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders branch --show-current
```
Expected: `feat/shelf-orders`

- [ ] **Step 2: Confirm the dependencies, and that installing them changed nothing tracked**

pnpm installs the worktree's dependencies on the first `pnpm exec` (it did so
at 12:46 on 2026-10-12). What matters is that the lockfile stayed as
committed, because a dirty tree blocks `pnpm publish` later. If
`node_modules/` is ever missing, reinstall with
`CI=true pnpm -C <worktree> install --frozen-lockfile` (`CI=true` supplies the
TTY confirmation pnpm wants; `--frozen-lockfile` keeps the lockfile as is).

```sh
ls -d /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders/packages/dsh-plugin-shop/node_modules
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders status --short
```
Expected: the directory exists, and `status` lists only this plan as untracked.

- [ ] **Step 3: Establish the green baseline before touching code**

Run the two suites this change will move. Both must be green now; a red one is
pre-existing and must be reported, not "fixed" by this work.

```sh
pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run tests/client/present.test.ts tests/client/ShopTab.client.spec.tsx tests/client/css-tokens.client.spec.ts
pnpm -C packages/dsh-plugin-shop typecheck
```
Expected: all three files pass; typecheck exits 0. `tsdown` runs first inside
`typecheck`, so the worktree gains a `lib/` — that is expected.

- [ ] **Step 4: Commit this plan**

```sh
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders add docs/plans/2026-10-12-shelf-orders.md
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders commit -m "docs(plan): shelf orders - newest listed and recently updated (C1)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```
Expected: one commit on `feat/shelf-orders`, on top of `e63ec32`.

---

### Task 1: The pure core — `shelfTime`, `utcDay`, `orderShelf`

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts` (additions after
  `sortByStars`, around line 650; the key map near the `CATEGORY_KEYS` block
  around line 480)
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` (six keys, both
  dictionaries)
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry` (`../host/index.ts`), `ShopLocaleKey`
  (`./locales.ts`) — both already imported by `present.ts`.
- Produces, for Tasks 2 and 3:
  - `type ShelfOrder = 'stars' | 'added' | 'updated'`
  - `const SHELF_ORDERS: ShelfOrder[]`
  - `function shelfOrderLocaleKey(order: ShelfOrder): ShopLocaleKey`
  - `function shelfTime(entry: CatalogEntry, order: ShelfOrder, builtAt: string): number | undefined`
  - `function utcDay(ms: number): string`
  - `function orderShelf(starOrdered: readonly CatalogEntry[], order: ShelfOrder, builtAt: string): readonly CatalogEntry[]`
  - locale keys `sortLabel`, `sortStars`, `sortAdded`, `sortUpdated`,
    `listedOn`, `updatedOn`

- [ ] **Step 1: Add the six locale keys**

In `packages/dsh-plugin-shop/src/client/locales.ts`, in the `zh` dictionary,
immediately after `catalogStats` (line 24):

```ts
  catalogStats: '{count} 个插件 · 构建于 {date}',
  /** The shelf's order control, and the date each card carries under the two
   * date orders (design 2026-10-12-shelf-orders §4). */
  sortLabel: '排序',
  sortStars: '星标',
  sortAdded: '最新上架',
  sortUpdated: '最近更新',
  listedOn: '上架 {date}',
  updatedOn: '更新 {date}',
```

and in `en`, immediately after its `catalogStats` (line 198):

```ts
  catalogStats: '{count} packages · built {date}',
  /** The shelf's order control, and the date each card carries under the two
   * date orders (design 2026-10-12-shelf-orders §4). */
  sortLabel: 'Sort',
  sortStars: 'Stars',
  sortAdded: 'Newest',
  sortUpdated: 'Recently updated',
  listedOn: 'Listed {date}',
  updatedOn: 'Updated {date}',
```

- [ ] **Step 2: Write the failing tests**

In `packages/dsh-plugin-shop/tests/client/present.test.ts`, extend the import
list at the top with `orderShelf`, `shelfTime`, `shelfOrderLocaleKey`,
`SHELF_ORDERS`, `utcDay` (keep it alphabetical-ish, as the list already is):

```ts
  reviewHashPin, shelfOrderLocaleKey, shelfTime, SHELF_ORDERS, sortByStars, starsOf, tierKey, utcDay, orderShelf,
```

Then add, after `describe('sortByStars cost (G-5)')` (which ends around line
548), these four blocks. `entry` is the module-level fixture already there.

```ts
describe('shelfTime', () => {
  const BUILT_AT = '2026-10-12T09:33:35.944Z'
  const at = (over: Partial<CatalogEntry>): CatalogEntry => ({ ...entry, ...over })

  it('reads `added` under one date order and `publishedAt` under the other', () => {
    const both = at({ added: '2026-10-11', publishedAt: '2026-10-12T06:44:10Z' })
    expect(shelfTime(both, 'added', BUILT_AT)).toBe(Date.parse('2026-10-11T00:00:00Z'))
    expect(shelfTime(both, 'updated', BUILT_AT)).toBe(Date.parse('2026-10-12T06:44:10Z'))
  })

  it('has no date under the star order, which is not a date', () => {
    expect(shelfTime(at({ added: '2026-10-11' }), 'stars', BUILT_AT)).toBeUndefined()
  })

  it('refuses a date later than the catalog build, which a commit author can write', () => {
    // A github entry's `publishedAt` is its head commit's AUTHOR date
    // (github-client.ts), which `git` lets anyone set — to 2099 if they like.
    expect(shelfTime(at({ publishedAt: '2099-01-01T00:00:00Z' }), 'updated', BUILT_AT)).toBeUndefined()
  })

  it('takes a publishedAt exactly at the build and refuses one millisecond later', () => {
    expect(shelfTime(at({ publishedAt: BUILT_AT }), 'updated', BUILT_AT)).toBe(Date.parse(BUILT_AT))
    expect(shelfTime(at({ publishedAt: '2026-10-12T09:33:35.945Z' }), 'updated', BUILT_AT)).toBeUndefined()
  })

  it('refuses an absent, off-form or unparseable date', () => {
    expect(shelfTime(at({ added: undefined }), 'added', BUILT_AT)).toBeUndefined()
    expect(shelfTime(at({ publishedAt: null }), 'updated', BUILT_AT)).toBeUndefined()
    // A date-time with no zone is LOCAL time, so it is refused rather than
    // guessed at: the shelf order must not depend on the machine.
    expect(shelfTime(at({ publishedAt: '2026-10-12T06:44:10' }), 'updated', BUILT_AT)).toBeUndefined()
    // `Date.parse` alone accepts this one — it answers a 2001 date.
    expect(shelfTime(at({ added: 'October 12' }), 'added', BUILT_AT)).toBeUndefined()
    expect(shelfTime(at({ publishedAt: '2026-13-45T99:99:99Z' }), 'updated', BUILT_AT)).toBeUndefined()
    expect(shelfTime(at({ added: '2026-10-12T00:00:00Z' }), 'added', BUILT_AT)).toBeUndefined()
  })

  it('takes a rolled-over day as the day it parses to (design §3)', () => {
    // `2026-02-31` is 3 March. The design accepts the roll-over rather than
    // validating the calendar: the label is derived from the same instant the
    // sort ranked by, so the two agree whatever the engine answers.
    expect(shelfTime(at({ added: '2026-02-31' }), 'added', BUILT_AT))
      .toBe(Date.parse('2026-02-31T00:00:00Z'))
  })

  it('treats every date as unknown when the build time is not a date-time', () => {
    expect(shelfTime(at({ added: '2026-10-11' }), 'added', '')).toBeUndefined()
    expect(shelfTime(at({ added: '2026-10-11' }), 'added', '2026-10-12')).toBeUndefined()
    expect(shelfTime(at({ added: '2026-10-11' }), 'added', 'whenever')).toBeUndefined()
  })
})

describe('utcDay', () => {
  it('answers the UTC calendar day of the instant', () => {
    expect(utcDay(Date.parse('2026-10-12T06:44:10.460Z'))).toBe('2026-10-12')
    expect(utcDay(Date.parse('2026-10-12T23:59:59Z'))).toBe('2026-10-12')
  })

  it('answers the UTC day of an offset instant, not the day it was written as', () => {
    // 06:44 at +08:00 is 22:44 the PREVIOUS day in UTC.
    expect(utcDay(Date.parse('2026-10-12T06:44:10+08:00'))).toBe('2026-10-11')
  })

  it('answers the UTC day under a non-UTC machine zone', () => {
    const original = process.env.TZ
    try {
      process.env.TZ = 'Asia/Shanghai'
      // The guard first: it proves the zone change took effect, so the
      // assertion below is not passing merely because the runner is UTC.
      expect(new Date(Date.parse('2026-10-11T22:44:10Z')).getDate()).toBe(12)
      expect(utcDay(Date.parse('2026-10-11T22:44:10Z'))).toBe('2026-10-11')
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})

describe('orderShelf', () => {
  const BUILT_AT = '2026-10-12T09:33:35.944Z'
  // The star order is deliberately the REVERSE of the name order, so a
  // name tie-break cannot pass these by accident.
  const starOrdered: CatalogEntry[] = [
    { ...entry, name: 'dsh-zulu', added: '2026-10-12', publishedAt: '2026-10-12T08:00:00Z' },
    { ...entry, name: 'dsh-mike', added: '2026-10-11', publishedAt: '2026-10-12T09:00:00Z' },
    { ...entry, name: 'dsh-alpha', added: '2026-10-11', publishedAt: '2026-10-10T00:00:00Z' },
    { ...entry, name: 'dsh-nodate', added: undefined, publishedAt: null },
  ]
  const names = (list: readonly CatalogEntry[]): string[] => list.map(item => item.name)

  it('answers the array it was handed under the star order', () => {
    // Identity, not equality: the default path must allocate nothing, or the
    // memos downstream of it recompute on every catalog refresh.
    expect(orderShelf(starOrdered, 'stars', BUILT_AT)).toBe(starOrdered)
  })

  it('sorts newest listed first, keeping the star order inside one day', () => {
    // zulu leads on 10-12; the 10-11 block keeps the input order (mike before
    // alpha), which is the star order and NOT the name order.
    expect(names(orderShelf(starOrdered, 'added', BUILT_AT)))
      .toEqual(['dsh-zulu', 'dsh-mike', 'dsh-alpha', 'dsh-nodate'])
  })

  it('sorts most recently published first', () => {
    expect(names(orderShelf(starOrdered, 'updated', BUILT_AT)))
      .toEqual(['dsh-mike', 'dsh-zulu', 'dsh-alpha', 'dsh-nodate'])
  })

  it('puts a future-dated entry with the undated ones, not at the top', () => {
    const future = { ...entry, name: 'dsh-future', added: '2026-10-12', publishedAt: '2099-01-01T00:00:00Z' }
    expect(names(orderShelf([...starOrdered, future], 'updated', BUILT_AT)))
      .toEqual(['dsh-mike', 'dsh-zulu', 'dsh-alpha', 'dsh-nodate', 'dsh-future'])
  })

  it('never writes to the array it was handed', () => {
    // A frozen input turns an in-place sort into a TypeError.
    const frozen = Object.freeze([...starOrdered])
    expect(names(orderShelf(frozen, 'added', BUILT_AT)))
      .toEqual(['dsh-zulu', 'dsh-mike', 'dsh-alpha', 'dsh-nodate'])
  })

  it('holds its three promises over a generated catalog', () => {
    // Deterministic by construction: no `Math.random` anywhere in this repo's
    // tests. The generator mixes dated, undated, future-dated and tied
    // entries so the properties are exercised on all four classes.
    const made: CatalogEntry[] = Array.from({ length: 400 }, (_, i) => ({
      ...entry,
      name: `dsh-gen-${String(i).padStart(3, '0')}`,
      added: i % 7 === 0 ? undefined : `2026-10-${String((i * 13) % 29 + 1).padStart(2, '0')}`,
      publishedAt: i % 11 === 0 ? null : `2026-10-${String((i * 7) % 12 + 1).padStart(2, '0')}T0${i % 10}:00:00Z`,
    }))
    const inputIndex = new Map(made.map((item, i) => [item, i]))
    // `noUncheckedIndexedAccess`: a guarded read, never an assertion.
    const positionOf = (item: CatalogEntry): number => inputIndex.get(item) ?? -1
    for (const order of ['added', 'updated'] as const) {
      const ordered = orderShelf(made, order, BUILT_AT)
      expect(ordered).toHaveLength(made.length)
      const timeOf = (item: CatalogEntry): number | undefined => shelfTime(item, order, BUILT_AT)
      for (let i = 1; i < ordered.length; i += 1) {
        const previous = ordered[i - 1]
        const current = ordered[i]
        if (previous === undefined || current === undefined) continue
        const before = timeOf(previous)
        const after = timeOf(current)
        // 1. a dated entry never follows an undated one
        expect(before === undefined && after !== undefined).toBe(false)
        if (before === undefined || after === undefined) continue
        // 2. dated entries never ascend
        expect(before).toBeGreaterThanOrEqual(after)
        // 3. equal keys keep the input's relative order
        if (before === after) expect(positionOf(previous)).toBeLessThan(positionOf(current))
      }
    }
  })
})

describe('orderShelf cost (design 2026-10-12 §5)', () => {
  it('re-sorts 9,400 entries under both date orders inside the keystroke budget', () => {
    // Cell-adjacent to the existing G-5 case: same size, same method (CPU
    // time, five runs, no wall clock), same 60 ms cap. That case already
    // brushes the cap on the Windows CI runner, so a LARGER fixture here
    // would invent a new margin rather than inherit the existing one.
    const entries: CatalogEntry[] = Array.from({ length: 9400 }, (_, i) => ({
      ...entry,
      name: `dsh-plugin-${(i * 7919) % 9400}`,
      added: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`,
      publishedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T0${i % 10}:00:00Z`,
    }))
    const builtAt = '2026-10-12T09:33:35.944Z'
    const runs = 5
    for (const order of ['added', 'updated'] as const) {
      const started = process.cpuUsage()
      for (let run = 0; run < runs; run += 1) orderShelf(entries, order, builtAt)
      const used = process.cpuUsage(started)
      const perRun = (used.user + used.system) / 1000 / runs
      expect(perRun, order).toBeLessThan(60)
    }
  })
})

describe('shelfOrderLocaleKey', () => {
  it('names every order exactly once, in display order', () => {
    expect(SHELF_ORDERS).toEqual(['stars', 'added', 'updated'])
    expect(SHELF_ORDERS.map(shelfOrderLocaleKey)).toEqual(['sortStars', 'sortAdded', 'sortUpdated'])
  })
})
```

- [ ] **Step 3: Run the new tests to verify they fail**

```sh
pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run tests/client/present.test.ts
```
Expected: FAIL — `shelfTime is not a function` (and the same for `orderShelf`,
`utcDay`, `shelfOrderLocaleKey`, `SHELF_ORDERS`).

- [ ] **Step 4: Implement the pure core**

In `packages/dsh-plugin-shop/src/client/present.ts`, add the key map and order
type just above the `CATEGORY_KEYS` block (line 480), mirroring its shape:

```ts
/**
 * Which order the shelf is in (design 2026-10-12-shelf-orders). `stars` is
 * the default AND the tie-break of both date orders, so the two date orders
 * are stable re-sorts of it rather than orders with comparators of their own.
 */
const SHELF_ORDER_KEYS = {
  stars: 'sortStars',
  added: 'sortAdded',
  updated: 'sortUpdated',
} as const

/** The order vocabulary as a type, derived from the map above so the client
 * never repeats the three literals. */
export type ShelfOrder = keyof typeof SHELF_ORDER_KEYS

/** The three orders in display order (map insertion order). */
export const SHELF_ORDERS = Object.keys(SHELF_ORDER_KEYS) as ShelfOrder[]

/** The locale key naming one order (the toggle's buttons). */
export function shelfOrderLocaleKey(order: ShelfOrder): ShopLocaleKey {
  return SHELF_ORDER_KEYS[order]
}
```

and the date functions immediately after `sortByStars` (which ends at line 650):

```ts
/** The day form the registry writes into `added` (`emit.ts` E9 enforces it
 * on every build on its side; a catalog is untrusted input on this side). */
const DAY_FORM = /^\d{4}-\d{2}-\d{2}$/

/**
 * The ES date-time form WITH an explicit zone. The zone is required, and not
 * for tidiness: a date-time string with no zone is parsed as LOCAL time, so
 * accepting one would make the shelf's order depend on the machine.
 */
const INSTANT_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * One date string as milliseconds, or undefined when it cannot be trusted.
 *
 * The form is checked BEFORE `Date.parse`, and that order is load-bearing:
 * V8 answers a real instant for `2026-02-31T00:00:00Z` (3 March) and for
 * `October 12` (a 2001 date), so `Date.parse` alone is not a validity test.
 */
function parseForm(value: unknown, form: RegExp): number | undefined {
  if (typeof value !== 'string' || !form.test(value)) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** `shelfTime` with the catalog's build time already parsed, for the n calls
 * `orderShelf` makes in one pass. */
function timeOf(entry: CatalogEntry, order: ShelfOrder, built: number | undefined): number | undefined {
  if (order === 'stars') return undefined
  const ms = order === 'added'
    ? parseForm(entry.added, DAY_FORM)
    : parseForm(entry.publishedAt, INSTANT_FORM)
  if (ms === undefined || built === undefined || ms > built) return undefined
  return ms
}

/**
 * The entry's sort key under a date order, or undefined when it has no usable
 * date (design §3): absent, off-form, unparseable, or later than the catalog's
 * own `builtAt`. Milliseconds since the epoch. `'stars'` carries no date, so
 * this answers undefined for it.
 */
export function shelfTime(entry: CatalogEntry, order: ShelfOrder, builtAt: string): number | undefined {
  return timeOf(entry, order, parseForm(builtAt, INSTANT_FORM))
}

/**
 * A UTC calendar day for display: "2026-10-12". Derived from the instant the
 * sort ranked by, so a card's label and its position cannot disagree. UTC and
 * never a local getter: a reader in UTC+8 must see the same days the catalog
 * was built in, the calendar the stats row already prints.
 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The shelf in `order` (design 2026-10-12-shelf-orders §2, §5). `'stars'`
 * returns the array it was handed, so the default path allocates nothing and
 * does not invalidate the memos downstream of it.
 *
 * Each key is computed ONCE per entry rather than inside the comparator, and
 * the sort is stable (ES2019), so entries sharing a date keep the star order
 * they arrived in — which is how the tie-break is defined without a second
 * comparator that could drift from `sortByStars`.
 */
export function orderShelf(
  starOrdered: readonly CatalogEntry[],
  order: ShelfOrder,
  builtAt: string,
): readonly CatalogEntry[] {
  if (order === 'stars') return starOrdered
  const built = parseForm(builtAt, INSTANT_FORM)
  const keyed = starOrdered.map(entry => ({ entry, time: timeOf(entry, order, built) }))
  keyed.sort((a, b) => {
    if (a.time === undefined) return b.time === undefined ? 0 : 1
    if (b.time === undefined) return -1
    return b.time - a.time
  })
  return keyed.map(item => item.entry)
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```sh
pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run tests/client/present.test.ts
```
Expected: PASS, including the two cost cases. If the orderShelf cost case
fails, report the number rather than loosening the cap.

- [ ] **Step 6: Typecheck**

```sh
pnpm -C packages/dsh-plugin-shop typecheck
```
Expected: exit 0.

- [ ] **Step 7: Commit**

```sh
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders add packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/src/client/locales.ts packages/dsh-plugin-shop/tests/client/present.test.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders commit -m "feat(shop): the shelf's two date orders, and the date rules behind them (C1)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The toggle

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` (state near line
  1452; the two memos at 1630-1642; the stats row at 2158; the import at 10)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.module.css` (the
  `.catalogStatsRow` rule at 475; new `.sortGroup`/`.sortLabel`)
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`,
  `packages/dsh-plugin-shop/tests/client/css-tokens.client.spec.ts`

**Interfaces:**
- Consumes: `SHELF_ORDERS`, `ShelfOrder`, `orderShelf`,
  `shelfOrderLocaleKey` from Task 1, already exported by `present.ts`.
- Produces, for Task 3: the local `order: ShelfOrder` state and a `builtAt`
  string, both read when the card's date label is wired.

- [ ] **Step 1: Write the failing behaviour tests**

In `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`, add a
describe block after the `sortByStars`-related cases (near line 2145, after
"shows no badge for an unstarred entry"). It defines its own catalog with all
three orders distinct, and one entry deliberately lacking `added` — and it
carries the HIGHEST star count, so "sorted last" cannot be a low rank's doing.

These cases assert ORDER and PRESSED STATE only. The date label on the card
is Task 3's: asserting it here would make this task impossible to turn green.
Task 3 appends its label cases to this same block and reuses `datedCatalog`,
`cardNames` and `orderButton`, so keep those three names exactly.

```tsx
describe('ShopTab shelf orders', () => {
  /** Three orders, three answers:
   *   stars   bare (9999) > old (900) > new-a (20) > new-b (10)
   *   added   new-a, new-b (10-12, in star order) > old (10-01) > bare (none)
   *   updated old (09:30) > new-b (08:00) > bare (07:00) > new-a (10-06)
   * 10-12 is the catalog's build day, so no entry is future-dated. */
  function datedCatalog(): ShopCatalogResult {
    const base = snapshot().plugins[0]!
    return {
      ...snapshot(),
      builtAt: '2026-10-12T09:33:35.944Z',
      plugins: [
        { ...base, name: 'dsh-bare', added: undefined, publishedAt: '2026-10-12T07:00:00Z' },
        { ...base, name: 'dsh-old', added: '2026-10-01', publishedAt: '2026-10-12T09:30:00Z' },
        { ...base, name: 'dsh-new-a', added: '2026-10-12', publishedAt: '2026-10-06T00:00:00Z' },
        { ...base, name: 'dsh-new-b', added: '2026-10-12', publishedAt: '2026-10-12T08:00:00Z' },
      ],
      stars: { 'dsh-bare': 9999, 'dsh-old': 900, 'dsh-new-a': 20, 'dsh-new-b': 10 },
    }
  }

  const cardNames = (): (string | null)[] =>
    [...document.querySelectorAll('[data-shop-entry]')].map(card => card.getAttribute('data-shop-entry'))

  const orderButton = (label: string): HTMLElement => screen.getByRole('button', { name: label })

  it('opens in the star order, with the star order pressed', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-bare')).toBeTruthy())
    expect(cardNames()).toEqual(['dsh-bare', 'dsh-old', 'dsh-new-a', 'dsh-new-b'])
    expect(orderButton(en.sortStars).getAttribute('aria-pressed')).toBe('true')
    expect(orderButton(en.sortAdded).getAttribute('aria-pressed')).toBe('false')
    expect(orderButton(en.sortUpdated).getAttribute('aria-pressed')).toBe('false')
  })

  it('orders by listing date, keeping the star order inside one day, and moves the pressed state', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(orderButton(en.sortAdded))
    // `dsh-bare` carries the most stars and is still last, because it has no
    // `added` date at all.
    expect(cardNames()).toEqual(['dsh-new-a', 'dsh-new-b', 'dsh-old', 'dsh-bare'])
    expect(orderButton(en.sortAdded).getAttribute('aria-pressed')).toBe('true')
    expect(orderButton(en.sortStars).getAttribute('aria-pressed')).toBe('false')
  })

  it('orders by publication date', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(orderButton(en.sortUpdated))
    // `dsh-bare` has no `added` and a perfectly good `publishedAt`, so the two
    // date orders must disagree about it — and they do.
    expect(cardNames()).toEqual(['dsh-old', 'dsh-new-b', 'dsh-bare', 'dsh-new-a'])
    expect(orderButton(en.sortUpdated).getAttribute('aria-pressed')).toBe('true')
  })

  it('goes back to the star order', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(orderButton(en.sortUpdated))
    fireEvent.click(orderButton(en.sortStars))
    expect(cardNames()).toEqual(['dsh-bare', 'dsh-old', 'dsh-new-a', 'dsh-new-b'])
    expect(orderButton(en.sortStars).getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps the order when a search narrows the shelf, and the filter when the order changes', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(orderButton(en.sortAdded))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'dsh-new' } })
    expect(cardNames()).toEqual(['dsh-new-a', 'dsh-new-b'])
    fireEvent.click(orderButton(en.sortUpdated))
    expect(cardNames()).toEqual(['dsh-new-b', 'dsh-new-a'])
  })

  it('orders the Installed view as well as the shelf', async () => {
    // The Installed view reads the ordered catalog directly (`matched`), so it
    // must follow the toggle exactly as the shelf does. The installed rows'
    // `installed` equals the catalog version, so neither is outdated and
    // neither moves into the Updatable section.
    const { injected } = bench(datedCatalog(), [
      { name: 'dsh-old', installed: '1.2.0', latest: '1.2.0', outdated: false, enabled: true },
      { name: 'dsh-new-b', installed: '1.2.0', latest: '1.2.0', outdated: false, enabled: true },
    ])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-category-installed]') as HTMLElement)
    // star order: old (900) before new-b (10)
    await waitFor(() => expect(cardNames()).toEqual(['dsh-old', 'dsh-new-b']))
    fireEvent.click(orderButton(en.sortAdded))
    // listing order: new-b (10-12) before old (10-01)
    expect(cardNames()).toEqual(['dsh-new-b', 'dsh-old'])
  })
})
```

Then, inside `describe('ShopTab incremental rendering')` (which owns the
`IntersectionObserver` stub and `fireSentinel`), add one more case after
"resets to the first batch when the query changes" (line 3025):

```tsx
  it('resets to the first batch when the shelf order changes', async () => {
    const base = manyPlugins(1).plugins[0]!
    const plugins = [
      ...Array.from({ length: 60 }, (_, i) => ({ ...base, name: `dsh-alpha-${String(i).padStart(2, '0')}`, added: '2026-08-01' })),
      ...Array.from({ length: 60 }, (_, i) => ({ ...base, name: `dsh-beta-${String(i).padStart(2, '0')}`, added: '2026-09-01' })),
    ] as ShopCatalogResult['plugins']
    const { injected } = bench({ ...manyPlugins(1), plugins, builtAt: '2026-10-12T00:00:00Z' })
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-alpha-00')).toBeTruthy())

    // scroll two batches deep: 96 of 120 shown
    await fireSentinel()
    await waitFor(() => expect(cardCount()).toBe(96))

    // the newer block leads under 最新上架, and the window is back to one batch
    fireEvent.click(screen.getByRole('button', { name: en.sortAdded }))
    await waitFor(() => expect(cardCount()).toBe(48))
    expect(screen.getByText('dsh-beta-00')).toBeTruthy()
    expect(screen.queryByText('dsh-alpha-00')).toBeNull()
  })
```

Finally, in `css-tokens.client.spec.ts`, add to `describe('class references')`:

```ts
  it('lets the stats row wrap rather than overflow once the order control joins it', () => {
    // jsdom applies no layout, so the declaration is the only place a test can
    // see this: the row holds the catalog line, the refresh button and now
    // three pills, and a non-wrapping flex row overflows a narrow window.
    const row = rules.get('.catalogStatsRow') ?? ''
    expect(row, 'no .catalogStatsRow rule').not.toBe('')
    expect(row).toMatch(/display:\s*flex/)
    expect(row).toMatch(/flex-wrap:\s*wrap/)

    const group = rules.get('.sortGroup') ?? ''
    expect(group, 'no .sortGroup rule').not.toBe('')
    expect(group).toMatch(/margin-left:\s*auto/)
  })
```

- [ ] **Step 2: Run the new tests to verify they fail**

```sh
pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run tests/client/ShopTab.client.spec.tsx tests/client/css-tokens.client.spec.ts
```
Expected: FAIL — `Unable to find role="button" and name "Stars"`, and the
`.catalogStatsRow` case on `flex-wrap`.

- [ ] **Step 3: Wire the memos and the control**

In `ShopTab.tsx`, extend the `present.ts` import (line 10) with
`orderShelf`, `shelfOrderLocaleKey`, `SHELF_ORDERS`, `type ShelfOrder`.

Add the state beside `category` (line 1445):

```tsx
  // Which order the shelf is in (design 2026-10-12-shelf-orders §4). In-memory
  // like every other control here: a reload starts at the star order.
  const [order, setOrder] = useState<ShelfOrder>('stars')
```

Replace the `sortedCatalog` memo (line 1639) with a star-order memo and a
derived order, keeping the existing comment's promise ("one ordering is
computed once and both lists carry it") and extending it:

```tsx
  // Every catalog entry, in star order: the default shelf order AND the
  // tie-break of both date orders (design 2026-10-12-shelf-orders §2), which
  // is why it stays its own memo — switching to a date order must not re-run
  // the star sort, which is the expensive one.
  const starOrder = useMemo(
    () => (catalogState.kind === 'ready' ? sortByStars(catalogState.result.plugins, stars) : []),
    [catalogState, stars],
  )

  // The catalog's own build time, which bounds every date: an entry dated
  // later than it counts as undated. Off `catalogState`, so a refresh moves it.
  const builtAt = catalogState.kind === 'ready' ? catalogState.result.builtAt : ''

  // Every catalog entry, in shelf order. `browsable` FILTERS this instead of
  // sorting its own result: a filter preserves relative order and the sort is
  // stable, so one ordering is computed once and both lists carry it. The
  // Installed view reads this list directly — see `matched`.
  const sortedCatalog = useMemo(
    () => orderShelf(starOrder, order, builtAt),
    [starOrder, order, builtAt],
  )
```

In the stats row (line 2158), add the control as the row's LAST child, after
the `{reloadFailed && …}` line. The order matters: the refresh-failed note
belongs beside the button it reports on, and placed after the group, the
group's `margin-left: auto` would push that note to the far right of the row.

```tsx
        <span className={css.sortGroup} role="group" aria-labelledby={sortLabelId} data-shop-sort>
          {/* A visible label, not only an accessible name: three bare pills
            * beside the category bar read as three more categories. The
            * group is named by this text through `aria-labelledby` rather
            * than an `aria-label`, so a screen reader does not hear it
            * twice. */}
          <span className={css.sortLabel} id={sortLabelId}>{t('sortLabel')}</span>
          {SHELF_ORDERS.map(name => (
            <button
              key={name}
              type="button"
              // The category pills' own classes: a choice among a few, which
              // is what this is — and the pressed rule they carry is already
              // pinned to colour only, so the row cannot reflow on a click.
              className={order === name ? `${css.categoryButton} ${css.categoryButtonOn}` : css.categoryButton}
              aria-pressed={order === name}
              data-shop-order={name}
              onClick={() => { setOrder(name); setVisibleCount(SHOP_VISIBLE_BATCH) }}
            >
              {t(shelfOrderLocaleKey(name))}
            </button>
          ))}
        </span>
```

and declare the id where the other shelf state lives (beside `visibleCount`,
line 1459), since `useId` must run unconditionally:

```tsx
  const sortLabelId = useId()
```

- [ ] **Step 4: Add the CSS**

In `ShopTab.module.css`, add `flex-wrap: wrap` to `.catalogStatsRow` (line
475) with the reason, and add the two new rules directly below it:

```css
.catalogStatsRow {
  display: flex;
  align-items: center;
  /* The row holds the catalog line, the refresh button and the shelf order's
   * three pills (design 2026-10-12-shelf-orders §4). Without wrapping, the
   * last of them overflows the tab at a narrow width. */
  flex-wrap: wrap;
  gap: 10px;
  margin: 6px 0 0;
}

/* The shelf's order control, at the right end of the stats row. `margin-left:
 * auto` is what puts it there while the line and the refresh button stay
 * left — and it is safe on a wrapping row, unlike a width. */
.sortGroup {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
}

.sortLabel {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```sh
pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run tests/client/ShopTab.client.spec.tsx tests/client/css-tokens.client.spec.ts tests/client/present.test.ts
```
Expected: PASS. `css-tokens`' "every css.X the component reads has a rule"
covers the two new class names automatically.

- [ ] **Step 6: Typecheck, then commit**

```sh
pnpm -C packages/dsh-plugin-shop typecheck
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders add packages/dsh-plugin-shop/src/client/ShopTab.tsx packages/dsh-plugin-shop/src/client/ShopTab.module.css packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx packages/dsh-plugin-shop/tests/client/css-tokens.client.spec.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders commit -m "feat(shop): a three-way shelf order control in the stats row (C1)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The date on the card

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` (`EntryCard`'s props
  at 122; its `.cardMeta` row at 384; the render site at 2212)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.module.css` (the `.size`
  rule at 985)
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (the stale comment
  beside `added`, line 169)
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `shelfTime` and `utcDay` from Task 1; the `order` state and
  `builtAt` from Task 2.
- Produces: nothing later tasks read.

- [ ] **Step 1: Write the failing tests**

Append these to the `describe('ShopTab shelf orders')` block Task 2 created.
They reuse its `datedCatalog`, `cardNames` and `orderButton`, and add two
helpers of their own at the top of the appended section:

```tsx
  const dates = (): (string | null)[] =>
    [...document.querySelectorAll('[data-shop-shelf-date]')].map(node => node.textContent)

  const filled = (template: string, date: string): string => template.replace('{date}', date)

  it('shows no date on any card under the star order', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-bare')).toBeTruthy())
    expect(dates()).toEqual([])
  })

  it('labels each card with its listing day under Newest, and an undated card with none', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(orderButton(en.sortAdded))
    // In card order: new-a, new-b, old, bare. `dsh-bare` has no `added`, so
    // it is the one card with no label.
    expect(dates()).toEqual([
      filled(en.listedOn, '2026-10-12'),
      filled(en.listedOn, '2026-10-12'),
      filled(en.listedOn, '2026-10-01'),
    ])
    const bare = document.querySelector('[data-shop-entry="dsh-bare"]')
    expect(bare?.querySelector('[data-shop-shelf-date]')).toBeNull()
  })

  it('labels each card with its publication day under Recently updated', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(orderButton(en.sortUpdated))
    // In card order: old, new-b, bare, new-a — and `dsh-bare`, undated under
    // the listing order, has a perfectly good publication date.
    expect(dates()).toEqual([
      filled(en.updatedOn, '2026-10-12'),
      filled(en.updatedOn, '2026-10-12'),
      filled(en.updatedOn, '2026-10-12'),
      filled(en.updatedOn, '2026-10-06'),
    ])
  })

  it('takes the labels away on the way back to the star order', async () => {
    const { injected } = bench(datedCatalog())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
    fireEvent.click(orderButton(en.sortUpdated))
    expect(dates()).toHaveLength(4)
    fireEvent.click(orderButton(en.sortStars))
    expect(dates()).toEqual([])
  })

  it("labels a card with the catalog's UTC day, not the reader's", async () => {
    // 20:00 UTC on 10-11 is already 10-12 in UTC+8. The label must still read
    // 2026-10-11: the calendar the stats row's build date is printed in.
    const original = process.env.TZ
    try {
      process.env.TZ = 'Asia/Shanghai'
      // The precondition, asserted: without it this test would pass on any
      // UTC runner even if the label were built from local getters. A
      // runtime TZ switch was measured to take effect in this repo's vitest
      // pool, under jsdom and node alike, on 2026-10-12.
      expect(new Date(Date.parse('2026-10-11T20:00:00Z')).getDate(), 'the zone change took effect').toBe(12)
      const catalog = datedCatalog()
      catalog.plugins = catalog.plugins.map(item =>
        item.name === 'dsh-old' ? { ...item, publishedAt: '2026-10-11T20:00:00Z' } : item)
      const { injected } = bench(catalog)
      renderTab(injected)
      await waitFor(() => expect(screen.getByText('dsh-old')).toBeTruthy())
      fireEvent.click(orderButton(en.sortUpdated))
      const old = document.querySelector('[data-shop-entry="dsh-old"]')
      expect(old?.querySelector('[data-shop-shelf-date]')?.textContent).toBe(filled(en.updatedOn, '2026-10-11'))
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
```

- [ ] **Step 2: Run them to verify they fail**

```sh
pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run tests/client/ShopTab.client.spec.tsx
```
Expected: four of the five new cases FAIL — no `[data-shop-shelf-date]` node
exists yet, so `dates()` is `[]` and the UTC case reads `undefined`. 'shows no
date on any card under the star order' already passes, and should: it pins
the default, which this task must not change.

- [ ] **Step 3: Pass the date to the card**

Extend `ShopTab.tsx`'s import from `./present.ts` (line 10) with `shelfTime`
and `utcDay`; Task 2 already added `orderShelf`, `shelfOrderLocaleKey`,
`SHELF_ORDERS` and `type ShelfOrder` to it.

In `EntryCard`'s destructuring and props type (line 122), add two members. They
are separate primitives on purpose: this component is memoized, and a fresh
object per render would defeat it.

```tsx
const EntryCard = memo(function EntryCard({ entry, stars, order, shelfDay, installed, missing, harness, nameTakenBy, t, flow, uninstallFlow, restart, restartBlocked, reload, setEnabled, inInstalledView, restarts }: {
  entry: CatalogEntry
  stars: number | undefined
  /** The shelf's order, so the card can name the date it shows (design
   * 2026-10-12-shelf-orders §4). */
  order: ShelfOrder
  /** The entry's date under that order as a UTC calendar day, or undefined
   * when it has no usable date. A string, never an object: see above. */
  shelfDay: string | undefined
```

In the `.cardMeta` row (line 384), widen the wrapper's condition and render the
date first — it is a fixed-width figure like the size, and the author's
variable width is what the outer edge exists to absorb:

```tsx
        {(size !== undefined || author !== null || shelfDay !== undefined) && (
          <span className={css.cardMeta}>
            {shelfDay !== undefined && (
              // Which calendar this is: the catalog's (UTC), the same one the
              // stats row's build date prints, never the reader's own zone.
              <span className={css.shelfDate} data-shop-shelf-date>
                {t(order === 'added' ? 'listedOn' : 'updatedOn', { date: shelfDay })}
              </span>
            )}
```

At the render site (line 2212), compute the day from the same function the
order keyed on and pass both:

```tsx
                  <EntryCard entry={entry} stars={starsOf(entry, stars)} order={order} shelfDay={shelfDayOf(entry)} installed={installedByKey.get(key)} missing={missingByKey.get(key) ?? []} harness={harnessVerdictOf(harnessVerdicts, key)} nameTakenBy={nameTakenByKey.get(key)} t={t} flow={flows.flowFor(key)} uninstallFlow={uninstallFlows.flowFor(key)} restart={restart} restartBlocked={restartBlocked} reload={reload} setEnabled={setEnabled} inInstalledView={category === 'installed'} restarts={restarts} />
```

and define `shelfDayOf` beside `visible` (line 1837), so the card and the order
read one function:

```tsx
  /** The date a card shows under the current order, or undefined under the
   * star order and for an entry with no usable date. Computed from the same
   * `shelfTime` the order keyed on, so a label can never name a date the
   * order ignored. */
  const shelfDayOf = (entry: CatalogEntry): string | undefined => {
    const ms = shelfTime(entry, order, builtAt)
    return ms === undefined ? undefined : utcDay(ms)
  }
```

- [ ] **Step 4: Add the CSS and fix the stale host comment**

In `ShopTab.module.css`, extend the `.size` rule's selector (line 985) rather
than writing a second copy of its declarations — one figure style, one place:

```css
.size,
.shelfDate {
```

and add to that rule's comment, after the existing `font-variant-numeric`
paragraph:

```
 * `.shelfDate` shares this rule because it is the same kind of fact — a
 * fixed-width figure a reader compares down the shelf (design
 * 2026-10-12-shelf-orders §4) — and two copies of these declarations would
 * drift.
```

In `packages/dsh-plugin-shop/src/host/catalog.ts`, the comment beside `added`
(line 169) currently ends "…the client never renders it." That is no longer
true; correct it in the same change, as the design's §8 table says:

```
  // … Our own builds always carry it (registry E9); the client shows it on a
  // card under the shelf's 「最新上架」 order (design
  // 2026-10-12-shelf-orders §4).
```

- [ ] **Step 5: Run the tests to verify they pass**

```sh
pnpm -C packages/dsh-plugin-shop exec node node_modules/vitest/vitest.mjs run tests/client/ShopTab.client.spec.tsx tests/client/css-tokens.client.spec.ts tests/client/present.test.ts
```
Expected: PASS — the five label cases and every case Task 2 added.

- [ ] **Step 6: Typecheck, then commit**

```sh
pnpm -C packages/dsh-plugin-shop typecheck
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders add packages/dsh-plugin-shop/src/client/ShopTab.tsx packages/dsh-plugin-shop/src/client/ShopTab.module.css packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders commit -m "feat(shop): a date label on the card under either date order (C1)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full verification and the design doc's status

**Files:**
- Modify: `docs/design/2026-10-12-shelf-orders.md` (the `Status:` line, and
  §5's `orderShelf` signature — see Step 3)

Not in this task: looking at the result in a real dsh (both themes, two
widths). That is the controller's, after the final whole-branch review.

- [ ] **Step 1: Run the whole package suite, e2e included**

The e2e boots a REAL `dsh --profile web`, so it needs a private harness prefix
first on `PATH` and `DSH_SHOP_EXPECT_DSH` set to that harness's own
`dsh --version` (bare, e.g. `0.2.0-rc.2`), which the e2e compares before it
boots anything. The 0.2.0-rc.2 prefix is npm's `latest` today; the PR's CI
runs the other two harnesses of its matrix.

`pnpm test` rebuilds `lib/` first, which the e2e needs — never reach for
`vitest` directly here, or the e2e tests the previous build. The run takes
several minutes, so it writes a log and its own exit code. Write this script
to `/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders/.superpowers/sdd/2026-10-12-shelf-orders/run-package-suite.sh`
(a git-ignored directory):

```bash
#!/usr/bin/env bash
# The package suite, e2e included, against the private dsh 0.2.0-rc.2 prefix.
set -u
W=/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders
PREFIX=/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/.dsh020-prefix/bin
LOG=$W/.superpowers/sdd/2026-10-12-shelf-orders/package-suite.log
VERSION=$("$PREFIX/dsh" --version | tr -d '[:space:]')
{
  echo "dsh on PATH: $VERSION ($PREFIX)"
  CI=true PATH="$PREFIX:$PATH" DSH_SHOP_EXPECT_DSH="$VERSION" pnpm -C "$W/packages/dsh-plugin-shop" test
  echo "EXIT=$?"
} > "$LOG" 2>&1
```

Run it with `bash <that path>` in the background (the Bash tool's
`run_in_background`, timeout 1800000), and when it finishes read the log's
tail: the vitest summary and the `EXIT=` line. Expected: `EXIT=0`. Three cases
are known to flake under load — "serializes installs", "records the download
phase" and the G-5 sort budget; if one of those alone fails, rerun the script
once, and report both runs. Never loosen an assertion to get green.

- [ ] **Step 2: Run the root suite and both typechecks**

The root suite guards the registry and the docs; this change touches one
`docs/design/` file and no registry code, so it must stay green.

```sh
pnpm -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders test
pnpm -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders typecheck
pnpm -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders/packages/dsh-plugin-shop typecheck
```
Expected: all three exit 0.

- [ ] **Step 3: Record the built status in the design doc, and bring §5 in line with the code**

Change the `Status:` line of `docs/design/2026-10-12-shelf-orders.md` from
"implementation not started" to name the branch and what built it, e.g.:

```markdown
Status: **built on `feat/shelf-orders`** (2026-10-12), three commits: the pure
core, the toggle, and the card's date label. Decided 2026-10-12 by LivXue.
This amends D1 of `../../superpowers/specs/2026-08-26-github-stars-design.md`…
```

Then, in the same file's §5 code block, the `orderShelf` signature returns
`CatalogEntry[]` while the code returns `readonly CatalogEntry[]`. The code is
right and the spec is amended to match (CLAUDE.md: when the two disagree, the
spec is amended in the same change). The readonly return is forced: the
`'stars'` path returns the very array it was handed, which is readonly.
Replace that one line:

```ts
export function orderShelf(starOrdered: readonly CatalogEntry[], order: ShelfOrder, builtAt: string): readonly CatalogEntry[]
```

and extend the `'stars'` bullet beneath the block so the reason is recorded:

```markdown
- **`'stars'` returns the input reference**, so the default path allocates
  nothing and does not invalidate the memos downstream of `sortedCatalog`.
  That is also why the result is `readonly`: on that path it IS the input.
```

- [ ] **Step 4: Commit — do not push**

```sh
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders add docs/design/2026-10-12-shelf-orders.md
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders commit -m "docs(design): record the shelf orders as built" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shelf-orders log --oneline e617c46..HEAD
```

Report: the commit list, the package suite's totals and its `EXIT=` line, the
root suite's totals, and both typechecks' exit codes. Nothing is pushed, no
version is bumped and nothing is published: pushing, the PR and every release
step wait for the maintainer's explicit go-ahead.
