/** Harness compatibility as the AUTHOR states it: which `dsh.compatibility`
 * declarations the running installation does not meet (design
 * 2026-09-01-harness-compatibility §8.2). The presence check in `peers.ts`
 * infers from what a plugin imports; this reads what its author wrote down.
 *
 * Pure: the running version and profile arrive as arguments, so fixtures drive
 * every verdict and the one read of the installation stays in the gateway. */

import { satisfies, valid, validRange } from 'semver'
import { identityKey, type EntryIdentity } from '../shared/identity.ts'

/** What an author declared in `dsh.compatibility` that this installation does
 * not meet. Each half is present only when the author declared it AND it is
 * unmet here, and carries both sides, so the reader is told what was declared
 * and what is actually running rather than only that something is wrong. */
export interface HarnessVerdict {
  /** The declared `dsh` range, and the `@deepseek-ai/dsh` version running. */
  dsh?: { range: string; running: string }
  /** The declared profile names, and the profile this dsh was booted with. */
  profile?: { declared: string[]; running: string }
}

/** The running side of the comparison. `dshVersion` is null when the
 * installation's version could not be read; the profile is always known,
 * because the gateway asking was booted inside one. */
export interface HarnessRuntime {
  dshVersion: string | null
  profile: string
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
 * - `profile` needs a non-empty list. An empty one names no profile at all,
 *   which is not a claim that none is supported.
 */
export function compatibilityMap(
  entries: readonly (EntryIdentity & { compatibility?: { dsh?: string; profiles?: string[] } })[],
  runtime: HarnessRuntime,
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
    const profiles = declared.profiles
    if (profiles !== undefined && profiles.length > 0 && !profiles.includes(runtime.profile)) {
      verdict.profile = { declared: profiles, running: runtime.profile }
    }
    if (verdict.dsh !== undefined || verdict.profile !== undefined) out[identityKey(entry)] = verdict
  }
  return out
}
