/**
 * The shop's two buttons on dsh's Plugins page (design
 * 2026-10-16-shop-sidebar-page §7), in the head of a detail page, before the
 * page's own switch and uninstall (`plugins.detail.actions`, dsh 0.1.7-rc.2
 * and later): "Open Plugin shop" on the shop's own bundle page, and "View in
 * Plugin shop" on the page of any bundle the shelf lists. Any other subject
 * renders nothing, as the slot's contract asks of an entry.
 *
 * It renders inside dsh's page, so it carries its own error boundary: a
 * throw here costs the reader a button, never dsh's page.
 */
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ShopCatalogResult } from '../host/index.ts'
import type { ShopPageStore } from './page-store.ts'
import { entryKey, listedOnShelf } from './present.ts'
import css from './ShopTab.module.css'

/** The shop's own package, whose bundle page gets "Open Plugin shop". */
const OWN_PACKAGE = 'dsh-plugin-shop'

/** One bundle as a detail contribution sees it: the field this reads of the
 * Plugins page's `PluginPackageRef` (`dsh-client-ui-plugin-manager`'s slot
 * contract, identical in 0.1.7-rc.2 and 0.2.0-rc.2). */
export interface PluginPackageRef {
  readonly name: string
}

/** What a detail page is about, as the Plugins page hands it over. */
export type PluginsSubject =
  | { readonly kind: 'bundle'; readonly pkg: PluginPackageRef }
  | { readonly kind: 'row'; readonly pkg: PluginPackageRef }
  | { readonly kind: 'item'; readonly id: string }

/** The face index.ts hands the buttons. */
export interface ShopDetailActionInjected {
  /** The catalog a listing question is asked of (index.ts `listing`). */
  listing: () => Promise<ShopCatalogResult>
  /** Whether the page can be opened at all: false without a layout service
   * that can select a panel. */
  canOpen: () => boolean
  openShop: () => void
  page: ShopPageStore
}

export type ShopDetailActionProps =
  { subject: PluginsSubject }
  & PropsLocale<'settings.shop'>
  & InjectFace<ShopDetailActionInjected>

export function ShopDetailAction(props: ShopDetailActionProps): ReactNode {
  return (
    <DetailActionBoundary>
      <DetailActionBody {...props} />
    </DetailActionBoundary>
  )
}

/** Renders nothing once a child throws: a lost button, never a lost page. A
 * class, because React offers error boundaries in no other form. */
class DetailActionBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('dsh-plugin-shop: the Plugins page button crashed', error, info.componentStack)
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

function DetailActionBody({ subject, t, listing, canOpen, openShop, page }: ShopDetailActionProps): ReactNode {
  const name = subject.kind === 'bundle' ? subject.pkg.name : null
  const own = name === OWN_PACKAGE
  // The identities the shelf lists under this name, once the catalog
  // answered. Kept with the name it answered for, so a late answer for the
  // previous subject never puts a button on this one.
  const [listed, setListed] = useState<{ name: string; keys: readonly string[] } | null>(null)
  useEffect(() => {
    if (name === null || own) return
    let cancelled = false
    listing().then(result => {
      if (cancelled) return
      const cleared = new Set(result.notAShop ?? [])
      setListed({ name, keys: result.plugins.filter(entry => entry.name === name && listedOnShelf(entry, cleared)).map(entryKey) })
    }).catch(() => {
      // No catalog, or none this can read, so no claim: the button stays
      // away rather than send the reader to a shelf that may not hold the
      // plugin. Reading the answer runs after the render, outside the
      // boundary, so its failure ends here too.
    })
    return () => { cancelled = true }
  }, [name, own, listing])
  if (name === null || !canOpen()) return null
  if (own) {
    return <button type="button" className={css.detailAction} data-shop-open-shop onClick={openShop}>{t('openShop')}</button>
  }
  if (listed === null || listed.name !== name || listed.keys.length === 0) return null
  // One card to open when the name is one entry; a name two listed entries
  // share (a fork and its original) opens neither, and the search shows both.
  const only = listed.keys.length === 1 ? listed.keys[0] ?? null : null
  return (
    <button
      type="button"
      className={css.detailAction}
      data-shop-view-in-shop
      onClick={() => {
        page.focus(name, only)
        openShop()
      }}
    >
      {t('viewInShop')}
    </button>
  )
}
