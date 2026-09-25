# Harness compatibility signalling — design

Status: **implemented (2026-09-01), merged in 36ecdc2.** The catalog
gains a per-entry record of a plugin's `peerDependencies` names; the host
resolves them against the running installation; the client annotates
incompatible entries in three places and warns — never blocks — before
installing one. The authority spec
(`2026-08-18-dsh-plugin-shop-design.md`) is amended in the same change.
English only, per convention. **Amended 2026-09-04 (§7): the shop's own
declared peer RANGES are checked at load and warned about once** — the
one package whose ranges this project holds, and the one case where the
presence-only rule above leaves a real gap. **Amended 2026-09-11 (§8),
implemented 2026-09-24: the record is extended to the github channel,
which had carried none of it since that channel shipped — 61% of the
catalog — and to `dsh.compatibility`, the author's own machine-readable
declaration, which nothing in this repository read.** **Amended
2026-09-24 (§9): audited against the running harness, the verdict was
two-thirds false alarms** — 991 of the 1,493 entries it badged on the
live catalog. §9 records the audit and what changed: the verdict now
forms in two stages, the host and then the browser's module table; only
required peers are recorded; the resolver looks packages up directly and
caches nothing; and §8 is described as built.

## 0. The incident

A user installed `dsh-timeline@0.1.4` from the shop. On the next boot the
harness reported:

```
Failed to load plugins
failed to import loader entry d10c9e15 (dsh-timeline): client-modules:
require("@deepseek-ai/dsh-client-store") missed the module table — not a
platform seed word, not a materialized module, and no registered package
factory (a build-time externals drift, or a dynamic dependency that did
not arrive)
```

`dsh-timeline@0.1.4` declares sixteen peer dependencies, among them
`@deepseek-ai/dsh-client-store`. That package exists on npm only at
`0.1.2-alpha.2` — it belongs to the 0.1.2-alpha harness line. The user
runs `@deepseek-ai/dsh@0.1.1-rc.2`, whose tree does not contain it. The
plugin was built against a harness line the user is not on, and nothing
between the catalog and the install said so.

The shop listed the plugin (community tier, added 2026-08-25) and
installed it without a word. The catalog carries no compatibility fact of
any kind, so it could not have.

## 1. Evidence gathered before design

Each of these was measured against the live catalog or the installed
harness, not inferred.

- **The failing module is genuinely absent, and node resolution says so.**
  From the profile anchor, `@deepseek-ai/dsh-client-locale`,
  `@deepseek-ai/dsh-client-ui-conversation`, `@deepseek-ai/cordis` and
  `react` all resolve into the global harness tree;
  `@deepseek-ai/dsh-client-store` returns `MODULE_NOT_FOUND`. The oracle
  discriminates exactly the failing case, and it does so without any
  name pattern — `react` is not a `@deepseek-ai` package and resolves
  correctly. (Superseded 2026-09-24: `react` resolved on 0.1.1-rc.2; on
  0.1.5-rc.3 it has no package, and the browser's module table serves it
  — §9.1.)
