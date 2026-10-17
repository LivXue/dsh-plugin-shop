# The shop's own sidebar page — design

Status: **built** (2026-10-17): the page store on `feat/shop-page-store`, the
page on `feat/shop-sidebar-page`. LivXue started 0.9.0 on 2026-10-15 and took
each decision in §2 between then and 2026-10-16. The work lands as two pull
requests, the page store first (§5) and the sidebar page second (§4, §6, §7).
It amends §5.1 of `2026-08-18-dsh-plugin-shop-design.md` (the 2026-10-16
amendment there), whose 2026-10-15 amendment made the shop a Settings section.
English only, per convention.

Every harness fact below that names no other source was read in the installed
bundles of dsh 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2
(`.claude/worktrees/.dsh0{15,17,20}-prefix`) on 2026-10-15 or 2026-10-16, or
measured with a throwaway build that registered into the same seats on all
three (2026-10-15, worktree `probe-plugins-page`, never committed). A fact
that holds on fewer of them says which, and one read elsewhere names its
source where it is stated, as §2 item 3's Add plugin seat does.

## 1. Why

**dsh manages plugins on a sidebar page, and Settings is a dialog.** dsh 0.1.7
added a Plugins entry to the left sidebar. Its README:
"Use the **Plugins** entry in the Web sidebar to manage the profile's installed
bundles … Settings keeps the read-only inventory"
(`dsh-client-ui-plugin-manager`, 0.2.0-rc.2). The Settings section that 0.8.7
gave the shop sits in a modal, beside General and Models; a catalog of
thousands of cards is browsed better in the main column.

**The sidebar takes a third party's page on every supported harness.**
`sidebar.panellist` takes a row with its own glyph and the keyed `main` slot
takes the page the row opens (§3.1). The probe drew a row and rendered the
whole shop in the main column on all three harnesses, including 0.1.5-rc.3,
which has no Plugins page.

**Leaving costs the reader their place.** §5.1's "Leaving the section": the
shell renders only the open section, so leaving the shop and coming back
mounts it afresh, and the search text, the filters and an install's progress
view, restart offer included, go with it. A sidebar page is left far more
often than a Settings section is closed, typically to read a conversation
while an install runs, so the move has to carry the reader's state with it.

## 2. Decisions

LivXue's, in the order taken:

1. **The sidebar page is the shop's only home.** The Settings section goes.
   Rejected: the shop in both places, which mounts two live copies that each
   poll and each offer a restart while Settings is open over the page; and a
   Settings row that only jumps to the page, which dsh's Settings has no
   precedent for.
2. **The whole page persists** across leaving and returning, until a page
   reload or a hot swap of the shop's own client (§5.1). Rejected: nothing
   persists, today's cost made more visible; and only the install flows
   persist, which leaves a running install unreachable on return whenever its
   card is not on the default shelf.
3. **Two jumps from dsh's Plugins page**, 0.1.7 and later (§7): "Open Plugin
   shop" on the shop's own bundle page and "View in Plugin shop" on the page
   of any bundle the shelf lists. A row in the Add plugin menu
   (`plugins.add.actions`) waits: no dsh `latest` declares that slot yet
   (0.2.0-rc.2 on 2026-10-17). `next`, 0.2.1-rc.2, declares it, as do
   0.2.1-alpha.1 and alpha.3; the wait is for 0.2.1 to reach `latest`. The
   tags are from `npm view @deepseek-ai/dsh dist-tags`; the declarations were
   read in the `.dsh021a-prefix` install (alpha.1) and in packed
   `dsh-client-ui-plugin-manager` tarballs (alpha.3 and rc.2;
   `slot-contract.d.ts`).
4. **The state lives in a page store on `globalThis`** (§5), the pattern
   `restart-monitor.ts` already uses. Rejected: a host RPC listing running
   installs, which changes §5.3's method set and covers installs only, so the
   search, the filters and the scroll would still need a client store; and the
   `store` option of dsh's slot registration, which dsh's own Plugins page
   uses but the 0.1.1-rc.2 protocol this package builds against predates,
   with 0.1.5-rc.3 the harness at risk.
5. **A hot swap from a 0.8.x shop switches the main column to the shop page**
   (§6, rule 2), so the reader who pressed Update in Settings finds the restart
   offer when Settings closes. Rule 2 sees the 0.8.x shops that leave a store
   on the page, 0.8.4 and later; a swap from 0.8.0–0.8.3 reads as a fresh page
   and moves nothing.
