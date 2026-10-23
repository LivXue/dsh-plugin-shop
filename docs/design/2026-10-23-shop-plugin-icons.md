# Plugin icons on the shop page — design

Status: **proposed** (2026-10-23). LivXue asked for it on 2026-10-22 and took
each decision in §2 on 2026-10-23, the look from mockups shot on a real dsh
(§2.4). Nothing is built. It touches four places: the catalog build (§4, §5),
the catalog format (§6), the shop's host (§7) and the shop page (§8). The
format change is one the host reads, so the shop ships it through `beta` first
(§12). English only, per convention.

Every harness fact below that names no other source was read in the installed
bundles of dsh 0.1.5-rc.3, 0.1.7-rc.2, 0.2.0-rc.2 and 0.2.1-rc.2
(`.claude/worktrees/.dsh0{15,17,20,21}-prefix`) on 2026-10-23. Every catalog
figure was measured on 2026-10-23 against the catalog published that morning
(`schemaVersion` 5, 18,276 entries).

## 1. Why

**dsh draws a plugin's own icon; the shop draws none.** Since 0.1.7 a plugin
can declare an icon and dsh's sidebar Plugins page draws it beside the
plugin's name (§3). dsh 0.2.1 also ships a market of its own whose index
carries an icon per plugin. The shop, where a reader meets a plugin before
installing it, shows a name in monospace and nothing else, so a plugin whose
author drew an icon looks exactly like one whose author did not, and the
reader who installs it then meets an icon in dsh they never saw in the shop.

**Most plugins have none, so the absence has to look right too.** Every 4th
npm line of the 2026-10-23 `registry/snapshots/manifest.lock` was read from
the registry (1,984 manifests): 289 declare an icon (14.6%), 183 through a
package.json `icon` alone, 78 through an `./icon` export alone, 28 through
both. A first sample, on a lock two weeks older, read 16 of 318 (5.0%): the
icons are spreading fast, mostly among new plugins. GitHub entries were not
sampled. On the shelf's default order the first ten cards held one icon
(`@openviking/dsh-memory-plugin`). The shelf is still mostly the default
artwork, and §8 is designed for that page.

**Most icons are tiny, a few are not.** 286 of those icons were measured
(jsDelivr `HEAD`, 2026-10-23): median 321 bytes, p90 2.1 KiB, p99 181 KiB,
largest 210 KiB, none past dsh's 256 KiB. 259 are SVG (836 bytes on average);
22 PNG (61 KiB on average), 2 WebP and 2 JPEG are 9% of the icons and 86% of
the bytes (1.66 of 1.93 MB). Two declarations dsh would refuse: an `icon` that
is itself a `data:` URL, and a path ending `.icon`.

## 2. Decisions (LivXue, 2026-10-23)

1. **Where.** Every card on the shop's page shows its plugin's icon, installed
   or not. The Installed view (the same cards) and the rows of the Updatable
   and shadowed sections show it too.
2. **Which icon.** Only the one the author declared, through either source dsh
   reads (§3.1): package.json `icon`, or an `./icon` export. Never an image
   lifted from a README, a GitHub or npm avatar, or anything the build makes up.
3. **None, or an unusable one.** The card shows dsh's default plugin artwork,
   `PluginArtworkDefault` (§3.2). The same happens when an author's icon fails
   to decode in the browser.
4. **The look: option B.** A 32px tile at the front of the card's title row:
   0.5px border in `--dsw-alias-border-l3`, corner radius `--dsw-radius-md`, the
   artwork drawn at 24px with `object-fit: contain`. No backplate, in either
   theme, as on dsh's own page; the cost is stated in §8.4. Chosen from four
   options shot on dsh 0.2.1-rc.2 with shop 0.9.0 (§13).
5. **dsh's rules, not ours.** SVG, PNG, JPEG or WebP, chosen by extension; at
   most 256 KiB; drawn only as an image, never as inline markup (§3.1). An
   icon dsh would refuse is one the shop does not show.
6. **An icon never blocks a listing.** A bad declaration or file leaves the
   entry listed with the default artwork, and the build report says why, in
   words its author can act on (§10).
7. **When.** Icons travel with the daily catalog build: an author's new icon
   reaches the shop with the next build.
8. **Withholding by hand.** A maintainer can withhold one plugin's icon with a
   row in a review file, the way `denied.yml` withholds a listing (§9).

