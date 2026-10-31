# dsh 0.2.1 readiness — design

Status: **designed 2026-10-19 on `fix/dsh-021-readiness`, not released.** It
changes how the host updates a package and when it restarts, so it ships
through `beta` first. It amends `2026-09-26-plugin-manager-delegation.md`
(sections 2, 4 and 7), `2026-09-26-dsh-017-readiness.md` (B1) and the static
restart blocks of `2026-08-18-dsh-plugin-shop-design.md` and
`2026-09-11-activation-model.md`. English only, per convention.

npm moved `latest` and `next` to dsh 0.2.1-rc.2 on 2026-10-17; `alpha` is
0.2.1-alpha.5. All 36 published versions carry a prerelease suffix.

## 1. What 0.2.1 changed under the shop

Measured on 2026-10-19 by diffing the installed 0.2.0-rc.2 and 0.2.1-rc.2
trees, and by running the shop on both in private prefixes.

- **Unchanged, or changed compatibly:** every slot the shop registers into
  (`sidebar.panellist`, `main`, `plugins.detail.actions`, `settings.section`,
  `settings.plugins.tab`), the layout service's `selectPanel`, the RPC
  transport, the CSS tokens the shop reads (the theme sheet is byte-identical),
  the welcome notice's version (`2026-09-28.1` in both), and dsh's verdict on
  the shop's own harness peers. The client module seed gains `zod` and
  `@tanstack/react-virtual`, which the shop does not import.
- **Measured working on 0.2.1-rc.2:** the 0.9.0-beta.1 hand check, 137 of 137
  in light en, light zh and dark; the 0.8.7 hand check, 91 of 91; the CLI
  upgrade from 0.8.7 to 0.9.0-beta.1, 8 of 8; no console error, warning or
  page error beyond the hand checks' own aborted `installStart`, the same as on
  0.2.0-rc.2.
- **Changed and breaking:** in-place updates, and a profile reconcile that now
  replaces a running plugin whose files changed on disk (section 2), the
  meaning of `--from-default-profile` (section 3) and the shape of a refusal
  (section 4). Settings moved (section 5), which breaks only the suite.
- **New and optional:** `plugins.add.actions`, one row per contribution in the
  Plugins page's Add-plugin menu, and `plugins.tab`, the optional plugin
  market's Discover tab. Neither is used here (section 6).

## 2. dsh refuses to update an installed package in place

**Measured.** dsh-plugin-manager 0.2.1-rc.2 throws `already-installed` from
`installBundle` before pnpm runs whenever the `hmr` service exists and the spec
names a package the profile already depends on (`lib/index.js:1989-1991`; the
code joins `ManagementError` in `types.d.ts`). `hmr` is enabled by the same
condition as the plugin manager itself, so every profile the shop reaches the
manager from has it. The manager offers no update or replace operation, and
dsh's own Plugins page updates a non-official plugin by removing it and
installing it again. The guard first appears in the published
dsh-plugin-manager 0.2.1-alpha.3 (`lib/index.js:1990`), and alpha.4 through
rc.2 carry the same line at `:1991`; no earlier version has it. The e2e
asserts the shop's continuation from 0.2.1-rc.1, inside that range. This was
read from the unpacked packages on 2026-10-19, not run.

Amended 2026-10-31: the range now extends through 0.2.1-rc.5, the version CI
runs the e2e against. Its dsh-plugin-manager is byte-identical to rc.2's (read
from the installed closures, not the source), so the guard carries at `:1991`
and the e2e's `gte(..., '0.2.1-rc.1')` gate still runs inside the range.

Which installed package a spec names is `specPackageName`'s answer
(`lib/index.js:1373`): the name of a registry spec (`name@version`) or of a
local directory. Any other spec, a `github:` one included, names an installed
package only when it equals that package's saved spec. So an update of a github
entry to a new commit passes this guard. It then goes on through
`installBundle`'s `publishAndReload` (`lib/index.js:2093-2094`), and so through
dsh-hmr's `reconcileProfile` (below), where 0.2.0-rc.2's `installBundle`
answered `restart-required` for an installed name (`lib/index.js:1801`).

**Measured 2026-10-20** for a release-rescued entry (a tarball URL, which the
guard reads the way it reads a `github:` spec), on 0.2.1-rc.2 with 0.2.0-rc.2
as the control: dsh answers `{"stage":"enable",…,"changed":true,
"application":"applied",…,"version":"2.0.0","warnings":[]}` — `applied`, no
`restartReason` — and the new code is live at once: the running 1.0.0 disposed
at +1.8 s and 2.0.0 applied at +2.0 s. The shop read that answer as a restart
with reason `already-loaded`, by `managerOutcome`'s rule for a name this
process imported, and told the reader to restart. That notice was false.

