# Harness Compatibility Signalling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn a user, before and after installing, when a catalog plugin declares a peer dependency their harness does not provide.

**Architecture:** The registry copies each npm package's `peerDependencies` **names** into its catalog entry (schemaVersion 6, gated by `SHOP_CATALOG_V6`). The host resolves each distinct name once per snapshot through `createRequire` anchored at the profile, and publishes a map of package name → unresolved peer names. The client renders that one map in three places and never blocks an install.

**Tech Stack:** TypeScript (ESM, strict, `noUncheckedIndexedAccess`), vitest, zod, React 18, cordis.

**Spec:** [docs/design/2026-09-01-harness-compatibility.md](../design/2026-09-01-harness-compatibility.md)

## Global Constraints

- ESM everywhere; `.ts` extensions on local relative imports.
- `strict` and `noUncheckedIndexedAccess` are on. Guard index access; never assert it away.
- Every file ends with exactly one trailing newline.
- **The consumer-side `peers` field MUST be optional.** The live catalog is schemaVersion 5 and carries no such field; a required field is exactly how 0.5.0 broke every user.
- **Record every peer name — no filtering by name pattern.** Filtering to `@deepseek-ai/*` saves 11 KB of 410 KB and blinds the check to missing non-harness peers.
- **Presence only — never check version ranges.** The harness's own versions are prereleases (`0.1.1-rc.2`, `0.1.2-alpha.3`) which fail ordinary semver ranges, so range checks would mark working plugins incompatible.
- **Warn, never block.** The install proceeds when the person confirms.
- **The host publishes names; the client renders sentences** from `src/client/locales.ts` through dsh's locale service. No copy crosses the RPC.
- **An unavailable fact reads as "unknown", never as an accusation.** Any resolution failure other than a clean "module not found" yields no verdict.
- **Fixtures must be copied from real manifests**, not imagined. Both defects fixed on 2026-09-01 survived a green suite because a fixture agreed with the code's wrong assumption.
- `SHOP_CATALOG_V6` is set in `.github/workflows/daily.yml` **only** in the release commit that ships the reading client (Task 10). No earlier task touches it.

---

### Task 1: Harvest the peer names into the Candidate

