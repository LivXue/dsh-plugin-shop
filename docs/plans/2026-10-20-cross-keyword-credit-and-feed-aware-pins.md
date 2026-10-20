# Cross-keyword credit and feed-aware pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A name counts toward a harvest keyword when any search page of the run served it with that keyword in its indexed keywords; pins are seeded and earned only from names the change feed does not carry; and a probed pin that seeding no longer names is released.

**Architecture:** `searchByKeywords` (`registry/scripts/src/npm-client.ts`, shell) pages every keyword's search cells first and judges each keyword second, crediting across keywords from a run-level index of the keywords each search object listed. The policy decisions are pure functions in `publisher-state.ts`:
- which harvested names may seed a pin (`seedableNames`);
- which probed pins this run judged (`judgedPins`);
- what leaves the pinned set (`applyAxisReport`).

The coverage line (`describeFeedCoverage`, `feed-state.ts`) reports the cross credit.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), vitest, pnpm.

**Spec:** `docs/design/2026-10-20-cross-keyword-credit-and-feed-aware-pins.md`. Read it before any task. Its §1 holds the measurements the tests' figures come from.

## Global Constraints

- **Pure core, impure shell.** `publisher-state.ts` and `feed-state.ts` take no clock, network, filesystem, environment or locale. Every comparison is code-unit (`compareStrings`, `===`).
- **Exact equality only.** A keyword in a search object matches the harvest keyword with `===`: no `toLowerCase`, no `trim`.
- **No new requests.** Cross credit reads `package.keywords` from objects already fetched. A pin's verdict reads probes and pages the run already makes.
- **Strict handoff parsing.** Every new report field is parsed by the existing strict parsers (`parsePublisherAxisReport`, `parseFeedCoverage`), which throw `…; re-run the harvest that wrote it`.
- **Tests describe behavior.** When a change makes an existing assertion obsolete, change it and say why in a comment. Never edit an assertion silently.
- **Verify fixture arithmetic.** Use the house formula for an over-cap residual, as the change-feed tests do: `overCap = MAX_UNREACHABLE_RESIDUAL + 1`, `tail = Math.ceil(overCap / (1 - MIN_UNREACHABLE_RECOVERY)) + 50`, `recovered = tail - overCap`. It clears the rate floor so that the cap is what refuses.
- **Files end with exactly one trailing newline.** An empty `catch` names what it swallows.
- **Commits.** Each ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Use `git -C <worktree>`, never `git stash`.
- **Verify each task.** Run `pnpm test` (whole suite, from the worktree root) and `pnpm typecheck`. Both must pass. Write the exit code into the log (`…; echo "EXIT=$?"`), because a pipe hides it.

## Review Focus

1. A re-page of the FIRST keyword (`dsh-plugin`) serves a name whose object lists `deepseek-harness`. `deepseek-harness`, judged after it, credits that name. Covered in Task 2 by the case "credits a name the earlier keyword's retry pass served".
2. A search response whose objects carry no `keywords` field. It must credit nothing across keywords, seed nothing and release no pin. Covered in Task 2 ("no keywords, no credit") and Task 4 ("a pin whose names arrived without keywords is not judged").
3. An unavailable change feed, where `carriers` is an empty map. Seeding and earning must behave exactly as today. Covered in Task 3 ("an unavailable feed seeds as before").
4. Credits that take a keyword past npm's total. The line must say `(N over)` rather than read whole. Covered in Task 2 ("a credit npm does not count shows as over").
5. A handoff `judged` list naming a maintainer that is not pinned, or one that was also evicted. The first is ignored; for the second, eviction wins and the name is not counted twice. Covered in Task 1.

---

### Task 1: The pure rules — seedable names, judged pins, release

**Files:**
- Modify: `registry/scripts/src/publisher-state.ts`
  - near `HarvestedName` (≈ line 492);
  - `AxisOutcome` (≈ line 727);
  - `applyAxisReport` (≈ line 777).
- Test: `registry/scripts/tests/publisher-state.test.ts`

