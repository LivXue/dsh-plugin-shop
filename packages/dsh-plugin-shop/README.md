# dsh-plugin-shop

English | [中文](README.zh.md)

The plugin store for [DeepSeek Harness](https://github.com/deepseek-harness), as a
tab inside the Harness settings surface: browse a catalog of dsh plugins, install
one with a single confirmation, enable or disable what is installed, and see what
has a newer version.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-plugin-shop
```

Restart `dsh` once. The tab appears under **Settings → Plugins → Plugin store**.

## What it does

- **Browse and search** the catalog — 1800+ packages harvested from npm by the
  `dsh-plugin` keyword, with the author's own summary when they declared one.
- **Install** with one confirmation. An unreviewed plugin requires an explicit
  acknowledgement first, because an installed plugin holds the same privileges as
  a built-in one: your files, your shell, and the requests sent to the model.
- **Enable / disable** an installed plugin without a restart.
- **Spot outdated installs** against the catalog's current version.

## How it is put together

Two halves, one package:

- **Host** (`dsh-plugin-shop`) — fetches the catalog over the network, verifies its
  sha256 against the pointer, caches it, and runs `dsh plugin add` under a
  per-profile mutex. It exposes exactly five `store/*` Remote methods and nothing
  else.
- **Client** (`dsh-plugin-shop/client`) — the settings tab. It touches neither the
  network nor the filesystem; every effect goes through those five methods.

## The catalog

Built daily from the public npm registry and published as static JSON:

- `https://LivXue.github.io/dsh-plugin-shop/v1/index.json` — the pointer, carrying
  `schemaVersion`, `builtAt`, and the content hash
- `https://LivXue.github.io/dsh-plugin-shop/v1/plugins.<sha256>.json` — the data

Point the store at your own mirror with `DSH_STORE_CATALOG_URL`.

## What it does not claim

A listing is not an endorsement. `capabilities` is whatever the author wrote about
their own package — there is no sandbox in v0, and the UI never renders it as an
enforced permission list. The `verified` tier means a human read that exact
version; a newer publish downgrades to `verified-stale` and keeps the review
pinned to the version it was given.

## Author-facing docs

Declaring a `dsh.catalog` section so your plugin lists with your own words:
[docs/schema.md](https://github.com/LivXue/dsh-plugin-shop/blob/main/docs/schema.md).

## License

MIT
