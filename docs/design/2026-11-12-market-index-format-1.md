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

The published catalog — `schemaVersion` 5, **26,351** listed entries, read
2026-11-12 from the same `v1/` artifacts the shop reads — was mapped onto
format 1 and then handed to the harness's own `parseMarketIndex`, resolved
against an index URL.

Result, for the version of the mapping this document describes:

```
VALIDATOR: accepted
  plugins kept: 17,389
```

Nothing below is an estimate: every count in §3 is a property of that catalog,
recomputed by that mapping on the day this document was written.

## 3. What does not fit, and why

### 3.1 A github entry's manifest version is kept only beside a declaration — 7,769

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
source carries the commit instead: **7,769 listed github entries carry no
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

### 3.2 The same name is listed twice — 741

The catalog lists a bundle from npm and, separately, from its own repository.
Format 1 requires names unique within an index. The rule is already ours: npm
wins over its own owner's repository (`2026-10-19-npm-shadow-by-owner.md`),
and the validator rejects a repeat outright, so the mapping applies it first:
18,130 expressible entries become the 17,389 that validate.

### 3.3 A git source pinned to a tag rather than a commit — 443

The release-rescued entries store the release tag (`v0.2.1`) in `version` and
carry a prebuilt `tarball`. Format 1's git source takes a commit and nothing
else. Resolving the tag to its commit at harvest would let them in; until
that, they stay on the shelf and out of the index.

### 3.4 Repository URLs that are not http(s) — 37

`ssh://git@…`, `git@…` and `github://` forms. Both `homepage` and
`repository` are optional, so these entries keep their place and lose the
link. They are not a reason to hold anything back.

### 3.5 Names the npm grammar refuses — 8

All github-sourced, all shaped like a scoped package with an upper-case owner
(`@Badegg404/dsh-api-balance`). Format 1's `name` is an identifier, not the
git install spec, but it still has to be a valid npm name. These stay on the
shelf.

### 3.6 One four-part version — 1

`0.8.7.1` is not a SemVer. One entry, excluded until its manifest is fixed.

## 4. Icons are the size question

Measured on the same document:

| | |
|---|---|
| with every icon inlined as its `data:` URL | **17.9 MiB** |
| with no icons | **9.8 MiB** |

Our 6,317 published icons are already `data:` URLs in a content-addressed
sidecar, and **none exceeds the 32 KiB inline limit** — so inlining is legal,
it is just expensive. Format 1 is one document per source URL and has no
sharding, so the whole index arrives in one request inside the reader's
15-second budget. For reference, the published `plugins.json` is 26.2 MiB and
was fetched here in 1.3 s; that is a measurement of one network, not a
promise about every reader's.

The first cut should publish without icons (§7) and revisit with per-file
icons referenced by absolute URL, which keeps the document at 9.8 MiB and
still gives the Discover page its artwork.

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
  index lists **0 git-sourced plugins** out of 5,437; ours would be 5,404 of
  17,389. The `git` source variant, and its `path` for a monorepo package, is
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

Without §3.1, today's data already yields **17,389 plugins in 9.8 MiB** with
no icons, accepted by the harness's own validator. That is a working,
honest artifact that leaves out 7,769 github entries rather than inventing a
version for them — the same posture this repository takes everywhere else:
an absent fact costs the fact and never the listing.

Adding §3.1 lifts the ceiling to **24,127** — 17,389 + 6,738. It is 6,738 and
not 7,769 because 1,031 of those entries are held out by something else as
well (a tag instead of a commit, a name the npm grammar refuses, or a name an
npm entry already owns).

## 8. Decisions for a human

1. **Spend the re-read?** §3.1 costs one full re-read of every carried
   repository under `DECLARATIONS_RULE` 6. It is the difference between 66%
   of the catalog (17,389 of 26,351) and 92% of it (24,127).
2. **Icons now or later?** 9.8 MiB without, 17.9 MiB with. Per-file icons are
   a third option that needs the sidecar split.
3. **Tag-resolved entries?** §3.3 is 443 entries and one extra fact at
   harvest time.

## 9. What changes once this is accepted

- A spec amendment to `2026-08-18-dsh-plugin-shop-design.md` for a second
  published artifact and its path beside `v1/`.
- A plan entry in `2026-08-18-remaining-work.md`.
- If §3.1 is taken: the `github-client.ts` pairing, `repo-state.ts`'s parse
  rule, the tier/emit path, and `DECLARATIONS_RULE` 6, with the tests that
  pin the pairing (`pipeline.test.ts` asserts exactly which entries carry it)
  amended in the same change.

