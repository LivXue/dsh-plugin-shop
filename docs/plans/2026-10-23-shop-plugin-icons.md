# Plugin Icons on the Shop Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every card and row on the shop page shows the icon its plugin declares, read by dsh 0.2.1's rule and at most 32 KiB, or dsh's default artwork.

**Architecture:** The catalog build reads each listed package's icon declaration with dsh 0.2.1's rule (pure), fetches the bytes once per key from the listed artifact (impure), records every key's outcome in a committed `registry/icon-state.json`, and publishes the bytes as base64 data URLs in a content-addressed `icons.<sha256>.json` sidecar that `index.json` points at; each entry carries its icon's sha256. The shop's host fetches, verifies and grammar-checks that sidecar exactly as it does the stars sidecar and returns it beside `stars`; the page draws a 32px tile holding a 24px `<img>`.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), Node 26, vitest, zod (host), React with CSS modules (client), Playwright against a real dsh (e2e).

**Spec:** `docs/design/2026-10-23-shop-plugin-icons.md` (sections cited below as §n).

## Global Constraints

- Pure core, impure shell (CLAUDE.md): `icon-declaration.ts`, `icon-bytes.ts`, `icon-state.ts`, `icons-assemble.ts` and `icon-plan.ts` are pure: no clock, network, filesystem, environment or locale; every ordering through `compareStrings` (`identity.ts`). Only `icon-fetch.ts` and `build.ts` reach the network or the disk.
- Every body read goes through `readCappedBody` (`http-body.ts`); every `gunzipSync` carries `maxOutputLength`; `icon-fetch.ts` joins `SCANNED_SOURCES` in `registry/scripts/tests/github-client.test.ts`.
- `MAX_CATALOG_ICON_BYTES = 32 * 1024` (decision 9). Types by lowercased extension: `.svg` `image/svg+xml`, `.png` `image/png`, `.jpg` and `.jpeg` `image/jpeg`, `.webp` `image/webp`.
- `ICONS_FILE_BUDGET_BYTES = 16 * 1024 * 1024` (§6.2).
- An author's icon reaches the DOM only as an `<img>`'s `src` data URL (§8.5).
- `builtAt` never enters `icons.<sha>.json` or `icon-state.json`.
- `CATALOG_SCHEMA_VERSION` stays 5 (§6.3).
- A transport failure is "not yet read": never recorded, never a refusal. Refusals and "not read" are recorded per key (§5.1, §5.3).
- Published detail strings are exactly Task 2's table (§10; CLAUDE.md "Every rejection carries an author-readable detail").
- Byte counts in fixtures are computed in the test (`MAX_CATALOG_ICON_BYTES`, `MAX_CATALOG_ICON_BYTES + 1`), never typed as literals.
- Commits: author Dizhan Xue <xuedizhan17@mails.ucas.ac.cn>; the trailer `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` copied from an earlier commit's message (`git log -n 50 --format=%B | grep -m 1 '^Co-Authored-By: Claude Opus 5.5'`), never retyped. No push, PR, merge or release without LivXue's word; PRs are rebase-merged.
- Shop tests run against the private dsh prefixes only: `.claude/worktrees/.dsh0{15,17,20,21}-prefix/bin` first on PATH, with `DSH_SHOP_EXPECT_DSH` set to that leg's version and `DSH_SHOP_REQUIRE_E2E=1`; never the global dsh.
- Design documents English only; `docs/schema.md` and `docs/schema.zh.md` change together.
- No release is part of this plan: a beta needs LivXue's explicit version.

## Review Focus

1. **`exports` in the forms authors actually write**: `"./*"` patterns, condition objects whose first key is `types`, arrays, an explicit `"./package.json"`, and string or condition sugar at the top level. The shop must reach the same `./package.json` and `./icon` answers as dsh 0.2.1. Pinned by Task 1's fixtures and Task 17's cross-check against dsh's own page.
2. **SVG files with a UTF-8 BOM, an XML declaration, a DOCTYPE or comments before `<svg`** (one sampled icon has the DOCTYPE): they must pass the type check. Task 3.
3. **npm tarballs whose top-level directory is not `package/`, or whose members are prefixed `./package/`**: the icon is still found. Task 10.
4. **A corrupted or tampered icons sidecar**, fresh or cached: the catalog loads, with no icons and no error. Task 14.
5. **Upper-case extensions** (`Icon.SVG`): dsh lowercases them, so they are accepted with the right media type. Task 2.

## File Structure

Phase 1, the catalog (pull request 1):

| File | Responsibility |
|---|---|
| Create `registry/scripts/src/icon-declaration.ts` | `exports` resolution, `readIconDeclaration`, `fileListIncludes`, the detail copy. Pure. |
| Create `registry/scripts/src/icon-bytes.ts` | The 32 KiB bound, byte sniffing, data URL, sha256. Pure. |
| Create `registry/scripts/src/icon-state.ts` | Keys, outcome rows, parse, serialize, prune. Pure. |
| Create `registry/scripts/src/icons-assemble.ts` | The sidecar: assemble under the budget, serialize, parse. Pure. |
| Create `registry/scripts/src/icon-plan.ts` | Subjects from entries and candidates, the work plan, folding results, the report section. Pure. |
| Create `registry/scripts/src/icon-fetch.ts` | The published sidecar, npm tarballs, raw GitHub, release assets. Impure. |
| Create `registry/withheld-icons.yml`, `registry/icon-state.json` | The hand-written review file, empty; the committed outcome record, empty. |
| Modify `types.ts`, `npm-client.ts`, `github-client.ts`, `repo-state.ts`, `config.ts`, `pipeline.ts`, `emit.ts`, `pages-artifacts.ts`, `npm-package.ts`, `publish-catalog.ts`, `build.ts` (all under `registry/scripts/src/`) | Wiring. |
| Modify `.github/workflows/daily.yml` | Commit `icon-state.json` with the snapshot. |
| Modify `packages/dsh-plugin-shop/src/host/catalog.ts`, `.../host/types.ts` | Declare the entry's `icon` (the parity guard). |
| Modify `docs/design/2026-08-18-dsh-plugin-shop-design.md` | A pointer to the icons design in its catalog-format section. |

Phase 2, the shop (pull request 2):

| File | Responsibility |
|---|---|
| Modify `packages/dsh-plugin-shop/src/host/catalog.ts`, `.../host/index.ts` | The `icons` pointer, the sidecar's fetch, cache and grammar, the RPC field. |
| Create `packages/dsh-plugin-shop/src/client/default-artwork.ts` | The vendored default artwork as a data URL. |
| Create `packages/dsh-plugin-shop/src/client/PluginIcon.tsx` | The tile. |
| Modify `.../client/present.ts`, `.../client/ShopTab.tsx`, `.../client/ShopTab.module.css` | `iconOf`; the tile on cards and rows; the tile's CSS. |
| Modify `.../tests/fixtures/catalog-server.ts`; create `.../tests/fixtures/live-packages/dsh-shop-e2e-icon/` | The e2e's icons sidecar and its icon fixture. |
| Modify `docs/schema.md`, `docs/schema.zh.md` | Authors' icon section. |

---

## Phase 1: the catalog

### Task 1: Resolving an `exports` subpath as Node does

**Files:**
- Create: `registry/scripts/src/icon-declaration.ts`
- Test: `registry/scripts/tests/icon-declaration.test.ts`

**Interfaces:**
- Produces:
  - `export const EXPORT_CONDITIONS: ReadonlySet<string>`, holding `node`, `node-addons`, `import`, `module-sync` and `default`: what Node 26's ESM resolver matches by default.
  - `export interface ResolvedSubpath { path: string; via: 'exact' | 'pattern' }`. `path` is normalised POSIX with no leading `./`.
  - `export function resolveExportsSubpath(exportsField: unknown, subpath: './package.json' | './icon'): ResolvedSubpath | null`

- [ ] **Step 0: Set up the worktree once**

