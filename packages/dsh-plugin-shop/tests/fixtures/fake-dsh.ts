/**
 * A fake `dsh` CLI that runs on every platform.
 *
 * The fixtures this replaces were `#!/bin/sh` scripts written with
 * `chmod 0o755`, and on Windows there is no form of `spawn()` that can start
 * one: the file carries no PE image, so `CreateProcess` refuses it, and node
 * has refused `.cmd`/`.bat` without a shell since the 2024 batfile
 * argument-injection fix — so wrapping `sh` in a `.cmd` shim is not an escape
 * either. That is why `executor.test.ts`, `index.test.ts` and
 * `restart.test.ts` contributed 54 of the 55 Windows failures and had to be
 * excluded from the windows CI leg by name.
 *
 * A node script has no such problem: `dshCommand` runs a `dshBin` naming a JS
 * entry through the node already running the test (`JS_ENTRY` in
 * `src/host/dsh-cli.ts`), which is the same route production takes to the
 * real CLI on Windows. No shell is involved on either platform, so an
 * argument carrying a space or an `&` stays one argument.
 *
 * The body is written as source text rather than passed as a function,
 * because it runs in a CHILD process and cannot close over the test's scope.
 * Everything it needs arrives through interpolation or through `argv`.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Write `dir/dsh.mjs` and return its path, ready to hand to `dshBin`.
 *
 * `body` is ESM source with three bindings already in scope:
 *
 *  - `argv` — the CLI's own arguments, `['plugin', '--profile', 'web', 'add',
 *    '<spec>']`. `argv[0]` is what a shell fixture called `$1`, so the line
 *    those fixtures logged is `argv.slice(0, 5).join(' ')`.
 *  - `fs` — `node:fs`, so a body that records something needs no import.
 *  - `out` — one line to stdout. `process.stdout.write` remains available for
 *    the cases that deliberately emit no trailing newline, and the contrast
 *    between the two spellings is the point: an unterminated line is an
 *    assertion in `lineSink`'s tests, not an oversight.
 *
 * Exiting is the body's job, as it was the script's: `process.exit(n)`.
 *
 * The `.mjs` extension is load-bearing twice over — it is what `JS_ENTRY`
 * matches, and it is what makes the file ESM whatever the nearest
 * `package.json` says, which for a fixture under the OS temp directory is
 * whatever happens to be lying around above it.
 */
export function fakeDsh(dir: string, body: string, name = 'dsh.mjs'): string {
  const bin = join(dir, name)
  writeFileSync(bin, [
    "import * as fs from 'node:fs'",
    'const argv = process.argv.slice(2)',
    // `process.exit()` RECORDS the code and lets the body end, rather than
    // terminating on the spot.
    //
    // stdout is a PIPE here, so node's writes to it are ASYNCHRONOUS, and
    // `process.exit()` is documented to exit "even if there are still
    // asynchronous operations pending ... including I/O to process.stdout".
    // A body's exit is its last statement, so every line it printed is exactly
    // what is at risk. While a reader keeps the pipe empty each write finishes
    // inside `uv_write`'s first `write(2)` and nothing is ever queued — which
    // is why an idle machine never sees this — but under a full parallel suite
    // the reader is starved, the pipe backs up, and the queue is dropped.
    // Measured: 171, 181 and 201 lines of 250 arriving on three different
    // runs. Varying counts are what a lost race looks like; a logic error
    // gives the same wrong answer every time.
    //
    // Recording the code instead lets the process end normally, which flushes
    // stdout first. Verified against every body this fixture has: all sixteen
    // `process.exit(n)` call sites are the LAST line of their body, so nothing
    // depends on it not returning, and the two that spawn a grandchild
    // `unref()` it, so nothing holds the loop open either.
    //
    // The synchronous alternative — writing to fd 1 with `fs.writeSync` — was
    // tried first and is a trap. Node sets the pipe non-blocking as soon as
    // anything TOUCHES `process.stdout`, so the override needed to install it
    // is what makes the write it installs throw `EAGAIN` under the very
    // back-pressure it was meant to survive.
    'const recordExit = code => { process.exitCode = code === undefined ? 0 : code }',
    'process.exit = recordExit',
    "const out = line => process.stdout.write(line + '\\n')",
    body,
    '',
  ].join('\n'))
  return bin
}

/**
 * The commonest fixture: append the argv line to `calls.log` beside the
 * script, print one progress line, and exit with `exitCode`.
 *
 * Appending rather than truncating, because several cases spawn one fixture
 * more than once and read the log back as a sequence — which is what the
 * shell version's `>>` gave them.
 */
export function fakeDshRecording(dir: string, exitCode: number, options: { silent?: boolean } = {}): string {
  return fakeDsh(dir, [
    `fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, argv.slice(0, 5).join(' ') + '\\n')`,
    ...(options.silent === true ? [] : ["out('installing...')"]),
    `process.exit(${exitCode})`,
  ].join('\n'))
}
