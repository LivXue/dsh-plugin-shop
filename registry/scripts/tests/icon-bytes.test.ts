import { isUtf8 } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { MAX_CATALOG_ICON_BYTES, checkIconBytes, iconDataUrl, sha256Hex, sniffIconBytes } from '../src/icon-bytes.ts'
import { iconDetail, shownPath } from '../src/icon-declaration.ts'
import type { IconDeclaration, IconMediaType } from '../src/icon-declaration.ts'

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text)
const latin1 = (text: string): Uint8Array => Buffer.from(text, 'latin1')
const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values)
const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0))
const riff = (form: string): Uint8Array => bytesOf(...ascii('RIFF'), 0x04, 0x00, 0x00, 0x00, ...ascii(form))

/** U+FEFF, the byte order mark, built here so that no invisible character sits in this file. */
const BOM = String.fromCharCode(0xfeff)
/** UTF-16 as a file holds it, with the byte order mark that announces it. */
const utf16le = (text: string): Buffer => Buffer.from(BOM + text, 'utf16le')
const utf16be = (text: string): Buffer => Buffer.from(BOM + text, 'utf16le').swap16()
/** UTF-16 that nothing announces. */
const bareUtf16le = (text: string): Buffer => Buffer.from(text, 'utf16le')
const bareUtf16be = (text: string): Buffer => Buffer.from(text, 'utf16le').swap16()

const SVG_NS = 'http://www.w3.org/2000/svg'
const SVG_ROOT = `<svg xmlns="${SVG_NS}"/>`

// The least each sniff reads, with padding after it: as far as this check goes,
// a signature is a file.
const PNG = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00)
const JPEG = bytesOf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10)
const WEBP = riff('WEBP')
const SVG = utf8(SVG_ROOT)

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

// SVG files outside plain ASCII or well-formed UTF-8: ISO-8859-1 that says so,
// with a byte past 0x7F, which Firefox draws and Chromium does not; UTF-8 with
// text past ASCII; and a prolog comment that holds bytes that are no UTF-8.
const COPYRIGHT = String.fromCharCode(0xa9)
const GRINNING_FACE = String.fromCodePoint(0x1f600)
/** An ISO-8859-1 document that says so, with byte A9 in a comment and in its title. */
const ISO_8859_1 = latin1(
  `<?xml version="1.0" encoding="ISO-8859-1"?>\n<!-- ${COPYRIGHT} 2026 -->\n<svg xmlns="${SVG_NS}"><title>${COPYRIGHT} icon</title></svg>`,
)
const NON_ASCII_UTF8 = utf8(`<svg xmlns="${SVG_NS}"><title>图标</title></svg>`)
/** Bytes C3 28 are no UTF-8, and this puts them in a comment ahead of the root. */
const INVALID_UTF8_IN_A_COMMENT = Buffer.concat([utf8('<!-- '), bytesOf(0xc3, 0x28), utf8(` -->${SVG_ROOT}`)])

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
  const head = `<svg xmlns="${SVG_NS}"><!--`
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

describe('the fixtures', () => {
  it('are in the encodings their names say', () => {
    expect([...utf16le('<').subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00])
    expect([...utf16be('<').subarray(0, 4)]).toEqual([0xfe, 0xff, 0x00, 0x3c])
    expect([...bareUtf16le('<')]).toEqual([0x3c, 0x00])
    expect([...bareUtf16be('<')]).toEqual([0x00, 0x3c])
    // The four bytes of `<?` that XML 1.0 Appendix F reads as UTF-16 with no
    // mark: the refused rows that open this way are the shape it detects.
    expect([...bareUtf16le('<?')]).toEqual([0x3c, 0x00, 0x3f, 0x00])
    expect([...bareUtf16be('<?')]).toEqual([0x00, 0x3c, 0x00, 0x3f])
    expect(ISO_8859_1.filter((byte) => byte === 0xa9)).toHaveLength(2)
    expect(isUtf8(ISO_8859_1)).toBe(false)
    expect(isUtf8(INVALID_UTF8_IN_A_COMMENT)).toBe(false)
    expect(isUtf8(NON_ASCII_UTF8)).toBe(true)
    expect(NON_ASCII_UTF8.some((byte) => byte >= 0x80)).toBe(true)
  })
})

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

