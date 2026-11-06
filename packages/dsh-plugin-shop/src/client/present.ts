/** Pure presentation core for the shop tab (§5.1 Client half). No React, no
 * timers, no I/O: every function here maps a value to a value, so fixtures
 * drive all of it. */

export { isShopLike } from '../shared/shop-like.ts'
import { isShopLike } from '../shared/shop-like.ts'
// Only what the client half actually uses. The identity primitives it does
// not (`parseRepoSpec`, `installedSpecMatches`, `sameInstall`) were re-exported
// here too, which advertised them as part of the presentation API and gave a
// reader tracing their dependents a false hit through a barrel.
export { identityKey, type EntryIdentity } from '../shared/identity.ts'
import { holderLabel, identityKey, specVerdict, type EntryIdentity } from '../shared/identity.ts'
import type { ShopLocaleKey } from './locales.ts'
import type { CatalogEntry, HarnessVerdict, HotRestartReason, InstallRejectionCode, RestartBlockedReason, ShopVersionResult } from '../host/index.ts'
import type { Activation } from '../host/activation.ts'
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'

// Re-exported so the client half has one import site for it.
export type { Activation }

/** The done notice for one activation, as a locale key.
 *
 * A hot-mount reason code names WHY a restart is needed and is meaningful
 * only under `restart`; `live` and `reload` ignore any reason riding along,
 * because rendering one there would tell a reader their reload had failed.
 * An absent or unrecognized reason keeps the generic restart line rather
 * than showing a bare code. */
export function activationNoticeKey(activation: Activation, restartReason: HotRestartReason | undefined): ShopLocaleKey {
  if (activation === 'live') return 'installedNoRestartNotice'
  if (activation === 'reload') return 'installedReloadNotice'
  switch (restartReason) {
    case 'no-patch': return 'hotNoPatchNotice'
    case 'not-simple': return 'hotNotSimpleNotice'
    case 'host-unsupported': return 'hotHostUnsupportedNotice'
    case 'timeout': return 'hotTimeoutNotice'
    case 'mount-failed': return 'hotMountFailedNotice'
    case 'already-loaded': return 'hotAlreadyLoadedNotice'
    default: return 'installedRestartNotice'
  }
}

/** The same mapping for an UNINSTALL's done notice.
 *
 * A sibling rather than a `prefix` parameter on `activationNoticeKey`: the
 * two key sets are not parallel — `installedNoRestartNotice` against
 * `uninstalledLiveNotice` — so no prefix derives one from the other. It takes
 * no reason code, because a hot-mount reason explains why a MOUNT could not
 * happen and an uninstall mounts nothing.
 *
 * Here rather than in JSX because this is a pure Activation -> copy decision,
 * and in a component no fixture can reach it: the install side was covered
 * and this one was not, for the whole time both existed. */
export function uninstallActivationNoticeKey(activation: Activation): ShopLocaleKey {
  if (activation === 'restart') return 'uninstalledRestartNotice'
  return activation === 'reload' ? 'uninstalledReloadNotice' : 'uninstalledLiveNotice'
}

/** The copy key for one install phase. A function rather than an inline
 * ternary in the JSX so it is unit-testable: the tab's only test seam is a
 * whole-tab render driven by injected RPCs, which cannot be handed one view. */
export function installPhaseKey(phase: 'downloading' | 'installing'): ShopLocaleKey {
  return phase === 'downloading' ? 'downloading' : 'installing'
}

/** Why the shop cannot restart dsh, as a locale key.
 *
 * A sibling of `activationNoticeKey` and exhaustive for the same reason: the
 * switch has no default, so a reason added to `RestartBlockedReason` is a type
 * error here rather than a card that silently keeps a neighbour's copy. That
 * is the whole point of the type — the single boolean this replaced
 * had ONE string for three causes, and it named systemd, so a Windows reader
 * was told to restart a service they do not run and to set an override that
 * could not have helped. */
export function restartBlockedNoticeKey(reason: RestartBlockedReason): ShopLocaleKey {
  switch (reason) {
    case 'desktop': return 'restartBlockedDesktopNotice'
    case 'from-default-profile': return 'restartBlockedFromDefaultProfileNotice'
    case 'windows': return 'restartBlockedWindowsNotice'
    case 'systemd': return 'restartBlockedSystemdNotice'
    case 'port-zero': return 'restartBlockedPortZeroNotice'
  }
}

/** Tier → locale key, for the entry-card tier badge (§6.2). */
export function tierKey(tier: CatalogEntry['tier']): ShopLocaleKey {
  switch (tier) {
    case 'verified': return 'tierVerified'
    case 'verified-stale': return 'tierVerifiedStale'
    case 'community': return 'tierCommunity'
  }
}

/** The peers the Host said this installation does not provide, or none when it
 * said nothing — a plugin that runs here and one the Host could not judge are
 * both rendered as no warning at all. The map is keyed by install identity,
 * never by name, because two entries can share a name. */
export function missingPeersOf(incompatible: Record<string, string[]>, key: string): string[] {
  return incompatible[key] ?? []
}

/** The author's own `dsh.compatibility` that this installation does not meet
 * (design 2026-09-01 §8.2), or undefined when the host gave no verdict. Keyed
 * by install identity, never by name, for the reason `missingPeersOf` is.
 *
 * The map itself may be absent, whatever the result type says: a tab can
 * outlive a shop self-update by one reload and then be talking to the OLD
 * in-process host until dsh restarts, which answers the shape from before the
 * key existed. That is "no verdict", never a crash. */
export function harnessVerdictOf(
  verdicts: Readonly<Record<string, HarnessVerdict>> | undefined,
  key: string,
): HarnessVerdict | undefined {
  // Own properties only, the way `starsOf` and `heldBy` read their wire maps.
  return verdicts !== undefined && Object.hasOwn(verdicts, key) ? verdicts[key] : undefined
}

/**
 * One thing standing between an entry and a working install, carrying the
 * facts its copy names — never the copy, which the tab localizes (§4: no copy
 * crosses the RPC).
 *
 * Refusals and warnings, each with its own remedy. Two are refusals, and put
 * a label in the button's place (`refusesInstall`): a taken name, which the
 * host WILL refuse and the reader fixes by uninstalling a plugin; and harness
 * peers the running dsh WILL refuse (0.1.7 on), fixed by dsh's exact-version
 * exemption, whose command the host sends when dsh would accept one.
 * Everything else is about this harness and is advisory — the host installs
 * anyway: components node resolution and the page's module table both lack,
 * and an author's declared range or profile list this dsh falls outside of.
 */
