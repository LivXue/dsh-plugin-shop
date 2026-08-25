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

afterEach(cleanup)

describe('store client apply', () => {
  it('mounts the store remote and registers the locale namespace', async () => {
    const ctx = new Context()
    const locale = new LocaleRuntime(ctx)
    ctx.provide('locale', locale)
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
    await ctx.fiber.dispose()
  })
})
