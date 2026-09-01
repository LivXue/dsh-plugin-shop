/**
 * LLM classification client — the second module that reaches the network.
 *
 * Thin OpenAI-compatible layer over `POST {baseUrl}/chat/completions` with a
 * Bearer key. The model is a reasoning model (probe: 171 of 174 completion
 * tokens were reasoning), so items are classified in batches of
 * {@link CLASSIFY_BATCH_SIZE} to amortize that cost (spec
 * 2026-08-26-llm-categorization-design.md §3).
 * @module llm-client
 */

import { parseClassificationResponse } from './llm-parse.ts'
import type { Category } from './types.ts'

/** One package to classify: public npm metadata only (spec §3). */
export interface ClassifyItem {
  name: string
  description: string | null
  keywords: string[]
}

export interface ClassifyBatchResult {
  classified: Map<string, Category>
  /** Every expected name that ended the run without an adopted category, with why. */
  discarded: { name: string; reason: string }[]
}

export const CLASSIFY_BATCH_SIZE = 20

const CONCURRENCY = 4
/**
 * The completion budget per batch. It covers REASONING as well as output on
 * this model (D3: 171 of 174 completion tokens were reasoning), and reasoning
 * length does not follow input length — so 4096 truncated whole batches at
 * random: the 2026-09-01 backfill lost 1049 of 2724 names that way, with the
 * gateway answering 200 every time and description length identical between
 * the batches that survived and the ones that did not.
 */
const MAX_TOKENS = 16384
/** How much of an unusable completion the discard reason echoes. */
const HEAD_LIMIT = 80
const RETRY_LIMIT = 4
const RETRY_BASE_DELAY_MS = 1000
const RETRY_MAX_DELAY_MS = 8000

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The system prompt: the fixed vocabulary with the provider/integration tiebreak. */
const SYSTEM_PROMPT = [
  'You classify dsh plugin packages into exactly one of:',
  'tool — extends what the agent can do: commands, functions, utilities',
  'provider — connects to a service/API backend: model services, search APIs, cloud services',
  'ui — changes the interface: themes, widgets, panels',
  'workflow — orchestrates multi-step processes: pipelines, schedulers',
  'integration — bridges a specific third-party product (Slack, GitHub, Notion, and the like)',
  'theme — changes the interface\'s appearance: skins, themes, visual styles',
  'other — none of the above fits',
  'Disambiguation: provider is a generic capability; integration is a named product.',
  'Genuinely unsure means other.',
  'Input: a JSON array of { name, description, keywords }.',
  'Output: ONLY a JSON array [{"name":"...","category":"..."}], names echoed verbatim, nothing else.',
].join('\n')

const USER_TEMPLATE = (items: ClassifyItem[]): string =>
  JSON.stringify(items.map(i => ({ name: i.name, description: i.description, keywords: i.keywords })))

interface Options {
  baseUrl: string
  model: string
  apiKey: string
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/**
 * Why a 200 could not be used, in one line an operator can act on.
 *
 * The three shapes that lose a whole batch are indistinguishable in the
 * report otherwise: a truncated array, an empty completion (all budget spent
 * reasoning), and a body that was not the OpenAI shape at all. `finish_reason`
 * and `usage.completion_tokens` separate them, and the head of the content
 * shows which — the 2026-09-01 backfill recorded 1049 discards under one
 * constant string and could say nothing about any of them.
 *
 * The content echoes package descriptions, which are untrusted npm and GitHub
 * input, and this string is rendered into a markdown table: control
 * characters and `|` are replaced, and the echo is capped.
 */
function unusableReason(text: string, finishReason: unknown, completionTokens: unknown): string {
  const safe = (value: string): string => value.replace(/[\p{C}|]/gu, ' ')
  const head = safe(text).replace(/\s+/g, ' ').trim().slice(0, HEAD_LIMIT)
  const finish = typeof finishReason === 'string' && finishReason !== '' ? safe(finishReason).slice(0, 40) : '?'
  const tokens = typeof completionTokens === 'number' ? `, ${completionTokens} completion tokens` : ''
  const echo = head === '' ? '' : `: "${head}"`
  return `unparseable batch (finish_reason=${finish}${tokens}, content ${text.length} chars${echo})`
}

export async function classifyPackages(items: ClassifyItem[], options: Options): Promise<ClassifyBatchResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? defaultSleep
  const classified = new Map<string, Category>()
  const discarded: ClassifyBatchResult['discarded'] = []
  const batches: ClassifyItem[][] = []
  for (let i = 0; i < items.length; i += CLASSIFY_BATCH_SIZE) batches.push(items.slice(i, i + CLASSIFY_BATCH_SIZE))

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const slice = batches.slice(i, i + CONCURRENCY)
    await Promise.all(slice.map(async batch => {
      const expected = new Set(batch.map(b => b.name))
      // One body, sent by the first attempt and every retry: two copies of it
      // is two places for the token budget to drift apart.
      const request: RequestInit = {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          max_tokens: MAX_TOKENS,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_TEMPLATE(batch) }],
        }),
      }
      try {
        let response = await fetchImpl(`${options.baseUrl}/chat/completions`, request)
        for (let attempt = 0; (response.status === 429 || response.status >= 500) && attempt < RETRY_LIMIT - 1; attempt += 1) {
          const retryAfter = Number(response.headers.get('retry-after'))
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
            : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
          await sleep(delay)
          response = await fetchImpl(`${options.baseUrl}/chat/completions`, request)
        }
        if (!response.ok) {
          for (const b of batch) discarded.push({ name: b.name, reason: `gateway ${response.status}` })
          return
        }
        let text = ''
        let finishReason: unknown
        let completionTokens: unknown
        try {
          const body = await response.json() as {
            choices?: { message?: { content?: unknown }; finish_reason?: unknown }[]
            usage?: { completion_tokens?: unknown }
          }
          text = typeof body.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : ''
          finishReason = body.choices?.[0]?.finish_reason
          completionTokens = body.usage?.completion_tokens
        } catch {
          // A 200 whose body is not JSON or not the OpenAI shape: the batch degrades to unparseable discards below.
          text = ''
        }
        const adopted = parseClassificationResponse(text, expected)
        const reason = unusableReason(text, finishReason, completionTokens)
        for (const b of batch) {
          const category = adopted.get(b.name)
          if (category !== undefined) classified.set(b.name, category)
          else discarded.push({ name: b.name, reason })
        }
      } catch (error) {
        // A transport failure (connection refused, DNS, TLS) or any other throw from this
        // batch's own logic: every name in the batch becomes a gateway-unreachable discard.
        // A down gateway never fails the classification step (spec §5/D4).
        for (const b of batch) discarded.push({ name: b.name, reason: `gateway unreachable: ${error instanceof Error ? error.message : String(error)}` })
      }
    }))
  }
  return { classified, discarded }
}
