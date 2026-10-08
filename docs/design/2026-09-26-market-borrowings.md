# Market borrowings, second review — design

Status: **batch 1 decided and implemented (2026-09-26): §1–§4**, one commit
per section on `fix/borrowings-batch-1`. **C7 decided and implemented
2026-09-27: §7.** **Batch 2, A2 and A3, decided 2026-10-07 and built on
`feat/borrowings-batch-2`: §8–§10.** A second review of three
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

**Resolved 2026-09-27.** Measured on 0.1.7-rc.2: `setBundleEnabled(name,
false)` takes the package out of `dsh.profile.bundles` and keeps it
installed, and `pluginInventory` then holds no entry for it at all. So
"nothing live" cannot tell a deselected bundle from one not composed until a
restart, and the selection has to be read on its own.

- `installed()` reads it through `runningProfileBundles`. A package missing
  from the list is disabled whatever the inventory says, and an unreadable
  list decides nothing.
- `setEnabled` on a deselected package:
  - Off writes the plugin-level rows, since nothing of it runs.
  - On selects the bundle through dsh's own `pluginManager.setBundleEnabled`,
    the writer behind the switch that deselected it, then clears the
    plugin-level rows. `restart-required` becomes a restart, and a refusal
    comes back as a detail with nothing written.
  - Without that service, the detail names the list and the way back instead
    of the restart it used to advise. It does not print
    `dsh plugin add <name>`: that selects the bundle again on 0.1.5-rc.3 and
    does not on 0.1.7-rc.2 (measured the same day), and it lets pnpm float a
    registry package to `latest`.

Switching off stays per plugin, for the reasons of section 2.2 and because a bundle
switched back on is appended to the end of the list, which moves its
configuration precedence. The broader hand-off to the service is
[2026-09-26-plugin-manager-delegation.md](2026-09-26-plugin-manager-delegation.md).

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

**Follow-up (2026-09-27).** These rules are unchanged, but the monitor no
longer lives in `RestartPanel`: a self-update rewrites the shop's own client
bundle, dsh's client HMR swaps the tab out, and the swap's unmount stopped the
monitor before the restart finished. It now belongs to the page
(`client/restart-monitor.ts`; design §8, both 2026-09-27 amendments).

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
competitors again. None of these is decided unless its row says so.

| Item | What | Nature |
|---|---|---|
| A2 | npm packages that are deprecated or unpublished drop out of the keyword search and vanish from the catalog with no report row: **decided 2026-10-07, §8** | harvest |
| A3 | a share of commit-pinned GitHub entries ship a `main` that only a `build` script produces, so they install and then fail to load: **decided 2026-10-07, §9** | gate |
| B1 | dsh 0.1.7 checks every `@deepseek-ai/dsh*` peer's declared range at activation | 0.1.7 readiness |
| B2 | dsh 0.1.7 ships its own `pluginManager` service; hand installs to it where present | 0.1.7 readiness |
| B3 | the Desktop app's `desktop` profile refuses the CLI the shop spawns | 0.1.7 readiness |
| B4 | `dsh.bundle.patch` may be an array from 0.1.7 | 0.1.7 readiness |
| C1 | a newest / recently-updated sort (`added`, `publishedAt` are in every entry and unread) | client |
| C2 | a Chinese-to-English query dictionary for search, matched on word boundaries | client |
| C4 | `windowsHide`, `GIT_TERMINAL_PROMPT=0` and ssh `BatchMode` on spawned installs | host |
| C5 | archived GitHub repositories | gate |
| C6 | npm packages with install scripts | gate / client |
| C7 | classify pnpm's out-of-memory failure: **decided and implemented, §7** | host |
| C8 | a label saying where a displayed version came from | client |
| C9 | debounce the search box | client |
| C10 | a GitHub install stranded when an npm package shadows the name | host |
| C11 | a prefilled failure-report link | client |
| C12 | an author-doc section on "listed, but it will not load" | docs |
| C13 | a mutation-test gate for the pure core | tests |
| C14 | a left-rail panel entry (`panellist.id` must equal `main.key`) | client |
| C15 | static per-plugin pages | catalog |