6. **Glyph B**, a bag with a whale tail (§4.3), chosen from three candidates
   shot in a real 0.2.0-rc.2 sidebar, each in its idle and selected rows, wide
   and collapsed, light and dark. The shots are not committed; §4.3 holds the
   chosen paths. The note that the tail can read as an arrow at 16px was
   weighed and the glyph kept.

## 3. Harness facts

### 3.1 Sidebar and main column (all three harnesses)

- **`sidebar.panellist`**: a `list` slot, scope `root`, declared by
  `dsh-client-ui-sidebar`. Its owner props are `{ size, active }`, and its
  metadata is `{ id, order, label }`, with the label resolved from the
  registration's `label`. Each row is a `<button aria-label={label}>` that
  carries `aria-current="page"` while its panel is selected. The glyph renders
  inside an `aria-hidden` span through
  `renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })`,
  and the label is shown beside the glyph while the column is wide.
- **dsh's own rows**: Plugins at `order: 0` (0.1.7 and later; 插件 / Plugins)
  and Automation at `order: 10` when `ui-schedule` is enabled. The web profile
  the probe installed into has no Automation row, and on 0.1.5-rc.3 the shop's
  row was the only global row.
- **dsh's own glyphs** (`IconPluginPinwheelOutlineRegular`,
  `IconClockOutlineRegular`) use a 16×16 viewBox, `stroke="currentColor"`, a
  stroke width of 1 and no fill. Both ignore `active`: the row draws the
  selection.
- **`main`**: a `keyed` slot, scope `root`, declared by `dsh-client-ui-layout`.
  `MainPanel` renders
  `renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })`, so
  only the selected key is mounted.
- **`retainMainPanels`** runs on every change to the `main` registry. A
  selection whose key is no longer registered falls back to `null`, which is
  the conversation.
- **`ctx.layout`**: `selectPanel(id)` throws when `id` is not a registered
  `main` key and otherwise selects it, and `panelInfo` is an observable of
  `{ activePanelId }`. **Measured 2026-10-16 (§9.1): this shape is not
  the same on all three harnesses.** 0.1.5-rc.3's `ILayout` is a command
  facade (`selectPanel`, `beginNavigation`, `toggleSidebar`,
  `openRightbar`, `closeRightbar`) and the observable reaches the client only
  as a root slot hook behind a private field of `ctx.slots`;
  0.1.7-rc.2 and 0.2.0-rc.2 carry `panelInfo` on `ILayout` as well. So the
  shop calls `selectPanel` and never reads the observable: a read of
  `ctx.layout.panelInfo` is `undefined` on 0.1.5-rc.3, and an unguarded
  `getSnapshot()` throws during `apply` (observed: the shop's entry failed to
  apply and dsh drew its "Failed to load plugins" page). What the shop needs
  to know about the selection it records itself — see §6's rule 1.

### 3.2 The Plugins page (0.1.7-rc.2 and 0.2.0-rc.2)

Its slot contract (`slot-contract.d.ts`) is byte-identical on the two.

- **`plugins.detail.actions`** is a `list` slot, scope `root`, with owner props
  `{ subject }`. It holds "Controls at the head of a detail page, before the
  page's own switch and uninstall … An entry renders null for a subject it has
  no control for." A subject is one of:
  - `bundle`, carrying `pkg: { name, version?, installed, enabled, rows }`;
  - `row`;
  - `item`.
- **`plugins.bundle.config`** is "a bundle's own configuration", not a place
  for navigation. **`plugins.item`** is "OCCUPIED by the official settings
  pages".
- **The page resets its own view** to the card list whenever the main column
  leaves it.
- **Layout** (the 0.2.0-rc.2 stylesheet):
  - `.page` is the scroll container: `height: 100%; overflow: auto;
    display: flex; flex-direction: column; align-items: center; gap: 32px;
    padding: 0 clamp(24px, 4vw, 48px) 48px`. Each child gets
    `width: 100%; max-width: 960px`.
  - The head is a `<header data-window-drag>` with
    `padding-top: calc(28px + var(--dsh-frame-top-clearance, 0px))`.
  - The title is an `<h1>`, 20px on a 28px line, weight 500.
  - The intro is 13px on a 20px line, in `--dsw-alias-label-secondary`.

