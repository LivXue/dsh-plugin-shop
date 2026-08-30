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
| D7 | A listing is **dual-track**: declared or derived | Measured after D1-D6 were fixed: the `dsh-plugin` keyword already carries ~1390 npm packages, of which a 100-package sample showed 94% declaring `dsh.bundle` and **0% declaring `dsh.catalog`**. Requiring a field this project invented would have shipped an empty catalog against a live ecosystem, contradicting D2's own premise |
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
`dsh-plugin-hub`, `@lanbaolu/dsh-plugin-hub`, `@mutocenew/dsh-plugin-catalog`).

**R — `registry/` (data only, no runtime code)**

Artifacts publish to a CDN as `/v1/index.json` (a pointer) and `/v1/plugins.<sha256>.json` (the data). Separating pointer from data lets a client cache the data file indefinitely while polling only a few hundred bytes.

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

`category` is a closed enum: `tool` | `provider` | `ui` | `workflow` | `integration` | `other`.

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

A consumer presents a derived entry as unclaimed, which is also the signal that prompts an author to add the section.

### 6.2 Published artifacts

`/v1/index.json`:

```json
{
  "schemaVersion": 2,
  "builtAt": "2026-08-18T00:00:00Z",
  "count": 137,
  "plugins": { "url": "plugins.<sha256>.json", "sha256": "<sha256>" }
}
```

The pointer may carry an optional `stars` object naming a content-addressed sidecar of GitHub star counts keyed by package name; stars are live daily data and are quarantined there so the plugin data hash stays cache-stable. `schemaVersion` remains 2.

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
      "tier": "verified",
      "metadata": "declared",
      "review": {
        "reviewedVersion": "1.2.0",
        "reviewer": "github:someone",
        "reviewCommit": "abc1234",
        "notes": "..."
      },
      "catalog": {
        "category": "tool",
        "summary": { "en": "...", "zh": "..." },
        "capabilities": ["fs", "shell"]
      }
    }
  ],
  "denied": [
    { "name": "dsh-hllo-plugin", "detail": "Denied by the registry: possible typosquat of dsh-hello-plugin" }
  ]
}
```

`denied` carries every denylisted package with its author-readable reason; the Host consults it for the `shop/installStart` gate (§7.2). Rejections that are not denials stay in the build report.

`summary.zh` is optional in the published format because a derived entry has none, so `schemaVersion` is `2`.

A derived listing may carry an LLM-assigned `catalog.category` sourced from `registry/categories.yml`; the assignment is advisory and never gates a listing.

`builtAt` appears **only in index.json and never inside the hashed content**. Otherwise the hash changes daily, every CDN cache is invalidated, and every git diff is noise.

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
   - Levenshtein distance to any name in `verified.yml` is between 1 and 2 inclusive — **held for human adjudication** (into `denied.yml`, or cleared into `allowed-similar.yml`), never auto-listed. This is the typosquatting gate. The threshold of 2 is a starting point tunable against the observed false-positive rate; changing it touches a constant and its test, not the process.
5. **Tier** — intersect with `verified.yml`.

   > **verified pins a version. It never attaches to a name.**

   `verified.yml` records `{ name, reviewedVersion, reviewer, reviewCommit, notes }`. If npm's latest exceeds `reviewedVersion`, the entry is **downgraded to `verified-stale`**, and the UI shows "reviewed v1.2.0 / current v1.3.0 unreviewed".

   Most markets attach verification to a package name, which means an author who passes review can then publish a malicious version and inherit the trust automatically. That is the cheapest supply-chain attack available.
6. **Stars** — GitHub GraphQL fetches star counts for github.com repositories into `dist/v1/stars.<sha>.json`; failures publish without stars and retry next build (`github-stars.ts`, shell).
7. **Emit** — sort by package name for determinism; produce `plugins.<sha256>.json` and `index.json`, with the build report as a CI artifact.
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
  |                              | 2. tier != verified and !acknowledged
  |                              |                     -> needs-acknowledgement
  |                              | 3. spec = `${name}@${version}` (pinned)
  |                              | 4. take the per-profile mutex
  |<---- { installId } ----------| 5. spawn dsh plugin --profile <p> add <spec>
  |                              |--------------------------------->|
  |  poll shop/installStatus -->|<-------- stdout/stderr ----------|
  |<---- { state, log[] } -------| 6. exit 0 -> re-read the manifest, confirm
  |<---- { done, needsRestart } -|         dsh.profile.bundles changed
```

