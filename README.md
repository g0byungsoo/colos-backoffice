# Colos: phone agent and back office architecture

Architecture notes for the software behind Colos, a small shipping container brokerage my family ran. From 2021 to 2025 I was its general manager and its only engineer. As staff left and weren't replaced, I rebuilt their work in software: answering the phone, tracking inventory and supplier prices, handling price negotiation, and invoicing. By the end, the system covered roughly four people's work.

This repository documents the design, the trade-offs, and what broke. The original source code isn't included. The code here is a rebuild with synthetic data that shows how I'd build the same system today.

## System at a glance

- **Phone.** About 10 to 30 calls a day. A routing rule sent known customers to my phone during business hours. Every other call went to a voice agent on ElevenLabs' agent platform, with an OpenAI model writing the replies.
- **Data.** One shared Google Sheet held weekly inventory and prices, customer details, and notes. People edited it, my code read and wrote it through the Google Sheets API, and the agent read it. HubSpot was added later as the CRM.
- **Back office.** Node.js on Vercel. A cron job scraped supplier prices, and an OpenAI model handled the language work: checking price changes, negotiating, researching buyers, and suggesting suppliers.
- **Money.** Code enforced a price floor. Discounts and every invoice went through me. Wire invoices used the company's existing Excel template; card invoices went out through Stripe.

## Phone agent

![Colos phone agent architecture](docs/diagrams/colos-phone-agent-architecture.png)

**Routing.** Calls from saved numbers rang my phone from 8am to 6pm. Unknown numbers went to the agent at any hour, and from 6pm to 8am the agent took every call.

**The agent.** The agent ran on ElevenLabs' platform, on a Twilio number. ElevenLabs handled speech to text, turn-taking, and text to speech, and an OpenAI model wrote each reply. I configured the model with instructions and reference documents, and it read the shared sheet for inventory and customer notes.

**What worked.** Short, factual calls and emails: whether a container was ready for pickup at the depot, whether we had one in stock, and depots or suppliers confirming pickup times.

**What didn't.** Existing customers calling about a problem, like a late container or a wrong invoice. They were already upset, and the agent could explain but couldn't fix anything, so they got angrier and some complained. In the end I routed calls back to my phone.

**The lesson.** The routing rule knew who was calling and when, but not why. A customer with an open problem who called after 6pm, or from an unsaved number, still reached the agent. Today I'd look the caller up first and send anyone with an open order or problem to a person, with a summary on screen.

## Back office

![Colos back office architecture](docs/diagrams/colos-backoffice-architecture.png)

**Prices.** Suppliers changed prices weekly, each on its own day, so a cron job scraped their sites on Monday and Tuesday. The model checked what changed, and code updated inventory and prices in the sheet.

**Deals.** Customers negotiated by email or phone, and the model handled the back and forth. An offer that left less than $50 over our buying cost got a hard no: the model judged it, and code checked the math. Any other discount needed my approval. The model also researched companies that placed orders and suggested which supplier should fill each one.

**Invoices.** I triggered or approved every invoice. Wire invoices used the company's existing Excel template, filled with the customer's details and the order's line items. Card invoices were created through the Stripe API.

## Design decisions

| Decision | What it bought | What it cost |
|---|---|---|
| ElevenLabs' agent platform instead of a custom voice pipeline | Listening, turn-taking, voice, and telephony in one place, run by one engineer | Less control over each stage, and no per-stage latency numbers on my side |
| Route on caller and time of day | Known customers reached a person during business hours, and every other call still got answered | The rule knew who and when, not why |
| One shared Google Sheet | Anyone could read and fix it, version history came free, and the API was simple | No schema or row locking, and nothing checked how old a price was |
| Model negotiates, code enforces the floor | Natural back and forth without a rule for every phrasing, and no discount below the floor | The floor is only as good as the cost data behind it |
| Human approval on every invoice | Nothing went out unseen | I was the bottleneck, and approval missed both invoice errors |
| Scheduled scraping, Monday and Tuesday | No manual price entry, with runs timed to supplier updates | Prices go stale between a supplier's change and the next run, and site changes break scrapers |

## What broke

1. **Upset callers.** Described above.
2. **Stale prices.** An invoice went out before that week's price update landed. It used last week's price, and we lost money on the order.
3. **A skipped discount.** Regular customers got a slightly lower price. One invoice skipped that step and went out at full price.

Both invoice errors passed my approval. Approval can't catch what the approver can't see. The checks belong in code, before a person reviews, and the review screen should show the numbers that tend to go wrong. The same weak spot sat under the $50 floor: it compared against our cost, and that cost was only as fresh as the last scrape.

## What I'd change today

