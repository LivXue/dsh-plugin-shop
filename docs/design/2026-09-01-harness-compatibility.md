# Harness compatibility signalling — design

Status: **decided (2026-09-01), implementation pending.** The catalog
gains a per-entry record of a plugin's `peerDependencies` names; the host
resolves them against the running installation; the client annotates
incompatible entries in three places and warns — never blocks — before
installing one. The authority spec
(`2026-08-18-dsh-plugin-shop-design.md`) is amended in the same change.
English only, per convention.

## 0. The incident

A user installed `dsh-timeline@0.1.4` from the shop. On the next boot the
harness reported:

```
Failed to load plugins
failed to import loader entry d10c9e15 (dsh-timeline): client-modules:
require("@deepseek-ai/dsh-client-store") missed the module table — not a
platform seed word, not a materialized module, and no registered package
factory (a build-time externals drift, or a dynamic dependency that did
not arrive)
```

`dsh-timeline@0.1.4` declares sixteen peer dependencies, among them
`@deepseek-ai/dsh-client-store`. That package exists on npm only at
`0.1.2-alpha.2` — it belongs to the 0.1.2-alpha harness line. The user
runs `@deepseek-ai/dsh@0.1.1-rc.2`, whose tree does not contain it. The
plugin was built against a harness line the user is not on, and nothing
between the catalog and the install said so.

The shop listed the plugin (community tier, added 2026-08-25) and
installed it without a word. The catalog carries no compatibility fact of
any kind, so it could not have.

## 1. Evidence gathered before design

Each of these was measured against the live catalog or the installed
harness, not inferred.

- **The failing module is genuinely absent, and node resolution says so.**
  From the profile anchor, `@deepseek-ai/dsh-client-locale`,
  `@deepseek-ai/dsh-client-ui-conversation`, `@deepseek-ai/cordis` and
  `react` all resolve into the global harness tree;
  `@deepseek-ai/dsh-client-store` returns `MODULE_NOT_FOUND`. The oracle
  discriminates exactly the failing case, and it does so without any
  name pattern — `react` is not a `@deepseek-ai` package and resolves
  correctly.
- **That oracle is the harness's own.** `ClientModuleRegistry`
  (`@deepseek-ai/dsh-client-modules`, service name `clientModules`)
  builds its `resolvePkgJson` out of `createRequire(ctx.baseUrl)` and
  resolves each spec's `package.json` through it. Asking the same
  question the loader asks is what keeps our verdict and the runtime's
  behaviour from drifting apart.
- **`clientModules.table` is NOT that oracle.** `processOne` admits an
  entry only while `entry.fiber !== undefined && !entry.disabled`, so
  the table is "what is live", not "what is available". Reading
  availability out of it would report every not-yet-loaded module as
  missing.
- **Regular dependencies must not be checked.** `temml` is a plain
  dependency of `dsh-timeline` and correctly fails to resolve before the
  install — pnpm brings it with the package. Only `peerDependencies`
  describe what the environment must already provide.
- **Peer declarations are common and small.** In an evenly spaced
  50-entry sample of the live catalog, 36 entries (72%) declare
  peerDependencies; 35 (70%) declare at least one `@deepseek-ai/*` peer.
  The count per entry ranges 1–16.
- **Size, measured against the live 3.63 MB / 4915-entry
  `plugins.json`:** recording every peer name inline costs
  **+410 KB (+11.6%)**; restricting to `@deepseek-ai/*` saves only 11 KB
  of that; interning the names behind a shared table would cost ~74 KB
  in the sample (~90–110 KB extrapolated).
- **Version ranges would be noise.** All sixteen of `dsh-timeline`'s
  peers are declared `"*"`, as are most peers in the sample. Where a
  real range does exist, the harness's own prerelease versions
  (`0.1.1-rc.2`, `0.1.2-alpha.3`) do not satisfy ordinary semver ranges,
  so range checking would mark working plugins incompatible.

## 2. What is recorded

Each npm catalog entry gains an optional `peers`: the **names** of the
package's `peerDependencies`, verbatim from the manifest, no ranges.

```json
{
  "name": "dsh-timeline",
  "version": "0.1.4",
  "peers": ["@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store", "react", "…"]
}
```

**Names, not a derived verdict.** The catalog is one artifact served to
everyone; compatibility depends on the reader's own installation. So the
catalog records what the plugin *requires* — a reader-independent fact
copied from the manifest — and the verdict is formed on the machine that
knows the answer. Nothing in the pipeline guesses which harness version
first shipped a module, because such a map is a guess that goes stale
with every harness release and whose errors land on working plugins.

**Every peer name, unfiltered.** Filtering to `@deepseek-ai/*` saves 11 KB
of 410 KB and buys a name pattern — which this project rejects elsewhere
for good reason, and which would blind the check to a missing peer that
happens not to be a harness package.

