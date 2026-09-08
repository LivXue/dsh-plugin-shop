/** The shop tab: browse the catalog, detail an entry, install with the
 * acknowledgement gate, poll the install to its terminal state (§7.2).
 * Everything the tab renders is text — summaries, capabilities, log lines,
 * details — never markup, so hostile npm descriptions cannot inject (spec
 * §11.3.4): no render path here may ever use dangerouslySetInnerHTML. */

import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CatalogEntry, InstallArgs, ShopCatalogResult, ShopInstalledEntry, ShopInstallResult, ShopInstallStatusResult, ShopRestartResult, ShopSetEnabledResult, ShopUninstallResult, ShopUpdateResult, ShopVersionResult } from '../host/index.ts'
import { CATEGORY_ORDER, CHECK_UP_TO_DATE_MS, INSTALL_POLL_MS, RESTART_GRACE_MS, RESTART_WAIT_MS, SHOP_VISIBLE_BATCH, type Category, authorOf, categoryKey, categoryLocaleKey, displayVersion, entryKey, formatSize, formatStars, hasGithubHome, heldBy, identityKey, isCustomLicense, isShopLike, missingPeersOf, nextVisibleCount, npmPageUrl, rejectionCodeKey, restartReasonKey, reviewHashPin, sortByStars, starsOf, tierKey } from './present.ts'
import { useInstallFlows, type InstallFlow } from './useInstall.ts'
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
  /** The profile manifest's dependency specs — the install gate's own input,
   * so the card's verdict and the host's are one rule. `null` is "cannot
   * say", never "nothing is installed". */
  installedSpecs: () => Promise<Record<string, string> | null>
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
const EntryCard = memo(function EntryCard({ entry, stars, installed, missing, nameTakenBy, t, flowFor, installStatus, uninstall, restart, restartSupported, setEnabled, onSettled }: {
  entry: CatalogEntry
  stars: number | undefined
  installed: ShopInstalledEntry | undefined
  missing: string[]
  /** The repository (or npm package) whose plugin already holds this bundle
   * name. Undefined on the `installed !== undefined` branch by construction:
   * that branch means THIS identity is the one installed. */
  nameTakenBy: string | undefined
  t: ShopTabProps['t']
  flowFor: (key: string) => InstallFlow
  installStatus: ShopTabInjected['installStatus']
  uninstall: ShopTabInjected['uninstall']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
  setEnabled: ShopTabInjected['setEnabled']
  onSettled: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const blockers = blockersOf(missing, nameTakenBy, t)
  const detailId = useId()
  const summary = entry.catalog?.summary
  // Null for a github entry, and for any name outside npm's own grammar.
  const npmUrl = npmPageUrl(entry)
  const author = authorOf(entry)
  // Undefined for a github entry and for an npm publish predating npm 5.6;
  // the label is simply not rendered then.
  const size = formatSize(entry.unpackedSize)
  const category = entry.catalog?.category ?? 'other'
  const installTarget: InstallArgs = {
    name: entry.name,
    version: entry.version,
    source: entry.source,
    repo: entry.repo,
    subdir: entry.subdir,
  }
  const flow = flowFor(entryKey(entry))
  const uninstallSettled = useCallback(() => {
    // Once removal lands, an install/update result from the same session is
    // stale. Clear it before the installed projection drops this row.
    flow.reset()
    onSettled()
  }, [flow, onSettled])
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
        {/* Everything in this entry's way, one paragraph each, in the order
          * `blockersOf` fixes. Computed ONCE for the card: the badge below is
          * handed this same list, so the two can never be built from
          * different inputs or drift in ordering. */}
        {blockers.map(blocker => (
          <p className={css.incompatibleDetail} data-shop-incompatible-detail key={blocker.kind}>{blocker.text}</p>
        ))}
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
      {/* The action line: buttons sit on their own row under the summary,
       * each followed by the incompatibility badge that qualifies it; an
       * active install/uninstall flow (gate, log, notices) takes the full
       * width below them, where it has room. */}
      <div className={css.cardActions} data-shop-actions>
        {installed === undefined ? (
          <InstallPanel target={installTarget} tier={entry.tier} missing={missing} blockers={blockers} missingStated flow={flow} t={t} restart={restart} restartSupported={restartSupported} />
        ) : (
          <>
            {installed.outdated || flow.view.kind !== 'idle' ? (
              // The update button drives the same install flow for the
              // catalog's latest version; a completed flow stays mounted
              // after installed() catches up so its outcome remains visible.
              <InstallPanel target={installTarget} tier={entry.tier} variant={installed.outdated ? 'update' : 'install'} missing={missing} blockers={blockers} missingStated flow={flow} t={t} restart={restart} restartSupported={restartSupported} />
            ) : (
              // No button on this branch, so the badge follows the label that
              // takes its place: an installed plugin whose modules are absent
              // is exactly the case that most needs to say so.
              <>
                <p className={css.installedLabel} data-shop-installed>{t('installed')}</p>
                <BlockerBadge blockers={blockers} t={t} />
              </>
            )}
            {/* The hot enable/disable switch (§8) sits on every installed
             * row — current or outdated — and reads the inventory state. */}
            <EnabledSwitch row={installed} t={t} setEnabled={setEnabled} />
            <UninstallPanel name={entry.name} t={t} uninstall={uninstall} installStatus={installStatus} restart={restart} restartSupported={restartSupported} onSettled={uninstallSettled} />
          </>
        )}
        {/* How big it is and who put it here, pushed to the right edge of the
         * action row. Collapsed-card facts on purpose: comparing two
         * same-looking listings should not require opening each one, and the
         * size is what separates a 25 kB wrapper from a 180 MB one at a
         * glance. An active install flow takes the full row width, so this
         * group drops below it until the flow settles.
         *
         * The size reads left of the author because it is a property of the
         * artifact and the author is a property of its origin — and because
         * `size` is absent on every github entry, so putting it at the outer
         * edge would leave a ragged right margin down the shelf.
         *
         * The wrapper renders only when it has something to hold. An empty one
         * is not free: `.cardActions` is a flex row with `gap: 8px`, so a
         * zero-width item still adds 8px after the last button — and "neither"
         * is a common state rather than a corner, since a github entry has no
         * size and the live catalog carries no `publisher` for most entries
         * until the daily build that first harvested it. */}
        {(size !== undefined || author !== null) && (
          <span className={css.cardMeta}>
            {size !== undefined && (
              // role="img" + aria-label is this file's idiom for naming an
              // otherwise-generic element (see .starsBadge): the visible text
              // is the bare figure, while the accessible name and the tooltip
              // say WHICH size it is. Unpacked and download differ by the
              // compression ratio, and a reader who takes this for the
              // download has been misinformed by us.
              <span className={css.size} data-shop-size role="img" aria-label={t('sizeLabel', { size })} title={t('sizeLabel', { size })}>
                {size}
              </span>
            )}
            {author !== null && (
              <span className={css.author} data-shop-author>{t('authorLine', { author })}</span>
            )}
          </span>
        )}
      </div>
    </div>
  )
})

