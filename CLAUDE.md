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
pnpm build:catalog  # ~1390 live npm requests, several minutes — see below
```

**`build:catalog` hits the public npm registry roughly 1390 times and takes minutes.** Do not run it to check that a change compiles; the tests cover every policy decision without a network. Run it when you have changed the fetching or writing layer and need to see it work end to end.

## The one architectural rule

**A pure core, an impure shell.**

- Pure: `gate.ts`, `tier.ts`, `emit.ts`, `pipeline.ts`, `schema.ts`, `types.ts`. No clock, no network, no filesystem, no environment. Every policy decision lives here, which is why fixtures can drive all of it.
- Impure: `npm-client.ts` and `llm-client.ts` (the only modules that reach the network), `build.ts` (reads the clock once, writes the artifacts), `config.ts` (reads the registry YAML), `emit-schema.ts` (writes the generated schema).

A policy decision that migrates into the shell becomes untestable. If a pure module needs the time, take it as a parameter — `build.ts` reads the clock exactly once and passes it down.

## Invariants worth breaking a build over

- **`builtAt` never enters the hashed content.** It belongs to `index.json` alone. Putting it in the data changes the content hash daily, invalidating every CDN cache and filling each commit with noise. A determinism test in `pipeline.test.ts` enforces this; if you find yourself editing that test to pass, you have broken the property it protects.
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
- Hitting the search page bound throws rather than truncating.
- A package that cannot be fetched becomes a `fetch-failed` rejection in the build report. Nothing disappears without a reason attached to its name.

Every rejection carries an author-readable `detail`. Those strings are published, and a plugin author reads them to find out why their package is not listed — a wrong or misattributed reason is a defect, not a wording nit.

## Untrusted input

Everything from npm is hostile: package names, descriptions, `dsh.catalog` contents, and the field names inside it. It reaches a published artifact, so validate at that boundary and escape anything rendered into the build report. Internal, typed values between our own modules do not need re-validation.

## Conventions

- ESM everywhere (`"type": "module"`); `.ts` extensions in local relative imports.
- `strict` and `noUncheckedIndexedAccess` are on. Guard index access; never assert it away.
- Files end with exactly one trailing newline.
- The zod schema is the single definition of the catalog section. `registry/schema/plugin-entry.schema.json` is generated from it and freshness-tested — regenerate it, never edit it.
- User-facing docs are bilingual (`X.md` + `X.zh.md`, `English | 中文` header link). The Chinese file states the same facts in its own register; it is not a word-for-word translation.
- **Design documents and specs are English only.** They are engineering records, not user surfaces.
- Catalog summaries carry the author's `en` and `zh`. The build never synthesizes a translation; a missing one stays missing.
- An empty `catch` names what it swallows and why nothing else can reach it.

## Testing

- Tests describe behavior. If a change makes a test obsolete, change it and say why — do not quietly edit an assertion to make a run green.
- **Verify test-data arithmetic.** Fixtures asserting an edit distance or a version comparison must actually have that property. Two fixtures in this repo shipped with distances that were wrong, and both passed for the wrong reason until a review recomputed them.
- Assert on every artifact a property claims to cover. A determinism test that checks one of four stable outputs establishes nothing about the other three.
- The pipeline is a pure function: prefer a fixture over a mock, and never mock the modules under test.
