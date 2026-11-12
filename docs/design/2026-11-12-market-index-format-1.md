# A second artifact: the catalog in dsh's own market-index format

**Date:** 2026-11-12
**Status:** proposed
**Amends:** nothing yet

The shop publishes a catalog that its own page reads. The harness now defines
a format for exactly that kind of catalog — and a reader for it. Publishing
the same data in that format would make every listed plugin reachable from
dsh's own **Discover** page and from the `plugin_market` agent tool, with no
shop installed.

This document answers three questions and leaves the fourth to a human: does
our catalog fit the format, what does it not fit yet, what would it buy, and
what should be spent to get it.

---

## 1. The format is the harness's, not a competitor's

`@deepseek-ai/dsh-plugin-market-index` ships inside dsh. Its own module header
says the format "is defined by the plugin market index format Agent Note;
readers and generators share this validator" — and it exports `parseMarketIndex`,
so a third-party catalog can be checked against the same rules the harness
reads it with.

`@deepseek-ai/dsh-plugin-market` is the other half: its own type comment calls
it the "Host reader of configured plugin market indexes for the Discover page
and the `plugin_market` tool." It offers `search`, `entry` and
`readEntryDetail`.

What that reader gives a listed plugin, measured from the installed
0.2.2-rc.1 packages:

| | |
|---|---|
| text search | fuzzy over **name, author, keywords, and every language** of title, description, category title and label title; every word matches as a prefix or within edit distance 2 |
| filters | one `category` id, and every one of a list of `label` ids |
| order | any **declared sort key**, with an initial direction |
| page | `limit` 1–100 (`MAX_LIMIT`) |
| fetch | one document per source URL, `fetchTimeoutMs` default **15 s** |
| icon | a `data:` URL or an absolute URL; **inline payload ≤ 32 KiB decoded** |
| name | a valid npm package name, ≤ 214 characters |
| version | an **exact SemVer** per listed version, descending |
| source | `npm` (with an optional registry) or `git` (an https URL plus a **lowercase 40-hex commit**, and an optional package directory) |
| timestamp | `publishTimestamp`, integer Unix seconds below 10^11 |

The git variant's package directory is the same concept as our `subdir`, and
the `search` text already spans both languages. Two of the format's parts are
things the shop has and no other public index uses: see §5.

## 2. The measurement

The published catalog — `schemaVersion` 5, **27,111** listed entries, the
build stamped `builtAt 2026-11-12T09:37:02.761Z` — was mapped onto format 1
and then handed to the harness's own `parseMarketIndex`, resolved against an
index URL.

Result, for the version of the mapping this document describes:

```
VALIDATOR: accepted
  plugins kept: 17,983
```

Nothing below is an estimate: every count in §3 is a property of that catalog,
recomputed by that mapping on the day this document was written.

## 3. What does not fit, and why

### 3.1 A github entry's manifest version is kept only beside a declaration — 7,900

This is the one that decides whether the artifact can be published at all,
and it is not a gap in the data.

`github-client.ts` records `candidate.manifestVersion` only when the manifest
also declares `dshPeers` or `engines.dsh`:

```ts
if ((dshPeers !== undefined || engines !== undefined) && usableVersion) {
  ...
  candidate.manifestVersion = version
} else {
  delete candidate.dshPeers
  delete candidate.engines
  delete candidate.manifestVersion
}
```

That pairing is correct for what the field was added for — naming the
`name@version` in the exemption command dsh asks a refused plugin to run. It
is wrong for format 1, where every version needs an exact SemVer and a git
source carries the commit instead: **7,900 listed github entries carry no
version at all**, because their manifests declare neither peers nor engines.

Two consequences worth stating plainly:

- `Entry.manifestVersion`'s own comment says it is "present exactly when its
  `Entry.dshPeers` is". Relaxing the recording rule means relaxing that
  sentence, `repo-state.ts`'s parse rule that refuses the two recorded apart,
  and the tier/emit path that carries them together.
- The read has to happen again. `DECLARATIONS_RULE` goes to 6, and every
  carried repository is re-read once — the same mechanism rule 2 used when
  the field was introduced (2026-10-10).

For scale: among the 21,777 candidates already stamped with the current rule,
**10,897 carry no `manifestVersion`**, so the absence is the rule rather than
a half-finished backfill.

