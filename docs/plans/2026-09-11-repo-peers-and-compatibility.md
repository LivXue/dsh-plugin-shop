# Repo peers and `dsh.compatibility` — implementation plan

> **Status (2026-09-24): implemented**, together with the audit recorded in
> `docs/design/2026-09-01-harness-compatibility.md` §9. The tasks below are
> the plan as written and are left as they were; seven things were built
> differently, each for a reason found while building it:
>
> - **The shared reader excludes optional peers.** One `peerNamesOf`, in
>   `npm-client.ts`, serves both channels and leaves out a peer marked
>   `optional: true` in `peerDependenciesMeta`, before the length filter and
>   the 128-name cap. Task 1's reader took `Object.keys(peerDependencies)`,
>   which records an optional peer as a requirement — the audit found 381 live
>   entries badged for nothing else (design §9.2).
> - **`RepoCandidate.peers` is optional, and its absence queues a
>   re-fetch.** Records revived from `repo-state.json` are a bare cast, so a
>   record written before the change lacks the field at runtime, which Task 1's
>   `peers: string[]` would have typed away. And the rollout note's "roughly
>   eight daily builds" assumed a backfill that re-reads old records; it
>   re-reads only what a marker queues. An absent `peers` now queues its
>   repository once, like `sizeProbed` and `assetVerified`, and
>   `compatibility` rides the same marker (design §9.8).
> - **The verdict lives in `packages/dsh-plugin-shop/src/host/compatibility.ts`,
>   not `peers.ts`,** and its shape is `{ dsh?: { range, running }, profile?:
>   { declared, running } }` rather than Task 7's `{ dsh?: string; profiles?:
>   string[] }`: each half carries both sides, so the copy can name what was
>   declared and what is running.
> - **Github `peers` are harvested and recorded now, but EMITTED only once
>   `SHOP_EMIT_REPO_PEERS` flips** — in the release commit that first
>   promotes a build carrying the module-table refinement to `latest`. Task 3
>   emitted them unconditionally, and an installed shop from 0.8.3 or earlier
>   judges any `peers` by node resolution alone: on a sample of 297 real github
>   manifests it would badge about 15% of github entries, half of them for
>   platform seed words (design §9.8).
> - **The profile half is judged by the harness's own template bundles, not
>   by the profile's name** — Task 7 compared `profiles` with the profile
>   directory's name, which the reader chooses; a `rescue` profile built from
>   the web bundles would have been told it is not `web` (design §9.9).
> - **The running version is read through `nodeVersionResolver`,** at the same
>   profile anchor as the peer check, instead of Task 7's separate
>   `nodeDshVersion` over `createRequire`. That resolver no longer uses
>   `require.resolve` at all (design §9.5), and a second reader would have
>   been a second notion of "the running installation".
> - **The verdict renders as blockers the incompatible filter counts** — on
>   the card, in the install acknowledgement and on the installed rows, under
>   the "Incompatible" badge — rather than as Task 8's two standalone warning
>   lines beside the missing-peer warning. Task 8's `harnessVerdictOf` selector
>   is kept and feeds `blockersOf`, and its copy keys are `harnessRangeDetail`
>   / `harnessProfileDetail` rather than `harnessMismatch` / `profileMismatch`,
>   because each line names both sides. Warn, never block, is unchanged.
>
> The rollout note at the end is superseded too: four of the five
> `@lanxing/dsh-galgame` peers it counts as not resolving are platform seed
> words the web client provides (design §9.1), and the backfill it describes
> needed a marker to happen at all (design §9.8). Measured against the
> committed `repo-state.json` on 2026-09-24, that marker queues 10,629
> repositories: at least six daily builds at the 2,000 budget, not "roughly
> eight".

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two gaps behind "this plugin is incompatible and the shop said nothing": github-channel entries carry no `peers` at all (61% of the catalog, blind since the record shipped), and `dsh.compatibility` — an exact declaration authors already publish — is read by nothing in this repository.

**Architecture:** Both are catalog *records*, not verdicts: the pipeline copies what the package requires, and the reader's own host decides. B1 carries `peerDependencies` names through the github candidate, which already parses the manifest they live in. B2 adds an optional `compatibility` to both channels and a host-side semver comparison against the running harness.

**Tech Stack:** TypeScript ESM (`.ts` extensions in local imports), vitest, zod on the consumer side, `semver` for the comparison.

**Spec:** `docs/design/2026-09-01-harness-compatibility.md` §8 (amended 2026-09-11)

## Global Constraints

- **Everything from npm and GitHub is hostile.** Validate and length-bound at the harvest boundary; these strings reach a published artifact.
- **The catalog records a requirement, never a verdict.** Compatibility depends on who is reading, so the pipeline never decides it.
- **Additive and optional fields ride EVERY `schemaVersion`.** Do not bump `CATALOG_SCHEMA_VERSION`. A consumer's zod is non-strict and strips keys it does not know; emitting a higher version NUMBER is the change that breaks old clients.
- **Optional entry keys sit after `added` and before `tier`** (§7.1). A new key appended there rewrites every entry's hash once, which a new field must; inserting it elsewhere also moves neighbouring keys and widens the delta beyond what the field requires.
- **Warn, never block.** No compatibility fact may remove an entry from the catalog or refuse an install.
- **No verdict when the fact is missing.** Absent, unparseable, or unresolvable each yield silence. One false warning teaches a reader to ignore every warning.
- **`strict` and `noUncheckedIndexedAccess`**; ESM with `.ts` extensions; exactly one trailing newline.
- **Two suites.** Tasks 1-5 are registry code: root `pnpm test` and `pnpm typecheck` cover them. Tasks 6-8 touch `packages/dsh-plugin-shop`, whose tests root `pnpm test` does NOT run — use `pnpm -C packages/dsh-plugin-shop test` (it builds first) and `pnpm -C packages/dsh-plugin-shop typecheck`. **Never run `pnpm build:catalog` to check a change compiles** — it makes thousands of live requests and takes minutes; the fixtures cover every policy decision without a network.

---

### Task 1: The github candidate carries peer names

**Files:**
- Modify: `registry/scripts/src/types.ts` — `RepoCandidate` (line 76 onward)
- Modify: `registry/scripts/src/github-client.ts` — the candidate construction (lines 841–856)
- Test: `registry/scripts/tests/github-client.test.ts`

**Interfaces:**
- Consumes: `PEERS_MAX_COUNT` (128) and `PEER_NAME_MAX_LENGTH` (128), both already exported from `registry/scripts/src/npm-client.ts`.
- Produces: `RepoCandidate.peers: string[]` — the same shape and bounds as `Candidate.peers`, always present, empty when the manifest declares none. Tasks 2 and 3 read it.

- [ ] **Step 1: Write the failing test**

Add to `registry/scripts/tests/github-client.test.ts`, in the describe block that already builds candidates from fixture manifests:

```ts
it('records the repo manifest peerDependencies names, without ranges', async () => {
  const candidate = await candidateFromManifest({
    name: 'dsh-galgame',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.1', react: '^18.2.0' },
  })
  expect(candidate?.peers).toEqual(['@deepseek-ai/cordis', 'react'])
})

