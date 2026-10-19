# An npm package hides only its own owner's repositories — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An accepted npm package hides a same-named repository candidate
only when the repository its manifest declares belongs to that candidate's
owner, or cannot be read as a GitHub URL. Every other candidate is gated on
its own, and every `shadowed-by-npm` row says which case hid it.

**Architecture:** One pure function, `npmShadowOf`, lives in a new
`registry/scripts/src/npm-shadow.ts`. It returns the `shadowed-by-npm` row for
a repository candidate, or `null`. `selectEntries` (`pipeline.ts`) and
`selectPending` (`classify-select.ts`) both call it with a map from every
ACCEPTED npm name to the repository that package declares, which both build
with the same module's `acceptedNpmRepositories`. The shop's source
does not change: pin tests come first and show that the released shop already
handles an npm entry and a github entry of one name.

**Tech Stack:** TypeScript ESM (`strict`, `noUncheckedIndexedAccess`),
vitest 2.1, Node 26 type stripping for the offline replay.

**Spec:** `docs/design/2026-10-19-npm-shadow-by-owner.md`, with the
corrections made while planning and after PR #103's review. Read §2, §3 and
§7 before any task.

## Global Constraints

- **Pure module.** `npm-shadow.ts` imports only `types.ts` (types),
  `Accepted` from `gate.ts` (a type), `githubOwnerName` from `github-repo.ts`,
  and `repoUnit` from `identity.ts`.
  - No clock, network, filesystem, environment or locale.
  - Case-folding is `toLowerCase`, because GitHub logins and repository names
    are ASCII.
- **The code stays `shadowed-by-npm`.** A new code changes a published
  artifact. Only `detail` changes, and its copy is exactly Task 2's three
  strings.
- **A rejected npm package hides nothing** (B-6). Only accepted packages enter
  the map.
- **`githubOwnerName` is not changed.** Its "no guesses" rule is shared with
  the stars sidecar and the denial check.
- **The candidate's owner** is the text of `RepoCandidate.repo` before its
  first `/`: the search's `owner/slug`, never the `repository` field.
- **No shop source change.**
  `git diff origin/main...HEAD -- packages/dsh-plugin-shop/src` stays empty:
  the three dots diff against the merge base, so shop changes that reach
  `main` meanwhile are not counted as this branch's. If a Task 1 pin fails on
  today's code, stop (spec §8 step 0).
