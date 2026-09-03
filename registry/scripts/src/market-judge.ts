/**
 * Is this package a marketplace for dsh plugins?
 *
 * The name heuristic asks a cruder question and gets it wrong in one specific
 * direction: on the live catalog it caught 73 names and 20 were innocent —
 * 存茶指南, 腌菜保存, an A-share quant plugin whose "market" is the stock
 * market, a session-log plugin whose "store" is a verb. This asks the narrow
 * question the heuristic cannot.
 *
 * @module market-judge
 */
import { runBatches, type LlmOptions } from './llm-client.ts'

/** One candidate to judge: public npm/GitHub metadata only. */
export interface MarketItem {
  name: string
  /** `owner/slug` when the candidate came from a repository. Included because
   * the slug is sometimes the only thing that reads like a market, and the
   * model should see what tripped the filter. */
  repo?: string
  description: string | null
  keywords: string[]
}

export interface MarketBatchResult {
  /** Name → whether it is a dsh plugin marketplace. */
  verdicts: Map<string, boolean>
  /** Every name that ended the run without a verdict, with why. */
  discarded: { name: string; reason: string }[]
}

/**
 * Narrow on purpose.
 *
 * "Is this a market?" is the question that produced the eleven skill, skin,
 * MCP, CLI-tool and agent marketplaces sitting in markets.yml — all of them
 * markets, none of them selling dsh plugins. The question has to name the
 * goods.
 *
 * The asymmetry note is the other half. A wrong `true` hides a working plugin
 * from every user and nothing says so; a wrong `false` lists one competitor on
 * a shelf of nine thousand. Those are not equal, and the model is told which
 * way to lean — but it is told to OMIT rather than guess, because an omitted
 * name keeps the heuristic's answer and is asked again tomorrow, while a
 * guessed one is recorded forever.
 */
const SYSTEM_PROMPT = [
  'You decide ONE thing about each package: is it a MARKETPLACE FOR dsh PLUGINS —',
  'software whose purpose is to let a user browse and install dsh plugins?',
  '',
  'true ONLY for that. false for everything else, including:',
  '- a marketplace for something that is NOT a dsh plugin: skills, skins, themes,',
  '  MCP servers, CLI tools, agents, or another product entirely',
  '- a manager for plugins the user has ALREADY installed',
  '- a compatibility layer that loads another ecosystem\'s format',
  '- one author\'s bundle of their own plugins',
  '- a plugin whose NAME merely contains store/shop/market/mall in another sense:',
  '  storing tea, the stock market, a pet market, storing session logs',
  '',
  'If the metadata does not let you tell, OMIT that entry entirely. Do not guess.',
  'A wrong true hides a working plugin from every user; an omission costs nothing',
  'and the question is asked again tomorrow.',
  '',
  'Input: a JSON array of { name, repo, description, keywords }.',
  'Output: ONLY a JSON array [{"name":"...","market":true}], names echoed verbatim,',
  'omitting any you cannot decide, nothing else.',
].join('\n')

const USER_TEMPLATE = (items: MarketItem[]): string =>
  JSON.stringify(items.map(i => ({
    name: i.name,
    repo: i.repo ?? null,
    description: i.description,
    keywords: i.keywords,
  })))

/**
 * Read one batch's answer.
 *
 * Adopts a row only when the name was asked about and `market` is a real
 * boolean — a string "true", a missing key or an unexpected name is dropped,
 * which turns into a discard and a retry rather than a recorded guess. The
 * completion is untrusted model output shaped by untrusted npm descriptions.
 *
 * @param text - the raw completion.
 * @param expected - the names this batch asked about.
 * @returns the verdicts that survived, by name.
 */
export function parseMarketResponse(text: string, expected: Set<string>): Map<string, boolean> {
  const out = new Map<string, boolean>()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) return out
  let rows: unknown
  try {
    rows = JSON.parse(text.slice(start, end + 1))
  } catch {
    // A truncated or fenced completion: the whole batch degrades to discards.
    return out
  }
  if (!Array.isArray(rows)) return out
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const { name, market } = row as { name?: unknown; market?: unknown }
    if (typeof name !== 'string' || typeof market !== 'boolean') continue
    if (!expected.has(name) || out.has(name)) continue
    out.set(name, market)
  }
  return out
}

/**
 * Judge a batch of market candidates.
 * @param items - the candidates, already filtered to names without a verdict.
 * @param options - gateway, model, credentials, and test seams.
 * @returns the verdicts and one discard line per undecided name.
 */
export async function judgeMarkets(items: MarketItem[], options: LlmOptions): Promise<MarketBatchResult> {
  const { adopted, discarded } = await runBatches<MarketItem, boolean>(
    items,
    { systemPrompt: SYSTEM_PROMPT, toUser: USER_TEMPLATE, parse: parseMarketResponse },
    options,
  )
  return { verdicts: adopted, discarded }
}