## 3. What dsh does

### 3.1 Reading an icon (0.1.7-rc.2, 0.2.0-rc.2, 0.2.1-rc.2)

`readPluginMeta` and `iconOf` in `dsh-app-boot` (`lib/types/package-meta.js`).
The versions differ, and the difference is large in practice (§1):

- **The manifest is found through the package's `exports`.** Every version
  resolves `<name>/package.json` with Node's resolver (`optionalResourcePath`),
  so a package whose `exports` map does not expose `./package.json` has no
  manifest as far as dsh is concerned, and its `icon` field is never read. A
  package with no `exports` field resolves it.
- **0.1.7-rc.2 and 0.2.0-rc.2** have `iconOf(value, manifestPath)`: the
  package.json `icon` and nothing else.
- **0.2.1-rc.2** adds a second source: when the manifest does not resolve, or
  carries no `icon`, an exported `<specifier>/icon` resource, resolved the same
  way without evaluating the package and required to lie inside the package
  that owns the specifier. A resolvable manifest's `icon` wins over the export.
- **A bad `icon` is an error, not a fall-through.** An `icon` that is present
  but not a non-empty string throws (`must be a non-empty string`); dsh then
  shows no icon at all, and never tries the export.
- On the 289 icons of §1, read by Node's documented resolution of the two
  subpaths with the default conditions: 0.1.7/0.2.0 would draw 207, 0.2.1
  would draw 288, neither would draw 1.
- **The `icon` path** must be relative: an absolute path, a Windows absolute
  path, or anything with a URL scheme (`/^[A-Za-z][A-Za-z\d+.-]*:/`) throws
  `icon must be a relative file path`. Resolved against the manifest's real
  directory, it must stay inside it (`icon must remain inside its manifest
  directory`).
- **The type comes from the extension**: `.svg` `image/svg+xml`, `.png`
  `image/png`, `.jpg`/`.jpeg` `image/jpeg`, `.webp` `image/webp`; anything else
  throws `icon must be SVG, PNG, JPEG, or WebP`. The bytes are not sniffed.
- **A regular file of at most `MAX_ICON_BYTES` = 256 × 1024 bytes**, checked on
  the stat and again on the bytes read.
- **The result is a base64 data URL**, which the inventory's schema describes
  as "render as an image, not inline markup".

0.1.5-rc.3 has neither `iconOf` nor `MAX_ICON_BYTES`: it reads no icon.

### 3.2 Drawing one (0.2.1-rc.2)

`dsh-client-ui-plugin-manager`'s `PackageArtwork` draws `<img src width height
alt="">` with `object-fit: contain`, and on `onError` falls back to the default
artwork: `PluginArtworkDefault` on cards (artwork 36px in a 48px tile,
`.cardIcon`: `border: .5px solid var(--dsw-alias-border-l3)`, `border-radius:
var(--dsw-radius-lg)`), `PluginArtworkSubagent` on list rows (30px in 40px,
`.rowIcon`, `--dsw-radius-md`). `PluginArtworkDefault` is a 36×36 SVG, one
path filled with a vertical gradient from `#54ECE7` to `#658EFF`; it is
exported by the primitives `dsh-web-frontend` bundles in 0.1.7-rc.2,
0.2.0-rc.2 and 0.2.1-rc.2, and absent from 0.1.5-rc.3. dsh is MIT-licensed
("Copyright (c) 2026 DeepSeek").

### 3.3 dsh's own market index (0.2.1-rc.2)

`dsh-plugin-market-index` ("plugin market index format 1") gives each plugin
an optional `icon`: either a base64 `data:` URL of SVG, PNG, JPEG or WebP of at
most `MAX_INLINE_ICON_BYTES` = 32 KiB decoded, or a URL that resolves to
`https:` or to the index's own origin. It is prior art only; publishing the
shop's catalog in that format is a separate question this design does not
take up.

## 4. Reading the declaration

The declaration is data the harvest already holds; reading it costs no
request.

- **npm.** `toCandidate` (`registry/scripts/src/npm-client.ts`) builds the
  candidate from `versions[dist-tags.latest]` of the packument it already
  read, and keeps no icon, `files` or `exports` field today. It gains the
  manifest's `icon` and `exports`.
