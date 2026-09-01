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
    } catch {
      // Unresolvable is the answer, not an error: the peer is absent, which is
      // precisely the fact being reported.
      return false
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
  const known = new Map<string, boolean>()
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
        } catch {
          // No verdict for this entry; see the doc comment above.
          usable = false
          break
        }
        known.set(spec, present)
      }
      if (!present) missing.push(spec)
    }
    if (usable && missing.length > 0) out[entry.name] = missing
  }
  return out
}
