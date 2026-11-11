# Evals

The fixed inputs are [retrieval.jsonl](../evals/retrieval.jsonl) and [scenarios](../evals/scenarios). [run.ts](../evals/run.ts) runs them. [grading.ts](../evals/grading.ts) defines scenarioSchema and gradeCode. This document explains existing evidence. No eval inputs, prompts, thresholds or reports changed during this documentation pass.

## Scenario format and grading

This is the actual [A26 file](../evals/scenarios/A26.json), with only whitespace compacted:

```json
{
  "id": "A26",
  "category": "superseded_policy",
  "caller": "+15555550199",
  "at": "2026-11-11T03:00:00Z",
  "turns": ["Is the unpaid reservation hold seven days?"],
  "expectations": {
    "route": "agent",
    "tools": ["search"],
    "source_ids": ["K07"],
    "excludes": ["holds stock for seven calendar days"]
  }
}
```

Other optional expectations include forbidden_tools, handoff, contains, customer_id and a negotiation decision. Each repetition gets a fresh nonpersistent LocalDataSource. It cannot touch the live sheet. The harness runs the scripted turns, finishes the conversation and grades in this order:

1. `gradeCode` compares route, required and forbidden tools, handoff, reply fragments and retrieved source ids. It checks note ownership and returned search metadata. It tracks successful pricing amounts across turns and checks spoken currency independently of the application guardrail.
2. The harness re-reads source rows. It recomputes inventory counts, order ownership and readiness, effective list price, supplier provenance and freshness, margin floor and negotiation decision. It checks that a discount created an approval, a conversation wrote Calls, and an after-hours issue queued a priority callback. These checks do not merely trust the tool's decision field.
3. In live mode the judge reads [judge.md](../prompts/judge.md), scenario, transcript, initial routing evidence and code failures. It returns pass and reason. A judge pass cannot erase a code failure.

The judge is gpt-5 in the saved live report. GPT-5 model calls use low reasoning effort. A failure or missing judge output fails the scenario. The harness preserves partial evidence if a later operation fails, including money failures from earlier turns.

The full suite exits nonzero when hybrid recall@5 is below 0.90, scenario pass rate is below 0.90, or any money failure occurs. The thresholds are in run.ts and in each full report. A retrieval-only or agent-only run omits the other part's threshold rather than measuring it.

The test-set hash is SHA256 over the raw retrieval JSONL followed by the raw scenario texts in filename order. It does not hash source code, prompts, seed rows or model versions. Both saved full reports contain:

```text
bb84b5d64b6994b80ed80a4a6d6e683ab80a54f0d44bd24cddb63163716c2e11
```

Pass^k is empirical: count scenario ids for which every one of k repetitions passed, then divide by the number of scenario ids. It is not the aggregate pass rate raised to a power. From [live/full.json](../evals/reports/live/full.json), 59/60 runs passed, while 29/30 scenario ids passed both repetitions. These yield 98.33 percent and pass^2 of 0.9667 after rounding. [offline/full.json](../evals/reports/offline/full.json) has 60/60 runs and 30/30 ids, so both values are 1.

## Offline and live

Offline uses `offlineIntent`, direct tool dispatch and FakeEmbedder. It strips the API key from runtime configuration, skips the judge and reports reranking as not run. Live uses the SDK intent and phone agents, OpenAI embeddings and the model judge. The retrieval comparison explicitly includes the model reranker. Application search uses the RAG_RERANK flag instead.

Both modes exercise local synthetic records and the same prompts are loaded where model calls are used. Offline passing says the adapter and deterministic paths worked. It does not predict model behavior or hosted audio behavior. Reports are archived separately by mode and selection. The latest command also overwrites latest.json and latest.md.

## Reading retrieval scores

The corpus has 40 labeled queries in retrieval.jsonl. For each query, the harness requests 20 chunks, deduplicates them to source ids and measures the first source or first 5 sources. Recall is the fraction of labeled relevant ids retrieved, averaged over queries. MRR uses the reciprocal rank of the first relevant source in that returned list, or zero if absent.

One question contributes `1 / 40 = 0.025` to mean recall. A complete success-to-failure change for that question moves recall by 0.025. If a question has two relevant ids, losing one moves mean recall by `0.5 / 40 = 0.0125`. These are calculations from the query count and the formula in run.ts. The report values are not all-or-nothing accuracy on questions.