- **That oracle is the harness's own.** `ClientModuleRegistry`
  (`@deepseek-ai/dsh-client-modules`, service name `clientModules`)
  builds its `resolvePkgJson` out of `createRequire(ctx.baseUrl)` and
  resolves each spec's `package.json` through it. Asking the same
  question the loader asks is what keeps our verdict and the runtime's
  behaviour from drifting apart. (Superseded 2026-09-24: client-side
  modules never pass through node resolution, and the loader resolves a
  row's own package, never its peers — §9.1.)
- **`clientModules.table` is NOT that oracle.** `processOne` admits an
  entry only while `entry.fiber !== undefined && !entry.disabled`, so
  the table is "what is live", not "what is available". Reading
  availability out of it would report every not-yet-loaded module as
  missing.
- **Regular dependencies must not be checked.** `temml` is a plain
  dependency of `dsh-timeline` and correctly fails to resolve before the
  install — pnpm brings it with the package. Only `peerDependencies`
  describe what the environment must already provide. (Only the
  required ones, 2026-09-24 — §9.2.)
- **Peer declarations are common and small.** In an evenly spaced
  50-entry sample of the live catalog, 36 entries (72%) declare
  peerDependencies; 35 (70%) declare at least one `@deepseek-ai/*` peer.
  The count per entry ranges 1–16.
- **Size, measured against the live 3.63 MB / 4915-entry
  `plugins.json`:** recording every peer name inline costs
  **+410 KB (+11.6%)**; restricting to `@deepseek-ai/*` saves only 11 KB
  of that; interning the names behind a shared table would cost ~74 KB
  in the sample (~90–110 KB extrapolated).
- **Version ranges would be noise.** All sixteen of `dsh-timeline`'s
  peers are declared `"*"`, as are most peers in the sample. Where a
  real range does exist, the harness's own prerelease versions
  (`0.1.1-rc.2`, `0.1.2-alpha.3`) do not satisfy ordinary semver ranges,
  so range checking would mark working plugins incompatible.

## 2. What is recorded

Each npm catalog entry gains an optional `peers`: the **names** of the
package's `peerDependencies`, verbatim from the manifest, no ranges.
(Superseded 2026-09-24: the names of its REQUIRED peers, on both
channels — §9.2, §9.8.)

```json
{
  "name": "dsh-timeline",
  "version": "0.1.4",
  "peers": ["@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store", "react", "…"]
}
```

**Names, not a derived verdict.** The catalog is one artifact served to
everyone; compatibility depends on the reader's own installation. So the
catalog records what the plugin *requires* — a reader-independent fact
copied from the manifest — and the verdict is formed on the machine that
knows the answer. Nothing in the pipeline guesses which harness version
first shipped a module, because such a map is a guess that goes stale
with every harness release and whose errors land on working plugins.

**Every peer name, unfiltered.** Filtering to `@deepseek-ai/*` saves 11 KB
of 410 KB and buys a name pattern — which this project rejects elsewhere
for good reason, and which would blind the check to a missing peer that
happens not to be a harness package. (Superseded 2026-09-24: optional
peers are now left out — by the author's own `peerDependenciesMeta`, not
by a name pattern, so the objection here still stands. §9.2.)

**Inline, not interned.** Interning would save ~300 KB, and it is
declined: `plugins.json` is a published artifact that plugin authors read
to find out how their package was listed, and indices into a side table
are not something a person reads. 11.6% on a content-addressed file that
is re-fetched only when its hash changes does not buy back that
legibility.

**Ranges are out of scope**, per the evidence above: presence-only
catches the class of failure that occurred and produces no false
positives. A false warning teaches people to ignore every warning, which
costs more than the misses. (Superseded 2026-09-24: it produced them —
two in three badges on the live catalog, §9.)

### schemaVersion 6

**Amended 2026-09-03: there is no version bump. `peers` rides
schemaVersion 5, and `PEERS_SCHEMA_VERSION` / `SHOP_CATALOG_V6` are
gone.** What follows records why the original choreography was the wrong
instrument, because the reasoning applies to the next additive field too.

`peers` is additive, and this section read that as a reason to bump —
following `SHOP_HARVEST_REPOS`, `SHOP_HARVEST_SUBPACKAGES` and
`SHOP_CATALOG_V5` before it. But those precedents are not alike.
`SHOP_CATALOG_V5` gates a new ENUM VALUE (`theme`), which an older
client's closed zod enum rejects wholesale — a real compatibility gate.
`peers` is an optional FIELD, and consumer-side zod is non-strict by
design, so a client that predates it strips the key and carries on. It
never needed a gate for safety.

The gate it got was a SIZE gate wearing a version number: 410 KB on a
3.63 MB file, withheld from clients that could not read it. That cost is
real, but a schemaVersion bump does not buy it — it buys a hard break.
Emitting `schemaVersion: 6` throws in every client capping at 5, on the
version NUMBER, before any field is looked at; the shop does not open at
all. So the flag could only ever be flipped by betting that few enough
installations were old, and that bet is unsettleable: npm's per-version
download counts for this package are flat across 36 versions (median
164, max 218, the current `latest` at zero), which is mirror traffic
enumerating releases rather than installs. There is no telemetry.

Weighing an unmeasurable break against 410 KB, the bytes win. The field
ships to everyone, older clients ignore it, and the compatibility badges
stop waiting on a flag nobody could responsibly flip.
`CATALOG_SCHEMA_VERSION` stays 5.

## 3. How the verdict is formed

The host resolves each distinct peer name once per loaded snapshot:

```
resolvePeer(spec) = createRequire(profileBaseUrl).resolve(`${spec}/package.json`) succeeds
```

and reports, per entry, **the peer names that did not resolve** — an
empty list meaning compatible. The client receives names, not a boolean,
so every rendering can say which module is missing rather than that
something is wrong. (Superseded 2026-09-24: the host looks each name up
directly rather than through `createRequire`, on every call rather than
once per snapshot, and the client then clears every name its module
table serves — §9.1, §9.5, §9.6.)

**Cost.** 4915 entries averaging ~3 peers is ~15,000 lookups, but the
distinct names number in the hundreds; a `Map<string, boolean>` built per
snapshot collapses the work to a few hundred synchronous resolutions,
themselves cached by node. (Superseded 2026-09-24: nothing caches a
lookup across calls any more, on purpose — §9.4, §9.6.)

**Degradation is silence, never a false alarm.** If the profile anchor is
unavailable, or resolution throws for a reason other than
`MODULE_NOT_FOUND`, the entry carries **no verdict** and the client shows
nothing. This follows the same rule as the pluginInventory read: an
unavailable fact reads as "unknown", never as an accusation. (The rule
stands; its triggers changed 2026-09-24 with the resolver, and a module
table the client cannot read is a new one — §9.1, §9.5.)

**Test seam.** A `resolvePeer?: (spec: string) => boolean` option, in the
same style as the existing `inventory`, `loaderEntries` and `hot`
injections, so fixtures drive every verdict and exactly one production
call site touches the filesystem.

**Boundary, stated plainly.** The verdict describes this machine at this
moment. It says nothing about version adequacy (§2), nothing about a
package's own dependencies (§1), and it cannot help while the harness is
too broken to start — at that point the shop is not running either. Its
value after the fact is that once dsh starts at all, the installed list
names the culprit and the missing module, instead of leaving a
hexadecimal entry id to reverse-engineer.

## 4. What the reader sees

One verdict, three renderings:

| Surface | Rendering |
|---|---|
| Catalog card | A badge naming the missing module(s) |
| Install acknowledgement | An added warning line in the existing dialog |
| Installed list | The same badge — where a user looks after a failure |

**Warn, never block.** The install proceeds if the person confirms. The
check is presence-only and this project does not know every way a plugin
might legitimately work; refusing an install on our inference would make
the shop wrong in a way the user cannot override.

**No copy crosses the RPC.** The host publishes module names; the client
renders sentences from its own dictionaries through dsh's locale service.
The alternative was tried and removed on 2026-09-01: hot-mount restart
reasons were bilingual strings baked into the host, and every reader got
both languages regardless of their dsh setting.

**Deliberately not built:** filtering or reordering the catalog by
compatibility, blocking an install, deriving a minimum harness version,
and checking version ranges. **Amended 2026-09-04: the last of those is
scoped to CATALOG entries** — see §7, which checks ranges for the shop's
own declared peers, the one package whose ranges we hold. (Filtering has
since been built, 2026-09-07, as an opt-in switch — the authority spec's
amendment of that date; §9.9 adds the harness blockers to what it
counts.)

## 5. Testing

- **Registry:** peer extraction driven by packument fixtures, including a
  package with no `peerDependencies` at all.
- **Host:** verdicts driven through the `resolvePeer` seam. Fixtures must
  carry the real shapes — a missing `@deepseek-ai/*` peer, a present one,
  a present non-`@deepseek-ai` peer (`react`), and a missing
  non-`@deepseek-ai` peer — copied from `dsh-timeline`'s actual manifest
  rather than imagined. (`react` was present on 0.1.1-rc.2; on 0.1.5-rc.3
  the host cannot find it and the module table serves it — §9.1.)
- **Host, running harness:** the gateway's verdicts that need a template
  table are driven through its `readHarness` option, and
  `readRunningHarness` itself is tested in a native Node child process.
  (Amended 2026-09-25: on a Windows runner, whose checkout is on D: and
  temp directory on C:, an in-process read under vitest's module runner
  cannot import a fixture's app-boot from the other drive. The read then
  yields no table, so a test expecting one fails and a test expecting none
  passes for the wrong reason. Node's own loader, which production uses,
  reads the same fixtures there.)
- **Client:** the pure name-list → locale-key mapping, and each of the
  three renderings.
- **E2E:** a live fixture package declaring a peer that cannot resolve,
  asserting the badge and the install warning appear and that the install
  still completes on confirmation. (Superseded 2026-09-24: the fixture's
  peer was a seed word on the pinned harness, so the e2e asserted a false
  positive — §9.7.)

The fixture rule is not ceremony. Both defects fixed on 2026-09-01
survived a green suite because a fixture written from the same wrong
assumption as the code agreed with it.

## 6. Release

1. The consumer-side `peers` field is **optional**. The live catalog is
   v5 and carries no such field; a client that requires it refuses the
   published catalog outright. This is exactly how 0.5.0 broke every
   user, and the parse must be proven against a v5 fixture.
2. ~~`SHOP_CATALOG_V6` flips in the release commit that ships the reading
   client, never before.~~ **Withdrawn 2026-09-03**: the flag is removed
   and `peers` ships at schemaVersion 5. Point 1 above still stands and
   is the reason — the field must parse as optional, which is exactly
   what lets it ride the older version instead of needing a new one.
3. The release goes through the `beta` dist-tag first. A version that
   changes what the host reads is precisely the class the channel exists
   for.

## 7. Amendment (2026-09-04): the shop's own peers, checked at load

Everything above judges OTHER packages, on presence alone, because the
catalog records peer names without ranges (§2). The shop's own
`package.json` is the opposite case: it declares real ranges on five
packages, three of them harness packages at `^0.1.1-rc.2`, and nothing
enforced them. `dsh plugin add` does not, and the presence machinery
answers a different question.

The cost was measured the hard way: the harness moved from `0.1.1-rc.2`
to `0.1.2-rc.1` under this repo overnight, a plugin path silently changed
behaviour, and hours went into diagnosing what one line at load would
have said.

**The check.** At load, `ShopGateway` reads the ranges from its own
shipped manifest (`ownPeerRanges`), reads the version each peer resolves
at through the same profile anchor the presence check uses
(`nodeVersionResolver` — `nodeResolver`'s own resolution, kept instead of
collapsed to a boolean; superseded 2026-09-24, both now look the package
up directly — §9.5), and compares:

```
satisfies(found, range, { includePrerelease: true })
```

**`includePrerelease` is load-bearing.** The harness ships nothing but
`-rc` versions, so strict semver rejects every one of them, including
whichever one is installed and working. Measured against `^0.1.1-rc.2`:

| Version | strict | includePrerelease | What it is |
|---|---|---|---|
| `0.1.5-rc.1` | violates | satisfies | the install — npm `latest`, measured 2026-09-10, works fine |
| `0.1.9-rc.3` | violates | satisfies | hypothetical: a later rc on the same minor line. Published nowhere — it stands for whatever the next rc is, so this row survives a re-measurement of the one above |
| `0.1.1-rc.1` | violates | violates | older than pinned |
| `0.2.0-rc.1` | violates | violates | minor-line move — the real breaking change |
| `1.0.0` | violates | violates | major-line move |

Strict mode would fire on the current install for a non-problem and turn
every future rc bump into a false alarm. `includePrerelease` keeps
discrimination on both sides, which is the same reason §3's no-verdict
rule exists: one false warning teaches a reader to ignore every warning.

**Warn once, loudly; never throw.** One message per load naming each
mismatch with its declared range and the version found. Refusing to load
would cost the user the entire shop, which is worse than a degraded one,
so the check cannot fail a load: it is wrapped, and a repeated message is
suppressed by a guard inside the check itself.

**No verdict for a peer that cannot be read.** Absent, restricting
`./package.json` in its exports, an unreadable manifest, a version that
is not semver, a declared range semver cannot parse — each yields nothing
for that peer while the others are still judged. Absence is not a version
violation; §3's presence check is what covers it. (Superseded in part
2026-09-24: an `exports` map no longer hides the version — it hid it
behind every proxy package a packaged executable writes, §9.3.)

