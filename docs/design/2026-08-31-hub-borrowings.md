# Borrowings from the dsh-plugin-hub console — design draft

Status: **decided and implemented (2026-08-31).** Review of
[Noob-stupid/dsh-plugin-hub](https://github.com/Noob-stupid/dsh-plugin-hub)
concluded with four borrowable items and several deliberate non-borrows
(framework upgrade, AI-plan execution, Gitee/custom sources, the skills
market). Decision: **A, B, C implemented as recommended; D (live search)
dropped** — the browse-only surface was not worth the client churn; the
daily build remains the discovery cadence. The authority spec
(`2026-08-18-dsh-plugin-shop-design.md`) is amended in the same change that
implements them. English only, per convention. Where the implementation
diverged from this draft, the sections below say so (B's edit mechanism was
already built on the framework's own parser rather than the surgical text
edit drafted here).

## 0. Evidence gathered before design

- **pnpm git-subdir syntax is real**: `pnpm add
  github:changesets/changesets#<sha>&path:packages/apply-release-plan`
  resolved the subpackage manifest correctly and failed only on its
  `workspace:^` internal dependency — i.e. `&path:` works, and a
  self-contained subpackage (no `workspace:`-protocol deps) installs.
- **dsh passes specs verbatim to pnpm**: `dsh plugin add` classifies
  `github:` specs only to print a failure hint; nothing validates or rewrites
  them. A `github:owner/repo#sha&path:<dir>` spec reaches pnpm untouched.
- Their static index (500 repos by stars, 6h CI, jsDelivr) discovers
  installability at *browse* time (an enrich endpoint); we gate at *harvest*
  time. Nothing in A–D weakens that difference.

## A. Monorepo subpackage expansion

Today a repo whose root manifest declares no `dsh.bundle` is rejected
`no-bundle`. A share of those are monorepos whose *subpackage* is the plugin
(the hub's "聚合" class). A lists the installable ones.

- **Probe** (`github-client.ts`, shell): when the root manifest has no
  bundle, read the root's `workspaces` (array or object form) and/or probe
  `packages/*/package.json`, capped at 8 subpackage manifests per repo
  (budget: the probe costs the same raw fetches as the candidate itself).
- **Listable rule** (pure, `repo-gate.ts`): a subpackage is a candidate iff
  1. its manifest declares `dsh.bundle` (the silent-no-op rule, unchanged);
  2. it declares no `workspace:`-protocol dependency — the changesets
     failure class, uninstallable outside the workspace, author-readable
     reason;
  3. no `prepare`/`prepack` (the existing `requires-build` rule);
  4. license / something-to-show / denylist / similarity checks run on the
     subpackage name and the repo, as today.
- **Entry model**: name = subpackage name, `repo` = owner/slug,
  `version` = pinned commit, plus a new `subdir` field. `schemaVersion`
  bumps 3 → 4 with the same release-order protection as the github channel:
  the client release that parses v4 ships before the daily build's flag
  flip.
- **Install path**: the Host builds
  `github:owner/slug#commit&path:<subdir>` from snapshot fields — still
  never a client string. The argv-smuggling guard keeps applying (the spec
  contains `&`, which is why the executor stays spawn-argv, no shell).
  Pre-flight git check and post-flight bundle confirmation unchanged.
  `repo-pins.ts` pins `owner/slug#subdir` → commit, so outdated reporting
  keeps working.
- **npm-published subpackages**: already covered — the npm entry wins by
  bundle name (existing dedup). The git-subdir form only adds the
  unpublished ones.
- **Rejection detail** for a monorepo with no listable subpackage stays
  `no-bundle`, with the detail extended to say why (root has no bundle and
  no installable subpackage).
- **Harvest memory**: `repo-state.json` candidates gain `subdir`; the
  pushedAt/commit semantics are untouched.

## B. Installed-plugin toggle (HMR)

The shop's installed rows gain enable/disable. Scope: **shop-listed
entries only** — the full third-party inventory with its 70-row protected
list is a different product surface and stays out.

- **Mechanism (implemented)**: `shop/setEnabled { name, enabled }` —
  already shipped in the v0 of this surface — writes the user patch layer
  `$DSH_HOME/profiles/<p>/cordis.patch.yml` through the framework's own
  `loadOptionalPatches` parse + `js-yaml` dump (`setUserLayerRow` in
  `profile.ts`), a whole-file rewrite of the row list. This is the shipped,
  tested mechanism and replaces the surgical two-line edit this draft
  proposed; the framework parser is the authority on the file's shape
  (including `!!js` expressions), so editing through it beats hand-rolled
  text surgery.
- **Entry id**: resolved from the Loader plugin inventory service
  (`pluginInventory`, entryId + moduleName + enabled), not raw
  `loader.entries()` — the inventory already reports the real enabled
  state, which the row now renders.
- **Enabled state**: `shop/installed` gains `enabled` per row, read from
  the inventory; when the service is not mounted (an older harness) every
  row reads as enabled — the pre-inventory optimistic assumption, now
  explicit. The client switch initializes from it instead of assuming
  "installed ⇒ on", and the switch renders on every installed row
  (current and outdated), not only outdated ones.
- **Protection**: `setEnabled` refuses the shop's own row and any
  `@deepseek-ai/*` bundle — disabling the host chain would break HMR
  itself. Within the shop-listed scope that is the whole surface.
- **Non-interactions**: toggle ≠ uninstall — install pins, bundle
  registration, and the catalog all stay untouched; a disabled entry still
  reports installed with its version.

## C. Registry fallback chain (fetch layer only)

The harvest's npm fetches (search + packument) gain a backup registry for
transport failures. Installs are explicitly NOT touched — they run in the
user's profile through the user's pnpm and registry config.

- **Ordering**: primary `https://registry.npmjs.org`, backup
  `https://registry.npmmirror.com` (env `NPM_BACKUP_REGISTRY` to override
  or disable).
- **Fallback triggers**: network throw, timeout (a per-attempt
  `AbortSignal` bound, on top of the existing 429 budget — the "stall
  detection" borrowing), and 5xx. **Never on 404** — a not-found from the
  primary is authoritative and must not be re-litigated against a mirror.
- **Integrity**: the mirror serves npm's own metadata, including
  `dist.integrity`; our pinning compares content hashes, so a
  mirror-served answer is interchangeable with the primary's, and a
  tampered or mismatched mirror is caught by the integrity check at
  install time. Fetch-only keeps this risk bounded: the fallback never
  chooses what a user installs from.
- The daily build inherits this with no workflow change.

## D. Live search (browse-only) — DROPPED (2026-08-31)

Kept here for the record. The proposed browse-only live-search surface was
dropped by decision: the daily build remains the discovery cadence, and the
client churn did not earn its keep. Nothing in the record contradicts the
idea if it is ever revisited; the install invariant argument still stands.

## Decisions (2026-08-31)

1. **A**: git-subdir install form + schemaVersion-4 flag rollout — YES.
2. **B**: shop-listed-only toggle scope — YES.
3. **C**: backup registry default-on with npmjs primary — YES.
4. **D**: dropped — NO.

A also forced a harvest-memory fix that stands on its own: deterministic
fetch failures (`no-manifest`) are now recorded in `repo-state.json` (the
file's shape moves from a singular `candidate` to a `candidates` array plus
an optional `failure`, with a tolerant parse of the old shape), so known
dead ends stop re-consuming the per-run fetch budget every day — measured
2026-08-31: failures re-fetched forever, and the subpackage probe would
have multiplied their cost.
