import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { nodeKills, type KillFns } from '../../src/host/executor.ts'
import { createPrefetcher, isPrefetchableSpec, type SpawnFn } from '../../src/host/prefetch.ts'
import { fakePnpm } from '../fixtures/fake-pnpm.ts'
import { fileTempRoot } from './temp-root.ts'

const TEMP_ROOT = fileTempRoot('prefetch')

const temp = () => mkdtempSync(join(TEMP_ROOT, 'dsh-prefetch-'))

/** A batch environment whose PATH is `dir`, holding stubs named `pnpm`.
 *
 * The pump resolves its bin before spawning, so a case that names the BARE
 * `pnpm` needs a PATH that answers for it — and letting the probe read the
 * runner's own PATH would make the case pass or fail by accident, since CI has
 * pnpm on it and a container running this file may not. Nothing here is ever
 * executed: every case that uses this injects its own `spawn`. Several
 * spellings, because a case driving the win32 branch from a Linux runner looks
 * for `.cmd` while the POSIX branch looks for the name itself.
 *
 * `path` replaces the string the probe is handed, for the cases about how a
 * PATH STRING is read rather than about one directory: the stub still lands in
 * `dir`, and the caller spells the string the way its case is about — several
 * real entries joined by a separator the `platform` argument may not name. */
const pathHoldingPnpm = (
  dir: string,
  suffixes: readonly string[] = ['', '.cmd'],
  path: string = dir,
): NodeJS.ProcessEnv => {
  for (const suffix of suffixes) writeFileSync(join(dir, `pnpm${suffix}`), '')
  return { PATH: path }
}

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

/** A `spawn` whose children exit when THIS test says so, for the one arm of
 * the pump no child on this machine can reach.
 *
 * The windows absence arm is entered only by a batch the pump handed to a
 * shell, which needs `platform: 'win32'`; a Linux runner cannot get there, and
 * no real process would either — what makes the arm necessary is that the
 * shell STARTS SUCCESSFULLY and reports the missing pnpm itself, so a child
 * this file could start would report ENOENT on the `error` event instead, the
 * path the CI case already covers. All the pump reads off a child is one
 * registration per event plus the `exit` the test emits, so an `EventEmitter`
 * is the whole fixture. It carries no `pid` on purpose: `killTree` reads that
 * as nothing to kill, and a made-up one would only invite a `taskkill` against
 * whatever holds it.
 *
 * Every spawn hands back its OWN child, because the pump's staleness guard is
 * object identity — one object returned twice would make an old batch's
 * handlers believe they were still current, which no real spawn can do, and
 * the guard is the one thing these cases must not quietly defeat. */
