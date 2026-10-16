// @vitest-environment jsdom
/**
 * The identity contract `flowFor` owes a memoized consumer.
 *
 * `views` is replaced wholesale on every poll RESPONSE, so an accessor handed
 * straight to `memo(EntryCard)` failed its shallow compare once a second for
 * the whole duration of any one install, anywhere on the shelf. The fix is
 * not to freeze the accessor - a frozen one would never report that the
 * install a card IS showing has moved on - but to make its result stable per
 * key. These cases pin both halves of that: unchanged keys keep their object,
 * and a key whose own flow moves gets a new one.
 */
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useKeyedFlows, useRegistryFlows } from '../../src/client/useFlows.ts'
import { createFlowRegistry } from '../../src/client/flow-registry.ts'
import { INSTALL_POLL_MS, type InstallView } from '../../src/client/present.ts'
import type { ShopInstallStatusResult } from '../../src/host/index.ts'

afterEach(cleanup)
afterEach(() => { vi.useRealTimers() })

type Args = { installId: string }

/** `begin` never rejects, per the hook's contract: a transport throw is the
 * caller's to fold into a view. */
function bench() {
  const begin = vi.fn(async (args: Args): Promise<InstallView> =>
    ({ kind: 'running', installId: args.installId, log: [], phase: 'installing' }))
  // Never settles, so the poll interval keeps running and cannot race the
  // assertions with a terminal transition nobody asked for.
  const installStatus = vi.fn(async (): Promise<ShopInstallStatusResult> =>
    ({ found: true, state: 'running', log: [] }))
  const rendered = renderHook(() => useKeyedFlows<Args>(begin, installStatus))
  return { ...rendered, begin, installStatus }
}

