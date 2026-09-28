/**
 * dsh's `pluginManager` service (0.1.7 on), as far as this shop calls it:
 * design 2026-09-26-plugin-manager-delegation. Structural throughout: the
 * build compiles against the 0.1.1-rc.2 harness floor, where
 * `@deepseek-ai/dsh-plugin-manager` does not exist.
 */
import { activationOf, type Activation } from './activation.ts'
import { allowVersionCommand } from './compatibility.ts'
import { installFailureDetail, REFUSAL_OPENER } from './executor.ts'
import type { HotRestartReason } from './hot.ts'

/** The operations the shop calls. `cancelInstall` is optional because only
 * the install deadline uses it. Answers stay `unknown` until `readChange`
 * reads them: a later harness may add or drop fields. */
export interface PluginManagerLike {
  installBundle(spec: string, options: { requestId: string }): Promise<unknown>
  removeBundle(name: string): Promise<unknown>
  /** `id` is the live loader entry id `listPlugins` reports (`include:...`),
   * not the patch row id (dsh 0.1.7-rc.2 `setPluginEnabled`). */
  setPluginEnabled(id: string, enabled: boolean): Promise<unknown>
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  cancelInstall?(requestId: string): Promise<unknown>
}

const REQUIRED = ['installBundle', 'removeBundle', 'setPluginEnabled', 'setBundleEnabled'] as const

/** The service, when `service` offers every required operation; else null.
 * All or nothing: half a service would take an install and fail its
 * uninstall. */
export function asPluginManager(service: unknown): PluginManagerLike | null {
  if (typeof service !== 'object' || service === null) return null
  const candidate = service as Record<string, unknown>
  if (!REQUIRED.every(method => typeof candidate[method] === 'function')) return null
  if (candidate.cancelInstall !== undefined && typeof candidate.cancelInstall !== 'function') return null
  return service as PluginManagerLike
}

export interface ManagerIncompatible { name: string; version: string; runtimeVersion: string; peers: Record<string, string> }

/** The facts of one answer, each checked for its type. */
export interface ManagerChange {
  application: string | null
  stage: string | null
  errorCode: string | null
  diagnostic: string | null
  incompatible: ManagerIncompatible[]
  kind: string | null
  output: string
  pendingBuilds: string[]
  failedAt: string | null
  /** Whether the profile's files differ from before the operation (dsh's
   * `diskState`, which covers package.json). */
  changed: boolean | null
  /** dsh keeps only the last 16 KB of a pnpm run's output; true when this
   * answer's `packageResult.output` was cut short, so an absence in it
   * proves nothing. */
  truncated: boolean
}

const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}

function incompatibleList(value: unknown): ManagerIncompatible[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const entry = record(item)
    const name = text(entry.name)
    const version = text(entry.version)
    const runtimeVersion = text(entry.runtimeVersion)
    if (name === null || version === null || runtimeVersion === null) return []
    const peers = Object.fromEntries(
      Object.entries(record(entry.peers)).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
    )
    return [{ name, version, runtimeVersion, peers }]
  })
}

/** Read one `ChangeResult`. Every field is optional: one a later harness
 * drops reads as absent, never as a crash. */
export function readChange(raw: unknown): ManagerChange {
  const result = record(raw)
  const error = record(result.error)
  const run = record(result.packageResult)
  const fromError = incompatibleList(error.incompatible)
  return {
    application: text(result.application),
    stage: text(result.stage),
    errorCode: text(error.code),
    diagnostic: text(error.diagnostic),
    incompatible: fromError.length > 0 ? fromError : incompatibleList(run.incompatible),
    kind: text(run.kind),
    output: text(run.output) ?? '',
    pendingBuilds: Array.isArray(result.pendingBuilds)
      ? result.pendingBuilds.filter((name): name is string => typeof name === 'string')
      : [],
    failedAt: text(result.failedAt),
    changed: typeof result.changed === 'boolean' ? result.changed : null,
    truncated: run.truncated === true,
  }
}

/** True when `sentence` names a `dsh plugin` command. */
function namesCliCommand(sentence: string): boolean {
  return sentence.includes('dsh plugin')
}

const isTerminal = (character: string): boolean => character === '.' || character === '!' || character === '?'
const isSpace = (character: string): boolean => /\s/.test(character)