**Files:**
- Modify: `registry/scripts/src/types.ts` (the `Candidate` interface)
- Modify: `registry/scripts/src/npm-client.ts:189-213` (`toCandidate`)
- Test: `registry/scripts/tests/npm-client.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `Candidate.peers: string[]` — the keys of the manifest's `peerDependencies`, in manifest order, `[]` when the field is absent or not an object.

- [ ] **Step 1: Write the failing tests**

Append to `registry/scripts/tests/npm-client.test.ts`, inside the existing `describe('toCandidate', ...)` block:

```ts
  it('keeps the names of the peer dependencies, dropping the ranges', () => {
    // Shape copied from dsh-timeline@0.1.4, the package whose peer on
    // @deepseek-ai/dsh-client-store broke a user's harness: every range there
    // is "*", which is why ranges are not recorded.
    const withPeers = {
      ...packument,
      versions: {
        '1.2.0': {
          ...packument.versions['1.2.0'],
          peerDependencies: {
            '@deepseek-ai/cordis': '*',
            '@deepseek-ai/dsh-client-store': '*',
            react: '^18.2.0',
          },
        },
      },
    }
    expect(toCandidate(withPeers)?.peers).toEqual([
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store',
      'react',
    ])
  })

  it('reads no peers when the manifest declares none', () => {
    expect(toCandidate(packument)?.peers).toEqual([])
  })

  it('reads no peers when peerDependencies is not an object', () => {
    const hostile = {
      ...packument,
      versions: { '1.2.0': { ...packument.versions['1.2.0'], peerDependencies: 'everything' } },
    }
    expect(toCandidate(hostile)?.peers).toEqual([])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts`
Expected: FAIL — `peers` is `undefined`, not an array.

- [ ] **Step 3: Add the field to the Candidate type**

In `registry/scripts/src/types.ts`, inside `export interface Candidate`, after the `keywords` field:

```ts
  /**
   * The names of the package's `peerDependencies`, without ranges. A peer is
   * what the environment must already provide, so an unresolvable one means
   * the plugin cannot run on this harness — the failure that broke a user on
   * 2026-09-01. Ranges are deliberately dropped: nearly every dsh plugin
   * declares `"*"`, and the harness's own prerelease versions do not satisfy
   * ordinary ranges, so checking them would accuse working plugins.
   */
  peers: string[]
```

- [ ] **Step 4: Read the field in toCandidate**

In `registry/scripts/src/npm-client.ts`, extend the manifest type near line 189 (the block already declaring `keywords?: unknown`) with:

```ts
      peerDependencies?: unknown
```

and add to the object returned at line 199, after the `keywords` entry:

```ts
    peers: manifest.peerDependencies !== null && typeof manifest.peerDependencies === 'object'
      ? Object.keys(manifest.peerDependencies)
      : [],
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run registry/scripts/tests/npm-client.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole registry suite for compile fallout**

Run: `pnpm test && pnpm typecheck`
Expected: PASS. Any other construction of a `Candidate` literal in tests now needs `peers: []`; add it where the compiler points.

- [ ] **Step 7: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/npm-client.ts registry/scripts/tests
git commit -m "feat(registry): harvest the peer dependency names"
```

---

### Task 2: Carry the peers onto the emitted Entry

**Files:**
- Modify: `registry/scripts/src/types.ts` (the `Entry` interface)
- Modify: `registry/scripts/src/tier.ts:30-50` (`assignTier`)
- Test: `registry/scripts/tests/tier.test.ts`

**Interfaces:**
- Consumes: `Candidate.peers: string[]` (Task 1).
- Produces: `Entry.peers?: string[]` — present exactly when the package declares at least one peer. Absent, not `[]`, when it declares none: an empty array on 28% of 4915 entries is bytes that say nothing.

- [ ] **Step 1: Write the failing tests**

Append to `registry/scripts/tests/tier.test.ts`, inside `describe('assignTier', ...)`:

```ts
  it('carries the candidate peer names onto the entry', () => {
    const input = accepted('dsh-other-plugin', '1.0.0')
    input.candidate.peers = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store']
    expect(assignTier(input, config).peers).toEqual(['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store'])
  })

  it('omits the field entirely when the package declares no peers', () => {
    const entry = assignTier(accepted('dsh-other-plugin', '1.0.0'), config)
    // Absent, not []: an empty array on every peerless entry is bytes that
    // carry no fact, on a file served to every reader.
    expect('peers' in entry).toBe(false)
  })
```

Also update the `accepted()` helper at `registry/scripts/tests/tier.test.ts:54` so its candidate literal compiles — add `peers: []` after `keywords: []`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run registry/scripts/tests/tier.test.ts`
Expected: FAIL — `entry.peers` is `undefined` in the first test.

- [ ] **Step 3: Add the field to the Entry type**

In `registry/scripts/src/types.ts`, inside `export interface Entry`, after the `added` field:

```ts
  /**
   * The package's declared peer dependency names, present exactly when it
   * declares any. The Host resolves them against the running installation to
   * tell the reader whether the plugin can run there; the catalog records the
   * requirement, never a verdict, because compatibility depends on who is
   * reading. Emitted only at schemaVersion 6 and above.
   */
  peers?: string[]
```

- [ ] **Step 4: Set it in assignTier**

In `registry/scripts/src/tier.ts`, inside `assignTier`, extend the `base` object (currently ending with `added: firstSeenOf(config, candidate.name),`):

```ts
    ...(candidate.peers.length > 0 ? { peers: candidate.peers } : {}),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run registry/scripts/tests/tier.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add registry/scripts/src/types.ts registry/scripts/src/tier.ts registry/scripts/tests/tier.test.ts
git commit -m "feat(registry): carry the peer names onto the catalog entry"
```

---

### Task 3: schemaVersion 6, gated

**Files:**
- Modify: `registry/scripts/src/emit.ts:14-24` (constants) and its `emit` function
- Modify: `registry/scripts/src/build.ts:222-224`
- Test: `registry/scripts/tests/emit.test.ts`

**Interfaces:**
- Consumes: `Entry.peers?: string[]` (Task 2).
- Produces: `export const PEERS_SCHEMA_VERSION = 6` from `registry/scripts/src/emit.ts`. Below 6, `peers` is stripped from every emitted entry.

**Why stripped rather than allowed to ride:** `added`, `tarball` and `replacement` ride lower versions because an old client's non-strict zod drops unknown keys harmlessly. `peers` is different only in size — it adds 410 KB to a 3.63 MB file, and paying that on every catalog fetch before any client can use it is waste. `CATALOG_SCHEMA_VERSION` stays 5; the theme downgrade keeps comparing against it.

- [ ] **Step 1: Write the failing tests**

Append to `registry/scripts/tests/emit.test.ts` (use the file's existing entry-fixture helper; if it builds entries inline, follow that shape and add `peers`):

```ts
describe('peers and schemaVersion 6', () => {
  const withPeers = {
    name: 'dsh-peered', version: '1.0.0', integrity: 'sha512-a', publishedAt: '2026-08-01T00:00:00.000Z',
    repository: 'https://github.com/you/x', license: 'MIT', tier: 'community' as const,
    metadata: 'derived' as const,
    catalog: { category: 'tool' as const, summary: { en: 'x' }, capabilities: [] },
    source: 'npm' as const, added: '2026-08-01',
    peers: ['@deepseek-ai/dsh-client-store'],
  }

  it('emits the peers at schemaVersion 6', () => {
    const artifacts = emit([withPeers], [], '2026-09-01T00:00:00.000Z', null, PEERS_SCHEMA_VERSION)
    const data = JSON.parse(artifacts.pluginsJson) as { schemaVersion: number; plugins: { peers?: string[] }[] }
    expect(data.schemaVersion).toBe(6)
    expect(data.plugins[0]?.peers).toEqual(['@deepseek-ai/dsh-client-store'])
  })

  it('strips the peers below schemaVersion 6', () => {
    const artifacts = emit([withPeers], [], '2026-09-01T00:00:00.000Z', null, CATALOG_SCHEMA_VERSION)
    const data = JSON.parse(artifacts.pluginsJson) as { schemaVersion: number; plugins: Record<string, unknown>[] }
    expect(data.schemaVersion).toBe(5)
    expect(data.plugins[0] !== undefined && 'peers' in data.plugins[0]).toBe(false)
  })
})
```

Add `PEERS_SCHEMA_VERSION` to the import from `../src/emit.ts` at the top of the file. Adjust the `emit(...)` argument list if the local signature differs — read `registry/scripts/src/emit.ts` before writing.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run registry/scripts/tests/emit.test.ts`
Expected: FAIL — `PEERS_SCHEMA_VERSION` is not exported.

- [ ] **Step 3: Add the constant**

In `registry/scripts/src/emit.ts`, after `export const CATALOG_SCHEMA_VERSION = 5`:

```ts
/** v6 adds `peers` — the package's declared peer dependency names, which the
 * Host resolves against the running installation (design
 * 2026-09-01-harness-compatibility). Gated because it is 410 KB on a 3.63 MB
 * file: no reason to serve it before a client can read it. */
export const PEERS_SCHEMA_VERSION = 6
```

- [ ] **Step 4: Strip below 6 in the emit map**

In `registry/scripts/src/emit.ts`, the `emitted` mapping currently downgrades `theme` below `CATALOG_SCHEMA_VERSION`. Replace it with a single pass that also strips `peers`:

```ts
  let themeDowngraded = 0
  const emitted = entries.map(entry => {
    let next = entry
    if (schemaVersion < CATALOG_SCHEMA_VERSION && next.catalog.category === 'theme') {
      themeDowngraded += 1
      next = { ...next, catalog: { ...next.catalog, category: 'other' as const } }
    }
    if (schemaVersion < PEERS_SCHEMA_VERSION && next.peers !== undefined) {
      const { peers: _peers, ...rest } = next
      next = rest
    }
    return next
  })
```

- [ ] **Step 5: Gate it in build.ts**

In `registry/scripts/src/build.ts`, extend the import on line 25 to include `PEERS_SCHEMA_VERSION`, then replace lines 222-223:

```ts
const v5Flag = process.env.SHOP_CATALOG_V5 === '1'
// The v6 catalog (peers) rides the v6 client, like every schema bump before
// it: the flag flips in the release commit that ships the reader.
const v6Flag = process.env.SHOP_CATALOG_V6 === '1'
const schemaVersion = v6Flag
  ? PEERS_SCHEMA_VERSION
  : v5Flag ? CATALOG_SCHEMA_VERSION : (probeSubpackages ? SUBPACKAGE_SCHEMA_VERSION : SCHEMA_VERSION)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run registry/scripts/tests/emit.test.ts && pnpm test && pnpm typecheck`
Expected: PASS. The determinism test in `pipeline.test.ts` must still pass untouched — if it fails, `peers` has leaked into something it must not affect; do not edit that test to make it green.

- [ ] **Step 7: Commit**

```bash
git add registry/scripts/src/emit.ts registry/scripts/src/build.ts registry/scripts/tests/emit.test.ts
git commit -m "feat(registry): schemaVersion 6 carries peers, behind SHOP_CATALOG_V6"
```

---

### Task 4: The consumer schema accepts peers — and still accepts v5

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts:9-14` and `:23-65`
- Test: `packages/dsh-plugin-shop/tests/host/catalog.test.ts`

**Interfaces:**
- Consumes: the v6 wire shape (Task 3).
- Produces: `SUPPORTED_SCHEMA_VERSION = 6`; `CatalogEntry.peers?: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dsh-plugin-shop/tests/host/catalog.test.ts`. Follow the file's existing pattern for building a pointer + data pair and a fake fetch; read the file first and reuse its helper rather than inventing one.

```ts
describe('peers (schemaVersion 6)', () => {
  it('parses a v6 entry carrying peers', async () => {
    // Names copied from dsh-timeline@0.1.4's real manifest.
    const result = await loadFixtureCatalog({
      schemaVersion: 6,
      plugins: [{ ...baseEntry, peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react'] }],
    })
    expect(result.snapshot.entries[0]?.peers).toEqual([
      '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react',
    ])
  })

  it('parses the live v5 shape, which has no peers field at all', async () => {
    // The 0.5.0 regression, in the shape that caused it: a required new field
    // made the client refuse the still-published older catalog outright.
    const result = await loadFixtureCatalog({ schemaVersion: 5, plugins: [baseEntry] })
    expect(result.snapshot.entries[0]?.peers).toBeUndefined()
    expect(result.snapshot.entries).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/host/catalog.test.ts` from `packages/dsh-plugin-shop`
Expected: FAIL — the v6 pointer is refused as newer than supported.

- [ ] **Step 3: Raise the supported version and add the field**

In `packages/dsh-plugin-shop/src/host/catalog.ts`, change line 14 to `export const SUPPORTED_SCHEMA_VERSION = 6` and extend the doc comment above it with:

```
 * 6 adds `peers`, the package's declared peer dependency names
 * (2026-09-01 harness compatibility).
```

In `entrySchema`, after the `tarball` field:

```ts
  // v6: the package's declared peer dependency names. OPTIONAL on the
  // consumer, and this is not a style preference: the live catalog is v5 and
  // carries no such field, and making `added` required is exactly what made
  // 0.5.0 refuse the published catalog for every user.
  peers: z.array(z.string()).optional(),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/host/catalog.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/tests/host/catalog.test.ts
git commit -m "feat(host): accept schemaVersion 6 peers, optional so v5 still parses"
```

---

### Task 5: The peer resolver and the verdict

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/peers.ts`
- Test: `packages/dsh-plugin-shop/tests/host/peers.test.ts`

**Interfaces:**
- Consumes: `CatalogEntry.peers?: string[]` (Task 4).
- Produces, from `src/host/peers.ts`:
  - `export type PeerResolver = (spec: string) => boolean`
  - `export function nodeResolver(baseUrl: string): PeerResolver`
  - `export function incompatibilityMap(entries: readonly { name: string; peers?: string[] }[], resolve: PeerResolver): Record<string, string[]>` — package name → unresolved peer names, keys present only for entries with at least one missing peer.

- [ ] **Step 1: Write the failing tests**

Create `packages/dsh-plugin-shop/tests/host/peers.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { incompatibilityMap, nodeResolver } from '../../src/host/peers.ts'

// The real division on the machine where this broke: everything the harness
// ships resolves from the profile anchor; dsh-client-store, which exists only
// on the 0.1.2-alpha line, does not.
const present = new Set(['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-locale', 'react'])
const resolve = (spec: string): boolean => present.has(spec)

describe('incompatibilityMap', () => {
  it('names the peers that did not resolve', () => {
    const map = incompatibilityMap(
      [{ name: 'dsh-timeline', peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store', 'react'] }],
      resolve,
    )
    expect(map).toEqual({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
  })

  it('omits an entry whose peers all resolve', () => {
    expect(incompatibilityMap([{ name: 'ok', peers: ['react'] }], resolve)).toEqual({})
  })

  it('omits an entry that declares no peers', () => {
    expect(incompatibilityMap([{ name: 'bare' }], resolve)).toEqual({})
  })

  it('reports a missing peer that is not a harness package', () => {
    // No name pattern: the check is uniform, so a missing `temml` is reported
    // exactly like a missing @deepseek-ai module.
    expect(incompatibilityMap([{ name: 'x', peers: ['temml'] }], resolve)).toEqual({ x: ['temml'] })
  })

  it('resolves each distinct name once however many entries share it', () => {
    let calls = 0
    const counting = (spec: string): boolean => { calls += 1; return present.has(spec) }
    incompatibilityMap(
      [
        { name: 'a', peers: ['@deepseek-ai/cordis', 'react'] },
        { name: 'b', peers: ['@deepseek-ai/cordis', 'react'] },
        { name: 'c', peers: ['@deepseek-ai/cordis'] },
      ],
      counting,
    )
    expect(calls).toBe(2)
  })

  it('treats a throwing resolver as no verdict rather than as missing', () => {
    // Silence, never a false alarm: an unavailable fact must not read as an
    // accusation against a plugin that may be perfectly fine.
    const throwing = (): boolean => { throw new Error('anchor unavailable') }
    expect(incompatibilityMap([{ name: 'x', peers: ['whatever'] }], throwing)).toEqual({})
  })
})

describe('nodeResolver', () => {
  it('resolves a package that exists and refuses one that does not', () => {
    const resolveHere = nodeResolver(import.meta.url)
    expect(resolveHere('vitest')).toBe(true)
    expect(resolveHere('@deepseek-ai/dsh-client-store-that-does-not-exist')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/host/peers.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `packages/dsh-plugin-shop/src/host/peers.ts`:

```ts
/** Harness compatibility: which declared peers the running installation does
 * not provide (design 2026-09-01-harness-compatibility). */

import { createRequire } from 'node:module'

/** Answers "can this installation provide `spec`?" — injected so fixtures
 * drive every verdict and exactly one call site touches the filesystem. */
export type PeerResolver = (spec: string) => boolean

/**
 * The production resolver: the same question the harness's own
 * ClientModuleRegistry asks, through a require anchored at the profile. Asking
 * what the loader asks is what keeps this verdict and the runtime's behaviour
 * from drifting apart.
 */
export function nodeResolver(baseUrl: string): PeerResolver {
  const require = createRequire(baseUrl)
  return spec => {
    try {
      require.resolve(`${spec}/package.json`)
      return true
    } catch {
      // Unresolvable is the answer, not an error: the peer is absent, which is
      // precisely the fact being reported.
      return false
    }
  }
}

/**
 * Package name → the peer names that did not resolve. A key is present only
 * when at least one peer is missing, so an absent key means "runs here, or we
 * could not tell" — the client renders nothing for either.
 *
 * A resolver that throws yields NO verdict at all: an unavailable fact must
 * never read as an accusation, because one false warning teaches a reader to
 * ignore every warning.
 */
export function incompatibilityMap(
  entries: readonly { name: string; peers?: string[] }[],
  resolve: PeerResolver,
): Record<string, string[]> {
  const known = new Map<string, boolean>()
  const out: Record<string, string[]> = {}
  for (const entry of entries) {
    if (entry.peers === undefined || entry.peers.length === 0) continue
    const missing: string[] = []
    let usable = true
    for (const spec of entry.peers) {
      let present = known.get(spec)
      if (present === undefined) {
        try {
          present = resolve(spec)
        } catch {
          // No verdict for this entry; see the doc comment above.
          usable = false
          break
        }
        known.set(spec, present)
      }
      if (!present) missing.push(spec)
    }
    if (usable && missing.length > 0) out[entry.name] = missing
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/host/peers.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/peers.ts packages/dsh-plugin-shop/tests/host/peers.test.ts
git commit -m "feat(host): resolve declared peers against the running installation"
```

---

### Task 6: Publish the verdict on the catalog RPC

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (imports, `ShopGatewayOptions`, `ShopCatalogResult`, the `catalog` method)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `incompatibilityMap`, `nodeResolver`, `PeerResolver` (Task 5).
- Produces:
  - `ShopGatewayOptions.resolvePeer?: PeerResolver`
  - `ShopCatalogResult.incompatible: Record<string, string[]>` — serves all three client renderings, since every surface is keyed by package name and `installed()` only ever returns catalog-backed rows.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dsh-plugin-shop/tests/host/index.test.ts`, using the file's existing `gatewayWithSnapshot` helper (read it first; pass `resolvePeer` through the options it forwards):

```ts
describe('ShopGateway.catalog incompatibility', () => {
  const peered = {
    name: 'dsh-timeline', version: '0.1.4', integrity: null, publishedAt: null, repository: null,
    license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-08-25',
    peers: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-client-store'],
  }

  it('names the missing peer on the catalog result', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 6, builtAt: '', entries: [peered], denied: [], stars: {} },
      { resolvePeer: (spec: string) => spec !== '@deepseek-ai/dsh-client-store' },
    )
    const result = await gateway.catalog({})
    expect(result.incompatible).toEqual({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] })
  })

  it('reports nothing when every peer resolves', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 6, builtAt: '', entries: [peered], denied: [], stars: {} },
      { resolvePeer: () => true },
    )
    expect((await gateway.catalog({})).incompatible).toEqual({})
  })

  it('reports nothing for a v5 catalog, whose entries carry no peers', async () => {
    const { gateway } = gatewayWithSnapshot(
      { schemaVersion: 5, builtAt: '', entries: [{ ...peered, peers: undefined }], denied: [], stars: {} },
      { resolvePeer: () => false },
    )
    expect((await gateway.catalog({})).incompatible).toEqual({})
  })
})
```

If `gatewayWithSnapshot` takes no options argument, extend it to accept and forward `Partial<ShopGatewayOptions>` rather than duplicating it.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/host/index.test.ts`
Expected: FAIL — `result.incompatible` is `undefined`.

- [ ] **Step 3: Wire it into the gateway**

In `packages/dsh-plugin-shop/src/host/index.ts`:

Add the import beside the other host-module imports:

```ts
import { incompatibilityMap, nodeResolver, type PeerResolver } from './peers.ts'
```

Add to `ShopGatewayOptions`, beside `inventory` and `loaderEntries`:

```ts
  /** Test-only injection: answers whether a peer resolves. Production builds
   * one from the profile anchor. */
  resolvePeer?: PeerResolver
```

Add to `ShopCatalogResult`, after `stars`:

```ts
  /** Package name → the declared peers this installation does not provide
   * (design 2026-09-01). A name is absent when the plugin runs here or when
   * no verdict could be formed; the client renders nothing for both. */
  incompatible: Record<string, string[]>
```

In the `catalog` method, after `this.lastSnapshot = snapshot`, build the map and return it:

```ts
    const resolve = this.options.resolvePeer ?? nodeResolver(pathToFileURL(join(this.profileDirResolved(), 'cordis.yml')).href)
    return {
      schemaVersion: snapshot.schemaVersion,
      builtAt: snapshot.builtAt,
      stale,
      plugins: snapshot.entries,
      denied: snapshot.denied,
      stars: snapshot.stars,
      incompatible: incompatibilityMap(snapshot.entries, resolve),
    }
```

`pathToFileURL` and `join` are already imported in this file; confirm before adding an import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/host/index.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "feat(host): publish the incompatibility map on the catalog RPC"
```

---

### Task 7: The copy and the pure mapping

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` (both dictionaries)
- Modify: `packages/dsh-plugin-shop/src/client/present.ts`
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`

**Interfaces:**
- Consumes: `ShopCatalogResult.incompatible` (Task 6).
- Produces:
  - Locale keys `incompatibleBadge`, `incompatibleDetail`, `incompatibleInstallWarning`.
  - `export function missingPeersOf(incompatible: Record<string, string[]>, name: string): string[]`

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/client/present.test.ts`:

```ts
describe('missingPeersOf', () => {
  it('returns the named missing peers', () => {
    expect(missingPeersOf({ 'dsh-timeline': ['@deepseek-ai/dsh-client-store'] }, 'dsh-timeline'))
      .toEqual(['@deepseek-ai/dsh-client-store'])
  })

  it('returns none for a name the host said nothing about', () => {
    expect(missingPeersOf({ 'dsh-timeline': ['x'] }, 'dsh-other')).toEqual([])
  })
})
```

Add `missingPeersOf` to the import from `../../src/client/present.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/client/present.test.ts`
Expected: FAIL — `missingPeersOf` is not exported.

- [ ] **Step 3: Add the copy**

In `packages/dsh-plugin-shop/src/client/locales.ts`, in the `zh` dictionary after `installedRestartNotice`:

```ts
  incompatibleBadge: '缺少依赖',
  incompatibleDetail: '此插件需要 {modules}，你当前的 dsh 未提供',
  incompatibleInstallWarning: '此插件需要 {modules}，你当前的 dsh 未提供；安装后它很可能无法加载。',
```

and the matching entries in `en`, in the same position:

```ts
  incompatibleBadge: 'missing dependency',
  incompatibleDetail: 'This plugin needs {modules}, which your dsh does not provide',
  incompatibleInstallWarning: 'This plugin needs {modules}, which your dsh does not provide; it will most likely fail to load once installed.',
```

- [ ] **Step 4: Add the mapping**

In `packages/dsh-plugin-shop/src/client/present.ts`, beside `tierKey`:

```ts
/** The peers the Host said this installation does not provide, or none when it
 * said nothing — a plugin that runs here and one the Host could not judge are
 * both rendered as no warning at all. */
export function missingPeersOf(incompatible: Record<string, string[]>, name: string): string[] {
  return incompatible[name] ?? []
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/client/present.test.ts && pnpm typecheck`
Expected: PASS. The `en` dictionary is `satisfies Record<ShopLocaleKey, string>`, so a missing key is a type error.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/locales.ts packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/tests/client/present.test.ts
git commit -m "feat(client): copy and mapping for the incompatibility notice"
```

---

### Task 8: The three renderings

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx`
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.module.css`
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `missingPeersOf` and the three locale keys (Task 7); `ShopCatalogResult.incompatible` (Task 6).
- Produces: DOM hooks `data-shop-incompatible` (badge, on the catalog card and the installed row) and `data-shop-incompatible-warning` (the install dialog line).

- [ ] **Step 1: Write the failing tests**

Append to `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`, following the file's existing `bench` / `renderTab` helpers. The catalog mock must return `incompatible`.

```ts
  it('badges a catalog entry whose peer the harness does not provide', async () => {
    const { injected } = bench(snapshot({ tier: 'community' }), {
      incompatible: { 'dsh-hello-plugin': ['@deepseek-ai/dsh-client-store'] },
    })
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(screen.getByText(en.incompatibleBadge)).toBeTruthy()
    expect(screen.getByText(/@deepseek-ai\/dsh-client-store/)).toBeTruthy()
  })

  it('warns inside the install gate but still lets the install proceed', async () => {
    const { injected, install } = bench(snapshot({ tier: 'community' }), {
      incompatible: { 'dsh-hello-plugin': ['@deepseek-ai/dsh-client-store'] },
    })
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    expect(container.querySelector('[data-shop-incompatible-warning]')).toBeTruthy()
    // Warn, never block: the confirm button is live and the install runs.
    fireEvent.click(container.querySelector('[data-shop-confirm]') as HTMLElement)
    await waitFor(() => expect(install).toHaveBeenCalled())
  })

  it('shows no badge when the host reported no incompatibility', async () => {
    const { injected } = bench(snapshot({ tier: 'community' }), { incompatible: {} })
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(container.querySelector('[data-shop-incompatible]')).toBeNull()
  })
```

`bench` must be extended to accept catalog-result overrides if it does not already; read it first.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/client/ShopTab.client.spec.tsx`
Expected: FAIL — no badge, no warning element.

- [ ] **Step 3: Thread the map and render the badge**

In `packages/dsh-plugin-shop/src/client/ShopTab.tsx`:

- Add `missingPeersOf` to the import from `./present.ts`.
- Hold the catalog result's `incompatible` in the same state the plugins list comes from, and pass `missing={missingPeersOf(incompatible, entry.name)}` into `EntryCard` (and into the installed-row component) as a `string[]` prop.
- Inside `EntryCard`, in the `css.badges` span beside the tier badge:

```tsx
          {missing.length > 0 && (
            <span className={css.incompatibleBadge} data-shop-incompatible title={t('incompatibleDetail', { modules: missing.join(', ') })}>
              {t('incompatibleBadge')}
            </span>
          )}
```

- Below the card's summary line, so the module names are readable without hovering:

```tsx
          {missing.length > 0 && (
            <p className={css.incompatibleDetail}>{t('incompatibleDetail', { modules: missing.join(', ') })}</p>
          )}
```

- Render the same badge block on the installed row.
- In `InstallPanel`, add a `missing: string[]` prop and render, inside the `gateOpen` branch between the title and the actions:

```tsx
        {missing.length > 0 && (
          <p className={css.gateWarning} data-shop-incompatible-warning>
            {t('incompatibleInstallWarning', { modules: missing.join(', ') })}
          </p>
        )}
```

- [ ] **Step 4: Add the styles**

In `packages/dsh-plugin-shop/src/client/ShopTab.module.css`, following the existing `.tierBadge` and `.notice` rules for colour tokens and spacing, add `.incompatibleBadge`, `.incompatibleDetail` and `.gateWarning`. Use the same warning token the file already uses for failure text; do not introduce a new colour literal.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/client/ShopTab.client.spec.tsx && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-shop/src/client
git add packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx
git commit -m "feat(client): badge and warn on a plugin this harness cannot run"
```

---

### Task 9: End-to-end against a real harness

**Files:**
- Create: `packages/dsh-plugin-shop/tests/fixtures/live-packages/dsh-shop-e2e-peer/package.json`
- Create: `packages/dsh-plugin-shop/tests/fixtures/live-packages/dsh-shop-e2e-peer/cordis.patch.yml`
- Create: `packages/dsh-plugin-shop/tests/fixtures/live-packages/dsh-shop-e2e-peer/index.js`
- Modify: `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts`

**Interfaces:**
- Consumes: everything above, through a real `dsh web` boot.
- Produces: no code other tasks use.

- [ ] **Step 1: Create the fixture package**

`package.json` — the peer name is the one that actually broke a user, so the fixture cannot drift from reality:

```json
{
  "name": "dsh-shop-e2e-peer",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "peerDependencies": { "@deepseek-ai/dsh-client-store": "*" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`cordis.patch.yml` — the shape published packages use:

```yaml
- insert:
    - id: e2e-peer
      name: dsh-shop-e2e-peer
```

`index.js` — copy the body of `tests/fixtures/live-packages/dsh-shop-e2e-live/index.js`, changing only whatever identifies the plugin.

- [ ] **Step 2: Write the failing e2e assertions**

In `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts`, add the fixture to the list built near line 104 (where `dsh-shop-e2e-live` is registered), give its catalog entry `peers: ["@deepseek-ai/dsh-client-store"]` in the fixture catalog the spec serves, and add a spec:

```ts
  it('badges a plugin whose peer this harness does not provide, and still installs on confirm', async () => {
    const card = dialog.locator('[data-shop-entry="dsh-shop-e2e-peer"]')
    await card.waitFor({ state: 'visible', timeout: 15_000 })
    await expect(card.locator('[data-shop-incompatible]')).toBeVisible()
    expect(await card.textContent()).toContain('@deepseek-ai/dsh-client-store')
    await card.locator('[data-shop-install]').click()
    await expect(card.locator('[data-shop-incompatible-warning]')).toBeVisible()
    await card.locator('[data-shop-confirm]').click()
    // Warn, never block.
    await card.locator('[data-shop-install-done], [data-shop-restart-notice]').first()
      .waitFor({ state: 'visible', timeout: 60_000 })
  })
```

Match the surrounding specs' locator names exactly — read them before writing, rather than trusting the names above.

- [ ] **Step 3: Run the e2e to verify it fails, then passes**

Run: `pnpm test`
Expected: the new spec FAILS before Tasks 6-8 are in place and PASSES after. Since those tasks precede this one, expect a first run that fails only on fixture wiring; fix that, then a green run.

- [ ] **Step 4: Commit**

```bash
git add packages/dsh-plugin-shop/tests
git commit -m "test(e2e): the incompatibility badge and warning against a real harness"
```

---

### Task 10: Release 0.6.0 through the beta tag

**Files:**
- Modify: `packages/dsh-plugin-shop/package.json`
- Modify: `README.md`, `README.zh.md`, `packages/dsh-plugin-shop/README.md`, `packages/dsh-plugin-shop/docs/README.zh.md`
- Modify: `.github/workflows/daily.yml`
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (the authority spec, amended in the same change)

**Interfaces:** none.

- [ ] **Step 1: Amend the authority spec**

Add `peers` to the catalog entry shape in `docs/design/2026-08-18-dsh-plugin-shop-design.md`, with a one-line pointer to `docs/design/2026-09-01-harness-compatibility.md`. The spec is the authority; a schema change that does not land there is a drift.

- [ ] **Step 2: Publish the beta**

Bump `packages/dsh-plugin-shop/package.json` to `0.6.0-beta.0`. **Do not touch the README pins** — they track `latest`. Do not set `SHOP_CATALOG_V6` yet.

```bash
pnpm -C packages/dsh-plugin-shop test
pnpm -C packages/dsh-plugin-shop typecheck
git add -A && git commit -m "chore: 0.6.0-beta.0 — harness compatibility, on the beta tag first"
git push origin main
cd packages/dsh-plugin-shop && npm publish --tag beta
```

- [ ] **Step 3: Verify the beta by hand, on a real profile**

Install `dsh-plugin-shop@0.6.0-beta.0`, open the shop against the **live v5 catalog**, and confirm: the catalog loads (the v5 parse is the 0.5.0 failure mode), and no entry is badged — v5 carries no `peers`, so every verdict must be silent. Stop here and report if anything is badged: a badge against a v5 catalog means a verdict was invented.

- [ ] **Step 4: Promote and flip the flag together**

Only after Step 3 passes. Bump to `0.6.0`, update the pin in all four READMEs, and add to the `build:catalog` env block in `.github/workflows/daily.yml`:

```yaml
          # The v6 catalog (peers) rides the v6 client: the flag flips in the
          # release commit that ships it, so no older client ever meets a
          # schemaVersion it refuses.
          SHOP_CATALOG_V6: '1'
```

```bash
pnpm test && pnpm typecheck
pnpm -C packages/dsh-plugin-shop test && pnpm -C packages/dsh-plugin-shop typecheck
git add -A && git commit -m "chore: release 0.6.0 — harness compatibility signalling"
git push origin main
cd packages/dsh-plugin-shop && npm publish
```

- [ ] **Step 5: Verify the release**

`npm view` is served from cache right after a write and will show stale values. Read the registry directly:

```bash
curl -s "https://registry.npmjs.org/dsh-plugin-shop?$(date +%s)" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(JSON.stringify(j['dist-tags']))})"
```

Then wait for the daily catalog build and confirm `index.json` reports `schemaVersion: 6` and that entries carry `peers`.

---

## Self-Review

**Spec coverage.** §2 recorded field → Tasks 1-3. §2 schemaVersion 6 → Task 3. §3 verdict, cost, degradation, test seam → Tasks 5-6. §4 three renderings, warn-never-block, no copy across the RPC → Tasks 7-8. §5 testing → the test step of every task plus Task 9. §6 release → Task 10. No section is unimplemented.

**No JSON-schema regeneration.** `registry/schema/plugin-entry.schema.json` is generated from the zod schema for the author-declared `dsh.catalog` section. `peers` is derived from `peerDependencies`, not author-declared, so it does not belong there and `pnpm emit:schema` is not part of this work. `docs/schema.md` likewise stays unchanged.

**Type consistency.** `PeerResolver`, `nodeResolver`, `incompatibilityMap`, `missingPeersOf`, `Candidate.peers`, `Entry.peers`, `CatalogEntry.peers`, `ShopGatewayOptions.resolvePeer`, `ShopCatalogResult.incompatible` and the three locale keys are spelled identically everywhere they appear above.

**Known soft spots for the implementer.** Three tasks depend on helpers whose current signatures must be read before writing: `gatewayWithSnapshot` (Task 6), `bench` (Task 8), and the e2e's fixture registration and locator names (Task 9). Each step says so. Extend those helpers rather than duplicating them.
