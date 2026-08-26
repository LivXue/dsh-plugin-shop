<div align="center">

# dsh-plugin-shop

**The plugin shop for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — browse a catalog of
dsh plugins, install one with a single confirmation, and manage what you have, from a tab inside Settings.

[![npm](https://img.shields.io/npm/v/dsh-plugin-shop?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-shop)
[![license](https://img.shields.io/npm/l/dsh-plugin-shop?color=blue)](https://github.com/LivXue/dsh-plugin-shop/blob/main/LICENSE)
[![plugin CI](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/plugin.yml/badge.svg)](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/plugin.yml)
[![catalog](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/daily.yml/badge.svg)](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/daily.yml)

English | [中文](https://github.com/LivXue/dsh-plugin-shop/blob/main/packages/dsh-plugin-shop/docs/README.zh.md)

</div>

---

## 🖼️ Screenshots

<div align="center">
<img src="https://raw.githubusercontent.com/LivXue/dsh-plugin-shop/main/docs/images/shelf-light.png" alt="The plugin shop shelf inside dsh Settings" width="860">
</div>

<table>
<tr>
<td width="50%"><img src="https://raw.githubusercontent.com/LivXue/dsh-plugin-shop/main/docs/images/gate-light.png" alt="Installing an unreviewed plugin requires an explicit acknowledgement"></td>
<td width="50%"><img src="https://raw.githubusercontent.com/LivXue/dsh-plugin-shop/main/docs/images/shelf-dark.png" alt="The same shelf in the dark theme"></td>
</tr>
<tr>
<td align="center"><sub>Installing an unreviewed plugin requires an explicit acknowledgement</sub></td>
<td align="center"><sub>The same shelf in the dark theme</sub></td>
</tr>
</table>

## 📦 Install

Two tracks below. They do the same thing; pick the one that matches who is reading.

### 🧑 For people

**Prerequisites:** Node.js. Running the harness itself needs no install — the
upstream-documented form is `npx -y @deepseek-ai/dsh web`. But the shop installs
plugins by spawning the `dsh` command, so put it on your PATH once
(`npm install -g @deepseek-ai/dsh`) and verify with `dsh --version`.

```sh
# dsh on PATH (global install):
dsh plugin --profile web add dsh-plugin-shop
# or straight through npx, nothing installed:
npx -y @deepseek-ai/dsh plugin --profile web add dsh-plugin-shop
```

Replace `web` with your profile if you use another one. Then restart `dsh` once — a
newly added bundle is not applied to a running process — and open

> **Settings → Plugins → Plugin shop**

You land on a shelf of plugin cards with a search box. The first load reads the catalog
over the network and can take a few seconds; a shimmering skeleton stands in until the
cards arrive.

### 🤖 For agents

Non-interactive, no prompts, nothing to confirm. `--profile` is **mandatory** —
without it `dsh plugin` exits with
`error: required option '--profile <name>' not specified`.

**1. Resolve a profile name.** Profiles are directories under `$DSH_HOME/profiles`
(`$DSH_HOME` defaults to `~/.dsh`). `node_modules` appears there too and is *not* a
profile.

```sh
ls -1 "${DSH_HOME:-$HOME/.dsh}/profiles" | grep -v '^node_modules$'
```

**2. Install.**

```sh
dsh plugin --profile <profile> add dsh-plugin-shop
```

**3. Verify — do not skip this.** A zero exit from step 2 means pnpm resolved the
package, not that the profile will load it. Assert on the bundle list:

```sh
dsh plugin --profile <profile> list --depth 0
```

`dsh-plugin-shop` must appear with a resolved version. If you would rather read the
manifest directly, the same fact lives at
`$DSH_HOME/profiles/<profile>/package.json` under `dsh.profile.bundles`.

**4. Restart the profile** — `dsh --profile <profile>`, or `dsh web` for the web
profile. Enabling or disabling an *already installed* plugin is hot; adding a new
bundle is not.

#### Failure modes

| What you see | What it means | What to do |
|---|---|---|
| `error: required option '--profile <name>' not specified` | `--profile` was omitted | Pass it; there is no default |
| A version older than npm's `latest` gets installed | pnpm 11 holds back very recently published versions | Expected, not an error; the newest lands once its cooldown passes |
| `client bundles not found ... lib/client.js` | the copy on disk was built without its browser half | Install from npm rather than from a source checkout, or run `pnpm build` in that checkout |
| `no profile directory found above <path>` | the plugin could not locate its profile | Please report it — this is resolved from `ctx.baseUrl` and should not fail |
| The tab is missing after a restart | the bundle is not in the profile's `bundles` | Re-run step 3; if it is absent, step 2 did not complete |

## ✨ What it does

| | |
|---|---|
| **Browse & search** | 1800+ packages harvested from npm by the `dsh-plugin` keyword, shown with the author's own summary when they declared one |
| **Install** | One confirmation. An unreviewed plugin requires an explicit acknowledgement first — an installed plugin holds the same privileges as a built-in one |
| **Enable / disable** | Applies to an installed plugin without a restart |
| **Outdated installs** | Compared against the catalog's current version |

## 🧩 How it is put together

Two halves ship in this one package, and the split between them is the security
boundary:

| Half | Entry | Can reach | Cannot reach |
|---|---|---|---|
| **Host** | `dsh-plugin-shop` | The network (catalog fetch and sha256 verify), the filesystem (cache), `dsh plugin add` under a per-profile mutex | — |
| **Client** | `dsh-plugin-shop/client` | Exactly five `shop/*` Remote methods | The network, the filesystem |

Compromising the browser half buys an attacker those five calls and nothing more.

## ⚙️ Configuration

| Variable | Effect |
|---|---|
| `DSH_SHOP_CATALOG_URL` | Point the shop at your own catalog mirror instead of the public one |

## 📚 The catalog

Built daily from the public npm registry and published as static JSON:

- [`/v1/index.json`](https://LivXue.github.io/dsh-plugin-shop/v1/index.json) — the pointer, carrying `schemaVersion`, `builtAt`, and the content hash
- `/v1/plugins.<sha256>.json` — the data, content-addressed and safe to cache indefinitely

The pointer is small enough to poll. The shop verifies the data file's sha256 against
the pointer before trusting a byte of it.

## ⚠️ What it does not claim

A listing is not an endorsement.

`capabilities` is whatever the author wrote about their own package. **There is no
sandbox in v0**, and the interface never renders that field as an enforced permission
list. The `verified` tier means a human read *that exact version*; a newer publish
downgrades it to `verified-stale` and keeps the review pinned to the version it was
actually given — so passing review once cannot buy trust for every future release.

## 🏷️ For plugin authors

Add `"keywords": ["dsh-plugin"]` to `package.json` and publish. The daily build finds
you; nothing is submitted to this project. Declare a `dsh.catalog` section to control
your own category, summary and capabilities — or omit it, and the catalog derives a
listing from your npm `description`.

Full reference: [docs/schema.md](https://github.com/LivXue/dsh-plugin-shop/blob/main/docs/schema.md).

## 📄 License

[MIT](https://github.com/LivXue/dsh-plugin-shop/blob/main/LICENSE) © LivXue
