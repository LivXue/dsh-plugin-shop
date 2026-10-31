// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en, type ShopLocaleKey } from '../../src/client/locales.ts'
import { createPageStore } from '../../src/client/page-store.ts'
import { ShopDetailAction, type PluginsSubject, type ShopDetailActionInjected, type ShopDetailActionProps } from '../../src/client/ShopDetailAction.tsx'
import type { ShopCatalogResult } from '../../src/host/index.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

type Entry = ShopCatalogResult['plugins'][number]
const entry = (name: string, extra: Partial<Entry> = {}): Entry => ({
  name, version: '1.0.0', integrity: null, publishedAt: null, repository: 'https://github.com/you/x', license: 'MIT',
  tier: 'community', metadata: 'derived', source: 'npm', added: '2026-10-16',
  catalog: { category: 'tool', summary: { en: 'x', zh: 'x' }, capabilities: [] }, ...extra,
})
const catalogOf = (...plugins: Entry[]): ShopCatalogResult => ({
  schemaVersion: 2, builtAt: '2026-10-16T00:00:00Z', stale: false, plugins, denied: [], stars: {}, icons: {}, incompatible: {}, incompatibleHarness: {},
})
const bundle = (name: string): PluginsSubject => ({ kind: 'bundle', pkg: { name } })

function bench(result: () => Promise<ShopCatalogResult>, options: { canOpen?: boolean; t?: ShopDetailActionProps['t'] } = {}) {
  const page = createPageStore(() => ({ install: vi.fn(), uninstall: vi.fn(), updateStart: vi.fn(), installStatus: vi.fn() }), { pollUnwatched: false })
  const face: ShopDetailActionInjected = { listing: vi.fn(result), canOpen: () => options.canOpen ?? true, openShop: vi.fn(), page }
  const t = options.t ?? (((key: ShopLocaleKey) => en[key]) as ShopDetailActionProps['t'])
  const elementFor = (subject: PluginsSubject) => <ShopDetailAction {...({ subject, t, ...face } as unknown as ShopDetailActionProps)} />
  const renderFor = (subject: PluginsSubject) => render(elementFor(subject))
  return { page, face, renderFor, elementFor }
}

