# Working on this repository

This is a rebuild with synthetic data. It is not the source that ran at Colos. Preserve the original README write-up. Keep new documentation separate from the historical account.

## Setup

Use Node.js 22 and npm. Run npm ci from the repository root. Copy .env.example to .env for live work. Local tests need no credentials.

For a local walkthrough, set DATA_SOURCE=local. Run doctor, seed, index and chat. Local writes live under .cache/local and do not change the seed CSVs. Seed refuses to replace populated tabs unless force is requested.

For Sheets, enable the Google Sheets API in a Google Cloud project. Create a service account and a JSON key. Create a blank spreadsheet and share it with the service account email as an editor. Set GOOGLE_SHEET_ID and either GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS. Set OPENAI_API_KEY for model calls and embeddings. Run doctor before seed.

Do not print secrets. Never commit .env, .cache, .logs, out or node_modules. Keep these paths in .gitignore.

## Commands

Run from the repository root:

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
DATA_SOURCE=local npm run doctor
DATA_SOURCE=local npm run seed
DATA_SOURCE=local npm run index
DATA_SOURCE=local npm run chat -- --from +15555550123 --at 2026-11-10T19:30:00Z
DATA_SOURCE=local npm run negotiate -- fixtures/emails/lowball.txt
DATA_SOURCE=local npm run prices:refresh
DATA_SOURCE=local npm run invoice:preview -- O001
DATA_SOURCE=local npm run invoice:approve -- O001
DATA_SOURCE=local npm run invoice:send -- O001
npm run dev
npm run eval
npm run eval:retrieval
npm run eval:agent
```

Check the fixtures directory for the available email examples. Supplier snapshots have fixed dates. When a later scheduled update has passed, refusal is expected until a fresh source exists.

Tests must stay offline and must not use the live sheet. Use a new LocalDataSource with persist set to false for each isolated test. An eval without an API key measures the deterministic adapter. Report the skipped model judge rather than calling that a live model result.

Run evals before changing prompts or models. Do not edit labels, expected behavior, thresholds or seed rows to make a failing check pass. Fix the system or report the miss. Record actual commands and outcomes. Never invent eval scores, usage, latency or cost.

## Folder ownership

| Folder | Responsibility |
|---|---|
| src/config | Parse environment variables in one place |
| src/domain | Schemas and pure routing, money and approval rules |
| src/data | Sheets and local adapters, seed, doctor, conflict checks |
| src/rag | Chunking, embeddings, ranking, filters and index persistence |
| src/agents | SDK agents, tool adapters, guardrails and conversation logs |
| src/backoffice | Price refresh, negotiation, invoice preview, approval and send |
| src/phone | Twilio and ElevenLabs integration boundaries |
| src/server and api | HTTP routes and deployment entry points |
| src/cli | Command parsing and terminal output |
| prompts | Shared system prompts used by the app and evals |
| data/seed | Fixed synthetic input records |
| fixtures | Supplier HTML, example emails and wire workbook template |
| evals | Fixed labels, scenarios, graders and measured reports |
| docs | Decisions and original diagrams |

Keep domain functions free of I/O. Validate tool inputs and outputs with Zod. Read installed SDK types before using an API. Keep money in integer cents and timestamps in UTC. Format display times with TIMEZONE. The model proposes text and flags. Code owns writes, identity, money and approval decisions.

Use append-only supplier prices. Existing rows require a fresh expected value when updated. Never let a model or a request body select an arbitrary customer identity for note retrieval. Use the verified conversation state.

## Workflow

Work in small milestones: contracts and domain, data, retrieval, agents, back office, phone and server, evals, then docs. Run the relevant checks after each milestone and make a short commit. Do not push unless the user asks.

## Writing

Use plain English and short sentences. Match the README's tone. Do not use em dashes, en dashes, double hyphens in prose, marketing words or emojis. Command flags may use their required syntax. Distinguish historical memories, synthetic fixtures and measured results. Describe limitations directly. Do not imply that a dry run tested a live service.

The authoritative build spec is docs/BUILD_SPEC.md. Preserve its text. Root owns src/domain, src/config, package.json and the lockfile. Workers edit only assigned folders. Record offline and live results separately. Missing credentials skip live checks and do not block local work.
