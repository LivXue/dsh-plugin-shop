# Change-feed harvest -- design

Status: **specified (2026-10-04).** Approach A, chosen by LivXue on
2026-10-04. Reads npm's replication change feed to find dsh plugins by
publication time, so the residue that npm search ranks beyond every
5,250-name window is harvested instead of tolerated, and the 60-name
stopgap in `MAX_UNREACHABLE_RESIDUAL` can come down.

## 0. What breaks, and when

Both harvest keywords are past `SEARCH_WINDOW`. On the 2026-10-04
12:20 build `keywords:dsh-plugin` answered 6,762 and
`keywords:deepseek-harness` 8,498, and npm serves only ranks 0-5,249
of any query. The harvest
partitions each keyword into refinement, oversized, deeper and publisher
cells; none of them is covering, because each is a query and the `from`
cap is the wall.

The residual -- names npm counts that no cell served -- read 28 and 25
that day. `MAX_UNREACHABLE_RESIDUAL` has been raised three times, each
after a red build: 10 to 14 (2026-09-16), 14 to 20 (2026-09-18), 20 to
60 (2026-10-03). The last raise is documented as a stopgap that comes
down "when new packages are harvested by publication time". This design
is that harvest.

The next cliff is dated. `keywords:dsh-plugin,dsh,deepseek-harness` read
4,422 on 2026-09-25 and 4,906 on 2026-10-03, about 60 a day, so it
crosses the window around 2026-10-08. When a shared cell crossed on
2026-09-24, and another on 2026-09-30, the names only that cell
reached became residue on the same day: the first crossing reddened
one build, the second four days of them.

## 1. Rank and time

Search reaches a package by rank, and npm ranks a new package at the
bottom: in the 2026-09-08 sample, 222 of the 250 names at ranks
5,000-5,249 were created within seven days. So the residue is mostly
the newest packages. The replication feed lists packages by the time
they changed, which has nothing to do with rank. It reaches exactly
what search structurally cannot.

The feed was priced once before, in its complete form: one document
read per change, at 165,689 changes a day, two orders of magnitude
above an npm-side run (design doc, 2026-09-08 follow-up). This design
prices the filtered form, which the earlier price did not consider.

## 2. Measurements (2026-10-04)

Scripts and raw data: `.claude/worktrees/.scratch-dsh-cell/`
(git-ignored). Each item says how it was measured.

**The feed.**

- `_changes?since=<seq>&limit=10000` pages forward. `last_seq` is the
  next cursor, and a page shorter than the limit is the head.
- `descending=true` ignores `since`: 40 descending pages re-read the
  newest ~10,000 rows (about five hours). A daily read therefore needs
  a stored cursor.
- `limit=20000` answers HTTP 400.
- A row is `{seq, id, changes: [{rev}]}`, one row per package at its
  latest change within the range. Rows carry no timestamps.
- `rev` is a poor signal of newness: 14 of 168 dsh-like ids in the
  newest window were still at revision 1, because these packages are
  republished constantly.

**Volume.**

- One day (165,000 seqs, about 23 hours): 4 pages, 34,448 packages,
  3.6 MB, about 5 s of request time.
- From 2026-07-01 to the head: 62 pages, 619,484 rows, 76 s; the
  largest page was 1,078,874 bytes. The position of 2026-07-01 is seq
  117,350,216, dated by binary search on the median `modified` of the
  rows that follow a position: a row read forward is a package whose
  last change sits at that position.

**The name filter `/dsh|deepseek|cordis/i`.**

- Recall over the per-keyword unions of the 2026-10-03 replay:
  dsh-plugin 6,384 of 6,645 (96.1%), deepseek-harness 7,998 of 8,371
  (95.5%).
- Recall over the lowest-rank window pages, the youngest names: 496 of
  503 and 480 of 503.
- Recall over the 22 residue names the 2026-10-03 owner sweep
  identified: 19.
