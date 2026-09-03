# Audit fixes D — host and client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the twenty-one host- and client-side findings of the 2026-09-03 debug audit — the RPC and client addressing entries by a name 151 live names share, and every unbounded body read, missing deadline, unkilled process group and prototype-bearing map behind them.

**Architecture:** The central change is that an entry's identity is `(source, name, repo, subdir)` end to end: one `identityKey` in `src/shared/identity.ts`, used by `validateInstall`, `install()`, `installed()`, the incompatibility map, the pins file and every client lookup map, so a name can never select another repository's code. Around it, every read of a body and every spawn of a child gains a bound: byte caps and `TransportError` conversion on the catalog transport, an abortable commit budget on every bulk read, a deadline plus a process-group kill on the install spawn, and a boundary grammar on `name`/`version`/`repo`/`tarball.url` so nothing from the catalog reaches argv unvalidated.

**Tech Stack:** TypeScript 5.6 (ESM, `strict`, `noUncheckedIndexedAccess`), zod 4.4, vitest 2.1, React 18, `js-yaml` 4, `semver` 7, Node 22 (`node:child_process`, `node:zlib`, `node:string_decoder`).

**Spec:** [docs/plans/2026-09-03-debug-audit.md](2026-09-03-debug-audit.md) — findings G-1, F-1, F-2/G-10, G-2, G-3, G-6/F-3, G-4, G-5, G-7, G-8, G-9, G-11, F-4, F-5, F-6, F-7, F-8, F-9, F-10, F-11, F-12

## Global Constraints

- Everything reaching the host from the catalog is hostile — package names, versions, `repo`, `subdir`, `tarball.url`, `catalog` text, `peers` — and is validated at the `entrySchema` boundary, never downstream.
- **No `shell: true` for the dsh spawn, ever**: node hands cmd.exe a joined, UNQUOTED command line, and our argv carries catalog data (`github:owner/slug#<sha>&path:<subdir>` — `&` is a cmd separator). The shop resolves the CLI's JS entry and runs it through `process.execPath` instead (`dsh-cli.ts`).
- The compatibility check stays a `require.resolve(spec + '/package.json')` presence check anchored at the profile (`peers.ts` `nodeResolver`); version ranges are deliberately dropped (harness prereleases do not satisfy ordinary ranges, so range checking would mark working plugins incompatible — 2026-09-01-harness-compatibility §1).
- Transport failures — the fetch threw, a non-2xx answer, a body that died mid-stream, a body over the cap, a stalled read past the commit budget — degrade to the cached snapshot with `stale: true`. Everything that *interprets* bytes (pointer parse, schemaVersion, sha256, data parse, entry grammar, tarball coherence) throws even when a cache exists.
- sha256 is verified on the fetched bytes for both the data file and the stars sidecar, on the wire and in the cache; a tampered cache is treated as absent.
- `verifyTarballSha256`'s cap is `MAX_TARBALL_BYTES = 64 * 1024 * 1024` (64 MiB) and stays exactly that. The new caps match it in spirit and are stated per module: `MAX_BODY_BYTES = 64 * 1024 * 1024` for catalog HTTP bodies, `MAX_PACKAGE_BYTES = 32 * 1024 * 1024` for an npm tarball on the wire, `MAX_INFLATED_BYTES = 64 * 1024 * 1024` for its `gunzipSync` output.
- ESM everywhere; local relative imports carry the `.ts` extension.
- `strict` and `noUncheckedIndexedAccess` are on: guard index access, never assert it away.
- Every file ends with exactly one trailing newline.
- **G-1 changes an RPC shape** (`InstallArgs` and `ShopInstalledEntry`), so this release goes to `beta` first at `0.8.0-beta.0` and is installed by hand into a throwaway `DSH_HOME` before promotion. README install pins track `latest`, so all four move only in the promotion commit, never in the beta.
- Baseline at HEAD plus the working tree's Incompatible-badge change: `pnpm -C packages/dsh-plugin-shop test` = **25 files / 492 tests green**; both typechecks clean. The working tree's badge change (`IncompatibleBadge` is a component; `InstallPanel`'s idle branch returns a fragment of button + badge) is preserved by every task here.
- `test` and `typecheck --noEmit` both skip `lib/`, so any task that packs must `rm -rf lib && pnpm build` first.

---

### Task 1: One install identity, shared by both halves

**Files:**
- Create: `packages/dsh-plugin-shop/src/shared/identity.ts`
- Modify: `packages/dsh-plugin-shop/src/client/present.ts:277-299` (`entryKey` delegates)
- Test: `packages/dsh-plugin-shop/tests/host/identity.test.ts` (new)

**Interfaces:**
- Consumes: `CatalogEntry` from `src/host/types.ts`.
- Produces: `EntryIdentity`, `identityKey(identity): string`, `parseRepoSpec(spec): string | null`, `installedSpecMatches(entry, spec): boolean`. Tasks 4-8 depend on all four.

- [ ] **Step 1: Write the failing test**

```ts
// packages/dsh-plugin-shop/tests/host/identity.test.ts
import { describe, expect, it } from 'vitest'
import { identityKey, installedSpecMatches, parseRepoSpec } from '../../src/shared/identity.ts'
import type { CatalogEntry } from '../../src/host/types.ts'

const npmEntry: CatalogEntry = {
  name: 'dsh-foo', version: '1.2.0', integrity: null, publishedAt: null,
  repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm',
  added: '2026-08-25',
}
const repoEntry: CatalogEntry = {
  ...npmEntry, version: 'a'.repeat(40), source: 'github', repo: 'alice/dsh-foo',
}

describe('identityKey', () => {
  it('is the registry uniqueness rule verbatim (emit.ts assertCatalogInvariants)', () => {
    expect(identityKey(npmEntry)).toBe('npm:dsh-foo')
    expect(identityKey(repoEntry)).toBe('github:alice/dsh-foo#')
    expect(identityKey({ ...repoEntry, subdir: 'packages/a' })).toBe('github:alice/dsh-foo#packages/a')
  })

  it('separates two repositories that publish the same package name', () => {
    // 151 live names cover 243 entries; `alice/dsh-foo` and `bob/dsh-foo` are
    // two legitimate entries under one name (present.ts:286).
    expect(identityKey(repoEntry)).not.toBe(identityKey({ ...repoEntry, repo: 'bob/dsh-foo' }))
  })

  it('falls back to the name for a github entry carrying no repo', () => {
    expect(identityKey({ ...repoEntry, repo: undefined })).toBe('github:dsh-foo#')
  })
})

describe('parseRepoSpec', () => {
  it('reads the repo out of every spec form pnpm writes for a repo install', () => {
    expect(parseRepoSpec('github:alice/dsh-foo')).toBe('alice/dsh-foo')
    expect(parseRepoSpec('github:Alice/DSH-Foo')).toBe('alice/dsh-foo')
    expect(parseRepoSpec(`github:alice/dsh-foo#${'a'.repeat(40)}`)).toBe('alice/dsh-foo')
    expect(parseRepoSpec(`github:alice/dsh-foo#${'a'.repeat(40)}&path:packages/a`)).toBe('alice/dsh-foo')
    expect(parseRepoSpec('https://github.com/alice/dsh-foo/releases/download/v1.0.0/p.tgz')).toBe('alice/dsh-foo')
    expect(parseRepoSpec('git+https://github.com/alice/dsh-foo.git')).toBe('alice/dsh-foo')
  })

  it('answers null for every npm range spec, which is not a repo at all', () => {
    expect(parseRepoSpec('^1.0.0')).toBeNull()
    expect(parseRepoSpec('1.5.0')).toBeNull()
    expect(parseRepoSpec('workspace:*')).toBeNull()
    expect(parseRepoSpec('latest')).toBeNull()
    expect(parseRepoSpec('')).toBeNull()
  })
})

