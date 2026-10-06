/**
 * The restart handoff's browser half (design §8), held by the page rather
 * than by the tab that confirmed the restart.
 *
 * It lived in a RestartPanel effect until 2026-09-27, and a self-update
 * killed it. dsh's client HMR (`@deepseek-ai/dsh-client-hmr`, mounted by the
 * web bundle unconditionally) stat-polls every client bundle and hot-swaps
 * one whose file changed; a self-update rewrites this package's own
 * `lib/client.js`, so the swap disposes the tab's fiber and mounts a fresh
 * instance of a freshly imported module. The effect's cleanup then stopped
 * the probe, and once the restart finished nothing reloaded the page: it sat
 * on the old process's answers while dsh's socket quietly reconnected to the
 * new one. Measured on dsh 0.1.5-rc.3 updating 0.8.2 to 0.8.3; with the
 * `/plugins/events` channel blocked the same flow reloaded.
 *
 * So the state sits on `globalThis` under a registry symbol — the one thing a
 * swapped-in module instance shares with the one it replaced — and the probe
 * loop is plain timers owned by no fiber. Any tab reads the state, so the
 * replacement renders the restart under way instead of offering another.
 *
 * The REQUEST is the page's too, since later the same day. On dsh
 * 0.1.5-rc.3 and 0.1.7-rc.2 alike a unary Remote call is an HTTP POST whose
 * fetch rides the calling mount's abort signal, and an answer that arrives after the mount went inactive is
 * rewritten to "no longer mounted" (dsh-api-gateway's client). A swap landing
 * inside the restart's round trip therefore left the tab that pressed with no
 * answer, whether or not the host had committed: measured with the request
 * held, the host never restarted; with the response held, it did, and the page
 * stayed on the old process showing the old version. So every module instance
 * registers its own path to the host here (the client half's apply), a confirm
 * records the request before anything is awaited, and a request whose path is
 * withdrawn mid-call is asked again through a live one. The host answers a
 * repeat with the restart it already committed.
 *
 * The VERDICT outlives the page, since 2026-10-06. The monitor reloads on
 * any origin that keeps answering, and a process that never exited answers
 * as steadily as one that replaced it: on macOS a confirmed restart reloaded
 * into the very process it had asked to go, and the row went on showing the
 * version before the update with nothing to say why. A commit therefore
 * records, in this tab's sessionStorage, which process committed it (its
 * boot identity and pid), and every version answer the reloaded page
 * receives is judged against that record (`noteBoot`).
 */

import type { ShopRestartResult } from '../host/index.ts'
import { INSTALL_POLL_MS, RESTART_GRACE_MS, restartMonitorVerdict } from './present.ts'

/** What this page is doing about a restart: waiting for the host to answer
 * the confirm, waiting for the new server once it committed, given up on
 * that server, or reloaded into the process that was asked to restart and
 * found it still answering — `pid` is that process. `logFile` is where the
 * host said the new process writes; a host older than that field sends
 * none, and one older than the boot identity sends no `pid` and is never
 * judged `not-restarted` at all. */
export type RestartMonitorState =
  | { kind: 'requesting' }
  | { kind: 'restarting'; logFile?: string }
  | { kind: 'failed'; logFile?: string }
  | { kind: 'not-restarted'; pid?: number; logFile?: string }

/** How one press ended, for the panel that made it: the page follows the
 * restart from here, the host refused it, or it never reached a host that
 * could answer. */
export type RestartRequestOutcome =
  | { kind: 'started' }
  | { kind: 'refused'; detail: string }
  | { kind: 'unreachable' }

/** One module instance's path to the host, live until that instance's mount
 * is torn down. */
interface Carrier {
  restart: () => Promise<ShopRestartResult>
  live: boolean
}

/** The request the page is waiting on the host for. */
interface Attempt {
  /** The path it rides now: the one first asked on, or the one that took
   * over when that was withdrawn. */
  carrier: Carrier
  reload: () => void
  /** Asked again since its first path was withdrawn. */
  reissued: boolean
  /** Every press waiting on it: the first, and any that joined it. */
  waiters: Array<(outcome: RestartRequestOutcome) => void>
}

