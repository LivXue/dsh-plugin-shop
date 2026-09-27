# Delegating package operations to dsh's plugin manager: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On a harness that offers dsh's `pluginManager` service (0.1.7 on), install, update, uninstall and switch plugins through that service instead of the `dsh plugin` CLI, and open the desktop profile, with the 0.1.5 path unchanged.

**Architecture:** A pure module (`plugin-manager.ts`) holds the structural types, capability detection and the mapping from the service's `ChangeResult` to the shop's install record. A runner (`manager-runner.ts`) wraps one service call as the same `RunningInstall` the CLI executor produces, inside the same per-profile queue. The gateway chooses the runner per operation by capability. No RPC changes shape.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), vitest 2.1.9, playwright 1.62 for the e2e, the real dsh 0.1.7-rc.2 and 0.1.5-rc.3 harnesses.

**Spec:** [docs/design/2026-09-26-plugin-manager-delegation.md](../design/2026-09-26-plugin-manager-delegation.md). Read it first: every rule below argues from it.

## Preconditions

Start from `main` after these are merged:

1. #64, the 0.1.7 CI leg, with its e2e fixes for 0.1.7's first run (the no-default-workspace seed and `waitForFirstRun`). Without it no automated run reaches the service path, and 0.1.7 e2e runs are not stable.
2. #65, the pnpm 12 abort hint. Task 2 routes the service's `unknown` failures through `installFailureDetail`, where that hint lives.
3. #67, the bundle switch. It introduces `pluginManager()`, `BundleSelector` and `setDeselectedEnabled` in `src/host/index.ts`, which Task 1 generalizes.

## Global Constraints

- Detection is by capability, never by version: `ctx.get('pluginManager')` whose `installBundle`, `removeBundle`, `setPluginEnabled` and `setBundleEnabled` are all functions (spec section 3.1).
- The service's types are declared structurally in the shop. The build compiles against the 0.1.1-rc.2 harness floor, where `@deepseek-ai/dsh-plugin-manager` does not exist, so nothing may import it.
- No RPC changes shape: `ShopInstallResult`, `ShopInstallStatusResult`, `ShopUninstallResult`, `ShopUpdateResult` and `ShopSetEnabledResult` keep their fields (spec section 3.4).
- The shop never sends `approvedBuilds` (spec section 8).
- When the service is absent, the CLI path behaves exactly as before, and every existing test passes unchanged, except the #67 fakes Task 1 completes.
- No detail a desktop reader can see contains a `dsh plugin` command. dsh's CLI rejects the desktop profile for every `plugin` subcommand, `allow-version` included (`rejectElectronProfile`, dsh 0.1.7-rc.2 `lib/bin.js`).
- Every sentence the shop writes for a service error code or failure kind says what dsh's own source says the code means (the table in Task 2), never what its name suggests. These strings are published to plugin authors and users.
- Comments and records are ASCII-only English. A user-visible string moved from existing code keeps its exact characters. A new `catch` names what it swallows and why nothing else can reach it.
- Service fixtures mirror the full `ChangeResult` shape measured on 0.1.7-rc.2 (spec section 2), not only the fields the code reads.
- Releasing is out of scope. The first build carrying this goes through `beta`, at a version LivXue confirms.

## Where this plan departs from the spec

Each is written into the spec in Task 11.

- **Section 7 names two details that print a `dsh plugin` command. Four do:** the undo in `alsoConfirm`, readiness B1's `allow-version` refusal, `installTimeoutDetail` ("Run it yourself ... dsh plugin --profile X install") and `installFailureDetail`'s hint ("pnpm failed in the profile. Run: dsh plugin ..."). Task 2 covers all four.
- **Section 7 sends a desktop reader to "dsh's Settings, Plugins page" for the exemption. There is none there.** 0.1.7-rc.2's Plugins page (`dsh-client-ui-plugin-manager`) offers no exemption flow; the service has `setVersionExemption`, but no page calls it. The desktop refusal says the exemption cannot be granted from the shop or the CLI, and points nowhere it cannot verify.
- **`install-state` events are not subscribed.** Section 6 says a phase moves the record to `running`. The record is already `running` from the moment the queue hands it the turn, so the phases would change nothing a reader sees. Only `install-log` is routed.
- **`overridden` from a switch carries no note.** `ShopSetEnabledResult` has no field for one on success, and adding it changes an RPC shape. A switch maps `overridden` to plain success; the client's next `installed()` shows the live state. An install's note does reach its reader: the wire already carries `detail` on a done record, and Task 9 renders it.

## Review Focus

Inputs the spec implies but no rule names, most likely to bite first. Each has a test in the task that owns the code.

1. **A log chunk arriving after its record settled, or a line split across two chunks.** Late output must not reopen or grow a finished record, and a split line must read as one (Task 4).
2. **The service rejecting instead of answering, or the shop's own reading of the answer throwing** (a transport failure, `InvalidInstallSpecError`, a post-install check that cannot read the package). The record fails with the message, never stays `running`, and the profile's queue slot is released (Task 4).
3. **The deadline firing while dsh is applying the bundle.** `cancelInstall` answers `too-late`, the runner keeps waiting, and the record settles exactly once (Task 4).
4. **A `ChangeResult` whose `application` this shop does not know**, from a later harness. It must fail loudly with what dsh answered, never read as success (Task 2).
5. **The desktop profile with the service present and failing.** Every detail the reader can reach, the timeout and pnpm-failure ones included, is free of `dsh plugin` commands (Tasks 2 and 8).

---

### Task 0: Branch and baseline

**Files:** none changed.

- [ ] **Step 1: Branch from the merged main**

```bash
git fetch github
git switch -c feat/plugin-manager-delegation github/main
git log --oneline -8   # must show the merges of #64, #65 and #67
```

- [ ] **Step 2: Record the baseline on both harnesses**

Run each with the harness first on `PATH`, vitest launched by node directly (npx rewrites `PATH`), and the expectation set, so the run proves which dsh it booted:

```bash
cd packages/dsh-plugin-shop
PATH=<0.1.7-rc.2 prefix>/bin:$PATH DSH_SHOP_REQUIRE_E2E=1 DSH_SHOP_EXPECT_DSH=0.1.7-rc.2 node node_modules/vitest/vitest.mjs run
PATH=<0.1.5-rc.3 prefix>/bin:$PATH DSH_SHOP_REQUIRE_E2E=1 DSH_SHOP_EXPECT_DSH=0.1.5-rc.3 node node_modules/vitest/vitest.mjs run
```

Expected: all green, except that under machine load `the install deadline and the process group (F-1)`, `retains at most 32 finished installs` and `sortByStars cost (G-5)` can exceed their bounds (all three pass alone). Write the totals down; Task 11 compares against them.

---

### Task 1: The service's shape and its detection

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/plugin-manager.ts`
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (`BundleSelector`, `pluginManager()`, the type of `change` in `setDeselectedEnabled`)
- Test: `packages/dsh-plugin-shop/tests/host/plugin-manager.test.ts`, `packages/dsh-plugin-shop/tests/host/index.test.ts` (`withManager`)

**Interfaces:**
- Produces: `interface PluginManagerLike`, `function asPluginManager(service: unknown): PluginManagerLike | null`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/host/plugin-manager.test.ts
import { describe, expect, it } from 'vitest'
import { asPluginManager } from '../../src/host/plugin-manager.ts'

const fn = async (): Promise<unknown> => ({})
const complete = { installBundle: fn, removeBundle: fn, setPluginEnabled: fn, setBundleEnabled: fn, cancelInstall: fn }

describe('asPluginManager', () => {
  it('takes a service that offers every operation the shop calls', () => {
    expect(asPluginManager(complete)).toBe(complete)
  })

  it('refuses a service missing any one of the four operations', () => {
    // A harness offering half the service would take an install through it
    // and then fail the uninstall; all or nothing is the rule.
    for (const method of ['installBundle', 'removeBundle', 'setPluginEnabled', 'setBundleEnabled'] as const) {
      const partial: Record<string, unknown> = { ...complete }
      delete partial[method]
      expect(asPluginManager(partial), method).toBeNull()
    }
  })

  it('takes a service without cancelInstall, which only the deadline uses', () => {
    const { cancelInstall: _unused, ...rest } = complete
    expect(asPluginManager(rest)).not.toBeNull()
  })

  it('refuses what is not a service at all', () => {
    expect(asPluginManager(undefined)).toBeNull()
    expect(asPluginManager(null)).toBeNull()
    expect(asPluginManager('pluginManager')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/plugin-manager.test.ts` (in `packages/dsh-plugin-shop`)
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the module**

```ts
// src/host/plugin-manager.ts
/**
 * dsh's `pluginManager` service (0.1.7 on), as far as this shop calls it:
 * design 2026-09-26-plugin-manager-delegation. Structural throughout: the
 * build compiles against the 0.1.1-rc.2 harness floor, where
 * `@deepseek-ai/dsh-plugin-manager` does not exist.
 */

/** The operations the shop calls. `cancelInstall` is optional because only
 * the install deadline uses it. Answers stay `unknown` until `readChange`
 * reads them: a later harness may add or drop fields. */
export interface PluginManagerLike {
  installBundle(spec: string, options: { requestId: string }): Promise<unknown>
  removeBundle(name: string): Promise<unknown>
  /** `id` is the live loader entry id `listPlugins` reports (`include:...`),
   * not the patch row id (dsh 0.1.7-rc.2 `setPluginEnabled`). */
  setPluginEnabled(id: string, enabled: boolean): Promise<unknown>
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>
  cancelInstall?(requestId: string): Promise<unknown>
}

const REQUIRED = ['installBundle', 'removeBundle', 'setPluginEnabled', 'setBundleEnabled'] as const

/** The service, when `service` offers every required operation; else null.
 * All or nothing: half a service would take an install and fail its
 * uninstall. */
export function asPluginManager(service: unknown): PluginManagerLike | null {
  if (typeof service !== 'object' || service === null) return null
  const candidate = service as Record<string, unknown>
  if (!REQUIRED.every(method => typeof candidate[method] === 'function')) return null
  if (candidate.cancelInstall !== undefined && typeof candidate.cancelInstall !== 'function') return null
  return service as PluginManagerLike
}
```

- [ ] **Step 4: Point the gateway at it**

In `src/host/index.ts`, delete the `BundleSelector` interface #67 added and replace `pluginManager()`:

```ts
import { asPluginManager, type PluginManagerLike } from './plugin-manager.ts'

  /** dsh's `pluginManager` service, when the running harness provides all of
   * it (0.1.7 and later), else null. Read on each use, like `pluginPackages`.
   * Design 2026-09-26-plugin-manager-delegation, section 3.1. */
  private pluginManager(): PluginManagerLike | null {
    return asPluginManager((this.ctx as { get?: (name: string) => unknown }).get?.('pluginManager'))
  }
```

In `setDeselectedEnabled`, `change` was typed from `BundleSelector`. Type it locally instead:

```ts
    let change: { application?: unknown; error?: { code?: unknown; diagnostic?: unknown } }
    try {
      change = (await manager.setBundleEnabled(name, true)) as typeof change
```

In `tests/host/index.test.ts`, the #67 fakes offer `setBundleEnabled` alone, which the stricter detection now refuses. Complete them in one place, `withManager`, with every other operation rejecting, so a call the case must not make fails it:

