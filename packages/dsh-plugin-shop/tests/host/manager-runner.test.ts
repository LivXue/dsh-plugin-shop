import { describe, expect, it, vi } from 'vitest'
import { inProfileQueue, type InstallStatus, type RunningInstall } from '../../src/host/executor.ts'
import { continueAfter, ManagerLogs, MECHANISM_PREFIX, startManagerOperation } from '../../src/host/manager-runner.ts'
import type { ManagerOutcome } from '../../src/host/plugin-manager.ts'
import type { Prefetcher } from '../../src/host/prefetch.ts'
import { isTerminalInstallState } from '../../src/shared/install-state.ts'

const done: ManagerOutcome = { state: 'done', activation: 'live' }

describe('startManagerOperation', () => {
  it('opens the log with the mechanism, then the lines dsh streams for this request', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-1', requestId: 'r1', mechanism: 'install dsh-a@1.0.0', logs,
      run: async requestId => { logs.chunk(requestId, 'Progress: resolved 1\r\n+ dsh-a 1.0.0\n'); return {} },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.log).toEqual([`${MECHANISM_PREFIX} install dsh-a@1.0.0`, 'Progress: resolved 1', '+ dsh-a 1.0.0'])
  })

  it('joins a line dsh streamed in two chunks', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-2', requestId: 'r2', mechanism: 'install x', logs,
      run: async requestId => { logs.chunk(requestId, 'Progress: res'); logs.chunk(requestId, 'olved 1\n'); return {} },
      outcome: () => done,
    })
    expect((await running.finished).log).toEqual([`${MECHANISM_PREFIX} install x`, 'Progress: resolved 1'])
  })

  it('takes the final output when no chunk arrived', async () => {
    const running = startManagerOperation({
      profile: 'runner-3', requestId: 'r3', mechanism: 'remove dsh-a', logs: new ManagerLogs(),
      run: async () => ({ packageResult: { output: 'Packages: -1\nDone' } }),
      outcome: () => done,
    })
    expect((await running.finished).log).toEqual([`${MECHANISM_PREFIX} remove dsh-a`, 'Packages: -1', 'Done'])
  })

  it('ignores a chunk for another request, and one that arrives after the record settled', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-4', requestId: 'r4', mechanism: 'install dsh-b@1.0.0', logs,
      run: async () => { logs.chunk('someone-else', 'not mine\n'); return {} },
      outcome: () => done,
    })
    await running.finished
    logs.chunk('r4', 'too late\n')
    expect(running.status().log).toEqual([`${MECHANISM_PREFIX} install dsh-b@1.0.0`])
  })

  it('fails the record and frees the queue when the service call rejects', async () => {
    const running = startManagerOperation({
      profile: 'runner-5', requestId: 'r5', mechanism: 'install dsh-c@1.0.0', logs: new ManagerLogs(),
      run: async () => { throw new Error('plugin-manager: a local path must be absolute: ./x') },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe("dsh-plugin-shop: dsh's plugin manager failed: plugin-manager: a local path must be absolute: ./x")
    expect(inProfileQueue('runner-5', async () => {}).ahead).toBe(0)
  })

  it('fails the record, never leaving it running, when the post-install check throws', async () => {
    const running = startManagerOperation({
      profile: 'runner-6', requestId: 'r6', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => ({}), outcome: () => done,
      alsoConfirm: () => { throw new Error('ENOENT: no such file, package.json') },
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe('dsh-plugin-shop: could not verify the installed plugin: ENOENT: no such file, package.json')
    expect(inProfileQueue('runner-6', async () => {}).ahead).toBe(0)
  })

  it('waits its turn behind a command already queued in the same profile, downloading meanwhile', async () => {
    let release!: () => void
    inProfileQueue('runner-7', () => new Promise<void>(resolve => { release = resolve }))
    const run = vi.fn(async () => ({}))
    const released = vi.fn()
    const prefetcher: Prefetcher = { request: () => ({ started: true }), release: released }
    const running = startManagerOperation({
      profile: 'runner-7', requestId: 'r7', mechanism: 'install x@1.0.0', logs: new ManagerLogs(),
      run, outcome: () => done, prefetcher, spec: 'x@1.0.0',
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(run).not.toHaveBeenCalled()
    expect(running.status().state).toBe('downloading')
    release()
    await running.finished
    expect(run).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledWith('runner-7', 'x@1.0.0')
  })

  it('cancels at the deadline and reads the cancellation through the outcome', async () => {
    let finish!: (value: unknown) => void
    const cancel = vi.fn(async () => { finish({ application: 'cancelled' }); return { status: 'cancelled' } })
    const running = startManagerOperation({
      profile: 'runner-8', requestId: 'r8', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 30,
      run: () => new Promise(resolve => { finish = resolve }),
      cancel,
      outcome: raw => (raw as { application?: string }).application === 'cancelled' ? { state: 'failed', detail: 'timed out' } : done,
    })
    expect(await running.finished).toMatchObject({ state: 'failed', detail: 'timed out' })
    expect(cancel).toHaveBeenCalledWith('r8')
  })

  it('keeps waiting when the cancellation comes too late, and settles once', async () => {
    let finish!: (value: unknown) => void
    const outcome = vi.fn((): ManagerOutcome => done)
    const cancel = vi.fn(async () => ({ status: 'too-late' }))
    const running = startManagerOperation({
      profile: 'runner-9', requestId: 'r9', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 30,
      run: () => new Promise(resolve => { finish = resolve }),
      cancel,
      outcome,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(isTerminalInstallState(running.status().state)).toBe(false)
    finish({ application: 'applied' })
    expect((await running.finished).state).toBe('done')
    expect(outcome).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith('r9')
  })

  it('turns a done install into a failure when the post-install check objects', async () => {
    const running = startManagerOperation({
      profile: 'runner-10', requestId: 'r10', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => ({}), outcome: () => done,
      alsoConfirm: () => 'x declares the loader entry id "dup", which y already declares.',
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.activation).toBeUndefined()
    expect(status.detail).toContain('"dup"')
  })

  it('drops a download-phase log line that arrives after the record has settled', async () => {
    // Built outside the queued task itself so `release` is assigned the
    // moment this promise is constructed, not on the microtask that later
    // runs the task: this profile's earlier command is still "running" until
    // release() is called, whenever the test calls it.
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    inProfileQueue('runner-11', () => blocked)
    // The download phase's pump reports through the same `log` the runner
    // wires to `append`, not through ManagerLogs, so it can call back long
    // after the record itself is done.
    let capturedLog!: (line: string) => void
    const prefetcher: Prefetcher = {
      request: args => { capturedLog = args.log!; return { started: true } },
      release: () => {},
    }
    const running = startManagerOperation({
      profile: 'runner-11', requestId: 'r11', mechanism: 'install x@1.0.0', logs: new ManagerLogs(),
      run: async () => ({}), outcome: () => done, prefetcher, spec: 'x@1.0.0',
    })
    release()
    await running.finished
    expect(running.status().log).toEqual([`${MECHANISM_PREFIX} install x@1.0.0`])
    capturedLog('late pump line')
    expect(running.status().log).toEqual([`${MECHANISM_PREFIX} install x@1.0.0`])
  })

  it('flushes a final streamed line that never got its own newline', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-12', requestId: 'r12', mechanism: 'install dsh-a@1.0.0', logs,
      // No trailing newline: the line sits in the assembler until flush().
      run: async requestId => { logs.chunk(requestId, '+ dsh-a 1.0.0'); return {} },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.log).toEqual([`${MECHANISM_PREFIX} install dsh-a@1.0.0`, '+ dsh-a 1.0.0'])
  })

  it('does not replay the answer output for a line dsh already streamed', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-13', requestId: 'r13', mechanism: 'install dsh-a@1.0.0', logs,
      // The streamed chunk and the settled answer carry the identical line.
      run: async requestId => {
        logs.chunk(requestId, '+ dsh-a 1.0.0\n')
        return { packageResult: { output: '+ dsh-a 1.0.0\n' } }
      },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.log).toEqual([`${MECHANISM_PREFIX} install dsh-a@1.0.0`, '+ dsh-a 1.0.0'])
  })

  it('keeps the mechanism line first no matter how long the log grows', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-14', requestId: 'r14', mechanism: 'install x', logs,
      run: async requestId => {
        for (let i = 0; i < 250; i++) logs.chunk(requestId, `line ${i}\n`)
        return {}
      },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.log[0]).toBe(`${MECHANISM_PREFIX} install x`)
    expect(status.log.length).toBe(201)
    expect(status.log[status.log.length - 1]).toBe('line 249')
  })

  it('fails the record instead of throwing when reading the answer itself throws', async () => {
    const running = startManagerOperation({
      profile: 'runner-15', requestId: 'r15', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => ({ get packageResult(): never { throw new Error('getter boom') } }),
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe("dsh-plugin-shop: could not read the result from dsh: getter boom")
    expect(inProfileQueue('runner-15', async () => {}).ahead).toBe(0)
  })

  // The detail was `[object Object]` until R42.1 made messageOf total with
  // one fixed string: its fallback, Object.prototype.toString, can throw as
  // well (a revoked Proxy), so it was not the last resort it looked like.
  it('never leaves the record running when the rejection cannot describe itself', async () => {
    const running = startManagerOperation({
      profile: 'runner-16', requestId: 'r16', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => { throw Object.create(null) },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe("dsh-plugin-shop: dsh's plugin manager failed: an error with no readable message")
    expect(inProfileQueue('runner-16', async () => {}).ahead).toBe(0)
  })

  // R42.1: describing each of these threw inside the catch, before the record
  // settled, so it stayed `running` for good and F-5 refused every restart
  // after it. dsh itself never throws such values.
  it.each([
    ['a Proxy whose getPrototypeOf trap throws', 'runner-24', () => new Proxy({}, { getPrototypeOf: () => { throw new Error('trap') } })],
    ['an Error whose message is a Symbol', 'runner-25', () => Object.defineProperty(new Error('x'), 'message', { value: Symbol('boom') })],
    ['an Error whose message getter throws', 'runner-26', () => Object.defineProperty(new Error('x'), 'message', { get: () => { throw new Error('getter') } })],
  ])('settles the record failed when the rejection is %s', async (_value, profile, rejection) => {
    const running = startManagerOperation({
      profile, requestId: profile, mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => { throw rejection() },
      outcome: () => done,
    })
    const status = await running.finished.catch(() => running.status())
    expect(status.state).toBe('failed')
    expect(status.detail).toBe("dsh-plugin-shop: dsh's plugin manager failed: an error with no readable message")
    expect(inProfileQueue(profile, async () => {}).ahead).toBe(0)
  })

  it("keeps a thrown message's dsh plugin clause from a desktop reader, as dsh's answer is kept", async () => {
    // R42.4, the scrub forDesktopReader applies to dsh's answer.
    const rejection = new Error("plugin-manager: the profile is locked; run 'dsh plugin install'")
    const desktop = startManagerOperation({
      profile: 'runner-27', requestId: 'r27', mechanism: 'install x', logs: new ManagerLogs(), desktop: true,
      run: async () => { throw rejection },
      outcome: () => done,
    })
    expect((await desktop.finished).detail).toBe("dsh-plugin-shop: dsh's plugin manager failed: plugin-manager: the profile is locked")
    const web = startManagerOperation({
      profile: 'runner-28', requestId: 'r28', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => { throw rejection },
      outcome: () => done,
    })
    expect((await web.finished).detail).toBe("dsh-plugin-shop: dsh's plugin manager failed: plugin-manager: the profile is locked; run 'dsh plugin install'")
  })

  it('keeps stdout and stderr as separate line assemblers', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-17', requestId: 'r17', mechanism: 'install x', logs,
      run: async requestId => {
        logs.chunk(requestId, 'Progress: res', 'stdout')
        logs.chunk(requestId, 'WARN deprecated y\n', 'stderr')
        logs.chunk(requestId, 'olved 1\n', 'stdout')
        return {}
      },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.log).toEqual([`${MECHANISM_PREFIX} install x`, 'WARN deprecated y', 'Progress: resolved 1'])
  })

  it('fails the record with the answer-reading detail when outcome() itself throws', async () => {
    const running = startManagerOperation({
      profile: 'runner-18', requestId: 'r18', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => ({}),
      outcome: () => { throw new Error('cannot classify this answer') },
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toBe("dsh-plugin-shop: could not read the result from dsh: cannot classify this answer")
  })

  it('flushes a partial streamed line before the record fails', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-19', requestId: 'r19', mechanism: 'install x', logs,
      run: async requestId => {
        logs.chunk(requestId, 'ERR_PNPM_X boom')
        throw new Error('install failed')
      },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.log).toContain('ERR_PNPM_X boom')
  })

  it('does not start the cancellation deadline until the operation is actually running', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    inProfileQueue('runner-20', () => blocked)
    const cancel = vi.fn(async () => ({ status: 'cancelled' }))
    const running = startManagerOperation({
      profile: 'runner-20', requestId: 'r20', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 30,
      run: async () => ({}),
      cancel,
      outcome: () => done,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(cancel).not.toHaveBeenCalled()
    release()
    await running.finished
    expect(cancel).not.toHaveBeenCalled()
  })

  it('clears the cancellation deadline once the answer has already arrived', async () => {
    const cancel = vi.fn(async () => ({ status: 'cancelled' }))
    const running = startManagerOperation({
      profile: 'runner-21', requestId: 'r21', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 20,
      run: async () => ({}),
      cancel,
      outcome: () => done,
    })
    await running.finished
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(cancel).not.toHaveBeenCalled()
  })

  it('ignores a chunk whose text is not a string', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-22', requestId: 'r22', mechanism: 'install x', logs,
      run: async requestId => { logs.chunk(requestId, 42); return {} },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.log).toEqual([`${MECHANISM_PREFIX} install x`])
  })

  it('does not let a synchronously throwing cancel escape the timer as an unhandled error', async () => {
    let finish!: (value: unknown) => void
    const cancel = vi.fn(() => { throw new Error('sync') })
    const running = startManagerOperation({
      profile: 'runner-23', requestId: 'r23', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 20,
      run: () => new Promise(resolve => { finish = resolve }),
      cancel,
      outcome: () => done,
    })
    await new Promise(resolve => setTimeout(resolve, 45))
    finish({})
    expect((await running.finished).state).toBe('done')
    expect(cancel).toHaveBeenCalledWith('r23')
  })
})

/** A record whose status a case sets by hand, and whose `finished` it settles
 * by hand: what `continueAfter` composes, with no command behind it. */
function handRecord(installId: string, status: InstallStatus): RunningInstall & {
  set: (next: InstallStatus) => void
  settle: () => void
  reject: (error: Error) => void
} {
  let current = status
  let resolveFinished!: (value: InstallStatus) => void
  let rejectFinished!: (error: Error) => void
  const finished = new Promise<InstallStatus>((resolve, reject) => {
    resolveFinished = resolve
    rejectFinished = reject
  })
  return {
    installId,
    status: () => current,
    finished,
    set: next => { current = next },
    settle: () => { resolveFinished(current) },
    reject: error => { rejectFinished(error) },
  }
}

/** One turn of the event loop: every promise settled so far has run its
 * handlers by the time it resolves. */
const turn = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('continueAfter', () => {
  const BRIDGE = 'dsh-plugin-shop: the first command was refused; running the next one instead'
  const refusal: InstallStatus = { state: 'failed', log: ['first: started', 'first: refused'], detail: 'the first command was refused' }
  const landed: InstallStatus = { state: 'done', log: ['next: + x 1.0.0'], activation: 'restart', restartReason: 'already-loaded' }

  it('reads as the next record from the first read after the refusal, never as the refusal', () => {
    // Review Focus 2: a poll that lands between dsh's refusal and the next
    // command must not see the record fail, or the client stops polling on a
    // failure the record is about to leave.
    const first = handRecord('first-1', refusal)
    const next = vi.fn(() => handRecord('next-1', { state: 'running', log: [] }))
    const running = continueAfter(first, () => true, next, BRIDGE)
    expect(running.status().state).toBe('running')
    expect(next).toHaveBeenCalledOnce()
  })

  it('stays the first record, its finish included, when that ends without the refusal, and never starts the next', async () => {
    const first = handRecord('first-2', { state: 'running', log: ['first: started'] })
    const next = vi.fn(() => handRecord('next-2', { state: 'running', log: [] }))
    const running = continueAfter(first, () => false, next, BRIDGE)
    expect(running.installId).toBe('first-2')
    expect(running.status()).toEqual({ state: 'running', log: ['first: started'] })
    const failed: InstallStatus = { state: 'failed', log: ['first: started', 'first: pnpm broke'], detail: 'pnpm failed' }
    first.set(failed)
    expect(running.status()).toEqual(failed)
    first.settle()
    expect(await running.finished).toEqual(failed)
    expect(next).not.toHaveBeenCalled()
  })

  it("reads as the next record, live, behind the first record's log and the bridge", () => {
    const first = handRecord('first-3', refusal)
    const second = handRecord('next-3', { state: 'running', log: ['next: installing'] })
    const running = continueAfter(first, () => true, () => second, BRIDGE)
    expect(running.installId).toBe('first-3')
    expect(running.status()).toEqual({ state: 'running', log: ['first: started', 'first: refused', BRIDGE, 'next: installing'] })
    // The next record's activation and reason, and no detail: the refusal's
    // own detail does not outlive it.
    second.set({ ...landed, log: ['next: installing', 'next: + x 1.0.0'] })
    expect(running.status()).toEqual({
      state: 'done',
      log: ['first: started', 'first: refused', BRIDGE, 'next: installing', 'next: + x 1.0.0'],
      activation: 'restart',
      restartReason: 'already-loaded',
    })
    // And the next record's detail when it fails.
    const failing = continueAfter(handRecord('first-3b', refusal), () => true, () => handRecord('next-3b', {
      state: 'failed', log: ['next: ERR_PNPM_X'], detail: 'the next command failed',
    }), BRIDGE)
    expect(failing.status()).toEqual({
      state: 'failed', log: ['first: started', 'first: refused', BRIDGE, 'next: ERR_PNPM_X'], detail: 'the next command failed',
    })
  })

  it('finishes when the next record does, with the merged status', async () => {
    const first = handRecord('first-4', { state: 'running', log: ['first: started'] })
    const second = handRecord('next-4', { state: 'running', log: [] })
    const running = continueAfter(first, () => true, () => second, BRIDGE)
    let finishedWith: InstallStatus | undefined
    void running.finished.then(status => { finishedWith = status })
    first.set({ ...refusal, log: ['first: started'] })
    first.settle()
    await turn()
    expect(finishedWith).toBeUndefined()
    second.set(landed)
    second.settle()
    expect(await running.finished).toEqual({ ...landed, log: ['first: started', BRIDGE, 'next: + x 1.0.0'] })
  })

  it('starts the next record once, however many reads reach the refusal before the first record finishes', async () => {
    const first = handRecord('first-5', { state: 'running', log: [] })
    const second = handRecord('next-5', { state: 'running', log: [] })
    const inside: InstallStatus[] = []
    // A read made from inside `next` while it starts the command sees the
    // continuation under way, and starts nothing more.
    const next = vi.fn(() => {
      inside.push(running.status())
      return second
    })
    const running = continueAfter(first, () => true, next, BRIDGE)
    // While the first record runs, nothing starts, whatever `refused` says.
    running.status()
    running.status()
    expect(next).not.toHaveBeenCalled()
    first.set(refusal)
    for (let read = 0; read < 5; read += 1) running.status()
    expect(inside).toEqual([{ state: 'running', log: ['first: started', 'first: refused', BRIDGE] }])
    first.settle()
    second.set(landed)
    second.settle()
    await running.finished
    running.status()
    expect(next).toHaveBeenCalledOnce()
  })

  it('starts the next record once when the first record finishing reaches the refusal before any read', async () => {
    const first = handRecord('first-6', refusal)
    const second = handRecord('next-6', { state: 'running', log: [] })
    const next = vi.fn(() => second)
    const running = continueAfter(first, () => true, next, BRIDGE)
    first.settle()
    await turn()
    expect(next).toHaveBeenCalledOnce()
    for (let read = 0; read < 5; read += 1) expect(running.status().state).toBe('running')
    second.set(landed)
    second.settle()
    await running.finished
    expect(next).toHaveBeenCalledOnce()
  })

  it('decides once, when the first record ends, whether to continue, so a flag flipped later changes nothing', async () => {
    // `status()` and `finished` answer from one decision, or a read after a
    // late flip would start a command the finish had already said was not
    // coming.
    const failed: InstallStatus = { state: 'failed', log: ['first: started', 'first: pnpm broke'], detail: 'pnpm failed' }
    // Decided by the read that sees the first record end...
    const byRead = handRecord('first-9', { state: 'running', log: ['first: started'] })
    let readFlag = false
    const askedByRead = vi.fn(() => readFlag)
    const nextByRead = vi.fn(() => handRecord('next-9', { state: 'running', log: [] }))
    const readFirst = continueAfter(byRead, askedByRead, nextByRead, BRIDGE)
    expect(readFirst.status().state).toBe('running')
    expect(askedByRead).not.toHaveBeenCalled()
    byRead.set(failed)
    expect(readFirst.status()).toEqual(failed)
    readFlag = true
    for (let read = 0; read < 3; read += 1) expect(readFirst.status()).toEqual(failed)
    byRead.settle()
    expect(await readFirst.finished).toEqual(failed)
    expect(readFirst.status()).toEqual(failed)
    expect(nextByRead).not.toHaveBeenCalled()
    expect(askedByRead).toHaveBeenCalledOnce()
    // ...or by its finish, when no read came first.
    const byFinish = handRecord('first-10', failed)
    let finishFlag = false
    const askedByFinish = vi.fn(() => finishFlag)
    const nextByFinish = vi.fn(() => handRecord('next-10', { state: 'running', log: [] }))
    const finishFirst = continueAfter(byFinish, askedByFinish, nextByFinish, BRIDGE)
    byFinish.settle()
    expect(await finishFirst.finished).toEqual(failed)
    finishFlag = true
    for (let read = 0; read < 3; read += 1) expect(finishFirst.status()).toEqual(failed)
    expect(nextByFinish).not.toHaveBeenCalled()
    expect(askedByFinish).toHaveBeenCalledOnce()
  })

  it('ends the record failed, with the reason, when starting the next record throws, and never starts it again', async () => {
    // `next` gates the spec the first record's start already gated, so this
    // is not expected; the record must still end rather than read as the
    // refusal, or throw out of a status read.
    const first = handRecord('first-7', refusal)
    const next = vi.fn((): RunningInstall => { throw new Error('spawn EACCES') })
    const running = continueAfter(first, () => true, next, BRIDGE)
    const failed: InstallStatus = { state: 'failed', log: ['first: started', 'first: refused', BRIDGE], detail: 'dsh-plugin-shop: spawn EACCES' }
    expect(running.status()).toEqual(failed)
    expect(running.status()).toEqual(failed)
    first.settle()
    expect(await running.finished).toEqual(failed)
    expect(next).toHaveBeenCalledOnce()
  })

  it("carries the next record's rejected finish to its own, and never to the process as an unhandled rejection", async () => {
    // The executor's convention for its own records: `finished` carries the
    // rejection, and a handler is attached so that nobody awaiting it is no
    // process death.
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const first = handRecord('first-8', refusal)
      const second = handRecord('next-8', { state: 'running', log: [] })
      const running = continueAfter(first, () => true, () => second, BRIDGE)
      first.settle()
      await turn()
      second.reject(new Error('the command could not be built'))
      await turn()
      expect(unhandled).not.toHaveBeenCalled()
      await expect(running.finished).rejects.toThrow('the command could not be built')
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