```bash
cd /Evermind/sh_evermind/xuedizhan/dsh-plugin-store/.claude/worktrees/shop-plugin-icons
CI=true pnpm install --frozen-lockfile
```
Expected: exits 0.

- [ ] **Step 1: Write the failing tests**

`describe('resolveExportsSubpath')`, one `it` per row; each asserts `toEqual` on the result shown.

| Case | `exports` | Subpath | Result |
|---|---|---|---|
| No field | `undefined` | `./package.json` | `{ path: 'package.json', via: 'exact' }` |
| No field | `undefined` | `./icon` | `null` |
| Root only | `{ '.': './index.js' }` | `./package.json` | `null` |
| Explicit | `{ '.': './index.js', './package.json': './package.json' }` | `./package.json` | `{ path: 'package.json', via: 'exact' }` |
| Pattern | `{ './*': './*' }` | `./package.json` | `{ path: 'package.json', via: 'pattern' }` |
| Pattern | `{ './*': './*' }` | `./icon` | `{ path: 'icon', via: 'pattern' }` |
| Exact beats pattern | `{ './*': './dist/*', './icon': './icon.svg' }` | `./icon` | `{ path: 'icon.svg', via: 'exact' }` |
| Longest prefix | `{ './*': './dist/*', './i*': './x/*.svg' }` | `./icon` | `{ path: 'x/con.svg', via: 'pattern' }` |
| Conditions | `{ './icon': { types: './i.d.ts', default: './icon.svg' } }` | `./icon` | `{ path: 'icon.svg', via: 'exact' }` |
| Key order | `{ './icon': { import: './a.svg', require: './b.svg' } }` | `./icon` | `{ path: 'a.svg', via: 'exact' }` |
| No match | `{ './icon': { require: './b.svg' } }` | `./icon` | `null` |
| Array | `{ './icon': ['./a.svg', './b.svg'] }` | `./icon` | `{ path: 'a.svg', via: 'exact' }` |
| Escape | `{ './icon': '../out.svg' }` | `./icon` | `null` |
| Not `./` | `{ './icon': 'icon.svg' }` | `./icon` | `null` |
| Climbs out | `{ './icon': './a/../../x.svg' }` | `./icon` | `null` |
| Null target | `{ './icon': null }` | `./icon` | `null` |
| String sugar | `'./index.js'` | `./package.json` | `null` |
| Condition sugar | `{ import: './index.js' }` | `./package.json` | `null` |

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/icon-declaration.test.ts`
Expected: FAIL, the module or its export is missing.

- [ ] **Step 3: Implement `resolveExportsSubpath`**

Follow Node's `PACKAGE_EXPORTS_RESOLVE`:
- **Sugar.** A string, an array, or an object with no key starting with `.` means `{ '.': value }`.
- **Matching a key.** An exact key wins. Otherwise take the keys holding exactly one `*` whose prefix and suffix bracket the subpath. Pick the longest prefix, then the longest key, and substitute the matched part into every `*` of the target.
- **Resolving a target.**
  - A string must start with `./`; normalise it with `posix.normalize`, and it must not begin with `..`, contain a `..` segment, or contain `node_modules`.
  - An array resolves to its first member that resolves.
  - An object is read in its own key order. The first key in `EXPORT_CONDITIONS` decides, and an `undefined` result moves on to the next key.
  - `null` excludes.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/icon-declaration.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icon-declaration.ts registry/scripts/tests/icon-declaration.test.ts
git commit -m "feat(registry): resolve an exports subpath the way Node does, for icons"
```

### Task 2: Reading a manifest's icon declaration (dsh 0.2.1's rule)

**Files:**
- Modify: `registry/scripts/src/icon-declaration.ts`
- Test: `registry/scripts/tests/icon-declaration.test.ts`

**Interfaces:**
- Consumes: `resolveExportsSubpath` (Task 1).
- Produces:

```ts
export type IconMediaType = 'image/svg+xml' | 'image/png' | 'image/jpeg' | 'image/webp'
export interface IconDeclaration { source: 'icon' | 'export'; path: string; mediaType: IconMediaType }
export type IconRead =
  | { kind: 'none' }
  | { kind: 'declared'; declaration: IconDeclaration }
  | { kind: 'refused'; detail: string }
export function readIconDeclaration(manifest: unknown): IconRead
export function fileListIncludes(files: unknown, path: string): boolean
export const iconDetail: { /* the functions in the table below */ }
export function shownPath(value: string): string // JSON.stringify of the value, cut to 79 characters plus '…' when longer than 80
```

**The detail copy.** These strings are exact; `label` is `package.json "icon"` for `source: 'icon'`, and `the "./icon" export` otherwise.

| Function | Text |
|---|---|
| `notString()` | `package.json "icon" must be a non-empty string; dsh shows no icon for this package.` |
| `notRelative(shown)` | `package.json "icon" ${shown} must be a relative file path inside the package; dsh shows no icon for this package.` |
| `leavesPackage(shown)` | `package.json "icon" ${shown} leaves the package directory; dsh shows no icon for this package.` |
| `badType(label, shown)` | `${label} ${shown} is not an SVG, PNG, JPEG or WebP file name; dsh chooses an icon's type by its extension.` |
| `fieldUnreachable()` | `package.json "icon" is never read: the package's "exports" does not expose "./package.json", so dsh cannot see the field. Add "./package.json": "./package.json" to "exports", or export "./icon".` |
| `notInFiles(label, shown)` | `${label} ${shown} is not in package.json "files", so a git install leaves it out and dsh never sees it.` |
| `notInPackage(label, shown, name, version)` | `${label} ${shown} is not in the published package ${name}@${version}.` |
| `notAtCommit(label, shown, repo, commit)` | `${label} ${shown} is not in ${repo} at commit ${commit.slice(0, 7)}.` |
| `notInRelease(label, shown)` | `${label} ${shown} is not in the release asset this entry installs.` |
| `tooLarge(label, shown, bytes)` | `${label} ${shown} is ${kib} KiB; the shop shows icons of at most 32 KiB.` where `kib = (Math.ceil(bytes / 102.4) / 10).toFixed(1)`; with `bytes` null, `${label} ${shown} is larger than 32 KiB; the shop shows icons of at most 32 KiB.` |
| `wrongBytes(label, shown, typeName)` | `${label} ${shown} does not hold ${typeName} data, although its extension says it does.` (`typeName`: `SVG`, `PNG`, `JPEG`, `WebP`) |
| `packageTooLarge(name, version)` | `the published package ${name}@${version} is larger than the 32 MiB the catalog build downloads, so its icon was not read.` |
| `packageUnpacksTooLarge(name, version)` | `the published package ${name}@${version} unpacks to more than the 64 MiB the catalog build reads, so its icon was not read.` |
| `releaseTooLarge()` | `the release asset is larger than the 32 MiB the catalog build downloads, so its icon was not read.` |
| `withheldByHand(reason)` | `withheld by registry/withheld-icons.yml: ${reason}` |
| `withheldForSize()` | `withheld: the icons file reached its 16 MiB budget, and the largest icons give way first.` |

- [ ] **Step 1: Write the failing tests**

