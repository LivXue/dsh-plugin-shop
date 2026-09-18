# Publisher pinning — design

Status: **specified (2026-09-17), implemented (2026-09-18).** Answers
[#38](https://github.com/LivXue/dsh-plugin-shop/issues/38). The publisher
axis shipped in 0.8.1 rotates uniformly through its vocabulary and keeps no
record of which cells ever supplied a name, so a residue owner is probed with
the probability of the slice and not because it is a residue owner. This
design gives the axis a memory, and seeds that memory from data the harvest
already holds before the keyword that needs it crosses the search window.

## 0. What breaks, and when

`keywords:dsh-plugin` measured **5,066** on 2026-09-17 against a
`SEARCH_WINDOW` of 5,250 — one `size=1` search, the method
`PARTITION_KEYWORDS`' comment prescribes. That is **184 names of headroom**.
Against the six-day mean of 67/day (4,666 on 09-11 to 5,066 on 09-17, both
read the same way) it crosses in 2.8 days; against the last single-day
reading of 42/day, 4.4. **2026-09-20, ± a day.**

81 of its names carry no `PARTITION_KEYWORDS` refinement beyond the harvest
keyword itself (measured 2026-09-08, recorded in
`docs/plans/2026-09-08-publisher-partition.md`). No refinement cell can reach
them; they are reachable only while they sit inside the window. They are held
by 38 maintainers, of whom `huanlin` holds 21.

`MAX_UNREACHABLE_RESIDUAL` is 14 as of 2026-09-16 and that is the ceiling of
its bracket, so those 81 names do not fit under any tolerance this repo may
adopt. The build fails on the day they pass out of the window.

## 1. Why the shipped mechanism cannot cover the transition

Two properties of `selectPublisherCells`, both load-bearing and neither
stated in #38.

**The productivity signal does not exist before the crossing.** A cell is
selected when `cellTotal > servedFor.get(maintainer).size` — it can supply
names the window did not. Under the window the sweep serves every name, so
that predicate is false for every maintainer. The axis does not even run:
`selectPublisherCells` is called only when `partitioned` is true.

**After the crossing the signal exists but has to be found by chance.** The
vocabulary held 3,775 names on 2026-09-16 against a
`PUBLISHER_PROBE_BUDGET_DEFAULT` of 500, so one snapshot probes 13.2% of it
and a full cycle is 7.5 snapshots. Finding 38 specific owners by uniform
rotation therefore costs days, and the residual is over the cap throughout.

Persisting probe outcomes — #38's directions 1 and 2 — is a steady-state
mechanism and inherits both properties. On the first day past the crossing
its record is empty, because there was nothing to record.

## 2. The at-risk rule

For a harvest keyword `K` and a harvested name whose search object carries
`keywords`, let

```
R = (keywords ∩ PARTITION_KEYWORDS) \ {K}
```

`R = ∅` makes the name **at risk**: no refinement cell selects it, so it is
reachable only while its rank is inside `K`'s window. Its maintainers are
recorded as pinned for `K`.

**Rank is not part of the rule.** A name carrying a refinement is reachable
through that refinement's cell at any rank; only a name with no refinement can
become unreachable. Rank decides *when* a name passes out of reach, never
*which* names can. Selecting by rank would also require predicting future
ranks: the model that multiplies an uncovered rate by a tail length
over-predicted fivefold where it could be checked
(`docs/plans/2026-09-08-publisher-partition.md`), and the at-risk set by tag
is measurable exactly, today, with no prediction at all.

A name carrying the *other* harvest keyword is not at risk: both harvest
keywords are in `PARTITION_KEYWORDS`, so their intersection cell reaches it.

**Cost: no additional requests.** Every npm search object already carries
`keywords` beside `maintainers` — verified live 2026-09-17 against
`keywords:dsh-plugin`, whose objects expose `date, description, keywords,
license, links, maintainers, name, publisher, sanitized_name, version`. The
paging loop already reads `maintainersOf(object?.package)`
(`npm-client.ts:1719`) from that same object. `SearchBody` names only `name`
and `maintainers`, so the field is added to the type; the bytes are fetched
and parsed either way.

Seeding runs for any keyword the harvest pages in full — which is exactly the
condition under which the at-risk set is visible.

**Amendment (2026-09-18): this sentence does not hold for the shipped code —
see §4's amendment.** Seeding is not gated on full enumeration; it runs for
every harvest keyword each run, against whatever names that run's window
sweep and refinement cells actually put in `harvested`.

## 3. Pinning lifecycle

**Entry** is either of:

- *Seeding* (§2), while the keyword is still enumerable.
- *Outcome* — a rotated cell that supplied at least one name not already in
  the keyword's union is pinned, so a residue owner that appears after the
  crossing is found once rather than re-found by chance.

  Attribution here is **order-dependent**: two cells holding the same name
  credit whichever paged first. That is accepted rather than corrected,
  because the question pinning asks is "is this cell worth probing again",
  not "which cell owns this name". The order is deterministic (§4), so the
  answer does not vary between runs on the same state.

**Exit is `cellTotal === 0` for that keyword, and nothing else.** The
publisher no longer publishes under it.

A rule that evicts after N probes that supplied nothing is wrong here, and
wrong in a way that passes its own tests. Seeding is deliberately generous:
on 2026-09-17 none of the 81 at-risk names is past the window yet, so each of
the 38 cells supplies nothing on every run until the crossing. A
miss-counting rule evicts exactly those 38 during the days the design exists
to prepare for, leaving the pinned set empty on the day it is needed. The two
errors are not symmetric — a stale pin costs one probe per run, a wrong
eviction costs the crossing — so the predicate asks whether the publisher
still exists, not whether it has been useful lately.

Pinning is **per keyword**. Cells are `{keywords: [K], maintainer}`, so the
verdict is per keyword: a maintainer pinned for `dsh-plugin` must not be
evicted because its `deepseek-harness` cell supplied nothing.

## 4. Budget and probe order

```
order   = pinned[K] ++ rotation slice from cursor
rotation budget = PUBLISHER_PROBE_BUDGET_DEFAULT − |pinned[K]| probed
```

On the 2026-09-17 figures `dsh-plugin` seeds ~38 against a budget of 500 —
7.6%, leaving rotation essentially its current cycle.

`deepseek-harness` seeds **nothing**, and this asymmetry is inherent rather
than incidental: it crossed the window before this design existed, so it is no
longer enumerable and its at-risk set is no longer visible (§1). Its pinned set
starts empty and is built only by the outcome path (§3), one owner per
rotation encounter. The seeding half is available to a keyword exactly once,
in the interval before it crosses, and `dsh-plugin` is inside that interval
until about 2026-09-20.

**`nextCursor` advances by the rotation count, never by the budget.**
Advancing by the budget skips `|pinned|` publishers per snapshot, permanently
and silently — the vocabulary grows, every build is green, and a band of
maintainers is never rotated to. `nextCursor(state, budget)`'s present
signature is shaped to invite exactly that error.

Two guards:

- `MAX_PINNED_PER_KEYWORD` is **half the probe budget** (250 at the default
  500). Pinned probes therefore cannot take more than half a run, and rotation
  always keeps at least half — it degrades, it never starves. The at-risk share
  is ~2% of names, so at ~70 new names a day the set grows by roughly one owner
  a day and the bound is ~8 months out; it exists so that horizon is a bound
  rather than a cliff.
- **A full pinned set is reported, not thrown.** At the bound, seeding and
  outcome entries are being refused, which means newly-arrived residue owners
  are silently not pinned. That is the failure worth naming: a slower rotation
  is a coverage regression rather than an error, and discovering nothing new
  looks exactly like having nothing to discover.

**Amendment (2026-09-18): §2 and the two paragraphs above are wrong about the
shipped code, in three ways worth separating.**

**(a) Seeding is not gated on full enumeration, and that is deliberate.**
`searchByKeywords`'s `onPublisherAxis` callback fires, in its own words,
"even when the keyword never crosses the window, because
`vocabulary`/`atRiskNames` are informative on their own and a caller pinning
owners needs every keyword, not only the ones that partitioned"
(`npm-client.ts`). `atRiskOwners`/`atRiskNameCount` are computed against
`[...harvested.values()]` — whatever names that run actually put in the
harvested set, which for a partitioned keyword includes the mandatory
window-floor `pageCell` sweep and every refinement cell's contribution, not
nothing. Gating seeding on `!partitioned` would have thrown away exactly the
recurring, no-extra-request signal a keyword keeps producing after it
crosses — the one slice of the at-risk population still visible for free
every run — for no benefit: nothing else in the pinning lifecycle needs the
"fully enumerable" property, only the COMPLETENESS of what a single run's
seeding pass can see depends on it (see (c), below).

**(b) The "~38 against a budget of 500 — 7.6%" arithmetic, and "seeds
nothing" below, both rest on that false premise, and the real pinned set is
larger than either implies.** `deepseek-harness` seeds from its own
window-floor sweep too, and the at-risk rate across that slice is not
uniform. `PARTITION_KEYWORDS`'s own comment (`npm-client.ts`) measured, for
`deepseek-harness` pre-`deepwatch`: 7 of 250 uncovered — "uncovered" there is
the same predicate as "at risk" here, `R = ∅` — at ranks 5,000-5,250 (the
bottom of its former window, 2.8%), against 0 of 250 at ranks 2,500-2,750
(mid-ranking, 0.0%). At-risk names concentrate at the bottom of a window the
same way the uncovered ones did. That does not hand back an exact count —
this comment's own repeated instruction is to re-measure live rather than
trust a figure here, and no one has re-run `deepseek-harness`'s own
window-floor sweep specifically to count the at-risk names inside it — but a
2.8% band at the bottom of a window-sized sweep is not a rounding error
against a budget of 500, and it argues for tens of owners, not the zero the
paragraph below states. The real total the pinned sets reach across both
keywords is therefore larger than "~38 … 7.6%" by an unmeasured but
non-trivial margin.

**(c) For a keyword that IS partitioned, seeding is structurally incomplete,
though not for the reason first written here.** An at-risk name (§2, `R =
∅`) carries no `PARTITION_KEYWORDS` refinement, so by that same definition no
`keywords:K,r` cell can ever match it — refinement cells are the one source
that can never contribute an at-risk name to `harvested`. The window-floor
sweep is a source, but not the only one: `harvested` is fed by every
`pageCell` call this run makes, publisher cells included — both the pinned
loop and the rotated loop pass it (`npm-client.ts`) — and
`atRiskOwners`/`atRiskNameCount` (§2) run over the whole map,
unconditionally, before `seeded` is built. So a publisher cell probed and
paged this run, pinned or freshly rotated to, hands seeding any at-risk name
it holds at whatever rank that name sits, window or past it — the maintainer
axis does not filter by rank under `K`, which is the entire point of running
it. Seeding is in fact the BROADER of the two entry paths, not the narrower:
it counts a name the instant `harvested` holds it, with no delta test, while
the outcome path (§3) fires only from the rotated loop and only when the
name is new to the run's union. A rotated cell that earns a pinned spot this
run (`delta > 0`) satisfies both paths in the same run, off the same
`harvested` entry.

The real gap is narrower than "past the window, only the outcome path
reaches it": nothing guarantees that the cell holding a given past-window
at-risk name is selected and paged this run at all. Publisher-cell selection
is the pinned list plus a rotation slice under budget, filtered by the
productivity test (§4); a maintainer not yet pinned is reached only if
rotation happens to land on it. So a partitioned keyword's seeding this run
sees the window-floor sweep (every at-risk name ranked inside the window,
every run) plus whatever the publisher axis — pinned and rotated together —
happens to probe and page (any rank, but only for the maintainers actually
selected). Neither term is complete on its own, and their union is not
guaranteed to be either — which is the sense in which this paragraph's
original claim of incompleteness is right, for the wrong mechanism.

The two axes are not independent, and the loop between them is worth naming
rather than leaving implicit: an outcome-path probe that surfaces a residue
owner earns it a pinned spot (§3), and from the next run on, that owner is
probed unconditionally rather than left to rotation's odds — widening the
NEXT run's seeding input, for as long as the owner keeps publishing under
the keyword. The publisher axis feeds seeding; it does not only sit beside
it.

This is not a bug to fix — it is why §3 has two entry paths instead of one,
and why the design accepts that a crossed keyword's pinned set stays
incomplete rather than promising seeding, the publisher axis, or their
combination will eventually enumerate it.

## 5. Module placement

The at-risk rule and the probe order are policy and belong in the pure core,
per the repository's one architectural rule. `publisher-state.ts` is already
pure (`parsePublisherState`, `serializePublisherState`, `mergePublishers`,
`nextCursor`) and is where they go:

```ts
export function atRiskOwners(
  names: readonly { keywords: readonly string[]; maintainers: readonly string[] }[],
  harvestKeyword: string,
  refinements: readonly string[],
): string[]

export function probeOrder(
  state: PublisherState, keyword: string, budget: number,
): { pinned: string[]; rotated: string[] }
```

`npm-client.ts` keeps the requests and keeps none of the decisions.

This also gives the selection its first test surface. `selectPublisherCells`
is today a closure inside `searchByKeywords` over `servedFor`, `probe`,
`publishers` and `publisherProbeOffset`; it is reachable only through a stubbed
`searchByKeywords`, which is why no measurement of how many cells it selects
exists anywhere in the repository or its logs.

### State

```ts
export interface PublisherState {
  publishers: string[]
  cursor?: number
  pinned?: Record<string, string[]>   // keyword -> maintainers, sorted
}
```

`pinned` is serialized sorted, like `publishers`, so the committed file does
not depend on insertion order. Entries are validated with `isMaintainerName`
on parse and a malformed `pinned` throws, per "failing loudly".

## 6. Observability

The axis currently emits one line, `publisher vocabulary 3735 -> 3775`. It
reports neither how many cells it selected nor what they contributed, so its
own effect has never been measured. A sibling of `describeShortfall` reports,
per keyword and into both the CI log and the build report:

```
keywords:dsh-plugin publisher axis — vocabulary 3775, 38 pinned
(38 probed, 0 supplied), 462 rotated from cursor 1305 (3 supplied 7 names),
seeded 2 new owners from 81 at-risk names
```

**The inputs are reported, not only the results.** An empty vocabulary is a
legal no-op: 0.8.1 shipped one and CI was green while the axis did nothing.
`vocabulary 0` has to be visible as a value, not as an absent line.

## 7. Testing

Fixtures drive every rule; no module under test is mocked. Three cases are
load-bearing:

1. **The crossing.** One pinned set exercised first under the window and then
   past it, asserting the seeded owners are still pinned and still probed.
   This is the only case that catches a miss-counting eviction rule (§3);
   every fixture written entirely past the window agrees with the wrong rule.

   **Amendment (2026-09-18): that last sentence overstates it.** An immediate
   `cellTotal === 0` eviction rule and an N-miss-streak rule produce the same
   `probed` array on this test's one past-window call, because probing
   always precedes any eviction decision and the test never reads `evicted`
   — it cannot discriminate the predicate's wording, and does not. What it
   actually locks in: the real, unstubbed at-risk path (`atRiskOwners`)
   seeds the owner while `dsh-plugin` is still inside the window (confirmed
   by reverting a mutation that dropped it from the seed line); and
   `probeOrder` (`publisher-state.ts`) sources the pinned-probe list
   unconditionally from the persisted map — no re-derivation of at-risk
   status, no window-crossed check — so a name earned under the window is
   still probed on a later, past-window run even when it is absent from that
   run's own rotation vocabulary. Chaining the first call's real `seeded`
   output into the second call's pinned argument is what makes this a
   regression lock rather than a fixture. The eviction predicate itself is
   covered elsewhere, by 'evicts a pinned publisher whose cell total is
   zero, and only that one' (`npm-client.test.ts:2588`, immediate, not after
   a streak) and 'does not evict a pinned publisher that merely supplied
   nothing' (`npm-client.test.ts:2600`, keyed on `cellTotal`, not on
   supplied-delta). A cross-run PERSISTED miss counter is untested because
   none exists: `parsePublisherState` drops unknown top-level keys, so one
   cannot appear by accident, but nothing today would catch a
   badly-implemented one either, since no test models multi-run persisted
   state.
