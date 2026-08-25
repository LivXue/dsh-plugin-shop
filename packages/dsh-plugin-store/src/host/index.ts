/** StoreGateway: the Host half of dsh-plugin-store (§5.1). */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { loadCatalog, type LoadCatalogOptions } from './catalog.ts'
import type { CatalogEntry, DeniedEntry } from './types.ts'

/** Test-only injection points; production callers pass nothing. */
export interface StoreGatewayOptions {
  catalogUrl?: string
  cacheDir?: string
  loadCatalog?: (options: LoadCatalogOptions) => ReturnType<typeof loadCatalog>
}

/** One row of the row config the bundle patch (§cordis.patch.yml) supplies. */
interface StoreRowConfig {
  catalogUrl?: unknown
  cacheDir?: unknown
}

/** `store/catalog` result (§7.3), plus the denied list for the install gate's UI. */
export interface StoreCatalogResult {
  schemaVersion: number
  builtAt: string
  stale: boolean
  plugins: CatalogEntry[]
  denied: DeniedEntry[]
}

/** Remote-only service exposing the five store methods of §7.3.
 *
 * @typert service store */
export class StoreGateway extends TypertRemoteService {
  private readonly options: StoreGatewayOptions

  constructor(ctx: Context, options: StoreGatewayOptions = {}) {
    super(ctx, 'store')
    this.options = options
  }

  private rowConfig(): { catalogUrl: string; cacheDir: string } {
    if (this.options.catalogUrl !== undefined && this.options.cacheDir !== undefined) {
      return { catalogUrl: this.options.catalogUrl, cacheDir: this.options.cacheDir }
    }
    // Structural cast instead of the cordis-plugin-loader Context augmentation:
    // the store must not depend on that package, whose types never reach this
    // package's typecheck. The loader's own type of `config` is `unknown`,
    // so the row's shape is re-validated below before it is trusted.
    const loader = (this.ctx as {
      loader?: { entries(): Array<{ options: { name?: string; config?: unknown } }> }
    }).loader
    const entry = loader?.entries().find(entry => entry.options.name === 'dsh-plugin-store')
    const config = entry?.options.config as StoreRowConfig | undefined
    const catalogUrl = config?.catalogUrl
    const cacheDir = config?.cacheDir
    if (typeof catalogUrl !== 'string' || typeof cacheDir !== 'string') {
      throw new Error('dsh-plugin-store: the store row is missing catalogUrl or cacheDir config')
    }
    return { catalogUrl, cacheDir }
  }

  /** Browse the catalog (§7.3): cached snapshot, refreshed on demand. */
  @Remote('catalog')
  async catalog(args?: { refresh?: boolean }): Promise<StoreCatalogResult> {
    const { catalogUrl, cacheDir } = this.rowConfig()
    const load = this.options.loadCatalog ?? loadCatalog
    const { snapshot, stale } = await load({ baseUrl: catalogUrl, cacheDir, refresh: args?.refresh ?? false })
    return {
      schemaVersion: snapshot.schemaVersion,
      builtAt: snapshot.builtAt,
      stale,
      plugins: snapshot.entries,
      denied: snapshot.denied,
    }
  }
}

export default StoreGateway