describe('the Plugins page buttons (design 2026-10-16-shop-sidebar-page §7)', () => {
  it('offers "Open Plugin shop" on the shop\'s own bundle page, and opens the page', () => {
    const { face, renderFor } = bench(async () => catalogOf())
    const { container } = renderFor(bundle('dsh-plugin-shop'))
    const button = container.querySelector('[data-shop-open-shop]')
    expect(button?.textContent).toBe('Open Plugin shop')
    fireEvent.click(button!)
    expect(face.openShop).toHaveBeenCalledTimes(1)
    expect(face.listing).not.toHaveBeenCalled()
  })

  it('offers "View in Plugin shop" on a bundle the shelf lists, and puts that plugin on the shelf', async () => {
    const { page, face, renderFor } = bench(async () => catalogOf(entry('dsh-hello-plugin')))
    page.setView({ query: 'memory', category: 'theme', hideIncompatible: true })
    page.recordScroll(900)
    const { container } = renderFor(bundle('dsh-hello-plugin'))
    await waitFor(() => expect(container.querySelector('[data-shop-view-in-shop]')).toBeTruthy())
    expect(container.querySelector('[data-shop-view-in-shop]')?.textContent).toBe('View in Plugin shop')
    fireEvent.click(container.querySelector('[data-shop-view-in-shop]')!)
    expect(page.getSnapshot().view).toMatchObject({ query: 'dsh-hello-plugin', category: null, hideIncompatible: false })
    expect(page.isExpanded('npm:dsh-hello-plugin')).toBe(true)
    expect(page.readScroll()).toBe(0)
    expect(face.openShop).toHaveBeenCalledTimes(1)
  })

  it('expands no card when two listed entries share the name', async () => {
    const { page, renderFor } = bench(async () => catalogOf(entry('dup'), entry('dup', { source: 'github', repo: 'you/dup' })))
    const { container } = renderFor(bundle('dup'))
    await waitFor(() => expect(container.querySelector('[data-shop-view-in-shop]')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-view-in-shop]')!)
    expect(page.getSnapshot().view.query).toBe('dup')
    // Neither entry's card opened: the store holds no expanded card.
    expect(page.isExpanded('npm:dup')).toBe(false)
    expect(page.isExpanded('github:you/dup#')).toBe(false)
  })

  // Each look follows `act`, which settles the answer first: a look that
  // comes too soon cannot tell "nothing" from "not rendered yet". The last
  // look is the control: under the same wait, a listed bundle's button shows.
  it('renders nothing for a bundle the catalog does not list, or the shelf does not show', async () => {
    const { face, renderFor } = bench(async () => catalogOf(entry('dsh-plugin-hub'), entry('dsh-hello-plugin')))
    const absent = renderFor(bundle('dsh-other-plugin'))
    expect(face.listing).toHaveBeenCalledTimes(1)
    await act(async () => {})
    expect(absent.container.innerHTML).toBe('')
    absent.unmount()
    // A competing market is in the catalog but never on the shelf.
    const market = renderFor(bundle('dsh-plugin-hub'))
    await act(async () => {})
    expect(market.container.innerHTML).toBe('')
    market.unmount()
    // The control: a bundle the same catalog lists, under the same wait.
    const listed = renderFor(bundle('dsh-hello-plugin'))
    await act(async () => {})
    expect(listed.container.querySelector('[data-shop-view-in-shop]')).toBeTruthy()
  })

  // dsh can hand one mounted entry the next bundle's subject. An answer is
  // kept with the name it answered for, and one that lands after the subject
  // moved on is dropped, so neither puts a button on a bundle whose own
  // answer is not in yet, or takes one from a bundle whose answer is. `act`
  // settles each answer before the next look, because a look that comes too
  // soon cannot tell "nothing changed" from "not rendered yet".
  it('answers for the bundle on screen when the Plugins page moves on to another', async () => {
    const answers: Array<(result: ShopCatalogResult) => void> = []
    const { elementFor } = bench(() => new Promise(resolve => { answers.push(resolve) }))
    const view = render(elementFor(bundle('dsh-hello-plugin')))
    view.rerender(elementFor(bundle('dsh-other-plugin')))
    await act(async () => { answers[1]?.(catalogOf(entry('dsh-other-plugin'))) })
    expect(view.container.querySelector('[data-shop-view-in-shop]')).toBeTruthy()
    // The first bundle's answer, landing late, leaves the second one's button.
    await act(async () => { answers[0]?.(catalogOf(entry('dsh-hello-plugin'))) })
    expect(view.container.querySelector('[data-shop-view-in-shop]')).toBeTruthy()
    // Back on the first bundle, its new answer not in yet: the second
    // bundle's answer says nothing about this one.
    view.rerender(elementFor(bundle('dsh-hello-plugin')))
    expect(view.container.innerHTML).toBe('')
  })

  // `listing` stays uncalled for all three: a row or item subject carries no
  // bundle name, and the shop's own bundle page needs no catalog for its
  // button. The count is the point of the case, asserted after all three
  // renders, so a later refactor that asks the catalog for any subject fails
  // here rather than in a Plugins page that quietly reads the catalog for
  // every row of every bundle.
  it('renders nothing for one of a bundle\'s rows, or an official plugin, and asks the catalog nothing', () => {
    const { face, renderFor, elementFor } = bench(async () => catalogOf(entry('dsh-hello-plugin')))
    expect(renderFor({ kind: 'row', pkg: { name: 'dsh-hello-plugin' } }).container.innerHTML).toBe('')
    expect(renderFor({ kind: 'item', id: 'shell' }).container.innerHTML).toBe('')
    // As dsh hands it over: every field of its `PluginPackageRef`, of which
    // the shop declares only the name.
    const dshBundle = { kind: 'bundle', pkg: { name: 'dsh-plugin-shop', installed: true, enabled: true, rows: [] } } as const
    expect(renderFor(dshBundle).container.innerHTML).not.toBe('')
    expect(face.listing).toHaveBeenCalledTimes(0)
    // The witness that the count moves: a listed bundle asks, and only once,
    // though dsh builds its subject afresh on every `PackageDetail` render.
    const listed = renderFor(bundle('dsh-hello-plugin'))
    listed.rerender(elementFor(bundle('dsh-hello-plugin')))
    expect(face.listing).toHaveBeenCalledTimes(1)
  })

  it('renders nothing without a layout service to open the page with', () => {
    const { renderFor } = bench(async () => catalogOf(), { canOpen: false })
    expect(renderFor(bundle('dsh-plugin-shop')).container.innerHTML).toBe('')
  })

  it('renders nothing when the catalog cannot be read', async () => {
    const { face, renderFor } = bench(() => Promise.reject(new Error('offline')))
    const { container } = renderFor(bundle('dsh-hello-plugin'))
    expect(face.listing).toHaveBeenCalledTimes(1)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  // An answer that breaks the catalog's shape throws while the button reads
  // it, which happens after the render, out of the boundary's sight. The
  // failure must still end inside the button: a rejection nothing handles
  // reaches dsh's page as an uncaught error.
  it('renders nothing for an answer it cannot read, and lets no failure escape', async () => {
    const escaped: unknown[] = []
    const onRejection = (reason: unknown): void => { escaped.push(reason) }
    process.on('unhandledRejection', onRejection)
    try {
      const { face, renderFor } = bench(async () => ({ ...catalogOf(), plugins: null }) as unknown as ShopCatalogResult)
      const { container } = renderFor(bundle('dsh-hello-plugin'))
      expect(face.listing).toHaveBeenCalledTimes(1)
      await act(async () => {})
      expect(container.innerHTML).toBe('')
      // Waits on an absence, so a late timer only gives an unhandled
      // rejection more turns to surface, never fewer.
      await new Promise(resolve => { setTimeout(resolve, 20) })
      expect(escaped).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  it('renders nothing, rather than break dsh\'s page, when it throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwing = (() => { throw new Error('locale') }) as unknown as ShopDetailActionProps['t']
    const { renderFor } = bench(async () => catalogOf(), { t: throwing })
    expect(() => renderFor(bundle('dsh-plugin-shop'))).not.toThrow()
    expect(document.querySelector('[data-shop-open-shop]')).toBeNull()
  })
})
