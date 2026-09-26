/** ShopGateway: the Host half of dsh-plugin-shop (§5.1). */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readProfileManifest } from '@deepseek-ai/dsh-app-boot'
import { lt, minVersion, valid } from 'semver'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { ownPeerRanges, ownVersion } from '../own-version.ts'
import { catalogOrigins, loadCatalog, type LoadCatalogOptions } from './catalog.ts'
import type { CatalogResult, CatalogSnapshot } from './catalog.ts'
import type { CatalogOrigin } from './origin.ts'
import { npmrcRegistry } from './npmrc.ts'
import type { CatalogEntry, DeniedEntry } from './types.ts'
import { validateInstall, type InstallArgs, type InstallRejectionCode } from './install.ts'
import { startInstall, startUninstall, type InstallStatus } from './executor.ts'
import { cleanHotDir, hotMount, hotUnmount, nodeHotFs, type HotFs } from './hot.ts'
import { activationOf, type Activation } from './activation.ts'
import { hasClientHalf } from './client-half.ts'
import { restartCommand, startRestart, type RestartOutcome } from './restart.ts'
import { fetchLatestVersion } from './self-update.ts'
import { detectSupervisor } from './supervisor.ts'
import { readRepoPins, writeRepoPins, type RepoPinFs } from './repo-pins.ts'
import { collidingEntryId, discoverProfile, ownedEntries, ownedEntryIds, ownsEntryId, setUserLayerRows, type OwnedEntry } from './profile.ts'
import { identityKey, installedSpecMatches } from '../shared/identity.ts'
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'
import { createPrefetcher, type Prefetcher } from './prefetch.ts'
import {
  createPeerVersionCheck,
  incompatibilityMap,
  nodeResolver,
  nodeVersionResolver,
  type PeerResolver,
  type PeerVersionResolver,
} from './peers.ts'
import { compatibilityMap, type HarnessVerdict } from './compatibility.ts'
import { readRunningHarness, type RunningHarness } from './harness.ts'

// Re-exported so the boundary type is reachable from the package's public
// ./types subpath; the typert generator refuses remote parameter types it
// cannot import from there.
export type { InstallArgs, InstallRejectionCode } from './install.ts'
export type { HotRestartReason } from './hot.ts'
// Otherwise only reachable through a result field (e.g. ShopSetEnabledResult
// ['activation']), which left `lib/index.d.ts` emitting it as module-local
// and unnamed for a `dsh-plugin-shop/remote` consumer (M-5).
export type { Activation } from './activation.ts'
// The catalog entry shape reaches the client half through this same boundary.
export type { CatalogEntry } from './types.ts'
// So does the compatibility verdict, which lives beside the pure function that
// forms it; the client imports it from here, never from that module.
export type { HarnessVerdict } from './compatibility.ts'

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
  /** Test-only injection: the filesystem `packageHasClientHalf` reads
   * `dsh.client` through; the same seam `hot.ts` reads its patch through.
   * Production uses `nodeHotFs`. */
  hotFs?: HotFs
  /** Test-only injection: the Loader's boot-layer entries; production reads
   * them from `ctx.loader`. */
  loaderEntries?: () => Array<LoaderEntryLike>
  dshBin?: string
  /** The dsh argv this process was launched with, for `shop/restart`;
   * defaults to the real `process.argv` minus node and the script path. */
  restartArgv?: string[]
  /** The JS entry `shop/restart` re-runs; defaults to `process.argv[1]`, the
   * script this dsh was started with. It is also what identifies the running
   * harness for the `dsh.compatibility` verdict: the package that owns this
   * script, through symlinks, is the dsh actually running, and its own
   * app-boot supplies the profile templates (`harness.ts`). A script owned by
   * anything else — a test runner, another host — leaves both halves of that
   * verdict silent. The tests about where the running version comes from pass
   * a fixture install here, which is the production path; the rest inject
   * `readHarness`. */
  restartScript?: string
  /** Test-only injection: how the running harness is read from
   * `restartScript`; production uses `readRunningHarness`. It exists because
   * an in-process test cannot import a module from another Windows drive
   * under vitest's module runner, and a Windows runner has the checkout on D:
   * and the temp dir, where every fixture harness lives, on C:. The read's
   * import of the fixture's app-boot fails there, and the table reads empty.
   * Production passes nothing, so the running dsh is read as before. Read
   * once and kept either way (see `harnessRead`), so like the default it
   * must never reject. */
  readHarness?: (script: string | undefined) => Promise<RunningHarness>
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
  /** Test-only injection: the pins file's filesystem; production uses node:fs. */
  pinFs?: RepoPinFs
  /** Test-only injection: the explicit `allowRestart` override; production
   * reads the loader row's `config.allowRestart`. */
  allowRestart?: boolean
  /** The environment `detectSupervisor` reads; production uses process.env. */
  env?: NodeJS.ProcessEnv
  /** The platform the restart gate reads; production uses process.platform. */
  platform?: NodeJS.Platform
  /** The pid `detectSupervisor` inspects; production uses process.ppid —
   * the PARENT pid (a systemd unit's main process has ppid 1). */
  ppid?: number
  /** Test-only injection: how the release-tarball integrity check fetches
   * the release asset; production uses global fetch. */
  fetchTarball?: (url: string) => Promise<Response>
  /** Test-only injection: answers whether a peer resolves. Production builds
   * one from the profile anchor. */
  resolvePeer?: PeerResolver
  /** Test-only injection: answers which version a peer resolves at, for the
   * load-time self-check. Production builds one from the profile anchor. */
  resolvePeerVersion?: PeerVersionResolver
  /** Test-only injection: the peer ranges the self-check judges against;
   * production reads them from the shipped package.json. */
  peerRanges?: Record<string, string>
  /** Test-only injection: the download phase's pump; production builds the
   * real one. A test gateway left with the real pump spawns `pnpm store add`
   * — a live registry request — from every install that finds a command
   * already queued for its profile. */
  prefetcher?: Prefetcher
  /** Test-only injection: the record of packages this process may already
   * have imported. Production shares one module-scope set across every
   * gateway in the process (see `importedThisProcess`), which a test file
   * building many gateways would otherwise share as well. */
  importedModules?: Set<string>
}

/** `shop/installStart` result (§7.3): rejections are typed wire values with an
 * author-readable `detail`, not thrown RPC errors. */
export type ShopInstallResult =
  | { ok: true; installId: string; state: InstallState }
  | { ok: false; code: InstallRejectionCode; detail: string }

export interface ShopInstallStatusResult extends InstallStatus { found: boolean }

