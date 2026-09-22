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
sweep, refinement cells and publisher cells actually put in `harvested`.

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

### 2026-09-18 amendment: a zero is confirmed, and one run's evictions are bounded

`cellTotal === 0` remains the only predicate, but a single observation of it
is not enough to act on, and the reason is in this module's own record: a
numeric zero total is a legal answer npm serves for a real query, and the
same search has been observed serving a 249-object page of a 600-name set and
a 200 carrying `<!doctype html>`. Two rules follow, and they cover different
failures:

- **Confirmed.** A zero is re-probed once, and the pin is reported evicted
  only if the second answer agrees. This costs one request and only on a
  zero, which is rare by construction — every maintainer in the vocabulary
  was read off a `keywords:<harvest>` result.
- **Bounded.** At most `MAX_EVICTIONS_PER_RUN` (8) pins may leave in one run;
  past that the run removes *none* and says so. Confirmation cannot catch a
  *correlated* zero — a degraded index answers zero twice as readily as once,
  milliseconds apart — but the count can: pinned owners unpublish one at a
  time, and the set grows by roughly one owner a day, so a run reporting many
  at once is describing the registry rather than the ecosystem. All or
  nothing, because applying the first 8 of 200 turns a registry fault into a
  silent partial one. Enforced in `applyAxisReport`, so the untrusted
  `--harvest-from` path — which never probed anything — is covered by the
  same rule.

This is the asymmetry §3 already states, applied to the evidence rather than
only to the predicate: a stale pin costs one probe per run, a wrong eviction
costs the crossing.

### 2026-09-18 amendment: a keyword under the window has complete knowledge, and may forget

Entry runs for every keyword; exit as stated above is `selectPublisherCells`'
alone, and that only runs once a keyword partitions. Left there, the pinned
set of a keyword still inside its window is **monotone** — it can only grow,
climbing to `MAX_PINNED_PER_KEYWORD` and then reporting itself FULL about a
set nothing has ever probed.

So exit has a second form, available exactly while the first is not: when the
keyword enumerated **whole** and inside its window, every name it has was
paged, so the seeded set is the whole at-risk owner set and a pin it does not
name has stopped being at risk (an unpublish, or a package that gained a
refinement keyword). The run then replaces the pinned set rather than growing
it. Past the window the seeded set is only what the window sweep showed — the
owners this axis exists for are precisely the ones it cannot show — so there
the set may only grow, and the probe is the only exit.

`AxisOutcome.seedingComplete` carries the licence to the pure module, and it
is **not** simply `!partitioned`: a tolerated shortfall (up to
`MAX_SEARCH_SHORTFALL`) means a handful of names went unseen, and one of them
may be a pinned owner's only at-risk package. Removing that pin would cost
exactly what §3 says an eviction costs, on the one day the mechanism exists
for, so the licence requires both — inside the window AND enumerated whole.
`partitioned` stays on the report, where it distinguishes a keyword that
printed zeros because it was never probed from an axis that is broken.

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

**And so is the cursor** — see §4's 2026-09-18 amendment, which is the same
argument reaching its own conclusion one step later.

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

**(b) "Seeds nothing" below is wrong as an absolute — but only just, and by a
margin that is already measured.** `deepseek-harness` is partitioned, and a
partitioned keyword runs a mandatory window-floor `pageCell` sweep into
`harvested` (`npm-client.ts`), so its seeding pass does see every at-risk
name ranked inside the 5,250 that sweep serves. A sweep that runs and finds
little is not the same statement as a sweep that does not run.

How little it finds has already been counted, in the very comment this
section cites. `PARTITION_KEYWORDS`'s own comment (`npm-client.ts`) records
**one** name in the 5,250 `deepseek-harness` can address as carrying no
refinement from that list beyond the harvest keyword itself — `R = ∅`, the
same predicate as "at risk" here. That population is exactly the one the
window-floor sweep serves, so the figure needs no adjustment to apply to
seeding. It was measured 2026-09-08, and that comment's standing instruction
is to re-measure live rather than trust a figure written down; re-measure
before acting on it.

