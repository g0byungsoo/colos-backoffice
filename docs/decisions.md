# Decisions

## Tools for facts, retrieval for text

Decision: Tools read prices, stock, pickup status and accounts from the data source. Retrieval searches policies and customer notes. A price may appear in a reply only if a pricing tool returned it during that conversation.

Why: A document can explain a release number. It cannot tell us whether a particular order is ready today.

Cost: Every factual answer needs a validated tool path. The guardrail checks money in the final reply, but a live voice platform also needs equivalent output controls.

## Local hybrid search

Decision: Combine BM25 and vector rankings with reciprocal rank fusion. Keep the index on disk and update chunks by content hash. Use a model reranker only when enabled.

Why: The corpus is small. A reviewer can read the search code without learning another service. Notes are filtered by the verified customer's identity before ranking. Superseded policies are excluded by default.

Cost: The index is a local snapshot. The search tool checks source content when building it, and the index command can warm it in advance. There is no shared index service or background sync. Serverless caches are temporary and may rebuild after a cold start. The fake embedder uses hashed words and does not measure semantic model quality.

## Model intent sorting

Decision: The live agent assigns each turn to a fixed reason list, including not_sure. Existing order problems trigger a person or a priority callback. An offline adapter uses simple text rules to exercise the same tools.

Why: There is no labeled production corpus to train a classifier. A fixed output schema makes routing inspectable.

Cost: Model behavior can change. Run the fixed evals before changing a model or prompt. Offline runs test the adapter and code paths. They do not establish live model accuracy. Caller identification happens before any model reply.

## Money rules in code

Decision: Code chooses the offer decision and calculates invoices from current supplier cost, list price and active customer rules. Money is integer cents. The strongest active discount applies; discounts do not stack. Invoice rows store unit amounts. Quantity determines the total.

Why: A model can draft a reply but cannot set an amount or bypass the floor. The preview shows the inputs an owner must review. Approval binds to a fingerprint of those inputs. Send checks the inputs again.

Cost: Pricing rules need explicit maintenance. The agreed price on an order is historical context and does not override the current rules. A negotiated discount enters Approvals. It does not silently become a pricing rule. The owner must resolve the approval and update the rule before invoicing. Taxes, delivery charges and credits are outside this reference implementation.

## Sheets as the source of truth

Decision: Keep Sheets as the shared record. Validate every row. Batch reads, cache within a request, back off on rate limits, and re-read a row before changing it. Supplier price observations are append-only.

Why: This preserves the original workflow and makes the rebuild easy to inspect. Local mode reads the same synthetic CSVs and stores changes separately.

Cost: Sheets has no transaction or conditional row update. A human can still edit between the final read and write. Local files also have no lock shared across processes. Move invoice approval, billing state, idempotency records and the outbox to Postgres first. Move orders and inventory next. Keep Sheets as an editable view only after conflict handling is defined.

## Supplier snapshots

Decision: Parse the supplied HTML fixtures with Cheerio. Keep their captured observation dates. A changed layout fails closed and creates an alert. The reviewer returns flags; code decides which observations can be appended.

Why: A fixture should never look like a fresh supplier observation merely because a job ran today. Invoice previews must refuse a price when the weekly update has passed and refresh cannot provide a current observation.

Cost: These fixtures expire. A deployment needs actual supplier fetchers and current source pages. The model review and parser do not establish that a supplier will honor a price.

## Explicit email offers

Decision: Negotiation emails include an Order header and either Offer-Cents or an Offer dollar amount. Code parses the amount. The model writes the draft inside the resulting decision.

Why: This keeps ambiguous currency extraction outside the money path while showing the approval workflow.

Cost: Free-form emails need an operator or a separate extraction and confirmation step. The Outbox holds drafts. This rebuild does not connect an email sender.

## Call identity and messages

Decision: A saved customer phone identifies an account. An unknown caller must supply a matching order number and company name. Depot and supplier callers receive general factual service. An existing order problem is handed off even when it appears after the initial routing decision.

Why: Account lookups and note retrieval need an identity set by code. A model must not choose which customer's private notes it can search.

Cost: Caller ID and knowledge of an order are weak authentication. A production deployment should add a stronger verification step for sensitive changes. The reference does not modify orders or accounts through voice. After hours it records a priority callback without promising a resolution time.

## Optional integrations and deployment

Decision: Missing optional credentials select an explicit dry run. Stripe accepts test keys only. Wire invoices use a synthetic workbook template and do not contain bank details. Twilio and ElevenLabs use separate interfaces from the text agent.

Why: The core can be reviewed without telephony or payment accounts. The text agent, CLI and server reuse tool code.

Cost: Generated files and queued messages are not proof of delivery. Live webhook signatures, audio, transfers and Stripe delivery need account-backed verification. A serverless filesystem is temporary. Use persistent storage for generated invoices and durable jobs before deployment.

## Evaluation evidence

Decision: Keep retrieval labels, scenario expectations, seed data and thresholds fixed while repairing code. Code grades tool use, isolation and money before the optional model judge. Reports identify offline runs and skipped model grading.

Why: A passing fake adapter does not prove the chosen model behaves correctly. Recorded transcripts and source ids help distinguish search failures from reply failures.

Cost: Live model evaluation needs an API key and incurs usage. The report records measured tokens and elapsed time. There is no guessed dollar cost or claimed voice latency.