/**
 * `shop/setEnabled` result (§7.3): an unknown name is a typed wire value, not
 * a thrown RPC error.
 *
 * A union rather than one flat shape with two optional fields, so that
 * "`activation` is present exactly when `ok`" is something the compiler
 * holds instead of a sentence this comment asks every reader to hold. Every
 * `ok` answer says what the reader must do for the toggle to be visible — a
 * toggled package with a browser half needs a reload, which this result used
 * to be unable to say (design 2026-09-11-activation-model §6) — and every
 * refusal carries the detail that names why.
 *
 * The client still defaults an absent `activation` conservatively. This type
 * binds the process it is compiled into; the WIRE outlives it, because a tab
 * can reach an older in-process host for as long as one reload after a shop
 * self-update lands on disk.
 */
export type ShopSetEnabledResult =
  | { ok: true; activation: Activation }
  | { ok: false; detail: string }

/** `shop/uninstallStart` result (§7.3): a name outside the catalog or not
 * installed is a typed wire value with an author-readable `detail`, not a
 * thrown RPC error. */
export type ShopUninstallResult =
  | { ok: true; installId: string }
  | { ok: false; detail: string }

/** `shop/restart` result (§7.3): the restarted server's URL, or a typed
 * failure — on failure the old process is still serving. */
export type ShopRestartResult = RestartOutcome

/** Why `shop/restart` would refuse, for a reason fixed for the life of this
 * process: the platform, the supervisor (env and ppid are read once at
 * construction), and the launch argv. Every one of them is decided before the
 * first request arrives, which is what lets `version()` advertise it and the
 * client name it without asking again.
 *
 * `restart()` carries one further refusal this deliberately omits — a running
 * install — because that one is transient: a mount-time answer about it would
 * be stale the moment the install finished, and a card would go on saying a
 * restart was impossible after it had become possible. Static here, dynamic
 * there; the split is the whole reason this is a separate predicate rather
 * than a cache of `restart()`'s answer. */
export type RestartBlockedReason = 'windows' | 'systemd' | 'port-zero'

/** Each blocked reason's author-readable refusal, written once.
 *
 * `restart()` returns these as its `detail` and `version()` returns the bare
 * reason for the client to localize, so the two can no longer disagree about
 * WHY a restart is impossible. They did: `version()` reported a boolean that
 * covered two of the refusals, the client had one string for that boolean, and
 * that string named systemd — so a Windows user was told to restart a systemd
 * service and to set an override that the platform check, being the first gate
 * of the three, could never reach. */
const RESTART_BLOCKED_DETAIL: Record<RestartBlockedReason, string> = {
  windows: 'dsh-plugin-shop: restart is not supported on Windows yet; restart dsh manually to apply the change',
  systemd: 'dsh-plugin-shop: restart is disabled because this process is a systemd service — a restart would kill the takeover helper along with the unit, and the service would not come back. Set allowRestart: true in the shop row config to override.',
  'port-zero': 'dsh-plugin-shop: restart is not supported when dsh was launched with --port 0; restart dsh manually',
}

/** `shop/version` result (§7.3): the RUNNING shop version (from the shipped
 * package.json, not the manifest's range), the npm latest when the check
 * could answer (`null` = no answer — advisory, never an error), and the
 * comparison verdict. */
export interface ShopVersionResult {
  installed: string
  latest: string | null
  outdated: boolean
  /** Why `shop/restart` would refuse, or null when nothing static stands in
   * its way. The client drops the restart offer on a reason and renders that
   * reason's own copy, keeping the pending-change notice either way. */
  restartBlocked: RestartBlockedReason | null
}

/** `shop/updateStart` result (§7.3): the self-update spawn, or a typed
 * refusal (a version that is not plain semver). */
export type ShopUpdateResult =
  | { ok: true; installId: string; state: InstallState }
  | { ok: false; detail: string }

/** `shop/installed` entry (§7.3): one installed catalog plugin. The identity
 * fields distinguish same-named npm and GitHub rows; `installed` remains the
 * manifest spec or the recorded GitHub pin, and the client never does version
 * math. */
export interface ShopInstalledEntry {
  name: string
  source: 'npm' | 'github'
  repo?: string
  subdir?: string
  installed: string
  latest: string
  outdated: boolean
  enabled: boolean
}

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
  /** Names whose shop-like NAME must not hide them from the shelf
   * (registry/not-a-shop.yml). Absent for a catalog built before the key. */
  notAShop?: string[]
  /** GitHub star counts by package name; {} when the pointer names no sidecar
   * or the sidecar could not be fetched/verified (§5). */
  stars: Record<string, number>
  /** Install identity (`npm:<name>` / `github:<repo>#<subdir>`) → the declared
   * peers node resolution cannot find from the profile. This is the HOST half
   * of the verdict only: a module the browser's module table serves — a
   * platform seed word such as `react` — has no package on disk and is still
   * listed here, so the client removes every name its live module table
   * provides before anything renders (`client/module-table.ts`), and renders
   * no peer verdict at all on a page that offers no usable table. A key is
   * absent when the plugin runs here or when no verdict could be formed;
   * same-named entries stay independent. */
  incompatible: Record<string, string[]>
  /** Install identity → what the entry's author declared in
   * `dsh.compatibility` that this installation does not meet (design
   * 2026-09-01-harness-compatibility §8.2). A key is absent when nothing was
   * declared or every declared half is met. A half that cannot be judged —
   * the running version unreadable, a range semver cannot parse — is left out
   * while the other is still judged, so an unknown never reads as an
   * accusation; same-named entries stay independent. A process not started
   * by dsh's CLI judges neither half: nothing then says which harness runs
   * (`harness.ts`). */
  incompatibleHarness: Record<string, HarnessVerdict>
}

/** An own-property read of a dependency map parsed from the profile manifest.
 * A bare index read answers for `Object.prototype`, and `constructor` is a
 * legal npm name (`[a-z0-9][a-z0-9._-]*`), so `dependencies['constructor']`
 * hands back a function for a package that is not installed. The
 * `spec === undefined` guard then passes, and `installedSpecMatches` returns
 * TRUE for an npm entry — `parseRepoSpec` coerces the function to a string
 * that matches no `github:` shorthand and answers `null`, which is exactly
 * what an npm entry expects. So the entry reads as installed when it is not.
 * `Object.hasOwn` is the same fix already applied at the two membership
 * checks above; these two sites need the VALUE, hence a helper. */
function ownDependencySpec(
  dependencies: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  return Object.hasOwn(dependencies, name) ? dependencies[name] : undefined
}