**No owner count for `deepseek-harness` has been measured.** The 38 owners in
§0 are `dsh-plugin`'s, and `PARTITION_KEYWORDS`'s comment refuses a ratio
across these two populations in both directions, so neither keyword's figure
may be converted into the other's.

So the real magnitude is CLOSE TO the "nothing" below rather than far from
it: one at-risk name, of unmeasured ownership. What needs qualifying is the
absolute wording, not the design consequence — `deepseek-harness`'s pinned
set is still built essentially by the outcome path. And `dsh-plugin`'s "~38
against a budget of 500 — 7.6%" is measured against `dsh-plugin`'s own fully
enumerated name set and its own budget; nothing here touches it.

> **Corrected 2026-09-18, the same day this amendment was written.** As first
> written, (b) asserted that "no one has re-run `deepseek-harness`'s own
> window-floor sweep specifically to count the at-risk names inside it", and
> from the pre-`deepwatch` 2.8% band at ranks 5,000-5,250 argued for "tens of
> owners, not the zero the paragraph below states" — and that the "~38 …
> 7.6%" arithmetic rested on a false premise. All three were wrong. The count
> exists and is the 1-of-5,250 above; the band figure is the one number in
> that comment that may not carry such an argument, since the comment flags it
> as "not reconciled with the 1-of-5,250, so neither may be multiplied against
> the other keyword's figure"; and the 7.6% is `dsh-plugin`'s own and never
> depended on `deepseek-harness`. The paragraph below under-claims by rounding
> one down to zero; this point then over-claimed in the other direction by an
> order of magnitude, off a superseded figure. Recorded rather than quietly
> rewritten: an amendment whose whole job is accuracy is the last place to
> make a silent correction.

**(c) For a keyword that IS partitioned, seeding is structurally incomplete,
though not for the reason first written here.** An at-risk name (§2, `R =
∅`) carries no `PARTITION_KEYWORDS` refinement, so by that same definition no
`keywords:K,r` cell matches it — refinement cells are the one source that
does not contribute an at-risk name to `harvested`. "Does not", not "cannot":
`keywordsOf` truncates at `KEYWORDS_MAX_COUNT` (`npm-client.ts`), so a
package declaring more than 128 keywords with its refinement past the cut is
recorded as carrying none of them, and is then served by that refinement's
cell *and* scored at risk. Exotic — no real package approaches that bound,
which is why it is a defensive ceiling — but it is the one way around the
structural claim, and it is a truncation bound rather than anything about
tags.

The window-floor sweep is a source, but not the only one: `harvested` is fed
by every `pageCell` call this run makes, publisher cells included — both the
pinned loop and the rotated loop pass it (`npm-client.ts`) — and
`atRiskOwners`/`atRiskNameCount` (§2) run over the whole map,
unconditionally, before `seeded` is built. So a publisher cell probed and
paged this run, pinned or freshly rotated to, hands seeding any at-risk name
it holds at whatever rank that name sits, window or past it — the maintainer
axis does not filter by rank under `K`, which is the entire point of running
it.

**Over at-risk names** — this paragraph's whole subject — seeding is in fact
the BROADER of the two entry paths, not the narrower: it counts such a name
the instant `harvested` holds it, with no delta test, while the outcome path
(§3) fires only from the rotated loop and only when the name is new to the
run's union. Outside that scope the two are incomparable rather than nested,
because the outcome path is not restricted to at-risk names: a rotated cell
whose new names all carry a refinement earns a pin while seeding nothing. So
a rotated cell that earns a pinned spot this run (`delta > 0`) satisfies both
paths off the same `harvested` entry when that entry is at risk, and only the
outcome path when it is not.

