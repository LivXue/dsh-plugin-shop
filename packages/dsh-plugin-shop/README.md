<div align="center">

# dsh-plugin-shop

**The plugin shop for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** — browse a catalog of
dsh plugins, install one with a single confirmation, and manage what you have, from a tab inside Settings.

[![npm](https://img.shields.io/npm/v/dsh-plugin-shop?logo=npm&color=cb3837)](https://www.npmjs.com/package/dsh-plugin-shop)
[![plugins](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2FLivXue.github.io%2Fdsh-plugin-shop%2Fv1%2Findex.json&query=count&label=plugins&color=blue)](https://LivXue.github.io/dsh-plugin-shop/v1/index.json)
[![filtered](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2FLivXue.github.io%2Fdsh-plugin-shop%2Fv1%2Findex.json&query=rejected&label=filtered&color=orange)](https://LivXue.github.io/dsh-plugin-shop/v1/index.json)
[![license](https://img.shields.io/npm/l/dsh-plugin-shop?color=blue)](https://github.com/LivXue/dsh-plugin-shop/blob/main/LICENSE)
[![plugin CI](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/plugin.yml/badge.svg)](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/plugin.yml)
[![catalog](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/daily.yml/badge.svg)](https://github.com/LivXue/dsh-plugin-shop/actions/workflows/daily.yml)

English | [中文](https://github.com/LivXue/dsh-plugin-shop/blob/main/packages/dsh-plugin-shop/docs/README.zh.md)

</div>

---

## 📦 Install

Two tracks below. They do the same thing; pick the one that matches who is reading.

### 🧑 For people

**Prerequisites:** Node.js. Running the harness itself needs no install — the
upstream-documented form is `npx -y @deepseek-ai/dsh web`. Plugin management
goes through `dsh plugin`, which spawns both the `dsh` command and `pnpm` —
install them once with `npm install -g @deepseek-ai/dsh pnpm` and verify with
`dsh --version` and `pnpm --version`.

```sh
# dsh on PATH (global install). The explicit version pin matters: pnpm 11
# holds back very recent releases, so a bare `add dsh-plugin-shop` can hand
# you an older version for a while. Pin the current release — refresh it
# with `npm view dsh-plugin-shop version`.
dsh plugin --profile web add dsh-plugin-shop@0.7.2
# or straight through npx, nothing installed:
npx -y @deepseek-ai/dsh plugin --profile web add dsh-plugin-shop@0.7.2
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

**2. Install.** Pin the version — the explicit pin bypasses pnpm's release
cooldown, and deterministic installs are the point of the agent path.

```sh
dsh plugin --profile <profile> add dsh-plugin-shop@0.7.2
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
| A version older than npm's `latest` gets installed | pnpm 11 holds back very recently published versions | Pin the version explicitly: `dsh plugin --profile <p> add dsh-plugin-shop@<version>` |
| `client bundles not found ... lib/client.js` | the copy on disk was built without its browser half | Install from npm rather than from a source checkout, or run `pnpm build` in that checkout |
| `dsh: pnpm not found on PATH — install pnpm to manage profile plugins` | `dsh plugin` forwards to pnpm, and pnpm is missing | `npm install -g pnpm` |
| `no profile directory found above <path>` | the plugin could not locate its profile | Please report it — this is resolved from `ctx.baseUrl` and should not fail |
| The tab is missing after a restart | the bundle is not in the profile's `bundles` | Re-run step 3; if it is absent, step 2 did not complete |

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

## ✨ What it does

| | |
|---|---|
| **Browse & search** | Thousands of plugins, harvested from the whole public npm registry by the `dsh-plugin` and `deepseek-harness` keywords and from GitHub repositories using them as topics — shown with the author's own summary when they declared one, and sorted into seven categories |
| **Install** | One confirmation. An unreviewed plugin requires an explicit acknowledgement first — an installed plugin holds the same privileges as a built-in one |
| **Enable / disable** | Applies to an installed plugin without a restart |
| **Installed state** | An installed plugin shows an Installed label on its card — or an Update button when the catalog has a newer version — plus an Uninstall button; the Installed filter in the category bar shows only installed plugins |
| **Restart** | After an install, update, or uninstall, the shop offers to restart dsh — stating the cost first: the page disconnects and in-flight work is interrupted |
| **Self-update** | The shop shows its own version next to the search box, checks npm for a newer release, and updates itself with the pinned version — then the usual restart |

## 🔎 Where the shelf comes from

The catalog is not a list anyone curates by hand. Six steps run every day, and two of
them are the reason the shelf is worth reading:

1. **Harvest the whole registry.** Every npm package carrying `dsh-plugin` or
   `deepseek-harness`, plus every GitHub repository using them as topics. Nothing is
   submitted; there is no queue.
2. **Gate every candidate.** Most of what is harvested never reaches the shelf; the
   live badges on the
   [repository README](https://github.com/LivXue/dsh-plugin-shop) count both sides.
   A package with no `dsh.bundle` is a library, not a plugin. No
   license or no repository means nothing can be audited. Deprecated on npm is out; a
   repository listing additionally needs no build scripts and no `workspace:`
   dependencies, either of which would fail the install on your machine. A name a hair
   away from a popular one is held until someone clears it. Seventeen recorded
   reasons, all mechanical, and every rejection carries a line its author can read.
3. **Classify and record.** Seven categories, and the peer modules each plugin
   declares — names only, never version ranges.
4. **Publish.** Content-addressed JSON, to npm and GitHub Pages at once.
5. **Fetch here.** This package races the origins and verifies the sha256 before
   trusting a byte.
6. **Check dependencies here too.** Your installation resolves each recorded peer name
   against *your* profile — the same question dsh's loader asks at mount time. A card
   whose modules are absent reads **Incompatible** and names them. That verdict is
   computed on your machine, because it depends on the harness you are actually
   running, not the one the build ran on.

The full pipeline diagram lives in the
[repository README](https://github.com/LivXue/dsh-plugin-shop#-how-it-fits-together).

One thing this does **not** do: no listing has been read by a human. `verified.yml` is
empty today, every entry is community-tier, and every install asks you to acknowledge
that. Mechanical filtering is not review.

## 🧩 How it is put together

Two halves ship in this one package, and the split between them is the security
boundary:

| Half | Entry | Can reach | Cannot reach |
|---|---|---|---|
| **Host** | `dsh-plugin-shop` | The network (catalog fetch and sha256 verify), the filesystem (cache), `dsh plugin add` under a per-profile mutex | — |
| **Client** | `dsh-plugin-shop/client` | Exactly nine `shop/*` Remote methods | The network, the filesystem |

Compromising the browser half buys an attacker those nine calls and nothing more.

## ⚙️ Configuration

The shop reads its catalog from whichever source answers first: the npm
package `dsh-plugin-shop-catalog` (via your configured registry, npmmirror,
or npmjs) or `https://LivXue.github.io/dsh-plugin-shop/v1/`. All of them
carry the same bytes; the race exists because the link to one of them can be
far slower than the link to another. Setting `DSH_SHOP_CATALOG_URL` opts out
of the race and uses only what you name.

| Variable | Effect |
|---|---|
| `DSH_SHOP_CATALOG_URL` | Read the catalog only from this base, instead of racing the default sources |

## 📚 The catalog

Built daily from the public npm registry and published as static JSON:

- [`/v1/index.json`](https://LivXue.github.io/dsh-plugin-shop/v1/index.json) — the pointer, carrying `schemaVersion`, `builtAt`, the entry `count` and `rejected` totals (the badges above read them live), and the content hash
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

Add a harvest keyword — `"keywords": ["dsh-plugin"]` or `"keywords": ["deepseek-harness"]` — to
`package.json` and publish. Or, without npm: add the keyword as a GitHub repo *topic* and keep a
`package.json` at the root with a `name` and `dsh.bundle` — the catalog lists the repo and pins the
default-branch commit as its version. The daily build finds you; nothing is submitted to this project. Declare a `dsh.catalog` section to control
your own category, summary and capabilities — or omit it, and the catalog derives a
listing from your npm `description`.

Full reference: [docs/schema.md](https://github.com/LivXue/dsh-plugin-shop/blob/main/docs/schema.md).

## 📄 License

[Apache-2.0](https://github.com/LivXue/dsh-plugin-shop/blob/main/LICENSE) © LivXue
