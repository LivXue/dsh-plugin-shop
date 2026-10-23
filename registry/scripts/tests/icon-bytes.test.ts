import { describe, expect, it } from 'vitest'
import { MAX_CATALOG_ICON_BYTES, checkIconBytes, iconDataUrl, sha256Hex, sniffIconBytes } from '../src/icon-bytes.ts'
import { iconDetail, shownPath } from '../src/icon-declaration.ts'
import type { IconDeclaration, IconMediaType } from '../src/icon-declaration.ts'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values)
const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0))
const riff = (form: string): Uint8Array => bytesOf(...ascii('RIFF'), 0x04, 0x00, 0x00, 0x00, ...ascii(form))

// The least each sniff reads, with padding after it: as far as this check goes,
// a signature is a file.
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00)
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)
const WEBP = riff('WEBP')
const SVG = utf8('<svg xmlns="http://www.w3.org/2000/svg"/>')

const SAMPLES: Record<IconMediaType, Uint8Array> = {
  'image/svg+xml': SVG,
  'image/png': PNG,
  'image/jpeg': JPEG,
  'image/webp': WEBP,
}
const MEDIA_TYPES: IconMediaType[] = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp']

/** Each type with a file name of its extension and the name `iconDetail` gives it. */
const FILES: [mediaType: IconMediaType, path: string, typeName: string][] = [
  ['image/svg+xml', 'icon.svg', 'SVG'],
  ['image/png', 'icon.png', 'PNG'],
  ['image/jpeg', 'icon.jpg', 'JPEG'],
  ['image/webp', 'icon.webp', 'WebP'],
]

function declare(path: string, mediaType: IconMediaType, source: IconDeclaration['source'] = 'icon'): IconDeclaration {
  return { source, path, mediaType }
}

/** The sample followed by zeros, `length` bytes in all. */
function padded(sample: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length)
  out.set(sample)
  return out
}

/** An SVG document of exactly `length` bytes whose padding is a comment, so it
 * stays a document a browser draws. */
function svgOfLength(length: number): Uint8Array {
  const head = '<svg xmlns="http://www.w3.org/2000/svg"><!--'
  const tail = '--></svg>'
  const encoded = utf8(head + 'x'.repeat(length - head.length - tail.length) + tail)
  // The fixture's arithmetic: all of it is ASCII, so characters are bytes.
  expect(encoded.length).toBe(length)
  return encoded
}

function refusal(bytes: Uint8Array, declaration: IconDeclaration): string {
  const result = checkIconBytes(bytes, declaration)
  if (result.ok) throw new Error(`expected ${declaration.path} to be refused, and it was accepted`)
  return result.detail
}

describe('sniffIconBytes: each format is its own type and no other', () => {
  it.each(MEDIA_TYPES.flatMap((actual) => MEDIA_TYPES.map((claimed): [IconMediaType, IconMediaType] => [actual, claimed])))(
    '%s bytes, read as %s',
    (actual, claimed) => {
      expect(sniffIconBytes(SAMPLES[actual], claimed)).toBe(actual === claimed)
    },
  )

  it.each(MEDIA_TYPES)('nothing at all is %s', (mediaType) => {
    expect(sniffIconBytes(new Uint8Array(0), mediaType)).toBe(false)
  })
})

describe('sniffIconBytes: the binary formats', () => {
  it.each<[what: string, bytes: Uint8Array, mediaType: IconMediaType, expected: boolean]>([
    ['the PNG signature, with padding after it', PNG, 'image/png', true],
    ['a PNG signature cut one byte short', PNG.subarray(0, 7), 'image/png', false],
    ['a PNG signature with its last byte changed', bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b, 0x00), 'image/png', false],
    ['a PNG signature that does not start the file', bytesOf(0x00, ...PNG), 'image/png', false],
    ['a JPEG start-of-image marker and the marker after it', bytesOf(0xff, 0xd8, 0xff, 0xe0), 'image/jpeg', true],
    ['the same with fill bytes before the second marker', bytesOf(0xff, 0xd8, 0xff, 0xff, 0xe1), 'image/jpeg', true],
    ['a start-of-image marker that nothing follows', bytesOf(0xff, 0xd8), 'image/jpeg', false],
    ['a start-of-image marker followed by no marker', bytesOf(0xff, 0xd8, 0x00, 0xe0), 'image/jpeg', false],
    ['RIFF, a size, and WEBP', WEBP, 'image/webp', true],
    ['RIFF, a size, and another form, a WAV file named .webp', riff('WAVE'), 'image/webp', false],
    ['RIFX, which is the same container in the other byte order', bytesOf(...ascii('RIFX'), 0x04, 0x00, 0x00, 0x00, ...ascii('WEBP')), 'image/webp', false],
    ['WEBP right after RIFF, with no size between', bytesOf(...ascii('RIFFWEBP'), 0x00, 0x00, 0x00, 0x00), 'image/webp', false],
    ['RIFF, a size, and WEBP cut one byte short', WEBP.subarray(0, 11), 'image/webp', false],
  ])('%s', (_what, bytes, mediaType, expected) => {
    expect(sniffIconBytes(bytes, mediaType)).toBe(expected)
  })
})

