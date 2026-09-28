# Delegating package operations to dsh's plugin manager: design

Status: Built, on branch `feat/plugin-manager-delegation`. Of the three
directions for remaining work item 6(a), LivXue chose A on 2026-09-26, and
option (a) of section 7 the same day. This amends
[2026-09-26-dsh-017-readiness.md](2026-09-26-dsh-017-readiness.md) B3: its
desktop refusal now stands only where the service described here is absent.

## 1. Why

dsh 0.1.7 ships `@deepseek-ai/dsh-plugin-manager`, mounted in base-backed
profiles as the Cordis service `pluginManager`. Its sidebar Plugins page and
its `plugin_manager` agent tool both drive it. It installs, updates, removes
and switches plugins and bundles, and it answers with data: the saved change,
the application outcome, a failure kind, and the packages a compatibility
check refused.

The shop performs the same mechanics itself, by spawning
`dsh plugin --profile <p> add|remove` and reading what the CLI prints. On
0.1.7 three things follow from that.

- **dsh's bundle switch is invisible to the shop.** The Plugins page can take
  a bundle out of `dsh.profile.bundles` and keep it installed. Nothing of it
  then runs, so the plugin inventory holds no entry for it, and the shop,
  which reads "nothing live" as enabled, shows it switched on.
- **The desktop profile is closed.** The CLI refuses `--profile desktop`
  (readiness B3), so the shop refuses every mutation there.
- **Refusals and failures are read by pattern.** `refusalDetail` and
  `installFailureDetail` parse CLI output line by line. The service hands
  over the same facts as fields.

Direction A keeps what only the shop has: the catalog, the install gates, the
acknowledgement every install asks for, and the compatibility verdicts on the
cards. It hands the mechanics to the harness service wherever one exists. On
a harness without it (0.1.5) nothing changes.

Two alternatives were rejected. Making the shop catalog-only on 0.1.7 (B)
drops the acknowledgement: dsh's page does not ask for one, and it is where
this project places install risk (CLAUDE.md, "Who reviews"). Keeping the CLI
everywhere (C) leaves desktop closed and lets the shop's view of the profile
keep drifting from dsh's own.

## 2. What was measured

On 2026-09-26, dsh 0.1.7-rc.2 was booted with `--profile web` in a temporary
`DSH_HOME`, with a throwaway plugin calling the service from its own context,
the way the shop would.

