/** ShopGateway: the Host half of dsh-plugin-shop (§5.1). */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { lt, minVersion, valid } from 'semver'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ownVersion } from '../own-version.ts'
import { loadCatalog, type LoadCatalogOptions } from './catalog.ts'
import type { CatalogSnapshot } from './catalog.ts'
import type { CatalogEntry, DeniedEntry } from './types.ts'
import { validateInstall, type InstallArgs, type InstallRejectionCode } from './install.ts'
import { startInstall, startUninstall, type InstallStatus } from './executor.ts'
import { cleanHotDir, hotMount, hotUnmount } from './hot.ts'
import { startRestart, type RestartOutcome } from './restart.ts'
import { fetchLatestVersion } from './self-update.ts'
import { detectSupervisor } from './supervisor.ts'
import { readRepoPins, writeRepoPins, type RepoPinFs } from './repo-pins.ts'
import { discoverProfile, ownedEntryIds, ownsEntryId, setUserLayerRow, setUserLayerRows } from './profile.ts'

// Re-exported so the boundary type is reachable from the package's public
// ./types subpath; the typert generator refuses remote parameter types it
// cannot import from there.
export type { InstallArgs, InstallRejectionCode } from './install.ts'
export type { HotRestartReason } from './hot.ts'
// The catalog entry shape reaches the client half through this same boundary.
export type { CatalogEntry } from './types.ts'

/** One Loader inventory entry, structurally — the shop never depends on
 * cordis-plugin-loader, whose types do not reach this package's typecheck. */
export interface InventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
}

/** One boot-layer Loader entry, structurally — the surface `liveDisableIds`
 * consumes. `fiber` is the entry's live activation (present while the plugin
 * is up); `update` flips its options. */
