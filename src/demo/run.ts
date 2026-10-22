// Scripted demo: a buying agent goes through the whole flow against a fresh gateway.
//   npm run demo             mock PayPal, the script presses Approve on the mock checkout for you
//   npm run demo:manual      you approve in the browser (mock checkout, or the real PayPal sandbox if keys are set)
// Flags: --manual  --keep-open (leave the server running so you can open the ledger page)
// The demo uses its own temporary state and ledger, so it never touches .local/.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../api/node-server.ts';
import { httpPayApi, type ApiResult } from '../mcp/core.ts';

const manual = process.argv.includes('--manual');
const keepOpen = process.argv.includes('--keep-open') || manual;
const dir = mkdtempSync(join(tmpdir(), 'agent-pay-demo-'));
const port = process.env.PORT ? Number(process.env.PORT) : manual ? 8788 : 0;
const srv = await startServer({ port, statePath: join(dir, 'state.json'), ledgerPath: join(dir, 'ledger.jsonl'), log: () => {} });
const base = srv.publicUrl;
const env = srv.app.environment;
const say = (s = '') => console.log(s);
const step = (n: number, s: string) => say(`\n${n}. ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Q = { quote_id: string; total: string; items: Array<{ description: string; price: string }>; spending?: { left_today: string }; paypal?: { order_id: string; approve_url?: string; capture_id?: string }; receipt?: Record<string, unknown> & { receipt_id: string }; results?: Array<{ call: string; body: Record<string, unknown> }> };

say(`Plainfeed agent pay: scripted demo`);
say(`Gateway ${base}. PayPal: ${env === 'mock' ? 'mock (local fake of the Orders API)' : 'sandbox'}. Data: ${srv.app.source.name}.`);

const agent = httpPayApi(base, 'demo-agent-key-not-secret');

step(1, 'The agent asks for data without paying.');
const first = await fetch(`${base}/v1/compare?a=lisbon&b=madrid`, { headers: { 'x-agent-key': 'demo-agent-key-not-secret' } });
const firstBody = (await first.json()) as { error: { message: string } };
say(`   GET /v1/compare?a=lisbon&b=madrid answered HTTP ${first.status} ${first.statusText}: ${firstBody.error.message}`);

step(2, 'The agent plans everything it needs and asks for one quote, so its person approves only once.');
const qr = await agent.quote(['/v1/compare?a=lisbon&b=madrid', '/v1/cities/pt-lisbon', '/v1/cities/es-madrid']);
if (qr.status !== 201) fail('quote', qr);
const quote = qr.body as unknown as Q;
for (const i of quote.items) say(`   ${i.description.padEnd(28)} $${i.price}`);
say(`   Total $${quote.total}. The agent may spend $${quote.spending?.left_today} more today. Nothing charged yet.`);

step(3, 'The gateway creates a PayPal order (Orders v2) and returns the approval link.');
const co = await agent.checkout(quote.quote_id);
if (co.status !== 200) fail('checkout', co);
const order = (co.body as unknown as Q).paypal as NonNullable<Q['paypal']>;
say(`   PayPal order ${order.order_id}`);
say(`   Approval link: ${order.approve_url}`);

step(4, 'Finishing before the person approves is refused, and nothing is charged.');
const early = await agent.capture(quote.quote_id);
say(`   HTTP ${early.status}: ${(early.body.error as { message: string }).message}`);

step(5, manual || env !== 'mock' ? 'Open the link above and approve the payment. Waiting...' : 'The person paying approves. (Mock mode: the script presses Approve on the mock checkout page.)');
if (!manual && env === 'mock') {
  const r = await fetch(`${base}/mock-paypal/approve`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `token=${order.order_id}`, redirect: 'manual' });
  say(`   Approved. The browser is sent back to ${r.headers.get('location')?.split('?')[0]}.`);
}

step(6, 'The agent finishes the payment and gets the data with a signed receipt.');
let paid: ApiResult = early;
for (let i = 0; i < 300; i++) {
  paid = await agent.capture(quote.quote_id);
  if (paid.status === 200) break;
  await sleep(2000);
}
if (paid.status !== 200) fail('capture', paid);
const done = paid.body as unknown as Q;
say(`   Paid $${done.total}. PayPal capture ${done.paypal?.capture_id}. Receipt ${done.receipt?.receipt_id}.`);
const compare = done.results?.find((r) => r.call.startsWith('/v1/compare'))?.body as { summary?: string } | undefined;
say(`   From the data: ${compare?.summary}`);
const check = await fetch(`${base}/pay/receipts/verify`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(done.receipt) });
say(`   Receipt signature valid: ${((await check.json()) as { valid: boolean }).valid ? 'yes' : 'no'}.`);
const again = await agent.capture(quote.quote_id);
say(`   Asking again returns the same receipt (${(again.body as unknown as Q).receipt?.receipt_id}) and charges nothing more.`);

step(7, 'A second agent with tight limits tries to overspend.');
const tight = httpPayApi(base, 'tight-agent-key-not-secret');
const big = await tight.quote(['/v1/compare?a=paris&b=berlin', '/v1/compare?a=tokyo&b=taipei', '/v1/compare?a=london&b=new-york']);
say(`   HTTP ${big.status}: ${(big.body.error as { message: string }).message}`);

await sleep(800); // let the PayPal webhook arrive
step(8, 'The seller\'s ledger, one plain-English line per payment event.');
const ledger = (await (await fetch(`${base}/ledger.json`)).json()) as { entries: Array<{ seq: number; text: string }>; check: { ok: boolean; entries: number } };
for (const e of ledger.entries) say(`   #${e.seq} ${e.text}`);
say(`   Chain check: ${ledger.check.ok ? `OK, ${ledger.check.entries} entries, nothing changed or removed` : 'BROKEN'}.`);

if (keepOpen) {
  say(`\nLedger page: ${base}/ledger   (press Ctrl+C to stop)`);
} else {
  await srv.close();
  say('\nDone.');
}

function fail(what: string, r: ApiResult): never {
  console.error(`\nDemo stopped at ${what}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  process.exit(1);
}
