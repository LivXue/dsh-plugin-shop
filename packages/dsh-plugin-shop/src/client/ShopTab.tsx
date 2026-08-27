/** The shop tab: browse the catalog, detail an entry, install with the
 * acknowledgement gate, poll the install to its terminal state (§7.2).
 * Everything the tab renders is text — summaries, capabilities, log lines,
 * details — never markup, so hostile npm descriptions cannot inject (spec
 * §11.3.4): no render path here may ever use dangerouslySetInnerHTML. */

import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogEntry, InstallArgs, ShopCatalogResult, ShopInstalledEntry, ShopInstallResult, ShopInstallStatusResult, ShopRestartResult, ShopSetEnabledResult, ShopUninstallResult } from '../host/index.ts'
import { CATEGORY_ORDER, SHOP_VISIBLE_BATCH, type Category, categoryKey, categoryLocaleKey, formatStars, isShopLike, isUnclaimed, nextVisibleCount, rejectionCodeKey, sortByStars, tierKey } from './present.ts'
import { useInstall } from './useInstall.ts'
import { useUninstall } from './useUninstall.ts'
import css from './ShopTab.module.css'

/** The tab's Remote face: the Host result types, already unwrapped from the
 * wire envelope by `index.ts`; `catalog` throws on a wire error so the tab's
 * error state renders. */
export interface ShopTabInjected {
  catalog: (args?: { refresh?: boolean }) => Promise<ShopCatalogResult>
  install: (args: InstallArgs) => Promise<ShopInstallResult>
  installStatus: (args: { installId: string }) => Promise<ShopInstallStatusResult>
  setEnabled: (args: { name: string; enabled: boolean }) => Promise<ShopSetEnabledResult>
  installed: () => Promise<ShopInstalledEntry[]>
  uninstall: (args: { name: string }) => Promise<ShopUninstallResult>
  restart: () => Promise<ShopRestartResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type ShopTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.shop'>
  & InjectFace<ShopTabInjected>

/** What the tab is trying to load, and with which catalog cache behavior:
 * a refresh forces the network re-fetch while the stale snapshot stays
 * visible (§10); a retry leaves the error state and starts from loading. */
type LoadRequest = { kind: 'initial' } | { kind: 'refresh' } | { kind: 'retry' }

type CatalogState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; result: ShopCatalogResult }

/** The installed list state (§7.3). `installed()` runs alongside `catalog()`
 * and its rows ARE the tab's installed signal: a shelf card for an installed
 * entry shows its installed state — or the update button when behind —
 * instead of the install button, and the entries rendered as the "installed"
 * section are the same list filtered to `outdated`. The enabled switch per
 * row is optimistic (v0 assumes an installed plugin is on). */
type InstalledState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; entries: ShopInstalledEntry[] }

function ChevronIcon({ open }: { open: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className={open ? css.chevronOpen : css.chevron}>
      <path fill="currentColor" d="M3.5 6 8 10.5 12.5 6l1 1L8 12.5 2.5 7l1-1Z" />
    </svg>
  )
}

/** One entry card: the category spine and cover band, the expandable header
 * (name, tier, category, unclaimed marker), the plain-text summary in both
 * languages, the self-declared capabilities, the detail section, and the
 * install controls. An installed plugin's card carries its installed row:
 * current → the non-interactive installed label, behind → the update button;
 * uninstalled → the install button. */