export type Blocker =
  | { kind: 'name-taken'; holder: string }
  | { kind: 'harness-peers'; refused: Readonly<Record<string, string>>; running: string; allowCommand: string | null }
  | { kind: 'missing-peers'; modules: readonly string[] }
  | { kind: 'harness-range'; range: string; running: string }
  | { kind: 'harness-profile'; declared: readonly string[]; running: string }

export type BlockerKind = Blocker['kind']

/**
 * Everything standing in one entry's way, in the order every surface renders
 * it — the card's detail lines, the badge's accessible name, the outdated
 * row's refusal — and the one list the incompatible filter reads, through
 * `readsIncompatible`, and the install button, through `refusesInstall`.
 *
 * The refusals read first. The name conflict leads: it is about a plugin the
 * reader chose and would lose. Then dsh's own refusal, then what this machine
 * is measured to lack, then what the author declared, range before profiles —
 * the order the host's verdict carries its halves.
 */
export function blockersOf(
  missing: readonly string[],
  harness: HarnessVerdict | undefined,
  nameTakenBy: string | undefined,
): Blocker[] {
  const blockers: Blocker[] = []
  if (nameTakenBy !== undefined) blockers.push({ kind: 'name-taken', holder: nameTakenBy })
  if (harness?.peers !== undefined) {
    const { refused, running, allowCommand } = harness.peers
    blockers.push({ kind: 'harness-peers', refused, running, allowCommand })
  }
  if (missing.length > 0) blockers.push({ kind: 'missing-peers', modules: missing })
  if (harness?.dsh !== undefined) blockers.push({ kind: 'harness-range', range: harness.dsh.range, running: harness.dsh.running })
  if (harness?.profile !== undefined) {
    blockers.push({ kind: 'harness-profile', declared: harness.profile.declared, running: harness.profile.running })
  }
  return blockers
}

/**
 * The badge's visible word for these blockers, or null when there are none.
 *
 * "Incompatible" for anything about this harness, whichever reason put it
 * there. A taken name is the more serious condition and names a different
 * remedy, so it decides the word whenever it holds — the card is perfectly
 * compatible, and a different plugin is in the way.
 */
export function blockerBadgeKey(blockers: readonly { kind: BlockerKind }[]): ShopLocaleKey | null {
  if (blockers.length === 0) return null
  return blockers.some(blocker => blocker.kind === 'name-taken') ? 'nameTakenBadge' : 'incompatibleBadge'
}

/** Whether the badge reads "Incompatible" — exactly the set the incompatible
 * filter counts and takes away. Derived from the badge's own rule, never
 * restated beside it: the filter used to test the peer list by hand, which
 * held only while missing peers were the one reason for the word — a card
 * badged for its declared range would have read "Incompatible" and survived
 * the filter that names it. */
export function readsIncompatible(blockers: readonly { kind: BlockerKind }[]): boolean {
  return blockerBadgeKey(blockers) === 'incompatibleBadge'
}

/**
 * Whether this install is refused before it starts, so the card shows the
 * refused label where its button would be, rather than a button for an
 * install that cannot proceed: refused by the host, for a taken name, or by
 * the running dsh, for its harness peers.
 *
 * The second is the one harness reason that blocks (design
 * 2026-09-26-dsh-017-readiness, B1, amending "warn, never block"): dsh 0.1.7
 * refuses the install itself, an npm entry before pnpm runs and a github
 * entry after it, rolling the profile back, and the shop cannot install past
 * it. The verdict is dsh's own rule on the profile's own exemptions, whichever
 * channel the entry comes from (design
 * 2026-09-28-bundle-components-and-github-peers, section 7.3), so the label
 * is dsh's answer given early, never the shop's opinion — and recording the
 * exemption the card shows is what brings the button back.
 */
export function refusesInstall(blockers: readonly { kind: BlockerKind }[]): boolean {
  return blockers.some(blocker => blocker.kind === 'name-taken' || blocker.kind === 'harness-peers')
}

/** The key dsh 0.2.1 lists a package's own `engines.dsh` range under, among
 * the requirements it refuses (design 2026-10-19-dsh-021-readiness, section
 * 4). Cards DO receive it now: the catalog carries `engines` from the 2026-11-02
 * build on (design 2026-11-02-market-borrowings §1), `ownManifest` hands it to
 * dsh's own rule, and a refusal comes back with this key in the map — which is
 * why {@link refusedPeersText} has to render it as `dsh <range>` rather than as
 * a package name. An install-time refusal carries the same key in its own
 * detail (`versionRefusalDetail`), which never passes through here. */
const ENGINES_DSH = 'engines.dsh'

/**
 * The refused requirements as the refusal's copy names them: each one and the
 * range the package declared, in the order dsh reported them. A peer is named
 * by its package. `engines.dsh` is a manifest path, not a name anyone asked
 * for, so it reads as `dsh` and its range, the way the sentence says "it
 * requires dsh >=0.3.0". A blank range — which dsh refuses — is quoted, or the
 * sentence would name the requirement and nothing it asked for.
 */
export function refusedPeersText(refused: Readonly<Record<string, string>>): string {
  return Object.entries(refused)
    .map(([name, range]) => `${name === ENGINES_DSH ? 'dsh' : name} ${range.trim() === '' ? JSON.stringify(range) : range}`)
    .join(', ')
}

/**
 * The plugin already holding this entry's bundle name, if a DIFFERENT one is,
 * named the way the host's refusal names it.
 *
 * `specs` is the profile manifest's dependencies exactly as the install gate
 * reads them (`installedSpecs`), and the verdict is the gate's own function.
 * One rule on one input, so the badge and the refusal cannot disagree. The
 * first version of this derived the answer from `installed()`, which drops
 * every dependency no catalog entry matches — so a fork, a hand install or a
 * delisted holder was invisible here while the host still refused, and the
 * card showed a plain Install button for an install that could not proceed.
 *
 * `undefined` specs means the host could not read the manifest. The answer is
 * undefined there too: the card makes no claim rather than promising a clean
 * install it cannot vouch for.
 */
