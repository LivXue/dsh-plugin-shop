# Bundle components and github harness peers: design

Status: proposed 2026-09-28. All three phases were built from 2026-09-29
to 2026-10-01 on branches that never landed. **Re-measured and re-scoped
2026-10-10 (section 13): this change builds section 6, and the rest of
the github half of section 7 (7.3's shop judgment of an entry's own
peers) follows in the shop change that follows the registry's. Sections 4
and 5, and the component half of section 7, are not built.** LivXue chose
on 2026-09-27 that the card says so before the click
(approach A of section 3), on 2026-09-28 its form A1 and each part of this
design, the 29 delistings of section 5 included, and on 2026-10-10 the
github half alone. It amends
[2026-09-26-dsh-017-readiness.md](2026-09-26-dsh-017-readiness.md) B1.2
(github entries record their harness peers) and B1.3 (a bundle's components
are predicted; not built, section 13), and
[2026-09-01-harness-compatibility.md](2026-09-01-harness-compatibility.md)
section 10 (what blocks an install). English only, per convention.

## 1. Why

On 2026-09-27 an install of `@linfengqaqtat/dsh-scriptor-full@0.1.0-preview.6`
from the shop, on dsh 0.1.7-rc.2, ended:

    dsh refused the install: Plugin @linfengqaqtat/dsh-scriptor@0.1.0-preview.6
    is incompatible with dsh 0.1.7-rc.2: peerDependencies
    {"@deepseek-ai/dsh-tools":"0.1.5-rc.2", ...}. Plugin
    webnovel-embedding-provider@0.0.8 is incompatible with dsh 0.1.7-rc.2: ...
    Restored package.json, pnpm-lock.yaml, and node_modules. ...

The entry is a bundle that declares no peers of its own. Its patch inserts
two plugins, and each pins its harness peers to `0.1.5-rc.2`. The card
offered the install because the catalog records an entry's own `dshPeers`
and nothing else; dsh judged the two plugins after pnpm and rolled the
install back.

The same gap, measured on 2026-09-28 against dsh 0.1.7-rc.2's own rule and
the catalog built 2026-09-27T06:35Z (12,352 entries: 5,132 npm, 7,220
github):

| Case | Cards | Today | After this design |
|---|---|---|---|
| npm bundle whose exact-pinned component dsh refuses | 1 (`@linfengqaqtat/dsh-scriptor-full`) | Install enabled, refused after pnpm | Install disabled, with a command per refused package |
| npm bundle whose range-pinned components dsh refuses | 1 (`dsh-ros2`) | Disabled on its own peers; its command clears the bundle only | Unchanged (section 11) |
| `dsh.bundle` that no dsh runs | 23 npm, 6 github | Never a working plugin (section 5.1) | Not listed |
| github entry whose own peers dsh refuses | 273 | Install enabled, refused after pnpm | Install disabled, with its command |

For scale: 349 npm cards are already disabled on their own peers
(readiness B1).

## 2. What dsh does

Read from dsh 0.1.7-rc.2's `@deepseek-ai/dsh-plugin-manager`,
`@deepseek-ai/dsh-app-boot` and `@deepseek-ai/cordis-plugin-include`
(`lib/index.js` each). The exported readers and the rule were run on the
live catalog's manifests (section 12), and the report in section 1 is the
post-install check observed live.

- **Two checks, with different inputs.** Before pnpm runs,
  `runProfilePnpm` (plugin-manager `:438`) judges each named spec it can
  read without installing (`:500-514`): a registry spec's manifest through
  `pnpm view`, a path from disk. Git and tarball specs are skipped. After
  pnpm (`:615-646`) it judges every direct dependency pnpm changed and,
  for each, the plugins that dependency's bundle patch inserts
  (`bundleComponentManifests`, `:404`), and restores the profile when any
  is refused.
- **Which plugins a patch inserts.** `bundleComponentManifests` reads every
  declared patch file, keeps the patches carrying `insert`, and composes
  them over an empty root with the loader's own `applyEntryPatches`
  (app-boot `composeEntries`, `:988`; cordis-plugin-include `:56`). A patch
  whose `id` is absent or falsy appends its rows to the root. A patch with
  an `id` appends them to that group row's `config`, and is skipped when no
  such row exists or it is not a group. The result is then visited,
  descending into each group's `config`, and every row's string `name`
  that starts with neither `.` nor `/` and holds no `:` is taken, reduced
  to its package: one path segment, two for a scope.
- **Which copy is judged.** Each name is resolved with app-boot's
  `resolveBundleDir` (`:900`), each anchor in Node's own lookup order.
  The installation anchor comes first (`<dsh>/package.json`, the
  `INSTALL_ANCHOR` dsh passes). The second is the changed package's own
  `package.json`, because `bundleComponentManifests` is handed that
  package's directory (plugin-manager `:627`). Profiles are initialized
  with `nodeLinker: hoisted` (app-boot 0.1.7-rc.2 `:565`, 0.1.5-rc.3
  `:368`). So after pnpm the bundle's own directory resolves exactly the
  version it depends on: nested under it when another version holds the
  profile's slot, and hoisted to `<profile>/node_modules/<name>` otherwise.
  For an exact pin, only the installation's copy can differ from the pin.
  No catalog name resolved from the anchor of either installation measured
  (a separate prefix and a global install). (Amended 2026-09-28 with the
  implementation plan. This bullet first named `<profile>/package.json` as
  the second anchor, which is `resolveBundleDir`'s parameter name, not what
  this caller passes.)
