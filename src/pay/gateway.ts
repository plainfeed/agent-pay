// The payment flow, transport free (src/api/handler.ts puts HTTP in front of it).
//
//  1. quote     An agent asks for one or more calls. The gateway prices them, checks the agent's limits,
//               fetches the data (so it only sells data that exists) and holds it back.
//  2. checkout  The gateway creates a PayPal order (Orders v2) for the quote and returns the approval link.
//  3. approve   A person opens the link and approves in PayPal. The agent never touches payment details.
//  4. capture   The gateway captures the order, checks PayPal's amount and reference match the quote,
//               then releases the data with a signed receipt and writes a ledger line.
//  Webhooks from PayPal confirm captures, finish payments PayPal held for review, and record refunds.
//
// Limits are checked three times: when quoting (counting other payments still waiting for approval),
// when creating the PayPal order, and right before capture, so parallel quotes cannot slip past them.

import { newId } from '../lib/crypto.ts';
import { toCents, toValue, usd, type Cents } from '../lib/money.ts';
import { PayPalError, approvalUrl, type Order, type PayPalClient } from '../paypal/client.ts';
import type { DataSource } from '../data/source.ts';
import type { Agent, AgentRegistry } from './agents.ts';
import { CallError, type Catalog, type PricedCall } from './catalog.ts';
import type { Ledger, LedgerInput } from './ledger.ts';
import type { ReceiptSigner, Receipt } from './receipts.ts';
import type { Quote, StateStore } from './store.ts';

export type Outcome<T = Record<string, unknown>> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; code: string; message: string; details?: Record<string, unknown> };

