/**
 * One package operation through dsh's `pluginManager` service, tracked as the
 * same `RunningInstall` the CLI executor produces: design
 * 2026-09-26-plugin-manager-delegation, section 6. It runs in the same
 * per-profile queue as CLI commands, so the two paths are never concurrent in
 * one profile.
 */
import {
  createBoundedLog, inProfileQueue, INSTALL_TIMEOUT_MS, lineSink, requestDownloadPhase,
  type InstallStatus, type RunningInstall,
} from './executor.ts'
import { readChange, type ManagerOutcome } from './plugin-manager.ts'
import type { Prefetcher } from './prefetch.ts'
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'

/** The first line of every record this runner writes. The shop's log panel
 * shows it and the 0.1.7 e2e asserts it, so a silent fall back to the CLI
 * fails a case instead of passing it. */
export const MECHANISM_PREFIX = "via dsh's plugin manager:"

/** Routes the service's `plugin-manager/install-log` chunks to the record
 * whose request id they carry. A chunk for any other id is dropped. */
export class ManagerLogs {
  private readonly sinks = new Map<string, (text: string) => void>()

  open(requestId: string, sink: (text: string) => void): () => void {
    this.sinks.set(requestId, sink)
    return () => { this.sinks.delete(requestId) }
  }

  chunk(requestId: unknown, text: unknown): void {
    if (typeof requestId !== 'string' || typeof text !== 'string') return
    this.sinks.get(requestId)?.(text)
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
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function startManagerOperation(options: ManagerOperationOptions): RunningInstall {
  const { profile, requestId, mechanism, logs, run, cancel, outcome, alsoConfirm, prefetcher, spec, env } = options
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
  const log = createBoundedLog()
  let state: InstallState = 'running'
  let settled: ManagerOutcome | null = null
  let streamed = false

  const status = (): InstallStatus => ({
    state,
    log: log.lines(),
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
  append(`${MECHANISM_PREFIX} ${mechanism}`)
  // The assembler the CLI capture uses: a line split across chunks reads as
  // one, and CRLF ends a line.
  const lines = lineSink(append)
  const close = logs.open(requestId, text => {
    streamed = true
    lines.write(Buffer.from(text, 'utf8'))
  })

  const queued = inProfileQueue(profile, async (): Promise<InstallStatus> => {
    state = 'running'
    let deadline: ReturnType<typeof setTimeout> | undefined
    if (cancel !== undefined) {
      deadline = setTimeout(() => {
        cancel(requestId).catch(() => {
          // A failed cancellation leaves the call running; its answer still
          // settles the record below, and nothing else waits on this promise.
        })
      }, timeoutMs)
    }
    let raw: unknown
    try {
      raw = await run(requestId)
    } catch (error) {
      lines.flush()
      settled = { state: 'failed', detail: `dsh-plugin-shop: dsh's plugin manager failed: ${messageOf(error)}` }
      state = 'failed'
      return status()
    } finally {
      clearTimeout(deadline)
    }
    lines.flush()
    if (!streamed) {
      for (const line of readChange(raw).output.split(/\r?\n/)) if (line !== '') append(line)
    }
    let result: ManagerOutcome
    try {
      result = outcome(raw)
      if (result.state === 'done' && alsoConfirm !== undefined) {
        const objection = alsoConfirm()
        if (objection !== null) result = { state: 'failed', detail: objection }
      }
    } catch (error) {
      // The shop's own reading of the answer threw (a post-install check that
      // cannot read the package, say). The record must still settle: a record
      // left running holds the profile's queue and the client's poll forever.
      result = { state: 'failed', detail: `dsh-plugin-shop: the shop could not check what dsh installed: ${messageOf(error)}` }
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
    // The task catches its own failures, so this never rejects today; the
    // handler keeps a future throw from becoming an unhandled rejection that
    // would take the host down (the same guard as spawnPluginCli's).
  })
  return { installId: requestId, status, finished }
}
