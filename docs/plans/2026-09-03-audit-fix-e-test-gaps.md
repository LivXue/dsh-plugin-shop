# Audit fixes E — close the test gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every test in this repository fail when the behaviour it names is broken — proven by injecting that break — and produce end to end the artifacts and report rows the suite only ever asserted by construction.

**Architecture:** The standard is mutation, not coverage: a test earns its place by failing under the one-line bug it claims to catch. Three findings here (H-1, H-2, H-3) were established by injecting exactly that bug and watching the suite stay green, so each of their tasks reproduces the mutation first, writes the test against the mutated module, and only then restores it. The rest are absences — a path no test walks, a fixture that does not exist, a throw that cannot fire — and take the ordinary failing-test-first shape, with the reason the mutation step does not apply stated in the task.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), vitest 2.1, zod 4, `node:crypto`, `node:fs`, playwright (package e2e only), GitHub Actions.

**Spec:** [docs/plans/2026-09-03-debug-audit.md](2026-09-03-debug-audit.md) — findings H-1 … H-9

## Global Constraints

- The green baseline is **334 root tests / 22 files** (`pnpm test`) and **492 package tests / 25 files** (`pnpm -C packages/dsh-plugin-shop test`, with the uncommitted Incompatible-badge change in the tree; 490 at `49db942`). Every task states its expected new total.
- No `.only`, no `.skip`, no snapshots, no `vi.mock` of a module under test. `it.skipIf` survives only where it already lives (`real-install.test.ts`, `web-full-flow.e2e.ts`) and Task 4 puts a guard on it.
- Never mock the module under test; prefer a fixture over a mock. The pipeline is a pure function — drive it with data, not stubs.
- Assert on **every** artifact a property claims to cover. `Artifacts` has six fields: `pluginsFileName`, `pluginsJson`, `indexJson`, `badgeJson`, `manifestLock`, `report`.
- Verify test-data arithmetic independently: a hash asserted in a test is recomputed with `node:crypto` from the bytes under test, never read back out of the value being checked.
- A test that survives its own mutation is not a test. Mutate in place, keep the pristine module at `/tmp/<name>.orig.ts`, restore from it.
- ESM everywhere; `.ts` extensions on local relative imports (`from '../src/emit.ts'`).
- Files end with exactly one trailing newline. `docs/` prose in this plan is English only.
- Do not touch the uncommitted `ShopTab.tsx` / `ShopTab.module.css` / `ShopTab.client.spec.tsx` change in the tree — it is unrelated (the Incompatible badge moved beside the Install button) and stays.
- Verification per task: `npx vitest run <file>` focused, then `pnpm test` (root) and `pnpm typecheck`; for package tasks also `pnpm -C packages/dsh-plugin-shop test` and `pnpm -C packages/dsh-plugin-shop typecheck`. All four before the commit.

**Cross-plan ordering.** Four tasks are gated on sibling plans:

| Task | Waits on | Why |
|---|---|---|
| 2 (H-2) | [A — stop the bleeding](2026-09-03-audit-fix-a-urgent.md), D-2 / A-5 | the throw path is red until `fetchCandidate` catches |
| 10 (H-1b) | [C — network, artifacts, CI](2026-09-03-audit-fix-c-network-artifacts-ci.md), C-3 | `serializeStars` does not exist yet; its names come from plan C |
| 11 (H-6) | [B — identity and trust](2026-09-03-audit-fix-b-identity-trust.md) C-2, **and** C's C-3 | the twin-name perturbation fails until the identity sort lands; the sidecar cannot be compared until it is a pure return value |

Tasks 1, 3, 4, 5, 6, 7, 8, 9 are independent of A–D and can land in any order, today.

---

### Task 1: H-1 — name the plugins file by the bytes it actually writes

> **Outcome: DONE.** The gap was reproduced first, as the task asks: replacing
> `update(pluginsJson)` with `update(JSON.stringify(sorted))` — the same data,
> a different serialisation — left **38 of 38 green**. The test now recomputes
> the hash from the emitted bytes rather than reading it back out of the index,
> and that mutation goes red.

**Files:**
- Modify: `registry/scripts/tests/emit.test.ts:74-80` (the tautological test) and add one case after it
- Read only: `registry/scripts/src/emit.ts:176` (`const sha256 = createHash('sha256').update(pluginsJson).digest('hex')`)

**Interfaces:**
- Consumes: `emit(entries: Entry[], rejections: Rejection[], builtAt: string, stars?: StarsPointer | null, schemaVersion?: number, notAShop?: ReadonlySet<string>): Artifacts` from `../src/emit.ts`; the file's local `entry(name: string, version = '1.0.0'): Entry` helper; `createHash` from `node:crypto`.
- Produces: the recomputation idiom `createHash('sha256').update(pluginsJson).digest('hex')`, reused by Task 10 for the stars sidecar.

The gap: the current test reads `index.plugins.sha256` and asserts `pluginsFileName === plugins.${that}.json`. Both sides come from the same variable, so hashing bytes other than the ones written leaves it green — and the host's integrity check (`packages/dsh-plugin-shop/src/host/catalog.ts:400-402`) then refuses every published catalog while CI passes.

- [x] **Step 1: Prove the gap — inject the mutation**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
cp registry/scripts/src/emit.ts /tmp/emit.ts.orig
# Hash a different serialisation of the same data than the one written out.
perl -pi -e "s/\Qconst sha256 = createHash('sha256').update(pluginsJson).digest('hex')\E/const sha256 = createHash('sha256').update(JSON.stringify(sorted)).digest('hex')/" registry/scripts/src/emit.ts
git diff --numstat registry/scripts/src/emit.ts   # must read: 1  1  registry/scripts/src/emit.ts
npx vitest run registry/scripts/tests/emit.test.ts
```

Expected: `Tests  31 passed (31)`. The suite is green while every published `index.json` points at a sha256 no consumer can reproduce.

- [x] **Step 2: Write the test that catches it**

Add `import { createHash } from 'node:crypto'` as the first import of `registry/scripts/tests/emit.test.ts`, then replace lines 74-80 with:

```ts
  it('names the plugins file by the hash of the bytes it actually writes', () => {
    const { pluginsFileName, pluginsJson, indexJson } = emit(
      [entry('dsh-b'), entry('dsh-a')], [], '2026-08-18T00:00:00.000Z',
    )
    const index = JSON.parse(indexJson) as { plugins: { url: string; sha256: string } }
    // Recomputed here from the bytes emit returned, with no reference to the
    // value emit put in the index. Comparing the file name against
    // index.plugins.sha256 — which is what this used to do — compares one
    // variable with itself: hashing a different serialisation than the one
    // written passes, and the host's integrity check (host/catalog.ts:400-402)
    // then refuses every published catalog while CI stays green.
    const expected = createHash('sha256').update(pluginsJson).digest('hex')
    expect(index.plugins.sha256).toBe(expected)
    expect(pluginsFileName).toBe(`plugins.${expected}.json`)
    expect(index.plugins.url).toBe(pluginsFileName)
  })

  it('hashes the utf-8 bytes a reader downloads, not the string length', () => {
    // A catalog summary is author text; `zh` is multi-byte in almost every
    // real entry. writeFileSync defaults to utf8 and the host hashes the
    // downloaded BYTES, so a hash computed over any other encoding of the
    // same string would verify locally and fail for every reader. The entry
    // below makes byteLength differ from length, which is what makes this
    // assertion able to fail at all.
    const zh: Entry = {
      ...entry('dsh-zh'),
      catalog: { category: 'tool', summary: { en: 'x', zh: '渲染图表 — 多字节' }, capabilities: [] },
    }
    const { pluginsJson, indexJson } = emit([zh], [], '2026-08-18T00:00:00.000Z')
    expect(Buffer.byteLength(pluginsJson, 'utf8')).toBeGreaterThan(pluginsJson.length)
    const index = JSON.parse(indexJson) as { plugins: { sha256: string } }
    expect(index.plugins.sha256).toBe(
      createHash('sha256').update(Buffer.from(pluginsJson, 'utf8')).digest('hex'),
    )
  })
```

- [x] **Step 3: Run it against the mutated copy to verify it fails**

Run: `npx vitest run registry/scripts/tests/emit.test.ts`

Expected: FAIL, 2 failed | 30 passed (32). Both new cases report `AssertionError: expected 'fcc218afb1ba02b628335c4960a70f954ddc6f0f90514ceb5c85b4288188cbb5' to be 'a71134b3602c819801bee41194843d2cae976f98d8995fb8242df20cd01538fc' // Object.is equality` (the mutated hash against the recomputed one; the digests differ for any fixture, these are the values for the two-entry case).

- [x] **Step 4: Restore the module and run it green**

```bash
cp /tmp/emit.ts.orig registry/scripts/src/emit.ts
git diff --numstat registry/scripts/src/emit.ts   # must print nothing
npx vitest run registry/scripts/tests/emit.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS — `emit.test.ts (32 tests)`, root total **335 passed (335)**, typecheck clean.

- [x] **Step 5: Commit**

```bash
git add registry/scripts/tests/emit.test.ts
git commit -m "test(emit): recompute the plugins-file hash instead of comparing it with itself

H-1: the assertion read index.plugins.sha256 and checked the file name
against it, so hashing bytes other than the ones written stayed green.
Recomputed with node:crypto from the returned pluginsJson, plus a
multi-byte case pinning the utf-8 encoding the host verifies."
```

---

### Task 2: H-2 — drive `fetchCandidates` through both failure paths

**Files:**
- Modify: `registry/scripts/tests/npm-client.test.ts` — add a `describe('fetchCandidates')` block after the existing `describe('fetchCandidate')` (ends at line 518), and add `fetchCandidates` to the import on line 2
- Read only: `registry/scripts/src/npm-client.ts:361-378`

**Interfaces:**
- Consumes: `fetchCandidates(names: string[], fetchImpl?: typeof fetch, token?: string, backupRegistry?: string): Promise<{ candidates: Candidate[]; rejections: Rejection[] }>`; the `(async (url: string | URL) => new Response(...)) as unknown as typeof fetch` fixture idiom already used throughout this file.
- Produces: nothing later tasks depend on.

**Ordering: this task lands AFTER plan A's D-2 / A-5 task.** Plan A makes `fetchCandidate` catch a transport throw and return `{ ok: false, detail }`; until it does, the throw case below is red for the production reason plan A fixes, not for a test defect. Confirm the precondition mechanically before starting:

```bash
grep -n "catch" registry/scripts/src/npm-client.ts | sed -n '1,20p'
# fetchCandidate (line ~340) must wrap fetchWithFailover in a try/catch.
# If it does not, stop: run plan A's D-2 task first.
```

No test calls `fetchCandidates` today — `npm-client.test.ts:245` only mentions it in a comment. Both the mislabelled code and the dropped rejection survive, and a dropped rejection is exactly the silent disappearance CLAUDE.md forbids. `pipeline.test.ts:73-79` feeds a hand-built `fetch-failed` row, so it tests emit's merging, never the mapping.

> **Executed 2026-09-05 — already satisfied, nothing written.** A `describe('fetchCandidates')` block now sits at `npm-client.test.ts:1570`, carrying plan A's D-2 work and naming H-2 in its own comment. Both of Step 1's mutations were run against it and **both are caught**: mislabelling the code as `no-bundle` turns 3 cases red, dropping the rejection turns 4 red. Coverage exceeds what this task specified — six cases, including the 500 path, the transport throw, a stalled connection, the backup registry, a null packument body, and a sliding-pool case (`keeps every slot working while one name stalls`) that this task could not have written: `HARVEST_CONCURRENCY` is no longer a batch barrier, so Step 2's third fixture describes a mechanism that no longer exists.

- [x] **Step 1: Prove the gap — inject the mutation**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
cp registry/scripts/src/npm-client.ts /tmp/npm-client.ts.orig
# Mutation (a): mislabel the code — the report row names a reason that is not the reason.
perl -pi -e "s/\Qelse rejections.push({ name, code: 'fetch-failed', detail: result.detail })\E/else rejections.push({ name, code: 'no-bundle', detail: result.detail })/" registry/scripts/src/npm-client.ts
npx vitest run registry/scripts/tests/npm-client.test.ts
# Expected: 53 passed (53) — green.
# Mutation (b): drop the rejection entirely — the package vanishes with no reason attached to its name.
cp /tmp/npm-client.ts.orig registry/scripts/src/npm-client.ts
perl -pi -e "s/\Qelse rejections.push({ name, code: 'fetch-failed', detail: result.detail })\E/\/\/ dropped/" registry/scripts/src/npm-client.ts
npx vitest run registry/scripts/tests/npm-client.test.ts
```

Expected: `Tests  53 passed (53)` for **both** mutations.

- [x] **Step 2: Write the test that catches it**

Change line 2 to `import { fetchCandidate, fetchCandidates, HARVEST_KEYWORDS, PEERS_MAX_COUNT, searchByKeywords, toCandidate } from '../src/npm-client.ts'`, then append after the `describe('fetchCandidate')` block:

```ts
describe('fetchCandidates', () => {
  // The harvest runs ~8,800 packuments through this function. CLAUDE.md: "a
  // package that cannot be fetched becomes a `fetch-failed` rejection in the
  // build report. Nothing disappears without a reason attached to its name."
  // Nothing exercised it, so mislabelling the code and dropping the rejection
  // both passed (H-2).
  const packument = (name: string) => ({
    name,
    'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': '2026-08-01T12:00:00.000Z' },
    versions: {
      '1.0.0': {
        dist: { integrity: `sha512-${name}` },
        license: 'MIT',
        dsh: {
          bundle: { patch: './cordis.patch.yml' },
          catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
        },
      },
    },
  })

  it('records an unfetchable name as fetch-failed and keeps harvesting the rest', async () => {
    // A 5xx with no backup registry configured: the response reaches
    // fetchCandidate, which reports the status. No 429 anywhere here — a 429
    // is retried through the real defaultSleep and would spend 62s.
    const fetchImpl = (async (url: string | URL) => (String(url).includes('dsh-bad')
      ? new Response('boom', { status: 500 })
      : new Response(JSON.stringify(packument('dsh-good')), { status: 200 }))) as unknown as typeof fetch

    const { candidates, rejections } = await fetchCandidates(['dsh-good', 'dsh-bad'], fetchImpl)
    expect(candidates.map(c => c.name)).toEqual(['dsh-good'])
    expect(rejections).toEqual([{
      name: 'dsh-bad',
      code: 'fetch-failed',
      detail: 'npm registry returned 500 fetching dsh-bad',
    }])
  })

  it('records a transport failure as fetch-failed rather than rejecting the whole harvest', async () => {
    // D-2 / A-5: fetchWithFailover rethrows the primary failure when there is
    // no backup, and Promise.all turns one ECONNRESET on one of ~8,800
    // packuments into a failed build with no row for the package that caused
    // it. The detail must name the cause, because a plugin author reads it.
    const fetchImpl = (async (url: string | URL) => {
      if (String(url).includes('dsh-bad')) {
        const error = new Error('read ECONNRESET')
        ;(error as unknown as { code: string }).code = 'ECONNRESET'
        throw error
      }
      return new Response(JSON.stringify(packument('dsh-good')), { status: 200 })
    }) as unknown as typeof fetch

    const { candidates, rejections } = await fetchCandidates(['dsh-good', 'dsh-bad'], fetchImpl)
    expect(candidates.map(c => c.name)).toEqual(['dsh-good'])
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.name).toBe('dsh-bad')
    expect(rejections[0]?.code).toBe('fetch-failed')
    expect(rejections[0]?.detail).toContain('ECONNRESET')
  })

  it('reports every unfetchable name, not just the first in a batch', async () => {
    // HARVEST_CONCURRENCY is 8 and the results of a batch are drained in one
    // loop; a `break` or a single-assignment slip there would silently drop
    // the rest of the batch's failures.
    const fetchImpl = (async (url: string | URL) => (String(url).includes('ok')
      ? new Response(JSON.stringify(packument('dsh-ok')), { status: 200 })
      : new Response('gone', { status: 500 }))) as unknown as typeof fetch

    const names = ['dsh-a', 'dsh-b', 'dsh-ok', 'dsh-c']
    const { candidates, rejections } = await fetchCandidates(names, fetchImpl)
    expect(candidates).toHaveLength(1)
    expect(rejections.map(r => r.name)).toEqual(['dsh-a', 'dsh-b', 'dsh-c'])
    expect(rejections.every(r => r.code === 'fetch-failed')).toBe(true)
  })
})
```

- [x] **Step 3: Run it against the mutated copy to verify it fails**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts` (with mutation (b) still applied from Step 1)

Expected: FAIL. `records an unfetchable name as fetch-failed…` reports `AssertionError: expected [] to deeply equal [ { name: 'dsh-bad', code: 'fetch-failed', … } ]`; `reports every unfetchable name…` reports `expected [] to deeply equal [ 'dsh-a', 'dsh-b', 'dsh-c' ]`. Re-apply mutation (a) and re-run: the same two fail with `expected 'no-bundle' to be 'fetch-failed'` / the `code` field of the deep-equal diff.

- [x] **Step 4: Restore the module and run it green**

```bash
cp /tmp/npm-client.ts.orig registry/scripts/src/npm-client.ts
git diff --numstat registry/scripts/src/npm-client.ts   # must print nothing
npx vitest run registry/scripts/tests/npm-client.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS — `npm-client.test.ts (56 tests)`, root total **338 passed (338)** (335 after Task 1 plus three).

- [x] **Step 5: Commit**

```bash
git add registry/scripts/tests/npm-client.test.ts
git commit -m "test(npm-client): drive fetchCandidates through both failure paths

H-2: no test called fetchCandidates, so mislabelling the rejection code
and dropping the rejection entirely both stayed green — the silent
disappearance CLAUDE.md forbids. Covers the status path, the transport
throw path (D-2), and every failure in one batch."
```

---

### Task 3: H-3 — pin the failure-line picker's documented ordering

**Files:**
- Modify: `packages/dsh-plugin-shop/tests/host/executor.test.ts` — add two cases inside `describe('installFailureDetail')` (lines 394-473), after the carriage-return case that ends at line 471
- Read only: `packages/dsh-plugin-shop/src/host/executor.ts:97-135` (`installFailureDetail`), specifically lines 120-123

**Interfaces:**
- Consumes: `installFailureDetail(profile: string, log: readonly string[]): string` from `../../src/host/executor.ts` (already imported at line 5).
- Produces: nothing later tasks depend on.

The documented rule is "Scanning from the end: a pnpm error code first, then any thrown error, then the last line that is not noise." Both existing verbatim fixtures carry exactly one diagnostic line, so neither half of the ordering is pinned.

> **Executed 2026-09-05, as written.** Both mutations survived the pre-existing suite (43 passed under each), and each now turns exactly one of the two new cases red — neither fixture catches the other's mutation, which is why the task asked for both. Line numbers had moved: `installFailureDetail` is at `executor.ts:118` (the picker at `:128-131`), and the describe block runs `executor.test.ts:404-483`. Package suite **632 passed (632)** across 28 files, typecheck clean.

- [x] **Step 1: Prove the gap — inject the mutation**

**Mutation (a) — first match instead of last.** Drop the reverse:

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
cp packages/dsh-plugin-shop/src/host/executor.ts /tmp/executor.ts.orig
perl -pi -e "s/\Qconst reversed = [...usable].reverse()\E/const reversed = [...usable]/" packages/dsh-plugin-shop/src/host/executor.ts
git diff --numstat packages/dsh-plugin-shop/src/host/executor.ts   # must read: 1  1
npx vitest run --root packages/dsh-plugin-shop tests/host/executor.test.ts
```

Expected: `Tests  30 passed (30)` — green, with the first diagnostic line reported instead of the last. Restore, then apply the second.

**Mutation (b) — a thrown error outranks a pnpm code.** A hand edit, not a one-liner: the two lines are regex literals full of `\`, `|` and `?`, and every quoting form for them is more likely to silently match nothing than to swap them (which itself proves nothing). At `executor.ts:121-122`, swap the two `find` clauses so they read:

```ts
  const pick = reversed.find(line => /(?:^|\s)\w*Error:/.test(line))
    ?? reversed.find(line => /ERR_[A-Z][A-Z_]*/.test(line))
    ?? usable[usable.length - 1]
