# Audit fixes B — identity and trust (registry) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a listing's identity — not its bare name — the key that reviews, denials, the typosquatting hold, first-seen dates and every sort agree on, and make the three trust pins (version, commit, tarball sha256) all mean exact match.

**Architecture:** The central change is that a listing's identity is `(source, name, repo, subdir)`, not `name`: one new pure module `identity.ts` owns that string in the four shapes the pipeline needs (`repoUnit`, `installIdentity`, `firstSeenKey`, `compareEntries`), and every consumer is moved onto it. On top of that, `verified.yml` gains `repo:` so a GitHub review binds `(repo, commit)` instead of inheriting through a bundle name that up to 14 repositories claim, the npm hold learns the difference between "this package is reviewed" and "a name this package resembles is reviewed", and an LLM market verdict becomes a hold a human confirms rather than a silent, permanent delisting. Everything here is pure-core work driven by fixtures; the two impure touches (`npm-client.ts`'s projection, `github-client.ts`'s probe count) carry no policy.

**Tech Stack:** TypeScript 5.6 ESM (`.ts` extensions in local imports), Node 22/24 with `--experimental-strip-types`, vitest 2.1, zod 4.4, `yaml` 2.x, `semver` 7.6, `fastest-levenshtein` 1.0.16.

**Spec:** [docs/plans/2026-09-03-debug-audit.md](2026-09-03-debug-audit.md) — findings A-2, B-1, B-2, B-3/A-4, B-4, B-5/A-7, B-6, B-7, B-8, B-9, B-11, B-12, C-2, C-6/B-10/A-8, D-7, E-5. This plan is WP1's registry half plus all of WP2. The host half of WP1 (`installStart`, `installed()`, `validateInstall`, the client maps — finding G-1) is NOT in scope here: it changes an RPC shape and ships through `beta`.

## Global Constraints

- **A pure core, an impure shell.** `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`, `types.ts`, `repo-gate.ts`, `subpackage-select.ts`, `markets.ts`, `own.ts` and the new `identity.ts` take no clock, network, filesystem or environment. `build.ts` reads the clock exactly once (`build.ts:211`) and passes it down.
- **`verified` pins a version, a commit, or a tarball sha256 — never a name.** After Task 7 all three compare by exact equality; the npm pin is the last one that did not.
- **A review never attaches to a name.** After Task 2 a GitHub review carries `repo:` and is keyed by it; a bundle name only ever enters the typosquatting probe set.
- **Tiering and metadata are orthogonal.** `tier` answers "has a human read this?", `metadata` answers "did the author describe it?". Nothing in this plan couples them.
- **LLM output never gates a listing, removes an entry, or blocks a publish.** After Task 16 an LLM `market: true` is a review hold; only `by: human` withholds a listing.
- **Every rejection carries an author-readable `detail`.** Those strings are published and read by plugin authors; a wrong or misattributed reason is a defect. Tasks 12, 14 and 5 exist because of misattributed reasons.
- **Entries sort by identity before emit.** After Task 11 the comparator is `(name, source, repo ?? '', subdir ?? '')` and rejections sort by `(name, code, detail)`. Every comparison is code-unit; no `localeCompare`, no `Intl` (purity).
- **ESM everywhere**, `.ts` extensions on local relative imports, `"type": "module"`.
- **`strict` and `noUncheckedIndexedAccess` are on** (`tsconfig.json`). Guard index access; never assert it away. `noUnusedLocals` is off, but remove imports a change orphans anyway.
- **Files end with exactly one trailing newline** (`emit.test.ts:158-165` pins this for the artifacts).
- **`SIMILARITY_THRESHOLD = 2`** (`registry/scripts/src/gate.ts:13`). `DERIVED_SUMMARY_MAX_LENGTH = 200` (`gate.ts:20`). `MAX_SUBPACKAGES = 8` (`subpackage-select.ts:12`).
- **`fastest-levenshtein` is plain Levenshtein, not Damerau-Levenshtein**: a transposition costs 2, not 1, so a transposed pair sits exactly at the threshold. Any new fixture asserting a distance must be recomputed by hand — two fixtures in this repo shipped with wrong distances and passed for the wrong reason.
- **Baseline at `5f48787` (plan A merged): 24 test files, 611 tests, green in ~6 s; `pnpm typecheck` clean.** Every task ends with `pnpm test` and `pnpm typecheck` before its commit.
- **Registry-side only.** Nothing here changes an RPC shape or the host's parsing: `Entry.review` reaches the client through a non-strict zod object (`packages/dsh-plugin-shop/src/host/catalog.ts:73-82`, and `:164` "Do not add .strict()"), so the new `review.repo` field is additive and an installed 0.7.4 shop strips it. No package release is required; the changes ship on the next daily build.

---

### Task 1: `identity.ts` — one home for `(source, name, repo, subdir)`

**Files:**
- Create: `registry/scripts/src/identity.ts`
- Modify: `registry/scripts/src/repo-gate.ts:50-52`
- Modify: `registry/scripts/src/emit.ts:104-111`
- Modify: `CLAUDE.md:43`
- Test: `registry/scripts/tests/identity.test.ts` (new)

**Interfaces:**
- Consumes: `Entry`, `Rejection`, `RepoCandidate` from `./types.ts`.
- Produces: `repoUnit({ repo, subdir? }): string`, `installIdentity(entry): string`, `firstSeenKey(entry): string`, `compareEntries(a, b): number`, `compareRejections(a, b): number`, `compareStrings(a, b): number`. Tasks 10, 11, 16 and 17 all depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `registry/scripts/tests/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  compareEntries, compareRejections, compareStrings, firstSeenKey, installIdentity, repoUnit,
} from '../src/identity.ts'
import type { Entry, Rejection } from '../src/types.ts'

function npmEntry(name: string): Entry {
  return {
    name, version: '1.0.0', integrity: `sha512-${name}`, publishedAt: '2026-08-01T12:00:00.000Z',
    repository: `https://github.com/you/${name}`, license: 'MIT', tier: 'community',
    metadata: 'declared',
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    source: 'npm',
    added: '2026-08-01',
  }
}

function repoEntry(name: string, repo: string, subdir?: string): Entry {
  return {
    ...npmEntry(name),
    source: 'github',
    repo,
    ...(subdir === undefined ? {} : { subdir }),
  }
}

describe('repoUnit', () => {
  it('is the repo for a root candidate and repo#subdir for a subpackage', () => {
    // The unit an author acts on — the string repo-gate.ts already used for
    // every rejection name, now shared so the shadow row cannot drift from it.
    expect(repoUnit({ repo: 'someone/dsh-repo-plugin' })).toBe('someone/dsh-repo-plugin')
    expect(repoUnit({ repo: 'someone/monorepo', subdir: 'packages/sub-plugin' }))
      .toBe('someone/monorepo#packages/sub-plugin')
  })
})

describe('installIdentity', () => {
  it('separates the two install channels and the subpackages within one repo', () => {
    expect(installIdentity(npmEntry('dsh-x'))).toBe('npm:dsh-x')
    expect(installIdentity(repoEntry('dsh-x', 'good/dsh-x'))).toBe('github:good/dsh-x#')
    expect(installIdentity(repoEntry('dsh-x', 'good/mono', 'packages/a')))
      .toBe('github:good/mono#packages/a')
  })

  it('distinguishes two repositories publishing the same bundle name', () => {
    // 151 live names are shared by 243 entries; dsh-skill-manager is claimed
    // by 14 repositories. A name is not an identity.
    expect(installIdentity(repoEntry('dsh-foo', 'alice/dsh-foo')))
      .not.toBe(installIdentity(repoEntry('dsh-foo', 'bob/dsh-foo')))
  })
})

describe('firstSeenKey', () => {
  it('keys an npm entry by name and a repo entry by lowercased owner/slug', () => {
    // `owner/slug` carries a slash and never a leading `@`, so it cannot
    // collide with an npm name in the one first-seen map. Lowercased because
    // GitHub resolves repository names case-insensitively — a repo that
    // changes its casing must not read as a new listing and re-stamp `added`.
    expect(firstSeenKey(npmEntry('dsh-x'))).toBe('dsh-x')
    expect(firstSeenKey(repoEntry('dsh-x', 'good/dsh-x'))).toBe('good/dsh-x')
    expect(firstSeenKey(repoEntry('dsh-x', 'Good/DSH-X'))).toBe('good/dsh-x')
    // The npm name is NOT folded: an npm name is a distinct string, and npm
    // still serves legacy uppercase names.
    expect(firstSeenKey(npmEntry('DSH-Legacy'))).toBe('DSH-Legacy')
  })
})

describe('compareEntries', () => {
  it('orders by name first, then by the rest of the identity', () => {
    expect(compareEntries(npmEntry('dsh-a'), npmEntry('dsh-b'))).toBe(-1)
    // github sorts before npm on a name tie ('g' < 'n'), and two repos with
    // the same bundle name order by repo — the tie that kept input order and
    // made the content hash depend on the harvest order (C-2).
    expect(compareEntries(repoEntry('dsh-a', 'alice/x'), npmEntry('dsh-a'))).toBe(-1)
    expect(compareEntries(repoEntry('dsh-a', 'alice/x'), repoEntry('dsh-a', 'bob/x'))).toBe(-1)
    expect(compareEntries(repoEntry('dsh-a', 'a/mono', 'packages/a'), repoEntry('dsh-a', 'a/mono', 'packages/b')))
      .toBe(-1)
    expect(compareEntries(npmEntry('dsh-a'), npmEntry('dsh-a'))).toBe(0)
  })
})

describe('compareRejections', () => {
  it('breaks a name tie on the code and then the detail', () => {
    const a: Rejection = { name: 'a/b', code: 'no-bundle', detail: 'x' }
    const b: Rejection = { name: 'a/b', code: 'no-license', detail: 'x' }
    const c: Rejection = { name: 'a/b', code: 'no-bundle', detail: 'y' }
    expect(compareRejections(a, b)).toBe(-1)
    expect(compareRejections(a, c)).toBe(-1)
    expect(compareRejections(a, a)).toBe(0)
  })
})

