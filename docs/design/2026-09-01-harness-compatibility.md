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
designed but not implemented: the record is extended to the github
channel, which has carried none of it since that channel shipped — 61%
of the catalog — and to `dsh.compatibility`, the author's own
machine-readable declaration, which nothing in this repository reads.**

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
  correctly.
- **That oracle is the harness's own.** `ClientModuleRegistry`
  (`@deepseek-ai/dsh-client-modules`, service name `clientModules`)
  builds its `resolvePkgJson` out of `createRequire(ctx.baseUrl)` and
  resolves each spec's `package.json` through it. Asking the same
  question the loader asks is what keeps our verdict and the runtime's
  behaviour from drifting apart.
- **`clientModules.table` is NOT that oracle.** `processOne` admits an
  entry only while `entry.fiber !== undefined && !entry.disabled`, so
  the table is "what is live", not "what is available". Reading
  availability out of it would report every not-yet-loaded module as
  missing.
- **Regular dependencies must not be checked.** `temml` is a plain
  dependency of `dsh-timeline` and correctly fails to resolve before the
  install — pnpm brings it with the package. Only `peerDependencies`
  describe what the environment must already provide.
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
happens not to be a harness package.

**Inline, not interned.** Interning would save ~300 KB, and it is
declined: `plugins.json` is a published artifact that plugin authors read
to find out how their package was listed, and indices into a side table
are not something a person reads. 11.6% on a content-addressed file that
is re-fetched only when its hash changes does not buy back that
legibility.

**Ranges are out of scope**, per the evidence above: presence-only
catches the class of failure that occurred and produces no false
positives. A false warning teaches people to ignore every warning, which
costs more than the misses.

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
something is wrong.

**Cost.** 4915 entries averaging ~3 peers is ~15,000 lookups, but the
distinct names number in the hundreds; a `Map<string, boolean>` built per
snapshot collapses the work to a few hundred synchronous resolutions,
themselves cached by node.

**Degradation is silence, never a false alarm.** If the profile anchor is
unavailable, or resolution throws for a reason other than
`MODULE_NOT_FOUND`, the entry carries **no verdict** and the client shows
nothing. This follows the same rule as the pluginInventory read: an
unavailable fact reads as "unknown", never as an accusation.

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
own declared peers, the one package whose ranges we hold.

## 5. Testing

- **Registry:** peer extraction driven by packument fixtures, including a
  package with no `peerDependencies` at all.
- **Host:** verdicts driven through the `resolvePeer` seam. Fixtures must
  carry the real shapes — a missing `@deepseek-ai/*` peer, a present one,
  a present non-`@deepseek-ai` peer (`react`), and a missing
  non-`@deepseek-ai` peer — copied from `dsh-timeline`'s actual manifest
  rather than imagined.
- **Client:** the pure name-list → locale-key mapping, and each of the
  three renderings.
- **E2E:** a live fixture package declaring a peer that cannot resolve,
  asserting the badge and the install warning appear and that the install
  still completes on confirmation.

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
collapsed to a boolean), and compares:

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
violation; §3's presence check is what covers it.

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
  (128) and `PEERS_MAX_COUNT` (128).
- `repo-gate`'s per-entry payload budget counts it, and the comment
  stating that a repo entry carries no peers — the written record of
  this blind spot — goes with the change.

**The fix arrives gradually, and that is safe.** `RepoCandidate` is
persisted: it rides `RepoStateEntry.candidates` into `repo-state.json`,
which held 15,748 repositories on 2026-09-11. Cached candidates have no
`peers` until their repository is re-fetched, and the GitHub half
re-fetches at most `REPO_BACKFILL_BUDGET_DEFAULT` (2,000) per build — so
coverage fills in over roughly eight builds rather than one. §3's
degradation rule is what makes the interim correct rather than merely
tolerable: an entry with no `peers` carries **no verdict**, so a
half-backfilled catalog warns about fewer entries, never about the wrong
ones.

Once the data lands, §3's existing presence check is sufficient for the
reported case. Measured from the profile anchor on 2026-09-11, five of
the eight peers `@lanxing/dsh-galgame@1.1.0` declares —
`@deepseek-ai/dsh-client-runtime`,
`@deepseek-ai/dsh-client-ui-primitives`,
`@deepseek-ai/dsh-client-ui-slots`, `react` and `react-dom` — return
`MODULE_NOT_FOUND`. No new verdict logic is required; the record was the
whole gap.

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
installation".

**Warn, never block**, per §4, and **no verdict when the fact is
missing**, per §3: no declaration, an unparseable range, an unresolvable
harness version, or a `profiles` list that does not name this profile
each yield silence rather than an accusation. A declaration naming
profiles is a separate verdict from one naming versions, and an entry
may fail either; the client names which.

### 8.3 Ranges for catalog entries: still deferred, no longer for the same reason

§2 declined ranges because "presence-only catches the class of failure
that occurred and produces no false positives". That remains the
strongest argument, but the evidence has moved: `@lanxing/dsh-galgame`
declares `@deepseek-ai/dsh-client-locale@^0.1.0-rc.6`, the harness
provides `0.1.5-rc.1`, and `semver.satisfies` returns **false** — a real
mismatch that presence cannot see, on a real listed package, on a real
machine. §2's claim that presence-only misses nothing worth catching is
now known to be false.

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
