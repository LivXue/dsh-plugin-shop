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
  registerRestartCarrier,
  requestRestart,
  resetRestartMonitor,
  startRestartMonitor,
  subscribeRestartMonitor,
} from '../../src/client/restart-monitor.ts'
import type { ShopRestartResult } from '../../src/host/index.ts'

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

/** A module instance's path to the host whose one call the test settles by
 * hand; left unsettled, it is a call the swap cut off. */
function heldCarrier() {
  let settle: { resolve: (result: ShopRestartResult) => void; reject: (error: unknown) => void } | undefined
  const restart = vi.fn(() => new Promise<ShopRestartResult>((resolve, reject) => { settle = { resolve, reject } }))
  return {
    restart,
    answer: (result: ShopRestartResult) => { settle?.resolve(result) },
    fail: (error: unknown) => { settle?.reject(error) },
  }
}

/** Let settled calls run their continuations. */
const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

const STILL_RUNNING = 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.'

describe('a restart request belongs to the page too', () => {
  // On dsh 0.1.5-rc.3 and 0.1.7-rc.2 alike a unary Remote call is an HTTP
  // POST whose fetch rides the calling mount's own abort signal, and an answer arriving after that mount
  // went inactive is rewritten to "no longer mounted" (dsh-api-gateway's
  // client). So a self-update's HMR swap that lands inside the restart's round
  // trip leaves the tab that pressed with no answer at all, whether or not
  // the host committed: measured 2026-09-27 with the request held (the host
  // never restarted) and with the response held (it did, and the page stayed
  // on the old process). Each module instance therefore registers its own path
  // to the host, and the page asks again through a live one.

  it('shows a confirmed restart as under way before the host has answered', () => {
    const held = heldCarrier()
    registerRestartCarrier(held.restart)
    void requestRestart({ reload: vi.fn(), restart: vi.fn() })
    expect(readRestartMonitor()).toEqual({ kind: 'requesting' })
    expect(held.restart).toHaveBeenCalledTimes(1)
  })

  it('follows the restart once the host commits it', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', answering())
    const reload = vi.fn()
    registerRestartCarrier(vi.fn().mockResolvedValue({ ok: true, logFile: '/home/you/.dsh/shop/restart.log' }))
    await expect(requestRestart({ reload, restart: vi.fn() })).resolves.toEqual({ kind: 'started' })
    expect(readRestartMonitor()).toEqual({ kind: 'restarting', logFile: '/home/you/.dsh/shop/restart.log' })
    await vi.advanceTimersByTimeAsync(RESTART_GRACE_MS + RESTART_STABLE_MS + 2_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('hands a refusal back to the press and leaves nothing under way', async () => {
    registerRestartCarrier(vi.fn().mockResolvedValue({ ok: false, detail: STILL_RUNNING }))
    await expect(requestRestart({ reload: vi.fn(), restart: vi.fn() })).resolves.toEqual({ kind: 'refused', detail: STILL_RUNNING })
    expect(readRestartMonitor()).toBeNull()
  })

  it('reports a host it could not reach while the path that carried the request is still live', async () => {
    registerRestartCarrier(vi.fn().mockRejectedValue(new Error('shop remote: gateway/internal: fetch failed')))
    await expect(requestRestart({ reload: vi.fn(), restart: vi.fn() })).resolves.toEqual({ kind: 'unreachable' })
    expect(readRestartMonitor()).toBeNull()
  })

  it('asks again through the module instance that replaces a mount torn down mid-request', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', answering())
    const torn = heldCarrier()
    const withdraw = registerRestartCarrier(torn.restart)
    const reload = vi.fn()
    const outcome = requestRestart({ reload, restart: vi.fn() })
    // The swap disposes the old fiber first: its path is withdrawn, and
    // nothing live is left to ask yet.
    withdraw()
    await vi.advanceTimersByTimeAsync(0)
    expect(readRestartMonitor()).toEqual({ kind: 'requesting' })
    const replacement = vi.fn().mockResolvedValue({ ok: true, logFile: '/home/you/.dsh/shop/restart.log' })
    registerRestartCarrier(replacement)
    await expect(outcome).resolves.toEqual({ kind: 'started' })
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(readRestartMonitor()).toEqual({ kind: 'restarting', logFile: '/home/you/.dsh/shop/restart.log' })
    await vi.advanceTimersByTimeAsync(RESTART_GRACE_MS + RESTART_STABLE_MS + 2_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('asks again at once when the replacement registered before the old mount was torn down', () => {
    const torn = heldCarrier()
    const withdraw = registerRestartCarrier(torn.restart)
    void requestRestart({ reload: vi.fn(), restart: vi.fn() })
    const replacement = vi.fn().mockResolvedValue({ ok: true })
    registerRestartCarrier(replacement)
    // The old path is still live, so its own call may yet answer: nothing is
    // asked twice on the strength of a registration alone.
    expect(replacement).not.toHaveBeenCalled()
    withdraw()
    // In the same turn as the withdrawal, which the client half makes before
    // it disposes the mount — so the ask is under way before the old call can
    // even be aborted.
    expect(replacement).toHaveBeenCalledTimes(1)
  })

  it('lets nothing the torn-down call says later decide the request', async () => {
    const torn = heldCarrier()
    const withdraw = registerRestartCarrier(torn.restart)
    const outcome = requestRestart({ reload: vi.fn(), restart: vi.fn() })
    withdraw()
    // The abort that disposing the mount causes: not the host's answer.
    torn.fail(new Error('shop remote: gateway/cancelled: client api: Remote invocation "shop/restart" was aborted'))
    await flush()
    expect(readRestartMonitor()).toEqual({ kind: 'requesting' })
    const replacement = heldCarrier()
    registerRestartCarrier(replacement.restart)
    // The re-issue's answer is the one the press gets, refusal included.
    replacement.answer({ ok: false, detail: STILL_RUNNING })
    await expect(outcome).resolves.toEqual({ kind: 'refused', detail: STILL_RUNNING })
    expect(readRestartMonitor()).toBeNull()
  })

  it("follows the torn-down call's own commit, even before the re-issue answers", async () => {
    const torn = heldCarrier()
    const withdraw = registerRestartCarrier(torn.restart)
    const outcome = requestRestart({ reload: vi.fn(), restart: vi.fn() })
    withdraw()
    const replacement = heldCarrier()
    registerRestartCarrier(replacement.restart)
    // A transport that still delivers an answer after the mount went away:
    // a commit is the truth about the host however late it arrives.
    torn.answer({ ok: true, logFile: '/home/you/.dsh/shop/restart.log' })
    await expect(outcome).resolves.toEqual({ kind: 'started' })
    expect(readRestartMonitor()).toEqual({ kind: 'restarting', logFile: '/home/you/.dsh/shop/restart.log' })
  })

  it('follows a re-issue that cannot reach the host, because the first request may have taken it down', async () => {
    // The response-held measurement: the host had committed, answered into an
    // aborted fetch, and exited two seconds later. An ask that finds nothing
    // listening is what that looks like from the replacement.
    const torn = heldCarrier()
    const withdraw = registerRestartCarrier(torn.restart)
    const outcome = requestRestart({ reload: vi.fn(), restart: vi.fn() })
    withdraw()
    registerRestartCarrier(vi.fn().mockRejectedValue(new Error('shop remote: gateway/internal: fetch failed')))
    await expect(outcome).resolves.toEqual({ kind: 'started' })
    expect(readRestartMonitor()).toEqual({ kind: 'restarting' })
  })

  it('joins a second press to the request already in flight', async () => {
    const held = heldCarrier()
    registerRestartCarrier(held.restart)
    const first = requestRestart({ reload: vi.fn(), restart: vi.fn() })
    const second = requestRestart({ reload: vi.fn(), restart: vi.fn() })
    expect(held.restart).toHaveBeenCalledTimes(1)
    held.answer({ ok: false, detail: STILL_RUNNING })
    await expect(first).resolves.toEqual({ kind: 'refused', detail: STILL_RUNNING })
    await expect(second).resolves.toEqual({ kind: 'refused', detail: STILL_RUNNING })
  })

  it('asks nothing when the page is already following a restart', async () => {
    startRestartMonitor({ reload: vi.fn() })
    const carrier = vi.fn()
    registerRestartCarrier(carrier)
    await expect(requestRestart({ reload: vi.fn(), restart: vi.fn() })).resolves.toEqual({ kind: 'started' })
    expect(carrier).not.toHaveBeenCalled()
  })

  it("uses the pressing tab's own path when no module instance registered one", async () => {
    const own = vi.fn().mockResolvedValue({ ok: true })
    await expect(requestRestart({ reload: vi.fn(), restart: own })).resolves.toEqual({ kind: 'started' })
    expect(own).toHaveBeenCalledTimes(1)
  })

  it("prefers the newest registered path to the pressing tab's own", async () => {
    // Both are the same client half in production; mid-swap, a tab not yet
    // re-rendered may still hold the path of an instance being torn down.
    const registered = vi.fn().mockResolvedValue({ ok: true })
    registerRestartCarrier(registered)
    const own = vi.fn()
    await requestRestart({ reload: vi.fn(), restart: own })
    expect(registered).toHaveBeenCalledTimes(1)
    expect(own).not.toHaveBeenCalled()
  })

  it('shares its paths and its request with a module instance imported after the swap', async () => {
    vi.resetModules()
    const before = await import('../../src/client/restart-monitor.ts')
    vi.resetModules()
    const after = await import('../../src/client/restart-monitor.ts')
    const torn = heldCarrier()
    const withdraw = before.registerRestartCarrier(torn.restart)
    const outcome = before.requestRestart({ reload: vi.fn(), restart: vi.fn() })
    const replacement = vi.fn().mockResolvedValue({ ok: true })
    after.registerRestartCarrier(replacement)
    withdraw()
    await expect(outcome).resolves.toEqual({ kind: 'started' })
    expect(replacement).toHaveBeenCalledTimes(1)
    expect(after.readRestartMonitor()).toEqual({ kind: 'restarting' })
  })

  it('adopts a page store an older shop build created, which carries no request fields', async () => {
    // 0.8.4-beta.0 created the store as { state, listeners, stop }. The first
    // update FROM that build hands the replacement tab a store in that shape.
    const page = globalThis as unknown as Record<symbol, unknown>
    page[Symbol.for('dsh-plugin-shop.restart-monitor')] = { state: null, listeners: new Set(), stop: null }
    const carrier = vi.fn().mockResolvedValue({ ok: true })
    registerRestartCarrier(carrier)
    await expect(requestRestart({ reload: vi.fn(), restart: vi.fn() })).resolves.toEqual({ kind: 'started' })
    expect(carrier).toHaveBeenCalledTimes(1)
  })

  it('forgets its paths and its request once reset', async () => {
    const held = heldCarrier()
    registerRestartCarrier(held.restart)
    void requestRestart({ reload: vi.fn(), restart: vi.fn() })
    resetRestartMonitor()
    expect(readRestartMonitor()).toBeNull()
    const own = vi.fn().mockResolvedValue({ ok: true })
    await requestRestart({ reload: vi.fn(), restart: own })
    expect(own).toHaveBeenCalledTimes(1)
    // The forgotten request's answer changes nothing.
    held.answer({ ok: false, detail: STILL_RUNNING })
    await flush()
    expect(readRestartMonitor()).toEqual({ kind: 'restarting' })
  })
})
