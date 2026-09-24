# Catalog schema

English | [中文](schema.zh.md)

A plugin is listed by declaring a harvest keyword — `dsh-plugin` or `deepseek-harness` — in its `package.json`. A plugin that never publishes to npm is listed from its GitHub repository instead: add the `dsh-plugin` or `deepseek-harness` *topic* to the repo, keep a `package.json` at the root with a `name` and a `dsh.bundle` section, and the catalog pins the default-branch commit as its version. The `dsh.catalog` section below is **optional**: declare it to control your own listing text, category, and capabilities, or omit it and the catalog derives a listing from what npm already knows. The machine-readable schema for a declared section is [`registry/schema/plugin-entry.schema.json`](../registry/schema/plugin-entry.schema.json), generated from the validator the build runs, so it cannot drift from what is enforced.

```json
{
  "keywords": ["dsh-plugin"],
  "dsh": {
    "bundle":  { "patch": "./cordis.patch.yml" },
    "catalog": {
      "category": "tool",
      "summary": { "en": "Does a thing", "zh": "做一件事" },
      "capabilities": ["fs", "shell"]
    }
  }
}
```

If you declare `dsh.catalog`, both languages are required — declaring the section means declaring both:

| Field | Required | Meaning |
|---|---|---|
| `category` | yes | One of `tool`, `provider`, `ui`, `workflow`, `integration`, `theme`, `other` |
| `summary.en` | yes | One line, 1–200 characters. Not synthesized: a missing translation stays missing |
| `summary.zh` | yes | The same, in Chinese |
| `capabilities` | yes | Up to 20 free-form strings, 1–64 characters each, naming the dsh services the plugin uses |

If you do not declare `category`, the shop may assign one by automated review; declare it to stay in control. The `theme` category is for plugins that change the interface's appearance: skins, themes, visual styles (皮肤、主题、外观).

If your repository is on GitHub, its star count is shown automatically — there is nothing to declare; repositories on other hosts show none.

**`capabilities` is self-declared and unenforced.** dsh does not sandbox plugins, so this field describes what the author says the plugin touches. It is displayed, never checked. Do not read it as a permission grant.

**Every field that reaches the published catalog is length-bounded.** A declared section is copied verbatim into a file every reader downloads, so a value past its bound is rejected with the field named rather than published: `summary.en` and `summary.zh` at 200 characters each, every `capabilities` item at 64. The build bounds the npm manifest fields it reads on your behalf the same way — `name` at 214 characters, `version` at 128, `dist.integrity` at 256, the publication time npm reports at 64, the publishing account at 128, `license` at 128 (past that it is not an SPDX identifier) and `repository` at 512 — and, on both channels, it records at most 128 required `peerDependencies` names, each at most 128 characters. Optional peers are left out before that cap applies, so they never take a slot. Peers past either of those two bounds are dropped from your entry and the listing still appears: that trim is silent and gets no row in the build report. `dsh.compatibility` is bounded the same way — its `dsh` range at 256 characters, each profile name at 64, and at most 16 profiles — and whatever is past a bound is dropped just as silently, with no row. `dist.unpackedSize` — the figure behind an npm package's size on the shelf — is read the same way and kept only when npm reports it as a safe non-negative integer; anything else is dropped and your entry lists without a size, which is also silent and also gets no row. A zero is kept, not dropped: npm reports 0 for an empty tarball and the shelf shows "0 B". A listing taken from a GitHub repository needs its root `package.json` to decode to at most 1 MB (1,048,576 bytes) — the bound is on the decoded JSON measured in bytes, and the build stops reading once it is crossed — and a `name` in the shop's own bundle-name grammar, which is npm's minus the lowercase rule: an optional `@scope/`, then a letter or a digit, then any of letters, digits, `.`, `-` and `_`, at most 214 characters in total. Uppercase is accepted here even though npm forbids it in a new publication — a repository is not an npm publication, and `DSH-FS-TOOL` installs fine — but a leading `.` or `_` is not, in the name or in the scope. A subpackage's directory path is bounded at 200 characters, because it becomes that entry's own identifier (`owner/repo#path`): a longer one is not listed, and its row says the path was cut.

**The size on your card is measured, and how depends on where you list from.** The shelf shows what installing the plugin puts on disk; it reaches the published catalog as `installSize`, which is the key to look for if you are reading `plugins.json` directly. For an npm package that is npm's own `dist.unpackedSize`, so the card and your npm page agree. For a listing taken from a GitHub repository it is the sum of the file sizes in the git tree at the pinned commit — scoped to your subpackage directory when your entry has one, so a monorepo is never charged whole. Directories and submodules contribute nothing: a submodule's content is not in that tree and a tarball install does not fetch it either. It is **not** the size GitHub reports for the repository, which counts history and is not what you install.

Expect a repository figure to run larger than the same code's npm figure. That is real content rather than error: a repository holds the tests, docs and screenshots your npm `files` whitelist leaves out, and a repo install genuinely puts all of it on disk.

A size is a decoration, so failing to measure one costs the label and never the listing, and none of these get a row in the build report. Yours will be absent if npm reported no `dist.unpackedSize` (publishes older than npm 5.6) or reported one that is not a safe non-negative integer; or, on the GitHub side, if the tree came back truncated, any element of it was unreadable, a file reported a size that is negative or not a safe integer, the running sum passed 2^53, or no file matched at all — an empty tree, or a subpackage directory matching nothing. That last one is deliberate: zero files counted is not the same statement as zero bytes, and publishing "0 B" would claim your plugin costs nothing to install.