/** Splits `line` into sentences, each still carrying whatever whitespace
 * followed its `.`, `!` or `?`, so joining every piece back together
 * reproduces `line` exactly. A sentence ends after a run of terminal
 * punctuation that whitespace or the end of the line follows; the text after
 * the last such run is one more piece, so a line with no terminal
 * punctuation at all is one sentence spanning the whole line, and an empty
 * line gives none. One pass from left to right: the regex this replaced
 * backtracked quadratically on a long run of punctuation with no whitespace
 * after it, and dsh's output holds up to 16 KB of whatever pnpm printed. */
function sentencesIn(line: string): string[] {
  const pieces: string[] = []
  let start = 0
  let index = 0
  while (index < line.length) {
    if (!isTerminal(line.charAt(index))) {
      index += 1
      continue
    }
    let runEnd = index
    while (runEnd < line.length && isTerminal(line.charAt(runEnd))) runEnd += 1
    if (runEnd < line.length && !isSpace(line.charAt(runEnd))) {
      // Followed by something else, as in `a.b` or `x...y`: no sentence ends.
      index = runEnd
      continue
    }
    let end = runEnd
    while (end < line.length && isSpace(line.charAt(end))) end += 1
    pieces.push(line.slice(start, end))
    start = end
    index = end
  }
  if (start < line.length) pieces.push(line.slice(start))
  return pieces
}

/** Where `sentence`'s terminator starts: its closing punctuation and the
 * whitespace after it. Scanned back from the end, so no run in dsh's output
 * can make it slow. */
function terminatorStart(sentence: string): number {
  let end = sentence.length
  while (end > 0 && /\s/.test(sentence.charAt(end - 1))) end -= 1
  while (end > 0 && '.!?'.includes(sentence.charAt(end - 1))) end -= 1
  return end
}

/** `sentence`, with every clause that names a `dsh plugin` command removed.
 * A clause is a run between `; ` separators, and what is kept keeps the
 * sentence's terminator. A sentence with nothing to remove is returned
 * unchanged; one that loses every clause is dropped (null). */
function scrubSentence(sentence: string): string | null {
  if (!namesCliCommand(sentence)) return sentence
  const end = terminatorStart(sentence)
  const kept = sentence.slice(0, end).split('; ').filter(clause => !namesCliCommand(clause))
  return kept.length === 0 ? null : `${kept.join('; ')}${sentence.slice(end)}`
}

/** `line`, with every clause that names a `dsh plugin` command removed (see
 * `scrubSentence`). A line with nothing to remove is returned unchanged (so
 * it stays exactly what it was); one that loses every sentence is dropped
 * (null). */
function scrubLine(line: string): string | null {
  const sentences = sentencesIn(line)
  if (sentences.length === 0) return line
  const kept = sentences.map(scrubSentence).filter((sentence): sentence is string => sentence !== null)
  return kept.length === 0 ? null : kept.join('')
}

function scrubText(value: string): string {
  return value.split('\n').map(scrubLine).filter((line): line is string => line !== null).join('\n')
}

/** `change`, with every clause naming a `dsh plugin` command removed from
 * `diagnostic` and `output`: dsh's CLI refuses every `plugin` subcommand for
 * the desktop profile, so a step dsh wrote assuming that command exists must
 * not reach a reader there. Two dsh texts this exists for: dsh-app-boot's
 * `pluginCompatibilityWarning` ("... with `dsh plugin allow-version` or the
 * plugin manager ..."), whose sentence goes whole, and the restoration line
 * after a failed repair ("..., but node_modules could not be reinstalled;
 * run 'dsh plugin install'"), which keeps what it says dsh restored. A
 * clause is a run between `; ` separators within a sentence; a sentence left
 * with no clause is dropped, and so is a line left with no sentence. Every
 * other line stays untouched, and a diagnostic left empty afterward reads as
 * absent, the same way `codeReason` already treats one. */
export function forDesktopReader(change: ManagerChange): ManagerChange {
  return {
    ...change,
    diagnostic: change.diagnostic === null ? null : scrubText(change.diagnostic),
    output: scrubText(change.output),
  }
}

/** The end of a detail that passes on what a service call threw: `: ` and
 * the message, scrubbed for a desktop reader as `forDesktopReader` scrubs
 * dsh's answer, since a thrown message is dsh's text as well. A message left
 * with nothing to say ends the detail with a period instead. */
export function thrownTail(message: string, desktop: boolean): string {
  const said = desktop ? scrubText(message) : message
  return said.trim() === '' ? '.' : `: ${said}`
}

export interface ManagerOutcome { state: 'done' | 'failed'; activation?: Activation; restartReason?: HotRestartReason; detail?: string }

