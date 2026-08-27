/** The shop's own published version, read from the package.json that ships
 * next to this package — the RUNNING version, not the manifest's range
 * spec. This lives at the package root (not under src/host) on purpose:
 * both the source tree (tests) and the bundled `lib/index.js` sit exactly
 * one level below the package root, so the same relative URL resolves in
 * both. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export function ownVersion(): string {
  return (JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version: string }).version
}