describe('sniffIconBytes: SVG', () => {
  // The shape Adobe Illustrator's SVG 1.1 export writes, its entity list
  // trimmed: a DOCTYPE with `>` inside it well before it ends. libxml2 and
  // expat both parse it, so refusing it would tell its author something untrue.
  const ILLUSTRATOR = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<!-- Generator: Adobe Illustrator 11.0.0, SVG Export Plug-In  -->',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [',
    '\t<!ENTITY ns_extend "http://ns.adobe.com/Extensibility/1.0/">',
    '\t<!ENTITY ns_ai "http://ns.adobe.com/AdobeIllustrator/10.0/">',
    ']>',
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="&ns_extend;">',
  ].join('\n')

  it.each<[what: string, text: string]>([
    ['an svg element', '<svg>'],
    ['an svg element that closes at once', '<svg/>'],
    ['an svg element whose attributes follow a line break', '<svg\n viewBox="0 0 1 1">'],
    ['a BOM, an XML declaration, a DOCTYPE and a comment before the element', '\uFEFF<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['white space before the element', ' \t\r\n<svg>'],
    ['processing instructions beyond the XML declaration', '<?xml version="1.0"?><?xml-stylesheet href="a.css"?><svg>'],
    ['comments and instructions, any number of them in any order', '<!-- a --><?p q?>\n<!-- b --><!DOCTYPE svg><!-- c --><?r?>\n<svg>'],
    ['a second BOM, which the decoder leaves in the text where it strips the first', '\uFEFF\uFEFF<svg>'],
    ['a comment that holds an <svg> and a double hyphen, and ends at the first -->', '<!-- <svg> -- <g> --><svg>'],
    ['a DOCTYPE whose quoted identifiers hold a ">"', '<!DOCTYPE svg PUBLIC "a>b" \'c>d\'><svg>'],
    ['a DOCTYPE with an internal subset, as Illustrator wrote them', ILLUSTRATOR],
    // One trap each. Two apostrophes in one subset would close each other as a
    // quoted literal and hide that the comment, or the instruction, was never skipped.
    ['a subset whose entity value holds a "]" and a ">"', '<!DOCTYPE svg [ <!ENTITY e "a ] > b"> ]><svg>'],
    ['a subset whose comment holds an apostrophe, a "]" and a ">"', '<!DOCTYPE svg [ <!-- it\'s ] > --> ]><svg>'],
    ['a subset whose instruction holds an apostrophe, a "]" and a ">"', '<!DOCTYPE svg [ <?pi \' ] > ?> ]><svg>'],
  ])('reads %s as SVG', (_what, text) => {
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(true)
  })

  it.each([' ', '\t', '\r', '\n'])('ends the name <svg at %j', (space) => {
    expect(sniffIconBytes(utf8(`<svg${space}width="1">`), 'image/svg+xml')).toBe(true)
  })

  it.each<[what: string, text: string]>([
    ['an html element', '<html>'],
    ['an element whose name merely starts with svg', '<svgx>'],
    ['an upper-case SVG element, since XML names are case-sensitive and SVG\'s root is svg', '<SVG>'],
    ['an empty file', ''],
    ['a start tag cut off after its name', '<svg'],
    ['text before the element', 'x<svg>'],
    ['another element first', '<g/><svg>'],
    ['markup after a prolog that is not svg', '<?xml version="1.0"?><!DOCTYPE svg><html><svg>'],
    ['an <svg> that only a comment holds', '<!-- <svg> --><html>'],
    ['a comment that never ends', '<!-- <svg>'],
    ['an instruction that never ends', '<?xml <svg>'],
    ['a DOCTYPE with a quote that never closes', '<!DOCTYPE svg PUBLIC "x><svg>'],
    ['a DOCTYPE whose internal subset never closes', '<!DOCTYPE svg [ <!ENTITY a "b"> <svg>'],
  ])('does not read %s as SVG', (_what, text) => {
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(false)
  })

  it.each<[what: string, bytes: Uint8Array]>([
    ['bytes that are not valid UTF-8', bytesOf(0xc3, 0x28)],
    ['an svg element followed by bytes that are not valid UTF-8', bytesOf(...ascii('<svg>'), 0xc3, 0x28)],
    ['an overlong encoding of a NUL', bytesOf(...ascii('<svg>'), 0xc0, 0x80)],
  ])('does not read %s as SVG', (_what, bytes) => {
    expect(sniffIconBytes(bytes, 'image/svg+xml')).toBe(false)
  })

  // The scan never goes back over what it has passed, so a prolog as long as an
  // icon may be costs a pass, and one that is never closed is refused after one.
  it('reads a prolog of as many comments as fit in an icon', () => {
    const text = `${'<!---->'.repeat(Math.floor(MAX_CATALOG_ICON_BYTES / '<!---->'.length))}<svg>`
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(true)
  })

  // Each filler holds nothing that would close its opener: no `-->`, no `?>`,
  // no quote of the kind that was opened, no `]` outside a literal.
  it.each<[opener: string, filler: string]>([
    ['<!--', '<svg> '],
    ['<?', '<svg> '],
    ['<!DOCTYPE "', '<svg> '],
    ["<!DOCTYPE '", '<svg> '],
    ['<!DOCTYPE [', '<!ENTITY a "b"> '],
  ])('refuses %j opened and never closed, over as many bytes as an icon may have', (opener, filler) => {
    const text = opener + filler.repeat(Math.ceil(MAX_CATALOG_ICON_BYTES / filler.length))
    expect(utf8(text).length).toBeGreaterThanOrEqual(MAX_CATALOG_ICON_BYTES)
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(false)
  })
})

