# Market Borrowings Batch 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Account for every listed npm package the harvest stops returning (A2), and refuse every commit-pinned github entry whose pinned tree lacks a file its bundle loads (A3).

**Architecture:** A2 adds a pure classifier (`departures.ts`) and one network step in `npm-client.ts` that runs right after `fetchCandidates`, in `classify.ts` and in `build.ts`'s own harvest, comparing the committed `manifest.lock` with the harvest; its carried candidates, rows and counts ride `dist/harvest.json`. A3 generalizes `release-asset.ts`'s patch-target check from an archive to a set of tree paths and runs it in `fetchRepoCandidate`'s sizing step, recording a marker and a finding on the candidate; `repo-gate.ts` refuses a finding as `requires-build`, the release rescue extends to it, and `diffRepoState` backfills unmarked candidates.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), vitest, node `--experimental-strip-types` for the registry scripts, `yaml` 2.x (already a dependency).

**Spec:** [docs/design/2026-09-26-market-borrowings.md](../design/2026-09-26-market-borrowings.md) §8 (A2), §9 (A3), §10 (docs and order), committed as `439a3e8`. The authority spec ([2026-08-18-dsh-plugin-shop-design.md](../design/2026-08-18-dsh-plugin-shop-design.md)) already carries both amendments, marked "not yet built"; Task 10 flips them.

## Global Constraints

- Pure modules touch no clock, network, filesystem, environment or locale: `gate.ts`, `emit.ts`, `feed-state.ts`, `departures.ts` (new), `release-asset.ts`, `tree-size.ts`, `repo-gate.ts`, `repo-state.ts`. Network reads live in `npm-client.ts` and `github-client.ts` only.
- ESM everywhere; local imports carry the `.ts` extension.
- `strict` and `noUncheckedIndexedAccess` are on. Guard index access; never assert it away.
- Every ordering that reaches a file uses `compareStrings` (code-unit), never `localeCompare` or a bare `.sort()` on mixed data.
- Files end with exactly one trailing newline.
- One new rejection code only: `npm-gone`. A3 reuses `requires-build`.
- Hostile text is bounded before it is published or committed: a deprecation message at 200 characters (`DERIVED_SUMMARY_MAX_LENGTH`), each finding string at 200 (`UNBUILT_FIELD_MAX_LENGTH`), echoed into a detail at 80 (`ECHO_MAX`), all cut by `truncateWholeCharacters`. Every response body is read through `readJsonCapped` or `readCappedBody`.
- An empty `catch` names what it swallows and why nothing else can reach it.
- Never run `pnpm build:catalog` to check that a change compiles.
- Tests describe behavior, prefer fixtures to mocks, never mock the module under test, and fixture arithmetic must be true (recompute every count you assert).
- Commit after every green step; nothing is pushed, no PR is opened, nothing is published. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Design documents are English only; `docs/schema.md` and `docs/schema.zh.md` change together, each in its own register.

## Review Focus

1. **A `manifest.lock` line whose integrity holds several space-separated hashes, or whose name is scoped** — the reader must return the npm name and not throw (test in Task 2).
2. **A deprecation message carrying `|`, a newline or a double quote** — the published report keeps one row, and the gate's path and the departure path write the same sentence (tests in Task 1 and Task 5).
3. **`deprecated: " "`, npm's un-deprecate** — not deprecated, so a still-keyworded package is carried, never rowed (test in Task 3).
4. **A subpackage declaring `"patch": "./cordis.patch.yml"`** — its tree path is `<subdir>/cordis.patch.yml`, and the path in the finding is relative to the subpackage (test in Task 6).
5. **A tree that is truncated, past the byte cap, or answers 404** — no refusal, and the candidate is still marked so the backfill ends (tests in Task 6 and Task 9; a 404 and a body past the cap reach `fetchRepoCandidate` as the same `body: undefined`, so the 404 test pins both).

---

## Setup (before Task 1)

- [ ] **Step 1: Install dependencies in the worktree**

Run (from `.claude/worktrees/feat+borrowings-batch-2`): `CI=true pnpm install --frozen-lockfile`
Expected: exit 0.

- [ ] **Step 2: Record the baseline**

Run: `pnpm test` then `pnpm typecheck`
Expected: both exit 0. Write the passing file and test counts into your report; every later task compares against them.

---

### Task 1: The deprecation message, and one sentence for it

