# Borrowings from dsh-market — design

Status: **decided (2026-08-31), implementation pending.** Review of
[dsh-market/dsh-market](https://github.com/dsh-market/dsh-market) (the
in-harness market app that consumes the curated awesome-dsh-plugin
registry) concluded with nine borrowable items, organized as four
sub-projects built in this order: **C (host hardening) → B (publish-time
self-check) → A (catalog data layer) → D (hot-mount)**. The authority
spec (`2026-08-18-dsh-plugin-shop-design.md`) is amended in the same
change that implements each sub-project. English only, per convention.

dsh-market is the consumer layer of a different catalog (PR-curated,
2,452 entries); this project is the producer (keyword harvest, zero
friction). Borrowings are adapted to that difference, not copied.

## 0. Evidence gathered before design

- **`@deepseek-ai/cordis-plugin-include` is published** (^1.0.6, a
  direct dependency of the dsh npm package). dsh-market's comment
  calling it "vendored, unpublished" is outdated. Verified in the local
  dsh 0.1.1-rc.2 install: `Include` class with `write()` and
  `import()` exported at
  `@deepseek-ai/cordis-plugin-include/lib/index.js:284`.
- **`ctx.plugin(plugin, config)` returns `Fiber & PromiseLike<Fiber>`**
  (cordis 4 registry types): awaitable until loaded, disposable.
- **The `loader` service is injectable out-of-tree**:
  `ctx.reflect.provide("loader", …)` in `cordis-plugin-loader`; entries
  expose `options`, `fiber`, and `update(options, create, force)`.
  Our host already reads it by structural cast (`rowConfig()` in
  `packages/dsh-plugin-shop/src/host/index.ts`).
- **Our host resolves harness packages at runtime through
  peerDependencies** hoisted into the profile (`dsh-app-boot` etc.,
  P1-verified). The include plugin rides the same path as an optional
  peer.
- **Their hot-mount rows use a `mkt-` id prefix** so a hot-mounted
  entry never collides with the bundle layer's own rows at next boot;
  the ephemeral yml inputs are wiped every boot.
- **Live-disable of a bundle-layer entry works and has a sharp edge**:
  their theme manager retries `entry.update({disabled})` until the
  fiber is actually down, because "a disable can land while the entry's
  init is still in flight" (dsh-market `src/themes.ts`). For an update
  swap this retry is mandatory, not defensive: a plugin that provides
  cordis services would otherwise have two live instances and the
  second provision throws.

## 1. Sub-project C — host hardening

### C-1: systemd guard for `shop/restart` (their restart.ts:31-44)

- **Pure function** `detectSupervisor(env, processSnapshot) →
  'systemd' | null`, in the pure core. Environment and the process
  snapshot are parameters; the shell reads them once and passes them
  down. Detection: `(INVOCATION_ID || JOURNAL_STREAM) present &&
  ppid === 1` — **both signals required**: `INVOCATION_ID` is inherited
  by every descendant of a unit, and treating inheritance as ownership
  would hide the button for ordinary terminals (their measured
  failure).
- `shop/restart` gains a pre-flight check: systemd detected and no
  explicit override → typed refusal `supervisor-managed`, issued before
  anything is torn down. The two-phase handoff never starts.
- **Escape hatch**: `allowRestart: true` in the shop's loader row
  config, read through the existing `ShopRowConfig` (which already
  reads `entry.options.config` — the same channel the market documents
  as the only place the loader passes a plugin config sub-object).
- Client: the restart button hides on `restartSupported: false`; the
  pending-change notice stays visible and says why. The flag rides the
  existing `shop/version` result (`{ installed, latest, outdated,
  restartSupported }`), which the client already reads at boot and on
  refresh — no new RPC surface.
- Tests: a fixture matrix over `detectSupervisor` (INVOCATION_ID ×
  JOURNAL_STREAM × ppid), and the refusal tested through the executor,
  per the "test denial through the executor" rule.

### C-2: forwards-only update verdict — pinned by test