export interface OutcomeContext {
  profile: string
  name: string
  operation: 'install' | 'update' | 'uninstall'
  /** The gateway's `imported` record holds the name (market borrowings section 1). */
  alreadyImported: boolean
  hasClientHalf: boolean
  /** The desktop profile, whose readers can run no `dsh plugin` command. */
  desktop: boolean
  timeoutMs: number
}

/** What each management code means, in dsh 0.1.7-rc.2's own terms (the
 * implementation plan of 2026-09-27, Task 2, records where each is raised). */
const CODE_SENTENCE: Record<string, string> = {
  'unknown-plugin': 'dsh lists no plugin entry by that id',
  'invalid-spec': 'dsh could not read the install spec',
  'ambiguous-install': 'dsh could not tell which package the install added',
  'not-bundle': 'the package is not a dsh bundle',
  'not-removable': 'dsh does not allow removing this bundle',
  'stop-profile': 'the bundle is running and this dsh cannot unload it live, so the profile has to be stopped first',
  'bundle-in-use': 'the bundle was switched off, but some of its plugins are still running',
  'stale-approval': 'a build approval names a package pnpm no longer holds',
  'management-required': 'the plugin belongs to dsh itself',
  unaddressable: "the plugin is not a row of the profile's own patch, so dsh cannot address it",
  'operation-error': 'dsh hit an unexpected error',
}

/** What each classified pnpm failure was, as dsh classifies it. */
const KIND_SENTENCE: Record<string, string> = {
  'pnpm-missing': 'pnpm could not be started',
  timeout: "pnpm did not finish within dsh's own time bound",
  'not-found': 'no such package was found',
  // The requested version, not the catalog's: an update of the shop itself
  // asks for the version npm's dist-tags name.
  'no-matching-version': 'no version matching the requested one was found',
  network: 'the network failed',
  'disk-full': 'the disk is full',
  permission: 'permission was denied',
  integrity: 'the downloaded package failed its integrity check',
}

const WHERE: Record<string, string> = {
  registry: ' at the registry',
  'spec-host': ' at the host the package is fetched from',
}

/** An own-property read of one of the three tables above. They are object
 * literals, so a bare index read answers for Object.prototype, and a code of
 * `toString` would publish a function's source as dsh's reason (R43). */
const lookup = (table: Readonly<Record<string, string>>, key: string): string | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined

/** The pnpm-failure hint a desktop reader gets: it names no command, which
 * the CLI would refuse for that profile. */
const DESKTOP_FAILURE_HINT = 'pnpm failed in the profile'

/** What dsh says it restored after refusing, from its own restoration line:
 * the first `dsh: ` line after the one opening the refusal
 * (dsh-plugin-manager's `rejected`), read as the CLI path's `refusalDetail`
 * reads it, capitalized and ending in dsh's own period. Null when the output
 * holds no such line, being empty or cut short. */
function restorationSentence(output: string): string | null {
  const lines = output.split(/\r?\n/)
  const start = lines.findIndex(line => line.startsWith(REFUSAL_OPENER))
  if (start === -1) return null
  const line = lines.slice(start + 1).find(later => later.startsWith('dsh: '))
  const said = line?.slice('dsh: '.length).trim() ?? ''
  return said === '' ? null : `${said.charAt(0).toUpperCase()}${said.slice(1)}`
}

/** The refusal of a package the running dsh rejects on its peers, for the
 * operation dsh refused: an install, an update, or an uninstall whose pnpm
 * run touched an incompatible sibling. What dsh restored is dsh's to say,
 * so its restoration line is passed on. Without one, an install or update
 * says what dsh's own pre-check says, and an uninstall says nothing of it. */
function versionRefusalDetail(context: OutcomeContext, change: ManagerChange): string {
  const refused = change.incompatible.map(issue =>
    `${issue.name}@${issue.version} declares ${Object.entries(issue.peers).map(([peer, range]) => `${peer} ${range}`).join(', ')},`
    + ` which dsh ${issue.runtimeVersion} does not satisfy`)
  const restored = restorationSentence(change.output)
    ?? (context.operation === 'uninstall' || change.truncated ? null : 'Nothing was installed.')
  const base = `dsh-plugin-shop: dsh refused the ${context.operation}: ${refused.join('; ')}.${restored === null ? '' : ` ${restored}`}`
  if (context.desktop) {
    return `${base} dsh's CLI, which grants version exemptions, does not manage the desktop profile, and this shop grants none.`
  }
  const commands = change.incompatible
    .map(issue => allowVersionCommand(context.profile, issue))
    .filter((command): command is string => command !== null)
  if (commands.length === 0) return base
  return `${base} To accept the risk of crashes or data loss for ${commands.length === 1 ? 'this exact version' : 'these exact versions'},`
    + ` run: ${commands.join('; ')} - then ${context.operation} again.`
}

