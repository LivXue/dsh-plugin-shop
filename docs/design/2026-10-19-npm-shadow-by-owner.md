# An npm package hides only its own owner's repositories — design

Status: **chosen** (2026-10-19). Issue #88 surfaced it. LivXue chose this
option the same day over the alternative, which kept the rule, reworded its
detail and asked the issue's author to rename. It amends, in the same
change:

- the npm-wins sentence of the 2026-08-30 amendment in
  `2026-08-18-dsh-plugin-shop-design.md`;
- the four places `2026-08-30-github-install-channel.md` states that
  rule (§6);
- the "npm shadows GitHub" bullet of
  `docs/superpowers/specs/2026-08-26-llm-categorization-design.md` (§6);
- the "npm-published subpackages" bullet of `2026-08-31-hub-borrowings.md`
  (§6);
- the **Channel moves** risk of `2026-10-04-change-feed-harvest.md` (§6);
- the code pointer `2026-10-08-archived-flag-and-shadowed-recovery.md` gives
  for the refusal, which this change moves (§6).

English only, per convention.

Every figure below was measured on 2026-10-19 against these sources:

- the build of 06:25Z: its published `v1/report.md` and
  `plugins.c2fc6c02….json`;
- `registry/repo-state.json` at `origin/main` `cf44ee5`;
- `origin/main`'s own `gateRepo`, replayed offline on the recorded
  candidates;
- for the renames and transfers in §2, GitHub's REST and GraphQL APIs,
  read-only, which follow both.

## 1. Why

**The rule.** `selectEntries` (`pipeline.ts:207-235` at `cf44ee5`) collects
the bundle names of the ACCEPTED npm packages. It refuses every repository candidate
whose bundle name is among them, as `shadowed-by-npm`, with one detail:

> The npm package X is already listed; the repository is not listed
> separately.

`selectPending` (`classify-select.ts:54-73` at `cf44ee5`) mirrors the rule.

The channel design chose this rule for one project published on both
channels: "real semver beats a commit pin". It never considered two projects
that happen to choose one name.

**What it does to two projects.** The repository in issue #88 is an
independent plugin.

- **History.** The 2026-10-12 build first harvested
  `gulagala001/dsh-intelligent-ui`, and every build since has refused it.
- **On its own merits it passes.** Gated alone, it is accepted:
  release-rescued at `v0.2.1-alpha.2.iui.1.0.0`, with a pinned sha256 that
  equals the author's `SHA256SUMS.txt`.
- **The namesake is someone else's.** The npm package `dsh-intelligent-ui`
  is yunyv's, published from `yunyv/dsh-intelligent-ui`. The two
  repositories have different root commits.

So the detail tells the author that their repository is that package's
source, and it is not. CLAUDE.md treats a misattributed reason in a
published artifact as a defect.

**How often.** 5,957 rows of the report read `shadowed-by-npm`. Each is
classed by a string comparison, case-folded: the `owner/name` the npm
package's `repository` reads as, against the candidate's `repo`.

| the npm package's `repository`, as a string | rows |
|---|---|
| is the candidate's own `owner/name` | 4,581 |
| is a different `owner/name` of the same owner | 47 |
| is not a `https://github.com/<owner>/<name>` URL | 23 |
| is an `owner/name` of another owner | 1,306 |

A string does not follow a rename or a transfer, and GitHub does: 21 of the
47 and 28 of the 1,306 are the candidate itself (§2).

Of the 1,306 rows whose npm package names another owner:

- 796 pass the repository gate on their own, across 488 bundle names. The
  796 rows come from 791 repositories, and 161 of those were listed before:
  each appears in an earlier committed `manifest.lock`, and is hidden
  today. 16 of the 796 are among the 28.
- 510 do not. Today they are refused with a reason that is not theirs,
  except the other 12 of the 28, which are the npm package's own
  repository.

A sample of 40 gate-passing rows from the last three classes, drawn with
seed 88:

- 34 have git histories of their own;
- 4 share a root commit with the repository their npm namesake names:
  - two of the 4 are same-owner, one of them the candidate itself under an
    earlier name (§2);
  - the other two are independent repositories, copies rather than GitHub
    transfers;
- 2 could not be read.

## 2. The rule

An ACCEPTED npm package hides a repository candidate of the same bundle name
in exactly two cases.