Hybrid does not beat vector on this set. In live/full.json both have recall@1 of 0.9500 and MRR of 0.9875. Vector recall@5 is 1.0000; hybrid is 0.9875. Hybrid misses K12 for R03, which labels both K02 and K12. The reranked hybrid reaches recall@5 of 1.0000 and MRR of 1.0000, within this small fixed set only.

Hybrid stays as a simple way to combine literal terminology with semantic matching. It avoids calibrating incomparable score scales and keeps the lexical path inspectable. That is an architectural choice, not evidence of a measured win. A larger fixed set could support choosing a different default later. No confidence interval or production accuracy is claimed.

## A26 investigation

The exact failed turn from live/full.json matched the saved local log `.logs/fd46005d-1182-4b8d-856d-092eb09a6228.jsonl` by reply text, tool query and exact response.ms. The log is ignored runtime evidence, not a committed artifact. Its relevant sequence is:

```text
route: agent
error: OutputGuardrailTripwireTriggered
input: Is the unpaid reservation hold seven days?
search first hit: K07#0, current
reply: I could not safely answer. Please ask the owner to confirm.
reason: policy
```

The returned K07 text says an unpaid reservation holds stock until the end of the next business day. It also says a hold does not lock a supplier price. Superseded text did not reach this response. The judge correctly failed the answer because the caller received a deferral despite sufficient retrieved evidence.

The confirmed cause is the output guardrail trip and the phone loop's catch fallback. The blocked model draft is not in the report or JSONL log, so the exact trigger text cannot be confirmed. There is no need to rerun the model to locate the failure stage: the original log survives.

A plausible mechanism is visible in [scanMoney](../src/agents/guardrails.ts). Any use of the word price activates monetary context. In that context, a spelled number such as seven is rejected even when it describes a duration. A direct, read-only invocation of allowedMoney during this documentation pass returned:

| Diagnostic text | allowedMoney with empty amount set and moneyContext false |
|---|---|
| An unpaid reservation holds stock until the end of the next business day. | true |
| No, not seven days. An unpaid reservation holds stock until the end of the next business day. A hold does not lock a supplier price. | false |

These are diagnostic strings, not recovered model output. The second one demonstrates a possible false positive; it does not prove that the failed model draft used those words.

A future fix should distinguish duration language from money amounts while preserving the floor and quote-evidence checks. It should add regression coverage for a policy answer mentioning both a duration and price validity, then rerun the fixed evals. Recording a redacted blocked draft and guardrail reason would make the exact trigger observable. No guardrail, test or prompt was changed in this pass.

## Speed and tokens

All numbers below are computed from [evals/reports/live/full.json](../evals/reports/live/full.json). This is the local text path on gpt-5-mini with low reasoning effort. It is not voice latency, hosted ElevenLabs performance or a cold-start benchmark. No audio, transcription or time-to-first-token measurement is present.

Flatten `scenarios[].transcript[].response` to get 66 turns. Sort response.ms. Median is the middle value, or the mean of the middle pair. p95 uses nearest rank: sorted element at `ceil(0.95 * n) - 1`. Divide milliseconds by 1000 for seconds. Rounded to 3 decimal places, the median is 3.863 s, p95 is 5.905 s and max is 6.420 s.

These include deterministic replies and routes that do not call the model. Turn ms starts after clearing the request cache and ends before the final Calls write and turn log append. It includes intent, phone calls and tools that ran inside the turn. It excludes the eval judge. Scenario ms includes more harness work and judging; do not use it as turn time. The initial after-hours callback can happen before a measured turn.

Token summaries use each repetition's scenario.tokens. Input includes returned intent and phone usage plus captured nested search embeddings, reranking and price review. Output includes returned generated usage. Judge usage is separate. The report does not break cached tokens or reasoning tokens into separate fields. Failed calls that return no usage cannot be counted. Standalone retrievalTokens covers embeddings, not standalone reranker usage.

| Scenario token count | Median | p95 | Max | Sum |
|---|---:|---:|---:|---:|
| Input | 1968.5 | 3659 | 3944 | 100045 |
| Output | 248 | 486 | 574 | 13813 |
| Input plus output | 2113.5 | 4118 | 4364 | 113858 |

The rows summarize all 60 scenario repetitions. Each total is computed per repetition before taking its percentile. Judge sums, computed separately from scenario.judgeTokens, are 46311 input and 19437 output. Dollar cost is not computed.

