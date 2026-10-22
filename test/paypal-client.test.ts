// The PayPal client against the mock PayPal API. These check both sides: that the client follows
// PayPal's rules (idempotency, retries, token caching, error details) and that the mock answers the
// way the Orders v2 spec says PayPal does.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PayPalClient, PayPalError, SANDBOX_API, approvalUrl, orderRequestBody, type CreateOrderInput } from '../src/paypal/client.ts';
import { MockPayPal } from '../src/paypal/mock.ts';

function setup(opts: { maxRetries?: number } = {}) {
  const mock = new MockPayPal({ approvalPageUrl: 'http://gateway.test/mock-paypal/checkoutnow' });
  const sleeps: number[] = [];
  const logs: string[] = [];
  const client = new PayPalClient({
    clientId: mock.clientId,
    clientSecret: mock.clientSecret,
    baseUrl: mock.baseUrl,
    fetch: mock.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (l) => logs.push(l),
    maxRetries: opts.maxRetries,
  });
  return { mock, client, sleeps, logs };
}

let n = 0;
function input(over: Partial<CreateOrderInput> = {}): CreateOrderInput {
  n++;
  return {
    quoteId: `q_test${n}`,
    description: 'Plainfeed data for Test agent: 2 API calls',
    currency: 'USD',
    lines: [
      { name: 'Compare lisbon and madrid', sku: 'cities.compare', unitCents: 5, quantity: 1 },
      { name: 'City costs: pt-lisbon', sku: 'cities.get', unitCents: 2, quantity: 1 },
    ],
    brandName: 'Plainfeed',
    returnUrl: 'http://gateway.test/pay/return',
    cancelUrl: 'http://gateway.test/pay/cancel',
    ...over,
  };
}

describe('order request body', () => {
  it('matches the Orders v2 shape: CAPTURE, item_total equals the items, PayPal wallet with no shipping', () => {
    const b = orderRequestBody(input({ quoteId: 'q_abc' }));
    assert.equal(b.intent, 'CAPTURE');
    const pu = b.purchase_units[0];
    assert.equal(pu.reference_id, 'q_abc');
    assert.equal(pu.custom_id, 'q_abc');
    assert.equal(pu.invoice_id, 'q_abc');
    assert.deepEqual(pu.amount, { currency_code: 'USD', value: '0.07', breakdown: { item_total: { currency_code: 'USD', value: '0.07' } } });
    assert.deepEqual(pu.items[0], { name: 'Compare lisbon and madrid', sku: 'cities.compare', quantity: '1', unit_amount: { currency_code: 'USD', value: '0.05' }, category: 'DIGITAL_GOODS' });
    assert.equal('soft_descriptor' in pu, false, 'optional fields left out');
    const ctx = b.payment_source.paypal.experience_context;
    assert.equal(ctx.shipping_preference, 'NO_SHIPPING');
    assert.equal(ctx.user_action, 'PAY_NOW');
    assert.equal(ctx.return_url, 'http://gateway.test/pay/return');
  });
  it('keeps item names within the 127 characters PayPal returns', () => {
    const b = orderRequestBody(input({ lines: [{ name: 'x'.repeat(300), sku: 's', unitCents: 1, quantity: 1 }] }));
    assert.equal(b.purchase_units[0].items[0].name.length, 127);
  });
  it('refuses an empty order', () => {
    assert.throws(() => orderRequestBody(input({ lines: [] })));
  });
});

describe('approval link', () => {
  it('prefers payer-action and falls back to approve', () => {
    assert.equal(approvalUrl({ links: [{ rel: 'self', href: 's' }, { rel: 'payer-action', href: 'p' }, { rel: 'approve', href: 'a' }] }), 'p');
    assert.equal(approvalUrl({ links: [{ rel: 'approve', href: 'a' }] }), 'a');
    assert.equal(approvalUrl({ links: [] }), null);
  });
});