2. **Cursor advance.** Rotation spends `budget − |pinned|`, so the cursor
   advances by the rotation count. Asserted against a pinned set large enough
   that the two differ.
3. **Reporting with an empty vocabulary**, against the 0.8.1 regression.

The rest: the at-risk predicate (a refinement excludes; the bare harvest
keyword includes; the other harvest keyword excludes); exit on `cellTotal ===
0` and no exit on a cell that merely supplied nothing; per-keyword isolation;
probe order; the half-budget report; and state round-trip, including a
malformed `pinned` throwing and sorted serialization.

## 8. Deliberately not built

- **A second cursor inside the pinned set.** It addresses a pinned set larger
  than the probe budget, which the §4 growth rate places months out and which
  the half-budget report announces well before it arrives. Adding it now fixes
  a hypothetical with state shape.
- **Replacing the probe with a page.** `probe` is a `size=1` search and
  `pageCell` a `size=250` one whose first response already carries the total,
  so for a publisher under one page the probe is a second request for
  information the page returns. Whether that converts into coverage depends on
  body size and rate-limit exposure under `MAX_SEARCH_BODY_BYTES`, which is
  unmeasured. It is orthogonal to selection — a multiplier on whatever order
  §4 produces — and belongs to its own measurement.
- **A covering harvest.** No query-based axis is covering, because the `from`
  cap is the wall and both axes are queries. The replication feed remains the
  only covering route and remains priced in the design doc's 2026-09-08
  follow-up.
