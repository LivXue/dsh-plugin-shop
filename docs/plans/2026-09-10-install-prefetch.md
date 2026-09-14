# Install prefetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the download for a queued install concurrently while the install itself stays serial, and label the two phases honestly.

**Architecture:** The per-profile mutex in `executor.ts` is untouched — it is the precondition of `installFailureDetail`'s attribution. An install that lands behind another one gets its packages fetched into pnpm's content store by a batched `pnpm store add` running outside the mutex, so its serial turn is a store hit. The mutex itself is the phase boundary: `state` starts `'downloading'` and the chained task flips it to `'running'` as its first act.

**Tech Stack:** TypeScript (ESM, `strict`, `noUncheckedIndexedAccess`), vitest, node `child_process`, pnpm 11.

**Spec:** `docs/design/2026-09-10-install-prefetch.md`

## Global Constraints

- ESM everywhere; `.ts` extensions in local relative imports.
- `strict` and `noUncheckedIndexedAccess` are on. Guard index access; never assert it away.
- Files end with exactly one trailing newline.
- Every user-facing string is bilingual: a key added to `zh` in `src/client/locales.ts` must be added to `en`, which is checked by `} satisfies Record<ShopLocaleKey, string>` at `locales.ts:209`.
- Design documents are English only.
- Tests describe behavior. A test made obsolete is rewritten with its reason stated, never quietly adjusted to pass.
- Prefer a fixture over a mock; never mock the module under test.
- An empty `catch` names what it swallows and why nothing else can reach it.
- The prefetch is best-effort. No failure of it may change whether an install succeeds — only how fast it runs.
- Run one test file with: `pnpm -C packages/dsh-plugin-shop exec vitest run <path> -t '<name>'` from the repository root.
- Full gates: `pnpm -C packages/dsh-plugin-shop test` and `pnpm -C packages/dsh-plugin-shop typecheck`.

---

### Task 1: One definition of the install state, with a terminal predicate

The union is declared twice today — `src/host/executor.ts:16` and `src/client/present.ts:128` — with nothing keeping them in agreement. It is about to gain a variant, so it moves to `src/shared/` first. It also gains `isTerminalInstallState`, because three call sites currently ask "is this finished?" by writing `!== 'running'`, which is only correct while there is exactly one non-terminal state.

**Files:**
- Create: `packages/dsh-plugin-shop/src/shared/install-state.ts`
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts:16` (delete the local union, import instead)
- Modify: `packages/dsh-plugin-shop/src/client/present.ts:126-134` (`InstallStatusShape.state`)
- Test: `packages/dsh-plugin-shop/tests/shared/install-state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type InstallState = 'downloading' | 'running' | 'done' | 'failed'` and `isTerminalInstallState(state: InstallState): boolean`, both from `src/shared/install-state.ts`.

- [ ] **Step 1: Write the failing test**

Create `packages/dsh-plugin-shop/tests/shared/install-state.test.ts`:

```ts
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { isTerminalInstallState, type InstallState } from '../../src/shared/install-state.ts'

const SRC_DIR = fileURLToPath(new URL('../../src', import.meta.url))
const OWNER = join(SRC_DIR, 'shared', 'install-state.ts')

