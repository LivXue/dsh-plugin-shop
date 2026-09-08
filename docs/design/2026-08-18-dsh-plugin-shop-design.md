# dsh-plugin-shop Design

Status: reviewed, implementation plan pending
Date: 2026-08-18

## 1. Background

Every capability in DeepSeek Harness (dsh) is a Cordis plugin, and users compose their runtime by stacking bundle layers into a profile. The installation channel already exists: `dsh plugin --profile <p> add <spec>` forwards to pnpm inside the profile directory, then reconciles the profile's `dsh.profile.bundles` **against the installed state** rather than against a dependency diff.

What is missing is not installation. It is three other things:

- **Discovery** — no catalog exists, so a user has no way to learn which plugins exist.
- **Trust** — no source tiering, so installing a plugin means trusting an unknown body of code completely.
- **Interface** — no visual entry point for browsing, enabling, or updating.

dsh-plugin-shop supplies those three.

## 2. Goals and non-goals

### Goals

- A **public community** market: publishing to npm is enough to be discovered; nothing is submitted to this project.
- A **git-auditable** catalog: every daily change is a reviewable, revertable, attributable diff.
- A **tiered trust** model: reviewed and unreviewed entries are visually distinct, and a review binds to the exact version it covered.
- A **zero-privilege browser interface**: compromising the UI does not compromise the runtime.

### Non-goals (deliberate, not omissions)

- **No sandboxing.** A mounted plugin holds the full `ctx` — filesystem, shell, and the request stream to the model. Installing is complete trust. This project does not change that; it states the fact before the user clicks.
- **No defense against a compromised npm.**
- **No download counts, ratings, or reviews.** Those need a server and an anti-abuse program, which is pure liability below roughly a thousand plugins.
- **No install-from-arbitrary-URL.** That capability stays in the CLI; see §5.3.
- **No listing of plugins that ship with the harness.** The shelf is for third-party plugins; the ones dsh brings with it are already in its built-in plugin list. `@deepseek-ai/cordis-plugin-group`, `-include`, `-timer`, `-loader` and `-hmr` all sit in a `@deepseek-ai/dsh@0.1.2-rc.1` install's own `node_modules` (`-timer` and `-include` as direct dependencies of the CLI package, measured 2026-09-07), so a row for one would advertise software every dsh user already has, behind an install button that changes nothing. The line is **ships with dsh**, not **published under `@deepseek-ai`**: an official plugin released from its own repository is an ordinary candidate and is listed like any other. This non-goal needs no mechanism of its own and has none — the bundled packages declare no npm `keywords` at all, so the keyword harvest never sees them, and one that copies the host project's repository boilerplate is refused as `harness-repository` (§7.1). Recorded here because it was read as a coverage gap in upstream discussion #5867 — the official scope's naming convention is not missing from the harvest key, it is outside the shelf's scope — and because the same policy already shows up at runtime: the shop refuses to toggle a `@deepseek-ai/*` bundle as part of the harness chain (§7.3, hub borrowings B).

## 3. Terminology

| Term | Meaning |
|---|---|
| catalog | The set of plugin entries built daily by `registry/` and published as static JSON |
| entry | One plugin record in the catalog |
| tier | An entry's trust level: `verified` / `verified-stale` / `community` |
| profile | A dsh runtime composition under `$DSH_HOME/profiles/<name>` |
| bundle | An npm package declaring `dsh.bundle`; installing it adds a patch layer to a profile |
| user layer | A profile's `cordis.patch.yml`, which dsh hot-reloads |

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Public community market with a self-hosted registry | The ecosystem data belongs to the project, rather than depending on a third party's availability and governance |
| D2 | Plugin metadata is **harvested from npm by keyword** | Publishing is listing; zero human step. Frictionless listing is a precondition for a community market reaching volume |
| D7 | A listing is **dual-track**: declared or derived | Measured 2026-08-18, after D1-D6 were fixed: the `dsh-plugin` keyword carried ~1390 npm packages then (3,731 on 2026-09-04 — the ecosystem grew, the conclusion did not change; the ~5,100 this row briefly carried was the OTHER harvest keyword, `deepseek-harness`, so re-probe this figure rather than inheriting it), of which a 100-package sample showed 94% declaring `dsh.bundle` and **0% declaring `dsh.catalog`**. Requiring a field this project invented would have shipped an empty catalog against a live ecosystem, contradicting D2's own premise |
| D3 | **verified / community** tiering | Automatic harvesting necessarily admits unreviewed packages. A market cannot both have zero friction and pretend everything is safe |
| D4 | The shop itself is an **out-of-tree bundle** | Independent release cadence, free of the dsh repository's gates. Verified that v0 needs no upstream change |
| D5 | The catalog is **static JSON built by daily CI**, not a service | Zero operations, and it makes the catalog a git-auditable artifact — the whole value of this approach over a server |
| D6 | The catalog is **fetched and cached by the Host**, not by the browser | Avoids CORS/CSP, enables offline degradation and intranet mirrors, and collapses network egress to one auditable point |

## 5. Architecture

### 5.1 Components and repository layout

One repository, two directories. `registry/` holds data and build scripts; `packages/dsh-plugin-shop/` holds the npm package. They share no code, only the schema in §6.

```
registry/
  schema/plugin-entry.schema.json   Catalog entry schema, carrying schemaVersion
  verified.yml                      Human allowlist, pinned per version
  denied.yml                        Denylist
  allowed-similar.yml               Explicit clearance for near-duplicate names
  snapshots/manifest.lock           Daily committed name -> version -> integrity
  scripts/build.ts                  harvest -> validate -> merge -> emit
packages/dsh-plugin-shop/            The npm package dsh-plugin-shop (under packages/ because the typert generator requires it; see the §5.1 note)
  src/host/                         ShopGateway
  src/client/                       Browser half
packages/dsh-typert-protocol/         Vendored @deepseek-ai/dsh-typert-protocol, build-time only (VENDORED.md)
.github/workflows/daily.yml         Daily and PR-triggered registry build
```

The package directory is `packages/dsh-plugin-shop/` rather than `plugin/` because `@deepseek-ai/dsh-typert-generator` hardcodes `packages/` as the package container.

The published npm package is named `dsh-plugin-shop`, not `dsh-plugin-shop`. The
latter was taken on npm on 2026-08-14 by an unrelated project of the same
concept, as were `dsh-plugin-hub`, `dsh-plugin-market`, `dsh-shop`,
`dsh-marketplace`, `dsh-catalog` and `dsh-plugin-catalog` — six different
maintainers publishing inside ten days. The repository, the Pages deployment
and the catalog URL were renamed to match, so one name spans all of them.
Note that `isShopLike` (§7.2 client filter) matches our own name by design:
the shelf does not list itself, because the shop is bootstrap-installed.
Competing marketplaces whose names escape the keyword patterns are named
explicitly in the filter (2026-08-27: `dsh-plugin`, the npm package of
`github.com/dshplugin/dsh-plugin-hub`; 2026-08-28, when the
`deepseek-harness` harvest keyword brought the app-store packages in:
`dsh-plugin-hub`, `@lanbaolu/dsh-plugin-hub`, `@mutocenew/dsh-plugin-catalog`;
2026-09-07: `@dsheval/dsh-top100-plugin`, dsheval.ai's Top100 rankings market,
whose own README calls the settings panel a plugin market and which browses,
installs, updates and uninstalls from that index).
A name can advertise a market without carrying a market word — a ranking, a
leaderboard, an index — so this list grows only when someone reads a package,
and each addition is recorded in `markets.yml` as `by: human` so the daily
classifier neither re-asks it nor can clear it back onto the shelf.

**R — `registry/` (data only, no runtime code)**

Artifacts publish to a CDN as `/v1/index.json` (a pointer) and `/v1/plugins.<sha256>.json` (the data). Separating pointer from data lets a client cache the data file indefinitely while polling only a few hundred bytes.

**Amendment (2026-09-01): the CDN becomes a set of raced origins.** The same
`v1/` tree also publishes as the npm package `dsh-plugin-shop-catalog`, and
the Host races a cheap pointer request across npm registries and Pages,
taking the bulk transfer from whichever answers first. The pointer/data split
is unchanged and does all the same work; what changes is that there is more
than one place to ask. Driven by measurement: the Pages origin serves a
China-side reader at 0.03 MB/s against an npm mirror's 12.53 MB/s. See
`2026-09-01-catalog-mirrors.md`.

**S — `packages/dsh-plugin-shop/` (the npm package `dsh-plugin-shop`, two halves)**

- **Host half**, `ShopGateway`: registers the `shop/*` Remote. It is the only place that touches the network or the profile directory.
- **Client half**, `dsh-plugin-shop/client`: follows the `dsh.client` convention, mounts the shop's Remote through `ctx.remote.$mount()`, and contributes one tab to `settings.plugins.tab`. **It touches neither the network nor the filesystem.**

**Upstream dsh: no change required for v0.**

### 5.2 Why out-of-tree works (verified against the source)

| Capability | Verdict | Evidence |
|---|---|---|
| Browser half can be loaded | Yes | `client/modules`' Node half scans enabled Loader entries for `dsh.client` packages, resolves `exports["./client"]`, hashes the bundle into the boot graph, and serves it under `/plugins` |
| Can register its own RPC | Yes | `ctx.remote.$mount()` is public, and `dsh-typert-loader` discovers and registers generated host artifacts in Loader compositions |
| Can read the installed plugin list | Yes | `pluginInventory/list` returns Loader entry id, specifier, effective enablement, and root Fiber phase |
| Can mutate installed plugins | No — must build it | `host/plugin-inventory` states it "cannot enable, disable, add, or remove plugins" |
| Can expose its own settings namespace | No — blocked by an allowlist | `WEB_SETTINGS_NAMESPACES` is a hardcoded constant in `api-proxy.ts` |
| Can push events to the browser | No — blocked by an allowlist | `API_REMOTE_FORWARDED_EVENTS` is a hardcoded array in `api/remotes/src/remote-events.ts` |

Neither blocked capability stops v0: the shop uses its own `shop/*` Remote instead of a settings namespace, and polls for progress instead of receiving pushes (§7.2).

### 5.3 Three hard boundaries

1. **The Client half holds no privilege.** Everything it can do is the nine `shop/*` methods in §7.3. If the UI is compromised, the attack surface is those nine methods' arguments.
2. **The Host accepts a name and a version, never an arbitrary spec.** `shop/installStart` takes `{ name, version }`, not a pnpm command line; `shop/uninstallStart` takes `{ name }`, never a pnpm command line. The Host validates against its own cached catalog snapshot (and, for uninstall, the installed manifest) and constructs the spec itself. `shop/restart` takes no arguments and re-spawns the Host's own command line verbatim — it cannot make the server do anything the user did not already launch. `shop/updateStart` takes `{ version }`, re-validated as plain semver, and the Host builds the pinned `dsh-plugin-shop@<version>` spec itself — the self-update path can never carry an arbitrary spec.
3. **The Host's catalog snapshot is the source of truth.** The browser sends a name; the Host decides using its own snapshot and trusts no metadata sent from the browser.

A direct consequence of boundary 2: **the shop UI will never have an "install from GitHub URL" button.** That capability stays in `dsh plugin add`, because it requires the user to explicitly enable `allowBuilds` and explicitly pin a commit SHA — two decisions that must not collapse into one click.

## 6. Catalog data model

### 6.1 What a plugin author declares

An author edits only their own `package.json`:

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

Two identifiers stay **ecosystem-neutral and deliberately unbranded**:

- The keywords are `dsh-plugin` and `deepseek-harness`, never `dsh-plugin-shop`. An author declares "I am a dsh plugin" (or "I integrate with deepseek-harness"), not "I want to be on your shelf".
- The field is `dsh.catalog`, not `dsh.shop`. The `dsh` section is DeepSeek's namespace — its JSDoc states that "other consumers own additional keys", so adding one is sanctioned — but adding a key named after this project would plant our sign in someone else's namespace. `catalog` names what the data is, so a second shop can reuse it directly. For a public community market that is the honest choice.

