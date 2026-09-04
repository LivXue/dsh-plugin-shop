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
import { FetchTimeoutError, withTimeout } from './npm-client.ts'
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

/**
 * Per-attempt bound on a gateway completion.
 *
 * It has to be this large because the request is NOT streaming: nothing here
 * sets `stream: true`, so the response headers do not arrive until the model
 * has finished generating, and this deadline therefore bounds TOTAL GENERATION
 * of up to {@link MAX_TOKENS} = 16384 tokens — on a reasoning model, where D3
 * measured 171 of 174 completion tokens going to reasoning — with
 * {@link CONCURRENCY} = 4 streams sharing one self-hosted gateway. At 120s
 * that demanded 137 tok/s sustained per stream, which a healthy run can miss;
 * 600s asks for 27 tok/s, below any rate at which the step is worth running.
 *
 * Sized so it does not fire on a healthy run, NOT so it bounds a bad day: a
 * gateway that is down or hopelessly slow is capped by the build job's own
 * `timeout-minutes`, which is the only bound that sees the aggregate. What
 * keeps this number off the critical path is the retry ladder below, which now
 * treats a timeout as the transient failure it is.
 */
export const GATEWAY_REQUEST_TIMEOUT_MS = 600_000

/**
 * Wall-clock budget for ONE {@link runBatches} call. Past it, batches are
 * discarded unattempted rather than asked.
 *
 * A per-request deadline bounds one request; nothing bounded their SUM, and
 * the sum is a product of four things no single constant reveals:
 * ceil(batches / {@link CONCURRENCY}) waves, x {@link RETRY_LIMIT} attempts,
 * x {@link GATEWAY_REQUEST_TIMEOUT_MS}. For the 2724-name backfill in
 * MAX_TOKENS' comment that is 137 batches / 4 x 4 x 600s = ~1400 minutes,
 * inside a job bounded at 120 — and `classify.ts` runs BEFORE
 * `build:catalog`, so a stalled gateway would consume the run and the catalog
 * would never be built at all. Adding the retry made this 20x worse than the
 * ~70 minutes it cost before, trading a batch of 20 discarded names for the
 * whole day's catalog.
 *
 * A FIFTH multiplier is the caller: `classify.ts` makes two of these calls in
 * one process — the category question and the market question — so the STEP
 * caps at twice this, 30 minutes, and a third question would make it 45. That
 * is the number to check against the job's 120, not this one.
 *
 * Sized to be far above any healthy run and far below the job. Erring small is
 * cheap and self-correcting: `categories.yml` is a build input, so a discarded
 * tail is simply asked again next build, and successive builds converge.
 * Erring large costs the catalog.
 */
export const CLASSIFY_BUDGET_MS = 15 * 60_000

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
  /** Per-attempt deadline on a gateway request. Defaults to
   * {@link GATEWAY_REQUEST_TIMEOUT_MS}; a seam, so a test need not wait one out. */
  timeoutMs?: number
  /** Wall-clock budget for this whole call. Defaults to {@link CLASSIFY_BUDGET_MS}. */
  budgetMs?: number
  /** The clock, so a test can spend a 15-minute budget in milliseconds. */
  now?: () => number
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

/**
 * One batched question to the gateway, for any prompt.
 *
 * The transport half — batching, the concurrency window, the retry ladder, the
 * token budget and the three discard shapes — is the part that was measured
 * and tuned (D3, and the 2026-09-01 backfill that lost 1049 names). A second
 * question must not carry a second copy of it, so it is parameterised on the
 * three things that actually differ: the prompt, how a batch becomes a user
 * message, and how one answer is read.
 *
 * @param items - what to ask about; each must expose a `name` to echo.
 * @param ask - the prompt, the serialiser, and the parser for one batch.
 * @param options - gateway, model, credentials, and test seams.
 * @returns the adopted answers by name, and one discard line per name without one.
 */