**Pure core, impure shell**, as everywhere else: `peerVersionMismatches`
and `peerVersionWarning` are pure and fixture-driven;
`nodeVersionResolver` and `ownPeerRanges` are the only parts that touch
the filesystem, and both arrive through injection seams
(`resolvePeerVersion`, `peerRanges`) beside the existing `resolvePeer`.

**Deliberately not built:** blocking the load, reporting the mismatch
over the RPC or into the client UI, and checking ranges for catalog
entries — the catalog has no ranges to check.

## 8. Amendment (2026-09-11): the github channel, and the author's own declaration

Two gaps, found while investigating a report that `@lanxing/dsh-galgame`
"is incompatible but shows no warning". The report was right and the
cause was neither of the ones §2 and §3 anticipated.

### 8.1 The github channel carries no peers at all

`@lanxing/dsh-galgame` is listed as a **github** entry — its catalog
`version` is a commit sha and it carries `repo` — and §2's record is
npm-only. `RepoCandidate` has no `peers` field, `repo-gate` notes the
absence in the comment beside its payload budget, and
`incompatibilityMap` skips any entry whose `peers` is undefined. So the
warning was not weak: there was nothing to form it from.

Measured against the live catalog of 2026-09-11 (`schemaVersion` 5,
10,220 entries):

| Channel | Entries | Carrying `peers` |
|---|---|---|
| github | 6,230 | **0** |
| npm | 3,990 | 2,881 |

**The check has been structurally blind to 61% of the catalog since it
shipped, and the channel it misses was not a later arrival.** The github
harvest landed on 2026-08-30 (663483d); `peers` first shipped on
2026-09-01 (f7654d2), two days later. §2 above says "each **npm**
catalog entry" in so many words, and §3's cost arithmetic follows suit —
the record was scoped to one of two live channels at the moment it was
designed, and nothing since has revisited it. This was a gap from the
first commit, not drift.

The data is already in hand. `github-client` fetches and parses each
repo's root `package.json` (and a subpackage's, for monorepo
candidates), which is where `peerDependencies` lives — it is read, then
dropped. So the change is to carry it:

- `RepoCandidate` gains `peers: string[]`, the same shape as the npm
  candidate's: names only, bounded by the same `PEER_NAME_MAX_LENGTH`
  (128) and `PEERS_MAX_COUNT` (128). (As built it is optional,
  `peers?:` — §9.8.)
- `repo-gate`'s per-entry payload budget counts it, and the comment
  stating that a repo entry carries no peers — the written record of
  this blind spot — goes with the change.

**The fix arrives gradually, and that is safe.** `RepoCandidate` is
persisted: it rides `RepoStateEntry.candidates` into `repo-state.json`,
which held 15,748 repositories on 2026-09-11. Cached candidates have no
`peers` until their repository is re-fetched, and the GitHub half
re-fetches at most `REPO_BACKFILL_BUDGET_DEFAULT` (2,000) per build — so
coverage fills in over roughly eight builds rather than one.
(Superseded 2026-09-24: the backfill re-reads only what a marker queues,
and nothing queued these — §9.8.) §3's degradation rule is what makes
the interim correct rather than merely tolerable: an entry with no
`peers` carries **no verdict**, so a half-backfilled catalog warns about
fewer entries, never about the wrong ones.

Once the data lands, §3's existing presence check is sufficient for the
reported case. Measured from the profile anchor on 2026-09-11, five of
the eight peers `@lanxing/dsh-galgame@1.1.0` declares —
`@deepseek-ai/dsh-client-runtime`,
`@deepseek-ai/dsh-client-ui-primitives`,
`@deepseek-ai/dsh-client-ui-slots`, `react` and `react-dom` — return
`MODULE_NOT_FOUND`. No new verdict logic is required; the record was the
whole gap. (Superseded 2026-09-24: four of those five are platform seed
words, and the verdict needed a second stage — §9.1.)

### 8.2 `dsh.compatibility` is declared by authors and read by nobody

Some packages state their harness compatibility outright.
`@xmanrui/dsh-im@4.19.2` declares:

```json
"compatibility": {
  "dsh": "0.1.2-alpha.4 || 0.1.2-alpha.5 || 0.1.2-rc.1 || 0.1.3-alpha.1 || 0.1.5-alpha.1",
  "profiles": ["web"]
}
```

Nothing in this repository reads `dsh.compatibility` — not the harvest,
not the gate, not the shop. Measured on 2026-09-11 against the running
`@deepseek-ai/dsh@0.1.5-rc.1`, `semver.satisfies` returns **false** for
that declaration: the author has published an exact, machine-readable
statement that the plugin does not support this harness, and the shop
lists it without comment.

The entry gains an optional `compatibility: { dsh?: string; profiles?:
string[] }`, harvested from both channels' manifests.

**It does not move `schemaVersion`.** Additive and optional, so it rides
every version — the reasoning `emit.ts` sets out for `peers` and
`unpackedSize`, and the mistake `peers` itself made: a doc comment
claiming "emitted only at schemaVersion 6 and above" outlived the gate
coming off, and the compatibility badges never shipped because of it.
The new field's comment states that it rides every version, in those
words, because the next additive field will copy whatever this one says.

**The verdict is formed on the reader's machine**, exactly as §2
requires for `peers`: the catalog records the author's requirement, and
the host compares it against the running harness. The version is read
through the same anchor §3 already uses —
`createRequire(profileBaseUrl).resolve('@deepseek-ai/dsh/package.json')`,
measured to yield `0.1.5-rc.1` on the reporting machine — so this check
and the peer check cannot drift onto different notions of "the running
installation". (As built, the version is read from the running dsh
itself, not at that anchor, and on purpose: see section 9.9.)

**Warn, never block**, per §4, and **no verdict when the fact is
missing**, per §3: no declaration, an unparseable range, an unresolvable
harness version, or a `profiles` list that does not name this profile
each yield silence rather than an accusation. (Superseded 2026-09-24: a
list that does not name the running profile is that half's verdict, not
a silence — §9.9.) A declaration naming profiles is a separate verdict
from one naming versions, and an entry may fail either; the client names
which.

### 8.3 Ranges for catalog entries: still deferred, no longer for the same reason

§2 declined ranges because "presence-only catches the class of failure
that occurred and produces no false positives". That remains the
strongest argument, but the evidence has moved: `@lanxing/dsh-galgame`
declares `@deepseek-ai/dsh-client-locale@^0.1.0-rc.6`, the harness
provides `0.1.5-rc.1`, and `semver.satisfies` returns **false** — a real
mismatch that presence cannot see, on a real listed package, on a real
machine. §2's claim that presence-only misses nothing worth catching is
now known to be false.

