# Devpost submission: Plainfeed Agent Pay

Text to paste into the Devpost form, section by section, then the voice-over script for the video. Replace the two links in brackets once they exist.


## Project name

Plainfeed Agent Pay

## Elevator pitch (Devpost limit: 200 characters)

AI agents buy data one call at a time with PayPal. The agent gets a price, its person approves in PayPal, and the seller gets limits per agent and a ledger that shows any edit.

## Inspiration

I run Plainfeed, a set of small data APIs: city living costs, fuel prices, EV charging, local events and local officials. More and more of the traffic that wants this data comes from AI agents. They need three answers on a Tuesday, not a monthly plan.

Data APIs are still sold the old way. You sign up, pick a monthly plan and paste an API key into a config file. That works for a developer. It does not work for an agent that discovers a data source halfway through a task, and it is a risk for the person whose card is behind that key, because nothing stops a confused agent from spending in a loop.

I wanted the shortest honest path: the agent asks, gets a price, its person approves the payment in PayPal, and the data comes back with a receipt. The seller keeps a record that cannot be quietly changed.

## What it does

Plainfeed Agent Pay is a payment gateway that sits in front of a data API.

1. An agent calls a data endpoint. Paid calls answer `402 Payment Required` with a price quote.
2. The agent puts every call it needs into one quote, so its person approves once. The gateway checks the agent's spending limits and fetches the data first, so nobody pays for a call that would fail.
3. The gateway creates a PayPal order through the Orders v2 API and gives the agent the approval link.
4. The person opens the link and approves in PayPal. The agent never sees or types payment details.
5. The gateway captures the payment, checks that PayPal's amount and reference match the quote, and only then releases the data with a signed receipt.
6. PayPal's webhook confirms the capture. Refunds and payments PayPal holds for review are handled too.

For the seller:

- **Per-call prices** in one small file.
- **Two limits per agent**: the most one payment may be, and the most per day, counting payments still waiting for approval. Limits are checked when quoting, when creating the PayPal order, and right before capture. If a capture would pass the daily limit, the order is simply not captured and no money moves.
- **A plain-English ledger**, one line per payment event, for example "Paid: $0.09 from Trip planner through PayPal (order ..., capture ...). Delivered 3 calls." Each line holds the SHA-256 hash of the line before it, so any edit or deletion breaks the chain and the ledger page turns red. The ledger page is an AG Grid table with totals.

For the agent, an MCP server with five tools: `list_prices`, `get_quote`, `start_payment`, `finish_payment` and `spending_status`. Claude uses them directly. The tool descriptions tell the agent to show the link to its person and never approve a payment itself.

## How we built it

- **TypeScript on Node 22**, no runtime dependencies, tested with Node's built-in test runner. The HTTP handler is a plain `fetch` handler, so it can move to Cloudflare Workers later like the rest of Plainfeed.
- **PayPal Orders v2**: create (`intent: CAPTURE`, one line item per API call, `item_total` matching the items, PayPal wallet with no shipping), buyer approval through the `payer-action` link, and capture. The quote id is the order's `reference_id`, `custom_id` and `invoice_id`, so every PayPal record points back to it.
- **PayPal webhooks**: every event is checked with PayPal's verify-webhook-signature API, with the raw body passed exactly as received, and each event id is handled once.
- **PayPal's best practices**, taken from the PayPal AI Toolkit's best-practice checklist and checked against PayPal's Orders v2 OpenAPI spec (version 2.36): a `PayPal-Request-Id` on every POST, derived from the quote so retries and parallel calls can never create two orders or two captures; backoff on 429 that respects `Retry-After`; a cached OAuth token; PayPal's `debug_id` kept on every error; server-side order creation and capture.
- **A faithful mock of the PayPal API** for running with no account. It answers the same paths with the same status codes, error bodies and response shapes, honours idempotency, validates orders the way PayPal does, and signs its webhooks. The real PayPal client runs against it unchanged. Two environment variables switch everything to the real PayPal sandbox.
- **MCP server** over stdio (for Claude Desktop and Claude Code) and over Streamable HTTP, tested with the official MCP SDK client.
- **Signed receipts** (HMAC-SHA256 over canonical JSON) that anyone can check at `POST /pay/receipts/verify`.
- **AG Grid Community** for the ledger page, with a theme that follows light and dark mode.
- **85 automated tests** cover the PayPal client, the mock, the whole payment flow, limits across a day boundary, webhooks (forged, altered, repeated, refunds, a lost capture response), sandbox mode, MCP over both transports, restarts, and the scripted demo.