The real gap is narrower than "past the window, only the outcome path
reaches it": nothing guarantees that the cell holding a given past-window
at-risk name is selected and paged this run at all. Publisher-cell selection
is the pinned list plus a rotation slice under budget (§4), filtered by the
productivity test (§1); a maintainer not yet pinned is reached only if
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

### 2026-09-18 amendment: the cursor is per keyword, and advances by positions WALKED

Two corrections to the arithmetic above, both of which silently cost coverage.

**One cursor cannot serve two keywords.** The rotation budget is
`PUBLISHER_PROBE_BUDGET_DEFAULT − |pinned[K]|`, which is per keyword by
construction, so two keywords with different pinned sets walk different
distances in one run. A single shared cursor has to advance by one of those
distances and is wrong for the other keyword either way: advance by the larger
and the more-pinned keyword skips a band every run; advance by the smaller and
the other re-probes ground it covered. The skip is not self-healing, because
whether the band is ever revisited depends on `gcd(advance, |vocabulary|)`.
Simulated against the shipped `probeOrder`/`nextCursor` at a 500 budget with
250 pins on one keyword: at a vocabulary of 4,000 that keyword reaches 2,000
publishers and **never** the other 2,000; likewise at 3,500, 4,500 and 5,000;
2,007 runs to full coverage at 3,999, against 8 with no pins. The vocabulary
grows a few names a day and walks through all of these. The keyword that
accumulates the most pins is `deepseek-harness`, which is the keyword the axis
exists for.

So `cursors: Record<string, number>` — the same shape change `pinned` already
carries, for the same reason. The legacy scalar `cursor` stays as the seed for
a keyword with no entry of its own, written as the MINIMUM over `cursors`: the
only value that cannot put a reader ahead of a keyword's own lap.

**The advance is `stepped`, not `rotated.length`.** The walk skips a candidate
already in the pinned set, consuming a vocabulary position without returning
one, so advancing by the rotation length restarts the next run inside the band
this one already covered — about 16 wasted probes a run at the 250-pin bound
over a 3,775-name vocabulary, and a correspondingly longer lap. `probeOrder`
returns `stepped` alongside the two lists.

This also restores, as arithmetic rather than as a special case, the no-churn
property the earlier `size <= budget` guard carried: a run that walked the
whole vocabulary has `stepped === size`, and `(cursor + size) % size` is
`cursor`, so a budget at or above the vocabulary leaves the committed file
untouched.

**Related, and the reason the pinned half is capped at half the BUDGET:**
`|pinned[K]|` was sliced at `min(budget, MAX_PINNED_PER_KEYWORD)`, so
"rotation always keeps the other half" held only while
`budget === 2 × MAX_PINNED_PER_KEYWORD` — a coincidence between two constants
declared in different modules. Any smaller budget handed the whole of it to
the pinned set, leaving the rotation empty and the cursor frozen. The slice is
now `min(|pinned[K]|, ⌊budget/2⌋)`, which makes the guarantee a property of
`probeOrder` at every budget.

### 2026-09-19 amendment: the budget is a run pool split by tail, not a per-keyword grant

```
tail[K]   = max(0, total[K] - SEARCH_WINDOW)
pool      = PUBLISHER_PROBE_BUDGET_DEFAULT x |keywords that partition|
floor[K]  = max(2 x |pinned[K]|, MIN_PROBE_BUDGET_PER_KEYWORD)
budget[K] = floor[K] + (pool - SUM floor) x tail[K] / SUM tail
```

The grant this replaces — every partitioning keyword receives
`PUBLISHER_PROBE_BUDGET_DEFAULT` outright — is measured against what it bought
in the 2026-09-19 published build report:

| keyword | tail | residual | pinned probes -> supplied | rotation probes -> supplied |
| --- | ---: | ---: | ---: | ---: |
| `dsh-plugin` | 376 | 1 | 45 -> 0 | 455 -> 0 |
| `deepseek-harness` | 1,969 | 15 | 228 -> 13 | 272 -> 0 |