### 3.3 Registration timing

`ctx.slots.inject(name, factory)` registers once some package declares `name`.
A registration into an undeclared slot stays inert. The probe registered into
all of the Plugins page's slots on 0.1.5-rc.3 without an error, and nothing
rendered.

### 3.4 Modules

Every `@deepseek-ai` import in `src/client` is `import type`. The client
bundle's runtime imports are React and its own bundled code, nothing from dsh.
0.1.5-rc.3's install tree has no `dsh-client-ui-primitives` directory, and
whether its module table seeds that module was not established.

## 4. The page

### 4.1 Registrations

`apply` registers, in this order:

1. `main`, `key: 'shop'`, `locale: NS`, `inject: injected` → `ShopPage`. It
   comes first because the row's click calls `selectPanel('shop')`, which
   throws while the key is unregistered.
2. `sidebar.panellist`, `id: 'shop'`, `order: 5`, `label: () => t('title')`,
   `locale: NS` → `ShopGlyph`. Order 5 places it directly under Plugins and
   above Automation.
3. `plugins.detail.actions`, `id: 'shop'`, `order: 0`, `locale: NS`, with its
   own inject face → `ShopDetailAction` (§7).

The `settings.section` registration and `ShopSection.tsx` are removed.

The protocol this package builds against (0.1.1-rc.2) declares none of these
three slots. `index.ts` declares them by augmenting
`@deepseek-ai/dsh-client-ui-slots`' `SlotMap` with dsh's own declarations, the
way it already declares `connection/reset`. The Plugins page's subject type is
declared locally too, with only the fields §7 reads.

The layout service is read through `ctx.get('layout')`, never through
`inject`. The reason is the same one `modules` is read that way: the
features that need it degrade without it, and an inject requirement would
hold the whole client back on a harness that lacks the service.

### 4.2 Layout

`ShopPage` mirrors dsh's Plugins page (§3.2):

```
<section data-shop-page>                  scroll container, dsh's .page rules
  <header data-shop-page-head data-window-drag>
    <h1 data-shop-page-title>{t('title')}</h1>
    <p data-shop-page-intro>{t('intro')}</p>
  </header>
  <ShopTab …/>                            the shop body, unchanged
</section>
```

- **The column widens from 760px to 960px**, and the CSS-token test that pins
  760 moves with it. The body's first row (search, version row, GitHub link)
  needs 712px in English, by `ShopTab.tsx`'s own measurement, so a full-width
  column keeps it on one line; a narrower window wraps it, as Settings did.
  The shelf is one card per row, so the extra width goes to each card's
  summary.
- **The header holds no control.** dsh's desktop drag region
  (`data-window-drag`) can therefore cover all of it.
- **Headings.** The page title is the page's `<h1>`, so the shelf's
  "Updatable" `<h2>` now sits under it. That settles #94's deferred minor, an
  `<h2>` beside an `<h2>`.
- **Copy.** The title and intro keep 0.8.7's dictionary keys and text. The
  intro uses `--dsw-alias-label-secondary`, as dsh's intro does, and the e2e
  measures its contrast on the page's real background.
- **`ShopTab` keeps its name**, its `data-shop-tab` root and its content.

### 4.3 Glyph

`ShopGlyph({ size })` follows dsh's own glyphs: `width` and `height` set to
`size`, `viewBox="0 0 16 16"`, `fill="none"`, `stroke="currentColor"`,
`stroke-width="1"`, round caps and joins, and `aria-hidden="true"`. It
ignores `active`, as dsh's glyphs do. The paths are glyph B as shot:

```
M4.7 5.5H11.3Q12.5 5.5 12.632 6.693L13.368 13.307Q13.5 14.5 12.3 14.5H3.7Q2.5 14.5 2.632 13.307L3.368 6.693Q3.5 5.5 4.7 5.5Z   bag
M5.75 5.5V4.25a2.25 2.25 0 0 1 4.5 0V5.5                                                                                  handle
M8 12.75V11.25                                                                                                             tail stock
M8 11.25C7.4 10.2 6.6 9.8 5.75 9.75                                                                                        left fluke
M8 11.25C8.6 10.2 9.4 9.8 10.25 9.75                                                                                       right fluke
```

## 5. The page store

### 5.1 Where it lives

