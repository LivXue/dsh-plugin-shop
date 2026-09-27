import { describe, expect, it, vi } from 'vitest'
import { inProfileQueue } from '../../src/host/executor.ts'
import { ManagerLogs, MECHANISM_PREFIX, startManagerOperation } from '../../src/host/manager-runner.ts'
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
    expect(status.detail).toContain('a local path must be absolute')
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
    expect(status.detail).toContain('ENOENT')
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
    const running = startManagerOperation({
      profile: 'runner-9', requestId: 'r9', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 30,
      run: () => new Promise(resolve => { finish = resolve }),
      cancel: async () => ({ status: 'too-late' }),
      outcome,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(isTerminalInstallState(running.status().state)).toBe(false)
    finish({ application: 'applied' })
    expect((await running.finished).state).toBe('done')
    expect(outcome).toHaveBeenCalledOnce()
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
})
