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
      let response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          max_tokens: 4096,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_TEMPLATE(batch) }],
        }),
      })
      for (let attempt = 0; (response.status === 429 || response.status >= 500) && attempt < RETRY_LIMIT - 1; attempt += 1) {
        const retryAfter = Number(response.headers.get('retry-after'))
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
          : Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS)
        await sleep(delay)
        response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: options.model,
            temperature: 0,
            max_tokens: 4096,
            messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: USER_TEMPLATE(batch) }],
          }),
        })
      }
      if (!response.ok) {
        for (const b of batch) discarded.push({ name: b.name, reason: `gateway ${response.status}` })
        return
      }
      let text = ''
      try {
        const body = await response.json() as { choices?: { message?: { content?: unknown } }[] }
        text = typeof body.choices?.[0]?.message?.content === 'string' ? body.choices[0].message.content : ''
      } catch {
        text = ''
      }
      const adopted = parseClassificationResponse(text, expected)
      for (const b of batch) {
        const category = adopted.get(b.name)
        if (category !== undefined) classified.set(b.name, category)
        else discarded.push({ name: b.name, reason: 'unparseable batch' })
      }
    }))
  }
  return { classified, discarded }
}
