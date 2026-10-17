/**
 * The page store's contract (design 2026-10-16-shop-sidebar-page §5): the
 * reader's controls and every flow outlive the components that show them; a
 * settle leaves the page what it must do on its next mount; and dsh
 * restarting under the page settles exactly what a restart settles.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPageStore, INITIAL_VIEW, installPageStore, readPageStore, resetPageStore, type PageStoreDeps, type ShopPageStore } from '../../src/client/page-store.ts'
import { INSTALL_POLL_MS, SHOP_VISIBLE_BATCH } from '../../src/client/present.ts'
import { SELF_UPDATE_KEY } from '../../src/client/useUpdateSelf.ts'
import type { ShopInstallStatusResult } from '../../src/host/index.ts'

afterEach(() => {
  resetPageStore()
  vi.useRealTimers()
})

/** A store over stubbed RPCs; every poll answers `status` unless a test
 * says otherwise. Polls unwatched, as the page's own store does. */
function bench(status: ShopInstallStatusResult = { found: true, state: 'running', log: [] }) {
  const deps = {
    install: vi.fn<PageStoreDeps['install']>().mockResolvedValue({ ok: true, installId: 'i1', state: 'running' }),
    uninstall: vi.fn<PageStoreDeps['uninstall']>().mockResolvedValue({ ok: true, installId: 'u1' }),
    updateStart: vi.fn<PageStoreDeps['updateStart']>().mockResolvedValue({ ok: true, installId: 's1', state: 'running' }),
    installStatus: vi.fn<PageStoreDeps['installStatus']>().mockResolvedValue(status),
    noteUninstalled: vi.fn<(name: string) => void>(),
  }
  const store = createPageStore(() => deps, { pollUnwatched: true })
  return { store, deps }
}

const KEY = 'npm:dsh-hello-plugin'
const HELLO = { name: 'dsh-hello-plugin', version: '1.2.0' }
const done = (activation: 'live' | 'reload' | 'restart'): ShopInstallStatusResult => ({ found: true, state: 'done', log: [], activation })

describe('the reader\'s place', () => {
  it('opens on the star order, every category and the first batch', () => {
    const { store } = bench()
    expect(store.getSnapshot().view).toBe(INITIAL_VIEW)
    expect(INITIAL_VIEW).toEqual({ query: '', category: null, order: 'stars', hideIncompatible: false, visibleCount: SHOP_VISIBLE_BATCH, expanded: new Set() })
    store.dispose()
  })

  it('keeps the view the reader set, and tells its subscribers', () => {
    const { store } = bench()
    const heard = vi.fn()
    store.subscribe(heard)
    store.setView({ query: 'hello', category: 'tool', visibleCount: SHOP_VISIBLE_BATCH })
    store.updateView(view => ({ hideIncompatible: !view.hideIncompatible, visibleCount: view.visibleCount + SHOP_VISIBLE_BATCH }))
    expect(store.getSnapshot().view).toMatchObject({ query: 'hello', category: 'tool', order: 'stars', hideIncompatible: true, visibleCount: 2 * SHOP_VISIBLE_BATCH })
    expect(heard).toHaveBeenCalledTimes(2)
    store.dispose()
  })

  it('expands and collapses a card by identity', () => {
    const { store } = bench()
    store.toggleExpanded(KEY)
    expect(store.getSnapshot().view.expanded.has(KEY)).toBe(true)
    store.toggleExpanded(KEY)
    expect(store.getSnapshot().view.expanded.has(KEY)).toBe(false)
    store.dispose()
  })

  it('keeps a switch\'s owed notice sticky, a restart outranking a reload', () => {
    const { store } = bench()
    store.setOwed(`card:${KEY}`, 'reload')
    store.setOwed(`card:${KEY}`, 'restart')
    store.setOwed(`card:${KEY}`, 'reload')
    expect(store.getSnapshot().owed.get(`card:${KEY}`)).toBe('restart')
    // Each surface owes only what was done to it.
    expect(store.getSnapshot().owed.has(`row:${KEY}`)).toBe(false)
    store.dispose()
  })
})

