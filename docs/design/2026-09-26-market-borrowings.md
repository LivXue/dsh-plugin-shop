# Market borrowings, second review — design

Status: **batch 1 decided and implemented (2026-09-26): §1–§4**, one commit
per section on `fix/borrowings-batch-1`. A second review of three
dsh plugin markets — [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)
(reviewed once before, `2026-08-31-market-borrowings.md`),
[bradeGithub/DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace)
and [2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) — produced
twenty-four candidate items. The first batch is four defects of ours that the
comparison exposed: an update that reports `live` while the old code runs
(§1), a toggle that erases the user's own patch rows (§2), a restart monitor
that reloads into a boot that is about to die (§3), and a tab that one render
error blanks with no way back (§4). The other twenty are listed in §6,
undecided. The specs these change are amended in the same change:
`2026-09-11-activation-model.md` (§3, §6), `2026-08-31-hub-borrowings.md`
(§B) and `2026-08-18-dsh-plugin-shop-design.md` (§8). English only, per
convention.

A competitor citation below says where an idea came from; it is never the
evidence. Every claim rests on this repository, on the pinned harness
(`@deepseek-ai/dsh@0.1.5-rc.3`), or on a measurement taken here.

## 1. An update never hot-swaps a package this process has imported

### 1.1 The defect

The update path brought the old version's live entries down
(`liveEntriesDown`) and hot-mounted the new version under `mkt-` ids,
reporting `live` for a package with no browser half. What then ran was the
OLD code.

**Measured 2026-09-26** in `web-full-flow.e2e.ts` against dsh 0.1.5-rc.3,
with a fixture whose every activation appends the version string held in its
own module scope: `dsh-shop-e2e-update@1.0.0` installed before dsh boots, the
catalog offering 2.0.0, the update driven through the real UI. Afterwards the
package's `package.json` on disk read 2.0.0, and the update had caused
exactly one activation, which reported `1.0.0`.

The chain, each link read in the pinned harness:

1. A profile installs with `nodeLinker: hoisted`
   (`dsh-app-boot/lib/index.js:368`), so every version of a package lives at
   `<profile>/node_modules/<name>/` — one file URL.
2. The hot tree is `@deepseek-ai/cordis-plugin-include`'s `Include`, whose
   `import()` calls `loader.internal.import(...)`
   (`cordis-plugin-loader/lib/index.js:270-283`), and `loader.internal` is
   Node's own ESM `ModuleLoader` (`ModuleLoader.fromInternal()`, `:672`),
   whose module map is keyed by URL.
3. The one thing in the harness that evicts entries from that map is
   `cordis-plugin-hmr`, and it skips every URL containing `/node_modules/`
   (`cordis-plugin-hmr/lib/index.js:51`, `:286`).

So a second import of the package's URL returns the module the boot imported,
whatever the files under it now say. The hot-mount e2e case never saw this:
it reads liveness from the loader inventory, which proves that an entry runs,
not whose code it runs.