The code is already forwards-only: npm compares with semver `lt`
(`host/index.ts:531`); the github pin comparison uses `!==`
deliberately — commits are unordered, and following the catalog pin is
the intended semantics. dsh-market hit the opposite bug for real (a
`latest` dist-tag pointing at an older release turned "update" into a
downgrade that broke the profile's boot). Deliverable: tests pinning
the `lt` semantics (equal version and backwards `latest` both report
not-outdated) with a comment citing the incident.

### C-3: stale answers never silent — audit + pin

Audit the three degradation paths — catalog cache fallback (already
carries `stale` + builtAt), stars sidecar (advisory, no row rendered),
version check (`latest: null`). No behavior change is intended; the
deliverable is a test pinning that every degraded answer carries its
stale/absent signal. dsh-market's own history justifies the audit:
their bundled snapshot + TTL cache quietly served a 39%-smaller frozen
catalog, and the fix was to delete the fallback, not to label it. We
keep our fallback (it serves install-gate availability, not discovery
freshness) but the label is not optional.

## 2. Sub-project B — publish-time self-check (their E1–E12)

dsh-market's `scripts/validate-registry.mjs` is the consumer's full
expectation of catalog quality. Mapping it onto our pipeline:

| Their check | Our status |
|---|---|
| E1 required fields | covered — zod schema at the emit boundary |
| E2 bilingual description non-empty | not applicable — derived listings have no `zh` by design (D7); adopting it would delete every derived entry |
| E3 npm name syntax | covered — names come from npm itself, zod-validated |
| E4 `stars` nullable | aligned — sidecar absence means unknown ("partial stars beat none"); a check that treats absence as a defect is exactly the mistake their publish guard made |
| E5 url shape | covered — `repository` normalized + zod URL |
| E6 owner matches url | not applicable — our format has no owner/url pair |
| E7 category whitelist | covered — closed enum + zod; `theme` joins the same enum (§4) |
| E8 page url | not applicable — we carry no page URLs |
| E9 `added` not future | **added with the `added` field** (§3.2), enforced in the invariant check |
| E10 install command consistency | immune by construction — we carry no pre-rendered install command; the Host builds specs from snapshot fields, so the drift class E10 guards does not exist |
| E11 unique install identity | **to add** — explicit assertion, see below |
| E12 count integrity | **to add** — `index.json.count === plugins.length`, asserted |

Deliverable: a pure `assertCatalogInvariants(artifacts, now)` in
`emit.ts`, called before anything is written, throwing on violation
(fail loudly, never a warning):

- **E11**: no two entries share an install identity — `(source, name)`
  for npm entries, `(repo, subdir)` for github entries. npm-wins dedup
  already exists; this is the boundary assertion that it held.
- **E12**: `count === plugins.length` in the pointer, and the pointer's
  `schemaVersion` matches the data's.
- **E9**: every entry's `added` is present and not later than `now`.

One test per invariant. The mapping table itself is recorded in this
document as the consumer-contract reference.

## 3. Sub-project A — catalog data layer (one bump: v4 → v5)

### 3.1 `tarball`: release-tarball rescue for `requires-build` repos

Only the `requires-build` rejection class triggers probing (bounded
cost: the probe exists to rescue exactly that class). When the repo
gate finds `prepare`/`prepack`, it first asks the GitHub client for
`/repos/{owner}/{repo}/releases/latest`; a `.tgz`/`.tar.gz` asset
rescues the repo into a listed entry.

**The entry pins the release, not the commit** (deliberate, the fork
that was decided against keeping the commit pin):

- `version` = the release tag name; install target = the tarball URL,
  which the Host builds from snapshot fields — `shop/installStart`
  still takes `{ name, version }`, never a URL. pnpm accepts remote
  tarball specs through `dsh plugin add` (dsh passes specs verbatim;
  dsh-market installs tarball targets through the same machinery).
- The harvest downloads the tarball once and records its sha256 in the
  snapshot, beside the URL. GitHub release assets are immutable per
  URL (re-upload = new asset = new URL), so URL pinning plus the
  recorded hash is the audit story; the hash is not re-checked at
  install time.
- `outdated` = the harvest re-probes and finds a newer release tag.
  Re-probing happens when the repo's `pushedAt` advances (existing
  incremental machinery); otherwise the recorded tarball stands. The
  probe result lives in `repo-state.json` so a repo with no release
  does not re-consume the fetch budget daily.