const EntryCard = memo(function EntryCard({ entry, stars, installed, t, install, installStatus, uninstall, restart }: {
  entry: CatalogEntry
  stars: number | undefined
  installed: ShopInstalledEntry | undefined
  t: ShopTabProps['t']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  uninstall: ShopTabInjected['uninstall']
  restart: ShopTabInjected['restart']
}): ReactNode {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const summary = entry.catalog?.summary
  const category = entry.catalog?.category ?? 'other'
  return (
    <div className={css.card} data-shop-entry={entry.name} data-category={category}>
      <span className={css.cardSpine} aria-hidden="true" />
      <span className={css.cardCover} aria-hidden="true">
        <span className={css.coverLabel}>{t(categoryKey(entry))}</span>
      </span>
      <button
        type="button"
        className={css.entryHeader}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(current => !current)}
      >
        <span className={css.name}>{entry.name}</span>
        <span className={css.badges}>
          <span className={css.tierBadge} data-tier={entry.tier}>{t(tierKey(entry.tier))}</span>
          {isUnclaimed(entry) && <span className={css.unclaimedBadge}>{t('unclaimed')}</span>}
          {stars !== undefined && (
            // role="img" names the badge for assistive tech (ARIA refuses to
            // name a generic element); the name carries the RAW count — the
            // locale's "1234 stars" — while the visual text stays compact.
            <span className={css.starsBadge} role="img" aria-label={t('stars', { count: stars })}>★ {formatStars(stars)}</span>
          )}
          <ChevronIcon open={open} />
        </span>
      </button>
      <div className={css.body}>
        {summary !== undefined && (
          // Collapsed cards clamp the summary to keep the shelf even; an
          // expanded card lifts the clamp so the author's full text shows.
          <p className={open ? `${css.summary} ${css.summaryExpanded}` : css.summary}>{summary.en}</p>
        )}
        {summary?.zh !== undefined && (
          <p className={open ? `${css.summaryZh} ${css.summaryZhExpanded}` : css.summaryZh}>{summary.zh}</p>
        )}
        {entry.catalog !== undefined && entry.catalog.capabilities.length > 0 && (
          <div className={css.capabilitiesBlock}>
            <p className={css.capabilitiesNote}>{t('capabilitiesNote')}</p>
            <ul className={css.capabilities}>
              {entry.catalog.capabilities.map(capability => <li key={capability}>{capability}</li>)}
            </ul>
          </div>
        )}
        {open && (
          <section id={detailId} className={css.detail}>
            <dl className={css.detailRows}>
              <div className={css.detailRow}>
                <dt>{t('version')}</dt>
                <dd>{entry.version}</dd>
              </div>
              {entry.repository !== null && (
                <div className={css.detailRow}>
                  <dt>{t('repository')}</dt>
                  <dd>
                    {/^https?:\/\//.test(entry.repository) ? (
                      // The catalog is untrusted input: only a value that IS
                      // an http(s) URL becomes a link; anything else renders
                      // as plain text. New tab + noopener/noreferrer keeps the
                      // opened page from reaching back into this tab.
                      <a href={entry.repository} target="_blank" rel="noopener noreferrer">
                        {entry.repository}
                      </a>
                    ) : entry.repository}
                  </dd>
                </div>
              )}
              {entry.license !== null && (
                <div className={css.detailRow}>
                  <dt>{t('license')}</dt>
                  <dd>{entry.license}</dd>
                </div>
              )}
            </dl>
            {entry.tier === 'verified-stale' && entry.review !== undefined && (
              <p className={css.reviewedLine}>
                {t('reviewedVersionLine', { reviewed: entry.review.reviewedVersion, current: entry.version })}
              </p>
            )}
          </section>
        )}
        {installed === undefined ? (
          <InstallPanel name={entry.name} version={entry.version} tier={entry.tier} t={t} install={install} installStatus={installStatus} restart={restart} />
        ) : (
          <div className={css.installedActions}>
            {installed.outdated ? (
              // The update button drives the same install flow for the
              // catalog's latest version; the community gate still applies
              // (§9.3).
              <InstallPanel name={entry.name} version={entry.version} tier={entry.tier} variant="update" t={t} install={install} installStatus={installStatus} restart={restart} />
            ) : (
              <p className={css.installedLabel} data-shop-installed>{t('installed')}</p>
            )}
            <UninstallPanel name={entry.name} t={t} uninstall={uninstall} installStatus={installStatus} restart={restart} />
          </div>
        )}
      </div>
    </div>
  )
})

/** One entry's install flow: the button, the §9.3 acknowledgement gate for
 * community-tier entries, and the live view — running log, restart notice,
 * failure detail, rejection detail — driven by `useInstall`. Shared by the
 * catalog cards (`variant: 'install'`) and the outdated rows' update button
 * (`variant: 'update'`, which drives the same install flow for `name@latest`). */
