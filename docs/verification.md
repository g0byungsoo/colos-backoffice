# Verification

These checks were run during the rebuild session. No live service credentials were available. Local runs used synthetic data. The runtime reported Node.js 26.3.0. The installed executable path named node@22 reported the same version, so Node.js 22 remains a CI check to verify.

## Build and tests

| Command | Result |
|---|---|
| `npm ci --offline` | Passed using the populated npm cache |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | Passed: 77 tests in 9 source test files |
| `npm run build` | Passed |
| `npx vitest run src/domain src/data` | Passed: 18 tests |
| `npx vitest run src/rag evals/grading.test.ts` | Passed: 7 tests |
| `npx vitest run src/server` | Passed: 3 tests |
| `npx biome check . --write` | Applied formatting; final lint passed |

The same install, typecheck, lint, test and build commands also passed in a fresh local git clone with service credentials removed. Installation used the existing npm cache and the offline option. No live sheet or model was used.

An early lint run found formatting errors. Those were fixed. The first eval missed a depot gate intent. The classifier was fixed without changing labels. An intermediate test run counted compiled tests from dist as well as source tests. The final Vitest configuration includes only source tests.

## Local commands

| Command | Result |
|---|---|
| `DATA_SOURCE=local npm run doctor` | Passed; optional integrations reported dry run |
| `DATA_SOURCE=local npm run seed` | Passed on the empty local store |
| `DATA_SOURCE=local npm run seed` repeated | Refused populated data as required |
| `DATA_SOURCE=local npm run index` | Passed; fake index contained 168 chunks |
| `DATA_SOURCE=local npm run chat -- --from +15555550199 --at 2026-11-10T19:30:00Z` | Exit 0: Agent route; availability tool returned stock |
| `DATA_SOURCE=local npm run chat -- --from +15555550101 --at 2026-11-10T19:30:00Z` | Exit 0: Owner route for a saved customer |
| `DATA_SOURCE=local npm run chat -- --from +15555550102 --at 2026-11-10T19:30:00Z` | Exit 0: Owner route with open issue reason |
| `DATA_SOURCE=local npm run chat -- --from +15555550102 --at 2026-11-11T03:00:00Z` | Exit 0: Priority callback recorded; no resolution promised |
| `DATA_SOURCE=local npm run chat -- --from +15555550181 --at 2026-11-10T19:30:00Z` | Exit 0: Agent recorded depot pickup confirmation |
| `DATA_SOURCE=local npm run negotiate -- fixtures/emails/lowball.txt --at 2026-11-11T19:00:00Z` | Exit 0: hard_no; draft written to Outbox |
| `DATA_SOURCE=local npm run negotiate -- fixtures/emails/discount.txt --at 2026-11-11T19:00:00Z` | Exit 0: needs_approval; approval and draft created |
| `DATA_SOURCE=local npm run prices:refresh -- --at 2026-11-11T19:00:00Z` | Exit 0: Successful synthetic refresh |
| `DATA_SOURCE=local npm run invoice:preview -- O001 --at 2026-11-11T19:00:00Z` | Exit 0: Preview applied active discount and current cost |
| `DATA_SOURCE=local npm run invoice:approve -- O001 --at 2026-11-11T19:00:00Z` | Exit 0: Approved the unchanged preview |
| `DATA_SOURCE=local npm run invoice:send -- O001 --at 2026-11-11T19:00:00Z` | Exit 0: Created wire workbook; email delivery remained dry run |
| `DATA_SOURCE=local npm run invoice:preview -- O001 --at 2026-11-18T19:00:00Z` | Refused stale supplier snapshot as required |
| `DATA_SOURCE=local npm run invoice:preview -- O001 --method card --at 2026-11-11T19:00:00Z` | Passed |
| `DATA_SOURCE=local npm run invoice:approve -- O001 --method card --at 2026-11-11T19:00:00Z` | Passed |
| `DATA_SOURCE=local npm run invoice:send -- O001 --method card --at 2026-11-11T19:00:00Z` | Explicit dry run; no Stripe invoice created |
| `DATA_SOURCE=local npm run dev` | Started local HTTP server; stopped after smoke check |
| `curl --fail --silent http://localhost:3000/health` | Returned status ok and last successful price run |
| `git check-ignore .env .cache/test .logs/test out/test node_modules/test` | All paths ignored |

The wire preview returned list 280000 cents, discount 14000 cents, final 266000 cents and supplier cost 202000 cents. Workbook totals are also checked by a unit test. No live payment or email was sent.

## Evals

| Command | Result |
|---|---|
| `npm run eval:retrieval -- --offline` | Passed hybrid recall threshold |
| `npm run eval:agent -- --offline` | Passed scenario and money checks |
| `npm run eval -- --offline --repeat 2` | Passed: 60 of 60 scenario runs; pass^2 1.0000; no money failures |

Hybrid recall@5 was 0.9875. Reports preserve the individual retrieval miss. See evals/reports/latest.md and latest.json for the full results, source ids, transcripts and measured times. Embeddings were fake. The model judge and model reranker were skipped. Dollar cost and voice latency were not measured.

## Not run

The following need credentials or an external environment:

- Live OpenAI model access: set the key and run `npm run doctor`.
- Live Sheets access, header checks and writes: set the sheet id and service account, then run `npm run doctor` and `npm run seed` with the default Sheets data source.
- Live embeddings and agent: run `npm run index` and `npm run chat` with the API key. Repeat each caller route shown above.
- Live model evals, judge and reranker: run `npm run eval -- --repeat 2` with the API key. Evals still use local synthetic records.
- Stripe test invoice creation and delivery: set STRIPE_SECRET_KEY and repeat the card preview, approval and send commands.
- Twilio signatures against real requests, owner dialing and ElevenLabs audio: configure the optional phone variables, deploy the webhook, configure the hosted agent and place test calls. Unit tests cover missing secrets, invalid signatures and a mock bridge only.
- Vercel deployment and CI on Node.js 22. The entry point and workflow files are present, but no deployment or remote workflow was triggered.

Production use also needs durable billing state, a real supplier fetcher, stronger caller verification, hosted voice controls and storage for generated files. These are documented limits, not completed live checks.
