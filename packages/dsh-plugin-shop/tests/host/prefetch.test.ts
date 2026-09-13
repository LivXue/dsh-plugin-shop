import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { nodeKills, type KillFns } from '../../src/host/executor.ts'
import { createPrefetcher, isPrefetchableSpec, type SpawnFn } from '../../src/host/prefetch.ts'
import { fakePnpm } from '../fixtures/fake-pnpm.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('prefetch')

const temp = () => mkdtempSync(join(TEMP_ROOT, 'dsh-prefetch-'))
const batches = (dir: string): string[] => {
  const log = join(dir, 'pnpm.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line !== '')
}

/** How long a poll waits for a real child to start. It bounds a failure
 * report, never a passing run: `executor.test.ts` states the rule this file
 * now follows — "under parallel-suite load no fixed sleep is safe, so poll
 * instead" — and node's own startup is the thing no sleep could bound. */
const CHILD_WAIT = { timeout: 10_000 }

/** The command line of every child the pump starts. Recording the spawn is
 * what makes "nothing was spawned" and "one child carried these specs"
 * assertions about calls that happened rather than about a sleep being long
 * enough — which, for a child this file has to start itself, it is not. */
interface Spawned {
  command: string
  args: readonly string[]
  options: SpawnOptions
}

const recording = (calls: Spawned[], run: SpawnFn = nodeSpawn): SpawnFn => (command, args, options) => {
  calls.push({ command, args, options })
  return run(command, args, options)
}

/** A child that exits at once, for the cases that assert on the command line
 * the pump BUILDS: running one verbatim would be a real `pnpm store add` on
 * the network, while a node that ends immediately still drives the pump's own
 * event path for real. */
const standIn: SpawnFn = () => nodeSpawn(process.execPath, ['-e', ''], { stdio: 'ignore' })

/** A `KillFns` that records the kill AND performs it.
 *
 * Recording alone is how the two hang cases below were written, and it leaks
 * a process per run: the fixture child is spawned `detached` with
 * `stdio: 'ignore'`, so one that is never really killed reparents to PID 1
 * and outlives the run — and the vitest worker — indefinitely. Measured
 * 2026-09-13: sixty of them alive at once on one machine, the oldest up 3d9h
 * at 13-35 MB each, and a full-file run of this suite adds two more. The
 * repository keeps a dedicated guard test for temp-directory leaks; a leaked
 * process is the same class and, unlike a temp directory, nothing later
 * reclaims it. So the recorder delegates to `nodeKills`, the real handler
 * `killTree` defaults to, and the assertions that a kill was REQUESTED are
 * unchanged. */
const recordingKills = (killed: number[]): KillFns => ({
  killGroup: pid => { killed.push(pid); nodeKills.killGroup(pid) },
  killPid: pid => { killed.push(pid); nodeKills.killPid(pid) },
  taskkill: pid => { killed.push(pid); nodeKills.taskkill(pid) },
})

describe('isPrefetchableSpec', () => {
  it('accepts the npm and github forms', () => {
    expect(isPrefetchableSpec('dsh-hello@1.2.0')).toBe(true)
    expect(isPrefetchableSpec('github:owner/slug#0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(isPrefetchableSpec('github:owner/slug#0123456789abcdef0123456789abcdef01234567&path:packages/a')).toBe(true)
  })

  // Measured 2026-09-10: pnpm re-fetches a raw tarball URL on every install
  // even when the store holds that exact tarball, and `store add` on a URL
  // resolves no dependency closure. Prefetching one is a full extra download
  // for no saving. Design doc §3.
  it('refuses a raw https tarball URL, which a prefetch cannot help', () => {
    expect(isPrefetchableSpec('https://github.com/o/s/releases/download/v1/a.tgz')).toBe(false)
    expect(isPrefetchableSpec('http://example.test/a.tgz')).toBe(false)
  })
})

describe('the prefetch pump', () => {
  it('sends one batch carrying every pending spec', async () => {
    const dir = temp()
    const calls: Spawned[] = []
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir, { delayMs: 30 }),
      spawn: recording(calls),
    })
    expect(prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })).toEqual({ started: true })
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({ started: true })
    // The line lands only once a real node child has started — measured at
    // 89-96ms on an idle box, and longer under the full parallel suite, which
    // is what a fixed sleep could not bound.
    await vi.waitFor(() => expect(batches(dir)).toEqual(['store add a@1 b@1']), CHILD_WAIT)
    expect(calls).toHaveLength(1)
  })

  it('holds a late arrival for the next batch rather than a second child', async () => {
    const dir = temp()
    const calls: Spawned[] = []
    // The fixture is a `.mjs`, so `jsEntryCommand` routes it through node and
    // the recorded argv carries that entry in front of the verb.
    const bin = fakePnpm(dir, { delayMs: 120 })
    const prefetcher = createPrefetcher({ pnpmBin: bin, spawn: recording(calls) })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    // Polled, not slept: waiting for the first child to exist is what makes
    // the arrival below late, and that is a fact about the call record rather
    // than about how long node took to start.
    await vi.waitFor(() => expect(calls).toHaveLength(1), CHILD_WAIT)
    prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })
    // A child is started from a microtask, so one turn of the microtask queue
    // is enough for a child that was going to start to have started. The lane
    // already has one, and the batch `b@1` rides must not be a second one.
    await Promise.resolve()
    expect(calls.map(call => call.args)).toEqual([[bin, 'store', 'add', 'a@1']])
    // Nor is it dropped: it rides the batch that starts once the first exits.
    await vi.waitFor(() => expect(batches(dir)).toEqual(['store add a@1', 'store add b@1']), CHILD_WAIT)
    expect(calls.map(call => call.args)).toEqual([
      [bin, 'store', 'add', 'a@1'],
      [bin, 'store', 'add', 'b@1'],
    ])
  })

  it('refuses a tarball spec by name, without spawning anything', async () => {
    const dir = temp()
    const calls: Spawned[] = []
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir), spawn: recording(calls) })
    expect(prefetcher.request({
      profile: 'web', spec: 'https://github.com/o/s/releases/download/v1/a.tgz', cwd: dir,
    })).toEqual({ started: false, reason: 'unsupported-spec' })
    // One turn of the microtask queue is enough for a child that was going to
    // appear, so what is left here is the call record — not a sleep that
    // passes whether or not a child spawned late.
    await Promise.resolve()
    expect(calls).toEqual([])
  })

  it('reports pnpm absent to the install it was serving, and refuses the next by name', async () => {
    const dir = temp()
    const lines: string[] = []
    const missing = join(dir, 'definitely-not-here')
    const calls: Spawned[] = []
    const prefetcher = createPrefetcher({ pnpmBin: missing, spawn: recording(calls) })
    expect(prefetcher.request({
      profile: 'web', spec: 'a@1', cwd: dir, log: line => lines.push(line),
    })).toEqual({ started: true })
    await vi.waitFor(() => expect(lines.filter(line => line.includes('pnpm not found'))).toHaveLength(1), CHILD_WAIT)
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({
      started: false, reason: 'no-pnpm',
    })
    // The refused install reached no child at all. A `batches(dir)` check
    // cannot say that here — a pnpm that does not exist can never write the
    // log, so it passes whatever the pump does.
    expect(calls.map(call => call.command)).toEqual([missing])
  })

  it('tells every install a failed batch served, and installs anyway', async () => {
    const dir = temp()
    const a: string[] = []
    const b: string[] = []
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { exitCode: 1 }) })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir, log: line => a.push(line) })
    prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir, log: line => b.push(line) })
    const told = () => [a, b].map(lines => lines.some(line => line.includes('exit 1')))
    await vi.waitFor(() => expect(batches(dir)).toEqual(['store add a@1 b@1']), CHILD_WAIT)
    // One batch serves both installs, so both are told — the exit only happens
    // after a real child has run, hence the poll.
    await vi.waitFor(() => expect(told()).toEqual([true, true]), CHILD_WAIT)
  })

  it('announces a spawn that throws, and keeps serving the next install', async () => {
    const dir = temp()
    const lines: string[] = []
    let attempts = 0
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir),
      // A synchronous throw is the one failure with no child to report it —
      // and the pump starts its batch from a microtask, so an escaping throw
      // is an uncaughtException rather than a rejected promise, which node
      // answers by taking the host process down with every install in it.
      spawn: (command, args, options) => {
        attempts += 1
        if (attempts === 1) throw new Error('boom')
        return nodeSpawn(command, args, options)
      },
    })
    expect(prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir, log: line => lines.push(line) }))
      .toEqual({ started: true })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    expect(lines.join('\n')).toContain('could not start')
    expect(lines.join('\n')).toContain('boom')
    // Best-effort is not merely "does not throw": the lane is not left wedged,
    // so the next install still gets its batch.
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({ started: true })
    await vi.waitFor(() => expect(batches(dir)).toEqual(['store add b@1']), CHILD_WAIT)
    expect(attempts).toBe(2)
  })

  it('kills a batch that outruns its bound', async () => {
    const dir = temp()
    const killed: number[] = []
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir, { hang: true }),
      timeoutMs: 60,
      kills: recordingKills(killed),
    })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    // Polled for the same reason: the bound is what fires, and a sleep long
    // enough for it on an idle box is not long enough under the full suite.
    await vi.waitFor(() => expect(killed).toHaveLength(1), CHILD_WAIT)
  })

  it('kills a batch once nothing needs it', async () => {
    const dir = temp()
    const killed: number[] = []
    const calls: Spawned[] = []
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir, { hang: true }),
      spawn: recording(calls),
      kills: recordingKills(killed),
    })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    // The release has to land while the batch is running or it exercises a
    // lane with no child in it, so wait for the child rather than for a clock.
    await vi.waitFor(() => expect(calls).toHaveLength(1), CHILD_WAIT)
    prefetcher.release('web', 'a@1')
    await vi.waitFor(() => expect(killed).toHaveLength(1), CHILD_WAIT)
  })
})

