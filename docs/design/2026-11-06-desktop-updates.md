# Desktop updates: dsh's own update operation, and the page that owns it

Date: 2026-11-06
Status: implemented on `fix/desktop-harness-detection` (with the running-harness
fix), unreleased.
Amends: [2026-10-19-dsh-021-readiness.md](2026-10-19-dsh-021-readiness.md) §2
(updates dsh refuses in place) and the self-update section of
[2026-08-18-dsh-plugin-shop-design.md](2026-08-18-dsh-plugin-shop-design.md) §7.3.

## 1. What failed, measured

On the DeepSeek Harness desktop app 0.2.2-rc.1, with 0.9.1 installed in
`~/.dsh/profiles/desktop`, every update offered by the shop failed. The
self-update's answer, from the app's own screenshot:

```
更新失败
via dsh's plugin manager: update dsh-plugin-shop@0.9.2
dsh-plugin-shop: dsh refused the update of dsh-plugin-shop (already-installed):
this version of dsh cannot update an installed package directly; uninstall it,
then install it again.
```

Two independent causes meet:

1. **dsh refuses an install in place.** From dsh-plugin-manager 0.2.1-alpha.3
   on, `installBundle` throws `already-installed` before pnpm runs when the
   `hmr` service exists and the spec names a package the profile already
   depends on. §2 of the 0.2.1 readiness design records that measurement, and
   the shop's answer at the time was the CLI continuation: `dsh plugin add`
   updates such a package as before.
2. **The desktop profile has no CLI continuation.** dsh's launcher refuses
   `--profile desktop` outright (`bin.js`'s `rejectElectronProfile`), and the
   one CLI entry allowed to manage it — `dsh-desktop-host/lib/cli.js`, through
   `runCli({ manageDesktopProfile: true })` — requires the app to be fully
   quit. So the shop's continuation was deliberately disabled on that profile,
   and the refusal reached the reader.

The consequence is wider than the shop's own update: **every update of an
installed plugin fails on the desktop profile** for the same reason. A fresh
install is unaffected, which is why the 2026-11-06 report about installs
looked isolated to the shop until the self-update was tried.

## 2. What dsh 0.2.2 offers instead

`@deepseek-ai/dsh-plugin-manager` 0.2.2-rc.1 exports a fifth operation on the
service, `updateBundle(name, version, { registry?, requestId? })`
(`lib/index.js:2468`), which is what dsh's own Plugins page calls
(`dsh-client-ui-plugin-manager/lib/client.js`'s `runUpdate`). Its sequence,
read from the shipped package and run by dsh itself:

1. `checking` — the installed bundle must be updatable, the target must be a
   valid semver **newer** than the installed one, the registry must answer
   `name@version`, and the manifest must declare `dsh.bundle` and pass dsh's
   own peer check.
2. `removing` — `removeBundle(name)`, which deselects and unloads the bundle
   and runs pnpm's remove.
3. `installing` — `installBundle(`${name}@${version}`, { saveExact: true })`,
   the same call the shop already uses, past the guard because the package
   was removed first.
4. `restoring` — when the install fails after the removal, dsh reinstalls
   `${name}@${from}` itself and records the attempt as `restore` in its
   answer.

The answer is `{ from, to, step, result, restore? }`, where `result` is the
same `ChangeResult` an `installBundle` call returns. dsh emits
`plugin-manager/update-state` for the steps and the nested install keeps
emitting `plugin-manager/install-log` under the caller's request id.

The operation is **registry-version shaped**: it builds `${name}@${version}`.
It cannot update a github entry, whose update installs a new commit spec — and
does not need to: the `already-installed` guard reads a spec through
`specPackageName`, which returns nothing for a `github:` spec, so a new commit
already passes it and the ordinary install path works (§2 of the 0.2.1
readiness design measured the same for a release-rescued tarball URL).

## 3. Decisions

### 3.1 Desktop npm plugin updates use `updateBundle`

In `install()`, an update whose catalog entry is `source: 'npm'` on the
desktop profile, with a manager that offers `updateBundle`, starts that
operation instead of `installBundle`. Every other shape is unchanged:

- **Desktop only.** Every other profile keeps the CLI continuation, which is
  measured and reaches the same result without unloading the plugin first.
  Moving those profiles onto `updateBundle` would be a behaviour change with
  no defect to close.
- **npm only**, for §2's reason.
- **Feature-detected.** `updateBundle` is optional on `PluginManagerLike`;
  through dsh 0.2.1 the manager has no update operation, and the desktop
  refusal stands as before.
- The record is the shop's ordinary `RunningInstall` (same queue, same
  request-id log routing, same status polling), so the client needs no new
  install UI. The mechanism line reads `update name@version`.
- `managerOutcome` reads the nested `result` exactly as it reads an
  `installBundle` answer. When dsh attempted a restore, the outcome's detail
  gains one sentence saying whether the old version came back — a reader on
  the failure detail alone otherwise cannot tell whether anything is
  installed.

### 3.2 The shop's own update is refused on desktop, and the client points at dsh's page

`updateStart` on the desktop profile returns
`{ ok: false, code: 'desktop-manual', detail }` and touches no manager
method. The alternative — `updateBundle('dsh-plugin-shop', version)` — was
rejected: its remove step disposes the very host that is executing the call.
The RPC would never answer, the install record would die with the host, and a
failure between remove and install would leave the profile without the shop
and without a surface to say so. dsh's own Plugins page is built for exactly
this: it runs outside the plugin being updated and survives its removal, which
is why the same `updateBundle` is safe there.

The client learns this from the host rather than guessing:
`shop/version` gains `selfUpdate: 'dsh-page' | null`. On `'dsh-page'` the
version row's Update button becomes **在插件页更新 / Update in Plugins**, which
selects dsh's own `plugins` panel through the layout service. A host older
than the field sends nothing, which the client reads as "update here", so the
client and host stay compatible in both directions.

## 4. Verification

- **Host tests** (`index.test.ts`): a desktop npm update calls
  `updateBundle(name, version, { requestId })` and reports `done`; a failed
  install names dsh's restore; a github desktop update still uses
  `installBundle`; a desktop self-update answers `code: 'desktop-manual'`
  without calling the manager, and its detail names no `dsh plugin` command;
  a desktop manager without `updateBundle` keeps the `already-installed`
  refusal; `version()` reports `selfUpdate: 'dsh-page'` on desktop and `null`
  on web.
- **Client tests** (`ShopTab.client.spec.tsx`): `selfUpdate: 'dsh-page'`
  renders the Plugins-page button instead of Update, carries the explanatory
  title, calls the injected move once, and never calls `updateStart`.
- **Live**, on an isolated desktop host against a copy of the real desktop
  profile: a plugin installed at an older version updates through the shop to
  the catalog's version (the host log shows the manager's remove/install), and
  the shop's own version row offers **在插件页更新**, which switches to dsh's
  Plugins page (whose detail offers 更新到 0.9.2).

## 5. What this does not do

- It does not make the shop update itself in-app on the desktop profile. That
  remains dsh's page's job by design, and the client says so.
- It does not migrate non-desktop profiles to `updateBundle`. Their CLI
  continuation is unchanged, including for the shop itself.
- It does not add a fallback for a desktop harness that predates
  `updateBundle`; the refusal is accurate there, and the self-update path
  still points at dsh's page.