export function heldBy(
  entry: EntryIdentity,
  specs: Readonly<Record<string, string>> | undefined,
): string | undefined {
  // `Object.hasOwn`, not an index read, for the reason host/index.ts's
  // `ownDependencySpec` spells out: this map is the profile manifest's
  // dependencies carried over the wire, it carries Object.prototype, and
  // `constructor` is a legal npm name — so an index read hands back a
  // function for a package nobody installed, and the card would badge a name
  // conflict against it.
  if (specs === undefined || !Object.hasOwn(specs, entry.name)) return undefined
  const spec = specs[entry.name]
  if (spec === undefined) return undefined
  return specVerdict(entry, spec) === 'same' ? undefined : holderLabel(spec, entry.name)
}

/** Install rejection code → locale key, for the rejected-state code label
 * (§7.2): every rejection the host can return has a human label here. */
export function rejectionCodeKey(code: InstallRejectionCode): ShopLocaleKey {
  switch (code) {
    case 'denied': return 'deniedCode'
    case 'not-in-catalog': return 'notInCatalogCode'
    case 'version-mismatch': return 'versionMismatchCode'
    case 'needs-acknowledgement': return 'needsAcknowledgementCode'
    case 'tarball-integrity': return 'tarballIntegrityCode'
    case 'ambiguous-identity': return 'ambiguousIdentityCode'
    case 'name-taken': return 'nameTakenCode'
    case 'desktop-profile': return 'desktopProfileCode'
  }
}

/** What a shelf version string is (market borrowings §11): a version npm
 * serves, or the spec a profile manifest holds for one; the commit a github
 * entry is pinned to; or the tag of the release a rescued github entry
 * installs from. */
export type VersionKind = 'npm' | 'commit' | 'release'

export interface VersionLabel {
  kind: VersionKind
  /** What the shelf prints: `v1.2.3`, `4da5ae8`, `v0.29.10`. */
  text: string
  /** What the accessible name and the tooltip print after the kind's word:
   * the same string without the `v` the shelf adds to an npm version. */
  value: string
}

/** A commit pin as the registry writes one: forty lowercase hex. */
const COMMIT_PIN = /^[0-9a-f]{40}$/

/**
 * How a version string reads on the shelf, decided by its source and its
 * shape alone (market borrowings §11).
 *
 * Shape, never the entry's `tarball`, because an installed row carries only
 * the pin the shop recorded at install — the catalog `version` of that moment
 * — and no `tarball`. The registry pins a commit as forty lowercase hex and a
 * release by its tag, so the two shapes do not cross; `present.test.ts`
 * checks that against the committed live catalog.
 *
 * - An npm version takes the `v` the shelf has always shown, and only before
 *   a digit: an installed row reports the manifest's spec, and a range there
 *   (`^1.2.3`) is not a version to prefix.
 * - A commit is cut to the seven characters git abbreviates to, with no `v`:
 *   it is not a version number.
 * - A release tag prints exactly as tagged, never cut and never prefixed:
 *   cutting `v0.29.10` to seven characters printed `v0.29.1`, another
 *   version, and the `v` this function no longer adds doubled the tag's own.
 */
export function versionLabel(source: 'npm' | 'github', version: string): VersionLabel {
  if (source === 'npm') return { kind: 'npm', text: /^\d/.test(version) ? `v${version}` : version, value: version }
  if (COMMIT_PIN.test(version)) {
    const short = version.slice(0, 7)
    return { kind: 'commit', text: short, value: short }
  }
  return { kind: 'release', text: version, value: version }
}

/** The copy that names a version's kind, for the accessible name and the
 * tooltip; its `{version}` takes {@link VersionLabel.value}. */
export function versionLabelKey(kind: VersionKind): ShopLocaleKey {
  switch (kind) {
    case 'npm': return 'npmVersionLabel'
    case 'commit': return 'commitVersionLabel'
    case 'release': return 'releaseVersionLabel'
  }
}

/** The hash pin a stale line names for a repo or release-rescued entry — the
 * reviewed commit, or the reviewed release tarball sha256 (market borrowings
 * §3.1). Shortened to 7 chars like a commit on the card; '' only for a
 * hand-built fixture carrying no pin. The npm form is a version, which
 * {@link versionLabel} prints instead. */
export function reviewHashPin(review: NonNullable<CatalogEntry['review']>): string {
  return (review.reviewedCommit ?? review.reviewedSha256 ?? '').slice(0, 7)
}

/**
 * Whether the license value is the npm idiom `SEE LICENSE IN <file>` — a
 * valid SPDX form meaning "custom license, text ships in that file". The
 * catalog keeps the author's verbatim value; the shelf renders it as a
 * localized "Custom license" label. Everything else renders verbatim.
 */
export function isCustomLicense(license: string | null): boolean {
  return license !== null && /^SEE LICENSE IN /i.test(license)
}

/** One polled install status (§7.3 wire data), structural. */
export interface InstallStatusShape {
  found: boolean
  state: InstallState
  log: string[]
  activation?: Activation
  restartReason?: HotRestartReason
  detail?: string
  /** The terminal line that ran, in the form a reader can retry by hand
   * (design 2026-11-02-market-borrowings §5). Present on a failure only. */
  command?: string
}

/** The install view state machine (§7.2). `phase` distinguishes the download
 * that runs ahead of the per-profile mutex from the install that holds it.
 * It rides the `running` kind rather than adding a kind of its own: every
 * `view.kind === 'running'` site — the flow registry's poll collection
 * (flow-registry.ts) among them — must keep treating a downloading install
 * as live. */
export type InstallView =
  | { kind: 'idle' }
  | { kind: 'rejected'; code: InstallRejectionCode; detail: string }
  | { kind: 'running'; installId: string; log: string[]; phase: 'downloading' | 'installing' }
  | { kind: 'done'; activation: Activation; log: string[]; restartReason?: HotRestartReason; detail?: string }
  | { kind: 'failed'; detail: string; log: string[]; command?: string }

/** One event the install view reacts to. */
export type InstallEvent =
  | { type: 'rejected'; code: InstallRejectionCode; detail: string }
  | { type: 'started'; installId: string; state: InstallState }
  | { type: 'status'; status: InstallStatusShape }

