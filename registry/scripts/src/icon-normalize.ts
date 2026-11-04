/**
 * Shrinking an icon that is larger than the catalog can carry (design
 * 2026-11-04-icon-downscale.md).
 *
 * The icon a card draws is 24 px (48 on a 2× screen). An author who exports a
 * 512 px PNG at 80 KiB is not doing anything wrong — the file is simply sized
 * for a use this shelf does not have. Refusing it costs the reader the icon;
 * carrying it costs the catalog's 16 MiB budget. So the build decodes the
 * raster, draws it into a 64 px box and re-encodes it, which is what the card
 * would have done with it anyway.
 *
 * Pure: bytes in, bytes out. No clock, no network, no filesystem — the same
 * contract every module in the catalog's pure core keeps, so a fixture drives
 * all of it.
 *
 * Only PNG and JPEG are decoded. WebP and GIF would need a wasm codec, and
 * SVG is text with no pixels to resample; an oversized one of those keeps the
 * refusal it had before, which names the file's real size.
 */

import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import type { IconMediaType } from './icon-declaration.ts'

/**
 * The box a shrunk icon is drawn into, in pixels. 64 is the 48 a 2× screen
 * asks for with headroom, and the largest dimension: an aspect ratio is kept,
 * so a wide icon stays wide and a tall one tall.
 */
export const ICON_SHRINK_BOX_PX = 64

/**
 * The largest source dimension this will decode. A PNG's IHDR and a JPEG's
 * SOF state their size before the pixels exist, and a small file can claim an
 * enormous canvas: a 30 KiB PNG may inflate to gigabytes of RGBA. Anything
 * past this box is left to the size refusal rather than decoded — 2048 px is
 * 4× the largest icon a plugin author realistically ships, and well inside
 * what this process can hold.
 */
export const ICON_SHRINK_MAX_SOURCE_PX = 2048

/** JPEG quality for a re-encode that PNG could not fit. */
const JPEG_QUALITY = 82

/** A decoded image, RGBA, row-major. */
interface Pixels {
  width: number
  height: number
  data: Uint8Array
}

/**
 * `bytes` re-encoded to fit `capBytes` when it is an oversized PNG or JPEG, or
 * null when it is anything else, is already inside the cap, or cannot be
 * shrunk under it.
 *
 * Null means "carry the original": the caller's size check then refuses it
 * with the sentence that names the author's real file size.
 *
 * The output's media type may differ from the input's — a PNG that will not
 * fit the cap as PNG is offered as JPEG, because a photographic icon of 64 px
 * is a few kilobytes as JPEG and can be tens as PNG. The caller writes the
 * media type it sniffs from the returned bytes, so a JPEG is labelled JPEG.
 */
export function shrinkIconBytes(bytes: Uint8Array, mediaType: IconMediaType, capBytes: number): Uint8Array | null {
  if (bytes.length <= capBytes) return null
  let pixels: Pixels | null = null
  try {
    if (mediaType === 'image/png') pixels = decodePng(bytes)
    else if (mediaType === 'image/jpeg') pixels = decodeJpeg(bytes)
  } catch {
    // Swallows a decoder refusing malformed input: the original bytes are
    // returned to the size check, which is where a broken icon is already
    // judged. Nothing else can reach this catch — the decoders throw only for
    // bytes they cannot read.
    return null
  }
  if (pixels === null) return null
  const small = resample(pixels, ICON_SHRINK_BOX_PX)
  const png = encodePng(small)
  if (png !== null && png.length <= capBytes) return png
  // A flat or gradient icon fits PNG; a photograph may not. JPEG at this size
  // is a few kilobytes and visually indistinguishable at 24 px.
  const jpg = encodeJpeg(small)
  if (jpg !== null && jpg.length <= capBytes) return jpg
  return null
}

/** The PNG's pixels, or null for a header this will not decode. */
function decodePng(bytes: Uint8Array): Pixels | null {
  const size = pngSize(bytes)
  if (size === null) return null
  const png = PNG.sync.read(Buffer.from(bytes))
  if (png.width !== size.width || png.height !== size.height) return null
  return { width: png.width, height: png.height, data: png.data }
}