/** What stands between this entry and a working install. Two conditions of
 * different severity and different remedy, which is why the badge reads its
 * label off the kind instead of calling both "incompatible": missing
 * components are advisory — the host installs anyway — while a taken name is
 * a refusal the host will make, and the fix is uninstalling a plugin rather
 * than upgrading dsh. */
type BlockerKind = 'name-taken' | 'missing-peers'
interface Blocker { kind: BlockerKind; text: string }

/**
 * Everything standing in this entry's way, already localized.
 *
 * The two are independent and both can hold at once, so this is a list and
 * every surface renders the same list. The name conflict reads first: it is
 * about a plugin the reader chose and would lose.
 */
function blockersOf(missing: string[], nameTakenBy: string | undefined, t: ShopTabProps['t']): Blocker[] {
  const blockers: Blocker[] = []
  if (nameTakenBy !== undefined) {
    blockers.push({ kind: 'name-taken', text: t('nameTakenDetail', { holder: nameTakenBy }) })
  }
  if (missing.length > 0) {
    blockers.push({ kind: 'missing-peers', text: t('incompatibleDetail', { modules: missing.join(', ') }) })
  }
  return blockers
}

/** The harness-compatibility verdict, rendered beside the control it
 * qualifies. It answers "what happens if I press this", not "what is this",
 * so it belongs to the action row and not among the identity badges in the
 * header — where it also sat inside a <button>, competing with that button's
 * own hit area for the tooltip. Renders nothing when the harness provides
 * everything. */
function BlockerBadge({ blockers, t }: {
  /** Already computed by the surface that owns the card, so the badge and the
   * detail paragraphs can never be built from different inputs. */
  blockers: readonly Blocker[]
  t: ShopTabProps['t']
}): ReactNode {
  // On the list, not on the joined copy. `detail === ''` asked a question
  // about the dictionary — an empty or shadowed locale entry would have made
  // the badge vanish from a card that does have a reason.
  if (blockers.length === 0) return null
  const detail = blockers.map(blocker => blocker.text).join('\n')
  // A taken name is the more serious of the two and names a different remedy,
  // so it decides the visible word when both hold.
  const taken = blockers.some(blocker => blocker.kind === 'name-taken')
  return (
    // role="img" + aria-label is this file's own idiom for naming an
    // otherwise-generic element for assistive tech (see .starsBadge above):
    // the visible word stays the compact "Incompatible" label while the
    // accessible name carries the full explanation. This matters most on
    // OutdatedRow, which prints no [data-shop-incompatible-detail] line, so
    // without this the module list would reach the accessibility tree only
    // through `title` -- not keyboard-reachable, and announced unreliably or
    // not at all by screen readers. `title` stays too, for the mouse.
    <span
      className={css.incompatibleBadge}
      data-shop-blocker={taken ? 'name-taken' : 'missing-peers'}
      role="img"
      aria-label={detail}
      title={detail}
    >
      {t(taken ? 'nameTakenBadge' : 'incompatibleBadge')}
    </span>
  )
}