The older argument against ranges is narrower than §2's and survives
intact: `Candidate.peers` records that nearly every dsh plugin declares
`"*"`, and that the harness's own prerelease versions do not satisfy
ordinary ranges — so ranges would be inert for most entries and
actively wrong for some. That bounds the BENEFIT; it does not restore
the claim that there is none. Both belong in the measurement that
decides this, and neither has been made: what share of declared ranges
are `"*"`, and how many of the rest are prerelease false alarms, are
unmeasured on this catalog.

It stays out of this change on cost, not on principle — and the cost is
stated as measured, because the obvious version of this sentence was
wrong. `peers` is **not** the catalog's heaviest field. Measured over the
live `plugins.json` of 2026-09-11 (8,626,438 bytes): `catalog` 28.2%,
`integrity` 9.2%, `repository` 7.3%, `peers` 5.5% (475,304 bytes, of
which 395,682 are the names themselves). So ranges are not obviously
unaffordable, and "it is already the biggest thing in there" is not an
argument anyone may reuse.

What makes the pricing premature is 8.1, not the present size: `peers`
today covers 2,881 npm entries and no github entries at all, and 8.1
opens it to a channel holding 6,230 more. Whatever ranges cost, they
cost it against a field that is about to grow by an unmeasured factor,
against a per-entry payload budget that is measured rather than nominal.
Pricing them now would be pricing a record half the catalog does not yet
have. Land 8.1, re-measure, then decide.

## 9. Amendment (2026-09-24): the verdict, audited against the running harness

§1 through §8 measured the verdict's inputs — modules, manifests,
channels — on 0.1.1-rc.2 and 0.1.5-rc.1. This measures its output, over
the whole live catalog, on 0.1.5-rc.3, and most of what it said was
wrong.

**Method.** The production `incompatibilityMap` and `nodeResolver`, as
shipped, over the live catalog built 2026-09-23T05:46:40Z
(`schemaVersion` 5; 11,864 entries — 4,885 npm, 6,979 github), from a
real `web` profile on dsh 0.1.5-rc.3. For the optional-peer figures,
each flagged entry's harvested version manifest was fetched from
registry.npmjs.org: 1,493 of 1,493, with no fetch failure.

**Result.** 3,492 npm entries carry `peers`; no github entry does, since
§8.1 was not yet built. 1,493 of the 3,492 were badged "Incompatible" —
42.8% of those judged — and this is why:

| Badged because of | Entries |
|---|---|
| platform seed words only (§9.1) | 755 |
| peers the author marked `optional: true` only (§9.2) | 381 |
| **seed words and/or optional peers only: definite false alarms** | **991 (66%)** |
| `@deepseek-ai/dsh-client-runtime` only (§9.1: the verdict stands) | 357 |
| some other absent peer | 145 |

The last three rows partition the 1,493 (991 + 357 + 145). The first
two overlap — an entry whose every missing name is a seed word its
author also marked optional counts in both — so they sum past the
third. 465 of the 1,493 name at least one optional peer. The 145
include `cordis` (35 entries), `@deepseek-ai/dsh-host-apiproxy` (20)
and `schemastery` (18). `react` alone was named in 1,177 of the badges.

§2 declined ranges because "a false warning teaches people to ignore
every warning". Two in three of these warnings were false.

### 9.1 The oracle had drifted, and the loader never asked our question

§1's second bullet — "that oracle is the harness's own" — does not hold
on 0.1.5-rc.3.

**Client-side modules never pass through node resolution.** A plugin's
browser half is served by `@deepseek-ai/dsh-client-modules`' module
table, which answers in order: a platform seed word, a materialized
module (`loadCache`), a graph row (`manifest.modules`), a registered
factory — and otherwise throws. A seed word is answered at the first
step, and no `node_modules` is consulted for it.

