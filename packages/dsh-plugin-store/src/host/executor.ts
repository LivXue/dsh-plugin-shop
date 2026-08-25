/** Install executor: spawn the dsh CLI, stream its output, serialize per profile. */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export type InstallState = 'running' | 'done' | 'failed'

export interface InstallStatus {
  state: InstallState
  log: string[]
  needsRestart?: boolean
  detail?: string
}

const MAX_LOG_LINES = 200
const MAX_LOG_BYTES = 64 * 1024

interface RunningInstall {
  installId: string
  status: () => InstallStatus
  finished: Promise<InstallStatus>
}

// One in-flight install per profile (§7.2: pnpm locks itself, but its
// concurrent-access errors are unreadable to a user).
const profileQueues = new Map<string, Promise<unknown>>()

function chain<T>(profile: string, task: () => Promise<T>): Promise<T> {
  const previous = profileQueues.get(profile) ?? Promise.resolve()
  const next = previous.then(task, task)
  profileQueues.set(profile, next.catch(() => {}))
  return next
}

/**
 * Run one `dsh plugin --profile <profile> add <spec>` and track it.
 * Never rolls back; a failure surfaces stderr verbatim plus the recovery hint
 * (§10). The store never passes build-script flags: `allowBuilds` stays the
 * user's explicit decision in the CLI (§7.2).
 */
export function startInstall(options: {
  profile: string
  spec: string
  dshBin?: string
  onStatus?: (status: InstallStatus) => void
}): RunningInstall {
  const { profile, spec, dshBin = 'dsh', onStatus } = options
  const installId = randomUUID()
  const log: string[] = []
  let logBytes = 0
  let state: InstallState = 'running'
  let detail: string | undefined

  const status = (): InstallStatus => ({
    state,
    log: [...log],
    ...(state === 'done' ? { needsRestart: true } : {}),
    ...(detail !== undefined ? { detail } : {}),
  })

  // Chunks are split into lines, and a trailing partial line (a chunk that
  // does not end in \n) is dropped; acceptable at v0, the log is
  // informational and the next chunk usually completes the line.
  const append = (line: string): void => {
    log.push(line)
    logBytes += line.length
    // Drop oldest until both caps hold; the newest line is never dropped,
    // even when a single pathological line alone exceeds the byte cap.
    while ((log.length > MAX_LOG_LINES || logBytes > MAX_LOG_BYTES) && log.length > 1) {
      const oldest = log.shift()
      if (oldest !== undefined) logBytes -= oldest.length
    }
    onStatus?.(status())
  }

  const finished = chain(profile, () => new Promise<InstallStatus>((resolve) => {
    const child = spawn(dshBin, ['plugin', '--profile', profile, 'add', spec], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line !== '') append(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line !== '') append(line)
    })
    child.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      state = 'failed'
      detail = code === 'ENOENT'
        ? 'dsh not found on PATH — install the dsh CLI to manage profile plugins'
        : `dsh spawn failed: ${error.message}`
      onStatus?.(status())
      resolve(status())
    })
    child.on('close', (exitCode) => {
      if (state !== 'running') return
      if (exitCode === 0) {
        state = 'done'
      } else {
        state = 'failed'
        const lastLogLine = log[log.length - 1] ?? ''
        detail = `pnpm failed in the profile. Run: dsh plugin --profile ${profile} install — ${lastLogLine}`
      }
      onStatus?.(status())
      resolve(status())
    })
  }))

  return { installId, status, finished }
}
