# CLAUDE.md

dsh-plugin-shop is the plugin market for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It harvests dsh plugins from npm, decides which may be listed, and publishes a catalog people install software from.

**Starting work? Read [docs/plans/2026-08-18-remaining-work.md](docs/plans/2026-08-18-remaining-work.md) first** — what is built, what is not, and what needs a human decision.

**The spec in [docs/design/](docs/design/) is the authority.** Code, tests, and prose follow it; when they disagree, the spec wins or the spec gets amended in the same change. Amending it is normal — [D7](docs/design/2026-08-18-dsh-plugin-shop-design.md) exists because running the harvest against the live registry disproved a premise the design was built on.

## Layout

```
registry/          The catalog pipeline. All of P0.
  schema/          plugin-entry.schema.json — GENERATED, never hand-edited
  verified.yml     Human review record, pinned per version
  denied.yml       Denylist, every entry states why
  allowed-similar.yml  Names cleared past the typosquatting hold
  snapshots/       manifest.lock, committed daily
  scripts/src/     Pipeline modules
  scripts/tests/   One test file per module
packages/dsh-plugin-shop/  The npm package dsh-plugin-shop
packages/dsh-typert-protocol/  Vendored @deepseek-ai/dsh-typert-protocol, build-time only
docs/design/       Specs. English only.
docs/plans/        Implementation plans.
docs/schema.md     Author-facing reference. Bilingual.
```

## Commands

```sh
pnpm install
pnpm test           # vitest
pnpm typecheck      # tsc --noEmit
pnpm emit:schema    # regenerate registry/schema/plugin-entry.schema.json
pnpm build:catalog  # thousands of live network requests, several minutes — see below
```

**`build:catalog` makes thousands of live network requests and takes minutes.** The npm half fetches one packument per harvested name — the deduplicated union of the two keywords, 5,658 on 2026-09-04 — plus about forty paged searches. The two keywords' own totals are deliberately not restated here: `PARTITION_KEYWORDS`'s comment in `registry/scripts/src/npm-client.ts` is the one place that measures and keeps them, because its partition arithmetic is counted against them, and three copies of that figure had already drifted apart on the same date. The GitHub half re-fetches up to `REPO_BACKFILL_BUDGET` (2,000 by default) of the 14,740 repositories in `repo-state.json`, several requests each. The figure this replaced was one keyword's size in August 2026 quoted as if it were the whole run; it predated both the second keyword and the GitHub half. The figure tracks the ecosystem, so re-measure it with one `size=1` search per keyword rather than trusting the number written here. Do not run the build to check that a change compiles; the tests cover every policy decision without a network. Run it when you have changed the fetching or writing layer and need to see it work end to end.

## The one architectural rule

**A pure core, an impure shell.**

- Pure: `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`, `types.ts`, `identity.ts`. No clock, no network, no filesystem, no environment — and no locale: every comparison is code-unit, because a locale-aware sort would make the published bytes depend on the machine. Every policy decision lives here, which is why fixtures can drive all of it.
- Impure: `npm-client.ts`, `llm-client.ts`, and `github-stars.ts` (the only modules that reach the network), `build.ts` (reads the clock once, writes the artifacts), `config.ts` (reads the registry YAML), `emit-schema.ts` (writes the generated schema).

A policy decision that migrates into the shell becomes untestable. If a pure module needs the time, take it as a parameter — `build.ts` reads the clock exactly once and passes it down.

## Invariants worth breaking a build over

- **`builtAt` never enters the hashed content.** Putting it in the data changes the content hash daily, invalidating every CDN cache and filling each commit with noise. A determinism test in `pipeline.test.ts` enforces this; if you find yourself editing that test to pass, you have broken the property it protects. Outside the hash it travels freely — `index.json`, the npm package's readme, and its `catalogBuiltAt` manifest field, which `publish-catalog.ts` reads to refuse a build older than the published `latest`; all three are regenerated per publish, so none of them churn a hash.
- **Live daily data stays in its own sidecar.** Star counts change every day; they live in a separate content-addressed `stars.<sha>.json` so the plugin data hash never churns daily. The same rule as `builtAt`, applied to data.
- **Entries sort by package name before emit.** Output must not depend on the order npm returned them in.
- **`verified` pins a version, never a name.** A published version newer than `reviewedVersion` downgrades to `verified-stale` and keeps the review. Attaching verification to a package name lets an author pass review once and inherit trust for every future version — the cheapest supply-chain attack there is.
- **Tiering and metadata are orthogonal.** `tier` answers "has a human read this?", `metadata` answers "did the author describe it?". A derived listing can be verified; do not couple them.
- **Harvest by keyword, never by name pattern.** A name pattern is trivially spoofed.
- **LLM output is advisory.** The classifier may change a category, never gate a listing, never remove an entry, and never block a publish. A failed classification leaves the entry unclassified and is retried on the next build; `categories.yml` is a build input like `verified.yml`.

## Failing loudly

This project would rather stop than publish something plausible and wrong. Concretely:

- A malformed registry file throws. Silently listing nothing is indistinguishable from an empty ecosystem.
- A duplicate name in `verified.yml` or `denied.yml` throws. Last-one-wins would silently pick a review.
- A malformed `dsh.catalog` is rejected, never downgraded to a derived listing. The author declared it and got it wrong; hiding that leaves them wondering why their text never appeared.
- **A search that cannot enumerate its whole result set throws rather than truncating.** One npm query reaches 5,250 names (`from` is capped at 5,000, and a larger one silently returns page 0), so an over-window keyword is partitioned on `keywords:a,b` intersections — the only filtering qualifier the API honors, and it has no negation, so a partition is never covering by construction. The harvest therefore measures what it enumerated against the keyword's own total and throws on a shortfall; it stops paging on the answered `total`, never on a short page, and a response carrying no `total` throws too. The GitHub half splits each topic into stars/date/size windows under the 1,000-result search cap and throws when one still exceeds it after every split. `keywords:deepseek-harness` was 118 names short of the npm window on 2026-09-04 and is closing on it; that headroom is `SEARCH_WINDOW` less the keyword total `npm-client.ts` records, so re-derive it there rather than trusting this sentence.
- A package that cannot be fetched becomes a `fetch-failed` rejection in the build report. Nothing disappears without a reason attached to its name.

Every rejection carries an author-readable `detail`. Those strings are published, and a plugin author reads them to find out why their package is not listed — a wrong or misattributed reason is a defect, not a wording nit. `no-license`, `no-repository` and above all `no-manifest` are knowingly broader than the cases they name. A `license` or `repository` past its length bound reports `no-license` / `no-repository`; `no-manifest` is the code for every way a manifest we DID read cannot be listed — refused for its size, unreadable, over-bounded in `name`, `version` or `publisher`, past the per-entry payload budget, declaring a name outside the bundle-name grammar, declaring no name and no installable subpackage, or naming a subpackage directory past its bound. So the report's Reason column can read "no" about a field the author did declare. The `detail` is the accurate half and says which bound was crossed; a new code is a change to a published artifact, so the fix is to keep the reason in the `detail`, not to mint one. Resist restating that list as a count — "three codes" is what this sentence said until the set grew and the number quietly became false.

The converse is the invariant that keeps `no-manifest` meaningful, and it is two-sided: **`no-manifest` means the manifest was read, or a 404 answered for it — never that a request failed.** A transport failure is `fetch-failed`, which `harvestRepos` does not persist and the next build retries. Collapsing the two is what made a blocked `raw.githubusercontent.com` write "No package.json at the repository root" into the durable record of every repository it could not reach.

## Untrusted input

Everything from npm is hostile: package names, descriptions, `dsh.catalog` contents, and the field names inside it. It reaches a published artifact, so validate at that boundary and escape anything rendered into the build report. Internal, typed values between our own modules do not need re-validation.

## Conventions

- ESM everywhere (`"type": "module"`); `.ts` extensions in local relative imports.
- `strict` and `noUncheckedIndexedAccess` are on. Guard index access; never assert it away.
- Files end with exactly one trailing newline.
- The zod schema is the single definition of the catalog section. `registry/schema/plugin-entry.schema.json` is generated from it and freshness-tested — regenerate it, never edit it.
- User-facing docs are bilingual (`X.md` + `X.zh.md`, `English | 中文` header link). The Chinese file states the same facts in its own register; it is not a word-for-word translation.
- The READMEs pin the current version in their install commands (`dsh-plugin-shop@<version>` — the explicit pin is the only way past pnpm 11's release cooldown). A release commit updates the pin in all four READMEs together with `package.json`.
- **Design documents and specs are English only.** They are engineering records, not user surfaces.
- Catalog summaries carry the author's `en` and `zh`. The build never synthesizes a translation; a missing one stays missing.
- An empty `catch` names what it swallows and why nothing else can reach it.

## Release channels

npm carries two dist-tags. `latest` is what `dsh plugin add dsh-plugin-shop` installs; `beta` is where a release goes to be proven first.

```sh
pnpm -C packages/dsh-plugin-shop test       # includes the live-harness e2e
pnpm -C packages/dsh-plugin-shop typecheck
npm publish --tag beta                      # X.Y.Z-beta.N — latest untouched
# install that build on a real profile and use the thing that changed, then:
npm publish                                 # X.Y.Z — moves latest
```

A prerelease version (`X.Y.Z-beta.N`) is mandatory for the beta tag: it keeps `latest` resolution away from the build even if the tag is ever mistyped, and semver orders a prerelease BELOW its own release, so the self-update check tells a beta tester to move to the stable build the moment it ships and never the other way. The shop reads `dist-tags.latest` alone, so a stable user never sees a beta.

**A version that changes what the host reads — the catalog schema, an RPC shape, a harness service — goes through `beta` first.** 0.5.0 through 0.5.2 each shipped straight to `latest` and each was broken for every user within minutes: a required field the live catalog did not have, then a service shape we had guessed, then an ownership key the loader does not use. Not one of them would have survived installing the build once, by hand, before promoting it — and no test suite caught them, because a fixture written from the same wrong assumption agrees with it.

The beta commit bumps `package.json` only. **README install pins track `latest`**, so they move in the promotion commit, never in the beta — a pinned prerelease in the README hands every reader the untested build.

## Testing

- Tests describe behavior. If a change makes a test obsolete, change it and say why — do not quietly edit an assertion to make a run green.
- **Verify test-data arithmetic.** Fixtures asserting an edit distance or a version comparison must actually have that property. Two fixtures in this repo shipped with distances that were wrong, and both passed for the wrong reason until a review recomputed them.
- Assert on every artifact a property claims to cover. A determinism test that checks one of four stable outputs establishes nothing about the other three.
- The pipeline is a pure function: prefer a fixture over a mock, and never mock the modules under test.