describe('the command line a batch is started with', () => {
  const SPEC = 'github:owner/slug#0123456789abcdef0123456789abcdef01234567&path:packages/a'

  /** The command line the pump builds for one batch, as `{ command, args,
   * shell }`. The child that runs it is a stand-in: what these cases are about
   * is the argv, and a real `pnpm store add` would reach the network. */
  const line = async (options: {
    pnpmBin?: string
    platform?: NodeJS.Platform
    execPath?: string
  }) => {
    const calls: Spawned[] = []
    const prefetcher = createPrefetcher({ ...options, spawn: recording(calls, standIn) })
    prefetcher.request({ profile: 'web', spec: SPEC, cwd: TEMP_ROOT })
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    return calls.map(call => ({ command: call.command, args: call.args, shell: call.options.shell }))
  }

  it('quotes an &-bearing spec where a shell will parse the line, and nowhere else', async () => {
    // Windows with a bare `pnpm`: a `.cmd` shim, so node's shell mode is the
    // only way to start it, and under a shell node joins the argv into an
    // unescaped cmd.exe line. Bare, `&` splits the spec — pnpm warms the
    // repository ROOT and cmd runs the tail — so the spec must be quoted.
    expect(await line({ pnpmBin: 'pnpm', platform: 'win32' })).toEqual([
      { command: 'pnpm', args: ['store', 'add', `"${SPEC}"`], shell: true },
    ])
    // Off Windows there is no shell, and a quote would be a literal character
    // in the spec — an install that works today, broken.
    expect(await line({ pnpmBin: 'pnpm', platform: 'linux' })).toEqual([
      { command: 'pnpm', args: ['store', 'add', SPEC], shell: false },
    ])
    // A JS entry is routed through node on every platform, so the shell mode
    // that made the quoting necessary is gone even on Windows.
    const bin = fakePnpm(TEMP_ROOT)
    expect(await line({ pnpmBin: bin, platform: 'win32', execPath: process.execPath })).toEqual([
      { command: process.execPath, args: [bin, 'store', 'add', SPEC], shell: false },
    ])
  })
})
