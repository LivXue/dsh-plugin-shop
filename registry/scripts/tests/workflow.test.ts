/** The daily workflow's commit steps, read as data.
 *
 * `build.ts` writes four files back into the repository and a bot commits
 * them. `registry/first-seen.yml` was written every build (build.ts) and never
 * added (daily.yml), so every name absent from the committed file was stamped
 * `added: <today>` again the next day: on 2026-09-03 the live catalog had
 * 4,842 of 9,422 entries carrying `added: "2026-09-03"`, 3,197 entries
 * differed from the previous build in `added` ALONE, the content hash churned
 * daily for packages whose content had not changed, publish-catalog's
 * "unchanged, skip" path could never fire (six catalog versions published in
 * one day), and `added` was fiction for half the shelf. That is the `builtAt`
 * invariant broken through a side door.
 *
 * These tests exist so the NEXT such file cannot be forgotten: they read the
 * writers' own source, not a hand-maintained list.
 *
 * Two properties a plain text scan cannot tell apart, so this file parses
 * `daily.yml` as YAML and checks each explicitly:
 *  - a file is staged AT ALL (anywhere in the workflow), and
 *  - it is staged in the step that runs AFTER the code that writes it.
 * Committing `first-seen.yml` in the classifier's commit step — which runs
 * before `build:catalog` ever touches the file — satisfies the first
 * property and violates the second, staging yesterday's copy every day.
 * That is this task's original bug, and a guard that only checks the first
 * property would wave it through again.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'daily.yml'), 'utf8')
const buildTs = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'build.ts'), 'utf8')
const classifyTs = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'classify.ts'), 'utf8')

// build.ts and classify.ts are the only two of daily.yml's five
// `node --experimental-strip-types` entry points (see strip-types.test.ts's
// ENTRY_POINTS) whose registry/-relative writes this workflow's `build` job
// needs staged after each run:
//  - classify.ts runs directly (the "Classify new listings" step);
//  - build.ts runs via `pnpm build:catalog` (package.json's script).
// The other three are out of scope for a different reason each, not because
// nobody checked:
//  - emit-schema.ts writes registry/schema/plugin-entry.schema.json, but as
//    a single hard-coded literal (SCHEMA_PATH), never through
//    `join(REGISTRY_DIR, …)` — findJoinCalls() would find nothing to scan
//    in it regardless. It also isn't a step in this workflow at all
//    (`pnpm emit:schema` is a local/dev command).
//  - publish-catalog.ts IS invoked here, but by the separate `publish` job
//    (`pnpm publish:catalog`) and it writes only under dist/npm/ — there is
//    no REGISTRY_DIR call site in it to miss.
//  - backfill-first-seen.ts does write registry/first-seen.yml through
//    `join(REGISTRY_DIR, …)`, but it is a manual one-off a human runs
//    directly — never a step in this workflow — so staging its output is
//    that human's responsibility, not this guard's.
// If daily.yml ever grows a step that runs a third module writing under
// registry/, this hard-coded pair needs a third entry — nothing below
// derives the module list from the workflow automatically, so that step is
// on whoever adds it.

// ---------------------------------------------------------------------------
// Every `join(REGISTRY_DIR …)` call site, and which ones are file writes.
// ---------------------------------------------------------------------------

interface JoinCall {
  /** Index in `source` where the literal text `join(REGISTRY_DIR` starts. */
  readonly start: number
  /** The registry-relative path, if every argument after REGISTRY_DIR was a
   * static string. Undefined if a segment is a template literal with an
   * interpolated `${…}`, or the call could not be parsed as a plain
   * comma-separated argument list. */
  readonly path: string | undefined
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r'
}

/** Every `join(REGISTRY_DIR, …)` call in `source`, found by hand-scanning
 * rather than a single regex: these calls take zero or more comma-separated
 * string segments, and a JS regex cannot capture a variable number of
 * repeated groups — `matchAll` keeps only the last iteration of a repeated
 * capture, not all of them, so a two-segment `join` would silently lose its
 * first segment under a regex-only extraction. */