**Interfaces:**
- Produces:
  - `seedableNames(harvested: ReadonlyMap<string, HarvestedName>, carried: { has(name: string): boolean }): HarvestedName[]`. Returns the values whose key `carried` does not hold, in map order.
  - `type PinCell = 'zero' | 'over-window' | 'redundant' | 'paged'`.
  - `interface PinObservation { readonly maintainer: string; readonly cell: PinCell; readonly whole: boolean; readonly names: readonly HarvestedName[] }`.
  - `judgedPins(observations: readonly PinObservation[]): string[]`. Returns the judged maintainers, sorted with `compareStrings`, unique, each passing `isMaintainerName`.
  - `AxisOutcome.judged: readonly string[]`.
  - `applyAxisReport(...)` returns `{ state, refused, evictionsRefused, released: string[] }`. `released` lists the pins that left because seeding did not name them, sorted.

- [ ] **Step 1: Write the failing tests.** Add `judged: []` to the `outcome()` helper's defaults in the `applyAxisReport` describe block. Then add these cases:
  - **`describe('seedableNames')`**
    - `it('leaves out a name the change feed carries')`: `seedableNames(new Map([['a', A], ['b', B]]), new Map([['b', 'alice']]))` equals `[A]`.
    - `it('keeps every name when the feed carries none')`: an empty `Set` returns both values.
  - **`describe('judgedPins')`**. Each case is a one-element list. `kw = { keywords: ['k'], maintainers: ['u'] }`; `bare = { keywords: [], maintainers: ['u'] }`.
    - `{ cell: 'redundant', whole: false, names: [kw] }` gives `['u']`.
    - `{ cell: 'paged', whole: true, names: [kw] }` gives `['u']`.
    - `{ cell: 'paged', whole: false, names: [kw] }` gives `[]`.
    - `{ cell: 'zero', … }` gives `[]`.
    - `{ cell: 'over-window', … }` gives `[]`.
    - `{ cell: 'paged', whole: true, names: [kw, bare] }` gives `[]`. Comment: a response that stopped carrying `keywords` reads every name as not at risk.
    - `{ cell: 'redundant', whole: false, names: [] }` gives `[]`: no evidence.
    - Two observations `['zb', 'za']` plus a duplicate `'za'` give `['za', 'zb']`.
    - Maintainer `'Not A Name'` gives `[]`.
  - **Release (in `describe('applyAxisReport')`)**
    - `it('releases a judged pin that seeding no longer names, and keeps one it did not judge')`:
      - state pinned `{ k: ['judged-gone', 'kept', 'unjudged'] }`;
      - outcome `{ seeded: ['kept'], judged: ['judged-gone', 'kept'] }`;
      - expect pinned `['kept', 'unjudged']` and `released` `['judged-gone']`.
    - `it('lets a seed take the slot a release freed in the same run')`:
      - `full` is `MAX_PINNED_PER_KEYWORD` users;
      - outcome `{ seeded: ['newresidueowner'], judged: [full[0]] }`;
      - expect pinned to contain `'newresidueowner'`, `refused` `[]`, `released` `[full[0]]`.
    - `it('ignores a judged name that is not pinned')`: `judged: ['stranger']` gives `released` `[]`, pinned unchanged.
    - `it('counts an evicted pin once, as evicted')`:
      - pinned `['z']`, outcome `{ evicted: ['z'], judged: ['z'] }`;
      - expect `released` `[]`, pinned `undefined`.
    - Extend `removes a pin the complete seeding of an un-partitioned keyword does not name`: also expect `released` `['gone']`.

- [ ] **Step 2: Run the tests to verify they fail.** Run `pnpm exec vitest run registry/scripts/tests/publisher-state.test.ts`. Expected: FAIL, because `seedableNames`/`judgedPins` are not exported and `released` is undefined.

