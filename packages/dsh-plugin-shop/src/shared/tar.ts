/** A read-only ustar parser: the npm transport's only way into a tarball.
 *
 * Pure — bytes in, a path-to-bytes map out. It handles exactly what `npm
 * pack` emits and refuses everything else loudly, because the alternative to
 * a small strict reader is a fourth runtime dependency (design §4). */

/** Bytes up to the first NUL, one character for each byte. Tar pads its
 * fixed-width text fields with NULs, so a plain toString would carry them into
 * the path.
 *
 * `latin1`, not `ascii`: a name is bytes, and `ascii` drops the high bit of
 * every one, so a name written in UTF-8 came back as a different string (`é`,
 * C3 A9, as `C)`) that could be another file's name. One character for each
 * byte is lossless and is the same string for a name that is ASCII, which is
 * every name the npm transport reads. A caller that wants the characters of a
 * UTF-8 name decodes `Buffer.from(name, 'latin1')`, or looks a name up as
 * `Buffer.from(wanted, 'utf8').toString('latin1')`. */
function cstring(field: Buffer): string {
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('latin1')
}

/** Tar sizes are octal text, NUL- or space-terminated. An unparseable size
 * would desynchronise every subsequent header, so it throws rather than
 * guessing zero. */
function parseOctal(field: Buffer): number {
  const text = cstring(field).trim()
  if (text === '') return 0
  const value = Number.parseInt(text, 8)
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`tar: unparseable size field ${JSON.stringify(text)}`)
  }
  return value
}

/** `..` in any position, or a leading `/`, would let an archive write outside
 * the directory it claims. Nothing we publish contains either, so a tarball
 * that does is hostile or corrupt — refuse it rather than filter it. */
function assertContained(path: string): string {
  if (path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error(`tar: ${JSON.stringify(path)} escapes the archive root`)
  }
  return path
}

/**
 * Parse an uncompressed tar archive into path → bytes.
 *
 * Directory entries and every non-regular type (symlinks, pax and GNU
 * extension headers) are skipped: npm packs regular files under `package/`,
 * and a catalog tarball that needs anything else is not one we published.
 * Each path is spelled by its bytes, one character each ({@link cstring}).
 */
export function readTar(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    // The archive ends with zero blocks; one is enough to stop reading.
    if (header.every(byte => byte === 0)) break
    const name = cstring(header.subarray(0, 100))
    const prefix = cstring(header.subarray(345, 500))
    const size = parseOctal(header.subarray(124, 136))
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const path = prefix === '' ? name : `${prefix}/${name}`
    offset += 512
    if (typeflag === '0' || typeflag === '\0') {
      files.set(assertContained(path), buffer.subarray(offset, offset + size))
    }
    offset += Math.ceil(size / 512) * 512
  }
  return files
}
