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
 * tarball, and all three are checked here:
 *
 *  1. the bundle NAME it installs under,
 *  2. the `dsh.bundle` that makes it a plugin rather than a plain dependency,
 *  3. the `requires-build` / `workspace-deps` waiver, which the rescue grants
 *     only because a release asset is presumed PREBUILT — so an asset still
 *     carrying `prepare`/`prepack` or unresolved `workspace:` specifiers is
 *     refused. Without (3) a plain `tar czf` of a source tree earned the
 *     waiver and landed unbuilt, which is the exact failure `requires-build`
 *     exists to prevent.
 *
 * Measured on the 2026-09-06 catalog, 7 of 176 rescued entries broke (1) or
 * (2), and every one was unusable: the install put a different package in the
 * profile, the declared bundle never landed, and the post-install confirm
 * failed. Filtering them removes nothing installable. (That figure is kept
 * HERE and nowhere else — CLAUDE.md's warning about three copies of one
 * measurement drifting apart applies.)
 *
 * Pure: bytes and a name in, a verdict out. No clock, no network, no
 * filesystem — `gunzipSync` is deterministic, so fixtures drive all of it.
 * Takes `Uint8Array` because that is what the capped body reader hands back
 * and nothing here needs a `Buffer`.
 */

import { gunzipSync } from 'node:zlib'
import { readTar } from '../../../packages/dsh-plugin-shop/src/shared/tar.ts'
import { hasWorkspaceDeps } from './subpackage-select.ts'

export type ReleaseAssetVerdict =
  | { ok: true }
  /** Why the rescue was refused, in the author's terms. It reaches a published
   * build-report row AND the committed `repo-state.json`, so every value
   * interpolated into it is bounded. */
  | { ok: false; detail: string }

/**
 * What the asset may inflate to. `readTarballBody` caps the COMPRESSED asset
 * at 32 MB, which bounds nothing after this call: gzip of zeros reaches about
 * 1029:1 on this Node, so an accepted asset can demand ~33 GB and no `Buffer`
 * limit intervenes first. An OOM kill is not catchable, so it would take the
 * daily build down with no report at all — past every `catch` here and in the
 * probe. Same bound and same reason as `npm-origin.ts`'s `MAX_INFLATED_BYTES`,
 * which is the module this file's tar reader was moved out of.
 */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024

/** How much of a hostile string may be echoed back. Not a name bound: the
 * name that reaches these messages has already failed the equality check, so
 * its only other ceiling is the manifest cap — about a megabyte, which would
 * be copied verbatim into a published page and into a committed JSON file.
 * Same figure and same reasoning as `describeBadName`. */
const ECHO_MAX = 80

/** A hostile value, quoted and bounded, for a message an author reads. */
function echo(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  return JSON.stringify(text.length > ECHO_MAX ? `${text.slice(0, ECHO_MAX)}…` : text)
}

/** `tar czf x.tgz ./package` emits `./package/…`, which `readTar` tolerates;
 * normalising here keeps the root rule below from seeing `.` as the root. */