Implementation decisions:

- **Pin the version.** The spec is `name@version`, not `name` and never `^version`. The user clicked a version in the snapshot; that is what must be installed.
- **Spawn rather than reimplement.** dsh's own `stdio: 'inherit'` inherits the pipe we provide, so streaming logs come for free with no upstream change. The orchestration — init, pnpm, reconcile — lives in `runPlugin` in `apps/cli/src/plugin.ts` and is **exported from no package**; `dsh-app-boot` exports only the primitives. Copying the reconcile loop would drift, and its "by installed state, not by dependency diff" semantics are subtle enough not to duplicate.
- **Poll for progress rather than push.** `API_REMOTE_FORWARDED_EVENTS` is a hardcoded in-repository array, so an out-of-tree plugin cannot push events to the browser. `shop/installStart` returns an `installId` immediately and the client polls `shop/installStatus` once per second. A side benefit is that it survives a page reload.
- **Serialize per profile.** pnpm locks itself, but its concurrent-access errors are unreadable to a user. One mutex per profile on the Host side.
- **Never roll back automatically.** After a pnpm failure `dsh.profile.bundles` is still consistent, because reconcile runs only on exit 0, but `dependencies` may already have been rewritten. The response is to surface stderr verbatim and suggest `dsh plugin --profile <p> install`. **Automatically rolling back a package manager's intermediate state breaks environments more often than leaving it alone.**
- **The shop never writes `allowBuilds`.** pnpm 10 and later block build scripts by default, which is a security property obtained for free. A plugin that needs a build script simply cannot be installed from the shop; the UI says so plainly and prints the CLI command.

### 7.3 RPC contract

| Method | Arguments | Returns |
|---|---|---|
| `shop/catalog` | `{ refresh?: boolean }` | `{ schemaVersion, builtAt, stale, plugins[] }` |
| `shop/installStart` | `{ name, version, acknowledged? }` | `{ installId }` |
| `shop/installStatus` | `{ installId }` | `{ state, log[], needsRestart? }` |
| `shop/setEnabled` | `{ name, enabled }` | `{ ok }` |
| `shop/uninstallStart` | `{ name }` | `{ installId }` |
| `shop/restart` | none | `{ ok }` |
| `shop/version` | none | `{ installed, latest, outdated }` |
| `shop/updateStart` | `{ version }` | `{ installId }` |
| `shop/installed` | none | `{ name, installed, latest, outdated }[]` |

**Amendment (2026-08-25): the install method is `shop/installStart`, not `shop/install`.** The web full-flow e2e against the real composition exposed that the client api's `RemoteNamespaceService` owns a method named `install` (its internal mount primitive), so a Remote namespace cannot expose one: mounting `shop/install` throws "method \"shop/install\" conflicts with its namespace service". The wire method is renamed to `shop/installStart` (pairing with `shop/installStatus`); the client-visible injected face keeps the name `install`, and the host-side code method is unchanged — only the wire name differs.

**Amendment (2026-08-25): a client package that mounts its own Remote must consume it through the reflect shop, not the inject face.** The same e2e exposed that `ctx.remote.<ns>` refuses a namespace to a fiber whose inject face does not name it ("cannot get property remote.shop without inject"), while naming it in the face deadlocks the boot's activation gate: the gate waits for `remote.shop` to be provided, and only the package's own apply — which the gate is holding back — can mount it ("pending (waiting for service: remote.shop)"). The client half therefore reads the mounted namespace via `ctx.get('remote.shop')`, the reflect shop's documented inject-free read, after `$mount` settles. Third-party client packages that self-mount should follow the same pattern.

**Amendment (2026-08-27): `shop/outdated` is reshaped into `shop/installed`, which returns every installed catalog entry with an `outdated` flag.** The tab's shelf cards need the full installed set — not just the behind-version subset — so the card for an installed plugin shows its installed state (or the update button when behind) instead of an install button. The outdated section and the card state both derive from this one list; the semver comparison stays on the Host, and the client never does version math.

**Amendment (2026-08-27, follow-up): `shop/uninstallStart` joins the RPC surface, the shelf gains an Installed filter, and installed cards carry uninstall.** Removing a plugin revokes privilege rather than granting it, so uninstall sits inside the §9.1 Client-half threat model (the five-method boundary becomes six); the RPC validates the name against the catalog snapshot and the installed manifest, so it cannot remove profile dependencies the shop does not manage (the base bundle, the shop itself). The category bar gains an Installed button that filters the shelf to installed plugins; installed cards show the update button (when behind) plus an uninstall button, replacing the bare installed label. The "Plugin catalog" heading is dropped — the bar and stats carry the context.

