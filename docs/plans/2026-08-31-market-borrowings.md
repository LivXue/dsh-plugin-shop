# Market Borrowings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the nine dsh-market borrowings — host hardening, publish-time invariants, the catalog v5 data layer, and restart-free hot-mount — in four phases.

**Architecture:** Phase C hardens the shop Host (supervisor detection, forwards-only pin, stale audit). Phase B adds emit-time catalog invariants (E11/E12). Phase A extends the catalog schema (tarball rescue, `added`, `replacement`, `theme`) behind a v5 flag with release-order choreography. Phase D ports dsh-market's Include-tree hot-mount into the shop's install/uninstall/update flows without changing the wire contract.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), zod v4, vitest, node `--experimental-strip-types` for registry scripts, cordis 4 (`ctx.plugin` → Fiber), `@deepseek-ai/cordis-plugin-include` (optional peer).

**Spec:** [docs/design/2026-08-31-market-borrowings.md](../design/2026-08-31-market-borrowings.md) — the plan argues from the spec, so the spec travels with it; executors read both. The authority spec ([2026-08-18-dsh-plugin-shop-design.md](../design/2026-08-18-dsh-plugin-shop-design.md)) is amended in the same change that implements Phase A (Task A-7).

## Global Constraints

- Pure core (gate.ts, tier.ts, emit.ts, pipeline.ts, schema.ts, types.ts, and any new pure module) touches no clock, network, filesystem, or environment. Time arrives as a parameter; `build.ts` reads the clock once.
- ESM everywhere (`"type": "module"`); local relative imports use `.ts` extensions.
- `strict` and `noUncheckedIndexedAccess` are on. Guard index access; never assert it away.
- Files end with exactly one trailing newline.
- Registry tests run with `pnpm test` (vitest) from the repo root; shop-package tests with `cd packages/dsh-plugin-shop && pnpm test`. Run both before every commit. Typecheck: `pnpm typecheck` (root) and `cd packages/dsh-plugin-shop && pnpm typecheck`.
- Rejections must be tested through the executor/RPC, never by asserting a UI button state.
- `builtAt` never enters the hashed content; entries sort by package name before emit; every rejection carries an author-readable `detail`.
- User-facing docs are bilingual; design docs and plans are English only.
- Never run `pnpm build:catalog` to check compilation — it performs ~1390 live npm requests.
- Do not commit `packages/dsh-plugin-shop/tests/client/self-update-repro.spec.ts` (pre-existing untracked work, not part of this plan).

---

## Phase C — Host hardening

### Task C-1: `detectSupervisor` — pure systemd detection

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/supervisor.ts`
- Test: `packages/dsh-plugin-shop/tests/host/supervisor.test.ts`

**Interfaces:**
- Produces: `export type Supervisor = 'systemd' | null`; `export interface ProcessSnapshot { ppid: number }`; `export function detectSupervisor(env: Record<string, string | undefined>, proc: ProcessSnapshot): Supervisor` — pure, consumed by Task C-2.

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-plugin-shop/tests/host/supervisor.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { detectSupervisor } from '../../src/host/supervisor.ts'

describe('detectSupervisor', () => {
  it('detects systemd only when an env marker AND ppid 1 both hold', () => {
    expect(detectSupervisor({ INVOCATION_ID: 'abc' }, { ppid: 1 })).toBe('systemd')
    expect(detectSupervisor({ JOURNAL_STREAM: '8:123' }, { ppid: 1 })).toBe('systemd')
    expect(detectSupervisor({ INVOCATION_ID: 'abc', JOURNAL_STREAM: '8:123' }, { ppid: 1 })).toBe('systemd')
  })

  it('returns null when the process is not the unit main process', () => {
    // INVOCATION_ID is inherited by every descendant of a unit (an ordinary
    // terminal included); ownership needs ppid 1 too.
    expect(detectSupervisor({ INVOCATION_ID: 'abc' }, { ppid: 4321 })).toBe(null)
    expect(detectSupervisor({ JOURNAL_STREAM: '8:123' }, { ppid: 4321 })).toBe(null)
  })

  it('returns null without any marker', () => {
    expect(detectSupervisor({}, { ppid: 1 })).toBe(null)
    expect(detectSupervisor({ PATH: '/usr/bin' }, { ppid: 1 })).toBe(null)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/supervisor.test.ts`
Expected: FAIL — cannot resolve `../../src/host/supervisor.ts`.

- [ ] **Step 3: Write the implementation**

Create `packages/dsh-plugin-shop/src/host/supervisor.ts`:

```ts
/** systemd-supervisor detection for `shop/restart` (design 2026-08-31
 * market-borrowings C-1).
 *
 * Pure: the environment and the process snapshot are parameters, so the
 * policy is fixture-driven. Two signals are required on purpose:
 * `INVOCATION_ID` (and `JOURNAL_STREAM`) are inherited by every descendant
 * of a unit — an ordinary terminal opened inside a service would carry them
 * too. Only the unit's own main process has ppid 1; hiding the restart button
 * for anything else would be the worse bug (dsh-market's restart.ts:31-44
 * documents the same measured failure). */
export type Supervisor = 'systemd' | null

export interface ProcessSnapshot { ppid: number }

export function detectSupervisor(
  env: Record<string, string | undefined>,
  proc: ProcessSnapshot,
): Supervisor {
  const marked = env.INVOCATION_ID !== undefined || env.JOURNAL_STREAM !== undefined
  return marked && proc.ppid === 1 ? 'systemd' : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/supervisor.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/supervisor.ts packages/dsh-plugin-shop/tests/host/supervisor.test.ts
git commit -m "feat(host): pure systemd-supervisor detection for the restart guard"
```

### Task C-2: restart guard, `allowRestart` escape, `restartSupported` in `shop/version`

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (options, row config, `restart()`, `version()`)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts` (extend)

**Interfaces:**
- Consumes: `detectSupervisor` from Task C-1.
- Produces: `ShopVersionResult` gains `restartSupported: boolean`; `ShopGatewayOptions` gains `allowRestart?: boolean`, `env?: NodeJS.ProcessEnv`, `ppid?: number`; `ShopRowConfig` gains `allowRestart?: unknown`. The `shop/restart` refusal detail is the fixed string below — Task C-3 renders around it.

- [ ] **Step 1: Extend `ShopGatewayOptions` and `ShopRowConfig`**

In `packages/dsh-plugin-shop/src/host/index.ts`, add to `ShopGatewayOptions` (after `pinFs?`):

```ts
  /** Test-only injection: the explicit `allowRestart` override; production
   * reads the loader row's `config.allowRestart`. */
  allowRestart?: boolean
  /** The environment `detectSupervisor` reads; production uses process.env. */
  env?: NodeJS.ProcessEnv
  /** The pid `detectSupervisor` inspects; production uses process.pid. */
  ppid?: number
```

Change `ShopRowConfig` (line ~116):

```ts
interface ShopRowConfig {
  catalogUrl?: unknown
  cacheDir?: unknown
  allowRestart?: unknown
}
```

Add imports at the top: `import { detectSupervisor } from './supervisor.ts'`.

- [ ] **Step 2: Add the gateway fields and the override reader**

In the constructor, after `this.pinFs = ...` add:

```ts
    this.allowRestart = options.allowRestart
    this.env = options.env ?? process.env
    this.ppid = options.ppid ?? process.pid
```

Add the field declarations near the other privates (after `private readonly pinFs: RepoPinFs`):

```ts
  private readonly allowRestart?: boolean
  private readonly env: NodeJS.ProcessEnv
  private readonly ppid: number
```

Add a private method next to `rowConfig()`:

```ts
  /** The explicit restart override. Only the row's `config:` sub-object is
   * passed to a plugin — a top-level `allowRestart:` beside `name:` would be
   * silently ignored by the loader (dsh-market README, #227). */
  private allowRestartConfigured(): boolean {
    if (this.allowRestart !== undefined) return this.allowRestart
    const loader = (this.ctx as unknown as {
      loader?: { entries(): Array<{ options: { name?: string; config?: unknown } }> }
    }).loader
    const entry = loader?.entries().find(entry => entry.options.name === 'dsh-plugin-shop')
    const config = entry?.options.config as ShopRowConfig | undefined
    return config?.allowRestart === true
  }
```

- [ ] **Step 3: Add the supervisor pre-flight to `restart()`**

In `restart()` (before the `--port 0` check), insert:

```ts
    // Under a systemd unit the two-phase handoff kills itself: the main
    // process exiting also kills the unit's cgroup, taking the detached
    // helper with it, and the service never comes back. Refuse before
    // anything is torn down unless the user explicitly allowed it.
    if (detectSupervisor(this.env, { ppid: this.ppid }) === 'systemd' && !this.allowRestartConfigured()) {
      return {
        ok: false,
        detail: 'dsh-plugin-shop: restart is disabled because this process is a systemd service — a restart would kill the takeover helper along with the unit, and the service would not come back. Set allowRestart: true in the shop row config to override.',
      }
    }
```

- [ ] **Step 4: Report `restartSupported` in `shop/version`**

Change `ShopVersionResult`:

```ts
export interface ShopVersionResult {
  installed: string
  latest: string | null
  outdated: boolean
  /** Whether `shop/restart` is usable: false when a supervisor owns this
   * process and no `allowRestart` override is set. The client hides the
   * restart offer on false but keeps the pending-change notice. */
  restartSupported: boolean
}
```

Change `version()` to return it:

```ts
      restartSupported: detectSupervisor(this.env, { ppid: this.ppid }) === null || this.allowRestartConfigured(),