describe('checkIconBytes', () => {
  const svg = declare('icon.svg', 'image/svg+xml')

  it('accepts an SVG exactly as long as the bound', () => {
    expect(checkIconBytes(svgOfLength(MAX_CATALOG_ICON_BYTES), svg)).toEqual({ ok: true })
  })

  it('refuses one byte more, and tells the author the bound', () => {
    const detail = refusal(svgOfLength(MAX_CATALOG_ICON_BYTES + 1), svg)
    expect(detail).toBe(iconDetail.tooLarge('package.json "icon"', '"icon.svg"', MAX_CATALOG_ICON_BYTES + 1))
    // The sentence as an author reads it: one byte over reads as 32.1, never 32.0.
    expect(detail.endsWith('is 32.1 KiB; the shop shows icons of at most 32 KiB.')).toBe(true)
  })

  // `iconDetail` sits below this module, cannot import the constant, and so
  // writes the bound out in its copy, in both of the sentences below. If the
  // constant moves and the copy does not, an author is told a bound the build
  // does not apply; this is what makes one change drag the other.
  it('states the bound the constant sets, in the copy for a known size and for an unknown one', () => {
    const kib = MAX_CATALOG_ICON_BYTES / 1024
    expect(refusal(svgOfLength(MAX_CATALOG_ICON_BYTES + 1), svg)).toContain(`icons of at most ${kib} KiB.`)
    expect(iconDetail.tooLarge('package.json "icon"', '"icon.svg"', null)).toContain(`is larger than ${kib} KiB;`)
    expect(iconDetail.tooLarge('package.json "icon"', '"icon.svg"', null)).toContain(`icons of at most ${kib} KiB.`)
  })

  it.each(FILES)('applies the bound to a %s file too', (mediaType, path) => {
    expect(checkIconBytes(padded(SAMPLES[mediaType], MAX_CATALOG_ICON_BYTES), declare(path, mediaType))).toEqual({ ok: true })
    expect(refusal(padded(SAMPLES[mediaType], MAX_CATALOG_ICON_BYTES + 1), declare(path, mediaType)))
      .toBe(iconDetail.tooLarge('package.json "icon"', shownPath(path), MAX_CATALOG_ICON_BYTES + 1))
  })

  it('judges the size before the type: a file over the bound that is also the wrong type is refused for its size', () => {
    const big = new Uint8Array(MAX_CATALOG_ICON_BYTES + 1)
    expect(refusal(big, declare('icon.png', 'image/png'))).toBe(iconDetail.tooLarge('package.json "icon"', '"icon.png"', big.length))
  })

  it('refuses PNG bytes declared as icon.svg', () => {
    expect(refusal(PNG, svg)).toBe(iconDetail.wrongBytes('package.json "icon"', '"icon.svg"', 'SVG'))
  })

  it.each(FILES)('refuses html bytes declared as a %s file, %s, as not holding %s data', (mediaType, path, typeName) => {
    expect(refusal(utf8('<html>'), declare(path, mediaType))).toBe(iconDetail.wrongBytes('package.json "icon"', shownPath(path), typeName))
  })

  it.each(FILES)('accepts a small %s file that holds what its extension says', (mediaType, path) => {
    expect(checkIconBytes(SAMPLES[mediaType], declare(path, mediaType))).toEqual({ ok: true })
  })

  it('refuses a file with nothing in it for what it is not, not for its size', () => {
    expect(refusal(new Uint8Array(0), declare('icon.png', 'image/png'))).toBe(iconDetail.wrongBytes('package.json "icon"', '"icon.png"', 'PNG'))
  })

  it.each<[source: IconDeclaration['source'], label: string]>([
    ['icon', 'package.json "icon"'],
    ['export', 'the "./icon" export'],
  ])('names a declaration that came from %s as %s, in either refusal', (source, label) => {
    expect(refusal(PNG, declare('icon.svg', 'image/svg+xml', source))).toBe(iconDetail.wrongBytes(label, '"icon.svg"', 'SVG'))
    expect(refusal(svgOfLength(MAX_CATALOG_ICON_BYTES + 1), declare('icon.svg', 'image/svg+xml', source)))
      .toBe(iconDetail.tooLarge(label, '"icon.svg"', MAX_CATALOG_ICON_BYTES + 1))
  })

  it('quotes an author\'s path with shownPath, so a newline in it never reaches a sentence', () => {
    const path = 'a"b\nc.svg'
    expect(shownPath(path)).not.toContain('\n')
    expect(refusal(PNG, declare(path, 'image/svg+xml'))).toBe(iconDetail.wrongBytes('package.json "icon"', shownPath(path), 'SVG'))
    expect(refusal(svgOfLength(MAX_CATALOG_ICON_BYTES + 1), declare(path, 'image/svg+xml')))
      .toBe(iconDetail.tooLarge('package.json "icon"', shownPath(path), MAX_CATALOG_ICON_BYTES + 1))
  })
})

