# The shop page on a wide screen — implementation plan

Design: [docs/design/2026-11-02-shop-widescreen-layout.md](../design/2026-11-02-shop-widescreen-layout.md).
Scope: `packages/dsh-plugin-shop` client only. No catalog, host, RPC or store
change.

## Goal

When the tab root (`.panel`) is at least 1140 CSS px wide, the shop page shows
a 232 px filter rail beside a two-column card grid; below that it keeps today's
horizontal chips and, from 872 px, two columns. One DOM tree serves both, so
every `data-shop-*` hook appears once and every existing test that selects one
keeps its meaning.

## Constraints

- The layout is chosen by the **tab root's** inline size (container query on
  `.panel`), never the viewport: dsh's main column can be narrower than the
  window. `.shelfBody` cannot be its own container, because the rule that
  turns it into a grid is the query's target.
- No control is rendered twice. No store action, ordering, filtering, scroll
  restore or page-store field changes.
- Every existing hook stays: `data-shop-category-all`,
  `data-shop-category-tab`, `data-shop-category-installed`,
  `data-shop-hide-incompatible`, `data-shop-order`, `data-shop-entry`,
  `data-shop-outdated-entry`, `data-shop-shadowed-entry`.
- `pnpm -C packages/dsh-plugin-shop test` (includes the live-harness e2e) and
  `pnpm -C packages/dsh-plugin-shop typecheck` must pass after every task that
  touches code; `pnpm test` at the root must pass at the end.

## Task 1 — the shelf body and its two arrangements

**Files:** `ShopTab.tsx` (the render from `css.categoryBar` through the two
sections), `ShopTab.module.css`.

- [ ] Raise `.page > *`'s cap from 960 to `min(1280px, 100%)`. The head and
      the panel must share the body's edges. Keep `.panel`'s `overflow: clip`
      and 3 px margin (`.searchInput` still sits at its (0, 0)) and its flex
      column with the toolbar first.
- [ ] Add `container-type: inline-size` to `.panel`.
- [ ] Wrap the category group and the switch in `<div className={css.controls}>`
      and the stats row, the cards, the empty/showing lines and the two
      sections in `<div className={css.results}>`; wrap both in
      `<div className={css.shelfBody}>`. Source order: controls, then results.
- [ ] `.shelfBody` and `.results` are `display: flex; flex-direction: column;
      gap: 14px` so today's vertical rhythm survives the move; on the panel,
      the 14 px gap now separates the toolbar from the shelf body only.
- [ ] Under `@container (min-width: 1140px)` give `.shelfBody`
      `display: grid; grid-template-columns: 232px minmax(0, 1fr);
      column-gap: 24px; row-gap: 14px;`.
- [ ] Confirm with a screenshot that the title, the toolbar and the cards
      share one left edge at 1440.
- [ ] Acceptance: at a 1680 px window (a 1280 px tab) the rail is left of the
      results; at 1440 px the grid is two columns with no rail; at 1024 px
      the page reads as today.

## Task 2 — the rail

**Files:** `ShopTab.tsx` (the switch and the headings), `ShopTab.module.css`.

- [ ] Move the switch out of `.categoryBar` into `.controls`, as its sibling.
      At narrow widths `.controls` is `display: flex; flex-wrap: nowrap;
      align-items: flex-end; gap: 6px` (nowrap: a wrapping row sends the
      switch to a line of its own as soon as the chips' max-content exceeds
      the container), the bar is `flex: 0 1 auto; min-width: 0` and wraps its
      own chips, and the switch keeps `margin-left: auto`, so it sits at the
      right edge of the bar's last line as it does today.
- [ ] Add two `<h2 className={css.railHeading}>` elements: "分类" before the
      group, "筛选" after it. "筛选" renders only when the switch does (never
      in the Installed view). Both are `display: none` outside the container
      query.
- [ ] Under the container query: `.controls` becomes a column
      (`align-items: stretch; gap: 8px`), the category buttons full-width rows
      (`display: flex; justify-content: space-between`), the switch a row, and
      `.controls` itself
      `position: sticky; top: calc(16px + var(--dsh-frame-top-clearance, 0px));
      align-self: start; max-height: calc(100vh - 32px); overflow: auto`.
- [ ] Acceptance: keyboard tab order is categories → switch → stats → cards at
      both widths; the rail scrolls internally only when taller than the
      window; and the e2e proves the rail actually sticks inside the panel's
      `overflow: clip` (Task 6).

## Task 3 — the card composition