**Files:**
- Modify: `registry/scripts/src/types.ts` (`Candidate`, after `deprecated: boolean`)
- Modify: `registry/scripts/src/gate.ts` (new exports after `truncateWholeCharacters`; the `deprecated` branch at line 268)
- Modify: `registry/scripts/src/npm-client.ts` (`toCandidate`, the returned object; import from `./gate.ts`)
- Test: `registry/scripts/tests/gate.test.ts`, `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Produces: `deprecationMessageOf(deprecated: unknown): string | undefined` and `deprecatedDetail(message: string | undefined): string`, both exported from `gate.ts`; `Candidate.deprecationMessage?: string`.

- [ ] **Step 1: Write the failing gate tests**

Append to `registry/scripts/tests/gate.test.ts` (add `deprecatedDetail, deprecationMessageOf` to the existing import from `'../src/gate.ts'`):

```ts
describe('the deprecated row (design 2026-09-26-market-borrowings §8.2)', () => {
  it('quotes the author\'s message', () => {
    const result = gate(candidate({ deprecated: true, deprecationMessage: 'Renamed to dsh-new.' }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('deprecated')
      expect(result.rejection.detail).toBe('Marked deprecated on npm: "Renamed to dsh-new.".')
    }
  })

  it('keeps today\'s sentence when npm carries no message', () => {
    const result = gate(candidate({ deprecated: true }), config)
    expect(!result.ok && result.rejection.detail).toBe('Marked deprecated on npm.')
  })

  it('quotes a message holding a double quote as JSON, so the sentence stays one string', () => {
    expect(deprecatedDetail('Use "dsh-b" | not this')).toBe('Marked deprecated on npm: "Use \\"dsh-b\\" | not this".')
  })
})

describe('deprecationMessageOf', () => {
  it.each([[true], [''], ['   '], [42], [null], [undefined]])('reads %j as no message', (value) => {
    expect(deprecationMessageOf(value)).toBeUndefined()
  })

  it('trims the message and cuts it at 200 code units without splitting a surrogate pair', () => {
    // 199 ASCII characters, then an astral one whose HIGH half lands at
    // index 199: the cut at 200 keeps it alone, so it is dropped.
    const message = `${'x'.repeat(199)}\u{1F600}tail`
    const out = deprecationMessageOf(`  ${message}  `)
    expect(out).toBe('x'.repeat(199))
    expect(out).not.toMatch(LONE_SURROGATE)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/gate.test.ts`
Expected: FAIL — `deprecatedDetail` and `deprecationMessageOf` are not exported, and the first test still reads `Marked deprecated on npm.`

- [ ] **Step 3: Implement**

In `registry/scripts/src/types.ts`, inside `Candidate`, directly after `deprecated: boolean`:

```ts
  /**
   * The author's deprecation message, trimmed and bounded
   * (`deprecationMessageOf` in `gate.ts`); absent when the package is not
   * deprecated or npm carries no text for it. The `deprecated` row quotes it
   * (design 2026-09-26-market-borrowings §8.2).
   */
  deprecationMessage?: string
```

In `registry/scripts/src/gate.ts`, after `truncateWholeCharacters`:

```ts
/**
 * The author's deprecation message, bounded for the published report, or
 * undefined when npm carries none: a bare `true`, an empty or blank string, or
 * no string at all.
 *
 * The message is the author's own text and reaches `report.md` verbatim, so it
 * takes the bound a derived summary takes and is cut at a whole character
 * (design 2026-09-26-market-borrowings §8.2). Whether the package IS
 * deprecated is `isDeprecated`'s question (`feed-state.ts`); this reads only
 * what it says.
 * @param deprecated - the manifest's `deprecated` value, unvalidated.
 */
export function deprecationMessageOf(deprecated: unknown): string | undefined {
  if (typeof deprecated !== 'string') return undefined
  const message = deprecated.trim()
  return message === '' ? undefined : truncateWholeCharacters(message, DERIVED_SUMMARY_MAX_LENGTH)
}

/**
 * The one sentence a deprecated package's row carries, from the gate and from
 * the departure step alike, so one fact is never worded two ways (design
 * 2026-09-26-market-borrowings §8.2). The message is quoted as JSON: a quote
 * inside it cannot end the quotation early.
 * @param message - the bounded message, from {@link deprecationMessageOf}.
 */
export function deprecatedDetail(message: string | undefined): string {
  return message === undefined
    ? 'Marked deprecated on npm.'
    : `Marked deprecated on npm: ${JSON.stringify(message)}.`
}
```

Replace the `deprecated` branch (currently `if (candidate.deprecated) return reject(name, 'deprecated', 'Marked deprecated on npm.')`) with:

```ts
  if (candidate.deprecated) return reject(name, 'deprecated', deprecatedDetail(candidate.deprecationMessage))
```

In `registry/scripts/src/npm-client.ts`, add `import { deprecationMessageOf } from './gate.ts'`, and in `toCandidate`'s returned object directly after `deprecated: isDeprecated(manifest.deprecated),`:

```ts
    // Absent unless npm carries text for it: the row quotes the author, and a
    // bare `true` has nothing to quote (design 2026-09-26-market-borrowings §8.2).
    ...(() => {
      const message = deprecationMessageOf(manifest.deprecated)
      return message === undefined ? {} : { deprecationMessage: message }
    })(),
```

- [ ] **Step 4: Run the gate tests**

Run: `pnpm vitest run registry/scripts/tests/gate.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the projection tests**

Append to `registry/scripts/tests/npm-client.test.ts`:

```ts
describe('toCandidate reads the deprecation message', () => {
  const packumentWith = (deprecated: unknown): unknown => ({
    name: 'dsh-old',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name: 'dsh-old', version: '1.0.0', deprecated, dsh: { bundle: { patch: './cordis.patch.yml' } } } },
  })

  it('carries the bounded message beside the flag', () => {
    const candidate = toCandidate(packumentWith('  Renamed to dsh-new.  '))
    expect(candidate?.deprecated).toBe(true)
    expect(candidate?.deprecationMessage).toBe('Renamed to dsh-new.')
  })

  it('carries no message for a bare true, and nothing at all for npm\'s blank un-deprecate', () => {
    const bare = toCandidate(packumentWith(true))
    expect(bare?.deprecated).toBe(true)
    expect(bare && 'deprecationMessage' in bare).toBe(false)
    const blank = toCandidate(packumentWith('   '))
    expect(blank?.deprecated).toBe(false)
    expect(blank && 'deprecationMessage' in blank).toBe(false)
  })
})
```

- [ ] **Step 6: Run the npm-client tests and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts` then `pnpm typecheck`
Expected: PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/gate.ts registry/scripts/src/npm-client.ts registry/scripts/tests/gate.test.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(registry): quote the author's deprecation message in the deprecated row

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Read the last catalog's npm names back from `manifest.lock`

**Files:**
- Modify: `registry/scripts/src/emit.ts` (new export after `emit`)
- Test: `registry/scripts/tests/emit.test.ts`

**Interfaces:**
- Produces: `lockNpmNames(lock: string): string[]` — sorted by `compareStrings`, deduplicated.

- [ ] **Step 1: Write the failing tests**

Append to `registry/scripts/tests/emit.test.ts` (add `lockNpmNames` to the import from `'../src/emit.ts'`):

```ts
describe('lockNpmNames (design 2026-09-26-market-borrowings §8.2)', () => {
  it('reads back the npm names the lock writer wrote, and no github line', () => {
    const { manifestLock } = emit(
      [entry('dsh-b'), entry('@scope/dsh-a'), repoEntry('dsh-repo', 'owner/slug')],
      [], '2026-08-18T00:00:00.000Z',
    )
    expect(lockNpmNames(manifestLock)).toEqual(['@scope/dsh-a', 'dsh-b'])
  })

  it('reads an empty lock as no names', () => {
    expect(lockNpmNames('')).toEqual([])
  })

  it('reads a line whose integrity holds several space-separated hashes', () => {
    expect(lockNpmNames('dsh-a 1.0.0 sha512-x sha1-y\n')).toEqual(['dsh-a'])
  })

  it('throws on a line this module never wrote, rather than reading it as no catalog', () => {
    expect(() => lockNpmNames('dsh-a 1.0.0 sha512-x\ndsh-b 1.0.0\n')).toThrow(/manifest\.lock line 2/)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/emit.test.ts`
Expected: FAIL — `lockNpmNames` is not exported.

- [ ] **Step 3: Implement**

Append to `registry/scripts/src/emit.ts`:

```ts
/**
 * The npm names a committed `manifest.lock` lists, sorted, read back by the
 * module that writes it (`manifestLock` in {@link emit}). The last published
 * catalog is the baseline a departure is measured against (design
 * 2026-09-26-market-borrowings §8.2).
 *
 * A line is `name version integrity` for npm and `owner/slug name version` for
 * github, and the first field tells them apart: an npm name holds a `/` only
 * behind a leading `@`, and a repository never starts with one. Only three
 * fields are required, so an integrity that is itself several space-separated
 * hashes still reads. A line with fewer is not one this module wrote and
 * throws: a malformed registry file must not read as an empty catalog, which
 * would report every departure as nothing.
 * @param lock - the file's text.
 */
export function lockNpmNames(lock: string): string[] {
  const names = new Set<string>()
  for (const [index, line] of lock.split('\n').entries()) {
    if (line === '') continue
    const fields = line.split(' ')
    const [first] = fields
    if (fields.length < 3 || first === undefined || first === '') {
      throw new Error(`manifest.lock line ${index + 1} is not a lock line: ${JSON.stringify(line.slice(0, 80))}`)
    }
    if (first.startsWith('@') || !first.includes('/')) names.add(first)
  }
  return [...names].sort(compareStrings)
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run registry/scripts/tests/emit.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/emit.ts registry/scripts/tests/emit.test.ts
git commit -m "feat(registry): read the last catalog's npm names back from manifest.lock

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Classify a departed name

**Files:**
- Modify: `registry/scripts/src/feed-state.ts` (extract `isUnpublishStub` and `latestVersionOf` out of `classifyPackument`)
- Create: `registry/scripts/src/departures.ts`
- Test: `registry/scripts/tests/feed-state.test.ts` (existing `classifyPackument` tests must stay green unchanged), `registry/scripts/tests/departures.test.ts` (new)

**Interfaces:**
- Consumes: `deprecatedDetail`, `deprecationMessageOf` (Task 1); `isDeprecated`, `FEED_PACKAGE_NAME_MAX_LENGTH` (`feed-state.ts`); `DERIVED_SUMMARY_MAX_LENGTH`, `VERSION_MAX_LENGTH`, `truncateWholeCharacters` (`gate.ts`).
- Produces (from `departures.ts`):
  - `type DepartureAnswer = { kind: 'packument'; body: unknown } | { kind: 'missing' } | { kind: 'failed'; reason: string }`
  - `type DepartureOutcome = { kind: 'carried'; name } | { kind: 'deprecated'; name; message: string | undefined } | { kind: 'unpublished'; name; date: string | undefined } | { kind: 'removed'; name } | { kind: 'keyword-dropped'; name; version: string } | { kind: 'unanswered'; name; reason: string }`
  - `interface DepartureSummary { departed: number; carried: readonly string[]; deprecated: number; npmGone: number }`
  - `departedNames(listed: readonly string[], harvested: ReadonlySet<string>): string[]`
  - `classifyDeparture(name: string, answer: DepartureAnswer, harvestKeywords: readonly string[]): DepartureOutcome`
  - `departureRejection(outcome: Exclude<DepartureOutcome, { kind: 'carried' }>, harvestKeywords: readonly string[]): Rejection`
  - `summarizeDepartures(outcomes: readonly DepartureOutcome[]): DepartureSummary`
  - `DEPARTURES_HEADING` (string) and `describeDepartures(summary: DepartureSummary): string[]`
  - `parseDepartureSummary(raw: unknown, source: string): DepartureSummary`
- Produces (from `feed-state.ts`): `isUnpublishStub(packument: unknown): boolean`, `latestVersionOf(packument: object): { version: string; manifest: Record<string, unknown> } | null`.

- [ ] **Step 1: Extract the two feed helpers (refactor under the existing tests)**

In `registry/scripts/src/feed-state.ts`, add above `classifyPackument`:

```ts
/**
 * npm's unpublish stub: a 200 with no `dist-tags` and no `versions`, the
 * unpublish recorded as an object at `time.unpublished` (change-feed design
 * §4.6). Exactly that shape; any other versionless body is a failed read.
 * Shared with the departure classifier (design 2026-09-26-market-borrowings
 * §8.2) so the two cannot disagree on what "unpublished" looks like.
 * @param packument - a parsed body, unvalidated.
 */
export function isUnpublishStub(packument: unknown): boolean {
  if (packument === null || typeof packument !== 'object' || Array.isArray(packument)) return false
  const p = packument as { versions?: unknown; 'dist-tags'?: unknown; time?: unknown }
  const time = p.time
  const unpublished = time !== null && typeof time === 'object' && !Array.isArray(time)
    ? (time as { unpublished?: unknown }).unpublished
    : undefined
  return p.versions === undefined && p['dist-tags'] === undefined
    && unpublished !== null && typeof unpublished === 'object' && !Array.isArray(unpublished)
}

/**
 * The version `dist-tags.latest` names, with its manifest, or null when the
 * packument names no usable latest version. `Object.hasOwn`, so a `latest` of
 * `__proto__` finds no version rather than the prototype.
 * @param packument - a packument already known to be an object.
 */
export function latestVersionOf(packument: object): { version: string; manifest: Record<string, unknown> } | null {
  const p = packument as { 'dist-tags'?: unknown; versions?: unknown }
  const tags = p['dist-tags']
  const latest = tags !== null && typeof tags === 'object' ? (tags as { latest?: unknown }).latest : undefined
  const versions = p.versions
  if (typeof latest !== 'string' || versions === null || typeof versions !== 'object' || Array.isArray(versions)
    || !Object.hasOwn(versions, latest)) {
    return null
  }
  const manifest = (versions as Record<string, unknown>)[latest]
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return null
  return { version: latest, manifest: manifest as Record<string, unknown> }
}
```

Then rewrite the body of `classifyPackument` after its name check, keeping the comment block about the stub, so that it reads:

```ts
  if (isUnpublishStub(packument)) return { kind: 'gone', name }
  const latest = latestVersionOf(p)
  if (latest === null) return failed('the registry answered a packument with no latest version')
  const v = latest.manifest as { keywords?: unknown; deprecated?: unknown }
  return classifyManifest(name, { name, keywords: v.keywords, deprecated: v.deprecated, maintainers: p.maintainers }, harvestKeywords)
```

Run: `pnpm vitest run registry/scripts/tests/feed-state.test.ts`
Expected: PASS with no test edited — the refactor changes no behavior.

- [ ] **Step 2: Write the failing classifier tests**

Create `registry/scripts/tests/departures.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  classifyDeparture, departedNames, departureRejection, describeDepartures, parseDepartureSummary,
  summarizeDepartures, type DepartureOutcome,
} from '../src/departures.ts'

const KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

/** A packument whose latest version carries `latest` on top of a keyworded default. */
function packument(latest: Record<string, unknown> = {}, name = 'dsh-x'): unknown {
  return {
    name,
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { name, version: '2.0.0', keywords: ['dsh-plugin'], ...latest } },
  }
}

describe('departedNames', () => {
  it('keeps the listed names the harvest did not produce, sorted and deduplicated', () => {
    expect(departedNames(['dsh-b', 'dsh-a', 'dsh-c', 'dsh-a'], new Set(['dsh-c']))).toEqual(['dsh-a', 'dsh-b'])
  })

  it('departs nothing from an empty lock', () => {
    expect(departedNames([], new Set(['dsh-a']))).toEqual([])
  })
})

describe('classifyDeparture', () => {
  it('carries a package whose latest version still lists a harvest keyword, undeprecated', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument() }, KEYWORDS)).toEqual({ kind: 'carried', name: 'dsh-x' })
  })

  it('carries a package npm un-deprecated with a blank message, as isDeprecated reads it', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: '   ' }) }, KEYWORDS))
      .toEqual({ kind: 'carried', name: 'dsh-x' })
  })

  it('reads a deprecated latest version with its message, and a bare true without one', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: 'Renamed to dsh-y.' }) }, KEYWORDS))
      .toEqual({ kind: 'deprecated', name: 'dsh-x', message: 'Renamed to dsh-y.' })
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ deprecated: true }) }, KEYWORDS))
      .toEqual({ kind: 'deprecated', name: 'dsh-x', message: undefined })
  })

  it('reads npm\'s unpublish stub with its date, and without one when the time is malformed', () => {
    const stub = (at: unknown): unknown => ({ name: 'dsh-x', time: { unpublished: { time: at, versions: ['1.0.0'] } } })
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: stub('2026-09-30T08:00:00.000Z') }, KEYWORDS))
      .toEqual({ kind: 'unpublished', name: 'dsh-x', date: '2026-09-30' })
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: stub(42) }, KEYWORDS))
      .toEqual({ kind: 'unpublished', name: 'dsh-x', date: undefined })
  })

  it('reads a 404 as removed', () => {
    expect(classifyDeparture('dsh-x', { kind: 'missing' }, KEYWORDS)).toEqual({ kind: 'removed', name: 'dsh-x' })
  })

  it('reads a latest version with neither harvest keyword as keyword-dropped, naming the version', () => {
    expect(classifyDeparture('dsh-x', { kind: 'packument', body: packument({ keywords: ['tool'] }) }, KEYWORDS))
      .toEqual({ kind: 'keyword-dropped', name: 'dsh-x', version: '2.0.0' })
  })

  it.each([
    ['a transport failure', { kind: 'failed', reason: 'npm registry returned 503' }, 'npm registry returned 503'],
    ['another package\'s packument', { kind: 'packument', body: packument({}, 'dsh-y') }, 'the registry answered the packument of another package'],
    ['a body that is not a packument', { kind: 'packument', body: ['dsh-x'] }, 'the registry answered a body that is not a packument'],
    ['a packument with no latest version', { kind: 'packument', body: { name: 'dsh-x', 'dist-tags': {}, versions: {} } }, 'the registry answered a packument with no latest version'],
  ] as const)('reads %s as unanswered', (_what, answer, reason) => {
    expect(classifyDeparture('dsh-x', answer, KEYWORDS)).toEqual({ kind: 'unanswered', name: 'dsh-x', reason })
  })
})

describe('departureRejection', () => {
  it.each([
    [{ kind: 'deprecated', name: 'dsh-x', message: 'Renamed to dsh-y.' }, 'deprecated', 'Marked deprecated on npm: "Renamed to dsh-y.".'],
    [{ kind: 'unpublished', name: 'dsh-x', date: '2026-09-30' }, 'npm-gone', 'Unpublished from npm on 2026-09-30, so no version is left to install.'],
    [{ kind: 'unpublished', name: 'dsh-x', date: undefined }, 'npm-gone', 'Unpublished from npm, so no version is left to install.'],
    [{ kind: 'removed', name: 'dsh-x' }, 'npm-gone', 'npm no longer has a package of this name: the registry answers 404.'],
    [{ kind: 'keyword-dropped', name: 'dsh-x', version: '2.0.0' }, 'npm-gone', 'Its latest version, 2.0.0, no longer lists the dsh-plugin or deepseek-harness keyword, so the harvest does not select it. Add one back and the next build lists it again.'],
    [{ kind: 'unanswered', name: 'dsh-x', reason: 'npm registry returned 503' }, 'npm-gone', 'It left the keyword harvest, and npm did not answer when asked why: npm registry returned 503.'],
  ] as const)('words %o', (outcome, code, detail) => {
    expect(departureRejection(outcome, KEYWORDS)).toEqual({ name: 'dsh-x', code, detail })
  })
})

describe('summarizeDepartures, describeDepartures and parseDepartureSummary', () => {
  const outcomes: DepartureOutcome[] = [
    { kind: 'carried', name: 'dsh-b' },
    { kind: 'deprecated', name: 'dsh-c', message: undefined },
    { kind: 'removed', name: 'dsh-d' },
    { kind: 'carried', name: 'dsh-a' },
  ]

  it('counts each outcome and sorts the carried names', () => {
    // 4 departed = 2 carried + 1 deprecated + 1 npm-gone.
    expect(summarizeDepartures(outcomes)).toEqual({ departed: 4, carried: ['dsh-a', 'dsh-b'], deprecated: 1, npmGone: 1 })
  })

  it('writes the count line, and the carried names only when there are some', () => {
    expect(describeDepartures(summarizeDepartures(outcomes))).toEqual([
      'npm packages missing from the harvest since the last catalog: 4 (carried 2, deprecated 1, npm-gone 1)',
      'carried, still carrying a harvest keyword that neither npm search nor the change feed returned: dsh-a, dsh-b',
    ])
    expect(describeDepartures({ departed: 0, carried: [], deprecated: 0, npmGone: 0 })).toEqual([
      'npm packages missing from the harvest since the last catalog: 0 (carried 0, deprecated 0, npm-gone 0)',
    ])
  })

  it('round-trips a summary through the handoff parser', () => {
    const summary = summarizeDepartures(outcomes)
    expect(parseDepartureSummary(JSON.parse(JSON.stringify(summary)), 'test')).toEqual(summary)
  })

  it.each([
    ['counts that do not add up', { departed: 3, carried: ['dsh-a'], deprecated: 1, npmGone: 0 }],
    ['a negative count', { departed: 0, carried: [], deprecated: -1, npmGone: 1 }],
    ['a carried name that is not a string', { departed: 1, carried: [1], deprecated: 0, npmGone: 0 }],
    ['not an object', ['departed']],
  ])('refuses %s', (_what, raw) => {
    expect(() => parseDepartureSummary(raw, '--harvest-from x')).toThrow(/--harvest-from x: expected `departures`/)
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/departures.test.ts`
Expected: FAIL — `../src/departures.ts` does not exist.

- [ ] **Step 4: Implement `departures.ts`**

Create `registry/scripts/src/departures.ts`:

```ts
/**
 * A listed npm package the harvest no longer returns, and why (design
 * 2026-09-26-market-borrowings §8).
 *
 * npm search returns no deprecated package and its `total` counts none, so a
 * package deprecated after it was listed never reaches the gate's own
 * `deprecated` rule, and an unpublished, removed or un-keyworded one leaves the
 * same way. The harvest compares the last published catalog with what it
 * produced and asks npm once about each name it lost. Pure: an answer comes
 * in, an outcome goes out; `npm-client.ts` does the reading.
 * @module departures
 */
import { FEED_PACKAGE_NAME_MAX_LENGTH, isDeprecated, isUnpublishStub, latestVersionOf } from './feed-state.ts'
import { DERIVED_SUMMARY_MAX_LENGTH, VERSION_MAX_LENGTH, deprecatedDetail, deprecationMessageOf, truncateWholeCharacters } from './gate.ts'
import { compareStrings } from './identity.ts'
import type { Rejection } from './types.ts'

/** What reading one departed name's packument answered. */
export type DepartureAnswer =
  | { readonly kind: 'packument'; readonly body: unknown }
  /** The registry answered 404. */
  | { readonly kind: 'missing' }
  /** Anything that is not npm's answer about the package: a transport
   * failure, a deadline, another status, an unreadable or oversized body. */
  | { readonly kind: 'failed'; readonly reason: string }

/** Why one departed name left, or that it stays: §8.2's table. */
export type DepartureOutcome =
  | { readonly kind: 'carried'; readonly name: string }
  | { readonly kind: 'deprecated'; readonly name: string; readonly message: string | undefined }
  | { readonly kind: 'unpublished'; readonly name: string; readonly date: string | undefined }
  | { readonly kind: 'removed'; readonly name: string }
  | { readonly kind: 'keyword-dropped'; readonly name: string; readonly version: string }
  | { readonly kind: 'unanswered'; readonly name: string; readonly reason: string }

/** One run's departures, for the report and the harvest handoff. */
export interface DepartureSummary {
  /** Names listed in the last catalog and absent from this harvest. */
  readonly departed: number
  /** The carried ones, sorted. */
  readonly carried: readonly string[]
  readonly deprecated: number
  readonly npmGone: number
}

/** The heading of the report line; a guard test pins it. */
export const DEPARTURES_HEADING = 'npm packages missing from the harvest since the last catalog'

/**
 * The names the last catalog listed that this harvest did not produce, sorted
 * and deduplicated. A name the harvest produced stays the gate's to judge.
 * @param listed - the npm names of the last published catalog.
 * @param harvested - every name this run's harvest produced, candidates and
 *   `fetch-failed` rows alike.
 */
export function departedNames(listed: readonly string[], harvested: ReadonlySet<string>): string[] {
  return [...new Set(listed)].filter(name => !harvested.has(name)).sort(compareStrings)
}

/**
 * Why one departed name left, read off npm's answer.
 *
 * The membership rule is the change feed's (`classifyManifest`): the latest
 * version lists a harvest keyword by exact code-unit equality and is not
 * deprecated. A package that still passes it is carried; the gate judges it.
 * @param name - the departed name.
 * @param answer - what reading its packument answered.
 * @param harvestKeywords - `HARVEST_KEYWORDS`, passed in because this module is pure.
 */
export function classifyDeparture(name: string, answer: DepartureAnswer, harvestKeywords: readonly string[]): DepartureOutcome {
  if (answer.kind === 'missing') return { kind: 'removed', name }
  if (answer.kind === 'failed') return { kind: 'unanswered', name, reason: answer.reason }
  const body = answer.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'unanswered', name, reason: 'the registry answered a body that is not a packument' }
  }
  if ((body as { name?: unknown }).name !== name) {
    return { kind: 'unanswered', name, reason: 'the registry answered the packument of another package' }
  }
  if (isUnpublishStub(body)) return { kind: 'unpublished', name, date: unpublishDate(body) }
  const latest = latestVersionOf(body)
  if (latest === null) {
    return { kind: 'unanswered', name, reason: 'the registry answered a packument with no latest version' }
  }
  const { deprecated, keywords } = latest.manifest as { deprecated?: unknown; keywords?: unknown }
  if (isDeprecated(deprecated)) return { kind: 'deprecated', name, message: deprecationMessageOf(deprecated) }
  const declared: readonly unknown[] = Array.isArray(keywords) ? keywords : []
  if (!harvestKeywords.some(keyword => declared.includes(keyword))) {
    return { kind: 'keyword-dropped', name, version: truncateWholeCharacters(latest.version, VERSION_MAX_LENGTH) }
  }
  return { kind: 'carried', name }
}

/** The date part of `time.unpublished.time`, when that is a well-formed timestamp. */
function unpublishDate(stub: object): string | undefined {
  const time = (stub as { time?: unknown }).time
  const unpublished = time !== null && typeof time === 'object' ? (time as { unpublished?: unknown }).unpublished : undefined
  const at = unpublished !== null && typeof unpublished === 'object' ? (unpublished as { time?: unknown }).time : undefined
  return typeof at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(at) ? at.slice(0, 10) : undefined
}

/**
 * The row a departed name leaves with. `deprecated` uses the gate's own
 * sentence; every other cause is `npm-gone`, the npm half of `repo-gone`.
 * @param outcome - a classified departure that is not carried.
 * @param harvestKeywords - named in the keyword-dropped sentence.
 */
export function departureRejection(
  outcome: Exclude<DepartureOutcome, { kind: 'carried' }>,
  harvestKeywords: readonly string[],
): Rejection {
  const { name } = outcome
  switch (outcome.kind) {
    case 'deprecated':
      return { name, code: 'deprecated', detail: deprecatedDetail(outcome.message) }
    case 'unpublished':
      return {
        name,
        code: 'npm-gone',
        detail: outcome.date === undefined
          ? 'Unpublished from npm, so no version is left to install.'
          : `Unpublished from npm on ${outcome.date}, so no version is left to install.`,
      }
    case 'removed':
      return { name, code: 'npm-gone', detail: 'npm no longer has a package of this name: the registry answers 404.' }
    case 'keyword-dropped':
      return {
        name,
        code: 'npm-gone',
        detail: `Its latest version, ${outcome.version}, no longer lists the ${harvestKeywords.join(' or ')} keyword,`
          + ' so the harvest does not select it. Add one back and the next build lists it again.',
      }
    case 'unanswered':
      return {
        name,
        code: 'npm-gone',
        detail: `It left the keyword harvest, and npm did not answer when asked why: ${truncateWholeCharacters(outcome.reason, DERIVED_SUMMARY_MAX_LENGTH)}.`,
      }
  }
}

/** One run's outcomes, counted. */
export function summarizeDepartures(outcomes: readonly DepartureOutcome[]): DepartureSummary {
  const carried = outcomes.filter(outcome => outcome.kind === 'carried').map(outcome => outcome.name).sort(compareStrings)
  const deprecated = outcomes.filter(outcome => outcome.kind === 'deprecated').length
  return { departed: outcomes.length, carried, deprecated, npmGone: outcomes.length - carried.length - deprecated }
}

/**
 * The report's lines: the count, written whether or not it is zero so a reader
 * can see the step ran, then the carried names when there are any.
 */
export function describeDepartures(summary: DepartureSummary): string[] {
  const head = `${DEPARTURES_HEADING}: ${summary.departed} (carried ${summary.carried.length}, deprecated ${summary.deprecated}, npm-gone ${summary.npmGone})`
  return summary.carried.length === 0
    ? [head]
    : [head, `carried, still carrying a harvest keyword that neither npm search nor the change feed returned: ${summary.carried.join(', ')}`]
}

/**
 * Read the handoff's `departures` record. Its counts are interpolated into a
 * published report, so a shape this module never writes throws, the rule
 * `parseKeywordShortfall` applies to `shortfalls`.
 * @param raw - the record, unvalidated.
 * @param source - names the file in the error.
 */
export function parseDepartureSummary(raw: unknown, source: string): DepartureSummary {
  const fail = (): never => {
    throw new Error(`${source}: expected \`departures\` to be { departed, carried, deprecated, npmGone } with counts that add up`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail()
  const { departed, carried, deprecated, npmGone } = raw as Record<string, unknown>
  const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  if (!isCount(departed) || !isCount(deprecated) || !isCount(npmGone)) return fail()
  if (!Array.isArray(carried)
    || !carried.every(name => typeof name === 'string' && name !== '' && name.length <= FEED_PACKAGE_NAME_MAX_LENGTH)) {
    return fail()
  }
  if (departed !== carried.length + deprecated + npmGone) return fail()
  return { departed, carried: [...(carried as string[])].sort(compareStrings), deprecated, npmGone }
}
```

Add `| 'npm-gone'` to `RejectionCode` in `registry/scripts/src/types.ts`, directly after `| 'repo-gone'`.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/departures.test.ts registry/scripts/tests/feed-state.test.ts` then `pnpm typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add registry/scripts/src/feed-state.ts registry/scripts/src/departures.ts registry/scripts/src/types.ts registry/scripts/tests/departures.test.ts
git commit -m "feat(registry): classify a listed npm package the harvest lost, and word its row

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Read departed packuments and fold the outcome into the harvest

**Files:**
- Modify: `registry/scripts/src/npm-client.ts` (new exports after `fetchCandidates`; imports)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: `lockNpmNames` (Task 2); everything `departures.ts` exports (Task 3); `toCandidate`, `fetchWithFailover`, `readJsonCapped`, `MAX_PACKUMENT_BYTES`, `HARVEST_CONCURRENCY`, `HARVEST_KEYWORDS` (this module).
- Produces:
  - `readDeparture(name, fetchImpl?, sleep?, token?, backupRegistry?, timeoutMs?): Promise<DepartureAnswer>` — never throws.
  - `interface DepartureRun { candidates: Candidate[]; rejections: Rejection[]; summary: DepartureSummary }`
  - `accountForDepartures(lockText: string | null, harvest: { candidates: readonly Candidate[]; rejections: readonly Rejection[] }, options?: { fetchImpl?; sleep?; token?; backupRegistry?; timeoutMs?; harvestKeywords? }): Promise<DepartureRun>`

- [ ] **Step 1: Write the failing tests**

Append to `registry/scripts/tests/npm-client.test.ts` (add `accountForDepartures, readDeparture` to the import from `'../src/npm-client.ts'`, and `import type { Candidate } from '../src/types.ts'` if it is not already imported):

```ts
describe('readDeparture (design 2026-09-26-market-borrowings §8.2)', () => {
  const noSleep = async (_ms: number) => {}

  it('hands back the packument npm answered', async () => {
    const body = { name: 'dsh-x', 'dist-tags': { latest: '1.0.0' }, versions: {} }
    const fetchImpl = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
    expect(await readDeparture('dsh-x', fetchImpl, noSleep)).toEqual({ kind: 'packument', body })
  })

  it('reads a 404 as npm\'s answer, not a failure', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    expect(await readDeparture('dsh-x', fetchImpl, noSleep)).toEqual({ kind: 'missing' })
  })

  it('reads a 5xx with no backup as a failure naming the status', async () => {
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
    expect(await readDeparture('dsh-x', fetchImpl, noSleep)).toEqual({ kind: 'failed', reason: 'npm registry returned 503' })
  })

  it('reads a thrown transport error as a failure, and never throws', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    const answer = await readDeparture('dsh-x', fetchImpl, noSleep)
    expect(answer.kind).toBe('failed')
    expect(answer.kind === 'failed' && answer.reason).toContain('could not reach the npm registry')
  })
})

describe('accountForDepartures (design 2026-09-26-market-borrowings §8.2)', () => {
  const noSleep = async (_ms: number) => {}
  const harvested = (name: string): Candidate => ({
    name, version: '1.0.0', integrity: `sha512-${name}`, publishedAt: '2026-09-01T00:00:00.000Z',
    repository: `https://github.com/someone/${name}`, license: 'MIT', deprecated: false, hasBundle: true,
    catalog: null, description: 'x', keywords: ['dsh-plugin'], peers: [],
  })
  const carrier = (name: string): unknown => ({
    name,
    'dist-tags': { latest: '1.0.0' },
    time: { '1.0.0': '2026-09-01T00:00:00.000Z' },
    versions: {
      '1.0.0': {
        name, version: '1.0.0', keywords: ['dsh-plugin'], license: 'MIT', description: 'Still a plugin.',
        repository: { url: `git+https://github.com/someone/${name}.git` },
        dist: { integrity: `sha512-${name}` }, dsh: { bundle: { patch: './cordis.patch.yml' } },
      },
    },
  })
  /** Routes a packument URL by the encoded name it ends with. */
  const registry = (bodies: Record<string, { status: number; body: unknown }>): typeof fetch =>
    (async (url: string | URL) => {
      const name = decodeURIComponent(String(url).split('/').pop() ?? '')
      const answer = bodies[name]
      if (answer === undefined) throw new Error(`unrouted ${String(url)}`)
      return new Response(JSON.stringify(answer.body), { status: answer.status })
    }) as unknown as typeof fetch

  it('carries a still-keyworded package, rows the rest, and leaves harvested names alone', async () => {
    const lock = 'dsh-a 1.0.0 sha512-a\ndsh-gone 1.0.0 sha512-g\ndsh-kept 1.0.0 sha512-k\nowner/repo dsh-r abc\n'
    const run = await accountForDepartures(lock, { candidates: [harvested('dsh-a')], rejections: [] }, {
      sleep: noSleep,
      fetchImpl: registry({
        'dsh-gone': { status: 404, body: {} },
        'dsh-kept': { status: 200, body: carrier('dsh-kept') },
      }),
    })
    expect(run.candidates.map(c => c.name)).toEqual(['dsh-a', 'dsh-kept'])
    expect(run.rejections).toEqual([
      { name: 'dsh-gone', code: 'npm-gone', detail: 'npm no longer has a package of this name: the registry answers 404.' },
    ])
    expect(run.summary).toEqual({ departed: 2, carried: ['dsh-kept'], deprecated: 0, npmGone: 1 })
  })

  it('treats a name the harvest rowed as fetch-failed as harvested, not departed', async () => {
    const run = await accountForDepartures('dsh-a 1.0.0 sha512-a\n', {
      candidates: [], rejections: [{ name: 'dsh-a', code: 'fetch-failed', detail: 'x' }],
    }, { sleep: noSleep, fetchImpl: registry({}) })
    expect(run.summary).toEqual({ departed: 0, carried: [], deprecated: 0, npmGone: 0 })
  })

  it('departs nothing when there is no lock', async () => {
    const run = await accountForDepartures(null, { candidates: [harvested('dsh-a')], rejections: [] }, { sleep: noSleep, fetchImpl: registry({}) })
    expect(run.candidates.map(c => c.name)).toEqual(['dsh-a'])
    expect(run.summary.departed).toBe(0)
  })

  it('rows a departed name whose read failed, quoting the failure', async () => {
    const run = await accountForDepartures('dsh-down 1.0.0 sha512-d\n', { candidates: [], rejections: [] }, {
      sleep: noSleep, fetchImpl: registry({ 'dsh-down': { status: 503, body: {} } }),
    })
    expect(run.rejections).toEqual([{
      name: 'dsh-down', code: 'npm-gone',
      detail: 'It left the keyword harvest, and npm did not answer when asked why: npm registry returned 503.',
    }])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts -t "Departure"`
Expected: FAIL — `readDeparture` and `accountForDepartures` are not exported.

- [ ] **Step 3: Implement**

In `registry/scripts/src/npm-client.ts`, extend the imports:

```ts
import { escapeCell, lockNpmNames } from './emit.ts'
import { classifyDeparture, departedNames, departureRejection, summarizeDepartures, type DepartureAnswer, type DepartureOutcome, type DepartureSummary } from './departures.ts'
```

and append after `fetchCandidates`:

```ts
/**
 * Read one departed name's packument for the departure classifier (design
 * 2026-09-26-market-borrowings §8.2), through the same failover, deadline and
 * byte cap as {@link fetchCandidate}. Never throws: a 404 is npm's answer and
 * comes back as such, and anything else that is not a packument comes back as
 * a reason the published row can quote.
 */
export async function readDeparture(
  name: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
  token: string | undefined = undefined,
  backupRegistry: string | undefined = undefined,
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<DepartureAnswer> {
  let response: Response
  try {
    response = await fetchWithFailover(encodeURIComponent(name), fetchImpl, sleep, token, backupRegistry, timeoutMs)
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof FetchTimeoutError
        ? `the npm registry did not answer within ${timeoutMs}ms`
        : error instanceof PrimaryStatusError
          ? `npm registry returned ${error.status}`
          : `could not reach the npm registry (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  if (response.status === 404) return { kind: 'missing' }
  if (!response.ok) return { kind: 'failed', reason: `npm registry returned ${response.status}` }
  try {
    const read = await readJsonCapped(response, MAX_PACKUMENT_BYTES)
    if (!read.ok) {
      return {
        kind: 'failed',
        reason: read.reason === 'too-large'
          ? `the registry answered a packument larger than ${MAX_PACKUMENT_BYTES} bytes`
          : 'the response body was unreadable',
      }
    }
    return { kind: 'packument', body: read.value }
  } catch (error) {
    // A deadline landing mid-body arrives here, as in fetchCandidate; any
    // other throw is a body that did not parse.
    return {
      kind: 'failed',
      reason: error instanceof FetchTimeoutError
        ? `the npm registry did not answer within ${timeoutMs}ms`
        : 'the response body was unreadable',
    }
  }
}

/** What the departure step adds to a harvest (design 2026-09-26-market-borrowings §8.2). */
export interface DepartureRun {
  /** The harvest's candidates and the carried ones, sorted by name. */
  readonly candidates: Candidate[]
  /** The harvest's rejections, then one row per departure that is not carried. */
  readonly rejections: Rejection[]
  readonly summary: DepartureSummary
}

/**
 * Compare the last published catalog with this harvest and account for every
 * npm name it lost: carry the ones that still qualify, row the rest.
 *
 * Runs where the harvest runs, right after {@link fetchCandidates}: in
 * `classify.ts` on the daily workflow and in `build.ts` when it harvests
 * itself, so the classifier sees a carried package as live and keeps its
 * `categories.yml` row. A carried candidate is counted in no keyword's
 * coverage, so carrying can neither hide a harvest that stopped working nor
 * cancel a genuinely missing name.
 * @param lockText - the committed `registry/snapshots/manifest.lock`, or null
 *   when there is none (the first build), which departs nothing.
 * @param harvest - what `fetchCandidates` produced.
 */
export async function accountForDepartures(
  lockText: string | null,
  harvest: { readonly candidates: readonly Candidate[]; readonly rejections: readonly Rejection[] },
  options: {
    readonly fetchImpl?: typeof fetch
    readonly sleep?: (ms: number) => Promise<void>
    readonly token?: string
    readonly backupRegistry?: string
    readonly timeoutMs?: number
    readonly harvestKeywords?: readonly string[]
  } = {},
): Promise<DepartureRun> {
  const keywords = options.harvestKeywords ?? HARVEST_KEYWORDS
  const listed = lockText === null ? [] : lockNpmNames(lockText)
  const harvested = new Set([...harvest.candidates.map(candidate => candidate.name), ...harvest.rejections.map(rejection => rejection.name)])
  const names = departedNames(listed, harvested)
  // The pool fetchCandidates uses, for the reason its comment gives: one
  // stalled packument costs one slot, and answers land at the claimed index.
  const answers: (DepartureAnswer | undefined)[] = names.map(() => undefined)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next
      next += 1
      if (index >= names.length) return
      const name = names[index]
      if (name === undefined) continue
      answers[index] = await readDeparture(
        name, options.fetchImpl ?? fetch, options.sleep ?? defaultSleep, options.token, options.backupRegistry,
        options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(HARVEST_CONCURRENCY, names.length) }, () => worker()))
  const carried: Candidate[] = []
  const rows: Rejection[] = []
  const outcomes: DepartureOutcome[] = []
  names.forEach((name, index) => {
    const answer = answers[index]
    if (answer === undefined) return
    let outcome = classifyDeparture(name, answer, keywords)
    if (outcome.kind === 'carried') {
      // 'carried' is answered only for a packument naming this package with
      // an object at its latest version, which is every precondition of
      // toCandidate, so the projection cannot be null here and its name is
      // the packument's. The fallback row exists for the type, not for a
      // case; no test can reach it, and none pretends to.
      const candidate = answer.kind === 'packument' ? toCandidate(answer.body) : null
      if (candidate !== null) carried.push(candidate)
      else outcome = { kind: 'unanswered', name, reason: 'the registry answered a packument with no usable latest version' }
    }
    if (outcome.kind !== 'carried') rows.push(departureRejection(outcome, keywords))
    outcomes.push(outcome)
  })
  return {
    candidates: [...harvest.candidates, ...carried].sort((a, b) => compareStrings(a.name, b.name)),
    rejections: [...harvest.rejections, ...rows],
    summary: summarizeDepartures(outcomes),
  }
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts` then `pnpm typecheck`
Expected: PASS, exit 0. The body-read guard in `github-client.test.ts` scans `npm-client.ts`; run it too: `pnpm vitest run registry/scripts/tests/github-client.test.ts -t "structural guard"` — expected PASS, because every new read goes through `readJsonCapped`.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
git commit -m "feat(registry): read each departed npm name once, carry what still qualifies

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire departures through `classify.ts`, the handoff and the report

**Files:**
- Modify: `registry/scripts/src/classify.ts` (after `fetchCandidates`; the handoff write)
- Modify: `registry/scripts/src/build.ts` (the fresh harvest branch, the `--harvest-from` branch, the report write)
- Modify: `registry/scripts/tests/repo-guards.test.ts` (the handoff guard's expected string)
- Test: `registry/scripts/tests/publisher-handoff.test.ts` (new `describe` running both entry points for real)

**Interfaces:**
- Consumes: `accountForDepartures` (Task 4); `describeDepartures`, `parseDepartureSummary`, `DEPARTURES_HEADING`, `DepartureSummary` (Task 3).
- Produces: `dist/harvest.json` gains `departures: DepartureSummary`; `report.md` gains the departures block.

- [ ] **Step 1: Write the failing end-to-end tests**

In `registry/scripts/tests/publisher-handoff.test.ts`, append a new block. It uses the file's own `newWorkspace`, `runEntry`, `searchPage` and `packument` helpers; they live here because this file is the one that runs `classify.ts` and `build.ts` as CI does.

```ts
describe('a listed npm package the harvest lost (design 2026-09-26-market-borrowings §8)', () => {
  /** A packument the gate lists: bundle, license, repository, integrity, publish time, description. */
  function listable(name: string): unknown {
    return {
      name,
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': '2026-09-01T00:00:00.000Z' },
      maintainers: [{ name: 'bob' }],
      versions: {
        '1.0.0': {
          name, version: '1.0.0', keywords: ['dsh-plugin'], license: 'MIT', description: 'A plugin the search stopped returning.',
          repository: { type: 'git', url: `git+https://github.com/bob/${name}.git` },
          dist: { integrity: `sha512-${name}` }, dsh: { bundle: { patch: './cordis.patch.yml' } },
        },
      },
    }
  }
  const MESSAGE = 'Renamed to dsh-new | see the README'
  const DEPRECATED_DETAIL = `Marked deprecated on npm: ${JSON.stringify(MESSAGE)}.`

  it('classify.ts rows a deprecated departure and carries a qualifying one, keeping its category row', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'registry', 'snapshots'), { recursive: true })
      writeFileSync(join(cwd, 'registry', 'snapshots', 'manifest.lock'),
        'dsh-a 1.0.0 sha512-a\ndsh-gone 1.0.0 sha512-g\ndsh-kept 1.0.0 sha512-k\n')
      writeFileSync(join(cwd, 'registry', 'categories.yml'), '- name: "dsh-kept"\n  category: tool\n')
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'size=1', body: { total: 1, objects: [] } },
        { contains: '/-/v1/search', body: searchPage(1, ['dsh-a'], ['bob']) },
        { contains: '/dsh-gone', body: { name: 'dsh-gone', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'dsh-gone', version: '1.0.0', keywords: ['dsh-plugin'], deprecated: MESSAGE } } } },
        { contains: '/dsh-kept', body: listable('dsh-kept') },
        { contains: '/dsh-a', body: packument('dsh-a') },
      ])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'harvest.json'), 'utf8')) as {
        candidates: { name: string }[]; rejections: unknown[]; departures?: unknown
      }
      // 2 departed = 1 carried (dsh-kept) + 1 deprecated (dsh-gone).
      expect(handoff.departures).toEqual({ departed: 2, carried: ['dsh-kept'], deprecated: 1, npmGone: 0 })
      expect(handoff.rejections).toContainEqual({ name: 'dsh-gone', code: 'deprecated', detail: DEPRECATED_DETAIL })
      expect(handoff.candidates.map(c => c.name)).toContain('dsh-kept')
      // The classifier prunes every categories.yml row its live names do not
      // hold; a carried package must keep its own.
      expect(readFileSync(join(cwd, 'registry', 'categories.yml'), 'utf8')).toContain('"dsh-kept"')
      expect(run.stderr).toContain('npm packages missing from the harvest since the last catalog: 2 (carried 1, deprecated 1, npm-gone 0)')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts --harvest-from publishes the departures line, and the message cannot break its row', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [{ name: 'dsh-gone', code: 'deprecated', detail: DEPRECATED_DETAIL }],
        shortfalls: [], publishers: [],
        departures: { departed: 1, carried: [], deprecated: 1, npmGone: 0 },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const report = readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')
      expect(report).toContain('npm packages missing from the harvest since the last catalog: 1 (carried 0, deprecated 1, npm-gone 0)')
      expect(report).toContain('| dsh-gone | deprecated | Marked deprecated on npm: "Renamed to dsh-new \\| see the README". |')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts refuses a handoff whose departures do not add up', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
        departures: { departed: 2, carried: [], deprecated: 1, npmGone: 0 },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('expected `departures`')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
```

The rule pair `size=1` / `/-/v1/search` answers both harvest keywords alike, as the file's existing classifier test relies on; the change feed's requests match no rule, so the feed reports itself unavailable and credits nothing.

Append to `registry/scripts/tests/pipeline.test.ts` (it already has `candidates`, `config`, `BUILT_AT` and the `Rejection` type):

```ts
it('sorts departure rows with every other rejection, whatever order they arrive in (design 2026-09-26-market-borrowings §8.4)', () => {
  const rows: Rejection[] = [
    { name: 'dsh-z', code: 'npm-gone', detail: 'npm no longer has a package of this name: the registry answers 404.' },
    { name: 'dsh-y', code: 'deprecated', detail: 'Marked deprecated on npm.' },
  ]
  const forward = runPipeline(candidates, [], config, BUILT_AT, rows)
  const reversed = runPipeline(candidates, [], config, BUILT_AT, [...rows].reverse())
  expect(forward.report).toBe(reversed.report)
  expect(forward.report).toContain('| dsh-z | npm-gone | npm no longer has a package of this name: the registry answers 404. |')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/publisher-handoff.test.ts -t "harvest lost"` and `pnpm vitest run registry/scripts/tests/pipeline.test.ts -t "departure rows"`
Expected: the handoff tests FAIL — the handoff has no `departures`, and the report has no departures line. The pipeline test PASSES already: `npm-gone` rows are ordinary rejections, which `emit` sorts by name, code and detail. It is added to pin that property for the new code, not to drive an implementation.

- [ ] **Step 3: Wire `classify.ts`**

Replace `const { candidates, rejections } = await fetchCandidates(names, fetch, npmToken, npmBackupRegistry)` with:

```ts
  const fetched = await fetchCandidates(names, fetch, npmToken, npmBackupRegistry)
  // Design 2026-09-26-market-borrowings §8.2: account for every name the last
  // published catalog listed and this harvest lost. HERE, not only in
  // build.ts: the live names below decide which categories.yml rows survive,
  // and a carried package must be one of them.
  const lockPath = join(REGISTRY_DIR, 'snapshots', 'manifest.lock')
  const departureRun = await accountForDepartures(
    existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null,
    fetched,
    { token: npmToken, backupRegistry: npmBackupRegistry },
  )
  for (const line of describeDepartures(departureRun.summary)) process.stderr.write(`classify: ${line}\n`)
  const { candidates, rejections } = departureRun
```

Change the handoff write to:

```ts
  writeFileSync(join(DIST_DIR, 'harvest.json'),
    `${JSON.stringify({ candidates, rejections, shortfalls, publishers, publisherAxis: axis, feed: { state: serializeFeedState(feedNext), report: feedRun.report, coverage: feedCoverage }, departures: departureRun.summary })}\n`)
```

Add `accountForDepartures` to the `npm-client.ts` import and `import { describeDepartures } from './departures.ts'`.

- [ ] **Step 4: Wire `build.ts`**

Add the imports `accountForDepartures` (from `./npm-client.ts`) and `import { describeDepartures, parseDepartureSummary, type DepartureSummary } from './departures.ts'`. Declare beside `npmParts`:

```ts
  /** The departure step's counts (design 2026-09-26-market-borrowings §8.2),
   * from this build's own harvest or the classifier's handoff. Undefined only
   * for a handoff written before the field existed. */
  let departureSummary: DepartureSummary | undefined
```

In the fresh-harvest branch, replace the three lines from `const harvested = await fetchCandidates(...)` with:

```ts
    const harvested = await fetchCandidates(names, fetch, npmToken, npmBackupRegistry)
    const lockPath = join(REGISTRY_DIR, 'snapshots/manifest.lock')
    const departureRun = await accountForDepartures(
      existsSync(lockPath) ? readFileSync(lockPath, 'utf8') : null,
      harvested,
      { token: npmToken, backupRegistry: npmBackupRegistry },
    )
    candidates = departureRun.candidates
    rejections = departureRun.rejections
    departureSummary = departureRun.summary
```

In the `--harvest-from` branch, add `departures?: unknown` to the `parsed` type and, after `rejections = parsed.rejections as Rejection[]`:

```ts
    // Optional as a whole, like `shortfalls`: a handoff from before the field
    // existed must still build. A record present is validated, because its
    // counts reach the published report.
    if (parsed.departures !== undefined) {
      departureSummary = parseDepartureSummary(parsed.departures, `--harvest-from ${harvestFrom}`)
    }
```

Before the `report.md` write, and include `departureLine` in it right after `npmLine`:

```ts
  const departureParts = departureSummary === undefined ? [] : describeDepartures(departureSummary)
  for (const part of departureParts) process.stderr.write(`npm: ${part}\n`)
  const [departureHead, ...departureRest] = departureParts
  const departureLine = departureHead === undefined ? '' : `\n${departureHead}\n${departureRest.map(part => `- ${part}\n`).join('')}`
  writeFileSync(join(OUT_DIR, 'report.md'), `${artifacts.report}\nStars: ${starsNote}\n${npmLine}${departureLine}${axisLine}${feedLine}${repoLine}`)
```

- [ ] **Step 5: Update the handoff guard, and say why**

In `registry/scripts/tests/repo-guards.test.ts`, inside `'carries a tolerated search shortfall across the harvest handoff'`: replace the expected `JSON.stringify(...)` string with the one Step 3 writes, and add, with a comment that the departures record rides the handoff for the reason `shortfalls` does:

```ts
    expect(read('registry/scripts/src/build.ts')).toContain('parsed.departures')
    expect(read('registry/scripts/src/build.ts')).toContain('describeDepartures(departureSummary)')
    expect(read('registry/scripts/src/departures.ts'))
      .toContain("export const DEPARTURES_HEADING = 'npm packages missing from the harvest since the last catalog'")
```

The edit is the contract moving, not an assertion bent to a run: the handoff gained a field both ends must agree on.

- [ ] **Step 6: Run the tests and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/publisher-handoff.test.ts registry/scripts/tests/repo-guards.test.ts registry/scripts/tests/strip-types.test.ts` then `pnpm typecheck`
Expected: PASS, exit 0.

- [ ] **Step 7: Commit**

```bash
git add registry/scripts/src/classify.ts registry/scripts/src/build.ts registry/scripts/tests/publisher-handoff.test.ts registry/scripts/tests/repo-guards.test.ts registry/scripts/tests/pipeline.test.ts
git commit -m "feat(registry): account for npm departures where the harvest runs, and report them

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The patch-target check over a set of paths

**Files:**
- Modify: `registry/scripts/src/types.ts` (new `UnbuiltFinding` type)
- Modify: `registry/scripts/src/release-asset.ts` (exports; `under`; `archiveCandidates` and `missingInsertTarget` for a `''` root; new `treePathOf`, `declaredPatchFiles`, `unbuiltFinding`)
- Modify: `registry/scripts/src/tree-size.ts` (new `treeBlobPaths`)
- Test: `registry/scripts/tests/release-asset.test.ts`, `registry/scripts/tests/tree-size.test.ts`

**Interfaces:**
- Produces (types.ts): `type UnbuiltFinding = { patch: string } | { insert: string; path: string }`.
- Produces (release-asset.ts): `UNBUILT_FIELD_MAX_LENGTH = 200`, `MAX_PATCH_BYTES` (now exported), `echo(value: unknown): string` (now exported), `treePathOf(root: string, file: string): string | null`, `declaredPatchFiles(manifest: unknown): string[] | null`, `unbuiltFinding(manifest: unknown, bundleName: string, root: string, present: ReadonlySet<string>, patchTexts: ReadonlyMap<string, string>): UnbuiltFinding | null`.
- Produces (tree-size.ts): `treeBlobPaths(body: unknown): ReadonlySet<string> | null`.

- [ ] **Step 1: Write the failing tests**

Append to `registry/scripts/tests/release-asset.test.ts` (extend the import with `declaredPatchFiles, treePathOf, unbuiltFinding, UNBUILT_FIELD_MAX_LENGTH`):

```ts
describe('unbuiltFinding: the patch-target rule against a git tree (design 2026-09-26-market-borrowings §9.2)', () => {
  const manifest = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'dsh-whale', exports: { '.': './lib/index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } }, ...extra,
  })
  const patch = "- insert:\n    - id: whale\n      name: 'dsh-whale'\n"
  const texts = (text = patch): ReadonlyMap<string, string> => new Map([['./cordis.patch.yml', text]])

  it('finds nothing when the tree holds the patch and the module it inserts', () => {
    expect(unbuiltFinding(manifest(), 'dsh-whale', '', new Set(['package.json', 'cordis.patch.yml', 'lib/index.js']), texts())).toBeNull()
  })

  it('names the inserted module a gitignored lib/ leaves unresolvable', () => {
    expect(unbuiltFinding(manifest(), 'dsh-whale', '', new Set(['package.json', 'cordis.patch.yml', 'src/index.ts']), texts()))
      .toEqual({ insert: 'dsh-whale', path: 'lib/index.js' })
  })

  it('names a declared patch file the tree does not hold, without its text', () => {
    expect(unbuiltFinding(manifest(), 'dsh-whale', '', new Set(['package.json']), new Map()))
      .toEqual({ patch: './cordis.patch.yml' })
  })

  it('reads a subpackage under its own directory and reports the path relative to it', () => {
    const present = new Set(['packages/whale/package.json', 'packages/whale/cordis.patch.yml'])
    expect(unbuiltFinding(manifest(), 'dsh-whale', 'packages/whale', present, texts()))
      .toEqual({ insert: 'dsh-whale', path: 'lib/index.js' })
  })

  it('counts every arm of a conditions object, so one shipped arm is enough', () => {
    const conditions = manifest({ exports: { '.': { node: './dist/node.js', default: './dist/browser.js' } } })
    expect(unbuiltFinding(conditions, 'dsh-whale', '', new Set(['cordis.patch.yml', 'dist/node.js']), texts())).toBeNull()
  })

  it('takes main\'s directory-index lookup', () => {
    const legacy = manifest({ exports: undefined, main: './dist' })
    expect(unbuiltFinding(legacy, 'dsh-whale', '', new Set(['cordis.patch.yml', 'dist/index.js']), texts())).toBeNull()
  })

  it('forms no verdict on an export target it cannot decode or a wildcard', () => {
    expect(unbuiltFinding(manifest({ exports: { '.': './lib/%zz.js' } }), 'dsh-whale', '', new Set(['cordis.patch.yml']), texts())).toBeNull()
    expect(unbuiltFinding(manifest({ exports: { '.': './lib/*.js' } }), 'dsh-whale', '', new Set(['cordis.patch.yml']), texts())).toBeNull()
  })

  it('never refuses a module of another package, a list it cannot read, or a patch it was not given', () => {
    const otherPatch = "- insert:\n    - id: x\n      name: 'dsh-other'\n"
    expect(unbuiltFinding(manifest(), 'dsh-whale', '', new Set(['cordis.patch.yml']), texts(otherPatch))).toBeNull()
    expect(unbuiltFinding(manifest(), 'dsh-whale', '', new Set(['cordis.patch.yml']), new Map())).toBeNull()
    expect(unbuiltFinding(manifest({ dsh: { bundle: { patch: true } } }), 'dsh-whale', '', new Set(), new Map())).toBeNull()
    expect(unbuiltFinding(manifest({ dsh: { bundle: {} } }), 'dsh-whale', '', new Set(), new Map())).toBeNull()
  })

  it('checks every file of a list-valued patch', () => {
    const listed = manifest({ dsh: { bundle: { patch: ['./a.yml', './b.yml'] } } })
    expect(unbuiltFinding(listed, 'dsh-whale', '', new Set(['a.yml', 'lib/index.js']), new Map([['./a.yml', patch]])))
      .toEqual({ patch: './b.yml' })
  })

  it('bounds what it records at a whole character', () => {
    const long = `./${'p'.repeat(250)}.yml`
    const found = unbuiltFinding(manifest({ dsh: { bundle: { patch: long } } }), 'dsh-whale', '', new Set(), new Map())
    expect(found).toEqual({ patch: long.slice(0, UNBUILT_FIELD_MAX_LENGTH) })
  })
})

describe('treePathOf', () => {
  it.each([
    ['', './cordis.patch.yml', 'cordis.patch.yml'],
    ['packages/whale', './cordis.patch.yml', 'packages/whale/cordis.patch.yml'],
    ['', 'config/patch.yml', 'config/patch.yml'],
  ])('joins %j and %j', (root, file, expected) => {
    expect(treePathOf(root, file)).toBe(expected)
  })

  it.each([[''], ['./'], ['/abs.yml'], ['a/../b.yml'], ['a/./b.yml'], ['a\\b.yml'], ['a//b.yml']])(
    'cannot ask a tree about %j', (file) => {
      expect(treePathOf('', file)).toBeNull()
    })
})

describe('declaredPatchFiles', () => {
  it.each([
    [{ dsh: { bundle: { patch: './x.yml' } } }, ['./x.yml']],
    [{ dsh: { bundle: { patch: ['./a.yml', './b.yml'] } } }, ['./a.yml', './b.yml']],
    [{ dsh: { bundle: {} } }, []],
    [{ dsh: { bundle: { patch: 7 } } }, null],
    [{ dsh: { bundle: true } }, null],
    [{}, null],
    [null, null],
  ])('reads %j as %j', (manifest, expected) => {
    expect(declaredPatchFiles(manifest)).toEqual(expected)
  })
})
```

Append to `registry/scripts/tests/tree-size.test.ts` (extend the import with `treeBlobPaths`):

```ts
describe('treeBlobPaths', () => {
  it('lists every blob and nothing else', () => {
    expect(treeBlobPaths(tree([{ path: 'a.js', size: 1 }, { path: 'src', type: 'tree' }, { path: 'vendor', type: 'commit' }])))
      .toEqual(new Set(['a.js']))
  })

  it.each([
    ['a truncated tree', tree([{ path: 'a.js', size: 1 }], true)],
    ['a tree that is not a list', { truncated: false, tree: {} }],
    ['an element it cannot read', { truncated: false, tree: [null] }],
    ['a blob without a path', { truncated: false, tree: [{ type: 'blob', size: 1 }] }],
    ['no body at all', undefined],
  ])('cannot vouch for an absence in %s', (_what, body) => {
    expect(treeBlobPaths(body)).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/release-asset.test.ts registry/scripts/tests/tree-size.test.ts`
Expected: FAIL — the new names are not exported.

- [ ] **Step 3: Implement**

In `registry/scripts/src/types.ts`, before `RepoCandidate`:

```ts
/**
 * What a commit-pinned candidate's git tree lacks that its bundle declares
 * (design 2026-09-26-market-borrowings §9.2), each string bounded at
 * `UNBUILT_FIELD_MAX_LENGTH`.
 */
export type UnbuiltFinding =
  /** A declared `dsh.bundle.patch` file, as declared. */
  | { patch: string }
  /** A module the patch inserts from the package itself, and the path its
   * manifest resolves it to, relative to the package. */
  | { insert: string; path: string }
```

In `registry/scripts/src/release-asset.ts`:
- add `import { truncateWholeCharacters } from './gate.ts'` and `import type { UnbuiltFinding } from './types.ts'`;
- change `const MAX_PATCH_BYTES` to `export const MAX_PATCH_BYTES` and `function echo` to `export function echo`;
- add, above `archiveCandidates`:

```ts
/** A member path under `root`: an archive's single top-level directory, a
 * subpackage directory in a git tree, or `''` for a tree's repository root. */
function under(root: string, relative: string): string {
  return root === '' ? relative : `${root}/${relative}`
}
```

- in `archiveCandidates`, replace `candidates.push(normalize(\`${root}/${relative}${suffix}\`))` with `candidates.push(normalize(under(root, \`${relative}${suffix}\`)))`;
- in `missingInsertTarget`, replace `return { name, path: first.slice(root.length + 1) }` with `return { name, path: root === '' ? first : first.slice(root.length + 1) }`;
- append:

```ts
/** How long a recorded finding's strings may be: they reach the committed
 * `repo-state.json` and the published detail (design §9.4). */
export const UNBUILT_FIELD_MAX_LENGTH = 200

/**
 * The tree path of a file a manifest declares relative to its package, or
 * null when the declaration is not a path a git tree can be asked about:
 * empty, absolute, holding a backslash, or carrying an empty, `.` or `..`
 * segment after the leading `./`. Null forms no verdict; the rule refuses only
 * what it can prove is absent (design 2026-09-26-market-borrowings §9.2).
 */
export function treePathOf(root: string, file: string): string | null {
  const relative = file.replace(/^\.\//, '')
  if (relative === '' || relative.startsWith('/') || relative.includes('\\')) return null
  if (relative.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return under(root, relative)
}

/**
 * The patch files a manifest's `dsh.bundle` declares, or null when it declares
 * no loadable bundle: no `dsh.bundle` object, or a `patch` that is neither a
 * string nor a list of strings. A bundle object without `patch` declares none.
 * @param manifest - a parsed package.json, unvalidated.
 */
export function declaredPatchFiles(manifest: unknown): string[] | null {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null
  const dsh = (manifest as { dsh?: unknown }).dsh
  const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as { bundle?: unknown }).bundle : undefined
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) return null
  const patch = (bundle as { patch?: unknown }).patch
  return patch === undefined ? [] : patchFilesOf(patch)
}

/**
 * What a commit-pinned candidate's git tree lacks that its bundle declares,
 * or null when nothing is proven missing (design 2026-09-26-market-borrowings
 * §9.2). This module's claim (3) against a set of paths: every declared patch
 * file is in `present`, and every module a patch inserts from the package
 * itself resolves, by {@link missingInsertTarget}'s rules, to a path in it.
 * @param manifest - the manifest the candidate was projected from.
 * @param bundleName - the candidate's name.
 * @param root - the candidate's `subdir`, or `''` for a repository root.
 * @param present - the tree's blob paths ({@link treeBlobPaths}).
 * @param patchTexts - each declared patch file's text, keyed as declared; a
 *   file missing here (past `MAX_PATCH_BYTES`) forms no verdict on its inserts.
 */
export function unbuiltFinding(
  manifest: unknown,
  bundleName: string,
  root: string,
  present: ReadonlySet<string>,
  patchTexts: ReadonlyMap<string, string>,
): UnbuiltFinding | null {
  const files = declaredPatchFiles(manifest)
  if (files === null) return null
  const declared = manifest as { name?: unknown; exports?: unknown; main?: unknown }
  for (const file of files) {
    const path = treePathOf(root, file)
    if (path === null) continue
    if (!present.has(path)) return { patch: truncateWholeCharacters(file, UNBUILT_FIELD_MAX_LENGTH) }
    const text = patchTexts.get(file)
    if (text === undefined) continue
    const missing = missingInsertTarget(text, declared, bundleName, root, present)
    if (missing !== null) {
      return {
        insert: truncateWholeCharacters(missing.name, UNBUILT_FIELD_MAX_LENGTH),
        path: truncateWholeCharacters(missing.path, UNBUILT_FIELD_MAX_LENGTH),
      }
    }
  }
  return null
}
```

Append to `registry/scripts/src/tree-size.ts`:

```ts
/**
 * The blob paths of a git tree response, or null when the tree cannot vouch
 * for an absence: truncated, not a list, or holding an element this cannot
 * read. Feeds the patch-target check (design 2026-09-26-market-borrowings
 * §9.2), which refuses only what it can prove missing: an unread element may
 * be the very file it would call absent.
 * @param body - the parsed tree response, untrusted.
 */
export function treeBlobPaths(body: unknown): ReadonlySet<string> | null {
  if (body === null || typeof body !== 'object') return null
  const { tree, truncated } = body as { tree?: unknown; truncated?: unknown }
  if (truncated !== undefined && truncated !== false) return null
  if (!Array.isArray(tree)) return null
  const paths = new Set<string>()
  for (const element of tree as unknown[]) {
    if (element === null || typeof element !== 'object') return null
    const { path, type } = element as { path?: unknown; type?: unknown }
    if (type !== 'blob') continue
    if (typeof path !== 'string') return null
    paths.add(path)
  }
  return paths
}
```

- [ ] **Step 4: Run the tests and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/release-asset.test.ts registry/scripts/tests/tree-size.test.ts` then `pnpm typecheck`
Expected: PASS, exit 0, and every existing release-asset test passes unedited: `under` changes nothing for a non-empty root.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/release-asset.ts registry/scripts/src/tree-size.ts registry/scripts/tests/release-asset.test.ts registry/scripts/tests/tree-size.test.ts
git commit -m "feat(registry): check a bundle's patch targets against a git tree's paths

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Record the check, and backfill it

**Files:**
- Modify: `registry/scripts/src/types.ts` (`RepoCandidate`: `entriesChecked`, `unbuilt`)
- Modify: `registry/scripts/src/repo-state.ts` (`checkCarriedEntryCheck` in `parseRepoState`'s chain; `lacksEntryCheck` in `diffRepoState`)
- Test: `registry/scripts/tests/repo-state.test.ts`

**Interfaces:**
- Consumes: `UnbuiltFinding` (Task 6), `UNBUILT_FIELD_MAX_LENGTH` (Task 6), `canEverList` (`repo-gate.ts`; Task 8 extends it).
- Produces: `RepoCandidate.entriesChecked?: true`, `RepoCandidate.unbuilt?: UnbuiltFinding`; `diffRepoState` queues a backfill fetch for a repository holding a listable, non-rescued candidate without the marker.

- [ ] **Step 1: Mark the "normally recorded" fixture, and say why**

In `registry/scripts/tests/repo-state.test.ts`, inside the `candidate()` helper, after `declarationsRule: DECLARATIONS_RULE,` add:

```ts
    // And its tree was checked for the files its patch loads (design
    // 2026-09-26-market-borrowings §9). Unmarked, every fixture below would
    // queue for that backfill and stop testing what it names.
    entriesChecked: true,
```

- [ ] **Step 2: Write the failing tests**

Append to `registry/scripts/tests/repo-state.test.ts`:

```ts
describe('the entry-check record (design 2026-09-26-market-borrowings §9.4, §9.6)', () => {
  const seen = (repo: string) => ({ repo, pushedAt: '2026-08-01T00:00:00Z' })
  const stateWith = (overrides: Partial<RepoCandidate>): RepoState => ({
    'o/r': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [{ ...candidate('o/r'), ...overrides }] },
  })

  it('queues an unmarked listable candidate for one backfill fetch', () => {
    const { entriesChecked: _marker, ...unmarked } = candidate('o/r')
    const state: RepoState = { 'o/r': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [unmarked] } }
    expect(diffRepoState(state, [seen('o/r')]).toFetch).toEqual([{ ...seen('o/r'), backfillOnly: true }])
  })

  it('does not queue a marked candidate, or a release-rescued one', () => {
    expect(diffRepoState(stateWith({}), [seen('o/r')]).toFetch).toEqual([])
    const { entriesChecked: _marker, ...unmarked } = candidate('o/r')
    const rescued: RepoState = {
      'o/r': {
        pushedAt: '2026-08-01T00:00:00Z', commit,
        candidates: [{ ...unmarked, release: { tag: 'v1', url: 'https://github.com/o/r/releases/download/v1/a.tgz', sha256: 'c'.repeat(64), assetVerified: true } }],
      },
    }
    expect(diffRepoState(rescued, [seen('o/r')]).toFetch).toEqual([])
  })

  it('round-trips both fields', () => {
    const state = stateWith({ unbuilt: { insert: 'dsh-r', path: 'lib/index.js' } })
    expect(parseRepoState(serializeRepoState(state))).toEqual(state)
  })

  it.each([
    ['a marker that is not true', { entriesChecked: 'yes' }],
    ['a finding without the marker', { entriesChecked: undefined, unbuilt: { patch: './x.yml' } }],
    ['a finding of neither shape', { unbuilt: { patch: './x.yml', insert: 'x' } }],
    ['an empty finding string', { unbuilt: { patch: '' } }],
    ['a finding string past its bound', { unbuilt: { patch: 'p'.repeat(201) } }],
  ])('refuses %s', (_what, overrides) => {
    const text = serializeRepoState(stateWith(overrides as Partial<RepoCandidate>))
    expect(() => parseRepoState(text)).toThrow(/malformed entry-check record/)
  })
})
```

Check the `{ entriesChecked: undefined, ... }` case: `JSON.stringify` drops an undefined key, so the serialized candidate carries `unbuilt` with no marker — the shape under test.

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/repo-state.test.ts`
Expected: FAIL — the unmarked candidate is not queued, and the malformed records parse.

- [ ] **Step 4: Implement**

In `registry/scripts/src/types.ts`, inside `RepoCandidate`, after `sizeCappedAt?: number`:

```ts
  /**
   * That the patch-target check (design 2026-09-26-market-borrowings §9) ran
   * on this candidate's pinned commit and got an answer, whichever way it
   * went. The contract of {@link RepoCandidate.sizeProbed}: written for an
   * answer, never for a transport failure, and its absence queues the
   * repository for one backfill fetch.
   */
  entriesChecked?: true
  /**
   * What the check found missing; present only beside `entriesChecked`. The
   * repo gate refuses the candidate as `requires-build` unless a release
   * rescued it.
   */
  unbuilt?: UnbuiltFinding
```

In `registry/scripts/src/repo-state.ts`, add `import { UNBUILT_FIELD_MAX_LENGTH } from './release-asset.ts'`, and beside `checkCarriedDeclarations`:

```ts
/**
 * Refuse a carried entry-check record of a shape this build never writes
 * (design 2026-09-26-market-borrowings §9.4): `entriesChecked` is `true` or
 * absent, and `unbuilt` is `{ patch }` or `{ insert, path }`, each a non-empty
 * string within `UNBUILT_FIELD_MAX_LENGTH`, present only beside the marker.
 * A wrong shape throws, the rule for a malformed registry file: the finding
 * decides a listing, so a corrupt one must not be read either way.
 */
function checkCarriedEntryCheck(repo: string, candidate: RepoCandidate): RepoCandidate {
  const { entriesChecked, unbuilt } = candidate as { entriesChecked?: unknown; unbuilt?: unknown }
  const malformed = (): never => {
    throw new Error(`repo-state.json: ${repo} has a candidate with a malformed entry-check record`)
  }
  if (entriesChecked !== undefined && entriesChecked !== true) malformed()
  if (unbuilt !== undefined && (entriesChecked !== true || !isUnbuiltFinding(unbuilt))) malformed()
  return candidate
}

function isUnbuiltFinding(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const field = (text: unknown): boolean => typeof text === 'string' && text !== '' && text.length <= UNBUILT_FIELD_MAX_LENGTH
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length === 1 && keys[0] === 'patch') return field(record.patch)
  if (keys.length === 2 && keys[0] === 'insert' && keys[1] === 'path') return field(record.insert) && field(record.path)
  return false
}
```

In `parseRepoState`, wrap both call sites: `reboundCarriedSize(checkCarriedEntryCheck(repo, checkCarriedDeclarations(repo, candidate)))` (and the same for `entry.candidate`).

Beside `lacksSizeProbe`:

```ts
/**
 * Whether a recorded repo holds a candidate the patch-target check never
 * answered for (design 2026-09-26-market-borrowings §9.6). The retroactivity
 * hole `lacksSizeProbe` closed, closed the same way: the marker's absence is
 * the queue, a check that answers sets it, and a candidate it refuses stops
 * passing {@link canEverList}, so the backfill ends by itself. A release-rescued
 * candidate is skipped: it installs the archive, which `verifyReleaseAsset`
 * already holds to the same rule.
 */
function lacksEntryCheck(recorded: RepoState[string]): boolean {
  return (recorded.candidates ?? []).some(
    candidate => candidate.release === undefined && canEverList(candidate) && candidate.entriesChecked !== true,
  )
}
```

and extend `diffRepoState`'s condition to `if (changed || hasUnverifiedRelease(recorded) || lacksSizeProbe(recorded, treeCap) || lacksEntryCheck(recorded)) {`. Update `diffRepoState`'s doc comment to name the entry check among the full-fetch backfills.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/repo-state.test.ts` then `pnpm typecheck`
Expected: PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/repo-state.ts registry/scripts/tests/repo-state.test.ts
git commit -m "feat(registry): record the patch-target check per candidate, and backfill it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Refuse an unbuilt candidate in the repo gate

**Files:**
- Modify: `registry/scripts/src/repo-gate.ts` (`canEverList`; `gateRepo` after the `workspace-deps` rule; new `unbuiltDetail`)
- Test: `registry/scripts/tests/repo-gate.test.ts`

**Interfaces:**
- Consumes: `RepoCandidate.unbuilt` (Task 7), `echo` (Task 6).
- Produces: `canEverList(candidate)` is false for a candidate with `unbuilt` and no `release`; `gateRepo` refuses it as `requires-build`.

- [ ] **Step 1: Write the failing tests**

Append to `registry/scripts/tests/repo-gate.test.ts`:

```ts
describe('an unbuilt finding (design 2026-09-26-market-borrowings §9.4)', () => {
  const at = commit.slice(0, 7)

  it('refuses a root whose inserted module is missing, naming the file and every remedy', () => {
    const result = gateRepo(repo({ entriesChecked: true, unbuilt: { insert: 'dsh-repo-plugin', path: 'lib/index.js' } }), config)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.rejection.code).toBe('requires-build')
      expect(result.rejection.detail).toBe(
        `Its patch inserts "dsh-repo-plugin", which its package.json resolves to "lib/index.js", and the repository does not contain that file at ${at}.`
        + ' A git install runs no build, so the plugin would not load.'
        + ' Commit the built files, publish to npm, or attach a packed release tarball, and it can be listed.',
      )
    }
  })

  it('tells a subpackage nothing about a release tarball, which cannot rescue it', () => {
    const result = gateRepo(repo({ subdir: 'packages/x', entriesChecked: true, unbuilt: { insert: 'dsh-repo-plugin', path: 'lib/index.js' } }), config)
    expect(!result.ok && result.rejection.detail).toMatch(/Commit the built files or publish to npm, and it can be listed\.$/)
  })

  it('refuses a missing patch file in its own words', () => {
    const result = gateRepo(repo({ entriesChecked: true, unbuilt: { patch: './dist/cordis.patch.yml' } }), config)
    expect(!result.ok && result.rejection.detail).toBe(
      `Declares dsh.bundle.patch "./dist/cordis.patch.yml", which the repository does not contain at ${at}, so dsh has no patch to load.`
      + ' Commit the file, publish to npm, or attach a packed release tarball, and it can be listed.',
    )
  })

  it('appends why an attached release did not rescue it', () => {
    const result = gateRepo(repo({ entriesChecked: true, unbuilt: { patch: './x.yml' }, releaseRejected: 'the release asset holds no files' }), config)
    expect(!result.ok && result.rejection.detail).toMatch(/A release tarball WAS found and refused: the release asset holds no files$/)
  })

  it('accepts the candidate a release rescued', () => {
    const release = { tag: 'v1.0.0', url: 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/a.tgz', sha256: 'c'.repeat(64), assetVerified: true } as const
    expect(gateRepo(repo({ entriesChecked: true, unbuilt: { patch: './x.yml' }, release }), config).ok).toBe(true)
  })
})
```

Append to the `'the entry-check record'` block Task 7 added in `registry/scripts/tests/repo-state.test.ts`:

```ts
  it('does not queue a candidate the check refused, so the backfill ends', () => {
    // The finding makes canEverList false, and lacksEntryCheck asks it.
    expect(diffRepoState(stateWith({ unbuilt: { patch: './cordis.patch.yml' } }), [seen('o/r')]).toFetch).toEqual([])
  })
```

It passes before this task's implementation for a weaker reason (the fixture is marked), so check it fails for the right one: with the fixture's marker removed and the finding kept, it must still not queue once `canEverList` reads `unbuilt`. Write that variant too:

```ts
  it('does not queue a refused candidate even when its marker is lost', () => {
    const { entriesChecked: _marker, ...unmarked } = candidate('o/r')
    const state: RepoState = { 'o/r': { pushedAt: '2026-08-01T00:00:00Z', commit, candidates: [{ ...unmarked, unbuilt: { patch: './cordis.patch.yml' } }] } }
    expect(diffRepoState(state, [seen('o/r')]).toFetch).toEqual([])
  })
```

In the existing `'canEverList agrees with the gate it is a shortcut for'` block, extend `combinations` with an `unbuilt` dimension and the rejection-code lists stay as they are (`requires-build` is already among them):

```ts
  const combinations = [false, true].flatMap(hasBundle =>
    [false, true].flatMap(requiresBuild =>
      [false, true].flatMap(hasWorkspaceDeps =>
        [undefined, RELEASE].flatMap(release =>
          [undefined, { patch: './cordis.patch.yml' }].map(unbuilt =>
            ({ hasBundle, requiresBuild, hasWorkspaceDeps, release, ...(unbuilt === undefined ? {} : { entriesChecked: true as const, unbuilt }) }))))))
```

Update the block's opening comment from "three of `gateRepo`'s rules" to four, and say the fourth is design §9's.

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/repo-gate.test.ts registry/scripts/tests/repo-state.test.ts`
Expected: FAIL — the unbuilt candidates are accepted, and the lost-marker variant is queued.

- [ ] **Step 3: Implement**

In `registry/scripts/src/repo-gate.ts`, add `import { echo } from './release-asset.ts'` and extend the type import with `UnbuiltFinding`. In `canEverList`, after the `hasWorkspaceDeps` line:

```ts
  // Design 2026-09-26-market-borrowings §9.4: the pinned tree lacks a file the
  // bundle loads, and a release answers it like the two rules above.
  if (candidate.unbuilt !== undefined && candidate.release === undefined) return false
```

In `gateRepo`, directly after the `workspace-deps` rule:

```ts
  // Design 2026-09-26-market-borrowings §9.4. The tree at the pinned commit
  // lacks a file the bundle loads: a patch file, or a module its patch inserts
  // from the package itself. A git install runs no build, so the entry could
  // not load; the code is `requires-build` because that is the fact, and the
  // release rescue already answers it.
  if (candidate.unbuilt !== undefined && candidate.release === undefined) {
    return reject(unit, 'requires-build', unbuiltDetail(candidate, candidate.unbuilt) + rescueNote(candidate))
  }
```

and beside `rescueNote`:

```ts
/**
 * The `requires-build` detail for an unbuilt finding (design
 * 2026-09-26-market-borrowings §9.4). Values are echoed, quoted and cut at
 * `ECHO_MAX`, as the release path echoes them. A subpackage is told nothing
 * about a release tarball: the rescue is for repository roots only.
 */
function unbuiltDetail(candidate: RepoCandidate, finding: UnbuiltFinding): string {
  const at = candidate.commit.slice(0, 7)
  const remedy = (lead: string): string => candidate.subdir === undefined
    ? `${lead}, publish to npm, or attach a packed release tarball, and it can be listed.`
    : `${lead} or publish to npm, and it can be listed.`
  if ('patch' in finding) {
    return `Declares dsh.bundle.patch ${echo(finding.patch)}, which the repository does not contain at ${at}, so dsh has no patch to load. ${remedy('Commit the file')}`
  }
  return `Its patch inserts ${echo(finding.insert)}, which its package.json resolves to ${echo(finding.path)},`
    + ` and the repository does not contain that file at ${at}. A git install runs no build, so the plugin would not load. ${remedy('Commit the built files')}`
}
```

- [ ] **Step 4: Run the gate, state and pipeline tests, and the typecheck**

Run: `pnpm vitest run registry/scripts/tests/repo-gate.test.ts registry/scripts/tests/repo-state.test.ts registry/scripts/tests/pipeline.test.ts registry/scripts/tests/classify-select.test.ts` then `pnpm typecheck`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/repo-gate.ts registry/scripts/tests/repo-gate.test.ts registry/scripts/tests/repo-state.test.ts
git commit -m "feat(registry): refuse a github entry whose pinned tree lacks what its patch loads

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Run the check in the sizing step, and extend the release rescue

**Files:**
- Modify: `registry/scripts/src/github-client.ts` (`probeSubpackageCandidates`, `projectRepoCandidates`, `fetchRepoCandidate`; new `rescueRelease`, `readPatchAtCommit`, `checkEntries`; imports)
- Test: `registry/scripts/tests/github-client.test.ts`

**Interfaces:**
- Consumes: `declaredPatchFiles`, `treePathOf`, `unbuiltFinding`, `MAX_PATCH_BYTES` (Task 6); `treeBlobPaths` (Task 6); `canEverList` (Task 8); `UnbuiltFinding`, `RepoCandidate.entriesChecked`, `RepoCandidate.unbuilt` (Tasks 6–7).
- Produces: every sizeable candidate `fetchRepoCandidate` returns carries `entriesChecked: true` whenever the sizing tree answered and every needed read answered, and `unbuilt` when the check found something; a root with a finding is release-probed.

- [ ] **Step 1: Write the failing tests**

Add a `describe` inside the existing `describe('fetchRepoCandidate', ...)` in `registry/scripts/tests/github-client.test.ts`, beside the sizing tests (it uses that block's `meta`, `commit`, `sleep` and `stubFetch`):

```ts
  describe('the patch-target check (design 2026-09-26-market-borrowings §9.3)', () => {
    const manifest = JSON.stringify({
      name: 'dsh-repo-plugin',
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, catalog: { category: 'tool', summary: { en: 'x' }, capabilities: [] } },
    })
    const patch = "- insert:\n    - id: plugin\n      name: 'dsh-repo-plugin'\n"
    const treeUrl = `https://api.github.com/repos/someone/dsh-repo-plugin/git/trees/${commit}?recursive=1`
    const patchUrl = `https://raw.githubusercontent.com/someone/dsh-repo-plugin/${commit}/cordis.patch.yml`
    const releaseUrl = 'https://api.github.com/repos/someone/dsh-repo-plugin/releases/latest'
    const tree = (paths: string[], truncated = false): Response => new Response(JSON.stringify({
      truncated, tree: paths.map(path => ({ path, type: 'blob', size: 10 })),
    }), { status: 200 })
    const base = (): Record<string, Response> => ({
      'https://raw.githubusercontent.com/someone/dsh-repo-plugin/main/package.json': new Response(manifest, { status: 200 }),
      'https://api.github.com/repos/someone/dsh-repo-plugin/commits/main': new Response(JSON.stringify({
        sha: commit, commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
      }), { status: 200 }),
    })

    it('marks a candidate whose tree holds its patch and the module it inserts', async () => {
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json', 'cordis.patch.yml', 'lib/index.js']),
        [patchUrl]: new Response(patch, { status: 200 }),
      }), sleep, 'token')
      expect(result.ok && result.candidates[0]?.entriesChecked).toBe(true)
      expect(result.ok && result.candidates[0]?.unbuilt).toBeUndefined()
    })

    it('records the module a gitignored lib/ leaves unresolvable, after a release probe finds none', async () => {
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json', 'cordis.patch.yml', 'src/index.ts']),
        [patchUrl]: new Response(patch, { status: 200 }),
        [releaseUrl]: new Response('{"message":"Not Found"}', { status: 404 }),
      }), sleep, 'token')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.candidates[0]?.entriesChecked).toBe(true)
        expect(result.candidates[0]?.unbuilt).toEqual({ insert: 'dsh-repo-plugin', path: 'lib/index.js' })
        expect(result.candidates[0]?.release).toBeUndefined()
      }
    })

    it('records a declared patch file the tree does not hold, without reading it', async () => {
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json', 'lib/index.js']),
        [releaseUrl]: new Response('{"message":"Not Found"}', { status: 404 }),
      }), sleep, 'token')
      expect(result.ok && result.candidates[0]?.unbuilt).toEqual({ patch: './cordis.patch.yml' })
    })

    it('marks a truncated tree without a verdict, so the backfill ends', async () => {
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json'], true),
      }), sleep, 'token')
      expect(result.ok && result.candidates[0]?.entriesChecked).toBe(true)
      expect(result.ok && result.candidates[0]?.unbuilt).toBeUndefined()
    })

    it('leaves the candidate unmarked when the patch read fails in transport', async () => {
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json', 'cordis.patch.yml']),
        [patchUrl]: new Response('upstream error', { status: 500 }),
      }), sleep, 'token')
      expect(result.ok && result.candidates[0]?.sizeProbed).toBe(true)
      expect(result.ok && result.candidates[0]?.entriesChecked).toBeUndefined()
      expect(result.ok && result.candidates[0]?.unbuilt).toBeUndefined()
    })

    it('marks a tree that answered 404 without a verdict', async () => {
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: new Response('{"message":"Not Found"}', { status: 404 }),
      }), sleep, 'token')
      expect(result.ok && result.candidates[0]?.entriesChecked).toBe(true)
      expect(result.ok && result.candidates[0]?.unbuilt).toBeUndefined()
    })

    const assetUrl = 'https://github.com/someone/dsh-repo-plugin/releases/download/v1.0.0/dsh-repo-plugin.tgz'
    const releaseOf = (): Response => new Response(JSON.stringify({ tag_name: 'v1.0.0', assets: [{ browser_download_url: assetUrl }] }), { status: 200 })

    it('rescues a root whose finding a verified release answers', async () => {
      const bytes = packedTarball('dsh-repo-plugin', { exports: { '.': './lib/index.js' } }, { 'package/lib/index.js': 'export default {}\n' })
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json', 'cordis.patch.yml']),
        [patchUrl]: new Response(patch, { status: 200 }),
        [releaseUrl]: releaseOf(),
        [assetUrl]: new Response(bytes, { status: 200 }),
      }), sleep, 'token')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.candidates[0]?.release?.tag).toBe('v1.0.0')
        expect(result.candidates[0]?.unbuilt).toEqual({ insert: 'dsh-repo-plugin', path: 'lib/index.js' })
      }
    })

    it('keeps the finding, and says why, when the attached release is refused', async () => {
      // An asset that packs another package: verifyReleaseAsset refuses it.
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json', 'cordis.patch.yml']),
        [patchUrl]: new Response(patch, { status: 200 }),
        [releaseUrl]: releaseOf(),
        [assetUrl]: new Response(packedTarball('another-package'), { status: 200 }),
      }), sleep, 'token')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.candidates[0]?.release).toBeUndefined()
        expect(result.candidates[0]?.releaseRejected).toBeTypeOf('string')
        expect(result.candidates[0]?.unbuilt).toEqual({ insert: 'dsh-repo-plugin', path: 'lib/index.js' })
      }
    })

    it('leaves the candidate unmarked when the release probe fails in transport', async () => {
      // Recording the finding without having asked the release would refuse
      // an entry its asset may rescue, so neither is recorded.
      const result = await fetchRepoCandidate(meta, stubFetch({
        ...base(),
        [treeUrl]: tree(['package.json', 'cordis.patch.yml']),
        [patchUrl]: new Response(patch, { status: 200 }),
        [releaseUrl]: new Response('upstream error', { status: 500 }),
      }), sleep, 'token')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.candidates[0]?.sizeProbed).toBe(true)
        expect(result.candidates[0]?.entriesChecked).toBeUndefined()
        expect(result.candidates[0]?.unbuilt).toBeUndefined()
      }
    })

    it('checks a subpackage under its own directory and never release-probes it', async () => {
      const urls: string[] = []
      const routes = stubFetch({
        'https://raw.githubusercontent.com/someone/monorepo/main/package.json':
          new Response(JSON.stringify({ private: true, workspaces: ['packages/*'] }), { status: 200 }),
        'https://api.github.com/repos/someone/monorepo/commits/main': new Response(JSON.stringify({
          sha: commit, commit: { author: { date: '2026-08-01T12:00:00.000Z' } },
        }), { status: 200 }),
        'https://api.github.com/repos/someone/monorepo/git/trees/main?recursive=1': new Response(JSON.stringify({
          tree: [{ path: 'package.json' }, { path: 'packages/x/package.json' }],
        }), { status: 200 }),
        'https://raw.githubusercontent.com/someone/monorepo/main/packages/x/package.json': new Response(JSON.stringify({
          name: 'dsh-x', exports: { '.': './lib/index.js' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
        }), { status: 200 }),
        [`https://api.github.com/repos/someone/monorepo/git/trees/${commit}?recursive=1`]: new Response(JSON.stringify({
          truncated: false,
          tree: [
            { path: 'package.json', type: 'blob', size: 10 },
            { path: 'packages/x/package.json', type: 'blob', size: 10 },
            { path: 'packages/x/cordis.patch.yml', type: 'blob', size: 10 },
          ],
        }), { status: 200 }),
        [`https://raw.githubusercontent.com/someone/monorepo/${commit}/packages/x/cordis.patch.yml`]:
          new Response("- insert:\n    - id: x\n      name: 'dsh-x'\n", { status: 200 }),
      })
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        urls.push(String(url))
        return routes(url, init)
      }) as unknown as typeof fetch
      const result = await fetchRepoCandidate({ ...meta, fullName: 'someone/monorepo' }, fetchImpl, sleep, 'token')
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.candidates[0]?.subdir).toBe('packages/x')
        expect(result.candidates[0]?.unbuilt).toEqual({ insert: 'dsh-x', path: 'lib/index.js' })
      }
      expect(urls.some(url => url.includes('releases/latest'))).toBe(false)
    })
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/github-client.test.ts -t "patch-target check"`
Expected: FAIL — no candidate carries `entriesChecked`.

- [ ] **Step 3: Thread each candidate's manifest out of the projection**

In `probeSubpackageCandidates`: add `manifests: Map<RepoCandidate, unknown>` to the return type; create `const manifests = new Map<RepoCandidate, unknown>()` beside `candidates`; after `candidates.push(sub)` add `manifests.set(sub, subManifest)`; give all three returns a `manifests` key (`new Map()` for the two early ones, `manifests` for the last).

Above `projectRepoCandidates`, add:

```ts
/**
 * A projection's outcome, plus the manifest each candidate was projected from.
 * Beside the array, never on the rows: a transient field on a row has to be
 * stripped at every return that carries it, which is the leak the
 * `anyClaimed` comment in probeSubpackageCandidates records. Read by the
 * patch-target check (design 2026-09-26-market-borrowings §9.3).
 */
