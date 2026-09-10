# Parallel download, serial install — design

Date: 2026-09-10
Status: specifies unbuilt behaviour. No code implements it. §7.2 of the main design gains its amendment in the implementing change, not here — until then the mutex step described there is what ships.

## 1. The complaint, and what it actually was

Reported as "installing several plugins at once hangs". It is neither a hang nor a
regression.

Installs are serialized per profile and always have been. `chain()` and
`profileQueues` in `executor.ts` arrived in `afd3c41` (2026-08-25), the first commit
that implemented install at all, and §7.2 step 5 of the main design names the
per-profile mutex as a step. `executor.ts` has not been touched since the 0.8.0
release.

What produces the appearance of a hang is that queueing is invisible. `state` is
initialised to `'running'` before the task enters the queue, so a **waiting** install
reports the same state as an executing one, and the client has no affordance for the
difference. Start five installs and five cards read `Installing…` while four of them
do nothing. `INSTALL_TIMEOUT_MS` bounds one command at fifteen minutes, so the
appearance can persist for a long time without anything being wrong.

## 2. Why the mutex stays

The comment on `profileQueues` gives one reason: pnpm locks itself, but its
concurrent-access errors are unreadable to a user. That is the smaller reason.

The larger one is that the executor's failure reporting is built on being the only
writer. `installFailureDetail` reads the profile manifest before and after the spawn
and reports only the difference, deliberately reporting evidence rather than
inferring a cause — one of its branches is "the name is absent and something else was
added — name what was added. That is the culprit." Under concurrent installs the
"something else" is a sibling install's own package, and the shop would name an
innocent package as the culprit in a string a plugin author reads. CLAUDE.md counts a
wrong author-readable `detail` as a defect, not a wording nit.

So the mutex is the precondition of the executor's attribution, not merely a guard
against pnpm's error text. Any design that makes installs concurrent owes the
executor a new way to attribute a miss. This design does not make them concurrent.

## 3. Measurements

**This section owns these figures.** Other documents and comments should cite it
rather than copy it; three copies of a figure in this repository had already drifted
apart on one date.

Measured 2026-09-10 on pnpm 11.13.0, dsh 0.1.2-rc.1, Linux. Each install ran in a
fresh `DSH_HOME` against a shared store, so "cold" is the first install of that
package and "warm" is a second install of it into a new profile.

| spec | cold | warm | download share |
| --- | --- | --- | --- |
| `dsh-always-status-bar@0.1.0` | 2115 ms | 825 ms | 61% |
| `upstream-radar@0.45.0` | 1945 ms | 832 ms | 57% |
| `@liushutan/dsh-automation@0.1.22` | 3506 ms | 876 ms | 75% |
| `github:ant404/dsh-media-gen#e60af48…` | 3424 ms | 2037 ms | 41% |
| `github:Joeytisaly/dsh-web-search-tokenrhythm#d0ee437…` | 3964 ms | 2092 ms | 47% |
| **total** | **14,954 ms** | **6,662 ms** | |

The warm floor is what the serial phase costs and cannot be removed by any amount of
prefetching: about 830 ms for an npm entry, about 2,040 ms for a github entry. The
difference is the build a git-hosted plugin runs on install, which dsh's own failure
text names. Most of the catalog is github-sourced — 5,993 of the 10,098 rows in
`registry/snapshots/manifest.lock` on 2026-09-10, against 3,921 npm rows — so the
mixed figure above is the representative one, not the npm-only ratio. (A comment in
`index.ts` puts the github share at 61%; this measurement gives 59% and the two are
not reconciled here. Either way the conclusion is the same: the github warm floor
dominates.)

`Σ warm = 6,662 ms` against `Σ cold = 14,954 ms` bounds the whole design: the best a
parallel download phase can reach is a 55% reduction, and only if every download
overlaps a serial install perfectly. Warming everything first and then installing
serially reaches about 34%.

### The mechanism, measured end to end

`pnpm store add <spec>` in a cwd inside the profile, then `dsh plugin add <spec>` in a
fresh profile. Every install reported `downloaded 0`, so the prefetch removed the
download entirely:

| spec | `store add` | install | downloaded |
| --- | --- | --- | --- |
| `@hzpeng/dsh-lens-rail@0.1.1` | 2721 ms | 813 ms | 0 |
| `dsh-ai-question-chime@1.0.4` | 1415 ms | 808 ms | 0 |
| `github:cheesehaqi/dsh-qq-onebot-bridge#baf…` | 3185 ms | 2084 ms | 0 |
| `github:uckkk/dsh-regex#6d2c0ed…` | 3232 ms | 2040 ms | 0 |
| `github:pd90506/dsh-web-notification#6a4076…` | 3053 ms | 3227 ms | 0 |

The last row's install is a second longer than the others' and still reports
`downloaded 0`: build time varies per plugin and is not download.

### What `pnpm store add` does and does not do

- It accepts all three spec forms the shop builds — `name@version`,
  `github:owner/slug#commit`, and a raw https tarball URL.
- It takes several specs in one call, mixed forms, and handles the network concurrency
  itself: two specs cost 2,911 ms, about what one alone costs. **The design therefore
  needs no concurrency pool of its own.**
- A multi-spec call's exit status is all-or-nothing — one unreachable spec yields
  `ERR_PNPM_STORE_ADD_FAILURE: Some packages have not been added correctly` and a
  non-zero exit while the others may have landed. Per-spec success is only readable
  from the `+ <spec>` lines on stdout.
- A `github:` spec resolves through `codeload.github.com/…/tar.gz/<sha>` rather than
  `git clone`, and that tarball IS served from the content store on the next install.

### Why a raw tarball URL is excluded

A release-rescued entry installs from `entry.tarball.url` — 184 of the 10,098 live
entries on 2026-09-10. Prefetching that form buys nothing, measured twice:

- The URL is re-fetched on **every** install. `Progress: resolved 0, reused 0,
  downloaded 1, added 0` is the first line even when the store already holds that
  exact tarball from a completed prior install. pnpm must fetch it to read its
  `package.json`, and that read does not go through the store.
- `store add` on a URL resolves no dependency closure. After prefetching one, the
  install still reported `resolved 4, reused 1, downloaded 3`; a second entry gave
  `resolved 7, reused 5, downloaded 2`.

So the form is excluded from the prefetch. **This is a measured exclusion, not an
oversight** — the three forms are indistinguishable at the `store add` boundary
(all exit 0, all print `+ <spec>`), and only the install's `reused`/`downloaded`
counters reveal that one of them changed nothing. A future reader who "fixes" the
gap adds one full extra download per release-rescued install for no saving.

## 4. The design

A prefetch phase runs concurrently; the install phase stays serial and unchanged.

### The predicate

An install is prefetched if and only if:

```
something is already queued or running for this profile
AND the spec form is npm or github:           (§3 excludes raw tarball URLs)
```

The queue-empty case is excluded because there is nothing for the download to overlap
with: prefetching then installing in series repeats pnpm's resolution and can only add
work to a lone install. The magnitude is not measured and does not need to be — the
overlap it would hide does not exist.

**`profileQueues` cannot answer the first clause.** Its entries are only ever set,
never deleted, so `has(profile)` is true forever after that profile's first install
and would mark every later lone install as queued — earning it a pointless prefetch
and a `Downloading…` label that is simply false. The pump therefore needs an explicit
depth, not the presence of a map key: a per-profile counter incremented as a task is
enqueued and decremented when it settles, with the predicate reading "the depth was
already above zero when I enqueued", i.e. something is ahead of me. Promise state is
not observable, so the counter is the only honest signal available.

### The queue is the phase boundary

`spawnPluginCli` sets `state` before handing its task to `chain()`, and the task body
runs only once it holds the queue. So:

- `state` is initialised to `'downloading'` when the predicate holds, `'running'`
  otherwise.
- the chained task's first act is `state = 'running'; onStatus?.(status())`.

No new synchronisation primitive, and no separate bookkeeping of who is waiting: the
mutex that already exists reports the boundary.

### The pump

A new module `src/host/prefetch.ts`. It does not live in `executor.ts`, which is
already 32 KB; the repository's habit is a small focused module per concern
(`race.ts`, `npmrc.ts`, `tar.ts`), and the spawn is injected the way `DshCliFs`,
`fetchTarball` and `KillFns` already are.

