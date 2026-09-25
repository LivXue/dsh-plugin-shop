// @vitest-environment jsdom
import './__loader__.ts'
import { loadModule } from './__loader__.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { apply, inject, NS, WARM_TTL_MS } from '../../src/client/index.ts'
import { useInstallFlows } from '../../src/client/useInstall.ts'
import type { ShopTabInjected } from '../../src/client/ShopTab.tsx'
import type { InstallArgs, ShopInstallResult } from '../../src/host/index.ts'

// The published dsh client packages expose their browser bundles (a
// `__ModuleLoader__.load` handoff) as the `./client` default; their exports
// exist only inside the loader, so the test fetches them through the loader —
// the same channel the web shell uses — rather than through a named import.
const { Context } = loadModule<typeof import('@deepseek-ai/cordis')>('@deepseek-ai/cordis')
const { LocaleRuntime } = loadModule<typeof import('@deepseek-ai/dsh-client-locale/client')>('@deepseek-ai/dsh-client-locale')
const { SlotRegistry } = loadModule<typeof import('@deepseek-ai/dsh-client-runtime/client')>('@deepseek-ai/dsh-client-runtime')

afterEach(cleanup)

/** One stubbed shop method: return the wire envelope of your choice. The
 * stub speaks the WIRE name `installStart` — index.ts unwraps
 * `ctx.remote.shop.installStart` (§7.3 amendment: the wire method is
 * installStart, never install, which the namespace service owns). */
interface ShopStub {
  installStart?: (args: InstallArgs) => Promise<unknown>
  uninstallStart?: (args: { name: string }) => Promise<unknown>
  updateStart?: (args: { version: string }) => Promise<unknown>
  catalog?: () => Promise<unknown>
}

/** Boot apply() against a stubbed remote and return the shop tab entry's
 * injected face — the real unwrap from index.ts sits between the wire
 * envelopes the stub returns and the injected methods the tab calls.
 *
 * @param modules the page's `modules` service, provided before the shop boots
 *   the way the web shell provides it; omitted, the page has none. */
async function boot(shop: ShopStub = {}, modules?: unknown) {
  const ctx = new Context()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  if (modules !== undefined) ctx.provide('modules', modules)
  await ctx.plugin(SlotRegistry).await()
  // The settings surface declares the tab seat at boot in the real shell;
  // declaring it here makes the tab's inject callback run synchronously
  // inside apply (the inventory browser spec declares it the same way).
  ctx.slots.register({
    name: 'root',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
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
    installStatus: vi.fn(),
    setEnabled: vi.fn(),
    installed: vi.fn(),
    uninstallStart: shop.uninstallStart ?? vi.fn(),
    restart: vi.fn(),
    version: vi.fn(),
    updateStart: shop.updateStart ?? vi.fn(),
  })
  await apply(ctx)
  const entry = ctx.slots.entries('settings.plugins.tab').find(e => e.options.id === 'shop')
  if (entry === undefined) throw new Error('the shop tab entry is not registered')
  const injected = entry.inject!() as unknown as ShopTabInjected
  return { ctx, locale, mounted, disposer, injected }
}

describe('shop client apply', () => {
  it('mounts the shop remote, registers the locale namespace and the shop tab', async () => {
    const { ctx, locale, mounted, disposer } = await boot()

    expect(inject).toEqual(['remote', 'slots', 'locale'])
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ package: 'dsh-plugin-shop' })
    expect(locale.bind(NS)('tab')).toBe('Plugin shop')
    // The runtime augments the cordis Context with the slots service; the
    // accessor is typed, so there is no cast to the class.
    const slots = ctx.slots
    expect(slots.entries('settings.plugins.tab').some(entry => entry.options.id === 'shop')).toBe(true)
    await ctx.fiber.dispose()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0) // the tab is disposed with the context
    expect(disposer).toHaveBeenCalled()
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
    // Driven through `useInstallFlows`, which is the registry the shop
    // actually ships. This used to drive `useInstall`, a single-view hook
    // with no production caller left — so the assertion was made about a
    // code path no reader could reach, while the shipped one implemented the
    // same rule separately and uncovered.
    const { result } = renderHook(() => useInstallFlows(injected.install, injected.installStatus))
    await act(async () => {
      await result.current.flowFor('k').start(args)
    })
    expect(result.current.flowFor('k').view).toEqual({ kind: 'failed', detail: '', log: [] })
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
