/**
 * Node's `--experimental-strip-types` strips TypeScript syntax without
 * transforming it — unlike vitest's esbuild transform, it rejects syntax
 * esbuild tolerates silently, a TypeScript parameter property
 * (`constructor(public readonly x: number)`) among them. `package.json`'s
 * `build:catalog`, `publish:catalog`, and `emit:schema` scripts, and
 * `.github/workflows/daily.yml`'s direct `classify.ts` invocation, all run
 * under this flag in production. A syntax every test here accepts (through
 * vitest's transform) can still break every real invocation while the whole
 * suite stays green — this file is the only thing that runs the actual
 * production interpreter over the actual production entry points.
 *
 * The entry-point list is DERIVED, never written down. A hand-maintained list
 * covers exactly the class of defect this file exists to catch — a new
 * `node --experimental-strip-types <x>.ts` invocation nobody remembered to
 * add — only until the next one is written. Three sources, unioned:
 *  - `package.json`'s `scripts`,
 *  - every workflow under `.github/workflows/`, and
 *  - every module in `registry/scripts/src/` carrying the entry-point guard
 *    described below. That third source is the only one that discovers
 *    `backfill-first-seen.ts`, a manual one-off no script and no workflow
 *    invokes.
 *
 * Every entry point runs real work at module scope once invoked as a script:
 * `build.ts` and `classify.ts` make live npm (and, for classify, LLM) calls
 * and overwrite committed registry files; `publish-catalog.ts` resolves the
 * published packument over the network and, past that, runs a real `npm
 * publish`; `backfill-first-seen.ts` shells out to `git log`/`git show` and
 * overwrites `registry/first-seen.yml`. None of that may run here — this file
 * proves that the *syntax* survives stripping and that the *guard* holds, not
 * that the behavior is correct (every module below has its own test file).
 *
 * Each entry point guards its work POSITIVELY and on an EXACT name:
 * `if (basename(process.argv[1] ?? '') === '<file>.ts') { … }`. Both halves
 * are load-bearing, and each has its own test below.
 *
 *  - POSITIVE. The form this replaced was `if (process.argv[1]?.endsWith(…)
 *    !== true) process.exit(0)` at module scope, which terminates whatever
 *    process IMPORTS the module — inside vitest, a worker that vanishes
 *    mid-suite and reports success, i.e. the silent success CLAUDE.md
 *    forbids. `emit-schema.ts` drew the positive line first, and
 *    `schema.test.ts` already relies on it to import `renderJsonSchema`
 *    without the write side effect.
 *  - EXACT. `endsWith('build.ts')` also admits `prebuild.ts` and
 *    `rebuild.ts`; `basename()` admits neither. The price of an exact name is
 *    that it is a literal, so a rename that forgets to update it would leave
 *    the entry point exiting 0 having done nothing — which is why the guard
 *    is read back out of each module's source and checked against that
 *    module's own file name rather than merely assumed.
 *
 * Under `node -e`, `process.argv[1]` is `undefined` (there is no script file,
 * only the `-e` string), so `basename('')` is `''`, no guard matches, and the
 * real work is skipped before any of it runs. A dynamic `import()` (rather
 * than a static one) is required for this to matter: a static `import` would
 * be hoisted and evaluated by vitest's own esbuild-transformed loader, never
 * by the `node --experimental-strip-types` process this file spawns, and
 * would prove nothing about the flag.
 *
 * Verified to discriminate, not just pass:
 *  - reverting the CRITICAL fix this file was added for
 *    (`PrimaryStatusError`'s constructor back to a TypeScript parameter
 *    property in npm-client.ts, which `build.ts` and `classify.ts` both
 *    import) turns every "imports cleanly" case red with
 *    `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]`;
 *  - restoring the negative `process.exit(0)` guard in any entry point turns
 *    that module's "stays importable" case red — the importer never runs, so
 *    the child exits 0 with no marker instead of the sentinel status.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const srcDir = join(repoRoot, 'registry', 'scripts', 'src')

/** The importing child's own exit status and stdout marker. Neither is
 * reachable from the imported module: `0` is what the guard this replaced
 * exited with, and `1` is what an uncaught throw gives. */
const IMPORTER_STATUS = 43
const IMPORTER_MARK = 'importer survived'