/**
 * The dimensions a PNG's IHDR states, or null when the header is not one or
 * claims a canvas past {@link ICON_SHRINK_MAX_SOURCE_PX}.
 *
 * Read BEFORE `PNG.sync.read`, which allocates the canvas: a 30 KiB file may
 * claim 60,000 × 60,000 and take the build down with it.
 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  // Signature, then a length + "IHDR" + 13 bytes of header. 24 bytes is the
  // whole of what is read here.
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || !signature.every((byte, index) => bytes[index] === byte)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  if (width === 0 || height === 0) return null
  if (width > ICON_SHRINK_MAX_SOURCE_PX || height > ICON_SHRINK_MAX_SOURCE_PX) return null
  return { width, height }
}

/** The JPEG's pixels, or null for a header this will not decode. */
function decodeJpeg(bytes: Uint8Array): Pixels | null {
  const size = jpegSize(bytes)
  if (size === null) return null
  const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true })
  return { width: decoded.width, height: decoded.height, data: decoded.data }
}

/**
 * The dimensions a JPEG's start-of-frame marker states, or null when there is
 * no frame marker or it claims a canvas past
 * {@link ICON_SHRINK_MAX_SOURCE_PX}.
 *
 * Decoding a JPEG allocates its canvas too, so the same rule as `pngSize`
 * applies: read first, allocate second. The scan walks markers rather than
 * searching for `0xC0`, because a compressed segment may contain that byte.
 */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1] ?? 0
    // Standalone markers carry no length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0)
    if (length < 2) return null
    // SOF0..SOF15, minus the four that are not frames.
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isFrame) {
      const height = ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0)
      const width = ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0)
      if (width === 0 || height === 0) return null
      if (width > ICON_SHRINK_MAX_SOURCE_PX || height > ICON_SHRINK_MAX_SOURCE_PX) return null
      return { width, height }
    }
    // `length` counts its own two bytes.
    offset += 2 + length
  }
  return null
}

/**
 * `pixels` drawn into a `box`-sized square, aspect ratio kept, with the
 * smaller axis letterboxed — the icon is centred on transparent pixels rather
 * than stretched.
 *
 * Bilinear sampling, averaged when shrinking: a 512 → 64 reduction takes an
 * 8 × 8 box per output pixel, which is what keeps a photographic icon from
 * aliasing into noise at 24 px.
 */
function resample(pixels: Pixels, box: number): Pixels {
  const scale = Math.min(box / pixels.width, box / pixels.height)
  const width = Math.max(1, Math.round(pixels.width * scale))
  const height = Math.max(1, Math.round(pixels.height * scale))
  const offsetX = Math.floor((box - width) / 2)
  const offsetY = Math.floor((box - height) / 2)
  const out = new Uint8Array(box * box * 4)
  const stepX = pixels.width / width
  const stepY = pixels.height / height
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * stepY)
    const y1 = Math.min(pixels.height, Math.max(y0 + 1, Math.ceil((y + 1) * stepY)))
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * stepX)
      const x1 = Math.min(pixels.width, Math.max(x0 + 1, Math.ceil((x + 1) * stepX)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const at = (sy * pixels.width + sx) * 4
          r += pixels.data[at] ?? 0
          g += pixels.data[at + 1] ?? 0
          b += pixels.data[at + 2] ?? 0
          a += pixels.data[at + 3] ?? 0
          count += 1
        }
      }
      const target = ((y + offsetY) * box + (x + offsetX)) * 4
      out[target] = Math.round(r / count)
      out[target + 1] = Math.round(g / count)
      out[target + 2] = Math.round(b / count)
      out[target + 3] = Math.round(a / count)
    }
  }
  return { width: box, height: box, data: out }
}

function encodePng(pixels: Pixels): Uint8Array | null {
  try {
    const encoded = PNG.sync.write({ width: pixels.width, height: pixels.height, data: Buffer.from(pixels.data) } as unknown as PNG)
    return new Uint8Array(encoded)
  } catch {
    // Swallows an encoder refusing the buffer this module built. It cannot:
    // the shape is one it just produced. A null here costs the icon its
    // shrink, not the build.
    return null
  }
}

function encodeJpeg(pixels: Pixels): Uint8Array | null {
  try {
    const encoded = jpeg.encode({ data: Buffer.from(pixels.data), width: pixels.width, height: pixels.height }, JPEG_QUALITY)
    return new Uint8Array(encoded.data)
  } catch {
    // Same rule as `encodePng`.
    return null
  }
}