type ProjectedCandidates = RepoFetchResult & { readonly manifests?: ReadonlyMap<RepoCandidate, unknown> }
```

Change `projectRepoCandidates`' return type to `Promise<ProjectedCandidates>`, `const root = projectCandidate(...)` to `let root = ...`, and its two candidate-bearing returns to:

```ts
  if (root !== null && root.hasBundle) {
    return { ok: true, candidates: [root], manifests: new Map([[root, manifest]]) }
  }
```

```ts
    if (subs.length > 0) {
      return { ok: true, candidates: subs, manifests: subManifests, ...(subFailures.length > 0 ? { subpackageFailures: subFailures } : {}) }
    }
```

destructuring `manifests: subManifests` from `probeSubpackageCandidates`' result.

- [ ] **Step 4: Extract the release rescue into one helper**

Add above `projectRepoCandidates`, moving the rescue block's existing comments into it:

```ts
/**
 * Probe a repository root's latest release and, when its asset verifies,
 * rescue the root onto it. One helper for the projection's rescue
 * (`requiresBuild || hasWorkspaceDeps`) and the patch-target check's (design
 * 2026-09-26-market-borrowings §9.5), so the two cannot drift. Throws when the
 * probe fails in transport, as `fetchLatestReleaseTarball` does.
 * @returns the root rescued, the root with `releaseRejected`, or the root
 *   unchanged when there is no release asset to try.
 */
