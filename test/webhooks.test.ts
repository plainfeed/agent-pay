// PayPal webhooks: verified with PayPal before anything happens, handled once per event id.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEMO_KEY, approvedQuote, call, clock, makeApp } from './helpers.ts';

const BASKET = ['/v1/compare?a=lisbon&b=madrid', '/v1/cities/pt-lisbon'];

async function paidApp() {
  const app = makeApp();
  const mock = app.mock;
  if (!mock) throw new Error('mock');
  const seen: Request[] = [];
  const handler = app.handler;
  mock.webhookSink = async (r) => {
    seen.push(r.clone());
    return handler(r);
  };
  const { quoteId, orderId } = await approvedQuote(app, BASKET);
  const paid = await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
  return { app, mock, seen, quoteId, orderId, captureId: paid.body.paypal.capture_id as string };
}

describe('PayPal webhooks', () => {
  it('confirms a capture in the ledger after PayPal signs it', async () => {
    const { app, mock } = await paidApp();
    assert.deepEqual(await mock.deliverWebhooks(), [200]);
    const last = app.ledger.entries().at(-1);
    assert.equal(last?.type, 'paypal_confirmed');
    assert.match(last?.text ?? '', /^Confirmed by PayPal: capture [A-Z0-9]+ for \$0\.07 is complete \(webhook WH-/);
    assert.ok(mock.calls.some((c) => c.path === '/v1/notifications/verify-webhook-signature'), 'asked PayPal to verify');
  });

  it('handles a redelivered event only once', async () => {
    const { app, mock, seen } = await paidApp();
    await mock.deliverWebhooks();
    const before = app.ledger.entries().length;
    const again = await app.handler(seen[0].clone());
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { reason: string }).reason, 'duplicate');
    assert.equal(app.ledger.entries().length, before);
  });

  it('ignores forged or altered deliveries', async () => {
    const { app, mock, seen } = await paidApp();
    await mock.deliverWebhooks();
    const before = app.ledger.entries().length;
    const original = seen[0];
    const raw = await original.clone().text();
    const altered = new Request(original.url, { method: 'POST', headers: original.headers, body: raw.replace('"event_type":"PAYMENT.CAPTURE.COMPLETED"', '"event_type":"PAYMENT.CAPTURE.REFUNDED"') });
    assert.equal((await app.handler(altered)).status, 400);
    const forged = new Request(original.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
    assert.equal((await app.handler(forged)).status, 400);
    assert.equal(app.ledger.entries().length, before);
  });

  it('records refunds made in PayPal', async () => {
    const { app, mock, quoteId, captureId } = await paidApp();
    await mock.deliverWebhooks();
    mock.refund(captureId);
    assert.deepEqual(await mock.deliverWebhooks(), [200]);
    const last = app.ledger.entries().at(-1);
    assert.equal(last?.type, 'refunded');
    assert.match(last?.text ?? '', /^Refunded: \$0\.07 went back/);
    assert.equal((await call(app, 'GET', `/pay/quotes/${quoteId}`, { key: DEMO_KEY })).body.status, 'refunded');
    const totals = (await call(app, 'GET', '/ledger.json')).body.totals;
    assert.deepEqual(totals, { captured: '0.07', refunded: '0.07', net: '0.00', entries: 4 });
  });

  it('finishes a payment from the webhook when the capture response never reached the gateway', async () => {
    const app = makeApp();
    if (!app.mock) throw new Error('mock');
    const { quoteId, orderId } = await approvedQuote(app, BASKET);
    // PayPal captured, but the answer was lost on the way back (for example a timeout).
    await app.gateway.opts.paypal.captureOrder(orderId, `capture-${quoteId}`);
    assert.equal((await call(app, 'GET', `/pay/quotes/${quoteId}`, { key: DEMO_KEY })).body.status, 'awaiting_approval');
    await app.mock.deliverWebhooks();
    const r = await call(app, 'POST', `/pay/quotes/${quoteId}/capture`, { key: DEMO_KEY });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'paid');
    assert.equal(r.body.results.length, 2);
    assert.equal(app.ledger.entries().filter((e) => e.type === 'payment_captured').length, 1);
  });

  it('records a PayPal capture even if the quote expired before the webhook arrived', async () => {
    const c = clock();
    const app = makeApp({ now: c.now });
    if (!app.mock) throw new Error('mock');
    const { quoteId, orderId } = await approvedQuote(app, BASKET);
    await app.gateway.opts.paypal.captureOrder(orderId, `capture-${quoteId}`); // response lost
    c.advance(45 * 60_000); // past the 30 minute quote lifetime
    assert.equal((await call(app, 'GET', `/pay/quotes/${quoteId}`, { key: DEMO_KEY })).body.status, 'expired');
    await app.mock.deliverWebhooks();
    const r = await call(app, 'GET', `/pay/quotes/${quoteId}`, { key: DEMO_KEY });
    assert.equal(r.body.status, 'paid');
    assert.equal(r.body.results.length, 2);
    assert.equal(app.ledger.entries().at(-1)?.type, 'payment_captured');
  });

  it('is off in sandbox mode until a webhook id is set', async () => {
    const app = makeApp({ env: { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' } });
    const r = await call(app, 'POST', '/paypal/webhook', { body: { id: 'WH-1' } });
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'webhooks_off');
  });
});
