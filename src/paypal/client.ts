// PayPal REST client for exactly the calls this project makes. Checked in October 2026 against
// PayPal's Orders v2 OpenAPI spec (version 2.36), the Webhooks v1 spec, and the checklist in the
// PayPal AI Toolkit best-practices skill (github.com/paypal/AI-Toolkit).
//
//   POST /v1/oauth2/token                            client credentials; token cached until shortly before expires_in
//   POST /v2/checkout/orders                         create an order: intent CAPTURE, PayPal wallet, no shipping
//   GET  /v2/checkout/orders/{id}                    read an order
//   POST /v2/checkout/orders/{id}/capture            capture after the buyer approves
//   POST /v1/notifications/verify-webhook-signature  check that a webhook really came from PayPal
//
// Rules it follows:
// - Every Orders and webhook POST carries a PayPal-Request-Id. Retries reuse it, so a retry can never charge twice.
// - 429 and 5xx are retried with backoff, honouring Retry-After. 401 refreshes the token once.
// - Every error keeps PayPal's debug_id (needed when contacting PayPal support) and the detail issue name.
// - Credentials only come from the caller (environment variables), never from code.

import { randomUUID } from 'node:crypto';
import { toValue, type Cents } from '../lib/money.ts';

export const SANDBOX_API = 'https://api-m.sandbox.paypal.com';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface Money {
  currency_code: string;
  value: string;
}
export interface Link {
  href: string;
  rel: string;
  method?: string;
}
export interface Capture {
  id: string;
  status: 'COMPLETED' | 'DECLINED' | 'PARTIALLY_REFUNDED' | 'PENDING' | 'REFUNDED' | 'FAILED';
  status_details?: { reason?: string };
  amount: Money;
  custom_id?: string;
  invoice_id?: string;
  final_capture?: boolean;
  seller_receivable_breakdown?: { gross_amount: Money; paypal_fee?: Money; net_amount?: Money };
  create_time?: string;
  links?: Link[];
}
export interface PurchaseUnit {
  reference_id?: string;
  custom_id?: string;
  invoice_id?: string;
  description?: string;
  amount?: Money & { breakdown?: { item_total?: Money } };
  items?: Array<{ name: string; quantity: string; unit_amount: Money; sku?: string; category?: string }>;
  payments?: { captures?: Capture[] };
}
export interface Order {
  id: string;
  status: 'CREATED' | 'SAVED' | 'APPROVED' | 'VOIDED' | 'COMPLETED' | 'PAYER_ACTION_REQUIRED';
  intent?: string;
  purchase_units?: PurchaseUnit[];
  payer?: { payer_id?: string; email_address?: string; name?: { given_name?: string; surname?: string } };
  links?: Link[];
  create_time?: string;
}

export interface OrderLine {
  /** Shown to the buyer in PayPal. PayPal returns at most 127 characters. */
  name: string;
  sku: string;
  unitCents: Cents;
  quantity: number;
}

export interface CreateOrderInput {
  /** Our quote id. Used as reference_id, custom_id and invoice_id so every PayPal record points back to it. */
  quoteId: string;
  description: string;
  currency: 'USD';
  lines: OrderLine[];
  brandName: string;
  returnUrl: string;
  cancelUrl: string;
}

/** PayPal error with the fields you need to act on it. */
export class PayPalError extends Error {
  readonly status: number;
  /** PayPal error name, for example UNPROCESSABLE_ENTITY or RESOURCE_NOT_FOUND. */
  readonly code: string;
  /** First detail issue, for example ORDER_NOT_APPROVED or INSTRUMENT_DECLINED. */
  readonly issue: string | undefined;
  readonly debugId: string | undefined;
  readonly links: Link[];

  constructor(status: number, code: string, message: string, issue?: string, debugId?: string, links: Link[] = []) {
    super(message);
    this.status = status;
    this.code = code;
    this.issue = issue;
    this.debugId = debugId;
    this.links = links;
  }

  static from(status: number, body: unknown): PayPalError {
    const b = (body ?? {}) as Record<string, unknown>;
    const details = Array.isArray(b.details) ? (b.details as Array<Record<string, unknown>>) : [];
    const issue = details.length ? String(details[0].issue ?? '') || undefined : undefined;
    const code = String(b.name ?? b.error ?? `HTTP_${status}`);
    const message = String(b.message ?? b.error_description ?? (details[0]?.description as string | undefined) ?? `PayPal answered HTTP ${status}`);
    return new PayPalError(status, code, message, issue, b.debug_id ? String(b.debug_id) : undefined, Array.isArray(b.links) ? (b.links as Link[]) : []);
  }
}

/** The JSON body for POST /v2/checkout/orders. Exported so tests can check its shape against the spec. */
export function orderRequestBody(input: CreateOrderInput) {
  if (!input.lines.length) throw new Error('An order needs at least one line.');
  const money = (cents: Cents): Money => ({ currency_code: input.currency, value: toValue(cents) });
  const total = input.lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
  return {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: input.quoteId,
        custom_id: input.quoteId,
        invoice_id: input.quoteId,
        description: input.description.slice(0, 127),
        amount: { ...money(total), breakdown: { item_total: money(total) } },
        items: input.lines.map((l) => ({
          name: l.name.slice(0, 127),
          sku: l.sku.slice(0, 127),
          quantity: String(l.quantity),
          unit_amount: money(l.unitCents),
          category: 'DIGITAL_GOODS',
        })),
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: input.brandName.slice(0, 127),
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          landing_page: 'LOGIN',
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
        },
      },
    },
  };
}

