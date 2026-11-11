# The shop page on a wide screen — design

Status: **released 2026-11-02 as 0.9.1**; the §4 amendment of 2026-11-06 (the
switches' words on one line) is released in 0.9.3 (2026-11-07).
LivXue chose direction A — a filter rail and a two-column card grid — from
four mockups on 2026-11-02 (`.claude/worktrees/.scratch-shop-ui/mockups.html`,
never committed). It changes the page's layout only; the catalog, the RPC
shapes and every store action stay as they are. English only, per convention.

## 1. What is wrong today

The page is one column of cards under a 960 px cap (`.page > *` in
`ShopTab.module.css`), and the controls that decide what the shelf shows are
spread over two rows that wrap at that width:

- A card spans almost the whole page, so a two-line summary ends in a long
  line of text with nothing beside it, and the footer's size and author sit
  far from the install button they belong with.
- The category bar wraps; the count/date/refresh/sort line sits under it and
  wraps again in narrower windows.
- The measured window of the report that started this (2026-11-01, dsh
  0.2.1-rc.5, shop 0.9.1-beta.0): 1568 × 765 image at ~1.5 device pixel ratio,
  about 1045 CSS px, content 924 px — the cap does not bind, and a card is 924
  px wide.

The page already survives a narrow column (design
2026-10-16-shop-sidebar-page §4.2, its 2026-10-22 amendment), so this design
must not regress that: the layout is chosen against the page's own width, not
the window's (see §3).

## 2. Decisions (LivXue, 2026-11-02)

1. **Direction A.** A filter rail on the left when there is room, and a card
   grid of two columns instead of one. Two is the ceiling, not a stage: with
   the 1280 px cap, a 232 px rail and a 24 px gap the results column is 1024
   px, and three 430 px cards plus two gaps need 1314.
2. **The rail holds categories and the hide-incompatible switch.** Sorting
   stays in the toolbar at every width — since 2026-11-11 in its right
   column, on the same row as the count and Refresh rather than beside them
   (design `2026-11-11-shop-shelf-restyle.md` §2.6) — because it is a
   property of the result set rather than a filter.
3. **One DOM tree for both arrangements.** The rail is today's category group
   and switch, reflowed by CSS; no control is rendered twice, so every
   `data-shop-*` hook appears once and the tests that select them keep their
   meaning.
4. **Below the rail width, the page is today's page** — horizontal chips and
   one column — with the card composition of §5.
5. **No new data, no changed semantics.** Ordering, filtering, the installed
   view, the outdated and shadowed sections, scroll restore and the page store
   are untouched. A card/table toggle is a later phase and is out of scope; so
   is a master/detail split.

## 3. Widths and breakpoints

The page's own width decides, not the viewport: dsh's main column can be
narrower than the window (the 2026-10-22 clipping fix exists because of that),
so the layout uses a **container query**, not a media query.

- `.page > *` rises from 960 to `min(1280px, 100%)`, for `.pageHead` and
  `.panel` alike: a head at 960 over a body at 1280 would be inset 160 px on
  each side and read as misaligned. `.panel` keeps its `overflow: clip` and
  3 px clip margin — `.searchInput` is still its first child at (0, 0), so its
  focus ring still paints outside the box — and keeps its `display: flex`
  column with the toolbar first.
- **The container is `.panel`, not `.shelfBody`.** A container cannot answer
  its own query, and the rule that turns the shelf body into a
  `232px minmax(0, 1fr)` grid is exactly that rule. `.shelfBody` is an
  unpadded block child of the panel, so its inline size *is* the panel's; the
  query names the tab root, which is also the width the toolbar gets.

  ```css
  .page > * { width: 100%; max-width: min(1280px, 100%); }
  .panel    { container-type: inline-size; }
  ```

- Breakpoints on the **panel's** inline size:

  | Inline size | Layout |
  |---|---|
  | ≥ 1140 px | rail 232 px + results; results grid `repeat(auto-fill, minmax(430px, 1fr))`, two columns |
  | 872–1139 px | no rail (controls as today's wrapping chips); two columns |
  | < 872 px | no rail; one column |

  The numbers are the requirement, not a taste: two 430 px tracks and the
  12 px gap need 872 px of results column, the rail and its gap add 256, so
  the rail arrives at 1128 and the design pins **1140** for twelve pixels of
  margin. Below 872 the grid's `minmax(min(430px, 100%), 1fr)` yields one
  column by itself; the 872 bound is stated so the e2e can pin it.
- At the 2026-11-01 window (§1) the panel is about 924 px, so the shop there
  keeps the chips and gains the two columns; **the rail needs a panel of
  1140 px**, a genuinely wide window. That is the intended progression, not a
  miss: the two-column grid is what the current window buys.

## 4. The layout

Markup, in this order (the order a screen reader reads and the eye follows):

```
.page
  header.pageHead                      h1 + intro; no control, the drag region
  .panel                               the tab root; the container; capped 1280
    .toolbar                           search, then version/Check + GitHub,
                                       then count/Refresh, then sort
                                       (two grid rows: search | version,
                                       count | sort; amended 2026-11-11)
    .shelfBody
      .controls                        the category group + the switch
        h2.railHeading                 "分类" — wide only
        .categoryBar                   role="group", unchanged
        h2.railHeading                 "筛选" — wide only, only with the switch
        button[data-shop-hide-incompatible]
      .results
        ul.cards                       the grid
        empty / showing lines
        OutdatedSection                installed view only
        ShadowedSection                installed view only
```

> **2026-11-11 note.** The count, the Refresh button and the sort left
> `.results` for the toolbar, which became a grid of two paired columns: the
> search box and the count it found on the left, the shop's version row and
> the sort on the right. The three rows the page read as are now two, and the
> hole between the search box and the version row is the gutter between two
> columns that mean something. The count is what the QUERY found and the sort
> is how the list is ARRANGED; beside each other in the results column they
> read as one more row of shelf furniture. Design:
> `2026-11-11-shop-shelf-restyle.md` §2.6.
>
> The consequence on a wide tab: the toolbar spans both columns, so the count
> now sits above the rail rather than above the cards, and the sort above the
> cards where it already was. The rail's own headings stay where they are.

- **Vertical rhythm is unchanged.** `.panel`'s 14 px gap stays between
  `.toolbar` and `.shelfBody`; `.shelfBody` and `.results` each carry
  `display: flex; flex-direction: column; gap: 14px` at narrow widths, and
  under the wide rule `.shelfBody` becomes a single-row grid with
  `column-gap: 24px` and the same 14 px row gap. Today's gaps between the bar,
  the stats row, the cards and the sections therefore survive the move.
- **Narrow (`< 1140 px`)**: `.shelfBody` is a column. `.controls` is a flex
  row (`flex-wrap: nowrap`, `align-items: flex-end`) holding the bar and the
  switch: the bar is `flex: 0 1 auto; min-width: 0` and wraps its own chips,
  while the switch sits at the right edge with `margin-left: auto`,
  bottom-aligned with the bar's last line. `nowrap` is load-bearing: flex
  line-breaking uses the chips' max-content width, so with `wrap` the switch
  drops to a line of its own on every narrow panel (measured 84 px tall
  against 52 px). The rail headings are `display: none`. Apart from §5, this
  is today's page.

  **Amended 2026-11-06: a switch never breaks its words.** Since the
  favorites switch (design 2026-11-02-market-borrowings §7) the row holds two
  switches, and a row that cannot fit its items shrinks every one of them:
  each switch was squeezed below its own content and broke its label
  mid-word — 只看收 / 藏, 隐藏不兼容 / 3708 — reported on a two-column panel
  against the live catalog's counts. `white-space: nowrap` on
  `.incompatibleFilter`, the class both switches carry, makes a label's
  min-content its whole width, which a flex item's automatic minimum does not
  shrink below; the squeeze goes to the bar, whose chips wrap.
- **Wide (`≥ 1140 px`)**: `.shelfBody` is
  `grid-template-columns: 232px minmax(0, 1fr); column-gap: 24px;` with
  `.controls` in the first column and `.results` in the second. `.controls`
  becomes a vertical rail:
  - `position: sticky; top: calc(16px + var(--dsh-frame-top-clearance, 0px));
    align-self: start; max-height: calc(100vh - 32px - var(--dsh-frame-top-
    clearance, 0px)); overflow: auto;` — the cap subtracts the same clearance
    the offset adds, or a rail that fits the cap hangs below the viewport
    while stuck.
  - Category buttons become full-width rows, label left, count right, same
    classes and `aria-pressed`; the switch becomes a row under the "筛选"
    heading.
  - Two visually quiet `<h2>` headings ("分类", "筛选"); "排序" is absent — see
    decision 2 — and "筛选" is rendered only when the switch is.
- **Sort** stays visible, as pills, at every width. It left `.catalogStatsRow`
  for the toolbar on 2026-11-11 (the note above): the sort is how the list is
  ARRANGED, and it moved with the count rather than on its own. Its pills
  also stopped wearing the category tabs' chrome, so three sort pills beside
  eight category tabs no longer read as three more categories (design
  `2026-11-11-shop-shelf-restyle.md` §2.2).
- **The sticky rail must actually stick.** `.panel` already carries
  `overflow: clip`, which is not a scroll container, so the page remains the
  scrollport; but that is a property to prove, not assume. The e2e scrolls the
  page and reads the rail's top edge before and after (§7).
- **Scroll restore** (`page-store`) keys cards by identity and takes the card
  at the top edge. In a grid that card sits at the top of its row, with its
  neighbour beside it — still "the card the reader was at, at the top edge".
  The existing jsdom restore specs keep their one-column fake (they test the
  arithmetic, not pixels); the two-column behaviour is checked in the e2e
  (§7), where a real layout exists.

## 5. The card

The card keeps every field and hook (`data-shop-entry`, `data-category`, the
header button, the spine, the action row) and changes composition. Today's
header puts the icon, the name and a badge cluster holding seven items on one
row, which at 430 px would leave the name about 120 px; the badge cluster
moves to a second line, under the name, and the chevron keeps the right edge:

```
[icon 32] [name ..........................] [chevron]
          [category] [npm] [octocat] [v1.0.0] [tier] [archived] [★ 92.2k]
[summary, two lines]
[Install]                              [listed date · 7.3 MB · author]
```

- Header: a flex row with `align-items: flex-start`; the icon and the chevron
  align with the name's line, and the name sits in a column wrapper with the
  badge row under it (indented by the icon plus its gap). The name stays one
  line with ellipsis. Nothing is dropped or reordered inside the badge row:
  category badge, npm mark, octocat, version, tier, archived and stars are
  all still there, still carrying their own accessible names, and the header
  button still carries the category badge's name.
- Summary: clamp two lines as today (`-webkit-line-clamp: 2`).
- Action row: today's `.cardActions` with the install/update/uninstall
  controls and the gate on the left, and `.cardMeta` (shelf date, size,
  author) flush right via its existing `margin-left: auto`. Add
  `margin-top: auto` to `.cardActions`, and make the grid item a one-row
  grid (`.cards > li { display: grid }`) so the card fills the stretched
  cell. Both halves are needed: without the item's grid the card keeps its
  content height and the auto margin has no free space to absorb — measured
  65 px short at a 1280 px tab — so two cards in a row end their buttons on
  different lines. An installed card's action row holds more controls and
  already wraps; that is unchanged.
- The grid gap is 8 px vertically (today's) and 12 px between columns.
- The whole header stays the expand toggle; the badge row is decoration with
  its accessible names. The card keeps its border radius, spine, hover and
  entry animation (`prefers-reduced-motion` still respected).

## 6. Accessibility

- `.controls` is a plain `<div>`, not a `<nav>`: these are filter buttons, not
  links, and a navigation landmark would promise the wrong thing. The two
  `<h2 class="railHeading">` elements give the rail its structure and are
  `display: none` below the threshold, where the controls are one bar and the
  headings describe nothing.
- `.categoryBar` keeps `role="group"` and its `aria-label`; the category
  buttons keep `aria-pressed`; the switch keeps `role="switch"` and
  `aria-checked`. The switch moves out of the group to sit beside the "筛选"
  heading — a boolean modifier was never one of the categories — and its own
  state and behaviour are unchanged. It is still absent in the Installed view,
  and the "筛选" heading is absent with it.
- DOM order is toolbar, then controls, then results at every width. The
  toolbar's own order is row-major — search → version/Check + GitHub →
  count/Refresh → sort (amended 2026-11-11) — so tab order follows the eye:
  search, version row, count, sort, categories → switch → cards.
- The sticky rail takes no focus of its own and does not trap scrolling; its
  `overflow: auto` exists only for a rail taller than the window.
- The counts in the rail are the same text the chips carry, so a screen
  reader hears one count per category, not two.
- The shelf's own geometry is `checkShelfLayout`'s job (rail width, the
  arrangement, the column count, no overhang, the card filling its cell);
  `checkCategoryBar` runs at the wide width, where the bar is the rail, and
  `checkOneLine` is unchanged — its rule that no element gains a second
  border, shadow or outline still holds for the rail's plain rows.

## 7. Testing

- **CSS pins** (`css-tokens.client.spec.ts`): the page cap of 1280 (replacing
  the 960 pin), `.panel`'s `container-type: inline-size`, the 1140 container
  threshold, the rail width of 232, the grid minimum of 430, the 8 px/12 px
  gaps, and `.cardActions`' `margin-top: auto`.
- **jsdom** (`ShopTab.client.spec.tsx`): each control's hook appears exactly
  once; the rail's buttons still call the same store setters; a card renders
  icon, name, badge row, summary and action row in that order; the installed
  view and the outdated/shadowed sections render inside `.results`.
- **e2e** (`web-full-flow.e2e.ts`): three arrangements — the rail with two
  columns, two columns without a rail, and one column — each asserted
  against the tab width it MEASURES, plus no card overhanging its column and
  every card filling its grid cell. **The window width is not the tab's**:
  dsh's sidebar and the page's padding sit between them, so the run measures
  that chrome once (at 1024, where the tab is below every breakpoint) and
  derives three windows targeting tab widths of 1180, 1000 and 804. A fixed
  window pair would assert the host's sidebar width rather than this page's
  layout; the 0.1.5 leg's chrome differs from 0.2.x's. There is no 390 px
  case: the shop is a page inside dsh, whose chrome does not fit there, and
  the narrowest real state is the 662 px column the 2026-10-22 clipping case
  already guards. Since 2026-11-06 each of the three also asserts that both
  switches' words sit on one line, counted from their text's line boxes:
  every box check passed while the labels broke (§4 amendment). Two
  additions:
  - **the sticky rail**: scroll the page and assert the rail's top edge moved
    by no more than the page's own scroll while the results column scrolled
    under it;
  - **the scroll restore round trip**, which the flow already runs at
    1680×480: scroll into the shelf, leave the page, return, and the anchor
    card is at the same top edge. At 1680 the grid is already two columns, so
    this is the grid case; no new round trip is added, because the restore
    reads the card's rect and never the column count. It is the one
    grid-specific behaviour jsdom cannot see, because jsdom evaluates no
    container queries and `ShopPage.client.spec.tsx`'s `layOut` fake
    hard-codes one card per row.
- **PR screenshots, amended 2026-11-02 after review**: the three-width set
  was not produced. `shoot-readme-screenshots` captures the PUBLISHED build,
  and a local-build capture needs a harness of its own; the first build
  therefore shipped without the artifact, and the review found the rail's
  inside broken while every geometry-only check passed. The gap is answered
  in code rather than prose: `checkShelfLayout` now measures the rail's
  inside (button width, the label/count split, the switch's row), which is
  what a screenshot would have shown, and the visual pass belongs to the
  beta hand-check on a real profile. The README set is still the six steps
  the shoot script produces (shelf light/dark in en and zh, the gate in en
  and zh), reshot in the promotion commit against the published build.

## 8. Left to the builder

The exact vertical rhythm inside the rail, the sticky offset's constant, the
small-caps heading type, and the empty-state layout inside the wider results
column.

## 9. Built (2026-11-02)

The page, the rail, the card composition and the grid are implemented as
specified, with these builder calls:

- The sticky offset is `16px + var(--dsh-frame-top-clearance, 0px)`, and the
  cap subtracts that clearance too. The controls row is `flex-wrap: nowrap`
  at both widths: a wrapping COLUMN with a `max-height` would split a tall
  rail into a second column instead of scrolling it, and a wrapping ROW sends
  the switch to a line of its own on every narrow panel (measured 84 px tall
  against 52 px for the old bar).
- **The whole `@container` block must stay last in the stylesheet.** Nesting
  adds no specificity: between a container rule and a top-level rule of the
  same selector, source order decides. The first build wrote the block above
  `.categoryBar`, `.categoryButton` and the two focus rules, so the rail kept
  the pills' row (a 53 px button in a 232 px rail), the switch's auto margin
  and the outside focus ring, while the geometry-only e2e stayed green. The
  block now sits at the end of the file, `css-tokens.client.spec.ts` fails if
  it moves back up, and the e2e measures the rail's INSIDE — button width,
  the label/count split and the switch's row — not only its box.
- The badge row's indentation is structural, not a margin: the header is
  icon | column(name, badges) | chevron, so the row starts where the name
  does by construction. The chevron left the badge cluster to keep the right
  edge.
- The category buttons carry their label and count in two spans, which is
  what lets the rail put the label left and the count right. Their accessible
  names are unchanged.
- The narrow `.controls` row's bar is `flex: 0 1 auto`: it may shrink and
  wrap its own chips, but it must not grow, or it would take the whole line.
- The grid item (`.cards > li`) is a one-row grid, so the card fills the
  stretched cell and `margin-top: auto` on the action row has free space to
  absorb. Without it every card kept its content height — measured 65 px
  short of its cell at a 1280 px tab — and two cards in a row ended their
  buttons on different lines.
- The rail's controls draw their focus ring inset (`outline-offset: -2px`,
  the `.entryHeader` idiom): the rail is a scroll container and its controls
  are flush with its padding box, so an outside ring lost both vertical
  segments to the clip.
- **The card edge is `border-l2`** (2026-11-02, after the beta hand-check
  asked for a slightly deeper edge). The page and the card are both
  `bg-layer-1` — the light theme resolves every layer token to white — so
  the border is the card's only edge, and `border-l1` (4% black on white,
  #f5f5f5) read as no edge. `border-l2` is 10% (#e5e5e5), lifting the edge's
  contrast against white from 1.09:1 to 1.26:1 (recomputed from the live
  tokens, 2026-11-12), and in dark from 6% to 12% white on #232324. The hover
  mix follows the same base.
- The e2e derives its three windows from the chrome it measures once (at
  1024, below every breakpoint): tab widths of 1180, 1000 and 804. A fixed
  window pair would assert the host's sidebar width, and the 0.1.5 leg's
  differs from 0.2.x's. The 390 px case is dropped: dsh's chrome does not
  fit it, and the 1024 window already exercises the 662 px column the
  2026-10-22 clipping case guards. The sticky check compares the rail's
  movement with the results' over the same 100 px of scroll, because the
  shelf scrolls only about 262 px in that window — less than a fixed-offset
  check assumed. The existing clipping case derives its narrow window the
  same way: at a fixed 1024 its single 662 px column is wider than a 634 px
  wide-grid card, and its skipped-card precondition did not hold at a 160 px
  window on Ubuntu; it now runs at 60 px and narrows to one card-width below
  the measured wide card.
- The existing 1680×480 restore round trip is the grid case; no second round
  trip was added, because the restore reads the card's rect, not the column
  count.

Verified on dsh 0.2.1-rc.5: the package's full suite (55 files, 1906 tests,
including the live web full flow's 12/12 cases — the three arrangements, the
rail's sticky edge, no overhang and the cell fill) and `typecheck`. The 0.1.5
leg was not available on this machine — its prefix had been removed — so that
leg runs in CI.
