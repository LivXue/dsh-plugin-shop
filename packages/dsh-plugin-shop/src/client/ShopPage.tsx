/**
 * The shop's own page in dsh's main column (design
 * 2026-10-16-shop-sidebar-page §4.2), framed as dsh frames its Plugins page:
 * the page is its own scroll container, its head carries the title and the
 * one intro line and clears the desktop title bar, and the body below is
 * `ShopTab`, unchanged.
 *
 * It keeps the reader's scroll position in the page store (design
 * 2026-10-16-shop-sidebar-page §5.7). The position is written on every
 * scroll event — a browser fires at most one a frame, and the store takes it
 * without telling anyone — with the card at the page's top edge. The page
 * goes back there once, when the shelf is on screen again and the installed
 * list has answered, unless the reader moved first: the same card at the
 * same height, held there for a moment while the cards around it render, or
 * the position when that card is no longer on the shelf or the shelf was
 * refiltered since.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { ScrollAnchor } from './page-store.ts'
import { ShopTab, type ShopTabProps } from './ShopTab.tsx'
import css from './ShopTab.module.css'

/** What each card on the shelf carries: its identity (ShopTab), not its
 * name, which two listed entries can share — a fork and its original. */
const IDENTITY = 'data-shop-identity'

/** How long the page holds the reader's card at its height once it is put
 * back, in ms. The cards near it render a frame or two later and take their
 * real heights, each correction brings a few more above it into range, and
 * the shelf's entry animation moves it for 220ms (ShopTab.module.css).
 * Measured on dsh 0.2.0-rc.2 with the live catalog, the card stood still
 * within 200ms of being put back. */
export const HOLD_MS = 500

/** The shelf's cards in document order: the children of the one list that
 * holds them, a live collection reached through the first card, so a scroll
 * event never walks the cards' own subtrees. Null while no card is on the
 * page. */
function cardsOf(scroller: HTMLElement): HTMLCollection | null {
  return scroller.querySelector(`[${IDENTITY}]`)?.parentElement?.children ?? null
}

/** The shelf's gap between two cards, in px: `.cards`' `gap` in
 * ShopTab.module.css, as the list's computed row gap reads it. */
function gapOf(list: Element | null): number {
  const gap = list === null ? Number.NaN : Number.parseFloat(getComputedStyle(list).rowGap)
  return Number.isFinite(gap) ? gap : 0
}

/**
 * Where the reader is on the shelf: the first card whose bottom lies below
 * the page's top edge, and its top relative to that edge. The cards stand one
 * per row in document order, so their bottoms rise with their index, and a
 * binary search reads a handful of their rects on each scroll event, never
 * one per card.
 *
 * A card whose top lies below the edge counts only while it lies no further
 * below than the shelf's gap between cards, as when the edge falls in that
 * gap. Further down, the reader is above the shelf, in the head or the
 * toolbar: nothing there lays out at a placeholder height, so the position
 * alone is exact, while a card would pull them down the page whenever the
 * content above the shelf grows meanwhile.
 */
function anchorAt(scroller: HTMLElement): ScrollAnchor | null {
  const cards = cardsOf(scroller)
  if (cards === null) return null
  const edge = scroller.getBoundingClientRect().top
  let low = 0
  let high = cards.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if ((cards.item(middle)?.getBoundingClientRect().bottom ?? edge) > edge) high = middle
    else low = middle + 1
  }
  const card = cards.item(low)
  // The list's last child can be the sentinel that grows the shelf, which is
  // no card.
  const key = card?.getAttribute(IDENTITY) ?? null
  if (card === null || key === null) return null
  const offset = card.getBoundingClientRect().top - edge
  if (offset > 0 && offset > gapOf(card.parentElement)) return null
  return { key, offset }
}

/** The card with `key` on the shelf, matched by iteration: an identity
 * carries `:`, `/` and `#`, which a selector would have to escape. */
function cardWith(scroller: HTMLElement, key: string): Element | null {
  const cards = cardsOf(scroller)
  if (cards === null) return null
  for (const card of cards) {
    if (card.getAttribute(IDENTITY) === key) return card
  }
  return null
}

