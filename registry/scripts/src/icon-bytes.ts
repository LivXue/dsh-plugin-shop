/**
 * What the bytes fetched for a declared icon must be (design
 * 2026-10-23-shop-plugin-icons §5.4), and what the catalog makes of the ones
 * that pass: the data URL it carries them as and the digest that keys them
 * (§6.1).
 *
 * The sentences an author reads when the bytes fail are not written here:
 * {@link iconDetail} owns every one of them, this module's two among them.
 *
 * Pure: no clock, no network, no filesystem, no environment, and no locale.
 *
 * @module icon-bytes
 */
import { createHash } from 'node:crypto'
import { iconDetail, iconLabel, shownPath } from './icon-declaration.ts'
import type { IconDeclaration, IconMediaType } from './icon-declaration.ts'

/**
 * The most bytes an icon may have for the catalog to carry it. It is dsh's own
 * bound for an icon a plugin market index carries inline
 * (`MAX_INLINE_ICON_BYTES`), not the 256 KiB dsh reads from an installed
 * package: the bytes sit in a file every shop download carries, and the larger
 * bound would have grown it several-fold (design decision 9 and §6.2 keep the
 * measurement). A larger icon is refused, and its entry draws the default
 * artwork.
 *
 * `iconDetail` writes this bound out as "32 KiB" in the sentences an author
 * reads, because it sits below this module and cannot import it. Moving the
 * constant means moving that copy, and the test that holds the one to the other
 * fails until both have moved.
 */
export const MAX_CATALOG_ICON_BYTES = 32 * 1024

/** The eight bytes every PNG file starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * The start-of-image marker, and the `FF` that opens the marker after it. Every
 * JPEG file has both: a marker opens with `FF`, and so does any fill byte
 * ahead of it.
 */
const JPEG_START = [0xff, 0xd8, 0xff]

/** `RIFF`, which opens the container, and `WEBP`, which names its form after a four-byte size. */
const RIFF = [0x52, 0x49, 0x46, 0x46]
const WEBP = [0x57, 0x45, 0x42, 0x50]

/**
 * The byte order marks that make a file UTF-16, each with the decoder it
 * selects. The mark is no part of the text, and the decode steps over it.
 * UTF-16 with no mark is not UTF-16 here, in any form, the `<?` patterns that
 * XML 1.0 Appendix F detects included: it drew in neither Chromium nor Firefox
 * (design §5.4), so it is read like any other bytes, one character each, and
 * has no root.
 */
const UTF16_MARKS = [
  { label: 'utf-16le', mark: [0xff, 0xfe] },
  { label: 'utf-16be', mark: [0xfe, 0xff] },
] as const

/**
 * Whether some measured browser draws the bytes as an image of `mediaType`, the
 * type the icon's extension names and the type its data URL carries (design
 * §5.4).
 *
 * dsh chooses an icon's type by its extension and never sniffs, and the
 * browser it draws in does: measured with data URLs in an `<img>`, Chromium
 * and Firefox draw a PNG, a JPEG or a WebP under any of the three raster
 * types, and Firefox draws one under `image/svg+xml` too; neither draws SVG
 * text under a raster type. So a raster is accepted whichever extension it
 * carries, and SVG text only under `.svg`, and the data URL keeps the
 * extension's type, as dsh does, so the icon draws in the shop wherever it
 * draws on dsh's page. Of the four formats dsh names, what is refused is what
 * neither browser draws, and the refusal can truly say that the file does not
 * hold what its extension promises. A file of any other format is refused too,
 * though GIF, BMP and ICO draw under a raster type: the check knows only those
 * four, and the sentence is still true of such a file (design §5.4). For SVG,
 * which browsers read in more than one encoding, design §5.4 gives what was
 * measured, and the check follows it.
 *
 * A type check and no more, and not a sanitiser: an SVG is defended by
 * reaching the page only as an image's `src` (§8.5). A raster is read for its
 * opening bytes and nothing past them ({@link isRaster}). SVG is a first
 * element named `svg` ({@link startsWithSvgElement}), found in a text built
 * from the whole file ({@link svgText}), so the bytes must already be held to
 * {@link MAX_CATALOG_ICON_BYTES}, as {@link checkIconBytes} holds them before
 * it asks.
 */