describe('installedSpecMatches', () => {
  it('matches an npm entry only against a spec that is not a repo', () => {
    expect(installedSpecMatches(npmEntry, '^1.0.0')).toBe(true)
    expect(installedSpecMatches(npmEntry, 'workspace:*')).toBe(true)
    // bob's repo is installed; the npm namesake must NOT claim that row.
    expect(installedSpecMatches(npmEntry, 'github:bob/dsh-foo')).toBe(false)
  })

  it('matches a github entry only against a spec naming its own repo', () => {
    // The defect: `alice/dsh-foo` claimed bob's installed row, and the
    // Outdated row's Update button then spawned alice's commit over it.
    expect(installedSpecMatches(repoEntry, 'github:alice/dsh-foo')).toBe(true)
    expect(installedSpecMatches(repoEntry, 'github:bob/dsh-foo')).toBe(false)
    expect(installedSpecMatches(repoEntry, '^1.0.0')).toBe(false)
  })

  it('matches a release-rescued entry against the release URL pnpm recorded', () => {
    const rescued: CatalogEntry = {
      ...repoEntry, version: 'v1.0.0',
      tarball: { url: 'https://github.com/alice/dsh-foo/releases/download/v1.0.0/p.tgz', sha256: 'a'.repeat(64) },
    }
    expect(installedSpecMatches(rescued, 'https://github.com/alice/dsh-foo/releases/download/v1.0.0/p.tgz')).toBe(true)
    expect(installedSpecMatches(rescued, 'https://github.com/bob/dsh-foo/releases/download/v1.0.0/p.tgz')).toBe(false)
  })

  it('never matches a github entry carrying no repo, which has no identity to compare', () => {
    expect(installedSpecMatches({ ...repoEntry, repo: undefined }, 'github:alice/dsh-foo')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/identity.test.ts` (from `packages/dsh-plugin-shop`) — Expected: FAIL with `Error: Failed to load url ../../src/shared/identity.ts` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `packages/dsh-plugin-shop/src/shared/identity.ts`:

```ts
/**
 * One entry's install identity, defined once for both halves of the package.
 *
 * `name` is NOT an identity. The registry's uniqueness rule is `npm:<name>`
 * for an npm entry and `github:<repo>#<subdir>` for a repo one
 * (`registry/scripts/src/emit.ts:107-109` assertCatalogInvariants), so two
 * GitHub repositories publishing the same `package.json` name are two
 * legitimate entries under one name, as are two subpackages of one monorepo.
 * The live catalog holds 151 such names over 243 entries.
 *
 * Keying the RPC and the client's lookup maps by name made an "Update" on
 * one of them install the OTHER repository's commit. This module is the
 * single definition both halves read, so the host's answer and the client's
 * key can never drift apart.
 */

/** The fields that decide which catalog row a request is about. */
export interface EntryIdentity {
  source: 'npm' | 'github'
  name: string
  repo?: string
  subdir?: string
}

/** The registry's uniqueness rule verbatim. Mirrors `emit.ts`; the two must
 * not drift. A github entry with no `repo` falls back to its name, the same
 * fallback the registry invariant uses. */
export function identityKey(identity: EntryIdentity): string {
  return identity.source === 'npm'
    ? `npm:${identity.name}`
    : `github:${identity.repo ?? identity.name}#${identity.subdir ?? ''}`
}

/** `owner/slug`, lowercased, or null when this is not a repo reference. */
const REPO = '([\\w.-]+)\\/([\\w.-]+?)'
const GITHUB_SHORTHAND = new RegExp(`^github:${REPO}(?:[#&].*)?$`)
const GITHUB_URL = new RegExp(`^(?:git\\+)?https?:\\/\\/(?:www\\.)?github\\.com\\/${REPO}(?:\\.git)?(?:[\\/?#].*)?$`)

/**
 * The `owner/slug` a profile manifest's dependency spec refers to, lowercased,
 * or null when the spec is an npm range rather than a repository.
 *
 * pnpm records a repo install as `github:owner/slug` — no commit, which is
 * why the shop keeps its own pins — and a release-rescued install as the
 * release asset URL it was given. Both forms have to resolve to the same
 * identity as the catalog row that produced them.
 */
export function parseRepoSpec(spec: string): string | null {
  const shorthand = GITHUB_SHORTHAND.exec(spec)
  if (shorthand !== null && shorthand[1] !== undefined && shorthand[2] !== undefined) {
    return `${shorthand[1]}/${shorthand[2]}`.toLowerCase()
  }
  const url = GITHUB_URL.exec(spec)
  if (url !== null && url[1] !== undefined && url[2] !== undefined) {
    return `${url[1]}/${url[2]}`.toLowerCase()
  }
  return null
}

/**
 * Whether this catalog entry is the thing the profile manifest installed
 * under its name.
 *
 * The manifest holds one dependency per name, so the name alone cannot say
 * WHICH same-named entry is installed — the spec can. An npm entry owns the
 * row only when the spec is not a repository reference; a github entry owns
 * it only when the spec names that entry's own repo.
 */
export function installedSpecMatches(entry: EntryIdentity, spec: string): boolean {
  const repo = parseRepoSpec(spec)
  if (entry.source === 'npm') return repo === null
  if (entry.repo === undefined) return false
  return repo === entry.repo.toLowerCase()
}
```

Then in `packages/dsh-plugin-shop/src/client/present.ts`, replace the body of `entryKey` (lines 295-299) so there is one definition. Before:

```ts
export function entryKey(entry: CatalogEntry): string {
  return entry.source === 'npm'
    ? `npm:${entry.name}`
    : `github:${entry.repo ?? entry.name}#${entry.subdir ?? ''}`
}
```

After:

```ts
export function entryKey(entry: CatalogEntry): string {
  return identityKey(entry)
}
```

and add the import beside the existing shared re-export at the top of `present.ts` (line 5):

```ts
export { isShopLike } from '../shared/shop-like.ts'
export { identityKey, installedSpecMatches, parseRepoSpec, type EntryIdentity } from '../shared/identity.ts'
import { identityKey } from '../shared/identity.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/identity.test.ts tests/client/present.test.ts` — Expected: PASS (the five existing `entryKey` cases in `present.test.ts` still pass unchanged, which is the point of delegating rather than rewriting).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/shared/identity.ts packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/tests/host/identity.test.ts
git commit -m "feat(host): define one install identity for both halves (G-1)"
```

---

### Task 2: The catalog boundary refuses a name, version, repo or tarball URL it cannot safely spawn

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts:64-118` (`entrySchema`), `:133-160` (`validateEntryCoherence`)
- Test: `packages/dsh-plugin-shop/tests/host/catalog.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. `CatalogEntry.repo` is guaranteed present for `source: 'github'` after this task, which Tasks 5 and 6 rely on.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/catalog.test.ts` (after the `v5 entries` describe block, which ends at line ~628):

```ts
describe('entry grammar at the boundary (G-6 / F-3)', () => {
  const base = {
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
    added: '2026-08-25',
  }

  /** Serve one hand-built data file and its pointer, and return the load. */
  function loadWith(plugins: unknown[], schemaVersion = 5): Promise<unknown> {
    const data = JSON.stringify({ schemaVersion, plugins, denied: [] })
    const { pointer } = pointerFor(data, '2026-09-03T00:00:00Z', undefined, schemaVersion)
    const fetchImpl = (async (input: string | URL) => new Response(
      String(input).endsWith('/index.json') ? pointer : data, { status: 200 },
    )) as unknown as typeof fetch
    return loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
  }

  it('refuses an npm name outside npm\'s own package-name grammar', async () => {
    // pnpm reads `name@spec` as an ALIAS, so `dsh-x@npm:other` installs a
    // package other than the one the card showed.
    await expect(loadWith([{ ...base, name: 'dsh-x@npm:some-other-package', source: 'npm' }]))
      .rejects.toThrow(/npm package-name grammar/)
    await expect(loadWith([{ ...base, name: 'dsh x', source: 'npm' }]))
      .rejects.toThrow(/npm package-name grammar/)
  })

  it('refuses an npm version that is not a plain semver version', async () => {
    // Observed argv at a fake dsh: `[add] [dsh-x@1.0.0 & calc.exe]`. dsh runs
    // `spawnSync('pnpm', args, { shell: process.platform === 'win32' })`, so
    // on Windows that reaches an unquoted cmd.exe line.
    await expect(loadWith([{ ...base, version: '1.0.0 & calc.exe', source: 'npm' }]))
      .rejects.toThrow(/plain semver version/)
    await expect(loadWith([{ ...base, version: 'v1.2.0', source: 'npm' }]))
      .rejects.toThrow(/plain semver version/)
  })

  it('keeps every shape the live catalog actually publishes', async () => {
    // The guard must not repeat 0.5.0: a boundary rule the live catalog does
    // not satisfy refuses the whole shelf for every user. Measured against
    // today's catalog: 5,908 GitHub entries, 162 of them release-rescued
    // with a tag for a version.
    const result = await loadWith([
      { ...base, name: '@scope/dsh-plugin', version: '0.1.4-alpha.2', source: 'npm' },
      { ...base, name: 'dsh.dot_under-name', version: '1.0.0+build.7', source: 'npm' },
      { ...base, name: 'sub-plugin', version: 'd'.repeat(40), source: 'github', repo: 'someone/monorepo', subdir: 'packages/sub-plugin' },
      { ...base, name: '{{PKG_NAME}}', version: 'e'.repeat(40), source: 'github', repo: 'someone/template' },
      {
        ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
        tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz', sha256: 'a'.repeat(64) },
      },
    ]) as { snapshot: { entries: unknown[] } }
    expect(result.snapshot.entries).toHaveLength(5)
  })

  it('refuses a repo that is not owner/slug', async () => {
    await expect(loadWith([{ ...base, version: 'd'.repeat(40), source: 'github', repo: 'a/b?x' }]))
      .rejects.toThrow(/owner\/slug/)
    await expect(loadWith([{ ...base, version: 'd'.repeat(40), source: 'github', repo: 'a/b/c' }]))
      .rejects.toThrow(/owner\/slug/)
  })

  it('refuses a github entry with no repo, which has no installable identity', async () => {
    await expect(loadWith([{ ...base, version: 'd'.repeat(40), source: 'github' }]))
      .rejects.toThrow(/must carry its repo/)
  })

  it('refuses a github version that is neither a commit nor a release tag', async () => {
    await expect(loadWith([{ ...base, version: `${'d'.repeat(40)} & calc.exe`, source: 'github', repo: 'owner/slug' }]))
      .rejects.toThrow(/neither a 40-character commit sha nor a release tag/)
    await expect(loadWith([{ ...base, version: 'refs/heads/main;calc', source: 'github', repo: 'owner/slug' }]))
      .rejects.toThrow(/neither a 40-character commit sha nor a release tag/)
  })

  it('keeps a release tag, with or without a tarball beside it', async () => {
    // 162 live GitHub entries carry a tag rather than a commit. A flat 40-hex
    // rule would have refused the shelf for every user; coupling the tag form
    // to `tarball` would do the same the day one loses its tarball.
    const result = await loadWith([
      {
        ...base, name: 'dsh-plugin-tui', version: 'v0.2.1', source: 'github', repo: 'ablemind/dsh-plugin-tui',
        tarball: { url: 'https://github.com/ablemind/dsh-plugin-tui/releases/download/v0.2.1/p.tgz', sha256: 'b'.repeat(64) },
      },
      { ...base, name: 'dsh-tagged', version: 'release/1.0', source: 'github', repo: 'owner/tagged' },
    ]) as { snapshot: { entries: unknown[] } }
    expect(result.snapshot.entries).toHaveLength(2)
  })

  it('refuses a tarball url carrying a query or a fragment', async () => {
    // `validateEntryCoherence` checked host and path only, so `?a=1&calc`
    // rode through into the install spec.
    await expect(loadWith([{
      ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/p.tgz?a=1&calc', sha256: 'a'.repeat(64) },
    }])).rejects.toThrow(/no query or fragment/)
    await expect(loadWith([{
      ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/p.tgz#x', sha256: 'a'.repeat(64) },
    }])).rejects.toThrow(/no query or fragment/)
  })

  it('refuses a tarball sha256 that is not 64 hex characters', async () => {
    await expect(loadWith([{
      ...base, name: 'dsh-rescued', version: 'v1.0.0', source: 'github', repo: 'owner/slug',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.0.0/p.tgz', sha256: 'not-a-hash' },
    }])).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/catalog.test.ts -t "entry grammar at the boundary"` — Expected: FAIL — the first six cases resolve instead of rejecting (`promise resolved "{ snapshot: …, stale: false }" instead of rejecting`), because `name`, `version` and `repo` are bare `z.string()`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/catalog.ts`, add the grammars above `entrySchema` (before line 64):

```ts
/** npm's own package-name grammar: an optional `@scope/`, then a name, both
 * lowercase and limited to npm's character set, 214 characters overall. The
 * value becomes half of an install spec (`name@version`), and pnpm reads
 * `name@npm:other` as an ALIAS — so a name outside this grammar could install
 * a package other than the one the card showed. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** SemVer 2.0.0, anchored. `semver.valid` is deliberately NOT used here: it
 * is lenient where this must not be — it accepts `v1.0.0` and ` 1.0.0 `, and
 * `valid('1.0.0+build.1')` answers `'1.0.0'`, so a `valid(v) === v` check
 * would refuse a legal npm version. This value becomes argv. */
const NPM_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/

/** A GitHub commit: the pin a repo entry installs at. */
const COMMIT_SHA = /^[0-9a-f]{40}$/

/** A GitHub release tag — the `version` of a release-rescued entry, which is
 * display and pin only (the spec is the tarball URL). 162 of the 5,908 live
 * GitHub entries carry one. Permissive about `/`, which real tags carry
 * (`release/1.0`), and closed against everything a shell would read. */
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/

/** `owner/slug`, the repo binding the install spec is built from. */
const REPO_FULL_NAME = /^[\w.-]+\/[\w.-]+$/
```

Replace the `name`, `version` and `repo` fields of `entrySchema` (lines 65-66 and 93) and the `tarball` field (line 105), and append the source-dependent check to the object. Before:

```ts
const entrySchema = z.object({
  name: z.string(),
  version: z.string(),
```
…
```ts
  repo: z.string().optional(),
```
…
```ts
  tarball: z.object({ url: z.string(), sha256: z.string() }).optional(),
```
…
```ts
  peers: z.array(z.string()).optional(),
})
```

After:

```ts
const entrySchema = z.object({
  // Bounded and control-character-free for EVERY source: a github entry's
  // name comes from an unvalidated repository manifest (the live catalog
  // holds `{{PKG_NAME}}` and `Skills Manager`), and it still reaches the
  // post-install manifest confirmation and the published rejection details.
  // The npm grammar is enforced below, for npm entries only, because that is
  // the only source whose name reaches an install spec.
  name: z.string().min(1).max(214).regex(/^[^\u0000-\u001f\u007f]+$/, 'entry name carries a control character'),
  version: z.string().min(1).max(256),
```
…
```ts
  repo: z.string().regex(REPO_FULL_NAME, 'repo must be owner/slug').optional(),
```
…
```ts
  tarball: z.object({ url: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).optional(),
```
…
```ts
  peers: z.array(z.string()).optional(),
}).superRefine((entry, ctx) => {
  // The spec the Host builds differs per source, so the grammar does too.
  // Refusing here refuses the whole catalog, which is the intended posture
  // for data we publish (§9.2 fail loudly): a row the Host cannot safely
  // spawn must not be silently dropped either.
  if (entry.source === 'npm') {
    if (!NPM_NAME.test(entry.name)) {
      ctx.addIssue({ code: 'custom', path: ['name'], message: `npm entry name ${JSON.stringify(entry.name)} is outside npm's package-name grammar` })
    }
    if (!NPM_VERSION.test(entry.version)) {
      ctx.addIssue({ code: 'custom', path: ['version'], message: `npm entry version ${JSON.stringify(entry.version)} is not a plain semver version` })
    }
    return
  }
  if (entry.repo === undefined) {
    ctx.addIssue({ code: 'custom', path: ['repo'], message: 'a github entry must carry its repo — it is the entry\'s identity and the spec is built from it' })
  }
  // 40-hex OR a release tag, and NOT "commit unless `tarball` is present".
  // 162 of the 5,908 live GitHub entries are release-rescued and carry a tag
  // (`@ablemind/dsh-plugin-tui` -> `v0.2.1`), so a flat 40-hex rule would
  // refuse the whole catalog for every user — the 0.5.0 failure mode, and the
  // correction the audit's G-6 finding now records. Coupling the tag form to
  // `tarball` would have the same effect the day a rescued row loses its
  // tarball. A tag that arrives WITHOUT one still cannot install: `install()`
  // requires the commit form on that branch and answers `version-mismatch:
  // … has no installable commit`, which is one loud entry instead of a dead
  // shelf.
  if (!COMMIT_SHA.test(entry.version) && !RELEASE_TAG.test(entry.version)) {
    ctx.addIssue({ code: 'custom', path: ['version'], message: `github entry version ${JSON.stringify(entry.version)} is neither a 40-character commit sha nor a release tag` })
  }
})
```

In `validateEntryCoherence`, add the query/fragment refusal after the protocol check (after line 152):

```ts
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      throw new Error(`catalog entry ${entry.name}: tarball url must be https on github.com`)
    }
    // A release asset URL has no query and no fragment. `?a=1&calc` passed the
    // host and path checks and rode into the install spec, where dsh's own
    // `shell: true` on Windows reads `&` as a command separator.
    if (parsed.search !== '' || parsed.hash !== '') {
      throw new Error(`catalog entry ${entry.name}: tarball url must carry no query or fragment`)
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/catalog.test.ts` — Expected: PASS, all pre-existing cases included (the v4 `subdir`, v5 `tarball`, v6 `peers` and origin-racing fixtures all satisfy the new grammar; verified against the fixtures at `catalog.test.ts:47,72,474,512,519,632,670,952,1009,1133`).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/tests/host/catalog.test.ts
git commit -m "fix(host): validate name, version, repo and tarball url at the catalog boundary (G-6/F-3)"
```

---

### Task 3: The executor refuses a target carrying shell punctuation

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts:210-218`
- Test: `packages/dsh-plugin-shop/tests/host/executor.test.ts:287-298`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports; the throw message gains a second form.

- [ ] **Step 1: Write the failing test**

Replace the existing `refuses a flag-like name…` test in `tests/host/executor.test.ts` (lines 288-298) with:

```ts
  it('refuses a flag-like name instead of letting the CLI parse it as an option', () => {
    // A name beginning with `-` would be argv smuggling (e.g. `--profile` as
    // an operand); the executor must throw rather than spawn. The same guard
    // covers startInstall, whose spec is `name@version`.
    expect(() => startUninstall({ profile: 'web', name: '--profile' })).toThrow(
      'dsh-plugin-shop: refusing to spawn with a flag-like operand: --profile',
    )
    expect(() => startInstall({ profile: 'web', spec: '-x@1.0.0' })).toThrow(
      'dsh-plugin-shop: refusing to spawn with a flag-like operand: -x@1.0.0',
    )
  })

  it('refuses a target carrying shell punctuation, whatever built it', () => {
    // Defence in depth behind catalog.ts's boundary grammar. dsh itself runs
    // `spawnSync('pnpm', args, { shell: process.platform === 'win32' })`, so
    // on Windows the target reaches an UNQUOTED cmd.exe line where `|`, `<`,
    // `>`, `^`, `"` and `(` all change what runs.
    for (const spec of ['dsh-x@1.0.0 & calc.exe', 'dsh-x@1.0.0|calc', 'dsh-x@1.0.0"', 'dsh-x@$(calc)', 'dsh-x@1.0.0\n', 'dsh-{{x}}@1.0.0']) {
      expect(() => startInstall({ profile: 'web', spec }), spec).toThrow(
        /refusing to spawn with an unsafe operand/,
      )
    }
  })

  it('keeps every target form the Host legitimately builds', () => {
    // `&` cannot be refused — the monorepo subpackage spec is
    // `github:owner/slug#<sha>&path:<subdir>` — so it is catalog.ts's grammar
    // on `repo`, `version` and `subdir` that keeps that one safe. `%` stays
    // for the same reason a percent-encoded local `file:` spec must work.
    const commit = 'd'.repeat(40)
    for (const spec of [
      'dsh-hello-plugin@1.2.0',
      '@scope/dsh-plugin@0.1.4-alpha.2',
      `github:someone/dsh-repo-plugin#${commit}`,
      `github:someone/monorepo#${commit}&path:packages/sub-plugin`,
      'https://github.com/owner/slug/releases/download/v1.0.0/plugin.tgz',
      'file:///tmp/dsh-real-install-a1b2/dsh-plugin-shop',
    ]) {
      // The spawn itself fails (no such dsh) — the assertion is that the
      // GUARD does not fire, which is a synchronous throw.
      expect(() => startInstall({ profile: 'guard-probe', spec, dshBin: join(tmpdir(), 'no-such-dsh-bin') }), spec).not.toThrow()
    }
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/executor.test.ts -t "refuses a target carrying shell punctuation"` — Expected: FAIL with `expected [Function] to throw error including 'refusing to spawn with an unsafe operand' but it didn't` (the current guard checks only a leading `-`).

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/executor.ts`, add above `spawnPluginCli` (before line 200):

```ts
/**
 * Punctuation that makes an install target dangerous rather than merely odd.
 *
 * The shop's own spawn uses no shell, but dsh's does: `spawnSync('pnpm',
 * args, { shell: process.platform === 'win32' })` hands cmd.exe a joined,
 * UNQUOTED line, where `|`, `<`, `>`, `^`, `"`, `(`, `)` and whitespace all
 * change what runs. `&` is deliberately NOT here — the monorepo subpackage
 * spec is `github:owner/slug#<sha>&path:<subdir>` — so what keeps that one
 * safe is catalog.ts's grammar on `repo`, `version` and `subdir`. `%` is
 * likewise kept: a percent-encoded local `file:` spec needs it, and `%VAR%`
 * cannot arrive from the catalog now that every field feeding a spec is
 * grammar-checked.
 */
const UNSAFE_TARGET = /[\s"'`|<>^$();\\{}]|[\u0000-\u001f\u007f]/
```

and extend the guard (lines 215-218). Before:

```ts
  const target = argv[1]
  if (target === undefined || target.startsWith('-')) {
    throw new Error(`dsh-plugin-shop: refusing to spawn with a flag-like operand: ${target ?? '(none)'}`)
  }
```

After:

```ts
  const target = argv[1]
  if (target === undefined || target.startsWith('-')) {
    throw new Error(`dsh-plugin-shop: refusing to spawn with a flag-like operand: ${target ?? '(none)'}`)
  }
  if (UNSAFE_TARGET.test(target)) {
    throw new Error(`dsh-plugin-shop: refusing to spawn with an unsafe operand: ${JSON.stringify(target)}`)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/executor.test.ts tests/host/index.test.ts tests/host/real-install.test.ts` — Expected: PASS (the `file:` spec at `real-install.test.ts:62` is built by `pathToFileURL` over a `mkdtemp` path and carries none of the refused characters).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/executor.ts packages/dsh-plugin-shop/tests/host/executor.test.ts
git commit -m "fix(host): refuse an install target carrying shell punctuation (G-6/F-3)"
```

---

### Task 4: `validateInstall` resolves the entry by identity, never by name alone

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/install.ts:5-43` (whole module)
- Modify: `packages/dsh-plugin-shop/src/client/present.ts:50-58` (`rejectionCodeKey`)
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts:62,155` (one key per dictionary)
- Test: `packages/dsh-plugin-shop/tests/host/install.test.ts`

**Interfaces:**
- Consumes: `identityKey`, `EntryIdentity` (Task 1).
- Produces: `InstallArgs { name, version, acknowledged?, source?, repo?, subdir? }`; `InstallRejectionCode` gains `'ambiguous-identity'`; `ValidateResult` success becomes `{ ok: true; entry: CatalogEntry }`. Tasks 5, 6 and 8 depend on all three.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/install.test.ts`, and change lines 57 and 62 (`toEqual({ ok: true })`) to `toMatchObject({ ok: true })` — the success shape now carries the resolved entry, which is exactly what removes the second `.find` by name in `index.ts`:

```ts
describe('validateInstall identity (G-1)', () => {
  const commit = 'a'.repeat(40)
  const alice: CatalogSnapshot['entries'][number] = {
    name: 'dsh-foo', version: commit, integrity: commit, publishedAt: null,
    repository: 'https://github.com/alice/dsh-foo', license: 'MIT',
    tier: 'community', metadata: 'derived', source: 'github', repo: 'alice/dsh-foo',
    added: '2026-08-25',
  }
  const bob = { ...alice, version: 'b'.repeat(40), integrity: 'b'.repeat(40), repo: 'bob/dsh-foo' }
  const twoRepos: CatalogSnapshot = {
    schemaVersion: 6, builtAt: '2026-09-03T00:00:00Z', entries: [alice, bob], denied: [], stars: {},
  }

  it('resolves the requested identity, not the first entry sharing the name', () => {
    // The defect: `.find(e => e.name === args.name)` answered alice for every
    // request, so installing bob's failed with `version-mismatch: dsh-foo@bbb…
    // is not the cataloged version (aaa…)` — a published detail that is false.
    const result = validateInstall(twoRepos, {
      name: 'dsh-foo', version: bob.version, acknowledged: true,
      source: 'github', repo: 'bob/dsh-foo',
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.entry.repo).toBe('bob/dsh-foo')
  })

  it('separates two subpackages of one repository', () => {
    const mono = { ...alice, repo: 'someone/mono', subdir: 'packages/a' }
    const other = { ...alice, version: 'c'.repeat(40), repo: 'someone/mono', subdir: 'packages/b' }
    const snap: CatalogSnapshot = {
      schemaVersion: 6, builtAt: '', entries: [mono, other], denied: [], stars: {},
    }
    const result = validateInstall(snap, {
      name: 'dsh-foo', version: other.version, acknowledged: true,
      source: 'github', repo: 'someone/mono', subdir: 'packages/b',
    })
    expect(result).toMatchObject({ ok: true })
    if (result.ok) expect(result.entry.subdir).toBe('packages/b')
  })

  it('reports an identity the catalog does not hold as not-in-catalog', () => {
    const result = validateInstall(twoRepos, {
      name: 'dsh-foo', version: commit, acknowledged: true,
      source: 'github', repo: 'carol/dsh-foo',
    })
    expect(result).toMatchObject({ ok: false, code: 'not-in-catalog' })
    if (!result.ok) expect(result.detail).toContain('github:carol/dsh-foo#')
  })

  it('refuses a name-only request the catalog cannot disambiguate', () => {
    // A browser tab left open across a self-update still sends the old
    // `{name, version}` shape. Guessing which of two repositories it meant is
    // exactly the wrongness this finding is about, so it is refused instead.
    const result = validateInstall(twoRepos, { name: 'dsh-foo', version: commit, acknowledged: true })
    expect(result).toMatchObject({ ok: false, code: 'ambiguous-identity' })
    if (!result.ok) {
      expect(result.detail).toBe('dsh-plugin-shop: the catalog holds 2 entries named dsh-foo, and this request does not say which one; refresh the shop and try again')
    }
  })

  it('still serves a name-only request when the name is unique', () => {
    const single: CatalogSnapshot = {
      schemaVersion: 6, builtAt: '', entries: [alice], denied: [], stars: {},
    }
    const result = validateInstall(single, { name: 'dsh-foo', version: commit, acknowledged: true })
    expect(result).toMatchObject({ ok: true })
  })
})
```

Add the `CatalogSnapshot` type import already present at the top of the file, and nothing else.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/install.test.ts -t "validateInstall identity"` — Expected: FAIL — the first case reports `{ ok: false, code: 'version-mismatch' }` (alice's entry answered for bob's request) and `result.entry` does not exist on the success type (`tsc` also reports `Property 'entry' does not exist on type '{ ok: true; }'`).

- [ ] **Step 3: Write the implementation**

Replace `packages/dsh-plugin-shop/src/host/install.ts` in full. Before (lines 1-43) is the current module keyed on `args.name`. After:

```ts
/** Install gate: the gate rejection paths of §7.2, as a pure function. */

import type { CatalogSnapshot } from './catalog.ts'
import type { CatalogEntry } from './types.ts'
import { identityKey } from '../shared/identity.ts'

export type InstallRejectionCode =
  | 'not-in-catalog'
  | 'denied'
  | 'version-mismatch'
  | 'needs-acknowledgement'
  // A release-rescued entry's tarball failed verification against the
  // recorded sha256, or could not be fetched within the byte cap (the Host
  // checks before anything spawns; §3.1 of 2026-08-31-market-borrowings).
  | 'tarball-integrity'
  // The request named a package name the catalog holds more than once and
  // said nothing about which entry it meant. 151 live names cover 243
  // entries, so this is not hypothetical — and guessing would install
  // another repository's code (G-1).
  | 'ambiguous-identity'

export interface InstallArgs {
  name: string
  version: string
  acknowledged?: boolean
  /** The entry's install identity (G-1). `name` is not one: the catalog's
   * uniqueness rule is `npm:<name>` / `github:<repo>#<subdir>`.
   *
   * OPTIONAL on the wire on purpose. The client and the host ship in one
   * package, but a browser tab left open across a shop self-update and
   * restart still holds the PREVIOUS client bundle, which sends only
   * `{name, version}`. Such a request is served when the name is unique and
   * refused as `ambiguous-identity` when it is not — never guessed. */
  source?: 'npm' | 'github'
  repo?: string
  subdir?: string
}

export type ValidateResult =
  | { ok: true; entry: CatalogEntry }
  | { ok: false; code: InstallRejectionCode; detail: string }

/**
 * Decide whether one install request may proceed, against the Host's own
 * snapshot (§5.3), and hand back the entry it resolved to — so the caller
 * builds the spec from THAT row and never re-finds it by name.
 *
 * The browser sends an identity; nothing it says about the package is
 * trusted beyond selecting which validated row applies.
 */
export function validateInstall(snapshot: CatalogSnapshot, args: InstallArgs): ValidateResult {
  const denied = snapshot.denied.find(d => d.name === args.name)
  if (denied !== undefined) {
    return { ok: false, code: 'denied', detail: `dsh-plugin-shop: ${args.name} is denied: ${denied.detail}` }
  }
  let entry: CatalogEntry | undefined
  if (args.source === undefined) {
    // The legacy name-only shape. Unique is answerable; ambiguous is not.
    const named = snapshot.entries.filter(e => e.name === args.name)
    if (named.length > 1) {
      return {
        ok: false,
        code: 'ambiguous-identity',
        detail: `dsh-plugin-shop: the catalog holds ${named.length} entries named ${args.name}, and this request does not say which one; refresh the shop and try again`,
      }
    }
    entry = named[0]
  } else {
    const wanted = identityKey({ source: args.source, name: args.name, repo: args.repo, subdir: args.subdir })
    entry = snapshot.entries.find(e => identityKey(e) === wanted)
    if (entry === undefined) {
      return { ok: false, code: 'not-in-catalog', detail: `dsh-plugin-shop: ${wanted} is not in the catalog` }
    }
  }
  if (entry === undefined) {
    return { ok: false, code: 'not-in-catalog', detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
  }
  if (entry.version !== args.version) {
    return { ok: false, code: 'version-mismatch', detail: `dsh-plugin-shop: ${args.name}@${args.version} is not the cataloged version (${entry.version})` }
  }
  if (entry.tier !== 'verified' && !args.acknowledged) {
    const detail = entry.tier === 'verified-stale'
      ? `dsh-plugin-shop: ${args.name} is verified-stale: a newer version than the review is current and has not been reviewed; acknowledgement is required`
      : `dsh-plugin-shop: ${args.name} is ${entry.tier}-tier and has not been reviewed; acknowledgement is required`
    return { ok: false, code: 'needs-acknowledgement', detail }
  }
  return { ok: true, entry }
}
```

In `packages/dsh-plugin-shop/src/client/present.ts`, extend `rejectionCodeKey` (lines 50-58) — the switch is exhaustive over the union, so leaving it alone is a compile error. Before:

```ts
    case 'tarball-integrity': return 'tarballIntegrityCode'
  }
}
```

After:

```ts
    case 'tarball-integrity': return 'tarballIntegrityCode'
    case 'ambiguous-identity': return 'ambiguousIdentityCode'
  }
}
```

In `packages/dsh-plugin-shop/src/client/locales.ts`, add one key to each dictionary, immediately after `tarballIntegrityCode` (line 62 in `zh`, line 155 in `en`):

```ts
  tarballIntegrityCode: '压缩包完整性校验失败',
  ambiguousIdentityCode: '无法确定是哪一个条目',
```

```ts
  tarballIntegrityCode: 'tarball integrity check failed',
  ambiguousIdentityCode: 'Ambiguous entry',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/install.test.ts tests/client/present.test.ts` — Expected: PASS. Then `npx tsc --noEmit -p tsconfig.json` — Expected: one error remaining, `index.ts` still reading the old success shape, which Task 5 fixes.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/install.ts packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/src/client/locales.ts packages/dsh-plugin-shop/tests/host/install.test.ts
git commit -m "fix(host): resolve an install request by identity, refusing an ambiguous name (G-1)"
```

---

### Task 5: `install()` builds the spec from the resolved entry and pins by identity

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:627-735` (`install`), `:722-730` (pin write)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `validateInstall` returning `{ ok: true; entry }` (Task 4), `identityKey` (Task 1).
- Produces: pins keyed by `identityKey(entry)` with a read-time fallback to the legacy bare-name key. Task 6 reads the same key.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/index.test.ts`:

```ts
describe('two catalog entries share one name (G-1)', () => {
  const aliceCommit = 'a'.repeat(40)
  const bobCommit = 'b'.repeat(40)
  const alice: CatalogEntry = {
    name: 'dsh-foo', version: aliceCommit, integrity: aliceCommit, publishedAt: null,
    repository: 'https://github.com/alice/dsh-foo', license: 'MIT',
    tier: 'community', metadata: 'derived', source: 'github', repo: 'alice/dsh-foo',
    added: '2026-08-25',
  }
  const bob: CatalogEntry = { ...alice, version: bobCommit, integrity: bobCommit, repo: 'bob/dsh-foo' }

  function gatewayWithBoth(dir: string, dependencies: Record<string, string>): ShopGateway {
    const bin = join(dir, 'fake-dsh')
    writeFileSync(bin, ['#!/bin/sh', `echo "$1 $2 $3 $4 $5" >> "${join(dir, 'calls.log')}"`, 'exit 0', ''].join('\n'))
    chmodSync(bin, 0o755)
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-dup-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies }))
    return new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [alice, bob], denied: [], stars: {} }, stale: false }) as CatalogResult,
      dshBin: bin,
    })
  }

  it('spawns the identity that was asked for, not the first entry with the name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dup-install-'))
    const gateway = gatewayWithBoth(dir, {})
    const result = await gateway.install({
      name: 'dsh-foo', version: bobCommit, acknowledged: true,
      source: 'github', repo: 'bob/dsh-foo',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const deadline = Date.now() + 5000
    let terminal = gateway.installStatus({ installId: result.installId })
    while (terminal.state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
      terminal = gateway.installStatus({ installId: result.installId })
    }
    const calls = readFileSync(join(dir, 'calls.log'), 'utf8')
    expect(calls).toContain(`add github:bob/dsh-foo#${bobCommit}`)
    expect(calls).not.toContain('alice/dsh-foo')
    // The pin is recorded under the IDENTITY, so alice's pin cannot overwrite
    // bob's — the bare-name key made the two share one slot.
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8')))
      .toEqual({ 'github:bob/dsh-foo#': bobCommit })
  })

  it('refuses a name-only install request while two entries share the name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dup-ambiguous-'))
    const gateway = gatewayWithBoth(dir, {})
    const result = await gateway.install({ name: 'dsh-foo', version: bobCommit, acknowledged: true })
    expect(result).toMatchObject({ ok: false, code: 'ambiguous-identity' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(existsSync(join(dir, 'calls.log'))).toBe(false)
  })
})
```

Three pre-existing assertions in the same file describe the pin WRITE and change with it — the pin slot is now the identity, so two repositories publishing one bundle name can no longer overwrite each other's recorded commit:

- `index.test.ts:860`: `toEqual({ 'dsh-repo-plugin': commit })` → `toEqual({ 'github:someone/dsh-repo-plugin#': commit })`
- `index.test.ts:939`: `toEqual({ 'sub-plugin': commit })` → `toEqual({ 'github:someone/monorepo#packages/sub-plugin': commit })`
- `index.test.ts:1000`: `toEqual({ 'dsh-rescued': tag })` → `toEqual({ 'github:owner/slug#': tag })`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/index.test.ts -t "two catalog entries share one name"` — Expected: FAIL — the first case records `add github:alice/dsh-foo#aaa…` (the audit's exact reproduction: another repository's commit replacing the user's plugin) and the pins file reads `{ 'dsh-foo': 'bbb…' }`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/index.ts`, add `identityKey` to the imports (beside the other local imports, after line 26):

```ts
import { identityKey, installedSpecMatches } from '../shared/identity.ts'
```

Then in `install()`, replace the verdict-and-re-find block (lines 635-640). Before:

```ts
    const verdict = validateInstall(this.lastSnapshot, args)
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail }
    const entry = this.lastSnapshot.entries.find(e => e.name === args.name)
    // validateInstall passed, so the entry exists; the guard keeps the type
    // honest without asserting a state the validator never produces.
    if (entry === undefined) return { ok: false, code: 'not-in-catalog', detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
```

After:

```ts
    const verdict = validateInstall(this.lastSnapshot, args)
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail }
    // The validator resolved which row this request is about, by identity —
    // re-finding it by name is what installed another repository's commit
    // (G-1), so the entry travels out of the gate instead.
    const entry = verdict.entry
```

and replace the pin write (lines 723-730). Before:

```ts
    if (entry.source === 'github') {
      // Remember the pinned commit: the manifest records only
      // `github:owner/slug`, so the pins file is how `installed()` reports
      // outdated honestly. A failed install leaves a pin behind, but the
      // manifest presence gate keeps it invisible.
      const pins = readRepoPins(this.pinFs, this.pinsPath())
      writeRepoPins(this.pinFs, this.pinsPath(), { ...pins, [args.name]: args.version })
    }
```

After:

```ts
    if (entry.source === 'github') {
      // Remember the pinned commit: the manifest records only
      // `github:owner/slug`, so the pins file is how `installed()` reports
      // outdated honestly. A failed install leaves a pin behind, but the
      // manifest presence gate keeps it invisible.
      //
      // Keyed by IDENTITY, not by name: two repositories publishing the same
      // bundle name shared one pin slot, so installing one silently rewrote
      // the other's recorded commit (G-1).
      const pins = readRepoPins(this.pinFs, this.pinsPath())
      writeRepoPins(this.pinFs, this.pinsPath(), { ...pins, [identityKey(entry)]: entry.version })
    }
```

Note the value is now `entry.version` rather than `args.version`: they are equal (the validator refuses a mismatch), and reading it off the validated row keeps the pin sourced from the snapshot rather than from the wire.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/index.test.ts` — Expected: PASS, including the three pre-existing pin-write assertions updated in Step 1 above.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "fix(host): build the install spec from the resolved entry and pin by identity (G-1)"
```

---

### Task 6: `installed()` matches the manifest's spec to the entry, and every row carries its identity

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:157-163` (`ShopInstalledEntry`), `:762-831` (`installed`), `:854-905` (`uninstall`)
- Modify: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx:35-47` (`bench` fills the new field)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `identityKey`, `installedSpecMatches` (Task 1); the identity-keyed pins written in Task 5.
- Produces: `ShopInstalledEntry { name, source, repo?, subdir?, installed, latest, outdated, enabled }`. Task 8 keys the client's maps off it.

- [ ] **Step 1: Write the failing test**

Append inside the `describe('two catalog entries share one name (G-1)')` block created in Task 5:

```ts
  it('reports one row for the repository that is actually installed', async () => {
    // The audit's reproduction: with bob's installed, `installed()` returned
    // TWO rows for one plugin, one of them `outdated: true`, and the Outdated
    // row's Update button spawned alice's commit over it.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dup-installed-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'github:bob/dsh-foo#': bobCommit }))
    const gateway = gatewayWithBoth(dir, { 'dsh-foo': 'github:bob/dsh-foo' })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-foo', source: 'github', repo: 'bob/dsh-foo',
      installed: bobCommit, latest: bobCommit, outdated: false, enabled: true,
    }])
  })

  it('does not let an npm namesake claim a repo entry\'s installed row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dup-npm-'))
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-dup-npm-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-foo': 'github:bob/dsh-foo' },
    }))
    const npmTwin: CatalogEntry = {
      ...alice, version: '2.0.0', integrity: 'sha512-x', source: 'npm', repo: undefined,
    }
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [npmTwin, bob], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    // Only bob's row: the npm entry with the same name is not what is
    // installed, and reporting it produced a phantom "update available".
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-foo', source: 'github', repo: 'bob/dsh-foo',
      installed: 'github:bob/dsh-foo', latest: bobCommit, outdated: false, enabled: true,
    }])
  })

  it('forgets the identity pin on uninstall', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-dup-uninstall-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({
      'github:bob/dsh-foo#': bobCommit, 'github:alice/dsh-foo#': aliceCommit,
    }))
    const gateway = gatewayWithBoth(dir, { 'dsh-foo': 'github:bob/dsh-foo' })
    await gateway.catalog({})
    const result = await gateway.uninstall({ name: 'dsh-foo' })
    expect(result.ok).toBe(true)
    // Only the installed identity's pin is forgotten; alice's stays.
    expect(JSON.parse(readFileSync(join(dir, 'cache/github-pins.json'), 'utf8')))
      .toEqual({ 'github:alice/dsh-foo#': aliceCommit })
  })
```

Eleven pre-existing `installed()` assertions gain the row's identity — the field is new on the wire, so every expectation states it:

- `index.test.ts:449,467,473,479,504,531,537,543` and both rows of `:485-488`: add `source: 'npm'` to each expected object.
- `index.test.ts:875`: add `source: 'github', repo: 'someone/dsh-repo-plugin'`.

And `tests/client/ShopTab.client.spec.tsx`'s `bench` fills the field once, so the seventeen row literals in that file stay exactly as they are (including the two the working tree's badge change added). Before (lines 35, 40):

```ts
function bench(catalogResult: ShopCatalogResult, installedEntries: ShopInstalledEntry[] = []) {
```
```ts
  const installed = vi.fn<ShopTabInjected['installed']>().mockResolvedValue(installedEntries)
```

After:

```ts
/** An installed row as the tests write it: `source` defaults to npm, which
 * is what every fixture here means. A repo fixture states `source`/`repo`
 * and the identity then flows through the tab's maps (G-1). */
type InstalledFixture =
  Omit<ShopInstalledEntry, 'source' | 'repo' | 'subdir'>
  & Partial<Pick<ShopInstalledEntry, 'source' | 'repo' | 'subdir'>>

function bench(catalogResult: ShopCatalogResult, installedEntries: InstalledFixture[] = []) {
```
```ts
  const rows: ShopInstalledEntry[] = installedEntries.map(row => ({ source: 'npm', ...row }))
  const installed = vi.fn<ShopTabInjected['installed']>().mockResolvedValue(rows)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/index.test.ts -t "reports one row for the repository that is actually installed"` — Expected: FAIL with two rows returned instead of one (`- Expected 1, + Received 2`), the second being alice's with `outdated: true`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/index.ts`, replace `ShopInstalledEntry` (lines 157-163). Before:

```ts
export interface ShopInstalledEntry { name: string; installed: string; latest: string; outdated: boolean; enabled: boolean }
```

After:

```ts
export interface ShopInstalledEntry {
  name: string
  /** The row's install identity (G-1). `name` is not one: the catalog holds
   * 151 names over 243 entries, and the client's lookup maps, its React keys
   * and the Update button's install request all need to know WHICH entry
   * this row is. Mirrors the fields `identityKey` reads. */
  source: 'npm' | 'github'
  repo?: string
  subdir?: string
  installed: string
  latest: string
  outdated: boolean
  enabled: boolean
}
```

Replace the row loop in `installed()` (lines 803-830). Before:

```ts
    const installed: ShopInstalledEntry[] = []
    for (const entry of this.lastSnapshot.entries) {
      const spec = dependencies[entry.name]
      if (spec === undefined) continue
      if (entry.source === 'github') {
        // The manifest spec is `github:owner/slug` — no commit. The pin the
        // shop recorded at install time is the commit truth; without one the
        // entry was installed by other means and reads as current rather
        // than killing the RPC over an unknowable comparison.
        const pin = pins[entry.name]
        installed.push({
          name: entry.name,
          installed: pin ?? spec,
          latest: entry.version,
          outdated: pin !== undefined && pin !== entry.version,
          enabled: enabledOf(entry.name),
        })
      } else {
        installed.push({
          name: entry.name,
          installed: spec,
          latest: entry.version,
          outdated: this.isBehind(spec, entry.version),
          enabled: enabledOf(entry.name),
        })
      }
    }
    return installed
```

After:

```ts
    const installed: ShopInstalledEntry[] = []
    for (const entry of this.lastSnapshot.entries) {
      const spec = dependencies[entry.name]
      if (spec === undefined) continue
      // The manifest holds ONE dependency per name, so the name cannot say
      // which same-named entry is installed — the spec can. Without this,
      // `installed()` returned a row for every entry sharing the name, one
      // of them `outdated`, and its Update button installed the other
      // repository's commit (G-1).
      if (!installedSpecMatches(entry, spec)) continue
      const identity = { source: entry.source, repo: entry.repo, subdir: entry.subdir }
      if (entry.source === 'github') {
        // The manifest spec is `github:owner/slug` — no commit. The pin the
        // shop recorded at install time is the commit truth; without one the
        // entry was installed by other means and reads as current rather
        // than killing the RPC over an unknowable comparison. The bare-name
        // key is read as a fallback so an upgrade from a build that wrote it
        // does not lose the pin (it is re-written under the identity on the
        // next install, and forgotten on uninstall).
        const pin = pins[identityKey(entry)] ?? pins[entry.name]
        installed.push({
          name: entry.name,
          ...identity,
          installed: pin ?? spec,
          latest: entry.version,
          outdated: pin !== undefined && pin !== entry.version,
          enabled: enabledOf(entry.name),
        })
      } else {
        installed.push({
          name: entry.name,
          ...identity,
          installed: spec,
          latest: entry.version,
          outdated: this.isBehind(spec, entry.version),
          enabled: enabledOf(entry.name),
        })
      }
    }
    return installed
```

Replace the head and the pin-forget of `uninstall()` (lines 862-869 and 895-900). Before:

```ts
    if (!this.lastSnapshot.entries.some(entry => entry.name === args.name)) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
    }
    const manifest = readProfileManifest('dsh-plugin-shop', this.profileDirResolved())
    const dependencies = manifest.dependencies ?? {}
    if (dependencies[args.name] === undefined) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not installed` }
    }
```

After:

```ts
    const named = this.lastSnapshot.entries.filter(entry => entry.name === args.name)
    if (named.length === 0) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
    }
    const manifest = readProfileManifest('dsh-plugin-shop', this.profileDirResolved())
    const dependencies = manifest.dependencies ?? {}
    const spec = dependencies[args.name]
    if (spec === undefined) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not installed` }
    }
    // The removal itself is by name — the profile manifest holds exactly one
    // dependency under it — but WHICH same-named entry is installed decides
    // which pin to forget (G-1). An entry that matches nothing is still
    // removable: uninstalling revokes privilege, so a spec the catalog no
    // longer explains must not trap the package in the profile.
    const installedEntry = named.find(candidate => installedSpecMatches(candidate, spec))
```

Before:

```ts
    // Forget the commit pin alongside the dependency; a stale pin would
    // otherwise outlive the uninstall in the shop's cache.
    const pins = readRepoPins(this.pinFs, this.pinsPath())
    if (pins[args.name] !== undefined) {
      delete pins[args.name]
      writeRepoPins(this.pinFs, this.pinsPath(), pins)
    }
```

After:

```ts
    // Forget the commit pin alongside the dependency; a stale pin would
    // otherwise outlive the uninstall in the shop's cache. Both spellings go:
    // this build's identity key, and the bare-name key an earlier build wrote.
    const pins = readRepoPins(this.pinFs, this.pinsPath())
    const stalePins = [args.name, ...(installedEntry === undefined ? [] : [identityKey(installedEntry)])]
    let forgot = false
    for (const key of stalePins) {
      if (pins[key] !== undefined) {
        delete pins[key]
        forgot = true
      }
    }
    if (forgot) writeRepoPins(this.pinFs, this.pinsPath(), pins)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/index.test.ts tests/client/ShopTab.client.spec.tsx` and `npx tsc -p tsconfig.test.json --noEmit` — Expected: PASS and clean.

Note the residual, left alone deliberately: `readRepoPins` filters values by `/^[0-9a-f]{40}$/`, so a release-rescued entry's TAG pin (`v1.0.0`) is written and then dropped on read — that row reports `installed: <spec>` and `outdated: false`. It is a pre-existing defect no audit finding covers, and widening the value check is a behaviour change on its own evidence, not part of G-1.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/index.test.ts packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx
git commit -m "fix(host): match an installed row to its catalog entry by spec, not by name (G-1)"
```

---

### Task 7: The incompatibility map is keyed by identity

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/peers.ts:133-175` (`incompatibilityMap`)
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:246-249` (`ShopCatalogResult.incompatible` doc)
- Test: `packages/dsh-plugin-shop/tests/host/peers.test.ts`

**Interfaces:**
- Consumes: `identityKey`, `EntryIdentity` (Task 1).
- Produces: `incompatibilityMap(entries: readonly (EntryIdentity & { peers?: string[] })[], resolve)` returning a map keyed by `identityKey`. Task 8 reads it with `identityKey(entry)`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/peers.test.ts`:

```ts
describe('incompatibilityMap identity (G-1)', () => {
  it('keys each verdict by the entry identity, so same-named entries do not merge', () => {
    // Two repositories publishing one bundle name declare different peers.
    // Keyed by name, the second overwrote the first and one of the two cards
    // showed the other's verdict.
    const map = incompatibilityMap(
      [
        { source: 'github', name: 'dsh-foo', repo: 'alice/dsh-foo', peers: ['@deepseek-ai/dsh-client-store'] },
        { source: 'github', name: 'dsh-foo', repo: 'bob/dsh-foo', peers: ['react'] },
        { source: 'npm', name: 'dsh-foo', peers: ['temml'] },
      ],
      resolve,
    )
    expect(map).toEqual({
      'github:alice/dsh-foo#': ['@deepseek-ai/dsh-client-store'],
      'npm:dsh-foo': ['temml'],
    })
  })

  it('keys a subpackage entry by its subdir', () => {
    const map = incompatibilityMap(
      [{ source: 'github', name: 'sub', repo: 'someone/mono', subdir: 'packages/a', peers: ['temml'] }],
      resolve,
    )
    expect(map).toEqual({ 'github:someone/mono#packages/a': ['temml'] })
  })
})
```

The eight pre-existing cases in the same file pass bare `{ name, peers }` objects; each gains `source: 'npm'` so the fixture states the identity it is asserting under, and their expectations become `npm:`-prefixed:

- `peers.test.ts:16-21` → `{ source: 'npm', name: 'dsh-timeline', peers: [...] }`, expect `{ 'npm:dsh-timeline': ['@deepseek-ai/dsh-client-store'] }`
- `:24` → `{ source: 'npm', name: 'ok', peers: ['react'] }`
- `:28` → `{ source: 'npm', name: 'bare' }`
- `:34` → `{ source: 'npm', name: 'x', peers: ['temml'] }`, expect `{ 'npm:x': ['temml'] }`
- `:40-47` → the three counting fixtures gain `source: 'npm'`
- `:55`, `:63`, `:74-79` → same, expectations stay `{}`

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/peers.test.ts -t "incompatibilityMap identity"` — Expected: FAIL with `{ 'dsh-foo': ['temml'] }` received (all three entries collapsed onto one name key, last writer winning) instead of the two identity keys.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/peers.ts`, add the import and change the signature and the two writes. Before (line 101 area and 133-175):

```ts
import { createRequire } from 'node:module'
```
…
```ts
export function incompatibilityMap(
  entries: readonly { name: string; peers?: string[] }[],
  resolve: PeerResolver,
): Record<string, string[]> {
```
…
```ts
    if (usable && missing.length > 0) out[entry.name] = missing
```

After:

```ts
import { createRequire } from 'node:module'
import { identityKey, type EntryIdentity } from '../shared/identity.ts'
```
…
```ts
/**
 * Install identity → the peer names that did not resolve. A key is present
 * only when at least one peer is missing, so an absent key means "runs here,
 * or we could not tell" — the client renders nothing for either.
 *
 * Keyed by IDENTITY, not by name: two repositories publishing one bundle
 * name declare different peers, and a name key made the second overwrite the
 * first (G-1). The client looks a card up with `identityKey(entry)`.
 *
 * A resolver that throws yields NO verdict at all: an unavailable fact must
 * never read as an accusation, because one false warning teaches a reader to
 * ignore every warning.
 */
export function incompatibilityMap(
  entries: readonly (EntryIdentity & { peers?: string[] })[],
  resolve: PeerResolver,
): Record<string, string[]> {
```
…
```ts
    if (usable && missing.length > 0) out[identityKey(entry)] = missing
```

Delete the now-duplicated doc comment that sat above the old signature (lines 133-141), which the block above replaces.

In `packages/dsh-plugin-shop/src/host/index.ts`, update the field doc on `ShopCatalogResult` (lines 246-249). Before:

```ts
  /** Package name → the declared peers this installation does not provide
   * (design 2026-09-01). A name is absent when the plugin runs here or when
   * no verdict could be formed; the client renders nothing for both. */
  incompatible: Record<string, string[]>
```

After:

```ts
  /** Install identity (`npm:<name>` / `github:<repo>#<subdir>`) → the declared
   * peers this installation does not provide (design 2026-09-01). A key is
   * absent when the plugin runs here or when no verdict could be formed; the
   * client renders nothing for both. Keyed by identity rather than name so
   * two same-named entries cannot inherit each other's verdict (G-1). */
  incompatible: Record<string, string[]>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/peers.test.ts tests/host/index.test.ts` — Expected: PASS. The four `ShopGateway.catalog incompatibility` cases at `index.test.ts:1453-1530` assert through `catalog()`; their expectations change from `{ 'dsh-timeline': [...] }` to `{ 'npm:dsh-timeline': [...] }` in the same edit.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/peers.ts packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/peers.test.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "fix(host): key the incompatibility map by install identity (G-1)"
```

---

### Task 8: The client addresses every entry by identity

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx:226-250` (`EntryCard` action row), `:286-303` (`InstallPanel` props), `:382-384,396-421` (the two `start` calls), `:671-698` (`OutdatedRow`), `:707-748` (`OutdatedSection`), `:886-894` (`installedByName`), `:916-931` (`filtered`), `:979-1012` (`tiers`/`sources`/`missingByName`), `:1240-1244` (card list), `:1256-1267` (section props)
- Modify: `packages/dsh-plugin-shop/src/client/present.ts:32-37` (`missingPeersOf` doc and parameter name)
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `identityKey`, `entryKey` (Task 1); `InstallArgs` with identity fields (Task 4); `ShopInstalledEntry` with identity fields (Task 6); `incompatible` keyed by identity (Task 7).
- Produces: no exports; `InstallPanel` takes `target: InstallArgs` in place of `name`/`version`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx` (inside the top-level `describe('ShopTab', …)`):

```ts
  it('addresses two same-named repository entries separately (G-1)', async () => {
    // `installedByName`, `tiers`, `sources` and `missingByName` all keyed on
    // the bare name, so bob's installed row claimed alice's card too, the
    // Outdated list rendered a duplicate React key, and the Update button
    // could hand the host the wrong repository.
    const aliceCommit = 'a'.repeat(40)
    const bobCommit = 'b'.repeat(40)
    const base = snapshot().plugins[0]
    if (base === undefined) throw new Error('the fixture snapshot has no entry')
    const alice = { ...base, name: 'dsh-foo', version: aliceCommit, source: 'github' as const, repo: 'alice/dsh-foo' }
    const bob = { ...alice, version: bobCommit, repo: 'bob/dsh-foo' }
    const { injected, install } = bench(
      {
        ...snapshot(),
        plugins: [alice, bob],
        incompatible: { 'github:bob/dsh-foo#': ['@deepseek-ai/dsh-client-store'] },
      },
      [{
        name: 'dsh-foo', source: 'github', repo: 'bob/dsh-foo',
        installed: 'c'.repeat(40), latest: bobCommit, outdated: true, enabled: true,
      }],
    )
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText(en.installedSection)).toBeTruthy())

    // One outdated row for the one installed repository, not one per namesake.
    expect(container.querySelectorAll('[data-shop-outdated-entry]')).toHaveLength(1)
    // The peer verdict belongs to bob's identity alone.
    expect(container.querySelectorAll('[data-shop-outdated-entry] [data-shop-incompatible]')).toHaveLength(1)
    // Both cards render, and only the uninstalled one offers Install.
    expect(container.querySelectorAll('[data-shop-entry="dsh-foo"]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-shop-install]')).toHaveLength(1)

    fireEvent.click(container.querySelector('[data-shop-outdated-entry] [data-shop-update]')!)
    fireEvent.click(container.querySelector('[data-shop-outdated-entry] [data-shop-confirm]')!)
    await waitFor(() => expect(install).toHaveBeenCalled())
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      name: 'dsh-foo', version: bobCommit, source: 'github', repo: 'bob/dsh-foo', acknowledged: true,
    }))
  })

  it('sends the identity on a plain shelf install too', async () => {
    const { injected, install } = bench(snapshot({ tier: 'verified' }))
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-install]')!)
    await waitFor(() => expect(install).toHaveBeenCalled())
    expect(install).toHaveBeenCalledWith(expect.objectContaining({
      name: 'dsh-hello-plugin', version: '1.2.0', source: 'npm',
    }))
  })
```

Eleven pre-existing sites in the same file change with the two maps this task re-keys — each is a fixture stating a key the host now spells differently, or an install-args expectation gaining the identity:

**The `incompatible` fixtures become identity-keyed** (Task 7 re-keyed the host's map): at lines 980, 995, 1015, 1036, 1053, 1066, 1083, 1102 and 1121, `incompatible: { 'dsh-hello-plugin': ['@deepseek-ai/dsh-client-store'] }` becomes `incompatible: { 'npm:dsh-hello-plugin': ['@deepseek-ai/dsh-client-store'] }`. The `incompatible: {}` sites (31, 1007, 1149, 1212, 1266, 1315, 1326, 1338, 1350, 1357, 1383) are unaffected.

**The install-args expectations state the identity.** `toHaveBeenCalledWith` compares the whole argument object, so an added defined property fails it. At lines 170, 189, 859, 870, 897 and 947, `{ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: … }` becomes `{ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: …, source: 'npm', repo: undefined, subdir: undefined }`; at line 1309 (a github fixture) it becomes `{ name: 'dsh-hello-plugin', version: commit, acknowledged: true, source: 'github', repo: 'someone/dsh-hello-plugin', subdir: undefined }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/ShopTab.client.spec.tsx -t "addresses two same-named repository entries separately"` — Expected: FAIL — `expected '[data-shop-install]' length 1, received 0` (bob's installed row claimed alice's card by name), and jsdom logs React's duplicate-key warning for the Outdated list.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/client/present.ts`, rename the parameter and correct the doc (lines 32-37). Before:

```ts
/** The peers the Host said this installation does not provide, or none when it
 * said nothing — a plugin that runs here and one the Host could not judge are
 * both rendered as no warning at all. */
export function missingPeersOf(incompatible: Record<string, string[]>, name: string): string[] {
  return incompatible[name] ?? []
}
```

After:

```ts
/** The peers the Host said this installation does not provide, or none when it
 * said nothing — a plugin that runs here and one the Host could not judge are
 * both rendered as no warning at all. The map is keyed by INSTALL IDENTITY
 * (`identityKey`), never by name: two entries can share a name and declare
 * different peers (G-1). */
export function missingPeersOf(incompatible: Record<string, string[]>, key: string): string[] {
  return incompatible[key] ?? []
}
```

In `packages/dsh-plugin-shop/src/client/ShopTab.tsx`, add `identityKey` to the `present.ts` import list on line 10 (it already imports `entryKey`), and make these nine edits.

(a) `EntryCard`'s action row (lines 226-250). Before:

```ts
      <div className={css.cardActions} data-shop-actions>
        {installed === undefined ? (
          <InstallPanel name={entry.name} version={entry.version} tier={entry.tier} missing={missing} missingStated t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
        ) : (
          <>
            {installed.outdated ? (
              // The update button drives the same install flow for the
              // catalog's latest version; the community gate still applies
              // (§9.3).
              <InstallPanel name={entry.name} version={entry.version} tier={entry.tier} variant="update" missing={missing} missingStated t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
```

After:

```ts
      <div className={css.cardActions} data-shop-actions>
        {installed === undefined ? (
          <InstallPanel target={installTarget} tier={entry.tier} missing={missing} missingStated t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
        ) : (
          <>
            {installed.outdated ? (
              // The update button drives the same install flow for the
              // catalog's latest version; the community gate still applies
              // (§9.3).
              <InstallPanel target={installTarget} tier={entry.tier} variant="update" missing={missing} missingStated t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
```

with the target built beside the other derived values in `EntryCard` (after line 94, `const category = …`):

```ts
  // What an install request for THIS card is: the identity, never the name
  // alone — the catalog holds 151 names over 243 entries (G-1).
  const installTarget: InstallArgs = {
    name: entry.name, version: entry.version,
    source: entry.source, repo: entry.repo, subdir: entry.subdir,
  }
```

(b) `InstallPanel`'s props (lines 286-303). Before:

```ts
function InstallPanel({ name, version, tier, missing, missingStated = false, variant = 'install', t, install, installStatus, restart, restartSupported }: {
  name: string
  version: string
  tier: CatalogEntry['tier']
```

After:

```ts
function InstallPanel({ target, tier, missing, missingStated = false, variant = 'install', t, install, installStatus, restart, restartSupported }: {
  /** The install request this panel drives, identity included — so the
   * Update button on an outdated row can never spawn a same-named entry
   * from another repository (G-1). */
  target: InstallArgs
  tier: CatalogEntry['tier']
```

(c) the gate's confirm (line 384). Before:

```ts
              void start({ name, version, acknowledged: true })
```

After:

```ts
              void start({ ...target, acknowledged: true })
```

(d) the idle button's click (line 406) — the surrounding fragment of button plus `IncompatibleBadge` is unchanged. Before:

```ts
            // Reviewed: install directly; there is nothing to acknowledge (§9.3).
            void start({ name, version, acknowledged: undefined })
```

After:

```ts
            // Reviewed: install directly; there is nothing to acknowledge (§9.3).
            void start({ ...target, acknowledged: undefined })
```

(e) `OutdatedRow` (lines 671-698). Before:

```ts
function OutdatedRow({ row, tier, source, missing, t, setEnabled, install, installStatus, restart, restartSupported }: {
  row: ShopInstalledEntry
  tier: CatalogEntry['tier']
  source: CatalogEntry['source']
```
…
```ts
        <InstallPanel name={row.name} version={row.latest} tier={tier} variant="update" missing={missing} t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
```

After:

```ts
function OutdatedRow({ row, tier, missing, t, setEnabled, install, installStatus, restart, restartSupported }: {
  row: ShopInstalledEntry
  tier: CatalogEntry['tier']
```
…
```ts
        <InstallPanel
          target={{ name: row.name, version: row.latest, source: row.source, repo: row.repo, subdir: row.subdir }}
          tier={tier} variant="update" missing={missing} t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported}
        />
```

and the version line's `source === 'github'` test (line 688) reads the row's own field:

```ts
          <span>{t('installedVersion', { version: row.source === 'github' ? row.installed.slice(0, 7) : row.installed })}</span>
```

(f) `OutdatedSection` (lines 707-748): the three name-keyed maps become one identity-keyed entry map, and the React key becomes the identity. Before:

```ts
function OutdatedSection({ state, tiers, sources, missingByName, t, setEnabled, install, installStatus, restart, restartSupported }: {
  state: InstalledState
  tiers: ReadonlyMap<string, CatalogEntry['tier']>
  sources: ReadonlyMap<string, CatalogEntry['source']>
  missingByName: ReadonlyMap<string, string[]>
```
…
```ts
        {outdated.map(row => (
          <li key={row.name}>
            <OutdatedRow
              row={row}
              tier={tiers.get(row.name) ?? 'community'}
              source={sources.get(row.name) ?? 'npm'}
              missing={missingByName.get(row.name) ?? []}
```

After:

```ts
function OutdatedSection({ state, entriesByKey, missingByKey, t, setEnabled, install, installStatus, restart, restartSupported }: {
  state: InstalledState
  /** Catalog entries by install identity — the row's tier comes from here.
   * An identity the loaded catalog does not hold falls back to the community
   * gate, the safer read. */
  entriesByKey: ReadonlyMap<string, CatalogEntry>
  missingByKey: ReadonlyMap<string, string[]>
```
…
```ts
        {outdated.map(row => (
          <li key={identityKey(row)}>
            <OutdatedRow
              row={row}
              tier={entriesByKey.get(identityKey(row))?.tier ?? 'community'}
              missing={missingByKey.get(identityKey(row)) ?? []}
```

(g) `installedByName` → `installedByKey` (lines 886-894). Before:

```ts
  // Each shelf card looks its installed state up by name; the Installed
  // filter below selects on the same map.
  const installedByName = useMemo(() => {
    const map = new Map<string, ShopInstalledEntry>()
    if (installedState.kind === 'ready') {
      for (const entry of installedState.entries) map.set(entry.name, entry)
    }
    return map
  }, [installedState])
```

After:

```ts
  // Each shelf card looks its installed state up by INSTALL IDENTITY; the
  // Installed filter below selects on the same map. By name, one installed
  // repository marked every same-named card as installed (G-1).
  const installedByKey = useMemo(() => {
    const map = new Map<string, ShopInstalledEntry>()
    if (installedState.kind === 'ready') {
      for (const entry of installedState.entries) map.set(identityKey(entry), entry)
    }
    return map
  }, [installedState])
```

(h) the `installed` filter branch (lines 919-921) and the memo dependency (line 931). Before:

```ts
      if (category === 'installed') {
        if (!installedByName.has(entry.name)) return false
```
…
```ts
  }, [browsable, query, category, installedByName])
```

After:

```ts
      if (category === 'installed') {
        if (!installedByKey.has(entryKey(entry))) return false
```
…
```ts
  }, [browsable, query, category, installedByKey])
```

(i) `tiers` / `sources` / `missingByName` (lines 979-1012) become `entriesByKey` / `missingByKey`. Before:

```ts
  const tiers = useMemo(() => {
    const map = new Map<string, CatalogEntry['tier']>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) map.set(entry.name, entry.tier)
    }
    return map
  }, [catalogState])
  // The same lookup shape for each entry's install source, so a github
  // entry's 40-hex commit renders as the short form everywhere.
  const sources = useMemo(() => {
    const map = new Map<string, CatalogEntry['source']>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) map.set(entry.name, entry.source)
    }
    return map
  }, [catalogState])
```
…
```ts
  const missingByName = useMemo(() => {
    const map = new Map<string, string[]>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) {
        map.set(entry.name, missingPeersOf(catalogState.result.incompatible, entry.name))
      }
    }
    return map
  }, [catalogState])
```

After:

```ts
  // The outdated rows' update gate needs each entry's tier, and the row
  // renders a github commit short — both come off the catalog entry, looked
  // up by install identity. Two name-keyed maps stood here and handed a row
  // its namesake's tier (G-1); one identity-keyed map cannot.
  const entriesByKey = useMemo(() => {
    const map = new Map<string, CatalogEntry>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) map.set(entryKey(entry), entry)
    }
    return map
  }, [catalogState])
```
…
```ts
  const missingByKey = useMemo(() => {
    const map = new Map<string, string[]>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) {
        map.set(entryKey(entry), missingPeersOf(catalogState.result.incompatible, entryKey(entry)))
      }
    }
    return map
  }, [catalogState])
```

(j) the two render sites (lines 1240-1244 and 1256-1267). The card list's `key={entryKey(entry)}` is already the identity and does not change; its two lookups do. Before:

```ts
              <li key={entryKey(entry)}>
                <EntryCard entry={entry} stars={starsOf(entry, stars)} installed={installedByName.get(entry.name)} missing={missingByName.get(entry.name) ?? []} t={t} install={install} installStatus={installStatus} uninstall={uninstall} restart={restart} restartSupported={restartSupported} setEnabled={setEnabled} />
```
…
```ts
      <OutdatedSection
        state={installedState}
        tiers={tiers}
        sources={sources}
        missingByName={missingByName}
```

After:

```ts
              <li key={entryKey(entry)}>
                <EntryCard entry={entry} stars={starsOf(entry, stars)} installed={installedByKey.get(entryKey(entry))} missing={missingByKey.get(entryKey(entry)) ?? []} t={t} install={install} installStatus={installStatus} uninstall={uninstall} restart={restart} restartSupported={restartSupported} setEnabled={setEnabled} />
```
…
```ts
      <OutdatedSection
        state={installedState}
        entriesByKey={entriesByKey}
        missingByKey={missingByKey}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/ShopTab.client.spec.tsx tests/client/present.test.ts` and `npx tsc -p tsconfig.test.json --noEmit` — Expected: PASS and clean, the two working-tree badge tests (`sits the badge to the right of the Install button…`, `…of the Update button on the installed-list row`) included: the badge still follows the button inside `InstallPanel`'s idle fragment, which this task does not touch.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/ShopTab.tsx packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx
git commit -m "fix(client): key every entry lookup by install identity (G-1)"
```

---

### Task 9: One catalog load at boot, not two

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:296-311` (state), `:576-615` (`catalog`), `:628-634` (`install` lazy load), `:763-769` (`installed` lazy load), `:855-861` (`uninstall` lazy load)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `private loadCatalogOnce(refresh: boolean): Promise<CatalogResult>` and `private snapshotNow(): Promise<CatalogSnapshot>`; Task 12's tests reach the loader through `catalog()` as before.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/index.test.ts`:

```ts
describe('concurrent catalog loads (G-7)', () => {
  const entries: CatalogEntry[] = [{
    name: 'dsh-one', version: '2.0.0', integrity: null, publishedAt: null, repository: null,
    license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
  }]

  it('loads once when catalog() and installed() are called together on a cold cache', async () => {
    // The client warms `catalog`, `installed` and `version` at boot. With no
    // snapshot yet, `installed()` saw `lastSnapshot === null` while
    // `catalog()`'s load was still in flight and started a SECOND one: two
    // origin races and two ~1.5 MB downloads.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-once-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: { 'dsh-one': '^1.0.0' } }))
    let loadCalls = 0
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { release = resolve })
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => {
        loadCalls += 1
        await gate
        return { snapshot: { schemaVersion: 6, builtAt: '', entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    const both = Promise.all([gateway.catalog({}), gateway.installed()])
    await vi.waitFor(() => expect(loadCalls).toBeGreaterThan(0))
    release?.()
    const [, installed] = await both
    expect(loadCalls).toBe(1)
    expect(installed).toHaveLength(1)
  })

  it('still re-asks the loader after a failed load', async () => {
    // The memo must not hand a rejected load to every later caller.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-once-fail-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    let loadCalls = 0
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async () => {
        loadCalls += 1
        if (loadCalls === 1) throw new Error('offline')
        return { snapshot: { schemaVersion: 6, builtAt: '', entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    await expect(gateway.catalog({})).rejects.toThrow('offline')
    await expect(gateway.catalog({})).resolves.toMatchObject({ schemaVersion: 6 })
    expect(loadCalls).toBe(2)
  })

  it('a refresh always reaches the loader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-once-refresh-'))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const seen: Array<boolean | undefined> = []
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir: dir,
      loadCatalog: async (options) => {
        seen.push(options.refresh)
        return { snapshot: { schemaVersion: 6, builtAt: '', entries, denied: [], stars: {} }, stale: false } as CatalogResult
      },
    })
    await gateway.catalog({})
    await gateway.catalog({ refresh: true })
    expect(seen).toEqual([false, true])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/index.test.ts -t "loads once when catalog() and installed()"` — Expected: FAIL with `expected 2 to be 1` (`loadCalls`).

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/index.ts`, add the field beside `lastSnapshot` (after line 298):

```ts
  /** The catalog load that is currently in flight, memoised so the client's
   * three boot-time warms share one. `installed()` and `install()` used to
   * see `lastSnapshot === null` while `catalog()`'s load was still running
   * and start their own — two origin races and two bulk downloads on a cold
   * cache (G-7). Cleared when it settles, either way. */
  private inFlightLoad: Promise<CatalogResult> | null = null
```

and add the two helpers directly below `originsFor` (after line 554):

```ts
  /** Load the catalog, joining an in-flight load rather than starting a
   * second. A `refresh` always reaches the loader — it is the user asking
   * for the network — and becomes the load a concurrent plain caller joins,
   * since a fresher answer is never worse. */
  private loadCatalogOnce(refresh: boolean): Promise<CatalogResult> {
    const existing = this.inFlightLoad
    if (!refresh && existing !== null) return existing
    const { catalogUrl, cacheDir } = this.rowConfig()
    const load = this.options.loadCatalog ?? loadCatalog
    const started = load({ origins: this.originsFor(catalogUrl), cacheDir, refresh })
      .then((result) => {
        this.lastSnapshot = result.snapshot
        return result
      })
    this.inFlightLoad = started
    const forget = (): void => {
      if (this.inFlightLoad === started) this.inFlightLoad = null
    }
    // Both arms: a rejected load must not be handed to every later caller,
    // and a settled one has already put its snapshot in `lastSnapshot`.
    started.then(forget, forget)
    return started
  }

  /** The snapshot the install gate runs against: the last loaded one, or one
   * load if nothing has been loaded yet (§7.2 — never a fresh fetch per
   * request). */
  private async snapshotNow(): Promise<CatalogSnapshot> {
    if (this.lastSnapshot !== null) return this.lastSnapshot
    const { snapshot } = await this.loadCatalogOnce(false)
    return snapshot
  }
```

Replace the load in `catalog()` (lines 578-581). Before:

```ts
    const { catalogUrl, cacheDir } = this.rowConfig()
    const load = this.options.loadCatalog ?? loadCatalog
    const { snapshot, stale } = await load({ origins: this.originsFor(catalogUrl), cacheDir, refresh: args?.refresh ?? false })
    this.lastSnapshot = snapshot
```

After:

```ts
    const { snapshot, stale } = await this.loadCatalogOnce(args?.refresh ?? false)
```

Replace each of the three identical lazy-load blocks — in `install()` (lines 629-634), `installed()` (lines 764-769) and `uninstall()` (lines 856-861). Before (each):

```ts
    if (this.lastSnapshot === null) {
      const { catalogUrl, cacheDir } = this.rowConfig()
      const load = this.options.loadCatalog ?? loadCatalog
      const { snapshot } = await load({ origins: this.originsFor(catalogUrl), cacheDir })
      this.lastSnapshot = snapshot
    }
```

After (each):

```ts
    await this.snapshotNow()
```

`this.lastSnapshot` is set by then, so the `null` narrowing each method already performs below is unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/index.test.ts` — Expected: PASS, including `lazily loads the catalog when installed() is called without a prior catalog()` (`index.test.ts:491`) and `…when uninstall() is called…` (`:577`), which still see exactly one load.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "fix(host): memoise the in-flight catalog load so boot fetches it once (G-7)"
```

---

### Task 10: A package named `constructor` cannot read the prototype for its star count

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts:301-317` (`starsOf`)
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts:219-233` (`parseStarsText`)
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`, `packages/dsh-plugin-shop/tests/host/catalog.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/client/present.test.ts`:

```ts
describe('starsOf against a prototype-bearing map (G-8)', () => {
  // `constructor`, `toString` and `valueOf` are all legal npm package names,
  // and the stars map crosses the wire as an ordinary JSON object — so a
  // plain index read answered with `Object.prototype`'s member: `starsOf`
  // returned a FUNCTION, `formatStars` rendered `NaNk`, and the NaN
  // comparator sorted the entry first, at the top of the shelf.
  for (const name of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    it(`answers undefined for an entry named ${name}`, () => {
      expect(starsOf({ ...entry, name }, {})).toBeUndefined()
    })
  }

  it('still reads a real count for such a name', () => {
    expect(starsOf({ ...entry, name: 'constructor' }, { constructor: 12 })).toBe(12)
  })

  it('does not sort a prototype-named entry to the top of the shelf', () => {
    const proto = { ...entry, name: 'constructor' }
    const real = { ...entry, name: 'dsh-real' }
    expect(sortByStars([proto, real], { 'dsh-real': 5 }).map(e => e.name)).toEqual(['dsh-real', 'constructor'])
  })
})
```

and append to `packages/dsh-plugin-shop/tests/host/catalog.test.ts`:

```ts
describe('the stars sidecar carries no prototype (G-8)', () => {
  it('hands the client a null-prototype map', async () => {
    const data = dataJson([entry])
    const stars = starsFile({ 'dsh-hello-plugin': 7 })
    const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', { url: stars.url, sha256: stars.sha256 })
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/index.json')) return new Response(pointer, { status: 200 })
      if (url.endsWith(stars.url)) return new Response(stars.text, { status: 200 })
      return new Response(data, { status: 200 })
    }) as unknown as typeof fetch
    const result = await loadCatalog({ baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs() })
    expect(result.snapshot.stars['dsh-hello-plugin']).toBe(7)
    expect(Object.getPrototypeOf(result.snapshot.stars)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/present.test.ts -t "prototype-bearing map" tests/host/catalog.test.ts -t "carries no prototype"` — Expected: FAIL — `expected [Function: Object] to be undefined` for the `constructor` case, and `expected Object.prototype to be null` for the sidecar.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/client/present.ts`, replace `starsOf`'s body (lines 315-317). Before:

```ts
export function starsOf(entry: CatalogEntry, stars: Record<string, number>): number | undefined {
  return stars[entry.repo ?? entry.name]
}
```

After:

```ts
export function starsOf(entry: CatalogEntry, stars: Record<string, number>): number | undefined {
  const key = entry.repo ?? entry.name
  // `Object.hasOwn`, not a plain index read: the map arrives over the RPC as
  // an ordinary object, and `constructor`, `toString` and `valueOf` are all
  // legal package names. A plain read answered with Object.prototype's
  // member — a function — which `formatStars` rendered `NaNk` and the
  // comparator sorted to the top of the shelf (G-8).
  if (!Object.hasOwn(stars, key)) return undefined
  return stars[key]
}
```

In `packages/dsh-plugin-shop/src/host/catalog.ts`, give the parsed map a null prototype (line 225). Before:

```ts
    const out: Record<string, number> = {}
```

After:

```ts
    // Null prototype: the sidecar's keys are package names and repo full
    // names from npm and GitHub, and `constructor` is a legal one. Belt and
    // braces beside `starsOf`'s `Object.hasOwn` — the client's copy of this
    // object is rebuilt by JSON and loses the prototype, so both ends need
    // their own guard (G-8).
    const out: Record<string, number> = Object.create(null) as Record<string, number>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/present.test.ts tests/host/catalog.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/tests/client/present.test.ts packages/dsh-plugin-shop/tests/host/catalog.test.ts
git commit -m "fix: a prototype-named package cannot borrow Object.prototype for its stars (G-8)"
```

---

### Task 11: Every catalog body read is capped and converted to a `TransportError`

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/origin.ts:19-27` (`OriginHandle.file`), `:52-89` (`httpOrigin`), plus two new exports
- Test: `packages/dsh-plugin-shop/tests/host/origin.test.ts`, `packages/dsh-plugin-shop/tests/host/catalog.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `MAX_BODY_BYTES`, `readCappedBytes(response, label, maxBytes?): Promise<Buffer>`, `readCappedText(response, label, maxBytes?): Promise<string>`, and `OriginHandle.file(url, signal?)`. Tasks 12 and 13 both consume all four.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/origin.test.ts`:

```ts
import { MAX_BODY_BYTES } from '../../src/host/origin.ts'

/** A 200 whose body delivers `head` and then errors, the shape a stream that
 * truncates or resets mid-download takes at the fetch layer. A local server
 * that destroys the socket produces the same rejection; this needs no port
 * and settles deterministically. */
function dying(head: Uint8Array): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head)
      controller.error(new TypeError('terminated'))
    },
  }), { status: 200 })
}

describe('httpOrigin body reads (G-3, F-2/G-10)', () => {
  it('converts a body that dies mid-stream into a TransportError', async () => {
    // The body read sat OUTSIDE the conversion, so `TypeError: terminated`
    // escaped the race loop and threw past a valid on-disk cache instead of
    // degrading to it — which this module's own header promises.
    const fetchImpl = (async (input: string | URL) =>
      String(input).endsWith('index.json') ? ok('{}') : dying(new Uint8Array(10))) as unknown as typeof fetch
    const handle = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal)
    const failure = await handle.file('plugins.abc.json').catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/body read failed/)
  })

  it('converts a pointer body that dies mid-stream the same way', async () => {
    const fetchImpl = (async () => dying(new Uint8Array(10))) as unknown as typeof fetch
    await expect(httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal))
      .rejects.toBeInstanceOf(TransportError)
  })

  it('refuses a body over the cap instead of buffering it', async () => {
    const over = new Uint8Array(64)
    const fetchImpl = (async (input: string | URL) =>
      String(input).endsWith('index.json') ? ok('{}') : new Response(over, { status: 200 })) as unknown as typeof fetch
    const handle = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal)
    // The cap is exercised at a test-sized value through the exported reader;
    // the 64 MiB production value is asserted below rather than allocated.
    const failure = await readCappedText(new Response(over, { status: 200 }), 'probe', 32).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/exceeded the 32-byte cap/)
    // And the same origin serves a body under the cap unchanged.
    expect(await handle.file('plugins.abc.json')).toHaveLength(64)
  })

  it('refuses a 2xx with no body at all', async () => {
    const fetchImpl = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch
    const failure = await httpOrigin('https://shop.test/v1/', fetchImpl).probe(new AbortController().signal).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/returned no body/)
  })

  it('caps catalog bodies at 64 MiB, the same number verifyTarballSha256 uses', () => {
    expect(MAX_BODY_BYTES).toBe(64 * 1024 * 1024)
  })
})
```

(the file's existing `import { TransportError, httpOrigin, resolveDataUrl }` gains `readCappedText`.)

Append to `packages/dsh-plugin-shop/tests/host/catalog.test.ts`:

```ts
describe('a truncated body degrades to the cache (G-3)', () => {
  it('serves the cached snapshot when the data body dies after ten bytes', async () => {
    const data = dataJson([entry])
    const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
    const fs = memFs()
    fs.write('/cache/index.json', pointer)
    fs.write(`/cache/${url}`, data)
    const fetchImpl = (async (input: string | URL) => {
      if (String(input).endsWith('/index.json')) return new Response(pointer, { status: 200 })
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(10))
          controller.error(new TypeError('terminated'))
        },
      }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await loadCatalog({
      baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: fs,
      now: () => new Date('2026-09-01T00:00:00Z'),
    })
    // Before the fix this threw a raw `TypeError: terminated` with a valid
    // cache sitting right there.
    expect(result.stale).toBe(true)
    expect(result.snapshot.entries[0]?.name).toBe('dsh-hello-plugin')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/origin.test.ts tests/host/catalog.test.ts -t "degrades to the cache"` — Expected: FAIL — `readCappedText` is not exported (`does not provide an export named 'readCappedText'`), and the catalog case rejects with `TypeError: terminated` instead of resolving.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/origin.ts`, change `OriginHandle.file` (lines 23-26). Before:

```ts
  /** One file named by the pointer, by the pointer's own raw url string.
   * Callers pass that string verbatim — never a basename, which would strip
   * a hostile absolute url into a fetchable relative one. */
  file: (url: string) => Promise<string>
```

After:

```ts
  /** One file named by the pointer, by the pointer's own raw url string.
   * Callers pass that string verbatim — never a basename, which would strip
   * a hostile absolute url into a fetchable relative one.
   *
   * `signal`, when given, bounds the transfer: `catalog.ts` hands over the
   * commit budget's signal, because this call is the one bulk fetch that sat
   * outside every budget and parked the whole load (G-2). */
  file: (url: string, signal?: AbortSignal) => Promise<string>
```

Add the two readers after `resolveDataUrl` (after line 49):

```ts
/** The largest catalog body this build reads into memory. The live
 * `plugins.json` is 6.5 MB uncompressed (1.48 MB gzipped on the wire), so
 * this is headroom rather than a gate — and it is deliberately the same
 * number as `verifyTarballSha256`'s `MAX_TARBALL_BYTES`, so the package's
 * bulk readers answer to one figure. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024

/**
 * Read a response body through a byte cap, converting every failure into a
 * `TransportError`.
 *
 * `fetch` resolves its Response as soon as the HEADERS arrive, so the body is
 * where a truncated or reset stream actually fails — and the body read sat
 * OUTSIDE the conversion, so a `TypeError: terminated` escaped the race loop
 * and threw past a valid on-disk cache instead of degrading to it (G-3).
 * `npm-origin.ts:254-265` already handled exactly this case for the tarball;
 * this is that shape, plus the cap the 260 KB gzip bomb asked for
 * (F-2/G-10).
 */
export async function readCappedBytes(
  response: Response,
  label: string,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<Buffer> {
  if (response.body === null) {
    // A 2xx with no body at all is an origin failing to speak the protocol,
    // not corrupt content: it falls through to the next origin.
    throw new TransportError(`${label} returned no body`)
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        try {
          // Close the connection the cap was protecting; nothing past the cap
          // is ever read.
          await reader.cancel()
        } catch {
          // The stream already closed or errored; the cap verdict stands.
        }
        throw new TransportError(`${label} exceeded the ${maxBytes}-byte cap`)
      }
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    if (error instanceof TransportError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new TransportError(`${label} body read failed: ${detail}`, { cause: error })
  }
  return Buffer.concat(chunks)
}

/** The same capped read, decoded as UTF-8 — what every catalog file is. */
export async function readCappedText(
  response: Response,
  label: string,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<string> {
  return (await readCappedBytes(response, label, maxBytes)).toString('utf8')
}
```

Replace the two reads in `httpOrigin` (lines 68 and 75-86). Before:

```ts
      if (!response.ok) throw new TransportError(`catalog pointer returned ${response.status} for ${id}`)
      const pointerText = await response.text()
```

After:

```ts
      if (!response.ok) throw new TransportError(`catalog pointer returned ${response.status} for ${id}`)
      const pointerText = await readCappedText(response, `catalog pointer fetch for ${id}`)
```

Before:

```ts
        file: async (url) => {
          const resolved = resolveDataUrl(baseUrl, url)
          let dataResponse: Response
          try {
            dataResponse = await fetchImpl(resolved)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new TransportError(`catalog data fetch failed for ${id}: ${detail}`, { cause: error })
          }
          if (!dataResponse.ok) throw new TransportError(`catalog data returned ${dataResponse.status} for ${id}`)
          return dataResponse.text()
        },
```

After:

```ts
        file: async (url, signal) => {
          const resolved = resolveDataUrl(baseUrl, url)
          let dataResponse: Response
          try {
            dataResponse = await fetchImpl(resolved, signal === undefined ? undefined : { signal })
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new TransportError(`catalog data fetch failed for ${id}: ${detail}`, { cause: error })
          }
          if (!dataResponse.ok) throw new TransportError(`catalog data returned ${dataResponse.status} for ${id}`)
          return readCappedText(dataResponse, `catalog data fetch for ${id}`)
        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/origin.test.ts tests/host/catalog.test.ts tests/host/transport-parity.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/origin.ts packages/dsh-plugin-shop/tests/host/origin.test.ts packages/dsh-plugin-shop/tests/host/catalog.test.ts
git commit -m "fix(host): cap every catalog body read and convert it to a TransportError (G-3, F-2/G-10)"
```

---

### Task 12: The commit budget covers — and aborts — every bulk read

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts:38-58` (`withCommitTimeout` → `withCommitBudget`), `:370-372` (pointer call), `:392-398` (data call), `:416-433` (stars call)
- Test: `packages/dsh-plugin-shop/tests/host/catalog.test.ts`

**Interfaces:**
- Consumes: `OriginHandle.file(url, signal?)` (Task 11).
- Produces: `withCommitBudget(id, what, start)` (module-private); no exported change.

- [ ] **Step 1: Write the failing test**

In `packages/dsh-plugin-shop/tests/host/catalog.test.ts`, extend the `fakeOrigin` helper (lines 676-713) with two hanging modes:

```ts
    /** Never settles on the DATA file — the bulk fetch that happens AFTER
     * the race has committed, which no budget covered (G-2). */
    dataHangs?: boolean
    /** Never settles on the stars sidecar, the second uncovered read. */
    starsHangs?: boolean
```

and inside the returned handle's `file`:

```ts
          file: async (url) => {
            if (opts.dataHangs === true && url.startsWith('plugins.')) return new Promise<string>(() => {})
            if (opts.starsHangs === true && url.startsWith('stars.')) return new Promise<string>(() => {})
            if (opts.dataFails === 'transport') throw new TransportError(`${id} data down`)
            if (opts.dataFails === 'loud') throw new Error(`${id} data corrupt`)
            return opts.data ?? ''
          },
```

Then append:

```ts
describe('the commit budget covers the bulk reads (G-2)', () => {
  const entry = {
    name: 'dsh-hello-plugin', version: '1.2.0', integrity: 'sha512-i', publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
    added: '2026-08-25',
  }

  it('degrades to the cache when the committed origin answers the pointer and never the data file', async () => {
    // The reproduction: a server that answers `index.json` and never the data
    // file left `catalog()` pending after 45 s, past both the 10 s probe and
    // the 30 s commit budgets — and the client's boot warm then held a
    // never-settling promise every plain open awaited.
    vi.useFakeTimers()
    try {
      const data = dataJson([entry])
      const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
      const fs = memFs()
      fs.files.set('/cache/index.json', pointer)
      fs.files.set(`/cache/${url}`, data)
      const pending = loadCatalog({
        cacheDir: '/cache', fsImpl: fs,
        now: () => new Date('2026-09-01T00:00:00Z'),
        origins: [fakeOrigin('stalls-on-data', { delay: 0, pointer, dataHangs: true })],
      })
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await pending
      expect(result.stale).toBe(true)
      expect(result.snapshot.entries).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('throws, naming the budget, when the data file stalls and there is no cache', async () => {
    vi.useFakeTimers()
    try {
      const data = dataJson([entry])
      const { pointer, url } = pointerFor(data, '2026-08-25T00:00:00Z')
      const pending = loadCatalog({
        cacheDir: '/cache', fsImpl: memFs(),
        origins: [fakeOrigin('stalls-on-data', { delay: 0, pointer, dataHangs: true })],
      })
      const settled = pending.catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(30_000)
      const failure = await settled
      expect(String(failure)).toMatch(new RegExp(`did not serve ${url.replace(/\./g, '\\.')} within 30000 ms`))
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes with no stars when the sidecar stalls', async () => {
    // Stars are advisory (spec §5); a stalled sidecar must not park a load
    // whose data file arrived.
    vi.useFakeTimers()
    try {
      const data = dataJson([entry])
      const stars = starsFile({ 'dsh-hello-plugin': 7 })
      const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z', { url: stars.url, sha256: stars.sha256 })
      const pending = loadCatalog({
        cacheDir: '/cache', fsImpl: memFs(),
        origins: [fakeOrigin('stalls-on-stars', { delay: 0, pointer, data, starsHangs: true })],
      })
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await pending
      expect(result.snapshot.entries).toHaveLength(1)
      expect(result.snapshot.stars).toEqual({})
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the data fetch itself, not merely the wait', async () => {
    // A budget that only stops WAITING leaves the socket open and the body
    // downloading; the signal is what actually ends it. Built from a
    // setTimeout-driven controller rather than `AbortSignal.timeout`, which
    // fake timers do not drive.
    vi.useFakeTimers()
    try {
      const data = dataJson([entry])
      const { pointer } = pointerFor(data, '2026-08-25T00:00:00Z')
      let aborted = false
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        if (String(input).endsWith('/index.json')) return new Response(pointer, { status: 200 })
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('aborted'))
          })
        })
      }) as unknown as typeof fetch
      const settled = loadCatalog({
        baseUrl: 'https://shop.test/v1/', cacheDir: '/cache', fetchImpl, fsImpl: memFs(),
      }).catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
      expect(aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/catalog.test.ts -t "the commit budget covers the bulk reads"` — Expected: FAIL — the first three cases time out (`Test timed out in 5000ms`) because nothing bounds `handle.file`, and the fourth reports `expected false to be true`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/catalog.ts`, replace `withCommitTimeout` (lines 38-58). Before:

```ts
/** Reject with a TransportError if `work` outlives `COMMIT_TIMEOUT_MS`. The
 * underlying fetch is left to finish or fail on its own and its result is
 * discarded: aborting it would need a signal threaded through OriginHandle,
 * and a stalled origin we have already abandoned costs nothing but its own
 * socket. */
async function withCommitTimeout<T>(work: Promise<T>, id: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new TransportError(`${id} did not produce a pointer within ${COMMIT_TIMEOUT_MS} ms`)),
          COMMIT_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
```

After:

```ts
/**
 * Run one bulk read of the committed origin under `COMMIT_TIMEOUT_MS`, and
 * abort the read itself when the budget expires.
 *
 * This used to wrap `pointer()` alone, so `handle.file()` — the OTHER bulk
 * fetch, the ~1.5 MB data file — ran with no signal and outside every
 * budget: a server that answered `index.json` and never the data file left
 * `catalog()` pending past 45 s, and the client's boot warm then held a
 * never-settling promise that every plain open awaited (G-2).
 *
 * The signal is handed to the read rather than merely raced against, so the
 * socket the budget was protecting actually closes. Built on `setTimeout`
 * (not `AbortSignal.timeout`) because that is the clock a test can drive.
 */
async function withCommitBudget<T>(
  id: string,
  what: string,
  start: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      start(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const expired = new TransportError(`${id} did not ${what} within ${COMMIT_TIMEOUT_MS} ms`)
          controller.abort(expired)
          reject(expired)
        }, COMMIT_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
```

Replace the pointer call (line 371). Before:

```ts
      pointerText = await withCommitTimeout(settled.value.pointer(), settled.value.id)
```

After:

```ts
      pointerText = await withCommitBudget(settled.value.id, 'produce a pointer', () => settled.value.pointer())
```

Replace the data call (line 394). Before:

```ts
    dataText = await handle.file(pointer.plugins.url)
```

After:

```ts
    dataText = await withCommitBudget(handle.id, `serve ${pointer.plugins.url}`, signal => handle.file(pointer.plugins.url, signal))
```

Replace the stars call (line 423). Before:

```ts
      const starsText = await handle.file(pointer.stars.url)
```

After:

```ts
      // Advisory, and budgeted for the same reason as the data file: a
      // stalled sidecar must not park a load whose catalog already arrived.
      const starsText = await withCommitBudget(handle.id, `serve ${pointer.stars.url}`, signal => handle.file(pointer.stars.url!, signal))
```

`pointer.stars` is narrowed by the enclosing `if (pointer.stars !== undefined)`, but the arrow function reopens it, so bind it first instead of asserting — replace the whole `if` body's head (line 417) with:

```ts
  if (pointer.stars !== undefined) {
    const sidecar = pointer.stars
```

and use `sidecar.url` / `sidecar.sha256` inside, so the read reads:

```ts
      const starsText = await withCommitBudget(handle.id, `serve ${sidecar.url}`, signal => handle.file(sidecar.url, signal))
      const starsActual = createHash('sha256').update(starsText).digest('hex')
      if (starsActual === sidecar.sha256) {
        stars = parseStarsText(starsText)
        fsImpl.write(join(cacheDir, basename(sidecar.url)), starsText)
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/catalog.test.ts` — Expected: PASS, including `falls through to a healthy origin when the committed winner stalls past the commit budget` (`catalog.test.ts:758`), whose message wording is preserved by the `'produce a pointer'` argument.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/tests/host/catalog.test.ts
git commit -m "fix(host): budget and abort every bulk catalog read, not just the pointer (G-2)"
```

---

### Task 13: The npm tarball is bounded on the wire and at inflate

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/npm-origin.ts:8-12` (imports), `:126-200` (`load`), `:202-229` (`read`/`file`)
- Test: `packages/dsh-plugin-shop/tests/host/npm-origin.test.ts`

**Interfaces:**
- Consumes: `readCappedBytes`, `MAX_BODY_BYTES` (Task 11).
- Produces: `MAX_PACKAGE_BYTES`, `MAX_INFLATED_BYTES` (exported for the test's fixture arithmetic).

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/npm-origin.test.ts` (its imports gain `MAX_INFLATED_BYTES, MAX_PACKAGE_BYTES` from `npm-origin.ts`), and replace the existing mid-download fixture:

```ts
describe('npmOrigin body bounds (F-2 / G-10)', () => {
  it('refuses a tarball that inflates past the cap, with the cap named', () => {
    // Measured: 260,934 gzip bytes inflated to 268,435,456 (ratio 1029:1),
    // RSS +518 MB. `verifyIntegrity` runs first and cannot help — a raced
    // mirror computes `dist.integrity` over the bomb, so the digest matches.
    // Zeros compress ~1000:1, which is the same shape at fixture cost.
    const bomb = gzipSync(Buffer.alloc(MAX_INFLATED_BYTES + 1))
    const integrity = `sha512-${createHash('sha512').update(bomb).digest('base64')}`
    return npmOrigin('https://reg.test/', 'c', registry({ tarball: bomb, integrity })).probe(signal())
      .then(handle => handle.pointer())
      .then(() => { throw new Error('the bomb was inflated') }, (failure: unknown) => {
        expect(failure).toBeInstanceOf(TransportError)
        expect(String(failure)).toMatch(/inflates past the/)
        expect(String(failure)).toMatch(String(MAX_INFLATED_BYTES))
      })
  })

  it('refuses a tarball body over the wire cap before it is ever hashed', async () => {
    const oversized = Buffer.alloc(MAX_PACKAGE_BYTES + 1)
    const handle = await npmOrigin('https://reg.test/', 'c',
      registry({ tarball: oversized, integrity: INTEGRITY })).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/exceeded the/)
  })

  it('caps a package tarball at 32 MiB on the wire and 64 MiB inflated', () => {
    // The published catalog package is 4,174,769 bytes and its `v1/` tree is
    // 6.5 MB uncompressed (2026-09-01-catalog-mirrors §1), so both caps are
    // headroom rather than gates.
    expect(MAX_PACKAGE_BYTES).toBe(32 * 1024 * 1024)
    expect(MAX_INFLATED_BYTES).toBe(64 * 1024 * 1024)
  })
})
```

and replace the body of `raises TransportError when the tarball body dies mid-download` (lines 225-248) — the hand-built `{ ok, status, arrayBuffer }` object has no `body`, and the reader is now streamed, so the fixture becomes a real Response whose stream errors:

```ts
  it('raises TransportError when the tarball body dies mid-download', async () => {
    // fetch resolves its Response as soon as the headers arrive, so a
    // truncated or reset stream rejects at the BODY read, not at the fetch
    // call — which was wrapped while the body read next to it was not (item
    // C, 2026-09 review). The purest transport failure of the set.
    const truncating = (async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/latest')) {
        return new Response(JSON.stringify({
          version: '2026.901.0',
          dist: { tarball: 'https://reg.test/c/-/c-1.tgz', integrity: INTEGRITY },
        }), { status: 200 })
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x1f, 0x8b]))
          controller.error(new TypeError('fetch failed'))
        },
      }), { status: 200 })
    }) as unknown as typeof fetch
    const handle = await npmOrigin('https://reg.test/', 'c', truncating).probe(signal())
    const failure = await handle.pointer().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(TransportError)
    expect(String(failure)).toMatch(/tarball body read failed/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/npm-origin.test.ts -t "npmOrigin body bounds"` — Expected: FAIL — the bomb case throws `Error: the bomb was inflated` (the 64 MiB inflate succeeds), and `MAX_INFLATED_BYTES` is not exported.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/npm-origin.ts`, change the origin import (line 12) and add the caps below `PACKAGE_ROOT` (after line 22):

```ts
import { type CatalogOrigin, type OriginHandle, TransportError, readCappedBytes } from './origin.ts'
```

```ts
/** How many bytes of package tarball this build will read from a registry.
 * The published catalog package is 4,174,769 bytes (2026-09-01-catalog-mirrors
 * §1), so this is ~8× headroom. A body over it is refused before it is
 * hashed, let alone inflated. */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024

/** How many bytes that tarball may inflate to. The package's whole `v1/`
 * tree is about 6.5 MB uncompressed, so this is ~10× headroom — and it is
 * the bound that matters: a 260 KB body inflated to 268 MB and took RSS up
 * by 518 MB, and `dist.integrity` cannot catch it because a raced mirror
 * computes the digest over the bomb (F-2/G-10). */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024
```

Thread a signal through `load` and `read`, replace the buffered body read, and bound the inflate. Before (lines 127, 154-175, 191-199):

```ts
      const load = async (): Promise<Map<string, Buffer>> => {
        if (files !== null) return files
```
…
```ts
        let tarballResponse: Response
        try {
          tarballResponse = await fetchImpl(tarballUrl.href)
        } catch (error) {
```
…
```ts
        let bytes: Buffer
        try {
          bytes = Buffer.from(await tarballResponse.arrayBuffer())
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new TransportError(`npm origin ${registryUrl} tarball body read failed: ${detail}`, { cause: error })
        }
```
…
```ts
        let parsed: Map<string, Buffer>
        try {
          parsed = readTar(gunzipSync(bytes))
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new TransportError(`npm origin ${registryUrl} served an unparsable tarball: ${detail}`, { cause: error })
        }
        files = parsed
        return files
      }
```

After:

```ts
      const load = async (signal?: AbortSignal): Promise<Map<string, Buffer>> => {
        if (files !== null) return files
```
…
```ts
        let tarballResponse: Response
        try {
          tarballResponse = await fetchImpl(tarballUrl.href, signal === undefined ? undefined : { signal })
        } catch (error) {
```
…
```ts
        // Streamed through the wire cap rather than buffered whole: an
        // `arrayBuffer()` read has no bound at all, and the body is
        // attacker-chosen (every raced npm origin — npmjs, npmmirror, and any
        // `registry=` from ~/.npmrc — is a source). `readCappedBytes` already
        // converts a mid-stream failure, a bodyless 2xx and an over-cap body
        // into attributed TransportErrors.
        const bytes = await readCappedBytes(
          tarballResponse,
          `npm origin ${registryUrl} tarball`,
          MAX_PACKAGE_BYTES,
        )
```
…
```ts
        let parsed: Map<string, Buffer>
        try {
          // `maxOutputLength` is the bound that matters: 260 KB of gzip
          // inflated to 268 MB before it. zlib refuses over the cap with
          // ERR_BUFFER_TOO_LARGE, which gets its own truthful detail below —
          // "unparsable" would be a lie about an oversized-but-valid archive.
          parsed = readTar(gunzipSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES }))
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ERR_BUFFER_TOO_LARGE' || /larger than/.test(detail)) {
            throw new TransportError(
              `npm origin ${registryUrl}: the tarball inflates past the ${MAX_INFLATED_BYTES}-byte cap; refusing to read it`,
              { cause: error },
            )
          }
          throw new TransportError(`npm origin ${registryUrl} served an unparsable tarball: ${detail}`, { cause: error })
        }
        files = parsed
        return files
      }
```

Then pass the signal on through `read` and `file` (lines 202-229). Before:

```ts
      const read = async (name: string): Promise<string> => {
        const entry = (await load()).get(`${PACKAGE_ROOT}${name}`)
```
…
```ts
        file: async (url) => {
          if (url.includes('/') || url.startsWith('.')) {
            throw new Error(`npm origin ${registryUrl}: ${JSON.stringify(url)} must be a plain file name`)
          }
          return read(url)
        },
```

After:

```ts
      const read = async (name: string, readSignal?: AbortSignal): Promise<string> => {
        const entry = (await load(readSignal)).get(`${PACKAGE_ROOT}${name}`)
```
…
```ts
        file: async (url, fileSignal) => {
          if (url.includes('/') || url.startsWith('.')) {
            throw new Error(`npm origin ${registryUrl}: ${JSON.stringify(url)} must be a plain file name`)
          }
          return read(url, fileSignal)
        },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/npm-origin.test.ts tests/host/catalog.test.ts tests/host/transport-parity.test.ts` — Expected: PASS, including `raises TransportError when the tarball body is not gzip at all`, whose `/unparsable tarball/` assertion the code-branching above preserves.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/npm-origin.ts packages/dsh-plugin-shop/tests/host/npm-origin.test.ts
git commit -m "fix(host): cap the npm tarball on the wire and at inflate (F-2/G-10)"
```

---

### Task 14: A spawned install has a deadline and dies with its process group

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts:6` (import), `:25-26` (constants), `:186-208` (options), `:256-325` (the spawn and settle), `:333-352` and `:361-380` (forward `timeoutMs`)
- Test: `packages/dsh-plugin-shop/tests/host/executor.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `installTimeoutDetail(profile, timeoutMs): string`, `killTree(pid, platform, kills?)`, `KillFns`, and `timeoutMs?: number` on `startInstall`/`startUninstall`. Task 15 edits the same settle path.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/executor.test.ts` (its imports gain `installTimeoutDetail, killTree` from `executor.ts`):

```ts
describe('the install deadline and the process group (F-1)', () => {
  /** A fake dsh that leaves a grandchild holding the inherited stdout and
   * exits at once. The probe from the audit: `state=running` for 4 s after
   * `dsh` itself had exited at 0 ms, because completion waited on `close`,
   * which fires only when EVERY holder of the pipe has exited. */
  function grandchildDsh(sleepSeconds: number): { bin: string; pidFile: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-grandchild-'))
    const pidFile = join(dir, 'grandchild.pid')
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      'echo "installing..."',
      `sleep ${sleepSeconds} &`,
      `echo $! > "${pidFile}"`,
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    return { bin, pidFile }
  }

  it('settles on exit even while a grandchild holds the pipe', async () => {
    const { bin, pidFile } = grandchildDsh(20)
    const started = Date.now()
    const status = await startInstall({ profile: 'grandchild', spec: 'a@1.0.0', dshBin: bin }).finished
    expect(status.state).toBe('done')
    expect(status.log.join('\n')).toContain('installing...')
    // `close` would not have fired for ~20 s.
    expect(Date.now() - started).toBeLessThan(5000)
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim())
    try {
      process.kill(grandchild, 'SIGKILL')
    } catch {
      // Already gone; nothing to clean up.
    }
  })

  it('stops a command that outlives its deadline and frees the profile queue', async () => {
    // With a hung first install, a second sat `running` (queued) at 3 s and
    // only a dsh restart cleared the queue.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-deadline-'))
    const hung = join(dir, 'dsh')
    writeFileSync(hung, [
      '#!/bin/sh',
      'sleep 30 &',
      `echo $! > "${join(dir, 'gpid')}"`,
      'wait',
      '',
    ].join('\n'))
    chmodSync(hung, 0o755)

    const first = startInstall({ profile: 'deadline', spec: 'a@1.0.0', dshBin: hung, timeoutMs: 300 })
    const second = startInstall({ profile: 'deadline', spec: 'b@1.0.0', dshBin: fixtureDsh(0) })

    const firstStatus = await first.finished
    expect(firstStatus.state).toBe('failed')
    expect(firstStatus.detail).toMatch(/did not finish within 1s and was stopped/)
    expect(firstStatus.detail).toMatch(/dsh plugin --profile deadline install/)

    const secondStatus = await second.finished
    expect(secondStatus.state).toBe('done')

    // The grandchild went with the process group, not just `dsh` itself —
    // otherwise `pnpm` keeps rewriting the profile's node_modules.
    const grandchild = Number(readFileSync(join(dir, 'gpid'), 'utf8').trim())
    await vi.waitFor(() => { expect(() => process.kill(grandchild, 0)).toThrow() })
  })

  it('names the deadline rather than blaming pnpm', () => {
    const detail = installTimeoutDetail('web', 900_000)
    expect(detail).toMatch(/did not finish within 900s and was stopped/)
    expect(detail).toMatch(/dsh plugin --profile web install/)
    expect(detail).not.toMatch(/pnpm failed/)
  })
})

describe('killTree', () => {
  it('walks the tree with taskkill on Windows and with the group on POSIX', () => {
    // Windows has no process groups and `taskkill /T` is the tree walk; the
    // branch is testable off Windows because the kills are parameters.
    const calls: string[] = []
    const kills = {
      killGroup: (pid: number) => { calls.push(`group:${pid}`) },
      killPid: (pid: number) => { calls.push(`pid:${pid}`) },
      taskkill: (pid: number) => { calls.push(`taskkill:${pid}`) },
    }
    killTree(4242, 'win32', kills)
    expect(calls).toEqual(['taskkill:4242'])

    calls.length = 0
    killTree(4242, 'linux', kills)
    expect(calls).toEqual(['group:4242'])

    calls.length = 0
    killTree(4242, 'linux', {
      ...kills,
      killGroup: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) },
    })
    expect(calls).toEqual(['pid:4242'])

    calls.length = 0
    killTree(undefined, 'linux', kills)
    expect(calls).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/executor.test.ts -t "the install deadline and the process group"` — Expected: FAIL — the grandchild case exceeds the 5 s bound (`expected 20014 to be less than 5000`), the deadline case times out with the first install still `running`, and `installTimeoutDetail`/`killTree` are not exported.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/executor.ts`, extend the import (line 6) and the constants (after line 26):

```ts
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process'
```

```ts
/** How long one `dsh plugin` command may run before the shop stops it. A
 * cold install of a plugin with a large dependency tree is minutes on a slow
 * link, so this is deliberately generous; what it removes is UNBOUNDED —
 * without it a network stall or a pnpm lock wait kept the install `running`
 * forever and queued every later install, uninstall and self-update for that
 * profile behind it, with no cancel RPC and nothing but a dsh restart to
 * clear it (F-1). */
const INSTALL_TIMEOUT_MS = Number(process.env.DSH_SHOP_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/** How long the pipes get to deliver what the child already wrote, after the
 * child itself has exited. Completion used to be the `close` event, which
 * fires only when every holder of the inherited stdout/stderr has exited —
 * so one `sleep &` grandchild held the record open (measured: 4 s after dsh
 * exited at 0 ms). */
const PIPE_DRAIN_MS = 500
```

Add the detail and the killer above `spawnPluginCli` (after `spawnFailureDetail`, line 165):

```ts
/** The failure detail a stopped command carries. It names the deadline
 * rather than blaming pnpm, because nothing failed — the shop gave up. */
export function installTimeoutDetail(profile: string, timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  return `dsh-plugin-shop: the command did not finish within ${seconds}s and was stopped.`
    + ` Run it yourself to see what it is waiting on: dsh plugin --profile ${profile} install`
}

/** The three kill primitives, as parameters so both platform branches are
 * testable off their own platform. */
export interface KillFns {
  killGroup: (pid: number) => void
  killPid: (pid: number) => void
  taskkill: (pid: number) => void
}

const nodeKills: KillFns = {
  killGroup: pid => process.kill(-pid, 'SIGKILL'),
  killPid: pid => process.kill(pid, 'SIGKILL'),
  // No shell: a fixed binary and a numeric argv, like every other spawn here.
  taskkill: (pid) => { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) },
}

/**
 * Kill a child and everything it spawned.
 *
 * `child.kill()` reaches only the `dsh` process; the `pnpm` it spawned — and
 * whatever pnpm spawned — keeps running and keeps the profile's
 * `package.json`, lockfile and `node_modules` under rewrite. On POSIX the
 * child leads its own process group (`detached`), so `process.kill(-pid)`
 * reaches the group; Windows has no process groups, and `taskkill /T /F`
 * walks the tree instead.
 */
export function killTree(
  pid: number | undefined,
  platform: NodeJS.Platform,
  kills: KillFns = nodeKills,
): void {
  if (pid === undefined) return
  if (platform === 'win32') {
    kills.taskkill(pid)
    return
  }
  try {
    kills.killGroup(pid)
  } catch {
    // ESRCH (already gone), or EPERM/EINVAL where no group was created.
    // Falling back to the child alone still beats leaving it running.
    try {
      kills.killPid(pid)
    } catch {
      // Nothing left to kill; the deadline verdict stands either way.
    }
  }
}
```

Add `timeoutMs` to the options bag and destructure it (lines 200-209). Before:

```ts
function spawnPluginCli(options: {
  profile: string
  argv: string[]
  dshBin: string
  env?: NodeJS.ProcessEnv
  confirm?: (home: string | undefined) => string | null
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
}): RunningInstall {
  const { profile, argv, dshBin, env, confirm, afterDone, onStatus } = options
```

After:

```ts
function spawnPluginCli(options: {
  profile: string
  argv: string[]
  dshBin: string
  env?: NodeJS.ProcessEnv
  confirm?: (home: string | undefined) => string | null
  afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: HotRestartReason } | void>
  onStatus?: (status: InstallStatus) => void
  /** The deadline for this command; production uses INSTALL_TIMEOUT_MS. */
  timeoutMs?: number
}): RunningInstall {
  const { profile, argv, dshBin, env, confirm, afterDone, onStatus, timeoutMs = INSTALL_TIMEOUT_MS } = options
```

Guard `append` against a settled record (line 237). Before:

```ts
  const append = (line: string): void => {
    log.push(line)
```

After:

```ts
  const append = (line: string): void => {
    // A surviving grandchild keeps writing after the record has settled;
    // appending then would keep calling `onStatus` for a command the client
    // has already stopped polling.
    if (state !== 'running') return
    log.push(line)
```

Replace the whole `finished` body (lines 256-322). Before is the current `new Promise` block whose completion is `child.on('close', …)`. After:

```ts
  const finished = chain(profile, () => new Promise<InstallStatus>((resolve) => {
    const { command, args } = dshCommand({
      dshBin,
      args: ['plugin', '--profile', profile, ...argv],
      platform: process.platform,
      execPath: process.execPath,
      script: dshScript(),
    })
    // Not every start failure arrives as an `error` event: spawning a Windows
    // `.cmd` without a shell throws EINVAL synchronously out of `spawn()`
    // (measured 2026-09-02). Left to propagate it would reject `finished`,
    // which nothing awaits, and the install would poll as `running` forever
    // instead of reporting why it never started.
    let child: ChildProcessByStdio<null, Readable, Readable>
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ?? process.env,
        // Its own process group, so a deadline kill reaches `pnpm` and
        // everything pnpm spawned rather than `dsh` alone (F-1). Windows has
        // no process groups and `detached` there opens a console window, so
        // the tree is walked by `taskkill /T` in `killTree` instead.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve(failToStart(error as NodeJS.ErrnoException))
      return
    }

    let exited = false
    let closed = false
    let exitCode: number | null = null
    let timedOut = false
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined

    const drainThenSettle = (): void => {
      clearTimeout(drainTimer)
      drainTimer = setTimeout(() => { void settle() }, PIPE_DRAIN_MS)
    }

    /** Settle exactly once and release the pipes. */
    const settle = async (): Promise<void> => {
      if (state !== 'running') return
      clearTimeout(drainTimer)
      clearTimeout(deadlineTimer)
      child.stdout.destroy()
      child.stderr.destroy()
      if (timedOut) {
        state = 'failed'
        detail = installTimeoutDetail(profile, timeoutMs)
      } else if (exitCode === 0) {
        const confirmDetail = confirm?.(env?.DSH_HOME)
        if (confirmDetail != null) {
          state = 'failed'
          detail = confirmDetail
        } else if (afterDone !== undefined) {
          try {
            const outcome = await afterDone(env?.DSH_HOME)
            needsRestartOnDone = outcome?.needsRestart ?? true
            restartReason = outcome?.restartReason
          } catch {
            // A failed hot path never fails the install — the package IS
            // installed; it activates on restart instead.
            needsRestartOnDone = true
            restartReason = 'mount-failed'
          }
          state = 'done'
        } else {
          state = 'done'
        }
      } else {
        state = 'failed'
        detail = installFailureDetail(profile, log)
      }
      onStatus?.(status())
      resolve(status())
    }

    // Split on CRLF as well as LF. Every console producer on Windows —
    // pnpm, node, dsh's own wrapper — terminates with `\r\n`, and splitting
    // on '\n' alone left a literal `\r` on the end of every captured line.
    // The client renders this log, and `installFailureDetail` filters it with
    // `$`-anchored patterns that one trailing control character defeats.
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line !== '') append(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line !== '') append(line)
    })
    child.on('error', (error) => {
      clearTimeout(drainTimer)
      clearTimeout(deadlineTimer)
      resolve(failToStart(error as NodeJS.ErrnoException))
    })
    // `exit`, not `close`: the CHILD has finished, and that is the answer.
    // `close` waits for every holder of the inherited pipes, and a grandchild
    // can hold them open indefinitely (F-1). The drain is what still gets the
    // child's own output into the log.
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      if (closed) {
        void settle()
        return
      }
      drainThenSettle()
    })
    child.on('close', () => {
      closed = true
      if (exited) void settle()
    })
    deadlineTimer = setTimeout(() => {
      timedOut = true
      killTree(child.pid, process.platform)
      // The kill must not be able to hang the record either: settle after the
      // same grace whether or not `exit` ever arrives.
      drainThenSettle()
    }, timeoutMs)
  }))
```

Finally forward the option from both entry points (lines 333-352 and 361-380). In `startInstall`, before:

```ts
  onStatus?: (status: InstallStatus) => void
}): RunningInstall {
  const { profile, spec, dshBin = 'dsh', env, expectedName, afterDone, onStatus } = options
  return spawnPluginCli({
    profile,
    argv: ['add', spec],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleActivation(profile, home, expectedName) : undefined,
    afterDone,
    onStatus,
  })
```

After:

```ts
  onStatus?: (status: InstallStatus) => void
  /** The deadline for this install; production uses INSTALL_TIMEOUT_MS. */
  timeoutMs?: number
}): RunningInstall {
  const { profile, spec, dshBin = 'dsh', env, expectedName, afterDone, onStatus, timeoutMs } = options
  return spawnPluginCli({
    profile,
    argv: ['add', spec],
    dshBin,
    env,
    confirm: expectedName !== undefined ? home => confirmBundleActivation(profile, home, expectedName) : undefined,
    afterDone,
    onStatus,
    timeoutMs,
  })
```

and the identical two-line change in `startUninstall` (`timeoutMs?: number` on the bag, `timeoutMs` destructured and forwarded).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/executor.test.ts tests/host/index.test.ts tests/host/real-install.test.ts` — Expected: PASS, `serializes installs into one profile` (`executor.test.ts:85`) and `withholds done until afterDone settles` (`:255`) included — the drain adds 500 ms to each fixture's settle and neither asserts a wall-clock bound.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/executor.ts packages/dsh-plugin-shop/tests/host/executor.test.ts
git commit -m "fix(host): give a spawned install a deadline and kill its process group (F-1)"
```

---

### Task 15: A log line survives a chunk boundary

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts:6-10` (import), `:234-236` (the stale comment), the two `data` handlers and `settle` from Task 14
- Test: `packages/dsh-plugin-shop/tests/host/executor.test.ts`

**Interfaces:**
- Consumes: the `settle` function from Task 14.
- Produces: `LineSink`, `lineSink(emit): LineSink`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/executor.test.ts` (its imports gain `lineSink`):

```ts
describe('lineSink (F-6)', () => {
  it('completes a line split across chunks instead of emitting the fragment', () => {
    // The comment said "the next chunk usually completes it"; the code
    // appended the remainder as a NEW line. A fake dsh writing ` ERR_PNPM_FE`,
    // pausing 300 ms, then `TCH_404 …` produced two lines and the picker
    // reported ` ERR_PNPM_FE` as the reason the install failed.
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    sink.write(Buffer.from(' ERR_PNPM_FE'))
    sink.write(Buffer.from('TCH_404 GET https://r/x: Not Found - 404\n'))
    sink.flush()
    expect(lines).toEqual([' ERR_PNPM_FETCH_404 GET https://r/x: Not Found - 404'])
  })

  it('reassembles a multi-byte character split across chunks', () => {
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    const bytes = Buffer.from('已安装\n', 'utf8')
    sink.write(bytes.subarray(0, 4))
    sink.write(bytes.subarray(4))
    sink.flush()
    expect(lines).toEqual(['已安装'])
  })

  it('emits a final line the stream never terminated', () => {
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    sink.write(Buffer.from('no newline here'))
    expect(lines).toEqual([])
    sink.flush()
    expect(lines).toEqual(['no newline here'])
  })

  it('splits CRLF as well as LF and drops empty lines', () => {
    const lines: string[] = []
    const sink = lineSink(line => lines.push(line))
    sink.write(Buffer.from('a\r\n\r\nb\r\n'))
    sink.flush()
    expect(lines).toEqual(['a', 'b'])
  })
})

describe('startInstall line assembly (F-6)', () => {
  it('reports the whole line when the stream splits it, not the fragment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-split-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, [
      '#!/bin/sh',
      "printf '%s' ' ERR_PNPM_FE'",
      'sleep 0.3',
      "printf '%s\\n' 'TCH_404 GET https://r/x: Not Found - 404'",
      'exit 1',
      '',
    ].join('\n'))
    chmodSync(bin, 0o755)
    const status = await startInstall({ profile: 'split', spec: 'a@1.0.0', dshBin: bin }).finished
    expect(status.state).toBe('failed')
    expect(status.log).toEqual([' ERR_PNPM_FETCH_404 GET https://r/x: Not Found - 404'])
    expect(status.detail).toMatch(/ERR_PNPM_FETCH_404/)
  })

  it('keeps a final unterminated line in the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-unterminated-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, ['#!/bin/sh', "printf '%s' 'the bundle did not appear'", 'exit 1', ''].join('\n'))
    chmodSync(bin, 0o755)
    const status = await startInstall({ profile: 'unterminated', spec: 'a@1.0.0', dshBin: bin }).finished
    expect(status.log).toEqual(['the bundle did not appear'])
    expect(status.detail).toMatch(/did not appear/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/executor.test.ts -t "lineSink"` — Expected: FAIL with `does not provide an export named 'lineSink'`; and once exported, the split-chunk case fails as `[' ERR_PNPM_FE', 'TCH_404 GET https://r/x: Not Found - 404']`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/executor.ts`, add the import (after line 10):

```ts
import { StringDecoder } from 'node:string_decoder'
```

Add the sink above `spawnPluginCli` (beside `killTree`):

```ts
/** One stream's line assembler. */
export interface LineSink {
  write: (chunk: Buffer) => void
  /** Emit whatever is left when the stream ends without a final newline. */
  flush: () => void
}

/**
 * Assemble whole lines out of a byte stream.
 *
 * The old loop split each CHUNK and appended the trailing remainder as its
 * own line, on the theory the comment stated — "the next chunk usually
 * completes it". It does not: a fake dsh writing ` ERR_PNPM_FE`, pausing
 * 300 ms, then `TCH_404 …` produced `[" ERR_PNPM_FE", "TCH_404 GET …"]`, and
 * `installFailureDetail` reported the fragment as the reason the install
 * failed (F-6). A multi-byte UTF-8 sequence split across chunks was mangled
 * the same way, which is what `StringDecoder` is for.
 *
 * Empty lines are dropped by the caller's `emit`, as before.
 */
export function lineSink(emit: (line: string) => void): LineSink {
  const decoder = new StringDecoder('utf8')
  let pending = ''
  return {
    write(chunk) {
      pending += decoder.write(chunk)
      // Split on CRLF as well as LF: every console producer on Windows —
      // pnpm, node, dsh's own wrapper — terminates with `\r\n`, and the
      // client renders this log while `installFailureDetail` filters it with
      // `$`-anchored patterns one trailing control character defeats.
      const parts = pending.split(/\r?\n/)
      pending = parts.pop() ?? ''
      for (const line of parts) if (line !== '') emit(line)
    },
    flush() {
      pending += decoder.end()
      if (pending !== '') {
        emit(pending)
        pending = ''
      }
    },
  }
}
```

Replace the stale comment above `append` (lines 234-236). Before:

```ts
  // Chunks are split into lines; a trailing partial line (a chunk that does
  // not end in \n) is appended as-is — the next chunk usually completes it
  // and the log renders plain text, so a fragment is acceptable at v0.
```

After:

```ts
  // Whole lines only: `lineSink` holds a trailing partial until the next
  // chunk completes it, and flushes it at settle if the stream ended without
  // a newline. A fragment in the log is a fragment in the published failure
  // detail (F-6).
```

Replace the two `data` handlers written in Task 14 with the sinks, and flush them in `settle`. Before:

```ts
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line !== '') append(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) if (line !== '') append(line)
    })
```

After:

```ts
    const outLines = lineSink(append)
    const errLines = lineSink(append)
    child.stdout.on('data', (chunk: Buffer) => { outLines.write(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { errLines.write(chunk) })
```

and in `settle`, flush BEFORE the verdict is computed, since `installFailureDetail` reads `log`. Before:

```ts
      if (state !== 'running') return
      clearTimeout(drainTimer)
      clearTimeout(deadlineTimer)
      child.stdout.destroy()
      child.stderr.destroy()
```

After:

```ts
      if (state !== 'running') return
      clearTimeout(drainTimer)
      clearTimeout(deadlineTimer)
      // A stream that ended without a final newline still has a line in it,
      // and the failure picker is about to read the log.
      outLines.flush()
      errLines.flush()
      child.stdout.destroy()
      child.stderr.destroy()
```

Move the two sink declarations above `settle` so the flush call resolves (both are `const` in the same closure; declare them immediately after the `spawn` try/catch block).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/executor.test.ts` — Expected: PASS, including `caps the log at 200 lines, dropping the oldest` (250 newline-terminated lines still produce 250 appends) and both CRLF cases.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/executor.ts packages/dsh-plugin-shop/tests/host/executor.test.ts
git commit -m "fix(host): assemble whole log lines across chunk boundaries (F-6)"
```

---

### Task 16: A release-tag pin survives being read back

**Files:**
- Modify: `packages/dsh-plugin-shop/src/shared/identity.ts` (host the two version grammars)
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (import them instead of declaring them)
- Modify: `packages/dsh-plugin-shop/src/host/repo-pins.ts:24-32` (`readRepoPins`)
- Test: `packages/dsh-plugin-shop/tests/host/repo-pins.test.ts` (new), `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `identityKey` (Task 1); the identity-keyed pins of Tasks 5 and 6; `ShopInstalledEntry` (Task 6).
- Produces: `COMMIT_SHA` and `RELEASE_TAG` exported from `src/shared/identity.ts`; `catalog.ts` and `repo-pins.ts` both import them, so the boundary grammar and the pin store cannot drift.

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-plugin-shop/tests/host/repo-pins.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { readRepoPins, writeRepoPins, type RepoPinFs } from '../../src/host/repo-pins.ts'

/** An in-memory stand-in for the pins file, like catalog.test.ts's memFs. */
function memFs(): RepoPinFs & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    exists: p => files.has(p),
    read: p => files.get(p) ?? '',
    write: (p, data) => { files.set(p, data) },
  }
}

describe('readRepoPins', () => {
  const commit = 'a'.repeat(40)

  it('round-trips a commit pin', () => {
    const fs = memFs()
    writeRepoPins(fs, '/pins.json', { 'github:owner/slug#': commit })
    expect(readRepoPins(fs, '/pins.json')).toEqual({ 'github:owner/slug#': commit })
  })

  it('round-trips a release-tag pin (G-11)', () => {
    // The value check kept only 40-hex, so a release-rescued entry's tag pin
    // was written and then dropped on every read — and `installed()` could
    // never report `outdated` for any of the 162 live entries that carry a
    // tag rather than a commit.
    const fs = memFs()
    writeRepoPins(fs, '/pins.json', { 'github:owner/slug#': 'v1.0.0', 'github:o/s2#': 'release/1.0' })
    expect(readRepoPins(fs, '/pins.json')).toEqual({
      'github:owner/slug#': 'v1.0.0',
      'github:o/s2#': 'release/1.0',
    })
  })

  it('still drops a value that is neither a commit nor a tag', () => {
    const fs = memFs()
    fs.files.set('/pins.json', JSON.stringify({
      good: commit,
      spaced: 'v1.0.0 & calc.exe',
      empty: '',
      numeric: 7,
      nested: { v: commit },
    }))
    expect(readRepoPins(fs, '/pins.json')).toEqual({ good: commit })
  })

  it('reads a missing or corrupt file as no memory', () => {
    const fs = memFs()
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
    fs.files.set('/pins.json', 'not json')
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
    fs.files.set('/pins.json', '[1,2,3]')
    expect(readRepoPins(fs, '/pins.json')).toEqual({})
  })
})
```

and append to the `release-rescued tarball install` describe in `packages/dsh-plugin-shop/tests/host/index.test.ts`:

```ts
  it('reports a release-rescued install as outdated when the catalog tag moves (G-11)', async () => {
    // The round trip, not the write. `index.test.ts:1000` asserts only that
    // the tag was WRITTEN — `toEqual({ 'dsh-rescued': tag })` — and passes,
    // which is exactly what hid the dropped read for 162 live entries. That
    // assertion stays (it pins the identity key), and this one pins the fact
    // it cannot see.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-tarball-outdated-'))
    mkdirSync(join(dir, 'cache'), { recursive: true })
    writeFileSync(join(dir, 'cache/github-pins.json'), JSON.stringify({ 'github:owner/slug#': 'v1.0.0' }))
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-tarball-outdated-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', dsh: { profile: { bundles: [] } },
      dependencies: { 'dsh-rescued': TARBALL_URL },
    }))
    const newer: CatalogEntry = {
      ...tarballEntry, version: 'v1.1.0',
      tarball: { url: 'https://github.com/owner/slug/releases/download/v1.1.0/plugin.tgz', sha256: 'b'.repeat(64) },
    }
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: join(dir, 'cache'), profile: 'web', profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [newer], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    await gateway.catalog({})
    expect(await gateway.installed()).toEqual([{
      name: 'dsh-rescued', source: 'github', repo: 'owner/slug',
      installed: 'v1.0.0', latest: 'v1.1.0', outdated: true, enabled: true,
    }])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/repo-pins.test.ts tests/host/index.test.ts -t "release-rescued install as outdated"` — Expected: FAIL — the tag round trip returns `{}` (`- Expected { 'github:owner/slug#': 'v1.0.0', … } + Received {}`), and `installed()` answers `installed: '<the tarball url>', outdated: false`.

- [ ] **Step 3: Write the implementation**

Move the two version grammars into `packages/dsh-plugin-shop/src/shared/identity.ts` — the boundary that admits a pin and the store that reads it back must answer to one definition, which is what let them disagree. Append to that module:

```ts
/** A GitHub commit: the pin a repo entry installs at. */
export const COMMIT_SHA = /^[0-9a-f]{40}$/

/**
 * A GitHub release tag: the `version` of a release-rescued entry, and
 * therefore also a pin value.
 *
 * 162 of the 5,908 GitHub entries in today's catalog carry one rather than a
 * commit. Permissive about `/`, which real tags do carry (`release/1.0`), and
 * closed against everything a shell would read — a pin is written back into
 * the shop's own cache and compared against a catalog value, never spawned,
 * but the two grammars stay identical so a value the boundary admits is a
 * value the store keeps (G-11).
 */
export const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+/-]{0,127}$/
```

In `packages/dsh-plugin-shop/src/host/catalog.ts`, delete the local `COMMIT_SHA` and `RELEASE_TAG` declarations added in Task 2 and import them instead (beside the other local imports):

```ts
import { COMMIT_SHA, RELEASE_TAG } from '../shared/identity.ts'
```

In `packages/dsh-plugin-shop/src/host/repo-pins.ts`, widen the value check. Before (lines 8-10 of the module's doc block onward, and the loop at 24-32):

```ts
/** Bundle name to the pinned commit. */
export type RepoPins = Record<string, string>

/** Read the pins file; any irregularity degrades to an empty record. */
export function readRepoPins(fs: RepoPinFs, path: string): RepoPins {
  if (!fs.exists(path)) return {}
  try {
    const parsed = JSON.parse(fs.read(path)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: RepoPins = {}
    for (const [name, commit] of Object.entries(parsed)) {
      if (typeof commit === 'string' && /^[0-9a-f]{40}$/.test(commit)) out[name] = commit
    }
    return out
  } catch {
    // A corrupt pins file means "no memory", like a missing one.
    return {}
  }
}
```

After:

```ts
/** Install identity to the pinned version: a 40-character commit for a repo
 * entry, or the release tag for a release-rescued one. */
export type RepoPins = Record<string, string>

/**
 * Read the pins file; any irregularity degrades to an empty record.
 *
 * A value is kept when it is a commit OR a release tag. Keeping only the
 * commit form silently dropped every release-rescued entry's pin — written
 * on install, gone on the next read — so `installed()` could never report
 * `outdated` for the 162 live entries whose version is a tag (G-11). Both
 * grammars come from `shared/identity.ts`, the same ones the catalog
 * boundary admits.
 */
export function readRepoPins(fs: RepoPinFs, path: string): RepoPins {
  if (!fs.exists(path)) return {}
  try {
    const parsed = JSON.parse(fs.read(path)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: RepoPins = {}
    for (const [key, pin] of Object.entries(parsed)) {
      if (typeof pin !== 'string') continue
      if (COMMIT_SHA.test(pin) || RELEASE_TAG.test(pin)) out[key] = pin
    }
    return out
  } catch {
    // A corrupt pins file means "no memory", like a missing one.
    return {}
  }
}
```

with the import at the top of `repo-pins.ts`:

```ts
import { COMMIT_SHA, RELEASE_TAG } from '../shared/identity.ts'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/repo-pins.test.ts tests/host/index.test.ts tests/host/catalog.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/shared/identity.ts packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/src/host/repo-pins.ts packages/dsh-plugin-shop/tests/host/repo-pins.test.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "fix(host): keep a release-tag pin when reading it back (G-11)"
```

---

### Task 17: The hot-mount input is real YAML, so a scoped module can mount

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/hot.ts:31-34` (import), `:166-172` (`renderRows`)
- Test: `packages/dsh-plugin-shop/tests/host/hot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `renderRows(rows, prefix): string` becomes exported (the finding's reproduction is a unit test of it).

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/hot.test.ts` (its imports gain `renderRows` from `hot.ts` and `JSON_SCHEMA, load` from `js-yaml`):

```ts
describe('renderRows (F-4)', () => {
  it('emits a scoped module name the Include dialect can parse', () => {
    // `@` cannot start a plain YAML scalar. The real shape
    // `@tt-a1i/archify-dsh` made hotMount answer
    // `{ ok: false, reason: 'mount-failed' }` with `bad indentation of a
    // mapping entry (2:9)` — so EVERY entry mounting a `@deepseek-ai/*`
    // module silently fell back to restart, with a reason code that says
    // restart will fix it. The package's own patch had the name quoted; the
    // render dropped the quotes.
    const text = renderRows([{ id: 'archify', name: '@tt-a1i/archify-dsh' }], 'mkt-')
    expect(load(text, { schema: JSON_SCHEMA })).toEqual([{ id: 'mkt-archify', name: '@tt-a1i/archify-dsh' }])
  })

  it('emits an unscoped name unchanged, byte for byte', () => {
    // The shape the existing mount test asserts, so the fix is not a
    // reformat of every hot file.
    expect(renderRows([{ id: 'hello', name: 'dsh-hello-plugin' }], 'mkt-'))
      .toBe('- id: mkt-hello\n  name: dsh-hello-plugin\n')
  })

  it('survives every scalar a package.json name or id can carry', () => {
    for (const name of ['@deepseek-ai/dsh-skill-filesystem', '{{PKG_NAME}}', 'yes', 'no', 'null', '1.0', '- dash', 'a: colon', '*star', '#hash', 'tab\tinside']) {
      const text = renderRows([{ id: 'x', name }], 'mkt-')
      expect(load(text, { schema: JSON_SCHEMA }), name).toEqual([{ id: 'mkt-x', name }])
    }
  })

  it('round-trips several rows', () => {
    const text = renderRows([{ id: 'a', name: '@scope/a' }, { id: 'b', name: 'b' }], 'mkt-')
    expect(load(text, { schema: JSON_SCHEMA })).toEqual([
      { id: 'mkt-a', name: '@scope/a' },
      { id: 'mkt-b', name: 'b' },
    ])
  })
})
```

and one end-to-end case in the existing `hotMount / hotUnmount` describe:

```ts
  it('mounts a package whose patch inserts a scoped module', async () => {
    const fs = memFs()
    seedPackage(fs, "- insert:\n    - id: archify\n      name: '@tt-a1i/archify-dsh'\n")
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })
    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })
    expect(result).toEqual({ ok: true, reason: null })
    expect(fs.files.get(join(HOT_DIR, 'hot-1.yml'))).toBe("- id: mkt-archify\n  name: '@tt-a1i/archify-dsh'\n")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/hot.test.ts -t "renderRows"` — Expected: FAIL with `does not provide an export named 'renderRows'`; and once exported, the scoped case fails with `YAMLException: bad indentation of a mapping entry (2:9)`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/hot.ts`, add `dump` to the `js-yaml` import (line 34):

```ts
import { JSON_SCHEMA, Type, dump, load } from 'js-yaml'
```

and replace `renderRows` (lines 166-172). Before:

```ts
/** Render the accepted rows with prefixed ids — the exact input file the
 * Include tree mounts. Only values the line scan accepted are emitted, and
 * the output is itself a simple patch (round-trips through
 * parseSimplePatch). */
function renderRows(rows: HotRow[], prefix: string): string {
  return rows.map(row => `- id: ${prefix}${row.id}\n  name: ${row.name}`).join('\n') + '\n'
}
```

After:

```ts
/**
 * Render the accepted rows with prefixed ids — the exact input file the
 * Include tree mounts.
 *
 * Serialised by the YAML writer, never by string concatenation. `@` cannot
 * start a plain YAML scalar, so hand-built `name: @tt-a1i/archify-dsh` was
 * rejected by the Include's own dialect (`bad indentation of a mapping entry
 * (2:9)`) and EVERY entry mounting a scoped module fell back to restart with
 * a reason code claiming restart would fix it (F-4). The same held for `yes`,
 * `no`, a leading `*`, `#` or `-`, and a name containing `: `.
 *
 * `lineWidth: -1` keeps a long name on one line rather than folding it;
 * `noRefs: true` matches `profile.ts`'s writer. For a plain unscoped name the
 * output is byte-identical to what the concatenation produced.
 */
export function renderRows(rows: HotRow[], prefix: string): string {
  return dump(rows.map(row => ({ id: `${prefix}${row.id}`, name: row.name })), {
    noRefs: true,
    lineWidth: -1,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/hot.test.ts tests/host/index.test.ts` — Expected: PASS, including `mounts a simple patch, then unmounts and disposes the tree` (`hot.test.ts:126`), whose exact-bytes assertion `'- id: mkt-hello\n  name: dsh-hello-plugin\n'` `dump` reproduces.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/hot.ts packages/dsh-plugin-shop/tests/host/hot.test.ts
git commit -m "fix(host): serialise the hot-mount input as YAML so a scoped module mounts (F-4)"
```

---

### Task 18: The hot mount will not read a patch outside the package

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/hot.ts:32` (import), `:266-276` (the patch read)
- Test: `packages/dsh-plugin-shop/tests/host/hot.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to the `hotMount / hotUnmount` describe in `packages/dsh-plugin-shop/tests/host/hot.test.ts`:

```ts
  it('refuses a bundle patch path that escapes the package directory (F-10)', async () => {
    // `ownedEntryIds` (profile.ts:131-135) confines the same field; these two
    // readers of one untrusted manifest value disagreed, and this one read
    // and mounted `../../../../etc/hostile.yml`.
    const fs = memFs()
    const reads: string[] = []
    const watched: HotFs = {
      read: (p) => { reads.push(p); return fs.read(p) },
      write: fs.write,
      list: fs.list,
    }
    fs.files.set(join(PKG_DIR, 'package.json'), JSON.stringify({
      name: 'dsh-hello-plugin', version: '1.0.0',
      dsh: { bundle: { patch: '../../../../etc/hostile.yml' } },
    }))
    fs.files.set('/etc/hostile.yml', '- insert:\n    - id: pwned\n      name: hostile\n')
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })

    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs: watched, dir: HOT_DIR, timeoutMs: 1000 })

    expect(result).toEqual({ ok: false, reason: 'no-patch' })
    expect(reads).not.toContain('/etc/hostile.yml')
    expect(fs.files.get(join(HOT_DIR, 'hot-1.yml'))).toBeUndefined()
  })

  it('still reads a patch in a subdirectory of the package', async () => {
    const fs = memFs()
    fs.files.set(join(PKG_DIR, 'package.json'), JSON.stringify({
      name: 'dsh-hello-plugin', version: '1.0.0',
      dsh: { bundle: { patch: './dsh/cordis.patch.yml' } },
    }))
    fs.files.set(join(PKG_DIR, 'dsh', 'cordis.patch.yml'), '- insert:\n    - id: hello\n      name: dsh-hello-plugin\n')
    const ctx = testCtx({ await: async () => {}, dispose: async () => {} })
    const result = await hotMount(ctx, PROFILE, 'dsh-hello-plugin', { hotTreeClass: FakeHotTree, fs, dir: HOT_DIR, timeoutMs: 1000 })
    expect(result).toEqual({ ok: true, reason: null })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/hot.test.ts -t "escapes the package directory"` — Expected: FAIL — `expected { ok: false, reason: 'no-patch' } to equal …` receives `{ ok: true, reason: null }`, and `reads` contains `/etc/hostile.yml`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/hot.ts`, extend the path import (line 32):

```ts
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
```

and replace the patch read in `hotMount` (lines 266-276). Before:

```ts
  // The installed package's own bundle patch is the mount source: locate it
  // through the package's dsh field (defaulting to the conventional name).
  const packageDir = join(profileDir, 'node_modules', packageName)
  const dsh = readPkgDsh(fs, packageDir)
  let patchText: string
  try {
    patchText = fs.read(join(packageDir, dsh?.patch ?? 'cordis.patch.yml'))
  } catch {
    ctx.logger?.warn(`hot-mount ${packageName}: no patch file to mount — restart will activate it`)
    return { ok: false, reason: 'no-patch' }
  }
```

After:

```ts
  // The installed package's own bundle patch is the mount source: locate it
  // through the package's dsh field (defaulting to the conventional name).
  const packageDir = join(profileDir, 'node_modules', packageName)
  const dsh = readPkgDsh(fs, packageDir)
  // The path comes from an untrusted package manifest and is about to be
  // read. `ownedEntryIds` (profile.ts:131-135) already confines the same
  // field; this reader did not, and mounted `../../../../etc/hostile.yml`
  // (F-10). Two readers of one hostile value must not disagree.
  const patchFile = resolve(packageDir, dsh?.patch ?? 'cordis.patch.yml')
  const inside = relative(packageDir, patchFile)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    ctx.logger?.warn(`hot-mount ${packageName}: the declared bundle patch is outside the package directory — restart will activate it`)
    return { ok: false, reason: 'no-patch' }
  }
  let patchText: string
  try {
    patchText = fs.read(patchFile)
  } catch {
    ctx.logger?.warn(`hot-mount ${packageName}: no patch file to mount — restart will activate it`)
    return { ok: false, reason: 'no-patch' }
  }
```

`no-patch` is the honest reason code: it says "this package can never hot-mount", which is exactly true of a package declaring a patch it does not own.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/hot.test.ts` — Expected: PASS. `resolve(PKG_DIR, './cordis.patch.yml')` is byte-identical to the previous `join(packageDir, 'cordis.patch.yml')` for every existing fixture, so the seven pre-existing mount cases are untouched.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/hot.ts packages/dsh-plugin-shop/tests/host/hot.test.ts
git commit -m "fix(host): confine the hot-mount patch path to the package directory (F-10)"
```

---

### Task 19: A restart refuses while an install is running

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:912-957` (`restart`)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (it reads `this.installs`, which Task 14 left in place).
- Produces: `private hasRunningCommand(): boolean`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/index.test.ts`:

```ts
describe('restart while an install is running (F-5)', () => {
  it('refuses instead of booting a new dsh against a half-mutated profile', async () => {
    // `restart()` never consulted `this.installs`: it spawned the helper and
    // exited after 2 s while a `dsh plugin add` child was neither detached
    // nor killed, so `pnpm` kept rewriting the profile's package.json,
    // lockfile and node_modules (and hit EPIPE on its inherited stdout)
    // while the helper booted the new dsh against the result.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-busy-'))
    const slow = join(dir, 'dsh')
    writeFileSync(slow, ['#!/bin/sh', 'sleep 2', 'exit 0', ''].join('\n'))
    chmodSync(slow, 0o755)
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-restart-busy-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: [] } }, dependencies: {} }))
    const listed: CatalogEntry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null,
      license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
    }
    const exit = vi.fn()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: mkdtempSync(join(tmpdir(), 'dsh-restart-busy-cache-')),
      profile: 'web', profileDir, dshBin: slow, exit, restartArgv: ['web'],
      restartParentPid: await (async () => process.pid)(),
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [listed], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true, source: 'npm' })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect(gateway.installStatus({ installId: started.installId }).state).toBe('running')

    const outcome = await gateway.restart()
    expect(outcome).toEqual({
      ok: false,
      detail: 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.',
    })
    expect(exit).not.toHaveBeenCalled()
  })

  it('allows the restart once the install has settled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-idle-'))
    const quick = join(dir, 'dsh')
    writeFileSync(quick, ['#!/bin/sh', 'exit 0', ''].join('\n'))
    chmodSync(quick, 0o755)
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-restart-idle-profile-'))
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', dsh: { profile: { bundles: ['dsh-hello-plugin'] } }, dependencies: {} }))
    const listed: CatalogEntry = {
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null,
      license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
    }
    const exit = vi.fn()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: mkdtempSync(join(tmpdir(), 'dsh-restart-idle-cache-')),
      profile: 'web', profileDir, dshBin: quick, exit, restartArgv: ['web'],
      restartExitDelayMs: 1, restartParentPid: 1,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 6, builtAt: '', entries: [listed], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true, source: 'npm' })
    if (!started.ok) throw new Error('the fixture install was rejected')
    await vi.waitFor(() => {
      expect(gateway.installStatus({ installId: started.installId }).state).not.toBe('running')
    })
    expect(await gateway.restart()).toEqual({ ok: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/index.test.ts -t "restart while an install is running"` — Expected: FAIL — the first case receives `{ ok: true }` and `exit` was scheduled.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/index.ts`, add the predicate beside `evictFinishedInstalls` (after line 748):

```ts
  /** Whether any command this gateway started is still running. */
  private hasRunningCommand(): boolean {
    for (const record of this.installs.values()) {
      if (record.status().state === 'running') return true
    }
    return false
  }
```

and add the refusal as the FIRST check in `restart()` (before the Windows guard at line 918):

```ts
    // A running install owns the profile: `pnpm` is rewriting its
    // package.json, lockfile and node_modules. Exiting now hands the helper
    // a half-written profile to boot the new dsh against, and leaves the
    // child neither detached from nor killed by the process that spawned it
    // (F-5). Refused before anything is torn down, like every other refusal
    // on this path.
    if (this.hasRunningCommand()) {
      return {
        ok: false,
        detail: 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.',
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/index.test.ts` — Expected: PASS, the five pre-existing `ShopGateway.restart` and `restart guard` cases included: none of them starts an install first, so the new check falls through.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "fix(host): refuse a restart while an install is still running (F-5)"
```

---

### Task 20: The restart helper re-runs THIS process, and its spawn failure is reported

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/restart.ts:13-14` (imports), `:40-70` (`startRestart`), plus a new pure `restartCommand`
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:78-80` (option), `:266-268` (field), `:938-951` (the call)
- Test: `packages/dsh-plugin-shop/tests/host/restart.test.ts`, `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `restartCommand({ dshBin, argv, execPath, execArgv, script }): { command, args }`; `startRestart` takes `{ command, args, parentPid, logFile, env? }`; `ShopGatewayOptions.restartScript?: string`.

- [ ] **Step 1: Reproduce the finding (it is filed *Plausible*)**

F-7 has two claims. Reproduce both before changing anything; if either does not reproduce, close that half with a note instead of writing the fix.

Claim A — the helper's spawn failure is an uncaught event. Add to `packages/dsh-plugin-shop/tests/host/restart.test.ts`:

```ts
  it('records a helper that could not start, instead of raising an uncaught event', async () => {
    // `spawn('sh', …)` has no `'error'` listener, and a spawn failure arrives
    // ASYNCHRONOUSLY — after this function returned and the caller already
    // committed. An empty PATH is the cheapest way to make `sh` itself
    // unresolvable: libuv sets the child's environ before `execvp`, so the
    // lookup uses the PATH we pass.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-nopath-'))
    const logFile = join(dir, 'restart.log')
    startRestart({
      command: 'dsh',
      args: ['web'],
      parentPid: await deadPid(),
      logFile,
      env: { PATH: '' },
    })
    await until(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('the restart helper could not start'), 5000)
    rmSync(dir, { recursive: true, force: true })
  })
```

Run: `npx vitest run tests/host/restart.test.ts -t "could not start"` — Expected: FAIL. Before the fix it fails one of two ways, and either confirms claim A: `Error: condition not met in time` (nothing was recorded), or an unhandled `Error: spawn sh ENOENT` reported against the file, because a ChildProcess `'error'` with no listener is rethrown.

Claim B — `dsh` from PATH is not this process. Assert it as a pure fact:

```ts
describe('restartCommand', () => {
  it('re-runs this process by its own entry, not a name on PATH', () => {
    // The helper exec'd `dsh` from PATH with `process.argv.slice(2)`, dropping
    // `execArgv`: a dsh started as `node …/bin.js web`, via npx/pnpm dlx, or
    // from a shell whose PATH differs from the host's, exits and nothing
    // takes the port.
    expect(restartCommand({
      dshBin: 'dsh',
      argv: ['web', '--no-open'],
      execPath: '/usr/bin/node',
      execArgv: ['--enable-source-maps'],
      script: '/opt/dsh/lib/bin.js',
    })).toEqual({
      command: '/usr/bin/node',
      args: ['--enable-source-maps', '/opt/dsh/lib/bin.js', 'web', '--no-open'],
    })
  })

  it('honours an explicit dshBin as given', () => {
    // A caller naming a specific file made an explicit choice — the same rule
    // `dshCommand` applies. This is also what keeps the fixture-driven tests
    // in this file and index.test.ts exercising their own fake dsh.
    expect(restartCommand({
      dshBin: '/tmp/fixture/dsh',
      argv: ['web'],
      execPath: '/usr/bin/node',
      execArgv: [],
      script: '/opt/dsh/lib/bin.js',
    })).toEqual({ command: '/tmp/fixture/dsh', args: ['web'] })
  })

  it('falls back to the bare name when this process has no script path', () => {
    expect(restartCommand({
      dshBin: 'dsh', argv: ['web'], execPath: '/usr/bin/node', execArgv: [], script: undefined,
    })).toEqual({ command: 'dsh', args: ['web'] })
  })
})
```

Run: `npx vitest run tests/host/restart.test.ts -t "restartCommand"` — Expected: FAIL with `does not provide an export named 'restartCommand'`.

- [ ] **Step 2: Convert the three existing cases to the new call shape**

`restart.test.ts:73-114` passes `dshBin`/`argv`; `startRestart` now takes the resolved command. Change each of the three:

- `execs the dsh command verbatim once the parent pid is gone…`: `dshBin: fixtureDsh(marker), argv: ['web', '--no-open']` → `command: fixtureDsh(marker), args: ['web', '--no-open']`
- `holds the child back while the parent pid is alive`: `dshBin: fixtureDsh(marker), argv: ['web']` → `command: fixtureDsh(marker), args: ['web']`
- `throws when the log file cannot be opened, before committing`: same rename

Run: `npx vitest run tests/host/restart.test.ts` — Expected: FAIL on the type error (`Object literal may only specify known properties, and 'dshBin' does not exist`) until Step 3 lands; the point of this step is that the rename is part of the change, not a follow-up.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/restart.ts`, extend the imports (lines 13-14):

```ts
import { appendFileSync, openSync, closeSync } from 'node:fs'
import { spawn } from 'node:child_process'
```

Add the pure resolver above `startRestart`:

```ts
/**
 * The command line that re-runs THIS process.
 *
 * The helper used to exec `dsh` from PATH with `process.argv.slice(2)`,
 * which is not the same thing: `execArgv` was dropped, and a dsh started as
 * `node …/bin.js web`, through `npx`/`pnpm dlx`, or from a shell whose PATH
 * differs from the host's, exited into nothing (F-7). `process.execPath` plus
 * `process.argv[1]` plus `execArgv` is the same process, byte for byte — and
 * a global shim has already resolved to that JS entry by the time it runs, so
 * this is not a Windows-only route the way `dshCommand`'s is.
 *
 * An explicit `dshBin` naming a file is the caller's own choice and is used
 * as given, the same rule `dshCommand` applies.
 */
export function restartCommand(options: {
  dshBin: string
  argv: readonly string[]
  execPath: string
  execArgv: readonly string[]
  script: string | undefined
}): { command: string; args: string[] } {
  const { dshBin, argv, execPath, execArgv, script } = options
  if (dshBin === 'dsh' && script !== undefined) {
    return { command: execPath, args: [...execArgv, script, ...argv] }
  }
  return { command: dshBin, args: [...argv] }
}
```

Replace `startRestart` (lines 40-70). Before:

```ts
export function startRestart(options: {
  dshBin: string
  argv: string[]
  parentPid: number
  logFile: string
  env?: NodeJS.ProcessEnv
}): void {
  const { dshBin, argv, parentPid, logFile, env } = options
  // Opened by the parent: the descriptor is inherited by the helper and the
  // dsh child; the parent's own copy closes right after the spawn.
  const logFd = openSync(logFile, 'a')
  try {
    const helper = spawn('sh', [
      '-c',
      // $1 is the parent pid; once `kill -0` fails the loop ends, the pid
      // is shifted away, and "$@" is the dsh command line verbatim.
      'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@"',
      'sh',
      String(parentPid),
      dshBin,
      ...argv,
    ], {
      stdio: ['ignore', logFd, logFd],
      env: env ?? process.env,
      detached: true, // its own process group: survives this process's exit
    })
    helper.unref()
  } finally {
    closeSync(logFd)
  }
}
```

After:

```ts
export function startRestart(options: {
  /** The already-resolved command — see `restartCommand`. */
  command: string
  args: readonly string[]
  parentPid: number
  logFile: string
  env?: NodeJS.ProcessEnv
}): void {
  const { command, args, parentPid, logFile, env } = options
  // Opened by the parent: the descriptor is inherited by the helper and the
  // dsh child; the parent's own copy closes right after the spawn.
  const logFd = openSync(logFile, 'a')
  try {
    const helper = spawn('sh', [
      '-c',
      // $1 is the parent pid; once `kill -0` fails the loop ends, the pid
      // is shifted away, and "$@" is the dsh command line verbatim.
      'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; shift; exec "$@"',
      'sh',
      String(parentPid),
      command,
      ...args,
    ], {
      stdio: ['ignore', logFd, logFd],
      env: env ?? process.env,
      detached: true, // its own process group: survives this process's exit
    })
    helper.on('error', (error) => {
      // A spawn failure arrives ASYNCHRONOUSLY, after this function returned
      // and the caller committed. With no listener node re-throws it as an
      // uncaught 'error' event and takes the process down before the response
      // is even out (F-7). The log file is the documented place a failed
      // handoff is diagnosed from, so that is where this goes.
      try {
        appendFileSync(logFile, `dsh-plugin-shop: the restart helper could not start: ${error.message}\n`)
      } catch {
        // The log was writable a moment ago (openSync above succeeded); if it
        // is not now there is nowhere left to record this, and the client's
        // origin monitor is the remaining reporter.
      }
    })
    helper.unref()
  } finally {
    closeSync(logFd)
  }
}
```

In `packages/dsh-plugin-shop/src/host/index.ts`, add the option (after line 80):

```ts
  /** The JS entry `shop/restart` re-runs; defaults to `process.argv[1]`, the
   * script this dsh was started with. */
  restartScript?: string
```

the field (after line 267):

```ts
  /** The script the restart re-runs — this process's own entry. */
  private readonly restartScript: string | undefined
```

its assignment (beside `restartArgv`, line 326):

```ts
    this.restartScript = options.restartScript ?? process.argv[1]
```

the import (beside the existing `startRestart` import, line 21):

```ts
import { restartCommand, startRestart, type RestartOutcome } from './restart.ts'
```

and the call (lines 939-946). Before:

```ts
      const { cacheDir } = this.rowConfig()
      startRestart({
        dshBin: this.dshBin,
        argv: this.restartArgv,
        parentPid: this.restartParentPid,
        logFile: join(cacheDir, 'restart.log'),
        env: process.env,
      })
```

After:

```ts
      const { cacheDir } = this.rowConfig()
      const { command, args } = restartCommand({
        dshBin: this.dshBin,
        argv: this.restartArgv,
        execPath: process.execPath,
        execArgv: process.execArgv,
        script: this.restartScript,
      })
      startRestart({
        command,
        args,
        parentPid: this.restartParentPid,
        logFile: join(cacheDir, 'restart.log'),
        env: process.env,
      })
```

Then add one gateway-level case to `packages/dsh-plugin-shop/tests/host/index.test.ts`, so the wiring is covered and not only the pure resolver:

```ts
  it('re-runs this process\'s own entry when dshBin is the bare default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-node-'))
    const marker = join(dir, 'ran.log')
    const script = join(dir, 'fake-bin.js')
    writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '\\n')\n`)
    const exit = vi.fn()
    const gateway = new ShopGateway(stubCtx(), {
      catalogUrl: 'https://shop.test/v1/', cacheDir: dir, profile: 'web',
      exit, restartExitDelayMs: 1, restartParentPid: 1,
      restartArgv: ['web', '--no-open'], restartScript: script,
    })
    expect(await gateway.restart()).toEqual({ ok: true })
    await vi.waitFor(() => { expect(existsSync(marker)).toBe(true) }, { timeout: 5000 })
    expect(readFileSync(marker, 'utf8')).toContain('web --no-open')
    rmSync(dir, { recursive: true, force: true })
  })
```

