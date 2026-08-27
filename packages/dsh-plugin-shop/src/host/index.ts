/** ShopGateway: the Host half of dsh-plugin-shop (§5.1). */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { lt, minVersion, valid } from 'semver'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ownVersion } from '../own-version.ts'
import { loadCatalog, type LoadCatalogOptions } from './catalog.ts'
import type { CatalogSnapshot } from './catalog.ts'
import type { CatalogEntry, DeniedEntry } from './types.ts'
import { validateInstall, type InstallArgs, type InstallRejectionCode } from './install.ts'
import { startInstall, startUninstall, type InstallStatus } from './executor.ts'
import { startRestart, type RestartOutcome } from './restart.ts'
import { fetchLatestVersion } from './self-update.ts'
import { discoverProfile, setUserLayerRow } from './profile.ts'

// Re-exported so the boundary type is reachable from the package's public
// ./types subpath; the typert generator refuses remote parameter types it
// cannot import from there.
export type { InstallArgs, InstallRejectionCode } from './install.ts'
// The catalog entry shape reaches the client half through this same boundary.
export type { CatalogEntry } from './types.ts'

/** One Loader inventory entry, structurally — the shop never depends on
 * cordis-plugin-loader, whose types do not reach this package's typecheck. */
export interface InventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
}

/** Test-only injection points; production callers pass nothing. */
export interface ShopGatewayOptions {
  catalogUrl?: string
  cacheDir?: string
  loadCatalog?: (options: LoadCatalogOptions) => ReturnType<typeof loadCatalog>
  /** The profile dsh installs into; discovered from this module's own
   * location when omitted. */
  profile?: string
  /** The profile directory the user layer lives in; discovered when omitted. */
  profileDir?: string
  /** The Loader plugin inventory; read from `ctx` when omitted. */
  inventory?: { list(): InventoryEntry[] }
  dshBin?: string
  /** The dsh argv this process was launched with, for `shop/restart`;
   * defaults to the real `process.argv` minus node and the script path. */
  restartArgv?: string[]
  /** Test-only injection: the exit the restart calls after the response is
   * delivered. Production uses `process.exit`. */
  exit?: (code?: number) => void
  /** The pid the restart helper waits on before exec'ing the new dsh;
   * defaults to this process. Tests point it at a dead pid so the fixture
   * runs immediately instead of waiting for the vitest worker to exit. */
  restartParentPid?: number
  /** Test-only injection: the shop's latest-version lookup; production
   * fetches the npm packument. */
  fetchLatestVersion?: () => Promise<string | null>
  /** How long the gateway waits after a successful restart response before
   * exiting the old process; test-only shortening, production uses 2s. */
  restartExitDelayMs?: number
}

/** `shop/installStart` result (§7.3): rejections are typed wire values with an
 * author-readable `detail`, not thrown RPC errors. */
export type ShopInstallResult =
  | { ok: true; installId: string }
  | { ok: false; code: InstallRejectionCode; detail: string }

export interface ShopInstallStatusResult extends InstallStatus { found: boolean }

/** `shop/setEnabled` result (§7.3): an unknown name is a typed wire value,
 * not a thrown RPC error. */
export interface ShopSetEnabledResult { ok: boolean; detail?: string }

/** `shop/uninstallStart` result (§7.3): a name outside the catalog or not
 * installed is a typed wire value with an author-readable `detail`, not a
 * thrown RPC error. */
export type ShopUninstallResult =
  | { ok: true; installId: string }
  | { ok: false; detail: string }

/** `shop/restart` result (§7.3): the restarted server's URL, or a typed
 * failure — on failure the old process is still serving. */
export type ShopRestartResult = RestartOutcome

/** `shop/version` result (§7.3): the RUNNING shop version (from the shipped
 * package.json, not the manifest's range), the npm latest when the check
 * could answer (`null` = no answer — advisory, never an error), and the
 * comparison verdict. */
export interface ShopVersionResult { installed: string; latest: string | null; outdated: boolean }

