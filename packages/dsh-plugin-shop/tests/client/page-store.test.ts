/**
 * The page store's contract (design 2026-10-16-shop-sidebar-page §5): the
 * reader's controls and every flow outlive the components that show them; a
 * settle leaves the page what it must do on its next mount; and dsh
 * restarting under the page settles exactly what a restart settles.
 */
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createPageStore, disposeOccupant, INITIAL_VIEW, installPageStore, readPageStore, resetPageStore, switchKey, type PageStoreDeps, type ShopPageStore } from '../../src/client/page-store.ts'
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
    expect(INITIAL_VIEW).toEqual({ query: '', category: null, order: 'stars', hideIncompatible: false, visibleCount: SHOP_VISIBLE_BATCH })
    expect(store.isExpanded(KEY)).toBe(false)
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
    expect(store.isExpanded(KEY)).toBe(true)
    store.toggleExpanded(KEY)
    expect(store.isExpanded(KEY)).toBe(false)
    store.dispose()
  })

  it('tells the expanded cards on a channel of their own, and never replaces the page snapshot for them', () => {
    // The shelf re-renders whole for every new snapshot; one card opens.
    const { store } = bench()
    const shelf = vi.fn()
    const cards = vi.fn()
    store.subscribe(shelf)
    store.subscribeExpanded(cards)
    const before = store.getSnapshot()
    store.toggleExpanded(KEY)
    expect(store.isExpanded(KEY)).toBe(true)
    expect(cards).toHaveBeenCalledTimes(1)
    // Expanding from outside a card, as a jump to one plugin does, opens it
    // and leaves an open card as it is.
    store.expand(KEY)
    expect(cards).toHaveBeenCalledTimes(1)
    store.expand('npm:other-plugin')
    expect(store.isExpanded('npm:other-plugin')).toBe(true)
    expect(cards).toHaveBeenCalledTimes(2)
    store.toggleExpanded(KEY)
    expect(store.isExpanded(KEY)).toBe(false)
    expect(cards).toHaveBeenCalledTimes(3)
    expect(shelf).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(before)
    store.dispose()
  })

  it('publishes nothing for a view change that changes nothing', () => {
    // A category pill or a shelf order pressed again, or a batch the shelf
    // already shows: React's own setters bailed on an identical value.
    const { store } = bench()
    const heard = vi.fn()
    store.subscribe(heard)
    const before = store.getSnapshot()
    store.setView({ query: '', category: null })
    store.setView({})
    store.updateView(view => ({ order: view.order, visibleCount: view.visibleCount }))
    expect(heard).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(before)
    store.setView({ order: 'added' })
    expect(heard).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('keeps a switch\'s owed notice sticky, a restart outranking a reload', () => {
    const { store } = bench()
    store.setOwed(`card:${KEY}`, 'reload', store.owedEpoch())
    store.setOwed(`card:${KEY}`, 'restart', store.owedEpoch())
    store.setOwed(`card:${KEY}`, 'reload', store.owedEpoch())
    expect(store.getOwed(`card:${KEY}`)).toBe('restart')
    // Each surface owes only what was done to it.
    expect(store.getOwed(`row:${KEY}`)).toBeUndefined()
    store.dispose()
  })

  it('tells a switch\'s notice on a channel of its own, and never replaces the page snapshot for it', () => {
    // The shelf re-renders whole for every new snapshot; one switch shows a
    // notice.
    const { store } = bench()
    const shelf = vi.fn()
    const switches = vi.fn()
    store.subscribe(shelf)
    store.subscribeOwed(switches)
    const before = store.getSnapshot()
    store.setOwed(switchKey('card', KEY), 'restart', store.owedEpoch())
    expect(store.getOwed(switchKey('card', KEY))).toBe('restart')
    expect(switches).toHaveBeenCalledTimes(1)
    expect(shelf).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(before)
    // dsh restarting under the page settles the notice on the same channel.
    store.noteRestarted()
    expect(store.getOwed(switchKey('card', KEY))).toBeUndefined()
    expect(switches).toHaveBeenCalledTimes(2)
    // A restart that finds no restart owed prunes nothing, and tells no switch.
    store.noteRestarted()
    expect(switches).toHaveBeenCalledTimes(2)
    // A disposed store tells no switch anything more.
    store.dispose()
    store.setOwed(switchKey('row', KEY), 'reload', store.owedEpoch())
    expect(switches).toHaveBeenCalledTimes(2)
  })

  it('remembers where the page was scrolled to, and that it is mounted, without telling its subscribers', () => {
    const { store } = bench()
    const heard = vi.fn()
    store.subscribe(heard)
    expect(store.readScroll()).toBe(0)
    store.recordScroll(640)
    store.notePageMounted(true)
    store.notePageMounted(false)
    expect(store.readScroll()).toBe(640)
    expect(heard).not.toHaveBeenCalled()
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
    store.clearReverdict(store.getSnapshot().reverdicts)
    deps.installStatus.mockResolvedValue(done('live'))
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.has(KEY)).toBe(false)
    // The bare package name, never the identity key the registry is keyed by.
    expect(deps.noteUninstalled).toHaveBeenCalledWith('dsh-hello-plugin')
    expect(store.getSnapshot()).toMatchObject({ settled: 2, reverdictPending: true })
    store.dispose()
  })

  /** Each record answers `running` until the case gives it an answer. */
  function answering(deps: ReturnType<typeof bench>['deps']): Map<string, ShopInstallStatusResult> {
    const answers = new Map<string, ShopInstallStatusResult>()
    deps.installStatus.mockImplementation(async ({ installId }) => answers.get(installId) ?? { found: true, state: 'running', log: [] })
    return answers
  }

  it('leaves an uninstall still running when an install of the identity lands, and folds the uninstall\'s own settle', async () => {
    // A settle supersedes the other registry's RECEIPT. An uninstall pressed
    // while an update ran is no receipt: deleting its view dropped every later
    // answer for it, so its settle never ran.
    vi.useFakeTimers()
    const { store, deps } = bench()
    const answers = answering(deps)
    await store.installs.start(KEY, HELLO)
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    answers.set('i1', done('restart'))
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.get(KEY)?.kind).toBe('done')
    expect(store.uninstalls.getSnapshot().views.get(KEY)?.kind).toBe('running')
    answers.set('u1', done('live'))
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.uninstalls.getSnapshot().views.get(KEY)?.kind).toBe('done')
    expect(deps.noteUninstalled).toHaveBeenCalledWith('dsh-hello-plugin')
    expect(store.getSnapshot().settled).toBe(2)
    // The uninstall that landed last supersedes the install's receipt.
    expect(store.installs.getSnapshot().views.has(KEY)).toBe(false)
    store.dispose()
  })

  it('leaves an install still running when an uninstall of the identity lands, and folds the install\'s own settle', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    const answers = answering(deps)
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await store.installs.start(KEY, HELLO)
    answers.set('u1', done('live'))
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.uninstalls.getSnapshot().views.get(KEY)?.kind).toBe('done')
    expect(store.installs.getSnapshot().views.get(KEY)?.kind).toBe('running')
    answers.set('i1', done('restart'))
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.get(KEY)?.kind).toBe('done')
    expect(store.getSnapshot().settled).toBe(2)
    // The install that landed last supersedes the uninstall's receipt.
    expect(store.uninstalls.getSnapshot().views.has(KEY)).toBe(false)
    store.dispose()
  })

  it('supersedes the receipt of its own identity and of no other', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    const answers = answering(deps)
    deps.uninstall.mockResolvedValueOnce({ ok: true, installId: 'u-other' })
    await store.uninstalls.start('npm:other-plugin', { name: 'other-plugin' })
    answers.set('u-other', done('live'))
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.uninstalls.getSnapshot().views.get('npm:other-plugin')?.kind).toBe('done')
    await store.installs.start(KEY, HELLO)
    answers.set('i1', done('restart'))
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.installs.getSnapshot().views.get(KEY)?.kind).toBe('done')
    expect(store.uninstalls.getSnapshot().views.get('npm:other-plugin')?.kind).toBe('done')
    store.dispose()
  })

  it('drops every switch notice of the identity an uninstall removed, and no other identity\'s', async () => {
    // The removed installation's switches are gone, and a reinstall draws
    // fresh ones under the same keys: a notice left there would describe a
    // toggle made against the installation before.
    vi.useFakeTimers()
    const { store } = bench(done('live'))
    store.setOwed(switchKey('card', KEY), 'restart', store.owedEpoch())
    store.setOwed(switchKey('row', KEY), 'reload', store.owedEpoch())
    store.setOwed(switchKey('card', 'npm:other-plugin'), 'restart', store.owedEpoch())
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.getOwed(switchKey('card', KEY))).toBeUndefined()
    expect(store.getOwed(switchKey('row', KEY))).toBeUndefined()
    expect(store.getOwed(switchKey('card', 'npm:other-plugin'))).toBe('restart')
    store.dispose()
  })

  it('keeps the switch notices of an identity whose uninstall failed', async () => {
    vi.useFakeTimers()
    const { store } = bench({ found: true, state: 'failed', log: [], detail: 'busy' })
    store.setOwed(switchKey('card', KEY), 'restart', store.owedEpoch())
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.uninstalls.getSnapshot().views.get(KEY)?.kind).toBe('failed')
    expect(store.getOwed(switchKey('card', KEY))).toBe('restart')
    store.dispose()
  })

  it('changes nothing after a failed uninstall: the package is still installed', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench()
    deps.installStatus.mockResolvedValueOnce(done('restart'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    store.clearReverdict(store.getSnapshot().reverdicts)
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

  it('clears a pending reverdict once the answer a page asked for lands', async () => {
    vi.useFakeTimers()
    const { store } = bench(done('live'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    store.clearReverdict(store.getSnapshot().reverdicts)
    expect(store.getSnapshot().reverdictPending).toBe(false)
    store.dispose()
  })

  it('keeps a reverdict pending when the answer that lands was asked before a later settle raised another', async () => {
    vi.useFakeTimers()
    const { store, deps } = bench(done('live'))
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    // A page asks for this reverdict...
    const asked = store.getSnapshot().reverdicts
    // ...and a second install lands while its answer is out.
    deps.install.mockResolvedValueOnce({ ok: true, installId: 'i2', state: 'running' })
    await store.installs.start('npm:other-plugin', { name: 'other-plugin', version: '1.0.0' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.getSnapshot().reverdicts).toBe(asked + 1)
    store.clearReverdict(asked)
    expect(store.getSnapshot().reverdictPending).toBe(true)
    store.clearReverdict(asked + 1)
    expect(store.getSnapshot().reverdictPending).toBe(false)
    store.dispose()
  })

  it('counts the reverdicts a restart raises as well as a settle\'s, and none for a failed install', async () => {
    vi.useFakeTimers()
    const { store } = bench({ found: true, state: 'failed', log: [], detail: 'boom' })
    await store.installs.start(KEY, HELLO)
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.getSnapshot()).toMatchObject({ settled: 1, reverdicts: 0, reverdictPending: false })
    store.noteRestarted()
    expect(store.getSnapshot()).toMatchObject({ settled: 2, reverdicts: 1, reverdictPending: true })
    store.dispose()
  })
})

describe('a switch\'s notice once its installation leaves the profile', () => {
  it('drops every notice of an identity the installed list a page read no longer holds, on every surface, and no other identity\'s', () => {
    // Removed outside the shop, through dsh's Plugins page or `dsh plugin
    // remove`: no uninstall of the page's settles for it, and the installed
    // list is the one witness.
    const { store } = bench()
    store.noteInstalled([KEY, 'npm:other-plugin'])
    store.setOwed(switchKey('card', KEY), 'restart', store.owedEpoch())
    store.setOwed(switchKey('row', KEY), 'reload', store.owedEpoch())
    store.setOwed(switchKey('card', 'npm:other-plugin'), 'restart', store.owedEpoch())
    const switches = vi.fn()
    store.subscribeOwed(switches)
    store.noteInstalled(['npm:other-plugin'])
    expect(store.getOwed(switchKey('card', KEY))).toBeUndefined()
    expect(store.getOwed(switchKey('row', KEY))).toBeUndefined()
    expect(store.getOwed(switchKey('card', 'npm:other-plugin'))).toBe('restart')
    expect(switches).toHaveBeenCalledTimes(1)
    // A list that holds every identity owing a notice drops nothing, and
    // tells no switch anything.
    store.noteInstalled(['npm:other-plugin'])
    expect(switches).toHaveBeenCalledTimes(1)
    store.dispose()
  })

  it('lets a toggle that answers after its installation left re-create nothing, and a toggle of the installation after it owe again', async () => {
    vi.useFakeTimers()
    const { store } = bench(done('live'))
    store.noteInstalled([KEY])
    // A toggle is out while the identity's uninstall lands...
    const beforeUninstall = store.owedEpoch()
    await store.uninstalls.start(KEY, { name: 'dsh-hello-plugin' })
    await vi.advanceTimersByTimeAsync(INSTALL_POLL_MS)
    expect(store.uninstalls.getSnapshot().views.get(KEY)?.kind).toBe('done')
    store.setOwed(switchKey('card', KEY), 'restart', beforeUninstall)
    expect(store.getOwed(switchKey('card', KEY))).toBeUndefined()
    // ...and another while the list a page reads stops holding it, though its
    // switch owed nothing yet: the switch the last list drew is the one gone.
    store.noteInstalled([KEY])
    const beforeRemoval = store.owedEpoch()
    store.noteInstalled([])
    store.setOwed(switchKey('row', KEY), 'reload', beforeRemoval)
    expect(store.getOwed(switchKey('row', KEY))).toBeUndefined()
    // A toggle of the installation the page sees now owes what it answers.
    store.noteInstalled([KEY])
    store.setOwed(switchKey('card', KEY), 'restart', store.owedEpoch())
    expect(store.getOwed(switchKey('card', KEY))).toBe('restart')
    store.dispose()
  })

  it('lets a toggle that answers after dsh restarted under the page owe the restart it answers: the new process served it', () => {
    // The page notes a restart only from a version answer the new process
    // gave, and the old process sent its toggle answers before it exited: an
    // answer that lands after the restart is noted is the new process's, and
    // the restart it owes is real.
    const { store } = bench()
    const since = store.owedEpoch()
    store.noteRestarted()
    store.setOwed(switchKey('card', KEY), 'restart', since)
    expect(store.getOwed(switchKey('card', KEY))).toBe('restart')
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
    store.setOwed('card:npm:a', 'restart', store.owedEpoch())
    store.setOwed('row:npm:b', 'reload', store.owedEpoch())
    store.clearReverdict(store.getSnapshot().reverdicts)
    const before = store.getSnapshot().settled
    store.noteRestarted()
    expect(store.installs.getSnapshot().views.has('npm:waits-restart')).toBe(false)
    // A reload is still owed by a page nobody reloaded.
    expect(store.installs.getSnapshot().views.get('npm:waits-reload')?.kind).toBe('done')
    expect(store.getOwed('card:npm:a')).toBeUndefined()
    expect(store.getOwed('row:npm:b')).toBe('reload')
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

  it('takes no change once disposed, tells and registers nobody, and keeps what it held readable', () => {
    // A hot swap's window can still reach a disposed store, through a late
    // version answer's restart or a React tree subscribing for one more
    // commit, and a successor reads what it held (design §5.1).
    const { store } = bench()
    store.setView({ query: 'hello' })
    store.toggleExpanded(KEY)
    store.noteInstalled([KEY])
    store.setOwed(switchKey('card', KEY), 'reload', store.owedEpoch())
    store.noteRestarted()
    const early = vi.fn()
    store.subscribe(early)
    store.subscribeOwed(early)
    store.subscribeExpanded(early)
    store.dispose()
    const held = store.getSnapshot()
    const late = vi.fn()
    store.subscribe(late)
    store.subscribeOwed(late)
    store.subscribeExpanded(late)
    store.setView({ query: 'goodbye' })
    store.updateView(view => ({ visibleCount: view.visibleCount + 1 }))
    store.toggleExpanded(KEY)
    store.expand('npm:other-plugin')
    store.setOwed(switchKey('card', KEY), 'restart', store.owedEpoch())
    store.noteInstalled([])
    store.clearReverdict(held.reverdicts)
    store.noteRestarted()
    expect(early).not.toHaveBeenCalled()
    expect(late).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(held)
    expect(held).toMatchObject({ view: { query: 'hello' }, reverdictPending: true, settled: 1 })
    expect(store.getOwed(switchKey('card', KEY))).toBe('reload')
    expect(store.isExpanded(KEY)).toBe(true)
    expect(store.isExpanded('npm:other-plugin')).toBe(false)
  })

  it('holds one store for the page, hands back the one it replaced, and forgets it on reset', () => {
    const first = bench().store
    const second = bench().store
    expect(installPageStore(first)).toEqual({ kind: 'none' })
    expect(installPageStore(second)).toEqual({ kind: 'store', store: first })
    expect(readPageStore()).toEqual({ kind: 'store', store: second })
    resetPageStore()
    expect(readPageStore()).toEqual({ kind: 'none' })
    first.dispose()
  })

  it('says what sits at the page key: nothing, a store of this schema, or an object of another, which it never hands out as a store', () => {
    expect(readPageStore()).toEqual({ kind: 'none' })
    const store = bench().store
    installPageStore(store)
    expect(readPageStore()).toEqual({ kind: 'store', store })
    // A later shop's store, met after a downgrade, need not share this shape:
    // reading it as this one's would throw inside `apply`.
    const later = { schema: 2, getSnapshot: () => { throw new Error('a schema-2 store read as schema 1') } }
    expect(installPageStore(later as unknown as ShopPageStore)).toEqual({ kind: 'store', store })
    const read = readPageStore()
    expect(read).toEqual({ kind: 'other', occupant: later })
    if (read.kind === 'other') expectTypeOf(read.occupant).toBeUnknown()
    store.dispose()
  })

  it('disposes an occupant that calls itself schema 1 without a dispose, as it does another shape\'s', () => {
    // An object that claims this schema and lacks the method is no more
    // this store than a schema-2 one: a throw here would take the shop off
    // the page inside `apply`, the failure the classification exists to
    // remove.
    const claimed = { schema: 1 } as unknown as ShopPageStore
    expect(() => { disposeOccupant({ kind: 'store', store: claimed }) }).not.toThrow()
    expect(() => { disposeOccupant({ kind: 'other', occupant: { schema: 1 } }) }).not.toThrow()
    expect(() => { disposeOccupant({ kind: 'none' }) }).not.toThrow()
    // A store's own dispose is still called, once.
    const real = bench().store
    const disposed = vi.spyOn(real, 'dispose')
    disposeOccupant({ kind: 'store', store: real })
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(() => { resetPageStore() }).not.toThrow()
  })

  it('forgets a store of another shape without calling what it lacks', () => {
    // A later shop's store, met after a downgrade, need not share this shape,
    // which is why index.ts disposes a replaced one only through a `dispose`
    // that exists. A reset that called a missing one would throw out of
    // `afterEach` and bury the failure of the case that left it there.
    installPageStore({ schema: 2 } as unknown as ShopPageStore)
    expect(() => { resetPageStore() }).not.toThrow()
    expect(readPageStore()).toEqual({ kind: 'none' })
  })
})