const scriptedSpawn = (): { spawn: SpawnFn; exitCurrent: (code: number) => void } => {
  let current: { child: ChildProcess; exit: (code: number) => void } | null = null
  return {
    spawn: () => {
      const emitter = new EventEmitter()
      current = {
        child: emitter as unknown as ChildProcess,
        exit: code => { emitter.emit('exit', code) },
      }
      return current.child
    },
    /** Exit the child the pump started most recently — the batch an outcome
     * at this point in a case belongs to. */
    exitCurrent: code => {
      if (current === null) throw new Error('no scripted child has been spawned yet')
      current.exit(code)
    },
  }
}

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
    // The refused install reached no child at all — and neither did the one
    // being served. The bin is resolved before the batch is spawned, so a pnpm
    // that is not there never becomes a child on any platform, which is what
    // this case's Windows runs could not get from an exit code (see
    // `SHELL_COMMAND_NOT_FOUND`). A `batches(dir)` check cannot say that here —
    // a pnpm that does not exist can never write the log, so it passes whatever
    // the pump does.
    expect(calls).toEqual([])
  })

  // The other half of that case, and the one no run of this file on a Linux
  // box can perform: on win32 the batch above goes through a shell, so the
  // child that fails is `cmd.exe` — which exists — and the `error` event the
  // case above waits for never arrives. What arrives instead is an `exit`
  // carrying the shell's not-found code, which is what this drives.
  it('reads absence off a shell that exits not-found, and refuses the next by name', async () => {
    const dir = temp()
    const lines: string[] = []
    const calls: Spawned[] = []
    const scripted = scriptedSpawn()
    // The batch PATH this case's `pnpm` resolves on. This arm is only reachable
    // by a batch that IS started — the pump resolves the bin first, and a bare
    // name the runner's PATH happened not to hold would latch absence before
    // the scripted child ever existed.
    const env = pathHoldingPnpm(dir)
    const prefetcher = createPrefetcher({
      pnpmBin: 'pnpm',
      platform: 'win32',
      spawn: recording(calls, scripted.spawn),
    })
    expect(prefetcher.request({
      profile: 'web', spec: 'a@1', cwd: dir, env, log: line => lines.push(line),
    })).toEqual({ started: true })
    // Deterministic end to end, so no poll is needed and none is written: the
    // batch is built from `request`'s microtask, the scripted child answers
    // synchronously, and one turn of the queue is every wait this case has.
    // Nothing here depends on how long node takes to start, because no node
    // starts.
    await Promise.resolve()
    // The precondition the rest of the case rests on: this IS the shell path,
    // which is the only one where the code below can mean absence. A bare
    // `pnpm` is no `.js` entry, so `jsEntryCommand` declines it and win32 gets
    // the shell.
    expect(calls.map(call => ({ command: call.command, args: call.args, shell: call.options.shell })))
      .toEqual([{ command: 'pnpm', args: ['store', 'add', 'a@1'], shell: true }])
    expect(lines).toEqual([])
    // 9009 is the literal, deliberately: importing the constant would let the
    // test and the pump agree on a number while both were wrong, and this
    // assertion is the only thing outside cmd.exe's own behaviour that holds
    // the value still. That it is really cmd.exe's number is what CI's windows
    // runner decides — see the constant's comment in `prefetch.ts`.
    scripted.exitCurrent(9009)
    // The same line the ENOENT case above announces, and the only one: an
    // install told both "pnpm not found" and "exit 9009" was told twice about
    // one event, and the CI case filters on the substring for exactly this.
    expect(lines).toEqual(['dsh-plugin-shop: no download phase — pnpm not found on PATH'])
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({
      started: false, reason: 'no-pnpm',
    })
    // The refused install reached no child at all — the same thing the CI case
    // asserts about its own refused install, here on the branch CI runs.
    await Promise.resolve()
    expect(calls).toHaveLength(1)
  })

  it('still reports a shell batch that really ran and failed, and keeps serving', async () => {
    const dir = temp()
    const lines: string[] = []
    const scripted = scriptedSpawn()
    // Carried on BOTH requests: `request` replaces the lane's environment, so a
    // second one that omitted it would put the probe back on the runner's own
    // PATH.
    const env = pathHoldingPnpm(dir)
    const prefetcher = createPrefetcher({
      pnpmBin: 'pnpm',
      platform: 'win32',
      spawn: scripted.spawn,
    })
    expect(prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir, env, log: line => lines.push(line) }))
      .toEqual({ started: true })
    await Promise.resolve()
    scripted.exitCurrent(1)
    // A code the shell uses for other reasons is NOT absence: the generic
    // line stands, and the latch stays clear.
    expect(lines.join('\n')).toContain('exit 1')
    expect(lines.join('\n')).not.toContain('pnpm not found')
    expect(prefetcher.request({
      profile: 'web', spec: 'b@1', cwd: dir, env, log: line => lines.push(line),
    })).toEqual({ started: true })
    // Settle the batch that request just started, so its bound is cleared
    // rather than left pending past the end of the case — and so the success
    // line is asserted on the shell path too. It is a fresh child, so this
    // exit reaches the batch that owns it and not the one that already ended.
    await Promise.resolve()
    scripted.exitCurrent(0)
    expect(lines.join('\n')).toContain('packages fetched ahead of the install')
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

/**
 * The question the pump now asks BEFORE spawning — can this bin be started at
 * all — put to the filesystem instead of read off a failure afterwards.
 *
 * That is the half the Windows leg could not do (see `SHELL_COMMAND_NOT_FOUND`
 * in `prefetch.ts`: a path that is not there and a command that ran and failed
 * both exit 1), and it is why these cases can live here rather than only in
 * CI: resolving a bin is a filesystem and PATH walk, so a Linux runner decides
 * it exactly as a Windows runner does.
 *
 * The PRESENT cases are the ones the feature lives by. A probe that always
 * answered "absent" would satisfy every other case in this file — nothing
 * asserts on a batch that was never started — while silently refusing a pnpm
 * that is right there.
 */
