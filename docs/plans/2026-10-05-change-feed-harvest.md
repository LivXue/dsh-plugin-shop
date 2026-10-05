# Change-Feed Harvest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harvest dsh plugins from npm's replication change feed by
publication time, crediting them to search coverage after sampled
verification, so the residual past the 5,250-name search window is
harvested instead of tolerated.

**Architecture:** A pure module, `feed-state.ts`, holds the committed
state (`registry/feed-state.json`), the membership rule and every
decision. An impure module, `npm-feed.ts`, reads the feed forward from
the committed cursor and the `/latest` manifests it selects.
`searchByKeywords` gains a feed step at the end of `enumerate()` that
credits feed-only carriers after paging their owners' cells.
`classify.ts` runs the feed before the search and hands the next state
to `build.ts`, which writes the file after the pipeline; `daily.yml`
commits it.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`),
Node `--experimental-strip-types`, vitest, pnpm, GitHub Actions.

**Spec:** `docs/design/2026-10-04-change-feed-harvest.md` (commit
`42b285b` on this branch). Read it first; this plan argues from it.

## Global Constraints

- Worktree, used by every command below as a literal path:
  `/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed`
  on branch `feat/change-feed`, based on `origin/main` `868df77`. Never
  edit the main checkout.
- Run git as `/usr/bin/git -C <worktree> ...` and pnpm as
  `pnpm --dir <worktree> ...`. Commit after every green step. Every
  commit message ends with
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- `feed-state.ts` is pure: no clock, no network, no filesystem, no
  environment. It must contain none of the deadline guard's seam
  markers: `typeof fetch`, `Promise<Response>`, `RequestInit`, or a
  bare `fetch(`.
- Every ordering that reaches a file or a report uses `compareStrings`
  (code-unit), never a locale sort.
- Every npm-sourced string rendered into the build report goes through
  `escapeCell`.
- New text is ASCII. Prose in docs wraps at 72 columns; code follows
  the surrounding file. Files end with exactly one newline.
- An empty `catch` names what it swallows and why.
- Constants, from spec section 4.9: `FEED_URL =
  'https://replicate.npmjs.com/registry'`, `FEED_PAGE_LIMIT = 10_000`,
  `FEED_PAGE_BUDGET = 200`, `FEED_PAGE_MAX_BYTES = 8 MiB`,
  `FEED_MANIFEST_MAX_BYTES = 1 MiB`, `FEED_READ_CONCURRENCY = 16`,
  `FEED_READ_TIME_BUDGET_MS = 20 min`,
  `FEED_NAME_PATTERN = /dsh|deepseek|cordis/i`,
  `FEED_BOOTSTRAP_SEQ = 117_350_000`, `FEED_VERIFY_OWNERS = 16`,
  `FEED_MAX_DISAGREEMENTS = 3`.
- `MAX_UNREACHABLE_RESIDUAL` stays 60 in this change.
- A PR is a zero-write dry run. Merge (squash, explicit subject
  `(#N)`, curated body with the trailer, `--match-head-commit`) only
  on LivXue's word.

## Review Focus

1. **A feed id outside the package-name rule** (a legacy capitalized
   name such as `DSH-Thing`, or junk) must never reach the state file.
   If it did, the next run's strict parse would throw, and the feed
   would be dead until a human edits the file. Task 2 tests it at
   selection and at the merge.
2. **A package republished during one run's paging** shows up on two
   pages. It must be read once, at its last row. Task 2.
3. **A `/latest` manifest whose `keywords` is a string or holds
   non-strings** is read as data and never throws. Task 1.
4. **A `--harvest-from` handoff whose feed state is behind the
   committed file** is refused and never written. A cursor moving
   backwards only re-reads, but a stale list un-learns carriers until
   they change again. Task 6.
5. **A verification cell that answers 5xx or serves short of its
   total** leaves its owner's names unverified, never disagreeing, so a
   registry hiccup cannot throw the build. Task 4.

---

### Task 1: The state file and the membership rule

**Files:**
- Create: `registry/scripts/src/feed-state.ts`
- Create: `registry/scripts/tests/feed-state.test.ts`
- Modify: `registry/scripts/src/npm-client.ts` (move `isDeprecated`
  out, import it back)

**Interfaces:**
- Consumes: `compareStrings(a: string, b: string): number` from
  `identity.ts`; `isMaintainerName(value: unknown): value is string`
  from `publisher-state.ts`.
- Produces:
  - constants `FEED_NAME_PATTERN`, `FEED_BOOTSTRAP_SEQ`,
    `FEED_PACKAGE_NAME_MAX_LENGTH`, `FEED_VERIFY_OWNERS`,
    `FEED_MAX_DISAGREEMENTS`
  - `isFeedPackageName(value: unknown): value is string`
  - `isDeprecated(deprecated: unknown): boolean`
  - `interface FeedCarrier { readonly owner: string | null; readonly keywords: readonly string[] }`
  - `interface FeedState { readonly seq: number; readonly carriers: ReadonlyMap<string, FeedCarrier>; readonly pending: readonly string[] }`
  - `type FeedRead`, with kinds `carrier` (with `carrier`),
    `not-carrier`, `gone`, `failed` (with `reason`) and `unreached`,
    each carrying `name`
  - `classifyManifest(name: string, manifest: unknown, harvestKeywords: readonly string[]): FeedRead`
  - `bootstrapFeedState(): FeedState`
  - `parseFeedState(raw: string, harvestKeywords: readonly string[]): FeedState`
  - `serializeFeedState(state: FeedState): string`

- [ ] **Step 0: Install and record the baseline**

Run:
```bash
CI=true pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed install --frozen-lockfile
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed test
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: every test passes (1,315 at `#73`), and `tsc` prints
nothing. Record the count; Task 8 compares against it.

- [ ] **Step 1: Write the failing tests**

Create `registry/scripts/tests/feed-state.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  bootstrapFeedState, classifyManifest, FEED_BOOTSTRAP_SEQ, FEED_NAME_PATTERN, FEED_PACKAGE_NAME_MAX_LENGTH,
  isDeprecated, isFeedPackageName, parseFeedState, serializeFeedState, type FeedState,
} from '../src/feed-state.ts'

const KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']

describe('classifyManifest', () => {
  const manifest = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: 'dsh-x', keywords: ['dsh-plugin'], maintainers: [{ name: 'alice' }], ...overrides,
  })

  it('admits a manifest that lists a harvest keyword exactly', () => {
    expect(classifyManifest('dsh-x', manifest(), KEYWORDS)).toEqual({
      kind: 'carrier', name: 'dsh-x', carrier: { owner: 'alice', keywords: ['dsh-plugin'] },
    })
  })

  it('records every harvest keyword it lists, sorted by code unit', () => {
    const read = classifyManifest('dsh-x', manifest({ keywords: ['dsh-plugin', 'tool', 'deepseek-harness'] }), KEYWORDS)
    expect(read).toMatchObject({ kind: 'carrier', carrier: { keywords: ['deepseek-harness', 'dsh-plugin'] } })
  })

  it('refuses a keyword that matches only case-insensitively, as npm search does', () => {
    // 0 of 7,002 packuments matched only this way (spec section 2); the
    // index compares exactly, so crediting one would cancel a missing name.
    expect(classifyManifest('dsh-x', manifest({ keywords: ['DSH-Plugin'] }), KEYWORDS))
      .toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it.each([true, 'Folded into dsh-y.'])('refuses a deprecated manifest (deprecated: %j)', (deprecated) => {
    expect(classifyManifest('dsh-x', manifest({ deprecated }), KEYWORDS)).toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it.each([false, '', '   ', undefined])('keeps a manifest that is not deprecated (deprecated: %j)', (deprecated) => {
    expect(classifyManifest('dsh-x', manifest({ deprecated }), KEYWORDS).kind).toBe('carrier')
  })

  it('reads a keywords string as no keywords, never as a throw', () => {
    // Review Focus 3.
    expect(classifyManifest('dsh-x', manifest({ keywords: 'dsh-plugin, tool' }), KEYWORDS))
      .toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it('ignores keyword entries that are not strings', () => {
    expect(classifyManifest('dsh-x', manifest({ keywords: [null, 7, { k: 1 }, 'dsh-plugin'] }), KEYWORDS).kind)
      .toBe('carrier')
  })

  it('reports a manifest for another package as failed, so the name is read again next run', () => {
    expect(classifyManifest('dsh-x', manifest({ name: 'dsh-y' }), KEYWORDS)).toMatchObject({ kind: 'failed', name: 'dsh-x' })
  })

  it('reads a manifest with no name as not a carrier', () => {
    expect(classifyManifest('dsh-x', manifest({ name: undefined }), KEYWORDS)).toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it.each([null, 'text', 42, ['dsh-plugin']])('reads a body that is not an object (%j) as not a carrier', (body) => {
    expect(classifyManifest('dsh-x', body, KEYWORDS)).toEqual({ kind: 'not-carrier', name: 'dsh-x' })
  })

  it('takes the code-unit-smallest maintainer username as owner, never _npmUser', () => {
    const read = classifyManifest('dsh-x', manifest({
      maintainers: [{ name: 'zed' }, { name: 'bob' }], _npmUser: { name: 'GitHub Actions' },
    }), KEYWORDS)
    expect(read).toMatchObject({ carrier: { owner: 'bob' } })
  })

  it('stores a null owner when no maintainer name passes the username grammar', () => {
    const read = classifyManifest('dsh-x', manifest({ maintainers: [{ name: 'Bob Smith' }, 'alice', null] }), KEYWORDS)
    expect(read).toMatchObject({ kind: 'carrier', carrier: { owner: null } })
  })
})

describe('isDeprecated', () => {
  it.each([
    [true, true], ['Use dsh-y.', true], ['', false], ['  ', false], [false, false], [undefined, false], [1, false],
  ])('reads %j as deprecated: %s', (value, expected) => {
    expect(isDeprecated(value)).toBe(expected)
  })
})

describe('isFeedPackageName', () => {
  it.each(['dsh-recheck', '@pbfuzz/dsh-kanalyzer', 'a', 'x'.repeat(FEED_PACKAGE_NAME_MAX_LENGTH)])('accepts %s', (name) => {
    expect(isFeedPackageName(name)).toBe(true)
  })

  it.each([
    '', 'DSH-Thing', '_hidden', '.dot', '@scope', '@/x', 'a b', 'x'.repeat(FEED_PACKAGE_NAME_MAX_LENGTH + 1), '__proto__', 7,
  ])('refuses %j', (name) => {
    expect(isFeedPackageName(name)).toBe(false)
  })
})

describe('FEED_NAME_PATTERN', () => {
  it.each(['dsh-recheck', '@d0nj/dsh-web-search-multi', 'my-DeepSeek-tool', 'cordis-plugin-x', 'spreadsheet-utils'])(
    'matches %s', (id) => {
      expect(FEED_NAME_PATTERN.test(id)).toBe(true)
    },
  )

  it.each(['probe-kit', 'billion-context-relief', 'react'])('does not match %s', (id) => {
    expect(FEED_NAME_PATTERN.test(id)).toBe(false)
  })

  it('carries no g flag, so test() keeps no state between calls', () => {
    expect(FEED_NAME_PATTERN.flags).not.toContain('g')
    expect([FEED_NAME_PATTERN.test('dsh-a'), FEED_NAME_PATTERN.test('dsh-a')]).toEqual([true, true])
  })
})

describe('the state file', () => {
  const state: FeedState = {
    seq: 134466916,
    carriers: new Map([
      ['dsh-recheck', { owner: 'f1refly', keywords: ['deepseek-harness', 'dsh-plugin'] }],
      ['@pbfuzz/dsh-kanalyzer', { owner: null, keywords: ['dsh-plugin'] }],
    ]),
    pending: ['dsh-b', 'dsh-a'],
  }
  const text = [
    '{',
    '  "seq": 134466916,',
    '  "carriers": {',
    '    "@pbfuzz/dsh-kanalyzer": {"owner":null,"keywords":["dsh-plugin"]},',
    '    "dsh-recheck": {"owner":"f1refly","keywords":["deepseek-harness","dsh-plugin"]}',
    '  },',
    '  "pending": [',
    '    "dsh-a",',
    '    "dsh-b"',
    '  ]',
    '}',
    '',
  ].join('\n')

  it('serializes one carrier per line, sorted by code unit, with one trailing newline', () => {
    expect(serializeFeedState(state)).toBe(text)
  })

  it('serializes the same state the same way whatever order it was built in', () => {
    const reversed: FeedState = {
      ...state, carriers: new Map([...state.carriers].reverse()), pending: [...state.pending].reverse(),
    }
    expect(serializeFeedState(reversed)).toBe(text)
  })

  it('serializes an empty state compactly', () => {
    expect(serializeFeedState(bootstrapFeedState()))
      .toBe(`{\n  "seq": ${FEED_BOOTSTRAP_SEQ},\n  "carriers": {},\n  "pending": []\n}\n`)
  })

  it('round-trips', () => {
    const parsed = parseFeedState(text, KEYWORDS)
    expect(parsed.seq).toBe(134466916)
    expect(parsed.carriers).toEqual(state.carriers)
    expect(parsed.pending).toEqual(['dsh-a', 'dsh-b'])
    expect(serializeFeedState(parsed)).toBe(text)
  })

  it('ignores an unknown top-level key, and the next write drops it', () => {
    const parsed = parseFeedState('{"seq": 5, "carriers": {}, "pending": [], "note": "hi"}', KEYWORDS)
    expect(serializeFeedState(parsed)).toBe('{\n  "seq": 5,\n  "carriers": {},\n  "pending": []\n}\n')
  })

  it.each([
    ['not JSON', '{', /not JSON/],
    ['an array', '[]', /expected an object/],
    ['a negative seq', '{"seq": -1, "carriers": {}, "pending": []}', /`seq`/],
    ['a fractional seq', '{"seq": 1.5, "carriers": {}, "pending": []}', /`seq`/],
    ['a string seq', '{"seq": "1", "carriers": {}, "pending": []}', /`seq`/],
    ['carriers as an array', '{"seq": 1, "carriers": [], "pending": []}', /`carriers`/],
    ['a carrier outside the package-name rule',
      '{"seq": 1, "carriers": {"DSH-X": {"owner": null, "keywords": ["dsh-plugin"]}}, "pending": []}', /package name/],
    ['a carrier that is not an object', '{"seq": 1, "carriers": {"dsh-x": 3}, "pending": []}', /must be an object/],
    ['an owner outside the username grammar',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": "Bob Smith", "keywords": ["dsh-plugin"]}}, "pending": []}', /owner/],
    ['a missing owner', '{"seq": 1, "carriers": {"dsh-x": {"keywords": ["dsh-plugin"]}}, "pending": []}', /owner/],
    ['an empty keyword list', '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": []}}, "pending": []}', /at least one/],
    ['a keyword that is not a harvest keyword',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": ["dsh"]}}, "pending": []}', /not a harvest keyword/],
    ['keywords out of order',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": ["dsh-plugin", "deepseek-harness"]}}, "pending": []}',
      /out of order/],
    ['a keyword listed twice',
      '{"seq": 1, "carriers": {"dsh-x": {"owner": null, "keywords": ["dsh-plugin", "dsh-plugin"]}}, "pending": []}',
      /out of order or twice/],
    ['a missing pending list', '{"seq": 1, "carriers": {}}', /`pending`/],
    ['a pending name outside the rule', '{"seq": 1, "carriers": {}, "pending": ["DSH-X"]}', /`pending`/],
    ['a pending name listed twice', '{"seq": 1, "carriers": {}, "pending": ["dsh-a", "dsh-a"]}', /twice/],
  ])('throws on %s', (_what, raw, message) => {
    expect(() => parseFeedState(raw, KEYWORDS)).toThrow(message)
  })

  it('names the file and the way out in every error', () => {
    expect(() => parseFeedState('{', KEYWORDS)).toThrow(/registry\/feed-state\.json: .*delete it to re-read the feed/)
  })

  it('starts a bootstrap at FEED_BOOTSTRAP_SEQ holding nothing', () => {
    const fresh = bootstrapFeedState()
    expect(fresh.seq).toBe(FEED_BOOTSTRAP_SEQ)
    expect(fresh.carriers.size).toBe(0)
    expect(fresh.pending).toEqual([])
  })
})
```

Arithmetic check for the order fixtures: `compareStrings('dsh-plugin',
'deepseek-harness')` compares `s` (0x73) against `e` (0x65), so it is
positive, and that list is out of order. `@` (0x40) sorts before `d`
(0x64), which puts `@pbfuzz/...` first in `text`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/feed-state.test.ts`
Expected: FAIL. The module `../src/feed-state.ts` cannot be resolved.

- [ ] **Step 3: Write the module**

Create `registry/scripts/src/feed-state.ts`:

```ts
/**
 * The change feed's committed state and the rule that decides which
 * packages it holds. Pure: no clock, no network, no filesystem, no
 * environment.
 *
 * npm search reaches a package by RANK and ranks a new one at the bottom,
 * past every 5,250-name window; npm's replication change feed lists it by
 * the time it changed. `npm-feed.ts` reads the feed. Every decision it
 * applies lives here, so fixtures can drive all of them.
 * Spec: docs/design/2026-10-04-change-feed-harvest.md.
 * @module feed-state
 */
import { compareStrings } from './identity.ts'
import { isMaintainerName } from './publisher-state.ts'

/**
 * The ids whose `/latest` manifest a run reads: a DISCOVERY filter, never
 * a membership rule. A name it matches is admitted only by the exact
 * keyword in its manifest (`classifyManifest`), so the pattern can cause a
 * miss but never a listing -- CLAUDE.md, "Admit by keyword, never by name
 * pattern".
 *
 * Measured 2026-10-04 (spec section 2): it matches 96.1% of the names that
 * carry `dsh-plugin` and 95.5% of those that carry `deepseek-harness`, and
 * 19 of the 22 residue names an owner sweep identified; it selects about
 * 700 ids a day. Most false positives are "spreadsheet", which contains
 * "dsh"; each costs one small read. No `g` flag: `test` on a global regex
 * keeps `lastIndex` between calls, and this one is shared by every call.
 */
export const FEED_NAME_PATTERN = /dsh|deepseek|cordis/i

/**
 * Where a run with no state file starts reading. Seq 117,350,216 dates to
 * 2026-07-01T00:00Z by binary search on the median `modified` of the rows
 * that follow it (spec section 2); rounded down, it is ahead of the first
 * dsh package. A full catch-up from here measured 62 pages and 17,779
 * selected ids.
 */
export const FEED_BOOTSTRAP_SEQ = 117_350_000

/** npm's own bound on the length of a package name. */
export const FEED_PACKAGE_NAME_MAX_LENGTH = 214

/**
 * The modern npm package-name grammar: lowercase, URL-safe, an optional
 * scope. Applied where a name is ADMITTED and again where the file is
 * PARSED, so the parser can never meet a name the writer produced (spec
 * section 4.2). npm still serves some legacy names with capitals; those
 * are refused at selection and stay search's to reach, as they are today.
 */
const FEED_PACKAGE_NAME = /^(?:@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/

/**
 * Owners whose `keywords:K maintainer:U` cell one run pages per keyword to
 * verify feed-only names. Today's residue has 12 owners per keyword, so
 * every feed-only name is verified until a crossing grows it past 16.
 */
export const FEED_VERIFY_OWNERS = 16

/**
 * Feed-only names per keyword per run that may disagree with their
 * owner's cell before the build throws. Room for index lag on a name
 * published minutes before the read; a systematic drift exceeds it at once
 * -- crediting deprecated packages would have produced 28 disagreements
 * out of 47 (spec section 2).
 */
export const FEED_MAX_DISAGREEMENTS = 3

/** Whether `value` is a name the feed may store (see FEED_PACKAGE_NAME). */
export function isFeedPackageName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= FEED_PACKAGE_NAME_MAX_LENGTH
    && FEED_PACKAGE_NAME.test(value)
}

/**
 * Whether npm reports this version deprecated.
 *
 * `npm deprecate <pkg> ""` is the documented un-deprecate, and it leaves
 * `deprecated: ""` behind -- so the presence of the key says nothing. A
 * non-empty message means deprecated; so does a bare `true`, which some
 * manifests carry and which we must not read as "fine" (audit B-5). It
 * lives here, not in npm-client.ts, so the feed's membership rule and the
 * packument reader share one definition: npm search excludes deprecated
 * packages from its results AND from `total` (spec section 2), so the two
 * must agree exactly.
 * @param deprecated - the manifest `deprecated` value, unvalidated.
 */
export function isDeprecated(deprecated: unknown): boolean {
  if (deprecated === true) return true
  return typeof deprecated === 'string' && deprecated.trim() !== ''
}

/** One package the feed holds. */
export interface FeedCarrier {
  /**
   * The code-unit-smallest `maintainers[].name` that `isMaintainerName`
   * accepts, or null when none does. Never `_npmUser`: that is the
   * identity that published, and it can be a bot's display name ("GitHub
   * Actions"), which `maintainer:` cannot address.
   */
  readonly owner: string | null
  /** The harvest keywords its latest version lists: sorted, never empty. */
  readonly keywords: readonly string[]
}

/** The committed state, `registry/feed-state.json`. */
export interface FeedState {
  /** The feed position up to which every row has been applied. */
  readonly seq: number
  /** Every package the feed has seen whose latest version passes the rule. */
  readonly carriers: ReadonlyMap<string, FeedCarrier>
  /** Names whose read failed or was not reached; read first next run. */
  readonly pending: readonly string[]
}

/** What reading one `/latest` manifest established. */
export type FeedRead =
  | { readonly kind: 'carrier'; readonly name: string; readonly carrier: FeedCarrier }
  // Read, and not a carrier: no harvest keyword, deprecated, another 4xx,
  // too large, or not JSON. The manifest was read -- the `no-manifest`
  // side of the line CLAUDE.md draws -- so the name is dropped.
  | { readonly kind: 'not-carrier'; readonly name: string }
  // A 404, or a row the feed marks deleted.
  | { readonly kind: 'gone'; readonly name: string }
  // A transport failure, a deadline, a 5xx or 429 after retries, or the
  // manifest of another package: the `fetch-failed` side. Kept, retried.
  | { readonly kind: 'failed'; readonly name: string; readonly reason: string }
  // Not started within the run's read budget. Kept, retried.
  | { readonly kind: 'unreached'; readonly name: string }

/**
 * Apply the membership rule (spec section 4.3) to one parsed `/latest`
 * manifest. A package carries a harvest keyword when the manifest names
 * it, lists the keyword by exact code-unit equality -- as npm search and
 * `isAtRisk` compare -- and is not deprecated.
 */
export function classifyManifest(name: string, manifest: unknown, harvestKeywords: readonly string[]): FeedRead {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return { kind: 'not-carrier', name }
  const m = manifest as { name?: unknown; keywords?: unknown; deprecated?: unknown; maintainers?: unknown }
  if (typeof m.name !== 'string') return { kind: 'not-carrier', name }
  // The manifest of another package is a statement about the transport (a
  // cache answering the wrong key), not about this package, so it is
  // retried rather than believed -- the packument reader's own rule.
  if (m.name !== name) return { kind: 'failed', name, reason: 'the registry answered with the manifest of another package' }
  if (isDeprecated(m.deprecated)) return { kind: 'not-carrier', name }
  const declared: readonly unknown[] = Array.isArray(m.keywords) ? m.keywords : []
  const keywords = harvestKeywords.filter(keyword => declared.includes(keyword)).sort(compareStrings)
  if (keywords.length === 0) return { kind: 'not-carrier', name }
  const owners = (Array.isArray(m.maintainers) ? m.maintainers : [])
    .map((entry: unknown) => (entry !== null && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
    .filter(isMaintainerName)
    .sort(compareStrings)
  return { kind: 'carrier', name, carrier: { owner: owners[0] ?? null, keywords } }
}

/** The state a run starts from when `registry/feed-state.json` is absent. */
export function bootstrapFeedState(): FeedState {
  return { seq: FEED_BOOTSTRAP_SEQ, carriers: new Map(), pending: [] }
}

/**
 * Read `registry/feed-state.json`. Throws on anything malformed (spec
 * section 4.2): a state the build cannot trust is a state it must not
 * credit, and an empty one would look like an ecosystem with no residue.
 * Unknown top-level keys are ignored, as publisher-state.json's are, and
 * the next write drops them.
 */
export function parseFeedState(raw: string, harvestKeywords: readonly string[]): FeedState {
  const fail = (what: string): never => {
    throw new Error(`registry/feed-state.json: ${what}; restore it from git, or delete it to re-read the feed from FEED_BOOTSTRAP_SEQ`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // JSON.parse throws only a SyntaxError about this text, which is what
    // the message reports.
    return fail(`not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('expected an object')
  const p = parsed as { seq?: unknown; carriers?: unknown; pending?: unknown }
  const seq = p.seq
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) return fail('`seq` must be a non-negative integer')
  const rawCarriers = p.carriers
  if (rawCarriers === null || typeof rawCarriers !== 'object' || Array.isArray(rawCarriers)) {
    return fail('`carriers` must be an object')
  }
  const carriers = new Map<string, FeedCarrier>()
  for (const [name, value] of Object.entries(rawCarriers)) {
    const shown = JSON.stringify(name.slice(0, 80))
    if (!isFeedPackageName(name)) return fail(`carrier ${shown} is not a package name the feed admits`)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(`carrier ${shown} must be an object`)
    const entry = value as { owner?: unknown; keywords?: unknown }
    const owner = entry.owner === null
      ? null
      : isMaintainerName(entry.owner) ? entry.owner : fail(`carrier ${shown} has an owner that is neither null nor a maintainer username`)
    if (!Array.isArray(entry.keywords) || entry.keywords.length === 0) {
      return fail(`carrier ${shown} must list at least one harvest keyword`)
    }
    const keywords: string[] = []
    for (const keyword of entry.keywords as unknown[]) {
      if (typeof keyword !== 'string' || !harvestKeywords.includes(keyword)) {
        return fail(`carrier ${shown} lists a keyword that is not a harvest keyword`)
      }
      const previous = keywords[keywords.length - 1]
      if (previous !== undefined && compareStrings(previous, keyword) >= 0) {
        return fail(`carrier ${shown} lists its keywords out of order or twice`)
      }
      keywords.push(keyword)
    }
    carriers.set(name, { owner, keywords })
  }
  const rawPending = p.pending
  if (!Array.isArray(rawPending)) return fail('`pending` must be an array')
  const pending: string[] = []
  for (const name of rawPending as unknown[]) {
    if (!isFeedPackageName(name)) return fail('`pending` holds a name the feed does not admit')
    pending.push(name)
  }
  if (new Set(pending).size !== pending.length) return fail('`pending` lists a name twice')
  return { seq, carriers, pending: pending.sort(compareStrings) }
}

/**
 * Write `registry/feed-state.json`: one carrier per line, everything
 * sorted by code unit, one trailing newline, so a day's churn is a few
 * hundred lines rather than a reformatted file (spec section 4.2).
 */
export function serializeFeedState(state: FeedState): string {
  const carriers = [...state.carriers]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([name, carrier]) =>
      `    ${JSON.stringify(name)}: ${JSON.stringify({ owner: carrier.owner, keywords: [...carrier.keywords].sort(compareStrings) })}`)
  const pending = [...new Set(state.pending)].sort(compareStrings).map(name => `    ${JSON.stringify(name)}`)
  const block = (lines: readonly string[]): string => (lines.length === 0 ? '' : `\n${lines.join(',\n')}\n  `)
  return `{\n  "seq": ${state.seq},\n  "carriers": {${block(carriers)}},\n  "pending": [${block(pending)}]\n}\n`
}
```

- [ ] **Step 4: Move `isDeprecated` out of npm-client.ts**

In `registry/scripts/src/npm-client.ts`, delete the whole `isDeprecated`
function together with its doc comment: the block that starts with
`/**\n * Whether npm reports this version deprecated.` and ends with the
function's closing `}` just above `export function toCandidate(`. Then
add this import after the `publisher-state.ts` import line near the top
of the file:

```ts
import { isDeprecated } from './feed-state.ts'
```

The single call site, `deprecated: isDeprecated(manifest.deprecated),`
inside `toCandidate`, stays as it is.

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/feed-state.test.ts registry/scripts/tests/npm-client.test.ts
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: both files PASS. The `toCandidate` deprecated tests in
npm-client.test.ts pass unchanged, and `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed add registry/scripts/src/feed-state.ts registry/scripts/tests/feed-state.test.ts registry/scripts/src/npm-client.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed commit -q -F - <<'EOF'
feat(registry): the change feed's state file and membership rule

feed-state.ts holds registry/feed-state.json's shape, its strict
parser and its line-per-carrier serializer, and the membership rule a
/latest manifest must pass: the exact harvest keyword, not
deprecated. isDeprecated moves here so the rule and the packument
reader share one definition.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 2: One run's pure logic

**Files:**
- Modify: `registry/scripts/src/feed-state.ts` (append)
- Modify: `registry/scripts/tests/feed-state.test.ts` (append)

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces:
  - `interface FeedRow { readonly seq: number; readonly id: string; readonly deleted: boolean }`
  - `parseFeedPage(value: unknown): { readonly rows: readonly FeedRow[]; readonly lastSeq: number } | null`
  - `interface FeedSelection { readonly read: readonly string[]; readonly gone: readonly string[]; readonly refused: number }`
  - `selectFeedIds(rows: readonly FeedRow[], prior: FeedState): FeedSelection`
  - `applyFeedReads(prior: FeedState, reads: readonly FeedRead[], nextSeq: number): FeedState`
  - `carrierCounts(state: FeedState, harvestKeywords: readonly string[]): Record<string, number>`
  - `feedCarriersByKeyword(state: FeedState, harvestKeywords: readonly string[]): Map<string, Map<string, string | null>>`
  - `interface FeedVerificationPlan { readonly owners: readonly string[]; readonly namesOf: ReadonlyMap<string, readonly string[]>; readonly unverified: readonly string[]; readonly ownersTotal: number }`
  - `planFeedVerification(feedOnly: readonly string[], ownerOf: ReadonlyMap<string, string | null>, budget: number, seed: number): FeedVerificationPlan`
  - `interface FeedCoverage { keyword; feedOnly; supplied; ownersVerified; ownersTotal; verified; unverified; disagreed: readonly string[] }`, all readonly and all counts numbers
  - `interface FeedRunReport { available: boolean; note: string; fromSeq; toSeq; pages; selected; read; failed; unreached; refused; pending; carriers: Readonly<Record<string, number>> }`, all readonly
  - `interface FeedInput { readonly carriers: ReadonlyMap<string, ReadonlyMap<string, string | null>>; readonly seed: number; readonly onCoverage?: (coverage: FeedCoverage) => void }`
  - `NO_FEED: FeedInput`

- [ ] **Step 1: Write the failing tests**

Extend the import at the top of `feed-state.test.ts` to:

```ts
import {
  applyFeedReads, bootstrapFeedState, carrierCounts, classifyManifest, FEED_BOOTSTRAP_SEQ, FEED_NAME_PATTERN,
  FEED_PACKAGE_NAME_MAX_LENGTH, feedCarriersByKeyword, isDeprecated, isFeedPackageName, parseFeedPage, parseFeedState,
  planFeedVerification, selectFeedIds, serializeFeedState, type FeedRow, type FeedState,
} from '../src/feed-state.ts'
```

and append:

```ts
describe('parseFeedPage', () => {
  it('reads rows and the next cursor off a page', () => {
    expect(parseFeedPage({
      results: [{ seq: 5, id: 'dsh-a', changes: [{ rev: '1-x' }] }, { seq: 7, id: 'gone-b', deleted: true, changes: [] }],
      last_seq: 7,
    })).toEqual({ rows: [{ seq: 5, id: 'dsh-a', deleted: false }, { seq: 7, id: 'gone-b', deleted: true }], lastSeq: 7 })
  })

  it('reads only a literal true as deleted', () => {
    expect(parseFeedPage({ results: [{ seq: 1, id: 'a', deleted: 'yes' }], last_seq: 1 })?.rows[0]?.deleted).toBe(false)
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['no results', { last_seq: 1 }],
    ['results that are not an array', { results: {}, last_seq: 1 }],
    ['a string cursor, the CouchDB 2 shape', { results: [], last_seq: '1-g1AAAA' }],
    ['a row with no seq', { results: [{ id: 'a' }], last_seq: 1 }],
    ['a row with a string seq', { results: [{ seq: '1', id: 'a' }], last_seq: 1 }],
    ['a row with no id', { results: [{ seq: 1 }], last_seq: 1 }],
    ['a row that is not an object', { results: [7], last_seq: 1 }],
  ])('refuses %s', (_what, page) => {
    expect(parseFeedPage(page)).toBeNull()
  })
})

describe('selectFeedIds', () => {
  const state = (carriers: Record<string, string[]> = {}, pending: string[] = []): FeedState => ({
    seq: 0,
    carriers: new Map(Object.entries(carriers).map(([name, keywords]) => [name, { owner: 'alice', keywords }])),
    pending,
  })
  const row = (seq: number, id: string, deleted = false): FeedRow => ({ seq, id, deleted })

  it('reads an id the name filter matches, and only those', () => {
    expect(selectFeedIds([row(1, 'dsh-a'), row(2, 'react')], state())).toEqual({ read: ['dsh-a'], gone: [], refused: 0 })
  })

  it('reads an id once when it appears on two pages, at its last row', () => {
    // Review Focus 2: the feed is live, so a package republished mid-read
    // shows up again further on, and a deletion then a republish is a read.
    expect(selectFeedIds([row(1, 'dsh-a'), row(9, 'dsh-a')], state())).toEqual({ read: ['dsh-a'], gone: [], refused: 0 })
    expect(selectFeedIds([row(1, 'dsh-a', true), row(9, 'dsh-a')], state({ 'dsh-a': ['dsh-plugin'] })).read)
      .toEqual(['dsh-a'])
  })

  it('re-reads a held carrier that changed even though the filter does not match it', () => {
    expect(selectFeedIds([row(1, 'probe-kit')], state({ 'probe-kit': ['dsh-plugin'] })).read).toEqual(['probe-kit'])
  })

  it('reads every pending name first, changed or not, then the changed ids in code-unit order', () => {
    expect(selectFeedIds([row(1, 'dsh-c'), row(2, 'dsh-b')], state({}, ['dsh-z', 'dsh-y'])).read)
      .toEqual(['dsh-y', 'dsh-z', 'dsh-b', 'dsh-c'])
  })

  it('reads a pending name that also changed only once', () => {
    expect(selectFeedIds([row(1, 'dsh-y')], state({}, ['dsh-y'])).read).toEqual(['dsh-y'])
  })

  it('marks a held carrier the feed deleted as gone, without a read', () => {
    expect(selectFeedIds([row(1, 'dsh-a', true)], state({ 'dsh-a': ['dsh-plugin'] })))
      .toEqual({ read: [], gone: ['dsh-a'], refused: 0 })
  })

  it('marks a deleted pending name gone and does not read it', () => {
    expect(selectFeedIds([row(1, 'dsh-p', true)], state({}, ['dsh-p']))).toEqual({ read: [], gone: ['dsh-p'], refused: 0 })
  })

  it('ignores the deletion of a package it never held', () => {
    expect(selectFeedIds([row(1, 'dsh-a', true)], state())).toEqual({ read: [], gone: [], refused: 0 })
  })

  it('refuses, and counts, a matching id outside the package-name rule', () => {
    // Review Focus 1: a legacy capitalized name must never be read into the
    // state, or the next run's strict parse throws.
    expect(selectFeedIds([row(1, 'DSH-Legacy'), row(2, 'dsh-ok')], state()))
      .toEqual({ read: ['dsh-ok'], gone: [], refused: 1 })
  })

  it('skips design documents', () => {
    expect(selectFeedIds([row(1, '_design/dsh')], state()).read).toEqual([])
  })
})

describe('applyFeedReads', () => {
  const prior: FeedState = {
    seq: 10,
    carriers: new Map([['dsh-held', { owner: 'alice', keywords: ['dsh-plugin'] }]]),
    pending: ['dsh-pend'],
  }

  it('sets a carrier and clears it from pending', () => {
    const next = applyFeedReads(prior, [
      { kind: 'carrier', name: 'dsh-pend', carrier: { owner: 'bob', keywords: ['deepseek-harness'] } },
    ], 20)
    expect(next.carriers.get('dsh-pend')).toEqual({ owner: 'bob', keywords: ['deepseek-harness'] })
    expect(next.pending).toEqual([])
    expect(next.seq).toBe(20)
  })

  it.each(['not-carrier', 'gone'] as const)('removes a held name read as %s', (kind) => {
    expect(applyFeedReads(prior, [{ kind, name: 'dsh-held' }], 20).carriers.has('dsh-held')).toBe(false)
  })

  it('keeps a held carrier whose read failed, and makes it pending', () => {
    const next = applyFeedReads(prior, [{ kind: 'failed', name: 'dsh-held', reason: 'the registry answered 503' }], 20)
    expect(next.carriers.get('dsh-held')).toEqual({ owner: 'alice', keywords: ['dsh-plugin'] })
    expect(next.pending).toEqual(['dsh-held', 'dsh-pend'])
  })

  it('makes an unreached name pending', () => {
    expect(applyFeedReads(prior, [{ kind: 'unreached', name: 'dsh-new' }], 20).pending).toEqual(['dsh-new', 'dsh-pend'])
  })

  it('never stores a name outside the package-name rule, so the next parse cannot throw', () => {
    // Review Focus 1, at the writer: whatever reaches the merge, the file
    // it produces parses.
    const next = applyFeedReads(prior, [
      { kind: 'carrier', name: 'DSH-Legacy', carrier: { owner: null, keywords: ['dsh-plugin'] } },
      { kind: 'failed', name: 'Bad Name', reason: 'x' },
    ], 20)
    expect(next.carriers.has('DSH-Legacy')).toBe(false)
    expect(next.pending).toEqual(['dsh-pend'])
    expect(() => parseFeedState(serializeFeedState(next), KEYWORDS)).not.toThrow()
  })

  it('refuses to move the cursor backwards', () => {
    expect(() => applyFeedReads(prior, [], 9)).toThrow(/cannot move from 10 to 9/)
  })

  it('leaves the prior state untouched', () => {
    applyFeedReads(prior, [{ kind: 'gone', name: 'dsh-held' }], 20)
    expect(prior.carriers.has('dsh-held')).toBe(true)
  })
})

describe('feedCarriersByKeyword and carrierCounts', () => {
  const state: FeedState = {
    seq: 1,
    carriers: new Map([
      ['dsh-b', { owner: null, keywords: ['dsh-plugin'] }],
      ['dsh-a', { owner: 'alice', keywords: ['deepseek-harness', 'dsh-plugin'] }],
    ]),
    pending: [],
  }

  it('groups carriers by harvest keyword with their owners, in code-unit order of name', () => {
    const byKeyword = feedCarriersByKeyword(state, KEYWORDS)
    expect([...(byKeyword.get('dsh-plugin') ?? [])]).toEqual([['dsh-a', 'alice'], ['dsh-b', null]])
    expect([...(byKeyword.get('deepseek-harness') ?? [])]).toEqual([['dsh-a', 'alice']])
  })

  it('holds an empty map for a keyword nothing carries', () => {
    expect(feedCarriersByKeyword(bootstrapFeedState(), KEYWORDS).get('dsh-plugin')?.size).toBe(0)
  })

  it('counts carriers per keyword', () => {
    expect(carrierCounts(state, KEYWORDS)).toEqual({ 'dsh-plugin': 2, 'deepseek-harness': 1 })
  })
})

describe('planFeedVerification', () => {
  const owners = new Map<string, string | null>([
    ['n-a1', 'a'], ['n-a2', 'a'], ['n-b', 'b'], ['n-c', 'c'], ['n-d', 'd'], ['n-e', 'e'], ['n-null', null],
  ])
  const all = ['n-a1', 'n-a2', 'n-b', 'n-c', 'n-d', 'n-e', 'n-null']

  it('checks every owner when they fit the budget, and leaves an ownerless name unverified', () => {
    const plan = planFeedVerification(all, owners, 16, 0)
    expect(plan.owners).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(plan.namesOf.get('a')).toEqual(['n-a1', 'n-a2'])
    expect(plan.unverified).toEqual(['n-null'])
    expect(plan.ownersTotal).toBe(5)
  })

  it('rotates the owners it checks by the seed, wrapping round', () => {
    // Five owners a..e: seed 3 starts at d; seed 4 starts at e and wraps
    // to a; 4 + 5,000 is 4 again modulo 5.
    expect(planFeedVerification(all, owners, 2, 3).owners).toEqual(['d', 'e'])
    expect(planFeedVerification(all, owners, 2, 4).owners).toEqual(['e', 'a'])
    expect(planFeedVerification(all, owners, 2, 5004).owners).toEqual(['e', 'a'])
  })

  it('leaves the names of every owner it does not check unverified', () => {
    expect(planFeedVerification(all, owners, 2, 3).unverified).toEqual(['n-a1', 'n-a2', 'n-b', 'n-c', 'n-null'])
  })

  it('checks nothing with a zero budget or no feed-only names', () => {
    expect(planFeedVerification(all, owners, 0, 0).owners).toEqual([])
    expect(planFeedVerification([], owners, 16, 0)).toEqual({ owners: [], namesOf: new Map(), unverified: [], ownersTotal: 0 })
  })

  it('treats a name with no recorded owner as unverified', () => {
    expect(planFeedVerification(['n-unknown'], owners, 16, 0).unverified).toEqual(['n-unknown'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/feed-state.test.ts`
Expected: FAIL. `parseFeedPage`, `selectFeedIds` and the other new
names are not exported.

- [ ] **Step 3: Append the implementation to `feed-state.ts`**

```ts
/** One row of the change feed: a package at its latest change in the range read. */
export interface FeedRow {
  readonly seq: number
  readonly id: string
  readonly deleted: boolean
}

const isSeq = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Read one `_changes` page, or null when its shape is not the one
 * measured on 2026-10-04 (spec section 2). All or nothing: rows are
 * applied in order, so a page with one unreadable row would advance the
 * cursor past a change nobody read.
 */
export function parseFeedPage(value: unknown): { readonly rows: readonly FeedRow[]; readonly lastSeq: number } | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const page = value as { results?: unknown; last_seq?: unknown }
  const lastSeq = page.last_seq
  if (!Array.isArray(page.results) || !isSeq(lastSeq)) return null
  const rows: FeedRow[] = []
  for (const raw of page.results as unknown[]) {
    if (raw === null || typeof raw !== 'object') return null
    const row = raw as { seq?: unknown; id?: unknown; deleted?: unknown }
    const seq = row.seq
    const id = row.id
    if (!isSeq(seq) || typeof id !== 'string') return null
    rows.push({ seq, id, deleted: row.deleted === true })
  }
  return { rows, lastSeq }
}

/** Which names one run reads, and which it drops without a read. */
export interface FeedSelection {
  /** Names to read this run: every pending name first, then each changed id once. */
  readonly read: readonly string[]
  /** Held or pending names the feed marks deleted: gone without a read. */
  readonly gone: readonly string[]
  /** Ids the name filter matched that the package-name rule refuses. */
  readonly refused: number
}

/**
 * Choose what to read (spec section 4.4, step 3): an id the name filter
 * matches, or one the state already holds or has pending -- so a held
 * carrier is re-read whenever it changes, even if the pattern is ever
 * narrowed -- plus every pending name, changed or not.
 */
export function selectFeedIds(rows: readonly FeedRow[], prior: FeedState): FeedSelection {
  // The feed is live, so one id can appear on two pages of one run when
  // its package changed again mid-read: only its last row counts.
  const last = new Map<string, FeedRow>()
  for (const row of rows) {
    const held = last.get(row.id)
    if (held === undefined || row.seq >= held.seq) last.set(row.id, row)
  }
  const pending = new Set(prior.pending)
  const gone: string[] = []
  const changed: string[] = []
  let refused = 0
  for (const [id, row] of last) {
    if (id.startsWith('_')) continue
    const known = prior.carriers.has(id) || pending.has(id)
    if (!known && !FEED_NAME_PATTERN.test(id)) continue
    if (!isFeedPackageName(id)) {
      refused += 1
      continue
    }
    if (row.deleted) {
      if (known) gone.push(id)
      continue
    }
    if (!pending.has(id)) changed.push(id)
  }
  const goneSet = new Set(gone)
  return {
    read: [...[...pending].filter(name => !goneSet.has(name)).sort(compareStrings), ...changed.sort(compareStrings)],
    gone: gone.sort(compareStrings),
    refused,
  }
}

/**
 * Merge one run's reads into the state (spec section 4.4, step 5). Pure:
 * the prior state is not modified. Pending names hold what the cursor has
 * passed, which is what makes advancing it safe.
 */
export function applyFeedReads(prior: FeedState, reads: readonly FeedRead[], nextSeq: number): FeedState {
  if (!Number.isSafeInteger(nextSeq) || nextSeq < prior.seq) {
    throw new Error(`the change-feed cursor cannot move from ${prior.seq} to ${nextSeq}`)
  }
  const carriers = new Map(prior.carriers)
  const pending = new Set(prior.pending)
  for (const read of reads) {
    // The writer applies the parser's own rule, so nothing written here can
    // make the next run's parse throw (spec section 4.2).
    if (!isFeedPackageName(read.name)) continue
    switch (read.kind) {
      case 'carrier':
        carriers.set(read.name, read.carrier)
        pending.delete(read.name)
        break
      case 'not-carrier':
      case 'gone':
        carriers.delete(read.name)
        pending.delete(read.name)
        break
      case 'failed':
      case 'unreached':
        pending.add(read.name)
        break
    }
  }
  return { seq: nextSeq, carriers, pending: [...pending].sort(compareStrings) }
}

/** Carriers per harvest keyword, for the report. */
export function carrierCounts(state: FeedState, harvestKeywords: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const keyword of harvestKeywords) counts[keyword] = 0
  for (const carrier of state.carriers.values()) {
    for (const keyword of carrier.keywords) counts[keyword] = (counts[keyword] ?? 0) + 1
  }
  return counts
}

/**
 * The carriers `searchByKeywords` may credit: per harvest keyword, each
 * carrier's owner, in code-unit order of name.
 */
export function feedCarriersByKeyword(
  state: FeedState,
  harvestKeywords: readonly string[],
): Map<string, Map<string, string | null>> {
  const byKeyword = new Map<string, Map<string, string | null>>()
  for (const keyword of harvestKeywords) byKeyword.set(keyword, new Map())
  for (const [name, carrier] of [...state.carriers].sort(([a], [b]) => compareStrings(a, b))) {
    for (const keyword of carrier.keywords) byKeyword.get(keyword)?.set(name, carrier.owner)
  }
  return byKeyword
}

/** Which owners' cells one keyword pages to verify its feed-only names. */
export interface FeedVerificationPlan {
  /** Owners whose `keywords:K maintainer:U` cell is paged, in order. */
  readonly owners: readonly string[]
  /** Each chosen owner's feed-only names, sorted. */
  readonly namesOf: ReadonlyMap<string, readonly string[]>
  /** Feed-only names not checked this run: no owner, or an owner past the budget. */
  readonly unverified: readonly string[]
  /** Distinct owners holding feed-only names. */
  readonly ownersTotal: number
}

/**
 * Choose up to `budget` owners in code-unit order, rotated by `seed` (the
 * next state's `seq`), so successive runs check different owners when
 * there are more than the budget (spec section 4.5).
 */
export function planFeedVerification(
  feedOnly: readonly string[],
  ownerOf: ReadonlyMap<string, string | null>,
  budget: number,
  seed: number,
): FeedVerificationPlan {
  const byOwner = new Map<string, string[]>()
  const unverified: string[] = []
  for (const name of [...feedOnly].sort(compareStrings)) {
    const owner = ownerOf.get(name) ?? null
    if (owner === null) {
      unverified.push(name)
      continue
    }
    const names = byOwner.get(owner)
    if (names === undefined) byOwner.set(owner, [name])
    else names.push(name)
  }
  const all = [...byOwner.keys()].sort(compareStrings)
  const take = Math.min(Math.max(0, budget), all.length)
  const offset = all.length === 0 ? 0 : seed % all.length
  const owners: string[] = []
  for (let i = 0; i < take; i += 1) {
    const owner = all[(offset + i) % all.length]
    if (owner !== undefined) owners.push(owner)
  }
  const chosen = new Set(owners)
  for (const owner of all) {
    if (!chosen.has(owner)) unverified.push(...(byOwner.get(owner) ?? []))
  }
  return {
    owners,
    namesOf: new Map(owners.map((owner): [string, string[]] => [owner, byOwner.get(owner) ?? []])),
    unverified: unverified.sort(compareStrings),
    ownersTotal: all.length,
  }
}

/** What the feed step did for one keyword in one run (spec section 4.7). */
export interface FeedCoverage {
  readonly keyword: string
  /** Carriers of the keyword no search cell had served when the step ran. */
  readonly feedOnly: number
  /** The step's own delta on the keyword's union: credited names plus any
   * other name a verification cell served. */
  readonly supplied: number
  readonly ownersVerified: number
  readonly ownersTotal: number
  readonly verified: number
  readonly unverified: number
  /** Feed-only names their owner's cell did not serve: neither listed nor
   * credited. Sorted. */
  readonly disagreed: readonly string[]
}

/** What one run's feed read did (spec section 4.7). */
export interface FeedRunReport {
  /** False when the head or the first page could not be read, or the
   * stored cursor is past the head: nothing from the feed is listed or
   * credited, and the run is today's search-only harvest. */
  readonly available: boolean
  /** Why the feed is unavailable, or where paging stopped early; empty when
   * it read to the head. */
  readonly note: string
  readonly fromSeq: number
  readonly toSeq: number
  readonly pages: number
  /** Names chosen to read, pending first. */
  readonly selected: number
  /** Of those, the reads that were started: `selected - unreached`. */
  readonly read: number
  readonly failed: number
  readonly unreached: number
  /** Matching ids the package-name rule refused. */
  readonly refused: number
  /** Pending names after the merge. */
  readonly pending: number
  /** Carriers per harvest keyword after the merge. */
  readonly carriers: Readonly<Record<string, number>>
}

/** What `searchByKeywords` takes from the feed. */
export interface FeedInput {
  /** Per harvest keyword, each carrier's owner. Empty when the feed is unavailable. */
  readonly carriers: ReadonlyMap<string, ReadonlyMap<string, string | null>>
  /** Rotation seed for `planFeedVerification`: the next state's `seq`. */
  readonly seed: number
  /** Called once per harvest keyword with what the feed step did, BEFORE
   * any throw, so the line reaches the log on the run that needs it. */
  readonly onCoverage?: (coverage: FeedCoverage) => void
}

/** No feed: `searchByKeywords` behaves exactly as it did before the feed existed. */
export const NO_FEED: FeedInput = { carriers: new Map(), seed: 0 }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/feed-state.test.ts
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: PASS, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed add registry/scripts/src/feed-state.ts registry/scripts/tests/feed-state.test.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed commit -q -F - <<'EOF'
feat(registry): one change-feed run's pure logic

Page parsing, selection (filter, held and pending names, last row
wins, the package-name rule refusing at the door), the merge, per-
keyword grouping, and the owner-verification plan rotated by the
cursor. Plus the report, coverage and input types the network
reader and searchByKeywords share.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 3: The network reader

**Files:**
- Create: `registry/scripts/src/npm-feed.ts`
- Create: `registry/scripts/tests/npm-feed.test.ts`
- Modify: `registry/scripts/src/npm-client.ts` (export `readJsonCapped`)
- Modify: `registry/scripts/tests/npm-client.test.ts` (network-module list)
- Modify: `registry/scripts/tests/github-client.test.ts` (`SCANNED_SOURCES`)

**Interfaces:**
- Consumes: Task 2's `applyFeedReads`, `carrierCounts`,
  `classifyManifest`, `parseFeedPage`, `selectFeedIds`, `FeedRead`,
  `FeedRow`, `FeedRunReport` and `FeedState`; and from npm-client.ts,
  `fetchWithRetry(url, fetchImpl, sleep, token): Promise<Response>`,
  `withTimeout(fetchImpl, ms, subject): typeof fetch` and
  `readJsonCapped(response, cap)`.
- Produces:
  - constants `FEED_URL`, `FEED_PAGE_LIMIT`, `FEED_PAGE_BUDGET`,
    `FEED_PAGE_MAX_BYTES`, `FEED_MANIFEST_MAX_BYTES`,
    `FEED_READ_CONCURRENCY`, `FEED_READ_TIME_BUDGET_MS`,
    `FEED_REQUEST_TIMEOUT_MS`
  - `interface FeedHarvest { readonly next: FeedState; readonly report: FeedRunReport }`
  - `interface HarvestFeedOptions { harvestKeywords: readonly string[]; fetchImpl?; sleep?; token?; now?; timeoutMs?; pageBudget?; readBudgetMs? }`
  - `harvestFeed(prior: FeedState, options: HarvestFeedOptions): Promise<FeedHarvest>`

- [ ] **Step 1: Write the failing tests**

Create `registry/scripts/tests/npm-feed.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { FeedState } from '../src/feed-state.ts'
import { FEED_MANIFEST_MAX_BYTES, FEED_PAGE_LIMIT, harvestFeed } from '../src/npm-feed.ts'

const KEYWORDS: readonly string[] = ['dsh-plugin', 'deepseek-harness']
const instant = async (_ms: number): Promise<void> => {}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

type Handler = readonly [match: (url: string) => boolean, respond: () => Response]

/** Routes each request by URL; an unmatched URL is a fixture bug and throws. */
function route(handlers: readonly Handler[]): { fetchImpl: typeof fetch; calls: { url: string; auth: string | null }[] } {
  const calls: { url: string; auth: string | null }[] = []
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, auth: new Headers(init?.headers).get('authorization') })
    for (const [match, respond] of handlers) if (match(url)) return respond()
    throw new Error(`unexpected request ${url}`)
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const isHead = (url: string): boolean => url === 'https://replicate.npmjs.com/registry/'
const isPage = (since: number) => (url: string): boolean =>
  url === `https://replicate.npmjs.com/registry/_changes?since=${since}&limit=${FEED_PAGE_LIMIT}`
const isLatest = (name: string) => (url: string): boolean =>
  url === `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`
const page = (rows: readonly { seq: number; id: string; deleted?: boolean }[], lastSeq: number): Response =>
  json({
    results: rows.map(r => ({ seq: r.seq, id: r.id, changes: [{ rev: '1-a' }], ...(r.deleted === true ? { deleted: true } : {}) })),
    last_seq: lastSeq,
  })
const manifest = (name: string, keywords: readonly string[] = ['dsh-plugin']): Response =>
  json({ name, version: '1.0.0', keywords, maintainers: [{ name: 'alice' }] })
const at = (seq: number, carriers: Record<string, string[]> = {}, pending: string[] = []): FeedState => ({
  seq,
  carriers: new Map(Object.entries(carriers).map(([name, keywords]) => [name, { owner: 'alice', keywords }])),
  pending,
})
const fullPage = (from: number, idAt: (i: number) => string = i => `pkg-${i}`) =>
  Array.from({ length: FEED_PAGE_LIMIT }, (_, i) => ({ seq: from + 1 + i, id: idAt(i) }))

describe('harvestFeed', () => {
  it('reads forward from the cursor to a short page, then reads the manifests it selected', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ db_name: 'registry', update_seq: 300 })],
      [isPage(100), () => page([{ seq: 150, id: 'dsh-a' }, { seq: 160, id: 'react' }], 160)],
      [isLatest('dsh-a'), () => manifest('dsh-a')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.seq).toBe(160)
    expect(next.carriers.get('dsh-a')).toEqual({ owner: 'alice', keywords: ['dsh-plugin'] })
    expect(calls.some(c => c.url.includes('/react/latest'))).toBe(false)
    expect(report).toEqual({
      available: true, note: '', fromSeq: 100, toSeq: 160, pages: 1, selected: 1, read: 1, failed: 0,
      unreached: 0, refused: 0, pending: 0, carriers: { 'dsh-plugin': 1, 'deepseek-harness': 0 },
    })
  })

  it('keeps paging while pages come back full', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 99_999 })],
      [isPage(100), () => page(fullPage(100), 100 + FEED_PAGE_LIMIT)],
      [isPage(100 + FEED_PAGE_LIMIT), () => page([{ seq: 100 + FEED_PAGE_LIMIT + 1, id: 'dsh-last' }], 100 + FEED_PAGE_LIMIT + 1)],
      [isLatest('dsh-last'), () => manifest('dsh-last')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report.pages).toBe(2)
    expect(next.seq).toBe(100 + FEED_PAGE_LIMIT + 1)
    expect(next.carriers.has('dsh-last')).toBe(true)
  })

  it('stops at the page budget, keeping what it read', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 99_999 })],
      [isPage(100), () => page(fullPage(100, i => (i === 0 ? 'dsh-first' : `pkg-${i}`)), 100 + FEED_PAGE_LIMIT)],
      [isLatest('dsh-first'), () => manifest('dsh-first')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, pageBudget: 1 })
    expect(report.note).toBe('stopped at the 1-page budget')
    expect(next.seq).toBe(100 + FEED_PAGE_LIMIT)
    expect(next.carriers.has('dsh-first')).toBe(true)
  })

  it('is unavailable when the head cannot be read, and leaves the state exactly as it was', async () => {
    const prior = at(100, { 'dsh-held': ['dsh-plugin'] })
    const { fetchImpl, calls } = route([[isHead, () => json({ error: 'down' }, 503)]])
    const { next, report } = await harvestFeed(prior, { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next).toBe(prior)
    expect(report).toMatchObject({ available: false, fromSeq: 100, toSeq: 100, pages: 0, selected: 0 })
    expect(report.note).toMatch(/feed head could not be read/)
    expect(calls.some(c => c.url.includes('_changes'))).toBe(false)
  })

  it('is unavailable when the stored cursor is past the head, naming the re-seed', async () => {
    const { fetchImpl } = route([[isHead, () => json({ update_seq: 50 })]])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report.available).toBe(false)
    expect(report.note).toMatch(/cursor 100 is past the feed head 50.*re-seeded/)
  })

  it('is unavailable when the first page has a shape it does not know', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => json({ results: [], last_seq: '160-g1AAAA' })],
    ])
    const { report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report).toMatchObject({ available: false, note: 'the first feed page has an unexpected shape' })
  })

  it('keeps the pages already read when a later page fails', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 99_999 })],
      [isPage(100), () => page(fullPage(100, i => (i === 5 ? 'dsh-early' : `pkg-${i}`)), 100 + FEED_PAGE_LIMIT)],
      [isPage(100 + FEED_PAGE_LIMIT), () => json({}, 500)],
      [isLatest('dsh-early'), () => manifest('dsh-early')],
    ])
    const { next, report } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(report.available).toBe(true)
    expect(report.note).toMatch(/^stopped after 1 page\(s\): /)
    expect(next.seq).toBe(100 + FEED_PAGE_LIMIT)
    expect(next.carriers.has('dsh-early')).toBe(true)
  })

  it('reads a scoped name with its scope and slash encoded', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: '@scope/dsh-x' }], 101)],
      [isLatest('@scope/dsh-x'), () => manifest('@scope/dsh-x')],
    ])
    const { next } = await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(calls.map(c => c.url)).toContain('https://registry.npmjs.org/%40scope%2Fdsh-x/latest')
    expect(next.carriers.has('@scope/dsh-x')).toBe(true)
  })

  it.each([
    ['a 404 removes a held carrier', () => json('Not Found', 404), false, false],
    ['a 403 removes it: an answer about the resource', () => json({}, 403), false, false],
    ['a manifest that is not JSON removes it', () => new Response('<!doctype html>', { status: 200 }), false, false],
    ['a manifest over the cap removes it',
      () => new Response('{}', { status: 200, headers: { 'content-length': String(FEED_MANIFEST_MAX_BYTES + 1) } }), false, false],
    ['a manifest without the keyword removes it', () => manifest('dsh-held', ['tool']), false, false],
    ['a 503 after retries keeps it, pending', () => json({}, 503), true, true],
    ['the manifest of another package keeps it, pending', () => manifest('dsh-other'), true, true],
  ] as const)('%s', async (_what, respond, held, pending) => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-held' }], 101)],
      [isLatest('dsh-held'), respond],
    ])
    const { next } = await harvestFeed(at(100, { 'dsh-held': ['dsh-plugin'] }), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.carriers.has('dsh-held')).toBe(held)
    expect(next.pending.includes('dsh-held')).toBe(pending)
  })

  it('removes a held carrier the feed marks deleted, without a read', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-held', deleted: true }], 101)],
    ])
    const { next } = await harvestFeed(at(100, { 'dsh-held': ['dsh-plugin'] }), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant })
    expect(next.carriers.has('dsh-held')).toBe(false)
    expect(calls.some(c => c.url.endsWith('/latest'))).toBe(false)
  })

  it('leaves what it could not start within the read budget pending, and still advances the cursor', async () => {
    const { fetchImpl } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-a' }, { seq: 102, id: 'dsh-b' }], 102)],
    ])
    const { next, report } = await harvestFeed(at(100), {
      harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, now: () => 0, readBudgetMs: 0,
    })
    expect(report).toMatchObject({ selected: 2, read: 0, unreached: 2, pending: 2 })
    expect(next.pending).toEqual(['dsh-a', 'dsh-b'])
    expect(next.seq).toBe(102)
  })

  it('sends the npm token to the registry and never to the feed host', async () => {
    const { fetchImpl, calls } = route([
      [isHead, () => json({ update_seq: 300 })],
      [isPage(100), () => page([{ seq: 101, id: 'dsh-a' }], 101)],
      [isLatest('dsh-a'), () => manifest('dsh-a')],
    ])
    await harvestFeed(at(100), { harvestKeywords: KEYWORDS, fetchImpl, sleep: instant, token: 'secret' })
    expect(calls.length).toBe(3)
    for (const call of calls) {
      expect(call.auth).toBe(call.url.startsWith('https://registry.npmjs.org/') ? 'Bearer secret' : null)
    }
  })
})
```

Then add the module to both guards.

In `registry/scripts/tests/npm-client.test.ts`, inside
`it('finds the network modules at all, ...')`, after
`expect(files).toContain('github-stars.ts')`, add:

```ts
    expect(files).toContain('npm-feed.ts')