/**
 * Every `node --experimental-strip-types registry/scripts/src/<file>.ts`
 * invocation in `text`, as bare file names. Intervening node flags are
 * skipped, so `--experimental-strip-types --no-warnings <path>` counts; an
 * invocation with no such path (`--experimental-strip-types -e '…'`) names no
 * module and yields nothing.
 */
function invokedFiles(text: string): string[] {
  const pattern = /--experimental-strip-types\s+(?:--\S+\s+)*registry\/scripts\/src\/([A-Za-z0-9._-]+\.ts)/g
  return [...text.matchAll(pattern)].flatMap(match => (match[1] === undefined ? [] : [match[1]]))
}

/**
 * The file name an entry point's guard admits, read from CODE — a line whose
 * trimmed form opens with a comment marker is prose, and prose about a guard
 * is not a guard. `undefined` when the module carries no such guard.
 */
function guardedName(source: string): string | undefined {
  for (const raw of source.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue
    const match = /basename\(\s*process\.argv\[1\]\s*\?\?\s*''\s*\)\s*===\s*'([A-Za-z0-9._-]+\.ts)'/.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

function srcFiles(): string[] {
  return readdirSync(srcDir).filter(file => file.endsWith('.ts')).sort()
}

/** Modules something in this repo actually invokes under the flag:
 * `package.json`'s scripts, and every workflow. Read at call time, so a
 * workflow edited concurrently is scanned as it stands rather than as some
 * line number remembered here. */
function wiredEntryPoints(): string[] {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>
  }
  const found = new Set<string>()
  for (const command of Object.values(manifest.scripts ?? {})) {
    if (typeof command === 'string') for (const file of invokedFiles(command)) found.add(file)
  }
  const workflowDir = join(repoRoot, '.github', 'workflows')
  const workflows = readdirSync(workflowDir).filter(file => file.endsWith('.yml') || file.endsWith('.yaml')).sort()
  for (const workflow of workflows) {
    for (const file of invokedFiles(readFileSync(join(workflowDir, workflow), 'utf8'))) found.add(file)
  }
  return [...found].sort()
}

/** Modules that guard module-scope work on their own file name — an entry
 * point by construction, whether or not anything in the repo invokes them. */
function guardedEntryPoints(): string[] {
  return srcFiles().filter(file => guardedName(readFileSync(join(srcDir, file), 'utf8')) !== undefined)
}

const ENTRY_POINTS = [...new Set([...wiredEntryPoints(), ...guardedEntryPoints()])].sort()

describe('the entry-point list is derived, not maintained by hand', () => {
  it('extracts an invocation at all, so the derivation cannot pass by matching nothing', () => {
    expect(invokedFiles('node --experimental-strip-types registry/scripts/src/build.ts')).toEqual(['build.ts'])
    expect(invokedFiles('        run: node --experimental-strip-types --no-warnings registry/scripts/src/classify.ts\n'))
      .toEqual(['classify.ts'])
    // A flag-only invocation names no module, so `-e` one-liners stay out…
    expect(invokedFiles('node --experimental-strip-types -e "import(\'./x.ts\')"')).toEqual([])
    // …and so does an invocation that is not under the flag at all.
    expect(invokedFiles('node registry/scripts/src/build.ts')).toEqual([])
  })

  it('reads a guard at all, and never reads one out of prose', () => {
    expect(guardedName("if (basename(process.argv[1] ?? '') === 'build.ts') {\n")).toBe('build.ts')
    expect(guardedName("  if (basename(process.argv[1] ?? '') === 'emit-schema.ts') {\n")).toBe('emit-schema.ts')
    expect(guardedName("// if (basename(process.argv[1] ?? '') === 'build.ts') {\n")).toBeUndefined()
    expect(guardedName(" * if (basename(process.argv[1] ?? '') === 'build.ts') {\n")).toBeUndefined()
    // The exact shape this test exists to require: the endsWith form it
    // replaced is not a guard as far as this scan is concerned, so a
    // regression to it fails rather than being read as a match.
    expect(guardedName("if (process.argv[1]?.endsWith('build.ts') !== true) process.exit(0)\n")).toBeUndefined()
  })

  it('finds the wired invocations, so the derivation cannot pass by finding nothing', () => {
    const wired = wiredEntryPoints()
    // package.json's three scripts…
    expect(wired).toContain('build.ts')
    expect(wired).toContain('publish-catalog.ts')
    expect(wired).toContain('emit-schema.ts')
    // …and daily.yml's direct invocation.
    expect(wired).toContain('classify.ts')
  })

  it('finds the manual one-off that no script and no workflow invokes', () => {
    // backfill-first-seen.ts is run once, by a human, by hand. It appears in
    // no script and no workflow, so the guard scan is the only thing that can
    // discover it — and if that scan ever stops finding guards, this is the
    // test that says so rather than the list quietly shrinking.
    expect(guardedEntryPoints()).toContain('backfill-first-seen.ts')
  })

  it('names a real module for every wired invocation', () => {
    for (const file of wiredEntryPoints()) {
      expect(srcFiles(), `${file} is invoked under the flag but does not exist in ${srcDir}`).toContain(file)
    }
  })
})

describe('entry points survive --experimental-strip-types', () => {
  for (const file of ENTRY_POINTS) {
    it(`imports ${file} cleanly, without running its module-scope work`, () => {
      const target = join(srcDir, file)
      // `process.execPath`: the same node binary running this test, so the
      // check is against the interpreter actually in use, not a `node` on
      // PATH that might resolve to a different (or absent) version.
      // `JSON.stringify(target)` quotes the absolute path as a JS string
      // literal for the `-e` source; `timeout`+`killSignal` are the backstop
      // if a guard regresses and the child starts the real, network-bound
      // work instead of exiting immediately — this fails fast in seconds
      // rather than hanging the suite for the several minutes a real harvest
      // takes (CLAUDE.md).
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', `import(${JSON.stringify(target)})`],
        { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' },
      )
      const detail = [
        `${file}: exit ${String(result.status)}, signal ${String(result.signal)}`,
        result.error ? `spawn error: ${result.error.message}` : null,
        result.stderr.trim() === '' ? null : `stderr:\n${result.stderr}`,
      ].filter((line): line is string => line !== null).join('\n')
      expect(result.status, detail).toBe(0)
    })
  }
})

describe('importing an entry point never terminates the importing process', () => {
  for (const file of ENTRY_POINTS) {
    it(`leaves the importer alive and in control after importing ${file}`, () => {
      const target = join(srcDir, file)
      // The importer awaits the import, then marks stdout and exits with a
      // status the module itself cannot produce. A module-scope
      // `process.exit(0)` — the guard form this replaced — pre-empts both:
      // the child exits 0 with an empty stdout, and every future unit test
      // that so much as imports a helper from here dies the same way, having
      // reported success.
      const importer = `await import(${JSON.stringify(target)})\n`
        + `process.stdout.write(${JSON.stringify(IMPORTER_MARK)})\n`
        + `process.exit(${String(IMPORTER_STATUS)})\n`
      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--input-type=module', '-e', importer],
        { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL' },
      )
      const detail = [
        `${file}: exit ${String(result.status)}, signal ${String(result.signal)}`,
        result.error ? `spawn error: ${result.error.message}` : null,
        `stdout: ${JSON.stringify(result.stdout)}`,
        result.stderr.trim() === '' ? null : `stderr:\n${result.stderr}`,
      ].filter((line): line is string => line !== null).join('\n')
      expect(result.stdout, detail).toContain(IMPORTER_MARK)
      expect(result.status, detail).toBe(IMPORTER_STATUS)
    })
  }
})

describe('every entry point guards its work on its own exact file name', () => {
  for (const file of ENTRY_POINTS) {
    it(`${file} compares basename(process.argv[1]) to '${file}'`, () => {
      const source = readFileSync(join(srcDir, file), 'utf8')
      expect(
        guardedName(source),
        `${file} must run its module-scope work inside `
          + `\`if (basename(process.argv[1] ?? '') === '${file}') { … }\`. A negative guard ending in `
          + 'process.exit(0) kills whatever imports this module, and reports success doing it; '
          + `an endsWith('${file}') comparison also admits pre${file} and re${file}, and a name that `
          + 'no longer matches the file leaves the invocation exiting 0 having done nothing.',
      ).toBe(file)
    })
  }
})