function findJoinCalls(source: string): JoinCall[] {
  const needle = 'join(REGISTRY_DIR'
  const calls: JoinCall[] = []
  let searchFrom = 0
  for (;;) {
    const start = source.indexOf(needle, searchFrom)
    if (start === -1) break
    searchFrom = start + needle.length
    let cursor = searchFrom
    const segments: string[] = []
    let resolved = true
    parseArgs: for (;;) {
      while (cursor < source.length && isSpace(source.charAt(cursor))) cursor++
      if (cursor >= source.length) { resolved = false; break parseArgs }
      const ch = source.charAt(cursor)
      if (ch === ')') { cursor++; break parseArgs }
      if (ch !== ',') { resolved = false; break parseArgs } // unexpected token: not a plain arg list
      cursor++
      while (cursor < source.length && isSpace(source.charAt(cursor))) cursor++
      const quote = source.charAt(cursor)
      if (quote !== "'" && quote !== '"' && quote !== '`') { resolved = false; break parseArgs } // a non-literal argument
      cursor++
      let content = ''
      let sawInterpolation = false
      while (cursor < source.length && source.charAt(cursor) !== quote) {
        if (source.charAt(cursor) === '\\') { content += source.slice(cursor, cursor + 2); cursor += 2; continue }
        if (quote === '`' && source.charAt(cursor) === '$' && source.charAt(cursor + 1) === '{') sawInterpolation = true
        content += source.charAt(cursor)
        cursor++
      }
      if (cursor >= source.length) { resolved = false; break parseArgs } // unterminated string literal
      cursor++ // the closing quote
      if (sawInterpolation) resolved = false
      segments.push(content)
    }
    calls.push({ start, path: resolved ? segments.join('/') : undefined })
  }
  return calls
}

type JoinCallVerdict =
  | { readonly kind: 'write'; readonly path: string }
  | { readonly kind: 'unwritten'; readonly note: string }

/** Classifies one `join(REGISTRY_DIR …)` call site as a file write (its path
 * is passed directly, or via a variable, to `writeFile`/`writeFileSync`/
 * `appendFile`/`appendFileSync`) or not. */
