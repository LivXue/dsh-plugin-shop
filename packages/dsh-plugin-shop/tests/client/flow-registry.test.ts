/**
 * The flow registry's contract (design 2026-10-16-shop-sidebar-page §5.4): a
 * start guarded per identity, polling the registry owns rather than a
 * component's effect, one settle per terminal status, and an answer for a
 * flow that moved on dropped rather than folded.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { beginInstall, beginUninstall, beginUpdate, createFlowRegistry, IDLE_VIEW, type FlowRegistryDeps } from '../../src/client/flow-registry.ts'
import { INSTALL_POLL_MS, type InstallView } from '../../src/client/present.ts'
import type { ShopInstallStatusResult } from '../../src/host/index.ts'

afterEach(() => { vi.useRealTimers() })

type Args = { installId: string }

const running = (args: Args): InstallView => ({ kind: 'running', installId: args.installId, log: [], phase: 'installing' })

/** A registry over stubbed RPCs. `statuses` answer the polls in order; every
 * later poll answers `running`, so a flow never settles unless told to. */
function bench(pollUnwatched: boolean, statuses: ShopInstallStatusResult[] = []) {
  const begin = vi.fn(async (args: Args): Promise<InstallView> => running(args))
  const queue = [...statuses]
  const installStatus = vi.fn(async (): Promise<ShopInstallStatusResult> => queue.shift() ?? { found: true, state: 'running', log: [] })
  const onSettled = vi.fn()
  const deps: FlowRegistryDeps<Args> = { begin, installStatus, onSettled }
  const flows = createFlowRegistry<Args>(() => deps, { pollUnwatched })
  return { flows, begin, installStatus, onSettled }
}