```

and in the assertion message just below it that reads `'npm-client.ts
owns withTimeout and must keep exporting it: the other three network '`,
replace `the other three network ` with `the other network `. The
module count is not this message's to keep.

In `registry/scripts/tests/github-client.test.ts`, change
`SCANNED_SOURCES` to:

```ts
const SCANNED_SOURCES: readonly { file: string; source: string }[] = [
  { file: 'github-client.ts', source: githubClientSource },
  { file: 'npm-client.ts', source: srcOf('npm-client.ts') },
  { file: 'npm-feed.ts', source: srcOf('npm-feed.ts') },
  { file: 'http-body.ts', source: srcOf('http-body.ts') },
]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/npm-feed.test.ts registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts`
Expected: FAIL. `npm-feed.ts` cannot be resolved, the network-module
scan does not find it, and `srcOf('npm-feed.ts')` throws ENOENT.

- [ ] **Step 3: Export `readJsonCapped`**

In `registry/scripts/src/npm-client.ts`, change
`async function readJsonCapped(` to `export async function readJsonCapped(`.
Leave the rest of the function and its comment as they are.

- [ ] **Step 4: Write the module**

Create `registry/scripts/src/npm-feed.ts`:

```ts
/**
 * npm's replication change feed, read FORWARD from the committed cursor,
 * and the `/latest` manifest of every id it selects. Impure: this module
 * reaches the network. Every decision it applies lives in feed-state.ts.
 *
 * Forward only, because the feed offers nothing else: `descending=true`
 * ignores `since`, so a newest-first read can never page back past the
 * newest ~10,000 rows (spec section 2). Every request goes through this
 * repo's `withTimeout` and `fetchWithRetry`, and every body through
 * `readJsonCapped`.
 * Spec: docs/design/2026-10-04-change-feed-harvest.md, section 4.4.
 * @module npm-feed
 */
import {
  applyFeedReads, carrierCounts, classifyManifest, parseFeedPage, selectFeedIds,
  type FeedRead, type FeedRow, type FeedRunReport, type FeedState,
} from './feed-state.ts'
import { fetchWithRetry, readJsonCapped, withTimeout } from './npm-client.ts'

export const FEED_URL = 'https://replicate.npmjs.com/registry'
const REGISTRY = 'https://registry.npmjs.org'

/** The API's maximum: `limit=20000` answers HTTP 400 (measured 2026-10-04). */
export const FEED_PAGE_LIMIT = 10_000

/** Pages one run may read. A catch-up from FEED_BOOTSTRAP_SEQ measured 62; a day, 4. */
export const FEED_PAGE_BUDGET = 200

/** Cap on one head or page body. The largest page measured was 1,078,874 bytes. */
export const FEED_PAGE_MAX_BYTES = 8 * 1024 * 1024

/** Cap on one `/latest` manifest. They average 2.5 KB; github-client caps a package.json at 1 MiB. */
export const FEED_MANIFEST_MAX_BYTES = 1024 * 1024

/** Concurrent manifest reads: 600 at 16 answered 25.8 a second with no 429 (measured 2026-10-04). */
export const FEED_READ_CONCURRENCY = 16

/** Wall-clock budget for one run's manifest reads. The bootstrap's 17,779 take ~11.5 minutes
 * at the measured rate, a day's ~700 about 30 seconds; what is not started becomes pending. */
export const FEED_READ_TIME_BUDGET_MS = 20 * 60_000

/** Per-attempt bound. Matches npm-client's: the same registry host, the same reason. */
export const FEED_REQUEST_TIMEOUT_MS = 30_000

/** One run's result. */
export interface FeedHarvest {
  /** The state to commit; the prior one, unchanged, when the feed is unavailable. */
  readonly next: FeedState
  readonly report: FeedRunReport
}

export interface HarvestFeedOptions {
  readonly harvestKeywords: readonly string[]
  readonly fetchImpl?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
  /** The npm token, sent to the registry's `/latest` reads; the feed host takes none. */
  readonly token?: string
  /** Monotonic clock for the read budget; a seam, so a test can spend twenty minutes in none. */
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly pageBudget?: number
  readonly readBudgetMs?: number
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** GET one JSON body under a cap, or throw a sentence saying why not. */
async function getJson(url: string, timed: typeof fetch, sleep: (ms: number) => Promise<void>, cap: number): Promise<unknown> {
  const response = await fetchWithRetry(url, timed, sleep, undefined)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const body = await readJsonCapped(response, cap)
  if (!body.ok) throw new Error(`${url} answered a body that is ${body.reason === 'too-large' ? `over ${cap} bytes` : 'not JSON'}`)
  return body.value
}

/** Read one `/latest` manifest and say what it established. Never throws. */
async function readLatest(
  name: string,
  timed: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
  harvestKeywords: readonly string[],
): Promise<FeedRead> {
  let response: Response
  try {
    response = await fetchWithRetry(`${REGISTRY}/${encodeURIComponent(name)}/latest`, timed, sleep, token)
  } catch (error) {
    return { kind: 'failed', name, reason: message(error) }
  }
  if (response.status === 404) return { kind: 'gone', name }
  // A 429 or 5xx here is what fetchWithRetry's ladder could not outlast:
  // the server could not answer THIS time, so the name is read again next
  // run. Any other non-2xx is an answer about the resource -- the
  // `no-manifest` side of the line CLAUDE.md draws -- and not a carrier.
  if (response.status === 429 || response.status >= 500) {
    return { kind: 'failed', name, reason: `the registry answered ${response.status}` }
  }
  if (!response.ok) return { kind: 'not-carrier', name }
  let body: Awaited<ReturnType<typeof readJsonCapped>>
  try {
    body = await readJsonCapped(response, FEED_MANIFEST_MAX_BYTES)
  } catch (error) {
    // A deadline that lands mid-body, or a stream that errors: a statement
    // about the transport, not about the manifest, so the name is retried.
    return { kind: 'failed', name, reason: message(error) }
  }
  if (!body.ok) return { kind: 'not-carrier', name }
  return classifyManifest(name, body.value, harvestKeywords)
}

/**
 * Read the feed forward from `prior.seq` and the manifests it selects, and
 * return the next state (spec section 4.4). Never throws for a feed
 * problem: an unreadable head or first page, or a cursor past the head,
 * makes the feed unavailable and returns `prior` unchanged; a later page
 * that fails ends paging with the prefix already read.
 */
export async function harvestFeed(prior: FeedState, options: HarvestFeedOptions): Promise<FeedHarvest> {
  const {
    harvestKeywords, fetchImpl = fetch, sleep = defaultSleep, token,
    // A duration, so a monotonic clock: an NTP step must not expire it.
    now = () => performance.now(),
    timeoutMs = FEED_REQUEST_TIMEOUT_MS, pageBudget = FEED_PAGE_BUDGET, readBudgetMs = FEED_READ_TIME_BUDGET_MS,
  } = options
  const timed = withTimeout(fetchImpl, timeoutMs, 'npm change feed')
  const unavailable = (note: string): FeedHarvest => ({
    next: prior,
    report: {
      available: false, note, fromSeq: prior.seq, toSeq: prior.seq, pages: 0,
      selected: 0, read: 0, failed: 0, unreached: 0, refused: 0,
      pending: prior.pending.length, carriers: carrierCounts(prior, harvestKeywords),
    },
  })

  let head: unknown
  try {
    head = await getJson(`${FEED_URL}/`, timed, sleep, FEED_PAGE_MAX_BYTES)
  } catch (error) {
    return unavailable(`the feed head could not be read: ${message(error)}`)
  }
  const updateSeq = head !== null && typeof head === 'object' ? (head as { update_seq?: unknown }).update_seq : undefined
  if (typeof updateSeq !== 'number' || !Number.isSafeInteger(updateSeq) || updateSeq < 0) {
    return unavailable('the feed head carries no integer update_seq')
  }
  if (prior.seq > updateSeq) {
    return unavailable(`the stored cursor ${prior.seq} is past the feed head ${updateSeq}: the replica was rebuilt or renumbered, so registry/feed-state.json must be re-seeded`)
  }

  const rows: FeedRow[] = []
  let seq = prior.seq
  let pages = 0
  let note = ''
  for (;;) {
    if (pages >= pageBudget) {
      note = `stopped at the ${pageBudget}-page budget`
      break
    }
    let page: ReturnType<typeof parseFeedPage>
    try {
      page = parseFeedPage(await getJson(`${FEED_URL}/_changes?since=${seq}&limit=${FEED_PAGE_LIMIT}`, timed, sleep, FEED_PAGE_MAX_BYTES))
    } catch (error) {
      if (pages === 0) return unavailable(`the first feed page could not be read: ${message(error)}`)
      note = `stopped after ${pages} page(s): ${message(error)}`
      break
    }
    // A page whose cursor goes backwards, or a non-empty one that does not
    // advance it, would re-read forever or apply rows out of order.
    if (page === null || page.lastSeq < seq || (page.rows.length > 0 && page.lastSeq === seq)) {
      if (pages === 0) return unavailable('the first feed page has an unexpected shape')
      note = `stopped after ${pages} page(s): a page has an unexpected shape`
      break
    }
    for (const row of page.rows) rows.push(row)
    pages += 1
    seq = page.lastSeq
    if (page.rows.length < FEED_PAGE_LIMIT) break
  }

  const selection = selectFeedIds(rows, prior)
  const results: FeedRead[] = selection.gone.map((name): FeedRead => ({ kind: 'gone', name }))
  const reads: (FeedRead | undefined)[] = new Array<FeedRead | undefined>(selection.read.length)
  const started = now()
  let claimed = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = claimed
      claimed += 1
      const name = selection.read[index]
      if (name === undefined) return
      reads[index] = now() - started >= readBudgetMs
        ? { kind: 'unreached', name }
        : await readLatest(name, timed, sleep, token, harvestKeywords)
    }
  }
  await Promise.all(Array.from({ length: Math.min(FEED_READ_CONCURRENCY, selection.read.length) }, worker))
  for (const read of reads) if (read !== undefined) results.push(read)

  const next = applyFeedReads(prior, results, seq)
  const count = (kind: FeedRead['kind']): number => results.filter(read => read.kind === kind).length
  return {
    next,
    report: {
      available: true, note, fromSeq: prior.seq, toSeq: seq, pages,
      selected: selection.read.length,
      read: selection.read.length - count('unreached'),
      failed: count('failed'),
      unreached: count('unreached'),
      refused: selection.refused,
      pending: next.pending.length,
      carriers: carrierCounts(next, harvestKeywords),
    },
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/npm-feed.test.ts registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: PASS. The body-read guard finds no uncapped read in
npm-feed.ts, and the deadline guard finds `withTimeout(` and the
`'./npm-client.ts'` import.

- [ ] **Step 6: Commit**

```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed add registry/scripts/src/npm-feed.ts registry/scripts/tests/npm-feed.test.ts registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed commit -q -F - <<'EOF'
feat(registry): read npm's change feed forward from the cursor

npm-feed.ts checks the head, pages _changes forward until a short
page or the page budget, and reads the /latest manifest of every
selected id, 16 at a time within a time budget. An unreadable head or
first page, or a cursor past the head, makes the feed unavailable and
changes nothing; a later page that fails keeps the prefix. Both guards
now scan the new module.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 4: The feed step in `searchByKeywords`

**Files:**
- Modify: `registry/scripts/src/npm-client.ts`
- Modify: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: from feed-state.ts, `FEED_MAX_DISAGREEMENTS`,
  `FEED_VERIFY_OWNERS`, `NO_FEED`,
  `planFeedVerification(feedOnly, ownerOf, budget, seed)`,
  `FeedCoverage` and `FeedInput`.
- Produces: `searchByKeywords` takes an 11th positional parameter,
  `feed: FeedInput = NO_FEED`, and calls `feed.onCoverage` once per
  harvest keyword. `pageCell` now returns `Promise<number>`, the total
  the cell last answered.

- [ ] **Step 1: Write the failing tests**

In `registry/scripts/tests/npm-client.test.ts`, add this import after
the `stalling-fetch.ts` import:

```ts
import { FEED_MAX_DISAGREEMENTS, type FeedCoverage, type FeedInput } from '../src/feed-state.ts'
```

Then insert the block below **inside** `describe('searchByKeywords',
...)`, immediately before the `})` that closes it, which sits just
above `describe('fetchCandidate', () => {`. `stubSearch` is defined in
that block, so the tests must live there to reach it.

```ts
  describe('the change-feed step', () => {
    const ownerQuery = 'keywords:deepseek-harness maintainer:alice'
    /** `total` names under deepseek-harness: the window serves the first
     * SEARCH_WINDOW, the `,dsh` refinement `recovered` of the rest, and
     * alice's cell `ownerServes`, answering `ownerTotal` (default: what it
     * serves). `ownerFails` answers alice's cell with a 503. */
    const feedFixture = (
      total: number, recovered: number, ownerServes: readonly string[] = [], ownerFails = false, ownerTotal?: number,
    ) => {
      const beyond = Array.from({ length: Math.max(0, total - SEARCH_WINDOW) }, (_, i) => `beyond${i}`)
      const window = Array.from({ length: Math.min(total, SEARCH_WINDOW) }, (_, i) => `w${i}`)
      const cell = ['w0', ...beyond.slice(0, recovered)]
      const stub = stubSearch(
        query => (query === 'keywords:deepseek-harness' ? total
          : query === 'keywords:deepseek-harness,dsh' ? cell.length
          : query === ownerQuery ? (ownerTotal ?? ownerServes.length)
          : 0),
        (query, from) => {
          if (query === 'keywords:deepseek-harness') return from > MAX_SEARCH_FROM ? [] : window.slice(from, from + 250)
          if (query === 'keywords:deepseek-harness,dsh') return cell.slice(from, from + 250)
          if (query === ownerQuery) return ownerServes.slice(from, from + 250)
          return []
        },
      )
      const fetchImpl = ownerFails
        ? (async (url: string | URL, init?: RequestInit) => (new URL(String(url)).searchParams.get('text') === ownerQuery
          ? new Response('{}', { status: 503 })
          : stub.fetchImpl(url, init))) as unknown as typeof fetch
        : stub.fetchImpl
      return { fetchImpl, urls: stub.urls, beyond }
    }
    const feedOf = (names: readonly string[], owner: string | null = 'alice', coverage?: FeedCoverage[]): FeedInput => ({
      carriers: new Map([['deepseek-harness', new Map(names.map(name => [name, owner] as const))]]),
      seed: 0,
      ...(coverage === undefined ? {} : { onCoverage: (c: FeedCoverage) => { coverage.push(c) } }),
    })
    const run = (fetchImpl: typeof fetch, feed?: FeedInput, onShortfall?: (s: KeywordShortfall) => void) =>
      searchByKeywords(fetchImpl, async () => {}, undefined, undefined, undefined, onShortfall, undefined, undefined, undefined, undefined, feed)
    const forHarness = (coverage: readonly FeedCoverage[]) => coverage.find(c => c.keyword === 'deepseek-harness')
    // The 2026-10-04 shape at today's cap: 661 names past the window, the
    // cells recover 600, so 61 are missing. 600 / 661 = 0.908 clears the
    // recovery floor, so the cap is what refuses it.
    const overCap = MAX_UNREACHABLE_RESIDUAL + 1
    const tail = Math.ceil(overCap / (1 - MIN_UNREACHABLE_RECOVERY)) + 50
    const total = SEARCH_WINDOW + tail
    const recovered = tail - overCap
    const missing = Array.from({ length: overCap }, (_, i) => `beyond${recovered + i}`)

    it('closes a residual the cap refuses, crediting the names their owner cell serves', async () => {
      expect((tail - overCap) / tail).toBeGreaterThan(MIN_UNREACHABLE_RECOVERY)
      await expect(run(feedFixture(total, recovered, missing).fetchImpl))
        .rejects.toThrow(new RegExp(`a tail shortfall of ${overCap}`))
      const coverage: FeedCoverage[] = []
      const names = await run(feedFixture(total, recovered, missing).fetchImpl, feedOf(missing, 'alice', coverage))
      expect(names).toHaveLength(total)
      expect(names).toContain(missing[0])
      expect(forHarness(coverage)).toEqual({
        keyword: 'deepseek-harness', feedOnly: overCap, supplied: overCap,
        ownersVerified: 1, ownersTotal: 1, verified: overCap, unverified: 0, disagreed: [],
      })
    })

    it('neither lists nor credits a name its owner cell does not serve, and names it', async () => {
      const coverage: FeedCoverage[] = []
      const names = await run(feedFixture(total, recovered, missing).fetchImpl, feedOf([...missing, 'dsh-phantom'], 'alice', coverage))
      expect(names).not.toContain('dsh-phantom')
      expect(forHarness(coverage)).toMatchObject({ feedOnly: overCap + 1, verified: overCap, disagreed: ['dsh-phantom'] })
    })

    it('throws when more names disagree than one run may absorb, after reporting them', async () => {
      const phantoms = Array.from({ length: FEED_MAX_DISAGREEMENTS + 1 }, (_, i) => `dsh-phantom${i}`)
      const coverage: FeedCoverage[] = []
      await expect(run(feedFixture(SEARCH_WINDOW, 0).fetchImpl, feedOf(phantoms, 'alice', coverage)))
        .rejects.toThrow(/membership rule no longer describes npm search/)
      expect(forHarness(coverage)?.disagreed).toEqual(phantoms)
    })

    it('counts the names of an owner whose cell fails as unverified, never as disagreeing', async () => {
      // Review Focus 5.
      const coverage: FeedCoverage[] = []
      const names = await run(feedFixture(total, recovered, missing, true).fetchImpl, feedOf(missing, 'alice', coverage))
      expect(names).toHaveLength(total)
      expect(forHarness(coverage)).toMatchObject({ verified: 0, unverified: overCap, disagreed: [] })
    })

    it('counts the names of an owner whose cell serves short of its total as unverified', async () => {
      // Review Focus 5: the cell answers 61 but serves 60, so it was not
      // paged in full and proves nothing about the 61st.
      const coverage: FeedCoverage[] = []
      await run(feedFixture(total, recovered, missing.slice(1), false, overCap).fetchImpl, feedOf(missing, 'alice', coverage))
      expect(forHarness(coverage)).toMatchObject({ verified: 0, unverified: overCap, disagreed: [] })
    })

    it('changes nothing when the feed holds nothing', async () => {
      const before: KeywordShortfall[] = []
      const after: KeywordShortfall[] = []
      const without = await run(feedFixture(5407, 150).fetchImpl, undefined, s => before.push(s))
      const fixture = feedFixture(5407, 150)
      const withEmpty = await run(fixture.fetchImpl, feedOf([]), s => after.push(s))
      expect(withEmpty).toEqual(without)
      expect(after).toEqual(before)
      expect(fixture.urls.some(url => decodeURIComponent(url).includes('maintainer:'))).toBe(false)
    })

    it('repeats no verification request on the retry pass', async () => {
      // 5407 names, 150 recovered: 7 missing. The feed holds 3 of them, so
      // the keyword is still short after the first pass and enumerates again.
      const held = ['beyond150', 'beyond151', 'beyond152']
      const fixture = feedFixture(5407, 150, held)
      const names = await run(fixture.fetchImpl, feedOf(held))
      expect(names).toContain('beyond152')
      expect(fixture.urls.filter(url => new URL(url).searchParams.get('text') === ownerQuery)).toHaveLength(1)
    })

    it('never counts a carrier an earlier cell already served', async () => {
      const coverage: FeedCoverage[] = []
      await run(feedFixture(5407, 150, ['beyond150']).fetchImpl, feedOf(['w0', 'beyond150'], 'alice', coverage))
      expect(forHarness(coverage)).toMatchObject({ feedOnly: 1, supplied: 1, verified: 1 })
    })

    it('credits a carrier with no owner as unverified, without a request', async () => {
      const fixture = feedFixture(5407, 150)
      const coverage: FeedCoverage[] = []
      const names = await run(fixture.fetchImpl, feedOf(['beyond150'], null, coverage))
      expect(names).toContain('beyond150')
      expect(forHarness(coverage)).toMatchObject({ unverified: 1, ownersTotal: 0 })
      expect(fixture.urls.some(url => decodeURIComponent(url).includes('maintainer:'))).toBe(false)
    })

    it('adds any other name a verification cell serves, counting it as supplied', async () => {
      const coverage: FeedCoverage[] = []
      const names = await run(feedFixture(5407, 150, ['beyond150', 'beyond151']).fetchImpl, feedOf(['beyond150'], 'alice', coverage))
      expect(names).toContain('beyond151')
      expect(forHarness(coverage)).toMatchObject({ feedOnly: 1, supplied: 2, verified: 1 })
    })
  })
```

Arithmetic, recomputed: `MAX_UNREACHABLE_RESIDUAL` is 60, so
`overCap` is 61. `61 / (1 - 0.9)` is 610.0000000000001 in floating
point, so `ceil` gives 611, plus 50 makes `tail` 661, `recovered` 600,
`total` 5,911, and `missing` is `beyond600` to `beyond660`. In the
retry fixture, 5,407 - 5,250 = 157 names are past the window, the cell
recovers `beyond0` to `beyond149`, and the feed holds 3 of the
remaining 7. That leaves 4 missing, which keeps the run short after the
first pass (forcing the retry) but under the cap.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/npm-client.test.ts -t "the change-feed step"`
Expected: FAIL. The feed argument is ignored, so the over-cap fixture
still throws and no coverage record is reported.

- [ ] **Step 3: Import the feed's names into npm-client.ts**

Replace the import Task 1 added:

```ts
import { isDeprecated } from './feed-state.ts'
```

with:

```ts
import { FEED_MAX_DISAGREEMENTS, FEED_VERIFY_OWNERS, isDeprecated, NO_FEED, planFeedVerification, type FeedCoverage, type FeedInput } from './feed-state.ts'
```

- [ ] **Step 4: Make `pageCell` report the total it last answered**

In `pageCell`'s doc comment, after the `@param pastWindow` paragraph,
add:

```ts
   * @returns the total this cell last answered, so a caller can tell a
   *   cell paged in full from one that served short of its own total.
```

Change its signature line `  ): Promise<void> => {` (the one just above
`const query = cellQuery(cell)`) to `  ): Promise<number> => {`. Then
change its two returns:

- `if (pastWindow === 'stop' || answered <= SEARCH_WINDOW) return` becomes `if (pastWindow === 'stop' || answered <= SEARCH_WINDOW) return answered`
- `if (objects.length === 0 || from + objects.length >= cellTotal) return` becomes `if (objects.length === 0 || from + objects.length >= cellTotal) return answered`

Every existing caller awaits `pageCell` and ignores the result, so
nothing else changes.

- [ ] **Step 5: Add the parameter**

After the line `  onPublisherAxis: (report: PublisherAxisReport) => void = () => {},`
in the `searchByKeywords` signature, add:

```ts
  /**
   * The change feed's carriers for this run (spec 2026-10-04, section
   * 4.5): per harvest keyword, each carrier's owner. Credited after the
   * publisher cells, so the axis selects, probes, earns and evicts exactly
   * as before. An empty map -- the default, and what an unavailable feed
   * passes -- is today's harvest exactly.
   */
  feed: FeedInput = NO_FEED,
```

- [ ] **Step 6: Add the feed step, and run it at the end of `enumerate`**

Insert this block immediately before the line
`    const enumerate = async (): Promise<void> => {`:

```ts
    /**
     * The change-feed step (spec 2026-10-04, section 4.5). It runs at the
     * end of every `enumerate` pass, after the window, refinement,
     * oversized and publisher cells, and is memoized like
     * `publisherCells`: the first pass verifies and credits, and a retry
     * pass re-adds what the first credited and repeats no request.
     *
     * A feed-only name -- one the feed holds and no search cell served --
     * is checked by paging its owner's `keywords:K maintainer:U` cell,
     * because crediting a name npm search does not count would cancel a
     * genuinely missing one in `required - forKeyword.size`. `harvested`
     * is withheld from those pages, so at-risk seeding sees what it saw
     * before; their maintainers still reach `onPublishers`, as every
     * search page's do.
     */
    let feedCredited: readonly string[] | undefined
    const runFeedStep = async (): Promise<void> => {
      if (feedCredited !== undefined) {
        for (const name of feedCredited) forKeyword.add(name)
        return
      }
      const ownerOf = feed.carriers.get(keyword) ?? new Map<string, string | null>()
      const feedOnly = [...ownerOf.keys()].filter(name => !forKeyword.has(name))
      const plan = planFeedVerification(feedOnly, ownerOf, FEED_VERIFY_OWNERS, feed.seed)
      const before = forKeyword.size
      const verified: string[] = []
      const unverified: string[] = [...plan.unverified]
      const disagreed: string[] = []
      for (const owner of plan.owners) {
        const served = new Set<string>()
        let complete: boolean
        try {
          const answered = await pageCell({ keywords: [keyword], maintainer: owner }, served, 'stop')
          complete = served.size >= answered
        } catch {
          // A 5xx after retries, a deadline or a malformed page from ONE
          // verification cell. It proves nothing either way about the
          // names the cell would have shown, so they count as unverified
          // (spec section 4.5), never as disagreeing: a registry hiccup must
          // not throw the build. Every other request in this run still
          // throws as it always has.
          complete = false
        }
        // Whatever the cell served is search-served under this keyword, so
        // it belongs to the union whether or not the paging finished.
        for (const name of served) forKeyword.add(name)
        for (const name of plan.namesOf.get(owner) ?? []) {
          if (!complete) unverified.push(name)
          else if (served.has(name)) verified.push(name)
          else disagreed.push(name)
        }
      }
      feedCredited = [...verified, ...unverified].sort(compareStrings)
      for (const name of feedCredited) {
        forKeyword.add(name)
        seen.add(name)
      }
      const coverage: FeedCoverage = {
        keyword,
        feedOnly: feedOnly.length,
        supplied: forKeyword.size - before,
        ownersVerified: plan.owners.length,
        ownersTotal: plan.ownersTotal,
        verified: verified.length,
        unverified: unverified.length,
        disagreed: disagreed.sort(compareStrings),
      }
      feed.onCoverage?.(coverage)
      if (disagreed.length > FEED_MAX_DISAGREEMENTS) {
        throw new Error(`the change feed holds ${disagreed.length} name(s) carrying ${keywordQuery([keyword])} that their owner's search cell does not serve, past the ${FEED_MAX_DISAGREEMENTS} one run may absorb: its membership rule no longer describes npm search, and crediting through it would cancel missing names one for one`)
      }
    }
```

Then, at the end of `enumerate`, change:

```ts
            if (cell.maintainer !== undefined) earned.push(cell.maintainer)
          }
        }
      }
    }
    await enumerate()