```

```bash
cp /tmp/executor.ts.orig packages/dsh-plugin-shop/src/host/executor.ts
# ...apply the swap above, then:
git diff --numstat packages/dsh-plugin-shop/src/host/executor.ts   # must read: 2  2 — if it reads 0 0 the edit did not land
npx vitest run --root packages/dsh-plugin-shop tests/host/executor.test.ts
```

Expected: `Tests  30 passed (30)` — green again. Both halves of the documented ordering can be inverted with the suite none the wiser.

- [x] **Step 2: Write the test that catches it**

Insert before the closing `})` of `describe('installFailureDetail')` (currently line 473):

```ts
  it('picks the LAST pnpm error code when a failed install emits several', () => {
    // "Scanning from the end" is the documented rule, and with two codes it
    // is the only thing that decides which one a user reads. Both existing
    // verbatim fixtures carry exactly one diagnostic line, so dropping the
    // reverse and taking the first match passed (H-3). pnpm emits the peer
    // warning while resolving and the fetch failure when it gives up: the
    // later line is the one that ended the install.
    const log = [
      '+ dsh-two-codes 1.0.0',
      '[ERR_PNPM_PEER_DEP_ISSUES] Unmet peer dependencies',
      'Progress: resolved 12, reused 12, downloaded 0',
      '[ERR_PNPM_FETCH_404] GET https://registry.npmjs.org/dsh-nope: Not Found - 404',
      'dsh: pnpm failed in profile directory /root/probe/profiles/f7',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toMatch(/ERR_PNPM_FETCH_404/)
    expect(detail).not.toMatch(/ERR_PNPM_PEER_DEP_ISSUES/)
    // The noise filter still ran: neither the Progress line nor dsh's own
    // wrapper may be what the user is shown.
    expect(detail).not.toMatch(/Progress: resolved/)
    expect(detail).not.toMatch(/pnpm failed in profile directory/)
    // The approve-builds hint belongs to ERR_PNPM_IGNORED_BUILDS alone.
    expect(detail).not.toMatch(/approve-builds/)
  })

  it('prefers a pnpm error code over a thrown error even when the throw came later', () => {
    // The rule is a precedence, not a position: "a pnpm error code first,
    // then any thrown error". The TypeError below is LATER in the log than
    // the pnpm code, so scanning from the end alone would pick it — which is
    // what makes this able to catch a swap of the two find clauses. pnpm
    // named the actual failure; dsh's own reconcile then threw over the
    // half-installed profile, which is a consequence, not the cause.
    const log = [
      'Done in 1.2s using pnpm v11.13.0',
      '[ERR_PNPM_NO_MATCHING_VERSION] No matching version found for dsh-nope@9.9.9',
      'TypeError: Cannot read properties of undefined (reading \'bundles\')',
      '    at reconcile (file:///…/dsh-app-boot/lib/index.js:512:9)',
      'Node.js v26.6.0',
    ]
    const detail = installFailureDetail('web', log)
    expect(detail).toMatch(/ERR_PNPM_NO_MATCHING_VERSION/)
    expect(detail).toMatch(/dsh-nope@9\.9\.9/)
    expect(detail).not.toMatch(/TypeError/)
    expect(detail).not.toMatch(/Node\.js v26/)
    expect(detail).toMatch(/Run: dsh plugin --profile web install/)
  })
```

- [x] **Step 3: Run it against the mutated copy to verify it fails**

Run: `npx vitest run --root packages/dsh-plugin-shop tests/host/executor.test.ts`

Expected: FAIL, one case per mutation. With mutation (a) applied: `picks the LAST pnpm error code…` fails on `expected 'pnpm failed in the profile. Run: dsh plugin --profile web install — [ERR_PNPM_PEER_DEP_ISSUES] Unmet peer dependencies' not to match /ERR_PNPM_PEER_DEP_ISSUES/`. With mutation (b) applied: `prefers a pnpm error code over a thrown error…` fails on `expected 'pnpm failed in the profile. Run: dsh plugin --profile web install — TypeError: Cannot read properties of undefined (reading 'bundles')' to match /ERR_PNPM_NO_MATCHING_VERSION/`. Apply each mutation in turn and confirm one case turns red each time — neither mutation is caught by the other's fixture, which is why both are needed.

- [x] **Step 4: Restore the module and run it green**

```bash
cp /tmp/executor.ts.orig packages/dsh-plugin-shop/src/host/executor.ts
git diff --numstat packages/dsh-plugin-shop/src/host/executor.ts   # must print nothing
pnpm -C packages/dsh-plugin-shop test
pnpm -C packages/dsh-plugin-shop typecheck
```

Expected: PASS — `tests/host/executor.test.ts (32 tests)`, package total **494 passed (494)**.

- [x] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/tests/host/executor.test.ts
git commit -m "test(executor): pin the failure-line picker's scan order and precedence

H-3: both verbatim fixtures carried one diagnostic line, so taking the
first match instead of the last, and ranking a thrown error above a pnpm
code, both stayed green. Two fixtures, one per mutation: two ERR_ codes
(the later wins) and a pnpm code with a later TypeError (the code wins)."
```

---

### Task 4: H-4 — a CI run may not be green because the exit criteria skipped

> **Outcome: DONE.** Step 1 reproduced it: with `dsh` hidden from PATH,
> `real-install.test.ts` reported `1 skipped` and the run **exited 0**. The P1
> exit criterion did not execute and nothing said so.
>
> `DSH_SHOP_REQUIRE_E2E=1` now turns that skip into a failure, and `plugin.yml`
> sets it on the package-suite step — that workflow installs the harness and a
> browser two steps earlier for exactly this purpose, so a skip there is a green
> run that proves nothing. A developer's machine without `dsh` still skips
> quietly, which is the honest case.
>
> The guard over the workflow parses the YAML. Its first version sliced 500
> characters after the `run:` line, and the comment explaining the variable
> pushed the variable itself out of the window — a correct workflow read as
> broken. Same lesson as the Dependabot pairing guard the same day: grep the
> shape and you match the prose.

**Files:**
- Modify: `packages/dsh-plugin-shop/tests/host/real-install.test.ts:18-47` (add the flag) and add one guard case
- Modify: `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts:85-100` (add the flag) and add one guard describe
- Modify: `.github/workflows/plugin.yml:29`

**Interfaces:**
- Consumes: the existing `hasDsh` constants in both files; `hasChromium` in `web-full-flow.e2e.ts:98`; `expect(value, message)` — the two-argument form already used at `real-install.test.ts:73`.
- Produces: the environment variable name **`DSH_SHOP_REQUIRE_E2E`** (value `'1'`), read by both test files and set by `plugin.yml`.

**No mutation step.** This is an absence, not a surviving mutation: there is no line to mutate, because the failure mode is that the P1 and P2 exit criteria *do not run at all* and the run is green anyway. The reproduction is the skip itself, which Step 1 exercises directly.

- [x] **Step 1: Reproduce the gap — hide `dsh` and watch both criteria vanish silently**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
# Both files probe for a `dsh` CLI. With PATH stripped, both find nothing.
env PATH=/usr/bin:/bin npx vitest run --root packages/dsh-plugin-shop \
  tests/host/real-install.test.ts tests/client/web-full-flow.e2e.ts
echo "exit: $?"
```

Expected: `Tests  no tests` / `5 skipped`, **exit 0**. The P1 and P2 exit criteria did not execute and nothing said so. Note also that `plugin.yml:24` gates on `dsh --version` — a bare-name spawn — while `real-install.test.ts:28-47` probes through `dshCommand`/`resolveDshScript`; the two can disagree, so a green CI run today is not evidence either criterion ran.

- [x] **Step 2: Write the test that catches it**

In `packages/dsh-plugin-shop/tests/host/real-install.test.ts`, after the `hasDsh` IIFE (line 47) add:

```ts
// CI sets this so a skip cannot be mistaken for a pass. The workflow's own
// `dsh --version` step uses a DIFFERENT probe from the one above, so a
// probe-only failure used to yield a green run in which the P1 exit criterion
// never executed (H-4). Locally it is unset and the skip below still works.
const requireE2e = process.env.DSH_SHOP_REQUIRE_E2E === '1'
```

Then, as the first case inside `describe('real installation')` (before the `it.skipIf` at line 57):

```ts
  // This case never skips — it is the guard on the skip.
  it('runs the P1 exit criterion rather than skipping it, wherever that is required', () => {
    expect(
      requireE2e && !hasDsh,
      'DSH_SHOP_REQUIRE_E2E=1, but the dsh CLI probe failed: the P1 exit criterion '
      + 'would have skipped and the run would still have been green. Fix the CLI '
      + 'install step in .github/workflows/plugin.yml, or unset the variable to run offline.',
    ).toBe(false)
  })
```

In `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts`, after `hasChromium` (line 98) add:

```ts
// See real-install.test.ts: CI sets this so the P2 exit criterion cannot skip
// its way to a green run (H-4).
const requireE2e = process.env.DSH_SHOP_REQUIRE_E2E === '1'

// Outside the skipIf'd describe below, so it runs even when that one does not.
describe('the P2 exit criterion', () => {
  it('runs rather than skipping wherever that is required', () => {
    expect(
      requireE2e && !hasDsh,
      'DSH_SHOP_REQUIRE_E2E=1, but the dsh CLI probe failed: the P2 exit criterion '
      + 'would have skipped. Fix `npm install -g @deepseek-ai/dsh` in '
      + '.github/workflows/plugin.yml, or unset the variable to run offline.',
    ).toBe(false)
    expect(
      requireE2e && !hasChromium,
      'DSH_SHOP_REQUIRE_E2E=1, but playwright chromium is not installed at '
      + `${chromium.executablePath()}: the P2 exit criterion would have skipped. `
      + 'Fix the `playwright install chromium` step in .github/workflows/plugin.yml.',
    ).toBe(false)
  })
})
```

Then the workflow. Replace `.github/workflows/plugin.yml:29`:

```yaml
      - run: pnpm -C packages/dsh-plugin-shop test
```

with:

```yaml
      - run: pnpm -C packages/dsh-plugin-shop test
        env:
          # The P1 and P2 exit criteria are `skipIf(!hasDsh)` cases: with the
          # CLI or chromium missing they skip and the job still exits 0. This
          # turns each skip into a failed assertion, so a broken install step
          # is a red run rather than a green one in which neither criterion
          # executed (audit H-4). The `dsh --version` step above uses a
          # different probe from the tests, which is why it is not the gate.
          DSH_SHOP_REQUIRE_E2E: '1'
```

- [x] **Step 3: Run it and verify it fails when the criteria would skip**

```bash
env PATH=/usr/bin:/bin DSH_SHOP_REQUIRE_E2E=1 npx vitest run --root packages/dsh-plugin-shop \
  tests/host/real-install.test.ts tests/client/web-full-flow.e2e.ts
echo "exit: $?"
```

Expected: FAIL, 2 failed, **non-zero exit**, with `AssertionError: DSH_SHOP_REQUIRE_E2E=1, but the dsh CLI probe failed: the P1 exit criterion would have skipped and the run would still have been green. … expected true to be false`. Then confirm the local path is unaffected:

```bash
env PATH=/usr/bin:/bin npx vitest run --root packages/dsh-plugin-shop \
  tests/host/real-install.test.ts tests/client/web-full-flow.e2e.ts
```

Expected: PASS, 2 passed | 5 skipped — no dsh, no chromium, no false alarm.

- [x] **Step 4: Run the full suites green with the CLI present**

```bash
pnpm -C packages/dsh-plugin-shop test
DSH_SHOP_REQUIRE_E2E=1 pnpm -C packages/dsh-plugin-shop test
pnpm -C packages/dsh-plugin-shop typecheck
```

Expected: PASS both ways — `tests/host/real-install.test.ts (2 tests)`, `tests/client/web-full-flow.e2e.ts (5 tests)`, package total **496 passed (496)**.

- [x] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/tests/host/real-install.test.ts \
        packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts \
        .github/workflows/plugin.yml
git commit -m "test(e2e): make CI fail when the P1/P2 exit criteria would skip

H-4: both criteria are skipIf(!hasDsh) and exit 0 when skipped, and the
workflow gated on a different probe than the tests use, so a probe-only
failure produced a green run in which neither ran. DSH_SHOP_REQUIRE_E2E=1
turns each skip into a failed assertion; plugin.yml sets it."
```

---

### Task 5: H-5 — remove the throw that cannot fire, and assert the property it claimed

> **Outcome: DONE — branch deleted, property kept.** The throw at `emit.ts` was
> unreachable exactly as the task argues: `pluginsJson` is built from `sorted`
> a few lines above, and `JSON.stringify` cannot change an array's length, so
> both counts came from the same array by construction. The comparison now
> lives in `emit.test.ts` between the two EMITTED artifacts, where it can go red
> if they are ever built from different sources. `assertCatalogInvariants` is
> untouched.

**Files:**
- Modify: `registry/scripts/src/emit.ts:220-223` (delete the dead branch)
- Modify: `registry/scripts/tests/emit.test.ts` — add one case to `describe('emit')`, after the schema-version case that ends at line 96

**Interfaces:**
- Consumes: `emit(...)` and the local `entry` / `repoEntry` helpers.
- Produces: nothing later tasks depend on.

**Decision: delete the branch and pin the property in a test.** `emit.ts:222` parses `pluginsJson` back and compares `.plugins.length` with `sorted.length`, but `pluginsJson` is built from `sorted` at line 175 (and `sorted` at line 155) — `JSON.stringify` cannot change an array's length, so the two values are the same number by construction and the throw is unreachable. An unreachable throw is code no test can verify, and CLAUDE.md's standard is that a test must fail when the behaviour breaks. Moving the comparison into a test keeps the guard *and* makes it real: the day someone builds the two artifacts from different sources, the test goes red. Keeping the branch and re-deriving one count "independently" cannot help, because both counts still originate in `sorted` inside the same function. `assertCatalogInvariants` (the E9 date check and the duplicate-identity check) is untouched — those fire on real input and have four tests.

**No mutation step.** The finding is that the branch *cannot* be mutated into failing: any input that would make it fire is unreachable through `emit`'s signature. Step 1 demonstrates that instead.

- [x] **Step 1: Demonstrate the branch is unreachable — mutate its condition and watch nothing change**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
cp registry/scripts/src/emit.ts /tmp/emit.ts.h5.orig
# Invert the condition: if the branch were reachable, EVERY emit would now throw.
perl -pi -e "s/\Qif (dataCount !== sorted.length)\E/if (dataCount === sorted.length)/" registry/scripts/src/emit.ts
npx vitest run registry/scripts/tests/emit.test.ts
```

Expected: `Tests  28 failed | 4 passed (32)`. Every case that reaches the end of `emit` now throws `catalog invariant: index count does not match the data file`, which proves the condition is *always* false and the branch therefore dead. The four survivors are the `assertCatalogInvariants` cases at lines 269, 274, 287 and 293, which throw earlier and match on their own message. Restore before continuing:

```bash
cp /tmp/emit.ts.h5.orig registry/scripts/src/emit.ts
git diff --numstat registry/scripts/src/emit.ts   # must print nothing
```

- [x] **Step 2: Write the test that pins the property**

Add to `describe('emit')` in `registry/scripts/tests/emit.test.ts`, after the `stamps the schema version on both files` case:

```ts
  it('reports the same entry count in the index as the data file carries', () => {
    // E12 used to be a throw inside emit (emit.ts:222) comparing
    // JSON.parse(pluginsJson).plugins.length with sorted.length — two names
    // for one number three lines apart, so the branch could not fire and
    // could not be tested (H-5). The property is real; it belongs here,
    // where it fails the day the two artifacts stop sharing a source. Mixed
    // sources and a rejection, so neither count is trivially 1.
    const { pluginsJson, indexJson } = emit(
      [entry('dsh-b'), repoEntry('dsh-a', 'owner/slug'), entry('dsh-c')],
      [{ name: 'dsh-no', code: 'no-bundle', detail: 'x' }],
      '2026-08-18T00:00:00.000Z',
    )
    const data = JSON.parse(pluginsJson) as { plugins: unknown[] }
    const index = JSON.parse(indexJson) as { count: number; rejected: number }
    expect(index.count).toBe(data.plugins.length)
    expect(index.count).toBe(3)
    expect(index.rejected).toBe(1)
  })
```

- [x] **Step 3: Delete the dead branch**

Remove these four lines from `registry/scripts/src/emit.ts` (lines 220-223, immediately before `return { pluginsFileName, ... }`):

```ts
  // E12: the pointer's count must equal the data file's plugin array — the
  // two artifacts are built separately and this keeps them honest.
  const dataCount = (JSON.parse(pluginsJson) as { plugins: unknown[] }).plugins.length
  if (dataCount !== sorted.length) throw new Error('catalog invariant: index count does not match the data file')
```

and replace them with:

```ts
  // E12 (the pointer's count equals the data file's plugin array) used to be
  // a throw here. It compared two names for one number: `pluginsJson` is
  // built from `sorted` above, so the branch was unreachable and untestable
  // (audit H-5). The property is asserted in emit.test.ts against the two
  // EMITTED artifacts instead, which is a check that can actually fail.
```

- [x] **Step 4: Run it green**

```bash
npx vitest run registry/scripts/tests/emit.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS — `emit.test.ts (33 tests)`, root total **339 passed (339)**, typecheck clean (the removal drops the only use of `dataCount`, so an unused-variable error here means the replacement was pasted in the wrong place).

- [x] **Step 5: Commit**

```bash
git add registry/scripts/src/emit.ts registry/scripts/tests/emit.test.ts
git commit -m "refactor(emit): drop the unreachable index-count throw, assert it instead

H-5: the branch compared JSON.parse(pluginsJson).plugins.length with the
sorted array it was built from three lines earlier, so it could neither
fire nor be tested. Inverting its condition failed all 32 cases, which is
the proof. The property now lives in a test over the two emitted
artifacts, where it can fail if they ever stop sharing a source."
```

---

### Task 6: H-7 — resolve fixture paths from the module, not the cwd

> **Outcome: DONE, and the finding was wider than Plausible.** Step 1
> reproduced it: running `pipeline.test.ts` from `/tmp` with an explicit
> `--root` raised `ENOENT` and reported **"no tests"** rather than a failure —
> the shape that hides.
>
> `cwd-independence.test.ts` then found a **second** instance the audit did not
> name: `schema.test.ts` read `registry/schema/plugin-entry.schema.json` the
> same way. Both now resolve from the module.
>
> Verified end to end: the whole suite run from `/tmp` is 28 files, 760 tests,
> all passing. The guard scans source rather than re-running each file from a
> foreign directory, which would double the suite's runtime to catch a defect
> whose signature is one regex.

**Files:**
- Modify: `registry/scripts/tests/pipeline.test.ts:1-9`
- Modify: `registry/scripts/tests/schema.test.ts:1-2,40-44`
- Create: `registry/scripts/tests/cwd-independence.test.ts`

**Interfaces:**
- Consumes: `fileURLToPath` from `node:url`, `dirname`/`join` from `node:path`, `import.meta.dirname` — the idiom already established at `registry/scripts/tests/readme-pins.test.ts:27` (`join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')`) and at `packages/dsh-plugin-shop/tests/host/npm-origin.test.ts:11` (`import.meta.dirname`).
- Produces: `registry/scripts/tests/cwd-independence.test.ts`, the guard that keeps the next file from drifting back.

The audit marks H-7 *Plausible*, so Step 1 is the reproduction that confirms or closes it.

**No mutation step.** There is no production line to mutate: the defect is in the tests' own path resolution, and Step 1 reproduces it directly by changing the cwd.

- [x] **Step 1: Reproduce — run the suite from a subdirectory**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/registry
npx vitest run --root .. scripts/tests/pipeline.test.ts
npx vitest run --root .. scripts/tests/schema.test.ts
```

**Confirmed, not merely plausible.** `pipeline.test.ts` fails to collect at all:

```
FAIL  registry/scripts/tests/pipeline.test.ts [ registry/scripts/tests/pipeline.test.ts ]
Error: ENOENT: no such file or directory, open 'registry/scripts/tests/fixtures/packuments.json'
 ❯ registry/scripts/tests/pipeline.test.ts:8:3
```

and `schema.test.ts` loses one case: `1 failed | 5 passed (6)` with `Error: ENOENT … open 'registry/schema/plugin-entry.schema.json'` at `schema.test.ts:42:23`. `readFileSync` resolves against `process.cwd()`, so 20 pipeline tests and the schema-freshness guard exist only when vitest happens to be started from the repository root. A sweep confirms these are the only two offenders:

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
grep -rn "readFileSync('registry\|readFileSync(\"registry" registry/scripts/tests/
grep -rn "readFileSync('packages\|readFileSync(\"packages" packages/dsh-plugin-shop/tests/
```

- [x] **Step 2: Fix both paths and write the guard**

`registry/scripts/tests/pipeline.test.ts` lines 1-9 become:

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runPipeline } from '../src/pipeline.ts'
import { parseRegistryConfig } from '../src/config.ts'
import type { Candidate, Rejection } from '../src/types.ts'

