# The market judge and `markets.yml` — design

Date: 2026-09-03
Status: describes shipped behaviour. Records the D-7 amendment this document was commissioned for, the `by: human` gate that amendment asked for, and why that gate was reverted the same day (§4).

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
| `config.ts` | shell | derives `notAShop` from the rows; `pipeline.ts` reads `marketRows` for the report line |

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

**The verdict decides. `by` records who judged it.**

- `market: true` — withheld from the shelf, whichever judged it.
- `market: false` — clears the name filter and nothing else. No trust tier,
  no skipped gate.

One classifier pass is accurate enough for the question in §3: it is narrow,
and a name plus a description usually settle it. What the `by` field buys is
review, not authority — `pipeline.ts` puts every `by: llm` withholding in the
build report under "Withheld from the shelf on an LLM verdict alone", because
a recorded row is never re-asked and nothing else would ever surface a wrong
one. Correcting it means editing the row.

### The `by: human` gate that was tried, and why it was wrong

D-7 asked for an LLM `true` to be a HOLD — recorded, but not withholding,
until a human wrote `by: human`. That shipped on 2026-09-04 and was reverted
the same day. Two measurements killed it:

**It advertised what the heuristic had been hiding.** `notAShop` is the
CLEARED list, and the client shows a name that is cleared **or** not shop-like
(`ShopTab.tsx:920-922`). Routing an LLM `true` into `notAShop` therefore did
not "leave the entry shelved pending review" — it cleared the name filter for
it. Of the 17 `market: true, by: llm` rows live at the time, `isShopLike`
matched 16. The hold advertised sixteen competing markets.

**And there is no human.** `verified.yml`, `denied.yml` and
`allowed-similar.yml` are all empty by design: the human-review path is a door
left open for the future, not a process that runs. A hold whose only exit is a
human is not a queue, it is a permanent no-op.

### What D-7's severity actually is

The finding says a steered verdict "removes a competitor for good". Measured
2026-09-04, that overstates it in one direction and understates the real cost
in another.

`isShopLike('dsh-hello-plugin')` and `isShopLike('dsh-fs-tool')` are both
false, and a name that is not shop-like is shown whether or not it is cleared.
So a hostile description that steers the model into
`{"name": "<neighbour>", "market": true}` withholds **nothing** when the
neighbour has an ordinary name. The attack can only bite a victim whose name
already reads like a marketplace — and those are hidden by default anyway.

What it does cost such a victim is the re-ask: the recorded row means the
classifier never asks again, so a plugin like 存茶指南 or 腌菜保存 wrongly
flagged once stays flagged. That is the harm the report line addresses, and it
is why the line exists rather than a stricter parser: `parseMarketResponse`
must accept any name the batch asked about, because the model may answer a
batch in any order, so there is no positional check to add.

Nor is withholding a deletion. `ShopTab.tsx:911` puts it plainly — *not
advertised is not hidden*: a withheld entry is absent from `browsable`, so it
cannot be browsed, searched or counted in the shop, but it stays in
`plugins.json`, an installed copy stays manageable in the installed section,
and `dsh plugin add <name>` still works.

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
that the daily bot then commits. A forged `true` withholds — §4 explains why
that is the policy, and bounds the damage to names that already read like
marketplaces — and a forged `false` shelves a competing market. Either way it
lands in `markets.yml`, is never re-asked, and a read token is still a read
token. The report line surfaces a forged `true`; nothing surfaces a forged
`false`.
**Move the gateway to TLS with a hostname and a verified certificate.** This
is an infrastructure task, not a code change, and it is tracked as an
operational item in
`docs/plans/2026-09-03-audit-fix-b-identity-trust.md`.