describe('useKeyedFlows: the flow identity a memo depends on', () => {
  it('hands back one object for an idle key across re-renders', () => {
    const { result, rerender } = bench()
    const first = result.current.flowFor('npm:quiet')
    rerender()
    expect(result.current.flowFor('npm:quiet')).toBe(first)
  })

  it('leaves an uninvolved key untouched while another key starts installing', async () => {
    const { result } = bench()
    const quiet = result.current.flowFor('npm:quiet')
    await act(async () => { await result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    // The whole `views` map was replaced twice on that path - `idle` first,
    // then the begin answer - and the bystander's flow survived both.
    expect(result.current.flowFor('npm:quiet')).toBe(quiet)
    expect(result.current.flowFor('npm:busy').view).toMatchObject({ kind: 'running', installId: 'i1' })
  })

  it('hands back a NEW object for the key whose own flow moved', async () => {
    const { result } = bench()
    const before = result.current.flowFor('npm:busy')
    expect(before.view).toEqual({ kind: 'idle' })
    await act(async () => { await result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    // Stability must not cost correctness: the card that IS installing has to
    // learn about it.
    expect(result.current.flowFor('npm:busy')).not.toBe(before)
    expect(result.current.flowFor('npm:busy').view).not.toEqual({ kind: 'idle' })
  })

  it('returns a flow whose reset clears that key and leaves its neighbour alone', async () => {
    const { result } = bench()
    await act(async () => { await result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    await act(async () => { await result.current.flowFor('npm:other').start({ installId: 'i2' }) })
    const other = result.current.flowFor('npm:other')
    act(() => { result.current.flowFor('npm:busy').reset() })
    expect(result.current.flowFor('npm:busy').view).toEqual({ kind: 'idle' })
    expect(result.current.flowFor('npm:other')).toBe(other)
  })
})

describe('useKeyedFlows: one start in flight per key', () => {
  // Removing the §9.3 gate exposed a second click that the gate used to
  // absorb. The gate's confirm button was the only thing between "Install" and
  // the RPC, and a second press while the first was still unanswered reopened
  // the gate instead of starting a second install. Without it, two clicks on
  // one card are two 开始 requests, and the host does not dedupe: a release
  // asset is downloaded and hashed twice, or the same name is installed twice
  // over. Every button that offers an install shares this hook, so one guard
  // here covers the card, both update buttons and the outdated row.

  /** A `begin` the test resolves by hand, so the in-flight window is ours. */
  function deferredBench() {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const begin = vi.fn(async (args: Args): Promise<InstallView> => {
      await gate
      return { kind: 'running', installId: args.installId, log: [], phase: 'installing' }
    })
    const installStatus = vi.fn(async (): Promise<ShopInstallStatusResult> =>
      ({ found: true, state: 'running', log: [] }))
    const rendered = renderHook(() => useKeyedFlows<Args>(begin, installStatus))
    return { ...rendered, begin, release: () => { release?.() } }
  }

  it('ignores a second start for the same key while the first is unanswered', async () => {
    const { result, begin, release } = deferredBench()
    let first: Promise<void> | undefined
    act(() => { first = result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    expect(begin).toHaveBeenCalledTimes(1)
    // The second press, from the same card with the same key. Deliberately not
    // awaited here: with the guard missing this promise is the hang itself,
    // and a timeout is a worse signal than a count.
    let second: Promise<void> | undefined
    act(() => { second = result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    expect(begin, 'the host does not dedupe; this is the only thing that does').toHaveBeenCalledTimes(1)
    await act(async () => { release(); await first; await second })
    expect(result.current.flowFor('npm:busy').view).toMatchObject({ kind: 'running', installId: 'i1' })
  })

  it('reports the in-flight window on the flow, so the button can show it', async () => {
    const { result, release } = deferredBench()
    expect(result.current.flowFor('npm:busy').starting).toBe(false)
    let first: Promise<void> | undefined
    act(() => { first = result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    // Between the click and the answer the reader gets a disabled button and a
    // wait cursor, which is a fact about the flow, not about the button.
    expect(result.current.flowFor('npm:busy').starting).toBe(true)
    await act(async () => { release(); await first })
    expect(result.current.flowFor('npm:busy').starting).toBe(false)
  })

  it('takes a start again once the first one has answered', async () => {
    const { result, begin, release } = deferredBench()
    let first: Promise<void> | undefined
    act(() => { first = result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    await act(async () => { release(); await first })
    // A retry of a settled flow is a new request, not a repeat of the one in
    // flight: `start` clears the previous outcome and asks again.
    await act(async () => { await result.current.flowFor('npm:busy').start({ installId: 'i2' }) })
    expect(begin).toHaveBeenCalledTimes(2)
  })

  it('does not let one key in flight block another', async () => {
    const { result, begin, release } = deferredBench()
    let first: Promise<void> | undefined
    let second: Promise<void> | undefined
    act(() => { first = result.current.flowFor('npm:a').start({ installId: 'i1' }) })
    act(() => { second = result.current.flowFor('npm:b').start({ installId: 'i2' }) })
    // The guard is per identity: the whole shelf is not held hostage by one
    // card, and two different plugins install at once.
    expect(begin).toHaveBeenCalledTimes(2)
    expect(result.current.flowFor('npm:b').starting).toBe(true)
    await act(async () => { release(); await first; await second })
  })
})

describe('useKeyedFlows: resetting by what a flow holds', () => {
  // dsh restarting under the page settles every receipt that was waiting for
  // a restart, across every card at once; the tab names which by the view,
  // not by the key (design §8, 2026-10-06 amendment).

  it('returns every key the predicate selects to idle and leaves the rest, objects included', async () => {
    const { result } = bench()
    await act(async () => { await result.current.flowFor('npm:a').start({ installId: 'i1' }) })
    await act(async () => { await result.current.flowFor('npm:b').start({ installId: 'i2' }) })
    await act(async () => { await result.current.flowFor('npm:c').start({ installId: 'i3' }) })
    const kept = result.current.flowFor('npm:b')
    act(() => { result.current.resetWhere(view => view.kind === 'running' && view.installId !== 'i2') })
    expect(result.current.flowFor('npm:a').view).toEqual({ kind: 'idle' })
    expect(result.current.flowFor('npm:c').view).toEqual({ kind: 'idle' })
    expect(result.current.flowFor('npm:b')).toBe(kept)
    expect([...result.current.pending]).toEqual(['npm:b'])
  })

  it('changes nothing, identities included, when the predicate selects no flow', async () => {
    const { result } = bench()
    await act(async () => { await result.current.flowFor('npm:a').start({ installId: 'i1' }) })
    const pending = result.current.pending
    const flow = result.current.flowFor('npm:a')
    act(() => { result.current.resetWhere(() => false) })
    expect(result.current.pending).toBe(pending)
    expect(result.current.flowFor('npm:a')).toBe(flow)
  })

  it('keeps one identity across renders, so a subscription built on it holds', () => {
    const { result, rerender } = bench()
    const first = result.current.resetWhere
    expect(first).toBeTypeOf('function')
    rerender()
    expect(result.current.resetWhere).toBe(first)
  })
})

describe('useKeyedFlows: polling belongs to the component that owns the registry', () => {
  it('stops polling when the component unmounts', async () => {
    vi.useFakeTimers()
    const { result, unmount, installStatus } = bench()
    await act(async () => { await result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS) })
    expect(installStatus).toHaveBeenCalledTimes(1)
    unmount()
    await vi.advanceTimersByTimeAsync(5 * INSTALL_POLL_MS)
    expect(installStatus).toHaveBeenCalledTimes(1)
  })
})

describe('useRegistryFlows: a registry the page owns', () => {
  // `renderHook` outside `act`, as this file's other cases call it: the assertions
  // read the snapshot `useSyncExternalStore` already holds, so a batched wrapper
  // could only hide a re-subscribe that failed to happen.
  it('keeps a flow across an unmount and a remount', async () => {
    const begin = vi.fn(async (args: Args): Promise<InstallView> => ({ kind: 'running', installId: args.installId, log: [], phase: 'installing' }))
    const installStatus = vi.fn(async (): Promise<ShopInstallStatusResult> => ({ found: true, state: 'running', log: [] }))
    const registry = createFlowRegistry<Args>(() => ({ begin, installStatus }), { pollUnwatched: true })
    const first = renderHook(() => useRegistryFlows(registry))
    await act(async () => { await first.result.current.flowFor('npm:busy').start({ installId: 'i1' }) })
    first.unmount()
    const second = renderHook(() => useRegistryFlows(registry))
    expect(second.result.current.flowFor('npm:busy').view).toMatchObject({ kind: 'running', installId: 'i1' })
    expect([...second.result.current.pending]).toEqual(['npm:busy'])
    registry.dispose()
  })
})
