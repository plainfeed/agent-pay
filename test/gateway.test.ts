// The whole payment flow through the HTTP API, in mock mode, with no network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BASE, DEMO_KEY, TIGHT_KEY, approvedQuote, call, clock, makeApp, webFonts } from './helpers.ts';

const BASKET = ['/v1/compare?a=lisbon&b=madrid', '/v1/cities/pt-lisbon'];

describe('free and priced calls', () => {
  it('reports mock mode on /health', async () => {
    const r = await call(makeApp(), 'GET', '/health');
    assert.equal(r.body.paypal, 'mock');
    assert.equal(r.body.data_source, 'sample');
    assert.equal(r.body.webhooks, true);
  });
  it('lists prices and serves free calls without a key', async () => {
    const app = makeApp();
    assert.equal((await call(app, 'GET', '/v1/prices')).body.products.length, 4);
    const s = await call(app, 'GET', '/v1/sources');
    assert.equal(s.status, 200);
    assert.equal(s.body.sample, true);
  });
  it('answers a paid call with 402 and the price when no agent key is sent', async () => {
    const r = await call(makeApp(), 'GET', '/v1/compare?a=lisbon&b=madrid');
    assert.equal(r.status, 402);
    assert.equal(r.body.error.code, 'payment_required');
    assert.equal(r.body.error.price, '0.05');
  });
  it('answers a paid call with 402 and a ready quote when the agent is known', async () => {
    const r = await call(makeApp(), 'GET', '/v1/compare?a=lisbon&b=madrid', { key: DEMO_KEY });
    assert.equal(r.status, 402);
    assert.equal(r.body.quote.total, '0.05');
    assert.equal(r.body.quote.status, 'open');
    assert.equal(r.headers.get('x-quote-id'), r.body.quote.quote_id);
    assert.equal(r.body.quote.results, undefined, 'no data before payment');
    assert.equal(r.body.how_to_pay.length, 3);
  });
  it('rejects unknown agent keys and missing keys on the payment API', async () => {
    const app = makeApp();
    assert.equal((await call(app, 'POST', '/pay/quotes', { body: { calls: BASKET } })).status, 401);
    const r = await call(app, 'POST', '/pay/quotes', { key: 'nope', body: { calls: BASKET } });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'unknown_agent_key');
  });
});

describe('quotes', () => {
  it('prices a basket as one payment and shows what is left to spend', async () => {
    const r = await call(makeApp(), 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    assert.equal(r.status, 201);
    assert.equal(r.body.total, '0.07');
    assert.deepEqual(
      r.body.items.map((i: { price: string }) => i.price),
      ['0.05', '0.02'],
    );
    assert.equal(r.body.spending.left_today, '0.93');
    assert.match(r.body.next, /checkout/);
  });
  it('only quotes data that exists: an unknown city gets no quote and no charge', async () => {
    const app = makeApp();
    const r = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: ['/v1/cities/atlantis'] } });
    assert.equal(r.status, 404);
    assert.equal(r.body.error.code, 'call_failed');
    assert.equal(app.gateway.opts.store.quotes.size, 0);
  });
  it('refuses free calls, empty baskets and baskets over 10 calls', async () => {
    const app = makeApp();
    assert.equal((await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: ['/v1/sources'] } })).body.error.code, 'free_call');
    assert.equal((await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: [] } })).body.error.code, 'no_calls');
    const many = Array.from({ length: 11 }, () => '/v1/cities/pt-lisbon');
    assert.equal((await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: many } })).body.error.code, 'too_many_calls');
  });
  it('keeps one agent out of another agent\'s quotes', async () => {
    const app = makeApp();
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    assert.equal((await call(app, 'GET', `/pay/quotes/${q.body.quote_id}`, { key: TIGHT_KEY })).status, 404);
    assert.equal((await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: TIGHT_KEY })).status, 404);
  });
  it('expires quotes that are not paid in time', async () => {
    const c = clock();
    const app = makeApp({ now: c.now });
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    c.advance(31 * 60_000);
    const r = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'quote_expired');
  });
});

