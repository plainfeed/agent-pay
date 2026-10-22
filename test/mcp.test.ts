// Interop: the official MCP TypeScript SDK client buys data through our MCP server, over stdio
// (the buyer's machine) and over Streamable HTTP (POST /mcp on the gateway).

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/api/node-server.ts';
import { DEMO_KEY, ROOT } from './helpers.ts';

type Text = { type: string; text: string };
const text = (r: Record<string, unknown>) => (r.content as Text[])[0].text;

describe('MCP over stdio with the official SDK client', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: Client;
  before(async () => {
    srv = await startServer({ port: 0, env: {}, statePath: null, ledgerPath: null, receiptSecret: 'test-receipt-secret-0123456789', mockWebhookDelayMs: null, log: () => {} });
    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', join(ROOT, 'src/mcp/stdio.ts')],
        env: { ...process.env, GATEWAY_URL: srv.publicUrl, AGENT_KEY: DEMO_KEY } as Record<string, string>,
        stderr: 'pipe',
      }),
    );
  });
  after(async () => {
    await client.close();
    await srv.close();
  });

  it('offers five tools', async () => {
    assert.equal(client.getServerVersion()?.name, 'plainfeed-agent-pay');
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['finish_payment', 'get_quote', 'list_prices', 'spending_status', 'start_payment']);
    assert.match(client.getInstructions() ?? '', /approves every payment in PayPal/);
  });

  it('buys data end to end: quote, PayPal link, refused before approval, paid after', async () => {
    const prices = await client.callTool({ name: 'list_prices', arguments: {} });
    assert.match(text(prices), /Compare two cities: \$0\.05/);

    const q = await client.callTool({ name: 'get_quote', arguments: { calls: ['/v1/compare?a=lisbon&b=madrid', '/v1/cities/pt-lisbon'] } });
    assert.equal(q.isError, false);
    const quoteId = (q.structuredContent as { quote_id: string }).quote_id;
    assert.match(text(q), /\$0\.07 for 2 calls/);

    const start = await client.callTool({ name: 'start_payment', arguments: { quote_id: quoteId } });
    assert.match(text(start), /Ask the user to approve \$0\.07/);
    assert.match(text(start), /Do not open or approve the link yourself/);
    const orderId = (start.structuredContent as { paypal: { order_id: string } }).paypal.order_id;

    const early = await client.callTool({ name: 'finish_payment', arguments: { quote_id: quoteId } });
    assert.equal(early.isError, true);
    assert.match(text(early), /has not approved/);

    srv.app.mock?.approve(orderId); // the person approves in PayPal
    const done = await client.callTool({ name: 'finish_payment', arguments: { quote_id: quoteId } });
    assert.equal(done.isError, false);
    assert.match(text(done), /^Paid \$0\.07 through PayPal/);
    const sc = done.structuredContent as { receipt: { receipt_id: string }; results: Array<{ body: { summary?: string } }> };
    assert.match(sc.receipt.receipt_id, /^r_/);
    assert.match(sc.results[0].body.summary ?? '', /Lisbon/);

    const spend = await client.callTool({ name: 'spending_status', arguments: {} });
    assert.match(text(spend), /spent \$0\.07 today/);
  });

  it('reports spending-limit refusals as tool errors', async () => {
    const big = Array.from({ length: 10 }, (_, i) => `/v1/compare?a=lisbon&b=${['madrid', 'paris', 'berlin', 'london', 'tokyo', 'taipei', 'nairobi', 'new-york', 'mexico-city', 'madrid'][i]}`);
    const r = await client.callTool({ name: 'get_quote', arguments: { calls: big } });
    assert.equal(r.isError, true);
    assert.match(text(r), /over the \$0\.25 limit per payment/);
  });
});

describe('MCP over Streamable HTTP on the gateway', () => {
  let srv: Awaited<ReturnType<typeof startServer>>;
  let client: Client;
  before(async () => {
    srv = await startServer({ port: 0, env: {}, statePath: null, ledgerPath: null, receiptSecret: 'test-receipt-secret-0123456789', mockWebhookDelayMs: null, log: () => {} });
    client = new Client({ name: 'http-agent', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.publicUrl}/mcp`), { requestInit: { headers: { 'x-agent-key': DEMO_KEY } } }));
  });
  after(async () => {
    await client.close();
    await srv.close();
  });

  it('lists tools and quotes through POST /mcp', async () => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 5);
    const q = await client.callTool({ name: 'get_quote', arguments: { calls: ['/v1/cities/jp-tokyo'] } });
    assert.match(text(q), /\$0\.02 for 1 call/);
  });

  it('refuses /mcp without a valid agent key', async () => {
    const r = await fetch(`${srv.publicUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(r.status, 401);
  });
});
