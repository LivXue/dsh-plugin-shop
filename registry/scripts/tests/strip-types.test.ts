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
 * Every entry point below runs real work at module scope once invoked as a
 * script: `build.ts` and `classify.ts` make live npm (and, for classify,
 * LLM) calls and overwrite committed registry files; `publish-catalog.ts`
 * resolves the published packument over the network and, past that, runs a
 * real `npm publish`; `backfill-first-seen.ts` shells out to `git log`/`git
 * show` and overwrites `registry/first-seen.yml`. None of that may run here
 * — this test proves only that the *syntax* survives stripping, not that the
 * behavior is correct (every module below has its own test file for that).
 *
 * Each file guards its real work behind
 * `process.argv[1]?.endsWith('<file>.ts')` — `emit-schema.ts` had this guard
 * first, and `schema.test.ts` already relies on it to import
 * `renderJsonSchema` without the write side effect; the other four entry
 * points now draw the same line. Under `node -e`, `process.argv[1]` is
 * `undefined` (there is no script file, only the `-e` string), so
 * `undefined?.endsWith(...)` evaluates to `undefined` — never strictly
 * `true` — and every guard's `!== true` / `=== true` check takes the branch
 * that skips the real work, before any of it runs. A dynamic `import()`
 * (rather than a static one) is required for this to matter: a static
 * `import` would be hoisted and evaluated by vitest's own esbuild-transformed
 * loader, never by the `node --experimental-strip-types` process this test
 * spawns, and would prove nothing about the flag.
 *
 * Verified to discriminate, not just pass: reverting the CRITICAL fix this
 * test was added for (`PrimaryStatusError`'s constructor back to a
 * TypeScript parameter property in npm-client.ts, which `build.ts` and
 * `classify.ts` both import) turns every one of these red with
 * `SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]`; restoring the fix turns
 * them green again.
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const srcDir = join(repoRoot, 'registry', 'scripts', 'src')

// Every module `package.json` or daily.yml invokes with
// `node --experimental-strip-types` directly.
const ENTRY_POINTS = [
  'build.ts',
  'classify.ts',
  'publish-catalog.ts',
  'emit-schema.ts',
  'backfill-first-seen.ts',
]

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
