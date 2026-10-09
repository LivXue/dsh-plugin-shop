# Archived repositories marked, and a shadowed install recoverable — design

Status: **C5 probe + C10 MVP merged 2026-10-08 and 2026-10-09 (PRs #81,
#83). C5 surface PR in implementation 2026-10-09, direction D1 (GraphQL
bulk), chosen by LivXue 2026-10-09.** Two borrowings from
`2026-09-26-market-borrowings.md` §6: **C5** (archived GitHub
repositories) and **C10** (a GitHub install stranded when an npm package
shadows the name). Decisions taken on 2026-10-08:

- **C5 decision: C.** Mark every archived repository in the catalog, refuse
  nothing. Not option A (delist archived on sight: archived is a one-way
  state and the deletion would be hard to reverse when GitHub re-opens one)
  and not option B (refuse new, mark old) because both refuse-to-list moves
  were measured against the wrong precedent — the right one is the daily
  catalog's own `deprecated` marker for npm packages: it does not delist, it
  marks, and the shelf shows "作者已弃用". An archived GitHub repository is
  the same shape of fact about the package.
- **C5 cadence: P.** A tiny probe PR first: read the `archived` boolean the
  GitHub search/harvest already returns and persist it into
  `registry/repo-state.json`. The next daily catalog build tells us the real
  archive share over the 8,163 listed github entries, and the
  surface-the-flag PR that follows starts from a measured number, not a
  guess. A3's precedent — `Measured 2026-10-07 on the catalog built
  2026-10-06T17:06Z, over all 7,817 commit-pinned github entries` — is what
  kept that surgery honest at 547 rows; the same discipline applies here at
  the same order of magnitude.
- **C10 scope: MVP.** Recover control over an installed github entry the
  catalog can no longer show: an `installed()` row, an Uninstall button, a
  plain explanation. Explicitly NOT in this batch: shadowed reinstall,
  shadowed update, a picker between shadowed same-named entries, or a
  registry change.

A competitor citation below says where an idea came from; it is never the
evidence. Every claim rests on this repository, on the pinned harness
(`@deepseek-ai/dsh@0.1.5-rc.3`), or on a measurement taken here.

## 1. C5: every archived github entry is marked, none is refused

### 1.1 The observation

The github harvest already reads the repository's `archived` boolean on
every page it fetches — the field sits beside `pushed_at` and
`stargazers_count` in the search-item payload (`github-client.ts:291-323`),
and the harvest projects `pushedAt` and `stars` into `repo-state.json`
today. `archived` is silently dropped.

That boolean matters for listing policy because it is one-directional: a
repository archived on 2026-10-08 stays archived under any realistic
ecosystem outcome (the owner does not come back to unarchive). And it does
NOT break the pinned install: `manifest.lock` carries the 40-char commit
sha, GitHub does not delete archived commits, and the `codeload` tarball at
that sha keeps serving. An archived listing is degraded (no more updates,
no more issue respones), never broken.

Idea source: 2bingling's `decay.ts` treats `archived` as one of five decay
kinds and surfaces it as a grey badge on the shelf; it delists nothing. Brade
and dsh-market have no handling at all.

### 1.2 The rule (probe stage)

Add `archived: boolean` to the repository record in `repo-state.json`, read
from the same search item `pushed_at` comes from. The probe PR changes
nothing else — no gate behaviour, no catalog schema, no report line. The
next daily catalog build emits a repo-state.json in which every repository
is marked archived or not, and we measure the real share.

### 1.3 The rule (surface stage, follow-up PR)

**Amended 2026-10-09 after the probe measurement landed.** The probe
produced a falsified premise: over the `repo-state.json` that the first
post-probe catalog build committed (909d6fa), every one of the 20,306
recorded repositories carried `archived: false` — including the entries
the live catalog lists. The GitHub search REST endpoint does not carry
`archived` on its items, contrary to what §1.2 assumed when the probe was
designed. The read `parseRepoMeta` now performs is a no-op for every
repository the harvest has ever seen.

The surface PR therefore needs the value from a source that actually
carries it. The design is GraphQL bulk, which `github-stars.ts` already
uses for the daily star counts and whose cost fits the existing daily
budget without a new pipeline:

- **Fetch**: a per-build pass over the LISTED github repositories (the
  ~8,163 in the current catalog, not the full 20,306 repo-state pool)
  queries `isArchived` in batches of 200, as per-repo aliases the way
  `fetchStarCounts` does — ~41 calls a build, inside the 5,000-point
  hourly budget the star pass already amortizes. The pass lives beside
  `fetchStarCounts` in
  `github-stars.ts`, sharing its timeout / `withTimeout` / auth handling.
- **Persist**: `repo-state.json`'s per-repository `archived` field is
  written from the GraphQL answer, not from the search projection (whose
  read is removed in the same change — leaving it in place would keep a
  known-broken input live, the "additive key whose consumer never landed"
  failure mode in reverse).
- **Unanswerable**: a batch that errors, or a repo the GraphQL response
  omits (renamed, transferred, deleted between the search and the batch),
  leaves the record unchanged. A repo is never marked `archived: false`
  on the strength of a missing answer — "no fact supplied ⇒ no write",
  the same rule the probe's `nextRepoState` arm already carries.
- **Emit**: `plugins.<sha>.json` gains `archived?: true` on each github
  entry whose repo-state record holds `archived: true` (omitted otherwise;
  additive, like `dshPeers`). The build report gains one line,
  `github entries from archived repositories: N` — this is the line the
  probe PR deliberately did NOT carry (R5), landing here where the field
  first reaches the published catalog.
- **Shop**: `host/catalog.ts` parses the field through the existing zod
  schema with `.optional()`; the shelf card shows a subdued badge
  `已归档 / Archived` beside the version, in the same subdued register as
  the existing `tierCommunity`/`tierShadowed` badges — informational, not
  the warn tint of `tierVerifiedStale`. Bilingual locale keys
  `archivedBadge` in `locales.ts`.

Refusing nothing means the shelving, the `Outdated` verdict, the install
button, and the harvest's coverage arithmetic are all unchanged. The
shop release that exposes the badge goes through the beta channel per
the release rule for "a version that changes what the host reads" — the
schema adds a field the host now parses.

**Measurement the surface PR reports on its first catalog run**: the
share of listed github entries whose repo is archived. Prior to this
amendment the design promised that number from the probe alone; the
probe proved the probe could not see it, and the surface PR is what
measures it for real.

### 1.4 Not built

- **Refusing or delisting** on `archived`. Option C is the recorded decision
  (§"Status" above); revisiting is a separate design with the measured share
  as its input.
- **Marking npm packages whose *repository* is archived.** npm entries carry
  a repository URL, but it is author-declared text, not an observed fact
  about the package; crossing that bridge is a separate design.

## 2. C10 (MVP): an install the catalog can no longer show keeps its Uninstall

### 2.1 The defect

`installed()` (`host/index.ts:1730`) iterates the catalog snapshot and, for
every entry, looks up the profile manifest's dependency spec by name
(`ownDependencySpec`), skipping the entry when the spec does not match
(`installedSpecMatches`). A shadowed github entry has no catalog row (the
pipeline refuses it `shadowed-by-npm`, `pipeline.ts:227-231`), so the loop
never visits it — but the profile manifest still holds its spec. The reader
who installed it yesterday now has a dependency that no card names, no
switch toggles, no Uninstall removes.

The same shape of loss holds for a fork the catalog never listed and a
pulled-then-reinstalled package (§A2's departures), but those are out of
this section's scope: the shadowed-github case is the one where the SHOP
ITSELF installed the thing, through the Install button, when the catalog
still listed it.

Measured directly from the live catalog fetched 2026-10-08 (the committed
`tests/fixtures/plugins-live.json`, 14,167 entries): npm names and github
repos collide at exactly **26 bundle names** — the 26 github installs a
reader can hold whose catalog card is gone today. The measurement script
lives in the batch ledger (`shadowedCount` against the fixture); the
mechanism, not the count, is the defect.

### 2.2 The rule (MVP)

`installed()` keeps its current iteration (catalog rows it can show) and
adds a second pass over the profile manifest's own dependencies, after the
loop. For every manifest name NO catalog row claimed:

- **`parseSpec`** on the spec decides, as it does everywhere else
  (`host/install.ts:124-127` reads the same verdict). The MVP handles
  `{ kind: 'github', repo }` only. An npm-shaped spec with no catalog row is
  a departure (§A2), the departed-package card the C10 follow-up may add —
  not this batch.
- The row synthesized is a `ShopInstalledEntry` with the identity the spec
  can carry: `source: 'github'`, `repo`, no `subdir` (a spec does not name
  one), `installed` = the recorded pin or the spec itself, `latest: null`,
  `outdated: false` (there is no catalog truth to compare against), and the
  enabled bit from the same `enabledOf` the normal path uses.
- The card renders with a badge (`shadowedBadge: '目录未列出此包'` /
  `'Not in the current catalog'`), an explanatory line naming the catalog
  fact and listing the causes this mechanism covers ("此包已安装，但当前的插件目录没有它（可能是被同名 npm 包遮蔽、作者已下架、或目录尚未收录）；它照常运行。"
  / "This package is installed but the current catalog does not list it (it
  may be shadowed by a same-named npm package, removed by the author, or
  never listed); it runs as before."), an **Uninstall** button, and no
  Install / Update / Enable buttons. The badge names the catalog fact
  rather than the npm-twin cause because the mechanism synthesizes this row
  for any github spec no catalog row claims — an unlisted fork, a removed
  listing, or a same-named conflict with a different repo too — and a word
  covering more cases than it says is worse than one wider and accurate.

**`uninstall` gains a shadowed arm.** Today's RPC refuses
`snapshot.entries.length === 0` with "is not in the catalog"
(`host/index.ts:1840`); a shadowed github install has no catalog row by
definition, so the button the card offers would otherwise refuse itself.
The rule re-uses the same `parseSpec` reading: when no catalog entry
matches the name AND the manifest spec parses as `{ kind: 'github' }`, the
uninstall proceeds through the same removal path the matched arm uses —
the profile manifest is the truth here, not the snapshot. npm-shaped
unmatched specs and unparseable ones keep today's refusal (the MVP's
scope guard).

Nothing about this touches the gate, the harvest, or `manifest.lock`. The
files in play are `host/index.ts` (the second pass in `installed()`, the
shadowed arm in `uninstall`), `client/ShopTab.tsx` (the badge + the
reduced action set), `client/locales.ts` (the three strings), and the
tests. The pure presentation decision goes where the other presentation
decisions live: the existing card variant for a known-but-unlisted install
(`reviewedVersionLine`, `deniedCode`) is the model.

### 2.3 Not built (the follow-up's list)

- **Shadowed reinstall**: a reader uninstalling the shadowed entry and
  wanting it back later. The npm package still shadows; the shop would have
  to special-case past the gate. A separate design.
- **Shadowed update**: the entry has no `latest`, so no update verdict is
  meaningful. Out of scope for the same reason.
- **A picker**: a same-named pair (the listed npm entry and the shadowed
  github entry) offered side by side at install time. The current Install
  gate's `nameTakenCode` already refuses the collision; letting the reader
  CHOOSE is a different UX.
- **The npm departure case** (§A2's rows): a `deprecated`/`npm-gone` npm
  entry whose card needs the same recovery treatment. Same shape, different
  fact, next batch.

## 3. Testing

- **C5 probe**: a fixture search response with one `archived: true` item
  lands `true` in the repo-state record; the field round-trips through
  `diffRepoState`; an absent `archived` in an old repo-state.json parses
  (the field is optional on read).
- **C10**: at the host, an `installed()` fixture whose manifest holds
  `github:owner/slug` while the catalog holds only the npm entry of the same
  name — the synthesized row appears, with `latest: null` and the shadowed
  identity; an npm-shaped spec with no catalog row produces NO row (the
  scope guard); an unparseable spec produces no row. At `uninstallStart`, a
  name with no catalog row and a github-shaped manifest spec proceeds; the
  same name with an npm-shaped spec still refuses "not in the catalog", and
  an unparseable spec refuses the same way. At the client, the shadowed
  card renders the badge and the explanatory line, offers Uninstall, and
  offers no Install / Update / Enable; clicking Uninstall on it reaches
  the RPC (and, in the e2e, actually removes the manifest row). The
  `installedSpecs` RPC stays byte-identical — the MVP reads what it already
  reads.

## 4. Order

Two PRs, in this order:

1. **`feat/archived-probe`** (registry only): the `archived` read, the
   repo-state persistence, the diff round-trip, one report line. Zero shop
   surface. One catalog run shows the measured share.
2. **`feat/shadowed-recovery`** (shop host + client): the C10 MVP section.
   Held until the measurement PR has merged, because it rebases on the same
   `host/index.ts` neighbourhood as no other branch — a soft sequencing
   constraint, not a hard one.

The C5 surface PR waits for the measurement and is not in this batch.