describe('sniffIconBytes: SVG, what may come before the root', () => {
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
    `<svg xmlns="${SVG_NS}" xmlns:x="&ns_extend;"/>`,
  ].join('\n')

  it.each<[what: string, text: string]>([
    ['an svg element', '<svg>'],
    ['an svg element that closes at once', '<svg/>'],
    ['an svg element whose attributes follow a line break', '<svg\n viewBox="0 0 1 1">'],
    ['a BOM, an XML declaration, a DOCTYPE and a comment before the element', `${BOM}<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<!-- c --><svg xmlns="${SVG_NS}"/>`],
    ['white space before the element', ' \t\r\n<svg>'],
    ['processing instructions beyond the XML declaration', '<?xml version="1.0"?><?xml-stylesheet href="a.css"?><svg>'],
    ['comments and instructions, any number of them in any order', '<!-- a --><?p q?>\n<!-- b --><!DOCTYPE svg><!-- c --><?r?>\n<svg>'],
    ['a second BOM, skipped like white space', `${BOM}${BOM}<svg>`],
    ['a BOM after white space, in any order', ` ${BOM}<svg>`],
    ['a comment that holds an <svg> and a double hyphen, and ends at the first -->', '<!-- <svg> -- <g> --><svg>'],
    ['a comment that holds a ">"', '<!-- a > b --><svg>'],
    ['a processing instruction that holds a ">"', '<?p a>b?><svg>'],
    ['a DOCTYPE whose system literal holds a ">"', '<!DOCTYPE svg SYSTEM "c>d"><svg>'],
    ['the same in single quotes', "<!DOCTYPE svg SYSTEM 'c>d'><svg>"],
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
    // A prolog is not a document: no root is no SVG, however much comes before it.
    ['an XML declaration and nothing after it', '<?xml version="1.0"?>'],
    ['an XML declaration and white space after it', '<?xml version="1.0"?>\n'],
    ['a comment and nothing after it', '<!-- c -->'],
    ['a DOCTYPE and nothing after it', '<!DOCTYPE svg>'],
    ['a byte order mark and nothing after it', BOM],
    ['white space and nothing else', ' \n'],
  ])('does not read %s as SVG', (_what, text) => {
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(false)
  })
})

describe('sniffIconBytes: SVG, the name of the root element', () => {
  it.each<[what: string, text: string]>([
    ['svg:svg bound to the SVG namespace', `<svg:svg xmlns:svg="${SVG_NS}"/>`],
    ['a one-letter prefix', `<s:svg xmlns:s="${SVG_NS}" width="1"/>`],
    ['a prefix of every name-character class: both cases of letter, a digit, "_", "-" and "."', `<Ab-c.d_e1:svg xmlns:Ab-c.d_e1="${SVG_NS}"/>`],
    ['a prefix outside ASCII, in UTF-8', `<图:svg xmlns:图="${SVG_NS}"/>`],
    ['a prefixed root after a prolog', `<?xml version="1.0"?><!-- c --><s:svg xmlns:s="${SVG_NS}">`],
    ['a prefixed root followed by a line break', '<s:svg\n  width="1">'],
  ])('reads %s as SVG', (_what, text) => {
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(true)
  })

  it('reads a prefix outside ASCII in ISO-8859-1', () => {
    const e = String.fromCharCode(0xe9)
    const bytes = latin1(`<?xml version="1.0" encoding="ISO-8859-1"?><${e}:svg xmlns:${e}="${SVG_NS}"/>`)
    expect(isUtf8(bytes)).toBe(false)
    expect(sniffIconBytes(bytes, 'image/svg+xml')).toBe(true)
  })

  it.each<[what: string, text: string]>([
    ['svg followed by more name', '<svgx>'],
    ['a name that ends in svg', '<xsvg>'],
    ['the letters svg with no "<" before them', 'xsvg>'],
    ['a prefixed root whose local name merely starts with svg', '<svg:svgx>'],
    ['an empty prefix', '<:svg>'],
    ['an empty local name', '<svg:>'],
    ['an empty prefix and a second colon', '<svg::svg>'],
    ['two prefixes', '<svg:svg:svg>'],
    ['a prefix that ends where white space begins', '<a b:svg>'],
    ['an upper-case local name', '<s:SVG>'],
    ['white space between "<" and the name', '< svg>'],
    ['a prefixed root cut off after its name', '<s:svg'],
  ])('does not read %s as SVG', (_what, text) => {
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(false)
  })
})