/** One entry's install flow: the button, the §9.3 acknowledgement gate for
 * community-tier entries, and the live view — running log, restart notice,
 * failure detail, rejection detail — driven by `useInstall`. Shared by the
 * catalog cards (`variant: 'install'`) and the outdated rows' update button
 * (`variant: 'update'`, which drives the same install flow for `name@latest`). */
function InstallPanel({ target, tier, missing, blockers, missingStated = false, variant = 'install', flow, t, restart, restartSupported }: {
  /** The install request this panel drives, identity included. */
  target: InstallArgs
  tier: CatalogEntry['tier']
  missing: string[]
  /** What stands in this install's way, computed by the surface that owns the
   * card. Empty on an outdated row: that row IS the installed plugin, so no
   * name conflict is possible and its badge carries `missing` alone. */
  blockers: readonly Blocker[]
  /** The surface around this panel already states what is missing, so the
   * gate must not repeat it. True on a catalog card, which renders the detail
   * whenever anything is missing; false on an outdated row, which carries the
   * badge and its title and nothing else — there the gate is the only place
   * the modules are named in plain sight. */
  missingStated?: boolean
  variant?: 'install' | 'update'
  /** Shared by every panel rendering this install identity. */
  flow: InstallFlow
  t: ShopTabProps['t']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
}): ReactNode {
  const [gateOpen, setGateOpen] = useState(false)
  const { view, start } = flow

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
        {/* The log outlives the install, exactly as it does on `failed`. It
            used to stop at the terminal state, so the outcome that leaves
            something worth reading — what landed, what pnpm did — was the one
            that showed nothing, and a user who looked away and back read that
            as the log having been lost (reported 2026-09-06). */}
        {view.log.length > 0 && (
          <div className={css.log}>
            {view.log.map((line, index) => <div key={index} className={css.logLine}>{line}</div>)}
          </div>
        )}
        <p className={css.notice} data-shop-restart-notice>
          {/* The done notice: a hot-mount failure names WHY through a reason
              code, localized here so it reads in the dsh language the person
              set — the host bakes no copy. A restart without a reason keeps
              the generic notice. needsRestart=false is the hot mount having
              SUCCEEDED (`hot.mount` returned ok, in `install`'s afterDone in
              index.ts) — the plugin is live, and the notice says so. It
              used to read as a stale-catalog anomaly, describing a state
              this branch has not carried since a failed confirm became
              `failed`: it told a user whose install had just gone live that
              nothing had changed and to try again. */}
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
        {!missingStated && blockersOf(missing, undefined, t).map(blocker => (
          <p className={css.gateWarning} data-shop-incompatible-warning key={blocker.kind}>{blocker.text}</p>
        ))}
        <div className={css.gateActions}>
          <button
            type="button"
            className={css.confirmButton}
            data-shop-confirm
            onClick={() => {
              setGateOpen(false)
              void start({ ...target, acknowledged: true })
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
  // A taken name is a refusal the host WILL make, and the client already holds
  // the same verdict — so the button must not open the §9.3 gate for it. That
  // gate asks the reader to accept a plugin's privileges; spending it on an
  // install that cannot proceed, and then landing them on a rejected card with
  // no retry, is the worst order to do these things in. Missing components
  // stay clickable: the host installs those, and the copy says "may".
  const refused = blockers.some(blocker => blocker.kind === 'name-taken')
  return (
    <>
      <button
        type="button"
        className={css.installButton}
        disabled={refused}
        {...(refused ? { 'data-shop-refused': true } : {})}
        {...(update ? { 'data-shop-update': true } : { 'data-shop-install': true })}
        onClick={() => {
          if (tier === 'verified') {
            // Reviewed: install directly; there is nothing to acknowledge (§9.3).
            void start({ ...target, acknowledged: undefined })
          } else {
            setGateOpen(true)
          }
        }}
      >
        {t(update ? 'update' : 'install')}
      </button>
      {/* One wording everywhere, including the outdated row. `missingByName`
          is keyed by the CATALOG (latest) entry, so on that row the version
          that actually runs is the INSTALLED one and it is the update that
          wants the missing module — the copy's "may be" carries that
          imprecision deliberately rather than splitting the string. */}
      <BlockerBadge blockers={blockers} t={t} />
    </>
  )
}

/** One installed entry's uninstall flow: remove from the profile through the
 * same executor records and poll loop as installs. Uninstalling revokes
 * privilege rather than granting it, so there is no acknowledgement gate —
 * §9.3 is about granting. A business failure (not in the catalog / not
 * installed) lands in the failed view with the host's published detail; a
 * transport failure carries the empty detail and the localized fallback. */
function UninstallPanel({ name, t, uninstall, installStatus, restart, restartSupported, onSettled }: {
  name: string
  t: ShopTabProps['t']
  uninstall: ShopTabInjected['uninstall']
  installStatus: ShopTabInjected['installStatus']
  restart: ShopTabInjected['restart']
  restartSupported: boolean
  onSettled: () => void
}): ReactNode {
  const { view, start } = useUninstall(uninstall, installStatus)
  const settled = useRef(onSettled)
  settled.current = onSettled
  useEffect(() => {
    if (view.kind === 'done') settled.current()
  }, [view.kind])

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
function RestartPanel({ t, restart, gate }: {
  t: ShopTabProps['t']
  restart: ShopTabInjected['restart']
  /** When given, the TRIGGER lives elsewhere — the version row — and this
   * panel renders only the confirmation and the outcome. Restarting drops
   * every live conversation, so moving the button must not move it past the
   * gate: both entry points open this same one, and only its confirm calls
   * the RPC. */
  gate?: { open: boolean; close: () => void }
}): ReactNode {
  const [ownGateOpen, setOwnGateOpen] = useState(false)
  const gateOpen = gate === undefined ? ownGateOpen : gate.open
  const setGateOpen = (open: boolean): void => {
    if (gate === undefined) setOwnGateOpen(open)
    else if (!open) gate.close()
  }
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
  // An external trigger owns the button; this panel is then only the gate and
  // the outcome, and renders nothing while idle.
  if (gate !== undefined) return null
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
function OutdatedRow({ row, tier, missing, t, setEnabled, flowFor, restart, restartSupported }: {
  row: ShopInstalledEntry
  tier: CatalogEntry['tier']
  missing: string[]
  t: ShopTabProps['t']
  setEnabled: ShopTabInjected['setEnabled']
  flowFor: (key: string) => InstallFlow
  restart: ShopTabInjected['restart']
  restartSupported: boolean
}): ReactNode {
  return (
    <div className={css.outdatedRow} data-shop-outdated-entry={row.name}>
      <div className={css.outdatedInfo}>
        <span className={css.name}>{row.name}</span>
        <span className={css.outdatedVersions}>
          <span>{t('installedVersion', { version: row.source === 'github' ? row.installed.slice(0, 7) : row.installed })}</span>
          <span>{t('latestVersion', { version: row.latest })}</span>
        </span>
      </div>
      <div className={css.outdatedActions}>
        <EnabledSwitch row={row} t={t} setEnabled={setEnabled} />
        <InstallPanel
          target={{ name: row.name, version: row.latest, source: row.source, repo: row.repo, subdir: row.subdir }}
          tier={tier} variant="update" missing={missing} blockers={blockersOf(missing, undefined, t)}
          flow={flowFor(identityKey(row))} t={t} restart={restart} restartSupported={restartSupported}
        />
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
function OutdatedSection({ state, entriesByKey, missingByKey, t, setEnabled, flowFor, restart, restartSupported }: {
  state: InstalledState
  entriesByKey: ReadonlyMap<string, CatalogEntry>
  missingByKey: ReadonlyMap<string, string[]>
  t: ShopTabProps['t']
  setEnabled: ShopTabInjected['setEnabled']
  flowFor: (key: string) => InstallFlow
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
          <li key={identityKey(row)}>
            <OutdatedRow
              row={row}
              tier={entriesByKey.get(identityKey(row))?.tier ?? 'community'}
              missing={missingByKey.get(identityKey(row)) ?? []}
              t={t}
              setEnabled={setEnabled}
              flowFor={flowFor}
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
  const { t, catalog, install, installStatus, setEnabled, installed, installedSpecs, uninstall, restart, version, updateStart } = props
  const [catalogState, setCatalogState] = useState<CatalogState>({ kind: 'loading' })
  const [installedState, setInstalledState] = useState<InstalledState>({ kind: 'loading' })
  /** The install gate's own input, or undefined while it is unknown — loading,
   * failed, or answered `null` by a host that could not read the manifest.
   * Undefined is never read as "nothing is installed": a card makes no claim
   * about a conflict it could not check. */
  const [specs, setSpecs] = useState<Record<string, string> | undefined>(undefined)
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
  // Lifted so the version row's Restart button and the confirmation below are
  // the same gate rather than two. Only the self-update path needs this; the
  // per-plugin panels keep RestartPanel's own state.
  const [selfRestartGate, setSelfRestartGate] = useState(false)
  const selfUpdate = useUpdateSelf(updateStart, installStatus)
  const [request, setRequest] = useState<LoadRequest>({ kind: 'initial' })
  // Mutations refresh only the installed projection; the catalog stays on
  // screen and its network/cache policy remains driven by `request`.
  const [mutations, setMutations] = useState(0)
  const noteMutation = useCallback(() => { setMutations(current => current + 1) }, [])
  const flows = useInstallFlows(install, installStatus, noteMutation)
  // A refresh deliberately leaves the current shelf on screen (§10), so the
  // reload control carries the only sign that the click did anything.
  const [reloading, setReloading] = useState(false)
  const [reloadFailed, setReloadFailed] = useState(false)
  const [query, setQuery] = useState('')
  // `installed` is a filter mode alongside the six catalog categories, not a
  // seventh category: it selects by installed state, not by `catalog.category`.
  const [category, setCategory] = useState<Category | 'installed' | null>(null)
  // Whether the shelf leaves out entries the Host reported missing components
  // for. Off by default: a filter nobody asked for must not hide listings on
  // first open, and the count on the button is what tells a reader there is
  // anything to hide. Independent of `category`, because it subtracts from
  // whatever the categories selected rather than competing with them.
  const [hideIncompatible, setHideIncompatible] = useState(false)

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
        //
        // A failed RELOAD keeps whatever is already on screen: the error view
        // exists for having nothing to show, and discarding a catalog the
        // user is reading because a re-fetch failed would be a worse outcome
        // than the stale data. The note beside the control says so, since a
        // reload that silently changed nothing is indistinguishable from one
        // that found no newer build.
        if (cancelled) return
        setCatalogState(current => (current.kind === 'ready' ? current : { kind: 'error' }))
        setReloadFailed(true)
      } finally {
        // Released on both outcomes: a reload that failed must hand the
        // button back rather than leave it disabled with nothing to retry.
        if (!cancelled) setReloading(false)
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
        // One effect, so the two views of the profile cannot disagree about
        // how fresh they are, and one failure surface rather than two.
        const [entries, held] = await Promise.all([installed(), installedSpecs()])
        if (cancelled) return
        setInstalledState({ kind: 'ready', entries })
        setSpecs(held ?? undefined)
      } catch {
        // Same privacy rule as the catalog: the transport detail is never
        // rendered; the error line is the readable face of a failed load.
        if (cancelled) return
        setInstalledState({ kind: 'error' })
        setSpecs(undefined)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [installed, installedSpecs, request, mutations])

  // Each shelf card looks its installed state up by install identity; the
  // Installed filter below selects on the same map.
  const installedByKey = useMemo(() => {
    const map = new Map<string, ShopInstalledEntry>()
    if (installedState.kind === 'ready') {
      for (const entry of installedState.entries) map.set(identityKey(entry), entry)
    }
    return map
  }, [installedState])

  // Entries the shelf will advertise: what the catalog carries, less the
  // competing markets. The exclusion lives here ONCE — `filtered`, the
  // category counts and the catalog line all read it — because while each
  // spelled it out for itself they drifted apart: the line counted every
  // entry and said "9300 packages" above a shelf that would never render 73
  // of them. An INSTALLED shop-like plugin stays manageable in the installed
  // section below; not advertised is not hidden. The repo slug gets the same
  // check for github entries.
  const browsable = useMemo(() => {
    if (catalogState.kind !== 'ready') return []
    // `notAShop` is the catalog's own exemption list (registry/not-a-shop.yml):
    // the name filter reads names, and a name cannot say whether a plugin
    // stores tea or sells plugins. It travels with the data, so a correction
    // lands on the next daily build instead of the client's next release.
    const cleared = new Set(catalogState.result.notAShop ?? [])
    return catalogState.result.plugins.filter(entry =>
      cleared.has(entry.name)
      || (!isShopLike(entry.name) && (entry.repo === undefined || !isShopLike(entry.repo))))
  }, [catalogState])

  // Sort once for a loaded catalog, then filter that stable ordering. A
  // filtered-list sort repeated the full comparator work on every keystroke.
  const stars = useMemo(
    () => (catalogState.kind === 'ready' ? catalogState.result.stars : {}),
    [catalogState],
  )
  const sortedBrowsable = useMemo(() => sortByStars(browsable, stars), [browsable, stars])

  // Each card's incompatibility badge, looked up once per catalog load
  // instead of computed inline in the render: missingPeersOf hands back a
  // fresh `[]` for every package the host did not flag, and doing that in
  // the JSX below would hand EntryCard's memo a new array on every
  // unrelated re-render (a keystroke, a poll tick), forcing every visible
  // card to re-render regardless of whether anything about it changed.
  //
  // Declared above `filtered` because that filter reads it: a `const` is in
  // its temporal dead zone until its own line runs, so a useMemo callback
  // that closes over one declared later throws on the first render rather
  // than on some later edge.
  const missingByKey = useMemo(() => {
    const map = new Map<string, string[]>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) {
        map.set(entryKey(entry), missingPeersOf(catalogState.result.incompatible, entryKey(entry)))
      }
    }
    return map
  }, [catalogState])

  // Which catalog entries a DIFFERENT plugin has already taken the name of.
  // Declared above `filtered` for the same temporal-dead-zone reason as
  // `missingByKey`: the filter below reads it.
  // `specs` is keyed by name, so this is one map lookup per entry — the first
  // version scanned the whole installed list per entry, ~9,300 linear searches
  // rebuilt on every install, uninstall and enable toggle.
  //
  // Memoized for CPU, not for reference identity: unlike `missingByKey`, whose
  // values are fresh arrays that would break EntryCard's memo, these are
  // strings and compare by value.
  const nameTakenByKey = useMemo(() => {
    const map = new Map<string, string>()
    if (catalogState.kind !== 'ready') return map
    for (const entry of catalogState.result.plugins) {
      const holder = heldBy(entry, specs)
      if (holder !== undefined) map.set(entryKey(entry), holder)
    }
    return map
  }, [catalogState, specs])

  // The set the filter offers to take away: exactly the entries whose badge
  // READS "Incompatible". `BlockerBadge` lets a taken name decide the visible
  // word when both blockers hold, so testing the peer list alone would hide a
  // card that never mentioned compatibility — and that card is the only
  // surface explaining why its install is refused. One predicate, so the
  // count on the button and the set it subtracts can never disagree.
  const badgedIncompatible = useCallback(
    (key: string) => (missingByKey.get(key) ?? []).length > 0 && !nameTakenByKey.has(key),
    [missingByKey, nameTakenByKey],
  )

  // What the category and the search box select, BEFORE the incompatible
  // modifier subtracts from it. Kept separate for two reasons: the empty shelf
  // below has to say which control emptied it, and this is the only honest way
  // to know — `matched` non-empty with `filtered` empty means the modifier did
  // it, with no second copy of the filter chain to drift.
  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sortedBrowsable.filter(entry => {
      if (category === 'installed') {
        if (!installedByKey.has(entryKey(entry))) return false
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
  }, [sortedBrowsable, query, category, installedByKey])

  // Never in the Installed view. That view is management, not shelf: an
  // installed plugin that is up to date appears in exactly one place — its
  // card, which carries the enable switch and the uninstall button, since
  // `OutdatedSection` renders only rows whose `outdated` is true. Subtracting
  // there would leave no way to remove the broken install the reader came to
  // fix. Same distinction the shop-like names already make: not advertised is
  // not hidden.
  //
  // Applied to the survivors rather than inside the pass above: this is the
  // most expensive predicate on the shelf (a key string, a map lookup) and the
  // least selective — the host flags a handful out of thousands — so running
  // it after the search narrows ~9,300 entries to a few is the same answer for
  // a fraction of the work on every keystroke.
  const filtered = useMemo(
    () => (hideIncompatible && category !== 'installed'
      ? matched.filter(entry => !badgedIncompatible(entryKey(entry)))
      : matched),
    [matched, hideIncompatible, category, badgedIncompatible],
  )
  filteredLenRef.current = filtered.length

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

  const visible = incremental ? filtered.slice(0, visibleCount) : filtered

  // One button per category plus All; each shows how many of the browsable
  // (shop-like-excluded) entries carry that category.
  const categoryCounts = useMemo(() => {
    const counts = new Map<Category, number>()
    for (const entry of browsable) {
      const key = categoryKey(entry)
      const bare = CATEGORY_ORDER.find(c => categoryLocaleKey(c) === key)
      if (bare !== undefined) counts.set(bare, (counts.get(bare) ?? 0) + 1)
    }
    return counts
  }, [browsable])

  // The Installed button's count: installed entries the shelf would actually
  // show (shop-like installed plugins stay in the installed section below).
  const installedCount = useMemo(() => {
    if (installedState.kind !== 'ready') return 0
    return installedState.entries.filter(entry => !isShopLike(entry.name)).length
  }, [installedState])

  // How many browsable entries the Host reported missing components for —
  // the number the filter button carries. Over `browsable`, like every
  // category count: a count over `filtered` would change as the reader typed
  // and would read as "how many are hidden right now", which is not what the
  // button offers to do.
  const incompatibleCount = useMemo(
    () => browsable.filter(entry => badgedIncompatible(entryKey(entry))).length,
    [browsable, badgedIncompatible],
  )

  // The outdated rows' update gate and source display both come from the
  // catalog entry, looked up by install identity.
  const entriesByKey = useMemo(() => {
    const map = new Map<string, CatalogEntry>()
    if (catalogState.kind === 'ready') {
      for (const entry of catalogState.result.plugins) map.set(entryKey(entry), entry)
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
          {/* Status only. The reload ACTION lives once, beside the build
            * date — two identical Refresh buttons on one screen made the
            * shelf ambiguous about which one did what. */}
          {result.stale && (
            <span className={css.staleBadge}>{t('staleLabel', { date: result.builtAt.slice(0, 10) })}</span>
          )}
          {selfVersion !== null && (
            <div className={css.versionBlock}>
              <span className={css.versionText} data-shop-version>v{selfVersion.installed}</span>
              {/* One control, one job, three states in sequence: Check ->
                * Update -> Restart. Each replaces the last rather than joining
                * it — while Check and Update both rendered, the row asked the
                * user to pick between two buttons when only one was ever the
                * thing to do, on a row that already wraps at ordinary widths.
                * The shop cannot swap itself live, so a landed self-update
                * always ends in a restart; the button carries it, and the gate
                * for it still renders in the panel below. While the update
                * runs, Check returns and the progress panel is the
                * affordance. */}
              {selfUpdate.view.kind === 'done' && restartSupported ? (
                <button
                  type="button"
                  className={css.restartSelfButton}
                  data-shop-restart
                  onClick={() => setSelfRestartGate(true)}
                >
                  {t('restart')}
                </button>
              ) : selfVersion.outdated && selfVersion.latest !== null && selfUpdate.view.kind === 'idle' ? (
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
              ) : (
                <button
                  type="button"
                  className={css.checkUpdateButton}
                  data-shop-check-update
                  /* `title`, not `aria-label`: an aria-label REPLACES the
                   * accessible name, so it would keep announcing "Check for
                   * updates" while the button reads "Up to date" and hide the
                   * state change. As a description it rides alongside instead.
                   * The visible word is short because this row wraps: measured
                   * against the built stylesheet, the row needs 776px to stay
                   * on one line with "Check for updates" and 712px with
                   * "Check". */
                  title={t('checkUpdateTitle')}
                  disabled={checkState !== 'idle'}
                  onClick={() => void checkVersion()}
                >
                  {checkState === 'up-to-date' ? t('upToDate') : t('checkUpdate')}
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
            {restartSupported && (
              <RestartPanel
                t={t}
                restart={restart}
                gate={{ open: selfRestartGate, close: () => setSelfRestartGate(false) }}
              />
            )}
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
          data-shop-category-all
        >
          {/* browsable.length, not the sum of the per-category counts: an
            * entry whose category is outside CATEGORY_ORDER lands in no
            * bucket and the sum would quietly lose it. */}
          {t('all')} {browsable.length}
        </button>
        {CATEGORY_ORDER.map(key => (
          <button
            key={key}
            type="button"
            className={category === key ? `${css.categoryButton} ${css.categoryButtonOn}` : css.categoryButton}
            aria-pressed={category === key}
            /* The hue the pressed state paints with, read from the same table
             * the cards' spines and badges read (`ShopTab.module.css`). It
             * rides the DOM rather than an inline style so the two surfaces
             * cannot drift: there is one table, and a tab is the colour of the
             * cards it filters to.
             *
             * It is a STYLING attribute and never a test hook: every card
             * carries `data-category` too, so `[data-category="tool"]` names a
             * tab and a card at once. That collision already made a spec count
             * seven tabs as seven cards; `data-shop-category-tab` is the hook,
             * matching the `data-shop-category-all` / `-installed` idiom on
             * either side of this loop. */
            data-category={key}
            data-shop-category-tab={key}
            onClick={() => { setCategory(key); setVisibleCount(SHOP_VISIBLE_BATCH) }}
          >
            {t(categoryLocaleKey(key))} {categoryCounts.get(key) ?? 0}
          </button>
        ))}
        {/* No `data-category`: Installed selects by installed state, not by
          * `catalog.category`, so it has no hue of its own and keeps the brand
          * token `.categoryButton` sets as the fallback. Same for All. */}
        <button
          type="button"
          className={category === 'installed' ? `${css.categoryButton} ${css.categoryButtonOn}` : css.categoryButton}
          aria-pressed={category === 'installed'}
          data-shop-category-installed
          onClick={() => { setCategory('installed'); setVisibleCount(SHOP_VISIBLE_BATCH) }}
        >
          {t('installed')} {installedCount}
        </button>
        {/* The incompatible filter, at the far edge of the bar (the stylesheet
          * pushes it there). A MODIFIER, not a ninth category: the categories
          * choose what to show and this subtracts from whatever they chose, so
          * it does not participate in `category` state and its own state
          * survives a category switch. The count is over `browsable` like the
          * category counts, so it says how many entries the shelf holds with
          * something missing — not how many the current filter shows.
          *
          * So it is a SWITCH and not a pill. It wore `.categoryButton` and sat
          * in the same row at the same size, which made a boolean modifier
          * read as a ninth tab that happened to be red — the tabs are a
          * choose-one group and this one is on or off, and nothing in the
          * shape said so. The track is the shop's existing switch, the one
          * every installed card carries, so there is one switch idiom here
          * rather than two.
          *
          * Absent in the Installed view, where the modifier does not apply:
          * that view is the only place a broken install can be disabled or
          * removed, so nothing is subtracted from it, and offering a control
          * that changes nothing would be a claim the view cannot honour. The
          * state itself survives — switching back brings it and its switch
          * back.
          *
          * `role="switch"` with `aria-checked` is what a fixed label buys.
          * The label used to flip between "Hide" and "Show", which ruled out
          * any state attribute — pairing a flipping label with a pressed state
          * announces "Show incompatible 1, pressed" while they are hidden,
          * the inverse of the truth — and cost a length: two labels are two
          * widths, so the control resized under the pointer that had just
          * clicked it, in a bar that wraps. The switch carries the state, the
          * words name what it does, and the box never changes size. The action
          * that a click performs now lives in the `title` alone, which is the
          * one place a changing string costs no layout. */}
        {category !== 'installed' && (
          <button
            type="button"
            role="switch"
            aria-checked={hideIncompatible}
            className={hideIncompatible ? `${css.incompatibleFilter} ${css.incompatibleFilterOn}` : css.incompatibleFilter}
            title={t(hideIncompatible ? 'showIncompatibleTitle' : 'incompatibleFilterTitle')}
            data-shop-hide-incompatible
            onClick={() => { setHideIncompatible(current => !current); setVisibleCount(SHOP_VISIBLE_BATCH) }}
          >
            {/* Decoration, not content: the button already carries the name
              * and `aria-checked` already carries the state, so an exposed
              * track would announce a second, nameless switch inside it. */}
            <span className={hideIncompatible ? `${css.switch} ${css.switchOn}` : css.switch} aria-hidden="true">
              <span className={css.switchKnob} />
            </span>
            {t('hideIncompatible', { count: incompatibleCount })}
          </button>
        )}
      </div>
      <div className={css.catalogStatsRow}>
        <p className={css.catalogStats} data-shop-catalog-stats>{t('catalogStats', { count: String(browsable.length), date: result.builtAt.slice(0, 10) })}</p>
        <button
          type="button"
          className={css.reloadButton}
          data-shop-reload
          disabled={reloading}
          onClick={() => { setReloading(true); setReloadFailed(false); setRequest({ kind: 'refresh' }) }}
        >
          {reloading ? t('refreshing') : t('refresh')}
        </button>
        {reloadFailed && <span className={css.reloadFailed} data-shop-reload-failed>{t('refreshFailed')}</span>}
      </div>
      {result.plugins.length === 0 ? (
        <p className={css.emptyLine}>{t('empty')}</p>
      ) : filtered.length === 0 ? (
        /* Which control emptied the shelf. `matched` is what the category and
         * the search box selected, so a non-empty `matched` with an empty
         * `filtered` says the incompatible modifier took the rest — and the
         * reader has to be told, because the search box they would look at is
         * empty and the modifier's own state survives category switches. The
         * generic search-miss line said "No matching plugins" over a shelf
         * their own toggle had cleared. */
        <p className={css.emptyLine} data-shop-empty>
          {matched.length > 0 ? t('emptyIncompatibleFiltered') : t('emptySearch')}
        </p>
      ) : (
        <>
          <ul className={css.cards}>
            {/* Keyed by install identity, never by name: the catalog's
              * uniqueness invariant is the identity, and 243 of its entries
              * share a name with another (see entryKey). A name key handed
              * React duplicates, and it then left every duplicate's card
              * orphaned in the DOM when the filter changed. */}
            {visible.map(entry => {
              // Once per card. `entryKey` builds a fresh string on every call,
              // and this line was asking for four of them.
              const key = entryKey(entry)
              return (
                <li key={key}>
                  <EntryCard entry={entry} stars={starsOf(entry, stars)} installed={installedByKey.get(key)} missing={missingByKey.get(key) ?? []} nameTakenBy={nameTakenByKey.get(key)} t={t} flowFor={flows.flowFor} installStatus={installStatus} uninstall={uninstall} restart={restart} restartSupported={restartSupported} setEnabled={setEnabled} onSettled={noteMutation} />
                </li>
              )
            })}
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
        entriesByKey={entriesByKey}
        missingByKey={missingByKey}
        t={t}
        setEnabled={setEnabled}
        flowFor={flows.flowFor}
        restart={restart}
        restartSupported={restartSupported}
      />
    </div>
  )
}