(`restartParentPid: 1` makes the helper's `kill -0 1` fail immediately for an unprivileged process, which is how the pre-existing restart cases already run the fixture at once. The script is CommonJS `require` on purpose: it is spawned by `process.execPath` with no package.json above it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/restart.test.ts tests/host/index.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/restart.ts packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/restart.test.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "fix(host): re-run this process on restart and report a helper that cannot start (F-7)"
```

---

### Task 21: The version check has a deadline and tries the user's own registry

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/self-update.ts` (whole module)
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:330` (wiring), `:537-554` (`originsFor` reads a memoised registry)
- Test: `packages/dsh-plugin-shop/tests/host/self-update.test.ts`, `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `fetchLatestVersion(fetchFn?, options?: { registry?: string | null; timeoutMs?: number })`, `VERSION_CHECK_TIMEOUT_MS`; `private npmRegistry(): string | null` on the gateway.

- [ ] **Step 1: Write the failing test**

Rewrite `packages/dsh-plugin-shop/tests/host/self-update.test.ts` — the first case's assertion changes because the call now carries a signal, which is the whole point:

```ts
import { describe, expect, it, vi } from 'vitest'
import { VERSION_CHECK_TIMEOUT_MS, fetchLatestVersion } from '../../src/host/self-update.ts'

function fetchReturning(body: unknown, ok = true): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  }) as unknown as typeof fetch
}

describe('fetchLatestVersion', () => {
  it('returns the latest dist-tag of the shop packument, under a deadline', async () => {
    const fetchFn = fetchReturning({ 'dist-tags': { latest: '0.4.4' } })
    expect(await fetchLatestVersion(fetchFn)).toBe('0.4.4')
    // The URL assertion is unchanged; the second argument is new. Without a
    // signal the check had NO deadline at all (still pending at 5 s against a
    // silent socket; undici's default is 300 s), and `shop/version` is warmed
    // at every web boot (F-8).
    expect(fetchFn).toHaveBeenCalledWith(
      'https://registry.npmjs.org/dsh-plugin-shop',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('degrades to null on a non-ok response', async () => {
    expect(await fetchLatestVersion(fetchReturning({}, false))).toBeNull()
  })

  it('degrades to null on an unexpected payload', async () => {
    expect(await fetchLatestVersion(fetchReturning({}))).toBeNull()
    expect(await fetchLatestVersion(fetchReturning({ 'dist-tags': {} }))).toBeNull()
    expect(await fetchLatestVersion(fetchReturning({ 'dist-tags': { latest: 42 } }))).toBeNull()
  })

  it('degrades to null when the fetch throws', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch
    expect(await fetchLatestVersion(fetchFn)).toBeNull()
  })

  it('gives up on a socket that never answers', async () => {
    // The bound holds even for a fetch that ignores the signal, which is what
    // makes it testable and what makes a badly-behaved dispatcher harmless.
    const fetchFn = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const started = Date.now()
    expect(await fetchLatestVersion(fetchFn, { timeoutMs: 50 })).toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('asks the user\'s own registry first, then npmjs', async () => {
    // A mirror-only user never got an update check although their .npmrc
    // registry is already read for the catalog race.
    const urls: string[] = []
    const fetchFn = vi.fn(async (input: string | URL) => {
      urls.push(String(input))
      if (urls.length === 1) return { ok: false, json: async () => ({}) } as unknown as Response
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.9.0' } }) } as unknown as Response
    }) as unknown as typeof fetch
    expect(await fetchLatestVersion(fetchFn, { registry: 'https://registry.npmmirror.com' })).toBe('0.9.0')
    expect(urls).toEqual([
      'https://registry.npmmirror.com/dsh-plugin-shop',
      'https://registry.npmjs.org/dsh-plugin-shop',
    ])
  })

  it('asks once when the configured registry IS npmjs', async () => {
    const fetchFn = fetchReturning({ 'dist-tags': { latest: '1.0.0' } })
    expect(await fetchLatestVersion(fetchFn, { registry: 'https://registry.npmjs.org/' })).toBe('1.0.0')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('bounds the check at five seconds by default', () => {
    expect(VERSION_CHECK_TIMEOUT_MS).toBe(5000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/self-update.test.ts` — Expected: FAIL — `does not provide an export named 'VERSION_CHECK_TIMEOUT_MS'`, and `gives up on a socket that never answers` times out at the vitest 5 s limit.

- [ ] **Step 3: Write the implementation**

Replace `packages/dsh-plugin-shop/src/host/self-update.ts` in full:

```ts
/** Self-update version check: the shop's latest published version, from the
 * npm packument. Advisory by design — like the stars sidecar, a failed
 * check degrades to `null` and never throws, never blocks a publish. The
 * catalog cannot serve here: the shop is bootstrap-installed and is not
 * harvested into its own catalog. */

/** The npm package the shop itself is published as. */
const SHOP_PACKAGE = 'dsh-plugin-shop'

/** The registry that always gets asked, last. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** How long one registry gets to answer. `shop/version` is warmed at every
 * web boot, and this call had no deadline at all: still pending at 5 s
 * against a silent socket, with undici's default headers timeout at 300 s
 * behind it (F-8). */
export const VERSION_CHECK_TIMEOUT_MS = 5000

/** Ask one registry. Any failure — network, non-2xx, unexpected payload,
 * deadline — is the same outcome: no answer from THIS registry. */
async function askRegistry(
  fetchFn: typeof fetch,
  registry: string,
  timeoutMs: number,
): Promise<string | null> {
  const url = `${registry}${SHOP_PACKAGE}`
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    // The signal is handed to the fetch AND raced, so the bound holds even
    // for a dispatcher (or an injected stand-in) that ignores it. Losing
    // rejections are handled by `Promise.race` itself, so nothing here can
    // surface as an unhandled rejection.
    const response = await Promise.race([
      fetchFn(url, { signal }),
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new Error(`the version check did not answer within ${timeoutMs} ms`))
        })
      }),
    ])
    if (!response.ok) return null
    const packument = await response.json() as { 'dist-tags'?: { latest?: unknown } }
    const latest = packument['dist-tags']?.latest
    return typeof latest === 'string' ? latest : null
  } catch {
    // Any fetch, abort or parse failure is the same outcome: no answer, not
    // an error — the version row simply shows the installed version alone.
    return null
  }
}

/**
 * Fetch the shop's `latest` dist-tag, or `null` when no registry can answer.
 *
 * The user's own `registry=` is tried first when it is known: their .npmrc is
 * already read for the catalog race, and a mirror-only user otherwise never
 * got an update check at all. npmjs is always the fallback, so a mirror that
 * lags behind cannot hide a release. `dist-tags.latest` alone is read, so a
 * stable user never sees a beta.
 */
export async function fetchLatestVersion(
  fetchFn: typeof fetch = fetch,
  options: { registry?: string | null; timeoutMs?: number } = {},
): Promise<string | null> {
  const { registry = null, timeoutMs = VERSION_CHECK_TIMEOUT_MS } = options
  const asked = new Set<string>()
  for (const base of registry === null ? [DEFAULT_REGISTRY] : [registry, DEFAULT_REGISTRY]) {
    const normalized = base.endsWith('/') ? base : `${base}/`
    if (asked.has(normalized)) continue
    asked.add(normalized)
    const latest = await askRegistry(fetchFn, normalized, timeoutMs)
    if (latest !== null) return latest
  }
  return null
}
```

In `packages/dsh-plugin-shop/src/host/index.ts`, hoist the npmrc read out of `originsFor` so both readers share one, memoised, result. Add the field (after the `originCache` field, line 301):

```ts
  /** The user's own `registry=` from `~/.npmrc`, read at most once per
   * gateway: it does not change under a running dsh, and re-reading it would
   * put a filesystem read on the catalog hot path. Wrapped so a genuine
   * `null` is distinguishable from "not read yet". */
  private npmRegistryCache: { value: string | null } | null = null
```

Add the reader beside `originsFor` and make `originsFor` call it. Before (lines 537-554):

```ts
  private originsFor(catalogUrl: string): CatalogOrigin[] {
    if (this.originCache?.catalogUrl === catalogUrl) return this.originCache.origins
    const registry = npmrcRegistry(path => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // No user npmrc, or unreadable: the defaults are raced instead. This
        // is a preference, never a requirement.
        return null
      }
    }, homedir())
    const origins = catalogOrigins(catalogUrl, fetch, registry)
    this.originCache = { catalogUrl, origins }
    return origins
  }
```

After:

```ts
  /** The user's own registry, read once. The self-update check reads the same
   * value: their .npmrc was already consulted for the catalog race, and a
   * mirror-only user otherwise never got an update check (F-8). */
  private npmRegistry(): string | null {
    const cached = this.npmRegistryCache
    if (cached !== null) return cached.value
    const value = npmrcRegistry(path => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // No user npmrc, or unreadable: the defaults are raced instead. This
        // is a preference, never a requirement.
        return null
      }
    }, homedir())
    this.npmRegistryCache = { value }
    return value
  }

  private originsFor(catalogUrl: string): CatalogOrigin[] {
    if (this.originCache?.catalogUrl === catalogUrl) return this.originCache.origins
    const origins = catalogOrigins(catalogUrl, fetch, this.npmRegistry())
    this.originCache = { catalogUrl, origins }
    return origins
  }
```

and wire the check to it (line 330). Before:

```ts
    this.latestVersion = options.fetchLatestVersion ?? (() => fetchLatestVersion())
```

After:

```ts
    this.latestVersion = options.fetchLatestVersion ?? (() => fetchLatestVersion(fetch, { registry: this.npmRegistry() }))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/self-update.test.ts tests/host/index.test.ts tests/host/catalog.test.ts` — Expected: PASS. The three `ShopGateway.version` cases inject `fetchLatestVersion`, so they never reach the network.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/self-update.ts packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/self-update.test.ts
git commit -m "fix(host): bound the version check and ask the user's own registry first (F-8)"
```

---

### Task 22: The user layer keeps its `!!js` spelling

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/profile.ts:6` (import), `:85-94` (`setUserLayerRows`)
- Test: `packages/dsh-plugin-shop/tests/host/profile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no new exports.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/profile.test.ts`:

```ts
describe('setUserLayerRows and the !!js spelling (F-9)', () => {
  it('writes an existing !!js scalar back as !!js, not as __jsExpr', async () => {
    // Measured: `apiKey: !!js process.env.DEEPSEEK_API_KEY` came back as
    // `apiKey:\n  __jsExpr: process.env.DEEPSEEK_API_KEY`. Functionally
    // equivalent (the loader's isJsExpr is shape-based), but every toggle
    // rewrote the user's own file into an undocumented spelling.
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-jsexpr-'))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), [
      '- id: provider-row',
      '  config:',
      '    apiKey: !!js process.env.DEEPSEEK_API_KEY',
      '',
    ].join('\n'))

    setUserLayerRows({ profileDir, rows: [{ id: 'hello-row', disabled: true }] })

    const written = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(written).toContain('!!js process.env.DEEPSEEK_API_KEY')
    expect(written).not.toContain('__jsExpr')
    // The new row landed beside the preserved one.
    expect(written).toContain('hello-row')
    rmSync(profileDir, { recursive: true, force: true })
  })

  it('still writes a plain row unchanged', () => {
    const profileDir = mkdtempSync(join(tmpdir(), 'dsh-jsexpr-plain-'))
    setUserLayerRows({ profileDir, rows: [{ id: 'a', disabled: true }, { id: 'b', disabled: false }] })
    // `disabled: false` means "let the bundle default rule", so only `a` is
    // written — the pre-existing behaviour, restated here because this task
    // replaces the writer.
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe('- id: a\n  disabled: true\n')
    rmSync(profileDir, { recursive: true, force: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/profile.test.ts -t "!!js spelling"` — Expected: FAIL — the written file contains `__jsExpr: process.env.DEEPSEEK_API_KEY` and not `!!js`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/profile.ts`, replace the `js-yaml` import (line 6) and add the writer schema above `setUserLayerRow`:

```ts
import { DEFAULT_SCHEMA, Type, dump } from 'js-yaml'
```

```ts
/**
 * The loader's `!!js` expression spelling, so a user layer that carries one
 * comes back the way it went in.
 *
 * app-boot's `loadOptionalPatches` constructs a `!!js <expr>` scalar as
 * `{ __jsExpr: <expr> }` — the loader's own `isJsExpr` is shape-based — and
 * js-yaml's default writer has no idea that shape is a tag, so a rewrite
 * turned `apiKey: !!js process.env.DEEPSEEK_API_KEY` into a nested
 * `__jsExpr:` mapping. Equivalent to the loader, undocumented to the person
 * whose file it is (F-9).
 *
 * Comments are still lost: js-yaml parses to plain values and cannot carry
 * them. Preserving them needs a document-level YAML API (the `yaml` package,
 * which this package does not depend on) and a rewrite of this function; it
 * is recorded here rather than half-done.
 */
interface JsExpr { __jsExpr: string }

function isJsExpr(value: unknown): value is JsExpr {
  return typeof value === 'object' && value !== null
    && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
}

const JS_EXPR_TYPE = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (data: string): JsExpr => ({ __jsExpr: data }),
  predicate: isJsExpr,
  represent: (value: object) => (value as JsExpr).__jsExpr,
})