describe('the flow registry', () => {
  it('reports a start in flight, then holds the view its answer maps to', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const { flows, begin } = bench(true)
    begin.mockImplementationOnce(async (args: Args) => { await gate; return running(args) })
    const started = flows.start('npm:a', { installId: 'i1' })
    expect(flows.getSnapshot().starting.has('npm:a')).toBe(true)
    expect(flows.getSnapshot().views.get('npm:a')).toBe(IDLE_VIEW)
    release()
    await started
    expect(flows.getSnapshot().starting.has('npm:a')).toBe(false)
    expect(flows.getSnapshot().views.get('npm:a')).toEqual(running({ installId: 'i1' }))
    flows.dispose()
  })

  it('ignores a second start for a key whose first start is unanswered', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const { flows, begin } = bench(true)
    begin.mockImplementation(async (args: Args) => { await gate; return running(args) })
    const first = flows.start('npm:a', { installId: 'i1' })
    const second = flows.start('npm:a', { installId: 'i1' })
    // The host does not dedupe: a second RPC would install the same name twice.
    expect(begin).toHaveBeenCalledTimes(1)
    release()
    await Promise.all([first, second])
    expect(begin).toHaveBeenCalledTimes(1)
    flows.dispose()
  })

  it('polls a running flow with nothing subscribed when it polls unwatched', async () => {
    vi.useFakeTimers()
    const { flows, installStatus } = bench(true)
    await flows.start('npm:a', { installId: 'i1' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledWith({ installId: 'i1' })
    flows.dispose()
  })

  it('polls only while something subscribes when it does not', async () => {
    vi.useFakeTimers()
    const { flows, installStatus } = bench(false)
    const unsubscribe = flows.subscribe(() => {})
    await flows.start('npm:a', { installId: 'i1' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledTimes(1)
    unsubscribe()
    await vi.advanceTimersByTimeAsync(5 * INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledTimes(1)
    // A component that mounts again (React StrictMode's second mount among
    // them) picks the polling back up.
    const again = flows.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledTimes(2)
    again()
    flows.dispose()
  })

  it('folds a terminal status, settles once with the arguments it started with, and stops polling', async () => {
    vi.useFakeTimers()
    const { flows, installStatus, onSettled } = bench(true, [{ found: true, state: 'done', log: ['added'], activation: 'live' }])
    await flows.start('npm:a', { installId: 'i1' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(flows.getSnapshot().views.get('npm:a')).toEqual({ kind: 'done', activation: 'live', log: ['added'] })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith('npm:a', 'done', { installId: 'i1' })
    await vi.advanceTimersByTimeAsync(5 * INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledTimes(1)
    flows.dispose()
  })

  it('drops an answer for a flow that was reset while the poll was out', async () => {
    vi.useFakeTimers()
    let answer: (status: ShopInstallStatusResult) => void = () => {}
    const { flows, installStatus, onSettled } = bench(true)
    installStatus.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    await flows.start('npm:a', { installId: 'i1' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledTimes(1)
    flows.reset('npm:a')
    answer({ found: true, state: 'done', log: [], activation: 'live' })
    await vi.advanceTimersByTimeAsync(0)
    expect(flows.getSnapshot().views.has('npm:a')).toBe(false)
    expect(onSettled).not.toHaveBeenCalled()
    flows.dispose()
  })

  it('resets every key a predicate selects and leaves the others, identities included', async () => {
    const { flows } = bench(true)
    await flows.start('npm:a', { installId: 'i1' })
    await flows.start('npm:b', { installId: 'i2' })
    const kept = flows.getSnapshot().views.get('npm:b')
    flows.resetWhere(view => view.kind === 'running' && view.installId === 'i1')
    expect(flows.getSnapshot().views.has('npm:a')).toBe(false)
    expect(flows.getSnapshot().views.get('npm:b')).toBe(kept)
    // Selecting nothing changes nothing, the snapshot's identity included.
    const before = flows.getSnapshot()
    flows.resetWhere(() => false)
    expect(flows.getSnapshot()).toBe(before)
    flows.dispose()
  })

  it('stops for good on dispose and keeps its snapshot readable', async () => {
    vi.useFakeTimers()
    const { flows, begin, installStatus } = bench(true)
    await flows.start('npm:a', { installId: 'i1' })
    flows.dispose()
    await vi.advanceTimersByTimeAsync(5 * INSTALL_POLL_MS)
    expect(installStatus).not.toHaveBeenCalled()
    expect(flows.getSnapshot().views.get('npm:a')?.kind).toBe('running')
    await flows.start('npm:b', { installId: 'i2' })
    expect(begin).toHaveBeenCalledTimes(1)
  })

  it('settles once when two overlapping polls for one identity both answer terminal', async () => {
    vi.useFakeTimers()
    const { flows, installStatus, onSettled } = bench(true)
    // Every poll is held unanswered, so the second tick fires while the first
    // poll is still out. That is what an install longer than INSTALL_POLL_MS
    // produces — the ordinary case, not a contrived one — and it is the only
    // way two polls for ONE identity can be in flight at once: `poll` issues
    // on every tick without awaiting the previous answer.
    const answers: Array<(status: ShopInstallStatusResult) => void> = []
    installStatus.mockImplementation(() => new Promise(resolve => { answers.push(resolve) }))
    await flows.start('npm:a', { installId: 'i1' })
    await vi.advanceTimersByTimeAsync(2 * INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledTimes(2)
    expect(answers).toHaveLength(2)
    for (const answer of answers) answer({ found: true, state: 'done', log: ['added'], activation: 'live' })
    await vi.advanceTimersByTimeAsync(0)
    // The first answer folds the view to `done` and settles. The second
    // describes a record the view has already left — the view is no longer
    // `running` — so it is dropped rather than settling the same record again.
    expect(flows.getSnapshot().views.get('npm:a')).toEqual({ kind: 'done', activation: 'live', log: ['added'] })
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(onSettled).toHaveBeenCalledWith('npm:a', 'done', { installId: 'i1' })
    flows.dispose()
  })

  it('drops an answer for an identity the key has since moved past', async () => {
    vi.useFakeTimers()
    const { flows, installStatus, onSettled } = bench(true)
    const answers: Array<(status: ShopInstallStatusResult) => void> = []
    installStatus.mockImplementation(() => new Promise(resolve => { answers.push(resolve) }))
    await flows.start('npm:a', { installId: 'i1' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(answers).toHaveLength(1)
    // `inFlight` is released as soon as the start answers, so a retry for the
    // same key is permitted while the i1 poll is still out — and this is what
    // the ordinary retry path looks like: the key is showing i2 while i1's
    // answer is still coming.
    await flows.start('npm:a', { installId: 'i2' })
    expect(flows.getSnapshot().views.get('npm:a')).toEqual(running({ installId: 'i2' }))
    answers[0]?.({ found: true, state: 'done', log: [], activation: 'live' })
    await vi.advanceTimersByTimeAsync(0)
    // The answer describes i1, which this key no longer shows: folding it
    // would put i1's outcome on i2's view and settle with i2's arguments.
    expect(flows.getSnapshot().views.get('npm:a')).toEqual(running({ installId: 'i2' }))
    expect(onSettled).not.toHaveBeenCalled()
    flows.dispose()
  })
})

describe('the three ways a flow starts', () => {
  it('maps an install answer, a gate refusal and a transport throw', async () => {
    const args = { name: 'a', version: '1.0.0' }
    expect(await beginInstall(async () => ({ ok: true, installId: 'i1', state: 'downloading' }))(args))
      .toEqual({ kind: 'running', installId: 'i1', log: [], phase: 'downloading' })
    expect(await beginInstall(async () => ({ ok: false, code: 'denied', detail: 'dsh-plugin-shop: a is denied: spam' }))(args))
      .toEqual({ kind: 'rejected', code: 'denied', detail: 'dsh-plugin-shop: a is denied: spam' })
    // The transport detail can name hosts and ports, so it never reaches a view.
    expect(await beginInstall(async () => { throw new Error('shop remote: transport: http://127.0.0.1:4100') })(args))
      .toEqual({ kind: 'failed', detail: '', log: [] })
  })

  it('maps an uninstall answer, a business refusal and a transport throw', async () => {
    const args = { name: 'a' }
    expect(await beginUninstall(async () => ({ ok: true, installId: 'u1' }))(args))
      .toEqual({ kind: 'running', installId: 'u1', log: [], phase: 'installing' })
    expect(await beginUninstall(async () => ({ ok: false, detail: 'dsh-plugin-shop: a is not installed' }))(args))
      .toEqual({ kind: 'failed', detail: 'dsh-plugin-shop: a is not installed', log: [] })
    expect(await beginUninstall(async () => { throw new Error('shop remote: transport') })(args))
      .toEqual({ kind: 'failed', detail: '', log: [] })
  })

  it('maps an update answer, a refusal and a transport throw', async () => {
    const args = { version: '0.9.1' }
    expect(await beginUpdate(async () => ({ ok: true, installId: 's1', state: 'running' }))(args))
      .toEqual({ kind: 'running', installId: 's1', log: [], phase: 'installing' })
    expect(await beginUpdate(async () => ({ ok: false, detail: 'dsh-plugin-shop: 0.9.x is not a version' }))(args))
      .toEqual({ kind: 'failed', detail: 'dsh-plugin-shop: 0.9.x is not a version', log: [] })
    expect(await beginUpdate(async () => { throw new Error('shop remote: transport') })(args))
      .toEqual({ kind: 'failed', detail: '', log: [] })
  })
})
