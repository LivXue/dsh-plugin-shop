// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACKNOWLEDGEMENT_EN, ACKNOWLEDGEMENT_ZH, SHOP_VISIBLE_BATCH, rejectionCodeKey } from '../../src/client/present.ts'
import { en, zh, type ShopLocaleKey } from '../../src/client/locales.ts'
import { ShopTab, type ShopTabInjected, type ShopTabProps } from '../../src/client/ShopTab.tsx'
import type { ShopCatalogResult, ShopInstalledEntry } from '../../src/host/index.ts'

afterEach(cleanup)

function snapshot(overrides: Partial<ShopCatalogResult['plugins'][number]> = {}): ShopCatalogResult {
  return {
    schemaVersion: 2,
    builtAt: '2026-08-25T00:00:00Z',
    stale: false,
    plugins: [{
      name: 'dsh-hello-plugin', version: '1.2.0', integrity: null, publishedAt: null,
      repository: 'https://github.com/you/hello-plugin', license: 'MIT',
      tier: 'community', metadata: 'derived',
      catalog: { category: 'tool', summary: { en: 'Says hello.', zh: '打个招呼。' }, capabilities: ['fs', 'shell'] },
      ...overrides,
    }],
    denied: [],
    stars: {},
  }
}

function bench(catalogResult: ShopCatalogResult, installedEntries: ShopInstalledEntry[] = []) {
  const catalog = vi.fn<ShopTabInjected['catalog']>().mockResolvedValue(catalogResult)
  const install = vi.fn<ShopTabInjected['install']>().mockResolvedValue({ ok: true, installId: 'i1' })
  const installStatus = vi.fn<ShopTabInjected['installStatus']>().mockResolvedValue({ found: true, state: 'done', log: [], needsRestart: true })
  const setEnabled = vi.fn<ShopTabInjected['setEnabled']>().mockResolvedValue({ ok: true })
  const installed = vi.fn<ShopTabInjected['installed']>().mockResolvedValue(installedEntries)
  const uninstall = vi.fn<ShopTabInjected['uninstall']>().mockResolvedValue({ ok: true, installId: 'u1' })
  const injected: ShopTabInjected = { catalog, install, installStatus, setEnabled, installed, uninstall }
  return { catalog, install, installStatus, setEnabled, installed, uninstall, injected }
}

function renderTab(injected: ShopTabInjected) {
  // Dictionary-backed `t` with the published bundle's `{param}` substitution
  // semantics, so the tests exercise the real copy verbatim. The framework
  // seats PropsRuntime demands (useSessions/useWorkspaces) are exercised in
  // the apply and e2e lanes, not here.
  const t = ((key: ShopLocaleKey, params?: Record<string, unknown>): string => {
    const template = en[key]
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match))
  }) as ShopTabProps['t']
  return render(<ShopTab {...({ t, ...injected } as unknown as ShopTabProps)} />)
}