describe('install state', () => {
  it('calls done and failed terminal, and downloading and running not', () => {
    const terminal: InstallState[] = ['done', 'failed']
    const live: InstallState[] = ['downloading', 'running']
    for (const state of terminal) expect(isTerminalInstallState(state)).toBe(true)
    for (const state of live) expect(isTerminalInstallState(state)).toBe(false)
  })

  // The structural guard. Two spellings of one wire union is how the host and
  // the client drifted apart before, and a second copy would typecheck
  // perfectly while disagreeing about what states exist.
  it('is declared in exactly one source file', () => {
    const offenders: string[] = []
    for (const dir of ['host', 'client', 'shared']) {
      const base = join(SRC_DIR, dir)
      for (const file of readdirSync(base)) {
        if (!/\.tsx?$/.test(file)) continue
        const path = join(base, file)
        if (path === OWNER) continue
        if (/'running'\s*\|\s*'done'\s*\|\s*'failed'/.test(readFileSync(path, 'utf8'))) {
          offenders.push(join(dir, file))
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/shared/install-state.test.ts`
Expected: FAIL — the module does not exist, so the import throws. (Once it exists but the moves are not done, the guard fails naming `host/executor.ts` and `client/present.ts`.)

- [ ] **Step 3: Create the shared module**

Create `packages/dsh-plugin-shop/src/shared/install-state.ts`:

```ts
/** The lifecycle of one install or uninstall command (§7.2, §7.3).
 *
 * Declared here rather than beside either consumer because it crosses the RPC
 * boundary: `executor.ts` produces it, `present.ts` consumes it, and each
 * used to spell the union itself with nothing keeping the two in agreement.
 *
 * `downloading` and `running` are BOTH non-terminal. Until `downloading`
 * existed there was exactly one non-terminal state, so `!== 'running'` was a
 * safe synonym for "finished" and three call sites wrote it that way. Ask
 * `isTerminalInstallState` instead — the next state added must not silently
 * reclassify a live install as finished.
 */
export type InstallState = 'downloading' | 'running' | 'done' | 'failed'

/** Whether the host is done with this record: it will not change again, and a
 * poller may stop. */
export function isTerminalInstallState(state: InstallState): boolean {
  return state === 'done' || state === 'failed'
}
```

- [ ] **Step 4: Point both consumers at it**

In `packages/dsh-plugin-shop/src/host/executor.ts`, delete line 16 (`export type InstallState = 'running' | 'done' | 'failed'`) and add to the import block:

```ts
import { type InstallState } from '../shared/install-state.ts'
```

Re-export it so existing importers of `executor.ts` keep working:

```ts
export type { InstallState } from '../shared/install-state.ts'
```

In `packages/dsh-plugin-shop/src/client/present.ts`, add the import and use the type:

```ts
import type { InstallState } from '../shared/install-state.ts'
```

```ts
/** One polled install status (§7.3 wire data), structural. */
export interface InstallStatusShape {
  found: boolean
  state: InstallState
  log: string[]
  needsRestart?: boolean
  restartReason?: HotRestartReason
  detail?: string
}
```

- [ ] **Step 5: Run the new test and the two suites it touches**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/shared/install-state.test.ts tests/client/present.test.ts tests/host/executor.test.ts`
Expected: PASS. `executor.test.ts` and `present.test.ts` are unchanged — nothing yet produces `'downloading'`, so no existing assertion changes meaning in this task.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C packages/dsh-plugin-shop typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/dsh-plugin-shop/src/shared/install-state.ts \
        packages/dsh-plugin-shop/src/host/executor.ts \
        packages/dsh-plugin-shop/src/client/present.ts \
        packages/dsh-plugin-shop/tests/shared/install-state.test.ts
git commit -m "refactor(shop): one install-state union, and a terminal predicate to ask it with"
```

---

### Task 2: The client accepts `downloading` before the host can send it

Deliberate ordering: the consumer learns the state first, so no commit in between can misreport one. Three sites decide terminality by exclusion, and the spec's §5 names only two — `useInstall.ts:143` collects which installs to poll by `view.kind === 'running'`, so a new view *kind* would leave a downloading install unpolled forever. The view therefore keeps `kind: 'running'` and gains a `phase`, and the spec is corrected to name the third site.

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/present.ts:136-141` (`InstallView`), `:176-200` (`reduceInstall`)
- Modify: `packages/dsh-plugin-shop/src/client/useInstall.ts:150` (the poll's terminal test), `:51`, `:123` (seed the phase)
- Modify: `packages/dsh-plugin-shop/src/host/index.ts:133-135` (`ShopInstallResult`)
- Modify: `docs/design/2026-09-10-install-prefetch.md` (§5's table gains the third site)
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`

**Interfaces:**
- Consumes: `InstallState`, `isTerminalInstallState` from Task 1.
- Produces: `InstallView`'s running arm is `{ kind: 'running'; installId: string; log: string[]; phase: 'downloading' | 'installing' }`; `ShopInstallResult`'s ok arm is `{ ok: true; installId: string; state: InstallState }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dsh-plugin-shop/tests/client/present.test.ts`:

```ts
describe('reduceInstall — the download phase', () => {
  const started = (state: InstallState = 'running') =>
    reduceInstall({ kind: 'idle' }, { type: 'started', installId: 'i1', state })

  it('seeds the phase from the state the host reported at start', () => {
    expect(started('downloading')).toEqual({
      kind: 'running', installId: 'i1', log: [], phase: 'downloading',
    })
    expect(started('running')).toEqual({
      kind: 'running', installId: 'i1', log: [], phase: 'installing',
    })
  })

  // The failure this guards is not a wrong label: a `downloading` status read
  // as terminal ends the poll and reports a success the host never sent.
  it('keeps polling on a downloading status and carries the phase', () => {
    const view = reduceInstall(started('downloading'), {
      type: 'status',
      status: { found: true, state: 'downloading', log: ['fetching'] },
    })
    expect(view).toEqual({
      kind: 'running', installId: 'i1', log: ['fetching'], phase: 'downloading',
    })
  })

  it('moves the phase to installing when the state does', () => {
    const view = reduceInstall(started('downloading'), {
      type: 'status',
      status: { found: true, state: 'running', log: ['adding'] },
    })
    expect(view).toEqual({
      kind: 'running', installId: 'i1', log: ['adding'], phase: 'installing',
    })
  })

  it('still settles on done', () => {
    const view = reduceInstall(started('downloading'), {
      type: 'status',
      status: { found: true, state: 'done', log: ['ok'], needsRestart: false },
    })
    expect(view.kind).toBe('done')
  })
})
```

Add `InstallState` to that file's imports:

```ts
import type { InstallState } from '../../src/shared/install-state.ts'
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/present.test.ts -t 'the download phase'`
Expected: FAIL — `started` passes a `state` the `InstallEvent` type does not have, and the returned views carry no `phase`.

- [ ] **Step 3: Widen the view, the event and the reducer**

In `packages/dsh-plugin-shop/src/client/present.ts`:

```ts
/** The install view state machine (§7.2). `phase` distinguishes the download
 * that runs ahead of the per-profile mutex from the install that holds it.
 * It rides the `running` kind rather than adding a kind of its own: every
 * `view.kind === 'running'` site — `useInstall.ts`'s poll collection among
 * them — must keep treating a downloading install as live. */
export type InstallView =
  | { kind: 'idle' }
  | { kind: 'rejected'; code: InstallRejectionCode; detail: string }
  | { kind: 'running'; installId: string; log: string[]; phase: 'downloading' | 'installing' }
  | { kind: 'done'; needsRestart: boolean; log: string[]; restartReason?: HotRestartReason }
  | { kind: 'failed'; detail: string; log: string[] }

/** One event the install view reacts to. */
export type InstallEvent =
  | { type: 'rejected'; code: InstallRejectionCode; detail: string }
  | { type: 'started'; installId: string; state: InstallState }
  | { type: 'status'; status: InstallStatusShape }

/** The phase a non-terminal state renders as. */
function phaseOf(state: InstallState): 'downloading' | 'installing' {
  return state === 'downloading' ? 'downloading' : 'installing'
}
```

In `reduceInstall`, replace the `started` case and the `running` branch:

```ts
    case 'started':
      return { kind: 'running', installId: event.installId, log: [], phase: phaseOf(event.state) }
```

```ts
      if (!isTerminalInstallState(status.state)) {
        return {
          kind: 'running',
          installId: state.installId,
          log: status.log,
          phase: phaseOf(status.state),
        }
      }
```

Import the predicate:

```ts
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'
```

- [ ] **Step 4: Fix the poll's terminal test and seed the phase**

In `packages/dsh-plugin-shop/src/host/index.ts`, widen the result:

```ts
export type ShopInstallResult =
  | { ok: true; installId: string; state: InstallState }
  | { ok: false; code: InstallRejectionCode; detail: string }
```

and import `InstallState` from `../shared/install-state.ts`. Both `install()` and the uninstall start return `state: running.status().state` alongside `installId`; the executor already computes it.

In `packages/dsh-plugin-shop/src/client/useInstall.ts:150`:

```ts
          if (status.found && isTerminalInstallState(status.state)) settled.current?.(key)
```

and at the two `started` dispatch sites (`:51` and `:123`) pass the state the host returned:

```ts
      setView({ kind: 'running', installId: result.installId, log: [], phase: result.state === 'downloading' ? 'downloading' : 'installing' })
```

```ts
      put(key, { kind: 'running', installId: result.installId, log: [], phase: result.state === 'downloading' ? 'downloading' : 'installing' })
```

Import `isTerminalInstallState` from `../shared/install-state.ts`.

The other two hooks build the same view shape and are NOT symmetric — seed each
according to what it can actually do:

**`src/client/useUpdateSelf.ts:33` — seed from the host, like `useInstall`.** The
self-update runs through `startInstall` (`index.ts:1213`), so it can be queued behind
another install and prefetched like any other. `ShopUpdateResult` (`index.ts:170`) is
therefore widened exactly as `ShopInstallResult` is:

```ts
export type ShopUpdateResult =
  | { ok: true; installId: string; state: InstallState }
  | { ok: false; detail: string }
```

with `updateStart`'s return (`index.ts:1222`) gaining `state: running.status().state`.
Seeding it `'installing'` instead would make a queued self-update read
Installing → Downloading → Installing: a backwards flicker, worse than the delay it
saves.

**`src/client/useUninstall.ts:34` — seed `phase: 'installing'`, unconditionally.** An
uninstall has nothing to fetch. `ShopUninstallResult` (`index.ts:146`) carries no state
and must not gain one, because an uninstall can never be in a download phase — see
Task 5, which passes the prefetcher to `startInstall` only.

```ts
      setView({ kind: 'running', installId: result.installId, log: [], phase: 'installing' })
```

- [ ] **Step 5: Run the client suite**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/`
Expected: PASS. Existing assertions that construct a `running` view now need `phase: 'installing'`; add it and say so in the commit — the view gained a field, the behavior those tests describe did not change.

- [ ] **Step 6: Correct the spec's §5**

In `docs/design/2026-09-10-install-prefetch.md`, the "Two consumers test terminality by exclusion" table becomes four rows and its heading loses the count — the spec found two, and reading the code for this plan found two more:

```markdown
### Sites that test terminality by exclusion, and what each needs

| site | today | required |
| --- | --- | --- |
| `useInstall.ts:150` | `status.state !== 'running'` ends the poll | `isTerminalInstallState(status.state)` |
| `present.ts:194` | `if (status.state === 'running')`, else fall through to done/failed | `if (!isTerminalInstallState(status.state))` |
| `executor.ts:481` | `append` drops a line when `state !== 'running'` | `if (isTerminalInstallState(state)) return` — otherwise the download phase's own log lines are silently discarded, and §7's whole visibility argument fails quietly |
| `useInstall.ts:143` | collects installs to poll by `view.kind === 'running'` | unchanged, because the view keeps that kind and carries a `phase` — a new view *kind* would leave a downloading install unpolled forever |

Three of the four are the same mistake with different consequences: one stops the poll,
one misreports the state, one throws away the evidence. None is a type error.
```

- [ ] **Step 7: Typecheck and commit**

Run: `pnpm -C packages/dsh-plugin-shop typecheck`
Expected: PASS.

```bash
git add packages/dsh-plugin-shop/src/client packages/dsh-plugin-shop/src/host/index.ts \
        packages/dsh-plugin-shop/tests/client docs/design/2026-09-10-install-prefetch.md
git commit -m "feat(client): a download phase the view can render, and no poll that reads it as finished"
```

---

### Task 3: A reusable "run a JS entry through node" command

`prefetch.ts` will spawn pnpm, and its test fixture is a `.mjs` file that cannot be spawned directly on any platform. `dshCommand` already decides this for `dsh` (the `JS_ENTRY` branch), but its first branch is dsh-specific. Extract the reusable half rather than writing a second copy of the regex — a second copy is a second place to get Windows wrong.

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/dsh-cli.ts:53` (`JS_ENTRY`), `:77-92` (`dshCommand`)
- Test: `packages/dsh-plugin-shop/tests/host/dsh-cli.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `jsEntryCommand(bin: string, args: readonly string[], execPath: string): DshCommand | null` from `src/host/dsh-cli.ts` — a command routing `bin` through node when `bin` names a JavaScript entry, or `null` when `bin` should be spawned as given.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/host/dsh-cli.test.ts`:

```ts
describe('jsEntryCommand', () => {
  it('routes a .mjs, .cjs and .js entry through the given node', () => {
    for (const bin of ['/tmp/fake.mjs', '/tmp/fake.cjs', '/tmp/fake.js']) {
      expect(jsEntryCommand(bin, ['store', 'add', 'a@1'], '/usr/bin/node')).toEqual({
        command: '/usr/bin/node',
        args: [bin, 'store', 'add', 'a@1'],
      })
    }
  })

  it('answers null for a program, so the caller spawns it as given', () => {
    expect(jsEntryCommand('pnpm', ['store', 'add', 'a@1'], '/usr/bin/node')).toBeNull()
    expect(jsEntryCommand('/usr/local/bin/pnpm', [], '/usr/bin/node')).toBeNull()
  })
})
```

Add `jsEntryCommand` to that file's import from `../../src/host/dsh-cli.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/dsh-cli.test.ts -t 'jsEntryCommand'`
Expected: FAIL — `jsEntryCommand is not a function`.

- [ ] **Step 3: Extract it and have `dshCommand` use it**

In `packages/dsh-plugin-shop/src/host/dsh-cli.ts`, below `JS_ENTRY`:

```ts
/**
 * The command that starts `bin` through `execPath` when `bin` names a
 * JavaScript entry, or `null` when `bin` is a program to spawn as given.
 *
 * Extracted from {@link dshCommand} so `prefetch.ts` can reach the same
 * decision for pnpm without a second copy of {@link JS_ENTRY}: both need it
 * for the same two reasons — a packaged JS entry is what a caller pinning an
 * installation can name, and a `.mjs` test fixture is the only fake CLI that
 * can be spawned on Windows at all.
 */
export function jsEntryCommand(
  bin: string,
  args: readonly string[],
  execPath: string,
): DshCommand | null {
  if (!JS_ENTRY.test(bin)) return null
  return { command: execPath, args: [bin, ...args] }
}
```

and rewrite the tail of `dshCommand`:

```ts
  if (dshBin === DSH_BIN_NAME) {
    if (platform === 'win32' && script !== null) return { command: execPath, args: [script, ...args] }
    return { command: dshBin, args: [...args] }
  }
  return jsEntryCommand(dshBin, args, execPath) ?? { command: dshBin, args: [...args] }
```

- [ ] **Step 4: Run the whole file to prove `dshCommand` is unchanged**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/dsh-cli.test.ts`
Expected: PASS, including every pre-existing `dshCommand` case. This is a pure extraction: no `dshCommand` assertion may need editing.

- [ ] **Step 5: Commit**

```bash
git add packages/dsh-plugin-shop/src/host/dsh-cli.ts packages/dsh-plugin-shop/tests/host/dsh-cli.test.ts
git commit -m "refactor(host): jsEntryCommand, so pnpm reaches the same decision dsh does"
```

---

### Task 4: The prefetch pump

A focused module with an injected spawn, driven in tests by a real spawnable fake pnpm. `executor.ts` is already 32 KB; the repository's habit is a small module per concern (`race.ts`, `npmrc.ts`, `tar.ts`).

**Files:**
- Create: `packages/dsh-plugin-shop/src/host/prefetch.ts`
- Create: `packages/dsh-plugin-shop/tests/fixtures/fake-pnpm.ts`
- Test: `packages/dsh-plugin-shop/tests/host/prefetch.test.ts`

**Interfaces:**
- Consumes: `jsEntryCommand` (Task 3); `KillFns` and `killTree` from `./executor.ts`.
- Produces, all from `src/host/prefetch.ts`:
  - `isPrefetchableSpec(spec: string): boolean`
  - `type PrefetchRequest = { started: true } | { started: false; reason: 'unsupported-spec' | 'no-pnpm' }`
  - `interface Prefetcher { request: (args: { profile: string; spec: string; cwd: string; env?: NodeJS.ProcessEnv; log?: (line: string) => void }) => PrefetchRequest; release: (profile: string, spec: string) => void }`
  - `createPrefetcher(options?: { pnpmBin?: string; spawn?: typeof nodeSpawn; platform?: NodeJS.Platform; execPath?: string; timeoutMs?: number; kills?: KillFns }): Prefetcher`

`request` reports the reason rather than a bare `false` because the caller writes the
line a user reads: "skipped, pnpm not found on PATH" and "no download phase for this
spec form" are different facts and the caller is the only place that knows which
install they belong to. Batch-level outcomes go the other way — the pump keeps each
spec's `log` and reports a batch's exit or timeout to every install that batch served,
because one batch serves several.

- [ ] **Step 1: Write the fake pnpm fixture**

Create `packages/dsh-plugin-shop/tests/fixtures/fake-pnpm.ts`:

```ts
/**
 * A fake `pnpm` that runs on every platform, for the same reason
 * `fake-dsh.ts` exists: a `#!/bin/sh` fixture cannot be spawned on Windows,
 * and a `.mjs` one is routed through node by `jsEntryCommand`.
 *
 * The body records its argv so a test can assert WHICH specs a batch carried
 * and how many batches ran — the two properties the pump is about.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Write `dir/pnpm.mjs`, appending one line per invocation to `dir/pnpm.log`.
 *
 * `delayMs` holds the child open so a test can enqueue a second install while
 * a batch is in flight. `exitCode` drives the non-zero path. `hang` never
 * exits, for the timeout case.
 */
export function fakePnpm(dir: string, options: {
  exitCode?: number
  delayMs?: number
  hang?: boolean
} = {}): string {
  const { exitCode = 0, delayMs = 0, hang = false } = options
  const bin = join(dir, 'pnpm.mjs')
  writeFileSync(bin, [
    "import * as fs from 'node:fs'",
    'const argv = process.argv.slice(2)',
    // Same reason as fake-dsh.ts: process.exit() on a piped stdout can drop
    // queued writes, so record the code and let the process end normally.
    'const recordExit = code => { process.exitCode = code === undefined ? 0 : code }',
    `fs.appendFileSync(${JSON.stringify(join(dir, 'pnpm.log'))}, argv.join(' ') + '\\n')`,
    hang
      ? 'setInterval(() => {}, 1000)'
      : `setTimeout(() => recordExit(${exitCode}), ${delayMs})`,
    '',
  ].join('\n'))
  return bin
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/dsh-plugin-shop/tests/host/prefetch.test.ts`:

```ts
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPrefetcher, isPrefetchableSpec } from '../../src/host/prefetch.ts'
import { fakePnpm } from '../fixtures/fake-pnpm.ts'

const temp = () => mkdtempSync(join(tmpdir(), 'dsh-prefetch-'))
const batches = (dir: string): string[] => {
  const log = join(dir, 'pnpm.log')
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(line => line !== '')
}
const settle = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms))

describe('isPrefetchableSpec', () => {
  it('accepts the npm and github forms', () => {
    expect(isPrefetchableSpec('dsh-hello@1.2.0')).toBe(true)
    expect(isPrefetchableSpec('github:owner/slug#0123456789abcdef0123456789abcdef01234567')).toBe(true)
    expect(isPrefetchableSpec('github:owner/slug#0123456789abcdef0123456789abcdef01234567&path:packages/a')).toBe(true)
  })

  // Measured 2026-09-10: pnpm re-fetches a raw tarball URL on every install
  // even when the store holds that exact tarball, and `store add` on a URL
  // resolves no dependency closure. Prefetching one is a full extra download
  // for no saving. Design doc §3.
  it('refuses a raw https tarball URL, which a prefetch cannot help', () => {
    expect(isPrefetchableSpec('https://github.com/o/s/releases/download/v1/a.tgz')).toBe(false)
    expect(isPrefetchableSpec('http://example.test/a.tgz')).toBe(false)
  })
})

describe('the prefetch pump', () => {
  it('sends one batch carrying every pending spec', async () => {
    const dir = temp()
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { delayMs: 30 }) })
    expect(prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })).toEqual({ started: true })
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({ started: true })
    await settle(200)
    expect(batches(dir)).toEqual(['store add a@1 b@1'])
  })

  it('holds a late arrival for the next batch rather than a second child', async () => {
    const dir = temp()
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { delayMs: 120 }) })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    await settle(40)
    prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })
    await settle(40)
    expect(batches(dir)).toEqual(['store add a@1'])
    await settle(300)
    expect(batches(dir)).toEqual(['store add a@1', 'store add b@1'])
  })

  it('refuses a tarball spec by name, without spawning anything', async () => {
    const dir = temp()
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir) })
    expect(prefetcher.request({
      profile: 'web', spec: 'https://github.com/o/s/releases/download/v1/a.tgz', cwd: dir,
    })).toEqual({ started: false, reason: 'unsupported-spec' })
    await settle(120)
    expect(batches(dir)).toEqual([])
  })

  it('reports pnpm absent to the install it was serving, and refuses the next by name', async () => {
    const dir = temp()
    const lines: string[] = []
    const prefetcher = createPrefetcher({ pnpmBin: join(dir, 'definitely-not-here') })
    expect(prefetcher.request({
      profile: 'web', spec: 'a@1', cwd: dir, log: line => lines.push(line),
    })).toEqual({ started: true })
    await settle(200)
    expect(lines.filter(line => line.includes('pnpm not found'))).toHaveLength(1)
    expect(prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir })).toEqual({
      started: false, reason: 'no-pnpm',
    })
    await settle(120)
    expect(batches(dir)).toEqual([])
  })

  it('tells every install a failed batch served, and installs anyway', async () => {
    const dir = temp()
    const a: string[] = []
    const b: string[] = []
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { exitCode: 1 }) })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir, log: line => a.push(line) })
    prefetcher.request({ profile: 'web', spec: 'b@1', cwd: dir, log: line => b.push(line) })
    await settle(250)
    expect(batches(dir)).toEqual(['store add a@1 b@1'])
    expect(a.some(line => line.includes('exit 1'))).toBe(true)
    expect(b.some(line => line.includes('exit 1'))).toBe(true)
  })

  it('kills a batch that outruns its bound', async () => {
    const dir = temp()
    const killed: number[] = []
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir, { hang: true }),
      timeoutMs: 60,
      kills: { killGroup: pid => killed.push(pid), killPid: pid => killed.push(pid), taskkill: pid => killed.push(pid) },
    })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    await settle(300)
    expect(killed).toHaveLength(1)
  })

  it('kills a batch once nothing needs it', async () => {
    const dir = temp()
    const killed: number[] = []
    const prefetcher = createPrefetcher({
      pnpmBin: fakePnpm(dir, { hang: true }),
      kills: { killGroup: pid => killed.push(pid), killPid: pid => killed.push(pid), taskkill: pid => killed.push(pid) },
    })
    prefetcher.request({ profile: 'web', spec: 'a@1', cwd: dir })
    await settle(80)
    prefetcher.release('web', 'a@1')
    await settle(80)
    expect(killed).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/prefetch.test.ts`
Expected: FAIL — `src/host/prefetch.ts` does not exist.

- [ ] **Step 4: Write the pump**

Create `packages/dsh-plugin-shop/src/host/prefetch.ts`:

```ts
/**
 * The download phase that runs in front of the per-profile install mutex.
 *
 * `dsh plugin add` is one opaque call: it resolves, fetches, links and writes
 * in a single pnpm invocation, so the shop cannot split it. What it can do is
 * warm pnpm's content store first, from outside the mutex, so the serialized
 * install is a store hit. Measured 2026-09-10: an npm or github spec warmed
 * this way installs with `downloaded 0`. Design doc §3.
 *
 * Best-effort by construction. Every failure here — pnpm absent, a non-zero
 * batch, a timeout, a store guessed wrong — leaves `dsh plugin add` to fetch
 * what the store lacks, exactly as it does today. Nothing about whether an
 * install SUCCEEDS may depend on this module.
 */

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { jsEntryCommand } from './dsh-cli.ts'
import { killTree, type KillFns } from './executor.ts'

/** How long one batch may run before it is killed. Far below
 * `INSTALL_TIMEOUT_MS`: a batch still running after this is no longer hiding
 * any latency, and the install behind it simply proceeds cold. */
const BATCH_TIMEOUT_MS = Number(process.env.DSH_SHOP_PREFETCH_TIMEOUT_MS) || 90 * 1000

/**
 * Whether warming the store for `spec` can save the install any work.
 *
 * A raw https tarball URL cannot, measured twice on 2026-09-10: pnpm
 * re-fetches such a URL on EVERY install even when the store already holds
 * that exact tarball — it must read the `package.json` inside it and that
 * read does not go through the store — and `pnpm store add` on a URL resolves
 * no dependency closure. So a prefetch of that form is one extra full
 * download for no measured saving. The three spec forms are indistinguishable
 * at the `store add` boundary (all exit 0, all print `+ <spec>`), which is why
 * this exclusion is recorded rather than left to look like an oversight.
 * Design doc §3.
 */
export function isPrefetchableSpec(spec: string): boolean {
  return !/^https?:\/\//i.test(spec)
}

/** Why no download phase happened, when one did not. The caller writes the
 * line a user reads, so it needs the reason and not a bare `false`. */
export type PrefetchRequest =
  | { started: true }
  | { started: false; reason: 'unsupported-spec' | 'no-pnpm' }

export interface Prefetcher {
  /** Queue `spec` for this profile's next batch, starting one if none runs.
   * `log` receives the outcome of whichever batch ends up carrying this spec —
   * one batch serves several installs, so a batch's exit is reported to each
   * of them. */
  request: (args: {
    profile: string
    spec: string
    cwd: string
    env?: NodeJS.ProcessEnv
    log?: (line: string) => void
  }) => PrefetchRequest
  /** This spec's install has settled. Kills the batch when nothing else needs it. */
  release: (profile: string, spec: string) => void
}

type Log = (line: string) => void

interface Lane {
  /** Spec → the log of the install waiting on it, for specs not yet sent. */
  pending: Map<string, Log>
  /** The same, for the specs the running batch carries. */
  inFlight: Map<string, Log>
  child: ChildProcess | null
  timer: NodeJS.Timeout | null
  /** The profile directory. It decides which store pnpm picks, so it is
   * carried per lane rather than per batch — every install into one profile
   * resolves to the same directory. */
  cwd: string
  env: NodeJS.ProcessEnv | undefined
}

export function createPrefetcher(options: {
  pnpmBin?: string
  spawn?: typeof nodeSpawn
  platform?: NodeJS.Platform
  execPath?: string
  timeoutMs?: number
  kills?: KillFns
} = {}): Prefetcher {
  const {
    pnpmBin = 'pnpm',
    spawn = nodeSpawn,
    platform = process.platform,
    execPath = process.execPath,
    timeoutMs = BATCH_TIMEOUT_MS,
    kills,
  } = options
  const lanes = new Map<string, Lane>()
  let pnpmAbsent = false

  const lane = (profile: string, cwd: string, env: NodeJS.ProcessEnv | undefined): Lane => {
    const existing = lanes.get(profile)
    if (existing !== undefined) {
      existing.cwd = cwd
      existing.env = env
      return existing
    }
    const created: Lane = {
      pending: new Map(), inFlight: new Map(), child: null, timer: null, cwd, env,
    }
    lanes.set(profile, created)
    return created
  }

  /** Tell every install the running batch served. */
  const announce = (current: Lane, line: string): void => {
    for (const log of current.inFlight.values()) log(line)
  }

  const finish = (profile: string, current: Lane): void => {
    if (current.timer !== null) clearTimeout(current.timer)
    current.timer = null
    current.child = null
    current.inFlight.clear()
    if (current.pending.size > 0 && !pnpmAbsent) start(profile, current)
  }

  const start = (profile: string, current: Lane): void => {
    const specs = [...current.pending.keys()]
    for (const [spec, log] of current.pending) current.inFlight.set(spec, log)
    current.pending.clear()
    const argv = ['store', 'add', ...specs]
    // pnpm on Windows is a `.cmd` shim, and node has refused `.cmd` without a
    // shell since the 2024 batfile fix; dsh's own answer for the same problem
    // is `shell: win32`. Every spec reaching that command line has already
    // passed `executor.ts`'s UNSAFE_TARGET gate — which refuses `"` — before
    // this module is called, so no quote here can be anything but ours.
    const routed = jsEntryCommand(pnpmBin, argv, execPath)
    const child = spawn(routed?.command ?? pnpmBin, routed?.args ?? argv, {
      cwd: current.cwd,
      env: current.env,
      stdio: 'ignore',
      detached: platform !== 'win32',
      shell: routed === null && platform === 'win32',
    })
    current.child = child
    child.on('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        pnpmAbsent = true
        announce(current, 'dsh-plugin-shop: no download phase — pnpm not found on PATH')
      } else {
        announce(current, `dsh-plugin-shop: the download phase could not start — ${error.message}`)
      }
      finish(profile, current)
    })
    child.on('exit', code => {
      if (code === 0) announce(current, 'dsh-plugin-shop: packages fetched ahead of the install')
      else if (code !== null) announce(current, `dsh-plugin-shop: the download phase exit ${code}; the install will fetch what is missing`)
      finish(profile, current)
    })
    current.timer = setTimeout(() => {
      announce(current, 'dsh-plugin-shop: the download phase exceeded its bound; the install will fetch what is missing')
      killTree(child.pid, platform, kills)
      finish(profile, current)
    }, timeoutMs)
  }

  return {
    request: ({ profile, spec, cwd, env, log = () => {} }) => {
      if (!isPrefetchableSpec(spec)) return { started: false, reason: 'unsupported-spec' }
      if (pnpmAbsent) return { started: false, reason: 'no-pnpm' }
      const current = lane(profile, cwd, env)
      current.pending.set(spec, log)
      if (current.child === null) start(profile, current)
      return { started: true }
    },
    release: (profile, spec) => {
      const current = lanes.get(profile)
      if (current === undefined) return
      current.pending.delete(spec)
      current.inFlight.delete(spec)
      if (current.child !== null && current.inFlight.size === 0 && current.pending.size === 0) {
        killTree(current.child.pid, platform, kills)
      }
    },
  }
}
```

**The import between this module and `executor.ts` is not a cycle to fix.**
`prefetch.ts` imports `killTree` and `KillFns` from `executor.ts` at runtime;
`executor.ts` imports only `type Prefetcher` back, which erases at compile time. An
implementer who "breaks the cycle" by copying `killTree` creates a second kill path,
which is the one thing that file's comments argue against.

- [ ] **Step 5: Run the tests until green**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/prefetch.test.ts`
Expected: PASS, all nine cases.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm -C packages/dsh-plugin-shop typecheck`
Expected: PASS.

```bash
git add packages/dsh-plugin-shop/src/host/prefetch.ts \
        packages/dsh-plugin-shop/tests/host/prefetch.test.ts \
        packages/dsh-plugin-shop/tests/fixtures/fake-pnpm.ts
