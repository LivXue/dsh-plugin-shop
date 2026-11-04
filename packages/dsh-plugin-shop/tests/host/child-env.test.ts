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
    expect(installEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
  })

  it('overrides a caller that set either prompt back on', () => {
    // A narrowed env wins for everything else, but these are not preferences:
    // no prompt on this path can be answered either way. `GCM_INTERACTIVE` is
    // the one Windows needs — Git Credential Manager ignores
    // `GIT_TERMINAL_PROMPT` and opens its own window on a cache miss.
    const env = installEnv({ GIT_TERMINAL_PROMPT: '1', GCM_INTERACTIVE: 'auto' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
  })

  it('falls back to the process environment when the caller passes none', () => {
    const env = installEnv(undefined)
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GCM_INTERACTIVE).toBe('never')
    expect(env.PATH).toBe(process.env.PATH)
  })
})

describe('the two spawns that run a package manager', () => {
  // One function for both, so a setting cannot reach one path and not the
  // other. The structural half is the only way to see spawn OPTIONS.
  for (const file of ['executor.ts', 'prefetch.ts']) {
    it(`${file} hides the console window on EVERY spawn, and takes the environment from installEnv`, () => {
      // Per spawn CALL, not once per file: executor.ts has two (the install
      // CLI and taskkill), and a guard matching the file once let the second
      // through. Comments are stripped first — prefetch.ts quotes a spawn call
      // in its own documentation.
      const text = source(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      const calls = (text.match(/\b(?:spawn|spawnSync)\(/g) ?? []).length
      const hidden = (text.match(/windowsHide:\s*true/g) ?? []).length
      expect(calls, `${file} must contain at least one spawn call`).toBeGreaterThan(0)
      expect(hidden, `${file}: ${calls} spawn calls, ${hidden} with windowsHide`).toBe(calls)
      expect(text, `${file} must build the child env with installEnv`).toMatch(/env:\s*installEnv\(/)
    })
  }
})
