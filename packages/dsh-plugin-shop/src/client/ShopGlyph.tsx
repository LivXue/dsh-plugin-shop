/**
 * The shop's glyph in dsh's sidebar (design 2026-10-16-shop-sidebar-page
 * §4.3): a bag with a whale tail, drawn the way dsh draws its own panel
 * glyphs — a 16×16 view box, one-pixel `currentColor` strokes, no fill — so
 * the row's colour and its selection treatment reach it unchanged. `active`
 * is ignored, as dsh's own glyphs ignore it: the row draws the selection.
 */
import type { ReactNode } from 'react'

export function ShopGlyph({ size }: { size: number; active: boolean }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-shop-glyph
    >
      <path d="M4.7 5.5H11.3Q12.5 5.5 12.632 6.693L13.368 13.307Q13.5 14.5 12.3 14.5H3.7Q2.5 14.5 2.632 13.307L3.368 6.693Q3.5 5.5 4.7 5.5Z" />
      <path d="M5.75 5.5V4.25a2.25 2.25 0 0 1 4.5 0V5.5" />
      <path d="M8 12.75V11.25" />
      <path d="M8 11.25C7.4 10.2 6.6 9.8 5.75 9.75" />
      <path d="M8 11.25C8.6 10.2 9.4 9.8 10.25 9.75" />
    </svg>
  )
}