`describe('readIconDeclaration')`:
- `{ icon: './assets/icon.svg' }` gives `{ kind: 'declared', declaration: { source: 'icon', path: 'assets/icon.svg', mediaType: 'image/svg+xml' } }`.
- `{ icon: 'Icon.SVG' }` declares `path: 'Icon.SVG'`, `mediaType: 'image/svg+xml'` (Review Focus 5).
- `{ icon: '' }` is refused with exactly `iconDetail.notString()`.
- `{ icon: 7 }` is refused with exactly `iconDetail.notString()`.
- `{ icon: 'data:image/svg+xml;base64,AAAA' }` is refused, and its detail starts with `package.json "icon" "data:image/svg+xml;base64,AAAA" must be a relative file path`.
- `{ icon: '/abs/icon.svg' }` and `{ icon: 'C:\\icon.svg' }` are each refused with `notRelative`.
- `{ icon: '../icon.svg' }` is refused with `leavesPackage`.
- `{ icon: './logo.icon' }` is refused with `badType('package.json "icon"', '"logo.icon"')`.
- `{ icon: './icon.svg', exports: { '.': './i.js' } }` is refused with exactly `iconDetail.fieldUnreachable()`.
- `{ icon: './old.svg', exports: { '.': './i.js', './icon': './new.svg' } }` declares `source: 'export'`, `path: 'new.svg'`: the field is unreachable, and the export wins.
- `{ icon: './a.svg', exports: { '.': './i.js', './package.json': './package.json', './icon': './b.svg' } }` declares `source: 'icon'`, `path: 'a.svg'`.
- `{ icon: '', exports: { './package.json': './package.json', './icon': './b.svg' } }` is refused with `notString()`: a bad field does not fall through.
- `{ exports: { './*': './*' } }` is `{ kind: 'none' }`: the pattern gives `icon`, which has no extension.
- `{ exports: { './icon': './icon' } }` is refused with `badType('the "./icon" export', '"icon"')`.
- `{}` and `null` are `{ kind: 'none' }`.
- `shownPath` of 120 `a`s is a quoted string of 80 characters ending in `…`.

`describe('fileListIncludes')`:

| `files` | Path | Result |
|---|---|---|
| `undefined` | `icon.svg` | true |
| `['assets']` | `assets/icon.svg` | true |
| `['assets/']` | `assets/icon.svg` | true |
| `['*.svg']` | `icon.svg` | true |
| `['*.svg']` | `assets/icon.svg` | false |
| `['**/*.svg']` | `assets/icon.svg` | true |
| `['dist', '!dist/icon.svg']` | `dist/icon.svg` | false |
| `['lib']` | `icon.svg` | false |
| `'lib'` (not an array) | `icon.svg` | true |

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/icon-declaration.test.ts`
Expected: FAIL on the new describes.

- [ ] **Step 3: Implement**

Follow §4's four steps.
- `notRelative` matches dsh's test: a POSIX absolute path, `win32.isAbsolute`, or `/^[A-Za-z][A-Za-z\d+.-]*:/`.
- Normalise with `posix.normalize` after stripping a leading `./`. A result that is `..` or starts with `../` is `leavesPackage`.
- The extension comes from `posix.extname(path).toLowerCase()`.
- `fileListIncludes`:
  - Entries are read in order. A `!` entry excludes.
  - An entry matches a path that equals it, or that lies under it as a directory (trailing `/` optional).
  - Otherwise it matches as a glob: `*` within one segment, `**` across segments.
  - Anything other than an array of strings restricts nothing.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/icon-declaration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icon-declaration.ts registry/scripts/tests/icon-declaration.test.ts
git commit -m "feat(registry): read an icon declaration by dsh 0.2.1's rule"
```

### Task 3: What a fetched icon's bytes must be

**Files:**
- Create: `registry/scripts/src/icon-bytes.ts`
- Test: `registry/scripts/tests/icon-bytes.test.ts`

**Interfaces:**
- Consumes: `IconDeclaration`, `IconMediaType`, `iconDetail`, `shownPath` (Task 2).
- Produces:

```ts
export const MAX_CATALOG_ICON_BYTES = 32 * 1024
export function sniffIconBytes(bytes: Uint8Array, mediaType: IconMediaType): boolean
export function checkIconBytes(bytes: Uint8Array, declaration: IconDeclaration): { ok: true } | { ok: false; detail: string }
export function iconDataUrl(bytes: Uint8Array, mediaType: IconMediaType): string // `data:${mediaType};base64,${base64}`
export function sha256Hex(bytes: Uint8Array): string
```

- [ ] **Step 1: Write the failing tests**
- **Sniffing.**
  - The PNG signature `89 50 4E 47 0D 0A 1A 0A` plus padding passes for `image/png` and fails for `image/svg+xml`.
  - `FF D8 FF E0` passes for JPEG.
  - `RIFF` + 4 bytes + `WEBP` passes for WebP.
  - Each of these SVG texts passes: `\uFEFF<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<!-- c --><svg xmlns="http://www.w3.org/2000/svg"/>`, and `<svg>`, and `<svg\n viewBox="0 0 1 1">`.
  - These fail: `<html>`, `<svgx>`, `<SVG>`, and bytes that are not valid UTF-8 (`0xC3 0x28`).
- **Checking.**
  - An SVG body exactly `MAX_CATALOG_ICON_BYTES` long (padded with a comment) is `{ ok: true }`.
  - One byte longer is refused, with detail ending `is 32.1 KiB; the shop shows icons of at most 32 KiB.`
  - PNG bytes declared as `icon.svg` are refused with `wrongBytes('package.json "icon"', '"icon.svg"', 'SVG')`.
- **Encoding.** `iconDataUrl(new TextEncoder().encode('<svg/>'), 'image/svg+xml')` equals `data:image/svg+xml;base64,PHN2Zy8+`. `sha256Hex` of empty bytes equals `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/icon-bytes.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**
- SVG decodes with `new TextDecoder('utf-8', { fatal: true })`.
- Before matching `<svg` followed by whitespace, `/` or `>`, skip any number of each of these, in any order: a BOM, whitespace, `<?…?>`, `<!--…-->` and `<!DOCTYPE …>`.
- Check the size first, then the sniff.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/icon-bytes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icon-bytes.ts registry/scripts/tests/icon-bytes.test.ts
git commit -m "feat(registry): an icon is at most 32 KiB and holds what its extension says"
```

### Task 4: Candidates carry their declarations

**Files:**
- Modify: `registry/scripts/src/types.ts` (`Candidate`, `RepoCandidate`)
- Modify: `registry/scripts/src/npm-client.ts` (`toCandidate`, line ~2176)
- Modify: `registry/scripts/src/github-client.ts` (`writeDeclarations`, line ~1171)
- Modify: `registry/scripts/src/repo-state.ts` (`DECLARATIONS_RULE` and its comment)
- Test: `registry/scripts/tests/npm-client.test.ts`, `github-client.test.ts`, `repo-state.test.ts`

**Interfaces:**
- Consumes: `readIconDeclaration`, `fileListIncludes`, `iconDetail`, `shownPath` (Task 2).
- Produces:
  - `Candidate.icon?: IconRead`, present only when it is not `none`.
  - `Candidate.distTarball?: string`, present only when the icon is `declared` and `dist.tarball` is a string.
  - `RepoCandidate.icon?: IconRead`, present only when it is not `none`.
  - `DECLARATIONS_RULE = 3`.

- [ ] **Step 1: Write the failing tests**
- **npm-client.test.ts.**
  - `toCandidate` of a packument whose latest version has `icon: './icon.svg'` and `dist.tarball: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz'` gains `icon: { kind: 'declared', declaration: { source: 'icon', path: 'icon.svg', mediaType: 'image/svg+xml' } }` and that `distTarball`.
  - One with no icon has neither key (`expect('icon' in c).toBe(false)`, likewise `distTarball`).
- **github-client.test.ts.** Through the existing harvest fixtures whose package.json drives `projectCandidate`:
  - A manifest with `icon: './icon.svg'` yields `candidate.icon` declared.
  - The same manifest with `files: ['dist']` yields `{ kind: 'refused', detail: iconDetail.notInFiles('package.json "icon"', '"icon.svg"') }`.
  - A manifest without one has no `icon` key.
  - The re-read path (`rereadCandidate` against a stubbed manifest at the commit) writes the same `icon`.
