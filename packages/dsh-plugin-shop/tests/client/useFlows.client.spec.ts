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
import { useKeyedFlows } from '../../src/client/useFlows.ts'
import type { InstallView } from '../../src/client/present.ts'
import type { ShopInstallStatusResult } from '../../src/host/index.ts'

afterEach(cleanup)

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