**Files:** `ShopTab.tsx` (`EntryCard`, `ChevronIcon`'s position),
`ShopTab.module.css`.

- [ ] Restructure the header button as icon → column(name, badge row) →
      chevron. The badge row holds every existing badge in order: category,
      npm mark, octocat, version, tier, archived, stars. Nothing is dropped
      and no accessible name changes.
- [ ] Header `align-items: flex-start`; the icon and the chevron align with
      the name line; the badge row sits under the name, indented by the icon
      plus its gap, and wraps when the card is narrow. The name stays one line
      with ellipsis.
- [ ] Add `margin-top: auto` to `.cardActions`. `.cardMeta`'s existing
      `margin-left: auto` stays; together they put every card's action row on
      its row's bottom edge with size and author flush right.
- [ ] Keep the header button, the spine, `data-shop-entry`, `data-category`,
      the badge's accessible name and the expand behaviour unchanged.
- [ ] Acceptance: a jsdom test renders one card and asserts the order icon →
      name → badge row → summary → action row, and that the summary clamps two
      lines.

## Task 4 — the grid

**Files:** `ShopTab.module.css`.

- [ ] `.cards { grid-template-columns: repeat(auto-fill, minmax(min(430px,
      100%), 1fr)); gap: 8px 12px; }` with `list-style: none`, the existing
      entry animation and `prefers-reduced-motion` intact.
- [ ] Acceptance: 1680 px and 1440 px → two columns, 1024 px (a 662 px tab)
      → one; no card overflows its column at any width. Two is the ceiling
      (§2 of the design), so no width produces three.

## Task 5 — tests for structure and state

**Files:** `tests/client/ShopTab.client.spec.tsx`,
`tests/client/css-tokens.client.spec.ts`.

- [ ] CSS pins: the page cap of 1280 (replacing the 960 pin), `.panel`'s
      `container-type: inline-size`, the 1140 container threshold, the rail
      width 232, the grid minimum 430, the `8px 12px` gaps, and
      `.cardActions`' `margin-top: auto`.
- [ ] jsdom: each of the five control hooks appears exactly once; clicking
      `[data-shop-category-installed]`, a category tab, a sort order and the
      switch still calls the same store setters (the existing assertions, run
      against the new markup); the "筛选" heading is absent in the Installed
      view; the two sections render inside `.results`.
- [ ] Acceptance: the two files pass; no existing case is deleted.

## Task 6 — the e2e at three widths

**Files:** `tests/client/web-full-flow.e2e.ts` (the helpers
`checkCategoryBar` and `checkOneLine`, and the clipping case from 2026-10-22).

- [ ] Derive the three windows from the chrome the run measures once (at
      1024, below every breakpoint), targeting tab widths of 1180, 1000 and
      804, so no host's sidebar width is hard-coded; assert each arrangement
      from the measured width, that no card overhangs its column, and that
      every card fills its grid cell. There is no 390 case: dsh's chrome
      does not fit one, and 1024 already yields the 662 px column the
      clipping case guards.
- [ ] Run `checkCategoryBar` at 1680, where the bar is the rail, and keep its
      colour, contrast and width assertions; it measures each control's own
      width, so the arrangement needs no change in the helper.
- [ ] Add the sticky check: scroll the page and assert the rail's top edge
      stays under the frame clearance instead of leaving with the page.
- [ ] Keep the existing restore round trip (it runs at 1680×480, which is
      already two columns) and record in its comment that it is the grid
      case; the restore reads the card's rect, not the column count.
- [ ] Acceptance: the e2e passes on 0.1.5-rc.3 and 0.2.1-rc.5 locally (the two
      legs this machine runs) and on the four legs in CI.

## Task 7 — docs and evidence

**Files:** the design doc.

- [ ] Set the design's status to built, with the branch and worktree, and
      record every builder call that changed a decision (the sticky
      constant, the no-wrap rail, the badge row's structural indentation,
      the e2e's window mapping, the restore round trip). The commit range is
      filled in when the branch is committed, which happens on request.
- [ ] Open the PR with the three-width screenshots (1680, 1440, 1024; light
      and dark) taken from a local build, and note that the README images
      stay stale by construction until the promotion commit.
- [ ] Do **not** reshoot the README screenshots here: they shoot the published
      build, so they move in the promotion commit (CLAUDE.md).

## Verification before the pull request

```sh
pnpm -C packages/dsh-plugin-shop test        # includes web-full-flow.e2e
pnpm -C packages/dsh-plugin-shop typecheck
rm -rf packages/dsh-plugin-shop/lib && pnpm -C packages/dsh-plugin-shop build
pnpm test                                     # root
```
