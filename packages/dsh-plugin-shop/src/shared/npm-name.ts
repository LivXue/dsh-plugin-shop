/**
 * The npm package-name grammar a catalogue row's `name` must satisfy.
 *
 * ONE definition, read in three places: the Host's entry schema
 * (`host/catalog.ts`), the registry's gate (`registry/scripts/src/gate.ts`)
 * and `emit`'s last-line invariant. The dependency can only point this way —
 * the package's tsconfig pins `rootDir: "src"`, so the registry reaches in
 * and nothing here can reach out (the same reason `shop-like.ts` lives here).
 *
 * Why it is narrower than npm's own rule: `validate-npm-package-name` accepts
 * a scope beginning with `_` or `.` — `@_iluxury/dsh-routerai-price-watcher`
 * is valid for a NEW publication — while this grammar requires the scope's
 * first character to be a letter or digit. That was a deliberate argv-safety
 * choice when the rule lived only in the client: the name becomes half of an
 * install spec, and everything this excludes is shell punctuation. It stopped
 * being merely a client rule the moment a catalogue shipped, because the
 * clients parse the WHOLE data file as one zod object: a single name outside
 * this grammar costs every listing, not one. On 2026-10-30
 * `@_iluxury/dsh-routerai-price-watcher` did exactly that — valid on npm, no
 * gate rule to catch it, and every 0.8.0+ shop answered 「暂时无法读取目录」
 * for a 21,493-row catalogue. The gate now admits only what this parses.
 *
 * The narrow side is therefore the WIRE CONTRACT, frozen by the installed
 * base: widening it in a client release also widens the gate, because this is
 * one constant, and the catalogue would then carry names every older client
 * still refuses. Do not widen it without a way to know which client versions
 * are installed; npm's per-version download counts cannot answer that (the
 * measurement is in `emit.ts`'s `peers` comment).
 *
 * @module shared/npm-name
 */

/**
 * An optional `@scope/`, then a name starting with a letter or digit and
 * continuing in lowercase letters, digits, `.`, `_` or `-`. No uppercase, no
 * leading dot or underscore on either segment, and no shell punctuation.
 */
export const CATALOG_NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * Whether a catalogue row can carry `name`.
 * @param name - the npm package name, taken from the published packument.
 */
export function isCatalogNpmName(name: string): boolean {
  return CATALOG_NPM_NAME.test(name)
}
