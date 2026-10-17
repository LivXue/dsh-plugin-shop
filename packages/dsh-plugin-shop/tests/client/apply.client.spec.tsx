// @vitest-environment jsdom
import './__loader__.ts'
import { loadModule } from './__loader__.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject, NS, WARM_TTL_MS } from '../../src/client/index.ts'
import { installPageStore, readPageStore, readPredecessor, resetPageStore, type ShopPageStore } from '../../src/client/page-store.ts'
import { INSTALL_POLL_MS } from '../../src/client/present.ts'
import { ShopGlyph } from '../../src/client/ShopGlyph.tsx'
import { ShopPage } from '../../src/client/ShopPage.tsx'
import type { ShopTabInjected } from '../../src/client/ShopTab.tsx'
import { readRestartMonitor, registerRestartCarrier, requestRestart, resetRestartMonitor, startRestartMonitor } from '../../src/client/restart-monitor.ts'
import type { InstallArgs, ShopInstallResult, ShopVersionResult } from '../../src/host/index.ts'

// The published dsh client packages expose their browser bundles (a
// `__ModuleLoader__.load` handoff) as the `./client` default; their exports
// exist only inside the loader, so the test fetches them through the loader —
// the same channel the web shell uses — rather than through a named import.
const { Context } = loadModule<typeof import('@deepseek-ai/cordis')>('@deepseek-ai/cordis')
const { LocaleRuntime } = loadModule<typeof import('@deepseek-ai/dsh-client-locale/client')>('@deepseek-ai/dsh-client-locale')
const { SlotRegistry } = loadModule<typeof import('@deepseek-ai/dsh-client-runtime/client')>('@deepseek-ai/dsh-client-runtime')

afterEach(() => {
  cleanup()
  // Every boot registers its restart path on the restart monitor's record
  // and puts its own store on the page (page-store.ts); both live on
  // globalThis and outlive the test that booted it.
  resetRestartMonitor()
  resetPageStore()
})

/** One stubbed shop method: return the wire envelope of your choice. The
 * stub speaks the WIRE name `installStart` — index.ts unwraps
 * `ctx.remote.shop.installStart` (§7.3 amendment: the wire method is
 * installStart, never install, which the namespace service owns). */
interface ShopStub {
  installStart?: (args: InstallArgs) => Promise<unknown>
  installStatus?: (args: { installId: string }) => Promise<unknown>
  uninstallStart?: (args: { name: string }) => Promise<unknown>
  updateStart?: (args: { version: string }) => Promise<unknown>
  catalog?: () => Promise<unknown>
  restart?: () => Promise<unknown>
  version?: () => Promise<unknown>
}

/** Boot apply() against a stubbed remote and return the shop page entry's
 * injected face — the real unwrap from index.ts sits between the wire
 * envelopes the stub returns and the injected methods the tab calls.
 *
 * @param modules the page's `modules` service, provided before the shop boots
 *   the way the web shell provides it; omitted, the page has none.
 * @param options `layout: true` provides a fake of dsh's layout service
 *   (`fakeLayout`) before the shop boots; omitted, the page has none.
 *   `unmountOnLeave: true` unmounts the page the moment its `main` entry
 *   leaves, as a host stricter than React would. */