Half the run's probes went to the keyword one name short of complete and
recovered nothing, while the keyword at 15 of the 20 names
`MAX_UNREACHABLE_RESIDUAL` allows took the smaller rotation. The grant is not
merely flat but anti-correlated with demand: `probeOrder` caps the pinned half
at half the budget and gives the remainder to the rotation, so the smaller
pinned set draws the larger rotation share.

**The pool is the old spend.** `PUBLISHER_PROBE_BUDGET_DEFAULT` times the
keywords that partition is exactly what the grant cost, so this is a
redistribution and never a raise: a lone crossing keyword receives precisely
what it received before, and the per-run request arithmetic that constant's
comment owns is unchanged. At the measurement above the split is 171 / 829,
which moves `deepseek-harness`'s rotation cycle from 14.3 runs to 6.5 and
`dsh-plugin`'s from 8.5 to 31.

**Demand is the tail, although the residual is the target.** The residual is
known only after the cells page and the allocation is fixed before the first
probe. It is also a small integer that reaches zero, so a share keyed to it
would stop a keyword's rotation on the run after a clean one — the run its
tail grew. The tail is measured before any probe, is thousands of names wide
and moves smoothly. As a proxy it is loose but ordered the same way: tail per
missing name was 376 and 131 on 2026-09-19, within a factor of 2.9.

Two floors, each answering a way a bare proportional split fails:

- **Twice the pinned set**, so `probeOrder`'s half-the-budget cap still reaches
  every pin. An unprobed pin supplies nothing and is never evicted either, so
  starving the pinned half raises the residual the allocation exists to lower,
  and that half is the productive one — 13 of 13 recoveries above. Stated
  against `probeOrder`'s own rule rather than against `MAX_PINNED_PER_KEYWORD`,
  so the two cannot drift apart.
- **`MIN_PROBE_BUDGET_PER_KEYWORD` (100)**, a policy floor rather than a
  measured optimum. Only the rotation can seed a keyword's first pin and a
  pinned set accumulates across runs, so a purely proportional split holds the
  smallest tail at zero pins permanently — the standing start of §1, one
  keyword at a time. Against the 3,887-name vocabulary committed 2026-09-19, a
  keyword held at this floor cycles in 39 runs.

When the floors exceed the pool, the pool wins and is split in their
proportion: the budget is a cap before it is an allocation.

**Every keyword is partitioned before any is paged**, because a
demand-proportional split cannot be computed from the first keyword's tail
alone. This costs no extra request on a run that completes; on one that throws
while paging it has spent the later keyword's refinement probes early, and the
converse is the better half of that trade — a keyword no refinement splits now
throws before the earlier keyword pages five thousand names it is about to
discard.

**What this does not fix.** The pool is unchanged, so the axis reaches no name
it could not reach before; it reaches the residue sooner. The residual drifts
about 2.5 names a day, `dsh-plugin`'s tail is growing, and once the two tails
are comparable the split returns to roughly even. This buys time on issue #38
exactly as the cap raise did, differing only in that it costs nothing and
surrenders no guard.

### 2026-09-22 amendment: the bound is 400 and the budget 800, because the horizon above was wrong by a factor of three

The two guards in this section predicted `MAX_PINNED_PER_KEYWORD` was "~8
months out" at one owner a day. Measured, from `registry/publisher-state.json`
on `main` after each run, `keywords:deepseek-harness` pinned:

| date | 09-19 (published) | 09-19 (merge) | 09-20 | 09-21 | 09-22 |
| --- | ---: | ---: | ---: | ---: | ---: |
| pinned | 228 | 233 | 234 | 236 | 239 |
| at-risk names seen | 235 | 241 | 242 | 244 | — |

About 2.75 owners a run, and 239 of 250 within four days.