```

to:

```ts
            if (cell.maintainer !== undefined) earned.push(cell.maintainer)
          }
        }
      }
      await runFeedStep()
    }
    await enumerate()
```

- [ ] **Step 7: Run the tests to verify they pass**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/npm-client.test.ts
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: PASS for the whole file, the existing `searchByKeywords`
tests unchanged. `tsc` prints nothing.

- [ ] **Step 8: Commit**

```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed add registry/scripts/src/npm-client.ts registry/scripts/tests/npm-client.test.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed commit -q -F - <<'EOF'
feat(registry): credit change-feed carriers after verifying them

searchByKeywords takes the feed's carriers and, at the end of each
enumerate pass, credits the ones no cell served -- after paging up to
FEED_VERIFY_OWNERS of their owners' keywords:K maintainer:U cells. A
name its owner's cell does not serve is neither listed nor credited,
and more than FEED_MAX_DISAGREEMENTS of them throw. A cell that fails
or serves short leaves its names unverified, never disagreeing.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 5: Report lines and handoff parsers

**Files:**
- Modify: `registry/scripts/src/feed-state.ts` (append)
- Modify: `registry/scripts/tests/feed-state.test.ts` (append)

**Interfaces:**
- Consumes: `FeedRunReport`, `FeedCoverage`, `isFeedPackageName`,
  `compareStrings`; `escapeCell(value: string): string` from `emit.ts`.
