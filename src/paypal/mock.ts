// A faithful fake of the PayPal REST calls this project uses, so everything runs with no PayPal account.
//
// It answers HTTP the way api-m.sandbox.paypal.com does for these calls: same paths, status codes,
// idempotency behaviour (PayPal-Request-Id), error body shape (name, message, debug_id, details[].issue,
// links) and response shapes (from the Orders v2 spec, version 2.36). The real PayPalClient runs against
// it unchanged; only the base URL and the fetch function differ.
//
// Faked: OAuth tokens, create / get / capture orders, buyer approval and cancel, webhook delivery and
// signature verification, refunds (as webhook events only), and injected failures for tests.
// Not faked: real accounts, risk checks, currency conversion, and fees (always reported as 0.00).

import { randomUUID } from 'node:crypto';
import { hmac, newId } from '../lib/crypto.ts';
import { toCents } from '../lib/money.ts';
import type { Capture, Order, PurchaseUnit } from './client.ts';

export const MOCK_API = 'https://api-m.mock-paypal.invalid';

type Op = 'token' | 'create' | 'get' | 'capture' | 'verify';
interface Failure {
  status: number;
  name: string;
  issue?: string;
  message?: string;
  retryAfter?: number;
}
interface StoredOrder {
  order: Order;
  returnUrl: string;
  cancelUrl: string;
}
interface SentEvent {
  transmissionId: string;
  rawBody: string;
  signature: string;
  time: string;
}
export interface MockCall {
  method: string;
  path: string;
  requestId: string | null;
  prefer: string | null;
  body: unknown;
}

const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function paypalId(length = 17): string {
  let s = '';
  for (let i = 0; i < length; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'mock', ...headers } });
}

function ppError(status: number, name: string, issue: string | undefined, description: string, extraLinks: Order['links'] = []): Response {
  const debug_id = randomUUID().replace(/-/g, '').slice(0, 13);
  const body: Record<string, unknown> = {
    name,
    message: status === 422 ? 'The requested action could not be performed, semantically incorrect, or failed business validation.' : description,
    debug_id,
    details: issue ? [{ issue, description }] : [],
    links: [...(issue ? [{ href: `https://developer.paypal.com/api/rest/reference/orders/v2/errors/#${issue}`, rel: 'information_link', method: 'GET' }] : []), ...(extraLinks ?? [])],
  };
  return json(status, body);
}

export interface MockPayPalOptions {
  /** Base URL of the page where a buyer approves, for example http://localhost:8787/mock-paypal/checkoutnow */
  approvalPageUrl?: string;
  /** Where webhook events are delivered (the gateway's handler). Optional. */
  webhookSink?: (req: Request) => Promise<Response>;
  webhookUrl?: string;
  now?: () => Date;
}

export class MockPayPal {
  readonly baseUrl = MOCK_API;
  readonly clientId = 'mock-client-id';
  readonly clientSecret = 'mock-client-secret';
  readonly webhookId = 'MOCK-WEBHOOK-1';
  readonly merchantId = 'MOCKMERCHANT1';
  approvalPageUrl: string;
  webhookSink: ((req: Request) => Promise<Response>) | undefined;
  webhookUrl: string;
  /** Every API call received, for tests. */
  readonly calls: MockCall[] = [];
  /** Events waiting for deliverWebhooks(). */
  readonly outbox: string[] = [];
  /** What the next successful capture reports. */
  captureOutcome: 'COMPLETED' | 'PENDING' | 'DECLINED' = 'COMPLETED';
  tokensIssued = 0;

  private readonly now: () => Date;
  private readonly orders = new Map<string, StoredOrder>();
  private readonly tokens = new Map<string, number>();
  private readonly idempotent = new Map<string, { status: number; body: unknown }>();
  private readonly invoiceIds = new Set<string>();
  private readonly failures = new Map<Op, Failure[]>();
  private readonly sent = new Map<string, SentEvent>();
  private readonly signingSecret = randomUUID();

  constructor(opts: MockPayPalOptions = {}) {
    this.approvalPageUrl = opts.approvalPageUrl ?? 'http://localhost:8787/mock-paypal/checkoutnow';
    this.webhookSink = opts.webhookSink;
    this.webhookUrl = opts.webhookUrl ?? 'http://localhost:8787/paypal/webhook';
    this.now = opts.now ?? (() => new Date());
  }

  /** Make the next call of this kind fail (or return 429 with Retry-After). Queued in order. */
  failNext(op: Op, failure: Failure, times = 1): void {
    const list = this.failures.get(op) ?? [];
    for (let i = 0; i < times; i++) list.push(failure);
    this.failures.set(op, list);
  }