async function boot(shop: ShopStub = {}, modules?: unknown, options: { layout?: boolean; unmountOnLeave?: boolean } = {}) {
  const ctx = new Context()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  if (modules !== undefined) ctx.provide('modules', modules)
  await ctx.plugin(SlotRegistry).await()
  // The shell declares the main column's seat and the sidebar's at boot,
  // which makes the page's and the row's inject callbacks run synchronously
  // inside apply. It declares the two Settings seats too, which the shop no
  // longer uses, so the assertions that the shop is absent from them read a
  // declared seat rather than an absent one.
  ctx.slots.register({
    name: 'root',
    children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.plugins.tab': { kind: 'list', scope: 'root' },
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  const layout = options.layout === true ? fakeLayout(ctx) : undefined
  if (layout !== undefined) ctx.provide('layout', layout.service)
  // A host stricter than React: it unmounts the page the moment its entry
  // leaves, on the slot registry's synchronous mutation event. Registered
  // before apply, because cordis disposes a fiber's effects newest first.
  if (options.unmountOnLeave === true) {
    ctx.on('slots/changed', key => {
      if (key !== 'main' || ctx.slots.entries('main').some(entry => entry.options.key === 'shop')) return
      // The page key reports what it holds (page-store.ts): only a store of
      // this schema is the page's, and it is the one that hears this.
      const occupant = readPageStore()
      if (occupant.kind === 'store') occupant.store.notePageMounted(false)
    })
  }
  const mounted: unknown[] = []
  const disposer = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  ctx.provide('remote', {
    $mount: vi.fn(async (contribution: unknown) => { mounted.push(contribution); return disposer }),
  })
  // The tab's injected face reads the namespace through the reflect shop
  // (`ctx.get`), the same channel the real mount registers it on — index.ts
  // cannot use `ctx.remote.shop`, which the inject gate refuses (see the
  // deadlock comment there). The stub speaks the WIRE names.
  ctx.provide('remote.shop', {
    catalog: shop.catalog ?? vi.fn(),
    installStart: shop.installStart ?? vi.fn(),
    installStatus: shop.installStatus ?? vi.fn(),
    setEnabled: vi.fn(),
    installed: vi.fn(),
    uninstallStart: shop.uninstallStart ?? vi.fn(),
    restart: shop.restart ?? vi.fn(),
    version: shop.version ?? vi.fn(),
    updateStart: shop.updateStart ?? vi.fn(),
  })
  await apply(ctx)
  const entry = ctx.slots.entries('main').find(e => e.options.key === 'shop')
  if (entry === undefined) throw new Error('the shop page entry is not registered')
  const injected = entry.inject!() as unknown as ShopTabInjected
  return { ctx, locale, mounted, disposer, injected, layout }
}

/** dsh's layout service as the SHOP calls it — `selectPanel` only, plus the
 * fallback the layout plugin performs: a selection drops to the conversation
 * (`null`) when its key's `main` entry leaves (`retainMainPanels`, identical
 * on 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2, measured 2026-10-16;
 * design 2026-10-16-shop-sidebar-page §6). `selected()` is the TEST's window
 * on the selection: the shop never reads it, and no `panelInfo` is faked,
 * because a service that carried one would let a regression read it back
 * (its shape differs on 0.1.5-rc.3;
 * design 2026-10-16-shop-sidebar-page §3.1). */
function fakeLayout(ctx: InstanceType<typeof Context>) {
  let active: string | null = null
  const held = (id: string): boolean => ctx.slots.entries('main').some(entry => entry.options.key === id)
  const service = {
    selectPanel: vi.fn((id: string | null) => {
      if (id !== null && !held(id)) throw new Error(`layout.selectPanel: main panel "${id}" is not registered`)
      active = id
    }),
  }
  ctx.slots.subscribe('main', () => { if (active !== null && !held(active)) active = null })
  return { service, selected: (): string | null => active }
}

describe('shop client apply', () => {
  it('mounts the shop remote, registers the locale namespace, the page and its sidebar row', async () => {
    const { ctx, locale, mounted, disposer } = await boot()

    expect(inject).toEqual(['remote', 'slots', 'locale'])
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ package: 'dsh-plugin-shop' })
    expect(locale.bind(NS)('title')).toBe('Plugin shop')
    const slots = ctx.slots
    const pageEntry = slots.entries('main').find(entry => entry.options.key === 'shop')
    // The page frame, not the bare body: the two share one props type, so
    // only the component tells them apart.
    expect(pageEntry?.component).toBe(ShopPage)
    const row = slots.entries('sidebar.panellist').find(entry => entry.options.id === 'shop')
    if (row === undefined) throw new Error('the sidebar row is not registered')
    // Directly under dsh's Plugins row (order 0), above Automation (10).
    expect(row.options.order).toBe(5)
    expect(row.component).toBe(ShopGlyph)
    // No longer a Settings section, nor a tab inside Built-in plugins
    // (design 2026-10-16-shop-sidebar-page §2).
    expect(slots.entries('settings.section').some(entry => entry.options.id === 'shop')).toBe(false)
    expect(slots.entries('settings.plugins.tab').some(entry => entry.options.id === 'shop')).toBe(false)
    await ctx.fiber.dispose()
    expect(slots.entries('main')).toHaveLength(0)
    expect(slots.entries('sidebar.panellist')).toHaveLength(0)
    expect(disposer).toHaveBeenCalled()
  })

  it('names the sidebar row in the locale current when the sidebar reads it', async () => {
    // dsh re-reads `label` when the locale changes; a label captured once at
    // registration would keep the row in the language dsh booted in.
    const { ctx, locale } = await boot()
    const row = ctx.slots.entries('sidebar.panellist').find(entry => entry.options.id === 'shop')
    if (row === undefined) throw new Error('the sidebar row is not registered')
    const label = row.options.label as () => string
    expect(label()).toBe('Plugin shop')
    locale.setLocale('zh')
    expect(label()).toBe('插件商店')
  })

  it('registers the same page and row identity on a fresh apply, as a self-update hot swap does', async () => {
    // The sidebar selects the page by the row's id, which is the page's
    // `main` key; a re-apply must bring both back unchanged.
    const first = await boot()
    await first.ctx.fiber.dispose()
    // Every boot registers its restart path on the restart monitor's
    // record, as afterEach notes; clear it between the two boots the same way.
    resetRestartMonitor()
    const second = await boot()
    expect(second.ctx.slots.entries('main').map(entry => entry.options.key)).toEqual(['shop'])
    const row = second.ctx.slots.entries('sidebar.panellist').find(entry => entry.options.id === 'shop')
    expect(row?.options.order).toBe(5)
  })

  it('routes a host business rejection through the real unwrap as a resolved value', async () => {
    const rejection: ShopInstallResult = {
      ok: false,
      code: 'denied',
      detail: 'dsh-plugin-shop: dsh-blocked is denied: matched the denylist',
    }
    const { injected } = await boot({
      installStart: async () => ({ ok: true as const, value: rejection }),
    })
    const args: InstallArgs = { name: 'dsh-blocked', version: '1.0.0', acknowledged: true }
    // The host's business rejection is a method RESULT, not a wire error: the
    // envelope is ok:true with the ShopInstallResult union as its value, and
    // unwrap passes it through — injected.install resolves, never throws.
    await expect(injected.install(args)).resolves.toEqual(rejection)
  })

  it('maps a wire failure through the real unwrap to the failed view', async () => {
    const { injected } = await boot({
      installStart: async () => ({ ok: false as const, error: { code: 'WIRE', message: 'boom' } }),
    })
    const args: InstallArgs = { name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true }
    // An envelope-level failure is a TRANSPORT failure: the real unwrap throws
    // the prefixed wire message, so injected.install rejects.
    await expect(injected.install(args)).rejects.toThrow('shop remote: WIRE: boom')
    // And the install registry's start mapping catches that throw into the
    // failed view — the `rejected` state stays reserved for the host's
    // business union (§7.2). The transport detail is private (it can name
    // hosts and ports) and never rendered, so the failed view carries an
    // EMPTY detail; ShopTab falls back to the localized
    // installTransportFailed line (R-P2-15).
    //
    // Driven through the page store's install registry, the one the shop
    // ships (page-store.ts; apply hands it to the tab as `page`), which
    // begins every install through flow-registry.ts's `beginInstall`. This
    // case once drove `useInstall`, a single-view hook no reader reached, and
    // so asserted about a path the shop never took.
    const page = injected.page
    if (page === undefined) throw new Error('the face hands over no page store')
    await page.installs.start('k', args)
    expect(page.installs.getSnapshot().views.get('k')).toEqual({ kind: 'failed', detail: '', log: [] })
  })
})

