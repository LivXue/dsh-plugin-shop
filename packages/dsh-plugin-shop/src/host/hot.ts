/**
 * Restart-free installs: mount a freshly installed plugin into the running
 * composition through a shop-owned Include subtree (design 2026-08-31
 * market-borrowings §4, mechanism ported from dsh-market's hot.ts).
 *
 * Durable state stays with the profile's `dsh.profile.bundles`, so the next
 * boot loads the plugin through the normal bundle layer. The subtree exists
 * only for this process: its input files live under `<profile>/.dsh-shop/`
 * and are wiped on every boot, so a crash can never leave a file that
 * collides with the bundle layer (inserting an id the bundle layer also
 * inserts is a hard boot failure). Rows are prefixed `mkt-` for the same
 * reason: within this session the hot entry must never share an id with a
 * boot-layer entry, including a disabled one left behind by an update swap.
 *
 * The Include subclass suppresses `write()` — the loader otherwise persists
 * tree changes back to the file it read (dsh-market hot.ts; the in-tree
 * precedent is dsh's agent-presets PresetTree).
 *
 * Deliberate non-port: dsh-market's client-only shim (`mountClientOnlyDeps`
 * and `shimNames`, which hot-mounted a package with no server-side entry by
 * inserting a shim loader entry) is omitted. Our catalog never lists a
 * package without `dsh.bundle`, so the shim branch is unreachable here
 * (YAGNI). `hotMount` still distinguishes "no patch file / not
 * hot-mountable" from "restart will fix it" through the bilingual `reason`.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** One hot-mountable insert row: a plain `- id:` / `name:` pair. */
export interface HotRow { id: string; name: string }

/** The loader-side surface hot mounts consume: a cordis plugin registration
 * and (optionally) a logger. The real ctx satisfies this structurally. */
export interface HotContext {
  plugin(plugin: unknown, config: unknown): PluginHandle
  logger?: { info(message: string): void; warn(message: string): void }
}

/** A cordis Fiber handle: `await()` settles when activation finishes (or
 * fails); `dispose()` tears the fiber down. */
export interface PluginHandle {
  await(): Promise<unknown>
  dispose(): Promise<unknown> | void
}

export interface HotMountResult {
  ok: boolean
  /** Bilingual, distinguishing "restart will fix it" (a transient mount
   * failure) from "this package can never hot-mount" (no patch file, or a
   * patch the hot tree cannot replicate). null exactly when ok. */
  reason: string | null
}

/** Test injection for the host shell (filesystem + ctx + clock). Production
 * defaults: the real include import, node:fs, `join(profileDir, '.dsh-shop')`
 * and `DSH_SHOP_HOT_MOUNT_TIMEOUT_MS || 10000`. */
export interface HotDeps {
  /** The tree class to mount; production loads the Include class via the
   * optional peer. An explicit null means "the include is unavailable" and
   * short-circuits the load (the old-harness fallback). */
  hotTreeClass?: unknown
  fs?: HotFs
  dir?: string
  timeoutMs?: number
  now?: () => number
}

/** The node:fs surface hot.ts uses; injectable so tests never touch disk. */
export interface HotFs {
  read: (path: string) => string
  write: (path: string, data: string) => void
  list: (path: string) => string[]
}

const nodeFs: HotFs = {
  read: path => readFileSync(path, 'utf8'),
  write: (path, data) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
  },
  list: path => readdirSync(path),
}

/** This session's mounts, keyed by package name — the same key `hotUnmount`
 * and the gateway's flows use. The subtree unwinds with the shop's own
 * fiber; the map exists so a name can be disposed on demand. */
const hotHandles = new Map<string, PluginHandle>()

/** The shop's own namespace for ephemeral mount inputs. */
const HOT_DIR = '.dsh-shop'

/** `hot-<n>.yml` files: the only things `cleanHotDir` wipes and the only
 * files `hotMount` writes. */
const HOT_FILE_RE = /^hot-(\d+)\.yml$/