**The seed.** The web shell (`@deepseek-ai/dsh-web-frontend`, in its
function `by()`) seeds these on 0.1.5-rc.3: `react`,
`react/jsx-runtime`, `react-dom`, `react-dom/client`,
`@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
`@deepseek-ai/dsh-client-ui-slots`,
`@deepseek-ai/dsh-client-ui-primitives` and
`@deepseek-ai/dsh-client-ui-dockkit`. None but `@deepseek-ai/cordis`
exists as a package anywhere in the harness tree (a whole-tree search),
so a fresh install answers `MODULE_NOT_FOUND` for the rest too — the
answer §3 reads as "missing".

**Why §1 measured `react` as resolving.** On 0.1.1-rc.2 `react` was a
real package in the dsh tree, and §1 measured that line correctly. This
machine's `$DSH_HOME/profiles/node_modules/react` link, created
2026-08-24 at first boot, points at `dsh/node_modules/react`, which no
longer exists.

**§8.1 misread the same signal.** It measured `react`, `react-dom`,
`@deepseek-ai/dsh-client-ui-primitives` and
`@deepseek-ai/dsh-client-ui-slots` as `MODULE_NOT_FOUND` and read that
as the plugin's incompatibility, when it was the oracle having drifted.
All four are seed words on 0.1.5-rc.3. The fifth name §8.1 reported,
`@deepseek-ai/dsh-client-runtime`, is the one case below where the
verdict stands.

**The irony worth stating.** `@deepseek-ai/dsh-client-store`, the module
§0's incident turned on, is now a seed word. The check built from that
incident accused every plugin declaring it, on the harness line that
provides it.

**The loader never asked our question.** In 0.1.5-rc.3 the harness's
`locatePkgJson` locates a LOADER ROW's own package, through the
Loader's `resolveSync` (ESM hooks included), with
`createRequire(baseUrl)` only as a fallback "for runtimes without Node
internals". It never resolves peers. §1's "asking the same question the
loader asks" named a question the loader does not ask.

**Decision: a two-stage verdict.**

1. **The host keeps node resolution** — the direct lookup of §9.5 — and
   publishes, as before, the names it cannot find from the profile
   (`ShopCatalogResult.incompatible`).
2. **The client then removes every name its live module table serves**,
   save a name this page has uninstalled (below), through the public
   `ClientModuleLoader` contract only: `ctx.get('modules')`, reading
   `manifest.modules`, `loadCache`, and `import()`, whose seed branch
   answers without side effects. Never through the TypeScript-private
   `seed`, `factories` or `graphRows`: private members promise nothing
   across a harness release.

The table is read in one direction: it can clear a name the host could
not find, never add one. §1's third bullet rejects a module table as an
availability oracle because it lists only what is live; that objection
is to reading the table as an accusation, and this reads it only as an
acquittal. A module not yet live leaves the host's verdict standing; it
cannot raise one.

**The table can outlive an uninstall, so the page remembers its own.**
An acquittal is only as current as the table that gives it. On
0.1.5-rc.3 the table is a boot-time snapshot: the module system's
constructor is the only writer of `manifest.modules`, and only
`invalidate` prunes `loadCache`, so a restart-free uninstall leaves the
removed package's row and cache record where they were. On 0.1.7-rc.2
(`next`), `updateManifest` replaces the manifest once the uninstall
reconciles; until then the old row stands, and after it `prune` keeps
the removed package in the table's private graph rows and in
`loadCache` while any retained module still references it. A kept row
that never materialized is then reached by the `import()` probe, which
fetches and runs that plugin's client bundle: the side effect the probe
exists never to cause. So the client keeps the set of package names
this page has uninstalled since it loaded, and the refinement neither
clears a name in that set nor asks the table about one: for those
names the host's verdict stands. The shop cannot uninstall what the
harness itself serves (seed words, the harness's own client packages),
and an install needs no counterpart, because a reinstalled package
resolves on the host again and leaves the host's list. The set survives
the tab closing and reopening, and a re-applied bundle, which is a new
page, starts it empty. The limit, stated: an uninstall made from
another tab, another window or the CLI is not in the set and stays
unknown to this page until it reloads, and on 0.1.7-rc.2 a kept row for
such a package can still reach `import()`. A residual, stated not
fixed: a seed word can still enter the set by name. A github entry's
package name is whatever its author declares, and no gate stops an
entry named `react` or `@deepseek-ai/dsh-client-store`. Uninstalling
such an entry from the shop puts that name in the set, and every entry
that declares it is then badged, though the table still serves it,
until the page reloads.

**Verdicts are asked for again after an install or an uninstall.** When
either settles `done`, and only then, the tab asks the host again with a
reverdict: it skips the page's stash, asks with the plain call a
stash-expired open makes (the host's own snapshot and freshness window,
never a network refresh), and its answer becomes the new stash. The
host forms both verdicts on every call (section 9.6), so that answer
describes the installation as the mutation left it. `reverdict` is the
client's own instruction and never reaches the wire, whose `catalog`
takes `{ refresh?: boolean }` alone. The shelf stays on screen while it
runs, as it does for a refresh. A Refresh already pending takes
precedence over it, and that holds only through the host: the tab
discards the superseded refresh's own result, and the reverdict's
plain call gets the refreshed snapshot because the host's
`loadCatalogOnce` joins a plain call to a load already in flight, a
refresh's included, rather than starting a second one. A reverdict
never hides a failed Refresh; a failed reverdict leaves the screen as
it was with no note of its own, since the reader asked for nothing.
It does not re-run the shop's own version check, which asks npm and
stays tied to an explicit Refresh or Retry. The stash is dropped when a
mutation starts and again when a reverdict starts, so a plain open in
between asks the host rather than replaying a verdict formed before the
change.

**An unusable table yields no peer verdicts at all** — never a fallback
to the host's, because measured, the host's answer alone is
majority-false on this line. Even with optional peers out of the record
(§9.2), 610 of the 1,112 entries it would still badge are accused of
seed words and nothing else: 991 and 1,493, each less the 381 that §9.2
clears. Silence is the documented degradation — §3's rule, applied to
the second stage. It holds on a page that has uninstalled packages too:
a table that is not there cannot vouch for a removed name, so the false
clear the page-removed set exists to prevent does not arise, and the set
carves no exception out of the silence.

**Why not a hard-coded seed list.** A copy is exactly the drift that
caused this. `packages/dsh-plugin-shop/tsdown.client.config.ts`'s
`BASELINE` is already one, and it still lists
`@deepseek-ai/dsh-client-runtime/client`, which 0.1.5-rc.3 no longer
has. Only the live table moves with the harness.

**`@deepseek-ai/dsh-client-runtime`: the verdict stands.** It exists
nowhere in dsh 0.1.5-rc.3 — not as a package, not as a seed word, not
referenced by the web frontend. A plugin that requires it at runtime
fails; one that imports only its types works, as the shop itself does
through `import type`. A peer list cannot tell the two apart, so the 357
entries it alone accuses keep their badge: the author declared the
requirement, and the harness does not meet it. An author whose plugin
needs only the types can mark the peer optional (§9.2).

**A limit, stated not fixed.** A name the host resolves but the client's
table does not serve is still not flagged — `zod`, for one, resolves to
4.6.5 through the link farm and is not seeded. How often that matters is
unmeasured, and the gap is structural: a peer list does not say which
half of a plugin needs a peer.

**Amended 2026-09-25, on review.** The page-removed set and the
reverdict are new. Before them the refinement trusted every row and
cache record the table held, so a restart-free uninstall erased the
host's correct "missing X". Reproduced against the real client: after
uninstalling `dock-base`, which has a client half and which six catalog
entries declare as a peer, skipping the reload and pressing Refresh, the
host listed it missing, the table cleared it, and no badge came back
until the page reloaded. And a settled mutation left the shelf's
verdicts as they were: the page replayed its stash for up to
`WARM_TTL_MS` and the tab never asked again, so installing a missing
peer from the shop, which hot-mounts it and offers no reload, left
every entry declaring that peer badged "missing" until a Refresh, a
reload or the stash expired.

### 9.2 Optional peers were recorded as requirements

`registry/scripts/src/npm-client.ts` took `Object.keys(peerDependencies)`
and never read `peerDependenciesMeta`, so a peer its author marked
`optional: true` — one the author says the environment need not provide
— was recorded, and judged, exactly like a required one. 381 entries
were badged for nothing else.

**Fixed at harvest, not in the client.** A shared `peerNamesOf` records
required peers only, for both channels (§9.8). The catalog records
requirements (§2), and an optional peer is not one, so it was the record
that was wrong. Fixing it there also clears these 381 false alarms in every
shop version already installed, on the next catalog build, with no client
release — these, and not the seed-word ones, which only the refining client
can clear (§9.1).

**Optional names are filtered before the 128-name cap**, so an optional
peer never takes a slot. **Malformed meta reads as "not optional"**:
only an exact `optional: true` withdraws a declared peer, so a malformed
`peerDependenciesMeta` never costs a required peer its record.

dsh-plugin-shop 0.8.3 itself marks all five of its peers optional.

This is not the name filter §2 declined. The author's own declaration
decides, per package; nothing is inferred from what a name looks like.

### 9.3 A packaged executable blinds the version self-check

§7 reads the version each of the shop's own peers resolves at. Under
`process.pkg` — a packaged dsh executable — dsh-app-boot writes ESM
proxy packages into `$DSH_HOME/profiles/node_modules`, and deliberately
omits `./package.json` from their `exports`.
`require.resolve('<peer>/package.json')` then throws
`ERR_PACKAGE_PATH_NOT_EXPORTED`, so no version could be read, though the
proxy's manifest carries it — and §7's no-verdict rule turned that into
silence.

Reproduced with that exact manifest shape: a proxy at `0.2.0-rc.1`
against the declared `^0.1.1-rc.2` gave no mismatch — the minor-line
move §7's table names as the real breaking change.

**Scope.** Plain-Node installs link with symlinks and were unaffected.
It was not reproduced on a real packaged binary, and whether dsh
distributes one was not checked; §9.5's fix does not depend on either
answer.

### 9.4 Node's cache kept an uninstalled peer present

Node caches a successful `require.resolve` for the lifetime of the
process and never re-checks the disk; a failure is not cached. So a peer
the user uninstalled went on reading as present until dsh restarted.
Measured on Node 26.6.0: absent → `false`, installed → `true`,
uninstalled → `true`.

§3's boundary says the verdict describes "this machine at this moment".
For a present answer it had described this machine at the moment the
process first asked.

### 9.5 One fix for both: look the package up directly

The resolver no longer goes through `require.resolve`. It walks the
`node_modules` directories upward from the profile anchor, exactly as
Node's ESM resolver matches a bare package name:

- **present** means the walk's match holds a manifest. The walk visits
  each ancestor's `node_modules/<name>` in turn, and the first that stats
  as a directory, following symlinks, is the match; a candidate that is
  anything else (absent, a file, a dangling link, or a path whose stat
  fails for any reason, `EACCES` and `ELOOP` included) is not here, and
  the walk moves on to the next ancestor. It stops at the match whatever
  the match holds, and the package is present only when that directory
  holds a `package.json` that stats as a file. A match with no
  manifest reads absent and shadows every copy above it, because the
  loader fails the import there rather than falling through. This is
  Node's own rule, taken from Node 26.6.0's reader (`getPackageJSONURL`)
  and measured against it: a looping link in front of a real copy loads
  the copy, and an empty directory in front of one fails with
  `ERR_MODULE_NOT_FOUND`. So the 29 dangling links in this machine's
  link farm read absent. One shape is knowingly given up: a directory
  holding `index.js` and no manifest imports, and reads absent here; no
  package manager installs it;
- **the version** is read from that directory's own `package.json`;
- **no `exports` gating and no process cache** — the first closes §9.3,
  the second §9.4;
- **no global folders.** Global folders such as `NODE_PATH` and
  `~/.node_modules` are not searched: the ESM resolver that loads plugin
  host code does not search them either;
- **peer names are validated as bare package names first.** They come
  from the catalog, which is untrusted input, and before this a hostile
  name such as `../x` resolved relative to the profile. A name that fails
  validation now yields no verdict for the entry that declares it.

The presence check (`nodeResolver`), section 7's version self-check
(`nodeVersionResolver`) and the lookup of the running dsh's own
app-boot (section 9.9) all answer from this one lookup
(`packageDirectory`). Section 3's degradation rule stands, and at this
stage its triggers are now two: a profile directory that cannot be
discovered, and a peer name that fails validation. No state of the
filesystem makes the lookup throw: it answers present or absent, and,
but for the `index.js` shape above, says absent exactly where the
loader would fail. At the second stage the triggers are a module table
that cannot be read, and a name the table cannot answer for, which
silences the entry declaring it (section 9.1).

**Amended 2026-09-25, on review.** The first cut walked on only past
`ENOENT` and `ENOTDIR` and threw on any other stat failure, reasoning
that such a candidate might hold the package, and `incompatibilityMap`
turned the throw into no verdict. The loader never asks what a candidate
it cannot stat holds; it walks on. So a missing peer, whose walk runs
all the way to the root, met any unsearchable or looping `node_modules`
on the way (a `~/node_modules` made by `sudo npm i` under umask 027,
say), and every missing-peer badge in the catalog went silent while
those plugins still failed to import: that was the trigger this section
listed as "a filesystem error other than absence". The first cut also
counted any matched directory as present, so an uninstall that stopped
part-way (on Windows a locked file is enough) left
`node_modules/<name>/` holding nothing but a nested `node_modules/`, and
the badge naming that peer disappeared while the plugin failed with
`ERR_MODULE_NOT_FOUND`.

### 9.6 The per-snapshot cache never hit, and is deleted

`ShopGateway.incompatibleCache` kept the verdict keyed on the snapshot's
object identity — §3's "once per loaded snapshot". But `loadCatalog`
parses a new object on every call, so sequential calls never hit it:
measured, two loads from a fresh cache are not `===`. Its test passed
only because the stub returned one fixed object — §5's fixture rule,
failing in a new place.

**Deleted, not repaired.** A snapshot-keyed cache that worked would be
worse than none: it would go on saying "missing X" after the user
installs X, for as long as that snapshot is served. The verdict is
recomputed on every `catalog()` call instead, which costs ~17 ms warm
and 182 ms cold for 334 distinct peer names.
The one input kept across calls is which harness is running, read once
per gateway, because a running process cannot change it (section 9.9).

### 9.7 The e2e asserted a false positive

The e2e fixture `dsh-shop-e2e-peer` declared
`@deepseek-ai/dsh-client-store` as "a genuinely-missing peer", and the
e2e asserted its badge — against dsh 0.1.5-rc.3, where that module is a
seed word. It passed because the host's answer had drifted the same way
(§9.1). The fixture was copied from §0's incident and never re-checked
against the harness line the e2e pins: §5's fixture rule, broken by the
one test §5 itself specified.

The fixture now declares a peer that nothing anywhere provides, which
must badge, beside a seed-word peer, which must not. On this line "a
peer that cannot resolve", which is all §5 asked for, is not the same
thing as a missing one.

### 9.8 §8.1 as built: github peers, and a backfill that has to be asked for

**`RepoCandidate.peers` is optional**, not the `string[]` §8.1
specified. Records revived from `registry/repo-state.json` are a bare
cast, so a record written before this change lacks the field at runtime
whatever its type claims; the type now says what is true.

**A re-read marker.** "Fills in over roughly eight builds" assumed the
backfill would re-read old records. It does not: `pushedAt` gates the
re-fetch, and beyond the repositories that changed, the GitHub half
re-reads only those a marker queues. The `installSize` backfill the
estimate leaned on had nothing left to queue — measured against the
committed `repo-state.json` on 2026-09-24, 0 of its 10,864 listable
candidates still lacked `sizeProbed` — so without a marker a cached
record would gain `peers` only when its repository next pushed, and for a
dormant one, never. The marker is a rule version. Each candidate carries
`declarationsRule`, the `DECLARATIONS_RULE` (`repo-state.ts`) under
which its `peers` and `compatibility` were written, and one writer
writes the two fields and the stamp together, on every projection. A
listable candidate whose stamp is not the current rule, absent
included, queues its repository for a re-read. The rule is bumped
whenever `peerNamesOf` or `compatibilityOf` changes what it returns, or
where a candidate's declarations are read from changes, and every
recorded listable candidate is then re-read once; nothing but that
discipline enforces the bump, and both readers' doc comments say so.
The stamp compares for equality, so one from a later rule (a build that
was rolled back) is re-read as well.

**The re-read asks for the declarations and nothing else.** A
repository whose only need is the stamp goes to a queue of its own,
served after every full fetch, in a run the systematic-failure bound let
through, and never competing with a changed repository. For each
listable candidate with a stale stamp it reads what the entry installs:
the `package.json` at the recorded commit and subdirectory, one raw
request and no REST call, never the branch, which may have moved; or,
for a release-rescued root, the recorded release asset, believed only
once it hashes to the recorded sha256. A success writes the two fields
and the stamp, and nothing else. A failure (a request that throws, a
status that is not ok, a manifest that is unreadable or names another
package, a pinned archive that does not open as this package) leaves
the candidate exactly as recorded and unstamped, so it queues again
next run; it is never a failure record, never a published row, and
never counts toward the systematic-failure bound. A recorded asset that
answers 404, answers past the tarball cap, or no longer hashes to its
pin is instead a definite answer that the verified bytes are gone: the
rescue is unverified and left unstamped, and takes the full re-probe
next run, where GitHub's own releases answer decides what stands. A
failed re-read costs a slower backfill and nothing else.

**The phase is bounded three ways**, each by a constant in
`github-client.ts` whose comment owns its figures.
`DECLARATIONS_REREAD_BUDGET_DEFAULT` caps how many repositories one run
re-reads; its comment measures the queue the stamp opened and how many
runs it takes to drain. `DECLARATIONS_REREAD_TIME_BUDGET_MS_DEFAULT`
caps how long the phase may keep starting reads, and is checked before
every read; its comment holds the measured build-job table that sizes it
against the job's `timeout-minutes`. And a breaker stops the phase after
`DECLARATIONS_REREAD_MAX_CONSECUTIVE_FAILURES` host failures in a row.
It counts only reads the host failed, a request that threw or was
answered 429 or 5xx. Any other answer resets it, and a record refused
before any request neither counts nor resets it: a record that fails the
same way every run gathers at the head of every later run's queue, and
a breaker that counted it would trip there for good. What the phase
does not start is deferred, unchanged. It describes at most
`DECLARATIONS_REREAD_FAILURE_LINES` failed re-reads a run on stderr,
and past that one line with the total, and the build note carries the
counts and, when the phase stopped early, why.

**Every re-read takes the first answer it gets.** The asset download
makes one attempt, bounded by `TARBALL_REQUEST_TIMEOUT_MS`, and the raw
manifest read retries only a request that throws. Neither waits out a
429 or a 5xx: a failed re-read is asked again next run anyway, so a wait
buys it nothing, and a read with no status ladder ends within its own
deadlines, which is what bounds how far a read already in flight can
overrun the time budget. The full fetch's release probe keeps its
429/5xx ladder, because it decides whether a changed repository's
rescue is listed.

**Both pins are checked before any request.** A recorded commit that is
not a 40-character sha is refused, since it would read some other ref
than the one the entry installs. A recorded release-asset URL is
requested only when it parses as a github.com release download for the
repository it is recorded under: `https`, no credentials and no port,
the host `github.com` (a trailing dot normalized away), and a path
`/<owner>/<repo>/releases/download/<asset>` naming that repository,
owner and name compared case-insensitively. Anything else is refused
and counted as a failed re-read. No release-asset request carries the
GitHub token either, the full probe's download included: only requests
to api.github.com and raw.githubusercontent.com are sent it. The reason
is that `repo-state.json` is not only this build's output. A pull
request can edit it, and the build runs on pull requests with the job's
token, so a recorded URL naming another host would have sent that token
there, in plaintext over `http://`. A public release asset needs none.