/** `shop/updateStart` result (§7.3): the self-update spawn, or a typed
 * refusal (a version that is not plain semver). */
export type ShopUpdateResult =
  | { ok: true; installId: string }
  | { ok: false; detail: string }

/** `shop/installed` entry (§7.3): one installed catalog plugin. `installed`
 * is the profile manifest's dependency spec verbatim (a range, a tag, or
 * `workspace:*`); `outdated` is the Host's verdict that the installed version
 * sits behind the catalog's — the client never does version math. */
export interface ShopInstalledEntry { name: string; installed: string; latest: string; outdated: boolean }

/** One row of the row config the bundle patch (§cordis.patch.yml) supplies. */
interface ShopRowConfig {
  catalogUrl?: unknown
  cacheDir?: unknown
}

/** `shop/catalog` result (§7.3), plus the denied list for the install gate's UI. */
export interface ShopCatalogResult {
  schemaVersion: number
  builtAt: string
  stale: boolean
  plugins: CatalogEntry[]
  denied: DeniedEntry[]
  /** GitHub star counts by package name; {} when the pointer names no sidecar
   * or the sidecar could not be fetched/verified (§5). */
  stars: Record<string, number>
}

/** Remote-only service exposing the shop Remote methods of §7.3.
 *
 * @typert service shop */
export class ShopGateway extends TypertRemoteService {
  private readonly options: ShopGatewayOptions
  /** The profile dsh installs into; discovered from this module's own
   * location when the caller does not supply one. */
  private readonly profile: string
  private readonly profileDir?: string
  private readonly inventory?: ShopGatewayOptions['inventory']
  private readonly dshBin: string
  /** The argv `shop/restart` re-spawns: the real process argv minus node and
   * the CLI script path, or a test-provided substitute. */
  private readonly restartArgv: string[]
  /** The exit the restart calls once the response is out; `process.exit` in
   * production, a spy in tests. */
  private readonly exit: (code?: number) => void
  private readonly restartExitDelayMs: number
  private readonly restartParentPid: number
  private readonly latestVersion: () => Promise<string | null>
  /** The install gate runs against the last loaded snapshot, never a fresh
   * fetch per request (§7.2: the Host's cached snapshot is the truth). */
  /** Finished install records retained, so a poll sees the true terminal
   * state (§8: done / needsRestart / failure detail). Oldest evicted on add. */
  private static readonly MAX_FINISHED_INSTALLS = 32

  /** How long the gateway waits after a successful restart response before
   * exiting the old process — the browser must receive the URL first. */
  private static readonly RESTART_EXIT_DELAY_MS = 2000

  /** The install gate runs against the last loaded snapshot, never a fresh
   * fetch per request (§7.2: the Host's cached snapshot is the truth). */
  private lastSnapshot: CatalogSnapshot | null = null
  /** Install records, running and finished; a poll finds one here or reports not found. */
  private readonly installs = new Map<string, ReturnType<typeof startInstall>>()
  /** Every install id in insertion order, oldest first; finished-record eviction walks this from the front. */
  private readonly installOrder: string[] = []

  constructor(ctx: Context, options: ShopGatewayOptions = {}) {
    super(ctx, 'shop')
    this.options = options
    this.profile = options.profile ?? discoverProfile(fileURLToPath(import.meta.url), this.bootBaseDir()).name
    this.profileDir = options.profileDir
    this.inventory = options.inventory
    this.dshBin = options.dshBin ?? 'dsh'
    this.restartArgv = options.restartArgv ?? process.argv.slice(2)
    this.exit = options.exit ?? ((code?: number) => process.exit(code))
    this.restartExitDelayMs = options.restartExitDelayMs ?? ShopGateway.RESTART_EXIT_DELAY_MS
    this.restartParentPid = options.restartParentPid ?? process.pid
    this.latestVersion = options.fetchLatestVersion ?? (() => fetchLatestVersion())
  }