At most one batch child per profile:

1. An install that satisfies the predicate adds its spec to that profile's pending set.
2. If no batch child is running for the profile, one is spawned for the whole pending
   set: `pnpm store add <spec>…`.
3. When it exits, a non-empty pending set starts the next batch.

A late arrival therefore rides the next batch. A batch is roughly 3 s and a warm
install 0.8–2.0 s, so an arrival more than about two positions back is usually warm
before its turn; one that is not installs cold, which costs it the speedup and nothing
else.

### How the store is selected

`pnpm store path` answers differently per location, because pnpm places the store on
the same filesystem as the project so it can hardlink. Three locations on one machine,
one pnpm binary:

| cwd | store |
| --- | --- |
| the repository | `/Evermind/sh_evermind/.pnpm-store/v11` |
| `/root/.dsh/profiles/web` | `/root/.local/share/pnpm/store/v11` |
| `/tmp/…/profiles/spike` | `/tmp/.pnpm-store/v11` |

So the store is not configured, it is **inherited**: the batch runs with
`cwd = resolveProfileDir(profile, home)` — the same resolution `executor.ts` already
imports from `@deepseek-ai/dsh-app-boot` for the manifest diff — and the same
environment the `dsh` spawn gets. dsh itself runs `spawnSync("pnpm", …, { cwd: dir })`
with `dir` the profile directory, so this reproduces its context rather than guessing
at it. Setting `store-dir` was tried and is not a substitute: a profile-local `.npmrc`
did not move the answer.

pnpm needs no new guarantee. dsh resolves it as a bare name off `PATH` and exits 127
with `pnpm not found on PATH` when it is absent, so any machine where an install works
at all already has it. The prefetch resolves it the same way and skips itself when it
cannot.

### Windows

The prefetch spawns pnpm, so it inherits problems `dsh-cli.ts` has already solved and
must reuse rather than re-solve:

- `pnpm` on Windows is a `.cmd` shim, and node has refused `.cmd` without a shell
  since the 2024 batfile CVE. dsh's own answer is `shell: process.platform === 'win32'`.
- With a shell, catalog data reaches a command line. The existing `UNSAFE_TARGET` gate
  (which refuses `"` in the operand) and `shellSafeTarget()` (which quotes a spec
  containing `&`, on win32 only) apply unchanged and must be applied here too.

A second implementation of this is a second place to get Windows wrong.

## 5. States and labels

`InstallState` gains one variant: `'downloading' | 'running' | 'done' | 'failed'`.
`running` is not renamed — a dozen sites reference it — but its meaning narrows to
"the spawn is running".

| state | en | zh | when |
| --- | --- | --- | --- |
| `downloading` | `Downloading…` | `正在下载…` | a batch is running or pending for this install |
| `running` | `Installing…` (unchanged) | `正在安装…` (unchanged) | it holds the mutex; `dsh plugin add` is running |

`downloading` means the install is **in the download phase**, not that bytes are
moving at that instant: a spec waiting for the next batch reports it too. A third
`queued` label would remove that imprecision and was declined in favour of two labels.
The two excluded cases never enter the state at all, so for them the label is exact.

### Two consumers test terminality by exclusion and must be changed

The current union has exactly one non-terminal state, so "not `running`" is a safe
synonym for "terminal". Adding a second non-terminal state breaks that equivalence
**without a type error** — both sites below still typecheck:

| site | today | required |
| --- | --- | --- |
| `useInstall.ts:150` | `status.state !== 'running'` ends the poll | test `'done'`/`'failed'` explicitly |
| `present.ts:194` | `if (status.state === 'running')`, else fall through to done/failed | a `downloading` branch before them |

Left unchanged, a downloading install is read as finished: polling stops and the card
reports success while the package is still being fetched. This is the one failure mode
of this design that corrupts what the user is told rather than merely costing speed.

### One definition

`InstallState` is currently declared twice — `executor.ts:16` and `present.ts:128`
each spell the literal union, with nothing keeping them in agreement. Adding a variant
is the moment to move it to `src/shared/` and have both read one definition.

## 6. Degradation