describe('shop client apply warm', () => {
  const fakeCatalog = {
    schemaVersion: 2, builtAt: '2026-08-27T00:00:00Z', stale: false,
    plugins: [], denied: [], stars: {}, incompatible: {}, incompatibleHarness: {},
  }

  // Equality, not identity, in the three cases below. They asserted `toBe`
  // until 2026-09-24, when the tab stopped being handed the host's object:
  // every result now passes through the module table on its way to the tab
  // (module-table.ts), which makes a copy with a refined `incompatible` and
  // leaves the stashed result untouched for the next hand-over to refine. What
  // these cases prove — WHICH result was served, and with how many wire calls
  // — is carried by the distinguishing `builtAt` and the call counts, exactly
  // as before.
  it('warms the catalog at boot and serves the tab from the warm fetch', async () => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const { injected } = await boot({ catalog })
    expect(catalog).toHaveBeenCalledTimes(1) // the boot-time warm
    expect(await injected.catalog(undefined)).toEqual(fakeCatalog)
    expect(catalog).toHaveBeenCalledTimes(1) // consumed, no second wire call
    // A refresh always goes to the wire.
    await injected.catalog({ refresh: true })
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('falls back to a fresh call when the boot-time warm fetch failed', async () => {
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'WIRE', message: 'down' } })
      .mockResolvedValue({ ok: true, value: fakeCatalog })
    const { injected } = await boot({ catalog })
    expect(await injected.catalog(undefined)).toEqual(fakeCatalog)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('serves the refreshed catalog to the next plain open, not the boot catalog', async () => {
    const second = { ...fakeCatalog, builtAt: '2026-08-28T00:00:00Z' }
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: fakeCatalog })
      .mockResolvedValue({ ok: true, value: second })
    const { injected } = await boot({ catalog })
    expect(await injected.catalog({ refresh: true })).toEqual(second)
    expect(await injected.catalog(undefined)).toEqual(second)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('re-asks the host once the stash outlives the freshness window', async () => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const { injected } = await boot({ catalog })
    expect(catalog).toHaveBeenCalledTimes(1)
    vi.useFakeTimers({ now: Date.now() + WARM_TTL_MS + 1 })
    try {
      await injected.catalog(undefined)
      expect(catalog).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("bounds the stash at the host's own freshness window", () => {
    expect(WARM_TTL_MS).toBe(5 * 60 * 1000)
  })

  it('bypasses a fresh stash on reverdict, never sends a reverdict key over the wire, and stores the result as the new stash', async () => {
    const second = { ...fakeCatalog, builtAt: '2026-08-28T00:00:00Z' }
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: fakeCatalog })
      .mockResolvedValue({ ok: true, value: second })
    const { injected } = await boot({ catalog })
    expect(catalog).toHaveBeenCalledTimes(1) // the boot-time warm
    // A reverdict bypasses the still-fresh stash and goes to the wire, asking
    // the host's own snapshot and freshness window again — never a network
    // refresh, and never `{ reverdict: true }` itself, which the host RPC
    // does not accept.
    expect(await injected.catalog({ reverdict: true })).toEqual(second)
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(catalog.mock.calls[1]).toEqual([undefined])
    // And it becomes the new stash: a later plain open does not go to the
    // wire again.
    expect(await injected.catalog(undefined)).toEqual(second)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('checks refresh before reverdict, so a combined { refresh: true, reverdict: true } still reaches the network', async () => {
    // Reverdict alone calls `ns.catalog(undefined)` (the test above); if
    // refresh were checked second, this combined call would take the
    // reverdict branch and never ask for `{ refresh: true }` at all.
    const second = { ...fakeCatalog, builtAt: '2026-08-28T00:00:00Z' }
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: fakeCatalog })
      .mockResolvedValue({ ok: true, value: second })
    const { injected } = await boot({ catalog })
    expect(catalog).toHaveBeenCalledTimes(1) // the boot-time warm
    expect(await injected.catalog({ refresh: true, reverdict: true })).toEqual(second)
    expect(catalog).toHaveBeenCalledTimes(2)
    expect(catalog.mock.calls[1]).toEqual([{ refresh: true }])
  })

  it('drops the stash before a reverdict asks, so a failed reverdict never leaves a pre-mutation stash for the next plain open to replay', async () => {
    const third = { ...fakeCatalog, builtAt: '2026-08-29T00:00:00Z' }
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: fakeCatalog }) // boot-time warm
      .mockResolvedValueOnce({ ok: false, error: { code: 'WIRE', message: 'down' } }) // the reverdict itself fails
      .mockResolvedValue({ ok: true, value: third }) // the next plain open
    const { injected } = await boot({ catalog })
    expect(catalog).toHaveBeenCalledTimes(1) // the boot-time warm
    await expect(injected.catalog({ reverdict: true })).rejects.toThrow()
    expect(catalog).toHaveBeenCalledTimes(2)
    // If the pre-mutation stash had survived, this open would replay
    // `fakeCatalog` with no further wire call; instead it must ask again.
    expect(await injected.catalog(undefined)).toEqual(third)
    expect(catalog).toHaveBeenCalledTimes(3)
  })

  it('drops the stash the moment install() starts, before installStart settles', async () => {
    // Each mutator drops the stash SYNCHRONOUSLY at the start of the call,
    // not in a .then() after the host call resolves — because a tab can
    // unmount before installStart settles, and then no reverdict is ever
    // requested. A plain open concurrent with the still-pending install must
    // not replay the pre-mutation stash.
    let resolveInstall!: (value: unknown) => void
    const installStart = vi.fn(() => new Promise(resolve => { resolveInstall = resolve }))
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const { injected } = await boot({ catalog, installStart })
    expect(catalog).toHaveBeenCalledTimes(1) // the boot-time warm, still fresh

    const args: InstallArgs = { name: 'dsh-hello-plugin', version: '1.0.0', acknowledged: true }
    const pending = injected.install(args)
    // installStart has not settled yet — resolveInstall is still unused.
    await injected.catalog(undefined)
    expect(catalog).toHaveBeenCalledTimes(2) // re-asked; the stash was dropped already

    resolveInstall({ ok: true, value: { ok: true, installId: 'i1' } })
    await pending
  })

  it('drops the stash the moment uninstall() starts, before uninstallStart settles', async () => {
    let resolveUninstall!: (value: unknown) => void
    const uninstallStart = vi.fn(() => new Promise(resolve => { resolveUninstall = resolve }))
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const { injected } = await boot({ catalog, uninstallStart })
    expect(catalog).toHaveBeenCalledTimes(1)

    const pending = injected.uninstall({ name: 'dsh-hello-plugin' })
    await injected.catalog(undefined)
    expect(catalog).toHaveBeenCalledTimes(2)

    resolveUninstall({ ok: true, value: { ok: true } })
    await pending
  })

  it('drops the stash the moment updateStart() starts, before updateStart settles', async () => {
    let resolveUpdate!: (value: unknown) => void
    const updateStart = vi.fn(() => new Promise(resolve => { resolveUpdate = resolve }))
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const { injected } = await boot({ catalog, updateStart })
    expect(catalog).toHaveBeenCalledTimes(1)

    const pending = injected.updateStart({ version: '1.1.0' })
    await injected.catalog(undefined)
    expect(catalog).toHaveBeenCalledTimes(2)

    resolveUpdate({ ok: true, value: { ok: true, installId: 'u1' } })
    await pending
  })
})

