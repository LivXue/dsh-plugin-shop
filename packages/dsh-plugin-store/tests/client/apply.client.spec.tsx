// @vitest-environment jsdom
import './__loader__.ts'
import { loadModule } from './__loader__.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import { apply, inject, NS } from '../../src/client/index.ts'

// The published dsh client packages expose their browser bundles (a
// `__ModuleLoader__.load` handoff) as the `./client` default; their exports
// exist only inside the loader, so the test fetches them through the loader —
// the same channel the web shell uses — rather than through a named import.
const { Context } = loadModule<typeof import('@deepseek-ai/cordis')>('@deepseek-ai/cordis')
const { LocaleRuntime } = loadModule<typeof import('@deepseek-ai/dsh-client-locale/client')>('@deepseek-ai/dsh-client-locale')
const { SlotRegistry } = loadModule<typeof import('@deepseek-ai/dsh-client-runtime/client')>('@deepseek-ai/dsh-client-runtime')

afterEach(cleanup)

describe('store client apply', () => {
  it('mounts the store remote, registers the locale namespace and the store tab', async () => {
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

    await apply(ctx)

    expect(inject).toEqual(['remote', 'slots', 'locale'])
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ package: 'dsh-plugin-store' })
    expect(locale.bind(NS)('tab')).toBe('Plugin store')
    // The runtime augments the cordis Context with the slots service; the
    // accessor is typed, so there is no cast to the class.
    const slots = ctx.slots
    expect(slots.entries('settings.plugins.tab').some(entry => entry.options.id === 'store')).toBe(true)
    await ctx.fiber.dispose()
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0) // the tab is disposed with the context
    expect(disposer).toHaveBeenCalled()
  })
})
