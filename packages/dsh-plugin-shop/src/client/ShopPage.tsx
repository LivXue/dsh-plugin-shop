/**
 * The shop's own page in dsh's main column (design
 * 2026-10-16-shop-sidebar-page §4.2), framed as dsh frames its Plugins page:
 * the page is its own scroll container, its head carries the title and the
 * one intro line and clears the desktop title bar, and the body below is
 * `ShopTab`, unchanged.
 *
 * It keeps the reader's scroll position in the page store (§5.7). The
 * position is written on every scroll event — a browser fires at most one a
 * frame, and the store takes it without telling anyone — and restored once,
 * when the shelf is on screen again and the installed list has answered,
 * unless the reader moved first.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { ShopTab, type ShopTabProps } from './ShopTab.tsx'
import css from './ShopTab.module.css'

export function ShopPage(props: ShopTabProps): ReactNode {
  const { t, page } = props
  const scroller = useRef<HTMLElement>(null)
  // A wheel, a touch or a key before the restore: the reader is already
  // somewhere, and a restore would pull the page out from under them.
  const moved = useRef(false)
  const restore = useCallback(() => {
    const node = scroller.current
    if (node === null || moved.current || page === undefined) return
    node.scrollTop = page.readScroll()
  }, [page])
  const cancelRestore = (): void => { moved.current = true }
  // The page's own mount, reported to the store: this component is the only
  // thing that knows the page is on screen, and it knows it without asking
  // dsh anything — `main` mounts a selected key's panel and nothing else.
  // When a hot swap tears this instance down, its `main` entry records the
  // flag as it leaves, and the next instance's `apply` reads that record
  // (index.ts; design §6). The order measured on 0.1.5-rc.3, 0.1.7-rc.2 and
  // 0.2.0-rc.2 on 2026-10-16 runs that record while this page is still
  // mounted (design §6, §9.1), so it reads true for a page on screen. An
  // effect, not a layout effect: nothing downstream may run before the first
  // paint on the strength of it.
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
      onScroll={event => { page?.recordScroll(event.currentTarget.scrollTop) }}
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