describe('shop client apply: the tab is handed the module table verdict', () => {
  /** The harness's own rejection for a name nothing provides — verbatim from
   * @deepseek-ai/dsh-client-modules 0.1.5-rc.3, since "absent" is keyed on it. */
  const cannotResolve = (specifier: string): Error =>
    new Error(`client-modules: cannot resolve "${specifier}" — not a seed word, not a materialized module, and not a row in the boot graph (the runtime mirror of the bundle purity gate)`)

  /** A page's `modules` service: react and react-dom are seed words, and
   * `cached` names what has materialized so far. */
  function moduleTable(cached: string[] = []) {
    const probe = vi.fn(async (specifier: string): Promise<unknown> => {
      if (specifier === 'react' || specifier === 'react-dom') return {}
      throw cannotResolve(specifier)
    })
    const table = {
      version: 'client',
      manifest: { rev: 'r1', modules: [], plugins: [] },
      loadCache: new Map<string, unknown>(cached.map(id => [id, { id, exports: {}, styles: [], edges: new Set() }])),
      import: probe,
    }
    return { table, probe }
  }

  /** What the host sends: node resolution found none of these, including the
   * two seed words the page serves from its own instances. */
  const hostSaid = (incompatible: Record<string, string[]>) => ({
    schemaVersion: 2, builtAt: '2026-09-24T00:00:00Z', stale: false,
    plugins: [], denied: [], stars: {}, incompatible,
    incompatibleHarness: { 'npm:declares-tui': { profile: { declared: ['tui'], running: 'web' } } },
  })
  const HOST = hostSaid({ 'npm:seed-only': ['react', 'react-dom'], 'npm:needs-absent': ['react', '@x/absent'] })
  const REFINED = { 'npm:needs-absent': ['@x/absent'] }

  it('hands the tab the warm result with every name the table provides removed, asking once per name', async () => {
    const { table, probe } = moduleTable()
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: HOST })
    const { injected } = await boot({ catalog }, table)
    const result = await injected.catalog(undefined)
    expect(result.incompatible).toEqual(REFINED)
    // Only the peer half changes: everything else is the host's result as sent.
    expect(result).toEqual({ ...HOST, incompatible: REFINED })
    // Once per distinct name per hand-over. A refinement run twice over one
    // result would ask `@x/absent` again — "exactly once" is this count.
    expect(probe.mock.calls.map(call => call[0]).sort()).toEqual(['@x/absent', 'react', 'react-dom'])
  })

  it('refines a refreshed result, and the fresh one a failed warm fetch falls back to', async () => {
    const { table } = moduleTable()
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'WIRE', message: 'down' } })
      .mockResolvedValue({ ok: true, value: HOST })
    const { injected } = await boot({ catalog }, table)
    expect((await injected.catalog(undefined)).incompatible).toEqual(REFINED) // the fallback
    expect((await injected.catalog({ refresh: true })).incompatible).toEqual(REFINED) // the refresh
    expect(catalog).toHaveBeenCalledTimes(3)
  })

  it('refines against a module table registered only after the shop booted', async () => {
    // The warm fetch starts during plugin boot, when nothing guarantees the
    // `modules` service is registered yet. Refining there would find no table
    // and hand the tab silence for a plugin that IS broken; refining when the
    // tab asks finds the table it will actually be served from.
    const { table } = moduleTable()
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: HOST })
    const { ctx, injected } = await boot({ catalog })
    ctx.provide('modules', table)
    expect((await injected.catalog(undefined)).incompatible).toEqual(REFINED)
    expect(catalog).toHaveBeenCalledTimes(1) // still the warm result
  })

  it('judges a stashed result against the table as it stands when the tab asks', async () => {
    // The stash keeps the host's own result, so each hand-over sees the table
    // of that moment: a module that materialized after the first open clears
    // the entry that wanted it, with no second wire call.
    const { table } = moduleTable()
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: HOST })
    const { injected } = await boot({ catalog }, table)
    expect((await injected.catalog(undefined)).incompatible).toEqual(REFINED)
    table.loadCache.set('@x/absent', { id: '@x/absent', exports: {}, styles: [], edges: new Set() })
    expect((await injected.catalog(undefined)).incompatible).toEqual({})
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('hands the tab no peer verdict at all when the page has no module table', async () => {
    // Not the host's list as it arrived: measured, that list is majority-false
    // on this harness line, and an unavailable fact must never read as an
    // accusation.
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: HOST })
    const { injected } = await boot({ catalog })
    const result = await injected.catalog(undefined)
    expect(result.incompatible).toEqual({})
    // The author's own declaration is not the module table's to judge.
    expect(result.incompatibleHarness).toEqual(HOST.incompatibleHarness)
  })
})

describe('shop client apply: the page-removed set and a bare incompatible result', () => {
  const hostSaid = (incompatible: Record<string, string[]>) => ({
    schemaVersion: 2, builtAt: '2026-09-24T00:00:00Z', stale: false,
    plugins: [], denied: [], stars: {}, incompatible, incompatibleHarness: {},
  })

  it('keeps "missing dock-base" after noteUninstalled(\'dock-base\'), although the table still lists it as a row', async () => {
    // dock-base has a client half and remains a graph row after a
    // restart-free uninstall — exactly the false "provided" the page-removed
    // set exists to prevent (module-table.ts's header; design
    // 2026-09-01-harness-compatibility section 9.1).
    const table = {
      version: 'client' as const,
      manifest: {
        rev: 'r1',
        modules: [{ id: 'dock-base', url: '/plugin/dock-base?rev=r1', initialUrl: '/batch?rev=r1', rev: 'r1', inject: [], external: [] }],
        plugins: [{ id: 'dock-base', inject: [], immediately: false }],
      },
      loadCache: new Map<string, unknown>(),
      import: vi.fn(async () => ({})),
    }
    const HOST = hostSaid({ 'npm:needs-dock-base': ['dock-base'] })
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: HOST })
    const { injected } = await boot({ catalog }, table)
    // Without noteUninstalled, the row clears the entry.
    expect((await injected.catalog(undefined)).incompatible).toEqual({})
    injected.noteUninstalled?.('dock-base')
    // The very same stashed host result, refined again: the page-removed set
    // now overrides the row, with no wire call needed — a hand-over refines
    // fresh every time regardless of which load path produced the underlying
    // host result (the "on the way OUT, never on the way in" comment above).
    expect((await injected.catalog(undefined)).incompatible).toEqual({ 'npm:needs-dock-base': ['dock-base'] })
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('resets the page-removed set on a fresh apply(), so a name noted uninstalled before does not carry over', async () => {
    // `pageRemoved` lives at module scope (index.ts), which is what lets it
    // survive the SAME tab closing and reopening — but that
    // scope is also wider than one page, and index.ts's own comment on the
    // reset (beside `warmCatalog`, at the top of apply()) says a re-applied
    // bundle is a new page that has uninstalled nothing yet. Two independent
    // boot() calls are two independent apply()s sharing the one module
    // instance, so the only way the second could still hide dock-base is a
    // missing reset leaking the first call's Set into it.
    const table = {
      version: 'client' as const,
      manifest: {
        rev: 'r1',
        modules: [{ id: 'dock-base', url: '/plugin/dock-base?rev=r1', initialUrl: '/batch?rev=r1', rev: 'r1', inject: [], external: [] }],
        plugins: [{ id: 'dock-base', inject: [], immediately: false }],
      },
      loadCache: new Map<string, unknown>(),
      import: vi.fn(async () => ({})),
    }
    const HOST = hostSaid({ 'npm:needs-dock-base': ['dock-base'] })
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: HOST })

    const first = await boot({ catalog }, table)
    first.injected.noteUninstalled?.('dock-base')
    expect((await first.injected.catalog(undefined)).incompatible).toEqual({ 'npm:needs-dock-base': ['dock-base'] })

    // A second, independent apply() over the SAME table and the SAME catalog
    // stub — but a fresh Context, and no noteUninstalled call on this face.
    const second = await boot({ catalog }, table)
    expect((await second.injected.catalog(undefined)).incompatible).toEqual({})
  })

  it('hands over without rejecting when the host result carries no incompatible field at all', async () => {
    // A host built at 0.5.4 or earlier: every other field is present, but
    // this one predates it. A usable table is provided too, so the
    // refinement cannot take its own no-table shortcut (oracle null) and must
    // actually reach `Object.entries(incompatible)` — the unguarded read that
    // `handOver`'s `?? {}` has to protect.
    const table = {
      version: 'client' as const,
      manifest: { rev: 'r1', modules: [], plugins: [] },
      loadCache: new Map<string, unknown>(),
      import: vi.fn(async () => ({})),
    }
    const bare = { schemaVersion: 2, builtAt: '2026-09-24T00:00:00Z', stale: false, plugins: [], denied: [], stars: {}, incompatibleHarness: {} }
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: bare })
    const { injected } = await boot({ catalog }, table)
    await expect(injected.catalog(undefined)).resolves.toMatchObject({ incompatible: {} })
  })
})