async function rescueRelease(
  root: RepoCandidate,
  fullName: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number,
  tarballTimeoutMs: number,
): Promise<RepoCandidate> {
  const [owner, slug] = fullName.split('/')
  if (owner === undefined || slug === undefined) return root
  const release = await fetchLatestReleaseTarball(owner, slug, root.name, fetchImpl, sleep, token, timeoutMs, tarballTimeoutMs)
  if (release === null) return root
  if (!release.ok) return { ...root, releaseRejected: release.detail }
  const rescued: RepoCandidate = {
    ...root,
    release: { tag: release.tag, url: release.url, sha256: release.sha256, assetVerified: true },
    installSize: release.installSize,
    sizeProbed: true,
  }
  writeDeclarations(rescued, release.declarations)
  return rescued
}
```

Replace the projection's inline rescue block with:

```ts
  if (root !== null && (root.requiresBuild || root.hasWorkspaceDeps)) {
    root = await rescueRelease(root, meta.fullName, fetchImpl, sleep, token, timeoutMs, tarballTimeoutMs)
  }
```

Run: `pnpm vitest run registry/scripts/tests/github-client.test.ts -t "rescue"`
Expected: every existing rescue test PASSES unedited — the refactor moves code, not behavior.

- [ ] **Step 5: Implement the check in the sizing step**

Extend the imports: `declaredPatchFiles, MAX_PATCH_BYTES, treePathOf, unbuiltFinding` from `./release-asset.ts`; `treeBlobPaths` from `./tree-size.ts`; `type UnbuiltFinding` from `./types.ts`. Add before `fetchRepoCandidate`:

```ts
/**
 * One declared patch file's text at the pinned commit (design
 * 2026-09-26-market-borrowings §9.3), read only for a file the tree lists.
 * `answered: false` for anything that is not the file: a transport failure,
 * a deadline, a non-ok status — a 404 included, since the tree said the file
 * is there — so the candidate stays unmarked and is checked again next run.
 * A body past MAX_PATCH_BYTES answers with no text: claim (2) then forms no
 * verdict for that file, as the archive path does.
 */