| Call | Result |
|---|---|
| `ctx.get('pluginManager')` | Present. `installBundle`, `removeBundle`, `setPluginEnabled`, `setBundleEnabled`, `listPlugins`, `listBundles` and `inspect` are all functions. Absent on 0.1.5-rc.3. |
| `installBundle('file:<dir>')` for a package declaring the peer `@deepseek-ai/dsh: 0.1.2-rc.1` | `application: 'failed'`, `stage: 'install'`, `error.code: 'incompatible-version'`, and `error.incompatible` = `[{ name, version, runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh': '0.1.2-rc.1' } }]`. The same list is on `packageResult.incompatible`. |
| `installBundle('file:<dir>')` for a fresh bundle | `application: 'applied'`, `stage: 'enable'`, `bundle` set. Its entry was live at once and the bundle was appended to `dsh.profile.bundles`. The caller mounted nothing. |
| `setPluginEnabled('include:shop-dummy2', false)`, then `true` | `applied` both times, and the live entry followed. The user layer gained `{ id: shop-dummy2, disabled: true }`, then `disabled: false`, with dsh's header comment kept. `listPlugins` gave the live id with `patchId: 'shop-dummy2'`, so the service maps the two id spaces itself. |
| `installBundle('file:<dir-v2>')`, same name, next version | `application: 'restart-required'`. The dependency spec was replaced, the order of `dsh.profile.bundles` did not change, and the old module kept running. |
| `removeBundle(name)` | `application: 'applied'`, `stage: 'remove'`. The entry and the dependency were both gone. |
| Events | The probe received `plugin-manager/install-state` (`installing`, `applying`, each tagged with the caller's `requestId`), 21 `plugin-manager/install-log` chunks carrying `requestId`, `argv` and `stream`, and `plugin-manager/changed` after each operation. |
| The calling plugin | Applied once across all of the above. No operation restarted the plugin that made the calls. |

Read from the service source (0.1.7-rc.2, `lib/index.js`), not measured:

- An install whose package was already a dependency returns
  `restart-required` without reloading (`Object.hasOwn(before, name)`), so an
  update never reports a live swap.
- Selecting a bundle that is already selected leaves `dsh.profile.bundles`
  alone. Enabling a deselected one appends it, which changes configuration
  precedence.
- There is no update operation. `installBundle(name@version)` on an installed
  name replaces it, because the one dependency that changed is taken as the
  target. `inspect` refuses such a spec as `already-installed`, so it cannot
  serve as a pre-check for updates.
- Registry fallback (`fallbackRegistries`, default
  `https://registry.npmmirror.com/`) lives in the service. The CLI imports only
  `@deepseek-ai/dsh-plugin-manager/operations`, which has none.
- The CLI also writes `.plugin-manager/logs/operation-*`, but its `pnpm.log`
  is empty (the CLI inherits the terminal and captures nothing), while a
  service run's `pnpm.log` holds pnpm's output. Measured on the same day.
- For a git spec whose host is github.com, `installBundle` first runs
  `git ls-remote` against the repository, bounded by
  `githubConnectionTimeoutMs` (5 s by default), before pnpm starts. Of the
  shop's three spec forms only the `github:` one is such a spec. A timeout
  there answers `kind: 'timeout'` with `failedAt: 'spec-host'`, and pnpm
  never runs; pnpm's own timeouts never carry `failedAt`. The CLI path has no
  such check: the dsh CLI imports only
  `@deepseek-ai/dsh-plugin-manager/operations`, which does not include it.
  Read from dsh-plugin-manager 0.1.7-rc.2's source on 2026-09-28.

## 3. The boundary

### 3.1 Detection

The gateway asks `ctx.get('pluginManager')` at each operation, as it asks for
`pluginPackages` and `pluginInventory`. It takes the service path when
`installBundle`, `removeBundle`, `setPluginEnabled` and `setBundleEnabled` are
all functions. It never consults a version number: a capability is what the
harness offers. Amended 2026-09-28: it asks once per RPC, at the start, and
passes the answer down. Asked again after an await, a service disposed in
between let a desktop mutation past the desktop gate and onto the CLI path.

The shop declares the slice it calls as a structural interface,
`PluginManagerLike`, instead of importing the package's types. The build
compiles against the harness floor, 0.1.1-rc.2 (plugin.yml, "compile at the
floor"), where the package does not exist. `HarnessPackageLookup` is
structural for the same reason.

### 3.2 What stays

Everything before the mutation, and everything the client sees:

- `installStart`'s gates (`validateInstall`, the release tarball's sha256
  pre-check, and the desktop check in its new form, section 7), and its spec
  construction: `name@version`, `github:owner/slug#commit[&path:subdir]`, or
  the release tarball URL. `parseInstallSpec` accepts all three forms.
  Amended 2026-09-28: the CLI executor's operand gate, which refuses a
  flag-like operand and one holding shell punctuation, runs on both paths.
  The manager path runs it before the spec reaches `installBundle` or the
  download phase, whose pump relies on it.
- The github commit pins, written at install and forgotten at uninstall.
- `alsoConfirm`'s checks on the landed files, the entry-id collision and the
  patch-declaration hazard. They are the shop's own policy and run on both
  paths.
- The per-profile queue, its depth counter, the `downloading` state, and the
  prefetcher.
- The install records: `installs`, `installOrder`, eviction, and
  `hasRunningCommand`, which the restart gate reads.
- The `imported` record (design 2026-09-26-market-borrowings, section 1) and
  the restart gate.

### 3.3 What changes

The mutation itself. A service-backed runner produces the same
`RunningInstall` (`installId`, `status()`, `finished`) as `startInstall` and
`startUninstall`, so `installStatus`, eviction, the restart gate and the
client are untouched. The CLI runner stays as it is and is chosen whenever the
service is absent.

### 3.4 The wire

No RPC changes shape. The client gains copy for the new details in section 5
and nothing else.

## 4. Operations

| Shop RPC | Service call | Activation |
|---|---|---|
| `installStart`, a fresh name | `installBundle(spec, { requestId: installId })` | Section 5 |
| `installStart`, an installed name (a catalog update) | The same | `restart`, reason `already-loaded` |
| `updateStart` (the shop itself) | `installBundle('dsh-plugin-shop@<version>', { requestId })` | `restart` |
| `uninstallStart` | `removeBundle(name)` | From `application`, with `hadClientHalf` read before the call, as today |
| `setEnabled` | `setPluginEnabled(entryId, enabled)` for each live entry the package owns. When enabling a package missing from `dsh.profile.bundles`, `setBundleEnabled(name, true)` first. | As today |

Switching off stays per plugin rather than per bundle, as it is today. That
works on both harnesses, dsh's Plugins page reads the same key, and a bundle
cycle would move the bundle to the end of `dsh.profile.bundles`. Calling the
service rather than the shop's own writer also returns `overridden`, which the
shop's writer cannot see. The bundle-selection read and the
`setBundleEnabled` call arrive first, in the smaller change that fixes the
invisible bundle switch (remaining item 3).

## 5. Reading the result

A `ChangeResult` becomes a terminal `InstallStatus`. The first rule that
matches wins.

1. `error.code === 'incompatible-version'`: `failed`, with readiness B1's
   detail built from `error.incompatible` through `allowVersionCommand`.
   Nothing is parsed.

   Amended 2026-09-27. The rule also matches `operation-error` when
   `error.incompatible` is a non-empty list: a removal whose post-run
   compatibility scan refused a sibling reports this way too. The detail
   passes on dsh's own restoration line ("nothing was installed",
   "restored ...", or "... could not be reinstalled ...") rather than
   asserting one. With no such line, an install or an update says "Nothing
   was installed." unless dsh truncated the output; an uninstall asserts
   nothing. The wording follows the operation: "refused the `<operation>`",
   "then `<operation>` again".
