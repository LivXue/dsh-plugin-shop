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
- **Changed and breaking:** in-place updates (section 2), the meaning of
  `--from-default-profile` (section 3) and the shape of a refusal (section 4).
  Settings moved (section 5), which breaks only the suite.
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
installing it again.

**Effect.** Every update from the shop's Updatable section, and the shop's own
self-update, failed on 0.2.1-rc.2 with "dsh refused the update of `<name>`
(already-installed).", in 0.8.7 and 0.9.0-beta.1 alike: their host halves are
identical. A self-update to a 9.9.9 served by a local registry failed on
0.2.1-rc.2 and succeeded on 0.2.0-rc.2.

**The CLI has no such guard.** `dsh plugin --profile <p> add <spec>` over an
installed package rewrites it on 0.2.1-rc.2, as before: the upgrade from 0.8.7
to 0.9.0-beta.1 went through it. After such an update of a package the running
dsh imported at boot, the running dsh keeps the old code until it restarts, on
0.2.1-rc.2 exactly as on 0.2.0-rc.2: the e2e's update fixture stayed at one
`1.0.0` activation for 20 s after a CLI update to 2.0.0 landed. So the restart
the shop reports for an update remains true.

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

What it is not:

- **Not remove-then-install.** The plugin would be down between the two calls,
  `removeBundle` can refuse with `bundle-in-use`, and the shop cannot remove
  itself: removing its own bundle unloads the gateway that holds the record.
- **Not for a fresh install.** A name the shop did not see as installed but
  dsh refuses as `already-installed` fails with the sentence below. The CLI
  path's hot mount assumes a name this process never imported, and here it may
  have.
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

On 0.2.1, 0.8.7's documented path "Settings → Plugin shop" now starts from the
Account menu. The README moves at the 0.9.0 promotion, when the shop becomes a
sidebar page.

## 6. Not in this change

- `engines.dsh` in the catalog (section 4).
- `plugins.add.actions` and `plugins.tab` (section 1).
- The `--port=0` spelling of `--port 0` is not detected as `port-zero`. This
  predates 0.2.1.
- No release. The beta's version number is confirmed when it is cut.