```

- [ ] **Step 5: Write the tests**

Open `packages/dsh-plugin-shop/tests/host/index.test.ts`. If it does not already export a helper that constructs a `ShopGateway` with injected `catalogUrl`/`cacheDir`, note the existing pattern and mirror it. Add a `describe('restart guard', ...)`:

```ts
describe('restart guard (systemd)', () => {
  const gatewayOptions = () => ({
    catalogUrl: 'https://shop.test/v1/', cacheDir: '/tmp/shop-cache',
    exit: () => {}, restartExitDelayMs: 0,
  })

  it('refuses restart when systemd owns the process', async () => {
    const gateway = new ShopGateway({} as never, { ...gatewayOptions(), env: { INVOCATION_ID: 'abc' }, ppid: 1 })
    const result = await gateway.restart()
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.detail).toContain('systemd')
  })

  it('allows restart when the row config overrides', async () => {
    const gateway = new ShopGateway({} as never, { ...gatewayOptions(), allowRestart: true, env: { INVOCATION_ID: 'abc' }, ppid: 1 })
    // startRestart is spawned; the test injects exit and a dead parent pid so
    // nothing really restarts. Assert the call was committed.
    const result = await gateway.restart()
    expect(result.ok).toBe(true)
  })

  it('reports restartSupported: false under systemd without the override', async () => {
    const gateway = new ShopGateway({} as never, { ...gatewayOptions(), env: { INVOCATION_ID: 'abc' }, ppid: 1, fetchLatestVersion: async () => '9.9.9' })
    const version = await gateway.version()
    expect(version.restartSupported).toBe(false)
  })

  it('reports restartSupported: true outside a supervisor', async () => {
    const gateway = new ShopGateway({} as never, { ...gatewayOptions(), env: {}, ppid: 4321, fetchLatestVersion: async () => null })
    const version = await gateway.version()
    expect(version.restartSupported).toBe(true)
  })
})
```

Check `restart.test.ts` for how a committed restart is faked (the `restartParentPid` trick) and reuse it for the "allows" case so no real `sh` helper is spawned by the test.

- [ ] **Step 6: Run the tests**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/index.test.ts tests/host/restart.test.ts`
Expected: PASS — new cases green, existing restart/version cases still green (the `version()` shape gained a field; fix any existing assertions that exhaustively match the old object).

- [ ] **Step 7: Typecheck and full package tests**

Run: `cd packages/dsh-plugin-shop && pnpm typecheck && pnpm test`
Expected: clean; all host tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "feat(host): refuse restart under systemd unless allowRestart; report restartSupported"
```

### Task C-3: client hides the restart offer when unsupported

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/index.ts` (fetch version, pass down)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` (RestartPanel gating)
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` (notice string, en + zh)
- Test: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx` (extend)

**Interfaces:**
- Consumes: `ShopVersionResult.restartSupported` from Task C-2.
- Produces: `ShopTabInjected` gains `restartSupported: boolean`.

- [ ] **Step 1: Thread `restartSupported` into the tab**

The injected face already exposes `version: async () => unwrap(await ns.version())` (`src/client/index.ts:122`). In `ShopTab.tsx`, the tab already fetches version on mount for the self-update display — reuse that result (fetch once, keep in the same state) and extract `restartSupported` from it. Add `restartSupported: boolean` to the `ShopTabInjected` interface (line ~29, next to `restart`).

- [ ] **Step 2: Gate the RestartPanel**

In `InstallPanel` (line ~242), replace:

```tsx
        {view.needsRestart && <RestartPanel t={t} restart={restart} />}
```

with:

```tsx
        {view.needsRestart && restartSupported && <RestartPanel t={t} restart={restart} />}
        {view.needsRestart && !restartSupported && (
          <p className={css.notice} data-shop-restart-disabled>{t('restartDisabledNotice')}</p>
        )}
```

In `UninstallPanel` (line ~346), wrap the same way: `{restartSupported && <RestartPanel .../>}` plus the `restartDisabledNotice` line when not. Thread `restartSupported` through both panels' props.

- [ ] **Step 3: Add the locale string**

In `src/client/locales.ts`, add to both dictionaries (copy the neighboring keys' style):

```ts
  restartDisabledNotice: 'This dsh process runs as a systemd service, so the shop cannot restart it safely. Restart the service manually, or set allowRestart: true in the shop row config.',
```

and the Chinese equivalent stating the same two facts (systemd 服务下商店不能安全重启；手动重启服务，或在商店行配置里设置 allowRestart: true).

- [ ] **Step 4: Extend the component test**

In `ShopTab.client.spec.tsx`, find the existing restart-panel test(s) and add: with `restartSupported: false` and a done view with `needsRestart: true`, the restart button is absent and `data-shop-restart-disabled` is present; with `restartSupported: true` the button renders as before.

- [ ] **Step 5: Run and commit**

Run: `cd packages/dsh-plugin-shop && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/dsh-plugin-shop/src/client/
git commit -m "feat(client): hide the restart offer when the host reports restartSupported: false"
```

### Task C-4: pin forwards-only update semantics

**Files:**
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts` (extend)

**Interfaces:**
- Consumes: `installed()` and `isBehind` semantics from `src/host/index.ts`.

- [ ] **Step 1: Write the tests**

Add to `index.test.ts` a `describe('forwards-only outdated', ...)` with cases driven through `installed()` (fixture snapshot + injected `profileDir` pointing at a temp profile manifest, per the existing `installed` tests in that file; reuse their fixture helpers):

```ts
  // dsh-market's update incident: a `latest` dist-tag pointing at an OLDER
  // release made a plain `!==` comparison turn "update" into a downgrade
  // that broke the profile's boot (their updates.ts:86-100). The npm verdict
  // here is strictly forwards-only: semver `lt` between the installed spec's
  // floor and the catalog version.
  it('reports an equal installed version as current', ...)
  it('reports a backwards catalog version as current, never "outdated"', ...) // spec 2.0.0 vs catalog 1.5.0
  it('reports a behind installed version as outdated', ...)                  // spec ^1.0.0 vs catalog 1.5.0
```

For each case: build a fixture `lastSnapshot` (via the injected `loadCatalog` option or the existing snapshot fixture), a profile manifest whose `dependencies[entry.name]` is the spec, call `installed()`, assert `outdated`.

- [ ] **Step 2: Run to see them pass (the code is already correct)**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/index.test.ts`
Expected: PASS — this task pins existing behavior; if any case fails, the behavior regressed and the fix belongs in `isBehind` (`packages/dsh-plugin-shop/src/host/index.ts:433`), which must stay `lt`-based.

- [ ] **Step 3: Commit**

```bash
git add packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "test(host): pin forwards-only outdated verdicts (dsh-market downgrade incident)"
```

### Task C-5: stale answers never silent — audit and pin

**Files:**
- Test: `packages/dsh-plugin-shop/tests/host/catalog.test.ts` (extend)
- Test: `packages/dsh-plugin-shop/tests/host/self-update.test.ts` (extend if gaps exist)

**Interfaces:**
- Consumes: `loadCatalog` stale semantics (`src/host/catalog.ts`), `shop/version` advisory `latest: null` semantics.

- [ ] **Step 1: Audit against the three paths**

Read `src/host/catalog.ts` and confirm each degradation path carries its signal; fix only if one is silent:
1. Catalog cache fallback — `stale: true` returned with the cached snapshot (catalog.ts:234-236, 256-258). ✓
2. Stars sidecar failure — degrades to `{}` (advisory; no UI row renders). ✓
3. Version check — `latest: null`, client shows the version alone. ✓

If the audit finds a silent path, fix it now (smallest change that adds the signal) and note it in the commit message.

- [ ] **Step 2: Add the missing pin tests to `catalog.test.ts`**

Add cases asserting (each mirrors an existing fixture helper):
- a transport failure with a cached snapshot returns `stale: true` AND the snapshot's `builtAt` (the consumer's only freshness signal) — assert the value, not just truthiness;
- a transport failure with **no** cache throws (never fabricates an answer);
- a tampered cached data file (sha mismatch) is treated as absent and a fresh fetch is attempted (never served).

- [ ] **Step 3: Run and commit**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/catalog.test.ts tests/host/self-update.test.ts`
Expected: PASS.

```bash
git add packages/dsh-plugin-shop/tests/host/catalog.test.ts packages/dsh-plugin-shop/tests/host/self-update.test.ts
git commit -m "test(host): pin that every degraded catalog answer carries its stale signal"
```

---

## Phase B — Publish-time self-check

### Task B-1: `assertCatalogInvariants` — E11 unique identity, E12 count consistency

**Files:**
- Modify: `registry/scripts/src/emit.ts` (invariant function + call at the top of `emit`)
- Test: `registry/scripts/tests/emit.test.ts` (extend)

**Interfaces:**
- Produces: `export function assertCatalogInvariants(entries: Entry[], builtAt: string): void` — throws on violation; called by `emit()` itself before any artifact is built. Phase A Task A-4 extends it with the E9 `added` check. The `builtAt` date part is the "now" reference — the pure core never reads a clock.

- [ ] **Step 1: Write the failing tests**

Add to `registry/scripts/tests/emit.test.ts` (reuse the existing entry fixture; note the `Entry` type import):

```ts
describe('assertCatalogInvariants', () => {
  it('throws on two entries with the same npm identity', () => {
    const entry = /* the existing fixture entry, source: 'npm' */
    expect(() => emit([entry, { ...entry }], [], '2026-08-31T00:00:00Z')).toThrow(/duplicate install identity/)
  })

  it('throws on two github entries with the same repo and subdir', () => {
    const repo = /* fixture github entry with repo: 'owner/slug', subdir: 'packages/a' */
    expect(() => emit([repo, { ...repo }], [], '2026-08-31T00:00:00Z')).toThrow(/duplicate install identity/)
  })

  it('allows the same bundle name from different repos', () => {
    // the registry legitimately holds distinct plugins under one name
    const a = /* github entry, repo 'owner-a/slug' */; const b = /* github entry, repo 'owner-b/slug', same name */
    expect(() => emit([a, b], [], '2026-08-31T00:00:00Z')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run registry/scripts/tests/emit.test.ts`