**Why the answer means what it means.** dsh-plugin-manager 0.2.1's `change`
starts a result at `applied`, and `reload` returns
`{ warnings, restartReason }` from `hmr.reconcileProfile`, whose reason is a
profile-wide `restartReason` or the first pending entry's; `change` then
rewrites `applied` to `restart-required` whenever it got one
(`lib/index.js:2373-2398`). So an `applied` answer from a harness whose
`hmr` has `reconcileProfile` says the reconcile left nothing pending: the
running plugin was replaced, or nothing was running to replace. 0.1.7 and
0.2.0 have the hmr service without that method (`reconcileProfilePatches`
only), and 0.1.5 has no hmr at all: there an `applied` answer still means the
module Node cached is the one running, which is the measured O1 of the
market-borrowings design.

**Decision (2026-10-20).** `OutcomeContext` gains
`reconcilesRunningPlugins`, read from the running harness's `hmr` service
(`typeof hmr.reconcileProfile === 'function'`), and `managerOutcome` keeps its
restart with reason `already-loaded` for an `applied` answer on a name this
process imported only when that is false. Where it is true the answer falls
through to the live/reload rule every other `applied` answer gets. The
capability is read, never the version. `overridden` keeps the restart: it
comes from `setPluginEnabled` and says a higher layer decides whether the
change runs, not that the new code is running.

