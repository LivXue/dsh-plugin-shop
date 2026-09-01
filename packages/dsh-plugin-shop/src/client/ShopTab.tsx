/** The shop tab: browse the catalog, detail an entry, install with the
 * acknowledgement gate, poll the install to its terminal state (§7.2).
 * Everything the tab renders is text — summaries, capabilities, log lines,
 * details — never markup, so hostile npm descriptions cannot inject (spec
 * §11.3.4): no render path here may ever use dangerouslySetInnerHTML. */

import { memo, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogEntry, InstallArgs, ShopCatalogResult, ShopInstalledEntry, ShopInstallResult, ShopInstallStatusResult, ShopRestartResult, ShopSetEnabledResult, ShopUninstallResult, ShopUpdateResult, ShopVersionResult } from '../host/index.ts'
import { CATEGORY_ORDER, CHECK_UP_TO_DATE_MS, INSTALL_POLL_MS, RESTART_GRACE_MS, RESTART_WAIT_MS, SHOP_VISIBLE_BATCH, type Category, authorOf, categoryKey, categoryLocaleKey, displayVersion, formatStars, hasGithubHome, isCustomLicense, isShopLike, missingPeersOf, nextVisibleCount, npmPageUrl, rejectionCodeKey, restartReasonKey, reviewHashPin, sortByStars, starsOf, tierKey } from './present.ts'
import { useInstall } from './useInstall.ts'
import { useUninstall } from './useUninstall.ts'
import { useUpdateSelf } from './useUpdateSelf.ts'
import css from './ShopTab.module.css'

/** The project's home on GitHub, linked from the toolbar. */
const SHOP_REPO_URL = 'https://github.com/LivXue/dsh-plugin-shop'

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
  version: () => Promise<ShopVersionResult>
  updateStart: (args: { version: string }) => Promise<ShopUpdateResult>
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
 * (name, tier, category), the plain-text summary in both
 * languages, the self-declared capabilities, the detail section, and the
 * install controls. An installed plugin's card carries its installed row:
 * current → the non-interactive installed label, behind → the update button;
 * uninstalled → the install button. */