The store lives in `page-store.ts`, on
`globalThis[Symbol.for('dsh-plugin-shop.page')]`, and carries `schema: 1`.
The registry symbol is the one thing a hot-swapped module instance shares with
the instance it replaced; that is why `restart-monitor.ts` lives there (its
header explains), and the page store sits beside it for the same reason.
Reading the key checks the schema (`readPageStore`): the key holds nothing, a
store of this schema, or another schema's object. A later shop's store, met
after a downgrade, is the last of these, and this shop never reads it as its
own; it stops one only through a `dispose` it has.

**Lifetime.** Each `apply` creates a new store. A re-applied bundle is a new
page, as `warmCatalog` and `pageRemoved` in `index.ts` already treat it.
Before replacing a predecessor's store, `apply` reads its hand-over facts
(§6) and disposes it, which stops its timer and drops its listeners.
A disposed store, its flow registries included, publishes nothing and
registers no listener again, so nothing in a hot swap's window changes it, a
start that answers late included; what it held stays readable. A page reload
starts with no store.

### 5.2 What it keeps

| Kept across leaving and returning | Held before the page store by |
|---|---|
| Search text, category, shelf order, "hide incompatible", the number of cards shown | `ShopTabBody` state |
| The scroll position (§5.7) | nothing: Settings owned the scroll container |
| Which cards are expanded, by identity | each `EntryCard`'s `open` |
| Install and uninstall flows per identity: the view (running, done, failed, rejected, with log and phase) and the set whose start is in flight | `useKeyedFlows` |
| The self-update flow | `useUpdateSelf` |
| Each installed row's owed notice (reload or restart) | each row's `owed` |
| A pending reverdict and a count of those raised, and a settle count that tells a mounted page to re-read the installed list | `request`, `mutations` |

### 5.3 What it does not keep

- **Dialogs and gates**, such as the restart confirmations. Coming back to an
  open confirmation would be a surprise.
- **Transient states**: the Check button's checking and up-to-date states, the
  refresh spinner and its failure note.
- **Data**: the catalog (`index.ts` stashes it), the installed list, the
  manifest specs and the version answer. Every mount reads them again, as it
  does today, and the host answers from memory.

### 5.4 Who polls

The store owns one interval per kind of flow (install, uninstall,
self-update), each running while a flow of its kind runs, at
`INSTALL_POLL_MS`. Each polls its own running install ids on every tick and
folds the status through `reduceInstall` in the order the requests were asked:
every request takes a number, and an answer asked before one already folded
for its flow is dropped, so two that crossed never put an older status over a
newer one. A request that fails, or never answers, holds nothing back: the
next tick asks again. A terminal status does at store level what the tab's
settle callbacks did before the store:

- an install that ends `done` resets that identity's uninstall receipt;
- an uninstall that ends `done` resets the identity's install receipt, drops
  the notices its switches owed on every surface (a reinstall draws fresh
  switches under the same keys), and records the package as removed by this
  page (`noteUninstalled`, with the name the uninstall was started with);
- either one ending `done` sets the pending reverdict and bumps the settle
  count, and a failed install bumps the count only.

A receipt is a view that has stopped running. A flow of the other kind still
running for the identity, such as an uninstall pressed while an update ran, is
left to settle by its own poll: resetting it would drop every later answer for
it, its settle included.

A switch's notices also go when the installed list a page reads no longer
holds its identity, on every surface. A plugin removed outside the shop,
through dsh's Plugins page or `dsh plugin remove`, has no uninstall of this
page to settle, and the list is its one witness; installing it again from the
shop takes a list read that shows its Install button, so that read drops the
notice first. Every drop is counted, and a toggle hands back the count it
started at with its answer. An answer that lands after its identity left the
profile re-creates nothing. A restart under the page (§5.5) leaves every
answer standing: the page notes one only from the new process's version
answer, and the old process sent its answers before it exited, so an answer
that lands after the restart is noted is the new process's, and the restart it
owes is real.

A mounted page reacts at once. An unmounted page finds the pending reverdict
on its next mount, and its first catalog request is then a reverdict. The
first verdicts it shows are therefore judged after the mutation, never
replayed from a stash taken while the install ran. `index.ts` drops the stash
when a mutation starts, but a page mounted while the install ran would have
refilled it with verdicts judged before the install landed.