**A transport failure is never recorded as a fact about a repository.**
Every transport failure in the full fetch path throws, the release
probe's included, and lands as a `fetch-failed` row: nothing is
persisted, the recorded entry stands, and the repository is fetched
again next run. The probe answers "no release" only for a definite
answer: a 404 from `releases/latest`, a release that names no tarball
asset, an asset past `MAX_TARBALL_BYTES`, or a 404 for the asset
itself. A 200 that is not GitHub's release object throws too, whether it
is not JSON or lacks a string `tag_name` and an `assets` array; a
proxy's error page is the likely source. A root or subpackage manifest
reads as unreadable, and so as `no-manifest`, only when its bytes
arrived and do not parse, and a subpackage-discovery tree that fails
mid-read throws rather than reading as "no subpackages". The cost is
stated rather than hidden: an environment that blocks the release-asset
host now fails every repository that reaches the probe, and enough of
them trip the systematic-failure bound and stop the build, where it
used to delist every rescued entry and go green.

**A rescued entry declares what its tarball declares.** A
release-rescued root installs the release tarball, not the default
branch it was projected from, so its `peers` and `compatibility` are
read from the `package.json` inside the verified tarball: the rule the
rescue already applied to its name and `installSize`.

§8.1's safety argument holds for the backfill itself: an entry with no
`peers` carries no verdict, so the interim under-warns and never
mis-warns.

