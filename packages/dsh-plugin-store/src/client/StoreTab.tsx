/** The store tab: browse the catalog, detail an entry, install with the
 * acknowledgement gate, poll the install to its terminal state (§7.2).
 * Everything the tab renders is text — summaries, capabilities, log lines,
 * details — never markup, so hostile npm descriptions cannot inject (spec
 * §11.3.4): no render path here may ever use dangerouslySetInnerHTML. */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogEntry, InstallArgs, StoreCatalogResult, StoreInstallResult, StoreInstallStatusResult } from '../host/index.ts'
import { isUnclaimed, rejectionCodeKey, tierKey } from './present.ts'
import { useInstall } from './useInstall.ts'
import css from './StoreTab.module.css'

/** The tab's Remote face: the Host result types, already unwrapped from the
 * wire envelope by `index.ts`; `catalog` throws on a wire error so the tab's
 * error state renders. */
export interface StoreTabInjected {
  catalog: (args?: { refresh?: boolean }) => Promise<StoreCatalogResult>
  install: (args: InstallArgs) => Promise<StoreInstallResult>
  installStatus: (args: { installId: string }) => Promise<StoreInstallStatusResult>
}

/** Full component props assembled by the Settings slot renderer. */
export type StoreTabProps =
  PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.store'>
  & InjectFace<StoreTabInjected>

/** What the tab is trying to load, and with which catalog cache behavior:
 * a refresh forces the network re-fetch while the stale snapshot stays
 * visible (§10); a retry leaves the error state and starts from loading. */
type LoadRequest = { kind: 'initial' } | { kind: 'refresh' } | { kind: 'retry' }

type CatalogState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; result: StoreCatalogResult }

function ChevronIcon({ open }: { open: boolean }): ReactNode {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className={open ? css.chevronOpen : css.chevron}>
      <path fill="currentColor" d="M3.5 6 8 10.5 12.5 6l1 1L8 12.5 2.5 7l1-1Z" />
    </svg>
  )
}

/** One entry card: the expandable header (name, tier, unclaimed marker), the
 * plain-text summary in both languages, the self-declared capabilities, the
 * detail section, and the install controls. */
function EntryCard({ entry, t, install, installStatus }: {
  entry: CatalogEntry
  t: StoreTabProps['t']
  install: StoreTabInjected['install']
  installStatus: StoreTabInjected['installStatus']
}): ReactNode {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const summary = entry.catalog?.summary
  return (
    <div className={css.card} data-store-entry={entry.name}>
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
          <ChevronIcon open={open} />
        </span>
      </button>
      <div className={css.body}>
        {summary !== undefined && <p className={css.summary}>{summary.en}</p>}
        {summary?.zh !== undefined && <p className={css.summaryZh}>{summary.zh}</p>}
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
                  <dd>{entry.repository}</dd>
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
        <InstallPanel entry={entry} t={t} install={install} installStatus={installStatus} />
      </div>
    </div>
  )
}

/** One entry's install flow: the button, the §9.3 acknowledgement gate for
 * community-tier entries, and the live view — running log, restart notice,
 * failure detail, rejection detail — driven by `useInstall`. */
function InstallPanel({ entry, t, install, installStatus }: {
  entry: CatalogEntry
  t: StoreTabProps['t']
  install: StoreTabInjected['install']
  installStatus: StoreTabInjected['installStatus']
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
      <p className={css.notice} data-store-restart-notice>
        {view.needsRestart ? t('installedRestartNotice') : t('installedNoRestartNotice')}
      </p>
    )
  }
  if (view.kind === 'failed') {
    return (
      <div className={css.installPanel}>
        <p className={css.failedHeading}>{t('installFailed')}</p>
        <div className={css.log}>
          {view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
        </div>
        <p className={css.failedDetail}>{view.detail}</p>
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
  // idle: the install button, or the §9.3 acknowledgement gate for anything
  // that has not been human-reviewed.
  if (gateOpen) {
    return (
      <div className={css.gate}>
        <p className={css.gateTitle}>{t('acknowledgementTitle')}</p>
        <p className={css.gateBody}>{t('acknowledgementBody')}</p>
        <div className={css.gateActions}>
          <button
            type="button"
            className={css.confirmButton}
            data-store-confirm
            onClick={() => {
              setGateOpen(false)
              void start({ name: entry.name, version: entry.version, acknowledged: true })
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
  return (
    <button
      type="button"
      className={css.installButton}
      data-store-install
      onClick={() => {
        if (entry.tier === 'verified') {
          // Reviewed: install directly; there is nothing to acknowledge (§9.3).
          void start({ name: entry.name, version: entry.version, acknowledged: undefined })
        } else {
          setGateOpen(true)
        }
      }}
    >
      {t('install')}
    </button>
  )
}

/** The store tab root: browse, search, refresh, and render one card per
 * entry. Data attributes on the e2e-relevant nodes follow the Task 3 list. */
export function StoreTab(props: StoreTabProps): ReactNode {
  const { t, catalog, install, installStatus } = props
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: 'loading' })
  const [request, setRequest] = useState<LoadRequest>({ kind: 'initial' })
  const [query, setQuery] = useState('')

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

  const filtered = useMemo(() => {
    if (catalogState.kind !== 'ready') return []
    const q = query.trim().toLowerCase()
    if (q === '') return catalogState.result.plugins
    return catalogState.result.plugins.filter(entry => {
      const summaryEn = entry.catalog?.summary.en ?? ''
      const summaryZh = entry.catalog?.summary.zh ?? ''
      return entry.name.toLowerCase().includes(q)
        || summaryEn.toLowerCase().includes(q)
        || summaryZh.toLowerCase().includes(q)
    })
  }, [catalogState, query])

  if (catalogState.kind === 'loading') {
    return (
      <div className={css.panel} data-store-tab>
        <p className={css.stateLine}>{t('loading')}</p>
      </div>
    )
  }
  if (catalogState.kind === 'error') {
    return (
      <div className={css.panel} data-store-tab>
        <p className={css.stateLine}>{t('error')}</p>
        <button type="button" className={css.actionButton} onClick={() => setRequest({ kind: 'retry' })}>
          {t('retry')}
        </button>
      </div>
    )
  }
  const { result } = catalogState
  return (
    <div className={css.panel} data-store-tab>
      <div className={css.toolbar}>
        <input
          type="search"
          className={css.searchInput}
          aria-label={t('search')}
          placeholder={t('search')}
          value={query}
          onChange={event => setQuery(event.target.value)}
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
      <h2 className={css.catalogHeading}>{t('catalog')}</h2>
      {result.plugins.length === 0 ? (
        <p className={css.emptyLine}>{t('empty')}</p>
      ) : filtered.length === 0 ? (
        <p className={css.emptyLine}>{t('emptySearch')}</p>
      ) : (
        <ul className={css.cards}>
          {filtered.map(entry => (
            <li key={entry.name}>
              <EntryCard entry={entry} t={t} install={install} installStatus={installStatus} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