- **Repository conventions.**
  - `.ts` extensions on local imports, and every file ends with exactly one
    newline.
  - An edited test says why in its commit.
  - Every commit ends with
    `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
  - Work on branch `fix/npm-shadow-by-owner` in
    `.claude/worktrees/npm-shadow-by-owner`. It is merged by rebase later, so
    each commit message is part of the history.
- **Commands.**
  - Registry suite: `pnpm test` from the worktree root.
  - Registry typecheck: `pnpm typecheck`, which covers
    `registry/scripts/**`, tests included.
  - Shop files: from `packages/dsh-plugin-shop`, run
    `node node_modules/vitest/vitest.mjs run <files>`. Not `npx`, which can put
    another `dsh` first on `PATH`.
  - Baseline, before any task, on `cf44ee5`'s code: registry 1797/1797
    passed; Task 1's four shop files plus `tests/host/identity.test.ts`,
    740/740.

## Review Focus

Five inputs the spec implies, but which no case in it exercises, ordered by
how likely each is to bite. Each line names the task whose tests pin it.

1. **A prefix of an owner.** The npm package names
   `https://github.com/ali/dsh-x` and the candidate is `alice/dsh-x`. That is
   another owner, and the candidate is not hidden. (Task 2)
2. **A GitHub URL `githubOwnerName` refuses.** A `/tree/main/packages/x`
   path, or a `www.github.com` host, is hidden with the third detail. That is
   today's behaviour, so nothing is listed by accident. (Task 2)
3. **A `|` in the declared repository name.** The URL keeps it in the path,
   the same-owner detail quotes it, and `report.md` must escape it rather than
   grow a column. (Task 3)
4. **Another owner's monorepo under an npm name.** Each subpackage is listed
   beside the npm entry with its own identity. (Task 3: this is the old
   line-748 pair.)
5. **A declared npm package and another owner's derived repository of its
   name.** The name becomes live and pending with the repository's own
   description. If that repository is hidden instead, the name is in neither
   set. (Task 3)

---

### Task 1: Pin the shop's handling of an npm + github pair (spec §8 step 0)

Tests only, on today's code. They must pass before any registry change.

**Files:**
- Modify: `packages/dsh-plugin-shop/tests/host/index.test.ts`, in the
  `two catalog entries share one name (G-1)` describe, after
  `does not let an npm namesake claim a repo entry's installed row`.
- Modify: `packages/dsh-plugin-shop/tests/host/install.test.ts`: a new
  describe after `validateInstall identity (G-1)`.
- Modify: `packages/dsh-plugin-shop/tests/client/present.test.ts`, in the
  `heldBy` describe.
- Modify: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`,
  after `addresses two same-named repository entries separately (G-1)`.

**Interfaces:** none produced. The tests read `ShopGateway.installed`,
`validateInstall`, `heldBy` and the rendered card as they stand.

- [ ] **Step 1: `installed()` gives each spec form to exactly one sibling**

Add a describe-local helper and three cases. Leave the existing inline-twin
case as it is.

```ts
// An npm entry and a github entry of one name, which the catalog lists
// once an npm package hides only its own owner's repositories (design
// 2026-10-19-npm-shadow-by-owner §5). A profile holds one dependency per
// name, so every spec form must land on exactly one of the two rows.
function gatewayWithNpmTwin(dir: string, sibling: CatalogEntry, dependencies: Record<string, string>): ShopGateway {
  const profileDir = mkdtempSync(join(TEMP_ROOT, 'dsh-pair-profile-'))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: Object.keys(dependencies) } }, dependencies }))
  const npmTwin: CatalogEntry = { ...alice, version: '2.0.0', integrity: 'sha512-x', source: 'npm', repo: undefined }
  return new ShopGateway(stubCtx(), {
    catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
    loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [sibling, npmTwin], denied: [], stars: {} }, stale: false }) as CatalogResult,
  })
}

it.each([['an npm range', '^2.0.0'], ['a spec it cannot attribute', 'file:../fork']])(
  'gives %s to the npm entry alone, beside its github namesake', async (_, spec) => {
    const gateway = gatewayWithNpmTwin(mkdtempSync(join(TEMP_ROOT, 'dsh-pair-npm-')), bob, { 'dsh-foo': spec })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-foo', source: 'npm', installed: spec, latest: '2.0.0', outdated: false, enabled: true,
    }])
  })

it('gives a release tarball URL to its rescued github entry alone', async () => {
  const url = 'https://github.com/bob/dsh-foo/releases/download/v1.0.0/p.tgz'
  const rescued: CatalogEntry = { ...bob, version: 'v1.0.0', tarball: { url, sha256: 'f'.repeat(64) } }
  const gateway = gatewayWithNpmTwin(mkdtempSync(join(TEMP_ROOT, 'dsh-pair-tarball-')), rescued, { 'dsh-foo': url })
  await gateway.catalog({})
  expect(await gateway.installed()).toEqual([{
    name: 'dsh-foo', source: 'github', repo: 'bob/dsh-foo', installed: url, latest: 'v1.0.0', outdated: false, enabled: true,
  }])
})
```

- [ ] **Step 2: `validateInstall` resolves each sibling and refuses across them**

New describe `validateInstall with an npm entry and a github entry of one name`.

- Fixture `npmFoo`:
  - `name: 'dsh-foo'`, `version: '2.0.0'`, `integrity: 'sha512-x'`,
    `publishedAt: null`;
  - `repository: 'https://github.com/alice/dsh-foo'`, `license: 'MIT'`,
    `tier: 'community'`, `metadata: 'derived'`, `source: 'npm'`,
    `added: '2026-08-25'`.
- Fixture `bob`: `{ ...npmFoo, version: 'b'.repeat(40), integrity: null,
  source: 'github', repo: 'bob/dsh-foo', repository: 'https://github.com/bob/dsh-foo' }`.
- Snapshot `pair`: `{ schemaVersion: 6, builtAt: '', entries: [bob, npmFoo],
  denied: [], stars: {} }`. The github entry comes first, which is the
  catalog's order (`compareEntries`).

Every request carries `acknowledged: true`.

| case | request | installed spec | expected |
|---|---|---|---|
| `resolves the npm identity to the npm entry` | `source: 'npm'`, version `2.0.0` | — | `ok`, `entry.source === 'npm'` |
| `resolves the github identity to the github entry` | `source: 'github'`, `repo: 'bob/dsh-foo'`, `bob.version` | — | `ok`, `entry.repo === 'bob/dsh-foo'` |
| `refuses a name-only request as ambiguous` | name and `2.0.0` only | — | `ambiguous-identity`, detail exactly `dsh-plugin-shop: the catalog holds 2 entries named dsh-foo, and this request does not say which one; refresh the shop and try again` |
| `refuses the npm sibling while the github one is installed` | npm, `2.0.0` | `github:bob/dsh-foo` | `name-taken`, detail contains `bob/dsh-foo` |
| `refuses the github sibling while the npm one is installed` | github, bob | `^2.0.0` | `name-taken`, detail contains `npm:dsh-foo` |
| `lets each sibling update itself` | npm with `^1.0.0` installed; github with `github:bob/dsh-foo` installed | as stated | both `ok` |

- [ ] **Step 3: `heldBy` marks only the sibling that is not installed**

Add this case to the `heldBy` describe, which already has `entry` (npm
`dsh-hello-plugin`) and `repoEntry` (github `Mvyvn/dsh-hello-plugin`):

```ts
it('marks only the sibling that is not installed, for an npm entry and a github entry of one name', () => {
  const github = { 'dsh-hello-plugin': 'github:Mvyvn/dsh-hello-plugin' }
  expect(heldBy(entry, github)).toBe('Mvyvn/dsh-hello-plugin')
  expect(heldBy(repoEntry, github)).toBeUndefined()
  const npm = { 'dsh-hello-plugin': '^1.0.0' }
  expect(heldBy(entry, npm)).toBeUndefined()
  expect(heldBy(repoEntry, npm)).toBe('npm:dsh-hello-plugin')
})
```

- [ ] **Step 4: the shelf refuses only the npm card**

```ts
it('refuses only the npm card while its github namesake is installed', async () => {
  const base = snapshot().plugins[0]
  if (base === undefined) throw new Error('the fixture snapshot has no entry')
  const npmFoo = { ...base, name: 'dsh-foo', version: '2.0.0' }
  const bob = { ...base, name: 'dsh-foo', version: 'b'.repeat(40), source: 'github' as const, repo: 'bob/dsh-foo', repository: 'https://github.com/bob/dsh-foo' }
  const { injected } = bench({ ...snapshot(), plugins: [bob, npmFoo] }, [{
    name: 'dsh-foo', source: 'github', repo: 'bob/dsh-foo', installed: 'b'.repeat(40), latest: 'b'.repeat(40), outdated: false, enabled: true,
  }])
  const { container } = renderTab(injected)
  await waitFor(() => expect(container.querySelectorAll('[data-shop-entry="dsh-foo"]')).toHaveLength(2))
  const refused = [...container.querySelectorAll('[data-shop-entry="dsh-foo"] [data-shop-refused]')]
  expect(refused).toHaveLength(1)
  expect(refused[0]?.getAttribute('data-shop-blocker-kind')).toBe('name-taken')
  // The card with the npm mark carries the refusal; the other one reads as installed and is not refused.
  const cards = [...container.querySelectorAll('[data-shop-entry="dsh-foo"]')]
  const npmCard = cards.find(card => card.querySelector('[data-shop-source-npm]') !== null)
  const githubCard = cards.find(card => card !== npmCard)
  expect(npmCard?.querySelector('[data-shop-refused]')).toBeTruthy()
  expect(githubCard?.querySelector('[data-shop-installed]')).toBeTruthy()
  expect(githubCard?.querySelector('[data-shop-refused]')).toBeNull()
})
```

`bench` derives the specs from the installed rows, so the profile holds
`github:bob/dsh-foo`.

- [ ] **Step 5: run the four files**

Run, from `packages/dsh-plugin-shop`:
`node node_modules/vitest/vitest.mjs run tests/host/index.test.ts tests/host/install.test.ts tests/client/present.test.ts tests/client/ShopTab.client.spec.tsx`

Expected: PASS, with 11 new tests: 3 + 6 + 1 + 1.
If a new case fails, STOP: no registry task may start, and the failure goes
to LivXue (spec §8 step 0).

- [ ] **Step 6: prove the pins bite, then revert**

1. In `src/shared/identity.ts`, make `installedSpecMatches` return
   `entry.source === 'github'` for an `unknown` verdict. Run `index.test.ts`.
   Expected: FAIL in `gives a spec it cannot attribute to the npm entry alone…`.
2. In `src/host/install.ts`, make the identity lookup
   `snapshot.entries.find(candidate => candidate.name === args.name)`. Run
   `install.test.ts`. Expected: FAIL in
   `resolves the npm identity to the npm entry`, because bob comes first.
3. Revert both with `git checkout -- packages/dsh-plugin-shop/src`.
   `git diff --stat -- packages/dsh-plugin-shop/src` must print nothing.

- [ ] **Step 7: typecheck and commit**

Run `pnpm -C packages/dsh-plugin-shop typecheck`. Expected: clean.

```bash
git add packages/dsh-plugin-shop/tests
git commit -m "test(shop): pin an npm entry and a github entry of one name" -m "The catalog lists such a pair from the first build in which an npm package hides only its own owner's repositories (#88), and every installed shop reads that catalog the day it ships. These pass on today's code; they exist so the next change to installed(), validateInstall, heldBy or the card meets a pair (design 2026-10-19-npm-shadow-by-owner §7, §8 step 0)." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `npmShadowOf` (spec §2–§4)

**Files:**
- Create: `registry/scripts/src/npm-shadow.ts`
- Test: `registry/scripts/tests/npm-shadow.test.ts`

**Interfaces:**
- Produces:
  - `export function acceptedNpmRepositories(accepted: readonly Accepted[]): ReadonlyMap<string, string>`.
    It maps each ACCEPTED npm package's name to `Accepted.repository`, the
    repository its manifest declares.
  - `export function npmShadowOf(candidate: RepoCandidate, acceptedNpm: ReadonlyMap<string, string>): Rejection | null`.

- [ ] **Step 1: write the failing tests**

Use a fixture helper `repo(overrides)`, which returns a gate-passing
`RepoCandidate`. Copy it from `classify-select.test.ts`, with
`repo: 'alice/dsh-x'`, `name: 'dsh-x'` and
`repository: 'https://github.com/alice/dsh-x'`. Unless its row says
otherwise, every case passes `new Map([['dsh-x', <the npm repository>]])`.

| case | npm `repository` | candidate | expected |
|---|---|---|---|
| `returns null for a name no accepted npm package holds` | map has only `dsh-other` | default | `null` |
| `hides the npm package's own repository, whatever its case` | `https://github.com/Alice/DSH-X` | default | `{ name: 'alice/dsh-x', code: 'shadowed-by-npm', detail: OWN('dsh-x') }` |
| `names a hidden monorepo subpackage by its repo#subdir unit` | `https://github.com/alice/mono` | `repo: 'alice/mono'`, `subdir: 'packages/x'` | name `alice/mono#packages/x`, detail OWN |
| `hides a different owner/name of the same owner, naming the one the npm package declares` | `https://github.com/Alice/dsh-x-npm` | default | detail SAME_OWNER('dsh-x', 'Alice/dsh-x-npm') |
| `hides the npm package's own repository when the candidate's repo is the one in mixed case` | `https://github.com/starsharryzhu/dsh-x` | `repo: 'StarsHarryZhu/Dsh-X'`, `repository: 'https://github.com/StarsHarryZhu/Dsh-X'` | name `StarsHarryZhu/Dsh-X`, detail OWN |
| `hides a repository of the same owner when the candidate's owner is the one in mixed case` | `https://github.com/starsharryzhu/dsh-x-npm` | the same | name `StarsHarryZhu/Dsh-X`, detail SAME_OWNER('dsh-x', 'starsharryzhu/dsh-x-npm') |
| `hides a repository it cannot compare, for each unreadable spelling` (`it.each`) | each of `https://gitee.com/alice/dsh-x`, `ssh://git@github.com/alice/dsh-x`, `github:alice/dsh-x`, `https://github.com/alice/dsh-x/tree/main/packages/x`, `https://www.github.com/alice/dsh-x` | default | detail UNPARSED('dsh-x') |
| `leaves another owner's repository to the gate` | map `[['dsh-intelligent-ui', 'https://github.com/yunyv/dsh-intelligent-ui']]` | `name: 'dsh-intelligent-ui'`, `repo: 'gulagala001/dsh-intelligent-ui'` | `null` |
| `does not read an owner that is a prefix of the candidate's owner as the same owner` | `https://github.com/ali/dsh-x` | default | `null` |
| `compares the candidate's repo, not its repository field` | `https://github.com/alice/dsh-x` | `repo: 'bob/dsh-x'`, `repository: 'https://github.com/alice/dsh-x'` | `null` |

Assert each detail with `toBe` against the exact strings of Step 3, written
out in the test file. Do not import them from the module: the published copy
is what is under test.

The two mixed-case rows are the ones that fail if the candidate side's fold
is dropped: every other candidate in the file is lower case.

One case for `acceptedNpmRepositories`,
`maps each package the gate accepted to the repository it declares, as declared`:
gate two npm fixtures, declaring `https://github.com/Alice/dsh-a` and
`github:bob/dsh-b`, and expect the map to hold both strings unchanged. The
`npm(overrides)` fixture is copied from `classify-select.test.ts`.

- [ ] **Step 2: run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/npm-shadow.test.ts`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: implement `npm-shadow.ts`**

The rule, in order:

1. Let `repository = acceptedNpm.get(candidate.name)`. If it is `undefined`,
   no accepted npm package holds the name: return `null`.
2. Let `declared = githubOwnerName(repository)`. If it is `null`, the row is
   UNPARSED.
3. Let `repo = candidate.repo.toLowerCase()`. If
   `repo === \`${declared.owner}/${declared.name}\`.toLowerCase()`, the row is
   OWN.
4. If `repo.startsWith(\`${declared.owner.toLowerCase()}/\`)`, the row is
   SAME_OWNER, naming `${declared.owner}/${declared.name}` as declared. The
   trailing slash is what refuses an owner prefix.
5. Otherwise return `null`.

The row is `{ name: repoUnit(candidate), code: 'shadowed-by-npm', detail }`.
`repoUnit` keeps a monorepo's rows distinguishable (C-6; that comment moves
here from `pipeline.ts`). Here `npm` is `candidate.name`, which is the npm
package's name.

`acceptedNpmRepositories` is
`new Map(accepted.map(item => [item.candidate.name, item.repository]))`. Its
comment says why it takes the gate's `Accepted` results: a rejected package
cannot be passed in (B-6), and every value is a string, because the gate
refuses a package that declares no repository (`no-repository`).

The exact copy, with `${npm}` the npm package name:

- OWN: `The npm package ${npm} names this repository as its source and is already listed; the repository is not listed separately.`
- SAME_OWNER: `The npm package ${npm} is already listed and names ${owner}/${name} as its source: a repository of the same owner, either this one under an earlier name or another. This repository is not listed separately. If it is a different plugin, giving it a package name of its own lets the catalog judge it on its own.`
  - The comparison is of strings, and GitHub follows a rename, so a
    different `owner/name` of the same owner may be the candidate itself
    under an earlier name (spec §2 counts them). The sentence says either,
    and never "another repository".
- UNPARSED: `The npm package ${npm} is already listed, and the repository it names is not a plain https://github.com/owner/name URL, so this repository cannot be told apart from it and is not listed separately. If it is a different plugin, giving it a package name of its own lets the catalog judge it on its own.`

The module comment says four things:
- the rule, with spec §2's two cases;
- that it never hides more than the rule it replaces;
- why the owner is the line;
- why the candidate's owner comes from `repo`.

Cite the design by name, as `pipeline.ts` cites its designs.

- [ ] **Step 4: run the tests and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/npm-shadow.test.ts && pnpm typecheck`
Expected: PASS and clean.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/npm-shadow.ts registry/scripts/tests/npm-shadow.test.ts
git commit -m "feat(registry): npmShadowOf - an npm package hides only its owner's repositories" -m "One pure rule for both readers (design 2026-10-19-npm-shadow-by-owner §2-§4): an accepted npm package hides a same-named repository when its declared repository belongs to that repository's owner, or cannot be read as a GitHub URL. Each case has its own detail, so the row no longer tells an unrelated author that their repository is the npm package's source (#88). acceptedNpmRepositories builds the map the rule reads from the gate's accepted results, so both readers build it one way." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Both readers call `npmShadowOf` (spec §4, §7)

**Files:**
- Modify: `registry/scripts/src/pipeline.ts:205-235`, in `selectEntries`.
- Modify: `registry/scripts/src/classify-select.ts:54-73`, in `selectPending`.
- Test: `registry/scripts/tests/pipeline.test.ts`
- Test: `registry/scripts/tests/classify-select.test.ts`
- Modify: `registry/scripts/tests/repo-gate.test.ts:273` (comment only).

**Interfaces:**
- Consumes: Task 2's `npmShadowOf` and `acceptedNpmRepositories`.
- Produces: no new export. `selectEntries` and `selectPending` keep their
  signatures.

- [ ] **Step 1: change the tests**

`pipeline.test.ts`:

1. **Re-point line 361.** Its title becomes
   `shadows the repository the npm package names as its source, with a reason`.
   - Candidate: `{ ...repoCandidate, name: 'dsh-hello-plugin', repo: 'you/hello-plugin', repository: 'https://github.com/you/hello-plugin' }`.
   - Assert that the report contains this row, and that `plugins.json` holds
     no github entry:
     `| you/hello-plugin | shadowed-by-npm | The npm package dsh-hello-plugin names this repository as its source and is already listed; the repository is not listed separately. |`
2. **New case** `lists another owner's repository beside the npm package of its name`. This is the old pair.
   - Input: `runPipeline(candidates, [{ ...repoCandidate, name: 'dsh-hello-plugin' }], config, BUILT_AT)`.
   - The report holds no `shadowed-by-npm`.
   - The `dsh-hello-plugin` entries, read as `[source, repo ?? null]`, equal
     `[['github', 'someone/dsh-repo-plugin'], ['npm', null]]`.
3. **New case** `escapes a | the npm package declares in its repository name` (Review Focus 3).
   - npm: the fixture's `dsh-hello-plugin` with
     `repository: 'https://github.com/you/hello|plugin'`, alone.
   - Repository: `{ ...repoCandidate, name: 'dsh-hello-plugin', repo: 'you/hello-plugin-next', repository: 'https://github.com/you/hello-plugin-next' }`.
   - The report contains
     `| you/hello-plugin-next | shadowed-by-npm | The npm package dsh-hello-plugin is already listed and names you/hello\|plugin as its source: a repository of the same owner, either this one under an earlier name or another.`
4. **Re-point line 748** to `you/hello-plugin`'s own subpackages:
   `repoAt('dsh-hello-plugin', 'you/hello-plugin', commitA, 'packages/y')` and
   `packages/x`. Its rows are `| you/hello-plugin#packages/x |` then `#packages/y`.
5. **New case** `lists each subpackage of another owner's repository beside the npm package` (Review Focus 4).
   - Input: line 748's old `dave/monorepo` pair.
   - The `dsh-hello-plugin` entries, read as `[source, repo ?? null, subdir ?? null]`, equal
     `[['github','dave/monorepo','packages/x'], ['github','dave/monorepo','packages/y'], ['npm',null,null]]`.
   - No `shadowed-by-npm` row.
6. **Determinism.** Add `repoAt('dsh-hello-plugin', 'erin/hello-fork', commitB)`
   to `repos`, and `- name: erin/hello-fork\n  added: 2026-08-04\n` to
   `dated.firstSeen`.
   - Every accepted entry needs a row, or the across-clocks case fails.
   - Update both fixture comments: there are now five repository entries, one
     of them another owner's repository named like an npm package.
   - In `is byte-identical in every artifact…`, assert that
     `first.pluginsJson` contains `erin/hello-fork`. Without it, the case
     passes whether or not the pair is listed.
7. **Rename only.** The B-6 comment at :636-637 names `npmNames`; it becomes
   `acceptedNpm`.

`classify-select.test.ts`:

1. **Re-point :85** to the npm package's own repository:
   `repo({ name: 'dsh-same-name', repo: 'you/npm-plugin', repository: 'https://github.com/you/npm-plugin' })`.
   - The title becomes
     `skips the repository an accepted npm package names as its source`.
   - The assertions are unchanged.
2. **Re-point :103** to the same repository, so that only the rejection
   explains the result. The title and assertions are unchanged.
3. **New case** `classifies another owner's repository beside an accepted npm namesake` (Review Focus 5).
   - Inputs: line 85's declared `dsh-same-name`, and
     `repo({ name: 'dsh-same-name' })`, which is `someone/…` and derived.
   - `pending` equals
     `[{ name: 'dsh-same-name', description: 'A repo plugin.', keywords: [] }]`.
   - `liveNames` has `dsh-same-name`.
4. **New describe** `selectPending agrees with selectEntries`. Its case
   `makes liveNames exactly the names of the derived entries the build lists`
   uses these fixtures:
   - Each verdict alone decides one name. Four names each have a DECLARED
     npm package, which never makes its name live, and exactly one
     repository, so the name is live exactly when that repository is not
     hidden:
     - `dsh-own`: npm `you/dsh-own`, repository `you/dsh-own` (own: hidden);
     - `dsh-same-owner`: npm `you/dsh-same-owner`, repository
       `you/dsh-same-owner-next` (same owner: hidden);
     - `dsh-gitee`: npm `https://gitee.com/you/dsh-gitee`, repository
       `someone/dsh-gitee` (unparsed: hidden);
     - `dsh-other-owner`: npm `you/dsh-other-owner`, repository
       `someone/dsh-other-owner` (another owner: listed, derived).
   - One derived pair for a name listed twice and live once:
     `npm({ name: 'dsh-twice', repository: 'https://github.com/you/dsh-twice' })`
     and the repository `someone/dsh-twice`.
   - Every repository has the matching `name` and `repository`.
   - Assert the premises first: every npm package is accepted, the four as
     declared, and every repository passes `gateRepo` alone as derived.
   - Assert that `liveNames`, sorted, equals the sorted, de-duplicated names
     of `selectEntries(...).entries` whose `metadata === 'derived'`, and that
     both equal `['dsh-other-owner', 'dsh-twice']`.
   - Each of four drifted `selectPending`s must fail it: hiding only the own
     repository, not hiding the unparsed case, not hiding the same-owner
     case, and the old rule that hides every repository of an accepted npm
     name.
   - Import `selectEntries` from `../src/pipeline.ts`, and pass
     `'2026-08-18T00:00:00.000Z'` as `builtAt`.

`repo-gate.test.ts:273`: the comment's `npmNames` becomes `acceptedNpm`.

- [ ] **Step 2: run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/pipeline.test.ts registry/scripts/tests/classify-select.test.ts`

Expected: FAIL in these seven cases, and no others:
- in `pipeline.test.ts`:
  - the re-pointed line-361 case, which still gets the old detail;
  - the two new another-owner listing cases;
  - the escape case;
  - `is byte-identical…`, whose new assertion finds erin shadowed;
- in `classify-select.test.ts`:
  - `classifies another owner's repository beside an accepted npm namesake`;
  - the agreement case, whose expected names include `dsh-other-owner`.

The re-pointed line-748, :85 and :103 cases pass before and after. They test
a same-owner pair, which both rules treat alike.

- [ ] **Step 3: wire both readers**

- **`selectEntries`.**
  - Replace `npmNames` with
    `const acceptedNpm = acceptedNpmRepositories(accepted)`, after the npm
    loop, from the `Accepted[]` that loop already collects.
  - In the repository loop, `const shadow = npmShadowOf(repoCandidate, acceptedNpm)`.
    When it is not `null`, push it and `continue`.
  - Rewrite the "npm first" comment to state the narrowed rule and B-6, and
    cite the design. It says that `selectPending` builds the same map and
    asks the same function, and that the classifier's repositories are a
    build behind, so it sees a transfer a run late (spec §4).
- **`selectPending`.** Its `npmAccepted` becomes `acceptedNpm`, built the
  same way: the npm loop collects the gate's accepted results, before its
  derived check, and `acceptedNpmRepositories` runs after it. Skip a
  repository when `npmShadowOf(candidate, acceptedNpm) !== null`.
  - Its two comments say that a hidden repository's name keeps the npm
    package's row.
  - They also say that both readers build the map and ask the rule the same
    way, and that these repositories come from the committed snapshot, a
    build behind (spec §4).
- `unmatchedRegistryNotes`' own `npmNames` (`pipeline.ts:139`) is a different
  set. Leave it.

- [ ] **Step 4: run the registry suite and the typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: every file passes, the count rises by the cases Tasks 2 and 3 add,
and the typecheck is clean.

- [ ] **Step 5: commit**

```bash
git add registry/scripts/src/pipeline.ts registry/scripts/src/classify-select.ts registry/scripts/tests
git commit -m "fix(registry): another owner's repository is no longer shadowed by an npm namesake (#88)" -m "selectEntries and selectPending both build the accepted-npm map with acceptedNpmRepositories and ask npmShadowOf, so the build and the classifier give a candidate the same verdict (design 2026-10-19-npm-shadow-by-owner §4). The classifier's candidates are a build behind, so it sees a transfer a run late, as it sees a new repository. Four existing cases were built on cross-owner pairs, which the rule now lists; each moves to a same-owner pair so it keeps testing what its title says, and the old pairs become the new another-owner cases (§7). The determinism fixture gains one such pair." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The documents and comments that state the rule (spec §6)

**Files:**
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md:501`
- Modify: `docs/design/2026-08-30-github-install-channel.md`, at :6, :63-65,
  :94-96 and :281-282.
- Modify: `docs/superpowers/specs/2026-08-26-llm-categorization-design.md`, at
  :140-143.
- Modify: `docs/design/2026-08-31-hub-borrowings.md:60-62`.
- Modify: `docs/design/2026-10-04-change-feed-harvest.md:614-617`.
- Modify: `docs/design/2026-10-08-archived-flag-and-shadowed-recovery.md:149`.
- Modify: `registry/scripts/src/gate.ts:297-303` and `:421-427`
  (comments only).

**Interfaces:** none.

- [ ] **Step 1: the main design.** Change
  "(`shadowed-by-npm`, with a reason)" in "npm wins when a repo's bundle
  name already ships as an npm package" into one parenthesis. It follows the
  `**amended …**:` pattern the paragraph already uses:
  `(\`shadowed-by-npm\`, with a reason; **narrowed 2026-10-19**: only when the npm package's \`repository\` names a repository of the candidate's owner, or cannot be read as a \`https://github.com/<owner>/<name>\` URL; another owner's repository is gated on its own and listed beside it if it passes — design 2026-10-19-npm-shadow-by-owner.md)`.
- [ ] **Step 2: the channel design.** Insert the same note, worded to fit
  each sentence, after:
  - "npm wins the bundle-name dedup" in the status header;
  - "when no npm entry exists" in the **Non-goals** bullet;
  - "with npm entries winning" in the **Union** bullet;
  - decision 3's parenthesis.

  Each says that npm wins only over a repository of the owner its own
  `repository` names, or when that field is not a plain GitHub URL, and cites
  the design.
- [ ] **Step 3: `gate.ts:297-303`.** In the denial comment,
  "(npm wins by design)" becomes "(an npm package wins over its own
  repository by design)". Reflow the paragraph.
- [ ] **Step 4: `gate.ts:421-427`.** Replace the A-2 paragraph's middle
  sentence:

  ```ts
  // identity. Without the hold at distance 0, any npm publisher could take
  // that bundle name: a package naming the verified repository, or another
  // of its owner's, as its source would shadow it (`shadowed-by-npm`) and
  // take its place on the shelf, as would one whose `repository` is not a
  // plain GitHub URL, and one naming another owner's repository would be
  // listed beside it under the reviewed name
  // (design 2026-10-19-npm-shadow-by-owner).
  ```

  Keep the first line and the `allowed-similar.yml` sentence. The hold itself
  is unchanged.
- [ ] **Step 5: the classifier spec and three more designs.**
  - The classifier spec's "npm shadows GitHub" bullet becomes "An npm package
    shadows its own owner's repositories": a repo candidate of an ACCEPTED
    npm name is skipped only when `npmShadowOf` hides it, and another
    owner's repository goes on to the gate and is classified when listed. It
    adds that the classifier applies the rule to the committed snapshot, so a
    transfer or an account rename reaches it one run late, as a newly
    discovered repository does (spec §4).
  - `2026-08-31-hub-borrowings.md:60-62`, the "npm-published subpackages"
    bullet, gains the same note for a subpackage of another owner's
    repository.
  - `2026-10-04-change-feed-harvest.md:614-617`, the **Channel moves** risk:
    the GitHub entry is shadowed only when the npm package's `repository`
    names its owner or is not a plain GitHub URL, so after a transfer or an
    account rename the dry run's diff shows a listed pair as well.
  - `2026-10-08-archived-flag-and-shadowed-recovery.md:149` cites
    `pipeline.ts:227-231` for the refusal, which this change moves. It names
    `npmShadowOf` and `selectEntries` instead.
- [ ] **Step 6: check that nothing else states the old rule.**

  Run:
  `git grep -n -E "npm wins|npm entry wins|npm-wins|shadow(s|ed)? the|npmNames|npmAccepted|npm shadows|shadowed by an|namesake" -- registry/scripts docs/design docs/superpowers/specs`

  This leaves out the registry's data files, whose descriptions say
  "shadows the". Expected: every remaining hit is one of three kinds:
  - it states the narrowed rule;
  - it is history that was true when written: `gate.test.ts:786`'s account
    of A-2, or the designs §6 lists as still true;
  - it is unrelated: `workflow.test.ts`'s env shadowing, or
    `pipeline.ts:139`'s `npmNames`.
- [ ] **Step 7: typecheck and commit.**

  Run: `pnpm typecheck`. Expected: clean.

```bash
git add docs/design docs/superpowers/specs/2026-08-26-llm-categorization-design.md registry/scripts/src/gate.ts
git commit -m "docs: npm wins over its own owner's repositories, not every same-named one" -m "The main design's 2026-08-30 amendment, the github channel design's four statements of the dedup rule, the classifier spec's npm-shadows-GitHub bullet, the hub-borrowings subpackage bullet, the change-feed design's channel-moves risk, and two gate.ts comments said npm wins every bundle name it shares; design 2026-10-19-npm-shadow-by-owner narrows that (§6). The classifier spec also says the classifier applies the rule to the committed snapshot, a build behind (§4), and the archived-flag design names the refusal by function rather than by a line this change moves." -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Offline replay and the whole-branch check (spec §8 step 1)

**Files:** none in the repository. The replay lives in
`.claude/worktrees/.scratch-npm-shadow/`, which is git-ignored:
- `scripts/replay.mts`;
- its inputs, `inputs/plugins.c2fc6c02….json` (sha256 `c2fc6c02…`, the
  06:25Z build) and `inputs/report.md`;
- `out/baseline.json`.

**Interfaces:** consumes `npmShadowOf` through its `--predicate` flag.

- [ ] **Step 1: replay.** From the worktree, run:
  `node --no-warnings ../.scratch-npm-shadow/scripts/replay.mts "$PWD" ../.scratch-npm-shadow/inputs/plugins.c2fc6c02e4e752d4b5cbb9c24b54e53f0b5e28249621e300c9ece4bf73cb28e5.json ../.scratch-npm-shadow/out/after.json --predicate`

  Expected: both lines, peers attached and peers withheld, read
  `{"total":5957,"own-repo":4581,"same-owner":47,"unparsed":23,"other-owner":1306,"listed":796,"ownRejection":510,"listedNames":488,"listedRepos":791,"disagreements":0}`.
  - The baseline run without `--predicate` gave exactly these numbers on
    2026-10-19.
  - `disagreements` counts candidates on which `npmShadowOf` differs from
    the measured class. It also counts a hidden candidate whose detail is
    not its class's variant.
  - If `disagreements` is not 0, the script prints up to five of them; fix
    the cause before going on.
- [ ] **Step 2: whole branch.**
  - Run `pnpm test && pnpm typecheck` from the root.
  - Run `pnpm -C packages/dsh-plugin-shop typecheck`.
  - Run the four Task 1 shop files again.
  - Run `git diff --stat origin/main...HEAD -- packages/dsh-plugin-shop/src`,
    which must print nothing.

  Expected: all green. The shop's e2e legs are not rerun locally, because its
  source is untouched; CI runs them.

---

### Task 6: The pull request (spec §8 step 2)

Merging waits for LivXue: rebase-merge, after the dry run and every review
comment are read.

- [ ] **Step 1: wait out a main catalog run.** A PR's dry run shares the
  GitHub token with it. Run:
  `gh run list --branch main --workflow daily.yml --status in_progress --json databaseId,displayTitle`

  Expected: `[]`. Otherwise, wait for that run to finish.
- [ ] **Step 2: push and open the PR.**
  - Run `git push -u origin fix/npm-shadow-by-owner`.
  - Title: `An npm package hides only its own owner's repositories (#88)`.
  - The body covers:
    - the rule;
    - the replay's figures;
    - the shop audit and the pins;
    - that the catalog dry run will likely stop on the npm tail cap, as on
      10-18 and 10-19, and that PR #101 merged under the same stop;
    - `Refs #88`. Not `Fixes`: the issue closes after the follow-up comment.
  - It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 3: watch CI and reviews.**
  - CI: the plugin workflow, plus a catalog dry run of about 110 minutes.
  - Poll reviews and inline comments with `gh` before calling the PR ready.
    LivXue's passes post silently.
  - If the dry run clears the cap, check its report against the replay.

### After merge, each step on its own go-ahead (spec §8 step 3)

- Watch the first main build. Its `plugins.json` should hold three
  `dsh-intelligent-ui` entries:
  - yunyv's npm package;
  - `gulagala001/dsh-intelligent-ui`, pinned to `v0.2.1-alpha.2.iui.1.0.0`;
  - `StarsHarryZhu/dsh-intelligent-UI`.

  Its report should have no other-owner `shadowed-by-npm` row.
- The #88 follow-up comment, posted on "发".
