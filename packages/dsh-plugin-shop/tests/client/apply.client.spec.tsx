// @vitest-environment jsdom
import './__loader__.ts'
import { loadModule } from './__loader__.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { apply, inject, NS } from '../../src/client/index.ts'
import { useInstall } from '../../src/client/useInstall.ts'
import type { StoreTabInjected } from '../../src/client/StoreTab.tsx'
import type { InstallArgs, StoreInstallResult } from '../../src/host/index.ts'

// The published dsh client packages expose their browser bundles (a
// `__ModuleLoader__.load` handoff) as the `./client` default; their exports
// exist only inside the loader, so the test fetches them through the loader —
// the same channel the web shell uses — rather than through a named import.
const { Context } = loadModule<typeof import('@deepseek-ai/cordis')>('@deepseek-ai/cordis')
const { LocaleRuntime } = loadModule<typeof import('@deepseek-ai/dsh-client-locale/client')>('@deepseek-ai/dsh-client-locale')
const { SlotRegistry } = loadModule<typeof import('@deepseek-ai/dsh-client-runtime/client')>('@deepseek-ai/dsh-client-runtime')

afterEach(cleanup)

/** One stubbed store method: return the wire envelope of your choice. The
 * stub speaks the WIRE name `installStart` — index.ts unwraps
 * `ctx.remote.store.installStart` (§7.3 amendment: the wire method is
 * installStart, never install, which the namespace service owns). */
interface StoreStub {
  installStart?: (args: InstallArgs) => Promise<unknown>
}

/** Boot apply() against a stubbed remote and return the store tab entry's
 * injected face — the real unwrap from index.ts sits between the wire
 * envelopes the stub returns and the injected methods the tab calls. */
async function boot(store: StoreStub = {}) {
  const ctx = new Context()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
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
  // The tab's injected face reads the namespace through the reflect store
  // (`ctx.get`), the same channel the real mount registers it on — index.ts
  // cannot use `ctx.remote.store`, which the inject gate refuses (see the
  // deadlock comment there). The stub speaks the WIRE names.
  ctx.provide('remote.store', {
    catalog: vi.fn(),
    installStart: store.installStart ?? vi.fn(),
    installStatus: vi.fn(),
    setEnabled: vi.fn(),
    outdated: vi.fn(),
  })
  await apply(ctx)
  const entry = ctx.slots.entries('settings.plugins.tab').find(e => e.options.id === 'store')
  if (entry === undefined) throw new Error('the store tab entry is not registered')
  const injected = entry.inject!() as unknown as StoreTabInjected
  return { ctx, locale, mounted, disposer, injected }
}

describe('store client apply', () => {
  it('mounts the store remote, registers the locale namespace and the store tab', async () => {
    const { ctx, locale, mounted, disposer } = await boot()

    expect(inject).toEqual(['remote', 'slots', 'locale'])
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ package: 'dsh-plugin-shop' })
    expect(locale.bind(NS)('tab')).toBe('Plugin store')
    // The runtime augments the cordis Context with the slots service; the
    // accessor is typed, so there is no cast to the class.
    const slots = ctx.slots
    expect(slots.entries('settings.plugins.tab').some(entry => entry.options.id === 'store')).toBe(true)
    await ctx.fiber.dispose()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0) // the tab is disposed with the context
    expect(disposer).toHaveBeenCalled()
  })

  it('routes a host business rejection through the real unwrap as a resolved value', async () => {
    const rejection: StoreInstallResult = {
      ok: false,
      code: 'denied',
      detail: 'dsh-plugin-shop: dsh-blocked is denied: matched the denylist',
    }
    const { injected } = await boot({
      installStart: async () => ({ ok: true as const, value: rejection }),
    })
    const args: InstallArgs = { name: 'dsh-blocked', version: '1.0.0', acknowledged: true }
    // The host's business rejection is a method RESULT, not a wire error: the
    // envelope is ok:true with the StoreInstallResult union as its value, and
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
    await expect(injected.install(args)).rejects.toThrow('store remote: WIRE: boom')
    // And useInstall.start catches that throw into the failed view — the
    // `rejected` state stays reserved for the host's business union (§7.2).
    // The transport detail is private (it can name hosts and ports) and never
    // rendered, so the failed view carries an EMPTY detail; StoreTab falls
    // back to the localized installTransportFailed line (R-P2-15).
    const { result } = renderHook(() => useInstall(injected.install, injected.installStatus))
    await act(async () => {
      await result.current.start(args)
    })
    expect(result.current.view).toEqual({ kind: 'failed', detail: '', log: [] })
  })
})
