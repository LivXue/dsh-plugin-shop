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
 *     only because a release asset is presumed PREBUILT — so the patch the
 *     manifest points dsh at must be IN the archive, the modules that patch
 *     INSERTS must be in it too, and `workspace:` specifiers must already be
 *     resolved. Without (3) a `tar czf` of a bare manifest earned the waiver
 *     and landed with nothing to load.
 *
 *     The patch file and the modules it names are two claims, not one: a
 *     committed `cordis.patch.yml` beside a gitignored `dist/` satisfies the
 *     first and fails the second, which is `@open-design/dsh-runtime`'s exact
 *     shape. See {@link missingInsertTarget}.
 *
 *     Note what (3) does NOT test: the presence of a `prepare`/`prepack`
 *     script. `npm pack` runs those, ships the output, and leaves the scripts
 *     in the manifest, so nearly every correct package still declares one —
 *     refusing on that delisted 90 working entries in a live dry run.
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
import { parse } from 'yaml'
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

/**
 * How much of a patch file is parsed. The archive is already bounded at
 * {@link MAX_INFLATED_BYTES}, which leaves 64 MB of YAML reachable by this
 * parser; a cordis patch is a config file — the one that prompted this rule
 * is 649 bytes. Past the cap the patch is not read and NOTHING is refused:
 * an unread patch is an unanswered question, not a defect. Same figure and
 * same reasoning as `MAX_MANIFEST_BYTES`, kept local so this module keeps no
 * edge to the impure half.
 */
const MAX_PATCH_BYTES = 1024 * 1024

/**
 * Every module name an `insert` row registers, in reading order.
 *
 * Deliberately NOT `parseSimplePatch`, the shop's patch reader. That one
 * answers "can a hot tree replicate this?" and returns null for a row
 * carrying config, a bare targeting row, or a key beyond the id/name pair —
 * all three of which appear in the very patch this rule was written for. A
 * conservative null there is correct for hot mounting and useless here, so
 * this reads the same file for a different question and tolerates everything
 * that question does not depend on.
 *
 * Shallow on purpose: top-level list → each row's `insert` → each item's
 * string `name`. A YAML alias can make the parsed value CYCLIC (`- insert:
 * &a [*a]` parses into an array holding itself), so anything that walked the
 * tree hunting for a `name` would not return. Nothing here recurses, and the
 * parser's own `maxAliasCount` bounds the expansion before we see it.
 */
function patchInsertNames(text: string): string[] {
  let parsed: unknown
  try {
    // `logLevel: 'silent'` because the loader's own dialect is not this
    // parser's: a `!!js` scalar is a legal patch value and `yaml` warns on
    // every one it cannot resolve. Measured against the 176 live rescued
    // assets that is 33 warnings a build, on stderr, about nothing actionable
    // — and the unresolved scalar still arrives as its raw string, which
    // cannot match a bundle name and is skipped exactly as it should be.
    parsed = parse(text, { logLevel: 'silent' })
  } catch {
    // Unreadable YAML says nothing about whether the package was built, and
    // reporting our parser's limits as the author's defect is the mistake
    // this file's tar `catch` already names. The rule simply does not apply.
    return []
  }
  if (!Array.isArray(parsed)) return []
  const names: string[] = []
  for (const row of parsed) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue
    // hasOwn, not an index read: the patch is hostile input and `constructor`
    // is a legal YAML key, which would otherwise hand back a function.
    if (!Object.hasOwn(row, 'insert')) continue
    const inserted = (row as { insert?: unknown }).insert
    if (!Array.isArray(inserted)) continue
    for (const item of inserted) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
      if (!Object.hasOwn(item, 'name')) continue
      const name = (item as { name?: unknown }).name
      if (typeof name === 'string') names.push(name)
    }
  }
  return names
}

