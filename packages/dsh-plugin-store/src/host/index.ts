/** StoreGateway: the Host half of dsh-plugin-store (§5.1). */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { loadCatalog, type LoadCatalogOptions } from './catalog.ts'
import type { CatalogSnapshot } from './catalog.ts'
import type { CatalogEntry, DeniedEntry } from './types.ts'
import { validateInstall, type InstallArgs, type InstallRejectionCode } from './install.ts'
import { startInstall, type InstallStatus } from './executor.ts'

// Re-exported so the boundary type is reachable from the package's public
// ./types subpath; the typert generator refuses remote parameter types it
// cannot import from there.
export type { InstallArgs } from './install.ts'

/** Test-only injection points; production callers pass nothing. */
export interface StoreGatewayOptions {
  catalogUrl?: string
  cacheDir?: string
  loadCatalog?: (options: LoadCatalogOptions) => ReturnType<typeof loadCatalog>
  /** The profile dsh installs into; discovery lands in Task 7. */
  profile?: string
  dshBin?: string
}

/** `store/install` result (§7.3): rejections are typed wire values with an
 * author-readable `detail`, not thrown RPC errors. */
export type StoreInstallResult =
  | { ok: true; installId: string }
  | { ok: false; code: InstallRejectionCode; detail: string }

export interface StoreInstallStatusResult extends InstallStatus { found: boolean }

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
  /** The profile dsh installs into; discovery (Task 7) fills the default. */
  private readonly profile: string
  /** The install gate runs against the last loaded snapshot, never a fresh
   * fetch per request (§7.2: the Host's cached snapshot is the truth). */
  private lastSnapshot: CatalogSnapshot | null = null
  /** In-flight installs; an installStatus poll finds one here or reports not found. */
  private readonly installs = new Map<string, ReturnType<typeof startInstall>>()

  constructor(ctx: Context, options: StoreGatewayOptions = {}) {
    super(ctx, 'store')
    this.options = options
    this.profile = options.profile ?? ''
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
    this.lastSnapshot = snapshot
    return {
      schemaVersion: snapshot.schemaVersion,
      builtAt: snapshot.builtAt,
      stale,
      plugins: snapshot.entries,
      denied: snapshot.denied,
    }
  }

  /**
   * Install one cataloged version into the profile (§7.2). The four rejection
   * paths run against this Host's snapshot before anything is spawned; only a
   * passing request reaches the executor.
   */
  @Remote('install')
  async install(args: InstallArgs): Promise<StoreInstallResult> {
    if (this.lastSnapshot === null) {
      const { catalogUrl, cacheDir } = this.rowConfig()
      const load = this.options.loadCatalog ?? loadCatalog
      const { snapshot } = await load({ baseUrl: catalogUrl, cacheDir })
      this.lastSnapshot = snapshot
    }
    const verdict = validateInstall(this.lastSnapshot, args)
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail }
    const running = startInstall({ profile: this.profile, spec: `${args.name}@${args.version}`, dshBin: this.options.dshBin })
    this.installs.set(running.installId, running)
    void running.finished.then(() => this.installs.delete(running.installId))
    return { ok: true, installId: running.installId }
  }

  /** Poll one install's progress (§7.2); unknown ids report `found: false`. */
  @Remote('installStatus')
  installStatus(args: { installId: string }): StoreInstallStatusResult {
    const running = this.installs.get(args.installId)
    if (running === undefined) return { found: false, state: 'failed', log: [], detail: `unknown installId: ${args.installId}` }
    return { found: true, ...running.status() }
  }
}

export default StoreGateway
