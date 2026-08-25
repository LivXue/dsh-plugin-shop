import { describe, expect, it } from 'vitest'
import StoreGateway from '../../src/host/index.ts'
import type { CatalogResult } from '../../src/host/catalog.ts'

function stubCtx(): never {
  return { get: () => undefined, reflect: { provide: () => {} } } as never
}

describe('StoreGateway', () => {
  it('registers the store namespace as a Typert remote service', () => {
    const gateway = new StoreGateway(stubCtx())
    expect(gateway.name).toBe('store')
    expect(gateway.typertRemote.serviceKey).toBe('store')
    expect(gateway.typertRemote.namespace).toBe('store')
  })
})

describe('StoreGateway.catalog', () => {
  const snapshot = {
    schemaVersion: 2,
    builtAt: '2026-08-25T00:00:00Z',
    entries: [{ name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' }],
    denied: [{ name: 'dsh-blocked', detail: 'matched the denylist' }],
  }

  it('forwards the refresh flag to the catalog loader and maps the snapshot', async () => {
    const calls: Array<{ refresh?: boolean }> = []
    const gateway = new StoreGateway(stubCtx(), {
      catalogUrl: 'https://store.test/v1/',
      cacheDir: '/cache',
      loadCatalog: async options => { calls.push(options); return { snapshot, stale: false } as CatalogResult },
    })

    const result = await gateway.catalog({ refresh: true })
    expect(calls).toEqual([expect.objectContaining({ baseUrl: 'https://store.test/v1/', cacheDir: '/cache', refresh: true })])
    expect(result).toEqual(expect.objectContaining({ schemaVersion: 2, stale: false }))
    expect(result.plugins[0]?.name).toBe('dsh-hello-plugin')
    expect(result.denied[0]?.detail).toBe('matched the denylist')
  })

  it('reports the stale flag through to the client', async () => {
    const gateway = new StoreGateway(stubCtx(), {
      catalogUrl: 'https://store.test/v1/',
      cacheDir: '/cache',
      loadCatalog: async () => ({ snapshot, stale: true }) as CatalogResult,
    })

    const result = await gateway.catalog({})
    expect(result.stale).toBe(true)
  })

  it('rejects loudly when the store row is missing its config', async () => {
    const gateway = new StoreGateway({
      get: () => undefined,
      reflect: { provide: () => {} },
      loader: { entries: () => [] },
    } as never)

    await expect(gateway.catalog({})).rejects.toThrow(
      'dsh-plugin-store: the store row is missing catalogUrl or cacheDir config',
    )
  })

  it('reads the row config through the Loader when no options are given', async () => {
    const calls: Array<{ baseUrl: string; cacheDir: string; refresh?: boolean }> = []
    const gateway = new StoreGateway(
      {
        get: () => undefined,
        reflect: { provide: () => {} },
        loader: {
          entries: () => [{
            options: {
              name: 'dsh-plugin-store',
              config: { catalogUrl: 'https://row.test/v1/', cacheDir: '/row-cache' },
            },
          }],
        },
      } as never,
      {
        loadCatalog: async options => { calls.push(options); return { snapshot, stale: false } as CatalogResult },
      },
    )

    await gateway.catalog({})
    expect(calls).toEqual([expect.objectContaining({ baseUrl: 'https://row.test/v1/', cacheDir: '/row-cache' })])
  })
})