export interface LoaderEntryLike {
  id?: string
  options: { name?: string }
  fiber?: unknown
  update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void>
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
  /** The Loader plugin inventory; read from `ctx` when omitted. The REAL
   * host-side service returns the bare snapshot OBJECT `{ entries: [...] }`,
   * not a bare array and not a wire envelope (hub-borrowings B assumed the
   * array and the toggle crashed on the real shape — 0.5.2 fix; the envelope
   * exists only on the remote's client side). Both shapes normalize in
   * `listInventory()`. */
  inventory?: { list(): Promise<{ entries: InventoryEntry[] } | InventoryEntry[]> }
  /** Test-only injection: the hot-mount functions; production uses the real
   * hotMount/hotUnmount. */
  hot?: { mount: typeof hotMount; unmount: typeof hotUnmount }
  /** Test-only injection: the Loader's boot-layer entries; production reads
   * them from `ctx.loader`. */
  loaderEntries?: () => Array<LoaderEntryLike>
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
  /** Whether `git` is on PATH — a github entry cannot install without it;
   * test-only injection, production probes the real binary. */
  hasGit?: () => boolean
  /** Test-only injection: the pins file's filesystem; production uses node:fs. */
  pinFs?: RepoPinFs
  /** Test-only injection: the explicit `allowRestart` override; production
   * reads the loader row's `config.allowRestart`. */
  allowRestart?: boolean
  /** The environment `detectSupervisor` reads; production uses process.env. */
  env?: NodeJS.ProcessEnv
  /** The pid `detectSupervisor` inspects; production uses process.ppid —
   * the PARENT pid (a systemd unit's main process has ppid 1). */
  ppid?: number
  /** Test-only injection: how the release-tarball integrity check fetches
   * the release asset; production uses global fetch. */
  fetchTarball?: (url: string) => Promise<Response>
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
export interface ShopVersionResult {
  installed: string
  latest: string | null
  outdated: boolean
  /** Whether `shop/restart` is usable: false when a supervisor owns this
   * process and no `allowRestart` override is set. The client hides the
   * restart offer on false but keeps the pending-change notice. */
  restartSupported: boolean
}

/** `shop/updateStart` result (§7.3): the self-update spawn, or a typed
 * refusal (a version that is not plain semver). */
export type ShopUpdateResult =
  | { ok: true; installId: string }
  | { ok: false; detail: string }

/** `shop/installed` entry (§7.3): one installed catalog plugin. `installed`
 * is the profile manifest's dependency spec verbatim (a range, a tag, or
 * `workspace:*`) — for a github entry it is the pinned commit the shop
 * installed, falling back to the `github:owner/slug` spec when the pin is
 * unknown; `outdated` is the Host's verdict that the installed version sits
 * behind the catalog's — the client never does version math. */
export interface ShopInstalledEntry { name: string; installed: string; latest: string; outdated: boolean; enabled: boolean }

/** One row of the row config the bundle patch (§cordis.patch.yml) supplies. */
interface ShopRowConfig {
  catalogUrl?: unknown
  cacheDir?: unknown
  allowRestart?: unknown
}

/** How many bytes a release tarball may be at the integrity check. The
 * registry already refuses to publish a tarball over 32 MiB, so 64 MiB is
 * headroom, not a gate of its own. */
export const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/**
 * Fetch a release tarball and verify its sha256 against the catalog record
 * (market borrowings §3.1). Returns a rejection detail, or null when the
 * bytes match. The read streams through the byte cap, so an oversized or
 * hostile body is refused without ever being buffered. Every failure — fetch
 * throw, non-2xx, unreadable body, over-cap, hash mismatch — carries the same
 * `tarball-integrity` code with a detail naming what happened, so the plugin
 * author can read the cause.
 */
export async function verifyTarballSha256(
  fetchTarball: (url: string) => Promise<Response>,
  url: string,
  recordedSha256: string,
  maxBytes: number = MAX_TARBALL_BYTES,
): Promise<string | null> {
  let response: Response
  try {
    response = await fetchTarball(url)
  } catch (error) {
    return `dsh-plugin-shop: the release tarball could not be fetched (network failure: ${(error as Error).message}); refusing to install`
  }
  if (!response.ok) {
    return `dsh-plugin-shop: the release tarball could not be fetched (HTTP ${response.status}); refusing to install`
  }
  if (response.body === null) {
    return 'dsh-plugin-shop: the release tarball has no readable body; refusing to install'
  }
  const hash = createHash('sha256')
  let bytes = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        try {
          // Close the connection the cap was protecting; the bytes beyond
          // the cap are never read.
          await reader.cancel()
        } catch {
          // The stream already closed or errored; the cap verdict stands.
        }
        return `dsh-plugin-shop: the release tarball exceeds the size cap (${maxBytes} bytes); refusing to install`
      }
      hash.update(value)
    }
  } catch (error) {
    return `dsh-plugin-shop: the release tarball download failed (${(error as Error).message}); refusing to install`
  }
  if (hash.digest('hex') !== recordedSha256) {
    return 'dsh-plugin-shop: the release tarball failed sha256 verification against the catalog record; refusing to install'
  }
  return null
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
  private readonly hot?: ShopGatewayOptions['hot']
  private readonly loaderEntriesInjected?: ShopGatewayOptions['loaderEntries']
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
  private readonly hasGit: () => boolean
  private readonly pinFs: RepoPinFs
  private readonly allowRestart?: boolean
  private readonly env: NodeJS.ProcessEnv
  /** The parent pid `detectSupervisor` inspects; production defaults to
   * process.ppid (a systemd unit's main process has ppid 1). */
  private readonly ppid: number
  /** The release-tarball fetch for the install-time integrity check; global
   * fetch in production, a fixture response in tests. */
  private readonly fetchTarball: (url: string) => Promise<Response>
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
    this.hot = options.hot
    this.loaderEntriesInjected = options.loaderEntries
    this.dshBin = options.dshBin ?? 'dsh'
    this.restartArgv = options.restartArgv ?? process.argv.slice(2)
    this.exit = options.exit ?? ((code?: number) => process.exit(code))
    this.restartExitDelayMs = options.restartExitDelayMs ?? ShopGateway.RESTART_EXIT_DELAY_MS
    this.restartParentPid = options.restartParentPid ?? process.pid
    this.latestVersion = options.fetchLatestVersion ?? (() => fetchLatestVersion())
    this.hasGit = options.hasGit ?? (() => spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0)
    this.pinFs = options.pinFs ?? {
      exists: path => existsSync(path),
      read: path => readFileSync(path, 'utf8'),
      write: (path, data) => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, data)
      },
    }
    this.allowRestart = options.allowRestart
    this.env = options.env ?? process.env
    this.ppid = options.ppid ?? process.ppid
    this.fetchTarball = options.fetchTarball ?? ((url: string) => fetch(url))
    try {
      // The ephemeral `hot-<n>.yml` inputs from a previous session must
      // never survive a boot: a crashed session's stale inputs would mount
      // against this session's composition.
      cleanHotDir(this.profileDirResolved())
    } catch {
      // Swallows the profile-dir discovery failure: a profile dir that does
      // not resolve yet (the stub-ctx test constructions) has nothing to
      // wipe, and failing a boot over a missing wipe dir would be the worse
      // failure.
    }
  }

  /** The pins file lives in the shop's own cache, next to the catalog cache. */
  private pinsPath(): string {
    return join(this.rowConfig().cacheDir, 'github-pins.json')
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

  /** The inventory, through the wire remote: an envelope `{ ok, value }` or
   * `{ ok: false, error }`. Each row is re-validated before trust (same
   * discipline as the rowConfig cast). */
  private async listInventory(): Promise<InventoryEntry[]> {
    const remote = this.inventory ?? (this.ctx as { get?: (name: string) => unknown }).get?.('pluginInventory') as
      | { list(): Promise<unknown> }
      | undefined
    if (remote === undefined) throw new Error('dsh-plugin-shop: pluginInventory service is not mounted')
    const result = await remote.list()
    // The host-side service returns the BARE snapshot `{ entries: [...] }` —
    // no wire envelope (that exists only on the remote's client side).
    const list = Array.isArray(result) ? result : (result as { entries?: unknown }).entries
    if (!Array.isArray(list)) return []
    const entries: InventoryEntry[] = []
    for (const item of list) {
      if (item !== null && typeof item === 'object'
        && typeof (item as { entryId?: unknown }).entryId === 'string'
        && typeof (item as { moduleName?: unknown }).moduleName === 'string'
        && typeof (item as { enabled?: unknown }).enabled === 'boolean') {
        entries.push(item as InventoryEntry)
      }
    }
    return entries
  }

  /** The Loader's boot-layer entries; a harness without the loader answers
   * with an empty list (there is then nothing to live-disable). */
  private loaderEntries(): Array<LoaderEntryLike> {
    if (this.loaderEntriesInjected !== undefined) return this.loaderEntriesInjected()
    const loader = (this.ctx as unknown as { loader?: { entries(): Iterable<LoaderEntryLike> } }).loader
    return loader === undefined ? [] : [...loader.entries()]
  }

  /** Live-disable one boot-layer entry, retrying until its fiber is actually
   * down. A disable can land while the entry's init is still in flight: the
   * options flip but the finishing init brings the fiber up anyway, and a
   * plain re-update no-ops on the empty diff (dsh-market themes.ts:74-93).
   * For an update swap this sequencing is mandatory, not defensive: two live
   * instances of a service-providing plugin would collide at provision. */
  /** The package's owned entry ids, or none when its bundle patch cannot be
   * read. For the paths where a live disable is an optimization and the
   * operation must succeed regardless; `setEnabled` reports the failure
   * instead, because there the patch IS the answer being asked for. */
  private ownedEntryIdsOrNone(packageName: string): string[] {
    try {
      return ownedEntryIds({ profileDir: this.profileDirResolved(), packageName })
    } catch {
      // Unreadable patch: nothing to disable live, so the hot path falls back
      // to restart activation exactly as it does for a package with no rows.
      return []
    }
  }

  private async liveDisableIds(ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return false
    const owned = new Set(ids)
    let found = false
    for (const entry of this.loaderEntries()) {
      // Matched on the entry id, never the module name: a package's entry
      // may mount another package's module entirely (see ownedEntryIds), and
      // the name match silently found nothing for every such package.
      if (entry.id === undefined || !ownsEntryId(owned, entry.id)) continue
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await entry.update({ disabled: true }, false, true)
          found = true
        } catch {
          // A failing update leaves the entry running — best-effort live-disable; the hot path falls back to restart.
          break
        }
        if (entry.fiber === undefined) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    return found
  }

  /** Enable or disable one installed plugin, hot (§8): a disable writes the
   * row to the user layer, an enable drops it again so the bundle default
   * rules — the CLI's watchUserPatches applies either through HMR. The shop's
   * own row and the framework's bundles are never toggleable: disabling the
   * host chain would break HMR itself. */
  @Remote('setEnabled')
  async setEnabled(args: { name: string; enabled: boolean }): Promise<ShopSetEnabledResult> {
    if (args.name === 'dsh-plugin-shop' || args.name.startsWith('@deepseek-ai/')) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is part of the harness chain and cannot be toggled from the shop` }
    }
    const profileDir = this.profileDirResolved()
    // Installed-ness is the profile manifest's dependencies — the same truth
    // `installed()` renders the row from. Reading it from a different source
    // than the list the user clicked is what let the shop show a toggle and
    // then deny the package existed.
    const manifest = readProfileManifest('dsh-plugin-shop', profileDir)
    if ((manifest.dependencies ?? {})[args.name] === undefined) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not installed` }
    }
    // A malformed or unreadable bundle patch must reach the person as a
    // reason, not as a throw: an escaped exception crosses the RPC as a bare
    // transport failure, and the client can only render "please retry" for it
    // — the one rejection on this path with no author-readable detail.
    let owned: string[]
    try {
      owned = ownedEntryIds({ profileDir, packageName: args.name })
    } catch (error) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} has a bundle patch that could not be read: ${String(error)}` }
    }
    if (owned.length === 0) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} contributes no plugin entries, so there is nothing to enable or disable` }
    }
    const ownedSet = new Set(owned)
    // Liveness is read from the LIVE ids, which carry the namespace of every
    // tree composed above the entry (see ownsEntryId).
    const live = (await this.listInventory()).filter(entry => ownsEntryId(ownedSet, entry.entryId))
    if (live.length === 0) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is installed but its entries are not in the running plugin tree; restart dsh to compose them` }
    }
    // The row names the CONFIG id — the id the package's own patch inserted —
    // never the live id it was found by. The user layer is applied by the
    // harness's applyEntryPatches, which looks each row's id up among the ids
    // the bundle patches declared: a row spelled `include:foo` matches nothing
    // there and disables nothing, and a hot `mkt-foo` row would be lost for
    // good, because the restart composes that plugin under its bare id.
    //
    // Every entry the package owns toggles together: a package that inserts a
    // host row and a client row is one plugin to the person clicking.
    setUserLayerRows({ profileDir, rows: owned.map(id => ({ id, disabled: !args.enabled })) })
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

  /** The explicit restart override. Only the row's `config:` sub-object is
   * passed to a plugin — a top-level `allowRestart:` beside `name:` would be
   * silently ignored by the loader (dsh-market README, #227). */
  private allowRestartConfigured(): boolean {
    if (this.allowRestart !== undefined) return this.allowRestart
    const loader = (this.ctx as unknown as {
      loader?: { entries(): Array<{ options: { name?: string; config?: unknown } }> }
    }).loader
    const entry = loader?.entries().find(entry => entry.options.name === 'dsh-plugin-shop')
    const config = entry?.options.config as ShopRowConfig | undefined
    return config?.allowRestart === true
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
   * Install one cataloged version into the profile (§7.2). The rejection
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
    const entry = this.lastSnapshot.entries.find(e => e.name === args.name)
    // validateInstall passed, so the entry exists; the guard keeps the type
    // honest without asserting a state the validator never produces.
    if (entry === undefined) return { ok: false, code: 'not-in-catalog', detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
    // The Host builds the spec itself: npm entries become `name@version`,
    // github entries become `github:owner/slug#commit` (subpackage entries
    // `github:owner/slug#commit&path:<subdir>`) — all from fields the
    // snapshot validated, never from a client-supplied string (§7.2).
    let spec: string
    if (entry.source === 'github' && entry.tarball !== undefined) {
      // Release-rescued entry: the spec is the prebuilt tarball URL the
      // snapshot validated (https github.com releases of this very repo).
      // No git, no commit pin — the recorded tag is the version.
      // The recorded sha256 is enforced before anything spawns: fetch the
      // tarball now and verify its bytes. The install itself re-fetches
      // through pnpm, so an asset swapped between this check and pnpm's
      // fetch is a TOCTOU window — this check catches passive MITM and
      // asset tampering at the check instant, and the catalog chain
      // (pointer sha256 + validateEntryCoherence) already pins the URL
      // itself.
      const integrity = await verifyTarballSha256(
        this.fetchTarball,
        entry.tarball.url,
        entry.tarball.sha256,
      )
      if (integrity !== null) {
        return { ok: false, code: 'tarball-integrity', detail: integrity }
      }
      spec = entry.tarball.url
    } else if (entry.source === 'github') {
      if (entry.repo === undefined || !/^[0-9a-f]{40}$/.test(args.version)) {
        return { ok: false, code: 'version-mismatch', detail: `dsh-plugin-shop: ${args.name} has no installable commit` }
      }
      // pnpm git installs need git on PATH; failing before the spawn turns a
      // cryptic pnpm error into an author-readable rejection.
      if (!this.hasGit()) {
        return { ok: false, code: 'git-missing', detail: 'dsh-plugin-shop: git is not on PATH, which github installs require; install git and retry' }
      }
      spec = `github:${entry.repo}#${args.version}${entry.subdir !== undefined ? `&path:${entry.subdir}` : ''}`
    } else {
      spec = `${args.name}@${args.version}`
    }
    // An update must bring the old instance down before the new one mounts:
    // two live instances of a service-providing plugin would collide at
    // provision (see liveDisableIds). The profile manifest's dependencies are
    // the install's own record — the shop's managed bundle list.
    const manifest = readProfileManifest('dsh-plugin-shop', this.profileDirResolved())
    const isUpdate = (manifest.dependencies ?? {})[args.name] !== undefined
    // Resolve the OLD version's entry ids now: `afterDone` runs once the new
    // tarball has already overwritten the package's bundle patch on disk.
    // Best-effort: the update must not fail because the version being
    // REPLACED has an unreadable patch — no ids just means no live disable,
    // and the hot path already falls back to restart activation.
    const priorEntryIds = isUpdate ? this.ownedEntryIdsOrNone(args.name) : []
    const running = startInstall({
      profile: this.profile,
      spec,
      dshBin: this.dshBin,
      // §7.2 step 6: exit 0 must be confirmed against the profile manifest —
      // a bundle that did not land is a stale catalog, not a done install.
      expectedName: args.name,
      // After the bundle lands, bring it up hot — unless this is an update,
      // whose old instance must be down first (see liveDisableIds). A failed
      // mount falls back to restart activation, never to a silent half-state.
      afterDone: async () => {
        const hot = this.hot ?? { mount: hotMount, unmount: hotUnmount }
        if (isUpdate) {
          // Sequencing: the old instance must be down before the new one
          // mounts (see liveDisableIds). A failure here falls back to restart.
          await this.liveDisableIds(priorEntryIds)
        }
        const result = await hot.mount(
          { plugin: (plugin, config) => (this.ctx as unknown as { plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void } }).plugin(plugin, config) },
          this.profileDirResolved(),
          args.name,
        )
        return result.ok
          ? { needsRestart: false }
          : { needsRestart: true, restartReason: result.reason ?? undefined }
      },
    })
    if (entry.source === 'github') {
      // Remember the pinned commit: the manifest records only
      // `github:owner/slug`, so the pins file is how `installed()` reports
      // outdated honestly. A failed install leaves a pin behind, but the
      // manifest presence gate keeps it invisible.
      const pins = readRepoPins(this.pinFs, this.pinsPath())
      writeRepoPins(this.pinFs, this.pinsPath(), { ...pins, [args.name]: args.version })
    }
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
    const pins = readRepoPins(this.pinFs, this.pinsPath())
    // The inventory knows the real enabled state. When the service is not
    // mounted (an older harness), every entry reads as enabled — the same
    // optimistic assumption the pre-inventory client made.
    const live = new Map<string, boolean>()
    let haveInventory = false
    try {
      for (const entry of await this.listInventory()) live.set(entry.entryId, entry.enabled)
      haveInventory = true
    } catch {
      // pluginInventory is not mounted; `enabled` stays the default below.
    }
    /** A package is enabled when every entry it owns and that is live is
     * enabled. Keyed by entry id, never by module name — the entry a package
     * inserts may mount a different package's module (see ownedEntryIds). */
    const enabledOf = (name: string): boolean => {
      if (!haveInventory) return true
      let owned: string[]
      try {
        owned = ownedEntryIds({ profileDir: this.profileDirResolved(), packageName: name })
      } catch {
        // A malformed bundle patch in ONE installed package must not take the
        // whole installed list down with it; the row reads as enabled, and
        // acting on it returns the read failure as a rejection detail (see
        // setEnabled) rather than a wrong state.
        return true
      }
      const ownedSet = new Set(owned)
      const present = [...live].filter(([entryId]) => ownsEntryId(ownedSet, entryId))
      return present.length === 0 || present.every(([, enabled]) => enabled)
    }
    const installed: ShopInstalledEntry[] = []
    for (const entry of this.lastSnapshot.entries) {
      const spec = dependencies[entry.name]
      if (spec === undefined) continue
      if (entry.source === 'github') {
        // The manifest spec is `github:owner/slug` — no commit. The pin the
        // shop recorded at install time is the commit truth; without one the
        // entry was installed by other means and reads as current rather
        // than killing the RPC over an unknowable comparison.
        const pin = pins[entry.name]
        installed.push({
          name: entry.name,
          installed: pin ?? spec,
          latest: entry.version,
          outdated: pin !== undefined && pin !== entry.version,
          enabled: enabledOf(entry.name),
        })
      } else {
        installed.push({
          name: entry.name,
          installed: spec,
          latest: entry.version,
          outdated: this.isBehind(spec, entry.version),
          enabled: enabledOf(entry.name),
        })
      }
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
    // Resolve the entry ids while the package is still on disk: `afterDone`
    // runs after the uninstall removed it, and its bundle patch with it.
    // Best-effort for the same reason as the update path: a package with an
    // unreadable patch must still be removable.
    const priorEntryIds = this.ownedEntryIdsOrNone(args.name)
    const running = startUninstall({
      profile: this.profile,
      name: args.name,
      dshBin: this.dshBin,
      expectedName: args.name,
      // Bring the plugin down the moment the bundle is gone: a session hot
      // mount first, else the live boot entry. The package is removed from
      // the profile manifest either way — nothing can come back — so the
      // result never demands a restart, even when neither arm found anything
      // (the plugin simply never loaded this session).
      afterDone: async () => {
        const hot = this.hot ?? { mount: hotMount, unmount: hotUnmount }
        const hotRemoved = await hot.unmount(args.name)
        const disabled = hotRemoved || await this.liveDisableIds(priorEntryIds)
        // Privilege is revoked the moment the fiber is gone; the boot
        // composition drops the entry row at next boot.
        return { needsRestart: false }
      },
    })
    // Forget the commit pin alongside the dependency; a stale pin would
    // otherwise outlive the uninstall in the shop's cache.
    const pins = readRepoPins(this.pinFs, this.pinsPath())
    if (pins[args.name] !== undefined) {
      delete pins[args.name]
      writeRepoPins(this.pinFs, this.pinsPath(), pins)
    }
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
    // Under a systemd unit the two-phase handoff kills itself: the main
    // process exiting also kills the unit's cgroup, taking the detached
    // helper with it, and the service never comes back. Refuse before
    // anything is torn down unless the user explicitly allowed it.
    if (detectSupervisor(this.env, { ppid: this.ppid }) === 'systemd' && !this.allowRestartConfigured()) {
      return {
        ok: false,
        detail: 'dsh-plugin-shop: restart is disabled because this process is a systemd service — a restart would kill the takeover helper along with the unit, and the service would not come back. Set allowRestart: true in the shop row config to override.',
      }
    }
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
      restartSupported: detectSupervisor(this.env, { ppid: this.ppid }) === null || this.allowRestartConfigured(),
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