it('records an empty peers list when the manifest declares none', async () => {
  const candidate = await candidateFromManifest({ name: 'dsh-plain', dsh: { bundle: {} } })
  expect(candidate?.peers).toEqual([])
})

it('ignores a peerDependencies that is not an object', async () => {
  for (const value of [null, 'react', ['react'], 42]) {
    const candidate = await candidateFromManifest({ name: 'dsh-odd', dsh: { bundle: {} }, peerDependencies: value })
    expect(candidate?.peers).toEqual([])
  }
})

it('drops peer names past the bounds rather than rejecting the candidate', async () => {
  // The same silent trim the npm channel applies: a listing must not be
  // lost to a decoration. docs/schema.md states this trim gets no build
  // report row, on either channel.
  const long = 'a'.repeat(PEER_NAME_MAX_LENGTH + 1)
  const many = Object.fromEntries(
    Array.from({ length: PEERS_MAX_COUNT + 5 }, (_, i) => [`peer-${i}`, '*']),
  )
  const withLong = await candidateFromManifest({ name: 'dsh-long', dsh: { bundle: {} }, peerDependencies: { [long]: '*', ok: '*' } })
  expect(withLong?.peers).toEqual(['ok'])
  const withMany = await candidateFromManifest({ name: 'dsh-many', dsh: { bundle: {} }, peerDependencies: many })
  expect(withMany?.peers).toHaveLength(PEERS_MAX_COUNT)
})
```

`candidateFromManifest` stands for whatever this file already uses to drive a manifest through to a `RepoCandidate` — find it with `grep -n "function \|const .* = async" registry/scripts/tests/github-client.test.ts | head -30` and reuse it. Import the two bounds from `../src/npm-client.ts`.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run registry/scripts/tests/github-client.test.ts -t peer`
Expected: FAIL — `candidate.peers` is `undefined`.

- [ ] **Step 3: Add the field**

In `registry/scripts/src/types.ts`, add to `RepoCandidate` after `hasWorkspaceDeps`:

```ts
  /**
   * The names of the repo manifest's `peerDependencies`, without ranges —
   * the same record, and the same reasoning, as {@link Candidate.peers}.
   *
   * This channel carried none until 2026-09-11, which left the harness
   * compatibility check blind to 6,230 of the catalog's 10,220 entries. The
   * data was always in hand: `github-client` parses the manifest these live
   * in and dropped the field. See 2026-09-01-harness-compatibility §8.1.
   *
   * Persisted, because it rides {@link RepoStateEntry.candidates} into
   * `repo-state.json`: a cached candidate has no `peers` until its
   * repository is re-fetched, so coverage fills in over the backfill budget
   * rather than in one build. An entry with no `peers` carries no verdict,
   * so the interim under-warns and never mis-warns.
   */
  peers: string[]
```

In `registry/scripts/src/github-client.ts`, import the bounds and add a reader above the candidate construction:

```ts
import { PEERS_MAX_COUNT, PEER_NAME_MAX_LENGTH } from './npm-client.ts'
```

```ts
/** The manifest's peer names, bounded exactly as the npm channel bounds
 * them. A non-object `peerDependencies` is not an error: the manifest is
 * untrusted input and a malformed field means "declares none", never a lost
 * listing. */
function peerNamesOf(manifest: unknown): string[] {
  const peers = (manifest as { peerDependencies?: unknown } | null)?.peerDependencies
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return []
  return Object.keys(peers)
    .filter(peer => peer.length > 0 && peer.length <= PEER_NAME_MAX_LENGTH)
    .slice(0, PEERS_MAX_COUNT)
}
```

and add the field to the returned candidate (after `hasWorkspaceDeps`, line ~852):

```ts
    peers: peerNamesOf(m),
```

If the subpackage path (line ~1122) builds its own candidate object, add the same line there, reading the SUBPACKAGE's manifest — a monorepo subpackage declares its own peers and inheriting the root's would be a fabricated record.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run registry/scripts/tests/github-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/github-client.ts registry/scripts/tests/github-client.test.ts
git commit -m "feat(registry): the github candidate carries peer names