  getStoredOrder(id: string): Order | undefined {
    return this.orders.get(id)?.order;
  }

  /** The buyer approves the order in "PayPal". Returns the return_url the browser is sent to. */
  approve(orderId: string): string {
    const s = this.orders.get(orderId);
    if (!s) throw new Error(`No mock order ${orderId}`);
    if (s.order.status !== 'PAYER_ACTION_REQUIRED' && s.order.status !== 'CREATED') throw new Error(`Order ${orderId} is ${s.order.status}, not waiting for approval`);
    s.order.status = 'APPROVED';
    s.order.payer = { payer_id: 'MOCKBUYER0001', email_address: 'sandbox-buyer@example.com', name: { given_name: 'Sandbox', surname: 'Buyer' } };
    s.order.links = [this.selfLink(orderId), { href: `${this.baseUrl}/v2/checkout/orders/${orderId}/capture`, rel: 'capture', method: 'POST' }];
    const u = new URL(s.returnUrl);
    u.searchParams.set('token', orderId);
    u.searchParams.set('PayerID', 'MOCKBUYER0001');
    return u.toString();
  }

  /** The buyer clicks cancel. Returns the cancel_url the browser is sent to. */
  cancel(orderId: string): string {
    const s = this.orders.get(orderId);
    if (!s) throw new Error(`No mock order ${orderId}`);
    const u = new URL(s.cancelUrl);
    u.searchParams.set('token', orderId);
    return u.toString();
  }

  /** The merchant refunds a capture from the PayPal dashboard: emits PAYMENT.CAPTURE.REFUNDED. */
  refund(captureId: string): void {
    for (const { order } of this.orders.values()) {
      const pu = order.purchase_units?.[0];
      const cap = pu?.payments?.captures?.find((c) => c.id === captureId);
      if (!cap) continue;
      cap.status = 'REFUNDED';
      const refundId = paypalId();
      this.queueEvent('PAYMENT.CAPTURE.REFUNDED', 'refund', `A ${cap.amount.value} ${cap.amount.currency_code} capture payment was refunded`, {
        id: refundId,
        status: 'COMPLETED',
        amount: cap.amount,
        custom_id: cap.custom_id,
        invoice_id: cap.invoice_id,
        create_time: this.now().toISOString(),
        links: [
          { href: `${this.baseUrl}/v2/payments/refunds/${refundId}`, rel: 'self', method: 'GET' },
          { href: `${this.baseUrl}/v2/payments/captures/${captureId}`, rel: 'up', method: 'GET' },
        ],
      });
      return;
    }
    throw new Error(`No mock capture ${captureId}`);
  }