- **The rule and its key.** `evaluatePluginCompatibility` (app-boot
  `:286`) reads every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer and
  keys its exemption by the judged manifest's `name@version`. It accepts
  any non-empty version string as that key; `allow-version` grants exact
  versions only; and a missing or empty version makes it throw on a
  mismatch.
- **A throw is a refusal.** Anything that throws while the post-install
  check reads a changed package or its components, an unloadable
  `dsh.bundle` included, is reported as "Cannot validate installed
  package" and refuses the install. No exemption clears it.
- **Nothing answers earlier.** `inspect()` (`:1541`) never runs the rule,
  and the components are named in the tarball, not the packument.

## 3. Approaches

Three places to tell the reader were weighed, and LivXue chose A:

- **A. On the card, before the click.** The catalog records what dsh
  reads after pnpm, and the shop judges it with dsh's rule. Chosen.
- B. At the click, before pnpm: the host reads the prefetched tarball with
  app-boot's readers and fails in seconds. The card would still offer an
  install that cannot proceed.
- C. Remember dsh's refusal after the first failure. Exact by
  construction, but the first click still costs a full install and a
  rollback.

Within A, three forms:

- **A1. The catalog records each package's requirements at a pinned
  version; the shop judges them with the running dsh's rule and the
  profile's exemptions.** Chosen.
- A2. The catalog records component names only, and the shop looks them up
  among other catalog entries. One entry's verdict would then depend on
  another being listed, and on its catalog version being the pin: a
  delisting could hide a refusal, and a newer catalog version could invent
  one.
- A3. The build computes a verdict per dsh version. The catalog records
  requirements, never verdicts; a build cannot read a profile's
  exemptions; and each dsh release would leave the verdicts stale.

## 4. Phase 1, registry: npm bundle components

**Not built (section 13).**

### 4.1 What is recorded

`components` on npm entries: a list of `{ name, version, dshPeers }`,
sorted by `name`, absent when empty. A package is recorded as a component
when all of the following hold:

1. The bundle's patch inserts it, read by the subset rule of section 4.2,
   and it is not the bundle itself.
2. The bundle pins it exactly in `dependencies`: the spec is a string equal
   to its own canonical semver. A range, a dist-tag, an `npm:` alias, a git
   or tarball spec, and the `v`-prefixed and build-metadata forms are all
   excluded. An alias could not be recorded anyway: its installed manifest
   names another package. A name that `optionalDependencies` also declares
   is excluded too. That field overrides `dependencies` for pnpm, which may
   skip an optional dependency on the reader's platform, and a pin that does
   not land is never judged. (Amended 2026-09-28 with the implementation
   plan; the first draft read `optionalDependencies` as well.)
3. Its manifest at that version names that package and that version, and
   declares harness peers, read by `dshPeersOf` with its bounds.

Only exact pins, because pnpm resolves a range at install time. A component
fixed after the daily build would leave the card refusing an install that
dsh accepts, the one error a disabled button must not make (readiness
B1.2). Measured on 2026-09-28: bundle patches insert 41 components that
declare harness peers, 20 of them exact-pinned and 21 on ranges. dsh
0.1.7-rc.2 refuses 7: `dsh-scriptor-full`'s 2, which are exact, and
`dsh-ros2`'s 5, which are ranges. These figures count both dependency
fields; phase 1's differential check re-measures them under item 2.

### 4.2 Reading the patch: the subset rule

The parser keeps only rows dsh is certain to judge:

- Among the patches carrying an `insert` key, across the declared patch
  files in their declared order, every one must hold an array `insert`.
  Otherwise nothing is recorded for the bundle: dsh would either throw on
  it or apply it as an override this rule does not model.
- The rows of every such patch whose `id` is absent or falsy, as
  `applyEntryPatches` reads it, are taken, and so is every row nested in a
  group's `config` among them, recursively.
- Names are taken from those rows as section 2's visitor takes them.

An `id`-targeted insert is ignored. dsh judges its rows when the target
group exists, so ignoring them can only lose a component, never add one.
Of the 12 bundle patches phase 1 reads today, none uses an `id`-targeted
insert, and one holds a group row.

Nothing is recorded for the bundle when a patch file is missing,
unreadable or past `MAX_PATCH_BYTES`, when its top level is not a list, or
when the rows pass a depth or row-count bound. A YAML alias can make the
parsed value cyclic, which is why `patchInsertNames` is shallow. A `!!js`
value is never a name: dsh's dialect parses it as an expression object.

