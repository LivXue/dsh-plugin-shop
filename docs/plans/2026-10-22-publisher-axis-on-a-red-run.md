# A red run keeps its publisher axis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When Classify fails a coverage check after every harvest keyword has reported its publisher axis, the run commits `registry/publisher-state.json` alone, exactly as a passing run's `build.ts` would write it from the same records.

**Architecture:**
- `searchByKeywords` holds a `CoverageCheckError` until every keyword has finished.
- `classify.ts` hands the axis over in `dist/publisher-axis.json`.
- `build.ts --axis-from` applies it, through the function the full build now shares.
- Two new steps at the end of the `build` job write the file (no secret) and commit it (git-only, with the push credential).

**Tech Stack:** TypeScript (node `--experimental-strip-types`), vitest, GitHub Actions YAML.

**Spec:** `docs/design/2026-10-22-publisher-axis-on-a-red-run.md`

## Global Constraints

- **Pure core, impure shell.**
  - `publisher-state.ts` stays pure.
  - `spendPublisherAxis` is a pure function at `build.ts` module scope: no clock, no filesystem.
  - Every comparison is code unit.
- **`build.ts` is the only writer of `registry/publisher-state.json`.** `classify.ts` keeps reading it only.
- **Error class:** `export class CoverageCheckError extends Error {}` in `registry/scripts/src/npm-client.ts`.
- **Handoff file:** `dist/publisher-axis.json`, holding exactly `{ "publishers": string[], "publisherAxis": PublisherAxisReport[] }`, serialized as `classify.ts` serializes those two fields into `dist/harvest.json`.
- **Commit message:** `chore(registry): publisher axis of a run that failed its coverage check [skip ci]`.
- **Both new steps' condition** is `failure() && steps.classify.outcome == 'failure' && ` + `PUSH_STEP_IF`. The commit step also requires `steps.axis.outcome == 'success'`.
- **The new `build.ts` invocation:**
  - It is `node --experimental-strip-types registry/scripts/src/build.ts --axis-from dist/publisher-axis.json`. Do not use `pnpm build:catalog`: `workflow.test.ts`'s step lookup throws when two steps mention `build:catalog`.
  - No new step's `run:` may mention `classify.ts`.
- **The push guard's `::error::` advice** ends "start a new run (Run workflow): a re-run checks out this run's own commit and meets the same conflict", in all three copies of `push_with_rebase`, byte-identical.
- Files end with exactly one trailing newline. ESM, `.ts` relative imports, `strict` and `noUncheckedIndexedAccess`.

## Review Focus

- **The write step fails** (malformed or refused handoff). The commit step must commit nothing: its condition requires `steps.axis.outcome == 'success'` (Task 4 pins it).
- **A handoff naming a username the vocabulary grammar refuses.** `--axis-from` must refuse it, exactly as `--harvest-from` would, and leave the committed file untouched (Task 2).
- **A non-coverage error in one keyword's `finish`, after another keyword failed coverage.** The run throws that error, and classify writes no axis file (Tasks 1 and 3).
- **A pull request whose Classify fails coverage.** Neither new step runs. The pinned conditions carry `PUSH_STEP_IF` (Task 4).
- **Both keywords fail.** The thrown message names both in `HARVEST_KEYWORDS` order, and the axis file holds both records (Tasks 1 and 3).

---

### Task 1: Every keyword finishes before a coverage check throws

**Files:**
- Modify: `registry/scripts/src/npm-client.ts`:
  - the four coverage throws in `finish` (window bound unpartitioned and partitioned, recovery floor, residual cap);
  - the phase loops at the end of `searchByKeywords`;
  - the MAX_UNREACHABLE_RESIDUAL comment's sentence "a failing run never reaches its commit step, so the cursor does not advance".
- Test: `registry/scripts/tests/npm-client.test.ts`.

**Interfaces:**
- Produces: `export class CoverageCheckError extends Error {}`. The four coverage throws use it.
- Unchanged: the feed disagreement throw, every throw in `search`/`pageCell`/`probe`, and the throw `classify.ts` gets from a request.