Expected: FAIL — no invariant runs yet (duplicate emits succeed).

- [ ] **Step 3: Implement**

In `emit.ts`, add above `emit`:

```ts
/**
 * Cross-field catalog invariants, checked before anything is emitted
 * (design 2026-08-31 market-borrowings §2, the E11/E12 borrowings). The
 * consumer cannot self-heal these: a duplicated install identity makes the
 * install route ambiguous, and a count that does not match the data file
 * breaks every consumer's summary. Throwing beats publishing either.
 * @param entries - the accepted entries, pre-sort.
 * @param builtAt - the build timestamp; its date part is the "now" reference.
 */
export function assertCatalogInvariants(entries: Entry[], builtAt: string): void {
  const identities = new Set<string>()
  for (const entry of entries) {
    const key = entry.source === 'npm'
      ? `npm:${entry.name}`
      : `github:${entry.repo ?? entry.name}#${entry.subdir ?? ''}`
    if (identities.has(key)) throw new Error(`catalog invariant: duplicate install identity ${key}`)
    identities.add(key)
  }
}
```

Call it as the first statement of `emit()`:

```ts
  assertCatalogInvariants(entries, builtAt)
```

Add the E12 cross-artifact check right before `return` in `emit()`:

```ts
  // E12: the pointer's count must equal the data file's plugin array — the
  // two artifacts are built separately and this keeps them honest.
  const dataCount = (JSON.parse(pluginsJson) as { plugins: unknown[] }).plugins.length
  if (dataCount !== sorted.length) throw new Error('catalog invariant: index count does not match the data file')
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm vitest run registry/scripts/tests/emit.test.ts`
Expected: PASS — new cases green; all existing emit/determinism cases still green.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`
Expected: clean.

```bash
git add registry/scripts/src/emit.ts registry/scripts/tests/emit.test.ts
git commit -m "feat(registry): emit-time invariants — unique install identity, count consistency"
```

---

## Phase A — Catalog data layer (v4 → v5)

### Task A-1: `theme` in the category enum + schema regeneration

**Files:**
- Modify: `registry/scripts/src/types.ts` (CATEGORIES)
- Modify: `registry/schema/plugin-entry.schema.json` (REGENERATED via `pnpm emit:schema`, never hand-edited)
- Test: `registry/scripts/tests/categories.test.ts`, `registry/scripts/tests/schema.test.ts` (update where they pin the enum)

**Interfaces:**
- Produces: `CATEGORIES` gains `'theme'`; `Category` widens automatically; `categorySchema` (zod) follows `CATEGORIES`. Consumed by Tasks A-2..A-7.

- [ ] **Step 1: Add the value**

In `registry/scripts/src/types.ts`, change:

```ts
export const CATEGORIES = ['tool', 'provider', 'ui', 'workflow', 'integration', 'other'] as const
```

to:

```ts
export const CATEGORIES = ['tool', 'provider', 'ui', 'workflow', 'integration', 'theme', 'other'] as const
```

(Order: `theme` sits beside the content categories; `other` stays last. The comment above the line already says adding one is a schema change.)

- [ ] **Step 2: Run the tests to find every pin of the old enum**

Run: `pnpm vitest run registry/scripts/tests/categories.test.ts registry/scripts/tests/schema.test.ts registry/scripts/tests/config.test.ts`
Expected: FAIL where the enum is pinned. Update those assertions to include `theme` (say in the commit message why: the enum widened, and the tests describe the new contract).

- [ ] **Step 3: Regenerate the schema**

Run: `pnpm emit:schema`
Expected: `registry/schema/plugin-entry.schema.json` now contains `"theme"` in the category enum.

- [ ] **Step 4: Re-run and commit**

Run: `pnpm vitest run registry/scripts/tests/` and `pnpm typecheck`
Expected: all green (schema.test.ts freshness passes against the regenerated file).

```bash
git add registry/scripts/src/types.ts registry/scripts/tests/categories.test.ts registry/scripts/tests/schema.test.ts registry/schema/plugin-entry.schema.json
git commit -m "feat(registry): add theme to the closed category enum (market borrowings A-4)"
```

### Task A-2: `theme` in the LLM classifier

**Files:**
- Modify: `registry/scripts/src/llm-client.ts` (the system prompt's category list)
- Modify: `registry/scripts/tests/llm-client.test.ts` or `llm-parse.test.ts` (where the prompt/list is pinned)

**Interfaces:**
- Consumes: `CATEGORIES` from Task A-1. `llm-parse.ts` validates via `isCategory` which reads `CATEGORIES` — automatic.

- [ ] **Step 1: Add the prompt line**

In `registry/scripts/src/llm-client.ts` (near lines 42–48), add after the `integration` line, matching its style:

```ts
  'theme — changes the interface's appearance: skins, themes, visual styles',
```

- [ ] **Step 2: Run, fix pins, commit**

Run: `pnpm vitest run registry/scripts/tests/llm-client.test.ts registry/scripts/tests/llm-parse.test.ts`
Expected: green or pinned-list failures — update pins to include `theme`.

```bash
git add registry/scripts/src/llm-client.ts registry/scripts/tests/
git commit -m "feat(registry): teach the classifier the theme category"
```

### Task A-3: `replacement` pointers on denials

**Files:**
- Modify: `registry/scripts/src/config.ts` (deniedSchema + RegistryConfig.denied value type)
- Modify: `registry/scripts/src/types.ts` (Rejection gains `replacement?`)
- Modify: `registry/scripts/src/gate.ts` and `registry/scripts/src/repo-gate.ts` (denial detail)
- Modify: `registry/scripts/src/emit.ts` (denied array carries `replacement`)
- Test: `registry/scripts/tests/config.test.ts`, `registry/scripts/tests/gate.test.ts`, `registry/scripts/tests/repo-gate.test.ts`, `registry/scripts/tests/emit.test.ts`

**Interfaces:**
- Produces: `RegistryConfig.denied: Map<string, { reason: string; replacement?: string }>` (type change — every `config.denied.get(...)` caller in gate.ts/repo-gate.ts must be updated in the same task); `Rejection.replacement?: string`; the published `denied[]` object gains an optional `replacement` key. The detail format is `Denied by the registry: <reason> Known replacement: <name>.` — author-readable, published.

- [ ] **Step 1: Extend the config schema**

In `config.ts`, change `deniedSchema`:

```ts
const deniedSchema = z.array(z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
  replacement: z.string().min(1).optional(),
}).strict())
```

Change `RegistryConfig`:

```ts
  /** Package name to the reason it is excluded, plus the known replacement
   * when a human recorded one. */
  denied: Map<string, { reason: string; replacement?: string }>
```

Change the parse loop:

```ts
  const denied = new Map<string, { reason: string; replacement?: string }>()
  for (const row of parseFile('denied.yml', input.denied, deniedSchema)) {
    setUnique(denied, 'denied.yml', row.name, {
      reason: row.reason,
      ...(row.replacement !== undefined ? { replacement: row.replacement } : {}),
    })
  }
```

- [ ] **Step 2: Update the two gates**

In `types.ts`, `Rejection` gains:

```ts
  /** The known replacement, when a human recorded one in denied.yml. */
  replacement?: string
```

In `gate.ts`, replace the denial block:

```ts
  const denial = config.denied.get(name)
  if (denial !== undefined) {
    const suffix = denial.replacement === undefined ? '' : ` Known replacement: ${denial.replacement}.`
    return reject(name, 'denied', `Denied by the registry: ${denial.reason}${suffix}`)
  }
```

(and carry `replacement: denial.replacement` into the rejection object when present). In `repo-gate.ts`, the same two changes for both the `config.denied.get(candidate.repo)` and `config.denied.get(candidate.name)` lookups — the lookup returns the object now, so restructure:

```ts
  const denial = config.denied.get(candidate.repo) ?? config.denied.get(candidate.name)
  if (denial !== undefined) {
    const suffix = denial.replacement === undefined ? '' : ` Known replacement: ${denial.replacement}.`
    return reject(unit, 'denied', `Denied by the registry: ${denial.reason}${suffix}`)
  }
```

(The rejected object gains `replacement: denial.replacement` via a spread when defined.)

- [ ] **Step 3: Emit the pointer**

In `emit.ts`, the `denied` mapping:

```ts
  const denied = rejections
    .filter(r => r.code === 'denied')
    .map(r => ({
      name: r.name,
      detail: r.detail,
      ...(r.replacement !== undefined ? { replacement: r.replacement } : {}),
    }))
```

- [ ] **Step 4: Update tests (they will fail on the type change) and add cases**

- `config.test.ts`: a denied row with `replacement` parses; a row without still parses; a malformed replacement (non-string) throws.
- `gate.test.ts` / `repo-gate.test.ts`: a denied candidate with a replacement produces detail containing `Known replacement: <name>` and the rejection carries `replacement`; without a replacement the detail is exactly the old string.
- `emit.test.ts`: a `denied` rejection with `replacement` emits the key; without, the object has exactly `{ name, detail }`.
- Also update `registry/denied.yml`'s header comment to document the optional key (example row style), and add the design doc's E-mapping note if the header mentions field semantics.

Run: `pnpm vitest run registry/scripts/tests/`
Expected: all green.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm typecheck`

```bash
git add registry/scripts/src/config.ts registry/scripts/src/types.ts registry/scripts/src/gate.ts registry/scripts/src/repo-gate.ts registry/scripts/src/emit.ts registry/scripts/tests/ registry/denied.yml
git commit -m "feat(registry): optional replacement pointer on denials (market borrowings A-3)"
```

### Task A-4: `added` — first-seen dates

**Files:**
- Modify: `registry/scripts/src/config.ts` (firstSeen parse + serialize)
- Modify: `registry/scripts/src/types.ts` (Entry gains `added`)
- Modify: `registry/scripts/src/pipeline.ts` (attach `added`, throw when missing)
- Modify: `registry/scripts/src/emit.ts` (E9 in the invariants)
- Modify: `registry/scripts/src/build.ts` (pre-append new names; write the file back)
- Create: `registry/scripts/src/backfill-first-seen.ts` (one-time git-history backfill)
- Create: `registry/first-seen.yml` (generated by the backfill, committed)
- Test: `registry/scripts/tests/config.test.ts`, `registry/scripts/tests/pipeline.test.ts`, `registry/scripts/tests/emit.test.ts`

**Interfaces:**
- Produces: `RegistryConfig.firstSeen: Map<string, string>` (dates as `YYYY-MM-DD`); `Entry.added: string`; `serializeFirstSeen(rows: ReadonlyMap<string, string>): string`; invariant: a listed entry whose name has no first-seen row throws; `added` later than the build date throws (E9).

- [ ] **Step 1: Schema + parser + serializer in `config.ts`**

Add:

```ts
const firstSeenSchema = z.array(z.object({
  name: z.string().min(1),
  added: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict())
```

`parseRegistryConfig` input gains `firstSeen: string`; parse like the others:

```ts
  const firstSeen = new Map<string, string>()
  for (const row of parseFile('first-seen.yml', input.firstSeen, firstSeenSchema)) {
    setUnique(firstSeen, 'first-seen.yml', row.name, row.added)
  }
```

`loadRegistryConfig` reads it via `readOptional(dir, 'first-seen.yml')`. `RegistryConfig` gains:

```ts
  /** Package name to the date it first entered the catalog (YYYY-MM-DD). */
  firstSeen: Map<string, string>
```

Add the serializer (mirroring `serializeCategoryRows`'s quoting rule — names always double-quoted because scoped names start with `@`):

```ts
/** Serialize the first-seen file: header, sorted rows, trailing newline. */
export function serializeFirstSeen(rows: ReadonlyMap<string, string>): string {
  const rowsText = [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, added]) => `- name: "${name}"\n  added: ${added}`)
  const body = rowsText.length === 0 ? ['[]'] : rowsText
  return `${['# First catalog appearance per package name (YYYY-MM-DD). Appended by the daily build;', '# a name absent here is simply "first seen today".'].join('\n')}\n${body.join('\n')}\n`
}
```

- [ ] **Step 2: `Entry.added` + pipeline attach**

In `types.ts`, `Entry` gains (after `subdir?`):

```ts
  /** The date this entry first appeared in the catalog (YYYY-MM-DD). */
  added: string
```

In `pipeline.ts`, after each `entries.push(assignTier(...))` and `assignRepoTier(...)`, attach the date with a loud guard. Add a small helper above `runPipeline`:

```ts
function withAdded(entry: Entry, firstSeen: ReadonlyMap<string, string>): Entry {
  const added = firstSeen.get(entry.name)
  if (added === undefined) throw new Error(`first-seen.yml: ${entry.name} has no first-seen row`)
  return { ...entry, added }
}
```

and use it at both push sites.

- [ ] **Step 3: E9 in the invariants**

In `emit.ts` `assertCatalogInvariants`, add before the identity loop:

```ts
  // E9: `added` is present and never in the future relative to the build date.
  const today = builtAt.slice(0, 10)
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.added)) {
      throw new Error(`catalog invariant: ${entry.name} has an unparseable added date ${entry.added}`)
    }
    if (entry.added > today) {
      throw new Error(`catalog invariant: ${entry.name} added ${entry.added} is later than the build date ${today}`)
    }
  }