- **repo-state.test.ts.** Any assertion written against rule 2 moves to `DECLARATIONS_RULE`. A carried candidate stamped 2 is selected for re-read.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts registry/scripts/tests/repo-state.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**
- `toCandidate` widens its manifest type with `icon?: unknown`, `exports?: unknown` and `dist.tarball?: unknown`, calls `readIconDeclaration(manifest)`, and spreads the two optional keys.
- `writeDeclarations` widens `declarations` with `icon`, `exports` and `files`. A declared icon that `fileListIncludes(files, path)` rejects becomes the `notInFiles` refusal. It sets `candidate.icon`, or deletes it when the read is `none`.
- `DECLARATIONS_RULE` becomes 3. Its comment's field list gains `icon`, plus a dated line: `3 (2026-10-23): icon as well (design 2026-10-23-shop-plugin-icons §4); every listable carried candidate stamped 2 is re-read once to gain it, and until it is, it carries none.`

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts registry/scripts/tests/repo-state.test.ts && pnpm typecheck`
Expected: PASS; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/npm-client.ts registry/scripts/src/github-client.ts registry/scripts/src/repo-state.ts registry/scripts/tests/npm-client.test.ts registry/scripts/tests/github-client.test.ts registry/scripts/tests/repo-state.test.ts
git commit -m "feat(registry): candidates carry their icon declarations; declarations rule 3"
```

### Task 5: The outcome record

**Files:**
- Create: `registry/scripts/src/icon-state.ts`, `registry/icon-state.json` (contents `{}` and a newline)
- Test: `registry/scripts/tests/icon-state.test.ts`

**Interfaces:**
- Consumes: `IconMediaType` (Task 2).
- Produces:

```ts
export type IconKey = string
export function npmIconKey(name: string, version: string, path: string): IconKey     // `npm:${name}@${version}:${path}`
export function githubIconKey(repo: string, commit: string, path: string): IconKey   // `github:${repo}@${commit}:${path}`, path including subdir
export function releaseIconKey(tarballSha256: string, path: string): IconKey         // `release:${sha256}:${path}`
export type IconOutcome =
  | { outcome: 'published'; sha256: string; mediaType: IconMediaType; bytes: number }
  | { outcome: 'refused'; detail: string }
  | { outcome: 'not-read'; detail: string }
export function parseIconState(text: string): Map<IconKey, IconOutcome>
export function serializeIconState(state: ReadonlyMap<IconKey, IconOutcome>): string
export function pruneIconState(state: ReadonlyMap<IconKey, IconOutcome>, live: ReadonlySet<IconKey>): Map<IconKey, IconOutcome>
```

- [ ] **Step 1: Write the failing tests**
- A three-row map serialises and parses back `toEqual` the same.
- Two maps with the same rows inserted in different orders serialise to identical bytes, keys sorted by `compareStrings`.
- An empty map serialises to `{}\n`.
- Each of these throws, with an error message containing the row's key:
  - a `published` row with sha `abc`;
  - an outcome `maybe`;
  - an extra field;
  - a `bytes` of -1.
- Text that is not JSON also throws.
- `pruneIconState` keeps exactly the live keys.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/icon-state.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**