The pending reverdict clears only when the answer to the request made for it
lands, a failed answer included, so a page left before then leaves it for its
next mount. The store counts every reverdict raised, and an answer clears only
the latest: a request made before a later settle cannot have judged that
settle, so the page asks again. A Refresh or Retry clicked while a reverdict is
pending supersedes the request made for it, and carries its count instead: the
host judges the click's request after the settle that raised the reverdict, so
its answer clears it, while a failed one leaves it pending and the page asks
for it again.

### 5.5 dsh restarted under the page

The store subscribes to `onRestarted` in `apply`. On a restart it clears what
the restart settled (`settledByRestart`) from all three kinds of flow and from
the rows' restart notices, sets the pending reverdict and bumps the settle
count. A mounted page also takes the fresh version answer, as it does today.

### 5.6 The React side

Components subscribe with `useSyncExternalStore`. A switch's owed notice has a
channel of its own (`subscribeOwed`, `getOwed`), apart from the page snapshot
the shop body subscribes to, so a notice re-renders its switch and never the
shelf. A toggle reads `owedEpoch` when it starts and hands it to `setOwed` with
its answer, and the shop body hands every installed list it reads to
`noteInstalled` (§5.4). The expanded cards live on a channel of their own too
(`subscribeExpanded`, `isExpanded`), outside the shelf view, so opening a card
re-renders that card: a card's header toggles it (`toggleExpanded`), and
`expand` opens one from outside it, leaving an open card open. A view change
that changes nothing, such as a pill pressed again, publishes nothing. The
flow accessors, `useRegistryFlows`, keep the contracts `useKeyedFlows` had,
and `useFlows.client.spec.ts` pins them on that hook:

- one flow object per key while that key's view and start state are unchanged;
- `pending` keeps its identity while its membership is unchanged;
- a second start for a key whose start is in flight is ignored synchronously.

### 5.7 Scroll position

The page's `<section>` is its only scroll container. While the shop lived in
Settings, it sat inside Settings' own container and restored no scroll.

- **Recording.** The scroll position is written to the store on scroll, at
  most once per animation frame.
- **Restoring.** On mount the stored card count renders that many cards. Once
  the catalog is ready and the installed list has answered (the Updatable
  section and the Installed view are drawn from it), and both are laid out, the
  page sets the position once; a page that is genuinely shorter clamps it.
- **Cancelling.** A wheel, touch or key event before the restore cancels it.

### 5.8 Known gap: a reload during an install

A page reload starts a new store, and no RPC lets a new page find an install
that is already running. After a reload mid-install, the card offers Install
again. The gate passes a same-identity request ("the ordinary update path"),
so a second press queues a second install of the same version behind the
first, and the executor runs them one after the other. 0.9.0 accepts this.
The follow-up would keep running install ids in `sessionStorage`, as the
restart verdict already is.

## 6. Hot swaps

A self-update rewrites the shop's `lib/client.js`. dsh's client HMR then
disposes the shop's client fiber and applies the new module (see
`restart-monitor.ts`' header). Until the restart, **the new client runs
against the old host**. This design adds no RPC, so between the swap and the
restart 0.9.0's client asks a 0.8.7 host only what 0.8.7's own client asked
it. The restart-monitor store also keeps its shape, because a 0.8.x
predecessor hands it over.

**What the predecessor was.** At the start of `apply`, before it registers
anything:

| What is on `globalThis` | Predecessor |
|---|---|
| a page store with `schema: 1` and a `handover` | 0.9.0 or later |
| a page store with `schema: 1` and no `handover` | a build with the page store (§5) but not yet the page, whose shop still lived in Settings: read as a 0.8.x shop. The two land in separate pull requests (§10), so a build cut between them leaves this |
| a page store of another schema | a later shop, after a downgrade: its hand-over cannot be read, so it reads as a page that was not showing |
| the restart-monitor store, no page store | a 0.8.4–0.8.7 shop, which creates that store in its own `apply`; 0.9.0's `apply` creates it too, but only after this read |
| neither | none: a fresh page |

**Both rules act only on an update waiting for a restart.** That means the
first version answer after `apply` carries `pendingVersion`. A self-update or
a CLI install of a new version always leaves one. A bundle switched off and on
again leaves none, so it never moves the reader. Each rule selects the page at
most once per `apply`, after the page's own `main` entry is registered.
Without a layout service that can select a panel, one whose `selectPanel` is
there to call, neither rule does anything.