/**
 * Package names whose module this PROCESS may already hold in Node's module
 * cache (design 2026-09-26-market-borrowings §1.2).
 *
 * A hot mount can only deliver code the process has not imported yet. The hot
 * tree imports through the loader's `internal.import`, which is Node's own ESM
 * loader and caches a module by its URL, and an install rewrites a package's
 * files at the URL it already had (`nodeLinker: hoisted`). Once a name is in
 * here, a mount of it would re-run the cached module under whatever version is
 * now on disk.
 *
 * Module scope rather than a gateway field, because the cache it models is the
 * process's: a gateway rebuilt inside a running dsh — a restarted shop fiber —
 * must not forget what the process imported before it existed. Every gateway
 * seeds it with the profile's dependencies at construction (the boot
 * composition) and extends it with every name the hot path mounts. Nothing is
 * ever removed: an uninstall disposes the fiber, not the module record.
 */
const importedThisProcess = new Set<string>()

/** Remote-only service exposing the shop Remote methods of §7.3.
 *
 * @typert service shop */
export class ShopGateway extends TypertRemoteService {
  private readonly options: ShopGatewayOptions
  /** The context this gateway was built with: the shop's own fiber. Inside an
   * RPC method `this.ctx` is NOT that — cordis hands a service out with `ctx`
   * rebound to the context that looked it up, so a call arriving over the
   * wire sees the caller's, the typert gateway's (measured on 0.1.5-rc.3 and
   * 0.1.7-rc.2). Anything whose PARENT matters is registered from here. The
   * hot tree above all: registered from the gateway's context it was owned by
   * the gateway's fiber rather than the shop's, was listed under the gateway's
   * loader entry, and — the part a reader saw — sat where dsh's client
   * registry never composed it, so a hot-installed browser half needed a
   * restart that a reload now does (design 2026-09-26-dsh-017-readiness). */
  private readonly home: Context
  /** The profile dsh installs into; discovered from this module's own
   * location when the caller does not supply one. */
  private readonly profile: string
  private readonly profileDir?: string
  private readonly inventory?: ShopGatewayOptions['inventory']
  private readonly hot?: ShopGatewayOptions['hot']
  private readonly hotFs?: ShopGatewayOptions['hotFs']
  private readonly loaderEntriesInjected?: ShopGatewayOptions['loaderEntries']
  private readonly dshBin: string
  /** The argv `shop/restart` re-spawns: the real process argv minus node and
   * the CLI script path, or a test-provided substitute. */
  private readonly restartArgv: string[]
  /** The script the restart re-runs — this process's own entry. */
  private readonly restartScript: string | undefined
  /** The exit the restart calls once the response is out; `process.exit` in
   * production, a spy in tests. */
  private readonly exit: (code?: number) => void
  private readonly restartExitDelayMs: number
  private readonly restartParentPid: number
  private readonly latestVersion: () => Promise<string | null>
  private readonly pinFs: RepoPinFs
  private readonly allowRestart?: boolean
  private readonly env: NodeJS.ProcessEnv
  /** The platform the restart gate reads; production defaults to
   * process.platform. The two-phase handoff is POSIX-only (restart.ts). */
  private readonly platform: NodeJS.Platform
  /** The parent pid `detectSupervisor` inspects; production defaults to
   * process.ppid (a systemd unit's main process has ppid 1). */
  private readonly ppid: number
  /** The release-tarball fetch for the install-time integrity check; global
   * fetch in production, a fixture response in tests. */
  private readonly fetchTarball: (url: string) => Promise<Response>
  /** One pump for the whole gateway: batching is per profile and lives inside
   * it, so a second instance would race the first for the same store. */
  private readonly prefetcher: Prefetcher
  /** What this process may already have imported (see `importedThisProcess`). */
  private readonly imported: Set<string>
  /** The install gate runs against the last loaded snapshot, never a fresh
   * fetch per request (§7.2: the Host's cached snapshot is the truth). */
  /** Finished install records retained, so a poll sees the true terminal
   * state (§8: done / activation / failure detail). Oldest evicted on add. */
  private static readonly MAX_FINISHED_INSTALLS = 32

  /** How long the gateway waits after a successful restart response before
   * exiting the old process — the browser must receive the URL first. */
  private static readonly RESTART_EXIT_DELAY_MS = 2000

  /** The install gate runs against the last loaded snapshot, never a fresh
   * fetch per request (§7.2: the Host's cached snapshot is the truth). */
  private lastSnapshot: CatalogSnapshot | null = null
  /** A cold-cache catalog load shared by concurrent RPC calls. */
  private inFlightLoad: Promise<CatalogResult> | null = null
  /** The origin list built for the last-seen `catalogUrl`, memoised so the
   * user's npmrc is read at most once per gateway (see `originsFor`). */
  private originCache: { catalogUrl: string; origins: CatalogOrigin[] } | null = null
  /** The user's own `registry=` from `~/.npmrc`, read at most once per
   * gateway. A wrapper distinguishes a genuine `null` from an unread value. */
  private npmRegistryCache: { value: string | null } | null = null
  /** The harness this process runs, read at most once per gateway: which dsh
   * is running cannot change while it runs, and the read imports a module. A
   * promise, so concurrent first calls share one read; `readRunningHarness`
   * never rejects, so there is no failure to retry. */
  private harnessRead: Promise<RunningHarness> | null = null
  /** Install records, running and finished; a poll finds one here or reports not found. */
  private readonly installs = new Map<string, ReturnType<typeof startInstall>>()
  /** Every install id in insertion order, oldest first; finished-record eviction walks this from the front. */
  private readonly installOrder: string[] = []

