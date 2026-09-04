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

describe('the pointer cache window', () => {
  it('is recorded in the mirrors design with the fallback it chose', () => {
    // A known ten-minute hole in one transport is a fact a reader of the
    // design needs, and a decision NOT to close something gets silently
    // re-litigated if it is not written down with its price.
    const design = read('docs/design/2026-09-01-catalog-mirrors.md')
    expect(design).toContain('### The pointer outlives the data it names')
    expect(design).toContain('max-age=600')
    expect(design).toContain('dsh-plugin-shop-catalog')
  })

  it('is stated in both READMEs beside the artifact table', () => {
    // Anyone fetching /v1/ themselves needs to know the data names change
    // per build and where to get a self-consistent pair instead.
    for (const file of ['README.md', 'README.zh.md']) {
      expect(read(file), `${file} does not name the npm fallback`).toContain('dsh-plugin-shop-catalog')
      expect(read(file), `${file} does not mention the 404 a stale pointer causes`).toContain('404')
    }
  })
})

describe('workflow action pins', () => {
  const workflows = ['.github/workflows/daily.yml', '.github/workflows/plugin.yml']

  it('pins every action to a full commit SHA and names the version in a comment', () => {
    // A major tag is a moving reference, and whoever can move it runs code in
    // a job holding LLM_API_KEY, NPM_TOKEN, STARS_TOKEN and a repo token —
    // pnpm/action-setup, a third-party action, installs the very binary that
    // later runs publish:catalog. The trailing comment is not decoration: it
    // is how the file stays readable, and it is what Dependabot rewrites.
    for (const file of workflows) {
      const uses = [...read(file).matchAll(/^[ \t]*(?:-[ \t]*)?uses:[ \t]*(\S+)[ \t]*(?:#[ \t]*(\S+))?/gm)]
      expect(uses.length, `${file} declares no actions`).toBeGreaterThan(0)
      for (const match of uses) {
        expect(match[1], `${file}: ${String(match[1])} is not pinned to a 40-hex commit`)
          .toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
        expect(match[2], `${file}: ${String(match[1])} names no version in a trailing comment`)
          .toMatch(/^v\d+\.\d+\.\d+$/)
      }
    }
  })

  it('asks Dependabot to keep the pins current', () => {
    // A SHA pin that nobody bumps is a security patch nobody applies. The
    // weekly PR is the other half of the trade.
    const dependabot = read('.github/dependabot.yml')
    expect(dependabot).toContain('package-ecosystem: github-actions')
    expect(dependabot).toMatch(/interval:\s*weekly/)
  })

  it('uses one SHA per action across both workflows', () => {
    // daily.yml checks out three times and plugin.yml once; four different
    // pins of actions/checkout would be four things to review.
    const byAction = new Map<string, Set<string>>()
    for (const file of workflows) {
      for (const match of read(file).matchAll(/uses:[ \t]*([\w.-]+\/[\w.-]+)@([0-9a-f]{40})/g)) {
        const action = match[1]!
        if (!byAction.has(action)) byAction.set(action, new Set())
        byAction.get(action)!.add(match[2]!)
      }
    }
    for (const [action, shas] of byAction) {
      expect([...shas], `${action} is pinned to more than one commit`).toHaveLength(1)
    }
  })
})