- **GitHub.** `projectCandidate` (`registry/scripts/src/github-client.ts`)
  reads package.json at the default branch, before the commit is pinned
  (`fetchHeadCommit` runs after it), and `writeDeclarations` stamps what it
  keeps with `DECLARATIONS_RULE` (`registry/scripts/src/repo-state.ts`, 2
  today). The declaration joins what it keeps, and the rule goes to 3, so
  carried records re-read it under the existing re-read budgets
  (`DECLARATIONS_REREAD_BUDGET_DEFAULT`, `DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT`).
  A subpackage's declaration is read from its own package.json, and its
  path is relative to that directory.

One pure function turns a manifest into either a declaration (the source it
came from, a normalised POSIX path, a media type) or a refusal with its
detail (§10). It applies §3.1 in order: `icon` if it is a string; otherwise
`exports["./icon"]` when that is a string, or an object whose `import` or
`default` member is a string, in that order. That is a subset of Node's
resolution, and a deeper conditional object is refused with a detail that
names the supported forms; everything else in §3.1 (relative, no scheme, not
leaving the package, the four extensions) is checked here, before any byte is
fetched. A declaration that is absent is not a refusal: the entry simply has
no icon.

## 5. Fetching the bytes

### 5.1 The key, and reuse

Each icon is keyed by exactly what it was read from:

- npm: `npm:<name>@<version>:<path>`
- a git-installed GitHub entry: `github:<owner>/<slug>@<commit>:<path>`, the
  path including the subpackage directory
- a release-rescued GitHub entry: `release:<sha256 of the tarball>:<path>`

A key never changes meaning: the same version, commit or tarball always holds
the same bytes, so an outcome read once holds forever. Two stores keep it, and
neither is git history for third-party images (builder check, 2026-10-23: the
published file alone could not remember a key it never published):

- **`registry/icon-state.json`, committed with the daily snapshot** (it joins
  the snapshot step's `git add` list in `daily.yml`, which `workflow.test.ts`
  checks): one row per key with its outcome, either the sha256, media type and
  size of the bytes, or the refusal with its detail, or "not read" with its
  cause. No bytes. A refused or not-read key is never fetched again, and the
  report's rows (§10) are rebuilt from these rows, not from a fresh fetch. A
  row whose key no listing names any more is dropped.
- **The bytes are the published icons file's** (§6): at start the build reads
  the published `index.json` from the Pages URL, follows its `icons` pointer
  and checks the file's sha256. A key whose recorded sha256 is in it is reused
  without a request. One that is not (the first run, an outage, a deploy that
  failed after the snapshot commit) is fetched again from its recorded source,
  §5.2, under §5.3's budget, and must hash to the recorded sha256; one that no
  longer does is re-read as new.

Only keys no row knows are fetched for the first time.

### 5.2 Where the bytes come from

- **npm: the listed tarball itself.** `dist.tarball` (registry host only),
  read with `readCappedBody` at the existing `MAX_TARBALL_BYTES` (32 MiB),
  verified against the entry's `dist.integrity` before anything is inflated,
  inflated with `gunzipSync` and `maxOutputLength` at `MAX_INFLATED_BYTES`
  (64 MiB), unpacked with `readTar` (`packages/dsh-plugin-shop/src/shared/tar.ts`,
  which `release-asset.ts` already imports), and the member at
  `<root>/<path>` taken, `<root>` being the tarball's single top-level
  directory (`package/` for everything `npm pack` writes). Verifying the
  integrity is what makes the icon provably the listed artifact's: the catalog
  says "this version", and so does its icon. The build downloads no npm
  tarball today, so this is new traffic, bounded by §5.3 and paid once per
  version thanks to §5.1. A package past either cap is "not read" (§10), not
  refused: its author did nothing wrong.
- **A git-installed GitHub entry: the file at the pinned commit**,
  `raw.githubusercontent.com/<owner>/<slug>/<commit>/<path>`, through
  `fetchRobust` and `readCappedBody` at 256 KiB + 1. The declaration was read
  at the branch head (§4); if the path is missing at the commit, that is a
  refusal that names the commit, and the next commit is a new key.
- **A release-rescued entry: the release tarball the harvest already
  downloads** (`downloadReleaseAsset`, `openPackedManifest`), the member taken
  in the same pass that reads its manifest, so it costs no request. The
  harvest downloads that asset only when it reads the repository, so when the
  bytes are needed again (§5.1) the icon step downloads the recorded asset
  itself, through the same `downloadReleaseAsset` and its 300-second deadline,
  and checks it against the entry's `tarball.sha256`.