```ts
  /** A pluginManager: `partial`'s operations, and every other one the shop's
   * detection requires, each rejecting so a stray call fails the case. */
  const completeService = (partial: object): object => {
    const refuse = (method: string) => async (): Promise<never> => { throw new Error(`this case must not call ${method}`) }
    return {
      installBundle: refuse('installBundle'),
      removeBundle: refuse('removeBundle'),
      setPluginEnabled: refuse('setPluginEnabled'),
      setBundleEnabled: refuse('setBundleEnabled'),
      ...partial,
    }
  }
  const withManager = (service: object): never =>
    ({ get: (name: string) => name === 'pluginManager' ? completeService(service) : undefined, reflect: { provide: () => {} } }) as never
```

- [ ] **Step 5: Run the new file and the gateway file**

Run: `node node_modules/vitest/vitest.mjs run tests/host/plugin-manager.test.ts tests/host/index.test.ts`
Expected: PASS, every case, #67's included.

- [ ] **Step 6: Commit**

```bash
git add src/host/plugin-manager.ts src/host/index.ts tests/host/plugin-manager.test.ts tests/host/index.test.ts
git commit -m "feat(shop): read dsh's pluginManager as one structural service, detected by capability"
```

---

### Task 2: Reading the service's answer

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/plugin-manager.ts`
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts` (`installFailureDetail` gains a `hint` parameter)
- Test: `packages/dsh-plugin-shop/tests/host/plugin-manager.test.ts`, `packages/dsh-plugin-shop/tests/host/executor.test.ts`

**Interfaces:**
- Consumes: `installFailureDetail(profile, log, hint?)` and `installTimeoutDetail(profile, timeoutMs)` from `executor.ts`; `allowVersionCommand(profile, { name, version, runtimeVersion }): string | null` from `compatibility.ts`; `activationOf({ hostLive, clientLive, hasClientHalf }): Activation` from `activation.ts`; `HotRestartReason` from `hot.ts`.
- Produces:
  - `interface ManagerIncompatible { name: string; version: string; runtimeVersion: string; peers: Record<string, string> }`
  - `interface ManagerChange { application: string | null; stage: string | null; errorCode: string | null; diagnostic: string | null; incompatible: ManagerIncompatible[]; kind: string | null; output: string; pendingBuilds: string[]; failedAt: string | null }`
  - `function readChange(raw: unknown): ManagerChange`
  - `function codeSentence(code: string): string | undefined`
  - `interface ManagerOutcome { state: 'done' | 'failed'; activation?: Activation; restartReason?: HotRestartReason; detail?: string }`
  - `interface OutcomeContext { profile: string; name: string; operation: 'install' | 'update' | 'uninstall'; alreadyImported: boolean; hasClientHalf: boolean; desktop: boolean; timeoutMs: number }`
  - `function managerOutcome(raw: unknown, context: OutcomeContext): ManagerOutcome`

What each code and kind means, read from `@deepseek-ai/dsh-plugin-manager` 0.1.7-rc.2 `lib/index.js` on 2026-09-27. The sentences below say exactly this:

| Code or kind | Raised when |
|---|---|
| `unknown-plugin` | `setPluginEnabled`: no `listPlugins` row has that entry id |
| `invalid-spec` | the install spec does not parse |
| `ambiguous-install` | after pnpm, not exactly one dependency changed, so dsh cannot tell what the install added |
| `not-bundle` | the package has no bundle manifest |
| `not-removable` | `removeBundle`: no such bundle, or dsh marks it not removable |
| `stop-profile` | `removeBundle` on a running bundle while dsh runs without HMR |
| `bundle-in-use` | the bundle was deselected, but some of its entries still have a live fiber |
| `stale-approval` | a build approval names a package pnpm no longer holds pending |
| `management-required` | the entry is one of dsh's own protected modules, or the service's owner entry |
| `unaddressable` | the entry is not exactly one row of the profile's own patch under the root `include` (a tree the shop hot-mounted itself is one) |
| `operation-error` | anything else, with its exact message as `diagnostic` |
| kind `timeout` | pnpm's run hit dsh's own time bound |
| kind `pnpm-missing` | pnpm could not be spawned (ENOENT) |
| kind `not-found` | `ERR_PNPM_FETCH_404`, `E404`, `404 Not Found` |
| kind `no-matching-version` | `ERR_PNPM_NO_MATCHING_VERSION`, `ETARGET` |
| kinds `disk-full`, `permission`, `integrity`, `network` | `ENOSPC`; `EACCES` or `EPERM`; tarball integrity codes; connection errors and `ERR_PNPM_FETCH_5xx` |
| `failedAt` `registry`, `spec-host` | which host the failure is attributed to |

- [ ] **Step 1: Give `installFailureDetail` a hint parameter, test first**

Append to `tests/host/executor.test.ts`:

```ts
describe('installFailureDetail with a caller hint', () => {
  it('opens with the caller hint in place of the CLI command', () => {
    // The desktop profile takes no `dsh plugin` command, so the plugin
    // manager runner passes a hint that names none.
    const detail = installFailureDetail('desktop', ['ERR_PNPM_FOO boom'], 'pnpm failed in the profile')
    expect(detail).toMatch(/^pnpm failed in the profile /)
    expect(detail).toContain('ERR_PNPM_FOO boom')
    expect(detail).not.toContain('dsh plugin')
  })

  it('keeps the CLI command when no hint is given', () => {
    expect(installFailureDetail('web', ['ERR_PNPM_FOO boom'])).toContain('Run: dsh plugin --profile web install')
  })
})
```

Run: `node node_modules/vitest/vitest.mjs run tests/host/executor.test.ts -t "caller hint"`
Expected: the first case FAILS (the hint is ignored), the second passes.

Then change the signature in `src/host/executor.ts` and delete the body's own `const hint = ...` line, leaving the rest of the body as it is:

```ts
export function installFailureDetail(
  profile: string,
  log: readonly string[],
  hint = `pnpm failed in the profile. Run: dsh plugin --profile ${profile} install`,
): string {
```

Run the file: PASS.

- [ ] **Step 2: Write the failing table for `managerOutcome`**

Every row states the break it catches. The results are the full shape the real service returned when probed (spec section 2), trimmed only of fields no rule reads.

```ts
// tests/host/plugin-manager.test.ts, appended
import { managerOutcome, type OutcomeContext } from '../../src/host/plugin-manager.ts'

const context: OutcomeContext = {
  profile: 'web', name: 'dsh-managed', operation: 'install',
  alreadyImported: false, hasClientHalf: false, desktop: false, timeoutMs: 900_000,
}
const desktop: OutcomeContext = { ...context, profile: 'desktop', desktop: true }
const applied = { changed: true, application: 'applied', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null], warnings: [] }
const refused = {
  changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', enabled: true, registries: [null],
  error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-managed', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }] },
  packageResult: { exitCode: 1, output: '', truncated: false, logPath: '/l', kind: 'unknown' },
}
const pnpmFailed = (kind: string, output: string, extra: object = {}) => ({
  changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', registries: [null], ...extra,
  packageResult: { exitCode: 1, output, truncated: false, logPath: '/l', kind },
})

describe('managerOutcome', () => {
  it('builds the refusal from the structured list, with the exemption command', () => {
    // Rule 1. Nothing is parsed: the list is dsh's own record.
    const outcome = managerOutcome(refused, context)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('@deepseek-ai/dsh 0.1.2-rc.1')
    expect(outcome.detail).toContain('dsh plugin --profile web allow-version dsh-managed@1.0.0 --dsh-version 0.1.7-rc.2 --accept-risk')
  })

  it('tells a desktop reader the exemption cannot be granted here, and prints no command', () => {
    const detail = managerOutcome(refused, desktop).detail ?? ''
    expect(detail).toContain('@deepseek-ai/dsh 0.1.2-rc.1')
    expect(detail).not.toContain('dsh plugin')
    expect(detail).toMatch(/does not manage the desktop profile/)
  })

  it('never reports an enablement failure after pnpm succeeded as a done install', () => {
    // Rule 2, the confusion dsh-market reported as a bug (fa8722a).
    const outcome = managerOutcome({ ...applied, application: 'failed', error: { code: 'operation-error', diagnostic: 'duplicate entry id' }, packageResult: { exitCode: 0, output: '', truncated: false, logPath: '/l' } }, context)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toMatch(/is installed, but dsh could not enable it/)
    expect(outcome.detail).toContain('duplicate entry id')
    expect(outcome.detail).toMatch(/Uninstall it from the shop/)
  })

  it('names the builds pnpm is holding, and the approval step, for build-blocked', () => {
    const outcome = managerOutcome(pnpmFailed('build-blocked', 'ERR_PNPM_IGNORED_BUILDS', { pendingBuilds: ['esbuild'] }), context)
    expect(outcome.detail).toContain('esbuild')
    expect(outcome.detail).toContain('approve-builds')
  })

  it('reads an unknown failure through installFailureDetail, where the pnpm 12 hint lives', () => {
    const outcome = managerOutcome(pnpmFailed('unknown', 'memory allocation of 671088640 bytes failed\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace'), context)
    expect(outcome.detail).toContain('pnpm/pnpm#15362')
  })

  it('reads an unknown failure for a desktop reader without the CLI command', () => {
    const detail = managerOutcome(pnpmFailed('unknown', 'ERR_PNPM_SOMETHING went wrong'), desktop).detail ?? ''
    expect(detail).toContain('ERR_PNPM_SOMETHING went wrong')
    expect(detail).not.toContain('dsh plugin')
  })

  it('says what a classified failure was and where', () => {
    expect(managerOutcome(pnpmFailed('not-found', 'ERR_PNPM_FETCH_404', { failedAt: 'registry' }), context).detail)
      .toBe('dsh-plugin-shop: the install failed at the registry: no such package was found.')
    expect(managerOutcome(pnpmFailed('network', 'ENOTFOUND', { failedAt: 'spec-host' }), context).detail)
      .toBe('dsh-plugin-shop: the install failed at the host the package is fetched from: the network failed.')
    expect(managerOutcome(pnpmFailed('disk-full', 'ENOSPC'), context).detail)
      .toBe('dsh-plugin-shop: the install failed: the disk is full.')
  })

  it('carries a management code with the sentence dsh source gives it, and dsh diagnostic', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'remove', target: 'dsh-managed', error: { code: 'bundle-in-use', diagnostic: 'still mounted' } }, { ...context, operation: 'uninstall' })
    expect(outcome.detail).toBe('dsh-plugin-shop: dsh refused the uninstall of dsh-managed (bundle-in-use): the bundle was switched off, but some of its plugins are still running. dsh reported: still mounted')
  })

  it('still reports a code this shop has no sentence for', () => {
    const outcome = managerOutcome({ changed: false, application: 'failed', stage: 'install', target: 'x', error: { code: 'brand-new-code' } }, context)
    expect(outcome).toEqual({ state: 'failed', detail: 'dsh-plugin-shop: dsh refused the install of dsh-managed (brand-new-code).' })
  })

  it('reads a cancelled install as the timeout, with the command outside the desktop profile only', () => {
    const cancelled = { changed: false, application: 'cancelled', stage: 'install', target: 'x' }
    const web = managerOutcome(cancelled, context)
    expect(web.state).toBe('failed')
    expect(web.detail).toContain('did not finish within 900s')
    expect(web.detail).toContain('dsh plugin --profile web install')
    const app = managerOutcome(cancelled, desktop)
    expect(app.detail).toContain('did not finish within 900s')
    expect(app.detail).not.toContain('dsh plugin')
  })

  it('asks for a restart when dsh does, and names an update as already loaded', () => {
    expect(managerOutcome({ ...applied, application: 'restart-required' }, { ...context, operation: 'update' }))
      .toEqual({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
    expect(managerOutcome({ ...applied, application: 'restart-required' }, context))
      .toEqual({ state: 'done', activation: 'restart' })
  })

  it('keeps overridden as success, with a note that another layer decides', () => {
    const outcome = managerOutcome({ ...applied, application: 'overridden' }, context)
    expect(outcome.state).toBe('done')
    expect(outcome.detail).toMatch(/higher-priority layer/)
  })

  it('reads applied as live for a host-only install and as reload for one with a browser half', () => {
    expect(managerOutcome(applied, context)).toEqual({ state: 'done', activation: 'live' })
    expect(managerOutcome(applied, { ...context, hasClientHalf: true })).toEqual({ state: 'done', activation: 'reload' })
  })

  it('asks for a restart when this process imported the package before, whatever dsh applied', () => {
    // Design 2026-09-26-market-borrowings section 1: Node answers a second
    // import with the module it cached. Open item O1 may retire this rule.
    expect(managerOutcome(applied, { ...context, alreadyImported: true }))
      .toEqual({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
  })

  it('fails loudly on an application it does not know', () => {
    // Review Focus 4: a later harness answering something new must not read
    // as success.
    const outcome = managerOutcome({ ...applied, application: 'deferred' }, context)
    expect(outcome.state).toBe('failed')
    expect(outcome.detail).toContain('"deferred"')
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/plugin-manager.test.ts`
Expected: FAIL, `managerOutcome` is not exported.

