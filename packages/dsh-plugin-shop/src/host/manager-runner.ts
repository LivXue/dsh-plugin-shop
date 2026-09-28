/**
 * One package operation through dsh's `pluginManager` service, tracked as the
 * same `RunningInstall` the CLI executor produces: design
 * 2026-09-26-plugin-manager-delegation, section 6. It runs in the same
 * per-profile queue as CLI commands, so the two paths are never concurrent in
 * one profile.
 */
import {
  createBoundedLog, inProfileQueue, INSTALL_TIMEOUT_MS, lineSink, requestDownloadPhase,
  type InstallStatus, type LineSink, type RunningInstall,
} from './executor.ts'
import { readChange, thrownTail, type ManagerOutcome } from './plugin-manager.ts'
import type { Prefetcher } from './prefetch.ts'
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'

/** The first line of every record this runner writes. The shop's log panel
 * shows it and the 0.1.7 e2e asserts it, so a silent fall back to the CLI
 * fails a case instead of passing it. */
export const MECHANISM_PREFIX = "via dsh's plugin manager:"

/** Routes the service's `plugin-manager/install-log` chunks to the record
 * whose request id they carry. A chunk for any other id is dropped. dsh
 * tags each chunk with the stream it came from; a non-string stream reads
 * as `stdout`, matching a harness that predates the tag. */
export class ManagerLogs {
  private readonly sinks = new Map<string, (text: string, stream: string) => void>()

  open(requestId: string, sink: (text: string, stream: string) => void): () => void {
    this.sinks.set(requestId, sink)
    return () => { this.sinks.delete(requestId) }
  }

  chunk(requestId: unknown, text: unknown, stream?: unknown): void {
    if (typeof requestId !== 'string' || typeof text !== 'string') return
    this.sinks.get(requestId)?.(text, typeof stream === 'string' ? stream : 'stdout')
  }
}

export interface ManagerOperationOptions {
  profile: string
  /** The record's id, handed to the service as its request id. */
  requestId: string
  /** What the mechanism line says after the prefix, e.g. `install dsh-a@1.0.0`. */
  mechanism: string
  logs: ManagerLogs
  run: (requestId: string) => Promise<unknown>
  cancel?: (requestId: string) => Promise<unknown>
  outcome: (raw: unknown) => ManagerOutcome
  alsoConfirm?: () => string | null
  /** The download phase, as on the CLI path: `spec` is what it warms. */
  prefetcher?: Prefetcher
  spec?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  /** The desktop profile, whose readers can run no `dsh plugin` command: a
   * message the service call throws is scrubbed as dsh's answer is. */
  desktop?: boolean
}

/** What every value this cannot describe reads as. */
const UNREADABLE = 'an error with no readable message'

/** What a thrown value says about itself, and total: describing an error is
 * never itself the reason a settle fails. An `Error` gives its `message`,
 * anything else `String(value)`. A message that is not a string, or a
 * description that throws anywhere, reads as one fixed string: a Proxy whose
 * getPrototypeOf trap throws defeats `instanceof` itself, a `message` getter
 * can throw, and a null-prototype object has no conversion to a string. */
export const messageOf = (error: unknown): string => {
  try {
    const said: unknown = error instanceof Error ? error.message : String(error)
    if (typeof said === 'string') return said
  } catch {
    // Describing the value threw: the `instanceof` walk, the `message`
    // getter or `String`. The fixed string below says so, and nothing else
    // in this function can throw.
  }
  return UNREADABLE
}