describe('the resolution probe', () => {
  const ABSENT = 'dsh-plugin-shop: no download phase — pnpm not found on PATH'

  it('reads a path-shaped bin off the filesystem, never off PATH', async () => {
    const dir = temp()
    const calls: Spawned[] = []
    const lines: string[] = []
    const prefetcher = createPrefetcher({
      // A file that is not there, while a `pnpm` that IS there sits on the
      // batch's PATH: a caller who pinned a path gets that path's answer, and
      // a probe that fell back to PATH would start the wrong one.
      pnpmBin: join(dir, 'pnpm-not-installed'),
      spawn: recording(calls),
    })
    expect(prefetcher.request({
      profile: 'web', spec: 'a@1', cwd: dir, env: pathHoldingPnpm(temp()), log: line => lines.push(line),
    })).toEqual({ started: true })
    // Nothing spawns, so one turn of the queue is every wait this case has:
    // the announcement is made from `request`'s own microtask, and no process
    // startup stands between the two.
    await Promise.resolve()
    expect(lines).toEqual([ABSENT])
    expect(calls).toEqual([])
  })

  it('refuses a bare name the batch PATH does not hold, and refuses the next by name', async () => {
    const dir = temp()
    const calls: Spawned[] = []
    const lines: string[] = []
    const prefetcher = createPrefetcher({ pnpmBin: 'pnpm', spawn: recording(calls) })
    expect(prefetcher.request({
      profile: 'web',
      spec: 'a@1',
      cwd: dir,
      // A PATH that exists but holds nothing — the fabricated environment is
      // also what a REAL spawn here would inherit, so this case cannot reach a
      // pnpm of the runner's even when the probe is removed to check that it
      // is the probe doing the work.
      env: { PATH: join(dir, 'nowhere') },
      log: line => lines.push(line),
    })).toEqual({ started: true })
    await Promise.resolve()
    expect(lines).toEqual([ABSENT])
    expect(calls).toEqual([])
    // And the latch is process-wide: the next install is refused by name,
    // before a batch is even assembled.
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({
      started: false, reason: 'no-pnpm',
    })
  })

  it('starts the batch a win32 name resolves through its .cmd suffix', async () => {
    const dir = temp()
    const lines: string[] = []
    const calls: Spawned[] = []
    const scripted = scriptedSpawn()
    const prefetcher = createPrefetcher({
      pnpmBin: 'pnpm',
      platform: 'win32',
      spawn: recording(calls, scripted.spawn),
    })
    expect(prefetcher.request({
      profile: 'web',
      spec: 'a@1',
      cwd: dir,
      // ONLY `pnpm.cmd`: that is the shim npm installs on Windows, and the
      // reason this module passes `shell: true` there at all. A probe that
      // looked for the bare name alone would answer "absent" on a Windows
      // machine that has pnpm.
      env: pathHoldingPnpm(dir, ['.cmd']),
      log: line => lines.push(line),
    })).toEqual({ started: true })
    await Promise.resolve()
    expect(calls.map(call => ({ command: call.command, args: call.args, shell: call.options.shell })))
      .toEqual([{ command: 'pnpm', args: ['store', 'add', 'a@1'], shell: true }])
    // A batch that really started, not one that was started and then latched:
    // nothing was announced, and its exit reports the ordinary way.
    scripted.exitCurrent(0)
    expect(lines).toEqual(['dsh-plugin-shop: packages fetched ahead of the install'])
  })

  it('starts the batch a bare name on the batch PATH names', async () => {
    const dir = temp()
    const lines: string[] = []
    const calls: Spawned[] = []
    const scripted = scriptedSpawn()
    // `platform` pinned to a POSIX one so the line asserted below is the same
    // on either host — the bare name is what this case is about, and the
    // win32 suffix walk is the case above.
    const prefetcher = createPrefetcher({
      pnpmBin: 'pnpm', platform: 'linux', spawn: recording(calls, scripted.spawn),
    })
    expect(prefetcher.request({
      profile: 'web', spec: 'a@1', cwd: dir, env: pathHoldingPnpm(dir, ['']), log: line => lines.push(line),
    })).toEqual({ started: true })
    await Promise.resolve()
    expect(calls.map(call => ({ command: call.command, args: call.args, shell: call.options.shell })))
      .toEqual([{ command: 'pnpm', args: ['store', 'add', 'a@1'], shell: false }])
    scripted.exitCurrent(0)
    expect(lines).toEqual(['dsh-plugin-shop: packages fetched ahead of the install'])
  })

  // The collision the Windows runner hit, staged where it can be run.
  //
  // `platform: 'linux'` names the separator; the string handed to the probe
  // was produced by the HOST. On the Windows runner the temp directory every
  // case here starts from IS a colon-bearing path — `C:\Users\RUNNER~1\…\
  // dsh-prefetch-X`, whose drive-letter colon a split on ':' cuts in two,
  // leaving `C` and `\Users\…`, neither of them the directory that holds the
  // pnpm the case had just written. That path has no `;` in it, and a name
  // carrying ONE separator is still whole under a split on the other: the
  // stage below folds a `;` in as well, which is what a Windows directory name
  // may legally hold (a `:` it may not — NTFS forbids it, which is why this
  // stage is a fabrication, skipped where it cannot be built). Both spelled
  // inside the one entry, so BOTH splits cut it and neither puts it back
  // together: the string read as the single directory it is is the only
  // reading left, and the reading a bet on either separator alone would lose.
  const colonPath = it.skipIf(process.platform === 'win32')
  colonPath('starts the batch when a single PATH entry holds both separators in its name', async () => {
    const dir = temp()
    const lines: string[] = []
    const calls: Spawned[] = []
    const scripted = scriptedSpawn()
    const holder = join(dir, 'dsh-prefetch:posix;win32')
    mkdirSync(holder)
    // The premise the case rests on, asserted rather than assumed: this ONE
    // entry holds the pnpm and no fragment of either split does. (The
    // separator-free fragments resolve against this file's cwd, which is why
    // they are checked here rather than assumed away.)
    expect(holder.split(':').map(fragment => existsSync(join(fragment, 'pnpm')))).toEqual([false, false])
    expect(holder.split(';').map(fragment => existsSync(join(fragment, 'pnpm')))).toEqual([false, false])
    const prefetcher = createPrefetcher({
      pnpmBin: 'pnpm', platform: 'linux', spawn: recording(calls, scripted.spawn),
    })
    expect(prefetcher.request({
      profile: 'web', spec: 'a@1', cwd: dir, env: pathHoldingPnpm(holder, ['']), log: line => lines.push(line),
    })).toEqual({ started: true })
    await Promise.resolve()
    expect(calls.map(call => ({ command: call.command, args: call.args, shell: call.options.shell })))
      .toEqual([{ command: 'pnpm', args: ['store', 'add', 'a@1'], shell: false }])
    scripted.exitCurrent(0)
    expect(lines).toEqual(['dsh-plugin-shop: packages fetched ahead of the install'])
  })

  // The same disagreement read the other way round. Both joinings must reach
  // the pnpm, because neither direction is decided by the string: the ';' row
  // is the one a real Windows machine meets, and a bet that reads a ';'-joined
  // PATH as one enormous directory name disables the optimization for every
  // Windows user whose PATH holds more than one entry.
  //
  // The ':' row is a fabrication wherever an absolute path carries a colon of
  // its own, and is skipped there rather than asserted. On the Windows runner
  // the two entries are `C:\Users\RUNNER~1\…\dsh-prefetch-X`, so the string
  // this row joins is `C:\…\first:C:\…\second`; splitting it on ':' yields
  // `C` and `\…\first`, and a rooted-but-driveless fragment resolves against
  // the CURRENT drive — the runner's temp is on C: and its checkout on D:, so
  // it points at neither directory. No reading recovers the two, and none
  // should have to: no host joins Windows absolute paths the POSIX way, which
  // is what makes this a fixture that cannot be built rather than a probe that
  // reads one wrongly. The predicate names that precondition — entries free of
  // a colon — instead of the platform, so the row runs wherever it IS buildable.
  const joined = (separator: string) => async () => {
    const first = temp()
    const second = temp()
    const lines: string[] = []
    const calls: Spawned[] = []
    const scripted = scriptedSpawn()
    const prefetcher = createPrefetcher({
      pnpmBin: 'pnpm', platform: 'linux', spawn: recording(calls, scripted.spawn),
    })
    expect(prefetcher.request({
      profile: 'web',
      spec: 'a@1',
      cwd: first,
      // `first` is a real entry holding no pnpm, so finding one means the probe
      // walked the list rather than landing on the first thing it looked at.
      // The stub is written under `second`, and the string is the two joined
      // this row's way.
      env: pathHoldingPnpm(second, [''], `${first}${separator}${second}`),
      log: line => lines.push(line),
    })).toEqual({ started: true })
    await Promise.resolve()
    expect(calls.map(call => ({ command: call.command, args: call.args, shell: call.options.shell })))
      .toEqual([{ command: 'pnpm', args: ['store', 'add', 'a@1'], shell: false }])
    scripted.exitCurrent(0)
    expect(lines).toEqual(['dsh-plugin-shop: packages fetched ahead of the install'])
  }

  it.skipIf(TEMP_ROOT.includes(':'))('starts the batch a PATH joined the POSIX way names', joined(':'))

  it('starts the batch a PATH joined the Windows way names', joined(';'))
})

describe('the command line a batch is started with', () => {
  const SPEC = 'github:owner/slug#0123456789abcdef0123456789abcdef01234567&path:packages/a'

  /** The command line the pump builds for one batch, as `{ command, args,
   * shell }`. The child that runs it is a stand-in: what these cases are about
   * is the argv, and a real `pnpm store add` would reach the network.
   *
   * Every case gets a PATH this file owns, holding a `pnpm` stub, because the
   * pump resolves its bin before spawning: the bare-name cases below would
   * otherwise be asserting that the RUNNER has pnpm rather than that the pump
   * builds the right line. */
  const line = async (options: {
    pnpmBin?: string
    platform?: NodeJS.Platform
    execPath?: string
  }) => {
    const calls: Spawned[] = []
    const prefetcher = createPrefetcher({ ...options, spawn: recording(calls, standIn) })
    prefetcher.request({ profile: 'web', spec: SPEC, cwd: TEMP_ROOT, env: pathHoldingPnpm(temp()) })
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