describe('iconDataUrl', () => {
  it('encodes the bytes as a base64 data URL of the type', () => {
    expect(iconDataUrl(utf8('<svg/>'), 'image/svg+xml')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  it.each(MEDIA_TYPES)('opens with the %s type and nothing else', (mediaType) => {
    expect(iconDataUrl(SAMPLES[mediaType], mediaType).startsWith(`data:${mediaType};base64,`)).toBe(true)
  })

  it.each<[what: string, bytes: Uint8Array, encoded: string]>([
    ['no bytes', new Uint8Array(0), ''],
    ['one byte, padded with two "="', bytesOf(0x66), 'Zg=='],
    ['two bytes, padded with one "="', bytesOf(0x66, 0x6f), 'Zm8='],
    ['three bytes, which need none', bytesOf(0x66, 0x6f, 0x6f), 'Zm9v'],
    ['bytes that use "+" and "/" of the standard alphabet, never "-" and "_"', bytesOf(0xfb, 0xff), '+/8='],
  ])('writes %s as standard base64 with padding', (_what, bytes, encoded) => {
    expect(iconDataUrl(bytes, 'image/png')).toBe(`data:image/png;base64,${encoded}`)
  })

  it('encodes the bytes a view covers, and not the buffer it sits in', () => {
    const whole = utf8('xx<svg/>yy')
    expect(iconDataUrl(whole.subarray(2, 8), 'image/svg+xml')).toBe('data:image/svg+xml;base64,PHN2Zy8+')
  })

  // Task 6 reads the icons file back by this grammar and no other: the type,
  // `;base64,`, then the standard alphabet in groups of four, padded.
  it('writes one grammar, for every type and for every length modulo three', () => {
    for (const mediaType of MEDIA_TYPES) {
      for (let length = 0; length <= 9; length++) {
        const url = iconDataUrl(new Uint8Array(length).fill(0xab), mediaType)
        expect(url).toMatch(/^data:image\/(?:svg\+xml|png|jpeg|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      }
    }
  })
})

describe('sha256Hex', () => {
  it.each<[what: string, bytes: Uint8Array, digest: string]>([
    ['no bytes', new Uint8Array(0), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['"abc"', utf8('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ])('hashes %s to its lower-case hex digest', (_what, bytes, digest) => {
    expect(sha256Hex(bytes)).toBe(digest)
  })

  it('hashes the bytes a view covers, and not the buffer it sits in', () => {
    expect(sha256Hex(utf8('xxabcyy').subarray(2, 5))).toBe(sha256Hex(utf8('abc')))
  })
})
