/**
 * Does a GitHub release asset actually contain the package the entry claims?
 *
 * The release rescue is the ONE channel where an entry's declared identity and
 * its installable bytes come from two different artifacts. Every other channel
 * reads the name from the very thing it installs: an npm entry's name IS its
 * packument key, and a commit-pinned repo entry (subpackages included) reads
 * its manifest out of the tree pnpm will fetch. A release asset is uploaded by
 * hand and can be anything.
 *
 * That gap let three claims taken from the repo tree ride onto an unverified
 * tarball — the bundle name it installs under, the `dsh.bundle` that makes it
 * a plugin at all, and the waiver of `requires-build`/`workspace-deps` that
 * the rescue grants on the premise that the tarball is a prebuilt copy of THIS
 * package. Measured on the 2026-09-06 catalog, 7 of 176 rescued entries broke
 * it, and every one of them was unusable: the install put a different package
 * in the profile, the declared bundle never landed, and the post-install
 * confirm failed. Filtering them removes nothing installable.
 *
 * Pure: bytes and a name in, a verdict out. No clock, no network, no
 * filesystem — `gunzipSync` is deterministic, so fixtures drive all of it.
 * Takes `Uint8Array` because that is what the capped body reader hands back
 * and nothing here needs a `Buffer`; `gunzipSync` widens to `Buffer` itself.
 */

import { gunzipSync } from 'node:zlib'
import { readTar } from '../../../packages/dsh-plugin-shop/src/shared/tar.ts'

export type ReleaseAssetVerdict =
  | { ok: true }
  /** Why the rescue was refused, in the author's terms. It reaches a published
   * build-report row, so it names both the asset's package and the entry's. */
  | { ok: false; detail: string }

/** A name check on the filename would have been cheaper and wrong twice over:
 * `@crosery/dsh-drop` ships a correct `dsh-drop.tgz` (a false positive), and
 * `get-fable` ships a correctly-named asset that declares no bundle (a false
 * negative). Only the packed manifest answers. */
export function verifyReleaseAsset(bytes: Uint8Array, bundleName: string): ReleaseAssetVerdict {
  let manifest: { name?: unknown; dsh?: { bundle?: unknown } }
  try {
    const files = readTar(gunzipSync(bytes))
    // `npm pack` always roots at `package/`, but these assets are hand-made:
    // a sibling root is accepted, a nested one is not, because a deep
    // `package.json` belongs to a dependency rather than to the package.
    const entry = [...files.entries()]
      .find(([path]) => path.split('/').length === 2 && path.endsWith('/package.json'))
    if (entry === undefined) {
      return { ok: false, detail: `the release asset carries no package.json at its root, so it is not a packed npm package` }
    }
    manifest = JSON.parse(entry[1].toString('utf8')) as typeof manifest
    if (typeof manifest !== 'object' || manifest === null) throw new Error('not an object')
  } catch {
    // Swallows gunzip, the tar reader's deliberate loudness, and JSON.parse.
    // An asset we cannot read is an asset we cannot vouch for, which is the
    // same answer as one that disagrees.
    return { ok: false, detail: 'the release asset could not be read as a gzipped npm package tarball' }
  }
  if (manifest.name !== bundleName) {
    const packed = typeof manifest.name === 'string' ? manifest.name : '(unnamed)'
    return {
      ok: false,
      detail: `the release asset packs ${packed}, not ${bundleName}`
        + ` — installing it would put ${packed} in the profile and ${bundleName} would never land.`
        + ' Attach the packed tarball for this package instead.',
    }
  }
  if (manifest.dsh?.bundle === undefined || manifest.dsh.bundle === null) {
    return {
      ok: false,
      detail: `the release asset declares no dsh.bundle, so dsh would install it as a plain dependency`
        + ' rather than a plugin. The repository root declares one; the packed tarball must too.',
    }
  }
  return { ok: true }
}