describe('PayPal client against the mock API', () => {
  it('defaults to the sandbox, never live', () => {
    const c = new PayPalClient({ clientId: 'x', clientSecret: 'y' });
    assert.equal(c.baseUrl, SANDBOX_API);
    assert.equal(SANDBOX_API, 'https://api-m.sandbox.paypal.com');
  });

  it('creates an order waiting for the payer, with a payer-action link', async () => {
    const { client, mock } = setup();
    const o = await client.createOrder(input(), 'req-1');
    assert.match(o.id, /^[A-Z0-9]{17}$/);
    assert.equal(o.status, 'PAYER_ACTION_REQUIRED');
    assert.equal(approvalUrl(o), `http://gateway.test/mock-paypal/checkoutnow?token=${o.id}`);
    const post = mock.calls.find((c) => c.path === '/v2/checkout/orders');
    assert.equal(post?.requestId, 'req-1');
    assert.equal(post?.prefer, 'return=representation');
  });

  it('caches the access token across calls and shares one request between concurrent callers', async () => {
    const { client, mock } = setup();
    await Promise.all([client.createOrder(input(), 'a'), client.createOrder(input(), 'b'), client.createOrder(input(), 'c')]);
    await client.createOrder(input(), 'd');
    assert.equal(mock.tokensIssued, 1);
  });

  it('sends a PayPal-Request-Id on every Orders POST', async () => {
    const { client, mock } = setup();
    const o = await client.createOrder(input(), 'r-create');
    mock.approve(o.id);
    await client.captureOrder(o.id, 'r-capture');
    const posts = mock.calls.filter((c) => c.method === 'POST' && c.path.startsWith('/v2/'));
    assert.equal(posts.length, 2);
    assert.ok(posts.every((c) => c.requestId));
  });

  it('is idempotent: the same PayPal-Request-Id returns the same order', async () => {
    const { client } = setup();
    const inp = input();
    const a = await client.createOrder(inp, 'same-id');
    const b = await client.createOrder(inp, 'same-id');
    assert.equal(a.id, b.id);
  });

  it('refuses to capture before the buyer approves (ORDER_NOT_APPROVED, 422)', async () => {
    const { client } = setup();
    const o = await client.createOrder(input(), 'x1');
    await assert.rejects(client.captureOrder(o.id, 'cap-1'), (e: unknown) => {
      assert.ok(e instanceof PayPalError);
      assert.equal(e.status, 422);
      assert.equal(e.code, 'UNPROCESSABLE_ENTITY');
      assert.equal(e.issue, 'ORDER_NOT_APPROVED');
      assert.ok(e.debugId);
      return true;
    });
  });

  it('captures once: a repeat with the same request id returns the first capture, a new id is ORDER_ALREADY_CAPTURED', async () => {
    const { client, mock } = setup();
    const o = await client.createOrder(input(), 'x2');
    mock.approve(o.id);
    const first = await client.captureOrder(o.id, 'cap-same');
    const cap = first.purchase_units?.[0].payments?.captures?.[0];
    assert.equal(first.status, 'COMPLETED');
    assert.equal(cap?.status, 'COMPLETED');
    assert.equal(cap?.amount.value, '0.07');
    assert.equal(cap?.custom_id, first.purchase_units?.[0].custom_id);
    const repeat = await client.captureOrder(o.id, 'cap-same');
    assert.equal(repeat.purchase_units?.[0].payments?.captures?.[0].id, cap?.id);
    await assert.rejects(client.captureOrder(o.id, 'cap-other'), (e: unknown) => e instanceof PayPalError && e.issue === 'ORDER_ALREADY_CAPTURED');
  });

  it('retries 429 after Retry-After with the same request id', async () => {
    const { client, mock, sleeps } = setup();
    mock.failNext('create', { status: 429, name: 'RATE_LIMIT_REACHED', retryAfter: 2 });
    const o = await client.createOrder(input(), 'retry-me');
    assert.ok(o.id);
    assert.deepEqual(sleeps, [2000]);
    const ids = mock.calls.filter((c) => c.path === '/v2/checkout/orders').map((c) => c.requestId);
    assert.deepEqual(ids, ['retry-me', 'retry-me']);
  });

  it('retries server errors with backoff, then gives up with the debug_id kept', async () => {
    const { client, mock, sleeps, logs } = setup({ maxRetries: 2 });
    mock.failNext('create', { status: 503, name: 'SERVICE_UNAVAILABLE', message: 'down' }, 3);
    await assert.rejects(client.createOrder(input(), 'down'), (e: unknown) => e instanceof PayPalError && e.status === 503 && !!e.debugId);
    assert.deepEqual(sleeps, [500, 1000]);
    assert.ok(logs.some((l) => /debug_id=/.test(l)));
  });

  it('gets a new token once when PayPal says the token is no longer valid', async () => {
    // The token expires on the PayPal side while the client's clock says its cached token is still fine.
    let mockTime = Date.parse('2026-10-22T00:00:00Z');
    const mock = new MockPayPal({ now: () => new Date(mockTime) });
    const client = new PayPalClient({ clientId: mock.clientId, clientSecret: mock.clientSecret, baseUrl: mock.baseUrl, fetch: mock.fetch, now: () => Date.parse('2026-10-22T00:00:00Z') });
    await client.createOrder(input(), 't1');
    mockTime += 9 * 3600_000;
    await client.createOrder(input(), 't2');
    assert.equal(mock.tokensIssued, 2);
  });

  it('reports bad credentials as invalid_client', async () => {
    const mock = new MockPayPal();
    const client = new PayPalClient({ clientId: 'wrong', clientSecret: 'wrong', baseUrl: mock.baseUrl, fetch: mock.fetch, maxRetries: 0 });
    await assert.rejects(client.createOrder(input(), 'z'), (e: unknown) => e instanceof PayPalError && e.status === 401 && e.code === 'invalid_client');
  });

  it('reads an order back', async () => {
    const { client } = setup();
    const o = await client.createOrder(input(), 'g1');
    const got = await client.getOrder(o.id);
    assert.equal(got.id, o.id);
    await assert.rejects(client.getOrder('NOSUCHORDER000000'), (e: unknown) => e instanceof PayPalError && e.status === 404 && e.code === 'RESOURCE_NOT_FOUND');
  });
});

