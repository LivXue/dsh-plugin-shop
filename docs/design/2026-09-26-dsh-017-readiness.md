# dsh 0.1.7 readiness — design

Status: **implemented 2026-09-26 on `feat/dsh-017-readiness`, not
released.** It changes what the host reads — a catalog field and three RPC
shapes — so it ships through `beta` first. It amends
`2026-09-01-harness-compatibility.md` (§10: one harness reason now blocks;
§11: the peer check asks the harness which packages it serves) and
`2026-09-11-activation-model.md` (the 2026-09-14 amendment is reversed)
in the same change. English only, per convention.

dsh publishes two lines at once: `latest` is 0.1.5-rc.3 and `next` is
0.1.7-rc.2. The shop has to work on both, so everything here was measured
against both, installed side by side — 0.1.5-rc.3 globally, 0.1.7-rc.2 in
a separate prefix — with the web e2e run on each.

## B0. The shop broke the whole 0.1.7 web UI

On 0.1.7-rc.2, a profile with the shop installed showed "Failed to load
plugins" and nothing else. Four things were wrong; the first was fatal.

### B0.1 Every typert codec needs a `create()` factory

The two harness lines read a strict codec through different keys.
0.1.5-rc.3's typert loader demands `codec.schema`, a zod v4 schema, and
ignores everything else. 0.1.7-rc.2's demands a `create()` factory, which
its registry calls lazily and caches, in every position that carries a
codec — the result, each `parameters[].codec`, the context receiver's
`invocation.codec`, each `uplink.codec` — and on every `schemas[]` entry;
it ignores `schema`. Neither rejects the other's key, so a codec carrying
both loads on both.

The generator this package builds with (0.1.1-rc.2) prints `schema` only.
A manifest 0.1.7 refuses does not fail alone: the loader's activation
throws, which withdraws every typert definition in the process.

`scripts/typert-dual-codecs.ts` wraps the generator's tsdown plugin and,
after it writes `lib/typert.host.js` and `lib/typert.remote-client.js`,
puts `create: () => <the same schema>` beside every codec's `schema:` line
and inside every named schema entry. It wraps rather than adding a second
plugin because rolldown runs `writeBundle` hooks in parallel, and the
rewrite must read the generator's output rather than race it. It reads the
generator's printed shape line by line and refuses to guess: a count of
strict codecs that differs from the count of rewritten schema lines, or
output that already carries factories, stops the build. The second case is
the retirement signal — the day the generator emits factories itself, the
step fails and is removed, after checking that 0.1.5 still gets its
`schema`.

### B0.2 The Settings section is called 内置插件

0.1.7 renamed the Settings section the shop's tab lives under — Built-in
plugins / 内置插件, because the plain word now names the sidebar's own
plugin-manager page. The e2e and the README screenshot script find it by
either label. The READMEs' "Settings → Plugins → Plugin shop" depends on
the reader's dsh, not on the shop's version, so it stays until dsh 0.1.7
reaches `latest`, and changes then together with the screenshots.

### B0.3 The hot tree hangs off the shop's own entry

cordis hands a service out with `ctx` rebound to the context that looked
it up. Inside an RPC method, the shop's `this.ctx` was therefore the
typert gateway's — measured on both harnesses. The hot tree was
registered from it: the loader's `internal/plugin` handler sets
`fiber.entry = fiber.parent[Entry.key]`, and the `EntryTree` constructor
sets `entry.subtree = this`, so the tree became the gateway's subtree,
listed as `include:typert-gateway:mkt-<id>`, and dsh's client registry
never composed it.

The gateway now keeps the context it was constructed with (`home`) and
registers the tree from that. The tree unwinds with the shop and lists as
`include:shop:mkt-<id>`, which is what `hot.ts` always claimed.

That changes the activation model. `dsh-client-modules` composes
`window.__DSH_BOOT__` from `loader.entries()` on each `internal/plugin`
event, so a package hot-mounted under the shop's entry enters the graph
the next page load is served. The e2e measures it on both harnesses:
across a reload after the hot mount, the graph gains the package under a
new `rev`, and the page runs the fixture's client script. A hot install of
a package declaring `dsh.client` now reports `reload`, and the
`client-half` restart reason and its copy are deleted. The 2026-09-14
measurement that moved these installs to `restart` — a graph
byte-identical across a reload — was taken with the tree under the
gateway (`2026-09-11-activation-model.md`, §1, second amendment).

**Known limitation, not fixed here.** The loader keeps one `subtree` per
entry, and every hot mount constructs a new tree under the shop's entry.
A second hot mount in one session therefore replaces the first in
`entry.subtree`, which is where `loader.entries()` walks. Read from the
loader's source, not measured end to end: the first package should keep
running while dropping out of that enumeration — the inventory's listing,
and any later recomposition of the client graph — until the next boot. It
predates this change: under the gateway's entry the same overwrite
applied, and to a subtree the gateway might have owned itself.

