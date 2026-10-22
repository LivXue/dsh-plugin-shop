import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ICON_FETCH_TIME_BUDGET_MS_DEFAULT, PUBLISHED_CATALOG_URL } from '../src/icon-fetch.ts'

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
 * the GitHub half from harvesting. The icon step's two budgets are not
 * credentials, but a developer who set one for a local run would change what a
 * test reads; `runEntry`'s `extraEnv` sets them where a test is about them. The
 * job's deadline is in the environment of every step after the catalog job's
 * first, `pnpm test` among them, so it is withheld for the same reason.
 */
const WITHHELD = ['LLM_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NPM_BACKUP_REGISTRY', 'ICON_FETCH_BUDGET', 'ICON_FETCH_TIME_BUDGET_MS', 'CATALOG_JOB_DEADLINE_MS']

/** The published catalog's index as a request carries it: `URL` writes the host in lower case. */
const PUBLISHED_INDEX_URL = new URL('index.json', PUBLISHED_CATALOG_URL).href

interface Run {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  /** Every URL the child requested, in order. */
  readonly urls: string[]
}

/** A throwaway working directory holding the registry files
 * `loadRegistryConfig` requires; everything else it treats as absent. */
function newWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'publisher-handoff-'))
  mkdirSync(join(cwd, 'registry'), { recursive: true })
  for (const file of ['verified.yml', 'denied.yml', 'allowed-similar.yml', 'withheld-icons.yml']) {
    writeFileSync(join(cwd, 'registry', file), '[]\n')
  }
  return cwd
}

/**
 * Runs one entry point as the real script CI runs, against fixed responses.
 * `extraEnv` is applied after the variables above are withheld.
 */
