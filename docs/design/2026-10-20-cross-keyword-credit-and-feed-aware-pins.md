# Cross-keyword credit and feed-aware pins — design

Status: **specified (2026-10-20), implemented (2026-10-21).** Answers the
tail-cap failures of 2026-10-19 and 2026-10-20. Amends
`2026-09-17-publisher-pinning.md` §2, §3 and §6,
`2026-10-04-change-feed-harvest.md` §4.5 and §4.7, and the search-coverage
section of the authority spec (`2026-08-18-dsh-plugin-shop-design.md`).

## 0. What breaks

From 2026-10-19 07:35 on, every catalog run but one stopped at Classify on
`keywords:deepseek-harness`'s tail cap. The runs were 16, 20, 15 and 17 names
short against the 14 `MAX_UNREACHABLE_RESIDUAL` allows; the exception, at
2026-10-20 04:40, read 5 and passed Classify. A red run committed nothing then
— the red run's own axis commit is design
`2026-10-22-publisher-axis-on-a-red-run`, later — so `publisher-state.json` on
`main` stood still all that time, and every one of those runs probed the same
400 pinned and 400 rotated publishers, from cursor 2799.

## 1. Measurements (2026-10-20)

A census paged every cell the harvest could ask of `keywords:deepseek-harness`:
- its window;
- all 47 refinement cells;
- the `keywords:deepseek-harness maintainer:U` cell of every one of the
  5,464 publishers in `publisher-state.json`.

The probe set of the committed state was modelled on top of the census, and
the model matches the runs. It predicts 213 names supplied by the pinned and
rotated cells; the 10:24 run reported 211.

1. **Real misses: 35.** The committed state cannot reach 35 names that npm
   counts under the keyword. All 35 have three things in common:
   - no fitting refinement: their only refinement keywords are `dsh` and
     `dsh-plugin`, and both of those cells are oversized (9,982 and 8,188
     names);
   - names outside `FEED_NAME_PATTERN`;
   - 14 owners, none of them probed.

   18 of the 35 are one family, `@toddzheng024/vapor-*`, published on
   2026-09-11. Re-paging the three truncated windows an hour later moved
   none of the 35, so rank churn does not explain them.
2. **The build already held most of them.**
   - 34 of the 35 carry `dsh-plugin`.
   - The `dsh-plugin` harvest read that keyword whole that run (9,191 of
     9,191) and served 23 of the 34:
     - 22 through its own pinned cells: `toddzheng024`, `raphael-liu` and
       `ghostcorn` are pinned for `dsh-plugin` and not for
       `deepseek-harness`;
     - 1 through its `dsh` refinement window.
   - 28 of the 35 are in the published catalog (`manifest.lock`).

   Coverage is counted per keyword, so the build stopped over names it
   held.
3. **The pins were spent on owners the feed already covers.** The
   keyword's at-risk names number 2,202, held by 1,479 owners, against 400
   slots, so the pinned set is FULL and refuses new owners.
   - 2,066 of those names are change-feed carriers, which the feed step
     credits when no search cell serves them, unless their owner's own cell
     omits them twice (§4.1).
   - The other 136 are held by 87 owners: 95 names outside
     `FEED_NAME_PATTERN`, and 41 pattern names the feed does not hold.
   - Only 22 of the 400 pins hold one of those 87. The other 378 hold
     owners whose at-risk names the feed already credits.
4. **Stale credits: about 15.** npm's replication feed emits no row for an
   unpublish.
   - Between seq 136,497,528 and 138,258,981, none of the 5 unpublishes
     checked has a row, while all 12 of the deprecations checked do.
   - The feed therefore never re-reads an unpublished carrier: 15 of the
     keyword's committed carriers are unpublished packages.
   - Each one is credited every run, and each one cancels a real miss in
     `required − enumerated`.
   - The verification step drops one only when its owner is among the 64
     sampled and the run commits.

   So the reported 17 is net: about 35 real misses less about 15 stale
   credits.
5. **Crediting by indexed keywords does not over-count.** Paging the
   `keywords:dsh-plugin` window again turned up 4,609 objects whose
   `package.keywords` lists `deepseek-harness` exactly.
   - Every one of them was served by a `keywords:deepseek-harness` query in
     the census.
   - No object in that window lists a case or spacing variant of the
     keyword.

## 2. Decision

