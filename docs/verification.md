# Verification

These checks ran in this session on 2026-11-11. They use synthetic data. OpenAI was the only configured external service. Google Sheets, payment delivery and voice calls remain unverified.

## Install and offline checks

A fresh local clone used Node.js 22.23.4. It had no .env file or service credentials. The install used the existing npm cache with npm offline mode enabled. Tests block network requests even when the working checkout has credentials.

| Command | Result |
|---|---|
| `npm install` | Passed while completing the shared contracts |
| `node --version` | v22.23.4 |
| `npm ci` | Exit 0 in the clean clone using the local npm cache |
| `npm run typecheck` | Exit 0 |
| `npm run lint` | Exit 0 |
| `npm test` | Exit 0: 134 tests passed across 15 files |
| `npm run build` | Exit 0 |
| `npm audit --omit=dev` | No vulnerabilities reported |
| `git check-ignore .env .cache/test .logs/test out/test node_modules/test` | All paths ignored |
| Git tracked-file and history scan | No tracked runtime artifacts or credential patterns found |
| SHA256 comparison of seed data and eval inputs | All 48 files unchanged |
| Historical README and diagram comparison | Only the permitted README changes; diagrams unchanged |

The tests include the skipped customer discount and stale supplier price regressions. They also cover a discount that breaches the floor, edits made before a write, failed price parsing, partial price writes, invoice retries, webhook authentication, account isolation and false claims after failed actions.

## CLI checks with local data

Every successful command below exited with zero. The stale preview and repeated seed exited with one as expected. The API key was set unless the command used the offline flag.

| Command | Result |
|---|---|
| `DATA_SOURCE=local npm run doctor` | OpenAI model access passed; synthetic headers and rows validated; absent integrations reported dry run |
| `DATA_SOURCE=local npm run seed -- --offline` | Created all 17 local tabs |
| `DATA_SOURCE=local npm run index -- --offline` | Loaded 168 chunks with the fake embedder |
| `DATA_SOURCE=local npm run index` | Loaded the OpenAI embedding index |
| `DATA_SOURCE=local RUNTIME_DIR=.cache/fresh-index-verification npm run index` | Built a fresh index: 168 chunks embedded through text-embedding-3-small |
| `DATA_SOURCE=local npm run chat -- --from +15555550199 --at 2026-11-10T19:30:00Z` | Unknown caller asked about 20GP stock at D01; availability tool returned 12 and the reply matched |
| `DATA_SOURCE=local npm run chat -- --from +15555550101 --at 2026-11-10T19:30:00Z` | Saved customer routed to owner |
| `DATA_SOURCE=local npm run chat -- --from +15555550102 --at 2026-11-10T19:30:00Z` | Open issue routed to owner with its reason |
| `DATA_SOURCE=local npm run chat -- --from +15555550102 --at 2026-11-11T03:00:00Z` | Priority callback recorded; no resolution time promised |
| `DATA_SOURCE=local npm run chat -- --from +15555550181 --at 2026-11-10T19:30:00Z` | Depot pickup confirmation recorded for review |
| `DATA_SOURCE=local npm run prices:refresh -- --at 2026-11-11T19:00:00Z` | Live model review passed for the fixtures; appended 8 observations for each of 5 suppliers |
| `DATA_SOURCE=local npm run negotiate -- fixtures/emails/lowball.txt --at 2026-11-11T19:00:00Z` | hard_no; draft written to Outbox |
| `DATA_SOURCE=local npm run negotiate -- fixtures/emails/discount.txt --at 2026-11-11T19:00:00Z` | needs_approval; approval and draft created |
| `DATA_SOURCE=local npm run invoice:preview -- O001 --method wire --at 2026-11-11T19:00:00Z` | Applied the active discount and current cost |
| `DATA_SOURCE=local npm run invoice:approve -- O001 --method wire --at 2026-11-11T19:00:00Z` | Approved the unchanged preview |
| `DATA_SOURCE=local npm run invoice:send -- O001 --method wire --at 2026-11-11T19:00:00Z` | Created out/INV-O001-1.xlsx and queued a message; delivery remained dry run |
| `DATA_SOURCE=local npm run invoice:preview -- O001 --method card --at 2026-11-11T19:00:00Z` | Preview passed |
| `DATA_SOURCE=local npm run invoice:approve -- O001 --method card --at 2026-11-11T19:00:00Z` | Approval passed |
| `DATA_SOURCE=local npm run invoice:send -- O001 --method card --at 2026-11-11T19:00:00Z` | Explicit dry run; no Stripe invoice created |
| `DATA_SOURCE=local npm run invoice:preview -- O001 --offline --at 2026-11-18T19:00:00Z` | Exit 1: stale supplier snapshot refused |
| `DATA_SOURCE=local npm run seed -- --offline` on populated local data | Exit 1: refused to overwrite Customers |
| `DATA_SOURCE=local npm run dev` | Started local HTTP server; stopped after the smoke check |
| `curl --fail --silent http://localhost:3000/health` | Returned status ok and the last successful price run |