### 3.2 The same name is listed twice — 768

The catalog lists a bundle from npm and, separately, from its own repository.
Format 1 requires names unique within an index. The rule is already ours: npm
wins over its own owner's repository (`2026-10-19-npm-shadow-by-owner.md`),
and the validator rejects a repeat outright, so the mapping applies it first:
18,751 expressible entries become the 17,983 that validate.

### 3.3 A git source pinned to a tag rather than a commit — 450

The release-rescued entries store the release tag (`v0.2.1`) in `version` and
carry a prebuilt `tarball`. Format 1's git source takes a commit and nothing
else. Resolving the tag to its commit at harvest would let them in; until
that, they stay on the shelf and out of the index.

### 3.4 Repository URLs that are not http(s) — 39

`ssh://git@…`, `git@…` and `github://` forms. Both `homepage` and
`repository` are optional, so these entries keep their place and lose the
link. They are not a reason to hold anything back.

### 3.5 Names the npm grammar refuses — 8

All github-sourced, all shaped like a scoped package with an upper-case owner
(`@Badegg404/dsh-api-balance`). Format 1's `name` is an identifier, not the
git install spec, but it still has to be a valid npm name. These stay on the
shelf.

### 3.6 Versions that are not SemVer — 2

`0.8.7.1` and one other four-part version. Two entries, excluded until their
manifests are fixed.

## 4. Size: raw, on the wire, and by shape

Measured on the same document with `zlib` — gzip at level 9, brotli at
quality 11:

| shape | raw | gzip | brotli |
|---|---|---|---|
| full, every icon inlined | 18.76 MiB | 6.92 MiB | 5.25 MiB |
| full, no icons | 10.14 MiB | **2.39 MiB** | **1.61 MiB** |
| no icons, `homepage` dropped where it only repeats `repository.url`, empty `keywords`/`labels` omitted | 8.88 MiB | **2.28 MiB** | **1.53 MiB** |
| name, description and category only | 6.61 MiB | 1.87 MiB | 1.27 MiB |
| the format's own minimum, no description | 3.86 MiB | 0.49 MiB | 0.39 MiB |

All five validate. **The cost that matters is the compressed column.** GitHub
Pages and jsDelivr serve with `Content-Encoding`, and the reader's `fetch`
asks for gzip and brotli and decompresses transparently, so a reader pays one
and a half to two and a half MiB for the no-icons shapes, not ten.

The size question is almost entirely the icons: inlining them adds **4.5 MiB
of gzip**, more than every other field in the document combined. Our 6,317
published icons are already `data:` URLs in a content-addressed sidecar and
**none exceeds the 32 KiB inline limit**, so inlining is legal — it is just
the most expensive thing the format lets us write.

Trimming is real but small once compressed. Dropping the `homepage` that only
repeats `repository.url`, and omitting empty `keywords` and `labels` instead
of writing `[]`, saves 1.26 MiB raw and 0.11 MiB of gzip: a repeated URL
compresses to almost nothing. Both are worth doing because they cost nothing,
and neither should be counted on for the budget.

Format 1 is one document per source URL with no sharding, so the whole index
arrives in one request inside the reader's 15-second budget. A first cut
publishes the no-icons shape and revisits per-file icons referenced by
absolute URL, which keeps the document near 9 MiB raw and still gives the
Discover page its artwork.

### 4.1 It is one more file in the artifact that already exists

The catalog is already published as its own artifact, on two transports, and
this change does not add a third:

| | |
|---|---|
| GitHub Pages | `https://LivXue.github.io/dsh-plugin-shop/v1/` — `index.json` plus the sidecars it names, and the browser-only `badge.json` and `report.md` |
| npm | `dsh-plugin-shop-catalog`, the same machine-readable files under `v1/` (11.9 MiB, the `2026.1112.0` tarball) |

Both lists are derived from the pointer: `dataFileNames` in
`pages-artifacts.ts` reads the emitted `index.json`, `pagesArtifactNames` adds
the browser-only files to it, and `npmArtifactNames` takes the same list
unchanged. A data file the pointer names reaches both transports; one it does
not name reaches neither. The format-1 document is a sixth entry in that list.