```

(When entries carry `added` they sort by name before emit — the invariant runs on the pre-sort array, which is fine.)

- [ ] **Step 4: build.ts pre-append + write-back**

In `build.ts`, after the harvest branches (both paths have `candidates` + `repoCandidates` set) and before `runPipeline` (line ~208):

```ts
// First-seen bookkeeping: any name this run harvested for the first time gets
// today. The appended file is written back after the pipeline, so the daily
// commit carries both the new dates and the manifest lock together.
const today = new Date().toISOString().slice(0, 10)
const firstSeen = new Map(config.firstSeen)
for (const candidate of candidates) if (!firstSeen.has(candidate.name)) firstSeen.set(candidate.name, today)
for (const repo of repoCandidates) if (!firstSeen.has(repo.name)) firstSeen.set(repo.name, today)
const configWithFirstSeen = { ...config, firstSeen }
```

Change the pipeline call to pass `configWithFirstSeen`, and after the `manifest.lock` write add:

```ts
writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(firstSeen))
```

(import `serializeFirstSeen` from `./config.ts`).

- [ ] **Step 5: The one-time backfill script**

Create `registry/scripts/src/backfill-first-seen.ts`:

```ts
/** One-time backfill of registry/first-seen.yml from the manifest.lock git
 * history: a name's first-seen date is the date of the first committed
 * snapshot that listed it. Real dates only — no fabrication. Run once with
 * `node --experimental-strip-types registry/scripts/src/backfill-first-seen.ts`,
 * commit the produced file, then never run it again (the daily build appends).
 *
 * manifest.lock line shapes (emit.ts): npm entries are `name version integrity`,
 * repo entries are `owner/slug name version` — the slash disambiguates. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serializeFirstSeen } from './config.ts'

const REGISTRY_DIR = 'registry'
const LOCK = 'snapshots/manifest.lock'

function namesOf(lockText: string): Set<string> {
  const names = new Set<string>()
  for (const line of lockText.split('\n')) {
    if (line === '') continue
    const parts = line.split(' ')
    const name = (parts[0] ?? '').includes('/') ? parts[1] : parts[0]
    if (name !== undefined && name !== '') names.add(name)
  }
  return names
}

function lockAt(sha: string): string {
  return execFileSync('git', ['show', `${sha}:${join(REGISTRY_DIR, LOCK)}'], { encoding: 'utf8' })
}

const history = execFileSync(
  'git', ['log', '--reverse', '--format=%H %cs', '--', join(REGISTRY_DIR, LOCK)], { encoding: 'utf8' },
)
  .split('\n').filter(line => line !== '')
  .map(line => {
    const [sha, date] = line.split(' ')
    return { sha: sha ?? '', date: date ?? '' }
  })

const current = namesOf(readFileSync(join(REGISTRY_DIR, LOCK), 'utf8'))
const firstSeen = new Map<string, string>()
for (const { sha, date } of history) {
  if (sha === '' || date === '') continue
  let lockText: string
  try {
    lockText = lockAt(sha)
  } catch {
    continue // a rename or filter edge — the next commit still answers
  }
  for (const name of namesOf(lockText)) {
    if (current.has(name) && !firstSeen.has(name)) firstSeen.set(name, date)
  }
}

writeFileSync(join(REGISTRY_DIR, 'first-seen.yml'), serializeFirstSeen(firstSeen))
process.stderr.write(`backfilled ${firstSeen.size} name(s) from ${history.length} snapshot commit(s)\n`)
```

- [ ] **Step 6: Run the backfill once and commit the file**

Run: `node --experimental-strip-types registry/scripts/src/backfill-first-seen.ts`
Expected: stderr reports the counts; `registry/first-seen.yml` exists with one row per name in the current manifest.lock, dates in the past.
Then: `node --experimental-strip-types registry/scripts/src/build.ts --harvest-from <path>` is NOT needed — the tests below drive the pure parts; the build runs next daily.

- [ ] **Step 7: Tests**

- `config.test.ts`: first-seen rows parse; duplicate name throws; malformed date throws; `serializeFirstSeen` quotes scoped names and sorts.
- `pipeline.test.ts`: an entry whose name has a first-seen row emits with that `added`; a name without a row throws with `first-seen.yml` in the message. Update every existing pipeline fixture/config fixture to include `firstSeen` rows for the names they list (the deterministic-output fixtures must gain the `added` field too — recompute expected JSON).
- `emit.test.ts`: E9 cases — future date throws, unparseable date throws. Update existing expected artifacts for the new `added` field (all fixture entries need one; use `'2026-08-25'`).

Run: `pnpm vitest run registry/scripts/tests/`
Expected: all green.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm typecheck`

```bash
git add registry/scripts/src/config.ts registry/scripts/src/types.ts registry/scripts/src/pipeline.ts registry/scripts/src/emit.ts registry/scripts/src/build.ts registry/scripts/src/backfill-first-seen.ts registry/first-seen.yml registry/scripts/tests/
git commit -m "feat(registry): added — first-seen dates with git-history backfill (market borrowings A-2)"
```

### Task A-5: tarball rescue for `requires-build` repos

**Files:**
- Modify: `registry/scripts/src/types.ts` (`RepoCandidate.release`)
- Modify: `registry/scripts/src/github-client.ts` (release probe in `fetchRepoCandidate`)
- Modify: `registry/scripts/src/repo-gate.ts` (rescue branch)
- Modify: `registry/scripts/src/tier.ts` (release-pinned review semantics)
- Modify: `registry/scripts/src/emit.ts` (entry carries `tarball`; manifest.lock line for release entries)
- Test: `registry/scripts/tests/github-client.test.ts`, `registry/scripts/tests/repo-gate.test.ts`, `registry/scripts/tests/tier.test.ts`, `registry/scripts/tests/emit.test.ts`, `registry/scripts/tests/pipeline.test.ts`

**Interfaces:**
- Produces: `RepoCandidate.release?: { tag: string; url: string; sha256: string }` (attached by the fetch layer, before gating — `repo-gate` stays pure); `Entry.tarball?: { url: string; sha256: string }`; for a rescued entry `version` = the release tag, `integrity` = the tarball's sha256, `source` stays `'github'`, and `verified` pins `reviewedVersion` against the tag. `requires-build` rejection detail unchanged for unrescued repos.

- [ ] **Step 1: Probe function in `github-client.ts`**

Add near `fetchHeadCommit`:

```ts
/**
 * Probe a repository's latest GitHub Release for a prebuilt tarball — the
 * rescue channel for repos whose build script makes a git install impossible
 * through the shop (design 2026-08-31 market-borrowings §3.1). Only the
 * `requires-build` class triggers this probe, so its API cost is bounded by
 * the class it rescues. The result rides `repo-state.json` through the
 * candidate, so it re-probes only when the repo's `pushedAt` advances.
 * The tarball is downloaded once here and hashed: GitHub release assets are
 * immutable per URL (re-upload = new asset = new URL), so URL + sha256 is the
 * audit story. Returns null when there is no release or no tarball asset.
 */