**Inline, not interned.** Interning would save ~300 KB, and it is
declined: `plugins.json` is a published artifact that plugin authors read
to find out how their package was listed, and indices into a side table
are not something a person reads. 11.6% on a content-addressed file that
is re-fetched only when its hash changes does not buy back that
legibility.

**Ranges are out of scope**, per the evidence above: presence-only
catches the class of failure that occurred and produces no false
positives. A false warning teaches people to ignore every warning, which
costs more than the misses.

### schemaVersion 6

`peers` is additive, so the bump follows the established choreography:
`CATALOG_SCHEMA_VERSION = 6`, emitted only behind `SHOP_CATALOG_V6`, and
that flag flips in the same release commit that ships the client which
reads it (as `SHOP_HARVEST_REPOS`, `SHOP_HARVEST_SUBPACKAGES` and
`SHOP_CATALOG_V5` did before it).

## 3. How the verdict is formed

The host resolves each distinct peer name once per loaded snapshot:

```
resolvePeer(spec) = createRequire(profileBaseUrl).resolve(`${spec}/package.json`) succeeds
```

and reports, per entry, **the peer names that did not resolve** — an
empty list meaning compatible. The client receives names, not a boolean,
so every rendering can say which module is missing rather than that
something is wrong.

**Cost.** 4915 entries averaging ~3 peers is ~15,000 lookups, but the
distinct names number in the hundreds; a `Map<string, boolean>` built per
snapshot collapses the work to a few hundred synchronous resolutions,
themselves cached by node.

**Degradation is silence, never a false alarm.** If the profile anchor is
unavailable, or resolution throws for a reason other than
`MODULE_NOT_FOUND`, the entry carries **no verdict** and the client shows
nothing. This follows the same rule as the pluginInventory read: an
unavailable fact reads as "unknown", never as an accusation.

**Test seam.** A `resolvePeer?: (spec: string) => boolean` option, in the
same style as the existing `inventory`, `loaderEntries` and `hot`
injections, so fixtures drive every verdict and exactly one production
call site touches the filesystem.

**Boundary, stated plainly.** The verdict describes this machine at this
moment. It says nothing about version adequacy (§2), nothing about a
package's own dependencies (§1), and it cannot help while the harness is
too broken to start — at that point the shop is not running either. Its
value after the fact is that once dsh starts at all, the installed list
names the culprit and the missing module, instead of leaving a
hexadecimal entry id to reverse-engineer.

## 4. What the reader sees

One verdict, three renderings:

| Surface | Rendering |
|---|---|
| Catalog card | A badge naming the missing module(s) |
| Install acknowledgement | An added warning line in the existing dialog |
| Installed list | The same badge — where a user looks after a failure |

**Warn, never block.** The install proceeds if the person confirms. The
check is presence-only and this project does not know every way a plugin
might legitimately work; refusing an install on our inference would make
the shop wrong in a way the user cannot override.

**No copy crosses the RPC.** The host publishes module names; the client
renders sentences from its own dictionaries through dsh's locale service.
The alternative was tried and removed on 2026-09-01: hot-mount restart
reasons were bilingual strings baked into the host, and every reader got
both languages regardless of their dsh setting.

**Deliberately not built:** filtering or reordering the catalog by
compatibility, blocking an install, deriving a minimum harness version,
and checking version ranges.

## 5. Testing

- **Registry:** peer extraction driven by packument fixtures, including a
  package with no `peerDependencies` at all.
- **Host:** verdicts driven through the `resolvePeer` seam. Fixtures must
  carry the real shapes — a missing `@deepseek-ai/*` peer, a present one,
  a present non-`@deepseek-ai` peer (`react`), and a missing
  non-`@deepseek-ai` peer — copied from `dsh-timeline`'s actual manifest
  rather than imagined.
- **Client:** the pure name-list → locale-key mapping, and each of the
  three renderings.
- **E2E:** a live fixture package declaring a peer that cannot resolve,
  asserting the badge and the install warning appear and that the install
  still completes on confirmation.

The fixture rule is not ceremony. Both defects fixed on 2026-09-01
survived a green suite because a fixture written from the same wrong
assumption as the code agreed with it.

## 6. Release

1. The consumer-side `peers` field is **optional**. The live catalog is
   v5 and carries no such field; a client that requires it refuses the
   published catalog outright. This is exactly how 0.5.0 broke every
   user, and the parse must be proven against a v5 fixture.
2. `SHOP_CATALOG_V6` flips in the release commit that ships the reading
   client, never before.
3. The release goes through the `beta` dist-tag first. A version that
   changes what the host reads is precisely the class the channel exists
   for.
