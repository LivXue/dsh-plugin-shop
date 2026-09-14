import { describe, expect, it } from 'vitest'
import { activationOf } from '../../src/host/activation.ts'

describe('activationOf', () => {
  it('demands a restart whenever the host half is not running', () => {
    // A client half cannot rescue a host half that never composed: the
    // browser graph is built from the LOADER's entries, so a package the
    // loader does not hold contributes nothing to reload into.
    expect(activationOf({ hostLive: false, clientLive: true, hasClientHalf: true })).toBe('restart')
    expect(activationOf({ hostLive: false, clientLive: true, hasClientHalf: false })).toBe('restart')
  })

  it('reports live when there is no browser half to refresh', () => {
    // `clientLive` cannot matter here — there is nothing for either a reload
    // or a restart to bring in — so both spellings answer the same.
    expect(activationOf({ hostLive: true, clientLive: true, hasClientHalf: false })).toBe('live')
    expect(activationOf({ hostLive: true, clientLive: false, hasClientHalf: false })).toBe('live')
  })

  it('asks for a reload when the browser half is in the graph the server hands out', () => {
    expect(activationOf({ hostLive: true, clientLive: true, hasClientHalf: true })).toBe('reload')
  })

  it('demands a restart when the browser half is NOT in that graph', () => {
    // The case a hot mount lands in. `ClientModuleRegistry` composes
    // `window.__DSH_BOOT__` from the BOOT composition; a hot mount adds to
    // the live loader entries without entering it, so a reload fetches a
    // graph that does not contain the package. Measured 2026-09-14 against
    // dsh 0.1.5-rc.1 in `web-full-flow.e2e.ts`: across that reload the graph
    // is byte-identical, same `rev`, with the package's host half live the
    // whole time. Offering a reload here promises what it cannot deliver,
    // which is the same defect as the `live` claim it replaced — one step
    // cheaper instead of two.
    expect(activationOf({ hostLive: true, clientLive: false, hasClientHalf: true })).toBe('restart')
  })
})
