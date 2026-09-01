import { describe, expect, it } from 'vitest'
import { incompatibilityMap, nodeResolver } from '../../src/host/peers.ts'

// The real division on the machine where this broke: everything the harness
// ships resolves from the profile anchor; dsh-client-store, which exists only
// on the 0.1.2-alpha line, does not.
const present = new Set(['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-locale', 'react'])
const resolve = (spec: string): boolean => present.has(spec)

describe('incompatibilityMap', () => {
  it('names the peers that did not resolve', () => {
    const map = incompatibilityMap(
      [{ name: 'dsh-timeline', peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react'] }],
      resolve,
    )
    expect(map).toEqual({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
  })

  it('omits an entry whose peers all resolve', () => {
    expect(incompatibilityMap([{ name: 'ok', peers: ['react'] }], resolve)).toEqual({})
  })

  it('omits an entry that declares no peers', () => {
    expect(incompatibilityMap([{ name: 'bare' }], resolve)).toEqual({})
  })

  it('reports a missing peer that is not a harness package', () => {
    // No name pattern: the check is uniform, so a missing `temml` is reported
    // exactly like a missing @deepseek-ai module.
    expect(incompatibilityMap([{ name: 'x', peers: ['temml'] }], resolve)).toEqual({ x: ['temml'] })
  })

  it('resolves each distinct name once however many entries share it', () => {
    let calls = 0
    const counting = (spec: string): boolean => { calls += 1; return present.has(spec) }
    incompatibilityMap(
      [
        { name: 'a', peers: ['@deepseek-ai/cordis', 'react'] },
        { name: 'b', peers: ['@deepseek-ai/cordis', 'react'] },
        { name: 'c', peers: ['@deepseek-ai/cordis'] },
      ],
      counting,
    )
    expect(calls).toBe(2)
  })

  it('treats a throwing resolver as no verdict rather than as missing', () => {
    // Silence, never a false alarm: an unavailable fact must not read as an
    // accusation against a plugin that may be perfectly fine.
    const throwing = (): boolean => { throw new Error('anchor unavailable') }
    expect(incompatibilityMap([{ name: 'x', peers: ['whatever'] }], throwing)).toEqual({})
  })

  it('discards a partial missing list when a later peer throws', () => {
    const flaky = (spec: string): boolean => {
      if (spec === 'react') return false
      throw new Error('anchor unavailable')
    }
    expect(incompatibilityMap([{ name: 'x', peers: ['react', 'whatever'] }], flaky)).toEqual({})
  })

  it('when a shared peer throws, both entries get no verdict and it is resolved once', () => {
    let calls = 0
    const mockResolve = (spec: string): boolean => {
      calls++
      if (spec === 'react') return true
      throw new Error('resolution failed')
    }

    const map = incompatibilityMap(
      [
        { name: 'a', peers: ['react', 'throwing-peer'] },
        { name: 'b', peers: ['throwing-peer', 'react'] },
      ],
      mockResolve,
    )

    expect(map).toEqual({}) // both entries get no verdict
    expect(calls).toBe(2) // 'react' once, 'throwing-peer' once
  })
})

describe('nodeResolver', () => {
  it('resolves a package that exists and refuses one that does not', () => {
    const resolveHere = nodeResolver(import.meta.url)
    expect(resolveHere('vitest')).toBe(true)
    expect(resolveHere('@deepseek-ai/dsh-client-store-that-does-not-exist')).toBe(false)
  })
})