**Emission is gated on the refining client (`SHOP_EMIT_REPO_PEERS`).** That
argument does NOT hold for a shop already installed. A client from 0.8.3 or
earlier judges every entry that carries `peers` by node resolution alone —
the verdict §9.1 measured as majority-false — so the day github entries
carried peers, every not-yet-upgraded shop would badge them for seed words.
Measured on a seeded sample of 297 real github manifests (2026-09-24),
projected through `peerNamesOf`: such a client would badge 15.2% of github
entries, about 1,024 of 6,757, and about half of those, some 501, for seed
words alone; the refining client badges about 523. Publishing github peers
before that client is `latest` would therefore raise an installed shop's
false alarms rather than lower them. So the harvest, the `repo-state.json`
record and the declarations re-read run from this change, while emission waits
on `SHOP_EMIT_REPO_PEERS`, which flips in the release commit that first
promotes a build carrying `client/module-table.ts` to `latest` — the
precedent `SHOP_HARVEST_REPOS`, `SHOP_HARVEST_SUBPACKAGES` and
`SHOP_CATALOG_V5` set, each flipped in the release that shipped its reading
client. The backfill runs meanwhile, so the record is as complete as the
days since this change allow on the day it flips, and the build report
says, while it is off, that github peers are withheld. What the gate buys
is ORDER, not absence: the fix is published before the data an older client
mishandles. A shop that is never updated still meets github peers after the
flip, as it meets the npm seed-word verdicts today, and how many such
installations exist cannot be measured — §2's amendment records why npm's
download counts are no census. The shop's own update prompt is what reaches
them.

**The classifier gates the candidates the build lists.** `classify.ts`
gates the same github candidates again, read back from
`repo-state.json`, which keeps the peers it recorded whatever the flag
says. So both steps decide the flag through one helper
(`repoPeersEmitted`) and withhold through `withholdRepoPeers` before any
gate pass, and the per-entry payload budget (`ENTRY_PAYLOAD_MAX_BYTES`)
measures the same candidate in both. The flag is declared once, on the
`build` job, so the classify step, which runs before the build step,
reads the value the build step reads, and `workflow.test.ts` pins that
no step redeclares it.

**Optional peers are excluded on this channel too**, through the shared
`peerNamesOf` (§9.2).

**`compatibility` rides the same stamp**, because one writer writes both
fields and the stamp together: a candidate stamped under the current
rule had its `dsh.compatibility` read under that rule too, and an
absent `compatibility` beside a stamp means "declares none".

**Amended 2026-09-25, on review.** Four rules above changed:

- The marker was the bare presence of `peers`, and it sent every record
  it queued back through the full fetch (a head commit, a recursive
  sizing tree, subpackage discovery and, for a rescued root, the release
  probe and its archive) to learn what one `package.json` says. Presence
  also knew "read or not" and never "read under which rule": a change to
  `peerNamesOf` would have reached npm entries on the next build and no
  dormant repository ever, a carried `['react', 'left-pad']` staying as
  it was while npm's reader returned `['react']`.
- Down that path, transient failures became durable facts. A recorded
  rescue whose `releases/latest` answered 403 once, or whose asset
  download dropped, came back as its `requires-build` root, which the
  gate rejects as "Declares a prepare/prepack build script ... Publish
  to npm" while the verified tarball still stood. A reset while reading
  a root `package.json` was persisted as `no-manifest`, "package.json
  was unreadable.", though that code must never mean a request that
  failed. A failed monorepo tree read, or a reset subpackage manifest
  read, dropped its subpackage entries. None of these moved `pushedAt`,
  so nothing re-queued the repository until it pushed again.
- A rescued root carried its default branch's declarations, which can
  describe a package the entry does not install: `wyzh0117/dsh-notebook`
  requires nothing at HEAD, while the tarball it installs requires
  `@deepseek-ai/dsh-client-runtime`. And `compatibility`, which is not
  withheld, already reached readers: a `"dsh": ">=0.1.7-0"` declared
  only at HEAD made an older tarball read "Incompatible" on 0.1.5-rc.3.
- The classifier gated its candidates with peers attached while the
  build stripped them first, so a repository whose peers alone crossed
  the payload budget listed in the build and dropped out of the
  classifier's live names. That pruned its `categories.yml` row, and the
  entry read `other` every day until the flag flipped. The flag was set
  on the build step alone, which the classify step never saw.

### 9.9 §8.2 as built: `dsh.compatibility`

**Harvest.** Read on both channels and bounded (the range at
`COMPATIBILITY_RANGE_MAX_LENGTH`, each profile name at
`PROFILE_NAME_MAX_LENGTH`, at most `COMPATIBILITY_PROFILES_MAX_COUNT`
profiles, all in `npm-client.ts`), trimmed silently with no build-report
row, like the peers trim, then carried through gate, tier and emit. It
rides every `schemaVersion`, and the host's zod accepts it. A
release-rescued entry's declaration is its tarball's (section 9.8).