async function fetchLatestReleaseTarball(
  owner: string,
  slug: string,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  token: string | undefined,
): Promise<{ tag: string; url: string; sha256: string } | null> {
  const url = `${GITHUB_API}/repos/${owner}/${slug}/releases/latest`
  const response = await fetchRobust(url, fetchImpl, sleep, token)
  if (!response.ok) return null
  let body: { tag_name?: unknown; assets?: unknown }
  try {
    body = await response.json() as typeof body
  } catch {
    return null
  }
  if (typeof body.tag_name !== 'string' || !Array.isArray(body.assets)) return null
  const asset = body.assets
    .map(a => (a as { browser_download_url?: unknown }).browser_download_url)
    .find((u): u is string => typeof u === 'string' && /\.(?:tgz|tar\.gz)$/.test(u))
  if (asset === undefined) return null
  const assetResponse = await fetchRobust(asset, fetchImpl, sleep, token)
  if (!assetResponse.ok) return null
  const bytes = new Uint8Array(await assetResponse.arrayBuffer())
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { tag: body.tag_name, url: asset, sha256 }
}
```

(import `createHash` from `node:crypto` at the top — check whether it is already imported.)

- [ ] **Step 2: Attach the probe result in `fetchRepoCandidate`**

After the `root` is projected and before the subpackage/return branches, probe only the `requires-build` root (the rescue class):

```ts
  if (root !== null && root.requiresBuild) {
    const release = await fetchLatestReleaseTarball(owner, slug, fetchImpl, sleep, token)
    if (release !== null) root.release = release
  }
```

- [ ] **Step 3: Rescue branch in `repo-gate.ts`**

Replace the `requiresBuild` rejection:

```ts
  if (candidate.requiresBuild && candidate.release === undefined) {
    return reject(unit, 'requires-build',
      'Declares a prepare/prepack build script, which a git install requires and pnpm blocks by default; the shop never enables build scripts, so the repository could not install. Publish to npm, or drop the script, and it can be listed.')
  }
```

(a `requiresBuild` repo WITH a release falls through — the tarball channel covers it.)

- [ ] **Step 4: `RepoCandidate.release` in types + entry shape in `tier.ts`**

`types.ts` `RepoCandidate` gains (after `subdir?`):

```ts
  /** A prebuilt GitHub Release tarball, when the fetch layer probed one for a
   * `requiresBuild` repo. Its presence turns the entry into a
   * release-pinned entry: `version` = the tag, `integrity` = the tarball
   * sha256. */
  release?: { tag: string; url: string; sha256: string }
```

`Entry` gains (after `subdir?`):

```ts
  /** The prebuilt GitHub Release tarball, present exactly when the entry was
   * rescued from `requires-build`. The Host installs this URL instead of the
   * git form. */
  tarball?: { url: string; sha256: string }
```

`assignRepoTier` in `tier.ts` — the base gains the release branch:

```ts
  const release = repo.release
  const base = {
    name: repo.name,
    version: release !== undefined ? release.tag : repo.commit,
    integrity: release !== undefined ? release.sha256 : repo.commit,
    publishedAt: repo.publishedAt ?? '',
    repository: repo.repository,
    license: repo.license ?? '',
    metadata: accepted.metadata,
    catalog: accepted.catalog,
    source: 'github' as const,
    repo: repo.repo,
    ...(repo.subdir !== undefined ? { subdir: repo.subdir } : {}),
    ...(release !== undefined ? { tarball: { url: release.url, sha256: release.sha256 } } : {}),
  }
  // A release-pinned entry is reviewed by its tag, like an npm version: tags
  // are the author's version namespace, and a commit comparison would compare
  // against a hash that is no longer the entry's identity.
  if (release !== undefined) {
    if (review === undefined || review.reviewedVersion === undefined) return { ...base, tier: 'community' }
    return { ...base, tier: review.reviewedVersion === release.tag ? 'verified' : 'verified-stale', review }
  }
```

(keep the existing reviewedCommit path for non-release entries.)

- [ ] **Step 5: Emit the field and the lock line**

`emit.ts` needs no change for the entry field (it serializes `sorted` verbatim). The manifest.lock line for a release entry must stay `owner/slug name version` — `version` is now the tag, which is what the daily diff should show. No change needed.

- [ ] **Step 6: Tests**

- `github-client.test.ts`: with a fake fetch that serves a manifest with `prepare` and a `releases/latest` body with one `.tgz` asset, `fetchRepoCandidate` returns a candidate with `requiresBuild: true` AND `release` set (assert `tag`, `url`, and a 64-hex `sha256`); no release → candidate has no `release`; no `.tgz` asset → no `release`; a non-requiresBuild manifest does not call the release endpoint (assert via a fetch spy).
- `repo-gate.test.ts`: a `requiresBuild` candidate WITHOUT release still rejects `requires-build` (old detail intact); WITH release it is accepted (other rules satisfied).
- `tier.test.ts`: a release-pinned accepted repo with `verified.reviewedVersion === tag` is `verified`; a different tag is `verified-stale`; a commit-only review pin yields `community` (the pin does not transfer across identity kinds).
- `emit.test.ts`/`pipeline.test.ts`: fixture entries gain `tarball` cases; deterministic output updated for the new field where present.

Run: `pnpm vitest run registry/scripts/tests/`
Expected: all green.

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm typecheck`

```bash
git add registry/scripts/src/types.ts registry/scripts/src/github-client.ts registry/scripts/src/repo-gate.ts registry/scripts/src/tier.ts registry/scripts/tests/
git commit -m "feat(registry): release-tarball rescue for requires-build repos (market borrowings A-1)"
```

### Task A-6: schemaVersion 5 — consumer side (host + client) and flag plumbing

**Files:**
- Modify: `registry/scripts/src/emit.ts` (v5 constant + subpackage precedent)
- Modify: `registry/scripts/src/build.ts` (`SHOP_CATALOG_V5` flag → schemaVersion choice)
- Modify: `registry/scripts/src/pipeline.ts` (already passes schemaVersion through)
- Modify: `packages/dsh-plugin-shop/src/host/catalog.ts` (SUPPORTED_SCHEMA_VERSION 5; entry schema: `added`, `tarball`, `theme`; denied `replacement`; tarball URL binding validation)
- Modify: `packages/dsh-plugin-shop/src/host/types.ts` (`CatalogEntry.added/tarball`, `CatalogSection.category` + theme, `DeniedEntry.replacement`)
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (install spec for tarball entries; skip the git check for them; pins)
- Test: `registry/scripts/tests/emit.test.ts`, `packages/dsh-plugin-shop/tests/host/catalog.test.ts`, `packages/dsh-plugin-shop/tests/host/index.test.ts`, `packages/dsh-plugin-shop/tests/host/install.test.ts`

**Interfaces:**
- Produces: `CATALOG_SCHEMA_VERSION = 5` emitted only when `SHOP_CATALOG_V5 === '1'` (else `SUBPACKAGE_SCHEMA_VERSION` = 4, the existing default chain); `SUPPORTED_SCHEMA_VERSION = 5` in the host; `CatalogEntry` carries `added: string` and optional `tarball: { url: string; sha256: string }`; tarball URLs must be `https://github.com/<owner>/<repo>/releases/...` where `<owner>/<repo>` equals the entry's `repo` (case-insensitive) — anything else is refused loudly at parse, mirroring dsh-market's release-binding rule. The v5 flag flip happens at release time (one line, marked in Step 6); this task ships everything the flip depends on.

- [ ] **Step 1: v5 constants + flag in the registry build**

`emit.ts`:

```ts
export const SCHEMA_VERSION = 3
export const SUBPACKAGE_SCHEMA_VERSION = 4
/** v5 (market borrowings): `added` on every entry, optional `tarball`
 * (release rescue), `theme` category, `denied[].replacement`. Emitted only
 * when SHOP_CATALOG_V5 is set — `theme` is a new enum value, and an old
 * client's zod enum rejects a catalog containing it wholesale, so the client
 * that parses v5 must ship first (release-order choreography, §3.5). */
export const CATALOG_SCHEMA_VERSION = 5
```

`build.ts`: replace the `runPipeline(...)` version argument:

```ts
const v5Flag = process.env.SHOP_CATALOG_V5 === '1'
const schemaVersion = v5Flag ? CATALOG_SCHEMA_VERSION : (probeSubpackages ? SUBPACKAGE_SCHEMA_VERSION : SCHEMA_VERSION)
const artifacts = runPipeline(candidates, repoCandidates, configWithFirstSeen, new Date().toISOString(), rejections, starsInfo, schemaVersion)
```

(import `CATALOG_SCHEMA_VERSION` from `./emit.ts`.)

- [ ] **Step 2: Host zod + types**

`host/types.ts`:
- `CatalogSection.category` union gains `'theme'`.
- `CatalogEntry` gains `added: string` and `tarball?: { url: string; sha256: string }`.
- `DeniedEntry` gains `replacement?: string`.