**The first answer waits on npm.** The host's `version` asks the registry for
the shop's latest release, uncached, before it reads the profile's copy for
`pendingVersion` (`host/index.ts`, `self-update.ts`; the same in the
0.8.4–0.8.7 hosts, which answer until the restart). That lookup normally
takes about a second, and up to about 10 s when no registry answers: 5 s for
the profile's configured registry, then 5 s for npmjs.org, which is always
asked last. A reader who goes elsewhere in that window is moved to the page
once, when the answer lands. This is accepted, with no time bound: the move
brings the restart offer the update needs, and a bound would skip it exactly
when an update has just finished on a slow mirror, with the reader waiting
for that offer.

- **Rule 1, a 0.9.0-or-later predecessor.** The requirement: a hot swap while
  the shop page is showing leaves it showing. If dsh unregisters the old
  `main` entry before the new one registers, `retainMainPanels` drops the
  selection to the conversation, so the new `apply` selects the page again
  whenever the predecessor's store recorded the page as showing when its
  teardown began. The record is taken by the `main` injection itself: its
  factory returns `[unregister, record]`, and cordis disposes the disposers an
  effect collected in reverse order of collection, so `record` runs while the
  entry still holds the selection. **What it records is the page's own mount,
  not dsh's selection** (§3.1: the selection observable is not readable
  through `ctx.layout` on every leg — on 0.1.5-rc.3 it reaches the client only
  as a root slot hook behind a private field — and `main` mounts a selected
  key's panel and nothing else, so the
  page knows it is on screen without asking dsh).

  What the probe measured on 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2, all three
  agreeing, is the register order and the timing of the record, not the
  mount-based witness itself: the probe's own record asked dsh for the
  selection (`selectionReader()?.read() === 'shop'`) and read `showing=true` on
  all three, which establishes that a record placed as the factory's second
  disposer runs while the page is still mounted and the selection still stands.
  The mount is an equivalent witness by argument: `main` mounts a selected
  key's panel and nothing else, and the probe's record ran at the one moment
  the page was mounted and selected, so a page that watches its own mount sees
  the same thing without reading the observable (§9.1).

  The e2e has since measured the mount-based witness on 0.1.7-rc.2 and
  0.2.0-rc.2 (2026-10-17, UTC), through its hot-swap case. On a build with
  rule 1 removed, the swap happened: the new bundle was fetched and the old
  page's root detached. The conversation then kept the main column, and the
  case failed waiting for the restart offer. With rule 1 the case passes. The
  page comes back there only through rule 1, which reads the record, so the
  record read the page as mounted. On 0.1.5-rc.3 the witness is still argued:
  that run was not made there.

  The evidence for the fallback is the page itself: after the swap the DOM read
  `probe page showing false, row aria-current null` on all three — the shop's
  page was gone and the conversation held the column, so the selection does not
  survive the swap and rule 1 is needed on every leg. The new `apply`'s own
  reading of the selection is the corroborating second witness on 0.1.7-rc.2 and
  0.2.0-rc.2 (`selection at apply: null`). 0.1.5-rc.3 also prints a
  `selection at apply` line, but it is not a witness: that leg's root-hook
  reader printed `null` at its first `apply` too, while the page was in fact
  selected (`selection -> null` twice, never `shop`, then `page mounted`, DOM
  `aria-current page`) — it demonstrably misses transitions. That leg's
  evidence is its `record` reading `showing=true` and the DOM reading. dsh unregisters the old `main` entry
  before the new one registers, and the reader saw the conversation for 1255 ms
  (0.1.5-rc.3), 1755 ms (0.1.7-rc.2) and 1005 ms (0.2.0-rc.2) — the gap between
  the swap and the second `apply` that rule 1's own `selectPanel` closes.

  The same three legs also measured `selectPanel('shop')` under an open
  Settings dialog: the dialog **stayed open** on all three while the page
  became selected behind it, which is what rule 2 accepts (§9.4, the hand
  check before the pull request, reads the same thing).
