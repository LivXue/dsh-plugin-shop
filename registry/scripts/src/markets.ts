/**
 * `markets.yml`: the verdict on every name the shop-like filter catches.
 *
 * The file is regenerated on every classify run, so its header lives in
 * exactly one place, as `categories.yml`'s does.
 *
 * @module markets
 */

/** One recorded verdict. */
export interface MarketRow {
  name: string
  /** Whether it is a competing dsh plugin marketplace. */
  market: boolean
  by: 'human' | 'llm'
  reason: string
}

const HEADER = [
  '# Every name the shop-like NAME filter catches, and whether it is actually a',
  '# competing dsh plugin market.',
  '#',
  '# The filter reads names. A name cannot say whether a plugin stores TEA or',
  '# sells plugins, so on its own it hid 20 legitimate entries out of 73 — and',
  '# hid them silently: catalogued, gated, tiered, never rendered.',
  '#',
  '#   market: true   a competing dsh plugin market. Withheld from the shelf —',
  '#                  but only with by: human. With by: llm it is a HOLD: the',
  '#                  entry stays shelved and the build report lists it for a',
  '#                  human to confirm (by: human) or correct (market: false).',
  '#   market: false  not one. Shelved like any other entry; this clears the name',
  '#                  filter and NOTHING else — no trust tier, no skipped gate.',
  '#',
  '# BOTH verdicts are recorded, not just the exemptions. That memory is what lets',
  '# the daily classifier skip a name it has already judged, and it is what stops',
  '# an LLM flip-flopping a name on and off the shelf and churning the catalog\'s',
  '# content hash with it. Rows are never pruned for the same reason: a name that',
  '# drops out of the catalog for a day must not come back unjudged.',
  '#',
  '#   by: human   adjudicated in review. Never overwritten by the classifier.',
  '#               This is the only value that can withhold a listing.',
  '#   by: llm     judged by the daily classifier. Advisory, like every other LLM',
  '#               verdict here: it removes nothing. A true is a review hold —',
  '#               correct a wrong row by editing it, and it will not be',
  '#               re-asked. A model steered by a hostile package description',
  '#               could otherwise have delisted a neighbour for good.',
  '#',
  '# Keyed by NAME, which is the unit the client filters on, and not by the',
  '# catalog\'s install identity. Those differ: the 73 caught entries carry 65',
  '# distinct names, because `dsh-plugin-market` is published by seven separate',
  '# repos and `dsh-plugin-store` by three. A verdict covers every entry sharing',
  '# that name.',
  '#',
  '# Seeded 2026-09-02 from an audit of all 73, each checked against its GitHub',
  '# description or npm metadata rather than the catalog summary alone. `reason`',
  '# on a market:true row quotes what the plugin says it is; that self-description',
  '# is the evidence.',
  '',
  '',
].join('\n')

/**
 * Fold fresh LLM verdicts into the recorded ones.
 *
 * An existing row always wins. A human row is authoritative, and an llm row
 * already present means the name has been judged — re-answering it is exactly
 * the flip-flop the file exists to prevent. `selectMarketPending` should never
 * offer a judged name anyway; this makes that a property rather than a hope.
 *
 * Nothing is pruned. `categories.yml` drops names that left the catalog because
 * a stale category costs nothing; a dropped verdict costs a re-ask and, with
 * it, the chance of a different answer.
 *
 * @param existing - rows parsed from the file.
 * @param fresh - name → is-a-market, from this run's classifier.
 * @param reasons - name → the one-line reason to record for a fresh verdict.
 * @returns every row, sorted by name.
 */
export function mergeMarketRows(
  existing: readonly MarketRow[],
  fresh: ReadonlyMap<string, boolean>,
  reasons: ReadonlyMap<string, string>,
): MarketRow[] {
  const merged = new Map<string, MarketRow>()
  for (const row of existing) merged.set(row.name, row)
  for (const [name, market] of fresh) {
    if (merged.has(name)) continue
    merged.set(name, {
      name,
      market,
      by: 'llm',
      reason: reasons.get(name) ?? (market ? 'Judged a dsh plugin market.' : 'Judged not a dsh plugin market.'),
    })
  }
  return [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * Serialize rows to the file text: header, sorted rows, trailing newline.
 *
 * Names and reasons are ALWAYS double-quoted with JSON escaping. A scoped npm
 * name starts with `@`, which YAML forbids at the start of a plain scalar, and
 * a reason quotes an untrusted npm description that may hold a colon, a quote
 * or a newline — either would produce a file this step's own loader could not
 * read back. JSON string syntax is valid YAML and handles all of it.
 *
 * @param rows - the merged rows.
 * @returns the file text.
 */
export function serializeMarketRows(rows: readonly MarketRow[]): string {
  const sorted = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const text = sorted.map(row => [
    `- name: ${JSON.stringify(row.name)}`,
    `  market: ${row.market ? 'true' : 'false'}`,
    `  by: ${row.by}`,
    `  reason: ${JSON.stringify(row.reason.replace(/\s+/g, ' ').trim())}`,
  ].join('\n')).join('\n\n')
  return `${HEADER}${text}\n`
}