describe('settles, with no page mounted', () => {
  it('folds an install that lands while nothing watches: the installed list re-reads, and the catalog is judged again', async () => {
    vi.useFakeTimers()
    const { store } = bench(done('restart'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.get(KEY)).toMatchObject({ kind: 'done', activation: 'restart' })
    expect(store.getSnapshot()).toMatchObject({ settled: 1, reverdictPending: true })
    store.dispose()
  })

  it('re-reads the installed list after a failed install, and asks for no reverdict', async () => {
    vi.useFakeTimers()
    const { store } = bench({ found: true, state: 'failed', log: [], detail: 'boom' })
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.getSnapshot()).toMatchObject({ settled: 1, reverdictPending: false })
    store.dispose()
  })

  it('lets an install that lands supersede the identity\'s uninstall receipt', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    deps.installStatus.mockResolvedValueOnce(done('live'))
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.uninstalls.getSnapshot().views.get(KEY)?.kind).toBe('done')
    deps.installStatus.mockResolvedValue(done('restart'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.uninstalls.getSnapshot().views.has(KEY)).toBe(false)
    store.dispose()
  })

  it('lets an uninstall that lands supersede the install receipt, and names the package for the page-removed set', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    deps.installStatus.mockResolvedValueOnce(done('restart'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    store.clearReverdict()
    deps.installStatus.mockResolvedValue(done('live'))
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.has(KEY)).toBe(false)
    // The bare package name, never the identity key the registry is keyed by.
    expect(deps.noteUninstalled).toHaveBeenCalledWith('dsh-hello-plugin')
    expect(store.getSnapshot()).toMatchObject({ settled: 2, reverdictPending: true })
    store.dispose()
  })

  it('changes nothing after a failed uninstall: the package is still installed', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    deps.installStatus.mockResolvedValueOnce(done('restart'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    store.clearReverdict()
    deps.installStatus.mockResolvedValue({ found: true, state: 'failed', log: [], detail: 'busy' })
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.get(KEY)?.kind).toBe('done')
    expect(deps.noteUninstalled).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toMatchObject({ settled: 1, reverdictPending: false })
    store.dispose()
  })

  it('keeps a reverdict pending when a further settle lands before a page asks for it', async () => {
    vi.useFakeTimers()
    // The page mounted, a settle set the flag, and it asked for verdicts --
    // which have not landed yet. A second install settles in that window.
    const { store, deps } = bench()
    deps.installStatus.mockResolvedValueOnce(done('live'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.getSnapshot().reverdictPending).toBe(true)
    expect(store.getSnapshot().settled).toBe(1)
    // A failed install changed nothing, so it asks for no reverdict of its
    // own -- and must not withdraw the one still waiting.
    deps.installStatus.mockResolvedValue({ found: true, state: 'failed', log: [], detail: 'boom' })
    await store.installs.start('npm:other-plugin', { name: 'other-plugin', version: '1.0.0' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.getSnapshot()).toMatchObject({ settled: 2, reverdictPending: true })
    store.dispose()
  })

  it('clears a pending reverdict once a page asked for it', async () => {
    vi.useFakeTimers()
    const { store } = bench(done('live'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    store.clearReverdict()
    expect(store.getSnapshot().reverdictPending).toBe(false)
    store.dispose()
  })
})

describe('dsh restarting under the page', () => {
  it('settles what waited for a restart and nothing else', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    deps.install.mockResolvedValueOnce({ ok: true, installId: 'i1', state: 'running' }).mockResolvedValueOnce({ ok: true, installId: 'i2', state: 'running' })
    deps.installStatus.mockImplementation(async ({ installId }) => (installId === 'i1' ? done('restart') : done('reload')))
    await store.installs.start('npm:waits-restart', { name: 'waits-restart', version: '1.0.0' })
    await store.installs.start('npm:waits-reload', { name: 'waits-reload', version: '1.0.0' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    store.setOwed('card:npm:a', 'restart')
    store.setOwed('row:npm:b', 'reload')
    store.clearReverdict()
    const before = store.getSnapshot().settled
    store.noteRestarted()
    expect(store.installs.getSnapshot().views.has('npm:waits-restart')).toBe(false)
    // A reload is still owed by a page nobody reloaded.
    expect(store.installs.getSnapshot().views.get('npm:waits-reload')?.kind).toBe('done')
    expect(store.getSnapshot().owed.has('card:npm:a')).toBe(false)
    expect(store.getSnapshot().owed.get('row:npm:b')).toBe('reload')
    expect(store.getSnapshot()).toMatchObject({ settled: before + 1, reverdictPending: true })
    store.dispose()
  })

  it('clears every kind of receipt a restart settled, not just an install’s', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench(done('restart'))
    await store.installs.start(KEY, HELLO)
    await store.uninstalls.start('npm:waits-uninstall', { name: 'waits-uninstall' })
    await store.self.start(SELF_UPDATE_KEY, { version: '1.3.0' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.get(KEY)?.kind).toBe('done')
    expect(store.uninstalls.getSnapshot().views.get('npm:waits-uninstall')?.kind).toBe('done')
    expect(store.self.getSnapshot().views.get(SELF_UPDATE_KEY)?.kind).toBe('done')
    store.noteRestarted()
    expect(store.installs.getSnapshot().views.has(KEY)).toBe(false)
    expect(store.uninstalls.getSnapshot().views.has('npm:waits-uninstall')).toBe(false)
    expect(store.self.getSnapshot().views.has(SELF_UPDATE_KEY)).toBe(false)
    store.dispose()
  })
})

describe('the store on the page', () => {
  it('stops polling for good once disposed', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    await store.installs.start(KEY, HELLO)
    store.dispose()
    await vi.advanceTimersByTimeAsync(5 * INSTALL_POLL_MS)
    expect(deps.installStatus).not.toHaveBeenCalled()
  })

  it('drops a listener registered before it was disposed', () => {
    const { store } = bench()
    const heard = vi.fn()
    store.subscribe(heard)
    store.setView({ query: 'hello' })
    expect(heard).toHaveBeenCalledTimes(1)
    // A hot swap disposes the old store while a React tree may still hold its
    // subscription for one commit, so a dead-but-live listener is reachable.
    store.dispose()
    store.setView({ query: 'goodbye' })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('holds one store for the page, hands back the one it replaced, and forgets it on reset', () => {
    const first = bench().store
    const second = bench().store
    expect(installPageStore(first)).toBeUndefined()
    expect(installPageStore(second)).toBe(first)
    expect(readPageStore()).toBe(second)
    resetPageStore()
    expect(readPageStore()).toBeUndefined()
    first.dispose()
  })

  it('forgets a store of another shape without calling what it lacks', () => {
    // A later shop's store, met after a downgrade, need not share this shape,
    // which is why index.ts disposes a replaced one only through a `dispose`
    // that exists. A reset that called a missing one would throw out of
    // `afterEach` and bury the failure of the case that left it there.
    installPageStore({ schema: 2 } as unknown as ShopPageStore)
    expect(() => { resetPageStore() }).not.toThrow()
    expect(readPageStore()).toBeUndefined()
  })
})