**Still open.** The shop's own self-update passes the capability through
unchanged (`startManagerInstall`'s call reads whatever the harness has), and
on 0.2.1 it does not reach this path at all: the manager refuses it
`already-installed` and the record continues through the CLI, whose update of
`file:` specs leaves the shop unavailable until a restart (§2, below).

**Effect.** Every update of an npm entry from the shop's Updatable section, and
the shop's own self-update, failed on 0.2.1-rc.2 with "dsh refused the update
of `<name>` (already-installed).", in 0.8.7 and 0.9.0-beta.1 alike: their host
halves are identical. A self-update to a 9.9.9 served by a local registry
failed on 0.2.1-rc.2 and succeeded on 0.2.0-rc.2.

**The CLI has no such guard.** `dsh plugin --profile <p> add <spec>` over an
installed package rewrites it on 0.2.1-rc.2, as before: the upgrade from 0.8.7
to 0.9.0-beta.1 went through it. The shop runs the `dsh` its PATH finds on
POSIX, and on Windows, through node, the running dsh's own entry, or failing
that the first `@deepseek-ai/dsh` beside a PATH entry (`dshCommand` and
`resolveDshScript` in `src/host/dsh-cli.ts`). So on 0.2.1 an update the manager
refuses depends on that binary, where on 0.2.0 it ran in-process, through the
manager: a missing dsh fails with the CLI path's own detail, and a different
version on PATH is not detected.

**Until the next reconcile.** After such an update of a package the running dsh
imported at boot, the running dsh keeps the old code at first: the e2e's update
fixture stayed at one `1.0.0` activation for 20 s after a CLI update to 2.0.0
landed, on 0.2.1-rc.2 as on 0.2.0-rc.2. On 0.2.1 that lasts only until dsh
reconciles the profile. dsh-hmr 0.2.1-rc.2's `reconcileProfile`
(`lib/index.js:1307-1385`) replaces a running plugin whose loaded files changed
on disk (`planReplacement`, `:1214`; `stopPlanned`, `:1274`); only a changed
module whose importers reach dsh's own static graph, or one whose plugin no
Loader entry starts, stays loaded until a restart. dsh-plugin-manager
0.2.1-rc.2 runs it after each change it makes, through `reload`
(`lib/index.js:2360`): from `setPluginEnabled` (`:1936`), `setBundleEnabled`
(`:1952`), `installBundle` (`:2094`), `removeBundle` (`:2146`, `:2159`) and
`setVersionExemption` (`:1646`). A change to a watched patch file runs it too
(dsh-hmr `:849-873`), and a change to the profile manifest does only when
`dsh.profile.bundles` changed, so the CLI's update alone does not. 0.2.0-rc.2
has no such replacement: its dsh-hmr has only `reconcileProfilePatches`.
Measured 2026-10-19: the same fixture, CLI-updated to 2.0.0 while dsh ran,
stayed at 1.0.0 for 10 s and activated 2.0.0 within 5 s of a no-op comment
added to `profiles/web/cordis.patch.yml` on 0.2.1-rc.2; on 0.2.0-rc.2 the same
trigger left 1.0.0 running.

So the restart the shop reports for an update stays a correct instruction, but
the next reconcile in that session can make the new code live first: any
switch, install or uninstall, from the shop or from dsh's own Plugins page, or
a patch edit. The card's restart notice is then stale. dsh's guard fires
exactly where `hmr` exists, which is where this replacement runs: the
continuation recreates on disk the state the guard keeps the manager from
making.

**A shop installed from a `file:` spec.** On 0.2.1-rc.2 a shop whose saved
spec is `file:`, a local directory or a tarball alike, fared worse: after its
continued self-update and then a reconcile before the restart, every shop RPC
the page made answered `gateway/service-unavailable` (`active Service "shop"
is unavailable`), the page showed only the catalog-unreadable retry, and no
Restart was offered, which leaves restarting dsh by hand (that recovery was
not tried). A shop installed from the registry by name kept its old code and
its Restart offer (the same `bootId`, pending 9.9.9), while the same reconcile
replaced the e2e's update fixture beside it. The same trigger without the
update, and the same sequence on 0.2.0-rc.2, were fine. Measured 2026-10-19 by
the final review: install the shop, boot `dsh web`, continue its self-update
to a 9.9.9 served by a local registry, append a comment to
`profiles/web/cordis.patch.yml`, then read the shop's RPCs, with the e2e's
update fixture beside it showing that the reconcile ran. This project's checks
install the shop from `file:` specs: the self-update probe from a directory,
and the hand check from the pack's tarball, which dsh saves as
`file:…/dsh-plugin-shop-<version>.tgz`. The probe restarts straight after the
update and passes, and the hand check never self-updates, so a check that
reconciles between a self-update and its restart must not read this as a shop
regression.

**Decision.** An update — `installStart` for a name the profile holds — and a
self-update (`updateStart`) that dsh's plugin manager refuses with
`already-installed` continue through the CLI path, in the same install record:

- The record keeps its mechanism line and whatever dsh streamed, then adds one
  line naming the refusal and the command that runs next, exactly:

  ```
  dsh-plugin-shop: dsh's plugin manager updates no installed package in place (already-installed); running `dsh plugin --profile <profile> add <spec>` instead
  ```
- From then on its state, detail and activation are the CLI command's. An
  update of a plugin reports a restart with reason `already-loaded`, as the CLI
  path always has; the self-update reports a restart.
- The continuation is keyed on dsh's structured code, never on its version: a
  dsh that updates in place through its manager again keeps being used.

The decision stands with the reconcile above: without it no npm update, the
shop's own included, works on 0.2.1, and the restart it reports stays correct.
Remove-then-install stays rejected for the reasons below.

What it is not:

- **Not remove-then-install.** The plugin would be down between the two calls,
  `removeBundle` can refuse with `bundle-in-use`, and the shop cannot remove
  itself: removing its own bundle unloads the gateway that holds the record.
- **Not for a fresh install.** A name the shop did not see as installed but
  dsh refuses as `already-installed` fails with the sentence below: the shop
  and dsh then disagree about what the profile holds, and refusing is the safe
  side.
- **Not on the desktop profile.** dsh's CLI refuses that profile
  (`isDesktopProfile`), so the refusal stands, and reads as every
  `already-installed` refusal now reads: "this dsh updates no installed
  package in place: uninstall it, then install it again".

## 3. A restart could recreate the profile

**Measured.** From 0.2.1, `--from-default-profile <name>` replaces an existing
custom profile with a fresh copy of the shipped template on every launch: its
plugins, its user patch and its version exemptions are deleted (`dsh --help`:
"replace a custom profile with a fresh copy of a shipped profile template").
0.2.0 refused an existing profile instead ("profile … already exists …; omit
--from-default-profile to use it"). In throwaway homes, relaunching
`dsh rescue --from-default-profile web` over a `rescue` profile that held the
shop booted with no dependencies and with a line written into its user layer
gone on 0.2.1-rc.2. On 0.2.0-rc.2 it exited with that refusal and left the
profile intact.

**Effect.** The shop's in-page restart re-runs `process.argv.slice(2)`
verbatim. On 0.2.1, a Restart in a dsh launched that way deleted every plugin
installed in the profile, the shop included. On 0.2.0, the restarted dsh failed
to boot.

**Decision.** `from-default-profile` is a fifth static restart block, on every
harness: the shop refuses an in-page restart when its launch argv holds
`--from-default-profile` or `--from-default-profile=<name>`, and tells the
reader to restart dsh themselves without the flag. The flag is not stripped
from the restart's argv. The restarted process would then no longer run the
command the reader chose, and their next launch with the flag recreates the
profile anyway.

It is checked right after `desktop`, ahead of `windows`, `systemd` and
`port-zero`. It has no override, so naming the overridable `systemd` reason
first would send the reader to `allowRestart: true` and still refuse them.
And every later reason's remedy is a manual restart, which a reader launched
with the flag would run with it, so this reason's copy is the one they need.
`desktop` stays first: dsh refuses to launch that profile from its CLI at all.

## 4. A refusal lost its list

**Measured.** app-boot 0.2.1's `evaluatePluginCompatibility` returns
`requirements` where 0.1.7 to 0.2.0 returned `peers`
(`lib/types/plugin-compatibility.d.ts`), and dsh-plugin-manager's
`IncompatiblePlugin` does the same. Each key is a dsh peer's name, or
`engines.dsh`. The shop read `peers`, so on 0.2.1-rc.2 a refused card read
"本机的 dsh 0.2.1-rc.2 会拒绝安装此插件：它要求 。" and a refusal through
the manager read "declares ,". The verdict itself, the refused label and the
allow-version command were unaffected.

**Decision.**

- Both adapters, `peerCheckOf` (`src/host/harness.ts`) for the prediction and
  `incompatibleList` (`src/host/plugin-manager.ts`) for an install's answer,
  read `requirements` when it is present and `peers` otherwise. Either way it
  lands in the shop's own `peers` field. Every consumer stays as it is.
- The card writes the `engines.dsh` key as `dsh <range>`.
- The detail of a refusal through the manager keeps dsh's key verbatim
  ("declares engines.dsh >=0.3.0"), because it names what the package
  declares.

**A known gap, not fixed here.** 0.2.1 lets `engines.dsh` decide alone when a
manifest declares one, and reads `engines` with `pnpm view` before an install.
The catalog carries no `engines`, so the prediction judges peers only.

On a seeded sample of 300 of the catalog's 7,217 npm entries (latest
versions, 2026-10-19):
- 46 declare `engines.dsh`;
- dsh 0.2.1-rc.2 refuses 62, and the prediction refuses 62;
- they disagree on 2: one false refusal and one missed one.

Closing the gap needs the catalog to carry `engines.dsh`, which means the
registry's harvest and its schema. That is its own change.

## 5. Settings moved into the Account menu

From 0.2.1-rc.1, the sidebar foot's button is the Account menu: its
accessible name is `账号菜单` / "Account menu", and its text is 更多 / More.
Settings is the first item of the menu it opens (设置 / Settings), followed by
意见反馈 / Feedback and 登录 / Sign in. 0.2.1-alpha.1 still shows a Settings
button there. The dialog keeps its name. This was measured on 0.2.1-rc.1 and
0.2.1-rc.2.

The shop never opens Settings itself, but every check that does timed out on
0.2.1-rc.2:
- 7 of the e2e's 11 cases: two directly, and the rest through the state that
  the failed cases left in the page store;
- the hand checks.

The e2e now reaches Settings through the Account menu from 0.2.1-rc.1
(`settingsEntry`, `openSettings`). `plugin.yml` gains a 0.2.1-rc.2 leg on both
operating systems, and the e2e's harness header names it, as
`repo-guards.test.ts` requires.

Amended 2026-10-31: the leg and the harness header now name 0.2.1-rc.5, npm's
`latest` since 2026-10-30; rc.2 was superseded inside the same 0.2.1 line and
is no longer a leg. The two closures' shop contracts were byte-identical, and
the whole package suite (e2e included) ran on rc.5 before the pin moved.

On 0.2.1, 0.8.7's documented path "Settings → Plugin shop" now starts from the
Account menu. The README moves at the 0.9.0 promotion, when the shop becomes a
sidebar page.

## 6. Not in this change

- `engines.dsh` in the catalog (section 4).
- `plugins.add.actions` and `plugins.tab` (section 1).
- The `--port=0` spelling of `--port 0` is not detected as `port-zero`. This
  predates 0.2.1.
- No release. The beta's version number is confirmed when it is cut.
