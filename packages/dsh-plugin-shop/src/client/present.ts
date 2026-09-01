/** Pure presentation core for the shop tab (§5.1 Client half). No React, no
 * timers, no I/O: every function here maps a value to a value, so fixtures
 * drive all of it. */

import type { ShopLocaleKey } from './locales.ts'
import type { CatalogEntry, HotRestartReason, InstallRejectionCode } from '../host/index.ts'

/** Hot-mount reason code → locale key, so the notice reads in the language
 * the person set in dsh. An absent (or unrecognized) reason keeps the generic
 * restart line rather than showing a bare code. */
export function restartReasonKey(reason: HotRestartReason | undefined): ShopLocaleKey {
  switch (reason) {
    case 'no-patch': return 'hotNoPatchNotice'
    case 'not-simple': return 'hotNotSimpleNotice'
    case 'host-unsupported': return 'hotHostUnsupportedNotice'
    case 'timeout': return 'hotTimeoutNotice'
    case 'mount-failed': return 'hotMountFailedNotice'
    default: return 'installedRestartNotice'
  }
}

/** Tier → locale key, for the entry-card tier badge (§6.2). */
export function tierKey(tier: CatalogEntry['tier']): ShopLocaleKey {
  switch (tier) {
    case 'verified': return 'tierVerified'
    case 'verified-stale': return 'tierVerifiedStale'
    case 'community': return 'tierCommunity'
  }
}

/** Spec §9.3 verbatim — the community-tier acknowledgement. The zh dictionary
 * states the same facts in its own register; never soften this wording. */
export const ACKNOWLEDGEMENT_EN =
  'Once installed, this plugin holds the same privileges as a built-in one: reading and writing your files, running shell commands, and reading and modifying the requests sent to the model. It has not been reviewed.'

/** Spec §9.3 in the zh register — the same facts, the same force. */
export const ACKNOWLEDGEMENT_ZH =
  '安装后，此插件将拥有与内置插件相同的权限：读写你的文件、执行 shell 命令，以及读取和修改发送给模型的请求。它未经审核。'

/** Install rejection code → locale key, for the rejected-state code label
 * (§7.2): every rejection the host can return has a human label here. */
export function rejectionCodeKey(code: InstallRejectionCode): ShopLocaleKey {
  switch (code) {
    case 'denied': return 'deniedCode'
    case 'not-in-catalog': return 'notInCatalogCode'
    case 'version-mismatch': return 'versionMismatchCode'
    case 'needs-acknowledgement': return 'needsAcknowledgementCode'
    case 'git-missing': return 'gitMissingCode'
    case 'tarball-integrity': return 'tarballIntegrityCode'
  }
}

/** The version a card displays: full for npm, the short commit for github. */
export function displayVersion(entry: { source: 'npm' | 'github'; version: string }): string {
  return entry.source === 'github' ? entry.version.slice(0, 7) : entry.version
}

/** The hash pin a stale line names for a repo or release-rescued entry — the
 * reviewed commit, or the reviewed release tarball sha256 (market borrowings
 * §3.1). Shortened to 7 chars like the card's own version; '' only for a
 * hand-built fixture carrying no pin. The npm form is a version and keeps the
 * version line's `v` prefix instead. */
export function reviewHashPin(review: NonNullable<CatalogEntry['review']>): string {
  return (review.reviewedCommit ?? review.reviewedSha256 ?? '').slice(0, 7)
}

/**
 * Whether the license value is the npm idiom `SEE LICENSE IN <file>` — a
 * valid SPDX form meaning "custom license, text ships in that file". The
 * catalog keeps the author's verbatim value; the shelf renders it as a
 * localized "Custom license" label. Everything else renders verbatim.
 */
export function isCustomLicense(license: string | null): boolean {
  return license !== null && /^SEE LICENSE IN /i.test(license)
}

/** One polled install status (§7.3 wire data), structural. */
export interface InstallStatusShape {
  found: boolean
  state: 'running' | 'done' | 'failed'
  log: string[]
  needsRestart?: boolean
  restartReason?: HotRestartReason
  detail?: string
}

