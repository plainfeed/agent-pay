// The Node server, the pages it serves, persistence across restarts, and the scripted demo.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { startServer } from '../src/api/node-server.ts';
import { DEMO_KEY, ROOT, tempDir, webFonts } from './helpers.ts';

const base = { env: {}, receiptSecret: 'test-receipt-secret-0123456789', mockWebhookDelayMs: null, log: () => {} };

describe('node server', () => {
  it('serves the landing page, the ledger page and the API', async () => {
    const srv = await startServer({ ...base, port: 0, statePath: null, ledgerPath: null });
    try {
      const home = await (await fetch(`${srv.publicUrl}/`)).text();
      assert.match(home, /Plainfeed Agent Pay/);
      const ledger = await (await fetch(`${srv.publicUrl}/ledger`)).text();
      assert.match(ledger, /ag-grid-community@36\.2\.0/);
      assert.match(ledger, /B612 Mono/);
      for (const page of [home, ledger]) assert.deepEqual(webFonts(page), ['B612+Mono'], 'the only web font is B612 Mono');
      const j = (await (await fetch(`${srv.publicUrl}/ledger.json`)).json()) as { check: { ok: boolean } };
      assert.equal(j.check.ok, true);
    } finally {
      await srv.close();
    }
  });

  it('keeps quotes, payments and the ledger across a restart', async () => {
    const dir = tempDir();
    const paths = { statePath: join(dir, 'state.json'), ledgerPath: join(dir, 'ledger.jsonl') };
    const first = await startServer({ ...base, ...paths, port: 0 });
    const h = { 'x-agent-key': DEMO_KEY, 'content-type': 'application/json' };
    const q = (await (await fetch(`${first.publicUrl}/pay/quotes`, { method: 'POST', headers: h, body: JSON.stringify({ calls: ['/v1/cities/ke-nairobi'] }) })).json()) as { quote_id: string };
    const co = (await (await fetch(`${first.publicUrl}/pay/quotes/${q.quote_id}/checkout`, { method: 'POST', headers: h })).json()) as { paypal: { order_id: string } };
    first.app.mock?.approve(co.paypal.order_id);
    const paid = (await (await fetch(`${first.publicUrl}/pay/quotes/${q.quote_id}/capture`, { method: 'POST', headers: h })).json()) as { receipt: { receipt_id: string } };
    await first.close();

    const second = await startServer({ ...base, ...paths, port: 0 });
    try {
      const again = (await (await fetch(`${second.publicUrl}/pay/quotes/${q.quote_id}`, { headers: h })).json()) as { status: string; receipt: { receipt_id: string } };
      assert.equal(again.status, 'paid');
      assert.equal(again.receipt.receipt_id, paid.receipt.receipt_id);
      const l = (await (await fetch(`${second.publicUrl}/ledger.json`)).json()) as { check: { ok: boolean; entries: number } };
      assert.deepEqual([l.check.ok, l.check.entries], [true, 2]);
    } finally {
      await second.close();
    }
  });
});

describe('scripted demo', () => {
  it('runs the whole flow in mock mode and ends with a clean ledger', () => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/demo/run.ts')], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', UPSTREAM_URL: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /HTTP 402 Payment Required/);
    assert.match(r.stdout, /Receipt signature valid: yes/);
    assert.match(r.stdout, /over the \$0\.10 limit per payment/);
    assert.match(r.stdout, /Confirmed by PayPal/);
    assert.match(r.stdout, /Chain check: OK, 4 entries/);
  });
});