/** The sentence a management code gets, plus dsh's own diagnostic. The
 * diagnostic is trimmed and stripped of one trailing period so one that
 * already ends in a period is not doubled; empty after that reads as
 * absent. Exported: Task 7 builds the same tail for a non-terminal notice. */
export function codeReason(change: ManagerChange, code: string): string {
  const sentence = lookup(CODE_SENTENCE, code)
  const diagnostic = change.diagnostic !== null ? change.diagnostic.trim().replace(/\.$/, '') : ''
  const said = diagnostic !== '' ? ` dsh reported: ${diagnostic}.` : ''
  return `${sentence !== undefined ? `: ${sentence}` : ''}.${said}`
}

/** A desktop reader's detail for build scripts pnpm held. The app bundles
 * its own package manager, so `pnpm approve-builds` is no step for this
 * reader, and the shop never allows build scripts itself. dsh's own Plugins
 * page offers "Allow these scripts and retry" on the failed screen of an
 * install it runs, listing the held packages (dsh-client-ui-plugin-manager
 * 0.1.7-rc.2: `installApproveAndRetry` in lib/client.js, and its README), so
 * that is named, but only for an install whose held builds dsh listed. Its
 * Add plugin dialog refuses a name the profile already holds, so it cannot
 * rerun an update, and with no name listed it offers no such button. */
function desktopBuildsDetail(context: OutcomeContext, change: ManagerChange, held: string): string {
  const base = `dsh-plugin-shop: pnpm is holding the build scripts of ${held}, which it blocks by default, and this shop never allows them.`
  if (context.operation !== 'install' || change.pendingBuilds.length === 0) return base
  return `${base} dsh's Plugins page offers "Allow these scripts and retry" when an install it runs stops on them.`
}

/** What a `cancelled` answer means, for every reader: the shop's deadline
 * asked dsh to stop the operation, and dsh answers `cancelled` only once its
 * repository check or pnpm has exited and package.json and pnpm-lock.yaml
 * are back as they were (dsh-plugin-manager 0.1.7-rc.2: cancelInstall, and
 * InstallCancelledError, thrown after the files are restored). Nothing was
 * installed, so the detail names no command: the CLI's `install`, which the
 * CLI path's own timeout detail names, would no longer involve the package.
 * Only installBundle can be cancelled, so the operation is an install or an
 * update. */
function cancelledDetail(context: OutcomeContext): string {
  const seconds = Math.max(1, Math.round(context.timeoutMs / 1000))
  return `dsh-plugin-shop: the ${context.operation} did not finish within ${seconds}s, so the shop cancelled it.`
    + ` dsh stopped it, restored the profile's package.json and pnpm-lock.yaml, and installed nothing. Try the ${context.operation} again from the shop.`
}

/** A `ChangeResult` as the shop's terminal install record: design
 * 2026-09-26-plugin-manager-delegation, section 5, read by the first rule
 * that matches. A removal that failed after dsh changed the profile says,
 * after whichever rule read it, that the package is still installed and
 * switched off. */
export function managerOutcome(raw: unknown, context: OutcomeContext): ManagerOutcome {
  const change = context.desktop ? forDesktopReader(readChange(raw)) : readChange(raw)
  const outcome = outcomeByRule(change, context)
  // removeBundle switches an enabled bundle off before pnpm runs, and
  // nothing switches it back on, so a removal that failed with the profile's
  // files changed left the package installed and off. The sentence is the
  // shop's own, so no scrub applies to it.
  if (context.operation === 'uninstall' && outcome.state === 'failed' && change.changed === true) {
    const switchedOff = `${context.name} is still installed, but dsh has switched it off.`
    if (outcome.detail === undefined) return { ...outcome, detail: switchedOff }
    const needsPeriod = !/[.!?]$/.test(outcome.detail)
    return { ...outcome, detail: `${outcome.detail}${needsPeriod ? '.' : ''} ${switchedOff}` }
  }
  return outcome
}

