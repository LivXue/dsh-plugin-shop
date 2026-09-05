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
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (relative: string): string => readFileSync(join(repoRoot, relative), 'utf8')

describe('the catalog harvest is serialised across refs', () => {
  it('puts every pull-request run in ONE concurrency group', () => {
    // The harvest is bounded by one GitHub token's search quota, not by the
    // ref, so a per-ref group lets any number of them run at once. Measured
    // 2026-09-05: seven catalog runs started within 90 seconds — a merge to
    // main, a branch push, and five Dependabot PRs that landed the moment
    // .github/dependabot.yml did — each running the full 82-window live
    // harvest on the same token. The search API answered 403 and main's
    // post-merge build died on it.
    //
    // main keeps its own group, so a PR can never cancel a run that publishes.
    const workflow = read('.github/workflows/daily.yml')
    const group = workflow.match(/^\s*group:\s*(.+)$/m)?.[1] ?? ''
    expect(group, 'daily.yml groups by ref alone, so PR runs do not queue')
      .toMatch(/pull_request/)
    expect(group, 'main must not share the pull-request group').toMatch(/github\.ref/)
  })
})

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

  it('carries a tolerated search shortfall across the harvest handoff', () => {
    // Two files, one contract, and the reason it matters is easy to miss: CI
    // always passes --harvest-from, so build.ts's OWN searchByKeywords call
    // never runs there. The shortfall is found by classify.ts, and unless it
    // rides the handoff the published report cannot say this build is missing
    // packages. The write and the read have to move together.
    expect(read('registry/scripts/src/classify.ts'))
      .toContain('JSON.stringify({ candidates, rejections, shortfalls })')
    expect(read('registry/scripts/src/build.ts')).toContain('parsed.shortfalls')
    // And it reaches the artifact a reader actually sees.
    expect(read('registry/scripts/src/build.ts')).toContain('npm search shortfall')
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

describe('secrets are scoped to the steps that consume them', () => {
  interface Step { name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown> }
  interface BuildJob { permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] }

  /** The `build` job, parsed. */
  function buildJob(): BuildJob {
    const workflow = parse(read('.github/workflows/daily.yml')) as { jobs: Record<string, BuildJob> }
    const job = workflow.jobs.build
    if (job === undefined) throw new Error('daily.yml declares no build job')
    return job
  }

  it('keeps every secret out of the job-level env, so no other step inherits one', () => {
    // A job-level `env:` block is in EVERY step's environment. It held
    // NPM_TOKEN, LLM_API_KEY and GITHUB_TOKEN, which put all three into
    // `pnpm install` and its lifecycle scripts — a postinstall hook in any
    // transitive dependency could read them — and put LLM_API_KEY into the
    // harvest of thousands of third-party manifests. Only two steps need any
    // of them.
    const job = buildJob()
    for (const [name, value] of Object.entries(job.env ?? {})) {
      expect(String(value), `job-level env ${name} exposes a secret to every step`)
        .not.toMatch(/secrets\./)
    }
  })

  it('names every step that holds a secret, so a new one is a decision made twice', () => {
    // Named rather than counted alone: adding a secret to a fifth step should
    // have to be written here as well as there.
    const job = buildJob()
    const holders = job.steps
      .filter(step => Object.values(step.env ?? {}).some(v => /secrets\./.test(String(v))))
      .map(step => step.name ?? step.run ?? step.uses ?? '?')
    expect(holders).toHaveLength(4)
    expect(holders.filter(h => h.includes('Classify'))).toHaveLength(1)
    expect(holders.filter(h => h.includes('build:catalog'))).toHaveLength(1)
    expect(holders.filter(h => h.startsWith('Commit'))).toHaveLength(2)
  })

  it('runs the whole job under contents: read', () => {
    // The ambient grant is what `pnpm install`, the plaintext LLM call and the
    // harvest of thousands of third-party manifests all run under. Only the two
    // git-only push steps need write, and they carry it themselves.
    expect(buildJob().permissions?.contents).toBe('read')
  })

  it('does not let checkout leave a pushable credential on disk', () => {
    // With the default `persist-credentials: true`, checkout writes an
    // http.extraheader credential into .git/config, where every later step can
    // read it and push with it. Scoping a token to the push steps' env: is
    // pointless while that file holds one, which is why this and the
    // REGISTRY_PUSH_TOKEN below are one change rather than two.
    const checkout = buildJob().steps.find(step => (step.uses ?? '').startsWith('actions/checkout@'))
    expect(checkout, 'the build job does not check out').toBeDefined()
    expect(checkout?.with?.['persist-credentials']).toBe(false)
  })

  it('gives the write credential to the two push steps and to nothing else', () => {
    // The whole point: after this, the only steps that ever hold a credential
    // that can write to the repository are two git-only steps that touch no
    // third-party data.
    const job = buildJob()
    const writers = job.steps.filter(step => 'REGISTRY_PUSH_TOKEN' in (step.env ?? {}))
    expect(writers).toHaveLength(2)
    expect(writers.every(w => (w.name ?? '').startsWith('Commit'))).toBe(true)
    for (const step of writers) {
      // It reaches git from the environment, never from a command line or a
      // config file: the argv carries the variable NAME.
      expect(step.run, `${step.name ?? '?'} does not push with the scoped credential`)
        .toContain('password=$REGISTRY_PUSH_TOKEN')
      // An EMPTY credential.helper resets any inherited list. Matched on the
      // empty value specifically: an assertion for the bare key is also
      // satisfied by the real helper's own line, so it could never fail.
      expect(step.run, `${step.name ?? '?'} does not reset the inherited helper list`)
        .toMatch(/GIT_CONFIG_VALUE_0=\s/)
    }
  })
})

describe('the published shop manifest', () => {
  const pkg = JSON.parse(read('packages/dsh-plugin-shop/package.json')) as {
    devDependencies?: Record<string, string>
  }

  it('declares the vendored protocol with the workspace protocol', () => {
    // Load-bearing: pnpm 11 does not link a workspace member from a plain
    // range, and the typert generator only recognises @Remote symbols
    // declared in a workspace package under packages/ (VENDORED.md).
    expect(pkg.devDependencies?.['@deepseek-ai/dsh-typert-protocol']).toMatch(/^workspace:/)
  })

  it('is released with the tool that rewrites that specifier', () => {
    // `npm publish` shipped `workspace:^0.1.1-rc.2` into the published
    // manifest of 0.7.4 (measured with npm view); `pnpm publish` and `pnpm pack`
    // resolve it. The specifier above and the release command are one
    // decision, and this is the coupling that keeps them agreeing.
    const claude = read('CLAUDE.md')
    const release = claude.slice(claude.indexOf('## Release channels'))
    expect(release, 'CLAUDE.md has no Release channels section').not.toBe('')
    expect(release).toContain('pnpm publish --tag beta')
    expect(release, 'a bare `npm publish` would ship the workspace: specifier').not.toMatch(/^npm publish/m)
  })
})

describe('the vendored typert protocol', () => {
  const pkg = JSON.parse(read('packages/dsh-typert-protocol/package.json')) as {
    version: string
    exports: Record<string, unknown>
    files?: string[]
  }

  it('records the same version in VENDORED.md and package.json', () => {
    // A re-sync replaces lib/ and bumps the version; recording one without
    // the other leaves the copy claiming to be something it is not, and
    // nothing checked.
    const match = /@deepseek-ai\/dsh-typert-protocol@(\S+?)`/.exec(read('packages/dsh-typert-protocol/VENDORED.md'))
    expect(match?.[1], 'VENDORED.md names no source version').toBeDefined()
    expect(match?.[1]).toBe(pkg.version)
  })

  it('keeps the generator-required host export and file declarations', () => {
    // The workspace typert generator validates this exact export before it
    // emits the shop host face. The target files are generated in the shop's
    // lib/ directory, not copied into the protocol workspace member.
    expect(pkg.exports['./typert']).toEqual({
      types: './lib/typert.host.d.ts',
      default: './lib/typert.host.js',
    })
    expect(pkg.files).toContain('lib/typert.host.js')
    expect(pkg.files).toContain('lib/typert.host.d.ts')
  })
})

describe('what git is allowed to pick up', () => {
  /** `git check-ignore` exits 0 when the path is ignored, 1 when it is not.
   * Asked of git rather than parsed out of .gitignore, because the pattern
   * that matters is the one git actually applies — including the negation. */
  const ignored = (path: string): boolean => {
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: repoRoot, stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }

  it('ignores the agent scratch directory', () => {
    // 4.4 MB containing shadow.git, untracked AND unignored: one `git add -A`
    // from being committed.
    expect(ignored('.raven/NOTICE.txt')).toBe(true)
    expect(ignored('.raven/shadow.git')).toBe(true)
  })

  it('ignores every dotenv variant, not just the bare name', () => {
    // `.env` was covered; `.env.local` and `.env.production` were not.
    for (const file of ['.env', '.env.local', '.env.production', '.env.test.local']) {
      expect(ignored(file), `${file} is not ignored`).toBe(true)
    }
  })

  it('ignores packed tarballs but keeps the tracked fixture', () => {
    // `npm pack` drops one in the package directory during every release.
    // The fixture is deliberately tracked, so the negation states that and
    // this asserts it: an ignore rule does not untrack a tracked file, but a
    // later `git rm --cached` plus re-add would silently drop it.
    expect(ignored('packages/dsh-plugin-shop/dsh-plugin-shop-9.9.9.tgz')).toBe(true)
    expect(ignored('some-package.tgz')).toBe(true)
    expect(ignored('packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz')).toBe(false)
  })

  it('keeps the fixture tarball tracked', () => {
    // The negation is worthless if the file it exempts stopped being tracked.
    const tracked = execFileSync('git', ['ls-files', 'packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    expect(tracked.trim()).toBe('packages/dsh-plugin-shop/tests/fixtures/catalog-package.tgz')
  })
})

describe('the exit criteria cannot skip silently in CI', () => {
  it('tells the package suite that a skipped exit criterion is a failure', () => {
    // real-install.test.ts and web-full-flow.e2e.ts are the P1 and P2 exit
    // criteria, and both skip when no usable `dsh` is found. plugin.yml
    // installs the harness and a browser two steps earlier for exactly that
    // reason, so a skip there is not honest — it is a green run that proves
    // nothing. Reproduced 2026-09-05: hiding `dsh` from PATH gave `1 skipped`
    // and exit 0.
    // Parsed, not windowed: the first version sliced 500 characters after the
    // `run:` line and the comment explaining the env pushed the env itself out
    // of the window, so a correct workflow read as broken.
    const workflow = parse(read('.github/workflows/plugin.yml')) as {
      jobs: Record<string, { steps: { run?: string; env?: Record<string, string> }[] }>
    }
    const steps = workflow.jobs.test?.steps ?? []
    const suite = steps.find(step => (step.run ?? '').includes('packages/dsh-plugin-shop test'))
    expect(suite, 'plugin.yml does not run the package suite').toBeDefined()
    expect(suite?.env?.DSH_SHOP_REQUIRE_E2E, 'plugin.yml does not require the exit criteria to run')
      .toBe('1')
  })
})