/** The install view state machine (§7.2). */
export type InstallView =
  | { kind: 'idle' }
  | { kind: 'rejected'; code: InstallRejectionCode; detail: string }
  | { kind: 'running'; installId: string; log: string[] }
  | { kind: 'done'; needsRestart: boolean; restartReason?: HotRestartReason }
  | { kind: 'failed'; detail: string; log: string[] }

/** One event the install view reacts to. */
export type InstallEvent =
  | { type: 'rejected'; code: InstallRejectionCode; detail: string }
  | { type: 'started'; installId: string }
  | { type: 'status'; status: InstallStatusShape }

/** §7.2 once-per-second poll cadence, as a named constant. */
export const INSTALL_POLL_MS = 1000

/** §8 restart handoff: the client polls the origin only after this grace
 * period (the host's exit delay plus margin), so an origin that answers is
 * the NEW server, never the dying old one. */
export const RESTART_GRACE_MS = 3000

/** §8 restart handoff: how long the client waits for the new server to
 * answer before reporting the manual restart command. */
export const RESTART_WAIT_MS = 30000

/** How long the check-update button reports "up to date" after a re-check
 * finds no newer release, before reverting to its idle label. */
export const CHECK_UP_TO_DATE_MS = 3000

/** How many shelf cards mount at a time. The shelf holds ~1900 entries; one
 * commit of the whole grid is ~28k DOM nodes, so the list renders in batches
 * behind a sentinel (§A1) and grows on scroll. 48 is ~3-4 rows. */
export const SHOP_VISIBLE_BATCH = 48

/** The next number of cards to show: the current window plus one batch,
 * clamped so the window never claims more cards than the list holds. */
export function nextVisibleCount(visible: number, total: number, batch: number): number {
  return Math.min(visible + batch, total)
}

/** Pure install view reducer. A `status` event only applies to the install the
 * view is tracking — a status for an install it never started (idle) is an
 * unrelated event and a no-op, like any other event it does not recognize. */
export function reduceInstall(state: InstallView, event: InstallEvent): InstallView {
  switch (event.type) {
    case 'started':
      return { kind: 'running', installId: event.installId, log: [] }
    case 'rejected':
      return { kind: 'rejected', code: event.code, detail: event.detail }
    case 'status': {
      if (state.kind !== 'running') return state
      const { status } = event
      // The host retains finished records, so a poll that reports no record
      // after a successful start is genuinely anomalous. Surface the host's
      // own detail when it has one; otherwise the honest generic line.
      if (!status.found) {
        return { kind: 'failed', detail: status.detail ?? 'install record lost', log: status.log }
      }
      if (status.state === 'running') {
        return { kind: 'running', installId: state.installId, log: status.log }
      }
      if (status.state === 'done') {
        // A hot-mount failure rides the done status as a bilingual restart
        // reason (market borrowings §4.2); the view carries it only when the
        // host sent one, so a plain restart keeps the old shape.
        return {
          kind: 'done',
          needsRestart: !!status.needsRestart,
          ...(status.restartReason !== undefined ? { restartReason: status.restartReason } : {}),
        }
      }
      return { kind: 'failed', detail: status.detail ?? '', log: status.log }
    }
  }
}

const SHOP_KEYWORDS = ['store', 'market', 'mall', 'shop', 'marketplace'] as const

/**
 * Competing plugin marketplaces whose names carry no store/market keyword
 * and so escape the pattern rules below (spec §7.2). Each is a real npm
 * package that presents its own catalog of dsh plugins inside the Harness:
 * `dsh-plugin` is the npm package of github.com/dshplugin/dsh-plugin-hub,
 * `dsh-plugin-hub` and `@lanbaolu/dsh-plugin-hub` are app-store packages,
 * and `@mutocenew/dsh-plugin-catalog` ships a plugin directory with agent
 * query tools. Exact names only — nothing here is a pattern.
 */
const SHOP_LIKE_NAMES = ['dsh-plugin', 'dsh-plugin-hub', '@lanbaolu/dsh-plugin-hub', '@mutocenew/dsh-plugin-catalog'] as const

/**
 * Whether a package name reads as a plugin shop (a marketplace for dsh
 * plugins, e.g. `dsh-plugin-shop`, `dsh-store`, `pluginstore`). The shop
 * tab hides these so the market does not list competing markets.
 *
 * Precision over recall: a name merely CONTAINING a keyword segment without
 * a plugin qualifier or a keyword ending (`market-data-provider`,
 * `marketplace-hub`) is NOT a shop plugin, and `dsh-restore` must never
 * match on the substring "store". The keyword list keeps "store" on purpose:
 * it matches other people's package names, not ours.
 */