- [ ] **Step 4: Write the reading**

```ts
// src/host/plugin-manager.ts, appended
import { activationOf, type Activation } from './activation.ts'
import { allowVersionCommand } from './compatibility.ts'
import { installFailureDetail, installTimeoutDetail } from './executor.ts'
import type { HotRestartReason } from './hot.ts'

export interface ManagerIncompatible { name: string; version: string; runtimeVersion: string; peers: Record<string, string> }

/** The facts of one answer, each checked for its type. */
export interface ManagerChange {
  application: string | null
  stage: string | null
  errorCode: string | null
  diagnostic: string | null
  incompatible: ManagerIncompatible[]
  kind: string | null
  output: string
  pendingBuilds: string[]
  failedAt: string | null
}

const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}

function incompatibleList(value: unknown): ManagerIncompatible[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const entry = record(item)
    const name = text(entry.name)
    const version = text(entry.version)
    const runtimeVersion = text(entry.runtimeVersion)
    if (name === null || version === null || runtimeVersion === null) return []
    const peers = Object.fromEntries(
      Object.entries(record(entry.peers)).filter((pair): pair is [string, string] => typeof pair[1] === 'string'),
    )
    return [{ name, version, runtimeVersion, peers }]
  })
}

/** Read one `ChangeResult`. Every field is optional: one a later harness
 * drops reads as absent, never as a crash. */
export function readChange(raw: unknown): ManagerChange {
  const result = record(raw)
  const error = record(result.error)
  const run = record(result.packageResult)
  const fromError = incompatibleList(error.incompatible)
  return {
    application: text(result.application),
    stage: text(result.stage),
    errorCode: text(error.code),
    diagnostic: text(error.diagnostic),
    incompatible: fromError.length > 0 ? fromError : incompatibleList(run.incompatible),
    kind: text(run.kind),
    output: text(run.output) ?? '',
    pendingBuilds: Array.isArray(result.pendingBuilds)
      ? result.pendingBuilds.filter((name): name is string => typeof name === 'string')
      : [],
    failedAt: text(result.failedAt),
  }
}

export interface ManagerOutcome { state: 'done' | 'failed'; activation?: Activation; restartReason?: HotRestartReason; detail?: string }

export interface OutcomeContext {
  profile: string
  name: string
  operation: 'install' | 'update' | 'uninstall'
  /** The gateway's `imported` record holds the name (market borrowings section 1). */
  alreadyImported: boolean
  hasClientHalf: boolean
  /** The desktop profile, whose readers can run no `dsh plugin` command. */
  desktop: boolean
  timeoutMs: number
}

/** What each management code means, in dsh 0.1.7-rc.2's own terms (the
 * implementation plan of 2026-09-27, Task 2, records where each is raised). */
const CODE_SENTENCE: Record<string, string> = {
  'unknown-plugin': 'dsh lists no plugin entry by that id',
  'invalid-spec': 'dsh could not read the install spec',
  'ambiguous-install': 'dsh could not tell which package the install added',
  'not-bundle': 'the package is not a dsh bundle',
  'not-removable': 'dsh does not allow removing this bundle',
  'stop-profile': 'the bundle is running and this dsh cannot unload it live, so the profile has to be stopped first',
  'bundle-in-use': 'the bundle was switched off, but some of its plugins are still running',
  'stale-approval': 'a build approval names a package pnpm no longer holds',
  'management-required': 'the plugin belongs to dsh itself',
  unaddressable: "the plugin is not a row of the profile's own patch, so dsh cannot address it",
  'operation-error': 'dsh hit an unexpected error',
}

/** The sentence for a management code, when this shop has one. */
export function codeSentence(code: string): string | undefined {
  return CODE_SENTENCE[code]
}

/** What each classified pnpm failure was, as dsh classifies it. */
const KIND_SENTENCE: Record<string, string> = {
  'pnpm-missing': 'pnpm could not be started',
  timeout: "pnpm did not finish within dsh's own time bound",
  'not-found': 'no such package was found',
  'no-matching-version': "no version matching the catalog's was found",
  network: 'the network failed',
  'disk-full': 'the disk is full',
  permission: 'permission was denied',
  integrity: 'the downloaded package failed its integrity check',
}

const WHERE: Record<string, string> = {
  registry: ' at the registry',
  'spec-host': ' at the host the package is fetched from',
}

/** The pnpm-failure hint a desktop reader gets: it names no command, which
 * the CLI would refuse for that profile. */
const DESKTOP_FAILURE_HINT = 'pnpm failed in the profile'

function refusalDetail(context: OutcomeContext, incompatible: readonly ManagerIncompatible[]): string {
  const refused = incompatible.map(issue =>
    `${issue.name}@${issue.version} declares ${Object.entries(issue.peers).map(([peer, range]) => `${peer} ${range}`).join(', ')},`
    + ` which dsh ${issue.runtimeVersion} does not satisfy`)
  const base = `dsh-plugin-shop: dsh refused the install: ${refused.join('; ')}. Nothing was installed.`
  if (context.desktop) {
    return `${base} dsh's CLI, which grants version exemptions, does not manage the desktop profile, and this shop grants none.`
  }
  const commands = incompatible
    .map(issue => allowVersionCommand(context.profile, issue))
    .filter((command): command is string => command !== null)
  if (commands.length === 0) return base
  return `${base} To accept the risk of crashes or data loss for ${commands.length === 1 ? 'this exact version' : 'these exact versions'},`
    + ` run: ${commands.join('; ')} - then install again.`
}

function sentenceAndReport(change: ManagerChange, code: string): string {
  const sentence = CODE_SENTENCE[code]
  const said = change.diagnostic !== null ? ` dsh reported: ${change.diagnostic}` : ''
  return `${sentence !== undefined ? `: ${sentence}` : ''}.${said}`
}

function cancelledDetail(context: OutcomeContext): string {
  if (!context.desktop) return installTimeoutDetail(context.profile, context.timeoutMs)
  const seconds = Math.max(1, Math.round(context.timeoutMs / 1000))
  return `dsh-plugin-shop: the ${context.operation} did not finish within ${seconds}s, and the shop cancelled it.`
}

/** A `ChangeResult` as the shop's terminal install record: design
 * 2026-09-26-plugin-manager-delegation, section 5. The first rule that
 * matches wins. */