async function runBatches<Item extends { name: string }, Answer>(
  items: Item[],
  ask: {
    systemPrompt: string
    toUser: (batch: Item[]) => string
    parse: (text: string, expected: Set<string>) => Map<string, Answer>
  },
  options: Options,
): Promise<{ adopted: Map<string, Answer>; discarded: { name: string; reason: string }[] }> {
  // Wrapped once, here, rather than at each of the two call sites below: the
  // retry line and the first attempt are exactly the pair a later edit bounds
  // one of and forgets the other.
  const timedFetch = withTimeout(options.fetchImpl ?? fetch, options.timeoutMs ?? GATEWAY_REQUEST_TIMEOUT_MS, 'llm gateway')
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? Date.now
  const budgetMs = options.budgetMs ?? CLASSIFY_BUDGET_MS
  const startedAt = now()
  // Safe by CHECK, not by construction — the shape this repo already uses for
  // its coverage guards and its systematic-failure bound. There is no
  // arrangement of the constants that makes the product safe; only measuring
  // the time actually spent does.
  const budgetSpent = (): boolean => now() - startedAt >= budgetMs
  const notAttempted = `classification stopped: the step's ${budgetMs}ms budget was spent before this batch was asked. It is asked again on the next build.`
  const classified = new Map<string, Answer>()
  const discarded: { name: string; reason: string }[] = []
  const batches: Item[][] = []
  for (let i = 0; i < items.length; i += CLASSIFY_BATCH_SIZE) batches.push(items.slice(i, i + CLASSIFY_BATCH_SIZE))

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    if (budgetSpent()) {
      // Every remaining name still gets a row. The budget skips WORK, never a
      // name: a name that silently vanished from the report would be the
      // 2026-09-01 backfill's defect again, where 1049 discards said nothing.
      for (const batch of batches.slice(i)) {
        for (const b of batch) discarded.push({ name: b.name, reason: notAttempted })
      }
      break
    }
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
          messages: [{ role: 'system', content: ask.systemPrompt }, { role: 'user', content: ask.toUser(batch) }],
        }),
      }
      // A timeout is transient in exactly the way a 429 or a 503 is, so it
      // belongs in the ladder rather than in the catch below. It used to skip
      // the ladder entirely — the loop matches on STATUS, and a throw goes
      // straight to the catch — which discarded all CLASSIFY_BATCH_SIZE names
      // in one go. And because a slow gateway is systematic, the same batches
      // were discarded again on every build: the "retried on the next build"
      // this module's discard reason promises never actually arrived.
      const attempt = async (): Promise<Response | FetchTimeoutError> => {
        try {
          return await timedFetch(`${options.baseUrl}/chat/completions`, request)
        } catch (error) {
          if (error instanceof FetchTimeoutError) return error
          throw error
        }
      }
      try {
        let outcome = await attempt()
        for (let retry = 0;
          (outcome instanceof FetchTimeoutError || outcome.status === 429 || outcome.status >= 500)
            && retry < RETRY_LIMIT - 1 && !budgetSpent();
          retry += 1) {
          const retryAfter = outcome instanceof FetchTimeoutError ? NaN : Number(outcome.headers.get('retry-after'))
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, RETRY_MAX_DELAY_MS)
            : Math.min(RETRY_BASE_DELAY_MS * 2 ** retry, RETRY_MAX_DELAY_MS)
          await sleep(delay)
          outcome = await attempt()
        }
        // Out of chances: hand it to the catch below, which is where a batch
        // becomes one `gateway unreachable` discard per name.
        if (outcome instanceof FetchTimeoutError) throw outcome
        const response = outcome
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
        } catch (error) {
          // A deadline that lands mid-body is not an unparseable completion,
          // and reporting it as one would publish a reason that is simply
          // untrue under each of the batch's package names. Rethrown to the
          // catch below, which says the honest thing.
          if (error instanceof FetchTimeoutError) throw error
          // A 200 whose body is not JSON or not the OpenAI shape: the batch degrades to unparseable discards below.
          text = ''
        }
        const adopted = ask.parse(text, expected)
        const reason = unusableReason(text, finishReason, completionTokens)
        for (const b of batch) {
          const answer = adopted.get(b.name)
          if (answer !== undefined) classified.set(b.name, answer)
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
  return { adopted: classified, discarded }
}

/**
 * Classify packages into the fixed category vocabulary.
 * @param items - the packages to classify.
 * @param options - gateway, model, credentials, and test seams.
 * @returns the adopted categories and the discards.
 */
export async function classifyPackages(items: ClassifyItem[], options: Options): Promise<ClassifyBatchResult> {
  const { adopted, discarded } = await runBatches<ClassifyItem, Category>(
    items,
    { systemPrompt: SYSTEM_PROMPT, toUser: USER_TEMPLATE, parse: parseClassificationResponse },
    options,
  )
  return { classified: adopted, discarded }
}

export { runBatches, type Options as LlmOptions }