1. **Same owner.** Its `repository` reads as
   `https://github.com/<owner>/<name>` (`githubOwnerName`, unchanged), and
   `<owner>` equals the candidate's owner, case-folded.
   - The candidate's owner is the part of its `repo` before the slash: the
     search's own `owner/slug`, not the candidate's `repository` URL.
   - Case-folding is `toLowerCase`, as `firstSeenKey` and the denial lookup
     fold it. GitHub logins are ASCII, so no locale enters.
   - This covers both a `repository` that is the candidate's own
     `owner/name` (4,581 rows) and one that is a different `owner/name` of
     the same owner (47 rows). Both are string comparisons: 21 of the 47
     resolve on GitHub to the candidate itself under an earlier name.
   - Which of the two applies decides only the detail (§3). It is the whole
     `owner/name`, case-folded the same way.
2. **Nothing to compare.** Its `repository` does not read that way: another
   host, or an `ssh://` or `github:` spelling (23 rows). Today's behaviour
   stands.

Every other candidate goes through `gateRepo` as if no npm package had its
name. A rejected npm package hides nothing (B-6, unchanged).

What follows from it:

- **It never hides more than today.** Both cases require an accepted npm
  package of the name, and that is today's whole condition. No listed entry
  can disappear because of this change: it only lists.
- **It decides from two strings already in hand**: the npm candidate's
  `repository` and the repository candidate's `repo`. It stays in the pure
  core, and it adds no request.
- **It trusts a claim.** An npm package's `repository` is whatever its author
  wrote. An author who names someone else's repository hides that
  repository. Today any author hides it without naming anything, so this is
  never worse than today.
- **The owner is the line.** Both strings carry a GitHub login, the one
  identity the two channels share. Under one owner, a second repository of
  the same name is that owner's own project in another place, not someone
  else's plugin. The sample bears this out: of its two same-owner rows that
  share a root commit, one is a second repository of one project
  (`1624318455/dsh-plugin-proxy`), and the other is the npm package's own
  repository under an earlier name (`ZhenXifu/dsh-plugin`, now
  `ZhenXifu/dsh-collapsible-models`).

  The line is a string comparison: the login the package's `repository`
  was written with, against the one the GitHub search returned for the
  candidate. GitHub follows a renamed repository, a transferred one and a
  renamed account, and a string does not. Only the last two break the line.
  Measured against GitHub's API on 2026-10-19:
  - A rename keeps the owner, so the line holds and the row stays hidden,
    under the same-owner detail. 21 of the 47 same-owner rows (18 of their
    44 repositories) are the candidate itself under an earlier name, such as
    `huaxiren6/dsh-email-reader`, now `huaxiren6/DSH-EmailReader`.
  - A transfer or an account rename changes the owner, so the line breaks:
    the npm package's own repository reads as another owner's. 28 of the
    1,306 other-owner rows are this case. 16 pass the gate and are listed beside their own
    npm package, a second card for one project, among them `QIN-SMART/*`,
    now `DEVbyQIN/*` (4 rows), and `acryldev/*`, now `cordisplugins/*` (3
    rows). The other 12 are refused for their own reasons.

  Resolving them is not built (§9).
- **An impersonator is listed too.** Any other owner's same-named
  repository that passes the gate is now listed beside the npm package. The
  only preventive defence against impersonation is the verified-name hold:
  `repo-gate.ts` probes every verified bundle name and holds even an exact
  match (distance 0), and `verified.yml` is empty by design. After the fact,
  a `denied.yml` row naming the repository delists it, as it delists any
  github entry. This is the same exposure the 304 names already shared by
  github entries have.

## 3. What the report says

The code stays `shadowed-by-npm`, because a new code is a change to a
published artifact (CLAUDE.md). The detail changes. It now says which case
applies, names the npm package, and names the repository it points at
whenever that `owner/name` is not this one's.

- **The npm package names this repository.** "The npm package X names this
  repository as its source and is already listed; the repository is not
  listed separately."
- **It names a different `owner/name` of the same owner.** "The npm package
  X is already listed and names owner/other as its source: a repository of
  the same owner, either this one under an earlier name or another. This
  repository is not listed separately. If it is a different plugin, giving
  it a package name of its own lets the catalog judge it on its own." A
  string cannot tell the two apart, and 21 of the 47 rows name this
  repository under an earlier name (§2).
- **Its repository is not a plain GitHub URL.** "The npm package X is already
  listed, and the repository it names is not a plain
  https://github.com/owner/name URL, so this repository cannot be told apart
  from it and is not listed separately. If it is a different plugin, giving
  it a package name of its own lets the catalog judge it on its own."