Two changes ship in one PR, and a third follows it.

- **Cross-keyword credit (§3).** A name counts toward keyword `K`'s
  coverage when any search page of the run served it and its search object
  lists `K` exactly.
- **Feed-aware pins (§4).** Pins are seeded and earned only from names the
  change feed does not carry. A judged pin (§4.2) that seeding no longer
  names is released.
- **Stale carriers (deferred to its own PR).** It has to follow the two
  above. Removing the stale credits raises the reported shortfall by as
  many names as it removes (about 15 on 2026-10-20). Shipped first, it
  would turn a red build redder.

## 3. Cross-keyword credit

### 3.1 The rule

Take harvest keyword `K`, once its own cells have been paged. A name joins
`K`'s union when both hold:
- a search page served it this run, from any harvest keyword's window,
  refinement, oversized, publisher or verification cell;
- that page's object for it lists `K` in `package.keywords`, compared
  exactly, code unit for code unit.

This is a measurement, not an assumption. `keywords:K` counts the packages
whose indexed keywords contain `K`, and the search object carries those
same indexed keywords. Exact equality can only under-credit: npm may also
match a variant this rule ignores. The match cannot over-credit, and §1.5
measured it. Its timing can: a name published under both keywords after
the first keyword's total was read can be credited without being counted
(§3.2).

What it does not count:
- A name the authority spec's 2026-10-07 amendment carries is read from a
  packument, not served by a search, and stays out of every keyword's
  coverage as before.
- A feed credit remains the feed step's own.
- A keyword that appears only in a manifest is the gate's input, never this
  rule's.

### 3.2 Two phases

Today each keyword is paged and judged before the next one is paged, so the
first keyword in `HARVEST_KEYWORDS` (`dsh-plugin`) could never credit the
second's pages. `searchByKeywords` therefore runs in two phases.

**Phase one** pages every keyword's search cells: window, refinements,
oversized cells and publisher cells.

**Phase two** then takes each keyword in turn and does the following:
1. credits across keywords;
2. runs the feed step;
3. re-probes the total;
4. re-pages once if the keyword is short;
5. credits across keywords again;
6. reports, then checks.

Five consequences, all accepted:
- **The feed step comes after the cross credit.** A cross-credited name is
  not feed-only, so it is neither verified nor counted in `feed supplied`.
- **A re-page's new names reach later keywords only.** They count for
  keywords judged after the re-page, not for one already judged. A re-page
  recovers single omissions, and the error points toward under-crediting.
- **A red run costs more.** The second keyword is paged even when the first
  then fails its checks, which today it is not: about half an hour of
  requests on a run that is red either way.
- **A paging failure loses the earlier keyword's lines.** A request that
  throws while phase one pages the later keyword (a transport failure, a
  page with no total, a partition cell needing a `from` past the cap) ends
  the run before the earlier keyword is judged. That keyword's axis,
  coverage and shortfall lines, which used to print first, never print. A
  throw while judging logs as before. (Amended 2026-10-22: a coverage
  check's throw now waits until every keyword has finished, so a later
  keyword's lines print on a run an earlier keyword fails, and the run can
  commit its publisher axis; `2026-10-22-publisher-axis-on-a-red-run.md`,
  §3.1. A paging failure still loses them.)
- **The first keyword's credit can outrun its total.** Its `required` is
  the smallest of its partition-time total and its re-probes, while its
  cross credit draws on pages fetched up to one paging phase after its
  own. A name published under both keywords in that interval can be
  credited without being counted, and each such name hides one genuine
  miss: by estimate a few names on a typical run, though a family
  published under both keywords in that interval hides one genuine miss
  per name. The second keyword has had the same kind of skew on its own
  pages since every keyword is partitioned before any is paged
  (`2026-09-17-publisher-pinning.md`, the 2026-09-19 amendment to §4).

### 3.3 Report