## 7. C7: pnpm 12 aborting out of memory

Decided and implemented 2026-09-27.

### 7.1 The defect

pnpm 12's native binary can abort while it checks peers. It prints
`memory allocation of <N> bytes failed` and Rust's backtrace note, and on
Windows exits 3221226505 (0xC0000409). The cause is pnpm/pnpm#15362: the peer
check intersected the ranges of a missing peer, and the intersection doubled
for every package that wanted it. dsh writes `autoInstallPeers: false` into
every profile's `pnpm-workspace.yaml` (dsh-app-boot, 0.1.5-rc.3 and 0.1.7-rc.2
alike), so every `@deepseek-ai/dsh*` peer stays missing and plugins that share
one trip it. pnpm fixed it in 12.7.0, released 2026-09-25 under `next-12`.
npm's `latest` was still 12.6.0, from before the fix, when this was written.

`installFailureDetail` found no `ERR_` line and no thrown error in such a log,
so it reported the last line that survived its noise filter: the backtrace
note on 0.1.5, and dsh's `plugin command failed; diagnostics: <path>` on
0.1.7. Both came with the usual hint to run `dsh plugin install`, which aborts
again on the same profile.

### 7.2 Reproduction

On 2026-09-27, through the real CLI of dsh 0.1.5-rc.3 and of 0.1.7-rc.2, with
pnpm 12.6.0 capped at 8 GiB of address space (the reporter's machine size):
adding forty local packages that each want `oom-missing-peer` with their own
overlapping range, `>=1.0.<i> || ^1.<i>.0`, aborted on both harnesses with
`memory allocation of 671088640 bytes failed`. Forty packages sharing one
identical range did not abort, and neither did a profile holding only the
shop: pnpm collapses identical ranges, and a small profile never doubles far
enough. That is why dsh-market could not reproduce it on macOS, and why most
people on 12.6.0 will not see it.

### 7.3 The rule

A log line that is exactly Rust's allocation-abort message replaces the
detail. The rule runs after dsh's own refusal and before the picker, which
prefers any `ERR_` line: an abort ends the run wherever it lands, so a code
printed before it did not decide the outcome. The detail quotes the line,
says the plugin did not cause it, names the known bug and the release that
fixes it, and gives the way out: pnpm 12.7.0 or later, or pnpm 11. It also
says what to do when the reader's pnpm already has the fix, because
pnpm/pnpm#15867 aborts in the same words for a different reason. The recovery
hint is dropped, and nothing retries: the same install aborts again.

The pattern is anchored at both ends. V8's own heap exhaustion, "Allocation
failed - JavaScript heap out of memory", comes from pnpm 11 or from dsh
itself, and the pnpm 12 remedy would be wrong for it.

dsh 0.1.7's own classifier has the same gap: `classifyInstallFailure` files
this abort as `unknown`, so its Plugins page shows the raw failure too.
Remaining-work U5 records the upstream change.

### 7.4 Testing

Both captured logs, V8's heap exhaustion as the negative, and a constructed
log with an `ERR_` line before the abort. Four mutations were each caught by
at least one case: a loose pattern, the rule yielding to an `ERR_` line, the
rule never consulted, and the recovery hint kept.

## 8. A2: a listed npm package that leaves the harvest is accounted for

Decided and built 2026-10-07.

### 8.1 The defect

npm search returns no deprecated package, and its `total` counts none
(`isDeprecated`, `feed-state.ts:110`, is shared by the feed and the
packument reader for that reason). A listed package that its author
deprecates is therefore never harvested again, and the gate's rule for it
(`gate.ts:268`, "Marked deprecated on npm.") never receives it: the report
built 2026-10-06T17:06Z holds 16,025 rejections and not one `deprecated`
row. An unpublished package, one npm removed, and one whose latest version
lists neither harvest keyword leave the harvest the same way. Nothing in the
build compares one catalog with the next, so each of them leaves the shelf
with no row anywhere, which CLAUDE.md's "Failing loudly" forbids by name.
The GitHub half already does this for repositories: `diffRepoState` names
every recorded repository the topic search stopped returning, and the build
publishes it once as `repo-gone` (`build.ts:300`).

Measured 2026-10-07 over the 27 daily `manifest.lock` snapshots on `main`
from 2026-09-05 to 2026-10-06 (no build committed one on 09-12, 09-13 and
09-30 to 10-02). An npm name sat in one snapshot and not the next 174 times.
37 of those names came back later. Of the 137 still absent on 2026-10-06, 13
carry a gate row in that day's report, and **124 left with no row**. Their
state on npm, read 2026-10-07:

| State | Names |
|---|---|
| Latest version deprecated | 70 |
| Unpublished: npm's stub | 27 |
| No longer on the registry: 404 | 21 |
| Latest version lists neither harvest keyword | 6 |
| Latest version still lists a keyword, not deprecated | 0 |

A keyword match finds a named successor in 37 of the 70 deprecation
messages ("Renamed to @leaf233/dsh-model-gateway", "Folded into
@moguiyu/dsh-tavily 0.3.0"), and 13 of them are npm Support's own "Package
no longer supported. Contact Support at https://www.npmjs.com/support for
more info.".

The 37 that came back are the other half of the defect. 29 of them still
qualified by the change feed's membership rule on the day they left, and 23
of those had published nothing new: only the harvest can have dropped them.
`dsh-agnes-studio` is missing from every catalog built from 2026-09-22 to
2026-10-03. A missing package costs more than a shelf slot. The host's
`installed()` reports only names that have a catalog row, so every reader
who installed it loses its card, and with the card its switch, its update
and its uninstall.

The change feed (`2026-10-04-change-feed-harvest.md`), merged 2026-10-06,
credits most of what search drops. On that day's build it supplied 34 and 36
names, `keywords:dsh-plugin` ended 2 short of its total, and no qualifying
package left. It cannot reach a name its pattern does not select, a name its
verification leaves unconfirmed or disagreeing, or anything on a run where
the feed is unavailable.

### 8.2 The rule

**Who left.** `L` is the set of npm names in the last published catalog:
the committed `registry/snapshots/manifest.lock` (`build.ts:459` writes it,
and the daily workflow commits it), read before this build overwrites it. A
pure reader beside its writer (`emit.ts:316`) takes the npm lines, `name
version integrity`, and skips the github ones, `owner/slug name version`.
`H` is every name this run's npm harvest produced: the candidates it
fetched, and the names whose fetch became a `fetch-failed` row. The departed
names are `L − H`, in code-unit order. A name in `H` stays the gate's to
judge, as today.

- **It runs where the npm harvest runs**, right after `fetchCandidates`: in
  `classify.ts` on the daily workflow, and in `build.ts` when it harvests
  itself. The carried candidates, the rows and the counts ride
  `dist/harvest.json` with the rest of the harvest, as `shortfalls` do. That
  placement is load-bearing. The classifier computes its live names from the
  candidates it holds and prunes every other `categories.yml` row
  (`mergeCategoryRows`), so a carry added only in `build.ts` would cost a
  carried package its category on every run it is carried.
- With no lock, the first build, nothing departs.
- A build after a gap compares with the last catalog that was published, so
  the departures of the gap arrive together.
- A pull request's zero-write dry run computes the set the same way, and
  `--harvest-from` publishes what the harvest computed.

**Why each left.** One packument read per departed name, through the
harvest's own reader: the backup-registry failover, `REQUEST_TIMEOUT_MS` and
`MAX_PACKUMENT_BYTES`. A pure function classifies the answer. It reuses
`isDeprecated` and the unpublish-stub test inside `classifyPackument`
(`feed-state.ts:195`), which moves into a shared helper rather than being
copied.

| What npm answers | Outcome | Code | Detail (draft) |
|---|---|---|---|
| The latest version lists a harvest keyword and is not deprecated | carried | — | — |
| The latest version is deprecated | row | `deprecated` | `Marked deprecated on npm: "<message>".` |
| npm's unpublish stub | row | `npm-gone` | `Unpublished from npm on <date>, so no version is left to install.` |
| 404 | row | `npm-gone` | `npm no longer has a package of this name: the registry answers 404.` |
| The latest version lists neither harvest keyword | row | `npm-gone` | `Its latest version, <version>, no longer lists the dsh-plugin or deepseek-harness keyword, so the harvest does not select it. Add one back and the next build lists it again.` |
| Anything else: a transport failure, a deadline, another status, a body that is not this package's packument | row | `npm-gone` | `It left the keyword harvest, and npm did not answer when asked why: <reason>.` |

- **Carried** means the package stays listed. Its packument is projected by
  `toCandidate` and joins the candidates, so the gate judges it like any
  other and may still reject it with its own row. It is counted in no
  keyword's coverage, not in `enumerated` and not in a shortfall or a
  residual. Carrying therefore cannot hide a harvest that has stopped
  working, and cannot cancel a genuinely missing name, which is why the feed
  refuses to credit a name its owner's cell omits (change-feed design §4.5).
  A carried name is in the next lock, so it is read again on every build
  until the harvest returns it. LivXue chose on 2026-10-07 to carry such a
  package rather than only report it.
- **`npm-gone`** is a new code, the npm half of `repo-gone`: neither harvest
  keyword returns the package any more, and the detail says why when npm
  answered. LivXue chose it on 2026-10-07 over a code per cause, which would
  have added three or four codes and still left the last row without one.
- **One row, once.** A departure row appears on the build the package
  leaves, as `repo-gone` does. The next lock no longer holds the name.
- **The deprecation message** is the author's text bound for a published
  artifact. It is cut at a whole character to 200 characters
  (`DERIVED_SUMMARY_MAX_LENGTH`, the bound `summary.en` has) and escaped by
  `escapeCell` like every cell. A bare `true` carries no message and reads
  `Marked deprecated on npm.`, today's sentence. The gate's own branch
  (`gate.ts:268`) builds its detail through the same function, so the two
  paths cannot word one fact two ways, and `Candidate` carries the bounded
  message to make that possible.
- **The date** of an unpublish is the date part of `time.unpublished.time`
  when that is a well-formed timestamp. Otherwise the sentence omits it.
- **A repository the departed package shadowed** (`shadowed-by-npm`) is no
  longer shadowed on the same build and goes through the repo gate on its
  own, as today.
- **The report** gains one line beside the harvest's diagnostics, `npm
  packages missing from the harvest since the last catalog: N (carried C,
  deprecated D, npm-gone G)`, and the carried names below it. Nothing bounds
  `N` and nothing throws on it. A search that stops working is caught
  earlier, by the coverage checks, and an ecosystem event such as the
  takedown of a whole family is a real departure that has to publish.
- **Cost.** One packument read per departed name. Over the measured window
  that is at most 17 a build.

### 8.3 Not built

- **Telling a reader who installed it.** The catalog carries no departure,
  so the shop cannot say a plugin was withdrawn. That needs a field and a
  shop release (CLAUDE.md, "Release channels"). For now the fact lives in
  the row in `report.md`.
- **Rows that persist.** A departure is reported on the build it happens
  on, like `repo-gone`.
- **GitHub entries whose repository stays listed.** In the same window 86
  github entries left while their repository kept other entries, and 63 of
  those repositories listed a new entry the same day: a rename or a
  restructure. The other 23 may have left without a row. A repository that
  leaves entirely is `repo-gone`'s, and 44 of the 773 that left came back.
  Neither case is this section's.

### 8.4 Testing

- The lock reader against its writer: npm lines read back exactly, github
  lines skipped, scoped names, an empty lock.
- The departed set: a harvested name the gate rejects has not departed, and
  an absent lock departs nothing.
- The classifier as a table: each row of §8.2, a bare-`true` deprecation, an
  empty-string deprecation (not deprecated, by `isDeprecated`), a stub with
  and without a date, a 404, another status, a body that is not JSON,
  another package's packument, a packument with no latest version.
- The details: the message cut on an astral character, and the same
  sentence from the gate's path and the departure path for one message.
- A carried name reaches the gate and is absent from every coverage count.
  The report line counts each outcome. The pinning splits three ways, one
  per test site: the determinism test in `pipeline.test.ts` covers the new
  rows; `departures.test.ts` covers the carried-name ordering
  (`summarizeDepartures` sorts them); and the line itself is built in
  `build.ts` outside `runPipeline`, where an end-to-end test pins its
  order-independence.
- The packument read against fetch fixtures: 200, 404, the stub, a 5xx with
  and without a backup registry, a deadline. And `build.ts` in both harvest
  modes, fresh and `--harvest-from`.
- The handoff: its new field is parsed and validated the way `shortfalls`
  is, because its values reach the published report, and a carried package
  keeps its `categories.yml` row through `classify.ts`.

## 9. A3: a commit-pinned entry must contain what its patch loads

Decided and built 2026-10-07.

### 9.1 The defect

`verifyReleaseAsset` refuses a release asset whose patch inserts a module of
the package that the archive does not contain (`missingInsertTarget`,
`release-asset.ts:391`, and the 2026-09-07 "patch targets" amendment of the
authority spec's §7.2). A commit-pinned entry gets no such check, as that
function's own comment says (`release-asset.ts:388`): the entry that
prompted the rule, `@open-design/dsh-runtime`, is commit-pinned and stays
listed. The `requires-build` rule (`repo-gate.ts:146`) looks only for a
`prepare` or `prepack` script. A repository that gitignores `lib/` and fills
it with a plain `build` script passes every rule and is listed with nothing
to load, because a git install runs no build script.

What a missing entry module does depends on the harness, read from each
one's `@deepseek-ai/dsh-app-boot/lib/index.js`:

- **0.1.5-rc.3**: `assertEntriesLoaded` (`:1434`) throws "Cordis startup
  failed because these plugin(s) could not be resolved", so the whole
  profile fails to start. That is the incident shape §3.1 records for
  2026-09-15.
- **0.1.7-rc.2 and 0.2.0-rc.2**: an inactive entry that is not on the
  required list produces one warning and leaves its siblings running
  (`:3995` and `:3996`), so the plugin installs and silently does nothing.

Measured 2026-10-07 on the catalog built 2026-10-06T17:06Z, over all 7,817
commit-pinned github entries; the 274 release-rescued ones are checked
already. For each entry, its manifest and every declared patch file were
read at the pinned commit, and every module the patch inserts from the
package itself was resolved by `missingInsertTarget`'s own rules, with
presence decided by the file at that commit.

| Outcome | Entries |
|---|---|
| Every module it inserts from itself resolves to a file at the commit | 7,148 |
| An inserted module resolves only to files the commit does not contain | **650** |
| A declared patch file is not in the commit | **4** |
| `dsh.bundle` is not a loadable declaration: the bundle-components design's §5, not this section's | 6 |
| No `package.json` at the pinned commit: not this section's | 9 |

The 650 resolve through `exports` (612) or `main` (38), into `lib/` (553),
`dist/` (92) or elsewhere (5). 617 of them declare a `build` script. They
are 529 repository roots and 121 subpackages, in 596 repositories. Two of
the four missing patch files are build output themselves
(`./dist/cordis.patch.yml`). All 650 were judged a second time against the
git tree API at the same commits: the same 650, no tree truncated, and no
path present only under a different case. One of them: `1Lyn-en/dsh-whale`
at `3bfc3a9` exports `./lib/index.js`, its root `.gitignore` lists `lib/`,
and its patch inserts `@1lyn-en/dsh-whale`.

### 9.2 The rule

The release-asset rule's claim (3), applied to the git tree at the pinned
commit:

1. Every file `dsh.bundle.patch` declares is a blob in the tree, under the
   entry's `subdir` when it has one.
2. For every module a patch inserts from the package itself, meaning a name
   equal to the bundle name or under `<name>/`, at least one path its
   `exports` or `main` can resolve to is a blob in the tree.

The resolution is `missingInsertTarget`'s, unchanged, and so is its
direction. Every arm of a conditions object counts, `types` and `typings`
excepted, and `main` takes Node's extension and directory-index lookups.
None of these is ever refused: a wildcard, a `..`, an undecodable escape, a
name belonging to another package, a subpath no map lists, an entry point
declared nowhere. The rule can miss a defect and never invents one. The
function is generalized from an archive root and a member list to a root
directory and a set of paths, and both channels call it. A file that exists
only under another case is absent, as it is in an archive: Linux and the CI
runners resolve paths case-sensitively. No such entry exists today.

No verdict is formed when the tree is truncated, is not a list, answered
404, or was past `MAX_TREE_BYTES`; when a patch file is past
`MAX_PATCH_BYTES`; or when a patch does not parse. A patch file that exists
is never refused for its content.

### 9.3 Where it is checked

In `fetchRepoCandidate`, beside the sizing read (`github-client.ts:1498`),
which already fetches the recursive tree at the pinned commit for every
candidate that can list. Every candidate of a repository shares that tree.
The manifest is handed over from the projection that read it, not read
again, so the one new request is a raw read of each declared patch file at
the pinned commit. Only the candidates the sizing read covers are checked:
not release-rescued, and passing `canEverList`.

### 9.4 Records and the gate

- **Two fields** join `RepoCandidate` and `repo-state.json`.
  - A **marker** that the check ran, set whichever way it went, as
    `sizeProbed` is: whenever the tree answered, the no-verdict outcomes of
    §9.2 included. A transport failure reading the tree or a patch file sets
    nothing, and the next build tries again.
  - The **finding**: the missing patch file, or the inserted module and the
    path it resolves to. Each is author-controlled text bound for the
    committed file and the published detail, so each is cut at a whole
    character to 200 characters when recorded, and echoed into the detail
    through the release path's `echo`, which cuts at `ECHO_MAX` (80).
- **The code is `requires-build`.** `repo-gate.ts` refuses a candidate with
  a finding and no release. The fact is the one that code names, an entry
  that needs a build no install runs, and the release rescue already
  answers it. No code is added.
- **`canEverList` gains the same condition**, so the guard test in
  `repo-gate.test.ts` keeps it in step with the gate. A refused candidate is
  then neither sized nor checked again until its repository moves.
- **Details** (drafts):
  - A root's module: `Its patch inserts @1lyn-en/dsh-whale, which its
    package.json resolves to lib/index.js, and the repository does not
    contain that file at 3bfc3a9. A git install runs no build, so the plugin
    would not load. Commit the built files, publish to npm, or attach a
    packed release tarball, and it can be listed.`
  - A subpackage's module: the same without the release tarball, because
    the rescue is for roots only.
  - A patch file: `Declares dsh.bundle.patch ./dist/cordis.patch.yml, which
    the repository does not contain at <commit>, so dsh has no patch to
    load.`, followed by the same remedies.
  - A refused release asset appends `rescueNote`'s sentence, as it does for
    `requires-build` today.

### 9.5 The release rescue

The rescue extends to this finding, for a repository root. Once the check
has a finding, the root is probed with `fetchLatestReleaseTarball`, the same
probe and the same `verifyReleaseAsset` the projection runs for
`requiresBuild || hasWorkspaceDeps` (`github-client.ts:1603`). The two
places share one helper. An asset that verifies rescues the entry as it does
today: the entry installs the tarball, and its size and declarations come
from the archive. A refused asset is recorded in `releaseRejected`.

Measured on the 529 flagged roots: 188 have a latest release, 111 of those
carry a `.tgz` or `.tar.gz` asset, and `verifyReleaseAsset` as it stands on
`main` accepts 107 of them. 3 are refused, and 1 is past
`MAX_TARBALL_BYTES` at 157,882,370 bytes.

### 9.6 The backfill

`diffRepoState` queues a repository for a backfill fetch when it holds a
candidate that can list, is not release-rescued and has no marker. That is
the same queue as `lacksSizeProbe` (`repo-state.ts:359` and `:408`) and the
same budget, `REPO_BACKFILL_BUDGET_DEFAULT` (2,000 repositories a build,
`github-client.ts:1702`), changed repositories first. Over the
`repo-state.json` committed 2026-10-07T07:24Z the queue would hold 12,124
candidates in 11,844 repositories. The 2026-10-06 build fetched 802 changed
repositories, which leaves about 1,200 slots, so the backfill converges in
about ten builds, in repository-name order. The marker's absence is the
queue and a check that ran removes it, so the backfill ends by itself.

### 9.7 What it delists

On the 2026-10-06 catalog, 654 entries are refused (650 and 4) and 107 of
them are rescued, so **at most 547 leave the shelf**, approved by LivXue on
2026-10-07 with the rescue's extension. They leave as their repositories
are re-checked over the backfill, each with its row. Whether any of the four
missing-patch entries is rescuable was not measured, and the bound counts
none of them as rescued.

### 9.8 Not built

- An entry point written in TypeScript, which Node does not strip under
  `node_modules`.
- A build script in a dependency, which pnpm blocks at install. The host's
  failure detail already names `ERR_PNPM_IGNORED_BUILDS` and the approval
  step.
- A file the tree holds and the codeload tarball does not: an
  `export-ignore` path, a Git LFS pointer.
- A subpath the package does not export, which §9.2 leaves unanswered.
- The 9 entries with no `package.json` at their pinned commit.

### 9.9 Testing

- The generalized check over a set of paths: a repository root and a
  `subdir`; any arm of a conditions object, the declaration-order case
  included, and `types` skipped; `main`'s suffixes; a wildcard, a `..` and
  a bad escape skipped; another package's module skipped; a missing patch
  file; a list-valued patch; a truncated tree, a 404 and a malformed tree
  forming no verdict. The release-asset tests stay as they are and pass.
- `repo-gate`: both details, the subpackage's without the release clause;
  `rescueNote` appended; a release present means accepted; and the guard
  test extended so `canEverList` false still means the gate refuses.
- `repo-state`: the two fields parsed and serialized with their bounds, and
  a malformed one throws; a candidate without the marker is queued as a
  backfill, a marked one is not, a release-rescued one is not; after one
  simulated pass the queue is empty.
- `github-client`: the sizing step reads each patch at the pinned commit and
  records the marker and the finding; a failed tree or patch read records
  neither; a root with a finding is release-probed and a subpackage is not,
  through each of the probe's three outcomes.
- Each guard is reverted once to see a named test fail, as §7.4 did.

## 10. Batch 2: docs and order

- **Docs.** The authority spec takes two amendments in the same change, one
  for §8 under its §7.1 step 4 and one for §9 after the 2026-09-07 "patch
  targets" amendment in its §7.2. When the code lands, `docs/schema.md` and
  `docs/schema.zh.md` tell authors what a GitHub listing must commit and
  what deprecating or unpublishing leaves in the report, and CLAUDE.md's
  "Failing loudly" gains the departure rule.
- **One pull request** from `feat/borrowings-batch-2`, squash-merged. Its
  zero-write dry run shows the departure line and the first slice of the
  backfill. The registry is all it changes: no shop release, no README pin.
- **After the merge**, §8 takes effect on the next daily build, and §9's
  backfill starts there.
- **The bundle-components design** (`2026-09-28-bundle-components-and-github-peers.md`),
  built on branches that have not landed, edits the same files: `gate.ts`,
  `types.ts`, `npm-client.ts`, `build.ts`, `repo-gate.ts`, `repo-state.ts`
  and `release-asset.ts`. The two are independent in logic: §9 adds no
  `DECLARATIONS_RULE` bump, and its marker is separate from that design's
  rule-2 stamp. Whichever lands second resolves text conflicts only.