// Resolved from this module, not the cwd: a cwd-relative path exists only
// when vitest is started from the repository root, and from anywhere else the
// whole file fails to collect with ENOENT (audit H-7). readme-pins.test.ts
// has always done it this way.
const candidates = JSON.parse(
  readFileSync(fileURLToPath(new URL('fixtures/packuments.json', import.meta.url)), 'utf8'),
) as Candidate[]
```

`registry/scripts/tests/schema.test.ts` lines 1-2 become:

```ts
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
```

and lines 40-44 become:

```ts
// registry/scripts/tests → the repository root, the same three levels
// readme-pins.test.ts walks.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

describe('published JSON Schema', () => {
  it('matches the committed file', () => {
    const committed = readFileSync(join(repoRoot, 'registry', 'schema', 'plugin-entry.schema.json'), 'utf8')
    expect(committed).toBe(renderJsonSchema())
  })
})
```

(the `const repoRoot` line goes above the `describe`, at module scope.)

Create `registry/scripts/tests/cwd-independence.test.ts`:

```ts
/** No test in this suite may resolve a repository path against the process's
 * cwd.
 *
 * `readFileSync('registry/…')` works only when vitest is started from the
 * repository root. From anywhere else the read is ENOENT and, at module
 * scope, the whole file fails to collect — silently taking its cases out of
 * the run rather than failing one of them. That is how H-7 was reproduced:
 *
 *   cd registry && npx vitest run --root .. scripts/tests/pipeline.test.ts
 *   → Error: ENOENT … open 'registry/scripts/tests/fixtures/packuments.json'
 *
 * `readme-pins.test.ts` has always resolved from `import.meta.url`. This
 * guard is what keeps the next file from drifting back — the same shape as
 * the workflow guard plan A adds for the files `build.ts` writes.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const testsDir = import.meta.dirname

/** A filesystem call opening on a repository top-level directory: the shape
 * that resolves only from the repository root. */