git commit -m "feat(host): a batched prefetch pump, best-effort by construction"
```

---

### Task 5: Wire the pump to the queue, and let the mutex mark the phase

**Files:**
- Modify: `packages/dsh-plugin-shop/src/host/executor.ts:44-51` (the queue and a depth beside it), `:467` (initial state), `:481` (`append`'s guard), `:501` (the chained task's first act)
- Modify: `packages/dsh-plugin-shop/src/host/index.ts` (the gateway's `prefetcher` field and the two `startInstall` call sites; `evictFinishedInstalls` at `:918` and `hasRunningCommand` at `:927`)
- Modify: `docs/design/2026-08-18-dsh-plugin-shop-design.md` (§7.2 amendment)
- Modify: `docs/design/2026-09-10-install-prefetch.md` (§5's table corrected to the full set of sites)
- Test: `packages/dsh-plugin-shop/tests/host/executor.test.ts`, `packages/dsh-plugin-shop/tests/host/index.test.ts`

**Interfaces:**
- Consumes: `createPrefetcher`, `isPrefetchableSpec` (Task 4); `InstallState` (Task 1).
- Produces: `spawnPluginCli` accepts `prefetcher?: Prefetcher`; a queued install's first reported state is `'downloading'`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/dsh-plugin-shop/tests/host/executor.test.ts`:

```ts
describe('the download phase in front of the queue', () => {
  // Every case here uses a profile name of its own. `profileQueues` and the
  // new `profileDepth` are MODULE-level, and 33 cases in this file already
  // share `profile: 'web'` — an install still in flight from any of them
  // would make "nothing is ahead of me" read `downloading` and turn these
  // into intermittent failures that look like a regression in the feature
  // under test.
  it('reports downloading while queued, then running once it holds the queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-phase-'))
    const bin = fakeDsh(dir, 'setTimeout(() => process.exit(0), 120)')
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { delayMs: 40 }) })
    const first = startInstall({ profile: 'phase-queue', spec: 'a@1', dshBin: bin, prefetcher })
    // Nothing was ahead of the first, so it never enters the download phase.
    expect(first.status().state).toBe('running')
    const second = startInstall({ profile: 'phase-queue', spec: 'b@1', dshBin: bin, prefetcher })
    expect(second.status().state).toBe('downloading')
    await first.finished
    await second.finished
    expect(second.status().state).toBe('done')
  })

  it('records the download phase in the install log a user reads', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-phase-log-'))
    const bin = fakeDsh(dir, 'setTimeout(() => process.exit(0), 120)')
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir, { delayMs: 20 }) })
    const first = startInstall({ profile: 'phase-log', spec: 'a@1', dshBin: bin, prefetcher })
    const second = startInstall({ profile: 'phase-log', spec: 'b@1', dshBin: bin, prefetcher })
    await first.finished
    await second.finished
    // `append` refuses a line only once the state is TERMINAL. Guarded by
    // `state !== 'running'` instead, every line here is dropped and §7's
    // visibility argument fails without a single test going red.
    expect(second.status().log.some(line => line.includes('fetched ahead of the install'))).toBe(true)
  })

  it('says why there is no download phase for a tarball spec', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-phase-tb-'))
    const bin = fakeDsh(dir, 'setTimeout(() => process.exit(0), 80)')
    const prefetcher = createPrefetcher({ pnpmBin: fakePnpm(dir) })
    const first = startInstall({ profile: 'phase-tarball', spec: 'a@1', dshBin: bin, prefetcher })
    const second = startInstall({
      profile: 'phase-tarball',
      spec: 'https://github.com/o/s/releases/download/v1/a.tgz',
      dshBin: bin,
      prefetcher,
    })
    expect(second.status().state).toBe('running')
    expect(second.status().log.some(line => line.includes('no download phase for this spec form'))).toBe(true)
    await first.finished
    await second.finished
  })

  it('does not prefetch a lone install, this time or the next', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-lone-'))
    const bin = fakeDsh(dir, 'process.exit(0)')
    const pnpmBin = fakePnpm(dir)
    const prefetcher = createPrefetcher({ pnpmBin })
    // Two sequential installs, each awaited. `profileQueues` keeps its key
    // after the first, so a predicate written as `has(profile)` would call the
    // second one queued and prefetch it. Nothing is ahead of it.
    await startInstall({ profile: 'solo', spec: 'a@1', dshBin: bin, prefetcher }).finished
    await startInstall({ profile: 'solo', spec: 'b@1', dshBin: bin, prefetcher }).finished
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(existsSync(join(dir, 'pnpm.log'))).toBe(false)
  })
})
```

