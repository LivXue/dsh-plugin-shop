# Audit fixes C — network shell, artifacts, CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the GitHub half of the harvest tell the truth about why a repository is not listed, publish to Pages only the artifacts the spec lists, and stop the daily workflow from holding a write credential and mutable action tags while it processes hostile input.

**Architecture:** Three seams. In the network shell (`github-client.ts`, `npm-client.ts`) a failure gets classified by what actually happened — only a 404 is `no-manifest`, a page is full only if its *raw* item count says so, and every JSON body is read under a byte cap. In the build shell (`build.ts`) the four lines of sidecar policy move into the pure core (`stars-assemble.ts`, `pipeline.ts`) and the Pages upload becomes a staged directory built from a pure file list. In CI the build job drops to `contents: read`, every action is pinned to a commit SHA, and the guards that exist for release commits actually run on one.

**Tech Stack:** TypeScript ESM with `.ts` relative imports, Node 22/24 type-stripping, vitest, zod, `yaml`, GitHub Actions.

**Spec:** [docs/plans/2026-09-03-debug-audit.md](2026-09-03-debug-audit.md) — findings D-3, D-4, D-9, C-7, E-9/D-8, C-3, C-4/A-9/E-8, C-5, E-4, E-6, E-7, E-10, E-11, E-12

## Global Constraints

- Pure core (`gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`, `types.ts`, `stars-assemble.ts`, and the new `pages-artifacts.ts`): no clock, no network, no filesystem, no environment. `node:crypto` is allowed — `emit.ts` already hashes there.
- Impure shell: `npm-client.ts`, `llm-client.ts`, `github-stars.ts`, `github-client.ts` (network), `build.ts` (clock + writes), `config.ts` (reads registry YAML), `classify.ts`, `publish-catalog.ts`.
- `builtAt` belongs to `index.json` alone and never enters hashed content.
- Stars live in their own content-addressed sidecar `stars.<sha256>.json`, so the plugin data hash never churns daily.
- A package or repository that cannot be fetched becomes a `fetch-failed` rejection in the build report, never a disappearance.
- Every rejection carries an author-readable `detail`. A wrong or misattributed reason is a defect, not a wording nit.
- Entries sort by package name before emit; the stars sidecar sorts by key before hashing.
- ESM everywhere, `.ts` extensions on local relative imports.
- `strict` and `noUncheckedIndexedAccess` are on. Guard index access; never assert it away.
- Every file ends with exactly one trailing newline.
- The four artifacts the spec lists for `/v1/`: `index.json`, `plugins.<sha256>.json`, `stars.<sha256>.json`, `badge.json`. Nothing else ships to Pages.
- GitHub search caps a query at 1000 results (`GITHUB_SEARCH_CAP`) and a page at 100 (`SEARCH_PAGE_SIZE`); `MAX_SEARCH_PAGES` is 10.
- npm search caps `from` at 5000 and this plan does not change that loop — D-1 is plan A's.

## Cross-plan ordering

- **Task 9 (C-3) collides with plan B, which replaces `pipeline.ts` wholesale.** [Plan B](2026-09-03-audit-fix-b-identity-trust.md) rewrites the whole of `registry/scripts/src/pipeline.ts` — imports plus `runPipeline` — for the identity keying (C-2, B-6, C-6). Task 9 splits that same function into `selectEntries` + a thin `runPipeline`. **Land Task 9 first**, then plan B's replacement must be written against the split file: its new gate/tier loops go inside `selectEntries`, and `runPipeline` stays the two-line composition. If plan B lands first, Task 9 re-does the extraction on B's version — the mechanical part is unchanged, since it moves loop bodies verbatim, but the diff is written twice. Plan B's `emit.ts` sort change (lines 104-111) does not conflict with Task 10, which touches only `escapeCell` at lines 67-79.
- **Task 9's interface disagrees with plan E's Task 10 as written.** [Plan E](2026-09-03-audit-fix-e-test-gaps.md) recomputes the sidecar's hash and expects `serializeStars(assembled) → { json, sha }` in a module it guesses at `registry/scripts/src/stars-serialize.ts`. This plan produces **`serializeStars(assembled) → { fileName, json, sha256 }` in `registry/scripts/src/stars-assemble.ts`**, beside the assembler that feeds it: `fileName` is there because C-3 names the file naming as policy that must leave the shell, and `sha256` matches `StarsPointer.sha256` and `emit`'s own field. Plan E's task consumes this plan's names, not the audit's prose shorthand — reconcile in plan E, not here.
- **Task 15 (E-7) rewrites the two `git push` steps that plan A's E-2 also rewrites.** [Plan A](2026-09-03-audit-fix-a-urgent.md) Task 6 adds `git fetch origin main || true` and `git rebase origin/main || { git rebase --abort || true; }` before each push. Do Task 15 after plan A lands and carry those two lines through verbatim; Task 15 changes only the `env:` block and the final `git push` line of each step. Plan A's guard test asserts both strings are present, so dropping them fails its test rather than silently regressing.
- **Task 12 (C-5) hands the durable code fix to plan D** (`packages/dsh-plugin-shop/src/host/origin.ts`): an HTTP data-file 404 should fall through to another origin instead of only to the disk cache. This plan owns the decision and the documentation, not the host change.

## New and changed exports, at a glance

| Module | Export | Task |
|---|---|---|
| `github-client.ts` | `parseHarvestBudget(raw, fallback) => number` | 7 |
| `github-client.ts` | `RepoHarvestOptions.retryAfterMs?: number` | 8 |
| `github-client.ts` | `RepoHarvestResult.incompleteWindows: string[]`, `.firstAttemptError: string \| null` | 5, 8 |
| `github-client.ts` | `searchReposByTopic` returns `incompleteWindows` | 4 |
| `repo-state.ts` | `nextRepoState(state, seen, fetched, pruneGone?)` | 5 |
| `repo-state.ts` | `staleFailureRepos(state, code, detail, limit) => string[]` | 3 |
| `npm-client.ts` | `MAX_SEARCH_BODY_BYTES`, `MAX_PACKUMENT_BYTES` | 6 |
| `pipeline.ts` | `selectEntries(candidates, repoCandidates, config, preexisting?) => { entries, rejections }` | 9 |
| `stars-assemble.ts` | `assembleStarsForEntries(entries, searchStars, graphqlStars) => AssembledStars` | 9 |
| `stars-assemble.ts` | `serializeStars(assembled) => SerializedStars` | 9 |
| `pages-artifacts.ts` (new) | `PagesPointer`, `PAGES_FIXED_FILES`, `pagesArtifactNames(pointer) => string[]` | 11 |

---

### Task 1: Only a 404 is `no-manifest`

> **Outcome: ALREADY DONE by plan A, more strongly than the steps below ask.
> Do not apply Step 3 — it would be a regression.** Verified 2026-09-04 at
> `github-client.ts:1102-1122`.
>
> Plan A narrowed the same branch, and where this task says "return
> `fetch-failed`", plan A **throws**. That difference is the whole point: a
> returned rejection is a verdict `harvestRepos` records, while a throw lands
> in its catch, publishes a reason we wrote, records nothing so the next build
> retries — and counts toward the systematic-failure bound, which counts
> throws alone and so could never fire for a returned status. A pool-wide 403
> is a broken harvest, not fourteen thousand bad repositories, and only the
> throw can stop the build.
>
> Coverage is wider than the three cases below:
> `describe('only a 404 is a verdict about the repository')` in
> `github-client.test.ts` holds eight, including a single-repo 500, "records
> nothing so the next run retries it", the pool-wide bound firing
> (`40 of 40 repositories threw`), the genuine 404 still persisting, and the
> tree and subpackage variants.
>
> Task 19 (D-10) is the note that exists because of this task: when the
> narrowing stops a build, the answer is a lower `REPO_BACKFILL_BUDGET`, never
> a widening back to a returned status.


