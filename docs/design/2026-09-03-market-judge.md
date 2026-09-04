# The market judge and `markets.yml` — design

Date: 2026-09-03
Status: describes shipped behaviour, with the D-7 amendment this document was written for.

## 1. Why the filter exists, and why it is not the answer

The shelf must not advertise its competitors, so the client hides an entry
whose NAME reads like a plugin marketplace (`shared/shop-like.ts`,
`isShopLike`). A name is a bad instrument for that question. On the live
catalog the filter caught 73 entries and 20 of them were innocent: 存茶指南
and 腌菜保存 (storing tea, storing pickles), an A-share quant plugin whose
"market" is the stock market, a session-log plugin whose "store" is a verb.

Those 20 were not merely mislabelled — they were catalogued, gated, tiered and
then never rendered, with nothing anywhere saying why. That is the failure this
design answers: the filter stays as a CANDIDATE selector, and every name it
catches goes to a recorded verdict.

## 2. The pieces

| Piece | Purity | What it does |
|---|---|---|
| `shared/shop-like.ts` | pure | the NAME heuristic; selects candidates, decides nothing |
| `market-select.ts` | pure | `selectMarketPending(candidates, judged)` — the names still lacking a verdict, deduplicated by name and sorted |
| `market-judge.ts` | shell | the prompt, and `parseMarketResponse`, which is pure |
| `markets.ts` | pure | `mergeMarketRows`, `serializeMarketRows` |
| `registry/markets.yml` | data | the recorded verdicts — a build input, like `verified.yml` |
| `config.ts` | shell | derives `notAShop` and `marketHolds` from the rows |

`markets.yml` is keyed by NAME, which is the unit the client filters on and
NOT the catalog's install identity. The two differ: the 73 caught entries carry
65 distinct names, because `dsh-plugin-market` is published by seven separate
repositories and `dsh-plugin-store` by three. A verdict covers every entry
sharing that name.

## 3. The question the model is asked

"Is this a MARKETPLACE FOR dsh PLUGINS — software whose purpose is to let a
user browse and install dsh plugins?" Narrow on purpose. "Is this a market?"
is what produced the eleven skill, skin, MCP, CLI-tool and agent marketplaces
sitting in the file: all markets, none of them selling dsh plugins.

The model is told to OMIT what it cannot decide rather than guess, because an
omitted name keeps the heuristic's answer and is asked again tomorrow, while a
recorded one is not.

## 4. What a verdict may do — the D-7 amendment

**An LLM verdict never removes an entry.** This is the CLAUDE.md rule, and
until 2026-09-03 the code broke it:

- `market: true, by: human` — withholds the listing. A human read the plugin.
- `market: true, by: llm` — a **hold**. The name is recorded, so the
  classifier does not re-ask it, and the build report lists it under "Market
  holds awaiting human confirmation". The entry stays on the shelf until a
  human records `by: human`.
- `market: false` — clears the name filter and nothing else. No trust tier, no
  skipped gate.

Why the asymmetry: a wrong `true` deletes a working plugin from every user's
view and nothing says so; a wrong `false` lists one competitor on a shelf of
nine thousand. Those costs are not equal.

Why a hold and not a stricter parser: `parseMarketResponse` adopts any name
the batch asked about, and it must — the model may answer a batch in any
order, so there is no positional check to add. But batches are sorted names,
so a package's own description can name its neighbour, and a hostile
description that steers the model into `{"name": "<neighbour>", "market":
true}` used to delist that neighbour permanently. The defence has to be
downstream of the parse, and it is: nothing an LLM says hides anything.

Rows are never pruned, for the reason the memory exists: a name that drops out
of the catalog for a day must not come back unjudged. `categories.yml` prunes
because a stale category costs nothing; a dropped verdict costs a re-ask and,
with it, the chance of a different answer.

## 5. Failure modes

- **Gateway unreachable, or no `LLM_API_KEY`.** `runBatches` swallows the
  outage; every pending name becomes a discard with a reason, keeps the
  heuristic's answer, and is asked again next build. No verdict is invented.
- **Unparseable completion.** `parseMarketResponse` returns nothing for the
  whole batch: a truncated or fenced answer is a discard, never a partial
  read.
- **A `"true"` string, a missing key, an unexpected name.** Dropped. Only a
  real boolean for a name the batch asked about is adopted.
- **A wrong recorded row.** Edit it. `by: human` is never overwritten by the
  classifier, and an existing `by: llm` row is not re-asked either — the file
  is the memory, so correcting it is the interface.

## 6. Operational

The default gateway is `http://8.141.31.123:3000/v1` (`classify.ts:53`, and
the same literal at `.github/workflows/daily.yml:73`) — plaintext, to a bare
IP. Both were re-read on 2026-09-04 when this record was written; the plan that
commissioned it quoted `classify.ts:37` and `daily.yml:41`, which had already
drifted, so cite the literal and re-derive the lines rather than trusting
either number.

An on-path party can read `LLM_API_KEY` from the request and forge verdicts
that the daily bot then commits. Under the amendment above a forged `true` is
only a hold, which is a real reduction in blast radius, but a forged `false`
still shelves a competing market and a read token is still a read token.
**Move the gateway to TLS with a hostname and a verified certificate.** This
is an infrastructure task, not a code change, and it is tracked as an
operational item in
`docs/plans/2026-09-03-audit-fix-b-identity-trust.md`.