### B0.4 The e2e reads 0.1.7's UI as it now is

0.1.7 keeps a Settings tab it has shown mounted and hidden, with the
snapshot it fetched when first shown, so the inventory tab no longer
reflects a mount made afterwards; the e2e reads the inventory on a fresh
page. And 0.1.7's inventory draws a phase dot only for pending, loading
and unloading, stating the active phase as text in the opened card; the
e2e accepts either. The missing inventory row was first read as the attach
point's fault, and three comments said so; the diagnostics showed the
caller was the typert gateway on both harnesses alike, and the comments
were corrected.

## B1. dsh 0.1.7 refuses an install on its harness peers

### B1.1 What dsh does

Read from `@deepseek-ai/dsh-plugin-manager` and `@deepseek-ai/dsh-app-boot`
0.1.7-rc.2, and exercised with the real CLI in a throwaway `DSH_HOME`.

- **The rule** is app-boot's `evaluatePluginCompatibility(manifest,
  exemptions, runtimeVersion)`. It reads every `@deepseek-ai/dsh` and
  `@deepseek-ai/dsh-*` peer — optional ones included, since it never reads
  `peerDependenciesMeta` — and refuses one whose range the runtime does not
  satisfy under `includePrerelease`. `workspace:^`, `workspace:~` and
  `workspace:*` mean the runtime itself; an empty or blank range is
  refused. The runtime defaults to app-boot's own version, read from its
  manifest on every call. A non-string range on ANY peer throws.
- **The preflight**, before pnpm runs, judges each named spec it can read
  without installing: a registry spec through `pnpm view <spec> name
  version peerDependencies --json`, a path spec from disk. A git or tarball
  spec is skipped. A refusal prints `dsh: installation rejected: …` and
  `dsh: nothing was installed.`; a throw is swallowed.
- **The post-install check** judges every direct dependency pnpm changed,
  and the plugins its bundle patch rows name. A refusal — or a throw,
  reported as "Cannot validate installed package" — restores
  `package.json`, the lockfile and `node_modules`.
- **The exemption** is a record in the profile's `compatibility.json`,
  exact `name@version` to a list of exact dsh versions, written by `dsh
  plugin --profile <p> allow-version <name>@<version> --dsh-version
  <runtime> --accept-risk`. The CLI prints exactly that command after a
  refusal. A grant must name the running version. Exercised end to end: the
  command recorded the key, and the refused install then succeeded.
- **At boot**, installed plugins the rule refuses and no exemption covers
  are disabled.
- **Since when.** app-boot first exports the rule at 0.1.7-rc.1; every
  earlier published app-boot, 0.1.7-alpha.2 included, has none (all
  scanned 2026-09-26). The shop therefore reads the capability off the
  running app-boot's exports, never off a version number.

### B1.2 What the catalog records

`dshPeers` on npm entries: the manifest's harness peers with their ranges
verbatim, optional peers and empty ranges included, because the rule reads
both. Bounded like every harvested declaration (`PEERS_MAX_COUNT`, the peer
name bound, 256 code units per range) and dropped, never rejected, past a
bound — and a dropped peer can only hide a refusal, never invent one, since
dsh refuses when any harness peer fails. That is the direction the shop,
which disables an install on this record, can afford to be wrong in.

**Not on github entries.** dsh keys an exemption by the INSTALLED
manifest's `name@version`, and a github entry's catalog version is a
commit. The shop can neither read such an entry's exemption status nor
print a command that clears it, so it forms no verdict there, and a record
would be a key nothing reads. The first draft harvested one for github
too, which cost a `DECLARATIONS_RULE` bump: every carried candidate stamped
under the current rule — 11,282 of them, in 11,016 repositories — re-read
under the per-run budget of 4,000 repositories, about three daily builds,
for data no consumer used. It was removed before commit. A github verdict
needs the manifest's `version` as well; both would then be harvested under
one bump.

**Cost, measured on the catalog of 2026-09-26** (7,916,197 bytes, 12,236
entries). 2,239 npm entries declare 10,330 REQUIRED harness peers; at the
shortest possible range, `"*"`, the field would add 391,742 bytes (4.95%).
A 150-entry sample fetched from npm the same day puts the real average at
48.8 bytes per peer (726 peers, 40 of them optional), which extrapolates to
roughly 0.55 MB, about 7%. The ranges are not mostly `*`: 67 of the 726
were, and the rest are caret ranges (`^0.1.0-rc.6` alone is 144) and exact
pins (`0.1.1-rc.2`, `0.1.5-rc.3`, `0.1.5-rc.2 || 0.1.6-alpha.1`), so
dropping ranges dsh always accepts would save about 6% of the field — not
worth a second rule. The heaviest entry, `@mstar-harness/dsh@3.11.2`,
declares 62 harness peers: with the field it measures 5,580 bytes, under
half the 12 KiB per-entry payload budget.

### B1.3 What the shop does

- **The check is dsh's own.** `harness.ts` takes `evaluatePluginCompatibility`
  and `readProfileVersionExemptions` from the running app-boot — both or
  neither, since a rule without the exemptions would refuse what a profile
  has already allowed — and binds the rule to app-boot's own version, read
  once. Passing none re-reads the manifest on every call: 75 ms against
  12 ms for 2,000 manifests on 0.1.7-rc.2.
- **The verdict** (`peerVerdictsOf`, pure) hands the rule, for each npm
  entry with `dshPeers`, the manifest dsh's preflight reads — name,
  version, and those peers — with the profile's exemptions. An exempted
  refusal is no verdict; a throw is no verdict for that entry.
  `catalog()` reads the exemptions on every call, because recording one is
  exactly the event that must clear a card; a failed read forms no
  refusals at all.
- **The command** is rebuilt, never copied: `allowVersionCommand` spells
  it as dsh prints it, from a name and versions that pass dsh's own
  exemption grammar, and offers none otherwise. Checked against dsh's
  validator on 330 inputs, with no disagreement. The name and version come
  from the catalog and the command goes to a terminal; the grammar admits
  no whitespace, quote, `$`, backtick, `;`, `|`, `&`, redirection or
  bracket. The profile is written as dsh writes it: the reader chose it.
- **The card** gets a `harness-peers` blocker, ordered after a name
  conflict and before everything advisory: the refused peers and the dsh
  refusing them, then the lead-in and the command on a line of its own.
  **The Install and Update buttons are disabled** (`refusesInstall`), the
  badge reads "Incompatible", and the incompatible filter counts the card.
  After running the command, Refresh re-enables the button. The outdated
  row, which states no detail line and whose gate was the one place its
  reasons were written out, now writes a refusal out beside its disabled
  button.
- **A refusal the catalog cannot predict** — a github entry, a bundle's
  components, a manifest dsh cannot judge — still reaches dsh. The failed
  install now reports "dsh refused the install", what dsh restored, and the
  exemption command, rebuilt from what dsh printed through the same
  grammar: after pnpm, dsh prints the installed manifest's own name, which
  a tarball or git package chooses itself. It used to read as "pnpm
  failed" and send the reader to `dsh plugin install`, which repairs
  nothing.

**How many cards this disables.** Of a 300-entry sample of npm entries
with required harness peers, judged by 0.1.7-rc.2's own rule on
2026-09-26, 44 are refused (14.7%) — roughly 330 of the 2,239, or 6% of
the 5,095 npm entries. On 0.1.5-rc.3 nothing is disabled: that dsh refuses
no install on its peers.

**Residuals.** A bundle whose component plugin is refused is not predicted:
the catalog records the bundle's own peers only. And a manifest with a
non-string range on any peer is refused after pnpm whatever the
exemptions, because the rule throws before it reads them; if its harness
peers are also refused, the card offers a command that clears only half
of that. Both surface as the install's own failure, in dsh's words.

**The decision this amends.** The harness-compatibility design refused to
block an install on its own inference (§4: warn, never block). This is not
an inference: it is dsh's refusal, by dsh's rule, on the profile's own
exemptions, given before pnpm instead of after. The shop cannot install
past it, and the button's only other outcome was a failed card. §10 of
that design records the amendment; every other harness reason still warns.

**0.1.7 also ships a Plugins page** (`dsh-client-ui-plugin-manager`) that
installs, enables, disables and removes plugins and records these same
exemptions. It overlaps the shop; nothing here depends on it.

## B3. The desktop profile

dsh's CLI refuses `--profile desktop`, in any letter case, for a launch
and for `dsh plugin` alike: the profile "is managed exclusively by the
Electron application" (`rejectElectronProfile`, the same in 0.1.5-rc.3 and
0.1.7-rc.2). Every mutation the shop makes spawns that CLI, so in the
desktop profile an install, an uninstall or a self-update failed as "pnpm
failed", and a restart would relaunch a dsh that exits at once. Each is now
refused before anything spawns: an install with the `desktop-profile`
rejection code, an uninstall and a self-update with a detail pointing at
the app, and `desktop` leads the restart gate, so the card shows the app's
own copy in place of the restart offer.

## B4. A list-valued `dsh.bundle.patch`

0.1.7's app-boot (`bundlePatchFiles`) accepts the patch as one
package-relative file or a list of them, applied in order, and throws on
anything else. 0.1.5 joins the declaration onto the package directory, so
a list stops the profile from starting.

The shop reads a list wherever it reads the patch — the entries it owns,
the rows a hot mount replicates — one file at a time, each confined to the
package directory. A declaration no dsh loads owns nothing and mounts
nothing, rather than falling back to `cordis.patch.yml`. After an install,
the confirm step fails a list on a dsh whose app-boot does not export
`bundlePatchFiles` (`list-unsupported`) and a malformed declaration on any
dsh (`malformed`), with the undo command, before anything mounts it. An
unidentified harness forms no verdict on a list.

The registry holds every file of a list to the release-asset checks: a
release-rescued entry must ship each listed file and every module it
inserts, and a declaration that is neither a path nor a list of paths is
refused.

## B5. The peer check read every harness package as missing

0.1.5's app-boot links the installation's dependency closure into
`$DSH_HOME/profiles/node_modules`, and that link farm is where the shop's
peer walk found every harness package. 0.1.7 keeps none: it serves the
same closure to plugins through Node's module hooks and writes nothing
there. So on 0.1.7-rc.2 the walk read `@deepseek-ai/dsh-llm`,
`@deepseek-ai/dsh-tools` and the rest of what the running dsh ships as
missing, and the shop badged 2,214 live entries against 570 on
0.1.5-rc.3 — the fourth card on the shelf among them. The load-time
self-check of the shop's own peers lost its input the same way.

The host now asks dsh's `pluginPackages` service first — `packageOf`, the
resolution a plugin's own import goes through — from the profile anchor,
and walks the disk only behind it; on 0.1.5, which has no such service,
the walk alone answers as before. On a real 0.1.7-rc.2 boot the tab then
offers to hide 582 entries, against 570 on 0.1.5-rc.3. The measurements
and the rules the new path keeps are in
`2026-09-01-harness-compatibility.md` §11.

## Testing

- **Unit.** The codec rewrite on a fixture in the generator's printed
  shape, and the built faces against both harnesses' rules. The peer check
  taken from a fixture app-boot in a child process: bound to app-boot's
  version, none for half a check or a versionless manifest. The verdict and
  the command as tables. The gateway: verdicts merged beside the declared
  halves, exemptions re-read per call, silence without a check or with an
  unreadable record. The client: blocker order, `refusesInstall`, the
  disabled button and the command on the card and the outdated row, and
  Refresh re-enabling it. The executor: dsh 0.1.7-rc.2's verbatim output,
  captured from both a preflight and a post-install refusal. The desktop
  refusals; the list-valued patch in every reader.
- **The web e2e, on both harnesses.** The peer fixture declares an
  optional `@deepseek-ai/dsh` peer no 0.1 build satisfies — optional, so
  its required-peer verdict is unchanged. On 0.1.5-rc.3 its card is not
  disabled. On 0.1.7-rc.2 it is, the command it shows is run through the
  real CLI exactly as shown, Refresh re-enables the button, and the install
  that ends the case succeeds — dsh honouring the exemption at its
  preflight and again after pnpm. The fixture registry now serves
  `peerDependencies` in its packuments, as a real registry does; without
  them dsh's preflight would judge a manifest with no peers, a path no real
  install takes. The same fixture declares `@deepseek-ai/dsh-llm`, a host
  package every dsh ships, and its card must not name it (B5): on 0.1.5 the
  link farm supplies it, on 0.1.7 only `pluginPackages` does, and with the
  host change removed the case fails on 0.1.7-rc.2.
- **Which dsh the e2e boots.** On Linux it spawns the first bare `dsh` on
  the vitest process's `PATH` (`resolveDshScript` only recognizes npm's
  Windows layout), and `npx` prepends a `node_modules/.bin` for every
  ancestor of the working directory. A `dsh` in any of those beats a
  harness put first on `PATH`: from a checkout under `/tmp`, a stray
  `/tmp/node_modules/.bin/dsh` (0.1.5-rc.1 on the machine this was measured
  on) was booted in place of 0.1.7-rc.2. From this repository's own
  checkout no ancestor holds one, and the runs behind this record booted
  the harness they named. `node node_modules/vitest/vitest.mjs run
  tests/client/web-full-flow.e2e.ts` rewrites no `PATH` at all. Either way,
  read the version from inside the run — the card's harness-range line
  names the running dsh. So verified, all seven cases pass on 0.1.7-rc.2
  and on 0.1.5-rc.3.

## Release

The catalog gains `dshPeers`, and three RPC shapes change: `HarnessVerdict`
gains `peers`, `InstallRejectionCode` gains `desktop-profile`, and
`RestartBlockedReason` gains `desktop`. All are additive, and an older shop
ignores the field; the version still goes through `beta`, per the release
rules.

CI pins the harness at 0.1.5-rc.3, so it runs the refusal case's 0.1.5
branch only. A second e2e leg on 0.1.7 would run the other branch, every
B0 fix and B5's badge assertion; it is a cost decision and is not taken
here.