export function managerOutcome(raw: unknown, context: OutcomeContext): ManagerOutcome {
  const change = readChange(raw)
  if (change.errorCode === 'incompatible-version') {
    return { state: 'failed', detail: refusalDetail(context, change.incompatible) }
  }
  if (change.application === 'failed' && change.stage === 'enable') {
    const code = change.errorCode ?? 'failed'
    return {
      state: 'failed',
      detail: `dsh-plugin-shop: ${context.name} is installed, but dsh could not enable it (${code})`
        + `${sentenceAndReport(change, code)} Uninstall it from the shop to undo the install.`,
    }
  }
  if (change.application === 'failed' && change.errorCode === null) {
    if (change.kind === 'build-blocked') {
      const held = change.pendingBuilds.length > 0 ? change.pendingBuilds.join(', ') : 'a dependency'
      return {
        state: 'failed',
        detail: `dsh-plugin-shop: pnpm is holding the build scripts of ${held}, which it blocks by default:`
          + ' run `pnpm approve-builds` in the profile directory to allow them, then install again.',
      }
    }
    const sentence = change.kind === null ? undefined : KIND_SENTENCE[change.kind]
    if (sentence !== undefined) {
      const where = change.failedAt === null ? '' : WHERE[change.failedAt] ?? ''
      return { state: 'failed', detail: `dsh-plugin-shop: the ${context.operation} failed${where}: ${sentence}.` }
    }
    const lines = change.output.split(/\r?\n/).filter(line => line !== '')
    return {
      state: 'failed',
      detail: context.desktop
        ? installFailureDetail(context.profile, lines, DESKTOP_FAILURE_HINT)
        : installFailureDetail(context.profile, lines),
    }
  }
  if (change.errorCode !== null) {
    return {
      state: 'failed',
      detail: `dsh-plugin-shop: dsh refused the ${context.operation} of ${context.name} (${change.errorCode})${sentenceAndReport(change, change.errorCode)}`,
    }
  }
  if (change.application === 'cancelled') {
    return { state: 'failed', detail: cancelledDetail(context) }
  }
  if (change.application === 'restart-required') {
    return context.operation === 'update'
      ? { state: 'done', activation: 'restart', restartReason: 'already-loaded' }
      : { state: 'done', activation: 'restart' }
  }
  if (change.application === 'applied' || change.application === 'overridden') {
    const note = change.application === 'overridden'
      ? { detail: 'Saved, but a higher-priority layer (the home or invocation patch) decides whether it runs.' }
      : {}
    if (context.operation !== 'uninstall' && context.alreadyImported) {
      return { state: 'done', activation: 'restart', restartReason: 'already-loaded', ...note }
    }
    return {
      state: 'done',
      activation: activationOf({ hostLive: true, clientLive: true, hasClientHalf: context.hasClientHalf }),
      ...note,
    }
  }
  return {
    state: 'failed',
    detail: `dsh-plugin-shop: dsh answered the ${context.operation} with "${change.application ?? 'nothing'}", which this shop does not know how to read.`,
  }
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `node node_modules/vitest/vitest.mjs run tests/host/plugin-manager.test.ts tests/host/executor.test.ts`
Expected: PASS, every row.

- [ ] **Step 6: Revert each guard once**

One at a time, restoring after each, and confirm a row fails: drop the `stage === 'enable'` branch; swap the two `restart-required` answers; remove the `alreadyImported` condition; make the final fallthrough return `done`; make `refusalDetail` ignore `desktop`; make `cancelledDetail` ignore `desktop`; pass no hint for desktop in the unknown branch.

- [ ] **Step 7: Commit**

```bash
git add src/host/plugin-manager.ts src/host/executor.ts tests/host/plugin-manager.test.ts tests/host/executor.test.ts
git commit -m "feat(shop): read the plugin manager's answer as the shop's install record"
```

---

### Task 3: The queue, the log and the download phase, shared

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts`
- Test: `packages/dsh-plugin-shop/tests/host/executor.test.ts`

**Interfaces:**
- Produces:
  - `export interface RunningInstall` (already defined; add `export`)
  - `export const INSTALL_TIMEOUT_MS` (already defined; add `export`)
  - `export function inProfileQueue<T>(profile: string, task: () => Promise<T>): { ahead: number; finished: Promise<T> }`
  - `export function createBoundedLog(): { push(line: string): void; lines(): string[] }`
  - `export function requestDownloadPhase(options: { prefetcher: Prefetcher; profile: string; spec: string; env?: NodeJS.ProcessEnv; log: (line: string) => void }): PrefetchRequest | null`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/host/executor.test.ts, appended
import { createBoundedLog, inProfileQueue, requestDownloadPhase } from '../../src/host/executor.ts'
import type { Prefetcher } from '../../src/host/prefetch.ts'

describe('inProfileQueue', () => {
  it('runs a task after every command already queued for the same profile', async () => {
    const order: string[] = []
    let release!: () => void
    const first = inProfileQueue('queue-share', () => new Promise<void>(resolve => { release = () => { order.push('first'); resolve() } }))
    const second = inProfileQueue('queue-share', async () => { order.push('second') })
    expect(first.ahead).toBe(0)
    expect(second.ahead).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    release()
    await second.finished
    expect(order).toEqual(['first', 'second'])
  })

  it('frees the slot when a task rejects', async () => {
    const failed = inProfileQueue('queue-reject', async () => { throw new Error('boom') })
    await expect(failed.finished).rejects.toThrow('boom')
    expect(inProfileQueue('queue-reject', async () => {}).ahead).toBe(0)
  })
})

describe('createBoundedLog', () => {
  it('keeps the newest lines within the line cap', () => {
    const log = createBoundedLog()
    for (let i = 0; i < 205; i++) log.push(`line ${i}`)
    expect(log.lines()).toHaveLength(200)
    expect(log.lines()[0]).toBe('line 5')
  })

  it('never drops the newest line, even alone over the byte cap', () => {
    const log = createBoundedLog()
    log.push('x'.repeat(70 * 1024))
    expect(log.lines()).toHaveLength(1)
  })
})

describe('requestDownloadPhase', () => {
  const prefetcher = (answer: ReturnType<Prefetcher['request']> | Error): Prefetcher => ({
    request: () => { if (answer instanceof Error) throw answer; return answer },
    release: () => {},
  })

  it('returns a started request and logs nothing of its own', () => {
    const lines: string[] = []
    expect(requestDownloadPhase({ prefetcher: prefetcher({ started: true }), profile: 'web', spec: 'a@1.0.0', log: line => lines.push(line) }))
      .toEqual({ started: true })
    expect(lines).toEqual([])
  })

  it('says why there is no download phase when pnpm is missing', () => {
    const lines: string[] = []
    requestDownloadPhase({ prefetcher: prefetcher({ started: false, reason: 'no-pnpm' }), profile: 'web', spec: 'a@1.0.0', log: line => lines.push(line) })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/pnpm not found on PATH/)
  })

  it('logs a request that throws and returns null, never rethrowing', () => {
    const lines: string[] = []
    expect(requestDownloadPhase({ prefetcher: prefetcher(new Error('cannot build')), profile: 'web', spec: 'a@1.0.0', log: line => lines.push(line) }))
      .toBeNull()
    expect(lines[0]).toMatch(/the download phase could not start/)
    expect(lines[0]).toContain('cannot build')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/executor.test.ts -t "inProfileQueue|createBoundedLog|requestDownloadPhase"`
Expected: FAIL, none is exported.

- [ ] **Step 3: Add the helpers beside `chain`, and move `spawnPluginCli` onto them**

```ts
/** Run `task` in `profile`'s queue, after every command already in it: the
 * queue `spawnPluginCli` uses, shared with the plugin manager's runner so the
 * two paths are never concurrent in one profile. `ahead` is how many commands
 * were queued or running when the slot was taken. */
export function inProfileQueue<T>(profile: string, task: () => Promise<T>): { ahead: number; finished: Promise<T> } {
  const ahead = enterQueue(profile)
  const finished = chain(profile, task).finally(() => { leaveQueue(profile) })
  return { ahead, finished }
}

/** An install record's log: the newest lines within MAX_LOG_LINES and
 * MAX_LOG_BYTES, never dropping the newest one. */
export function createBoundedLog(): { push(line: string): void; lines(): string[] } {
  const lines: string[] = []
  let bytes = 0
  return {
    push(line: string): void {
      lines.push(line)
      bytes += Buffer.byteLength(line)
      while ((lines.length > MAX_LOG_LINES || bytes > MAX_LOG_BYTES) && lines.length > 1) {
        const oldest = lines.shift()
        if (oldest !== undefined) bytes -= Buffer.byteLength(oldest)
      }
    },
    lines: () => [...lines],
  }
}
```

`requestDownloadPhase` is `spawnPluginCli`'s prefetch block, moved. First move its three log strings, unchanged character for character (they contain non-ASCII dashes, so cut and paste them, never retype), into constants beside it:

- `DOWNLOAD_PHASE_FAILED_PREFIX`: the "could not start" string up to and including the dash and space before `${(error as Error).message}`;
- `DOWNLOAD_PHASE_NO_PNPM`: the `'no-pnpm'` arm's string;
- `DOWNLOAD_PHASE_UNSUPPORTED`: the other arm's string.

Then:

```ts
/**
 * Ask the pump to warm `spec` while an operation waits its turn, and say in
 * that operation's log why there is no download phase when there is none.
 * Shared by the CLI executor and the plugin manager runner.
 */
export function requestDownloadPhase(options: {
  prefetcher: Prefetcher
  profile: string
  spec: string
  env?: NodeJS.ProcessEnv
  log: (line: string) => void
}): PrefetchRequest | null {
  const { prefetcher, profile, spec, env, log } = options
  let prefetch: PrefetchRequest
  try {
    prefetch = prefetcher.request({ profile, spec, cwd: resolveProfileDir(profile, env?.DSH_HOME), env, log })
  } catch (error) {
    log(`${DOWNLOAD_PHASE_FAILED_PREFIX}${(error as Error).message}`)
    return null
  }
  if (!prefetch.started) log(prefetch.reason === 'no-pnpm' ? DOWNLOAD_PHASE_NO_PNPM : DOWNLOAD_PHASE_UNSUPPORTED)
  return prefetch
}
```

Keep the long comment that sits above the block today; move it above `requestDownloadPhase`, because its account of why the `catch` is load-bearing still holds for both callers.

In `spawnPluginCli`:
- replace the moved block with:

  ```ts
  let prefetch: PrefetchRequest | null = null
  if (ahead > 0 && prefetcher !== undefined) {
    prefetch = requestDownloadPhase({ prefetcher, profile, spec: target, env, log: append })
  }
  if (prefetch?.started === true) state = 'downloading'
  ```
- replace `const log: string[] = []` and `let logBytes = 0` with `const log = createBoundedLog()`;
- in `append`, replace the push and the trimming loop with `log.push(line)`, keeping the terminal check and `onStatus?.(status())`;
- in `status()`, read `log: log.lines()`;
- `installFailureDetail(profile, log)` becomes `installFailureDetail(profile, log.lines())`.

Leave its queue code as it is. Add `export` to `interface RunningInstall` and to `const INSTALL_TIMEOUT_MS`.

- [ ] **Step 4: Run the whole executor file, then the gateway file**

Run: `node node_modules/vitest/vitest.mjs run tests/host/executor.test.ts tests/host/index.test.ts`
Expected: PASS, including every existing log, queue and download-phase case.

- [ ] **Step 5: Commit**

```bash
git add src/host/executor.ts tests/host/executor.test.ts
git commit -m "refactor(shop): share the profile queue, the bounded log and the download phase with a second runner"
```

---

### Task 4: The plugin manager runner

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/manager-runner.ts`
- Test: `packages/dsh-plugin-shop/tests/host/manager-runner.test.ts`

**Interfaces:**
- Consumes: `inProfileQueue`, `createBoundedLog`, `requestDownloadPhase`, `INSTALL_TIMEOUT_MS`, `RunningInstall` (Task 3); `lineSink`, `InstallStatus` (existing); `ManagerOutcome`, `readChange` (Task 2); `Prefetcher` from `prefetch.ts`.
- Produces:
  - `const MECHANISM_PREFIX = "via dsh's plugin manager:"`
  - `class ManagerLogs { open(requestId: string, sink: (text: string) => void): () => void; chunk(requestId: unknown, text: unknown): void }`
  - `interface ManagerOperationOptions`
  - `function startManagerOperation(options: ManagerOperationOptions): RunningInstall`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/host/manager-runner.test.ts
import { describe, expect, it, vi } from 'vitest'
import { inProfileQueue } from '../../src/host/executor.ts'
import { ManagerLogs, MECHANISM_PREFIX, startManagerOperation } from '../../src/host/manager-runner.ts'
import type { ManagerOutcome } from '../../src/host/plugin-manager.ts'
import type { Prefetcher } from '../../src/host/prefetch.ts'
import { isTerminalInstallState } from '../../src/shared/install-state.ts'

const done: ManagerOutcome = { state: 'done', activation: 'live' }

describe('startManagerOperation', () => {
  it('opens the log with the mechanism, then the lines dsh streams for this request', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-1', requestId: 'r1', mechanism: 'install dsh-a@1.0.0', logs,
      run: async requestId => { logs.chunk(requestId, 'Progress: resolved 1\r\n+ dsh-a 1.0.0\n'); return {} },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.log).toEqual([`${MECHANISM_PREFIX} install dsh-a@1.0.0`, 'Progress: resolved 1', '+ dsh-a 1.0.0'])
  })

  it('joins a line dsh streamed in two chunks', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-2', requestId: 'r2', mechanism: 'install x', logs,
      run: async requestId => { logs.chunk(requestId, 'Progress: res'); logs.chunk(requestId, 'olved 1\n'); return {} },
      outcome: () => done,
    })
    expect((await running.finished).log).toEqual([`${MECHANISM_PREFIX} install x`, 'Progress: resolved 1'])
  })

  it('takes the final output when no chunk arrived', async () => {
    const running = startManagerOperation({
      profile: 'runner-3', requestId: 'r3', mechanism: 'remove dsh-a', logs: new ManagerLogs(),
      run: async () => ({ packageResult: { output: 'Packages: -1\nDone' } }),
      outcome: () => done,
    })
    expect((await running.finished).log).toEqual([`${MECHANISM_PREFIX} remove dsh-a`, 'Packages: -1', 'Done'])
  })

  it('ignores a chunk for another request, and one that arrives after the record settled', async () => {
    const logs = new ManagerLogs()
    const running = startManagerOperation({
      profile: 'runner-4', requestId: 'r4', mechanism: 'install dsh-b@1.0.0', logs,
      run: async () => { logs.chunk('someone-else', 'not mine\n'); return {} },
      outcome: () => done,
    })
    await running.finished
    logs.chunk('r4', 'too late\n')
    expect(running.status().log).toEqual([`${MECHANISM_PREFIX} install dsh-b@1.0.0`])
  })

  it('fails the record and frees the queue when the service call rejects', async () => {
    const running = startManagerOperation({
      profile: 'runner-5', requestId: 'r5', mechanism: 'install dsh-c@1.0.0', logs: new ManagerLogs(),
      run: async () => { throw new Error('plugin-manager: a local path must be absolute: ./x') },
      outcome: () => done,
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toContain('a local path must be absolute')
    expect(inProfileQueue('runner-5', async () => {}).ahead).toBe(0)
  })

  it('fails the record, never leaving it running, when the post-install check throws', async () => {
    const running = startManagerOperation({
      profile: 'runner-6', requestId: 'r6', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => ({}), outcome: () => done,
      alsoConfirm: () => { throw new Error('ENOENT: no such file, package.json') },
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.detail).toContain('ENOENT')
    expect(inProfileQueue('runner-6', async () => {}).ahead).toBe(0)
  })

  it('waits its turn behind a command already queued in the same profile, downloading meanwhile', async () => {
    let release!: () => void
    inProfileQueue('runner-7', () => new Promise<void>(resolve => { release = resolve }))
    const run = vi.fn(async () => ({}))
    const released = vi.fn()
    const prefetcher: Prefetcher = { request: () => ({ started: true }), release: released }
    const running = startManagerOperation({
      profile: 'runner-7', requestId: 'r7', mechanism: 'install x@1.0.0', logs: new ManagerLogs(),
      run, outcome: () => done, prefetcher, spec: 'x@1.0.0',
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(run).not.toHaveBeenCalled()
    expect(running.status().state).toBe('downloading')
    release()
    await running.finished
    expect(run).toHaveBeenCalledOnce()
    expect(released).toHaveBeenCalledWith('runner-7', 'x@1.0.0')
  })

  it('cancels at the deadline and reads the cancellation through the outcome', async () => {
    let finish!: (value: unknown) => void
    const cancel = vi.fn(async () => { finish({ application: 'cancelled' }); return { status: 'cancelled' } })
    const running = startManagerOperation({
      profile: 'runner-8', requestId: 'r8', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 30,
      run: () => new Promise(resolve => { finish = resolve }),
      cancel,
      outcome: raw => (raw as { application?: string }).application === 'cancelled' ? { state: 'failed', detail: 'timed out' } : done,
    })
    expect(await running.finished).toMatchObject({ state: 'failed', detail: 'timed out' })
    expect(cancel).toHaveBeenCalledWith('r8')
  })

  it('keeps waiting when the cancellation comes too late, and settles once', async () => {
    let finish!: (value: unknown) => void
    const outcome = vi.fn((): ManagerOutcome => done)
    const running = startManagerOperation({
      profile: 'runner-9', requestId: 'r9', mechanism: 'install x', logs: new ManagerLogs(), timeoutMs: 30,
      run: () => new Promise(resolve => { finish = resolve }),
      cancel: async () => ({ status: 'too-late' }),
      outcome,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(isTerminalInstallState(running.status().state)).toBe(false)
    finish({ application: 'applied' })
    expect((await running.finished).state).toBe('done')
    expect(outcome).toHaveBeenCalledOnce()
  })

  it('turns a done install into a failure when the post-install check objects', async () => {
    const running = startManagerOperation({
      profile: 'runner-10', requestId: 'r10', mechanism: 'install x', logs: new ManagerLogs(),
      run: async () => ({}), outcome: () => done,
      alsoConfirm: () => 'x declares the loader entry id "dup", which y already declares.',
    })
    const status = await running.finished
    expect(status.state).toBe('failed')
    expect(status.activation).toBeUndefined()
    expect(status.detail).toContain('"dup"')
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/manager-runner.test.ts`
Expected: FAIL, the module does not exist.

- [ ] **Step 3: Write the runner**

```ts
// src/host/manager-runner.ts
/**
 * One package operation through dsh's `pluginManager` service, tracked as the
 * same `RunningInstall` the CLI executor produces: design
 * 2026-09-26-plugin-manager-delegation, section 6. It runs in the same
 * per-profile queue as CLI commands, so the two paths are never concurrent in
 * one profile.
 */
import {
  createBoundedLog, inProfileQueue, INSTALL_TIMEOUT_MS, lineSink, requestDownloadPhase,
  type InstallStatus, type RunningInstall,
} from './executor.ts'
import { readChange, type ManagerOutcome } from './plugin-manager.ts'
import type { Prefetcher } from './prefetch.ts'
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'

/** The first line of every record this runner writes. The shop's log panel
 * shows it and the 0.1.7 e2e asserts it, so a silent fall back to the CLI
 * fails a case instead of passing it. */
export const MECHANISM_PREFIX = "via dsh's plugin manager:"

/** Routes the service's `plugin-manager/install-log` chunks to the record
 * whose request id they carry. A chunk for any other id is dropped. */
export class ManagerLogs {
  private readonly sinks = new Map<string, (text: string) => void>()

  open(requestId: string, sink: (text: string) => void): () => void {
    this.sinks.set(requestId, sink)
    return () => { this.sinks.delete(requestId) }
  }

  chunk(requestId: unknown, text: unknown): void {
    if (typeof requestId !== 'string' || typeof text !== 'string') return
    this.sinks.get(requestId)?.(text)
  }
}

export interface ManagerOperationOptions {
  profile: string
  /** The record's id, handed to the service as its request id. */
  requestId: string
  /** What the mechanism line says after the prefix, e.g. `install dsh-a@1.0.0`. */
  mechanism: string
  logs: ManagerLogs
  run: (requestId: string) => Promise<unknown>
  cancel?: (requestId: string) => Promise<unknown>
  outcome: (raw: unknown) => ManagerOutcome
  alsoConfirm?: () => string | null
  /** The download phase, as on the CLI path: `spec` is what it warms. */
  prefetcher?: Prefetcher
  spec?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export function startManagerOperation(options: ManagerOperationOptions): RunningInstall {
  const { profile, requestId, mechanism, logs, run, cancel, outcome, alsoConfirm, prefetcher, spec, env } = options
  const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
  const log = createBoundedLog()
  let state: InstallState = 'running'
  let settled: ManagerOutcome | null = null
  let streamed = false

  const status = (): InstallStatus => ({
    state,
    log: log.lines(),
    ...(settled?.state === 'done' && settled.activation !== undefined ? { activation: settled.activation } : {}),
    ...(settled?.state === 'done' && settled.restartReason !== undefined ? { restartReason: settled.restartReason } : {}),
    ...(settled?.detail !== undefined ? { detail: settled.detail } : {}),
  })
  // Terminal, not "not running": a line from the download phase belongs in
  // the log, and only a settled record refuses more.
  const append = (line: string): void => {
    if (isTerminalInstallState(state)) return
    log.push(line)
  }
  append(`${MECHANISM_PREFIX} ${mechanism}`)
  // The assembler the CLI capture uses: a line split across chunks reads as
  // one, and CRLF ends a line.
  const lines = lineSink(append)
  const close = logs.open(requestId, text => {
    streamed = true
    lines.write(Buffer.from(text, 'utf8'))
  })

  const queued = inProfileQueue(profile, async (): Promise<InstallStatus> => {
    state = 'running'
    let deadline: ReturnType<typeof setTimeout> | undefined
    if (cancel !== undefined) {
      deadline = setTimeout(() => {
        cancel(requestId).catch(() => {
          // A failed cancellation leaves the call running; its answer still
          // settles the record below, and nothing else waits on this promise.
        })
      }, timeoutMs)
    }
    let raw: unknown
    try {
      raw = await run(requestId)
    } catch (error) {
      lines.flush()
      settled = { state: 'failed', detail: `dsh-plugin-shop: dsh's plugin manager failed: ${messageOf(error)}` }
      state = 'failed'
      return status()
    } finally {
      clearTimeout(deadline)
    }
    lines.flush()
    if (!streamed) {
      for (const line of readChange(raw).output.split(/\r?\n/)) if (line !== '') append(line)
    }
    let result: ManagerOutcome
    try {
      result = outcome(raw)
      if (result.state === 'done' && alsoConfirm !== undefined) {
        const objection = alsoConfirm()
        if (objection !== null) result = { state: 'failed', detail: objection }
      }
    } catch (error) {
      // The shop's own reading of the answer threw (a post-install check that
      // cannot read the package, say). The record must still settle: a record
      // left running holds the profile's queue and the client's poll forever.
      result = { state: 'failed', detail: `dsh-plugin-shop: the shop could not check what dsh installed: ${messageOf(error)}` }
    }
    settled = result
    state = result.state
    return status()
  })

  // Only an operation with something ahead of it has anything to overlap
  // with, as on the CLI path (see `profileDepth` in executor.ts).
  const prefetch = queued.ahead > 0 && prefetcher !== undefined && spec !== undefined
    ? requestDownloadPhase({ prefetcher, profile, spec, env, log: append })
    : null
  if (prefetch?.started === true && !isTerminalInstallState(state)) state = 'downloading'

  const finished = queued.finished.finally(() => {
    close()
    if (prefetcher !== undefined && spec !== undefined) prefetcher.release(profile, spec)
  })
  void finished.catch(() => {
    // The task catches its own failures, so this never rejects today; the
    // handler keeps a future throw from becoming an unhandled rejection that
    // would take the host down (the same guard as spawnPluginCli's).
  })
  return { installId: requestId, status, finished }
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `node node_modules/vitest/vitest.mjs run tests/host/manager-runner.test.ts`
Expected: PASS, every case.

