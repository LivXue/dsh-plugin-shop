/** The user's configured npm registry, if they have one (design §3).
 *
 * Pure: the caller injects the read. This is a deliberately partial reading
 * of npm's config resolution — only the user-level `registry=` line — and
 * that is safe precisely because the origin list is raced: a registry we
 * guess wrong about loses a 400-byte request and nothing else. */

import { join } from 'node:path'

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
    if (value !== undefined) return value
  }
  return null
}