export interface GatewayOptions {
  paypal: PayPalClient;
  environment: 'mock' | 'sandbox';
  catalog: Catalog;
  agents: AgentRegistry;
  source: DataSource;
  ledger: Ledger;
  store: StateStore;
  receipts: ReceiptSigner;
  /** Base URL buyers' browsers use to reach this server (PayPal sends them back here). */
  publicUrl: string;
  webhookId?: string;
  brandName?: string;
  quoteTtlMinutes?: number;
  maxCallsPerQuote?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const fail = (status: number, code: string, message: string, details?: Record<string, unknown>): Outcome<never> => ({ ok: false, status, code, message, details });

function utcDay(iso: string | Date): string {
  return (typeof iso === 'string' ? iso : iso.toISOString()).slice(0, 10);
}

function listCalls(q: Quote): string {
  const parts = q.items.map((i) => `${i.description} (${usd(i.price_cents)})`);
  return parts.length > 3 ? `${parts.slice(0, 3).join(', ')} and ${parts.length - 3} more` : parts.join(', ');
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export interface Spending {
  spent_today: string;
  waiting_for_approval: string;
  daily_cap: string;
  order_cap: string;
  left_today: string;
}

export class Gateway {
  readonly opts: GatewayOptions;
  private readonly now: () => Date;
  private readonly inflight = new Map<string, Promise<Outcome>>();

  constructor(opts: GatewayOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => new Date());
  }

  get environment() {
    return this.opts.environment;
  }

  agentByKey(key: string | null | undefined): Agent | null {
    return this.opts.agents.lookup(key);
  }

  private log(line: string) {
    this.opts.log?.(line);
  }

  private ledger(input: LedgerInput) {
    return this.opts.ledger.append({ currency: 'USD', ...input });
  }

  private expireIfDue(q: Quote): void {
    if ((q.status === 'open' || q.status === 'awaiting_approval') && this.now().toISOString() > q.expires_at) {
      q.status = 'expired';
      this.opts.store.put(q);
    }
  }

  /** Limits come from the registry at the time of each check. An agent removed from the registry can no longer pay. */
  private agentFor(q: Quote): Agent {
    return this.opts.agents.byId(q.agent_id) ?? { id: q.agent_id, name: q.agent_name, orderCapCents: 0, dailyCapCents: 0 };
  }

  /** Spending today in cents, as numbers, excluding one quote if given. */
  private spend(agent: Agent, exclude?: string) {
    const today = utcDay(this.now());
    let spent = 0;
    let waiting = 0;
    for (const q of this.opts.store.forAgent(agent.id)) {
      if (q.id === exclude) continue;
      this.expireIfDue(q);
      if ((q.status === 'paid' || q.status === 'pending_capture') && q.paid_at && utcDay(q.paid_at) === today) spent += q.total_cents;
      if ((q.status === 'open' || q.status === 'awaiting_approval') && utcDay(q.created_at) === today) waiting += q.total_cents;
    }
    return { spent, waiting };
  }

  spending(agent: Agent): Spending {
    const { spent, waiting } = this.spend(agent);
    return {
      spent_today: toValue(spent),
      waiting_for_approval: toValue(waiting),
      daily_cap: toValue(agent.dailyCapCents),
      order_cap: toValue(agent.orderCapCents),
      left_today: toValue(Math.max(0, agent.dailyCapCents - spent - waiting)),
    };
  }

  /** What an agent may see of a quote. Data is only included once paid. */
  publicQuote(q: Quote, withResults = false) {
    const id = q.id;
    const next: Record<string, string> = {
      open: `Create the PayPal payment: POST /pay/quotes/${id}/checkout (MCP tool start_payment).`,
      awaiting_approval: `Ask the person paying to open approve_url and approve the payment in PayPal. Then POST /pay/quotes/${id}/capture (MCP tool finish_payment).`,
      pending_capture: 'PayPal is holding this payment for review. The data is released when PayPal confirms it. Check again later.',
      paid: 'Paid. The data is in results and the signed receipt is in receipt.',
      declined: 'PayPal declined the payment. Ask for a new quote.',
      cancelled: 'The person paying cancelled in PayPal. Ask for a new quote if they still want the data.',
      refused: 'A spending limit stopped this payment. No money moved.',
      expired: 'This quote expired. Ask for a new one.',
      refunded: 'This payment was refunded.',
    };
    return {
      quote_id: id,
      status: q.status,
      agent: { id: q.agent_id, name: q.agent_name },
      currency: q.currency,
      total: toValue(q.total_cents),
      items: q.items.map((i) => ({ call: i.call, description: i.description, price: toValue(i.price_cents) })),
      created_at: q.created_at,
      expires_at: q.expires_at,
      paypal: q.paypal
        ? {
            environment: this.opts.environment,
            order_id: q.paypal.order_id,
            approve_url: q.status === 'awaiting_approval' ? q.paypal.approve_url : undefined,
            capture_id: q.paypal.capture_id,
            capture_status: q.paypal.capture_status,
          }
        : null,
      receipt: q.receipt,
      results: withResults && q.status === 'paid' ? q.results : undefined,
      next: next[q.status],
    };
  }

  /** Free calls are served directly. */
  async serveFree(call: PricedCall) {
    return this.opts.source.get(call);
  }

  price(call: string): PricedCall {
    return this.opts.catalog.price(call);
  }

  async quote(agent: Agent, calls: unknown): Promise<Outcome> {
    const max = this.opts.maxCallsPerQuote ?? 10;
    if (!Array.isArray(calls) || calls.length === 0) return fail(400, 'no_calls', 'Send "calls": a list of paths, for example ["/v1/compare?a=lisbon&b=madrid"].');
    if (calls.length > max) return fail(400, 'too_many_calls', `A quote holds at most ${max} calls.`);
    const priced: PricedCall[] = [];
    try {
      for (const c of calls) priced.push(this.opts.catalog.price(String(c)));
    } catch (e) {
      if (e instanceof CallError) return fail(e.status, e.code, e.message);
      throw e;
    }
    const free = priced.find((p) => p.priceCents === 0);
    if (free) return fail(400, 'free_call', `${free.call} is free. Call it directly, without a quote.`);
    const total: Cents = priced.reduce((s, p) => s + p.priceCents, 0);
    const { spent, waiting } = this.spend(agent);
    if (total > agent.orderCapCents) {
      this.ledger({
        type: 'cap_blocked',
        agent_id: agent.id,
        agent_name: agent.name,
        amount: toValue(total),
        text: `Blocked: ${agent.name} asked to pay ${usd(total)} for ${plural(priced.length, 'call')}, over its limit of ${usd(agent.orderCapCents)} per payment. No PayPal order was created and no money moved.`,
      });
      return fail(403, 'over_order_cap', `This quote is ${usd(total)}, over the ${usd(agent.orderCapCents)} limit per payment for ${agent.name}. Split it into smaller quotes.`, { total: toValue(total), order_cap: toValue(agent.orderCapCents) });
    }
    if (spent + waiting + total > agent.dailyCapCents) {
      this.ledger({
        type: 'cap_blocked',
        agent_id: agent.id,
        agent_name: agent.name,
        amount: toValue(total),
        text: `Blocked: a ${usd(total)} quote would take ${agent.name} to ${usd(spent + waiting + total)} today (paid ${usd(spent)}, waiting for approval ${usd(waiting)}), over its daily limit of ${usd(agent.dailyCapCents)}. No PayPal order was created and no money moved.`,
      });
      return fail(403, 'over_daily_cap', `This would pass ${agent.name}'s daily limit of ${usd(agent.dailyCapCents)}. Spent today ${usd(spent)}, waiting for approval ${usd(waiting)}.`, { spending: this.spending(agent) as unknown as Record<string, unknown> });
    }
    // Fetch first: only data that exists gets sold. Nothing is shown before payment.
    const results: Quote['results'] = [];
    for (const p of priced) {
      const r = await this.opts.source.get(p);
      if (r.status !== 200) {
        const msg = (r.body as { error?: { message?: string } })?.error?.message ?? `HTTP ${r.status}`;
        return fail(r.status >= 500 ? 502 : r.status, 'call_failed', `No quote: ${p.call} failed (${msg}). Nothing was charged.`, { call: p.call });
      }
      results.push({ call: p.call, status: r.status, body: r.body });
    }
    const created = this.now();
    const q: Quote = {
      id: newId('q'),
      agent_id: agent.id,
      agent_name: agent.name,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + (this.opts.quoteTtlMinutes ?? 30) * 60_000).toISOString(),
      status: 'open',
      currency: 'USD',
      total_cents: total,
      items: priced.map((p) => ({ product: p.product.id, call: p.call, description: p.description, price_cents: p.priceCents })),
      results,
    };
    this.opts.store.put(q);
    return { ok: true, status: 201, body: { ...this.publicQuote(q), spending: this.spending(agent) } };
  }

