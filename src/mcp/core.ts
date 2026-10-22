// Model Context Protocol server for buying agents: JSON-RPC 2.0 in, responses out.
// The tools talk to the gateway's HTTP API with the agent's key, so the same core runs over stdio
// (src/mcp/stdio.ts, for Claude Desktop or Claude Code on the buyer's machine) and over Streamable
// HTTP at POST /mcp on the gateway itself.
//
// The agent never sees or enters payment details. It gets a PayPal approval link, shows it to its
// person, and waits. Every payment is approved by a human in PayPal.

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

export interface PayApi {
  prices(): Promise<ApiResult>;
  quote(calls: string[]): Promise<ApiResult>;
  checkout(quoteId: string): Promise<ApiResult>;
  capture(quoteId: string): Promise<ApiResult>;
  status(quoteId: string): Promise<ApiResult>;
  spending(): Promise<ApiResult>;
}

/** PayApi over HTTP. baseUrl is the gateway, agentKey is sent as x-agent-key. */
export function httpPayApi(baseUrl: string, agentKey: string, doFetch: FetchLike = (u, i) => fetch(u, i)): PayApi {
  const base = baseUrl.replace(/\/+$/, '');
  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult> {
    const headers: Record<string, string> = { accept: 'application/json', 'x-agent-key': agentKey };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await doFetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      return { status: 0, body: { error: { code: 'gateway_unreachable', message: `Could not reach the payment gateway at ${base}: ${(e as Error).message}` } } };
    }
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      return { status: res.status, body: { error: { code: 'bad_response', message: text.slice(0, 200) } } };
    }
  }
  const q = (id: string) => encodeURIComponent(id);
  return {
    prices: () => call('GET', '/v1/prices'),
    quote: (calls) => call('POST', '/pay/quotes', { calls }),
    checkout: (id) => call('POST', `/pay/quotes/${q(id)}/checkout`),
    capture: (id) => call('POST', `/pay/quotes/${q(id)}/capture`),
    status: (id) => call('GET', `/pay/quotes/${q(id)}`),
    spending: () => call('GET', '/pay/spending'),
  };
}

export const SERVER_INFO = { name: 'plainfeed-agent-pay', title: 'Plainfeed data, paid per call with PayPal', version: '0.1.0' };
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const QUOTE_ID = { type: 'string', description: 'Quote id from get_quote, for example q_7f3k9m2x4c1a.' };

