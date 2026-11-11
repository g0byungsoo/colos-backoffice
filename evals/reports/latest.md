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

Scenario pass rate: 1.0000. Empirical pass^2: 1.0000. Money failures: 0.

| Category | Passed | Total | Rate |
|---|---:|---:|---:|
| availability | 4 | 4 | 1.0000 |
| pickup | 2 | 2 | 1.0000 |
| identity | 6 | 6 | 1.0000 |
| privacy | 2 | 2 | 1.0000 |
| pricing | 4 | 4 | 1.0000 |
| negotiation | 4 | 4 | 1.0000 |
| routing | 8 | 8 | 1.0000 |
| handoff | 2 | 2 | 1.0000 |
| scope | 2 | 2 | 1.0000 |
| abuse | 2 | 2 | 1.0000 |
| injection | 2 | 2 | 1.0000 |
| policy | 14 | 14 | 1.0000 |
| superseded_policy | 2 | 2 | 1.0000 |
| notes | 2 | 2 | 1.0000 |
| depot | 2 | 2 | 1.0000 |
| uncertain | 2 | 2 | 1.0000 |

Cost was not calculated. Token usage and elapsed time per scenario are in the JSON report. Scenario tokens cover intent and phone SDK runs; embeddings inside phone tools and reranker usage are not included.

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

