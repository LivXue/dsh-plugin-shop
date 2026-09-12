import { describe, expect, it } from 'vitest'
import { activationOf } from '../../src/host/activation.ts'

describe('activationOf', () => {
  it('demands a restart whenever the host half is not running', () => {
    // A client half cannot rescue a host half that never composed: the
    // browser graph is built from the LOADER's entries, so a package the
    // loader does not hold contributes nothing to reload into.
    expect(activationOf({ hostLive: false, hasClientHalf: true })).toBe('restart')
    expect(activationOf({ hostLive: false, hasClientHalf: false })).toBe('restart')
  })

  it('asks for a reload when the host is live and the package has a browser half', () => {
    expect(activationOf({ hostLive: true, hasClientHalf: true })).toBe('reload')
  })

  it('reports live when the host is live and there is no browser half to refresh', () => {
    expect(activationOf({ hostLive: true, hasClientHalf: false })).toBe('live')
  })
})
