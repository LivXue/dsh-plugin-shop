# Change-feed harvest -- design

Status: **specified (2026-10-04).** Approach A, chosen by LivXue on
2026-10-04. Reads npm's replication change feed to find dsh plugins by
publication time, so the residue that npm search ranks beyond every
5,250-name window is harvested instead of tolerated, and the 60-name
stopgap in `MAX_UNREACHABLE_RESIDUAL` can come down. Built in PR #74
(2026-10-06); the cap came down to 14 in the follow-up (section 5).

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

**The manifest and the packument.**

- `GET /<name>/latest` (scoped names with `%2F`) averages 2.5 KB. 600
  reads at 16 concurrent took 23.2 s (25.8 a second), with no error
  and no 429 -- from a workstation.
- It carries `name`, `keywords`, `deprecated` and `maintainers[].name`,
  but those maintainers are the publish's, not today's: 9 of 50
  long-lived packages differ from the packument's top-level
  `maintainers` (`optimist`: `substack` against `bcoe` and `chevex`);
  0 of 352 dsh carriers changed in one day did (2026-10-05, PR #74
  review).
- From a GitHub runner `/latest` crawls where the packument does not:
  the PR #74 dry run started 1,124 `/latest` reads in 20 minutes (16
  concurrent, 41 failed), while the same job fetched 9,403 full
  packuments in 136 s (8 concurrent, about 69 a second). A young dsh
  plugin's packument is about 16 KB. A run therefore reads the full
  packument (section 4.3).
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
  feed head, the feed pages and full packuments, and re-reads the
  packument of a name verification omitted (`confirmCarriers`).
  Requests go through `withTimeout` and `fetchWithRetry` from
  `npm-client.ts`; bodies through `readCappedBody`.
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
  time budget. They are read again on the next run, with its changed
  ids, and the selection bound in section 4.4 keeps the list within
  what one run can read.
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
  clone or a deleted file heals in one run. This change commits the
  bootstrap state itself, so the snapshot step's `git add` always finds
  the file -- one missing pathspec makes `git add` stage nothing, and
  the step runs under `bash -e` (PR #74 review) -- and the first run's
  starting cursor is visible in the repository.

### 4.3 The membership rule

A package carries harvest keyword `K` when its full packument, read at
`/<name>`:

1. names the package that was requested;
2. has a `latest` dist-tag naming one of its own versions, and that
   version lists `K` in `keywords` by exact code-unit equality, as
   `isAtRisk` compares;
3. and that version is not deprecated by `isDeprecated`: a non-empty
   message or a bare `true`, the semantics `fetchCandidate` already
   uses.

Its owner is the code-unit-smallest of the packument's top-level
`maintainers[].name` -- today's owners -- that `isMaintainerName`
accepts. Amended 2026-10-05: the rule first read `/latest`, whose
maintainers are the publish's and which a GitHub runner fetched about
75 times slower (section 2).

This rule is the search index's membership as far as it has been
measured: exact keyword, latest version, deprecated packages excluded.
Where it is wrong, section 4.5 is the guard.

### 4.4 One run

1. **Head.** `GET /registry/` gives `update_seq`. A stored `seq` past
   it means the replica was rebuilt or renumbered, and the feed is
   unavailable for the run.
2. **Rows.** Page `_changes?since=seq&limit=10000` until a short page
   or `FEED_PAGE_BUDGET` pages. Keep each id's last row. Skip ids that
   begin with `_`. Stop, too, before a page after the first whose ids
   would take this run's selection -- pending names included -- past
   `FEED_MAX_SELECTED`; that page waits for the next run, cursor and
   all, so a flood of matching ids cannot grow the state past what one
   run can read. The first page is always taken: a backlog of reads
   that keep failing can slow the cursor, never stop it, and grows by
   at most one page's ids a run meanwhile. (A second security review
   on 2026-10-05 found that holding the first page back too stopped the
   feed for good once a backlog filled the bound.)
3. **Selection.** Read an id when it matches `FEED_NAME_PATTERN`, or
   is a carrier or pending -- so an entry on the list is re-read
   whenever it changes, even if the pattern is ever narrowed. Every
   pending name is read whether or not it changed. A row marked
   `deleted: true` is gone without a read. An unpublish the feed does
   not mark answers 200 with npm's stub -- no `dist-tags`, no
   `versions`, the unpublish recorded in `time` -- and is gone the
   same way. Amended 2026-10-06: this said such an unpublish answers
   404. It does not, and read as a failure the stub stayed pending for
   good -- both of the first `main` run's pending names were stubs --
   while a carrier unpublished after it was read would have been
   credited unverified on every run. The names are read in
   code-unit order rotated by the head's `update_seq`, so a run that
   cannot read them all never leaves the same names last. Amended
   2026-10-05 after a security review: pending names were read first
   in a fixed order and the list had no bound, so failing reads or a
   flood could starve the same names forever and grow the file
   without limit.
4. **Reads.** `FEED_READ_CONCURRENCY` packument reads at a time, until
   done or `FEED_READ_TIME_BUDGET_MS`. Names not reached become pending.