- [ ] **Step 1: Write the failing tests** in a new `describe('a coverage check waits for every keyword to report', …)`. The fixture is a plain fetch stub:
  - `keywords:dsh-plugin` answers total 10 and serves 2 names (unpartitioned, short by 8);
  - `keywords:deepseek-harness` answers total 1 and serves `dsh-b`.

  Record reports through `onPublisherAxis`. Tests:
  - `it('lets the second keyword report its axis when the first fails its coverage check')`:
    - `rejects.toBeInstanceOf(CoverageCheckError)`;
    - the message contains `keywords:dsh-plugin`;
    - the reported keywords equal `['dsh-plugin', 'deepseek-harness']`.
  - `it('names every keyword that failed, in harvest order')`: deepseek-harness also short (total 10, serves 1). The message contains `keywords:dsh-plugin`, then `keywords:deepseek-harness`.
  - `it('throws at once on a failure that is no coverage check, and the later keyword does not report')`:
    - dsh-plugin's second `size=1` probe answers `{ "objects": [] }` with no total;
    - rejects with `answered no total`, and `not.toBeInstanceOf(CoverageCheckError)`;
    - no report for `deepseek-harness`.
  - The existing test of the change feed's disagreement bound (find it by `FEED_MAX_DISAGREEMENTS`) gains `expect(error).not.toBeInstanceOf(CoverageCheckError)`.
- [ ] **Step 2: Run** `npx vitest run registry/scripts/tests/npm-client.test.ts -t 'waits for every keyword'`. Expected: FAIL. Before the change, `CoverageCheckError` does not exist, and the second keyword never reports.
- [ ] **Step 3: Implement.**
  - Declare `CoverageCheckError` beside `FetchTimeoutError`, with a doc comment citing design 2026-10-22 §2.
  - Throw it from the four coverage checks.
  - Replace `for (const r of runs) await r.finish()` with a loop that collects `CoverageCheckError`s and rethrows anything else at once. After the loop:
    - one failure → throw it as is;
    - several → throw `new CoverageCheckError(messages.join('; and '))`.
  - Amend the comment above the phase loops (design §3.1).
- [ ] **Step 4: Run** the full suite, `pnpm test`, then `pnpm typecheck`. Expected: all pass.
  - A test that asserted the later keyword stays silent after an earlier coverage failure is obsolete by design. Change it and say why in the commit.
- [ ] **Step 5: Commit** `feat(registry): every keyword reports before a coverage check throws`.

### Task 2: `build.ts --axis-from` applies a handed-over axis, through the full build's own function

**Files:**
- Modify: `registry/scripts/src/build.ts`:
  - the publisher-state block at `:537-605` moves into `spendPublisherAxis`;
  - the `--harvest-from` parsing of `publishers` and `publisherAxis` at `:218-238` moves into two shared parsers;
  - a new guard block handles `--axis-from`.
- Test: `registry/scripts/tests/publisher-handoff.test.ts`.

**Interfaces:**
- Consumes: `PublisherAxisReport` and `parsePublisherAxisReport` from `npm-client.ts`; `parsePublisherState`, `mergePublishers`, `retainPinned`, `applyAxisReport` and `serializePublisherState` from `publisher-state.ts`.
- Produces (module scope, `build.ts`):
  - `function spendPublisherAxis(prior: PublisherState, saw: Iterable<string>, axis: readonly PublisherAxisReport[]): { state: PublisherState; parts: string[] }`:
    - `parts` are the axis lines, each with its notes, exactly as `axisParts` holds them today;
    - the no-axis line is included when `axis` is empty.
  - `function parsePublishersField(raw: unknown, where: string): string[]` and `function parsePublisherAxisField(raw: unknown, where: string): PublisherAxisReport[]`. Their bodies are today's `:218-221` and `:231-238`.
