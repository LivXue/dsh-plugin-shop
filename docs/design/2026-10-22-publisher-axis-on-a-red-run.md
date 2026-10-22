# A red run keeps its publisher axis — design

Status: **specified and built (2026-10-22).** Answers the authority spec's 2026-09-14
note, which asked for "an advance that survives a failed coverage check".
Amends the authority spec (`2026-08-18-dsh-plugin-shop-design.md`): the
cursor paragraph of the publisher axis, and that note. Also amends
`2026-09-17-publisher-pinning.md`, which records a red run re-running its
losing draw, and §3.2 of
`2026-10-20-cross-keyword-credit-and-feed-aware-pins.md`.

## 0. What breaks

`registry/publisher-state.json` carries three things from one run to the
next:
- the vocabulary of maintainers;
- each harvest keyword's pinned set;
- each keyword's rotation cursor.

Only a passing run writes it. `build.ts` writes it after the artifact block,
and CI commits it with the daily snapshot. A run that fails a coverage check
stops in Classify, before `build.ts` runs, and commits nothing.

So a run that fails *because of* its slice runs that slice again, and again:
- **2026-09-11 to 09-14.** The cursor stood at 3,000 for three days (the
  authority spec's 2026-09-14 note).
- **2026-09-30 to 10-03.** Every run started `dsh-plugin`'s rotation at the
  same cursor and probed the same slice (the publisher-pinning design's
  2026-10-03 record).
- **2026-10-19 to 10-21.** Every run probed the same 400 pinned and 400
  rotated `deepseek-harness` publishers from cursor 2799 (the cross-keyword
  design, §0).

## 1. What has to survive

**The cursor alone is not enough.**
- A rotated cell finds an owner whose names past the window nothing else
  reaches. The run earns that owner a pin, and the pin is what makes the next
  run probe the owner again.
- A red run loses its earned pins along with its cursor.
- Advance the cursor and lose the pins, and each red run is served its own
  slice's names and no earlier slice's. A residue spread over owners in
  several slices is then whole in no single run.
- Commit the pins as well, and red runs accumulate. Each one pins the residue
  owners its slice found. The next run probes them in its pinned half while
  its rotation moves on.

**Before 2026-10-21 this would have bought nothing.** Both pinned sets were
full at 400 and refused every new owner. PR #108's release exit took them to
47 and 49 on its first passing run.

## 2. Decision

When Classify fails a coverage check after every harvest keyword has
reported its publisher axis:
- The run commits `registry/publisher-state.json` and nothing else.
- The state is exactly what `build.ts` would write from the same axis records
  on a passing run.
- Nothing is published, and the build stays red.

**A coverage check** is one of the checks that close `searchByKeywords`'
judgement of a keyword:
- the window bound, for an unpartitioned and for a partitioned keyword;
- the recovery-rate floor (`MIN_UNREACHABLE_RECOVERY`);
- the residual cap (`MAX_UNREACHABLE_RESIDUAL`).

They now throw `CoverageCheckError`.

**Every other failure still commits nothing**:
- a request that fails;
- a page with no total;
- a partition cell that needs a page past the cap;
- the change feed's disagreement bound;
- a keyword that never reported its axis.

The disagreement bound is left out on purpose. Past it, the feed's carriers
no longer describe npm search, and seeding read those carriers, so the axis
it fed is suspect.

## 3. Design

### 3.1 Every keyword reports before a coverage check throws

- **Phase two finishes every keyword.** It runs each keyword's `finish`, then
  throws any `CoverageCheckError` it held. If more than one keyword failed,
  the message names each, in `HARVEST_KEYWORDS` order. Any other error is
  thrown at once, as before.
- **The later keyword is no longer hidden.** A run whose first keyword fails
  still credits, feeds, re-probes and reports the second. Before, a
  `dsh-plugin` throw hid `deepseek-harness` entirely; the publisher-pinning
  design's 2026-10-03 record had to raise the cap in a copy of the module to
  see it.
- **Cost.** On such a run, the later keyword's `finish` adds one re-probe, a
  re-page when the keyword is short, and its feed verification. Those are the
  requests a passing run makes.

### 3.2 Classify hands the axis over

`classify.ts` catches a `CoverageCheckError`:
- **When it holds one axis record per harvest keyword**, it writes
  `dist/publisher-axis.json`, carrying:
  - `publishers`: the maintainers its pages carried;
  - `publisherAxis`: the records.

  These are the same two fields, in the same shapes, that `dist/harvest.json`
  carries. Then it throws the error again, and the step fails as before.
- **On any other error** it writes nothing.

### 3.3 build.ts applies the axis, and nothing else

`build.ts --axis-from <file>`:
- reads `publishers` and `publisherAxis` with the parsers `--harvest-from`
  uses. Both fields are required here: a file without them has nothing to
  apply.
- applies them to the committed `publisher-state.json` through the function
  the full build uses;
- writes that one file, and prints the axis lines;
- does not search, fetch, run the pipeline or write any other file;
- refuses to run with `--harvest-from`.

`build.ts` stays the file's only writer. `classify.ts` gives the reason: a
second writer is one whose work the first overwrites.

### 3.4 The workflow commits it

The Classify step gains `id: classify`. Two new steps end the `build` job.
Both run only when that step failed, on `main`, for the triggers the other
two commit steps run for:

```
if: failure() && steps.classify.outcome == 'failure' && <the push steps' trigger and branch guard>
```

**Two steps, because the write credential may only be held by a git-only
step.** `repo-guards.test.ts` holds the job to this, and `daily.yml`'s
permissions comment says why. Only steps that touch no third-party data hold
`REGISTRY_PUSH_TOKEN`. `build.ts` loads third-party packages and parses
usernames that came from npm.

- **The first step holds no secret.** It exits quietly when
  `dist/publisher-axis.json` does not exist, and otherwise runs
  `node --experimental-strip-types registry/scripts/src/build.ts --axis-from dist/publisher-axis.json`.
- **The second step is git-only and holds the credential.** It runs only when
  the first succeeded, so a refused handoff commits nothing. It stages
  `registry/publisher-state.json` alone and exits quietly when that file has
  not changed. Otherwise it commits it as
  `chore(registry): publisher axis of a run that failed its coverage check [skip ci]`
  and pushes it through a byte-identical copy of `push_with_rebase`.

A pull request runs neither, so a dry run stays zero-write.

### 3.5 Runs that start from an older commit

The red run's commit moves `main`. A run that checks out an older commit
reads the state the red run started from, so it probes the same slice again
and its own commits meet the red run's:
- **A re-run.** GitHub re-runs a workflow on its original commit.
- **A run queued behind the red run** whose trigger commit landed before the
  axis commit did. `main`'s concurrency group queues a run rather than
  cancelling the one in progress.

Such a run that goes red can fail to push its axis commit, when it
conflicts with the one before it. One that goes green still publishes, but
its commit steps can stop on the autostash guard and record nothing that
run. Either can also land cleanly, when its cursors stepped the way the red
run's did; the harm is the slice probed twice, every time.

This exposure is not new. A run queued behind a green run's snapshot commit
meets it today, which is one reason a pull request is not merged while a
`main` catalog run is in progress. What is new is the re-run case.

**The remedy is a new run, not a re-run.** A new run (Run workflow) checks
out `main` as it is, axis commit included. The push guard's `::error::` used
to advise "re-run the workflow", which repeats the conflict. Every copy of
`push_with_rebase` now says to start a new run, and the red run's commit
step says so in a `::notice::` once its axis is on `main`, where the person
deciding whether to re-run will see it (final review).

## 4. Why committing a red run's axis is safe

- **It decides nothing about the catalog.** The state only chooses which
  cells the next run probes. Membership is the gate's, by keyword. A wrong
  pin costs one probe a run.
- **Every rule is the one a passing run applies.** The same `applyAxisReport`
  runs:
  - evictions are all or nothing under `MAX_EVICTIONS_PER_RUN`;
  - a report whose evictions were refused releases nothing;
  - a pin is released only when this run judged it or seeding was complete;
  - the pinned bound holds.

  A failing keyword never claims complete seeding, because `seedingComplete`
  needs a keyword read whole.
- **The records are measurements the run finished.** A keyword reports its
  axis only after its own paging, its feed step and its re-probe. What failed
  after that is a judgement of a count, not a measurement. A run that could
  not measure (a request, a malformed page) never reaches every keyword's
  report, and commits nothing.
- **A degraded registry cannot strip pins past today's bounds.**
  - A cell that served short is not judged.
  - A zero total evicts only when a second probe confirms it, and only within
    the cap.
  - Seeding adds owners and never removes one.

## 5. Not built

- **A red run's other state files.**
  - `feed-state.json` is not committed. The next run reads the feed again from
    the committed cursor, so its rows are read twice, not lost. A carrier the
    red run's verification withdrew stays in the file until a later sample of
    its owner withdraws it again.
  - `repo-state.json` has nothing to commit: the GitHub half never ran.
- **A run that fails after Classify** (the GitHub half, the pipeline).
  - Its slice did not cause the failure, so running the slice again costs a
    day, not a streak.
  - `build.ts` may already have written the file. Applying the axis on top
    could advance a cursor twice.
- **A cursor that advances without the pins**, from a date for example. It
  ends a streak only when one slice holds the whole residue (§1).

## 6. Testing

`npm-client.test.ts`:
- A first keyword failing a coverage check still lets the second report its
  axis, and the error is a `CoverageCheckError` naming the first.
- Two keywords failing are both named.
- An error that is not a coverage check (a page with no total on the retry
  pass, the feed's disagreement bound) is thrown at once, and the later
  keyword does not report.

`publisher-handoff.test.ts`, running the real scripts:
- **`classify.ts` on a coverage failure** writes `dist/publisher-axis.json`
  with both keywords' records and the maintainers it saw, writes no
  `dist/harvest.json`, and exits non-zero.
- **`classify.ts` on a failure before every keyword reported** writes no axis
  file.
- **`build.ts --axis-from`** writes the `publisher-state.json` a full build
  writes from the same records (pins, releases, cursors, vocabulary). It
  writes no other file, makes no request, and prints the axis lines.
- **`build.ts --axis-from` refuses** a file without `publisherAxis`, and
  refuses `--harvest-from` beside it.

`workflow.test.ts` and `repo-guards.test.ts`:
- **Exactly three committing steps push.** The new commit step's condition is
  pinned as the push steps' guard behind
  `failure() && steps.classify.outcome == 'failure'`, and so is its
  `build.ts` step's. Its `push_with_rebase` is byte-identical to the other
  two, and it passes the sandbox cases the other two pass.
- **The new commit step stages `registry/publisher-state.json` alone**, and
  runs after the step that writes it.
- **The write credential is held by the three `Commit` steps and by nothing
  else.** The `build.ts` step holds no secret.
- **The tests counting committing steps, steps that hold secrets, and steps
  allowed to rewrite the tree** change on purpose. Each says what it now
  counts.
