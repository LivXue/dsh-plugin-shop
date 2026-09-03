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
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'daily.yml'), 'utf8')

/** Every path under `registry/` that one module writes with writeFileSync. */
function registryWrites(source: string): string[] {
  const out = new Set<string>()
  // `writeFileSync(join(REGISTRY_DIR, 'x/y.ext'), …)` — the literal form.
  for (const match of source.matchAll(/writeFileSync\(\s*join\(REGISTRY_DIR,\s*'([^']+)'\)/g)) {
    if (match[1] !== undefined) out.add(match[1])
  }
  // `const p = join(REGISTRY_DIR, 'x.json')` … `writeFileSync(p, …)` — the
  // variable form build.ts uses for repo-state.json.
  for (const match of source.matchAll(/const (\w+) = join\(REGISTRY_DIR, '([^']+)'\)/g)) {
    const [, variable, file] = match
    if (variable !== undefined && file !== undefined
      && new RegExp(`writeFileSync\\(${variable}\\b`).test(source)) out.add(file)
  }
  return [...out].sort()
}

/** Every path the workflow's `git add` lines stage. */
function stagedPaths(): Set<string> {
  const staged = new Set<string>()
  for (const match of workflow.matchAll(/^\s*git add ([^\n]+)$/gm)) {
    for (const token of (match[1] ?? '').trim().split(/\s+/)) staged.add(token)
  }
  return staged
}

describe('the daily workflow stages every registry file the build writes', () => {
  const staged = stagedPaths()

  it('finds the writers, so the extraction itself is not silently empty', () => {
    // If a refactor changes how the writes are spelled, this fails rather than
    // letting the guard below pass vacuously.
    const build = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'build.ts'), 'utf8')
    const classify = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'classify.ts'), 'utf8')
    expect(registryWrites(build)).toEqual(['first-seen.yml', 'repo-state.json', 'snapshots/manifest.lock'])
    expect(registryWrites(classify)).toEqual(['categories.yml', 'markets.yml'])
  })

  it('stages every file build.ts writes under registry/', () => {
    const build = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'build.ts'), 'utf8')
    for (const file of registryWrites(build)) {
      expect(staged, `daily.yml must git add registry/${file}`).toContain(`registry/${file}`)
    }
  })

  it('stages every file classify.ts writes under registry/', () => {
    const classify = readFileSync(join(repoRoot, 'registry', 'scripts', 'src', 'classify.ts'), 'utf8')
    for (const file of registryWrites(classify)) {
      expect(staged, `daily.yml must git add registry/${file}`).toContain(`registry/${file}`)
    }
  })
})