- Guard blocks:
  - the existing guard becomes `if (basename(process.argv[1] ?? '') === 'build.ts' && !process.argv.includes('--axis-from'))`;
  - a sibling `if (basename(process.argv[1] ?? '') === 'build.ts' && process.argv.includes('--axis-from'))` runs the new mode.

  `strip-types.test.ts`'s `guardedName` still reads both, and its body is not re-indented.

- [ ] **Step 1: Write the failing tests** in a new `describe('build.ts --axis-from', …)`:
  - `it('writes the publisher state a full build writes from the same records, and nothing else')`:
    - two workspaces with the same committed `publisher-state.json` (pins for both keywords, 600 publishers);
    - the same two axis records: one releasing a judged pin, both stepping the cursor;
    - one run of `build.ts --harvest-from` (records inside a `harvest.json`) and one of `build.ts --axis-from` (records in `publisher-axis.json`);
    - assert the two `publisher-state.json` files are byte-identical;
    - assert the `--axis-from` workspace has no `dist/v1`, no `registry/snapshots/manifest.lock`, no `registry/feed-state.json` and no `registry/first-seen.yml`;
    - `run.urls` is `[]`, and stderr contains `released 1 judged pin(s)` and `publisher vocabulary`.
  - `it('refuses a file without publisherAxis, and leaves the committed state as it was')`: non-zero status, stderr names `publisherAxis`, file bytes unchanged.
  - `it('refuses a handoff naming a username the vocabulary grammar refuses')`: `publishers: ['bad user']`, non-zero, file unchanged.
  - `it('refuses --harvest-from beside it')`: non-zero.
- [ ] **Step 2: Run** `npx vitest run registry/scripts/tests/publisher-handoff.test.ts -t 'axis-from'`. Expected: FAIL, because the flag is unknown, the full build runs and the fetch preload rejects.
- [ ] **Step 3: Implement** the extraction and the new block.
  - The new block reads `--axis-from <path>`, requires both fields, applies `spendPublisherAxis`, writes the file and prints `npm: <part>` and the vocabulary line.
  - Rewrite the comment at `:543-546` ("a failing run does not skip its slice") to say what is true now: a run that fails its coverage check commits this file through `--axis-from` (design 2026-10-22).
- [ ] **Step 4: Run** `pnpm test`, then `pnpm typecheck`. Expected: all pass.
  - `workflow.test.ts`'s `join(REGISTRY_DIR …)` accounting covers the new block. Extend `EXCUSED_REGISTRY_DIR_USES` only if the scan asks, and give the reason in the entry.
- [ ] **Step 5: Commit** `feat(registry): build.ts --axis-from applies a handed-over publisher axis alone`.

### Task 3: Classify hands the axis over on a coverage failure

**Files:**
- Modify: `registry/scripts/src/classify.ts`, around the `searchByKeywords` call.
- Test: `registry/scripts/tests/publisher-handoff.test.ts`.

**Interfaces:**
- Consumes: `CoverageCheckError` (Task 1). Task 2's `--axis-from` reads this file.

- [ ] **Step 1: Write the failing tests:**
  - `it('classify.ts hands the publisher axis over when a coverage check fails, and writes no harvest')`:
    - preload rules make `keywords:dsh-plugin` short (total 10, serves 2) and `keywords:deepseek-harness` whole;
    - non-zero status;
    - `dist/publisher-axis.json` parses to `publisherAxis` keywords `['dsh-plugin', 'deepseek-harness']` and `publishers` sorted;
    - `dist/harvest.json` does not exist;
    - `registry/publisher-state.json` does not exist.
  - `it('classify.ts writes no axis file when it fails before every keyword reported')`: dsh-plugin's second probe answers no total. Non-zero status, and no `dist/publisher-axis.json`.
  - The existing `it('classify.ts carries what it saw in the handoff, …')` gains `expect(existsSync(join(cwd, 'dist', 'publisher-axis.json'))).toBe(false)`.
