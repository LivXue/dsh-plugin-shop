import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isTerminalInstallState, type InstallState } from '../../src/shared/install-state.ts'

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url))
const OWNER = join(SRC_DIR, 'shared', 'install-state.ts')

describe('install state', () => {
  it('calls done and failed terminal, and downloading and running not', () => {
    const terminal: InstallState[] = ['done', 'failed']
    const live: InstallState[] = ['downloading', 'running']
    for (const state of terminal) expect(isTerminalInstallState(state)).toBe(true)
    for (const state of live) expect(isTerminalInstallState(state)).toBe(false)
  })

  // The structural guard. Two spellings of one wire union is how the host and
  // the client drifted apart before, and a second copy would typecheck
  // perfectly while disagreeing about what states exist.
  it('is declared in exactly one source file', () => {
    const offenders: string[] = []
    for (const dir of ['host', 'client', 'shared']) {
      const base = join(SRC_DIR, dir)
      for (const file of readdirSync(base)) {
        if (!/\.tsx?$/.test(file)) continue
        const path = join(base, file)
        if (path === OWNER) continue
        if (/'running'\s*\|\s*'done'\s*\|\s*'failed'/.test(readFileSync(path, 'utf8'))) {
          offenders.push(join(dir, file))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