- Produces:
  - `describeFeedRun(report: FeedRunReport): string`
  - `describeFeedCoverage(coverage: FeedCoverage): string`
  - `parseFeedRunReport(value: unknown, where: string, harvestKeywords: readonly string[]): FeedRunReport`
  - `parseFeedCoverage(value: unknown, where: string, harvestKeywords: readonly string[]): FeedCoverage`

- [ ] **Step 1: Write the failing tests**

Extend the import in `feed-state.test.ts` with `describeFeedCoverage`,
`describeFeedRun`, `parseFeedCoverage`, `parseFeedRunReport`, `type
FeedCoverage` and `type FeedRunReport`, then append:

```ts
const runReport: FeedRunReport = {
  available: true, note: '', fromSeq: 100, toSeq: 160, pages: 1, selected: 3, read: 3, failed: 1,
  unreached: 0, refused: 2, pending: 1, carriers: { 'dsh-plugin': 7, 'deepseek-harness': 5 },
}
const unavailableReport: FeedRunReport = {
  ...runReport, available: false, note: 'the feed head could not be read: x', toSeq: 100, pages: 0,
  selected: 0, read: 0, failed: 0, refused: 0,
}
const coverage: FeedCoverage = {
  keyword: 'deepseek-harness', feedOnly: 16, supplied: 17, ownersVerified: 12, ownersTotal: 12,
  verified: 16, unverified: 0, disagreed: [],
}

describe('describeFeedRun', () => {
  it('states the cursor, the reads and the carriers', () => {
    expect(describeFeedRun(runReport)).toBe(
      'change feed: seq 100 -> 160 (1 page(s)); read 3 of 3 selected (1 failed, 0 not reached, 2 refused); '
        + '1 pending; carriers: deepseek-harness 5, dsh-plugin 7')
  })

  it('says where paging stopped', () => {
    expect(describeFeedRun({ ...runReport, note: 'stopped at the 200-page budget' }))
      .toContain('(1 page(s), stopped at the 200-page budget)')
  })

  it('says nothing was listed or credited when the feed was unavailable', () => {
    expect(describeFeedRun(unavailableReport))
      .toBe('change feed unavailable: the feed head could not be read: x; no feed name was listed or credited')
  })

  it('escapes the note, which can quote a server', () => {
    expect(describeFeedRun({ ...unavailableReport, note: 'a|b\nc' }))
      .toBe('change feed unavailable: a\\|b c; no feed name was listed or credited')
  })
})

describe('describeFeedCoverage', () => {
  it('states what the feed supplied and how much of it was verified', () => {
    expect(describeFeedCoverage(coverage)).toBe('keywords:deepseek-harness feed supplied 17 (owners verified 12 of 12)')
  })

  it('names unverified and disagreeing names, escaped', () => {
    expect(describeFeedCoverage({ ...coverage, verified: 13, unverified: 1, disagreed: ['dsh-a', 'dsh-b'] }))
      .toBe('keywords:deepseek-harness feed supplied 17 (owners verified 12 of 12; 1 unverified; 2 disagreed: dsh-a, dsh-b)')
  })
})

describe('parseFeedRunReport', () => {
  it('round-trips a report', () => {
    expect(parseFeedRunReport(JSON.parse(JSON.stringify(runReport)), 'harvest.json', KEYWORDS)).toEqual(runReport)
    expect(parseFeedRunReport(JSON.parse(JSON.stringify(unavailableReport)), 'harvest.json', KEYWORDS)).toEqual(unavailableReport)
  })

  it.each([
    ['no available flag', { available: undefined }],
    ['a fractional count', { pages: 1.5 }],
    ['a negative count', { failed: -1 }],
    ['no note', { note: 7 }],
    ['a missing keyword count', { carriers: { 'dsh-plugin': 1 } }],
    ['a cursor moving backwards', { toSeq: 99 }],
    ['reads that do not add up', { read: 2 }],
    ['more failures than reads', { failed: 4 }],
    ['an unavailable feed that read pages', { available: false }],
  ])('throws on %s', (_what, patch) => {
    expect(() => parseFeedRunReport({ ...runReport, ...patch }, 'harvest.json', KEYWORDS))
      .toThrow(/harvest\.json: change-feed report/)
  })
})

describe('parseFeedCoverage', () => {
  it('round-trips a record', () => {
    expect(parseFeedCoverage(JSON.parse(JSON.stringify(coverage)), 'harvest.json', KEYWORDS)).toEqual(coverage)
  })

  it.each([
    ['a keyword that is not a harvest keyword', { keyword: 'dsh' }],
    ['parts that do not add up', { verified: 15 }],
    ['more owners verified than held', { ownersVerified: 13 }],
    ['less supplied than credited', { supplied: 15 }],
    ['a disagreed name outside the rule', { disagreed: ['DSH-X'], verified: 15 }],
    ['a disagreed list that is not an array', { disagreed: 'dsh-a' }],
  ])('throws on %s', (_what, patch) => {
    expect(() => parseFeedCoverage({ ...coverage, ...patch }, 'harvest.json', KEYWORDS))
      .toThrow(/harvest\.json: change-feed coverage record/)
  })
})
```