- It selects about 700 ids a day (676 measured) and 17,779 from
  2026-07-01. Most false positives are "spreadsheet" (sprea-dsh-eet):
  291 of the 311 matches the build did not hold in one day carried no
  harvest keyword. Each costs one small read.

**The manifest.**

- `GET /<name>/latest` (scoped names with `%2F`) averages 2.5 KB. 600
  reads at 16 concurrent took 23.2 s (25.8 a second), with no error
  and no 429.
- It carries `name`, `keywords`, `deprecated` and `maintainers[].name`.
- `_npmUser.name` can be a bot's display name -- "GitHub Actions" for
  `@khorsheed/dsh-room-tool` -- so it is not an owner. The same trap
  as `publisher.username` in search objects.

**What search counts.**

- Search excludes deprecated packages from its results AND from
  `total`. Eight `keywords:K maintainer:U` cells of owners holding
  deprecated carriers answered a `total` equal to the objects served,
  and none served a deprecated package.
- Of the carriers the 2026-10-04 build did not hold, 105 of 128
  (dsh-plugin) and 123 of 147 (deepseek-harness) were deprecated.
  Crediting them would have cancelled real missing names.
- No case-only matches: in 7,002 packuments, nothing carried a harvest
  keyword only case-insensitively.
- Bare-name text search does not find young packages that `keywords:`
  already serves: 5 of 10 harvested controls were missed. It cannot be
  used as an index check.

**Recovery against the 2026-10-04 12:20 build** (residuals 28 / 25).

- The feed, read back to 2026-08-14, finds 16 / 16 live carriers that
  existed when the search ran and that the build did not hold.
- Another 10 / 10 are listed today through the GitHub channel only: a
  GitHub entry is listed when no harvested npm package shadows it.
  That hid them from a first count. The feed reaches them too.
- 26 / 26 in all, and each is served by its owner's
  `keywords:K maintainer:U` cell, so each is counted in `total`.
  deepseek-harness's 26 against 25 is inside the run's count noise:
  `required` is the minimum of the totals read during the run.

**The complete route, priced.** One day of feed, every changed package
the filter does NOT match and the build did not hold: 33,590 `/latest`
reads, 27 minutes at 12 concurrent, which found 3 live carriers (3 for
dsh-plugin, 1 for deepseek-harness).

## 3. Decision

- **A, chosen:** a name-filtered feed and a persisted list of carriers,
  credited to coverage after sampled verification (section 4.5). About
  a minute a run.
