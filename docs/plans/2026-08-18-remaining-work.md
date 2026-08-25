# Remaining work

Date: 2026-08-18 (launch state updated 2026-08-25; P1 state updated 2026-08-25)
Status: P0 merged and published; P1 complete; P2 not started

This is the handover document. It assumes you have no context from the session that built P0.

## How to pick this up

1. Read [CLAUDE.md](../../CLAUDE.md) — the architectural rules and invariants.
2. Read the spec, [docs/design/2026-08-18-dsh-plugin-store-design.md](../design/2026-08-18-dsh-plugin-store-design.md). It is the authority. Sections 5, 7, 8, and 9 are what P1 implements.
3. Skim [docs/notes/2026-08-18-p0-execution-ledger.md](../notes/2026-08-18-p0-execution-ledger.md) if you want to know why a decision was made the way it was. Every ruling taken during P0 is recorded there with its cost if wrong.
4. Then start at "Decisions only a human can make" below.

## Where things stand

P0 — the catalog pipeline — is complete: 24 commits on branch `feat/p0-registry`, merged into `main` and published on 2026-08-25 as https://github.com/LivXue/dsh-plugin-store. Pages serves the catalog at https://LivXue.github.io/dsh-plugin-store/v1/index.json.

- 82 tests across 7 files pass; `pnpm typecheck` is clean.
- The pipeline harvests by keyword, gates, tiers, and emits deterministic artifacts. `pnpm build:catalog` has been run once against the live registry and works end to end.
- The catalog format is at `schemaVersion` 2, because dual-track listings (spec D7) made `summary.zh` optional.

P1 — the Host half — is complete (2026-08-25, branch `feat/p1-host`, merged): the npm package `dsh-plugin-store` lives at `packages/dsh-plugin-store/` (the typert generator hardcodes `packages/` as its package container; spec §5.1 was amended accordingly), exposing the five `store/*` Remote methods. The P1 exit criterion — the real-installation test of spec §11.3.3 — passes against the real dsh CLI, locally and in CI (`plugin.yml`). Execution record: [2026-08-25-p1-host.md](2026-08-25-p1-host.md).

What does **not** exist yet: the Client half (`packages/dsh-plugin-store/src/client/`), and everything in spec sections 5.1 (component S Client half), 6.1 (the unclaimed rendering rule), 7.3 (the browser side of the contract), and 9.3 (the acknowledgement wording). That is P2.

### The one thing to understand before touching anything

The live ecosystem is real and it is large. Roughly 1390 npm packages already carry the `dsh-plugin` keyword; a 100-package sample found 94% declaring `dsh.bundle` and **none** declaring `dsh.catalog`. That measurement is what forced dual-track listings, and it is why the gate must never require a field this project invented. If you find yourself adding a required field to the author-facing contract, check it against that number first.

## Decisions only a human can make

These block a real launch, not the code.

1. **The GitHub owner and the published URL.** Both READMEs and the workflow assume `https://dsh-plugin-store.github.io/v1/index.json`, which is only correct if the GitHub account itself is named `dsh-plugin-store` and Pages serves from the repository root. If the repo lands under a different owner, the URL needs an extra path segment and both READMEs change together.
   → Resolved 2026-08-25: the repo lives at https://github.com/LivXue/dsh-plugin-store; the published URL is https://LivXue.github.io/dsh-plugin-store/v1/index.json. Both READMEs and the deploy environment's `url:` carry it.
2. **GitHub Pages must be configured with Source = "GitHub Actions"** in repository settings. Without it, `actions/deploy-pages` fails on its very first run with a "Get Pages site failed" error that reads like a workflow bug rather than a settings gap.
   → Resolved 2026-08-25: Pages enabled via the API with `build_type=workflow`.
3. **Whether `main` allows the Actions bot to push.** The daily workflow commits `registry/snapshots/manifest.lock`. Branch protection that blocks direct pushes makes that step fail — it is marked `continue-on-error` so the publish survives, but the snapshot then silently stops updating. Either allow the bot or move the snapshot to a pull request.
   → Resolved 2026-08-25: `main` carries no branch protection (verified via API), so the Actions bot may push directly.
4. **Who reviews.** The `verified` tier is worth exactly as much as the human review behind it. With no reviewers, every entry stays `community` and the store is an awesome-list with a UI. This is the project's largest non-technical risk and no amount of code addresses it.
   → Resolved 2026-08-25: review will be handled by a future workflow, tracked in https://github.com/LivXue/dsh-plugin-store/issues/1. Until it exists, `verified` stays empty on purpose.

## P1 — the Host half (done 2026-08-25)

The store's server side: `packages/dsh-plugin-store/src/host/`, registering the `store/*` Remote. Spec sections 5.3, 7.2, 7.3, and 9 define it. Exit criterion: the real-installation test in spec section 11.3 passes. Implemented per [2026-08-25-p1-host.md](2026-08-25-p1-host.md): all five `store/*` methods, catalog fetch/verify/cache with stale degradation, the four rejection paths through the executor, per-profile mutex, hot setEnabled, and the CI gate. Kept below as the record of the constraints P1 was built under.