describe('ShopTab', () => {
  it('renders a derived entry as unclaimed with a tier badge and the plain-text summary', async () => {
    const { injected } = bench(snapshot())
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(screen.getByText('Says hello.')).toBeTruthy()
    expect(screen.getByText('打个招呼。')).toBeTruthy()
    expect(screen.getByText(en.unclaimed)).toBeTruthy()
    expect(screen.getByText(en.tierCommunity)).toBeTruthy()
    expect(screen.getByText(en.capabilitiesNote)).toBeTruthy()
    expect(screen.getByText('fs')).toBeTruthy()
    expect(screen.getByText('shell')).toBeTruthy()
    expect(container.querySelector('a')).toBeNull() // summaries are plain text — no links
  })

  it('renders a hostile summary as text, never as markup', async () => {
    const { injected } = bench(snapshot({
      catalog: { category: 'tool', summary: { en: '<img src=x onerror=alert(1)>' }, capabilities: [] },
    }))
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy())
    expect(container.querySelector('img')).toBeNull()
  })

  it('gates a community install behind the acknowledgement wording', async () => {
    const { injected, install } = bench(snapshot())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(screen.getByText(en.acknowledgementBody)).toBeTruthy())
    expect(screen.getByText(en.acknowledgementTitle)).toBeTruthy()
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en.confirm))
    await waitFor(() => expect(install).toHaveBeenCalledWith({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true }))
  })

  it('closes the acknowledgement gate on cancel without installing', async () => {
    const { injected, install } = bench(snapshot())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(screen.getByText(en.acknowledgementBody)).toBeTruthy())
    fireEvent.click(screen.getByText(en.cancel))
    expect(install).not.toHaveBeenCalled()
    expect(screen.queryByText(en.acknowledgementBody)).toBeNull()
  })

  it('installs a verified entry without acknowledgement', async () => {
    const { injected, install } = bench(snapshot({ tier: 'verified' }))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(install).toHaveBeenCalledWith({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: undefined }))
    expect(screen.queryByText(en.acknowledgementBody)).toBeNull()
  })

  it.each([
    ['denied', 'dsh-plugin-shop: dsh-blocked is denied: matched the denylist'],
    ['not-in-catalog', 'dsh-plugin-shop: dsh-ghost is not in the catalog snapshot'],
    ['version-mismatch', 'dsh-plugin-shop: catalog version 1.2.0, requested 9.9.9'],
    ['needs-acknowledgement', 'dsh-plugin-shop: dsh-risky is community-tier; installation requires acknowledgement'],
  ] as const)('renders the %s rejection detail verbatim', async (code, detail) => {
    const { injected, install } = bench(snapshot({ tier: 'verified' }))
    install.mockResolvedValue({ ok: false, code, detail })
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(screen.getByText(detail)).toBeTruthy())
    expect(screen.getByText(en[rejectionCodeKey(code)])).toBeTruthy()
  })

  it('shows the restart notice after a successful install', async () => {
    const { injected, installStatus } = bench(snapshot({ tier: 'verified' }))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(screen.getByText(en.installedRestartNotice)).toBeTruthy(), { timeout: 3000 })
    expect(installStatus).toHaveBeenCalledWith({ installId: 'i1' })
  })

  it('renders the failed install with the host log and detail', async () => {
    const { injected, installStatus } = bench(snapshot({ tier: 'verified' }))
    installStatus.mockResolvedValue({ found: true, state: 'failed', log: ['pnpm failed'], detail: 'pnpm failed — run: dsh plugin --profile web install' })
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(screen.getByText('pnpm failed')).toBeTruthy(), { timeout: 3000 })
    expect(screen.getByText(en.installFailed)).toBeTruthy()
    expect(screen.getByText('pnpm failed — run: dsh plugin --profile web install')).toBeTruthy()
  })

  it('never renders the transport detail of a thrown install', async () => {
    const { injected, install } = bench(snapshot({ tier: 'verified' }))
    install.mockRejectedValueOnce(new Error('shop remote: WIRE: boom'))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText(en.install))
    await waitFor(() => expect(screen.getByText(en.installTransportFailed)).toBeTruthy())
    expect(screen.queryByText('WIRE')).toBeNull() // private transport detail stays out of the UI
    expect(screen.queryByText('boom')).toBeNull()
  })

  it('labels a stale catalog with its builtAt and offers a refresh', async () => {
    const { injected, catalog } = bench({ ...snapshot(), stale: true })
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('showing 2026-08-25')).toBeTruthy())
    fireEvent.click(screen.getByText(en.refresh))
    await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2))
    expect(catalog).toHaveBeenLastCalledWith({ refresh: true })
  })

  it('filters entries by name and by summary, with an empty-search state', async () => {
    const two = snapshot()
    two.plugins.push({
      name: 'dsh-goodbye-plugin', version: '0.9.0', integrity: null, publishedAt: null,
      repository: null, license: null, tier: 'verified', metadata: 'declared',
      catalog: { category: 'tool', summary: { en: 'Waves goodbye.' }, capabilities: [] },
    })
    const { injected } = bench(two)
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-goodbye-plugin')).toBeTruthy())
    const search = screen.getByRole('searchbox', { name: en.search })
    fireEvent.change(search, { target: { value: 'goodbye' } }) // matches the name
    expect(screen.queryByText('dsh-hello-plugin')).toBeNull()
    expect(screen.getByText('dsh-goodbye-plugin')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'says' } }) // matches the en summary
    expect(screen.getByText('dsh-hello-plugin')).toBeTruthy()
    expect(screen.queryByText('dsh-goodbye-plugin')).toBeNull()
    fireEvent.change(search, { target: { value: '打个' } }) // matches the zh summary
    expect(screen.getByText('dsh-hello-plugin')).toBeTruthy()
    fireEvent.change(search, { target: { value: 'zzz-nope' } })
    expect(screen.getByText(en.emptySearch)).toBeTruthy()
  })

  it('renders the empty state for an empty catalog', async () => {
    const { injected } = bench({ ...snapshot(), plugins: [] })
    renderTab(injected)
    await waitFor(() => expect(screen.getByText(en.empty)).toBeTruthy())
  })

  it('renders the error state on a failed load and recovers on retry', async () => {
    const { injected, catalog } = bench(snapshot())
    catalog.mockRejectedValueOnce(new Error('dsh-plugin-shop: shop/catalog: net::ERR_CONNECTION_RESET'))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText(en.error)).toBeTruthy())
    expect(screen.queryByText('net::ERR_CONNECTION_RESET')).toBeNull() // private transport detail stays out of the UI
    fireEvent.click(screen.getByText(en.retry))
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
  })

  it('details a verified-stale entry with the reviewed/current version line', async () => {
    const { injected } = bench(snapshot({
      tier: 'verified-stale',
      review: { reviewedVersion: '1.0.0', reviewer: 'someone', reviewCommit: 'abc123', notes: 'reviewed against the published tarball' },
    }))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText('dsh-hello-plugin'))
    expect(screen.getByText('reviewed v1.0.0 / current v1.2.0 unreviewed')).toBeTruthy()
    expect(screen.getByText(en.version)).toBeTruthy()
    expect(screen.getByText('1.2.0')).toBeTruthy()
    expect(screen.getByText(en.repository)).toBeTruthy()
    expect(screen.getByText('https://github.com/you/hello-plugin')).toBeTruthy()
    expect(screen.getByText(en.license)).toBeTruthy()
    expect(screen.getByText('MIT')).toBeTruthy()
  })

  it('renders a https repository as a link that opens safely in a new tab', async () => {
    const { injected } = bench(snapshot())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText('dsh-hello-plugin'))
    const link = screen.getByRole('link', { name: 'https://github.com/you/hello-plugin' })
    expect(link.getAttribute('href')).toBe('https://github.com/you/hello-plugin')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders a repository that is not an http(s) URL as plain text, never a link', async () => {
    const { injected } = bench(snapshot({ repository: 'not-a-url' }))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(screen.getByText('dsh-hello-plugin'))
    expect(screen.getByText('not-a-url')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'not-a-url' })).toBeNull()
  })

  it('clamps the summary when collapsed and lifts the clamp when expanded', async () => {
    const { injected } = bench(snapshot())
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    // collapsed: the clamped class, not the expanded one
    expect(container.querySelector('[class*="_summary"]')).not.toBeNull()
    expect(container.querySelector('[class*="_summaryExpanded"]')).toBeNull()
    fireEvent.click(screen.getByText('dsh-hello-plugin'))
    // expanded: the expanded class joins the base class
    expect(container.querySelector('[class*="_summaryExpanded"]')).not.toBeNull()
  })

  it('filters the shelf by category and restores with All', async () => {
    const result = snapshot()
    result.plugins = [
      { ...result.plugins[0]!, name: 'dsh-tool-a' },
      { ...result.plugins[0]!, name: 'dsh-ui-a' },
    ]
    result.plugins[0]!.catalog = { category: 'tool', summary: { en: 'a tool' }, capabilities: [] }
    result.plugins[1]!.catalog = { category: 'ui', summary: { en: 'a ui' }, capabilities: [] }
    const { injected } = bench(result)
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-tool-a')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Tool/ }))
    expect(screen.getByText('dsh-tool-a')).toBeTruthy()
    expect(screen.queryByText('dsh-ui-a')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /All/ }))
    expect(screen.getByText('dsh-ui-a')).toBeTruthy()
  })

  it('combines the category filter with the search query as AND', async () => {
    const result = snapshot()
    result.plugins = [
      { ...result.plugins[0]!, name: 'dsh-tool-alpha' },
      { ...result.plugins[0]!, name: 'dsh-tool-beta' },
      { ...result.plugins[0]!, name: 'dsh-ui-alpha' },
    ]
    result.plugins[0]!.catalog = { category: 'tool', summary: { en: 'a tool' }, capabilities: [] }
    result.plugins[1]!.catalog = { category: 'tool', summary: { en: 'a tool' }, capabilities: [] }
    result.plugins[2]!.catalog = { category: 'ui', summary: { en: 'a ui' }, capabilities: [] }
    const { injected } = bench(result)
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-tool-alpha')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Tool/ }))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alpha' } })
    expect(screen.getByText('dsh-tool-alpha')).toBeTruthy()
    expect(screen.queryByText('dsh-tool-beta')).toBeNull()
    expect(screen.queryByText('dsh-ui-alpha')).toBeNull()
  })

  it('marks the selected category with aria-pressed', async () => {
    const { injected } = bench(snapshot())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    const all = screen.getByRole('button', { name: /All/ })
    expect(all.getAttribute('aria-pressed')).toBe('true')
    const tool = screen.getByRole('button', { name: /Tool/ })
    expect(tool.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(tool)
    expect(tool.getAttribute('aria-pressed')).toBe('true')
    expect(all.getAttribute('aria-pressed')).toBe('false')
  })

  it('pins the acknowledgement wording to §9.3 in both dictionaries', () => {
    expect(en.acknowledgementBody).toBe(ACKNOWLEDGEMENT_EN)
    expect(zh.acknowledgementBody).toBe(ACKNOWLEDGEMENT_ZH)
  })

  it('lists outdated installs with their installed and latest versions', async () => {
    const { injected, installed } = bench(snapshot(), [{ name: 'dsh-hello-plugin', installed: '1.0.0', latest: '1.2.0', outdated: true }])
    renderTab(injected)
    await waitFor(() => expect(screen.getByText(en.installedSection)).toBeTruthy())
    expect(screen.getByText('installed v1.0.0')).toBeTruthy()
    expect(screen.getByText('latest v1.2.0')).toBeTruthy()
    expect(installed).toHaveBeenCalled()
  })

  it('toggles an outdated install with setEnabled and shows the hot-apply note', async () => {
    const { injected, setEnabled } = bench(snapshot(), [{ name: 'dsh-hello-plugin', installed: '1.0.0', latest: '1.2.0', outdated: true }])
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('installed v1.0.0')).toBeTruthy())
    const toggle = screen.getByRole('switch')
    fireEvent.click(toggle)
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith({ name: 'dsh-hello-plugin', enabled: false }))
    expect(screen.getByText(en.hotApplyNote)).toBeTruthy()
  })

  it('updates an outdated install to the latest version directly when verified', async () => {
    const { injected, install } = bench(snapshot({ tier: 'verified' }), [{ name: 'dsh-hello-plugin', installed: '1.0.0', latest: '1.2.0', outdated: true }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('installed v1.0.0')).toBeTruthy())
    // The card and the installed-section row both carry an update button; this
    // test drives the section's.
    fireEvent.click(container.querySelector('[data-shop-outdated-entry="dsh-hello-plugin"] [data-shop-update]')!)
    await waitFor(() => expect(install).toHaveBeenCalledWith({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: undefined }))
  })

  it('gates a community-tier update behind the acknowledgement', async () => {
    const { injected, install } = bench(snapshot({ tier: 'community' }), [{ name: 'dsh-hello-plugin', installed: '1.0.0', latest: '1.2.0', outdated: true }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('installed v1.0.0')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-outdated-entry="dsh-hello-plugin"] [data-shop-update]')!)
    await waitFor(() => expect(screen.getByText(en.acknowledgementBody)).toBeTruthy())
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en.confirm))
    await waitFor(() => expect(install).toHaveBeenCalledWith({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true }))
  })

  it('shows the installed label instead of an install button on the card of a current install', async () => {
    const { injected } = bench(snapshot(), [{ name: 'dsh-hello-plugin', installed: '1.2.0', latest: '1.2.0', outdated: false }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    const card = container.querySelector('[data-shop-entry="dsh-hello-plugin"]')
    expect(card?.querySelector('[data-shop-installed]')?.textContent).toBe(en.installed)
    expect(card?.querySelector('[data-shop-install]')).toBeNull()
    expect(card?.querySelector('[data-shop-update]')).toBeNull()
    // The card still carries the uninstall control.
    expect(card?.querySelector('[data-shop-uninstall]')).not.toBeNull()
    // A current install has no row in the installed section.
    expect(container.querySelector('[data-shop-outdated]')).toBeNull()
  })

  it('shows the update button instead of an install button on the card of an install behind the catalog', async () => {
    const { injected, install } = bench(snapshot({ tier: 'verified' }), [{ name: 'dsh-hello-plugin', installed: '1.0.0', latest: '1.2.0', outdated: true }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('installed v1.0.0')).toBeTruthy())
    const card = container.querySelector('[data-shop-entry="dsh-hello-plugin"]')
    expect(card?.querySelector('[data-shop-installed]')).toBeNull()
    expect(card?.querySelector('[data-shop-install]')).toBeNull()
    // Update and uninstall sit side by side.
    expect(card?.querySelector('[data-shop-uninstall]')).not.toBeNull()
    fireEvent.click(card!.querySelector('[data-shop-update]')!)
    await waitFor(() => expect(install).toHaveBeenCalledWith({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: undefined }))
  })

  it('uninstalls an installed plugin through the card button and shows the restart notice', async () => {
    const { injected, uninstall } = bench(snapshot(), [{ name: 'dsh-hello-plugin', installed: '1.2.0', latest: '1.2.0', outdated: false }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-entry="dsh-hello-plugin"] [data-shop-uninstall]')!)
    await waitFor(() => expect(uninstall).toHaveBeenCalledWith({ name: 'dsh-hello-plugin' }))
    // The poll reports done; the notice replaces the button.
    await waitFor(() => expect(screen.getByText(en.uninstalledRestartNotice)).toBeTruthy(), { timeout: 3000 })
  })

  it('renders the host detail when the uninstall is refused', async () => {
    const { injected, uninstall } = bench(snapshot(), [{ name: 'dsh-hello-plugin', installed: '1.2.0', latest: '1.2.0', outdated: false }])
    uninstall.mockResolvedValue({ ok: false, detail: 'dsh-plugin-shop: dsh-hello-plugin is not installed' })
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-entry="dsh-hello-plugin"] [data-shop-uninstall]')!)
    await waitFor(() => expect(screen.getByText(en.uninstallFailed)).toBeTruthy())
    expect(screen.getByText('dsh-plugin-shop: dsh-hello-plugin is not installed')).toBeTruthy()
  })

  it('filters the shelf to installed plugins through the Installed category button', async () => {
    const result = snapshot()
    result.plugins = [
      { ...result.plugins[0]!, name: 'dsh-installed' },
      { ...result.plugins[0]!, name: 'dsh-not-installed' },
    ]
    const { injected } = bench(result, [{ name: 'dsh-installed', installed: '1.2.0', latest: '1.2.0', outdated: false }])
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-not-installed')).toBeTruthy())
    const installedButton = screen.getByRole('button', { name: /^Installed 1$/ })
    fireEvent.click(installedButton)
    await waitFor(() => expect(screen.queryByText('dsh-not-installed')).toBeNull())
    expect(screen.getByText('dsh-installed')).toBeTruthy()
    expect(installedButton.getAttribute('aria-pressed')).toBe('true')
    // All restores the whole shelf.
    fireEvent.click(screen.getByRole('button', { name: /^All 2$/ }))
    await waitFor(() => expect(screen.getByText('dsh-not-installed')).toBeTruthy())
  })

  it('gates the card update button behind the acknowledgement for a community install', async () => {
    const { injected, install } = bench(snapshot({ tier: 'community' }), [{ name: 'dsh-hello-plugin', installed: '1.0.0', latest: '1.2.0', outdated: true }])
    const { container } = renderTab(injected)
    await waitFor(() => expect(screen.getByText('installed v1.0.0')).toBeTruthy())
    fireEvent.click(container.querySelector('[data-shop-entry="dsh-hello-plugin"] [data-shop-update]')!)
    await waitFor(() => expect(screen.getByText(en.acknowledgementBody)).toBeTruthy())
    expect(install).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText(en.confirm))
    await waitFor(() => expect(install).toHaveBeenCalledWith({ name: 'dsh-hello-plugin', version: '1.2.0', acknowledged: true }))
  })

  it('sorts the shelf by stars and renders the badge on starred entries', async () => {
    const result = snapshot()
    result.plugins = [
      { ...result.plugins[0]!, name: 'dsh-nostar' },
      { ...result.plugins[0]!, name: 'dsh-top' },
    ]
    result.stars = { 'dsh-top': 1234 }
    const { injected } = bench(result)
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-top')).toBeTruthy())
    const names = [...document.querySelectorAll('[class*="_name"]')].map(el => el.textContent)
    expect(names).toEqual(['dsh-top', 'dsh-nostar'])
    // The badge is an img-role node, so the raw count names it for assistive
    // tech while the visual text stays the compact "★ 1.2k" form.
    expect(screen.getByLabelText('1234 stars')).toBeTruthy()
    expect(screen.getByText('★ 1.2k')).toBeTruthy()
  })

  it('shows no badge for an unstarred entry', async () => {
    const result = snapshot()
    result.stars = {}
    const { injected } = bench(result)
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(screen.queryByLabelText(/stars/)).toBeNull()
  })
})