**What the estimate missed is the shape of seeding, not its rate.** The set
does not accumulate slowly against the at-risk population, it tracks it:
nearly every at-risk name contributes a distinct owner, so the pinned set sits
a few names below the at-risk owner count and binds as soon as that count
reaches the bound. Size any future raise against the at-risk owner count and
its growth, never against the keyword's own growth.

**The bound cannot be raised alone.** With the budget allocated by tail
(the 2026-09-19 amendment), every keyword at the bound at once makes the
allocator's floors — twice each pinned set — sum to `2 x C x K` against a pool
of `P x K`, so the floors fit only while `C <= P / 2`. Past that the allocator
clamps, `probeOrder` slices `⌊budget/2⌋` of a larger set, and because
`pinFor` stores the set sorted by code unit the slice is the same alphabetical
prefix every run: the tail is pinned in name only, and silently, since the
axis line reports the set's size and not how much of it was reached. So the
pair moves together, 250/500 to 400/800, and `publisher-state.test.ts` asserts
the property through `allocateProbeBudgets` and `probeOrder` rather than as
arithmetic between two literals.

**What it costs.** The pool is `P x |keywords that partition|`, so a run goes
from 1,000 probes to 1,600. At the 1.1-1.3s per probe already measured, that
is 11-13 minutes added to `Classify new listings`, which took 32m38s, 32m45s,
33m12s and 36m40s over 2026-09-19 to 2026-09-21 (the step's `started_at` to
`completed_at` in `actions/runs/<id>/jobs`). The `build` job took 62m30s to
71m20s over the same runs against `daily.yml`'s `timeout-minutes: 120`, so the
worst observed run lands near 84 minutes with about half an hour of margin.
Derived from a measured per-probe cost, not measured end to end: no run exists
at this pool yet, and those four figures should be re-read once one does.

**Where it buys risk.** Exposure scales with the pool, and
`PUBLISHER_PROBE_BUDGET_DEFAULT`'s comment records that sustained pressure is
what escalated to the 503 that `searchTotal` does not retry. 1,600 sequential
probes sits closer to the 3,474 that produced that 503 than 1,000 did; what
still separates them is shape rather than size, since the pool is split across
two keywords and interleaved with paging instead of run as one burst. This is
the first constant to lower if a 503 returns, and lowering it means lowering
the bound in the same change.

