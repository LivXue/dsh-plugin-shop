import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const testsDir = dirname(fileURLToPath(import.meta.url))
const srcDir = join(testsDir, '..', 'src')
// A `file://` URL, NOT a bare absolute path. `--import` goes through the ESM
// loader, and on Windows a bare `D:\…` reads its drive letter as a URL scheme:
// `ERR_UNSUPPORTED_ESM_URL_SCHEME … Received protocol 'd:'`. This is the same
// defect `importSpecifier` in strip-types.test.ts exists for, whose comment
// names the trap exactly — "an unexercised contract is how a simplification
// back to a bare path stays green on the only platform CI runs" — and it was
// reintroduced here the same day, so the citation is the point.
const preload = pathToFileURL(join(testsDir, 'preload-fetch.ts')).href

/**
 * The variables that must not leak into a child, so a developer's live
 * credentials cannot turn one of these runs into a real request. `LLM_API_KEY`
 * empty is what disables classification; `GITHUB_TOKEN` absent is what keeps
 * the GitHub half from harvesting.
 */
const WITHHELD = ['LLM_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NPM_BACKUP_REGISTRY']

interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** Every URL the child requested, in order. */
  readonly urls: string[]
}

/** A throwaway working directory holding the three registry files
 * `loadRegistryConfig` requires; everything else it treats as absent. */
function newWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'publisher-handoff-'))
  mkdirSync(join(cwd, 'registry'), { recursive: true })
  for (const file of ['verified.yml', 'denied.yml', 'allowed-similar.yml']) {
    writeFileSync(join(cwd, 'registry', file), '[]\n')
  }
  return cwd
}