/** The link the buyer opens to approve. PayPal calls it "payer-action" when payment_source.paypal is sent, "approve" otherwise. */
export function approvalUrl(order: Pick<Order, 'links'>): string | null {
  const links = order.links ?? [];
  return (links.find((l) => l.rel === 'payer-action') ?? links.find((l) => l.rel === 'approve'))?.href ?? null;
}

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  /** Retries after the first attempt for 429, 5xx and network errors. Default 3. */
  maxRetries?: number;
}

export class PayPalClient {
  readonly baseUrl: string;
  private readonly opts: PayPalClientOptions;
  private readonly doFetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private token: { value: string; expiresAt: number } | null = null;
  private pendingToken: Promise<string> | null = null;

  constructor(opts: PayPalClientOptions) {
    if (!opts.clientId || !opts.clientSecret) throw new Error('PayPal client id and secret are required.');
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? SANDBOX_API).replace(/\/+$/, '');
    this.doFetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? (() => {});
  }

  /** Cached OAuth token. Concurrent callers share one token request. */
  async accessToken(): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt) return this.token.value;
    this.pendingToken ??= this.fetchToken().finally(() => {
      this.pendingToken = null;
    });
    return this.pendingToken;
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
    const max = this.opts.maxRetries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}/v1/oauth2/token`, {
          method: 'POST',
          headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: 'grant_type=client_credentials',
        });
      } catch (e) {
        if (attempt < max) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new PayPalError(0, 'NETWORK_ERROR', `Could not reach PayPal: ${(e as Error).message}`);
      }
      const body = parseJson(await res.text());
      if ((res.status === 429 || res.status >= 500) && attempt < max) {
        await this.sleep(retryAfterMs(res, attempt));
        continue;
      }
      if (!res.ok) {
        const err = PayPalError.from(res.status, body);
        this.log(`PayPal token request failed: HTTP ${res.status} ${err.code}: ${err.message}`);
        throw err;
      }
      const b = body as { access_token?: string; expires_in?: number };
      if (!b.access_token) throw new PayPalError(res.status, 'BAD_TOKEN_RESPONSE', 'PayPal returned no access_token.');
      // Refresh a minute early, and never cache for less than 10 seconds.
      const ttl = Math.max(10, (Number(b.expires_in) || 0) - 60);
      this.token = { value: b.access_token, expiresAt: this.now() + ttl * 1000 };
      return b.access_token;
    }
  }

  private async call<T>(method: 'GET' | 'POST', path: string, opts: { json?: unknown; rawJson?: string; requestId?: string; prefer?: string } = {}): Promise<T> {
    const requestId = method === 'POST' ? (opts.requestId ?? randomUUID()) : undefined;
    const body = opts.rawJson ?? (opts.json === undefined ? undefined : JSON.stringify(opts.json));
    const max = this.opts.maxRetries ?? 3;
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (requestId) headers['paypal-request-id'] = requestId;
      if (opts.prefer) headers.prefer = opts.prefer;
      let res: Response;
      try {
        res = await this.doFetch(this.baseUrl + path, { method, headers, body });
      } catch (e) {
        if (attempt < max) {
          await this.sleep(backoffMs(attempt));
          continue;
        }
        throw new PayPalError(0, 'NETWORK_ERROR', `Could not reach PayPal: ${(e as Error).message}`);
      }
      const parsed = parseJson(await res.text());
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.token = null;
        attempt--;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < max) {
        this.log(`PayPal ${method} ${path} answered ${res.status}; retrying (attempt ${attempt + 2} of ${max + 1}) with the same PayPal-Request-Id.`);
        await this.sleep(retryAfterMs(res, attempt));
        continue;
      }
      if (!res.ok) {
        const err = PayPalError.from(res.status, parsed);
        this.log(`PayPal ${method} ${path} failed: HTTP ${res.status} ${err.code}${err.issue ? ` (${err.issue})` : ''} debug_id=${err.debugId ?? 'none'}`);
        throw err;
      }
      return parsed as T;
    }
  }

  createOrder(input: CreateOrderInput, requestId: string): Promise<Order> {
    return this.call<Order>('POST', '/v2/checkout/orders', { json: orderRequestBody(input), requestId, prefer: 'return=representation' });
  }

  getOrder(orderId: string): Promise<Order> {
    return this.call<Order>('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
  }

  /** Capture an approved order. Reusing the same requestId makes a repeated capture return the first result. */
  captureOrder(orderId: string, requestId: string): Promise<Order> {
    return this.call<Order>('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { requestId, prefer: 'return=representation' });
  }

  /**
   * Ask PayPal whether a webhook delivery is genuine. The event is embedded as the raw bytes we received,
   * never re-serialized, because PayPal signed those exact bytes.
   */
  async verifyWebhookSignature(headers: Headers, rawBody: string, webhookId: string): Promise<boolean> {
    const h = (name: string) => headers.get(name) ?? '';
    const fields = {
      auth_algo: h('paypal-auth-algo'),
      cert_url: h('paypal-cert-url'),
      transmission_id: h('paypal-transmission-id'),
      transmission_sig: h('paypal-transmission-sig'),
      transmission_time: h('paypal-transmission-time'),
      webhook_id: webhookId,
    };
    if (!fields.transmission_id || !fields.transmission_sig) return false;
    const head = JSON.stringify(fields);
    const rawJson = `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
    const res = await this.call<{ verification_status?: string }>('POST', '/v1/notifications/verify-webhook-signature', { rawJson });
    return res.verification_status === 'SUCCESS';
  }
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function backoffMs(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt);
}

function retryAfterMs(res: Response, attempt: number): number {
  const ra = Number(res.headers.get('retry-after'));
  return Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : backoffMs(attempt);
}
