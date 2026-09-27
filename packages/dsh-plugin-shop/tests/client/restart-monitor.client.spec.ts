// @vitest-environment jsdom
/**
 * The restart monitor is held by the PAGE, not by the tab that confirmed the
 * restart. A self-update rewrites the shop's own client bundle, and dsh's
 * client HMR then swaps the tab for a fresh instance of a freshly imported
 * module: the monitor has to survive both the unmount and the new module
 * instance, or nothing reloads the page into the restarted server.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { RESTART_GRACE_MS, RESTART_STABLE_MS, RESTART_WAIT_MS, INSTALL_POLL_MS } from '../../src/client/present.ts'
import {
  readRestartMonitor,
  resetRestartMonitor,
  startRestartMonitor,
  subscribeRestartMonitor,
} from '../../src/client/restart-monitor.ts'

afterEach(() => {
  resetRestartMonitor()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

const answering = (): ReturnType<typeof vi.fn> => vi.fn().mockImplementation(async () => new Response('ok', { status: 200 }))

describe('the page-level restart monitor', () => {
  it('is the same monitor for a module instance imported after the swap', async () => {
    // The HMR swap imports the bundle again under a new revision: a new module
    // instance, with module-level state of its own. What it must share with
    // the old instance is the page.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', answering())
    vi.resetModules()
    const before = await import('../../src/client/restart-monitor.ts')
    vi.resetModules()
    const after = await import('../../src/client/restart-monitor.ts')
    expect(after).not.toBe(before)
    before.startRestartMonitor({ reload: vi.fn() })
    expect(after.readRestartMonitor()).toEqual({ kind: 'restarting' })
    after.resetRestartMonitor()
    expect(before.readRestartMonitor()).toBeNull()
  })

  it('reloads once the new server has kept answering, with no tab mounted at all', async () => {
    vi.useFakeTimers()
    const probe = answering()
    vi.stubGlobal('fetch', probe)
    const reload = vi.fn()
    startRestartMonitor({ reload })
    await vi.advanceTimersByTimeAsync(RESTART_GRACE_MS - 500)
    expect(probe).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(RESTART_STABLE_MS + 2_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the restart it is watching when another is confirmed, its clock included', async () => {
    // Every restart offer on the page reads this monitor, so a second press
    // can only come from a panel that has not re-rendered yet. Taking it as a
    // new restart would start the grace period and the stable window over,
    // and hand the reload to whichever panel pressed last.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', answering())
    const first = vi.fn()
    const second = vi.fn()
    startRestartMonitor({ reload: first })
    await vi.advanceTimersByTimeAsync(RESTART_GRACE_MS + 3 * INSTALL_POLL_MS)
    startRestartMonitor({ reload: second })
    // Probes run a poll interval apart, so the first restart's run of good
    // answers began at the grace period (3 s) and completes a stable window
    // later (11 s); we look at 12 s. A clock restarted at 6 s would begin its
    // run at 9 s and could not complete it before 17 s.
    await vi.advanceTimersByTimeAsync(RESTART_STABLE_MS - 2 * INSTALL_POLL_MS)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('reports failure with the log the host named when no server ever keeps answering', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    startRestartMonitor({ reload: vi.fn(), logFile: '/home/you/.dsh/shop/restart.log' })
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS + 2_000)
    expect(readRestartMonitor()).toEqual({ kind: 'failed', logFile: '/home/you/.dsh/shop/restart.log' })
  })

  it('hands every subscriber a change, and an unchanged state keeps its identity', async () => {
    // useSyncExternalStore re-renders on a snapshot of a new identity and
    // loops forever on one that is new every read.
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')))
    const listener = vi.fn()
    const unsubscribe = subscribeRestartMonitor(listener)
    startRestartMonitor({ reload: vi.fn() })
    expect(listener).toHaveBeenCalledTimes(1)
    const restarting = readRestartMonitor()
    await vi.advanceTimersByTimeAsync(RESTART_GRACE_MS + 3 * INSTALL_POLL_MS)
    expect(readRestartMonitor()).toBe(restarting)
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(readRestartMonitor()?.kind).toBe('failed')
    unsubscribe()
    resetRestartMonitor()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('probes nothing and reloads nothing once reset', async () => {
    vi.useFakeTimers()
    const probe = answering()
    vi.stubGlobal('fetch', probe)
    const reload = vi.fn()
    startRestartMonitor({ reload })
    resetRestartMonitor()
    await vi.advanceTimersByTimeAsync(RESTART_WAIT_MS + RESTART_STABLE_MS)
    expect(probe).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(readRestartMonitor()).toBeNull()
  })
})
