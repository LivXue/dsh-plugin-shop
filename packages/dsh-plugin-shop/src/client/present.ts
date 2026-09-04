/** Pure presentation core for the shop tab (§5.1 Client half). No React, no
 * timers, no I/O: every function here maps a value to a value, so fixtures
 * drive all of it. */

export { isShopLike } from '../shared/shop-like.ts'
export { identityKey, installedSpecMatches, parseRepoSpec, type EntryIdentity } from '../shared/identity.ts'
import { identityKey } from '../shared/identity.ts'
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

/** The peers the Host said this installation does not provide, or none when it
 * said nothing — a plugin that runs here and one the Host could not judge are
 * both rendered as no warning at all. The map is keyed by install identity,
 * never by name, because two entries can share a name. */
export function missingPeersOf(incompatible: Record<string, string[]>, key: string): string[] {
  return incompatible[key] ?? []
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
    case 'tarball-integrity': return 'tarballIntegrityCode'
    case 'ambiguous-identity': return 'ambiguousIdentityCode'
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

/**
 * The npm package page for one entry, or null when there is none to link.
 *
 * The name is untrusted catalog input and this CONSTRUCTS a URL from it, so
 * only a name inside the npm grammar gets a link — one optional `@scope/`
 * segment, then a name, both limited to npm's own character set. Every
 * character that survives that check is already safe in a URL path, so the
 * value is used verbatim: percent-encoding it would only mangle the `@` and
 * the scope separator that npm's own URLs carry literally. Anything else —
 * a traversal, a query, a whole URL smuggled in as a name — answers null and
 * the row renders as plain text, the same rule the repository row applies.
 *
 * A github entry answers null: it is installed from a repo and has no npm
 * package page.
 */
/**
 * Whether this entry has a GitHub home the reader could go and inspect.
 *
 * True for a github-source entry — a repository IS its identity — and for an
 * npm entry whose `repository` points at github.com, which is 4892 of the
 * live catalog's 4915 entries. The mark is therefore ordinary and its
 * ABSENCE is the signal: a listed package with no public source to read.
 *
 * `repository` is untrusted catalog input, so the host is PARSED rather than
 * pattern-matched — `evil-github.com` and `github.com.evil.test` both end in
 * the string and neither is GitHub. An unparseable or empty value (two live
 * entries carry one) is simply not a GitHub home.
 */
export function hasGithubHome(entry: CatalogEntry): boolean {
  if (entry.source === 'github') return true
  if (entry.repository === null) return false
  try {
    const host = new URL(entry.repository).hostname.toLowerCase()
    return host === 'github.com' || host === 'www.github.com'
  } catch {
    // Not a URL at all: no home to point at, and nothing to claim.
    return false
  }
}

/**
 * Who put this entry where it is — the fact a reader wants when two listings
 * carry the same text from different hands.
 *
 * The two sources answer it differently and neither is npm's `author` field:
 * that one is free text the publisher writes, and a clone inherits it
 * verbatim. An npm entry answers with the account npm recorded for the
 * version (`publisher`); a github entry answers with its repository owner,
 * which is already half of the `owner/slug` that IS its identity — so nothing
 * new has to be harvested or emitted for it.
 *
 * `repo` reaches the client as an unvalidated string, so the owner is taken
 * only from a value that really is `owner/slug` with an owner GitHub would
 * accept (1-39 chars of alphanumerics and hyphens). Anything else yields
 * null: a misleading fragment is worse than saying nothing, the same rule
 * npmPageUrl applies to a package name.
 */
export function authorOf(entry: CatalogEntry): string | null {
  if (entry.source === 'github') {
    if (entry.repo === undefined) return null
    const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/[^/]+$/.exec(entry.repo)
    return match?.[1] ?? null
  }
  return entry.publisher ?? null
}

export function npmPageUrl(entry: CatalogEntry): string | null {
  if (entry.source !== 'npm') return null
  const name = entry.name
  // 214 is npm's own limit; the segment checks reject `.`/`..` so the path
  // cannot climb out of /package/.
  if (name.length === 0 || name.length > 214) return null
  if (!/^(@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name)) return null
  if (name.split('/').some(segment => segment === '.' || segment === '..' || segment === '@')) return null
  return `https://www.npmjs.com/package/${name}`
}

/**
 * One entry's install identity — the value the catalog guarantees unique, and
 * therefore the only safe React key for a shelf card.
 *
 * `name` is NOT unique. The catalog's uniqueness invariant is the install
 * identity (registry `emit.ts` assertCatalogInvariants): `npm:<name>` for an
 * npm entry, `github:<repo>#<subdir>` for a repo one — so two GitHub
 * repositories publishing the same `package.json` name are two legitimate
 * entries under one name, as are two subpackages of one monorepo. The live
 * catalog holds 151 such names over 243 entries, five of them cookiecutter
 * templates that all name themselves `{{PKG_NAME}}`.
 *
 * Keying the shelf by name handed React duplicate keys, and React could then
 * no longer match a card to its DOM node: changing the filter left every
 * duplicate orphaned on the page — hundreds of stale cards from the previous
 * category, accumulating with each switch until the tab stopped responding.
 * This mirrors the registry's identity verbatim; the two must not drift.
 */
export function entryKey(entry: CatalogEntry): string {
  return identityKey(entry)
}

/**
 * One entry's star count from the sidecar, or undefined when it has none.
 *
 * The sidecar keys a github entry by its repo full name and an npm entry by
 * its package name — two disjoint keyspaces (registry `stars-assemble.ts`).
 * Every reader must go through this one function: the card read the repo key
 * and the shelf sort read the name, so for 2202 of the live catalog's 2210
 * github listings the number deciding a row's position was not the number
 * printed on it. 1590 of them sorted as unstarred — a 4014-star plugin at the
 * bottom of the shelf — and where an unrelated npm package happened to share
 * a listed entry's name, its stars ranked that entry instead: a 1-star
 * plugin held the first page on 13960 stars belonging to another project's
 * repo, one the catalog never even listed.
 */
export function starsOf(entry: CatalogEntry, stars: Record<string, number>): number | undefined {
  const key = entry.repo ?? entry.name
  // Package names are untrusted keys; never borrow Object.prototype members
  // such as `constructor` or `toString` as if they were star counts.
  if (!Object.hasOwn(stars, key)) return undefined
  return stars[key]
}

/** Sort the shelf: stars descending, un-starred entries last, name ascending
 * (case-insensitive) on ties (spec 2026-08-26-github-stars-design.md D1).
 * Display-time only — the catalog's own name sort is untouched. */
export function sortByStars(entries: CatalogEntry[], stars: Record<string, number>): CatalogEntry[] {
  // -1, never 0: a repo with a real count of zero still sorts above an entry
  // the sidecar has no count for at all.
  const count = (e: CatalogEntry): number => starsOf(e, stars) ?? -1
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
