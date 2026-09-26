/** Harness compatibility as the AUTHOR states it: which `dsh.compatibility`
 * declarations the running installation does not meet (design
 * 2026-09-01-harness-compatibility §8.2, as amended §9.9). The presence check
 * in `peers.ts` infers from what a plugin imports; this reads what its author
 * wrote down. And, from dsh 0.1.7 on, what dsh ITSELF refuses: the harness
 * peers its installer rejects an install on (`peerVerdictsOf`, design
 * 2026-09-26-dsh-017-readiness, B1).
 *
 * Pure: the running version, the running profile, the harness's own
 * template table and its peer check arrive as arguments, so fixtures drive
 * every verdict and the reads of the installation stay outside — the running
 * dsh, its template table and its peer check in `harness.ts`, the running
 * profile's bundles and exemptions in the gateway. */

import { parse, satisfies, valid, validRange } from 'semver'
import { identityKey, type EntryIdentity } from '../shared/identity.ts'
import type { PeerCheck } from './harness.ts'

/** What an author declared in `dsh.compatibility` that this installation does
 * not meet. Each half is present only when the author declared it AND it is
 * unmet here, and carries both sides, so the reader is told what was declared
 * and what is actually running rather than only that something is wrong. */
export interface HarnessVerdict {
  /** The declared `dsh` range, and the `@deepseek-ai/dsh` version running. */
  dsh?: { range: string; running: string }
  /** The declared profile templates, and the name of the profile this dsh was
   * booted with. */
  profile?: { declared: string[]; running: string }
  /** What the running dsh refuses this install on — no author's claim, and
   * the one half the shop blocks an install for (`PeerVerdict`). */
  peers?: PeerVerdict
}

/**
 * An install the running dsh will refuse (0.1.7 on): the harness peers it
 * refuses, each with the range the package declared; the dsh version it
 * judged them against; and the command that records dsh's exact-version
 * exemption for this package on this dsh, after which dsh installs it. The
 * command is null when dsh would refuse that too (`allowVersionCommand`).
 */
export interface PeerVerdict {
  refused: Record<string, string>
  running: string
  allowCommand: string | null
}

/** The running profile as the profile half needs it: its name, for the copy,
 * and the bundles it composes, for the comparison. `bundles` is null when the
 * profile manifest could not be read, which is no verdict rather than an
 * accusation. */
export interface RunningProfile {
  name: string
  bundles: readonly string[] | null
}

/** The running side of the comparison. `dshVersion` is null when the
 * running dsh's version could not be read — this process was not started by
 * dsh's CLI, or that CLI's manifest carries none (`harness.ts`). The profile
 * is always known, because the gateway asking was booted inside one — but
 * what it composes may not be. */
export interface HarnessRuntime {
  dshVersion: string | null
  profile: RunningProfile
}

/** Harness profile template name → the bundles that template composes, or an
 * empty record when the harness's own table could not be read. The names are
 * matched against catalog input, so a reader takes own keys only
 * (`unmetProfile`), and `profileTemplatesOf` builds one with no prototype. */
export type ProfileTemplates = Readonly<Record<string, readonly string[]>>

/**
 * Normalize the harness's OWN `PROFILE_TEMPLATES` into template name → bundle
 * names, or an empty record for a shape this build does not know.
 *
 * Two shapes exist and both are live: 0.1.5-rc.3 maps a name to
 * `{ bundles, patchReload }` (five templates), while the version this package
 * pins as a devDependency maps it to a bare array (two). A name whose value is
 * neither, or whose bundle list holds a non-string, is dropped rather than
 * guessed at — an unreadable table means no profile verdict, never a wrong
 * one. Copied from nowhere: the caller passes the harness's exported object.
 *
 * The record has NO PROTOTYPE, empty answer included. It is indexed by the
 * profile names a catalog entry declares, which are hostile input, and a
 * record built on `{}` answered `constructor`, `__proto__`, `toString`,
 * `hasOwnProperty` and `valueOf` from `Object.prototype`: a value that passed
 * the `undefined` guard and threw out of `compatibilityMap`, so one entry
 * declaring `profiles: ["constructor"]` rejected every `catalog()` call for
 * every user. Without a prototype there is also no `__proto__` setter, so a
 * template exported under that name stays an own key instead of replacing
 * the record's prototype. `unmetProfile` takes own keys only as well — the
 * type is exported, and a caller may hand in a plain object.
 */
