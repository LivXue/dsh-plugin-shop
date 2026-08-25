import { describe, expect, it } from 'vitest'
import StoreGateway from '../../src/host/index.ts'

describe('StoreGateway', () => {
  it('registers the store namespace as a Typert remote service', () => {
    const ctx = { get: () => undefined, reflect: { provide: () => {} } } as never
    const gateway = new StoreGateway(ctx)
    expect(gateway.name).toBe('store')
    expect(gateway.typertRemote.serviceKey).toBe('store')
    expect(gateway.typertRemote.namespace).toBe('store')
  })
})
