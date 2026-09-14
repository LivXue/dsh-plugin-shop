/**
 * The download phase that runs in front of the per-profile install mutex.
 *
 * `dsh plugin add` is one opaque call: it resolves, fetches, links and writes
 * in a single pnpm invocation, so the shop cannot split it. What it can do is
 * warm pnpm's content store first, from outside the mutex, so the serialized
 * install is a store hit. Measured 2026-09-10: an npm or github spec warmed
 * this way installs with `downloaded 0`. Design doc §3.
 *
 * Best-effort by construction. Every failure here — pnpm absent, a non-zero
 * batch, a timeout, a store guessed wrong — leaves `dsh plugin add` to fetch
 * what the store lacks, exactly as it does today. Nothing about whether an
 * install SUCCEEDS may depend on this module.
 */

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, posix, win32 } from 'node:path'
import { jsEntryCommand } from './dsh-cli.ts'
import { killTree, shellSafeTarget, type KillFns } from './executor.ts'

/** How long one batch may run before it is killed. Far below
 * `INSTALL_TIMEOUT_MS`: a batch still running after this is no longer hiding
 * any latency, and the install behind it simply proceeds cold. */
const BATCH_TIMEOUT_MS = Number(process.env.DSH_SHOP_PREFETCH_TIMEOUT_MS) || 90 * 1000

/**
 * Whether warming the store for `spec` can save the install any work.
 *
 * A raw https tarball URL cannot, measured twice on 2026-09-10: pnpm
 * re-fetches such a URL on EVERY install even when the store already holds
 * that exact tarball — it must read the `package.json` inside it and that
 * read does not go through the store — and `pnpm store add` on a URL resolves
 * no dependency closure. So a prefetch of that form is one extra full
 * download for no measured saving. The three spec forms are indistinguishable
 * at the `store add` boundary (all exit 0, all print `+ <spec>`), which is why
 * this exclusion is recorded rather than left to look like an oversight.
 * Design doc §3.
 */
export function isPrefetchableSpec(spec: string): boolean {
  return !/^https?:\/\//i.test(spec)
}

/** Why no download phase happened, when one did not. The caller writes the
 * line a user reads, so it needs the reason and not a bare `false`. */
export type PrefetchRequest =
  | { started: true }
  | { started: false; reason: 'unsupported-spec' | 'no-pnpm' }

export interface Prefetcher {
  /** Queue `spec` for this profile's next batch, starting one if none runs.
   * `log` receives the outcome of whichever batch ends up carrying this spec —
   * one batch serves several installs, so a batch's exit is reported to each
   * of them. */
  request: (args: {
    profile: string
    spec: string
    cwd: string
    env?: NodeJS.ProcessEnv
    log?: (line: string) => void
  }) => PrefetchRequest
  /** This spec's install has settled. Kills the batch when nothing else needs it. */
  release: (profile: string, spec: string) => void
}

type Log = (line: string) => void

/** The one call this module makes on `spawn`: the argv form, whose child
 * carries the `error`/`exit` listeners `start` needs. `typeof nodeSpawn` is an
 * overload set that also admits two-argument forms this module never builds a
 * command line for, and a test's recording wrapper cannot satisfy those — so
 * the seam is named, and a caller still passes `spawn` itself. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

interface Lane {
  /** Spec → the log of the install waiting on it, for specs not yet sent. */
  pending: Map<string, Log>
  /** The same, for the specs the running batch carries. */
  inFlight: Map<string, Log>
  child: ChildProcess | null
  timer: NodeJS.Timeout | null
  /** The profile directory. It decides which store pnpm picks, so it is
   * carried per lane rather than per batch — every install into one profile
   * resolves to the same directory. */
  cwd: string
  env: NodeJS.ProcessEnv | undefined
}

