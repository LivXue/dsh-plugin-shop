# Activation model — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shop's two-valued `needsRestart` with a three-valued `activation` (`live` / `reload` / `restart`), so install, update, uninstall and enable/disable each tell the reader what they actually have to do — including the case the shop has never been able to express: *the server is already correct, this page is stale*.

**Architecture:** One pure decision (`activationOf`) fed by two shell reads — the hot-mount outcome, and whether the installed package declares `dsh.client`. The value travels on the existing `installStatus` poll and on `setEnabled`'s result, and the client renders a Reload button where it used to render nothing.

**Tech Stack:** TypeScript ESM (`.ts` extensions in local imports), vitest, React 18 + CSS modules for the client half, Playwright + a real `dsh` for the e2e.

**Spec:** `docs/design/2026-09-11-activation-model.md` (and §8 of `docs/design/2026-08-18-dsh-plugin-shop-design.md`, amended 2026-09-11)

## Global Constraints

- **Pure core, impure shell.** `activation.ts` takes no clock, network, filesystem, environment or locale. `client-half.ts` touches the filesystem only through an injected seam.
- **`strict` and `noUncheckedIndexedAccess` are on.** Guard index access; never assert it away.
- **ESM everywhere**, `.ts` extensions in local relative imports.
- **Files end with exactly one trailing newline.**
- **Reason codes are codes, never copy.** The host bakes no user-facing English or Chinese; the client renders through the locale dictionaries.
- **User-facing docs are bilingual**: `packages/dsh-plugin-shop/README.md` and `packages/dsh-plugin-shop/docs/README.zh.md` state the same facts, each in its own register — not a word-for-word translation.
- **Tests describe behavior.** If a change makes a test obsolete, change it and say why in the commit; never edit an assertion just to make a run green.
- Run `pnpm test` (vitest) and `pnpm typecheck` (tsc --noEmit) from the repository root.

---

### Task 1: The activation decision

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/activation.ts`
- Test: `packages/dsh-plugin-shop/tests/host/activation.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type Activation = 'live' | 'reload' | 'restart'` and `export function activationOf(input: { hostLive: boolean; hasClientHalf: boolean }): Activation`. Tasks 3–6 all import from this module.

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-plugin-shop/tests/host/activation.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { activationOf } from '../../src/host/activation.ts'

describe('activationOf', () => {
  it('demands a restart whenever the host half is not running', () => {
    // A client half cannot rescue a host half that never composed: the
    // browser graph is built from the LOADER's entries, so a package the
    // loader does not hold contributes nothing to reload into.
    expect(activationOf({ hostLive: false, hasClientHalf: true })).toBe('restart')
    expect(activationOf({ hostLive: false, hasClientHalf: false })).toBe('restart')
  })

  it('asks for a reload when the host is live and the package has a browser half', () => {
    expect(activationOf({ hostLive: true, hasClientHalf: true })).toBe('reload')
  })

  it('reports live when the host is live and there is no browser half to refresh', () => {
    expect(activationOf({ hostLive: true, hasClientHalf: false })).toBe('live')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/activation.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/host/activation.ts"`.

- [ ] **Step 3: Write the module**

Create `packages/dsh-plugin-shop/src/host/activation.ts`:

```ts
/**
 * What a reader must do before a change the shop just made becomes visible
 * (design 2026-09-11-activation-model §2).
 *
 * A dsh plugin has two halves that go live by different routes. The host
 * half is composed by the loader; the browser half reaches a tab only
 * through `window.__DSH_BOOT__`, which the harness rebuilds from the live
 * loader entries on every index request. So a tab that predates the change
 * is stale by one RELOAD, not by one restart — measured 2026-09-11 against
 * dsh 0.1.5-rc.1, where a runtime disable, a runtime enable and a hot mount
 * each moved the served graph within seconds without the process
 * restarting.
 *
 * Three values, not two booleans: `needsRestart` plus `needsReload` would
 * admit a true/true that the system cannot be in, and would make every
 * reader re-derive the precedence.
 *
 * This answers about VISIBILITY, never about correctness. `live` does not
 * claim the plugin works; tiering (§9) and harness compatibility
 * (2026-09-01-harness-compatibility) are what speak to that.
 */
export type Activation = 'live' | 'reload' | 'restart'

/**
 * Decide what the reader must do.
 *
 * @param input.hostLive - whether the plugin's host half is running in this
 * process right now: the hot-mount outcome for an install or update, and
 * unconditionally true for an uninstall (the fiber is gone) and for a
 * toggle (the user layer is hot-reloaded).
 * @param input.hasClientHalf - whether the package declares `dsh.client`.
 * An unreadable manifest reports `true`; see `client-half.ts` for why.
 */
export function activationOf(input: { hostLive: boolean; hasClientHalf: boolean }): Activation {
  if (!input.hostLive) return 'restart'
  return input.hasClientHalf ? 'reload' : 'live'
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/activation.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/activation.ts packages/dsh-plugin-shop/tests/host/activation.test.ts
git commit -m "feat(shop): the three-valued activation decision

A plugin has two halves and the shop has only ever reported on one.
'reload' is the state it could not express: the server is already
correct and the open tab is showing what came before."
```

---