/** The phase a non-terminal state renders as: the WIRE state the host
 * reported (`InstallState`) mapped onto the phase the view carries. Exported
 * because every hook that turns a start or a poll result into a view spells
 * this same mapping, and three hand-copied ternaries are three chances for
 * one of them to drift.
 *
 * Not to be confused with `installPhaseKey`, which is the OTHER direction and
 * a different pair of values: view phase → the locale key to render. They
 * happen to share two spellings today and that is a coincidence of naming,
 * not a reason to fuse them — the wire union and the locale key set are free
 * to diverge. */
export function phaseOf(state: InstallState): 'downloading' | 'installing' {
  return state === 'downloading' ? 'downloading' : 'installing'
}

/** §7.2 once-per-second poll cadence, as a named constant. */
export const INSTALL_POLL_MS = 1000

/** §8 restart handoff: the client polls the origin only after this grace
 * period (the host's exit delay plus margin), so an origin that answers is
 * the NEW server, never the dying old one. */
export const RESTART_GRACE_MS = 3000

/** §8 restart handoff: how long the client waits for the new server to
 * START answering before reporting the manual restart command. A run of good
 * answers that began inside it may finish after it (see
 * `restartMonitorVerdict`). */
export const RESTART_WAIT_MS = 30000

/** §8 restart handoff: how long the new server must keep answering before the
 * page reloads into it (design 2026-09-26-market-borrowings §3). The Loader
 * mounts entries concurrently, so a boot that is about to fail can bind the
 * port and answer before the settled tree is audited and the process exits;
 * dsh-market measured that window inside 8 s. */
export const RESTART_STABLE_MS = 8000

/**
 * The restart monitor's decision after a probe of the origin.
 *
 * `stableSinceMs` is when the current unbroken run of good answers began —
 * null when the last probe failed, or none has succeeded yet — and both times
 * count from the moment the restart was committed. One answer is not enough:
 * reloading on it is what landed a reader on a boot that died a moment later,
 * a blank page in place of the notice naming the log. So the page reloads
 * only once the run has lasted `RESTART_STABLE_MS`, and the monitor gives up
 * only when no run is under way past `RESTART_WAIT_MS` — which bounds the
 * whole wait at the sum of the two, since a run that began in time either
 * completes or breaks after the deadline.
 */
export function restartMonitorVerdict(input: { elapsedMs: number; stableSinceMs: number | null }): 'wait' | 'reload' | 'failed' {
  if (input.stableSinceMs !== null && input.elapsedMs - input.stableSinceMs >= RESTART_STABLE_MS) return 'reload'
  if (input.stableSinceMs === null && input.elapsedMs > RESTART_WAIT_MS) return 'failed'
  return 'wait'
}

/**
 * Whether two `version()` answers came from different dsh processes — dsh
 * restarted under the page between them (design §8, 2026-10-06 amendment).
 *
 * A process names itself by `bootId` for as long as it lives, so where either
 * answer carries one, a difference decides: a host older than the field never
 * starts naming itself, and a newer one never stops. Where neither does, only
 * the code they run can differ — one process runs one version, read once at
 * its boot — which still catches the first restart after a self-update from
 * a host older than the field, the one that matters most.
 */
export function answeredByAnotherProcess(previous: ShopVersionResult, next: ShopVersionResult): boolean {
  if (previous.bootId !== undefined || next.bootId !== undefined) return previous.bootId !== next.bootId
  return previous.installed !== next.installed
}

/**
 * Whether an update of the shop has landed and waits for a restart: the
 * profile holds a version other than the one running. A host older than the
 * field sends none, and that reads as waiting: a client newer than its host
 * exists only because the disk holds a newer shop than the process running
 * (design §7.3, 2026-09-27 amendment). The tab's restart offer and the
 * hand-over after a hot swap (design 2026-10-16-shop-sidebar-page §6) read
 * it alike.
 */
export function updateAwaitsRestart(version: ShopVersionResult): boolean {
  return version.pendingVersion !== null
}

/**
 * Whether dsh restarting under the page settles this receipt: a change that
 * landed and was waiting for exactly that. The page store clears these
 * (page-store.ts, `noteRestarted`) once the answers come from another
 * process, and nothing else — a reload is still owed by a page nobody
 * reloaded, a failure still happened, and a flow still running settles by
 * its own poll.
 */
export function settledByRestart(view: InstallView): boolean {
  return view.kind === 'done' && view.activation === 'restart'
}

/** How long the check-update button reports "up to date" after a re-check
 * finds no newer release, before reverting to its idle label. */
export const CHECK_UP_TO_DATE_MS = 3000

/** How many shelf cards mount at a time. The shelf holds ~1900 entries; one
 * commit of the whole grid is ~28k DOM nodes, so the list renders in batches
 * behind a sentinel (§A1) and grows on scroll. 48 is ~3-4 rows. */
export const SHOP_VISIBLE_BATCH = 48

/** The next number of cards to show: the current window plus one batch,
 * clamped so the window never claims more cards than the list holds. */
export function nextVisibleCount(visible: number, total: number, batch: number): number {
  return Math.min(visible + batch, total)
}

/** Pure install view reducer. A `status` event only applies to the install the
 * view is tracking — a status for an install it never started (idle) is an
 * unrelated event and a no-op, like any other event it does not recognize. */