export function sniffIconBytes(bytes: Uint8Array, mediaType: IconMediaType): boolean {
  if (isRaster(bytes)) return true
  return mediaType === 'image/svg+xml' && startsWithSvgElement(svgText(bytes))
}

/**
 * Whether the bytes open as one of the three rasters: PNG's eight-byte
 * signature, {@link JPEG_START}, or `RIFF`, a four-byte size and `WEBP`.
 */
function isRaster(bytes: Uint8Array): boolean {
  return hasBytesAt(bytes, 0, PNG_SIGNATURE) || hasBytesAt(bytes, 0, JPEG_START) || (hasBytesAt(bytes, 0, RIFF) && hasBytesAt(bytes, 8, WEBP))
}

/** Whether `bytes` holds `expected` from `offset` on. A file too short to reach it does not. */
function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((byte, index) => bytes[offset + index] === byte)
}

/**
 * An SVG file's text. Only its prolog and root element are looked at, but the
 * text is built from every byte, by a decode or by a copy, so the bytes must
 * already be held to {@link MAX_CATALOG_ICON_BYTES}, as {@link checkIconBytes}
 * holds them before it asks.
 *
 * It is read in the encodings that keep a refusal true (design §5.4): the check
 * refuses only what no browser it was measured in draws, and accepts what some
 * browser draws, because a false acceptance costs nothing and a false refusal
 * publishes that the file holds no SVG data. A file that starts with a UTF-16
 * byte order mark ({@link UTF16_MARKS}) is decoded with replacement, as a
 * browser decodes it: a lone surrogate or a stray last byte becomes U+FFFD,
 * which opens no element and which a comment, an instruction or a literal
 * skips, and the file is read on. Replacement fails for no bytes, so nothing is
 * caught here; the one label that depends on the platform, `utf-16be`, needs
 * the ICU every official Node build carries. Any other bytes are read one
 * character each, so that UTF-8, ISO-8859-1 and the other ASCII-compatible
 * encodings an XML declaration may name all show the same ASCII prolog and root
 * name. An author's own non-ASCII characters land at U+0080 and above, which
 * {@link isNameChar} accepts inside a name and which the prolog skips inside a
 * comment, an instruction or a literal. UTF-16 with no mark is among those other
 * bytes, with a NUL between its characters, so it has no root.
 *
 * The scan stops at the root element, so how the rest of the file is encoded is
 * never checked: a browser that cannot decode the image draws the default
 * artwork (design decision 3). UTF-32 is not read either.
 */
