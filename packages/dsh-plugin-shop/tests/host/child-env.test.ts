import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { installEnv } from '../../src/host/child-env.ts'

/** A host module, as text: the spawn OPTIONS are not observable from a child,
 * so the two that matter here are pinned structurally, the way the body-cap
 * guard pins I/O seams elsewhere in this suite. */
const source = (name: string): string =>
  readFileSync(new URL(`../../src/host/${name}`, import.meta.url), 'utf8')

describe('the environment an install child gets', () => {
  it('turns a git credential prompt into an immediate failure', () => {
    // A private git dependency would otherwise sit at a username prompt with
    // no console to answer it, until INSTALL_TIMEOUT_MS reports a timeout —
    // the wrong cause, fifteen minutes later.
    expect(installEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0' })
  })

  it('overrides a caller that set the prompt back on', () => {
    // A narrowed env wins for everything else, but this one is not a
    // preference: no prompt on this path can be answered either way.
    expect(installEnv({ GIT_TERMINAL_PROMPT: '1' }).GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('falls back to the process environment when the caller passes none', () => {
    const env = installEnv(undefined)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.PATH).toBe(process.env.PATH)
  })
})

describe('the two spawns that run a package manager', () => {
  // One function for both, so a setting cannot reach one path and not the
  // other. The structural half is the only way to see spawn OPTIONS.
  for (const file of ['executor.ts', 'prefetch.ts']) {
    it(`${file} hides the console window and takes the environment from installEnv`, () => {
      const text = source(file)
      expect(text, `${file} must spawn with windowsHide: true`).toMatch(/windowsHide:\s*true/)
      expect(text, `${file} must build the child env with installEnv`).toMatch(/env:\s*installEnv\(/)
    })
  }
})