export function ShopPage(props: ShopTabProps): ReactNode {
  const { t, page } = props
  const scroller = useRef<HTMLElement>(null)
  // A wheel, a touch or a key before the restore: the reader is already
  // somewhere, and a restore would pull the page out from under them.
  const moved = useRef(false)
  // The hold's next frame, cancelled with the page.
  const holding = useRef<number | null>(null)
  useEffect(() => () => { if (holding.current !== null) cancelAnimationFrame(holding.current) }, [])
  const restore = useCallback(() => {
    const node = scroller.current
    if (node === null || moved.current || page === undefined) return
    const anchor = page.readAnchor()
    const card = anchor === null ? null : cardWith(node, anchor.key)
    if (anchor === null || card === null) {
      // No card goes with the position (the reader was above the shelf or
      // past every card, or the shelf was refiltered since), or it is no
      // longer on the shelf, as after a refresh that moved it past the cards
      // shown or removed it: the position the reader left.
      node.scrollTop = page.readScroll()
      return
    }
    // The same card at the same height. The position alone lands elsewhere:
    // a remount builds new cards, which remember no size, so every card above
    // the reader's lays out at its placeholder height until it renders
    // (`contain-intrinsic-size`, ShopTab.module.css).
    const drift = (): number => card.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset
    // From here until the hold below ends, the page is the only hand that
    // keeps the card: the browser's own scroll anchoring is off. The shelf's
    // entry animation keeps the anchoring out of most of the layouts the hold
    // corrects but not all, so it would take one step of the cascade, the
    // hold would read that as another hand and stop, and the steps after it
    // would go uncorrected (design 2026-10-16-shop-sidebar-page §5.7).
    node.style.overflowAnchor = 'none'
    node.scrollTop += drift()
    // Then the cards around it render and take their real heights, and those
    // above it move it, so the page holds it there for a moment. A wheel, a
    // touch or a key ends the hold, as it cancels the restore, and so does a
    // scroll by any other hand, such as a dragged scrollbar. Another hand
    // moves the page a pixel or more from where this one last put it; less is
    // the browser rounding a fractional position to the pixels it keeps.
    // Whatever ends the hold turns the anchoring back on.
    let held = node.scrollTop
    const until = performance.now() + HOLD_MS
    const hold = (): void => {
      holding.current = null
      if (moved.current || Math.abs(node.scrollTop - held) >= 1 || !card.isConnected || performance.now() > until) {
        node.style.overflowAnchor = ''
        return
      }
      const off = drift()
      if (Math.abs(off) >= 1) {
        node.scrollTop += off
        held = node.scrollTop
      }
      holding.current = requestAnimationFrame(hold)
    }
    holding.current = requestAnimationFrame(hold)
  }, [page])
  const cancelRestore = (): void => { moved.current = true }
  // The page's own mount, reported to the store: this component is the only
  // thing that knows the page is on screen, and it knows it without asking
  // dsh anything — `main` mounts a selected key's panel and nothing else.
  // When a hot swap tears this instance down, its `main` entry records the
  // flag as it leaves, and the next instance's `apply` reads that record
  // (index.ts; design 2026-10-16-shop-sidebar-page §6). The probe measured
  // that record running before the entry leaves, while dsh's selection still
  // stands, on 0.1.5-rc.3, 0.1.7-rc.2 and 0.2.0-rc.2 on 2026-10-16 (design
  // 2026-10-16-shop-sidebar-page §6, §9.1); that this page is still mounted
  // then, so the record reads true for a page on screen, is the design's
  // argued half. The e2e's hot-swap case witnesses it on 0.1.7-rc.2 and
  // 0.2.0-rc.2: the page comes back there only through rule 1, which reads
  // this record, and the case fails with rule 1 removed (measured
  // 2026-10-17). An effect, not a layout effect: nothing downstream may run
  // before the first paint on the strength of it.
  useEffect(() => {
    page?.notePageMounted(true)
    return () => { page?.notePageMounted(false) }
  }, [page])
  return (
    <section
      ref={scroller}
      className={`${css.page} notranslate`}
      translate="no"
      data-shop-page
      onScroll={event => { page?.recordScroll(event.currentTarget.scrollTop, anchorAt(event.currentTarget)) }}
      onWheel={cancelRestore}
      onTouchStart={cancelRestore}
      onKeyDown={cancelRestore}
    >
      {/* The head holds no control, so dsh's desktop drag region can cover
        * all of it, as on dsh's own pages. */}
      <header className={css.pageHead} data-shop-page-head data-window-drag>
        <h1 className={css.pageTitle} data-shop-page-title>{t('title')}</h1>
        <p className={css.pageIntro} data-shop-page-intro>{t('intro')}</p>
      </header>
      <ShopTab {...props} onShelfReady={restore} />
    </section>
  )
}