`host/catalog.ts`:
- `SUPPORTED_SCHEMA_VERSION` becomes `5`.
- `entrySchema` gains `added: z.string()`, `tarball: z.object({ url: z.string(), sha256: z.string() }).optional()`, and the category enum gains `'theme'`.
- `dataSchema.denied` row schema gains `replacement: z.string().optional()`.
- Add a post-parse coherence check invoked from both `readCached` and the fresh-fetch path (after `dataSchema.parse` succeeds), so a bad binding is refused loudly whether it came from the cache or the wire:

```ts
/** The tarball URL must be the entry's own GitHub release — path segments
 * `/<owner>/<repo>/releases/...` matching the entry's `repo` (case-
 * insensitive). A catalog row that names a trusted repo but installs an
 * archive from somewhere else is refused loudly, never installed
 * (dsh-market's release-binding rule, their sources.ts:16-49). */
function validateEntryCoherence(entries: CatalogEntry[]): void {
  for (const entry of entries) {
    if (entry.tarball === undefined) continue
    if (entry.source !== 'github' || entry.repo === undefined) {
      throw new Error(`catalog entry ${entry.name}: tarball requires a github entry with a repo`)
    }
    let parsed: URL
    try {
      parsed = new URL(entry.tarball.url)
    } catch {
      throw new Error(`catalog entry ${entry.name}: tarball url is unparseable`)
    }
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
      throw new Error(`catalog entry ${entry.name}: tarball url must be https on github.com`)
    }
    const segments = parsed.pathname.split('/').filter(s => s !== '')
    const owner = segments[0] ?? ''
    const slug = segments[1] ?? ''
    if (`${owner}/${slug}`.toLowerCase() !== entry.repo.toLowerCase() || segments[2] !== 'releases') {
      throw new Error(`catalog entry ${entry.name}: tarball url is not a release of ${entry.repo}`)
    }
  }
}
```

Call it on the parsed data in both `readCached` and the fresh path, before building the snapshot. Wrap in no try/catch — it must throw (fail loudly, never degrade).

- [ ] **Step 2b: Client-side chip support for `theme`**

The client category chip is NOT generic: `Category` derives from the `CATEGORY_KEYS` map (`src/client/present.ts:199-208`), the badge renders `t(categoryKey(entry))` (`ShopTab.tsx:102`), and the card spine has one hue per category (`ShopTab.module.css:430-435`). Add:
- `CATEGORY_KEYS` gains `theme: 'categoryTheme'`; `locales.ts` gains `categoryTheme` in both languages (themes & appearance / 主题与外观 — matching the neighboring category rows).
- `ShopTab.module.css`: `.card[data-category='theme'] { --spine-hue: #F472B6; }` and update the "six fixed hues" comments (now seven) at lines 5-8 and 418.

- [ ] **Step 3: Install spec for tarball entries**

In `index.ts` `install()`, the github branch (line ~319), before the commit check:

```ts
    if (entry.source === 'github' && entry.tarball !== undefined) {
      // Release-rescued entry: the spec is the prebuilt tarball URL the
      // snapshot validated (https github.com releases of this very repo).
      // No git, no commit pin — the recorded tag is the version.
      spec = entry.tarball.url
    } else if (entry.source === 'github') {
```

(the rest of the github branch — commit regex, git check, `github:` spec — stays as the `else` arm; the pins write below uses `args.version`, which for a tarball entry is the tag — correct as-is.)

- [ ] **Step 4: Consumer tests**

- `catalog.test.ts`: a v5 data fixture (with `added`, a `theme` entry, a `denied` row with `replacement`) parses and returns; a tarball URL that is not the entry's own repo release throws on load (fresh AND cached — assert both paths); a tarball URL on a non-github entry throws; schemaVersion 6 refuses with the upgrade message (existing pattern).
- `index.test.ts` / `install.test.ts`: `installStart` for a tarball entry builds a spec equal to `entry.tarball.url` and skips the git check (inject `hasGit: () => false` and assert the install still starts); an old-format github entry still demands git.

- [ ] **Step 5: Registry flag tests + run everything**

- `emit.test.ts`: `emit(..., CATALOG_SCHEMA_VERSION)` output carries `schemaVersion: 5` and the new fields round-trip.

Run: `pnpm vitest run registry/scripts/tests/ && cd packages/dsh-plugin-shop && pnpm test` and both typechecks.
Expected: all green.

- [ ] **Step 6: Flag-flip choreography (release time — DO NOT flip now)**