/**
 * `cmd.exe`'s exit code for a command line it could not resolve — the Windows
 * answer to the ENOENT node never sends there.
 *
 * On the one platform where this module passes `shell: true`, the child node
 * starts is `cmd.exe`, which EXISTS: the spawn succeeds, its "not recognized
 * as an internal or external command" complaint goes to a stderr this module
 * discards, and no `error` event ever arrives. The ENOENT latch below is
 * therefore dead on Windows by construction. Measured 2026-09-14 on this
 * Linux box, whose shell answers 127 instead of 9009 but is otherwise the same
 * shape: `spawn('definitely-not-here', argv, { shell: true })` emits only
 * `exit`, while the identical spawn without the shell emits `error: ENOENT`.
 * PR #45's `windows` job is the half that cannot run here — it is where the
 * missing latch showed up, as the case "reports pnpm absent to the install it
 * was serving, and refuses the next by name" sitting red for the full 10s of
 * its `vi.waitFor` because the line it filters for was never announced.
 *
 * **That arm did not turn the leg green, and this is why.** A temporary
 * diagnostic, gated on `shell` so only the Windows runner printed it, came
 * back with four exits, in test-file order:
 *
 *   exit code=1     bin="…\dsh-prefetch-*\definitely-not-here"
 *   exit code=9009  bin="pnpm"
 *   exit code=1     bin="pnpm"
 *   exit code=0     bin="pnpm"
 *
 * The first line is the failing case's own bin, and it is the whole finding:
 * that case passes a PATH, `cmd.exe` answers **1** for a path it cannot find,
 * and 1 is also what a command that RAN and failed answers. The two things
 * this latch must tell apart are the same number, so no value of this
 * constant could have made the arm fire — it was gated on a signal that case
 * does not produce. (The 9009 line is not evidence for the constant either.
 * It is the second shell-gated exit the suite emits, and the only real
 * `cmd.exe` child started before it is the one above: the cases that pass a
 * bare `pnpm` inject a scripted child that emits its own code — this file's
 * `scriptedSpawn` — so 9009 there is a fixture value echoed back, not a
 * measurement of the shell.)
 *
 * Absence is therefore asked BEFORE the spawn now, by {@link resolvesBin},
 * which is the primary mechanism. This arm stays as the one thing resolving
 * cannot cover: a name that IS found and still cannot be run. Its number is
 * `cmd.exe`'s long-standing answer for an unresolvable name and is unverified
 * by this repo's own runs — nothing reaches it without `platform === 'win32'`,
 * and nothing on the Windows runner has produced one. Should it be wrong the
 * behaviour is what Windows had before the arm existed: the latch does not set
 * and the generic exit line stands. A false positive is bounded by this
 * module's own contract — the worst a stray 9009 can do is refuse the rest of
 * the process's prefetches, a lost optimization and never a failed, slower or
 * altered install.
 */
const SHELL_COMMAND_NOT_FOUND = 9009

/** What a bare name may be resolved AS on Windows, on top of the name itself.
 *
 * `cmd.exe` resolves a bare command through `PATHEXT`, and these are the two
 * shapes an executor actually arrives in: `.cmd` is what npm's pnpm shim is,
 * which is the reason this module passes `shell: true` there at all, and
 * `.exe` is what a native install (a packed binary, a Node SEA) puts on PATH.
 * The bare name is tried as well, which makes this a superset of what the
 * shell resolves. That asymmetry is deliberate, because the two mistakes do
 * not cost the same: a false PRESENT spends one doomed child, which
 * {@link SHELL_COMMAND_NOT_FOUND} or `error` then latches a moment later,
 * while a false ABSENT both disables the optimization for the rest of the
 * process and tells the user pnpm is missing from a machine that has it. */
const WIN32_SUFFIXES = ['', '.cmd', '.exe'] as const

/**
 * Every plausible reading of a PATH string, as the directories it could hold.
 *
 * Three readings, because the two ends of that string disagree about who
 * decides the separator. `platform` says what the SHELL is — this module takes
 * it as an argument, and the tests drive the win32 branch from a Linux runner
 * with it — while the string itself was produced by the HOST that built the
 * batch's environment. So whichever separator `platform` names, the string may
 * have been joined with the other one, and BOTH mismatches are reachable; only
 * one of them was guarded.
 *
 * The one that bit: a single-entry PATH whose entry is a Windows absolute path
 * — `C:\Users\…\dsh-prefetch-X`, which is exactly what a test's temp directory
 * is on the Windows runner — read with `platform: 'linux'` splits on ':' into
 * `C` and `\Users\…`. Neither is the directory, so the pnpm that was right
 * there was reported absent, and the latch that follows means it stays absent
 * for the rest of the process. The string's own reading comes first for that
 * shape: it IS one directory, and that is the most direct true answer there
 * is. (A real PATH yields its real entries under one of the two splits; this
 * reading costs a stat on a string that is not a directory, which is what a
 * multi-entry PATH always is.)
 *
 * Trying all three costs an `existsSync` or two on a string none of them
 * resolves, and it is the safe direction to err in — see `WIN32_SUFFIXES`: a
 * false PRESENT spends one doomed child, while a false ABSENT both disables
 * the optimization for the rest of the process and tells the user pnpm is
 * missing from a machine that has it. The price is that a directory named
 * exactly like a PATH string — legal, if perverse — is read as the entry it
 * spells, and that lands on the cheap side of the same asymmetry.
 *
 * Order decides only how much work a MISS costs: a hit in any reading is
 * present, so the list is a set and not a preference.
 */
