/** Harness compatibility as the AUTHOR states it: which `dsh.compatibility`
 * declarations the running installation does not meet (design
 * 2026-09-01-harness-compatibility §8.2, as amended §9.9). The presence check
 * in `peers.ts` infers from what a plugin imports; this reads what its author
 * wrote down.
 *
 * Pure: the running version, the running profile and the harness's own
 * template table arrive as arguments, so fixtures drive every verdict and the
 * one read of the installation stays in the gateway. */

import { satisfies, valid, validRange } from 'semver'
import { identityKey, type EntryIdentity } from '../shared/identity.ts'

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
 * installation's version could not be read; the profile is always known,
 * because the gateway asking was booted inside one — but what it composes may
 * not be. */
export interface HarnessRuntime {
  dshVersion: string | null
  profile: RunningProfile
}

/** Harness profile template name → the bundles that template composes, or an
 * empty record when the harness's own table could not be read. */
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
 */
export function profileTemplatesOf(exported: unknown): ProfileTemplates {
  if (exported === null || typeof exported !== 'object' || Array.isArray(exported)) return {}
  const templates: Record<string, readonly string[]> = {}
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
 *   It still refuses what a range genuinely excludes: an exact list of other
 *   prereleases, or a later minor line.
 * - `profile` is judged by WHAT THE RUNNING PROFILE IS, not by what it is
 *   called. A profile's name is the reader's choice — `dsh --profile rescue
 *   --from-default-profile web` builds a profile called `rescue` from the web
 *   bundles, and dsh records nothing about which template it came from — so
 *   comparing names would badge every plugin declaring `profiles: ["web"]` on
 *   every web-app profile not literally named `web`. Each declared name is
 *   read as one of the harness's own templates, and it is met when every
 *   bundle of that template is in the running profile's bundles. A declared
 *   name that is no template cannot be judged; a list with such a name and no
 *   met template gives no verdict. The half is unmet only when every declared
 *   name is a template this profile does not compose — see the amendment for
 *   the whole rule.
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
 * unjudgeable, or nothing declared. See `compatibilityMap` for the rule and
 * why it reads bundles rather than the profile's name.
 */
function unmetProfile(
  declared: readonly string[] | undefined,
  running: RunningProfile,
  templates: ProfileTemplates,
): readonly string[] | null {
  // An empty list names no profile at all, which is not a claim that none is
  // supported, and an unreadable bundle list is a fact nobody could establish.
  if (declared === undefined || declared.length === 0) return null
  if (running.bundles === null) return null
  const composed = new Set(running.bundles)
  let unjudged = false
  for (const name of declared) {
    const bundles = templates[name]
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
