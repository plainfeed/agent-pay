// The gateway's HTTP API as one fetch handler: (Request) => Response.
//
//   GET  /health                          mode, PayPal environment, data source
//   GET  /v1/prices                       the price list (free)
//   GET  /v1/...                          a data call: free calls answer directly; paid calls answer
//                                         HTTP 402 Payment Required with a quote and how to pay
//   POST /pay/quotes                      {"calls": [...]} price a basket as one payment
//   GET  /pay/quotes/{id}                 quote status (data included once paid)
//   POST /pay/quotes/{id}/checkout        create the PayPal order, get the approval link
//   POST /pay/quotes/{id}/capture         capture after approval, get data plus signed receipt
//   GET  /pay/spending                    this agent's spending and limits
//   POST /pay/receipts/verify             check a receipt's signature (no key needed)
//   GET  /pay/return, /pay/cancel         where PayPal sends the buyer's browser back
//   POST /paypal/webhook                  PayPal webhook events (verified with PayPal first)
//   GET  /ledger.json                     the ledger with its chain check (seller view)
//   POST /mcp                             MCP over Streamable HTTP (JSON responses), for agents
//   GET  /mock-paypal/checkoutnow         mock mode only: the stand-in approval page
//
// Agents identify themselves with x-agent-key (or Authorization: Bearer <key>).

import type { MockPayPal } from '../paypal/mock.ts';
import type { Agent } from '../pay/agents.ts';
import { CallError } from '../pay/catalog.ts';
import type { Gateway, Outcome } from '../pay/gateway.ts';
import { Ledger } from '../pay/ledger.ts';
import { toCents, toValue } from '../lib/money.ts';
import { handleMcpMessage, httpPayApi, type JsonRpcMessage } from '../mcp/core.ts';
import { mockCheckoutPage, returnPage } from './pages.ts';

export type Handler = (req: Request) => Promise<Response>;

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-agent-key, authorization, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'x-quote-id',
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra } });
}

