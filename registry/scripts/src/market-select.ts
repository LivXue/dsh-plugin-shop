/**
 * Which names still need a market verdict.
 *
 * The name heuristic is the CANDIDATE filter, never the answer: it catches
 * competing marketplaces and, on the live catalog, 20 innocent names out of 73
 * as well. Everything it catches goes to `registry/markets.yml` for a verdict —
 * a human's or the classifier's — and a name already recorded there is never
 * asked about again, whichever way it was judged. That memory is what keeps an
 * LLM from flipping a name on and off the shelf between builds and churning
 * the catalog's content hash with it.
 *
 * @module market-select
 */
import { isShopLike } from '../../../packages/dsh-plugin-shop/src/shared/shop-like.ts'

/** A harvested candidate, npm or repo, reduced to what the filter reads. */
export interface MarketCandidate {
  name: string
  /** `owner/slug` for a github candidate. The filter reads it too: one entry
   * was caught by its repo alone while its package name was innocent. */
  repo?: string
}

/**
 * The names to ask about, sorted and deduplicated.
 *
 * Deduplicated by NAME because that is the unit `markets.yml` records and the
 * unit the client filters on — seven separate repos publish `dsh-plugin-market`,
 * and asking seven times would write one row.
 *
 * @param candidates - everything harvested this run.
 * @param judged - every name `markets.yml` already has a verdict for.
 * @returns names caught by the heuristic and not yet judged.
 */
export function selectMarketPending(
  candidates: readonly MarketCandidate[],
  judged: ReadonlySet<string>,
): string[] {
  const pending = new Set<string>()
  for (const candidate of candidates) {
    if (judged.has(candidate.name)) continue
    if (isShopLike(candidate.name) || (candidate.repo !== undefined && isShopLike(candidate.repo))) {
      pending.add(candidate.name)
    }
  }
  return [...pending].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}