/** The section 5 rules, in order; the first that matches wins. */
function outcomeByRule(change: ManagerChange, context: OutcomeContext): ManagerOutcome {
  // A pnpm run whose own compatibility scan rejected a package, a removal
  // that touched an incompatible sibling, reaches the caller as a plain
  // error, coded `operation-error`, with the structured list kept on
  // packageResult: the same refusal as `incompatible-version`, read from the
  // same list.
  if (change.errorCode === 'incompatible-version' || (change.errorCode === 'operation-error' && change.incompatible.length > 0)) {
    return { state: 'failed', detail: versionRefusalDetail(context, change) }
  }
  if (change.application === 'failed' && change.stage === 'enable') {
    const code = change.errorCode ?? 'failed'
    return {
      state: 'failed',
      detail: `dsh-plugin-shop: ${context.name} is installed, but dsh could not enable it (${code})`
        + `${codeReason(change, code)} Uninstall it from the shop to undo the install.`,
    }
  }
  // A failed pnpm run. dsh classifies its `kind`, then throws its output as a
  // plain error, which it codes `operation-error` with that whole output as
  // the diagnostic (dsh-plugin-manager 0.1.7-rc.2, installBundle and
  // removeBundle). An answer without that wrapper reads the same way, for a
  // harness that stops adding it. The diagnostic is never embedded here: the
  // kind names what happened, and an unknown kind gets an excerpt of the
  // output through installFailureDetail.
  if (change.application === 'failed' && change.kind !== null
    && (change.errorCode === null || change.errorCode === 'operation-error')) {
    if (change.kind === 'build-blocked') {
      const held = change.pendingBuilds.length > 0 ? change.pendingBuilds.join(', ') : 'a dependency'
      if (context.desktop) return { state: 'failed', detail: desktopBuildsDetail(context, change, held) }
      return {
        state: 'failed',
        detail: `dsh-plugin-shop: pnpm is holding the build scripts of ${held}, which it blocks by default:`
          + ` run \`pnpm approve-builds\` in the profile directory to allow them, then ${context.operation} again.`,
      }
    }
    // For a GitHub repository dsh runs `git ls-remote` before pnpm, bounded
    // by its githubConnectionTimeoutMs (5000 ms by default), and a timeout
    // there answers failedAt `spec-host`. pnpm's own timeouts never carry
    // failedAt, so this pair is that check and nothing else
    // (dsh-plugin-manager 0.1.7-rc.2, checkGithubConnection, installBundle).
    if (change.kind === 'timeout' && change.failedAt === 'spec-host') {
      return {
        state: 'failed',
        detail: `dsh-plugin-shop: the ${context.operation} failed at the host the package is fetched from: dsh checks that a GitHub repository is reachable`
          + ' before pnpm runs, and that check did not finish within its bound (5 s by default), so pnpm never ran.',
      }
    }
    const sentence = lookup(KIND_SENTENCE, change.kind)
    if (sentence !== undefined) {
      const where = change.failedAt === null ? '' : lookup(WHERE, change.failedAt) ?? ''
      return { state: 'failed', detail: `dsh-plugin-shop: the ${context.operation} failed${where}: ${sentence}.` }
    }
    const lines = change.output.split(/\r?\n/).filter(line => line !== '')
    return {
      state: 'failed',
      detail: context.desktop
        ? installFailureDetail(context.profile, lines, DESKTOP_FAILURE_HINT)
        : installFailureDetail(context.profile, lines),
    }
  }
  if (change.errorCode !== null) {
    // `operation-error` is what dsh codes any error that is not one of its
    // refusals (managementError), so it reads "could not", not "refused".
    const said = change.errorCode === 'operation-error'
      ? `could not ${context.operation} ${context.name}`
      : `refused the ${context.operation} of ${context.name}`
    return { state: 'failed', detail: `dsh-plugin-shop: dsh ${said} (${change.errorCode})${codeReason(change, change.errorCode)}` }
  }
  if (change.application === 'cancelled') {
    return { state: 'failed', detail: cancelledDetail(context) }
  }
  if (change.application === 'restart-required') {
    return context.operation === 'update'
      ? { state: 'done', activation: 'restart', restartReason: 'already-loaded' }
      : { state: 'done', activation: 'restart' }
  }
  if (change.application === 'applied' || change.application === 'overridden') {
    const note = change.application === 'overridden'
      ? { detail: 'Saved, but a higher-priority layer (the home or invocation patch) decides whether it runs.' }
      : {}
    if (context.operation !== 'uninstall' && context.alreadyImported) {
      return { state: 'done', activation: 'restart', restartReason: 'already-loaded', ...note }
    }
    return {
      state: 'done',
      activation: activationOf({ hostLive: true, clientLive: true, hasClientHalf: context.hasClientHalf }),
      ...note,
    }
  }
  return {
    state: 'failed',
    detail: `dsh-plugin-shop: dsh answered the ${context.operation} with "${change.application ?? 'nothing'}", which this shop does not know how to read.`,
  }
}