function classifyJoinCall(call: JoinCall, source: string): JoinCallVerdict {
  const before = source.slice(0, call.start)
  const writeCallee = /(?:append|write)File(?:Sync)?\(\s*$/
  const dynamic = (): JoinCallVerdict =>
    ({ kind: 'unwritten', note: 'the path has an interpolated segment and cannot be statically resolved' })

  if (writeCallee.test(before)) {
    return call.path !== undefined ? { kind: 'write', path: call.path } : dynamic()
  }
  const varMatch = /const\s+(\w+)\s*=\s*$/.exec(before)
  const varName = varMatch?.[1]
  if (varName !== undefined) {
    const isWritten = new RegExp(`(?:append|write)File(?:Sync)?\\(\\s*${varName}\\b`).test(source)
    if (!isWritten) return { kind: 'unwritten', note: `${varName} is declared but never passed to a write call in this module` }
    return call.path !== undefined ? { kind: 'write', path: call.path } : dynamic()
  }
  return { kind: 'unwritten', note: 'not a direct write-call argument or a variable declaration' }
}

/** Every path under `registry/` that `source` writes — directly, or via a
 * `const p = join(REGISTRY_DIR, …)` declaration later passed to a write
 * call — regardless of whether the path is single- or double-quoted,
 * backtick-quoted, spread across multiple `join()` segments, or written with
 * `writeFile`/`appendFile` (sync or not). */
function registryWrites(source: string): string[] {
  const out = new Set<string>()
  for (const call of findJoinCalls(source)) {
    const verdict = classifyJoinCall(call, source)
    if (verdict.kind === 'write') out.add(verdict.path)
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// Exhaustiveness: every REGISTRY_DIR join site is either a recognised write
// or an explicitly reasoned non-write. An unrecognised spelling — a new
// quote style, a new write-function name, a dynamic segment — must fail
// loudly here instead of silently vanishing from registryWrites().
// ---------------------------------------------------------------------------

interface ExcusedUse {
  readonly module: string
  /** A substring unique to the excused call's own line. Keyed by content,
   * not line number: if a future edit changes what ends up on that line,
   * the substring stops matching and this excuse silently stops applying —
   * the exhaustiveness check below then fails until a human re-confirms (or
   * replaces) the excuse, rather than an excuse quietly surviving a rewrite
   * of the line it was written for. */
  readonly snippet: string
  readonly reason: string
}

const EXCUSED_REGISTRY_DIR_USES: readonly ExcusedUse[] = [
  {
    module: 'build.ts',
    snippet: "mkdirSync(join(REGISTRY_DIR, 'snapshots')",
    reason: 'creates a directory; writes no file content',
  },
  {
    module: 'classify.ts',
    snippet: "const repoStatePath = join(REGISTRY_DIR, 'repo-state.json')",
    reason: 'classify.ts only reads repo-state.json (existsSync/readFileSync); '
      + 'build.ts is the sole writer, already covered by its own check above',
  },
  {
    module: 'classify.ts',
    snippet: 'mkdirSync(join(REGISTRY_DIR)',
    reason: 'creates a directory; writes no file content',
  },
]

function lineContaining(source: string, index: number): string {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  const lineEndIdx = source.indexOf('\n', index)
  return source.slice(lineStart, lineEndIdx === -1 ? source.length : lineEndIdx)
}

function lineNumberOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length
}

// ---------------------------------------------------------------------------
// The workflow's steps, read as structured YAML rather than scanned as flat
// text — so a `git add` can be attributed to the specific step it runs in,
// and that step's position checked against the step that writes the file.
// ---------------------------------------------------------------------------

interface WorkflowStep {
  readonly name: string | undefined
  readonly run: string | undefined
}

function parseBuildSteps(source: string): WorkflowStep[] {
  const doc: unknown = parse(source)
  const jobs = typeof doc === 'object' && doc !== null ? (doc as Record<string, unknown>).jobs : undefined
  const build = typeof jobs === 'object' && jobs !== null ? (jobs as Record<string, unknown>).build : undefined
  const steps = typeof build === 'object' && build !== null ? (build as Record<string, unknown>).steps : undefined
  if (!Array.isArray(steps)) throw new Error('daily.yml: jobs.build.steps is not an array — the workflow shape changed')
  return steps.map((step, index) => {
    if (typeof step !== 'object' || step === null) {
      throw new Error(`daily.yml: jobs.build.steps[${index}] is not an object`)
    }
    const { name, run } = step as Record<string, unknown>
    return {
      name: typeof name === 'string' ? name : undefined,
      run: typeof run === 'string' ? run : undefined,
    }
  })
}

/** Finds the one step matching `predicate`; throws (naming `label`) if none
 * or more than one matches, rather than silently picking the first. */
function findStep(
  steps: readonly WorkflowStep[],
  predicate: (step: WorkflowStep) => boolean,
  label: string,
): { readonly index: number; readonly step: WorkflowStep } {
  const matches = steps.map((step, index) => ({ step, index })).filter(({ step }) => predicate(step))
  if (matches.length === 0) throw new Error(`daily.yml: could not find the "${label}" step`)
  if (matches.length > 1) throw new Error(`daily.yml: found ${matches.length} steps matching "${label}", expected exactly one`)
  const [match] = matches
  if (match === undefined) throw new Error(`daily.yml: "${label}" resolution is inconsistent`) // unreachable
  return match
}

/** Every path a `run` block's `git add` lines stage. Backslash line
 * continuations are joined first: `git add a \` followed by `  b` is one
 * logical command staging both `a` and `b`, but without this the second
 * path sits on a line that does not start with `git add` and is invisible
 * to the line-anchored match below. */
function gitAddPaths(run: string | undefined, label: string): Set<string> {
  if (run === undefined) throw new Error(`daily.yml: the "${label}" step has no run block`)
  const joined = run.replace(/\\\r?\n[ \t]*/g, ' ')
  const staged = new Set<string>()
  for (const match of joined.matchAll(/^[ \t]*git add ([^\n]+)$/gm)) {
    for (const token of (match[1] ?? '').trim().split(/\s+/)) staged.add(token)
  }
  return staged
}

/** True if `path` is staged directly, or falls under a staged directory —
 * `git add registry/` (or `git add registry`) covers every file beneath it,
 * the same as the real `git add` would. */
function isStaged(path: string, staged: ReadonlySet<string>): boolean {
  if (staged.has(path)) return true
  for (const token of staged) {
    const dir = token.endsWith('/') ? token.slice(0, -1) : token
    if (path === dir || path.startsWith(`${dir}/`)) return true
  }
  return false
}

const buildSteps = parseBuildSteps(workflow)
const classifyStep = findStep(buildSteps, s => s.run?.includes('classify.ts') === true, 'classify.ts')
const buildCatalogStep = findStep(buildSteps, s => s.run?.includes('build:catalog') === true, 'build:catalog')
const commitClassifierStep = findStep(buildSteps, s => s.name === "Commit the classifier's output", "Commit the classifier's output")
const commitSnapshotStep = findStep(buildSteps, s => s.name === 'Commit the snapshot', 'Commit the snapshot')

const stagedByClassifierCommit = gitAddPaths(commitClassifierStep.step.run, "Commit the classifier's output")
const stagedBySnapshotCommit = gitAddPaths(commitSnapshotStep.step.run, 'Commit the snapshot')

describe('every REGISTRY_DIR join site in build.ts and classify.ts is accounted for', () => {
  const modules: ReadonlyArray<readonly [string, string]> = [
    ['build.ts', buildTs],
    ['classify.ts', classifyTs],
  ]

  for (const [moduleName, source] of modules) {
    it(`is a recognised write or an excused non-write, for every join(REGISTRY_DIR …) in ${moduleName}`, () => {
      for (const call of findJoinCalls(source)) {
        const verdict = classifyJoinCall(call, source)
        if (verdict.kind === 'write') continue
        const line = lineContaining(source, call.start)
        const excused = EXCUSED_REGISTRY_DIR_USES.some(e => e.module === moduleName && line.includes(e.snippet))
        expect(
          excused,
          `${moduleName}:${lineNumberOf(source, call.start)} — ${verdict.note}. `
            + 'Either registryWrites() needs to learn this spelling, or this call needs '
            + 'a reasoned entry in EXCUSED_REGISTRY_DIR_USES. Line: ' + line.trim(),
        ).toBe(true)
      }
    })
  }
})

describe('the daily workflow stages every registry file the build writes', () => {
  it('finds the writers, so the extraction itself is not silently empty', () => {
    // If a refactor changes how the writes are spelled, this fails rather than
    // letting the guards below pass vacuously.
    expect(registryWrites(buildTs)).toEqual(['first-seen.yml', 'repo-state.json', 'snapshots/manifest.lock'])
    expect(registryWrites(classifyTs)).toEqual(['categories.yml', 'markets.yml'])
  })

  it('the steps found by name really do commit something', () => {
    // findStep() above locates "Commit the classifier's output" and "Commit
    // the snapshot" by their exact step name. This ties that name-based
    // lookup back to the content the review anchored on: a step renamed by
    // copy-paste error into one of these two names, without actually running
    // `git commit`, would otherwise satisfy every check below vacuously.
    expect(commitClassifierStep.step.run ?? '').toContain('git commit')
    expect(commitSnapshotStep.step.run ?? '').toContain('git commit')
  })

  it('commits the classifier\'s output only in a step that runs after classify.ts', () => {
    expect(commitClassifierStep.index).toBeGreaterThan(classifyStep.index)
  })

  it('commits the snapshot only in a step that runs after build:catalog', () => {
    expect(commitSnapshotStep.index).toBeGreaterThan(buildCatalogStep.index)
  })

  it('stages every file build.ts writes, in the step that runs after build:catalog', () => {
    for (const file of registryWrites(buildTs)) {
      expect(
        isStaged(`registry/${file}`, stagedBySnapshotCommit),
        `"Commit the snapshot" must git add registry/${file} (staged there: ${[...stagedBySnapshotCommit].join(', ')})`,
      ).toBe(true)
    }
  })

  it('stages every file classify.ts writes, in the step that runs after classify.ts', () => {
    for (const file of registryWrites(classifyTs)) {
      expect(
        isStaged(`registry/${file}`, stagedByClassifierCommit),
        `"Commit the classifier's output" must git add registry/${file} (staged there: ${[...stagedByClassifierCommit].join(', ')})`,
      ).toBe(true)
    }
  })
})
