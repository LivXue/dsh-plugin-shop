# dsh-plugin-store

English | [中文](README.zh.md)

The plugin store for DeepSeek Harness — discover, install, enable, and update dsh plugins from a browsable catalog.

## Status

Design complete, implementation not started. See [the design](docs/design/2026-08-18-dsh-plugin-store-design.md).

## What it is

- A **public community** market. Publishing to npm with the `dsh-plugin` keyword is all it takes to be discovered; nothing is submitted to this project.
- A **git-auditable** catalog. Every daily change is a reviewable diff, not a row in someone's database.
- A **tiered trust** model. Reviewed and unreviewed plugins are visually distinct, and a review is pinned to the exact version it covered — so an author who passes review cannot publish a malicious version and inherit the trust.
- A **zero-privilege** browser interface. Compromising the UI does not compromise the runtime.

## What it is not

**It is not a sandbox.** A dsh plugin, once mounted, holds the full `ctx` — your filesystem, your shell, and the requests going to the model. Installing one is complete trust. This project does not change that; it tells you the truth before you click.

It also carries no download counts, ratings, or reviews, and it will never offer an "install from arbitrary URL" button. That capability stays in `dsh plugin add`, where enabling build scripts and pinning a commit are decisions you make explicitly.

## Listing a plugin

Add the keyword and a `dsh.catalog` section to your `package.json`, then publish to npm. The daily build picks it up.

```json
{
  "name": "dsh-hello-plugin",
  "keywords": ["dsh-plugin"],
  "dsh": {
    "bundle":  { "patch": "./cordis.patch.yml" },
    "catalog": {
      "category": "tool",
      "summary": { "en": "...", "zh": "..." },
      "capabilities": ["fs", "shell"]
    }
  }
}
```

A package without `dsh.bundle` is a library rather than an installable plugin and is not listed. A package without a license or a repository is not listed either: without a repository it cannot be audited.

## License

MIT