- **Only what the install would install.** pnpm installs a git dependency the
  way `npm pack` would pack it, so a GitHub package.json `files` list that
  leaves the icon out means dsh never sees it: refused, with a detail that
  names `files`. `.npmignore` is not read (a request per repository for a
  rare case); an icon it excludes will be published and draw where dsh would
  not.

Every new fetching path goes through `http-body.ts`, and its module joins
`SCANNED_SOURCES` in `github-client.test.ts` if it is not one already listed;
every inflate carries `maxOutputLength`, which the inflate guard checks across
the whole registry source.

### 5.3 Budgets and failures

A per-run budget bounds the new fetches, in the idiom of
`REPO_BACKFILL_BUDGET`: a count (`ICON_FETCH_BUDGET_DEFAULT`) and a wall-clock
budget, their values measured on the first full run and kept with their
arithmetic in the constant's comment, never restated elsewhere. A key past
the budget is "not yet read": the entry publishes without an icon this build
and is fetched on a later one. A transport failure is "not yet read" too,
never a refusal: a refusal is the author's to fix, and a timeout is not
(CLAUDE.md, the converse of `no-manifest`).

### 5.4 What a fetched icon must be

- At most 256 KiB, dsh's bound (§3.1).
- Its bytes agree with its extension: the PNG signature, a JPEG SOI marker, a
  RIFF/WEBP header, or for `.svg` UTF-8 text whose first element is `<svg`.
  dsh does not sniff; a PNG named `.svg` would only ever draw as a broken image
  there and the default here (§8.1), so refusing it costs nothing and tells
  the author why. The SVG check is a type check, not a sanitiser: the
  defence is §8.5's.

The checks are pure, and fixtures drive them.

## 6. The catalog format

### 6.1 A sidecar, like the stars

An entry's payload is capped at `ENTRY_PAYLOAD_MAX_BYTES` (12 KiB,
`gate.ts`), so the bytes cannot sit in the plugins file. They go in a new
content-addressed sidecar beside it, `icons.<sha256>.json`, shaped like the
stars sidecar's handling and published the same way:

```json
{
  "icons": { "<sha256 of the bytes>": "data:image/svg+xml;base64,…" },
  "sources": { "npm:dsh-inline-diff@1.10.0:icon.svg": "<sha256 of the bytes>" }
}
```

- `icons` holds each distinct icon once; `sources` is §5.1's reuse map. Keys
  sorted, the bytes deterministic for the same input, and no `builtAt`.
- Text, not image files, for two reasons. The host's transport seam carries
  text only: `OriginHandle.file()` returns a string, and the cache and its
  sha256 check read and write UTF-8 (`packages/dsh-plugin-shop/src/host/origin.ts`,
  `catalog.ts`). And a standalone SVG served from the Pages origin would be a
  document anyone could open, scripts and all; a JSON file never runs.
- The entry gains an optional `icon`: the sha256 that keys `icons`. It is
  the build's value, not the author's, and it does not count toward
  `ENTRY_PAYLOAD_MAX_BYTES`, so an icon can never push an entry past the
  budget and delist it.
- `index.json` gains an optional `icons: { url, sha256 }` beside `stars`.

### 6.2 Size

The npm transport downloads the whole `dsh-plugin-shop-catalog` package and
caps it at `MAX_PACKAGE_BYTES` (32 MiB compressed) and `MAX_INFLATED_BYTES`
(64 MiB inflated) in `npm-origin.ts`. On 2026-10-23 the published plugins file
was 17,889,435 bytes and the stars sidecar 615,785. 500 icons at the full
256 KiB would be 125 MiB and break both caps, so the icons file has a budget:
`ICONS_FILE_BUDGET_BYTES` = 16 MiB serialised, which keeps the package inside
both caps with the plugins file doubling. Past the budget, icons are kept
smallest first (ties by key) and the rest are reported as withheld for size
(§10). On the measured sizes, 16 sampled icons of 281 bytes to 3.1 KiB, the
budget holds thousands of icons and should never bind; the report prints the
file's size every build, so its growth is seen before it does.

### 6.3 Versions and transports

- Both additions are optional, so `CATALOG_SCHEMA_VERSION` stays 5, and the
  decision is recorded in `emit.ts`'s list of which new fields need a version
  gate. An older shop's non-strict parse strips the unknown keys and draws as
  it does today.