export function reduceInstall(state: InstallView, event: InstallEvent): InstallView {
  switch (event.type) {
    case 'started':
      return { kind: 'running', installId: event.installId, log: [], phase: phaseOf(event.state) }
    case 'rejected':
      return { kind: 'rejected', code: event.code, detail: event.detail }
    case 'status': {
      if (state.kind !== 'running') return state
      const { status } = event
      // The host retains finished records, so a poll that reports no record
      // after a successful start is genuinely anomalous. Surface the host's
      // own detail when it has one; otherwise the honest generic line.
      if (!status.found) {
        return { kind: 'failed', detail: status.detail ?? 'The installation record is no longer available. Refresh the shop to check whether the plugin was installed.', log: status.log }
      }
      if (!isTerminalInstallState(status.state)) {
        return {
          kind: 'running',
          installId: state.installId,
          log: status.log,
          phase: phaseOf(status.state),
        }
      }
      if (status.state === 'done') {
        // A hot-mount failure rides the done status as a bilingual restart
        // reason (market borrowings §4.2); the view carries it only when the
        // host sent one, so a plain restart keeps the old shape.
        return {
          kind: 'done',
          // `?? 'restart'`, matching the host's own default
          // (`executor.ts` `activationOnDone`). An absent field must never
          // be read as the cheaper outcome: that would publish a success
          // claim the host never made.
          activation: status.activation ?? 'restart',
          // The log rides the terminal state, exactly as it does on `failed`.
          // Without it the log a user was reading vanished the instant the
          // install succeeded — the one outcome that leaves something worth
          // inspecting was the one that showed nothing (reported 2026-09-06).
          log: status.log,
          ...(status.restartReason !== undefined ? { restartReason: status.restartReason } : {}),
          // A note the host attached to a success (the plugin manager's
          // `overridden`). Host copy, rendered as it came, like a failure's.
          ...(status.detail !== undefined ? { detail: status.detail } : {}),
        }
      }
      return { kind: 'failed', detail: status.detail ?? '', log: status.log, ...(status.command !== undefined ? { command: status.command } : {}) }
    }
  }
}


/**
 * Which order the shelf is in (design 2026-10-12-shelf-orders). `stars` is
 * the default AND the tie-break of both date orders, so the two date orders
 * are stable re-sorts of it rather than orders with comparators of their own.
 */
const SHELF_ORDER_KEYS = {
  stars: 'sortStars',
  added: 'sortAdded',
  updated: 'sortUpdated',
} as const

/** The order vocabulary as a type, derived from the map above so the client
 * never repeats the three literals. */
export type ShelfOrder = keyof typeof SHELF_ORDER_KEYS

/** The three orders in display order (map insertion order). `readonly`: this
 * is a shared vocabulary, and an order list a caller can push to is a bug
 * waiting for its second caller. */
export const SHELF_ORDERS: readonly ShelfOrder[] = Object.keys(SHELF_ORDER_KEYS) as ShelfOrder[]

/** The locale key naming one order (the toggle's buttons). */
export function shelfOrderLocaleKey(order: ShelfOrder): ShopLocaleKey {
  return SHELF_ORDER_KEYS[order]
}

const CATEGORY_KEYS = {
  tool: 'categoryTool',
  provider: 'categoryProvider',
  ui: 'categoryUi',
  workflow: 'categoryWorkflow',
  integration: 'categoryIntegration',
  theme: 'categoryTheme',
  other: 'categoryOther',
} as const

/** The locale key for one entry's category — derived entries read as `other`
 * (§6.1: a derived listing has no declared category). */
export function categoryKey(entry: CatalogEntry): ShopLocaleKey {
  return CATEGORY_KEYS[entry.catalog?.category ?? 'other']
}

/** The category vocabulary as a type, derived from the map above so the
 * client never repeats the seven literals. */
export type Category = keyof typeof CATEGORY_KEYS

/** The seven categories in display order (map insertion order). */
export const CATEGORY_ORDER = Object.keys(CATEGORY_KEYS) as Category[]

/** The locale key for one bare category value (the filter buttons). */
export function categoryLocaleKey(category: Category): ShopLocaleKey {
  return CATEGORY_KEYS[category]
}

/**
 * The npm package page for one entry, or null when there is none to link.
 *
 * The name is untrusted catalog input and this CONSTRUCTS a URL from it, so
 * only a name inside the npm grammar gets a link — one optional `@scope/`
 * segment, then a name, both limited to npm's own character set. Every
 * character that survives that check is already safe in a URL path, so the
 * value is used verbatim: percent-encoding it would only mangle the `@` and
 * the scope separator that npm's own URLs carry literally. Anything else —
 * a traversal, a query, a whole URL smuggled in as a name — answers null and
 * the row renders as plain text, the same rule the repository row applies.
 *
 * A github entry answers null: it is installed from a repo and has no npm
 * package page.
 */
/**
 * Whether this entry has a GitHub home the reader could go and inspect.
 *
 * True for a github-source entry — a repository IS its identity — and for an
 * npm entry whose `repository` points at github.com, which is 4892 of the
 * live catalog's 4915 entries. The mark is therefore ordinary and its
 * ABSENCE is the signal: a listed package with no public source to read.
 *
 * `repository` is untrusted catalog input, so the host is PARSED rather than
 * pattern-matched — `evil-github.com` and `github.com.evil.test` both end in
 * the string and neither is GitHub. An unparseable or empty value (two live
 * entries carry one) is simply not a GitHub home.
 */
export function hasGithubHome(entry: CatalogEntry): boolean {
  if (entry.source === 'github') return true
  if (entry.repository === null) return false
  try {
    const host = new URL(entry.repository).hostname.toLowerCase()
    return host === 'github.com' || host === 'www.github.com'
  } catch {
    // Not a URL at all: no home to point at, and nothing to claim.
    return false
  }
}

/**
 * Who put this entry where it is — the fact a reader wants when two listings
 * carry the same text from different hands.
 *
 * The two sources answer it differently and neither is npm's `author` field:
 * that one is free text the publisher writes, and a clone inherits it
 * verbatim. An npm entry answers with the account npm recorded for the
 * version (`publisher`); a github entry answers with its repository owner,
 * which is already half of the `owner/slug` that IS its identity — so nothing
 * new has to be harvested or emitted for it.
 *
 * `repo` reaches the client as an unvalidated string, so the owner is taken
 * only from a value that really is `owner/slug` with an owner GitHub would
 * accept (1-39 chars of alphanumerics and hyphens). Anything else yields
 * null: a misleading fragment is worse than saying nothing, the same rule
 * npmPageUrl applies to a package name.
 */
export function authorOf(entry: CatalogEntry): string | null {
  if (entry.source === 'github') {
    if (entry.repo === undefined) return null
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/[^/]+$/.exec(entry.repo)
    return match?.[1] ?? null
  }
  return entry.publisher ?? null
}

export function npmPageUrl(entry: CatalogEntry): string | null {
  if (entry.source !== 'npm') return null
  return npmPackageUrl(entry.name)
}

/** The npm page of one package name, or null when the name is not one npm
 * could have. The validation lives here, once, because both the entry's own
 * link and the update row's version link build the same path from a name that
 * is untrusted on one of them (`ShopInstalledEntry.name` is a profile
 * manifest key).
 */