- [ ] **Step 3: Implement in `publisher-state.ts`.**
  - **`judgedPins`.** A pin is judged when all three hold:
    - `cell === 'redundant'`, or `cell === 'paged'` with `whole`;
    - `names.length > 0`;
    - every name has `keywords.length > 0`.
  - **`applyAxisReport`.** Keep the order evict, then release, then pin:

    ```ts
    released = seedingComplete
      ? pinned.filter(u => !keep.has(u) && !evicted.includes(u))
      : pinned.filter(u => judged.has(u) && !keep.has(u) && !evicted.includes(u))
    ```

    `unpinFor` takes evicted plus released.
  - **Doc comments.** Rewrite the `AxisOutcome.seedingComplete` comment, which says "the probe is the only exit": past the window a judged pin may also leave (design §4.2), and the reason it can is that a probed pin's own cell shows its names. Document `judged` and `released` the same way. Cite the design doc by name.

- [ ] **Step 4: Run the tests to verify they pass.**
  - Run `pnpm exec vitest run registry/scripts/tests/publisher-state.test.ts`. Expected: PASS.
  - Then run the full `pnpm test` and `pnpm typecheck`. Expected: both `EXIT=0`. `AxisOutcome` consumers that build the type by hand need `judged: []` until Task 4. For now, `npm-client.ts` passes `judged: []` at its `onPublisherAxis` call, and `parsePublisherAxisReport` returns `judged: []`. Each carries a comment naming Task 4, which measures and parses the field.

- [ ] **Step 5: Commit** `feat(registry): seedable names, judged pins and their release — the pure rules`.

---

### Task 2: Cross-keyword credit, in two phases

**Files:**
- Modify: `registry/scripts/src/npm-client.ts`
  - `searchByKeywords` (≈ lines 2289–3011);
  - its doc comment.
- Modify: `registry/scripts/src/feed-state.ts`
  - `FeedCoverage` (≈ line 593);
  - `describeFeedCoverage` (≈ line 690);
  - `parseFeedCoverage` (≈ line 757).
- Test: `registry/scripts/tests/npm-client.test.ts`, `registry/scripts/tests/feed-state.test.ts`

**Interfaces:**
- Produces: `FeedCoverage.acrossKeywords: number`. It counts the names this keyword's union holds only because another keyword's search page served them, listing this keyword exactly. A count; the handoff requires it.
- Inside `searchByKeywords`:
  - a run-level `indexedKeywords: Map<string, readonly string[]>`. `pageCell` fills it for every object with a string name, using `keywordsOf(object?.package)`; the first observation wins.
  - one `keywordRun(part)` per partition, returning `{ search(): Promise<void>; finish(): Promise<void> }`.