Add to that file's imports: `existsSync` from `node:fs`, `fakePnpm` from `../fixtures/fake-pnpm.ts`, and `createPrefetcher` from `../../src/host/prefetch.ts`.

And append to `packages/dsh-plugin-shop/tests/host/index.test.ts`, because two gateway
methods decide "is this finished?" by exclusion and both are wrong once a second
non-terminal state exists:

```ts
describe('a queued install is live, not finished', () => {
  it('does not evict a queued install as though it had finished', async () => {
    // `evictFinishedInstalls` counted anything not 'running' as finished and
    // evictable. A queued install reports 'downloading', so once the retained
    // records pass the 32 cap the OLDEST QUEUED one is deleted — and
    // installStatus then answers found: false, which the client's reducer
    // renders as "install record lost" on an install that is about to run.
    // The existing 33-install eviction case cannot catch this: it awaits every
    // install's completion before adding the one that triggers eviction, so no
    // record is 'downloading' at that moment. This one never awaits.
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const ids: string[] = []
    for (let i = 0; i < 34; i += 1) {
      const result = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
      if (!result.ok) throw new Error('fixture install was rejected')
      ids.push(result.installId)
    }
    const second = ids[1]
    const last = ids[ids.length - 1]
    if (second === undefined || last === undefined) throw new Error('no install ids collected')
    // The first holds the queue; every later one is queued behind it.
    expect(gateway.installStatus({ installId: second }).found).toBe(true)
    // Drain, so the suite does not tear down with 34 children mid-flight.
    const deadline = Date.now() + 20000
    while (gateway.installStatus({ installId: last }).state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })

  it('refuses a restart while an install is still queued', async () => {
    // `hasRunningCommand` asked `state === 'running'`, so a queued install did
    // not count and a restart was allowed to boot a new dsh against a profile
    // with installs pending — the very case F-5 exists to refuse.
    const { gateway } = gatewayWithSnapshot({ schemaVersion: 2, builtAt: '', entries: [listed], denied: [], stars: {} })
    const first = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    const second = await gateway.install({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true })
    if (!first.ok || !second.ok) throw new Error('fixture install was rejected')
    expect(second.state).toBe('downloading')
    const restart = await gateway.restart()
    expect(restart.ok).toBe(false)
    const deadline = Date.now() + 20000
    while (gateway.installStatus({ installId: second.installId }).state === 'running' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  })
})
```

