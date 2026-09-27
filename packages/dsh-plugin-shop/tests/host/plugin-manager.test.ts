// tests/host/plugin-manager.test.ts
import { describe, expect, it } from 'vitest'
import { asPluginManager } from '../../src/host/plugin-manager.ts'

const fn = async (): Promise<unknown> => ({})
const complete = { installBundle: fn, removeBundle: fn, setPluginEnabled: fn, setBundleEnabled: fn, cancelInstall: fn }

describe('asPluginManager', () => {
  it('takes a service that offers every operation the shop calls', () => {
    expect(asPluginManager(complete)).toBe(complete)
  })

  it('refuses a service missing any one of the four operations', () => {
    // A harness offering half the service would take an install through it
    // and then fail the uninstall; all or nothing is the rule.
    for (const method of ['installBundle', 'removeBundle', 'setPluginEnabled', 'setBundleEnabled'] as const) {
      const partial: Record<string, unknown> = { ...complete }
      delete partial[method]
      expect(asPluginManager(partial), method).toBeNull()
    }
  })

  it('takes a service without cancelInstall, which only the deadline uses', () => {
    const { cancelInstall: _unused, ...rest } = complete
    expect(asPluginManager(rest)).not.toBeNull()
  })

  it('refuses what is not a service at all', () => {
    expect(asPluginManager(undefined)).toBeNull()
    expect(asPluginManager(null)).toBeNull()
    expect(asPluginManager('pluginManager')).toBeNull()
  })
})