Idea source: dsh-market measured the same thing ("2.0.0 on disk, 1.0.0
answering", issue #491) and has reported every package replacement as
needing a restart since #685 (`src/verify.ts`, `activationAfterReplace`).

### 1.2 The rule

An install of a package this process may already have imported reports
`activation: 'restart'` with the reason code `already-loaded`, and the shop
leaves the running instance alone: no live disable, no hot mount. The files
on disk are the new version, and the next boot imports them.

"May already have imported" is the union of two facts:

- **The profile manifest already holds the name** — every update. Whatever
  version is installed was composed at boot or has been mounted since.
- **The name is in a process-lifetime set** held at module scope in the
  gateway, so it outlives a gateway reconstructed in the same process. It is
  seeded at construction with every dependency of the profile manifest (the
  boot composition this process started from) and extended with every name
  the hot path mounts. Names are never removed: an uninstall disposes the
  fiber, not the module record. This is what catches an uninstall followed
  by a reinstall in the same session, which the manifest alone cannot.

So an update reports `already-loaded`; an uninstall and reinstall in one
session reports `already-loaded`; a fresh install of a name this process has
never seen hot-mounts as before.

The rule over-approximates on purpose. A package installed but disabled at
boot was probably never imported, and one added after boot by another route
(a terminal `dsh plugin add`) certainly was not, yet both are treated as
imported and cost a restart that was not strictly needed. The asymmetry is
the activation model's (§2 there): a step offered without need costs the
reader one action; a step withheld when needed is the defect this fixes.

**Leaving the old instance alone fixes a second defect.** The swap disabled
the boot entry and mounted the new rows under a `mkt-` id that the user layer
does not name, so updating a plugin the user had DISABLED brought it up,
until the next boot applied the user's row again. With no swap there is
nothing to bring it up.

**The code this retires.** With no update ever mounting, the install path's
reads of the OLD version — its entry ids for the live disable, and its
browser half for the activation union (activation model §3) — have no
caller. They are removed rather than left as a branch nothing reaches; the
uninstall path keeps its own copies of both reads.

### 1.3 Not built

- **A cache-busting re-import** (a query-suffixed URL). The import is the
  harness's `Include.import`, not the shop's, and the package's own imports
  would still resolve to cached URLs: half-new code is worse than old code.
- **Reporting which version is running.** "Restart to load it" is the
  honest instruction; a running-version probe is a different feature.

## 2. The toggle edits one key and nothing else

### 2.1 The defect

`setUserLayerRows` (`host/profile.ts`) read the user layer with the
harness's parser, dropped every row whose id it was toggling, appended
`{ id, disabled: true }` on a disable, and dumped the whole list back with
`js-yaml`. That loses two things:

- **The user's own row for that entry.** A `- id: X` row carrying a
  `config:` override — the thing the file exists for — was deleted by a
  disable and not restored by the enable after it.
- **Every comment in the file.** That includes the header dsh writes at
  profile init ("Your patch layer for this dsh profile … id-targeted config
  overrides, disables, and insert lists"), because `js-yaml` models no
  comments.

`hub-borrowings.md` §B chose the whole-file rewrite deliberately: "the
framework parser is the authority on the file's shape … editing through it
beats hand-rolled text surgery". That reasoning holds for READING. The parser
cannot WRITE the file back without loss.

### 2.2 The rule

The file is still validated by the harness's own parser first
(`loadOptionalPatches`): a malformed layer still throws, and `setEnabled`
still turns the throw into a detail. It is then edited as a document with
`yaml` (eemeli/yaml). That is already a direct dependency of this
repository's registry, and the harness's own plugin manager uses it to edit
the same file from 0.1.7 onwards (`@deepseek-ai/dsh-plugin-manager`,
`writePluginEnabled`). For each entry id being toggled:

- **The target** is the LAST row that `applyEntryPatches` would apply to that
  entry: a mapping with that `id`, no `insert`, and a `name` that is absent or
  equal to the entry's module name. A mismatched `name` makes the harness
  skip the row, so writing to it would change nothing.
- **If there is a target**, its `disabled` key is set to `!enabled` — added if
  absent — and nothing else in the row changes. If there is none,
  `{ id, disabled: !enabled }` is appended.
- **Nothing else changes**: other rows, other keys, comments, `!!js` scalars,
  quoting.

Why the last row: `applyEntryPatches` applies rows in order and each override
key REPLACES the target's value, so the last row that sets `disabled` is the
one that decides.

**An enable now writes `disabled: false` instead of removing the row.** The
old rule, "an enable drops it again so the bundle default rules", was a
whole-row deletion, and deletion is exactly what loses a user's row or the
comment attached to it. `yaml` attaches a leading comment to the node below
it, so deleting the first row of a file deletes the file's header. Writing a
key never deletes a node. It is also the harness's own convention for this
file from 0.1.7, so the two writers agree, and it enables an entry whose
bundle ships it disabled, which removing an override never could. The cost is
one `disabled: false` row left per toggled entry, reused on every later
toggle.

Two details of the write:

- **An empty flow sequence** (`[]`, the body of the template dsh writes) is
  turned into a block sequence before the first append, so the file stays one
  row per line.
- **The file keeps its permission bits** across the atomic rename, and a new
  file is created 0600, as the harness's writer does. A user layer can hold a
  credential in a `config:` override, and a rewrite must not widen who can
  read it.

### 2.3 Deferred

dsh 0.1.7's plugin page can switch a plugin off by taking it out of
`dsh.profile.bundles`, and `installed()` does not read `bundles`, so a plugin
switched off that way would show as enabled here. That belongs to the 0.1.7
hand-off (§6, B2), not to this fix: on the pinned 0.1.5-rc.3 nothing writes
`bundles` that way.

## 3. A restart is trusted only once the new server keeps answering

### 3.1 The defect

The restart monitor (`RestartPanel` in `client/ShopTab.tsx`) polled the origin
after a 3 s grace and reloaded the page on the first `fetch` that RESOLVED,
whatever its HTTP status. A boot that is about to fail can answer. The Loader
mounts entries concurrently, so the webserver entry can bind the port and
serve while a sibling plugin is still loading, and `assertEntriesActivated`
audits the settled tree only afterwards, failing the boot
(`dsh-app-boot/lib/index.js`, `assertEntriesActivated` and
`installFailLoud`). The page then reloads into a process that is gone a
moment later. The reader gets a blank tab instead of the notice that says
where the reboot's log is.

That is the incident already on record for 2026-09-15: a third-party plugin
importing an export the harness did not have killed the reboot while it
loaded the plugin tree, and the reader got a blank page.

Idea source: dsh-market found the same bind-then-die window and waits for
about 8 s of consecutive answers (commit 2c55981, `src/restart.ts`).

### 3.2 The rule

- **What counts as up.** A probe counts only when its response is `ok`
  (2xx). A refused connection, a network error and a 5xx are all "not up".
- **When to reload.** The page reloads once probes have succeeded
  CONTINUOUSLY for `RESTART_STABLE_MS` (8 s). Any failed probe resets the
  run.
- **When to give up.** The monitor fails when no successful run has begun by
  `RESTART_WAIT_MS` (30 s, unchanged), or when a run that began could not
  complete by `RESTART_WAIT_MS + RESTART_STABLE_MS`.
- **Probes never overlap.** Each starts one poll interval after the previous
  one settled.
- **The failure notice names the log file.** `shop/restart` now returns the
  path it wrote (`{ ok: true, logFile }`), because that path depends on
  `DSH_HOME` and on the shop row's `cacheDir`, which only the host knows. A
  host older than this change answers without it, and the notice keeps its
  generic wording.

The decision is a pure function in `present.ts`, from the probe history to
`wait`, `reload` or `failed`, so a fixture table drives every case.

Every successful restart now reloads 8 s later than before. That is the price
of never landing a reader on a dying boot, and the notice says a restart is in
progress the whole time.

## 4. A render error leaves a message and a way back

### 4.1 The defect

The shop has no error boundary of its own. Searching `src/` for
`ErrorBoundary|componentDidCatch|getDerivedStateFromError` finds nothing,
while the same search form finds 16 `useMemo` in `ShopTab.tsx`. The
harness's `SlotErrorBoundary` (`dsh-client-ui-renderer/lib/client.js`)
catches a crashing slot entry and renders `<div data-slot-error>`: empty, and
permanent until the page reloads. One render error therefore leaves the shop
tab blank, with no message and no retry.

One known trigger is outside our code. A browser's page translation (Chrome,
Edge) rewrites the text nodes React owns, and React's next commit throws on
the nodes it no longer finds (dsh-market issue #513, fixed there with
`translate="no"`). A derived catalog summary has no Chinese text, so the
reader most likely to switch translation on is exactly the one reading
English summaries in a Chinese UI.

### 4.2 The rule

- **The tab's root carries `translate="no"` and the `notranslate` class**, in
  each of its three states (loading, error, loaded). The shop renders no
  portals, so the root covers everything it draws.
- **The registered slot component is the tab inside a shop-owned error
  boundary.** On a render error the boundary logs the error with its
  component stack, then renders, inside the same kind of root, a localized
  line saying the tab hit an error, the error's own message, and a Retry
  button that remounts the tab from scratch. The fallback deliberately does
  not carry `data-shop-tab`, so a crashed tab can never satisfy a wait for a
  working one.

### 4.3 Not built

A "copy diagnostics" button. The message is plain, selectable text, and a
clipboard write needs a permission path that the message does not.

## 5. Testing

- **§1**: the e2e case above: the fixture, the module-scope measurement, and
  the restart copy and offer. At the host boundary, an update reports
  `already-loaded` without a live disable or a mount; an uninstall followed by
  a reinstall does too; a name present at construction is treated as
  imported; a fresh install still mounts and reports `live`, or `reload`
  for a package with a browser half (a `client-half` restart until
  `2026-09-26-dsh-017-readiness.md` §B0.3 reversed it).
- **§2**: a config row keeps its config through a disable and an enable;
  comments survive, the template header included; the last matching row is
  the one written; a row with a mismatched `name` is not a target; a new row
  is appended when none matches; the template's `[]` becomes a block
  sequence; permission bits survive; the existing `!!js` round trip still
  holds.
- **§3**: the pure verdict as a table. At the component, one answer followed
  by a refusal never reloads; 8 s of answers reloads exactly once; a 5xx never
  counts; the failure notice names the host's log path.
- **§4**: the boundary renders its fallback on a throw, and Retry remounts;
  each root state carries `translate="no"`; the client registers the wrapped
  component.

## 6. The other twenty

Recorded so the next batch starts from the list rather than from the
competitors again. None of these is decided.

| Item | What | Nature |
|---|---|---|
| A2 | npm packages that are deprecated or unpublished drop out of the keyword search and vanish from the catalog with no report row | harvest |
| A3 | a share of commit-pinned GitHub entries ship a `main` that only a `build` script produces, so they install and then fail to load | gate |
| B1 | dsh 0.1.7 checks every `@deepseek-ai/dsh*` peer's declared range at activation | 0.1.7 readiness |
| B2 | dsh 0.1.7 ships its own `pluginManager` service; hand installs to it where present | 0.1.7 readiness |
| B3 | the Desktop app's `desktop` profile refuses the CLI the shop spawns | 0.1.7 readiness |
| B4 | `dsh.bundle.patch` may be an array from 0.1.7 | 0.1.7 readiness |
| C1 | a newest / recently-updated sort (`added`, `publishedAt` are in every entry and unread) | client |
| C2 | a Chinese-to-English query dictionary for search, matched on word boundaries | client |
| C4 | `windowsHide`, `GIT_TERMINAL_PROMPT=0` and ssh `BatchMode` on spawned installs | host |
| C5 | archived GitHub repositories | gate |
| C6 | npm packages with install scripts | gate / client |
| C7 | classify pnpm's out-of-memory failure | host |
| C8 | a label saying where a displayed version came from | client |
| C9 | debounce the search box | client |
| C10 | a GitHub install stranded when an npm package shadows the name | host |
| C11 | a prefilled failure-report link | client |
| C12 | an author-doc section on "listed, but it will not load" | docs |
| C13 | a mutation-test gate for the pure core | tests |
| C14 | a left-rail panel entry (`panellist.id` must equal `main.key`) | client |
| C15 | static per-plugin pages | catalog |