- [ ] **Step 2: Run** `npx vitest run registry/scripts/tests/publisher-handoff.test.ts -t 'axis'`. Expected: the first test fails, because there is no file.
- [ ] **Step 3: Implement.**
  - Catch around `searchByKeywords`. When the error is a `CoverageCheckError` and `axis.length === HARVEST_KEYWORDS.length`, write the file, log `classify: handed the publisher axis to dist/publisher-axis.json for the commit step`, then rethrow.
  - Rethrow everything else untouched.
  - The comment cites design 2026-10-22 §3.2, and why the count is a guard rather than a branch the run can take.
- [ ] **Step 4: Run** `pnpm test`, then `pnpm typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(registry): classify.ts hands its publisher axis over when a coverage check fails`.

### Task 4: The workflow writes and commits it, and the specs say so

**Files:**
- Modify: `.github/workflows/daily.yml`:
  - `id: classify` on Classify;
  - two new last steps of `build`;
  - the `::error::` advice in both existing copies of `push_with_rebase`.
- Test:
  - `registry/scripts/tests/workflow.test.ts`: the module-scope push-step count, "exactly the two committing steps", "byte-identical", the per-step `if`, and the tree-mutating step list;
  - `registry/scripts/tests/repo-guards.test.ts`: secret holders, write-credential holders.
- Docs:
  - `docs/design/2026-08-18-dsh-plugin-shop-design.md`: the cursor sentence at `:637` and the 2026-09-14 note at `:667`;
  - `docs/design/2026-09-17-publisher-pinning.md`: "A red run commits nothing" (`:638`);
  - `docs/design/2026-10-20-cross-keyword-credit-and-feed-aware-pins.md`: §3.2's consequence "A paging failure loses the earlier keyword's lines", and the first keyword's coverage throw;
  - `docs/plans/2026-08-18-remaining-work.md`: a dated entry.

**Interfaces:**
- New steps:
  - `Write the publisher axis a failed coverage check left`: `id: axis`, no `env:` secret;
  - `Commit the publisher axis a failed coverage check left`: `continue-on-error: true`, `env: REGISTRY_PUSH_TOKEN`.
- `RED_RUN_STEP_IF = \`failure() && steps.classify.outcome == 'failure' && ${PUSH_STEP_IF}\``. The commit step's pinned condition is `failure() && steps.classify.outcome == 'failure' && steps.axis.outcome == 'success' && ${PUSH_STEP_IF}`.

- [ ] **Step 1: Write the failing tests:**
  - `pushSteps` names equal:
    - `"Commit the classifier's output"`;
    - `'Commit the snapshot'`;
    - `'Commit the publisher axis a failed coverage check left'`.
  - Every copy of `push_with_rebase` is byte-identical.
  - Each push step's `if` equals its pinned expression.
  - `it('writes the axis in a step holding no secret, before the step that commits it')`:
    - the write step's `env` holds no `secrets.`;
    - its `run` contains `--axis-from dist/publisher-axis.json` and `[ -f dist/publisher-axis.json ]`;
    - its index is less than the commit step's;
    - its `if` equals `RED_RUN_STEP_IF`.
  - `it('commits the red run\'s publisher-state.json and nothing else')`: the commit step's `git add` line stages exactly `registry/publisher-state.json`.
  - `it('advises a new run, not a re-run, when the autostash cannot reapply')`: every copy contains `start a new run (Run workflow)` and none contains `so re-run the workflow`.
  - repo-guards counts:
    - secret holders 5, `Commit` prefix 3;
    - write-credential holders 3, all `Commit`.
- [ ] **Step 2: Run** `npx vitest run registry/scripts/tests/workflow.test.ts registry/scripts/tests/repo-guards.test.ts`. Expected: FAIL. There are no such steps yet, and the copies still say re-run.
- [ ] **Step 3: Implement the workflow**, and in the same commit amend the docs listed above. Each amendment is dated 2026-10-22 and cites the design.
- [ ] **Step 4: Run** `pnpm test` and `pnpm typecheck`. Expected: all pass, the sandbox push cases included for the new step.
- [ ] **Step 5: Commit** `feat(ci): a run that fails its coverage check commits its publisher axis`.
