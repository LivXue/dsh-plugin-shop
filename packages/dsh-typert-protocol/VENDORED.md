# Vendored: @deepseek-ai/dsh-typert-protocol

Vendored from `@deepseek-ai/dsh-typert-protocol@0.1.1-rc.2` (MIT): the compiled
`lib/` exactly as shipped on npm, its `LICENSE`, and the original manifest plus
the `./typert` export required by the workspace typert generator. This copy
exists for the typert build; it is never published.

The `./typert` paths are generated host artifacts, not files copied from the
upstream protocol package. The generator validates that the workspace manifest
declares them before it emits the shop's host face; `pnpm build` is the step
that creates the corresponding files in the shop package's `lib/` directory.

## Why it is vendored

`@deepseek-ai/dsh-typert-generator`'s analyzer (`isTypeMetaSymbol`) accepts
`@Remote` / `TypertRemoteService` symbols only when the declaration's file
belongs to a workspace package named `@deepseek-ai/dsh-typert-protocol`, and
workspace registrations come exclusively from project references under
`<root>/packages/`. An npm-installed protocol can never be recognized, so the
protocol is vendored as the workspace member `packages/dsh-typert-protocol/`.

This is build-time only: the built `lib/` still imports the bare
`@deepseek-ai/dsh-typert-protocol` specifier, which resolves to the app's own
copy at runtime through the flat module fallback.

## Re-syncing

A `@deepseek-ai/dsh-typert-protocol` version bump requires re-syncing this
copy: replace `lib/` with `cp -r <node_modules>/@deepseek-ai/dsh-typert-protocol/lib packages/dsh-typert-protocol/lib`, update the `version` in `package.json`, and record the new source version here.