const pathReadings = (path: string | undefined): string[] => {
  const raw = path ?? ''
  // Both delimiters, named rather than spelled. Neither is `path.delimiter`,
  // which is the HOST's and would still be a bet: the string may have been
  // joined somewhere other than where this code runs.
  return [raw, ...raw.split(posix.delimiter), ...raw.split(win32.delimiter)]
}

/**
 * Whether `bin` names something a batch could actually start — asked of the
 * filesystem before the spawn, because on Windows the failure cannot answer it
 * (see {@link SHELL_COMMAND_NOT_FOUND}: a path that is not there and a command
 * that ran and failed both exit 1).
 *
 * Pure path arithmetic over `existsSync`, which is what makes it testable on
 * the Linux runners — the exit-code route was not, and that is why the Windows
 * leg was the only place the defect could appear. No process is started to ask
 * the question, so a bin that is not there is never spawned.
 *
 * `path` is the batch's OWN PATH, not the shop's: an install may carry a
 * narrowed environment, the batch inherits exactly that, and the name has to
 * resolve where the child will look for it. An absent `PATH` falls back to the
 * process's, the same way the child's environment would. The string is read
 * into entries by {@link pathReadings}, which tries every separator rather
 * than betting on the one `platform` names.
 *
 * An empty PATH entry is skipped, as `dsh-cli.ts` skips it: it means "the
 * current directory", which is not where a bare `pnpm` lives, and a relative
 * `existsSync` here would be answering about the shop's cwd instead.
 *
 * A RELATIVE bin is looked up against the process's own cwd rather than the
 * batch's, which is the one thing this questions less precisely than the OS
 * will. No caller produces one today — production passes the bare name, and
 * the fixtures pass absolute paths — and the backstop covers it if one ever
 * does, since the child then simply fails where this said it would start.
 */
const resolvesBin = (bin: string, platform: NodeJS.Platform, path: string | undefined): boolean => {
  // A separator makes it a path, and a path names one exact file: a caller
  // pinning a pnpm installation has already decided which one, so "present" is
  // "that file is there". Both separators on every platform, because
  // `platform` says what the SHELL is, not what the string means — a Windows
  // path reaching a POSIX run is still a path, and searching PATH for it could
  // only ever be wrong.
  if (bin.includes('/') || bin.includes('\\')) return existsSync(bin)
  const win32Host = platform === 'win32'
  // Off Windows an executor is the file itself or nothing: `execvp` appends no
  // extension.
  const suffixes: readonly string[] = win32Host ? WIN32_SUFFIXES : ['']
  for (const dir of pathReadings(path)) {
    if (dir === '') continue
    for (const suffix of suffixes) {
      if (existsSync(join(dir, bin + suffix))) return true
    }
  }
  return false
}

