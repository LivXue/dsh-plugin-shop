import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import { ICON_SHRINK_BOX_PX, ICON_SHRINK_MAX_SOURCE_PX, jpegSize, pngSize, shrinkIconBytes } from '../src/icon-normalize.ts'

/** Deterministic noise: incompressible, so a PNG of it is genuinely large. */
function noise(size: number, seed = 7): Uint8Array {
  const data = new Uint8Array(size * size * 4)
  let state = seed
  for (let i = 0; i < data.length; i++) {
    // xorshift32, so the fixture is the same on every run.
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    data[i] = (state >>> 24) & 0xff
  }
  return data
}

function pngOf(size: number, seed = 7): Uint8Array {
  return new Uint8Array(PNG.sync.write({ width: size, height: size, data: Buffer.from(noise(size, seed)) } as unknown as PNG))
}

function jpegOf(size: number, quality = 95): Uint8Array {
  return new Uint8Array(jpeg.encode({ data: Buffer.from(noise(size)), width: size, height: size }, quality).data)
}

const CAP = 32 * 1024

describe('the source dimensions are read before anything is decoded', () => {
  // A 30 KiB PNG may claim 60,000 × 60,000; decoding it would take the build
  // down. Both readers answer from the header and refuse an oversized canvas.

  it('reads a PNG IHDR', () => {
    expect(pngSize(pngOf(16))).toEqual({ width: 16, height: 16 })
  })

  it('refuses a PNG canvas past the source bound, and any bytes that are not a PNG', () => {
    const huge = Buffer.from(pngOf(16))
    // Rewrite the IHDR width/height fields; the decoder never sees it.
    huge.writeUInt32BE(ICON_SHRINK_MAX_SOURCE_PX + 1, 16)
    expect(pngSize(new Uint8Array(huge))).toBeNull()
    expect(pngSize(new Uint8Array([0, 1, 2, 3]))).toBeNull()
    expect(pngSize(new Uint8Array(0))).toBeNull()
  })

  it('reads a JPEG frame marker', () => {
    expect(jpegSize(jpegOf(16))).toEqual({ width: 16, height: 16 })
  })

  it('refuses a JPEG canvas past the source bound, and any bytes that are not a JPEG', () => {
    const huge = Buffer.from(jpegOf(16))
    // The SOF's height/width pair: find the marker the reader would.
    for (let i = 2; i + 9 < huge.length; i++) {
      if (huge[i] === 0xff && huge[i + 1] === 0xc0) {
        huge.writeUInt16BE(ICON_SHRINK_MAX_SOURCE_PX + 1, i + 5)
        break
      }
    }
    expect(jpegSize(new Uint8Array(huge))).toBeNull()
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0x00]))).toBeNull()
    expect(jpegSize(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})

describe('shrinkIconBytes', () => {
  it('leaves bytes already inside the cap alone', () => {
    expect(shrinkIconBytes(pngOf(8), 'image/png', CAP)).toBeNull()
  })

  it('shrinks an oversized PNG into the box, under the cap', () => {
    const source = pngOf(256)
    expect(source.length).toBeGreaterThan(CAP)
    const shrunk = shrinkIconBytes(source, 'image/png', CAP)
    expect(shrunk).not.toBeNull()
    expect(shrunk!.length).toBeLessThanOrEqual(CAP)
    const decoded = PNG.sync.read(Buffer.from(shrunk!))
    expect(decoded.width).toBe(ICON_SHRINK_BOX_PX)
    expect(decoded.height).toBe(ICON_SHRINK_BOX_PX)
  })

  it('shrinks an oversized JPEG too', () => {
    const source = jpegOf(256)
    expect(source.length).toBeGreaterThan(CAP)
    const shrunk = shrinkIconBytes(source, 'image/jpeg', CAP)
    expect(shrunk).not.toBeNull()
    expect(shrunk!.length).toBeLessThanOrEqual(CAP)
  })

  it('keeps an aspect ratio and letterboxes rather than stretching', () => {
    // A wide banner: 256 × 64.
    const data = new Uint8Array(noise(256).slice(0, 256 * 64 * 4))
    const wide = new Uint8Array(PNG.sync.write({ width: 256, height: 64, data: Buffer.from(data) } as unknown as PNG))
    const shrunk = shrinkIconBytes(wide, 'image/png', CAP)
    expect(shrunk).not.toBeNull()
    const decoded = PNG.sync.read(Buffer.from(shrunk!))
    expect(decoded.width).toBe(ICON_SHRINK_BOX_PX)
    expect(decoded.height).toBe(ICON_SHRINK_BOX_PX)
    // The top row is the letterbox: fully transparent.
    const topAlpha = decoded.data[3]
    expect(topAlpha).toBe(0)
  })

  it('answers null for a format it does not decode, leaving the original to the size refusal', () => {
    const bytes = new Uint8Array(CAP + 1)
    // The catalog's own media types: only the two rasters are decoded, and SVG
    // and WebP keep the size refusal they had.
    for (const mediaType of ['image/webp', 'image/svg+xml'] as const) {
      expect(shrinkIconBytes(bytes, mediaType, CAP), mediaType).toBeNull()
    }
  })

  it('answers null for corrupt bytes, so the original keeps its real size in the refusal', () => {
    const corrupt = Buffer.from(pngOf(64))
    corrupt.fill(0, 30)
    expect(shrinkIconBytes(new Uint8Array(corrupt), 'image/png', CAP)).toBeNull()
  })

  it('answers null when the source is past the decode bound', () => {
    const huge = Buffer.from(pngOf(16))
    huge.writeUInt32BE(ICON_SHRINK_MAX_SOURCE_PX + 1, 16)
    expect(shrinkIconBytes(new Uint8Array(huge), 'image/png', CAP)).toBeNull()
  })
})