5. **Merge** (pure). A carrier is set, replacing its keywords and
   owner. A non-carrier, a 404, npm's unpublished stub or a deletion
   removes the name. A
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
   - One the cell does not serve is paged once more, because npm has
     answered an empty result for a real cell before, and the publisher
     axis confirms a zero before it evicts for the same reason. A name
     that second complete paging omits too is confirmed against its
     CURRENT packument, because the stored owner may predate an owner
     change and the package may have changed since it was read (PR #74
     review): if its latest version no longer lists K, is deprecated,
     or the package is gone, it is **withdrawn**; if the packument names
     a different owner, the name is re-verified against that owner's
     cell by the same two-paging rule; if the packument cannot be read,
     it is **unverified**. Only a name a current owner's cell omits
     twice while the packument still lists K **disagrees**.
   - At most `FEED_MAX_CONFIRMATIONS` twice-omitted names of K are
     confirmed in a run, in code-unit order rotated by the next state's
     `seq`. A name past the bound is **unconfirmed**: not credited,
     because the one completed check -- two complete pagings of its
     owner's cell -- is against it, and not disagreeing, because nothing
     confirmed it; a later run's rotation reaches it. A confirmation is
     one packument read and, for a changed owner, two pagings of that
     owner's cell, so the bound keeps the step's cost from growing with
     one owner's holdings. Amended 2026-10-06: the PR #74 Windows review
     found this the one per-run cost the step left unbounded, and a
     review of the follow-up found that crediting the overflow, as names
     past the owner budget are, credits names the run has evidence
     against.
   - A name with a `null` owner, an owner beyond the budget, or an
     owner whose cell could not be paged in full is **unverified**. A
     paging hiccup never counts as a disagreement.
   - Any other name a verification cell serves joins `forKeyword` as
     an ordinary search-served name.
3. **Credit.** Verified and unverified names join `forKeyword`
   (coverage) and `seen` (candidates). Withdrawn, unconfirmed and
   disagreeing names join neither; the report counts the first two and
   names the third.
   What a confirmation learned -- today's owner, or that a name stopped
   being a carrier -- is applied to the next state
   (`applyConfirmations`); a confirmation that could not be read
   changes nothing.
4. **Throw** when more than `FEED_MAX_DISAGREEMENTS` names of one
   keyword disagree in one run. The membership rule then no longer
   describes the search index, and crediting through it would cancel
   genuinely missing names one for one. The step's report line waits
   for the keyword's final count (section 4.7) and this throw waits
   for the line, as the shortfall throws do, so a run either of them
   stops still logs it. A search request that fails after the step --
   the probe for the total, or the retry pass -- throws first, as it
   would with no feed.

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
crossing grows the residue's owners past the budget. Amended
2026-10-06: it had already. The first `main` run held feed-only names
under 29 and 30 owners against a budget of 16, so 13 and 14 owners'
names were credited unverified -- on the run the residual cap came
down to 14 on. The budget is now 64, which checks every owner of that
residue with room for it to double; past it, sampling resumes and the
line's `owners verified V of T` shows it.

### 4.6 Failure semantics

- **The head, or the first page, cannot be read** (a thrown request or
  a body that is not JSON, after `FEED_FETCH_ATTEMPTS` attempts; a
  status after `fetchWithRetry`'s ladder; a body over
  `FEED_PAGE_MAX_BYTES`; or a wrong shape), **or `seq` is past
  `update_seq`:** the feed is unavailable. The state
  is unchanged; no feed name is listed or credited; the report says
  why. The run is then today's search-only harvest, and the residual
  check decides whether it publishes.
- **A later page fails the same way:** paging stops. Rows are applied
  in order, so the pages already read form a consistent prefix; the
  run proceeds with it, the cursor at its last row, and the report
  says where it stopped.
- **The packument answers 404 or npm's unpublished stub, or the row is
  marked deleted:** gone, removed. The stub is matched exactly -- no
  `dist-tags`, no `versions`, and an object at `time.unpublished` --
  so any other versionless body is still a failed read.
- **The packument is read and is not a carrier** (no harvest keyword,
  deprecated, or past `FEED_PACKUMENT_MAX_BYTES`):
  removed. This is the `no-manifest` side of the `no-manifest` /
  `fetch-failed` line; the size is the author's own content, which
  CLAUDE.md lists as `no-manifest`, and as a failure it would let any
  author keep a name pending, and the cursor waiting on it, forever.
- **Anything else** -- a transport failure, a deadline, any non-2xx but
  a 404 (a 403 from a blocking edge included), a body that is not JSON
  or not a packument, or the packument of another package: failed. The
  previous status is kept, the name is pending, and the run line
  counts it. Amended 2026-10-05 after review: a non-JSON body and any
  4xx but a 404 were first specified as removals, which lets a blocked
  or misbehaving edge delete carriers durably and report nothing.