  constructor(ctx: Context, options: ShopGatewayOptions = {}) {
    super(ctx, 'shop')
    this.home = ctx
    this.options = options
    this.profile = options.profile ?? discoverProfile(fileURLToPath(import.meta.url), this.bootBaseDir()).name
    this.profileDir = options.profileDir
    this.inventory = options.inventory
    this.hot = options.hot
    this.hotFs = options.hotFs
    this.loaderEntriesInjected = options.loaderEntries
    this.dshBin = options.dshBin ?? 'dsh'
    this.restartArgv = options.restartArgv ?? process.argv.slice(2)
    this.restartScript = options.restartScript ?? process.argv[1]
    this.exit = options.exit ?? ((code?: number) => process.exit(code))
    this.restartExitDelayMs = options.restartExitDelayMs ?? ShopGateway.RESTART_EXIT_DELAY_MS
    this.restartParentPid = options.restartParentPid ?? process.pid
    this.latestVersion = options.fetchLatestVersion ?? (() => fetchLatestVersion(fetch, { registry: this.npmRegistry() }))
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
    this.platform = options.platform ?? process.platform
    this.ppid = options.ppid ?? process.ppid
    this.fetchTarball = options.fetchTarball ?? ((url: string) => fetch(url))
    this.prefetcher = options.prefetcher ?? createPrefetcher()
    this.imported = options.importedModules ?? importedThisProcess
    // What the profile holds as this gateway is built is what the boot
    // composed: imported, as far as the process's module cache is concerned.
    // An unreadable manifest seeds nothing — an update is still recognized
    // from the manifest at install time, so what goes unrecognized then is an
    // uninstall followed by a reinstall, and only until the next boot.
    for (const name of Object.keys(this.profileDependenciesOrNone() ?? {})) this.imported.add(name)
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
    // The harness self-check, at load and only here: the shop declares real
    // peer ranges on harness packages and nothing enforces them — `dsh plugin
    // add` does not, and the catalog's presence check answers a different
    // question (does it resolve?) about OTHER plugins. A harness that moved
    // under this build gets one line naming it, which is what an afternoon of
    // diagnosing a silently changed plugin path cost.
    this.checkPeerVersions()
  }