**Files:**
- Modify: `registry/scripts/src/github-client.ts:523-527`
- Test: `registry/scripts/tests/github-client.test.ts` (the `fetchRepoCandidate` describe, after line 144)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fetchRepoCandidate` returns `code: 'fetch-failed'` for every non-404 manifest response. Task 2 and Task 3 depend on that split.

- [ ] **Step 1: Write the failing test**

Append inside `describe('fetchRepoCandidate', ...)`, after the existing `reports fetch-failed when the head commit cannot be resolved` test:

```ts
  it('reports fetch-failed, not no-manifest, when the raw CDN answers 503', async () => {
    // `no-manifest` is a claim about the repository's contents. A 503 from
    // raw.githubusercontent.com is a claim about the CDN, and recording it as
    // `no-manifest` publishes a false reason to the author AND freezes it in
    // repo-state.json until `pushed_at` moves. The committed state holds
    // 1,918 such records and none can be told apart from a real 404.
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response('upstream broke', { status: 503 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('fetch-failed')
      expect(result.detail).toContain('503')
      expect(result.detail).toContain('someone/dsh-repo-plugin')
      expect(result.detail).not.toContain('No package.json')
    }
  })

  it('reports fetch-failed when the raw CDN answers 403', async () => {
    // The other status the live harvest meets: the CDN rate-limits by IP and
    // a shared runner egress collects 403s in bursts.
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response('forbidden', { status: 403 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('fetch-failed')
  })

  it('still reports no-manifest for a genuine 404', async () => {
    const fetchImpl = stubFetch({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response('404: Not Found', { status: 404 }),
    })
    const result = await fetchRepoCandidate(meta, fetchImpl, sleep, 'token')
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('no-manifest')
      expect(result.detail).toBe('No package.json at the repository root, so there is nothing for dsh to install.')
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts -t "reports fetch-failed, not no-manifest, when the raw CDN answers 503"` — Expected: FAIL with `expected 'no-manifest' to be 'fetch-failed'`.

- [ ] **Step 3: Write the implementation**

Before (`registry/scripts/src/github-client.ts:523-527`):

```ts
  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  const manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token)
  if (!manifestResponse.ok) {
    return { ok: false, code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }
  }
```

After:

```ts
  const rawUrl = `${RAW_GITHUB}/${owner}/${slug}/${meta.defaultBranch}/package.json`
  const manifestResponse = await fetchRobust(rawUrl, fetchImpl, sleep, token)
  if (!manifestResponse.ok) {
    // ONLY 404 says the file is not there. A 403 (the CDN rate-limits by
    // IP), a 451, an exhausted 429 or any 5xx says nothing about the
    // repository's contents — and `harvestRepos` records a `no-manifest` in
    // repo-state.json, where a deterministic failure is re-fetched only when
    // `pushed_at` changes. So a transient CDN status used to become a
    // permanent, author-readable lie: 1,918 committed records carry this
    // detail today and none can be told apart from a real 404.
    if (manifestResponse.status === 404) {
      return { ok: false, code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }
    }
    return {
      ok: false,
      code: 'fetch-failed',
      detail: `Could not read package.json from ${meta.fullName}: raw.githubusercontent.com returned ${manifestResponse.status}.`,
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts` — Expected: PASS.
Then `pnpm test` (green; 334 at HEAD plus this task's three) and `pnpm typecheck` (clean).

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/github-client.ts registry/scripts/tests/github-client.test.ts
git commit -m "fix(harvest): only a 404 manifest response is no-manifest"
```

---

### Task 2: A `no-manifest` retires a stale candidate; a `fetch-failed` never touches the state

**Files:**
- Modify: `registry/scripts/src/github-client.ts:640-655`
- Test: `registry/scripts/tests/github-client.test.ts:465-482` (rewritten) and one new test beside it

**Interfaces:**
- Consumes: Task 1's `code: 'fetch-failed'` for non-404 manifest responses.
- Produces: `harvestRepos` records a `no-manifest` for every fetched repo, recorded or not. Task 3's invalidation relies on this being the only writer of that record.

- [ ] **Step 1: Write the failing test**

Replace the existing test at `registry/scripts/tests/github-client.test.ts:465-482` — `it('keeps a failure as a reason and carries the recorded candidate for that repo', ...)`. It asserted exactly the behaviour D-3's second leg names as the defect: a repo that deletes its `package.json` kept its stale candidate listed forever while the same run reported it `no-manifest`, and re-consumed the fetch budget every day because the recorded `pushedAt` never advanced. The two tests below split that case by cause.

```ts
  it('retires the stale candidate of a repo that deleted its package.json', async () => {
    // Replaces "keeps a failure as a reason and carries the recorded
    // candidate for that repo", which pinned the defect: the candidate
    // survived and `pushedAt` stayed behind, so the entry stayed on the shelf
    // forever, the report said `no-manifest` about a listed entry, and the
    // repo re-consumed the fetch budget on every run. A `no-manifest` is a
    // fact about the contents at this `pushed_at`, so it is recorded.
    const state: RepoState = { 'x/gutted': { ...entryOf('x/gutted'), pushedAt: '2026-07-01T00:00:00Z' } }
    const seen = [{ repo: 'x/gutted', pushedAt: '2026-08-02T00:00:00Z' }]
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(s => ({ full_name: s.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: s.pushedAt })) }), { status: 200 })
      }
      return new Response('404: Not Found', { status: 404 })
    }) as unknown as typeof fetch

    const result = await harvestRepos({ state, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.failures).toEqual([{ repo: 'x/gutted', code: 'no-manifest', detail: 'No package.json at the repository root, so there is nothing for dsh to install.' }])
    expect(result.candidates).toEqual([])
    expect(result.nextState['x/gutted']?.candidates).toEqual([])
    expect(result.nextState['x/gutted']?.failure?.code).toBe('no-manifest')
    // The advanced pushedAt is what stops the daily re-fetch.
    expect(result.nextState['x/gutted']?.pushedAt).toBe('2026-08-02T00:00:00Z')
    // The commit is kept from the recorded entry rather than blanked.
    expect(result.nextState['x/gutted']?.commit).toBe(commit)
  })

  it('keeps a recorded candidate and its old pushedAt when the manifest fetch fails on transport', async () => {
    // The transient half of the same rule. A 503 says nothing about the
    // repository, so nothing is written: the recorded entry and its old
    // `pushedAt` stay, and the mismatch schedules the retry next run.
    const state: RepoState = { 'x/broken': { ...entryOf('x/broken'), pushedAt: '2026-07-01T00:00:00Z' } }
    const seen = [{ repo: 'x/broken', pushedAt: '2026-08-02T00:00:00Z' }]
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(s => ({ full_name: s.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: s.pushedAt })) }), { status: 200 })
      }
      return new Response('upstream broke', { status: 503 })
    }) as unknown as typeof fetch

    const result = await harvestRepos({ state, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.failures[0]?.code).toBe('fetch-failed')
    expect(result.candidates.map(c => c.repo)).toEqual(['x/broken'])
    expect(result.nextState['x/broken']?.pushedAt).toBe('2026-07-01T00:00:00Z')
    expect(result.nextState['x/broken']?.failure).toBeUndefined()
  })

  it('records a no-manifest for a repo it has never seen before', async () => {
    // Unchanged behaviour, asserted so the widened condition does not lose
    // the case it was written for: a dead end must not re-consume the budget.
    const seen = [{ repo: 'y/new-dead-end', pushedAt: '2026-08-02T00:00:00Z' }]
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (new URL(text).searchParams.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      if (text.includes('/search/repositories')) {
        return new Response(JSON.stringify({ items: seen.map(s => ({ full_name: s.repo, default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: s.pushedAt })) }), { status: 200 })
      }
      return new Response('404: Not Found', { status: 404 })
    }) as unknown as typeof fetch

    const result = await harvestRepos({ state: {}, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.nextState['y/new-dead-end']?.failure?.code).toBe('no-manifest')
    expect(result.nextState['y/new-dead-end']?.commit).toBe('')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts -t "retires the stale candidate of a repo that deleted its package.json"` — Expected: FAIL with `expected [ { repo: 'x/gutted', … } ] to deeply equal []` on `result.candidates` (the stale candidate is still carried), and `expected '2026-07-01T00:00:00Z' to be '2026-08-02T00:00:00Z'`.

- [ ] **Step 3: Write the implementation**

Before (`registry/scripts/src/github-client.ts:643-654`):

```ts
      } else {
        failures.push({ repo: entry.repo, code: result.code, detail: result.detail })
        // A deterministic failure on a repo with NO recorded entry is
        // recorded so the next runs carry the reason instead of re-fetching
        // the same dead end and re-consuming the budget. A repo WITH a
        // recorded entry keeps its candidates: the old pushedAt mismatch
        // schedules the retry next run (a `fetch-failed` stays transient
        // either way).
        if (result.code === 'no-manifest' && state[entry.repo] === undefined) {
          fresh.set(entry.repo, { candidates: [], failure: { code: result.code, detail: result.detail } })
        }
      }
```

After:

```ts
      } else {
        failures.push({ repo: entry.repo, code: result.code, detail: result.detail })
        // A `no-manifest` is a fact about the repository's contents at this
        // `pushed_at`, so it is recorded whether or not the repo was recorded
        // before. Recording it for a KNOWN repo is what retires a stale
        // candidate: a repo that deletes its package.json used to keep its
        // old candidate on the shelf forever while the same run reported it
        // `no-manifest`, and re-consumed the fetch budget every day because
        // the recorded `pushedAt` never advanced.
        //
        // A `fetch-failed` is a fact about the network and is never recorded:
        // the recorded entry and its old `pushedAt` stay, which schedules the
        // retry next run, and a repo never fetched at all stays out of the
        // state entirely so next run's `toFetch` picks it up again.
        if (result.code === 'no-manifest') {
          fresh.set(entry.repo, { candidates: [], failure: { code: result.code, detail: result.detail } })
        }
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/github-client.ts registry/scripts/tests/github-client.test.ts
git commit -m "fix(harvest): a no-manifest retires the stale candidate it contradicts"
```

---

### Task 3: Invalidate the 1,918 misattributed `no-manifest` records

**Files:**
- Modify: `registry/scripts/src/repo-state.ts` (add `staleFailureRepos` after `diffRepoState`, around line 114)
- Modify: `registry/repo-state.json` (data; rewritten by the one-off script)
- Test: `registry/scripts/tests/repo-state.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 2 must be committed first, or the re-fetch re-writes the same wrong records.
- Produces: `staleFailureRepos(state: RepoState, code: 'no-manifest' | 'fetch-failed', detail: string, limit: number): string[]`, sorted.

**What happens to the 1,918 records, and why:** they are invalidated in one commit. Measured at HEAD, `registry/repo-state.json` holds 14,740 repos: 1,918 carry `failure.code: 'no-manifest'` with the detail `No package.json at the repository root, so there is nothing for dsh to install.`, 4 carry `package.json was unreadable.`, 4 carry the no-installable-subpackage detail, and 12,814 carry candidates. The old rule wrote the same code and the same detail for a 404, a 403, a 451 and a 503, so a genuine 404 and a transient CDN status are byte-identical in the file and no rule can separate them. Leaving them is not an option: each one is a published rejection reason that may be false and is never re-fetched. Deleting the *entry*, not just the `failure` field, is what schedules the re-fetch — `diffRepoState` re-fetches only a repo that is absent or whose `pushed_at` moved, and a failed repo has neither. The 4 + 4 records with the other two details are left alone: those two paths only ever ran after a successful 200, so their reasons were never in doubt.

Cost: about 1,918 extra repo fetches on the next run. Each is one raw.githubusercontent.com read (a separate CDN, not counted against the REST quota) plus one `/repos/…/commits/…` REST call, plus a tree call for a monorepo signal — roughly 2,000–2,500 REST calls against a 5,000/hour PAT quota, which the existing `REPO_BACKFILL_BUDGET=2000` absorbs in a single run. If that run hits a secondary rate limit, re-run the script with `--limit 700` on three consecutive days instead; the selector is sorted, so every slice is deterministic and disjoint.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/repo-state.test.ts` (add `staleFailureRepos` to the existing import from `../src/repo-state.ts`, and `RepoStateEntry` to the type import):

```ts
describe('staleFailureRepos', () => {
  const mislabelled = 'No package.json at the repository root, so there is nothing for dsh to install.'
  const failing = (code: 'no-manifest' | 'fetch-failed', detail: string): RepoStateEntry => ({
    pushedAt: '2026-08-01T00:00:00Z',
    commit: 'a'.repeat(40),
    candidates: [],
    failure: { code, detail },
  })

  const state: RepoState = {
    'z/mislabelled': failing('no-manifest', mislabelled),
    'a/mislabelled': failing('no-manifest', mislabelled),
    'b/unreadable': failing('no-manifest', 'package.json was unreadable.'),
    'c/transient': failing('fetch-failed', 'Could not resolve the head commit of c/transient.'),
    'd/listed': { pushedAt: '2026-08-01T00:00:00Z', commit: 'a'.repeat(40), candidates: [] },
  }

  it('selects only the records the mislabelling rule wrote, sorted', () => {
    // The old rule wrote this exact code and detail for a 404, a 403, a 451
    // and a 503 alike, so the whole class is invalidated together. The other
    // two `no-manifest` details only ever followed a successful 200, so their
    // reasons were never in doubt and they stay.
    expect(staleFailureRepos(state, 'no-manifest', mislabelled, Number.POSITIVE_INFINITY))
      .toEqual(['a/mislabelled', 'z/mislabelled'])
  })

  it('honours the limit so the invalidation can be paced across runs', () => {
    // Sorted before slicing, so day two's slice is disjoint from day one's.
    expect(staleFailureRepos(state, 'no-manifest', mislabelled, 1)).toEqual(['a/mislabelled'])
  })

  it('selects nothing for a state with no such records', () => {
    expect(staleFailureRepos({ 'd/listed': state['d/listed']! }, 'no-manifest', mislabelled, 10)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-state.test.ts -t "selects only the records the mislabelling rule wrote"` — Expected: FAIL at import/collection time with `No "staleFailureRepos" export is defined on the "../src/repo-state.ts" mock` — in practice a transform error naming `staleFailureRepos` as not exported.

- [ ] **Step 3: Write the implementation**

Append to `registry/scripts/src/repo-state.ts`, after `diffRepoState` (line 114):

```ts
/**
 * The recorded repos whose failure record was written by the rule that
 * labelled every non-ok manifest response `no-manifest` (audit D-3).
 *
 * They cannot be told apart from genuine 404s — the old code wrote the same
 * code and the same detail for a 404, a 403, a 451 and a 503 — so the whole
 * class is invalidated once and re-fetched under the corrected rule.
 * Deleting the ENTRY, not just its `failure`, is what schedules the
 * re-fetch: {@link diffRepoState} re-fetches a repo only when it is absent
 * or its `pushed_at` moved, and a repo whose manifest fetch failed has
 * neither.
 * @param state - the recorded state.
 * @param code - the failure code to invalidate.
 * @param detail - the exact detail string the superseded rule wrote.
 * @param limit - at most this many, in sorted order, so a large
 *   invalidation can be paced across runs and every slice is deterministic
 *   and disjoint from the last.
 * @returns the repo full names to delete, sorted.
 */
export function staleFailureRepos(
  state: RepoState,
  code: 'no-manifest' | 'fetch-failed',
  detail: string,
  limit: number,
): string[] {
  return Object.entries(state)
    .filter(([, entry]) => entry.failure?.code === code && entry.failure.detail === detail)
    .map(([repo]) => repo)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limit)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-state.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

Now run the invalidation once. Write this to the scratchpad — it is a one-off and must not be committed:

```ts
// /tmp/claude-*/scratchpad/invalidate-raw-failures.ts
import { readFileSync, writeFileSync } from 'node:fs'
import {
  parseRepoState,
  serializeRepoState,
  staleFailureRepos,
} from '/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/registry/scripts/src/repo-state.ts'

const PATH = '/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/registry/repo-state.json'
const DETAIL = 'No package.json at the repository root, so there is nothing for dsh to install.'

const limitIndex = process.argv.indexOf('--limit')
const limit = limitIndex === -1 ? Number.POSITIVE_INFINITY : Number(process.argv[limitIndex + 1])
// The same trap C-7 is about: `Number('abc')` is NaN and `.slice(0, NaN)` is
// `[]`, which would silently invalidate nothing and report success.
if (!(limit > 0)) throw new Error(`--limit needs a positive number, got ${String(process.argv[limitIndex + 1])}`)

const state = parseRepoState(readFileSync(PATH, 'utf8'))
const before = Object.keys(state).length
const repos = staleFailureRepos(state, 'no-manifest', DETAIL, limit)
for (const repo of repos) delete state[repo]
writeFileSync(PATH, serializeRepoState(state))
process.stdout.write(`invalidated ${repos.length} of ${before} record(s); ${Object.keys(state).length} remain\n`)
```

Run: `node --experimental-strip-types <scratchpad>/invalidate-raw-failures.ts` — Expected: `invalidated 1918 of 14740 record(s); 12822 remain`.
Then confirm the file still parses and the other failure classes survived:
`node --experimental-strip-types -e "import('/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/registry/scripts/src/repo-state.ts').then(async m => { const { readFileSync } = await import('node:fs'); const s = m.parseRepoState(readFileSync('/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/registry/repo-state.json','utf8')); const f = Object.values(s).filter(e => e.failure); console.log(Object.keys(s).length, f.length) })"` — Expected: `12822 8`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/repo-state.ts registry/scripts/tests/repo-state.test.ts registry/repo-state.json
git commit -m "fix(harvest): invalidate the 1918 records the old manifest rule mislabelled"
```

---

### Task 4: Page a window on the raw item count, honour `incomplete_results`, reconcile against the probe

> **Outcome: all three findings were ALREADY FIXED by plan A, more strongly
> than the steps below ask. Do not apply Step 3 — it would be a regression.**
> Verified 2026-09-04 at `github-client.ts` (`searchPage`, `searchReposByTopic`).
>
> Every one of the three:
>
> 1. **Paging on the raw count.** `enumerated += metas.length + skipped`, and
>    the loop never breaks on a short page at all — it stops on the total the
>    API answered for that page, or on an empty one.
> 2. **`incomplete_results`.** Read, and it **throws**.
> 3. **Reconciliation against the probe.** `enumerated < probed` re-probes and
>    throws, with `Math.min(probed, after)` absorbing a window that shrank
>    mid-run.
>
> The difference is `incompleteWindows` versus a throw, and it is the same
> difference as Task 1: this task would publish a catalog known to be short
> and then suppress the consequence, while plan A stops the build. CLAUDE.md
> is explicit — "A search that cannot enumerate its whole result set throws
> rather than truncating" — and a failed build publishes nothing, so yesterday's
> catalog stays live and the badge date stops advancing where a maintainer can
> see it. **Task 5 is moot for the same reason**: a throw means `repo-state.json`
> is never rewritten and no `repo-gone` is ever published, which is exactly what
> Task 5 set out to guarantee.
>
> **What this task DID contribute, and what shipped instead:** re-reading the
> two guards for this comparison found a hole plan A left, and a way its throw
> was needlessly brittle. `searchPage` checked `incomplete_results`;
> `probeTotal` did not — and the probe is the more dangerous half, because a
> timed-out probe answers an UNDERCOUNTED `total_count`, which is the number the
> partition splits on, the zero-window skip reads, and the coverage check
> measures every enumeration against. A probe timing out to `0` skipped its
> whole window in silence: the failing test for it recorded
> `promise resolved "{ seen: [], metas: Map{}, …(1) }"` — the entire harvest
> returning empty with no error anywhere. Separately, `incomplete_results` means
> the query TIMED OUT, which is transient, so throwing on the first one failed
> the whole daily build on one slow second at GitHub.
>
> Both are one change: `searchBody`, the single request-and-read step both
> callers now use, which retries exactly once on a partial answer and throws
> when it stays partial. Strictly stronger than plan A (the probe is now
> covered) and strictly less brittle (a transient timeout no longer fails the
> build), with the doctrine unchanged.

**Files:**
- Modify: `registry/scripts/src/github-client.ts:151-170` (`searchPage`) and `262-287` (`searchReposByTopic`)
- Test: `registry/scripts/tests/github-client.test.ts` (the `searchReposByTopic` describe, after line 109)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `searchReposByTopic` returns `{ seen, metas, windowCount, incompleteWindows }` where `incompleteWindows: string[]` names every window whose enumeration is known to have dropped rows. Task 5 consumes it.

`partitionTopic` is deliberately left alone. Each window is re-probed immediately before it is paged rather than reusing the partition's total: the partition can be minutes old by the time the last window is paged, and the reconciliation compares against that number, so a fresh probe means fewer false alarms from ordinary pool churn. The cost is one `per_page=1` request and one 2 s pacing gap per window — under twenty requests for the whole run.

- [ ] **Step 1: Write the failing test**

Append inside `describe('searchReposByTopic', ...)`:

```ts
  it('pages a window on the raw item count, not the count that survived validation', async () => {
    // `metas.length < 100` was tested AFTER parseRepoMeta filtered, so one
    // item with a non-string `default_branch` ended a 149-repo window at 99:
    // page 2 was never requested, 50 repos vanished from the catalog for the
    // day, each was reported `repo-gone` ("deleted, renamed, or private" — a
    // published reason that was false), and each re-consumed the fetch budget
    // as new the next day.
    const urls: string[] = []
    const item = (name: string) => ({ full_name: name, default_branch: 'main', description: null, license: null, pushed_at: '2026-08-01T00:00:00Z' })
    const page1 = [
      ...Array.from({ length: 99 }, (_, i) => item(`o/p${String(i).padStart(3, '0')}`)),
      { full_name: 'o/untrusted', default_branch: 42 },
    ]
    const page2 = Array.from({ length: 50 }, (_, i) => item(`o/q${String(i).padStart(3, '0')}`))
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      urls.push(text)
      const params = new URL(text).searchParams
      const primary = decodeURIComponent(params.get('q') ?? '').includes('topic:dsh-plugin')
      if (params.get('per_page') === '1') {
        return new Response(JSON.stringify({ total_count: primary ? 149 : 0 }), { status: 200 })
      }
      if (!primary) return new Response(JSON.stringify({ items: [] }), { status: 200 })
      return new Response(JSON.stringify({ items: params.get('page') === '1' ? page1 : page2 }), { status: 200 })
    }) as unknown as typeof fetch

    const { seen, incompleteWindows } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(urls.some(u => new URL(u).searchParams.get('page') === '2')).toBe(true)
    expect(seen).toHaveLength(149)
    expect(incompleteWindows).toEqual([])
  })

  it('retries a page GitHub reports as incomplete and names the window when it stays partial', async () => {
    // `incomplete_results` was never read. GitHub sets it when the search
    // timed out and the page is partial, and a 40-item partial page of a
    // 900-repo window read as the end of the window.
    const pageRequests: string[] = []
    const item = (name: string) => ({ full_name: name, default_branch: 'main', description: null, license: null, pushed_at: '2026-08-01T00:00:00Z' })
    const fetchImpl = (async (url: string | URL) => {
      const params = new URL(String(url)).searchParams
      const primary = decodeURIComponent(params.get('q') ?? '').includes('topic:dsh-plugin')
      if (params.get('per_page') === '1') {
        return new Response(JSON.stringify({ total_count: primary ? 900 : 0 }), { status: 200 })
      }
      if (!primary) return new Response(JSON.stringify({ items: [] }), { status: 200 })
      pageRequests.push(String(params.get('page')))
      return new Response(JSON.stringify({
        incomplete_results: true,
        items: Array.from({ length: 40 }, (_, i) => item(`o/r${i}`)),
      }), { status: 200 })
    }) as unknown as typeof fetch

    const { seen, incompleteWindows } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(pageRequests).toEqual(['1', '1']) // requested once, retried once, not read as the end
    expect(seen).toHaveLength(40)
    expect(incompleteWindows).toHaveLength(1)
    expect(incompleteWindows[0]).toContain('topic:dsh-plugin')
    expect(incompleteWindows[0]).toContain('saw 40 of 900')
    expect(incompleteWindows[0]).toContain('incomplete_results')
  })

  it('names a window that enumerated fewer items than its probe counted', async () => {
    // The reconciliation catches every other way a window can come up short,
    // including the silent stop at MAX_SEARCH_PAGES.
    const item = (name: string) => ({ full_name: name, default_branch: 'main', description: null, license: null, pushed_at: '2026-08-01T00:00:00Z' })
    const fetchImpl = (async (url: string | URL) => {
      const params = new URL(String(url)).searchParams
      const primary = decodeURIComponent(params.get('q') ?? '').includes('topic:dsh-plugin')
      if (params.get('per_page') === '1') {
        return new Response(JSON.stringify({ total_count: primary ? 150 : 0 }), { status: 200 })
      }
      if (!primary) return new Response(JSON.stringify({ items: [] }), { status: 200 })
      return new Response(JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => item(`o/s${i}`)) }), { status: 200 })
    }) as unknown as typeof fetch

    const { incompleteWindows } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(incompleteWindows).toHaveLength(1)
    expect(incompleteWindows[0]).toContain('saw 40 of 150')
    expect(incompleteWindows[0]).not.toContain('incomplete_results')
  })

  it('reports nothing incomplete when every window meets its probe', async () => {
    const item = (name: string) => ({ full_name: name, default_branch: 'main', description: null, license: null, pushed_at: '2026-08-01T00:00:00Z' })
    const fetchImpl = (async (url: string | URL) => {
      const params = new URL(String(url)).searchParams
      if (params.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 2 }), { status: 200 })
      return new Response(JSON.stringify({ items: [item('o/a'), item('o/b')] }), { status: 200 })
    }) as unknown as typeof fetch

    const { seen, incompleteWindows } = await searchReposByTopic(fetchImpl, sleep, 'token')
    expect(seen.map(s => s.repo)).toEqual(['o/a', 'o/b'])
    expect(incompleteWindows).toEqual([])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts -t "pages a window on the raw item count"` — Expected: FAIL with `expected false to be true` on the page-2 assertion (the window ended at 99), and a TypeScript error on `incompleteWindows` not existing on the returned object.

- [ ] **Step 3: Write the implementation**

Before (`registry/scripts/src/github-client.ts:151-170`):

```ts
/** Fetch one page of a windowed search. */
async function searchPage(
  query: string,
  page: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<RepoMeta[]> {
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`
  const response = await searchRequest(url, fetchImpl, sleep, token)
  if (!response.ok) throw new Error(`github search for ${query} failed: ${response.status}`)
  const body = await response.json() as { items?: unknown }
  const items = Array.isArray(body.items) ? body.items : []
  const metas: RepoMeta[] = []
  for (const item of items) {
    const meta = parseRepoMeta(item)
    if (meta !== null) metas.push(meta)
  }
  return metas
}
```

After:

```ts
/**
 * One page of a windowed search: the metas the schema trusts, the RAW item
 * count, and the API's own partial-results flag.
 */
interface SearchPageResult {
  metas: RepoMeta[]
  /**
   * `items.length` BEFORE {@link parseRepoMeta} filtered. The only count
   * that says whether the page was full: filtering first ended a 149-repo
   * window at 99 on one item with a non-string `default_branch`.
   */
  rawCount: number
  /** GitHub sets `incomplete_results` when the search timed out and the page
   * is partial. Read, because a 40-item partial page of a 900-repo window
   * otherwise reads as the end of the window. */
  incomplete: boolean
}

/** Fetch one page of a windowed search. */
async function searchPage(
  query: string,
  page: number,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<SearchPageResult> {
  const url = `${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&per_page=${SEARCH_PAGE_SIZE}&page=${page}`
  const response = await searchRequest(url, fetchImpl, sleep, token)
  if (!response.ok) throw new Error(`github search for ${query} failed: ${response.status}`)
  const body = await response.json() as { items?: unknown; incomplete_results?: unknown }
  const items = Array.isArray(body.items) ? body.items : []
  const metas: RepoMeta[] = []
  for (const item of items) {
    const meta = parseRepoMeta(item)
    if (meta !== null) metas.push(meta)
  }
  return { metas, rawCount: items.length, incomplete: body.incomplete_results === true }
}
```

Before (`registry/scripts/src/github-client.ts:256-287`):

```ts
/**
 * List every repository carrying one of the harvest topics, through the
 * partitioned windows. Deduplicated and sorted.
 * @returns the repos the search saw (with `pushedAt`), and the window count.
 */
export async function searchReposByTopic(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
): Promise<{ seen: RepoSeen[]; metas: Map<string, RepoMeta>; windowCount: number }> {
  const byName = new Map<string, RepoMeta>()
  let windowCount = 0
  for (const topic of HARVEST_TOPICS) {
    const windows = await partitionTopic(topic, query => probeTotal(query, fetchImpl, sleep, token))
    windowCount += windows.length
    for (const window of windows) {
      const query = windowQuery(topic, window)
      for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
        const metas = await searchPage(query, page, fetchImpl, sleep, token)
        for (const meta of metas) {
          if (!byName.has(meta.fullName)) byName.set(meta.fullName, meta)
        }
        if (metas.length < SEARCH_PAGE_SIZE) break
      }
    }
  }
  const seen = [...byName.entries()]
    .map(([repo, meta]) => ({ repo, pushedAt: meta.pushedAt }))
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
  return { seen, metas: byName, windowCount }
}
```

After:

```ts
/**
 * List every repository carrying one of the harvest topics, through the
 * partitioned windows. Deduplicated and sorted.
 * @returns the repos the search saw (with `pushedAt`), the window count, and
 *   `incompleteWindows` — every window whose enumeration is KNOWN to have
 *   dropped rows. That list is load-bearing: an under-enumerated pool would
 *   otherwise be read as "these repositories are gone".
 */
export async function searchReposByTopic(
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) },
  token: string | undefined = undefined,
): Promise<{ seen: RepoSeen[]; metas: Map<string, RepoMeta>; windowCount: number; incompleteWindows: string[] }> {
  const byName = new Map<string, RepoMeta>()
  const incompleteWindows: string[] = []
  let windowCount = 0
  for (const topic of HARVEST_TOPICS) {
    const windows = await partitionTopic(topic, query => probeTotal(query, fetchImpl, sleep, token))
    windowCount += windows.length
    for (const window of windows) {
      const query = windowQuery(topic, window)
      // Re-probed immediately before paging rather than reusing the
      // partition's total: the partition can be minutes old by the time the
      // last window is paged, and this number is what the reconciliation
      // below compares against, so a fresh one means fewer false alarms from
      // ordinary pool churn. One `per_page=1` request per window.
      const total = await probeTotal(query, fetchImpl, sleep, token)
      let rawSeen = 0
      let partial = false
      for (let page = 1; page <= MAX_SEARCH_PAGES; page += 1) {
        let result = await searchPage(query, page, fetchImpl, sleep, token)
        if (result.incomplete) {
          // One retry: a search timeout is usually transient. A page that
          // stays partial marks the window rather than being read as its end.
          result = await searchPage(query, page, fetchImpl, sleep, token)
          if (result.incomplete) partial = true
        }
        for (const meta of result.metas) {
          if (!byName.has(meta.fullName)) byName.set(meta.fullName, meta)
        }
        rawSeen += result.rawCount
        // The RAW count decides. `metas` has been filtered, and one item the
        // schema distrusts used to end a 149-repo window at 99.
        if (result.rawCount < SEARCH_PAGE_SIZE) break
      }
      // Paging a window must see at least as many items as the probe counted
      // seconds earlier. Fewer means rows were dropped between the two — a
      // partial page, a page the loop stopped short of, or the silent stop at
      // MAX_SEARCH_PAGES — and the pool this run enumerated is not the pool.
      if (rawSeen < total || partial) {
        incompleteWindows.push(`${query}: saw ${rawSeen} of ${total}${partial ? ', incomplete_results' : ''}`)
      }
    }
  }
  const seen = [...byName.entries()]
    .map(([repo, meta]) => ({ repo, pushedAt: meta.pushedAt }))
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
  return { seen, metas: byName, windowCount, incompleteWindows }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts` — Expected: PASS (the existing `searchReposByTopic` and `harvestRepos` tests all answer `total_count: 0` to probes, so the reconciliation cannot fire on them).
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/github-client.ts registry/scripts/tests/github-client.test.ts
git commit -m "fix(harvest): page on the raw item count and reconcile each window against its probe"
```

---

### Task 5: An incomplete enumeration reports nothing gone and loses nothing from the state

> **Outcome: MOOT, and not implementable on its own.** Verified 2026-09-04.
>
> Every step here consumes Task 4's `incompleteWindows`, which the shipped code
> never produces: plan A **throws** on an under-enumerated window instead. Under
> that throw the build dies before `harvestRepos` returns, so
> `repo-state.json` is never rewritten and no `repo-gone` is ever published —
> which is precisely the guarantee this task set out to add. Implementing it
> would mean first reverting plan A's throw to a report, i.e. applying the Task
> 4 regression documented above; on its own it adds a `pruneGone` parameter
> with no caller, an `incompleteWindows` field that is always `[]`, and a
> `gone: []` branch nothing can reach.
>
> Its argument deserves recording, because it is not obviously wrong: a short
> GitHub window costs the whole shelf a day, including a healthy npm half of
> ~9,500 entries. Two things answer it. CLAUDE.md states the doctrine for both
> halves — "A search that cannot enumerate its whole result set throws rather
> than truncating" — and a failed build publishes nothing, so yesterday's
> catalog stays live and the badge date stops advancing where a maintainer can
> see it. And the frequency argument is weaker than when this was written: the
> likeliest trigger, a transient `incomplete_results`, is now retried rather
> than thrown (Task 4's note). **This is a policy choice, not a fact** — moving
> to publish-short-and-report would be a coherent design, and it would start by
> amending that CLAUDE.md sentence.
>
> **What this task DID contribute, and what shipped instead:** its premise —
> that `repo-gone` is a published reason and emitting a false one is a defect —
> holds independently of enumeration, and reading it that way found a live one.
> The detail read *"The topic search no longer returns this repository (deleted,
> renamed, or private)"*, naming three causes and omitting the likeliest: the
> owner edited the repository's topics. That repository still exists, is public
> and was never renamed, so all three published causes were false for it — and
> it is the only one of the four its author can act on. The reason now also
> names topic removal, and it moved out of `build.ts` into `repo-state.ts`
> beside `diffRepoState`, the pure rule that decides a repo is gone: it was the
> only rejection reason minted in the shell, where nothing could test it.

**Files:**
- Modify: `registry/scripts/src/repo-state.ts:116-148` (`nextRepoState`)
- Modify: `registry/scripts/src/github-client.ts:582-605` (`RepoHarvestResult`) and `612-680` (`harvestRepos`)
- Modify: `registry/scripts/src/build.ts:127-136`
- Test: `registry/scripts/tests/repo-state.test.ts`, `registry/scripts/tests/github-client.test.ts`

**Interfaces:**
- Consumes: `searchReposByTopic`'s `incompleteWindows: string[]` from Task 4.
- Produces: `nextRepoState(state, seen, fetched, pruneGone = true)`; `RepoHarvestResult.incompleteWindows: string[]`; `harvestRepos` returns `gone: []` when the enumeration is incomplete.

`repo-gone` is a published rejection reason that says "deleted, renamed, or private". Emitting it because a search window came up short is exactly the class of defect CLAUDE.md calls a defect rather than a wording nit — so when the enumeration is known incomplete, no repo is called gone and no recorded repo is dropped from the state. The catalog keeps yesterday's candidates for those repos and the report says which windows were short. This is deliberately not a throw: the pool churns and the npm half of the catalog is fine, so refusing to publish would cost the whole shelf a day to protect a pruning step that can safely wait a run.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/repo-state.test.ts`:

```ts
describe('nextRepoState with pruning disabled', () => {
  const candidate = (repo: string): RepoCandidate => ({
    name: repo.split('/')[1] ?? repo,
    repo,
    commit: 'b'.repeat(40),
    version: 'b'.repeat(40),
    publishedAt: null,
    repository: `https://github.com/${repo}`,
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    catalog: null,
    description: 'x',
  })

  it('carries a recorded repo the search did not return, instead of dropping it', () => {
    // Dropping it is right when the enumeration is trustworthy: the repo
    // really is gone. It is wrong when a window under-enumerated, because
    // the repo then vanishes from the catalog for a day and comes back as
    // new tomorrow, re-consuming the fetch budget.
    const state: RepoState = {
      'a/seen': { pushedAt: '2026-08-01T00:00:00Z', commit: 'b'.repeat(40), candidates: [candidate('a/seen')] },
      'b/unseen': { pushedAt: '2026-08-01T00:00:00Z', commit: 'b'.repeat(40), candidates: [candidate('b/unseen')] },
    }
    const seen = [{ repo: 'a/seen', pushedAt: '2026-08-01T00:00:00Z' }]
    const kept = nextRepoState(state, seen, new Map(), false)
    expect(Object.keys(kept).sort()).toEqual(['a/seen', 'b/unseen'])
    expect(kept['b/unseen']?.candidates.map(c => c.repo)).toEqual(['b/unseen'])
    // The default still prunes: that is the whole point of the flag.
    expect(Object.keys(nextRepoState(state, seen, new Map()))).toEqual(['a/seen'])
  })
})
```

Append inside `describe('harvestRepos', ...)` in `registry/scripts/tests/github-client.test.ts`:

```ts
  it('reports no repo as gone and keeps its candidates when a window under-enumerated', async () => {
    // A window that saw 1 of 3 used to produce two `repo-gone` rejections
    // whose published reason ("deleted, renamed, or private") was false, and
    // `nextRepoState` dropped both repos, so they came back as new tomorrow.
    const state: RepoState = {
      'a/kept': entryOf('a/kept'),
      'b/kept': entryOf('b/kept'),
    }
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      const params = new URL(text).searchParams
      const primary = decodeURIComponent(params.get('q') ?? '').includes('topic:dsh-plugin')
      if (params.get('per_page') === '1') {
        return new Response(JSON.stringify({ total_count: primary ? 3 : 0 }), { status: 200 })
      }
      if (!primary) return new Response(JSON.stringify({ items: [] }), { status: 200 })
      return new Response(JSON.stringify({
        items: [{ full_name: 'a/kept', default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: '2026-08-01T00:00:00Z' }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await harvestRepos({ state, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.incompleteWindows).toHaveLength(1)
    expect(result.gone).toEqual([])
    expect(Object.keys(result.nextState).sort()).toEqual(['a/kept', 'b/kept'])
    expect(result.candidates.map(c => c.repo).sort()).toEqual(['a/kept', 'b/kept'])
  })

  it('still drops a gone repo when every window met its probe', async () => {
    const state: RepoState = { 'a/kept': entryOf('a/kept'), 'c/gone': entryOf('c/gone') }
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      const params = new URL(text).searchParams
      const primary = decodeURIComponent(params.get('q') ?? '').includes('topic:dsh-plugin')
      if (params.get('per_page') === '1') {
        return new Response(JSON.stringify({ total_count: primary ? 1 : 0 }), { status: 200 })
      }
      if (!primary) return new Response(JSON.stringify({ items: [] }), { status: 200 })
      return new Response(JSON.stringify({
        items: [{ full_name: 'a/kept', default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: '2026-08-01T00:00:00Z' }],
      }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await harvestRepos({ state, budget: 5, fetchImpl, sleep, token: 't' })
    expect(result.incompleteWindows).toEqual([])
    expect(result.gone).toEqual(['c/gone'])
    expect(Object.keys(result.nextState)).toEqual(['a/kept'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts -t "reports no repo as gone and keeps its candidates when a window under-enumerated"` — Expected: FAIL with `expected [ 'b/kept' ] to deeply equal []` on `result.gone`, plus a TypeScript error on `result.incompleteWindows`.

- [ ] **Step 3: Write the implementation**

Before (`registry/scripts/src/repo-state.ts:116-148`):

```ts
/**
 * Merge one run's results into the next state: fetched repos record their
 * fresh outcome (candidates or a failure); carried repos keep the recorded
 * one; gone repos drop.
 * @param state - the previous state.
 * @param seen - everything the search saw this run.
 * @param fetched - fresh outcomes this run produced, keyed by repo.
 */
export function nextRepoState(
  state: RepoState,
  seen: RepoSeen[],
  fetched: Map<string, { candidates: RepoCandidate[]; failure?: { code: 'no-manifest' | 'fetch-failed'; detail: string } }>,
): RepoState {
  const next: RepoState = {}
  for (const entry of seen) {
```

After:

```ts
/**
 * Merge one run's results into the next state: fetched repos record their
 * fresh outcome (candidates or a failure); carried repos keep the recorded
 * one; gone repos drop.
 * @param state - the previous state.
 * @param seen - everything the search saw this run.
 * @param fetched - fresh outcomes this run produced, keyed by repo.
 * @param pruneGone - whether a recorded repo the search did not return may
 *   be dropped. False when the enumeration is known incomplete (a window
 *   came up short of its probe, or a page stayed partial): a repo must never
 *   be forgotten on the strength of a sweep that dropped rows, or it
 *   vanishes from the catalog for a day and returns as new tomorrow,
 *   re-consuming the fetch budget.
 */
export function nextRepoState(
  state: RepoState,
  seen: RepoSeen[],
  fetched: Map<string, { candidates: RepoCandidate[]; failure?: { code: 'no-manifest' | 'fetch-failed'; detail: string } }>,
  pruneGone = true,
): RepoState {
  const next: RepoState = {}
  for (const entry of seen) {
```

Then, before the closing `return next` of the same function (after the `for (const entry of seen)` loop and its trailing comment at line 146):

```ts
  if (!pruneGone) {
    for (const [repo, recorded] of Object.entries(state)) {
      if (next[repo] === undefined) next[repo] = recorded
    }
  }
  return next
}
```

In `registry/scripts/src/github-client.ts`, add to `RepoHarvestResult` (after `windowCount` at line 601):

```ts
  /**
   * Windows whose enumeration is known to have dropped rows, one string per
   * window naming the query and the shortfall. Non-empty means `gone` is
   * empty and nothing was pruned from the state — the report says which.
   */
  incompleteWindows: string[]
```

In the no-token early return (line 621), add `incompleteWindows: []`:

```ts
    return { candidates: [], failures: [], seen: [], gone: [], nextState: state, skipped: true, searchStars: new Map(), windowCount: 0, incompleteWindows: [], fetched: 0, carried: 0, deferred: 0 }
```

Change the destructure (line 623) and the state merge (line 657) and the return (lines 667-679):

```ts
  const { seen, metas, windowCount, incompleteWindows } = await searchReposByTopic(fetchImpl, sleep, token)
```

```ts
  // An incomplete enumeration must not prune: `repo-gone` is a published
  // reason that says "deleted, renamed, or private", and a window that came
  // up short of its probe is no evidence of any of the three.
  const enumerationComplete = incompleteWindows.length === 0
  const nextState = nextRepoState(state, seen, fresh, enumerationComplete)
```

```ts
  return {
    candidates,
    failures,
    seen,
    gone: enumerationComplete ? gone : [],
    nextState,
    skipped: false,
    searchStars,
    windowCount,
    incompleteWindows,
    fetched: queue.length,
    carried,
    deferred: toFetch.length - queue.length,
  }
```

In `registry/scripts/src/build.ts`, before (lines 127-136):

```ts
  for (const repo of repos.gone) {
    rejections.push({
      name: repo,
      code: 'repo-gone',
      detail: 'The topic search no longer returns this repository (deleted, renamed, or private).',
    })
  }
  writeFileSync(repoStatePath, serializeRepoState(repos.nextState))
  repoNote = `${repos.windowCount} windows, ${repos.seen.length} repos seen, ${repos.fetched} fetched, ${repos.carried} carried, ${repos.deferred} deferred`
  process.stderr.write(`github: ${repoNote}\n`)
```

After:

```ts
  // Empty when the enumeration was incomplete: harvestRepos withholds `gone`
  // rather than letting a short window publish "deleted, renamed, or
  // private" about a repository that is none of those.
  for (const repo of repos.gone) {
    rejections.push({
      name: repo,
      code: 'repo-gone',
      detail: 'The topic search no longer returns this repository (deleted, renamed, or private).',
    })
  }
  writeFileSync(repoStatePath, serializeRepoState(repos.nextState))
  const repoParts = [`${repos.windowCount} windows`, `${repos.seen.length} repos seen`, `${repos.fetched} fetched`, `${repos.carried} carried`, `${repos.deferred} deferred`]
  if (repos.incompleteWindows.length > 0) {
    repoParts.push(`${repos.incompleteWindows.length} window(s) incomplete, so nothing was pruned: ${repos.incompleteWindows.join('; ')}`)
  }
  repoNote = repoParts.join(', ')
  process.stderr.write(`github: ${repoNote}\n`)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts registry/scripts/tests/repo-state.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/repo-state.ts registry/scripts/src/github-client.ts registry/scripts/src/build.ts registry/scripts/tests/repo-state.test.ts registry/scripts/tests/github-client.test.ts
git commit -m "fix(harvest): an incomplete enumeration prunes nothing and reports which windows were short"
```

---

### Task 6: Catch the search body's parse, and cap every JSON body

> **Outcome: first half ALREADY DONE by plan A; second half SHIPPED, but by
> extracting the existing reader rather than writing the third copy this task
> asks for.** Verified 2026-09-04.
>
> **Catching the search body's parse** is done: `npm-client.ts`'s own
> `readSearchBody` names the keyword and the `from`, rethrows a
> `FetchTimeoutError` untouched because a deadline is not a malformed body, and
> separately refuses a body that parses but is not a search response (a bare
> `null` satisfies the cast structurally). Its wording is `at from=0 ... not a
> search response`, not this task's `page 0 ... unreadable`; an existing test
> pins it, so the sentences below are stale and were not applied.
>
> **The caps were genuinely missing**, and the asymmetry was as described:
> github-client capped every body it read while npm-client capped none, across
> one packument per harvested name plus every search page — and
> `fetchWithFailover` serves those from `NPM_BACKUP_REGISTRY`,
> registry.npmmirror.com by default, whenever the primary throws, stalls or
> 5xxs. `MAX_SEARCH_BODY_BYTES` (8 MB, throws) and `MAX_PACKUMENT_BYTES`
> (16 MB, a `fetch-failed` row) shipped with the split consequence this task
> argued for.
>
> **What changed from the plan:** Step 3 says to write `readJsonCapped` with
> the "Same shape as `readTarballBody` in github-client.ts". That reader's own
> doc comment is an argument against doing so: *"It is shared rather than
> written twice because the two readers had already drifted apart in the way
> that matters"* — one cancelled at the cap while the other bought the whole
> body and then measured it. A third copy would repeat the mistake the comment
> records. `readCappedBody` moved to `http-body.ts` instead and both clients
> import it; `readJsonCapped` is a thin JSON wrapper over it. The plan's
> content-length check survives as an early refusal only, never the
> measurement — a compressed body's header understates what it decodes to,
> which is the same reason the github reader counts bytes as they arrive.
>
> The guard test that enforces this got stronger rather than weaker: it was
> anchored to `github-client.ts` and would have gone green the moment the
> reader left that file, while npm-client — the module that had never capped
> anything — was never scanned at all. It now scans every module that reads a
> body. Both directions are mutation-checked.

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (new constants and `readJsonCapped` after `fetchWithRetry` at line 160; `searchByKeywords:301`; `fetchCandidate:342-349`)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MAX_SEARCH_BODY_BYTES = 8 * 1024 * 1024`, `MAX_PACKUMENT_BYTES = 16 * 1024 * 1024`. `fetchCandidate`'s parse-failure detail keeps the word `unreadable`, which `npm-client.test.ts:516` asserts.

The caps, and why these numbers. A search page carries `size=250` objects of registry metadata, about 500 KB live, so **8 MB** is sixteen times the observed size and still refuses a body no search page can legitimately produce. A packument is capped at **16 MB**, half the tarball reader's `MAX_TARBALL_BYTES`: a dsh plugin's packument is tens of kilobytes, and the largest packuments on npm at all — thousands of versions of a monolith — sit near this figure, so nothing a plugin author can publish reaches it. Over-cap outcomes differ by what the caller can do: an unusable packument becomes a `fetch-failed` row (nothing disappears without a reason attached to its name), while an unusable search page throws, because a keyword search that cannot complete would otherwise silently shrink the candidate set.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/npm-client.test.ts` (add `MAX_PACKUMENT_BYTES` and `MAX_SEARCH_BODY_BYTES` to the import on line 2):

```ts
describe('body bounds', () => {
  const packument = {
    name: 'dsh-hello-plugin',
    'dist-tags': { latest: '1.2.0' },
    time: { '1.2.0': '2026-08-01T12:00:00.000Z' },
    versions: { '1.2.0': { dist: { integrity: 'sha512-hello' }, license: 'MIT', dsh: { bundle: {} } } },
  }

  it('names the keyword and the page when a search answers 200 with a body it cannot parse', async () => {
    // Observed live: page 13 of keywords:dsh-plugin returned `<!doctype
    // html>` and the build died with a bare SyntaxError naming nothing. The
    // page cannot be read as empty either — ending the keyword there would
    // silently shrink the pool, which is indistinguishable from an empty
    // ecosystem.
    const fetchImpl = (async () => new Response('<!doctype html><html>proxy error</html>', { status: 200 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(/keywords:dsh-plugin page 0.*unreadable/s)
  })

  it('refuses a search page whose content-length exceeds the cap, before reading a byte', async () => {
    let read = false
    const fetchImpl = (async () => {
      read = true
      return new Response('{"objects":[]}', {
        status: 200,
        headers: { 'content-length': String(MAX_SEARCH_BODY_BYTES + 1) },
      })
    }) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(new RegExp(`keywords:dsh-plugin page 0.*${MAX_SEARCH_BODY_BYTES}`, 's'))
    expect(read).toBe(true) // the request happened; the BODY did not
  })

  it('refuses a streamed search page that exceeds the cap mid-download', async () => {
    // No content-length, so the cap has to trip on the reader. The stream
    // never ends on its own: if the cap were not enforced this test hangs.
    const chunk = new Uint8Array(1024 * 1024)
    const fetchImpl = (async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(chunk) },
    }), { status: 200 })) as unknown as typeof fetch
    await expect(searchByKeywords(fetchImpl)).rejects.toThrow(new RegExp(String(MAX_SEARCH_BODY_BYTES)))
  })

  it('turns an over-cap packument into a fetch-failed reason, not a crash', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(packument), {
      status: 200,
      headers: { 'content-length': String(MAX_PACKUMENT_BYTES + 1) },
    })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-enormous', fetchImpl)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.detail).toContain('dsh-enormous')
    expect(!result.ok && result.detail).toContain(String(MAX_PACKUMENT_BYTES))
  })

  it('still reads a packument under the cap', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(packument), { status: 200 })) as unknown as typeof fetch
    const result = await fetchCandidate('dsh-hello-plugin', fetchImpl)
    expect(result.ok).toBe(true)
    expect(result.ok && result.candidate.version).toBe('1.2.0')
  })

  it('caps a packument below the tarball reader and a search page below that', () => {
    // The relationship is the justification: a packument may be large, a
    // search page cannot be, and neither may approach the 32 MB a tarball is
    // allowed.
    expect(MAX_SEARCH_BODY_BYTES).toBeLessThan(MAX_PACKUMENT_BYTES)
    expect(MAX_PACKUMENT_BYTES).toBe(16 * 1024 * 1024)
    expect(MAX_SEARCH_BODY_BYTES).toBe(8 * 1024 * 1024)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "names the keyword and the page when a search answers 200 with a body it cannot parse"` — Expected: FAIL with `expected promise to reject with /keywords:dsh-plugin page 0.*unreadable/ but it rejected with SyntaxError: Unexpected token '<', "<!doctype "... is not valid JSON` — the bare SyntaxError naming no keyword. Collection also fails on the two missing exports.

- [ ] **Step 3: Write the implementation**

Insert into `registry/scripts/src/npm-client.ts` after `fetchWithRetry` (line 160):

```ts
/**
 * Byte cap on one search page's JSON body. A page carries `size=250` objects
 * of registry metadata — about 500 KB live — so this is sixteen times the
 * observed size and still refuses a body no search page can legitimately
 * produce. Unbounded before this: `response.json()` buffers whatever the
 * origin sends, and the origin can be a third-party mirror.
 */
export const MAX_SEARCH_BODY_BYTES = 8 * 1024 * 1024

/**
 * Byte cap on one packument. Half the tarball reader's 32 MB: a dsh plugin's
 * packument is tens of kilobytes, and the largest packuments on npm at all —
 * thousands of versions of a monolith — sit near this figure, so nothing a
 * plugin author can publish reaches it. An over-cap body becomes a
 * `fetch-failed` row like any other unusable response.
 */
export const MAX_PACKUMENT_BYTES = 16 * 1024 * 1024

/**
 * Read a response body as JSON under a hard byte cap.
 *
 * `response.json()` buffers the whole body before parsing, so a hostile or
 * broken origin can spend the build's memory before any of our code sees a
 * byte. A `content-length` over the cap is refused before the first read; a
 * streamed body is pulled through a reader and cancelled the moment the cap
 * trips. Same shape as `readTarballBody` in github-client.ts.
 *
 * The failure is returned, never thrown: the two callers want different
 * consequences from the same fact.
 */
async function readJsonCapped(
  response: Response,
  cap: number,
): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > cap) {
    return { ok: false, detail: `response body is ${length} bytes, over the ${cap}-byte cap` }
  }
  let text: string
  const body = response.body
  if (body == null) {
    // No readable stream (a fixture that only fakes `text()`): the
    // content-length check above already bounded the body.
    text = await response.text()
  } else {
    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > cap) {
          // Stop pulling the rest: over the cap, refuse.
          await reader.cancel()
          return { ok: false, detail: `response body exceeded the ${cap}-byte cap` }
        }
        chunks.push(value)
      }
    } finally {
      reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    text = new TextDecoder().decode(bytes)
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown }
  } catch (error) {
    // "unreadable" is load-bearing wording: it is what fetchCandidate has
    // always reported for an unparseable body, and a test pins it.
    return { ok: false, detail: `response body was unreadable (${error instanceof Error ? error.message : String(error)})` }
  }
}
```

Before (`registry/scripts/src/npm-client.ts:299-306`):

```ts
      const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
      if (!response.ok) throw new Error(`npm search for keywords:${keyword} failed: ${response.status}`)
      const body = await response.json() as { objects?: { package?: { name?: unknown } }[] }
      const objects = body.objects ?? []
      for (const object of objects) {
        if (typeof object.package?.name === 'string') seen.add(object.package.name)
      }
      if (objects.length < PAGE_SIZE) break
```

After:

```ts
      const response = await fetchWithFailover(path, fetchImpl, sleep, token, backupRegistry, timeoutMs)
      if (!response.ok) throw new Error(`npm search for keywords:${keyword} failed: ${response.status}`)
      const parsed = await readJsonCapped(response, MAX_SEARCH_BODY_BYTES)
      if (!parsed.ok) {
        // A 200 whose body cannot be read is not an empty page. Ending the
        // keyword here would silently shrink the candidate set, which is
        // indistinguishable from an empty ecosystem — and the bare
        // SyntaxError this replaces named neither the keyword nor the page
        // (observed live: page 13 of keywords:dsh-plugin answered
        // `<!doctype html>`).
        throw new Error(`npm search for keywords:${keyword} page ${page}: ${parsed.detail}`)
      }
      const body = parsed.value as { objects?: { package?: { name?: unknown } }[] }
      const objects = body.objects ?? []
      for (const object of objects) {
        if (typeof object.package?.name === 'string') seen.add(object.package.name)
      }
      if (objects.length < PAGE_SIZE) break
```

Before (`registry/scripts/src/npm-client.ts:340-352`):

```ts
  const response = await fetchWithFailover(encodeURIComponent(name), fetchImpl, sleep, token, backupRegistry, timeoutMs)
  if (!response.ok) return { ok: false, detail: `npm registry returned ${response.status} fetching ${name}` }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    // response.json() throws on a body that is not valid JSON; recorded as a
    // rejection like any other unusable response, rather than aborting the build.
    return { ok: false, detail: `${name}: response body was unreadable` }
  }
  const candidate = toCandidate(body)
  if (candidate === null) return { ok: false, detail: `${name}: packument names no usable latest version` }
  return { ok: true, candidate }
```

After:

```ts
  const response = await fetchWithFailover(encodeURIComponent(name), fetchImpl, sleep, token, backupRegistry, timeoutMs)
  if (!response.ok) return { ok: false, detail: `npm registry returned ${response.status} fetching ${name}` }
  // An unparseable body and an over-cap body are the same kind of fact: this
  // response cannot become a candidate. Both become a `fetch-failed` row with
  // the reason attached to the package's name, never an aborted build.
  const parsed = await readJsonCapped(response, MAX_PACKUMENT_BYTES)
  if (!parsed.ok) return { ok: false, detail: `${name}: ${parsed.detail}` }
  const candidate = toCandidate(parsed.value)
  if (candidate === null) return { ok: false, detail: `${name}: packument names no usable latest version` }
  return { ok: true, candidate }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts` — Expected: PASS, including the pre-existing `reports a body that cannot be parsed as JSON as a rejection, not a thrown error` at line 514, whose `toContain('unreadable')` the new wording preserves.
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "fix(npm): name the keyword on an unreadable search body and cap every JSON read"
```

---

### Task 7: A malformed `REPO_BACKFILL_BUDGET` throws instead of harvesting nothing

> **Outcome: DONE as written.** The defect was still live at `build.ts:137`,
> and all three fail-open modes were reproduced before the fix: `slice(0, NaN)`
> is `[]`, `Number('')` is `0`, and `slice(0, -1)` counts from the END — so a
> negative budget fetched all-but-one rather than the one it looks like.
>
> One addition beyond the steps: the `2000` default became
> `REPO_BACKFILL_BUDGET_DEFAULT`, exported beside the parser, so the shell
> carries no bare policy literal. A sweep for the same pattern elsewhere found
> no other numeric environment parse in `registry/scripts/src`.

**Files:**
- Modify: `registry/scripts/src/github-client.ts` (add `parseHarvestBudget` beside `RepoHarvestOptions`, after line 580)
- Modify: `registry/scripts/src/build.ts:105`
- Test: `registry/scripts/tests/github-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseHarvestBudget(raw: string | undefined, fallback: number): number`. Task 8 passes its result through the shared options object.

The parse is exported rather than inlined in `build.ts` because `build.ts` is a top-level-await script with no test seam, and this is the one decision in that line worth pinning: `Number('abc')` is `NaN`, `[...].slice(0, NaN)` is `[]`, so a typo used to fetch nothing and report `0 fetched` as a success. It lives in `github-client.ts` because the budget is that module's knob, next to `MAX_TARBALL_BYTES` and `REPO_CONCURRENCY`; the function itself is pure and tested, which is what CLAUDE.md's rule about policy in the shell is protecting.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/github-client.test.ts` (add `parseHarvestBudget` to the import on line 3):

```ts
describe('parseHarvestBudget', () => {
  it('reads a plain integer', () => {
    expect(parseHarvestBudget('500', 2000)).toBe(500)
  })

  it('falls back when the variable is unset', () => {
    expect(parseHarvestBudget(undefined, 2000)).toBe(2000)
  })

  it('accepts zero — a deliberate "search only, fetch nothing" run', () => {
    expect(parseHarvestBudget('0', 2000)).toBe(0)
  })

  it('throws on a value Number() would turn into NaN, naming the variable', () => {
    // `Number('abc')` is NaN and `[...].slice(0, NaN)` is `[]`, so this used
    // to fetch nothing at all and print "0 fetched" without an error — a
    // silent full stop on the GitHub half of the harvest.
    expect(() => parseHarvestBudget('abc', 2000)).toThrow(/REPO_BACKFILL_BUDGET.*"abc"/)
  })

  it('throws on an empty string, a negative number and a fraction', () => {
    // `Number('')` is 0, which would silently disable the harvest rather
    // than fail; a negative slice length counts from the end; a fraction is
    // a typo in a count.
    for (const raw of ['', '-1', '1.5', ' ']) {
      expect(() => parseHarvestBudget(raw, 2000), `${JSON.stringify(raw)} must throw`).toThrow(/REPO_BACKFILL_BUDGET/)
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts -t "throws on a value Number() would turn into NaN"` — Expected: FAIL at collection with `parseHarvestBudget is not exported by registry/scripts/src/github-client.ts`.

- [ ] **Step 3: Write the implementation**

Insert into `registry/scripts/src/github-client.ts` after the `RepoHarvestOptions` interface (line 580):

```ts
/**
 * Parse the per-run fetch budget from its environment string.
 *
 * `Number()` fails open in three ways that all end in a silent no-harvest:
 * `Number('abc')` is `NaN` and `[...].slice(0, NaN)` is `[]`, `Number('')`
 * is `0`, and a negative length makes `slice` count from the end. The old
 * line did all three and reported `0 fetched` as a success.
 * @param raw - the environment value, or undefined when unset.
 * @param fallback - the budget to use when the variable is unset.
 * @throws when the value is present but not a non-negative integer.
 */
export function parseHarvestBudget(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const budget = Number(raw)
  if (!Number.isInteger(budget) || budget < 0 || raw.trim() === '') {
    throw new Error(`REPO_BACKFILL_BUDGET must be a non-negative integer; got ${JSON.stringify(raw)}`)
  }
  return budget
}
```

Before (`registry/scripts/src/build.ts:105`):

```ts
  const budget = Number(process.env.REPO_BACKFILL_BUDGET ?? '2000')
```

After:

```ts
  const budget = parseHarvestBudget(process.env.REPO_BACKFILL_BUDGET, 2000)
```

And extend the import on `registry/scripts/src/build.ts:20`:

```ts
import { harvestRepos, parseHarvestBudget } from './github-client.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts -t "parseHarvestBudget"` — Expected: PASS (5 tests).
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/github-client.ts registry/scripts/src/build.ts registry/scripts/tests/github-client.test.ts
git commit -m "fix(harvest): a malformed REPO_BACKFILL_BUDGET throws instead of fetching nothing"
```

---

### Task 8: The whole-harvest retry cannot change the harvest's shape

> **Outcome: DONE, minus the Task 5 dependency.** The defect was live exactly
> as described: `build.ts` re-called `harvestRepos` without
> `probeSubpackages`, this module defaults it to `true`, and
> `schemaVersion` kept following the env flag — so a retried harvest emitted
> `subdir` entries under schemaVersion 3, which a v3 client ignores while
> installing the monorepo root. Only the retry path could produce it, which is
> why nothing ever saw it.
>
> `RepoHarvestResult.incompleteWindows` is NOT part of this: Task 5 is moot
> (see its note). `retryAfterMs` and `firstAttemptError` shipped as specified.
> The mutation that reintroduces the original defect — the retry rebuilding its
> options without `probeSubpackages` — is checked, and the fixture reads the
> option back off the retry through the git/trees probe, which fires if and only
> if probing is on.
>
> One fixture correction worth recording: a 5xx does not drive this test.
> `fetchRobust` retries a thrown request four times, so a 503 search is
> absorbed WITHIN one harvest attempt and never reaches the whole-harvest
> retry — the first version of the fixture passed against the unfixed code for
> that reason. A non-ok status is returned rather than thrown, so a 404 raises
> exactly once, which is what makes the attempt fail.

**Files:**
- Modify: `registry/scripts/src/github-client.ts:568-680` (options, result, and the split of `harvestRepos` into a retry wrapper over `harvestOnce`)
- Modify: `registry/scripts/src/build.ts:110-121`
- Test: `registry/scripts/tests/github-client.test.ts`

**Interfaces:**
- Consumes: `RepoHarvestResult.incompleteWindows` from Task 5; `parseHarvestBudget` from Task 7.
- Produces: `RepoHarvestOptions.retryAfterMs?: number`; `RepoHarvestResult.firstAttemptError: string | null`. `build.ts` no longer wraps the call in a try/catch.

The retry moves *into* `harvestRepos` rather than being fixed by "one options object" in `build.ts`. The defect exists because the retry lived outside the function that owns the options: `build.ts:120` re-called `harvestRepos({ state, budget, fetchImpl, token: ghToken })` without `probeSubpackages`, `harvestRepos` defaults it to `true`, and `schemaVersion` follows the env flag — so with `SHOP_HARVEST_SUBPACKAGES` unset a retried harvest emitted `subdir` entries under schemaVersion 3, which a v3 client silently misinstalls as the monorepo root. With the retry inside, there is one call site and one options object, and the bug class is structurally impossible rather than merely fixed. The retry is opt-in (`retryAfterMs`) so a unit test never retries by accident and mask a failure.

- [ ] **Step 1: Write the failing test**

Append inside `describe('harvestRepos', ...)` in `registry/scripts/tests/github-client.test.ts`:

```ts
  it('retries the whole harvest once after a pause and keeps probeSubpackages off on the retry', async () => {
    // The retry used to be in build.ts and rebuilt the options by hand,
    // omitting `probeSubpackages`; harvestRepos defaults it to true while
    // `schemaVersion` follows the env flag, so a retried harvest emitted
    // `subdir` entries under schemaVersion 3 — the misinstall the file's own
    // comment warns about. The bundle-less monorepo root below is the shape
    // that would trigger a subpackage probe if the flag were lost.
    const namedRoot = JSON.stringify({ name: 'monorepo-root', private: true, workspaces: ['packages/*'] })
    const delays: number[] = []
    let searchCalls = 0
    const fetchImpl = (async (url: string | URL) => {
      const text = String(url)
      if (text.includes('/git/trees/')) throw new Error('tree must not be fetched: probeSubpackages was lost on the retry')
      if (text.includes('/search/repositories')) {
        searchCalls += 1
        // fetchRobust retries a network throw four times before it
        // propagates, so the first whole attempt needs four failures.
        if (searchCalls <= 4) throw new Error('UND_ERR_HEADERS_TIMEOUT')
        const params = new URL(text).searchParams
        if (params.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 1 }), { status: 200 })
        return new Response(JSON.stringify({
          items: [{ full_name: 's/monorepo', default_branch: 'main', description: null, license: { spdx_id: 'MIT' }, pushed_at: '2026-08-02T00:00:00Z' }],
        }), { status: 200 })
      }
      if (text.includes('/commits/main')) {
        return new Response(JSON.stringify({ sha: commit, commit: { author: { date: '2026-08-02T00:00:00.000Z' } } }), { status: 200 })
      }
      if (text.includes('/package.json')) return new Response(namedRoot, { status: 200 })
      throw new Error(`unrouted: ${text}`)
    }) as unknown as typeof fetch

    const result = await harvestRepos({
      state: {},
      budget: 5,
      fetchImpl,
      sleep: async (ms: number) => { delays.push(ms) },
      token: 't',
      probeSubpackages: false,
      retryAfterMs: 30_000,
    })
    expect(delays).toContain(30_000)
    expect(result.firstAttemptError).toContain('UND_ERR_HEADERS_TIMEOUT')
    expect(result.candidates.map(c => c.name)).toEqual(['monorepo-root'])
    expect(result.candidates[0]?.subdir).toBeUndefined()
  })

  it('does not retry when no retryAfterMs is given, and reports no first-attempt error', async () => {
    // Opt-in, so a unit test cannot silently pass on a second attempt.
    const fetchImpl = (async () => { throw new Error('UND_ERR_HEADERS_TIMEOUT') }) as unknown as typeof fetch
    await expect(harvestRepos({ state: {}, budget: 1, fetchImpl, sleep, token: 't' }))
      .rejects.toThrow(/UND_ERR_HEADERS_TIMEOUT/)
  })

  it('reports no first-attempt error on a clean run', async () => {
    const fetchImpl = (async (url: string | URL) => {
      const params = new URL(String(url)).searchParams
      if (params.get('per_page') === '1') return new Response(JSON.stringify({ total_count: 0 }), { status: 200 })
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as unknown as typeof fetch
    const result = await harvestRepos({ state: {}, budget: 1, fetchImpl, sleep, token: 't', retryAfterMs: 30_000 })
    expect(result.firstAttemptError).toBeNull()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts -t "retries the whole harvest once after a pause"` — Expected: FAIL with `expected [ 2000, 4000, 8000 ] to include 30000` (no retry exists inside the function), plus a TypeScript error on the unknown `retryAfterMs` option.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/github-client.ts`, add to `RepoHarvestOptions` (after `probeSubpackages` at line 579):

```ts
  /**
   * When set, one whole-harvest retry after this pause. The GitHub half runs
   * through shared CI egress whose throttles outlast the per-request
   * backoffs, and a second failure should kill the build loudly — a
   * half-harvested catalog is worse than a red one.
   *
   * The retry lives HERE rather than at the call site because the call site
   * rebuilt the options by hand and dropped `probeSubpackages`, so a retried
   * harvest emitted `subdir` entries under a schemaVersion that cannot
   * describe them. One options object, one call site, no way to differ.
   */
  retryAfterMs?: number
```

Add to `RepoHarvestResult` (after `incompleteWindows` from Task 5):

```ts
  /**
   * The first attempt's failure when {@link RepoHarvestOptions.retryAfterMs}
   * was set and the retry succeeded; null otherwise. Returned rather than
   * logged so this module stays free of `process`.
   */
  firstAttemptError: string | null
```

Rename the existing exported function's declaration (line 612) and make it module-private:

Before:

```ts
/**
 * Harvest every repository candidate for the topics: partition the search,
 * diff against the recorded state, re-fetch only new or changed repos (up to
 * the budget), and carry the untouched candidates over.
 */
export async function harvestRepos(options: RepoHarvestOptions): Promise<RepoHarvestResult> {
```

After:

```ts
/**
 * One harvest attempt: partition the search, diff against the recorded
 * state, re-fetch only new or changed repos (up to the budget), and carry
 * the untouched candidates over. {@link harvestRepos} wraps this with the
 * optional retry.
 */
async function harvestOnce(options: RepoHarvestOptions): Promise<RepoHarvestResult> {
```

Add `firstAttemptError: null` to both of `harvestOnce`'s returns — the skipped early return (line 621) and the final one:

```ts
    return { candidates: [], failures: [], seen: [], gone: [], nextState: state, skipped: true, searchStars: new Map(), windowCount: 0, incompleteWindows: [], firstAttemptError: null, fetched: 0, carried: 0, deferred: 0 }
```

```ts
    windowCount,
    incompleteWindows,
    firstAttemptError: null,
    fetched: queue.length,
```

Then append the new exported wrapper after `harvestOnce`:

```ts
/**
 * Harvest every repository candidate for the topics, with one optional
 * whole-harvest retry.
 *
 * Both attempts receive the SAME options object. That is the point: the
 * retry used to be a second hand-written call in `build.ts` that omitted
 * `probeSubpackages`, and a retried harvest therefore emitted `subdir`
 * entries under schemaVersion 3.
 */
export async function harvestRepos(options: RepoHarvestOptions): Promise<RepoHarvestResult> {
  const { retryAfterMs, sleep = async (ms: number) => { await new Promise(resolve => setTimeout(resolve, ms)) } } = options
  if (retryAfterMs === undefined) return await harvestOnce(options)
  try {
    return await harvestOnce(options)
  } catch (error) {
    await sleep(retryAfterMs)
    const result = await harvestOnce(options)
    return { ...result, firstAttemptError: error instanceof Error ? error.message : String(error) }
  }
}
```

Before (`registry/scripts/src/build.ts:110-121`):

```ts
  let repos: Awaited<ReturnType<typeof harvestRepos>>
  try {
    repos = await harvestRepos({ state: repoState, budget, fetchImpl: fetch, token: ghToken, probeSubpackages })
  } catch (error) {
    // One whole-harvest retry after a pause: the GitHub half runs through
    // shared egress whose throttles outlast the per-request backoffs. A
    // second failure kills the build loudly — a half-harvested catalog is
    // worse than a red one, and the daily workflow retries next run.
    process.stderr.write(`github: first attempt failed (${error instanceof Error ? error.message : String(error)}); retrying once after 30s\n`)
    await new Promise(resolve => setTimeout(resolve, 30_000))
    repos = await harvestRepos({ state: repoState, budget, fetchImpl: fetch, token: ghToken })
  }
```

After:

```ts
  // The retry lives inside harvestRepos, which re-uses these exact options.
  // It used to live here and rebuilt them by hand without `probeSubpackages`,
  // so a retried harvest emitted `subdir` entries under a schemaVersion that
  // cannot describe them.
  const repos = await harvestRepos({
    state: repoState,
    budget,
    fetchImpl: fetch,
    token: ghToken,
    probeSubpackages,
    retryAfterMs: 30_000,
  })
  if (repos.firstAttemptError !== null) {
    process.stderr.write(`github: first attempt failed (${repos.firstAttemptError}); the retry after 30s succeeded\n`)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/github-client.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/github-client.ts registry/scripts/src/build.ts registry/scripts/tests/github-client.test.ts
git commit -m "fix(harvest): the whole-harvest retry reuses one options object"
```

---

### Task 9: The stars sidecar is built from accepted entries by a pure serialiser

> **Outcome: DONE, all three parts.** The waste was re-measured against the
> live artifacts on 2026-09-04 rather than taken from this plan: of 16,879
> sidecar keys, **7,624 (45%) are not catalog entries** — about 252 KB of the
> 602 KB every reader downloads. (This plan said 7,553 of 16,714 and ~265 KB of
> 596 KB; the catalog has grown since, and the figure tracks the ecosystem, so
> re-measure rather than trusting either.)
>
> **One correction to the produced interface.** `selectEntries` takes `builtAt`
> as a fourth parameter, which the plan's signature omits. It cannot be left
> out: `added` is the date an identity first reached the catalog, so the tiering
> needs the build date, and the alternative — reading a clock inside a pure
> module — is the thing CLAUDE.md forbids. `build.ts`'s single clock read moved
> above the stars step instead, so it is still read exactly once.
>
> **One extra fix, found while rewriting.** The tally was per-candidate while
> the keys are per-repository, so a monorepo contributing three plugin
> subpackages produced one key and a tally of three: the build note read
> `1 starred (3 from the search, 0 from GraphQL)`, a line contradicting its own
> count. Reproduced against the old function before changing it. Each key is
> now tallied once.

**Files:**
- Modify: `registry/scripts/src/stars-assemble.ts` (add `assembleStarsForEntries`, `SerializedStars`, `serializeStars`)
- Modify: `registry/scripts/src/pipeline.ts:24-63` (extract `selectEntries`)
- Modify: `registry/scripts/src/build.ts:139-229`
- Test: `registry/scripts/tests/stars-assemble.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `selectEntries(candidates: Candidate[], repoCandidates: RepoCandidate[], config: RegistryConfig, preexistingRejections?: Rejection[]): { entries: Entry[]; rejections: Rejection[] }`
  - `assembleStarsForEntries(entries: Entry[], searchStars: Map<string, number>, graphqlStars: Map<string, number>): AssembledStars`
  - `SerializedStars { fileName: string; json: string; sha256: string }` and `serializeStars(assembled: AssembledStars): SerializedStars`
  - `runPipeline`'s signature is unchanged, and `assembleStarsByKey` is deleted.

Three things move. The sidecar is keyed by the harvest today, not by the catalog: 7,553 of the live sidecar's 16,714 keys are not catalog entries — about 265 KB of 596 KB that every reader downloads. The sort, the `Object.fromEntries`, the sha256 and the file name were four lines of policy inside `build.ts` with no test at all. And because the accepted entries are now known before the network step, the GraphQL ask narrows from every candidate to every listed entry, which is a straight saving of quota points on packages that will not be published.

**The cost, stated:** the gate runs twice per build — once through `selectEntries` for the sidecar, once inside `runPipeline` for the artifacts. Both passes are pure and deterministic over the same inputs, they do no I/O, and the work is a levenshtein sweep against `verified.yml`, which holds zero rows today. The alternative — `build.ts` calling `selectEntries` and `emit` directly and skipping `runPipeline` — was rejected because it would leave `runPipeline` exercised only by tests, which is the class of defect audit H exists to catch.

- [ ] **Step 1: Write the failing test**

Replace `registry/scripts/tests/stars-assemble.test.ts` entirely (the `assembleStarsByKey` describe goes with the function it tests; the `npm`/`repo` candidate helpers go with it):

```ts
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseRegistryConfig } from '../src/config.ts'
import { selectEntries } from '../src/pipeline.ts'
import { assembleStarsForEntries, serializeStars, type AssembledStars } from '../src/stars-assemble.ts'
import type { Candidate, Entry } from '../src/types.ts'

function npmEntry(name: string, repository: string): Entry {
  return {
    name, version: '1.0.0', integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository, license: 'MIT', tier: 'community', metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'npm', added: '2026-08-01',
  }
}

function repoEntry(name: string, repo: string, subdir?: string): Entry {
  return {
    name, version: 'b'.repeat(40), integrity: 'b'.repeat(40), publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/${repo}`, license: 'MIT', tier: 'community', metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'github', repo, ...(subdir === undefined ? {} : { subdir }), added: '2026-08-01',
  }
}

describe('assembleStarsForEntries', () => {
  it('prefers the search count, keys npm entries by name and github entries by repo', () => {
    const assembled = assembleStarsForEntries(
      [npmEntry('pkg-a', 'https://github.com/o/a'), npmEntry('pkg-b', 'https://github.com/o/not-seen'), repoEntry('bundle-a', 'o/a')],
      new Map([['o/a', 42]]),
      new Map([['o/a', 99], ['o/not-seen', 7]]),
    )
    expect(assembled.stars).toEqual({ 'pkg-a': 42, 'pkg-b': 7, 'o/a': 42 })
    expect(assembled.fromSearch).toBe(2)
    expect(assembled.fromGraphql).toBe(1)
  })

  it('keeps a zero count — zero is a real star count', () => {
    const assembled = assembleStarsForEntries([npmEntry('pkg-a', 'https://github.com/o/a')], new Map([['o/a', 0]]), new Map([['o/a', 5]]))
    expect(assembled.stars).toEqual({ 'pkg-a': 0 })
    expect(assembled.fromSearch).toBe(1)
  })

  it('drops an entry with no count in either source, and a non-github repository url', () => {
    const assembled = assembleStarsForEntries(
      [npmEntry('pkg-a', 'https://gitlab.com/o/a'), npmEntry('pkg-b', 'https://github.com/o/missing')],
      new Map(), new Map(),
    )
    expect(assembled.stars).toEqual({})
    expect(assembled.fromSearch).toBe(0)
    expect(assembled.fromGraphql).toBe(0)
  })

  it('never attributes the harness own stars to an npm entry claiming it as its repository', () => {
    const assembled = assembleStarsForEntries(
      [npmEntry('pkg-mos', 'https://github.com/deepseek-ai/deepseek-harness')],
      new Map([['deepseek-ai/deepseek-harness', 205302]]), new Map(),
    )
    expect(assembled.stars).toEqual({})
  })

  it('keeps the count for a repo entry that is the harness itself', () => {
    // The skip is for misdeclared npm repositories; a github entry keyed by
    // the harness's own full name carries its own, factually correct count.
    const assembled = assembleStarsForEntries(
      [repoEntry('harness-bundle', 'deepseek-ai/deepseek-harness')],
      new Map([['deepseek-ai/deepseek-harness', 205302]]), new Map(),
    )
    expect(assembled.stars).toEqual({ 'deepseek-ai/deepseek-harness': 205302 })
    expect(assembled.fromSearch).toBe(1)
  })

  it('counts a repo once when two subpackage entries share it', () => {
    // Both key by `repo`, so the key is written once — and the tally the
    // build note prints must not count it twice.
    const assembled = assembleStarsForEntries(
      [repoEntry('sub-a', 'o/mono', 'packages/a'), repoEntry('sub-b', 'o/mono', 'packages/b')],
      new Map([['o/mono', 12]]), new Map(),
    )
    expect(assembled.stars).toEqual({ 'o/mono': 12 })
    expect(assembled.fromSearch).toBe(1)
  })

  it('carries no key for a candidate the gate rejected', () => {
    // The defect: the sidecar was assembled from every candidate the harvest
    // produced, so 7,553 of the live file's 16,714 keys named packages the
    // catalog does not list — about 265 KB of 596 KB, downloaded by everyone.
    const candidates = JSON.parse(
      readFileSync('registry/scripts/tests/fixtures/packuments.json', 'utf8'),
    ) as Candidate[]
    const config = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]',
      firstSeen: candidates.map(c => `- name: "${c.name}"\n  added: 2026-08-01`).join('\n') + '\n',
    })
    const { entries, rejections } = selectEntries(candidates, [], config)
    const stars = new Map(candidates.map(c => [`you/${c.name}`, 7]))
    const assembled = assembleStarsForEntries(entries, stars, new Map())

    const listed = entries.map(e => e.name)
    const rejected = rejections.map(r => r.name)
    expect(listed.length).toBeGreaterThan(0)
    expect(rejected).toContain('dsh-lib-only')
    for (const name of rejected) expect(Object.keys(assembled.stars)).not.toContain(name)
    for (const name of listed) expect(Object.keys(assembled.stars)).toContain(name)
  })
})

describe('serializeStars', () => {
  const of = (stars: Record<string, number>): AssembledStars => ({ stars, fromSearch: 0, fromGraphql: 0 })

  it('produces byte-identical output regardless of key insertion order', () => {
    const forward = serializeStars(of({ 'a/one': 1, 'b/two': 2, 'c/three': 3 }))
    const backward = serializeStars(of({ 'c/three': 3, 'b/two': 2, 'a/one': 1 }))
    expect(backward.json).toBe(forward.json)
    expect(backward.sha256).toBe(forward.sha256)
    expect(backward.fileName).toBe(forward.fileName)
  })

  it('sorts by key, indents by two, and ends with exactly one newline', () => {
    const { json } = serializeStars(of({ 'z/last': 2, 'a/first': 1 }))
    expect(json).toBe('{\n  "stars": {\n    "a/first": 1,\n    "z/last": 2\n  }\n}\n')
    expect(json.endsWith('\n\n')).toBe(false)
  })

  it('names the file by the sha256 of the bytes it serialized', () => {
    const { json, sha256, fileName } = serializeStars(of({ 'a/one': 1 }))
    expect(sha256).toBe(createHash('sha256').update(json).digest('hex'))
    expect(fileName).toBe(`stars.${sha256}.json`)
  })

  it('changes the hash when a count changes', () => {
    expect(serializeStars(of({ 'a/one': 1 })).sha256).not.toBe(serializeStars(of({ 'a/one': 2 })).sha256)
  })
})
```

Append to `registry/scripts/tests/pipeline.test.ts` inside `describe('runPipeline', ...)`:

```ts
  it('accepts exactly what selectEntries accepted — runPipeline is that plus emit', () => {
    // The extraction has to be behaviour-free: build.ts calls selectEntries
    // for the stars sidecar and runPipeline for the artifacts, and the two
    // must not be able to disagree about what is listed.
    const { entries, rejections } = selectEntries(candidates, [], config)
    const { pluginsJson, report } = runPipeline(candidates, [], config, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).toEqual([...entries.map(e => e.name)].sort())
    for (const rejection of rejections) expect(report).toContain(`| ${rejection.name} |`)
  })

  it('does not mutate the pre-existing rejections it is handed', () => {
    // build.ts hands the same array to selectEntries and then to
    // runPipeline; a push into it would double every fetch-failed row.
    const preexisting: Rejection[] = [
      { name: 'dsh-rate-limited', code: 'fetch-failed', detail: 'npm registry returned 429 fetching dsh-rate-limited' },
    ]
    selectEntries(candidates, [], config, preexisting)
    runPipeline(candidates, [], config, BUILT_AT, preexisting)
    expect(preexisting).toHaveLength(1)
  })
```

Add `selectEntries` to the `pipeline.ts` import on line 3 of that file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/stars-assemble.test.ts` — Expected: FAIL at collection with `No "assembleStarsForEntries" export is defined on "../src/stars-assemble.ts"` (and the same for `serializeStars` and `selectEntries`).

- [ ] **Step 3: Write the implementation**

Replace `registry/scripts/src/stars-assemble.ts` in full:

```ts
/**
 * Assembles and serializes the stars sidecar. Pure: the "which count wins"
 * policy, the key policy, the sort, the hash and the file name all live here,
 * so fixtures drive all of it and the determinism tests can cover the
 * sidecar the way they cover plugins.json.
 * @module stars-assemble
 */

import { createHash } from 'node:crypto'
import { githubOwnerName, isHarnessRepo } from './github-repo.ts'
import type { Entry } from './types.ts'

/**
 * The sidecar's `stars` object plus the per-source tallies the build note
 * reports. npm entries key by package name, github entries by repo full
 * name — the two keyspaces stay disjoint.
 */
export interface AssembledStars {
  stars: Record<string, number>
  fromSearch: number
  fromGraphql: number
}

/** The sidecar's serialized form: the bytes, their hash, and the
 * content-addressed name they publish under. */
export interface SerializedStars {
  fileName: string
  json: string
  sha256: string
}

/**
 * Merge the two star sources over the ACCEPTED entries.
 *
 * A search-derived count wins whenever the repo appears in the daily topic
 * enumeration: the count rides a response the harvest already paid for and
 * is exactly as fresh as the build. GraphQL covers the repos the search did
 * not see. `null` repository urls and repos with no count in either source
 * are skipped; a zero count is a real count.
 *
 * The unit is an entry, not a candidate. Assembled from candidates, the live
 * sidecar carried 16,714 keys of which 7,553 named packages the catalog does
 * not list — about 265 KB of 596 KB that every reader downloads.
 */
export function assembleStarsForEntries(
  entries: Entry[],
  searchStars: Map<string, number>,
  graphqlStars: Map<string, number>,
): AssembledStars {
  const stars: Record<string, number> = {}
  let fromSearch = 0
  let fromGraphql = 0
  for (const entry of entries) {
    // An npm entry declaring the harness as its repository is a
    // misdeclaration; the gate rejects it, and this keeps the rule true of
    // the sidecar independently of the gate. A github entry keyed by the
    // harness's own full name carries its own, correct count.
    if (entry.source === 'npm' && isHarnessRepo(entry.repository)) continue
    const key = entry.source === 'npm' ? entry.name : (entry.repo ?? entry.name)
    // Two subpackage entries of one monorepo share a key. Writing it once
    // keeps the tally honest: the build note reports a repo count.
    if (Object.hasOwn(stars, key)) continue
    const parsed = githubOwnerName(entry.repository)
    if (parsed === null) continue
    const fullName = `${parsed.owner}/${parsed.name}`
    const searchCount = searchStars.get(fullName)
    const count = searchCount ?? graphqlStars.get(fullName)
    if (count === undefined) continue
    stars[key] = count
    if (searchCount !== undefined) fromSearch += 1
    else fromGraphql += 1
  }
  return { stars, fromSearch, fromGraphql }
}

/**
 * Serialize the sidecar: sorted by key, hashed, and named by the hash.
 *
 * Sorted so the bytes do not depend on the entry order, which is the same
 * rule plugins.json follows. These four decisions used to be one expression
 * inside `build.ts` with no test over any of them.
 */
export function serializeStars(assembled: AssembledStars): SerializedStars {
  const json = `${JSON.stringify({
    stars: Object.fromEntries(
      Object.entries(assembled.stars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ),
  }, null, 2)}\n`
  const sha256 = createHash('sha256').update(json).digest('hex')
  return { fileName: `stars.${sha256}.json`, json, sha256 }
}
```

Replace `registry/scripts/src/pipeline.ts:24-63` (`runPipeline`) with the extraction plus the unchanged wrapper. Note the import line 6 must gain `Entry` — it is already imported there — and nothing else changes:

```ts
/**
 * Gate and tier every candidate: the policy half of {@link runPipeline},
 * separated so a caller that needs the ACCEPTED entries before emission can
 * have them. `build.ts` needs exactly that, to key the stars sidecar by
 * entry rather than by candidate and to narrow the GraphQL ask to the
 * entries that will actually be published.
 *
 * Pure and non-mutating: `preexistingRejections` is copied, because the same
 * array is handed to this and to {@link runPipeline} in one build.
 * @param candidates - packages fetched from npm, in any order.
 * @param repoCandidates - repositories fetched from GitHub, in any order.
 * @param config - the human-authored registry files.
 * @param preexistingRejections - rejections decided before this ran.
 * @returns the accepted entries and every rejection.
 */
export function selectEntries(
  candidates: Candidate[],
  repoCandidates: RepoCandidate[],
  config: RegistryConfig,
  preexistingRejections: Rejection[] = [],
): { entries: Entry[]; rejections: Rejection[] } {
  const entries: Entry[] = []
  const rejections: Rejection[] = [...preexistingRejections]

  // npm first: its entries own the bundle names (npm wins by design — real
  // semver beats a commit pin), and repo candidates for the same name are
  // recorded as shadowed, not silently dropped.
  const npmNames = new Set<string>()
  for (const candidate of candidates) {
    const result = gate(candidate, config)
    if (result.ok) {
      npmNames.add(candidate.name)
      entries.push(assignTier(result.accepted, config))
    } else {
      rejections.push(result.rejection)
    }
  }
  for (const repoCandidate of repoCandidates) {
    if (npmNames.has(repoCandidate.name)) {
      rejections.push({
        name: repoCandidate.repo,
        code: 'shadowed-by-npm',
        detail: `The npm package ${repoCandidate.name} is already listed; the repository is not listed separately.`,
      })
      continue
    }
    const result = gateRepo(repoCandidate, config)
    if (result.ok) entries.push(assignRepoTier(result.accepted, config))
    else rejections.push(result.rejection)
  }
  return { entries, rejections }
}

/**
 * Run the whole catalog build as a pure function.
 *
 * Purity is what makes the determinism test possible: the only inputs are the
 * candidates, the registry files, and the timestamp, so the same three
 * produce byte-identical artifacts regardless of candidate order or clock.
 * @param candidates - packages fetched from npm, in any order.
 * @param repoCandidates - repositories fetched from GitHub, in any order.
 * @param config - the human-authored registry files.
 * @param builtAt - ISO 8601 build timestamp.
 * @param preexistingRejections - rejections decided before this function ran, such as a
 *   name that could not be turned into a candidate at all (e.g. a failed fetch); merged
 *   into the emitted report alongside every rejection this function produces itself.
 * @param stars - optional pointer to a published stars sidecar, passed through to emit.
 * @returns the artifacts to publish and commit.
 */
export function runPipeline(
  candidates: Candidate[],
  repoCandidates: RepoCandidate[],
  config: RegistryConfig,
  builtAt: string,
  preexistingRejections: Rejection[] = [],
  stars: StarsPointer | null = null,
  schemaVersion: number = SCHEMA_VERSION,
): Artifacts {
  const { entries, rejections } = selectEntries(candidates, repoCandidates, config, preexistingRejections)
  return emit(entries, rejections, builtAt, stars, schemaVersion, config.notAShop)
}
```

In `registry/scripts/src/build.ts`, change the imports on lines 24 and 26:

```ts
import { runPipeline, selectEntries } from './pipeline.ts'
```
```ts
import { assembleStarsForEntries, serializeStars } from './stars-assemble.ts'
```

Move the first-seen block (today lines 208-216) up so it sits immediately after the two `mkdirSync` calls at line 144 and before the stars block, and add the selection beneath it. `new Date()` is still read exactly once; it now precedes the stars fetch rather than following it, which changes nothing that depends on it — `builtAt` stamps `index.json` and the first-seen dates, and neither is a function of the stars step:

```ts
// First-seen bookkeeping: any name this run harvested for the first time gets
// today. The appended file is written back after the pipeline, so the daily
// commit carries both the new dates and the manifest lock together. The clock
// is read here, exactly once, and passed down.
const builtAt = new Date().toISOString()
const today = builtAt.slice(0, 10)
const firstSeen = new Map(config.firstSeen)
for (const candidate of candidates) if (!firstSeen.has(candidate.name)) firstSeen.set(candidate.name, today)
for (const repo of repoCandidates) if (!firstSeen.has(repo.name)) firstSeen.set(repo.name, today)
const configWithFirstSeen = { ...config, firstSeen }

// The gate and the tiering, run before the stars step because the sidecar is
// keyed by ENTRY and the GraphQL ask should only spend points on entries that
// will be published. `runPipeline` runs the same pure pass again to emit; both
// passes are deterministic over the same inputs and neither does any I/O.
const selected = selectEntries(candidates, repoCandidates, configWithFirstSeen, rejections)
```

Then, inside the stars block, before (lines 165-172):

```ts
  // Repos the search already covered: ask GraphQL only for the rest.
  const graphqlRepos = new Map<string, { owner: string; name: string }>()
  for (const candidate of [...candidates, ...repoCandidates]) {
    const parsed = githubOwnerName(candidate.repository)
    if (parsed === null) continue
    const fullName = `${parsed.owner}/${parsed.name}`
    if (!repoSearchStars.has(fullName)) graphqlRepos.set(fullName, parsed)
  }
```

After:

```ts
  // Repos the search already covered: ask GraphQL only for the rest — and
  // only for entries the gate accepted. Asking for every candidate spent
  // points on packages the catalog does not list, which is the same defect
  // as putting them in the sidecar.
  const graphqlRepos = new Map<string, { owner: string; name: string }>()
  for (const entry of selected.entries) {
    const parsed = githubOwnerName(entry.repository)
    if (parsed === null) continue
    const fullName = `${parsed.owner}/${parsed.name}`
    if (!repoSearchStars.has(fullName)) graphqlRepos.set(fullName, parsed)
  }
```

And before (lines 190-198):

```ts
    const assembled = assembleStarsByKey(candidates, repoCandidates, repoSearchStars, graphqlStars)
    if (Object.keys(assembled.stars).length === 0) {
      starsNote = graphqlNote === '' ? 'no star counts' : `no star counts (${graphqlNote})`
      process.stderr.write(`stars: ${starsNote}\n`)
    } else {
      const starsJson = `${JSON.stringify({ stars: Object.fromEntries(Object.entries(assembled.stars).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) }, null, 2)}\n`
      const starsSha = createHash('sha256').update(starsJson).digest('hex')
      writeFileSync(join(OUT_DIR, `stars.${starsSha}.json`), starsJson)
      starsInfo = { url: `stars.${starsSha}.json`, sha256: starsSha }
```

After:

```ts
    const assembled = assembleStarsForEntries(selected.entries, repoSearchStars, graphqlStars)
    if (Object.keys(assembled.stars).length === 0) {
      starsNote = graphqlNote === '' ? 'no star counts' : `no star counts (${graphqlNote})`
      process.stderr.write(`stars: ${starsNote}\n`)
    } else {
      const serialized = serializeStars(assembled)
      writeFileSync(join(OUT_DIR, serialized.fileName), serialized.json)
      starsInfo = { url: serialized.fileName, sha256: serialized.sha256 }
```

Delete the now-duplicated first-seen block at the old location (lines 208-216 as numbered at HEAD), and drop the `createHash` import on line 15 — nothing else in `build.ts` hashes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/stars-assemble.test.ts registry/scripts/tests/pipeline.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`. `typecheck` is the guard that catches a missed `assembleStarsByKey` reference and the now-unused `createHash` import.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/stars-assemble.ts registry/scripts/src/pipeline.ts registry/scripts/src/build.ts registry/scripts/tests/stars-assemble.test.ts registry/scripts/tests/pipeline.test.ts
git commit -m "fix(stars): key the sidecar by accepted entry and serialize it in the pure core"
```

---

### Task 10: Report cells neutralise controls and bidi formatting

> **Outcome: DONE as written.** Every affected code point is `\u` escape text
> in both the source and the tests, and a check confirmed no raw control or
> bidi character entered the repository — the tool refused the first attempt to
> paste them, which is the reviewer-invisibility problem this task is about,
> demonstrated.
>
> The "order is load-bearing" claim in the doc comment is mutation-checked:
> swapping the newline collapse and the control strip turns a real line break
> into U+FFFD and two tests go red, so the comment is a tested statement rather
> than prose.
>
> **The client half is plan D's, not this task's** — a catalog `summary.en`
> reaches a terminal UI the same way a report cell reaches a terminal.
> `docs/plans/2026-09-03-audit-fix-d-host-client.md:440` has the consumer zod
> refusing a `name` that carries a control character. Worth noting when that
> task is reached: its regex is `[^\u0000-\u001f\u007f]+`, which covers C0
> and DEL but not C1 or the bidi marks and isolates that this task found
> necessary here, and it guards `name` rather than the summary text.

**Files:**
- Modify: `registry/scripts/src/emit.ts:67-79` (`escapeCell`)
- Test: `registry/scripts/tests/emit.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks consume. `escapeCell` stays module-private.

Order matters inside the function: the newline collapse runs before the control strip, so `\n` keeps becoming a space and the existing assertion at `emit.test.ts:155` stays true. Markdown link syntax is deliberately left alone — it renders as visible text in the run-artifact viewer, and escaping brackets would mangle the zod paths our own details carry (`dsh.catalog.capabilities[0]`).

**Write every affected code point as a `\u` escape**, in the test and in the implementation. A literal U+202E in a source file is invisible to a reviewer, which is the problem being fixed — do not paste raw control characters into the repo.

- [ ] **Step 1: Write the failing test**

Append inside `describe('emit', ...)` in `registry/scripts/tests/emit.test.ts`, after the existing pipe-and-newline escape test at line 156:

```ts
  it('neutralises control characters and bidi formatting in a rejection detail', () => {
    // `detail` carries text from a third party's package.json, and the
    // report's real reader is a maintainer in a terminal: U+001B opens an
    // escape sequence (the OSC-8 below hides an arbitrary target behind
    // harmless-looking text) and U+202E reverses the rest of the line, so a
    // row can be made to read as another package's. Each stripped code point
    // becomes U+FFFD rather than vanishing — a reader should see that
    // something was removed.
    const osc8 = '\u001b]8;;https://evil.test\u0007click\u001b]8;;\u0007'
    const detail = `safe ${osc8} \u202egnidaelsim\u202c \u2066wrapped\u2069`
    const { report } = emit([], [{ name: 'dsh-x', code: 'invalid-catalog', detail }], '2026-08-18T00:00:00.000Z')
    const lines = report.split('\n').filter(line => line.startsWith('| dsh-x'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/)
    expect(lines[0]).toContain('safe')
    expect(lines[0]).toContain('\ufffd')
  })

  it('neutralises a hostile rejection NAME the same way', () => {
    // A GitHub manifest name is unrestricted, and the name column is the one
    // a reader scans to find their own package.
    const { report } = emit([], [{ name: 'dsh-\u202eevil', code: 'no-bundle', detail: 'x' }], '2026-08-18T00:00:00.000Z')
    expect(report).not.toContain('\u202e')
    expect(report).toContain('dsh-\ufffdevil')
  })

  it('turns a tab into a space and leaves the pipe and newline rules intact', () => {
    const { report } = emit([], [{ name: 'dsh-x', code: 'no-bundle', detail: 'a\tb | c\nd' }], '2026-08-18T00:00:00.000Z')
    const lines = report.split('\n').filter(line => line.startsWith('| dsh-x'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toBe('| dsh-x | no-bundle | a b \\| c d |')
  })

  it('leaves ordinary non-ASCII text alone', () => {
    // The strip is a closed list of control and formatting code points, not
    // an ASCII filter: a Chinese detail or an emoji is fine.
    const detail = '缺少 summary.en 字段 🙂'
    const { report } = emit([], [{ name: 'dsh-x', code: 'no-summary', detail }], '2026-08-18T00:00:00.000Z')
    expect(report).toContain(`| dsh-x | no-summary | ${detail} |`)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/emit.test.ts -t "neutralises control characters and bidi formatting in a rejection detail"` — Expected: FAIL with `expected '| dsh-x | invalid-catalog | safe <ESC>]8;;https://evil.test…' not to match /[\u0000-\u001f…]/`.

- [ ] **Step 3: Write the implementation**

Before (`registry/scripts/src/emit.ts:67-79`):

```ts
/**
 * Escape one field for placement inside a markdown table cell.
 *
 * A rejection's `name`, `code`, and `detail` can all carry text sourced from
 * a third party's `package.json` — `detail` in particular reaches here
 * carrying a zod validation message that echoes back an unrecognized key an
 * author supplied. An unescaped `|` would split the cell into extra columns
 * and an unescaped newline would break the row into extra lines, letting
 * that text forge or corrupt neighboring rows in the published report.
 */
function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, ' ')
}
```

After:

```ts
/**
 * Escape one field for placement inside a markdown table cell.
 *
 * A rejection's `name`, `code`, and `detail` can all carry text sourced from
 * a third party's `package.json` — `detail` in particular reaches here
 * carrying a zod validation message that echoes back an unrecognized key an
 * author supplied. An unescaped `|` would split the cell into extra columns
 * and an unescaped newline would break the row into extra lines, letting
 * that text forge or corrupt neighboring rows in the published report.
 *
 * Control characters and bidi formatting are neutralised for the same
 * reason. They are inert in a browser rendering `text/markdown`, but the
 * report's real reader is a maintainer in a terminal: U+001B opens an escape
 * sequence — an OSC-8 hyperlink hides an arbitrary target behind
 * harmless-looking text — and U+202E reverses the rest of the line, so a
 * rejection row can be made to read as another package's. Each one becomes
 * U+FFFD rather than disappearing, because a reader should be able to see
 * that something was removed. The list is closed — C0, DEL, C1, and the bidi
 * marks and isolates — so ordinary non-ASCII text is untouched.
 *
 * Order is load-bearing: the newline collapse runs first, so a real line
 * break still becomes a space instead of a replacement character.
 *
 * Markdown link syntax is deliberately NOT escaped. It renders as visible
 * text in the run-artifact viewer, and escaping brackets would mangle the
 * zod paths our own details carry (`dsh.catalog.capabilities[0]`).
 */
function escapeCell(value: string): string {
  return value
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n|\t/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '\ufffd')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/emit.test.ts` — Expected: PASS, including the pre-existing `escapes a rejection detail containing a pipe and a newline so the row stays intact` at line 149.
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/emit.ts registry/scripts/tests/emit.test.ts
git commit -m "fix(report): strip controls and bidi formatting from table cells"
```

---

### Task 11: Pages gets a staged directory holding only the spec'd artifacts

> **Outcome: DONE as written**, with the leak confirmed against the live site
> on 2026-09-04 rather than taken on faith. All three answered 200:
> `/v1/harvest.json` at **4,037,180 bytes**, `/v1/report.md` at **1,722,904**,
> `/v1/classification-report.md` at 87 — beside a 486-byte `index.json`.
>
> The staging was simulated locally before committing: `dist/pages/` holds only
> `v1/`, so the published URLs are unchanged, and `dist/pages/v1/` holds
> exactly the four spec'd artifacts while the handoff and both reports stay in
> `dist/v1` as run artifacts.
>
> **One addition.** `publish-catalog.ts` already staged its own directory from
> scratch, as this task notes — but from a hardcoded list inline in the shell,
> differing from the Pages set by exactly one file (`badge.json`, which is the
> shields.io endpoint fetched over HTTP and never read out of the tarball).
> Leaving one transport's publishable set untested while the other is pure is
> the same asymmetry that let Pages publish 4 MB of hostile input for months,
> so `npmArtifactNames` joined the module and the one-file difference is now
> stated and tested instead of coincidental. The npm set is byte-identical to
> what it published before.

**Files:**
- Create: `registry/scripts/src/pages-artifacts.ts`
- Modify: `registry/scripts/src/build.ts` (the `node:fs` import on line 16; a staging block appended after line 239)
- Modify: `registry/scripts/src/classify.ts:31` and `:122`
- Modify: `.github/workflows/daily.yml:71` and `:114-124`
- Test: `registry/scripts/tests/pages-artifacts.test.ts` (new), `registry/scripts/tests/repo-guards.test.ts` (new)

**Interfaces:**
- Consumes: `starsInfo.url` from Task 9 (`serializeStars(...).fileName`), unchanged in shape.
- Produces: `PagesPointer`, `PAGES_FIXED_FILES`, `pagesArtifactNames(pointer: PagesPointer): string[]`, the staged tree `dist/pages/v1/`, and the shared test helpers `repoRoot` and `read(relative)` in `repo-guards.test.ts` that Tasks 12–17 append to.

Pages served `/v1/harvest.json` (3.98 MB of every candidate verbatim, rejected ones included, with unvalidated `dsh.catalog` values), `/v1/report.md` (1.7 MB) and `/v1/classification-report.md`, because `upload-pages-artifact` was pointed at `dist`. None of the three is in the artifact list the spec gives (design §6.2 plus the README's badge endpoint), none is content-addressed, and none is referenced by the pointer. The fix stages the publishable set into a directory built from scratch — what `publish-catalog.ts:69-77` already does for the npm transport.

`harvest.json` also moves out of `v1/` to `dist/harvest.json`, the path `classify.ts`'s own module comment has always claimed. It is an internal handoff, not an output, and it is the file that carries hostile input verbatim, so it must not sit in the directory whose name means "publishable". **The `--harvest-from` flag in `daily.yml` moves in the same commit** — the write and the read are one contract, and the guard test is what holds them together. The two reports stay in `dist/v1`, where `Upload build report` already reads them as run artifacts; the staging step is what keeps them off Pages, and moving them would churn two more workflow paths for no further protection.

`dist/v1` itself is deliberately NOT cleaned by the build: `--harvest-from dist/harvest.json` hands the classifier's harvest to this run through `dist/`, and the reports are uploaded from `dist/v1`. A local `dist/v1` therefore still accumulates old sidecars, which is now harmless because nothing publishes from it.

- [ ] **Step 1: Write the failing test**

Create `registry/scripts/tests/pages-artifacts.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { PAGES_FIXED_FILES, pagesArtifactNames } from '../src/pages-artifacts.ts'

describe('pagesArtifactNames', () => {
  it('publishes exactly the four spec-listed artifacts when the build produced stars', () => {
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } }))
      .toEqual(['index.json', 'badge.json', 'plugins.abc.json', 'stars.def.json'])
  })

  it('omits the sidecar when the build produced none', () => {
    // The stars fetch is advisory: no token, a rate limit or a down API
    // publishes without it, and the pointer then has no `stars` key.
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } }))
      .toEqual(['index.json', 'badge.json', 'plugins.abc.json'])
  })

  it('never lists the internal handoff or either report', () => {
    // Pages served all three because upload-pages-artifact was pointed at
    // `dist`: harvest.json alone is 3.98 MB of every candidate verbatim,
    // rejected ones included, with unvalidated dsh.catalog values.
    const names = pagesArtifactNames({ plugins: { url: 'plugins.abc.json' }, stars: { url: 'stars.def.json' } })
    for (const forbidden of ['harvest.json', 'report.md', 'classification-report.md']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('names the two fixed artifacts, and only those, as fixed', () => {
    expect([...PAGES_FIXED_FILES]).toEqual(['index.json', 'badge.json'])
  })

  it('returns a fresh array a caller cannot corrupt for the next call', () => {
    const first = pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } })
    first.push('harvest.json')
    expect(pagesArtifactNames({ plugins: { url: 'plugins.abc.json' } })).not.toContain('harvest.json')
  })
})
```

Create `registry/scripts/tests/repo-guards.test.ts`. This file collects the guards over the repository's own workflow and packaging conventions, the way `readme-pins.test.ts` guards the README pins; Tasks 12 through 17 append to it:

```ts
/** Guards over the repository's own conventions: what CI publishes, what it
 * is allowed to hold while it does, and what the packaging ships.
 *
 * These read files rather than call functions, because the thing guarded IS
 * a file — a workflow path, a permission block, an ignore rule. They catch
 * drift, not runtime behaviour; where a runtime fact is what matters, the
 * task that added the guard also names the log line or `gh api` read that
 * confirms it. A convention no test enforces is a convention that drifts
 * silently, which is what readme-pins.test.ts exists to prove. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8')

describe('what CI publishes to Pages', () => {
  it('uploads the staged directory, never dist itself', () => {
    // `path: dist` published /v1/harvest.json, /v1/report.md and
    // /v1/classification-report.md, none of which the spec lists.
    const workflow = read('.github/workflows/daily.yml')
    expect(workflow).toContain('uses: actions/upload-pages-artifact')
    const fromStep = workflow.slice(workflow.indexOf('actions/upload-pages-artifact'))
    expect(fromStep).toMatch(/\n\s+path: dist\/pages\n/)
    expect(fromStep).not.toMatch(/\n\s+path: dist\n/)
  })

  it('hands the build the harvest path the classifier writes', () => {
    // Two files, one contract: classify.ts writes the handoff and daily.yml
    // tells build.ts where to read it. A silent mismatch would make the build
    // re-harvest the whole ecosystem — about 8,800 packuments — rather than
    // fail, so the drift would cost hours before anyone noticed.
    expect(read('registry/scripts/src/classify.ts')).toContain("writeFileSync(join(DIST_DIR, 'harvest.json')")
    expect(read('.github/workflows/daily.yml')).toContain('--harvest-from dist/harvest.json')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/pages-artifacts.test.ts registry/scripts/tests/repo-guards.test.ts` — Expected: FAIL. `pages-artifacts.test.ts` fails at collection with `Failed to load "../src/pages-artifacts.ts"`; `repo-guards.test.ts` fails both assertions — `expected '…\n          path: dist\n' to match /\n\s+path: dist\/pages\n/` and `expected '…' to contain "writeFileSync(join(DIST_DIR, 'harvest.json')"`.

- [ ] **Step 3: Write the implementation**

Create `registry/scripts/src/pages-artifacts.ts`:

```ts
/**
 * What the Pages site is allowed to contain.
 *
 * `upload-pages-artifact` was pointed at `dist/`, so everything the build and
 * the classifier happened to write there was published: `/v1/harvest.json`
 * (3.98 MB of every candidate verbatim, rejected ones included, with
 * unvalidated `dsh.catalog` values), `/v1/report.md` (1.7 MB), and
 * `/v1/classification-report.md`. None of the three is in the spec's artifact
 * list (design §6.2 plus the README's badge endpoint), none is
 * content-addressed, and none is referenced by the pointer.
 *
 * The list of publishable names is policy, so it lives in the pure core where
 * a test can hold it to the spec; `build.ts` copies what this returns into a
 * directory it creates from scratch.
 * @module pages-artifacts
 */

/** The emitted pointer, as far as this module needs to read it. */
export interface PagesPointer {
  plugins: { url: string }
  /** Absent when the build published no sidecar — the stars fetch is
   * advisory, and a failure publishes without it. */
  stars?: { url: string }
}

/**
 * The fixed-name artifacts every build publishes: the pointer, and the
 * shields.io endpoint payload the README's `catalog` badge reads.
 */
export const PAGES_FIXED_FILES: readonly string[] = ['index.json', 'badge.json']

/**
 * Every file the Pages site publishes for one build, in a deterministic
 * order: the fixed-name artifacts, then the content-addressed data file, then
 * the stars sidecar when this build produced one.
 * @param pointer - the emitted `index.json`, which names the addressed files.
 * @returns a fresh array of file names, relative to `v1/`.
 */
export function pagesArtifactNames(pointer: PagesPointer): string[] {
  return [
    ...PAGES_FIXED_FILES,
    pointer.plugins.url,
    ...(pointer.stars === undefined ? [] : [pointer.stars.url]),
  ]
}
```

In `registry/scripts/src/build.ts`, extend the `node:fs` import (line 16) and add the new module import beside the others:

```ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
```
```ts
import { pagesArtifactNames } from './pages-artifacts.ts'
```

Append to the end of `registry/scripts/src/build.ts`, after the `wrote …` line (line 239):

```ts
// Pages gets a directory staged from scratch, holding exactly the artifacts
// the spec lists. `dist/v1` is NOT cleaned and is not what deploys: the
// classifier's harvest reaches this run through `dist/`, the two reports are
// uploaded from `dist/v1` as run artifacts, and a local `dist/v1` accumulates
// old sidecars — all harmless once nothing publishes from it.
const PAGES_DIR = 'dist/pages'
rmSync(PAGES_DIR, { recursive: true, force: true })
mkdirSync(join(PAGES_DIR, 'v1'), { recursive: true })
const pagesFiles = pagesArtifactNames({
  plugins: { url: artifacts.pluginsFileName },
  ...(starsInfo === null ? {} : { stars: { url: starsInfo.url } }),
})
for (const name of pagesFiles) copyFileSync(join(OUT_DIR, name), join(PAGES_DIR, 'v1', name))
process.stderr.write(`staged ${pagesFiles.length} file(s) for Pages: ${pagesFiles.join(', ')}\n`)
```

In `registry/scripts/src/classify.ts`, before (line 31):

```ts
const OUT_DIR = 'dist/v1'
```

After:

```ts
const OUT_DIR = 'dist/v1'
// The harvest handoff is an internal artifact, not an output: it carries
// every candidate verbatim, rejected ones included, with unvalidated
// `dsh.catalog` values. It sat in `dist/v1/` and was therefore published by
// Pages. `v1/` now means "publishable" and this is not. The path here and
// `--harvest-from` in daily.yml are one contract; a guard test pins both.
const DIST_DIR = 'dist'
```

Before (line 122):

```ts
writeFileSync(join(OUT_DIR, 'harvest.json'), `${JSON.stringify({ candidates, rejections })}\n`)
```

After:

```ts
writeFileSync(join(DIST_DIR, 'harvest.json'), `${JSON.stringify({ candidates, rejections })}\n`)
```

In `.github/workflows/daily.yml`, before (line 71):

```yaml
      - run: pnpm build:catalog -- --harvest-from dist/v1/harvest.json
```

After:

```yaml
      - run: pnpm build:catalog -- --harvest-from dist/harvest.json
```

Before (lines 114-124):

```yaml
      - name: Publish to Pages
        # `workflow_dispatch` fires on ANY ref, so the event check alone would
        # let a feature branch's catalog reach every reader. The github-pages
        # environment already restricts deployment to `main`, but that lives in
        # repository settings where one admin click widens it; the branch this
        # publishes from belongs in the workflow. 0.5.0 is what a wrong catalog
        # reaching everyone costs.
        if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist
```

After:

```yaml
      - name: Publish to Pages
        # `workflow_dispatch` fires on ANY ref, so the event check alone would
        # let a feature branch's catalog reach every reader. The github-pages
        # environment already restricts deployment to `main`, but that lives in
        # repository settings where one admin click widens it; the branch this
        # publishes from belongs in the workflow. 0.5.0 is what a wrong catalog
        # reaching everyone costs.
        #
        # `dist/pages`, never `dist`: build.ts stages exactly the artifacts the
        # spec lists into it, from scratch. Pointed at `dist`, this published
        # /v1/harvest.json (every candidate verbatim), /v1/report.md and
        # /v1/classification-report.md.
        if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'
        uses: actions/upload-pages-artifact@v3
        with:
          path: dist/pages
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/pages-artifacts.test.ts registry/scripts/tests/repo-guards.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

Then verify the staging end to end, from the committed fixture and with no network. Both harvest halves are off, so this is a pure local run:

```sh
mkdir -p dist dist/v1 && touch dist/v1/leftover.json
node --experimental-strip-types -e "
  const { readFileSync, writeFileSync } = await import('node:fs')
  const candidates = JSON.parse(readFileSync('registry/scripts/tests/fixtures/packuments.json', 'utf8'))
  writeFileSync('dist/harvest.json', JSON.stringify({ candidates, rejections: [] }) + '\n')
"
env -u GITHUB_TOKEN -u STARS_TOKEN SHOP_CATALOG_V5=1 \
  node --experimental-strip-types registry/scripts/src/build.ts --harvest-from dist/harvest.json
ls dist/pages/v1
rm -rf dist
```
Expected: the build prints `staged 3 file(s) for Pages: index.json, badge.json, plugins.<sha256>.json`, and `ls` shows exactly those three — no `leftover.json`, no `report.md`, no `harvest.json`, and no `stars.*.json` (no token, so the stars step skipped). The build also rewrites `registry/first-seen.yml` and `registry/snapshots/manifest.lock` from the fixture: `git checkout -- registry/` before committing.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/pages-artifacts.ts registry/scripts/src/build.ts registry/scripts/src/classify.ts .github/workflows/daily.yml registry/scripts/tests/pages-artifacts.test.ts registry/scripts/tests/repo-guards.test.ts
git commit -m "fix(pages): publish only the spec'd artifacts from a staged directory"
```

---

### Task 12: The pointer's cache window — name the fallback and its cost

**Files:**
- Modify: `docs/design/2026-09-01-catalog-mirrors.md` (a new subsection under §3, after "Origins may disagree" which ends at line 195)
- Modify: `README.md:210-212` and the matching paragraph in `README.zh.md`
- Test: `registry/scripts/tests/repo-guards.test.ts` (append)

**Interfaces:**
- Consumes: `pagesArtifactNames` from Task 11 — the staged set is precisely what a deploy replaces.
- Produces: nothing later tasks consume.

**The decision: document the npm mirror as the fallback; do not retain the previous generation.** A deploy replaces the Pages site wholesale, so the previous `plugins.<sha256>.json` and `stars.<sha256>.json` 404 the moment a new build lands, while `index.json` is served with `cache-control: max-age=600`. For up to ten minutes a reader holding the cached pointer is sent to a data URL that no longer exists.

Who it reaches, and the cost: a reader whose HTTP probe wins the race and who has no usable disk cache. Per the mirrors design, an HTTP bulk-fetch failure falls back to `cachedOrThrow`, not to another origin, so a first-ever load inside that window fails and the reader reopens the shop. Ten minutes, self-healing, and only on the slowest origin.

The rejected alternative and its price: retaining the previous generation means `build.ts` reading the published `index.json` over the network and re-downloading roughly 4.3 MB of the previous data and sidecar into the staged directory on **every** run — a new network dependency and a new failure mode in the daily build, plus a two-generation Pages upload, to close a ten-minute window on a Low finding. The npm transport has no such gap by construction: `publish-catalog.ts:75-77` copies `index.json` and every file it names into one tarball, so pointer and data always ship as one generation.

The durable code fix belongs to plan D: an HTTP data-file 404 should fall through to the next origin rather than only to the disk cache (`packages/dsh-plugin-shop/src/host/origin.ts`). This task records the decision and hands that over; it does not change the host.

- [ ] **Step 1: Verification procedure (not a vitest file)**

This finding is about a live CDN's behaviour, so confirm it before writing it down. Two read-only requests:

```sh
curl -sI https://LivXue.github.io/dsh-plugin-shop/v1/index.json | grep -iE 'cache-control|age:|etag'
curl -s https://LivXue.github.io/dsh-plugin-shop/v1/index.json | grep -o '"url": "[^"]*"'
```
Expected: a `cache-control` naming `max-age=600`, and the pointer's current `plugins.<sha256>.json` name. Then confirm the other half — that a generation which is no longer current is simply gone:

```sh
curl -so /dev/null -w '%{http_code}\n' \
  https://LivXue.github.io/dsh-plugin-shop/v1/plugins.0000000000000000000000000000000000000000000000000000000000000000.json
```
Expected: `404`. The two together are the finding: a pointer cached for up to 600 s can name a file that answers 404.

If `cache-control` reports a different max-age, write **that** number into the amendment instead of 600, and adjust "ten minutes" to match.

- [ ] **Step 2: Write the failing test**

Append to `registry/scripts/tests/repo-guards.test.ts`:

```ts
describe('the pointer cache window', () => {
  it('is recorded in the mirrors design with the fallback it chose', () => {
    // A known ten-minute hole in one transport is a fact a reader of the
    // design needs, and a decision NOT to close something gets silently
    // re-litigated if it is not written down with its price.
    const design = read('docs/design/2026-09-01-catalog-mirrors.md')
    expect(design).toContain('### The pointer outlives the data it names')
    expect(design).toContain('max-age=600')
    expect(design).toContain('dsh-plugin-shop-catalog')
  })

  it('is stated in both READMEs beside the artifact table', () => {
    // Anyone fetching /v1/ themselves needs to know the data names change
    // per build and where to get a self-consistent pair instead.
    for (const file of ['README.md', 'README.zh.md']) {
      expect(read(file), `${file} does not name the npm fallback`).toContain('dsh-plugin-shop-catalog')
      expect(read(file), `${file} does not mention the 404 a stale pointer causes`).toContain('404')
    }
  })
})
```

- [ ] **Step 3: Write the implementation**

Insert into `docs/design/2026-09-01-catalog-mirrors.md`, after the "Origins may disagree" subsection (ending line 195) and before `## 4. Integrity and trust`:

```markdown
### The pointer outlives the data it names

A Pages deploy replaces the site wholesale, so the previous
`plugins.<sha256>.json` and `stars.<sha256>.json` return 404 the moment a
new build lands — while Pages serves `index.json` with
`cache-control: max-age=600`. For up to ten minutes a reader holding the
cached pointer is sent to a data URL that no longer exists.

The gap belongs to one transport alone. An npm publish packs `index.json`
and every file it names into a single tarball
(`registry/scripts/src/publish-catalog.ts`), so pointer and data are
always the same generation; `dsh-plugin-shop-catalog` is the documented
fallback for exactly this window, and because every load races, a reader
normally never notices.

Who it reaches: a reader whose HTTP probe wins the race and who has no
usable disk cache. HTTP's bulk fetch happens after a winner is chosen, so
its failure falls back to `cachedOrThrow` rather than to another origin
(see "The race" above). A first-ever load inside the window fails, and
reopening the shop succeeds.

**Not retained deliberately.** Keeping the previous generation for one
deploy would mean the build reading the published `index.json` over the
network and re-downloading about 4.3 MB of the previous data and sidecar
into the staged Pages directory on every run: a new network dependency and
a new failure mode in the daily build, plus a two-generation upload, to
close a ten-minute window that already self-heals. The durable fix belongs
in the Host instead — an HTTP data-file 404 should fall through to the next
origin rather than only to the disk cache — and is tracked with the rest of
the host work.
```

In `README.md`, before (lines 210-212):

```markdown
Each build's rejection report, carrying an author-readable reason for every rejected
package, is attached to the workflow run. Nothing disappears without a reason attached
to its name.
```

After:

```markdown
Each build's rejection report, carrying an author-readable reason for every rejected
package, is attached to the workflow run. Nothing disappears without a reason attached
to its name.

The data files are content-addressed, so each build publishes new names and the previous
ones stop existing, while the pointer above it is cached for ten minutes. If you fetch
`/v1/` yourself, re-read `index.json` whenever a data URL answers 404 — or read the same
bytes from the npm package `dsh-plugin-shop-catalog`, where the pointer and the data it
names always ship in one tarball.
```

Add the matching paragraph to `README.zh.md` immediately after its rejection-report sentence, in its own register, stating the same three facts: the data names change with every build, the pointer is cached for ten minutes so a stale one can answer 404, and `dsh-plugin-shop-catalog` ships the pointer and its data together.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add docs/design/2026-09-01-catalog-mirrors.md README.md README.zh.md registry/scripts/tests/repo-guards.test.ts
git commit -m "docs(mirrors): name the pointer cache window and the npm fallback"
```

---

### Task 13: Pin every action to a commit SHA, and let Dependabot move them

**Files:**
- Modify: `.github/workflows/daily.yml:48-50, 89, 110, 122, 163-165, 169, 198`
- Modify: `.github/workflows/plugin.yml:18-20`
- Create: `.github/dependabot.yml`
- Test: `registry/scripts/tests/repo-guards.test.ts` (append)

**Interfaces:**
- Consumes: `read()` and `repoRoot` from `repo-guards.test.ts` (Task 11).
- Produces: the pin format `owner/repo@<40-hex> # vX.Y.Z`, which the guard test and Dependabot both depend on.

Every action was pinned to a mutable major tag — including the third-party `pnpm/action-setup@v4`, which installs the `pnpm` binary that later runs `publish:catalog` with `NODE_AUTH_TOKEN` in the environment and `id-token: write` in scope, in a job that also holds `LLM_API_KEY`, `NPM_TOKEN` and `STARS_TOKEN`. A major tag is a moving reference: whoever can move it can run code in that job. Pinning to a commit SHA of the version in use today changes no behaviour and removes the moving part; the trailing `# vX.Y.Z` comment is what keeps the file readable and is what Dependabot rewrites when it bumps a pin.

**These are the SHAs, resolved read-only on 2026-09-03**, each with the release it names:

| Action | Commit SHA | Version |
|---|---|---|
| `actions/checkout` | `11d5960a326750d5838078e36cf38b85af677262` | v4.4.0 |
| `pnpm/action-setup` | `b906affcce14559ad1aafd4ab0e942779e9f58b1` | v4.3.0 |
| `actions/setup-node` | `49933ea5288caeca8642d1e84afbd3f7d6820020` | v4.4.0 |
| `actions/upload-artifact` | `ea165f8d65b6e75b540449e92b4886f43607fa02` | v4.6.2 |
| `actions/download-artifact` | `d3f86a106a0bac45b974a628896c90dbdf5c8093` | v4.3.0 |
| `actions/upload-pages-artifact` | `56afc609e74202658d3ffba0e8f6dda462b719fa` | v3.0.1 |
| `actions/deploy-pages` | `d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e` | v4.0.5 |

Each is the commit the major tag in use resolves to today, so this is a no-op pin, not an upgrade. Newer majors exist (checkout v7, setup-node v7, upload-artifact v7, download-artifact v8, upload-pages-artifact v5, deploy-pages v5, action-setup v6); moving to them is a behaviour change and is deliberately not part of this task — that is what Dependabot's PRs are for, one at a time, with CI to judge each.

- [ ] **Step 1: Re-resolve the SHAs before writing them**

A SHA copied from a plan is a SHA nobody checked. Re-run the read-only resolution and confirm it matches the table above:

```sh
for spec in actions/checkout:v4 pnpm/action-setup:v4 actions/setup-node:v4 \
            actions/upload-artifact:v4 actions/download-artifact:v4 \
            actions/upload-pages-artifact:v3 actions/deploy-pages:v4; do
  repo=${spec%:*}; tag=${spec#*:}
  ref=$(gh api "repos/$repo/git/ref/tags/$tag" --jq '.object.type + " " + .object.sha')
  type=${ref% *}; sha=${ref#* }
  if [ "$type" = tag ]; then sha=$(gh api "repos/$repo/git/tags/$sha" --jq '.object.sha'); fi
  names=$(gh api "repos/$repo/tags?per_page=100" --jq ".[] | select(.commit.sha==\"$sha\") | .name" | tr '\n' ' ')
  printf '%-34s %s  # %s\n' "$repo" "$sha" "$names"
done
```
Expected: seven lines whose SHAs equal the table's, each comment listing the semver tag beside the major (e.g. `v4.4.0 v4`). If a SHA differs, the major tag has moved since this plan was written — use the value the command prints and update the table in the same commit, since the point of the exercise is that the tag moves.

- [ ] **Step 2: Write the failing test**

Append to `registry/scripts/tests/repo-guards.test.ts`:

```ts
describe('workflow action pins', () => {
  const workflows = ['.github/workflows/daily.yml', '.github/workflows/plugin.yml']

  it('pins every action to a full commit SHA and names the version in a comment', () => {
    // A major tag is a moving reference, and whoever can move it runs code in
    // a job holding LLM_API_KEY, NPM_TOKEN, STARS_TOKEN and a repo token —
    // pnpm/action-setup, a third-party action, installs the very binary that
    // later runs publish:catalog. The trailing comment is not decoration: it
    // is how the file stays readable, and it is what Dependabot rewrites.
    for (const file of workflows) {
      const uses = [...read(file).matchAll(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)[ \t]*(?:#[ \t]*(\S+))?/gm)]
      expect(uses.length, `${file} declares no actions`).toBeGreaterThan(0)
      for (const match of uses) {
        expect(match[1], `${file}: ${String(match[1])} is not pinned to a 40-hex commit`)
          .toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
        expect(match[2], `${file}: ${String(match[1])} names no version in a trailing comment`)
          .toMatch(/^v\d+\.\d+\.\d+$/)
      }
    }
  })

  it('asks Dependabot to keep the pins current', () => {
    // A SHA pin that nobody bumps is a security patch nobody applies. The
    // weekly PR is the other half of the trade.
    const dependabot = read('.github/dependabot.yml')
    expect(dependabot).toContain('package-ecosystem: github-actions')
    expect(dependabot).toMatch(/interval:\s*weekly/)
  })

  it('uses one SHA per action across both workflows', () => {
    // daily.yml checks out three times and plugin.yml once; four different
    // pins of actions/checkout would be four things to review.
    const byAction = new Map<string, Set<string>>()
    for (const file of workflows) {
      for (const match of read(file).matchAll(/uses:[ \t]*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})/g)) {
        const action = match[1]!
        if (!byAction.has(action)) byAction.set(action, new Set())
        byAction.get(action)!.add(match[2]!)
      }
    }
    for (const [action, shas] of byAction) {
      expect([...shas], `${action} is pinned to more than one commit`).toHaveLength(1)
    }
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts -t "pins every action to a full commit SHA"` — Expected: FAIL with `.github/workflows/daily.yml: actions/checkout@v4 is not pinned to a 40-hex commit`. The Dependabot test fails with `ENOENT: no such file or directory, open '.../.github/dependabot.yml'`.

- [ ] **Step 4: Write the implementation**

In `.github/workflows/daily.yml`, replace each `uses:` line. Before (lines 48-50, and identically at 163-165):

```yaml
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
```

After (both places):

```yaml
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
```

The remaining four, each in place of its tagged form:

```yaml
        uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4.6.2
```
```yaml
        uses: actions/upload-pages-artifact@56afc609e74202658d3ffba0e8f6dda462b719fa # v3.0.1
```
```yaml
        uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4.3.0
```
```yaml
      - uses: actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e # v4.0.5
```

`upload-artifact` appears twice in `daily.yml` (the report upload at line 89 and the dist upload at line 110); both take the same pin.

In `.github/workflows/plugin.yml`, before (lines 18-20):

```yaml
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
```

After:

```yaml
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
```

Create `.github/dependabot.yml`:

```yaml
# SHA-pinned actions are only as current as whoever bumps them, so the pin
# and this file are one decision: the pin removes the moving reference, and
# the weekly PR restores the updates the moving reference used to deliver.
# Dependabot rewrites both the SHA and the `# vX.Y.Z` comment beside it,
# which is why the comment format is part of the convention.
#
# Actions only. The npm dependencies are governed by pnpm-lock.yaml and a
# frozen-lockfile install, and bumping them is a release decision.
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    commit-message:
      prefix: chore(ci)
    groups:
      actions:
        patterns: ['*']
```

- [ ] **Step 5: Run test to verify it passes, then confirm the runtime**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

The test proves the file; the run proves GitHub accepts it. After pushing, read the next run's log — a SHA-pinned action prints its resolved source in the step header:

```sh
gh run list --workflow=plugin.yml --limit 1 --json databaseId,conclusion
gh run view <databaseId> --log | grep -iE 'Download action repository|checkout@|action-setup@' | head
```
Expected: lines naming each action at the pinned commit (`Download action repository 'actions/checkout@11d5960a…'`), and a successful conclusion. A wrong or non-existent SHA fails the run at that step with `Unable to resolve action`, before any of the job's secrets are used.

- [ ] **Step 6: Commit**
```bash
git add .github/workflows/daily.yml .github/workflows/plugin.yml .github/dependabot.yml registry/scripts/tests/repo-guards.test.ts
git commit -m "chore(ci): pin every action to a commit SHA and enable Dependabot"
```

---

### Task 14: The README-pin guard runs on the commits it exists for

**Files:**
- Modify: `.github/workflows/plugin.yml:3-8` (the path filters) and `:22-23` (a root-suite step)
- Test: `registry/scripts/tests/readme-pins.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks. Independent of Task 13, though both edit `plugin.yml` — if both are in flight, land 13 first so the pins are in place when this file is touched again.
- Produces: nothing later tasks consume.

`readme-pins.test.ts` lives in the root suite. `plugin.yml` — the workflow a release commit does trigger, since a release moves `packages/dsh-plugin-shop/package.json` — runs only `pnpm -C packages/dsh-plugin-shop test`. `daily.yml`, which does run the root suite, filters on `registry/**` and the *root* `package.json`. So the one guard written for release commits has never run on one, and the drift it catches was caught instead by the next scheduled build, after `npm publish`. Two fixes, both in `plugin.yml`: run the root suite (three seconds), and trigger on the two root READMEs, which a commit fixing only those would otherwise miss in both workflows.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/readme-pins.test.ts`, inside the existing `describe('README install pins', ...)`:

```ts
  it('runs in the workflow a release commit triggers', () => {
    // This guard exists for release commits and for three releases it never
    // ran on one: plugin.yml (which a release commit DOES trigger, because a
    // release moves packages/dsh-plugin-shop/package.json) ran only the
    // package suite, while daily.yml — the workflow that runs this file —
    // filters on paths a release commit does not touch. Drift was caught by
    // the next scheduled build, after npm publish.
    const plugin = readFileSync(join(repoRoot, '.github', 'workflows', 'plugin.yml'), 'utf8')
    expect(plugin, 'plugin.yml does not run the root suite').toMatch(/^\s+- run: pnpm test$/m)
    for (const readme of READMES) {
      const trigger = readme.startsWith('packages/') ? "'packages/dsh-plugin-shop/**'" : `'${readme}'`
      expect(plugin, `plugin.yml does not trigger on ${readme}`).toContain(trigger)
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/readme-pins.test.ts -t "runs in the workflow a release commit triggers"` — Expected: FAIL with `plugin.yml does not run the root suite: expected '…' to match /^\s+- run: pnpm test$/m`.

- [ ] **Step 3: Write the implementation**

In `.github/workflows/plugin.yml`, before (lines 3-8):

```yaml
on:
  push:
    paths: ['packages/dsh-plugin-shop/**', 'packages/dsh-typert-protocol/**', 'pnpm-workspace.yaml']
  pull_request:
    paths: ['packages/dsh-plugin-shop/**', 'packages/dsh-typert-protocol/**', 'pnpm-workspace.yaml']
  workflow_dispatch:
```

After:

```yaml
on:
  push:
    # The two root READMEs are here because a release commit moves all four
    # install pins together, and readme-pins.test.ts is the guard for exactly
    # that. Without them, a commit fixing only a root README triggers neither
    # workflow: daily.yml filters on registry/** and the root package.json.
    paths: &plugin-inputs
      - 'packages/dsh-plugin-shop/**'
      - 'packages/dsh-typert-protocol/**'
      - 'pnpm-workspace.yaml'
      - 'README.md'
      - 'README.zh.md'
  pull_request:
    paths: *plugin-inputs
  workflow_dispatch:
```

Before (lines 22-23):

```yaml
      - run: pnpm install --frozen-lockfile
      - run: npm install -g @deepseek-ai/dsh@0.1.1-rc.2
```

After:

```yaml
      - run: pnpm install --frozen-lockfile
      # The root suite, three seconds, for one test in it: readme-pins.test.ts
      # guards the four install pins a release commit must move together, and
      # it had never run on a release commit — plugin.yml ran only the package
      # suite and daily.yml's path filter names the ROOT package.json, not the
      # package's. 0.5.0 through 0.5.2 shipped with a README three releases
      # behind because of it.
      - run: pnpm test
      - run: npm install -g @deepseek-ai/dsh@0.1.1-rc.2
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/readme-pins.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`.

Confirm the trigger on the next push that touches the package or a root README:
```sh
gh run list --workflow=plugin.yml --limit 1 --json databaseId,event,conclusion
gh run view <databaseId> --log | grep -E 'Run pnpm test|Tests +[0-9]+ passed' | head
```
Expected: a `Run pnpm test` step whose output reports the root suite's passing count.

- [ ] **Step 5: Commit**
```bash
git add .github/workflows/plugin.yml registry/scripts/tests/readme-pins.test.ts
git commit -m "ci(plugin): run the root suite and watch the root READMEs"
```

---

### Task 15: The build job holds no write credential while it processes hostile input

**Files:**
- Modify: `.github/workflows/daily.yml:30-31` (job permissions), `:44-46` (the job-level `GITHUB_TOKEN`), `:57-70` and `:125-136` (the two commit steps), `:71-87` (the build step's env)
- Test: `registry/scripts/tests/repo-guards.test.ts` (append)

**Interfaces:**
- Consumes: `read()` from `repo-guards.test.ts` (Task 11). **Land plan A's E-2 first** — it rewrites the same two push steps with `git fetch && git rebase origin/main`, and those lines carry through here unchanged.
- Produces: nothing later tasks consume.

The job elevates `GITHUB_TOKEN` to `contents: write` and, through the job-level `env:` block, exports it to every step: `pnpm install` and its lifecycle scripts, the plaintext LLM call, and the harvest of about 8,800 third-party manifests. Only the two steps that push need write. GitHub grants permissions per job and offers no per-step elevation, so there are exactly two shapes of fix:

- **A separate `commit` job with `contents: write`.** No new secret, but the files to commit must travel as artifacts, and the classifier's commit — which today happens *before* the build precisely so a failed build still preserves the LLM's verdicts (`daily.yml:60-63`) — would move after it. That behaviour is load-bearing: an uncommitted market verdict is not a memory, the name is re-asked every run, and one bad roll then gets recorded forever.
- **A narrowly-scoped credential in the two push steps' own `env:`.** No restructure, no artifact plumbing, the classifier's commit stays where it is, and plan A's rebase lines are untouched. Cost: a fine-grained PAT a human must create and rotate.

**This task takes the second**, because it preserves the ordering guarantee and because a step-level `env:` is exactly the scope wanted: after it, the only steps that ever hold a write credential are two git-only steps that touch no third-party data.

**Non-mechanical prerequisite:** a repository secret `REGISTRY_PUSH_TOKEN` must exist before this lands, holding a fine-grained PAT scoped to this repository alone with `Contents: read and write` and nothing else. Creating it needs a human at github.com; a GitHub App installation token would be better still (short-lived) but costs a third-party action and two more secrets. Until the secret exists, the push steps fail with an empty token — they are `continue-on-error: true`, so the catalog still publishes and the snapshot commit is simply skipped, which is the same failure mode a rejected push already has.

- [ ] **Step 1: Verification procedure (not a vitest file)**

Confirm today's exposure before changing it, read-only:

```sh
gh api repos/LivXue/dsh-plugin-shop/contents/.github/workflows/daily.yml --jq .content \
  | base64 -d | sed -n '28,47p'
```
Expected: the `build` job's `permissions: contents: write` at the top and `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` inside the job-level `env:` block — the write token in every step's environment.

Then confirm the secret exists (names only; values are never readable):
```sh
gh secret list --repo LivXue/dsh-plugin-shop
```
Expected: `REGISTRY_PUSH_TOKEN` among the rows. If it is absent, stop and get it created — the rest of this task is safe to land without it (the pushes degrade to skipped), but it should be a deliberate choice, not a surprise.

After the change lands, the runtime grant is only visible in the run log, so read it there:
```sh
gh run list --workflow=daily.yml --limit 1 --json databaseId,conclusion
gh run view <databaseId> --log | grep -A9 'GITHUB_TOKEN Permissions'
```
Expected: `Contents: read` and nothing else granted to the `build` job. That line is the fact; the guard test below only pins the file that produces it.

- [ ] **Step 2: Write the failing test**

Append to `registry/scripts/tests/repo-guards.test.ts`:

```ts
describe('what the build job is allowed to hold', () => {
  const buildJob = (): string => {
    const text = read('.github/workflows/daily.yml')
    const start = text.indexOf('\n  build:')
    const end = text.indexOf('\n  publish:')
    expect(start, 'daily.yml has no build job').toBeGreaterThan(-1)
    expect(end, 'daily.yml has no publish job to bound the build job').toBeGreaterThan(start)
    return text.slice(start, end)
  }
  /** Comment lines dropped: these guards are about what the workflow DOES,
   * and the comments beside each rule name the very strings being forbidden
   * (`contents: write`, `GITHUB_TOKEN`) to explain why. Matching on prose
   * would make a correct file fail and invite someone to delete the prose. */
  const effective = (yaml: string): string =>
    yaml.split('\n').filter(line => !line.trim().startsWith('#')).join('\n')

  it('grants the build job read-only contents', () => {
    // `contents: write` was in scope for pnpm install's lifecycle scripts,
    // the plaintext LLM call, and the harvest of ~8,800 hostile manifests.
    expect(effective(buildJob())).toMatch(/permissions:\n\s+contents: read\n/)
    expect(effective(buildJob())).not.toContain('contents: write')
  })

  it('scopes the write credential to exactly the two steps that push', () => {
    // GitHub has no per-step permission elevation, so the write credential is
    // a separate secret placed in two steps' own env: blocks. Two pushes, two
    // declarations — a third would mean a step gained it by accident.
    const job = effective(buildJob())
    expect([...job.matchAll(/GIT_PUSH_TOKEN: /g)]).toHaveLength(2)
    expect([...job.matchAll(/^\s+git push /gm)]).toHaveLength(2)
    // Every push authenticates with that credential, never with a persisted
    // token that no longer has write.
    for (const line of job.split('\n').filter(l => l.trim().startsWith('git push '))) {
      expect(line, `a push does not use GIT_PUSH_TOKEN: ${line.trim()}`).toContain('${GIT_PUSH_TOKEN}')
    }
  })

  it('gives GITHUB_TOKEN only to the step that reads GitHub', () => {
    // The job-level env: block was what put the token in every step. Only
    // build.ts reads GITHUB_TOKEN (classify.ts reads NPM_TOKEN and LLM_* and
    // never touches the GitHub API), so it belongs on that one step.
    const job = effective(buildJob())
    const jobEnv = job.slice(job.indexOf('    env:'), job.indexOf('    steps:'))
    expect(jobEnv, 'the job-level env still exports GITHUB_TOKEN to every step').not.toContain('GITHUB_TOKEN')
    expect(job).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts -t "grants the build job read-only contents"` — Expected: FAIL with `expected '\n  build:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n…' to match /permissions:\n\s+contents: read\n/`.

- [ ] **Step 4: Write the implementation**

In `.github/workflows/daily.yml`, before (lines 28-46):

```yaml
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    env:
      # Optional read-only npm token; lifts the search API's per-IP rate
      # limit onto the token. Empty (e.g. on fork PRs) = unauthenticated.
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
      # LLM classifier (categories.yml). The key is a secret; an empty value
      # (fork PRs) skips classification — the classify step is designed for it.
      # The gateway serves plain HTTP only (no TLS listener) — the Bearer key
      # rides plaintext on the runner→gateway path; rotate-able key, gateway
      # owner's transport choice. Switch to https when the mirror gains TLS.
      LLM_BASE_URL: http://8.141.31.123:3000/v1
      LLM_MODEL: deepseek-v4-flash
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      # GitHub star counts (public GraphQL). Empty on forks/local runs; the
      # stars step skips and the catalog publishes without them.
      GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

After:

```yaml
  build:
    runs-on: ubuntu-latest
    # Read-only. GitHub grants permissions per JOB and has no per-step
    # elevation, so `contents: write` here meant a write token was in scope for
    # pnpm install's lifecycle scripts, the plaintext LLM call, and the harvest
    # of ~8,800 third-party manifests. The two steps that push carry their own
    # narrowly-scoped credential instead (see below). The comment sits above
    # the block, not inside it, so the guard test can match the two lines.
    permissions:
      contents: read
    env:
      # Optional read-only npm token; lifts the search API's per-IP rate
      # limit onto the token. Empty (e.g. on fork PRs) = unauthenticated.
      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
      # LLM classifier (categories.yml). The key is a secret; an empty value
      # (fork PRs) skips classification — the classify step is designed for it.
      # The gateway serves plain HTTP only (no TLS listener) — the Bearer key
      # rides plaintext on the runner→gateway path; rotate-able key, gateway
      # owner's transport choice. Switch to https when the mirror gains TLS.
      LLM_BASE_URL: http://8.141.31.123:3000/v1
      LLM_MODEL: deepseek-v4-flash
      LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
      # GITHUB_TOKEN is deliberately NOT here. Only build.ts reads it (the
      # repo harvest and the stars fallback); classify.ts reads NPM_TOKEN and
      # LLM_* and never touches the GitHub API. A job-level env: block is
      # every step's environment, which is how a credential ends up somewhere
      # nobody meant it to be.
```

Before (lines 57-70):

```yaml
      - name: Commit the classifier's output
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        # markets.yml as well as categories.yml. The classify step writes both,
        # and a market verdict that is not committed is not a memory: the name
        # would be re-asked every run, which is the flip-flop the file exists to
        # prevent — and one bad roll would then be recorded forever.
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/categories.yml registry/markets.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): llm classifier update"
          git push
```

After (if plan A's E-2 has landed, keep its `git fetch && git rebase origin/main` lines exactly where they are and change only the `env:` block and the final `git push` line):

```yaml
      - name: Commit the classifier's output
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        env:
          # A fine-grained PAT scoped to this repository with Contents:
          # read and write, and nothing else. This step and the snapshot
          # commit below are the ONLY two that hold a write credential;
          # everything between them runs with a read-only token. Actions masks
          # a registered secret in the log, including inside the push URL.
          GIT_PUSH_TOKEN: ${{ secrets.REGISTRY_PUSH_TOKEN }}
        # markets.yml as well as categories.yml. The classify step writes both,
        # and a market verdict that is not committed is not a memory: the name
        # would be re-asked every run, which is the flip-flop the file exists to
        # prevent — and one bad roll would then be recorded forever.
        #
        # This commit stays BEFORE the build for that reason: a failed build
        # must not discard the classifier's verdicts. That ordering is why the
        # credential is scoped per step rather than moved to a separate job.
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/categories.yml registry/markets.yml
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): llm classifier update"
          git push "https://x-access-token:${GIT_PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:${GITHUB_REF_NAME}"
```

Before (lines 125-136):

```yaml
      - name: Commit the snapshot
        # push included: the repo-state.json backfill memory must persist
        # across push-triggered runs, or every run restarts from empty.
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/snapshots/manifest.lock registry/repo-state.json
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): daily catalog snapshot"
          git push
```

After (same rule about plan A's rebase lines):

```yaml
      - name: Commit the snapshot
        # push included: the repo-state.json backfill memory must persist
        # across push-triggered runs, or every run restarts from empty.
        if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch' || github.event_name == 'push'
        continue-on-error: true
        env:
          # The second and last step holding a write credential.
          GIT_PUSH_TOKEN: ${{ secrets.REGISTRY_PUSH_TOKEN }}
        run: |
          git config user.name 'dsh-plugin-shop bot'
          git config user.email 'bot@users.noreply.github.com'
          git add registry/snapshots/manifest.lock registry/repo-state.json
          git diff --cached --quiet && exit 0
          git commit -m "chore(registry): daily catalog snapshot"
          git push "https://x-access-token:${GIT_PUSH_TOKEN}@github.com/${GITHUB_REPOSITORY}.git" "HEAD:${GITHUB_REF_NAME}"
```

Finally, give `GITHUB_TOKEN` to the one step that reads it. Before (lines 71-87, the `env:` block of the build step):

```yaml
      - run: pnpm build:catalog -- --harvest-from dist/harvest.json
        env:
```

After:

```yaml
      - run: pnpm build:catalog -- --harvest-from dist/harvest.json
        env:
          # The GitHub API's quota key for the repo harvest, and the stars
          # fallback when STARS_TOKEN is unset. On this step alone: it used to
          # sit in the job-level env: and reach every step.
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

(leave the four existing entries — `SHOP_HARVEST_REPOS`, `SHOP_HARVEST_SUBPACKAGES`, `SHOP_CATALOG_V5`, `STARS_TOKEN` — and their comments in place beneath it).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts` — Expected: PASS.
Then `pnpm test` and `pnpm typecheck`, then the `gh run view … | grep -A9 'GITHUB_TOKEN Permissions'` read from Step 1 on the first run after the push.

- [ ] **Step 6: Commit**
```bash
git add .github/workflows/daily.yml registry/scripts/tests/repo-guards.test.ts
git commit -m "ci(daily): read-only contents for the build job, write only in the push steps"
```

---

### Task 16: No `workspace:` in the published manifest, and the vendored copy cannot drift

**Files:**
- Modify: `CLAUDE.md` (the "Release channels" section)
- Modify: `packages/dsh-typert-protocol/package.json` (remove the dead `./typert` export and its two `files` entries)
- Modify: `packages/dsh-typert-protocol/VENDORED.md` (drop the `./typert` claim)
- Test: `registry/scripts/tests/repo-guards.test.ts` (append)

**Interfaces:**
- Consumes: `read()` and `repoRoot` from `repo-guards.test.ts` (Task 11).
- Produces: nothing later tasks consume.

Two defects in one place. `npm view dsh-plugin-shop@0.7.4 devDependencies` shows `"@deepseek-ai/dsh-typert-protocol": "workspace:^0.1.1-rc.2"`: `npm publish` ships the workspace protocol verbatim, where `pnpm publish` and `pnpm pack` replace it with the resolved range. The specifier cannot simply be un-workspaced — pnpm 11 does not link a workspace member from a plain range, and the typert generator only recognises `@Remote` symbols declared in a workspace package under `packages/` — so the fix is the publish tool, coupled to the specifier by a guard.

And the vendored copy has drifted: `packages/dsh-typert-protocol/package.json` declares an export `"./typert"` pointing at `./lib/typert.host.js` and `./lib/typert.host.d.ts`, and lists both in `files`. Neither file exists — the vendored `lib/` holds `index.js`, `invariant.js` and `types/` only — and nothing in the repository imports `@deepseek-ai/dsh-typert-protocol/typert` (grepped: zero hits). The export is dead and points at nothing, which is exactly the drift E-10 says has no check. It goes, along with the `files` entries and VENDORED.md's claim about it; the package is `private: true` and never published, so `files` is inert either way.

- [ ] **Step 1: Verification procedure, then the failing test**

First reproduce both halves locally. No publish, no network:

```sh
cd packages/dsh-plugin-shop
npm pack --pack-destination /tmp 2>/dev/null | tail -1
tar -xzOf /tmp/dsh-plugin-shop-*.tgz package/package.json | grep 'typert-protocol'
pnpm pack --pack-destination /tmp 2>/dev/null | tail -1
tar -xzOf /tmp/dsh-plugin-shop-*.tgz package/package.json | grep 'typert-protocol'
```
Expected: the `npm pack` manifest carries `"workspace:^0.1.1-rc.2"`; the `pnpm pack` one carries `"^0.1.1-rc.2"`. That is the whole finding, and it is why the release tool is the fix. (Only `package.json` matters here, so a stale `lib/` is fine — but for a real release, `rm -rf lib && pnpm build` comes first, or the tarball ships old code under a new version.) Clean up: `rm -f /tmp/dsh-plugin-shop-*.tgz`.

Then confirm the dead export:
```sh
ls packages/dsh-typert-protocol/lib
grep -rn 'dsh-typert-protocol/typert' --include='*.ts' --include='*.json' --include='*.md' . | grep -v node_modules
```
Expected: `index.js invariant.js types` — no `typert.host.js` — and no hits for the specifier anywhere.

Now append to `registry/scripts/tests/repo-guards.test.ts`:

```ts
describe('the published shop manifest', () => {
  const pkg = JSON.parse(read('packages/dsh-plugin-shop/package.json')) as {
    devDependencies?: Record<string, string>
  }

  it('declares the vendored protocol with the workspace protocol', () => {
    // Load-bearing: pnpm 11 does not link a workspace member from a plain
    // range, and the typert generator only recognises @Remote symbols
    // declared in a workspace package under packages/ (VENDORED.md).
    expect(pkg.devDependencies?.['@deepseek-ai/dsh-typert-protocol']).toMatch(/^workspace:/)
  })

  it('is released with the tool that rewrites that specifier', () => {
    // `npm publish` shipped `workspace:^0.1.1-rc.2` into the published
    // manifest of 0.7.4 (measured with npm view); `pnpm publish` and
    // `pnpm pack` resolve it. The specifier above and the release command
    // are one decision, and this is the coupling that keeps them agreeing.
    const claude = read('CLAUDE.md')
    const release = claude.slice(claude.indexOf('## Release channels'))
    expect(release, 'CLAUDE.md has no Release channels section').not.toBe('')
    expect(release).toContain('pnpm publish --tag beta')
    expect(release, 'a bare `npm publish` would ship the workspace: specifier').not.toMatch(/^npm publish/m)
  })
})

describe('the vendored typert protocol', () => {
  const pkg = JSON.parse(read('packages/dsh-typert-protocol/package.json')) as {
    version: string
    exports: Record<string, unknown>
    files?: string[]
  }

  it('records the same version in VENDORED.md and package.json', () => {
    // A re-sync replaces lib/ and bumps the version; recording one without
    // the other leaves the copy claiming to be something it is not, and
    // nothing checked.
    const match = /@deepseek-ai\/dsh-typert-protocol@(\S+?)`/.exec(read('packages/dsh-typert-protocol/VENDORED.md'))
    expect(match?.[1], 'VENDORED.md names no source version').toBeDefined()
    expect(match?.[1]).toBe(pkg.version)
  })

  it('ships every lib file its exports and files list name', () => {
    // The `./typert` export pointed at lib/typert.host.js and
    // lib/typert.host.d.ts, neither of which was ever copied in — dead, and
    // undetectable because nothing imports the specifier either.
    const named = new Set<string>([
      ...[...JSON.stringify(pkg.exports).matchAll(/"\.\/(lib\/[^"*]+)"/g)].map(m => m[1]!),
      ...(pkg.files ?? []).filter(entry => !entry.includes('*')),
    ])
    expect(named.size).toBeGreaterThan(0)
    for (const target of named) {
      expect(
        existsSync(join(repoRoot, 'packages/dsh-typert-protocol', target)),
        `${target} is named by the vendored manifest but missing from the copy`,
      ).toBe(true)
    }
  })
})
```

Add `existsSync` to the `node:fs` import at the top of `repo-guards.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts -t "ships every lib file its exports and files list name"` — Expected: FAIL with `lib/typert.host.js is named by the vendored manifest but missing from the copy: expected false to be true`.
Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts -t "is released with the tool that rewrites that specifier"` — Expected: FAIL with `expected '## Release channels\n\nnpm carries two dist-tags…' to contain "pnpm publish --tag beta"`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-typert-protocol/package.json`, remove the dead export — before:

```json
    "./src/*": "./src/*",
    "./package.json": "./package.json",
    "./typert": {
      "types": "./lib/typert.host.d.ts",
      "default": "./lib/typert.host.js"
    }
  },
```

After:

```json
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
```

And the two dead `files` entries — before:

```json
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/types/**/*.js",
    "lib/types/**/*.d.ts",
    "lib/typert.host.js",
    "lib/typert.host.d.ts"
  ],
```

After:

```json
  "files": [
    "lib/index.js",
    "lib/invariant.js",
    "lib/types/**/*.js",
    "lib/types/**/*.d.ts"
  ],
```

In `packages/dsh-typert-protocol/VENDORED.md`, before:

```markdown
Vendored from `@deepseek-ai/dsh-typert-protocol@0.1.1-rc.2` (MIT): the compiled
`lib/` exactly as shipped on npm, its `LICENSE`, and the original manifest plus
a `./typert` export. This copy exists for the typert build; it is never
published.
```

After:

```markdown
Vendored from `@deepseek-ai/dsh-typert-protocol@0.1.1-rc.2` (MIT): the compiled
`lib/` exactly as shipped on npm, its `LICENSE`, and the original manifest.
This copy exists for the typert build; it is never published.

A `./typert` export was added here at some point pointing at
`lib/typert.host.js` and `lib/typert.host.d.ts`. Neither file was ever copied
in and nothing imports the specifier, so both the export and its `files`
entries were removed on 2026-09-03. `registry/scripts/tests/repo-guards.test.ts`
now asserts that every path this manifest names exists, so a partial re-sync
fails a test instead of sitting here unnoticed.
```

In `CLAUDE.md`, before (the "Release channels" code block):

```sh
pnpm -C packages/dsh-plugin-shop test       # includes the live-harness e2e
pnpm -C packages/dsh-plugin-shop typecheck
npm publish --tag beta                      # X.Y.Z-beta.N — latest untouched
# install that build on a real profile and use the thing that changed, then:
npm publish                                 # X.Y.Z — moves latest
```

After:

```sh
pnpm -C packages/dsh-plugin-shop test       # includes the live-harness e2e
pnpm -C packages/dsh-plugin-shop typecheck
rm -rf packages/dsh-plugin-shop/lib && pnpm -C packages/dsh-plugin-shop build
cd packages/dsh-plugin-shop
pnpm publish --tag beta                     # X.Y.Z-beta.N — latest untouched
# install that build on a real profile and use the thing that changed, then:
pnpm publish                                # X.Y.Z — moves latest
```

and add this paragraph immediately after that block:

```markdown
**`pnpm publish`, never `npm publish`.** The package declares the vendored
protocol as `workspace:^0.1.1-rc.2` — load-bearing, because pnpm 11 does not
link a workspace member from a plain range and the typert generator only
recognises `@Remote` symbols declared in a workspace package under
`packages/`. `npm publish` ships that specifier verbatim: 0.7.4's published
manifest carries `workspace:^0.1.1-rc.2` today, which is inert for consumers
and breaks anything that resolves the manifest. `pnpm publish` rewrites it to
the resolved range. `pnpm publish` also refuses a dirty tree, which is a
feature — and the `rm -rf lib && build` above it is not optional: `test` and
`typecheck --noEmit` both skip `lib/`, so a pack from a stale `lib/` ships old
code under a new version number.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts` — Expected: PASS.
Then prove the removed export was genuinely dead — this is the only thing standing behind that deletion:
```sh
rm -rf packages/dsh-plugin-shop/lib
pnpm -C packages/dsh-plugin-shop build
pnpm -C packages/dsh-plugin-shop typecheck
pnpm -C packages/dsh-plugin-shop test
```
Expected: all three succeed. The typert generator runs inside `build`, so a build that still passes is the evidence that nothing resolved `@deepseek-ai/dsh-typert-protocol/typert`.
Then `pnpm test` and `pnpm typecheck` at the root.

- [ ] **Step 5: Commit**
```bash
git add CLAUDE.md packages/dsh-typert-protocol/package.json packages/dsh-typert-protocol/VENDORED.md registry/scripts/tests/repo-guards.test.ts
git commit -m "fix(release): publish with pnpm and pin the vendored copy against VENDORED.md"
```

---

### Task 17: `.gitignore` covers the agent directory, dotenv variants and tarballs

**Files:**
- Modify: `.gitignore`
- Test: `registry/scripts/tests/repo-guards.test.ts` (append)

**Interfaces:**
- Consumes: `repoRoot` from `repo-guards.test.ts` (Task 11).
- Produces: nothing later tasks consume.

`.raven/` is 4.4 MB, untracked and unignored, and contains `shadow.git` — so a `git add -A` commits somebody's agent scratch state into the repository. `.env` is ignored but `.env.*` is not, so `.env.local` and friends are one `git add -A` from being published. `*.tgz` is not ignored either, and `npm pack`/`pnpm pack` drop one in the package directory during a release.

**The exception matters:** `packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz` is a deliberately tracked fixture. A `.gitignore` rule does not untrack an already-tracked file, so nothing breaks without the negation — but a modification to an ignored-but-tracked file behaves confusingly, and a future `git rm --cached` plus re-add would silently drop the fixture. The negation states the intent and the test proves it.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/repo-guards.test.ts` (add `execFileSync` to the imports):

```ts
describe('what git is allowed to pick up', () => {
  /** `git check-ignore` exits 0 when the path is ignored, 1 when it is not.
   * Asked of git rather than parsed out of .gitignore, because the pattern
   * that matters is the one git actually applies — including the negation. */
  const ignored = (path: string): boolean => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: repoRoot, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  it('ignores the agent scratch directory', () => {
    // 4.4 MB containing shadow.git, untracked AND unignored: one `git add -A`
    // from being committed.
    expect(ignored('.raven/NOTICE.txt')).toBe(true)
    expect(ignored('.raven/shadow.git')).toBe(true)
  })

  it('ignores every dotenv variant, not just the bare name', () => {
    // `.env` was covered; `.env.local` and `.env.production` were not.
    for (const file of ['.env', '.env.local', '.env.production', '.env.test.local']) {
      expect(ignored(file), `${file} is not ignored`).toBe(true)
    }
  })

  it('ignores packed tarballs but keeps the tracked fixture', () => {
    // `npm pack` drops one in the package directory during every release.
    // The fixture is deliberately tracked, so the negation states that and
    // this asserts it: an ignore rule does not untrack a tracked file, but a
    // later `git rm --cached` plus re-add would silently drop it.
    expect(ignored('packages/dsh-plugin-shop/dsh-plugin-shop-9.9.9.tgz')).toBe(true)
    expect(ignored('some-package.tgz')).toBe(true)
    expect(ignored('packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz')).toBe(false)
  })

  it('keeps the fixture tarball tracked', () => {
    // The negation is worthless if the file it exempts stopped being tracked.
    const tracked = execFileSync('git', ['ls-files', 'packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(tracked.trim()).toBe('packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts -t "ignores the agent scratch directory"` — Expected: FAIL with `expected false to be true`. The dotenv test fails on `.env.local is not ignored`, and the tarball test on `some-package.tgz`.

- [ ] **Step 3: Write the implementation**

Before (`.gitignore`, in full):

```gitignore
node_modules/
lib/
# The vendored typert protocol's compiled lib/ is committed (VENDORED.md).
!packages/dsh-typert-protocol/lib/
!packages/dsh-typert-protocol/lib/**
dist/
*.tsbuildinfo
.env
.DS_Store
.playwright-mcp/
.claude/settings.local.json
.claude/worktrees/
```

After:

```gitignore
node_modules/
lib/
# The vendored typert protocol's compiled lib/ is committed (VENDORED.md).
!packages/dsh-typert-protocol/lib/
!packages/dsh-typert-protocol/lib/**
dist/
*.tsbuildinfo
# Every dotenv variant, not just the bare name: `.env.local` and
# `.env.production` were one `git add -A` from being published.
.env
.env.*
.DS_Store
# `npm pack` and `pnpm pack` drop a tarball in the package directory during
# every release. The fixture below is deliberately tracked — an ignore rule
# does not untrack an already-tracked file, so this negation is a statement of
# intent that a guard test asserts, and it survives a `git rm --cached`.
*.tgz
!packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz
# Agent scratch state: 4.4 MB including shadow.git, and nobody's to commit.
.raven/
.playwright-mcp/
.claude/settings.local.json
.claude/worktrees/
```

The two `!packages/dsh-typert-protocol/lib` negations and the four `.claude`/`.playwright-mcp` lines are unchanged; the block shows them so the file above can be replaced wholesale rather than patched by hand.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-guards.test.ts` — Expected: PASS.
Then confirm the working tree agrees, and that nothing tracked became invisible:
```sh
git status --porcelain | grep -E '\.raven|\.tgz|\.env' || echo 'clean'
git ls-files | grep -c '\.tgz$'
```
Expected: `clean` from the first (`.raven/` no longer appears as untracked), and `1` from the second — the fixture is still tracked.
Then `pnpm test` and `pnpm typecheck`.

- [ ] **Step 5: Commit**
```bash
git add .gitignore registry/scripts/tests/repo-guards.test.ts
git commit -m "chore: ignore .raven, dotenv variants and packed tarballs"
```

---

### Task 18: Loader errors name the package, the empty document and the BOM

**Files:**
- Modify: `registry/scripts/src/config.ts:77-91` (`parseFile`)
- Test: `registry/scripts/tests/config.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing later tasks consume. `parseFile` stays module-private.

Reproduced at HEAD, all three:

| Input | Message today |
|---|---|
| a `verified.yml` row missing `reviewer` | `verified.yml: 1.reviewer Invalid input: expected string, received undefined` |
| a comments-only file | `verified.yml: expected a YAML list, got object` |
| a UTF-8 BOM before `- ` | `Unexpected scalar at node end at line 1, column 4` |

The first names a zero-based row index where the reader needs the package name; the second reports `object` because `parse('')` returns `null` and `typeof null === 'object'`; the third does not name the file at all, and the caret points at column 4 of a line that looks correct. The file stays fatal in every case — a malformed registry file must stop the build — but the message has to say what to fix.

The existing assertions constrain the new format: `config.test.ts:104` matches `/reviewedVersion.*reviewedCommit.*reviewedSha256/`, `:136` and `:214` and `:225` match `/list/`, `:187` matches `/categories\.yml/`, `:210` matches `/first-seen\.yml/`. All four survive the format below.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/config.test.ts`, inside `describe('parseRegistryConfig', ...)`:

```ts
  it('names the package, not the row index, when a row is malformed', () => {
    // `verified.yml: 1.reviewer Invalid input` makes a reader count rows in a
    // file that will one day have hundreds. The name is what they are
    // looking for, and it is right there in the row.
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-good\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n'
        + '- name: dsh-missing-reviewer\n  reviewedVersion: 1.0.0\n  reviewCommit: c\n',
    })).toThrow(/verified\.yml: row 2 \(dsh-missing-reviewer\).*reviewer/s)
  })

  it('names the package on a whole-row refinement failure too', () => {
    // The refine's issue path is the row index alone, so the name has to come
    // from the row rather than from the path.
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-unpinned\n  reviewer: r\n  reviewCommit: c\n',
    })).toThrow(/verified\.yml: row 1 \(dsh-unpinned\).*reviewedVersion.*reviewedCommit.*reviewedSha256/s)
  })

  it('falls back to the row index when the row carries no usable name', () => {
    // allowed-similar.yml is a list of plain strings, and a malformed
    // verified row can be a scalar too. No name to print, so say so.
    expect(() => parseRegistryConfig({ ...empty, allowedSimilar: '- 42\n' }))
      .toThrow(/allowed-similar\.yml: row 1 /)
  })

  it('says the file is empty rather than reporting a YAML object', () => {
    // `parse('')` and `parse('# comment\n')` both return null, and
    // `typeof null === 'object'`, so the message accused the file of being a
    // map. It stays fatal — a malformed registry file must stop the build —
    // but it now says what to write.
    for (const text of ['', '# nothing here\n', '\n\n']) {
      expect(() => parseRegistryConfig({ ...empty, verified: text }), `${JSON.stringify(text)} must name the emptiness`)
        .toThrow(/verified\.yml: the file has no YAML document.*\[\]/s)
    }
  })

  it('parses a file whose first line carries a UTF-8 BOM', () => {
    // An editor that writes a BOM produced `Unexpected scalar at node end at
    // line 1, column 4` — no file name, and a caret pointing into a line that
    // looks correct. A BOM is an encoding marker, not content.
    const config = parseRegistryConfig({
      ...empty,
      verified: '\ufeff- name: dsh-bom\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
    })
    expect(config.verified.get('dsh-bom')?.reviewedVersion).toBe('1.0.0')
  })

  it('still names the file when the document is a map instead of a list', () => {
    // Unchanged behaviour, re-asserted so the null special-case above does
    // not swallow the genuine wrong-shape message.
    expect(() => parseRegistryConfig({ ...empty, denied: 'name: x\n' }))
      .toThrow(/denied\.yml: expected a YAML list, got object/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/config.test.ts -t "names the package, not the row index, when a row is malformed"` — Expected: FAIL with `expected [Function] to throw error matching /verified\.yml: row 2 \(dsh-missing-reviewer\).*reviewer/ but got 'verified.yml: 1.reviewer Invalid input: expected string, received undefined'`.

- [ ] **Step 3: Write the implementation**

Before (`registry/scripts/src/config.ts:77-91`):

```ts
/**
 * Parse one file, failing loudly with the file's name in the message. A
 * malformed registry file must stop the build: silently listing nothing looks
 * identical to an empty ecosystem.
 */
function parseFile<T>(label: string, text: string, schema: z.ZodType<T>): T {
  const raw: unknown = parse(text)
  if (!Array.isArray(raw)) throw new Error(`${label}: expected a YAML list, got ${typeof raw}`)
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue === undefined ? '' : issue.path.join('.')
  const message = issue === undefined ? 'invalid' : issue.message
  throw new Error(`${label}: ${path} ${message}`)
}
```

After:

```ts
/**
 * Parse one file, failing loudly with the file's name in the message. A
 * malformed registry file must stop the build: silently listing nothing looks
 * identical to an empty ecosystem.
 *
 * The message is the whole product of this function, because its reader is a
 * human with a broken file. Three things it used to get wrong: a row was
 * identified by its zero-based index rather than by the package name sitting
 * in it; an empty or comments-only file was reported as `got object`, since
 * `parse('')` is `null` and `typeof null === 'object'`; and a leading UTF-8
 * BOM failed inside the YAML parser as `Unexpected scalar at node end at line
 * 1, column 4`, naming no file and pointing at a line that looks correct.
 */
function parseFile<T>(label: string, text: string, schema: z.ZodType<T>): T {
  // A BOM is an encoding marker, not content. yaml 2.9 reads it as part of
  // the first token and fails several characters later.
  const raw: unknown = parse(text.replace(/^\ufeff/, ''))
  if (raw === null || raw === undefined) {
    throw new Error(`${label}: the file has no YAML document (it is empty, or only comments); write [] for an empty list`)
  }
  if (!Array.isArray(raw)) throw new Error(`${label}: expected a YAML list, got ${typeof raw}`)
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  if (issue === undefined) throw new Error(`${label}: invalid`)
  // The first path segment is the row index for every schema here (they are
  // all arrays), so the row can be looked up and named. A refinement failure
  // has ONLY that segment, which is exactly the case where the index alone
  // told the reader least.
  const [first, ...rest] = issue.path
  const row = typeof first === 'number' ? raw[first] : undefined
  const name = typeof row === 'object' && row !== null && typeof (row as { name?: unknown }).name === 'string'
    ? (row as { name: string }).name
    : undefined
  const where = typeof first === 'number'
    ? `row ${first + 1}${name === undefined ? '' : ` (${name})`}`
    : issue.path.join('.')
  const field = typeof first === 'number' ? rest.join('.') : ''
  throw new Error([label + ':', where, field, issue.message].filter(part => part !== '').join(' '))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/config.test.ts` — Expected: PASS, all 29 pre-existing tests included. The four whose regexes constrain the format (`:104`, `:136`, `:187`, `:210`, `:214`, `:225`) are the ones to watch.
Then `pnpm test` and `pnpm typecheck`.

Then check the message against the real files, which is the case that matters:
```sh
node --experimental-strip-types -e "
  const { loadRegistryConfig } = await import('./registry/scripts/src/config.ts')
  const config = loadRegistryConfig('registry')
  console.log('verified', config.verified.size, 'denied', config.denied.size, 'categories', config.categories.size, 'firstSeen', config.firstSeen.size)
"
```
Expected: the live counts load without throwing — `verified 0 denied 0 categories <n> firstSeen <n>`. `registry/verified.yml` ends in an explicit `[]` after its comment block, so the new empty-document branch does not fire on it.

- [ ] **Step 5: Commit**
```bash
git add registry/scripts/src/config.ts registry/scripts/tests/config.test.ts
git commit -m "fix(config): loader errors name the package, the empty file and the BOM"
```

---

## Finding to task

| Finding | Task | Ships as |
|---|---|---|
| D-3 (non-404 is `fetch-failed`) | 1 | daily build |
| D-3 (a `no-manifest` retires its stale candidate) | 2 | daily build |
| D-3 (the 1,918 committed records) | 3 | a data commit; the next run re-fetches them |
| D-4 (raw count, `incomplete_results`, probe reconciliation) | 4 | daily build |
| D-4 (no false `repo-gone`, no state loss) | 5 | daily build |
| D-9 (catch the search parse, cap both bodies) | 6 | daily build |
| C-7 (`REPO_BACKFILL_BUDGET`) | 7 | daily build |
| E-9 / D-8 (the retry's options) | 8 | daily build |
| C-3 (sidecar from accepted entries; pure serialiser) | 9 | daily build |
| A-9 (controls and bidi in report cells) | 10 | daily build |
| C-4 / E-8 (stage only the spec'd files; `harvest.json` out of `v1/`) | 11 | daily build + workflow |
| C-5 (the pointer's cache window) | 12 | docs; host fix handed to plan D |
| E-4 (SHA-pinned actions, Dependabot) | 13 | workflow |
| E-6 (the root suite on a release commit) | 14 | workflow |
| E-7 (`contents: read`, write only in the push steps) | 15 | workflow + a new secret |
| E-10 (`workspace:` in the published manifest; vendored drift) | 16 | CLAUDE.md + the next package release |
| E-11 (`.gitignore`) | 17 | repository hygiene |
| E-12 (loader error messages) | 18 | daily build |

## Suggested order

Tasks 1 through 9 are independent of the workflow and ship on a daily build; run them in order, since 2 depends on 1's classification and 3 must follow both. Task 5 depends on Task 4. Tasks 10 and 11 are next (11 changes `daily.yml`, so it wants the guard-test file it creates). Then 13, 14, 15 in that order — 15 last of the three because it rewrites steps plan A also touches. Tasks 12, 16, 17 and 18 are independent of everything and can go anywhere.

## Deliberately not changed

- **`probeTotal` and `searchPage` in `github-client.ts` still call `response.json()` uncaught,** so a non-JSON 200 from the GitHub search API throws a bare `SyntaxError` — the same class as D-9, on the other client. No finding covers it and inventing the work would put an unreviewed change in the harvest's hottest path. D-5 (plan A) is already opening these functions for timeouts; it is the natural place to add it.

> **Struck 2026-09-04.** Task 8 of plan A opened `fetchRobust`, `fetchRepoCandidate`, `probeSubpackageCandidates` and `harvestRepos` — never `probeTotal` or `searchPage`, so this was never going to arrive that way. The concern is moot regardless: both now route through `readSearchBody` (`github-client.ts:245`), which catches the parse. Do not presume this done because of D-5.
- **`fetch-failed` remains in `RepoStateEntry.failure`'s union** even though `harvestRepos` no longer writes it (Task 2). The union has to keep parsing a committed file that may contain one, and narrowing it would make `parseRepoState` throw on a state file it wrote itself.
- **The gate runs twice per build** after Task 9. Stated with its cost in that task; collapsing it would leave `runPipeline` exercised only by tests.
- **`dist/v1` is not cleaned by the build** (Task 11), because it is how the classifier's harvest and the two reports reach their consumers. Only `dist/pages` is rebuilt from scratch.
- **The GraphQL stars ask stays a single batch fetch**; Task 9 narrows *what* it asks for, not how. The 152 catalog entries with no count are a coverage question about the ask, not about the assembly, and no finding covers it.

## Self-review

Checked before this plan was finished:

1. **Every finding has a task.** All 17 ids in the scope line — D-3, D-4, D-9, C-7, E-9, D-8, C-3, C-4, A-9, E-8, C-5, E-4, E-6, E-7, E-10, E-11, E-12 — appear in the mapping table above, each in exactly one task.
2. **No placeholders.** Every step carries either real code (before and after, in full) or a named command with its expected output. The four tasks whose subject is a workflow or a live CDN (12, 13, 15, and the runtime halves of 14 and 17) say so explicitly and give a `curl`, `gh api` or `gh run view` read instead of a vitest file — plus a file-level guard test where the file itself is what drifted.
3. **Names and signatures agree across tasks.** `incompleteWindows` is produced in Task 4 and consumed in Task 5; `firstAttemptError` is added in Task 8 to the interface Task 5 extended; `parseHarvestBudget` (Task 7) is passed through the options object Task 8 introduces; `serializeStars(...).fileName` (Task 9) is what Task 11 stages; `read()` and `repoRoot` are created in Task 11's `repo-guards.test.ts` and appended to by 12, 13, 15, 16 and 17. The at-a-glance table lists every new export with the task that adds it.
4. **Line numbers were verified at `49db942`** by reading each file, not by trusting the audit: `emit.ts:77`, `build.ts:105` and `:190-198`, `github-client.ts:279`, `:526`, `:618`, `:651`, `npm-client.ts:301` and `:344`, `config.ts:84-90`, `classify.ts:122` and `:134`, `daily.yml:30-31`, `plugin.yml:29`, `packages/dsh-plugin-shop/package.json:121`.
5. **Two existing tests are changed, and both say why in the test body.** `github-client.test.ts:465-482` pinned D-3's second leg as correct behaviour (Task 2), and `stars-assemble.test.ts` is rewritten around the entry-keyed assembler (Task 9). Nothing else has an assertion edited to make a run green.
6. **Every count in this plan was measured, not estimated:** 14,740 repos and 1,918 mislabelled records from `registry/repo-state.json`; 334 tests and 22 files from `npx vitest run`; the seven action SHAs and their versions from `gh api`; the `workspace:` specifier from `packages/dsh-plugin-shop/package.json:121`; the missing `lib/typert.host.js` from the vendored tree; the three E-12 messages from running the loader against fixtures.

### Task 19: D-10 — a build that stops here must not be "fixed" by widening the status back

Finding D-10. **No code change. This task exists so the first person to see the build stop does not undo the fix that made it stop.**

Task 1 narrowed `no-manifest` to a genuine 404, so every other non-ok status from `readManifest` throws, and the systematic-failure bound (`MIN_THROWN_TO_BOUND = 20`, `MAX_THROWN_FRACTION = 0.1` in `github-client.ts`) turns a pool-wide throw into a failed build. That is this project's stated preference over persisting false verdicts, and it is what closed the case where a blocked `raw.githubusercontent.com` wrote "No package.json at the repository root" into the durable record of every repository it could not reach.

But it moves a silent degradation to a loud stop on a path with a plausible real trigger: **a REST rate-limit 403 on `git/trees` at `REPO_BACKFILL_BUDGET` 2,000.**

- [ ] **Step 1: When the build stops with a pool-wide throw, read the thrown detail first.**

If the statuses are 403 or 429, the harvest is rate-limited, not broken.

- [ ] **Step 2: Lower `REPO_BACKFILL_BUDGET`. Do NOT widen the status classification.**

Widening `no-manifest` back to "any non-ok status" restores the false-verdict bug in full: the durable `repo-state.json` record would again say "no package.json at the root" about every repository a rate limit hid. `no-manifest` is a verdict about a repository; a 403 is a statement about us.

- [ ] **Step 3: If lowering the budget proves too noisy, add an in-harvest budget — not a reclassification.**

`MAX_THROWN_FRACTION`'s own comment already names the missing in-harvest bound. Record the decision beside it, so the next reader finds the reasoning where the constant lives.

**Verification:** none. There is nothing to test; the guard this note protects is already tested by Task 1.

---
