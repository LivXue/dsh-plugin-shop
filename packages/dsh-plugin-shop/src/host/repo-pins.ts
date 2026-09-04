/**
 * The Host's memory of which commit it installed for each github entry.
 *
 * pnpm writes the manifest dependency as `github:owner/slug` — no commit —
 * and the resolved commit lives only in the lockfile. The shop records the
 * commit it pinned at install time in its own cache so `installed()` can
 * report `outdated` honestly without parsing pnpm's lockfile. The profile
 * manifest remains the source of truth for *presence*: a pin whose bundle
 * is not a manifest dependency is a leftover from a failed install and is
 * never reported.
 */

import { COMMIT_SHA, RELEASE_TAG } from '../shared/identity.ts'

export interface RepoPinFs {
  exists: (path: string) => boolean
  read: (path: string) => string
  write: (path: string, data: string) => void
}

/** Install identity to the pinned commit or release tag. */
export type RepoPins = Record<string, string>

/** Read the pins file; any irregularity degrades to an empty record. */
export function readRepoPins(fs: RepoPinFs, path: string): RepoPins {
  if (!fs.exists(path)) return {}
  try {
    const parsed = JSON.parse(fs.read(path)) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const out: RepoPins = {}
    for (const [name, pin] of Object.entries(parsed)) {
      if (typeof pin === 'string' && (COMMIT_SHA.test(pin) || RELEASE_TAG.test(pin))) out[name] = pin
    }
    return out
  } catch {
    // A corrupt pins file means "no memory", like a missing one.
    return {}
  }
}

/** Write the pins file atomically enough for its purpose (a cache). */
export function writeRepoPins(fs: RepoPinFs, path: string, pins: RepoPins): void {
  fs.write(path, `${JSON.stringify(pins, null, 2)}\n`)
}
