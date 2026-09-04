/** Guards over the repository's own conventions: what CI publishes, what it
 * is allowed to hold while it does, and what the packaging ships.
 *
 * These read files rather than call functions, because the thing guarded IS
 * a file — a workflow path, a permission block, an ignore rule. They catch
 * drift, not runtime behaviour; where a runtime fact is what matters, the
 * task that added the guard also names the log line or `gh api` read that
 * confirms it. A convention no test enforces is a convention that drifts
 * silently, which is what readme-pins.test.ts exists to prove. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8')

describe('what CI publishes to Pages', () => {
  it('uploads the staged directory, never dist itself', () => {
    // `path: dist` published /v1/harvest.json, /v1/report.md and
    // /v1/classification-report.md, none of which the spec lists. Confirmed
    // live on 2026-09-04: all three answered 200 on the published site.
    const workflow = read('.github/workflows/daily.yml')
    expect(workflow).toContain('uses: actions/upload-pages-artifact')
    const fromStep = workflow.slice(workflow.indexOf('actions/upload-pages-artifact'))
    expect(fromStep).toMatch(/\n\s+path: dist\/pages\n/)
    expect(fromStep).not.toMatch(/\n\s+path: dist\n/)
  })

  it('hands the build the harvest path the classifier writes', () => {
    // Two files, one contract: classify.ts writes the handoff and daily.yml
    // tells build.ts where to read it. A silent mismatch would make the build
    // re-harvest the whole ecosystem rather than fail, so the drift would cost
    // hours before anyone noticed.
    expect(read('registry/scripts/src/classify.ts')).toContain("writeFileSync(join(DIST_DIR, 'harvest.json')")
    expect(read('.github/workflows/daily.yml')).toContain('--harvest-from dist/harvest.json')
  })
})