function InstallPanel({ name, version, tier, variant = 'install', t, install, installStatus, restart }: {
  name: string
  version: string
  tier: CatalogEntry['tier']
  variant?: 'install' | 'update'
  t: ShopTabProps['t']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
}): ReactNode {
  const [gateOpen, setGateOpen] = useState(false)
  const { view, start } = useInstall(install, installStatus)

  if (view.kind === 'running') {
    return (
      <div className={css.installPanel}>
        <p className={css.installing}>{t('installing')}</p>
        {view.log.length > 0 && (
          <div className={css.log}>
            {view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
          </div>
        )}
      </div>
    )
  }
  if (view.kind === 'done') {
    return (
      <div className={css.installedActions}>
        <p className={css.notice} data-shop-restart-notice>
          {view.needsRestart ? t('installedRestartNotice') : t('installedNoRestartNotice')}
        </p>
        {/* The §8 restart offer: only when the install actually needs one —
            the needsRestart=false notice is the stale-catalog anomaly, where
            a restart would change nothing. */}
        {view.needsRestart && <RestartPanel t={t} restart={restart} />}
      </div>
    )
  }
  if (view.kind === 'failed') {
    return (
      <div className={css.installPanel}>
        <p className={css.failedHeading}>{t('installFailed')}</p>
        <div className={css.log}>
          {view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
        </div>
        {/* An empty detail marks a TRANSPORT failure (useInstall's start catch):
            the wire detail is private and never rendered, so the localized line
            is its readable face. A non-empty detail is the host's published copy
            (§7.2 stderr plus the recovery hint) and renders verbatim. */}
        <p className={css.failedDetail}>{view.detail === '' ? t('installTransportFailed') : view.detail}</p>
      </div>
    )
  }
  if (view.kind === 'rejected') {
    return (
      <div className={css.installPanel}>
        <p className={css.rejectedCode}>{t(rejectionCodeKey(view.code))}</p>
        <p className={css.rejectedDetail}>{view.detail}</p>
      </div>
    )
  }
  // idle: the install/update button, or the §9.3 acknowledgement gate for
  // anything that has not been human-reviewed.
  if (gateOpen) {
    return (
      <div className={css.gate}>
        <p className={css.gateTitle}>{t('acknowledgementTitle')}</p>
        <p className={css.gateBody}>{t('acknowledgementBody')}</p>
        <div className={css.gateActions}>
          <button
            type="button"
            className={css.confirmButton}
            data-shop-confirm
            onClick={() => {
              setGateOpen(false)
              void start({ name, version, acknowledged: true })
            }}
          >
            {t('confirm')}
          </button>
          <button type="button" className={css.cancelButton} onClick={() => setGateOpen(false)}>
            {t('cancel')}
          </button>
        </div>
      </div>
    )
  }
  const update = variant === 'update'
  return (
    <button
      type="button"
      className={css.installButton}
      {...(update ? { 'data-shop-update': true } : { 'data-shop-install': true })}
      onClick={() => {
        if (tier === 'verified') {
          // Reviewed: install directly; there is nothing to acknowledge (§9.3).
          void start({ name, version, acknowledged: undefined })
        } else {
          setGateOpen(true)
        }
      }}
    >
      {t(update ? 'update' : 'install')}
    </button>
  )
}

/** One installed entry's uninstall flow: remove from the profile through the
 * same executor records and poll loop as installs. Uninstalling revokes
 * privilege rather than granting it, so there is no acknowledgement gate —
 * §9.3 is about granting. A business failure (not in the catalog / not
 * installed) lands in the failed view with the host's published detail; a
 * transport failure carries the empty detail and the localized fallback. */
function UninstallPanel({ name, t, uninstall, installStatus, restart }: {
  name: string
  t: ShopTabProps['t']
  uninstall: ShopTabInjected['uninstall']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
}): ReactNode {
  const { view, start } = useUninstall(uninstall, installStatus)

  if (view.kind === 'running') {
    return (
      <div className={css.installPanel}>
        <p className={css.installing}>{t('uninstalling')}</p>
        {view.log.length > 0 && (
          <div className={css.log}>
            {view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
          </div>
        )}
      </div>
    )
  }
  if (view.kind === 'done') {
    return (
      <div className={css.installedActions}>
        <p className={css.notice} data-shop-uninstall-done>{t('uninstalledRestartNotice')}</p>
        <RestartPanel t={t} restart={restart} />
      </div>
    )
  }
  if (view.kind === 'failed') {
    return (
      <div className={css.installPanel}>
        <p className={css.failedHeading}>{t('uninstallFailed')}</p>
        <div className={css.log}>
          {view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
        </div>
        {/* Same transport rule as the install panel: an empty detail is a
            TRANSPORT failure and falls back to the localized line; a
            non-empty detail is the host's published copy and renders
            verbatim. */}
        <p className={css.failedDetail}>{view.detail === '' ? t('uninstallTransportFailed') : view.detail}</p>
      </div>
    )
  }
  // `rejected` cannot occur for uninstall — that code belongs to the install
  // gate — so anything left over is not a state to render.
  if (view.kind !== 'idle') return null
  return (
    <button
      type="button"
      className={css.uninstallButton}
      data-shop-uninstall
      onClick={() => void start({ name })}
    >
      {t('uninstall')}
    </button>
  )
}

/** The §8 restart flow (amendment 2026-08-27): after an install, update, or
 * uninstall reports done, this panel offers a restart of dsh. The
 * confirmation gate states the cost — the page disconnects and in-flight
 * conversations/tasks are interrupted — and on confirm the restart RPC runs;
 * the returned URL is where the browser jumps. A failed restart renders the
 * host's published detail: the old server is still up, nothing was lost. */
function RestartPanel({ t, restart }: {
  t: ShopTabProps['t']
  restart: ShopTabInjected['restart']
}): ReactNode {
  const [gateOpen, setGateOpen] = useState(false)
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'restarting' } | { kind: 'failed'; detail: string }>({ kind: 'idle' })

  const onConfirm = async (): Promise<void> => {
    setGateOpen(false)
    setState({ kind: 'restarting' })
    try {
      const result = await restart()
      if (result.ok) {
        // The host exits the old process shortly after this response lands;
        // the URL names the restarted server (a fresh port under --port 0).
        window.location.href = result.url
      } else {
        setState({ kind: 'failed', detail: result.detail })
      }
    } catch {
      // Transport failure: the request never reached the host, and the wire
      // detail is private (hosts and ports) — the localized line is its
      // readable face.
      setState({ kind: 'failed', detail: t('restartTransportFailed') })
    }
  }

  if (state.kind === 'restarting') {
    return <p className={css.notice} data-shop-restarting>{t('restarting')}</p>
  }
  if (state.kind === 'failed') {
    return <p className={css.failedDetail} data-shop-restart-error>{state.detail}</p>
  }
  if (gateOpen) {
    return (
      <div className={css.gate}>
        <p className={css.gateTitle}>{t('restartTitle')}</p>
        <p className={css.gateBody}>{t('restartBody')}</p>
        <div className={css.gateActions}>
          <button
            type="button"
            className={css.confirmButton}
            data-shop-restart-confirm
            onClick={() => void onConfirm()}
          >
            {t('restartConfirm')}
          </button>
          <button type="button" className={css.cancelButton} onClick={() => setGateOpen(false)}>
            {t('cancel')}
          </button>
        </div>
      </div>
    )
  }
  return (
    <button
      type="button"
      className={css.restartButton}
      data-shop-restart
      onClick={() => setGateOpen(true)}
    >
      {t('restart')}
    </button>
  )
}

/** One outdated install row (§7.3): the name, the installed and latest
 * versions, an optimistic enable/disable switch, and the update button (the
 * install flow for `name@latest`, reusing `InstallPanel`). The switch has no
 * installed-state RPC behind it — the tab assumes an installed plugin is on,
 * so the first toggle sends the inverted value. After a successful `setEnabled`
 * the §8 hot note renders. */
function OutdatedRow({ row, tier, t, setEnabled, install, installStatus, restart }: {
  row: ShopInstalledEntry
  tier: CatalogEntry['tier']
  t: ShopTabProps['t']
  setEnabled: ShopTabInjected['setEnabled']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
}): ReactNode {
  // v0 has no enabled-state RPC (§7.3), so the switch optimistically reads
  // "installed ⇒ enabled" and the first click disables.
  const [enabled, setEnabledState] = useState(true)
  const [toggle, setToggle] = useState<{ kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; detail: string }>({ kind: 'idle' })

  const onToggle = async (): Promise<void> => {
    if (toggle.kind === 'saving') return
    const next = !enabled
    setToggle({ kind: 'saving' })
    try {
      const result = await setEnabled({ name: row.name, enabled: next })
      if (result.ok) {
        setEnabledState(next)
        setToggle({ kind: 'saved' })
      } else {
        // The host's business failure carries an author- and user-readable
        // detail (§7.3); surface it verbatim. A missing detail falls back to
        // the localized failure line, never hardcoded English.
        setToggle({ kind: 'error', detail: result.detail ?? t('toggleFailed') })
      }
    } catch {
      // A thrown toggle is a TRANSPORT failure (index.ts's unwrap throws the
      // prefixed wire message); nothing else can reach this catch, because the
      // business result is a resolved value, never a throw. The transport
      // detail is private (it can name hosts and ports) and never rendered;
      // the localized failure line is the readable face of it.
      setToggle({ kind: 'error', detail: t('toggleFailed') })
    }
  }

  return (
    <div className={css.outdatedRow} data-shop-outdated-entry={row.name}>
      <div className={css.outdatedInfo}>
        <span className={css.name}>{row.name}</span>
        <span className={css.outdatedVersions}>
          <span className={css.outdatedVersion}>{t('installedVersion', { version: row.installed })}</span>
          <span className={css.outdatedVersion}>{t('latestVersion', { version: row.latest })}</span>
        </span>
      </div>
      <div className={css.outdatedActions}>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={t('enabledSwitch')}
          data-shop-toggle
          className={`${css.switch} ${enabled ? css.switchOn : ''}`}
          onClick={() => void onToggle()}
          disabled={toggle.kind === 'saving'}
        >
          <span className={css.switchKnob} />
        </button>
        <InstallPanel name={row.name} version={row.latest} tier={tier} variant="update" t={t} install={install} installStatus={installStatus} restart={restart} />
      </div>
      {toggle.kind === 'saved' && <p className={css.notice} data-shop-hot-apply>{t('hotApplyNote')}</p>}
      {toggle.kind === 'error' && <p className={css.failedDetail} data-shop-toggle-error>{toggle.detail}</p>}
    </div>
  )
}

/** The §7.3 installed list, rendered as the "installed" section: each row
 * shows both versions, a switch, and an update button. The rows are the
 * installed entries filtered to `outdated` — a current install is already
 * spoken for by its shelf card's installed label, and has no row here. The
 * tier for the update gate is looked up from the catalog by name (community →
 * acknowledgement); an entry absent from the catalog defaults to the
 * community gate (the safer read). */
function OutdatedSection({ state, tiers, t, setEnabled, install, installStatus, restart }: {
  state: InstalledState
  tiers: ReadonlyMap<string, CatalogEntry['tier']>
  t: ShopTabProps['t']
  setEnabled: ShopTabInjected['setEnabled']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
}): ReactNode {
  if (state.kind === 'loading') return null
  if (state.kind === 'error') {
    return <p className={css.stateLine} data-shop-outdated-error>{t('error')}</p>
  }
  const outdated = state.entries.filter(entry => entry.outdated)
  if (outdated.length === 0) return null
  return (
    <section className={css.outdatedSection} data-shop-outdated>
      <h2 className={css.catalogHeading}>{t('installedSection')}</h2>
      <ul className={css.outdatedList}>
        {outdated.map(row => (
          <li key={row.name}>
            <OutdatedRow
              row={row}
              tier={tiers.get(row.name) ?? 'community'}
              t={t}
              setEnabled={setEnabled}
              install={install}
              installStatus={installStatus}
              restart={restart}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The shop tab root: browse, search, refresh, and render one card per
 * entry. Data attributes on the e2e-relevant nodes follow the Task 3 list. */
export function ShopTab(props: ShopTabProps): ReactNode {
  const { t, catalog, install, installStatus, setEnabled, installed, uninstall, restart } = props
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: 'loading' })
  const [installedState, setInstalledState] = useState<InstalledState>({ kind: 'loading' })
  const [request, setRequest] = useState<LoadRequest>({ kind: 'initial' })
  const [query, setQuery] = useState('')
  // `installed` is a filter mode alongside the six catalog categories, not a
  // seventh category: it selects by installed state, not by `catalog.category`.
  const [category, setCategory] = useState<Category | 'installed' | null>(null)

  // The shelf renders in batches (§A1): ~1900 cards in one commit is ~28k
  // DOM nodes. `incremental` stays off where IntersectionObserver does not
  // exist (jsdom without a stub, ancient engines) and the whole list renders —
  // which is also what every test above the batching block relies on.
  const incremental = typeof IntersectionObserver !== 'undefined'
  const [visibleCount, setVisibleCount] = useState(SHOP_VISIBLE_BATCH)
  const sentinelRef = useRef<HTMLLIElement>(null)
  const filteredLenRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    // A refresh keeps the stale snapshot visible during the background
    // re-fetch (§10); a retry leaves the error state and starts from loading.
    if (request.kind !== 'refresh') {
      setCatalogState(current => (current.kind === 'ready' ? current : { kind: 'loading' }))
    }
    const load = async (): Promise<void> => {
      try {
        const result = await catalog(request.kind === 'refresh' ? { refresh: true } : undefined)
        if (!cancelled) setCatalogState({ kind: 'ready', result })
      } catch {
        // The transport detail is private (it can name hosts and ports) and
        // never rendered; the error state is the author- and user-readable
        // face of a failed load.
        if (!cancelled) setCatalogState({ kind: 'error' })
      }
    }
    void load()
    return () => { cancelled = true }
  }, [catalog, request])

  // The installed list runs against the same snapshot the catalog serves, so it
  // reloads on refresh/retry too — the host keeps `lastSnapshot` between calls.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const entries = await installed()
        if (!cancelled) setInstalledState({ kind: 'ready', entries })
      } catch {
        // Same privacy rule as the catalog: the transport detail is never
        // rendered; the error line is the readable face of a failed load.
        if (!cancelled) setInstalledState({ kind: 'error' })
      }
    }
    void load()
    return () => { cancelled = true }
  }, [installed, request])

  // Each shelf card looks its installed state up by name; the Installed
  // filter below selects on the same map.
  const installedByName = useMemo(() => {
    const map = new Map<string, ShopInstalledEntry>()
    if (installedState.kind === 'ready') {
      for (const entry of installedState.entries) map.set(entry.name, entry)
    }
    return map
  }, [installedState])

  const filtered = useMemo(() => {
    if (catalogState.kind !== 'ready') return []
    const q = query.trim().toLowerCase()
    return catalogState.result.plugins.filter(entry => {
      // Shop-like plugins (competing markets) are not advertised; an
      // INSTALLED one stays manageable in the installed section below.
      if (isShopLike(entry.name)) return false
      if (category === 'installed') {
        if (!installedByName.has(entry.name)) return false
      } else if (category !== null && categoryKey(entry) !== categoryLocaleKey(category)) {
        return false
      }
      if (q === '') return true
      const summaryEn = entry.catalog?.summary.en ?? ''
      const summaryZh = entry.catalog?.summary.zh ?? ''
      return entry.name.toLowerCase().includes(q)
        || summaryEn.toLowerCase().includes(q)
        || summaryZh.toLowerCase().includes(q)
    })
  }, [catalogState, query, category, installedByName])
  filteredLenRef.current = filtered.length

  // The shelf sorts by GitHub stars: the most-starred entries fill the first
  // batch, so a fresh visitor sees what the community uses most (§D1). The
  // stars sidecar is keyed by name; entries without a star count sort last.
  const stars = catalogState.kind === 'ready' ? catalogState.result.stars : {}
  const sorted = useMemo(() => sortByStars(filtered, stars), [filtered, stars])

  // The sentinel that grows the shelf: when the last rendered card's footer
  // comes within a screen and a half of the viewport, the window widens by
  // one batch. The effect re-runs as the window grows so it always observes
  // the CURRENT sentinel node; the length is read through a ref because the
  // callback must not close over a stale filtered list.
  useEffect(() => {
    if (!incremental) return
    const node = sentinelRef.current
    if (node === null) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(entry => entry.isIntersecting)) {
        setVisibleCount(current => nextVisibleCount(current, filteredLenRef.current, SHOP_VISIBLE_BATCH))
      }
    }, { rootMargin: '0px 0px 1200px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [incremental, visibleCount, filtered.length])

  const visible = incremental ? sorted.slice(0, visibleCount) : sorted

  // One button per category plus All; each shows how many of the browsable
  // (shop-like-excluded) entries carry that category.
  const categoryCounts = useMemo(() => {
    const counts = new Map<Category, number>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) {
        if (isShopLike(entry.name)) continue
        const key = categoryKey(entry)
        const bare = CATEGORY_ORDER.find(c => categoryLocaleKey(c) === key)
        if (bare !== undefined) counts.set(bare, (counts.get(bare) ?? 0) + 1)
      }
    }
    return counts
  }, [catalogState])

  // The Installed button's count: installed entries the shelf would actually
  // show (shop-like installed plugins stay in the installed section below).
  const installedCount = useMemo(() => {
    if (installedState.kind !== 'ready') return 0
    return installedState.entries.filter(entry => !isShopLike(entry.name)).length
  }, [installedState])

  // The outdated rows' update gate needs each entry's tier; the catalog is the
  // only source for it (ShopInstalledEntry carries none). An entry missing from
  // the loaded catalog defaults to the community gate at render.
  const tiers = useMemo(() => {
    const map = new Map<string, CatalogEntry['tier']>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) map.set(entry.name, entry.tier)
    }
    return map
  }, [catalogState])

  if (catalogState.kind === 'loading') {
    return (
      <div className={css.panel} data-shop-tab aria-busy="true">
        <p className={css.srOnly}>{t('loading')}</p>
        <div className={css.skeletonGrid} data-shop-skeleton aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className={css.skeletonCard}>
              <span className={css.skeletonCover} />
              <span className={css.skeletonName} />
              <span className={css.skeletonSummary} />
              <span className={css.skeletonSummaryShort} />
            </div>
          ))}
        </div>
      </div>
    )
  }
  if (catalogState.kind === 'error') {
    return (
      <div className={css.panel} data-shop-tab>
        <p className={css.stateLine}>{t('error')}</p>
        <button type="button" className={css.actionButton} onClick={() => setRequest({ kind: 'retry' })}>
          {t('retry')}
        </button>
      </div>
    )
  }
  const { result } = catalogState
  return (
    <div className={css.panel} data-shop-tab>
      <div className={css.toolbar}>
        <input
          type="search"
          className={css.searchInput}
          aria-label={t('search')}
          placeholder={t('search')}
          value={query}
          onChange={event => {
            setQuery(event.target.value)
            setVisibleCount(SHOP_VISIBLE_BATCH)
          }}
        />
        {result.stale && (
          <div className={css.staleBlock}>
            <span className={css.staleBadge}>{t('staleLabel', { date: result.builtAt.slice(0, 10) })}</span>
            <button type="button" className={css.actionButton} onClick={() => setRequest({ kind: 'refresh' })}>
              {t('refresh')}
            </button>
          </div>
        )}
      </div>
      <div className={css.categoryBar} role="group" aria-label={t('catalog')}>
        <button
          type="button"
          className={category === null ? `${css.categoryButton} ${css.categoryButtonOn}` : css.categoryButton}
          aria-pressed={category === null}
          onClick={() => { setCategory(null); setVisibleCount(SHOP_VISIBLE_BATCH) }}
        >
          {t('all')} {[...categoryCounts.values()].reduce((a, b) => a + b, 0)}
        </button>
        {CATEGORY_ORDER.map(key => (
          <button
            key={key}
            type="button"
            className={category === key ? `${css.categoryButton} ${css.categoryButtonOn}` : css.categoryButton}
            aria-pressed={category === key}
            onClick={() => { setCategory(key); setVisibleCount(SHOP_VISIBLE_BATCH) }}
          >
            {t(categoryLocaleKey(key))} {categoryCounts.get(key) ?? 0}
          </button>
        ))}
        <button
          type="button"
          className={category === 'installed' ? `${css.categoryButton} ${css.categoryButtonOn}` : css.categoryButton}
          aria-pressed={category === 'installed'}
          onClick={() => { setCategory('installed'); setVisibleCount(SHOP_VISIBLE_BATCH) }}
        >
          {t('installed')} {installedCount}
        </button>
      </div>
      <p className={css.catalogStats}>{t('catalogStats', { count: String(result.plugins.length), date: result.builtAt.slice(0, 10) })}</p>
      {result.plugins.length === 0 ? (
        <p className={css.emptyLine}>{t('empty')}</p>
      ) : filtered.length === 0 ? (
        <p className={css.emptyLine}>{t('emptySearch')}</p>
      ) : (
        <>
          <ul className={css.cards}>
            {visible.map(entry => (
              <li key={entry.name}>
                <EntryCard entry={entry} stars={stars[entry.name]} installed={installedByName.get(entry.name)} t={t} install={install} installStatus={installStatus} uninstall={uninstall} restart={restart} />
              </li>
            ))}
            {incremental && visibleCount < filtered.length && (
              <li ref={sentinelRef} className={css.cardsSentry} data-shop-sentry aria-hidden="true" />
            )}
          </ul>
          {incremental && visibleCount < filtered.length && (
            <p className={css.showingLine} aria-live="polite">
              {t('showing', { shown: String(visibleCount), total: String(filtered.length) })}
            </p>
          )}
        </>
      )}
      <OutdatedSection
        state={installedState}
        tiers={tiers}
        t={t}
        setEnabled={setEnabled}
        install={install}
        installStatus={installStatus}
        restart={restart}
      />
    </div>
  )
}
