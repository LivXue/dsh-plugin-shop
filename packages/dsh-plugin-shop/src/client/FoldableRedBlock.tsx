/**
 * The shared fold: one surface's whole red block, clamped to two lines by
 * default, expanded on one press of the small pill under it, and back to two
 * on a second. One fold per surface, never per blocker: a card's body and an
 * Updatable row's refusal print the same verdict through two spellings, and
 * each folds on its own.
 *
 * The fold is measured, NOT declared: `useFoldableRedBlock` watches the block
 * and answers "is this too tall to leave alone?" from the block's own
 * rendered height, whenever the box or the text in it changes. Where nothing
 * can be measured — jsdom lays nothing out — no toggle is offered, and the
 * unit suite supplies a model of the engine instead
 * (`tests/fixtures/fold-geometry.ts`).
 *
 * The toggle is a BUTTON with `aria-expanded`, not a semantic fold the DOM
 * carries. A screen reader meets the whole block either way: the label
 * above it (`role="img"` + `aria-label` and `title`) is the accessible name
 * of the whole verdict, and it is NOT the thing that folds.
 */
import type { ReactNode } from 'react'
import { useFoldableRedBlock } from './useFoldableRedBlock.ts'
import type { ShopTabProps } from './ShopTab.tsx'
import css from './ShopTab.module.css'

export function FoldableRedBlock({ children, t, attrName }: {
  children: ReactNode
  t: ShopTabProps['t']
  /** The data attribute the block is located by; its suffix names the toggle. */
  attrName: 'data-shop-remedy' | 'data-shop-refusal' | 'data-shop-blocker-lines'
}): ReactNode {
  const { rootRef, expandable, expanded, toggle } = useFoldableRedBlock()
  const kindName = attrName.replace(/^data-shop-/, '')
  // The toggle sits OUTSIDE the clamp, on the row under it, or the whole
  // point settles back inside a two-line fold and no press can undo it. That
  // is also what keeps React's own reconciliation stable under the install
  // flow's per-second re-render: the button does not ride the block's class
  // swap, so it survives the same way the Refresh pill beside the stats row
  // does.
  return (
    <>
      <div className={expanded ? css.foldBlockExpanded : css.foldBlock} {...{ [attrName]: true }} ref={rootRef}>
        {children}
      </div>
      {expandable && (
        <button
          type="button"
          // The page's one quiet-button style, the Refresh pill's, kept
          // beside this because what it does is exactly one line long and one
          // state to read; every other button here does something. The
          // cursor stays a pointer because it is a control, not a label.
          className={css.foldToggle}
          data-shop-fold={kindName}
          aria-expanded={expanded}
          onClick={toggle}
        >
          {expanded ? t('lessRedLines') : t('moreRedLines')}
        </button>
      )}
    </>
  )
}