- The icons file joins `dataFileNames` in `pages-artifacts.ts`, so it reaches
  Pages and the npm package together, and its hash joins `catalogShas` in
  `npm-package.ts`, so an icons-only change still publishes to npm.
- The generated `registry/schema/plugin-entry.schema.json` is regenerated
  (`pnpm emit:schema`).

## 7. The shop's host

- **The pointer.** The host's `pointerSchema` (`catalog.ts`) gains the optional
  `icons`; the cached `index.json` is re-serialised after that parse, so an
  undeclared key would be stripped from the cache.
- **The file.** Fetched from the committed origin exactly like the stars: the
  same `file()` call, the same cache in `cacheDir` under its content-addressed
  name, sha256-checked on fetch and on every cached read. A mismatch, or a
  parse failure, degrades to no icons and is logged, as a stars mismatch
  degrades to `{}`: icons are presentation, and they never cost the reader the
  catalog.
- **The parse checks the grammar.** Every key a 64-hex sha256; every value a
  `data:` URL of exactly the four media types with base64 content, under the
  per-icon bound. Nothing else reaches an `img.src`.
- **The RPC.** `ShopCatalogResult` gains `icons: Record<string, string>`,
  sha256 to data URL, beside `stars`; `CatalogEntry` and its `entrySchema`
  gain the optional `icon`, or the parse strips it. Shipping the map rather
  than a URL per entry sends each distinct icon once.

This changes what the host reads, so the shop goes through `beta` first
(§12 and CLAUDE.md "Release channels"). The catalog side can land first: an
older shop ignores both new keys.

## 8. The page

### 8.1 One component, two kinds of artwork

Every place that draws an icon draws the same component: a 32px tile holding
a 24px `<img>`. Its source is the entry's icon from the icons file (§6) when
there is one, and the default artwork otherwise; an `onError` on an author's
icon swaps in the default, as dsh's `PackageArtwork` does.

The default artwork is the shop's own copy of `PluginArtworkDefault` (§3.2),
taken from dsh's MIT-licensed source with its attribution in a comment, and
drawn through the same `<img>` as a constant data URL. Two reasons, both
measured or read rather than guessed: 0.1.5-rc.3 has no such export to borrow
at run time; and an inline SVG carries a gradient addressed by id, so
thousands of inline copies would need an id each (dsh mints one per instance),
while an `<img>` is its own document and needs none.

### 8.2 Where

- **The card** (`EntryCard`): first child of the header button
  (`.entryHeader`), before `.name`. The Installed view uses the same cards.
- **The Updatable rows** (`OutdatedRow`): first child of `.outdatedInfo`,
  before `.name`.
- **The shadowed rows** (`ShadowedSection`): the same place.

A row's icon is its catalog entry's; a row whose entry is no longer in the
catalog draws the default.

### 8.3 Size and spacing

Tile 32×32 with `box-sizing: border-box`, the border and radius of §2.4,
artwork 24×24. The header row is `align-items: center`, so the name centres on
the tile. The mockup added 2px above the row (`padding-top: 10px` in place of
8px) so the tile does not crowd the card's top edge; the exact spacing is the
builder's, checked by screenshot at 1440, 1024 and 390px wide in both themes.

### 8.4 The dark theme, without a backplate

An image is its own document, so an SVG painted with `currentColor` resolves
it to black whatever the page's text colour: on the dark theme such an icon
nearly disappears (`@aiwayds/dsh-feishu` in the mockups), exactly as it does
on dsh's own Plugins page. An SVG that switches colours under
`@media (prefers-color-scheme: dark)` follows the page's theme
(`@openviking/dsh-memory-plugin` turned white). Option D in the mockups showed
the alternative, a light plate with `color-scheme: light` forced on the image
(measured: the plate's darkest pixel under openviking's mark went from 240 to
10), and LivXue chose B without it. The author-facing docs say how to make an
icon read on both themes (§11).

### 8.5 Untrusted bytes stay images

An author's icon reaches the DOM only as an `<img>`'s `src`, a `data:` URL
built from bytes the catalog carried. Never `innerHTML`, never an inline
`<svg>`, never `<object>`, `<embed>` or `<iframe>`: an image document runs no
script and loads nothing external, and that is the whole defence for an SVG.
A test pins it (§12).

### 8.6 Weight