export function profileTemplatesOf(exported: unknown): ProfileTemplates {
  const templates: Record<string, readonly string[]> = Object.create(null)
  if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) return templates
  for (const [name, value] of Object.entries(exported as Record<string, unknown>)) {
    const bundles = Array.isArray(value)
      ? value
      : value !== null && typeof value === 'object'
        ? (value as { bundles?: unknown }).bundles
        : undefined
    if (!Array.isArray(bundles)) continue
    if (!bundles.every((bundle): bundle is string => typeof bundle === 'string')) continue
    templates[name] = bundles
  }
  return templates
}

/**
 * Install identity → the half or halves of an entry's declaration this
 * installation does not meet. A key is present only when something was
 * declared AND is unmet, so an absent key means "runs here, or we could not
 * tell" — the rule `incompatibilityMap` follows, and for the same reason: one
 * false warning teaches a reader to ignore every warning.
 *
 * The halves are judged apart, and an unknown on either side silences only its
 * own half:
 *
 * - `dsh` needs a range semver can parse and a running version that is semver,
 *   and is then `satisfies` with `includePrerelease`. That option is
 *   load-bearing: the harness ships nothing but prereleases, and strict semver
 *   refuses a prerelease against any range whose comparators carry none —
 *   `0.1.5-rc.3` fails `>=0.1.0`, and even `*` — so every author who wrote a
 *   plain range would be told they exclude a harness their range includes.
 *
 *   What the option does NOT do is read a range the way its author probably
 *   meant it. Under it a prerelease is compared like any other version, and a
 *   prerelease sorts BELOW its own release (measured with semver 7.8.5; the
 *   rows are pinned in compatibility.test.ts):
 *   - An upper bound written without `-0` admits the next line's
 *     prereleases: `<0.2.0` and `>=0.1.0 <0.2.0` both admit `0.2.0-rc.1`.
 *     Only a bound that desugars to `<0.2.0-0` refuses it — `^0.1.0`,
 *     `~0.1.0` and `0.1.x` do, as does `<0.2.0-0` written out.
 *   - A floor written without `-0` refuses its own prereleases: `>=0.1.5`,
 *     `^0.1.5` and `0.1.5` all refuse `0.1.5-rc.3`, because `0.1.5` sorts
 *     above it. `>=0.1.5-0` admits every `0.1.5-rc.N`.
 *   So `>=0.1.5-0` and `<0.2.0-0` are the spellings that say what an author
 *   usually means. The comparison stays semver's own and is never rewritten
 *   here: a verdict that coerced prereleases would answer differently from
 *   semver, which is what an author checks a range against. An exact list of
 *   other versions — `@xmanrui/dsh-im`'s declaration — is refused, as it
 *   should be.
 * - `profile` is met when the running profile's NAME is one of the declared
 *   names, or when it composes every bundle of a declared template.
 *
 *   The name is trusted for the names dsh ships, because for those it is not
 *   the reader's choice. On 0.1.5-rc.3 both paths that create a missing
 *   profile build one of a shipped name from that name's template
 *   (dsh-app-boot's `loadProfile`, and `dsh plugin`), and dsh refuses a
 *   shipped name as the target of `--from-default-profile`, so a profile
 *   carrying one was built from that template. That is all the name
 *   guarantees: which template the profile was built from, not what it
 *   composes now. Nothing holds the bundle list to the template afterwards:
 *   `dsh plugin`'s reconcile, not app-boot, appends each bundle it installs,
 *   and app-boot's `normalizeShippedProfile` rewrites only a list that is
 *   exactly a retired tuple or the current one. Bundles alone could not
 *   decide there: a profile keeps the bundle list it was created with, so the
 *   first harness release that added a bundle to `web` would badge every
 *   `profiles: ["web"]` plugin (`@xmanrui/dsh-im`) on every existing `web`
 *   profile, with copy saying it supports web and this dsh was launched with
 *   web.
 *
 *   Any other name is the reader's choice — `dsh --profile rescue
 *   --from-default-profile web` builds a profile called `rescue` from the web
 *   bundles, and dsh records nothing about which template it came from — so a
 *   running name no declaration matches is judged by what the profile IS:
 *   each declared name is read as one of the harness's own templates, met
 *   when every bundle of that template is in the running profile's bundles. A
 *   declared name that is no template — an own key of the table, never an
 *   inherited one — cannot be judged, and a list with such a name and no met
 *   template gives no verdict. The half is unmet only when the running name is
 *   not declared and every declared name is a template this profile does not
 *   compose — see the amendment for the whole rule.
 *
 *   The residual, knowingly kept: a custom-named profile is still judged by
 *   bundles, so a template that later gained a bundle would badge the custom
 *   profiles created before the change. No PUBLISHED
 *   `@deepseek-ai/dsh-app-boot` had changed a template's bundle list as of
 *   2026-09-25: all 28 versions, read that day, give every template they
 *   share the same list. One list was retired before the first publish:
 *   every published app-boot, from the first, carries a retired `headless`
 *   tuple (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`,
 *   `@deepseek-ai/dsh-headless`) in `INSTALLATION_OWNED_PROFILE_TUPLES`, and
 *   `normalizeShippedProfile` rewrites a `headless` profile carrying exactly
 *   that list to the current template when it loads.
 */