describe('mock PayPal checks requests like PayPal does', () => {
  it('rejects an item_total that does not add up (ITEM_TOTAL_MISMATCH)', async () => {
    const { client, mock } = setup();
    const body = orderRequestBody(input());
    body.purchase_units[0].amount.breakdown.item_total.value = '0.99';
    const token = await client.accessToken();
    const res = await mock.fetch(`${mock.baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { details: Array<{ issue: string }> }).details[0].issue, 'ITEM_TOTAL_MISMATCH');
  });

  it('rejects a reused invoice id (DUPLICATE_INVOICE_ID)', async () => {
    const { client } = setup();
    const inp = input();
    await client.createOrder(inp, 'inv-1');
    await assert.rejects(client.createOrder(inp, 'inv-2'), (e: unknown) => e instanceof PayPalError && e.issue === 'DUPLICATE_INVOICE_ID');
  });

  it('refuses calls without a valid bearer token', async () => {
    const mock = new MockPayPal();
    const res = await mock.fetch(`${mock.baseUrl}/v2/checkout/orders/ABC`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(res.status, 401);
  });
});

describe('webhook signature verification', () => {
  async function delivered() {
    const { client, mock } = setup();
    const seen: Request[] = [];
    mock.webhookSink = async (r) => {
      seen.push(r);
      return new Response('ok');
    };
    const o = await client.createOrder(input(), 'w1');
    mock.approve(o.id);
    await client.captureOrder(o.id, 'w1c');
    await mock.deliverWebhooks();
    return { client, mock, req: seen[0] };
  }

  it('confirms a genuine delivery, sending the raw body untouched', async () => {
    const { client, mock, req } = await delivered();
    const raw = await req.clone().text();
    assert.equal(await client.verifyWebhookSignature(req.headers, raw, mock.webhookId), true);
    const verifyCall = mock.calls.find((c) => c.path === '/v1/notifications/verify-webhook-signature');
    assert.ok(verifyCall?.requestId, 'verify POST carries a PayPal-Request-Id');
  });

  it('rejects a changed body, a wrong webhook id, and missing headers', async () => {
    const { client, mock, req } = await delivered();
    const raw = await req.clone().text();
    const changed = raw.replace(/"value":"0\.07"/g, '"value":"700.00"');
    assert.notEqual(changed, raw);
    assert.equal(await client.verifyWebhookSignature(req.headers, changed, mock.webhookId), false);
    assert.equal(await client.verifyWebhookSignature(req.headers, raw, 'OTHER-WEBHOOK'), false);
    assert.equal(await client.verifyWebhookSignature(new Headers(), raw, mock.webhookId), false);
  });
});