The wording is the builder's, within those facts. Every variant keeps
"already listed" and the npm package's name.

A hidden candidate never reaches `gateRepo`, as today. So the hint promises a
judgement, not a listing: the repository behind such a row may still fail
the gate on its own.

The repository a detail names comes from `githubOwnerName`, so only an owner
and a name reach the report, through its existing cell escaping.

## 4. One predicate, two readers

`selectEntries` and `selectPending` must agree on which candidates are
hidden. When they disagree, a name the build lists drops out of `liveNames`,
and the next prune deletes its category row. That is the failure
`repoPeersEmitted` was extracted to end (design
2026-09-01-harness-compatibility §9.8).

So the rule is one exported pure function, and both call it:

- `selectPending` reads its verdict;
- `selectEntries` reads its verdict and its detail.

The builder chooses where it lives and what it is called. Both readers also
build the map it reads, each accepted npm package's name to the repository
it declares, with one function (`acceptedNpmRepositories`), so a change to
how that map is built reaches both.

**Same rule, not the same snapshot.** One function gives a candidate the
same verdict in both readers. It does not give both readers the same
candidates. The classifier reads the committed `repo-state.json`, one build
behind the harvest the build gates (`selectPending`'s docstring). A
repository that changed between the two snapshots is judged by the build
first and by the classifier on the next run. Under the old rule a changed
bundle name did that. This rule also reads the owner, so a transfer or an
account rename does too. For that one build:

- a repository the build now lists has its name classified on the next run,
  and reads `other` until then if the name has no category row;
- a repository the build now hides keeps its name's row, or has it asked
  for, one run longer.

That is the "unclassified, retried next build" state D4 defines, which every
newly harvested repository already spends one build in, and the next run
ends it. harness-compatibility §9.8's disagreement recurred on every run.
Giving the classifier the build's own GitHub harvest would close the lag at
the price `selectPending`'s docstring declines: GitHub requests in the
classify step, which could advance the harvest state.

**What the classifier sees.** A newly listed derived entry shares its bundle
name's category row (`gate` and `gateRepo` look it up by bundle name).
That is already true of the 304 names that two github entries share today.
Measured, no newly listed name lacks a row, so the change asks the
classifier nothing new.

A market verdict in `markets.yml` and the `notAShop` list
(`emit.ts:279-283`) are keyed by name too, so each covers both entries.

## 5. The catalog's consumers

The catalog is data. Every installed shop reads a new catalog the day it is
published, and data has no beta channel: CLAUDE.md's release channels hold
the shop, not the catalog. So the released shops must already handle an npm
entry and a github entry of one name, because the first such pair reaches
them all at once.

**From 0.8.0 on, they do.** The audit (2026-10-19) read two refs, and the
line numbers below are theirs:

- `origin/main` at `cf44ee5`, whose `src/host` and `src/shared` are
  byte-identical to v0.8.7's, the npm `latest`;
- v0.8.5, for the install path.

0.8.0 through 0.8.4 carry the same two identity commits (`6f2334a`,
`d9ab214`, 2026-09-04, first released in 0.8.0-beta.0). What the audit
found:

- **Parse.** Each entry is validated alone, and nothing is keyed by name
  (`catalog.ts:123-387`). Stars key npm entries by name and github entries by
  repo (`stars-assemble.ts:77,84`).
- **Installed.** `installedSpecMatches` (`shared/identity.ts:134-137`)
  attributes a dependency spec to one source, so one dependency is never
  shown as both entries:
  - an npm range or version goes to the npm entry;
  - a `github:` spec goes to the github entry, comparing the repository
    case-insensitively;
  - an https release-tarball URL goes to the github entry, because pnpm
    9.15.9, 10.15.0 and 11.13.0 all record the URL as given;
  - a spec it cannot attribute (`file:`, `link:`, an `npm:` alias) goes to
    the npm entry, the documented tie-break.
- **Install.**
  - Every client from 0.8.0 on sends source, repo and subdir
    (`installTarget` in `ShopTab.tsx`, read at v0.8.0, v0.8.4 and v0.8.5).
  - `validateInstall` (`install.ts:101-107`) finds the entry by identity, and
    the host builds the spec from the entry it found.
  - A request that names only a duplicated name is refused as ambiguous
    (`install.ts:89-100`).
- **Uninstall.** An uninstall removes the one dependency of that name.
- **Updates.** An update verdict is formed on the row that matched.
- **Name taken.** The name-taken blocker (`present.ts:240-254`, mirrored by
  `install.ts:123-141`) marks only the sibling that is not installed.
- **Keyed by name on purpose.** These describe the one package on disk:
  - the page-removed set;
  - the imported set;
  - hot-mount handles.

  The not-a-shop clearance and the install-time denial check go by name as
  well, so one `markets.yml` verdict or one denial covers both siblings. The
  repository gate also denies by bundle name.

0.9.0-beta.2, on `beta` since 2026-10-20, changed `src/host` and `src/client`
after the audit (dsh 0.2.1 support). §7's shop pins pass unchanged on its
source, `6864aff`.

**Before 0.8.0, they do not.** Consider the releases between the first that
reads schema 5 (2026-08-31) and the identity commits. They address an
install by name (`entries.find(e => e.name === args.name)`, read at
`6f2334a^`). The catalog emits a same-name pair github first, because
`compareEntries` puts `'github'` before `'npm'`. So in those shops, Install
on either card resolves to the github entry. Every name that two github
entries share (304 of them) already resolves this way there.

Last week they were 4 of the shop's 738 npm downloads: 0.7.1-beta.0,
0.7.1-beta.1, and 0.7.3-beta.0 twice. My call is no mitigation, because
none exists:

- a schema bump would make every shop refuse the catalog, `latest`
  included;
- no catalog order serves both cards in such a shop.

**Two edges, neither new with mixed sources.**

- **"View in shop"** (0.9.0-beta.1 and 0.9.0-beta.2 only) finds a card by name
  (`ShopDetailAction.tsx:90`).
  - With both siblings on the shelf, it only sets the search, which shows
    both.
  - With one of them hidden (by the incompatible filter, say), it opens the
    visible one, even when the hidden one is installed.
  - Github pairs behave this way today.
- **Racing installs.** The install gate reads only the profile manifest.
  Install on the sibling, pressed while the first install is still running,
  passes the gate, and the second install overwrites the first. Github pairs
  behave this way today.

**Newest.** The Newest order (最新上架) sorts on `added` (`present.ts:771-777`,
the same in v0.8.7; v0.8.5 and v0.8.6 have no date order). `added` is the day
an identity first reached the catalog: its `first-seen.yml` row, or else the
build day. Of the 796 rows this change lists (791 repositories):

- 166 rows (161 repositories) were listed before and return with their
  recorded date. Each appears in an earlier `manifest.lock`, first in August
  (25), September (101) or October (35).
- The other 630 read "listed" on the day the change ships, beside that day's
  own newcomers: 51 to 570 a day over the last ten builds.

My call is to let them read so. That is the day they reach the shelf, and a
backfilled date would publish a day on which they were not listed. The next
day's newcomers sort above them.

## 6. Docs amended in the same change

- **The main design**: `2026-08-18-dsh-plugin-shop-design.md`, the
  2026-08-30 amendment. "npm wins when a repo's bundle name already ships as
  an npm package (`shadowed-by-npm`, with a reason)" gains an inline
  **narrowed 2026-10-19** note that states §2's two cases and cites this
  design.
- **The channel design**: `2026-08-30-github-install-channel.md`. Four
  places state the rule, and each gains the same note:
  - its status header ("npm wins the bundle-name dedup");
  - its **Non-goals** bullet ("the npm entry wins");
  - decision 3;
  - the **Union** bullet of its architecture section.
- **The classifier spec**:
  `docs/superpowers/specs/2026-08-26-llm-categorization-design.md`. Its "npm
  shadows GitHub" bullet no longer says every repository of an accepted npm
  name is skipped: only what `npmShadowOf` hides is, and another owner's
  repository goes on to the gate. It also says that the classifier applies
  the rule to the committed snapshot, so a transfer or an account rename
  waits one run (§4).
- **The subpackage design**: `2026-08-31-hub-borrowings.md`. Its
  "npm-published subpackages" bullet says the npm entry wins by bundle name.
  It gains the same note: a subpackage of another owner's repository is
  gated on its own and listed beside the npm entry if it passes, as
  `pipeline.test.ts`'s "lists each subpackage of another owner's repository
  beside the npm package" pins.
- **The change-feed design**: `2026-10-04-change-feed-harvest.md`, its
  **Channel moves** risk (:614-617). It expected a moved package's GitHub
  entry to become `shadowed-by-npm`, and nothing else. That holds when the
  npm package's `repository` names that repository or another of its
  owner's. When it names another owner's, as after a transfer or an account
  rename (28 rows on 2026-10-19, §2), the GitHub entry is listed beside the
  package. The risk now says so, so that a dry run's diff showing such a pair
  is not read as a regression.
- **A pointer this change moves**:
  `2026-10-08-archived-flag-and-shadowed-recovery.md` :149 cited
  `pipeline.ts:227-231` for the refusal. It now names `npmShadowOf`, which
  decides it, and `selectEntries`, which records the row.
- **`gate.ts`'s A-2 comment** says an npm publisher would "shadow the
  verified repository". It now does so by naming that repository, or
  another of its owner's, as its source, or by declaring a `repository`
  that is not a plain GitHub URL; one naming another owner's repository
  is listed beside it.
  The comment is reworded to stay true. The hold it explains is unchanged.
- **`gate.ts`'s denial comment** says the npm package wins the bundle name
  "by design". The case it describes still holds: a denied repository's
  author publishes the same code to npm, from that repository. The
  parenthetical now says what the design is: npm wins over its own
  repository.
- **Checked and still true:**
  - `2026-10-04-change-feed-harvest.md` :132;
  - `2026-09-26-market-borrowings.md` :543;
  - `2026-08-31-market-borrowings.md` :126-128, E11: it asserts that no two
    entries share an install identity, and a same-name npm and github pair
    does not;
  - the main design's :396;
  - `2026-10-08-archived-flag-and-shadowed-recovery.md`, whose recovery
    still covers the installs §2 keeps hidden. Its title for C10 (:7-8),
    like `2026-09-26-market-borrowings.md` :350's, names the install an npm
    package strands by shadowing it, which §2 still does for those.
- **Nothing to change:** `docs/schema.md`, `CONTRIBUTING.md`, the READMEs and
  CLAUDE.md do not state the rule.
- **Deferred to the next shop change.** Shop source is frozen on this branch:
  its commits change nothing under `packages/dsh-plugin-shop/src`. So four
  comments there on the §C10 recovery row keep the old rule until then
  (lines as on `6864aff`):
  - `host/index.ts:332-336`, on `ShopInstalledEntry.shadowed`;
  - `host/index.ts:1959-1962`, on the uninstall path's shadowed-github arm;
  - `client/ShopTab.tsx:1342-1344`, on `ShadowedSection`;
  - `client/ShopTab.module.css:880-881`, on the shadowed badge.

  Each ties the row to a `shadowed-by-npm` refusal that an npm entry holding
  the name used to imply; under §2 it is implied only when the npm package
  names the dependency's owner, or a `repository` that is not a plain GitHub
  URL. The user-facing `shadowedDetail` ("it may be shadowed by a same-named
  npm package, removed by the author, or never listed") stays true.

## 7. Testing

Registry: the pure core, driven by fixtures.

- **Each case of §2 with its detail:**
  - the npm package's own repository;
  - a monorepo subpackage of it;
  - a different `owner/name` of the same owner, with the owner in a
    different case;
  - the own and the same-owner case again, with the candidate's `repo` in
    mixed case against a lower-case URL, so that the candidate side's fold
    is pinned too;
  - a `repository` that is not a plain GitHub URL.
- **Another owner's repository** is listed beside the npm entry. Both reach
  `plugins.json`, sorted by `compareEntries` (the github entry before the npm
  one) with distinct install identities. The determinism property holds for
  the pair: input order changes no artifact byte.
- **B-6** still holds: a rejected npm package hides nothing.
- **`selectPending` agrees with `selectEntries`** on the same fixtures.
  Another owner's derived repository is live, and pending when its name has
  no row. A hidden one is neither. The fixtures are the same for both on
  purpose: §4's lag comes from the inputs, not from the rule.
- **`acceptedNpmRepositories`** maps each accepted package to the repository
  it declares, unchanged.
- **Existing cases built on cross-owner pairs** (lines as on `cf44ee5`) —
  every npm fixture names a `you/…` repository:
  - `pipeline.test.ts:361` shadows `someone/dsh-repo-plugin` with npm
    `dsh-hello-plugin`;
  - `pipeline.test.ts:748` shadows `dave/monorepo`;
  - `classify-select.test.ts:85` shadows `someone/dsh-repo-plugin` with a
    declared `dsh-same-name`;
  - `classify-select.test.ts:103` classifies a repository whose npm
    namesake the gate rejected. Under §2 another owner's repository is
    classified anyway, so the case would pass on the owner alone.

  Each moves to a same-owner pair so that it keeps testing what its title
  says, and its commit says why. The old pairs become the new
  another-owner cases.
- **`repo-gate.test.ts:273`'s comment** names `npmNames`. It follows any
  rename.

The shop: §5's behaviour is pinned by fixtures holding one npm entry and one
github entry of one name.

- `installed()` for each spec form §5 lists;
- `validateInstall`, by identity and for a name-only request;
- the name-taken verdict for each sibling.

They pass on today's code. They exist so that the next change to those
paths meets a pair.

- `identity.test.ts` already pairs `npmEntry` and `repoEntry`, both
  `dsh-foo`, for the identity functions themselves.
- One catalog-level fixture holds a pair. `index.test.ts`'s G-1 case "does
  not let an npm namesake claim a repo entry's installed row" gives
  `installed()` an npm entry and a github entry of one name, for a
  `github:` spec.
- The other spec forms, `validateInstall` and the client have met only two
  github entries of one name, or one side at a time.

## 8. Verification and rollout

0. **The shop's pins come first.** Write §7's shop fixtures before any
   registry code, against today's code.
   - If one fails, stop. §5's premise, that no shop release is needed before
     the catalog carries a pair, is then false, and the order changes: the
     shop fix comes first and reaches `latest` before this change.
1. **Offline replay.** The new function, run over `repo-state.json` and the
   published npm entries, reproduces §1's table and these totals:
   - 796 listed;
   - 510 refused for their own reasons;
   - 4,651 still `shadowed-by-npm`: 4,581 + 47 + 23.
2. **The PR's catalog dry run**, ~110 minutes and zero writes. Its classify
   step stopped on the npm tail cap in three of the four runs before
   2026-10-19 09:00Z. A run that clears the cap shows the report diff above.
   A run stopped on the cap says nothing about this change, which is pure and
   replayed in step 1. That is the precedent of PR #101, merged with its dry
   run stopped on the same cap.
3. **Merge, then the first main build.**
   - #88's repository is listed from its carried record. No re-fetch is
     needed: the record already holds the rescued release.
   - Its name carries three cards: yunyv's npm package, and two
     repositories that each pass the gate alone, `gulagala001/…` and
     `StarsHarryZhu/dsh-intelligent-UI`.
   - Issue #88 then gets the follow-up the first reply promises.

## 9. Not built

- **Telling copies from independent projects by git history.** It needs a
  request per pair, and a copy that starts a fresh history escapes it
  anyway. Under this change a copy pushed under another account is listed
  beside the npm package, as copies of github entries already are. The
  sample suggests about one in twenty of the 796.
- **Resolving renames and transfers.** §2's owner line compares strings, so
  it misses what GitHub follows.
  - 21 of the 47 same-owner rows are the candidate itself under an earlier
    name. They are hidden either way, so only their detail would change.
  - 28 of the 1,306 other-owner rows are the npm package's own repository
    after a transfer or an account rename, and 16 of those are listed
    beside it as a second card.
  - The shell could resolve them with a batched GraphQL lookup of the 685
    distinct repositories those rows declare (653 from other-owner rows and
    37 from same-owner rows, 5 in both), 60 to a request, and pass the
    result into the pure core.
  - 27 of the 653 did not resolve on 2026-10-19 (37 rows), nor did 1 of the
    37 (1 row), so the lookup needs a rule for a repository GitHub does not
    answer for.
  - It adds requests to a build whose GitHub half already runs against a
    budget.
- **Reading `ssh://` and `github:` spellings in `githubOwnerName`.** 11 of
  the 23 rows of §2's second case carry one (7 `ssh://`, 4 `github:`), from
  10 npm packages. The other 12 name another host.
  - 10 of the 11 are the npm package's own repository. They stay hidden
    either way, and only their detail would change.
  - One is another owner's: `ventisyn/dsh-approval-gate`, behind the npm
    package `dsh-approval-gate`, which declares
    `github:moon09300731/dsh-approval-gate`. It passes the gate on its own,
    so reading the spelling would list it, an issue #88 row like the 796.
    It is not a GitHub fork, but it shares its root commit with
    `moon09300731/dsh-approval-gate` and carries that history on (80
    commits against 19 on 2026-10-20), so it would be listed as another
    owner's copy, as the first bullet above already lists copies.
  - Its "no guesses" rule is shared with the stars sidecar and the denial
    check (spec 2026-08-26-github-stars-design.md §2.1).
  - Widening it is its own change, with its own effect on both.
- **Category and market rows keyed by install identity** rather than by
  name.
- **A report line counting same-name npm and github pairs.**