Build it in this order, because the failure-prone parts come first:

1. **`store/catalog`** — fetch the published `index.json`, verify the data file's sha256 against the pointer, cache it on disk, and serve the cached copy with a `stale` flag when the network is unavailable. A `schemaVersion` higher than this build supports must be refused loudly, never silently degraded.
2. **`store/install`** and **`store/installStatus`** — the five rejection paths (`not-in-catalog`, `denied`, `version-mismatch`, `needs-acknowledgement`, plus the pnpm failure path) must be **tested through the executor**, not by asserting that a UI disabled a button. Progress is polled, not pushed; see the constraint below.
3. **`store/setEnabled`** and **`store/outdated`** — P3 in the spec's phasing, but they share the profile plumbing, so pick them up when that plumbing is fresh.

### Constraints P1 inherits, verified against the dsh source during design

- The Host accepts `{ name, version }`, never an arbitrary pnpm spec, and validates against its own cached snapshot rather than anything the browser sent.
- Installation shells out to `dsh plugin --profile <p> add <name>@<version>`. The orchestration lives in `apps/cli/src/plugin.ts` in the dsh repository and is **exported from no package**, so calling the binary is correct and copying its reconcile loop is not.
- **Progress must be polled.** `API_REMOTE_FORWARDED_EVENTS` in `packages/api/remotes/src/remote-events.ts` is a hardcoded in-repository array, so an out-of-tree plugin cannot push events to the browser.
- The store never writes `allowBuilds`. A plugin needing build scripts cannot be installed from the store; say so and print the CLI command.
- Installs serialize per profile behind a mutex. A pnpm failure surfaces stderr verbatim and never rolls back automatically.

## P2 — the Client half

`packages/dsh-plugin-store/src/client/`, contributing one tab to `settings.plugins.tab`. It holds no privilege beyond the five `store/*` methods.

Two requirements that are easy to miss:

- **A derived listing renders as unclaimed.** Spec section 6.1 requires it, and it is the signal that prompts an author to describe their own plugin. Do not render a derived entry as though the author wrote it.
- **`summary` and `description` render as plain text.** No Markdown, no links. That text comes from a third party's `package.json` and reaches the browser.

The community-tier acknowledgement must say what the spec's section 9.3 says: the plugin gets the same privileges as a built-in one — files, shell, and the model request stream — and has not been reviewed. Wording like "please install with care" carries no information and is not acceptable.

## Carried-over cleanups

None of these block a merge. They are recorded so they are not rediscovered as if they were new.

| Area | Item |
|---|---|
| `schema.ts` | `catalogSectionSchema` carries no explicit `z.ZodType<CatalogSection>` annotation, so shape drift surfaces at the consumer rather than the declaration |
| `config.ts` | Only the first zod issue is surfaced on a malformed registry file; two missing fields need two fix-and-rerun cycles |
| `config.ts` | `reviewedVersion` is validated as a non-empty string rather than as semver; a non-semver value is caught only downstream in the tier comparison |
| `emit.ts` | `Artifacts` documents only `pluginsFileName`; the other four fields have no per-field doc |
| `emit.test.ts` | The empty-catalog `manifestLock === ''` carve-out is verified only by hand, not asserted |
| `pipeline.test.ts` | The order-shuffle test uses `.reverse()` rather than a true shuffle |
| `npm-client.ts` | `normalizeRepository`'s plain-string form has no test; only the `{ url }` object form is exercised |
| `build.ts` | `CONCURRENCY = 8` is a hardcoded constant |
| `build.ts` | The wiring that shapes a fetch failure into a `fetch-failed` rejection has no test; `build.ts` is a top-level-await entry point with no exports |
| repo | No coverage gate is configured, so untested branches are not caught by CI |
| workflow | The `github-pages` environment has no `url:` wired to the deployment output, so the deployed URL does not surface in the GitHub UI |
| workflow | The step named "Publish to Pages" only uploads the artifact; the actual publish is the deploy job's step. Misleading when debugging a failed publish |

## Optional upstream PRs to DeepSeek Harness

None of these block anything. Each removes a workaround.

| # | Change | What it buys |
|---|---|---|
| U1 | Lift `runPlugin` into `dsh-app-boot` with injectable stdio | The store calls a library instead of locating the `dsh` executable |
| U2 | Move settings-namespace exposure from `WEB_SETTINGS_NAMESPACES` to `settings.register()` | Out-of-tree plugins can expose their own configuration card. That file already lists this as deferred work |
| U3 | Let out-of-tree plugins register forwarded events | Install progress becomes a push instead of a poll |
| U4 | Give `pluginInventory` a write path | The store stops orchestrating profile mutation itself |

## Working habits this repository earned the hard way

Both of these came from real defects caught in P0 review, not from theory.

- **Recompute test-data arithmetic.** Two fixtures shipped with edit distances that were wrong, and both passed for the wrong reason. If a fixture's name or comment claims a distance or a version relationship, verify it rather than trusting it.
- **Assert on every artifact a property claims to cover.** The determinism test originally checked one of four stable outputs, so a timestamp leaking into the build report would have gone unnoticed by the whole suite.