- **Rule 2, a 0.8.x predecessor.** It sees 0.8.4 and later, through the
  restart monitor's store they leave (the table above). The new `apply` selects
  the page, and the Settings dialog loses the shop where that release put it.
  0.8.4–0.8.6 kept the shop in a tab of Built-in plugins
  (`settings.plugins.tab`; the section is Plugins on 0.1.5-rc.3), so the
  dialog stays on that section and falls back to its first tab
  (`dsh-client-ui-settings-plugins` selects `rows[0]` when the selected tab is
  gone, on all three harnesses). 0.8.7 gave the shop its own section
  (`settings.section`), so the dialog falls back to its first section. When
  the reader closes it, the shop page and its restart offer are underneath.
  0.8.0–0.8.3 register no restart carrier and leave nothing on `globalThis`,
  so they read as a fresh page and nothing moves: their reader loses the
  shop's tab with no restart offer in view. The cost was accepted: a CLI
  install of 0.9.0 under an open 0.8.x page also switches that page to the
  shop once.

## 7. The two jumps

`ShopDetailAction` renders in dsh's detail-page head, so it carries **its own
error boundary**, which renders nothing on an error. Without it, an exception
in the shop's button would reach dsh's page.

| Subject | Renders | A click |
|---|---|---|
| `bundle`, `pkg.name === 'dsh-plugin-shop'` | **Open Plugin shop** / **打开插件商店** | selects the shop page as the reader left it |
| `bundle`, another name the shelf lists (below) | **View in Plugin shop** / **在插件商店中查看** | writes the shelf view, then selects the page |
| anything else: a `row`, an `item`, a name the catalog does not list or the shelf hides, any subject before the catalog is known | nothing | |

- **"The shelf lists"** is the shelf's own predicate: a name `notAShop`
  clears, or a name and repository that `isShopLike` does not match. It moves
  from `ShopTab.tsx` to `present.ts`, so the button and the shelf apply one
  rule.
- **The catalog** comes from `index.ts`' stash, whatever its age: a listing
  question does not need the five-minute freshness a shelf does. With no stash,
  the action asks once through the same plain catalog call a page open makes,
  and renders nothing until that answers.
- **Writing the shelf view** sets the search text to the package name, clears
  the category and "hide incompatible", shows the first batch and scrolls to
  the top. When exactly one listed entry carries that name, its card is added
  to the expanded set. Whatever search the reader left is replaced: they asked
  to see this plugin.
- **Selection** goes through `ctx.layout.selectPanel('shop')`. Without a layout
  service that can select a panel the button does not render, because it could
  not navigate.
- **Style.** A plain `<button type="button">` drawn with the shop's own CSS,
  an outline button sized to the page's own small outline button (measured
  from the bundle when built, and pinned by the CSS-token test). The client
  takes no runtime dependency on a dsh UI package for two buttons (§3.4).
- **0.1.5-rc.3** declares no Plugins page slot, so nothing renders there
  (§3.3).

## 8. What does not change

- The host half, and §5.3's nine methods.
- The catalog, the install gates and the install mechanics.
- The restart handoff: `restart-monitor.ts`, its store's shape and its
  `sessionStorage` verdict. Only its listener plumbing moves: it goes through
  `listeners.ts`, which the page store and the flow registries share, while
  the store's shape, its plain-`Set` `listeners` included, and its behaviour
  are unchanged.
- What the shop body renders, with two exceptions. First, a failed or rejected
  install or update, and a failed self-update, offer Retry or Dismiss, a failed
  uninstall offers Dismiss beside its Retry, and a finished install or update
  offers Dismiss. The remount that once cleared those views is gone (§5.2), so
  without them a failure would stand until a page reload, and so would a
  finished install whose plugin was removed outside the shop. Second, the
  Installed view says nothing about the search while the installed list is
  loading or has failed: the store keeps the filter, so a return can open on
  that view before the list answers. While it loads, the shelf says it is
  reading the installed list (`installedLoading`), a quiet line in the
  register of the error's; when the list has failed, its own line reports
  that and the shelf adds nothing. Either way an empty view no longer said
  "No matching plugins." under an empty search box.

## 9. Testing

### 9.1 Measure before building

On all three harnesses, use a throwaway build that logs its registrations,
its disposals and every `panelInfo` change, installed into a temporary
`DSH_HOME`. The swap is triggered by replacing the installed `lib/client.js`
with a second build, since dsh's client HMR polls client bundles for changes.
Record:

1. During a swap with the shop page selected, the order of: the old `main`
   entry leaving, `retainMainPanels` falling back, the new `apply`, and the new
   `main` entry registering.