/** Runs one entry point as the real script CI runs, against fixed responses. */
function runEntry(cwd: string, file: string, args: readonly string[], rules: readonly unknown[]): Run {
  const fixture = join(cwd, 'fetch-rules.json')
  const log = join(cwd, 'fetch-log.txt')
  writeFileSync(fixture, JSON.stringify({ rules }))
  writeFileSync(log, '')
  const env: NodeJS.ProcessEnv = { ...process.env, FETCH_FIXTURE: fixture, FETCH_LOG: log }
  for (const name of WITHHELD) delete env[name]
  env.LLM_API_KEY = ''
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--import', preload, join(srcDir, file), ...args],
    { cwd, env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' },
  )
  const spawnError = result.error === undefined ? '' : `\nspawn error: ${result.error.message}`
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${spawnError}`,
    urls: readFileSync(log, 'utf8').split('\n').filter(line => line !== ''),
  }
}

/** A search response, with maintainers on every object. `keywords`, when
 * given, is attached to every object alike -- enough to make a name at risk
 * (or not) for the publisher axis without needing a distinct page per name. */
function searchPage(
  total: number, names: readonly string[], owners: readonly string[], keywords?: readonly string[],
): unknown {
  return {
    total,
    objects: names.map(name => ({
      package: {
        name,
        maintainers: owners.map(username => ({ username })),
        ...(keywords === undefined ? {} : { keywords }),
      },
    })),
  }
}

/** A packument the gate refuses cheaply, so the pipeline reaches its artifact
 * block without needing a realistic package. */
function packument(name: string): unknown {
  return { name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name, version: '1.0.0' } } }
}

const vocabulary = (cwd: string): unknown =>
  JSON.parse(readFileSync(join(cwd, 'registry', 'publisher-state.json'), 'utf8'))

describe('the publisher vocabulary survives the run that discovered it', () => {
  it('classify.ts carries what it saw in the handoff, and writes no vocabulary itself', () => {
    // The classifier OWNS the observations and the build owns the file. CI runs
    // them in that order, so a vocabulary written by the classifier would be
    // overwritten by the build a step later.
    const cwd = newWorkspace()
    try {
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'size=1', body: { total: 2, objects: [] } },
        { contains: '/-/v1/search', body: searchPage(2, ['dsh-a', 'dsh-b'], ['bob', 'alice']) },
        { contains: '/dsh-a', body: packument('dsh-a') },
        { contains: '/dsh-b', body: packument('dsh-b') },
      ])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'harvest.json'), 'utf8')) as {
        publishers?: unknown
      }
      expect(handoff.publishers).toEqual(['alice', 'bob'])
      expect(existsSync(join(cwd, 'registry', 'publisher-state.json'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts --harvest-from merges the handoff into the committed file', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: ['bob', 'alice'],
      })}\n`)
      // Every npm rule is absent on purpose: the handoff branch must make no
      // search at all, and preload-fetch throws on an unmatched URL, so a
      // build that reached the direct harvest fails here rather than passing
      // against a fixture that happened to cover it.
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(vocabulary(cwd)).toEqual({ publishers: ['alice', 'bob'], cursor: 0, pinned: {} })
      expect(run.stderr).toContain('publisher vocabulary 0 -> 2')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('the next classifier run probes the cells the last one seeded', () => {
    // The whole point of persisting. This run observes NO new username, so
    // every maintainer cell it probes came out of the committed file.
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'publisher-state.json'),
        `${JSON.stringify({ publishers: ['alice', 'bob'], cursor: 0 }, null, 2)}\n`)
      const run = runEntry(cwd, 'classify.ts', [], [
        // Past the window, so the publisher axis engages at all.
        { contains: 'maintainer%3Aalice', body: { total: 0, objects: [] } },
        { contains: 'maintainer%3Abob', body: { total: 0, objects: [] } },
        { contains: 'dsh%2Cplugin', body: { total: 1, objects: [] } },
        { contains: '%2Cdsh&size=1', body: { total: 1, objects: [] } },
        { contains: '%2Cdsh&', body: searchPage(1, ['w0'], []) },
        { contains: '%2C', body: { total: 0, objects: [] } },
        { contains: 'size=1', body: { total: 5410, objects: [] } },
        { contains: '/-/v1/search', body: searchPage(5410, ['w0'], []) },
        { contains: '/w0', body: packument('w0') },
      ])
      const probed = run.urls.filter(u => u.includes('maintainer%3A'))
      expect(probed.length, `stderr:\n${run.stderr}`).toBeGreaterThan(0)
      expect(probed.some(u => u.includes('maintainer%3Aalice'))).toBe(true)
      expect(probed.some(u => u.includes('maintainer%3Abob'))).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('a handoff with no publishers field leaves the vocabulary as it was', () => {
    // An older classifier wrote no such field. Its handoff must still build,
    // and must not read as "this run saw nobody, so forget everyone".
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'publisher-state.json'),
        `${JSON.stringify({ publishers: ['alice'], cursor: 0 }, null, 2)}\n`)
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'),
        `${JSON.stringify({ candidates: [], rejections: [], shortfalls: [] })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(vocabulary(cwd)).toEqual({ publishers: ['alice'], cursor: 0, pinned: {} })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  for (const [label, value] of [
    ['a string', '"alice"'],
    ['null', 'null'],
    ['an ungrammatical username', '["Alice"]'],
  ] as const) {
    it(`refuses a handoff whose publishers field is ${label}, before writing anything`, () => {
      // The handoff is where a username enters this process. A malformed one
      // must not become an empty list — that publishes a short vocabulary with
      // a green build — and must not be written either, because
      // `parsePublisherState` would then refuse the file on every later run.
      const cwd = newWorkspace()
      try {
        mkdirSync(join(cwd, 'dist'), { recursive: true })
        writeFileSync(join(cwd, 'dist', 'harvest.json'),
          `{"candidates":[],"rejections":[],"shortfalls":[],"publishers":${value}}\n`)
        const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
        expect(run.status, `stderr:\n${run.stderr}`).not.toBe(0)
        // A non-zero exit is not enough, and this is not a nit: every one of
        // these three passed on Windows while the child was dying in the ESM
        // loader before `build.ts` ran at all. `status !== 0` cannot tell a
        // build that REFUSED the handoff from one that never started, so the
        // reason is asserted too — and the loader's own error is named as the
        // thing this must not be mistaken for.
        expect(run.stderr, `stderr:\n${run.stderr}`).toContain('publisher-state.json')
        expect(run.stderr).not.toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME')
        expect(run.stderr).not.toContain('preload-fetch:')
        expect(existsSync(join(cwd, 'registry', 'publisher-state.json'))).toBe(false)
        expect(existsSync(join(cwd, 'registry', 'first-seen.yml'))).toBe(false)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }

  it('a seeded owner classify.ts observes reaches pinned via build.ts --harvest-from', () => {
    // The actual CI path: classify.ts harvests and hands off, build.ts
    // --harvest-from is what persists. A test that only drives searchByKeywords
    // directly, or only drives build.ts's own (never-taken-in-CI) search
    // branch, cannot tell this path apart from one where the handoff carries
    // no publisherAxis at all and pinning silently never happens.
    const cwd = newWorkspace()
    try {
      const classifyRun = runEntry(cwd, 'classify.ts', [], [
        { contains: 'size=1', body: { total: 1, objects: [] } },
        { contains: '/-/v1/search', body: searchPage(1, ['dsh-a'], ['carol'], ['dsh-plugin']) },
        { contains: '/dsh-a', body: packument('dsh-a') },
      ])
      expect(classifyRun.status, `classify stderr:\n${classifyRun.stderr}`).toBe(0)
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'harvest.json'), 'utf8')) as {
        publisherAxis?: unknown
      }
      // 'carol' is at risk under 'dsh-plugin' (her only package's only keyword
      // IS the harvest keyword) and not under 'deepseek-harness' (where that
      // same keyword is a refinement that clears her) -- confirming the axis
      // ran the real isAtRisk rule rather than a stub.
      expect(handoff.publisherAxis).toMatchObject([
        { keyword: 'dsh-plugin', seeded: ['carol'] },
        { keyword: 'deepseek-harness', seeded: [] },
      ])

      const buildRun = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(buildRun.status, `build stderr:\n${buildRun.stderr}`).toBe(0)
      expect(vocabulary(cwd)).toMatchObject({ pinned: { 'dsh-plugin': ['carol'] } })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  for (const [label, value] of [
    ['a string', '"nope"'],
    ['null', 'null'],
    ['missing rotatedProbed', '[{"keyword":"dsh-plugin","vocabulary":0,"pinnedProbed":0,"pinnedSupplied":0,"rotatedSupplied":0,"suppliedNames":0,"seeded":[],"evicted":[],"atRiskNames":0,"pinnedFull":false}]'],
    ['an ungrammatical seeded username', '[{"keyword":"dsh-plugin","vocabulary":0,"pinnedProbed":0,"pinnedSupplied":0,"rotatedProbed":0,"rotatedSupplied":0,"suppliedNames":0,"seeded":["Alice"],"evicted":[],"atRiskNames":0,"pinnedFull":false}]'],
  ] as const) {
    it(`refuses a handoff whose publisherAxis field is ${label}, before writing anything`, () => {
      // Strict like `publishers`, not lenient like `shortfalls`: this field
      // feeds pinFor/unpinFor, which write committed state, so a malformed
      // record must not be read as "no axis this run" any more than a
      // malformed `publishers` may be read as "nobody this run".
      const cwd = newWorkspace()
      try {
        mkdirSync(join(cwd, 'dist'), { recursive: true })
        writeFileSync(join(cwd, 'dist', 'harvest.json'),
          `{"candidates":[],"rejections":[],"shortfalls":[],"publisherAxis":${value}}\n`)
        const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
        expect(run.status, `stderr:\n${run.stderr}`).not.toBe(0)
        expect(run.stderr, `stderr:\n${run.stderr}`).toContain('publisher axis')
        expect(run.stderr).not.toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME')
        expect(run.stderr).not.toContain('preload-fetch:')
        expect(existsSync(join(cwd, 'registry', 'publisher-state.json'))).toBe(false)
        expect(existsSync(join(cwd, 'registry', 'first-seen.yml'))).toBe(false)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }

  it('the cursor advances by what the axis rotated to, not by the probe budget', () => {
    // Old behaviour advanced by PUBLISHER_PROBE_BUDGET_DEFAULT regardless of
    // how much the axis actually rotated to. 600 publishers is comfortably
    // above that budget on either the old or the new formula, so a cursor of
    // 42 can only come from actually reading `rotatedProbed`.
    const cwd = newWorkspace()
    try {
      const publishers = Array.from({ length: 600 }, (_, i) => `u${String(i).padStart(3, '0')}`)
      writeFileSync(join(cwd, 'registry', 'publisher-state.json'),
        `${JSON.stringify({ publishers, cursor: 0 }, null, 2)}\n`)
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [],
        publisherAxis: [{
          keyword: 'dsh-plugin', vocabulary: 600, pinnedProbed: 0, pinnedSupplied: 0,
          rotatedProbed: 42, rotatedSupplied: 0, suppliedNames: 0,
          seeded: [], evicted: [], atRiskNames: 0, pinnedFull: false,
        }],
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(vocabulary(cwd)).toMatchObject({ cursor: 42 })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
