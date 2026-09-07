/**
 * Build a packed npm tarball in memory — the shape `npm pack` emits and the
 * only shape a release asset may take to be accepted as a rescue.
 *
 * Shared because two suites need it for the same reason: since
 * `verifyReleaseAsset`, a placeholder body is no longer a stand-in for a
 * release asset. A fixture that is not a real packed package now tests the
 * refusal path, not the rescue path.
 */

import { gzipSync } from 'node:zlib'

/** A ustar archive of the given files, the shape `npm pack` emits. */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = []
  for (const [path, body] of Object.entries(files)) {
    const header = Buffer.alloc(512)
    header.write(path, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    // The checksum is the sum of every byte with the field itself as spaces.
    let sum = 0
    for (const byte of header) sum += byte
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    const content = Buffer.from(body, 'utf8')
    const padding = Buffer.alloc((512 - (content.length % 512)) % 512)
    blocks.push(header, content, padding)
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}


/** A gzipped tarball declaring `name`, with a `dsh.bundle` so it passes as a
 * plugin. `extra` overlays or adds manifest fields. */
export function packedTarball(name: string, extra: Record<string, unknown> = {}): Uint8Array {
  const manifest = { name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...extra }
  return gzipSync(tar({ 'package/package.json': JSON.stringify(manifest) }))
}

/** A gzipped tarball of arbitrary members — for the archives that are not
 * packed npm packages at all. */
export function rawTarball(files: Record<string, string>): Uint8Array {
  return gzipSync(tar(files))
}
