# Shelf orders: newest listed and recently updated — design

Status: **built on `feat/shelf-orders`** (2026-10-12), three commits: the pure
core, the toggle, and the card's date label. Decided 2026-10-12 by LivXue, who
chose both date orders, a date label on the card under either of them, and a
three-way toggle at the right end of the catalog's stats row. This amends D1 of
`../superpowers/specs/2026-08-26-github-stars-design.md`, whose fixed sort
becomes the default rather than the only order, and D1's non-goals line. It
implements borrowing C1 of `2026-09-26-market-borrowings.md`. English only,
per convention.

A competitor citation says where an idea came from; it is never the evidence.
Every claim below rests on this repository or on the published catalog of
2026-10-12 (`builtAt` 2026-10-12T09:33:35.944Z, 14,546 entries — 8,162 github,
6,384 npm), read that day.

## 1. The defect

The shelf has one order: stars descending, entries the `stars` sidecar holds no
count for last, ties by name (D1 of the stars design). Star counts are a
history of attention, and a plugin listed today has none:

- **1,400 entries carry an `added` date of 2026-10-06 or later** — 9.6% of the
  catalog, listed within the last seven build days. Under the star order
  **four of them reach the first page** (the first 48 cards), and their median
  position is **9,217 of 14,546**.
- 967 of those 1,400 have a real count of **zero**, so they tie and are ranked
  by name, behind every entry that has been starred even once.

Meanwhile `publishedAt` moves on its own: **2,937 entries were published in
that same window**, and 1,631 of them had been listed BEFORE it — work on
already-listed plugins that no current order can surface.

Both fields are already in every entry and the host already parses both
(`packages/dsh-plugin-shop/src/host/catalog.ts`); the client reads neither.

## 2. The rule

The shelf gains two orders beside the star order. All three are display-time
only; the catalog's own byte output is untouched.

| Order | Key | Ties |
|---|---|---|
| `stars` (default, unchanged) | star count desc, no count last | name asc, case-insensitive |
| `added` | `added` (YYYY-MM-DD) desc | the star order |
| `updated` | `publishedAt` desc | the star order |

**Both date orders are stable re-sorts of the star order.** Within one date
block the default order stands: on 2026-10-12 the 207 entries listed that day
open the shelf with the starred ones (47 of the first 48), and the 206th of
them is ranked by name, exactly as it is today.

**A date later than the catalog's build is not a date.** `builtAt` travels
with the catalog, so the bound needs no clock and the same data gives the same
answer on every machine. This closes the one hole the github half opens: its
`publishedAt` is the head commit's author date
(`registry/scripts/src/github-client.ts`), which `git` lets an author set
freely. Without the bound, a commit dated 2099 holds the top of 「最近更新」
for good.

**Unknown dates sort last**, among themselves by the star order, and their
cards show no date. An entry whose catalog carries no `added` (a cached
pre-v5 catalog) is unknown the same way, so the two orders degrade to the star
order rather than inventing one.

## 3. What counts as a date

The client is the boundary here: everything in a catalog is untrusted input,
and a catalog may also be one our own build did not write.

- `added` must match `YYYY-MM-DD` — the day form the registry writes and the
  only shape of it (`registry/scripts/src/emit.ts` enforces both the format
  and `added <= build date` on every build).
- `publishedAt` must match the ES date-time form with an explicit zone —
  `YYYY-MM-DDTHH:MM:SS(.mmm)?(Z|±HH:MM)`. The zone is required for a reason
  worth stating: offset-less date-time strings are parsed as LOCAL time, the
  one thing a shelf order must never depend on.
- Either string failing the form, parsing to `NaN`, or being later than
  `builtAt` makes the date **unknown**.
- An unparseable `builtAt` makes every date unknown, and both date orders
  degrade to the star order. Our own build always writes a valid one, and a
  corrupt cache already reports its staleness; this is the failsafe, not a
  case to handle.

All 14,546 live values satisfy both forms (measured), and neither current
producer emits an offset form — npm's `time[version]` and GitHub's commit date
are UTC `Z`. The forms are recognized because they are valid, not because they
are observed.

**One function answers both questions.** `shelfTime` decides whether an entry
has a date; the sort keys on it and the card's label is derived from the
parsed instant, so a card cannot show a date the sort never used.