**Verdict.** `compatibilityMap`, in
`packages/dsh-plugin-shop/src/host/compatibility.ts`, published as
`ShopCatalogResult.incompatibleHarness`: install identity →
`{ dsh?: { range, running }, profile?: { declared, running } }`. Each
half is present only when the author declared it AND it is unmet here,
and carries both sides. Unknown on either side — a running version that
cannot be read, a range semver cannot parse — means no verdict for that
half. The map runs under the same degrade-to-empty guard as the peer
map: a declaration nobody can judge is never an accusation, and one
entry must not cost every reader the catalog.

**Ranges are checked with `includePrerelease: true`, and that is all
the option does.** It is load-bearing: the harness ships nothing but
prereleases, and strict semver refuses a prerelease against any range
whose comparators carry none (`0.1.5-rc.3` fails `>=0.1.0`, and even
`*`), so every author who wrote a plain range would be told they exclude
a harness their range includes. It does not read a range the way its
author probably meant it: under it a prerelease compares like any other
version, and sorts below its own release. Measured with semver 7.8.5,
and pinned in `compatibility.test.ts`:

- a floor written without `-0` refuses its own prereleases: `>=0.1.5`,
  `^0.1.5` and `0.1.5` all refuse `0.1.5-rc.3`, while `>=0.1.5-0`
  admits every `0.1.5-rc.N`;
- an upper bound written without `-0` admits the next line's
  prereleases: `<0.2.0` and `>=0.1.0 <0.2.0` both admit `0.2.0-rc.1`,
  and only a bound that desugars to `<0.2.0-0` refuses it: `^0.1.0`,
  `~0.1.0` and `0.1.x` do, as does `<0.2.0-0` written out.

`^0.1.5-0` desugars to `>=0.1.5-0 <0.2.0-0`, so it does both. The
comparison stays semver's own and is never rewritten here: a verdict
that coerced prereleases would answer differently from semver, which is
what an author checks a range against. `docs/schema.md` gives authors
the spellings that say what they usually mean.

**The running side is the dsh that runs.** It is identified from the
script this process was started with (`restartScript`,
`process.argv[1]` in production), resolved through symlinks. The
package that owns it, the first directory at or above it holding a
`package.json` file, must be `@deepseek-ai/dsh`, and that manifest's
`version` is the running version. The template table is the
`PROFILE_TEMPLATES` of that dsh's own `@deepseek-ai/dsh-app-boot`. It
is found by section 9.5's lookup from the dsh package directory, never
through `NODE_PATH` (which pnpm's bin shims export), and imported by
file URL, which under the running dsh is the module it already loaded.
Both are read once per gateway and kept, a read that found nothing
included, because a running process cannot change which dsh it is
(`harness.ts`). A process that dsh's CLI did not start, such as a test
runner or another host embedding the shop, reads no harness, and both
halves are silent; a table that cannot be read costs the profile half
and keeps the version. This parts from section 8.2 on purpose.
Section 8.2 read the version at the peer check's anchor so that the two
checks could not describe different installations, but they ask
different questions: a peer must be importable from the profile, while
the version is that of whichever dsh is running, and the profile anchor
answered the second wrongly.

A limit, stated not fixed: under a packaged dsh executable
(`process.pkg`, section 9.3), no version or template table can be read
this way, and both halves degrade to silence. That is unmeasured: like
section 9.3's case, it was not reproduced on a real packaged binary.

**The profile half is met by the running profile's name, or by what it
composes.** It is met when the running profile's name is one of the
declared names, or when the running profile's `dsh.profile.bundles`
hold every bundle of a declared template: one of the running harness's
own `PROFILE_TEMPLATES` (on 0.1.5-rc.3: `acp`, `web`, `headless`,
`sdk`, `sdk-minimal`), read at runtime and never copied. A declared
name that is no template cannot be judged by bundles, so a list holding
one is met by name or gives no verdict. The half is unmet only when the
running name is not declared and every declared name is a template this
profile does not compose. An unreadable bundle list or template table
leaves the name to decide, and otherwise gives no verdict. The verdict
names the running profile by its name, for the copy.

Why both. For a name dsh does not ship, a profile's name is the
reader's choice: `dsh --profile rescue --from-default-profile web`
builds a profile called `rescue` from the web bundles, and dsh records
nothing about which template it came from, while `headless` can carry
`dsh-web-app` too. Judged by name alone, an author's
`profiles: ["web"]`, the one real declaration (`@xmanrui/dsh-im`),
would badge the plugin on every web-app profile not literally named
`web`, and the filter would hide it: the false-alarm class this
amendment exists to remove. So a name that does not match is judged by
what the profile composes. Bundles alone fail the other way, because a
profile keeps the bundle list it was created with: the first harness
release that added a bundle to `web` would badge every
`profiles: ["web"]` plugin on every existing `web` profile, with copy
saying the plugin supports web and dsh was launched with web. A name
dsh ships is not the reader's choice. On 0.1.5-rc.3 both paths that
create a missing profile build one of a shipped name from its template
(dsh-app-boot's `loadProfile`, and `dsh plugin`), and dsh refuses a
shipped name as the target of `--from-default-profile`, so a profile
carrying one was built from that template. For any other declared
name, a matching name can only turn a verdict into silence, never raise
one. The residual, kept knowingly: a custom-named profile is still
judged by bundles alone, so a template that gained a bundle would badge
the custom profiles built from it before; no published
`@deepseek-ai/dsh-app-boot` had changed a template's bundle list as of
2026-09-25.

**The template table has no prototype, and is read by own keys only.**
The names looked up in it are catalog input, and hostile. A table built
on `{}` answered `constructor`, `__proto__`, `toString`,
`hasOwnProperty` and `valueOf` from `Object.prototype`, each a
legal-looking profile name, with a value that passed the
missing-template guard and threw out of `compatibilityMap`. Such a name
is now an unknown one: no template, so no verdict.

**Rendering.** New blocker kinds, on the card, in the install
acknowledgement and on the installed rows. The badge reads
"Incompatible", so the incompatible filter counts and hides these
entries exactly as it does a missing-peer blocker — unless the name is
taken, which decides the visible word (the authority spec's 2026-09-07
amendment, as amended 2026-09-24) — and nothing blocks. The copy names
what was declared and what is running, not merely that they differ.

**Amended 2026-09-25, on review.**

- The running version was read through `nodeVersionResolver` at the
  profile anchor: what the profile can import, not what runs. A plugin
  that depends on the dsh package gets its copy hoisted into
  `<profile>/node_modules` (the listed `dsh-claude-tui@0.1.6` pulls
  0.1.2-rc.1), and every verdict then said "running 0.1.2-rc.1" while
  0.1.5-rc.3 ran, reproduced with real installs; a second install
  sharing `DSH_HOME` re-points the link farm the same way. The templates
  came from the shop's own import of app-boot, which resolves from the
  shop's real path: under a `link:` install that is this repository's
  devDependency, 0.1.1-rc.2 with two templates, while 0.1.5-rc.3 ran
  with five.
- The profile half was judged by bundles alone, so the template growth
  described above would have badged every plugin declaring that
  template on every profile built from it before the release.
- One entry declaring `profiles: ["constructor"]` made every
  `catalog()` call reject, for every user: the table answered from
  `Object.prototype`, and nothing guarded the verdict map.
- This section said ranges were checked with `includePrerelease` for
  section 7's reason. That reason, that the option still refuses a
  minor-line move, holds for section 7's caret range, which desugars to
  `<0.2.0-0`, and not for an upper bound an author writes out. The rule
  is unchanged; the claim was wrong, and `docs/schema.md` now gives
  authors the spellings.

### 9.10 What does not change

Warn, never block (§4). An unknown is silence, never an accusation
(§3). The catalog records requirements, and the reader's machine forms
the verdict (§2). §8.3's ranges stay deferred: 8.1 lands with this
amendment, and the re-measurement §8.3 asks for waits until the §9.8
backfill has re-read the channel.
