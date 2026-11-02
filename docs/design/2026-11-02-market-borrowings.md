# Market borrowings, third review — design

Status: **built 2026-11-02** (PR #124), not yet released: the catalog fields
and the three new RPC methods ship through `beta` first. A review of the three dsh
plugin markets — [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market),
[2BingLing/dsh-market](https://github.com/2BingLing/dsh-market) and
[bradeGithub/DSH-Plugins-Marketplace](https://github.com/bradeGithub/DSH-Plugins-Marketplace) —
produced four borrowings. The competitor citation says where an idea came
from; it is never the evidence. Every claim below rests on this repository,
on the pinned harness, or on a measurement taken here. English only, per
convention.

The four, in the order they are built:

1. **Prepurchase facts** the catalog can carry and no client shows today:
   `engines.dsh`, the runtime dependency count, and declared `bin` names
   (§1–§3).
2. **What changed** on an update row (§4).
3. **Recovery**: a copyable command after a failed install, and a rollback
   to the version a package was updated from (§5–§6).
4. **Favorites** (§7).

## 1. `engines.dsh` decides alone, and the catalog cannot say so

### 1.1 The defect

dsh 0.2.1's `unmetRequirements` (`@deepseek-ai/dsh-app-boot/lib/index.js`,
read 2026-11-02) returns `{ "engines.dsh": range }` when the manifest declares
`engines.dsh` and the running version does not satisfy it, **and never reads
`peerDependencies` in that case**. A manifest that declares both has its peers
ignored by the rule that refuses the install.

The shop predicts a refusal by handing dsh's own rule a manifest synthesised
from the catalog (`compatibility.ts`'s `ownManifest`). The catalog carries
`dshPeers` and no `engines`, so the prediction judges the peers — exactly the
half dsh does not read. Both answers are wrong in the same way:

- an entry whose `engines.dsh` excludes this host but whose peers pass shows
  no blocker, and the install is refused after pnpm has rewritten the profile;
- an entry whose peers fail this host but whose `engines.dsh` admits it is
  badged "Incompatible" and its install button is replaced, for an install
  dsh would have accepted.

`present.ts` already names the gap (`ENGINES_DSH`, "this waits for the
catalog to carry `engines`") and `docs/design/2026-09-26-dsh-017-readiness.md`
§4 records it. This section closes it.

### 1.2 The rule

The catalog carries the declaration verbatim as `engines`, on both channels,
under the same bounds and the same persistence as `dshPeers`:

- npm: `manifest.engines.dsh` of the harvested version;
- github: the same field of the manifest the declarations re-read already
  reads, written together with `dshPeers` and `manifestVersion`;
- release-rescued entries: the manifest inside the release tarball, as
  `dshPeers` already comes from there (`2026-09-26-market-borrowings.md` §5).

`DECLARATIONS_RULE` becomes 4, so every carried repository is re-read once.
That is the mechanism the field already relies on: a candidate stamped with an
older rule is re-read, and the re-read writes the new field.

`ownManifest` forms a manifest whenever the entry declares **either** an
`engines.dsh` range or harness peers; dsh's rule then applies its own
precedence. A github entry still needs its recorded `manifestVersion`, because
dsh's rule throws on a blank version — but the fields are written together, so
an entry with neither is unchanged.

`engines.dsh` is bounded by the same `DSH_PEER_RANGE_MAX_LENGTH` the peer
ranges use: it is the same kind of value, read by the same rule. It is counted
in the gate's payload probe for the same reason `dshPeers` is — it is author
text copied verbatim — unlike `installSize` and `icon`, which the registry
writes in a fixed width.

## 2. The rest of the prepurchase facts

A user's audit of 21 plugins on the competitor
([dsh-market#1008](https://github.com/dsh-market/dsh-market/issues/1008))
names the same three questions: how big it is, what it requires, and what it
does to the machine. The first is already published (`installSize`), the
second is §1, and the third is §3.

`dependencies` is the count of the manifest's runtime `dependencies` — a
fact, not a judgement. It is omitted when zero, so the common case costs no
bytes. It is the one prepurchase field that is registry-written from a
manifest and therefore **not** counted in the payload probe: it is a
three-digit integer no author can inflate, the same reasoning `installSize`
records.

`bin` is the names the manifest declares under `bin`, deduplicated, at most
three, each at most 48 characters, omitted when none. A name here means an
executable appears on `PATH` after install — the one surface change a manifest
states outright. It **is** counted in the payload probe: the strings are the
author's.

## 3. What is deliberately not built: a permission verdict

The audit asks for four marks — reads and writes files, runs a shell, reaches
the network, rewrites the system prompt. None of them can be derived honestly
today:

- No manifest field declares them. The plugin's `cordis.patch.yml` lists the
  modules it inserts (`insert: [{ id, name }]`), which is the plugin itself,
  not its surface.
- An LLM reading a README would produce a claim, not a fact. This repository
  publishes a rejection `detail` that authors read as the reason their package
  is not listed, and a wrong detail is a defect by its own standard
  (`CLAUDE.md`, "Failing loudly"). A wrong "no shell" badge is the same
  defect with a shorter half-life, because nobody can check it.

So the shop publishes **what the manifest declares** (§1, §2) and shows the
author's own `catalog.capabilities` where they wrote them. It does not infer
a permission set, and no card says "safe".

## 4. What changed

An update row shows the target version and nothing about the distance. The row
gains one link, built from facts already on the wire:

- npm: `https://www.npmjs.com/package/<name>/v/<targetVersion>`;
- github commit-pinned: `https://github.com/<owner>/<slug>/compare/<installed>...<target>`
  when the installed spec names a commit, else the target's own commit page;
- release-rescued: `https://github.com/<owner>/<slug>/releases/tag/<tag>`.

The link is built in `present.ts` from the entry and the installed spec, never
from a catalog-supplied URL: `entry.repository` is untrusted text and is not
the install source. It opens in a new tab with `noopener noreferrer`, as every
catalog link does.

## 5. A copyable command after a failed install

`executor.ts` already knows the exact spec it ran. The failure payload gains
`command`, the line that would retry the same spec in a terminal:

```
dsh plugin --profile <profile> add <spec>
```

The profile is the reader's own name, as `allowVersionCommand` already spells
it; the spec is the one the Host built from catalog fields, which for npm and
github carries no whitespace or shell metacharacter the grammars do not admit.
The client renders it in the failure block with a copy button, beside the
existing detail, and only where the executor reported one — a spawn failure
before the command was formed reports none.

## 6. Rollback

### 6.1 What is recorded

The host records, per install identity, the spec and version last **replaced**
by a successful install of a different version. That is one entry per update:
the row is written from the spec the executor just ran, after the flow reports
success, and only when the version changed.

The record lives in `<profile>/.dsh-shop/state.json`, beside the hot-mount
inputs but not among them: `cleanHotDir` wipes `hot-<n>.yml` only. The write
is the profile manifest's own pattern — temp file, then rename — so an
interrupted write leaves the previous state rather than half of a new one.

### 6.2 What it offers

An installed entry whose record names a different version shows "Roll back to
<version>". The RPC is `shop/rollbackStart({ key })` — the install identity,
never the name alone, because two entries can share a name — and takes **no
version from the client**: the host looks the spec up in its own record and
runs that.
A spec this host did not write cannot be run, which is the same invariant
`shop/installStart` holds by building its spec from the snapshot.

The rollback then runs through the CLI path, so the records, the activation
verdict and the notices are the install's own.

It does NOT ride the install flow registry on the client. That registry's
Retry re-sends the panel's target — the catalog's LATEST version — so a failed
rollback followed by Retry would install the version the reader is trying to
leave. The card therefore carries a small control of its own: it starts the
RPC, polls `shop/installStatus` at the flow's cadence, and asks the tab to
re-read the installed list once the host says done. One action, one outcome,
and no button that would do something other than what it says.

## 7. Favorites

A star on every shelf card, and a favorites switch in the filter column beside
the incompatible one — the same shape, because it is the same kind of control:
a boolean modifier that subtracts from whatever the categories and the query
selected. State is a set of install identities in the same `state.json`, read
through `shop/state` and written through `shop/setFavorite({ key, favorite })`.
The switch is not drawn against a host that answers no `shop/state`: there is
nothing to filter to, and a control that always empties the shelf would be a
claim that host cannot honour.

Favorites are keyed by install identity, never by name: two entries can share
a name, and a favorite that survives a re-listing should survive it as the
same identity. An entry that leaves the catalog keeps its row in the file —
pruning would lose a favorite across a one-day delisting — but the filter
counts what the catalog holds, so a delisted favorite simply does not show.

## 8. Wire and release consequences

- The catalog gains three optional keys; all three are additive and the index
  schema version does not move (`emit.ts`'s list records why).
- The client-half boundary gains `shop/state`, `shop/setFavorite` and
  `shop/rollbackStart`, and `shop/installStatus` gains an optional `command`.
  A version that changes what the host reads goes through `beta` first
  (`CLAUDE.md`, "Release channels"), so this ships as `0.9.2-beta.0`.
- The parity guard (`catalog-parity.test.ts`) requires the consumer's schema
  to declare every published key; the shop's `catalog.ts` declares all three.

## 9. Testing

- `npm-client.test.ts`: the three readers' bounds and omissions; a manifest
  with `engines.dsh` and peers.
- `compatibility.test.ts`: an engines-only entry forms a manifest; peers are
  ignored by the rule when engines is present; a github entry without
  `manifestVersion` still forms none.
- `repo-state.test.ts`: the new fields round-trip; a malformed one throws; the
  rule bump re-reads.
- `gate.test.ts`: the payload probe counts `engines` and `bin`, and not
  `dependencies`.
- `catalog-parity.test.ts`: green without an exemption.
- `present.test.ts` and `ShopTab.client.spec.tsx`: the link's three forms, the
  large-size mark, the rollback button, the favorite toggle and filter.
- `state` unit tests: a missing file is empty state; a malformed file reads as
  empty state rather than throwing, and the next write replaces it; each half
  is validated apart, so a corrupt rollback map never costs the stars; the
  bounds; `rollbackSpec` refusing a range and a non-commit.
- `ShopTab.client.spec.tsx`: the star and its revert on a refused save, the
  favorites switch in both directions, the absence of both against a host with
  no `shop/state`, the three detail rows and their absence, the large-size
  mark, the failed install's command line, the rollback offer and its absence
  when the record names what is installed, and the what-changed link.
- **No e2e case is added for these two.** The live lane already covers an
  install, an update and a reload of the shipped UI (`web-full-flow.e2e.ts`),
  and the fixture it drives has one version per package — a rollback needs a
  second, older artifact installed first. The unit and component tests above
  cover the decisions; the wire between them (the host's state file, the RPC)
  is covered by `state.test.ts` and the gateway tests. Adding the e2e is worth
  doing when the fixture grows a second version, and this section says so
  rather than letting the gap read as covered.
