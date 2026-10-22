// Create an agent key with spending limits. Prints the key once; stores only its SHA-256 hash.
//   npm run agent:new <id> "<name>" <order_cap> <daily_cap>
//   npm run agent:new trip-planner "Trip planner" 0.50 2.00
// Writes config/agents.local.json (not committed). Restart the gateway to load it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSecret, sha256Hex } from '../src/lib/crypto.ts';
import { AgentRegistry, type AgentConfig } from '../src/pay/agents.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const [id, name, orderCap, dailyCap] = process.argv.slice(2);
if (!id || !name || !orderCap || !dailyCap) {
  console.error('Usage: npm run agent:new <id> "<name>" <order_cap> <daily_cap>\nExample: npm run agent:new trip-planner "Trip planner" 0.50 2.00');
  process.exit(2);
}
const file = join(ROOT, 'config/agents.local.json');
const current = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { agents: AgentConfig[] }) : { agents: [] };
const key = newSecret('pfa');
const entry: AgentConfig = { id, name, key_sha256: sha256Hex(key), order_cap: orderCap, daily_cap: dailyCap };
// Validate against everything that will be loaded together.
AgentRegistry.fromFiles([join(ROOT, 'config/agents.json')]);
new AgentRegistry([...current.agents.filter((a) => a.id !== id), entry]);
writeFileSync(file, JSON.stringify({ agents: [...current.agents.filter((a) => a.id !== id), entry] }, null, 2) + '\n', { mode: 0o600 });
console.log(`Agent "${name}" (${id}): up to $${orderCap} per payment, $${dailyCap} per day.`);
console.log(`Key (shown once, store it in the agent's config as AGENT_KEY):\n${key}`);
