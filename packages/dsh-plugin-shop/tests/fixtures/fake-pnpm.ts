/**
 * A fake `pnpm` that runs on every platform, for the same reason
 * `fake-dsh.ts` exists: a `#!/bin/sh` fixture cannot be spawned on Windows,
 * and a `.mjs` one is routed through node by `jsEntryCommand`.
 *
 * The body records its argv so a test can assert WHICH specs a batch carried
 * and how many batches ran — the two properties the pump is about.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Write `dir/pnpm.mjs`, appending one line per invocation to `dir/pnpm.log`.
 *
 * `delayMs` holds the child open so a test can enqueue a second install while
 * a batch is in flight. `exitCode` drives the non-zero path. `hang` never
 * exits, for the timeout case.
 */
export function fakePnpm(dir: string, options: {
  exitCode?: number
  delayMs?: number
  hang?: boolean
} = {}): string {
  const { exitCode = 0, delayMs = 0, hang = false } = options
  const bin = join(dir, 'pnpm.mjs')
  writeFileSync(bin, [
    "import * as fs from 'node:fs'",
    'const argv = process.argv.slice(2)',
    // Same reason as fake-dsh.ts: process.exit() on a piped stdout can drop
    // queued writes, so record the code and let the process end normally.
    'const recordExit = code => { process.exitCode = code === undefined ? 0 : code }',
    `fs.appendFileSync(${JSON.stringify(join(dir, 'pnpm.log'))}, argv.join(' ') + '\\n')`,
    hang
      ? 'setInterval(() => {}, 1000)'
      : `setTimeout(() => recordExit(${exitCode}), ${delayMs})`,
    '',
  ].join('\n'))
  return bin
}