### Tokens for each scenario

The table reads scenario.tokens for repetitions 1 and 2 from live/full.json. Each cell is input / output. There is no averaging across repetitions.

| Scenario | Repetition 1 | Repetition 2 |
|---|---:|---:|
| A01 | 1771 / 122 | 1770 / 117 |
| A02 | 1759 / 132 | 1777 / 146 |
| A03 | 1982 / 105 | 1987 / 116 |
| A04 | 993 / 114 | 993 / 154 |
| A05 | 3915 / 395 | 3944 / 420 |
| A06 | 3659 / 459 | 3689 / 486 |
| A07 | 1112 / 247 | 1112 / 229 |
| A08 | 1774 / 284 | 1770 / 250 |
| A09 | 1773 / 188 | 1773 / 221 |
| A10 | 2374 / 422 | 2356 / 574 |
| A11 | 2336 / 480 | 2350 / 427 |
| A12 | 0 / 0 | 0 / 0 |
| A13 | 318 / 46 | 318 / 60 |
| A14 | 0 / 0 | 0 / 0 |
| A15 | 0 / 0 | 0 / 0 |
| A16 | 2179 / 335 | 2189 / 322 |
| A17 | 993 / 556 | 993 / 564 |
| A18 | 0 / 0 | 0 / 0 |
| A19 | 0 / 0 | 0 / 0 |
| A20 | 2189 / 263 | 2230 / 257 |
| A21 | 2261 / 314 | 2241 / 285 |
| A22 | 2255 / 307 | 2235 / 320 |
| A23 | 2222 / 311 | 2228 / 255 |
| A24 | 2192 / 277 | 2201 / 281 |
| A25 | 2160 / 289 | 2145 / 249 |
| A26 | 2206 / 223 | 2193 / 210 |
| A27 | 2164 / 269 | 2165 / 259 |
| A28 | 2416 / 267 | 2514 / 363 |
| A29 | 1914 / 210 | 1955 / 240 |
| A30 | 1000 / 189 | 1000 / 204 |

### Time inside tools

Flatten each turn's toolCalls and group by name. The table applies the same median, nearest-rank p95 and max calculation to tool.ms, rounded to 3 decimal places. Counts are observed calls in transcripts, not invocation quotas. They exclude initial route-side callbacks outside those transcripts.

| Tool | Calls | Median ms | p95 ms | Max ms |
|---|---:|---:|---:|---:|
| availability | 4 | 2.656 | 4.420 | 4.420 |
| handoff | 4 | 1.034 | 1.446 | 1.446 |
| negotiate_offer | 4 | 2345.875 | 2451.359 | 2451.359 |
| pickup_confirmation | 2 | 1.578 | 1.984 | 1.984 |
| pickup_status | 4 | 2.606 | 3.248 | 3.248 |
| pricing | 4 | 3.060 | 4.261 | 4.261 |
| search | 18 | 266.836 | 427.629 | 427.629 |
| verify_identity | 8 | 1.693 | 3.644 | 3.644 |

Tool ms measures the whole handler, including local reads, validation and any nested model calls. The negotiation handler may refresh stale supplier fixtures and run price review. Search includes index work and query embedding. The table does not isolate network time or prove that a particular nested call caused a slow sample.

### Reproduce the summaries without changing reports

```python
import json, math, statistics
from collections import defaultdict

r = json.load(open("evals/reports/live/full.json"))
turns = [t["response"] for s in r["scenarios"] for t in s["transcript"]]

def summary(values):
    values = sorted(values)
    return len(values), statistics.median(values), values[math.ceil(.95 * len(values)) - 1], max(values), sum(values)

print("turn ms", summary([t["ms"] for t in turns]))
for field in ("input", "output"):
    print(field, summary([s["tokens"][field] for s in r["scenarios"]]))
print("total", summary([sum(s["tokens"].values()) for s in r["scenarios"]]))
by_tool = defaultdict(list)
for turn in turns:
    for call in turn["toolCalls"]:
        by_tool[call["name"]].append(call["ms"])
for name, values in sorted(by_tool.items()):
    print(name, summary(values))
for s in r["scenarios"]:
    print(s["id"], s["repetition"], s["tokens"])
print("judge", {k: sum(s["judgeTokens"][k] for s in r["scenarios"]) for k in ("input", "output")})
```