- **Route on why.** Look the caller up before the agent speaks. Anyone with an open order or problem goes to a person, with a summary on screen.
- **A real source of truth.** Move the data into Postgres, put a date on every price, and keep a spreadsheet view for people.
- **Invoices built from rules.** Apply each customer's discount in code, refuse stale prices, and approve a preview that shows list price, discount, final price, and the price date.
- **Exactly-once billing.** Send every Stripe create with an idempotency key, and reconcile against Stripe nightly.
- **Measure the voice path.** Log end of turn, transcription, first token, and first audio on every call, and track p95 latency, transfers, callbacks, and complaints.
- **Evals.** Turn rejected drafts and complaint calls into a test set that runs before every prompt or model change.

## Reference implementation

The code below is a working reference built from the account above. All customers, orders, notes and supplier pages are synthetic. It is not the code that ran at Colos. The original diagrams describe the old system. The rebuild adds intent routing, isolated retrieval, rule-based invoices and evals.

### Setup

1. Install Node.js 22 and run `npm ci` from this directory.
2. Create a Google Cloud project and enable the Google Sheets API.
3. Create a service account and download its JSON key.
4. Create a blank Google Sheet.
5. Share the sheet with the service account email as an editor.
6. Copy `.env.example` to `.env`. Set `OPENAI_API_KEY`, `GOOGLE_SHEET_ID`, and `GOOGLE_SERVICE_ACCOUNT_JSON`. The JSON can be raw or base64. A key file path in `GOOGLE_APPLICATION_CREDENTIALS` can replace the JSON value.
7. Run `npm run doctor`. It checks model access, sheet access, headers and integration configuration. Missing tabs are expected before seeding. A permission error prints the email to share with.
8. Run `npm run seed`, then `npm run index`. Seed creates tabs with bold, frozen headers. It refuses populated tabs unless explicitly forced.
9. Run `npm run chat -- --from +15555550199 --at 2026-11-10T19:30:00Z`. Ask whether 20GP containers are available in D01. Tool calls and sources print as they happen. Type `/quit` to leave.

For a walkthrough without accounts, set `DATA_SOURCE=local` and leave the API key unset. Run the same commands. This uses a deterministic text adapter and fake embeddings. Local writes go to `.cache/local`; the CSVs stay unchanged. Tests and evals always use isolated local data, even when a sheet is configured.

Try saved customer `+15555550101`, customer with an open issue `+15555550102`, and depot `+15555550181`. Use `2026-11-10T19:30:00Z` for business hours and `2026-11-11T03:00:00Z` for after hours. Unknown callers can verify with order `O001` and company `Alder Wharf Works`.

The fixtures capture a fixed week. Price refresh preserves the captured date. After the next scheduled update, an invoice refuses the old snapshot. Use the recorded date for a repeatable review:

```sh
DATA_SOURCE=local npm run prices:refresh -- --at 2026-11-11T19:00:00Z
DATA_SOURCE=local npm run negotiate -- fixtures/emails/lowball.txt --at 2026-11-11T19:00:00Z
DATA_SOURCE=local npm run negotiate -- fixtures/emails/discount.txt --at 2026-11-11T19:00:00Z
DATA_SOURCE=local npm run invoice:preview -- O001 --at 2026-11-11T19:00:00Z
DATA_SOURCE=local npm run invoice:approve -- O001 --at 2026-11-11T19:00:00Z
DATA_SOURCE=local npm run invoice:send -- O001 --at 2026-11-11T19:00:00Z
```

Preview applies the active discount and binds approval to the reviewed facts. Send checks those facts again. Wire output goes to `out/`. Add `--method card` to each invoice command for Stripe test mode. Without a Stripe key, send reports a dry run and creates no Stripe invoice. Email drafts and callbacks stay in Outbox; no email sender is connected.

### Code and diagrams

| Diagram box | Implementation |
|---|---|
| Routing rule, owner phone | `src/domain/routing.ts`, `src/phone`, `src/server` |
| ElevenLabs agent, OpenAI model | `src/agents`, `prompts`, shared tools under `/tools/*` |
| Documents and customer notes | `src/rag`, added to the phone path |
| Google Sheet | `src/data`, row schemas in `src/domain` |
| Supplier websites and scraper | `fixtures/suppliers`, `src/backoffice/prices.ts` |
| Price review and negotiation models | `src/agents/price-reviewer.ts`, `src/agents/negotiator.ts` |
| Price rules and owner approval | `src/domain/pricing.ts`, `src/backoffice` |
| Wire and card invoices | `src/backoffice/invoices.ts`, `fixtures/invoices` |
| Shared configuration and local controls | `src/config`, `src/cli` |
| Measurement added to both diagrams | `evals`, unit tests, `.logs` |