function npmPackageUrl(name: string): string | null {
  // 214 is npm's own limit; the segment checks reject `.`/`..` so the path
  // cannot climb out of /package/.
  if (name.length === 0 || name.length > 214) return null
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) return null
  if (name.split('/').some(segment => segment === '.' || segment === '..' || segment === '@')) return null
  return `https://www.npmjs.com/package/${name}`
}

/** A GitHub `owner/slug`: letters, digits, dot, dash, underscore, one slash. */
const GITHUB_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/** Whether `repo` is a GitHub identity this code will put in a URL path. The
 * grammar alone admits `.` and `..`, which the URL parser then reads as path
 * segments — the same hole `npmPageUrl` closes on the npm side. */
function isGithubRepo(repo: string): boolean {
  return GITHUB_REPO.test(repo) && repo.split('/').every(segment => segment !== '.' && segment !== '..')
}

/**
 * The GitHub `owner/slug` a plugin's repository lives on, from either the
 * entry's `repo` (a github source holds it directly) or its `repository` URL
 * (an npm source holds a URL), or null when neither names one this code will
 * put in a URL path (design 2026-11-05-failure-report.md §1).
 *
 * The URL forms npm actually sees are handled: `https://github.com/o/s`,
 * `git+https://…`, `git@github.com:o/s.git` and the `github:o/s` shorthand.
 * Everything else — a GitLab URL, a shorthand that names another host — is
 * null rather than a guess: an issue filed on the wrong repository is worse
 * than no link.
 */