Record, do not execute: at the release commit that ships the v5-parsing client (this task's consumer code), set `SHOP_CATALOG_V5: "1"` in `.github/workflows/daily.yml`'s build step env (the v3→v4 precedent: the flag flips in the release commit, never before). The daily build until then emits v4 with the new fields **absent** (they ride the v5 path only) — confirm with `emit.test.ts` that the default (`SCHEMA_VERSION`/`SUBPACKAGE_SCHEMA_VERSION`) output carries no `added`/`tarball`/`theme` entries. Add a test pinning exactly that.

- [ ] **Step 7: Commit**

```bash
git add registry/scripts/src/emit.ts registry/scripts/src/build.ts registry/scripts/tests/emit.test.ts packages/dsh-plugin-shop/src/host/catalog.ts packages/dsh-plugin-shop/src/host/types.ts packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/
git commit -m "feat: catalog v5 consumer side — added/tarball/theme/replacement, tarball install path (market borrowings)"
```

### Task A-7: docs and authority-spec amendments

**Files:**
- Modify: `docs/schema.md` (bilingual author-facing reference)
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (the authority spec — amended in the same change, per CLAUDE.md)

**Interfaces:** none — documentation only, but required: the spec wins over code, and unamended code/spec drift is a defect.

- [ ] **Step 1: `docs/schema.md`**

In the category enum table, add `theme` with its bilingual description (skins/themes/visual appearance — 皮肤、主题、外观); document `added` (first catalog appearance date), the optional `tarball` object (release-rescue entries: url + sha256, version = the release tag), and the optional `replacement` on denied rows.

- [ ] **Step 2: Authority spec amendments (terse, in the same style as the existing amendments)**

- §6.1: the category enum gains `theme` (one line + rationale: consumer-visible change, rode v5).
- §6.2: entry fields `added` (first-seen date, `registry/first-seen.yml`), optional `tarball` (release-rescue); `denied[]` optional `replacement`; `schemaVersion` is 5 (behind `SHOP_CATALOG_V5`, release-order as before).
- §7.2 install flow: release-rescued entries install the prebuilt tarball URL (built from snapshot fields; binding validated at parse).
- §7.3: `shop/version` gains `restartSupported`; `shop/restart` gains the `supervisor-managed`-style typed refusal (systemd dual-signal detection, `allowRestart` override).
- §8: restart under a supervisor is refused by default; hot-mount amendment (from the same design): installs/uninstalls/updates may go live without a restart via a market-style ephemeral Include tree — the "install requires restart" row gains the hot-mount exception with a pointer to the borrowings design.
- §10 failure modes: systemd refusal row.

- [ ] **Step 3: Commit**

```bash
git add docs/schema.md docs/design/2026-08-18-dsh-plugin-shop-design.md
git commit -m "docs: bilingual schema reference and authority-spec amendments for the market borrowings"
```

---

## Phase D — Hot-mount (install / uninstall / update)

### Task D-1: `host/hot.ts` — the Include-tree mechanism

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/hot.ts`
- Test: `packages/dsh-plugin-shop/tests/host/hot.test.ts`

**Interfaces:**
- Consumes: cordis Fiber handle (`{ await(): Promise<unknown>; dispose(): Promise<unknown> | void }`), the loader's `Include` class via a computed dynamic import.
- Produces:
  - `export interface HotRow { id: string; name: string }`
  - `export function parseSimplePatch(patchText: string): HotRow[] | null` — pure.
  - `export interface HotContext { plugin(plugin: unknown, config: unknown): PluginHandle; logger?: { info(message: string): void; warn(message: string): void } }`
  - `export async function hotMount(ctx: HotContext, profileDir: string, packageName: string, deps?: HotDeps): Promise<HotMountResult>` where `HotDeps = { hotTreeClass?: unknown; fs?: HotFs; dir?: string; timeoutMs?: number; now?: () => number }` (test injection; production defaults to the real include import, node:fs, `join(profileDir, '.dsh-shop')`, `DSH_SHOP_HOT_MOUNT_TIMEOUT_MS || 10000`).
  - `export async function hotUnmount(packageName: string): Promise<boolean>`
  - `export function listHotMounts(): string[]`
  - `export function cleanHotDir(profileDir: string): void`
  - `export interface HotMountResult { ok: boolean; reason: string | null }` — `reason` bilingual, distinguishing "restart will fix it" from "this package can never hot-mount".
  - Deliberate non-port: the client-only shim (`mountClientOnlyDeps`, `shimNames`) is omitted — our catalog never lists a package without `dsh.bundle`, so the shim branch is unreachable code in this shop (YAGNI; record the omission in the module comment).

- [ ] **Step 1: Write the failing tests**

`tests/host/hot.test.ts` — parse matrix (pure):

```ts
import { describe, expect, it } from 'vitest'
import { parseSimplePatch } from '../../src/host/hot.ts'

describe('parseSimplePatch', () => {
  it('parses plain id/name insert rows', () => {
    expect(parseSimplePatch('- id: hello\n  name: dsh-hello-plugin\n')).toEqual([
      { id: 'hello', name: 'dsh-hello-plugin' },
    ])
  })

  it('parses multiple rows and strips comments', () => {
    const text = ['# a comment', '- id: a', '  name: pkg-a', '- id: b', '  name: pkg-b'].join('\n') + '\n'
    expect(parseSimplePatch(text)).toEqual([
      { id: 'a', name: 'pkg-a' },
      { id: 'b', name: 'pkg-b' },
    ])
  })

  it('parses CRLF lines (the Windows-patch regression their hot.ts documents)', () => {
    expect(parseSimplePatch('- id: hello\r\n  name: dsh-hello-plugin\r\n')).toEqual([
      { id: 'hello', name: 'dsh-hello-plugin' },
    ])
  })

  it('rejects config/expression rows', () => {
    expect(parseSimplePatch('- id: hello\n  config:\n    foo: 1\n')).toBe(null)
    expect(parseSimplePatch('- id: hello\n  name: !!js/expression foo()\n')).toBe(null)
  })

  it('rejects a trailing dangling id and empty text', () => {
    expect(parseSimplePatch('- id: hello\n')).toBe(null)
    expect(parseSimplePatch('')).toBe(null)
  })
})
```

And the mount/unmount cycle with fakes:

```ts
class FakeHotTree {
  static lastInstance: FakeHotTree | null = null
  path: string
  constructor(_ctx: unknown, config: { path: string }) { this.path = config.path; FakeHotTree.lastInstance = this }
  write(): void { /* suppressed in the subclass; faked here */ }
  import(name: string): unknown { return { name } }
}

const handle = { await: async () => {}, dispose: async () => { disposed = true } }
const ctx = { plugin: () => handle, logger: { info: () => {}, warn: () => {} } }
```

with `deps.fs` a mem-fs (like catalog.test.ts's `memFs`), a fake package dir containing `cordis.patch.yml` with one plain row, assert: `hotMount` writes `hot-1.yml` under the injected dir with `mkt-`-prefixed ids, returns `{ ok: true, reason: null }`, `listHotMounts()` includes the name; `hotUnmount(name)` disposes and returns true; a second `hotUnmount` returns false. A timeout case: `deps.timeoutMs: 1` with a handle whose `await` never settles → returns ok false with the bilingual reason, and dispose was attempted. An unavailable-include case: `deps.hotTreeClass = null` (the old-harness fallback) → `{ ok: false, reason: ... }` with the "host cannot hot-mount" wording, no file written.

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/hot.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `hot.ts`**

Port from dsh-market's `src/hot.ts` with these adaptations: own namespace `.dsh-shop`; `mkt-` prefix kept; timeout env `DSH_SHOP_HOT_MOUNT_TIMEOUT_MS`; the `HotContext`/`PluginHandle` structural types above; injectable `deps`; no shim path. Key pieces (write them in full, with the CRLF fix in the comment):

```ts
/**
 * Restart-free installs: mount a freshly installed plugin into the running
 * composition through a shop-owned Include subtree (design 2026-08-31
 * market-borrowings §4, mechanism ported from dsh-market's hot.ts).
 *
 * Durable state stays with the profile's `dsh.profile.bundles`, so the next
 * boot loads the plugin through the normal bundle layer. The subtree exists
 * only for this process: its input files live under `<profile>/.dsh-shop/`
 * and are wiped on every boot, so a crash can never leave a file that
 * collides with the bundle layer (inserting an id the bundle layer also
 * inserts is a hard boot failure). Rows are prefixed `mkt-` for the same
 * reason: within this session the hot entry must never share an id with a
 * boot-layer entry, including a disabled one left behind by an update swap.
 *
 * The Include subclass suppresses `write()` — the loader otherwise persists
 * tree changes back to the file it read (dsh-market hot.ts; the in-tree
 * precedent is dsh's agent-presets PresetTree).
 */
```

Include the `loadHotTreeClass` (computed specifier + try/catch → null), `parseSimplePatch` (CRLF-aware line scan), `cleanHotDir` (wipes `hot-\d+\.yml` only), `hotMount` (write yml → `ctx.plugin(HotTree, { path: pathToFileURL(file).href })` → timeout race → best-effort dispose on timeout → handle map), `hotUnmount`, `listHotMounts`, `readPkgDsh` (for the "no patch file" rejection message — keep, it names the reason). Use `import { mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from 'node:fs'` and `pathToFileURL` from `node:url`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/hot.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `cd packages/dsh-plugin-shop && pnpm typecheck`

```bash
git add packages/dsh-plugin-shop/src/host/hot.ts packages/dsh-plugin-shop/tests/host/hot.test.ts
git commit -m "feat(host): Include-tree hot-mount module, ported from dsh-market (market borrowings D)"
```

### Task D-2: executor `afterDone` seam — settle hot outcome before `done`

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts`
- Test: `packages/dsh-plugin-shop/tests/host/executor.test.ts` (extend)

**Interfaces:**
- Consumes: nothing from D-1 (the callback is injected by the gateway).
- Produces: `InstallStatus` gains `restartReason?: string`; `startInstall`/`startUninstall` options gain `afterDone?: (home: string | undefined) => Promise<{ needsRestart: boolean; restartReason?: string } | void>`. Semantics: on exit 0 + confirm pass, the terminal `done` is withheld until `afterDone` settles; its result sets `needsRestart` (default `true`) and `restartReason`. A throwing `afterDone` never fails the install — it falls back to `needsRestart: true` with the bilingual reason "热挂载失败,重启后生效 / hot-mount failed — restart required".

- [ ] **Step 1: Write the failing tests**

Extend `executor.test.ts` (it has a fixture `dsh` that records argv and exits 0; reuse it):

```ts
  it('withholds done until afterDone settles and takes its needsRestart', async () => {
    let settle: (v: { needsRestart: boolean }) => void
    const afterDone = () => new Promise<{ needsRestart: boolean }>(resolve => { settle = resolve })
    const running = startInstall({ profile: 'p', spec: 'fixture@1.0.0', dshBin: fixtureBin, afterDone })
    // give the child a tick to exit
    await new Promise(r => setTimeout(r, 50))
    expect(running.status().state).toBe('running')
    settle!({ needsRestart: false })
    const status = await running.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(false)
  })

  it('an afterDone failure still reports done, with needsRestart true and the fallback reason', async () => {
    const running = startInstall({ profile: 'p', spec: 'fixture@1.0.0', dshBin: fixtureBin,
      afterDone: async () => { throw new Error('boom') } })
    const status = await running.finished
    expect(status.state).toBe('done')
    expect(status.needsRestart).toBe(true)
    expect(status.restartReason).toContain('restart required')
  })
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/executor.test.ts`
Expected: FAIL — no `afterDone` option exists.

- [ ] **Step 3: Implement**

In `executor.ts`:

- `InstallStatus` gains `restartReason?: string`.
- `spawnPluginCli` options gain `afterDone`; track `needsRestartOnDone = true` and `restartReason` locals; `status()` becomes:

```ts
  const status = (): InstallStatus => ({
    state,
    log: [...log],
    ...(state === 'done' ? { needsRestart: needsRestartOnDone, ...(restartReason !== undefined ? { restartReason } : {}) } : {}),
    ...(detail !== undefined ? { detail } : {}),
  })
```

- The close handler's exit-0 branch becomes async:

```ts
      if (exitCode === 0) {
        const confirmDetail = confirm?.(env?.DSH_HOME)
        if (confirmDetail !== null) {
          state = 'failed'
          detail = confirmDetail
        } else if (afterDone !== undefined) {
          try {
            const outcome = await afterDone(env?.DSH_HOME)
            needsRestartOnDone = outcome?.needsRestart ?? true
            restartReason = outcome?.restartReason
          } catch {
            // A failed hot path never fails the install — the package IS
            // installed; it activates on restart instead.
            needsRestartOnDone = true
            restartReason = '热挂载失败,重启后生效 / hot-mount failed — restart required'
          }
          state = 'done'
        } else {
          state = 'done'
        }
      }
```

- `startInstall`/`startUninstall` pass `afterDone` through (same option name, same type).

- [ ] **Step 4: Run, then commit**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/executor.test.ts && pnpm typecheck`
Expected: PASS, clean.

```bash
git add packages/dsh-plugin-shop/src/host/executor.ts packages/dsh-plugin-shop/tests/host/executor.test.ts
git commit -m "feat(host): afterDone seam — hot outcome settles before install reports done"
```

### Task D-3: gateway hot paths — install / uninstall / update

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (loaderFor, hot wiring, afterDone for all three flows)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts` (extend)

**Interfaces:**
- Consumes: `hotMount`/`hotUnmount` from D-1, the `afterDone` seam from D-2.
- Produces: `ShopGatewayOptions` gains `hot?: { mount: typeof hotMount; unmount: typeof hotUnmount }` (test injection; production = the real functions) and `loaderEntries?: () => Array<{ options: { name?: string }; fiber?: unknown; update(options: { disabled: boolean | null }, create?: boolean, force?: boolean): Promise<void> }>` (test injection; production reads `ctx.loader`). A private `liveDisable(name): Promise<boolean>` retries `entry.update({ disabled: true }, false, true)` until `entry.fiber === undefined` or 3 attempts (3 × 200ms) — the mandatory sequencing for updates (a plugin providing cordis services would otherwise have two live instances and the second provision throws).

- [ ] **Step 1: Loader + hot access helpers**

In `index.ts`, add (next to `listInventory`):

```ts
  private loaderEntries(): Array<LoaderEntryLike> {
    if (this.loaderEntriesInjected !== undefined) return this.loaderEntriesInjected()
    const loader = (this.ctx as unknown as { loader?: { entries(): Iterable<LoaderEntryLike> } }).loader
    return loader === undefined ? [] : [...loader.entries()]
  }
```

with a structural `LoaderEntryLike` interface (options.name, fiber, update) declared near `InventoryEntry`. Add the `hot` option field and use `this.hot ?? { mount: hotMount, unmount: hotUnmount }`.

- [ ] **Step 2: `liveDisable` with the retry loop**

```ts
  /** Live-disable one boot-layer entry, retrying until its fiber is actually
   * down. A disable can land while the entry's init is still in flight: the
   * options flip but the finishing init brings the fiber up anyway, and a
   * plain re-update no-ops on the empty diff (dsh-market themes.ts:74-93).
   * For an update swap this sequencing is mandatory, not defensive: two live
   * instances of a service-providing plugin would collide at provision. */
  private async liveDisable(name: string): Promise<boolean> {
    let found = false
    for (const entry of this.loaderEntries()) {
      if (entry.options.name !== name) continue
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await entry.update({ disabled: true }, false, true)
          found = true
        } catch {
          break
        }
        if (entry.fiber === undefined) break
        await new Promise(resolve => setTimeout(resolve, 200))
      }
    }
    return found
  }
```

- [ ] **Step 3: Install — hot-mount, update-aware**

In `install()`: before spawning, record whether this is an update:

```ts
    const manifest = readProfileManifest('dsh-plugin-shop', this.profileDirResolved())
    const isUpdate = (manifest.dependencies ?? {})[args.name] !== undefined
```

Pass to `startInstall`:

```ts
      afterDone: async () => {
        const hot = this.hot ?? { mount: hotMount, unmount: hotUnmount }
        if (isUpdate) {
          // Sequencing: the old instance must be down before the new one
          // mounts (see liveDisable). A failure here falls back to restart.
          await this.liveDisable(args.name)
        }
        const result = await hot.mount(
          { plugin: (plugin, config) => (this.ctx as unknown as { plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void } }).plugin(plugin, config) },
          this.profileDirResolved(),
          args.name,
        )
        return result.ok
          ? { needsRestart: false }
          : { needsRestart: true, restartReason: result.reason ?? undefined }
      },
```

(Self-update excluded by construction: `updateStart` calls `startInstall` without `afterDone`, so it keeps `needsRestart: true` — the host half cannot swap itself live.)

- [ ] **Step 4: Uninstall — hotUnmount, else live-disable**

In `uninstall()`, pass:

```ts
      afterDone: async () => {
        const hot = this.hot ?? { mount: hotMount, unmount: hotUnmount }
        const hotRemoved = await hot.unmount(args.name)
        const disabled = hotRemoved || await this.liveDisable(args.name)
        // Privilege is revoked the moment the fiber is gone; the boot
        // composition drops the entry row at next boot.
        return { needsRestart: false }
      },
```

If neither a hot mount nor a live entry existed (e.g. the plugin never loaded), still return `{ needsRestart: false }` — the package is removed from the profile manifest; nothing can come back.

- [ ] **Step 5: Tests through the RPC**

Extend `index.test.ts` with injected `hot` fakes and a `loaderEntries` fixture. Representative case (install, fresh — no manifest dep):

```ts
import { describe, expect, it, vi } from 'vitest' // vi joins the existing imports

describe('hot paths', () => {
  // Hoist C-2's `gatewayOptions` helper to file scope — reused here.
  const hotMount = vi.fn(async () => ({ ok: true, reason: null }))
  const hotUnmount = vi.fn(async () => false)

  it('install reports done with needsRestart false after a hot mount', async () => {
    // Fixture: catalog snapshot + profile manifest without the name (fresh
    // install), dshBin pointing at the executor's fake dsh fixture.
    const gateway = new ShopGateway({} as never, { ...gatewayOptions(), hot: { mount: hotMount, unmount: hotUnmount } })
    // ... existing setup for installStart through a fixture snapshot ...
    const started = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const record = /* poll installStatus until terminal, or await via the executor fixture */
    expect(hotMount).toHaveBeenCalledTimes(1)
    expect(record.status().state).toBe('done')
    expect(record.status().needsRestart).toBe(false)
  })
})
```

Cover, with the same fakes:
- update (manifest dep present, loader entry whose `update` + `fiber` are controllable): `update({ disabled: true }, false, true)` called BEFORE mount; retry — first two updates leave `fiber` set, the third clears it — assert three calls.
- mount returns `{ ok: false, reason: 'r' }` → status `needsRestart: true` + `restartReason: 'r'`.
- uninstall: unmount true → no loader calls; unmount false + loader entry → disabled live; status `needsRestart: false`.
- self-update (`updateStart`) still reports `needsRestart: true` (no afterDone wired).

- [ ] **Step 6: Run and commit**

Run: `cd packages/dsh-plugin-shop && pnpm vitest run tests/host/index.test.ts tests/host/executor.test.ts && pnpm typecheck`
Expected: all green.

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "feat(host): hot install/uninstall/update paths through the afterDone seam (market borrowings D)"
```

### Task D-4: client notices — live install, restart reasons

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts` (carry `restartReason`; uninstall view gains needsRestart)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` (render the reason; live-uninstall notice)
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` (en + zh strings)
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`, `ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `InstallStatus.restartReason` from D-2.
- Produces: the done view carries `{ kind: 'done'; needsRestart: boolean; restartReason?: string }`; the uninstall done view carries `needsRestart`.

- [ ] **Step 1: `present.ts`**

`InstallView`'s done variant and `reduceInstall`'s `done` case gain `restartReason: status.restartReason` (only when defined). Mirror for the uninstall reducer: the done state carries `needsRestart: !!status.needsRestart` and the UI strings below branch on it.

- [ ] **Step 2: `ShopTab.tsx` + locales**

- InstallPanel done view: when `view.needsRestart && view.restartReason` render the reason line (plain text — host-supplied, bilingual) instead of the generic `installedRestartNotice`; when `!view.needsRestart` keep the existing `installedNoRestartNotice` (the live case — no copy change needed).
- UninstallPanel: when `needsRestart === false` show the new `uninstalledLiveNotice` (the plugin stopped immediately; the entry row clears at next boot) instead of `uninstalledRestartNotice`; keep the RestartPanel only when `needsRestart`.
- Add to `locales.ts` (en): `uninstalledLiveNotice: 'Removed and stopped immediately. The profile\'s boot composition picks up the removal at the next restart.'` — and the Chinese equivalent stating the same two facts.

- [ ] **Step 3: Tests**

- `present.test.ts`: a done status with `restartReason` carries it; a done status without keeps the old shape; uninstall done carries `needsRestart`.
- `ShopTab.client.spec.tsx`: done + needsRestart false renders the live notice and no restart panel; done + needsRestart true + reason renders the reason text (assert it is text content, not HTML).

- [ ] **Step 4: Run and commit**

Run: `cd packages/dsh-plugin-shop && pnpm typecheck && pnpm test`
Expected: all green.

```bash
git add packages/dsh-plugin-shop/src/client/
git commit -m "feat(client): live-install notices and restart reasons (market borrowings D)"
```

### Task D-5: optional peer dependency + real-composition e2e

**Files:**
- Modify: `packages/dsh-plugin-shop/package.json` (peerDependencies + peerDependenciesMeta)
- Modify: `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts` (extend with a hot-mount scenario) or add `packages/dsh-plugin-shop/tests/client/hot-mount.e2e.ts` following the same harness
- Test fixture: a plugin package whose patch is plain id/name rows and that "proves its own liveness" by registering an HTTP route from `apply()` (dsh-market's install.e2e.ts pattern)

**Interfaces:**
- Produces: the include plugin hoists into the profile at install time; a real dsh web composition proves the install → hot-mount → liveness chain end to end.

- [ ] **Step 1: Declare the optional peer**

In `package.json`, add to `peerDependencies`:

```json
    "@deepseek-ai/cordis-plugin-include": "^1.0.6"
```

and to `peerDependenciesMeta`:

```json
    "@deepseek-ai/cordis-plugin-include": {
      "optional": true
    }
```

Run `pnpm install` (locks update). Verify `pnpm typecheck` still passes — `hot.ts` imports the module only through the computed dynamic specifier, never as a static type dependency.

- [ ] **Step 2: The liveness fixture plugin**

Extend `tests/fixtures/hello-packages/` (or add a sibling): a package with `dsh.bundle: { patch: './cordis.patch.yml' }` whose patch is exactly:

```yml
- id: e2e-live
  name: dsh-shop-e2e-live
```

and whose apply registers a route proving it runs (mirror the e2e's existing composition setup; if the harness's web server route registration is not available to a fixture this simple, assert liveness through the loader inventory instead — `pluginInventory` must list the entry with `enabled: true` — and say so in the test comment).

- [ ] **Step 3: The e2e scenario**

In the e2e harness (real dsh web composition in a throwaway `DSH_HOME`, local npm registry serving the packed shop + the fixture): browse → acknowledge → install the fixture → poll `installStatus` to `done` → assert `needsRestart === false` → assert liveness (the fixture's route answers, or the inventory lists it enabled) → uninstall → assert `needsRestart === false` and the inventory no longer lists it enabled. Keep the existing restart-required scenario intact (it now exercises the fallback when the fixture has config rows — add a second fixture variant with a config row for that case, or reuse an existing one).

Run it the way the existing e2e runs (it needs a reachable dsh CLI; if the local environment cannot run it, run the suite once to confirm the new spec wires in and note the CI lane runs it).

- [ ] **Step 4: Run and commit**

Run: `cd packages/dsh-plugin-shop && pnpm typecheck && pnpm test`
Expected: all green locally; e2e green or skipped-with-reason (never silently — the suite already treats skips loudly).

```bash
git add packages/dsh-plugin-shop/package.json pnpm-lock.yaml packages/dsh-plugin-shop/tests/
git commit -m "feat: optional include-plugin peer + hot-mount e2e with a self-proving fixture"
```

---

## Final checks (run once after the last task)

- [ ] `pnpm test` (root), `pnpm typecheck` (root), `cd packages/dsh-plugin-shop && pnpm test && pnpm typecheck` — all green.
- [ ] `git status` clean except the pre-existing untracked `packages/dsh-plugin-shop/tests/client/self-update-repro.spec.ts` (never committed by this plan).
- [ ] The authority spec and the borrowings design agree with the code (Task A-7 shipped the amendments with their features).
- [ ] The `SHOP_CATALOG_V5` flip remains UNFLIPPED — release choreography, per the memory "never publish without confirmation"; the release commit flips it when the v5 client ships.