/**
 * The conditions this rule follows into an `exports` value, in scan order.
 *
 * `types` is absent by design. A pack that omits its `.d.ts` still loads, so
 * refusing over one would repeat the prepare/prepack mistake in a new place:
 * a true statement about the archive that is not a reason the plugin cannot
 * run. Only one target is followed, not every arm — a dual package whose
 * `require` arm is packed differently from its `import` arm is not something
 * this rule claims to judge, and the case it IS aimed at has every arm
 * missing at once.
 */
const RUNTIME_CONDITIONS = ['default', 'node', 'import', 'require'] as const

/** Follow a conditions object down to its first runtime string target.
 * Depth-bounded rather than recursive-until-done: the value is hostile. */
function conditionTarget(value: unknown, depth = 0): string | null {
  if (typeof value === 'string') return value
  if (depth >= 4 || value === null || typeof value !== 'object' || Array.isArray(value)) return null
  for (const condition of RUNTIME_CONDITIONS) {
    if (!Object.hasOwn(value, condition)) continue
    const found = conditionTarget((value as Record<string, unknown>)[condition], depth + 1)
    if (found !== null) return found
  }
  return null
}

/**
 * Where the manifest says a subpath of ITSELF lives, or null when this rule
 * cannot say.
 *
 * Null is the important half. A wildcard pattern, a subpath an `exports` map
 * does not list, a deep subpath with no map to resolve it, a `..` segment —
 * each is a shape this does not model, and refusing on an unmodelled shape is
 * a guess. The one guess this file already made in the confident direction
 * delisted 90 working entries.
 */
function ownSubpathTarget(manifest: { exports?: unknown; main?: unknown }, subpath: string): string | null {
  const target = declaredTarget(manifest, subpath)
  // ONE exit for every branch above. Applying these per-branch is how the
  // first draft let a `main` of `./dist/*.js` or `./../outside.js` through
  // unguarded while the `exports` arm refused the same shapes — a mutation
  // that survived because the only test for either reached the object arm.
  if (target === null || target.includes('*')) return null
  return target.split('/').includes('..') ? null : target
}

/** The literal target string the manifest declares for one of its own
 * subpaths, before the shapes {@link ownSubpathTarget} refuses to resolve. */
function declaredTarget(manifest: { exports?: unknown; main?: unknown }, subpath: string): string | null {
  const { exports } = manifest
  if (exports === undefined || exports === null) {
    // No map: only the package's own entry point is answerable. A deeper
    // subpath falls to legacy directory resolution, which has too many shapes
    // to call a miss. `main` absent is not defaulted to `index.js` either —
    // this refuses only what the author DECLARED and did not ship.
    return subpath === '.' && typeof manifest.main === 'string' ? manifest.main : null
  }
  if (typeof exports === 'string') return subpath === '.' ? exports : null
  if (typeof exports !== 'object' || Array.isArray(exports)) return null
  // A map keyed by subpaths, or a bare conditions object standing for `.`.
  return Object.keys(exports).some(key => key.startsWith('.'))
    ? (Object.hasOwn(exports, subpath) ? conditionTarget((exports as Record<string, unknown>)[subpath]) : null)
    : (subpath === '.' ? conditionTarget(exports) : null)
}

/**
 * The first module an `insert` row names, resolves into THIS package, and the
 * archive does not carry — or null when every such name checks out.
 *
 * This is the claim the patch-target check above cannot make. That one proves
 * the patch file ships; this one proves the files the patch points dsh at
 * ship. `@open-design/dsh-runtime` passes the first and fails this: it
 * committed cordis.patch.yml, gitignored `dist/`, and declared no
 * prepare/prepack, so both entries it inserted resolved through `exports`
 * onto files no install could contain.
 *
 * A name belonging to any OTHER package is skipped, never required: a patch
 * legitimately inserts its peers' modules, and demanding those be in this
 * archive would refuse every real plugin.
 *
 * Live impact, measured 2026-09-07 by running this verifier over all 176
 * rescued assets of the 2026.906.18 catalog: it delists NONE of them. The
 * refusal set is unchanged at 8, every one on an older rule. So this is a
 * guard against a shape that demonstrably exists in the wild and does not
 * currently reach THIS channel — `@open-design/dsh-runtime` is a
 * commit-pinned entry with no release asset, so nothing here sees it. Stated
 * plainly because "the rule that fixed the bug" would be the wrong summary.
 */
