/**
 * The shop's Settings section (design §5.1, amended 2026-10-15): its own
 * entry in the Settings nav, directly after Built-in plugins, where it used
 * to be a tab inside that section. The page carries the title and the one
 * intro line the built-in Models and Built-in plugins pages carry, above the
 * shop body, which is `ShopTab` unchanged.
 */
import type { ReactNode } from 'react'
import { ShopTab, type ShopTabProps } from './ShopTab.tsx'
import css from './ShopTab.module.css'

export function ShopSection(props: ShopTabProps): ReactNode {
  return (
    <div className={css.section}>
      <h2 className={css.sectionTitle} data-shop-section-title>{props.t('title')}</h2>
      <p className={css.sectionIntro} data-shop-section-intro>{props.t('intro')}</p>
      <ShopTab {...props} />
    </div>
  )
}