  /**
   * Warn once, at load, about any declared peer the harness provides outside
   * its declared range. Advisory by construction: it cannot throw, and it
   * never refuses the load — losing the whole shop is a worse outcome than
   * running against a harness that moved.
   */
  private checkPeerVersions(): void {
    try {
      createPeerVersionCheck({
        ranges: this.options.peerRanges ?? ownPeerRanges(),
        resolve: this.options.resolvePeerVersion ?? nodeVersionResolver(this.profileAnchor()),
        warn: message => {
          const logger = (this.ctx as { logger?: { warn(message: string): void } }).logger
          if (logger === undefined) console.warn(message)
          else logger.warn(message)
        },
      })()
    } catch {
      // Swallows a missing profile anchor (a bare test construction resolves
      // none) and an unreadable own manifest. Either way no verdict is
      // formable, and silence is the documented answer for a fact we cannot
      // read — never an accusation, and never a failed load.
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

  /** Where every "what can this installation's plugins import?" question
   * resolves from: the profile's own Loader root, which is where the harness
   * resolves plugins from. One definition for the peer presence check and the
   * load-time self-check, so neither can drift onto a different notion of
   * "the installation". NOT where the running harness is read from: a copy
   * of `@deepseek-ai/dsh` a plugin's dependencies hoist into the profile is
   * importable from here and is not what runs (`harness.ts`). Throws when no
   * profile directory can be discovered and none is given. */
  private profileAnchor(profileDir: string = this.profileDirResolved()): string {
    return pathToFileURL(join(profileDir, 'cordis.yml')).href
  }

  /** `profileDirResolved`, or null when no profile directory can be
   * discovered — for the reads that answer "cannot tell" rather than fail. */
  private profileDirOrNone(): string | null {
    try {
      return this.profileDirResolved()
    } catch {
      // Swallows the discovery failure: no profile above this module and none
      // on the boot's baseUrl (the bare test constructions). Every caller
      // reads null as "no verdict needing the profile can be formed".
      return null
    }
  }

  /** The harness this process runs, read once (see `harnessRead`). */
  private runningHarness(): Promise<RunningHarness> {
    const read = this.options.readHarness ?? readRunningHarness
    this.harnessRead ??= read(this.restartScript)
    return this.harnessRead
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
   * The uninstall path is the one caller: an update used to swap its running
   * instance for a hot mount through here, and no longer mounts at all
   * (design 2026-09-26-market-borrowings §1). */
  /** The package's owned entry ids, or none when its bundle patch cannot be
   * read. For the paths where a live disable is an optimization and the
   * operation must succeed regardless; `setEnabled` reports the failure
   * instead, because there the patch IS the answer being asked for. */
  /**
   * The profile manifest's dependencies, or undefined when it cannot be read.
   *
   * `readProfileManifest` throws on an unreadable file and lets `JSON.parse`
   * throw on a malformed one, and `profileDirResolved` can throw out of
   * `discoverProfile`. An escaped exception crosses the RPC as a bare
   * transport failure and the client can only render "please retry" (the same
   * hazard `setEnabled` catches), so a profile caught mid-write would turn
   * every published rejection detail on the install path — denied,
   * not-in-catalog, version-mismatch — into that one line.
   *
   * Undefined is "cannot say", which the caller must not read as "nothing is
   * installed": it means the install proceeds ungated rather than being
   * refused over a read that did not happen.
   */
  private profileDependenciesOrNone(): Record<string, string> | undefined {
    try {
      return readProfileManifest('dsh-plugin-shop', this.profileDirResolved()).dependencies ?? {}
    } catch {
      return undefined
    }
  }

  /**
   * The profile manifest's spec for one name, or undefined when the manifest
   * holds no such name — or could not be read at all.
   *
   * Through `ownDependencySpec` for the reason spelled out there: a bare index
   * read answers for `Object.prototype`, and `constructor` is a legal npm
   * name. The cost on this path is behavioural twice over — the gate would
   * weigh a function as the installed spec, and a phantom `isUpdate` would
   * refuse a hot mount to a package this process never imported.
   */
  private installedSpecOf(name: string): string | undefined {
    const dependencies = this.profileDependenciesOrNone()
    return dependencies === undefined ? undefined : ownDependencySpec(dependencies, name)
  }

  private ownedEntryIdsOrNone(packageName: string): string[] {
    try {
      return ownedEntryIds({ profileDir: this.profileDirResolved(), packageName })
    } catch {
      // Unreadable patch: no ids, so nothing gets disabled live. Read by
      // `liveEntriesDown` as "no live entry of this package", the same as a
      // package with no rows — the removal still stands at the next boot,
      // and there is nothing this process can name to bring down.
      return []
    }
  }

  /** Whether an installed package declares `dsh.client`. Reads through the
   * `hotFs` option — `HotFs` is `hot.ts`'s type, but this gateway forwards
   * the option only HERE, never into `hotMount`, which takes its own `fs`
   * from `HotDeps`. A fixture therefore drives this read alone, which is the
   * point: it is the only way to state what a package declared BEFORE an
   * update overwrote its manifest. */
  private packageHasClientHalf(packageName: string): boolean {
    return hasClientHalf(this.hotFs ?? nodeHotFs, this.profileDirResolved(), packageName)
  }

  /**
   * Bring every live entry the package owns down, best effort, and report
   * whether its host half is DOWN when this returns.
   *
   * "Nothing matched" is down: a package with no live entry is not running,
   * which is the ordinary case for removing a plugin that never loaded this
   * session. Only a matched entry whose fiber outlives the retries — or
   * whose `update` throws — leaves the plugin UP, and that is the one case
   * an uninstall must not describe as stopped.
   *
   * The old spelling answered "did any update succeed", which is a different
   * question: `update` resolving says the row was accepted, not that the
   * instance went away. The retry loop below exists precisely because those
   * two come apart, so reading the first as the second threw away the answer
   * the loop was computing.
   */
  private async liveEntriesDown(ids: readonly string[]): Promise<boolean> {
    if (ids.length === 0) return true
    const owned = new Set(ids)
    let allDown = true
    for (const entry of this.loaderEntries()) {
      // Matched on the entry id, never the module name: a package's entry
      // may mount another package's module entirely (see ownedEntryIds), and
      // the name match silently found nothing for every such package.
      if (entry.id === undefined || !ownsEntryId(owned, entry.id)) continue
      let down = false
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await entry.update({ disabled: true }, false, true)
        } catch {
          // A failing update leaves the entry running — best-effort
          // live-disable, and the caller reports the honest outcome.
          break
        }
        if (entry.fiber === undefined) {
          down = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      if (!down) allDown = false
    }
    return allDown
  }

  /** Enable or disable one installed plugin, hot (§8): the write sets the
   * `disabled` key of each owned entry's row in the user layer and changes
   * nothing else there (design 2026-09-26-market-borrowings §2) — the CLI's
   * watchUserPatches applies it through HMR. The shop's own row and the
   * framework's bundles are never toggleable: disabling the host chain would
   * break HMR itself. */
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
    if (!Object.hasOwn(manifest.dependencies ?? {}, args.name)) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not installed` }
    }
    // A malformed or unreadable bundle patch must reach the person as a
    // reason, not as a throw: an escaped exception crosses the RPC as a bare
    // transport failure, and the client can only render "please retry" for it
    // — the one rejection on this path with no author-readable detail.
    let owned: OwnedEntry[]
    try {
      owned = ownedEntries({ profileDir, packageName: args.name })
    } catch (error) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} has a bundle patch that could not be read: ${String(error)}` }
    }
    if (owned.length === 0) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} contributes no plugin entries, so there is nothing to enable or disable` }
    }
    const ownedSet = new Set(owned.map(entry => entry.id))
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
    // host row and a client row is one plugin to the person clicking. Each
    // row carries the module its entry mounts, which is what lets the write
    // land on a row the user named rather than beside it.
    setUserLayerRows({
      profileDir,
      rows: owned.map(({ id, name }) => ({ id, disabled: !args.enabled, ...(name !== undefined ? { name } : {}) })),
    })
    // The user layer is hot-reloaded by the harness, so the host half is
    // already in its new state; a package with a browser half still needs
    // the open tab to reload (design 2026-09-11-activation-model §3).
    // `clientLive: true` — a toggle moves a row the client registry already
    // enumerates, and the served graph follows it (§2, measured 2026-09-11).
    return { ok: true, activation: activationOf({ hostLive: true, clientLive: true, hasClientHalf: this.packageHasClientHalf(args.name) }) }
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

  /** The user's own registry, read once. The self-update check and catalog
   * race share this preference so neither path repeatedly touches ~/.npmrc. */
  private npmRegistry(): string | null {
    const cached = this.npmRegistryCache
    if (cached !== null) return cached.value
    const value = npmrcRegistry(path => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // No user npmrc, or unreadable: the defaults are raced instead. This
        // is a preference, never a requirement.
        return null
      }
    }, homedir())
    this.npmRegistryCache = { value }
    return value
  }

  /** The origins to race for this row's catalog. Read once per gateway: the
   * user's npmrc does not change under a running dsh, and re-reading it on
   * every catalog call would put a filesystem read on the hot path. */
  private originsFor(catalogUrl: string): CatalogOrigin[] {
    if (this.originCache?.catalogUrl === catalogUrl) return this.originCache.origins
    const origins = catalogOrigins(catalogUrl, fetch, this.npmRegistry())
    this.originCache = { catalogUrl, origins }
    return origins
  }

  /** Join an in-flight load; refresh requests always start a new load. */
  private loadCatalogOnce(refresh: boolean): Promise<CatalogResult> {
    const existing = this.inFlightLoad
    if (!refresh && existing !== null) return existing
    const { catalogUrl, cacheDir } = this.rowConfig()
    const load = this.options.loadCatalog ?? loadCatalog
    const started = load({ origins: this.originsFor(catalogUrl), cacheDir, refresh })
      .then(result => {
        this.lastSnapshot = result.snapshot
        return result
      })
    this.inFlightLoad = started
    const forget = (): void => {
      if (this.inFlightLoad === started) this.inFlightLoad = null
    }
    started.then(forget, forget)
    return started
  }

  /** Return the current snapshot, loading it once when needed. */
  private async snapshotNow(): Promise<CatalogSnapshot> {
    if (this.lastSnapshot !== null) return this.lastSnapshot
    const { snapshot } = await this.loadCatalogOnce(false)
    return snapshot
  }

  /** The explicit restart override. Only the row's `config:` sub-object is
   * passed to a plugin — a top-level `allowRestart:` beside `name:` would be
   * silently ignored by the loader (dsh-market README, #227). */
  /** Whether the two-phase handoff can run at all here. `restart.ts` drives
   * it through `sh`, `kill -0` and `sleep`, none of which Windows has. */
  private restartPlatformSupported(): boolean {
    return this.platform !== 'win32'
  }

  /** Why a restart would be refused for this process, or null when nothing
   * static does. One ordered list, read by `restart()` before it commits and
   * by `version()` so the client can say the same thing up front.
   *
   * The order is the order the refusals were written in and is load-bearing
   * for the copy a reader sees: Windows first, because the platform check has
   * no override and reporting the systemd one there sends a Windows user to
   * set `allowRestart: true`, which this gate would still refuse.
   *
   * - `windows`: the handoff helper is a POSIX shell one-liner (restart.ts)
   *   and there is no `sh` on Windows. That spawn fails ASYNCHRONOUSLY, so
   *   committing would answer `ok: true`, exit this process, and leave nothing
   *   to take the port — dsh would simply be gone.
   * - `systemd`: under a unit the two-phase handoff kills itself, because the
   *   main process exiting also kills the unit's cgroup and takes the detached
   *   helper with it; the service never comes back. Overridable, and the only
   *   one of the three that is.
   * - `port-zero`: the OS hands the NEW process a fresh port the browser
   *   cannot know, so a restart would strand the client on a dead origin. */
  private staticRestartBlock(): RestartBlockedReason | null {
    if (!this.restartPlatformSupported()) return 'windows'
    if (detectSupervisor(this.env, { ppid: this.ppid }) === 'systemd' && !this.allowRestartConfigured()) return 'systemd'
    const portIndex = this.restartArgv.indexOf('--port')
    if (portIndex !== -1 && this.restartArgv[portIndex + 1] === '0') return 'port-zero'
    return null
  }

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
    const { snapshot, stale } = await this.loadCatalogOnce(args?.refresh ?? false)
    // Both verdicts are judged on every call and never remembered against the
    // snapshot. The snapshot records what each entry DECLARES; what this
    // installation provides is not in it, and moves under it — installing a
    // missing peer from the shop is exactly the event that must clear its
    // badge, and a map kept per snapshot would go on naming that peer for as
    // long as the snapshot is served. Asking every time is cheap; design
    // 2026-09-01-harness-compatibility §9.6 owns the measurement. The one
    // input kept is the running harness — which dsh this process is, and its
    // template table — because a running process cannot change it.
    const harness = await this.runningHarness()
    // The profile directory, looked up ONCE: the peer resolver's anchor and
    // the profile half's bundles are read from the same directory, so the two
    // verdicts cannot describe two different profiles. None discovered (a
    // bare construction that supplies neither `profileDir` nor a module
    // location under a profile) means no verdict that needs one.
    const profileDir = this.profileDirOrNone()
    let incompatible: Record<string, string[]> = {}
    if (profileDir !== null) {
      try {
        const resolve = this.options.resolvePeer ?? nodeResolver(this.profileAnchor(profileDir))
        incompatible = incompatibilityMap(snapshot.entries, resolve)
      } catch {
        // Swallows anything incompatibilityMap throws on an entry shape this
        // build did not expect — `peers: 5`, say, which is not iterable, and
        // which the catalog's zod parse refuses, so only an injected snapshot
        // can carry it. A plugin we cannot judge is never accused, so the
        // whole map degrades to empty rather than one entry costing every
        // reader the catalog. A resolver's own throws never reach here:
        // incompatibilityMap turns those into no verdict for the entry.
        incompatible = {}
      }
    }
    let incompatibleHarness: Record<string, HarnessVerdict>
    try {
      incompatibleHarness = compatibilityMap(snapshot.entries, {
        dshVersion: harness.dshVersion,
        profile: { name: this.profile, bundles: profileDir === null ? null : this.runningProfileBundles(profileDir) },
      }, harness.templates)
    } catch {
      // Swallows anything compatibilityMap throws on a declaration this build
      // did not expect — `profiles: 5`, say, which has no `includes`, and
      // which the catalog's zod parse refuses, so only an injected snapshot
      // can carry it. The rule is the peer map's: a declaration nobody can
      // judge is never an accusation, and this call answers for the whole
      // shelf, so one entry must not reject it. It did: before the template
      // table lost its prototype, one entry declaring
      // `profiles: ["constructor"]` made every catalog() call reject, for
      // every user. The whole map degrades to empty; the peer map above
      // stands.
      incompatibleHarness = {}
    }
    return {
      schemaVersion: snapshot.schemaVersion,
      builtAt: snapshot.builtAt,
      stale,
      plugins: snapshot.entries,
      denied: snapshot.denied,
      notAShop: snapshot.notAShop ?? [],
      stars: snapshot.stars,
      incompatible,
      incompatibleHarness,
    }
  }

  /**
   * The bundles the profile at `profileDir` composes, or null when its
   * manifest cannot be read — which is no verdict on the profile half rather
   * than an accusation. `dsh.profile.bundles` is the same list
   * `discoverProfile` uses to recognize a profile directory, read through the
   * harness's own parser so a profile this shop was booted inside is read the
   * way dsh reads it.
   */
  private runningProfileBundles(profileDir: string): readonly string[] | null {
    try {
      const bundles = readProfileManifest('dsh-plugin-shop', profileDir).dsh?.profile?.bundles
      if (!Array.isArray(bundles) || !bundles.every((bundle): bundle is string => typeof bundle === 'string')) return null
      return bundles
    } catch {
      // Swallows an unreadable or malformed manifest: nobody can then say what
      // this profile composes, and the answer for that is silence on this
      // half, never a warning.
      return null
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
    const snapshot = await this.snapshotNow()
    // The manifest's dependency for this name, when it has one: the gate needs
    // it to tell an update of THIS plugin from a replacement of a different one
    // that shares the name. Read once, here, and reused for `isUpdate` below —
    // two reads straddling the tarball fetch could see two different manifests.
    const installedSpec = this.installedSpecOf(args.name)
    const verdict = validateInstall(snapshot, args, installedSpec)
    if (!verdict.ok) return { ok: false, code: verdict.code, detail: verdict.detail }
    // The validator resolved the row by identity. Re-finding it by name is
    // what installed another repository's commit when names collided.
    const entry = verdict.entry
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
      // No git check here, deliberately. pnpm resolves a `github:` spec
      // through GitHub's tarball endpoint, not `git clone`, so git is not a
      // precondition: measured with git stubbed to exit 127 on pnpm 9.15.9,
      // 10.15.0 and 11.13.0, for this form and the `&path:` one, then end to
      // end through the binary actually spawned below — `dsh plugin add`
      // exited 0 on dsh 0.1.1-rc.2 and the package landed in the profile
      // manifest. The preflight that stood here rejected EVERY github entry
      // on a machine without git, which is 61% of the catalog, for a
      // dependency the install does not have. A real failure still reports
      // pnpm's stderr verbatim plus the recovery hint (executor.ts).
      spec = `github:${entry.repo}#${args.version}${entry.subdir !== undefined ? `&path:${entry.subdir}` : ''}`
    } else {
      spec = `${args.name}@${args.version}`
    }
    // Whether this process may already have imported the package — and so
    // whether a hot mount could deliver the new code at all (design
    // 2026-09-26-market-borrowings §1). An update always may: whatever version
    // is installed was composed at boot or has been mounted since. The gate
    // above already proved that a defined spec names this very install, so
    // "the name is present" and "this is an update" are one fact, read once;
    // the own-property discipline lives in `installedSpecOf`. The process
    // record adds what the manifest cannot say: a name uninstalled earlier in
    // this session, whose module is still in the cache.
    const isUpdate = installedSpec !== undefined
    const alreadyImported = isUpdate || this.imported.has(args.name)
    const running = startInstall({
      profile: this.profile,
      spec,
      dshBin: this.dshBin,
      // §7.2 step 6: exit 0 must be confirmed against the profile manifest —
      // a bundle that did not land is not a done install. The executor takes
      // its own before/after snapshots of the profile's dependencies, through
      // the same resolution the confirm uses, so a miss reports the difference
      // and can name what actually landed.
      expectedName: args.name,
      // §7.2 step 5's new phase: an install that finds a command already
      // queued for this profile warms pnpm's store from OUTSIDE the mutex
      // while it waits. Best-effort — the install below is unchanged by it.
      prefetcher: this.prefetcher,
      // And, now that the files are on disk, the one collision the name gate
      // cannot see. Reporting it beats a done install that kills the next
      // boot; the package stays on disk, so the detail says how to undo it.
      alsoConfirm: () => {
        const clash = collidingEntryId({
          profileDir: this.profileDirResolved(),
          packageName: args.name,
          dependencies: Object.keys(this.profileDependenciesOrNone() ?? {}),
        })
        if (clash === null) return null
        return `dsh-plugin-shop: ${args.name} declares the loader entry id "${clash.id}", which ${clash.holder} already declares.`
          + ' dsh refuses to load a plugin tree holding a duplicate entry id, so the profile would not start.'
          + ` It is on disk: run \`dsh plugin --profile ${this.profile} remove ${args.name}\` to undo this install.`
      },
      // After the bundle lands, bring it up hot — unless this process may
      // already hold its module (see `alreadyImported`). A failed mount falls
      // back to restart activation, never to a silent half-state.
      afterDone: async () => {
        // No mount, and no live disable of the running instance. A mount would
        // import the package's URL again and Node would answer with the module
        // it cached, re-running the old code under the new version's name
        // (measured 2026-09-26, web-full-flow.e2e.ts). So the running instance
        // keeps running until the restart that loads the new files — and a
        // plugin the user had disabled stays disabled, which the swap this
        // replaced did not guarantee: it mounted the new rows under a `mkt-`
        // id that no user-layer row names.
        if (alreadyImported) return { activation: 'restart' as const, restartReason: 'already-loaded' as const }
        const hot = this.hot ?? { mount: hotMount, unmount: hotUnmount }
        // Recorded before the mount rather than on its success: the import is
        // what fills the cache, and a mount that fails after importing — an
        // activation that throws, a timeout — has filled it all the same.
        this.imported.add(args.name)
        const result = await hot.mount(
          { plugin: (plugin, config) => (this.home as unknown as { plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void } }).plugin(plugin, config) },
          this.profileDirResolved(),
          args.name,
        )
        if (!result.ok) {
          return { activation: 'restart' as const, ...(result.reason !== null ? { restartReason: result.reason } : {}) }
        }
        // The mount SUCCEEDED, so the host half is live — and the browser
        // half is in the graph the next page load boots from: the tree hangs
        // off the shop's own loader entry (`home`), where dsh's client
        // registry enumerates it like any boot-composed entry (activation.ts,
        // measured 2026-09-26 on 0.1.5-rc.3 and 0.1.7-rc.2). So a package with
        // a browser half is one reload away, not one restart. Only the new
        // version is read: a fresh install has no old one in the tab.
        return {
          activation: activationOf({
            hostLive: true,
            clientLive: true,
            hasClientHalf: this.packageHasClientHalf(args.name),
          }),
        }
      },
    })
    if (entry.source === 'github') {
      // Remember the pinned commit: the manifest records only
      // `github:owner/slug`, so the pins file is how `installed()` reports
      // outdated honestly. A failed install leaves a pin behind, but the
      // manifest presence gate keeps it invisible.
      const pins = readRepoPins(this.pinFs, this.pinsPath())
      writeRepoPins(this.pinFs, this.pinsPath(), { ...pins, [identityKey(entry)]: entry.version })
    }
    this.installs.set(running.installId, running)
    this.installOrder.push(running.installId)
    this.evictFinishedInstalls()
    return { ok: true, installId: running.installId, state: running.status().state }
  }

  /** Bound retained finished records at MAX_FINISHED_INSTALLS, evicting the
   * oldest finished ones (insertion order, oldest first). Live records —
   * running AND queued — are never evicted; an id absent from the map reports
   * `found: false`. */
  private evictFinishedInstalls(): void {
    const finishedIds: string[] = []
    for (const id of this.installOrder) {
      const record = this.installs.get(id)
      // Terminal, not "not running". A QUEUED install reports 'downloading',
      // and counting it here evicts a live record: `installStatus` then answers
      // found: false and the client renders "install record lost" for an
      // install that is about to run. The comment above this method — live
      // records are never evicted — is only true with this predicate.
      if (record !== undefined && isTerminalInstallState(record.status().state)) finishedIds.push(id)
    }
    const excess = Math.max(0, finishedIds.length - ShopGateway.MAX_FINISHED_INSTALLS)
    for (const id of finishedIds.slice(0, excess)) this.installs.delete(id)
  }

  /** Whether any command this gateway started is still running — or still
   * waiting its turn. */
  private hasRunningCommand(): boolean {
    for (const record of this.installs.values()) {
      // A queued install is a command this gateway started and has not
      // finished. Asking `=== 'running'` would let a restart boot a new dsh
      // against a profile with installs pending — what F-5 refuses.
      if (!isTerminalInstallState(record.status().state)) return true
    }
    return false
  }

  /** Poll one install's progress (§7.2); unknown ids report `found: false`. */
  @Remote('installStatus')
  installStatus(args: { installId: string }): ShopInstallStatusResult {
    const running = this.installs.get(args.installId)
    if (running === undefined) return { found: false, state: 'failed', log: [], detail: `unknown installId: ${args.installId}` }
    return { found: true, ...running.status() }
  }

  /**
   * The profile manifest's dependency spec for every name it holds — exactly
   * what the install gate reads, unfiltered.
   *
   * The client cannot derive this from `installed()`. That list drops any
   * dependency no catalog entry matches, so a fork, a hand `dsh plugin add`,
   * or an entry the catalog has since dropped is invisible to it — while the
   * gate, which reads the raw manifest, still refuses over it. That gap is
   * what made the card show a plain Install button for a name the host was
   * about to refuse. Shipping the gate's own input is what makes the badge
   * and the refusal one rule rather than two implementations that agree
   * until they do not.
   *
   * `null` is "cannot say" — an unreadable manifest — and is deliberately
   * distinct from `{}`, "nothing is installed": the client must not read a
   * failed read as a clean bill of health.
   */
  @Remote('installedSpecs')
  async installedSpecs(): Promise<Record<string, string> | null> {
    return this.profileDependenciesOrNone() ?? null
  }

  /** Installed catalog plugins (§7.3): every entry of the snapshot the profile
   * manifest declares as a dependency, with the Host's `outdated` verdict
   * attached. The tab's shelf cards and its Updatable section both derive
   * from this one list. */
  @Remote('installed')
  async installed(): Promise<ShopInstalledEntry[]> {
    const snapshot = await this.snapshotNow()
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
    for (const entry of snapshot.entries) {
      const spec = ownDependencySpec(dependencies, entry.name)
      if (spec === undefined) continue
      // A profile has one dependency per name, so the spec is the only way
      // to choose among same-named catalog entries.
      if (!installedSpecMatches(entry, spec)) continue
      const identity = { source: entry.source, repo: entry.repo, subdir: entry.subdir }
      if (entry.source === 'github') {
        // The manifest spec is `github:owner/slug` — no commit. The pin the
        // shop recorded at install time is the commit truth; without one the
        // entry was installed by other means and reads as current rather
        // than killing the RPC over an unknowable comparison.
        //
        // `pin !== entry.version` is an INEQUALITY, not an ordering. Two
        // commit shas cannot be ordered without asking the repository, so
        // this reports that the catalog offers a DIFFERENT commit, never
        // that it offers a newer one; the npm arm below is a real semver
        // comparison. §7.3's 2026-09-16 follow-up records what that bounds
        // the Updatable heading to, and why a probe per installed github
        // entry is not worth what it would cost.
        const pin = pins[identityKey(entry)] ?? pins[entry.name]
        installed.push({
          name: entry.name,
          ...identity,
          installed: pin ?? spec,
          latest: entry.version,
          outdated: pin !== undefined && pin !== entry.version,
          enabled: enabledOf(entry.name),
        })
      } else {
        installed.push({
          name: entry.name,
          ...identity,
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
    const snapshot = await this.snapshotNow()
    const named = snapshot.entries.filter(entry => entry.name === args.name)
    if (named.length === 0) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not in the catalog` }
    }
    const manifest = readProfileManifest('dsh-plugin-shop', this.profileDirResolved())
    const dependencies = manifest.dependencies ?? {}
    const spec = ownDependencySpec(dependencies, args.name)
    if (spec === undefined) {
      return { ok: false, detail: `dsh-plugin-shop: ${args.name} is not installed` }
    }
    // The dependency is removed by name, but the matching row tells us which
    // identity pin to forget. If no row matches, still allow removal: revoking
    // a dependency is safer than trapping it behind an unrecognised spec.
    const installedEntry = named.find(entry => installedSpecMatches(entry, spec))
    // Resolve the entry ids while the package is still on disk: `afterDone`
    // runs after the uninstall removed it, and its bundle patch with it.
    // Best-effort for the same reason as the update path: a package with an
    // unreadable patch must still be removable.
    const priorEntryIds = this.ownedEntryIdsOrNone(args.name)
    // Read the browser half while the package is still on disk — `afterDone`
    // runs after the uninstall deleted its manifest, and the conservative
    // fallback would then answer `true` for every package, turning this
    // verdict into a constant. Same ordering constraint, same reason, as
    // `priorEntryIds` above.
    const hadClientHalf = this.packageHasClientHalf(args.name)
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
        // Privilege is revoked the moment the fiber is gone, and the boot
        // composition drops the entry row at the next boot either way — so
        // neither arm finding anything still reports a live removal. What
        // this must NOT do is claim the plugin stopped while its fiber is
        // still up: "Removed and stopped immediately" would then be a false
        // statement about privilege, and a restart is the honest advice.
        const stopped = hotRemoved || await this.liveEntriesDown(priorEntryIds)
        // `clientLive: true` for the same reason as the toggle: what an
        // uninstall removes is a row of the boot composition, and dropping
        // one from the served graph is the measured half of §2.
        return { activation: activationOf({ hostLive: stopped, clientLive: true, hasClientHalf: hadClientHalf }) }
      },
    })
    // Forget the commit pin alongside the dependency; a stale pin would
    // otherwise outlive the uninstall in the shop's cache.
    const pins = readRepoPins(this.pinFs, this.pinsPath())
    const stalePins = [args.name, ...(installedEntry === undefined ? [] : [identityKey(installedEntry)])]
    let forgot = false
    for (const key of stalePins) {
      if (pins[key] === undefined) continue
      delete pins[key]
      forgot = true
    }
    if (forgot) {
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
    // A running install owns the profile: `pnpm` may be rewriting its
    // package.json, lockfile and node_modules. Exiting now would hand the
    // takeover helper a half-written profile, so refuse before anything is
    // torn down (F-5).
    if (this.hasRunningCommand()) {
      return {
        ok: false,
        detail: 'dsh-plugin-shop: an install is still running in this profile; a restart now would boot the new dsh against a half-written profile. Wait for it to finish and try again.',
      }
    }
    // The three static refusals, in the order `staticRestartBlock` states
    // them, and each one before anything is torn down. Asking it rather than
    // repeating its checks is what keeps the answer the client was given at
    // mount identical to the answer a press gets.
    const blocked = this.staticRestartBlock()
    if (blocked !== null) {
      return { ok: false, detail: RESTART_BLOCKED_DETAIL[blocked] }
    }
    let logFile: string
    try {
      const { cacheDir } = this.rowConfig()
      const { command, args } = restartCommand({
        dshBin: this.dshBin,
        argv: this.restartArgv,
        execPath: process.execPath,
        execArgv: process.execArgv,
        script: this.restartScript,
      })
      logFile = join(cacheDir, 'restart.log')
      startRestart({
        command,
        args,
        parentPid: this.restartParentPid,
        logFile,
        env: process.env,
      })
    } catch (error) {
      // A refused restart must not tear anything down; the detail names the
      // config or log problem in the shop's own words.
      return { ok: false, detail: `dsh-plugin-shop: restart could not be started: ${(error as Error).message}` }
    }
    // The response must reach the browser before this process exits; the
    // helper holds the child back until this pid is gone, so the port is
    // free when the new dsh binds. It names the log the new process writes,
    // for the page to point at if that process never stays up.
    setTimeout(() => this.exit(0), this.restartExitDelayMs)
    return { ok: true, logFile }
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
      restartBlocked: this.staticRestartBlock(),
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
      // The self-update runs through the same executor, so a queued update
      // gets the same download phase as a queued plugin install.
      prefetcher: this.prefetcher,
    })
    this.installs.set(running.installId, running)
    this.installOrder.push(running.installId)
    this.evictFinishedInstalls()
    return { ok: true, installId: running.installId, state: running.status().state }
  }
}

export default ShopGateway