interface MonitorStore {
  state: RestartMonitorState | null
  listeners: Set<() => void>
  /** Stops the running probe loop; null when none runs. */
  stop: (() => void) | null
  /** Every live module instance's path, newest last. */
  carriers: Carrier[]
  attempt: Attempt | null
}

/** A store as a build before the request moved here left it: 0.8.4-beta.0
 * created `{ state, listeners, stop }`, and the first update FROM that build
 * hands its store to this module. */
type StoredMonitor = Omit<MonitorStore, 'carriers' | 'attempt'> & Partial<Pick<MonitorStore, 'carriers' | 'attempt'>>

/** Registry symbol, so every module instance on the page finds the same store. */
const STORE_KEY = Symbol.for('dsh-plugin-shop.restart-monitor')

function monitorStore(): MonitorStore {
  const page = globalThis as unknown as Record<symbol, StoredMonitor | undefined>
  let stored = page[STORE_KEY]
  if (stored === undefined) {
    stored = { state: null, listeners: new Set(), stop: null }
    page[STORE_KEY] = stored
  }
  return Object.assign(stored, { carriers: stored.carriers ?? [], attempt: stored.attempt ?? null })
}

function settle(store: MonitorStore, state: RestartMonitorState | null): void {
  store.state = state
  for (const listener of [...store.listeners]) listener()
}

/** sessionStorage key of the restart this tab last saw committed. Not the
 * page store: the verdict belongs to the page the reload produces, and a
 * reload clears `globalThis`. Not localStorage: it is this tab's restart, and
 * another tab never asked for it. */
const RECORD_KEY = 'dsh-plugin-shop.restart'

/** Which process committed the restart, and what the notice names if that
 * process is still the one answering after the reload. */
interface RestartRecord {
  bootId: string
  pid?: number
  logFile?: string
}

function writeRecord(record: RestartRecord): void {
  try {
    globalThis.sessionStorage.setItem(RECORD_KEY, JSON.stringify(record))
  } catch {
    // Storage blocked for the origin, full, or absent outside a browser: the
    // restart goes ahead, and only the verdict after its reload is lost.
  }
}

/** The record, or null when there is none this module could have written.
 * Every plugin on the origin shares the tab's sessionStorage, and the pid is
 * rendered into a command the reader is told to run, so each field is
 * checked again on the way back in. */