### Task 2: Reading whether a package has a browser half

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/client-half.ts`
- Test: `packages/dsh-plugin-shop/tests/host/client-half.test.ts`

**Interfaces:**
- Consumes: `HotFs` (already exported from `src/host/hot.ts`; its `read(path: string): string` throws on a missing file). `memHotFs()` from `tests/host/mem-fs.ts` satisfies it.
- Produces: `export function hasClientHalf(fs: HotFs, profileDir: string, packageName: string): boolean`. Task 4 calls it.

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-plugin-shop/tests/host/client-half.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { hasClientHalf } from '../../src/host/client-half.ts'
import { memHotFs } from './mem-fs.ts'

const PROFILE = '/profile'

function withManifest(packageName: string, manifest: unknown): ReturnType<typeof memHotFs> {
  const fs = memHotFs()
  fs.write(join(PROFILE, 'node_modules', packageName, 'package.json'), JSON.stringify(manifest))
  return fs
}

describe('hasClientHalf', () => {
  it('is true when the package declares dsh.client', () => {
    const fs = withManifest('dsh-themer', { name: 'dsh-themer', dsh: { client: { inject: [], platform: 'web' } } })
    expect(hasClientHalf(fs, PROFILE, 'dsh-themer')).toBe(true)
  })

  it('is true for an EMPTY dsh.client object — the declaration is the fact, not its contents', () => {
    const fs = withManifest('dsh-themer', { name: 'dsh-themer', dsh: { client: {} } })
    expect(hasClientHalf(fs, PROFILE, 'dsh-themer')).toBe(true)
  })

  it('is false for a host-only package', () => {
    const fs = withManifest('dsh-tooler', { name: 'dsh-tooler', dsh: { bundle: { patch: './cordis.patch.yml' } } })
    expect(hasClientHalf(fs, PROFILE, 'dsh-tooler')).toBe(false)
  })

  it('is false when the package declares no dsh section at all', () => {
    const fs = withManifest('dsh-tooler', { name: 'dsh-tooler' })
    expect(hasClientHalf(fs, PROFILE, 'dsh-tooler')).toBe(false)
  })

  it('is false when dsh.client is present but not an object — a non-declaration', () => {
    for (const value of [null, 'web', 42, ['web']]) {
      const fs = withManifest('dsh-odd', { name: 'dsh-odd', dsh: { client: value } })
      expect(hasClientHalf(fs, PROFILE, 'dsh-odd')).toBe(false)
    }
  })

  it('assumes a client half when the manifest cannot be read', () => {
    // Offering a reload nobody needed costs one keystroke; withholding one
    // that was needed is the defect this module exists to fix. The
    // asymmetry decides the fallback — it is not a judgement call.
    expect(hasClientHalf(memHotFs(), PROFILE, 'dsh-absent')).toBe(true)
  })

  it('assumes a client half when the manifest is not JSON', () => {
    const fs = memHotFs()
    fs.write(join(PROFILE, 'node_modules', 'dsh-broken', 'package.json'), '{ not json')
    expect(hasClientHalf(fs, PROFILE, 'dsh-broken')).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/client-half.test.ts`
Expected: FAIL — cannot resolve `../../src/host/client-half.ts`.

- [ ] **Step 3: Write the module**

Create `packages/dsh-plugin-shop/src/host/client-half.ts`:

```ts
/**
 * Does an installed package have a browser half? (design
 * 2026-09-11-activation-model §3.)
 *
 * The harness's `ClientModuleRegistry` scans the loader's entries for
 * packages declaring `dsh.client` and composes `window.__DSH_BOOT__` from
 * them. That declaration is therefore the whole question: a package that
 * declares it puts something in a browser tab, and a tab opened before the
 * change is showing the state from before it.
 *
 * The read goes through `HotFs`, the same injected seam `hot.ts` uses to
 * read the same file for `dsh.bundle.patch`, so tests never touch disk and
 * exactly one production call site does.
 */

import { join } from 'node:path'
import type { HotFs } from './hot.ts'

/**
 * Whether `packageName`, as installed in `profileDir`, declares `dsh.client`.
 *
 * **An unreadable manifest answers `true`.** Offering a reload that was not
 * needed costs the reader one keystroke; withholding one that was needed is
 * the defect this module exists to fix, so the fallback is the safe side of
 * a lopsided asymmetry rather than a guess.
 *
 * The VALUE of `dsh.client` is not inspected — an empty object is a
 * declaration. Only a non-object (the manifest saying something else
 * entirely) reads as no declaration.
 */
export function hasClientHalf(fs: HotFs, profileDir: string, packageName: string): boolean {
  let text: string
  try {
    text = fs.read(join(profileDir, 'node_modules', packageName, 'package.json'))
  } catch {
    // Absent, unreadable, or removed between the caller's check and this
    // read. Nothing else can reach this catch, and every branch of it means
    // the same thing: we cannot tell, so assume the reload is needed.
    return true
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    // The package is on disk with a manifest we cannot parse. Same rule.
    return true
  }
  const client = (manifest as { dsh?: { client?: unknown } } | null)?.dsh?.client
  return typeof client === 'object' && client !== null && !Array.isArray(client)
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/client-half.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/client-half.ts packages/dsh-plugin-shop/tests/host/client-half.test.ts
git commit -m "feat(shop): read whether an installed package declares dsh.client

The harness composes the browser graph from exactly this declaration,
so it is the whole question. An unreadable manifest answers true: a
reload nobody needed costs a keystroke, a missing one is the bug."
```

---

