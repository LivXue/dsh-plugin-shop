import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const testsDir = dirname(fileURLToPath(import.meta.url))
const srcDir = join(testsDir, '..', 'src')
const preload = join(testsDir, 'preload-fetch.ts')

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

/** A search response, with maintainers on every object. */
function searchPage(total: number, names: readonly string[], owners: readonly string[]): unknown {
  return {
    total,
    objects: names.map(name => ({
      package: { name, maintainers: owners.map(username => ({ username })) },
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
      expect(vocabulary(cwd)).toEqual({ publishers: ['alice', 'bob'], cursor: 0 })
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
      expect(vocabulary(cwd)).toEqual({ publishers: ['alice'], cursor: 0 })
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
        expect(existsSync(join(cwd, 'registry', 'publisher-state.json'))).toBe(false)
        expect(existsSync(join(cwd, 'registry', 'first-seen.yml'))).toBe(false)
      } finally {
        rmSync(cwd, { recursive: true, force: true })
      }
    })
  }
})