**It cannot be a content-addressed sidecar like the other three.** The reader
takes one URL, fetches one document and validates it; it does not follow a
pointer. A `market.<sha>.json` name would change every build, and a reader's
configured source cannot follow a name that changes — so the file sits at a
stable name that each build overwrites, exactly as `index.json` already does.

That is safe on the reader's side: a fetched document is reused for
`cacheTtlMs`, which defaults to **ten minutes**, and the catalog is rebuilt
daily. The cost is on the npm transport: its tarball is gzipped, so the
no-icons index adds **2.3 to 2.4 MiB** (§4) to today's 11.9 MiB package.
Whether it ships on both transports or Pages only is §8's fourth decision;
the repository's standing rule is both.

## 5. What the format gives us that the shelf does not

- **A second surface for the same catalog.** Discover and the agent tool read
  the index without the shop being installed. Nothing about the shop's own
  page changes.
- **Chinese search, already paid for.** Text matching covers every language of
  a description, and our summaries already carry `en` and `zh`.
- **Our three shelf orders become declared sort keys.** Stars, newest listing
  and latest update are exactly three `sortKeys` ids with `order: 'desc'`.
  The one public format-1 index we found declares **no sort keys at all**
  (`metadata.sortKeys: {}`), so this is unclaimed ground.
- **The long description and its images are the harness's job.** The reader's
  `readEntryDetail` asks for the package's locale `meta.detail`, then the
  package README, then the repository README, and returns an image document.
  A screenshot carousel that a competing market built by hand arrives here
  for listed plugins by construction.
- **Our github channel is the deep end of the format.** That same public
  index lists **0 git-sourced plugins** out of 5,437; ours would be 5,478 of
  17,983. The `git` source variant, and its `path` for a monorepo package, is
  exercised here far beyond anywhere else.

## 6. What this does not do

- **It does not change the shop page.** Same shelf, same interactions, same
  catalog file the client reads today. This is an additional artifact.
- **It does not make the shop an installer.** The format's `source` already
  matches what our entries carry: `name@version` for npm, and a pinned commit
  plus package directory for git. The host builds the install spec.
- **It does not publish anything the catalog refuses.** The index is built
  from the same published entries, after the same gate.
- **It does not put our URL in front of a reader.** Today a source is added by
  hand — Discover's index sources. Whether dsh ships a default is the
  harness's decision, not ours.
- **It does not decide the version question.** §3.1 is a recording-rule
  change with a full re-read attached; that is a human's call, not a
  byproduct of writing this file.

## 7. What a first cut would publish

Without §3.1, today's data already yields **17,983 plugins in 10.1 MiB** with
no icons, accepted by the harness's own validator. That is a working,
honest artifact that leaves out 7,900 github entries rather than inventing a
version for them — the same posture this repository takes everywhere else:
an absent fact costs the fact and never the listing.

Adding §3.1 lifts the ceiling to **24,832** — 17,983 + 6,849. It is 6,849 and
not 7,900 because 1,051 of those entries are held out by something else as
well (a tag instead of a commit, a name the npm grammar refuses, or a name an
npm entry already owns).

## 8. Decisions for a human

1. **Spend the re-read?** §3.1 costs one full re-read of every carried
   repository under `DECLARATIONS_RULE` 6. It is the difference between 66%
   of the catalog (17,983 of 27,111) and 92% of it (24,832).
2. **Icons now or later?** 2.39 MiB of gzip without them, 6.92 MiB with.
   Per-file icons are a third option that needs the sidecar split.
3. **Tag-resolved entries?** §3.3 is 450 entries and one extra fact at
   harvest time.
4. **Both transports or Pages only?** §4.1 adds 2.3 to 2.4 MiB to the
   `dsh-plugin-shop-catalog` package. The repository's standing rule is that a
   data file reaches both or neither; exempting this one is a deliberate
   exception, not a default.

## 9. What changes once this is accepted

- A spec amendment to `2026-08-18-dsh-plugin-shop-design.md` for the sixth
  file in `v1/`, its stable name, and the pointer entry that carries it to
  both transports (§4.1).
- A plan entry in `2026-08-18-remaining-work.md`.
- If §3.1 is taken: the `github-client.ts` pairing, `repo-state.ts`'s parse
  rule, the tier/emit path, and `DECLARATIONS_RULE` 6, with the tests that
  pin the pairing (`pipeline.test.ts` asserts exactly which entries carry it)
  amended in the same change.