function svgText(bytes: Uint8Array): string {
  for (const { label, mark } of UTF16_MARKS) {
    if (hasBytesAt(bytes, 0, mark)) return new TextDecoder(label).decode(bytes.subarray(mark.length))
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
}

/** XML's white space. */
function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

/** U+FEFF: how a byte order mark reads in text that was decoded, past the one the decoder strips from the start. */
const BYTE_ORDER_MARK = 0xfeff

/** UTF-8's byte order mark, `EF BB BF`, as the three characters it reads as in text read byte for byte. */
const UTF8_BYTE_ORDER_MARK = String.fromCharCode(0xef, 0xbb, 0xbf)

/** What opens and what closes a comment and a processing instruction. */
const COMMENT = { open: '<!--', close: '-->' }
const PROCESSING_INSTRUCTION = { open: '<?', close: '?>' }
const BRACKETED = [COMMENT, PROCESSING_INSTRUCTION]

/** The keyword that opens a document type declaration. */
const DOCTYPE = '<!DOCTYPE'

/**
 * Whether the first element of an SVG document's text is an `svg`, with a
 * namespace prefix or without one ({@link opensSvgElement}). Before it may
 * come any number of white space, byte order marks, processing instructions
 * (the XML declaration among them), comments and DOCTYPEs, in any order.
 *
 * That is looser than XML, which wants the declaration first with nothing
 * before it, one byte order mark and at most one DOCTYPE, and it is meant to
 * be. A false refusal tells an author something untrue about their file; a
 * false acceptance only draws the default artwork, where the browser fails to
 * decode the image (design decision 3).
 *
 * Every step moves forward and none is repeated, so the cost is one pass over
 * the text however a hostile file spells it. No regular expression is applied
 * to the author's text.
 */
function startsWithSvgElement(text: string): boolean {
  let at = 0
  for (;;) {
    const blank = blankLength(text, at)
    if (blank > 0) {
      at += blank
      continue
    }
    let past = indexAfterBracketed(text, at)
    if (past === undefined && text.startsWith(DOCTYPE, at)) past = indexAfterDoctype(text, at + DOCTYPE.length)
    if (past === undefined) return opensSvgElement(text, at)
    if (past === -1) return false
    at = past
  }
}

/** How many characters of white space or of a byte order mark start at `at`: one, three for UTF-8's mark read byte for byte, or none. */
function blankLength(text: string, at: number): number {
  const code = text.charCodeAt(at)
  if (isSpace(code) || code === BYTE_ORDER_MARK) return 1
  return text.startsWith(UTF8_BYTE_ORDER_MARK, at) ? UTF8_BYTE_ORDER_MARK.length : 0
}

/**
 * Whether an element named `svg`, or `prefix:svg` with a prefix of at least one
 * name character, opens at `at`: the `<`, the name, and then white space, `/` or
 * `>`, so that `<svgx>`, `<svg:svgx>` and `<:svg>` are no match. A prefix is how
 * an XML document binds SVG to its namespace with `xmlns:prefix`, and browsers
 * draw it; the binding itself is not checked.
 */
function opensSvgElement(text: string, at: number): boolean {
  if (text.charAt(at) !== '<') return false
  const first = endOfName(text, at + 1)
  const prefixed = text.charAt(first) === ':' && first > at + 1
  const localStart = prefixed ? first + 1 : at + 1
  const localEnd = prefixed ? endOfName(text, localStart) : first
  if (localEnd - localStart !== 'svg'.length || !text.startsWith('svg', localStart)) return false
  const after = text.charAt(localEnd)
  return after === '/' || after === '>' || isSpace(text.charCodeAt(localEnd))
}

/** The index of the first character at or after `from` that is no name character: the end of a name, a prefix included up to its colon. */
function endOfName(text: string, from: number): number {
  let at = from
  while (at < text.length && isNameChar(text.charCodeAt(at))) at += 1
  return at
}

/**
 * A character a name may hold here: an ASCII letter or digit, `_`, `-`, `.`, and
 * any character from U+0080 on. XML allows fewer of those, which is a false
 * acceptance and no more. The last class is there because text read byte for
 * byte shows an author's non-ASCII prefix as bytes from 0x80 up.
 */
function isNameChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x2d ||
    code === 0x2e ||
    code >= 0x80
  )
}

/** The index just past the first `terminator` at or after `from`, or -1 where there is none. */
function indexAfter(text: string, terminator: string, from: number): number {
  const found = text.indexOf(terminator, from)
  return found === -1 ? -1 : found + terminator.length
}

/**
 * The index just past the comment or processing instruction that opens at
 * `at`, -1 where it never closes, or `undefined` where neither opens there.
 * The one place either is defined, for the prolog and for a DOCTYPE's insides.
 */
function indexAfterBracketed(text: string, at: number): number | undefined {
  for (const { open, close } of BRACKETED) {
    if (text.startsWith(open, at)) return indexAfter(text, close, at + open.length)
  }
  return undefined
}