2. `application === 'failed'` and `stage === 'enable'`: `failed`. The package
   is installed but dsh could not enable it; the detail carries dsh's error
   and how to undo the install (section 7 says what that is in the desktop
   profile). An enablement failure after pnpm exited 0 is never a done
   install. dsh-market reported that exact confusion as a bug (fa8722a).
3. `application === 'failed'` with `packageResult.kind`:
   - `build-blocked`: the `pendingBuilds` names and the approval instruction.
     The shop never sends `approvedBuilds` (section 8).
   - `not-found`, `no-matching-version`, `network`, `timeout`, `integrity`,
     `disk-full`, `permission`, `pnpm-missing`: one sentence each, naming
     `failedAt` when present.
   - `unknown`: `installFailureDetail` over `packageResult.output`. The pnpm
     out-of-memory hint (remaining item 6) lives there, so both paths get it.

   Amended 2026-09-27. dsh reports every failed pnpm run as
   `operation-error`, with `packageResult.kind` set and the whole pnpm
   output as its diagnostic (`installBundle` and `removeBundle` both throw
   `new Error(run.output)`). So this rule matches a failed answer carrying
   `kind` only when `error.code` is absent or `operation-error`, and it
   never embeds that diagnostic.

   Amended 2026-09-28. `timeout` with `failedAt: 'spec-host'` is dsh's
   repository check (section 2), not pnpm, and its sentence says that the
   check did not finish within its bound and that pnpm never ran.
4. Any other `error.code` (`unknown-plugin`, `invalid-spec`,
   `ambiguous-install`, `not-bundle`, `not-removable`, `stop-profile`,
   `bundle-in-use`, `stale-approval`, `management-required`, `unaddressable`,
   `operation-error`): `failed`, one sentence each plus `error.diagnostic`.

   Amended 2026-09-28. The detail says dsh refused the operation, except
   for `operation-error`, dsh's code for any error that is not one of its
   refusals (`managementError`), where it says dsh could not perform it. A
   switch and a re-selection word it the same way.
5. `application === 'cancelled'`: `failed`, with the timeout detail
   (section 6).

   Amended 2026-09-28. Not the CLI path's timeout detail, whose
   `dsh plugin --profile <p> install` no longer involves the package: dsh
   answers `cancelled` only once its repository check or pnpm has exited and
   package.json and pnpm-lock.yaml are restored (`cancelInstall`, and
   `InstallCancelledError`, thrown after the restore). The detail says the
   shop cancelled the operation at its deadline, that dsh stopped it,
   restored those two files and installed nothing, and to try again from the
   shop. It names no command, on web or on desktop.