- [ ] **Step 5: Revert each guard once**

Drop the terminal check in `append`; drop `lines.flush()`; ignore `streamed`; remove the `catch` around `outcome` and `alsoConfirm`. Each must fail a case. Restore.

- [ ] **Step 6: Commit**

```bash
git add src/host/manager-runner.ts tests/host/manager-runner.test.ts
git commit -m "feat(shop): run one plugin manager operation as an install record, in the profile's queue"
```

---

### Task 5: Install and update through the service

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (the constructor, `install`, `updateStart`)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `startManagerOperation`, `ManagerLogs` (Task 4); `managerOutcome` (Task 2); `pluginManager()` (Task 1); `INSTALL_TIMEOUT_MS`, `RunningInstall` (Task 3).
- Produces: `private readonly managerLogs: ManagerLogs`; `private postInstallHazard(name: string, harness: RunningHarness, undo: string): string | null` (the body of `install`'s `alsoConfirm`, moved); `private track(running: RunningInstall): void` (the `installs.set` / `installOrder.push` / `evictFinishedInstalls()` tail every start shares).

- [ ] **Step 1: Measure open item O1 before writing the imported rule into the gateway**

Boot 0.1.7-rc.2 on a temporary `DSH_HOME` with a throwaway probe plugin, as the spec's section 2 probe did. From the probe: `installBundle` a local bundle at v1, `removeBundle` it, `installBundle` v2 of the same name, and read which version's `apply` ran after the second install (each version appends its own `name@version` to a file under `DSH_HOME`). If v2 ran, the service loads a fresh module: remove the `alreadyImported` condition from `managerOutcome`'s `applied` branch and its test row. If v1 ran, keep both. Record the result for Task 11.

- [ ] **Step 2: Write the failing gateway tests**

```ts
// tests/host/index.test.ts, appended at the end of the file
describe("installs and updates through dsh's pluginManager", () => {
  const managed: CatalogEntry = { name: 'dsh-managed', version: '1.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived', source: 'npm', added: '2026-09-27' }
  const applied = { changed: true, application: 'applied', stage: 'enable', target: 'dsh-managed', enabled: true, bundle: 'dsh-managed', registries: [null], warnings: [] }
  const managedPatch = "- insert:\n    - id: managed-row\n      name: 'dsh-managed'\n"

  /** A gateway whose pluginManager records its calls, streams one chunk per
   * install through `plugin-manager/install-log`, and, when `lands`, puts
   * the package on disk as a real install does before it answers. */
  function managedGateway(result: object, options: { dependencies?: Record<string, string>; profile?: string; lands?: boolean } = {}): { gateway: ShopGateway; calls: unknown[][] } {
    const { dependencies = {}, profile = 'web', lands = true } = options
    const profileDir = toggleProfile()
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: Object.keys(dependencies) } }, dependencies }))
    const calls: unknown[][] = []
    const listeners = new Map<string, (payload: unknown) => void>()
    const service = {
      installBundle: async (spec: string, request: { requestId: string }) => {
        calls.push(['installBundle', spec, request.requestId])
        listeners.get('plugin-manager/install-log')?.({ requestId: request.requestId, jobId: 'j', argv: ['pnpm', 'add', spec], cwd: profileDir, stream: 'stdout', text: `+ ${spec}\n` })
        if (lands && spec.startsWith('dsh-managed@')) fixturePackage(profileDir, 'dsh-managed', managedPatch)
        return result
      },
      removeBundle: async () => { throw new Error('this case must not call removeBundle') },
      setPluginEnabled: async () => { throw new Error('this case must not call setPluginEnabled') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
      cancelInstall: async () => ({ status: 'not-running' }),
    }
    const ctx = {
      get: (name: string) => name === 'pluginManager' ? service : undefined,
      on: (event: string, listener: (payload: unknown) => void) => { listeners.set(event, listener) },
      reflect: { provide: () => {} },
    } as never
    const gateway = new ShopGateway(ctx, {
      catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile, profileDir,
      loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed], denied: [], stars: {} }, stale: false }) as CatalogResult,
    })
    return { gateway, calls }
  }

  const finish = async (gateway: ShopGateway, installId: string): Promise<ShopInstallStatusResult> => {
    await vi.waitFor(() => expect(isTerminalInstallState(gateway.installStatus({ installId }).state)).toBe(true), { timeout: 5000 })
    return gateway.installStatus({ installId })
  }

  it('installs through installBundle, with the catalog spec and the record id as request id', async () => {
    const { gateway, calls } = managedGateway(applied)
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(calls).toEqual([['installBundle', 'dsh-managed@1.0.0', started.installId]])
    expect(status).toMatchObject({ state: 'done', activation: 'live' })
    expect(status.log).toEqual(["via dsh's plugin manager: install dsh-managed@1.0.0", '+ dsh-managed@1.0.0'])
  })

  it('reads an update as a restart the package already loaded', async () => {
    const { gateway } = managedGateway({ ...applied, application: 'restart-required' }, { dependencies: { 'dsh-managed': '0.9.0' } })
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    expect(await finish(gateway, started.installId)).toMatchObject({ state: 'done', activation: 'restart', restartReason: 'already-loaded' })
  })

  it('updates the shop itself through installBundle', async () => {
    const { gateway, calls } = managedGateway({ ...applied, application: 'restart-required', target: 'dsh-plugin-shop' })
    const started = await gateway.updateStart({ version: '9.9.9' })
    if (!started.ok) throw new Error(started.detail)
    await finish(gateway, started.installId)
    expect(calls[0]?.slice(0, 2)).toEqual(['installBundle', 'dsh-plugin-shop@9.9.9'])
  })
})
```

`vi`, `isTerminalInstallState`, `CatalogEntry`, `CatalogResult` and `ShopInstallStatusResult` are already imported by this file. The existing suite is the no-service case: it builds every gateway with `stubCtx()` and keeps spawning the fake CLI.

- [ ] **Step 3: Run them and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts -t "through dsh's pluginManager"`
Expected: FAIL, the gateway spawns the CLI and never calls `installBundle`.

- [ ] **Step 4: Wire the gateway**

Imports:

```ts
import { createHash, randomUUID } from 'node:crypto'
import { INSTALL_TIMEOUT_MS, startInstall, startUninstall, type InstallStatus, type RunningInstall } from './executor.ts'
import { ManagerLogs, startManagerOperation } from './manager-runner.ts'
import { managerOutcome } from './plugin-manager.ts'
```

In the constructor, after the existing service reads:

```ts
    this.managerLogs = new ManagerLogs()
    // The service streams each pnpm run as it happens. A context without `on`
    // (a unit test's stub) streams nothing, and a record then takes the
    // service's final output instead.
    const on = (this.ctx as { on?: (event: string, listener: (payload: unknown) => void) => unknown }).on
    on?.call(this.ctx, 'plugin-manager/install-log', payload => {
      const chunk = payload as { requestId?: unknown; text?: unknown }
      this.managerLogs.chunk(chunk.requestId, chunk.text)
    })
```

Move the body of `install`'s `alsoConfirm` into `postInstallHazard(name, harness, undo)`, with `undo` in place of the literal `` It is on disk: run `dsh plugin --profile ${this.profile} remove ${args.name}` to undo this install. ``; the CLI path passes that same sentence, so its output does not change. Move the `installs.set` / `installOrder.push` / `evictFinishedInstalls()` tail into `track(running)` and call it from `install`, `uninstall` and `updateStart`.

In `install`, after `const harness = await this.runningHarness()` and before `startInstall`:

```ts
    const manager = this.pluginManager()
    if (manager !== null) {
      const running = startManagerOperation({
        profile: this.profile,
        requestId: randomUUID(),
        mechanism: `install ${spec}`,
        logs: this.managerLogs,
        run: requestId => manager.installBundle(spec, { requestId }),
        ...(manager.cancelInstall !== undefined ? { cancel: (requestId: string) => manager.cancelInstall!(requestId) } : {}),
        outcome: raw => {
          // The service imported the package by the time it answers, as a
          // hot mount has (see the CLI path's afterDone).
          if (!isUpdate) this.imported.add(args.name)
          return managerOutcome(raw, {
            profile: this.profile, name: args.name, operation: isUpdate ? 'update' : 'install',
            alreadyImported, hasClientHalf: this.packageHasClientHalf(args.name),
            desktop: isDesktopProfile(this.profile), timeoutMs: INSTALL_TIMEOUT_MS,
          })
        },
        alsoConfirm: () => this.postInstallHazard(args.name, harness, ' It is on disk: uninstall it from the shop to undo this install.'),
        prefetcher: this.prefetcher,
        spec,
      })
      if (entry.source === 'github') {
        const pins = readRepoPins(this.pinFs, this.pinsPath())
        writeRepoPins(this.pinFs, this.pinsPath(), { ...pins, [identityKey(entry)]: entry.version })
      }
      this.track(running)
      return { ok: true, installId: running.installId, state: running.status().state }
    }
```

In `updateStart`, before the CLI spawn:

```ts
    const manager = this.pluginManager()
    if (manager !== null) {
      const spec = `dsh-plugin-shop@${args.version}`
      const running = startManagerOperation({
        profile: this.profile, requestId: randomUUID(), mechanism: `update ${spec}`, logs: this.managerLogs,
        run: requestId => manager.installBundle(spec, { requestId }),
        ...(manager.cancelInstall !== undefined ? { cancel: (requestId: string) => manager.cancelInstall!(requestId) } : {}),
        // The shop's own host half is running, so its update never goes live.
        outcome: raw => managerOutcome(raw, {
          profile: this.profile, name: 'dsh-plugin-shop', operation: 'update', alreadyImported: true,
          hasClientHalf: true, desktop: isDesktopProfile(this.profile), timeoutMs: INSTALL_TIMEOUT_MS,
        }),
        prefetcher: this.prefetcher, spec,
      })
      this.track(running)
      return { ok: true, installId: running.installId, state: running.status().state }
    }
```

- [ ] **Step 5: Run the gateway file**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts`
Expected: PASS, the new cases and every existing one.

- [ ] **Step 6: Measure open item O4**

Pack the build (`rm -rf lib && pnpm build && pnpm pack`), install it into a 0.1.7-rc.2 profile, and from the shop's UI update the shop to a local tarball of a higher version. Expected: the record reaches `done` with `restart` before anything restarts. Record the result for Task 11.

- [ ] **Step 7: Commit**

```bash
git add src/host/index.ts tests/host/index.test.ts
git commit -m "feat(shop): install and update through dsh's pluginManager where the harness offers it"
```

---

### Task 6: Uninstall through the service

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (`uninstall`)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4 and 5.
- Produces: `private forgetPins(name: string, installedEntry: CatalogEntry | undefined): void` (the pin-deleting block `uninstall` already has, moved).

- [ ] **Step 1: Write the failing test**

Append inside the describe block of Task 5:

```ts
  it('uninstalls through removeBundle, with the mechanism line and the final output', async () => {
    const calls: unknown[][] = []
    const service = {
      installBundle: async () => { throw new Error('this case must not call installBundle') },
      removeBundle: async (name: string) => {
        calls.push(['removeBundle', name])
        return { changed: true, application: 'applied', stage: 'remove', target: name, warnings: [], packageResult: { exitCode: 0, output: 'Packages: -1', truncated: false, logPath: '/l' } }
      },
      setPluginEnabled: async () => { throw new Error('this case must not call setPluginEnabled') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
    }
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-managed', managedPatch)
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      {
        catalogUrl: 'https://shop.test/v1/', cacheDir: '/cache', profile: 'web', profileDir,
        loadCatalog: async () => ({ snapshot: { schemaVersion: 2, builtAt: '', entries: [managed], denied: [], stars: {} }, stale: false }) as CatalogResult,
      },
    )
    const started = await gateway.uninstall({ name: 'dsh-managed' })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(calls).toEqual([['removeBundle', 'dsh-managed']])
    expect(status).toMatchObject({ state: 'done', activation: 'live' })
    expect(status.log).toEqual(["via dsh's plugin manager: remove dsh-managed", 'Packages: -1'])
  })
```

`fixturePackage` records the dependency as `1.0.0`, which `installedSpecMatches` accepts against the catalog's `1.0.0`.

- [ ] **Step 2: Run it and watch it fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts -t "uninstalls through removeBundle"`
Expected: FAIL, the CLI is spawned.

- [ ] **Step 3: Wire `uninstall`**

Move the pin block into `forgetPins(args.name, installedEntry)`. Then, after `hadClientHalf` is read and before `startUninstall`:

```ts
    const manager = this.pluginManager()
    if (manager !== null) {
      // removeBundle carries no request id, so the record takes the service's
      // final output rather than a stream.
      const running = startManagerOperation({
        profile: this.profile, requestId: randomUUID(), mechanism: `remove ${args.name}`, logs: this.managerLogs,
        run: () => manager.removeBundle(args.name),
        outcome: raw => managerOutcome(raw, {
          profile: this.profile, name: args.name, operation: 'uninstall', alreadyImported: false,
          hasClientHalf: hadClientHalf, desktop: isDesktopProfile(this.profile), timeoutMs: INSTALL_TIMEOUT_MS,
        }),
      })
      this.forgetPins(args.name, installedEntry)
      this.track(running)
      return { ok: true, installId: running.installId }
    }
```

- [ ] **Step 4: Run the gateway file**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/host/index.ts tests/host/index.test.ts
git commit -m "feat(shop): uninstall through dsh's pluginManager where the harness offers it"
```

---

### Task 7: Switching through the service

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (`setEnabled`, the selected path only)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `readChange`, `codeSentence` (Task 2); `pluginManager()` (Task 1).

`setPluginEnabled` takes the live entry id `listPlugins` reports, the inventory's `include:...` id, and writes the patch row it maps to (dsh 0.1.7-rc.2 source). Both it and the shop read the same host inventory service, so the ids the shop holds are the ids it takes. An entry not under the root `include`, such as a tree the CLI path hot-mounted under the shop, answers `unaddressable`. On 0.1.7 every install goes through the service after Task 5, so no such tree exists there.

- [ ] **Step 1: Measure open item O3**

In a 0.1.7-rc.2 profile, write a user-layer row the way the 0.1.5 shop does (block style, with the module name: `- id: hello-row`, `  name: dsh-hello-fixture`, `  disabled: true`), then call `setPluginEnabled('include:hello-row', true)` from a probe plugin and read the file. Expected: that same row now reads `disabled: false`, and no second row was appended. If dsh appends a row instead, skip Steps 2 to 5, keep the shop's own writer for switching, and record why for Task 11.

- [ ] **Step 2: Write the failing tests**

```ts
describe("switches through dsh's pluginManager", () => {
  const applied = { changed: true, application: 'applied', stage: 'enable', target: 'x', enabled: false, warnings: [] }

  function switchingGateway(answers: object[]): { gateway: ShopGateway; calls: unknown[][]; profileDir: string } {
    const calls: unknown[][] = []
    const service = {
      installBundle: async () => { throw new Error('this case must not call installBundle') },
      removeBundle: async () => { throw new Error('this case must not call removeBundle') },
      setBundleEnabled: async () => { throw new Error('this case must not call setBundleEnabled') },
      setPluginEnabled: async (id: string, enabled: boolean) => {
        calls.push([id, enabled])
        return answers[calls.length - 1] ?? answers[answers.length - 1]
      },
    }
    const profileDir = toggleProfile()
    fixturePackage(profileDir, 'dsh-two-rows', "- insert:\n    - id: host-row\n      name: 'dsh-two-rows/host'\n    - id: client-row\n      name: 'dsh-two-rows/client'\n")
    const gateway = new ShopGateway(
      { get: (name: string) => name === 'pluginManager' ? service : undefined, reflect: { provide: () => {} } } as never,
      {
        profile: 'web', profileDir,
        inventory: { list: async () => ({ entries: [
          { entryId: 'include:host-row', moduleName: 'dsh-two-rows/host', enabled: true },
          { entryId: 'include:client-row', moduleName: 'dsh-two-rows/client', enabled: true },
        ] }) },
      },
    )
    return { gateway, calls, profileDir }
  }

  it('switches every live entry the package owns through setPluginEnabled, by live id, and writes no row itself', async () => {
    const { gateway, calls, profileDir } = switchingGateway([applied])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toMatchObject({ ok: true })
    expect(calls).toEqual([['include:host-row', false], ['include:client-row', false]])
    expect(existsSync(join(profileDir, 'cordis.patch.yml'))).toBe(false)
  })

  it('reports the first entry dsh refused, with the sentence for its code, and stops there', async () => {
    const { gateway, calls } = switchingGateway([{ ...applied, application: 'failed', error: { code: 'management-required' } }])
    const result = await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })
    expect(result).toEqual({ ok: false, detail: 'dsh-plugin-shop: dsh refused to switch dsh-two-rows (management-required): the plugin belongs to dsh itself.' })
    expect(calls).toHaveLength(1)
  })

  it('asks for a restart when any entry needs one', async () => {
    const { gateway } = switchingGateway([applied, { ...applied, application: 'restart-required' }])
    expect(await gateway.setEnabled({ name: 'dsh-two-rows', enabled: false })).toEqual({ ok: true, activation: 'restart' })
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts -t "switches through dsh's pluginManager"`
Expected: FAIL, the shop writes its own rows.

- [ ] **Step 4: Wire the selected path**

In `setEnabled`, after the `live.length === 0` check and before `setUserLayerRows`:

```ts
    const manager = this.pluginManager()
    if (manager !== null) {
      let restart = false
      for (const entry of live) {
        let change
        try {
          change = readChange(await manager.setPluginEnabled(entry.entryId, args.enabled))
        } catch (error) {
          // The service threw rather than answering: nothing says the entry
          // switched, and the reason travels as a detail, not as a transport
          // failure the client can only call "retry".
          return { ok: false, detail: `dsh-plugin-shop: dsh could not switch ${args.name}: ${String(error)}` }
        }
        if (change.application === 'failed' || change.application === 'cancelled' || change.errorCode !== null) {
          const code = change.errorCode ?? change.application ?? 'failed'
          const sentence = codeSentence(code)
          const said = change.diagnostic !== null ? ` dsh reported: ${change.diagnostic}` : ''
          return { ok: false, detail: `dsh-plugin-shop: dsh refused to switch ${args.name} (${code})${sentence !== undefined ? `: ${sentence}` : ''}.${said}` }
        }
        if (change.application === 'restart-required') restart = true
      }
      if (restart) return { ok: true, activation: 'restart' }
      return { ok: true, activation: activationOf({ hostLive: true, clientLive: true, hasClientHalf: this.packageHasClientHalf(args.name) }) }
    }
```

`overridden` falls through to success (see "Where this plan departs from the spec"). The deselected branch from #67 is untouched.

- [ ] **Step 5: Run the gateway file**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts`
Expected: PASS. The existing `setEnabled` cases use `stubCtx()` and stay on the writer path.

- [ ] **Step 6: Commit**

```bash
git add src/host/index.ts tests/host/index.test.ts
git commit -m "feat(shop): switch plugins through dsh's pluginManager where the harness offers it"
```

---

### Task 8: The desktop profile

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (the three early desktop returns)
- Test: `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: Tasks 5 and 6. `isDesktopProfile` matches `desktop` in any letter case.

- [ ] **Step 1: Write the failing tests**

Append inside the describe block of Task 5, which holds `managedGateway`, `managed`, `applied` and `finish`:

```ts
  it('routes a desktop install to the service when the harness offers one', async () => {
    const { gateway, calls } = managedGateway(applied, { profile: 'Desktop' })
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    await finish(gateway, started.installId)
    expect(calls).toHaveLength(1)
  })

  it('hands a desktop reader no dsh plugin command when the service refuses', async () => {
    // Review Focus 5: every detail a desktop reader reaches comes through
    // managerOutcome with `desktop: true`.
    const refusal = {
      changed: false, application: 'failed', stage: 'install', target: 'dsh-managed@1.0.0', registries: [null],
      error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-managed', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }] },
    }
    const { gateway } = managedGateway(refusal, { profile: 'desktop', lands: false })
    const started = await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })
    if (!started.ok) throw new Error(started.detail)
    const status = await finish(gateway, started.installId)
    expect(status.state).toBe('failed')
    expect(status.detail).not.toContain('dsh plugin')
  })

  it('still refuses every desktop mutation without the service', async () => {
    const gateway = new ShopGateway(stubCtx(), { profile: 'desktop', profileDir: toggleProfile() })
    expect(await gateway.install({ name: 'dsh-managed', version: '1.0.0', acknowledged: true })).toMatchObject({ ok: false, code: 'desktop-profile' })
    expect((await gateway.uninstall({ name: 'dsh-managed' })).ok).toBe(false)
    expect((await gateway.updateStart({ version: '9.9.9' })).ok).toBe(false)
  })
```

- [ ] **Step 2: Run them and watch the first two fail**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts -t "desktop"`
Expected: the first two FAIL, refused before the service is asked; the third passes.

- [ ] **Step 3: Make the three refusals conditional**

In `install`, `uninstall` and `updateStart`, change `if (isDesktopProfile(this.profile)) return ...` to `if (isDesktopProfile(this.profile) && this.pluginManager() === null) return ...`. `setEnabled` has no desktop return and gets none. The restart gate's `desktop` reason is untouched.

- [ ] **Step 4: Run the gateway file**

Run: `node node_modules/vitest/vitest.mjs run tests/host/index.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/host/index.ts tests/host/index.test.ts
git commit -m "feat(shop): open the desktop profile through dsh's pluginManager when the harness offers it"
```

---

### Task 9: The client: the done note and a marked log line

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts` (`InstallView`, `reduceInstall`)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx` (the install panel's done view; the seven `css.logLine` renders)
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`, `packages/dsh-plugin-shop/tests/client/ShopTab.client.spec.tsx`

The wire already carries `detail` on any record (`installStatus` spreads `running.status()`); `reduceInstall` drops it on `done`. Carrying it is a client change only.

- [ ] **Step 1: Write the failing tests**

In `tests/client/present.test.ts`, inside `describe('reduceInstall on a done status', ...)`:

```ts
  it('carries the host note on a done status, and adds no key without one', () => {
    const before: InstallView = { kind: 'running', installId: 'i1', log: [], phase: 'installing' }
    const noted = reduceInstall(before, {
      type: 'status',
      status: { found: true, state: 'done', log: [], activation: 'live', detail: 'Saved, but a higher-priority layer decides whether it runs.' },
    })
    expect(noted).toEqual({ kind: 'done', activation: 'live', log: [], detail: 'Saved, but a higher-priority layer decides whether it runs.' })
    const plain = reduceInstall(before, { type: 'status', status: { found: true, state: 'done', log: [], activation: 'live' } })
    expect('detail' in plain).toBe(false)
  })
```

In `tests/client/ShopTab.client.spec.tsx`, beside `offers the restart button after a successful install, gated by the cost notice`:

```ts
  it('shows the host note on a done install, and marks every log line', async () => {
    const { injected, installStatus } = bench(snapshot({ tier: 'verified' }))
    installStatus.mockResolvedValue({ found: true, state: 'done', log: ["via dsh's plugin manager: install dsh-hello-plugin@1.0.0", '+ dsh-hello-plugin 1.0.0'], activation: 'live', detail: 'Saved, but a higher-priority layer decides whether it runs.' })
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(container.querySelector('[data-shop-done-note]')).toBeTruthy(), { timeout: 3000 })
    expect(container.querySelector('[data-shop-done-note]')?.textContent).toBe('Saved, but a higher-priority layer decides whether it runs.')
    const lines = [...container.querySelectorAll('[data-shop-log-line]')].map(line => line.textContent)
    expect(lines).toEqual(["via dsh's plugin manager: install dsh-hello-plugin@1.0.0", '+ dsh-hello-plugin 1.0.0'])
  })
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node node_modules/vitest/vitest.mjs run tests/client/present.test.ts tests/client/ShopTab.client.spec.tsx -t "host note"`
Expected: FAIL, the note is dropped and the lines carry no attribute.

- [ ] **Step 3: Carry and render the note, and mark the lines**

In `present.ts`, the `done` member of `InstallView` becomes `{ kind: 'done'; activation: Activation; log: string[]; restartReason?: HotRestartReason; detail?: string }`, and the done branch of `reduceInstall` adds, after the `restartReason` spread:

```ts
          // A note the host attached to a success (the plugin manager's
          // `overridden`). Host copy, rendered as it came, like a failure's.
          ...(status.detail !== undefined ? { detail: status.detail } : {}),
```

In `ShopTab.tsx`, in the install panel's `view.kind === 'done'` branch, directly after the `data-shop-restart-notice` paragraph:

```tsx
        {view.detail !== undefined && <p className={css.notice} data-shop-done-note>{view.detail}</p>}
```

and on each of the seven `<div key={index} className={css.logLine}>{line}</div>` renders, add `data-shop-log-line`.

- [ ] **Step 4: Run the two client files**

Run: `node node_modules/vitest/vitest.mjs run tests/client/present.test.ts tests/client/ShopTab.client.spec.tsx`
Expected: PASS. If `ShopTab incremental ... expected 48 to be 96` fails, rerun: it is a known observer race in that test, on `main` too.

- [ ] **Step 5: Commit**

```bash
git add src/client/present.ts src/client/ShopTab.tsx tests/client/present.test.ts tests/client/ShopTab.client.spec.tsx
git commit -m "feat(shop): show a note the host attaches to a done install, and mark log lines for the e2e"
```

---

### Task 10: The e2e on 0.1.7, through the service

**Files:**
- Modify: `packages/dsh-plugin-shop/tests/client/web-full-flow.e2e.ts`

After Tasks 5 to 8, every mutation on the 0.1.7 leg runs through the service, so three cases change what they may assert there, and the spec's section 9 asks for a switch case the file does not have. The 0.1.5 leg keeps asserting the CLI path, unchanged. Branch on one flag, set in `beforeAll` after `launchedDshVersion` is read:

```ts
  /** Whether this harness offers dsh's pluginManager, so the shop's
   * mutations go through it (design 2026-09-26-plugin-manager-delegation). */
  let managerPath = false
  // in beforeAll, after launchedDshVersion is read:
  managerPath = gte(launchedDshVersion, '0.1.7-rc.1')
```

- [ ] **Step 1: Run the e2e on 0.1.7 and read what fails**

```bash
PATH=<0.1.7-rc.2 prefix>/bin:$PATH DSH_SHOP_REQUIRE_E2E=1 DSH_SHOP_EXPECT_DSH=0.1.7-rc.2 node node_modules/vitest/vitest.mjs run tests/client/web-full-flow.e2e.ts
```

Expected failures, each fixed in the step named. Anything else failing is a defect in Tasks 1 to 9: fix the code, not the case. A failed case leaves its evidence in `test-results/e2e/`.

- [ ] **Step 2: The failed install's detail (first case)**

The first case installs a name the local registry 404s. On the CLI path the failed view shows `installFailureDetail`'s hint; through the service, dsh classifies the 404 as `not-found` and the detail is section 5 rule 3's sentence. Where the case matches `/pnpm failed in the profile\. Run: dsh plugin --profile web install/`, branch:

```ts
      if (managerPath) {
        await card.getByText(/^dsh-plugin-shop: the install failed( at the registry)?: no such package was found\.$/)
          .waitFor({ state: 'visible', timeout: 60_000 })
        expect(await card.locator('[data-shop-log-line]').first().textContent())
          .toBe("via dsh's plugin manager: install dsh-e2e-fixture-plugin@1.0.0")
      } else {
        // the existing assertion, unchanged
      }
```

The optional `at the registry` admits both `failedAt` answers dsh may give for a registry spec. The service never falls from a private registry to a public one (spec section 8), so the local registry's 404 is the only answer and the leg makes no internet request.

- [ ] **Step 3: The hot-mount case's live id and mechanism lines**

Through the service the bundle is composed at the root, so the live id is the fixture's own row, not one under the shop. Where the case reads `include:shop:mkt-e2e-live`:

```ts
      const liveId = managerPath ? 'include:e2e-live' : 'include:shop:mkt-e2e-live'
```

and, once the install reaches done, on `managerPath`:

```ts
        expect(await card.locator('[data-shop-log-line]').first().textContent())
          .toBe("via dsh's plugin manager: install dsh-shop-e2e-live@1.0.0")
```

Assert the uninstall's first log line the same way, as `via dsh's plugin manager: remove dsh-shop-e2e-live`, and the update case's as `via dsh's plugin manager: install dsh-shop-e2e-update@2.0.0`. The browser-half case passing on this leg is open item O2's measurement. If it fails there, `applied` does not put a browser half one reload away: change `managerOutcome`'s `applied` branch to `clientLive: false` for an install, which yields `restart` for a package with a browser half, add that row to Task 2's table, and record it for Task 11.

- [ ] **Step 4: The config-row case, measured**

`dsh-shop-e2e-config`'s patch is one bare row, `- id: e2e-config` with a `config:` block. On the CLI path the shop's hot mount refuses a patch carrying a config row and asks for a restart with that reason. Through the service, dsh composes the bundle itself, and its answer decides: read it from Step 1's run (the record's notice and the evidence). Then branch the case on `managerPath`:

- If dsh answered `applied`: assert the done notice contains `已安装并热挂载` (the live notice, as the hot-mount case asserts it), that `[data-shop-restart]` is absent, and that `include:e2e-config` is live in the inventory, read on a fresh page the way the hot-mount case's probe reads it.
- If dsh answered `restart-required`: assert the notice text is `zh.installedRestartNotice` and that the restart offer is present (`expectRestartOffer`), without the config-row reason.

Rename the case so its title is true on both legs: `'a fixture whose patch carries a config row: the restart offer on the CLI path, and what dsh answers through its plugin manager'`.

- [ ] **Step 5: A switch case, on the boot-composed update fixture**

Add a case directly before the update case. It uses `dsh-shop-e2e-update`, which the boot composed and which has no browser half: on 0.1.5 the user layer reaches only boot-composed entries, and on 0.1.7 the service answers `unaddressable` for a tree the shop mounted itself. The update case reads its baseline activations at its own start, so the activations this case adds do not reach its assertions.

```ts
  it(
    'switches a boot-composed plugin off and on, and it runs again',
    async () => {
      expect(page).toBeDefined()
      const app = page!

      // The previous case ended on a page reload and waited out its first
      // run (waitForFirstRun), so Settings opens from scratch here.
      await app.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await app.getByRole('button', { name: '设置', exact: true }).click({ timeout: 15_000 })
      const dialog = app.getByRole('dialog', { name: '设置' })
      await dialog.waitFor({ state: 'visible', timeout: 10_000 })
      await dialog.getByRole('button', { name: PLUGINS_SECTION }).click()
      await dialog.getByRole('tab', { name: '插件商店' }).click()
      await dialog.locator('[data-shop-tab]').waitFor({ state: 'visible', timeout: 15_000 })
      await dialog.locator('[data-shop-category-installed]').click()

      const row = dialog.locator('[data-shop-enabled-switch="dsh-shop-e2e-update"]')
      const toggle = row.locator('[data-shop-toggle]')
      await toggle.waitFor({ state: 'visible', timeout: 15_000 })
      expect(await toggle.getAttribute('aria-checked')).toBe('true')
      const before = updateActivations().length

      await toggle.click()
      await row.locator('[data-shop-hot-apply]').waitFor({ state: 'visible', timeout: 15_000 })
      expect(await toggle.getAttribute('aria-checked')).toBe('false')
      if (managerPath) {
        // Open item O3: dsh wrote the row itself, in place, not beside it.
        const layer = readFileSync(join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
        expect(layer.match(/id: e2e-update\b/g)?.length, layer).toBe(1)
      }

      // The fixture appends its module-scope version each time it activates,
      // so a new line proves the entry went down and came back, on both legs.
      await toggle.click()
      await expect.poll(() => updateActivations().length, { timeout: 15_000 }).toBeGreaterThan(before)
      expect(await toggle.getAttribute('aria-checked')).toBe('true')
      expect(await row.locator('[data-shop-toggle-error]').count()).toBe(0)

      // The update case opens Settings from a closed dialog.
      await app.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    },
    120_000,
  )
```