`npm run dev` starts Hono. `/health` reports the last successful price run and its age. `/cron/prices` requires a bearer `CRON_SECRET`. `/tools/*` requires `x-tool-secret` and a signed call token created by the routing webhook. Missing secrets disable remote writes. When configured, Twilio signatures are checked against the incoming URL. Configure Twilio with the exact public webhook URL.

The Vercel entry point is `api/index.ts`. Cron runs on Monday and Tuesday in UTC. `vercel.json` includes prompts and fixtures. On Vercel, temporary files go under `/tmp/colos`. Persist logs and generated invoices elsewhere before relying on a deployment.

### Measured evals

The table comes from `npm run eval -- --offline --repeat 2` in this session. It uses the fixed retrieval labels and scenario files. The report records their hash. No labels, thresholds or seed rows were changed to improve a score.

| Retrieval | Recall@1 | Recall@5 | MRR |
|---|---:|---:|---:|
| bm25 | 0.9250 | 0.9875 | 0.9750 |
| vector | 0.8625 | 0.9875 | 0.9333 |
| hybrid | 0.9000 | 0.9875 | 0.9625 |
| hybrid with LLM rerank | not run | not run | not run |

All 60 scenario runs passed across 30 scenarios repeated twice. Empirical pass^2 was 1.0000. There were no money failures. Hybrid recall@5 exceeded the required 0.90. The report keeps the retrieval miss visible rather than hiding it behind the aggregate score.

These are offline adapter results. They do not establish live model accuracy. OpenAI embeddings, the model judge and the model reranker were not run. Cost was not calculated. Actual elapsed times and token fields are in [the JSON report](evals/reports/latest.json). Per-category results and misses are in [the readable report](evals/reports/latest.md). Run `npm run eval` with an API key to measure the live path. `eval:retrieval` and `eval:agent` run the parts separately.

### Known limits

- Live OpenAI, Google Sheets, Stripe, Twilio and ElevenLabs checks were not run because credentials were absent. Local doctor, seed, index, caller routes, negotiation and invoice commands were exercised. See [verification](docs/verification.md) for commands and results.
- The available runtime reported Node.js 26.3.0, including the installed path named node@22. Local checks passed there. CI requests Node.js 22, but that CI run has not been observed.
- Sheets re-reads detect edits but cannot make the final read and write atomic. Local files also need a single writer. Billing needs durable transactions before production use.
- Supplier pages are fixtures, not live scrapers. Captured prices expire. The email offer parser requires explicit headers. Approved negotiations require an owner to update the pricing rule before invoicing.
- The ElevenLabs adapter follows its [register-call documentation](https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/twilio/register-call), but has not been tested against a live account. The hosted voice agent still needs its prompts, tools, transfer behavior and output checks configured. Local text guardrails cannot intercept hosted audio.
- Phone handoff records a callback request. Initial known-customer routing can dial the owner with a whisper. Mid-call voice transfers need the hosted agent's transfer configuration.
- Currency guardrails use conservative text checks. They are a second check after tool access, not proof that arbitrary model language is safe. The fixed evals and live review remain necessary.
- The wire template is synthetic, contains no bank details and labels its amounts in cents. Sending it prepares a file and queues a message. It does not deliver email. Vercel files are temporary.
- The default text model is `gpt-5.4-mini`, based on the [official model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini). Model access and behavior still need a live check. Configuration can select another model after evals.

See [decisions](docs/decisions.md) for scope choices and their costs.

## Stack

ElevenLabs agent platform, Twilio, OpenAI API, Node.js on Vercel, Google Sheets API, HubSpot, Stripe.

## Repository layout

```text
.
├── src/
│   ├── config/       # Environment parsing
│   ├── domain/       # Schemas and pure rules
│   ├── data/         # Local files and Sheets
│   ├── rag/          # Retrieval and embeddings
│   ├── agents/       # Tools, guardrails and model calls
│   ├── backoffice/   # Prices, deals and invoices
│   ├── phone/        # Voice bridge
│   ├── server/       # Hono routes
│   └── cli/          # Local commands
├── api/              # Vercel entry point
├── data/seed/        # Synthetic CSVs
├── fixtures/         # Supplier pages, emails and wire template
├── prompts/          # Shared system prompts
├── evals/            # Fixed tests and measured reports
├── docs/             # Decisions, verification and original diagrams
├── .github/workflows/
├── AGENTS.md
├── README.md
└── LICENSE
```

The PNGs are what this README shows. The SVGs are the editable sources.

## Notes

Figures in the write-up are approximate and from memory. The code is a rebuild with synthetic data. It is not the code that ran at Colos.