The manifest they live in was already parsed and the field was thrown
away, which left the compatibility check blind to 61% of the catalog
from its first commit."
```

---

### Task 2: The repo payload budget counts them

**Files:**
- Modify: `registry/scripts/src/repo-gate.ts` — the `entryPayloadBytes` call (lines ~254–270) and the comment above it
- Test: `registry/scripts/tests/repo-gate.test.ts`

**Interfaces:**
- Consumes: `RepoCandidate.peers` (Task 1).
- Produces: nothing new; the budget's measured bytes now include `peers`.

- [ ] **Step 1: Write the failing test**

Add to `registry/scripts/tests/repo-gate.test.ts`:

```ts
it('counts peers against the per-entry payload budget', async () => {
  // The budget's promise is that the measured bytes are the bytes `emit`
  // will write. A field emitted but not counted breaks exactly that.
  const verdict = await gateRepo(repoCandidate({
    name: 'dsh-heavy',
    peers: Array.from({ length: PEERS_MAX_COUNT }, (_, i) => `${'p'.repeat(PEER_NAME_MAX_LENGTH - 4)}-${i}`),
  }))
  expect(verdict.ok).toBe(false)
  expect(verdict.code).toBe('no-manifest')
  expect(verdict.detail).toMatch(/budget/i)
})

it('lists a repo entry whose peers fit the budget', async () => {
  const verdict = await gateRepo(repoCandidate({ name: 'dsh-light', peers: ['react', '@deepseek-ai/cordis'] }))
  expect(verdict.ok).toBe(true)
})
```

`gateRepo` and `repoCandidate` stand for this file's existing helpers — reuse them, and give `repoCandidate` a `peers: []` default so every other test in the file keeps compiling.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run registry/scripts/tests/repo-gate.test.ts -t budget`
Expected: FAIL — the oversized entry is accepted, because `peers` is not in the measured object.

- [ ] **Step 3: Count it, and correct the comment**

In `repo-gate.ts`, replace the comment at lines ~254–260 and add the field to the measured object in `assignRepoTier`'s key order — after `added`, before `tier`:

```ts
  // The same per-entry budget the npm gate applies, over this channel's own
  // untrusted fields and in `assignRepoTier`'s key order, so the measured
  // bytes are the bytes `emit` will write. `peers` is measured here from
  // 2026-09-11: this channel carried none until then, and the sentence that
  // used to sit here saying so was the written record of a blind spot
  // covering 61% of the catalog (2026-09-01-harness-compatibility §8.1).
  // `tarball.url` comes straight from the GitHub releases API and is bounded
  // nowhere else, and the budget is what covers whatever field an entry
  // grows next. Last, so that every reason naming a single field is reported
  // ahead of it.
```

```ts
    ...(candidate.peers.length > 0 ? { peers: candidate.peers } : {}),
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run registry/scripts/tests/repo-gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/repo-gate.ts registry/scripts/tests/repo-gate.test.ts
git commit -m "fix(registry): the repo budget measures the bytes it will write

peers is about to be emitted on this channel, and a field emitted but
not counted breaks the budget's one promise."
```

---

### Task 3: The repo entry emits them

**Files:**
- Modify: `registry/scripts/src/tier.ts` — `assignRepoTier`'s `base` object (lines ~110–134)
- Test: `registry/scripts/tests/tier.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `RepoCandidate.peers` (Task 1).
- Produces: `Entry.peers` now appears on github entries. Task 6's consumer schema already accepts it.

- [ ] **Step 1: Write the failing test**

Add to `registry/scripts/tests/tier.test.ts`:

```ts
it('emits peers on a github entry, after added and before tier', () => {
  const entry = assignRepoTier(repoAccepted({ peers: ['react', '@deepseek-ai/cordis'] }), emptyConfig())
  expect(entry.peers).toEqual(['react', '@deepseek-ai/cordis'])
  const keys = Object.keys(entry)
  expect(keys.indexOf('peers')).toBeGreaterThan(keys.indexOf('added'))
  expect(keys.indexOf('peers')).toBeLessThan(keys.indexOf('tier'))
})