The dialect errs the same way. dsh parses a patch with js-yaml's JSON
schema and one custom type, `!!js` (app-boot `entryListSchema`, `:33`). The
parser reads it with `yaml`'s YAML 1.2 core schema and that type. The two
resolve plain scalars alike and merge no `<<` key, as measured on 60
scalars against the js-yaml dsh 0.1.7-rc.2 ships (4.3.2). The one
exception measured is a binary or signed prefixed integer (`0b101`,
`-0x1F`) that js-yaml reads as a number; the parser never takes one as a
name. It records nothing on any parse error or warning, which covers an
unknown tag (js-yaml throws on one). It also records nothing for a
top-level entry that is not a mapping, which dsh's parser refuses.
(Amended 2026-09-28 with the implementation plan, and corrected 2026-09-29
during phase 1. The plan read YAML 1.1, which merges `<<` keys and reads
`0o17` as a string: both are names dsh never takes.)

The parser is pure and sits beside `patchInsertNames`
(`release-asset.ts:213`). Before phase 1 lands, it is run over every
bundle patch the harvest reads and compared with dsh 0.1.7-rc.2's own
`composeEntries` and visitor on the same files. Its names must be a
subset, and a name it adds is a defect.

### 4.3 What is fetched

In the npm harvest, beside the packument each belongs to
(`fetchCandidate`), so the pure pipeline receives a finished candidate:

1. **Component manifests first.** A harvested bundle whose declaration
   loads (section 5) and that exact-pins at least one harvested name (the
   keyword harvest's union, before the gate) gets one `/<name>/<version>`
   request per such pin, through the packument's failover, timeout and
   byte cap. Measured 2026-09-29, counted against the listed names (the
   harvested set is a superset): 31 bundles and 71 requests.
2. **The tarball only when one of those manifests declares harness
   peers.** Its URL is the packument's `dist.tarball`. It is fetched only
   when it is on the npm registry or the configured backup, the two origins
   a packument can come from, through the packument's own failover, and
   `dist.integrity` binds the bytes whichever registry answers. (Amended
   2026-09-28 with the implementation plan. The first draft said "the
   registry that served the packument", which the failover does not
   record.) It is read through
   `readCappedBody` at `MAX_TARBALL_BYTES`, and refused early when
   `content-length` already exceeds the cap: that header can only cost a
   record, never admit a body, since the byte count still decides
   everything else. It is checked against `dist.integrity`, then opened
   with `release-asset.ts`'s readers: a single root, the manifest naming
   the bundle, and patch files within `MAX_PATCH_BYTES`, under
   `MAX_INFLATED_BYTES`. Today: 12 tarballs. 11 of them total 251 KiB,
   and `mimi-desktop-pet` (52,291,004 bytes) is refused on its header.

### 4.4 Bounds and failures

- **Budget.** `components` is not counted in `ENTRY_PAYLOAD_MAX_BYTES`. It
  is emitted only when the entry, with it, still fits the budget, all or
  nothing, so it can never reject an entry: a decoration costs itself,
  not the listing, the rule `installSize` follows (`gate.ts:403`). The
  heaviest real record adds 4,725 bytes (`@dfy-plugins/dsh-bundle`: 8
  components, 56 peers).
- **Failure.** A failed read records nothing for that bundle or
  component, and the next build tries again: a failed request, a tarball
  over the cap, an integrity mismatch, an archive that does not have
  exactly one root or that names another package, an unreadable patch, a
  component manifest naming another package or version. None of these is
  a rejection or a `fetch-failed` row, because a bundle's listing does not
  depend on its components. One line in the build report's diagnostics
  and the CI log names every bundle whose record came up short: a failed
  read of its tarball or of a component manifest, which the next build
  retries, or pins past the bound below, which every build leaves unread.
  (Corrected 2026-09-29 during phase 1: the line first called every short
  record a failed read that the next build retries.)
- **Pins.** At most 64 exact pins are read per bundle
  (`COMPONENT_PINS_MAX`, 8x the heaviest real record). Past that bound
  the first 64 are read, and the bundle is named in that line. (This bullet
  and the line's wording were amended 2026-09-28 with the implementation
  plan.)
- **Emission.** `components` joins the list of additive fields that ride
  every `schemaVersion` (`emit.ts`): a shop that predates it strips the
  key. Its `dshPeers` keys pass through `wellFormed` like the entry's own,
  and the determinism test covers it.
- **No `DECLARATIONS_RULE` bump.** npm entries are re-projected by every
  build.

## 5. Phases 1 and 2, registry: bundle declarations no dsh runs

**Not built (section 13)**, so section 6.1's unloadable-bundle record is not
written either.

### 5.1 The rule

`dsh.bundle` must be a plain object whose `patch` is a string or a list of
strings: `patchFilesOf` (`release-asset.ts:126`), the registry's reading
of app-boot 0.1.7's `bundlePatchFiles` (`:495`). Anything else is
unloadable: a `patch` that is absent, a boolean, a number, an object,
`null`, or a list holding a non-string, and a `dsh.bundle` that is itself
a string, a boolean, a number, `null` or a list.

No dsh runs such a package. dsh 0.1.7-rc.2 refuses every shape after pnpm
with "Cannot validate installed package", which no exemption clears:
`bundleComponentManifests` reads the declaration of every changed package.
dsh 0.1.5-rc.3 splits them by shape, since it takes a package for a
bundle exactly when `dsh.bundle.patch` is not undefined (dsh
`lib/plugin-*.js:32`):

- **A `patch` it can see but not use** (`true`, a number, an object,
  `null`, a list holding a non-string; all 23 npm entries of section 5.4)
  makes the package a bundle, whose profile then fails to start (app-boot
  `:851-853`). The shop's confirm step fails such an install first, as
  `malformed` (readiness B4).
- **No `patch`, or a `dsh.bundle` that is not an object** (all 6 github
  entries of section 5.4) installs as a plain dependency that never loads,
  with dsh's warning "declares no dsh.bundle".

A list of strings loads on 0.1.7 only and stays listed; on 0.1.5 the
confirm step already fails it as `list-unsupported` (readiness B4).

### 5.2 Where it is checked

- **npm, phase 1.** `toCandidate` records the declaration's shape when it
  is unloadable. `gate.ts` rejects on that record right after its
  `hasBundle` check (`:264`).
- **github, phase 2.** `writeDeclarations` records the shape under rule 2
  (section 6), from the same manifest it reads. `gateRepo` rejects right
  after its `no-bundle` check (`repo-gate.ts:136`), and `canEverList`
  (`:94`) asks the same predicate, so the gate and every queue agree on a
  record the current rule wrote. The declarations re-read asks it with a
  stale-stamped `unloadableBundle` set aside, because that record is an
  older rule's verdict: a record from another rule is re-read, not trusted
  (section 6.2), so a refusal written under a rule later loosened or rolled
  back lifts at the re-read instead of waiting for the author's next push.
  Until then the gate keeps refusing on it. `verifyReleaseAsset` stops
  accepting a missing `patch` (`:554`) for new probes; a carried rescue
  gets its record from the re-read.
- **Absence never rejects.** On github, absent means "loads" beside a
  rule-2 stamp and "not yet read under rule 2" beside any other.

### 5.3 Code and detail

`no-bundle`, the existing code: a new code would change a published
artifact (CLAUDE.md, "Failing loudly"). The detail names the shape and
what each dsh does with it, one sentence per class of section 5.1. Drafts,
to be checked against both harnesses' source when built:

> Declares dsh.bundle.patch as a boolean, which is neither a file path nor
> a list of file paths, so no dsh can load the bundle: dsh 0.1.5 fails to
> start a profile that selects it, and dsh 0.1.7 refuses the install.
> Point it at the patch file, for example "patch": "./cordis.patch.yml".

> Declares dsh.bundle as a boolean rather than an object naming its patch
> file, so no dsh runs it: dsh 0.1.5 installs it as a plain dependency that
> never loads, and dsh 0.1.7 refuses the install. Declare
> "bundle": { "patch": "./cordis.patch.yml" }.

A `dsh.bundle` object without a `patch` gets the second sentence, naming
the missing key.

A release-rescued entry's record comes from the release asset it would
install, so its detail says so: the same sentence with "The release asset
dsh would install declares" as its subject, ending "and attach a newly
packed release asset". A carried rescue's HEAD manifest is often a
different version from the tarball it installs, so naming HEAD's would
point the author at a file their entry does not use.

### 5.4 What it delists

Measured, and approved by LivXue, on 2026-09-28.

- **23 npm entries**, all from one publisher, all declaring
  `"patch": true`, and every one already disabled on dsh 0.1.7 by its own
  peers: `@liuhange/dsh-` followed by `ai-dataset-inspector`,
  `city-data-classifier`, `data-asset-attestation`,
  `data-asset-compliance-check`, `data-asset-inventory-scan`,
  `data-asset-orchestration`, `data-asset-quality-score`,
  `data-asset-registration-helper`, `data-asset-shared`,
  `data-asset-valuation`, `data-circulation-assessor`, `data-cleaning`,
  `data-inventory`, `data-lineage`, `data-masking`, `data-packaging`,
  `data-quality-scoring`, `data-sensitivity-classification`,
  `data-visualization`, `generate-registration-docs`,
  `gov-data-inspector`, `match-registration-agency` and
  `registration-precheck`.
- **6 github entries**, each delisted when its repository is re-read under
  rule 2. `dsh.bundle` is `true` in `harness-workshop`
  (AAA-STM32XinPianPiFaWangGe/DSH-Workshop), `dsh-obsidian-bridge`
  (AIMarshallLee/dsh-obsidian-bridge) and `dsh-mcp-orchestrator`
  (AIMarshallLee/dsh-mcp-orchestrator); a string in `gatecraft`
  (Cryonnan/GateCraft-math-modeling-skills) and `dsh-prolong-memory`
  (ycr40/dsh-prolong-memory); and it has no `patch` in
  `@t7kai/dsh-client-ui-slingshot` (JingkaiTang/dsh-client-ui-slingshot).

## 6. Phase 2, registry: github harness peers

**Built (section 13)**, without 6.1's unloadable-bundle record.

### 6.1 What is recorded

Through `writeDeclarations` (`github-client.ts:1011`), the one writer,
from the manifest dsh will install: the manifest at the pinned commit, a
subpackage's own for a subpackage, or for a release-rescued root the
packed manifest (`PackedDeclarations`, `release-asset.ts:63`, gains
`version`):

- **`dshPeers`**, read by `dshPeersOf`, which becomes the reader on both
  channels.
- **`manifestVersion`**, the manifest's own `version`, verbatim and
  bounded by the npm `version` bound: the version dsh keys an exemption
  by, where a github entry's catalog `version` is a commit, or a release
  tag for a rescue. It is recorded together with `dshPeers` or not at all,
  because neither alone can form a verdict (section 2: the rule throws on
  a mismatch without a version). Past a bound both are dropped, never
  rejected.
- **The unloadable-bundle record** of section 5.

The name dsh keys the exemption by is the candidate's own `name`: the
projection takes it from that manifest, and a rescue's packed manifest
must carry it (`openPackedManifest`).

No emit flag is needed. `withholdRepoPeers` strips `peers` only, and every
shop before phase 3 skips github entries in `peerVerdictsOf`, so no older
reader acts on either field. Every published host's catalog schema (0.8.3,
and main since) raises on a github entry only for a missing `repo`, an
`unpackedSize` or a version that is neither a commit nor a tag, and strips
a key it does not declare.

