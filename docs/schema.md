# Catalog schema

English | [中文](schema.zh.md)

A plugin is listed by declaring the `dsh-plugin` keyword and a `dsh.catalog` section in its `package.json`. The machine-readable schema is [`registry/schema/plugin-entry.schema.json`](../registry/schema/plugin-entry.schema.json), generated from the validator the build runs, so it cannot drift from what is enforced.

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

| Field | Required | Meaning |
|---|---|---|
| `category` | yes | One of `tool`, `provider`, `ui`, `workflow`, `integration`, `other` |
| `summary.en` | yes | One line, 1–200 characters. Not synthesized: a missing translation stays missing |
| `summary.zh` | yes | The same, in Chinese |
| `capabilities` | yes | Up to 20 free-form strings naming the dsh services the plugin uses |

**`capabilities` is self-declared and unenforced.** dsh does not sandbox plugins, so this field describes what the author says the plugin touches. It is displayed, never checked. Do not read it as a permission grant.

Unknown fields are rejected rather than ignored, so a typo fails the build with a message naming the field instead of silently dropping your data.
