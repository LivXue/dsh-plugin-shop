# Shrinking an oversized icon instead of refusing it — design

Status: **built 2026-11-04.** The icon pipeline refused an icon larger than 32
KiB (`design 2026-10-23-shop-plugin-icons` decision 9). A reader reported the
consequence — `@tuweizhi/dsh-whale-widget` shows the default artwork because
its `icon.png` is 80.8 KiB — and this replaces the refusal for the two formats
that can be resampled. English only, per convention.

## 1. The measurement

`registry/icon-state.json` at `main` on 2026-11-04: 4,892 rows, of which 260
were refused for size — 5.3% of every icon ever declared, and the single
largest reason for a missing icon that is not "the author declared none".

| Format | Refused | Median | Max | Decodable here |
|---|---|---|---|---|
| PNG | 217 | 42.8 KiB | 1031.9 KiB | yes |
| WebP | 23 | 187.5 KiB | 250.5 KiB | no (needs a wasm codec) |
| SVG | 13 | 45.6 KiB | 236.7 KiB | no pixels to resample |
| JPEG | 7 | 32.0 KiB | 38.6 KiB | yes |

The card draws 24 px, or 48 on a 2× screen. A 512 px export is not a mistake
by its author; it is sized for a use this shelf does not have. Refusing it
costs the reader the icon, and carrying it unchanged costs the catalog's
budget.

## 2. Why not raise the cap

The 32 KiB cap is what makes the 16 MiB budget on the icons file reachable:
every icon is carried in one JSON, and the npm route downloads that whole
catalog package under a 32 MiB compressed / 64 MiB decompressed cap. Raising
the per-icon cap to 96 KiB would admit 196 more icons and add about 12 MiB of
base64 — past the budget — and every future raster would add to that. Shrinking
admits them at a few kilobytes each and leaves the budget where it is.

## 3. The rule

A fetched icon larger than `MAX_CATALOG_ICON_BYTES` is decoded and drawn into a
**64 px box**, then re-encoded:

- **Only PNG and JPEG are decoded.** WebP and GIF would need a wasm codec, and
  SVG has no pixels to resample. An oversized one of those keeps the refusal it
  had, whose sentence names the author's real file size.
- **The source size is read from the header before anything is decoded.** A
  30 KiB PNG may claim 60,000 × 60,000 and take the build down with it, so
  `pngSize` reads the IHDR and `jpegSize` walks the JPEG markers; a canvas past
  **2048 px** is left to the size refusal rather than allocated.
- **The aspect ratio is kept and the smaller axis is letterboxed** on
  transparent pixels, so a wide banner stays a wide banner inside the square
  the card reserves.
- **PNG first, JPEG second.** A 64 px icon of noise is ~16 KiB as PNG, so PNG
  almost always fits; a photographic icon that does not is offered as JPEG at
  quality 82. The type published is the one the bytes sniff as, never the
  declaration's — a JPEG produced from a PNG source is labelled `image/jpeg`.
- **Anything that still will not fit keeps the original bytes**, so the
  existing refusal sentence still reports the author's real size.

Where: `icon-normalize.ts` is pure (bytes in, bytes out) and `icon-plan.ts`'s
`settle` calls it before `checkIconBytes`, so every fetch path — tarball, raw
file, release asset — goes through one place, and the sha256 recorded and the
data URL published are both the shrunk bytes'.

## 4. The rows already refused

A recorded verdict is never re-asked, so the 260 size refusals would have kept
their verdicts forever. They were removed from `registry/icon-state.json` once,
in the same change: the next build treats each as unknown, fetches it again and
either publishes the shrunk bytes (the 224 PNG/JPEG) or records the same
refusal (the 36 WebP/SVG). One pass, no loop.

## 5. What this does not change

- The catalog format, the RPC shapes and the client are untouched: the shop
  already draws any `data:` URL at 24 px. **This ships with the daily build and
  needs no shop release.**
- The 16 MiB budget and its accounting.
- An icon the author ships under 32 KiB: byte-for-byte the same file.

## 6. Testing

- `icon-normalize.test.ts`: the header readers (a valid canvas, one past the
  bound, bytes that are not an image), the shrink (PNG and JPEG, under the cap,
  inside the box, aspect kept and letterboxed), the formats it does not decode,
  corrupt bytes, and a source past the decode bound.
- `icon-plan.test.ts`: an oversized real PNG settles `published` with a
  `data:image/png` URL that decodes to 64 × 64, alongside the existing refusal
  case that still holds for SVG.
