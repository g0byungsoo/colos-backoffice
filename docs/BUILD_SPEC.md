Build a working reference implementation of the Colos system in this repo. Keep going until every item in "Definition of done" passes. If something isn't covered here, pick the simplest option a reviewer could follow in ten minutes, and note it in docs/decisions.md.

## Context

Read README.md and docs/ first. They describe Colos, a small shipping container brokerage my family ran (2021 to 2025; I was the GM and the only engineer): a phone line answered by a voice agent, and a back office that tracked supplier prices, negotiated deals and made invoices. The original code isn't available. This repo should show how I'd build the same system today.

Honesty rules:
- This is a rebuild with synthetic data, not the code that ran at Colos. The README must say so plainly.
- Never invent a result. Every number in the docs (eval scores, latency, cost) must come from a command you ran in this session. If you couldn't run it, say so and show the command.
- Don't edit eval labels, thresholds or seed data to make a check pass. Fix the system, or report the miss.

## How the original worked (keep these rules)

- About 10 to 30 calls a day. Saved numbers rang the owner from 8am to 6pm. Unknown numbers went to the agent at any hour, and from 6pm to 8am the agent took every call.
- The agent did well on short factual calls: is a container ready for pickup at the depot, is a type in stock, and depots or suppliers confirming pickup times. It did badly with existing customers calling about a problem, like a late container or a wrong invoice.
- One shared Google Sheet held weekly inventory and prices, customers and notes. People edited it, code read and wrote it, the agent read it.
- Suppliers change prices weekly, each on its own day, so a scraper ran Monday and Tuesday. The model checked what changed, and code wrote the changes.
- Negotiation by email or phone. An offer that leaves less than $50 over our buying cost gets a hard no: the model judges it, code confirms the math. Any other discount needs the owner's approval.
- The owner approved every invoice. Wire invoices used an Excel template, card invoices went through Stripe.
- Two invoice mistakes got past approval. One skipped a regular customer's discount. One went out on last week's price, before that week's update landed, and lost money.

## What changes in the rebuild

1. Route on why, not only who and when. Look the caller up before anyone speaks.
   - Customer with an open issue: a person during business hours, with a one-line reason whispered first. After hours, the agent takes a message, makes no promises, and creates a priority callback.
   - Saved customer, business hours, nothing open: ring the owner, as before.
   - Depots and suppliers: the agent, any time. That's the kind of call it handled well.
   - Unknown numbers: the agent. It gives general information only until the caller gives an order number and company name that match.
   - In its first turn, the agent sorts the reason for the call into a fixed list that includes not_sure, and hands off when it's a problem with an existing order.
2. Facts come from tools, text comes from retrieval. Prices, stock, pickup status and the caller's account are live lookups against the sheet. Policies, FAQs and customer notes are searched with RAG. The agent never says a price that didn't come back from a pricing tool in the same conversation.
3. The model proposes, code commits. Code enforces the floor (cost + $50), applies discounts from pricing rules, catches stale prices, and decides what needs approval. The model drafts, explains and flags. It never sets a number.
4. Evals. Retrieval quality and agent behavior are measured on a fixed test set before any prompt or model change, and both invoice mistakes are regression tests.

## Stack

- Node.js 22, TypeScript (strict, ESM), npm. Same language as the original, which ran on Vercel.
- OpenAI Agents SDK for TypeScript (@openai/agents) for agents, tools and guardrails, and openai for embeddings. Read the installed packages' types before calling an API. Don't guess signatures.
- googleapis (Sheets API with a service account), zod for every row and every tool's input and output, Hono for HTTP (local and Vercel), vitest, Biome, stripe (test mode), exceljs for the wire invoice, cheerio for supplier pages, twilio for signature checks and TwiML.
- No LangChain, no LlamaIndex, no hosted vector database. The retrieval code should be short enough to read in one sitting.
- Money is integer cents everywhere. Store times in UTC, show them in TIMEZONE.

## Environment