const CWD_RELATIVE =
  /(?:readFileSync|readdirSync|existsSync|statSync|writeFileSync|readdir|readFile)\(\s*['"`](?:registry|packages|docs|node_modules)\//

describe('fixture and artifact paths', () => {
  it('resolves every repository path from import.meta.url, never from the cwd', () => {
    const offenders: string[] = []
    for (const name of readdirSync(testsDir).sort()) {
      // This file's own regex literal names those directories.
      if (!name.endsWith('.test.ts') || name === 'cwd-independence.test.ts') continue
      const source = readFileSync(join(testsDir, name), 'utf8')
      for (const line of source.split('\n')) {
        if (CWD_RELATIVE.test(line)) offenders.push(`${name}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
```

- [x] **Step 3: Verify the guard fails on the defect it names**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
git stash push registry/scripts/tests/pipeline.test.ts
npx vitest run registry/scripts/tests/cwd-independence.test.ts
```

Expected: FAIL — `AssertionError: expected [ "pipeline.test.ts: readFileSync('registry/scripts/tests/fixtures/packuments.json', 'utf8')," ] to deeply equal []`. Restore and re-run:

```bash
git stash pop
npx vitest run registry/scripts/tests/cwd-independence.test.ts
```

Expected: PASS.

- [x] **Step 4: Run it green, from both directories**

```bash
npx vitest run registry/scripts/tests/pipeline.test.ts registry/scripts/tests/schema.test.ts
cd registry && npx vitest run --root .. scripts/tests/pipeline.test.ts scripts/tests/schema.test.ts && cd ..
pnpm test
pnpm typecheck
```

Expected: PASS everywhere — 20 + 6 tests from the subdirectory too, root total **340 passed (340)** across **23 files**.

- [x] **Step 5: Commit**

```bash
git add registry/scripts/tests/pipeline.test.ts registry/scripts/tests/schema.test.ts \
        registry/scripts/tests/cwd-independence.test.ts
git commit -m "test: resolve fixture and schema paths from import.meta.url

H-7, confirmed rather than plausible: run from registry/, pipeline.test.ts
fails to collect (ENOENT on the packuments fixture, taking all 20 cases
with it) and schema.test.ts loses the freshness guard. Both now resolve
from the module, and a new guard test fails on the next cwd-relative path."
```

---

### Task 7: H-8 — produce the `invalid-catalog` report row an author reads, end to end

**Files:**
- Modify: `registry/scripts/tests/fixtures/packuments.json` (add one candidate before the closing `]`)
- Modify: `registry/scripts/tests/pipeline.test.ts:65-71` (four rejections become five) and add one case after it

**Interfaces:**
- Consumes: the module-level `candidates` and `config` in `pipeline.test.ts`; `runPipeline(candidates: Candidate[], repoCandidates: RepoCandidate[], config: RegistryConfig, builtAt: string, preexistingRejections?: Rejection[], stars?: StarsPointer | null, schemaVersion?: number): Artifacts`; the `Candidate` shape as the other seven fixture entries write it.
- Produces: the fixture candidate `dsh-bad-catalog`, which Task 11's determinism test also harvests (it reads the same file; the extra rejection sorts into place and needs no first-seen row, since only accepted entries are looked up in `tier.ts:14`).

"A malformed `dsh.catalog` is rejected, never downgraded to a derived listing" is in CLAUDE.md's Failing-loudly list, and every rejection's `detail` is published for a plugin author to read. Today that holds only at the unit gate (`gate.test.ts:109-114`): no fixture candidate carries an invalid section, so the report row itself is never produced.

**No mutation step.** The gap is a missing fixture, not a surviving mutation — there is no code path to break, because the path is never walked. Step 1 confirms the row does not exist today.

> **Executed 2026-09-05, as written.** The predicted row is byte-for-byte what the pipeline produces: `| dsh-bad-catalog | invalid-catalog | dsh.catalog.(root): Unrecognized key: "tags \\| extra" |`. Both new assertions were run with the fixture stashed and both fail there, so the fixture is what carries them. `Accepted: 3` and the listed set are unchanged; `Rejected:` moves from 4 to 5. Root suite **763 passed (763)** across 28 files, typecheck clean.

- [x] **Step 1: Confirm the row is never produced**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
grep -c "invalid-catalog" registry/scripts/tests/fixtures/packuments.json || echo "0 — no fixture candidate carries one"
grep -rn "invalid-catalog" registry/scripts/tests/pipeline.test.ts || echo "pipeline.test.ts: never asserted"
```

Expected: no fixture entry and no pipeline assertion. `emit.test.ts:151-155` escapes a *hand-built* rejection, so the escaping is covered but the mapping from a real candidate is not.

- [x] **Step 2: Add the fixture candidate**

In `registry/scripts/tests/fixtures/packuments.json`, add a comma after the `dsh-no-summary` object's closing brace (line 99) and insert before the closing `]`:

```json
  {
    "name": "dsh-bad-catalog",
    "version": "1.0.0",
    "integrity": "sha512-badcatalog",
    "publishedAt": "2026-08-14T12:00:00.000Z",
    "repository": "https://github.com/you/bad-catalog",
    "license": "MIT",
    "deprecated": false,
    "hasBundle": true,
    "catalog": { "category": "tool", "summary": { "en": "Renders diagrams", "zh": "渲染图表" }, "capabilities": [], "tags | extra": ["diagrams"] },
    "description": "Declares a dsh.catalog carrying a field the schema does not know.",
    "keywords": [],
    "peers": []
  }
```

The unrecognised key is the one rejection whose `detail` echoes author text back into a published artifact, and the `|` inside it is why `escapeCell` exists. Everything else about the candidate is valid — a real license, a real bundle, a perfectly usable npm description — so the only reason it can fail to list is the declared section.

- [x] **Step 3: Write the assertions and verify they fail without the fixture**

Replace `registry/scripts/tests/pipeline.test.ts:65-71` with:

```ts
  it('reports all five rejections with their codes', () => {
    const { report } = runPipeline(candidates, [], config, BUILT_AT)
    expect(report).toContain('| dsh-lib-only | no-bundle |')
    expect(report).toContain('| dsh-no-license | no-license |')
    expect(report).toContain('| dsh-fs-too1 | name-too-similar |')
    expect(report).toContain('| dsh-no-summary | no-summary |')
    expect(report).toContain('| dsh-bad-catalog | invalid-catalog |')
  })

  it('publishes the invalid-catalog row escaped, and lists nothing for that package', () => {
    const { report, pluginsJson } = runPipeline(candidates, [], config, BUILT_AT)
    // The row a plugin author reads to find out why their text never
    // appeared, produced end to end rather than at the unit gate (H-8). The
    // author-supplied key name reaches a PUBLISHED artifact, so the `|` it
    // carries has to be escaped or it forges a column in the table.
    expect(report).toContain(
      '| dsh-bad-catalog | invalid-catalog | dsh.catalog.(root): Unrecognized key: "tags \\| extra" |',
    )
    // "rejected, never downgraded to a derived listing" (CLAUDE.md): the
    // package has a usable npm description, and it still must not list.
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string }[] }
    expect(parsed.plugins.map(p => p.name)).toEqual(['dsh-derived-plugin', 'dsh-fs-tool', 'dsh-hello-plugin'])
  })
```

Verify the assertions bite before trusting them:

```bash
git stash push registry/scripts/tests/fixtures/packuments.json
npx vitest run registry/scripts/tests/pipeline.test.ts
```

Expected: FAIL, 2 failed — `reports all five rejections…` on the `dsh-bad-catalog` line and `publishes the invalid-catalog row escaped…` on the escaped detail, both `expected '# Catalog build report…' to contain …`. Then:

```bash
git stash pop
```

- [x] **Step 4: Run it green**

```bash
npx vitest run registry/scripts/tests/pipeline.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS — `pipeline.test.ts (21 tests)`, root total **341 passed (341)**. The accepted set is unchanged (`dsh-derived-plugin`, `dsh-fs-tool`, `dsh-hello-plugin`) and the report's `Rejected:` line reads 5.

- [x] **Step 5: Commit**

```bash
git add registry/scripts/tests/fixtures/packuments.json registry/scripts/tests/pipeline.test.ts
git commit -m "test(pipeline): harvest a candidate whose declared dsh.catalog is invalid

H-8: no fixture candidate carried one, so the published invalid-catalog
row — the text a plugin author reads to find out why their summary never
appeared — was never produced end to end, and 'rejected, never downgraded'
held only at the unit gate. The key name carries a pipe, so the row also
proves escapeCell runs on the real path."
```

---

### Task 8: H-9a — replace the registry assertions that cannot fail

**Files:**
- Modify: `registry/scripts/tests/emit.test.ts:353-361` (`expect(badge.color).toBeTruthy()`)
- Modify: `registry/scripts/tests/emit.test.ts:277-282` (bare `not.toThrow()`)
- Read only: `registry/scripts/src/emit.ts:194-201` (the badge payload; `color: 'blue'` is at line 198 and occurs exactly once in the module)

**Interfaces:**
- Consumes: `emit(...)`, the local `entry` / `repoEntry` helpers.
- Produces: nothing later tasks depend on.

Two assertions in the root suite pass for any value the code could produce. `toBeTruthy()` on a colour passes for `'teal'`, `'not-a-colour'` and `'0.5'` alike — shields renders an unrecognised colour grey, so the badge would silently stop being blue. The bare `not.toThrow()` establishes that `emit` did not throw and nothing about the behaviour the test is named for.

**No mutation step.** These are assertions that cannot fail by construction; the demonstration is that the current form passes against a wrong value, which Step 1 shows without touching production code.

- [x] **Step 1: Show the current assertions accept a wrong value**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
node -e "console.log(['teal','not-a-colour','0.5',' '].map(v => Boolean(v)))"
# [ true, true, true, true ] — every one of these passes expect(color).toBeTruthy().
```

For the second: `emit([a, b], ...)` with two same-named repo entries returns six artifacts, and `not.toThrow()` inspects none of them — the test named "allows the same bundle name from different repos" would pass if `emit` dropped one of the two entries entirely.

- [x] **Step 2: Write the assertions that can fail**

Replace `registry/scripts/tests/emit.test.ts:353-361` with:

```ts
  it('carries a colour and a cache window shields will honour', () => {
    const badge = JSON.parse(emit([entry('dsh-a')], [], '2026-08-18T00:00:00.000Z').badgeJson) as
      { color: string; cacheSeconds: number }
    // Pinned, not merely truthy: shields renders an unrecognised colour grey,
    // and `toBeTruthy()` accepts 'teal' and 'not-a-colour' as readily as
    // 'blue' (H-9). The regex is shields' own accepted forms — one of the
    // named colours, or a hex triplet — so a future change to a colour
    // shields cannot render fails here rather than in a reader's README.
    expect(badge.color).toBe('blue')
    expect(badge.color).toMatch(
      /^(?:brightgreen|green|yellowgreen|yellow|orange|red|blue|grey|gray|lightgrey|lightgray|#(?:[0-9a-f]{3}|[0-9a-f]{6}))$/,
    )
    // Long enough not to hammer Pages from every README view, short enough
    // that the date is never a day behind what /v1/index.json already says.
    expect(badge.cacheSeconds).toBeGreaterThanOrEqual(300)
    expect(badge.cacheSeconds).toBeLessThanOrEqual(21600)
  })
```

Replace `registry/scripts/tests/emit.test.ts:277-282` with:

```ts
  it('allows the same bundle name from different repos', () => {
    // the registry legitimately holds distinct plugins under one name
    const a = repoEntry('dsh-a', 'owner-a/slug')
    const b = repoEntry('dsh-a', 'owner-b/slug')
    // `not.toThrow()` alone would also pass if emit silently dropped one of
    // the two, which is the opposite of what this case is named for (H-9).
    // Assert both identities actually reach the data file and the lock.
    const { pluginsJson, manifestLock } = emit([a, b], [], '2026-08-31T00:00:00Z')
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; repo?: string }[] }
    expect(parsed.plugins.map(p => p.name)).toEqual(['dsh-a', 'dsh-a'])
    expect(parsed.plugins.map(p => p.repo)).toEqual(['owner-a/slug', 'owner-b/slug'])
    expect(manifestLock).toBe('owner-a/slug dsh-a 1.0.0\nowner-b/slug dsh-a 1.0.0\n')
  })
```

- [x] **Step 3: Verify each fails on the value it now refuses**

```bash
cp registry/scripts/src/emit.ts /tmp/emit.ts.h9.orig
perl -pi -e "s/\Qcolor: 'blue',\E/color: 'teal',/" registry/scripts/src/emit.ts
npx vitest run registry/scripts/tests/emit.test.ts
```

Expected: FAIL — `AssertionError: expected 'teal' to be 'blue' // Object.is equality`. The pre-change assertion accepted `'teal'`. Restore:

```bash
cp /tmp/emit.ts.h9.orig registry/scripts/src/emit.ts
git diff --numstat registry/scripts/src/emit.ts   # must print nothing
```

For the second, drop the second entry from the emitted list:

```bash
perl -pi -e "s/\Qconst sorted = [...emitted].sort(\E/const sorted = [...emitted].slice(0, 1).sort(/" registry/scripts/src/emit.ts
npx vitest run registry/scripts/tests/emit.test.ts
```

Expected: FAIL, including `allows the same bundle name from different repos` with `expected [ 'dsh-a' ] to deeply equal [ 'dsh-a', 'dsh-a' ]` — which the bare `not.toThrow()` did not catch. Restore:

```bash
cp /tmp/emit.ts.h9.orig registry/scripts/src/emit.ts
git diff --numstat registry/scripts/src/emit.ts   # must print nothing
```

- [x] **Step 4: Run it green**

```bash
npx vitest run registry/scripts/tests/emit.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS — `emit.test.ts (33 tests)`, root total **341 passed (341)** (unchanged: both cases were strengthened in place, none added).

- [x] **Step 5: Commit**

```bash
git add registry/scripts/tests/emit.test.ts
git commit -m "test(emit): replace two assertions that could not fail

H-9: expect(badge.color).toBeTruthy() accepts 'teal' and 'not-a-colour',
which shields renders grey; the bare not.toThrow() on two same-named repo
entries would also pass if emit dropped one. Both now assert the value."
```

---

### Task 9: H-9b — test the package modules whose absence hides a real defect class

**Files:**
- Create: `packages/dsh-plugin-shop/tests/host/repo-pins.test.ts`
- Create: `packages/dsh-plugin-shop/tests/host/own-version.test.ts`
- Modify: `packages/dsh-plugin-shop/src/host/repo-pins.ts:27` (one line: the record's prototype)
- Modify: `packages/dsh-plugin-shop/tests/host/npm-origin.test.ts` (add a `describe('normalizeRegistryUrl')` block and extend the import on line 7)
- Modify: `packages/dsh-plugin-shop/tests/host/dsh-cli.test.ts:82` (`expect(shimDir).toBeTruthy()`)
- Modify: `packages/dsh-plugin-shop/tests/host/hot.test.ts:270-277` (bare `not.toThrow()`) and its `node:fs` import on line 2

**Interfaces:**
- Consumes: `readRepoPins(fs: RepoPinFs, path: string): RepoPins`, `writeRepoPins(fs: RepoPinFs, path: string, pins: RepoPins): void`, `RepoPinFs { exists: (path: string) => boolean; read: (path: string) => string; write: (path: string, data: string) => void }`, `RepoPins = Record<string, string>` from `../../src/host/repo-pins.ts`; `normalizeRegistryUrl(url: string): string` from `../../src/host/npm-origin.ts`; `ownVersion(): string` from `../../src/own-version.ts`; `cleanHotDir(profileDir: string): void` from `../../src/host/hot.ts`; `resolveDshScript(fs: DshCliFs, env: { argv1?: string; path?: string }): string | null` and the local `npmGlobal()` helper in `dsh-cli.test.ts`.
- Produces: nothing later tasks depend on.

**Why these four, and not the rest.** H-9 lists fourteen untested modules; blanket coverage would be busywork and, worse, would pin behaviour plans A–D are about to change. The picks:

- **`host/repo-pins.ts`** — the only record of which commit a `github:` install pinned, and the sole input to `installed()`'s `outdated` verdict (`host/index.ts:812`). Its lookup key is a catalog entry name, i.e. hostile npm/GitHub input, and it builds a prototype-bearing `{}`.
- **`host/npm-origin.normalizeRegistryUrl`** — two lines that decide the URL every mirror race fetches. Without the trailing slash, `new URL('dsh-x/latest', 'https://host/npm')` is `https://host/dsh-x/latest`: a path-prefixed registry from a user's `~/.npmrc` silently resolves off its own prefix.
- **`own-version.ts`** — the version the self-update check compares and the client shows, resting on an undocumented layout claim ("the source tree and the bundled `lib/index.js` sit exactly one level below the package root"). Every 0.5.x incident was a wrong assumption about layout or shape that no test held.
- The two weak assertions (`dsh-cli.test.ts:82`, `hot.test.ts:273`) — both currently pass for any outcome.

**Left untested, deliberately:** `build.ts` (impure orchestration; every defect the audit found in it — C-1, C-7, E-9 — has a failing test in plan A or C, and testing the whole build needs the network the pure core exists to avoid) · `publish-catalog.ts` (its two behaviours are in the audit's "Checked and clean"; the rest is `npm publish`, testable only by mocking it) · `classify.ts` (its policy half is `classify-select.ts`, 9 tests; the harvest wiring gets its test from plan A's D-2 backup-registry fix) · `backfill-first-seen.ts` (a one-shot recovery script plan A runs by hand once; its output is reviewed in that commit's diff, a stronger check than a test of a script that will not run again) · `own.ts` (exercised through `gate.ts`'s `self` cases, its only caller) · `emit-schema.ts`'s CLI branch (`renderJsonSchema()` is pinned byte-for-byte by the freshness guard; what remains is a `writeFileSync` of that string) · `market-judge.judgeMarkets` and `github-client.probeTotal` (D-7 and D-4 are High findings whose own "test first" belongs to plans B and C; a weaker test now would pin behaviour those plans change) · `client/useUninstall.ts`, `client/useUpdateSelf.ts`, `useInstall.usePollStatus` (all three reach production only through `ShopTab.tsx`, and `ShopTab.client.spec.tsx`'s 105 cases already drive the uninstall done view, the self-update restart offer and the once-per-second poll, as does `web-full-flow.e2e.ts`; their own state-machine tests belong with plan D's G-9 fix, which changes those machines).

**No mutation step.** These are absences — modules no test imports and assertions with no failing input. Each step below states the failing form first and confirms it fails.

- [x] **Step 1: Show the gap**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
grep -rn "repo-pins\|normalizeRegistryUrl\|own-version" packages/dsh-plugin-shop/tests/ || echo "no test imports any of the three"
# The prototype hazard, reproduced against the real module:
cat > /tmp/probe-pins.ts <<'EOF'
import { readRepoPins } from '/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/packages/dsh-plugin-shop/src/host/repo-pins.ts'
const fs = { exists: () => true, read: () => JSON.stringify({ 'dsh-real': 'a'.repeat(40) }), write: () => {} }
const pins = readRepoPins(fs, '/nowhere')
console.log('pins.constructor is', typeof pins['constructor'], '— !== undefined:', pins['constructor'] !== undefined)
EOF
node --experimental-strip-types /tmp/probe-pins.ts
```

Expected: `pins.constructor is function — !== undefined: true`. `constructor`, `toString` and `valueOf` are all legal npm package names and GitHub bundle names are unrestricted, so `host/index.ts:812`'s `pins[entry.name]` reads a function off `Object.prototype` and reports it as the installed commit with `outdated: true`.

- [x] **Step 2: Write the tests**

Create `packages/dsh-plugin-shop/tests/host/repo-pins.test.ts`:

```ts
/** The shop's memory of which commit a `github:` install pinned. Untested
 * until now (audit H-9), although it is the sole input to `installed()`'s
 * `outdated` verdict (host/index.ts:812) and its lookup key is a catalog
 * entry name — hostile npm/GitHub input.
 *
 * Fixtures over mocks: the RepoPinFs seam IS the production interface, so
 * these drive the real function through the real seam.
 */

import { describe, expect, it } from 'vitest'
import { readRepoPins, writeRepoPins, type RepoPinFs } from '../../src/host/repo-pins.ts'

function fsWith(contents: string | null): RepoPinFs & { written: string[] } {
  const written: string[] = []
  return {
    written,
    exists: () => contents !== null,
    read: () => {
      if (contents === null) throw new Error('read of a file that does not exist')
      return contents
    },
    write: (_path, data) => { written.push(data) },
  }
}

const COMMIT = 'a'.repeat(40)

describe('readRepoPins', () => {
  it('reads a bundle name to the 40-hex commit it was pinned at', () => {
    expect(readRepoPins(fsWith(JSON.stringify({ 'dsh-repo-plugin': COMMIT })), '/pins.json'))
      .toEqual({ 'dsh-repo-plugin': COMMIT })
  })

  it('drops a value that is not a commit rather than reporting it as one', () => {
    // The value reaches the user as `installed` in the RPC row. Anything that
    // is not a commit is not an answer, and a wrong one is worse than none.
    const pins = readRepoPins(fsWith(JSON.stringify({
      'dsh-hex': COMMIT,
      'dsh-short': 'abc',
      'dsh-upper': 'A'.repeat(40),
      'dsh-number': 12,
      'dsh-object': { commit: COMMIT },
    })), '/pins.json')
    expect(pins).toEqual({ 'dsh-hex': COMMIT })
  })

  it('reads a corrupt file as no memory at all', () => {
    expect(readRepoPins(fsWith('not json{{'), '/pins.json')).toEqual({})
  })

  it('reads a missing file as no memory, without reading it', () => {
    expect(readRepoPins(fsWith(null), '/pins.json')).toEqual({})
  })

  it('reads a JSON array or scalar as no memory', () => {
    expect(readRepoPins(fsWith('["dsh-a"]'), '/pins.json')).toEqual({})
    expect(readRepoPins(fsWith('"dsh-a"'), '/pins.json')).toEqual({})
    expect(readRepoPins(fsWith('null'), '/pins.json')).toEqual({})
  })

  it('never answers a lookup from Object.prototype', () => {
    // `constructor`, `toString` and `valueOf` are all legal npm package
    // names, and a GitHub bundle name is unrestricted. On a prototype-bearing
    // record each reads a FUNCTION, which `pins[entry.name] !== undefined`
    // then accepts as a recorded commit: host/index.ts:812 reports it as the
    // installed version with outdated: true, for a package never installed.
    const pins = readRepoPins(fsWith(JSON.stringify({ 'dsh-real': COMMIT })), '/pins.json')
    for (const inherited of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(pins[inherited]).toBeUndefined()
    }
    expect(pins['dsh-real']).toBe(COMMIT)
  })

  it('round-trips a written record through a read', () => {
    const fs = fsWith('{}')
    writeRepoPins(fs, '/pins.json', { 'dsh-a': COMMIT })
    expect(fs.written).toEqual([`{\n  "dsh-a": "${COMMIT}"\n}\n`])
    expect(readRepoPins(fsWith(fs.written[0] ?? ''), '/pins.json')).toEqual({ 'dsh-a': COMMIT })
  })
})
```

Create `packages/dsh-plugin-shop/tests/host/own-version.test.ts`:

```ts
/** `ownVersion()` is what the self-update check compares against
 * `dist-tags.latest` and what the client prints in the version row. It reads
 * `../package.json` relative to its OWN module url, and its correctness rests
 * on a layout claim in its header comment: the source tree and the bundled
 * `lib/index.js` both sit exactly one level below the package root, so the
 * same relative url resolves in both. Nothing tested either half (audit H-9),
 * and every 0.5.x release broke on an untested assumption of exactly this
 * kind.
 */

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownVersion } from '../../src/own-version.ts'

const packageRoot = join(import.meta.dirname, '..', '..')

describe('ownVersion', () => {
  it('reports the version in the package that ships it', () => {
    const declared = (JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { version: string }).version
    expect(ownVersion()).toBe(declared)
    // A semver, not a path or an empty string: the self-update comparison
    // feeds this to semver.lt and a non-version silently disables the check.
    expect(ownVersion()).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  })

  it('is one directory below the package root in both trees the module claims', () => {
    // The claim: `new URL('../package.json', import.meta.url)` resolves for
    // src/own-version.ts AND for lib/index.js. The first half is proven by
    // the case above; this pins the second, which a bundler layout change
    // (lib/host/index.js, say) would break at a user's boot and at no other
    // time. `pnpm test` runs tsdown first, so lib/ is present here.
    expect(existsSync(join(packageRoot, 'src', 'own-version.ts'))).toBe(true)
    expect(existsSync(join(packageRoot, 'lib', 'index.js'))).toBe(true)
    const main = (JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    ) as { main: string }).main
    expect(main).toBe('lib/index.js')
  })
})
```

In `packages/dsh-plugin-shop/tests/host/npm-origin.test.ts`, change line 7 to `import { normalizeRegistryUrl, npmOrigin } from '../../src/host/npm-origin.ts'` and append at the end of the file:

```ts
describe('normalizeRegistryUrl', () => {
  it('appends the trailing slash a path-prefixed registry needs to keep its prefix', () => {
    // `new URL(path, base)` drops the base's last segment when it has no
    // trailing slash: without this, a ~/.npmrc `registry=https://host/npm`
    // resolves the probe to https://host/dsh-x/latest — off its own prefix,
    // at a path the operator never served. Untested until now (H-9).
    expect(normalizeRegistryUrl('https://registry.example.com/npm')).toBe('https://registry.example.com/npm/')
    expect(new URL('dsh-x/latest', normalizeRegistryUrl('https://registry.example.com/npm')).href)
      .toBe('https://registry.example.com/npm/dsh-x/latest')
  })

  it('leaves a url that already ends in a slash alone', () => {
    expect(normalizeRegistryUrl('https://registry.npmjs.org/')).toBe('https://registry.npmjs.org/')
    // Idempotent: the origin id is `npm:${registryUrl}` and the race
    // deduplicates on it, so two spellings of one registry must not race
    // against each other.
    expect(normalizeRegistryUrl(normalizeRegistryUrl('https://registry.npmjs.org')))
      .toBe(normalizeRegistryUrl('https://registry.npmjs.org'))
  })
})
```

Replace `packages/dsh-plugin-shop/tests/host/dsh-cli.test.ts:82` (`expect(shimDir).toBeTruthy()`) with:

```ts
    // `toBeTruthy()` on an mkdtemp result can never fail (H-9). The claim is
    // that the answer came from argv1's OWNING package rather than from PATH
    // — which was not consulted at all here — so assert the resolved entry is
    // the CLI package's own file inside the fixture tree.
    expect(entry.startsWith(join(shimDir, 'node_modules', '@deepseek-ai', 'dsh'))).toBe(true)
```

Replace `packages/dsh-plugin-shop/tests/host/hot.test.ts:270-277` with:

```ts
  it('is a no-op when the namespace directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-shop-hot-'))
    try {
      const profileDir = join(root, 'profile')
      cleanHotDir(profileDir)
      // `not.toThrow()` alone would also pass if cleanHotDir created the
      // directory on its way past, which is the opposite of a no-op (H-9).
      expect(existsSync(profileDir)).toBe(false)
      expect(existsSync(join(profileDir, '.dsh-shop'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
```

and add `existsSync` to the `node:fs` import on line 2: `import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'`.

- [x] **Step 3: Verify the new tests fail before the fix**

```bash
npx vitest run --root packages/dsh-plugin-shop tests/host/repo-pins.test.ts
```

Expected: FAIL — `never answers a lookup from Object.prototype` reports `AssertionError: expected [Function: Object] to be undefined`. The other six cases pass (they describe behaviour the module already has, and they are what makes a future regression in the hex filter or the corrupt-file degradation visible at all).

- [x] **Step 4: Fix the prototype hazard and run everything green**

In `packages/dsh-plugin-shop/src/host/repo-pins.ts`, replace line 27:

```ts
    const out: RepoPins = {}
```

with:

```ts
    // A null prototype, not `{}`: the lookup key is a catalog entry name,
    // which is hostile npm/GitHub input, and `constructor`, `toString` and
    // `valueOf` are all legal package names. On a plain object each of them
    // reads a function off Object.prototype, so `pins[name] !== undefined` is
    // true for a package that was never installed and `installed()` reports a
    // function as the installed commit (host/index.ts:812). Same rule as G-8
    // applies to the stars map.
    const out: RepoPins = Object.create(null) as RepoPins
```

```bash
npx vitest run --root packages/dsh-plugin-shop tests/host/repo-pins.test.ts \
  tests/host/own-version.test.ts tests/host/npm-origin.test.ts \
  tests/host/dsh-cli.test.ts tests/host/hot.test.ts
pnpm -C packages/dsh-plugin-shop test
pnpm -C packages/dsh-plugin-shop typecheck
```

Expected: PASS — `repo-pins.test.ts (7 tests)`, `own-version.test.ts (2 tests)`, `npm-origin.test.ts (20 tests)`, `dsh-cli.test.ts (13 tests)`, `hot.test.ts (15 tests)`, package total **507 passed (507)** across **27 files**. `index.test.ts`'s pin cases (lines 860, 892, 939, 1000) must stay green: they assert on the parsed JSON file, so the null prototype is invisible to them.

The change is to a pure function's internal record and touches no RPC shape, no catalog field and no harness service, so it does not itself require a `beta` — it rides whatever release plan D ships.

**One finding this task surfaces and does not fix.** `host/index.ts:729` writes `args.version` into the pins file, and for a release-rescued github entry that value is a tag (`v1.0.0` — see `index.test.ts:1000`), which `readRepoPins`'s 40-hex filter drops on the next read. Such an entry therefore falls back to `installed: spec` and can never report `outdated`. That changes an RPC-visible field, so it belongs to plan D beside G-1's identity work, not here. Record it in plan D rather than widening this task.

> **Executed 2026-09-05. The plan was stale in four places; what landed differs.**
>
> 1. **`repo-pins.test.ts` already existed** — commit `110c500` (*fix(host): preserve release tag pins*, plan D's G-11) created it with four cases: a commit round-trip, a release-tag round-trip, a drop of anything that is neither, and missing/corrupt as no memory. Those cover the plan's fixtures in a different but equivalent form, so only the absent case was added: **the prototype hazard**. Writing the plan's file verbatim would have duplicated four tests and deleted a G-11 regression guard.
> 2. **The "finding this task does not fix" above is fixed.** `110c500` widened the filter to `COMMIT_SHA.test(pin) || RELEASE_TAG.test(pin)`, so a release-rescued entry's tag now survives the read. Nothing to record in plan D.
> 3. **The plan's `'dsh-upper': 'A'.repeat(40)` fixture would now be wrong.** `RELEASE_TAG` is `/^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/`, which accepts forty uppercase letters. The fixture asserted that value is dropped; it is kept, correctly.
> 4. **`normalizeRegistryUrl` was not untested.** `npm-origin.test.ts:270` ("keeps a registry url's path when resolving the probe request, even with no trailing slash") already drove exactly that behaviour end to end through `npmOrigin` — the mutation check found it by failing two tests instead of one. The new block still went in, pinning the two lines directly rather than only through their one caller, but its comment says so instead of claiming the gap the plan asserted.
>
> Line numbers had also moved: `repo-pins.ts:27` → `:30`, `hot.test.ts:270-277` → `:342`. The `HOT_DIR` the plan's replacement joins is, in `hot.test.ts`, a file-local **absolute** path (`join(PROFILE, '.dsh-shop')`) and not the module's unexported bare segment; the landed test uses the literal `'.dsh-shop'`.
>
> **Mutation-checked, against the plan's "no mutation step".** Every new assertion was proven able to fail: the prototype case failed before the fix; `normalizeRegistryUrl` → identity, `npmGlobal` returning a path outside the CLI package, `cleanHotDir` creating the directory on its way past, `ownVersion` → `'0.0.0'`, and a moved `lib/index.js` each failed exactly the case that names them. Package suite **630 passed (630)** across 28 files, root **762 passed (762)**, both typechecks clean.

- [x] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/tests/host/repo-pins.test.ts \
        packages/dsh-plugin-shop/tests/host/own-version.test.ts \
        packages/dsh-plugin-shop/tests/host/npm-origin.test.ts \
        packages/dsh-plugin-shop/tests/host/dsh-cli.test.ts \
        packages/dsh-plugin-shop/tests/host/hot.test.ts \
        packages/dsh-plugin-shop/src/host/repo-pins.ts
git commit -m "test(host): cover repo-pins, own-version and normalizeRegistryUrl

H-9: three modules no test imported, chosen because each hides a real
defect class — repo-pins is the only input to installed()'s outdated
verdict and answered lookups from Object.prototype (now a null-prototype
record), normalizeRegistryUrl decides the url every mirror race fetches,
and own-version rests on an untested layout claim. Also replaces the two
bare not.toThrow()/toBeTruthy() assertions in dsh-cli and hot."
```

---

### Task 10: H-1b — recompute the stars sidecar's hash (after plan C)

> **Outcome: ALREADY SATISFIED by plan C's task 9, which landed the serialiser
> this task was waiting for.** Verified 2026-09-05 by the mutation this task
> specifies: replacing `update(json)` with `update(JSON.stringify(sorted))` in
> `serializeStars` turns `stars-assemble.test.ts` red. The recomputation idiom
> was written into that test when the function was created, so there is nothing
> further to add.

**Files:**
- Modify: `registry/scripts/tests/stars-assemble.test.ts` — the module plan C extends with its pure serialiser

**Interfaces:**
- Consumes: plan C's `serializeStars(assembled: AssembledStars): SerializedStars` where `SerializedStars { fileName: string; json: string; sha256: string }`, and `AssembledStars { stars: Record<string, number>; fromSearch: number; fromGraphql: number }` — both from `../src/stars-assemble.ts`; `createHash` from `node:crypto`. These are plan C's landed names, reconciled 2026-09-03: the audit's C-3 prose used a different module and field spelling, and plan C is the producer, so plan C wins.
- Produces: nothing later tasks depend on. Task 11 byte-compares the same `json` under perturbation.

**Ordering: this task lands AFTER plan C's C-3 task.** Today the sidecar's sort, `Object.fromEntries`, hash and file naming all live in `build.ts:195-197`, in the impure shell, where no test can reach them — which is exactly why H-1's other half could not be written at HEAD.

**No mutation step at HEAD**, because the code to mutate does not exist yet; Step 2 mutation-checks plan C's function once it does.

- [x] **Step 1: Resolve the real names plan C landed**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
grep -rn "serializeStars" registry/scripts/src/ registry/scripts/tests/ \
  docs/plans/2026-09-03-audit-fix-c-network-artifacts-ci.md
grep -n "stars" registry/scripts/src/build.ts
```

Expected: `serializeStars` and `SerializedStars` exported from `registry/scripts/src/stars-assemble.ts`, and no `createHash` left in `build.ts`'s stars path. If `serializeStars` is absent, **stop**: plan C's C-3 has not landed and `build.ts` still hashes the sidecar inline, so there is nothing pure to test.

- [x] **Step 2: Prove the gap — inject the mutation into plan C's serialiser**

```bash
cp registry/scripts/src/stars-assemble.ts /tmp/stars-assemble.ts.orig
# Hash a different serialisation than the one returned, exactly as H-1's
# mutation did to emit.ts:176.
perl -pi -e "s/\Qupdate(json)\E/update(JSON.stringify(assembled.stars))/" registry/scripts/src/stars-assemble.ts
npx vitest run registry/scripts/tests/stars-assemble.test.ts
```

Expected: GREEN. Plan C's own order-independence test compares two `json` values with each other and never checks the digest against those bytes, so the file name can point at a hash of something else — and the host verifies sha256 on the fetched sidecar bytes (`host/catalog.ts:400-402`), so every reader would refuse it.

- [x] **Step 3: Write the test that catches it**

Add to plan C's stars-serialiser test file (adding `import { createHash } from 'node:crypto'` if it is not already there):

```ts
  it('names the stars sidecar by the hash of the bytes it actually writes', () => {
    // The H-1 recomputation, applied to the second content-addressed
    // artifact. Recomputed here from the returned json, never read back out
    // of the value under test.
    const assembled: AssembledStars = {
      stars: { 'dsh-b': 7, 'dsh-a': 0, 'owner/monorepo': 1234 },
      fromSearch: 2,
      fromGraphql: 1,
    }
    const { json, sha256 } = serializeStars(assembled)
    expect(sha256).toBe(createHash('sha256').update(json).digest('hex'))
    // Sorted by key, and a zero is a real count (stars-assemble.ts): the
    // sort is what keeps the sidecar's hash off the input's order, and
    // dropping a zero would silently rewrite an author's star count.
    expect(JSON.parse(json)).toEqual({ stars: { 'dsh-a': 0, 'dsh-b': 7, 'owner/monorepo': 1234 } })
    expect(Object.keys((JSON.parse(json) as { stars: Record<string, number> }).stars))
      .toEqual(['dsh-a', 'dsh-b', 'owner/monorepo'])
  })
```

- [x] **Step 4: Restore the module and run it green**

```bash
npx vitest run registry/scripts/tests/stars-assemble.test.ts
# Expected: FAIL — expected '<hash of assembled.stars>' to be '<hash of json>'.
cp /tmp/stars-assemble.ts.orig registry/scripts/src/stars-assemble.ts
git diff --numstat registry/scripts/src/stars-assemble.ts   # must print nothing
npx vitest run registry/scripts/tests/stars-assemble.test.ts
pnpm test
pnpm typecheck
```

Expected: PASS. The root total is plan C's total **plus exactly one** — record the before and after numbers from the two `pnpm test` runs rather than trusting an absolute figure this plan cannot know.

- [x] **Step 5: Commit**

```bash
git add registry/scripts/tests/stars-assemble.test.ts
git commit -m "test(stars): recompute the sidecar's hash from the bytes it writes

H-1, second half: with C-3 moving the sidecar's serialisation into the
pure core, the same independent recomputation the plugins file got now
applies to the stars file. Plan C's order test compares two json strings
with each other and never checks the digest against them."
```

---

### Task 11: H-6 — one determinism test, every artifact, every perturbation (after plans B and C)

**Files:**
- Modify: `registry/scripts/tests/pipeline.test.ts` — delete the three partial determinism cases at lines 81-88 (`produces byte-identical artifacts for the same input`), 134-142 (`produces identical data across build times`) and 144-151 (`produces byte-identical artifacts with a stars pointer across runs`), and add one `describe('determinism')` block in their place

**Interfaces:**
- Consumes: `runPipeline(candidates, repoCandidates, config, builtAt, preexistingRejections?, stars?, schemaVersion?): Artifacts`; `parseRegistryConfig({ verified, denied, allowedSimilar, categories, firstSeen }): RegistryConfig`; `RepoCandidate` from `../src/types.ts`; the module-level `candidates` fixture (which by then carries Task 7's `dsh-bad-catalog`); `Buffer.compare`.
- Produces: nothing later tasks depend on.

**Ordering: this task lands AFTER plan B's C-2 identity sort AND plan C's C-3 stars serialiser.** It is the union test the plan-of-plans names: the twin-name repo pair below reverses to different bytes at HEAD (verified: `pluginsJson`, `pluginsFileName` and `manifestLock` all differ), which is C-2, and the sidecar cannot be byte-compared until `serializeStars` returns it.

**Replacing three tests with one is the point, not a loss.** The three today are three slices of one property, and the audit's finding is that each slice is partial and their union still incomplete: the reversed-input case asserts four of six artifacts and never `indexJson` or `badgeJson`, the repeat case asserts two, the stars case two, repo-candidate order is never perturbed at all, and the sidecar is asserted by nothing. CLAUDE.md: "Assert on every artifact a property claims to cover. A determinism test that checks one of four stable outputs establishes nothing about the other three."

**No mutation step.** The gap is a perturbation never applied and artifacts never compared — an absence. Step 1 reproduces the specific hole plan B closes, so the test is known to bite.

> **Executed 2026-09-05. Most of this had already landed with plans B and C; what remained was the deletion and one perturbation.**
>
> `describe('determinism under every perturbation')` (`pipeline.test.ts:575`) was written by plan B's C-2 work and is stronger than this task's Step 2 block: it perturbs npm candidates, repo candidates **and** pre-existing rejections together, over all six artifacts plus `firstSeen`, and its fixtures carry ties this task's did not — two subpackages of one monorepo, a bundle name claimed by two owners, and two *rejected* subpackages of a third. Rewriting it from Step 2 would have lost coverage, so it was extended rather than replaced.
>
> What was actually missing:
> 1. **The repeated run.** Both existing cases compare a base against a *reversed* input; neither runs the same input twice, which is the only leg that separates nondeterminism inside `emit` from an ordering bug. Added, with the sidecar-pointer assertion carried over from the deleted stars case.
> 2. **The three superseded partial cases** at `:104`, `:171` and `:181` were still present. Deleted — that was this task's point.
>
> Both of Step 3's mutations were run before and after the deletion. Reverting `compareEntries` to the name-only comparator fails the reversed leg (`pluginsFileName moved with input order`); `builtAt` inside the hashed content fails the clock case. A third, `nonce: Math.random()` in the hashed content, fails the repeat leg (`moved between runs`) and would have passed every case that existed before this change. Root suite **760 passed (760)**, exactly −3 for the three deletions; typecheck clean.
>
> The Step 2 stars case could not be written as specified: plan C's serialiser takes ENTRIES (`assembleStarsForEntries(entries, searchStars, graphqlStars)`), not `(candidates, repoCandidates)`, and its order-independence is already pinned by `stars-assemble.test.ts:124` beside the byte-exact hash at `:111` — which is the right place for it, since the perturbation is the assembler's own.

- [x] **Step 1: Reproduce the hole — reverse two same-named repo candidates**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
grep -n "const sorted = " registry/scripts/src/emit.ts
# Plan B's C-2 fix sorts entries, lock lines and rejections by the FULL
# identity. If line 155 still reads
#   const sorted = [...emitted].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
# plan B has not landed — stop and run its C-2 task first.
```

At `49db942` the reproduction is:

```
one lock: "alice/dsh-twin dsh-twin cccc…\nbob/dsh-twin dsh-twin cccc…\n"
two lock: "bob/dsh-twin dsh-twin cccc…\nalice/dsh-twin dsh-twin cccc…\n"
pluginsJson equal: false   pluginsFileName equal: false   manifestLock equal: false
```

172 bundle names over 451 live entries are claimed by several repositories, so this is not a hypothetical shape.

- [x] **Step 2: Write the one test**

Delete lines 144-151, then 134-142, then 81-88 (highest first, so the earlier line numbers stay valid), and add this block at the end of `registry/scripts/tests/pipeline.test.ts`:

```ts
describe('determinism', () => {
  // ONE test for one property. It used to be three, each asserting a subset:
  // the reversed-input case checked four of six artifacts and never
  // badgeJson, the repeat case two, the stars case two — and repo candidate
  // order, which C-2 showed changes the content hash whenever two
  // repositories share a bundle name (172 live names do), was never
  // perturbed. CLAUDE.md: assert on every artifact a property claims to
  // cover (audit H-6).
  const ARTIFACTS = [
    'pluginsFileName', 'pluginsJson', 'indexJson', 'badgeJson', 'manifestLock', 'report',
  ] as const

  const commit = 'c'.repeat(40)
  const repo = (name: string, full: string, subdir?: string): RepoCandidate => ({
    name,
    repo: full,
    commit,
    version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/${full}`,
    license: 'MIT',
    hasBundle: true,
    requiresBuild: false,
    hasWorkspaceDeps: false,
    catalog: { category: 'tool', summary: { en: name, zh: '子包' }, capabilities: [] },
    description: name,
    ...(subdir == null ? {} : { subdir }),
  })

  // Two subpackages of one monorepo (so the `#subdir` half of the identity is
  // exercised) and a bundle name claimed by two different owners (so the sort
  // has a tie only the full identity can break).
  const repoCandidates: RepoCandidate[] = [
    repo('dsh-repo-plugin', 'someone/dsh-repo-plugin'),
    repo('sub-plugin', 'someone/monorepo', 'packages/sub-plugin'),
    repo('dsh-mono-plugin', 'someone/monorepo', 'packages/mono-plugin'),
    repo('dsh-twin', 'alice/dsh-twin'),
    repo('dsh-twin', 'bob/dsh-twin'),
  ]

  const fullConfig = parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
    denied: '[]',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: [
      '- name: dsh-fs-tool', '  added: 2026-08-10',
      '- name: dsh-hello-plugin', '  added: 2026-08-11',
      '- name: dsh-derived-plugin', '  added: 2026-08-12',
      '- name: dsh-repo-plugin', '  added: 2026-08-13',
      '- name: sub-plugin', '  added: 2026-08-14',
      '- name: dsh-mono-plugin', '  added: 2026-08-15',
      '- name: dsh-twin', '  added: 2026-08-16',
    ].join('\n') + '\n',
  })

  const STARS = { url: 'stars.deadbeef.json', sha256: 'deadbeef' }
  const LATER = '2030-01-01T00:00:00.000Z'
  const run = (npm: Candidate[], repos: RepoCandidate[], now: string) =>
    runPipeline(npm, repos, fullConfig, now, [], STARS, 4)

  it('is byte-identical under npm order, repo order and a repeated run', () => {
    const base = run(candidates, repoCandidates, BUILT_AT)
    const reversed = run([...candidates].reverse(), [...repoCandidates].reverse(), BUILT_AT)
    const repeated = run(candidates, repoCandidates, BUILT_AT)
    for (const key of ARTIFACTS) {
      // Buffer.compare, not toBe: the claim is about bytes, and a byte
      // comparison says so at the level a CDN and the host's sha256 check
      // both operate on.
      expect(Buffer.compare(Buffer.from(base[key]), Buffer.from(reversed[key])), `${key} moved with input order`).toBe(0)
      expect(Buffer.compare(Buffer.from(base[key]), Buffer.from(repeated[key])), `${key} moved between runs`).toBe(0)
    }
    // The perturbation has to be able to matter: both twins must actually be
    // listed, or the tie the sort has to break does not exist.
    const parsed = JSON.parse(base.pluginsJson) as { plugins: { name: string; repo?: string }[] }
    expect(parsed.plugins.filter(p => p.name === 'dsh-twin').map(p => p.repo))
      .toEqual(['alice/dsh-twin', 'bob/dsh-twin'])
  })

  it('carries the clock in the index and the badge, and nowhere else', () => {
    const base = run(candidates, repoCandidates, BUILT_AT)
    const later = run(candidates, repoCandidates, LATER)
    // The hashed content and everything committed must not move with the
    // clock — the builtAt invariant, which is what keeps every CDN cache
    // valid and every daily commit free of noise.
    for (const key of ['pluginsFileName', 'pluginsJson', 'manifestLock', 'report'] as const) {
      expect(Buffer.compare(Buffer.from(base[key]), Buffer.from(later[key])), `${key} moved with the clock`).toBe(0)
    }
    // And it must reach the two artifacts that are FOR the clock.
    expect(later.indexJson).not.toBe(base.indexJson)
    expect(later.badgeJson).not.toBe(base.badgeJson)
    // Nothing else in either of them moved: strip the one time-bearing field
    // and the rest is byte-identical, which is stronger than "differs".
    const strip = (json: string, field: string): string => {
      const parsed = JSON.parse(json) as Record<string, unknown>
      delete parsed[field]
      return JSON.stringify(parsed)
    }
    expect(strip(later.indexJson, 'builtAt')).toBe(strip(base.indexJson, 'builtAt'))
    expect(strip(later.badgeJson, 'message')).toBe(strip(base.badgeJson, 'message'))
    expect(JSON.parse(base.indexJson).builtAt).toBe(BUILT_AT)
    expect(JSON.parse(later.indexJson).builtAt).toBe(LATER)
    // The stars pointer rides the index and is not otherwise perturbed.
    expect(JSON.parse(later.indexJson).stars).toEqual(STARS)
  })

  it('is byte-identical in the stars sidecar under either candidate order', () => {
    // C-3 moved the sidecar's sort, serialisation and hash into the pure
    // core; before that it was assembled in build.ts and asserted by nothing
    // (H-6). Assembled from the same two candidate lists the artifacts above
    // are built from, so the perturbation is the same one.
    const searchStars = new Map([['alice/dsh-twin', 5], ['someone/monorepo', 12]])
    const graphqlStars = new Map([['bob/dsh-twin', 0], ['you/hello-plugin', 3]])
    const forward = serializeStars(
      assembleStarsByKey(candidates, repoCandidates, searchStars, graphqlStars),
    )
    const backward = serializeStars(
      assembleStarsByKey([...candidates].reverse(), [...repoCandidates].reverse(), searchStars, graphqlStars),
    )
    expect(Buffer.compare(Buffer.from(forward.json), Buffer.from(backward.json))).toBe(0)
    expect(forward.sha).toBe(backward.sha)
  })
})
```

Extend the imports at the top of the file: add `RepoCandidate` to the `types.ts` type import (`import type { Candidate, Rejection, RepoCandidate } from '../src/types.ts'`), and add `import { assembleStarsByKey } from '../src/stars-assemble.ts'` plus `import { serializeStars } from '../src/stars-assemble.ts'` (plan C puts the serialiser beside the assembler).

- [x] **Step 3: Verify each perturbation bites**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
cp registry/scripts/src/emit.ts /tmp/emit.ts.h6.orig
```

**Mutation 1 — revert plan B's identity sort to the name-only comparator it replaced.** This one is a hand edit, not a `perl` one-liner, because plan B's comparator text is not knowable from here: open `registry/scripts/src/emit.ts`, find the `const sorted = [...emitted].sort(…)` line, and replace whatever comparator plan B put there with exactly HEAD's:

```ts
  const sorted = [...emitted].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
```

Confirm the edit landed (`git diff --numstat registry/scripts/src/emit.ts` must report one changed line), then:

```bash
npx vitest run registry/scripts/tests/pipeline.test.ts
```

Expected: FAIL — `is byte-identical under npm order, repo order and a repeated run` reports `AssertionError: pluginsJson moved with input order: expected 1 to be 0` (or `-1`; `Buffer.compare` returns the sign of the comparison). Restore:

```bash
cp /tmp/emit.ts.h6.orig registry/scripts/src/emit.ts
git diff --numstat registry/scripts/src/emit.ts   # must print nothing
```

**Mutation 2 — put `builtAt` back inside the hashed content.** Add `builtAt,` to the object literal on the `const pluginsJson = ...` line (line 175 at HEAD), so it reads `JSON.stringify({ schemaVersion, builtAt, plugins: sorted, ... }, null, 2)`, then:

```bash
git diff --numstat registry/scripts/src/emit.ts   # must report one changed line
npx vitest run registry/scripts/tests/pipeline.test.ts
```

Expected: FAIL — `carries the clock in the index and the badge, and nowhere else` reports `pluginsJson moved with the clock: expected -1 to be 0`. Restore again and confirm `git diff --numstat` prints nothing.

- [x] **Step 4: Run it green**

```bash
npx vitest run registry/scripts/tests/pipeline.test.ts
cd registry && npx vitest run --root .. scripts/tests/pipeline.test.ts && cd ..
pnpm test
pnpm typecheck
```

Expected: PASS. The root total is plan C's + Task 10's total **minus exactly two** (three partial determinism cases replaced by three that together cover all six artifacts, both orders, the clock and the sidecar). Record the before and after numbers from the two `pnpm test` runs; a delta other than −2 means one of the three old cases was not deleted or an extra was added.

- [x] **Step 5: Commit**

```bash
git add registry/scripts/tests/pipeline.test.ts
git commit -m "test(pipeline): one determinism test over every artifact and perturbation

H-6: three partial cases replaced by one property. The old reversed-input
case asserted four of six artifacts and never badgeJson, the repeat case
two, the stars case two; repo candidate order was never perturbed although
C-2 showed it changes the hash for the 172 live bundle names two repos
share, and the sidecar was asserted by nothing. Now: npm order, repo order,
a repeat and the clock, byte-compared over all six artifacts plus the
stars sidecar, with builtAt proven to reach only the index and the badge."
```

---

## Coverage check

| Finding | Task | Shape |
|---|---|---|
| H-1 (plugins file hash) | 1 | mutation |
| H-1 (stars sidecar hash) | 10 | mutation, after plan C |
| H-2 (`fetchCandidates` untested) | 2 | mutation, after plan A |
| H-3 (failure-picker ordering) | 3 | mutation |
| H-4 (CI-skippable exit criteria) | 4 | absence |
| H-5 (unreachable index-count throw) | 5 | absence |
| H-6 (partial determinism tests) | 11 | absence, after plans B and C |
| H-7 (cwd-relative fixture paths) | 6 | absence — reproduced, and *Confirmed* rather than *Plausible* |
| H-8 (no invalid-catalog fixture) | 7 | absence |
| H-9 (weak assertions, untested modules) | 8 (registry), 9 (package) | absence |

Expected totals along the way, root suite: 334 → 335 (T1) → 338 (T2) → 339 (T5) → 340 (T6) → 341 (T7) → 341 (T8) → +1 (T10) → −2 (T11). Package suite: 492 → 494 (T3) → 496 (T4) → 507 (T9).

### Task 12: H-10 — CLOSED on 2026-09-04, recorded so it is not re-investigated

Finding H-10. **No work remains. This entry records the answer, because the finding shipped with two disproved hypotheses and one unconfirmed suspect, and the suspect was right.**

Two of `web-full-flow.e2e.ts`'s four cases failed stably against `[data-plugin-entry="include:typert-gateway:mkt-e2e-live"]` and `[data-phase]`. The finding had already disproved the registry branch's changes and H-11's temp-directory leak, and named as prime suspect the global `@deepseek-ai/dsh` install whose mtime sat minutes before the failures first appeared.

**That suspect was the cause.** `@deepseek-ai/dsh-client-ui-settings-plugin-inventory` changed its contract between the two versions, measured directly:

| | `0.1.1-rc.2` | `0.1.2-rc.1` |
|---|---|---|
| `data-enabled` | 2 | 0 |
| `data-kind` | 0 | 5 |
| 插件列表 | one list | split into 会话插件 (presets, open) and 全局插件 (Loader entries, **collapsed** when a preset roster exists) |

So the hot mount really did succeed — the install assertion passing was not a fluke — and the Loader entry the test looked for was inside a collapsed disclosure that never opened. The id was correct all along.

**A wrong diagnosis was reported before this one and is recorded so the pattern is recognised:** 27 bare ids were measured in the dialog and read as proof the plugin never mounted. Those were the preset composition rows — the OTHER of the two entry-id spaces ([[dsh-loader-id-spaces]]). Counting ids in the wrong plane looks exactly like counting them in the right one.

Closed by `2184265`: an `expandGlobalPlane` helper opens the 全局插件 disclosure after each 插件列表 tab click and waits for a `[data-plugin-entry^="include:"]` row, and `[data-enabled="true"]` became `[data-kind="enabled"]`. `b98dd1f` moved `plugin.yml`'s global pin to `0.1.2-rc.1` so CI drives the contract the selectors match. Verified green: run 33842995573, `web-full-flow.e2e.ts` 4 tests passed, 519/519 overall.

**The standing hazard this leaves:** the e2e drives the real `dsh` on PATH, so a harness release can break it with no change in this repository. `plugin.yml`'s pin is the only thing holding that still, and it carries the measured contract table as a comment. A same-line rc bump can still change the contract underneath it.

**Verification:** none — closed and green in CI.

> **Reviewed 2026-09-05 — no work, as recorded.** Left as the standing hazard it describes: `plugin.yml`'s pin to `0.1.2-rc.1` and its measured contract table are still the only thing holding the e2e's selectors to a harness contract this repository does not own.

---

### Task 13: H-11 — the temp-home leak is in the host tests, not in the e2e file the finding names

Finding H-11, **with its premise corrected**. The finding says "the suite creates a temporary `DSH_HOME` per scenario and never removes it" and points at `web-full-flow.e2e.ts`. Measured 2026-09-04 on `4ceb0b0`:

```
tests/host/index.test.ts             mkdtempSync=41   rmSync=2    ← dominant
tests/host/executor.test.ts          mkdtempSync=10   rmSync=0
tests/host/dsh-cli.test.ts           mkdtempSync=5    rmSync=0
tests/host/profile.test.ts           mkdtempSync=5    rmSync=0
tests/host/restart.test.ts           mkdtempSync=4    rmSync=3
tests/client/web-full-flow.e2e.ts    mkdtempSync=2    rmSync=2    ← balanced
```

`web-full-flow.e2e.ts` already cleans up: `afterAll` at `:237`, `rmSync(tmpHome, { recursive: true, force: true })` at `:248`. The leak is in the host tests, and `index.test.ts` alone accounts for 39 of the unbalanced sites. The surviving directory names agree — `dsh-restart-guard` 476, `dsh-restart-guard-cache` 476, `dsh-shop` 442, `dsh-gateway-profile` 442, `dsh-gateway-fixture` 442, `dsh-profile` 320, `dsh-fixture` 280, `dsh-hot-profile` 272 — all host-test scenario names. 5,089 directories present when this task was written; the audit measured 9,769 two days earlier and clearing them did not fix H-10.

> **Executed 2026-09-05. Worse than measured, and fixed with one root per file rather than paired removals.**
>
> Re-measured on `5988921`: **101** `mkdtempSync` sites under `tests/host/` against 12 removals, leaving **203** directories per run — not the 39 this task estimated. `index.test.ts` alone had grown from 41 sites to 59, `executor.test.ts` from 10 to 15. /tmp held **8,878**, cleared by hand after the fix.
>
> Two departures from the steps as written:
> 1. **The guard runs the host directory under an isolated `TMPDIR`, not a count of `/tmp`.** `os.tmpdir()` reads `TMPDIR` first on POSIX, so every scenario's directory lands in a sandbox this test owns. A `/tmp` count races with any other suite on the machine and inherits whatever backlog is already there — it would have been green on a busy machine and red on an idle one for reasons unrelated to the code. The guard lives at `tests/`, not `tests/host/`, because a guard inside the directory it runs would spawn itself.
> 2. **Vitest's own `VITEST*` variables are stripped from the child environment.** Inherited, the nested run believes it is a worker of the outer one and exits non-zero before running anything — which failed the guard for a reason that had nothing to do with temporary directories, and would have turned it green the moment the leak was fixed for the same wrong reason. This cost one debugging round and is the kind of thing that makes a guard look like it works.
>
> The fix is `tests/host/temp-root.ts`: `fileTempRoot(label)` creates one root per file and registers a single `afterAll` removal. Paired `rmSync` calls could not have held — a scenario that throws never reaches its own cleanup, and a scenario copied from another inherits the creation without the removal. Nine host files re-rooted, 101 sites, no scenario's assertions touched.
>
> Mutation-checked twice: dropping the `afterAll` leaves 9 roots behind, and reverting `index.test.ts` alone to `tmpdir()` leaves 139. Package suite **633 passed (633)** across 29 files, typecheck clean.

**Files:**
- Modify: `packages/dsh-plugin-shop/tests/host/index.test.ts`, `executor.test.ts`, `dsh-cli.test.ts`, `profile.test.ts`, `restart.test.ts`
- Test: `packages/dsh-plugin-shop/tests/host/temp-home-leak.test.ts` (new)

- [x] **Step 1: Write the failing test**

Create `tests/host/temp-home-leak.test.ts`. It counts `/tmp/dsh-*` directories, runs the host suite in a child process, and counts again:

```ts
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function tempHomes(): number {
  return readdirSync('/tmp', { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('dsh-')).length
}

describe('the host suite leaves no temporary DSH_HOME behind', () => {
  it('ends with the same /tmp/dsh-* count it started with', () => {
    const before = tempHomes()
    execFileSync('npx', ['vitest', 'run', 'tests/host/index.test.ts'], {
      cwd: new URL('../..', import.meta.url).pathname, stdio: 'ignore',
    })
    // A leak is a defect even though the directories are near-empty: 9,769 of
    // them turned `/tmp` into 10,557 entries and made every unrelated `ls
    // /tmp` useless. The cost is inodes and directory entries, not disk.
    expect(tempHomes()).toBe(before)
  })
}, 300_000)
```

- [x] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/temp-home-leak.test.ts` from `packages/dsh-plugin-shop`. Expected: FAIL, `expected 5128 to be 5089` or similar — `index.test.ts` alone leaks 39 per run.

- [x] **Step 3: Write the implementation**

Prefer **one per-run parent** over 41 individual `rmSync` calls: give each file a `mkdtempSync(join(tmpdir(), 'dsh-<file>-'))` root created in `beforeAll`, build every scenario home beneath it, and remove the root in `afterAll` with `rmSync(root, { recursive: true, force: true })`. One cleanup site per file cannot drift out of sync with the creation sites the way 41 paired calls can, and a test that throws mid-scenario still gets its directory removed.

Do not change what any scenario asserts. The homes are inputs, not subjects.

- [x] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/temp-home-leak.test.ts` — Expected: PASS.
Run: `pnpm -C packages/dsh-plugin-shop test` — Expected: PASS, 26 files / 520 tests (25/519 at `5f48787` plus this file's one case).
Run: `pnpm -C packages/dsh-plugin-shop typecheck` — Expected: no output.

Clear the backlog once, by hand, after the fix is in: `find /tmp -maxdepth 1 -type d -name 'dsh-*' -exec rm -rf {} +`. It matches no `claude-*` path and, being `-type d`, skips a packed `.tgz` sitting beside them.

- [x] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/tests/host/
git commit -m "test(host): each host test file owns one temp root and removes it"
```

---