- **B, rejected:** credit only names a `keywords:K maintainer:U` cell
  serves, verifying every feed-only name. One search per residue owner
  per run, growing with every crossing, drawn from a probe pool that
  is already full (#38). A keeps B's guarantee while the residue's
  owners fit a fixed budget.
- **C, rejected and kept as an upgrade:** read `/latest` for every
  changed package, about 34,000 a day. That adds 22-27 minutes a run
  for at most 3 / 1 names a day. Each of the three carries a
  `PARTITION_KEYWORDS` tag, but two carry only `dsh`, and
  `keywords:dsh-plugin,dsh` has itself crossed the window, so whether
  the existing cells reach them is not established. The residual will
  show it (section 6).

## 4. Design

### 4.1 Components

- **`feed-state.ts`** (new, pure): `FeedState`, the membership rule,
  the name filter, merging a run's reads, choosing owners to verify,
  parsing and serializing.
- **`npm-feed.ts`** (new, impure; it reaches the network): reads the
  feed head, the feed pages and `/latest` manifests. Requests go
  through `withTimeout` and `fetchWithRetry` from `npm-client.ts`;
  bodies through `readCappedBody`.
- **`npm-client.ts`:** `searchByKeywords` takes a `feed` argument and
  runs the feed step at the end of `enumerate()` (section 4.5).
- **`classify.ts` and `build.ts`:** read `registry/feed-state.json`,
  run the feed before the search, and carry the next state on the
  handoff. `build.ts` writes the file after the pipeline, beside
  `publisher-state.json`.
- **`daily.yml`:** stages `registry/feed-state.json` in the snapshot
  commit.

### 4.2 The state file

```json
{
  "seq": 134466916,
  "carriers": {
    "dsh-recheck": {"owner": "f1refly", "keywords": ["dsh-plugin"]}
  },
  "pending": []
}
```

- `seq`: the feed position up to which every row has been applied.
- `carriers`: every package the feed has seen whose latest version
  passes the membership rule (section 4.3), with the harvest keywords
  it carries (sorted) and one owner, or `null` when no maintainer name
  passes the username grammar.
- `pending`: names whose read failed or was not reached within the
  time budget. They are read first on the next run.
- One carrier per line, keys sorted by code unit, one trailing
  newline. A day's churn is then a few hundred lines rather than a
  reformatted file. About 8,000 carriers are expected, near 0.6 MB;
  `repo-state.json` is 16.5 MB.
- Parsing throws on anything malformed: a `seq` that is not a
  non-negative integer; a carrier name outside the package-name rule
  below; an owner that is neither `null` nor accepted by
  `isMaintainerName`; a keyword that is not a harvest keyword; an
  empty or unsorted keyword list; a duplicate in `pending`. Unknown
  top-level keys are ignored, as `publisher-state.json` ignores them,
  and dropped on the next write.
- **The package-name rule:** the modern npm grammar -- lowercase,
  URL-safe characters, an optional `@scope/`, at most 214 characters.
  The merge applies the same rule when it admits a carrier, so the
  parser can never meet a name the writer produced. A legacy name
  outside it (npm still serves some with capitals) is not admitted
  and is counted in the report; search still reaches it as it does
  today.
- A missing file is the bootstrap state
  `{seq: FEED_BOOTSTRAP_SEQ, carriers: {}, pending: []}`, so a fresh
  clone or a deleted file heals in one run. This change commits no
  state file; the first `main` run writes it.

### 4.3 The membership rule

A package carries harvest keyword `K` when its `/latest` manifest:

1. names the package that was requested;
2. lists `K` in `keywords` by exact code-unit equality, as `isAtRisk`
   compares;
3. is not deprecated by `isDeprecated`: a non-empty message or a bare
   `true`, the semantics `fetchCandidate` already uses.

Its owner is the code-unit-smallest `maintainers[].name` that
`isMaintainerName` accepts.

This rule is the search index's membership as far as it has been
measured: exact keyword, latest version, deprecated packages excluded.
Where it is wrong, section 4.5 is the guard.

### 4.4 One run

1. **Head.** `GET /registry/` gives `update_seq`. A stored `seq` past
   it means the replica was rebuilt or renumbered, and the feed is
   unavailable for the run.
2. **Rows.** Page `_changes?since=seq&limit=10000` until a short page
   or `FEED_PAGE_BUDGET` pages. Keep each id's last row. Skip ids that
   begin with `_`.
3. **Selection.** Read an id when it matches `FEED_NAME_PATTERN`, or
   is a carrier or pending -- so an entry on the list is re-read
   whenever it changes, even if the pattern is ever narrowed. Every
   pending name is read whether or not it changed. A row marked
   `deleted: true` is gone without a read; an unmarked unpublish
   answers 404 and is gone the same way.
4. **Reads.** `FEED_READ_CONCURRENCY` reads at a time, until done or
   `FEED_READ_TIME_BUDGET_MS`. Names not reached become pending.
5. **Merge** (pure). A carrier is set, replacing its keywords and
   owner. A non-carrier, a 404 or a deletion removes the name. A
   failed read keeps the name's previous status and makes it pending.
   A successful read clears pending. `seq` becomes the `last_seq` of
   the last page processed. Pending names hold what the cursor has
   passed, so advancing it is safe.
6. **Handoff.** The next state's carriers, grouped by keyword with
   their owners, go to `searchByKeywords`. The next state itself rides
   `dist/harvest.json` to `build.ts`.

### 4.5 The feed step inside `enumerate()`

For each harvest keyword K, after the window, refinement, oversized
and publisher cells. It is memoized like `publisherCells`, so the
retry pass repeats none of its requests.

1. **Feed-only names** are carriers of K that are not in `forKeyword`.
2. **Verification.** Group the feed-only names by owner. Choose up to
   `FEED_VERIFY_OWNERS` owners in code-unit order, rotated by the next
   state's `seq`, so successive runs check different owners when there
   are more than the budget. Page `keywords:K maintainer:U` for each.
   - A feed-only name of U that the cell serves is **verified**.
   - One the cell does not serve is paged once more, and **disagrees**
     only when that second complete paging omits it too: npm has
     answered an empty result for a real cell before, and the publisher
     axis confirms a zero before it evicts for the same reason.
   - A name with a `null` owner, an owner beyond the budget, or an
     owner whose cell could not be paged in full is **unverified**. A
     paging hiccup never counts as a disagreement.
   - Any other name a verification cell serves joins `forKeyword` as
     an ordinary search-served name.
3. **Credit.** Verified and unverified names join `forKeyword`
   (coverage) and `seen` (candidates). Disagreeing names join neither,
   and the report names them.
4. **Throw** when more than `FEED_MAX_DISAGREEMENTS` names of one
   keyword disagree in one run. The membership rule then no longer
   describes the search index, and crediting through it would cancel
   genuinely missing names one for one.

The step runs before `required` is measured. A residual the feed
closes therefore no longer sends the keyword through the second
`enumerate()` pass, a full re-page of its cells that
`deepseek-harness` has paid on every run.

The step runs after the publisher cells, so the publisher axis
selects, probes, earns and evicts exactly as before; the feed only
fills what the axis left. Running it first, so that the probe pool is
spent only on residue the filter cannot see, is the #38 follow-up. It
changes eviction dynamics, so it is not part of this change.

Verification pages are search pages, so the maintainers they carry join
the publisher vocabulary as every page's do; at-risk seeding does not
see them, because they are paged without `harvested`.

With today's residue (12 owners per keyword) every feed-only name is
verified, so every credited name is one that npm search served:
approach B's guarantee at A's cost. Sampling takes over only when a
crossing grows the residue's owners past the budget.

### 4.6 Failure semantics

- **The head, or the first page, cannot be read** (transport failure
  after retries, over `FEED_PAGE_MAX_BYTES`, not JSON, wrong shape),
  **or `seq` is past `update_seq`:** the feed is unavailable. The state
  is unchanged; no feed name is listed or credited; the report says
  why. The run is then today's search-only harvest, and the residual
  check decides whether it publishes.
- **A later page fails the same way:** paging stops. Rows are applied
  in order, so the pages already read form a consistent prefix; the
  run proceeds with it, the cursor at its last row, and the report
  says where it stopped.
- **`/latest` answers 404, or the row is marked deleted:** gone,
  removed.
- **`/latest` is the package's manifest, read and parsed, and is not a
  carrier** (no harvest keyword, or deprecated): removed. This is the
  `no-manifest` side of the `no-manifest` / `fetch-failed` line.
- **Anything else** -- a transport failure, a deadline, any non-2xx but
  a 404 (a 403 from a blocking edge included), a body past
  `FEED_MANIFEST_MAX_BYTES` or not JSON, a body that is not a manifest,
  or the manifest of another package: failed. The previous status is
  kept, the name is pending, and the run line counts it. Amended
  2026-10-05 after review: an over-cap or non-JSON body, and any 4xx
  but a 404, were first specified as removals, which lets a blocked or
  misbehaving edge delete carriers durably and report nothing.
- **A name is not reached within the time budget:** pending.
- **A package is deprecated between the read and the packument fetch:**
  the gate's existing `deprecated` rejection handles it.
- **More than `FEED_MAX_DISAGREEMENTS` disagreements for a keyword:**
  throw (section 4.5).

### 4.7 Report

- A run line in the build report and the CI log:
  `change feed: seq A -> B (P pages); read R of S selected
  (F failed, U pending); carriers: dsh-plugin X, deepseek-harness Y`
  -- or `change feed unavailable: <reason>`.
- Per keyword, beside the publisher-axis line: `feed supplied N
  (owners verified V of T; D disagreed: <names>)`. N is the feed
  step's own delta on `forKeyword`: credited feed-only names plus any
  other name a verification cell served.
- `enumerated` in the shortfall line includes credited feed names; the
  per-keyword line says how many.
- Names in the report are escaped like every other npm-sourced string.

### 4.8 CI, handoff and guards

- `classify.ts` reads `registry/feed-state.json` read-only, with an
  `EXCUSED_REGISTRY_DIR_USES` entry as for `publisher-state.json`;
  runs the feed; passes it to `searchByKeywords`; and adds the next
  state, the run report and the per-keyword figures to
  `dist/harvest.json`.
- `build.ts --harvest-from` parses that state strictly with the same
  parser and writes `registry/feed-state.json` after `runPipeline`,
  beside `publisher-state.json`. Without `--harvest-from` it runs the
  feed itself.
- The snapshot step in `daily.yml` adds `registry/feed-state.json` to
  its `git add`. Pull-request runs never reach that step: a PR stays a
  zero-write dry run.
- The tests that pin those seams change with them: the `harvest.json`
  text in `repo-guards.test.ts`, the registry-writes list in
  `workflow.test.ts`, and `preload-fetch.ts` rules for both feed hosts
  in the handoff fixtures.
- `npm-feed.ts` joins `SCANNED_SOURCES` in the body-read guard. The
  deadline guard finds it without being told.

### 4.9 Constants

- `FEED_URL = 'https://replicate.npmjs.com/registry'`.
- `FEED_PAGE_LIMIT = 10_000` -- the API's maximum; 20,000 answers 400.
- `FEED_PAGE_BUDGET = 200` pages a run -- the bootstrap needs 62, a
  day needs 4.
- `FEED_PAGE_MAX_BYTES = 8 MiB` -- the largest page measured was
  1,078,874 bytes.
- `FEED_MANIFEST_MAX_BYTES = 1 MiB` -- manifests average 2.5 KB, and
  `github-client.ts` caps a `package.json` at 1 MiB.
- `FEED_READ_CONCURRENCY = 16` -- 25.8 reads a second and no 429 were
  measured at 16.
- `FEED_READ_TIME_BUDGET_MS = 20 min` -- the bootstrap's 17,779 reads
  take about 11.5 minutes at the measured rate; a day's ~700 about 30
  seconds.
- `FEED_NAME_PATTERN = /dsh|deepseek|cordis/i` -- recall in section 2.
- `FEED_BOOTSTRAP_SEQ = 117_350_000` -- just before 2026-07-01T00:00Z,
  ahead of the first dsh package.
- `FEED_VERIFY_OWNERS = 16` per keyword -- today's residue has 12
  owners per keyword.
- `FEED_MAX_DISAGREEMENTS = 3` per keyword per run -- room for index
  lag on a name published minutes before the read. A systematic drift
  exceeds it at once: crediting deprecated packages would have
  produced 28 disagreements out of 47.
- Requests use `REQUEST_TIMEOUT_MS` per attempt and `fetchWithRetry`'s
  ladder, which honours `Retry-After`.

## 5. Invariants amended

- CLAUDE.md, "Harvest by keyword, never by name pattern", becomes:
  **Admit by keyword, never by name pattern.** A name pattern is
  trivially spoofed, so it never decides membership. The change feed
  uses one only to choose which manifests to read: every name it
  supplies is admitted by the exact keyword in its manifest, so the
  pattern can cause a miss but never a listing.
- CLAUDE.md's failing-loudly paragraph gains the feed. The cap stays
  at 60 in this change; lowering it is a separate change once two
  `main` runs have published with the feed, at a value LivXue sets.
- CLAUDE.md's lists of network modules and pure modules gain
  `npm-feed.ts` and `feed-state.ts`, and its layout gains
  `registry/feed-state.json`.
- Notes pointing here go into the 2026-08-18 design doc's 2026-09-08
  follow-up, which priced only the complete form; section 8 of
  `2026-09-17-publisher-pinning.md`; the "does not pursue the
  replication feed" bullet of the 2026-09-08 publisher-partition plan;
  and item 5 of `docs/plans/2026-08-18-remaining-work.md`.

## 6. Deliberately not built

- **Covering names without the filter words** (approach C). Priced in
  section 2 at 22-27 minutes a run for at most 3 / 1 names a day; the
  search cells stay responsible for them. Revisit if the residual
  grows while the feed reports healthy.
- **Running the feed step before the publisher cells** (#38).
- **Lowering the cap.** A separate change, after two `main` runs.
- **The GitHub half.** The feed is npm's.
- **A follower outside the daily build.** The daily delta costs
  seconds; reading more often buys freshness the catalog does not
  publish.

## 7. Testing

- **Pure** (`feed-state.test.ts`): the membership rule (exact case,
  both deprecated forms, name mismatch, owner choice, `null` owner);
  the merge for every outcome and for the cursor; the package-name
  rule on admission; serialization stable under input order, with one
  trailing newline; a parse round-trip; a parse that throws for each
  malformed field; owner rotation by `seq`.
- **Impure, with a fake fetch** (`npm-feed.test.ts`): forward paging to
  a short page; the page budget; the head check; a failing later page
  keeps the prefix; a failing first page is "unavailable"; both body
  caps; every `/latest` outcome; the time budget to pending; deleted
  rows; scoped-name encoding.
- **`searchByKeywords`** (`npm-client.test.ts`):
  - the 2026-10-04 shape -- a residual over the cap that throws
    without the feed and publishes with it;
  - verified, unverified and disagreeing names are credited or not as
    section 4.5 says;
  - more than `FEED_MAX_DISAGREEMENTS` throws;
  - a disagreement counts only after a second complete paging;
  - an unavailable feed reproduces today's result exactly;
  - the retry pass repeats no verification request;
  - the per-keyword count is the feed step's own delta on
    `forKeyword`, so a name an earlier cell served is never counted.
- **Handoff and workflow:** `dist/harvest.json` carries the state;
  `build.ts` writes the file after the pipeline; the snapshot step
  stages it; the guards in section 4.8.
- Fixture arithmetic is recomputed by hand, as CLAUDE.md requires.

## 8. Acceptance

- `pnpm test` and `pnpm typecheck` are green.
- The PR's dry run bootstraps from `FEED_BOOTSTRAP_SEQ` (about 13
  extra minutes, once), prints the feed line, verifies without
  throwing, and reads both residuals at noise, 5 or under. Its build
  job stays inside `timeout-minutes`.
- After the merge, the first `main` run commits a non-empty
  `registry/feed-state.json`, and the next run reads about 4 pages.

## 9. Risks

- **Rule drift.** If npm search starts excluding another class of
  package, credited names cancel missing ones. Section 4.5 throws on
  it.
- **Replica reset.** The head check (section 4.4).
- **Throughput limits.** None measured on either host; requests retry
  on 429 and honour `Retry-After`.
- **Channel moves.** Residue the GitHub channel lists today (10 per
  keyword on 2026-10-04) becomes npm-listed, and its GitHub entry
  becomes `shadowed-by-npm`. The dry run's report diff should show
  exactly that and nothing else.
- **State churn.** A few hundred lines a day in a committed file.