### 6.2 The rule bump

`DECLARATIONS_RULE` 1 -> 2 (`repo-state.ts:45`) queues every listable
carried candidate for a re-read: on 2026-09-28, 11,261 candidates in
11,017 repositories, 419 of them release-rescued (one asset download
each). At `DECLARATIONS_REREAD_BUDGET_DEFAULT`, 4,000 repositories a run,
that is three runs (4,000 + 4,000 + 3,017), unless the time budget cuts a
slice short. Rule 1's own backfill converged in three: stamped candidates
went 0 -> 4,192 -> 8,556 -> 11,282 between 2026-09-25 19:44 and
2026-09-26 09:29 UTC. Until a repository is re-read, its entries carry
nothing new: no verdict, no record, no rejection.

### 6.3 Budget and size

Both fields count toward the payload budget, as npm's `dshPeers` does.
After the change the heaviest github entry measures at most 4,696 bytes
(`dsh-nexttavern`), and none crosses 12 KiB. The published catalog grows
by about 883 KiB, 8.0% of its 11,353,592 bytes, almost all of it
`dshPeers`.

### 6.4 Figures

On 2026-09-28, 7,102 of the 7,220 github entries' manifests were readable
at their pinned commit; the 225 release-rescued ones were read there too,
which approximates their packed manifest. 3,743 declare harness peers, and
dsh 0.1.7-rc.2 refuses 273 of them, every one with an exact version. 2
manifests carry an inexact version and 5 none; none of those seven is
refused.

### 6.5 Not recorded: github bundle components

14 github bundles depend on an npm plugin that declares harness peers.
Their patches insert 5 exact-pinned components, in 4 bundles, and dsh
0.1.7-rc.2 refuses none of them. The component machinery stays npm-only;
a refusal there still reaches the reader as dsh's own, after pnpm
(section 7.6).

## 7. Phase 3, the shop

**Built by the shop change that follows the registry's, for an entry's
own peers only (section 13):** 7.3's judgment of a github entry by its
`manifestVersion`, on the npm card's unchanged `harness-peers` blocker.
7.1's `components` declaration, 7.2, the `components` half of 7.3 and
7.4's component sentences are not built.

The shop forms these verdicts only where the running app-boot exports the
peer rule, 0.1.7 on, and nothing changes elsewhere. 0.1.5 has no rule.
The desktop profile is unmeasured (delegation design, section 7); where
`readRunningHarness` identifies no harness, as for any process dsh's CLI
did not start, the shop forms no peer verdict at all.

### 7.1 Reading

`host/catalog.ts` declares `components` and `manifestVersion`, typed and
optional, as it declares every key it reads; `dshPeers` is already
declared on every entry. `components` is read on any entry and
`manifestVersion` on github entries only, where an npm entry's `version`
is already its manifest's. Neither is refused on the other channel: the
data file is read with a throwing `parse`, and a stray key would cost
every reader the whole catalog.

### 7.2 Which copy dsh judges

`harness.ts` additionally takes `resolveBundleDir` and
`readProfileManifest` from the running app-boot, anchored at the dsh
package it already identifies (`owner.dir`) joined with `package.json`:
the `INSTALL_ANCHOR` dsh passes (dsh `lib/profile-boot-*.js:119`). It
passes the installation as both of the resolver's anchors, so it asks the
installation half of dsh's lookup alone. The other half is the bundle's
own directory, which after pnpm resolves the pin (section 2). What the
profile holds today is therefore never consulted: neither a direct install
at another version nor this bundle's previous pin during an update. For
each recorded component:

| What the installation resolves | Verdict |
|---|---|
| Nothing (the resolver throws, its not-found answer) | The recorded pin is judged |
| The same `name@version` | Judged; it is the same manifest |
| Another version, or another name | Skipped: dsh judges that copy instead |
| A copy whose manifest cannot be read | That component skipped; dsh refuses in its own words (section 7.6) |
| No resolver exported | Every component skipped; the entry's own verdict stands |

A component name outside dsh's exemption grammar is never looked up,
since the lookup joins it onto paths. (Amended 2026-09-28 with the
implementation plan. The first table skipped a component whenever the
profile held another version, following the second anchor section 2 first
named.)

### 7.3 The verdict

`peerVerdictsOf` (`compatibility.ts:273`) runs each judged component
through the same rule, with the same exemptions. `PeerVerdict` gains
`components?: { name, version, refused, allowCommand }[]`, in name order;
its existing `refused` and `allowCommand` keep describing the entry
itself, and are `{}` and `null` when only components are refused. A
verdict forms when the entry or any component is refused.

A github entry is judged when it carries both `dshPeers` and
`manifestVersion`, as `{ name, version: manifestVersion,
peerDependencies: dshPeers }`. Its command is built from
`name@manifestVersion`, and is null for an inexact version, as
`allowVersionCommand` (`:326`) already rules.

### 7.4 The card

The `harness-peers` blocker (`present.ts:131`) shows the entry's own
sentence, only when it has one, then one sentence per refused component,
each on its own line. For example: "dsh 0.1.7-rc.2 on this machine refuses
@linfengqaqtat/dsh-scriptor@0.1.0-preview.6, which this plugin installs
with it: it requires ...". That is the wording both locales use; neither
says "bundle". (Amended 2026-09-28 with the implementation plan.) The
remedy lists one `allow-version` per refused
package, each on its own line, the lead-in in the plural when there are
several. All or none: when any refused package has no command, none is
shown, since running the others would not enable the install. As today,
Install and Update stay disabled (`refusesInstall`), the badge reads
Incompatible, the incompatible filter counts the card, and Refresh after
running the commands enables it. Copy in both locales.

### 7.5 Version skew

After a self-update, dsh 0.1.7's client HMR swap runs the new client
against the old host until the restart. The old host sends no
`components`, and the card renders as it does today. The reverse, an old
page against a new host, exists only between a restart and the restart
monitor's reload. There, a components-only verdict renders the entry's
sentence with an empty peer list and a disabled button, never a wrong
command.

### 7.6 Unchanged: what the card misses