describe('compareStrings', () => {
  it('compares by code unit, with no locale involved', () => {
    expect(compareStrings('a', 'b')).toBe(-1)
    expect(compareStrings('b', 'a')).toBe(1)
    expect(compareStrings('a', 'a')).toBe(0)
    // Code-unit order, not dictionary order: purity requires the same answer
    // under every LANG.
    expect(compareStrings('Z', 'a')).toBe(-1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/identity.test.ts` — Expected: FAIL with `Error: Failed to load url ../src/identity.ts` (the module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `registry/scripts/src/identity.ts`:

```ts
/**
 * A listing's identity, and the orderings built on it.
 *
 * The catalog's uniqueness rule is `npm:<name>` for npm entries and
 * `github:<repo>#<subdir>` for repository entries. Everything else in the
 * registry used to key on the bare `name`: reviews, denials, the similarity
 * hold, first-seen dates and every sort comparator. That mismatch is one
 * defect with many faces — 151 live names are shared by 243 entries and
 * `dsh-skill-manager` is claimed by 14 repositories — so the strings live
 * here, once, and every consumer imports them.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale
 * (every comparison is code-unit, so the artifacts are byte-identical under
 * any LANG).
 *
 * @module identity
 */
import type { Entry, Rejection } from './types.ts'

/** Code-unit comparison. Never `localeCompare`: a locale-aware order would
 * make the published bytes depend on the machine that built them. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The unit an author acts on for a repository candidate: the repo, or
 * `repo#subdir` for a monorepo subpackage. Rejection names, the shadow row
 * and `allowed-similar` reasoning all point at this string, so it has one
 * definition.
 */
export function repoUnit(candidate: { repo: string; subdir?: string }): string {
  return candidate.subdir === undefined ? candidate.repo : `${candidate.repo}#${candidate.subdir}`
}

/**
 * The install identity of an emitted entry — what `assertCatalogInvariants`
 * requires to be unique and what the Host must address an install by.
 * `repo` is optional on {@link Entry}, so a github entry that somehow lacks
 * it falls back to its name rather than emitting `github:undefined#`.
 */
export function installIdentity(entry: Pick<Entry, 'source' | 'name' | 'repo' | 'subdir'>): string {
  return entry.source === 'npm'
    ? `npm:${entry.name}`
    : `github:${entry.repo ?? entry.name}#${entry.subdir ?? ''}`
}

/**
 * The `first-seen.yml` key for an entry: the npm name, or the repository
 * `owner/slug`.
 *
 * Not the full install identity: `manifest.lock` records repo entries as
 * `owner/slug name version` with no subdir, so `owner/slug` is the finest
 * grain the committed history can prove a date for, and two subpackages of
 * one repository share the repository's first appearance. `owner/slug` always
 * contains a slash and never a leading `@`, so it cannot collide with an npm
 * name in the one map.
 *
 * The repo key is lowercased — GitHub resolves repository names
 * case-insensitively, so a repository that changes its casing must not read
 * as a new listing and re-stamp `added`. The npm name is not: an npm name is
 * a distinct string and the registry still serves legacy uppercase ones.
 * {@link installIdentity} does NOT fold, because that string is an install
 * target and must stay as published.
 */
export function firstSeenKey(entry: Pick<Entry, 'source' | 'name' | 'repo'>): string {
  return entry.source === 'npm' ? entry.name : (entry.repo ?? entry.name).toLowerCase()
}

/**
 * Total order on entries: the name first — that is the order a reader of
 * `plugins.json` expects and the one §7.1 names — then the rest of the
 * identity, so a tie can never fall back to the order npm or GitHub happened
 * to answer in.
 */
export function compareEntries(a: Entry, b: Entry): number {
  return compareStrings(a.name, b.name)
    || compareStrings(a.source, b.source)
    || compareStrings(a.repo ?? '', b.repo ?? '')
    || compareStrings(a.subdir ?? '', b.subdir ?? '')
}

/**
 * Total order on rejections. The name alone is not unique — one monorepo can
 * emit several rows under one repo, and one name can be rejected by both
 * channels — so the code and the author-readable detail break the tie.
 */
export function compareRejections(a: Rejection, b: Rejection): number {
  return compareStrings(a.name, b.name)
    || compareStrings(a.code, b.code)
    || compareStrings(a.detail, b.detail)
}
```

In `registry/scripts/src/repo-gate.ts`, replace lines 50-52:

```ts
  // The unit an author acts on: the repo, or `repo#subdir` for a monorepo
  // subpackage — rejection names must point at the thing to fix.
  const unit = candidate.subdir === undefined ? candidate.repo : `${candidate.repo}#${candidate.subdir}`
```

with:

```ts
  // The unit an author acts on: the repo, or `repo#subdir` for a monorepo
  // subpackage — rejection names must point at the thing to fix. Shared with
  // pipeline.ts's shadow row so the two spellings cannot drift (C-6).
  const unit = repoUnit(candidate)
```

and add to its imports, after line 4 (`import { DERIVED_SUMMARY_MAX_LENGTH, SIMILARITY_THRESHOLD } from './gate.ts'`):

```ts
import { repoUnit } from './identity.ts'
```

In `registry/scripts/src/emit.ts`, replace lines 104-111:

```ts
  const identities = new Set<string>()
  for (const entry of entries) {
    const key = entry.source === 'npm'
      ? `npm:${entry.name}`
      : `github:${entry.repo ?? entry.name}#${entry.subdir ?? ''}`
    if (identities.has(key)) throw new Error(`catalog invariant: duplicate install identity ${key}`)
    identities.add(key)
  }
```

with:

```ts
  const identities = new Set<string>()
  for (const entry of entries) {
    const key = installIdentity(entry)
    if (identities.has(key)) throw new Error(`catalog invariant: duplicate install identity ${key}`)
    identities.add(key)
  }
```

and add to `emit.ts`'s imports, after line 1 (`import { createHash } from 'node:crypto'`):

```ts
import { installIdentity } from './identity.ts'
```

In `CLAUDE.md`, replace line 43:

```
- Pure: `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`, `types.ts`. No clock, no network, no filesystem, no environment. Every policy decision lives here, which is why fixtures can drive all of it.
```

with:

```
- Pure: `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`, `types.ts`, `identity.ts`. No clock, no network, no filesystem, no environment — and no locale: every comparison is code-unit, because a locale-aware sort would make the published bytes depend on the machine. Every policy decision lives here, which is why fixtures can drive all of it.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/identity.test.ts` — Expected: PASS (7 tests).
Run: `npx vitest run registry/scripts/tests/emit.test.ts registry/scripts/tests/repo-gate.test.ts` — Expected: PASS, unchanged (this step is a pure refactor: `installIdentity` and `repoUnit` produce the same strings the inlined expressions did).
Run: `pnpm test` — Expected: PASS, 23 files / 341 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/identity.ts registry/scripts/tests/identity.test.ts registry/scripts/src/repo-gate.ts registry/scripts/src/emit.ts CLAUDE.md
git commit -m "refactor(registry): one module owns the (source, name, repo, subdir) identity"
```

---

### Task 2: a GitHub review binds `(repo, commit)`, not a bundle name

Findings B-2 (part 1) and B-3 / A-4. `verified.yml` is empty today, which is exactly why this is the moment: the first review recorded under the old shape would be wrong the day it was written. Today `bob/dsh-repo-plugin` at a commit nobody reviewed lists as `verified-stale` carrying `reviewer: github:alice-reviewer`, and at Alice's reviewed commit lists as `verified` and skips the install acknowledgement.

The config re-keying and the `assignRepoTier` lookup are one task on purpose: re-keying alone would leave `assignRepoTier` asking for a key that no longer exists, and the suite would be red between two commits.

**Files:**
- Modify: `registry/scripts/src/types.ts:143-159`
- Modify: `registry/scripts/src/config.ts:8-19`, `:53-75`, `:104-134`, `:159`
- Modify: `registry/scripts/src/tier.ts:49-51`, `:56-71` (doc), `:74`
- Modify: `registry/verified.yml` (header comment only; the list stays `[]`)
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` §7.1 step 5
- Modify: `docs/design/2026-08-30-github-install-channel.md` §7
- Modify: `CLAUDE.md:53`, `CLAUDE.md:63`
- Test: `registry/scripts/tests/config.test.ts`, `registry/scripts/tests/tier.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `Review.repo?: string`; `RegistryConfig.verified: Map<string, Review>` **re-keyed** — an npm review by its package `name`, a GitHub review by its lowercased `repo`; `RegistryConfig.verifiedNames: Set<string>` — every package/bundle name a review covers, which is the typosquatting probe set. Tasks 4, 5, 8, 9 and 17 depend on both.

- [ ] **Step 1: Write the failing test**

Two existing fixtures declare a github pin with no `repo:` and must move to the new shape first, or their files stop parsing at all. In `registry/scripts/tests/config.test.ts`, replace the two tests at lines 107-121:

```ts
  it('accepts a verified entry pinned by commit for a repository', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  reviewedCommit: abc123def\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })
    expect(config.verified.get('dsh-hello-plugin')?.reviewedCommit).toBe('abc123def')
  })

  it('accepts a verified entry pinned by tarball sha256 for a release-rescued entry', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-hello-plugin\n  reviewedSha256: ${'a'.repeat(64)}\n  reviewer: github:someone\n  reviewCommit: abc\n`,
    })
    expect(config.verified.get('dsh-hello-plugin')?.reviewedSha256).toBe('a'.repeat(64))
  })
```

with:

```ts
  it('accepts a verified entry pinned by commit, keyed by the repository it covers', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-hello-plugin\n  repo: someone/hello\n  reviewedCommit: abc123def\n  reviewer: github:someone\n  reviewCommit: abc\n',
    })
    expect(config.verified.get('someone/hello')?.reviewedCommit).toBe('abc123def')
  })

  it('accepts a verified entry pinned by tarball sha256 for a release-rescued entry', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-hello-plugin\n  repo: someone/hello\n  reviewedSha256: ${'a'.repeat(64)}\n  reviewer: github:someone\n  reviewCommit: abc\n`,
    })
    expect(config.verified.get('someone/hello')?.reviewedSha256).toBe('a'.repeat(64))
  })
```

In `registry/scripts/tests/tier.test.ts`, the shared `config` (lines 10-52) declares two github pins with no `repo:`; give them the repository they cover. Replace:

```ts
    '- name: dsh-tagged-plugin',
    `  reviewedSha256: ${reviewedSha256}`,
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
```

with:

```ts
    '- name: dsh-tagged-plugin',
    '  repo: someone/dsh-tagged-plugin',
    `  reviewedSha256: ${reviewedSha256}`,
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
```

and replace:

```ts
    '- name: dsh-commit-pinned',
    `  reviewedCommit: ${commit}`,
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
```

with:

```ts
    '- name: dsh-commit-pinned',
    '  repo: someone/dsh-commit-pinned',
    `  reviewedCommit: ${commit}`,
    '  reviewer: github:r',
    '  reviewCommit: abc',
    '  notes: fine',
```

`dsh-version-pinned` stays an npm review with no `repo`, which is exactly what the existing "does not transfer a version-only review pin onto a release entry" test needs.

Then append to `describe('assignRepoTier', ...)` in the same file, inside it so `repoAccepted` is in scope:

```ts
  it('gives a fork of the reviewed bundle name no tier and no review', () => {
    // B-3 / A-4: `bob/dsh-commit-pinned` at the commit ALICE reviewed used to
    // list as `verified` — acknowledgement skipped — and at any other commit
    // as `verified-stale` carrying Alice's byline. The review names a
    // repository; a bundle name is claimed by up to 14 of them.
    const base = repoAccepted('dsh-commit-pinned')
    const fork = { ...base, repo: { ...base.repo, repo: 'bob/dsh-commit-pinned' } }
    const entry = assignRepoTier(fork, config)
    expect(entry.tier).toBe('community')
    expect(entry.review).toBeUndefined()
  })

  it('finds the review whatever case the repository is spelled in', () => {
    const base = repoAccepted('dsh-commit-pinned')
    const cased = { ...base, repo: { ...base.repo, repo: 'Someone/dsh-commit-pinned' } }
    expect(assignRepoTier(cased, config).tier).toBe('verified')
  })
```

The fork needs no new first-seen row: `assignRepoTier` still keys `added` by the bundle name at this point, and `dsh-commit-pinned` already has one (`tier.test.ts:47-48`). Task 10 re-keys repo first-seen rows by `owner/slug` and rewrites that fixture then.

Append to `registry/scripts/tests/config.test.ts`, inside the existing `describe('parseRegistryConfig', ...)` block (after the `allowed-similar` test at line 95-98):

```ts
  it('keys a github review by the repository it covers, and an npm review by the package name', () => {
    // A GitHub review binds (repo, commit). 83 live bundle names are claimed
    // by both a fork and an original, so a review keyed by the bundle name
    // handed every fork the reviewer's verdict — and, at the reviewed commit,
    // the skipped install acknowledgement (B-3 / A-4).
    const config = parseRegistryConfig({
      ...empty,
      verified: [
        '- name: dsh-npm-plugin',
        '  reviewedVersion: 1.2.0',
        '  reviewer: github:someone',
        '  reviewCommit: abc1234',
        '- name: dsh-repo-plugin',
        '  repo: Alice/dsh-repo-plugin',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: github:someone',
        '  reviewCommit: abc1234',
      ].join('\n') + '\n',
    })
    expect(config.verified.get('dsh-npm-plugin')?.reviewedVersion).toBe('1.2.0')
    // Lowercased: GitHub resolves repository names case-insensitively, and
    // `own.ts` already folds case on the same string.
    expect(config.verified.get('alice/dsh-repo-plugin')?.reviewedCommit).toBe('a'.repeat(40))
    expect(config.verified.get('alice/dsh-repo-plugin')?.repo).toBe('Alice/dsh-repo-plugin')
    expect(config.verified.get('dsh-repo-plugin')).toBeUndefined()
    // The bundle name still reaches the typosquatting probe set: a lookalike
    // of a reviewed name is held whichever channel published it.
    expect([...config.verifiedNames].sort()).toEqual(['dsh-npm-plugin', 'dsh-repo-plugin'])
  })

  it('throws when a github review names no repo', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-repo-plugin\n  reviewedCommit: ${'a'.repeat(40)}\n  reviewer: r\n  reviewCommit: c\n`,
    })).toThrow(/verified\.yml.*repo: owner\/slug/s)
  })

  it('throws when a release review names no repo', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-repo-plugin\n  reviewedSha256: ${'a'.repeat(64)}\n  reviewer: r\n  reviewCommit: c\n`,
    })).toThrow(/verified\.yml.*repo: owner\/slug/s)
  })

  it('throws when an npm review carries a repo', () => {
    // An npm review is pinned by the version alone; a `repo:` on it would
    // read as a github review and never match anything.
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-npm-plugin\n  repo: a/b\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
    })).toThrow(/verified\.yml.*github review/s)
  })

  it('lets two repositories sharing a bundle name each hold their own review', () => {
    const config = parseRegistryConfig({
      ...empty,
      verified: [
        '- name: dsh-repo-plugin',
        '  repo: alice/dsh-repo-plugin',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: github:alice-reviewer',
        '  reviewCommit: abc',
        '- name: dsh-repo-plugin',
        '  repo: bob/dsh-repo-plugin',
        `  reviewedCommit: ${'b'.repeat(40)}`,
        '  reviewer: github:bob-reviewer',
        '  reviewCommit: def',
      ].join('\n') + '\n',
    })
    expect(config.verified.get('alice/dsh-repo-plugin')?.reviewer).toBe('github:alice-reviewer')
    expect(config.verified.get('bob/dsh-repo-plugin')?.reviewer).toBe('github:bob-reviewer')
  })

  it('throws on two reviews of the same repository', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: [
        '- name: dsh-repo-plugin',
        '  repo: alice/dsh-repo-plugin',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: r',
        '  reviewCommit: c',
        '- name: dsh-other-name',
        '  repo: Alice/dsh-repo-plugin',
        `  reviewedCommit: ${'b'.repeat(40)}`,
        '  reviewer: r',
        '  reviewCommit: d',
      ].join('\n') + '\n',
    })).toThrow(/verified\.yml.*duplicate entry for alice\/dsh-repo-plugin/s)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/config.test.ts -t "keys a github review by the repository it covers"` — Expected: FAIL with `verified.yml: 1 Unrecognized key: "repo"` (the schema is `.strict()`, so `repo:` is rejected before any keying question arises).

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/types.ts`, replace lines 143-159:

```ts
/**
 * A human review, pinned to the exact version (npm), commit (github), or
 * release tarball sha256 (github release rescue) it covered. Exactly one of
 * the three pins is present, matching the entry's source: trust never
 * inherits across unreviewed code on any source.
 */
export interface Review {
  reviewedVersion?: string
  reviewedCommit?: string
  /** For release-rescued entries, the pin is the tarball sha256 — the
   * content-addressed identity; the tag is display only, a mutable ref that
   * must never carry the trust. */
  reviewedSha256?: string
  reviewer: string
  reviewCommit: string
  notes: string
}
```

with:

```ts
/**
 * A human review, pinned to the exact version (npm), commit (github), or
 * release tarball sha256 (github release rescue) it covered. Exactly one of
 * the three pins is present, matching the entry's source: trust never
 * inherits across unreviewed code on any source.
 */
export interface Review {
  reviewedVersion?: string
  reviewedCommit?: string
  /** For release-rescued entries, the pin is the tarball sha256 — the
   * content-addressed identity; the tag is display only, a mutable ref that
   * must never carry the trust. */
  reviewedSha256?: string
  /**
   * `owner/slug` of the repository the review covers, as the reviewer wrote
   * it. Present exactly when the pin is a commit or a release sha256.
   *
   * A GitHub review binds `(repo, commit)`. A bundle name is not an identity:
   * 83 live bundle names are claimed by both a fork and an original, so a
   * review found by bundle name alone handed `bob/dsh-repo-plugin` the
   * verdict — and the reviewer's name — that a human wrote about
   * `alice/dsh-repo-plugin`, and at the reviewed commit it also handed it the
   * skipped install acknowledgement.
   */
  repo?: string
  reviewer: string
  reviewCommit: string
  notes: string
}
```

In `registry/scripts/src/config.ts`, replace lines 8-19:

```ts
const verifiedSchema = z.array(z.object({
  name: z.string().min(1),
  reviewedVersion: z.string().min(1).optional(),
  reviewedCommit: z.string().min(1).optional(),
  reviewedSha256: z.string().min(1).optional(),
  reviewer: z.string().min(1),
  reviewCommit: z.string().min(1),
  notes: z.string().default(''),
}).strict().refine(
  row => row.reviewedVersion !== undefined || row.reviewedCommit !== undefined || row.reviewedSha256 !== undefined,
  { message: 'declare reviewedVersion (npm), reviewedCommit (github), or reviewedSha256 (release tarball)' },
))
```

with:

```ts
const verifiedSchema = z.array(z.object({
  name: z.string().min(1),
  repo: z.string().min(1).optional(),
  reviewedVersion: z.string().min(1).optional(),
  reviewedCommit: z.string().min(1).optional(),
  reviewedSha256: z.string().min(1).optional(),
  reviewer: z.string().min(1),
  reviewCommit: z.string().min(1),
  notes: z.string().default(''),
}).strict().refine(
  row => row.reviewedVersion !== undefined || row.reviewedCommit !== undefined || row.reviewedSha256 !== undefined,
  { message: 'declare reviewedVersion (npm), reviewedCommit (github), or reviewedSha256 (release tarball)' },
).refine(
  // A github review binds (repo, commit): without the repo there is nothing
  // to bind it to, and the review would attach to a bundle name that up to 14
  // repositories claim.
  row => (row.reviewedCommit === undefined && row.reviewedSha256 === undefined) || row.repo !== undefined,
  { message: 'a github review must name the repository it covers: repo: owner/slug' },
).refine(
  // An npm review is pinned by the version alone. A `repo:` beside it would
  // be keyed as a github review and match nothing.
  row => row.reviewedVersion === undefined || row.repo === undefined,
  { message: 'repo: belongs to a github review (reviewedCommit / reviewedSha256), not to an npm review' },
))
```

In `registry/scripts/src/config.ts`, replace lines 54-57 of the `RegistryConfig` interface:

```ts
export interface RegistryConfig {
  /** Package name to its pinned review. */
  verified: Map<string, Review>
```

with:

```ts
export interface RegistryConfig {
  /**
   * Review index, keyed by the identity the review covers: an npm review by
   * its package `name`, a github review by its lowercased `repo`. The two
   * keyspaces cannot collide — `owner/slug` carries a slash and never a
   * leading `@` — so one map holds both, exactly as {@link denied} does.
   */
  verified: Map<string, Review>
  /**
   * Every package or bundle name a review covers. This — and never
   * {@link verified}'s keys — is the typosquatting hold's probe set: a
   * Levenshtein distance from an npm name to `owner/slug` is meaningless,
   * because the owner prefix drowns the distance.
   */
  verifiedNames: Set<string>
```

In `registry/scripts/src/config.ts`, replace lines 124-134:

```ts
  const verified = new Map<string, Review>()
  for (const row of parseFile('verified.yml', input.verified, verifiedSchema)) {
    setUnique(verified, 'verified.yml', row.name, {
      reviewedVersion: row.reviewedVersion,
      reviewedCommit: row.reviewedCommit,
      reviewedSha256: row.reviewedSha256,
      reviewer: row.reviewer,
      reviewCommit: row.reviewCommit,
      notes: row.notes,
    })
  }
```

with:

```ts
  const verified = new Map<string, Review>()
  const verifiedNames = new Set<string>()
  for (const row of parseFile('verified.yml', input.verified, verifiedSchema)) {
    // The key is the identity the review covers, so two repositories sharing
    // a bundle name can each hold their own review — and a second review of
    // the SAME repository still throws.
    const key = row.repo === undefined ? row.name : row.repo.toLowerCase()
    setUnique(verified, 'verified.yml', key, {
      reviewedVersion: row.reviewedVersion,
      reviewedCommit: row.reviewedCommit,
      reviewedSha256: row.reviewedSha256,
      repo: row.repo,
      reviewer: row.reviewer,
      reviewCommit: row.reviewCommit,
      notes: row.notes,
    })
    verifiedNames.add(row.name)
  }
```

In `registry/scripts/src/config.ts`, replace line 159:

```ts
  return { verified, denied, allowedSimilar, notAShop, marketsJudged, marketRows, categories, firstSeen }
```

with:

```ts
  return { verified, verifiedNames, denied, allowedSimilar, notAShop, marketsJudged, marketRows, categories, firstSeen }
```

In `registry/scripts/src/tier.ts`, replace lines 49-51:

```ts
  // A review whose only pin is a commit belongs to a repo entry of the same
  // bundle name, not to this npm candidate.
  if (review === undefined || review.reviewedVersion === undefined) return { ...base, tier: 'community' }
```

with:

```ts
  // Defence in depth: a github review is keyed by its repository now, so it
  // can no longer be reached by an npm name at all (config.ts). If one ever
  // were, a commit pin still says nothing about this npm package.
  if (review === undefined || review.reviewedVersion === undefined) return { ...base, tier: 'community' }
```

and replace line 74:

```ts
  const review = config.verified.get(repo.name)
```

with:

```ts
  // By repository, never by bundle name. A review binds (repo, commit): 83
  // live bundle names are claimed by both a fork and an original and
  // `dsh-skill-manager` by 14 repositories, so a name lookup handed every one
  // of them the verdict, the reviewer's byline and — at the reviewed commit —
  // the skipped install acknowledgement. Lowercased because GitHub resolves
  // repository names case-insensitively.
  const review = config.verified.get(repo.repo.toLowerCase())
```

and extend `assignRepoTier`'s doc comment by inserting, after "…and any other commit downgrades the entry to `verified-stale` while keeping the review.":

```
 * The review is found by the repository it names, never by the bundle name;
 * see {@link Review.repo}.
```

In `registry/verified.yml`, replace the whole file with:

```yaml
# Human review results. A review is pinned to the exact thing it covered and
# never to a name.
#
#   npm entry      reviewedVersion — the exact published version. Any other
#                  version, newer OR older, is verified-stale: a `latest`
#                  behind the review is what a hotfix published without --tag
#                  leaves behind, and an unpublish does the same.
#   github entry   repo + reviewedCommit. The review BINDS to the repository:
#                  a bundle name is claimed by up to 14 repositories, and 83
#                  live bundle names are shared by a fork and an original, so
#                  a review keyed by name would hand every fork the verdict.
#   release rescue repo + reviewedSha256 — the tarball's content hash, never
#                  the tag: a tag is a mutable ref an author can re-create on
#                  different content.
#
# - name: dsh-hello-plugin          # npm entry: reviewedVersion, no repo
#   reviewedVersion: 1.2.0
#   reviewer: github:someone
#   reviewCommit: abc1234
#   notes: Reads only the workspace; no network.
# - name: dsh-repo-plugin           # github entry: repo + reviewedCommit
#   repo: someone/dsh-repo-plugin
#   reviewedCommit: <40-hex commit>
#   reviewer: github:someone
#   reviewCommit: abc1234
#   notes: Reads only the workspace; no network.
# - name: dsh-repo-plugin           # github release-rescued: repo + reviewedSha256
#   repo: someone/dsh-repo-plugin
#   reviewedSha256: <64-hex sha256 of the reviewed release tarball>
#   reviewer: github:someone
#   reviewCommit: abc1234
#   notes: Reads only the workspace; no network.
[]
```

There is no data migration: `git log -1 --stat -- registry/verified.yml` and the file itself show the list is `[]`, so no recorded review has to be rewritten. That is the whole reason this change is cheap today and expensive after the first review.

In `docs/design/2026-08-18-dsh-plugin-shop-design.md` §7.1, replace this paragraph of step 5:

```
   `verified.yml` records `{ name, reviewedVersion, reviewedSha256, reviewer, reviewCommit, notes }`. If npm's latest exceeds `reviewedVersion`, the entry is **downgraded to `verified-stale`**, and the UI shows "reviewed v1.2.0 / current v1.3.0 unreviewed".
```

with:

```
   `verified.yml` records `{ name, repo?, reviewedVersion?, reviewedCommit?, reviewedSha256?, reviewer, reviewCommit, notes }`. Exactly one pin is present, and it selects the channel: `reviewedVersion` is an npm review and carries no `repo`; `reviewedCommit` and `reviewedSha256` are github reviews and MUST carry `repo`. If npm's latest exceeds `reviewedVersion`, the entry is **downgraded to `verified-stale`**, and the UI shows "reviewed v1.2.0 / current v1.3.0 unreviewed".

   **Amendment (2026-09-03, audit B-2 / B-3 / A-4): a github review binds `(repo, commit)`.** The review index is keyed by the identity the review covers — an npm review by its package name, a github review by its lowercased `owner/slug` — and `assignRepoTier` looks a review up by repository, never by bundle name. A bundle name is not an identity: 83 live bundle names are claimed by both a fork and an original, and `dsh-skill-manager` by 14 repositories, so a name lookup gave `bob/dsh-repo-plugin` the tier, the reviewer's name and (at the reviewed commit) the skipped acknowledgement that a human had written about `alice/dsh-repo-plugin`. Two repositories sharing a bundle name may each hold their own review; a second review of the same repository still throws. The reviewed repository is also **exempt from the typosquatting hold**, which previously rejected the very repository a human had reviewed as an impersonator of itself; every other repository carrying that bundle name is still held.
```

In `docs/design/2026-08-30-github-install-channel.md` §7, replace:

```
`community` by default. `verified` pins a **commit**, not a repo: the review
record for a GitHub entry carries `reviewedCommit` instead of
`reviewedVersion`, and a newer commit downgrades to `verified-stale` exactly as
a newer version does. The core invariant — trust never inherits across
unreviewed code — holds across both sources.
```

with:

```
`community` by default. `verified` pins a **commit** — and names the
repository that commit belongs to: the review record for a GitHub entry
carries `repo: owner/slug` plus `reviewedCommit` instead of
`reviewedVersion`, and any other commit downgrades to `verified-stale`
exactly as any other version does. The core invariant — trust never inherits
across unreviewed code — holds across both sources.

**Amendment (2026-09-03, audit B-3 / A-4):** the `repo` field is required, not
decorative. Without it the review was found by bundle name, so a fork
carrying the reviewed name inherited the tier and the reviewer's byline
(measured: 83 live bundle names are claimed by both a fork and an original).
`allowed-similar.yml` on this channel is likewise `owner/slug` and never a
bundle name: clearing a name cleared every repository using it.
```

In `CLAUDE.md`, replace line 53:

```
- **`verified` pins a version, never a name.** A published version newer than `reviewedVersion` downgrades to `verified-stale` and keeps the review. Attaching verification to a package name lets an author pass review once and inherit trust for every future version — the cheapest supply-chain attack there is.
```

with:

```
- **`verified` pins one exact artifact, never a name.** An npm review pins `reviewedVersion`, a github review pins `repo` + `reviewedCommit`, a release-rescued entry pins `repo` + `reviewedSha256`. Any other version, commit or tarball is `verified-stale` and keeps the review. Attaching verification to a package name lets an author pass review once and inherit trust for every future version — the cheapest supply-chain attack there is — and attaching it to a bundle name hands the same trust to every fork: 83 live bundle names are claimed by both a fork and an original.
```

In `CLAUDE.md`, replace line 63:

```
- A duplicate name in `verified.yml` or `denied.yml` throws. Last-one-wins would silently pick a review.
```

with:

```
- A duplicate identity in `verified.yml` or `denied.yml` throws — a repeated npm name, or a repeated `repo:`. Last-one-wins would silently pick a review. Two repositories sharing a bundle name are two identities and may each carry their own review; the same repository reviewed twice is a contradiction and throws.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/config.test.ts registry/scripts/tests/tier.test.ts` — Expected: PASS (35 + 26 tests). The existing "throws on a duplicate name in verified.yml" test (config.test.ts:139-153) still passes: both its rows are npm reviews, so both key on `dsh-hello-plugin`.
Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts registry/scripts/tests/gate.test.ts` — Expected: PASS. Both suites verify `dsh-fs-tool` by `reviewedVersion`, so their hold probes still find that name among `config.verified.keys()`. Note the one-commit window this leaves: a name verified by a github review is now keyed by its repo, so until Tasks 4 and 8 move both holds onto `verifiedNames`, a lookalike of a github-reviewed bundle name is not held. `verified.yml` is `[]`, so nothing is exposed in practice.
Run: `pnpm test` — Expected: PASS, 23 files / 349 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/config.ts registry/scripts/src/tier.ts registry/verified.yml registry/scripts/tests/config.test.ts registry/scripts/tests/tier.test.ts docs/design/2026-08-18-dsh-plugin-shop-design.md docs/design/2026-08-30-github-install-channel.md CLAUDE.md
git commit -m "feat(registry): a github review binds (repo, commit), not a bundle name"
```

---

### Task 3: shape-check every registry name row, and index repository denials case-folded

Finding E-5, first half (the second half — reporting a row that matched nothing — is Task 17, because it needs the harvest). `" dsh-evil "`, `dsh-evil\n` from a block scalar and a 300-character name all load today and can never equal an npm name, so a mistyped denial fails open with no signal.

**Files:**
- Modify: `registry/scripts/src/config.ts:8-32`, `:53-75`, `:135-142`, `:159`
- Test: `registry/scripts/tests/config.test.ts`

**Interfaces:**
- Consumes: `RegistryConfig.verified`/`verifiedNames` from Task 2.
- Produces: `RegistryConfig.deniedRepos: Map<string, { reason: string; replacement?: string }>` (lowercased `owner/slug` keys only) and `RegistryConfig.allowedSimilarRepos: Set<string>` (lowercased `owner/slug` entries only); the exported constants stay module-private. Tasks 5, 6, 9 and 17 depend on both names.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/config.test.ts`, inside `describe('parseRegistryConfig', ...)`:

```ts
  it('rejects a denial whose name is not a package name or an owner/slug', () => {
    // A padded, cased or newline-terminated name loads fine and then matches
    // nothing forever: the denial fails OPEN, which is the one direction a
    // denylist must never fail in.
    for (const name of ['" dsh-evil "', '"dsh evil"', '"dsh-evil\\n"', '"a/b/c"']) {
      expect(() => parseRegistryConfig({ ...empty, denied: `- name: ${name}\n  reason: Bad.\n` }),
        `denied.yml must reject ${name}`).toThrow(/denied\.yml/)
    }
  })

  it('accepts both denial forms: an npm name and a GitHub owner/slug', () => {
    const config = parseRegistryConfig({
      ...empty,
      denied: [
        '- name: dsh-evil-plugin\n  reason: Exfiltrates credentials.\n',
        '- name: "@scope/dsh-evil"\n  reason: Same code, scoped.\n',
        '- name: Someone/dsh-repo-plugin\n  reason: known bad actor\n',
      ].join(''),
    })
    expect(config.denied.get('dsh-evil-plugin')?.reason).toBe('Exfiltrates credentials.')
    expect(config.denied.get('@scope/dsh-evil')?.reason).toBe('Same code, scoped.')
    // The repo form also gets a case-folded index, because GitHub resolves
    // repository names case-insensitively and both gates read it.
    expect(config.deniedRepos.get('someone/dsh-repo-plugin')?.reason).toBe('known bad actor')
    expect(config.deniedRepos.has('dsh-evil-plugin')).toBe(false)
  })

  it('throws when two denials name the same repository in different cases', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      denied: '- name: Someone/dsh-x\n  reason: a\n- name: someone/dsh-x\n  reason: b\n',
    })).toThrow(/denied\.yml.*duplicate entry for someone\/dsh-x/s)
  })

  it('rejects a malformed allowed-similar row and indexes the repo form case-folded', () => {
    expect(() => parseRegistryConfig({ ...empty, allowedSimilar: '- " dsh-fs-tools "\n' }))
      .toThrow(/allowed-similar\.yml/)
    const config = parseRegistryConfig({ ...empty, allowedSimilar: '- dsh-fs-tools\n- Good/dsh-fs-tool\n' })
    expect(config.allowedSimilar.has('dsh-fs-tools')).toBe(true)
    expect([...config.allowedSimilarRepos]).toEqual(['good/dsh-fs-tool'])
  })

  it('rejects a review whose repo is not an owner/slug', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-x\n  repo: not-a-repo\n  reviewedCommit: ${'a'.repeat(40)}\n  reviewer: r\n  reviewCommit: c\n`,
    })).toThrow(/verified\.yml.*owner\/slug/s)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/config.test.ts -t "rejects a denial whose name is not a package name"` — Expected: FAIL with `AssertionError: denied.yml must reject " dsh-evil ": expected [Function] to throw an error` (every one of the four shapes parses today).

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/config.ts`, insert directly after the imports (after line 6, `import { CATEGORIES, type Category, type Review } from './types.ts'`):

```ts
/**
 * An npm package name as the registry can actually serve one: at most 214
 * characters, an optional `@scope/`, no whitespace, no control characters and
 * no leading `.` or `_`. Uppercase is permitted — npm refuses uppercase for
 * NEW packages but still serves the legacy ones, and a denial has to be able
 * to name one.
 */
const NPM_NAME = /^(?:@[A-Za-z0-9-~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$/

/**
 * A GitHub repository full name, `owner/slug`. Never a leading `@` and always
 * exactly one slash — which is what keeps the repo keyspace from colliding
 * with the npm keyspace inside `denied`, `verified` and `first-seen.yml`.
 */
const REPO_FULL_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/

/** A row that must name an npm package. */
const npmName = z.string().min(1).max(214).regex(
  NPM_NAME,
  'must be an npm package name: no spaces, no newlines, no leading dot or underscore, at most 214 characters',
)

/** A row that may name an npm package or a GitHub repository. */
const npmNameOrRepo = z.string().min(1).max(214).refine(
  value => NPM_NAME.test(value) || REPO_FULL_NAME.test(value),
  { message: 'must be an npm package name or a GitHub owner/slug: no spaces, no newlines, exactly one slash for a repo' },
)

/** A row that must name a GitHub repository. */
const repoFullName = z.string().min(1).max(140).regex(REPO_FULL_NAME, 'must be a GitHub owner/slug')
```

In the same file, change the three schemas' name fields. `verifiedSchema` (as Task 2 left it) gets:

```ts
  name: npmName,
  repo: repoFullName.optional(),
```

in place of:

```ts
  name: z.string().min(1),
  repo: z.string().min(1).optional(),
```

`deniedSchema` (lines 21-25) becomes:

```ts
const deniedSchema = z.array(z.object({
  name: npmNameOrRepo,
  reason: z.string().min(1),
  replacement: npmNameOrRepo.optional(),
}).strict())
```