it('omits peers entirely when the candidate declares none', () => {
  const entry = assignRepoTier(repoAccepted({ peers: [] }), emptyConfig())
  expect('peers' in entry).toBe(false)
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run registry/scripts/tests/tier.test.ts -t peers`
Expected: FAIL — `entry.peers` is `undefined`.

- [ ] **Step 3: Emit it**

In `assignRepoTier`'s `base`, beside `installSize` (which is already in the after-`added` group):

```ts
    // After `added`, with the other optional keys (§7.1). Omitted entirely
    // when empty, exactly as the npm path omits it: an empty array in the
    // artifact would be a claim ("declares no peers") the manifest may not
    // have made, and it costs bytes on every entry that has none.
    ...(repo.peers.length > 0 ? { peers: repo.peers } : {}),
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run registry/scripts/tests/tier.test.ts registry/scripts/tests/pipeline.test.ts`
Expected: PASS. `pipeline.test.ts` holds the determinism test — if a fixture's expected hash changed, that is the field legitimately rewriting entries once. Update the fixture and say so in the commit; **do not** edit the determinism assertion itself.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/tier.ts registry/scripts/tests/
git commit -m "feat(registry): github entries carry peers

Fills the record the compatibility check has been reading an empty
answer from since it shipped. One content-hash rewrite, as any new
emitted field costs."
```

---

### Task 4: Harvest `dsh.compatibility` on both channels

**Files:**
- Modify: `registry/scripts/src/types.ts` — a shared `Compatibility` interface, plus the field on `Candidate` and `RepoCandidate`
- Modify: `registry/scripts/src/npm-client.ts` — beside the `peers` extraction (line ~1497)
- Modify: `registry/scripts/src/github-client.ts` — beside Task 1's `peers: peerNamesOf(m)`
- Test: `registry/scripts/tests/npm-client.test.ts`, `registry/scripts/tests/github-client.test.ts`

**Interfaces:**
- Produces:

```ts
export interface Compatibility {
  /** A semver range naming the dsh versions the author supports. */
  dsh?: string
  /** The profile names the author supports (`web`, `tui`, …). */
  profiles?: string[]
}
```

  and `compatibility?: Compatibility` on both candidates. Tasks 5, 6 and 7 read it.

- [ ] **Step 1: Write the failing tests**

Add to both client test files (adapting the helper names each file already uses):

```ts
it('records a well-formed dsh.compatibility', () => {
  const candidate = toCandidate(manifestWith({
    dsh: { bundle: {}, compatibility: { dsh: '0.1.5-rc.1 || 0.1.6', profiles: ['web'] } },
  }))
  expect(candidate.compatibility).toEqual({ dsh: '0.1.5-rc.1 || 0.1.6', profiles: ['web'] })
})

it('keeps the half that is well formed and drops the half that is not', () => {
  // A malformed half must not cost the other: the author told us something
  // usable and we publish exactly that much.
  const candidate = toCandidate(manifestWith({ dsh: { bundle: {}, compatibility: { dsh: '0.1.5', profiles: 'web' } } }))
  expect(candidate.compatibility).toEqual({ dsh: '0.1.5' })
})

it('omits the field when nothing in it survives', () => {
  for (const value of [null, 'web', 42, [], { dsh: 42, profiles: [7] }]) {
    expect(toCandidate(manifestWith({ dsh: { bundle: {}, compatibility: value } })).compatibility).toBeUndefined()
  }
})

it('bounds the range string and each profile name', () => {
  const candidate = toCandidate(manifestWith({
    dsh: { bundle: {}, compatibility: {
      dsh: 'x'.repeat(COMPATIBILITY_RANGE_MAX_LENGTH + 1),
      profiles: ['web', 'y'.repeat(PROFILE_NAME_MAX_LENGTH + 1)],
    } },
  }))
  expect(candidate.compatibility).toEqual({ profiles: ['web'] })
})

it('bounds how many profiles it records', () => {
  const many = Array.from({ length: COMPATIBILITY_PROFILES_MAX_COUNT + 5 }, (_, i) => `p${i}`)
  const candidate = toCandidate(manifestWith({ dsh: { bundle: {}, compatibility: { profiles: many } } }))
  expect(candidate.compatibility?.profiles).toHaveLength(COMPATIBILITY_PROFILES_MAX_COUNT)
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts -t compatibility`
Expected: FAIL — `compatibility` is `undefined` and the bounds are not exported.

- [ ] **Step 3: Add the type, the bounds and one shared reader**

In `types.ts`:

```ts
/**
 * The author's own machine-readable statement of which harness their plugin
 * supports, copied from the manifest's `dsh.compatibility`.
 *
 * A REQUIREMENT, never a verdict — the same rule as {@link Candidate.peers}:
 * whether it is satisfied depends on the reader's installation, so the
 * comparison happens on the reader's machine.
 *
 * Additive and optional, so it rides EVERY `schemaVersion`; see
 * `emit.ts`'s list for why no version gate is needed, and
 * {@link Candidate.peers} for the stale-version-claim mistake this comment
 * exists not to repeat.
 */
export interface Compatibility {
  /** A semver range over `@deepseek-ai/dsh` versions. */
  dsh?: string
  /** The profile names the plugin supports. */
  profiles?: string[]
}
```

Add `compatibility?: Compatibility` to both `Candidate` and `RepoCandidate`, documenting on `RepoCandidate` that it too rides `repo-state.json` and backfills.

In `npm-client.ts`, beside the other bounds (near line 1329):

```ts
/** Longest `dsh.compatibility.dsh` range recorded. A real range is a handful
 * of versions joined by `||`; @xmanrui/dsh-im's five-version list, the
 * longest seen on 2026-09-11, is 78 characters. */
export const COMPATIBILITY_RANGE_MAX_LENGTH = 256
/** Longest profile name recorded. dsh's own are `web`, `tui`, `headless`. */
export const PROFILE_NAME_MAX_LENGTH = 64
/** Most profile names recorded. */
export const COMPATIBILITY_PROFILES_MAX_COUNT = 16

/**
 * Read `dsh.compatibility` out of an untrusted manifest, keeping only what
 * is well formed. A malformed half never costs the other, and a field with
 * nothing usable in it is absent rather than empty: an empty object in the
 * artifact would read as a declaration the author did not make.
 */
export function compatibilityOf(dsh: unknown): Compatibility | undefined {
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return undefined
  const raw = (dsh as { compatibility?: unknown }).compatibility
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { dsh: range, profiles } = raw as { dsh?: unknown; profiles?: unknown }
  const out: Compatibility = {}
  if (typeof range === 'string' && range.length > 0 && range.length <= COMPATIBILITY_RANGE_MAX_LENGTH) {
    out.dsh = range
  }
  if (Array.isArray(profiles)) {
    const kept = profiles
      .filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length <= PROFILE_NAME_MAX_LENGTH)
      .slice(0, COMPATIBILITY_PROFILES_MAX_COUNT)
    if (kept.length > 0) out.profiles = kept
  }
  return out.dsh === undefined && out.profiles === undefined ? undefined : out
}
```

Call it from both channels. npm (beside line 1497's `peers`):

```ts
    ...(() => {
      const compatibility = compatibilityOf(manifest.dsh)
      return compatibility === undefined ? {} : { compatibility }
    })(),
```

github (beside Task 1's `peers` line):

```ts
    ...(() => {
      const compatibility = compatibilityOf(m.dsh)
      return compatibility === undefined ? {} : { compatibility }
    })(),
```

The reader lives in `npm-client.ts` because that is where the sibling bounds live; `github-client.ts` already imports from it after Task 1.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/npm-client.ts registry/scripts/src/github-client.ts registry/scripts/tests/
git commit -m "feat(registry): harvest the author's own dsh.compatibility

@xmanrui/dsh-im has published an exact list of the dsh versions it
supports since 4.19.2, the running harness is not on it, and nothing
here has ever read the field."
```

---

### Task 5: Gate, tier and emit carry it through

**Files:**
- Modify: `registry/scripts/src/gate.ts` — the `entryPayloadBytes` call (line ~401)
- Modify: `registry/scripts/src/repo-gate.ts` — the same, beside Task 2's `peers`
- Modify: `registry/scripts/src/tier.ts` — `assignTier` (line ~62) and `assignRepoTier`
- Modify: `registry/scripts/src/types.ts` — `Entry.compatibility?: Compatibility`
- Modify: `registry/scripts/src/emit.ts` — the additive-fields list in the comment at line ~209
- Test: `registry/scripts/tests/gate.test.ts`, `tier.test.ts`, `emit.test.ts`, `pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// gate.test.ts and repo-gate.test.ts
it('counts compatibility against the payload budget', () => {
  const verdict = gateCandidate(candidate({
    compatibility: { dsh: 'x'.repeat(COMPATIBILITY_RANGE_MAX_LENGTH), profiles: Array.from({ length: COMPATIBILITY_PROFILES_MAX_COUNT }, (_, i) => `p${i}`.repeat(20)) },
    catalog: oversizedCatalogSection(),
  }))
  expect(verdict.ok).toBe(false)
})

// tier.test.ts — assert for BOTH assignTier and assignRepoTier
it('emits compatibility after added and before tier', () => {
  const entry = assignTier(accepted({ compatibility: { dsh: '0.1.5' } }), emptyConfig())
  expect(entry.compatibility).toEqual({ dsh: '0.1.5' })
  const keys = Object.keys(entry)
  expect(keys.indexOf('compatibility')).toBeGreaterThan(keys.indexOf('added'))
  expect(keys.indexOf('compatibility')).toBeLessThan(keys.indexOf('tier'))
})

it('omits compatibility when the candidate declares none', () => {
  expect('compatibility' in assignTier(accepted({}), emptyConfig())).toBe(false)
})

// emit.test.ts
it('emits compatibility at every schemaVersion', () => {
  // Additive and optional: an old client's zod strips the key. Bumping the
  // version NUMBER is what breaks old clients, so this field must never be
  // gated on one.
  for (const version of [5, CATALOG_SCHEMA_VERSION]) {
    const [entry] = emitEntries([entryWith({ compatibility: { dsh: '0.1.5' } })], version).plugins
    expect(entry?.compatibility).toEqual({ dsh: '0.1.5' })
  }
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run registry/scripts/tests/gate.test.ts registry/scripts/tests/tier.test.ts registry/scripts/tests/emit.test.ts -t compatibility`
Expected: FAIL.

- [ ] **Step 3: Thread it through**

Add to `Entry` in `types.ts` (documented as riding every `schemaVersion`, in those words). Add to both payload-budget objects and both tier `base` objects, in the after-`added` group, using the same `...(x !== undefined ? { compatibility: x } : {})` form as `publisher`.

In `emit.ts`, add `compatibility` to the parenthesised list in the comment at line ~209 — that comment is explicitly "the one place the 'does a new field need a version gate?' decision is recorded", and a reader who finds their field missing cannot tell a deliberate gate from an omission:

```ts
  // The additive fields (`added`, `tarball`, `replacement`, `peers`,
  // `publisher`, `unpackedSize`, `installSize`, `compatibility`) ride EVERY
  // version: ...
```

Confirm `toWellFormedEntry` reaches the new strings — it runs over the whole entry, so a lone surrogate in a range or a profile name is already covered. Add an `emit.test.ts` case asserting it, since the comment above it claims coverage "for whatever fields an Entry grows next" and that claim is now being cashed:

```ts
it('well-forms the compatibility strings like every other published string', () => {
  const [entry] = emitEntries([entryWith({ compatibility: { dsh: 'MIT\ud800', profiles: ['web\ud800'] } })], CATALOG_SCHEMA_VERSION).plugins
  expect(entry?.compatibility?.dsh).not.toContain('\ud800')
  expect(entry?.compatibility?.profiles?.[0]).not.toContain('\ud800')
})
```

- [ ] **Step 4: Run the whole registry suite**

Run: `pnpm vitest run registry/scripts/tests/`
Expected: PASS. Again: a determinism fixture whose hash moved is this field rewriting entries once — update the fixture, never the assertion.

- [ ] **Step 5: Check the generated schema is unaffected**

Run: `pnpm emit:schema && git diff --exit-code registry/schema/plugin-entry.schema.json`
Expected: **no diff.** `plugin-entry.schema.json` defines `dsh.catalog` only — its top-level properties are `category`, `summary`, `capabilities`. `dsh.compatibility` is a sibling of `dsh.catalog`, not part of it, so it is deliberately outside that schema; widening it would change what the file means. Authors learn the field from `docs/schema.md` (Task 9). If this command produces a diff, something touched the catalog-section zod and should not have.

- [ ] **Step 6: Commit**

```bash
git add registry/scripts/ registry/schema/
git commit -m "feat(registry): compatibility rides every schemaVersion to the catalog

Recorded in emit.ts's additive-field list, which is the one place that
decision is written down — peers went missing from the badges for a
year because a stale version claim outlived its gate."
```

---

### Task 6: The consumer accepts the new fields

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` — the entry zod (line ~172) and the schema comment (line ~18)
- Modify: `packages/dsh-plugin-shop/src/host/types.ts` — `CatalogEntry` (the `peers` comment at line ~49)
- Test: `packages/dsh-plugin-shop/tests/host/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('accepts an entry carrying compatibility', () => {
  const entry = parseCatalogEntry(fixtureEntry({ compatibility: { dsh: '0.1.5 || 0.1.6', profiles: ['web'] } }))
  expect(entry.compatibility).toEqual({ dsh: '0.1.5 || 0.1.6', profiles: ['web'] })
})

it('accepts a github entry carrying peers', () => {
  // Until 2026-09-11 no github entry could; the shape was always legal.
  const entry = parseCatalogEntry(fixtureEntry({ source: 'github', repo: 'o/s', peers: ['react'] }))
  expect(entry.peers).toEqual(['react'])
})

it('accepts an entry with neither', () => {
  expect(parseCatalogEntry(fixtureEntry({})).compatibility).toBeUndefined()
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/catalog.test.ts -t compatibility`
Expected: FAIL — zod strips `compatibility`, so it reads `undefined`.

- [ ] **Step 3: Widen the schema and correct two stale comments**

In `catalog.ts`, beside `peers` (line ~172):

```ts
  compatibility: z.object({
    dsh: z.string().optional(),
    profiles: z.array(z.string()).optional(),
  }).optional(),
```

Correct the comment at line ~18, which currently says schemaVersion "6 adds `peers`" — that gate came off on 2026-09-03 without ever being opened, and this is the consumer-side copy of exactly the stale claim `registry/scripts/src/types.ts` warns the next additive field will inherit.

Correct the same claim in `src/host/types.ts`, where `CatalogEntry.peers` is documented as "(schemaVersion 6)":

```ts
  /** The package's declared peer dependency names. Additive and optional, so
   * it rides every schemaVersion — the gate this once named came off on
   * 2026-09-03 without being opened. Present on npm entries since then and
   * on github entries since 2026-09-11. */
  peers?: string[]
  /** The author's declared harness compatibility, when they published one
   * (`dsh.compatibility`). A REQUIREMENT, not a verdict: the host compares
   * it against the running installation. Rides every schemaVersion. */
  compatibility?: { dsh?: string; profiles?: string[] }
```

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/catalog.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/src/host/types.ts packages/dsh-plugin-shop/tests/host/catalog.test.ts
git commit -m "feat(shop): read compatibility, and stop claiming peers needs v6

The consumer carried the same stale version claim the registry side
already corrected — the one the registry's own comment warns the next
additive field will copy."
```

---

### Task 7: The host forms the compatibility verdict

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/peers.ts` — a new exported function beside `incompatibilityMap`
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` — compute it beside `incompatible` (line ~741) and add it to the catalog snapshot result
- Test: `packages/dsh-plugin-shop/tests/host/peers.test.ts`

**Interfaces:**
- Produces:

```ts
export type CompatibilityVerdict = { dsh?: string; profiles?: string[] }
export function compatibilityMap(
  entries: readonly (EntryIdentity & { compatibility?: { dsh?: string; profiles?: string[] } })[],
  runtime: { dshVersion: string | null; profile: string },
): Record<string, CompatibilityVerdict>
```

  keyed by `identityKey`, present only when the entry declares something the runtime does NOT satisfy. `dsh` carries the declared range; `profiles` carries the declared list. Task 8 renders it.

- [ ] **Step 1: Write the failing test**

```ts
import { compatibilityMap } from '../../src/host/peers.ts'

const RUNTIME = { dshVersion: '0.1.5-rc.1', profile: 'web' }

describe('compatibilityMap', () => {
  it('reports a declared range the running harness does not satisfy', () => {
    // Measured 2026-09-11: this is @xmanrui/dsh-im@4.19.2's own declaration
    // against the harness that was running when it was reported.
    const map = compatibilityMap([entry('@xmanrui/dsh-im', {
      dsh: '0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1 || 0.1.3-alpha.1 || 0.1.5-alpha.1',
    })], RUNTIME)
    expect(map[identityKey(entry('@xmanrui/dsh-im', {}))]?.dsh).toContain('0.1.5-alpha.1')
  })

  it('says nothing when the running harness satisfies the range', () => {
    expect(compatibilityMap([entry('ok', { dsh: '0.1.5-rc.1 || 0.2.0' })], RUNTIME)).toEqual({})
  })

  it('says nothing when the entry declares no compatibility', () => {
    expect(compatibilityMap([entry('plain', undefined)], RUNTIME)).toEqual({})
  })

  it('reports a profile list that does not name the running profile', () => {
    expect(compatibilityMap([entry('tui-only', { profiles: ['tui'] })], RUNTIME)[identityKey(entry('tui-only', {}))]?.profiles)
      .toEqual(['tui'])
  })

  it('says nothing when the profile list names the running profile', () => {
    expect(compatibilityMap([entry('web-ok', { profiles: ['web', 'tui'] })], RUNTIME)).toEqual({})
  })

  it('gives NO verdict when the harness version is unknown', () => {
    // §3's rule: an unavailable fact reads as "unknown", never as an
    // accusation. The profile half is still judged.
    const map = compatibilityMap([entry('x', { dsh: '0.9.0', profiles: ['tui'] })], { dshVersion: null, profile: 'web' })
    expect(map[identityKey(entry('x', {}))]).toEqual({ profiles: ['tui'] })
  })

  it('gives NO verdict for a range semver cannot parse', () => {
    expect(compatibilityMap([entry('bad', { dsh: 'not a range' })], RUNTIME)).toEqual({})
  })

  it('judges a prerelease harness against a prerelease range', () => {
    // The harness ships prereleases continuously; without includePrerelease
    // every rc bump becomes a false alarm (§7's reasoning, same rule here).
    expect(compatibilityMap([entry('pre', { dsh: '>=0.1.0' })], RUNTIME)).toEqual({})
  })
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/peers.test.ts -t compatibilityMap`
Expected: FAIL — not exported.

- [ ] **Step 3: Write it**

In `peers.ts`, beside `incompatibilityMap`:

```ts
/**
 * Entries whose AUTHOR-DECLARED compatibility the running installation does
 * not meet, keyed by install identity (2026-09-01-harness-compatibility
 * §8.2). A key is present only when something was declared AND is not
 * satisfied, so an absent key means "runs here, or we could not tell" — the
 * same rule `incompatibilityMap` follows, and for the same reason.
 *
 * `includePrerelease`: the harness ships prereleases continuously
 * (`0.1.5-rc.1`), and ordinary semver refuses a prerelease against a range
 * whose comparators carry none — so without it every rc bump would accuse
 * every plugin that declared a plain range. §7 settled this for the shop's
 * own peers; the same reasoning governs here.
 */
export function compatibilityMap(
  entries: readonly (EntryIdentity & { compatibility?: { dsh?: string; profiles?: string[] } })[],
  runtime: { dshVersion: string | null; profile: string },
): Record<string, { dsh?: string; profiles?: string[] }> {
  const out: Record<string, { dsh?: string; profiles?: string[] }> = {}
  for (const entry of entries) {
    const declared = entry.compatibility
    if (declared === undefined) continue
    const verdict: { dsh?: string; profiles?: string[] } = {}
    const range = declared.dsh
    // No verdict when the fact is missing on either side: an unresolvable
    // harness version or an unparseable range is an unknown, never an
    // accusation.
    if (range !== undefined && runtime.dshVersion !== null
      && validRange(range) !== null && valid(runtime.dshVersion) !== null
      && !satisfies(runtime.dshVersion, range, { includePrerelease: true })) {
      verdict.dsh = range
    }
    const profiles = declared.profiles
    if (profiles !== undefined && profiles.length > 0 && !profiles.includes(runtime.profile)) {
      verdict.profiles = profiles
    }
    if (verdict.dsh !== undefined || verdict.profiles !== undefined) out[identityKey(entry)] = verdict
  }
  return out
}
```

`satisfies`, `valid` and `validRange` are already imported at the top of this file.

Add the runtime reader beside `nodeResolver`:

```ts
/** The running harness version, through the same profile anchor
 * `nodeResolver` uses — so this verdict and the peer verdict cannot drift
 * onto different notions of "the running installation". `null` when it
 * cannot be read, which yields no verdict rather than a warning. */
export function nodeDshVersion(baseUrl: string): string | null {
  try {
    const require = createRequire(baseUrl)
    const manifest = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    // Unresolvable, unreadable, or unparseable — each means the same thing
    // here: we do not know what is running, so we accuse nobody.
    return null
  }
}
```

In `index.ts`, compute it beside `incompatible` (line ~741) and add `incompatibleHarness` to the same snapshot result, with a `dshVersion?: string | null` test seam mirroring `resolvePeer`.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/peers.test.ts packages/dsh-plugin-shop/tests/host/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/peers.ts packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/
git commit -m "feat(shop): judge the author's declared compatibility on this machine

Same anchor as the peer check, so the two cannot drift onto different
notions of the running installation. Prereleases are included, or
every rc bump accuses every plugin that declared a plain range."
```

---

### Task 8: The reader sees it

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts` — a selector beside `missingPeersOf`
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` — `zh` and `en`
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` — the badge site that already renders the missing-peer warning
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`, `ShopTab.client.spec.tsx`

- [ ] **Step 1: Write the failing tests**

```ts
// present.test.ts
describe('harnessVerdictOf', () => {
  it('returns the verdict for this identity', () => {
    const map = { 'npm:dsh-im': { dsh: '0.1.2-rc.1' } }
    expect(harnessVerdictOf(map, 'npm:dsh-im')).toEqual({ dsh: '0.1.2-rc.1' })
  })
  it('returns undefined for an entry with no verdict', () => {
    expect(harnessVerdictOf({}, 'npm:other')).toBeUndefined()
  })
})
```

```tsx
// ShopTab.client.spec.tsx
it('warns when the author declared a harness this installation is not', () => {
  const { getByText } = renderCard({ entry: entryFixture('dsh-im'), incompatibleHarness: { 'npm:dsh-im': { dsh: '0.1.2-rc.1' } } })
  expect(getByText(en.harnessMismatch.replace('{range}', '0.1.2-rc.1'))).toBeTruthy()
})

it('warns when the author declared profiles this one is not among', () => {
  const { getByText } = renderCard({ entry: entryFixture('dsh-tui-thing'), incompatibleHarness: { 'npm:dsh-tui-thing': { profiles: ['tui'] } } })
  expect(getByText(en.profileMismatch.replace('{profiles}', 'tui'))).toBeTruthy()
})

it('says nothing for an entry with no verdict', () => {
  const { queryByText } = renderCard({ entry: entryFixture('fine'), incompatibleHarness: {} })
  expect(queryByText(/harness/i)).toBeNull()
})
```

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/ -t harness`
Expected: FAIL.

- [ ] **Step 3: Add the selector, the copy and the badge**

`present.ts`, beside `missingPeersOf` (which documents the keyed-by-identity rule — follow it, two entries can share a name):

```ts
/** The author's declared harness compatibility that this installation does
 * not meet, or undefined when the host gave no verdict. Keyed by install
 * identity, never by name, for the same reason `missingPeersOf` is. */
export function harnessVerdictOf(
  verdicts: Record<string, { dsh?: string; profiles?: string[] }>,
  key: string,
): { dsh?: string; profiles?: string[] } | undefined {
  return verdicts[key]
}
```

Locales — `zh`:

```ts
  harnessMismatch: '作者声明此插件支持 dsh {range}，与你正在运行的版本不符',
  profileMismatch: '作者声明此插件支持 {profiles} profile，与你当前的不符',
```

`en`:

```ts
  harnessMismatch: 'the author declares support for dsh {range}, which is not the version you are running',
  profileMismatch: 'the author declares support for the {profiles} profile(s), which is not the one you are on',
```

Render both beside the existing missing-peer warning in `ShopTab.tsx`, using the same styling and the same **warn, never block** placement: the install button stays enabled. An entry may carry both verdicts and both lines render.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/`
Expected: PASS, including the zh/en key-parity test.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/ packages/dsh-plugin-shop/tests/client/
git commit -m "feat(shop): show the author's own compatibility claim when it fails

Warn, never block: the install button stays enabled. The author said
which harness they support; the reader is entitled to see that before
they install, not after their profile stops booting."
```

---

### Task 9: Tell authors the field is read

**Files:**
- Modify: `docs/schema.md` line 66 (and the paragraph's `peers` claim at line 36)
- Modify: `docs/schema.zh.md` line 66 (and its line-38 twin)

- [ ] **Step 1: Correct the npm-only claim**

`docs/schema.md` line 66 currently opens "An npm entry also carries `peers` …". Replace the sentence's scope and add the new field:

```
Every entry also carries `peers` — the names of the package's declared `peerDependencies`, never a version range. A reader's own dsh resolves each name against its installation and reports back whichever it cannot provide, so the shop can badge a listing before someone installs a plugin their harness cannot run. Listings taken from a GitHub repository carry it too, from 2026-09-11; before that they carried none, and the badge could say nothing about them. A repository already in the build's cache gains its `peers` the next time that repository is re-read, not on the first build after the change, so the badge fills in over several days.

If your manifest declares `dsh.compatibility`, the catalog records that as well: `dsh`, a semver range naming the harness versions you support, and `profiles`, the profile names you support. Both are optional and either may stand alone. The build copies them; it never judges them — the reader's own dsh compares them against what it is actually running, and the shop shows a warning, never a refusal. Declaring nothing is not a claim of incompatibility and produces no warning at all.
```

- [ ] **Step 2: Correct the Chinese twin**

`docs/schema.zh.md` line 66 — the same facts in Chinese, in its own register, not a word-for-word rendering:

```
每条条目还带一个 `peers` 字段——插件在 `peerDependencies` 里声明的模块名，从不包含版本范围。读者自己的 dsh 会拿这些名字逐一匹配本机的安装，把解析不到的报告回来，商店据此在有人安装一个自己 harness 跑不起来的插件之前，先打上标记。自 2026-09-11 起，从 GitHub 仓库上架的条目同样带这个字段；在那之前它们一个都没有，标记对它们说不出任何话。已经在构建缓存里的仓库要等到下次被重新读取时才会补上 `peers`，不是改动后的第一次构建就齐，所以标记会在几天里逐步铺满。

如果你的 manifest 声明了 `dsh.compatibility`，目录也会记录下来：`dsh` 是一个 semver 范围，写明你支持的 harness 版本；`profiles` 是你支持的 profile 名。两者都可选，也可以只写其中一个。构建只负责抄录，不做判断——由读者自己的 dsh 拿它和实际运行的版本比对，商店给出的是提示，不是拒绝。什么都不声明不等于声明不兼容，不会产生任何提示。
```

- [ ] **Step 3: Check the length-bounds paragraph**

Line 36 (English) and line 38 (Chinese) enumerate every bound the build applies on the author's behalf, and both now understate it. Add the three new bounds to each: the `dsh.compatibility.dsh` range at 256 characters, each profile name at 64, and at most 16 profiles — trimmed silently, with no build-report row, exactly like the `peers` trim the paragraph already describes.

- [ ] **Step 4: Full verification**

```bash
pnpm test > /tmp/registry-test.log 2>&1; echo "REGISTRY EXIT=$?"; tail -5 /tmp/registry-test.log
pnpm -C packages/dsh-plugin-shop test > /tmp/shop-test.log 2>&1; echo "SHOP EXIT=$?"; tail -3 /tmp/shop-test.log
pnpm typecheck && pnpm -C packages/dsh-plugin-shop typecheck
pnpm emit:schema && git diff --exit-code registry/schema/plugin-entry.schema.json && echo "generated schema unchanged, as intended"
```

Expected: `EXIT=0`, clean typecheck, no schema diff. **Redirect and echo the exit code** — piping vitest into `tail` prints exit 0 over a red run.

- [ ] **Step 5: Commit**

```bash
git add docs/schema.md docs/schema.zh.md
git commit -m "docs(schema): peers is no longer npm-only, and compatibility is read

An author reads this file to find out how their package was listed.
It said npm-only because it was true, and it stopped being true."
```

---

## Rollout note (not a task)

`peers` on github entries fills in over roughly **eight daily builds**, not one: `RepoCandidate` is persisted in `registry/repo-state.json` (15,748 repositories on 2026-09-11) and the GitHub half re-reads at most `REPO_BACKFILL_BUDGET_DEFAULT` (2,000) of them per build. An entry with no `peers` carries no verdict, so the interim under-warns and never mis-warns — but do not read an unbadged github entry as evidence the change failed until the backfill has had time to run. `@lanxing/dsh-galgame` is the entry to check: five of its eight declared peers do not resolve on a stock profile, so it should badge once its repository is re-read.