function missingInsertTarget(
  patchText: string,
  manifest: { name?: unknown; exports?: unknown; main?: unknown },
  bundleName: string,
  root: string,
  present: ReadonlySet<string>,
): { name: string; path: string } | null {
  for (const name of patchInsertNames(patchText)) {
    let subpath: string
    if (name === bundleName) subpath = '.'
    else if (name.startsWith(`${bundleName}/`)) subpath = `./${name.slice(bundleName.length + 1)}`
    else continue
    const target = ownSubpathTarget(manifest, subpath)
    if (target === null) continue
    const relative = target.replace(/^\.\//, '')
    if (!present.has(normalize(`${root}/${relative}`))) return { name, path: relative }
  }
  return null
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
  let manifest: { name?: unknown; dsh?: unknown; exports?: unknown; main?: unknown }
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
  // `no-bundle` exists to kill — one JSON literal away from
  // `dsh-message-finder`, which the live harvest refuses on exactly this rule.
  const bundle = (manifest.dsh as { bundle?: unknown } | null | undefined)?.bundle
  if (typeof bundle !== 'object' || bundle === null || Array.isArray(bundle)) {
    return {
      ok: false,
      detail: 'the release asset declares no dsh.bundle object, so dsh would install it as a plain dependency'
        + ' rather than a plugin. The repository root declares one; the packed tarball must too.',
    }
  }
  // Claim (3): the waiver is granted because a release asset is presumed
  // PREBUILT, so the thing that has to be true is that what it ships is
  // usable — the patch the manifest points dsh at must be IN the archive.
  //
  // The script field cannot answer this and must not be used to. `npm pack`
  // runs `prepare`/`prepack`, includes the built output, and leaves the
  // scripts intact, so essentially every correctly packed package still
  // declares one; and pnpm does not run them for a tarball install anyway.
  // Refusing on their presence delisted 90 working entries in a dry run
  // against the live catalog, all of which ship compiled output next to the
  // script. The patch-target rule refuses the incomplete pack it was aimed at
  // and delists none of the 169 the other rules accept (measured).
  const patch = (bundle as { patch?: unknown }).patch
  if (typeof patch === 'string') {
    const target = normalize(`${rooted.root}/${patch.replace(/^\.\//, '')}`)
    if (!paths.includes(target)) {
      return {
        ok: false,
        detail: `the release asset declares dsh.bundle.patch ${echo(patch)} but the archive does not contain it,`
          + ' so this is a source tree or an incomplete pack rather than an installable package.'
          + ' `npm pack` from a built checkout includes it.',
      }
    }
    // The patch file shipping and the modules it INSERTS shipping are two
    // claims, and the first does not imply the second — see
    // {@link missingInsertTarget}. Read from the archive we already hold, so
    // this costs no request and stays as pure as the rest of the file.
    const patchBytes = [...files.entries()].find(([path]) => normalize(path) === target)?.[1]
    if (patchBytes !== undefined && patchBytes.byteLength <= MAX_PATCH_BYTES) {
      const missing = missingInsertTarget(
        Buffer.from(patchBytes).toString('utf8').replace(/^\ufeff/, ''),
        manifest, bundleName, rooted.root, new Set(paths),
      )
      if (missing !== null) {
        return {
          ok: false,
          detail: `the release asset's patch inserts ${echo(missing.name)}, which its own package.json resolves to`
            + ` ${echo(missing.path)} — and the archive does not contain that file, so the entry would fail to load.`
            + ' The build output is missing from the pack; `npm pack` from a built checkout includes it.',
        }
      }
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