## Tools used (AI)

- **Claude (Anthropic), through MCP**: the buying agent in the demo. It reads the price list, plans one quote for everything it needs, asks me to approve the PayPal payment, collects the data and cites the receipt.
- **Claude Code (Anthropic)**: wrote most of the code and tests with me, from my design and decisions.
- **PayPal AI Toolkit** (github.com/paypal/AI-Toolkit): its PayPal best-practice skill and reference files were the checklist for the PayPal integration.

## Challenges we ran into

- **Never charging twice.** A payment can be captured from three places: the agent finishing, the buyer's browser returning from PayPal, and the webhook. They can arrive at the same moment. Each capture uses one PayPal-Request-Id derived from the quote, and the gateway joins parallel captures into one, so there is exactly one charge and one ledger line.
- **Limits that cannot be raced.** An agent could ask for several quotes at once. Counting payments still waiting for approval, and checking again right before capture, closes that gap. The test for it crosses midnight UTC.
- **Webhook signatures.** PayPal signs the exact bytes it sent. Re-serializing the JSON breaks verification, so the raw body is embedded untouched in the verify call.
- **Tiny payments.** PayPal charges a fee per payment, so a two cent call on its own does not pay for itself. Baskets make one payment cover many calls. Saved payment methods are the real fix and come next.
- **Keeping a mock honest.** A mock that is too kind hides bugs. This one rejects totals that do not add up, reused invoice ids, captures before approval and second captures, and the tests prove the client handles each one.

## Accomplishments that we're proud of

- The whole flow, from a 402 answer to a signed receipt, runs in under a minute with no account, and the same code runs on the PayPal sandbox with two keys.
- A person approves every payment, and an agent's limits are enforced in three places, so a looping agent cannot run up a bill.
- A ledger a seller can show an accountant: plain sentences, and proof that nothing was changed.

## What we learned

- The HTTP 402 status code fits agents well: it tells a machine "this costs money" in a way it can act on.
- PayPal's Orders API already has what agent payments need: line items, references back to your own records, idempotency, and a clear approval step for a human.
- The most useful thing an agent tool description can say is what the agent must not do.

## What's next

- Saved PayPal payment methods (PayPal vault), so a person approves once and the limits do the rest.
- A prepaid balance per agent, so one payment covers many small calls.
- Moving the gateway onto Cloudflare Workers with D1, next to the five Plainfeed feeds, and selling all five through it.
- MCP's URL request feature, so the agent's app can open the PayPal link itself instead of the agent pasting it.

## Built with

typescript, node.js, paypal, paypal-orders-api, paypal-webhooks, model-context-protocol, claude, ag-grid

## Links

- Code: [GitHub repository URL]
- Video: [YouTube URL]

## Testing instructions (for judges)

No account is needed for mock mode:

```sh
git clone [GitHub repository URL] && cd plainfeed-agent-pay
npm install
npm test
npm run demo
```

`npm run demo:manual` lets you approve in the browser. `npm start` runs the gateway at http://localhost:8787; the ledger is at /ledger.

Real PayPal sandbox: put your own sandbox app's `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env.local` and run `npm start`. Approve with your sandbox Personal account at www.sandbox.paypal.com. Steps are in the README under "Switch to the real PayPal sandbox".

New work: this project was started on Oct 22, 2026, during the submission period. It builds on the existing Plainfeed data feeds, which are separate, private projects; none of their code is in this repository.


## Video voice-over script

For Gemini TTS. About 385 words, roughly 2 minutes 35 seconds at a normal speaking pace. Keep the finished video under 2:55; if it runs long, cut the sentence about the mock in the "Under the hood" line.

Recording notes:

- Screen recording only, no face, no music (the rules ban copyrighted music without permission).
- Record against the PayPal sandbox if the sandbox keys are set up, so the PayPal approval screen is real. If not, record mock mode and change line 4 to say "the mock checkout".
- With the bundled sample data, keep the words "sample numbers" in line 5. With the live City Cost feed, drop them.
- Keep logos and app splash screens out of frame where you can. The PayPal sandbox page is fine.
- Before recording: `npm start` in one terminal, Claude Code connected with `claude mcp add` (see README), and the ledger page open in a browser tab.
- Say the amounts Claude really used. The prompt below is written so the natural basket is one comparison and two city records, $0.09. If Claude picks different calls, change "three calls" and "nine cents" in line 3.
- For a fresh ledger on camera, stop the gateway and delete `.local/ledger.jsonl` and `.local/state.json` first.