const EntryCard = memo(function EntryCard({ entry, stars, installed, missing, t, install, installStatus, uninstall, restart, restartSupported, setEnabled }: {
  entry: CatalogEntry
  stars: number | undefined
  installed: ShopInstalledEntry | undefined
  missing: string[]
  t: ShopTabProps['t']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  uninstall: ShopTabInjected['uninstall']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
  setEnabled: ShopTabInjected['setEnabled']
}): ReactNode {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const summary = entry.catalog?.summary
  // Null for a github entry, and for any name outside npm's own grammar.
  const npmUrl = npmPageUrl(entry)
  const author = authorOf(entry)
  const category = entry.catalog?.category ?? 'other'
  return (
    <div className={css.card} data-shop-entry={entry.name} data-category={category}>
      <span className={css.cardSpine} aria-hidden="true" />
      <button
        type="button"
        className={css.entryHeader}
        aria-expanded={open}
        aria-controls={detailId}
        onClick={() => setOpen(current => !current)}
      >
        <span className={css.name}>{entry.name}</span>
        <span className={css.badges}>
          <span className={css.categoryBadge}>{t(categoryKey(entry))}</span>
          {entry.source === 'npm' && (
            // Where the thing installs from. npm comes first because that is
            // the answer to "what am I getting"; the octocat below answers
            // "where can I read it". Both are marks, not links: this whole
            // header is a <button>, and an <a> inside one is invalid HTML —
            // the npm page link lives in the expanded detail.
            <span className={css.sourceBadge} data-shop-source-npm role="img" aria-label={t('npmSource')}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
                <path fillRule="evenodd" d="M0 0v16h16V0H0zm13 13h-2V6H8v7H3V3h10v10z" />
              </svg>
            </span>
          )}
          {hasGithubHome(entry) && (
            // The octocat marks a GitHub home the reader can go and inspect —
            // a github-source entry, or an npm one whose repository is there
            // (4892 of the live catalog's 4915). Its ABSENCE is the signal:
            // a listed package with no public source to read.
            <span className={css.sourceBadge} data-shop-source-github role="img" aria-label={t('githubSource')}>
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
            </span>
          )}
          <span className={css.cardVersion} data-card-version>v{displayVersion(entry)}</span>
          {/* Only a tier that says something is badged. Every one of the live
            * catalog's 4915 entries is `community`, so that label was on
            * every card and carried no information. `verified` and
            * `verified-stale` mean a human read the code at a pinned version
            * — the most load-bearing signal here — and still show. */}
          {entry.tier !== 'community' && (
            <span className={css.tierBadge} data-tier={entry.tier}>{t(tierKey(entry.tier))}</span>
          )}
          {missing.length > 0 && (
            <span className={css.incompatibleBadge} data-shop-incompatible title={t('incompatibleDetail', { modules: missing.join(', ') })}>
              {t('incompatibleBadge')}
            </span>
          )}
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
          // Collapsed cards clamp the summary to two lines; expanding lifts
          // the clamp so the author's full text shows.
          <p className={open ? `${css.summary} ${css.summaryExpanded}` : css.summary}>{summary.en}</p>
        )}
        {summary?.zh !== undefined && (
          <p className={open ? `${css.summaryZh} ${css.summaryZhExpanded}` : css.summaryZh}>{summary.zh}</p>
        )}
        {missing.length > 0 && (
          <p className={css.incompatibleDetail}>{t('incompatibleDetail', { modules: missing.join(', ') })}</p>
        )}
        {open && entry.catalog !== undefined && entry.catalog.capabilities.length > 0 && (
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
              {/* The npm page comes first: it is the home of the exact thing
               * being installed, while `repository` is only where the package
               * SAYS its source lives — and those two disagreeing is the
               * whole reason a person might want to look. Who published it
               * sits on the action row, where it shows without expanding. */}
              {npmUrl !== null && (
                <div className={css.detailRow} data-shop-npm>
                  <dt>{t('npmPage')}</dt>
                  <dd>
                    <a href={npmUrl} target="_blank" rel="noopener noreferrer">
                      {npmUrl}
                    </a>
                  </dd>
                </div>
              )}
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
                  {/* The SEE LICENSE IN <file> idiom renders as a localized
                   * label; every other value renders verbatim. */}
                  <dd>{isCustomLicense(entry.license) ? t('customLicense') : entry.license}</dd>
                </div>
              )}
            </dl>
            {entry.tier === 'verified-stale' && entry.review !== undefined && (
              <p className={css.reviewedLine}>
                {entry.review.reviewedVersion !== undefined
                  ? t('reviewedVersionLine', { reviewed: entry.review.reviewedVersion, current: entry.version })
                  : t('reviewedPinLine', { pin: reviewHashPin(entry.review), current: displayVersion(entry) })}
              </p>
            )}
          </section>
        )}
      </div>
      {/* The action line: buttons sit on their own row under the summary; an
       * active install/uninstall flow (gate, log, notices) takes the full
       * width below them, where it has room. */}
      <div className={css.cardActions} data-shop-actions>
        {installed === undefined ? (
          <InstallPanel name={entry.name} version={entry.version} tier={entry.tier} missing={missing} t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
        ) : (
          <>
            {installed.outdated ? (
              // The update button drives the same install flow for the
              // catalog's latest version; the community gate still applies
              // (§9.3).
              <InstallPanel name={entry.name} version={entry.version} tier={entry.tier} variant="update" missing={missing} t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
            ) : (
              <p className={css.installedLabel} data-shop-installed>{t('installed')}</p>
            )}
            {/* The hot enable/disable switch (§8) sits on every installed
             * row — current or outdated — and reads the inventory state. */}
            <EnabledSwitch row={installed} t={t} setEnabled={setEnabled} />
            <UninstallPanel name={entry.name} t={t} uninstall={uninstall} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
          </>
        )}
        {/* Who put this here, pushed to the right edge of the action row. A
         * collapsed-card fact on purpose: comparing two same-looking listings
         * should not require opening each one. An active install flow takes
         * the full row width, so this drops below it until the flow settles. */}
        {author !== null && (
          <span className={css.author} data-shop-author>{t('authorLine', { author })}</span>
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
function InstallPanel({ name, version, tier, missing, variant = 'install', t, install, installStatus, restart, restartSupported }: {
  name: string
  version: string
  tier: CatalogEntry['tier']
  missing: string[]
  variant?: 'install' | 'update'
  t: ShopTabProps['t']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
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
          {/* The done notice: a hot-mount failure names WHY through a reason
              code, localized here so it reads in the dsh language the person
              set — the host bakes no copy. A restart without a reason keeps
              the generic notice; the needsRestart=false notice is the
              stale-catalog anomaly, where a restart would change nothing. */}
          {view.needsRestart
            ? t(restartReasonKey(view.restartReason))
            : t('installedNoRestartNotice')}
        </p>
        {/* The §8 restart offer: only when the install actually needs one —
            and the host can restart at all (§C-1); otherwise the disabled
            notice says why. */}
        {view.needsRestart && restartSupported && <RestartPanel t={t} restart={restart} />}
        {view.needsRestart && !restartSupported && (
          <p className={css.notice} data-shop-restart-disabled>{t('restartDisabledNotice')}</p>
        )}
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
        {missing.length > 0 && (
          <p className={css.gateWarning} data-shop-incompatible-warning>
            {t('incompatibleInstallWarning', { modules: missing.join(', ') })}
          </p>
        )}
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
function UninstallPanel({ name, t, uninstall, installStatus, restart, restartSupported }: {
  name: string
  t: ShopTabProps['t']
  uninstall: ShopTabInjected['uninstall']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
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
        <p className={css.notice} data-shop-uninstall-done>
          {view.needsRestart ? t('uninstalledRestartNotice') : t('uninstalledLiveNotice')}
        </p>
        {/* The §8 restart offer, which activates the uninstall: a live
            uninstall (needsRestart=false) is already done — the plugin
            stopped immediately, and the boot composition picks up the
            removal at the next restart on its own — so the offer (or its
            disabled notice, §C-1) renders only when the uninstall still
            needs one. */}
        {view.needsRestart && restartSupported && <RestartPanel t={t} restart={restart} />}
        {view.needsRestart && !restartSupported && (
          <p className={css.notice} data-shop-restart-disabled>{t('restartDisabledNotice')}</p>
        )}
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
 * conversations/tasks are interrupted — and on confirm the restart RPC
 * commits the two-phase handoff: the host exits, a helper re-runs dsh, and
 * this panel polls the origin after a grace period, refreshing the page
 * once the NEW server answers. A refused restart renders the host's
 * published detail; a server that never comes back names the manual
 * command. */
function RestartPanel({ t, restart }: {
  t: ShopTabProps['t']
  restart: ShopTabInjected['restart']
}): ReactNode {
  const [gateOpen, setGateOpen] = useState(false)
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'restarting' } | { kind: 'failed'; detail: string }>({ kind: 'idle' })

  const onConfirm = async (): Promise<void> => {
    setGateOpen(false)
    try {
      const result = await restart()
      if (!result.ok) {
        setState({ kind: 'failed', detail: result.detail })
        return
      }
      setState({ kind: 'restarting' })
    } catch {
      // Transport failure: the request never reached the host, and the wire
      // detail is private (hosts and ports) — the localized line is its
      // readable face.
      setState({ kind: 'failed', detail: t('restartTransportFailed') })
    }
  }

  // The origin monitor: while restarting, poll the current URL after the
  // grace period (the host exits within it, so an answer is the NEW server)
  // and reload into it. If it never answers within the wait, the honest
  // failure names the manual command.
  useEffect(() => {
    if (state.kind !== 'restarting') return
    const started = Date.now()
    const timer = setInterval(() => {
      const elapsed = Date.now() - started
      if (elapsed < RESTART_GRACE_MS) return
      // Success reloads into the new server; a rejection just means the new
      // server is not up yet — keep polling until the wait expires.
      void fetch(window.location.href, { cache: 'no-store' }).then(() => {
        window.location.reload()
      }, () => {})
      if (elapsed > RESTART_WAIT_MS) {
        clearInterval(timer)
        setState({ kind: 'failed', detail: t('restartFailedNotice') })
      }
    }, INSTALL_POLL_MS)
    return () => clearInterval(timer)
  }, [state, t])

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

/**
 * The hot enable/disable switch (§8). The initial state is the Host's
 * inventory verdict carried on the installed row; the click is optimistic
 * (the value flips on success) and a success renders the §8 hot note. A
 * transport throw renders the localized failure line — its private detail
 * (which can name hosts and ports) never reaches the UI.
 */
function EnabledSwitch({ row, t, setEnabled }: {
  row: ShopInstalledEntry
  t: ShopTabProps['t']
  setEnabled: ShopTabInjected['setEnabled']
}): ReactNode {
  const [enabled, setEnabledState] = useState(row.enabled)
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
      // business result is a resolved value, never a throw.
      setToggle({ kind: 'error', detail: t('toggleFailed') })
    }
  }

  return (
    <div className={css.switchWrap} data-shop-enabled-switch={row.name}>
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
      {toggle.kind === 'saved' && <p className={css.notice} data-shop-hot-apply>{t('hotApplyNote')}</p>}
      {toggle.kind === 'error' && <p className={css.failedDetail} data-shop-toggle-error>{toggle.detail}</p>}
    </div>
  )
}

/** One outdated install row (§7.3): the name, the installed and latest
 * versions, the hot enable/disable switch, and the update button (the
 * install flow for `name@latest`, reusing `InstallPanel`). */
function OutdatedRow({ row, tier, source, missing, t, setEnabled, install, installStatus, restart, restartSupported }: {
  row: ShopInstalledEntry
  tier: CatalogEntry['tier']
  source: CatalogEntry['source']
  missing: string[]
  t: ShopTabProps['t']
  setEnabled: ShopTabInjected['setEnabled']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
}): ReactNode {
  return (
    <div className={css.outdatedRow} data-shop-outdated-entry={row.name}>
      <div className={css.outdatedInfo}>
        <span className={css.badges}>
          <span className={css.name}>{row.name}</span>
          {missing.length > 0 && (
            <span className={css.incompatibleBadge} data-shop-incompatible title={t('incompatibleUpdateDetail', { modules: missing.join(', ') })}>
              {t('incompatibleBadge')}
            </span>
          )}
        </span>
        <span className={css.outdatedVersions}>
          <span>{t('installedVersion', { version: source === 'github' ? row.installed.slice(0, 7) : row.installed })}</span>
          <span>{t('latestVersion', { version: row.latest })}</span>
        </span>
      </div>
      <div className={css.outdatedActions}>
        <EnabledSwitch row={row} t={t} setEnabled={setEnabled} />
        <InstallPanel name={row.name} version={row.latest} tier={tier} variant="update" missing={missing} t={t} install={install} installStatus={installStatus} restart={restart} restartSupported={restartSupported} />
      </div>
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
function OutdatedSection({ state, tiers, sources, missingByName, t, setEnabled, install, installStatus, restart, restartSupported }: {
  state: InstalledState
  tiers: ReadonlyMap<string, CatalogEntry['tier']>
  sources: ReadonlyMap<string, CatalogEntry['source']>
  missingByName: ReadonlyMap<string, string[]>
  t: ShopTabProps['t']
  setEnabled: ShopTabInjected['setEnabled']
  install: ShopTabInjected['install']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
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
              source={sources.get(row.name) ?? 'npm'}
              missing={missingByName.get(row.name) ?? []}
              t={t}
              setEnabled={setEnabled}
              install={install}
              installStatus={installStatus}
              restart={restart}
              restartSupported={restartSupported}
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
  const { t, catalog, install, installStatus, setEnabled, installed, uninstall, restart, version, updateStart } = props
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: 'loading' })
  const [installedState, setInstalledState] = useState<InstalledState>({ kind: 'loading' })
  // The shop's own version row: null while the check is loading or failed
  // (the check is advisory — a failed one leaves the row empty, the tab's
  // own error states carry the bigger story).
  const [selfVersion, setSelfVersion] = useState<ShopVersionResult | null>(null)
  // Whether the host can actually restart dsh (§C-1): the flag rides the
  // same version read as the self-update row — no extra fetch. While the
  // advisory check has not answered, treat restart as supported: a systemd
  // deployment then gets the host's published refusal detail, and a failed
  // check never passes the systemd claim off as fact.
  const restartSupported = selfVersion?.restartSupported ?? true
  const selfUpdate = useUpdateSelf(updateStart, installStatus)
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

  // The shop's own version check runs alongside the catalog, reloading on
  // refresh/retry too.
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const result = await version()
        if (!cancelled) setSelfVersion(result)
      } catch {
        // The check is advisory: a transport failure leaves the row empty.
      }
    }
    void load()
    return () => { cancelled = true }
  }, [version, request])

  // The on-demand check behind the version number, with the same advisory
  // failure rule as the mount check. A re-check that finds nothing newer
  // flips the button to "up to date" for CHECK_UP_TO_DATE_MS; finding a
  // newer release leaves the idle label and shows the update button. The
  // button is disabled while checking and while reporting up-to-date.
  const [checkState, setCheckState] = useState<'idle' | 'checking' | 'up-to-date'>('idle')
  const upToDateTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (upToDateTimer.current !== null) clearTimeout(upToDateTimer.current)
  }, [])
  const checkVersion = async (): Promise<void> => {
    setCheckState('checking')
    try {
      const result = await version()
      setSelfVersion(result)
      if (result.outdated) {
        setCheckState('idle')
      } else {
        setCheckState('up-to-date')
        upToDateTimer.current = setTimeout(() => setCheckState('idle'), CHECK_UP_TO_DATE_MS)
      }
    } catch {
      // Advisory, like the mount check.
      setCheckState('idle')
    }
  }

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
      // INSTALLED one stays manageable in the installed section below. The
      // repo slug gets the same check for github entries.
      if (isShopLike(entry.name) || (entry.repo !== undefined && isShopLike(entry.repo))) return false
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
        if (isShopLike(entry.name) || (entry.repo !== undefined && isShopLike(entry.repo))) continue
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
  // The same lookup shape for each entry's install source, so a github
  // entry's 40-hex commit renders as the short form everywhere.
  const sources = useMemo(() => {
    const map = new Map<string, CatalogEntry['source']>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) map.set(entry.name, entry.source)
    }
    return map
  }, [catalogState])
  // Each card's incompatibility badge, looked up once per catalog load
  // instead of computed inline in the render: missingPeersOf hands back a
  // fresh `[]` for every package the host did not flag, and doing that in
  // the JSX below would hand EntryCard's memo a new array on every
  // unrelated re-render (a keystroke, a poll tick), forcing every visible
  // card to re-render regardless of whether anything about it changed.
  const missingByName = useMemo(() => {
    const map = new Map<string, string[]>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) {
        map.set(entry.name, missingPeersOf(catalogState.result.incompatible, entry.name))
      }
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
              <span className={css.skeletonName} />
              <span className={css.skeletonSummary} />
              <span className={css.skeletonSummaryShort} />
              <span className={css.skeletonActions} />
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
        <div className={css.toolbarRight}>
          {result.stale && (
            <div className={css.staleBlock}>
              <span className={css.staleBadge}>{t('staleLabel', { date: result.builtAt.slice(0, 10) })}</span>
              <button type="button" className={css.actionButton} onClick={() => setRequest({ kind: 'refresh' })}>
                {t('refresh')}
              </button>
            </div>
          )}
          {selfVersion !== null && (
            <div className={css.versionBlock}>
              <span className={css.versionText} data-shop-version>v{selfVersion.installed}</span>
              <button
                type="button"
                className={css.checkUpdateButton}
                data-shop-check-update
                disabled={checkState !== 'idle'}
                onClick={() => void checkVersion()}
              >
                {checkState === 'up-to-date' ? t('upToDate') : t('checkUpdate')}
              </button>
              {selfVersion.outdated && selfVersion.latest !== null && selfUpdate.view.kind === 'idle' && (
                <button
                  type="button"
                  className={css.updateSelfButton}
                  data-shop-update-self
                  onClick={() => {
                    // outdated implies the check answered; the guard keeps
                    // the type honest without asserting a value the host
                    // never produces.
                    if (selfVersion.latest !== null) void selfUpdate.start({ version: selfVersion.latest })
                  }}
                >
                  {t('update')}
                </button>
              )}
            </div>
          )}
          {/* The project's GitHub mark, right of the version row: a static
           * link independent of the advisory check, so it stays when the
           * version check has no answer. The octocat is the only affordance,
           * hence the aria-label. */}
          <a
            className={css.githubLink}
            href={SHOP_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('github')}
            data-shop-github
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </div>
      </div>
      {selfUpdate.view.kind === 'running' && (
        <div className={css.selfUpdatePanel} data-shop-self-updating>
          <p className={css.installing}>{t('installing')}</p>
          {selfUpdate.view.log.length > 0 && (
            <div className={css.log}>
              {selfUpdate.view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
            </div>
          )}
        </div>
      )}
      {selfUpdate.view.kind === 'done' && (
        <div className={css.selfUpdatePanel} data-shop-self-update-done>
          <div className={css.installedActions}>
            <p className={css.notice}>{t('installedRestartNotice')}</p>
            {/* The shop cannot swap itself live; the restart offer carries
                the same §C-1 gate as the install and uninstall flows. */}
            {restartSupported && <RestartPanel t={t} restart={restart} />}
            {!restartSupported && (
              <p className={css.notice} data-shop-restart-disabled>{t('restartDisabledNotice')}</p>
            )}
          </div>
        </div>
      )}
      {selfUpdate.view.kind === 'failed' && (
        <div className={css.selfUpdatePanel} data-shop-self-update-failed>
          <p className={css.failedHeading}>{t('updateFailed')}</p>
          {selfUpdate.view.log.length > 0 && (
            <div className={css.log}>
              {selfUpdate.view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
            </div>
          )}
          {/* Same transport rule as the install panel: an empty detail is a
              TRANSPORT failure and falls back to the localized line; a
              non-empty detail is the host's published copy. */}
          <p className={css.failedDetail}>{selfUpdate.view.detail === '' ? t('updateTransportFailed') : selfUpdate.view.detail}</p>
        </div>
      )}
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
                <EntryCard entry={entry} stars={starsOf(entry, stars)} installed={installedByName.get(entry.name)} missing={missingByName.get(entry.name) ?? []} t={t} install={install} installStatus={installStatus} uninstall={uninstall} restart={restart} restartSupported={restartSupported} setEnabled={setEnabled} />
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
        sources={sources}
        missingByName={missingByName}
        t={t}
        setEnabled={setEnabled}
        install={install}
        installStatus={installStatus}
        restart={restart}
        restartSupported={restartSupported}
      />
    </div>
  )
}