Every failure of the prefetch degrades to today's behaviour, because `dsh plugin add`
is unchanged and re-fetches whatever the store lacks. Correctness never depends on a
warm store; only speed does.

| condition | handling |
| --- | --- |
| `pnpm` absent (`ENOENT`) | mark the prefetch unavailable for this process, log once, do not retry per install |
| batch exits non-zero | log and continue; per §3 the status cannot attribute the failure to a spec |
| batch exceeds its bound | `killTree` the child and continue. The bound is its own constant, far below `INSTALL_TIMEOUT_MS`'s fifteen minutes |
| the install it serves already settled | kill the batch child; nothing dangling |
| the store guess is wrong | wasted bytes, install unchanged |

## 7. Failure modes

- **Silent loss of the speedup.** If pnpm changes its store layout or resolution, the
  prefetch keeps exiting 0 and buys nothing. Nothing else in the system would notice.
  This is why the install log carries a line saying whether the prefetch was attempted,
  skipped, or failed, and why §3's tarball finding is recorded as measured rather than
  assumed.
- **`downloading` read as terminal.** §5. The worst outcome available here, and the
  only one that misreports state to the user.
- **A batch outliving its purpose.** Bounded and killed; see §6.

## 8. Testing

### A spawnable fake pnpm, not a mock

`tests/fixtures/fake-dsh.ts` is already a real, spawnable node fake — written that way
because a `#!/bin/sh` fixture cannot be spawned on Windows at all. `fake-pnpm.ts`
follows it, injected through a `pnpmBin?: string` option that mirrors the existing
`dshBin`. Batch merging, timeouts, `ENOENT` and a non-zero exit are then driven by a
real controlled child, which is what CLAUDE.md asks for: a fixture over a mock, and
never a mock of the module under test.

### Tests that must fail first

State machine:

1. A queued install reports `downloading`, then `running` once it holds the queue.
2. **The poll does not treat `downloading` as settled.** Must fail while
   `useInstall.ts:150` reads `!== 'running'`. Write this one first — it is the only
   test here guarding against misreported state rather than lost speed.
3. `present.ts` maps `downloading` to a view that keeps polling.
4. A source-scanning guard fails on a second literal declaration of the state union.
   Types do not exist at runtime, and this repository already scans source for an
   invariant the compiler cannot see (the `http-body.ts` guard).

The pump:

5. Queue empty: the fake pnpm is never invoked, and the state starts `running`.
6. **A lone install into a profile that has installed before is still not prefetched.**
   This is the test that fails against a predicate written as
   `profileQueues.has(profile)` (§4): the map keeps the key forever, so the second
   install into a profile looks queued when nothing is ahead of it. Two sequential
   installs, each awaited to completion, must invoke the fake pnpm zero times.
7. Queue non-empty: one child carries the whole pending set, and an arrival during a
   batch joins the next one rather than starting a second concurrent child.
8. A raw tarball URL is excluded from the batch.
9. `pnpm` absent: marked unavailable, not retried per install, logged once; the install
   still succeeds.
10. Batch exits non-zero: the install still succeeds.
11. Batch times out: the child is killed (asserted through the injected kill seam) and
    the install still succeeds.
12. The install settles first: the batch child is killed.

Visibility:

13. The install log carries the prefetch outcome and, when skipped, why.

### Blast radius

22 assertions across `executor.test.ts`, `index.test.ts`, `ShopTab.client.spec.tsx`
and `present.test.ts` mention `'running'`. Most drive a single install, whose state
still starts `'running'` because the predicate excludes it. The ones that enqueue
several — the 33-install eviction case among them — change meaning. Each such
assertion is to be changed with its reason stated, per CLAUDE.md: a test made obsolete
is rewritten and explained, never quietly adjusted to pass.

## 9. Release

Adding a variant to `InstallState` changes an RPC shape, so the version carrying it
goes to `beta` first and is installed by hand on a real profile before promotion.
0.5.0 through 0.5.2 each shipped a host-visible change straight to `latest` and each
was broken within minutes; a fixture written from the same wrong assumption agrees
with it, so the suite would not have caught them either.

§7.2 step 5 of the main design becomes an amendment in the implementing change — the
mutex stays, and the amendment records the download phase in front of it and the
predicate that decides whether an install enters it.