export function compatibilityMap(
  entries: readonly (EntryIdentity & { compatibility?: { dsh?: string; profiles?: string[] } })[],
  runtime: HarnessRuntime,
  templates: ProfileTemplates,
): Record<string, HarnessVerdict> {
  // `satisfies` answers false for a version it cannot parse, which would read
  // as an accusation, so an unparseable running version is no version at all.
  const running = runtime.dshVersion !== null && valid(runtime.dshVersion) !== null ? runtime.dshVersion : null
  const out: Record<string, HarnessVerdict> = {}
  for (const entry of entries) {
    const declared = entry.compatibility
    if (declared === undefined) continue
    const verdict: HarnessVerdict = {}
    const range = declared.dsh
    if (range !== undefined && running !== null && validRange(range) !== null
      && !satisfies(running, range, { includePrerelease: true })) {
      verdict.dsh = { range, running }
    }
    const unmet = unmetProfile(declared.profiles, runtime.profile, templates)
    if (unmet !== null) verdict.profile = { declared: [...unmet], running: runtime.profile.name }
    if (verdict.dsh !== undefined || verdict.profile !== undefined) out[identityKey(entry)] = verdict
  }
  return out
}

/**
 * The declared profile list to report, or null when nothing is owed: met,
 * unjudgeable, or nothing declared. See `compatibilityMap` for the rule, why
 * a matching name is enough, and why bundles decide for any other name.
 */
function unmetProfile(
  declared: readonly string[] | undefined,
  running: RunningProfile,
  templates: ProfileTemplates,
): readonly string[] | null {
  // An empty list names no profile at all, which is not a claim that none is
  // supported.
  if (declared === undefined || declared.length === 0) return null
  // The running profile carries a declared name: met, bundles unread.
  if (declared.includes(running.name)) return null
  // An unreadable bundle list is a fact nobody could establish.
  if (running.bundles === null) return null
  const composed = new Set(running.bundles)
  let unjudged = false
  for (const name of declared) {
    // Own keys only: `name` is catalog input, and an inherited
    // `Object.prototype` member is no template (see `profileTemplatesOf`).
    const bundles = Object.hasOwn(templates, name) ? templates[name] : undefined
    // A name no harness ships: nothing to compare it against, so silence.
    if (bundles === undefined) {
      unjudged = true
      continue
    }
    if (bundles.every(bundle => composed.has(bundle))) return null
  }
  // Every name was a template this profile does not compose only when nothing
  // was left unjudged. One unknown name makes the whole list an unknown.
  return unjudged ? null : declared
}