**Why this half and not the rotation's.** Over the four runs after the budget
became demand-allocated, the pinned half supplied 13, 15, 19 and 32 names
against the rotation's 0, 3, 1 and 0 — about 66 names from 695 probes against
4 from roughly 1,769. Taking the rotation's share instead of paying for new
probes was the cheaper option and was rejected: the rotation's value is a
full-cycle property, it is the only path to an owner the at-risk rule cannot
see, and holding it at a fixed reservation would have moved its cycle from 6.8
runs to 26 — long enough that a family event reddens the build before the
rotation finds it, which is the event this axis exists for.

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
  cursor?: number                     // seed for a keyword with no entry below
  cursors?: Record<string, number>    // keyword -> rotation position
  pinned?: Record<string, string[]>   // keyword -> maintainers, sorted
}
```

Both keyed maps are serialized sorted, like `publishers`, so the committed
file does not depend on insertion order. Entries are validated with
`isMaintainerName` on parse and a malformed `pinned` throws, per "failing
loudly".

Both carry the **two** bounds every list this repo reads carries:
`MAX_PINNED_PER_KEYWORD` caps the names under one key and
`MAX_PINNED_KEYWORDS` caps the keys. And both are **pruned** to the current
`HARVEST_KEYWORDS` on write (`retainPinned`), because every writer copies each
existing key forward: a key written once by a since-renamed keyword, or by a
handoff naming a keyword this build does not harvest, would otherwise
round-trip into the committed file forever with nothing able to probe, evict
or report it. An empty `keyword: []` entry is dropped on read as well as on
write, for the same reason.

## 6. Observability

The axis currently emits one line, `publisher vocabulary 3735 -> 3775`. It
reports neither how many cells it selected nor what they contributed, so its
own effect has never been measured. A sibling of `describeShortfall` reports,
per keyword and into both the CI log and the build report:

```
keywords:dsh-plugin publisher axis — vocabulary 3775, 38 pinned,
38 probed (0 supplied), 462 rotated from cursor 1305 (7 supplied),
7 name(s) recovered, seeded 2 owner(s) from 81 at-risk name(s) seen this run
```

**The inputs are reported, not only the results.** An empty vocabulary is a
legal no-op: 0.8.1 shipped one and CI was green while the axis did nothing.
`vocabulary 0` has to be visible as a value, not as an absent line.

### 2026-09-18 amendment: what the line carries, exactly

Four corrections, each of which left a real state unreportable.

- **Every counter is in NAMES.** This section originally wrote
  `(3 supplied 7 names)` for three CELLS supplying seven names, while the
  implementation's `rotatedSupplied` counts names. A fixture carried those
  numerals into the fields, asserting `pinnedSupplied: 0, rotatedSupplied: 3,
  suppliedNames: 7` — a record the production path cannot emit, since the two
  halves and the total are one identity. The redundant total is gone (the line
  prints `pinnedSupplied + rotatedSupplied`), so the inconsistent state is no
  longer representable, and the example above is in the units the code keeps.
- **The pinned SET SIZE is reported**, not only how many of it were probed.
  Every probe counter is legitimately zero for a keyword still inside its
  window, so without it the line for 38 seeded owners waiting for the crossing
  is byte-identical to the line for seeding that has never worked — the 0.8.1
  failure this section exists to prevent. A set at `MAX_PINNED_PER_KEYWORD` is
  reported as FULL from that size rather than from a second field, and what
  the bound actually REFUSED is counted and named by `applyAxisReport`, in the
  run that refused it.
- **A keyword inside its window says so**, rather than printing a row of
  zeros that a broken axis prints too.
- **The at-risk count is printed unconditionally.** Gated on
  `seeded.length > 0`, it vanished in exactly the case where it is diagnostic:
  `isAtRisk` answers false for any name whose `keywords` array is absent, so a
  search response that stopped carrying the field would make seeding a
  permanent no-op and print a line indistinguishable from a healthy run.

A run whose `--harvest-from` handoff carries **no** axis record at all is also
reported, by `build.ts`, as the no-op it is: it pins nothing, evicts nothing
and advances no cursor, and an absent heading looked exactly like a healthy
run with nothing to do.

Finally, the keyword is **escaped** into the report like every other untrusted
string this repo publishes. On the handoff path it is JSON a build did not
produce, and `isPinnableKeyword` holds it only to a length and three refused
names — a newline forges an extra bullet in the published `report.md`.

### 2026-09-18 amendment: reachability is measured, not assumed

§2 scores a name safe when it carries any `PARTITION_KEYWORDS` entry other
than the harvest keyword. That is right before the crossing, where nothing has
been measured and every refinement still has its own window to spend; it is
wrong after it. `partitionKeyword` splits refinements into cells that fit
their own window and `oversized` ones that do not, and an oversized cell is
paged with `'stop'` — truncated at `SEARCH_WINDOW` exactly as the bare keyword
is. A name whose only refinement is one of those is reachable by **nothing**
past its rank, and scoring it safe hides precisely the population this axis
exists for. `keywords:deepseek-harness,dsh` crossing its own window is on the
record: it cost the catalog 24 packages between 2026-09-11 and 2026-09-14.

So a partitioned keyword measures its at-risk set against the refinements
whose cells it actually paged in full — the two-keyword cells, since a deeper
`[K, R, S]` split reaches a name only if it also carries `S` and so does not
make `R` alone sufficient. An un-partitioned keyword keeps the full list,
which there is a forecast rather than a measurement.

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