Arithmetic: `runReport` reads 3 with 0 unreached against 3 selected,
so `read: 2` breaks `read + unreached === selected`, and `failed: 4`
exceeds the 3 reads. `coverage` splits its 16 feed-only names as 16
verified, 0 unverified and 0 disagreed. `verified: 15` breaks that sum,
`supplied: 15` falls below the 16 credited, and `ownersVerified: 13`
exceeds the 12 held. The `DSH-X` row keeps the sum at 16 (15 + 0 + 1),
so it fails on the name alone.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/feed-state.test.ts`
Expected: FAIL. The four functions are not exported.

- [ ] **Step 3: Append the implementation**

Add `import { escapeCell } from './emit.ts'` as the first import of
`feed-state.ts`, then append:

```ts
/** One skimmable line for the build report and the CI log (spec section 4.7). */
export function describeFeedRun(report: FeedRunReport): string {
  if (!report.available) {
    return `change feed unavailable: ${escapeCell(report.note)}; no feed name was listed or credited`
  }
  const carriers = Object.keys(report.carriers).sort(compareStrings)
    .map(keyword => `${escapeCell(keyword)} ${report.carriers[keyword] ?? 0}`)
    .join(', ')
  const stopped = report.note === '' ? '' : `, ${escapeCell(report.note)}`
  return `change feed: seq ${report.fromSeq} -> ${report.toSeq} (${report.pages} page(s)${stopped}); `
    + `read ${report.read} of ${report.selected} selected (${report.failed} failed, ${report.unreached} not reached, `
    + `${report.refused} refused); ${report.pending} pending; carriers: ${carriers}`
}