Check `restart()`'s actual result shape against the existing F-5 case in this file
(`restart while an install is running (F-5)`) and match it — that case already asserts a
refusal and is the reference for what a refusal looks like.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/executor.test.ts -t 'the download phase in front of the queue'`
Expected: FAIL — the first case reads `'running'` (the state is set before the queue), and `startInstall` has no `prefetcher` option.

- [ ] **Step 3: Add a depth beside the queue**

In `packages/dsh-plugin-shop/src/host/executor.ts`, below `profileQueues`:

```ts
/** How many commands are queued or running per profile.
 *
 * `profileQueues` cannot answer this: its entries are only ever set, never
 * deleted, so `has(profile)` is true forever after a profile's first install
 * and would call every later lone install queued — earning it a pointless
 * prefetch and a `Downloading…` label that is simply false. Promise state is
 * not observable, so a counter is the only honest signal available.
 */
const profileDepth = new Map<string, number>()

function enterQueue(profile: string): number {
  const ahead = profileDepth.get(profile) ?? 0
  profileDepth.set(profile, ahead + 1)
  return ahead
}

function leaveQueue(profile: string): void {
  profileDepth.set(profile, Math.max(0, (profileDepth.get(profile) ?? 1) - 1))
}
```

- [ ] **Step 4: Let the mutex mark the phase**

In `spawnPluginCli`'s options add:

```ts
  /** The download phase, when the caller wants one. Best-effort: a queued
   * install whose prefetch fails or is refused simply installs cold. */
  prefetcher?: Prefetcher