describe('shop client apply: the restart path it registers on the page', () => {
  // A self-update's HMR swap disposes this fiber and applies a fresh module
  // instance in its place. dsh's dispose aborts the restart call still in
  // flight on this mount (restart-monitor.ts says how that was measured), so
  // the page has to ask again through the replacement's mount.

  it('withdraws its path before it tears the mount down, so the replacement asks before the old call is aborted', async () => {
    const reissued = vi.fn(async () => ({ ok: true as const, value: { ok: true, logFile: '/home/you/.dsh/shop/restart.log' } }))
    const old = await boot({ restart: () => new Promise(() => {}) })
    void requestRestart({ reload: vi.fn(), restart: old.injected.restart })
    expect(readRestartMonitor()).toEqual({ kind: 'requesting' })
    const next = await boot({ restart: reissued })
    let askedBeforeTeardown: number | undefined
    old.disposer.mockImplementation(async () => { askedBeforeTeardown = reissued.mock.calls.length })
    await old.ctx.fiber.dispose()
    expect(old.disposer).toHaveBeenCalled()
    expect(askedBeforeTeardown).toBe(1)
    await vi.waitFor(() => { expect(readRestartMonitor()).toEqual({ kind: 'restarting', logFile: '/home/you/.dsh/shop/restart.log' }) })
    await next.ctx.fiber.dispose()
  })

  it('carries the tab\'s restart on its own mount while it is the one registered', async () => {
    const restart = vi.fn(async () => ({ ok: true as const, value: { ok: true } }))
    const { ctx, injected } = await boot({ restart })
    await expect(requestRestart({ reload: vi.fn(), restart: injected.restart })).resolves.toEqual({ kind: 'started' })
    expect(restart).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })
})

describe('shop client apply: dsh restarting under the page', () => {
  // dsh's client reconnects to whatever server holds the origin and emits
  // `connection/reset` on every connect (dsh-api-gateway's
  // ClientRemoteService, 0.1.5-rc.3 through 0.2.0-rc.2) — and nothing reloads
  // the shop. A restart from a terminal, by a supervisor, or one whose own
  // reload never came left an open tab on the old process's answers: the old
  // version, an update still "waiting for a restart", and every card still
  // asking for one (design §8, 2026-10-06 amendment).

  const LOG = '/home/you/.dsh/shop/restart.log'
  const fakeCatalog = {
    schemaVersion: 2, builtAt: '2026-08-27T00:00:00Z', stale: false,
    plugins: [], denied: [], stars: {}, incompatible: {}, incompatibleHarness: {},
  }
  const answer = (bootId: string): { ok: true; value: ShopVersionResult } => ({
    ok: true,
    value: { installed: '0.8.6', latest: '0.8.6', outdated: false, restartBlocked: null, pendingVersion: null, bootId },
  })
  /** What a reload leaves of the page: no restart-monitor record and no probe
   * loop, but the tab's sessionStorage — and so the record of the restart it
   * asked for. */
  const pageReloaded = (): void => {
    const page = globalThis as unknown as Record<symbol, { stop?: (() => void) | null } | undefined>
    const key = Symbol.for('dsh-plugin-shop.restart-monitor')
    page[key]?.stop?.()
    delete page[key]
  }
  /** The face's subscription; failing loudly rather than skipping, since an
   * optional call on an absent one would let every case below pass. */
  const onRestarted = (injected: ShopTabInjected): NonNullable<ShopTabInjected['onRestarted']> => {
    if (injected.onRestarted === undefined) throw new Error('the face offers no onRestarted')
    return injected.onRestarted
  }

  it('judges the last restart by the first answer the reloaded page gets, before any tab opens', async () => {
    startRestartMonitor({ reload: vi.fn(), logFile: LOG, bootId: 'boot-a', pid: 4242 })
    pageReloaded()
    await boot({ version: vi.fn().mockResolvedValue(answer('boot-a')) })
    await vi.waitFor(() => { expect(readRestartMonitor()).toEqual({ kind: 'not-restarted', pid: 4242, logFile: LOG }) })
  })

  it('asks who is answering on every reconnect, so a later restart clears the verdict with no tab open', async () => {
    startRestartMonitor({ reload: vi.fn(), logFile: LOG, bootId: 'boot-a', pid: 4242 })
    pageReloaded()
    const version = vi.fn().mockResolvedValueOnce(answer('boot-a')).mockResolvedValue(answer('boot-b'))
    const { ctx } = await boot({ version })
    await vi.waitFor(() => { expect(readRestartMonitor()?.kind).toBe('not-restarted') })
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(readRestartMonitor()).toBeNull() })
    expect(version).toHaveBeenCalledTimes(2)
  })

  it('tells the tab once the answers come from another process, with the first answer from it', async () => {
    const version = vi.fn().mockResolvedValueOnce(answer('boot-a')).mockResolvedValue(answer('boot-b'))
    const { ctx, injected } = await boot({ version })
    const heard = vi.fn()
    onRestarted(injected)(heard)
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(1) })
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(heard).toHaveBeenCalledTimes(1) })
    expect(heard).toHaveBeenCalledWith(expect.objectContaining({ bootId: 'boot-b' }))
  })

  it('says nothing when the reconnect finds the same process', async () => {
    // dsh's socket also drops and comes back to the process it left.
    const version = vi.fn().mockResolvedValue(answer('boot-a'))
    const { ctx, injected } = await boot({ version })
    const heard = vi.fn()
    onRestarted(injected)(heard)
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(2) })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(heard).not.toHaveBeenCalled()
  })

  it("tells the tab when its own version check is what finds the new process", async () => {
    // The tab's checks pass through the same face; whichever answer is first
    // to come from the new process is the one that says so.
    const version = vi.fn().mockResolvedValueOnce(answer('boot-a')).mockResolvedValue(answer('boot-b'))
    const { injected } = await boot({ version })
    const heard = vi.fn()
    onRestarted(injected)(heard)
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(1) })
    await expect(injected.version()).resolves.toMatchObject({ bootId: 'boot-b' })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('stops telling a tab that unsubscribed', async () => {
    const version = vi.fn().mockResolvedValueOnce(answer('boot-a')).mockResolvedValue(answer('boot-b'))
    const { ctx, injected } = await boot({ version })
    const heard = vi.fn()
    const unsubscribe = onRestarted(injected)(heard)
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(1) })
    unsubscribe()
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(2) })
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(heard).not.toHaveBeenCalled()
  })

  it("drops the warm catalog once another process answers: the old one's verdicts are not the new one's", async () => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const version = vi.fn().mockResolvedValueOnce(answer('boot-a')).mockResolvedValue(answer('boot-b'))
    const { ctx, injected } = await boot({ catalog, version })
    const heard = vi.fn()
    onRestarted(injected)(heard)
    expect(catalog).toHaveBeenCalledTimes(1) // the boot-time warm
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(1) })
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(heard).toHaveBeenCalledTimes(1) })
    await injected.catalog(undefined)
    expect(catalog).toHaveBeenCalledTimes(2)
  })

  it('keeps the warm catalog across a reconnect to the same process', async () => {
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: fakeCatalog })
    const version = vi.fn().mockResolvedValue(answer('boot-a'))
    const { ctx, injected } = await boot({ catalog, version })
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(1) })
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(2) })
    await injected.catalog(undefined)
    expect(catalog).toHaveBeenCalledTimes(1)
  })
})