**One entry also has a total size budget, and it is a different kind of rule.** A field bound says what one value may look like; the budget says what a whole entry may cost. Everything the build takes from you — your `dsh.catalog` section, the manifest fields above, the peers that survived the trim, your `dsh.compatibility` declaration, and the unpacked size if npm reported one — is serialized exactly as it will appear in `plugins.json`, and the result must come to at most **12,288 bytes (12 KiB), counted in UTF-8 bytes** rather than characters: a Chinese summary costs three bytes per character there. The budget is checked last, and on GitHub listings as well as npm ones. Unlike the peer trim it refuses rather than shortens — an entry past it is not listed at all, and its Detail names the byte count it reached and the budget it crossed. So if your package is missing from the catalog entirely, look for its row in the build report; if the entry is there and only some peer names are absent, that was the trim — or you marked those peers optional. The two rules are deliberately not jointly satisfiable at their limits — 128 peers of 128 characters each is far past 12,288 bytes and is refused — so read the budget as the real ceiling and the field bounds as the shape each part may take. For scale: the largest entry today's catalog could hold, every maximum observed on 2026-09-04 gathered into one entry, measures 6,294 bytes, so nothing listed is near it.

The build report lists each rejection as a **Reason** and a **Detail** — read the Detail. Some Reason codes are broader than the case they carry: a `license` or `repository` past its bound reports `no-license` or `no-repository`, and `no-manifest` covers every way a `package.json` we did read cannot be listed — refused for its size, over-bounded in a field, past the entry budget, or carrying a name the bundle-name grammar rejects — so the code can say "no" about something you did declare. The Detail is the accurate half and names the bound you crossed. The converse is worth knowing when you are chasing a listing that never appeared: `no-manifest` means we read your `package.json`, or got a 404 asking for it. If our own request failed instead, the row says `fetch-failed`, and that is retried on the next build rather than held against your repository.

Unknown fields are rejected rather than ignored, so a typo fails the build with a message naming the field instead of silently dropping your data. That message is itself capped at 200 characters and ends with `… (truncated)` when it was cut; the field name comes first, so the part you need to act on always survives. **A `dsh.catalog` section that fails validation is rejected outright** — it never falls back to a derived listing, because an author who declared the section and got it wrong deserves the build report to say so, not a silent substitute.

## Listed without a `dsh.catalog`

Omit the section entirely and your package is still listed, from your npm `package.json`'s own `description` field:

| Field | Declared | Derived (no `dsh.catalog`) |
|---|---|---|
| `metadata` | `declared` | `derived` |
| `summary.en` | your text | your npm `description`, trimmed and capped at 200 characters |
| `summary.zh` | your text | absent |
| `category` | your choice | `other` |
| `capabilities` | your list (up to 20 items, 64 characters each) | empty |

A package with no `dsh.catalog` and no npm `description` is not listed at all — there is nothing to show. A derived listing carries `metadata: "derived"` in the published entry; adding a `dsh.catalog` section is how you claim it. The shop no longer badges derived entries visually.

`metadata` is independent of trust tier: a derived listing can still be `verified`, because review reads the plugin's code, not its prose.

## The published catalog data file

Each build publishes the catalog as a content-addressed data file, `plugins.<sha256>.json`, named by the hash of its own contents. Besides the accepted `plugins` array, it carries a `denied` array: every denylisted package with the author-readable reason it was blocked. The Host consults `denied` when a `shop/installStart` request names a blocked package. Rejections that are not denials — a missing bundle, a `dsh.catalog` that failed validation, a name too similar to an existing plugin — appear only in the build report, never in the published data.

Every entry carries `added`, the date it first appeared in the catalog (YYYY-MM-DD) — recorded per package name by the registry, never declared by the author. A GitHub entry rescued from a build script (`requires-build`) installs from a prebuilt release tarball instead of git: it carries an optional `tarball` object (`url` + `sha256`), its `version` is the release tag, and its `integrity` is the tarball's sha256. For such an entry, a `verified` review pins `reviewedSha256` — the reviewed tarball's content hash, never the tag: a tag is a mutable ref that can be re-created on different content, and verified trust must name what the entry actually installs. A `denied` row may carry `replacement`, the name of a legitimate substitute when a human recorded one.

Every entry, npm or GitHub, also carries `peers` — the names of its **required** `peerDependencies`, never a version range, and no field at all when it requires none. A peer you mark `optional: true` in `peerDependenciesMeta` is not recorded, so it never produces a warning. A GitHub listing gains the field the next time the build re-reads its repository: a one-time re-read, spread over several daily builds rather than done in one. A reader's own dsh checks each name against its installation and against the modules its web client provides itself, and warns only about a name neither provides, so the shop can badge a listing before someone installs a plugin their harness cannot run. It is a warning, never a refusal: the install still goes ahead if they confirm.

If your manifest declares `dsh.compatibility`, the catalog records that as well: `dsh`, a semver range naming the dsh versions you support, and `profiles`, the profile names you support. Both are optional and either may stand alone; a half that is malformed is dropped without costing the other. The build copies them and never judges them — the reader's own dsh compares them against the version and profile it is actually running, and when either does not match, the shop warns and names both sides: what you declared, and what the reader is running. Prerelease versions count, so `>=0.1.0` accepts `0.1.5-rc.3`, and a range dsh cannot parse is left unjudged rather than guessed at. It is a warning, never a refusal, and declaring nothing is not a claim of incompatibility: it produces no warning at all.