- [ ] **Step 1: Write the failing tests.**

  In `feed-state.test.ts`:
  - Add `acrossKeywords: 0` to the shared `coverage` fixture.
  - `it('says how many names another harvest keyword served')`: `{ ...coverage, acrossKeywords: 23 }` reads `…feed supplied 17 (owners verified 12 of 12); 23 served under another harvest keyword; enumerated 8530 of 8530`. The clause is printed only when the count is above 0, matching the line's other optional clauses, so the existing exact-line tests stay as they are.
  - In the `parseFeedCoverage` rejection table, add:
    - `['no cross-keyword count', { acrossKeywords: undefined }]`;
    - `['credits past what it enumerated', { acrossKeywords: 8530 }]`. The check becomes `enumerated < supplied + acrossKeywords`, replacing `enumerated < supplied`.

  In `npm-client.test.ts`, add a new `describe('cross-keyword credit')` built on `stubSearchWithPackages`:
  - **The fixture.** `deepseek-harness` is partitioned: total `SEARCH_WINDOW + tail`; the window serves the first `SEARCH_WINDOW`; `keywords:deepseek-harness,dsh` serves `recovered` names past it. That leaves `overCap` names missing (the formula from Global Constraints). `keywords:dsh-plugin` is unpartitioned and serves exactly those `overCap` names, each listing `['dsh-plugin', 'deepseek-harness']`.
  - `it('credits a name another keyword served when its search object lists this keyword exactly')`:
    - resolves;
    - the `deepseek-harness` `FeedCoverage` has `acrossKeywords: overCap` and `enumerated === required`.
    - The same fixture with the dsh-plugin objects listing `['dsh-plugin']` only rejects `a tail shortfall of ${overCap}`.
  - `it('does not credit a keyword listed in another case or with spaces')`: the objects list `'DeepSeek-Harness'` and `' deepseek-harness'`. It rejects `a tail shortfall of ${overCap}`.
  - `it('no keywords, no credit')`: the objects carry no `keywords` field. It rejects the same way.
  - `it('credits the keyword the harvest pages first, from the keyword it pages second')`: the mirror fixture. `dsh-plugin`, the first entry of `HARVEST_KEYWORDS`, is the partitioned one; the names are served under `deepseek-harness` listing `dsh-plugin`. It resolves. Before this task it rejects: `dsh-plugin` was judged before `deepseek-harness` was paged.
  - `it('credits a name the earlier keyword\'s retry pass served')`:
    - `stubSearchWithRetriedPages` makes `dsh-plugin`'s second paging serve one extra object listing `deepseek-harness`;
    - `deepseek-harness`, otherwise exactly `MAX_UNREACHABLE_RESIDUAL + 1` short, then passes.
  - `it('a cross-credited carrier is not feed-only')`:
    - one of the missing names is also a feed carrier (`feedOf`-style `FeedInput`);
    - its coverage reads `feedOnly: 0`, `supplied: 0`, `acrossKeywords: overCap`.
  - `it('a credit npm does not count shows as over')`:
    - `deepseek-harness` is whole on its own, and `dsh-plugin` additionally serves two names listing `deepseek-harness` that its query never counts;
    - the line ends `(2 over)`.

- [ ] **Step 2: Run the tests to verify they fail.**
  - Run `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts registry/scripts/tests/feed-state.test.ts`.
  - Expected: the new cases FAIL, rejecting `a tail shortfall of 15`, or failing on `acrossKeywords` undefined.

- [ ] **Step 3: Implement.**
  - **`feed-state.ts`:** the field, the clause and the parse check, with doc comments.
  - **`npm-client.ts`:**
    - **Hoist the loop body.** Move today's per-partition loop body into `const keywordRun = (part) => { …the same state and closures…; return { search, finish } }`.
    - **`search`** pages the window, the refinement cells, the oversized cells and the publisher cells. That is today's `enumerate` without `runFeedStep`.
    - **`creditAcross()`** adds every `[name, keywords]` of `indexedKeywords` with `!forKeyword.has(name) && keywords.includes(keyword)` to `forKeyword` and to a run-local `across: Set<string>`.
    - **`finish`** runs `creditAcross()` and then `runFeedStep()`, then `required` as today. On a shortfall it runs `search()`, `creditAcross()` and `runFeedStep()` (the last is memoized, as today), then re-probes. Then come today's seeding, axis report, coverage line and checks; the line gets `acrossKeywords: across.size`. Today's `continue` becomes `return`.
    - **Type.** `feedStep`'s type omits `'acrossKeywords'` beside `'enumerated' | 'required'`.
    - **The body.** It is now `const runs = partitions.map(keywordRun); for (const r of runs) await r.search(); for (const r of runs) await r.finish()`.
    - **Comments.** Update the `searchByKeywords` doc comment and the `partitions` hoisting comment ("on a run that throws while paging…"): both keywords are now paged before either is judged (design §3.2).
  - **Request order.** It changes. Update `it('pages every harvest keyword until the answered total is reached')`, which is keyed on call order:
    1. the `dsh-plugin` probe;
    2. the `deepseek-harness` probe;
    3. `dsh-plugin` page 1 (250 objects);
    4. `dsh-plugin` page 2 (`dsh-last`);
    5. the `deepseek-harness` empty page;
    6. the `dsh-plugin` re-probe;
    7. the `deepseek-harness` re-probe.

    Rewrite its comment to say both keywords are paged before either is judged. The count stays 7. Re-read any other failure for an order assumption before touching it.