describe('ShopTab shop-like filtering', () => {
  function twoPlugins(): ShopCatalogResult {
    return {
      schemaVersion: 2,
      builtAt: '2026-08-25T00:00:00Z',
      stale: false,
      stars: {},
      plugins: [
        snapshot().plugins[0]!,
        {
          name: 'dsh-plugin-shop-2', version: '2.0.0', integrity: null, publishedAt: null,
          repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
          catalog: { category: 'other', summary: { en: 'Another shop.' }, capabilities: [] },
        },
      ],
      denied: [],
    }
  }

  it('hides shop-like plugins from the browse list', async () => {
    const { injected } = bench(twoPlugins())
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(screen.queryByText('dsh-plugin-shop-2')).toBeNull()
  })

  it('keeps an installed shop-like plugin manageable in the installed section', async () => {
    const { injected } = bench(twoPlugins(), [{ name: 'dsh-plugin-shop-2', installed: '^1.0.0', latest: '2.0.0', outdated: true }])
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
    expect(screen.getByText('dsh-plugin-shop-2')).toBeTruthy()
  })
})

describe('ShopTab loading state', () => {
  it('renders a skeleton grid while the catalog loads and keeps the loading copy readable', async () => {
    const { injected, catalog } = bench(snapshot())
    let resolve!: (value: ShopCatalogResult) => void
    catalog.mockReturnValue(new Promise(r => { resolve = r }))
    const { container } = renderTab(injected)

    // The panel is busy, the skeleton is present, and the loading copy stays
    // in the accessibility tree (visually hidden).
    expect(container.querySelector('[data-shop-tab]')?.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[data-shop-skeleton]')).toBeTruthy()
    expect(container.querySelectorAll('[data-shop-skeleton] [class*="skeleton"]').length).toBeGreaterThan(0)
    expect(screen.getByText(en.loading)).toBeTruthy()

    // Settle the promise so the test exits cleanly through the ready state.
    await act(async () => { resolve(snapshot()) })
    await waitFor(() => expect(screen.getByText('dsh-hello-plugin')).toBeTruthy())
  })
})

/** Controllable IntersectionObserver for the batching tests. jsdom has none,
 * so the component's incremental rendering only engages where a stub exists;
 * the tests above (and any future ones without the stub) render everything. */
class StubIntersectionObserver {
  static instances: StubIntersectionObserver[] = []
  callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
    StubIntersectionObserver.instances.push(this)
  }
  observe(): void {}
  disconnect(): void {}
  fire(): void {
    this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
  }
}