- [ ] **Step 6: Run the e2e on both harnesses**

```bash
PATH=<0.1.7-rc.2 prefix>/bin:$PATH DSH_SHOP_REQUIRE_E2E=1 DSH_SHOP_EXPECT_DSH=0.1.7-rc.2 node node_modules/vitest/vitest.mjs run tests/client/web-full-flow.e2e.ts
PATH=<0.1.5-rc.3 prefix>/bin:$PATH DSH_SHOP_REQUIRE_E2E=1 DSH_SHOP_EXPECT_DSH=0.1.5-rc.3 node node_modules/vitest/vitest.mjs run tests/client/web-full-flow.e2e.ts
```

Expected: 8/8 on each.

- [ ] **Step 7: Commit**

```bash
git add tests/client/web-full-flow.e2e.ts
git commit -m "test(e2e): drive installs, switches, updates and uninstalls through dsh's plugin manager on 0.1.7"
```

---

### Task 11: Records and the final run

**Files:**
- Modify: `docs/design/2026-09-26-plugin-manager-delegation.md` (status, sections 5, 6, 7 and 10)
- Modify: `docs/design/2026-09-26-dsh-017-readiness.md` (B3: built)
- Modify: `docs/plans/2026-08-18-remaining-work.md` (item 6(a): built)

- [ ] **Step 1: Record what was measured and where the build departs from the spec**

In the spec: change the status line to built; write the O1 to O4 results into section 10, each with its date and what it decided; amend section 7 for the four details and for the exemption the Plugins page does not offer; add the two narrowings to sections 5 and 6; note in section 5 that rule 7's note reaches an install's reader through the client's done view and does not reach a switch's.

- [ ] **Step 2: Run everything, on both harnesses**

Repeat Task 0's two package runs, then:

```bash
pnpm -C packages/dsh-plugin-shop typecheck
pnpm typecheck
node node_modules/vitest/vitest.mjs run   # the root suite, from the repository root
```

Expected: Task 0's totals plus the new cases, all green, except the load-sensitive cases Task 0 names if the machine is loaded. Name any other failure in the PR, whatever its cause.

- [ ] **Step 3: Commit, push, and open the PR**

```bash
git add docs
git commit -m "docs(design): record the plugin manager hand-off as built, with what its open items measured"
git push -u github feat/plugin-manager-delegation
```

The PR body lists each task, the measurements, and each departure from the spec. It does not release: the beta version is LivXue's to confirm.
