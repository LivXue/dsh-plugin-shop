/**
 * The shop's own per-profile state: the plugins a reader starred, and the
 * version each installed plugin was updated from (design
 * 2026-11-02-market-borrowings §6–§7).
 *
 * One file, `<profile>/.dsh-shop/state.json`, beside the hot-mount inputs but
 * not among them: `cleanHotDir` wipes `hot-<n>.yml` only, so this survives a
 * boot. It is deliberately NOT part of the profile manifest: favorites are a
 * reading aid, and a `dsh plugin add` that rewrote `package.json` must never
 * be able to take them down.
 *
 * Every read is forgiving and every write is atomic. Losing this file costs a
 * reader their stars and one rollback offer; taking the page down over it
 * would be the worse bug, so a malformed file reads as empty state rather
 * than throwing. The next write replaces it with a valid one.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The filesystem this module needs, injected so tests never touch disk. The
 * production `write` is temp-then-rename: an interrupted write leaves the
 * previous state rather than half of a new one, the same pattern
 * `profile.ts` uses for the profile manifest. */
export interface ShopStateFs {
  read: (path: string) => string
  write: (path: string, data: string) => void
}

/**
 * How many times a rename is retried when Windows refuses it, and how long
 * between tries.
 *
 * Measured 2026-11-02 on Windows 11: `renameSync` over a target another
 * handle holds open throws `EPERM`, and so does one over a read-only target —
 * an antivirus scan, a backup agent or a second dsh on the same profile is
 * enough. Five tries at 20 ms covers a scanner's open/close window without
 * making a click wait on a wedged file.
 */
const RENAME_TRIES = 5
const RENAME_RETRY_MS = 20

/** The operations the writer needs, injected so the Windows-only retry can be
 * driven on any platform: `renameSync` over a held-open target throws `EPERM`
 * there and succeeds on POSIX, and every state test injects `memHotFs`, so the
 * production path had no coverage at all. */
export interface ShopStateIo {
  read: (path: string) => string
  mkdir: (path: string) => void
  writeFile: (path: string, data: string) => void
  rename: (from: string, to: string) => void
  remove: (path: string) => void
  wait: (ms: number) => void
  processId: number
}

function nodeShopStateIo(): ShopStateIo {
  return {
    read: path => readFileSync(path, 'utf8'),
    mkdir: path => { mkdirSync(path, { recursive: true }) },
    writeFile: (path, data) => { writeFileSync(path, data) },
    rename: (from, to) => { renameSync(from, to) },
    remove: path => { rmSync(path, { force: true }) },
    wait: ms => {
      const until = Date.now() + ms
      while (Date.now() < until) {
        // Spin. The wait is 20 ms and only on Windows' retry path.
      }
    },
    processId: process.pid,
  }
}

/**
 * A writer over `io`, temp-then-rename.
 *
 * The temp name carries the process id and a per-write counter: a fixed
 * `.tmp` gave two dsh processes on one profile the same scratch file.
 *
 * `rename` is retried on `EPERM`/`EBUSY`, which is what Windows reports when
 * another handle (an antivirus scan, a backup agent, a second dsh) holds the
 * target; measured 2026-11-02, a read-only target throws it too. Any other
 * code, or the last try, removes the scratch file and rethrows.
 */
export function shopStateFsFor(io: ShopStateIo): ShopStateFs {
  let counter = 0
  return {
    read: io.read,
    write: (path, data) => {
      io.mkdir(dirname(path))
      counter += 1
      const tmp = `${path}.${io.processId}.${counter}.tmp`
      io.writeFile(tmp, data)
      for (let attempt = 1; ; attempt += 1) {
        try {
          io.rename(tmp, path)
          return
        } catch (error) {
          const code = (error as { code?: unknown }).code
          const retryable = code === 'EPERM' || code === 'EBUSY'
          if (!retryable || attempt >= RENAME_TRIES) {
            try { io.remove(tmp) } catch { /* already gone, or unwritable: nothing left to tidy */ }
            throw error
          }
          io.wait(RENAME_RETRY_MS)
        }
      }
    },
  }
}

export const nodeShopStateFs: ShopStateFs = shopStateFsFor(nodeShopStateIo())

/**
 * What is known about one installed plugin's previous version, enough to
 * rebuild the exact install spec the shop would have used for it.
 *
 * `source`, `repo` and `subdir` are what the catalog said when the record was
 * written — the shop's own values, not the client's. A record whose shape is
 * not one of the two below is dropped on read: a rollback the shop cannot
 * spell is not offered.
 */
export interface ShopRollbackRecord {
  source: 'npm' | 'github'
  /** The installed plugin's package name. */
  name: string
  /** github only: `owner/slug`, exactly as the catalog wrote it. */
  repo?: string
  /** github only: the subpackage directory, when the entry installed one. */
  subdir?: string
  /** The version that was installed before the update: an npm version, or a
   * github commit (40 lowercase hex). */
  version: string
}

export interface ShopState {
  /** Install identities (`identityKey`) the reader starred. */
  favorites: string[]
  /** Install identity → the version it was updated from. */
  previous: Record<string, ShopRollbackRecord>
}

/**
 * A fresh empty state.
 *
 * A function, never a shared constant: both writers mutate what
 * `readShopState` returns, so handing every missing file the same object made
 * one profile's failed save visible to the next caller — and a test that
 * compared against the constant could not see it.
 */