A refusal the card does not predict (a range pin, a skipped slot, a
github bundle's component) still reaches the reader in dsh's own words
after pnpm. On the service path the shop reads `error.incompatible` (#70)
and names every package with its command (the shop's
`host/plugin-manager.ts:290-299`); on the CLI path `refusalDetail`
(`host/executor.ts`) does the same from dsh's output.

## 8. Testing

Registry, pure and fixture-driven (CLAUDE.md, "Testing"):

- **Components.** The subset parser as a table: root inserts, group
  recursion, `id`-targeted inserts ignored, a non-array `insert` recording
  nothing, names starting with `.` or `/` or holding `:` skipped, a
  subpath reduced to its package, the bundle itself excluded, `!!js`
  values, and the depth and row bounds. The exact-pin filter as a table:
  ranges, dist-tags, `npm:` aliases, git and tarball specs, a `v` prefix
  and build metadata excluded, `dependencies` read, and a name
  `optionalDependencies` also declares excluded. Each failure
  of section 4.4 records nothing and rejects nothing, and the diagnostics
  line counts it. Over the budget, `components` is dropped and the entry
  still lists. The determinism test covers `components` on every artifact
  it checks.
- **The unloadable-bundle predicate**, as a table through `gate`,
  `gateRepo`, `canEverList` and `verifyReleaseAsset`, asserting the exact
  detail strings. `canEverList`'s existing guard test keeps it and
  `gateRepo` in step.
- **Rule 2.** `writeDeclarations` writes `dshPeers`, `manifestVersion`,
  the record and the stamp together; a rule-1 record is queued; the commit
  re-read and the asset re-read both fill the fields; the two fields are
  recorded together or not at all.

Shop:

- **`peerVerdictsOf`, as a table:** the entry refused alone (unchanged),
  only a component refused, both; an exempted component; the installation
  resolving nothing, the same version, another copy, or a copy it cannot
  read; no resolver exported; a github entry with both fields, with one,
  and with an inexact version.
- **`harness.ts`:** the resolver taken from a fixture app-boot in a child
  process, as the peer check is today, with both of the anchors it hands
  the resolver the installation's, and none when the export is missing.
- **The client:** the blocker with components, the plural lead-in, all
  or none, `refusesInstall`, and an old host's verdict rendering as it
  does today.
- **The web e2e, on both CI legs.** A fixture bundle exact-pins a fixture
  component that declares a harness peer no dsh with the peer check satisfies, and the
  fixture catalog records it. On 0.1.7-rc.2 the card is disabled and names
  the component; its commands are run through the real CLI exactly as
  shown; Refresh enables the button; and the install succeeds, which is
  dsh honouring the component's exemption after pnpm. On 0.1.5-rc.3 the
  card is enabled and the install succeeds.
- **No github e2e.** The e2e installs from a local registry and has no
  github channel; the github verdict is unit-tested and checked by hand on
  the beta (section 10).
- **Every new guard is reverted to its defect once, and the suite must
  fail.**

## 9. Docs

**Superseded in part by section 13:** the cross-document notes landed
dated 2026-10-10, and the plan's entry as remaining-work item 9; the
`dsh.bundle` and `components` author docs are not written, nor is
CLAUDE.md's `no-bundle` line.

- **In this design's own change:** an "Amended 2026-09-28, not yet built"
  note in readiness B1.2 and B1.3 and in harness-compatibility section 10,
  and item 7 of the remaining-work plan.
- **With phase 1:** `docs/schema.md` and `docs/schema.zh.md` state the
  `dsh.bundle` rule, `components` as a record, and `dshPeers`: that on dsh
  0.1.7 a shop newer than 0.8.3 disables an npm install dsh would refuse
  and shows dsh's exemption command. CLAUDE.md's paragraph on the
  knowingly broad codes gains `no-bundle`. (Amended 2026-09-29 during
  phase 1: author docs land with the code they describe, and until phase
  3 no shop checks either.)
- **With phase 2:** the same two files for github's `dshPeers` and
  `manifestVersion`, the github half of the `dsh.bundle` rule (which
  reaches each repository at its next re-read), and the notes on
  `Entry.dshPeers` and `dshPeersOf` that say npm only. (Amended
  2026-09-29: phase 1's docs scope the `dsh.bundle` shape rule to npm
  packages, since phase 1 only refuses npm; a github repository declaring
  the same bad shape still lists until this phase's re-read applies the
  rule to it too.)
- **With phase 3:** the same two files, in the shop release that ships the
  check rather than in this phase's own change. They name that release's
  version and state that a shop from it on also checks `components` (one
  command per refused package, predicting an exact pin only) and judges
  github entries by their `manifestVersion`; phase 1's shop sentence drops
  its "on an npm entry" then. (Amended 2026-10-01 during phase 3: until a
  shop release carries the check, no shop version does it, and which one
  will is decided at release, per section 10.)

## 10. Release and order of work

**Superseded by section 13's order.**

| Phase | Content | Lands through |
|---|---|---|
| 1 | Registry, npm: `components`, and the rule (23 delisted) | A PR, whose zero-write dry run shows the live figures, then a catalog run |
| 2 | Registry, github: rule 2, and the rule (6 delisted) | A PR, whose dry run re-reads the first 4,000 repositories, then about three runs of backfill |
| 3 | Shop: component and github verdicts | A beta, checked by hand on a real 0.1.7 profile against the live catalog, then LivXue's go-ahead |

- The registry phases need no npm release. Their fields are additive, and
  the delistings take effect at the first build that reads each one, in
  `report.md` with their details.
- The shop goes through beta first: it reads a new app-boot export and
  adds an RPC field (CLAUDE.md, "Release channels"). It follows #70's
  pending beta, and its version is decided at release. The hand check: the
  `dsh-scriptor-full` card shows both commands; after running them and
  pressing Refresh the install succeeds; and a github card shows its
  refusal and command. Promotion to `latest` waits for LivXue's go-ahead,
  and the README pins move in that commit.
- The shop is last so that one beta is checked against live data for both
  kinds of card before it reaches `latest`. Its code can be written while
  phases 1 and 2 land.

## 11. Residuals

What the card still does not predict. Each reaches the reader as dsh's own
refusal after pnpm (section 7.6).

- **Range-pinned components:** 21 inserted with harness peers today.
  `dsh-ros2`'s 5 are refused; its card is disabled on its own peers, and
  its command clears only the bundle.
- **A component the dsh installation itself holds at another version**
  (section 7.2), none measured. (Amended 2026-09-28 with the implementation
  plan. This line first read "a component whose slot holds another
  version", which section 2's corrected anchor removes.)
- **A component pinned through `optionalDependencies`** (section 4.1),
  which pnpm may skip.
- **Rows an `id`-targeted insert adds**, none today.
- **A bundle whose tarball is past the cap:** `mimi-desktop-pet`.
- **A component that is not a harvested name.**
- **Github bundle components** (section 6.5), none refused today.
- **A manifest dsh cannot judge:** a non-string peer range anywhere in it,
  a patch dsh cannot compose, or a github manifest with a refused peer and
  no version (none today). dsh refuses each after pnpm, and no exemption
  clears it; unchanged from readiness B1.3.

## 12. How the figures were measured

Throwaway scripts, run on 2026-09-27 and 2026-09-28 against dsh
0.1.7-rc.2's own modules (a separate prefix), the catalog built
2026-09-27T06:35Z, and the live npm registry and GitHub. None is kept.

- **npm components:** each npm entry's manifest at its catalog version;
  for each bundle, the dependencies that are catalog names, resolved to
  the pinned or highest satisfying version and judged by the rule; the
  patch read with app-boot's own `bundlePatchPaths`, `loadOverlayPatches`
  and `composeEntries`, and `bundleComponentManifests`' visitor.
- **Phase 1's cost:** the same entries in section 4.3's two-step order.
  Tarball sizes are downloaded bytes, because npm's tarball HEAD carries
  no length.
- **Unloadable declarations:** `dsh.bundle` in each npm manifest at its
  catalog version, and in each readable github manifest.
- **github:** each entry's manifest at its pinned commit, subpackage
  aware, judged by the rule; bytes as `entryPayloadBytes` counts them.
- **The resolver:** every catalog npm name looked up from both measured
  installations' anchors; none resolved.
- **Rule 1's backfill and rule 2's queue:** the committed
  `registry/repo-state.json` of each catalog commit from 2026-09-24, and
  `canEverList` applied to the one of 2026-09-28.

## 13. 2026-10-10: re-measured, and only the github half is built

The three phases sat unmerged while main moved on, and on 2026-10-10 a
trial merge of the stack onto main conflicted in 20 files: the borrowings
of 2026-10-07 and 2026-10-08 changed the same registry modules. Before
paying for that, section 1's figures were measured again against the
catalog built 2026-10-09T12:39Z (14,257 entries), with the stack's own
readers (`componentReadPlan`, `componentPeersOf`, `readPackedPatchTexts`,
`patchComponentNames`, `readPackedDeclarations`, `unloadableBundle`,
`dshPeersOf`) and each dsh's own `evaluatePluginCompatibility`, with no
exemptions:

| Case | 2026-09-28, 0.1.7-rc.2 | 2026-10-10, 0.1.7-rc.2 | 2026-10-10, 0.2.0-rc.2 | 2026-10-10, 0.2.1-alpha.1 |
|---|---|---|---|---|
| github entry whose own peers dsh refuses after pnpm | 273 | 586 | 1,270 | 1,518 |
| npm bundle with a refused exact-pinned component, its own card enabled | 1 | 3 | 2 | 5 |
| `dsh.bundle` that no dsh runs, npm + github | 23 + 6 | 1 + 5 | 1 + 5 | 1 + 5 |
| npm cards already disabled on their own peers | 349 | 766 | 1,367 | 1,779 |

- dsh's `latest` is now 0.2.0-rc.2, and a caret range on a 0.x version
  stops below the next minor. The most frequent refused ranges are
  `^0.1.0-rc.6` pins: `dsh-tools` 196, `dsh-client-runtime` 146, `dsh-llm`
  110. On 0.2.0-rc.2, 1,270 of the 8,089 github entries read are refused
  (15.7%), 104 of them among the 316 release-rescued entries read. Section
  7.3's judgment predicts 1,269 of the 1,270, each with its exemption
  command.
- Section 5.4's 23 npm delistings cleared themselves: `@liuhange/dsh-*`
  republished with `"patch": "./cordis.patch.yml"`. One npm entry and five
  github entries are left.
- Not read: 33 release assets that timed out twice at 300 s (at most 33
  more refusals), 4 repositories that GraphQL could not resolve, and 6
  manifests that are not JSON.

LivXue chose on 2026-10-10 to build the github half alone, on main, from
the stack's reviewed code:

- **Built:**
  - Section 6.1's `dshPeers` and `manifestVersion` on github candidates,
    through the one declarations writer, for a commit-pinned root, a
    subpackage, and a release-rescued root's packed manifest.
  - Section 6.2's rule bump, `DECLARATIONS_RULE` 1 -> 2. Its re-read writes
    those two fields.
  - Both fields on github catalog entries, counted toward section 6.3's
    payload budget.
- **Built by the shop change that follows the registry's:**
  - Section 7.3 for an entry's own peers. A github entry is judged as
    `{ name, version: manifestVersion, peerDependencies: dshPeers }`, and its
    command is built from `name@manifestVersion`.
  - The card is the npm card's `harness-peers` blocker, unchanged.
- **Not built:** section 4 (npm components: 2 bundles on 0.2.0-rc.2),
  section 5 (the unloadable-bundle rule: 6 entries), and section 7.1's
  `components` declaration, 7.2 and the component half of 7.3 and 7.4.
  Building section 5 for github later takes `DECLARATIONS_RULE` 3 and
  another full re-read, which costs what section 6.2 counts.
- **Order:**
  1. The registry change lands first, with this document. Its pull
     request's zero-write dry run re-reads the first slice of
     repositories, and the backfill takes about three catalog runs.
  2. The shop's verdict follows as a beta, checked by hand on a real
     0.2.0-rc.2 profile against the live catalog: a refused github card
     shows dsh's sentence and the command, and after the command and
     Refresh it installs.
  3. Until a repository is re-read, its entries carry neither field, and
     the shop forms no verdict for them, as it does today.