6. `restart-required`: `done`, activation `restart`.
7. `overridden`: `done`, with a note that the change is saved and a
   higher-priority layer (the home or invocation patch) decides whether it
   runs.

   Amended 2026-09-27. That note reaches an install's reader through the
   client's done view.

   Amended 2026-09-28. A switch reads `overridden` as a failed switch,
   because dsh saved the row but the live state did not change: dsh answers
   it when the entry still differs from the request after its write and
   reload (`setPluginEnabled`), and its README names what outranks the
   profile's own patch, home and invocation patches. The detail says that
   dsh saved the switch but such a patch keeps the plugin on or off, and adds
   the n-of-m sentence below when other entries had already switched. Read
   as success, it flipped the client's switch and reported the change
   applied while the plugin ran as before.
8. `applied`: `done`. For an install, `activationOf({ hostLive: true,
   clientLive: true, hasClientHalf })`, the verdict a successful hot mount
   gives today, unless the `imported` record holds the name, in which case
   `restart` with `already-loaded` (open item O1). For an uninstall, `hostLive`
   is true.

A failed uninstall whose answer carries `changed: true` gets one more
sentence, added 2026-09-27: the package is still installed, but dsh has
switched it off. dsh deselects an enabled bundle before `pnpm remove` runs
and never re-selects it, so a failure past that point leaves the entry
disabled rather than as it was.

A call that throws before it yields a result, such as an
`InvalidInstallSpecError` or a transport failure, becomes `failed` with the
error's message. `alsoConfirm` runs after a done install, as on the CLI path,
and turns it into `failed` with its own detail. Amended 2026-09-28: a thrown
value whose message is not a string, or whose description itself throws,
reads as one fixed string, so its record always settles; before, such a
value left the record running and F-5 refusing every restart.

Switching is not one of these eight rules: `setEnabled` calls
`setPluginEnabled` per live entry and builds a `ShopSetEnabledResult`
directly (section 4). Amended 2026-09-27: a refusal after n of the m live
entries have already switched says "<n> of its <m> plugins had already
switched <on|off>." Nothing already applied is rolled back; the next
`installed()` call shows the live state. The bundle re-selection path from
#67 reads dsh's answer the same way. Amended 2026-09-28: both read it
through one helper, and an `application` this shop does not know fails the
switch or the re-selection with a detail naming it, as an install's answer
does when no rule above matches. The n-of-m sentence follows any failure
partway through, a thrown answer and an override included, not only a
refusal. A switch or a re-selection through the service is refused while an
operation this shop started is running or queued in the profile, the check
F-5 makes, with a detail saying to switch after it finishes: dsh holds its
profile lock for a whole install (`change()` wraps pnpm), and a switch would
wait for it up to its lock timeout, `lockWaitMs`, 120 s, and then fail. The
CLI path is unchanged, because its writer takes no dsh lock; nor is
switching a deselected package off, which the shop's writer does alone.

## 6. Progress, time and the queue

- The gateway subscribes once to `plugin-manager/install-log` and
  `plugin-manager/install-state`. A chunk whose `requestId` names a live
  record is split into lines and appended to that record's log under the
  existing bounds (`MAX_LOG_LINES`, `MAX_LOG_BYTES`), with carriage returns
  stripped as the CLI capture strips them. A phase moves the record to
  `running`.
- The record's first log line names the mechanism. It begins with
  `via dsh's plugin manager:` and continues with the operation and its
  target, for example `install dsh-foo@1.2.0`. The shop's log panel shows it,
  which tells a person reading a failure which path ran, and gives the e2e a
  shop-owned way to prove it (section 9).
- Removal carries no request id, so its record takes the final
  `packageResult.output`, as does an install whose chunks never arrived. A
  switch makes no record at all (section 5).
- The existing `INSTALL_TIMEOUT_MS` bounds a service install as it bounds a
  CLI one. On expiry the runner calls `cancelInstall(requestId)`. `cancelled`
  fails the record with today's timeout detail (amended 2026-09-28: with a
  detail of its own, section 5 rule 5). `too-late` means dsh is applying the
  bundle, and the runner keeps waiting for its result.
- Service operations run in the same per-profile chain as CLI ones: one at a
  time, `downloading` while queued, the prefetcher unchanged. The service's
  own profile lock (`lockWaitMs`, 120 s) orders them against dsh's page and
  the CLI.

Amended 2026-09-27, matching what shipped:
- `install-state` events are not subscribed. Only `install-log` is routed,
  one line assembler per stream.
- The mechanism line named above stays outside the bounded log, so it is
  always a record's first line. A record may carry one line over the line
  cap because of it.
- A record settles only when the service call settles. The shop's deadline
  cancels through `cancelInstall` and keeps waiting when dsh answers
  `too-late`, as above. A harness without `cancelInstall` gets no shop
  deadline at all.
