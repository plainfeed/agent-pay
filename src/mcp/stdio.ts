// MCP server over stdio for a buying agent (Claude Desktop, Claude Code or any MCP client).
// It forwards tool calls to a running gateway. Logs go to stderr only.
//   GATEWAY_URL  where the gateway runs (default http://localhost:8787)
//   AGENT_KEY    this agent's key (default: the public demo key, which only makes sense locally)
//
// Claude Code:   claude mcp add plainfeed-pay -e GATEWAY_URL=http://localhost:8787 -e AGENT_KEY=... -- node /path/to/plainfeed-agent-pay/src/mcp/stdio.ts
// Claude Desktop: { "mcpServers": { "plainfeed-pay": { "command": "node", "args": ["/path/to/plainfeed-agent-pay/src/mcp/stdio.ts"], "env": { "GATEWAY_URL": "http://localhost:8787", "AGENT_KEY": "..." } } } }

import { createInterface } from 'node:readline';
import { handleMcpMessage, httpPayApi, type JsonRpcMessage } from './core.ts';

const gatewayUrl = process.env.GATEWAY_URL ?? 'http://localhost:8787';
const agentKey = process.env.AGENT_KEY ?? 'demo-agent-key-not-secret';
const api = httpPayApi(gatewayUrl, agentKey);
process.stderr.write(`plainfeed-agent-pay MCP: forwarding to ${gatewayUrl}\n`);

const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n');
let queue: Promise<void> = Promise.resolve();
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  // Answer in order, one message at a time.
  queue = queue.then(async () => {
    let msg: JsonRpcMessage | JsonRpcMessage[];
    try {
      msg = JSON.parse(s);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      if (Array.isArray(msg)) {
        const out = (await Promise.all(msg.map((m) => handleMcpMessage(m, api)))).filter(Boolean);
        if (out.length) send(out);
      } else {
        const out = await handleMcpMessage(msg, api);
        if (out) send(out);
      }
    } catch (e) {
      process.stderr.write(`error: ${(e as Error).stack}\n`);
      send({ jsonrpc: '2.0', id: Array.isArray(msg) ? null : (msg.id ?? null), error: { code: -32603, message: 'Internal error' } });
    }
  });
});
rl.on('close', () => {
  void queue.then(() => process.exit(0));
});