function readRecord(): RestartRecord | null {
  let raw: string | null
  try {
    raw = globalThis.sessionStorage.getItem(RECORD_KEY)
  } catch {
    // Storage that refuses a read refused the write too: no record exists.
    return null
  }
  if (raw === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Not JSON, so not a record this module wrote.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { bootId, pid, logFile } = parsed as Record<string, unknown>
  if (typeof bootId !== 'string') return null
  return {
    bootId,
    ...(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(typeof logFile === 'string' ? { logFile } : {}),
  }
}

function forgetRecord(): void {
  try {
    globalThis.sessionStorage.removeItem(RECORD_KEY)
  } catch {
    // Storage that refuses access holds no record to forget.
  }
}

/** The page's restart, or null when it has committed none. The same object
 * until the state changes, as `useSyncExternalStore` requires. */
export function readRestartMonitor(): RestartMonitorState | null {
  return monitorStore().state
}

/** Be told when the page's restart changes state. */
export function subscribeRestartMonitor(listener: () => void): () => void {
  const store = monitorStore()
  store.listeners.add(listener)
  return () => { store.listeners.delete(listener) }
}

/**
 * Watch the origin for the restarted server and reload into it: probe once
 * the grace period is over (the host exits within it, so an answer is the NEW
 * server), and reload only after it has KEPT answering for the stable window.
 * A boot that is about to fail can bind the port and answer before its plugin
 * tree is audited and it exits; reloading on that one answer left the reader
 * on a blank page instead of the notice naming the log (design
 * 2026-09-26-market-borrowings §3). `restartMonitorVerdict` decides; this
 * loop only probes. Probes never overlap: each is scheduled one poll interval
 * after the previous one settled.
 *
 * A restart already being watched is left alone — every offer on the page
 * renders this state, so a second press can only come from a panel that has
 * not re-rendered yet, and a second loop would probe the same origin twice.
 */
export function startRestartMonitor(options: { reload: () => void; logFile?: string; bootId?: string; pid?: number }): void {
  const store = monitorStore()
  if (store.state?.kind === 'restarting') return
  store.stop?.()
  const { reload, logFile, bootId, pid } = options
  // For the page the reload produces, which judges this restart by the
  // process that answers it (`noteBoot`).
  if (bootId !== undefined) {
    writeRecord({ bootId, ...(pid === undefined ? {} : { pid }), ...(logFile === undefined ? {} : { logFile }) })
  }
  const started = Date.now()
  let stableSince: number | null = null
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const probe = async (): Promise<void> => {
    if (Date.now() - started >= RESTART_GRACE_MS) {
      let up = false
      try {
        // A fetch resolves on ANY status, and a proxy's 502 is not dsh
        // answering: only a 2xx counts.
        up = (await fetch(globalThis.location.href, { cache: 'no-store' })).ok
      } catch {
        // Refused or reset: the new server is not up — yet, or any more.
      }
      if (stopped) return
      const elapsed = Date.now() - started
      stableSince = up ? (stableSince ?? elapsed) : null
      const verdict = restartMonitorVerdict({ elapsedMs: elapsed, stableSinceMs: stableSince })
      if (verdict === 'reload') {
        store.stop = null
        reload()
        return
      }
      if (verdict === 'failed') {
        store.stop = null
        settle(store, logFile === undefined ? { kind: 'failed' } : { kind: 'failed', logFile })
        return
      }
    }
    timer = setTimeout(() => { void probe() }, INSTALL_POLL_MS)
  }
  store.stop = () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
  }
  timer = setTimeout(() => { void probe() }, INSTALL_POLL_MS)
  settle(store, logFile === undefined ? { kind: 'restarting' } : { kind: 'restarting', logFile })
}

/**
 * Register one module instance's path to the host; the client half's apply
 * does, with the `restart` it hands the tab. The returned function withdraws
 * it, and has to run BEFORE the mount it rides is disposed: a request still in
 * flight on it is then asked again through the newest live path — at once if
 * one is registered, or as soon as one is — rather than waiting on a call the
 * dispose is about to abort.
 */
export function registerRestartCarrier(restart: () => Promise<ShopRestartResult>): () => void {
  const store = monitorStore()
  const carrier: Carrier = { restart, live: true }
  store.carriers.push(carrier)
  const attempt = store.attempt
  if (attempt !== null && !attempt.carrier.live) ask(store, attempt, carrier)
  return () => {
    if (!carrier.live) return
    carrier.live = false
    const current = monitorStore()
    current.carriers = current.carriers.filter(each => each !== carrier)
    const orphaned = current.attempt
    const next = current.carriers.at(-1)
    if (orphaned !== null && orphaned.carrier === carrier && next !== undefined) ask(current, orphaned, next)
  }
}

/**
 * Ask the host to restart, for the page (design §8). The request is the
 * page's from the confirm on, not from the answer: every offer renders it as
 * under way, and a second press joins it rather than asking twice. It rides
 * the newest path a module instance registered, or — where no client half
 * registered one — the pressing tab's own `restart`.
 *
 * Resolves, never rejects, with what the press should show. A commit starts
 * the monitor and is `started`. A refusal and an unreachable host leave
 * nothing under way. A path withdrawn mid-call decides nothing but a commit;
 * the ask on the path that replaced it decides the rest, and that ask
 * finding no host is followed as a restart, since the first ask may have
 * committed and taken its host down with it.
 */
export function requestRestart(options: { reload: () => void; restart: () => Promise<ShopRestartResult> }): Promise<RestartRequestOutcome> {
  const store = monitorStore()
  if (store.state?.kind === 'restarting') return Promise.resolve({ kind: 'started' })
  return new Promise(resolve => {
    const pending = store.attempt
    if (pending !== null) {
      pending.waiters.push(resolve)
      return
    }
    const carrier = store.carriers.at(-1) ?? { restart: options.restart, live: true }
    const attempt: Attempt = { carrier, reload: options.reload, reissued: false, waiters: [resolve] }
    store.attempt = attempt
    settle(store, { kind: 'requesting' })
    ask(store, attempt, carrier)
  })
}

/** Carry the request on one path. Its answer decides only while the request
 * is still the page's and that path still carries it — a commit excepted. */
function ask(store: MonitorStore, attempt: Attempt, carrier: Carrier): void {
  if (attempt.carrier !== carrier) {
    attempt.carrier = carrier
    attempt.reissued = true
  }
  // Called now, not a tick later: the async wrapper only turns a synchronous
  // throw into the rejection every path's failure already is.
  void (async () => carrier.restart())().then(
    result => {
      if (store.attempt !== attempt) return
      if (result.ok) {
        // A commit is the truth about the host however late it arrives, even
        // on a path the request has since left.
        finish(store, attempt, { kind: 'started' })
        startRestartMonitor({
          reload: attempt.reload,
          ...(typeof result.logFile === 'string' ? { logFile: result.logFile } : {}),
          ...(typeof result.bootId === 'string' ? { bootId: result.bootId } : {}),
          ...(typeof result.pid === 'number' ? { pid: result.pid } : {}),
        })
        return
      }
      if (superseded(attempt, carrier)) return
      finish(store, attempt, { kind: 'refused', detail: result.detail })
      settle(store, null)
    },
    () => {
      if (store.attempt !== attempt || superseded(attempt, carrier)) return
      if (attempt.reissued) {
        finish(store, attempt, { kind: 'started' })
        startRestartMonitor({ reload: attempt.reload })
        return
      }
      finish(store, attempt, { kind: 'unreachable' })
      settle(store, null)
    },
  )
}

/** Whether a path's answer is one the request has moved past: the path was
 * withdrawn, so the dispose aborted it or the ask that replaced it decides. */
function superseded(attempt: Attempt, carrier: Carrier): boolean {
  return !carrier.live || attempt.carrier !== carrier
}

function finish(store: MonitorStore, attempt: Attempt, outcome: RestartRequestOutcome): void {
  store.attempt = null
  for (const waiter of attempt.waiters) waiter(outcome)
}

/**
 * Judge this tab's last committed restart by the process answering now. The
 * client half hands every `version()` answer here (index.ts), so the verdict
 * is made on the first answer a reloaded page receives, before any tab opens.
 *
 * The same boot as the one that committed is a restart that never happened:
 * the page says so, naming that process, for as long as it keeps answering
 * — across reloads too, since the record stays. Any other answer, an older
 * host's included, is a process that replaced it, and the record is spent.
 * Nothing is judged while this page's own restart is under way: the process
 * that committed answers until it exits, two seconds later.
 */
export function noteBoot(bootId: string | undefined): void {
  const store = monitorStore()
  if (store.state?.kind === 'requesting' || store.state?.kind === 'restarting') return
  const record = readRecord()
  if (record === null) return
  if (record.bootId === bootId) {
    if (store.state?.kind !== 'not-restarted') {
      settle(store, {
        kind: 'not-restarted',
        ...(record.pid === undefined ? {} : { pid: record.pid }),
        ...(record.logFile === undefined ? {} : { logFile: record.logFile }),
      })
    }
    return
  }
  forgetRecord()
  if (store.state?.kind === 'not-restarted') settle(store, null)
}

/** Stop the probe loop and forget the page's restart, its request, every
 * registered path and the tab's record of its last commit. Nothing in the
 * page calls this — a committed restart ends in a reload or a failure — so
 * its caller is a test isolating one case from the next. */
export function resetRestartMonitor(): void {
  const store = monitorStore()
  store.stop?.()
  store.stop = null
  for (const carrier of store.carriers) carrier.live = false
  store.carriers = []
  store.attempt = null
  forgetRecord()
  settle(store, null)
}
