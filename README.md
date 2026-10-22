# Plainfeed Agent Pay

PayPal pay-per-call for AI agents. An agent asks a data API for something, gets a price, its person approves the payment in PayPal, and the agent receives the data with a signed receipt. The seller gets per-call prices, spending limits per agent, and a plain-English ledger that shows if anyone edits it.

**TLDR:** `npm install && npm test && npm run demo` runs the whole flow on your laptop in under a minute, with no PayPal account. Add two PayPal sandbox keys and the same code runs against the real PayPal sandbox.

- Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (rules summary: [rules.md](rules.md), submission text: [SUBMISSION.md](SUBMISSION.md)).
- Uses PayPal Orders v2 (create, buyer approval, capture) and PayPal webhooks (signature verified with PayPal), checked against PayPal's Orders v2 spec (version 2.36) and the PayPal AI Toolkit best-practice checklist in October 2026.
- The buying agent is Claude (or any MCP client), through the MCP server in `src/mcp/`.
- Node 22.18 or newer. No runtime dependencies.

## Contents

- [Try it in one minute](#try-it-in-one-minute)
- [How a purchase works](#how-a-purchase-works)
- [Use it from Claude](#use-it-from-claude)
- [Switch to the real PayPal sandbox](#switch-to-the-real-paypal-sandbox)
- [How PayPal is used](#how-paypal-is-used)
- [Spending limits](#spending-limits)
- [The ledger](#the-ledger)
- [Mock mode: what it fakes](#mock-mode-what-it-fakes)
- [API](#api)
- [Sell a live Plainfeed feed](#sell-a-live-plainfeed-feed)
- [Tests](#tests)
- [Limits and open questions](#limits-and-open-questions)
- [Project layout](#project-layout)

## Try it in one minute

```sh
npm install        # dev tools only: MCP SDK for interop tests, TypeScript for the type check
npm test           # 85 tests, a few seconds, no network
npm run demo       # a scripted agent buys data through a mock PayPal
```

`npm run demo` prints each step: the 402 answer, the quote, the PayPal order, a capture refused before approval, the approval, the data and receipt, an agent blocked by its limit, and the ledger with its chain check.

To click through it yourself in a browser:

```sh
npm run demo:manual   # prints a checkout link; open it, press Approve, watch the script finish
npm start             # or run the gateway on http://localhost:8787 and look around
```

Then open http://localhost:8787 (overview), http://localhost:8787/ledger (the seller's ledger) and http://localhost:8787/v1/prices.

## How a purchase works

1. **Ask.** The agent calls a data endpoint, for example `GET /v1/compare?a=lisbon&b=madrid`. Paid calls answer `402 Payment Required` with a quote.
2. **Quote.** The agent puts every call it needs into one quote (`POST /pay/quotes`), so its person approves once. The gateway checks the agent's limits, fetches the data to make sure it exists, and holds it back.
3. **Checkout.** The gateway creates a PayPal order for the quote (Orders v2) and returns the PayPal approval link.
4. **Approve.** The person paying opens the link and approves in PayPal. The agent never sees or types payment details.
5. **Capture.** The gateway captures the order, checks that PayPal's amount and reference match the quote, then releases the data with a signed receipt and writes a ledger line.
6. **Confirm.** PayPal's webhook confirms the capture. Refunds and payments PayPal holds for review are handled the same way.

## Use it from Claude

Start the gateway (`npm start`), then add the MCP server to Claude Code:

```sh
claude mcp add plainfeed-pay -e GATEWAY_URL=http://localhost:8787 -e AGENT_KEY=demo-agent-key-not-secret -- node "$(pwd)/src/mcp/stdio.ts"
```

Or in Claude Desktop's config:

```json
{ "mcpServers": { "plainfeed-pay": { "command": "node", "args": ["/path/to/plainfeed-agent-pay/src/mcp/stdio.ts"], "env": { "GATEWAY_URL": "http://localhost:8787", "AGENT_KEY": "demo-agent-key-not-secret" } } } }
```

Then ask something like: "Compare a travel day in Lisbon and Madrid, and give me each city's costs. You can spend up to 20 cents."

Five tools:

| Tool | What it does |
|-|-|
| `list_prices` | What is for sale and what each call costs. |
| `get_quote` | Price a basket of calls as one payment. Shows what the agent may still spend today. |
| `start_payment` | Create the PayPal order and return the approval link for the person. The tool tells the agent never to open or approve it itself. |
| `finish_payment` | Capture after approval and return the data plus a signed receipt. Safe to repeat; never charges twice. |
| `spending_status` | Spent today, waiting for approval, and the limits. |

The gateway also serves the same tools over Streamable HTTP at `POST /mcp` (send `x-agent-key`).

## Switch to the real PayPal sandbox

Sandbox only: fake money, test accounts. There is no live mode in this project.

1. Sign in at https://developer.paypal.com/dashboard/ with a PayPal account (a free one works). This creates a test buyer (Personal) and a test seller (Business) account.
2. Open **Apps & Credentials**, pick the **Sandbox** tab, and use the **Default Application** or click **Create App**.
3. Copy the **Client ID** and **Secret**.
4. Put them in `.env.local` in this folder (it is not committed):

   ```sh
   PAYPAL_CLIENT_ID=...
   PAYPAL_CLIENT_SECRET=...
   ```

5. Run `npm start`. It should say `PayPal: SANDBOX`.
6. To approve a payment, open the link the agent shows and sign in at www.sandbox.paypal.com with the test **Personal** account from **Testing Tools > Sandbox Accounts** (its email looks like `sb-...@personal.example.com`).

Optional, webhooks: PayPal must reach `/paypal/webhook` over public HTTPS, for example through a tunnel. In the same app, add a webhook for `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED` and `PAYMENT.CAPTURE.REFUNDED`, then set `PAYPAL_WEBHOOK_ID` and `PUBLIC_URL`. Payments work without webhooks; they add confirmations, refunds and held payments.

## How PayPal is used

Every call is in `src/paypal/client.ts`, written against PayPal's Orders v2 OpenAPI spec (version 2.36) and Webhooks v1 spec, and the checklist in the PayPal AI Toolkit's best-practices skill.

| PayPal call | When | Details |
|-|-|-|
| `POST /v1/oauth2/token` | Before the first call | Client credentials. Token cached until a minute before `expires_in`; concurrent callers share one request. A 401 refreshes it once. |
| `POST /v2/checkout/orders` | `start_payment` | `intent: CAPTURE`, one purchase unit with one item per call (`DIGITAL_GOODS`), `item_total` equal to the items, `payment_source.paypal.experience_context` with `NO_SHIPPING` and `PAY_NOW`. The quote id is the `reference_id`, `custom_id` and `invoice_id`. The approval link is `payer-action`. |
| `POST /v2/checkout/orders/{id}/capture` | `finish_payment`, or when PayPal sends the buyer back | Checks status, amount, currency and `custom_id` before releasing anything. Handles `ORDER_NOT_APPROVED`, `ORDER_ALREADY_CAPTURED`, `INSTRUMENT_DECLINED` and `PENDING` captures. |
| `GET /v2/checkout/orders/{id}` | After `ORDER_ALREADY_CAPTURED` | Reads the existing capture instead of failing. |
| `POST /v1/notifications/verify-webhook-signature` | Every webhook | The raw body is embedded exactly as received. Unverified events are ignored. Each event id is handled once. |

Rules it follows: a `PayPal-Request-Id` on every Orders and webhook POST, derived from the quote so retries and parallel calls can never create two orders or two captures; 429 and 5xx retried with backoff that honours `Retry-After`; PayPal's `debug_id` kept on every error; credentials only from environment variables; server-side order creation and capture.

Why not let the agent call PayPal itself? The PayPal Agent Toolkit and MCP server give an AI the merchant's own PayPal powers. Here the merchant is the gateway, and the buyer's agent should never hold the merchant's keys or the buyer's payment details. So the gateway talks to PayPal, and the agent only gets a link for its person.

Where PayPal's own MCP server does fit is the seller's side. Optional: connect PayPal's sandbox MCP server to Claude next to this project (the PayPal AI Toolkit plugin sets it up: `/plugin install paypal@claude-plugins-official`, then a sandbox access token as described in https://github.com/paypal/AI-Toolkit). Then ask Claude to compare `npm run ledger` with PayPal's own records of the same orders. The ledger's PayPal order and capture ids make that a direct match. This needs your sandbox token, so it is not part of the tests.

## Spending limits

Each agent has a key (`x-agent-key`) and two limits, set by the seller in `config/agents.json` or `config/agents.local.json`:

- **Per payment** (`order_cap`): the most one PayPal payment may be.
- **Per day** (`daily_cap`, UTC): counting payments already made and payments still waiting for approval.

The limits are checked three times: at quote time, before creating the PayPal order, and right before capture. If a capture would pass the daily limit, the PayPal order is simply not captured and no money moves. Every block gets a ledger line.

Create an agent with its own key (shown once, stored only as a SHA-256 hash):

```sh
npm run agent:new trip-planner "Trip planner" 0.50 2.00
```

The two demo agents in `config/agents.json` have public keys on purpose (`demo-agent-key-not-secret`: $0.25 per payment, $1.00 a day; `tight-agent-key-not-secret`: $0.10 and $0.15). Delete them for anything other than local testing.

## The ledger

One plain-English line for every payment event, for example:

> Paid: $0.09 from Trip planner (demo) through PayPal (order BETXYFLYM3IVIYU6S, capture HBCCT52BK9EQR9MC6). Delivered 3 calls: Compare lisbon and madrid ($0.05), City costs: pt-lisbon ($0.02), City costs: es-madrid ($0.02). Spent today: $0.09 of $1.00.

- Stored as JSON Lines in `.local/ledger.jsonl`, opened only for appending.
- Each line holds the SHA-256 hash of the line before it. Changing or removing any past line breaks the chain, and the check names the first bad entry. The gateway refuses to start appending to a broken ledger.
- `npm run ledger` prints it; `npm run ledger:check` checks it; http://localhost:8787/ledger shows it live in an AG Grid table with totals.

## Mock mode: what it fakes

With no PayPal keys, `src/paypal/mock.ts` stands in for `api-m.sandbox.paypal.com`. It answers the same paths with the same status codes, error bodies (`name`, `message`, `debug_id`, `details[].issue`) and response shapes, honours `PayPal-Request-Id`, issues and checks bearer tokens, validates orders the way PayPal does (`ITEM_TOTAL_MISMATCH`, `AMOUNT_MISMATCH`, `DUPLICATE_INVOICE_ID`), refuses capture before approval, signs webhook deliveries and verifies them through the verify endpoint. The real client code runs unchanged against it.

It also serves a plainly labelled stand-in for PayPal's approval screen at `/mock-paypal/checkoutnow`. It does not imitate PayPal's look.

What it does not fake: real accounts, risk checks, currency conversion, and fees (it reports a fee of 0.00).

## API

Agents send `x-agent-key` (or `Authorization: Bearer <key>`). Money is US dollars, as strings like `"0.05"`.

| Endpoint | Key | What it does |
|-|-|-|
| `GET /health` | no | Mode (mock or sandbox), data source, webhook status. |
| `GET /v1/prices` | no | The price list. |
| `GET /v1/sources` | no | Free call: where the data comes from. |
| `GET /v1/compare?a=&b=`, `/v1/cities/{id}`, `/v1/cities?q=` | yes | Paid calls. Answer `402` with a quote and how to pay. |
| `POST /pay/quotes` | yes | `{"calls": ["/v1/compare?a=lisbon&b=madrid", ...]}`, 1 to 10 calls, one payment. |
| `GET /pay/quotes/{id}` | yes | Quote status. Includes the data once paid. |
| `POST /pay/quotes/{id}/checkout` | yes | Creates the PayPal order. Returns `paypal.approve_url`. |
| `POST /pay/quotes/{id}/capture` | yes | Captures after approval. Returns `results` and `receipt`. `409 not_approved` with the link if the person has not approved yet. |
| `GET /pay/spending` | yes | Spending today and limits. |
| `POST /pay/receipts/verify` | no | `{"valid": true}` if the receipt is genuine and unchanged. |
| `GET /pay/return`, `GET /pay/cancel` | no | Where PayPal sends the buyer's browser back. |
| `POST /paypal/webhook` | PayPal signature | PayPal events. |
| `GET /ledger.json`, `GET /ledger` | no | The seller's ledger. The server listens on 127.0.0.1 by default; put it behind your own access control before exposing it. |
| `POST /mcp` | yes | MCP over Streamable HTTP. |

Errors look like `{"error": {"code": "...", "message": "..."}}`.

## Sell a live Plainfeed feed

The bundled data (`data/sample-cities.json`) is made-up sample numbers so the repo runs on its own. To sell a real feed, point the gateway at it with the seller's own feed key, which buyers never see:

```sh
UPSTREAM_URL=https://citycost.plainfeed.workers.dev UPSTREAM_API_KEY=<seller key> npm start
```

How the other Plainfeed feeds plug in, and what would change inside them later: [INTEGRATION.md](INTEGRATION.md).

## Tests

`npm test` runs 85 tests with the test runner built into Node, no network:

- PayPal client: request shapes against the Orders v2 spec, token caching, `PayPal-Request-Id` on every POST, idempotent replays, 429 and 5xx retries, token refresh, error details, webhook signature checks.
- Mock fidelity: PayPal's validation errors, bearer tokens, capture rules.
- The full flow over HTTP: 402 quotes, checkout, capture before and after approval, parallel captures, return and cancel pages, declined funding, held payments, PayPal outages, expiry, agent isolation.
- Limits: per payment, per day counting pending payments, and the check right before capture across a day boundary.
- Webhooks: confirmation, redelivery, forged and altered events, refunds, a capture whose response was lost.
- Sandbox mode (all traffic to `api-m.sandbox.paypal.com`, with a stand-in) and the upstream feed source (key never shown to buyers).
- MCP: the official MCP SDK client buys data over stdio and over HTTP.
- The Node server, restart persistence, and the scripted demo.

`npm run typecheck` runs the TypeScript checker.

## Limits and open questions

- **Tiny payments and fees.** PayPal charges a fee on each payment, so a single 2 cent call does not pay for itself. Baskets help; a prepaid balance or a saved PayPal payment method (PayPal vault) is the next step. Check PayPal's current fees before pricing.
- **One person approves every payment.** That is the safety model today. Saved payment methods would let a person approve once and then let limits do the work.
- **State lives in files.** `.local/state.json` and `.local/ledger.jsonl` suit one server. A hosted version needs a database (see INTEGRATION.md).
- **Agent keys are shared secrets.** Fine for a seller and a few known agents; signed agent identities would scale better.
- **Sandbox only.** Going live would need a PayPal business account review and the live API host.

## Project layout

```
src/paypal/client.ts    PayPal REST client (OAuth, Orders v2, webhook verification)
src/paypal/mock.ts      faithful fake of those PayPal calls, for running without an account
src/pay/gateway.ts      the flow: quote, checkout, capture, limits, webhooks, receipts
src/pay/catalog.ts      price list and call normalisation (config/prices.json)
src/pay/agents.ts       agent keys and limits (config/agents*.json)
src/pay/ledger.ts       append-only, hash-chained, plain-English ledger
src/pay/receipts.ts     signed receipts
src/pay/store.ts        quotes and handled webhook ids
src/data/source.ts      sample dataset, or a live Plainfeed feed
src/api/                HTTP handler, pages, Node server, app wiring
src/mcp/                MCP tools for buying agents (stdio and HTTP)
src/demo/run.ts         the scripted demo
site/                   overview page and ledger page (AG Grid)
test/                   test suites (Node test runner)
```

## License

MIT, see [LICENSE](LICENSE).
