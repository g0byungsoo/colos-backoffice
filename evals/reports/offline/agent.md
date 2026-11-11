# Eval report

Mode: offline deterministic adapter and fake embeddings.

Live judge: not run. Offline results measure the deterministic adapter only.

Test set SHA256: bb84b5d64b6994b80ed80a4a6d6e683ab80a54f0d44bd24cddb63163716c2e11

| Retrieval | Recall@1 | Recall@5 | MRR | Status |
|---|---:|---:|---:|---|

Scenario pass rate: 1.0000. Empirical pass^1: 1.0000. Money failures: 0.

| Category | Passed | Total | Rate |
|---|---:|---:|---:|
| availability | 2 | 2 | 1.0000 |
| pickup | 1 | 1 | 1.0000 |
| identity | 3 | 3 | 1.0000 |
| privacy | 1 | 1 | 1.0000 |
| pricing | 2 | 2 | 1.0000 |
| negotiation | 2 | 2 | 1.0000 |
| routing | 4 | 4 | 1.0000 |
| handoff | 1 | 1 | 1.0000 |
| scope | 1 | 1 | 1.0000 |
| abuse | 1 | 1 | 1.0000 |
| injection | 1 | 1 | 1.0000 |
| policy | 7 | 7 | 1.0000 |
| superseded_policy | 1 | 1 | 1.0000 |
| notes | 1 | 1 | 1.0000 |
| depot | 1 | 1 | 1.0000 |
| uncertain | 1 | 1 | 1.0000 |

Cost was not calculated. Token usage and elapsed time per scenario are in the JSON report. Scenario tokens sum API-reported usage for completed turns, including intent, phone, nested search embeddings, search reranking and price review. Judge tokens are separate. The standalone retrieval token count covers embeddings only; standalone retrieval reranker usage is not recorded. Calls that fail before returning usage cannot be counted.

## Failures