- **A name is not reached within the time budget:** pending.
- **A confirmation read fails:** the name is unverified, and the state
  keeps what it held.
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
  (owners verified V of T; U unverified; W withdrawn; C unconfirmed;
  D disagreed: <names>); enumerated E of R (G over | G short)`, each
  count in the parentheses after the first printed only when non-zero,
  and the gap only when E is not R. N is the feed step's own delta on
  `forKeyword`: credited feed-only names plus any other name a
  verification cell served. V counts the owners whose every feed-only
  name reached a verdict, T every owner holding one; an owner whose
  cell failed or served short was asked, not verified, and so was one
  with a name left unconfirmed, or whose confirmation could not be read
  -- two pagings omitting a name are the question, not the verdict. U
  and C tell those causes apart (amended 2026-10-06, PR #76 review). E
  is the keyword's final count, after any retry pass, and R the total
  it is measured against.
- E includes credited feed names, so a keyword the feed closes reads
  whole whether its credits were verified or not. The count is printed
  on every run, whole or short, so a keyword made whole by crediting
  shows it beside its U unverified names. Amended 2026-10-06 after the
  PR #74 review: only a short keyword printed a count, and silence was
  the only sign of a whole one.
- R is the smallest total npm answered during the run, which absorbs a
  package unpublished mid-run and therefore understates when packages
  are published mid-run instead. So a healthy run can read a few
  `over`: names a cell served after the total was read, and credits npm
  does not count. `over` is noise to read beside U; `short` is the
  deficit, and only it is bounded by the cap.
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
- `FEED_MAX_SELECTED = 25_000` ids a run, pending included, the first
  page always taken -- the bootstrap selects ~17,900, and a run reads
  about 80,000 packuments within its time budget at the runner rate.
- `FEED_PAGE_MAX_BYTES = 8 MiB` -- the largest page measured was
  1,078,874 bytes.
- `FEED_PACKUMENT_MAX_BYTES` -- the candidate fetch's
  `MAX_PACKUMENT_BYTES` (16 MiB), for the same document.
- `FEED_READ_CONCURRENCY = 8` -- the candidate fetch's
  `HARVEST_CONCURRENCY`, which read about 69 packuments a second from
  a GitHub runner on 2026-10-05.
- `FEED_READ_TIME_BUDGET_MS = 20 min` -- the bootstrap's ~17,900 reads
  take about 4.5 minutes at the runner rate; a day's ~700 about 10
  seconds.
- `FEED_NAME_PATTERN = /dsh|deepseek|cordis/i` -- recall in section 2.
- `FEED_BOOTSTRAP_SEQ = 117_350_000` -- just before 2026-07-01T00:00Z,
  ahead of the first dsh package.
- `FEED_VERIFY_OWNERS = 64` per keyword -- the first `main` run's
  residue had 29 and 30 owners (2026-10-06). It was 16, against 12
  owners measured on 2026-10-04. One search request an owner, two when
  a name is omitted.
- `FEED_MAX_DISAGREEMENTS = 3` per keyword per run -- room for index
  lag on a name published minutes before the read. A systematic drift
  exceeds it at once: crediting deprecated packages would have
  produced 28 disagreements out of 47.
- `FEED_MAX_CONFIRMATIONS = 32` per keyword per run -- the first
  `main` run withdrew nothing and disagreed with nothing on either
  keyword; 32 leaves room for one owner's names going missing at once.
- Requests use `REQUEST_TIMEOUT_MS` per attempt and `fetchWithRetry`'s
  ladder, which honours `Retry-After`.
- `FEED_FETCH_ATTEMPTS = 3` -- a head or page request that throws, or
  answers a body that is not JSON, is asked again, 2 and then 4
  seconds apart; `fetchWithRetry` retries statuses only, so one reset
  would otherwise make the feed unavailable for the day (2026-10-05
  review).

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
  Amended 2026-10-06: the follow-up lowers it to 14, the ceiling of the
  bracket the 2026-08-18 design doc records, after this change's last
  dry run and its first `main` run (37412398137) both read the two
  keywords whole. At 14 a fifteen-name partition gap is refused again;
  the price is that a day the feed is unavailable (section 4.6) is a
  search-only harvest, which read 29 and 22 the day before the feed,
  and fails the build rather than publishing short.
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
  Built in the 2026-10-06 follow-up, at 14 (section 5).
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
  caps; every packument outcome; `confirmCarriers`; the time budget to
  pending; deleted rows; scoped-name encoding.
- **`searchByKeywords`** (`npm-client.test.ts`):
  - the 2026-10-04 shape -- a residual over the cap that throws
    without the feed and publishes with it;
  - verified, unverified and disagreeing names are credited or not as
    section 4.5 says;
  - more than `FEED_MAX_DISAGREEMENTS` throws;
  - a disagreement counts only after a second complete paging, and a
    twice-omitted name is withdrawn, re-verified or left unverified as
    its current packument says;
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
- The PR's dry run bootstraps from `FEED_BOOTSTRAP_SEQ` (about 5
  extra minutes, once), prints the feed line, verifies without
  throwing, and reads both residuals at noise, 5 or under. Its build
  job stays inside `timeout-minutes`. The first dry run (2026-10-05,
  run 37324032525) failed this: `/latest` reads crawled on the runner
  (1,124 of 17,887 in 20 minutes), so the feed supplied 4 / 2 names
  and the residuals read 25 / 28; reads moved to the packument.
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