- `verified` pins `reviewedVersion` = the release tag; the existing
  stale logic applies unchanged.
- Entry shape gains optional `tarball: { url, sha256 }`. Entries
  without it are unchanged.

### 3.2 `added`: first-listed date

- New build input `registry/first-seen.yml` (`name → YYYY-MM-DD`), the
  same class as `categories.yml`. The daily build appends names it has
  not seen with the build date, committed beside `manifest.lock`.
- One-time backfill for existing entries: first appearance in the
  `manifest.lock` git history — real dates, computed once, committed.
- Emitted as the entry field `added` for npm and github entries; the
  E9 check (§2) enforces "not later than the build date" and a listed
  entry with no first-seen row throws.

### 3.3 `replacement` pointers on denials

- `denied.yml` rows gain an optional `replacement` (npm name,
  shape-validated at config parse).
- The rejection detail for any denied row with a replacement becomes
  "Denied by the registry: \<reason\>. Known replacement: \<name\>."
  — the deprecated-npm rejection stays a rejection (decided; dsh-market
  marks instead, but deprecation is not a safety signal that justifies
  a new listing class here, and the pointer is what authors need to
  read).
- The published `denied[]` gains an optional `replacement` field.

### 3.4 `theme` category

The closed enum gains `theme`, in three places at once: the zod schema,
the LLM classifier's enum + parse validation, and `docs/schema.md`
(bilingual). `pnpm emit:schema` regenerates. The client renders it as
an ordinary category chip — no theme behavior (mutual exclusion, hot
switch) in this batch; the data lands first.

### 3.5 Schema-version choreography

All four changes ride one bump, **v4 → v5**, emitted behind
`SHOP_CATALOG_V5` (the v3→v4 precedent: flag flipped in the release
commit that ships the client able to parse it). The flag is a hard
requirement, not ceremony: `theme` is a new enum value, and an old
client's zod enum rejects a catalog containing it wholesale
(fail-loudly). The purely additive fields (`added`, `tarball`,
`replacement`) are backward-compatible, but one bump keeps one story.
The client half's zod gains `theme` in the same release.

## 4. Sub-project D — hot-mount (install / uninstall / update)

Scope decided as the full three paths — further than dsh-market, which
hot-mounts installs and toggles but does not swap updates.

**The wire contract does not change.** Hot-mounting happens inside the
existing install/uninstall flows, Host-side. `installStatus` already
carries `needsRestart`; its semantics change ("false" more often), the
shape does not. No new RPC methods; the §5.3 boundaries stand.

### 4.1 `host/hot.ts` (mechanism ported from their hot.ts)

- `loadHotTreeClass()`: dynamic `import('@deepseek-ai/cordis-plugin-include')`
  in try/catch. The package becomes an **optional peerDependency**
  (`^1.0.6`, `peerDependenciesMeta.optional: true`): an older harness
  installs fine and the import fails to a null class — every path then
  falls back to restart activation. The subclass suppresses `write()`
  (the loader otherwise persists tree changes back to the file it
  read) and shims client-only packages with a no-op `apply` (their
  `client-modules` requires a live loader entry to serve the client
  bundle).
- `parseSimplePatch`: plain `id`/`name` insert rows only, ported with
  their CRLF fix (a patch authored with Windows line endings must not
  read as "contains config rows"). Anything else → restart fallback.
- `hotMount(ctx, profileDir, packageName)`: writes `<profile>/.dsh-shop/hot-<n>.yml`
  (our own namespace; wiped at host start), rows under `mkt-` ids, then
  `ctx.plugin(HotTree, { path: fileURL })` and a timeout race
  (`DSH_SHOP_HOT_MOUNT_TIMEOUT_MS`, default 10s). Timeout or error →
  best-effort dispose, restart fallback. Handles kept in a map; the
  subtree unwinds with the shop's own fiber.