- [ ] **Step 4: Run the tests to verify they pass.**
  - Run the two files, then `pnpm test` and `pnpm typecheck`. Expected: `EXIT=0` for both.
  - Name every pre-existing test whose assertion changed in the commit body, with the reason.

- [ ] **Step 5: Commit** `feat(registry): a name counts toward every harvest keyword its search object lists`.

---

### Task 3: Seed and earn only what the feed cannot reach

**Files:**
- Modify: `registry/scripts/src/npm-client.ts`
  - the seeding block and `atRiskNames` (≈ lines 2897–2918);
  - the rotated paging loop (≈ lines 2824–2835);
  - `describePublisherAxis` (≈ line 452).
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `seedableNames` (Task 1). `FeedInput.carriers.get(keyword)` is a `ReadonlyMap<string, string | null>`; it is absent when the feed is unavailable.
- Produces: `PublisherAxisReport.atRiskNames`, now the count of at-risk names the feed does not carry.

- [ ] **Step 1: Write the failing tests** (in `describe('the publisher axis seeds at-risk owners while a keyword is enumerable')` or a new sibling):
  - `it('seeds no owner for an at-risk name the change feed carries')`:
    - an unpartitioned keyword whose names list only the harvest keyword;
    - the feed carries `dsh-carried` (owner `alice`) and not `plain` (owner `bob`);
    - expect `seeded` `['bob']` and `atRiskNames` `1`.
  - `it('an unavailable feed seeds as before')`: the same fixture with `NO_FEED` seeds `['alice', 'bob']`, `atRiskNames` `2`.
  - `it('a rotated cell whose new names the feed carries earns no pin')`:
    - a partitioned fixture whose rotation reaches two maintainers past the window;
    - `carol` supplies only `dsh-c` (a carrier) and `dave` supplies `plain-d`;
    - `seeded` contains `dave` and not `carol`;
    - `rotatedSupplied` still counts both names, because supply is measured as before.
  - Update `describePublisherAxis` exact-line cases to read `seeded N owner(s) from M at-risk name(s) the change feed does not carry, seen this run`. Comment: the count is now the population seeding read (design §4.1).

- [ ] **Step 2: Run the tests to verify they fail.** Run `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts`. Expected: the new cases FAIL (`alice` seeded, `carol` earned).

- [ ] **Step 3: Implement.**
  - Seeding reads `seedableNames(harvested, feed.carriers.get(keyword) ?? new Map())` in both `atRiskOwners` and `atRiskNameCount`.
  - In the rotated loop, page into a fresh `Set` (`got`). `fresh` is the members of `got` not already in `forKeyword`. Add `got` to `forKeyword`, and add `fresh.length` to `rotatedSupplied`.
  - The cell earns when `fresh.some(n => !carried.has(n))`.
  - Update the comments that state the old entry rule: design §3's outcome entry, and the `describePublisherAxis` "at-risk name(s) SEEN THIS RUN" note.

- [ ] **Step 4: Run the tests to verify they pass.** Run `pnpm test` and `pnpm typecheck`. Expected: `EXIT=0`.

- [ ] **Step 5: Commit** `feat(registry): pin only owners whose at-risk names the change feed does not carry`.

---

### Task 4: Measure which pins this run judged, and report what left

**Files:**
- Modify: `registry/scripts/src/npm-client.ts`
  - `selectPublisherCells` (≈ lines 2594–2636);
  - the pinned paging loop (≈ 2818–2823);
  - the `onPublisherAxis` call;
  - `parsePublisherAxisReport` (≈ 499);
  - the `selectPublisherCells` doc comment ("A zero-total cell exits the pinned set here … and nothing else does").