function runEntry(
  cwd: string, file: string, args: readonly string[], rules: readonly unknown[], extraEnv: NodeJS.ProcessEnv = {},
): Run {
  const fixture = join(cwd, 'fetch-rules.json')
  const log = join(cwd, 'fetch-log.txt')
  writeFileSync(fixture, JSON.stringify({ rules }))
  writeFileSync(log, '')
  const env: NodeJS.ProcessEnv = { ...process.env, FETCH_FIXTURE: fixture, FETCH_LOG: log }
  for (const name of WITHHELD) delete env[name]
  env.LLM_API_KEY = ''
  Object.assign(env, extraEnv)
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
      // A passing run hands its axis over in the harvest; the axis file is
      // a red run's alone (design 2026-10-22).
      expect(existsSync(join(cwd, 'dist', 'publisher-axis.json'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('classify.ts hands the publisher axis over when a coverage check fails, and writes no harvest', () => {
    // dsh-plugin answers 10 and serves 2, short past every allowance, while
    // deepseek-harness is whole: a coverage check fails after both keywords
    // reported their axis, so the run is red and its axis rides to the
    // commit step (design 2026-10-22, section 3.2).
    const cwd = newWorkspace()
    try {
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'keywords%3Adsh-plugin&size=1', body: { total: 10, objects: [] } },
        { contains: 'keywords%3Adsh-plugin&', body: searchPage(10, ['dsh-a1', 'dsh-a2'], ['carol', 'alice']) },
        { contains: 'keywords%3Adeepseek-harness&size=1', body: { total: 1, objects: [] } },
        { contains: 'keywords%3Adeepseek-harness&', body: searchPage(1, ['dsh-b'], ['bob']) },
      ])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('keywords:dsh-plugin')
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'publisher-axis.json'), 'utf8')) as {
        publishers?: unknown; publisherAxis?: { keyword?: unknown }[]
      }
      expect(handoff.publisherAxis?.map(record => record.keyword)).toEqual(['dsh-plugin', 'deepseek-harness'])
      expect(handoff.publishers).toEqual(['alice', 'bob', 'carol'])
      expect(existsSync(join(cwd, 'dist', 'harvest.json'))).toBe(false)
      expect(existsSync(join(cwd, 'registry', 'publisher-state.json'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('classify.ts writes no axis file when it fails before every keyword reported', () => {
    // A page with no total ends the run while the search is still paging:
    // no keyword finished, so there is no axis to commit.
    const cwd = newWorkspace()
    try {
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'keywords%3Adsh-plugin&size=1', body: { total: 10, objects: [] } },
        { contains: 'keywords%3Adsh-plugin&', body: searchPage(10, ['dsh-a1', 'dsh-a2'], ['alice']) },
        { contains: 'keywords%3Adeepseek-harness&size=1', body: { total: 1, objects: [] } },
        { contains: 'keywords%3Adeepseek-harness&', body: { objects: [] } },
      ])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('answered no total')
      expect(existsSync(join(cwd, 'dist', 'publisher-axis.json'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('classify.ts hands no axis over when the change feed\'s disagreement bound ends the run', () => {
    // The one failure that comes with an axis record for every keyword yet
    // is no coverage check: the bound is checked after deepseek-harness
    // reports its axis. Past it, the carriers seeding read no longer describe
    // npm search, so the axis they fed is not committed (design 2026-10-22,
    // section 2). Four carriers alice's own cell omits, each confirmed by
    // its packument, is one past FEED_MAX_DISAGREEMENTS.
    const phantoms = ['dsh-phantom0', 'dsh-phantom1', 'dsh-phantom2', 'dsh-phantom3']
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'feed-state.json'), `${JSON.stringify({
        seq: 117350001,
        carriers: Object.fromEntries(phantoms.map(name => [name, { owner: 'alice', keywords: ['deepseek-harness'] }])),
        pending: [],
      }, null, 2)}\n`)
      const packumentOf = (name: string): unknown => ({
        name,
        'dist-tags': { latest: '1.0.0' },
        versions: { '1.0.0': { name, version: '1.0.0', keywords: ['deepseek-harness'], maintainers: [{ name: 'alice' }] } },
        maintainers: [{ name: 'alice' }],
      })
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'replicate.npmjs.com/registry/_changes', body: { results: [], last_seq: 117350001 } },
        { contains: 'replicate.npmjs.com/registry/', body: { db_name: 'registry', update_seq: 117350001 } },
        { contains: 'maintainer%3Aalice', body: { total: 0, objects: [] } },
        { contains: 'keywords%3Adsh-plugin&size=1', body: { total: 1, objects: [] } },
        { contains: 'keywords%3Adsh-plugin&', body: searchPage(1, ['dsh-a'], ['bob']) },
        { contains: 'keywords%3Adeepseek-harness&size=1', body: { total: 1, objects: [] } },
        { contains: 'keywords%3Adeepseek-harness&', body: searchPage(1, ['dsh-b'], ['bob']) },
        ...phantoms.map(name => ({ contains: `/${name}`, body: packumentOf(name) })),
      ])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('membership rule no longer describes npm search')
      expect(run.stderr).toContain('classify: keywords:deepseek-harness publisher axis')
      expect(existsSync(join(cwd, 'dist', 'publisher-axis.json'))).toBe(false)
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
      expect(vocabulary(cwd)).toEqual({ publishers: ['alice', 'bob'], cursor: 0, cursors: {}, pinned: {} })
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
      expect(vocabulary(cwd)).toEqual({ publishers: ['alice'], cursor: 0, cursors: {}, pinned: {} })
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
    ['missing cursor', '[{"keyword":"dsh-plugin","vocabulary":0,"partitioned":false,"seedingComplete":true,"pinnedSet":0,"pinnedProbed":0,"pinnedSupplied":0,"rotatedProbed":0,"rotatedSupplied":0,"stepped":0,"seeded":[],"evicted":[],"judged":[],"atRiskNames":0}]'],
    ['missing rotatedProbed', '[{"keyword":"dsh-plugin","vocabulary":0,"partitioned":false,"seedingComplete":true,"pinnedSet":0,"pinnedProbed":0,"pinnedSupplied":0,"cursor":0,"rotatedSupplied":0,"stepped":0,"seeded":[],"evicted":[],"judged":[],"atRiskNames":0}]'],
    ['an ungrammatical seeded username', '[{"keyword":"dsh-plugin","vocabulary":0,"partitioned":false,"seedingComplete":true,"pinnedSet":0,"pinnedProbed":0,"pinnedSupplied":0,"cursor":0,"rotatedProbed":0,"rotatedSupplied":0,"stepped":0,"seeded":["Alice"],"evicted":[],"judged":[],"atRiskNames":0}]'],
    // A dangerous keyword is exactly as unusable as a missing one: it reaches
    // pinFor/unpinFor as the map key, and pinFor's own guard now refuses it --
    // but parsePublisherAxisReport must refuse it itself, at the handoff
    // boundary, the same way it refuses an ungrammatical seeded username
    // rather than leaving that to whatever pinFor happens to do with it.
    ['a dangerous keyword', '[{"keyword":"__proto__","vocabulary":0,"partitioned":false,"seedingComplete":true,"pinnedSet":0,"pinnedProbed":0,"pinnedSupplied":0,"cursor":0,"rotatedProbed":0,"rotatedSupplied":0,"stepped":0,"seeded":[],"evicted":[],"judged":[],"atRiskNames":0}]'],
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

  it('advances each keyword\'s own cursor by what that keyword WALKED', () => {
    // Two things at once, and both were wrong before. The advance is
    // `stepped` -- vocabulary positions walked -- not the budget and not the
    // rotation length; and it lands on the keyword's OWN cursor, so a
    // more-pinned keyword walking a shorter band is not dragged past what it
    // covered by the other keyword's longer one. 600 publishers is comfortably
    // above the probe budget, so these positions can only come from the
    // records.
    const cwd = newWorkspace()
    try {
      const publishers = Array.from({ length: 600 }, (_, i) => `u${String(i).padStart(3, '0')}`)
      writeFileSync(join(cwd, 'registry', 'publisher-state.json'),
        `${JSON.stringify({ publishers, cursor: 0 }, null, 2)}\n`)
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      const record = (keyword: string, stepped: number) => ({
        keyword, partitioned: true, seedingComplete: false, vocabulary: 600, pinnedSet: 0, pinnedProbed: 0, pinnedSupplied: 0,
        cursor: 0, rotatedProbed: stepped, rotatedSupplied: 0, stepped,
        seeded: [], evicted: [], judged: [], atRiskNames: 0,
      })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [],
        publisherAxis: [record('dsh-plugin', 42), record('deepseek-harness', 17)],
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      // A shared cursor advanced by max(42, 17) would put deepseek-harness at
      // 42, skipping the 25 publishers it never walked -- and at a vocabulary
      // commensurate with the advance, skipping the same band forever.
      expect(vocabulary(cwd)).toMatchObject({ cursors: { 'dsh-plugin': 42, 'deepseek-harness': 17 } })
      // The legacy field is the minimum, so a reader predating `cursors`
      // re-probes a band rather than skipping one.
      expect(vocabulary(cwd)).toMatchObject({ cursor: 17 })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('says which exit released a keyword\'s pins: the keyword counted whole, or a judged probe', () => {
    // Both exits used to print one sentence, so a reader could not tell a
    // keyword inside its window shedding the pins its complete seeding no
    // longer names from a keyword past it releasing pins its own probes judged
    // (PR #108 review). One record of each, one pin released by each.
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'publisher-state.json'), `${JSON.stringify({
        publishers: ['alice', 'bob'], cursor: 0, pinned: { 'dsh-plugin': ['alice'], 'deepseek-harness': ['bob'] },
      }, null, 2)}\n`)
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      const common = {
        vocabulary: 2, pinnedSet: 1, pinnedSupplied: 0, cursor: 0, rotatedProbed: 0, rotatedSupplied: 0, stepped: 0,
        seeded: [], evicted: [], atRiskNames: 0,
      }
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [],
        publisherAxis: [
          { ...common, keyword: 'dsh-plugin', partitioned: false, seedingComplete: true, pinnedProbed: 0, judged: [] },
          { ...common, keyword: 'deepseek-harness', partitioned: true, seedingComplete: false, pinnedProbed: 1, judged: ['bob'] },
        ],
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const axisLine = (keyword: string) =>
        run.stderr.split('\n').find(line => line.startsWith(`npm: keywords:${keyword} publisher axis`)) ?? ''
      expect(axisLine('dsh-plugin')).toContain('released 1 pin(s) seeding no longer names, the keyword counted whole inside its window')
      expect(axisLine('deepseek-harness')).toContain('released 1 judged pin(s) seeding no longer names')
      expect(axisLine('deepseek-harness')).not.toContain('counted whole')
      // The report the reader sees, not only stderr: the sentence is published
      // there too, and a stderr-only assertion leaves half the artifact free to
      // say something else (PR-1 review; CLAUDE.md, "Assert on every artifact a
      // property claims to cover").
      const report = readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')
      expect(report).toContain('released 1 pin(s) seeding no longer names, the keyword counted whole inside its window')
      expect(report).toContain('released 1 judged pin(s) seeding no longer names')
      expect((vocabulary(cwd) as { pinned?: unknown }).pinned).toEqual({})
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('says so in the report when a handoff carries no publisher axis at all', () => {
    // A handoff written before the field existed pins nothing, evicts nothing
    // and advances no cursor, so every subsequent run re-probes the same band
    // while the vocabulary grows -- the failure the cursor exists to prevent,
    // and it looked exactly like a healthy run with nothing to do, because the
    // heading was simply absent.
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'),
        '{"candidates":[],"rejections":[],"shortfalls":[]}\n')
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(run.stderr).toContain('no publisher axis record this run')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('build.ts --axis-from', () => {
  // A run that fails its coverage check hands its publisher axis over in
  // dist/publisher-axis.json, and this mode commits it alone (design
  // 2026-10-22). The state must be the one a passing run's full build would
  // have written from the same records, through the same function.
  const publishers = Array.from({ length: 600 }, (_, i) => `u${String(i).padStart(3, '0')}`)
  const committed = `${JSON.stringify({
    publishers, cursor: 0, pinned: { 'dsh-plugin': ['u000', 'u001'], 'deepseek-harness': ['u002'] },
  }, null, 2)}\n`
  const record = (keyword: string, over: Record<string, unknown>) => ({
    keyword, partitioned: true, seedingComplete: false, vocabulary: 600, pinnedSet: 0, pinnedProbed: 0,
    pinnedSupplied: 0, cursor: 0, rotatedProbed: 0, rotatedSupplied: 0, stepped: 0,
    seeded: [], evicted: [], judged: [], atRiskNames: 0, ...over,
  })
  // dsh-plugin judged u001 and seeding no longer names it, so it is
  // released; deepseek-harness seeds u100. Both keywords step their cursor.
  const axis = [
    record('dsh-plugin', { pinnedSet: 2, pinnedProbed: 2, rotatedProbed: 40, stepped: 42, seeded: ['u000'], judged: ['u001'], atRiskNames: 1 }),
    record('deepseek-harness', { pinnedSet: 1, pinnedProbed: 1, rotatedProbed: 17, stepped: 17, seeded: ['u002', 'u100'], atRiskNames: 2 }),
  ]
  const seen = ['u600', 'u601']
  /** A workspace holding the committed state above and `files` under dist/. */
  const workspace = (files: Record<string, unknown>): string => {
    const cwd = newWorkspace()
    writeFileSync(join(cwd, 'registry', 'publisher-state.json'), committed)
    mkdirSync(join(cwd, 'dist'), { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, 'dist', name), `${JSON.stringify(body)}\n`)
    return cwd
  }
  const stateOf = (cwd: string): string => readFileSync(join(cwd, 'registry', 'publisher-state.json'), 'utf8')

  it('writes the publisher state a full build writes from the same records, and nothing else', () => {
    const full = workspace({ 'harvest.json': { candidates: [], rejections: [], shortfalls: [], publishers: seen, publisherAxis: axis } })
    const alone = workspace({ 'publisher-axis.json': { publishers: seen, publisherAxis: axis } })
    try {
      const fullRun = runEntry(full, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(fullRun.status, `stderr:\n${fullRun.stderr}`).toBe(0)
      const run = runEntry(alone, 'build.ts', ['--axis-from', 'dist/publisher-axis.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(stateOf(alone)).toBe(stateOf(full))
      // The records did something, so the equality above is not two
      // untouched copies of the committed file.
      expect(stateOf(alone)).not.toBe(committed)
      expect(existsSync(join(alone, 'dist', 'v1'))).toBe(false)
      expect(existsSync(join(alone, 'registry', 'snapshots', 'manifest.lock'))).toBe(false)
      expect(existsSync(join(alone, 'registry', 'feed-state.json'))).toBe(false)
      expect(existsSync(join(alone, 'registry', 'first-seen.yml'))).toBe(false)
      expect(run.urls).toEqual([])
      expect(run.stderr).toContain('released 1 judged pin(s) seeding no longer names')
      expect(run.stderr).toContain('publisher vocabulary 600 -> 602')
    } finally {
      rmSync(full, { recursive: true, force: true })
      rmSync(alone, { recursive: true, force: true })
    }
  })

  it('refuses a file without publisherAxis, and leaves the committed state as it was', () => {
    const cwd = workspace({ 'publisher-axis.json': { publishers: seen } })
    try {
      const run = runEntry(cwd, 'build.ts', ['--axis-from', 'dist/publisher-axis.json'], [])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('publisherAxis')
      expect(stateOf(cwd)).toBe(committed)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses a handoff naming a username the vocabulary grammar refuses', () => {
    const cwd = workspace({ 'publisher-axis.json': { publishers: ['bad user'], publisherAxis: axis } })
    try {
      const run = runEntry(cwd, 'build.ts', ['--axis-from', 'dist/publisher-axis.json'], [])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('is not a maintainer username')
      expect(stateOf(cwd)).toBe(committed)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('refuses --harvest-from beside it', () => {
    const cwd = workspace({
      'publisher-axis.json': { publishers: seen, publisherAxis: axis },
      'harvest.json': { candidates: [], rejections: [], shortfalls: [] },
    })
    try {
      const run = runEntry(cwd, 'build.ts', ['--axis-from', 'dist/publisher-axis.json', '--harvest-from', 'dist/harvest.json'], [])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('cannot be combined with --harvest-from')
      expect(stateOf(cwd)).toBe(committed)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('the change feed rides the handoff into the committed file', () => {
  const feedState = (seq: number): string =>
    `{\n  "seq": ${seq},\n  "carriers": {\n    "dsh-feedonly": {"owner":"alice","keywords":["dsh-plugin"]}\n  },\n  "pending": []\n}\n`
  /** dsh-feedonly's full packument: its latest version lists dsh-plugin and
   * was published by alice; `owners` are its maintainers today. */
  const feedPackument = (owners: readonly string[]): unknown => ({
    name: 'dsh-feedonly',
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name: 'dsh-feedonly', version: '1.0.0', keywords: ['dsh-plugin'], maintainers: [{ name: 'alice' }] } },
    maintainers: owners.map(name => ({ name })),
  })
  const feedReport = {
    available: true, note: '', fromSeq: 117350000, toSeq: 117350001, pages: 1, selected: 1, read: 1, failed: 0,
    unreached: 0, refused: 0, pending: 0, carriers: { 'dsh-plugin': 1, 'deepseek-harness': 0 },
  }

  it('classify.ts reads the feed, credits a verified name, and hands the next state on', () => {
    const cwd = newWorkspace()
    try {
      // Specific before general, because the first match wins: the head
      // URL is a prefix of the page URL, and alice's cell URL contains
      // `from=0`.
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'replicate.npmjs.com/registry/_changes',
          body: { results: [{ seq: 117350001, id: 'dsh-feedonly', changes: [{ rev: '1-a' }] }], last_seq: 117350001 } },
        { contains: 'replicate.npmjs.com/registry/', body: { db_name: 'registry', update_seq: 117350001 } },
        { contains: 'maintainer%3Aalice', body: searchPage(1, ['dsh-feedonly'], ['alice']) },
        { contains: 'size=1', body: { total: 2, objects: [] } },
        { contains: 'from=0', body: searchPage(2, ['dsh-a'], ['bob']) },
        { contains: '/-/v1/search', body: { total: 2, objects: [] } },
        { contains: '/dsh-feedonly', body: feedPackument(['alice']) },
        { contains: '/dsh-a', body: packument('dsh-a') },
      ])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'harvest.json'), 'utf8')) as {
        candidates: { name: string }[]; rejections: { name: string }[]
        feed: { state: string; coverage: { keyword: string; verified: number }[] }
      }
      expect([...handoff.candidates, ...handoff.rejections].map(c => c.name)).toContain('dsh-feedonly')
      expect(handoff.feed.state).toBe(feedState(117350001))
      expect(handoff.feed.coverage.find(c => c.keyword === 'dsh-plugin')?.verified).toBe(1)
      expect(existsSync(join(cwd, 'registry', 'feed-state.json'))).toBe(false)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts --harvest-from writes the handed-off state, and makes no request for it', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
        feed: { state: feedState(117350001), report: feedReport, coverage: [] },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(readFileSync(join(cwd, 'registry', 'feed-state.json'), 'utf8')).toBe(feedState(117350001))
      expect(readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')).toContain('change feed: seq 117350000 -> 117350001')
      // Nothing is requested for the feed, nor for anything else the handoff
      // already carries. The one request is the icon step's look at the
      // published catalog, which every build makes (design
      // 2026-10-23-shop-plugin-icons §5.1); this fixture has no rule for it, so
      // it fails, and the build goes on without yesterday's icons.
      expect(run.urls).toEqual([PUBLISHED_INDEX_URL])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts refuses a handed-off state behind the committed file', () => {
    // Review Focus 4.
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'feed-state.json'), feedState(117350005))
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
        feed: { state: feedState(117350001), report: feedReport, coverage: [] },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('would move the cursor backwards')
      expect(readFileSync(join(cwd, 'registry', 'feed-state.json'), 'utf8')).toBe(feedState(117350005))
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts leaves the committed file alone when the handoff carries no feed record', () => {
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'feed-state.json'), feedState(117350005))
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(readFileSync(join(cwd, 'registry', 'feed-state.json'), 'utf8')).toBe(feedState(117350005))
      expect(readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')).toContain('no change-feed record in this handoff')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('classify.ts confirms a committed owner that has since changed, and hands the current owner on', () => {
    // The committed state stored alice for dsh-feedonly; bob owns it today
    // and this run's feed rows do not touch it, so it is not re-read. Alice's
    // cell omits it twice, the confirmation reads the packument, re-verifies
    // with bob, and the next state stores bob (PR #74 review).
    const cwd = newWorkspace()
    try {
      writeFileSync(join(cwd, 'registry', 'feed-state.json'),
        '{\n  "seq": 117350000,\n  "carriers": {\n    "dsh-feedonly": {"owner":"alice","keywords":["dsh-plugin"]}\n  },\n  "pending": []\n}\n')
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'replicate.npmjs.com/registry/_changes', body: { results: [], last_seq: 117350001 } },
        { contains: 'replicate.npmjs.com/registry/', body: { db_name: 'registry', update_seq: 117350001 } },
        { contains: 'maintainer%3Aalice', body: searchPage(0, [], []) },
        { contains: 'maintainer%3Abob', body: searchPage(1, ['dsh-feedonly'], ['bob']) },
        { contains: 'size=1', body: { total: 2, objects: [] } },
        { contains: 'from=0', body: searchPage(2, ['dsh-a'], ['carol']) },
        { contains: '/-/v1/search', body: { total: 2, objects: [] } },
        { contains: '/dsh-feedonly', body: feedPackument(['bob']) },
        { contains: '/dsh-a', body: packument('dsh-a') },
      ])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'harvest.json'), 'utf8')) as {
        feed: { state: string; coverage: { keyword: string; verified: number; disagreed: string[] }[] }
      }
      expect(handoff.feed.coverage.find(c => c.keyword === 'dsh-plugin')).toMatchObject({ verified: 1, disagreed: [] })
      expect(handoff.feed.state).toContain('"dsh-feedonly": {"owner":"bob","keywords":["dsh-plugin"]}')
      expect(run.urls.filter(url => url.includes('maintainer%3Aalice'))).toHaveLength(2)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('a listed npm package the harvest lost (design 2026-09-26-market-borrowings §8)', () => {
  /** A packument the gate lists: bundle, license, repository, integrity, publish time, description. */
  function listable(name: string): unknown {
    return {
      name,
      'dist-tags': { latest: '1.0.0' },
      time: { '1.0.0': '2026-09-01T00:00:00.000Z' },
      maintainers: [{ name: 'bob' }],
      versions: {
        '1.0.0': {
          name, version: '1.0.0', keywords: ['dsh-plugin'], license: 'MIT', description: 'A plugin the search stopped returning.',
          repository: { type: 'git', url: `git+https://github.com/bob/${name}.git` },
          // The name in base64, not the bare name: the gate refuses a hyphen
          // in an SRI hash, and classify-select.ts counts only a name the gate
          // accepts as live, so a refused dsh-kept would lose its
          // categories.yml row for a reason that is not the departure step's.
          dist: { integrity: `sha512-${Buffer.from(name).toString('base64')}` }, dsh: { bundle: { patch: './cordis.patch.yml' } },
        },
      },
    }
  }
  // A double quote, a pipe and a newline: each would end the quotation, the
  // cell or the row early if it reached report.md unescaped.
  const MESSAGE = 'Renamed to "dsh-new" | see the README\nfor the move'
  const DEPRECATED_DETAIL = `Marked deprecated on npm: ${JSON.stringify(MESSAGE)}.`
  // The row report.md must carry for that detail, worked out by hand, not by
  // the code under test. JSON.stringify writes the quote as \" and the newline
  // as the two characters \n; escapeCell (emit.ts) then writes the pipe as \|,
  // finds no raw CR, LF or tab left to turn into a space, and leaves every
  // backslash alone. One row.
  const DEPRECATED_ROW = '| dsh-gone | deprecated | Marked deprecated on npm: "Renamed to \\"dsh-new\\" \\| see the README\\nfor the move". |'

  it('classify.ts rows a deprecated departure and carries a qualifying one, keeping its category row', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'registry', 'snapshots'), { recursive: true })
      writeFileSync(join(cwd, 'registry', 'snapshots', 'manifest.lock'),
        'dsh-a 1.0.0 sha512-a\ndsh-gone 1.0.0 sha512-g\ndsh-kept 1.0.0 sha512-k\n')
      writeFileSync(join(cwd, 'registry', 'categories.yml'), '- name: "dsh-kept"\n  category: tool\n')
      const run = runEntry(cwd, 'classify.ts', [], [
        { contains: 'size=1', body: { total: 1, objects: [] } },
        { contains: '/-/v1/search', body: searchPage(1, ['dsh-a'], ['bob']) },
        { contains: '/dsh-gone', body: { name: 'dsh-gone', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'dsh-gone', version: '1.0.0', keywords: ['dsh-plugin'], deprecated: MESSAGE } } } },
        { contains: '/dsh-kept', body: listable('dsh-kept') },
        { contains: '/dsh-a', body: packument('dsh-a') },
      ])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const handoff = JSON.parse(readFileSync(join(cwd, 'dist', 'harvest.json'), 'utf8')) as {
        candidates: { name: string }[]; rejections: unknown[]; departures?: unknown
      }
      // 2 departed = 1 carried (dsh-kept) + 1 deprecated (dsh-gone).
      expect(handoff.departures).toEqual({ departed: 2, carried: ['dsh-kept'], deprecated: 1, npmGone: 0 })
      expect(handoff.rejections).toContainEqual({ name: 'dsh-gone', code: 'deprecated', detail: DEPRECATED_DETAIL })
      expect(handoff.candidates.map(c => c.name)).toContain('dsh-kept')
      // The classifier prunes every categories.yml row its live names do not
      // hold; a carried package must keep its own.
      expect(readFileSync(join(cwd, 'registry', 'categories.yml'), 'utf8')).toContain('"dsh-kept"')
      expect(run.stderr).toContain('npm packages missing from the harvest since the last catalog: 2 (carried 1, deprecated 1, npm-gone 0)')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts harvesting on its own rows a deprecated departure and lists a carried one through the gate', () => {
    // The fresh branch: what a local build runs, where daily.yml passes
    // --harvest-from. The classify.ts test's lock and routes, through
    // build.ts's own departure call.
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'registry', 'snapshots'), { recursive: true })
      writeFileSync(join(cwd, 'registry', 'snapshots', 'manifest.lock'),
        'dsh-a 1.0.0 sha512-a\ndsh-gone 1.0.0 sha512-g\ndsh-kept 1.0.0 sha512-k\n')
      const run = runEntry(cwd, 'build.ts', [], [
        { contains: 'size=1', body: { total: 1, objects: [] } },
        { contains: '/-/v1/search', body: searchPage(1, ['dsh-a'], ['bob']) },
        { contains: '/dsh-gone', body: { name: 'dsh-gone', 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { name: 'dsh-gone', version: '1.0.0', keywords: ['dsh-plugin'], deprecated: MESSAGE } } } },
        { contains: '/dsh-kept', body: listable('dsh-kept') },
        { contains: '/dsh-a', body: packument('dsh-a') },
      ])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const report = readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')
      expect(report).toContain('npm packages missing from the harvest since the last catalog: 2 (carried 1, deprecated 1, npm-gone 0)')
      expect(report).toContain('- carried, still carrying a harvest keyword that neither npm search nor the change feed returned: dsh-kept\n')
      expect(report.split('\n').filter(line => line.startsWith('| dsh-gone |'))).toEqual([DEPRECATED_ROW])
      // In the published data, so the carried candidate went through the gate.
      const index = JSON.parse(readFileSync(join(cwd, 'dist', 'v1', 'index.json'), 'utf8')) as { plugins: { url: string } }
      const data = JSON.parse(readFileSync(join(cwd, 'dist', 'v1', index.plugins.url), 'utf8')) as { plugins: { name: string }[] }
      expect(data.plugins.map(entry => entry.name)).toEqual(['dsh-kept'])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts --harvest-from publishes the departures line, and the message cannot break its row', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [{ name: 'dsh-gone', code: 'deprecated', detail: DEPRECATED_DETAIL }],
        shortfalls: [], publishers: [],
        departures: { departed: 1, carried: [], deprecated: 1, npmGone: 0 },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      const report = readFileSync(join(cwd, 'dist', 'v1', 'report.md'), 'utf8')
      expect(report).toContain('npm packages missing from the harvest since the last catalog: 1 (carried 0, deprecated 1, npm-gone 0)')
      expect(report.split('\n').filter(line => line.startsWith('| dsh-gone |'))).toEqual([DEPRECATED_ROW])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('build.ts refuses a handoff whose departures do not add up', () => {
    const cwd = newWorkspace()
    try {
      mkdirSync(join(cwd, 'dist'), { recursive: true })
      writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
        candidates: [], rejections: [], shortfalls: [], publishers: [],
        departures: { departed: 2, carried: [], deprecated: 1, npmGone: 0 },
      })}\n`)
      const run = runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], [])
      expect(run.status).not.toBe(0)
      expect(run.stderr).toContain('expected `departures`')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('the icon step rides the daily build (design 2026-10-23-shop-plugin-icons)', () => {
  // The build is run as CI runs it, from a handoff with one listed plugin that
  // declares `icon.svg`. Everything the icon step touches is read back from
  // disk. The icon is a real one and its digests are made here, by node:crypto
  // and Buffer and not by the modules under test, so the files the build writes
  // are held to an oracle of their own.
  const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><title>icon</title></svg>')
  const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
  const ICON_SHA = sha256(SVG)
  const DATA_URL = `data:image/svg+xml;base64,${SVG.toString('base64')}`
  const KEY = 'npm:dsh-icon-plugin@1.0.0:icon.svg'
  const INDEX_URL = PUBLISHED_INDEX_URL
  const TARBALL_URL = 'https://registry.npmjs.org/dsh-icon-plugin/-/dsh-icon-plugin-1.0.0.tgz'

  /** The record after a build that published the icon, as `serializeIconState` writes it. */
  const PUBLISHED_RECORD = `${JSON.stringify({
    [KEY]: { outcome: 'published', sha256: ICON_SHA, mediaType: 'image/svg+xml', bytes: SVG.length },
  }, null, 2)}\n`

  // Yesterday's published catalog, as the fixture serves it. The preload
  // answers with `JSON.stringify(body)`, so the bytes the pointer's hash covers
  // are the ones hashed here.
  const publishedFile = { icons: { [ICON_SHA]: DATA_URL }, sources: { [KEY]: ICON_SHA } }
  const publishedSha = sha256(JSON.stringify(publishedFile))
  const PUBLISHED_ICONS_URL = new URL(`icons.${publishedSha}.json`, PUBLISHED_CATALOG_URL).href
  const PUBLISHED_RULES = [
    { contains: 'v1/index.json', body: { icons: { url: `icons.${publishedSha}.json`, sha256: publishedSha } } },
    { contains: `icons.${publishedSha}.json`, body: publishedFile },
  ]

  /** A workspace holding the handoff of one plugin the gate lists, and the record when given. */
  function workspace(options: { icon?: boolean; record?: string } = {}): string {
    const cwd = newWorkspace()
    mkdirSync(join(cwd, 'dist'), { recursive: true })
    const icon = options.icon ?? true
    writeFileSync(join(cwd, 'dist', 'harvest.json'), `${JSON.stringify({
      candidates: [{
        name: 'dsh-icon-plugin', version: '1.0.0', integrity: 'sha512-icon', publishedAt: '2026-08-01T12:00:00.000Z',
        repository: 'https://github.com/you/icon-plugin', license: 'MIT', deprecated: false, hasBundle: true,
        catalog: { category: 'tool', summary: { en: 'Draws an icon', zh: '画一个图标' }, capabilities: [] },
        description: 'A plugin that declares an icon.', keywords: [], peers: [],
        ...(icon
          ? { icon: { kind: 'declared', declaration: { source: 'icon', path: 'icon.svg', mediaType: 'image/svg+xml' } }, distTarball: TARBALL_URL }
          : {}),
      }],
      rejections: [], shortfalls: [], publishers: [],
    })}\n`)
    if (options.record !== undefined) writeFileSync(join(cwd, 'registry', 'icon-state.json'), options.record)
    return cwd
  }

  const buildFrom = (cwd: string, rules: readonly unknown[] = [], env: NodeJS.ProcessEnv = {}): Run =>
    runEntry(cwd, 'build.ts', ['--harvest-from', 'dist/harvest.json'], rules, env)

  const out = (cwd: string, ...path: string[]): string => join(cwd, 'dist', 'v1', ...path)
  const readIndex = (cwd: string): { plugins: { url: string }; icons?: { url: string; sha256: string } } =>
    JSON.parse(readFileSync(out(cwd, 'index.json'), 'utf8')) as { plugins: { url: string }; icons?: { url: string; sha256: string } }
  /** Each listed entry's name and, when it carries one, its icon: the rest of an entry is not this step's. */
  const readEntries = (cwd: string): { name: string; icon?: string }[] =>
    (JSON.parse(readFileSync(out(cwd, readIndex(cwd).plugins.url), 'utf8')) as { plugins: { name: string; icon?: string }[] }).plugins
      .map(({ name, icon }) => ({ name, ...(icon === undefined ? {} : { icon }) }))
  const iconFiles = (dir: string): string[] => readdirSync(dir).filter(name => name.startsWith('icons.'))

  it('writes the sidecar, points the index and the entry at it, stages it for Pages and keeps the record', () => {
    const cwd = workspace({ record: PUBLISHED_RECORD })
    try {
      const run = buildFrom(cwd, PUBLISHED_RULES)
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      // The file as the design states it (§6.1): both maps in code-unit order,
      // two-space JSON and one trailing newline, named by its own hash.
      const sidecar = `${JSON.stringify({ icons: { [ICON_SHA]: DATA_URL }, sources: { [KEY]: ICON_SHA } }, null, 2)}\n`
      const name = `icons.${sha256(sidecar)}.json`
      expect(readFileSync(out(cwd, name), 'utf8')).toBe(sidecar)
      const index = readIndex(cwd)
      expect(index.icons).toEqual({ url: name, sha256: sha256(sidecar) })
      expect(readEntries(cwd)).toEqual([{ name: 'dsh-icon-plugin', icon: ICON_SHA }])
      // Pages stages what the index names, the icons file included, and no other data file.
      expect(readdirSync(join(cwd, 'dist', 'pages', 'v1')).sort())
        .toEqual(['badge.json', 'index.json', name, index.plugins.url, 'report.md'].sort())
      // Nothing was fetched for the icon: the record and yesterday's file carried it.
      expect(run.urls).toEqual([INDEX_URL, PUBLISHED_ICONS_URL])
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe(PUBLISHED_RECORD)
      // The section is the last block of the report, in one piece.
      const report = readFileSync(out(cwd, 'report.md'), 'utf8')
      expect(report).toContain(
        `\n## Icons\n\nDeclared 1: published 1, withheld by hand 0, withheld for size 0, refused 0, not read 0, not yet read 0. Icons file: ${Buffer.byteLength(sidecar)} bytes.\n`,
      )
      expect(report.endsWith(' bytes.\n')).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('writes no sidecar and no pointer when no listed plugin has an icon, and commits an empty record', () => {
    const cwd = workspace({ icon: false })
    try {
      const run = buildFrom(cwd)
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(iconFiles(out(cwd))).toEqual([])
      expect(iconFiles(join(cwd, 'dist', 'pages', 'v1'))).toEqual([])
      expect('icons' in readIndex(cwd)).toBe(false)
      expect(readEntries(cwd)).toEqual([{ name: 'dsh-icon-plugin' }])
      // The record is still written, so the snapshot step has a file to commit.
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe('{}\n')
      expect(readFileSync(out(cwd, 'report.md'), 'utf8')).toContain(
        '\n## Icons\n\nDeclared 0: published 0, withheld by hand 0, withheld for size 0, refused 0, not read 0, not yet read 0. Icons file: none.\n',
      )
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('stops on a malformed record before it requests, writes or publishes anything', () => {
    const malformed = '{"npm:dsh-icon-plugin@1.0.0:icon.svg":{"outcome":"mystery"}}\n'
    const cwd = workspace({ record: malformed })
    try {
      const run = buildFrom(cwd, PUBLISHED_RULES)
      expect(run.status).not.toBe(0)
      expect(run.stderr, `stderr:\n${run.stderr}`).toContain('icon-state.json')
      expect(run.stderr).not.toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME')
      expect(run.stderr).not.toContain('preload-fetch:')
      expect(run.urls).toEqual([])
      expect(existsSync(out(cwd, 'index.json'))).toBe(false)
      expect(existsSync(join(cwd, 'registry', 'first-seen.yml'))).toBe(false)
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe(malformed)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  for (const variable of ['ICON_FETCH_BUDGET', 'ICON_FETCH_TIME_BUDGET_MS', 'CATALOG_JOB_DEADLINE_MS']) {
    it(`stops on a mistyped ${variable} before it requests or writes anything`, () => {
      // A NaN deadline is no deadline and a count that reads as zero fetches
      // nothing; either would be reported as a healthy run.
      const cwd = workspace()
      try {
        const run = buildFrom(cwd, PUBLISHED_RULES, { [variable]: 'soon' })
        expect(run.status).not.toBe(0)
        expect(run.stderr, `stderr:\n${run.stderr}`).toContain(`${variable} must be a non-negative safe integer; got "soon"`)
        expect(run.stderr).not.toContain('preload-fetch:')
        expect(run.urls).toEqual([])
        expect(existsSync(out(cwd, 'index.json'))).toBe(false)
        expect(existsSync(join(cwd, 'registry', 'icon-state.json'))).toBe(false)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }

  it('publishes the entry without its icon, keeps the record and says why, when the published file is lost and the budget is zero', () => {
    // Budget zero is an instruction and not a typo: fetch nothing. The record
    // names the icon published, yesterday's file cannot be read (the fixture has
    // no rule for it), so the bytes are nowhere this build.
    const cwd = workspace({ record: PUBLISHED_RECORD })
    try {
      const run = buildFrom(cwd, [], { ICON_FETCH_BUDGET: '0' })
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(run.urls).toEqual([INDEX_URL])
      expect(iconFiles(out(cwd))).toEqual([])
      expect('icons' in readIndex(cwd)).toBe(false)
      expect(readEntries(cwd)).toEqual([{ name: 'dsh-icon-plugin' }])
      // Out of reach today, not gone: the next build fetches it against the sha256 recorded.
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe(PUBLISHED_RECORD)
      const report = readFileSync(out(cwd, 'report.md'), 'utf8')
      expect(report).toContain('Declared 1: published 0, withheld by hand 0, withheld for size 0, refused 0, not read 0, not yet read 1. Icons file: none.\n')
      // The line counts the fetches the budgets started, which a plan's fetch
      // the time budget never reached is not (describeLostIconsFile).
      expect(report.endsWith(
        '\nThe published icons file could not be read, so icons recorded as published were fetched again: 0 started within this build\'s budgets, 1 turned away by them.\n',
      )).toBe(true)
      expect(run.stderr).toContain('The published icons file could not be read')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('says no file was lost the day after a build that published none, though the record holds the icon', () => {
    // Yesterday every icon was withheld, so its index points at no icons file.
    // That is an answer, the empty file, and the line about a file that could
    // not be read is not true of it.
    const cwd = workspace({ record: PUBLISHED_RECORD })
    try {
      // The index a build that published no icons writes: the catalog's own
    // fields, and no `icons` pointer. A body with neither is not an index, and
    // reading it as one would hide an unreadable file (`readPublished`).
    const run = buildFrom(cwd, [{ contains: 'v1/index.json', body: { schemaVersion: 5, plugins: { url: 'plugins.x.json', sha256: '0'.repeat(64) } } }], { ICON_FETCH_BUDGET: '0' })
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(run.urls).toEqual([INDEX_URL])
      const report = readFileSync(out(cwd, 'report.md'), 'utf8')
      expect(report).toContain('Declared 1: published 0, withheld by hand 0, withheld for size 0, refused 0, not read 0, not yet read 1. Icons file: none.\n')
      expect(report).not.toContain('could not be read')
      expect(run.stderr).not.toContain('The published icons file could not be read')
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe(PUBLISHED_RECORD)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('starts no fetch once the time budget is spent, says so, and leaves the key for the next build', () => {
    // Zero is an instruction here as it is for the count: the deadline has
    // passed before the first fetch, so none is started.
    const cwd = workspace()
    try {
      const run = buildFrom(cwd, [], { ICON_FETCH_TIME_BUDGET_MS: '0' })
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(run.urls).toEqual([INDEX_URL])
      expect(run.stderr).toContain('icons: 1 of 1 planned fetches were not started: the time budget of 0 ms ran out')
      expect(readEntries(cwd)).toEqual([{ name: 'dsh-icon-plugin' }])
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe('{}\n')
      expect(readFileSync(out(cwd, 'report.md'), 'utf8')).toContain('Declared 1: published 0, withheld by hand 0, withheld for size 0, refused 0, not read 0, not yet read 1.')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('starts no icon fetch once the job\'s deadline has passed, says so, and still publishes', () => {
    // The deadline is the moment the catalog build must be done by, which the
    // workflow's first step writes. Past it the icon step has no time left at
    // all: the key is left for the next build, and the catalog publishes.
    // A minute ago, not the epoch: build.ts refuses a deadline older than any
    // job could be, which is what a step whose clock failed writes.
    const cwd = workspace()
    try {
      const run = buildFrom(cwd, [], { CATALOG_JOB_DEADLINE_MS: String(Date.now() - 60_000) })
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(run.urls).toEqual([INDEX_URL])
      expect(run.stderr).toContain(`icons: 1 of 1 planned fetches were not started: the time budget of 0 ms, cut from ${ICON_FETCH_TIME_BUDGET_MS_DEFAULT} ms to the time the job had left, ran out`)
      expect(readEntries(cwd)).toEqual([{ name: 'dsh-icon-plugin' }])
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe('{}\n')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('fetches as it always has when the deadline is far off', () => {
    const cwd = workspace()
    try {
      const run = buildFrom(cwd, [], { CATALOG_JOB_DEADLINE_MS: String(Date.now() + 24 * 60 * 60 * 1000) })
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(run.urls).toEqual([INDEX_URL, TARBALL_URL])
      expect(run.stderr).not.toContain('planned fetches were not started')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('goes on when a fetch fails: the entry publishes without its icon, nothing is recorded, the next build asks again', () => {
    // The tarball request has no rule, so it fails the way a timeout does. A
    // transport failure says nothing about the package, so it is not a refusal
    // and leaves no row.
    const cwd = workspace()
    try {
      const run = buildFrom(cwd)
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      expect(run.urls).toEqual([INDEX_URL, TARBALL_URL])
      expect(run.stderr).toContain(`icons: not yet read ${JSON.stringify(KEY)}: `)
      expect(readEntries(cwd)).toEqual([{ name: 'dsh-icon-plugin' }])
      expect(readFileSync(join(cwd, 'registry', 'icon-state.json'), 'utf8')).toBe('{}\n')
      expect(readFileSync(out(cwd, 'report.md'), 'utf8')).toContain('Declared 1: published 0, withheld by hand 0, withheld for size 0, refused 0, not read 0, not yet read 1.')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('hands the plan the withheld rows as well as the fold: a withheld plugin is not fetched, and the report names the row', () => {
    const cwd = workspace()
    try {
      writeFileSync(join(cwd, 'registry', 'withheld-icons.yml'), '- name: dsh-icon-plugin\n  reason: The icon is a logo we may not show.\n')
      const run = buildFrom(cwd)
      expect(run.status, `stderr:\n${run.stderr}`).toBe(0)
      // A plan made without the row would have asked for the tarball.
      expect(run.urls).toEqual([INDEX_URL])
      expect(readEntries(cwd)).toEqual([{ name: 'dsh-icon-plugin' }])
      const report = readFileSync(out(cwd, 'report.md'), 'utf8')
      expect(report).toContain('Declared 1: published 0, withheld by hand 1, ')
      expect(report).toContain('| dsh-icon-plugin | withheld by registry/withheld-icons.yml: The icon is a logo we may not show. |')
      // The row names a listed entry, so it is not reported as stale.
      expect(report).not.toContain('- withheld-icons.yml:')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
