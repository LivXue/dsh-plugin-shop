/**
 * The bytes installing a repository entry puts on disk, summed from a git
 * tree response — the github half's answer to npm's `dist.unpackedSize`.
 *
 * Pure, and validating: the body is a parsed GitHub response, which is
 * untrusted input like npm's, and this number reaches a published artifact.
 *
 * `undefined` — never a number — whenever the tree cannot answer honestly.
 * That asymmetry is the point: a figure here renders under a label saying
 * what installing costs, so an undercount is a false statement about a
 * published entry, while an absent size is merely a missing decoration. Each
 * `undefined` below names which of the two it is avoiding.
 *
 * What it deliberately does NOT measure: the DOWNLOAD. A repo install pulls
 * `codeload.github.com/<repo>/tar.gz/<sha>`, whose gzip of these same bytes
 * measured a median 1.86x smaller across 14 paired samples but ranged 1.28x
 * to 3.69x — so this figure cannot be converted into one, and codeload
 * declares no length and ignores a Range request (200, not 206, 3/3), so the
 * download is not knowable without fetching all of it.
 */
export function treeInstallSize(body: unknown, subdir?: string): number | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { tree, truncated } = body as { tree?: unknown; truncated?: unknown }
  // A truncated tree (>100k entries) hides blobs, and every hidden blob is
  // bytes the reader still downloads. Absent means not truncated — the API
  // always answers the flag, and a body without one is the pre-`recursive`
  // shape. Any OTHER value is a shape we do not understand, and the guess
  // that publishes an undercount is exactly "assume it was not truncated".
  if (truncated !== undefined && truncated !== false) return undefined
  if (!Array.isArray(tree)) return undefined
  // Trailing slash normalised so the prefix test cannot depend on how the
  // caller spelled the directory. `packages/foo` must not swallow
  // `packages/foo-bar`, which is why the separator is part of the prefix.
  const prefix = subdir === undefined ? undefined : `${subdir.replace(/\/+$/, '')}/`
  let total = 0
  let counted = 0
  for (const entry of tree as { path?: unknown; type?: unknown; size?: unknown }[]) {
    // `tree` (a directory) and `commit` (a submodule) hold no bytes of their
    // own. A submodule's CONTENT is not in this tree and is not fetched by a
    // tarball install either, so it is absent from the figure and from disk.
    if (entry.type !== 'blob') continue
    // Scope first, validate second: bytes outside the subpackage are not
    // installed, so a hostile size out there must not withhold the size of a
    // subpackage that is itself well-formed.
    if (prefix !== undefined && !(typeof entry.path === 'string' && entry.path.startsWith(prefix))) continue
    const size = entry.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined
    total += size
    counted += 1
    // Re-checked per blob rather than once at the end: past 2^53 the sum
    // stops being exact, and the first inexact addition is the last moment
    // the loss is still detectable.
    if (!Number.isSafeInteger(total)) return undefined
  }
  // Zero blobs is not zero bytes. An empty tree, or a subpackage directory
  // that matched nothing, would publish "0 B" — a claim that installing this
  // entry costs nothing, which is the plausible-and-wrong an absent size
  // exists to avoid.
  return counted === 0 ? undefined : total
}
