# dsh-plugin-store

English | [中文](README.zh.md)

The plugin store for DeepSeek Harness — discover, install, enable, and update dsh plugins from a browsable catalog.

## Status

P0 — the catalog pipeline — is live in this repository. The plugin host and client (P1/P2) are not started; see [the remaining work](docs/plans/2026-08-18-remaining-work.md) and [the design](docs/design/2026-08-18-dsh-plugin-store-design.md).

## The catalog

The catalog is built daily and published as static JSON:

- `https://LivXue.github.io/dsh-plugin-store/v1/index.json` — the pointer, carrying `schemaVersion`, `builtAt`, and the content hash
- `https://LivXue.github.io/dsh-plugin-store/v1/plugins.<sha256>.json` — the data

The pointer is small enough to poll; the data file is content-addressed and safe to cache indefinitely. Each build's rejection report, with an author-readable reason per rejected package, is attached to the workflow run.

## What it is

- A **public community** market. Publishing to npm with the `dsh-plugin` keyword is all it takes to be discovered; nothing is submitted to this project.
- A **git-auditable** catalog. Every daily change is a reviewable diff, not a row in someone's database.
- A **tiered trust** model. Reviewed and unreviewed plugins are visually distinct, and a review is pinned to the exact version it covered — so an author who passes review cannot publish a malicious version and inherit the trust.
- A **zero-privilege** browser interface. Compromising the UI does not compromise the runtime.

## What it is not

**It is not a sandbox.** A dsh plugin, once mounted, holds the full `ctx` — your filesystem, your shell, and the requests going to the model. Installing one is complete trust. This project does not change that; it tells you the truth before you click.

It also carries no download counts, ratings, or reviews, and it will never offer an "install from arbitrary URL" button. That capability stays in `dsh plugin add`, where enabling build scripts and pinning a commit are decisions you make explicitly.

## Listing a plugin

Add the keyword to your `package.json`, then publish to npm. The daily build picks it up. A `dsh.catalog` section is optional: declare it to control your own category, summary, and capabilities, or omit it and the catalog derives a listing from your npm `description` instead (see [the schema reference](docs/schema.md)).

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

A package without `dsh.bundle` is a library rather than an installable plugin and is not listed. A package without a license or a repository is not listed either: without a repository it cannot be audited. Nor is a package with neither a `dsh.catalog` section nor an npm `description` — there would be nothing to show.

## License

MIT