- Modify: `registry/scripts/src/build.ts`, the axis loop (≈ lines 561–580).
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `PinObservation`, `judgedPins` and `applyAxisReport(...).released` (Task 1).
- Produces: `PublisherAxisReport.judged`, set from `judgedPins(observations)`, where the run records one observation per pin `probeOrder` returned:
  - `'zero'`: the probe answered 0, whether confirmed or not.
  - `'over-window'`: `cellTotal > SEARCH_WINDOW`.
  - `'redundant'`: the cell was skipped by `cellTotal <= servedFor size`. Its names are `servedFor.get(maintainer)` mapped through `harvested`. A name `harvested` lacks counts as `{ keywords: [], maintainers: [] }`.
  - `'paged'`: `whole` is true when any pass's own paging served at least the total it answered. Page into a fresh `Set` and compare with `pageCell`'s return. Its names are the union of the names its own paging served, through `harvested`.

- [ ] **Step 1: Write the failing tests.** Use the `outcomeStub` / `stubPublisherProbe` family in `describe('the publisher axis probes its pinned set first')`:
  - `it('judges a pinned cell paged in full')`: `report.judged` includes that pin.
  - `it('does not judge a pinned cell that served short of its total')`: the paged total exceeds the objects served on both passes.
  - `it('judges a pinned cell the window had already covered')`: the cell total is at most what the window served for that maintainer.
  - `it('does not judge a zero-total pin, or one over the window')`.
  - `it('a pin whose names arrived without keywords is not judged')`.
  - In `parsePublisherAxisReport`'s tests, a record without `judged`, or with `judged: ['Not A Name']`, throws `has no \`judged\` array of maintainer usernames`.

- [ ] **Step 2: Run the tests to verify they fail.** Run `pnpm exec vitest run registry/scripts/tests/npm-client.test.ts`. Expected: FAIL, because `judged` is `[]`.

- [ ] **Step 3: Implement.**
  - Record the observations as specified under Interfaces, pass `judged: judgedPins(observations)` to `onPublisherAxis`, and parse `judged: names('judged')`.
  - In `build.ts`, after the existing `refused` note, add one more note when `applied.released.length > 0`: `released ${applied.released.length} pin(s) seeding no longer names`.
  - Update the `selectPublisherCells` doc comment to say a pin also leaves when this run judged it and seeding did not name it (design §4.2).

- [ ] **Step 4: Run the tests to verify they pass.** Run `pnpm test` and `pnpm typecheck`. Expected: `EXIT=0`.

- [ ] **Step 5: Commit** `feat(registry): release a pin this run judged and seeding no longer names`.

---

### Task 5: Amend the specs and CLAUDE.md

**Files:**
- Modify: `docs/design/2026-09-17-publisher-pinning.md`. Add a dated amendment note at §2 (the seeding population), at §3 after the 2026-09-18 "complete knowledge" amendment (the release exit), and at §6 (the line's wording).
- Modify: `docs/design/2026-10-04-change-feed-harvest.md`. At §4.5: feed-only is computed after cross credit. At §4.7: the line's new clause.
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md`. One amendment paragraph in the search-coverage section, after the 2026-10-06 cap amendment (≈ line 610): a keyword's union counts names another harvest keyword's search served that list it exactly.
- Modify: `CLAUDE.md`. In "Failing loudly", after the change-feed paragraph, add one paragraph: cross credit, feed-aware pins and the release exit, with a pointer to the design doc. Keep the figures in the design doc, not in CLAUDE.md, per the repo's rule against restating figures.

- [ ] **Step 1: Write the amendments.** Each note is dated 2026-10-20, names the design doc, and states the rule in one or two sentences. English only.
- [ ] **Step 2: Check for stale twins.** Run `grep -rn "only exit\|nothing else does\|probe is the only exit\|at-risk name(s) seen this run" docs registry/scripts/src CLAUDE.md`. Every hit either matches the new rule or is a dated historical record.
- [ ] **Step 3: Run the suite.** Run `pnpm test`. Docs changes alone should leave it at `EXIT=0`; some tests scan docs.
- [ ] **Step 4: Commit** `docs: cross-keyword credit and feed-aware pins in the specs and CLAUDE.md`.