describe('shop client apply: the page store (design 2026-10-16-shop-sidebar-page §5)', () => {
  /** The face's store, failing loudly rather than skipping when there is none. */
  const pageOf = (injected: ShopTabInjected): ShopPageStore => {
    if (injected.page === undefined) throw new Error('the face hands over no page store')
    return injected.page
  }

  it('builds the page\'s store, puts it on the page and hands it to the main-column entry', async () => {
    const { ctx, injected } = await boot()
    expect(readPageStore()).toEqual({ kind: 'store', store: pageOf(injected) })
    // The face is built per read; the store is the page's, the same each time.
    const entry = ctx.slots.entries('main').find(e => e.options.key === 'shop')
    if (entry === undefined) throw new Error('the shop page entry is not registered')
    expect((entry.inject!() as unknown as ShopTabInjected).page).toBe(pageOf(injected))
  })

  it('builds a new store on a fresh apply, and the one it replaces stops polling', async () => {
    const installStart = vi.fn().mockResolvedValue({ ok: true, value: { ok: true, installId: 'i1', state: 'running' } })
    const installStatus = vi.fn().mockResolvedValue({ ok: true, value: { found: true, state: 'running', log: [] } })
    const first = await boot({ installStart, installStatus })
    await pageOf(first.injected).installs.start('npm:dsh-hello-plugin', { name: 'dsh-hello-plugin', version: '1.2.0' })
    await vi.waitFor(() => { expect(installStatus).toHaveBeenCalled() }, { timeout: 3000 })
    await first.ctx.fiber.dispose()
    const polled = installStatus.mock.calls.length
    // Longer than one poll interval: a timer the dispose missed would fire.
    await new Promise(resolve => { setTimeout(resolve, INSTALL_POLL_MS + 500) })
    expect(installStatus.mock.calls.length).toBe(polled)
    const second = await boot()
    expect(pageOf(second.injected)).not.toBe(pageOf(first.injected))
    expect(readPageStore()).toEqual({ kind: 'store', store: pageOf(second.injected) })
  })

  it('disposes a predecessor whose teardown never ran', async () => {
    const installStart = vi.fn().mockResolvedValue({ ok: true, value: { ok: true, installId: 'i1', state: 'running' } })
    const installStatus = vi.fn().mockResolvedValue({ ok: true, value: { found: true, state: 'running', log: [] } })
    const first = await boot({ installStart, installStatus })
    await pageOf(first.injected).installs.start('npm:dsh-hello-plugin', { name: 'dsh-hello-plugin', version: '1.2.0' })
    await vi.waitFor(() => { expect(installStatus).toHaveBeenCalled() }, { timeout: 3000 })
    await boot() // the first fiber is never disposed
    const polled = installStatus.mock.calls.length
    await new Promise(resolve => { setTimeout(resolve, INSTALL_POLL_MS + 500) })
    expect(installStatus.mock.calls.length).toBe(polled)
  })

  it('tells the page\'s store when dsh restarted under the page, with no tab mounted', async () => {
    const answer = (bootId: string) => ({ ok: true as const, value: { installed: '0.8.7', latest: '0.8.7', outdated: false, restartBlocked: null, pendingVersion: null, bootId } })
    const version = vi.fn().mockResolvedValueOnce(answer('boot-a')).mockResolvedValue(answer('boot-b'))
    const { ctx, injected } = await boot({ version })
    await vi.waitFor(() => { expect(version).toHaveBeenCalledTimes(1) })
    const before = pageOf(injected).getSnapshot().settled
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(pageOf(injected).getSnapshot().settled).toBe(before + 1) })
    expect(pageOf(injected).getSnapshot().reverdictPending).toBe(true)
  })

  it('names a package an uninstall no tab watched removed, for the page-removed set', async () => {
    // dock-base keeps a graph row after a restart-free uninstall, the false
    // "provided" the page-removed set exists to refuse (module-table.ts).
    const table = {
      version: 'client' as const,
      manifest: {
        rev: 'r1',
        modules: [{ id: 'dock-base', url: '/plugin/dock-base?rev=r1', initialUrl: '/batch?rev=r1', rev: 'r1', inject: [], external: [] }],
        plugins: [{ id: 'dock-base', inject: [], immediately: false }],
      },
      loadCache: new Map<string, unknown>(),
      import: vi.fn(async () => ({})),
    }
    const HOST = {
      schemaVersion: 2, builtAt: '2026-09-24T00:00:00Z', stale: false,
      plugins: [], denied: [], stars: {}, incompatible: { 'npm:needs-dock-base': ['dock-base'] }, incompatibleHarness: {},
    }
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: HOST })
    const uninstallStart = vi.fn().mockResolvedValue({ ok: true, value: { ok: true, installId: 'u1' } })
    const installStatus = vi.fn().mockResolvedValue({ ok: true, value: { found: true, state: 'done', log: [], activation: 'live' } })
    const { injected } = await boot({ catalog, uninstallStart, installStatus }, table)
    expect((await injected.catalog(undefined)).incompatible).toEqual({})
    await pageOf(injected).uninstalls.start('npm:dock-base', { name: 'dock-base' })
    await vi.waitFor(() => { expect(pageOf(injected).uninstalls.getSnapshot().views.get('npm:dock-base')?.kind).toBe('done') }, { timeout: 3000 })
    expect((await injected.catalog(undefined)).incompatible).toEqual({ 'npm:needs-dock-base': ['dock-base'] })
  })

  it('sends the reverdict an unwatched install left to the wire, past the stash a mount refilled while it ran', async () => {
    // The whole chain the store closes, through the real stash (design
    // 2026-10-16-shop-sidebar-page §5.4): the install drops the stash when it
    // starts, a mount while it runs refills it with verdicts judged before it
    // lands, and the reverdict its settle leaves must pass that stash, reach
    // the wire and become the stash itself. `builtAt` tells the answers apart.
    const verdicts = (builtAt: string) => ({
      schemaVersion: 2, builtAt, stale: false,
      plugins: [], denied: [], stars: {}, incompatible: {}, incompatibleHarness: {},
    })
    const BEFORE = verdicts('2026-10-16T00:00:00Z')
    const AFTER = verdicts('2026-10-17T00:00:00Z')
    const catalog = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: BEFORE }) // the boot-time warm
      .mockResolvedValueOnce({ ok: true, value: BEFORE }) // the mid-install mount's, judged before the install lands
      .mockResolvedValue({ ok: true, value: AFTER }) // judged after it
    const installStart = vi.fn().mockResolvedValue({ ok: true, value: { ok: true, installId: 'i1', state: 'running' } })
    const installStatus = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { found: true, state: 'running', log: [] } })
      .mockResolvedValue({ ok: true, value: { found: true, state: 'done', log: [], activation: 'live' } })
    const { injected } = await boot({ catalog, installStart, installStatus })
    const page = pageOf(injected)
    expect(catalog).toHaveBeenCalledTimes(1) // the boot-time warm
    // (1) The install starts, and its start drops the stash.
    await page.installs.start('npm:dsh-hello-plugin', { name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(page.installs.getSnapshot().views.get('npm:dsh-hello-plugin')?.kind).toBe('running')
    expect(catalog).toHaveBeenCalledTimes(1)
    // (2) A tab mounted while it runs asks plainly. The dropped stash sends it
    // to the wire, and the answer, judged before the install lands, is the
    // stash again.
    expect(await injected.catalog(undefined)).toMatchObject({ builtAt: BEFORE.builtAt })
    expect(catalog).toHaveBeenCalledTimes(2)
    // (3) The install lands with no tab mounted, and its settle leaves the
    // reverdict pending.
    await vi.waitFor(() => { expect(page.getSnapshot().reverdictPending).toBe(true) }, { timeout: 4000 })
    expect(page.installs.getSnapshot().views.get('npm:dsh-hello-plugin')?.kind).toBe('done')
    expect(catalog).toHaveBeenCalledTimes(2)
    // (4) The next mount's first request is that reverdict: it passes the
    // refilled stash and reaches the wire...
    expect(await injected.catalog({ reverdict: true })).toMatchObject({ builtAt: AFTER.builtAt })
    expect(catalog).toHaveBeenCalledTimes(3)
    // (5) ...and its answer is the stash a following plain open is served
    // from, with no wire call.
    expect(await injected.catalog(undefined)).toMatchObject({ builtAt: AFTER.builtAt })
    expect(catalog).toHaveBeenCalledTimes(3)
  })

  it('replaces a store of another shape without calling what it lacks, as after a downgrade', async () => {
    installPageStore({ schema: 2 } as unknown as ShopPageStore)
    const { injected } = await boot()
    expect(readPageStore()).toEqual({ kind: 'store', store: pageOf(injected) })
  })
})

