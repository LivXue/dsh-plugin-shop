/**
 * Whether a package name reads as a competing plugin marketplace.
 *
 * Shared on purpose. The registry needs it to pick which newly harvested names
 * to send for a market verdict, and the client needs it to hide the ones no
 * verdict has reached yet. When each had a copy they drifted — that is exactly
 * how the shelf came to disagree with its own count — so there is one.
 *
 * It lives under the published package rather than beside the registry because
 * the dependency can only point this way: the package's tsconfig pins
 * `rootDir: "src"`, so nothing outside it can be imported, while the registry
 * scripts are internal and may reach in.
 *
 * This is a NAME heuristic and nothing more. It cannot tell a plugin that
 * stores tea from one that sells plugins — on the live catalog it caught 73
 * names of which 20 were innocent — so `registry/markets.yml` carries the
 * verdict per name and overrides it either way.
 *
 * @module shared/shop-like
 */

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