  /** The boot's Loader root directory (the active profile's `cordis.yml`
   * directory, carried on `ctx.baseUrl`), when present. A `link:` install
   * keeps this package at its source location, so the walk-up from
   * `import.meta.url` finds the repo rather than a profile; `ctx.baseUrl`
   * is the boot-provided authoritative answer. */
  private bootBaseDir(): string | undefined {
    const baseUrl = (this.ctx as { baseUrl?: unknown }).baseUrl
    if (typeof baseUrl !== 'string' || !baseUrl.startsWith('file:')) return undefined
    try {
      return fileURLToPath(baseUrl)
    } catch {
      // A malformed baseUrl is not a profile answer; the walk-up decides.
    }
    return undefined
  }

  /** The profile directory the user layer lives in — the discovered default
   * stays lazy so `setEnabled` works in tests via the `profileDir` option
   * without requiring a real profile above this module. */
  private profileDirResolved(): string {
    if (this.profileDir !== undefined) return this.profileDir
    return discoverProfile(fileURLToPath(import.meta.url), this.bootBaseDir()).dir
  }

  private listInventory(): InventoryEntry[] {
    if (this.inventory !== undefined) return this.inventory.list()
    const inventory = (this.ctx as { get?: (name: string) => unknown }).get?.('pluginInventory') as
      | { list(): InventoryEntry[] }
      | undefined
    if (inventory === undefined) throw new Error('dsh-plugin-shop: pluginInventory service is not mounted')
    return inventory.list()
  }