export function startManagerOperation(options: ManagerOperationOptions): RunningInstall {
  const { profile, requestId, mechanism, logs, run, cancel, outcome, alsoConfirm, prefetcher, spec, env, desktop = false } = options
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
  const mechanismLine = `${MECHANISM_PREFIX} ${mechanism}`
  const log = createBoundedLog()
  let state: InstallState = 'running'
  let settled: ManagerOutcome | null = null
  let streamed = false

  // The mechanism line is kept outside the bounded buffer and prepended
  // here, never pushed through `append`: it is the one line the shop's log
  // panel and the 0.1.7 e2e require regardless of how long the record's own
  // log grows, and a long log is typical of exactly the failures worth
  // naming a mechanism for. A record may therefore carry one line over
  // MAX_LOG_LINES.
  const status = (): InstallStatus => ({
    state,
    log: [mechanismLine, ...log.lines()],
    ...(settled?.state === 'done' && settled.activation !== undefined ? { activation: settled.activation } : {}),
    ...(settled?.state === 'done' && settled.restartReason !== undefined ? { restartReason: settled.restartReason } : {}),
    ...(settled?.detail !== undefined ? { detail: settled.detail } : {}),
  })
  // Terminal, not "not running": a line from the download phase belongs in
  // the log, and only a settled record refuses more.
  const append = (line: string): void => {
    if (isTerminalInstallState(state)) return
    log.push(line)
  }
  // One assembler per stream, as the CLI capture keeps (`lineSink` per
  // stream in executor.ts): stdout and stderr chunks arrive interleaved,
  // and assembling them through a single sink would splice one stream's
  // partial line into the other's. dsh runs a request's pnpm jobs one
  // after another, so a stream key is enough; no job key is needed.
  const streams = new Map<string, LineSink>()
  const streamFor = (stream: string): LineSink => {
    let sink = streams.get(stream)
    if (sink === undefined) {
      sink = lineSink(append)
      streams.set(stream, sink)
    }
    return sink
  }
  const flushStreams = (): void => { for (const sink of streams.values()) sink.flush() }
  const close = logs.open(requestId, (text, stream) => {
    streamed = true
    streamFor(stream).write(Buffer.from(text, 'utf8'))
  })

  const queued = inProfileQueue(profile, async (): Promise<InstallStatus> => {
    state = 'running'
    let deadline: ReturnType<typeof setTimeout> | undefined
    if (cancel !== undefined) {
      deadline = setTimeout(() => {
        // `cancel` may itself throw synchronously, not just return a
        // rejected promise; deferring the call into a microtask turns that
        // throw into a rejection this `.catch` handles, never a raw
        // uncaughtException, which the executor treats as fatal to every
        // install in flight.
        Promise.resolve().then(() => cancel(requestId)).catch(() => {
          // A failed cancellation leaves the call running; its answer still
          // settles the record below, and nothing else waits on this promise.
        })
      }, timeoutMs)
    }
    let raw: unknown
    try {
      raw = await run(requestId)
    } catch (error) {
      // run() rejects for a lock/disposal error the service raises, or an
      // InvalidInstallSpecError validated up front; returning (not
      // rethrowing) settles the record and frees this profile's queue slot.
      // The message is dsh's text, so a desktop reader gets it scrubbed.
      flushStreams()
      settled = { state: 'failed', detail: `dsh-plugin-shop: dsh's plugin manager failed${thrownTail(messageOf(error), desktop)}` }
      state = 'failed'
      return status()
    } finally {
      clearTimeout(deadline)
    }
    let result: ManagerOutcome
    try {
      // Everything that reads the answer shares this one try: the success
      // flush, the streamed-fallback replay and `outcome` itself all fail
      // the same way, and any of them throwing must still settle the
      // record rather than leave it running forever.
      flushStreams()
      if (!streamed) {
        for (const line of readChange(raw).output.split(/\r?\n/)) if (line !== '') append(line)
      }
      result = outcome(raw)
    } catch (error) {
      settled = { state: 'failed', detail: `dsh-plugin-shop: the shop could not read dsh's answer: ${messageOf(error)}` }
      state = 'failed'
      return status()
    }
    if (result.state === 'done' && alsoConfirm !== undefined) {
      try {
        const objection = alsoConfirm()
        if (objection !== null) result = { state: 'failed', detail: objection }
      } catch (error) {
        // The shop's own post-install check threw (it cannot read the
        // package, say), not the answer itself being unreadable: a
        // distinct message, so a published reason is never misattributed.
        result = { state: 'failed', detail: `dsh-plugin-shop: the shop could not check what dsh installed: ${messageOf(error)}` }
      }
    }
    settled = result
    state = result.state
    return status()
  })

  // Only an operation with something ahead of it has anything to overlap
  // with, as on the CLI path (see `profileDepth` in executor.ts).
  const prefetch = queued.ahead > 0 && prefetcher !== undefined && spec !== undefined
    ? requestDownloadPhase({ prefetcher, profile, spec, env, log: append })
    : null
  if (prefetch?.started === true && !isTerminalInstallState(state)) state = 'downloading'

  const finished = queued.finished.finally(() => {
    close()
    if (prefetcher !== undefined && spec !== undefined) prefetcher.release(profile, spec)
  })
  void finished.catch(() => {
    // Every throw inside the queued task above is now caught there (the
    // run() rejection catch and the answer-reading catch), so this never
    // rejects; the handler only keeps a future throw from becoming an
    // unhandled rejection that would take the host down (the same guard as
    // spawnPluginCli's).
  })
  return { installId: requestId, status, finished }
}