### Task 3: The executor carries `activation`

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts` — `InstallStatus` (around line 18), the `afterDone` option type (lines 440, 634, 714), and the `status()` closure (lines 468–476, 555–559)
- Modify: `packages/dsh-plugin-shop/tests/host/executor.test.ts`

**Interfaces:**
- Consumes: `Activation` from Task 1.
- Produces: `InstallStatus.activation?: Activation` replacing `needsRestart?: boolean`; `afterDone?: (home: string | undefined) => Promise<{ activation: Activation; restartReason?: HotRestartReason } | void>`. Task 4 supplies those callbacks; Task 5 reads the field off the wire.

- [ ] **Step 1: Change the executor's test expectations first**

In `packages/dsh-plugin-shop/tests/host/executor.test.ts`, replace every `needsRestart` assertion with its `activation` equivalent:

- `expect(status.needsRestart).toBe(true)` → `expect(status.activation).toBe('restart')`
- `expect(status.needsRestart).toBe(false)` → `expect(status.activation).toBe('live')` where the fixture's `afterDone` returns a live host with no client half; `'reload'` where it returns one with a client half
- an `afterDone` returning `{ needsRestart: false }` → `{ activation: 'live' }`
- an `afterDone` returning `{ needsRestart: true, restartReason: 'not-simple' }` → `{ activation: 'restart', restartReason: 'not-simple' }`

Find them with:

```bash
grep -n "needsRestart" packages/dsh-plugin-shop/tests/host/executor.test.ts
```

Then add this test, which pins the default — the property self-update relies on:

```ts
it('defaults a done install with no afterDone to restart', async () => {
  // `updateStart` passes no afterDone, so this default IS the shop's
  // self-update rule: a host half cannot swap itself live (§8).
  const running = startInstall({
    profile: 'web',
    spec: 'dsh-hello-fixture@1.0.0',
    dshBin: fakeDshBin({ exit: 0 }),
    expectedName: 'dsh-hello-fixture',
  })
  const status = await running.finished
  expect(status.state).toBe('done')
  expect(status.activation).toBe('restart')
})
```

Adapt `fakeDshBin` / the spawn harness to whatever the surrounding tests in this file already use — do not introduce a second pattern.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/executor.test.ts`
Expected: FAIL — `status.activation` is `undefined`.

- [ ] **Step 3: Change the executor**

In `src/host/executor.ts`, add the import and change the three shapes:

```ts
import type { Activation } from './activation.ts'
```

```ts
export interface InstallStatus {
  state: InstallState
  log: string[]
  /** What the reader must do for this change to be visible (design
   * 2026-09-11-activation-model). Present only on `done`. Absent means the
   * install is still running or failed, never "nothing to do". */
  activation?: Activation
  restartReason?: HotRestartReason
  detail?: string
}
```

In `spawnPluginCli`, rename the accumulator and change its default:

```ts
  // The default is `restart`, and it is load-bearing: `updateStart` passes
  // no `afterDone`, so the shop's own self-update lands here — a host half
  // cannot swap itself live (§8).
  let activationOnDone: Activation = 'restart'
  let restartReason: HotRestartReason | undefined
```

```ts
  const status = (): InstallStatus => ({
    state,
    log: [...log],
    ...(state === 'done' ? { activation: activationOnDone, ...(restartReason !== undefined ? { restartReason } : {}) } : {}),
    ...(detail !== undefined ? { detail } : {}),
  })
```

At the `afterDone` settle site (near line 555):

```ts
            activationOnDone = outcome?.activation ?? 'restart'
            restartReason = outcome?.restartReason
```

and in its failure arm:

```ts
            activationOnDone = 'restart'
            restartReason = 'mount-failed'
```

Change the `afterDone` option type in all three declarations (`spawnPluginCli`, `startInstall`, `startUninstall` — lines 440, 634, 714):

```ts
  afterDone?: (home: string | undefined) => Promise<{ activation: Activation; restartReason?: HotRestartReason } | void>
```

Update the doc comment above `spawnPluginCli` (line ~422) so it names the new field: *"its result sets `activation` (default `restart`) and `restartReason`"*.

- [ ] **Step 4: Run and watch it pass**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/executor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/executor.ts packages/dsh-plugin-shop/tests/host/executor.test.ts
git commit -m "refactor(shop): the executor reports activation, not needsRestart

The default moves from 'needs a restart' to 'restart', which is the
same rule said in the new vocabulary — and it is what keeps the shop's
own self-update correct without a special case."
```

---

### Task 4: The four flows report their activation

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` — `ShopSetEnabledResult` (line 141), the install `afterDone` (lines 879–893), the uninstall `afterDone` (lines 1090–1096), `setEnabled` (lines 590–634)
- Modify: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `activationOf` (Task 1), `hasClientHalf` (Task 2), the `afterDone` shape (Task 3).
- Produces: `ShopSetEnabledResult` becomes `{ ok: boolean; detail?: string; activation?: Activation }` — `activation` present exactly when `ok`. Task 6 renders it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/dsh-plugin-shop/tests/host/index.test.ts`, in the describe block that already drives installs with the `hot` injection:

```ts
it('reports reload when a hot-mounted package has a browser half', async () => {
  // The host is live; the tab that was open when it mounted is not.
  const gateway = makeGateway({ hot: { mount: async () => ({ ok: true, reason: null }), unmount: async () => true } })
  writeInstalledManifest(gateway, 'dsh-themer', { dsh: { client: { inject: [], platform: 'web' } } })
  const status = await runInstallToDone(gateway, 'dsh-themer')
  expect(status.activation).toBe('reload')
})

