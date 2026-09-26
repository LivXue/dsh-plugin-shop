# Activation model — design

Status: **implemented (2026-09-13).** Amended 2026-09-13 (§4.1): the
uninstall receipt outlives the row it is attached to, which took three
fixes to get right and is recorded so it is not rediscovered. Amended
2026-09-26 (§3, §5, §6): an update — or a reinstall of a package this process
already imported — no longer hot-mounts at all, because the mount re-ran the
OLD module under the new version's name (`2026-09-26-market-borrowings.md`
§1). The shop replaces its
two-valued `needsRestart` with a three-valued `activation`, because a dsh
plugin has two halves that go live by different routes and the shop has
only ever reported on one of them. The authority spec
(`2026-08-18-dsh-plugin-shop-design.md`, §8) is amended in the same
change. English only, per convention.

## 0. The incident

Two reports on 2026-09-11, one root cause.

**Disable.** Disabling `open-sea-skin`, and separately
`@xmanrui/dsh-im`, showed the shop's enable/disable note — *takes effect
without a restart* — and the plugin stayed on screen. A page reload was
what removed it.

**Install.** Installing `dsh-theme-endfield` showed *installed and
hot-mounted; running now, no restart needed*, and the theme did not
apply. The reader restarted dsh.

Both notices describe the **host half**. Neither says anything about the
browser, and the browser is where both of those plugins live: each
declares `dsh.client`. The shop has no concept for "the server is
already right, your page is stale", so it cannot say it, and the reader
is left to choose between believing a notice that looks wrong and
restarting a process that did not need restarting.

## 1. Evidence gathered before design

Measured 2026-09-11 against `@deepseek-ai/dsh@0.1.5-rc.1`, on a
throwaway `DSH_HOME` with purpose-built fixtures. None of it is inferred
from the type declarations alone; each row below is a fetched byte.

**The browser half arrives only through `window.__DSH_BOOT__`.**
`ClientModuleRegistry` (`@deepseek-ai/dsh-client-modules`, node half)
scans the loader's entries for packages declaring `dsh.client`, composes
the entry graph, and contributes it to the webserver's index injection
table. A browser tab reads that global once, at page load.

**The injection table is rebuilt per request.** `dsh-host-webserver`
documents `webserver/index-inject` as emitted on every index. So a
reload does not serve a graph frozen at boot; it serves the graph as of
that request. This is the fact the whole design rests on, and it is why
"reload" is a real third state rather than a synonym for "restart".

**Three runtime transitions, all observed without restarting the
process** — same pid, same port, no second `dsh web:` line in the log:

| Transition | Host half | Served `__DSH_BOOT__` | Browser needs |
|---|---|---|---|
| Disable at runtime | fiber disposed | 54 → 53 entries, `rev` changed | reload |
| Re-enable at runtime | fiber active | 53 → 54 entries | reload |
| Hot mount (the shop's own path) | activated in 0.8 s | 54 → 55 entries | reload |

The hot-mount row is the load-bearing one, so it was measured through
the shop's exact mechanism rather than a proxy: a probe plugin
replicating `hot.ts`'s `ctx.plugin(suppressWrite(Include), { path })`
against an include file of `mkt-`-prefixed rows, for a package present
in `node_modules` but deliberately absent from the boot bundle layer.
The fiber reported `ACTIVATED`, the graph gained the row, and the row's
advertised bundle URL (`/plugins/??dsh-probe-late/client.js&rev=…`)
answered **200**. The chain is complete end to end: mount → recompose →
inject → serve.

**A hypothesis was falsified, and it was the expensive one.**
`ClientModuleRegistry` caches package metadata — including the negative
"not a client package" verdict — per loader specifier and owning-tree
base URL *until restart*. The shop mounts from `<profile>/.dsh-shop/`,
not from the bundle layer's base, so a plausible reading was that a
hot-mounted package resolves to no package root there, gets cached as
"not a client package", and can then never appear without a restart —
which would have made "restart" the correct answer for every install and
this design unnecessary. It does not happen. Had this design been
written from the declarations instead of the probe, it would have
shipped the opposite rule.

**Amendment (2026-09-14): the hot-mount row above does not reproduce
through the shop's real install path, and the model changed because of
it.** Re-measured against the same dsh 0.1.5-rc.1 from
`web-full-flow.e2e.ts`, with one fixture and one variable — WHEN the
package reached disk:

| The package arrived | In the served `__DSH_BOOT__` |
|---|---|
| Before dsh booted (`dsh plugin add` in `beforeAll`) | **yes** — 55 entries, bundle URL `/plugins/??dsh-shop-e2e-client/client.js&rev=…` |
| After dsh booted, hot-mounted by the shop | **no** — graph byte-identical across a reload, same `rev`, while the host half is live |

Same fixture, same `dsh.client` declaration, same harness, same session
shape. The declaration is therefore valid and the difference is the
route: a package that was on disk at boot is in the composition the
registry enumerates, and one that arrives afterwards is not, however
successfully its host half hot-mounts.

That is the material difference from the probe above, and the reason the
falsification recorded there did not hold here. That probe's package was
"present in `node_modules`" — present when dsh booted. Every install the
shop actually performs downloads the package mid-session, which is the
case that was never measured.

**Consequence:** on the install and update paths a package with a browser
half now reports `restart`, not `reload`. Offering a reload there is the
same defect as the `live` claim it replaced — a step the reader is told
will work, which provably changes nothing — just one step cheaper.
Uninstall and enable/disable are unaffected: both move a row of the boot
composition, which is the half of this section that did reproduce.

**Side finding, not ours.** A `cordis.patch.yml` user layer containing
only an `insert` row does not apply: polled 25 s, `rev` unchanged. The
same insert applies immediately when a row targeting an existing entry
(`{ id, disabled: true }`) is written alongside it. This is upstream
behaviour in the harness's user-layer watcher. The shop never writes an
insert to the user layer — §8 forbids it, because the bundle layer would
mount the same rows again at the next boot — so nothing here depends on
it. Recorded so the next person measuring the user layer does not spend
the afternoon we spent.

## 2. What the model is

`activation` answers one question — *what does the reader have to do
before this change is visible?* — with three values:

| `hostLive` | `hasClientHalf` | `activation` | Meaning |
|---|---|---|---|
| false | — | `restart` | The host half is not running; only a boot composes it |
| true | true | `reload` | The server is already correct; this page is stale |
| true | false | `live` | Nothing to do |

**Three values, not two booleans.** A `needsRestart` plus a `needsReload`
would admit `true`/`true`, which is not a state the system can be in,
and every reader of the pair would have to re-derive the precedence.
One field with three values makes the impossible state unspellable.

**An unreadable `dsh.client` resolves to `true`.** If the installed
package's manifest cannot be read, the model assumes a client half and
offers the reload. Offering a reload that was not needed costs the
reader one keystroke; withholding one that was needed is the defect this
design exists to fix. The asymmetry is not close, so the fallback is not
a judgement call.

**`activation` is about visibility, never about correctness.** A `live`
verdict does not claim the plugin works, and a `reload` verdict does not
claim it will work after reloading. It reports what the harness needs in
order to *show* the change — nothing about whether the plugin itself is
sound, which is what §9's tiering and the harness-compatibility design
address.

## 3. Where each value comes from

The decision is pure: `activationOf({ hostLive, clientLive, hasClientHalf })`
in a new `src/host/activation.ts`, fixture-driven like every other policy
rule. All three inputs are gathered in the shell.

| Flow | `hostLive` | `clientLive` | `hasClientHalf` read |
|---|---|---|---|
| Install of a package this process never imported | the hot-mount result | **false** — a hot mount does not enter the registry's composition (§1 amendment) | after the files land |
| Update, or a reinstall of an imported package | **false**, and nothing is mounted — `already-loaded` (amended 2026-09-26) | not read | not read |
| Uninstall | whether the fiber actually went away | true — a boot-composition row | **before** the uninstall |
| Enable / disable | always true — the user layer is hot-reloaded | true — a boot-composition row | at the toggle |
| Shop self-update | always false | not read | not read |

**`hostLive` is measured, not assumed, on the uninstall path.** The hot
unmount, or a live-disable that leaves every owned fiber gone, is what
makes it true; an entry whose fiber outlives three disable attempts
leaves the plugin RUNNING, and "removed and stopped immediately" is then
a false statement about privilege rather than a cosmetic one.

**The install read was a union of both versions — retired 2026-09-26.**
`afterDone` runs once the new tarball has overwritten the manifest, so a
read there answers about the new version alone — and an update REMOVING a
browser half would have reported `live` while the open tab still ran the old
one's bundle. The union existed for that one case. An update no longer
mounts (next paragraph), so the only install that reads the browser half is
one with no previous version in the tab, and the read of the old version is
gone with the swap it served.

**An update never mounts (amended 2026-09-26).** Node caches a module by its
URL, a hoisted profile keeps every version of a package at one URL, and the
harness evicts nothing under `node_modules/` — so the swap's mount imported
the old module again and ran it under the new version's name, reported
`live` (measured in `web-full-flow.e2e.ts`; the chain is
`2026-09-26-market-borrowings.md` §1.1). An install of a package this process
may already have imported — any update, and a reinstall after an in-session
uninstall — therefore reports `restart` with the `already-loaded` reason and
leaves the running instance untouched. That is `hostLive: false` in the
table's sense: the host half the change describes is not running.

**A hot-mounted browser half cannot be reloaded into.** This is the §1
amendment's consequence, and it is where it lands in the model: the
install and update paths pass `clientLive: false`, so a package
declaring `dsh.client` resolves to `restart` there. It carries the
`client-half` reason, which is not a mount failure — the mount succeeded
and the host half is running — and exists so the reader is not told
"installed; restart dsh to activate" about a plugin they can already use.

**The uninstall read must precede the uninstall.** The package's
`package.json` is what declares `dsh.client`, and the uninstall deletes
it. This is the same ordering constraint the existing code already obeys
for `priorEntryIds`, and for the same reason; the new read belongs
beside it, not in `afterDone`.

**Self-update keeps `restart` unconditionally.** A host half cannot swap
itself live — the existing §8 ruling — so the shop's own update is the
one flow where the three-valued model collapses to one value by
construction, not by measurement.

**Reading `dsh.client` is a shell concern.** `hot.ts` already reads
`<profile>/node_modules/<name>/package.json` for `dsh.bundle.patch`
through its injected `HotFs`; the client-half read is a sibling on the
same seam, so tests never touch disk and exactly one production call
site does.

## 4. What the reader sees

`live` — the existing "running now" notice, no control.

`reload` — a notice saying the change is already live on the server and
this page is showing the state from before it, plus a **Reload** button
that calls `location.reload()`.

`restart` — unchanged: the localized hot-mount reason and the §8 restart
offer, or the §C-1 disabled notice naming why the host cannot restart —
Windows, a systemd unit without the override, or `--port 0` (amended
2026-09-14; it read "when a supervisor owns the process", which was one
of the three and the only one the copy named).

**The page is never reloaded without being asked.** A reload discards
whatever the reader was in the middle of — a conversation, a form, an
upload. The shop knows a reload would help; it does not know that now is
a good time, and that judgement belongs to the person whose work is on
the screen. This is the same reasoning that made the restart offer a
button behind a confirmation rather than an automatic consequence of
installing.

**The notice states the situation, not the mechanism.** A reader does
not need to know what `__DSH_BOOT__` is to understand "already applied;
reload to see it". The reason codes stay where they are — on `restart`,
where the reader genuinely has to choose between restarting and giving
up.

### 4.1 The receipt outlives the row (amended 2026-09-13)

An uninstall removes the thing the notice is attached to. The reader's own
row disappears from `installed()` within one RPC round-trip of the flow
reaching `done` — so a cue rendered inside that row is gone before it can
be read. This was shipped and had to be fixed three times, which is worth
recording once rather than rediscovering:

- **The card keeps a settled flow mounted.** `EntryCard` renders the
  uninstall panel while its flow is not `idle`, independently of whether
  the row is still installed. Without this the done view unmounts the
  instant the projection refreshes.
- **The Installed view keeps the entry matchable.** That guard only runs
  if the card renders at all, and the Installed category filter's
  membership test is the installed projection itself — so the same refresh
  dropped the entry out of the filter before the card's guard applied.
  Membership there is therefore "installed, OR its uninstall flow is still
  showing an outcome".
- **A kept row offers no Install.** Inside the Installed view the two rules
  above make `installed === undefined` mean exactly one thing — an
  uninstall that just settled — and that row must not offer to install the
  package whose removal it is reporting. §7.3's "management, not shelf"
  reading of that view is what this protects. Everywhere else the pairing
  is correct and deliberate: on the open shelf a just-removed entry is
  still browsable, and an Install button beside its receipt is the point.

**The count is not a contradiction.** The Installed button reads 0 while a
receipt is still on screen, and that is the honest pair: nothing is
installed, and the card is a receipt for the operation just performed, not
a listing. Making the count agree with the card would mean counting a
package that is gone.

**A receipt is sticky for the session.** Nothing resets an uninstall flow
back to `idle`; only a reload clears it — which is what the notice is
asking for. A reader who changes the filter instead sees the normal shelf
immediately.

## 5. Testing

**The gap that produced this design is a fixture gap.** All three of the
e2e's live packages — `dsh-shop-e2e-live`, `dsh-shop-e2e-config`,
`dsh-shop-e2e-peer` — declare `dsh.bundle` and none declares
`dsh.client`. The hot-mount e2e therefore proves the host half goes live
and asserts nothing whatsoever about the browser half, which is exactly
the blind spot both incidents came through. A fourth fixture declaring
`dsh.client` is part of this change, and the flow that installs it
asserts `activation === 'restart'`, the `client-half` copy, and the
restart activation's offer — with no reload offered.

The offer half is read from the host rather than assumed (amended
2026-09-14): `activation` is `restart` on every platform, but WHICH of
the two the client may show is the host's `restartBlocked`, so the flow
waits for the version check to resolve and then asserts the offer on a
host that can restart and that reason's own notice on one that cannot.
Asserting the POSIX outcome unconditionally is what left this case red
for ten seconds on Windows, on a host behaving exactly as designed.

That spec also carries the measurement the rule rests on, taken in the
browser rather than quoted from §1: it reads `window.__DSH_BOOT__`
before and after a reload following the hot mount, and pins that the
graph is byte-identical and the fixture absent from both, with the
boot-composed shop present as the control that keeps those two lines
from passing for the wrong reason. It is also the only thing in the
suite that loads the fixture's browser half at all; without it the
fixture's `client.js` and its `exports["./client"]` are executed by
nothing, and the suite asserts only what the shop SAID. If those lines
ever fail, the harness has begun composing hot mounts into the client
registry, and the install path can go back to `reload`.

`activationOf` is a three-row truth table and is tested as one.

The four flows are tested at the host boundary for which value they
report, including the ordering constraint: the browser half is read
while the package is still on disk, because `afterDone` runs once an
uninstall has deleted the manifest and once an update has overwritten
it.

The discriminating test is the HOST-ONLY uninstall, not the
client-declaring one. For a package that declares `dsh.client` both
orderings answer `reload` — an early read finds the declaration, a late
read finds nothing and the conservative fallback assumes one — so no
assertion on that case can tell the two apart, and a test written there
is not evidence about ordering however it is set up. The host-only case
separates them: read early it is `false` and reports `live`, read late
it hits the deleted manifest and reports `reload`. That test therefore
drives a fake `dsh` whose `remove` really deletes the manifest, and
asserts `live`. The client-declaring test stays, for the value it does
establish — that a browser half reaches `reload` at all.

The update path needed the opposite fixture, and had its own test: a
package whose OLD version declares `dsh.client` and whose new one does
not, which had to report `restart` because the open tab was running the
old bundle. One manifest on disk cannot express two versions, so that test
stated them through the `hotFs` read seam. It was retired on 2026-09-26
with the union read (§3): an update reports `already-loaded` whatever
either version declares. What replaced it is an e2e case with a fixture at
two versions, each activation recording the version held in its own module
scope — the one assertion able to tell which code ran, where the loader
inventory can only say that something runs.

## 6. The wire change

`ShopInstallStatusResult.needsRestart: boolean` becomes
`activation: 'live' | 'reload' | 'restart'`. `restartReason` stays, is
meaningful only under `restart`, and gains a `client-half` member — the
one value in that set which does not report a mount FAILURE: the mount
succeeded, and the browser half simply cannot be served without a
restart (§1 amendment). Amended 2026-09-26: it also gains `already-loaded`,
the other value that reports no failure — no mount was attempted, because
the process may already hold the package's module (§3). A client older
than that member renders its generic restart line for it, which is true,
merely less specific. `ShopSetEnabledResult` gains
`activation`; it currently returns `{ ok: true }` and the client renders
a hardcoded note, which is why enable/disable was wrong in a way no
amount of host-side correctness could have fixed.

**Replacing the field rather than adding one is safe here, and only
here.** Both halves ship in `dsh-plugin-shop` and the host serves the
client bundle out of its own installed package, so the two cannot be at
different versions. This is not the catalog, where an old client reads a
new artifact and additive-only is the law; it is an internal RPC between
two files in one package.

## 7. Deliberately not built

**Pushing the change to the browser.** The harness forwards only the
events in a hardcoded in-repository array, so an out-of-tree plugin
cannot push to the browser at all (§7). Even with a channel, see §4: the
reload is the reader's call.

**Reloading automatically after an install.** Same reason.

**Reporting `activation` for anything the shop did not do.** A plugin
that changes its own client bundle on disk, or a harness upgrade, also
leaves a page stale. The shop reports on the operations it performed;
inventing a general staleness monitor is a different feature with a
different failure mode, and this design does not open that door.

**Distinguishing "reload will help" from "reload is required".** Both
render as `reload`. The difference is not observable from the host, and
a reader who reloads unnecessarily loses nothing.
