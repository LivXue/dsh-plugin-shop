# The shop shelf, restyled

**Date:** 2026-11-11
**Status:** accepted
**Amends:** `2026-10-23-shop-plugin-icons.md` §4 (option E) and §8.4;
`2026-11-02-shop-widescreen-layout.md` §2 (decision 2) and §6 (DOM order)

The shop's shelf is functional and dense and correct, and it reads as a list of
settings rather than as a market. This document states what that costs, what
changes, and — as much of it — what deliberately does not.

It follows `2026-11-02-shop-widescreen-layout.md`, which set the shelf's
arrangement, and `2026-10-16-shop-sidebar-page.md`, which set the page's frame.
The arrangement does not change: the shelf stays a two-column card grid under a
rail on a wide tab, and one column below it.

---

## 1. What was wrong, measured

The page's difficulty is not its colours. It is that **nothing on it says what
matters**, and one thing on it says far too much.

### 1.1 The category badge is unreadable, in all seven hues

The badge carries the one word that says which of the seven categories a
plugin belongs to. It paints that word in the raw category hue. Measured in the
live app on 2026-11-11, at 11px/600 on white:

| category | hue | contrast |
|---|---|---|
| ui | `#2DD4BF` | **1.86 : 1** |
| integration | `#34D399` | **1.92 : 1** |
| workflow | `#F59E0B` | **2.15 : 1** |
| theme | `#F472B6` | 2.65 : 1 |
| provider | `#A78BFA` | 2.72 : 1 |
| tool | `#4C8DFF` | 3.20 : 1 |
| other | `#8B8E96` | 3.28 : 1 |

Every hue is under the 4.5:1 floor, and the two that read as "green" and
"amber" are under 2.2:1. This is the same defect class the stylesheet already
fixed for the other three hues — "never paints text with the raw error token",
"never paints text with the raw warn or success token" (`css-tokens.client.spec.ts`)
— and the seven category hues were never brought under that rule.

**The fix is the rule the reds already follow:** blend the hue toward
`label-primary`, the theme's foreground pole, which darkens the word on a light
surface and lightens it on a dark one.

### 1.2 The sort pills and the category tabs are the same control

`SHELF_ORDERS` renders with `css.categoryButton` — the same class as the
category tabs — and the stylesheet's comment says so outright: "The category
pills' own classes: a choice among a few, which is what this is". So the three
sort pills are drawn exactly like the eight category tabs, one row below them,
distinguished only by a small "排序" label at their left.

A filter and an ordering are different acts. They must not look the same.

### 1.3 The chrome is three ragged rows with a hole in the middle

The toolbar holds a search box at one end and the shop's version row at the
other, with nothing between them. The category bar is a second row. The catalog
count and the sort pills are a third. The result is a page whose first
twenty-eight pixels of reading are spent on nothing.

### 1.4 The card has no hierarchy inside it

The package name, the author's description and the size are three near-identical
grey lines. The name is 13px/600, the description is 13px/400 in
`label-primary` — the same colour as the name — and the size is 12px in
`label-secondary`. The eye cannot tell which of the three is the plugin.

### 1.5 The badge's Latin typography sits on Chinese text

`.categoryBadge` carries `text-transform: uppercase` and
`letter-spacing: 0.08em`. Uppercase does nothing to a Chinese word; the
letter-spacing pulls its glyphs apart. The badge reads loose for a reason that
has nothing to do with the design.

### 1.6 The red is loud

3,572 of the 26,265 entries are incompatible with the running dsh. Each carries
its notice in saturated red. Nothing else on the page is red, so each of those
3,572 notices is the loudest thing in its card.

---

## 2. What changes

### 2.1 The category badge blends its hue toward the foreground

The badge loses its border, its uppercase and its letter-spacing. It gains a
tint of its own hue as a ground and a hue blended 50% toward `label-primary` as
its text.

The 50% mix is the point. Measured over the badge's own 15% tint, every one of
the seven hues clears 4.5:1 (the worst is `ui` at 5.14:1; `workflow`, the hue
that failed hardest, reaches 5.61:1). The mix inverts with the theme, so the
dark theme gets a light word on a dark tint: measured there, the seven run
from 7.15:1 (`tool`) to 8.09:1 (`ui`).

**This is a correctness change, not a taste change.** §1.1.

### 2.2 The sort pills stop wearing the category tabs' clothes

The three sort pills keep the class they share — the pressed rule it carries is
pinned to colour only, and the row must not reflow on a click — but a rule
scoped to `.sortGroup` takes the chrome off them: no border, no fill, the
secondary label colour. The pressed sort pill takes a 7% foreground wash and a
one-pixel edge instead, so it reads as *selected* without reading as
*filtered*.

Both rules declare colour only, like the state rules they sit beside.

### 2.3 The card gains three levels

| | before | after |
|---|---|---|
| identity | 13px/600, `label-primary` | 13.5px/600, `label-primary` |
| description | 13px/400, `label-primary` | 13px/400, **`label-secondary`** |
| facts | 12px, `label-secondary` | 12px, `label-secondary` |

The description was the same colour as the name. It is now the secondary
label, which measures 5.80:1 on white — a clear demotion, not a dimming.

The facts do not move a point. Their third level comes from three other
channels — they are monospaced and tabular, they are flush right, and they
are the only figures on the line — and a mono figure at 11px on this surface
is below the floor the rest of the shelf reads at. Shrinking them would
make them quieter and no clearer.

The action row grows a one-pixel hairline above it, so the card has a footer
and the buttons are not floating in the description.

### 2.4 The spine reads