export function createPrefetcher(options: {
  pnpmBin?: string
  spawn?: SpawnFn
  platform?: NodeJS.Platform
  execPath?: string
  timeoutMs?: number
  kills?: KillFns
} = {}): Prefetcher {
  const {
    pnpmBin = 'pnpm',
    spawn = nodeSpawn,
    platform = process.platform,
    execPath = process.execPath,
    timeoutMs = BATCH_TIMEOUT_MS,
    kills,
  } = options
  const lanes = new Map<string, Lane>()
  let pnpmAbsent = false

  const lane = (profile: string, cwd: string, env: NodeJS.ProcessEnv | undefined): Lane => {
    const existing = lanes.get(profile)
    if (existing !== undefined) {
      existing.cwd = cwd
      existing.env = env
      return existing
    }
    const created: Lane = {
      pending: new Map(), inFlight: new Map(), child: null, timer: null, cwd, env,
    }
    lanes.set(profile, created)
    return created
  }

  /** Tell every install the running batch served. */
  const announce = (current: Lane, line: string): void => {
    for (const log of current.inFlight.values()) log(line)
  }

  /** pnpm is not on PATH: stop prefetching for the rest of this process, and
   * tell the installs the running batch served why.
   *
   * Three ways absence arrives land here — {@link resolvesBin}, which is the
   * primary one and the only one that asks before spawning; node's ENOENT for
   * a binary it could not start; and cmd.exe's {@link SHELL_COMMAND_NOT_FOUND}
   * for a name it could not resolve — so the latch and the line a user reads
   * cannot drift apart between them. */
  const latchAbsent = (current: Lane): void => {
    pnpmAbsent = true
    announce(current, 'dsh-plugin-shop: no download phase — pnpm not found on PATH')
  }

  const finish = (profile: string, current: Lane): void => {
    if (current.timer !== null) clearTimeout(current.timer)
    current.timer = null
    current.child = null
    current.inFlight.clear()
    if (current.pending.size > 0 && !pnpmAbsent) start(profile, current)
  }

  const start = (profile: string, current: Lane): void => {
    const specs = [...current.pending.keys()]
    for (const [spec, log] of current.pending) current.inFlight.set(spec, log)
    current.pending.clear()
    // Absence, asked rather than inferred. Both signals a child can give are
    // unreadable on Windows — a missing path and a failure that ran are the
    // same exit 1 — so the one question that decides it is put to the
    // filesystem while the batch is still nothing but a set of specs. The
    // specs are in `inFlight` by this point, so `latchAbsent` announces to
    // exactly the installs this batch would have served, and `finish` finds a
    // lane with nothing pending: no second batch, and no child that was only
    // ever going to fail.
    //
    // Probed per batch rather than once per process, which costs a few
    // `existsSync` calls: pnpm installed (or removed) while the host runs is
    // then answered by the next batch instead of by a latch that outlives the
    // fact. `pnpmAbsent` still short-circuits `request`, so a latched pump
    // never reaches here again.
    if (!resolvesBin(pnpmBin, platform, current.env?.PATH ?? process.env.PATH)) {
      latchAbsent(current)
      finish(profile, current)
      return
    }
    const argv = ['store', 'add', ...specs]
    // pnpm on Windows is a `.cmd` shim, and node has refused `.cmd` without a
    // shell since the 2024 batfile fix; dsh's own answer for the same problem
    // is `shell: true`, and the quoting below is what that shell makes
    // necessary. Under a shell node does not escape argv — it joins the array
    // into ONE cmd.exe command line — and `&`, which `executor.ts`'s
    // UNSAFE_TARGET deliberately lets through for the legitimate
    // `&#path:<subdir>` monorepo form, is a cmd separator. Unquoted, a
    // `github:owner/slug#<sha>&path:<subdir>` spec reaches pnpm as the
    // repository ROOT and warms that instead — silently, because the
    // `&path:...` tail happens to be a cmd builtin that succeeds and prints
    // nothing — while a spec shaped `evil&<command-on-PATH>` runs that command
    // instead of the batch. So each spec gets the same quoting
    // `executor.ts` applies to its own operand, under exactly the condition
    // that creates the shell: off Windows, and for a JS entry routed through
    // node, argv reaches the child verbatim and a quote would be a literal
    // character in the spec.
    //
    // The design doc's §Windows asks for exactly this: "the existing
    // UNSAFE_TARGET gate and shellSafeTarget() … apply unchanged and must be
    // applied here too".
    //
    // What makes that quote safe is UNSAFE_TARGET's refusal of `"`, which is
    // the caller's guarantee and not this module's: a spec has to have passed
    // the gate before `request` sees it. This comment used to claim that
    // guarantee for itself — "no quote here can be anything but ours" — while
    // emitting no quote at all, which is how the bare `&` above got through.
    const routed = jsEntryCommand(pnpmBin, argv, execPath)
    const shell = routed === null && platform === 'win32'
    const args = shell ? argv.map(arg => shellSafeTarget(arg, platform)) : (routed?.args ?? argv)
    let child: ChildProcess
    try {
      child = spawn(routed?.command ?? pnpmBin, args, {
        cwd: current.cwd,
        env: current.env,
        stdio: 'ignore',
        detached: platform !== 'win32',
        shell,
      })
    } catch (error) {
      // `spawn` throws synchronously only for a call it cannot even build (a
      // NUL byte, an option it refuses) — a missing binary arrives as an async
      // `error` instead. Nothing above can catch this one: `start` runs from
      // `request`'s microtask or from a child's own event handler, so an
      // escaping throw is an uncaughtException, and node's default handler for
      // one takes down the host process and every install in flight with it.
      // That is the one failure that CAN decide whether an install succeeds,
      // which is the single thing this module may never do. So: the same
      // announcement the `error` handler below makes for anything but ENOENT,
      // then `finish`, which clears the batch and restarts the lane if specs
      // queued behind it. `executor.ts` wraps its own spawn for this reason.
      announce(current, `dsh-plugin-shop: the download phase could not start — ${(error as Error).message}`)
      finish(profile, current)
      return
    }
    current.child = child
    // `killTree` takes effect asynchronously, and both the timeout path below
    // and `release` move on without waiting for the OS to reap the child —
    // so this batch's `error`/`exit` can still arrive after a NEWER batch has
    // already replaced it in `current` (see `finish`, which restarts a lane
    // that still has pending specs). Each handler below checks that this
    // closure's `child` is still the lane's current one before touching
    // shared state; a stale arrival is a no-op instead of announcing the old
    // outcome to the new batch's installs and wiping the new batch's timer
    // and child reference out from under it.
    const isCurrent = () => current.child === child
    child.on('error', error => {
      if (!isCurrent()) return
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        latchAbsent(current)
      } else {
        announce(current, `dsh-plugin-shop: the download phase could not start — ${error.message}`)
      }
      finish(profile, current)
    })
    child.on('exit', code => {
      if (!isCurrent()) return
      // Absence on the one path where `error` cannot report it. `shell` is
      // true only for a batch node handed to cmd.exe, which is the only place
      // 9009 means what it says — so the arm is gated on it rather than on the
      // bare number, which a real pnpm is free to exit with for its own
      // reasons. A batch that genuinely ran and failed still falls through to
      // the two lines below.
      if (shell && code === SHELL_COMMAND_NOT_FOUND) latchAbsent(current)
      else if (code === 0) announce(current, 'dsh-plugin-shop: packages fetched ahead of the install')
      else if (code !== null) announce(current, `dsh-plugin-shop: the download phase exit ${code}; the install will fetch what is missing`)
      finish(profile, current)
    })
    current.timer = setTimeout(() => {
      if (!isCurrent()) return
      announce(current, 'dsh-plugin-shop: the download phase exceeded its bound; the install will fetch what is missing')
      killTree(child.pid, platform, kills)
      finish(profile, current)
    }, timeoutMs)
  }

  return {
    request: ({ profile, spec, cwd, env, log = () => {} }) => {
      if (!isPrefetchableSpec(spec)) return { started: false, reason: 'unsupported-spec' }
      if (pnpmAbsent) return { started: false, reason: 'no-pnpm' }
      const current = lane(profile, cwd, env)
      current.pending.set(spec, log)
      if (current.child === null) {
        // Deferred rather than started inline: two `request()` calls issued
        // back to back (the ordinary case — an install resolves its whole
        // dependency list synchronously) must merge into ONE batch. Starting
        // synchronously here would let the first call snapshot `pending`
        // before the second call's spec ever landed in it, spawning two
        // batches where one was possible. A microtask runs after the current
        // synchronous burst of `request()` calls but before any timer, so by
        // the time this fires, every same-tick spec has already been added —
        // and the `pending.size > 0` recheck matters BECAUSE of this
        // deferral: something that arrived and then `release()`d before the
        // microtask ran must not spawn an empty batch.
        queueMicrotask(() => {
          if (current.child === null && current.pending.size > 0 && !pnpmAbsent) {
            start(profile, current)
          }
        })
      }
      return { started: true }
    },
    release: (profile, spec) => {
      const current = lanes.get(profile)
      if (current === undefined) return
      current.pending.delete(spec)
      current.inFlight.delete(spec)
      if (current.child !== null && current.inFlight.size === 0 && current.pending.size === 0) {
        killTree(current.child.pid, platform, kills)
      }
    },
  }
}
