// Sandbox mode and the upstream (live feed) data source, both without touching the network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MockPayPal } from '../src/paypal/mock.ts';
import { SANDBOX_API } from '../src/paypal/client.ts';
import { UpstreamSource } from '../src/data/source.ts';
import { Catalog } from '../src/pay/catalog.ts';
import { join } from 'node:path';
import { DEMO_KEY, ROOT, call, makeApp } from './helpers.ts';

describe('sandbox mode', () => {
  it('switches on with both PayPal keys and talks to api-m.sandbox.paypal.com', async () => {
    // Stand in for the sandbox: rewrite the host to the mock, and record the URLs the client used.
    const fake = new MockPayPal();
    const urls: string[] = [];
    const app = makeApp({
      env: { PAYPAL_CLIENT_ID: fake.clientId, PAYPAL_CLIENT_SECRET: fake.clientSecret, PAYPAL_WEBHOOK_ID: fake.webhookId },
      paypalFetch: (url, init) => {
        urls.push(url);
        return fake.fetch(url.replace(SANDBOX_API, fake.baseUrl), init);
      },
    });
    const h = await call(app, 'GET', '/health');
    assert.equal(h.body.paypal, 'sandbox');
    assert.equal(h.body.paypal_api, 'https://api-m.sandbox.paypal.com');
    assert.equal(app.mock, null);

    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: ['/v1/cities/tw-taipei'] } });
    const co = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    assert.equal(co.status, 200);
    fake.approve(co.body.paypal.order_id);
    const paid = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/capture`, { key: DEMO_KEY });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.receipt.paypal.environment, 'sandbox');
    assert.ok(urls.length >= 3);
    assert.ok(urls.every((u) => u.startsWith('https://api-m.sandbox.paypal.com/')));
  });

  it('refuses half a configuration', () => {
    assert.throws(() => makeApp({ env: { PAYPAL_CLIENT_ID: 'only-id' } }), /Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  });
});

describe('upstream data source (a live Plainfeed feed)', () => {
  const catalog = Catalog.fromFile(join(ROOT, 'config/prices.json'));

  it('forwards the call with the seller\'s key and returns the feed\'s answer', async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const src = new UpstreamSource('https://feed.example.test/', 'seller-key', async (url, init) => {
      seen.push({ url, key: new Headers(init?.headers).get('x-api-key') });
      return new Response(JSON.stringify({ summary: 'live answer' }), { status: 200 });
    });
    const r = await src.get(catalog.price('/v1/compare?b=madrid&a=lisbon'));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { summary: 'live answer' });
    assert.deepEqual(seen, [{ url: 'https://feed.example.test/v1/compare?a=lisbon&b=madrid', key: 'seller-key' }]);
  });

  it('turns the seller\'s own key problems and outages into gateway errors', async () => {
    const refused = new UpstreamSource('https://feed.example.test', 'k', async () => new Response('{"error":{}}', { status: 401 }));
    assert.equal((await refused.get(catalog.price('/v1/cities/x'))).status, 502);
    const down = new UpstreamSource('https://feed.example.test', 'k', async () => {
      throw new Error('ECONNREFUSED');
    });
    const r = await down.get(catalog.price('/v1/cities/x'));
    assert.equal(r.status, 502);
    assert.match(JSON.stringify(r.body), /did not answer/);
  });

  it('never shows the seller\'s feed key to buyers', async () => {
    const app = makeApp({
      env: { UPSTREAM_URL: 'https://feed.example.test', UPSTREAM_API_KEY: 'super-secret-feed-key' },
      upstreamFetch: async () => new Response(JSON.stringify({ id: 'pt-lisbon', per_diem: 300 }), { status: 200 }),
    });
    assert.equal((await call(app, 'GET', '/health')).body.data_source, 'upstream');
    const q = await call(app, 'POST', '/pay/quotes', { key: DEMO_KEY, body: { calls: ['/v1/cities/pt-lisbon'] } });
    const co = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key: DEMO_KEY });
    app.mock?.approve(co.body.paypal.order_id);
    const paid = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/capture`, { key: DEMO_KEY });
    assert.equal(paid.body.results[0].body.per_diem, 300);
    for (const r of [q, co, paid]) assert.doesNotMatch(r.text, /super-secret-feed-key/);
  });

  it('needs both the URL and the key', () => {
    assert.throws(() => new UpstreamSource('https://feed.example.test', ''), /UPSTREAM_API_KEY/);
    assert.throws(() => new UpstreamSource('feed.example.test', 'k'), /UPSTREAM_URL/);
  });
});