| Time | On screen | Narration |
|-|-|-|
| 0:00 | The overview page at localhost:8787 | AI agents are starting to do real work, and real work needs data. But data APIs are sold by monthly plan and API key. That suits a developer. It does not suit an agent that needs three answers on a Tuesday, or the person paying for it. |
| 0:18 | Same page, scroll to "How a purchase works" | Plainfeed Agent Pay lets an agent buy data one call at a time with PayPal. The agent gets a price. Its person approves the payment in PayPal. The seller gets limits for every agent, and a ledger anyone can check. |
| 0:33 | Claude Code. Type: "Compare a travel day in Lisbon and Madrid, and give me each city's costs. You can spend up to 20 cents." Claude calls list_prices, get_quote, start_payment | Here is Claude, connected through MCP. I ask it to compare Lisbon and Madrid, with a budget of twenty cents. Claude reads the price list and puts all three calls into one quote: nine cents. Then it starts the payment. The gateway creates a PayPal order and hands Claude a link. Claude shows me the link and waits. It never touches payment details. |
| 1:03 | Browser: the PayPal sandbox page, sign in as the sandbox buyer, approve | I open the link and approve as my sandbox buyer. PayPal sends me back, and the gateway captures the payment. It checks that the amount and the reference match the quote, and only then releases the data. |
| 1:22 | Claude Code: finish_payment, then Claude's answer with the receipt id | Back in the terminal, Claude finishes the payment and gets the data with a signed receipt. Its answer: a travel day in Lisbon costs about eight percent less than in Madrid, using the demo's sample numbers. It cites the receipt, so I know exactly what I paid for. |
| 1:42 | The ledger page, point at the new lines and the green chain check | This is the seller's side. Every payment event gets one plain English line. Each line carries a fingerprint of the line before it, so if anyone edits or deletes a line, this check turns red. |
| 1:58 | A terminal running `npm run demo:overspend`, then the ledger page's new "Blocked by limit" row | Now a budget agent with a ten cent limit asks for fifteen cents of data. It is blocked before any PayPal order exists, and the ledger says why. |
| 2:10 | The README section "How PayPal is used", then `npm test` passing | Under the hood, every PayPal request carries an idempotency key, so retries never charge twice. Webhooks are verified with PayPal before they count. With no keys, it runs against a faithful mock of the PayPal API, so anyone can try it in a minute. Eighty-five tests pass. |
| 2:35 | The overview page | It is built for small data sellers, and for people who let agents spend for them. Next comes saved PayPal payment methods, so a person approves once and the limits do the rest. Plainfeed Agent Pay. Open source, MIT license. |

Narration only, for pasting into Gemini TTS:

AI agents are starting to do real work, and real work needs data. But data APIs are sold by monthly plan and API key. That suits a developer. It does not suit an agent that needs three answers on a Tuesday, or the person paying for it.

Plainfeed Agent Pay lets an agent buy data one call at a time with PayPal. The agent gets a price. Its person approves the payment in PayPal. The seller gets limits for every agent, and a ledger anyone can check.

Here is Claude, connected through MCP. I ask it to compare Lisbon and Madrid, with a budget of twenty cents. Claude reads the price list and puts all three calls into one quote: nine cents. Then it starts the payment. The gateway creates a PayPal order and hands Claude a link. Claude shows me the link and waits. It never touches payment details.

I open the link and approve as my sandbox buyer. PayPal sends me back, and the gateway captures the payment. It checks that the amount and the reference match the quote, and only then releases the data.

Back in the terminal, Claude finishes the payment and gets the data with a signed receipt. Its answer: a travel day in Lisbon costs about eight percent less than in Madrid, using the demo's sample numbers. It cites the receipt, so I know exactly what I paid for.

This is the seller's side. Every payment event gets one plain English line. Each line carries a fingerprint of the line before it, so if anyone edits or deletes a line, this check turns red.

Now a budget agent with a ten cent limit asks for fifteen cents of data. It is blocked before any PayPal order exists, and the ledger says why.

Under the hood, every PayPal request carries an idempotency key, so retries never charge twice. Webhooks are verified with PayPal before they count. With no keys, it runs against a faithful mock of the PayPal API, so anyone can try it in a minute. Eighty-five tests pass.

It is built for small data sellers, and for people who let agents spend for them. Next comes saved PayPal payment methods, so a person approves once and the limits do the rest. Plainfeed Agent Pay. Open source, MIT license.
