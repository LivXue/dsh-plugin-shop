/** The shop's own published version, read from the package.json that ships
 * next to this package — the RUNNING version, not the manifest's range
 * spec. This lives at the package root (not under src/host) on purpose:
 * both the source tree (tests) and the bundled `lib/index.js` sit exactly
 * one level below the package root, so the same relative URL resolves in
 * both. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function ownManifest(): unknown {
  return JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
}

export function ownVersion(): string {
  return (ownManifest() as { version: string }).version
}

/**
 * The peer ranges this build declares — the input to the load-time harness
 * self-check. Read from the same shipped manifest as `ownVersion`, so the
 * ranges checked are the ones this build was actually published with, never
 * a second copy that can drift from them.
 *
 * A non-string range is dropped rather than repaired: only what we can
 * compare against is worth a verdict.
 */
export function ownPeerRanges(): Record<string, string> {
  const declared = (ownManifest() as { peerDependencies?: unknown }).peerDependencies
  if (declared === null || typeof declared !== 'object') return {}
  const ranges: Record<string, string> = {}
  for (const [spec, range] of Object.entries(declared)) {
    if (typeof range === 'string') ranges[spec] = range
  }
  return ranges
}