**Amendment (2026-08-27, follow-up): self-update.** The shop shows its own running version right of the search box (read from the shipped package.json), checks npm for a newer release on mount/refresh and on demand via a check button next to the version, and offers an update button when behind. `shop/version` reports `{ installed, latest, outdated }` with `latest` degrading to null when the registry cannot answer (advisory, like the stars sidecar); `shop/updateStart` runs the pinned `dsh-plugin-shop@<version>` spec (the only install form that bypasses pnpm's release cooldown) through the same executor, records, and polling as installs, with the version re-validated as plain semver at the boundary. The Client-half boundary becomes nine methods. Right of the version row sits a constant link to the project's GitHub repository, rendered as the octocat mark with an aria-label — a static URL, independent of the advisory check, so it stays visible when the version check has no answer.

**Amendment (2026-08-30): every shelf card shows its version.** The badge row leads with a quiet `v{x.y.z}` — the same fact as the expanded detail's version row, visible without expanding. The version is catalog data rendered as text, never as a spec.

**Amendment (2026-08-27, follow-up): boot-time warm.** The client bundle warms `shop/catalog` (plus the small `installed` and `version` reads) when its apply runs at web boot, so the shop's first open consumes the boot-time fetch instead of waiting on it — the host's slow network fetch happens while nobody is looking at the shop. The tab's plain open consumes the stashed promise (the host's snapshot is the same one a fresh call would serve, so §10 freshness semantics are unchanged); a refresh always goes to the wire, and a failed warm falls back to a fresh call. Each boot starts its own warm fetch.

## 8. When changes take effect

| Operation | Restart required | Evidence |
|---|---|---|
| Enable / disable | **No — hot** | `watchUserPatches` watches a profile's `cordis.patch.yml` and reapplies it through HMR via `entry.update({config:{patches}})` |
| Install / uninstall | **Yes** | Bundle layers come from the profile `package.json`'s `dsh.profile.bundles`, read at boot; the watcher does not cover it |

One clever-looking approach is ruled out: inserting the newly installed plugin's rows directly into the user layer to avoid a restart. **It does not work.** At the next boot `dsh.profile.bundles` already contains the package, because `dsh plugin` reconciles by installed state, so the same rows would mount twice.

**Amendment (2026-08-27): the shop now ships a restart endpoint, replacing the v0 ruling.** `shop/restart` commits a **two-phase handoff**: the Host spawns a detached helper that waits for the Host's own pid to disappear, then `exec`s the same `dsh` command line (`process.argv` verbatim — same profile, same port); the Host resolves `{ ok }` and exits once the response is out. The browser, still alive, polls the origin after a grace period and refreshes when the new server answers; if it never does, the UI names the manual command (`dsh web`) and points at the boot log (`restart.log` in the shop cache directory). The old process cannot wait for the new one — the new one must bind the port the old one still holds, and two live processes cannot bind it at once: the first implementation spawned the child and waited for its URL, and the child crashed in boot with `EADDRINUSE` on every attempt. Refusals (`--port 0`, a spawn or log failure) are typed and issued **before** anything is torn down; once `{ ok }` is returned, the old process WILL exit and the client-side monitor is the failure reporter.

The earlier ruling prescribed an opt-in flag, default off, loopback only. The author overrode it on 2026-08-27 in favor of always-on convenience. The residual risk, accepted: any browser context that can reach the shop UI can restart the server process (a nuisance-availability attack on the same host, not a privilege escalation — the restart re-runs the user's own launch command). The confirmation gate does not constrain a malicious context; it exists to inform a user.

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
| Catalog man-in-the-middle | `index.json` points at content-addressed data; the Host verifies the fetched sha256 against the pointer; this repository's git history is the second source of truth | `index.json` itself being replaced, mitigated only by HTTPS |
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
| Install succeeded but `bundles` unchanged | The package was a library, not a plugin, which the gate should have caught | Report a stale catalog and force a refresh |
| Profile does not exist | `dsh plugin` initializes it | Nothing to handle |
| Concurrent installs into one profile | The later caller waits | Per-profile mutex |

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
