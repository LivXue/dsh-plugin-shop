/**
 * Does an installed package have a browser half? (design
 * 2026-09-11-activation-model §3.)
 *
 * The harness's `ClientModuleRegistry` scans the loader's entries for
 * packages declaring `dsh.client` and composes `window.__DSH_BOOT__` from
 * them. That declaration is therefore the whole question: a package that
 * declares it puts something in a browser tab, and a tab opened before the
 * change is showing the state from before it.
 *
 * The read goes through `HotFs`, the same injected seam `hot.ts` uses to
 * read the same file for `dsh.bundle.patch`, so tests never touch disk and
 * exactly one production call site does.
 */

import { join } from 'node:path'
import type { HotFs } from './hot.ts'

/**
 * Whether `packageName`, as installed in `profileDir`, declares `dsh.client`.
 *
 * **An unreadable manifest answers `true`.** Offering a reload that was not
 * needed costs the reader one keystroke; withholding one that was needed is
 * the defect this module exists to fix, so the fallback is the safe side of
 * a lopsided asymmetry rather than a guess.
 *
 * The VALUE of `dsh.client` is not inspected — an empty object is a
 * declaration. Only a non-object (the manifest saying something else
 * entirely) reads as no declaration.
 */
export function hasClientHalf(fs: HotFs, profileDir: string, packageName: string): boolean {
  let text: string
  try {
    text = fs.read(join(profileDir, 'node_modules', packageName, 'package.json'))
  } catch {
    // Absent, unreadable, or removed between the caller's check and this
    // read. Nothing else can reach this catch, and every branch of it means
    // the same thing: we cannot tell, so assume the reload is needed.
    return true
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    // The package is on disk with a manifest we cannot parse. Same rule.
    return true
  }
  const client = (manifest as { dsh?: { client?: unknown } } | null)?.dsh?.client
  return typeof client === 'object' && client !== null && !Array.isArray(client)
}