/** Reasons, bilingual, distinguishing the P0-2 categories: a transient mount
 * failure ("restart will fix it") versus a package that structurally cannot
 * hot-mount. All tell the user to restart; the head names which category. */
const NO_PATCH_REASON = '该插件没有可热挂载的补丁文件,重启后生效 / the plugin has no patch file to hot-mount — restart required'
const NOT_SIMPLE_REASON = '该插件的补丁包含无法热挂载的配置,重启后生效 / the plugin\'s patch has config rows that cannot be hot-mounted — restart required'
const HOST_CANNOT_HOT_MOUNT_REASON = '当前环境不支持热挂载,重启后生效 / this harness cannot hot-mount — restart required'
const TIMEOUT_REASON = '热挂载超时,重启后生效 / hot-mount timed out — restart required'
const MOUNT_FAILED_REASON = '热挂载失败,重启后生效 / hot-mount failed — restart required'

const ID_LINE_RE = /^- id: (.+)$/
const NAME_LINE_RE = /^  name: (.+)$/

/**
 * Parse a bundle patch into the plain insert rows a hot tree can replicate.
 * Only `- id:` / `name:` pairs parse — a row with config, an expression
 * name, or a dangling id returns null, and the caller falls back to restart
 * activation. CRLF-aware: a patch authored with Windows line endings must
 * not read as "contains config rows" (the Windows-patch regression their
 * hot.ts documents). Pure: string in, rows out.
 */
export function parseSimplePatch(patchText: string): HotRow[] | null {
  const lines = patchText.split(/\r?\n/)
  const rows: HotRow[] = []
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue
    const idMatch = ID_LINE_RE.exec(raw)
    if (idMatch === null) return null
    const id = idMatch[1]
    if (id === undefined) return null
    // The id line must be followed by exactly one name line (blank lines and
    // comments may sit between); anything else — a config row, another id,
    // the end of the text — is not a simple insert.
    let name: string | undefined
    while (i + 1 < lines.length) {
      i++
      const next = lines[i] ?? ''
      if (next === '' || next.trim().startsWith('#')) continue
      const nameMatch = NAME_LINE_RE.exec(next)
      if (nameMatch === null) return null
      const value = nameMatch[1]
      if (value === undefined) return null
      // An expression name (`!!js/expression ...`) is evaluated by the
      // loader at activation — not a plain row the hot tree can replicate.
      if (value.includes('!!js/expression')) return null
      name = value
      break
    }
    if (name === undefined) return null
    rows.push({ id, name })
  }
  return rows.length > 0 ? rows : null
}

/** Render the accepted rows with prefixed ids — the exact input file the
 * Include tree mounts. Only values the line scan accepted are emitted, and
 * the output is itself a simple patch (round-trips through
 * parseSimplePatch). */
function renderRows(rows: HotRow[], prefix: string): string {
  return rows.map(row => `- id: ${prefix}${row.id}\n  name: ${row.name}`).join('\n') + '\n'
}

/** The next free `hot-<n>` number: one past the highest existing file, or 1
 * when the directory does not exist yet (the write recreates it). */