describe('paying with PayPal', () => {
  it('goes from quote to PayPal order to approval to capture, then releases data with a signed receipt', async () => {
    const app = makeApp();
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    const id = q.body.quote_id;

    const co = await call(app, 'POST', `/pay/quotes/${id}/checkout`, { key: DEMO_KEY });
    assert.equal(co.status, 200);
    assert.equal(co.body.status, 'awaiting_approval');
    const orderId = co.body.paypal.order_id;
    assert.equal(co.body.paypal.approve_url, `${BASE}/mock-paypal/checkoutnow?token=${orderId}`);
    const sent = app.mock?.getStoredOrder(orderId);
    assert.equal(sent?.purchase_units?.[0].custom_id, id);
    assert.equal(sent?.purchase_units?.[0].amount?.value, '0.07');

    const early = await call(app, 'POST', `/pay/quotes/${id}/capture`, { key: DEMO_KEY });
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'not_approved');
    assert.equal(early.body.error.approve_url, co.body.paypal.approve_url);

    app.mock?.approve(orderId);
    const paid = await call(app, 'POST', `/pay/quotes/${id}/capture`, { key: DEMO_KEY });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, 'paid');
    assert.equal(paid.body.results.length, 2);
    assert.match(paid.body.results[0].body.summary, /Lisbon costs \$305/);
    const receipt = paid.body.receipt;
    assert.equal(receipt.total, '0.07');
    assert.equal(receipt.paypal.order_id, orderId);
    assert.equal(receipt.paypal.environment, 'mock');
    assert.equal(receipt.issuer, BASE);

    assert.equal((await call(app, 'POST', '/pay/receipts/verify', { body: receipt })).body.valid, true);
    assert.equal((await call(app, 'POST', '/pay/receipts/verify', { body: { ...receipt, total: '0.01' } })).body.valid, false);

    const types = app.ledger.entries().map((e) => e.type);
    assert.deepEqual(types, ['order_created', 'payment_captured']);
    assert.match(app.ledger.entries()[1].text, /^Paid: \$0\.07 from Trip planner \(demo\) through PayPal/);
  });

  it('never charges twice: repeated and simultaneous captures return the same receipt', async () => {
    const app = makeApp();
    const { quoteId, orderId } = await approvedQuote(app, BASKET);
    const [a, b, c] = await Promise.all([
      call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY }),
      call(app, 'GET', `/pay/return?token=${orderId}&PayerID=MOCKBUYER0001`),
      call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.body.receipt.receipt_id, a.body.receipt.receipt_id);
    const again = await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
    assert.equal(again.body.receipt.receipt_id, a.body.receipt.receipt_id);
    assert.equal(app.ledger.entries().filter((e) => e.type === 'payment_captured').length, 1);
    const capturePosts = app.mock?.calls.filter((x) => x.path.endsWith('/capture')) ?? [];
    assert.ok(capturePosts.every((x) => x.requestId === `capture-${quoteId}`), 'every capture reuses one PayPal-Request-Id');
  });

  it('shows the buyer a page after approving in PayPal, and captures there', async () => {
    const app = makeApp();
    const { quoteId, orderId } = await approvedQuote(app, BASKET);
    const r = await call(app, 'GET', `/pay/return?token=${orderId}&PayerID=MOCKBUYER0001`);
    assert.equal(r.status, 200);
    assert.match(r.text, /Payment approved/);
    assert.match(r.text, /Paid \$0\.07/);
    assert.equal((await call(app, 'GET', `/pay/quotes/${quoteId}`, { key: DEMO_KEY })).body.status, 'paid');
  });

  it('records a cancel in PayPal and refuses to capture afterwards', async () => {
    const app = makeApp();
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    const co = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    const r = await call(app, 'GET', `/pay/cancel?token=${co.body.paypal.order_id}`);
    assert.match(r.text, /No money moved/);
    const cap = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/capture`, { key: DEMO_KEY });
    assert.equal(cap.body.error.code, 'quote_cancelled');
    assert.equal(app.ledger.entries().at(-1)?.type, 'cancelled');
  });

  it('asks the buyer to approve again when PayPal declines the funding source', async () => {
    const app = makeApp();
    const { quoteId, orderId } = await approvedQuote(app, BASKET);
    if (!app.mock) throw new Error('mock');
    app.mock.captureOutcome = 'DECLINED';
    const r = await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'instrument_declined');
    assert.ok(r.body.error.approve_url);
    assert.equal(app.ledger.entries().at(-1)?.type, 'payment_declined');
    app.mock.captureOutcome = 'COMPLETED';
    app.mock.approve(orderId);
    const ok = await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'paid');
  });

  it('holds the data while PayPal reviews a payment, and releases it when PayPal confirms', async () => {
    const app = makeApp();
    const { quoteId } = await approvedQuote(app, BASKET);
    if (!app.mock) throw new Error('mock');
    app.mock.captureOutcome = 'PENDING';
    const r = await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
    assert.equal(r.status, 202);
    assert.equal(r.body.status, 'pending_capture');
    assert.equal(r.body.results, undefined);
    app.mock.outbox.length = 0; // drop the PENDING event
    app.mock.completePendingCapture(r.body.paypal.capture_id);
    assert.deepEqual(await app.mock.deliverWebhooks(), [200]);
    const after = await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
    assert.equal(after.status, 200);
    assert.equal(after.body.results.length, 2);
    assert.deepEqual(
      app.ledger.entries().map((e) => e.type),
      ['order_created', 'capture_pending', 'payment_captured'],
    );
  });

  it('survives a PayPal outage: the checkout fails cleanly with the debug id, then works on retry', async () => {
    const app = makeApp();
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    app.mock?.failNext('create', { status: 503, name: 'SERVICE_UNAVAILABLE', message: 'down' }, 4);
    const r = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    assert.equal(r.status, 502);
    assert.equal(r.body.error.code, 'paypal_error');
    assert.ok(r.body.error.debug_id);
    const ok = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    assert.equal(ok.status, 200);
    assert.equal(app.ledger.entries().length, 1);
  });

  it('checkout is safe to repeat: one PayPal order per quote', async () => {
    const app = makeApp();
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    const a = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    const b = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    assert.equal(a.body.paypal.order_id, b.body.paypal.order_id);
    assert.equal(app.mock?.calls.filter((c) => c.path === '/v2/checkout/orders').length, 1);
  });
});

describe('spending limits', () => {
  it('blocks a quote over the per-payment limit before any PayPal order exists', async () => {
    const app = makeApp();
    const r = await call(app, 'POST', '/pay/quotes', { key: TIGHT_KEY, body: { calls: ['/v1/compare?a=paris&b=berlin', '/v1/compare?a=tokyo&b=taipei', '/v1/compare?a=london&b=new-york'] } });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'over_order_cap');
    const e = app.ledger.entries().at(-1);
    assert.equal(e?.type, 'cap_blocked');
    assert.match(e?.text ?? '', /over its limit of \$0\.10 per payment\. No PayPal order was created and no money moved\./);
    assert.equal(app.mock?.calls.length, 0);
  });

  it('counts payments still waiting for approval against the daily limit', async () => {
    const app = makeApp();
    // Budget bot: $0.10 per payment, $0.15 per day.
    const one = await call(app, 'POST', '/pay/quotes', { key: TIGHT_KEY, body: { calls: ['/v1/compare?a=paris&b=berlin', '/v1/compare?a=tokyo&b=taipei'] } });
    assert.equal(one.status, 201);
    const two = await call(app, 'POST', '/pay/quotes', { key: TIGHT_KEY, body: { calls: ['/v1/compare?a=lisbon&b=madrid', '/v1/cities/pt-lisbon'] } });
    assert.equal(two.status, 403);
    assert.equal(two.body.error.code, 'over_daily_cap');
    assert.equal(two.body.error.spending.waiting_for_approval, '0.10');
  });

  it('checks the daily limit again right before capture, and does not capture past it', async () => {
    const c = clock('2026-10-22T23:50:00.000Z');
    const app = makeApp({ now: c.now });
    const calls = ['/v1/compare?a=paris&b=berlin', '/v1/compare?a=tokyo&b=taipei'];
    const late = await approvedQuote(app, calls, TIGHT_KEY); // made yesterday, approved, not captured
    c.set('2026-10-23T00:05:00.000Z');
    const early = await approvedQuote(app, calls, TIGHT_KEY); // today
    assert.equal((await call(app, 'POST', `/pay/quotes/${early.quoteId}/capture`, { key: TIGHT_KEY })).status, 200);
    const r = await call(app, 'POST', `/pay/quotes/${late.quoteId}/capture`, { key: TIGHT_KEY });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'over_daily_cap');
    assert.equal(app.mock?.getStoredOrder(late.orderId)?.status, 'APPROVED', 'the PayPal order was never captured');
    assert.match(app.ledger.entries().at(-1)?.text ?? '', /^Blocked at capture: .* was not captured\. No money moved\.$/);
  });

  it('reports spending and limits', async () => {
    const app = makeApp();
    const { quoteId } = await approvedQuote(app, BASKET);
    await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
    await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: ['/v1/cities/fr-paris'] } });
    const r = await call(app, 'GET', '/pay/spending', { key: DEMO_KEY });
    assert.deepEqual(r.body.spending, { spent_today: '0.07', waiting_for_approval: '0.02', daily_cap: '1.00', order_cap: '0.25', left_today: '0.91' });
    assert.equal(r.body.recent.length, 2);
  });
});

describe('mock checkout pages', () => {
  it('shows a clearly labelled stand-in for the PayPal approval screen', async () => {
    const app = makeApp();
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    const co = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    const page = await call(app, 'GET', `/mock-paypal/checkoutnow?token=${co.body.paypal.order_id}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /Mock mode/);
    assert.match(page.text, /Approve \$0\.07/);
    assert.match(page.text, /Compare lisbon and madrid/);
    assert.deepEqual(webFonts(page.text), ['B612+Mono']);
  });
  it('approving sends the browser back to /pay/return like PayPal does', async () => {
    const app = makeApp();
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: BASKET } });
    const co = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    const r = await call(app, 'POST', '/mock-paypal/approve', { form: `token=${co.body.paypal.order_id}` });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), `/pay/return?token=${co.body.paypal.order_id}&PayerID=MOCKBUYER0001`);
  });
  it('does not exist in sandbox mode', async () => {
    const app = makeApp({ env: { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' } });
    assert.equal((await call(app, 'GET', '/mock-paypal/checkoutnow?token=X')).status, 404);
  });
});