.env.example lists every variable with a one-line comment. Only three are required:
- OPENAI_API_KEY
- GOOGLE_SHEET_ID
- GOOGLE_SERVICE_ACCOUNT_JSON (the key file's JSON, raw or base64), or GOOGLE_APPLICATION_CREDENTIALS with a path to it

Everything else has a default or is optional: OPENAI_MODEL (a current, inexpensive model that's good at tool calling, not gpt-6-astra), OPENAI_JUDGE_MODEL (stronger, used only to grade evals), OPENAI_EMBEDDING_MODEL (text-embedding-3-small), DATA_SOURCE (sheets or local, default sheets), TIMEZONE (America/Los_Angeles), BUSINESS_HOURS (08:00-18:00), OWNER_PHONE, FLOOR_MARGIN_CENTS (5000), STRIPE_SECRET_KEY, TWILIO_AUTH_TOKEN, ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, TOOL_WEBHOOK_SECRET, CRON_SECRET. An optional integration that isn't configured runs in dry-run mode and says so. Nothing crashes for a missing optional key.

## The sheet

npm run seed creates any missing tabs in the sheet, writes bold frozen headers, and fills synthetic rows from data/seed/*.csv. It refuses to overwrite a tab that has data unless given --force. The same CSVs back DATA_SOURCE=local, which tests and evals use so they never touch the live sheet.

Tabs (add columns if you need them):
- Customers: customer_id, company, contact_name, email, created_at
- Phones: phone_e164, party_type (customer, depot, supplier), party_id, label
- Depots: depot_id, name, city, hours
- Suppliers: supplier_id, name, update_weekday, update_time_local, source
- SupplierPrices (append-only): supplier_id, depot_id, container_type, cost_cents, observed_at, source_ref
- PriceList: depot_id, container_type, list_cents, effective_from
- Inventory: container_id, container_type, grade, depot_id, supplier_id, status, ready_for_pickup_at
- Orders: order_id, customer_id, supplier_id, depot_id, container_type, qty, agreed_unit_cents, status, created_at
- Issues: issue_id, customer_id, order_id, kind, status, summary, opened_at
- PricingRules: customer_id, kind (percent or fixed), amount, starts_on, ends_on
- Invoices: invoice_id, order_id, version, list_cents, discount_cents, final_cents, cost_cents, price_observed_at, method, status, stripe_invoice_id, idempotency_key, approved_at
- Approvals: approval_id, kind, ref_id, payload_json, status, requested_at, decided_at
- Outbox: message_id, channel, to, subject, body, status, created_at
- Knowledge: doc_id, title, body_markdown, status (current or superseded), updated_at
- Notes: note_id, customer_id, author, created_at, text
- Calls: call_id, from_e164, route, reason, summary, outcome, started_at
- JobRuns: run_id, job, started_at, finished_at, status, detail

Synthetic data only: made-up company names, 555-01xx phone numbers, example.com emails. About 30 customers, 4 depots, 5 suppliers, 60 containers, 12 knowledge docs (payment terms, pickup rules and release numbers, depot hours, container grades, delivery, damage claims, holds, cancellations), and 150 customer notes. Make retrieval genuinely hard: similar wording across docs, notes that mention other companies by name, and a superseded policy next to the current one.

Writes: append-only for prices, upsert by id for the rest, and re-read before writing so a row someone changed isn't overwritten. Batch reads, cache within a request, and back off on 429s (Sheets allows about 60 requests a minute per user).

## Folders (each maps to a box in the diagrams)

- src/config: env parsing with zod, in one place.
- src/domain: types, schemas and pure functions with no I/O: routing decision, price floor, discount, staleness, invoice math, approval rules. Most unit tests live here.
- src/data: a DataSource interface with SheetsDataSource and LocalDataSource, plus seed and doctor.
- src/rag: chunker (knowledge by heading, one note per chunk), an OpenAI embedder and a deterministic fake one for tests, BM25, vector search, reciprocal rank fusion, and an optional LLM reranker behind a flag. The index lives in .cache/rag/ and rebuilds incrementally by content hash. search() takes filters: notes are only searchable inside the caller's own customer_id, so one customer's notes can never reach another caller, and superseded docs are skipped unless asked for. Each result carries its source id and updated_at.
- src/agents: the phone agent (text version, used by the CLI and evals), the negotiator, and the price-change reviewer. Tools wrap domain and data. An input guardrail catches abuse and instructions hidden in emails. An output guardrail blocks any dollar amount that no pricing tool returned in the same run. Every conversation writes a Calls row and a JSONL log in .logs/ with each turn's tool calls, retrieved ids and timings, so a wrong answer can be traced to a bad search or a bad reply.
- src/backoffice:
  - prices: read supplier pages from fixtures/suppliers/ (two weeks per supplier, plus one page with a changed layout), parse with cheerio, have the reviewer flag odd changes as structured output, append new prices, record a JobRuns row, and alert instead of writing when a parse fails.
  - negotiation: email in, structured offer out. Code decides hard_no, needs_approval or accept. The model drafts the reply inside that decision, the draft goes to Outbox, and discounts go to Approvals.
  - invoices: preview from rules (list price, discount, final price, cost, margin, price date), approve, send. If a supplier's scheduled update has passed since its last price, refresh that supplier first, and refuse if the refresh fails. Block when the margin is under the floor. Card: a Stripe test invoice with an idempotency key. Wire: an .xlsx from a template, written to out/.
- src/phone: the Twilio routing webhook (check the signature when TWILIO_AUTH_TOKEN is set). Person: TwiML Dial to OWNER_PHONE with a whisper of the reason. Agent: hand the call to the ElevenLabs agent through their Twilio register-call endpoint, passing the caller's name and open items as dynamic variables. Server tools for the ElevenLabs agent live under /tools/* behind a shared-secret header and reuse the same tool code as src/agents. Check ElevenLabs' current docs for request and response shapes if you can reach them. If you can't, keep it behind an interface with a mock, and say in the README that it hasn't been tested against a live account.
- src/server: Hono app with /twilio/voice, /tools/*, /cron/prices (CRON_SECRET) and /health (last successful price run and its age). vercel.json with crons for Monday and Tuesday.
- src/cli: the commands below.
- prompts/: every system prompt as a markdown file. Evals load the same files the app loads.

## Commands

- doctor: checks env, the OpenAI key, sheet access, tab headers and optional integrations. On a sheet permission error, print the service account email to share the sheet with.
- seed, index
- chat -- --from +15555550123 [--at 2026-11-10T19:30]: run routing for that caller at that time, then a text conversation with the phone agent, printing tool calls and retrieved sources as they happen.
- negotiate -- <email file>: print the decision and the draft.
- prices:refresh, invoice:preview -- <order_id>, invoice:approve -- <order_id>, invoice:send -- <order_id>
- dev: start the server
- typecheck, lint, test (no network, no keys), build
- eval, eval:retrieval, eval:agent

## Evals

- evals/retrieval.jsonl: 40 labeled queries with the ids that should come back, some with filters. Report recall@1, recall@5 and MRR for bm25, vector, hybrid, and hybrid with rerank, side by side.
- evals/scenarios/: 30 scenarios, each with the caller, the time, scripted user turns and expectations. Cover availability and pickup readiness, a depot confirming a pickup, a price question, a lowball offer, an offer inside the discount band, an upset customer with an open issue, off-topic, abuse, instructions hidden in an email, a caller asking about another company's order, and policy questions that need retrieval, including the superseded-policy trap. Grade with code first (tools called or not, handoff made, numbers match the sheet, nothing below the floor, no other customer's data), then with OPENAI_JUDGE_MODEL against a short rubric that returns pass or fail and a reason. Support --repeat N and report pass^N.
- npm run eval writes evals/reports/latest.md plus JSON: per-category pass rates, failures with transcripts and retrieved ids, and tokens and time per scenario. It exits non-zero if hybrid recall@5 is under 0.90, if the scenario pass rate is under 90%, or if any money check fails even once.
- Both invoice mistakes are also unit tests in src/domain: an invoice for a customer with an active discount rule, and one priced before that supplier's weekly update. Both must be caught.
- CI: .github/workflows/ci.yml runs typecheck, lint, test and build on every push. evals.yml runs npm run eval on demand, and on pull requests when an OPENAI_API_KEY secret exists, and uploads the report.

## Docs

- Keep the existing README write-up word for word with two changes. Replace "The original source code isn't included." with "The original source code isn't included. The code here is a rebuild with synthetic data that shows how I'd build the same system today." Replace the line under Notes with "Figures in the write-up are approximate and from memory. The code is a rebuild with synthetic data. It is not the code that ran at Colos."
- Add a "Reference implementation" section after "What I'd change today": what it is, setup as numbered steps (create a Google Cloud project, enable the Sheets API, create a service account and a JSON key, create a blank sheet, share it with the service account email as an editor, fill .env, then doctor, seed, index, chat), how each folder maps to the two diagrams, the eval results table from a real run, and known limits. Update the repository layout block.
- docs/decisions.md: short entries for tools vs RAG, local hybrid search vs a hosted vector store, LLM intent sorting vs a trained classifier, money rules in code, and Sheets as the source of truth (and what moves to Postgres first). Each entry: the decision, why, and what it costs.
- AGENTS.md: setup, commands, folder ownership, and the writing rules below.
- Writing rules for every doc: plain English, short sentences, no em dashes or en dashes, no double hyphens in prose, no marketing words, no emojis, nothing that sounds AI-written. Match the tone of the existing README.

## Definition of done

1. From a clean clone, npm ci, then npm run typecheck, lint, test and build all pass with no network and no keys.
2. With only the three required variables set: doctor passes, seed fills the sheet, index builds, and chat works for an unknown number, a regular customer during business hours, a customer with an open issue during and after hours, and a depot.
3. negotiate gives a hard no below cost + $50, sends a discount to Approvals, and the model can't change the decision.
4. invoice:preview applies the customer's discount, refreshes or refuses a stale price, and blocks a margin under the floor.
5. eval meets the thresholds, and the README shows the real numbers.
6. No secrets in git. .env, .cache/, .logs/, out/ and node_modules/ are ignored.
7. The README says plainly that this is a rebuild with synthetic data, not the original code.

If a live check needs a key or the sheet and you don't have it, run everything else with DATA_SOURCE=local and list exactly what you didn't run.

Before your first commit, make sure .gitignore covers .env, .cache/, .logs/, out/ and node_modules/. Work in milestones: contracts and domain, data, RAG, agents, back office, phone and server, evals, docs. Run the checks after each one and commit with a short message. Don't push. When you finish, reply with what's done, each command you ran with its result, and anything you couldn't verify.