  /** Enable or disable one installed plugin, hot (§8): a disable writes the
   * row to the user layer, an enable drops it again so the bundle default
   * rules — the CLI's watchUserPatches applies either through HMR. */
  @Remote('setEnabled')
  setEnabled(args: { name: string; enabled: boolean }): ShopSetEnabledResult {
    const entry = this.listInventory().find(entry => entry.moduleName === args.name)
    if (entry === undefined) return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not installed` }
    setUserLayerRow({ profileDir: this.profileDirResolved(), row: { id: entry.entryId, disabled: !args.enabled } })
    return { ok: true }
  }

  private rowConfig(): { catalogUrl: string; cacheDir: string } {
    if (this.options.catalogUrl !== undefined && this.options.cacheDir !== undefined) {
      return { catalogUrl: this.options.catalogUrl, cacheDir: this.options.cacheDir }
    }
    // Structural cast instead of the cordis-plugin-loader Context augmentation:
    // the shop must not depend on that package. The augmentation reaches
    // this package's typecheck through dsh-app-boot's include types, so the
    // cast goes through `unknown`. The loader's own type of `config` is
    // `unknown`, so the row's shape is re-validated below before it is trusted.
    const loader = (this.ctx as unknown as {
      loader?: { entries(): Array<{ options: { name?: string; config?: unknown } }> }
    }).loader
    const entry = loader?.entries().find(entry => entry.options.name === 'dsh-plugin-shop')
    const config = entry?.options.config as ShopRowConfig | undefined
    const catalogUrl = config?.catalogUrl
    const cacheDir = config?.cacheDir
    if (typeof catalogUrl !== 'string' || typeof cacheDir !== 'string') {
      throw new Error('dsh-plugin-shop: the shop row is missing catalogUrl or cacheDir config')
    }
    return { catalogUrl, cacheDir }
  }

  /** Browse the catalog (§7.3): cached snapshot, refreshed on demand. */
  @Remote('catalog')
  async catalog(args?: { refresh?: boolean }): Promise<ShopCatalogResult> {
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
      stars: snapshot.stars,
    }
  }

  /**
   * Install one cataloged version into the profile (§7.2). The four rejection
   * paths run against this Host's snapshot before anything is spawned; only a
   * passing request reaches the executor.
   */
  // The wire method is `installStart`, never `install`: the client api's
  // RemoteNamespaceService owns a method named `install` (its internal mount
  // primitive), and mounting a namespace method with that name throws
  // "conflicts with its namespace service" — the web full-flow e2e exposed
  // this on the real composition (§7.3 amendment, 2026-08-25).
  @Remote('installStart')
  async install(args: InstallArgs): Promise<ShopInstallResult> {
    if (this.lastSnapshot === null) {
      const { catalogUrl, cacheDir } = this.rowConfig()
      const load = this.options.loadCatalog ?? loadCatalog
      const { snapshot } = await load({ baseUrl: catalogUrl, cacheDir })
      this.lastSnapshot = snapshot
    }
    const verdict = validateInstall(this.lastSnapshot, args)
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail }
    const running = startInstall({
      profile: this.profile,
      spec: `${args.name}@${args.version}`,
      dshBin: this.dshBin,
      // §7.2 step 6: exit 0 must be confirmed against the profile manifest —
      // a bundle that did not land is a stale catalog, not a done install.
      expectedName: args.name,
    })
    this.installs.set(running.installId, running)
    this.installOrder.push(running.installId)
    this.evictFinishedInstalls()
    return { ok: true, installId: running.installId }
  }

  /** Bound retained finished records at MAX_FINISHED_INSTALLS, evicting the
   * oldest finished ones (insertion order, oldest first). Running records
   * are never evicted; an id absent from the map reports `found: false`. */
  private evictFinishedInstalls(): void {
    const finishedIds: string[] = []
    for (const id of this.installOrder) {
      const record = this.installs.get(id)
      if (record !== undefined && record.status().state !== 'running') finishedIds.push(id)
    }
    const excess = Math.max(0, finishedIds.length - ShopGateway.MAX_FINISHED_INSTALLS)
    for (const id of finishedIds.slice(0, excess)) this.installs.delete(id)
  }

  /** Poll one install's progress (§7.2); unknown ids report `found: false`. */
  @Remote('installStatus')
  installStatus(args: { installId: string }): ShopInstallStatusResult {
    const running = this.installs.get(args.installId)
    if (running === undefined) return { found: false, state: 'failed', log: [], detail: `unknown installId: ${args.installId}` }
    return { found: true, ...running.status() }
  }

  /** Installed catalog plugins (§7.3): every entry of the snapshot the profile
   * manifest declares as a dependency, with the Host's `outdated` verdict
   * attached. The tab's shelf cards and its installed section both derive
   * from this one list. */
  @Remote('installed')
  async installed(): Promise<ShopInstalledEntry[]> {
    if (this.lastSnapshot === null) {
      const { catalogUrl, cacheDir } = this.rowConfig()
      const load = this.options.loadCatalog ?? loadCatalog
      const { snapshot } = await load({ baseUrl: catalogUrl, cacheDir })
      this.lastSnapshot = snapshot
    }
    const manifest = readProfileManifest('dsh-plugin-shop', this.profileDirResolved())
    const dependencies = manifest.dependencies ?? {}
    const installed: ShopInstalledEntry[] = []
    for (const entry of this.lastSnapshot.entries) {
      const spec = dependencies[entry.name]
      if (spec === undefined) continue
      installed.push({ name: entry.name, installed: spec, latest: entry.version, outdated: this.isBehind(spec, entry.version) })
    }
    return installed
  }

  /** Whether an installed dependency spec sits behind the catalog's version.
   * A spec identical to the catalog version is current by definition; a
   * pnpm-written non-semver spec like `workspace:*` is not reportable and
   * reads as current rather than killing the RPC. */
  private isBehind(spec: string, latest: string): boolean {
    if (spec === latest) return false
    let floor: string | null
    try {
      floor = minVersion(spec)?.version ?? null
    } catch {
      floor = null
    }
    return floor !== null && lt(floor, latest)
  }

  /** Uninstall one installed catalog plugin from the profile (§7.3 follow-up
   * amendment). Removing revokes privilege rather than granting it, so there
   * is no acknowledgement gate. The name must be a catalog entry the profile
   * manifest declares as a dependency — the RPC cannot remove profile
   * dependencies the shop does not manage (the base bundle, the shop
   * itself). The same install records/polling serve the client. */
  @Remote('uninstallStart')
  async uninstall(args: { name: string }): Promise<ShopUninstallResult> {
    if (this.lastSnapshot === null) {
      const { catalogUrl, cacheDir } = this.rowConfig()
      const load = this.options.loadCatalog ?? loadCatalog
      const { snapshot } = await load({ baseUrl: catalogUrl, cacheDir })
      this.lastSnapshot = snapshot
    }
    if (!this.lastSnapshot.entries.some(entry => entry.name === args.name)) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
    }
    const manifest = readProfileManifest('dsh-plugin-shop', this.profileDirResolved())
    const dependencies = manifest.dependencies ?? {}
    if (dependencies[args.name] === undefined) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not installed` }
    }
    const running = startUninstall({
      profile: this.profile,
      name: args.name,
      dshBin: this.dshBin,
      expectedName: args.name,
    })
    this.installs.set(running.installId, running)
    this.installOrder.push(running.installId)
    this.evictFinishedInstalls()
    return { ok: true, installId: running.installId }
  }

  /** Restart the dsh process the shop runs in (§8 amendment, 2026-08-27):
   * commit a two-phase handoff — a detached helper waits for this pid to
   * exit, then re-runs this process's own command line — and exit once the
   * response is out. The browser monitors the origin and refreshes when the
   * new server answers. Refusals are issued before anything is torn down. */
  @Remote('restart')
  async restart(): Promise<ShopRestartResult> {
    // Under --port 0 the OS hands the NEW process a fresh port the browser
    // cannot know; a restart would strand the client. Refuse before
    // anything is torn down.
    const portIndex = this.restartArgv.indexOf('--port')
    if (portIndex !== -1 && this.restartArgv[portIndex + 1] === '0') {
      return { ok: false, detail: 'dsh-plugin-shop: restart is not supported when dsh was launched with --port 0; restart dsh manually' }
    }
    try {
      const { cacheDir } = this.rowConfig()
      startRestart({
        dshBin: this.dshBin,
        argv: this.restartArgv,
        parentPid: this.restartParentPid,
        logFile: join(cacheDir, 'restart.log'),
        env: process.env,
      })
    } catch (error) {
      // A refused restart must not tear anything down; the detail names the
      // config or log problem in the shop's own words.
      return { ok: false, detail: `dsh-plugin-shop: restart could not be started: ${(error as Error).message}` }
    }
    // The response must reach the browser before this process exits; the
    // helper holds the child back until this pid is gone, so the port is
    // free when the new dsh binds.
    setTimeout(() => this.exit(0), this.restartExitDelayMs)
    return { ok: true }
  }

  /** The shop's own version and whether npm has a newer one (§7.3). The
   * check is advisory: a registry that cannot answer leaves `latest` null
   * and the client shows the version alone. `installed` is the RUNNING
   * version (own-version.ts), not the manifest's range spec. */
  @Remote('version')
  async version(): Promise<ShopVersionResult> {
    const installed = ownVersion()
    const latest = await this.latestVersion()
    return {
      installed,
      latest,
      outdated: latest !== null && lt(installed, latest),
    }
  }

  /** Update the shop itself to a published version (§7.3): the explicit pin
   * is the only install form that bypasses pnpm's release cooldown. The
   * version is re-validated as plain semver at the boundary — the spec
   * `dsh-plugin-shop@<version>` is built here, never from the wire. */
  @Remote('updateStart')
  async updateStart(args: { version: string }): Promise<ShopUpdateResult> {
    if (valid(args.version) === null) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.version} is not a valid version` }
    }
    const running = startInstall({
      profile: this.profile,
      spec: `dsh-plugin-shop@${args.version}`,
      dshBin: this.dshBin,
      expectedName: 'dsh-plugin-shop',
    })
    this.installs.set(running.installId, running)
    this.installOrder.push(running.installId)
    this.evictFinishedInstalls()
    return { ok: true, installId: running.installId }
  }
}

export default ShopGateway
