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

/**
 * Read a version once and keep it: the answer to "which code is this".
 *
 * The file cannot answer that question later. A profile installs hoisted, so
 * a self-update rewrites package.json in the directory the RUNNING code was
 * loaded from, and every read after it names the version that will run after
 * the next restart — which the version row then printed as the one running
 * (design §7.3, 2026-09-27 amendment).
 *
 * A first read that throws is not kept: the module import must not fail over
 * a version string, so the answer falls back to reading on demand, which is
 * what the row always did.
 */
export function versionAtLoad(read: () => string): () => string {
  let loaded: string | null
  try {
    loaded = read()
  } catch {
    // Swallows only the load-time read; the on-demand read below reports the
    // same failure to its caller, which is the one place it can be handled.
    loaded = null
  }
  return () => loaded ?? read()
}

/** The version of the code in this process, read when the module was first
 * evaluated — at boot, before any self-update could rewrite the file. */
export const runningVersion = versionAtLoad(() => (ownManifest() as { version: string }).version)

/**
 * The peer ranges this build declares — the input to the load-time harness
 * self-check. Read from the same shipped manifest as `runningVersion`, so the
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
