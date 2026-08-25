# Catalog schema

English | [中文](schema.zh.md)

A plugin is listed by declaring the `dsh-plugin` keyword in its `package.json`. The `dsh.catalog` section below is **optional**: declare it to control your own listing text, category, and capabilities, or omit it and the catalog derives a listing from what npm already knows. The machine-readable schema for a declared section is [`registry/schema/plugin-entry.schema.json`](../registry/schema/plugin-entry.schema.json), generated from the validator the build runs, so it cannot drift from what is enforced.

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
| `category` | yes | One of `tool`, `provider`, `ui`, `workflow`, `integration`, `other` |
| `summary.en` | yes | One line, 1–200 characters. Not synthesized: a missing translation stays missing |
| `summary.zh` | yes | The same, in Chinese |
| `capabilities` | yes | Up to 20 free-form strings naming the dsh services the plugin uses |

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

A package with no `dsh.catalog` and no npm `description` is not listed at all — there is nothing to show. A derived listing carries `metadata: "derived"` in the published entry, which a consumer can present as unclaimed; adding a `dsh.catalog` section is how you claim it.

`metadata` is independent of trust tier: a derived listing can still be `verified`, because review reads the plugin's code, not its prose.

## The published catalog data file

Each build publishes the catalog as a content-addressed data file, `plugins.<sha256>.json`, named by the hash of its own contents. Besides the accepted `plugins` array, it carries a `denied` array: every denylisted package with the author-readable reason it was blocked. The Host consults `denied` when a `store/install` request names a blocked package. Rejections that are not denials — a missing bundle, a `dsh.catalog` that failed validation, a name too similar to an existing plugin — appear only in the build report, never in the published data.