**Why the guard is not a `Date.parse` call alone.** V8 accepts what the format
never promised: `Date.parse('2026-02-31T00:00:00Z')` answers 3 March, not
`NaN`, and `Date.parse('October 12')` answers a 2001 date. The form check
comes first; `Date.parse` is then asked only about strings that have a shape.
A rolled-over date (a `2026-02-31` from some future producer) is displayed as
the day it parses to, which is also the day the sort ranked it by — the two
agree, which is the property that matters here.

## 4. Where the reader meets it

- **The toggle** sits at the right end of the catalog's stats row, where the
  build date and the refresh button are: `排序 [星标] [最新上架] [最近更新]`.
  The three labels come from the locale table; the group is named by its
  visible 「排序」 label through `aria-labelledby` (an `aria-label` beside a
  visible label would be announced twice), and each button carries
  `aria-pressed`, as the category bar's buttons do. Keyboard reach is the
  browser's own tab order.
- **Default `stars`, no persistence.** A reload, a remount (the tab's error
  boundary, a self-update's client swap) and a first paint all start at the
  star order. Category, query and the incompatible switch are equally
  in-memory today; persisting one of the four would be a separate decision.
- **Switching resets the visible window** to `SHOP_VISIBLE_BATCH` (48), which
  is what every other control on the shelf does. The toggle sits above the
  list, so the reader is at the top of it when they click.
- **The card's date label**, under either date order, in the card's meta row
  beside the size and the author: 上架 2026-10-12 / Listed 2026-10-12, and
  更新 2026-10-11 / Updated 2026-10-11. UTC, the same calendar the catalog's
  build date is shown in. Under the star order no label renders, so the
  default shelf's appearance does not change.
- **Scope: the shelf.** All, every category, search results and the Installed
  view read the one ordered list. The Updatable section is a management list
  off the host's own installed state and keeps its own order.

## 5. Code

`packages/dsh-plugin-shop/src/client/present.ts` (pure):

```ts
export type ShelfOrder = 'stars' | 'added' | 'updated'

/** The entry's sort key under `order`, or undefined when it has no usable
 * date (§3). Milliseconds since the epoch. */
export function shelfTime(entry: CatalogEntry, order: ShelfOrder, builtAt: string): number | undefined

/** A UTC calendar day for display: "2026-10-12". Derived from the same
 * instant `shelfTime` returned, so label and order cannot disagree. */
export function utcDay(ms: number): string

/** The shelf in `order`. `'stars'` returns the input array itself. */
export function orderShelf(starOrdered: readonly CatalogEntry[], order: ShelfOrder, builtAt: string): readonly CatalogEntry[]
```

- **Stability** is the language's: `Array.prototype.sort` has been stable since
  ES2019, so sorting the star-ordered array by a date yields the star order
  inside each date block. It also keeps the tie-break definition in one place,
  `sortByStars`.
- **`'stars'` returns the input reference**, so the default path allocates
  nothing and does not invalidate the memos downstream of `sortedCatalog`.
  That is also why the result is `readonly`: on that path it IS the input.
- **Each key is computed once per entry** before the sort, never inside the
  comparator: `2·n·log n` `Date.parse` calls became `n`, and the comparator
  stays numeric.
- **Cost** (G-5's method: fresh process, 5 runs, `process.cpuUsage`). Local
  machine, 2026-10-12 catalog: `sortByStars` **17.8 ms/run** on the live
  14,546 entries, `orderShelf` `added` **9.2**, `updated` **11.6** — the key
  pass is 3.6 and 5.7 ms of those. The existing 9,400-entry budget test sees
  the same 60 ms cap and already brushes it on the Windows CI runner
  (62.4 ms, PR #73), so both date orders are measured against **that fixture
  size** rather than a larger one, to inherit the existing safety margin
  instead of inventing a new one: on a synthetic 9,400-entry catalog the two
  cost **5.1 and 7.2 ms** CPU per run, well inside the cap.

`packages/dsh-plugin-shop/src/client/ShopTab.tsx`:

- `starOrder = useMemo(() => sortByStars(result.plugins, stars), …)`, then
  `sortedCatalog = useMemo(() => orderShelf(starOrder, order, result.builtAt), …)`.
  Every existing consumer of `sortedCatalog` — `browsable`, `matched`, the
  installed filter, the counts — inherits the order, matching the comment
  already there ("one ordering is computed once and both lists carry it").
- A new `order` state and the toggle's markup in the stats row. Adding them
  needs `flex-wrap: wrap` on that row, which has none today: one more control
  would otherwise overflow at a narrow width.
- `EntryCard` gains `order` and `shelfDay` (a plain string; the card stays
  memoized, and locale text is composed at render, as `stars` already is).
- Six locale strings, Chinese and English: `sortLabel` (排序), `sortStars`
  (星标), `sortAdded` (最新上架), `sortUpdated` (最近更新), `listedOn`
  (上架 {date}), `updatedOn` (更新 {date}).
- CSS: the toggle reuses `.categoryButton`/`.categoryButtonOn` (their hue
  defaults to the brand token where no `data-category` is set), so the
  selected state is a border colour, a 14% fill and an inset ring — never a
  size change. The label reuses the size figure's style: mono, tabular
  numerals, secondary colour, at 12px.

**No host, RPC, catalog-schema or registry change.** The host already parses
`added` and `publishedAt` (both optional on the consumer) and returns entries
whole; the client reads what it already has.

## 6. Testing

- **`shelfTime`/`utcDay`** in `present.test.ts`: both forms accepted, and
  rejected — absent, non-string, unparseable, a date after `builtAt`, a
  date-time without a zone. A `+08:00` instant yields the UTC day, not the
  local one. A missing `builtAt` makes everything unknown.
- **`orderShelf`**: each order; date desc; ties keep the star order
  (a fixture whose dates tie and whose star order is the reverse of its name
  order, so a name tie-break cannot pass by accident); unknowns last and
  stable among themselves; `'stars'` returns the input reference (identity).
- **The property test, not a fixture**: for a generated catalog, every entry
  with a defined `shelfTime` sorts before every entry without one, and no
  pair with equal keys is reordered relative to the star order.
- **The budget test** beside the existing one: both date orders at 9,400
  entries under 60 ms CPU (§5).
- **`ShopTab.client.spec.tsx`**: the default is `stars` and no label renders;
  clicking 最新上架 puts today's block first with 上架 labels, and 最近更新
  does the same by `publishedAt`; going back to 星标 restores the star order
  and removes the labels; switching resets the visible window to 48; and an
  entry with no `added` still renders (bare card) in the date orders.
- **No new e2e case.** `web-full-flow.e2e.ts` drives the published-version
  flows and its selectors are untouched. Its existing run stays the check
  that the shelf still works end to end.
- **Rendered verification before the PR**, beyond the tests: the built client
  against a real dsh profile — the three orders, both themes, a narrow width,
  and a card with no date.

## 7. Not built, and why

- **Persisting the chosen order** (localStorage, a profile setting) and a
  per-category default order.
- **An "updated" order from GitHub's `pushed_at`** rather than the commit's
  author date: it is a registry-side change to what a listing records, not a
  client order, and it is out of C1's scope.
- **Relative dates** ("3 days ago"): the shop has no clock anywhere, and a
  relative label would go stale in an open tab.
- **A "new" badge on the card** under the star order, and **any order for the
  Updatable section** or the shadowed rows.
- **Hiding or disabling the date orders when no entry has a date** (a cached
  pre-v5 catalog): both would show the star order under a date label. The
  live catalog has carried `added` since v5 and those orders are what the
  reader asked for; a disabled control would need its own empty-state copy.

**A limitation, recorded rather than fixed.** A github entry's `publishedAt`
is the author date of the pinned default-branch commit, and `git` keeps the
author date across `commit --amend` and rebase. A plugin updated by amending a
recent commit is as current as one that pushed a new commit, and 最近更新
ranks the second above the first. The committer date would track the push
more closely, and `pushed_at` is already harvested; either is a registry
change.

## 8. Documentation and release

| Document | Change |
|---|---|
| This file | New. |
| `docs/superpowers/specs/2026-08-26-github-stars-design.md` | D1 amended: the star order stays the default and the tie-break; the two date orders join behind a toggle. The §9 non-goal "No sort toggle (D1)" is superseded. |
| `docs/design/2026-09-26-market-borrowings.md` | §6, the C1 row marked decided, pointing here. |
| `packages/dsh-plugin-shop/src/host/catalog.ts` | A stale comment beside `added` says "the client never renders it". It renders it from this change on; the comment is corrected with the code, not here. |

**Release.** Client-only, and nothing the host reads changes — no catalog
schema, no RPC shape — so CLAUDE.md's rule that a host-read change goes
through `beta` first does not bind here. The version and the channel are the
maintainer's call at release time. The READMEs pin `latest` and the
screenshots are shot from the published build, so the feature's description
in the package README and the six images both move in the promotion commit,
with the pin — never in this change, and never in a beta.