The shelf skips off-screen cards already (`content-visibility: auto`); the
`<img>` decodes asynchronously; a data URL costs no request. Memory is bounded
by the icons file's budget (§6).

## 9. Withholding an icon by hand

A new review file, `registry/withheld-icons.yml`, empty, in the shape of
`denied.yml`: rows `{ name, reason }`, `name` an npm name or `owner/repo` (the
same `npmNameOrRepo` grammar), a repeated identity throws, as in every review
file. A withheld entry is published without an icon, so it draws the default,
and the report names it with its reason. It never touches the listing; that
stays `denied.yml`'s job.

## 10. The build report

A section for icons. One line of counts: declared, published, withheld by
hand (§9), withheld for size (§6.2), refused, not read (a package past §5.2's
caps), not yet read (§5.3), and the icons file's size. Then one row per
refused, withheld or not-read icon, with an author-readable detail in the
idiom of the rejection table: "icon ./assets/logo.gif is not
SVG, PNG, JPEG or WebP", "icon ./icon.png is 301 KiB; dsh shows at most
256 KiB", "icon ../shared/icon.svg leaves the package", "icon ./icon.svg is
not in the published package". These rows are not rejections: the entry is
listed, the new code space is the icon section's own, and none of it touches
the rejection codes the published report already carries.

## 11. For authors

`docs/schema.md` and `docs/schema.zh.md` gain an icon section: how to declare
one (the two sources of §3.1), the rules (dsh's), that `files` must include the
file when the package lists files, that the shop shows it after the next daily
build, and how to make it read on both themes: fixed colours, or a
`prefers-color-scheme` rule inside the SVG, never `currentColor` alone.

## 12. Testing and rollout

- **Pure core**: reading the declaration from an npm manifest and from a
  repository's package.json (both sources, a conditional `./icon` export,
  absent, malformed); the path rules (absolute, scheme, `..`, normalised
  forms); the type by extension, and the bytes agreeing with it; the size
  bound at 256 KiB exactly and one byte over; the icons file's bytes
  deterministic for the same input and free of `builtAt`; a withheld row
  removes the icon and is reported; a duplicate row throws.
- **Shell**: every download bounded by `http-body.ts` and every inflate
  bounded (the guard tests in `github-client.test.ts` already scan for both);
  a transport failure is "not yet read", never a refusal (the converse of
  `no-manifest`, CLAUDE.md "Failing loudly").
- **Host**: an index without an icons pointer yields no icons and no error; a
  hash mismatch is discarded and logged; both origins serve the file.
- **Page**: the tile draws an author's icon through `img.src` and nothing
  else (no `innerHTML`, no inline `svg` from catalog bytes); the default
  without an icon; the default after an `error` event; the rows draw it too;
  CSS pins the tile's 32px, the 24px artwork and the border token.
- **e2e**: a fixture plugin in the e2e's local registry declares an icon and
  its card's image hashes to the fixture's bytes; another declares none and
  draws the default.

Rollout, in two pull requests:

1. **The catalog** (§4 to §6, §9, §10): additive, so an older shop is
   untouched. Its PR runs the live harvest as the usual zero-write dry run;
   the first `main` run then fetches every icon once, under §5.3's budget, and
   the report shows how far it got.
2. **The shop** (§7, §8, §11's docs): `beta` first, then a hand check on a
   real profile, dsh 0.2.1-rc.2 for the icons and 0.1.5-rc.3 for the default
   artwork that harness cannot lend, before promoting. The README screenshots
   are reshot in the promotion commit, per CLAUDE.md.

The main design document's catalog-format section gains a pointer to this one
in the first pull request.

## 13. The mockups

Shot on 2026-10-23 on dsh 0.2.1-rc.2 with shop 0.9.0 from npm, light and
dark, by drawing the variants onto the live page with a throwaway script
(`.claude/worktrees/.scratch-shop-icons/mockup-shoot.ts`, never committed):
six real cards per variant (four with their authors' icons, two with the
default) and the top of the real shelf.

- **A**: a 48px tile left of the name, summary and actions; dsh's card geometry.
- **B** (chosen): a 32px tile at the front of the title row.
- **C**: a bare 20px glyph before the name.
- **D**: A with a light plate and `color-scheme: light` on the image.

## 14. Left to the builder

Module and component names; the header's exact spacing (§8.3); the report's
wording within §10's idiom; how the pipeline's new state is laid out on disk,
within §5's rules.