const normalize = (path: string): string => path.replace(/^\.\//, '')

/**
 * The asset's single top-level directory, or a reason there is not exactly one.
 *
 * This is the check that makes the rest binding. npm and pnpm extract a
 * tarball with `strip: 1` — the first path component is discarded whatever it
 * is called — so with members `aaa/package.json` and `package/package.json`
 * BOTH become `package.json` on disk and the LAST one written wins. Reading
 * the FIRST depth-2 manifest therefore verified one package while pnpm
 * installed another, and because the sha256 is computed over these exact
 * bytes the host's integrity gate passed by construction. `npm pack` never
 * emits two roots, so requiring exactly one costs nothing real and removes
 * the substitution entirely.
 */
function singleRoot(paths: readonly string[]): { root: string } | { detail: string } {
  const roots = new Set<string>()
  let rootLevel = false
  for (const path of paths) {
    const [head, ...rest] = path.split('/')
    if (head === undefined) continue
    if (rest.length === 0) rootLevel = true
    else roots.add(head)
  }
  if (roots.size === 1) {
    const [only] = [...roots]
    if (only !== undefined) return { root: only }
  }
  if (roots.size > 1) {
    return {
      detail: `the release asset holds ${roots.size} top-level directories (${[...roots].sort().slice(0, 3).map(echo).join(', ')})`
        + ' — npm and pnpm strip the first path component when they extract, so which package lands would depend on member order.'
        + ' Attach a tarball packed by `npm pack`, which emits exactly one.',
    }
  }
  return {
    detail: rootLevel
      ? 'the release asset has no top-level directory — npm and pnpm strip the first path component when they extract, so nothing would land. Attach a tarball packed by `npm pack`.'
      : 'the release asset holds no files',
  }
}

export function verifyReleaseAsset(bytes: Uint8Array, bundleName: string): ReleaseAssetVerdict {
  let files: Map<string, Uint8Array>
  try {
    files = readTar(gunzipSync(bytes, { maxOutputLength: MAX_INFLATED_BYTES }))
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (code === 'ERR_BUFFER_TOO_LARGE') {
      return { ok: false, detail: `the release asset inflates past the ${MAX_INFLATED_BYTES}-byte cap, so it was not read` }
    }
    // Swallows gunzip and the tar reader's deliberate loudness. This says
    // "we could not read it", never "it is malformed": a `..` member path or
    // a GNU base-256 size field is a limit of our own 60-line parser, and
    // reporting it as a fact about the author's artifact would be a wrong
    // reason rather than a wording nit.
    return { ok: false, detail: 'the release asset could not be read as a gzipped tar archive by this pipeline' }
  }
  const paths = [...files.keys()].map(normalize)
  const rooted = singleRoot(paths)
  if ('detail' in rooted) return { ok: false, detail: rooted.detail }
  const manifestPath = `${rooted.root}/package.json`
  const raw = [...files.entries()].find(([path]) => normalize(path) === manifestPath)?.[1]
  if (raw === undefined) {
    return { ok: false, detail: `the release asset's ${echo(rooted.root)} directory carries no package.json, so it is not a packed npm package` }
  }
  let manifest: { name?: unknown; dsh?: unknown; scripts?: unknown }
  try {
    // npm's own reader strips a UTF-8 BOM, so a manifest carrying one installs
    // fine; refusing it here — and calling the archive unreadable — would
    // report our parser's strictness as the author's defect.
    manifest = JSON.parse(Buffer.from(raw).toString('utf8').replace(/^﻿/, '')) as typeof manifest
  } catch {
    return { ok: false, detail: `the release asset's ${manifestPath} is not readable JSON` }
  }
  // The Array clause is deliberate and matches `projectCandidate`: an array is
  // `typeof 'object'` and non-null, so without it `manifest.name` reads
  // undefined and the author is told the asset "packs (unnamed)" when the fix
  // is to repair an invalid package.json.
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { ok: false, detail: `the release asset's ${manifestPath} is not a JSON object` }
  }
  if (manifest.name !== bundleName) {
    return {
      ok: false,
      detail: `the release asset packs ${echo(manifest.name)}, not ${bundleName}`
        + ' — installing it would put that package in the profile and this one would never land.'
        + ' Attach the packed tarball for this package instead.',
    }
  }
  // A NON-NULL OBJECT is what the rule means. `!== undefined` admitted
  // `false`, `0`, `''` and `null`, none of which registers a plugin, so the
  // rescue would have re-admitted exactly the silent no-op install that
  // `no-bundle` exists to kill — one JSON literal away from the `get-fable`
  // case that motivated this check.
  const bundle = (manifest.dsh as { bundle?: unknown } | null | undefined)?.bundle
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    return {
      ok: false,
      detail: 'the release asset declares no dsh.bundle object, so dsh would install it as a plain dependency'
        + ' rather than a plugin. The repository root declares one; the packed tarball must too.',
    }
  }
  // Claim (3). The waiver exists because a release asset is presumed prebuilt.
  const scripts = manifest.scripts as Record<string, unknown> | null | undefined
  const buildScript = ['prepare', 'prepack'].find(key => typeof scripts?.[key] === 'string')
  if (buildScript !== undefined) {
    return {
      ok: false,
      detail: `the release asset still declares a ${buildScript} script, so it is a source tree rather than a prebuilt package.`
        + ' pnpm blocks build scripts and the shop never enables them, so it would land unbuilt and its dsh.bundle.patch target would be absent.',
    }
  }
  if (hasWorkspaceDeps(manifest)) {
    return {
      ok: false,
      detail: 'the release asset still declares workspace:-protocol dependencies, which resolve only inside the'
        + ' repository\'s own workspace. `pnpm pack` rewrites them into resolved ranges; this tarball was not packed that way.',
    }
  }
  return { ok: true }
}
