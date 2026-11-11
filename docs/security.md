# Security model

This is a reference implementation with synthetic records. Its checks constrain account access and money writes. They do not establish strong caller authentication or make a hosted voice account safe by themselves.

## Identity and tools

[createConversation](../src/agents/phone.ts) derives a saved customer's identity from Phones and Customers before speaking. An unknown caller must provide an order number and company name to `verify_identity` in [createTools](../src/agents/tools.ts). Company comparison trims and ignores case. It must match the order's customer. An already verified caller cannot switch to another customer through this tool.

Phone SDK tool visibility requires identity for pickup_status and negotiate_offer. Each handler checks the requested order's owner again. pickup_confirmation requires a saved depot or supplier, and checks that the order belongs to that party's depot or supplier id. Public availability and list pricing need no account. Search accepts only query; code supplies the verified customer filter.

The low-level direct `invoke` path does not use SDK visibility. It validates the input and output schemas and relies on the same handler ownership checks. Handoff is also checked there. After handoff, every tool except handoff is blocked. HTTP restores that state from the saved call route and outcome.

Caller ID can be spoofed. Company names and order numbers can be learned. These checks are appropriate for this demonstration, not sensitive account changes. The phone tools do not edit orders, customer records or invoice amounts.

## HTTP authentication

[createApp](../src/server/app.ts) checks Twilio signatures on both voice and whisper requests when TWILIO_AUTH_TOKEN is set. Validation uses the received URL and form values, so proxy URL configuration matters. Invalid signatures return 403. Without the token, middleware returns inert dry-run TwiML before account reads or bridge registration.

Tools require configured Twilio authentication and TOOL_WEBHOOK_SECRET. Requests must send the secret in `x-tool-secret`, plus call_id, call_token and input in the JSON body. The body cannot choose from_e164 or customerId. Code reads those from the saved call and phone lookup. Missing configuration or wrong shared secret returns 401. An invalid or expired call token returns 403.

[issueCallToken and verifyCallToken](../src/phone/auth.ts) use HMAC-SHA256 over call id, caller number, start time and expiry. Expiry is exactly 2 hours after call start. Tokens cannot be moved between calls or extended by changing the expiry field. `equalSecret` uses a byte-length check and timingSafeEqual. The token is a reusable bearer credential until expiry. It has no nonce, per-tool scope or one-use enforcement.

The bridge passes the call token as a dynamic variable. Hosted tool configuration must also supply the shared-secret header. The token does not replace that header. TLS and protection of the hosted agent's configuration are deployment responsibilities.

The cron endpoint compares the Authorization header to `Bearer CRON_SECRET`. It returns 401 when absent or incorrect. Health is unauthenticated and exposes the last successful price run and its age, not account rows.

## Untrusted text

| Input | Check and limit |
|---|---|
| Calls | `unsafeInput` in [guardrails.ts](../src/agents/guardrails.ts) rejects selected abuse and instruction patterns before intent sorting. SDK guardrails repeat the check against the current caller message. It is a regex, not a general injection detector. |
| Emails | `suspiciousEmail` in [negotiator.ts](../src/agents/negotiator.ts) skips the model for selected control instructions. Structured output permits only code-approved drafts. Code parses the offer and fixes the decision first. |
| Retrieved text | [phone.md](../prompts/phone.md) and [reranker.md](../prompts/reranker.md) mark it as untrusted reference data. Access filters run before scoring and reranking. There is no separate content sanitizer for every instruction hidden in a note. |
| Supplier pages | [parseSupplierPage](../src/backoffice/prices.ts) accepts a fixed table shape and integer costs. The reviewer receives structured changes, not raw HTML instructions. Code enforces the write rules. |
| Model output | Zod validates tool and structured agent output. Code enforces invoice arithmetic, offer decisions, approval and ownership. The final text money guard constrains quoted amounts. These checks do not prove every natural-language statement is true. |

The phone output guard can reject harmless policy text, as [A26](evals.md#a26-investigation) shows. It can also miss forms of language outside its patterns. Hosted audio is not passed through the local text output guard. ElevenLabs must be configured with equivalent controls, transfer behavior and prompts before live use.

## Secrets, storage and remaining gaps

[config](../src/config/index.ts) parses keys in one place. [.env.example](../.env.example) lists names and defaults without values. [.gitignore](../.gitignore) excludes .env, runtime caches, logs, generated output and dependencies. Raw or base64 service-account JSON is parsed with generic malformed-credential errors. Hono returns generic uncaught request errors.

The application still writes account content into local retrieval caches, per-call logs, the sheet and generated invoices. There is no encryption-at-rest layer, retention policy or redaction pass over every tool input. Limit filesystem and sheet access. Synthetic test reports are safe to publish because their records are synthetic, not because the report format removes private data.

Sheets has no atomic compare-and-swap. Local queues do not coordinate separate processes. There is no rate limiter, comprehensive replay protection or distributed billing lock. Approval commands trust the operator's local environment; they are not a user-authenticated approval portal. A refresh or external write can partly succeed before a later failure.

The ElevenLabs bridge times out and returns an HTTP error when unreachable. It does not transfer automatically to a person. Account-backed voice and Stripe delivery remain unverified as listed in [verification](verification.md). Production work would start with stronger identity, durable billing and outbox transactions, reconciliation, log retention and hosted voice controls.