export const TOOLS = [
  {
    name: 'list_prices',
    title: 'List prices',
    description: 'See what data is for sale and what each call costs in US dollars. Paid calls go through get_quote, start_payment, the user approving in PayPal, then finish_payment.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  {
    name: 'get_quote',
    title: 'Get a price quote',
    description:
      'Price one or more data calls as one payment. Put everything you need in one quote, because each quote is one PayPal payment the user must approve. Calls are paths, for example "/v1/compare?a=lisbon&b=madrid", "/v1/cities/pt-lisbon", "/v1/cities?q=tokyo". Returns the total and how much this agent may still spend today. Nothing is charged yet.',
    inputSchema: {
      type: 'object',
      properties: { calls: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Paths to buy, 1 to 10.' } },
      required: ['calls'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: false },
  },
  {
    name: 'start_payment',
    title: 'Start the PayPal payment',
    description:
      'Create the PayPal payment for a quote. Returns a PayPal link. Show the user the amount and the link, ask them to approve it in PayPal, and wait until they say they are done. Never open, click or approve the link yourself.',
    inputSchema: { type: 'object', properties: { quote_id: QUOTE_ID }, required: ['quote_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  },
  {
    name: 'finish_payment',
    title: 'Finish the payment and get the data',
    description: 'After the user approves in PayPal, capture the payment and receive the data plus a signed receipt. If the user has not approved yet, it says so and gives the link again. Safe to call more than once; you are never charged twice.',
    inputSchema: { type: 'object', properties: { quote_id: QUOTE_ID }, required: ['quote_id'], additionalProperties: false },
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  },
  {
    name: 'spending_status',
    title: 'Spending today',
    description: 'How much this agent has spent today, how much is waiting for approval, and its limits per payment and per day.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
];

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const ok = (id: JsonRpcMessage['id'], result: unknown) => ({ jsonrpc: '2.0' as const, id: id ?? null, result });
const rpcFail = (id: JsonRpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0' as const, id: id ?? null, error: { code, message } });
export type JsonRpcReply = ReturnType<typeof ok> | ReturnType<typeof rpcFail>;

function toolResult(summary: string, data: unknown, isError = false) {
  return { content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }], structuredContent: data as Record<string, unknown>, isError };
}

function errText(r: ApiResult): string {
  const e = (r.body.error ?? {}) as { message?: string; code?: string };
  return e.message ?? `The gateway answered HTTP ${r.status}.`;
}

type QuoteBody = {
  quote_id: string;
  status: string;
  total: string;
  items: Array<{ description: string; price: string }>;
  paypal?: { order_id?: string; approve_url?: string; capture_id?: string; environment?: string } | null;
  receipt?: { receipt_id: string };
  results?: unknown;
  spending?: { left_today: string; daily_cap: string };
  next?: string;
};

export async function callTool(api: PayApi, name: string, args: Record<string, unknown>) {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  switch (name) {
    case 'list_prices': {
      const r = await api.prices();
      if (r.status !== 200) return toolResult(errText(r), r.body, true);
      const products = (r.body.products ?? []) as Array<{ path: string; price: string; label: string; free: boolean; required: string[] }>;
      const line = products.map((p) => `${p.label}: ${p.free ? 'free' : `$${p.price}`} (${p.path}${p.required.length ? `?${p.required.map((x) => `${x}=...`).join('&')}` : ''})`).join('; ');
      return toolResult(`Prices in USD. ${line}.`, r.body);
    }
    case 'get_quote': {
      const calls = Array.isArray(args.calls) ? args.calls.map(String) : [];
      if (!calls.length) return toolResult('calls is required: a list of paths such as "/v1/compare?a=lisbon&b=madrid".', { error: 'calls is required' }, true);
      const r = await api.quote(calls);
      if (r.status !== 201) return toolResult(`No quote. ${errText(r)}`, r.body, true);
      const b = r.body as unknown as QuoteBody;
      return toolResult(
        `Quote ${b.quote_id}: $${b.total} for ${b.items.length} call${b.items.length === 1 ? '' : 's'} (${b.items.map((i) => `${i.description} $${i.price}`).join(', ')}). This agent can spend $${b.spending?.left_today} more today. Nothing is charged yet. Next: tell the user the price, and if they agree call start_payment with quote_id ${b.quote_id}.`,
        r.body,
      );
    }
    case 'start_payment': {
      const id = str(args.quote_id);
      if (!id) return toolResult('quote_id is required.', { error: 'quote_id is required' }, true);
      const r = await api.checkout(id);
      if (r.status !== 200) return toolResult(`Could not start the payment. ${errText(r)}`, r.body, true);
      const b = r.body as unknown as QuoteBody;
      if (b.status === 'paid') return toolResult(`Quote ${id} is already paid. Call finish_payment to get the data again.`, r.body);
      const where = b.paypal?.environment === 'mock' ? 'the mock checkout (mock mode, no real PayPal)' : 'PayPal (sandbox)';
      return toolResult(
        `Ask the user to approve $${b.total} in ${where} at this link: ${b.paypal?.approve_url}\nWait until they say they approved, then call finish_payment with quote_id ${id}. Do not open or approve the link yourself.`,
        r.body,
      );
    }
    case 'finish_payment': {
      const id = str(args.quote_id);
      if (!id) return toolResult('quote_id is required.', { error: 'quote_id is required' }, true);
      const r = await api.capture(id);
      const b = r.body as unknown as QuoteBody;
      if (r.status === 200 && b.status === 'paid') {
        return toolResult(
          `Paid $${b.total} through PayPal (order ${b.paypal?.order_id}, capture ${b.paypal?.capture_id}). Receipt ${b.receipt?.receipt_id}. The data is in results below. Tell the user it was paid and cite the receipt id.`,
          r.body,
        );
      }
      if (r.status === 202) return toolResult(`PayPal is holding this payment for review. The data will be released when PayPal confirms it. Try finish_payment again in a few minutes.`, r.body);
      const details = (r.body.error ?? {}) as { code?: string; approve_url?: string };
      if (details.code === 'not_approved' || details.code === 'instrument_declined') {
        return toolResult(`${errText(r)} Link: ${details.approve_url}. Ask the user to approve it, then call finish_payment again.`, r.body, true);
      }
      return toolResult(`Not paid. ${errText(r)}`, r.body, true);
    }
    case 'spending_status': {
      const r = await api.spending();
      if (r.status !== 200) return toolResult(errText(r), r.body, true);
      const s = r.body.spending as Record<string, string>;
      return toolResult(
        `${(r.body.agent as { name: string }).name}: spent $${s.spent_today} today, $${s.waiting_for_approval} waiting for approval, $${s.left_today} left. Limits: $${s.order_cap} per payment, $${s.daily_cap} per day (UTC).`,
        r.body,
      );
    }
    default:
      return null;
  }
}

/** Handle one JSON-RPC message. Returns null for notifications and responses. */
export async function handleMcpMessage(msg: JsonRpcMessage, api: PayApi): Promise<JsonRpcReply | null> {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return rpcFail(null, -32600, 'Invalid Request');
  const isRequest = msg.id !== undefined && msg.id !== null && typeof msg.method === 'string';
  if (!isRequest) return null;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  switch (msg.method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      return ok(msg.id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Pay-per-call city cost data, paid with PayPal. Flow: list_prices, get_quote (batch every call you need into one quote), start_payment, then show the user the PayPal link and wait for them to approve, then finish_payment to get the data and a signed receipt. The user approves every payment in PayPal; you never handle payment details. Each agent has limits per payment and per day.',
      });
    }
    case 'ping':
      return ok(msg.id, {});
    case 'tools/list':
      return ok(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const res = await callTool(api, String(params.name ?? ''), (params.arguments ?? {}) as Record<string, unknown>);
      if (!res) return rpcFail(msg.id, -32602, `Unknown tool: ${String(params.name)}`);
      return ok(msg.id, res);
    }
    case 'resources/list':
      return ok(msg.id, { resources: [] });
    case 'prompts/list':
      return ok(msg.id, { prompts: [] });
    default:
      return rpcFail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}
