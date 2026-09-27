/**
 * dsh's `pluginManager` service (0.1.7 on), as far as this shop calls it:
 * design 2026-09-26-plugin-manager-delegation. Structural throughout: the
 * build compiles against the 0.1.1-rc.2 harness floor, where
 * `@deepseek-ai/dsh-plugin-manager` does not exist.
 */
import { activationOf, type Activation } from './activation.ts'
import { allowVersionCommand } from './compatibility.ts'
import { installFailureDetail, installTimeoutDetail } from './executor.ts'
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
  }
}

/** True when `sentence` names a `dsh plugin` command. */
function namesCliCommand(sentence: string): boolean {
  return sentence.includes('dsh plugin')
}

/** Splits `line` into sentences, each still carrying whatever whitespace
 * followed its `.`, `!` or `?`, so joining every piece back together
 * reproduces `line` exactly. A line with no terminal punctuation at all is
 * one sentence spanning the whole line. */
function sentencesIn(line: string): string[] {
  return line.match(/[\s\S]*?[.!?]+(?:\s+|$)|[\s\S]+$/g) ?? []
}

/** `line`, with every sentence that names a `dsh plugin` command removed. A
 * line with nothing to remove is returned unchanged (so it stays exactly
 * what it was); one that loses every sentence is dropped (null). */
function scrubLine(line: string): string | null {
  const sentences = sentencesIn(line)
  if (sentences.length === 0) return line
  const kept = sentences.filter(sentence => !namesCliCommand(sentence))
  return kept.length === 0 ? null : kept.join('')
}

function scrubText(value: string): string {
  return value.split('\n').map(scrubLine).filter((line): line is string => line !== null).join('\n')
}

/** `change`, with every sentence naming a `dsh plugin` command removed from
 * `diagnostic` and `output`: dsh's CLI refuses every `plugin` subcommand for
 * the desktop profile, so a sentence dsh wrote assuming that command exists
 * must not reach a reader there. Two dsh texts this exists for: dsh-app-boot's
 * `pluginCompatibilityWarning` ("... with `dsh plugin allow-version` or the
 * plugin manager ...") and the install rollback message ("run 'dsh plugin
 * install'"). Scrubbing line by line keeps every other line untouched; a
 * diagnostic left empty afterward reads as absent, the same way `codeReason`
 * already treats one. */
export function forDesktopReader(change: ManagerChange): ManagerChange {
  return {
    ...change,
    diagnostic: change.diagnostic === null ? null : scrubText(change.diagnostic),
    output: scrubText(change.output),
  }
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
  'no-matching-version': "no version matching the catalog's was found",
  network: 'the network failed',
  'disk-full': 'the disk is full',
  permission: 'permission was denied',
  integrity: 'the downloaded package failed its integrity check',
}

const WHERE: Record<string, string> = {
  registry: ' at the registry',
  'spec-host': ' at the host the package is fetched from',
}

/** The pnpm-failure hint a desktop reader gets: it names no command, which
 * the CLI would refuse for that profile. */
const DESKTOP_FAILURE_HINT = 'pnpm failed in the profile'

/** The refusal of a package the running dsh rejects on its peers, for the
 * operation dsh refused: an install, an update, or an uninstall whose pnpm
 * run touched an incompatible sibling. */
function versionRefusalDetail(context: OutcomeContext, incompatible: readonly ManagerIncompatible[]): string {
  const refused = incompatible.map(issue =>
    `${issue.name}@${issue.version} declares ${Object.entries(issue.peers).map(([peer, range]) => `${peer} ${range}`).join(', ')},`
    + ` which dsh ${issue.runtimeVersion} does not satisfy`)
  const nothing = context.operation === 'uninstall' ? 'Nothing was removed.' : 'Nothing was installed.'
  const base = `dsh-plugin-shop: dsh refused the ${context.operation}: ${refused.join('; ')}. ${nothing}`
  if (context.desktop) {
    return `${base} dsh's CLI, which grants version exemptions, does not manage the desktop profile, and this shop grants none.`
  }
  const commands = incompatible
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
  const sentence = CODE_SENTENCE[code]
  const diagnostic = change.diagnostic !== null ? change.diagnostic.trim().replace(/\.$/, '') : ''
  const said = diagnostic !== '' ? ` dsh reported: ${diagnostic}.` : ''
  return `${sentence !== undefined ? `: ${sentence}` : ''}.${said}`
}

function cancelledDetail(context: OutcomeContext): string {
  if (!context.desktop) return installTimeoutDetail(context.profile, context.timeoutMs)
  const seconds = Math.max(1, Math.round(context.timeoutMs / 1000))
  return `dsh-plugin-shop: the ${context.operation} did not finish within ${seconds}s, and the shop cancelled it.`
}

/** A `ChangeResult` as the shop's terminal install record: design
 * 2026-09-26-plugin-manager-delegation, section 5. The first rule that
 * matches wins. */
export function managerOutcome(raw: unknown, context: OutcomeContext): ManagerOutcome {
  const change = context.desktop ? forDesktopReader(readChange(raw)) : readChange(raw)
  // A pnpm run whose own compatibility scan rejected a package, a removal
  // that touched an incompatible sibling, reaches the caller as a plain
  // error, coded `operation-error`, with the structured list kept on
  // packageResult: the same refusal as `incompatible-version`, read from the
  // same list.
  if (change.errorCode === 'incompatible-version' || (change.errorCode === 'operation-error' && change.incompatible.length > 0)) {
    return { state: 'failed', detail: versionRefusalDetail(context, change.incompatible) }
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
      return {
        state: 'failed',
        detail: `dsh-plugin-shop: pnpm is holding the build scripts of ${held}, which it blocks by default:`
          + ` run \`pnpm approve-builds\` in the profile directory to allow them, then ${context.operation} again.`,
      }
    }
    const sentence = KIND_SENTENCE[change.kind]
    if (sentence !== undefined) {
      const where = change.failedAt === null ? '' : WHERE[change.failedAt] ?? ''
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
    return {
      state: 'failed',
      detail: `dsh-plugin-shop: dsh refused the ${context.operation} of ${context.name} (${change.errorCode})${codeReason(change, change.errorCode)}`,
    }
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