/**
 * Install identity → the refusal the running dsh will make, for each entry
 * whose harness peers it refuses and the profile has not exempted. A key is
 * present only for a refusal, so an absent key means "dsh installs it, or we
 * could not tell".
 *
 * The rule is dsh's own (`check`, from the running app-boot), handed the
 * manifest dsh's installer reads before it installs a registry spec — `pnpm
 * view <spec> name version peerDependencies`, measured in dsh-plugin-manager
 * 0.1.7-rc.2 — with the catalog's `dshPeers` for the peers. Those are the
 * only peers the rule reads, verbatim. What this cannot see errs toward
 * silence, never toward a refusal dsh would not make: a malformed peer range
 * elsewhere in the manifest, which dsh rejects only after installing, and
 * the plugins a bundle's patch rows name, which it checks then too. Those
 * reach the reader as the install's own failure (`installFailureDetail`).
 *
 * npm entries only. dsh keys an exemption by the INSTALLED manifest's
 * `name@version`, and a github entry's catalog version is a commit: its
 * exemption status cannot be read, and a refusal named here could never be
 * cleared from the shop. dsh refuses such an install itself, and says how
 * to exempt it.
 *
 * A throw from the check forms no verdict for that entry, as a resolver's
 * throw does in `incompatibilityMap`.
 */
export function peerVerdictsOf(
  entries: readonly (EntryIdentity & { version: string; dshPeers?: Record<string, string> })[],
  check: PeerCheck,
  exemptions: Record<string, string[]>,
  profile: string,
): Record<string, PeerVerdict> {
  const out: Record<string, PeerVerdict> = {}
  for (const entry of entries) {
    if (entry.source !== 'npm' || entry.dshPeers === undefined) continue
    let issue: ReturnType<PeerCheck['evaluate']>
    try {
      issue = check.evaluate({ name: entry.name, version: entry.version, peerDependencies: entry.dshPeers }, exemptions)
    } catch {
      // Swallows the rule refusing to judge: a runtime version app-boot
      // cannot parse, or a manifest shape it rejects, which the catalog
      // parse keeps out and only an injected snapshot could carry. An entry
      // nobody can judge is never accused.
      continue
    }
    if (issue === undefined || issue.exempted) continue
    out[identityKey(entry)] = {
      refused: { ...issue.peers },
      running: issue.runtimeVersion,
      allowCommand: allowVersionCommand(profile, issue),
    }
  }
  return out
}

/** npm's package-name grammar as dsh's exemption records accept it, verbatim
 * from app-boot 0.1.7-rc.2 (`PACKAGE_NAME` in profile-compatibility). */
const EXEMPTION_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** A version exactly as dsh's exemption records spell one: canonical semver,
 * build metadata included (app-boot's `isExactPluginVersion`). */
function isExactVersion(value: string): boolean {
  const parsed = parse(value)
  return parsed !== null && value === `${parsed.version}${parsed.build.length === 0 ? '' : `+${parsed.build.join('.')}`}`
}

/**
 * The command that records dsh's exact-version exemption for one refused
 * install, spelled as dsh's own CLI prints it after a refusal — or null when
 * `dsh plugin allow-version` would refuse the package or either version,
 * which it checks against the grammar above. The name and version come from
 * the catalog, which is hostile input bound for a terminal, and the two
 * grammars admit no whitespace, quote, `$`, backtick, `;`, `|`, `&`,
 * redirection or bracket, so no catalog value can add a command to the line
 * it is pasted into.
 *
 * The profile is written as it is, as dsh prints it: it is the reader's own
 * choice of name, never catalog input.
 */
export function allowVersionCommand(profile: string, issue: { name: string; version: string; runtimeVersion: string }): string | null {
  if (!EXEMPTION_PACKAGE_NAME.test(issue.name) || !isExactVersion(issue.version) || !isExactVersion(issue.runtimeVersion)) return null
  return `dsh plugin --profile ${profile} allow-version ${issue.name}@${issue.version} --dsh-version ${issue.runtimeVersion} --accept-risk`
}