`allowedSimilarSchema` (line 27) becomes:

```ts
const allowedSimilarSchema = z.array(npmNameOrRepo)
```

In `registry/scripts/src/config.ts`, replace lines 135-142:

```ts
  const denied = new Map<string, { reason: string; replacement?: string }>()
  for (const row of parseFile('denied.yml', input.denied, deniedSchema)) {
    setUnique(denied, 'denied.yml', row.name, {
      reason: row.reason,
      ...(row.replacement !== undefined ? { replacement: row.replacement } : {}),
    })
  }
  const allowedSimilar = new Set(parseFile('allowed-similar.yml', input.allowedSimilar, allowedSimilarSchema))
```

with:

```ts
  const denied = new Map<string, { reason: string; replacement?: string }>()
  const deniedRepos = new Map<string, { reason: string; replacement?: string }>()
  for (const row of parseFile('denied.yml', input.denied, deniedSchema)) {
    const value = {
      reason: row.reason,
      ...(row.replacement !== undefined ? { replacement: row.replacement } : {}),
    }
    setUnique(denied, 'denied.yml', row.name, value)
    // A denial written as `owner/slug` gets a second, case-folded index. Both
    // gates read it: the repo gate because GitHub resolves repository names
    // case-insensitively (B-8), and the npm gate because the author of a
    // denied repository can publish the same code to npm and win the bundle
    // name (B-6).
    if (REPO_FULL_NAME.test(row.name)) setUnique(deniedRepos, 'denied.yml', row.name.toLowerCase(), value)
  }
  const allowedSimilarRows = parseFile('allowed-similar.yml', input.allowedSimilar, allowedSimilarSchema)
  const allowedSimilar = new Set(allowedSimilarRows)
  // The repo-shaped clearances, case-folded. The GitHub channel honours ONLY
  // this set: a bundle-name clearance cleared every repository using the name
  // (A-4).
  const allowedSimilarRepos = new Set(
    allowedSimilarRows.filter(entry => REPO_FULL_NAME.test(entry)).map(entry => entry.toLowerCase()),
  )
```

Add the two fields to `RegistryConfig`, replacing lines 58-61 (as Task 2 left them):

```ts
  /** Package name to the reason it is excluded, plus the known replacement
   * when a human recorded one. */
  denied: Map<string, { reason: string; replacement?: string }>
  /** Names cleared past the similarity hold. */
  allowedSimilar: Set<string>
```

with:

```ts
  /** Package name to the reason it is excluded, plus the known replacement
   * when a human recorded one. Keyed as written. */
  denied: Map<string, { reason: string; replacement?: string }>
  /** The `owner/slug`-shaped denials, lowercased. Read by both gates: a
   * denial names a project, and a project has two published spellings. */
  deniedRepos: Map<string, { reason: string; replacement?: string }>
  /** Names cleared past the similarity hold, as written. */
  allowedSimilar: Set<string>
  /** The `owner/slug`-shaped clearances, lowercased — the only form the
   * GitHub channel honours. */
  allowedSimilarRepos: Set<string>
```

And the return statement:

```ts
  return {
    verified, verifiedNames, denied, deniedRepos, allowedSimilar, allowedSimilarRepos,
    notAShop, marketsJudged, marketRows, categories, firstSeen,
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/config.test.ts` — Expected: PASS (40 tests). Note the existing fixtures across the suite all use plain lowercase names and `someone/dsh-repo-plugin`-shaped repos, so none of them trips the new grammar.
Run: `pnpm test` — Expected: PASS, 23 files / 354 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/config.ts registry/scripts/tests/config.test.ts
git commit -m "fix(registry): shape-check every registry name row and index repo denials case-folded"
```

---

### Task 4: `reviewedVersion` is validated at load, and a name cannot be both reviewed and denied

Finding B-12. Today `reviewedVersion: one-point-two` loads and the build dies inside `tier` with `Invalid Version: one-point-two`, naming no file; and a name present in both `verified.yml` and `denied.yml` lets the denial win silently, leaving the review as dead text.

**Files:**
- Modify: `registry/scripts/src/config.ts:1-6` (import), the `verifiedSchema` `reviewedVersion` field, and `:159` (before the return)
- Test: `registry/scripts/tests/config.test.ts`

**Interfaces:**
- Consumes: `verified`, `verifiedNames`, `denied` from Tasks 2 and 3.
- Produces: the guarantee Task 7 relies on — `review.reviewedVersion` is always a canonical semver string, so an exact string comparison against `candidate.version` is a semver comparison.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/config.test.ts`, inside `describe('parseRegistryConfig', ...)`:

```ts
  it('names verified.yml when reviewedVersion is not a semver version', () => {
    // The build used to die in tier.ts with `Invalid Version:
    // one-point-two`, which names no file and no row.
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-x\n  reviewedVersion: one-point-two\n  reviewer: r\n  reviewCommit: c\n',
    })).toThrow(/verified\.yml: 0\.reviewedVersion.*semver/s)
  })

  it('requires the canonical semver spelling, so an exact comparison is a semver comparison', () => {
    // `v1.2.0` and `1.2.0+build` both mean 1.2.0 to semver but are different
    // strings; tier.ts compares strings (Task 7), so the file must carry the
    // canonical form or the review would silently never match.
    for (const version of ['v1.2.0', '1.2.0+build', '1.2']) {
      expect(() => parseRegistryConfig({
        ...empty,
        verified: `- name: dsh-x\n  reviewedVersion: ${version}\n  reviewer: r\n  reviewCommit: c\n`,
      }), `verified.yml must reject ${version}`).toThrow(/verified\.yml/)
    }
    const config = parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-x\n  reviewedVersion: 1.2.0-rc.9\n  reviewer: r\n  reviewCommit: c\n',
    })
    expect(config.verified.get('dsh-x')?.reviewedVersion).toBe('1.2.0-rc.9')
  })

  it('throws when a name is both reviewed and denied instead of letting the denial win silently', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: '- name: dsh-x\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '- name: dsh-x\n  reason: Exfiltrates credentials.\n',
    })).toThrow(/verified\.yml\/denied\.yml: dsh-x is both reviewed and denied/)
  })

  it('throws when a reviewed repository is also denied, in either case spelling', () => {
    expect(() => parseRegistryConfig({
      ...empty,
      verified: `- name: dsh-x\n  repo: Alice/dsh-x\n  reviewedCommit: ${'a'.repeat(40)}\n  reviewer: r\n  reviewCommit: c\n`,
      denied: '- name: alice/dsh-x\n  reason: known bad actor\n',
    })).toThrow(/is both reviewed and denied/)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/config.test.ts -t "names verified.yml when reviewedVersion is not a semver version"` — Expected: FAIL with `expected [Function] to throw an error` (the value loads as a plain non-empty string).

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/config.ts`, add to the imports after line 3 (`import { parse } from 'yaml'`):

```ts
import { valid as semverValid } from 'semver'
```

In `verifiedSchema`, replace:

```ts
  reviewedVersion: z.string().min(1).optional(),
```

with:

```ts
  // Canonical semver, checked here so the build fails with the FILE's name
  // rather than dying inside tier.ts with a bare `Invalid Version`. The
  // canonical form is required, not merely a parseable one: `assignTier`
  // compares this string to the published version exactly, so `v1.2.0` would
  // load and then never match anything.
  reviewedVersion: z.string().min(1).refine(
    value => semverValid(value) === value,
    { message: 'must be a canonical semver version — no leading v, no build metadata, e.g. 1.2.0' },
  ).optional(),
```

In `parseRegistryConfig`, insert immediately before the `return` statement:

```ts
  // A name cannot be reviewed and excluded at once. `gate` checks denial
  // before anything else, so the denial wins and the review becomes dead text
  // nobody notices — including the reviewer who wrote it. Both keyspaces are
  // compared case-folded, because a repository review and a repository denial
  // are both written `owner/slug`.
  const deniedKeys = new Set([...denied.keys()].map(key => key.toLowerCase()))
  for (const key of [...verified.keys(), ...verifiedNames]) {
    if (deniedKeys.has(key.toLowerCase())) {
      throw new Error(
        `verified.yml/denied.yml: ${key} is both reviewed and denied; the denial wins silently, so remove one of the two rows`,
      )
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/config.test.ts` — Expected: PASS (44 tests).
Run: `pnpm test` — Expected: PASS, 23 files / 358 tests. Every existing `reviewedVersion` fixture in the suite (`1.0.0`, `1.2.0`, `2.0.0`) is already canonical.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/config.ts registry/scripts/tests/config.test.ts
git commit -m "fix(registry): validate reviewedVersion at load and refuse a name that is both reviewed and denied"
```

---

### Task 5: the repo hold exempts the reviewed repository; `allowed-similar` is `owner/slug` there

Findings B-2 (part 2) and B-3 / A-4 (part 2). Today a `verified.yml` row for `someone/dsh-repo-plugin` makes `gateRepo` reject that very repository with "Exactly matches the verified package dsh-repo-plugin", and the only exit is a bundle-name clearance that clears every fork at once.

**Files:**
- Modify: `registry/scripts/src/repo-gate.ts:107-126`
- Modify: `registry/allowed-similar.yml` (header comment only; the list stays `[]`)
- Test: `registry/scripts/tests/repo-gate.test.ts`

**Interfaces:**
- Consumes: `RegistryConfig.verified` (keyed by lowercased repo, Task 2), `RegistryConfig.verifiedNames` (Task 2), `RegistryConfig.allowedSimilarRepos` (Task 3).
- Produces: `gateRepo` accepts the reviewed repository; nothing downstream changes shape.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/repo-gate.test.ts`, after the existing `describe('gateRepo', ...)` block:

```ts
describe('the hold and the reviewed identity', () => {
  const commitPin = 'b'.repeat(40)
  const reviewed = parseRegistryConfig({
    verified: [
      '- name: dsh-repo-plugin',
      '  repo: someone/dsh-repo-plugin',
      `  reviewedCommit: ${commitPin}`,
      '  reviewer: github:alice-reviewer',
      '  reviewCommit: abc',
      '  notes: fine',
    ].join('\n') + '\n',
    denied: '[]',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: '[]',
  })

  it('lists the repository the review names instead of rejecting it as an impersonator of itself', () => {
    // B-2: edits === 0 on the slug used to make the reviewed repo the "most
    // dangerous lookalike" of the review written about it, and the pipeline
    // listed nothing at all.
    const result = gateRepo(repo(), reviewed)
    expect(result.ok, result.ok ? '' : result.rejection.detail).toBe(true)
  })

  it('still holds a different repository carrying the reviewed bundle name', () => {
    // B-3 / A-4: this is the fork. It must not reach the catalog on the
    // strength of somebody else's review.
    const fork = gateRepo(repo({ repo: 'bob/dsh-repo-plugin' }), reviewed)
    expect(fork.ok).toBe(false)
    if (!fork.ok) {
      expect(fork.rejection.name).toBe('bob/dsh-repo-plugin')
      expect(fork.rejection.code).toBe('name-too-similar')
      expect(fork.rejection.detail).toContain('dsh-repo-plugin')
    }
  })

  it('clears a lookalike source by owner/slug and never by bundle name', () => {
    // A bundle-name clearance would clear every repository using the name —
    // 83 live bundle names are claimed by both a fork and an original.
    const byRepo = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '[]',
      allowedSimilar: '- good/dsh-fs-tol\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(gateRepo(repo({ repo: 'good/dsh-fs-tol', name: 'something-else' }), byRepo).ok).toBe(true)
    expect(gateRepo(repo({ repo: 'evil/dsh-fs-tol', name: 'something-else' }), byRepo).ok).toBe(false)

    const byName = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '[]',
      allowedSimilar: '- dsh-fs-tol\n',
      categories: '[]',
      firstSeen: '[]',
    })
    const held = gateRepo(repo({ repo: 'anyone/dsh-fs-tol', name: 'something-else' }), byName)
    expect(held.ok, 'a bundle-name clearance must not clear a repository').toBe(false)
  })

  it('exempts every subpackage of the reviewed repository, since the clearance unit is the repo', () => {
    const sub = gateRepo(repo({ subdir: 'packages/plugin' }), reviewed)
    expect(sub.ok, sub.ok ? '' : sub.rejection.detail).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts -t "lists the repository the review names"` — Expected: FAIL with `AssertionError: expected 'Exactly matches the verified package dsh-repo-plugin; only an explicitly allowed source may use that name; held for human adjudication.' ... expected false to be true`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/repo-gate.ts`, replace lines 107-126:

```ts
  // The typosquatting hold probes the slug (without the owner, whose prefix
  // would drown any distance) AND the bundle name: either can impersonate a
  // verified package. Unlike the npm gate — where an exact name IS the same
  // identity — an exact match here is a DIFFERENT identity claiming a
  // verified name, the most dangerous lookalike there is, so edits === 0
  // holds too. `allowed-similar.yml` is the human escape for a legitimate
  // source (e.g. the verified package's own repository).
  const slug = candidate.repo.split('/')[1] ?? candidate.repo
  if (!config.allowedSimilar.has(candidate.repo) && !config.allowedSimilar.has(candidate.name)) {
    for (const verifiedName of config.verified.keys()) {
      for (const probe of [slug, candidate.name]) {
        const edits = distance(probe, verifiedName)
        if (edits > SIMILARITY_THRESHOLD) continue
        return reject(unit, 'name-too-similar',
          edits === 0
            ? `Exactly matches the verified package ${verifiedName}; only an explicitly allowed source may use that name; held for human adjudication.`
            : `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
      }
    }
  }
```

with:

```ts
  // The typosquatting hold probes the slug (without the owner, whose prefix
  // would drown any distance) AND the bundle name: either can impersonate a
  // verified package. Unlike the npm gate — where an exact npm name IS the
  // same identity — an exact match here is a DIFFERENT identity claiming a
  // verified name, the most dangerous lookalike there is, so edits === 0
  // holds too.
  //
  // Two exits, and only two:
  //
  // 1. The repository the review itself names. A review binds (repo, commit),
  //    so this identity is the reviewed one and cannot be impersonating
  //    itself — without this exemption a `verified.yml` row for
  //    `someone/dsh-repo-plugin` rejected that repository with "Exactly
  //    matches the verified package dsh-repo-plugin" and the pipeline listed
  //    nothing (B-2). Every OTHER repository carrying the bundle name is
  //    still held, which is what stops the fork (B-3).
  // 2. `allowed-similar.yml`, by `owner/slug` ONLY. A bundle-name clearance
  //    cleared every repository using the name at once, and 83 live bundle
  //    names are claimed by both a fork and an original (A-4). Clearing a
  //    repo clears its subpackages with it: the review and the clearance are
  //    both statements about a source, and the subdirectory does not change
  //    who publishes it.
  const repoKey = candidate.repo.toLowerCase()
  const slug = candidate.repo.split('/')[1] ?? candidate.repo
  if (!config.verified.has(repoKey) && !config.allowedSimilarRepos.has(repoKey)) {
    for (const verifiedName of config.verifiedNames) {
      for (const probe of [slug, candidate.name]) {
        const edits = distance(probe, verifiedName)
        if (edits > SIMILARITY_THRESHOLD) continue
        return reject(unit, 'name-too-similar',
          edits === 0
            ? `Exactly matches the verified package ${verifiedName}; only an explicitly allowed source may use that name; held for human adjudication.`
            : `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
      }
    }
  }
```

Replace `registry/allowed-similar.yml` with:

```yaml
# Sources close enough to a verified name to trip the typosquatting gate,
# adjudicated by a human as legitimate. Listing something here only clears the
# similarity hold; it grants no trust tier.
#
# The unit differs per channel, because the identity does:
#
#   npm channel     the package name.
#   GitHub channel  `owner/slug` — the repository, never the bundle name. A
#                   bundle name is claimed by up to 14 repositories, so a
#                   name-shaped clearance cleared every fork at once. A repo
#                   clearance covers that repository's subpackages too.
#
# The repository a `verified.yml` row names needs no row here: a review binds
# (repo, commit), so the reviewed identity is exempt from the hold already.
#
# - dsh-fs-tools
# - good/dsh-fs-tool
[]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts` — Expected: PASS (19 tests). The existing "holds a lookalike slug AND a lookalike bundle name" test still passes: its config holds an npm review of `dsh-fs-tool`, so `verifiedNames` carries the name and no repo key matches.
Run: `pnpm test` — Expected: PASS, 23 files / 362 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/repo-gate.ts registry/allowed-similar.yml registry/scripts/tests/repo-gate.test.ts
git commit -m "fix(registry): the repo hold exempts the reviewed repository and clears by owner/slug"
```

---

### Task 6: case-fold repository names in the denial lookup and the hold probes

Finding B-8. `own.ts:51` and `github-repo.ts:38` fold case on repository full names; `repo-gate.ts` does not, so `denied someone/dsh-repo-plugin` misses the candidate `Someone/dsh-repo-plugin`, and a repository whose manifest name is `DSH-FS-TOOL` sits 9 edits from verified `dsh-fs-tool` (nine changed letters, the hyphens matching) and is admitted.

**Files:**
- Modify: `registry/scripts/src/repo-gate.ts:54-61`, and the hold loop as Task 5 left it
- Test: `registry/scripts/tests/repo-gate.test.ts`

**Interfaces:**
- Consumes: `RegistryConfig.deniedRepos` (Task 3), `RegistryConfig.verifiedNames` (Task 2).
- Produces: no new names.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/repo-gate.test.ts`:

```ts
describe('case folding on the GitHub channel', () => {
  it('matches a repo denial whatever case the repository is spelled in', () => {
    // GitHub resolves repository names case-insensitively, so `Someone/x` and
    // `someone/x` are one repository — and a denial that misses one of the
    // two spellings fails open.
    const denied = parseRegistryConfig({
      verified: '[]',
      denied: '- name: someone/dsh-repo-plugin\n  reason: known bad actor\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    const result = gateRepo(repo({ repo: 'Someone/dsh-repo-plugin' }), denied)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('denied')
      expect(result.rejection.detail).toBe('Denied by the registry: known bad actor')
    }
  })

  it('holds an uppercase bundle name that folds onto a verified name', () => {
    // Plain Levenshtein puts DSH-FS-TOOL nine edits from dsh-fs-tool — one
    // per changed letter — so the hold never saw it.
    const result = gateRepo(repo({ repo: 'someone/anything', name: 'DSH-FS-TOOL' }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('name-too-similar')
  })

  it('holds an uppercase slug that folds onto a verified name', () => {
    const result = gateRepo(repo({ repo: 'someone/DSH-FS-TOOL', name: 'something-else' }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('name-too-similar')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts -t "case folding on the GitHub channel"` — Expected: FAIL on all three: `expected true to be false` (the denial misses, and both uppercase probes are 9 edits away).

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/repo-gate.ts`, replace lines 54-57:

```ts
  // Denied by repo or by bundle name. `owner/slug` strings cannot collide
  // with npm package names (unscoped names carry no slash), so one map holds
  // both keyspaces.
  const denial = config.denied.get(candidate.repo) ?? config.denied.get(candidate.name)
```

with:

```ts
  // Denied by repo or by bundle name. `owner/slug` strings cannot collide
  // with npm package names (unscoped names carry no slash), so one map holds
  // both keyspaces.
  //
  // The repo side is case-folded, matching `own.ts` and `github-repo.ts`:
  // GitHub resolves repository names case-insensitively, so a denial written
  // in one case must catch every spelling of the same repository. The bundle
  // name is matched as written — an npm name is a distinct string — and a
  // mistyped name denial is caught by the matched-nothing report line instead
  // (E-5, Task 17).
  const denial = config.deniedRepos.get(candidate.repo.toLowerCase())
    ?? config.denied.get(candidate.name)
```

In the hold loop (as Task 5 left it), replace:

```ts
    for (const verifiedName of config.verifiedNames) {
      for (const probe of [slug, candidate.name]) {
        const edits = distance(probe, verifiedName)
```

with:

```ts
    for (const verifiedName of config.verifiedNames) {
      // Folded on both sides: a repository whose manifest name is
      // `DSH-FS-TOOL` sat nine edits — one per changed letter — from verified
      // `dsh-fs-tool` and sailed past a threshold of 2. The detail still
      // quotes the verified name as the reviewer wrote it.
      const target = verifiedName.toLowerCase()
      for (const probe of [slug.toLowerCase(), candidate.name.toLowerCase()]) {
        const edits = distance(probe, target)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts` — Expected: PASS (22 tests). The existing "denies by repo identity and by bundle name, preferring the repo as the key" test still passes: `someone/dsh-repo-plugin` is already lowercase, so `deniedRepos` holds it under the same key.
Run: `pnpm test` — Expected: PASS, 23 files / 365 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/repo-gate.ts registry/scripts/tests/repo-gate.test.ts
git commit -m "fix(registry): case-fold repository names in the repo denial lookup and hold probes"
```

---

### Task 7: an npm review means the reviewed version and no other

Finding B-1. `gt(candidate.version, review.reviewedVersion)` only downgrades NEWER versions, so `latest=1.1.0`, `latest=0.0.1` and `latest=1.2.0-rc.9` against `reviewedVersion=1.2.0` all render `verified` — and `install.ts:36` skips the acknowledgement for `verified`, so unreviewed code installs with no warning. A `latest` behind the review is exactly what a hotfix published without `--tag` leaves behind (the dsh-market incident, `docs/design/2026-08-31-market-borrowings.md` §C-2) and what an unpublish produces. The repo channel already compares exactly (`reviewedCommit !== repo.commit`, `reviewedSha256 === release.sha256`); this pin was the odd one out.

**Files:**
- Modify: `registry/scripts/src/tier.ts:1` (drop the import), `:18-29` (doc comment), `:52`
- Modify: `registry/scripts/tests/tier.test.ts:112-114` — **rewritten, not adjusted**
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` §7.1 step 5
- Modify: `CLAUDE.md:53`
- Test: `registry/scripts/tests/tier.test.ts`

**Interfaces:**
- Consumes: the canonical-semver guarantee from Task 4, which is what makes an exact string comparison a semver comparison.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

In `registry/scripts/tests/tier.test.ts`, **replace** the test at lines 112-114:

```ts
  it('treats a version older than the review as verified', () => {
    expect(assignTier(accepted('dsh-hello-plugin', '1.1.0'), config).tier).toBe('verified')
  })
```

with:

```ts
  // Rewritten 2026-09-03 (audit B-1). The old assertion — "treats a version
  // older than the review as verified" — PINNED the defect: `gt` only caught
  // newer versions, so anything at or below the reviewed version rendered
  // `verified` and skipped the install acknowledgement (host install.ts:36).
  // A `latest` behind the review is not a hypothetical: it is what a hotfix
  // published without `--tag` leaves behind (dsh-market incident,
  // 2026-08-31-market-borrowings §C-2) and what an unpublish produces. An npm
  // review now means the reviewed version and no other, exactly as the commit
  // and sha256 pins already did.
  it('downgrades a version OLDER than the review to verified-stale', () => {
    expect(assignTier(accepted('dsh-hello-plugin', '1.1.0'), config).tier).toBe('verified-stale')
  })

  it('downgrades a much older version to verified-stale and keeps the review', () => {
    const entry = assignTier(accepted('dsh-hello-plugin', '0.0.1'), config)
    expect(entry.tier).toBe('verified-stale')
    expect(entry.review?.reviewedVersion).toBe('1.2.0')
  })

  it('downgrades a prerelease of the reviewed version to verified-stale', () => {
    // 1.2.0-rc.9 sorts BELOW 1.2.0, so `gt` said "not newer" and the release
    // candidate inherited the verdict written about the release.
    expect(assignTier(accepted('dsh-hello-plugin', '1.2.0-rc.9'), config).tier).toBe('verified-stale')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/tier.test.ts -t "verified-stale"` — Expected: FAIL on the three new tests with `expected 'verified' to be 'verified-stale'`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/tier.ts`, delete line 1:

```ts
import { gt } from 'semver'
```

(nothing else in the module uses `semver` after this change).

Replace lines 18-29, the `assignTier` doc comment:

```ts
/**
 * Assign a trust tier to one accepted candidate.
 *
 * A review is pinned to the version it covered: when the published version is
 * newer than `reviewedVersion` the entry becomes `verified-stale` and keeps
 * the review, so a consumer can name both versions. Attaching verification to
 * a package name instead would let an author publish a malicious version and
 * inherit the trust automatically.
 * @param accepted - a candidate that passed the gate.
 * @param config - the human-authored registry files.
 * @returns the published catalog entry.
 */
```

with:

```ts
/**
 * Assign a trust tier to one accepted candidate.
 *
 * A review is pinned to the exact version it covered: any other published
 * version — newer OR older — makes the entry `verified-stale` and keeps the
 * review, so a consumer can name both versions. Attaching verification to a
 * package name instead would let an author publish a malicious version and
 * inherit the trust automatically.
 *
 * "Newer" is not the test, because a `latest` BEHIND the review is a real
 * shape: a hotfix published without `--tag` moves `latest` backwards (the
 * dsh-market incident, 2026-08-31-market-borrowings §C-2), and an unpublish
 * does the same. Under the old `gt` comparison every such version rendered
 * `verified` and the Host skipped its install acknowledgement.
 * @param accepted - a candidate that passed the gate.
 * @param config - the human-authored registry files.
 * @returns the published catalog entry.
 */
```

Replace line 52:

```ts
  const stale = gt(candidate.version, review.reviewedVersion)
```

with:

```ts
  // Exact match, like the commit and sha256 pins. A string comparison IS a
  // semver comparison here because `config.ts` requires `reviewedVersion` to
  // be the canonical spelling (no leading `v`, no build metadata), so the
  // only strings that differ are versions that differ. A version differing
  // only by build metadata reads as stale, which is the safe direction.
  const stale = candidate.version !== review.reviewedVersion
```

In `docs/design/2026-08-18-dsh-plugin-shop-design.md` §7.1 step 5, append after the 2026-09-03 amendment paragraph added in Task 2:

```
   **Amendment (2026-09-03, audit B-1): the npm pin is exact.** The rule was "if npm's latest exceeds `reviewedVersion`", which only downgraded newer versions: `latest=1.1.0`, `latest=0.0.1` and `latest=1.2.0-rc.9` against `reviewedVersion=1.2.0` all rendered `verified`, and the Host skips the install acknowledgement for `verified` alone. A `latest` behind the review is what a hotfix published without `--tag` produces and what an unpublish leaves behind. All three pins now compare by equality — version, commit, tarball sha256 — so the invariant reads the same on every channel: **`verified` means this exact artifact was read by a human, and nothing else.**
```

In `CLAUDE.md`, replace the bullet Task 2 wrote at line 53 with:

```
- **`verified` pins one exact artifact, never a name.** An npm review pins `reviewedVersion`, a github review pins `repo` + `reviewedCommit`, a release-rescued entry pins `repo` + `reviewedSha256`. All three compare by equality: any other version — newer OR older — is `verified-stale` and keeps the review, because a `latest` behind the review is what a hotfix published without `--tag` leaves behind. Attaching verification to a package name lets an author pass review once and inherit trust for every future version — the cheapest supply-chain attack there is — and attaching it to a bundle name hands the same trust to every fork: 83 live bundle names are claimed by both a fork and an original.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/tier.test.ts` — Expected: PASS (29 tests).
Run: `npx vitest run registry/scripts/tests/pipeline.test.ts` — Expected: PASS. `pipeline.test.ts:39-43` asserts `dsh-fs-tool` is `verified-stale` against `reviewedVersion: 1.0.0`; the fixture's version is higher, so the assertion holds for the same reason.
Run: `pnpm test` — Expected: PASS, 23 files / 367 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/tier.ts registry/scripts/tests/tier.test.ts docs/design/2026-08-18-dsh-plugin-shop-design.md CLAUDE.md
git commit -m "fix(registry): an npm review means the reviewed version and no other"
```

---

### Task 8: the npm hold skips only a package verified AS an npm package

Findings B-4 and A-2 — one condition answers both. `gate.ts:132` skips the hold whenever `edits === 0`, and iterates `config.verified.keys()`, so: two verified names one edit apart delist each other (B-4), and a name verified by a repository pin lets any npm publisher take it at distance 0, displace the verified GitHub entry via `shadowed-by-npm`, and inherit its shelf position and `added` date (A-2).

**Files:**
- Modify: `registry/scripts/src/gate.ts:129-136`
- Test: `registry/scripts/tests/gate.test.ts`

**Interfaces:**
- Consumes: `RegistryConfig.verified` (re-keyed, Task 2), `RegistryConfig.verifiedNames` (Task 2).
- Produces: no signature change to `gate`.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/gate.test.ts`, after the `describe('gate', ...)` block:

```ts
describe('the hold and the candidate own identity', () => {
  it('lists two verified names one edit apart instead of holding each against the other', () => {
    // B-4: verifying dsh-tool-a and dsh-tool-b — distance 1, the shape of a
    // same-author suite — removed BOTH from the catalog, each "Within 1
    // edit(s) of the verified package" the other. A review is already the
    // adjudication the hold asks for.
    const suite = parseRegistryConfig({
      verified: [
        '- name: dsh-tool-a\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
        '- name: dsh-tool-b\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      ].join(''),
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(gate(candidate({ name: 'dsh-tool-a' }), suite).ok).toBe(true)
    expect(gate(candidate({ name: 'dsh-tool-b' }), suite).ok).toBe(true)
  })

  const repoPinned = parseRegistryConfig({
    verified: [
      '- name: dsh-x',
      '  repo: good/dsh-x',
      `  reviewedCommit: ${'a'.repeat(40)}`,
      '  reviewer: github:r',
      '  reviewCommit: c',
    ].join('\n') + '\n',
    denied: '[]',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: '[]',
  })

  it('holds an npm package whose exact name is verified as a REPOSITORY', () => {
    // A-2: `good/dsh-x` is verified by commit. Publishing `dsh-x` on npm used
    // to skip the hold at distance 0, shadow the repo entry, and turn
    // `github:good/dsh-x tier=verified` into `npm:dsh-x tier=community
    // publisher=whoever`. The npm package is a DIFFERENT identity.
    const result = gate(candidate({ name: 'dsh-x' }), repoPinned)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('name-too-similar')
    expect(result.rejection.detail).toContain('dsh-x')
    expect(result.rejection.detail).toContain('verified as a repository')
  })

  it('clears that npm name when a human records it in allowed-similar', () => {
    // The escape is the npm NAME form: `good/dsh-x` in allowed-similar.yml
    // clears the GitHub channel and says nothing about who may publish the
    // name on npm.
    const cleared = parseRegistryConfig({
      verified: [
        '- name: dsh-x',
        '  repo: good/dsh-x',
        `  reviewedCommit: ${'a'.repeat(40)}`,
        '  reviewer: github:r',
        '  reviewCommit: c',
      ].join('\n') + '\n',
      denied: '[]',
      allowedSimilar: '- dsh-x\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(gate(candidate({ name: 'dsh-x' }), cleared).ok).toBe(true)
  })

  it('still holds a lookalike of a repo-verified name', () => {
    const result = gate(candidate({ name: 'dsh-xx' }), repoPinned)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('name-too-similar')
  })
})
```

Also extend the comment on the existing test at `gate.test.ts:214-216` so it names the reason it passes, rather than passing for a reason nobody wrote down:

```ts
  it('admits the verified name itself, which is distance zero', () => {
    // `dsh-fs-tool` is verified by `reviewedVersion`, i.e. AS THIS NPM
    // PACKAGE, so the candidate is the reviewed identity and the hold does
    // not apply. A name verified by a repository pin is a different identity
    // and IS held — see "holds an npm package whose exact name is verified as
    // a REPOSITORY".
    expect(gate(candidate({ name: 'dsh-fs-tool' }), config).ok).toBe(true)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/gate.test.ts -t "the hold and the candidate own identity"` — Expected: FAIL: "lists two verified names one edit apart" fails with `expected false to be true`, and "holds an npm package whose exact name is verified as a REPOSITORY" fails with `expected true to be false`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/gate.ts`, replace lines 129-136:

```ts
  if (!config.allowedSimilar.has(name)) {
    for (const verifiedName of config.verified.keys()) {
      const edits = distance(name, verifiedName)
      if (edits === 0 || edits > SIMILARITY_THRESHOLD) continue
      return reject(name, 'name-too-similar',
        `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
    }
  }
```

with:

```ts
  // The hold is skipped for exactly one identity: an npm package a human
  // reviewed AS AN NPM PACKAGE. Both halves of that sentence are load-bearing.
  //
  // "reviewed" (B-4): verifying `dsh-tool-a` and `dsh-tool-b` — distance 1,
  // the shape of a same-author suite — used to delist both, each held against
  // the other, because the hold skipped only the candidate's own exact name.
  // A review is already the adjudication the hold asks for.
  //
  // "as an npm package" (A-2): a name verified by `reviewedCommit` or
  // `reviewedSha256` belongs to a GITHUB entry, which is a different
  // identity. Skipping at distance 0 let any npm publisher take that bundle
  // name, shadow the verified repository (`shadowed-by-npm`) and inherit its
  // shelf position and `added` date. `allowed-similar.yml` — the npm-name
  // form — is the human escape when the npm package really is the same
  // project.
  const ownReview = config.verified.get(name)
  const verifiedAsThisPackage = ownReview !== undefined && ownReview.reviewedVersion !== undefined
  if (!verifiedAsThisPackage && !config.allowedSimilar.has(name)) {
    for (const verifiedName of config.verifiedNames) {
      const edits = distance(name, verifiedName)
      if (edits > SIMILARITY_THRESHOLD) continue
      return reject(name, 'name-too-similar', edits === 0
        ? `Exactly matches ${verifiedName}, which is verified as a repository rather than as this npm package, so publishing it here is a different identity claiming a reviewed name; held for human adjudication.`
        : `Within ${edits} edit(s) of the verified package ${verifiedName}; held for human adjudication.`)
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/gate.test.ts` — Expected: PASS (34 tests). The existing threshold tests (`dsh-fs-too1` held at 1, `dsh-fs-t00l` at 2, `dsh-fs-t001` admitted at 3) are unchanged: their config verifies `dsh-fs-tool` by version, so `verifiedNames` carries it and none of the three candidates is itself reviewed.
Run: `pnpm test` — Expected: PASS, 23 files / 371 tests. `pipeline.test.ts:69` still finds `| dsh-fs-too1 | name-too-similar |` in the report.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/gate.ts registry/scripts/tests/gate.test.ts
git commit -m "fix(registry): the npm hold skips only a package verified as an npm package"
```

---

### Task 9: a repository denial reaches the npm gate

Finding B-6. Denying `evil/dsh-x` does nothing once the author publishes `dsh-x` to npm from that repository: the npm gate checks only the name, npm wins the bundle name, the repository is reported `shadowed-by-npm` instead of `denied`, and `denied[]` — the list the Host's install gate consults — is empty.

The ordering the audit asks for ("run the denial check before the shadow short-circuit") comes for free: `pipeline.ts:39-48` gates every npm candidate first and only adds ACCEPTED names to `npmNames`, so a denied npm candidate never shadows anything and the repository reaches `gateRepo` and produces its own `denied` row. No change to `pipeline.ts` is needed for this finding — that is worth asserting rather than assuming, which is why the test drives `runPipeline` and not just `gate`.

**Files:**
- Modify: `registry/scripts/src/gate.ts:2` (import), `:71-75`
- Test: `registry/scripts/tests/gate.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `RegistryConfig.deniedRepos` (Task 3), `githubOwnerName` from `./github-repo.ts`.
- Produces: no signature change.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/gate.test.ts`:

```ts
describe('a denial names a project, not one of its two spellings', () => {
  const denied = parseRegistryConfig({
    verified: '[]',
    denied: '- name: Evil/dsh-x\n  reason: Exfiltrates credentials.\n  replacement: dsh-good\n',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: '[]',
  })

  it('rejects an npm package whose declared repository is denied, whatever the case', () => {
    const result = gate(candidate({ name: 'dsh-x', repository: 'https://github.com/evil/dsh-x' }), denied)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.rejection.code).toBe('denied')
    expect(result.rejection.detail)
      .toBe('Denied by the registry: Exfiltrates credentials. Known replacement: dsh-good.')
    expect(result.rejection.replacement).toBe('dsh-good')
  })

  it('leaves a package from another repository alone', () => {
    expect(gate(candidate({ name: 'dsh-x', repository: 'https://github.com/honest/dsh-x' }), denied).ok).toBe(true)
  })

  it('does not trip over a package that declares no repository', () => {
    // The denial check runs before the no-repository check, so a null
    // repository must reach the no-repository rejection, not throw here.
    const result = gate(candidate({ name: 'dsh-x', repository: null }), denied)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.rejection.code).toBe('no-repository')
  })
})
```

Append to `registry/scripts/tests/pipeline.test.ts`, as its own top-level `describe`:

```ts
describe('a repo denial survives the author publishing to npm', () => {
  const commit = 'e'.repeat(40)

  it('publishes both denial rows and lists nothing', () => {
    // B-6: the npm package won the bundle name, the repository was reported
    // `shadowed-by-npm`, and `denied[]` — which the Host's install gate reads
    // — stayed empty, so the install went through.
    const denied = parseRegistryConfig({
      verified: '[]',
      denied: '- name: evil/dsh-x\n  reason: Exfiltrates credentials.\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-x\n  added: 2026-08-10\n- name: evil/dsh-x\n  added: 2026-08-10\n',
    })
    const npmCandidate: Candidate = {
      name: 'dsh-x',
      version: '1.0.0',
      integrity: 'sha512-x',
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/evil/dsh-x',
      license: 'MIT',
      deprecated: false,
      hasBundle: true,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
      keywords: [],
      peers: [],
    }
    const repoCandidate: import('../src/types.ts').RepoCandidate = {
      name: 'dsh-x',
      repo: 'evil/dsh-x',
      commit,
      version: commit,
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: 'https://github.com/evil/dsh-x',
      license: 'MIT',
      hasBundle: true,
      requiresBuild: false,
      hasWorkspaceDeps: false,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
    }
    const { pluginsJson, report } = runPipeline([npmCandidate], [repoCandidate], denied, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as {
      plugins: unknown[]
      denied: { name: string; detail: string }[]
    }
    expect(parsed.plugins).toEqual([])
    expect(parsed.denied.map(d => d.name)).toEqual(['dsh-x', 'evil/dsh-x'])
    // And nothing is reported as shadowed: the npm candidate never reached
    // `npmNames`, so the repository was judged on its own.
    expect(report).not.toContain('shadowed-by-npm')
  })
})
```

`pipeline.test.ts` already imports `parseRegistryConfig` and `type Candidate` (lines 4-5), so no import changes are needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/pipeline.test.ts -t "publishes both denial rows and lists nothing"` — Expected: FAIL with `expected [ { name: 'dsh-x', … } ] to deeply equal []` — the npm entry is listed, `denied` is `[]`, and the report carries `| evil/dsh-x | shadowed-by-npm |`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/gate.ts`, replace line 2:

```ts
import { isHarnessRepo } from './github-repo.ts'
```

with:

```ts
import { githubOwnerName, isHarnessRepo } from './github-repo.ts'
```

Replace lines 71-75:

```ts
  const denial = config.denied.get(name)
  if (denial !== undefined) {
    const suffix = denial.replacement === undefined ? '' : ` Known replacement: ${denial.replacement}.`
    return reject(name, 'denied', `Denied by the registry: ${denial.reason}${suffix}`, denial.replacement)
  }
```

with:

```ts
  // Denied by npm name, or by the repository this package declares. A denial
  // names a PROJECT, and a project has two published spellings: `evil/dsh-x`
  // on GitHub and `dsh-x` on npm. Checking only the name let the author of a
  // denied repository publish the same code to npm, win the bundle name (npm
  // wins by design), and get the repository reported `shadowed-by-npm` while
  // `denied[]` — the list the Host's install gate consults — stayed empty.
  //
  // Case-folded on the repo side, as everywhere else on that keyspace. The
  // declared repository is attacker-controlled text, so `githubOwnerName`
  // returns null for anything that is not a plain
  // `https://github.com/<owner>/<name>` URL and the lookup is simply skipped
  // — the no-repository and harness-repository checks below still run.
  const declaredRepo = githubOwnerName(candidate.repository)
  const denial = config.denied.get(name)
    ?? (declaredRepo === null
      ? undefined
      : config.deniedRepos.get(`${declaredRepo.owner}/${declaredRepo.name}`.toLowerCase()))
  if (denial !== undefined) {
    const suffix = denial.replacement === undefined ? '' : ` Known replacement: ${denial.replacement}.`
    return reject(name, 'denied', `Denied by the registry: ${denial.reason}${suffix}`, denial.replacement)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/gate.test.ts registry/scripts/tests/pipeline.test.ts` — Expected: PASS (37 + 21 tests).
Run: `pnpm test` — Expected: PASS, 23 files / 375 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/gate.ts registry/scripts/tests/gate.test.ts registry/scripts/tests/pipeline.test.ts
git commit -m "fix(registry): a repository denial also rejects the npm package published from it"
```

---

### Task 10: `added` records the first appearance in the CATALOG, keyed by identity

Finding B-9. `build.ts:208-216` stamps today's date on every HARVESTED candidate, before the gate, keyed by bundle name; `types.ts:189-190` defines `added` as "the date this entry first appeared in the catalog". A package rejected for weeks and then listed carries its first-harvest date, and a repository entry inherits whatever date the bundle name got — from any of the up-to-14 repositories that claim it.

**Ordering dependency, stated because it changes what this task is worth:** the daily bot does not commit `registry/first-seen.yml` (`.github/workflows/daily.yml:133` adds only `manifest.lock` and `repo-state.json`), so every name absent from the committed file is re-stamped "first seen today" on the next build — finding C-1, which belongs to **WP0** (plan A, [2026-09-03-audit-fix-a-urgent.md](2026-09-03-audit-fix-a-urgent.md)). Until C-1 lands, this task makes `added` correct *within one build* and stops rejected candidates entering the file, but half the shelf still gets re-dated daily. Land C-1 first if the two plans are running in parallel. The re-keying below also means every github entry's row is new, so the one-time `backfill-first-seen.ts` re-run C-1 schedules is what recovers their real dates from `manifest.lock` history — this task changes that script so the re-run produces the new key space.

**Files:**
- Modify: `registry/scripts/src/pipeline.ts` (whole `runPipeline` body and the return type)
- Modify: `registry/scripts/src/tier.ts:7-16` (doc), `:89`
- Modify: `registry/scripts/src/build.ts:208-216`, `:229`, `:235`
- Modify: `registry/scripts/src/backfill-first-seen.ts:1-29`
- Test: `registry/scripts/tests/pipeline.test.ts`, `registry/scripts/tests/tier.test.ts`

**Interfaces:**
- Consumes: `firstSeenKey` (Task 1).
- Produces: `export interface PipelineResult extends Artifacts { firstSeen: Map<string, string> }` and `runPipeline(...): PipelineResult`. Task 11's determinism test and Task 17's report note both build on this.

- [ ] **Step 1: Write the failing test**

In `registry/scripts/tests/pipeline.test.ts`, re-key the shared config's repo first-seen rows (lines 16-27). Replace:

```ts
  firstSeen: [
    '- name: dsh-fs-tool',
    '  added: 2026-08-10',
    '- name: dsh-hello-plugin',
    '  added: 2026-08-11',
    '- name: dsh-derived-plugin',
    '  added: 2026-08-12',
    '- name: dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: sub-plugin',
    '  added: 2026-08-14',
  ].join('\n') + '\n',
```

with:

```ts
  firstSeen: [
    '- name: dsh-fs-tool',
    '  added: 2026-08-10',
    '- name: dsh-hello-plugin',
    '  added: 2026-08-11',
    '- name: dsh-derived-plugin',
    '  added: 2026-08-12',
    // Repo entries are keyed by `owner/slug`: a bundle name is claimed by up
    // to 14 repositories, so it cannot carry one repository's date.
    '- name: someone/dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: someone/monorepo',
    '  added: 2026-08-14',
  ].join('\n') + '\n',
```

**Replace** the two "throws when there is no first-seen row" tests, `pipeline.test.ts:122-132` and `:179-189`. Both pinned the old behaviour, in which a missing row was a build-stopping error because `build.ts` had already stamped every harvested name before the pipeline ran; now the pipeline itself resolves a first appearance to the build date and hands back the row to commit, so neither throw is reachable through `runPipeline` any more. `firstSeenOf`'s throw stays reachable — and stays tested — through a direct `assignTier` / `assignRepoTier` call in `tier.test.ts`. Delete:

```ts
  it('throws with the file name when a listed name has no first-seen row', () => {
    const withoutRow = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n',
    })
    expect(() => runPipeline(candidates, [], withoutRow, BUILT_AT))
      .toThrow('first-seen.yml: dsh-fs-tool has no first-seen row')
  })
```

and:

```ts
  it('throws when a repository entry has no first-seen row', () => {
    const withoutRow = parseRegistryConfig({
      verified: '[]',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(() => runPipeline([], [repoCandidate], withoutRow, BUILT_AT))
      .toThrow('first-seen.yml: dsh-repo-plugin has no first-seen row')
  })
```

and add, in `describe('runPipeline', ...)`:

```ts
  it('stamps a first appearance with the build date and returns the row to commit', () => {
    const withoutRow = parseRegistryConfig({
      verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n',
    })
    const { pluginsJson, firstSeen } = runPipeline(candidates, [], withoutRow, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { plugins: { name: string; added: string }[] }
    expect(parsed.plugins.find(p => p.name === 'dsh-fs-tool')?.added).toBe('2026-08-18')
    expect(firstSeen.get('dsh-fs-tool')).toBe('2026-08-18')
    // A recorded row is never overwritten.
    expect(firstSeen.get('dsh-hello-plugin')).toBe('2026-08-11')
  })

  it('never stamps a rejected candidate, so a package listed after weeks of rejection keeps its real date', () => {
    // B-9: the stamp used to happen before the gate, so `dsh-lib-only` —
    // rejected `no-bundle` every day — had a row from its first harvest, and
    // the day it finally declared a bundle it was "added" months earlier.
    const { firstSeen } = runPipeline(candidates, [], config, BUILT_AT)
    expect(firstSeen.has('dsh-lib-only')).toBe(false)
    expect(firstSeen.has('dsh-no-license')).toBe(false)
    expect(firstSeen.has('dsh-no-summary')).toBe(false)
  })
```

and, in `describe('runPipeline with repository candidates', ...)`:

```ts
  it('keys a repository first appearance by owner/slug and not by the bundle name', () => {
    const noRows = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
    })
    const { firstSeen, pluginsJson } = runPipeline([], [repoCandidate], noRows, BUILT_AT)
    expect(firstSeen.get('someone/dsh-repo-plugin')).toBe('2026-08-18')
    expect(firstSeen.has('dsh-repo-plugin')).toBe(false)
    const parsed = JSON.parse(pluginsJson) as { plugins: { added: string }[] }
    expect(parsed.plugins[0]?.added).toBe('2026-08-18')
  })

  it('gives two repositories sharing a bundle name their own first-seen rows', () => {
    // A-2's other half: with one row per bundle name, an npm package taking a
    // verified repo's name inherited its `added` date and looked as old as
    // the entry it displaced.
    const noRows = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]',
      firstSeen: '- name: alice/dsh-repo-plugin\n  added: 2026-07-01\n',
    })
    const { firstSeen, pluginsJson } = runPipeline([], [
      { ...repoCandidate, repo: 'alice/dsh-repo-plugin' },
      { ...repoCandidate, repo: 'bob/dsh-repo-plugin' },
    ], noRows, BUILT_AT)
    expect(firstSeen.get('alice/dsh-repo-plugin')).toBe('2026-07-01')
    expect(firstSeen.get('bob/dsh-repo-plugin')).toBe('2026-08-18')
    const parsed = JSON.parse(pluginsJson) as { plugins: { repo: string; added: string }[] }
    expect(parsed.plugins.map(p => [p.repo, p.added])).toEqual([
      ['alice/dsh-repo-plugin', '2026-07-01'],
      ['bob/dsh-repo-plugin', '2026-08-18'],
    ])
  })
```

In `registry/scripts/tests/tier.test.ts`, re-key the repo rows of the shared config's `firstSeen` (lines 36-51). Replace:

```ts
  firstSeen: [
    '- name: dsh-hello-plugin',
    '  added: 2026-08-10',
    '- name: dsh-other-plugin',
    '  added: 2026-08-11',
    '- name: dsh-derived-plugin',
    '  added: 2026-08-12',
    '- name: dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: dsh-tagged-plugin',
    '  added: 2026-08-14',
    '- name: dsh-commit-pinned',
    '  added: 2026-08-15',
    '- name: dsh-version-pinned',
    '  added: 2026-08-16',
  ].join('\n') + '\n',
```

with:

```ts
  firstSeen: [
    '- name: dsh-hello-plugin',
    '  added: 2026-08-10',
    '- name: dsh-other-plugin',
    '  added: 2026-08-11',
    '- name: dsh-derived-plugin',
    '  added: 2026-08-12',
    // Repo entries are keyed by lowercased `owner/slug` (identity.ts).
    '- name: someone/dsh-repo-plugin',
    '  added: 2026-08-13',
    '- name: someone/dsh-tagged-plugin',
    '  added: 2026-08-14',
    '- name: someone/dsh-commit-pinned',
    '  added: 2026-08-15',
    '- name: someone/dsh-version-pinned',
    '  added: 2026-08-16',
    '- name: bob/dsh-commit-pinned',
    '  added: 2026-08-17',
  ].join('\n') + '\n',
```

and replace the repo throw test (`tier.test.ts:199-202`):

```ts
  it('throws when a repo name has no first-seen row', () => {
    expect(() => assignRepoTier(repoAccepted('dsh-unseen'), config))
      .toThrow('first-seen.yml: dsh-unseen has no first-seen row')
  })
```

with:

```ts
  it('throws, naming the repository, when a repo identity has no first-seen row', () => {
    // The loud failure stays: `assignRepoTier` must never invent a date. The
    // pipeline resolves a first appearance before it gets here (B-9), so this
    // throw now means a caller skipped that resolution.
    expect(() => assignRepoTier(repoAccepted('dsh-unseen'), config))
      .toThrow('first-seen.yml: someone/dsh-unseen has no first-seen row')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/pipeline.test.ts -t "stamps a first appearance with the build date"` — Expected: FAIL with `Error: first-seen.yml: dsh-fs-tool has no first-seen row` (the pipeline still demands a recorded row).

- [ ] **Step 3: Write the implementation**

Replace the whole of `registry/scripts/src/pipeline.ts` (imports plus `runPipeline`) with:

```ts
import { gate, type Accepted } from './gate.ts'
import { gateRepo, type RepoAccepted } from './repo-gate.ts'
import { assignTier, assignRepoTier } from './tier.ts'
import { emit, SCHEMA_VERSION, type Artifacts, type StarsPointer } from './emit.ts'
import { firstSeenKey } from './identity.ts'
import type { RegistryConfig } from './config.ts'
import type { Candidate, Entry, Rejection, RepoCandidate } from './types.ts'

/** Every artifact of one build, plus the rows to write back. */
export interface PipelineResult extends Artifacts {
  /**
   * The first-seen map as it must be committed: the rows already recorded,
   * plus the build date for every identity that reached the CATALOG for the
   * first time. Decided here rather than in `build.ts` because it is a policy
   * question — which candidates are entries — and `build.ts` cannot answer it
   * without running the gate.
   */
  firstSeen: Map<string, string>
}

/**
 * Run the whole catalog build as a pure function.
 *
 * Purity is what makes the determinism test possible: the only inputs are the
 * candidates, the registry files, and the timestamp, so the same three
 * produce byte-identical artifacts regardless of candidate order or clock.
 * The one clock-dependent output is `added` for an identity appearing for the
 * FIRST time, which is why the committed `first-seen.yml` is what keeps the
 * content hash stable from day to day.
 * @param candidates - packages fetched from npm, in any order.
 * @param repoCandidates - repositories fetched from GitHub, in any order.
 * @param config - the human-authored registry files.
 * @param builtAt - ISO 8601 build timestamp.
 * @param preexistingRejections - rejections decided before this function ran, such as a
 *   name that could not be turned into a candidate at all (e.g. a failed fetch); merged
 *   into the emitted report alongside every rejection this function produces itself.
 * @param stars - optional pointer to a published stars sidecar, passed through to emit.
 * @returns the artifacts to publish and commit, and the first-seen rows to write back.
 */
export function runPipeline(
  candidates: Candidate[],
  repoCandidates: RepoCandidate[],
  config: RegistryConfig,
  builtAt: string,
  preexistingRejections: Rejection[] = [],
  stars: StarsPointer | null = null,
  schemaVersion: number = SCHEMA_VERSION,
): PipelineResult {
  const rejections: Rejection[] = [...preexistingRejections]
  const today = builtAt.slice(0, 10)

  // Gate everything first, tier second. `added` is the date an entry first
  // appeared in the CATALOG (types.ts), so it cannot be decided until the
  // gate has said which candidates ARE entries. Stamping every harvested
  // candidate before the gate — what build.ts used to do — gave a package
  // rejected for weeks and then listed the date of its first HARVEST (B-9).
  //
  // npm first: its entries own the bundle names (npm wins by design — real
  // semver beats a commit pin), and repo candidates for the same name are
  // recorded as shadowed, not silently dropped. Only ACCEPTED npm names
  // shadow, so a denied npm package leaves its repository to be judged on its
  // own merits (B-6).
  const npmNames = new Set<string>()
  const accepted: Accepted[] = []
  for (const candidate of candidates) {
    const result = gate(candidate, config)
    if (!result.ok) {
      rejections.push(result.rejection)
      continue
    }
    npmNames.add(candidate.name)
    accepted.push(result.accepted)
  }
  const acceptedRepos: RepoAccepted[] = []
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
    if (!result.ok) {
      rejections.push(result.rejection)
      continue
    }
    acceptedRepos.push(result.accepted)
  }

  // First seen, for the entries that got in, keyed by identity: the npm name,
  // or the repository's lowercased `owner/slug`. A recorded row always wins —
  // this map only ever grows.
  const firstSeen = new Map(config.firstSeen)
  for (const item of accepted) {
    const key = firstSeenKey({ source: 'npm', name: item.candidate.name })
    if (!firstSeen.has(key)) firstSeen.set(key, today)
  }
  for (const item of acceptedRepos) {
    const key = firstSeenKey({ source: 'github', name: item.repo.name, repo: item.repo.repo })
    if (!firstSeen.has(key)) firstSeen.set(key, today)
  }
  const withFirstSeen: RegistryConfig = { ...config, firstSeen }

  const entries: Entry[] = [
    ...accepted.map(item => assignTier(item, withFirstSeen)),
    ...acceptedRepos.map(item => assignRepoTier(item, withFirstSeen)),
  ]
  return {
    ...emit(entries, rejections, builtAt, stars, schemaVersion, config.notAShop),
    firstSeen,
  }
}
```

`gate.ts` already exports `Accepted` and `repo-gate.ts` already exports `RepoAccepted`, so the two combined imports above compile as written.

In `registry/scripts/src/tier.ts`, replace lines 7-16:

```ts
/**
 * The first-seen date for one listed name, failing loudly when the file has
 * no row for it. A listed entry without a date would silently omit a field
 * every consumer of `added` expects.
 */
function firstSeenOf(config: RegistryConfig, name: string): string {
  const added = config.firstSeen.get(name)
  if (added === undefined) throw new Error(`first-seen.yml: ${name} has no first-seen row`)
  return added
}
```

with:

```ts
/**
 * The first-seen date for one listed IDENTITY, failing loudly when the map
 * has no row for it. A listed entry without a date would silently omit a
 * field every consumer of `added` expects.
 *
 * The key comes from {@link firstSeenKey}: the npm name, or the repository's
 * lowercased `owner/slug`. `runPipeline` resolves a first appearance to the
 * build date before calling either tier function, so a throw here means a
 * caller skipped that resolution.
 */
function firstSeenOf(config: RegistryConfig, key: string): string {
  const added = config.firstSeen.get(key)
  if (added === undefined) throw new Error(`first-seen.yml: ${key} has no first-seen row`)
  return added
}
```

and add to the imports:

```ts
import { firstSeenKey } from './identity.ts'
```

Replace line 89 of `tier.ts`:

```ts
    added: firstSeenOf(config, repo.name),
```

with:

```ts
    added: firstSeenOf(config, firstSeenKey({ source: 'github', name: repo.name, repo: repo.repo })),
```

In `registry/scripts/src/build.ts`, replace lines 208-216:

```ts
// First-seen bookkeeping: any name this run harvested for the first time gets
// today. The appended file is written back after the pipeline, so the daily
// commit carries both the new dates and the manifest lock together.
const builtAt = new Date().toISOString()
const today = builtAt.slice(0, 10)
const firstSeen = new Map(config.firstSeen)
for (const candidate of candidates) if (!firstSeen.has(candidate.name)) firstSeen.set(candidate.name, today)
for (const repo of repoCandidates) if (!firstSeen.has(repo.name)) firstSeen.set(repo.name, today)
const configWithFirstSeen = { ...config, firstSeen }
```

with:

```ts
// The clock, read exactly once, and passed down. First-seen bookkeeping moved
// into the pipeline: which candidates are ENTRIES is a policy question the
// gate answers, and stamping every harvested candidate here dated packages
// that were never listed (B-9). The appended file is written back after the
// pipeline, so the daily commit carries both the new dates and the manifest
// lock together.
const builtAt = new Date().toISOString()
```

replace line 229:

```ts
const artifacts = runPipeline(candidates, repoCandidates, configWithFirstSeen, builtAt, rejections, starsInfo, schemaVersion)
```

with:

```ts
const artifacts = runPipeline(candidates, repoCandidates, config, builtAt, rejections, starsInfo, schemaVersion)
```

and replace line 235:

```ts
writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(firstSeen))
```

with:

```ts
writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(artifacts.firstSeen))
```

In `registry/scripts/src/backfill-first-seen.ts`, replace lines 7-29 (the header note and `namesOf`):

```ts
 * manifest.lock line shapes (emit.ts): npm entries are `name version integrity`,
 * repo entries are `owner/slug name version`. Scoped npm names lead with `@`
 * (and contain a slash); repo slugs are `owner/slug` with no leading `@` — so
 * the leading `@`, not the slash, decides which field holds the name. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeFirstSeen } from './config.ts'

const REGISTRY_DIR = 'registry'
const LOCK = 'snapshots/manifest.lock'

function namesOf(lockText: string): Set<string> {
  const names = new Set<string>()
  for (const line of lockText.split('\n')) {
    if (line === '') continue
    const parts = line.split(' ')
    const first = parts[0] ?? ''
    const name = first.startsWith('@') || !first.includes('/') ? parts[0] : parts[1]
    if (name !== undefined && name !== '') names.add(name)
  }
  return names
}
```

with:

```ts
 * manifest.lock line shapes (emit.ts): npm entries are `name version integrity`,
 * repo entries are `owner/slug name version`. Either way the FIRST field is
 * the first-seen key — the npm name, or the repository `owner/slug` — because
 * `added` is keyed by identity and a bundle name is claimed by up to 14
 * repositories (identity.ts, audit B-9). Repo keys are lowercased to match
 * `firstSeenKey`; npm names are left as published. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeFirstSeen } from './config.ts'

const REGISTRY_DIR = 'registry'
const LOCK = 'snapshots/manifest.lock'

function keysOf(lockText: string): Set<string> {
  const keys = new Set<string>()
  for (const line of lockText.split('\n')) {
    if (line === '') continue
    const key = line.split(' ')[0]
    if (key === undefined || key === '') continue
    // A repo line leads with `owner/slug`: no leading `@`, exactly one slash.
    keys.add(!key.startsWith('@') && key.includes('/') ? key.toLowerCase() : key)
  }
  return keys
}
```

and replace the three call sites of `namesOf` with `keysOf` (lines 44 and 54 of the current file):

```ts
const current = keysOf(readFileSync(join(REGISTRY_DIR, LOCK), 'utf8'))
```

```ts
  for (const name of keysOf(lockText)) {
    if (current.has(name) && !firstSeen.has(name)) firstSeen.set(name, date)
  }
```

The version-string guard at lines 59-66 stays. It can no longer fire from a misparse — the key is always field 0 — but the script reads `manifest.lock` out of arbitrary git history, and a lock shape older than the current writer is exactly the input it is there to refuse.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/pipeline.test.ts registry/scripts/tests/tier.test.ts` — Expected: PASS (24 + 29 tests).
Run: `pnpm test` — Expected: PASS, 23 files / 377 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/pipeline.ts registry/scripts/src/tier.ts registry/scripts/src/build.ts registry/scripts/src/backfill-first-seen.ts registry/scripts/tests/pipeline.test.ts registry/scripts/tests/tier.test.ts
git commit -m "fix(registry): stamp added from accepted entries, keyed by identity"
```

- [ ] **Step 6: The one-time backfill (needs a human on the diff)**

Only after WP0's C-1 fix (plan A) has added `registry/first-seen.yml` to the daily workflow's `git add` — otherwise the bot discards the result on the next run. Then:

```bash
node --experimental-strip-types registry/scripts/src/backfill-first-seen.ts
git diff --stat registry/first-seen.yml
```

Expect every github row to be replaced by an `owner/slug` row carrying the date of the first `manifest.lock` commit that listed that repository, and npm rows to be unchanged. **Do not commit this without reading the diff**: it rewrites ~8,850 lines, and a wrong date is permanent because the build only ever appends. This is a human decision, not a step to automate.

---

### Task 11: sort by identity, and the shadow row names the `repo#subdir` unit

Findings C-2 and C-6 / B-10 / A-8. `emit.ts:155,163,179` key their sorts on `name` alone, so ties keep input order: 172 bundle names over 451 entries in the live catalog are claimed by several repositories (`dsh-skill-manager` by 14), and reversing `repoCandidates` changes `plugins.<sha>.json`, `manifest.lock` and `index.json`. It is masked today only because `github-client.ts` happens to feed candidates in repo-sorted order, and `pipeline.test.ts:81-88` reverses npm candidates only. Separately, `pipeline.ts`'s shadow row names `repoCandidate.repo` where `repo-gate.ts:52` names `repo#subdir`, so a monorepo with several shadowed subpackages emits identical rows whose order follows the input.

**Files:**
- Modify: `registry/scripts/src/emit.ts:155`, `:156-163`, `:179`
- Modify: `registry/scripts/src/pipeline.ts` (the shadow row and its import)
- Test: `registry/scripts/tests/emit.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `compareEntries`, `compareRejections`, `compareStrings`, `repoUnit` (Task 1); `PipelineResult` (Task 10).
- Produces: no new names. **One-time output change:** entries that tie on name, and rejections that tie on name, get a defined order, so the first daily build after this lands moves some `manifest.lock` lines and changes the content hash once. That is the intended cost of a total order.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/emit.test.ts`:

```ts
describe('the sorts key on the whole identity, not the name', () => {
  it('orders entries that share a bundle name by source, repo, then subdir', () => {
    const { pluginsJson } = emit([
      repoEntry('dsh-shared', 'bob/dsh-shared'),
      repoEntry('dsh-shared', 'alice/mono', 'packages/b'),
      entry('dsh-shared'),
      repoEntry('dsh-shared', 'alice/mono', 'packages/a'),
    ], [], '2026-08-18T00:00:00.000Z')
    const parsed = JSON.parse(pluginsJson) as { plugins: { source: string; repo?: string; subdir?: string }[] }
    expect(parsed.plugins.map(p => [p.source, p.repo ?? '', p.subdir ?? ''])).toEqual([
      ['github', 'alice/mono', 'packages/a'],
      ['github', 'alice/mono', 'packages/b'],
      ['github', 'bob/dsh-shared', ''],
      ['npm', '', ''],
    ])
  })

  it('orders rejections that share a name by code and then detail', () => {
    const { report } = emit([], [
      { name: 'a/b', code: 'no-license', detail: 'second' },
      { name: 'a/b', code: 'no-bundle', detail: 'zzz' },
      { name: 'a/b', code: 'no-bundle', detail: 'aaa' },
    ], '2026-08-18T00:00:00.000Z')
    const rows = report.split('\n').filter(line => line.startsWith('| a/b '))
    expect(rows).toEqual([
      '| a/b | no-bundle | aaa |',
      '| a/b | no-bundle | zzz |',
      '| a/b | no-license | second |',
    ])
  })

  it('orders the published denied list by name and then detail', () => {
    const { pluginsJson } = emit([], [
      { name: 'a/b', code: 'denied', detail: 'zzz' },
      { name: 'a/b', code: 'denied', detail: 'aaa' },
    ], '2026-08-18T00:00:00.000Z')
    const parsed = JSON.parse(pluginsJson) as { denied: { detail: string }[] }
    expect(parsed.denied.map(d => d.detail)).toEqual(['aaa', 'zzz'])
  })
})
```

Append to `registry/scripts/tests/pipeline.test.ts`:

```ts
describe('determinism under every perturbation', () => {
  const commitA = 'a'.repeat(40)
  const commitB = 'b'.repeat(40)

  function repoAt(name: string, repo: string, commit: string, subdir?: string): import('../src/types.ts').RepoCandidate {
    return {
      name,
      repo,
      commit,
      version: commit,
      publishedAt: '2026-08-01T12:00:00.000Z',
      repository: `https://github.com/${repo}`,
      license: 'MIT',
      hasBundle: true,
      requiresBuild: false,
      hasWorkspaceDeps: false,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
      ...(subdir === undefined ? {} : { subdir }),
    }
  }

  // Four accepted entries sharing two bundle names, two of them subpackages
  // of one repository, plus two rejected subpackages of another — every tie
  // the comparators have to break.
  const repos = [
    repoAt('dsh-shared', 'alice/dsh-shared', commitA),
    repoAt('dsh-shared', 'bob/dsh-shared', commitB),
    repoAt('dsh-sub', 'carol/monorepo', commitA, 'packages/one'),
    repoAt('dsh-sub', 'carol/monorepo', commitA, 'packages/two'),
    { ...repoAt('dsh-bad', 'dave/monorepo', commitA, 'packages/x'), hasBundle: false },
    { ...repoAt('dsh-bad', 'dave/monorepo', commitA, 'packages/y'), hasBundle: false },
  ]
  const preexisting: Rejection[] = [
    { name: 'dsh-twice', code: 'fetch-failed', detail: 'npm registry returned 500' },
    { name: 'dsh-twice', code: 'no-manifest', detail: 'package.json was unreadable.' },
  ]
  const stars = { url: 'stars.deadbeef.json', sha256: 'deadbeef' }
  // Every ACCEPTED entry needs a recorded row here, or its `added` comes from
  // the clock (Task 10) and the across-clocks comparison below would fail for
  // the right reason. The verified row keeps `dsh-fs-too1` held, exactly as
  // the suite's shared config does, so the accepted set is the three plugins
  // plus the four repository entries.
  const dated = parseRegistryConfig({
    verified: '- name: dsh-fs-tool\n  reviewedVersion: 1.0.0\n  reviewer: github:r\n  reviewCommit: abc\n  notes: fine\n',
    denied: '[]',
    allowedSimilar: '[]',
    categories: '[]',
    firstSeen: [
      '- name: dsh-derived-plugin\n  added: 2026-08-12\n',
      '- name: dsh-fs-tool\n  added: 2026-08-10\n',
      '- name: dsh-hello-plugin\n  added: 2026-08-11\n',
      '- name: alice/dsh-shared\n  added: 2026-08-01\n',
      '- name: bob/dsh-shared\n  added: 2026-08-02\n',
      '- name: carol/monorepo\n  added: 2026-08-03\n',
    ].join(''),
  })

  it('is byte-identical in every artifact when only the input order changes', () => {
    const first = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars)
    const second = runPipeline(
      [...candidates].reverse(), [...repos].reverse(), dated, BUILT_AT, [...preexisting].reverse(), stars,
    )
    for (const key of ['pluginsFileName', 'pluginsJson', 'indexJson', 'badgeJson', 'manifestLock', 'report'] as const) {
      expect(second[key], key).toBe(first[key])
    }
    expect([...second.firstSeen]).toEqual([...first.firstSeen])
  })

  it('keeps the hashed data identical across build times, with only the index and badge moving', () => {
    const first = runPipeline(candidates, repos, dated, BUILT_AT, preexisting, stars)
    const second = runPipeline(
      [...candidates].reverse(), [...repos].reverse(), dated, '2030-01-01T00:00:00.000Z',
      [...preexisting].reverse(), stars,
    )
    expect(second.pluginsJson).toBe(first.pluginsJson)
    expect(second.pluginsFileName).toBe(first.pluginsFileName)
    expect(second.manifestLock).toBe(first.manifestLock)
    expect(second.report).toBe(first.report)
    // builtAt belongs to the index and the badge alone.
    expect(second.indexJson).not.toBe(first.indexJson)
    expect(second.badgeJson).not.toBe(first.badgeJson)
  })

  it('names each shadowed subpackage by its repo#subdir unit', () => {
    // C-6: both rows read `dave/monorepo` and were indistinguishable, so their
    // order in the report followed the harvest.
    const shadowing: Candidate[] = candidates.filter(c => c.name === 'dsh-hello-plugin')
    const { report } = runPipeline(shadowing, [
      repoAt('dsh-hello-plugin', 'dave/monorepo', commitA, 'packages/y'),
      repoAt('dsh-hello-plugin', 'dave/monorepo', commitA, 'packages/x'),
    ], dated, BUILT_AT)
    const rows = report.split('\n').filter(line => line.includes('shadowed-by-npm'))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('| dave/monorepo#packages/x |')
    expect(rows[1]).toContain('| dave/monorepo#packages/y |')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/pipeline.test.ts -t "determinism under every perturbation"` — Expected: FAIL on all three: the order tests report `pluginsJson: expected '…"repo": "bob/dsh-shared"…' to be '…"repo": "alice/dsh-shared"…'`, and the shadow test fails with `expected '| dave/monorepo | shadowed-by-npm | …' to contain '| dave/monorepo#packages/x |'`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/emit.ts`, add to the import from Task 1:

```ts
import { compareEntries, compareRejections, compareStrings, installIdentity } from './identity.ts'
```

Replace line 155:

```ts
  const sorted = [...emitted].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
```

with:

```ts
  // Name first — that is the order §7.1 promises a reader — then the rest of
  // the identity, so a tie can never fall back to the order npm or GitHub
  // answered in. 172 live bundle names over 451 entries are claimed by
  // several repositories.
  const sorted = [...emitted].sort(compareEntries)
```

Replace lines 156-163:

```ts
  const denied = rejections
    .filter(r => r.code === 'denied')
    .map(r => ({
      name: r.name,
      detail: r.detail,
      ...(r.replacement !== undefined ? { replacement: r.replacement } : {}),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
```

with:

```ts
  const denied = rejections
    .filter(r => r.code === 'denied')
    .map(r => ({
      name: r.name,
      detail: r.detail,
      ...(r.replacement !== undefined ? { replacement: r.replacement } : {}),
    }))
    // One name can be denied twice — an npm package and its repository both
    // carry a row — so the detail breaks the tie.
    .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.detail, b.detail))
```

Replace line 179:

```ts
  const sortedRejections = [...rejections].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
```

with:

```ts
  // Name, code, detail: a monorepo emits several rows under one repo, and a
  // pre-existing fetch failure can share a name with a gate rejection.
  const sortedRejections = [...rejections].sort(compareRejections)
```

`emit.ts:171-175` (`notAShopListed`) is deliberately left alone here: it is a list of names, so a name-keyed sort is correct by definition. Its real defect is duplication — the expression emits one copy per entry, and 151 live names are shared by 243 entries — and Task 16 rewrites that block.

In `registry/scripts/src/pipeline.ts`, change the identity import to:

```ts
import { firstSeenKey, repoUnit } from './identity.ts'
```

and replace the shadow row:

```ts
      rejections.push({
        name: repoCandidate.repo,
        code: 'shadowed-by-npm',
        detail: `The npm package ${repoCandidate.name} is already listed; the repository is not listed separately.`,
      })
```

with:

```ts
      rejections.push({
        // The same unit `repo-gate.ts` names, so a monorepo's shadowed
        // subpackages are distinguishable rows instead of N identical ones
        // whose order followed the harvest (C-6).
        name: repoUnit(repoCandidate),
        code: 'shadowed-by-npm',
        detail: `The npm package ${repoCandidate.name} is already listed; the repository is not listed separately.`,
      })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/emit.test.ts registry/scripts/tests/pipeline.test.ts` — Expected: PASS. `pipeline.test.ts:191-195` ("shadows a repository whose bundle name already ships as an npm package") still passes: its candidate has no `subdir`, so `repoUnit` returns `someone/dsh-repo-plugin` unchanged.
Run: `pnpm test` — Expected: PASS, 23 files / 383 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/emit.ts registry/scripts/src/pipeline.ts registry/scripts/tests/emit.test.ts registry/scripts/tests/pipeline.test.ts
git commit -m "fix(registry): sort by the whole identity and name shadowed subpackages by their unit"
```

- [ ] **Step 6: Amend §7.1 step 7**

In `docs/design/2026-08-18-dsh-plugin-shop-design.md` §7.1, replace step 7:

```
7. **Emit** — sort by package name for determinism; produce `plugins.<sha256>.json` and `index.json`, with the build report as a CI artifact.
```

with:

```
7. **Emit** — sort by package name for determinism, breaking ties on the rest of the install identity (`source`, `repo`, `subdir`) so the output can never depend on the order npm or GitHub answered in; rejections sort by `(name, code, detail)` for the same reason. Produce `plugins.<sha256>.json` and `index.json`, with the build report as a CI artifact.

   **Amendment (2026-09-03, audit C-2 / C-6):** the name alone is not a key. 172 live bundle names over 451 entries are claimed by several repositories (`dsh-skill-manager` by 14), and a name-only sort left those ties to input order — reversing the repository harvest changed the content hash, `manifest.lock` and `index.json`. A shadowed repository is likewise reported by its `owner/slug#subdir` unit, matching the repo gate, so a monorepo's shadowed subpackages are distinguishable rows.
```

```bash
git add docs/design/2026-08-18-dsh-plugin-shop-design.md
git commit -m "docs: emit sorts by the whole identity, and shadow rows name the unit"
```

---

### Task 12: `deprecated: ""` is npm's un-deprecate spelling, and the legacy licence forms are real

Finding B-5 / A-7. `npm-client.ts:245` reads `manifest.deprecated !== undefined`, and npm's documented un-deprecate — `npm deprecate <pkg> ""` — leaves `deprecated: ""` in the manifest, so a package the author explicitly un-deprecated is published with the reason "Marked deprecated on npm." `npm-client.ts:244` reads only `typeof license === 'string'`, so the legacy `license: { type, url }` object and `licenses: [...]` array — which npm still publishes, with a warning — become "Declares no license." Both are false published reasons, which CLAUDE.md calls a defect rather than a wording nit.

**Files:**
- Modify: `registry/scripts/src/npm-client.ts:214-262`
- Modify: `registry/scripts/src/gate.ts:82-84`
- Test: `registry/scripts/tests/npm-client.test.ts`, `registry/scripts/tests/gate.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `toCandidate(packument: unknown): Candidate | null`; `Candidate.license` may now come from a legacy form, `Candidate.deprecated` is true only for a real deprecation message.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/npm-client.test.ts`, inside `describe('toCandidate', ...)` so the `packument` fixture is in scope:

```ts
  it('reads an empty deprecated string as NOT deprecated, which is how npm spells un-deprecate', () => {
    // `npm deprecate <pkg> ""` is the documented way to undo a deprecation
    // and it leaves the key in place with an empty value. Reading "the key
    // exists" published "Marked deprecated on npm." for a package whose
    // author had explicitly withdrawn that.
    const undeprecated = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: '' } },
    }
    expect(toCandidate(undeprecated)?.deprecated).toBe(false)
    const blank = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: '   ' } },
    }
    expect(blank && toCandidate(blank)?.deprecated).toBe(false)
  })

  it('still reads a real deprecation message, and a bare boolean', () => {
    const withMessage = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: 'use dsh-hello-2 instead' } },
    }
    expect(toCandidate(withMessage)?.deprecated).toBe(true)
    // Some manifests carry `true` rather than a message; refusing to read it
    // would list a deprecated package.
    const withBoolean = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], deprecated: true } },
    }
    expect(toCandidate(withBoolean)?.deprecated).toBe(true)
  })

  it('reads the legacy license object and licenses array npm still serves', () => {
    const legacyObject = {
      ...packument,
      versions: {
        '1.2.0': { ...packument.versions['1.2.0'], license: { type: 'MIT', url: 'http://example.test/LICENSE' } },
      },
    }
    expect(toCandidate(legacyObject)?.license).toBe('MIT')
    const legacyArray = {
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          license: undefined,
          licenses: [{ type: 'Apache-2.0', url: 'http://example.test/LICENSE' }],
        },
      },
    }
    expect(toCandidate(legacyArray)?.license).toBe('Apache-2.0')
    const legacyStringArray = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: undefined, licenses: ['ISC'] } },
    }
    expect(toCandidate(legacyStringArray)?.license).toBe('ISC')
  })

  it('reports no license only when nothing declares one', () => {
    const none = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: undefined } },
    }
    expect(toCandidate(none)?.license).toBeNull()
    const empty = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: '  ' } },
    }
    expect(toCandidate(empty)?.license).toBeNull()
    const objectWithoutType = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], license: { url: 'http://example.test/L' } } },
    }
    expect(toCandidate(objectWithoutType)?.license).toBeNull()
  })