export function emptyShopState(): ShopState {
  return { favorites: [], previous: {} }
}

/** A path walk cannot climb out of: identities and names are catalog or
 * manifest text, and the record is only ever used to build a spec. */
const KEY_MAX_LENGTH = 300

/** The longest version this file keeps. An npm version is bounded by 256
 * everywhere else in this codebase; a commit is 40. */
const VERSION_MAX_LENGTH = 256

const REPO_SHAPE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** Most favorites one file may hold. Far past any real shelf, and a bound
 * nonetheless: the file is the reader's, and a hand-edited one must not turn
 * every card render into a set lookup over a million rows. */
export const FAVORITES_MAX = 5_000

/** Most rollback records one file may hold — one per installed plugin. */
export const PREVIOUS_MAX = 2_000

export function statePath(profileDir: string): string {
  return join(profileDir, '.dsh-shop', 'state.json')
}

/** One install identity this file will store. */
function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= KEY_MAX_LENGTH
}

function isRollbackRecord(value: unknown): value is ShopRollbackRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.source !== 'npm' && record.source !== 'github') return false
  if (typeof record.name !== 'string' || record.name.length === 0 || record.name.length > KEY_MAX_LENGTH) return false
  if (typeof record.version !== 'string' || record.version.length === 0 || record.version.length > VERSION_MAX_LENGTH) return false
  if (record.repo !== undefined && (typeof record.repo !== 'string' || !REPO_SHAPE.test(record.repo))) return false
  if (record.subdir !== undefined && typeof record.subdir !== 'string') return false
  // A github record without its repository cannot be spelled back into a
  // spec, so it is not one this module wrote.
  if (record.source === 'github' && record.repo === undefined) return false
  return true
}

/**
 * The state file's contents, or empty state when it is missing, unreadable or
 * malformed.
 *
 * Each half is validated on its own, so a corrupt `previous` map never costs
 * the reader their favorites: the parts that parse are kept, the parts that
 * do not are dropped. That is the opposite of the catalog's rule — a catalog
 * this code did not write is a five-alarm fire, while this file is a reading
 * aid whose loss is measured in stars.
 */
export function readShopState(fs: ShopStateFs, profileDir: string): ShopState {
  let text: string
  try {
    text = fs.read(statePath(profileDir))
  } catch (error) {
    // ABSENT is empty state; a file that is there and could not be read is a
    // different answer, and it is thrown rather than swallowed: on Windows an
    // antivirus or a second dsh can make the read fail with EACCES/EBUSY, and
    // a caller that took that for "no state yet" would write the empty base
    // over an intact file — every star and every rollback record gone.
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
    return emptyShopState()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // A hand-edited or truncated file. Empty state, replaced on next write.
    return emptyShopState()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return emptyShopState()
  const document = parsed as { favorites?: unknown; previous?: unknown }

  const favorites: string[] = []
  if (Array.isArray(document.favorites)) {
    const seen = new Set<string>()
    for (const value of document.favorites) {
      if (!isKey(value) || seen.has(value)) continue
      seen.add(value)
      favorites.push(value)
      if (favorites.length === FAVORITES_MAX) break
    }
  }

  const previous: Record<string, ShopRollbackRecord> = {}
  if (typeof document.previous === 'object' && document.previous !== null && !Array.isArray(document.previous)) {
    let kept = 0
    for (const [key, value] of Object.entries(document.previous)) {
      if (kept === PREVIOUS_MAX) break
      if (!isKey(key) || !isRollbackRecord(value)) continue
      previous[key] = value
      kept += 1
    }
  }

  return { favorites, previous }
}

/** Write one state document, bounded and normalized. Throws on a write
 * failure: the caller decides what a lost favorite costs, and swallowing here
 * would report a save that did not happen. */
export function writeShopState(fs: ShopStateFs, profileDir: string, state: ShopState): void {
  const favorites = state.favorites.filter(isKey).slice(0, FAVORITES_MAX)
  const previous: Record<string, ShopRollbackRecord> = {}
  let kept = 0
  for (const [key, record] of Object.entries(state.previous)) {
    if (kept === PREVIOUS_MAX) break
    if (!isKey(key) || !isRollbackRecord(record)) continue
    previous[key] = record
    kept += 1
  }
  fs.write(statePath(profileDir), `${JSON.stringify({ favorites, previous }, null, 2)}\n`)
}

/**
 * The spec a rollback re-installs, built from a record this host wrote.
 *
 * Never from client input: the RPC takes only the identity, and everything
 * here comes from the file above. `undefined` for a record whose version is
 * not the shape its channel can install — a hand-edited record, or one
 * written by a future rule — because a spec the shop cannot spell is not
 * offered as a button.
 */
export function rollbackSpec(record: ShopRollbackRecord): string | undefined {
  if (record.source === 'npm') {
    // A plain version, never a range: `^1.2.3` would resolve to whatever the
    // registry serves today, which is the opposite of a rollback.
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(record.version)) return undefined
    return `${record.name}@${record.version}`
  }
  if (!/^[0-9a-f]{40}$/.test(record.version)) return undefined
  const subdir = record.subdir === undefined ? '' : `&path:${record.subdir}`
  return `github:${record.repo}#${record.version}${subdir}`
}