async function readPatchAtCommit(
  fullName: string,
  commit: string,
  path: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number,
): Promise<{ answered: true; text: string | undefined } | { answered: false }> {
  const url = `${RAW_GITHUB}/${fullName}/${commit}/${path.split('/').map(encodeURIComponent).join('/')}`
  try {
    const response = await fetchRobust(url, fetchImpl, sleep, token, timeoutMs)
    if (!response.ok) return { answered: false }
    const bytes = await readCappedBody(response, MAX_PATCH_BYTES)
    if (bytes === null) return { answered: true, text: undefined }
    return { answered: true, text: new TextDecoder().decode(bytes).replace(/^﻿/, '') }
  } catch {
    // Swallows a transport failure of this one read — a throw from the retry
    // ladder, a deadline, a body that broke mid-stream. It says nothing about
    // the repository, and the caller records nothing for it, so the next run
    // asks again; nothing else can reach this catch.
    return { answered: false }
  }
}

/**
 * Run the patch-target check for one sizeable candidate (design
 * 2026-09-26-market-borrowings §9.3).
 * @param present - the tree's blob paths, or null when the tree answered but
 *   cannot vouch for an absence (truncated, malformed, 404, past the cap).
 */
async function checkEntries(
  candidate: RepoCandidate,
  manifest: unknown,
  present: ReadonlySet<string> | null,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  timeoutMs: number,
): Promise<{ checked: true; finding: UnbuiltFinding | null } | { checked: false }> {
  if (present === null) return { checked: true, finding: null }
  if (manifest === undefined) return { checked: false }
  const files = declaredPatchFiles(manifest)
  if (files === null) return { checked: true, finding: null }
  const root = candidate.subdir ?? ''
  const texts = new Map<string, string>()
  for (const file of files) {
    const path = treePathOf(root, file)
    // Unaskable or absent: `unbuiltFinding` decides which, and an absent file
    // needs no read.
    if (path === null || !present.has(path)) continue
    const read = await readPatchAtCommit(candidate.repo, candidate.commit, path, fetchImpl, sleep, token, timeoutMs)
    if (!read.answered) return { checked: false }
    if (read.text !== undefined) texts.set(file, read.text)
  }
  return { checked: true, finding: unbuiltFinding(manifest, candidate.name, root, present, texts) }
}
```

Replace the body of `fetchRepoCandidate` from `const result = await projectRepoCandidates(...)` to its end with:

```ts
  const { manifests, ...result } = await projectRepoCandidates(
    meta, fetchImpl, sleep, token, probeSubpackages, timeoutMs, tarballTimeoutMs,
  )
  if (!result.ok) return result
  const sizeable = result.candidates.filter(
    candidate => candidate.release === undefined && canEverList(candidate),
  )
  const first = sizeable[0]
  if (first === undefined) return result
  const read = await readSizingTree(meta.fullName, first.commit, fetchImpl, sleep, token, treeTimeoutMs)
  if (!read.answered) return result
  const cappedAt = 'cappedAt' in read ? read.cappedAt : undefined
  // A 404 or a body past the cap answers with no body: the commit's tree is
  // settled for now, so the check is marked with no verdict, as the size is.
  const present = read.body === undefined ? null : treeBlobPaths(read.body)
  const candidates: RepoCandidate[] = []
  for (const candidate of result.candidates) {
    if (candidate.release !== undefined || !canEverList(candidate)) {
      candidates.push(candidate)
      continue
    }
    const installSize = treeInstallSize(read.body, candidate.subdir)
    let next: RepoCandidate = {
      ...candidate,
      sizeProbed: true,
      ...(installSize !== undefined ? { installSize } : {}),
      ...(cappedAt !== undefined ? { sizeCappedAt: cappedAt } : {}),
    }
    const check = await checkEntries(candidate, manifests?.get(candidate), present, fetchImpl, sleep, token, timeoutMs)
    if (check.checked) {
      next = { ...next, entriesChecked: true, ...(check.finding === null ? {} : { unbuilt: check.finding }) }
      if (check.finding !== null && next.subdir === undefined) {
        try {
          next = await rescueRelease(next, meta.fullName, fetchImpl, sleep, token, timeoutMs, tarballTimeoutMs)
        } catch {
          // Swallows a release probe that failed in transport. Recording the
          // finding without having asked the release would refuse an entry
          // its asset may rescue, so the marker and the finding are dropped
          // together and the next run checks again; nothing else can reach
          // this catch.
          const { entriesChecked: _marker, unbuilt: _finding, ...unchecked } = next
          next = unchecked
        }
      }
    }
    candidates.push(next)
  }
  return { ...result, candidates }