export function githubSlugOf(repo: string | null | undefined, repository: string | null | undefined): string | null {
  if (repo !== null && repo !== undefined && isGithubRepo(repo)) return repo
  if (repository === null || repository === undefined) return null
  const text = repository.trim()
  if (text === '' || text.length > 512) return null
  // `github:owner/slug` is npm's shorthand for the https URL.
  const shorthand = /^github:([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/.exec(text)
  if (shorthand !== null) {
    const slug = shorthand[1] ?? ''
    return isGithubRepo(slug) ? slug : null
  }
  // `git@github.com:owner/slug.git` and `ssh://git@github.com/owner/slug`.
  const scp = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(text)
  if (scp !== null) {
    const slug = scp[1] ?? ''
    return isGithubRepo(slug) ? slug : null
  }
  let url: URL
  try {
    url = new URL(text.replace(/^git\+/, ''))
  } catch {
    return null
  }
  if (url.hostname !== 'github.com') return null
  const path = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '')
  return isGithubRepo(path) ? path : null
}

/**
 * How much of a failure a prefilled issue carries. The body is a URL query
 * parameter, and a browser or proxy cuts one off somewhere past a few
 * kilobytes; the last lines of a log are the interesting ones, and the first
 * are the ones a reporter can scroll back for.
 */
const REPORT_DETAIL_MAX = 1200
const REPORT_LOG_MAX = 1500
const REPORT_LOG_LINES = 20
/** The longest the body may be once URL-encoded, which is what a link pays. */
const REPORT_ENCODED_MAX = 6000

/** ANSI colour and cursor sequences: a rendered log never shows them, and a
 * pasted issue should not either. */
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g

/** What the failure report needs from the flow it reports. */
export interface FailureReportInput {
  verb: 'install' | 'update'
  name: string
  version: string
  source: 'npm' | 'github'
  /** Already resolved `owner/slug`, or null when the entry names none. */
  repo: string | null
  /** The host's published copy, which a failure may leave empty. */
  detail: string
  log: readonly string[]
  /** The running shop's version, when the tab knows it. */
  shopVersion?: string
}

/**
 * A prefilled GitHub issue against the plugin's own repository, or null when
 * no honest one can be built (design 2026-11-05-failure-report.md §1).
 *
 * The shop fills in what it knows and says so in the first line, so a
 * reporter is not handed a form that pretends to be complete. It never
 * claims a harness version it does not have: the author asks for
 * `dsh --version` in their template, and a wrong one would send the report
 * down the wrong path.
 */
export function failureReportUrl(input: FailureReportInput): string | null {
  if (input.repo === null || !isGithubRepo(input.repo)) return null
  // A cut keeps what matters at each end: the detail its start, where the
  // host states the cause; the log its end, where the failure is.
  const keepStart = (text: string, max: number): string => text.length <= max ? text : `${text.slice(0, max).trimEnd()} … (truncated)`
  const keepEnd = (text: string, max: number): string => text.length <= max ? text : `… (truncated; the full log is in the shop)\n${text.slice(text.length - max).trimStart()}`
  const logSource = input.log
    .join('\n')
    .replace(ANSI, '')
    .split('\n')
    .filter(line => line !== '')
    .slice(-REPORT_LOG_LINES)
    .join('\n')
  const detailSource = input.detail.replace(ANSI, '').trim()
  const verb = input.verb === 'update' ? 'Update' : 'Install'
  let detailMax = REPORT_DETAIL_MAX
  let logMax = REPORT_LOG_MAX
  const compose = (): string => [
    '<!-- The shop filled in what it knows. Edit anything that is wrong. -->',
    '',
    '### What I did',
    `\`${verb}\` \`${input.name}@${input.version}\` from ${input.source}, through the shop.`,
    '',
    '### What happened',
    detailSource === '' ? '(the shop recorded no detail)' : keepStart(detailSource, detailMax),
    '',
    '### Log',
    '```',
    keepEnd(logSource, logMax),
    '```',
    '',
    '### Environment',
    `- dsh-plugin-shop: ${input.shopVersion ?? 'unknown'}`,
    '- dsh: <!-- paste the output of `dsh --version` -->',
  ].join('\n')
  // A URL survives about 8 KiB in every client that opens one, and a body of
  // Chinese text costs nine encoded characters per character. The longer of
  // the detail and the log gives up a fifth at a time until the ENCODED body
  // fits. Only those two are cut: the environment block and the log's fences
  // are kept whole. The whole body used to be cut from its end, which took
  // the shop's version and the `dsh --version` marker out of exactly the long
  // non-ASCII reports (design 2026-11-05-failure-report.md §1, 2026-11-06).
  let body = compose()
  while (encodeURIComponent(body).length > REPORT_ENCODED_MAX) {
    const logShown = Math.min(logMax, logSource.length)
    const detailShown = Math.min(detailMax, detailSource.length)
    if (logShown === 0 && detailShown === 0) break
    if (logShown >= detailShown) logMax = Math.floor(logShown * 0.8)
    else detailMax = Math.floor(detailShown * 0.8)
    body = compose()
  }
  const title = `${verb} failed: ${input.name}@${input.version}`
  return `https://github.com/${input.repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`
}

/** A version segment safe to put in one URL path piece. */
const URL_VERSION = /^[A-Za-z0-9._+-]{1,256}$/

/**
 * Where an update's changes can be read, or null when no link can be built
 * honestly (design 2026-11-02-market-borrowings §4).
 *
 * Built from the installed row alone, never from `entry.repository`: that
 * field is author-declared text and is not the install source, so a link made
 * from it could send a reader to a repository that serves different code.
 * `row.repo` is the catalog's own github identity, the thing that installed.
 *
 * - npm: the npm page of the target version, which lists its own release
 *   notes when the author wrote them, and its publication date either way.
 * - github commit to commit: the compare view, which is the diff itself.
 * - anything else on github (a release tag, or a value that is not a commit):
 *   the repository's releases, which exists even when no release does.
 */
export function whatChangedUrl(row: {
  source: 'npm' | 'github'
  name: string
  repo?: string
  installed: string
  latest: string
}): string | null {
  if (row.source === 'npm') {
    const base = npmPackageUrl(row.name)
    if (base === null || !URL_VERSION.test(row.latest)) return null
    return `${base}/v/${row.latest}`
  }
  if (row.repo === undefined || !isGithubRepo(row.repo)) return null
  if (COMMIT_PIN.test(row.installed) && COMMIT_PIN.test(row.latest)) {
    return `https://github.com/${row.repo}/compare/${row.installed}...${row.latest}`
  }
  // Design §4: a commit target has its own page even when the installed side
  // is a tag; a release tag has its tag page. `/releases` is the fallback for
  // a value that is neither — and for a tag this grammar does not accept in a
  // path segment, since GitHub tags may carry `/`.
  if (COMMIT_PIN.test(row.latest)) return `https://github.com/${row.repo}/commit/${row.latest}`
  if (URL_VERSION.test(row.latest)) return `https://github.com/${row.repo}/releases/tag/${row.latest}`
  return `https://github.com/${row.repo}/releases`
}

/**
 * One entry's install identity — the value the catalog guarantees unique, and
 * therefore the only safe React key for a shelf card.
 *
 * `name` is NOT unique. The catalog's uniqueness invariant is the install
 * identity (registry `emit.ts` assertCatalogInvariants): `npm:<name>` for an
 * npm entry, `github:<repo>#<subdir>` for a repo one — so two GitHub
 * repositories publishing the same `package.json` name are two legitimate
 * entries under one name, as are two subpackages of one monorepo. How many
 * such names the catalog holds is kept in ONE place — `validateInstall`'s
 * docstring in host/install.ts, with the way to re-derive it — because the
 * copy that stood here had drifted to less than half the real figure.
 *
 * Keying the shelf by name handed React duplicate keys, and React could then
 * no longer match a card to its DOM node: changing the filter left every
 * duplicate orphaned on the page — hundreds of stale cards from the previous
 * category, accumulating with each switch until the tab stopped responding.
 * This mirrors the registry's identity verbatim; the two must not drift.
 */
export function entryKey(entry: CatalogEntry): string {
  return identityKey(entry)
}

/**
 * Whether the shelf lists `entry`: a name the catalog's `notAShop` clears,
 * or one whose name and repository `isShopLike` leaves alone. One rule for
 * the shelf and for the Plugins page's "View in Plugin shop" (design
 * 2026-10-16-shop-sidebar-page §7), so that button never sends a reader to a
 * shelf that hides the plugin.
 */
export function listedOnShelf(entry: CatalogEntry, cleared: ReadonlySet<string>): boolean {
  return cleared.has(entry.name) || (!isShopLike(entry.name) && (entry.repo === undefined || !isShopLike(entry.repo)))
}

/**
 * An entry's icon as the catalog's data URL, or undefined to draw the default:
 * it declares none, the catalog predates the icons file, or the sidecar
 * degraded and the map does not carry its sha256. The map is keyed by 64-hex
 * sha256, so no name from the catalog is ever used as a lookup here (design
 * 2026-10-23-shop-plugin-icons §7).
 */
export function iconOf(entry: CatalogEntry | undefined, icons: Readonly<Record<string, string>>): string | undefined {
  const sha = entry?.icon
  if (sha === undefined) return undefined
  return Object.hasOwn(icons, sha) ? icons[sha] : undefined
}

/**
 * One entry's star count from the sidecar, or undefined when it has none.
 *
 * The sidecar keys a github entry by its repo full name and an npm entry by
 * its package name — two disjoint keyspaces (registry `stars-assemble.ts`).
 * Every reader must go through this one function: the card read the repo key
 * and the shelf sort read the name, so for 2202 of the live catalog's 2210
 * github listings the number deciding a row's position was not the number
 * printed on it. 1590 of them sorted as unstarred — a 4014-star plugin at the
 * bottom of the shelf — and where an unrelated npm package happened to share
 * a listed entry's name, its stars ranked that entry instead: a 1-star
 * plugin held the first page on 13960 stars belonging to another project's
 * repo, one the catalog never even listed.
 */
export function starsOf(entry: CatalogEntry, stars: Record<string, number>): number | undefined {
  const key = entry.repo ?? entry.name
  // Package names are untrusted keys; never borrow Object.prototype members
  // such as `constructor` or `toString` as if they were star counts.
  if (!Object.hasOwn(stars, key)) return undefined
  return stars[key]
}

/** One collator for the whole shelf. Passing an options object to
 * localeCompare creates a collator per comparison, which dominates the sort
 * for a catalog with thousands of entries. */
const NAME_COLLATOR = new Intl.Collator(undefined, { sensitivity: 'base' })

/** Sort the shelf: stars descending, un-starred entries last, name ascending
 * (case-insensitive) on ties (spec 2026-08-26-github-stars-design.md D1).
 * Display-time only — the catalog's own name sort is untouched. */
export function sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[] {
  // -1, never 0: a repo with a real count of zero still sorts above an entry
  // the sidecar has no count for at all.
  const count = (e: CatalogEntry): number => starsOf(e, stars) ?? -1
  return [...entries].sort((a, b) => {
    const byStars = count(b) - count(a)
    if (byStars !== 0) return byStars
    return NAME_COLLATOR.compare(a.name, b.name)
  })
}

/** The day form the registry writes into `added` (`emit.ts` E9 enforces it
 * on every build on its side; a catalog is untrusted input on this side). */
const DAY_FORM = /^\d{4}-\d{2}-\d{2}$/

/**
 * The ES date-time form WITH an explicit zone. The zone is required, and not
 * for tidiness: a date-time string with no zone is parsed as LOCAL time, so
 * accepting one would make the shelf's order depend on the machine.
 */
const INSTANT_FORM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * One date string as milliseconds, or undefined when it cannot be trusted.
 *
 * The form is checked BEFORE `Date.parse`, and that order is load-bearing:
 * V8 answers a real instant for `2026-02-31T00:00:00Z` (3 March) and for
 * `October 12` (a 2001 date), so `Date.parse` alone is not a validity test.
 */
function parseForm(value: unknown, form: RegExp): number | undefined {
  if (typeof value !== 'string' || !form.test(value)) return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/** `shelfTime` with the catalog's build time already parsed, for the n calls
 * `orderShelf` makes in one pass. */
function timeOf(entry: CatalogEntry, order: ShelfOrder, built: number | undefined): number | undefined {
  if (order === 'stars') return undefined
  const ms = order === 'added'
    ? parseForm(entry.added, DAY_FORM)
    : parseForm(entry.publishedAt, INSTANT_FORM)
  if (ms === undefined || built === undefined || ms > built) return undefined
  return ms
}

/**
 * The entry's sort key under a date order, or undefined when it has no usable
 * date (design §3): absent, off-form, unparseable, or later than the catalog's
 * own `builtAt`. Milliseconds since the epoch. `'stars'` carries no date, so
 * this answers undefined for it.
 */
export function shelfTime(entry: CatalogEntry, order: ShelfOrder, builtAt: string): number | undefined {
  return timeOf(entry, order, parseForm(builtAt, INSTANT_FORM))
}

/**
 * A UTC calendar day for display: "2026-10-12". Derived from the instant the
 * sort ranked by, so a card's label and its position cannot disagree. UTC and
 * never a local getter: a reader in UTC+8 must see the same days the catalog
 * was built in, the calendar the stats row already prints.
 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * The shelf in `order` (design 2026-10-12-shelf-orders §2, §5). `'stars'`
 * returns the array it was handed, so the default path allocates nothing and
 * does not invalidate the memos downstream of it.
 *
 * Each key is computed ONCE per entry rather than inside the comparator, and
 * the sort is stable (ES2019), so entries sharing a date keep the star order
 * they arrived in — which is how the tie-break is defined without a second
 * comparator that could drift from `sortByStars`.
 */
export function orderShelf(
  starOrdered: readonly CatalogEntry[],
  order: ShelfOrder,
  builtAt: string,
): readonly CatalogEntry[] {
  if (order === 'stars') return starOrdered
  const built = parseForm(builtAt, INSTANT_FORM)
  const keyed = starOrdered.map(entry => ({ entry, time: timeOf(entry, order, built) }))
  keyed.sort((a, b) => {
    if (a.time === undefined) return b.time === undefined ? 0 : 1
    if (b.time === undefined) return -1
    return b.time - a.time
  })
  return keyed.map(item => item.entry)
}

/** 999 → "999"; 1000 → "1k"; 1234 → "1.2k"; 1500 → "1.5k"; 99999 → "100k". */
export function formatStars(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

/**
 * One entry's on-disk size as a label: 0 → "0 B", 812 → "812 B",
 * 25283 → "25.3 kB", 847407 → "847.4 kB", 179562863 → "179.6 MB".
 *
 * Decimal kB/MB, not KiB/MiB, because on the npm side the number IS npm's
 * `dist.unpackedSize` and npm's own package page shows it decimal — a reader
 * comparing the shelf against npmjs.com must not find two different figures
 * for one package. A github figure is a different measurement (its git tree's
 * blobs) but not a different unit, so one rule serves both. One fractional
 * digit at every magnitude above a kilobyte, the same rule `formatStars`
 * follows: a column of sizes is read by comparing them down the shelf, and
 * switching precision by magnitude makes that column ragged for no gain.
 *
 * Locale-free by construction (`toFixed`, not `toLocaleString`): the shelf's
 * two languages must not disagree about what a size is, and a decimal comma
 * in one of them would read as a thousands separator in the other.
 *
 * Undefined in, undefined out — an npm publish predating npm 5.6, or an entry
 * the registry could not measure honestly (`tree-size.ts` enumerates each way
 * that happens), and the card renders no label rather than a guess. The caller
 * need not check first.
 *
 * This once read "a github entry", which was true only while the shelf read
 * `unpackedSize` alone. It is not a source distinction any more: every live
 * github entry carries an `installSize`, and the sizeless count the build
 * report prints is owned by `emit.ts` — read it there rather than from a copy
 * here, because it tracks the daily build.
 */
export function formatSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined) return undefined
  if (bytes < 1000) return `${bytes} B`
  // GB is here for the tail, not for show: the largest live listing measured
  // 179 MB on 2026-09-07, and without this rung a gigabyte package would read
  // "1000.0 MB" — a number a reader has to divide in their head.
  //
  // The climb tests the ROUNDED value, not the raw one, because one fractional
  // digit is what the reader sees: 999_999 B is 999.999 kB, which `toFixed(1)`
  // renders "1000.0". Testing the raw value let that mantissa carry across the
  // boundary without the unit following, so every count in [999_950_000,
  // 1_000_000_000) printed the exact "1000.0 MB" this rung was added to
  // prevent — the rung could not help, because the carry happens below it.
  let value = bytes
  let unit = 'B'
  for (const next of ['kB', 'MB', 'GB']) {
    if (Number(value.toFixed(1)) < 1000) break
    value /= 1000
    unit = next
  }
  return `${value.toFixed(1)} ${unit}`
}