/**
 * The index just past a DOCTYPE whose keyword ends at `from`, or -1 where it
 * never ends. It ends at the first `>` that sits in none of the places a `>`
 * may: a quoted literal, which is where an identifier or an entity's value
 * can hold one, a comment or an instruction, and the bracketed internal
 * subset, where Adobe Illustrator's SVG 1.1 export declares its entities.
 * Stopping at the first `>` would end the DOCTYPE inside the subset and refuse
 * a file that is well-formed XML.
 */
function indexAfterDoctype(text: string, from: number): number {
  let at = indexOutsideLiterals(text, from, '[>')
  if (at === -1) return -1
  if (text.charAt(at) === '[') {
    // The subset ends at its own `]`, and the DOCTYPE runs on to its `>`.
    at = indexOutsideLiterals(text, at + 1, ']')
    if (at === -1) return -1
    at = indexOutsideLiterals(text, at + 1, '>')
    if (at === -1) return -1
  }
  return at + 1
}

/**
 * The index of the first character of `stops` at or after `from` that sits
 * outside every quoted literal, comment and processing instruction, or -1.
 * A quote opened and never closed, or a comment or instruction left open,
 * swallows the rest of the text and answers -1 with it.
 */
function indexOutsideLiterals(text: string, from: number, stops: string): number {
  let at = from
  while (at < text.length) {
    const char = text.charAt(at)
    if (stops.includes(char)) return at
    const past = char === '"' || char === "'" ? indexAfter(text, char, at + 1) : indexAfterBracketed(text, at)
    if (past === -1) return -1
    at = past ?? at + 1
  }
  return -1
}

/** How {@link iconDetail}'s `wrongBytes` names each type: the one the extension promised. */
const TYPE_NAMES: Readonly<Record<IconMediaType, string>> = {
  'image/svg+xml': 'SVG',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/webp': 'WebP',
}

/**
 * Whether the bytes fetched for `declaration` may be carried, or the sentence
 * its author is told where they may not: at most {@link MAX_CATALOG_ICON_BYTES},
 * and the kind of file the extension says ({@link sniffIconBytes}).
 *
 * `bytes` must be the whole file, because its length is the size the sentence
 * prints. A read that stopped at the cap, and so never learned the size,
 * reports `iconDetail.tooLarge(label, shown, null)` instead, without coming
 * here.
 *
 * The size is judged first. It is a comparison, and bytes the catalog would not
 * carry are not worth reading for what they hold. The path in a sentence is the
 * declaration's normalised one, quoted by {@link shownPath} because it is an
 * author's text.
 */
export function checkIconBytes(
  bytes: Uint8Array,
  declaration: IconDeclaration,
): { ok: true } | { ok: false; detail: string } {
  const label = iconLabel(declaration.source)
  const shown = shownPath(declaration.path)
  if (bytes.length > MAX_CATALOG_ICON_BYTES) return { ok: false, detail: iconDetail.tooLarge(label, shown, bytes.length) }
  if (!sniffIconBytes(bytes, declaration.mediaType)) {
    return { ok: false, detail: iconDetail.wrongBytes(label, shown, TYPE_NAMES[declaration.mediaType]) }
  }
  return { ok: true }
}

/**
 * The bytes as the `data:` URL the icons file carries them as and the shop sets
 * as an image's `src` (design §6.1): `data:<type>;base64,` and the standard
 * base64 alphabet, padded. Text, because the host's transport carries nothing
 * else, and the form dsh's own market index takes for an inline icon (§3.3).
 *
 * It does not check the bytes: the ones a caller passes are those that passed
 * {@link checkIconBytes}.
 */
export function iconDataUrl(bytes: Uint8Array, mediaType: IconMediaType): string {
  return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * The bytes' SHA-256 as lower-case hex: the key of the icons file's `icons`
 * map and the value of an entry's `icon`, so an icon that many plugins share is
 * carried once (design §6.1).
 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