```

Keep the two comment blocks the old body carried (release candidates are sized from their archive; `canEverList` skips what can never list) above the `sizeable` filter, unchanged.

- [ ] **Step 6: Run the new tests**

Run: `pnpm vitest run registry/scripts/tests/github-client.test.ts -t "patch-target check"`
Expected: PASS.

- [ ] **Step 7: Run the whole github-client suite and migrate the fixtures it now contradicts**

Run: `pnpm vitest run registry/scripts/tests/github-client.test.ts`
Expected failures fall into three classes. Resolve each in the test, with a comment saying which class and why; never by loosening the code.

1. **A recorded-state fixture that represents a normally recorded candidate now queues a backfill** (a `toFetch`, budget or fetched-count assertion moves). Add `entriesChecked: true` beside its `sizeProbed: true`, with the comment Task 7 Step 1 gave the repo-state helper.
2. **A sizing fixture whose tree lacks the manifest's `./cordis.patch.yml` now records `{ patch: './cordis.patch.yml' }`** and, for a root, release-probes. If the test is about something else (a size, a marker, a projection), add `cordis.patch.yml` to its tree. If its routes answer `releases/latest` with a 404, a whole-object `toEqual` on the candidate now sees the finding: add the patch file to the tree rather than the finding to the expectation, unless the test is about refusal.
3. **A test counting requests** now sees a patch read or a release probe. Route the patch file, then recompute the count from the routes and write the arithmetic in the comment.

Re-run until green, then run `pnpm vitest run registry/scripts/tests/` (the whole registry suite) and `pnpm typecheck`.
Expected: PASS, exit 0.

- [ ] **Step 8: Revert each guard once**

One at a time, each followed by `git checkout -- registry/scripts/src` after recording the result:
- delete the `lacksEntryCheck(recorded)` clause in `diffRepoState` — expect "queues an unmarked listable candidate for one backfill fetch" RED;
- make `checkEntries` return `{ checked: true, finding: null }` when `read.answered` is false — expect "leaves the candidate unmarked when the patch read fails in transport" RED;
- delete the `try`/`catch` around `rescueRelease` in `fetchRepoCandidate`, letting the throw propagate — expect "leaves the candidate unmarked when the release probe fails in transport" RED;
- make `canEverList` ignore `unbuilt` — expect the extended `canEverList` guard test and "does not queue a refused candidate even when its marker is lost" RED;
- make `fetchRepoCandidate` release-probe every candidate with a finding, subpackages included — expect "checks a subpackage under its own directory and never release-probes it" RED.
Record each command and the failing test's name in the report.

- [ ] **Step 9: Commit**

```bash
git add registry/scripts/src/github-client.ts registry/scripts/tests/github-client.test.ts
git commit -m "feat(registry): check each commit-pinned entry's patch targets at its pinned tree, and rescue a root by release

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Author docs, CLAUDE.md, and the design marked built