```

destructure it. Take the queue slot where `state` is declared (line 467), but leave the
value alone for now:

```ts
  const ahead = enterQueue(profile)
  let state: InstallState = 'running'
```

Fix `append`'s guard (line 481) — this is the third row of the spec's table, and
without it every line below is silently discarded:

```ts
  const append = (line: string): void => {
    // Terminal, not "not running": a line that arrives during the download
    // phase is exactly the evidence §7 asks for, and `state !== 'running'`
    // would drop it. Late output from a SETTLED command is still refused.
    if (isTerminalInstallState(state)) return
```

Then, immediately after `append` and `status` are defined and before `chain` is
called, make the request. The order matters and is safe: `append` must exist to be
handed over as the prefetch's log, and nothing can observe `state` in between —
`chain` schedules its task through a promise, so it cannot run before this
synchronous block ends.

```ts
  // Only an install with something ahead of it has anything to overlap with.
  // `ahead` is a depth, not `profileQueues.has(profile)` — see `profileDepth`.
  const prefetch = ahead > 0 && prefetcher !== undefined
    ? prefetcher.request({
        profile,
        spec: target,
        // The profile directory decides which store pnpm picks, so the batch
        // runs where dsh runs pnpm rather than where the shop happens to sit.
        cwd: resolveProfileDir(profile, env?.DSH_HOME),
        env,
        log: append,
      })
    : null
  if (prefetch?.started === true) {
    state = 'downloading'
  } else if (prefetch !== null) {
    append(prefetch.reason === 'no-pnpm'
      ? 'dsh-plugin-shop: no download phase — pnpm not found on PATH'
      : 'dsh-plugin-shop: no download phase for this spec form; the install fetches it directly')
  }
```

The chained task's first act is the phase flip:

```ts
  const finished = chain(profile, () => new Promise<InstallStatus>((resolve) => {
    state = 'running'
    onStatus?.(status())
    beforeSpawn?.(env?.DSH_HOME)
```

and the bookkeeping settles when the command ends, wrapping the `chain(...)` result:

```ts
  })).finally(() => {
    leaveQueue(profile)
    prefetcher?.release(profile, target)
  })
```

`.finally` passes the value through, so `RunningInstall.finished` still resolves with
the `InstallStatus` it always did. The task resolves and never rejects, so no rejection
path is introduced.

Add the imports (`resolveProfileDir` is already imported for the manifest diff):

```ts
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'
import type { Prefetcher } from './prefetch.ts'
```

Thread `prefetcher` through `startInstall`'s options into `spawnPluginCli`.

**`startUninstall` does NOT take a prefetcher, and `index.ts` must not pass it one.** An
uninstall has nothing to fetch, and `isPrefetchableSpec` would happily accept the bare
plugin name it carries as its target — the shop would run `pnpm store add <name>` for a
package it is about to remove. Leaving the option off `startUninstall` entirely makes
that unrepresentable rather than merely unused.

- [ ] **Step 5: Give the gateway one prefetcher and report the initial state**

Nothing about logging belongs here: the executor hands `append` over as the per-request
log in Step 4, so the gateway only owns the prefetcher's lifetime.

In `packages/dsh-plugin-shop/src/host/index.ts`, add the field to the gateway class
beside its other collaborators:

```ts
  /** One pump for the whole gateway: batching is per profile and lives inside
   * it, so a second instance would race the first for the same store. */
  private readonly prefetcher: Prefetcher = createPrefetcher()
```

Pass it at both `startInstall` call sites (`index.ts:852` for `install`, `:1213` for
the self-update), adding one property to the existing options object:

```ts
      prefetcher: this.prefetcher,
```

Import both names:

```ts
import { createPrefetcher, type Prefetcher } from './prefetch.ts'
```

**Do not touch `install()`'s return statement.** Task 2 already widened
`ShopInstallResult` and made it return `state: running.status().state` — that field is
a client contract and Task 2 owns it, while the prefetcher is host plumbing and this
task owns that. Until this task runs, the state it reports is always `'running'`
because nothing produced anything else; after it, the same expression reports
`'downloading'` for a queued install with no further edit. Verify it reads
`state: running.status().state` and move on; re-adding it duplicates a property in one
object literal.

**Two gateway methods in the same file decide "finished" by exclusion and are wrong the
moment a second non-terminal state exists.** Both are the same one-line change, and both
are the difference between a feature and a defect:

```ts
  private evictFinishedInstalls(): void {
    const finishedIds: string[] = []
    for (const id of this.installOrder) {
      const record = this.installs.get(id)
      // Terminal, not "not running". A QUEUED install reports 'downloading',
      // and counting it here evicts a live record: `installStatus` then answers
      // found: false and the client renders "install record lost" for an
      // install that is about to run. The comment above this method — running
      // records are never evicted — is only true with this predicate.
      if (record !== undefined && isTerminalInstallState(record.status().state)) finishedIds.push(id)
    }
```

```ts
  private hasRunningCommand(): boolean {
    for (const record of this.installs.values()) {
      // A queued install is a command this gateway started and has not
      // finished. Asking `=== 'running'` would let a restart boot a new dsh
      // against a profile with installs pending — what F-5 refuses.
      if (!isTerminalInstallState(record.status().state)) return true
    }
    return false
  }
```

Import the predicate in `index.ts`:

```ts
import { isTerminalInstallState, type InstallState } from '../shared/install-state.ts'
```

(`InstallState` is already imported there by Task 2; add the value import beside it.)

- [ ] **Step 6: Run the host suite and fix what genuinely changed meaning**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/host/`
Expected: PASS. Assertions that enqueue several installs and read `'running'` — the 33-install eviction case in `index.test.ts` among them — now see `'downloading'` first. Each one changed must say in the commit why: the install is queued, and the state now distinguishes queued from executing. Do not relax an assertion to `expect.anything()`.

- [ ] **Step 7: Amend §7.2 of the main design**

In `docs/design/2026-08-18-dsh-plugin-shop-design.md`, after the §7.2 flow diagram, add:

```markdown
**Amendment (2026-09-10, the download phase): step 5 gains a phase in front of it.** An install that finds something already queued or running for its profile, and whose spec is not a raw https tarball URL, has its packages fetched into pnpm's content store by a batched `pnpm store add` running OUTSIDE the mutex — so its serial turn is a store hit. The mutex itself is unchanged and is the phase boundary: such an install reports `downloading` until it holds the queue and `running` after. The prefetch is best-effort and decides nothing: pnpm absent, a non-zero batch or a timeout leaves `dsh plugin add` to fetch what the store lacks. The raw-tarball exclusion is measured, not an oversight — see `docs/design/2026-09-10-install-prefetch.md` §3, which owns every figure behind this amendment.
```

Then correct §5's table in `docs/design/2026-09-10-install-prefetch.md` to the FULL set.
The spec listed two sites, task 2's amendment raised it to four, and a grep of every
`!== 'running'` / `=== 'running'` in `src/` found six — two of which are defects rather
than labels. Replace that table with:

```markdown
| site | today | required |
| --- | --- | --- |
| `useInstall.ts:150` | `status.state !== 'running'` ends the poll | `isTerminalInstallState(status.state)` |
| `present.ts:194` | `if (status.state === 'running')`, else fall through to done/failed | `if (!isTerminalInstallState(status.state))` |
| `executor.ts:483` | `append` drops a line when `state !== 'running'` | `if (isTerminalInstallState(state)) return` — otherwise the download phase's own log lines are silently discarded |
| `index.ts:918` | `evictFinishedInstalls` counts anything not `'running'` as finished | `isTerminalInstallState(...)` — otherwise a queued install is evicted as live, and `installStatus` answers `found: false` for an install about to run |
| `index.ts:927` | `hasRunningCommand` asks `=== 'running'` | `!isTerminalInstallState(...)` — otherwise a restart is permitted against a profile with installs queued, which F-5 exists to refuse |
| `executor.ts:538`, `:584`, `:602` | `settle`, the child's `error` handler and the deadline timer each return early on `state !== 'running'` | **no change.** All three are created inside the chained task, whose first statement is `state = 'running'`, so `'downloading'` is unobservable at any of them; they guard double-settle, not terminality |
| `useInstall.ts:143` | collects installs to poll by `view.kind === 'running'` | **no change**, because the view keeps that kind and carries a `phase` — a new view *kind* would leave a downloading install unpolled forever |

Adding a second non-terminal state to a union that had exactly one does not produce a
type error at a single one of these sites. Two are labels, two are silent data loss, and
three are already correct for a reason worth writing down rather than rediscovering.
```

- [ ] **Step 8: Commit**

```bash
git add packages/dsh-plugin-shop/src/host packages/dsh-plugin-shop/tests/host \
        docs/design/2026-08-18-dsh-plugin-shop-design.md
git commit -m "feat(host): the queue marks the phase, and a queued install downloads while it waits"
```

---

### Task 6: The two labels

The key choice is a pure function in `present.ts`, mirroring `restartReasonKey` at
`present.ts:18` — the file's existing way of turning a state into a `ShopLocaleKey`.
That keeps the test a unit test: `ShopTab.client.spec.tsx`'s only helper is
`renderTab(injected)`, which drives the whole tab through injected RPCs and has no
seam for handing it one view.

**Files:**
- Modify: `packages/dsh-plugin-shop/src/client/locales.ts` (`zh` near `:34`, `en` near `:141`)
- Modify: `packages/dsh-plugin-shop/src/client/present.ts` (add `installPhaseKey` beside `restartReasonKey`)
- Modify: `packages/dsh-plugin-shop/src/client/ShopTab.tsx:424`, `:1367`
- Test: `packages/dsh-plugin-shop/tests/client/present.test.ts`

**Interfaces:**
- Consumes: `InstallView`'s `phase` (Task 2).
- Produces: locale keys `downloading` (both dictionaries) and `installPhaseKey(phase: 'downloading' | 'installing'): ShopLocaleKey`.

- [ ] **Step 1: Write the failing test**

Append to `packages/dsh-plugin-shop/tests/client/present.test.ts`:

```ts
describe('installPhaseKey', () => {
  it('names a copy key for each phase, and both dictionaries carry it', () => {
    expect(installPhaseKey('downloading')).toBe('downloading')
    expect(installPhaseKey('installing')).toBe('installing')
    for (const key of ['downloading', 'installing'] as const) {
      expect(en[key]).toBeTruthy()
      expect(zh[key]).toBeTruthy()
      expect(en[key]).not.toBe(zh[key])
    }
  })
})
```

Add to that file's imports:

```ts
import { en, zh } from '../../src/client/locales.ts'
import { installPhaseKey } from '../../src/client/present.ts'
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/present.test.ts -t 'installPhaseKey'`
Expected: FAIL — `installPhaseKey` is not exported and `downloading` is not a key of either dictionary.

- [ ] **Step 3: Add the bilingual key**

In `packages/dsh-plugin-shop/src/client/locales.ts`, beside `installing` in `zh`:

```ts
  downloading: '正在下载…',
```

and beside `installing` in `en`:

```ts
  downloading: 'Downloading…',
```

`ShopLocaleKey` is `keyof typeof zh` and `en` closes with `} satisfies Record<ShopLocaleKey, string>`, so omitting either half is a type error rather than a missing string at runtime.

- [ ] **Step 4: Add the key selector beside `restartReasonKey`**

In `packages/dsh-plugin-shop/src/client/present.ts`, next to `restartReasonKey`:

```ts
/** The copy key for one install phase. A function rather than an inline
 * ternary in the JSX so it is unit-testable: the tab's only test seam is a
 * whole-tab render driven by injected RPCs, which cannot be handed one view. */
export function installPhaseKey(phase: 'downloading' | 'installing'): ShopLocaleKey {
  return phase === 'downloading' ? 'downloading' : 'installing'
}
```

- [ ] **Step 5: Render the phase**

At `packages/dsh-plugin-shop/src/client/ShopTab.tsx:424` and `:1367`, replace:

```tsx
        <p className={css.installing}>{t('installing')}</p>
```

with:

```tsx
        <p className={css.installing}>{t(installPhaseKey(view.phase))}</p>
```

and add `installPhaseKey` to the file's existing import from `./present.ts`.

Leave `:585` alone — that is `t('uninstalling')`, a different flow whose own phase is not part of this change.

- [ ] **Step 6: Run the client suite**

Run: `pnpm -C packages/dsh-plugin-shop exec vitest run tests/client/`
Expected: PASS.

- [ ] **Step 7: Full gates**

Run: `pnpm -C packages/dsh-plugin-shop typecheck`
Run: `pnpm -C packages/dsh-plugin-shop test`
Expected: PASS. One known local caveat: `web-full-flow.e2e.ts` skips without a playwright chromium, so the live-harness leg is CI's (`plugin.yml` sets `DSH_SHOP_REQUIRE_E2E=1`).

- [ ] **Step 8: Commit**

```bash
git add packages/dsh-plugin-shop/src/client packages/dsh-plugin-shop/tests/client
git commit -m "feat(client): Downloading while it waits, Installing while it installs"
```

---

## After the tasks

- The version carrying this changes an RPC shape twice (`InstallState` gains a variant, `ShopInstallResult` gains a field), so it goes to `beta` first and is installed by hand on a real profile before promotion — design doc §9. The version number is not chosen here.
- Reshooting the README screenshots belongs to the promotion commit, not this branch: the shoot installs the published pin, so a UI change cannot reshoot for itself.