// A refusal tells the author their file does not hold SVG data, so the sniff
// refuses only what no browser it was measured in draws, and accepts what some
// browser draws (Chromium and Firefox, 2026-10-23): UTF-16 with a byte order
// mark, decoded with replacement, which both draw; and ISO-8859-1 that says so,
// with a byte past 0x7F, which Firefox draws. UTF-16 with no mark drew in
// neither, so it is refused whatever it opens with.
describe('sniffIconBytes: SVG, the encodings a browser reads', () => {
  const prolog = (declared: string): string => `<?xml version="1.0" encoding="${declared}"?><!-- ${GRINNING_FACE} --><!DOCTYPE svg>${SVG_ROOT}`

  it.each<[what: string, bytes: Uint8Array]>([
    ['UTF-16 little-endian with its byte order mark', utf16le(SVG_ROOT)],
    ['UTF-16 big-endian with its byte order mark', utf16be(SVG_ROOT)],
    ['UTF-16 little-endian with a declaration, a comment past the BMP and a DOCTYPE', utf16le(prolog('UTF-16'))],
    ['UTF-16 big-endian with the same', utf16be(prolog('UTF-16'))],
    ['UTF-16 with a byte order mark after white space', utf16le(` ${BOM}${SVG_ROOT}`)],
    ['UTF-16 with a prefixed root', utf16le(`<s:svg xmlns:s="${SVG_NS}"/>`)],
    // A browser decodes UTF-16 with replacement: a stray last byte, or a lone
    // surrogate, becomes U+FFFD and the file is read on. Each of these has its
    // root where the replacement cannot reach it, after it or past a comment.
    ['UTF-16 little-endian with a stray byte after the root, which a browser decodes to U+FFFD', Buffer.concat([utf16le(SVG_ROOT), bytesOf(0x41)])],
    ['UTF-16 big-endian with a stray byte after the root, which a browser decodes to U+FFFD', Buffer.concat([utf16be(SVG_ROOT), bytesOf(0x41)])],
    ['UTF-16 little-endian with a lone high surrogate after the root, which a browser decodes to U+FFFD', Buffer.concat([utf16le(SVG_ROOT), bytesOf(0x00, 0xd8)])],
    ['UTF-16 big-endian with a lone high surrogate after the root, which a browser decodes to U+FFFD', Buffer.concat([utf16be(SVG_ROOT), bytesOf(0xd8, 0x00)])],
    ['UTF-16 little-endian with a lone low surrogate in a comment before the root', Buffer.concat([utf16le('<!--'), bytesOf(0x00, 0xdc), Buffer.from(`-->${SVG_ROOT}`, 'utf16le')])],
    ['ISO-8859-1 that says so, holding byte A9 in a comment and in a title', ISO_8859_1],
    ['UTF-8 holding text outside ASCII', NON_ASCII_UTF8],
    ['UTF-8 with a byte order mark and text outside ASCII', Buffer.concat([bytesOf(0xef, 0xbb, 0xbf), NON_ASCII_UTF8])],
    // Only the prolog and the root are read, so what comes after is nobody's to
    // judge here: the browser draws or it does not, and the shop falls back.
    ['bytes that are no UTF-8 inside a comment before the root', INVALID_UTF8_IN_A_COMMENT],
    ['an svg element followed by bytes that are no UTF-8', bytesOf(...ascii('<svg>'), 0xc3, 0x28)],
    ['an svg element followed by an overlong NUL', bytesOf(...ascii('<svg>'), 0xc0, 0x80)],
    ['an svg element followed by a lone surrogate written as UTF-8', bytesOf(...ascii('<svg>'), 0xed, 0xa0, 0x80)],
  ])('reads %s as SVG', (_what, bytes) => {
    expect(sniffIconBytes(bytes, 'image/svg+xml')).toBe(true)
  })

  // Replacement decodes what is ill-formed and makes no root of it: a stray byte
  // or a lone surrogate after a mark is U+FFFD, and U+FFFD opens no element.
  // Nor does a UTF-16 file that announces itself and holds no root.
  it.each<[what: string, bytes: Uint8Array]>([
    ['a UTF-16 byte order mark and one stray byte, which decode to no root', bytesOf(0xff, 0xfe, 0x3c)],
    ['a UTF-16 byte order mark and a lone surrogate, which decode to no root', bytesOf(0xff, 0xfe, 0x00, 0xd8)],
    ['a UTF-16 little-endian byte order mark and nothing after it', bytesOf(0xff, 0xfe)],
    ['a UTF-16 big-endian byte order mark and nothing after it', bytesOf(0xfe, 0xff)],
  ])('does not read %s as SVG', (_what, bytes) => {
    expect(sniffIconBytes(bytes, 'image/svg+xml')).toBe(false)
  })

  // UTF-16 with no byte order mark is refused in every form. It drew in neither
  // Chromium nor Firefox (2026-10-23), whatever it opened with, the XML
  // declaration in both byte orders that XML 1.0 Appendix F detects among
  // them. Read one character per byte it has a NUL between its characters, so
  // it has no root.
  it.each<[what: string, bytes: Uint8Array]>([
    ['UTF-16 little-endian with no mark that opens with an XML declaration, which no measured browser draws in an img', bareUtf16le(prolog('UTF-16'))],
    ['UTF-16 big-endian with no mark that opens with an XML declaration, which no measured browser draws in an img', bareUtf16be(prolog('UTF-16'))],
    ['UTF-16 little-endian with no mark that opens with an instruction that is no declaration, which no measured browser draws in an img', bareUtf16le(`<?p q?>${SVG_ROOT}`)],
    ['UTF-16 big-endian with no mark that opens with an instruction that is no declaration, which no measured browser draws in an img', bareUtf16be(`<?p q?>${SVG_ROOT}`)],
    ['UTF-16 with no mark and a stray byte after the root, which no measured browser draws in an img', Buffer.concat([bareUtf16le(prolog('UTF-16')), bytesOf(0x41)])],
    ['UTF-16 with no mark and a lone surrogate after the root, which no measured browser draws in an img', Buffer.concat([bareUtf16le(prolog('UTF-16')), bytesOf(0x00, 0xd8)])],
    ['UTF-16 little-endian with no mark that opens with an XML declaration and holds no root', bareUtf16le('<?xml version="1.0"?>')],
    ['UTF-16 big-endian with no mark that opens with an XML declaration and holds no root', bareUtf16be('<?xml version="1.0"?>')],
    ['UTF-16 little-endian with no mark and no declaration, `<svg/>`', bareUtf16le(SVG_ROOT)],
    ['UTF-16 big-endian with no mark and no declaration, `<svg/>`', bareUtf16be(SVG_ROOT)],
    ['UTF-16 with no mark that opens with a comment', bareUtf16le(`<!-- c -->${SVG_ROOT}`)],
    ['UTF-16 with no mark that opens with white space and then a declaration', bareUtf16le(` ${prolog('UTF-16')}`)],
  ])('refuses %s', (_what, bytes) => {
    expect(sniffIconBytes(bytes, 'image/svg+xml')).toBe(false)
  })

  it.each<[what: string, bytes: Uint8Array]>([
    ['the first three bytes of `<?` in UTF-16', bytesOf(0x3c, 0x00, 0x3f)],
    ['two bytes that are no text at all, C3 28', bytesOf(0xc3, 0x28)],
  ])('does not read %s as SVG', (_what, bytes) => {
    expect(sniffIconBytes(bytes, 'image/svg+xml')).toBe(false)
  })

  it('reads the bytes a view covers, and not the buffer it sits in', () => {
    const text = utf8(`xx${SVG_ROOT}yy`)
    expect(sniffIconBytes(text.subarray(2, 2 + SVG_ROOT.length), 'image/svg+xml')).toBe(true)
    expect(sniffIconBytes(text.subarray(1, 2 + SVG_ROOT.length), 'image/svg+xml')).toBe(false)
    const wide = Buffer.concat([bytesOf(0x41, 0x42), utf16le(SVG_ROOT)])
    expect(sniffIconBytes(wide.subarray(2), 'image/svg+xml')).toBe(true)
    expect(sniffIconBytes(wide, 'image/svg+xml')).toBe(false)
  })
})