**Files:**
- Modify: `docs/schema.md`, `docs/schema.zh.md` (after the paragraph that begins "The build report lists each rejection as a **Reason**" / "构建报告把每条拒绝记成 **Reason**")
- Modify: `CLAUDE.md` ("The one architectural rule": the pure list; "Failing loudly": one bullet)
- Modify: `docs/design/2026-09-26-market-borrowings.md` (status line; §8 and §9 status lines)
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (the two 2026-10-07 amendments)

**Interfaces:** none.

- [ ] **Step 1: Author docs, both languages**

Append to `docs/schema.md`, after the "The build report lists each rejection…" paragraph:

```markdown
**When a listed package leaves the catalog, the report says why.** Each build compares its harvest with the catalog it last published. If your npm package was listed and the harvest no longer returns it, npm is asked about it once. A package whose latest version still lists `dsh-plugin` or `deepseek-harness` and is not deprecated stays listed. Otherwise the report carries one row on that build: `deprecated`, quoting your deprecation message (up to 200 characters), or `npm-gone`, which says whether the package was unpublished, is no longer on the registry, or lost both keywords. Add a keyword back and the next build lists it again.

**A listing taken from a GitHub repository installs the pinned commit as it is.** No build runs on a git install, so every file your bundle loads must be in the repository at that commit: each `dsh.bundle.patch` file, and the file your `exports` (or `main`) resolves to for each module the patch inserts from your own package. A `lib/` or `dist/` your `.gitignore` excludes is not there, and such a listing is refused as `requires-build` with the missing file named. Commit the built files, publish the package to npm, or, for a repository root, attach a packed release tarball (`npm pack` from a built checkout) to your latest release. A monorepo subpackage cannot be rescued by a release.
```

