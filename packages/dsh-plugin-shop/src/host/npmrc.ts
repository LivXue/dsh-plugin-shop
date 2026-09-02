/** The user's configured npm registry, if they have one (design §3).
 *
 * Pure: the caller injects the read. This is a deliberately partial reading
 * of npm's config resolution — only the user-level `registry=` line — and
 * that is safe precisely because the origin list is raced: a registry we
 * guess wrong about loses a 400-byte request and nothing else.
 *
 * That property only holds for a value that is actually a URL, which is why
 * the value is VALIDATED here rather than left to the caller. `npmOrigin`
 * addresses its probe with `new URL(<pkg>/latest, registryUrl)`, which
 * throws a raw `TypeError` — not a `TransportError` — for anything that is
 * not an absolute URL, and `catalog.ts`'s race loop rethrows everything that
 * is not a `TransportError`. An unvalidated `registry=` line would therefore
 * fail the WHOLE load with npmmirror, npmjs and Pages all healthy and no
 * cache fallback: the opposite of the stated property. Not a hypothetical
 * shape either — `registry=${NPM_REGISTRY}/` is npm's own documented config
 * expansion, it works perfectly for npm, and a reader that does not expand
 * it captures the literal. */

import { join } from 'node:path'

/** The value, if it is an absolute `http:`/`https:` URL; otherwise null.
 *
 * Both halves earn their place. The parse rejects a bare host, a relative
 * path, and an unexpanded `${VAR}`. The scheme check then rejects what
 * `new URL` happily accepts but the raced origins cannot fetch from —
 * `file:` and `ftp:` parse fine and are not registries a `fetch` can read.
 * The raw string is returned rather than the parsed href, so the value the
 * user wrote is what reaches `normalizeRegistryUrl` and the origin id. */
function asRegistryUrl(value: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    // `new URL` is the only expression in the try, and it throws for exactly
    // one reason: the value is not an absolute URL. That is the case being
    // rejected, so there is nothing else to distinguish or report.
    return null
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? value : null
}

/**
 * @param readFile - returns the file's text, or null when it does not exist.
 * @param home - the user's home directory.
 */
export function npmrcRegistry(readFile: (path: string) => string | null, home: string): string | null {
  const text = readFile(join(home, '.npmrc'))
  if (text === null) return null
  for (const line of text.split('\n')) {
    // Unscoped `registry=` only: `@scope:registry=` governs one scope and
    // says nothing about where an unscoped package should come from.
    const match = /^\s*registry\s*=\s*(\S+)\s*$/.exec(line)
    const value = match?.[1]
    if (value === undefined) continue
    const url = asRegistryUrl(value)
    // An unusable value is skipped rather than returned: the line is treated
    // as if it were not a registry line at all, so it can neither reach the
    // race nor mask a usable `registry=` line further down the file.
    if (url !== null) return url
  }
  return null
}