/** A catalog of n derived entries; names sort in index order. */
function manyPlugins(n: number): ShopCatalogResult {
  const plugins = Array.from({ length: n }, (_, i) => ({
    name: `dsh-pkg-${String(i).padStart(3, '0')}`,
    version: '1.0.0', integrity: null, publishedAt: null,
    repository: null, license: 'MIT', tier: 'community', metadata: 'derived',
  })) as ShopCatalogResult['plugins']
  return { schemaVersion: 2, builtAt: '2026-08-25T00:00:00Z', stale: false, plugins, denied: [], stars: {} }
}

const showingText = (shown: number, total: number): string =>
  en.showing.replace('{shown}', String(shown)).replace('{total}', String(total))

describe('ShopTab incremental rendering', () => {
  beforeEach(() => {
    StubIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)
  })

  const cardCount = (): number => document.querySelectorAll('[data-category]').length

  it('renders only the first batch of a large catalog, with a "showing" line and a sentinel', async () => {
    const { injected } = bench(manyPlugins(100))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-pkg-000')).toBeTruthy())
    expect(cardCount()).toBe(SHOP_VISIBLE_BATCH)
    expect(screen.getByText(showingText(48, 100))).toBeTruthy()
    expect(document.querySelector('[data-shop-sentry]')).toBeTruthy()
    expect(screen.queryByText('dsh-pkg-099')).toBeNull()
  })

  it('grows by one batch each time the sentinel intersects, and stops at the total', async () => {
    const { injected } = bench(manyPlugins(100))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-pkg-000')).toBeTruthy())

    act(() => { StubIntersectionObserver.instances.at(-1)?.fire() })
    await waitFor(() => expect(cardCount()).toBe(96))
    expect(screen.getByText(showingText(96, 100))).toBeTruthy()

    act(() => { StubIntersectionObserver.instances.at(-1)?.fire() })
    await waitFor(() => expect(cardCount()).toBe(100))
    // everything is shown: the sentinel and the showing line are gone
    expect(document.querySelector('[data-shop-sentry]')).toBeNull()
    expect(screen.queryByText(showingText(100, 100))).toBeNull()
  })

  it('shows every card at once when the catalog fits in one batch', async () => {
    const { injected } = bench(manyPlugins(30))
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-pkg-000')).toBeTruthy())
    expect(cardCount()).toBe(30)
    expect(document.querySelector('[data-shop-sentry]')).toBeNull()
    expect(screen.queryByText(showingText(30, 30))).toBeNull()
  })

  it('resets to the first batch when the query changes', async () => {
    const plugins = [
      ...Array.from({ length: 60 }, (_, i) => ({ name: `dsh-alpha-${String(i).padStart(2, '0')}`, version: '1.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' })),
      ...Array.from({ length: 60 }, (_, i) => ({ name: `dsh-beta-${String(i).padStart(2, '0')}`, version: '1.0.0', integrity: null, publishedAt: null, repository: null, license: 'MIT', tier: 'community', metadata: 'derived' })),
    ] as ShopCatalogResult['plugins']
    const { injected } = bench({ schemaVersion: 2, builtAt: '2026-08-25T00:00:00Z', stale: false, plugins, denied: [], stars: {} })
    renderTab(injected)
    await waitFor(() => expect(screen.getByText('dsh-alpha-00')).toBeTruthy())

    // scroll two batches deep: 96 of 120 shown
    act(() => { StubIntersectionObserver.instances.at(-1)?.fire() })
    await waitFor(() => expect(cardCount()).toBe(96))

    // a query that matches 60 entries: the batch resets, so only 48 render
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alpha' } })
    await waitFor(() => expect(screen.getByText(showingText(48, 60))).toBeTruthy())
    expect(cardCount()).toBe(48)
    expect(screen.queryByText('dsh-beta-00')).toBeNull()
  })
})