export function isShopLike(name: string): boolean {
  if ((SHOP_LIKE_NAMES as readonly string[]).includes(name.toLowerCase())) return true
  const segments = name.toLowerCase().split(/[-_.]+/)
  const hasPlugin = segments.includes('plugin')
  const concatenated = segments.some(segment =>
    /plugin(store|market|mall|shop|marketplace)/.test(segment)
    || /(store|market|mall|shop|marketplace)plugin/.test(segment))
  if (concatenated) return true
  // The glued spelling: `dshmarket` is one segment, so the keyword rules
  // below never see it. A segment that IS a keyword with only the `dsh`
  // prefix glued on is a store name; `dshstorekeeper` (extra letters after
  // the keyword) is not — same precision as the hyphenated cases.
  const glued = segments.some(segment =>
    segment.startsWith('dsh') && (SHOP_KEYWORDS as readonly string[]).some(keyword => segment === `dsh${keyword}`))
  if (glued) return true
  // `dsh-market-plus`: the keyword sits right after the dsh prefix but the
  // name does not END there. The second segment must be the keyword EXACTLY
  // (`dsh-marketing-tool` stays listed), and a third segment must be a store
  // qualifier — `dsh-shop-assistant` is an ecommerce operators' tool, not a
  // competing store, and stays listed too. The scoped spelling counts
  // (`@scope/dsh` is one segment because `/` is not a separator).
  const STORE_QUALIFIERS = ['plus', 'pro', 'hub', 'center', 'centre', 'max', 'free', 'lite'] as const
  const dshMarket = segments.length >= 2
    && (segments[0] === 'dsh' || segments[0]?.endsWith('/dsh') === true)
    && (SHOP_KEYWORDS as readonly string[]).includes(segments[1] as (typeof SHOP_KEYWORDS)[number])
    && (segments.length === 2 || (segments[2] !== undefined && (STORE_QUALIFIERS as readonly string[]).includes(segments[2] as (typeof STORE_QUALIFIERS)[number])))
  if (dshMarket) return true
  const keywordSegments = segments.filter(segment => (SHOP_KEYWORDS as readonly string[]).includes(segment))
  if (keywordSegments.length === 0) return false
  return hasPlugin || SHOP_KEYWORDS.includes(segments.at(-1) as (typeof SHOP_KEYWORDS)[number])
}

const CATEGORY_KEYS = {
  tool: 'categoryTool',
  provider: 'categoryProvider',
  ui: 'categoryUi',
  workflow: 'categoryWorkflow',
  integration: 'categoryIntegration',
  theme: 'categoryTheme',
  other: 'categoryOther',
} as const

/** The locale key for one entry's category — derived entries read as `other`
 * (§6.1: a derived listing has no declared category). */
export function categoryKey(entry: CatalogEntry): ShopLocaleKey {
  return CATEGORY_KEYS[entry.catalog?.category ?? 'other']
}

/** The category vocabulary as a type, derived from the map above so the
 * client never repeats the seven literals. */
export type Category = keyof typeof CATEGORY_KEYS

/** The seven categories in display order (map insertion order). */
export const CATEGORY_ORDER = Object.keys(CATEGORY_KEYS) as Category[]

/** The locale key for one bare category value (the filter buttons). */
export function categoryLocaleKey(category: Category): ShopLocaleKey {
  return CATEGORY_KEYS[category]
}

/** Sort the shelf: stars descending, un-starred entries last, name ascending
 * (case-insensitive) on ties (spec 2026-08-26-github-stars-design.md D1).
 * Display-time only — the catalog's own name sort is untouched. */
export function sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[] {
  const count = (e: CatalogEntry): number => stars[e.name] ?? -1
  return [...entries].sort((a, b) => {
    const byStars = count(b) - count(a)
    if (byStars !== 0) return byStars
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** 999 → "999"; 1000 → "1k"; 1234 → "1.2k"; 1500 → "1.5k"; 99999 → "100k". */
export function formatStars(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}