2. Whether `selectPanel` with the Settings dialog open closes the dialog.
3. The order in which cordis disposes a fiber's effects, which decides when
   rule 1's record can be read.

The findings amend §6 before any code depends on them. Measured 2026-10-16; the
findings are in §6, which also says which of them the probe's own record
established and which follow by argument from it. The probe's record read the
selection itself rather than watching its own mount, so the mount-based witness
§6 adopts is the argued half.

### 9.2 Unit

- **The page store:**
  - state survives an unmount and a remount;
  - polling continues with no page mounted;
  - a settle with no page mounted makes the next mount's first catalog
    request a reverdict;
  - `onRestarted` clears the settled receipts;
  - a re-`apply` disposes the predecessor's timer.
- **Registration:** `main`, `sidebar.panellist` and `plugins.detail.actions`
  are registered, and `settings.section` is not.
- **The hot-swap rules:** every row of §6's table, crossed with
  `pendingVersion` set and unset.
- **`ShopDetailAction`:** every subject in §7's table, plus an error inside
  the component rendering nothing.
- **Scroll restore:** it waits for the catalog and the installed list, happens
  once, and an earlier wheel, touch or key cancels it.
- **The existing `ShopTab` suite stays as it is.** It is the regression net
  for moving the state.

### 9.3 Browser e2e

Run on 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2, on Linux and on Windows.

- **The entry point moves to the sidebar.** The e2e asserts:
  - the row order: Plugins then Plugin shop on 0.1.7 and later, the shop's row
    alone on 0.1.5;
  - `aria-current` on the selected row;
  - the contrast of the title and the intro;
  - that Settings no longer has a Plugin shop section.
- **Leaving and returning.** Start an install, leave for another page, let the
  install finish, and return. The card shows the finished install, and the
  search text, the category and the scroll position are as they were left.
- **The two jumps** (0.1.7 and later): each button from its bundle page, and
  the shelf it lands on.
- **A hot swap with the shop page showing.** The page is still showing
  afterwards, and it offers the restart. The case replaces the installed
  files, never edits them in place, because they can be hard links into
  pnpm's store.

### 9.4 By hand, before the pull request

On all three harnesses:

- **From 0.8.7 to the candidate.** Install the candidate under an open 0.8.7
  page, which is the same hot swap a self-update makes. Settings falls back to
  its first section, closing it shows the shop page with the restart offer,
  and after the restart the shop reads the candidate's version. Boot on a
  fixed port: on `--port 0` the shop rightly refuses an in-page restart.
- **The 63-check hand check**, entered from the sidebar.

## 10. Documentation and release

- **The spec.** The first pull request amends the 2026-10-15 amendment's
  "Leaving the section" bullet, since its code is what makes that bullet
  false; the second adds the 2026-10-16 amendment to §5.1 of the main design,
  pointing here.
- **The promotion commit** moves the four READMEs' "Settings → Plugin shop"
  and the screenshot script's navigation, as the 0.8.7 promotion did, because
  READMEs track `latest`. The six screenshots are reshot from the published
  0.9.0.
- **Two pull requests**, in order: the page store, then the sidebar page. Each
  is pushed on LivXue's "开" and merged on "合并".
- **The first beta is `0.9.0-beta.1`.** 0.9.0-beta.0 was published on
  2026-09-08 and unpublished; it is still in the packument's `time` map, and
  npm never republishes an unpublished version. The beta number is confirmed
  with LivXue when it is due. From there the release follows 0.8.7's flow:
  - a hand check of the beta installed from npm;
  - the promotion commit;
  - `0.9.0` published on LivXue's word;
  - the screenshots reshot;
  - the tag and a draft GitHub release.

## 11. Not built, and why

- **A row in Add plugin's menu.** No dsh `latest` declares
  `plugins.add.actions` yet (0.2.0-rc.2 on 2026-10-17), though `next`,
  0.2.1-rc.2, does; §2 item 3 says where each was read.
- **Badges or sections on other bundles' pages**, such as "newer in the
  catalog". They were not asked for, and
  `plugins.detail.badge` and `plugins.detail.section` stay open for them.
- **The shop on its own bundle's configuration seat
  (`plugins.bundle.config`).** That seat's contract is a bundle's
  configuration.
- **Keeping running installs across a reload.** See §5.8.