`category` is a closed enum: `tool` | `provider` | `ui` | `workflow` | `integration` | `theme` | `other`. **Amendment (2026-08-31, market borrowings): `theme` joins the enum** — skins, themes, visual appearance. It is a consumer-visible change — an old client's closed enum rejects a catalog carrying an unknown value wholesale — so it rode the v5 bump behind `SHOP_CATALOG_V5`; see §6.2 for the choreography and the below-v5 downgrade at the emission boundary.

`capabilities` is **self-declared and unenforced**. v0 has no sandbox, so it exists for display only. The UI must not let it read as an enforced permission list; a false sense of safety is worse than none.

### Declared and derived listings

`dsh.catalog` is **optional**. A package that omits it is still listed, from what npm already knows:

| Entry field | Declared (`dsh.catalog` present) | Derived (absent) |
|---|---|---|
| `metadata` | `declared` | `derived` |
| `summary.en` | the author's text | the npm `description`, trimmed and capped at 200 characters |
| `summary.zh` | the author's text | absent |
| `category` | the author's choice | `other` |
| `capabilities` | the author's list | empty |

Three rules keep the fallback from eroding the format:

- **A malformed `dsh.catalog` is still rejected, never downgraded to derived.** An author who declared the section and got it wrong has made a mistake worth reporting; silently falling back would hide it and leave them wondering why their text never appeared.
- **A package with neither `dsh.catalog` nor an npm `description` is rejected** as `no-summary`. There is nothing to show a user, and an entry that displays only a package name is not a listing.
- **Tiering stays orthogonal to metadata.** A derived entry can be `verified`, because a review reads the code, not the description. The two axes answer different questions: `tier` is "has a human read this?", `metadata` is "did the author describe it?".

A consumer MAY present a derived entry as unclaimed — the signal that prompts an author to add the section. Amendment (2026-08-30): the shop no longer renders the unclaimed badge; almost no author claims a listing, so the badge was noise. The `metadata` field keeps the derived/declared distinction in the data; the shelf just does not mark it. The license row normalizes the npm idiom `SEE LICENSE IN <file>` (a valid SPDX form meaning a custom license whose text ships in that file) to a localized "Custom license" label — the catalog data stays verbatim.

### 6.2 Published artifacts

`/v1/index.json`:

```json
{
  "schemaVersion": 2,
  "builtAt": "2026-08-18T00:00:00Z",
  "count": 137,
  "rejected": 42,
  "plugins": { "url": "plugins.<sha256>.json", "sha256": "<sha256>" }
}
```

The pointer carries `count` and `rejected` — the listed and the filtered totals, the two numbers the README badges read live. It may carry an optional `stars` object naming a content-addressed sidecar of GitHub star counts, keyed by package name for npm entries and by repo full name for github entries; stars are live daily data and are quarantined there so the plugin data hash stays cache-stable. `schemaVersion` is 3.

`/v1/plugins.<sha256>.json`:

```json
{
  "schemaVersion": 2,
  "plugins": [
    {
      "name": "dsh-hello-plugin",
      "version": "1.2.0",
      "integrity": "sha512-...",
      "publishedAt": "2026-08-01T12:00:00Z",
      "repository": "https://github.com/you/hello-plugin",
      "license": "MIT",
      "metadata": "declared",
      "catalog": {
        "category": "tool",
        "summary": { "en": "...", "zh": "..." },
        "capabilities": ["fs", "shell"]
      },
      "source": "npm",
      "added": "2026-08-01",
      "publisher": "someone",
      "unpackedSize": 847407,
      "tier": "verified",
      "review": {
        "reviewedVersion": "1.2.0",
        "reviewer": "github:someone",
        "reviewCommit": "abc1234",
        "notes": "..."
      }
    }
  ],
  "denied": [
    { "name": "dsh-hllo-plugin", "detail": "Denied by the registry: possible typosquat of dsh-hello-plugin" }
  ]
}
```

**The key order above is the emitted order, not a presentation choice.**
`JSON.stringify` preserves insertion order, that order is what the content
hash is taken over, and `assignTier` is where it is decided (pinned by
`tier.test.ts`). A sample in a different order invites someone to reconcile
code to spec in the direction this document normally prescribes — which would
rewrite every entry in `plugins.json` and invalidate every CDN cache for a
build with no data change, the harm the `builtAt` invariant exists to prevent.
The optional npm fields (`publisher`, `unpackedSize`) sit after `added` and
before `tier`; `peers` sits between them when present.

`publisher` is the npm account behind the package — npm entries only, absent
when npm names no maintainer. The shop renders it beside a link to the
package's npm page and draws no conclusion from it: the person decides. The
email npm carries beside every account name is dropped; our artifact has no
use for republishing it.

Resolution: the account npm recorded for this version (`_npmUser.name`) when
that account is one of the package's `maintainers`, otherwise the first
maintainer. Neither field alone works. `_npmUser` alone is not an identity —
measured on 250 live catalog entries, 30 report it as the literal string
"GitHub Actions", the trusted-publisher path the better-run projects use, and
naming that reads BACKWARDS for the case this row exists to serve: the original
`@nanmicoder/dsh-agent-teams` publishes from CI while the clone
`dsh-agent-squad` was pushed by hand, so the clone would be the side showing a
human account. `maintainers` alone loses the useful distinction of who
actually pushed the version, and it is a list — though a thin one: 246 of those
250 have exactly one, so the first is nearly always the only. Requiring
`_npmUser` to be corroborated by the maintainer list gets an owned account on
both paths (verified against live packuments: `relakkes` for the CI-published
original, `shenzhsjtu` for the hand-pushed clone).

`author` is rejected outright, not used as any fallback. It is free text the
publisher writes and a clone inherits it verbatim: `dsh-agent-squad` carries
the name and email of the author of the package it copied, so presenting
`author` would print the original author's name on the clone.

The field is additive and optional, and `schemaVersion` does NOT move for it.
A consumer refuses a catalog whose version exceeds the one it was built for
(§10), so a bump would make every installed shop reject the catalog outright;
an unknown key, by contrast, is stripped by the consumer's non-strict zod,
which is what lets old and new hosts read one catalog. This is the same
treatment `added` and `tarball` received. A bump remains necessary only for a
change an old consumer would REJECT rather than ignore — v5's category enum
being the precedent.

Why the shop shows this rather than deciding for the person: a measurement of
the live catalog found 56 clusters of listings whose summaries are byte
identical, 22 of them spanning publishers with no npm account in common. Which
member of such a cluster is the original is not decidable automatically —
publication date says the wrong thing (the official `@openviking/dsh-memory-
plugin` was published three days AFTER the fork that copied it), npm account
names do not match GitHub owners (`relakkes` publishes `@nanmicoder/*`), and
star counts are inherited from the shared repository, so both sides show the
same number. Provenance attestations cover only 30% of the population and a
fork can carry a perfectly valid one for its own fork. A registry that guessed
would delist real authors; publishing the two facts a person needs — which npm
package this is, and who published it — costs nothing and cannot be wrong.