/** One line per keyword, beside the publisher-axis line (spec section 4.7). */
export function describeFeedCoverage(coverage: FeedCoverage): string {
  const parts = [`owners verified ${coverage.ownersVerified} of ${coverage.ownersTotal}`]
  if (coverage.unverified > 0) parts.push(`${coverage.unverified} unverified`)
  if (coverage.disagreed.length > 0) {
    parts.push(`${coverage.disagreed.length} disagreed: ${coverage.disagreed.map(escapeCell).join(', ')}`)
  }
  return `keywords:${escapeCell(coverage.keyword)} feed supplied ${coverage.supplied} (${parts.join('; ')})`
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Read a run report back off a `--harvest-from` handoff. Every field is
 * interpolated into a PUBLISHED build report, so a record that does not
 * carry it -- or carries a contradiction -- throws, as
 * `parseKeywordShortfall` does.
 */
export function parseFeedRunReport(value: unknown, where: string, harvestKeywords: readonly string[]): FeedRunReport {
  const fail = (what: string): never => {
    throw new Error(`${where}: change-feed report ${what}; re-run the harvest that wrote it`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('is not an object')
  const r = value as Record<string, unknown>
  const count = (field: string): number => {
    const n = r[field]
    return isCount(n) ? n : fail(`has no integer \`${field}\``)
  }
  const available = r.available
  if (typeof available !== 'boolean') return fail('has no boolean `available`')
  const note = r.note
  if (typeof note !== 'string') return fail('has no string `note`')
  const rawCarriers = r.carriers
  if (rawCarriers === null || typeof rawCarriers !== 'object' || Array.isArray(rawCarriers)) return fail('has no `carriers` object')
  const carriers: Record<string, number> = {}
  for (const keyword of harvestKeywords) {
    const n = (rawCarriers as Record<string, unknown>)[keyword]
    carriers[keyword] = isCount(n) ? n : fail(`has no carrier count for \`${keyword}\``)
  }
  const report: FeedRunReport = {
    available, note,
    fromSeq: count('fromSeq'), toSeq: count('toSeq'), pages: count('pages'),
    selected: count('selected'), read: count('read'), failed: count('failed'),
    unreached: count('unreached'), refused: count('refused'), pending: count('pending'),
    carriers,
  }
  if (report.toSeq < report.fromSeq) return fail(`moves the cursor backwards (${report.fromSeq} -> ${report.toSeq})`)
  if (report.read + report.unreached !== report.selected) return fail('counts reads that do not add up to what it selected')
  if (report.failed > report.read) return fail('reports more failed reads than reads')
  if (!report.available && (report.pages > 0 || report.selected > 0 || report.toSeq !== report.fromSeq)) {
    return fail('reports reading a feed it calls unavailable')
  }
  return report
}

/** Read one coverage record back off a `--harvest-from` handoff; see `parseFeedRunReport`. */
export function parseFeedCoverage(value: unknown, where: string, harvestKeywords: readonly string[]): FeedCoverage {
  const fail = (what: string): never => {
    throw new Error(`${where}: change-feed coverage record ${what}; re-run the harvest that wrote it`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail('is not an object')
  const c = value as Record<string, unknown>
  const count = (field: string): number => {
    const n = c[field]
    return isCount(n) ? n : fail(`has no integer \`${field}\``)
  }
  const keyword = c.keyword
  if (typeof keyword !== 'string' || !harvestKeywords.includes(keyword)) return fail('has no harvest `keyword`')
  const rawDisagreed = c.disagreed
  if (!Array.isArray(rawDisagreed)) return fail('has no `disagreed` array')
  const disagreed: string[] = []
  for (const name of rawDisagreed as unknown[]) {
    if (!isFeedPackageName(name)) return fail('names a disagreeing package outside the package-name rule')
    disagreed.push(name)
  }
  const coverage: FeedCoverage = {
    keyword,
    feedOnly: count('feedOnly'), supplied: count('supplied'),
    ownersVerified: count('ownersVerified'), ownersTotal: count('ownersTotal'),
    verified: count('verified'), unverified: count('unverified'),
    disagreed,
  }
  if (coverage.verified + coverage.unverified + coverage.disagreed.length !== coverage.feedOnly) {
    return fail('splits its feed-only names into parts that do not add up')
  }
  if (coverage.ownersVerified > coverage.ownersTotal) return fail('verified more owners than it holds')
  if (coverage.supplied < coverage.verified + coverage.unverified) return fail('supplied fewer names than it credited')
  return coverage
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/feed-state.test.ts
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: PASS, and `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed add registry/scripts/src/feed-state.ts registry/scripts/tests/feed-state.test.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed commit -q -F - <<'EOF'
feat(registry): change-feed report lines and handoff parsers

One run line and one line per keyword for the build report, every
npm-sourced string escaped; and strict parsers for both records, so
build.ts never publishes a field a handoff did not carry or a count
that contradicts another.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 6: Wire the harvest through classify.ts, build.ts and daily.yml

**Files:**
- Modify: `registry/scripts/src/classify.ts`
- Modify: `registry/scripts/src/build.ts`
- Modify: `.github/workflows/daily.yml` (the "Commit the snapshot"
  `git add`)
- Modify: `registry/scripts/tests/workflow.test.ts`
- Modify: `registry/scripts/tests/repo-guards.test.ts`
- Modify: `registry/scripts/tests/publisher-handoff.test.ts`

**Interfaces:**
- Consumes: `harvestFeed` (Task 3); `bootstrapFeedState`,
  `parseFeedState`, `serializeFeedState` and `feedCarriersByKeyword`
  (Tasks 1 and 2); `describeFeedRun`, `describeFeedCoverage`,
  `parseFeedRunReport` and `parseFeedCoverage` (Task 5); the
  `searchByKeywords` `feed` parameter (Task 4).
- Produces: the handoff `dist/harvest.json` carries
  `feed: { state: string, report: FeedRunReport, coverage: FeedCoverage[] }`,
  where `state` is `serializeFeedState`'s exact text. `build.ts` writes
  `registry/feed-state.json` after the pipeline. The build report gains
  a `change feed (npm, by publication time):` section.

- [ ] **Step 1: Write the failing tests**

In `registry/scripts/tests/workflow.test.ts`:

1. Change the expected `registryWrites(buildTs)` list to:

```ts
      .toEqual(['feed-state.json', 'first-seen.yml', 'publisher-state.json', 'repo-state.json', 'snapshots/manifest.lock'])
```

2. Append this entry to `EXCUSED_REGISTRY_DIR_USES`, after the
   `publisher-state.json` one:

```ts
  {
    module: 'classify.ts',
    snippet: "const feedStatePath = join(REGISTRY_DIR, 'feed-state.json')",
    reason: 'classify.ts only reads feed-state.json, to run the change feed; it carries '
      + 'the next state in dist/harvest.json instead, and build.ts is the sole writer, '
      + 'already covered by its own check above',
  },
```

In `registry/scripts/tests/repo-guards.test.ts`, replace

```ts
    expect(read('registry/scripts/src/classify.ts'))
      .toContain('JSON.stringify({ candidates, rejections, shortfalls, publishers, publisherAxis: axis })')
```

with

```ts
    expect(read('registry/scripts/src/classify.ts'))
      .toContain('JSON.stringify({ candidates, rejections, shortfalls, publishers, publisherAxis: axis, feed: { state: serializeFeedState(feedRun.next), report: feedRun.report, coverage: feedCoverage } })')
    // The change feed's next state rides the same handoff: build.ts is the
    // only writer of registry/feed-state.json, and CI never runs its search.
    expect(read('registry/scripts/src/build.ts')).toContain('parsed.feed')
```

In `registry/scripts/tests/publisher-handoff.test.ts`, append:

```ts
describe('the change feed rides the handoff into the committed file', () => {
  const feedState = (seq: number): string =>
    `{\n  "seq": ${seq},\n  "carriers": {\n    "dsh-feedonly": {"owner":"alice","keywords":["dsh-plugin"]}\n  },\n  "pending": []\n}\n`
  const feedReport = {
    available: true, note: '', fromSeq: 117350000, toSeq: 117350001, pages: 1, selected: 1, read: 1, failed: 0,
    unreached: 0, refused: 0, pending: 0, carriers: { 'dsh-plugin': 1, 'deepseek-harness': 0 },
  }

  it('classify.ts reads the feed, credits a verified name, and hands the next state on', () => {
    const cwd = newWorkspace()
    try {
      // Specific before general, because the first match wins: the head
      // URL is a prefix of the page URL, a package's /latest URL contains
      // its packument URL, and alice's cell URL contains `from=0`.
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'replicate.npmjs.com/registry/_changes',
          body: { results: [{ seq: 117350001, id: 'dsh-feedonly', changes: [{ rev: '1-a' }] }], last_seq: 117350001 } },
        { contains: 'replicate.npmjs.com/registry/', body: { db_name: 'registry', update_seq: 117350001 } },
        { contains: '/dsh-feedonly/latest',
          body: { name: 'dsh-feedonly', version: '1.0.0', keywords: ['dsh-plugin'], maintainers: [{ name: 'alice' }] } },
        { contains: 'maintainer%3Aalice', body: searchPage(1, ['dsh-feedonly'], ['alice']) },
        { contains: 'size=1', body: { total: 2, objects: [] } },
        { contains: 'from=0', body: searchPage(2, ['dsh-a'], ['bob']) },
        { contains: '/-/v1/search', body: { total: 2, objects: [] } },
        { contains: '/dsh-feedonly', body: packument('dsh-feedonly') },
        { contains: '/dsh-a', body: packument('dsh-a') },
      ])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'harvest.json'), 'utf8')) as {
        candidates: { name: string }[]; rejections: { name: string }[]
        feed: { state: string; coverage: { keyword: string; verified: number }[] }
      }
      expect([...handoff.candidates, ...handoff.rejections].map(c => c.name)).toContain('dsh-feedonly')
      expect(handoff.feed.state).toBe(feedState(117350001))
      expect(handoff.feed.coverage.find(c => c.keyword === 'dsh-plugin')?.verified).toBe(1)
      expect(existsSync(join(cwd, 'registry', 'feed-state.json'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts --harvest-from writes the handed-off state, and makes no request for it', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
        feed: { state: feedState(117350001), report: feedReport, coverage: [] },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(readFileSync(join(cwd, 'registry', 'feed-state.json'), 'utf8')).toBe(feedState(117350001))
      expect(readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')).toContain('change feed: seq 117350000 -> 117350001')
      expect(run.urls).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts refuses a handed-off state behind the committed file', () => {
    // Review Focus 4.
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'feed-state.json'), feedState(117350005))
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
        feed: { state: feedState(117350001), report: feedReport, coverage: [] },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('would move the cursor backwards')
      expect(readFileSync(join(cwd, 'registry', 'feed-state.json'), 'utf8')).toBe(feedState(117350005))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts leaves the committed file alone when the handoff carries no feed record', () => {
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'feed-state.json'), feedState(117350005))
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(readFileSync(join(cwd, 'registry', 'feed-state.json'), 'utf8')).toBe(feedState(117350005))
      expect(readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')).toContain('no change-feed record in this handoff')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
```

Fixture notes, checked against the code:
- The workspace holds no `feed-state.json`, so classify.ts starts from
  `FEED_BOOTSTRAP_SEQ` = 117,350,000. The page URL is therefore
  `_changes?since=117350000&limit=10000`, which the first rule
  answers. Its one row is a short page.
- `keywords:dsh-plugin` totals 2 and its window serves only `dsh-a`.
  The feed step then pages alice's cell, verifies `dsh-feedonly`,
  credits it, and the keyword enumerates 2 of 2.
- `keywords:deepseek-harness` also totals 2 and serves only `dsh-a`. No
  feed carrier carries it, so it ends one name short. That is under
  `MAX_SEARCH_SHORTFALL` and is reported, not thrown.
- `fromSeq` 117,350,000 to `toSeq` 117,350,001 in `feedReport` passes
  the parser's checks: 1 read plus 0 unreached equals 1 selected.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed exec vitest run registry/scripts/tests/workflow.test.ts registry/scripts/tests/repo-guards.test.ts registry/scripts/tests/publisher-handoff.test.ts`
Expected: FAIL. build.ts writes no `feed-state.json` yet, the excuse
matches no line, classify.ts's handoff text has no `feed`, and the four
handoff tests fail.

- [ ] **Step 3: Wire classify.ts**

Add `HARVEST_KEYWORDS` to the existing `./npm-client.ts` import. Then
add these imports in alphabetical position: the first after the
`./emit.ts` import, the second after `./npm-client.ts`.

```ts
import { bootstrapFeedState, describeFeedCoverage, describeFeedRun, feedCarriersByKeyword, parseFeedState, serializeFeedState, type FeedCoverage, type FeedInput } from './feed-state.ts'
import { harvestFeed } from './npm-feed.ts'
```

Immediately before `  const names = await searchByKeywords(`, insert:

```ts
  // The change feed (spec 2026-10-04), read BEFORE the search: the feed
  // step inside searchByKeywords credits its carriers before `required` is
  // measured. Read-only here for the reason publisher-state.json is: build.ts
  // owns the file and runs after this step, so the next state rides the
  // handoff instead. An unavailable feed credits nothing, which is today's
  // harvest exactly.
  const feedStatePath = join(REGISTRY_DIR, 'feed-state.json')
  const priorFeed = existsSync(feedStatePath)
    ? parseFeedState(readFileSync(feedStatePath, 'utf8'), HARVEST_KEYWORDS)
    : bootstrapFeedState()
  const feedRun = await harvestFeed(priorFeed, { harvestKeywords: HARVEST_KEYWORDS, token: npmToken })
  process.stderr.write(`classify: ${describeFeedRun(feedRun.report)}\n`)
  const feedCoverage: FeedCoverage[] = []
  const feedInput: FeedInput = {
    carriers: feedRun.report.available ? feedCarriersByKeyword(feedRun.next, HARVEST_KEYWORDS) : new Map(),
    seed: feedRun.next.seq,
    onCoverage: coverage => {
      feedCoverage.push(coverage)
      process.stderr.write(`classify: ${describeFeedCoverage(coverage)}\n`)
    },
  }
```

In the `searchByKeywords(` call, add `feedInput,` as the last
argument, after the `report => { axis.push(report); ... }` line. Then
change the handoff write to:

```ts
  writeFileSync(join(DIST_DIR, 'harvest.json'),
    `${JSON.stringify({ candidates, rejections, shortfalls, publishers, publisherAxis: axis, feed: { state: serializeFeedState(feedRun.next), report: feedRun.report, coverage: feedCoverage } })}\n`)
```

- [ ] **Step 4: Wire build.ts**

Add these imports in alphabetical position, the first after the
`./config.ts` import and the second after the `./npm-client.ts` import:

```ts
import { bootstrapFeedState, describeFeedCoverage, describeFeedRun, feedCarriersByKeyword, parseFeedCoverage, parseFeedRunReport, parseFeedState, serializeFeedState, type FeedInput, type FeedState } from './feed-state.ts'
import { harvestFeed } from './npm-feed.ts'
```

Immediately after the `const sawPublishers = new Set<string>()` line,
insert:

```ts
  // The change feed's committed state (spec 2026-10-04, section 4.8). This
  // module is its only writer, after the pipeline, beside
  // publisher-state.json.
  const feedStatePath = join(REGISTRY_DIR, 'feed-state.json')
  const priorFeed = existsSync(feedStatePath)
    ? parseFeedState(readFileSync(feedStatePath, 'utf8'), HARVEST_KEYWORDS)
    : bootstrapFeedState()
  let nextFeed: FeedState | undefined
  const feedParts: string[] = []
```

In the local branch (`if (harvestFrom === undefined) {`), immediately
before `    const shortfalls: KeywordShortfall[] = []`, insert:

```ts
    const feedRun = await harvestFeed(priorFeed, { harvestKeywords: HARVEST_KEYWORDS, token: npmToken })
    nextFeed = feedRun.next
    feedParts.push(describeFeedRun(feedRun.report))
    const feedInput: FeedInput = {
      carriers: feedRun.report.available ? feedCarriersByKeyword(feedRun.next, HARVEST_KEYWORDS) : new Map(),
      seed: feedRun.next.seq,
      onCoverage: coverage => { feedParts.push(describeFeedCoverage(coverage)) },
    }
```

and add `feedInput,` as the last argument of that branch's
`searchByKeywords(` call, after `report => axis.push(report),`.

In the handoff branch, add `feed?: unknown` to the type of `parsed`, so
the cast reads
`candidates?: unknown; rejections?: unknown; shortfalls?: unknown; publishers?: unknown` /
`publisherAxis?: unknown; feed?: unknown`. Then, right after the
`if (parsed.publisherAxis !== undefined) { ... }` block, insert:

```ts
    if (parsed.feed === undefined) {
      feedParts.push('no change-feed record in this handoff: registry/feed-state.json was left as it was')
    } else {
      const feed = parsed.feed as { state?: unknown; report?: unknown; coverage?: unknown } | null
      if (feed === null || typeof feed !== 'object' || typeof feed.state !== 'string' || !Array.isArray(feed.coverage)) {
        throw new Error(`--harvest-from ${harvestFrom}: expected \`feed\` to carry a serialized \`state\`, a \`report\` and a \`coverage\` array`)
      }
      const state = parseFeedState(feed.state, HARVEST_KEYWORDS)
      // Review Focus 4: an older handoff would move the cursor backwards,
      // and a carrier learned since would be un-learned until it changed.
      if (state.seq < priorFeed.seq) {
        throw new Error(`--harvest-from ${harvestFrom}: its change-feed state is at seq ${state.seq}, behind the committed ${priorFeed.seq}; writing it would move the cursor backwards`)
      }
      nextFeed = state
      feedParts.push(describeFeedRun(parseFeedRunReport(feed.report, `--harvest-from ${harvestFrom}`, HARVEST_KEYWORDS)))
      for (const raw of feed.coverage as unknown[]) {
        feedParts.push(describeFeedCoverage(parseFeedCoverage(raw, `--harvest-from ${harvestFrom}`, HARVEST_KEYWORDS)))
      }
    }
```

Immediately after
`  writeFileSync(publisherStatePath, serializePublisherState(nextPublishers))`,
insert:

```ts
  if (nextFeed !== undefined) writeFileSync(feedStatePath, serializeFeedState(nextFeed))
  for (const part of feedParts) process.stderr.write(`npm: ${part}\n`)
```

Replace the report write:

```ts
  writeFileSync(join(OUT_DIR, 'report.md'), `${artifacts.report}\nStars: ${starsNote}\n${npmLine}${axisLine}${repoLine}`)
```

with:

```ts
  const feedLine = feedParts.length === 0 ? '' : `\nchange feed (npm, by publication time):\n${feedParts.map(part => `- ${part}\n`).join('')}`
  writeFileSync(join(OUT_DIR, 'report.md'), `${artifacts.report}\nStars: ${starsNote}\n${npmLine}${axisLine}${feedLine}${repoLine}`)
```

- [ ] **Step 5: Stage the file in the daily workflow**

In `.github/workflows/daily.yml`, in the "Commit the snapshot" step,
change

```yaml
          git add registry/snapshots/manifest.lock registry/repo-state.json registry/first-seen.yml registry/publisher-state.json
```

to

```yaml
          git add registry/snapshots/manifest.lock registry/repo-state.json registry/first-seen.yml registry/publisher-state.json registry/feed-state.json
```

On every CI run the handoff carries a feed record, because classify.ts
always writes one. So build.ts always writes the file, and `git add`
always finds it, even on a run whose feed was unavailable. That run
writes the unchanged prior state, or the bootstrap state on the very
first run.

- [ ] **Step 6: Run the whole suite**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed test
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: everything passes. The existing classify.ts subprocess tests
have no feed rule, so `preload-fetch` throws on the head request, the
feed reports "unavailable", and the runs behave exactly as before.
`tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed add registry/scripts/src/classify.ts registry/scripts/src/build.ts .github/workflows/daily.yml registry/scripts/tests/workflow.test.ts registry/scripts/tests/repo-guards.test.ts registry/scripts/tests/publisher-handoff.test.ts
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed commit -q -F - <<'EOF'
feat(registry): run the change feed in the daily harvest

classify.ts reads registry/feed-state.json, runs the feed before the
search and passes its carriers in; the next state, the run report and
the per-keyword coverage ride dist/harvest.json. build.ts parses them
strictly, refuses a state behind the committed file, writes it after
the pipeline and adds a change-feed section to the build report.
daily.yml commits the file with the rest of the snapshot.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 7: Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/design/2026-10-04-change-feed-harvest.md` (section 4.5)
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md`
- Modify: `docs/design/2026-09-17-publisher-pinning.md` (section 8)
- Modify: `docs/plans/2026-09-08-publisher-partition.md`
- Modify: `docs/plans/2026-08-18-remaining-work.md` (item 5)

**Interfaces:** none; prose only. Two tests pin docs and must stay
green: `CLAUDE.md` must keep `` `MAX_UNREACHABLE_RESIDUAL` (60) ``, and
the 2026-08-18 design doc must keep `a residual of at most 60 names`.

- [ ] **Step 1: CLAUDE.md**

1. Layout: after the line `  markets.yml      Competing-market verdicts. The one review file that IS populated`, add
   `  feed-state.json  The change feed's cursor and carriers, committed daily`.
2. The pure list `- Pure: \`gate.ts\`, \`tier.ts\`, ...` gains
   `` `feed-state.ts` `` after `` `release-asset.ts` ``.
3. The impure list `- Impure: \`npm-client.ts\`, \`github-client.ts\`, \`llm-client.ts\`, and \`github-stars.ts\` (the only modules that reach the network)` becomes
   `- Impure: \`npm-client.ts\`, \`npm-feed.ts\`, \`github-client.ts\`, \`llm-client.ts\`, and \`github-stars.ts\` (the only modules that reach the network)`;
   the rest of that line is unchanged.
4. Replace the invariant line
   `- **Harvest by keyword, never by name pattern.** A name pattern is trivially spoofed.`
   with:

```markdown
- **Admit by keyword, never by name pattern.** A name pattern is
  trivially spoofed, so it never decides membership. The change feed
  uses one only to choose which manifests to read: every name it
  supplies is admitted by the exact keyword in its manifest, so the
  pattern can cause a miss but never a listing.
```

5. In the "Failing loudly" section, after the paragraph that begins
   `  **Count/paging noise has one per-keyword allowance.**`, add:

```markdown
  **The change feed credits the residue no query can reach**
  (`docs/design/2026-10-04-change-feed-harvest.md`). npm's replication
  feed is read forward from the cursor in `registry/feed-state.json`;
  ids matching `FEED_NAME_PATTERN` have their `/latest` manifest read,
  and a package whose latest version lists a harvest keyword exactly
  and is not deprecated is held as a carrier. Carriers no search cell
  served are credited only after their owner's `keywords:K
  maintainer:U` cell serves them, for up to `FEED_VERIFY_OWNERS` owners
  a run, and more than `FEED_MAX_DISAGREEMENTS` disagreements throw,
  because a credited name npm does not count cancels a missing one. An
  unavailable feed is today's search-only harvest. The cap stays at 60
  until two `main` runs have published with the feed; lowering it is
  its own change.
```

6. In the `build:catalog` paragraph under "Commands", after its first
   sentence, add:
   `The change feed adds one head request, about four feed pages and ~700 \`/latest\` manifests a day; a bootstrap from \`FEED_BOOTSTRAP_SEQ\` reads 62 pages and ~17,800 manifests once.`

- [ ] **Step 2: The spec, section 4.5**

After the sentence ending `the feed only fills what the axis left.`, add:

```markdown
Verification pages are search pages, so the maintainers they carry join
the publisher vocabulary as every page's do; at-risk seeding does not
see them, because they are paged without `harvested`.
```

- [ ] **Step 3: Notes in the older documents**

1. `docs/design/2026-08-18-dsh-plugin-shop-design.md`: after the
   bullet that begins
   `- **No design document survives on the replica, so no server-side view is available at all.**`,
   add:

```markdown
- **Amendment (2026-10-04): the replication feed, priced in its
  filtered form.** The price above is the COMPLETE form, one document
  read per change, and it holds: one day of feed is ~34,000 changed
  packages, ~22-27 minutes of `/latest` reads. Filtering ids by name
  before reading cuts that to ~700 reads a day at 95-96% recall, and
  against the 2026-10-04 build the filtered feed accounted for 26 of 28
  and 26 of 25 residual names. Built as
  `docs/design/2026-10-04-change-feed-harvest.md`; the complete form
  stays an upgrade, priced there.
```

2. `docs/design/2026-09-17-publisher-pinning.md`: after the line
   `  follow-up.` that ends the `- **A covering harvest.**` bullet in
   section 8, add:

```markdown
  Amended 2026-10-04: the feed is now read in its filtered form, which
  is not covering either -- it misses names without the filter words --
  but reaches the residue this axis cannot; see
  `2026-10-04-change-feed-harvest.md`.
```

3. `docs/plans/2026-09-08-publisher-partition.md`: after the bullet
   that begins `- **It does not pursue the replication feed.**`, add:

```markdown
  -> Pursued 2026-10-04 in its filtered form:
  `docs/design/2026-10-04-change-feed-harvest.md`.
```

4. `docs/plans/2026-08-18-remaining-work.md`: immediately before the
   line that begins `6. **dsh 0.1.7`, add:

```markdown
   -> Amended 2026-10-04: the fourth option above, the
   `replicate.npmjs.com` feed, is built in its filtered form
   (`docs/design/2026-10-04-change-feed-harvest.md`).
   `MAX_UNREACHABLE_RESIDUAL` stays 60 until two `main` runs publish
   with it.
```

- [ ] **Step 4: Check the docs**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed test
grep -c -P '[^\x00-\x7F]' /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed/docs/design/2026-10-04-change-feed-harvest.md
```
Expected: everything passes, including the two doc pins. The grep
prints `0`. Then read each edited paragraph once in place and confirm
it sits where the step said.

- [ ] **Step 5: Commit**

```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed add CLAUDE.md docs/design/2026-10-04-change-feed-harvest.md docs/design/2026-08-18-dsh-plugin-shop-design.md docs/design/2026-09-17-publisher-pinning.md docs/plans/2026-09-08-publisher-partition.md docs/plans/2026-08-18-remaining-work.md
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed commit -q -F - <<'EOF'
docs: the change feed in CLAUDE.md and the older designs

"Harvest by keyword" becomes "Admit by keyword": the feed's name
pattern only chooses what to read. CLAUDE.md lists the two new
modules and the state file and says how the feed is credited; the
documents that priced or deferred the replication feed point at the
spec that built it.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
```

---

### Task 8: Verify, open the PR, accept on the dry run

**Files:** none changed.

- [ ] **Step 1: The whole suite, typecheck, and a live smoke**

Run:
```bash
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed test
pnpm --dir /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed typecheck
```
Expected: every test passes; the count is Step 0's plus the new
tests. `tsc` prints nothing.

Then a live smoke against the real feed: one day of rows, about 700
manifests, about a minute. Write
`/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/.scratch-dsh-cell/feed-smoke.ts`
(git-ignored, never committed):

```ts
import { describeFeedRun } from '../feat+change-feed/registry/scripts/src/feed-state.ts'
import { harvestFeed } from '../feat+change-feed/registry/scripts/src/npm-feed.ts'

const head = (await (await fetch('https://replicate.npmjs.com/registry/')).json()) as { update_seq: number }
const { next, report } = await harvestFeed(
  { seq: head.update_seq - 165_000, carriers: new Map(), pending: [] },
  { harvestKeywords: ['dsh-plugin', 'deepseek-harness'] },
)
console.log(describeFeedRun(report))
console.log('sample carriers:', [...next.carriers.keys()].slice(0, 5))
```

Run: `node --experimental-strip-types /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/.scratch-dsh-cell/feed-smoke.ts`
Expected: one `change feed: seq A -> B (4 page(s)) ...` line, with
`B - A` near 165,000, a few hundred names read, `carriers` in the
hundreds for each keyword, and dsh-named sample carriers. Anything
else is a defect to fix before pushing.

- [ ] **Step 2: Push and open the PR**

Run:
```bash
/usr/bin/git -C /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/feat+change-feed push -u origin feat/change-feed
```

Then write the PR body to
`/Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/.scratch-dsh-cell/pr-feed-body.md`
with three sections:

- **Summary:** the problem in two sentences; what the feed does; the
  10-04 measurement (26/26 of 28/25); and what stays unchanged (the
  cap at 60, the publisher axis).
- **Test plan:** the suite count and typecheck, the smoke line, and
  this acceptance list for the dry run:
  - classify's log shows a `change feed: seq 117350000 -> ...` line and
    a `feed supplied` line for each keyword;
  - no disagreement throw;
  - both residuals are 5 or under;
  - the build job finishes inside `timeout-minutes`;
  - the report diff against the live report shows the channel moves
    and nothing else.
- **Footer:** the line `Generated with [Claude Code](https://claude.com/claude-code)`.

Run:
```bash
gh pr create --repo LivXue/dsh-plugin-shop --base main --head feat/change-feed --title "feat(registry): harvest the residue from npm's change feed" --body-file /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/.scratch-dsh-cell/pr-feed-body.md
```

- [ ] **Step 3: Watch the dry run, then hand over**

Poll the PR's catalog run until it completes. In-progress job logs
answer 404, so poll step status, not logs. Then read classify's step
log and the build report artifact against the acceptance list. Report
each item to LivXue with its measured value. The squash merge
(`--match-head-commit`, explicit subject, curated body with the
trailer) waits for LivXue's word.

---

## Self-review notes

- **Spec coverage:**
  - Section 4.1's components are Tasks 1-3 and 6.
  - Section 4.2 is Task 1, plus Task 2's admission rule.
  - Section 4.3 is Task 1.
  - Section 4.4's steps 1-6 are Tasks 2 and 3.
  - Section 4.5 is Task 4, and Task 7 for the vocabulary note.
  - Section 4.6's rows are Task 3 (head, pages, manifests), Task 4
    (disagreements) and the existing gate (deprecated after the read).
  - Section 4.7 is Task 5, plus the build-report section in Task 6.
  - Section 4.8 is Task 6.
  - Section 4.9's constants are Tasks 1 and 3.
  - Section 5 is Task 7.
  - Section 7 is spread across Tasks 1-6.
  - Section 8 is Task 8.
- **Names used across tasks:** `FeedInput.carriers`, `seed` and
  `onCoverage`; `harvestFeed(prior, { harvestKeywords, ... })`;
  `feedCarriersByKeyword`; `serializeFeedState`; `parseFeedState(raw,
  harvestKeywords)`; and `pageCell` returning `Promise<number>`.