```

Append to `registry/scripts/tests/gate.test.ts`, inside `describe('gate', ...)`:

```ts
  it('names the SPDX expectation when nothing declares a license', () => {
    const result = gate(candidate({ license: null }), config)
    if (result.ok) throw new Error('expected rejection')
    expect(result.rejection.code).toBe('no-license')
    expect(result.rejection.detail).toContain('SPDX')
    expect(result.rejection.detail).toContain('"license": "MIT"')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "reads an empty deprecated string"` — Expected: FAIL with `expected true to be false`.
Run: `npx vitest run registry/scripts/tests/npm-client.test.ts -t "reads the legacy license object"` — Expected: FAIL with `expected null to be 'MIT'`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/npm-client.ts`, insert before `toCandidate` (before line 214):

```ts
/**
 * The declared license as a string, from any spelling npm actually serves.
 *
 * The current field is an SPDX string, but the registry still carries the two
 * legacy forms — `license: { type, url }` and `licenses: [{ type, url }]` —
 * which npm publishes with a warning rather than a refusal. Reading only the
 * string form told those authors "Declares no license.", a published reason
 * that was simply false (audit A-7).
 * @param license - the manifest `license` value, unvalidated.
 * @param licenses - the manifest `licenses` value, unvalidated.
 * @returns the license identifier, or null when nothing declares one.
 */
function normalizeLicense(license: unknown, licenses: unknown): string | null {
  if (typeof license === 'string') return license.trim() === '' ? null : license
  if (license !== null && typeof license === 'object' && !Array.isArray(license)) {
    const type = (license as { type?: unknown }).type
    if (typeof type === 'string' && type.trim() !== '') return type
  }
  if (Array.isArray(licenses)) {
    for (const item of licenses) {
      if (typeof item === 'string' && item.trim() !== '') return item
      if (item !== null && typeof item === 'object') {
        const type = (item as { type?: unknown }).type
        if (typeof type === 'string' && type.trim() !== '') return type
      }
    }
  }
  return null
}

/**
 * Whether npm reports this version deprecated.
 *
 * `npm deprecate <pkg> ""` is the documented un-deprecate, and it leaves
 * `deprecated: ""` behind — so the presence of the key says nothing. A
 * non-empty message means deprecated; so does a bare `true`, which some
 * manifests carry and which we must not read as "fine" (audit B-5).
 * @param deprecated - the manifest `deprecated` value, unvalidated.
 */
function isDeprecated(deprecated: unknown): boolean {
  if (deprecated === true) return true
  return typeof deprecated === 'string' && deprecated.trim() !== ''
}
```

In the packument type inside `toCandidate` (lines 220-230), add `licenses` beside `license`:

```ts
    versions?: Record<string, {
      dist?: { integrity?: unknown }
      license?: unknown
      licenses?: unknown
      repository?: unknown
      deprecated?: unknown
      description?: unknown
      keywords?: unknown
      _npmUser?: { name?: unknown }
      peerDependencies?: unknown
      dsh?: { bundle?: unknown; catalog?: unknown }
    }>
```

Replace lines 244-245:

```ts
    license: typeof manifest.license === 'string' ? manifest.license : null,
    deprecated: manifest.deprecated !== undefined,
```

with:

```ts
    license: normalizeLicense(manifest.license, manifest.licenses),
    deprecated: isDeprecated(manifest.deprecated),
```

In `registry/scripts/src/gate.ts`, replace lines 82-84:

```ts
  if (candidate.license === null || candidate.license === '') {
    return reject(name, 'no-license', 'Declares no license.')
  }
```

with:

```ts
  if (candidate.license === null || candidate.license === '') {
    // The detail names what npm expects, because the author has to act on it:
    // the projection already accepts the two legacy forms (`license: { type }`
    // and `licenses: []`), so reaching here means nothing declares a license
    // at all.
    return reject(name, 'no-license',
      'Declares no license, so nobody can tell on what terms the code may be used. Declare an SPDX identifier, e.g. "license": "MIT".')
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts registry/scripts/tests/gate.test.ts` — Expected: PASS. The existing `gate.test.ts` "rejects a package with no license" test only checks the code, so it is unaffected.
Run: `pnpm test` — Expected: PASS, 23 files / 388 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/src/gate.ts registry/scripts/tests/npm-client.test.ts registry/scripts/tests/gate.test.ts
git commit -m "fix(registry): read npm's un-deprecate spelling and the legacy license forms"
```

---

### Task 13: workspaces globs are anchored at both ends, accept literal paths, and support `**`

Finding B-7, the selection half. `globToRegex` (`subpackage-select.ts:51-58`) anchors only the start and is tested against `${dir}/`, so `packages/*` also matches `packages/a/lib0`: seven nested manifests of one package displace real siblings past the cap of 8 (`packages/b` and `packages/zeta-plugin` vanish behind `packages/a/lib0…lib6`). Explicit non-glob `workspaces` entries are filtered out at `:80` and `:83`, so `workspaces: ['packages/core']` leaves no matcher and the `packages/*` fallback finds nothing. And a `**` glob fails the `/^\.?\/?[^*]*\*[^*]*$/` test, yields `null`, and the convention fallback is skipped because `globs` was non-empty.

**Files:**
- Modify: `registry/scripts/src/subpackage-select.ts:49-58`, `:76-99`
- Test: `registry/scripts/tests/subpackage-select.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `selectSubpackagePaths(rootManifest: unknown, treePaths: string[]): string[]`.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/subpackage-select.test.ts`, inside `describe('selectSubpackagePaths', ...)`:

```ts
  it('does not let one package nested manifests displace its siblings', () => {
    // The regex was anchored only at the start, so `packages/*` matched
    // `packages/a/lib0` too: seven nested manifests filled the cap of 8 and
    // the real siblings never got probed.
    const nested = [
      'package.json',
      ...Array.from({ length: 7 }, (_, i) => `packages/a/lib${i}/package.json`),
      'packages/b/package.json',
      'packages/zeta-plugin/package.json',
    ]
    const paths = selectSubpackagePaths({ workspaces: ['packages/*'] }, nested)
    expect(paths).toEqual(['packages/a', 'packages/b', 'packages/zeta-plugin'])
  })

  it('honours a literal workspaces entry instead of dropping it', () => {
    // `workspaces: ['packages/core', 'tools/*']` is a real declaration. The
    // literal entry was filtered out for containing no `*`, and when every
    // entry was literal the repo fell back to `packages/*` and found nothing.
    const paths = selectSubpackagePaths(
      { workspaces: ['packages/core', 'tools/*'] },
      ['package.json', 'packages/core/package.json', 'packages/other/package.json', 'tools/cli/package.json'],
    )
    expect(paths).toEqual(['packages/core', 'tools/cli'])
  })

  it('supports a ** glob at any depth', () => {
    const paths = selectSubpackagePaths(
      { workspaces: ['packages/**'] },
      ['package.json', 'packages/a/package.json', 'packages/group/b/package.json'],
    )
    expect(paths).toEqual(['packages/a', 'packages/group/b'])
  })

  it('falls back to the convention when no entry yields a matcher', () => {
    const paths = selectSubpackagePaths(
      { workspaces: ['!(vendor)/*'] },
      ['package.json', 'packages/a/package.json'],
    )
    expect(paths).toEqual(['packages/a'])
  })

  it('reads the object form and tolerates a leading ./ and a trailing slash', () => {
    const paths = selectSubpackagePaths(
      { workspaces: { packages: ['./packages/*/'] } },
      ['package.json', 'packages/a/package.json', 'packages/a/nested/package.json'],
    )
    expect(paths).toEqual(['packages/a'])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/subpackage-select.test.ts -t "does not let one package nested manifests displace its siblings"` — Expected: FAIL with `expected [ 'packages/a', 'packages/a/lib0', 'packages/a/lib1', … ] to deeply equal [ 'packages/a', 'packages/b', 'packages/zeta-plugin' ]`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/subpackage-select.ts`, replace lines 49-58:

```ts
/** Convert one workspaces glob to an anchored regex. Supports the `*` forms
 * actually used in monorepo declarations; anything else matches nothing. */
function globToRegex(glob: string): RegExp | null {
  const escaped = glob
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]+')
  if (!/^\.?\/?[^*]*\*[^*]*$/.test(glob)) return null
  return new RegExp(`^${escaped.replace(/^\.\//, '')}`)
}
```

with:

```ts
/**
 * Convert one `workspaces` entry to a regex anchored at BOTH ends, matched
 * against a subpackage directory path with no trailing slash.
 *
 * The end anchor is the fix: with only a start anchor, `packages/*` also
 * matched `packages/a/lib0`, so seven nested manifests of one package filled
 * the cap of 8 and the repository's real siblings were never probed.
 *
 * `*` matches one path segment, `**` matches one or more — the two forms
 * monorepo declarations use. An entry with no `*` at all is a literal path
 * and becomes its own exact matcher: `workspaces: ['packages/core']` is a
 * real declaration, and dropping it left the repository with no matcher.
 * Anything else (negations, brace expansion, `***`) yields null, and the
 * caller falls back to the convention rather than probing nothing.
 * @param glob - one raw workspaces entry.
 * @returns the matcher, or null when the entry is not a form we support.
 */
function globToRegex(glob: string): RegExp | null {
  const cleaned = glob.replace(/^\.?\//, '').replace(/\/+$/, '')
  if (cleaned === '') return null
  if (cleaned.includes('***') || /[?![\]{}()!]/.test(cleaned)) return null
  const pattern = cleaned
    .split(/(\*\*|\*)/)
    .map(part => (part === '**' ? '.+' : part === '*' ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${pattern}$`)
}
```

Replace lines 76-99:

```ts
export function selectSubpackagePaths(rootManifest: unknown, treePaths: string[]): string[] {
  const m = rootManifest as { workspaces?: unknown }
  let globs: string[]
  if (Array.isArray(m.workspaces)) {
    globs = m.workspaces.filter((entry): entry is string => typeof entry === 'string' && entry.includes('*'))
  } else if (typeof m.workspaces === 'object' && m.workspaces !== null && Array.isArray((m.workspaces as { packages?: unknown }).packages)) {
    const packages = (m.workspaces as { packages: unknown[] }).packages
    globs = packages.filter((entry): entry is string => typeof entry === 'string' && entry.includes('*'))
  } else {
    globs = [CONVENTION_GLOB]
  }
  if (globs.length === 0) globs = [CONVENTION_GLOB]
  const matchers = globs.map(globToRegex).filter((r): r is RegExp => r !== null)

  const dirs = new Set<string>()
  for (const path of treePaths) {
    if (!path.endsWith('/package.json')) continue
    const dir = path.slice(0, -'/package.json'.length)
    if (dir === '') continue // the root's own manifest is never a subpackage
    if (EXCLUDED_DIRS.test(dir)) continue
    if (!matchers.some(regex => regex.test(`${dir}/`))) continue
    dirs.add(dir)
  }
  return [...dirs].sort().slice(0, MAX_SUBPACKAGES)
}
```

with:

```ts
export function selectSubpackagePaths(rootManifest: unknown, treePaths: string[]): string[] {
  const m = rootManifest as { workspaces?: unknown }
  let globs: string[]
  if (Array.isArray(m.workspaces)) {
    globs = m.workspaces.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  } else if (typeof m.workspaces === 'object' && m.workspaces !== null && Array.isArray((m.workspaces as { packages?: unknown }).packages)) {
    const packages = (m.workspaces as { packages: unknown[] }).packages
    globs = packages.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
  } else {
    globs = [CONVENTION_GLOB]
  }
  if (globs.length === 0) globs = [CONVENTION_GLOB]
  let matchers = globs.map(globToRegex).filter((r): r is RegExp => r !== null)
  if (matchers.length === 0) {
    // Every declared entry was a form we do not support. Probing nothing
    // would report the repository `no-bundle` with no probe having happened;
    // the convention is a better guess than silence.
    const fallback = globToRegex(CONVENTION_GLOB)
    matchers = fallback === null ? [] : [fallback]
  }

  const dirs = new Set<string>()
  for (const path of treePaths) {
    if (!path.endsWith('/package.json')) continue
    const dir = path.slice(0, -'/package.json'.length)
    if (dir === '') continue // the root's own manifest is never a subpackage
    if (EXCLUDED_DIRS.test(dir)) continue
    // Matched against the directory itself, with both anchors: matching
    // `${dir}/` against a start-anchored regex is what let a nested manifest
    // satisfy its parent's glob.
    if (!matchers.some(regex => regex.test(dir))) continue
    dirs.add(dir)
  }
  return [...dirs].sort().slice(0, MAX_SUBPACKAGES)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/subpackage-select.test.ts` — Expected: PASS (9 tests). The four existing tests hold: `packages/*` against the shared `tree` still selects exactly `packages/core`, `packages/plugin-one`, `packages/plugin-two`, and `packages/examples/demo` plus `packages/plugin-one/node_modules/x` are now excluded twice over (by the end anchor and by `EXCLUDED_DIRS`).
Run: `npx vitest run registry/scripts/tests/github-client.test.ts` — Expected: PASS (the probe's selection is the only thing that changed).
Run: `pnpm test` — Expected: PASS, 23 files / 393 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/subpackage-select.ts registry/scripts/tests/subpackage-select.test.ts
git commit -m "fix(registry): anchor workspaces globs at both ends, accept literal paths and **"
```

---

### Task 14: a probed monorepo root says why, instead of pointing the author at the wrong file

Finding B-7, the detail half. `docs/design/2026-08-31-hub-borrowings.md` §A requires: "Rejection detail for a monorepo with no listable subpackage stays `no-bundle`, with the detail extended to say why (root has no bundle and no installable subpackage)." Today the root gets the generic detail, so the author of a monorepo whose subpackage IS the plugin is told to add `dsh.bundle` to the root manifest — the wrong file.

**Files:**
- Modify: `registry/scripts/src/types.ts` (`RepoCandidate`)
- Modify: `registry/scripts/src/github-client.ts:462-503` (`probeSubpackageCandidates` return), `:551-554`
- Modify: `registry/scripts/src/repo-gate.ts:68-71`
- Test: `registry/scripts/tests/repo-gate.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RepoCandidate.probedSubpackages?: number`. `repo-state.ts` casts stored candidates straight through (`repo-state.ts:70-71`), so the new optional field round-trips the committed harvest memory without a codec change.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/repo-gate.test.ts`:

```ts
describe('the no-bundle detail names the file the author must fix', () => {
  it('tells a plain package to declare dsh.bundle in its package.json', () => {
    const result = gateRepo(repo({ hasBundle: false }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-bundle')
      expect(result.rejection.detail).toContain('plain dependency')
      expect(result.rejection.detail).not.toContain('subpackage')
    }
  })

  it('tells a probed monorepo root that no subpackage declared one either', () => {
    // hub-borrowings §A: the root keeps the `no-bundle` code, but the detail
    // has to say a probe happened — otherwise the author of a monorepo whose
    // subpackage is the plugin is told to edit the root manifest.
    const result = gateRepo(repo({ hasBundle: false, probedSubpackages: 6 }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('no-bundle')
      expect(result.rejection.detail).toContain('6 subpackage')
      expect(result.rejection.detail).toContain('none of them declares dsh.bundle')
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts -t "tells a probed monorepo root"` — Expected: FAIL at typecheck inside vitest: `Object literal may only specify known properties, and 'probedSubpackages' does not exist in type 'Partial<RepoCandidate>'`; with the field added but no gate change, `expected 'Declares no dsh.bundle in its package.json, so dsh installs it as a plain dependency, not a plugin.' to contain '6 subpackage'`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/types.ts`, add to `RepoCandidate` after the `subdir` field (line 98):

```ts
  /**
   * How many subpackage manifests the harvest probed for this root, when it
   * probed any and none declared a bundle. Present only on a bundle-less
   * monorepo root, and only to make its rejection truthful: without it the
   * root is told to add `dsh.bundle` to the file the author already knows is
   * not the plugin (hub-borrowings §A, audit B-7).
   */
  probedSubpackages?: number
```

In `registry/scripts/src/github-client.ts`, change `probeSubpackageCandidates` to report how many manifests it selected. Replace its signature and the two `return []` early exits plus the final return:

```ts
async function probeSubpackageCandidates(
  owner: string,
  slug: string,
  meta: RepoMeta,
  rootManifest: unknown,
  head: { sha: string; date: string },
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<{ candidates: RepoCandidate[]; probed: number }> {
```

with the body's exits becoming `return { candidates: [], probed: 0 }` for the two unreadable-tree cases, and:

```ts
  return { candidates, probed: dirs.length }
```

as the final line, in place of `return candidates`.

Then in `fetchRepoCandidate`, replace lines 551-554:

```ts
  if (probeSubpackages && monorepoSignal(manifest)) {
    const subs = await probeSubpackageCandidates(owner, slug, meta, manifest, head, fetchImpl, sleep, token)
    if (subs.length > 0) return { ok: true, candidates: subs }
  }
```

with:

```ts
  if (probeSubpackages && monorepoSignal(manifest)) {
    const probe = await probeSubpackageCandidates(owner, slug, meta, manifest, head, fetchImpl, sleep, token)
    if (probe.candidates.length > 0) return { ok: true, candidates: probe.candidates }
    // The probe happened and found nothing installable. Record how many
    // manifests it read so the root's rejection can say so instead of
    // pointing the author at the root manifest (B-7).
    if (root !== null && probe.probed > 0) root.probedSubpackages = probe.probed
  }
```

In `registry/scripts/src/repo-gate.ts`, replace lines 68-71:

```ts
  if (!candidate.hasBundle) {
    return reject(unit, 'no-bundle',
      'Declares no dsh.bundle in its package.json, so dsh installs it as a plain dependency, not a plugin.')
  }
```

with:

```ts
  if (!candidate.hasBundle) {
    // Same code either way — the repository is not installable as a plugin —
    // but the detail has to name the file the author can act on. A monorepo
    // root whose subpackage is the plugin was being told to edit the root
    // manifest (hub-borrowings §A, audit B-7).
    const probed = candidate.probedSubpackages ?? 0
    return reject(unit, 'no-bundle', probed > 0
      ? `Declares no dsh.bundle in its package.json, and ${probed} subpackage manifest(s) were probed — none of them declares dsh.bundle either, so dsh would install this repository as a plain dependency, not a plugin. Declare dsh.bundle in the subpackage that IS the plugin.`
      : 'Declares no dsh.bundle in its package.json, so dsh installs it as a plain dependency, not a plugin.')
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts registry/scripts/tests/github-client.test.ts registry/scripts/tests/repo-state.test.ts` — Expected: PASS. `repo-gate.test.ts:41-49` still passes: its candidate carries no `probedSubpackages`, so it gets the unchanged detail and its `toContain('plain dependency')` assertion holds.
Run: `pnpm test` — Expected: PASS, 23 files / 395 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/github-client.ts registry/scripts/src/repo-gate.ts registry/scripts/tests/repo-gate.test.ts
git commit -m "fix(registry): a probed monorepo root's no-bundle detail names the real cause"
```

---

### Task 15: reproduce B-11 before changing anything

Finding B-11 is the only *Plausible* item in this plan's scope: `repo-gate.ts:76-79` rejects a repository carrying `workspace:`-protocol dependencies with "a git install from outside it cannot succeed", but a **release-rescued** entry installs the release tarball, not a git ref, and a tarball's manifest is rewritten at pack time. If that rewrite happens, the published reason is misattributed for that class of entry. **The fix in Step 3 is conditional on Step 1's outcome**, and a reproduction that fails to reproduce closes the finding with no code change.

**Files:**
- Reproduction only: a throwaway script in the session scratchpad directory (nothing in the repository)
- Conditionally modify: `registry/scripts/src/repo-gate.ts:76-79`
- Conditionally test: `registry/scripts/tests/repo-gate.test.ts`
- Always modify: this plan file, recording the outcome

- [ ] **Step 1: Reproduce**

Write and run this script. It needs `pnpm` and no network beyond the local store.

```bash
#!/usr/bin/env bash
set -euo pipefail
work="$(mktemp -d)"
cd "$work"
cat > pnpm-workspace.yaml <<'YML'
packages:
  - packages/*
YML
printf '{"name":"repro-root","private":true,"version":"0.0.0"}\n' > package.json
mkdir -p packages/lib packages/plugin
printf '{"name":"repro-lib","version":"1.0.0"}\n' > packages/lib/package.json
cat > packages/plugin/package.json <<'JSON'
{
  "name": "repro-plugin",
  "version": "1.0.0",
  "dependencies": { "repro-lib": "workspace:^1.0.0" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
JSON
pnpm install --ignore-scripts >/dev/null 2>&1 || true
cd packages/plugin
pnpm pack --pack-destination "$work" >/dev/null
echo "--- packed manifest ---"
tar -xzOf "$work"/repro-plugin-1.0.0.tgz package/package.json
```

Read the printed `dependencies`:

- **`"repro-lib": "^1.0.0"` (or any non-`workspace:` specifier) — CONFIRMED.** The tarball a release-rescued entry installs carries no `workspace:` specifier, so the rejection's stated reason ("a git install from outside it cannot succeed") does not describe what that entry would do. Continue to Step 2. Note also that `fetchLatestReleaseTarball` (`github-client.ts:334-355`) reads `body.assets`, which holds only author-uploaded assets — GitHub's auto-generated source archives live in `tarball_url`/`zipball_url` and are never selected — so the rescued artifact is pack output, not a source snapshot.
- **`"repro-lib": "workspace:^1.0.0"` unchanged — CLOSED.** The reason applies to the tarball too. Skip Steps 2-4, record the outcome in Step 5, and change no code.

Record the exact printed line under this task before going on.

**Outcome: CONFIRMED (run 2026-09-04, pnpm 11.13.0).** The packed manifest printed:

```json
  "dependencies": {
    "repro-lib": "^1.0.0"
  },
```

The `workspace:` prefix is gone — `pnpm pack` resolved it. The second half of
the premise was verified in the source rather than assumed:
`fetchLatestReleaseTarball` reads `body.assets[].browser_download_url` and
nothing else, and `tarball_url` / `zipball_url` appear **zero** times in
`github-client.ts`, so the rescued artifact is author-uploaded pack output and
never GitHub's auto-generated source snapshot. Steps 2-4 were executed.

- [ ] **Step 2: Write the failing test (only if CONFIRMED)**

Append to `registry/scripts/tests/repo-gate.test.ts`:

```ts
describe('workspace deps and the release rescue', () => {
  it('still rejects a git-installed repository with workspace: dependencies', () => {
    const result = gateRepo(repo({ hasWorkspaceDeps: true }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('workspace-deps')
      expect(result.rejection.detail).toContain('a git install from outside it cannot succeed')
    }
  })

  it('accepts a release-rescued repository whose SOURCE manifest has workspace: deps', () => {
    // B-11, reproduced <DATE>: `pnpm pack` rewrites `workspace:^1.0.0` to
    // `^1.0.0` in the packed manifest, and a release-rescued entry installs
    // that tarball, never the git ref. The old rejection told the author a
    // git install would fail — for an entry that performs no git install.
    // A sibling that is genuinely unpublished is still an honest
    // install-time failure the executor reports verbatim, which is the same
    // posture the github-channel design takes for transitive postinstall
    // scripts (§4, item 2b).
    const result = gateRepo(repo({
      hasWorkspaceDeps: true,
      release: {
        tag: 'v1.0.0',
        url: 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/plugin.tgz',
        sha256: 'a'.repeat(64),
      },
    }), config)
    expect(result.ok, result.ok ? '' : result.rejection.detail).toBe(true)
  })
})
```

Replace `<DATE>` with the date the reproduction was run.

- [ ] **Step 3: Run test to verify it fails (only if CONFIRMED)**

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts -t "accepts a release-rescued repository whose SOURCE manifest"` — Expected: FAIL with `expected 'Declares workspace:-protocol dependencies, which resolve only inside the repository's own workspace; a git install from outside it cannot succeed. …' … expected false to be true`.

- [ ] **Step 4: Write the implementation (only if CONFIRMED)**

In `registry/scripts/src/repo-gate.ts`, replace lines 76-79:

```ts
  if (candidate.hasWorkspaceDeps) {
    return reject(unit, 'workspace-deps',
      'Declares workspace:-protocol dependencies, which resolve only inside the repository\'s own workspace; a git install from outside it cannot succeed. Publish the package to npm, or drop the workspace: specifiers, and it can be listed.')
  }
```

with:

```ts
  // Only for a GIT install, which is what the reason describes. A
  // release-rescued entry installs the release tarball, and `pnpm pack`
  // rewrites `workspace:` specifiers into resolved ranges when it builds one
  // (reproduced, audit B-11) — so this rejection would have named a failure
  // mode that entry cannot have. Symmetric with the `requires-build` rule
  // directly above: the rescue answers exactly the objections that are about
  // installing from git. An unpublished sibling remains an honest
  // install-time failure the executor reports verbatim, as the github-channel
  // design §4 already accepts for transitive postinstall scripts.
  if (candidate.hasWorkspaceDeps && candidate.release === undefined) {
    return reject(unit, 'workspace-deps',
      'Declares workspace:-protocol dependencies, which resolve only inside the repository\'s own workspace; a git install from outside it cannot succeed. Publish the package to npm, attach a packed release tarball, or drop the workspace: specifiers, and it can be listed.')
  }
```

Run: `npx vitest run registry/scripts/tests/repo-gate.test.ts` — Expected: PASS. Note the existing "rejects a manifest with workspace:-protocol dependencies, naming the exit" test asserts `toContain('Publish the package to npm')`, which the new detail still satisfies.
Run: `pnpm test` and `pnpm typecheck` — Expected: PASS / no output.

- [ ] **Step 5: Commit**

If CONFIRMED:

```bash
git add registry/scripts/src/repo-gate.ts registry/scripts/tests/repo-gate.test.ts docs/plans/2026-09-03-audit-fix-b-identity-trust.md
git commit -m "fix(registry): the workspace-deps rejection applies to git installs, not release rescues"
```

If CLOSED (record the reproduction output in this task and change nothing else):

```bash
git add docs/plans/2026-09-03-audit-fix-b-identity-trust.md
git commit -m "docs: close audit B-11 — pnpm pack keeps workspace: specifiers, so the reason holds"
```

---

### Task 16: an LLM market verdict is a hold, not a delisting

> **Outcome: implemented 2026-09-04, then the `by: human` gate was REVERTED the
> same day.** The steps below are kept as written because the rest of the task
> shipped and stands — the `notes` channel on `emit`, the deduplicated
> `notAShopListed`, and `docs/design/2026-09-03-market-judge.md`. What was
> reverted is the one line deriving `notAShop`, plus the `marketHolds` field
> it fed.
>
> Two measurements killed the gate. `notAShop` is the CLEARED list and the
> client shows a name that is cleared OR not shop-like
> (`ShopTab.tsx:920-922`), so routing an LLM `true` into it ADVERTISED the 16
> shop-like names among the 17 live `by: llm` rows — the opposite of a hold.
> And there is no human: `verified.yml`, `denied.yml` and
> `allowed-similar.yml` are empty by design, so a hold whose only exit is a
> human is a permanent no-op. The same reading bounds D-7's severity, which
> this task overstated: a steered `true` on an ordinarily-named plugin
> withholds nothing, because `isShopLike` is false for it. See
> `docs/design/2026-09-03-market-judge.md` §4 for the full record.
>
> Policy as shipped: the verdict decides, `by` records who judged it, and the
> build report names every `by: llm` withholding for a spot-check.


Finding D-7. `market: true, by: llm` hides an entry from every shelf: only `market: false` names reach `notAShop` in `plugins.json` (`config.ts:150`, `emit.ts:171-175`), the client hides shop-like names absent from that list (`ShopTab.tsx:890-894`), and `mergeMarketRows` never re-asks or overwrites a recorded verdict — so the hide is permanent and no human ever sees it happen. `parseMarketResponse` accepts any name in the batch's `expected` set, and batches are sorted names, so a description in package A that steers the model into emitting `{"name": "<neighbour>", "market": true}` removes a competitor for good. That is the CLAUDE.md rule "LLM output ... never removes an entry" being broken in production, on 14 live rows.

The fix is not to make the parser cleverer — the model may legitimately answer the batch in any order, so there is no positional check to add. The fix is that an LLM `true` cannot hide anything by itself.

**Files:**
- Modify: `registry/scripts/src/config.ts:34-46` (the `markets.yml` doc comment), `:62-67`, `:143-150`, the return
- Modify: `registry/scripts/src/markets.ts:19-54` (the file header)
- Modify: `registry/scripts/src/emit.ts:127-134` (`notes` parameter), `:164-175`, `:207-217`
- Modify: `registry/scripts/src/pipeline.ts` (compute the note)
- Create: `docs/design/2026-09-03-market-judge.md`
- Test: `registry/scripts/tests/config.test.ts`, `registry/scripts/tests/markets.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `compareStrings` (Task 1), `PipelineResult` (Task 10).
- Produces: `RegistryConfig.marketHolds: Set<string>`; `emit(..., notes: readonly string[] = [])` as a seventh positional parameter — Task 17 uses the same channel.

- [ ] **Step 1: Write the failing test**

**Rewrite** `config.test.ts:12-30`. Its title, "derives the shop-like exemption from market:false rows only", states the rule this task replaces; the assertion happens to survive because the fixture has no `market: true, by: llm` row, which is exactly the case that matters. Replace the whole test with:

```ts
  it('withholds a listing only for a HUMAN market verdict; an LLM true is a hold', () => {
    // markets.yml records BOTH verdicts so the classifier has a memory and
    // never re-asks. What clears the client's name filter is "not judged a
    // market BY A HUMAN": an LLM `true` used to hide the entry from every
    // shelf, permanently and silently, which is the CLAUDE.md rule that LLM
    // output never removes an entry (audit D-7). A wrong `false` lists one
    // competitor on a shelf of nine thousand; a wrong `true` deletes a
    // working plugin. Those are not equal.
    const config = parseRegistryConfig({
      ...empty,
      markets: [
        '- name: dsh-plugin-market\n  market: true\n  by: human\n  reason: a market\n',
        '- name: dsh-tea-store\n  market: false\n  by: human\n  reason: stores tea\n',
        '- name: dsh-skin-market\n  market: false\n  by: llm\n  reason: sells skins\n',
        '- name: dsh-maybe-market\n  market: true\n  by: llm\n  reason: looks like a market\n',
      ].join(''),
    })
    expect([...config.notAShop].sort()).toEqual(['dsh-maybe-market', 'dsh-skin-market', 'dsh-tea-store'])
    expect([...config.marketHolds]).toEqual(['dsh-maybe-market'])
    // Judged covers every verdict: the classifier asks only about names
    // absent from it, so a name judged a market must be in here or it is
    // re-asked every day and can flip on a bad roll.
    expect([...config.marketsJudged].sort())
      .toEqual(['dsh-maybe-market', 'dsh-plugin-market', 'dsh-skin-market', 'dsh-tea-store'])
  })
```

Append to `registry/scripts/tests/markets.test.ts`:

```ts
describe('a steered verdict cannot delist a neighbour', () => {
  it('records a neighbour-named true as an llm hold, which hides nothing', () => {
    // The batch asked about dsh-a and its neighbour dsh-b. A hostile
    // description in dsh-a's metadata steers the model into answering `true`
    // for dsh-b. The parser cannot tell that apart from a legitimate answer —
    // batches may be answered in any order — so the defence is downstream:
    // an llm verdict is a hold a human confirms, never a hide.
    const verdicts = parseMarketResponse(
      '[{"name":"dsh-a","market":false},{"name":"dsh-b","market":true}]',
      new Set(['dsh-a', 'dsh-b']),
    )
    const rows = serializeMarketRows(mergeMarketRows([], verdicts, new Map()))
    const config = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
      markets: rows,
    })
    expect(config.notAShop.has('dsh-b'), 'an llm true must not hide the entry').toBe(true)
    expect([...config.marketHolds]).toEqual(['dsh-b'])
  })

  it('lets a human row confirm the hold', () => {
    const config = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]', firstSeen: '[]',
      markets: '- name: dsh-b\n  market: true\n  by: human\n  reason: it sells dsh plugins\n',
    })
    expect(config.notAShop.has('dsh-b')).toBe(false)
    expect(config.marketHolds.size).toBe(0)
  })
})
```

`markets.test.ts` must import `parseRegistryConfig`; add to its imports:

```ts
import { parseRegistryConfig } from '../src/config.ts'
```

Append to `registry/scripts/tests/pipeline.test.ts`:

```ts
describe('the market holds reach the build report', () => {
  it('names every held listing so a human can confirm or clear it', () => {
    const withHolds = parseRegistryConfig({
      verified: '[]',
      denied: '[]',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n- name: dsh-fs-tool\n  added: 2026-08-10\n',
      markets: '- name: dsh-hello-plugin\n  market: true\n  by: llm\n  reason: looks like a market\n',
    })
    const { report, pluginsJson } = runPipeline(candidates, [], withHolds, BUILT_AT)
    expect(report).toContain('Market holds awaiting human confirmation: 1')
    expect(report).toContain('- dsh-hello-plugin')
    // And the entry is still on the shelf: the hold does not remove it.
    const parsed = JSON.parse(pluginsJson) as { notAShop: string[] }
    expect(parsed.notAShop).toContain('dsh-hello-plugin')
  })

  it('says nothing when there are no holds', () => {
    const { report } = runPipeline(candidates, [], config, BUILT_AT)
    expect(report).not.toContain('Market holds')
  })

  it('publishes each cleared name once, however many entries share it', () => {
    // A-8 adjacent: `notAShop` was built one element per ENTRY, and 151 live
    // names are shared by 243 entries.
    const commit = 'f'.repeat(40)
    const cleared = parseRegistryConfig({
      verified: '[]', denied: '[]', allowedSimilar: '[]', categories: '[]',
      firstSeen: '- name: alice/dsh-store\n  added: 2026-08-01\n- name: bob/dsh-store\n  added: 2026-08-02\n',
      markets: '- name: dsh-store\n  market: false\n  by: human\n  reason: stores session logs\n',
    })
    const base: import('../src/types.ts').RepoCandidate = {
      name: 'dsh-store', repo: 'alice/dsh-store', commit, version: commit,
      publishedAt: '2026-08-01T12:00:00.000Z', repository: 'https://github.com/alice/dsh-store',
      license: 'MIT', hasBundle: true, requiresBuild: false, hasWorkspaceDeps: false,
      catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
      description: 'x',
    }
    const { pluginsJson } = runPipeline([], [
      base,
      { ...base, repo: 'bob/dsh-store', repository: 'https://github.com/bob/dsh-store' },
    ], cleared, BUILT_AT)
    const parsed = JSON.parse(pluginsJson) as { notAShop: string[] }
    expect(parsed.notAShop).toEqual(['dsh-store'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/config.test.ts -t "withholds a listing only for a HUMAN market verdict"` — Expected: FAIL with `expected [ 'dsh-skin-market', 'dsh-tea-store' ] to deeply equal [ 'dsh-maybe-market', 'dsh-skin-market', 'dsh-tea-store' ]`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/config.ts`, replace lines 143-150:

```ts
  const marketVerdicts = new Map<string, boolean>()
  const marketRows: MarketRow[] = []
  for (const row of parseFile('markets.yml', input.markets ?? '[]', marketsSchema)) {
    setUnique(marketVerdicts, 'markets.yml', row.name, row.market)
    marketRows.push(row)
  }
  const marketsJudged = new Set(marketVerdicts.keys())
  const notAShop = new Set([...marketVerdicts].filter(([, isMarket]) => !isMarket).map(([name]) => name))
```

with:

```ts
  const marketVerdicts = new Map<string, boolean>()
  const marketRows: MarketRow[] = []
  for (const row of parseFile('markets.yml', input.markets ?? '[]', marketsSchema)) {
    setUnique(marketVerdicts, 'markets.yml', row.name, row.market)
    marketRows.push(row)
  }
  const marketsJudged = new Set(marketVerdicts.keys())
  // Only a HUMAN `market: true` withholds a listing. An LLM `true` is a
  // HOLD: it stops the classifier re-asking — the flip-flop this file exists
  // to prevent — and it queues the name for a human, but the entry stays on
  // the shelf until somebody records `by: human`.
  //
  // Before this, an LLM `true` hid the entry from every shelf, permanently,
  // and nothing said so: the verdict was never re-asked and never
  // overwritten. `parseMarketResponse` adopts any name the batch asked about,
  // and batches are sorted names, so a hostile npm description could steer a
  // `true` onto a neighbouring package and delist a competitor for good
  // (audit D-7). CLAUDE.md: the classifier may change a category, never gate
  // a listing and never remove an entry.
  const notAShop = new Set(marketRows.filter(row => !(row.market && row.by === 'human')).map(row => row.name))
  const marketHolds = new Set(marketRows.filter(row => row.market && row.by === 'llm').map(row => row.name))
```

Add to `RegistryConfig`, after the `notAShop` field:

```ts
  /** Names an LLM judged a competing market and no human has confirmed. They
   * are still shelved; the build report lists them for review. */
  marketHolds: Set<string>
```

and add `marketHolds` to the returned object.

Replace the `markets.yml` doc comment above `marketsSchema` (lines 34-40) with:

```ts
/** `markets.yml`: every name the client's shop-like NAME filter catches, and
 * whether it IS a competing plugin market. Both verdicts are recorded, not
 * just the exemptions — that memory is what stops the daily classifier
 * re-asking about a name, and stops an LLM flip-flopping one in and out of
 * the shelf and churning the content hash with it. `by` decides what the
 * verdict DOES: `human` + `market: true` withholds the listing, while `llm` +
 * `market: true` is a hold that only a human can confirm. `reason` says what
 * the plugin actually is, because the name already misled once. */
```

In `registry/scripts/src/markets.ts`, replace these lines of `HEADER`:

```ts
  '#   market: true   a competing dsh plugin market. Stays off the shelf.',
  '#   market: false  not one. Shelved like any other entry; this clears the name',
  '#                  filter and NOTHING else — no trust tier, no skipped gate.',
```

with:

```ts
  '#   market: true   a competing dsh plugin market. Withheld from the shelf —',
  '#                  but only with by: human. With by: llm it is a HOLD: the',
  '#                  entry stays shelved and the build report lists it for a',
  '#                  human to confirm (by: human) or correct (market: false).',
  '#   market: false  not one. Shelved like any other entry; this clears the name',
  '#                  filter and NOTHING else — no trust tier, no skipped gate.',
```

and replace these lines of the same `HEADER`:

```ts
  '#   by: human   adjudicated in review. Never overwritten by the classifier.',
  '#   by: llm     judged by the daily classifier. Advisory like every other LLM',
  '#               verdict here — correct a wrong row by editing it, and it will',
  '#               not be re-asked.',
```

with:

```ts
  '#   by: human   adjudicated in review. Never overwritten by the classifier.',
  '#               This is the only value that can withhold a listing.',
  '#   by: llm     judged by the daily classifier. Advisory, like every other LLM',
  '#               verdict here: it removes nothing. A true is a review hold —',
  '#               correct a wrong row by editing it, and it will not be',
  '#               re-asked. A model steered by a hostile package description',
  '#               could otherwise have delisted a neighbour for good.',
```

In `registry/scripts/src/emit.ts`, replace the signature (lines 127-134) and add the parameter's doc line:

```ts
export function emit(
  entries: Entry[],
  rejections: Rejection[],
  builtAt: string,
  stars?: StarsPointer | null,
  schemaVersion: number = SCHEMA_VERSION,
  notAShop: ReadonlySet<string> = new Set(),
  notes: readonly string[] = [],
): Artifacts {
```

adding to its doc comment, after the `notAShop` line:

```
 * @param notes - report-only diagnostic lines (market holds, registry rows that
 *   matched nothing). They ride `report.md` and never the hashed data.
```

Replace lines 171-175:

```ts
  const notAShopListed = sorted
    .map(entry => entry.name)
    .filter(name => notAShop.has(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
```

with:

```ts
  // Deduplicated: the list is keyed by NAME because that is what the client's
  // filter reads, and one name can belong to many entries — 151 live names
  // are shared by 243 entries, so the old expression emitted the same name
  // once per entry.
  const notAShopListed = [...new Set(sorted.filter(entry => notAShop.has(entry.name)).map(entry => entry.name))]
    .sort(compareStrings)
```

Replace the report's `lines` array (lines 207-217) with:

```ts
  const lines = [
    '# Catalog build report',
    '',
    `Accepted: ${sorted.length}`,
    `Rejected: ${sortedRejections.length}`,
    ...(themeDowngraded > 0 ? [`Theme entries emitted as other (schemaVersion < 5): ${themeDowngraded}`] : []),
    // Diagnostics before the table, escaped like a cell: a note can quote a
    // package name, and an unescaped `|` or newline in one would corrupt the
    // document a maintainer reads.
    ...(notes.length > 0 ? ['', ...notes.map(escapeCell)] : []),
    '',
    '| Package | Reason | Detail |',
    '|---|---|---|',
    ...sortedRejections.map(r => `| ${escapeCell(r.name)} | ${escapeCell(r.code)} | ${escapeCell(r.detail)} |`),
  ]
```

In `registry/scripts/src/pipeline.ts`, add `compareStrings` to the identity import and compute the note between `entries` and the return:

```ts
import { compareStrings, firstSeenKey, repoUnit } from './identity.ts'
```

```ts
  // Report-only diagnostics. They ride `report.md`, never the hashed data,
  // and they are sorted so the report diffs cleanly.
  const notes: string[] = []
  const listedNames = new Set(entries.map(entry => entry.name))
  const holds = [...config.marketHolds].filter(name => listedNames.has(name)).sort(compareStrings)
  if (holds.length > 0) {
    notes.push(
      `Market holds awaiting human confirmation: ${holds.length}. An LLM judged these a competing plugin market. They are still on the shelf: record \`market: true, by: human\` in markets.yml to withhold one, or \`market: false\` to clear it.`,
      ...holds.map(name => `- ${name}`),
    )
  }
  return {
    ...emit(entries, rejections, builtAt, stars, schemaVersion, config.notAShop, notes),
    firstSeen,
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/config.test.ts registry/scripts/tests/markets.test.ts registry/scripts/tests/pipeline.test.ts registry/scripts/tests/emit.test.ts` — Expected: PASS.
Run: `pnpm test` — Expected: PASS, 23 files / 402 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Write the missing design record**

`docs/` has no design record of the market judge or `markets.yml` at all — the audit says so, and `grep -rl "market-judge\|markets.yml" docs/` confirms it. Create `docs/design/2026-09-03-market-judge.md` with exactly this content:

```markdown
# The market judge and `markets.yml` — design

Date: 2026-09-03
Status: describes shipped behaviour, with the D-7 amendment this document was written for.

## 1. Why the filter exists, and why it is not the answer

The shelf must not advertise its competitors, so the client hides an entry
whose NAME reads like a plugin marketplace (`shared/shop-like.ts`,
`isShopLike`). A name is a bad instrument for that question. On the live
catalog the filter caught 73 entries and 20 of them were innocent: 存茶指南
and 腌菜保存 (storing tea, storing pickles), an A-share quant plugin whose
"market" is the stock market, a session-log plugin whose "store" is a verb.

Those 20 were not merely mislabelled — they were catalogued, gated, tiered and
then never rendered, with nothing anywhere saying why. That is the failure this
design answers: the filter stays as a CANDIDATE selector, and every name it
catches goes to a recorded verdict.

## 2. The pieces

| Piece | Purity | What it does |
|---|---|---|
| `shared/shop-like.ts` | pure | the NAME heuristic; selects candidates, decides nothing |
| `market-select.ts` | pure | `selectMarketPending(candidates, judged)` — the names still lacking a verdict, deduplicated by name and sorted |
| `market-judge.ts` | shell | the prompt, and `parseMarketResponse`, which is pure |
| `markets.ts` | pure | `mergeMarketRows`, `serializeMarketRows` |
| `registry/markets.yml` | data | the recorded verdicts — a build input, like `verified.yml` |
| `config.ts` | shell | derives `notAShop` and `marketHolds` from the rows |

`markets.yml` is keyed by NAME, which is the unit the client filters on and
NOT the catalog's install identity. The two differ: the 73 caught entries carry
65 distinct names, because `dsh-plugin-market` is published by seven separate
repositories and `dsh-plugin-store` by three. A verdict covers every entry
sharing that name.

## 3. The question the model is asked

"Is this a MARKETPLACE FOR dsh PLUGINS — software whose purpose is to let a
user browse and install dsh plugins?" Narrow on purpose. "Is this a market?"
is what produced the eleven skill, skin, MCP, CLI-tool and agent marketplaces
sitting in the file: all markets, none of them selling dsh plugins.

The model is told to OMIT what it cannot decide rather than guess, because an
omitted name keeps the heuristic's answer and is asked again tomorrow, while a
recorded one is not.

## 4. What a verdict may do — the D-7 amendment

**An LLM verdict never removes an entry.** This is the CLAUDE.md rule, and
until 2026-09-03 the code broke it:

- `market: true, by: human` — withholds the listing. A human read the plugin.
- `market: true, by: llm` — a **hold**. The name is recorded, so the
  classifier does not re-ask it, and the build report lists it under "Market
  holds awaiting human confirmation". The entry stays on the shelf until a
  human records `by: human`.
- `market: false` — clears the name filter and nothing else. No trust tier, no
  skipped gate.

Why the asymmetry: a wrong `true` deletes a working plugin from every user's
view and nothing says so; a wrong `false` lists one competitor on a shelf of
nine thousand. Those costs are not equal.

Why a hold and not a stricter parser: `parseMarketResponse` adopts any name
the batch asked about, and it must — the model may answer a batch in any
order, so there is no positional check to add. But batches are sorted names,
so a package's own description can name its neighbour, and a hostile
description that steers the model into `{"name": "<neighbour>", "market":
true}` used to delist that neighbour permanently. The defence has to be
downstream of the parse, and it is: nothing an LLM says hides anything.

Rows are never pruned, for the reason the memory exists: a name that drops out
of the catalog for a day must not come back unjudged. `categories.yml` prunes
because a stale category costs nothing; a dropped verdict costs a re-ask and,
with it, the chance of a different answer.

## 5. Failure modes

- **Gateway unreachable, or no `LLM_API_KEY`.** `runBatches` swallows the
  outage; every pending name becomes a discard with a reason, keeps the
  heuristic's answer, and is asked again next build. No verdict is invented.
- **Unparseable completion.** `parseMarketResponse` returns nothing for the
  whole batch: a truncated or fenced answer is a discard, never a partial
  read.
- **A `"true"` string, a missing key, an unexpected name.** Dropped. Only a
  real boolean for a name the batch asked about is adopted.
- **A wrong recorded row.** Edit it. `by: human` is never overwritten by the
  classifier, and an existing `by: llm` row is not re-asked either — the file
  is the memory, so correcting it is the interface.

## 6. Operational

The default gateway is `http://8.141.31.123:3000/v1` (`classify.ts:37`, and
the same literal in `.github/workflows/daily.yml:41`) — plaintext, to a bare
IP.
An on-path party can read `LLM_API_KEY` from the request and forge verdicts
that the daily bot then commits. Under the amendment above a forged `true` is
only a hold, which is a real reduction in blast radius, but a forged `false`
still shelves a competing market and a read token is still a read token.
**Move the gateway to TLS with a hostname and a verified certificate.** This
is an infrastructure task, not a code change, and it is tracked as an
operational item in
`docs/plans/2026-09-03-audit-fix-b-identity-trust.md`.
```

The gateway address above is the literal at `registry/scripts/src/classify.ts:37`
(`process.env.LLM_BASE_URL ?? 'http://8.141.31.123:3000/v1'`), repeated at
`.github/workflows/daily.yml:41`. Re-read both before creating the file, so the
record cannot drift from the default it documents.

- [ ] **Step 6: Commit**

```bash
git add registry/scripts/src/config.ts registry/scripts/src/markets.ts registry/scripts/src/emit.ts registry/scripts/src/pipeline.ts registry/scripts/tests/config.test.ts registry/scripts/tests/markets.test.ts registry/scripts/tests/pipeline.test.ts docs/design/2026-09-03-market-judge.md
git commit -m "fix(registry): an LLM market verdict is a review hold, never a delisting"
```

- [ ] **Step 7: Amend CLAUDE.md**

Replace `CLAUDE.md:56`:

```
- **LLM output is advisory.** The classifier may change a category, never gate a listing, never remove an entry, and never block a publish. A failed classification leaves the entry unclassified and is retried on the next build; `categories.yml` is a build input like `verified.yml`.
```

with:

```
- **LLM output is advisory.** The classifier may change a category, never gate a listing, never remove an entry, and never block a publish. A failed classification leaves the entry unclassified and is retried on the next build; `categories.yml` and `markets.yml` are build inputs like `verified.yml`. In `markets.yml` only `by: human` can withhold a listing — an LLM `market: true` is a hold the build report names for review, because a hostile package description can steer a verdict onto a neighbouring package.
```

```bash
git add CLAUDE.md
git commit -m "docs: an LLM market verdict holds, it does not remove"
```

---

### Task 17: report the registry rows that matched no harvested candidate

Finding E-5, second half. Nothing reports a denial, a review or a clearance that matched nothing, so `DSH-Evil` in `denied.yml`, a review of a package that was unpublished, and a clearance for a repository that was renamed all sit in the files forever, doing nothing, with no signal. Task 3's grammar catches the shapes that can never match; this catches the shapes that can but do not.

**Files:**
- Modify: `registry/scripts/src/pipeline.ts` (new exported pure function, and one call)
- Test: `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `compareStrings` (Task 1); `RegistryConfig.verified`, `verifiedNames`, `denied`, `deniedRepos`, `allowedSimilar`, `allowedSimilarRepos` (Tasks 2 and 3); the `notes` channel on `emit` (Task 16).
- Produces: `export function unmatchedRegistryNotes(candidates: readonly Candidate[], repoCandidates: readonly RepoCandidate[], config: RegistryConfig): string[]`.

- [ ] **Step 1: Write the failing test**

Append to `registry/scripts/tests/pipeline.test.ts`:

```ts
describe('unmatchedRegistryNotes', () => {
  const commit = 'c'.repeat(40)
  const npmCandidate = candidates.find(c => c.name === 'dsh-hello-plugin')
  if (npmCandidate === undefined) throw new Error('fixture dsh-hello-plugin is missing')
  const repoCandidate: import('../src/types.ts').RepoCandidate = {
    name: 'dsh-repo-plugin', repo: 'Someone/dsh-repo-plugin', commit, version: commit,
    publishedAt: '2026-08-01T12:00:00.000Z', repository: 'https://github.com/Someone/dsh-repo-plugin',
    license: 'MIT', hasBundle: true, requiresBuild: false, hasWorkspaceDeps: false,
    catalog: { category: 'tool', summary: { en: 'x', zh: 'y' }, capabilities: [] },
    description: 'x',
  }

  it('says nothing when every row matched something', () => {
    const matched = parseRegistryConfig({
      verified: '- name: dsh-hello-plugin\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
      denied: '- name: someone/dsh-repo-plugin\n  reason: known bad actor\n',
      allowedSimilar: '- dsh-hello-plugin\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([npmCandidate], [repoCandidate], matched)).toEqual([])
  })

  it('names every row that matched nothing, with its file, sorted', () => {
    // A denial nobody can act on is worse than none: it reads as protection.
    const stale = parseRegistryConfig({
      verified: [
        '- name: dsh-unpublished\n  reviewedVersion: 1.0.0\n  reviewer: r\n  reviewCommit: c\n',
        `- name: dsh-renamed\n  repo: old/dsh-renamed\n  reviewedCommit: ${commit}\n  reviewer: r\n  reviewCommit: c\n`,
      ].join(''),
      denied: '- name: DSH-Evil\n  reason: typed in the wrong case\n',
      allowedSimilar: '- dsh-gone\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([npmCandidate], [repoCandidate], stale)).toEqual([
      'Registry rows that matched no harvested candidate this run:',
      '- allowed-similar.yml: dsh-gone',
      '- denied.yml: DSH-Evil',
      '- verified.yml: dsh-unpublished',
      '- verified.yml: old/dsh-renamed',
    ])
  })

  it('matches a repo row case-folded, and a denial against the bundle name too', () => {
    // A review and a denial of the same name cannot coexist (Task 4 throws),
    // so the two shapes are checked one config at a time. The candidate's
    // repo is `Someone/dsh-repo-plugin`, spelled differently in both rows.
    const reviewedAndCleared = parseRegistryConfig({
      verified: `- name: dsh-repo-plugin\n  repo: someone/dsh-repo-plugin\n  reviewedCommit: ${commit}\n  reviewer: r\n  reviewCommit: c\n`,
      denied: '[]',
      allowedSimilar: '- SOMEONE/dsh-repo-plugin\n',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([], [repoCandidate], reviewedAndCleared)).toEqual([])

    const deniedByBundleName = parseRegistryConfig({
      verified: '[]',
      denied: '- name: dsh-repo-plugin\n  reason: denied by bundle name\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '[]',
    })
    expect(unmatchedRegistryNotes([], [repoCandidate], deniedByBundleName)).toEqual([])
  })

  it('rides the build report', () => {
    const stale = parseRegistryConfig({
      verified: '[]',
      denied: '- name: dsh-never-seen\n  reason: nothing matches this\n',
      allowedSimilar: '[]',
      categories: '[]',
      firstSeen: '- name: dsh-hello-plugin\n  added: 2026-08-11\n- name: dsh-derived-plugin\n  added: 2026-08-12\n- name: dsh-fs-tool\n  added: 2026-08-10\n',
    })
    const { report } = runPipeline(candidates, [], stale, BUILT_AT)
    expect(report).toContain('Registry rows that matched no harvested candidate this run:')
    expect(report).toContain('- denied.yml: dsh-never-seen')
  })
})
```

Add `unmatchedRegistryNotes` to `pipeline.test.ts`'s import on line 3:

```ts
import { runPipeline, unmatchedRegistryNotes } from '../src/pipeline.ts'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run registry/scripts/tests/pipeline.test.ts -t "unmatchedRegistryNotes"` — Expected: FAIL with `SyntaxError: The requested module '../src/pipeline.ts' does not provide an export named 'unmatchedRegistryNotes'`.

- [ ] **Step 3: Write the implementation**

In `registry/scripts/src/pipeline.ts`, add this exported function above `runPipeline`:

```ts
/**
 * Registry rows that matched nothing this run, as report lines.
 *
 * A denial, a review or a clearance is matched EXACTLY (the repo keyspace
 * case-folded), so a row whose name is mistyped, re-cased, or left behind by
 * an unpublish simply never fires — and a denial nobody can act on is worse
 * than no denial, because it reads as protection (audit E-5). The grammar
 * check in `config.ts` catches shapes that can never match; this catches the
 * shapes that can but do not.
 *
 * Report-only: no row is dropped and no listing changes. Whether a stale row
 * should be deleted is a human's call — a package can be unpublished for a
 * week and come back.
 * @param candidates - every npm candidate this run harvested.
 * @param repoCandidates - every repository candidate this run harvested.
 * @param config - the human-authored registry files.
 * @returns the lines to add to the build report, or `[]` when everything matched.
 */
export function unmatchedRegistryNotes(
  candidates: readonly Candidate[],
  repoCandidates: readonly RepoCandidate[],
  config: RegistryConfig,
): string[] {
  const npmNames = new Set(candidates.map(candidate => candidate.name))
  const repoFullNames = new Set(repoCandidates.map(candidate => candidate.repo.toLowerCase()))
  const bundleNames = new Set(repoCandidates.map(candidate => candidate.name))
  const rows: { file: string; row: string }[] = []
  for (const [key, review] of config.verified) {
    // The key already says which channel the review is for: an npm review is
    // keyed by package name, a github review by lowercased `owner/slug`.
    const matched = review.reviewedVersion === undefined
      ? repoFullNames.has(key)
      : npmNames.has(key)
    if (!matched) rows.push({ file: 'verified.yml', row: key })
  }
  for (const key of config.denied.keys()) {
    // A denial may name an npm package, a repository, or a bundle name — the
    // repo gate reads all three.
    const matched = npmNames.has(key) || bundleNames.has(key) || repoFullNames.has(key.toLowerCase())
    if (!matched) rows.push({ file: 'denied.yml', row: key })
  }
  for (const entry of config.allowedSimilar) {
    const matched = npmNames.has(entry) || repoFullNames.has(entry.toLowerCase())
    if (!matched) rows.push({ file: 'allowed-similar.yml', row: entry })
  }
  if (rows.length === 0) return []
  rows.sort((a, b) => compareStrings(a.file, b.file) || compareStrings(a.row, b.row))
  return [
    'Registry rows that matched no harvested candidate this run:',
    ...rows.map(row => `- ${row.file}: ${row.row}`),
  ]
}
```

and extend the `notes` block Task 16 added, so it reads:

```ts
  // Report-only diagnostics. They ride `report.md`, never the hashed data,
  // and they are sorted so the report diffs cleanly.
  const notes: string[] = []
  const listedNames = new Set(entries.map(entry => entry.name))
  const holds = [...config.marketHolds].filter(name => listedNames.has(name)).sort(compareStrings)
  if (holds.length > 0) {
    notes.push(
      `Market holds awaiting human confirmation: ${holds.length}. An LLM judged these a competing plugin market. They are still on the shelf: record \`market: true, by: human\` in markets.yml to withhold one, or \`market: false\` to clear it.`,
      ...holds.map(name => `- ${name}`),
    )
  }
  notes.push(...unmatchedRegistryNotes(candidates, repoCandidates, config))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run registry/scripts/tests/pipeline.test.ts` — Expected: PASS.
Run: `pnpm test` — Expected: PASS, 23 files / 406 tests.
Run: `pnpm typecheck` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/pipeline.ts registry/scripts/tests/pipeline.test.ts
git commit -m "feat(registry): report registry rows that matched no harvested candidate"
```

---

## Operational items — not code, and not for an agent to do alone

1. **Spot-check the 17 `market: true, by: llm` rows when convenient — nothing is blocked on it.** Superseded 2026-09-04: Task 16's hold was reverted, so those rows withhold as they always did and the shelf does not advertise them. What the build report now carries is the list itself, under "Withheld from the shelf on an LLM verdict alone", because a recorded row is never re-asked. Two of the 17 are our own packages (`dsh-plugin-shop`, `dsh-plugin-shop-catalog`), which `own.ts` excludes anyway, and `dsw-workshop-plugin` is the one name among them `isShopLike` does not match, so its verdict changes nothing either way. Correcting any row means editing it to `market: false`.
2. **Move the LLM gateway to TLS.** `http://8.141.31.123:3000/v1` (`classify.ts:53`, `.github/workflows/daily.yml:73` — re-derived 2026-09-04; the `:37` / `:41` written here first had already drifted) is plaintext to a bare IP, so an on-path party can read `LLM_API_KEY` and forge verdicts the bot commits. Task 16 reduces the blast radius of a forged `true` to a hold, but a forged `false` still shelves a competing market and a stolen token is still a stolen token. Infrastructure work: a hostname, a certificate, and `LLM_BASE_URL` updated in the workflow. Recorded in `docs/design/2026-09-03-market-judge.md` §6.
3. **Run `backfill-first-seen.ts` once, after WP0's C-1 fix (plan A).** Task 10 Step 6 has the command and the reason it needs a human on the diff.

## Verification for the whole plan

After the last task, from a clean checkout of the branch:

```sh
rm -rf lib                              # the main-checkout stale-lib trap
pnpm install
pnpm test                               # expect 23 files, ~406 tests, green
pnpm typecheck                          # expect no output
git diff --stat main                    # registry/ + docs/ only; no packages/, no .github/
```

The per-task test counts quoted in each Step 4 are arithmetic from the 334-test
baseline at `49db942`, which predates plan A; the baseline is 611 at `5f48787`,
so read those numbers as deltas rather than totals. A difference of a test or two — because a fixture grew,
or because a task's tests were split differently — is fine; what must not
differ is green.

Do **not** run `pnpm build:catalog` to check this work: it makes thousands of live npm and GitHub requests and takes tens of minutes (CLAUDE.md's Commands section measures it and is the authority; the ~8,800 this replaced was two overlapping keyword totals added together), and every policy decision here is covered by fixtures. The first real exercise is the next scheduled daily build, whose `report.md` should show the two new diagnostic sections and whose `manifest.lock` diff will be larger than usual exactly once, from the identity tiebreak in Task 11.

Mutation-check every new test the way audit H did before considering a task done: copy the module under test to the scratchpad, inject the bug the test claims to catch, point the test at the copy, and watch it fail. A test that stays green under its own mutation is not a test. The specific mutations worth trying here: swap `compareEntries`'s tiebreak order; drop the `.toLowerCase()` in `firstSeenKey`; change `verifiedAsThisPackage` to `ownReview !== undefined`; change `notAShop`'s filter to `!row.market`; change `globToRegex`'s `$` back to nothing.

## What this plan does not cover

- **G-1, the host half of WP1.** `installStart`, `installed()`, `validateInstall` and the client's `installedByName` / `tiers` / `sources` maps still address entries by name. That changes an RPC shape, so it ships as `X.Y.Z-beta.0`, gets installed on a real profile carrying a duplicate-name entry, and only then moves `latest`. The registry half landing first is deliberate: it is what makes the catalog's identities distinguishable for the host to key on.
- **C-1 / A-3 / E-1 / E-2** (the daily write-back loop) and everything else in WP0, WP3, WP4, WP5, WP6, WP7. Task 10 names its ordering dependency on C-1 explicitly.
- **A-1** (unbounded catalog strings) — WP0, and it amends the schema section rather than the trust model.