`unpackedSize` is npm's `dist.unpackedSize` — the bytes an install puts on
disk. npm entries only, and only where the packument carried one; see the
2026-09-07 amendment for why a github entry gets none rather than an
approximation, and for the display rules (§7.3's amendment list). Additive and optional on the same
terms as `publisher` above: `schemaVersion` does not move for it.

`denied` carries every denylisted package with its author-readable reason; the Host consults it for the `shop/installStart` gate (§7.2). Rejections that are not denials stay in the build report.

`summary.zh` is optional in the published format because a derived entry has none, so `schemaVersion` is `2`.

A derived listing may carry an LLM-assigned `catalog.category` sourced from `registry/categories.yml`; the assignment is advisory and never gates a listing.

`builtAt` **never appears inside the hashed content**. Otherwise the hash changes daily, every CDN cache is invalidated, and every git diff is noise. Outside the hash it travels freely: `index.json` carries it, and so do the npm package's readme and its `catalogBuiltAt` manifest field — which the catalog-mirrors design uses to refuse a publish that would move `latest` backwards. All three are regenerated per publish and churn no hash.

**Amendment (2026-08-31, market borrowings): `schemaVersion` is 5**, emitted behind the build's `SHOP_CATALOG_V5` flag, with the release-order choreography as before (the v3→v4 precedent): the v5-parsing client ships first, and the flag flips in the release commit, so an old client never meets the new enum value. The bump is gated because `theme` is a new enum value and an old client's closed enum rejects a catalog containing it wholesale; the purely additive fields ride lower versions, since consumer-side zod strips unknown keys. Below v5 the emission boundary downgrades `theme` entries to `other` — the classifier and `categories.yml` keep `theme`, the build report counts the downgrades, and the flag flip restores the category with no data change.

**Amendment (2026-08-31, market borrowings): entries gain `added`, and optionally `tarball`; `denied[]` gains `replacement`.** `added` is the first-seen date (YYYY-MM-DD), recorded per name in `registry/first-seen.yml` — appended by the daily build, backfilled once from the `manifest.lock` git history — and a listed entry with no row, or a date later than the build date, throws (E9). The file is append-only, so the two names it accumulated before the bundle-name grammar existed — `{{NAME}}` and `{{PKG_NAME}}`, the only 2 of its 9,143 rows `isBundleName` now rejects — stay in it permanently; both are quoted, so the file still parses, and `isBundleName` stops a third from ever arriving. A release-rescued entry — a `requires-build` repo whose latest GitHub release carries a prebuilt tarball — carries `tarball: { url, sha256 }`: `version` = the release tag, `integrity` = the tarball's sha256, and the entry installs from the URL (§7.2). `denied[]` gains optional `replacement` naming a known substitute, and the denial detail reads "Denied by the registry: \<reason\>. Known replacement: \<name\>."

**Amendment (2026-09-01, harness compatibility): entries gain an optional `peers` field.** `peers` is an array of the package's declared `peerDependencies` names; present only when the package declares any. **Amended 2026-09-03: it is emitted at every schemaVersion.** `PEERS_SCHEMA_VERSION` and `SHOP_CATALOG_V6` are removed — the field is additive and an older client's non-strict zod strips it, so the gate was never a compatibility one, and bumping the emitted version to 6 would have thrown in every client capping at 5 for a field those clients ignore. `CATALOG_SCHEMA_VERSION` remains 5. The reasoning and implementation details are in `docs/design/2026-09-01-harness-compatibility.md` (§2).

**Amendment (2026-09-07, published reports): `/v1/report.md` and `/v1/classification-report.md` join the artifact list.** The build report is where a rejection's author-readable `detail` reaches the author it is written for, and it was reachable only as a zipped CI artifact on the workflow run — so "every rejection carries a reason" described a file its reader could not open. Upstream discussion #5867 is the demonstration: a plugin author searched the build metadata for their own scope, found nothing, and concluded the harvest could not see their packages. One of the six had in fact been harvested and rejected as `no-repository`, with an accurate reason they had no way to read. Neither report is content-addressed and neither is named by the pointer: those properties exist to keep the plugin data hash cache-stable, and a report regenerated every build and fetched by name buys nothing from either. The npm catalog package does NOT carry them — nothing reads a 1.7 MB markdown table out of a tarball — so `pages-artifacts.ts` now states the machine-readable set once and each transport's extras beside it, rather than deriving one list from the other. `/v1/harvest.json` stays unpublished permanently: it is the internal `classify.ts` -> `build.ts` handoff, 4 MB of raw candidates carrying unvalidated `dsh.catalog` values, escaped for no reader. Publishing the classification report also promoted its escaping to a published-surface concern, which it did not meet — it hand-rolled a `|` escape and a newline collapse on the discard reason and left the package name untouched — so both reports now share `emit.ts`'s `escapeCell`.

## 7. Data flow

### 7.1 Catalog build (daily and on PR)

```
harvest -> fetch manifest -> classify -> gate -> tier -> emit -> commit snapshot
```

1. **Harvest** — `registry.npmjs.org/-/v1/search?text=keywords:<keyword>`, paged per keyword (`dsh-plugin` and `deepseek-harness`), the two name sets unioned, deduplicated, and sorted. **Harvest by keyword, never by name pattern**; a name pattern is trivially spoofed. A keyword search that cannot complete aborts the harvest — harvesting only the keywords that answered would silently shrink the candidate set.
2. **Fetch manifest** — for each candidate, read the latest packument's `dsh.bundle`, `dsh.catalog`, `version`, `dist.integrity`, `repository`, `license`, and `deprecated`.
3. **Classify** — derived listings without a declared category and without a row in `categories.yml` are classified in batches by the LLM gateway (`classify.ts`, shell); failures leave the entry as `other` and are retried next build.
4. **Gate** — every rejection must leave an **author-readable reason** in the build report.
   - No `dsh.bundle` — a library, not an installable plugin. Rejected. Same criterion as the CLI's "declares no dsh.bundle" warning.
   - `dsh.catalog` present but failing schema validation. Rejected. A missing section is **not** a rejection — it produces a derived listing (§6.1).
   - Neither `dsh.catalog` nor an npm `description`. Rejected as `no-summary`: there is nothing to show.
   - Listed in `denied.yml`. Rejected.
   - Marked deprecated on npm. Rejected.
   - No license or no repository. Rejected. This is not fastidiousness: without a repository the package cannot be audited, and a plugin that wants to be listed has no reason to hide its source.
   - A repository naming `deepseek-ai/deepseek-harness` itself. Rejected as `harness-repository`. The host project's repository holds none of the plugin's source, so it audits nothing; the author has copied boilerplate and must declare the plugin's own repository. It is also what would keep a harness-bundled plugin off the shelf if one ever declared a harvest keyword (§2); the packages that ship with dsh today declare none, so they are never harvested and this rule never sees them.
   - Levenshtein distance to any name in `verified.yml` is between 1 and 2 inclusive — **held for human adjudication** (into `denied.yml`, or cleared into `allowed-similar.yml`), never auto-listed. This is the typosquatting gate. The threshold of 2 is a starting point tunable against the observed false-positive rate; changing it touches a constant and its test, not the process.
5. **Tier** — intersect with `verified.yml`.

   > **verified pins a version. It never attaches to a name.**

   `verified.yml` records `{ name, repo?, reviewedVersion?, reviewedCommit?, reviewedSha256?, reviewer, reviewCommit, notes }`. Exactly one pin is present, and it selects the channel: `reviewedVersion` is an npm review and carries no `repo`; `reviewedCommit` and `reviewedSha256` are github reviews and MUST carry `repo`. If npm's latest exceeds `reviewedVersion`, the entry is **downgraded to `verified-stale`**, and the UI shows "reviewed v1.2.0 / current v1.3.0 unreviewed".

   **Amendment (2026-09-03, audit B-2 / B-3 / A-4): a github review binds `(repo, commit)`.** The review index is keyed by the identity the review covers — an npm review by its package name, a github review by its lowercased `owner/slug` — and `assignRepoTier` looks a review up by repository, never by bundle name. A bundle name is not an identity: 83 live bundle names are claimed by both a fork and an original, and `dsh-skill-manager` by 14 repositories, so a name lookup gave `bob/dsh-repo-plugin` the tier, the reviewer's name and (at the reviewed commit) the skipped acknowledgement that a human had written about `alice/dsh-repo-plugin`. Two repositories sharing a bundle name may each hold their own review; a second review of the same repository still throws. The reviewed repository is also **exempt from the typosquatting hold**, which previously rejected the very repository a human had reviewed as an impersonator of itself; every other repository carrying that bundle name is still held.

   **Amendment (2026-09-03, audit B-1): the npm pin is exact.** The rule was "if npm's latest exceeds `reviewedVersion`", which only downgraded newer versions: `latest=1.1.0`, `latest=0.0.1` and `latest=1.2.0-rc.9` against `reviewedVersion=1.2.0` all rendered `verified`, and the Host skips the install acknowledgement for `verified` alone. A `latest` behind the review is what a hotfix published without `--tag` produces and what an unpublish leaves behind. All three pins now compare by equality — version, commit, tarball sha256 — so the invariant reads the same on every channel: **`verified` means this exact artifact was read by a human, and nothing else.**

   Most markets attach verification to a package name, which means an author who passes review can then publish a malicious version and inherit the trust automatically. That is the cheapest supply-chain attack available.

   **Amendment (2026-08-31, market borrowings): a release-rescued entry is pinned by `reviewedSha256`** — the reviewed tarball's content hash, never the tag: a GitHub tag is a mutable ref an author can delete and re-create on different content, and a tag-name pin would let verified trust inherit across unreviewed content. The tag stays the entry's displayed `version`; any other tarball sha256 downgrades the entry to `verified-stale`, keeping the review.
6. **Stars** — GitHub GraphQL fetches star counts for github.com repositories into `dist/v1/stars.<sha>.json`; failures publish without stars and retry next build (`github-stars.ts`, shell). **Amendment (2026-08-31):** repo star counts ride the topic search — every enumerated item carries `stargazers_count`, and the daily run pages the entire pool regardless of the fetch budget, so repo entries (and any npm entry whose repo the search saw) take the search count and cost no GraphQL quota; GraphQL covers only the repos the search did not see, which keeps it inside the PAT's 5,000-point hourly quota. Search-derived counts still land in the daily sidecar, never in the committed harvest memory (`repo-state.json`), and they survive a GraphQL failure — partial stars beat none. An npm entry whose repository names the harness itself gets no count at all: the harness's own stars are never attributed to a plugin that merely copied the host project's repository boilerplate.
7. **Emit** — sort by package name for determinism, breaking ties on the rest of the install identity (`source`, `repo`, `subdir`) so the output can never depend on the order npm or GitHub answered in; rejections sort by `(name, code, detail)` for the same reason. Produce `plugins.<sha256>.json` and `index.json`, and stage the publishable set — the data files, the badge endpoint and both build reports (§6.2) — into the directory Pages deploys. The reports are uploaded as run artifacts too; that upload is the belt, not the trousers.

   **Amendment (2026-09-03, audit C-2 / C-6):** the name alone is not a key. 172 live bundle names over 451 entries were claimed by several repositories on the day this was written (`dsh-skill-manager` by 14; 177 over 461 on 2026-09-06 — the figure is kept and re-derived in `validateInstall`'s docstring, not here), and a name-only sort left those ties to input order — reversing the repository harvest changed the content hash, `manifest.lock` and `index.json`. A shadowed repository is likewise reported by its `owner/slug#subdir` unit, matching the repo gate, so a monorepo's shadowed subpackages are distinguishable rows.
8. **Commit the snapshot** — write `manifest.lock` (name -> version -> integrity) back into `registry/snapshots/`.

   **This step is the entire value of this approach over a server.** Without it, the design degrades into an opaque service that happens to run on CI.

### 7.2 Install flow

```
Browser                     Host (ShopGateway)                  Subprocess
  | shop/installStart {name, version, acknowledged?}
  |----------------------------->|
  |                              | 1. check the Host's cached catalog snapshot
  |                              |    absent           -> not-in-catalog
  |                              |    denied           -> denied
  |                              |    version mismatch -> version-mismatch
  |                              | 2. the profile already holds this NAME,
  |                              |    from something else -> name-taken
  |                              | 3. tier != verified and !acknowledged
  |                              |                     -> needs-acknowledgement
  |                              | 4. spec = `${name}@${version}` (pinned)
  |                              | 5. take the per-profile mutex
  |<---- { installId } ----------| 6. spawn dsh plugin --profile <p> add <spec>
  |                              |--------------------------------->|
  |  poll shop/installStatus -->|<-------- stdout/stderr ----------|
  |<---- { state, log[] } -------| 7. exit 0 -> re-read the manifest, confirm
  |                              |         dsh.profile.bundles changed, and
  |<---- { done, needsRestart } -|         no loader entry id now collides
```

**Amendment (2026-09-07, name-taken): a profile holds one plugin per name, and the gate says so before the acknowledgement.** Step 2 is new. The shop writes `dependencies[name]`, so installing a second plugin of a name overwrites the first and the plugin the user chose is gone with no notice — 177 live catalog names are claimed by more than one entry, `dsh-skill-manager` by 14. The gate refuses unless the manifest's spec names this very install; a same-identity request is the ordinary update path. It sits ahead of step 3 so a request that cannot proceed never asks the reader to accept a plugin's privileges first.

The spec is attributed positively — a version or range is npm, the two GitHub forms are a repository — and **a spec the grammar does not cover is a third answer, never npm.** Reading `git+ssh://`, `file:`, `link:`, `workspace:*` or `npm:other@1` as npm made the gate pass them (an npm-vs-npm comparison is unconditionally "same"), so pnpm overwrote git remotes, working checkouts and aliases to other packages entirely; and read the other way it published "already installed from the npm package X" about a local directory. Those are refused now, quoting the spec.

The client refuses in the same breath, on the same input: `shop/installedSpecs` returns the manifest's dependency map — the gate's own argument — and the card runs the same `specVerdict`. It cannot be derived from `shop/installed`, which drops any dependency no catalog entry matches; a fork, a hand `dsh plugin add`, or a delisted holder is invisible there while the gate still refuses over it.

**This is NOT the loader's rule, and the two must not be conflated.** Same-named forks frequently declare different entry ids and would coexist fine — `Anyway-one/dsh-balance` declares `id: balance`, `ZHIZHU4410/deepseek-balance` declares `id: dsh-balance`. The loader's own constraint cuts the other way: two DIFFERENTLY-named bundles declaring one entry id make dsh refuse the whole tree ("duplicate loader entry id") and the profile does not boot — `2768651338/dsh-plugin-manager` and `Dingpenghui-good/dsh-plugin-manager` both declare `id: plugin-manager`, share no manifest key, and pass step 2. A candidate's ids are unreadable until its files are on disk, so that check moved to step 7, where it fails the install with the id, the package holding it, and the command to undo. It has to be caught there or not at all: `hotMount` prefixes its rows `mkt-`, so a colliding install reports done, works for the whole session, and kills the next boot with nothing connecting the two events.

Implementation decisions:

- **Pin the version.** The spec is `name@version`, not `name` and never `^version`. The user clicked a version in the snapshot; that is what must be installed.
- **Spawn rather than reimplement.** dsh's own `stdio: 'inherit'` inherits the pipe we provide, so streaming logs come for free with no upstream change. The orchestration — init, pnpm, reconcile — lives in `runPlugin` in `apps/cli/src/plugin.ts` and is **exported from no package**; `dsh-app-boot` exports only the primitives. Copying the reconcile loop would drift, and its "by installed state, not by dependency diff" semantics are subtle enough not to duplicate.
- **Poll for progress rather than push.** `API_REMOTE_FORWARDED_EVENTS` is a hardcoded in-repository array, so an out-of-tree plugin cannot push events to the browser. `shop/installStart` returns an `installId` immediately and the client polls `shop/installStatus` once per second. A side benefit is that it survives a page reload.
- **Serialize per profile.** pnpm locks itself, but its concurrent-access errors are unreadable to a user. One mutex per profile on the Host side.
- **Never roll back automatically.** After a pnpm failure `dsh.profile.bundles` is still consistent, because reconcile runs only on exit 0, but `dependencies` may already have been rewritten. The response is to surface stderr verbatim and suggest `dsh plugin --profile <p> install`. **Automatically rolling back a package manager's intermediate state breaks environments more often than leaving it alone.**
- **The shop never writes `allowBuilds`.** pnpm 10 and later block build scripts by default, which is a security property obtained for free. A plugin that needs a build script simply cannot be installed from the shop; the UI says so plainly and prints the CLI command.
- **Amendment (2026-09-02, Windows): the Host resolves the dsh CLI's JS entry and spawns node, never the npm shim.** "Spawn rather than reimplement" above assumed the CLI is spawnable by name. On Windows it is not, and the shop was therefore inoperable there — every install, uninstall and self-update failed. npm installs the CLI as `dsh`, `dsh.cmd` and `dsh.ps1` with no `.exe`; libuv resolves a bare name against `.com` and `.exe` only, and node has refused to spawn a `.cmd` without a shell since the 2024 batfile argument-injection fix. Measured on Windows 11 with dsh 0.1.1-rc.2 (2026-09-02): the bare name gives ENOENT — reported by a user as "Update failed / dsh not found on PATH" on a working install — and the resolved shim throws EINVAL **synchronously** out of `spawn()`, which the executor now catches, because an uncaught one rejected a promise nothing awaits and left the install polling as `running` forever. **`shell: true` is refused on purpose**, even though it is what the shim exists for and what dsh's own pnpm spawn uses: node hands cmd.exe a joined, unquoted command string, and our argv carries catalog data — a `github:` entry's spec is `github:owner/slug#<sha>&path:<subdir>`, `&` is a cmd command separator, and `subdir` comes from npm (§9.1). Instead `dsh-cli.ts` locates the `@deepseek-ai/dsh` package's declared `bin.dsh` — first through the package that owns `process.argv[1]`, which guarantees the child is the same dsh serving the shop, then through the shims' `node_modules` on PATH — and runs it with `process.execPath`. No shell is involved, so node escapes the argv itself. Non-Windows behavior is unchanged, and a `dshBin` naming a specific file is still spawned as given. One consequence stays open: dsh's own `spawnSync('pnpm', …, { shell: true })` puts that same `&`-bearing spec through cmd.exe, so `github:` and `tarball` installs remain unreliable on Windows until that is fixed upstream (§13); plain `name@version` specs, including the shop's own self-update, are unaffected.
- **Amendment (2026-09-07, release-asset verification): the rescue must be the package it rescues.** The rescue is the one channel where an entry's declared identity and its installable bytes come from two artifacts — the name, the `dsh.bundle` and the `requires-build`/`workspace-deps` waiver all come from the repo TREE, while the code comes from a hand-uploaded release asset. Nothing checked they were the same package. Every other channel reads its name from the thing it installs: an npm entry's name IS its packument key, and a commit-pinned repo entry (subpackages included) reads the manifest out of the tree pnpm fetches. Measured against the 2026-09-06 catalog, **every rescued entry that failed that premise was unusable** — the install put a different package in the profile (or one declaring no bundle, or a Python sdist), the declared bundle never landed, and the post-install confirm failed, so filtering them removes nothing installable. The count and its denominator are kept in `release-asset.ts`'s header and deliberately not restated here, the way this file already defers the harvest keyword totals to `npm-client.ts`. `@dsh-external/dsh-super-injector` shipped a packed `@dsh-external/dsh-graded-mode`; `cc-dsh-notifier` shipped `@baobaolaodie/cc-dsh-notifier`, a different manifest key; `get-fable`'s asset is correctly NAMED — a filename check clears it — and is a 45-directory repository snapshot rather than a packed package, so no root manifest of its own is readable; `dsh-message-finder`'s is correctly named and declares no `dsh.bundle` object, walking past the `no-bundle` rule that exists to kill a silent no-op install. (An earlier draft attributed the missing bundle to `get-fable`. That came from auditing the catalog with the SAME first-matching-manifest heuristic that was the defect in the code, which read an arbitrary member of its snapshot; the live dry run corrected the measurement along with the implementation.) `verifyReleaseAsset` now reads the packed `package.json` out of the bytes the probe already holds for its sha256 and requires `name` to equal the bundle name and `dsh.bundle` to be present; a filename check was rejected as the rule because it both false-positives (`@crosery/dsh-drop` ships a correct `dsh-drop.tgz`) and false-negatives (`get-fable`). A refused asset simply does not rescue, so the entry keeps the `requires-build` / `workspace-deps` rejection it arrived with — but that reason now carries WHY, because both of them advise attaching a release tarball and the author who did attach one would otherwise be told to go and delete a working build script. No new rejection code: the reason rides the `detail`. Both reasons can carry it because the probe now runs for `requiresBuild || hasWorkspaceDeps`: a repo with `workspace:` specifiers and no prepare/prepack was never release-probed at all, so an author who followed that very advice and attached a correct tarball got no rescue and no explanation. The asset must also be PREBUILT, which is tested the only way it can be: the `dsh.bundle.patch` the manifest declares must be IN the archive, and `workspace:` specifiers must already be resolved (`pnpm pack` rewrites those). **Refusing on the presence of a `prepare`/`prepack` script is NOT that test and was reverted** — `npm pack` runs those scripts, ships the built output and leaves the scripts in the manifest, so a live dry run refused 90 working entries that all carry compiled output beside the script, and pnpm does not run them for a tarball install anyway; the patch-target rule refuses the incomplete pack it was aimed at and delists none of the 169 entries the other rules accept (measured) — and it must hold exactly one top-level directory, because npm and pnpm extract with `strip: 1` and the LAST root wins on disk, so reading the first manifest verified one package while pnpm installed another.
- **Amendment (2026-09-07, patch targets): the patch file shipping is not the modules it names shipping.** The prebuilt test above requires the declared `dsh.bundle.patch` to be IN the archive. That is necessary and not sufficient: the patch is a committed config file, while the modules it inserts are build output. `@open-design/dsh-runtime` is the shape that separates them — it commits `cordis.patch.yml`, gitignores `dist/` (the repository's root `.gitignore` line 2, and its esbuild config writes there), and declares no `prepare`/`prepack`, so an archive can pass every other rule here and still insert two entries that resolve, through its own `exports`, onto files nothing would ever contain. So each `insert` row's `name` is now resolved: a name equal to the bundle name means subpath `.`, a name under `<bundleName>/` means that subpath, and the manifest's `exports` (or `main`) is followed to the set of targets the loader could select — the entry is refused only when NONE of them is a member of the archive. **A set, not a pick, and the PR #22 review is why.** The first implementation chose one target by a fixed `default`/`node`/`import`/`require` scan, resolved a `main` as an exact filename, and compared an `exports` target as a literal string; each of those refused an asset that imports successfully in real Node (reproduced on v22 for all three): Node matches conditions in the object's own DECLARATION order, so `{ node: './dist/node.js', default: './dist/browser.js' }` loads `dist/node.js` while the scan read the absent `dist/browser.js`; `main` carries extension and directory-index lookup, so `main: './dist/index'` and `main: './dist'` both load a shipped `dist/index.js`; and an `exports` target is a relative URL, so `./dist/my%20plugin.js` IS the shipped `dist/my plugin.js`. Modelling Node's algorithm exactly would mean deciding whether the install resolves as ESM or CJS, which the archive does not say — so collecting every reachable arm and refusing only when none ships is deliberately WEAKER than that algorithm, and errs the one safe way: it can miss a defect, never invent one. That also makes the scan order irrelevant rather than merely corrected. `types`/`typings` are the one exception, excluded because a type declaration is not something the loader can run — without that, a `.d.ts` alone would excuse a missing runtime module under the same rule. What it deliberately does NOT refuse is the larger half of the rule, because the one guess this check's neighbour made in the confident direction delisted 90 working entries: a name belonging to ANY other package (a patch legitimately inserts its peers' modules), a wildcard target, a subpath an `exports` map does not list, a deep subpath with no map to resolve it, a `..` escape, an entry point the author declared nowhere at all, a non-string `name` the loader would not take, an unparseable patch, and a patch past a 1 MB cap — every one of those is an unanswered question rather than a proven defect. The `types` condition is skipped for the same reason: a pack that omits its `.d.ts` still loads, so refusing over one would be a true statement about the archive that is not a reason the plugin cannot run. The reader is NOT the shop's `parseSimplePatch`: that answers "can a hot tree replicate this?" and returns null for a row carrying config, a bare targeting row, or a key beyond the id/name pair — all three appear in the very patch this rule was written for, so a conservative null there is correct for hot mounting and useless here. **Scope limit, stated because it is easy to assume otherwise: this hardens the release-rescue channel ONLY.** A commit-pinned repo entry has no archive to read, and `@open-design/dsh-runtime` is exactly that — `requiresBuild` is computed from `prepare`/`prepack` presence (`github-client.ts`), both of which it lacks, so it is never release-probed and this rule never sees it. It remains listed. Closing that requires a different mechanism against the repo tree, and the entry's own cost profile argues for one: 151 MiB must cross the wire (measured, GitHub codeload at the pinned commit; 253.2 MiB / 11,702 files unpacked) to obtain a 36.6 KiB / 13-file subpackage, because `&path:` is applied after the fetch and neither git nor codeload can deliver one subdirectory.

- **Amendment (2026-08-31, market borrowings): a release-rescued entry installs the prebuilt tarball URL.** For an entry carrying `tarball`, the spec is the snapshot's tarball URL — built from snapshot fields, never from the wire — instead of the `github:` form, and the git-on-PATH check does not apply. The Host validated the binding at catalog parse (a coherence check on both the cached and the fresh path): the URL must be an https release of the entry's own `repo`, so a row naming a trusted repo can never install an archive from elsewhere. The recorded tag is the displayed `version`. The sha256 is enforced at install: the Host fetches the tarball and verifies its bytes against the recorded hash before spawning, refusing with a typed `tarball-integrity` rejection on a mismatch or an unverifiable download — GitHub release assets are immutable per URL, but the check also catches passive MITM and asset tampering at the check instant. The install itself re-fetches through pnpm, so an asset swapped between the check and pnpm's fetch remains a TOCTOU window.

### 7.3 RPC contract

| Method | Arguments | Returns |
|---|---|---|
| `shop/catalog` | `{ refresh?: boolean }` | `{ schemaVersion, builtAt, stale, plugins[] }` |
| `shop/installStart` | `{ name, version, acknowledged? }` | `{ installId }` |
| `shop/installStatus` | `{ installId }` | `{ state, log[], needsRestart? }` |
| `shop/setEnabled` | `{ name, enabled }` | `{ ok }` |
| `shop/uninstallStart` | `{ name }` | `{ installId }` |
| `shop/restart` | none | `{ ok }` |
| `shop/version` | none | `{ installed, latest, outdated, restartSupported }` |
| `shop/updateStart` | `{ version }` | `{ installId }` |
| `shop/installed` | none | `{ name, installed, latest, outdated }[]` |
| `shop/installedSpecs` | none | `Record<name, spec>` or `null` |

**Amendment (2026-08-25): the install method is `shop/installStart`, not `shop/install`.** The web full-flow e2e against the real composition exposed that the client api's `RemoteNamespaceService` owns a method named `install` (its internal mount primitive), so a Remote namespace cannot expose one: mounting `shop/install` throws "method \"shop/install\" conflicts with its namespace service". The wire method is renamed to `shop/installStart` (pairing with `shop/installStatus`); the client-visible injected face keeps the name `install`, and the host-side code method is unchanged — only the wire name differs.

**Amendment (2026-08-25): a client package that mounts its own Remote must consume it through the reflect shop, not the inject face.** The same e2e exposed that `ctx.remote.<ns>` refuses a namespace to a fiber whose inject face does not name it ("cannot get property remote.shop without inject"), while naming it in the face deadlocks the boot's activation gate: the gate waits for `remote.shop` to be provided, and only the package's own apply — which the gate is holding back — can mount it ("pending (waiting for service: remote.shop)"). The client half therefore reads the mounted namespace via `ctx.get('remote.shop')`, the reflect shop's documented inject-free read, after `$mount` settles. Third-party client packages that self-mount should follow the same pattern.

**Amendment (2026-08-27): `shop/outdated` is reshaped into `shop/installed`, which returns every installed catalog entry with an `outdated` flag.** The tab's shelf cards need the full installed set — not just the behind-version subset — so the card for an installed plugin shows its installed state (or the update button when behind) instead of an install button. The outdated section and the card state both derive from this one list; the semver comparison stays on the Host, and the client never does version math.

**Amendment (2026-08-27, follow-up): `shop/uninstallStart` joins the RPC surface, the shelf gains an Installed filter, and installed cards carry uninstall.** Removing a plugin revokes privilege rather than granting it, so uninstall sits inside the §9.1 Client-half threat model (the five-method boundary becomes six); the RPC validates the name against the catalog snapshot and the installed manifest, so it cannot remove profile dependencies the shop does not manage (the base bundle, the shop itself). The category bar gains an Installed button that filters the shelf to installed plugins; installed cards show the update button (when behind) plus an uninstall button, replacing the bare installed label. The "Plugin catalog" heading is dropped — the bar and stats carry the context.

**Amendment (2026-08-27, follow-up): self-update.** The shop shows its own running version right of the search box (read from the shipped package.json), checks npm for a newer release on mount/refresh and on demand via a check button next to the version, and offers an update button when behind. `shop/version` reports `{ installed, latest, outdated }` with `latest` degrading to null when the registry cannot answer (advisory, like the stars sidecar); `shop/updateStart` runs the pinned `dsh-plugin-shop@<version>` spec (the only install form that bypasses pnpm's release cooldown) through the same executor, records, and polling as installs, with the version re-validated as plain semver at the boundary. The Client-half boundary becomes nine methods. Right of the version row sits a constant link to the project's GitHub repository, rendered as the octocat mark with an aria-label — a static URL, independent of the advisory check, so it stays visible when the version check has no answer.

**Amendment (2026-08-30): every shelf card shows its version.** The badge row leads with a quiet `v{x.y.z}` (the short commit for repo entries). The version is catalog data rendered as text, never as a spec. The expanded detail once repeated it as a version row; the duplicate was dropped (2026-08-30, follow-up) — the badge row is the single display.

**Amendment (2026-08-30, follow-up): the shelf renders one full-width card per row.** The shelf is a single column; each card holds four lines: the badge row (name truncating, category chip, version, tier, stars, octocat for repo entries), the clamped two-line summary (en + one-line zh; expanding lifts the clamp), the action line (install/update/uninstall), and — when expanded — the capabilities and the detail section (repository, license) below. The cover block is gone: the category chip in the badge row carries the hue. An active install or uninstall flow (gate, log, notices) takes the full width under the action line. The loading skeleton matches the same single-column, four-bar shape so the swap to content is a same-shape handoff.

**Amendment (2026-08-30, follow-up): the github direct-install channel** (design: 2026-08-30-github-install-channel.md). The harvest gains a second, parallel pool: GitHub repositories carrying the `dsh-plugin` or `deepseek-harness` *topic*, projected into repo candidates whose unit is `owner/slug` and whose version is the pinned default-branch commit. The repo gate re-expresses the npm rules: `package.json` present (`no-manifest`), `dsh.bundle` declared (`no-bundle` — the rule that kills the silent no-op install pnpm otherwise performs), a license, something to show, the denylist by repo or bundle name, and the typosquatting hold probing the slug and the bundle name. Entries carry `source: 'npm' | 'github'` and `repo`; npm wins when a repo's bundle name already ships as an npm package (`shadowed-by-npm`, with a reason). `schemaVersion` becomes 3; the client release precedes the flag flip so no live catalog serves v3 to a client that cannot parse it. On the install path the RPC invariant holds in its repo form: `shop/installStart` takes the bundle name and the commit, and the Host builds `github:owner/slug#commit` from snapshot fields — never a client string; git is NOT a precondition (**amended 2026-09-02**: the `git-missing` pre-flight was removed — pnpm resolves `github:` specs through GitHub's tarball endpoint, verified with git stubbed on pnpm 9/10/11 and end to end through `dsh plugin add`, so the check closed 61% of the catalog on git-less machines for a dependency the install does not have); the post-install bundle confirmation still applies. Because pnpm records `github:owner/slug` in the manifest without the commit, the Host persists its own install pins in its cache, and `shop/installed` compares the pin to the catalog commit for `outdated`. `verified` pins a `reviewedCommit` for repo entries and goes stale when the commit moves — trust never inherits across unreviewed commits. The client shows repo entries with an octocat badge and the short commit, and the shop-like filter probes the repo slug. The topic pool is heavily polluted — the gate rejects the ~80% of topic-carrying repos that cannot install or register — so count follows gate, never the raw pool. The pool is enumerated through mutually exclusive search windows (stars × created-day × size) because GitHub caps every query at 1,000 results, and a committed `repo-state.json` makes the manifest fetches incremental: only new or `pushed_at`-changed repos refetch each run, up to a per-run budget while the backfill fills (2026-08-31 amendment). A repo whose manifest declares a `prepare`/`prepack` build script is rejected with `requires-build`: a git install requires running it, pnpm blocks it by default, and the shop never passes build-script flags, so the entry could not install through the shop — install spot-checks (11/12, then 45/50 sampled entries succeeded; four of the five failures were exactly this class, the fifth a transitive postinstall script) made the rule empirical.

**Amendment (2026-08-31, follow-up): the hub borrowings** (design: 2026-08-31-hub-borrowings.md — A/B/C adopted, D dropped). (A) **Monorepo subpackage expansion**: a repo whose root manifest declares no bundle but signals a monorepo (`private: true` or a `workspaces` declaration) is probed once — tree listing, then up to eight subpackage manifests — and bundle-carrying subpackages become entries with a `subdir` field; the install spec becomes `github:owner/slug#commit&path:<subdir>` (pnpm-verified; dsh passes specs verbatim), and a subpackage with `workspace:`-protocol dependencies is rejected with `workspace-deps` (measured: it cannot resolve outside its own workspace). Rejections for subpackages name `owner/slug#subdir` — the unit an author fixes. `schemaVersion` bumps 3→4 behind `SHOP_HARVEST_SUBPACKAGES`, flipped in the release commit that ships the v4 client, so a v3 client (which would misinstall the monorepo root) never meets a `subdir` entry. The harvest memory's shape moves from a singular `candidate` to a `candidates` array plus an optional recorded `failure` for deterministic `no-manifest` outcomes — known dead ends stop re-consuming the per-run fetch budget (measured: they re-fetched forever, and the probe would have multiplied the cost); the old shape still parses. (B) **Installed-plugin toggle**: `shop/setEnabled` writes the user patch layer through the framework's own parser (whole-row-list rewrite via `loadOptionalPatches` + dump); `shop/installed` carries the inventory's `enabled` per row (absent service ⇒ enabled); the switch renders on every installed row, initialized from the real state; the shop's own row and `@deepseek-ai/*` bundles are never toggleable. (C) **Registry failover**: the harvest's npm fetches fall back to a backup registry (default `registry.npmmirror.com`, `NPM_BACKUP_REGISTRY` to override) on network throw, per-attempt timeout (AbortSignal), and 5xx — never on a 404 (authoritative) or an exhausted 429; when the backup also fails, the primary's failure is what propagates (**amended 2026-09-03**: scoped to the packument fetch only — registry.npmmirror.com does not implement the `keywords:` qualifier the harvest's search depends on, measured 2026-09-03 as `{"objects":[],"total":0}` for both harvest keywords, so the search never receives a backup argument; `searchByKeywords` still accepts one, unused by both production call sites). Fetch-only: installs keep running through the user's own pnpm and registry config, and the integrity pinning makes a mirror answer interchangeable.

**Amendment (2026-08-31, market borrowings C-1): `shop/version` gains `restartSupported`, and `shop/restart` gains a supervisor refusal.** `restartSupported` is false when a systemd unit owns this process — detection requires both signals: `INVOCATION_ID` or `JOURNAL_STREAM` present, and ppid 1, since the markers alone are inherited by every descendant of a unit, an ordinary terminal included — and the shop row config sets no `allowRestart: true` override. The client hides the restart offer on false and keeps the pending-change notice, naming the manual restart. `shop/restart` refuses in the same typed `{ ok: false, detail }` shape as the `--port 0` refusal, before anything is torn down: under a systemd unit the two-phase handoff kills itself — the main process exiting also kills the unit's cgroup, taking the detached helper with it, and the service never comes back.

**Amendment (2026-09-08): `keywords:deepseek-harness` has outgrown npm's search window, and the refinement list is no longer a fix — only a delay.**

The npm search API reaches 5,250 names per query (`from` capped at 5,000; re-verified live 2026-09-07 — `from=5000` serves a distinct tail, `from=5100` and above return page 0). `keywords:deepseek-harness` measured 5,401 on 2026-09-07, so **151 names sit beyond any single query's reach**, and the daily `build` job went red on every tree, `main` included, because the harvest refuses to publish a silently-short catalog.

Three axes were probed for a covering alternative and none exists:

- **Ranking weights are inert.** `quality`/`popularity`/`maintenance` leave the result identical at every position, head and tail (250/250 same-position, three weightings). They cannot re-slice what is reachable.
- **No negation qualifier.** `keywords:a,b` is an intersection and the only filter the API honors, so a cell's complement cannot be expressed and a refinement partition is never covering by construction.
- **No unwindowed index.** The CouchDB `byKeyword` view is gone (404), npms.io is dead, and ecosyste.ms ignores its own `keyword=` parameter (returns packages carrying none of it).

The immediate residual was closed the documented way — one refinement keyword, `deepwatch`, verified live to take the union from 5,394 to 5,400 of 5,401. **But the arithmetic says this is a treadmill.** The overshoot grows about eighty-three names a day (5,132 → 5,380 over three days), three times the rate the code previously recorded, and the residual is the uncovered fraction of it. (**That last inference is corrected by the follow-up amendment below** — the residual is a step function, not a drift. It is left standing here because this section is the record of what the failure looked like at the time.) Uncovered-ness concentrates exactly where the unreachable names are: sampled 2026-09-07, 2.8% of ranks 5,000–5,250 carry no refinement against 0.0% mid-ranking. The seven that broke this build were one publisher's scoped family, published together, ranking together at the bottom, carrying a private tag. The next such family reopens the gap, and a human extending a list per incident does not keep up with a daily residual.

The structural options each change what the shop publishes or how loudly it fails, which is why they are recorded here rather than decided in a constant's comment:

1. **Scale the tolerance to the measured overshoot.** The harvest can prove that `total − SEARCH_WINDOW` names are unreachable by any query and that the cells recovered all but *r* of them. Tolerating a small *r* — reported by name-count in the build report — is honest about a limit of the API rather than a defect in the partition, and it cannot hide a partition collapse, since that would crash the recovery rate. It does mean **knowingly publishing a catalog a few packages short**, which is a change to the "throws rather than truncating" invariant and needs to be stated as one.
2. **Derive the refinement vocabulary from harvested packuments.** The harvest already reads every candidate's `keywords`; persisting that vocabulary and using the most-covering tags as cells makes the list self-maintaining. It shrinks the residual without a human in the loop but is still not covering: a package whose only tag is the harvest keyword, ranking beyond the window, is unreachable by any AND.
3. **Drop `deepseek-harness` from `HARVEST_KEYWORDS`.** Keeps the invariant exactly, at the cost of every listing that carries only that tag.

Until one is chosen, each crossing costs a red build and a hand-measured refinement.

**Amendment (2026-09-08, follow-up): the wall measured, and two of the premises above corrected.**

The amendment above was written from the failure. This one is written from probing the API directly, and it moves two facts.

*Corrections.*

- **`maintainer:` IS a filter, and it composes with `keywords:`.** "The only filter the API honors" is wrong. Measured live: `keywords:deepseek-harness maintainer:<nonexistent>` returns **0**, not the unfiltered total, and `maintainer:bowenliang123` returns 2 alone and 2 intersected with the keyword. What genuinely is NOT honored — every one of these returns the unfiltered 5,407, i.e. no filtering at all — is `is:unstable`, `not:unstable`, `is:insecure`, `not:insecure`, `is:deprecated`, `not:deprecated` and `scope:`. So the "no negation" half stands, and "keywords is the only filter" does not.

  **What this does NOT buy, stated because the obvious inference is wrong.** Every package has a maintainer and not every package has a second keyword, so a publisher partition has no *structural* blind spot where a refinement partition does. That argues it should cover more. **Measured, it covers less**: seeded from the window's own 3,041 maintainers, publisher cells recover **95 of the 157** unreachable names (60.5%), against the shipped refinement list's **156 of 157** (99.4%). The structural advantage is real and the discovery constraint dominates it — a cell can only be queried for a maintainer already SEEN, and a single fat refinement (`keywords:deepseek-harness,dsh` alone recovers 123) reaches far more of the tail than the straddling condition a publisher cell needs. Publisher partitioning is therefore a **supplement aimed at a specific failure mode, never a replacement** — *for this keyword*. That qualifier is load-bearing and was missing when this paragraph was written: see the 2026-09-08 second-keyword amendment below, where the refinement list's 99.4% does not hold and the same axis is the only mechanism that reaches the residue at all.
- **The CouchDB replication database is alive.** `https://replicate.npmjs.com/` answers 200 with `doc_count: 4369123` and a working `_changes` feed. What 404s is the `byKeyword` *view*, which is a different object. The feed carries **165,689 changes/day** (measured over 91s of `update_seq` movement), so a provably-complete index is a real option with a real price, not an absent one — and that price is two orders of magnitude above the ~5,700 packument fetches an npm-side run costs today.

*What the wall actually is.* Not missing data. npm counts the unreachable names in the `total` it answers and simply will not address them: `from` is capped at 5,000 and `size` at 250, so only ranks 0–5,249 can be asked for. Worse than an error — **the API silently wraps**: `from=5100` and `from=5250` both return the FIRST page of the result set (verified: both answer `dsh-context`, rank 0). A harvester without the `from > MAX_SEARCH_FROM` throw would re-read one page forever and report success.

*The truncation is not random — it is biased against exactly what the shelf exists to surface.* npm ranks by score, so the tail is the lowest-scoring, which is the newest. Sampled 250 per position:

| ranks | median age | ≤7 days | >60 days |
|---|---|---|---|
| 0–249 | 5 d | 157/250 | 0/250 |
| 2500–2749 | 19 d | 27/250 | 0/250 |
| **5000–5249** | **3 d** | **222/250** | 0/250 |

Confirmed against `time.created` rather than the search `date` (which is last-publish): the tail sample was **created** 1–9 days ago, so these are genuinely new packages and not old ones recently touched. Nothing in 750 sampled packages was updated more than 60 days ago, so the whole keyword population is younger than two months and has grown at a roughly constant ~83–90 names/day since it existed.

*The residual is a step function, not a drift.* The obvious model — residual grows at the growth rate times the uncovered fraction — is wrong, and the live runs disprove it: total went 5,401 → 5,407 in a day while the union went 5,400 → 5,406, so the cells absorbed every one of the six new names and **the residual stayed at 1**. New packages mostly carry `dsh` or `dsh-plugin`, which existing cells already reach. What actually breaks the build is a *cluster*: one publisher releasing a family at once, ranking together at the bottom, sharing no refinement tag. That is the `sayedev` family of 20 (`keywords:deepseek-harness,deepwatch` is 20 names, all of them that one maintainer) which took the residual from 1 to 7 in a single day. **A tag-shaped recovery against a publisher-shaped risk is a category error**, and `deepwatch` closed the incident only because that family happened to share a private tag. The next one need not.

This is the whole case for publisher cells, and it is a narrow one: 14 of that family's 20 were already visible, so `maintainer:sayedev` was derivable from what the harvest had ALREADY read and its cell recovers all 20 — no human noticing a private tag, no list to extend. A refinement list cannot reach that family by construction unless someone adds the tag after the build has already gone red. So the two axes divide by what they are good at rather than competing: refinements carry the ordinary tail at 99.4%, publisher cells absorb the discrete family events that take the residual past any tolerance. The seed for the publisher axis should be every search result the harvest reads, not just the over-window keyword's window — `keywords:dsh-plugin` is fully enumerable today and contributes **349 maintainers the harness window never shows** (3,390 combined against 3,041) — and it should be PERSISTED across runs the way `repo-state.json` already persists repositories, so coverage accumulates monotonically instead of being re-derived each run from a window that is a shrinking fraction of the whole.

*The second keyword has about three weeks left.* `keywords:dsh-plugin` measured 3,731 on 2026-09-04 (recorded in D7) and **3,973 on 2026-09-08** — about 60 names/day against 1,277 of headroom, so it crosses `SEARCH_WINDOW` about **2026-09-29**. That is not merely a second keyword to partition: `dsh-plugin` is fully enumerable today and therefore contributes **349 maintainers the `deepseek-harness` window never shows** (2,256 of its own against 3,041 from the harness window; 3,390 combined). When it crosses, that free seed shrinks — at the moment it is most needed.

*Amendment (2026-09-08, second keyword): the refinement list is a hundred times weaker against it, and no refinement can fix that.* Because `keywords:dsh-plugin` is still fully enumerable, its coverage was measured before the fact rather than after the build went red. `PARTITION_KEYWORDS`' comment owns the figures; the conclusions are:

- The share of names carrying **none** of the 26 non-self refinements is 0.019% for `keywords:deepseek-harness` and **2.04%** for `keywords:dsh-plugin` — two orders of magnitude apart. The cause is a tag habit, not a coverage accident: `deepseek-harness` is almost always co-published with `dsh` or `dsh-plugin`, while `dsh-plugin` is the conventional plugin tag and is frequently the only one a package carries.
- The rate is worse at the bottom of the ranking, which is what a tail is made of: 4.4% over the lowest 250 ranks. That puts the residual at `MAX_UNREACHABLE_RESIDUAL` roughly **three to ten days after the crossing**, not months.
- **A refinement cannot close it.** Those packages carry `dsh-plugin` and mostly nothing else, so there is no second tag to intersect on — the mechanism `PARTITION_KEYWORDS` is has no move available. This is the first measured case where "add a keyword" is not merely a manual bill but structurally unavailable.
- The publisher axis reaches **all** of them: every one of the 81 carries at least one maintainer username inside the grammar, so against this axis the uncovered set has no residue — 0 of 81, against 81 of 81 for refinements. Concentration then decides only the cost: 38 distinct maintainers own them, the seven largest cells reach 51 (63%), and a full cover is 37 cells. The username must be read off `maintainers[].username` — `publisher.username` is the last publishing identity and can be a CI bot's display name (`GitHub Actions` for 12 of these), which `maintainer:` cannot address.

So the ordering in this section stands — publisher cells recover less of the *first* keyword's tail than refinements do — but the conclusion drawn from it does not generalise. For the second keyword the axis is not a supplement to a working mechanism; it is the mechanism. The plan in docs/plans/2026-09-08-publisher-partition.md therefore acquires a date it did not have when it was written.

**Root cause of the red build, stated separately from the fix: one constant carries two quantities that have opposite properties.** {@link MAX_SEARCH_SHORTFALL} was reasoned about, correctly, as a bound on npm answering a `total` it cannot serve — an overstated count, a 249-object page — and its own comment explains why it is 3 and not 15: "A partition gap is hundreds of names", so a looser bound would absorb a real gap silently. It now also has to absorb *unreachability*, which is a different animal:

| | race / overstatement | unreachable |
|---|---|---|
| magnitude | 1–3 | `total − SEARCH_WINDOW`; 157 today |
| growth | none | tracks the keyword, ~83/day |
| nature | noise; a re-page may close it | reported tail beyond one query's window |
| evidence | seen live: a window paged 5,247 of 5,250 mid-run | seen live: `enumerated 5406 of 5407` |

A bound sized for the first cannot hold the second, and a bound sized for the second hides a partition collapse — precisely what the existing comment refuses to allow. **So the two are separated before any partition work is done**, because every option in the amendment above needs the distinction and none of them supplies it. The harvest computes `max(0, required − SEARCH_WINDOW)` from the minimum of the probed totals, reports recovery against this single-window tail, and requires both a recovery rate of at least 90% and a residual of at most 10 names for gaps larger than the noise allowance. Every tolerated shortfall is reported.

The residual cap is bracketed, not chosen: **at least 9**, the headroom a publisher family needs, which must be absorbed rather than redden the build; and **under 15**, the size of the one real partition gap this repo has measured, which must never be absorbed.

The floor DECOMPOSES the `sayedev` residual rather than taking it whole, and the difference matters. That event read 7, but six of those names were the family past the window — the six `@deepwatch/*` packages `PARTITION_KEYWORDS`' comment names — and the seventh was the total climbing mid-run, i.e. count noise. Past the window `windowShortfall` is identically zero, so noise has no window term to land in and is charged to this cap instead of spending `MAX_SEARCH_SHORTFALL`'s own allowance. The same family arriving on a full noise allowance is therefore 6 + 3 = 9, which is the figure the cap has to clear rather than the 7 one day's reading showed.

It shipped at 25 on the reasoning that the family needed twenty-plus of headroom and that the two magnitudes were therefore incompatible — the family's cost is a residual of 9, so they are compatible, and 25 sat above the threshold the repo says must not be crossed. The rate floor cannot cover the gap in its place: a 0.9 floor permits a tenth of the tail, so a fifteen-name gap clears it from a 150-name tail up, and this keyword is well past that. **10 is the smallest value honouring both bounds, so the margin is asymmetric — one name below, four above.**

Two boundary conditions apply to that calculation. **Count/paging noise is independent of the window:** an aggregate shortfall of at most `MAX_SEARCH_SHORTFALL` (3) remains tolerated and reported on either side. A total of 5,251 can be an overstatement of 5,250 real names, so treating it as a proven one-name tail would falsely diagnose a 0% recovery. The allowance applies once per keyword, to the sum of its window and tail deficits. For example, enumerating 5,247 of 5,253 leaves three names on each term, six missing overall, and zero tail recovery; it must fail the recovery floor. Larger aggregate gaps must satisfy the window bound, the rate floor and the residual cap.

**The retry window is a union of two observations, not one fixed ranking.** Its distinct-name count can exceed 5,250. Recovery is `max(0, enumerated − SEARCH_WINDOW)`, counting the combined searches' union beyond one window's capacity. Subtracting a smaller measured sweep would credit the refinements with in-window names that the sweep omitted, so the capacity remains the reference even when the sweep serves short. Conversely, moving 20 already recovered names into the retry window at a total of 5,407 and a union of 5,400 must leave recovery at 150/157; subtracting all 5,270 window names would incorrectly lower it to 130/157. `windowShortfall` is the union's deficit below `min(required, SEARCH_WINDOW)`; `tailShortfall` is the remaining deficit. They are conservative count bounds, not observed ranks, and sum exactly to the aggregate shortfall. The build report carries both terms; a window-bound error also includes the sweep's measured count for diagnosis.

This does mean the catalog can be **knowingly published a few names short**, which is a change to "throws rather than truncating" and is stated here as one. The invariant it preserves is the one that matters: nothing is ever *silently* short. `total` is what makes that possible, and it is why no design here may stop comparing against it.


**Amendment (2026-09-07): entries carry `unpackedSize`, the shelf prints it, the category tabs take their category's hue, and the bar gains an incompatible filter.**

*`unpackedSize`.* npm entries carry the packument's `dist.unpackedSize` — the bytes an install puts on disk. Additive and optional, so it rides every `schemaVersion` (a consumer's non-strict zod strips a key it does not know; bumping the version NUMBER is the change that breaks a capped client, §6.2). The registry bounds it at harvest and DROPS anything that is not a safe non-negative integer, rather than rejecting the package: a size is a decoration, so a broken one costs the size and not the listing. Measured 2026-09-07, 250 of 250 live `dsh-plugin` packages carry one (min 25 kB, median 847 kB, max 180 MB), so the absent branch is for publishes older than npm 5.6.

**A github entry gets no size, deliberately.** GitHub's repo `size` is the repository's own disk usage including history, which is not the plugin — and for a monorepo subpackage it is not close. The rescued-release tarball's size is the COMPRESSED artifact, which is a different quantity from npm's unpacked figure and would put two incomparable numbers under one label. A number that measures something other than what its label says is the class of plausible-and-wrong this project stops for, so those entries print nothing. The client's `formatSize` is `undefined`-in/`undefined`-out for exactly that.

The label is decimal (`kB`/`MB`/`GB`, not `KiB`), because the figure IS npm's own and npmjs.com shows it decimal — a reader checking the shelf against the package page must not find two different numbers. It is locale-free by construction (`toFixed`, never `toLocaleString`): a decimal comma in one language reads as a thousands separator in the other. The visible text is the bare figure; the accessible name and tooltip say **unpacked**, since unpacked and download differ by the compression ratio.

*Card layout.* The size sits at the right end of the action row immediately LEFT of the author, both inside one wrapper that owns the `margin-left: auto`. Note what that ordering costs: the author's width varies and is absent entirely on many entries, so a size's horizontal position moves from row to row and the figures do not form a column. The size is mono and `tabular-nums` for per-figure legibility, which is the honest reason; an earlier draft of this amendment justified the monospace by a column this layout cannot produce. The wrapper is what makes the group stay flush right when only one of the two has a value — and size is absent on every github entry, so an outer-edge size would ragged the right margin down the shelf.

*Category tab colour and geometry.* A selected category tab's border, 14% background fill and inset ring use that category's own hue, read from the SAME table the card spine and category chip read (`--category-hue`, keyed by `data-category`). `All` and `Installed` select by something other than a category and keep the brand token.

**Text contrast (2026-09-08).** Hovered and selected labels mix 45% of the category hue with 55% of `--dsw-alias-label-primary`: the theme foreground darkens the text in the light theme and lightens it in the dark theme. The original unblended hue left all seven selected category labels below 3:1 on the light background, despite their inset rings. Chromium measurements against the current harness themes put the mixed text at a minimum of 5.87:1 in light and 8.75:1 in dark across the seven categories, All, Installed and the incompatible filter. These are observations, not a guarantee for future theme palettes: the web e2e requires at least 4.5:1 in hover, selected and selected-hover states in both themes. It checks category identity on the selected border rather than requiring the text to equal the raw hue, and retains exact width equality when selecting category tabs. (The filter left this group on 2026-09-08 and is measured as a switch; its label is held to the same 4.5:1 floor.)

**The pressed rule declares colour only, and that is a hard constraint, not a preference.** The tabs sit on a wrapping row; a tab that grows on selection can push its neighbours to the next line and slide out from under the pointer that just clicked it. `font-weight: 600` did this — bold metrics are wider than regular. Nothing that resolves to a length may join that rule: no padding, no border-width, no font-size, no letter-spacing. Two lanes hold it: `css-tokens.client.spec.ts` fails on such a declaration, and the web e2e measures one tab's `getBoundingClientRect().width` before and after the click and requires EXACT equality. The tolerance the e2e first used was useless — measured against real chromium, `font-weight: 600` moves a zh tab by 0.22px, because CJK glyphs are full-width and weight-invariant and only the Latin count digits move — so any tolerance loose enough to feel safe passes the defect.

**Corrections (2026-09-07, review of this amendment).** Three things the paragraphs above got wrong in their first form, each of which shipped and was caught by review rather than by a lane:

- *The pressed rule has to outrank hover, and specificity decides that — not source order.* Written as a bare `.categoryButtonOn` it is one compound unit against `.categoryButton:hover`'s two, so a selected tab under the pointer painted the hover rule's 45% border mix instead of the solid hue, for exactly as long as the pointer stayed where the click left it. It is written `.categoryButton.categoryButtonOn` and declared after the hover rule. The guard now asserts the two-class form exists, the bare form does not, and the pressed rule comes later.
- *Colour alone is not a sufficient affordance, so the constraint is "colour or shadow", not "colour".* Removing `font-weight: 600` removed the only pressed signal that hover could not defeat and that forced colours could not flatten — and the `other` tab's hue IS the neutral gray this UI uses for "no category", so on the light theme its pressed state differed from its unpressed state by almost nothing. The pressed rule carries `box-shadow: inset 0 0 0 1px var(--category-hue)`, a second ring that paints OUTSIDE the layout box and so costs the pill no metrics, plus a `forced-colors` outline. `box-shadow` is the one non-colour property the guard admits, for that reason.
- *The geometry guard is an allowlist.* It was a denylist of ~30 property names, which fails open: `font` (the shorthand that sets weight and size at once), `padding-inline`, `border-left-width` and `font-variant-numeric` all passed it, and the last is the natural thing to reach for on labels that end in a digit count. The rule the stylesheet states is "every declaration here is a colour", which is six names and stable, so the guard now asserts that and refuses everything else. It covers the `:hover` rules too: they reflow the same row and fire on mere pointer movement, which is strictly worse than on a click.

The filter was made a pill too, wearing `.categoryButton` and stating only its hue and its `margin-left: auto`. It had been a verbatim clone of all four pill rules, so the geometry constraint above was enforced against two copies that could drift; `--category-hue` was the knob this amendment introduced and is what made the clone unnecessary. That sharing is superseded by the 2026-09-08 amendment below, which takes the filter out of the pill group entirely; the clone-avoidance lesson survives it unchanged, applied now to `.switch`.

*The incompatible filter.* At the far edge of the category bar sits a toggle that leaves out entries the Host reported missing components for, carrying the count of them across the browsable shelf. It is a MODIFIER, not a ninth category: the categories choose what to show and this subtracts from whatever they chose, so it keeps its own state across a category switch and combines as AND. It is OFF by default — a filter nobody asked for must not hide listings on first open, and the count is what tells a reader there is anything to hide. It hides exactly the entries whose badge READS "Incompatible", which is a stronger statement than "whose missing-peer list is non-empty" and the reason the two must be one predicate rather than two spellings. A `name-taken` entry is NOT hidden: that badge names a different condition and a different remedy, and its card is the only surface that explains why the install is refused.

**Corrections (2026-09-07, review of this amendment).** The first implementation tested the missing-peer list directly, which broke the rule above in two ways that both reached the reader:

- *An entry can carry BOTH blockers.* `BlockerBadge` lets a taken name decide the visible word when both hold, so such a card reads "Name taken" — and testing the peer list hid it anyway, taking away the only surface explaining the refusal, which is the very carve-out the paragraph above states. The filter and its count both ask one predicate: missing peers AND no name holder.
- *The modifier does not apply to the Installed view.* That view is management, not shelf. An installed plugin that is up to date appears in exactly one place — its card, which carries the enable switch and the uninstall button, since the installed section lists only rows whose `outdated` is true — so subtracting there left a reader no way to disable or remove the broken install they had come to fix, above a tab still counting it. The filter is skipped for that view and its control is not rendered there; the state survives, so switching back restores both.

**The control carried the action in its label and therefore no `aria-pressed`.** The two encodings are each coherent and must not be mixed: the category tabs keep a fixed label and let `aria-pressed` carry the state; this button's label flipped between "Hide incompatible N" and "Show incompatible N". With both, a screen reader announced "Show incompatible 1, pressed" while they were hidden — the inverse of the truth. Superseded by the amendment below, which takes the other branch of that same choice.

**Amendment (2026-09-08): the incompatible filter is a switch, not a pill.**

Wearing `.categoryButton` put a boolean modifier in the same shape, the same row and the same size as the eight category tabs, differing only in being red — so it read as a ninth tab that happened to be red, which is the one thing the paragraphs above insist it is not. The tabs are choose-one; this is on or off. Nothing about a pill says which of those it is, and the reasoning that shared the pill rules was about avoiding a stylesheet clone, never about the two controls meaning the same thing.

It now renders as the shop's existing switch — the 32×18 track every installed card already carries — followed by its label, with no border and no fill of its own. Three things follow, and each of them is the reason rather than a consequence:

- *The label stops flipping, so `role="switch"` with `aria-checked` becomes correct.* The old encoding was forced: a flipping label rules out any state attribute. A switch carries the state in the knob, which frees the words to name what the control does, which is what makes the attribute honest. The category tabs and this control now sit on opposite branches of the same coherent choice — fixed label plus state attribute — and no longer mix encodings by accident. The `title` still tracks the state, since it is the one string that can change at no cost to layout.
- *Two labels were two widths.* The pressed-rule constraint above exists because the bar wraps and a control that grows slides out from under the pointer that clicked it — and the filter, the one control exempted from it, changed its whole label on click. A fixed label makes width invariance assertable here too, and the web e2e now measures it across off, hover and on rather than documenting the exception.
- *The knob's position is a non-colour affordance by construction.* The pills needed `box-shadow: inset` and a `forced-colors` outline to survive a system palette that flattens every colour. A knob that has slid is still slid.

`--switch-hue` is the knob that keeps this from becoming a second clone: `.switch` owns the geometry once, reads the hue from whoever wears it (success on the enable toggle, `--dsw-alias-state-error-primary` here), and the filter's one declaration reaches its track and its label together. It is read by INHERITANCE, so the default rides in a `var()` fallback — a declaration on `.switch` itself would shadow the ancestor's value and the filter's track would have gone on painting green. `.switch` also states its own `box-sizing` and `padding`, because its two wearers are a `<button>`, which the UA gives padding, and a `<span>`, which it does not.

Two smaller consequences worth stating because they are easy to get wrong. The hover rule that warms the track's border is scoped to the OFF track: `.incompatibleFilter:hover .switch` outranks `.switchOn` by a class, so unscoped it strips the hue from the border at exactly the moment a reader has the pointer on it to check the state — the same defect the pressed rule was corrected for on 2026-09-07, in a new place. And the resting knob steps down to `--dsw-alias-label-secondary` for this control only: on the enable toggle, off means "this plugin is disabled" and is worth a full-strength dot, while here off means "nothing is being taken away". In the light theme that distinction is the whole control, because `bg-layer-2` is the same white as the panel there, so an off track is a hairline outline with a dot in it and nothing else.

**An empty shelf says which control emptied it.** The filter is persistent and its search box is empty, so the generic "No matching plugins" line misattributed the cause to a search the reader had not made. The client keeps what the category and search selected separately from what the modifier left, so a non-empty former with an empty latter is the modifier, stated as such — and no second copy of the filter chain exists to drift from the first.

**Amendment (2026-08-27, follow-up): boot-time warm.** The client bundle warms `shop/catalog` (plus the small `installed` and `version` reads) when its apply runs at web boot, so the shop's first open consumes the boot-time fetch instead of waiting on it — the host's slow network fetch happens while nobody is looking at the shop. The tab's plain open consumes the stashed promise (the host's snapshot is the same one a fresh call would serve, so §10 freshness semantics are unchanged); a refresh always goes to the wire, and a failed warm falls back to a fresh call. Each boot starts its own warm fetch.

## 8. When changes take effect

| Operation | Restart required | Evidence |
|---|---|---|
| Enable / disable | **No — hot** | `watchUserPatches` watches a profile's `cordis.patch.yml` and reapplies it through HMR via `entry.update({config:{patches}})` |
| Install / uninstall | **Yes** — hot-mount exception (2026-08-31 amendment) | Bundle layers come from the profile `package.json`'s `dsh.profile.bundles`, read at boot; the watcher does not cover it |

One clever-looking approach is ruled out: inserting the newly installed plugin's rows directly into the user layer to avoid a restart. **It does not work.** At the next boot `dsh.profile.bundles` already contains the package, because `dsh plugin` reconciles by installed state, so the same rows would mount twice.

**Amendment (2026-08-27): the shop now ships a restart endpoint, replacing the v0 ruling.** `shop/restart` commits a **two-phase handoff**: the Host spawns a detached helper that waits for the Host's own pid to disappear, then `exec`s the same `dsh` command line (`process.argv` verbatim — same profile, same port); the Host resolves `{ ok }` and exits once the response is out. The browser, still alive, polls the origin after a grace period and refreshes when the new server answers; if it never does, the UI names the manual command (`dsh web`) and points at the boot log (`restart.log` in the shop cache directory). The old process cannot wait for the new one — the new one must bind the port the old one still holds, and two live processes cannot bind it at once: the first implementation spawned the child and waited for its URL, and the child crashed in boot with `EADDRINUSE` on every attempt. Refusals (`--port 0`, a spawn or log failure) are typed and issued **before** anything is torn down; once `{ ok }` is returned, the old process WILL exit and the client-side monitor is the failure reporter.

The earlier ruling prescribed an opt-in flag, default off, loopback only. The author overrode it on 2026-08-27 in favor of always-on convenience. The residual risk, accepted: any browser context that can reach the shop UI can restart the server process (a nuisance-availability attack on the same host, not a privilege escalation — the restart re-runs the user's own launch command). The confirmation gate does not constrain a malicious context; it exists to inform a user.

**Amendment (2026-08-31, market borrowings C-1): restart under a supervisor is refused by default.** When a systemd unit owns this process and the shop row config sets no `allowRestart: true`, `shop/restart` issues a typed refusal and the two-phase handoff never starts — the main process exiting also kills the unit's cgroup, which takes the detached helper with it, and the service would never come back. `shop/version` reports `restartSupported: false` and the client hides the restart offer while keeping the pending-change notice (§7.3).

**Amendment (2026-08-31, design: 2026-08-31-market-borrowings.md §4, Phase D): the install/uninstall row gains the hot-mount exception.** The borrowings design decides that installs, uninstalls, and updates go live without a restart through a shop-owned ephemeral Include subtree — `hot-<n>.yml` inputs under `<profile>/.dsh-shop/`, wiped at boot, rows under `mkt-` ids (dsh-market's mechanism, ported in the borrowings plan's Phase D, pending at this amendment). The ruling above still holds: the ephemeral tree is never a `cordis.patch.yml` write, so the same rows cannot mount twice at next boot. The wire contract does not change — `shop/installStatus`'s `needsRestart` reports the outcome, false more often — and the shop's own self-update always keeps `needsRestart`, since a host half cannot swap itself live.

## 9. Security model

### 9.1 Threat model

**In scope:**

| Attacker | Method |
|---|---|
| Malicious author | Publishes a backdoored plugin carrying a harvest keyword |
| Typosquatter | `dsh-fs-tools` impersonating `dsh-fs-tool` |
| Compromised legitimate plugin | Author's npm account stolen, or its dependency chain poisoned |
| Catalog man-in-the-middle | Hijacks CDN or DNS and rewrites `plugins.json` |
| Attack on the shop itself | Injects through catalog text to attack the browser half |

**Out of scope:** the runtime behavior of an installed plugin; a compromise of npm itself.

### 9.2 Countermeasures

| Threat | Countermeasure | Residual risk |
|---|---|---|
| Malicious author | Tiering; mandatory acknowledgement for community entries | The community tier carries real risk; only honest disclosure mitigates it |
| Typosquatting | Build-time edit-distance check, held for human adjudication | Novel impersonation techniques |
| Stolen account / malicious new version | verified pins a version; `manifest.lock` records integrity, so version and hash changes are visible in a git diff | Detection lags publication |
| Catalog man-in-the-middle | `index.json` points at content-addressed data; the Host verifies the fetched sha256 against the pointer; this repository's git history is the second source of truth | `index.json` itself being replaced: HTTPS stops network-level impersonation of an honest origin, but `dist.integrity` (npm transport) is a self-consistency check the origin computes over its own tarball, not an independent signature the Host verifies — a compromised or malicious origin can serve a self-consistent forged catalog and present an arbitrary package as `verified`; this repository's `manifest.lock` is the only out-of-band check, and no automated comparison against it exists |
| Catalog text injection | Client holds no privilege; `summary` and `description` render as **plain text only** — no Markdown, no links |  |
| Code execution at install time | pnpm 10+ blocks build scripts by default and the shop never writes `allowBuilds` | Entries a user enabled manually beforehand |

### 9.3 Wording of the acknowledgement

The community-tier confirmation must convey this:

> Once installed, this plugin holds the same privileges as a built-in one: reading and writing your files, running shell commands, and reading and modifying the requests sent to the model. It has not been reviewed.

The basis is dsh's own characterization of `allowBuilds` — "permission to execute the package's code on your machine at install time, outside any sandbox the agent runs under". Reuse the upstream wording rather than inventing a parallel vocabulary.

Wording such as "this plugin comes from the community, please install with care" carries no information and is not acceptable.

## 10. Failure modes

| Failure | Presentation | Handling |
|---|---|---|
| Catalog unreachable (offline, CDN outage) | Serve the last cached snapshot, labelled with its date | **Degrade and stay usable**; not an error |
| Catalog `schemaVersion` newer than the client supports | Refusal is **host-side**: the shop throws rather than degrade, the Host's log carries the upgrade instruction, and the client shows its generic error state with retry — the browser-level upgrade prompt is deferred until the wire carries a structured error signal | **Fail loudly**; never degrade silently |
| pnpm absent from PATH | The CLI already diagnoses this with exit 127 | Surface verbatim |
| pnpm install fails | stderr verbatim plus a `dsh plugin --profile <p> install` recovery hint | No automatic rollback |
| Install succeeded but the entry is not an active bundle | The confirm reads the profile manifest before and after and reports **the difference, never an inferred cause**: (a) the name IS an own dependency but not a bundle; (b) the name is absent and something else was added — name what; (c) the name is absent and nothing was added; (d) the manifest EXISTED before the install and could not be read, so the prior state is unknown | Report which of the four, as evidence. A stale catalog is named only in (c), the one shape where it is a real candidate. (b) and (c) are both claims about what CHANGED, so neither may be reported in (d) — an unreadable prior state read as an empty one makes every pre-existing dependency look newly added, and the report then tells the reader to remove a working plugin. An ABSENT manifest is not (d) but an empty prior state: nothing WAS installed, which is what a first install into a fresh profile looks like, and (b) has to keep working there. Same two-sided rule as `no-manifest` versus `fetch-failed` in the harvest. In (b) the package that landed is by construction not a catalog entry, so the shop's own uninstall cannot reach it and the report carries a `dsh plugin remove` line instead. **A cause may not be asserted here** — `install()` builds three spec forms and the confirm cannot see which one was spawned, so any reason it names is a guess wearing a fact's clothes |
| Confirm passes on membership alone | A bundle row left by an earlier install satisfies `bundles.includes` while THIS attempt put something else on disk; the caller then hot-mounts the old tree and publishes "running now, no restart needed" over an install that did nothing | The confirm requires **both**: the name listed in `dsh.profile.bundles` (via `Array.isArray`, since `readProfileManifest` only validates that the document is an object) **and** present as an own dependency |
| Profile does not exist | `dsh plugin` initializes it | Nothing to handle |
| Concurrent installs into one profile | The later caller waits | Per-profile mutex |
| Restart under a supervisor | `shop/version` reports `restartSupported: false` and the client hides the restart offer, naming the manual restart; `shop/restart` returns the typed refusal | Refuse before anything is torn down; `allowRestart: true` in the shop row config overrides |

## 11. Testing and acceptance

dsh-plugin-shop sits outside the dsh repository and is not bound by its 100% coverage, invariant, or doc-sync gates. Four of its practices are adopted deliberately:

1. **`build.ts` must be a pure function** — npm response fixtures in, JSON out. One case per gate rule, plus a **determinism test**: the same input twice produces byte-identical output. That test directly protects the "`builtAt` stays out of the hash" decision in §6.2.
2. **Rejections must be tested through the executor** — one test each for `not-in-catalog`, `denied`, `version-mismatch`, and `needs-acknowledgement`, calling `shop/installStart` directly rather than asserting that the UI disabled a button. Per dsh's own rule: "facades, wrappers, and listener order are not enforcement when direct or alternate callers can bypass them; test denial through the executor."
3. **One real installation test** — a temporary `DSH_HOME` and a fixture plugin package (a `file:` spec suffices; no verdaccio needed), asserting afterwards that the profile `package.json`'s `dsh.profile.bundles` gained an entry.
4. **An XSS regression** — a catalog fixture whose `summary` is `<img src=x onerror=...>`, asserting it renders as text.

## 12. Phases

| Phase | Content | Exit criteria |
|---|---|---|
| P0 | R: schema, `build.ts`, CI, first published artifact; bilingual README and schema documentation | The catalog is fetchable; the determinism test passes |
| P1 | S Host half: `shop/catalog`, `shop/installStart`, `shop/installStatus` | The real installation test passes |
| P2 | S Client half: browse, detail, install, acknowledgement — plus enable/disable (hot) and `shop/outdated` client-side (P3 absorbed into P2, 2026-08-25) | The XSS regression passes; the full flow works in a web profile |
| P3 | Absorbed into P2 (2026-08-25): enable/disable (hot) and `shop/outdated` client-side shipped in P2 Task 4 — no remaining content | — |

**P2 exit criterion (2026-08-25, met with a recorded deviation):** a successful shop-driven install is deferred until a real npm package with a `dsh.bundle` exists — an external fact, not a gap in the client. The executor's success path is proven by P1's real-installation test (§11.3.3), and the terminal-state poll by the web full-flow e2e, which proves browse → acknowledge → install-to-terminal through the real machinery.

P0 comes first because a schema change forces the Client to be rewritten. P1 comes next because it is the only part that genuinely fails at runtime — subprocesses and profile state — and the UI is the easiest thing to change.

### Documentation language

- **User-facing documentation is bilingual**: `README.md` (English) with `README.zh.md` alongside it, following the dsh convention of an `English | 中文` header link. The schema reference is bilingual on the same pattern.
- **Design documents and specs are English only.** They are engineering records, not user-facing surfaces, and a single language keeps one home per fact.
- Catalog `summary` carries both `en` and `zh` from the author; neither is synthesized by the build.

## 13. Optional upstream PRs (none blocks v0)

| # | Change | Benefit |
|---|---|---|
| U1 | Lift `runPlugin` into `dsh-app-boot` with injectable stdio | The shop calls a library instead of locating the `dsh` executable |
| U2 | Move settings-namespace exposure from `WEB_SETTINGS_NAMESPACES` to `settings.register()` | Out-of-tree plugins can expose their own configuration card; that file already lists this as deferred work |
| U3 | Let out-of-tree plugins register forwarded events | Install progress can become a push |
| U4 | Give `pluginInventory` a write path | The shop no longer orchestrates profile mutation itself |

## 14. Known limitations and deferred work

- **`capabilities` is self-declared and unenforced.** v0 has no sandbox. UI wording must not let it read as an enforced permission list.
- **The verified tier depends on sustained human review.** With no reviewers, every entry stays in the community tier and the shop degrades into an awesome-list with a UI. That is an operational problem rather than a technical one, but it determines whether the product has value; no technical measure substitutes for it.
- **No restart endpoint** (§8).
- **`shop/restart` is POSIX-only.** The two-phase handoff runs a shell one-liner through `sh` with `kill -0` and `sleep`, none of which Windows has, and `exec "$@"` has no Windows equivalent — it needs a detached node helper instead. Until then the Host refuses the call before anything is torn down and reports `restartSupported: false`, so the client keeps the pending-change notice and drops the offer (the same path as the systemd case). This is a refusal rather than a deferral because the failing spawn is asynchronous: committing would answer `ok: true`, exit the process, and leave nothing holding the port.
- **No download counts, ratings, or reviews** (§2).
- **A single catalog source.** An intranet mirror can replace the URL by configuration, but v0 does not merge multiple sources.

## 15. Appendix: dsh source consulted

| Fact | Location |
|---|---|
| `dsh plugin` orchestration and reconcile | `apps/cli/src/plugin.ts` |
| Profile and bundle manifest definitions | `packages/boot/app-boot/src/profile.ts` |
| Scope of user-layer hot reload | `watchUserPatches` in `packages/boot/app-boot/src/index.ts` |
| How an out-of-tree client half is loaded | `packages/client/modules/README.md` |
| Read-only plugin inventory and its limits | `packages/host/plugin-inventory/README.md` |
| Settings namespace allowlist | `WEB_SETTINGS_NAMESPACES` in `packages/host/apiproxy/src/api-proxy.ts` |
| Forwarded event allowlist | `packages/api/remotes/src/remote-events.ts` |
| Security characterization of `allowBuilds` | `docs/user/develop/basic/publish.md` |
