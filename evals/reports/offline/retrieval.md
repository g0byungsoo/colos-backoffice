# Eval report

Mode: offline deterministic adapter and fake embeddings.

Live judge: not run. Offline results measure the deterministic adapter only.

Test set SHA256: bb84b5d64b6994b80ed80a4a6d6e683ab80a54f0d44bd24cddb63163716c2e11

| Retrieval | Recall@1 | Recall@5 | MRR | Status |
|---|---:|---:|---:|---|
| bm25 | 0.9250 | 0.9875 | 0.9750 | measured |
| vector | 0.8625 | 0.9875 | 0.9333 | measured |
| hybrid | 0.9000 | 0.9875 | 0.9625 | measured |
| hybrid with LLM rerank | not run | not run | not run | not run: no live LLM in offline mode |

Scenario pass rate: not run. Empirical pass^1: not run. Money failures: 0.

| Category | Passed | Total | Rate |
|---|---:|---:|---:|

Cost was not calculated. Token usage and elapsed time per scenario are in the JSON report. Scenario tokens sum API-reported usage for completed turns, including intent, phone, nested search embeddings, search reranking and price review. Judge tokens are separate. The standalone retrieval token count covers embeddings only; standalone retrieval reranker usage is not recorded. Calls that fail before returning usage cannot be counted.

## Failures

### bm25 retrieval misses

```json
[
  {
    "id": "R03",
    "query": "What does a driver need at the gate to pick up a box?",
    "relevant_ids": [
      "K02",
      "K12"
    ],
    "filters": {},
    "retrieved_ids": [
      "K02",
      "K03",
      "K05",
      "K10",
      "K01"
    ]
  }
]
```

### vector retrieval misses

```json
[
  {
    "id": "R03",
    "query": "What does a driver need at the gate to pick up a box?",
    "relevant_ids": [
      "K02",
      "K12"
    ],
    "filters": {},
    "retrieved_ids": [
      "K03",
      "K02",
      "K05",
      "K10",
      "K01"
    ]
  }
]
```

### hybrid retrieval misses

```json
[
  {
    "id": "R03",
    "query": "What does a driver need at the gate to pick up a box?",
    "relevant_ids": [
      "K02",
      "K12"
    ],
    "filters": {},
    "retrieved_ids": [
      "K02",
      "K03",
      "K05",
      "K10",
      "K01"
    ]
  }
]
```