The text is `JSON.stringify(sortedObject, null, 2) + '\n'`. Parsing throws on any malformed row, because a malformed registry file throws (CLAUDE.md "Failing loudly").

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/icon-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icon-state.ts registry/icon-state.json registry/scripts/tests/icon-state.test.ts
git commit -m "feat(registry): a committed record of every icon key's outcome"
```

### Task 6: The icons sidecar

**Files:**
- Create: `registry/scripts/src/icons-assemble.ts`
- Test: `registry/scripts/tests/icons-assemble.test.ts`

**Interfaces:**
- Consumes: `IconKey` (Task 5).
- Produces:

```ts
export const ICONS_FILE_BUDGET_BYTES = 16 * 1024 * 1024
export interface PublishedIcon { key: IconKey; sha256: string; dataUrl: string }
export interface IconsFile { icons: Record<string, string>; sources: Record<IconKey, string> }
export function assembleIcons(icons: readonly PublishedIcon[], budget?: number): { file: IconsFile; withheldForSize: IconKey[] }
export function serializeIcons(file: IconsFile): { fileName: string; json: string; sha256: string } // fileName `icons.${sha256}.json`
export function parseIconsFile(text: string): IconsFile | null
```

- [ ] **Step 1: Write the failing tests**
- **Determinism.** The same icons in two input orders serialise to the same bytes and the same `fileName`. The JSON contains no `builtAt`.
- **Deduplication.** Two keys with identical bytes (the same sha) give one `icons` entry and two `sources`.
- **Budget.** With a budget that holds exactly the two smallest of three icons, the largest key is in `withheldForSize`, and its sha is in neither map. Equal sizes are decided by `compareStrings` on the sha.
- **Parsing.**
  - The serialised JSON parses back `toEqual` the file.
  - Each of these parses to `null`:
    - text that is not JSON;
    - a missing `sources`;
    - an icon key that is not 64-hex;
    - a value `javascript:alert(1)`;
    - a `data:text/html;base64,…`;
    - a `sources` value naming a sha absent from `icons`.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/icons-assemble.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**
- Admit shas in ascending order of data-URL length (ties by `compareStrings` on the sha), while the running sum of data-URL lengths stays at most `budget - 1024 * 1024`. That MiB is the allowance for the keys, the `sources` and the JSON syntax.
- `serializeStars` (`stars-assemble.ts`) sets the formatting and the hashing.
- A data URL is valid when it matches `/^data:image\/(svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/`.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/icons-assemble.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icons-assemble.ts registry/scripts/tests/icons-assemble.test.ts
git commit -m "feat(registry): a content-addressed icons sidecar under a 16 MiB budget"
```

### Task 7: Planning the work and folding the results

**Files:**
- Create: `registry/scripts/src/icon-plan.ts`
- Test: `registry/scripts/tests/icon-plan.test.ts`

**Interfaces:**
- Consumes:
  - Tasks 2, 3, 5 and 6.
  - `installIdentity` (`identity.ts`).
  - `Entry`, `Candidate`, `RepoCandidate` (`types.ts`).
- Produces:

```ts
export type IconFetchTarget =
  | { kind: 'npm'; name: string; version: string; tarball: string; integrity: string; path: string }
  | { kind: 'github'; repo: string; commit: string; path: string }                    // path includes subdir
  | { kind: 'release'; repo: string; url: string; sha256: string; path: string }      // path inside the asset's package root
export interface IconSubject {
  identity: string; name: string; withheldKey: string; read: IconRead
  key?: IconKey; target?: IconFetchTarget
}
export interface IconWork { key: IconKey; target: IconFetchTarget; declaration: IconDeclaration; expectSha256?: string }
export interface IconPlan { reuse: { key: IconKey; sha256: string }[]; fetch: IconWork[]; deferred: IconKey[] }
export type IconFetchResult =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'refused'; detail: string }
  | { kind: 'not-read'; detail: string }
  | { kind: 'not-yet-read'; reason: string }
export interface IconReportRow { name: string; identity: string; kind: 'refused' | 'not-read' | 'withheld'; detail: string }
export interface IconCounts { declared: number; published: number; withheldByHand: number; withheldForSize: number; refused: number; notRead: number; notYetRead: number }
export interface IconFold {
  nextState: Map<IconKey, IconOutcome>; file: IconsFile | null
  byIdentity: Map<string, string>; rows: IconReportRow[]; counts: IconCounts
}
export function iconSubjects(entries: readonly Entry[], candidates: readonly Candidate[], repoCandidates: readonly RepoCandidate[]): IconSubject[]
export function planIconWork(subjects: readonly IconSubject[], state: ReadonlyMap<IconKey, IconOutcome>, published: IconsFile | null, withheld: ReadonlyMap<string, { reason: string }>, budget: number): IconPlan
export function foldIconResults(subjects: readonly IconSubject[], plan: IconPlan, results: ReadonlyMap<IconKey, IconFetchResult>, state: ReadonlyMap<IconKey, IconOutcome>, published: IconsFile | null, withheld: ReadonlyMap<string, { reason: string }>, budget?: number): IconFold
```

**Rules** (§5.1, §5.3, §9):
- **Building subjects.**
  - Each subject matches an entry to its candidate by `installIdentity`.
  - `withheldKey` is the npm name, or the repository full name lowercased.
  - An npm target needs both `distTarball` and `integrity`.
  - A GitHub entry with `tarball` is a `release` target keyed by `releaseIconKey(tarball.sha256, path)`. Otherwise it is a `github` target keyed by `githubIconKey(repo, version, subdirPath)`; `Entry.version` is the commit for GitHub entries.
- **Planning.**
  - No work for: `none` and `refused` reads, withheld subjects, and keys recorded `refused` or `not-read`.
  - A key recorded `published` whose sha is in `published.icons` is reused. One whose sha is missing is fetched with `expectSha256`.
  - A key the record does not know is fetched.
  - Fetches are de-duplicated by key, sorted by `compareStrings`, and cut at `budget`; the rest go to `deferred`.
- **Folding.**
  - **Bytes.** Bytes pass `checkIconBytes` and are recorded `published`. A sha that differs from `expectSha256` is recorded as the new sha.
  - **Failed bytes.** A failed check is recorded `refused` with the check's detail.
  - **Refused, not read.** These results are recorded as they are.
  - **Not yet read.** A `not-yet-read` result, a deferred key, and a key with no result all change nothing, and count as not yet read.
  - **Assembly.** Reused and fetched icons go to `assembleIcons`. Keys it withholds for size become `withheld` rows with `iconDetail.withheldForSize()`.
  - **The identity map.** `byIdentity` maps the identity of each declared, non-withheld subject whose sha is in the final file.
  - **Report rows.** Rows come from:
    - subjects' `refused` reads;
    - recorded or fetched `refused` and `not-read` outcomes;
    - withheld subjects, with `iconDetail.withheldByHand(reason)`;
    - size-withheld keys.

    They are sorted by name, then identity, then detail.
  - **Pruning.** `nextState` is pruned to the keys of declared subjects.

- [ ] **Step 1: Write the failing tests**
- **Subjects.** An npm entry with a declared candidate yields `key: 'npm:x@1.0.0:icon.svg'` and an npm target. A GitHub entry with `subdir: 'packages/a'` yields `key: 'github:o/r@<sha>:packages/a/icon.svg'`. A release-rescued entry yields a `release` target.
- **Planning.**
  - A recorded `refused` key is not fetched.
  - A recorded `published` key whose sha is in `published.icons` is reused.
  - The same key with `published` null is fetched with `expectSha256`.
  - A withheld subject is not fetched.
  - With `budget` 2 and three unknown keys, the third in `compareStrings` order is deferred.
- **Folding.**
  - Valid SVG bytes become a `published` row, a `byIdentity` entry and an icon in `file.icons`.
  - Oversize bytes become a `refused` row with the `tooLarge` detail.
  - `not-yet-read` leaves the state unchanged and counts `notYetRead: 1`.
  - A withheld subject yields one `withheld` row and no `byIdentity` entry.
  - A refused read yields a row and no state row.
  - The state is pruned to live keys.
  - `counts` add up: `declared === published + withheldByHand + withheldForSize + refused + notRead + notYetRead`.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/icon-plan.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement** the rules above.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/icon-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icon-plan.ts registry/scripts/tests/icon-plan.test.ts
git commit -m "feat(registry): plan icon work from the record and fold its results"
```

### Task 8: The report's icon section

**Files:**
- Modify: `registry/scripts/src/icon-plan.ts`
- Test: `registry/scripts/tests/icon-plan.test.ts`

**Interfaces:**
- Consumes: `IconFold` (Task 7), `escapeCell` (`emit.ts`).
- Produces: `export function renderIconSection(fold: Pick<IconFold, 'rows' | 'counts'>, fileBytes: number | null): string`

- [ ] **Step 1: Write the failing test**

For counts `{ declared: 3, published: 1, withheldByHand: 0, withheldForSize: 0, refused: 1, notRead: 0, notYetRead: 1 }`, one refused row (`name: 'x|y'`), and `fileBytes` 1234, the output is exactly:

```
## Icons

Declared 3: published 1, withheld by hand 0, withheld for size 0, refused 1, not read 0, not yet read 1. Icons file: 1234 bytes.

| Plugin | Icon |
|---|---|
| x\|y | <the escaped detail> |
```

With `fileBytes` null, the line ends `Icons file: none.` With no rows, there is no table.

- [ ] **Step 2: Run, and see it fail**

Run: `pnpm vitest run registry/scripts/tests/icon-plan.test.ts`
Expected: FAIL on the new case.

- [ ] **Step 3: Implement**

Plain digits only: no `toLocaleString`.

- [ ] **Step 4: Run, and see it pass**

Run: `pnpm vitest run registry/scripts/tests/icon-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icon-plan.ts registry/scripts/tests/icon-plan.test.ts
git commit -m "feat(registry): the build report's icon section"
```

### Task 9: Withholding an icon by hand

**Files:**
- Create: `registry/withheld-icons.yml`
- Modify: `registry/scripts/src/config.ts`
- Test: `registry/scripts/tests/config.test.ts`

**Interfaces:**
- Produces:
  - `RegistryConfig.withheldIcons: Map<string, { reason: string }>`, keyed by npm name, or by repository full name lowercased.
  - `parseRegistryConfig`'s input gains `withheldIcons: string`.

- [ ] **Step 1: Write the failing tests**
- A row `{ name: 'x', reason: 'r' }` gives `withheldIcons.get('x')` equal to `{ reason: 'r' }`.
- `{ name: 'Owner/Repo', reason: 'r' }` is keyed `owner/repo`.
- A repeated name throws, and the message contains `withheld-icons.yml`.
- An empty reason throws.
- `[]` gives an empty map.
- A row with an unknown field throws.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/config.test.ts`
Expected: FAIL, and the typecheck flags the missing input.

- [ ] **Step 3: Implement**
- The schema is `z.array(z.object({ name: npmNameOrRepo, reason: z.string().min(1) }).strict())`, filled through `setUnique` as `denied.yml` is.
- `loadRegistryConfig` reads `withheld-icons.yml`.
- The file is a comment header, saying what a row does and that it never touches the listing, then `[]`.
- Every fixture that builds a `RegistryConfig` by hand gains `withheldIcons: new Map()`.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/config.test.ts && pnpm typecheck`
Expected: PASS; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add registry/withheld-icons.yml registry/scripts/src/config.ts registry/scripts/tests/config.test.ts
git commit -m "feat(registry): withheld-icons.yml withholds one plugin's icon by hand"
```

### Task 10: Fetching the bytes

**Files:**
- Create: `registry/scripts/src/icon-fetch.ts`
- Modify: `registry/scripts/src/github-client.ts`, to export `downloadReleaseAsset`, `recordedReleaseUrl`, `fetchRobust`, `RAW_GITHUB` and `MAX_TARBALL_BYTES`
- Test: `registry/scripts/tests/icon-fetch.test.ts`; `github-client.test.ts` (`SCANNED_SOURCES`)

**Interfaces:**
- Consumes:
  - Tasks 3, 6 and 7.
  - `readTar` (`packages/dsh-plugin-shop/src/shared/tar.ts`).
  - `readCappedBody` (`http-body.ts`).
- Produces:

```ts
export const PUBLISHED_CATALOG_URL = 'https://LivXue.github.io/dsh-plugin-shop/v1/'
export const ICON_FETCH_BUDGET_DEFAULT = 1500
export const ICON_FETCH_TIME_BUDGET_MS_DEFAULT = 15 * 60 * 1000
export const ICON_FETCH_CONCURRENCY = 8
export interface IconTransport {
  fetchImpl: typeof fetch; sleep: (ms: number) => Promise<void>; token: string
  timeoutMs: number; tarballTimeoutMs: number
  caps?: { tarballBytes: number; inflatedBytes: number }   // tests only; defaults MAX_TARBALL_BYTES, 64 MiB
}
export async function readPublishedIcons(fetchImpl: typeof fetch, baseUrl?: string): Promise<IconsFile | null>
export async function fetchIcon(work: IconWork, transport: IconTransport): Promise<IconFetchResult>
export async function harvestIcons(plan: IconPlan, transport: IconTransport, options: { concurrency: number; deadlineMs: number }): Promise<Map<IconKey, IconFetchResult>>
```

**Behaviour:**
- **`readPublishedIcons`.**
  - Reads `index.json` capped at 64 KiB, follows its `icons` pointer, and reads the file capped at 24 MiB.
  - The sha must match, and `parseIconsFile` must accept the text.
  - Any failure returns `null`; it never throws.
- **npm.**
  - A `dist.tarball` whose host is not `registry.npmjs.org` is `not-yet-read`.
  - **Reading the body.** A 404, a 429, a 5xx and a throw are all `not-yet-read`. A body over the cap is `not-read`, with `packageTooLarge`.
  - **Integrity.** It is verified as SRI: the algorithm before the first `-` (`sha512`, `sha384`, `sha256` or `sha1`), hashed with `node:crypto`, compared in base64. A mismatch, or an algorithm outside those four, is `not-yet-read`.
  - **Unpacking.** `gunzipSync(bytes, { maxOutputLength })`; an `ERR_BUFFER_TOO_LARGE` is `not-read`, with `packageUnpacksTooLarge`.
  - **The icon member.** After `readTar`, the root is the single first path segment shared by every member, with any leading `./` stripped. A missing `<root>/<path>` is `refused`, with `notInPackage`.
- **GitHub raw.**
  - The URL is `${RAW_GITHUB}/${repo}/${commit}/${path}`, through `fetchRobust`.
  - A 404 is `refused`, with `notAtCommit`. A 429 or 5xx is `not-yet-read`.
  - The body is read with `readCappedBody(response, MAX_CATALOG_ICON_BYTES + 1)`. Over that is `refused`, with `tooLarge(label, shown, null)`.
- **Release.**
  - The URL must pass `recordedReleaseUrl`, or the result is `not-yet-read`.
  - The download goes through `downloadReleaseAsset`. Over the cap is `not-read`, with `releaseTooLarge`. A missing asset or a sha mismatch is `not-yet-read`.
  - The asset is unpacked like an npm tarball. A missing member is `refused`, with `notInRelease`.
- **`harvestIcons`.** Runs `plan.fetch` with `concurrency` workers, and starts no new fetch after `deadlineMs`, measured with `performance.now()` from the call. Unstarted keys get no result.

- [ ] **Step 1: Write the failing tests**

Stubbed `fetchImpl`, and tarballs from `registry/scripts/tests/packed-tarball.ts`:
- A tarball with root `package/` yields the icon's bytes.
- So does one with root `pkg/`, and one whose members are prefixed `./package/` (Review Focus 3).
- An integrity mismatch is `not-yet-read`.
- With `caps.tarballBytes` 100, a 101-byte body is `not-read` with exactly `iconDetail.packageTooLarge('x', '1.0.0')`.
- With `caps.inflatedBytes` 10, unpacking is `not-read` with `packageUnpacksTooLarge`.
- A missing member is `refused` with `notInPackage`.
- Raw: 404 is `refused` with `notAtCommit`. 40 KiB is `refused` with the "larger than 32 KiB" text. 503 is `not-yet-read`.
- `readPublishedIcons`:
  - An index without `icons` gives `null`.
  - A sha mismatch gives `null`.
  - A valid pair gives the parsed file.
- `harvestIcons` with `deadlineMs: 0` starts nothing.
- In `github-client.test.ts`, `SCANNED_SOURCES` lists `icon-fetch.ts`, and the body-read and inflate guards pass.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/icon-fetch.test.ts registry/scripts/tests/github-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the behaviour above, with the constants' comment carrying their arithmetic once.
- `ICON_FETCH_BUDGET_DEFAULT`: the 2026-10-23 sample (§1) holds 289 declarations per quarter of the npm lines. That is about 1,160 npm keys for the first run, plus GitHub's unknown share, hence 1,500.
- The time budget: 15 minutes of a daily run that takes about 105 of its 180 allowed minutes.
- Re-measure both after the first `main` run, and replace the comment's figures with the measured ones.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm vitest run registry/scripts/tests/icon-fetch.test.ts registry/scripts/tests/github-client.test.ts && pnpm typecheck`
Expected: PASS; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src/icon-fetch.ts registry/scripts/src/github-client.ts registry/scripts/tests/icon-fetch.test.ts registry/scripts/tests/github-client.test.ts
git commit -m "feat(registry): fetch an icon from the listed tarball, commit or release asset"
```

### Task 11: Entries, the index pointer and both transports

**Files:**
- Modify: `registry/scripts/src/types.ts` (`Entry.icon?: string`), `pipeline.ts` (`runPipeline`), `emit.ts`, `pages-artifacts.ts`, `npm-package.ts`, `publish-catalog.ts`
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (`entrySchema`), `packages/dsh-plugin-shop/src/host/types.ts` (`CatalogEntry.icon?: string`)
- Test: `pipeline.test.ts`, `emit.test.ts`, `pages-artifacts.test.ts`, `npm-package.test.ts`, `catalog-parity.test.ts` (in `registry/scripts/tests/`)

**Interfaces:**
- Produces:
  - `export interface IconsPointer { url: string; sha256: string }` in `emit.ts`.
  - `emit(…, notes, icons: IconsPointer | null = null)`.
  - `runPipeline(…, schemaVersion, icons: { pointer: IconsPointer; byIdentity: ReadonlyMap<string, string> } | null = null)`.
  - `PagesPointer.icons?: IconsPointer`.
  - `LocalCatalog.shas.icons?` and `PublishedCatalog.shas.icons?`.

- [ ] **Step 1: Write the failing tests**
- **pipeline.test.ts.** With `icons` given, the entry whose identity is in `byIdentity` carries `icon: <sha>`, and `index.json` carries `"icons": { "url", "sha256" }` after `stars`. With `icons` null, neither appears. The determinism test's inputs gain an icons pointer, and the outputs stay byte-stable across input orders.
- **emit.test.ts.** An entry with `icon: 'xyz'` throws in `assertCatalogInvariants`, with a message naming the entry. With a 64-hex icon, it does not.
- **pages-artifacts.test.ts.** `pagesArtifactNames` and `npmArtifactNames` both include the icons file when the pointer has one.
- **npm-package.test.ts.** `catalogPublishDecision` skips only when the plugins, stars and icons shas all match; a changed icons sha publishes. `package.json`'s `catalogShas` gains `icons`.
- **catalog-parity.test.ts.** It passes, because the consumer now declares `icon`.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm vitest run registry/scripts/tests/pipeline.test.ts registry/scripts/tests/emit.test.ts registry/scripts/tests/pages-artifacts.test.ts registry/scripts/tests/npm-package.test.ts registry/scripts/tests/catalog-parity.test.ts`
Expected: FAIL. The parity test fails once `Entry.icon` exists and before the consumer declares it.

- [ ] **Step 3: Implement**
- **Entries.** `runPipeline` sets `icon` on entries after `selectEntries`, so the payload budget (gate time) never counts it (§6.1).
- **emit.ts.**
  - The additive-field comment's list gains `icon`.
  - `assertCatalogInvariants` checks `/^[0-9a-f]{64}$/`.
- **The consumer.** It gains `icon: z.string().regex(/^[0-9a-f]{64}$/).optional()`. `CatalogEntry.icon?: string` gets a doc comment: the sha256 keying the catalog's icons sidecar.

- [ ] **Step 4: Run, and see them pass**

Run: the same command, then `pnpm typecheck && pnpm -C packages/dsh-plugin-shop typecheck`
Expected: PASS; both typechecks exit 0.

- [ ] **Step 5: Commit**

```bash
git add registry/scripts/src packages/dsh-plugin-shop/src/host registry/scripts/tests
git commit -m "feat(registry): entries carry their icon's sha256 and the index points at the icons sidecar"
```

### Task 12: Wiring the build, the snapshot commit and the docs

**Files:**
- Modify: `registry/scripts/src/build.ts`, `.github/workflows/daily.yml` (the snapshot `git add`, line ~512)
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (a pointer); `docs/design/2026-10-23-shop-plugin-icons.md` (Status)
- Test: `registry/scripts/tests/workflow.test.ts` (must pass unchanged), the full root suite

**Interfaces:**
- Consumes: Tasks 5 to 11.

- [ ] **Step 1: Wire it**

In `build.ts`, after `selectEntries` and the stars step:
1. Read `registry/icon-state.json` with `parseIconState`. A missing file is an empty map; a malformed one throws.
2. `iconSubjects(selectedEntries, candidates, repoCandidates)`, then `await readPublishedIcons(fetch)`.
3. `planIconWork(…, config.withheldIcons, budget)`. The budget comes from `ICON_FETCH_BUDGET`, else the default; the time limit from `ICON_FETCH_TIME_BUDGET_MS`, else the default.
4. `await harvestIcons(…)`, then `foldIconResults(…)`.
5. When `fold.file` holds any icon, `serializeIcons(fold.file)` writes `OUT_DIR/<fileName>`, and the pointer and `byIdentity` go to `runPipeline`.
6. Write `serializeIconState(fold.nextState)` to `registry/icon-state.json`.
7. Append `renderIconSection(fold, fileBytes)` to `report.md`.

Then:
- In `daily.yml`, append `registry/icon-state.json` to the snapshot step's `git add`.
- Add a pointer paragraph to the main design's catalog-format section.

- [ ] **Step 2: Verify**

Run: `pnpm test && pnpm typecheck`
Expected: every test passes, `workflow.test.ts` included (it checks every registry write is committed), and the typecheck exits 0.

`pnpm build:catalog` is not run locally: per CLAUDE.md, the PR's own zero-write dry run exercises the fetching and writing end to end. Task 13 reads that run's report.

- [ ] **Step 3: Commit**

```bash
git add registry/scripts/src/build.ts .github/workflows/daily.yml docs/design
git commit -m "feat(registry): the daily build publishes the icons sidecar and commits the outcome record"
```

### Task 13: Pull request 1

- [ ] **Step 1:** Curate the history. The three design commits squash into one `docs(design): plugin icons on the shop page`, and this plan joins it as `docs(plans): ...`. Then one commit per task. Compare trees before and after.
- [ ] **Step 2:** Run `pnpm test && pnpm typecheck && pnpm -C packages/dsh-plugin-shop test` with the 0.2.1-rc.2 leg's environment (Global Constraints). Expected: all green; the shop's suite is untouched apart from a type.
- [ ] **Step 3:** Ask LivXue to open the PR, and push only on their word. The body is ASCII only. Once it is open:
  - Read the PR's dry run, both its report's `## Icons` section and the CI log.
  - Check reviews and inline comments before reporting ready.
  - Merge only on 合并, rebase-merged with `--match-head-commit`.

---

## Phase 2: the shop

Branch from Phase 1's merged `main`.

### Task 14: The host fetches, verifies and returns the icons

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (`pointerSchema`, `CatalogSnapshot`, both load paths), `packages/dsh-plugin-shop/src/host/index.ts` (`ShopCatalogResult`, the `catalog` RPC)
- Test: `packages/dsh-plugin-shop/tests/host/catalog.test.ts`; `transport-parity.test.ts` if it lists the data files

**Interfaces:**
- Produces:
  - `CatalogSnapshot.icons: Record<string, string>`
  - `ShopCatalogResult.icons: Record<string, string>`, mapping sha256 to data URL
  - module-private `parseIconsText(text: string): Record<string, string>`

- [ ] **Step 1: Write the failing tests**

Through `loadCatalog`, with the existing fixtures:
- **A valid sidecar.** A pointer with `icons` whose file holds one valid pair gives `snapshot.icons` with that pair.
- **Bad pairs are dropped one by one**, the rest kept:
  - a key `abc`;
  - a value `javascript:alert(1)`;
  - a `data:text/html;base64,` value;
  - a base64 longer than 43,692 characters, that is, decoded past 32 KiB.
- **Degrading to no icons.** Each of these gives `{}` and the catalog still loads (Review Focus 4):
  - a fetched sha mismatch;
  - a cached file tampered after the cache was written;
  - text that is not JSON.
- **Older catalogs.** A pointer without `icons` gives `{}`.
- **The npm transport.** The npm origin serves the icons file like the stars file.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/catalog.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
- Mirror the stars sidecar on both paths: `cachePath(cacheDir, url, 'icons')`, the same `withCommitBudget` and the same advisory `catch`.
- The grammar: key `/^[0-9a-f]{64}$/`; value `/^data:image\/(svg\+xml|png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/` with at most 43,692 base64 characters.
- The output is an `Object.create(null)` map.
- The RPC returns `snapshot.icons`.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host && pnpm -C packages/dsh-plugin-shop typecheck`
Expected: PASS; the typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host packages/dsh-plugin-shop/tests/host
git commit -m "feat(shop): the host fetches, verifies and returns the catalog's icons"
```

### Task 15: The tile, the default artwork, `iconOf`

**Files:**
- Create: `packages/dsh-plugin-shop/src/client/default-artwork.ts`, `packages/dsh-plugin-shop/src/client/PluginIcon.tsx`
- Modify: `packages/dsh-plugin-shop/src/client/present.ts`, `packages/dsh-plugin-shop/src/client/ShopTab.module.css`
- Test: `tests/client/present.test.ts`, `tests/client/PluginIcon.client.spec.tsx` (new), `tests/client/css-tokens.client.spec.ts`

**Interfaces:**
- Produces:

```ts
// default-artwork.ts
export const DEFAULT_ARTWORK_DATA_URL: string
// present.ts
export function iconOf(entry: CatalogEntry, icons: Readonly<Record<string, string>>): string | undefined
// PluginIcon.tsx
export function PluginIcon({ src }: { src: string | undefined }): ReactNode
```

- [ ] **Step 1: Write the failing tests**
- **present.test.ts.**
  - `iconOf({ ...entry, icon: S }, { [S]: url })` is `url`.
  - It is `undefined` for an entry without `icon`, and for `icon: 'constructor'` against `{}`: own properties only.
- **PluginIcon.client.spec.tsx.**
  - With `src`, it renders `span[data-shop-icon="author"][aria-hidden="true"]` whose only child is an `IMG` with that `src`, `width` 24, `height` 24, `alt=""` and `decoding="async"` (§8.6).
  - Firing `error` on the image re-renders with `data-shop-icon="default"` and `src === DEFAULT_ARTWORK_DATA_URL`.
  - `src` undefined renders the default.
  - No `svg` element exists under the span (§8.5).
- **css-tokens.client.spec.ts.**
  - `.iconTile` declares `width: 32px`, `height: 32px`, `border: 0.5px solid var(--dsw-alias-border-l3)`, `border-radius: var(--dsw-radius-md)` and `box-sizing: border-box`.
  - `.iconImage` declares `width: 24px`, `height: 24px` and `object-fit: contain`.
- **The default artwork.** `DEFAULT_ARTWORK_DATA_URL` starts with `data:image/svg+xml;base64,`, and its decoded text contains `viewBox="0 0 36 36"`, `#54ECE7` and `#658EFF`.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/present.test.ts tests/client/PluginIcon.client.spec.tsx tests/client/css-tokens.client.spec.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`default-artwork.ts` holds the base64 of the SVG printed by this command, which reads dsh 0.2.1-rc.2's own bundle, so that no character is hand-copied:

```bash
node -e "
const s = require('fs').readFileSync(process.argv[1], 'utf8');
const local = /PluginArtworkDefault:([A-Za-z0-9_\$]+)/.exec(s.slice(s.indexOf('PluginArtworkDefault:')))[1];
const body = s.slice(s.indexOf(local + '=({size:'), s.indexOf(local + '=({size:') + 4000);
const d = /\{d:\"([^\"]+)\"/.exec(body)[1];
const g = /x1:\"([^\"]+)\",y1:\"([^\"]+)\",x2:\"([^\"]+)\",y2:\"([^\"]+)\"/.exec(body);
const stops = [...body.matchAll(/stopColor:\"(#[0-9A-Fa-f]{6})\"/g)].map(m => m[1]);
console.log('<svg width=\"36\" height=\"36\" viewBox=\"0 0 36 36\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"' + d + '\" fill=\"url(#a)\"/><defs><linearGradient id=\"a\" x1=\"' + g[1] + '\" y1=\"' + g[2] + '\" x2=\"' + g[3] + '\" y2=\"' + g[4] + '\" gradientUnits=\"userSpaceOnUse\"><stop stop-color=\"' + stops[0] + '\"/><stop offset=\"1\" stop-color=\"' + stops[1] + '\"/></linearGradient></defs></svg>');
" ../.dsh021-prefix/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-CN7NIWNw.js
```

The SVG text sits in a comment above the constant, with the attribution: `PluginArtworkDefault from @deepseek-ai/dsh-web-frontend 0.2.1-rc.2, MIT License, Copyright (c) 2026 DeepSeek`.

- [ ] **Step 4: Run, and see them pass**

Run: the same command as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client packages/dsh-plugin-shop/tests/client
git commit -m "feat(shop): a 32px icon tile with dsh's default artwork behind it"
```

### Task 16: The tile on cards and rows

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx`, covering `EntryCard` (line ~153), its call (line ~2558), `OutdatedSection` and `OutdatedRow` (lines ~1386 and ~1328), and `ShadowedSection` (line ~1455)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.module.css` (header spacing)
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `PluginIcon`, `iconOf` (Task 15); `ShopCatalogResult.icons` (Task 14).
- Produces:
  - `EntryCard`'s prop `icon: string | undefined`.
  - `OutdatedSection`'s and `ShadowedSection`'s prop `iconFor: (key: string) => string | undefined`, keyed by `identityKey`.

- [ ] **Step 1: Write the failing tests**
- **A card with an icon.** In a catalog whose entry `e` has `icon: S`, and whose result has `icons: { [S]: url }`, the header button's first element child is `[data-shop-icon="author"]` with `img.src` equal to `url`.
- **A card without one** draws `[data-shop-icon="default"]`.
- **A result with no `icons` key** (an older host during self-update) draws defaults and does not throw.
- **An Updatable row** shows the tile before the name.
- **A shadowed row** whose identity has no catalog entry draws the default.
- **Accessibility.** The header button's accessible name is unchanged: it still begins with the plugin name, and the tile is `aria-hidden`.

- [ ] **Step 2: Run, and see them fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/ShopTab.client.spec.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**
- `icons` is a `useMemo` over `catalogState`, reading `result.icons ?? {}`.
- `EntryCard` renders `<PluginIcon src={icon} />` first inside `.entryHeader`.
- The rows render it first in `.outdatedInfo`.
- The header's top padding is the builder's (§8.3). The mockup used 10px; check it by screenshot at 1440, 1024 and 390 wide, in both themes.

- [ ] **Step 4: Run, and see them pass**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client`
Expected: PASS. The known load races in `executor`/`index` (memory) are not in this set.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/client packages/dsh-plugin-shop/tests/client
git commit -m "feat(shop): cards and rows draw their plugin's icon"
```

### Task 17: The e2e, against dsh's own page

**Files:**
- Create: `packages/dsh-plugin-shop/tests/fixtures/live-packages/dsh-shop-e2e-icon/`, holding `package.json`, `index.js`, `cordis.patch.yml`, `icon.svg` and `wrong.svg`
- Modify: `packages/dsh-plugin-shop/tests/fixtures/live-packages/dsh-shop-e2e-live/` (gains `"icon": "./icon.svg"` and `icon.svg`)
- Modify: `packages/dsh-plugin-shop/tests/fixtures/catalog-server.ts`, `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts`

**Interfaces:**
- Consumes: the registry's `readIconDeclaration`, `checkIconBytes`, `iconDataUrl`, `sha256Hex`, `assembleIcons` and `serializeIcons`, imported from `registry/scripts/src` (the reverse of `release-asset.ts`'s import from this package).

**The fixtures.** `dsh-shop-e2e-icon`'s manifest:
- `"exports": { ".": "./index.js", "./icon": "./icon.svg" }`, which hides `./package.json`;
- `"icon": "./wrong.svg"`, unreachable by dsh 0.2.1's rule;
- a bundle patch like `dsh-shop-e2e-live`'s.

`icon.svg` and `wrong.svg` are distinct, small, fixed-colour SVGs.

**The catalog server.** It lists the new fixture, and builds the icons sidecar by running the registry's functions over each fixture's manifest and files, so the e2e checks the registry's own answer.

- [ ] **Step 1: Write the failing cases**

Both go before the final hot-swap case, which must stay last.
- `draws an author's icon on its card and the default where none is declared`:
  - The `dsh-shop-e2e-live` card's tile image decodes to bytes whose sha256 equals `icon.svg`'s.
  - A fixture card without an icon has `[data-shop-icon="default"]`.
- `draws the icon dsh draws on its own Plugins page`, on 0.2.1 and later only, skipped with a stated reason below that:
  - Install `dsh-shop-e2e-icon` from its card.
  - Open dsh's sidebar Plugins page and hash every image with `crypto.subtle.digest` (memory: the Plugins page draws package icons).
  - Those hashes include the shop card's icon hash, and do not include `wrong.svg`'s.

- [ ] **Step 2: Run on 0.2.1, and see them fail**

Run (0.2.1-rc.2 leg): `pnpm -C packages/dsh-plugin-shop test` with `PATH=$PWD/../.dsh021-prefix/bin:$PATH DSH_SHOP_EXPECT_DSH=0.2.1-rc.2 DSH_SHOP_REQUIRE_E2E=1`
Expected: the two new cases FAIL, and nothing else.

- [ ] **Step 3: Implement** the fixtures and the catalog server's sidecar.

- [ ] **Step 4: Run every leg**

Run the package suite on 0.1.5-rc.3, 0.1.7-rc.2, 0.2.0-rc.2 and 0.2.1-rc.2, each with its own prefix and `DSH_SHOP_EXPECT_DSH`.
Expected:
- All green on every leg.
- The Plugins-page case runs on 0.2.1, and is skipped below it with its reason.
- Per leg, report the e2e line's duration, not the skip total.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/tests
git commit -m "test(shop): the e2e checks the card's icon against dsh's own Plugins page"
```

### Task 18: Authors' docs

**Files:**
- Modify: `docs/schema.md`, `docs/schema.zh.md`; `docs/design/2026-10-23-shop-plugin-icons.md` (Status)

- [ ] **Step 1:** Add the icon section of §11 to both files.
  - The two sources, and the `exports` caveat.
  - The rules, and the 32 KiB limit.
  - The `files` list.
  - That the icon appears with the next daily build.
  - How to make an icon read on both themes.
  - The Chinese text says the same facts in its own register.
- [ ] **Step 2:** Run `pnpm vitest run registry/scripts/tests/doc-pairs.test.ts`. Expected: PASS.
- [ ] **Step 3:** Commit: `docs: how a plugin declares an icon the shop shows`.

### Task 19: Pull request 2

- [ ] **Step 1:** Run the full package suite on all four legs, the root suite, and both typechecks. Expected: all green.
- [ ] **Step 2:** Curate the commits.
- [ ] **Step 3:** Ask LivXue to open the PR. Its body is ASCII only and states that the release goes through `beta`. Merge only on 合并.
- [ ] **Step 4:** No release. Ask LivXue for the beta version separately. The README screenshots are reshot in the later promotion commit, not here (CLAUDE.md).