describe('shop client apply: the hand-over after a hot swap (design 2026-10-16-shop-sidebar-page §6)', () => {
  /** A page no shop has applied on: neither store on `globalThis`. The
   * shared afterEach's resetRestartMonitor() recreates the monitor's store,
   * so it is deleted here, before every case. */
  const freshPage = (): void => {
    resetPageStore()
    resetRestartMonitor()
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('dsh-plugin-shop.restart-monitor')]
  }
  beforeEach(freshPage)
  const answer = (pendingVersion: string | null) => ({
    ok: true as const,
    value: { installed: '0.9.0', latest: '0.9.1', outdated: true, restartBlocked: null, pendingVersion, bootId: 'boot-a' },
  })
  /** Waits for the first version request, then a little longer. From that
   * request to a move runs only through microtasks (the stub's answer,
   * `version`'s unwrap, the rule's `then`), so the extra wait always covers a
   * move. A "moves nobody" case owes its non-vacuity elsewhere: its
   * `readPredecessor()` pre-assertion names the row it starts from, and a
   * moving neighbour passes under this same wait. */
  const settle = async (version: ReturnType<typeof vi.fn>): Promise<void> => {
    await vi.waitFor(() => { expect(version).toHaveBeenCalled() })
    await new Promise(resolve => { setTimeout(resolve, 20) })
  }
  /** The reader is on the page: dsh mounts it when its key is selected, and
   * ShopPage's mount effect tells the store (ShopPage.tsx). This file renders no
   * panel, so the case does what the page would. */
  const readerOnPage = (layout: { service: { selectPanel: (id: string | null) => void } } | undefined): void => {
    layout?.service.selectPanel('shop')
    const occupant = readPageStore()
    if (occupant.kind !== 'store') throw new Error('apply put no page store on the page')
    occupant.store.notePageMounted(true)
  }

  it('rule 1: brings the page back after a swap took it from the reader, once an update waits for a restart', async () => {
    const first = await boot({ version: vi.fn().mockResolvedValue(answer('0.9.1')) }, undefined, { layout: true })
    readerOnPage(first.layout)
    await first.ctx.fiber.dispose()
    // The entry left, so dsh's layout fell back to the conversation…
    expect(first.layout?.selected()).toBeNull()
    // …but the record reads the page's own mount, which no selection touches.
    expect(readPredecessor()).toEqual({ kind: 'page', showing: true })
    const version = vi.fn().mockResolvedValue(answer('0.9.1'))
    const second = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(second.layout?.service.selectPanel).toHaveBeenCalledTimes(1)
    expect(second.layout?.selected()).toBe('shop')
  })

  it('rule 1: selects the page once per apply, however many version answers follow', async () => {
    const first = await boot({ version: vi.fn().mockResolvedValue(answer('0.9.1')) }, undefined, { layout: true })
    readerOnPage(first.layout)
    await first.ctx.fiber.dispose()
    expect(readPredecessor()).toEqual({ kind: 'page', showing: true })
    const version = vi.fn().mockResolvedValue(answer('0.9.1'))
    const second = await boot({ version }, undefined, { layout: true })
    await settle(version)
    // A tab's own check and every reconnect's re-ask answer through the same
    // `version`, and the update still waits.
    await second.injected.version()
    await settle(version)
    expect(version).toHaveBeenCalledTimes(2)
    expect(second.layout?.service.selectPanel).toHaveBeenCalledTimes(1)
  })

  it('rule 1: records the page as showing even on a host that unmounts it the moment its entry leaves', async () => {
    const first = await boot({ version: vi.fn().mockResolvedValue(answer('0.9.1')) }, undefined, { layout: true, unmountOnLeave: true })
    readerOnPage(first.layout)
    await first.ctx.fiber.dispose()
    expect(readPredecessor()).toEqual({ kind: 'page', showing: true })
  })

  it('rule 1: leaves the reader where they were when the page was not showing', async () => {
    const first = await boot({ version: vi.fn().mockResolvedValue(answer('0.9.1')) }, undefined, { layout: true })
    await first.ctx.fiber.dispose()
    expect(readPredecessor()).toEqual({ kind: 'page', showing: false })
    const version = vi.fn().mockResolvedValue(answer('0.9.1'))
    const second = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(second.layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('rule 1: moves nobody when no update waits, as after the bundle is switched off and on', async () => {
    const first = await boot({ version: vi.fn().mockResolvedValue(answer(null)) }, undefined, { layout: true })
    readerOnPage(first.layout)
    await first.ctx.fiber.dispose()
    // The page WAS showing: what holds the reader still is the answer alone.
    expect(readPredecessor()).toEqual({ kind: 'page', showing: true })
    const version = vi.fn().mockResolvedValue(answer(null))
    const second = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(second.layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('rule 1: leaves the reader where they were after a downgrade from a later shop, even with an update waiting', async () => {
    // What a later shop leaves on the page after a downgrade: the restart
    // monitor's store, and a page store of another schema. As in every case
    // below that registers one, the predecessor's teardown withdrew its
    // carrier: the store it leaves is what names a predecessor.
    const withdraw = registerRestartCarrier(async () => ({ ok: true }))
    withdraw()
    installPageStore({ schema: 2, dispose: () => {} } as unknown as ShopPageStore)
    expect(readPredecessor()).toEqual({ kind: 'page', showing: false })
    const version = vi.fn().mockResolvedValue(answer('0.9.0'))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('rule 1: moves nobody after a downgrade from a later shop when no update waits', async () => {
    const withdraw = registerRestartCarrier(async () => ({ ok: true }))
    withdraw()
    installPageStore({ schema: 2, dispose: () => {} } as unknown as ShopPageStore)
    expect(readPredecessor()).toEqual({ kind: 'page', showing: false })
    const version = vi.fn().mockResolvedValue(answer(null))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('rule 2: brings up the page after a swap from a 0.8.x shop, once an update waits for a restart', async () => {
    // What a 0.8.4–0.8.7 shop leaves on the page: the restart monitor's store, no page store.
    const withdraw = registerRestartCarrier(async () => ({ ok: true }))
    withdraw()
    expect(readPredecessor()).toEqual({ kind: 'section' })
    const version = vi.fn().mockResolvedValue(answer('0.9.0'))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).toHaveBeenCalledTimes(1)
    expect(layout?.selected()).toBe('shop')
  })

  it('rule 2: brings up the page after a swap from a shop that kept the page store but still lived in Settings', async () => {
    // What a build with the page store but not yet the page leaves: the
    // restart monitor's store, and a schema-1 page store with no hand-over.
    const withdraw = registerRestartCarrier(async () => ({ ok: true }))
    withdraw()
    installPageStore({ schema: 1, dispose: () => {} } as unknown as ShopPageStore)
    const version = vi.fn().mockResolvedValue(answer('0.9.0'))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).toHaveBeenCalledTimes(1)
    expect(layout?.selected()).toBe('shop')
  })

  it('rule 2: moves nobody when no update waits', async () => {
    const withdraw = registerRestartCarrier(async () => ({ ok: true }))
    withdraw()
    expect(readPredecessor()).toEqual({ kind: 'section' })
    const version = vi.fn().mockResolvedValue(answer(null))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('rule 2: moves nobody when no update waits, after a swap from a shop that kept the page store but still lived in Settings', async () => {
    const withdraw = registerRestartCarrier(async () => ({ ok: true }))
    withdraw()
    installPageStore({ schema: 1, dispose: () => {} } as unknown as ShopPageStore)
    expect(readPredecessor()).toEqual({ kind: 'section' })
    const version = vi.fn().mockResolvedValue(answer(null))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('rule 2: moves nobody when the first version request fails', async () => {
    const withdraw = registerRestartCarrier(async () => ({ ok: true }))
    withdraw()
    expect(readPredecessor()).toEqual({ kind: 'section' })
    const version = vi.fn().mockResolvedValue({ ok: false, error: { code: 'WIRE', message: 'down' } })
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('a fresh page moves nobody, even with an update waiting', async () => {
    expect(readPredecessor()).toEqual({ kind: 'none' })
    const version = vi.fn().mockResolvedValue(answer('0.9.1'))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).not.toHaveBeenCalled()
  })

  it('a fresh page moves nobody when no update waits', async () => {
    expect(readPredecessor()).toEqual({ kind: 'none' })
    const version = vi.fn().mockResolvedValue(answer(null))
    const { layout } = await boot({ version }, undefined, { layout: true })
    await settle(version)
    expect(layout?.service.selectPanel).not.toHaveBeenCalled()
  })
})