The keyword's coverage line, `describeFeedCoverage`, gains `N served under
another harvest keyword` beside the feed's credits. A keyword made whole by
crediting therefore shows how.
- `FeedCoverage` gains `acrossKeywords`, a count that the handoff parses
  strictly.
- The line prints on every run: `classify.ts` and `build.ts` always pass
  `onCoverage`, and the feed step runs even when the feed is unavailable.

## 4. Feed-aware pins

### 4.1 Seeding and earning

A name that the change feed carries for `K` and no search cell serves is
credited by the feed step, unless two complete pagings of its owner's own
`keywords:K maintainer:U` cell omitted it, and that is the cell a pin for
the owner would page. A pin for its owner therefore reaches nothing the
feed step does not: the step credits the name, or has paged that cell
twice without it. The pins should go to the names only a pin can reach.

- **Seeding.** `atRiskOwners` and `atRiskNameCount` read only at-risk
  names that `feed.carriers` does not hold for `K`.
- **Earning.** A rotated cell earns its pin only when it supplied a new
  name the feed does not carry.
- **No feed.** On a run whose feed is unavailable, the carriers are empty
  and both rules are today's.
- **Report.** The at-risk figure becomes the population seeding read:
  `at-risk name(s) the change feed does not carry, seen this run`.

### 4.2 Release

Today a pin leaves only on a confirmed zero-total probe, or when an
unpartitioned keyword seeds completely. Under the rule in §4.1 that would
leave the 378 pins above in place for good, because the set is FULL. So
there is a third exit: a pin leaves when this run judged it and seeding did
not name it.

**Judged** means the pin was probed this run and one of the following
holds:
- its cell was skipped because the window and refinement cells had already
  served exactly as many of its names as the cell answered, and they had
  served no more of them once the keyword's last pass had run;
- some pass paged its cell in full, serving as many names as the cell
  answered on that pass, a total above zero.

**Not judged** are:
- a pin past the pinned half of the budget, even one the rotation probes;
- a zero-total probe, whether confirmed or not;
- a cell over the window;
- a cell skipped because it answered fewer names than the window and
  refinement cells had served its owner, when it was skipped or once the
  keyword's last pass had run (the counts disagree);
- a cell that served short of its own total on every pass.

**What equal counts establish.** Each way of being judged is a count met:
the window and refinement cells had served the owner exactly as many names
as the cell answered, or the cell's own paging served as many names as it
answered.
- The first reads equal counts as the same names. That holds while the
  `maintainer:` qualifier counts the same packages as the `maintainers`
  arrays on the objects those cells served.
- A cell answering fewer names than those cells served its owner shows the
  two counting differently, and such a skip is never evidence. The
  difference can show only after the skip: a retry pass can serve the owner
  a name the first pass omitted, so the count is read again at the end of
  the run.
- A paging pass whose cell answered a total of zero never counts as paged
  in full. Zero names served meets a zero total, and a zero total is never
  evidence.

**A guard on the evidence.** Every name the verdict rests on must carry a
non-empty `keywords` array: the names the window and refinement cells
served for that owner, or the names its own cell served.
- `isAtRisk` reads a name with no keywords as not at risk.
- A response that stopped carrying the field would therefore read every
  owner as safe and release every pin at once.
- Requiring the field is the evidence that the verdict came from the data
  it reads.

**Why this is now safe past the window.** The publisher-pinning design's
2026-09-18 amendment to §3 refused it, because "the owners this axis exists
for are precisely the ones it cannot show". That holds for unpinned owners.
A judged pin's own cell counts no more of its names under `K` than the run
was served, so seeding's verdict on that owner is complete as far as that
count can show.

**A release is judged against this run's reachable refinements.** A pin
released because every one of its owner's names carries a refinement `R`
loses any such name that sits past both windows on the day `R`'s own cell
crosses `SEARCH_WINDOW`, as the `,dsh` refinement's crossing cost the
catalog 24 packages between 2026-09-11 and 2026-09-14; the loss is bounded,
because seeding pins the owner again from any of its names still inside
`R`'s window.

**Not bounded by `MAX_EVICTIONS_PER_RUN`.** The first passing run releases
about 380 pins. A bound of eight would keep the set FULL for weeks.
- The zero-total exit keeps its bound: it guards a registry answering zero
  for real cells, which this exit cannot be triggered by.
- The report names the count and the exit:
  `released N judged pin(s) seeding no longer names`. (Amended 2026-10-22,
  PR #108 review: one sentence used to cover this exit and the
  complete-seeding one, which now reads `released N pin(s) seeding no
  longer names, the keyword counted whole inside its window`.)

**But a report the bound refused releases nothing.** When
`MAX_EVICTIONS_PER_RUN` refuses a report's evictions, the report releases no
pin, on this exit or the complete-seeding one. Every release rests on totals
the same registry answered in the same run: a cell skipped as covered, a
cell paged in full, a keyword enumerated whole. A pin the report lists as
evicted is never released either, so a refused eviction keeps its pin on
both exits.

**The handoff parser checks the count.** It refuses a record naming more
judged pins than it probed, since a pin is judged only by its own probe.

### 4.3 What it buys

After the first passing run, a keyword's pins are about 87 plus those earned.
`probeOrder` hands the remainder of the budget to the rotation, about 710
of 800. The vocabulary then cycles in about eight runs that advance it instead of
fourteen — a red run advances it too, through its own axis commit (design
`2026-10-22-publisher-axis-on-a-red-run`), and the owners of the 12 names that cross credit does not reach
(§5) are found that way.

## 5. Expected effect

These are estimates from 2026-10-20's data, not guarantees.
- **`deepseek-harness` with this PR:** 35 real misses less 23
  cross-credited leaves 12 real misses. With the stale credits still
  counted (about 15), the keyword reads whole or a few over.
- **With the stale-carrier PR as well:** about 12 short against the cap
  of 14, falling as the rotation earns pins for those owners.
- **`dsh-plugin`:** read whole on 2026-10-20, unchanged.

## 6. Invariants

- **Admit by keyword** still holds. Cross credit changes only what a
  keyword's coverage counts, never what the gate admits.
- **Coverage is still measured against npm's own total.** Every credit
  sits beside the final count on the report.
- **No new requests.** Cross credit reads fields already fetched. Feed-aware
  pins change which owners are probed, not how many probes are made.
- **The pure core keeps every policy decision.** The at-risk filter
  (`seedableNames`), the earning rule (`earnsPin`), the evidence rules that
  judge a pin (`judgedPins`) and the release rule (`applyAxisReport`) live
  in `publisher-state.ts`. The shell only measures:
  - for a pin whose cell it skipped, the cell's total, and how many of the
    owner's names the window and refinement cells had served when it was
    skipped and once the last pass had run;
  - for a pin whose cell it paged, each pass's total and how many names
    that pass served;
  - for a rotated cell, the names it added to the union.

## 7. Testing

`npm-client.test.ts`:
- **Cross credit.**
  - A name served only under the other keyword, whose object lists `K`,
    makes `K` whole.
  - A case or spacing variant is not credited.
  - Credit works with the crediting keyword first and with it second.
  - A cross-credited carrier is not feed-only.
  - `acrossKeywords` is reported.
- **Judging pins.**
  - Skipped as redundant: judged.
  - Paged in full: judged.
  - Served short on every pass: not judged.
  - Skipped with a total below what the window served: not judged.
  - Skipped as redundant, then a retry pass serves the owner a name past
    the cell's total: not judged.
  - A pass whose cell answered zero: not paged in full.
  - Zero total: not judged.
  - Over the window: not judged.
  - Any name without keywords: not judged.
  - A pin past the pinned half, probed by the rotation: not judged.
- **Seeding and earning** ignore carriers, and earning reads only the names
  a cell added to the union.

`publisher-state.test.ts`:
- `judgedPins` and `earnsPin` own their rules: a fixture drives every
  verdict.
- `applyAxisReport` releases judged pins that seeding did not name.
- It keeps unjudged pins and seeded pins.
- It releases nothing for a keyword with no record.
- It releases nothing, on either exit, from a report whose evictions the
  cap refused.
- A release frees a slot that a new seed then takes in the same run.

The parsers: `acrossKeywords` and `judged` are strict, with cross-field
checks (`judged` must be maintainer names and name no more pins than the
record probed, and `supplied` plus `acrossKeywords` cannot exceed
`enumerated`).

## 8. Deliberately not built

- **Stale carriers.** Next PR, for the order given in §2.
- **Advancing the cursor on a failed run.** The authority spec recorded
  this latent defect on 2026-09-14. This PR makes runs pass, which moves
  the cursor; a red run still freezes it. (Built 2026-10-22:
  `2026-10-22-publisher-axis-on-a-red-run.md`.)
- **A larger pin bound or probe budget.** The measurement says the pins
  went to the wrong owners, not that there were too few.
- **Counting names carried by the authority spec's 2026-10-07
  amendment.** Those names are read from a packument, not served by a
  search.