export function apiError(status: number, code: string, message: string, details: Record<string, unknown> = {}, extra: Record<string, string> = {}): Response {
  return json({ error: { code, message, ...details } }, status, extra);
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function fromOutcome(o: Outcome, extra: Record<string, string> = {}): Response {
  return o.ok ? json(o.body, o.status, extra) : apiError(o.status, o.code, o.message, o.details ?? {}, extra);
}

export function agentKey(req: Request): string | null {
  const h = req.headers.get('x-agent-key');
  if (h) return h.trim();
  const auth = req.headers.get('authorization');
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return null;
}

export function createHandler(gateway: Gateway, opts: { mock: MockPayPal | null }): Handler {
  const mock = opts.mock;

  function requireAgent(req: Request): Agent | Response {
    const key = agentKey(req);
    if (!key) return apiError(401, 'agent_key_required', 'Send your agent key in the x-agent-key header. Each agent has its own key and spending limits.');
    const agent = gateway.agentByKey(key);
    if (!agent) return apiError(401, 'unknown_agent_key', 'This agent key is not recognised.');
    return agent;
  }

  function lineItems(quoteId: string | undefined) {
    const q = quoteId ? gateway.opts.store.quotes.get(quoteId) : undefined;
    return q ? q.items.map((i) => ({ description: i.description, price: toValue(i.price_cents) })) : [];
  }

  const self: Handler = async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method.toUpperCase();
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (path === '/health') {
        return json({ ok: true, paypal: gateway.environment, paypal_api: gateway.opts.paypal.baseUrl, data_source: gateway.opts.source.name, webhooks: !!gateway.opts.webhookId, agents: gateway.opts.agents.size });
      }
      if (path === '/v1/prices') return json(gateway.opts.catalog.list());

      // ---- data calls: free ones answer, paid ones answer 402 with a quote
      if (path.startsWith('/v1/')) {
        if (method !== 'GET') return apiError(405, 'method_not_allowed', 'Data calls use GET.');
        let priced;
        try {
          priced = gateway.price(path + url.search);
        } catch (e) {
          if (e instanceof CallError) return apiError(e.status, e.code, e.message);
          throw e;
        }
        if (priced.priceCents === 0) {
          const r = await gateway.serveFree(priced);
          return json(r.body, r.status);
        }
        const agent = requireAgent(req);
        if (agent instanceof Response) {
          return apiError(402, 'payment_required', `This call costs $${toValue(priced.priceCents)}, paid with PayPal. Send your x-agent-key to get a quote.`, { price: toValue(priced.priceCents), currency: 'USD' });
        }
        const out = await gateway.quote(agent, [priced.call]);
        if (!out.ok) return fromOutcome(out);
        const qid = String(out.body.quote_id);
        return json(
          {
            error: { code: 'payment_required', message: `This call costs $${toValue(priced.priceCents)}, paid with PayPal. Quote ${qid} holds the data until it is paid.` },
            quote: out.body,
            how_to_pay: [`POST /pay/quotes/${qid}/checkout to create the PayPal payment`, 'The person paying opens approve_url and approves it in PayPal', `POST /pay/quotes/${qid}/capture to get the data and a signed receipt`],
          },
          402,
          { 'x-quote-id': qid },
        );
      }

      // ---- payment API for agents
      if (path === '/pay/quotes' && method === 'POST') {
        const agent = requireAgent(req);
        if (agent instanceof Response) return agent;
        let body: { calls?: unknown };
        try {
          body = (await req.json()) as { calls?: unknown };
        } catch {
          return apiError(400, 'bad_json', 'Send JSON like {"calls": ["/v1/compare?a=lisbon&b=madrid"]}.');
        }
        return fromOutcome(await gateway.quote(agent, body.calls));
      }
      let m = /^\/pay\/quotes\/([a-z0-9_]+)(?:\/(checkout|capture))?$/.exec(path);
      if (m) {
        const agent = requireAgent(req);
        if (agent instanceof Response) return agent;
        const [, id, action] = m;
        if (!action && method === 'GET') return fromOutcome(gateway.getQuote(agent, id));
        if (action === 'checkout' && method === 'POST') return fromOutcome(await gateway.checkout(agent, id));
        if (action === 'capture' && method === 'POST') return fromOutcome(await gateway.capture(id, agent));
        return apiError(405, 'method_not_allowed', 'Use GET for a quote, POST for checkout and capture.');
      }
      if (path === '/pay/spending' && method === 'GET') {
        const agent = requireAgent(req);
        if (agent instanceof Response) return agent;
        const quotes = gateway.opts.store.forAgent(agent.id).slice(-20).reverse().map((q) => ({ quote_id: q.id, status: q.status, total: toValue(q.total_cents), created_at: q.created_at, receipt_id: q.receipt?.receipt_id }));
        return json({ agent: { id: agent.id, name: agent.name }, spending: gateway.spending(agent), recent: quotes });
      }
      if (path === '/pay/receipts/verify' && method === 'POST') {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return apiError(400, 'bad_json', 'Send the receipt as JSON.');
        }
        const receipt = (body as { receipt?: unknown })?.receipt ?? body;
        return json({ valid: gateway.verifyReceipt(receipt) });
      }

      // ---- the buyer's browser comes back from PayPal
      if (path === '/pay/return' && method === 'GET') {
        const orderId = url.searchParams.get('token') ?? '';
        const q = gateway.quoteByOrder(orderId);
        if (!q) return html(returnPage({ ok: false, title: 'Payment not found', message: `No payment matches PayPal order ${orderId}.` }), 404);
        const out = await gateway.capture(q.id, null);
        const items = lineItems(q.id);
        const total = toValue(q.total_cents);
        if (out.ok && out.status === 200) {
          const b = out.body as { paypal?: { capture_id?: string }; receipt?: { receipt_id?: string } };
          return html(returnPage({ ok: true, title: 'Payment approved', message: `Paid $${total}. Your agent can now collect the data.`, items, total, orderId, captureId: b.paypal?.capture_id, receiptId: b.receipt?.receipt_id }));
        }
        if (out.ok && out.status === 202) return html(returnPage({ ok: true, title: 'Payment on hold', message: 'PayPal is reviewing this payment. Your agent gets the data once PayPal confirms it.', items, total, orderId }));
        return html(returnPage({ ok: false, title: 'Payment not completed', message: out.ok ? 'Unexpected state.' : out.message, items, total, orderId }), out.ok ? 200 : out.status);
      }
      if (path === '/pay/cancel' && method === 'GET') {
        const orderId = url.searchParams.get('token') ?? '';
        const out = gateway.cancelByOrder(orderId);
        return html(returnPage({ ok: false, title: 'Payment cancelled', message: out.ok ? 'You cancelled. No money moved and your agent was told.' : out.message, orderId }), out.ok ? 200 : out.status);
      }

      // ---- PayPal webhooks: raw body kept exactly as received for signature verification
      if (path === '/paypal/webhook' && method === 'POST') {
        const raw = await req.text();
        return fromOutcome(await gateway.webhook(raw, req.headers));
      }

      // ---- seller view of the ledger
      if (path === '/ledger.json' && method === 'GET') {
        const entries = gateway.opts.ledger.entries();
        const check = Ledger.check(entries);
        let captured = 0;
        let refunded = 0;
        for (const e of entries) {
          if (e.type === 'payment_captured' && e.amount) captured += toCents(e.amount);
          if (e.type === 'refunded' && e.amount) refunded += toCents(e.amount);
        }
        return json({ paypal: gateway.environment, check, totals: { captured: toValue(captured), refunded: toValue(refunded), net: toValue(Math.max(0, captured - refunded)), entries: entries.length }, entries });
      }

      // ---- MCP for agents over HTTP
      if (path === '/mcp') {
        if (method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST for MCP messages. This server does not open SSE streams.', {}, { allow: 'POST, OPTIONS' });
        const key = agentKey(req);
        if (!key || !gateway.agentByKey(key)) return apiError(401, 'agent_key_required', 'Send a valid agent key in x-agent-key.');
        let body: JsonRpcMessage | JsonRpcMessage[];
        try {
          body = (await req.json()) as JsonRpcMessage | JsonRpcMessage[];
        } catch {
          return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
        }
        const api = httpPayApi(url.origin, key, (u, init) => self(new Request(u, init)));
        if (Array.isArray(body)) {
          const out = (await Promise.all(body.map((msg) => handleMcpMessage(msg, api)))).filter(Boolean);
          return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
        }
        const out = await handleMcpMessage(body, api);
        return out ? json(out) : new Response(null, { status: 202, headers: CORS });
      }

      // ---- mock mode: the stand-in for PayPal's approval screen
      if (mock && path === '/mock-paypal/checkoutnow' && method === 'GET') {
        const token = url.searchParams.get('token') ?? '';
        const order = mock.getStoredOrder(token);
        if (!order) return html(returnPage({ ok: false, title: 'Order not found', message: `No mock order ${token}.` }), 404);
        const q = gateway.quoteByOrder(token);
        return html(mockCheckoutPage({ orderId: token, agentName: q?.agent_name ?? 'An agent', items: lineItems(q?.id), total: order.purchase_units?.[0]?.amount?.value ?? '0.00', status: order.status }));
      }
      if (mock && (path === '/mock-paypal/approve' || path === '/mock-paypal/cancel') && method === 'POST') {
        const form = new URLSearchParams(await req.text());
        const token = form.get('token') ?? url.searchParams.get('token') ?? '';
        let target: string;
        try {
          target = path.endsWith('approve') ? mock.approve(token) : mock.cancel(token);
        } catch (e) {
          return html(returnPage({ ok: false, title: 'Could not do that', message: (e as Error).message }), 409);
        }
        // Like PayPal, send the browser back to the return or cancel URL, which is relative to this server.
        const t = new URL(target);
        return new Response(null, { status: 303, headers: { location: t.pathname + t.search } });
      }

      return apiError(404, 'not_found', `No route for ${method} ${path}.`);
    } catch (e) {
      console.error(e);
      return apiError(500, 'internal_error', 'Server error.');
    }
  };
  return self;
}