  getQuote(agent: Agent | null, id: string): Outcome {
    const q = this.opts.store.quotes.get(id);
    if (!q || (agent && q.agent_id !== agent.id)) return fail(404, 'no_such_quote', `No quote ${id} for this agent.`);
    this.expireIfDue(q);
    return { ok: true, status: 200, body: this.publicQuote(q, true) };
  }

  async checkout(agent: Agent, id: string): Promise<Outcome> {
    const q = this.opts.store.quotes.get(id);
    if (!q || q.agent_id !== agent.id) return fail(404, 'no_such_quote', `No quote ${id} for this agent.`);
    this.expireIfDue(q);
    if (q.status === 'awaiting_approval' || q.status === 'paid' || q.status === 'pending_capture') return { ok: true, status: 200, body: this.publicQuote(q) };
    if (q.status !== 'open') return fail(409, `quote_${q.status}`, this.publicQuote(q).next ?? `Quote is ${q.status}.`);
    const { spent } = this.spend(agent, q.id);
    if (spent + q.total_cents > agent.dailyCapCents) return this.refuse(q, agent, spent, 'before creating the PayPal order');
    let order: Order;
    try {
      order = await this.opts.paypal.createOrder(
        {
          quoteId: q.id,
          description: `Plainfeed data for ${q.agent_name}: ${plural(q.items.length, 'API call')}`,
          currency: 'USD',
          lines: q.items.map((i) => ({ name: i.description, sku: i.product, unitCents: i.price_cents, quantity: 1 })),
          brandName: this.opts.brandName ?? 'Plainfeed',
          returnUrl: `${this.opts.publicUrl}/pay/return`,
          cancelUrl: `${this.opts.publicUrl}/pay/cancel`,
        },
        `order-${q.id}`,
      );
    } catch (e) {
      return this.paypalFailure(e, 'creating the PayPal order');
    }
    const approve = approvalUrl(order);
    if (!approve) return fail(502, 'no_approval_link', `PayPal created order ${order.id} but returned no approval link.`);
    q.status = 'awaiting_approval';
    q.paypal = { order_id: order.id, approve_url: approve };
    this.opts.store.put(q);
    this.ledger({
      type: 'order_created',
      agent_id: q.agent_id,
      agent_name: q.agent_name,
      quote_id: q.id,
      amount: toValue(q.total_cents),
      paypal_order_id: order.id,
      text: `${q.agent_name} asked to pay ${usd(q.total_cents)} for ${plural(q.items.length, 'call')}: ${listCalls(q)}. PayPal order ${order.id} is waiting for the person paying to approve it.`,
    });
    return { ok: true, status: 200, body: this.publicQuote(q) };
  }