The wire preview returned list 280000 cents, discount 14000 cents, final 266000 cents, cost 202000 cents and margin 64000 cents. The low offer was 200000 cents against a floor of 207000 cents. The discount offer was 220000 cents and required approval. These values came from the commands above.

The unsigned voice endpoint returned inert dry-run TwiML. Unauthenticated tool and cron requests returned 401. Unit tests exercise signed requests and the mock voice bridge. No real phone call, payment or email was sent.

## Evals

| Command | Result |
|---|---|
| `DATA_SOURCE=local npm run eval -- --offline --repeat 2` | 60 of 60 scenario runs passed (100.00%). Empirical pass^2 was 1.0000. There were 0 money failures. |
| `DATA_SOURCE=local npm run eval -- --repeat 2` | 59 of 60 scenario runs passed (98.33%). Empirical pass^2 was 0.9667. There were 0 money failures. |

Both commands exited with zero. The separate commands `DATA_SOURCE=local npm run eval:retrieval -- --offline` and `DATA_SOURCE=local npm run eval:agent -- --offline` also exited with zero and passed their checks. The live run used gpt-5-mini, text-embedding-3-small and the gpt-5 judge. The offline run used fake embeddings and skipped the model judge and reranker. Both runs used the same fixed test-set hash.

Live retrieval:

| Retrieval | Recall@1 | Recall@5 | MRR |
|---|---:|---:|---:|
| bm25 | 0.9250 | 0.9875 | 0.9750 |
| vector | 0.9500 | 1.0000 | 0.9875 |
| hybrid | 0.9500 | 0.9875 | 0.9875 |
| hybrid with LLM rerank | 0.9750 | 1.0000 | 1.0000 |

Offline retrieval:

| Retrieval | Recall@1 | Recall@5 | MRR |
|---|---:|---:|---:|
| bm25 | 0.9250 | 0.9875 | 0.9750 |
| vector | 0.8625 | 0.9875 | 0.9333 |
| hybrid | 0.9000 | 0.9875 | 0.9625 |
| hybrid with LLM rerank | not run | not run | not run |

The individual retrieval misses remain in the JSON reports. Scenario transcripts include tool calls and retrieved ids. Per-category results are in the readable reports. Costs and voice latency were not measured. The JSON describes which returned token counts are included; standalone retrieval reranker usage is not counted.

See the [live report](../evals/reports/live/full.md), [live JSON](../evals/reports/live/full.json), [offline report](../evals/reports/offline/full.md) and [offline JSON](../evals/reports/offline/full.json).

Failed live runs retained in the report: A26 repetition 2. It retrieved the current hold policy from K07, then deferred to the owner instead of answering.

## Checks waiting on credentials

No Google Sheet id or service account was available. Create a blank sheet and share it with the service account as an editor. Set GOOGLE_SHEET_ID and either GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS, then run:

```sh
DATA_SOURCE=sheets npm run doctor
DATA_SOURCE=sheets npm run seed
DATA_SOURCE=sheets npm run index
DATA_SOURCE=sheets npm run chat -- --from +15555550199 --at 2026-11-10T19:30:00Z
DATA_SOURCE=sheets npm run chat -- --from +15555550101 --at 2026-11-10T19:30:00Z
DATA_SOURCE=sheets npm run chat -- --from +15555550102 --at 2026-11-10T19:30:00Z
DATA_SOURCE=sheets npm run chat -- --from +15555550102 --at 2026-11-11T03:00:00Z
DATA_SOURCE=sheets npm run chat -- --from +15555550181 --at 2026-11-10T19:30:00Z
```

These sheet commands were not run. The same caller cases passed against local data. No sheet permission or formatting result is claimed.

No STRIPE_SECRET_KEY was available. Set a Stripe test key, then repeat the card commands above. Invoice creation, idempotency against Stripe and test delivery were not checked against an account.

No TWILIO_AUTH_TOKEN, OWNER_PHONE, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, TOOL_WEBHOOK_SECRET or CRON_SECRET was available. Set them and run `DATA_SOURCE=local npm run dev` behind a public HTTPS URL. Configure Twilio to post to `/twilio/voice` and configure the hosted agent's tools and transfers. Place calls for the caller cases above. Live signatures, owner dialing, audio and mid-call transfers were not tested. A curl request cannot prove that path.

For a configured cron endpoint, use `curl --fail -H "Authorization: Bearer $CRON_SECRET" https://YOUR_HOST/cron/prices`. That deployed check was not run. Vercel deployment and remote GitHub workflows were also not run. Nothing was pushed.

Production use still needs durable billing state, actual supplier fetchers, stronger caller verification, hosted voice controls and persistent storage for generated files.