- `hotUnmount(packageName)`: `fiber.dispose()`.
- Loader access: extend the existing structural cast into a
  `loaderFor(ctx)` helper exposing `entries()` with `update(options,
  create, force)` and `fiber` — no dependency on cordis-plugin-loader.

### 4.2 The three paths

1. **Install**: after `dsh plugin add` succeeds and the bundle is
   confirmed → hotMount → `installStatus` reports live (restart: false)
   or `needsRestart` with a bilingual reason that distinguishes
   "restart will fix it" from "this package can never hot-mount"
   (their P0-2 distinction).
2. **Uninstall**: a plugin hot-mounted this session → hotUnmount (gone
   immediately); a bundle-layer entry → live-disable via
   `entry.update({disabled: true}, false, true)` with the
   retry-until-fiber-down loop (3 × 200ms, their theme-manager
   pattern), so the plugin's code stops the moment the uninstall
   completes — privilege is revoked now, the boot composition cleans
   up at next boot.
3. **Update**: disable the old entry (retry until its fiber is down —
   mandatory sequencing, see §0) → hotMount the new version. `mkt-`
   ids cannot collide with the still-present disabled entry. Next boot
   loads the new version through the normal bundle layer.

Explicitly excluded: the shop's own self-update (`shop/updateStart`)
keeps `needsRestart` — a host half cannot swap itself live.

### 4.3 Safety and tests

- No new attack surface: the mechanism is Host-internal and triggered
  by flows that already sit behind the catalog/acknowledgement gates.
- The §8 ruling ("inserting rows into the user layer does not avoid a
  restart") still holds and is untouched — the hot tree is an
  ephemeral Include subtree, never a `cordis.patch.yml` write.
- A hot-mounted plugin runs under its `mkt-<id>` entry id, not its
  real one; plugins that self-reference their entry id may misbehave.
  dsh-market accepted the same trade-off; we record it and keep the
  restart fallback as the answer.
- Tests: the three paths through the executor-level RPC tests (per the
  "test through the executor" rule); the fallback matrix (config rows /
  include plugin unimportable / activation timeout → needsRestart); and
  the web e2e gains a fixture plugin that proves its own liveness by
  registering an HTTP route from `apply()` — the pattern dsh-market's
  `install.e2e.ts` uses.

## 5. Decisions

1. tarball rescue, release-pinned entries — YES (§3.1).
2. `added` via first-seen.yml + one-time git backfill — YES (§3.2).
3. deprecated stays a rejection; `replacement` rides denials — YES (§3.3).
4. `theme` joins the enum; no theme UX this batch — YES (§3.4).
5. E9/E11/E12 as emit-time invariants — YES (§2).
6. systemd dual-signal guard, default hide, `allowRestart` escape — YES (§1 C-1).
7. forwards-only pinned by tests — YES (§1 C-2).
8. stale audit, no behavior change — YES (§1 C-3).
9. hot-mount for install/uninstall/update; wire contract unchanged — YES (§4).

## 6. Evaluated and not borrowed (this batch)

Recorded so they are not rediscovered as if new; each may return.

- `screenshots` catalog field (their E12 host-whitelist) — not requested.
- Catalog distributed as an npm package (their `dsh-plugin-catalog`,
  China-mirror reachability + rollback) — worth revisiting for the
  distribution side; our harvest fallback covers only fetching.
- Release channels for self-update — depends on release-process
  decisions that are out of scope here.
- Update checks via git ref advertisement — already immune (our
  outdated compares local pins to catalog data; no runtime GitHub calls).
- Agents guard (block installs while a host agent runs) — small,
  candidate for the next hardening batch.
- Log sanitization single choke point — same batch candidate.
- Preflight lockfile scan (mirror-resolved lockfiles publish fine and
  fail the consumer's install) — candidate for the publish workflow.
- Capability-gated public update API — their versioned-envelope
  discipline is the model if our Remote ever opens beyond the client.
- PR-curated submission model — contradicts D2 (zero-friction listing);
  not a technical choice to borrow from a curated registry.
- Themes UX (mutual exclusion, one-click switch) — data first (§3.4),
  behavior later.
