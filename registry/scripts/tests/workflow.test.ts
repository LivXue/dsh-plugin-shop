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

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  /** The step's `if:` expression, verbatim. Carried because a push step's
   * guard is part of what makes the push safe, and only the whole expression
   * can show that. */
  readonly if: string | undefined
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
    const { name, run, if: ifExpr } = step as Record<string, unknown>
    return {
      name: typeof name === 'string' ? name : undefined,
      run: typeof run === 'string' ? run : undefined,
      if: typeof ifExpr === 'string' ? ifExpr : undefined,
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

// ---------------------------------------------------------------------------
// The two bot pushes, exercised rather than pattern-matched.
//
// Both ran with no fetch and no rebase under `continue-on-error: true`. Run
// 33731280504 (schedule, 2026-09-03, conclusion `success`) logged
// `! [rejected] main -> main (fetch first)` at 08:24 for the classifier commit
// and at 08:53 for the snapshot; run 33623131511 (2026-09-02, `success`) the
// same twice. Each occurrence silently discarded that day's LLM verdicts and
// the repo-state backfill memory, and the run reported that it had succeeded.
//
// These tests run the function AS WRITTEN IN daily.yml against throwaway local
// repositories. Asserting that the YAML contains the words "git fetch" would
// pass on a comment; only running it can show that a rejected push is retried.
// ---------------------------------------------------------------------------

/** Every step of `jobs.build.steps` whose `run:` pushes, found structurally.
 * A third pushing step added to THAT job under a name this file does not know
 * must fail the guard below: Task 5's step lookup is by name and is blind to a
 * new one by construction, and this is what closes that hole — for the build
 * job, and only for it. `parseBuildSteps` reads `jobs.build.steps` and nothing
 * else, so a `git push` added to the `publish` or `deploy` job passes every
 * check in this file. That gap is left open rather than overlooked: widening
 * the parser would pull both other jobs into a guard written for the two bot
 * commits, and neither pushes today — `deploy` has no `run:` step at all, and
 * `publish`'s three install, write an ~/.npmrc line, and publish to npm.
 *
 * Deliberately NOT anchored to the start of a line. The push this task
 * introduces lives inside `if git push origin HEAD:main; then …`, and
 * `then git push`, `git push || …` and `exec git push` are each one edit away.
 * A false positive (the words inside a `run:` block's own `#` comment — there
 * are none today, checked) fails loudly and gets looked at. A false negative
 * silently deletes every behavioural case below. */
const pushSteps = buildSteps.filter(step => /\bgit push\b/.test(step.run ?? ''))

// Not an `it(...)`: a `for (const step of pushSteps)` loop that generates
// nothing is invisible to vitest — the eight behavioural cases below would
// simply not exist and the file would report green. `findStep` throws on 0 or
// >1 matches for exactly this reason. Nor is this hypothetical: this task's
// first draft matched `git push` only at the start of a line, which its own
// Step 3 then moved behind `if `, emptying the list and taking the whole
// behavioural core with it while one assertion noticed.
if (pushSteps.length !== 2) {
  throw new Error(
    `daily.yml: expected exactly 2 steps whose run pushes, found ${pushSteps.length}`
    + ` (${pushSteps.map(step => step.name ?? '(unnamed)').join(', ') || 'none'})`,
  )
}

/** The `if:` expression both pushing steps must carry, byte for byte.
 *
 * Pinned as a literal rather than matched against a shape. The property that
 * matters is that `github.ref` is a TOP-LEVEL conjunct — that it gates every
 * trigger rather than only the last one — and deciding that means parsing the
 * expression, which no regex can do. The predecessor here,
 * `/^\(.+\) && github\.ref == 'refs\/heads\/main'$/`, told the paren-less
 * variant apart and nothing else: `.+` swallows `) || (`, so
 *
 *   (…'schedule' || …'workflow_dispatch') || (…'push') && github.ref == …
 *
 * matched it while parsing as `A || B || (C && D)`, leaving `workflow_dispatch`
 * outside the guard — exactly the dispatch-from-any-branch failure the guard
 * exists to prevent, green at 21/21.
 *
 * An exact string also means that adding a fourth trigger event has to edit
 * this constant deliberately, which is the moment to re-read the guard instead
 * of inheriting it. */
const PUSH_STEP_IF =
  "(github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
  + " || github.event_name == 'push') && github.ref == 'refs/heads/main'"

/** `push_with_rebase`'s definition exactly as the YAML writes it: from its
 * opening line to the first following line that is a lone `}` at the same
 * indent. `parse()` has already stripped the block scalar's common indent, so
 * that closing line is `}` at column 0. */
function pushFunction(step: WorkflowStep): string {
  const label = step.name ?? '(unnamed step)'
  const lines = (step.run ?? '').split('\n')
  const open = lines.findIndex(line => line.trimEnd().endsWith('push_with_rebase() {'))
  if (open === -1) throw new Error(`daily.yml: the "${label}" step defines no push_with_rebase()`)
  const indent = /^[ \t]*/.exec(lines[open] ?? '')?.[0] ?? ''
  const close = lines.findIndex((line, i) => i > open && line === `${indent}}`)
  if (close === -1) throw new Error(`daily.yml: "${label}"'s push_with_rebase() is never closed by "}" at its own indent`)
  return lines.slice(open, close + 1).join('\n')
}

describe('the daily workflow pushes safely', () => {
  const IDENT = {
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    // Whoever runs these tests has git configuration of their own, and three
    // ordinary settings each broke all seven cases that build a sandbox, with
    // nothing more useful to show than `Command failed: git commit`
    // (`commit.gpgsign`, with no signing key and none wanted for a throwaway
    // commit; and a `core.hooksPath` whose pre-commit hook fails outside its
    // own repo) or `Command failed: git clone` (`protocol.file.allow=never`,
    // and the sandbox clones over `file://`). Measured, one setting at a time.
    // Reading neither config file leaves the sandbox depending on nothing but
    // the git binary.
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  }
  /** `stdio: 'pipe'` because git writes to stderr on success and vitest shows
   * it: the empty-clone warning alone was six lines a run. `execFileSync`
   * still folds stderr into the thrown error's message, so a failing git
   * command says exactly as much as it did before. */
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...IDENT } })

  /** Commits on origin before the runner clones it. Seeded with ONE, the
   * depth-1 boundary was the root commit, the clone held the entire history,
   * and every case below passed identically against a full clone — the
   * shallow checkout they are named for was never exercised. Several commits
   * make the boundary a real graft. */
  const ORIGIN_COMMITS = 40

  /** A bare origin with a real history behind its tip, plus a depth-1 clone.
   *
   * An approximation of what `actions/checkout@v4` leaves on the runner, since
   * daily.yml:48 sets no `fetch-depth` — not a replica of it. `clone --depth 1
   * --branch main` leaves a single-branch refspec; the action does `init` +
   * `remote add` + a depth-1 `fetch` and leaves the wildcard refspec. What
   * `push_with_rebase` meets in either is a grafted boundary one commit deep,
   * which is the property these cases turn on. */
  function sandbox(): { dir: string; origin: string; seed: string; runner: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-push-'))
    try {
      const origin = join(dir, 'origin.git')
      git(dir, 'init', '--quiet', '--bare', origin)
      const seed = join(dir, 'seed')
      git(dir, 'clone', '--quiet', origin, seed)
      for (let n = 1; n <= ORIGIN_COMMITS; n++) {
        const last = n === ORIGIN_COMMITS
        // The tip stays `base`/`base\n` so the conflict case still collides on
        // this file's one line, and the log assertions still name it.
        writeFileSync(join(seed, 'f'), last ? 'base\n' : `history ${n}\n`)
        git(seed, 'add', 'f')
        git(seed, 'commit', '--quiet', '-m', last ? 'base' : `history ${n}`)
      }
      git(seed, 'push', '--quiet', 'origin', 'HEAD:main')
      const runner = join(dir, 'runner')
      git(dir, 'clone', '--quiet', '--depth', '1', '--branch', 'main', `file://${origin}`, runner)
      return { dir, origin, seed, runner }
    } catch (error) {
      // mkdtempSync runs before the first git call and each caller's
      // try/finally only opens once this has returned, so a throw in here
      // would otherwise leave the directory behind in the OS temp dir.
      rmSync(dir, { recursive: true, force: true })
      throw error
    }
  }

  /** Someone pushes to main while the ~50-minute run is in flight. */
  function humanPush(seed: string, file: string, content: string): void {
    git(seed, 'fetch', '--quiet', 'origin', 'main')
    git(seed, 'checkout', '--quiet', '-B', 'main', 'origin/main')
    writeFileSync(join(seed, file), content)
    git(seed, 'add', file)
    git(seed, 'commit', '--quiet', '-m', `human edits ${file}`)
    git(seed, 'push', '--quiet', 'origin', 'main')
  }

  /** Run the YAML's own function in the runner clone. `bash -e` matches the
   * shell GitHub gives a `run:` block (`bash -e {0}`), so `set -e` semantics
   * are the production ones and not a friendlier local approximation. */
  function runPush(dir: string, runner: string, fn: string): { status: number; out: string } {
    const script = join(dir, 'under-test.sh')
    writeFileSync(script, `${fn}\npush_with_rebase "under test"\n`)
    const result = spawnSync('bash', ['-e', script], {
      cwd: runner, encoding: 'utf8', env: { ...process.env, ...IDENT },
    })
    return { status: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  /** A pre-push hook that, on its FIRST invocation only, lands another commit
   * on origin so our push loses the race and is rejected for real. It must
   * fire once: left armed, attempt 2 would race too and the loop could never
   * converge. GIT_DIR and friends are exported into hooks and would point the
   * seed's commands at the runner's repository, so they are unset first. */
  function armRace(dir: string, runner: string, seed: string): void {
    const hook = join(runner, '.git', 'hooks', 'pre-push')
    writeFileSync(hook, [
      '#!/bin/sh',
      `if [ -f "${dir}/raced" ]; then exit 0; fi`,
      `touch "${dir}/raced"`,
      'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX',
      `cd "${seed}" || exit 1`,
      'git fetch --quiet origin main && git checkout --quiet -B main origin/main',
      'echo raced > raced && git add raced && git commit --quiet -m race',
      'git push --quiet origin main',
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 })
  }

  it('has exactly the two committing steps that push, and no third', () => {
    expect(pushSteps.map(step => step.name)).toEqual([
      "Commit the classifier's output",
      'Commit the snapshot',
    ])
  })

  it('keeps the two copies of push_with_rebase byte-identical', () => {
    // Each `run:` block is its own shell, so the function is necessarily
    // duplicated. Nothing else would notice one copy drifting.
    const [first, second] = pushSteps.map(pushFunction)
    expect(first).toBe(second)
  })

  it('clones the runner shallowly, so the cases below meet a real graft', () => {
    // The setup asserting its own premise, the same reflex as "finds the
    // writers, so the extraction itself is not silently empty" above. This
    // sandbox silently stopped being shallow once already: with a single
    // seeded commit the depth-1 boundary was the root commit and the clone
    // held everything, so the case named for the shallow checkout proved
    // nothing about it. daily.yml:48 sets no `fetch-depth`, so depth 1 is what
    // push_with_rebase runs in for real, and a rebase that could not cross a
    // graft would annotate ::error:: every morning instead of landing.
    const { dir, origin, runner } = sandbox()
    try {
      expect(git(runner, 'rev-parse', '--is-shallow-repository').trim()).toBe('true')
      const count = (cwd: string, ref: string): number => Number(git(cwd, 'rev-list', '--count', ref).trim())
      expect(count(origin, 'main')).toBe(ORIGIN_COMMITS)
      expect(count(runner, 'HEAD')).toBe(1)
      expect(count(runner, 'HEAD')).toBeLessThan(count(origin, 'main'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  for (const step of pushSteps) {
    const label = step.name ?? '(unnamed step)'

    it(`runs "${label}" only on refs/heads/main`, () => {
      // `workflow_dispatch` fires on ANY ref — the reason the four other
      // side-effecting steps and jobs in this file guard on it too. It did not
      // matter while this step ended in a bare `git push`, which went to the
      // dispatched branch's own upstream. `push_with_rebase` rebases onto
      // `origin/main` and pushes `HEAD:main`, so without this guard a dispatch
      // from any additive branch replays that branch onto main and pushes it:
      // exit 0, no annotation, unreviewed content on main. On a branch that
      // conflicts with main the other outcome is two ::warning:: and an
      // ::error:: on every dispatch, corroding the annotation this task relies
      // on.
      //
      // Compared against the whole pinned expression. `&&` binds tighter than
      // `||`, so WHERE the guard sits decides which triggers it covers, and
      // that is a question about how the expression parses — see PUSH_STEP_IF
      // for why no pattern over the text can answer it.
      expect(step.if).toBe(PUSH_STEP_IF)
    })

    it(`routes every push in "${label}" through push_with_rebase`, () => {
      const run = step.run ?? ''
      const outsideTheFunction = run.replace(pushFunction(step), '')
      // A bare `git push` re-added beside the function would still push
      // unsafely while every "contains push_with_rebase" assertion passed.
      // Unanchored for the same reason as `pushSteps`: `if git push …` outside
      // the function is a push, and the anchored form cannot see it.
      expect(outsideTheFunction).not.toMatch(/\bgit push\b/)
      expect(run).toMatch(/(^|\n)[ \t]*push_with_rebase ["'][^\n]*["']/)
    })

    it(`"${label}" pushes cleanly when origin moved under it`, () => {
      const { dir, seed, runner } = sandbox()
      try {
        humanPush(seed, 'human', 'human\n')
        writeFileSync(join(runner, 'bot'), 'bot\n')
        git(runner, 'add', 'bot')
        git(runner, 'commit', '--quiet', '-m', 'bot')
        const { status, out } = runPush(dir, runner, pushFunction(step))
        expect({ status, out }).toEqual({ status: 0, out: expect.any(String) })
        expect(out).not.toContain('::error::')
        // Both commits are on origin: the rebase preserved the human's work
        // rather than the push clobbering it.
        git(seed, 'fetch', '--quiet', 'origin', 'main')
        const log = git(seed, 'log', '--format=%s', 'FETCH_HEAD').split('\n').filter(Boolean)
        expect(log.slice(0, 3)).toEqual(['bot', 'human edits human', 'base'])
        // Origin ends holding exactly what it should: the seeded commits
        // plus the human's and the bot's, nothing dropped and nothing
        // replayed twice.
        //
        // Nothing deepens along the way, despite how the fetch reads.
        // Measured across origin advancing 5 -> 6 commits: the graft boundary
        // is byte-identical before and after `git fetch origin main`, and it
        // IS merge-base(HEAD, origin/main). That holds by construction rather
        // than by luck — origin/main only ever moves forward from the tip the
        // runner checked out — so only a history rewrite on origin could
        // defeat the rebase, and that surfaces as ::error::.
        //
        // What this count does NOT catch, since the obvious guess is wrong: a
        // push out of a shallow clone cannot truncate origin, whose own copy
        // of the graft commit has ordinary parents it still holds. Adding
        // `--force` to push_with_rebase leaves this length correct and is
        // caught by the order assertion above instead, losing the human's
        // commit — measured with the rebase intact (passes) and without it
        // (the order fires, the count never gets a say). Kept as a
        // reinforcing check on the final shape, not as the load-bearing one.
        expect(log).toHaveLength(ORIGIN_COMMITS + 2)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it(`"${label}" retries once when the push is rejected, and says so`, () => {
      const { dir, seed, runner } = sandbox()
      try {
        writeFileSync(join(runner, 'bot'), 'bot\n')
        git(runner, 'add', 'bot')
        git(runner, 'commit', '--quiet', '-m', 'bot')
        armRace(dir, runner, seed)
        const { status, out } = runPush(dir, runner, pushFunction(step))
        expect(status).toBe(0)
        expect(out.match(/::warning::/g) ?? []).toHaveLength(1)
        expect(out).not.toContain('::error::')
        git(seed, 'fetch', '--quiet', 'origin', 'main')
        const log = git(seed, 'log', '--format=%s', 'FETCH_HEAD').split('\n').filter(Boolean)
        expect(log.slice(0, 3)).toEqual(['bot', 'race', 'base'])
        expect(log).toHaveLength(ORIGIN_COMMITS + 2)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it(`"${label}" fails loudly when the rebase cannot be completed`, () => {
      const { dir, seed, runner } = sandbox()
      try {
        // Both sides edit the same line of the same file: the rebase conflicts,
        // aborts, and the un-rebased push is rejected on both attempts. Landing
        // nothing is correct here; landing it with `-X ours` would silently
        // discard whatever the other side committed.
        humanPush(seed, 'f', 'theirs\n')
        writeFileSync(join(runner, 'f'), 'ours\n')
        git(runner, 'add', 'f')
        git(runner, 'commit', '--quiet', '-m', 'bot edits f')
        const { status, out } = runPush(dir, runner, pushFunction(step))
        expect(status).toBe(1)
        expect(out.match(/::warning::/g) ?? []).toHaveLength(2)
        expect(out).toContain('::error::')
        // The runner is left on a usable branch, not mid-rebase.
        expect(git(runner, 'status', '--porcelain=v1', '--branch')).toContain('## main')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  }
})