// None of these is read twice, so what an author's file can cost is a pass over it.
describe('sniffIconBytes: SVG, hostile shapes at the length of an icon', () => {
  it('reads a prolog of as many comments as fit in an icon', () => {
    const text = `${'<!---->'.repeat(Math.floor(MAX_CATALOG_ICON_BYTES / '<!---->'.length))}<svg>`
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(true)
  })

  it('reads a UTF-16 prolog of comments over as many bytes as an icon may have', () => {
    const file = utf16le(`${'<!---->'.repeat(Math.ceil(MAX_CATALOG_ICON_BYTES / 2 / '<!---->'.length))}<svg>`)
    expect(file.length).toBeGreaterThanOrEqual(MAX_CATALOG_ICON_BYTES)
    expect(sniffIconBytes(file, 'image/svg+xml')).toBe(true)
  })

  it('refuses the same with no mark, over as many bytes as an icon may have, whatever it opens with', () => {
    const file = bareUtf16le(`<?p?>${'<!---->'.repeat(Math.ceil(MAX_CATALOG_ICON_BYTES / 2 / '<!---->'.length))}<svg>`)
    expect(file.length).toBeGreaterThanOrEqual(MAX_CATALOG_ICON_BYTES)
    expect(sniffIconBytes(file, 'image/svg+xml')).toBe(false)
  })

  // Every other unit of the comment is a lone surrogate, which is replaced, and
  // the root is still found after it.
  it('reads a UTF-16 comment of lone surrogates over as many bytes as an icon may have, then svg', () => {
    const unit = Buffer.concat([bytesOf(0x00, 0xd8), Buffer.from('a', 'utf16le')])
    const comment = Buffer.concat(Array.from({ length: Math.ceil(MAX_CATALOG_ICON_BYTES / unit.length) }, () => unit))
    const file = Buffer.concat([utf16le('<!--'), comment, Buffer.from(`-->${SVG_ROOT}`, 'utf16le')])
    expect(file.length).toBeGreaterThanOrEqual(MAX_CATALOG_ICON_BYTES)
    expect(sniffIconBytes(file, 'image/svg+xml')).toBe(true)
  })

  it('refuses UTF-16 that is nothing but lone surrogates, over as many bytes as an icon may have', () => {
    const file = Buffer.concat([bytesOf(0xff, 0xfe), Buffer.alloc(MAX_CATALOG_ICON_BYTES, bytesOf(0x00, 0xd8))])
    expect(sniffIconBytes(file, 'image/svg+xml')).toBe(false)
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

  it.each<[what: string, text: string, expected: boolean]>([
    ['an element name as long as an icon', `<${'a'.repeat(MAX_CATALOG_ICON_BYTES)}`, false],
    ['a prefix as long as an icon, then svg', `<${'a'.repeat(MAX_CATALOG_ICON_BYTES)}:svg>`, true],
    ['a name that is all colons', `<${':'.repeat(MAX_CATALOG_ICON_BYTES)}`, false],
    ['a prefix and a colon, repeated to the length of an icon', `<${'a:'.repeat(MAX_CATALOG_ICON_BYTES / 2)}svg>`, false],
    ['white space as long as an icon, then svg', `${' '.repeat(MAX_CATALOG_ICON_BYTES)}<svg>`, true],
  ])('reads %s once', (_what, text, expected) => {
    expect(utf8(text).length).toBeGreaterThanOrEqual(MAX_CATALOG_ICON_BYTES)
    expect(sniffIconBytes(utf8(text), 'image/svg+xml')).toBe(expected)
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

  // The sentence says the file holds no SVG data, so it is said of files no
  // measured browser draws, and not of UTF-16 with a mark or of ISO-8859-1.
  it('does not tell the author of a UTF-16 SVG with a byte order mark, or of an ISO-8859-1 one, that it holds no SVG data', () => {
    expect(checkIconBytes(utf16le(SVG_ROOT), svg)).toEqual({ ok: true })
    expect(checkIconBytes(utf16be(SVG_ROOT), svg)).toEqual({ ok: true })
    expect(checkIconBytes(Buffer.concat([utf16le(SVG_ROOT), bytesOf(0x41)]), svg)).toEqual({ ok: true })
    expect(checkIconBytes(ISO_8859_1, svg)).toEqual({ ok: true })
  })

  it('tells the author of a UTF-16 SVG with no byte order mark, which no measured browser draws, that it holds no SVG data', () => {
    const bytes = bareUtf16le(`<?xml version="1.0" encoding="UTF-16"?>${SVG_ROOT}`)
    expect(refusal(bytes, svg)).toBe(iconDetail.wrongBytes('package.json "icon"', '"icon.svg"', 'SVG'))
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