- Amended 2026-09-28. So a service call that never settles keeps its record
  running, and F-5 keeps refusing a restart, even after dsh answered
  `too-late`, when the files are already written and F-5's reason for
  refusing no longer holds. The shop has no second deadline for that case:
  the refusal lasts until the call settles or dsh itself restarts.

## 7. The desktop profile

Decision (a), 2026-09-26. In a profile named `desktop` in any letter case
(`isDesktopProfile`, the CLI's own rule), install, uninstall, update and
switching go through the service when it is present. Restart stays refused
there, because the app owns the process (`RestartBlockedReason` `desktop`).
Without the service, today's refusals stand: `desktop-profile` for an
install, and `DESKTOP_PROFILE_DETAIL` for the rest.

No detail may hand a desktop reader a `dsh plugin` command, because the CLI
refuses that profile. Two details print one today. The undo in
`alsoConfirm` and in section 5 rule 2 names the shop's own uninstall there.
Readiness B1's `allow-version` command names dsh's Settings, Plugins page,
where the service's own exemption flow (`setVersionExemption`) is offered. The
shop still grants no exemption itself.

Amended 2026-09-27. Four details printed a `dsh plugin` command, not the two
named above: the undo in `alsoConfirm`; readiness B1's `allow-version`
refusal; `installTimeoutDetail`; and `installFailureDetail`'s hint. None of
them reaches a desktop reader now. dsh's Plugins page offers no version
exemption, and the shop grants none; the desktop refusal says so and points
nowhere else.

dsh's own texts can still name a `dsh plugin` command, in
`pluginCompatibilityWarning` and in the rollback line "run 'dsh plugin
install'". A desktop reader's detail drops them at clause level: a sentence
splits at `"; "`, only the clauses naming a `dsh plugin` command drop, and
the rest keeps its terminator. The shop's own sentences are never scrubbed
this way, and the record's log stays dsh's verbatim record. Amended
2026-09-28: a message a service call throws is dsh's text too, and reaches a
desktop reader scrubbed the same way, in an operation's record and in the
details of a switch and a bundle re-selection.

Amended 2026-09-28. Nor may a detail hand a desktop reader a `pnpm` command:
the app supplies its own bundled package manager (the evidence paragraph
below). Rule 3's `build-blocked` detail names `pnpm approve-builds` on web
only. On desktop it says the shop never allows build scripts, and for an
install whose held builds dsh listed it adds that dsh's Plugins page offers
"Allow these scripts and retry" when an install it runs stops on them, read
from dsh-client-ui-plugin-manager 0.1.7-rc.2 (its README, and
`installApproveAndRetry` in `lib/client.js`) on 2026-09-28. That button sits
on the failed screen of the page's own Add plugin dialog, which refuses a
name the profile already holds, so an update's detail does not name it; nor
does one where dsh listed no held build, since the page then offers no such
button.

The evidence, and where it stops. The package's own README says
application-owned profiles supply their bundled package manager through
launcher facts, and the service does read `profile.packageManager` in place of
`pnpmCommand`. The same README lists "Desktop package operations remain owned
by the Desktop shell" under its known limitations. dsh-market routes the
desktop profile to the service (fa8722a, #702 and #703), keyed on the profile
name for the reason above. The desktop host, `@deepseek-ai/dsh-desktop-host`,
is not published, and nothing in this design was measured on it. In the worst
case the route changes what a person reads: a structured failure from the
service in place of a refusal.

## 8. Rules

- **Build scripts.** The shop still never approves them. `pendingBuilds` is
  shown and `approvedBuilds` is never sent
  ([the shop design](2026-08-18-dsh-plugin-shop-design.md), section 7.2).
- **Registries.** The service asks pnpm's configured registry first, then its
  `fallbackRegistries` while a registry is unreachable or has no copy, and
  never falls from a private registry to a public one. The CLI path has no
  fallback. This is accepted as the user's dsh configuration rather than
  overridden: the catalog's spec still pins the version, and a release
  tarball is still checked against its recorded sha256 before anything runs.
- **Release.** The shop reads a new harness service, so the first build
  carrying this goes through `beta` (CLAUDE.md, release channels). The 0.1.5
  path is unchanged.

## 9. Testing

- **Unit.** A fake service implementing `PluginManagerLike`. Section 5 as a
  table, one case per rule. Detection: present, absent, and one method
  missing. Event routing by request id, including a chunk for an unknown id.
  The timeout arm in both outcomes. Desktop routed with the service and
  refused without it. The `imported` override. Each guard is reverted to the
  defect once, and the suite must fail. Amended 2026-09-28: one case routes
  `install-log` and `changed` through a real cordis `Context`, from the
  context that provides the service to the one the gateway is built in. Every
  other case hands the gateway a stub whose listeners it calls by hand, which
  a subscription cordis never delivered would pass.
- **The e2e, on the 0.1.7 leg.** Remaining item 5 adds that leg and comes
  first. Install, switch off and on, update to the restart prompt, and
  uninstall, all through the service. The install, update and uninstall cases
  assert the mechanism line of section 6 in the shop's log panel, so a silent
  fall back to the CLI fails the case instead of passing it. dsh's own trace, a
  non-empty `pnpm.log`, is recorded in section 2 but not asserted: it is a
  harness internal. The 0.1.5 leg keeps covering the CLI path unchanged.
- **The uninstall case.** It asserts the line in the log panel of the
  uninstall's done view. Since this branch, that view keeps its log, as an
  install's done view does. dsh's removal settles about 1.3 s after the click,
  before the client's first 1 s poll, so the running view never shows the line.
- **The switch case.** It asserts no mechanism line, because a switch makes no
  record and has no log panel. Unit tests pin its route. On 0.1.7 the e2e
  proves the switch went through dsh in two ways: the entry goes down and comes
  back, and the user layer holds exactly one row for it (O3).
- **Desktop.** Unit tests only, and the PR says it is unmeasured.

## 10. Open items, measured before the step that needs them

- **O1.** Whether an uninstall followed by a reinstall in one session,
  through the service, loads a fresh module or the one Node cached. Until
  measured, the `imported` override in section 5 stands.

  Measured 2026-09-27, on 0.1.7-rc.2: after `removeBundle` and
  `installBundle` of v2 both answered `applied`, the re-created entry ran
  the module Node had cached. The profile uses `nodeLinker: hoisted`, so
  every version of a name loads from the same URL. Disk and `listBundles`
  said 2.0.0.

  Decided: the `alreadyImported` rule (a restart, reason `already-loaded`)
  stays. The manager path records a name as imported when dsh's answer
  reached stage `enable`. It re-reads the manifest into that record on
  `plugin-manager/changed` with `reason: 'install'`. That event names no
  package, and dsh's own Plugins page installs through the same service.
- **O2.** Whether `applied` makes a browser half one tab reload away, as a
  hot mount does today (`clientLive: true`).

  Measured 2026-09-27: the e2e's browser-half case passes through the
  service, so `applied` does put a browser half one reload away. Nothing
  changed.
- **O3.** Whether a row the shop wrote on 0.1.5 (block style, with a module
  name assertion) is updated in place when the service toggles it on 0.1.7.
  dsh matches rows by id and by any module-name assertion, so it is expected
  to be.

  Measured 2026-09-27, on 0.1.7-rc.2: `setPluginEnabled('include:<id>',
  enabled)` updated that row in place and appended none, whether or not the
  row carried `name`. The 0.1.5 shop's writer writes no `name`. dsh leaves
  the user layer at mode 0600, and it appends in flow style to the CLI's
  empty `[]` template.

  Decided: switching goes through the service.
- **O4.** Whether the shop's own update, made through the service while the
  shop is the caller, settles its call before the restart it asks for.

  Measured 2026-09-27, on 0.1.7-rc.2: `installBundle` on the shop's own
  package settled in the caller with `restart-required` after about 1.3 s.
  The running instance was neither disposed nor re-composed, and the new
  version ran only after a restart.

  Decided: the self-update record reaches `done` with a restart before
  anything restarts. No special handling.

## 11. Out of scope

A cancel button, a registry picker, exemption and build-approval screens, a
sidebar entry (market borrowings C14), and reading installed state from
`listBundles`: remaining item 3 reads the profile manifest, which suffices on
both harnesses.

## 12. Order of work

1. Remaining item 5: the 0.1.7 CI leg and the expected-version assertion.
2. Remaining item 6: the pnpm out-of-memory hint. Independent of the rest.
3. Remaining item 3: the bundle-selection read and the first
   `pluginManager` call.
4. This design, in steps: the runner with install and update, then
   uninstall, then switching, then desktop routing.