/** The writer's schema: js-yaml's default plus the `!!js` round trip. */
const USER_LAYER_SCHEMA = DEFAULT_SCHEMA.extend([JS_EXPR_TYPE])
```

and the dump (line 92). Before:

```ts
  writeFileSync(tmp, dump(next, { noRefs: true }))
```

After:

```ts
  writeFileSync(tmp, dump(next, { noRefs: true, schema: USER_LAYER_SCHEMA }))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/profile.test.ts tests/host/index.test.ts` — Expected: PASS. `DEFAULT_SCHEMA` is what `dump` already used, so every existing row's bytes are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/profile.ts packages/dsh-plugin-shop/tests/host/profile.test.ts
git commit -m "fix(host): keep the user layer's !!js spelling when rewriting it (F-9)"
```

---

### Task 23: A restricted `exports` map is not a missing peer

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/peers.ts:107-131` (`nodeResolver`)
- Test: `packages/dsh-plugin-shop/tests/host/peers.test.ts:94-120`

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Replace `throws when a package restricts ./package.json in its exports map` (`peers.test.ts:94-120`) — the claim it pins is the defect, so it is rewritten rather than adjusted, and append the two-peer case the audit asks for:

```ts
  it('treats a package that restricts ./package.json as present', () => {
    // `require.resolve('x/package.json')` throws ERR_PACKAGE_PATH_NOT_EXPORTED
    // for a package whose exports map does not list that subpath — but the
    // DIRECTORY was found, which is the only question this oracle asks.
    // Reporting it as unresolvable erased the whole entry's verdict and hid a
    // genuinely missing sibling (F-11).
    const dir = mkdtempSync(join(tmpdir(), 'noderesolver-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'restricted-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: 'restricted-pkg',
          version: '1.0.0',
          main: 'index.js',
          exports: { '.': './index.js' },
        }),
      )
      writeFileSync(join(pkgDir, 'index.js'), '')

      const resolveHere = nodeResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(resolveHere('restricted-pkg')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps a genuinely missing sibling\'s verdict beside a restricted package', () => {
    // The reported reproduction: `incompatibilityMap([{ peers: ['commander',
    // 'definitely-missing-peer'] }])` returned `{}`.
    const dir = mkdtempSync(join(tmpdir(), 'noderesolver-pair-'))
    try {
      const pkgDir = join(dir, 'node_modules', 'restricted-pkg')
      mkdirSync(pkgDir, { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: 'restricted-pkg', version: '1.0.0', main: 'index.js', exports: { '.': './index.js' },
      }))
      writeFileSync(join(pkgDir, 'index.js'), '')

      const resolveHere = nodeResolver(pathToFileURL(join(dir, 'anchor.js')).href)
      expect(incompatibilityMap(
        [{ source: 'npm', name: 'x', peers: ['restricted-pkg', 'definitely-missing-peer'] }],
        resolveHere,
      )).toEqual({ 'npm:x': ['definitely-missing-peer'] })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still throws for a resolution failure that is neither of those', () => {
    // The no-verdict path stays reachable: only MODULE_NOT_FOUND (absent) and
    // ERR_PACKAGE_PATH_NOT_EXPORTED (present) are verdicts.
    const throwing = nodeResolver('not-a-url')
    expect(() => throwing('anything')).toThrow()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/peers.test.ts -t "restricts ./package.json"` — Expected: FAIL with `ERR_PACKAGE_PATH_NOT_EXPORTED: Package subpath './package.json' is not defined by "exports"` thrown out of `resolveHere`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/host/peers.ts`, replace `nodeResolver` (lines 107-131). Before:

```ts
export function nodeResolver(baseUrl: string): PeerResolver {
  const require = createRequire(baseUrl)
  return spec => {
    try {
      require.resolve(`${spec}/package.json`)
      return true
    } catch (error) {
      // Only genuine module-not-found means the peer is absent. Anything else
      // (e.g., ERR_PACKAGE_PATH_NOT_EXPORTED when the module restricts
      // exports) is a resolution error that the harness itself handles by
      // returning no client module — rethrow so incompatibilityMap's catch
      // turns it into no-verdict.
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        return false
      }
      throw error
    }
  }
}
```

After:

```ts
export function nodeResolver(baseUrl: string): PeerResolver {
  const require = createRequire(baseUrl)
  return spec => {
    try {
      require.resolve(`${spec}/package.json`)
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Genuine module-not-found is the only "absent".
      if (code === 'MODULE_NOT_FOUND') return false
      // A modern package whose `exports` map does not list `./package.json`
      // is INSTALLED — resolution found the directory and then refused the
      // subpath. Rethrowing here erased the whole entry's verdict, so a
      // genuinely missing sibling in the same `peers` list was dropped with
      // it: `['commander', 'definitely-missing-peer']` answered `{}` (F-11).
      // Presence is the only question this oracle asks, and the answer is
      // yes.
      if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return true
      // Anything else is a resolution failure we cannot read as either
      // verdict; `incompatibilityMap`'s catch turns it into no verdict at
      // all, because one false warning teaches a reader to ignore every
      // warning.
      throw error
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/peers.test.ts tests/host/index.test.ts tests/client/web-full-flow.e2e.ts` — Expected: PASS. The e2e's `dsh-shop-e2e-peer` fixture declares `@deepseek-ai/dsh-client-store`, which is genuinely absent from that profile (MODULE_NOT_FOUND), so its badge assertion is unaffected.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/peers.ts packages/dsh-plugin-shop/tests/host/peers.test.ts
git commit -m "fix(host): a restricted exports map means present, not no-verdict (F-11)"
```

---

### Task 24: The boot-warm stash follows a refresh and expires

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/index.ts:30-37` (the stash), `:83-95` (the boot warm), `:97-115` (the injected `catalog`)
- Test: `packages/dsh-plugin-shop/tests/client/apply.client.spec.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `WARM_TTL_MS` exported from `src/client/index.ts` (the test reads it rather than hard-coding five minutes).

- [ ] **Step 1: Write the failing test**

Append to the `shop client apply warm` describe in `packages/dsh-plugin-shop/tests/client/apply.client.spec.tsx` (its imports gain `WARM_TTL_MS` from `../../src/client/index.ts`):

```ts
  it('serves the refreshed catalog to the next plain open, not the boot catalog', async () => {
    // A `refresh: true` result was RETURNED but not stashed, so after Refresh
    // showed builtAt 2 the next plain open handed back builtAt 1 again. The
    // comment claiming "freshness semantics are unchanged (§10)" was false.
    const second = { ...fakeCatalog, builtAt: '2026-08-28T00:00:00Z' }
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: fakeCatalog })
      .mockResolvedValue({ ok: true, value: second })
    const { injected } = await boot({ catalog })
    expect(await injected.catalog({ refresh: true })).toBe(second)
    expect(await injected.catalog(undefined)).toBe(second)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('re-asks the host once the stash outlives the freshness window', async () => {
    // There was no time bound at all, so a dsh running for days never
    // re-applied the host's five-minute freshness rule: every plain open
    // replayed the catalog fetched at boot.
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const { injected } = await boot({ catalog })
    expect(catalog).toHaveBeenCalledTimes(1)
    // Fake timers are installed AFTER boot so nothing in `apply` runs under
    // them; only `Date.now()` matters from here.
    vi.useFakeTimers({ now: Date.now() + WARM_TTL_MS + 1 })
    try {
      await injected.catalog(undefined)
      expect(catalog).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds the stash at the host\'s own freshness window', () => {
    expect(WARM_TTL_MS).toBe(5 * 60 * 1000)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/apply.client.spec.tsx -t "serves the refreshed catalog"` — Expected: FAIL with `expected { builtAt: '2026-08-27T00:00:00Z', … } to be { builtAt: '2026-08-28T00:00:00Z', … }` on the plain open, plus `does not provide an export named 'WARM_TTL_MS'`.

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/client/index.ts`, replace the stash declaration (lines 30-37). Before:

```ts
/** The boot-time warm fetch: the catalog the tab wants on its first open.
 * Started in apply — the client bundle boots with the web app, long before
 * the user reaches Settings — so the host's slow network fetch runs while
 * nobody is looking at the shop, and the tab's mount consumes this promise
 * instead of starting its own fetch. A rejection stays stored (the injected
 * catalog falls back to a fresh call); the extra catch keeps the
 * fire-and-forget from surfacing as an unhandled rejection. */
let warmCatalog: Promise<ShopCatalogResult> | null = null
```

After:

```ts
/** How long a stashed catalog may satisfy a plain open. The host re-checks
 * its own five-minute freshness on every call, so the stash must not outlive
 * that — otherwise a dsh running for days keeps replaying the catalog it
 * fetched at boot and the host's rule never runs (G-4). */
export const WARM_TTL_MS = 5 * 60 * 1000

/** The boot-time warm fetch: the catalog the tab wants on its first open.
 * Started in apply — the client bundle boots with the web app, long before
 * the user reaches Settings — so the host's slow network fetch runs while
 * nobody is looking at the shop, and the tab's mount consumes this promise
 * instead of starting its own fetch. A rejection stays stored (the injected
 * catalog falls back to a fresh call); the extra catch keeps the
 * fire-and-forget from surfacing as an unhandled rejection.
 *
 * Stamped with the time it was started, and REPLACED by every later result —
 * a refresh included. Returning a refresh without stashing it is what made
 * the next plain open show the boot catalog again. */
let warmCatalog: { at: number; result: Promise<ShopCatalogResult> } | null = null
```

Replace the boot warm (lines 89-93). Before:

```ts
  warmCatalog = null
  // Promise.resolve wraps the wire result so a stub or an ill-behaved
  // transport can never throw synchronously out of apply.
  warmCatalog = Promise.resolve(ns.catalog(undefined)).then(result => unwrap(result))
  void warmCatalog.catch(() => {})
```

After:

```ts
  warmCatalog = null
  // Promise.resolve wraps the wire result so a stub or an ill-behaved
  // transport can never throw synchronously out of apply.
  const warmed = Promise.resolve(ns.catalog(undefined)).then(result => unwrap(result))
  warmCatalog = { at: Date.now(), result: warmed }
  void warmed.catch(() => {})
```

Replace the injected `catalog` (lines 98-115). Before:

```ts
    catalog: async args => {
      // A refresh always goes to the wire; a plain open consumes the
      // boot-time fetch when it exists — the host's snapshot is the same
      // one a fresh call would serve, so freshness semantics are
      // unchanged (§10).
      if (args?.refresh === true) return unwrap(await ns.catalog(args))
      const warm = warmCatalog
      if (warm !== null) {
        try {
          return await warm
        } catch {
          // The boot-time fetch failed; a fresh call is the retry.
        }
      }
      const fresh = unwrap(await ns.catalog(args))
      warmCatalog = Promise.resolve(fresh)
      return fresh
    },
```

After:

```ts
    catalog: async args => {
      // Every result becomes the stash, a refresh included — and the stash
      // only satisfies a plain open inside WARM_TTL_MS, so the host's own
      // freshness rule is what decides after that (§10, G-4).
      if (args?.refresh === true) {
        const refreshed = unwrap(await ns.catalog(args))
        warmCatalog = { at: Date.now(), result: Promise.resolve(refreshed) }
        return refreshed
      }
      const warm = warmCatalog
      if (warm !== null && Date.now() - warm.at < WARM_TTL_MS) {
        try {
          return await warm.result
        } catch {
          // The stashed fetch failed; a fresh call is the retry.
        }
      }
      const fresh = unwrap(await ns.catalog(args))
      warmCatalog = { at: Date.now(), result: Promise.resolve(fresh) }
      return fresh
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/apply.client.spec.tsx` — Expected: PASS, including `warms the catalog at boot and serves the tab from the warm fetch` and `falls back to a fresh call when the boot-time warm fetch failed`.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/index.ts packages/dsh-plugin-shop/tests/client/apply.client.spec.tsx
git commit -m "fix(client): stash every catalog result and expire the boot warm (G-4)"
```

---

### Task 25: One collator, one shelf sort per catalog load

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts:319-331` (`sortByStars`)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx:916-938` (sort then filter), `:958` (`visible`), `:945-956` (the sentinel effect's deps)
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`

**Interfaces:**
- Consumes: `starsOf` with the `Object.hasOwn` guard (Task 10).
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/client/present.test.ts`:

```ts
describe('sortByStars cost (G-5)', () => {
  it('sorts 9,400 entries well inside a keystroke budget', () => {
    // `localeCompare(…, { sensitivity: 'base' })` builds a collator PER
    // COMPARISON: measured 291-314 ms per run on a synthetic 9,400-entry
    // catalog against 13-16 ms with a shared `Intl.Collator`. `filtered`
    // changes identity on every keystroke, so the first characters of any
    // query froze typing for about a third of a second.
    //
    // The bound is 60 ms — roughly 4x the collator figure, so a loaded CI box
    // has room, and 5x under the 291 ms this replaces, so the regression
    // cannot slip back in.
    const entries: CatalogEntry[] = Array.from({ length: 9400 }, (_, i) => ({
      ...entry,
      // A stable pseudo-shuffle, so the sort does real work rather than
      // walking an already-ordered list.
      name: `dsh-plugin-${(i * 7919) % 9400}`,
    }))
    const stars: Record<string, number> = Object.create(null)
    for (const [i, e] of entries.entries()) {
      if (i % 3 === 0) stars[e.name] = (i * 31) % 5000
    }
    const runs = 5
    const started = performance.now()
    for (let run = 0; run < runs; run += 1) sortByStars(entries, stars)
    const perRun = (performance.now() - started) / runs
    expect(perRun).toBeLessThan(60)
  })

  it('still tiebreaks case-insensitively on the name', () => {
    // The property the collator has to keep: the old comparator passed
    // `{ sensitivity: 'base' }`.
    const a = { ...entry, name: 'Beta' }
    const b = { ...entry, name: 'alpha' }
    expect(sortByStars([a, b], {}).map(e => e.name)).toEqual(['alpha', 'Beta'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/present.test.ts -t "sortByStars cost"` — Expected: FAIL with `expected 297.4 to be less than 60` (the figure varies by machine; the order of magnitude is the point).

- [ ] **Step 3: Write the implementation**

In `packages/dsh-plugin-shop/src/client/present.ts`, add the collator above `sortByStars` and use it (lines 319-331). Before:

```ts
/** Sort the shelf: stars descending, un-starred entries last, name ascending
 * (case-insensitive) on ties (spec 2026-08-26-github-stars-design.md D1).
 * Display-time only — the catalog's own name sort is untouched. */
export function sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[] {
  // -1, never 0: a repo with a real count of zero still sorts above an entry
  // the sidecar has no count for at all.
  const count = (e: CatalogEntry): number => starsOf(e, stars) ?? -1
  return [...entries].sort((a, b) => {
    const byStars = count(b) - count(a)
    if (byStars !== 0) return byStars
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}
```

After:

```ts
/** One collator for the whole shelf. `String.prototype.localeCompare` with an
 * options object builds a collator PER COMPARISON, and the comparator runs
 * ~9,400·log2(9,400) times: measured 291-314 ms per sort against 13-16 ms
 * here (G-5). Module scope is right — the shelf's ordering must not change
 * mid-session — and this is display-time only, so the catalog's own
 * code-unit name sort is untouched. */
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Sort the shelf: stars descending, un-starred entries last, name ascending
 * (case-insensitive) on ties (spec 2026-08-26-github-stars-design.md D1).
 * Display-time only — the catalog's own name sort is untouched. */
export function sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[] {
  // -1, never 0: a repo with a real count of zero still sorts above an entry
  // the sidecar has no count for at all.
  const count = (e: CatalogEntry): number => starsOf(e, stars) ?? -1
  return [...entries].sort((a, b) => {
    const byStars = count(b) - count(a)
    if (byStars !== 0) return byStars
    return NAME_COLLATOR.compare(a.name, b.name)
  })
}
```

In `packages/dsh-plugin-shop/src/client/ShopTab.tsx`, sort the browsable list ONCE per catalog load and filter the sorted list, rather than re-sorting the filtered list on every keystroke. Before (lines 916-938 and 958):

```ts
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return browsable.filter(entry => {
```
…
```ts
  }, [browsable, query, category, installedByKey])
  filteredLenRef.current = filtered.length

  // The shelf sorts by GitHub stars: the most-starred entries fill the first
  // batch, so a fresh visitor sees what the community uses most (§D1). The
  // stars sidecar is keyed by name; entries without a star count sort last.
  const stars = catalogState.kind === 'ready' ? catalogState.result.stars : {}
  const sorted = useMemo(() => sortByStars(filtered, stars), [filtered, stars])
```
…
```ts
  const visible = incremental ? sorted.slice(0, visibleCount) : sorted
```

After:

```ts
  // The shelf sorts by GitHub stars: the most-starred entries fill the first
  // batch, so a fresh visitor sees what the community uses most (§D1). The
  // sort runs ONCE per catalog load and the filter walks the sorted list —
  // sorting the FILTERED list re-ran a 9,400-entry sort on every keystroke
  // (G-5). Memoised on catalogState so the object identity is stable while a
  // query changes.
  const stars = useMemo(
    () => (catalogState.kind === 'ready' ? catalogState.result.stars : {}),
    [catalogState],
  )
  const sortedBrowsable = useMemo(() => sortByStars(browsable, stars), [browsable, stars])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sortedBrowsable.filter(entry => {
```
…
```ts
  }, [sortedBrowsable, query, category, installedByKey])
  filteredLenRef.current = filtered.length
```
…
```ts
  const visible = incremental ? filtered.slice(0, visibleCount) : filtered
```

(`Array.prototype.filter` preserves order, so the shelf's ordering is identical to before — this changes only how often the sort runs.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/present.test.ts tests/client/ShopTab.client.spec.tsx` — Expected: PASS, including `sorts the shelf by stars and renders the badge on starred entries` (`ShopTab.client.spec.tsx:950`), whose `['dsh-top', 'dsh-nostar']` order is unchanged.

Note what this task does NOT prove: filtering a sorted list and sorting a filtered list produce the same ORDER, so no DOM assertion can tell them apart. The discriminating assertion is the time bound on the pure function, which is what the audit asks for; the tab-level half is verified by the suite staying green (the order is unchanged) plus the `useMemo` dependency list, which no longer contains `query`.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/src/client/ShopTab.tsx packages/dsh-plugin-shop/tests/client/present.test.ts
git commit -m "perf(client): share one collator and sort the shelf once per load (G-5)"
```

---

### Task 26: A finished mutation refreshes the installed list, and one install flow serves both panels

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/useInstall.ts` (add `useInstallFlows`)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx:75-87` (`EntryCard` props), `:226-250` (its panels), `:286-306` (`InstallPanel` props), `:430-438` (`UninstallPanel` props), `:671-698` (`OutdatedRow`), `:707-748` (`OutdatedSection`), `:752-771` (tab state), `:870-884` (the installed effect), `:1240-1244`, `:1256-1267`
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `identityKey`/`entryKey` (Task 1), `InstallArgs` (Task 4), the identity-keyed maps (Task 8).
- Produces: `InstallFlow`, `UseInstallFlows`, `useInstallFlows(install, installStatus, onSettled?)`; `InstallPanel` takes `flow: InstallFlow` in place of `install`/`installStatus`; `EntryCard`, `OutdatedRow` and `OutdatedSection` take `flowFor: (key: string) => InstallFlow`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`:

```ts
  it('re-reads the installed list once an install reaches done (G-9)', async () => {
    // `installed()` re-ran only when `request` changed, so after an install,
    // uninstall or update reached `done` the Installed count, the Installed
    // filter and the Outdated section kept the PRE-mutation state until the
    // user found Refresh.
    const { injected, installed } = bench(snapshot({ tier: 'verified' }))
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(installed).toHaveBeenCalledTimes(1)
    fireEvent.click(container.querySelector('[data-shop-install]')!)
    // The default installStatus mock reports `done` on the first poll.
    await waitFor(() => expect(installed).toHaveBeenCalledTimes(2), { timeout: 3000 })
  })

  it('re-reads the installed list once an uninstall reaches done', async () => {
    const { injected, installed } = bench(snapshot(), [{ name: 'dsh-hello-plugin', installed: '1.2.0', latest: '1.2.0', outdated: false, enabled: true }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(installed).toHaveBeenCalledTimes(1)
    fireEvent.click(container.querySelector('[data-shop-uninstall]')!)
    await waitFor(() => expect(installed).toHaveBeenCalledTimes(2), { timeout: 3000 })
  })

  it('shows one install flow on both panels of an outdated entry', async () => {
    // An outdated package rendered two `InstallPanel`s — the card's and the
    // Outdated row's — each with its own `useInstall`, so finishing one left
    // the other still offering Update.
    const { injected } = bench(snapshot({ tier: 'verified' }), [{ name: 'dsh-hello-plugin', installed: '1.0.0', latest: '1.2.0', outdated: true, enabled: true }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText(en.installedSection)).toBeTruthy())
    expect(container.querySelectorAll('[data-shop-update]')).toHaveLength(2)
    fireEvent.click(container.querySelector('[data-shop-outdated-entry="dsh-hello-plugin"] [data-shop-update]')!)
    // Both panels leave the idle branch together: one flow, one identity.
    await waitFor(() => expect(container.querySelectorAll('[data-shop-update]')).toHaveLength(0))
  })

  it('keeps a running install when a search change unmounts its card', async () => {
    // The view lived inside the card, so filtering it off screen lost the
    // running install and the remounted card offered Install again.
    const result = snapshot({ tier: 'verified' })
    result.plugins = [
      { ...result.plugins[0]!, name: 'dsh-hello-plugin' },
      { ...result.plugins[0]!, name: 'dsh-other-plugin' },
    ]
    const { injected, installStatus } = bench(result)
    installStatus.mockResolvedValue({ found: true, state: 'running', log: ['working'] })
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-entry="dsh-hello-plugin"] [data-shop-install]')!)
    await waitFor(() => expect(screen.getByText(en.installing)).toBeTruthy())

    const search = screen.getByLabelText(en.search)
    fireEvent.change(search, { target: { value: 'other' } })
    await waitFor(() => expect(screen.queryByText('dsh-hello-plugin')).toBeNull())
    fireEvent.change(search, { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    // The install is still running, and the card does not offer Install.
    expect(container.querySelector('[data-shop-entry="dsh-hello-plugin"] [data-shop-install]')).toBeNull()
    expect(screen.getByText(en.installing)).toBeTruthy()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/client/ShopTab.client.spec.tsx -t "re-reads the installed list once an install reaches done"` — Expected: FAIL with `expected "installed" to be called 2 times, but got 1 time`; the flow-sharing case fails with two Update buttons still present, and the unmount case with the remounted card offering Install.

- [ ] **Step 3: Write the implementation**

Append to `packages/dsh-plugin-shop/src/client/useInstall.ts`:

```ts
/** One entry's install flow, as the tab hands it to a panel. */
export interface InstallFlow {
  view: InstallView
  start: (args: InstallArgs) => Promise<void>
}

export interface UseInstallFlows {
  /** The flow for one install identity. Two panels asking for the same key —
   * a shelf card and its Outdated row — get the same one. */
  flowFor: (key: string) => InstallFlow
}

/**
 * Every install flow the tab is driving, keyed by install identity.
 *
 * Two defects came from the state living inside the panel (G-9). An outdated
 * package renders two panels — its card's and its Outdated row's — each with
 * its own `useInstall`, so finishing one left the other still offering
 * Update. And a search change that filtered a card off screen unmounted its
 * hook, losing the running view and re-offering Install for an install that
 * was still going.
 *
 * `onSettled` fires when a flow reaches a terminal state, which is what the
 * tab uses to re-read `installed()`: without it the Installed count, the
 * Installed filter and the Outdated section kept the pre-mutation state
 * until the user found Refresh.
 */
export function useInstallFlows(
  install: (args: InstallArgs) => Promise<ShopInstallResult>,
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>,
  onSettled?: (key: string) => void,
): UseInstallFlows {
  const [views, setViews] = useState<ReadonlyMap<string, InstallView>>(() => new Map())
  // Held in a ref so a new callback identity on every tab render does not
  // re-subscribe the poll effect below.
  const settled = useRef(onSettled)
  settled.current = onSettled

  const put = useCallback((key: string, view: InstallView): void => {
    setViews((current) => {
      const next = new Map(current)
      next.set(key, view)
      return next
    })
  }, [])

  const apply = useCallback((key: string, event: InstallEvent): void => {
    setViews((current) => {
      const before = current.get(key) ?? { kind: 'idle' as const }
      const after = reduceInstall(before, event)
      if (after === before) return current
      const next = new Map(current)
      next.set(key, after)
      return next
    })
  }, [])

  const start = useCallback(async (key: string, args: InstallArgs): Promise<void> => {
    put(key, { kind: 'idle' })
    try {
      const result = await install(args)
      if (!result.ok) {
        put(key, { kind: 'rejected', code: result.code, detail: result.detail })
        return
      }
      put(key, { kind: 'running', installId: result.installId, log: [] })
    } catch {
      // A thrown install is a TRANSPORT failure (index.ts's unwrap throws the
      // prefixed wire code and message), not a business rejection: the
      // `rejected` state stays reserved for the host's ShopInstallResult
      // union (§7.2). The transport detail is private (it can name hosts and
      // ports) and never rendered, so the failed view carries an EMPTY detail
      // and ShopTab falls back to the localized line.
      put(key, { kind: 'failed', detail: '', log: [] })
    }
  }, [install, put])

  // ONE interval for every running flow. Each panel previously ran its own,
  // so an outdated entry polled the same install twice per second.
  useEffect(() => {
    const running: Array<[string, string]> = []
    for (const [key, view] of views) {
      if (view.kind === 'running') running.push([key, view.installId])
    }
    if (running.length === 0) return
    const timer = setInterval(() => {
      for (const [key, installId] of running) {
        void installStatus({ installId }).then((status) => {
          apply(key, { type: 'status', status })
          if (status.found && status.state !== 'running') settled.current?.(key)
        }, () => {
          // A poll failure is transient — the host retains the record, so the
          // next tick finds it. The rejection handler must be present: an
          // unhandled rejection here would escape the poll loop.
        })
      }
    }, INSTALL_POLL_MS)
    return () => clearInterval(timer)
  }, [views, installStatus, apply])

  const flowFor = useCallback((key: string): InstallFlow => ({
    view: views.get(key) ?? { kind: 'idle' },
    start: args => start(key, args),
  }), [views, start])

  return { flowFor }
}
```

and extend that module's imports (line 3-5):

```ts
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { INSTALL_POLL_MS, reduceInstall, type InstallEvent, type InstallView } from './present.ts'
import type { InstallArgs, ShopInstallResult, ShopInstallStatusResult } from '../host/index.ts'
```

In `packages/dsh-plugin-shop/src/client/ShopTab.tsx`:

(a) `InstallPanel` becomes controlled — replace `install`/`installStatus` with `flow` (lines 286-306 and 305). Before:

```ts
  variant?: 'install' | 'update'
  t: ShopTabProps['t']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
}): ReactNode {
  const [gateOpen, setGateOpen] = useState(false)
  const { view, start } = useInstall(install, installStatus)
```

After:

```ts
  variant?: 'install' | 'update'
  /** The tab owns this flow, keyed by install identity, so the card and the
   * Outdated row of one entry drive the same install (G-9). The gate stays
   * local: it belongs to the button that was pressed. */
  flow: InstallFlow
  t: ShopTabProps['t']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
}): ReactNode {
  const [gateOpen, setGateOpen] = useState(false)
  const { view, start } = flow
```

(b) `UninstallPanel` gains `onSettled` (lines 430-438), called when its view reaches `done`:

```ts
function UninstallPanel({ name, t, uninstall, installStatus, restart, restartSupported, onSettled }: {
  name: string
  t: ShopTabProps['t']
  uninstall: ShopTabInjected['uninstall']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
  /** Called once the uninstall settles, so the tab re-reads `installed()`. */
  onSettled: () => void
}): ReactNode {
  const { view, start } = useUninstall(uninstall, installStatus)
  useEffect(() => {
    if (view.kind === 'done') onSettled()
  }, [view.kind, onSettled])
```

(c) `EntryCard` swaps `install` for `flowFor` and gains `onSettled` (lines 75-87), and its action row reads the flow:

```ts
const EntryCard = memo(function EntryCard({ entry, stars, installed, missing, t, flowFor, installStatus, uninstall, restart, restartSupported, setEnabled, onSettled }: {
  entry: CatalogEntry
  stars: number | undefined
  installed: ShopInstalledEntry | undefined
  missing: string[]
  t: ShopTabProps['t']
  /** Looked up rather than passed as a value: `flowFor`'s identity changes
   * only when a flow changes, so a keystroke does not break this memo. */
  flowFor: (key: string) => InstallFlow
  installStatus: ShopTabInjected['installStatus']
  uninstall: ShopTabInjected['uninstall']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
  setEnabled: ShopTabInjected['setEnabled']
  onSettled: () => void
}): ReactNode {
```

with `const flow = flowFor(entryKey(entry))` beside `installTarget`, and the three panel usages becoming `flow={flow}` / `onSettled={onSettled}` in place of `install={install} installStatus={installStatus}`:

```ts
          <InstallPanel target={installTarget} tier={entry.tier} missing={missing} missingStated flow={flow} t={t} restart={restart} restartSupported={restartSupported} />
```
```ts
              <InstallPanel target={installTarget} tier={entry.tier} variant="update" missing={missing} missingStated flow={flow} t={t} restart={restart} restartSupported={restartSupported} />
```
```ts
            <UninstallPanel name={entry.name} t={t} uninstall={uninstall} installStatus={installStatus} restart={restart} restartSupported={restartSupported} onSettled={onSettled} />
```

(d) `OutdatedRow` and `OutdatedSection` take `flowFor` in place of `install`/`installStatus`, and the row's panel reads `flowFor(identityKey(row))`:

```ts
        <InstallPanel
          target={{ name: row.name, version: row.latest, source: row.source, repo: row.repo, subdir: row.subdir }}
          tier={tier} variant="update" missing={missing} flow={flowFor(identityKey(row))} t={t} restart={restart} restartSupported={restartSupported}
        />
```

(e) the tab owns the flows and the nonce (after line 771's `const [request, setRequest] = useState<LoadRequest>({ kind: 'initial' })`):

```ts
  // Re-read `installed()` when a mutation settles, without re-fetching the
  // catalog: `request` drives both, and bumping it for an install would throw
  // the whole shelf away. A separate nonce is the narrow signal (G-9).
  const [mutations, setMutations] = useState(0)
  const noteMutation = useCallback(() => { setMutations(current => current + 1) }, [])
  const flows = useInstallFlows(install, installStatus, noteMutation)
```

(f) the installed effect's dependency list (line 884):

```ts
  }, [installed, request, mutations])
```

(g) the two render sites:

```ts
                <EntryCard entry={entry} stars={starsOf(entry, stars)} installed={installedByKey.get(entryKey(entry))} missing={missingByKey.get(entryKey(entry)) ?? []} t={t} flowFor={flows.flowFor} installStatus={installStatus} uninstall={uninstall} restart={restart} restartSupported={restartSupported} setEnabled={setEnabled} onSettled={noteMutation} />
```
```ts
      <OutdatedSection
        state={installedState}
        entriesByKey={entriesByKey}
        missingByKey={missingByKey}
        t={t}
        setEnabled={setEnabled}
        flowFor={flows.flowFor}
        restart={restart}
        restartSupported={restartSupported}
      />
```

(h) the imports on lines 7 and 11-12:

```ts
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
```
```ts
import { useInstallFlows, type InstallFlow } from './useInstall.ts'
```

`useInstall` itself stays exported and unchanged — `useUpdateSelf` builds on the same reducer and `apply.client.spec.tsx:118` drives it directly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/client/ShopTab.client.spec.tsx tests/client/apply.client.spec.tsx` and `npx tsc -p tsconfig.test.json --noEmit` — Expected: PASS and clean. Verified against the existing suite: every test that asserts a unique restart notice (`ShopTab.client.spec.tsx:214,242,256,294`) uses `bench(snapshot(...))` with no installed rows, so only one panel exists and sharing a flow cannot duplicate a notice; the four update tests (`:852,862,887,939`) assert only that `install` was called, before the first poll tick.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/useInstall.ts packages/dsh-plugin-shop/src/client/ShopTab.tsx packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx
git commit -m "fix(client): re-read installed on a settled mutation and share one flow per identity (G-9)"
```

---

### Task 27: The inherited environment is a recorded residual, not a silent one

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts` (the comment at the spawn)
- Test: `packages/dsh-plugin-shop/tests/host/executor.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

F-12 is a **documentation and behaviour-lock task, not a code change**, and here is why each candidate change was rejected rather than deferred:

- **Filtering the environment is not safe.** The child is `dsh`, which needs `PATH`, `HOME`, `APPDATA`, the proxy variables, `npm_config_*` and the user's own pnpm settings to install anything. An allowlist would break real installs on unknown machines, and a denylist cannot work because the shop cannot tell which variables came from a `.env` that dsh loaded through `loadLayeredEnv` and which came from the user's shell — `process.env` has no provenance.
- **`--ignore-scripts` is not ours to pass.** pnpm 10+ already blocks build scripts by default and the shop never writes `allowBuilds` — that stays the user's explicit decision in the CLI (§7.2). Passing an install flag on the user's behalf changes install semantics for everyone, including profiles where they have deliberately approved builds.

So the trade-off gets written down where the decision lives, and pinned by a test so a future change to it is deliberate.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/executor.test.ts`:

```ts
describe('the child environment (F-12 residual)', () => {
  it('passes the parent environment to the child, deliberately', async () => {
    // Design-acknowledged residual: the child inherits the full
    // `process.env`, including any `.env` secrets dsh loaded via
    // `loadLayeredEnv`, and only pnpm's default script block stands between
    // them and a plugin's lifecycle scripts — a profile where the user has
    // approved builds loses that barrier. Filtering is not safe (dsh needs
    // PATH, HOME, the proxy variables and the user's pnpm config, and
    // `process.env` carries no provenance) and `--ignore-scripts` is the
    // user's decision, not ours (§7.2). Locked here so changing it is a
    // deliberate act with a failing test in front of it.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-env-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, ['#!/bin/sh', `printf '%s\\n' "$SHOP_F12_PROBE" > "${join(dir, 'env.txt')}"`, 'exit 0', ''].join('\n'))
    chmodSync(bin, 0o755)
    process.env.SHOP_F12_PROBE = 'inherited'
    try {
      await startInstall({ profile: 'env', spec: 'a@1.0.0', dshBin: bin }).finished
      expect(readFileSync(join(dir, 'env.txt'), 'utf8').trim()).toBe('inherited')
    } finally {
      delete process.env.SHOP_F12_PROBE
    }
  })

  it('uses only the given environment when one is passed', async () => {
    // The real-install test pins DSH_HOME this way, and the `env` option is
    // the seam a future narrowing would use.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-env-pinned-'))
    const bin = join(dir, 'dsh')
    writeFileSync(bin, ['#!/bin/sh', `printf '%s\\n' "$SHOP_F12_PROBE" > "${join(dir, 'env.txt')}"`, 'exit 0', ''].join('\n'))
    chmodSync(bin, 0o755)
    process.env.SHOP_F12_PROBE = 'inherited'
    try {
      await startInstall({ profile: 'env-pinned', spec: 'a@1.0.0', dshBin: bin, env: { PATH: process.env.PATH ?? '' } }).finished
      expect(readFileSync(join(dir, 'env.txt'), 'utf8').trim()).toBe('')
    } finally {
      delete process.env.SHOP_F12_PROBE
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/host/executor.test.ts -t "the child environment"` — Expected: PASS on the first run, and that is the point: this task locks behaviour that is already correct rather than changing it. If it FAILS, the environment is not being inherited as documented and the finding needs re-reading before anything else here is trusted.

- [ ] **Step 3: Write the implementation**

Extend the comment on the `env` line inside the `spawn` call in `packages/dsh-plugin-shop/src/host/executor.ts`. Before:

```ts
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: env ?? process.env,
```

After:

```ts
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // The child inherits the FULL environment, including any `.env`
        // secrets dsh loaded through `loadLayeredEnv`; only pnpm's default
        // script block stands between them and a plugin's lifecycle scripts,
        // and a profile where the user approved builds loses that barrier.
        // A design-acknowledged residual (F-12), kept on purpose:
        //  - filtering is not safe. dsh needs PATH, HOME, APPDATA, the proxy
        //    variables and the user's own npm/pnpm config to install
        //    anything, and `process.env` carries no provenance, so the shop
        //    cannot tell a `.env` secret from a shell variable.
        //  - `--ignore-scripts` is not ours to pass. pnpm 10+ blocks build
        //    scripts by default and `allowBuilds` stays the user's explicit
        //    decision in the CLI (§7.2).
        // `executor.test.ts`'s "the child environment (F-12 residual)" cases
        // pin both halves, so narrowing this is a deliberate act.
        env: env ?? process.env,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/host/executor.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/executor.ts packages/dsh-plugin-shop/tests/host/executor.test.ts
git commit -m "docs(host): record the inherited-environment residual and pin it (F-12)"
```

---

### Task 28: Release — 0.8.0-beta.0, proven by hand, then promoted

**Files:**
- Modify: `packages/dsh-plugin-shop/package.json:3` (version), twice
- Modify: `README.md:38,40,59`, `README.zh.md:36,38,56`, `packages/dsh-plugin-shop/README.md:38,40,70`, `packages/dsh-plugin-shop/docs/README.zh.md:36,38,63` (the promotion commit only)

**Interfaces:**
- Consumes: every task above.
- Produces: `dsh-plugin-shop@0.8.0` on `latest`.

**This release changes what the host reads and what the client sends.** `InstallArgs` gains `source`/`repo`/`subdir`, `ShopInstalledEntry` gains `source`/`repo`/`subdir`, `ShopCatalogResult.incompatible` is re-keyed, `InstallRejectionCode` gains a member, and `entrySchema` refuses catalog rows it used to accept. 0.5.0 through 0.5.2 each shipped straight to `latest` and each was broken for every user within minutes — a required field the live catalog did not have, a service shape we had guessed, an ownership key the loader does not use — and not one would have survived installing the build once, by hand, before promoting it. Hence a minor bump through `beta`.

- [ ] **Step 1: Green on everything, from a clean build**

```bash
pnpm test
pnpm typecheck
pnpm -C packages/dsh-plugin-shop test
pnpm -C packages/dsh-plugin-shop typecheck
rm -rf packages/dsh-plugin-shop/lib && pnpm -C packages/dsh-plugin-shop build
```

Expected: the root suite green; the package suite green at **at least 492 tests** plus everything added above (`test` and `typecheck --noEmit` both skip `lib/`, which is why the build is separate and comes before any pack).

- [ ] **Step 2: Prove the new `entrySchema` against the LIVE catalog before publishing anything**

The boundary grammar of Tasks 2 and 16 refuses rows it used to accept. If any of today's 9,422 live entries fails it, the shop's shelf goes dark for every user — the exact 0.5.0 failure. Run the real schema over the real bytes:

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
cat > /tmp/live-schema-check.ts <<'EOF'
import { loadCatalog } from '/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/packages/dsh-plugin-shop/src/host/catalog.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

const result = await loadCatalog({
  baseUrl: 'https://LivXue.github.io/dsh-plugin-shop/v1/',
  cacheDir: mkdtempSync(`${tmpdir()}/live-schema-`),
})
const entries = result.snapshot.entries
const github = entries.filter(e => e.source === 'github')
const tagged = github.filter(e => !/^[0-9a-f]{40}$/.test(e.version))
console.log(`parsed ${entries.length} entries; ${github.length} github, ${tagged.length} of them tag-versioned`)
EOF
node --experimental-strip-types /tmp/live-schema-check.ts
```

Expected: it prints a count near 9,422 with roughly 5,908 github entries and about 162 tag-versioned ones. **Any throw stops the release**: read the zod path it names, decide whether the grammar or the registry is wrong, and fix that before going further. Repeat the same command against the npm transport by pointing `origins` at `npmOrigin('https://registry.npmjs.org/', 'dsh-plugin-shop-catalog', fetch)` — both transports serve the same bytes (`transport-parity.test.ts`), so a disagreement here would itself be the finding.

- [ ] **Step 3: Pack and diff the file list against the published 0.7.4**

```bash
cd packages/dsh-plugin-shop
npm pack --dry-run --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const f=JSON.parse(s)[0].files.map(x=>x.path).sort();console.log(f.length);console.log(f.join('\n'))})" > /tmp/pack-0.8.0.txt
npm view dsh-plugin-shop@0.7.4 --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).dist.fileCount))"
head -1 /tmp/pack-0.8.0.txt
```

Expected: the published 0.7.4 reports **38** files; this pack reports **39**, the difference being exactly one new declaration file, `lib/types/shared/identity.d.ts`, from the new `src/shared/identity.ts`. Confirm it:

```bash
tail -n +2 /tmp/pack-0.8.0.txt | grep 'shared/'
```

Expected: `lib/types/shared/identity.d.ts` and `lib/types/shared/shop-like.d.ts`. **A count other than 39, or any other new or missing path, stops the release** — `files` in `package.json` is an allowlist and a module that lands outside it ships as a missing import at runtime (the 0.7.4 lesson).

- [ ] **Step 4: Bump to the prerelease and commit — READMEs untouched**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
node -e "const p='packages/dsh-plugin-shop/package.json';const fs=require('node:fs');const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='0.8.0-beta.0';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
git add packages/dsh-plugin-shop/package.json
git commit -m "chore: 0.8.0-beta.0 — an entry's identity is (source, name, repo, subdir)"
```

The prerelease version is mandatory for the beta tag: it keeps `latest` resolution away from this build even if the tag is ever mistyped, and semver orders a prerelease BELOW its own release, so the self-update check tells a beta tester to move to the stable build the moment it ships and never the other way. **README install pins track `latest`, so they do not move here** — a pinned prerelease in the README hands every reader the untested build. `registry/scripts/tests/readme-pins.test.ts` enforces exactly that.

- [ ] **Step 5: Publish the beta — REQUIRES THE USER'S EXPLICIT GO-AHEAD**

Do not run this without LivXue saying so in their own words. Stop here and ask.

```bash
cd packages/dsh-plugin-shop
npm publish --tag beta
npm view dsh-plugin-shop dist-tags --json
```

Expected: `dist-tags` shows `latest: 0.7.4` and `beta: 0.8.0-beta.0`. npm's registry reads lag right after a write, so verify with a cache-busted packument fetch rather than trusting `npm view` immediately:

```bash
curl -s "https://registry.npmjs.org/dsh-plugin-shop?cb=$(date +%s)" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['dist-tags']))"
```

- [ ] **Step 6: Install the beta by hand into a throwaway `DSH_HOME` and exercise what changed**

Never into a real profile. pnpm reuses a cached directory for `file:` paths, so install from the packed tarball, not the directory.

```bash
export DSH_HOME=/tmp/shop-0.8.0-probe
rm -rf "$DSH_HOME" && mkdir -p "$DSH_HOME"
npx -y @deepseek-ai/dsh plugin --profile probe add dsh-plugin-shop@0.8.0-beta.0
npx -y @deepseek-ai/dsh web --profile probe
```

Then, in the browser, confirm each of these by hand — they are the four things no fixture can prove:

1. **The duplicate-name case (G-1).** Search the shelf for a name the live catalog holds twice (`present.ts:286` records 151 such names; `dsh-skill-manager` is claimed by 14 repositories). Confirm every card renders, that each shows its own author, and that installing one lands `github:<that owner>/<slug>` in `$DSH_HOME/profiles/probe/package.json` — not a namesake's. Then confirm the Installed count and the Outdated section update without pressing Refresh (G-9).
2. **A killed mid-install (F-1).** Start an install of something large, find the `pnpm` child (`pgrep -f pnpm`), `kill -STOP` it, and confirm the install reports `failed` with the deadline detail rather than sitting `running` forever — with `DSH_SHOP_INSTALL_TIMEOUT_MS=20000` in the dsh environment so the wait is 20 s rather than 15 minutes. Then confirm a second install into the same profile starts (the queue is free) and that no `pnpm` process survives (`pgrep -f pnpm` is empty).
3. **A scoped hot mount (F-4).** Install a plugin whose bundle patch inserts a `@deepseek-ai/*` or other scoped module and confirm the result says the plugin is live, NOT that a restart is needed.
4. **A restart while an install runs (F-5).** Start an install, press Restart during it, and confirm the typed refusal renders and dsh keeps serving.

Record what each step actually did. A step that cannot be performed is a step that has not passed.

- [ ] **Step 7: Promote — REQUIRES THE USER'S EXPLICIT GO-AHEAD**

Only after Step 6 is done by hand and reported. Stop here and ask.

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store
node -e "const p='packages/dsh-plugin-shop/package.json';const fs=require('node:fs');const j=JSON.parse(fs.readFileSync(p,'utf8'));j.version='0.8.0';fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n')"
# All four README pins move HERE, in the same commit as the stable version.
sed -i 's/dsh-plugin-shop@0\.7\.4/dsh-plugin-shop@0.8.0/g' \
  README.md README.zh.md \
  packages/dsh-plugin-shop/README.md packages/dsh-plugin-shop/docs/README.zh.md
pnpm test   # readme-pins.test.ts lives in the ROOT suite and is the guard for exactly this commit
git add packages/dsh-plugin-shop/package.json README.md README.zh.md packages/dsh-plugin-shop/README.md packages/dsh-plugin-shop/docs/README.zh.md
git commit -m "chore: 0.8.0 — identity end to end, bounded reads, killable installs"
rm -rf packages/dsh-plugin-shop/lib && pnpm -C packages/dsh-plugin-shop build
cd packages/dsh-plugin-shop && npm publish
```

Expected: `readme-pins.test.ts` green (it fails when one README lags, when a prerelease reaches a README, and when a stable bump leaves the READMEs behind); `dist-tags.latest` becomes `0.8.0`, verified through the same cache-busted packument fetch as Step 5.

- [ ] **Step 8: Commit nothing else**

The publish steps produce no commit of their own. Confirm the tree is clean apart from the working tree's pre-existing Incompatible-badge change, which is not part of this release and stays where it is:

```bash
git status --short
```

---

## Finding → task map

| Finding | Task(s) |
|---|---|
| G-1 (name is not an identity, RPC and client) | 1, 4, 5, 6, 7, 8 |
| G-2 (the commit budget covered only `pointer()`) | 12 |
| G-3 (body reads outside the `TransportError` conversion) | 11 |
| G-4 (the boot-warm stash never expires, a refresh is not stashed) | 24 |
| G-5 (a full re-sort per keystroke) | 25 |
| G-6 / F-3 (unvalidated `name`/`version`/`repo`, tarball query) | 2, 3 |
| G-7 (two catalog loads at boot) | 9 |
| G-8 (`stars` reads `Object.prototype`) | 10 |
| G-9 (installed state stale after a mutation; two install panels) | 26 |
| G-10 / F-2 (uncapped bodies, unbounded `gunzipSync`) | 11, 13 |
| G-11 (a release-tag pin is dropped on read) | 16 |
| F-1 (no deadline, no kill, completion waits on inherited pipes) | 14 |
| F-4 (unquoted YAML in `renderRows`) | 17 |
| F-5 (`restart()` ignores in-flight installs) | 19 |
| F-6 (a chunk boundary splits a log line) | 15 |
| F-7 (the restart helper re-runs PATH `dsh`, no `'error'` listener) | 20 |
| F-8 (no deadline on the version check, registry hardcoded) | 21 |
| F-9 (the user layer is re-dumped, losing the `!!js` spelling) | 22 |
| F-10 (an unconfined package-declared patch path) | 18 |
| F-11 (`ERR_PACKAGE_PATH_NOT_EXPORTED` erases a verdict) | 23 |
| F-12 (the child inherits the full `process.env`) | 27 (documentation and behaviour lock) |
| Release (G-1 changes an RPC shape) | 28 |

## Residuals this plan leaves standing, on purpose

- **A self-consistent forged catalog.** The boundary grammar closes the argv-injection half of G-6/F-3; §9.2 still accepts that a compromised origin can serve a self-consistent catalog presenting an arbitrary package as `verified`, with `manifest.lock` as the only out-of-band check.
- **`github:` and `tarball` installs on Windows.** dsh's own `spawnSync('pnpm', args, { shell: true })` puts the `&`-bearing subpackage spec through cmd.exe. The shop's own spawns use no shell and every field feeding a spec is now grammar-checked, but the upstream fix is §13's, not ours.
- **Comments in `cordis.patch.yml`.** js-yaml parses to plain values, so a rewrite still drops the user's comments (Task 22 fixes only the `!!js` spelling). Preserving them needs the `yaml` package's document API and a rewrite of `setUserLayerRows`.
- **The install-time TOCTOU on a release tarball.** `verifyTarballSha256` checks the bytes at the check instant; pnpm re-fetches. Unchanged, and recorded in §7.2.
- **The inherited environment.** Task 27, with both rejected mitigations written down.
