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
| `capabilities` | yes | Up to 20 free-form strings naming the dsh services the plugin uses |

If you do not declare `category`, the shop may assign one by automated review; declare it to stay in control. The `theme` category is for plugins that change the interface's appearance: skins, themes, visual styles (皮肤、主题、外观).

If your repository is on GitHub, its star count is shown automatically — there is nothing to declare; repositories on other hosts show none.

**`capabilities` is self-declared and unenforced.** dsh does not sandbox plugins, so this field describes what the author says the plugin touches. It is displayed, never checked. Do not read it as a permission grant.

Unknown fields are rejected rather than ignored, so a typo fails the build with a message naming the field instead of silently dropping your data. **A `dsh.catalog` section that fails validation is rejected outright** — it never falls back to a derived listing, because an author who declared the section and got it wrong deserves the build report to say so, not a silent substitute.

## Listed without a `dsh.catalog`

Omit the section entirely and your package is still listed, from your npm `package.json`'s own `description` field:

| Field | Declared | Derived (no `dsh.catalog`) |
|---|---|---|
| `metadata` | `declared` | `derived` |
| `summary.en` | your text | your npm `description`, trimmed and capped at 200 characters |
| `summary.zh` | your text | absent |
| `category` | your choice | `other` |
| `capabilities` | your list | empty |

A package with no `dsh.catalog` and no npm `description` is not listed at all — there is nothing to show. A derived listing carries `metadata: "derived"` in the published entry; adding a `dsh.catalog` section is how you claim it. The shop no longer badges derived entries visually.

`metadata` is independent of trust tier: a derived listing can still be `verified`, because review reads the plugin's code, not its prose.

## The published catalog data file

Each build publishes the catalog as a content-addressed data file, `plugins.<sha256>.json`, named by the hash of its own contents. Besides the accepted `plugins` array, it carries a `denied` array: every denylisted package with the author-readable reason it was blocked. The Host consults `denied` when a `shop/installStart` request names a blocked package. Rejections that are not denials — a missing bundle, a `dsh.catalog` that failed validation, a name too similar to an existing plugin — appear only in the build report, never in the published data.

Every entry carries `added`, the date it first appeared in the catalog (YYYY-MM-DD) — recorded per package name by the registry, never declared by the author. A GitHub entry rescued from a build script (`requires-build`) installs from a prebuilt release tarball instead of git: it carries an optional `tarball` object (`url` + `sha256`), its `version` is the release tag, and its `integrity` is the tarball's sha256. For such an entry, a `verified` review pins `reviewedSha256` — the reviewed tarball's content hash, never the tag: a tag is a mutable ref that can be re-created on different content, and verified trust must name what the entry actually installs. A `denied` row may carry `replacement`, the name of a legitimate substitute when a human recorded one.

An npm entry also carries `peers` — the names of the package's declared `peerDependencies`, never a version range. A reader's own dsh resolves each name against its installation and reports back whichever it cannot provide, so the shop can badge a listing before someone installs a plugin their harness cannot run.
