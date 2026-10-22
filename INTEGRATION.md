# Connecting the Plainfeed feeds

**TLDR:** the feeds need no code change to take PayPal payments today. Run this gateway in front of a feed, give it a feed key that only the gateway knows, and list the feed's endpoints and prices. Changes inside the feeds are optional and described at the end. Nothing in the five feed projects was edited.

## Option A: the gateway in front of a feed (works now)

```
AI agent  ->  plainfeed-agent-pay (prices, PayPal, limits, ledger)  ->  a Plainfeed feed (x-api-key held by the gateway)
```

Steps for City Cost (the same for each feed):

1. Mint a feed key for the gateway itself, on a plan with enough daily requests, because every paid call by every agent uses it. In the feed project: `npm run key:new business "agent-pay gateway"`, then run the `wrangler` command it prints to store the key in the feed's D1 database.
2. Start the gateway with that key:

   ```sh
   UPSTREAM_URL=https://citycost.plainfeed.workers.dev UPSTREAM_API_KEY=<the key from step 1> npm start
   ```

3. Check `GET /health` says `"data_source": "upstream"`, then buy one call with the demo agent.

What the gateway does with the feed:

- It forwards the normalised call, for example `/v1/compare?a=lisbon&b=madrid`, with `x-api-key` set to the gateway's key. Buyers never see that key.
- It fetches the data when quoting, so an agent only pays for calls that succeed. A `404` from the feed means no quote and no charge.
- If the feed refuses the gateway's own key (`401`, `403`, `429`), the agent gets a `502` that says so, and nothing is charged.

### Price files for each feed

Each feed gets its own price list in the same format as `config/prices.json`. One gateway serves one feed; run one gateway per feed (or extend `Catalog` to hold several upstreams, a small change). Paths with fixed words must come before paths with `{placeholders}`, because the first match wins (for example `/v1/stations/near` before `/v1/stations/{id}`).

Endpoints worth pricing, from each feed's README (prices are for the seller to choose):

| Feed | Paid calls | Free calls |
|-|-|-|
| City Cost (`citycost`) | `/v1/compare`, `/v1/cities/{id}`, `/v1/cities` | `/v1/sources` |
| Fuel prices (`fuelprice`) | `/v1/cheapest`, `/v1/stations/near`, `/v1/averages`, `/v1/stations/{id}` | `/v1/fuels`, `/v1/sources` |
| EV charging (`ev-charge-api`) | `/v1/chargers/cheapest`, `/v1/chargers`, `/v1/stations/{id}`, `/v1/operators` | `/v1/sources` |
| Local events (`localevents`) | `/v1/events/near`, `/v1/events`, `/v1/events/{id}` | `/v1/cities`, `/v1/categories`, `/v1/sources` |
| Local officials (`local-officials-api`) | `/v1/lookup`, `/v1/officials`, `/v1/officials/{id}`, `/v1/divisions/{ocd_id}` | `/v1/coverage`, `/v1/divisions` |

Leave each feed's `/v1/export` off the per-call price list: bulk exports belong to the feeds' existing monthly plans.

Each product also needs a `describe` line: it becomes the PayPal item name and the ledger text. `UpstreamSource` passes any path through, so no code change is needed.

## Option B: payments inside each feed (later, optional)

Only worth doing if the gateway becomes a bottleneck or the feeds should answer `402` themselves. These are the changes, by file, in the feed projects (shown for `city-cost-api`; the others share the same layout):

1. **`src/api/handler.ts`, `authenticate()`**: when a paid endpoint is called with no key, answer `402 payment_required` with the price and a link to the gateway's `POST /pay/quotes`, instead of `401 missing_key`. Keep `401` for unknown keys.
2. **`src/mcp/core.ts`**: add the five payment tools from this repo's `src/mcp/core.ts` (or return a tool result that points the agent at the gateway's MCP server).
3. **Storage on Cloudflare**: this gateway keeps quotes in a JSON file and the ledger in a JSON Lines file. On Workers both move to D1. A migration like:

   ```sql
   CREATE TABLE agent_quotes (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, status TEXT NOT NULL, total_cents INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, paypal_order_id TEXT UNIQUE, paypal_capture_id TEXT UNIQUE, body TEXT NOT NULL);
   CREATE TABLE agent_ledger (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, body TEXT NOT NULL, prev TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
   CREATE TABLE paypal_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
   ```

   The ledger insert must read the last `hash` and write the new row in one D1 batch so two Workers cannot fork the chain.
4. **Crypto**: `src/lib/crypto.ts` uses `node:crypto`. On Workers, swap to Web Crypto (`crypto.subtle.digest` and HMAC with `importKey`), which is async, so `Ledger.append` and `ReceiptSigner.sign` become async.
5. **Secrets**: `npx wrangler secret put PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `RECEIPT_SECRET`. The PayPal client already uses `fetch` only, so it runs on Workers unchanged.
6. **Webhook route**: add `POST /paypal/webhook` and read the body with `await req.text()` before anything else, so the raw bytes reach PayPal's verify call untouched.
7. **Agent keys**: the feeds' existing API keys could double as agent identities, with the two limits added as columns on the keys table.

## Stripe and PayPal side by side

The feeds' Stripe setup (monthly plans, keys after checkout) stays as it is for people and companies on a subscription. PayPal per call is for agents that buy now and then, with a person approving each payment. They do not overlap: a request with a valid feed key is served on its plan; a request from an agent with no plan gets a PayPal quote.