Append to `docs/schema.zh.md` at the matching place, in its own register (same facts, not a word-for-word translation):

```markdown
**已上架的包离开目录时，报告会写明原因。** 每次构建都会把本次收录和上次发布的目录对比。如果你的 npm 包上次在目录里、这次没被收录，构建会向 npm 查询一次。最新版仍带 `dsh-plugin` 或 `deepseek-harness` 关键词且没有弃用的包，会继续上架；否则，那次构建的报告会写一行：`deprecated` 并引用你的弃用说明（最多 200 个字符），或者 `npm-gone`，说明它是被撤销发布、已不在 registry 上，还是去掉了两个关键词。把关键词加回去，下次构建就会重新上架。

**从 GitHub 仓库收录的条目，装的就是固定 commit 的原样内容。** 从 git 安装不会运行任何构建，所以 bundle 要加载的每个文件都必须在那个 commit 里：每个 `dsh.bundle.patch` 文件，以及 patch 插入的你自己包里的每个模块经 `exports`（或 `main`）解析到的文件。被 `.gitignore` 排除的 `lib/` 或 `dist/` 不在仓库里，这样的条目会以 `requires-build` 被拒绝，并写明缺的是哪个文件。可以把构建产物提交进仓库、把包发布到 npm，或者（仅限仓库根）在最新的 release 里附上打包好的 tarball（在构建好的目录里运行 `npm pack`）。monorepo 的子包无法靠 release 补救。
```

- [ ] **Step 2: CLAUDE.md**

In "The one architectural rule", add `departures.ts` to the pure list after `release-asset.ts`. In "Failing loudly", after the bullet "A package that cannot be fetched becomes a `fetch-failed` rejection…", add:

```markdown
- **A listed npm package the harvest no longer returns is read once** (design 2026-09-26-market-borrowings §8). One whose latest version still carries a harvest keyword undeprecated is carried: it joins the candidates and is counted in no keyword's coverage. Any other leaves with one row on that build, `deprecated` quoting the author's message or `npm-gone` naming the cause. This runs where the npm harvest runs, `classify.ts` included, because the classifier prunes the category rows of names it does not hold.
```

- [ ] **Step 3: Mark the design built**

In `docs/design/2026-09-26-market-borrowings.md`: change the status sentence `**Batch 2, A2 and A3, decided 2026-10-07: §8–§10, not yet built.**` to `**Batch 2, A2 and A3, decided 2026-10-07 and built on \`feat/borrowings-batch-2\`: §8–§10.**`, and each of §8's and §9's `Decided 2026-10-07, not yet built.` to `Decided and built 2026-10-07.` (use the date the code lands if it is not 2026-10-07). In `docs/design/2026-08-18-dsh-plugin-shop-design.md`, change `; not yet built)` to `; built)` in both 2026-10-07 amendments.

- [ ] **Step 4: Run the doc guards and the whole suite**

Run: `pnpm vitest run registry/scripts/tests/doc-pairs.test.ts` then `pnpm test` then `pnpm typecheck`
Expected: PASS, exit 0. Then check each changed file ends with exactly one newline: `for f in docs/schema.md docs/schema.zh.md CLAUDE.md docs/design/2026-09-26-market-borrowings.md docs/design/2026-08-18-dsh-plugin-shop-design.md; do tail -c 2 "$f" | od -An -c; done` — every line must end `\n` preceded by a character that is not `\n`.

- [ ] **Step 5: Commit**

```bash
git add docs/schema.md docs/schema.zh.md CLAUDE.md docs/design/2026-09-26-market-borrowings.md docs/design/2026-08-18-dsh-plugin-shop-design.md
git commit -m "docs: npm departures and unbuilt github entries for authors, and mark batch 2 built

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## After the last task

- [ ] Run `pnpm test` and `pnpm typecheck` once more on the branch tip; both exit 0, and the test count is the baseline's plus every test this plan added.
- [ ] Do not push, open a pull request, or run `pnpm build:catalog`. The pull request, its zero-write dry run (which shows the departures line and the first backfill slice of §9), and the squash merge each wait for LivXue's go-ahead.