function nextHotNumber(fs: HotFs, dir: string): number {
  let names: string[]
  try {
    names = fs.list(dir)
  } catch {
    // No namespace directory yet (first mount of the session) or it cannot
    // be read — either way numbering starts at 1; the write recreates it.
    return 1
  }
  let max = 0
  for (const name of names) {
    const match = HOT_FILE_RE.exec(name)
    if (match !== null && match[1] !== undefined) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return max + 1
}

/** Read the installed package's own `dsh` section to locate its bundle patch
 * (the Include input), or null when the package or the field is absent —
 * the "no patch file" rejection names this. */
function readPkgDsh(fs: HotFs, packageDir: string): { patch: string } | null {
  try {
    const pkg = JSON.parse(fs.read(join(packageDir, 'package.json'))) as
      { dsh?: { bundle?: { patch?: unknown } } }
    const patch = pkg.dsh?.bundle?.patch
    return typeof patch === 'string' ? { patch } : null
  } catch {
    // Unreadable or unparseable package.json, or no dsh.bundle.patch — the
    // same outcome: the hot tree has no input to mount.
    return null
  }
}

/** Load the Include class through a computed dynamic import, or null when
 * the optional peer is missing (an older harness — every path then falls
 * back to restart activation). */
async function loadHotTreeClass(): Promise<unknown> {
  const specifier = '@deepseek-ai/cordis-plugin-include'
  try {
    // The specifier is computed, so tsc never resolves the optional peer
    // (it is not a devDependency); the namespace is cast through unknown and
    // only the default export (the Include class) is extracted.
    const mod = (await import(specifier)) as unknown
    return (mod as { default: unknown }).default
  } catch {
    // Any failure — module absent, or the load rejected — means the harness
    // cannot hot-mount; null routes every call to the restart fallback.
    return null
  }
}

/** Wrap a tree class in a subclass that suppresses `write()` — the loader
 * otherwise persists tree changes back to the file it read. The hot file is
 * written once with the mkt- ids and must never be rewritten from live tree
 * state. */
function suppressWrite(treeClass: unknown): unknown {
  // The real Include class arrives dynamically, so the subclass is built on
  // a constructor-typed cast, never a static import of the optional peer.
  const Base = treeClass as new (ctx: unknown, config: unknown) => object
  return class HotTree extends Base {
    write(): void {}
  }
}

/**
 * Mount one installed package into the running composition through an
 * Include subtree: read its bundle patch, replicate the simple rows under
 * `mkt-` ids into `<profile>/.dsh-shop/hot-<n>.yml`, register the tree, and
 * race its activation against `timeoutMs`. Success returns `ok: true` with
 * no reason; any fallback returns `ok: false` with a bilingual reason
 * distinguishing "restart will fix it" (timeout, activation failure,
 * unavailable include) from "this package can never hot-mount" (no patch
 * file, or rows the hot tree cannot replicate). The plugin is installed in
 * the bundle layer either way, so a restart always activates it.
 */
export async function hotMount(
  ctx: HotContext,
  profileDir: string,
  packageName: string,
  deps: HotDeps = {},
): Promise<HotMountResult> {
  const {
    fs = nodeFs,
    dir = join(profileDir, HOT_DIR),
    timeoutMs = Number(process.env.DSH_SHOP_HOT_MOUNT_TIMEOUT_MS) || 10000,
    now = Date.now,
  } = deps

  // The installed package's own bundle patch is the mount source: locate it
  // through the package's dsh field (defaulting to the conventional name).
  const packageDir = join(profileDir, 'node_modules', packageName)
  const dsh = readPkgDsh(fs, packageDir)
  let patchText: string
  try {
    patchText = fs.read(join(packageDir, dsh?.patch ?? 'cordis.patch.yml'))
  } catch {
    ctx.logger?.warn(`hot-mount ${packageName}: no patch file to mount — restart will activate it`)
    return { ok: false, reason: NO_PATCH_REASON }
  }
  const rows = parseSimplePatch(patchText)
  if (rows === null) {
    ctx.logger?.warn(`hot-mount ${packageName}: patch has rows that cannot be hot-mounted — restart will activate it`)
    return { ok: false, reason: NOT_SIMPLE_REASON }
  }

  let treeClass = deps.hotTreeClass
  if (treeClass === undefined) treeClass = await loadHotTreeClass()
  if (treeClass === null) {
    ctx.logger?.warn(`hot-mount ${packageName}: the include plugin is unavailable in this harness — restart will activate it`)
    return { ok: false, reason: HOST_CANNOT_HOT_MOUNT_REASON }
  }

  const file = join(dir, `hot-${nextHotNumber(fs, dir)}.yml`)
  fs.write(file, renderRows(rows, 'mkt-'))

  let handle: PluginHandle
  try {
    // Building the subclass and registering it both happen inside the
    // fallback: an unconstructible tree class (a broken include export)
    // must degrade to restart activation, never throw.
    const HotTree = suppressWrite(treeClass)
    handle = ctx.plugin(HotTree, { path: pathToFileURL(file).href })
  } catch (error) {
    ctx.logger?.warn(`hot-mount ${packageName}: mounting the include tree failed — restart will activate it (${String(error)})`)
    return { ok: false, reason: MOUNT_FAILED_REASON }
  }

  // A package re-mounted this session (update): stop the old tree before the
  // new one activates — two live copies of one plugin would violate the
  // update sequencing rule (cordis rejects the second provision anyway; this
  // makes the ordering explicit). Registration precedes disposal on purpose:
  // a dispose-first order would leave a both-dead window if the new mount
  // then fails; this order accepts a brief both-registered window instead,
  // the old handle awaited before the new activation is raced.
  const previous = hotHandles.get(packageName)
  if (previous !== undefined) {
    try {
      await previous.dispose()
    } catch (error) {
      // Best-effort: an old tree that refuses to die is logged, and the new
      // activation either collides (fallback) or wins; a restart cleans up.
      ctx.logger?.warn(`hot-mount ${packageName}: the previous hot mount refused to dispose (${String(error)})`)
    }
    hotHandles.delete(packageName)
  }

  const outcome = await withTimeout(handle.await(), timeoutMs, now)
  if (outcome === 'settled') {
    hotHandles.set(packageName, handle)
    ctx.logger?.info(`hot-mounted ${packageName} (${file})`)
    return { ok: true, reason: null }
  }

  // Timeout or activation failure: the tree is up (partially or not at all)
  // and must not outlive the failed mount. Dispose is best-effort — the
  // bundle layer loads the plugin at next boot either way.
  try {
    await handle.dispose()
  } catch (error) {
    // A failed dispose must not mask the original outcome; the boot layer
    // cleans up whatever is left running.
    ctx.logger?.warn(`hot-mount ${packageName}: dispose after a failed mount also failed — a restart cleans up (${String(error)})`)
  }
  return { ok: false, reason: outcome === 'timeout' ? TIMEOUT_REASON : MOUNT_FAILED_REASON }
}

type MountOutcome = 'settled' | 'failed' | 'timeout'

/** Race the fiber's activation against the deadline. The remaining time is
 * measured on the injectable clock so tests can drive the timeout
 * deterministically; the timer is cleared when the activation wins. */
function withTimeout(
  activation: Promise<unknown>,
  timeoutMs: number,
  now: () => number,
): Promise<MountOutcome> {
  const deadline = now() + timeoutMs
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - now()))
  })
  return Promise.race([
    activation.then(() => 'settled' as const, () => 'failed' as const),
    timeout,
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * Dispose a package's hot mount. Returns false (without touching anything)
 * when the name is not mounted; the handle leaves the map before the
 * dispose so a mount can never be disposed twice, and a throwing dispose
 * propagates — the plugin may still be live in this session.
 */
export async function hotUnmount(packageName: string): Promise<boolean> {
  const handle = hotHandles.get(packageName)
  if (handle === undefined) return false
  hotHandles.delete(packageName)
  await handle.dispose()
  return true
}

/** The package names hot-mounted this session, in mount order. */
export function listHotMounts(): string[] {
  return [...hotHandles.keys()]
}

/** Wipe the session's mount inputs at host start: `hot-<n>.yml` files under
 * `<profile>/.dsh-shop/` only — anything else in the namespace directory is
 * left alone, and a missing directory is a no-op. */
export function cleanHotDir(profileDir: string): void {
  const dir = join(profileDir, HOT_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    // No namespace directory yet — nothing to wipe.
    return
  }
  for (const name of names) {
    if (HOT_FILE_RE.test(name)) rmSync(join(dir, name), { force: true })
  }
}