  /** POST every queued event to the webhook sink, signed like a PayPal delivery. Returns the HTTP statuses. */
  async deliverWebhooks(): Promise<number[]> {
    if (!this.webhookSink) throw new Error('No webhook sink configured on the mock.');
    const statuses: number[] = [];
    while (this.outbox.length) {
      const rawBody = this.outbox.shift() as string;
      const transmissionId = randomUUID();
      const time = this.now().toISOString();
      const signature = hmac(this.signingSecret, `${transmissionId}|${time}|${this.webhookId}|${rawBody}`);
      this.sent.set(transmissionId, { transmissionId, rawBody, signature, time });
      const res = await this.webhookSink(
        new Request(this.webhookUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'paypal-auth-algo': 'SHA256withRSA',
            'paypal-cert-url': `${this.baseUrl}/v1/notifications/certs/CERT-MOCK`,
            'paypal-transmission-id': transmissionId,
            'paypal-transmission-sig': signature,
            'paypal-transmission-time': time,
          },
          body: rawBody,
        }),
      );
      statuses.push(res.status);
    }
    return statuses;
  }

  /** fetch() replacement that answers like the PayPal REST API. */
  fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    if (u.origin !== this.baseUrl) return json(404, { name: 'NOT_FOUND', message: `Mock PayPal only serves ${this.baseUrl}` });
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const rawBody = typeof init.body === 'string' ? init.body : '';
    let body: unknown = undefined;
    if (rawBody && (headers.get('content-type') ?? '').includes('json')) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        return ppError(400, 'INVALID_REQUEST', 'MALFORMED_REQUEST_JSON', 'The request JSON is not well formed.');
      }
    }
    const requestId = headers.get('paypal-request-id');
    this.calls.push({ method, path: u.pathname, requestId, prefer: headers.get('prefer'), body: body ?? (rawBody || undefined) });

    if (method === 'POST' && u.pathname === '/v1/oauth2/token') return this.token(headers, rawBody);

    const auth = headers.get('authorization') ?? '';
    const tok = auth.replace(/^Bearer\s+/i, '');
    const exp = this.tokens.get(tok);
    if (!exp || exp < this.now().getTime()) return json(401, { error: 'invalid_token', error_description: 'Token signature verification failed' });

    let m: RegExpExecArray | null;
    if (method === 'POST' && u.pathname === '/v2/checkout/orders') return this.idem('create', requestId, () => this.create(body, headers.get('prefer')));
    if (method === 'GET' && (m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(u.pathname))) return this.get(m[1]);
    if (method === 'POST' && (m = /^\/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(u.pathname))) {
      const id = m[1];
      return this.idem(`capture:${id}`, requestId, () => this.capture(id));
    }
    if (method === 'POST' && u.pathname === '/v1/notifications/verify-webhook-signature') return this.verify(body);
    return json(404, { name: 'RESOURCE_NOT_FOUND', message: 'The specified resource does not exist.', debug_id: 'mock', details: [{ issue: 'INVALID_RESOURCE_ID' }] });
  };

  private takeFailure(op: Op): Response | null {
    const f = this.failures.get(op)?.shift();
    if (!f) return null;
    if (f.status === 429) return json(429, { name: 'RATE_LIMIT_REACHED', message: 'Too many requests. Blocked due to rate limiting.', debug_id: 'mock' }, { 'retry-after': String(f.retryAfter ?? 1) });
    return ppError(f.status, f.name, f.issue, f.message ?? f.issue ?? f.name);
  }

  private token(headers: Headers, rawBody: string): Response {
    const failed = this.takeFailure('token');
    if (failed) return failed;
    const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    if (headers.get('authorization') !== expected) return json(401, { error: 'invalid_client', error_description: 'Client Authentication failed' });
    if (!/grant_type=client_credentials/.test(rawBody)) return json(400, { error: 'unsupported_grant_type', error_description: 'Grant Type is NULL' });
    const access = `A21AA${randomUUID().replace(/-/g, '')}`;
    const expiresIn = 28800;
    this.tokens.set(access, this.now().getTime() + expiresIn * 1000);
    this.tokensIssued++;
    return json(200, { scope: 'https://uri.paypal.com/services/payments/payment', access_token: access, token_type: 'Bearer', app_id: 'APP-MOCK', expires_in: expiresIn, nonce: randomUUID() });
  }

  /** PayPal-Request-Id: a repeat of the same request id returns the stored first response with HTTP 200. */
  private idem(scope: string, requestId: string | null, run: () => Response | Promise<Response>): Promise<Response> | Response {
    const op: Op = scope === 'create' ? 'create' : 'capture';
    const failed = this.takeFailure(op);
    if (failed) return failed;
    if (requestId) {
      const prior = this.idempotent.get(`${scope}|${requestId}`);
      if (prior) return json(200, prior.body);
    }
    return Promise.resolve(run()).then(async (res) => {
      if (requestId && res.status < 300) this.idempotent.set(`${scope}|${requestId}`, { status: res.status, body: await res.clone().json() });
      return res;
    });
  }

  private selfLink(id: string) {
    return { href: `${this.baseUrl}/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' };
  }

  private create(body: unknown, prefer: string | null): Response {
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.intent !== 'CAPTURE' && b.intent !== 'AUTHORIZE') return ppError(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'A required field / parameter is missing: intent.');
    if (b.intent === 'AUTHORIZE') return ppError(422, 'UNPROCESSABLE_ENTITY', 'UNSUPPORTED_INTENT', 'The mock only implements intent CAPTURE.');
    const units = b.purchase_units as PurchaseUnit[] | undefined;
    if (!Array.isArray(units) || units.length < 1 || units.length > 10) return ppError(400, 'INVALID_REQUEST', 'MISSING_REQUIRED_PARAMETER', 'purchase_units must hold 1 to 10 units.');
    if (units.length !== 1) return ppError(422, 'UNPROCESSABLE_ENTITY', 'MULTIPLE_PURCHASE_UNITS_NOT_SUPPORTED', 'The mock supports one purchase unit.');
    const pu = units[0];
    const amount = pu.amount;
    if (!amount || !/^[A-Z]{3}$/.test(amount.currency_code ?? '') || !/^\d{1,10}(\.\d{2})?$/.test(amount.value ?? '')) {
      return ppError(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE', 'purchase_units[0].amount must have a currency_code and a value like "1.00".');
    }
    if (pu.items?.length) {
      const itemTotal = amount.breakdown?.item_total;
      if (!itemTotal) return ppError(422, 'UNPROCESSABLE_ENTITY', 'ITEM_TOTAL_REQUIRED', 'If item details are specified, item_total is required.');
      let sum = 0;
      for (const it of pu.items) {
        if (!it.name || it.name.length > 127) return ppError(400, 'INVALID_REQUEST', 'INVALID_STRING_LENGTH', 'Item name must be 1 to 127 characters.');
        if (!/^[1-9][0-9]{0,9}$/.test(it.quantity)) return ppError(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_SYNTAX', 'Item quantity must be a whole number string.');
        if (it.unit_amount?.currency_code !== amount.currency_code) return ppError(422, 'UNPROCESSABLE_ENTITY', 'CURRENCY_MISMATCH', 'Currency of all items must match the order currency.');
        sum += toCents(it.unit_amount.value) * Number(it.quantity);
      }
      if (sum !== toCents(itemTotal.value)) return ppError(422, 'UNPROCESSABLE_ENTITY', 'ITEM_TOTAL_MISMATCH', 'Should equal sum of (unit_amount * quantity) across all items for a given purchase_unit.');
      if (toCents(itemTotal.value) !== toCents(amount.value)) return ppError(422, 'UNPROCESSABLE_ENTITY', 'AMOUNT_MISMATCH', 'Should equal item_total + tax_total + shipping + handling + insurance - shipping_discount - discount.');
    }
    if (pu.invoice_id) {
      if (this.invoiceIds.has(pu.invoice_id)) return ppError(422, 'UNPROCESSABLE_ENTITY', 'DUPLICATE_INVOICE_ID', 'Duplicate Invoice ID detected. To avoid a potential duplicate transaction your account setting requires that Invoice Id be unique for each transaction.');
      this.invoiceIds.add(pu.invoice_id);
    }
    const ctx = ((b.payment_source as Record<string, unknown> | undefined)?.paypal as Record<string, unknown> | undefined)?.experience_context as Record<string, string> | undefined;
    const withSource = !!ctx;
    for (const k of ['return_url', 'cancel_url'] as const) {
      if (withSource && !/^https?:\/\//.test(ctx?.[k] ?? '')) return ppError(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_SYNTAX', `${k} must be an absolute http(s) URL.`);
    }
    const id = paypalId();
    const order: Order = {
      id,
      intent: 'CAPTURE',
      status: withSource ? 'PAYER_ACTION_REQUIRED' : 'CREATED',
      purchase_units: [
        {
          reference_id: pu.reference_id ?? 'default',
          amount: pu.amount,
          description: pu.description,
          custom_id: pu.custom_id,
          invoice_id: pu.invoice_id,
          items: pu.items,
        },
      ],
      create_time: this.now().toISOString(),
      links: [
        this.selfLink(id),
        withSource ? { href: `${this.approvalPageUrl}?token=${id}`, rel: 'payer-action', method: 'GET' } : { href: `${this.approvalPageUrl}?token=${id}`, rel: 'approve', method: 'GET' },
      ],
    };
    this.orders.set(id, { order, returnUrl: ctx?.return_url ?? 'http://localhost/return', cancelUrl: ctx?.cancel_url ?? 'http://localhost/cancel' });
    const minimal = prefer !== 'return=representation';
    return json(201, minimal ? { id, status: order.status, ...(withSource ? { payment_source: { paypal: {} } } : {}), links: order.links } : { ...order, payment_source: withSource ? { paypal: {} } : undefined });
  }

  private get(id: string): Response {
    const failed = this.takeFailure('get');
    if (failed) return failed;
    const s = this.orders.get(id);
    if (!s) return ppError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist. Please check the resource ID and try again.');
    return json(200, s.order);
  }

  private capture(id: string): Response {
    const s = this.orders.get(id);
    if (!s) return ppError(404, 'RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID', 'Specified resource ID does not exist. Please check the resource ID and try again.');
    const o = s.order;
    if (o.status === 'COMPLETED') return ppError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED', "Order already captured.If 'intent=CAPTURE' only one capture per order is allowed.");
    if (o.status !== 'APPROVED') return ppError(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED', "Payer has not yet approved the Order for payment. Please redirect the payer to the 'rel':'approve' url returned as part of the HATEOAS links within the Create Order call or provide a valid payment_source in the request.");
    const pu = o.purchase_units?.[0] as PurchaseUnit;
    if (this.captureOutcome === 'DECLINED') {
      // The buyer's funding source was declined: they must approve again with another one.
      o.status = 'PAYER_ACTION_REQUIRED';
      const again = { href: `${this.approvalPageUrl}?token=${id}`, rel: 'payer-action', method: 'GET' };
      o.links = [this.selfLink(id), again];
      return ppError(422, 'UNPROCESSABLE_ENTITY', 'INSTRUMENT_DECLINED', 'The instrument presented was either declined by the processor or bank, or it can\'t be used for this payment.', [{ href: again.href, rel: 'redirect', method: 'GET' }]);
    }
    const captureId = paypalId();
    const amount = pu.amount as { currency_code: string; value: string };
    const capture: Capture = {
      id: captureId,
      status: this.captureOutcome === 'PENDING' ? 'PENDING' : 'COMPLETED',
      ...(this.captureOutcome === 'PENDING' ? { status_details: { reason: 'PENDING_REVIEW' } } : {}),
      amount: { currency_code: amount.currency_code, value: amount.value },
      final_capture: true,
      seller_receivable_breakdown: {
        gross_amount: { currency_code: amount.currency_code, value: amount.value },
        paypal_fee: { currency_code: amount.currency_code, value: '0.00' },
        net_amount: { currency_code: amount.currency_code, value: amount.value },
      },
      custom_id: pu.custom_id,
      invoice_id: pu.invoice_id,
      create_time: this.now().toISOString(),
      links: [
        { href: `${this.baseUrl}/v2/payments/captures/${captureId}`, rel: 'self', method: 'GET' },
        { href: `${this.baseUrl}/v2/payments/captures/${captureId}/refund`, rel: 'refund', method: 'POST' },
        { href: `${this.baseUrl}/v2/checkout/orders/${id}`, rel: 'up', method: 'GET' },
      ],
    };
    pu.payments = { captures: [capture] };
    o.status = 'COMPLETED';
    o.links = [this.selfLink(id)];
    const evt = capture.status === 'COMPLETED' ? 'PAYMENT.CAPTURE.COMPLETED' : 'PAYMENT.CAPTURE.PENDING';
    this.queueEvent(evt, 'capture', `Payment ${capture.status === 'COMPLETED' ? 'completed' : 'pending'} for $ ${amount.value} ${amount.currency_code}`, {
      ...capture,
      supplementary_data: { related_ids: { order_id: id } },
    });
    return new Response(JSON.stringify(o), { status: 201, headers: { 'content-type': 'application/json' } });
  }

  /** The PayPal side of capture completing later (after a PENDING review). */
  completePendingCapture(captureId: string): void {
    for (const { order } of this.orders.values()) {
      const cap = order.purchase_units?.[0]?.payments?.captures?.find((c) => c.id === captureId);
      if (!cap) continue;
      cap.status = 'COMPLETED';
      delete cap.status_details;
      this.queueEvent('PAYMENT.CAPTURE.COMPLETED', 'capture', `Payment completed for $ ${cap.amount.value} ${cap.amount.currency_code}`, { ...cap, supplementary_data: { related_ids: { order_id: order.id } } });
      return;
    }
    throw new Error(`No mock capture ${captureId}`);
  }

  private queueEvent(eventType: string, resourceType: string, summary: string, resource: unknown): void {
    const event = {
      id: `WH-${paypalId(8)}-${paypalId(17)}`,
      event_version: '1.0',
      create_time: this.now().toISOString(),
      resource_type: resourceType,
      resource_version: '2.0',
      event_type: eventType,
      summary,
      resource,
      links: [{ href: `${this.baseUrl}/v1/notifications/webhooks-events/${newId('evt')}`, rel: 'self', method: 'GET' }],
    };
    this.outbox.push(JSON.stringify(event));
  }

  private verify(body: unknown): Response {
    const failed = this.takeFailure('verify');
    if (failed) return failed;
    const b = (body ?? {}) as Record<string, unknown>;
    for (const k of ['auth_algo', 'cert_url', 'transmission_id', 'transmission_sig', 'transmission_time', 'webhook_id', 'webhook_event']) {
      if (b[k] === undefined || b[k] === '') return ppError(400, 'VALIDATION_ERROR', 'MISSING_REQUIRED_PARAMETER', `${k} is required.`);
    }
    const sent = this.sent.get(String(b.transmission_id));
    const ok =
      !!sent &&
      b.webhook_id === this.webhookId &&
      b.transmission_sig === sent.signature &&
      b.transmission_time === sent.time &&
      JSON.stringify(b.webhook_event) === JSON.stringify(JSON.parse(sent.rawBody));
    return json(200, { verification_status: ok ? 'SUCCESS' : 'FAILURE' });
  }
}
