/** Harness compatibility: which declared peers the running installation does
 * not provide (design 2026-09-01-harness-compatibility). */

import { createRequire } from 'node:module'

/** Answers "can this installation provide `spec`?" — injected so fixtures
 * drive every verdict and exactly one call site touches the filesystem. */
export type PeerResolver = (spec: string) => boolean

/**
 * The production resolver: the same question the harness's own
 * ClientModuleRegistry asks, through a require anchored at the profile. Asking
 * what the loader asks is what keeps this verdict and the runtime's behaviour
 * from drifting apart.
 */
export function nodeResolver(baseUrl: string): PeerResolver {
  const require = createRequire(baseUrl)
  return spec => {
    try {
      require.resolve(`${spec}/package.json`)
      return true
    } catch (error) {
      // Only genuine module-not-found means the peer is absent. Anything else
      // (e.g., ERR_PACKAGE_PATH_NOT_EXPORTED when the module restricts
      // exports) is a resolution error that the harness itself handles by
      // returning no client module — rethrow so incompatibilityMap's catch
      // turns it into no-verdict.
      if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND') {
        return false
      }
      throw error
    }
  }
}

/**
 * Package name → the peer names that did not resolve. A key is present only
 * when at least one peer is missing, so an absent key means "runs here, or we
 * could not tell" — the client renders nothing for either.
 *
 * A resolver that throws yields NO verdict at all: an unavailable fact must
 * never read as an accusation, because one false warning teaches a reader to
 * ignore every warning.
 */
export function incompatibilityMap(
  entries: readonly { name: string; peers?: string[] }[],
  resolve: PeerResolver,
): Record<string, string[]> {
  const known = new Map<string, boolean | null>() // null marks "threw"
  const out: Record<string, string[]> = {}
  for (const entry of entries) {
    if (entry.peers === undefined || entry.peers.length === 0) continue
    const missing: string[] = []
    let usable = true
    for (const spec of entry.peers) {
      let present = known.get(spec)
      if (present === undefined) {
        try {
          present = resolve(spec)
          known.set(spec, present)
        } catch {
          // Resolution threw; mark so we don't retry, and discard this entry's
          // partial list. See the doc comment above.
          known.set(spec, null)
          usable = false
          break
        }
      } else if (present === null) {
        // This name threw before; discard this entry's partial list.
        usable = false
        break
      }
      if (!present) missing.push(spec)
    }
    if (usable && missing.length > 0) out[entry.name] = missing
  }
  return out
}