  /** Capture a quote's PayPal order. Safe to call many times and from several places at once. */
  capture(id: string, agent: Agent | null): Promise<Outcome> {
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.doCapture(id, agent).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async doCapture(id: string, agent: Agent | null): Promise<Outcome> {
    const q = this.opts.store.quotes.get(id);
    if (!q || (agent && q.agent_id !== agent.id)) return fail(404, 'no_such_quote', `No quote ${id} for this agent.`);
    this.expireIfDue(q);
    if (q.status === 'paid') return { ok: true, status: 200, body: this.publicQuote(q, true) };
    if (q.status === 'pending_capture') return { ok: true, status: 202, body: this.publicQuote(q) };
    if (q.status === 'open') return fail(409, 'checkout_first', `Start the payment first: POST /pay/quotes/${id}/checkout (MCP tool start_payment).`);
    if (q.status !== 'awaiting_approval' || !q.paypal) return fail(409, `quote_${q.status}`, this.publicQuote(q).next ?? `Quote is ${q.status}.`);
    const who = this.agentFor(q);
    const { spent } = this.spend(who, q.id);
    if (spent + q.total_cents > who.dailyCapCents) return this.refuse(q, who, spent, 'at capture');
    let order: Order;
    try {
      order = await this.opts.paypal.captureOrder(q.paypal.order_id, `capture-${q.id}`);
    } catch (e) {
      if (e instanceof PayPalError && e.issue === 'ORDER_NOT_APPROVED') {
        return fail(409, 'not_approved', `The person paying has not approved PayPal order ${q.paypal.order_id} yet. They need to open approve_url and approve it.`, { approve_url: q.paypal.approve_url, quote_id: q.id });
      }
      if (e instanceof PayPalError && e.issue === 'ORDER_ALREADY_CAPTURED') {
        try {
          order = await this.opts.paypal.getOrder(q.paypal.order_id);
        } catch (e2) {
          return this.paypalFailure(e2, 'reading the captured order');
        }
        return this.applyCapturedOrder(q, order);
      }
      if (e instanceof PayPalError && e.issue === 'INSTRUMENT_DECLINED') {
        this.ledger({
          type: 'payment_declined',
          agent_id: q.agent_id,
          agent_name: q.agent_name,
          quote_id: q.id,
          amount: toValue(q.total_cents),
          paypal_order_id: q.paypal.order_id,
          text: `Declined: PayPal declined the funding source for order ${q.paypal.order_id} (${usd(q.total_cents)}). The person paying can approve again with another payment method. No data was delivered.`,
        });
        return fail(409, 'instrument_declined', 'PayPal declined that payment method. Ask the person paying to open approve_url again and choose another one.', { approve_url: q.paypal.approve_url, quote_id: q.id });
      }
      return this.paypalFailure(e, 'capturing the PayPal order');
    }
    return this.applyCapturedOrder(q, order);
  }

  private refuse(q: Quote, agent: Agent, spent: Cents, when: string): Outcome {
    q.status = 'refused';
    q.note = `daily limit reached ${when}`;
    this.opts.store.put(q);
    this.ledger({
      type: 'cap_blocked',
      agent_id: q.agent_id,
      agent_name: q.agent_name,
      quote_id: q.id,
      amount: toValue(q.total_cents),
      paypal_order_id: q.paypal?.order_id,
      text: `Blocked ${when}: paying ${usd(q.total_cents)} would take ${q.agent_name} to ${usd(spent + q.total_cents)} today, over its daily limit of ${usd(agent.dailyCapCents)}.${q.paypal ? ` PayPal order ${q.paypal.order_id} was not captured.` : ''} No money moved.`,
    });
    return fail(403, 'over_daily_cap', `Not paid: this would pass ${q.agent_name}'s daily limit of ${usd(agent.dailyCapCents)} (already spent ${usd(spent)} today). No money moved.`);
  }

  private paypalFailure(e: unknown, doing: string): Outcome {
    if (e instanceof PayPalError) {
      this.log(`PayPal error while ${doing}: ${e.code} ${e.issue ?? ''} debug_id=${e.debugId ?? 'none'}`);
      return fail(502, 'paypal_error', `PayPal returned an error while ${doing}: ${e.issue ?? e.code}.`, { paypal_status: e.status, paypal_issue: e.issue, debug_id: e.debugId });
    }
    throw e;
  }

  private applyCapturedOrder(q: Quote, order: Order): Outcome {
    const pu = order.purchase_units?.[0];
    const cap = pu?.payments?.captures?.[0];
    if (!q.paypal || !cap) return fail(502, 'no_capture', `PayPal order ${q.paypal?.order_id} has no capture.`);
    const reference = cap.custom_id ?? pu?.custom_id;
    let matches = false;
    try {
      matches = cap.amount.currency_code === 'USD' && toCents(cap.amount.value) === q.total_cents && reference === q.id;
    } catch {
      matches = false;
    }
    if (!matches) {
      q.note = `capture ${cap.id} did not match: ${cap.amount.value} ${cap.amount.currency_code}, reference ${reference}`;
      this.opts.store.put(q);
      this.ledger({
        type: 'mismatch',
        agent_id: q.agent_id,
        agent_name: q.agent_name,
        quote_id: q.id,
        amount: cap.amount.value,
        paypal_order_id: q.paypal.order_id,
        paypal_capture_id: cap.id,
        text: `Held: PayPal capture ${cap.id} reports ${cap.amount.value} ${cap.amount.currency_code} with reference ${reference ?? 'none'}, but quote ${q.id} is ${usd(q.total_cents)}. No data was released. Check this payment by hand.`,
      });
      return fail(502, 'capture_mismatch', 'The PayPal capture does not match this quote. The data was not released; the seller has been told in the ledger.');
    }
    q.paypal.capture_id = cap.id;
    q.paypal.capture_status = cap.status;
    q.paypal.payer_id = order.payer?.payer_id;
    q.paypal.fee = cap.seller_receivable_breakdown?.paypal_fee?.value;
    q.paypal.net = cap.seller_receivable_breakdown?.net_amount?.value;
    if (cap.status === 'COMPLETED') return this.markPaid(q);
    if (cap.status === 'PENDING') {
      q.status = 'pending_capture';
      q.paid_at = this.now().toISOString();
      this.opts.store.put(q);
      this.ledger({
        type: 'capture_pending',
        agent_id: q.agent_id,
        agent_name: q.agent_name,
        quote_id: q.id,
        amount: toValue(q.total_cents),
        paypal_order_id: q.paypal.order_id,
        paypal_capture_id: cap.id,
        text: `On hold: PayPal captured ${usd(q.total_cents)} from ${q.agent_name}'s buyer (capture ${cap.id}) but is holding it${cap.status_details?.reason ? ` (${cap.status_details.reason})` : ''}. The data will be released when PayPal confirms it.`,
      });
      return { ok: true, status: 202, body: this.publicQuote(q) };
    }
    q.status = 'declined';
    this.opts.store.put(q);
    this.ledger({
      type: 'payment_declined',
      agent_id: q.agent_id,
      agent_name: q.agent_name,
      quote_id: q.id,
      amount: toValue(q.total_cents),
      paypal_order_id: q.paypal.order_id,
      paypal_capture_id: cap.id,
      text: `Declined: PayPal capture ${cap.id} for ${usd(q.total_cents)} came back ${cap.status}. No data was delivered.`,
    });
    return fail(402, 'payment_declined', `PayPal reported the payment as ${cap.status}. No data was delivered.`);
  }

  private markPaid(q: Quote): Outcome {
    if (!q.paypal?.capture_id) return fail(500, 'internal', 'markPaid without a capture');
    const who = this.agentFor(q);
    q.status = 'paid';
    q.paid_at ??= this.now().toISOString();
    const { spent } = this.spend(who, q.id);
    const entry = this.ledger({
      type: 'payment_captured',
      agent_id: q.agent_id,
      agent_name: q.agent_name,
      quote_id: q.id,
      amount: toValue(q.total_cents),
      paypal_order_id: q.paypal.order_id,
      paypal_capture_id: q.paypal.capture_id,
      text: `Paid: ${usd(q.total_cents)} from ${q.agent_name} through PayPal (order ${q.paypal.order_id}, capture ${q.paypal.capture_id}). Delivered ${plural(q.items.length, 'call')}: ${listCalls(q)}.${who.dailyCapCents ? ` Spent today: ${usd(spent + q.total_cents)} of ${usd(who.dailyCapCents)}.` : ''}`,
    });
    const receipt: Receipt = this.opts.receipts.sign({
      receipt_id: newId('r'),
      quote_id: q.id,
      agent_id: q.agent_id,
      agent_name: q.agent_name,
      items: q.items.map((i) => ({ call: i.call, description: i.description, price: toValue(i.price_cents) })),
      total: toValue(q.total_cents),
      currency: 'USD',
      paypal: { environment: this.opts.environment, order_id: q.paypal.order_id, capture_id: q.paypal.capture_id, capture_status: 'COMPLETED', payer_id: q.paypal.payer_id },
      paid_at: q.paid_at,
      ledger_seq: entry.seq,
    });
    q.receipt = receipt;
    this.opts.store.put(q);
    return { ok: true, status: 200, body: this.publicQuote(q, true) };
  }

  /** The buyer pressed cancel in PayPal. */
  cancelByOrder(orderId: string): Outcome {
    const q = this.opts.store.byOrderId(orderId);
    if (!q) return fail(404, 'no_such_order', `No quote for PayPal order ${orderId}.`);
    if (q.status !== 'awaiting_approval') return { ok: true, status: 200, body: this.publicQuote(q) };
    q.status = 'cancelled';
    this.opts.store.put(q);
    this.ledger({
      type: 'cancelled',
      agent_id: q.agent_id,
      agent_name: q.agent_name,
      quote_id: q.id,
      amount: toValue(q.total_cents),
      paypal_order_id: orderId,
      text: `Cancelled: the person paying cancelled PayPal order ${orderId} (${usd(q.total_cents)} for ${q.agent_name}). No money moved.`,
    });
    return { ok: true, status: 200, body: this.publicQuote(q) };
  }

  quoteByOrder(orderId: string): Quote | undefined {
    return this.opts.store.byOrderId(orderId);
  }

  /** Handle one PayPal webhook delivery: verify with PayPal, then act once per event id. */
  async webhook(rawBody: string, headers: Headers): Promise<Outcome> {
    if (!this.opts.webhookId) return fail(503, 'webhooks_off', 'Webhooks are not configured (set PAYPAL_WEBHOOK_ID).');
    let genuine: boolean;
    try {
      genuine = await this.opts.paypal.verifyWebhookSignature(headers, rawBody, this.opts.webhookId);
    } catch (e) {
      return this.paypalFailure(e, 'verifying a webhook');
    }
    if (!genuine) return fail(400, 'bad_signature', 'PayPal did not confirm this webhook signature. Ignored.');
    let event: { id?: string; event_type?: string; resource?: Record<string, unknown> };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return fail(400, 'bad_json', 'Webhook body is not JSON.');
    }
    if (!event.id || !this.opts.store.markEvent(event.id)) return { ok: true, status: 200, body: { handled: false, reason: 'duplicate' } };
    const res = (event.resource ?? {}) as Record<string, unknown> & { id?: string; custom_id?: string; status?: string; amount?: { value: string; currency_code: string }; links?: Array<{ rel: string; href: string }> };
    const relatedOrder = ((res.supplementary_data as Record<string, Record<string, string>> | undefined)?.related_ids ?? {}).order_id;
    const find = () => (res.custom_id ? this.opts.store.quotes.get(res.custom_id) : undefined) ?? (relatedOrder ? this.opts.store.byOrderId(relatedOrder) : undefined) ?? (res.id ? this.opts.store.byCaptureId(res.id) : undefined);

    switch (event.event_type) {
      case 'PAYMENT.CAPTURE.COMPLETED': {
        const q = find();
        if (!q || !q.paypal) return { ok: true, status: 200, body: { handled: false, reason: 'unknown capture' } };
        if (q.status === 'paid') {
          this.ledger({
            type: 'paypal_confirmed',
            agent_id: q.agent_id,
            agent_name: q.agent_name,
            quote_id: q.id,
            amount: res.amount?.value,
            paypal_order_id: q.paypal.order_id,
            paypal_capture_id: res.id,
            paypal_event_id: event.id,
            text: `Confirmed by PayPal: capture ${res.id} for ${res.amount ? `$${res.amount.value}` : 'this payment'} is complete (webhook ${event.id}).`,
          });
          return { ok: true, status: 200, body: { handled: true, quote_id: q.id } };
        }
        if (q.status === 'refunded') return { ok: true, status: 200, body: { handled: false, reason: 'quote was refunded' } };
        // PayPal says the money moved, so record it and deliver, whatever the quote's state: PayPal finished a
        // review, or our own capture response was lost on the way back (even if the quote has since expired).
        const order: Order = { id: q.paypal.order_id, status: 'COMPLETED', purchase_units: [{ custom_id: q.id, payments: { captures: [res as never] } }] };
        const out = this.applyCapturedOrder(q, order);
        return { ok: true, status: 200, body: { handled: out.ok, quote_id: q.id } };
      }
      case 'PAYMENT.CAPTURE.DENIED': {
        const q = find();
        if (!q || !q.paypal) return { ok: true, status: 200, body: { handled: false, reason: 'unknown capture' } };
        q.status = 'declined';
        this.opts.store.put(q);
        this.ledger({
          type: 'payment_declined',
          agent_id: q.agent_id,
          agent_name: q.agent_name,
          quote_id: q.id,
          amount: toValue(q.total_cents),
          paypal_order_id: q.paypal.order_id,
          paypal_capture_id: res.id,
          paypal_event_id: event.id,
          text: `Denied by PayPal: capture ${res.id} for ${usd(q.total_cents)} was denied after review. The data was not released.`,
        });
        return { ok: true, status: 200, body: { handled: true, quote_id: q.id } };
      }
      case 'PAYMENT.CAPTURE.REFUNDED': {
        const up = res.links?.find((l) => l.rel === 'up')?.href ?? '';
        const captureId = /\/captures\/([A-Z0-9]+)$/.exec(up)?.[1];
        const q = (captureId ? this.opts.store.byCaptureId(captureId) : undefined) ?? (res.custom_id ? this.opts.store.quotes.get(res.custom_id) : undefined);
        if (!q || !q.paypal) return { ok: true, status: 200, body: { handled: false, reason: 'unknown refund' } };
        q.status = 'refunded';
        this.opts.store.put(q);
        this.ledger({
          type: 'refunded',
          agent_id: q.agent_id,
          agent_name: q.agent_name,
          quote_id: q.id,
          amount: res.amount?.value,
          paypal_order_id: q.paypal.order_id,
          paypal_capture_id: q.paypal.capture_id,
          paypal_event_id: event.id,
          text: `Refunded: ${res.amount ? `$${res.amount.value}` : 'the payment'} went back to the person who paid for ${q.agent_name}'s quote ${q.id} (PayPal refund ${res.id}).`,
        });
        return { ok: true, status: 200, body: { handled: true, quote_id: q.id } };
      }
      default:
        return { ok: true, status: 200, body: { handled: false, reason: `event ${event.event_type} is not used` } };
    }
  }

  verifyReceipt(receipt: unknown): boolean {
    return this.opts.receipts.verify(receipt);
  }
}