The three-pixel spine in the category's hue is the shop's signature
(`2026-11-02-shop-widescreen-layout.md` §5) and it does not read at three
pixels. It becomes four, at 85% of the hue.

### 2.5 The badge's Latin typography comes off Chinese text

`text-transform: none`, `letter-spacing: 0`, 11px/500, and a six-pixel radius
instead of a pill. The word sits tight in its tint.

### 2.6 The chrome becomes two rows that mean something

The toolbar becomes a grid with two paired columns:

```
search              meta
count               sort
```

The left column is **what you can find** — the search box, and under it the
catalog count and its refresh button, which is what the query found. The right
column is **how the list is arranged** — the shop's version row and the sort
pills. The hole in the middle becomes the gutter it should have been.

The category bar stays its own row. It is a third kind of thing.

### 2.7 The incompatible notice gets a ground

The notice keeps its red — `--shop-error`, which measures 5.31:1 on the card —
and gains a seven-percent red ground and a one-pixel red edge, so it reads as a
block of text about one plugin rather than as a hole cut in the card. On its own
ground the same red measures 4.73:1.

The edge is one pixel and not two, because of the same rule §3 records for the
rest of the file: a control here draws at most one one-pixel line, and the
e2e scans the computed border widths to keep it that way. Two would have been
the first control in the stylesheet to draw more than one.

---

## 3. What does not change

The arrangement is not touched. The shelf stays `repeat(auto-fill, minmax(min(430px,
100%), 1fr))` — two columns under the rail on a wide tab, one below it. The card
edge stays `border-l2`, because `border-l1` reads as no edge at all (the
stylesheet's own measurement, re-measured in the live app: 1.09:1 against
white, where `l2` is 1.26:1). The hover edge stays the brand mix. No resting
shadow is added to a card, because
the one line in this stylesheet is that a shadow belongs to the hover lift
alone.

The pins that hold are the ones with a measurement behind them: the pressed tab
declares colour only, so the bar cannot reflow on a click; every control draws
at most one one-pixel line; the search box's focus ring keeps its room to paint
outside the panel.

---

## 4. The icon tile — an amendment

The tile gains a tint of its category's hue, at fifteen percent, behind the
artwork.

This is a **third option**, and it is recorded here rather than assumed:

- **option B** (the standing decision, `2026-10-23-shop-plugin-icons.md` §4):
  a 32px tile with a half-pixel border and no ground. Chosen because it matches
  dsh's own Plugins page.
- **option D** (rejected in §8.4): a light plate with `color-scheme: light`
  forced on the image, which fixes a black `currentColor` SVG but renders a
  theme-adaptive SVG's light variant — the plate's darkest pixel under
  `@openviking/dsh-memory-plugin`'s mark fell from 240 to 10.
- **option E** (this one): a tint of the category hue. It is **decoration, not
  a fix**. In the light theme it gives the tile a category colour that reads at
  a glance. In the dark theme it is nearly invisible, and the icon's own
  visibility problem — the one §8.4 is about — is exactly where it was.

The tile's **size, border and radius are unchanged**. The half-pixel border
stays, because it is what keeps the tile's edge visible in the dark theme,
where the tint does nothing.

Nothing about the icon's bytes changes: the author's icon still reaches the DOM
only as an `<img>`'s `src` (§8.5).

---

## 5. What this does not fix

- **A dark-theme icon that vanishes.** §4. Fixing it needs a light ground in
  the dark theme, which option D priced and the design declined.
- **The volume of red.** 3,572 notices are still 3,572 notices. This gives
  them a ground; it does not make them rarer.
- **The card grid's density.** Two columns stay two columns. A denser shelf is
  a different design, with a different set of trade-offs, and is not this one.
- **The `分类` and `筛选` headings**, which are hidden below 1140px because the
  rail is not there to carry them. The chips' own counts say what they are.

## 6. Review corrections, 2026-11-12

Five details from the max-effort review changed what §2 through §4 describe.
They are recorded here because the reasons are measurements, not taste.

- **The count's quiet step is 90%, not 75%.** The count is 11px and the file
  holds 4.5:1 for 11px text. At 75% it measured 3.37:1 on the light theme's
  white; at 90% it measures 4.63:1 and the name stays at 5.80:1. The pressed
  count inherits that 0.9 over the 22% fill and measures 4.53:1 at the `ui`
  hue, the worst of the seven. The dark theme was never the constraint.
- **The pressed sort pill's edge is `border-l2`.** §2.2 asks for a one-pixel
  edge; `border-l1` is 1.09:1 against the page and §3 already calls it no
  edge at all, so the wash was the only thing drawing the state.
- **The search glyph is markup, not a background image.** A `url()` data URI
  passes through the client build's CSS-modules rewrite, which replaced the
  `.w3` in `www.w3.org` with a hashed class name and shipped an SVG namespace
  Chromium refuses; the field drew no glyph. An `aria-hidden` SVG is still
  not announced, and `currentColor` fixes a second defect the fixed gray had:
  it stayed a light-theme gray in the dark palette.
- **A pressed tab's count may not declare a second opacity.** The base rule
  owns the 0.9 step; the pressed rule changes colour only, and the
  colour-only guard now covers it.
- **Forced colours get the badge's shape back.** The system palette erases
  the 15% tint, so the chip became a plain run of text. An inside outline
  restores the shape in that mode without moving the box; the word, and so
  the information, was never at risk.

The DOM order also changed: the count and Refresh now follow the version row
and GitHub link, so tab order is row-major (search, version row, count, sort,
categories, cards) instead of jumping down-left before crossing right. The
grid areas still paint search/version above count/sort.