it('reports live when a hot-mounted package is host-only', async () => {
  const gateway = makeGateway({ hot: { mount: async () => ({ ok: true, reason: null }), unmount: async () => true } })
  writeInstalledManifest(gateway, 'dsh-tooler', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const status = await runInstallToDone(gateway, 'dsh-tooler')
  expect(status.activation).toBe('live')
})

it('reports restart with its reason when the hot mount failed, client half or not', async () => {
  const gateway = makeGateway({ hot: { mount: async () => ({ ok: false, reason: 'not-simple' as const }), unmount: async () => true } })
  writeInstalledManifest(gateway, 'dsh-themer', { dsh: { client: { inject: [], platform: 'web' } } })
  const status = await runInstallToDone(gateway, 'dsh-themer')
  expect(status.activation).toBe('restart')
  expect(status.restartReason).toBe('not-simple')
})

it('reports reload after uninstalling a package that had a browser half', async () => {
  // The ordering constraint: the manifest is GONE by the time the result is
  // composed, so a read placed in afterDone would answer the conservative
  // `true` for every package and this test would pass for the wrong reason.
  // The host-only case below is what discriminates.
  const gateway = makeGateway({ hot: { mount: async () => ({ ok: true, reason: null }), unmount: async () => true } })
  writeInstalledManifest(gateway, 'dsh-themer', { dsh: { client: { inject: [], platform: 'web' } } })
  const status = await runUninstallToDone(gateway, 'dsh-themer')
  expect(status.activation).toBe('reload')
})

it('reports live after uninstalling a host-only package', async () => {
  const gateway = makeGateway({ hot: { mount: async () => ({ ok: true, reason: null }), unmount: async () => true } })
  writeInstalledManifest(gateway, 'dsh-tooler', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const status = await runUninstallToDone(gateway, 'dsh-tooler')
  expect(status.activation).toBe('live')
})

it('reports reload from setEnabled when the toggled package has a browser half', async () => {
  const gateway = makeGateway({})
  writeInstalledManifest(gateway, 'dsh-themer', { dsh: { client: { inject: [], platform: 'web' } } })
  const result = await gateway.setEnabled({ name: 'dsh-themer', enabled: false })
  expect(result.ok).toBe(true)
  expect(result.activation).toBe('reload')
})

it('reports live from setEnabled for a host-only package', async () => {
  const gateway = makeGateway({})
  writeInstalledManifest(gateway, 'dsh-tooler', { dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const result = await gateway.setEnabled({ name: 'dsh-tooler', enabled: false })
  expect(result.activation).toBe('live')
})
```

`makeGateway`, `runInstallToDone`, `runUninstallToDone` and `writeInstalledManifest` stand for whatever this file already uses to build a gateway, drive a flow to its terminal status, and place a package manifest under the fake profile. **Do not add new helpers** — `index.test.ts` is 104 KB and already has them; find them first with `grep -n "function make\|function run\|profileDir" packages/dsh-plugin-shop/tests/host/index.test.ts | head -40` and reuse the existing names.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/index.test.ts -t activation`
Expected: FAIL — `activation` is `undefined` (install/uninstall) and absent from `setEnabled`'s result.

- [ ] **Step 3: Wire the four flows**

In `src/host/index.ts` add the imports:

```ts
import { activationOf, type Activation } from './activation.ts'
import { hasClientHalf } from './client-half.ts'
```

Widen the wire type (line ~141):

```ts
/** `shop/setEnabled` result (§7.3): an unknown name is a typed wire value,
 * not a thrown RPC error. `activation` is present exactly when `ok`, and
 * says what the reader must do for the toggle to be visible — a toggled
 * package with a browser half needs a reload, which this result used to be
 * unable to say (design 2026-09-11-activation-model §6). */
export interface ShopSetEnabledResult { ok: boolean; detail?: string; activation?: Activation }
```

Install `afterDone` (replaces lines 891–893):

```ts
        return result.ok
          ? { activation: activationOf({ hostLive: true, hasClientHalf: this.packageHasClientHalf(args.name) }) }
          : { activation: 'restart' as const, ...(result.reason !== null ? { restartReason: result.reason } : {}) }
```

Uninstall: read the client half **before** `startUninstall`, beside the existing `priorEntryIds` line (~1078), and close over it:

```ts
    // Read the browser half while the package is still on disk — `afterDone`
    // runs after the uninstall deleted its manifest, and the conservative
    // fallback would then answer `true` for every package, turning this
    // verdict into a constant. Same ordering constraint, same reason, as
    // `priorEntryIds` above.
    const hadClientHalf = this.packageHasClientHalf(args.name)
```

and replace the uninstall `afterDone`'s return (line ~1096):

```ts
        return { activation: activationOf({ hostLive: true, hasClientHalf: hadClientHalf }) }
```

`setEnabled`'s success return (line ~633):

```ts
    setUserLayerRows({ profileDir, rows: owned.map(id => ({ id, disabled: !args.enabled })) })
    // The user layer is hot-reloaded by the harness, so the host half is
    // already in its new state; a package with a browser half still needs
    // the open tab to reload (design 2026-09-11-activation-model §3).
    return { ok: true, activation: activationOf({ hostLive: true, hasClientHalf: this.packageHasClientHalf(args.name) }) }
```

Add the private helper next to the other profile reads, so exactly one call site names the fs seam:

```ts
  /** Whether an installed package declares `dsh.client`. The `hotFs` option
   * is the same seam `hot.ts` reads its patch through, so a fixture drives
   * this without touching disk. */
  private packageHasClientHalf(packageName: string): boolean {
    return hasClientHalf(this.hotFs ?? nodeHotFs, this.profileDirResolved(), packageName)
  }
```

If the gateway has no `hotFs` option yet, add one beside the existing `hot` injection (line ~81) typed `HotFs`, and export a `nodeHotFs` from `hot.ts` (it currently has a module-private `nodeFs`; rename the export, keep the internal use). Both are test seams in the style this file already uses.

- [ ] **Step 4: Run and watch them pass**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/host/index.test.ts`
Expected: PASS (whole file — the change touches shared shapes).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean. If `needsRestart` still appears anywhere, this is where it surfaces.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/index.ts packages/dsh-plugin-shop/src/host/hot.ts packages/dsh-plugin-shop/tests/host/index.test.ts
git commit -m "feat(shop): install, uninstall and toggle each report an activation

The uninstall read happens before the uninstall, for the same reason
priorEntryIds does: the manifest that answers the question is the one
the uninstall deletes, and the conservative fallback would quietly
turn the verdict into a constant."
```

---

### Task 5: The client understands three states

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts` — `InstallStatusShape` (line ~126), `InstallView` (line ~140), `reduceInstall`, and a new `activationNoticeKey`
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` — `zh` and `en`
- Modify: `packages/dsh-plugin-shop/tests/client/present.test.ts`

**Interfaces:**
- Consumes: `Activation` (Task 1), the wire field (Tasks 3–4).
- Produces: `InstallView`'s `done` arm becomes `{ kind: 'done'; activation: Activation; log: string[]; restartReason?: HotRestartReason }`; `export function activationNoticeKey(activation: Activation, restartReason: HotRestartReason | undefined): ShopLocaleKey`. Task 6 renders both.

- [ ] **Step 1: Write the failing tests**

Add to `packages/dsh-plugin-shop/tests/client/present.test.ts`:

```ts
describe('activationNoticeKey', () => {
  it('keeps the hot-mount reason codes on restart', () => {
    expect(activationNoticeKey('restart', 'not-simple')).toBe('hotNotSimpleNotice')
    expect(activationNoticeKey('restart', 'no-patch')).toBe('hotNoPatchNotice')
  })

  it('falls back to the generic restart line when no reason came with it', () => {
    expect(activationNoticeKey('restart', undefined)).toBe('installedRestartNotice')
  })

  it('names the reload state, and ignores any reason riding along with it', () => {
    // A reason is meaningful only under `restart`; rendering one here would
    // tell a reader their reload failed.
    expect(activationNoticeKey('reload', undefined)).toBe('installedReloadNotice')
    expect(activationNoticeKey('reload', 'not-simple')).toBe('installedReloadNotice')
  })

  it('names the live state', () => {
    expect(activationNoticeKey('live', undefined)).toBe('installedNoRestartNotice')
  })
})

describe('reduceInstall on a done status', () => {
  it('carries the activation the host sent', () => {
    const before: InstallView = { kind: 'running', installId: 'i1', log: [] }
    const after = reduceInstall(before, {
      type: 'status',
      status: { found: true, state: 'done', log: ['ok'], activation: 'reload' },
    })
    expect(after).toEqual({ kind: 'done', activation: 'reload', log: ['ok'] })
  })

  it('defaults a done status with no activation to restart', () => {
    // The host's own default is `restart` (executor.ts). Coercing an absent
    // field to anything cheaper would publish a success claim the host
    // never made.
    const before: InstallView = { kind: 'running', installId: 'i1', log: [] }
    const after = reduceInstall(before, { type: 'status', status: { found: true, state: 'done', log: [] } })
    expect(after).toMatchObject({ kind: 'done', activation: 'restart' })
  })
})
```

Add `activationNoticeKey` to the existing import from `../../src/client/present.ts` at the top of the file.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/client/present.test.ts`
Expected: FAIL — `activationNoticeKey` is not exported.

- [ ] **Step 3: Change present.ts**

Replace `restartReasonKey` (lines 18–26) with:

```ts
/** The done notice for one activation, as a locale key.
 *
 * A hot-mount reason code names WHY a restart is needed and is meaningful
 * only under `restart`; `live` and `reload` ignore any reason riding along,
 * because rendering one there would tell a reader their reload had failed.
 * An absent or unrecognized reason keeps the generic restart line rather
 * than showing a bare code. */
export function activationNoticeKey(activation: Activation, restartReason: HotRestartReason | undefined): ShopLocaleKey {
  if (activation === 'live') return 'installedNoRestartNotice'
  if (activation === 'reload') return 'installedReloadNotice'
  switch (restartReason) {
    case 'no-patch': return 'hotNoPatchNotice'
    case 'not-simple': return 'hotNotSimpleNotice'
    case 'host-unsupported': return 'hotHostUnsupportedNotice'
    case 'timeout': return 'hotTimeoutNotice'
    case 'mount-failed': return 'hotMountFailedNotice'
    default: return 'installedRestartNotice'
  }
}
```

Import the type: `import type { Activation } from '../host/activation.ts'` and re-export it (`export type { Activation }`) so the client half has one import site for it.

Change the two shapes:

```ts
export interface InstallStatusShape {
  found: boolean
  state: 'running' | 'done' | 'failed'
  log: string[]
  activation?: Activation
  restartReason?: HotRestartReason
  detail?: string
}
```

```ts
  | { kind: 'done'; activation: Activation; log: string[]; restartReason?: HotRestartReason }
```

And in `reduceInstall`'s `done` arm, replace the `needsRestart` line:

```ts
          // `?? 'restart'`, matching the host's own default
          // (`executor.ts` `activationOnDone`). An absent field must never
          // be read as the cheaper outcome: that would publish a success
          // claim the host never made.
          activation: status.activation ?? 'restart',
```

- [ ] **Step 4: Add the locale strings**

In `src/client/locales.ts`, add to `zh` beside `installedNoRestartNotice` (line 43):

```ts
  installedReloadNotice: '已生效；刷新页面即可看到',
  reload: '刷新页面',
  reloadNote: '服务器已经是新状态，当前页面显示的还是刷新前的内容。',
```

and to `en` beside its counterpart (line 150):

```ts
  installedReloadNotice: 'already applied; reload the page to see it',
  reload: 'Reload the page',
  reloadNote: 'The server is already in the new state; this page is still showing what came before.',
```

Also correct the toggle note, which is the copy that made the disable case wrong — it claims completeness it does not have. `zh` (line 106) and `en` (line 208):

```ts
  hotApplyNote: '已生效，无需重启',          // zh
  hotApplyNote: 'applied without a restart', // en
```

(The `reload` keys above are what now carries the rest of the story, rendered only when the host says `reload`.)

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/client/present.test.ts`
Expected: PASS. There is a locale-parity test in this suite that asserts `zh` and `en` have identical key sets — if it fails, a key was added to only one dictionary.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/present.ts packages/dsh-plugin-shop/src/client/locales.ts packages/dsh-plugin-shop/tests/client/present.test.ts
git commit -m "feat(shop): the client reads three activations, not a boolean

restartReasonKey becomes activationNoticeKey, and a reason is rendered
only under restart: showing one beside a reload would tell a reader
their reload had failed."
```

---

### Task 6: The Reload control

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` — the install done panel (lines ~449–467), the uninstall done panel (lines ~596–610), `EnabledSwitch` (lines ~759–806)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.module.css` (if the repo keeps the tab's styles there — confirm the import at the top of `ShopTab.tsx`)
- Modify: `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

**Interfaces:**
- Consumes: `activationNoticeKey`, `InstallView['activation']` (Task 5), `ShopSetEnabledResult.activation` (Task 4).
- Produces: a `ReloadPanel` rendered under `data-shop-reload`; the existing `data-shop-restart-notice`, `data-shop-restart-disabled` and `data-shop-hot-apply` hooks keep their names and meanings.

- [ ] **Step 1: Write the failing tests**

Add to `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`, following the file's existing render helpers:

```ts
it('offers a reload, not a restart, when an install reports reload', async () => {
  const { getByText, queryByText } = renderDonePanel({ activation: 'reload', log: [] })
  expect(getByText(en.installedReloadNotice)).toBeTruthy()
  expect(getByText(en.reload)).toBeTruthy()
  expect(queryByText(en.restart)).toBeNull()
})

it('offers neither control when an install reports live', async () => {
  const { getByText, queryByText } = renderDonePanel({ activation: 'live', log: [] })
  expect(getByText(en.installedNoRestartNotice)).toBeTruthy()
  expect(queryByText(en.reload)).toBeNull()
  expect(queryByText(en.restart)).toBeNull()
})

it('still offers the restart when an install reports restart', async () => {
  const { getByText, queryByText } = renderDonePanel({ activation: 'restart', restartReason: 'not-simple', log: [] })
  expect(getByText(en.hotNotSimpleNotice)).toBeTruthy()
  expect(getByText(en.restart)).toBeTruthy()
  expect(queryByText(en.reload)).toBeNull()
})

it('reloads the page when the reload button is pressed', async () => {
  const reload = vi.fn()
  const { getByText } = renderDonePanel({ activation: 'reload', log: [] }, { reload })
  fireEvent.click(getByText(en.reload))
  expect(reload).toHaveBeenCalledTimes(1)
})

it('shows the reload offer after a toggle whose package has a browser half', async () => {
  const { getByRole, getByText } = renderToggle({ setEnabled: async () => ({ ok: true, activation: 'reload' as const }) })
  // The control is `role="switch"` carrying `aria-label={t('enabledSwitch')}`
  // — a fixed label with the state in `aria-checked`, per the design's
  // 2026-09-07 ruling. Do not select it by its visible text.
  fireEvent.click(getByRole('switch', { name: en.enabledSwitch }))
  await waitFor(() => expect(getByText(en.reload)).toBeTruthy())
})

it('shows only the applied note after a toggle whose package is host-only', async () => {
  const { getByRole, getByText, queryByText } = renderToggle({ setEnabled: async () => ({ ok: true, activation: 'live' as const }) })
  fireEvent.click(getByRole('switch', { name: en.enabledSwitch }))
  await waitFor(() => expect(getByText(en.hotApplyNote)).toBeTruthy())
  expect(queryByText(en.reload)).toBeNull()
})
```

`renderDonePanel` and `renderToggle` stand for this file's existing render helpers — find them with `grep -n "function render" packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx` and reuse them rather than adding new ones. The reload must arrive through an **injected** callback (default `() => location.reload()`), because jsdom's `location.reload` is not writable.

- [ ] **Step 2: Run and watch them fail**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`
Expected: FAIL — no reload control exists.

- [ ] **Step 3: Add the panel and wire the three sites**

Add near `RestartPanel` in `ShopTab.tsx`:

```tsx
/** The §4 reload offer: the server already holds the new state and this tab
 * does not. Never automatic — a reload discards whatever the reader had in
 * flight (a conversation, a form, an upload), and the shop knows a reload
 * would help without knowing that now is a good time. */
function ReloadPanel({ t, reload }: { t: ShopTabInjected['t']; reload: () => void }): JSX.Element {
  return (
    <div className={css.reloadPanel} data-shop-reload>
      <p className={css.notice}>{t('reloadNote')}</p>
      <button type="button" className={css.reloadButton} onClick={reload}>{t('reload')}</button>
    </div>
  )
}
```

Add `reload?: () => void` to `ShopTabInjected`, defaulted once at the tab root:

```ts
const reload = injected.reload ?? (() => { globalThis.location.reload() })
```

Install done panel — replace the notice and the two restart lines:

```tsx
        <p className={css.notice} data-shop-restart-notice>
          {t(activationNoticeKey(view.activation, view.restartReason))}
        </p>
        {view.activation === 'reload' && <ReloadPanel t={t} reload={reload} />}
        {view.activation === 'restart' && restartSupported && <RestartPanel t={t} restart={restart} />}
        {view.activation === 'restart' && !restartSupported && (
          <p className={css.notice} data-shop-restart-disabled>{t('restartDisabledNotice')}</p>
        )}
```

Uninstall done panel — same three lines, with its own notice key:

```tsx
        <p className={css.notice} data-shop-uninstall-done>
          {view.activation === 'restart' ? t('uninstalledRestartNotice')
            : view.activation === 'reload' ? t('installedReloadNotice')
            : t('uninstalledLiveNotice')}
        </p>
        {view.activation === 'reload' && <ReloadPanel t={t} reload={reload} />}
        {view.activation === 'restart' && restartSupported && <RestartPanel t={t} restart={restart} />}
        {view.activation === 'restart' && !restartSupported && (
          <p className={css.notice} data-shop-restart-disabled>{t('restartDisabledNotice')}</p>
        )}
```

`EnabledSwitch` — keep the result's activation in the `saved` state and render accordingly (line ~804):

```tsx
      {toggle.kind === 'saved' && (
        <>
          <p className={css.notice} data-shop-hot-apply>{t('hotApplyNote')}</p>
          {toggle.activation === 'reload' && <ReloadPanel t={t} reload={reload} />}
        </>
      )}
```

widening that component's `toggle` state to carry `activation?: Activation` from the `setEnabled` result, and threading `reload` down to it the way `t` already is.

- [ ] **Step 4: Style the panel**

Add `.reloadPanel` and `.reloadButton` to the tab's CSS module, mirroring `.restartPanel` / `.restartButton`. **Do not use a background-layer fill as the button's only affordance** — all four `bg-layer` tokens collapse to the same white under `body` in the light theme, so the control would vanish there. Give it a border in a `--dsw-alias-*` token, as the restart button does.

- [ ] **Step 5: Run and watch them pass**

Run: `pnpm vitest run packages/dsh-plugin-shop/tests/client/`
Expected: PASS. The CSS token spec (`css-tokens.client.spec.ts`) will fail on a hardcoded colour — use tokens.

- [ ] **Step 6: Commit**

```bash
git add packages/dsh-plugin-shop/src/client/ packages/dsh-plugin-shop/tests/client/
git commit -m "feat(shop): offer a reload where the page, not the server, is stale

Never automatic: a reload discards whatever the reader had in flight,
and the shop knows a reload would help without knowing that now is a
good time."
```

---

### Task 7: An e2e fixture that actually has a browser half

**Files:**
- Create: `packages/dsh-plugin-shop/tests/fixtures/live-packages/dsh-shop-e2e-client/package.json`, `cordis.patch.yml`, `index.js`, `client.js`
- Modify: `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts` — the fixture list (lines ~418–424), the local-registry call (~433), and a new scenario
- Modify: `packages/dsh-plugin-shop/tests/fixtures/local-registry.ts` only if it enumerates fixtures by name

**Interfaces:**
- Consumes: everything above.
- Produces: nothing other tasks read.

- [ ] **Step 1: Create the fixture**

`package.json`:

```json
{
  "name": "dsh-shop-e2e-client",
  "version": "1.0.0",
  "private": true,
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "inject": [], "platform": "web" }
  }
}
```

`cordis.patch.yml`:

```yaml
# A plain `- id:` / `name:` insert — the only form the shop's hot tree can
# mount without a restart. Same shape as dsh-shop-e2e-live; what is new here
# is the `dsh.client` declaration in package.json.
- insert:
    - id: e2e-client
      name: dsh-shop-e2e-client
```

`index.js`:

```js
// The activation e2e fixture. Its reason for existing is the `dsh.client`
// declaration in package.json: the three older live fixtures declare only
// `dsh.bundle`, so every hot-mount assertion in this suite was made about a
// package with no browser half — which is exactly the blind spot the
// reload/restart confusion of 2026-09-11 came through.
module.exports = { apply() {} }
```

`client.js`:

```js
// Registers a factory and nothing else: the e2e asserts that the shop
// reported `reload`, not that this component renders. Keeping it inert
// means a harness change to the component contract cannot fail this suite
// for an unrelated reason.
window.__ModuleLoader__.load({ id: 'dsh-shop-e2e-client', factory: () => ({ apply() {} }) })
```

- [ ] **Step 2: Register it with the local registry**

In `web-full-flow.e2e.ts`, add beside the other three fixture dirs (~line 418):

```ts
  const clientFixtureDir = fileURLToPath(
    new URL('../fixtures/live-packages/dsh-shop-e2e-client', import.meta.url),
  )
```

and add it to the `startLocalRegistry` call (~line 433):

```ts
  localRegistry = await startLocalRegistry([liveFixtureDir, configFixtureDir, peerFixtureDir, clientFixtureDir])
```

- [ ] **Step 3: Write the failing scenario**

Add a case alongside the existing live/config hot-mount scenarios, following their exact structure (they walk the settings modal to the shop tab, install by name, and poll to the terminal state):

```ts
it('a hot-mounted package with a browser half reports reload and offers the button', async () => {
  await installFromShelf(page, 'dsh-shop-e2e-client')
  const done = page.locator('[data-shop-restart-notice]')
  await expect(done).toHaveText(zh.installedReloadNotice, { timeout: 30_000 })
  await expect(page.locator('[data-shop-reload]')).toBeVisible()
  // The restart offer must NOT appear: the host half is live, and telling
  // this reader to restart is the bug this fixture exists to catch.
  await expect(page.locator('[data-shop-restart-notice] ~ button', { hasText: zh.restart })).toHaveCount(0)
})
```

`installFromShelf` stands for whatever this suite already uses to drive an install from the shelf — reuse it. Read the contract header at the top of the file first: it owns the pinned selectors, and **the harness DOM contract is read through a11y roles, not private `data-*` attributes**, wherever the markup belongs to dsh rather than to the shop. `data-shop-*` hooks are ours and are fair game.

- [ ] **Step 4: Run the e2e**

Run: `pnpm -C packages/dsh-plugin-shop test`
Expected: PASS. The suite **skips itself** unless a real `dsh` is on PATH and a Playwright chromium is installed — a skip is not a pass. Confirm it actually ran: the output must name the new case, not report it skipped. If it skipped, say so rather than reporting green.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/tests/fixtures/live-packages/dsh-shop-e2e-client packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts
git commit -m "test(e2e): a live fixture that declares dsh.client

All three existing live fixtures are host-only, so every hot-mount
assertion in this suite was made about a package with no browser half.
That is the blind spot both 2026-09-11 reports came through."
```

---

### Task 8: The user docs stop promising a restart-free toggle

**Files:**
- Modify: `packages/dsh-plugin-shop/README.md` lines 122, 126
- Modify: `packages/dsh-plugin-shop/docs/README.zh.md` lines 113, 117

- [ ] **Step 1: Correct the English table**

Line 122 currently reads:

```
| **Enable / disable** | Applies to an installed plugin without a restart |
```

Replace with:

```
| **Enable / disable** | Applies to an installed plugin without a restart. A plugin with a browser half also needs the open page reloaded, and the shop offers the button when it does |
```

Line 126 currently reads:

```
| **Restart** | After an install, update, or uninstall, the shop offers to restart dsh — stating the cost first: the page disconnects and in-flight work is interrupted |
```

Replace with:

```
| **Reload** | When an install, uninstall, or toggle is already live on the server and only the open page is stale, the shop offers to reload that page — never automatically, because a reload discards work in flight |
| **Restart** | Only when the plugin's host half could not be brought up live. The shop offers to restart dsh, stating the cost first: the page disconnects and in-flight work is interrupted |
```

- [ ] **Step 2: Correct the Chinese table**

Line 113 currently reads:

```
| **启停** | 对已安装插件生效，无需重启 |
```

Replace with:

```
| **启停** | 对已安装插件生效，无需重启。带浏览器半边的插件还需要刷新当前页面，商店会在需要时给出按钮 |
```

Line 117 currently reads:

```
| **重启** | 安装、更新、卸载后商店会提议重启 dsh，并先说明代价：页面会断开，进行中的工作会中断 |
```

Replace with:

```
| **刷新** | 当安装、卸载或启停已经在服务端生效、只是当前页面还停在旧状态时，商店提议刷新这个页面——不会自动刷新，因为刷新会丢掉进行中的工作 |
| **重启** | 仅当插件的宿主半边没能热挂载时。商店提议重启 dsh，并先说明代价：页面会断开，进行中的工作会中断 |
```

These state the same facts in each language's own register; the Chinese is not a word-for-word rendering of the English.

- [ ] **Step 3: Full verification**

```bash
pnpm test > /tmp/activation-test.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/activation-test.log
pnpm typecheck
grep -rn "needsRestart" packages/dsh-plugin-shop/src packages/dsh-plugin-shop/tests || echo "no needsRestart left"
```

Expected: `EXIT=0`, a clean typecheck, and no surviving `needsRestart`. **Redirect and echo the exit code** — piping vitest into `tail` prints exit 0 over a red run.

- [ ] **Step 4: Commit**

```bash
git add packages/dsh-plugin-shop/README.md packages/dsh-plugin-shop/docs/README.zh.md
git commit -m "docs(shop): the toggle row stopped being true when the plugin has a UI

'Applies without a restart' is the host half's story. Both reports on
2026-09-11 were from readers who believed it and were looking at a
stale page."
```
