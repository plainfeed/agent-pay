// Agents and their spending limits. Each agent carries its own key (sent as x-agent-key); the seller
// stores only a SHA-256 hash of it. Two limits per agent:
//   order_cap  the most one PayPal payment may be
//   daily_cap  the most the agent may spend in one UTC day, counting payments still waiting for approval
// The limits protect the person paying: a looping or confused agent cannot run up a bill, and cannot
// even ask its owner to approve a payment over the limit.

import { existsSync, readFileSync } from 'node:fs';
import { sha256Hex } from '../lib/crypto.ts';
import { toCents, type Cents } from '../lib/money.ts';

export interface AgentConfig {
  id: string;
  name: string;
  key_sha256: string;
  order_cap: string;
  daily_cap: string;
}

export interface Agent {
  id: string;
  name: string;
  orderCapCents: Cents;
  dailyCapCents: Cents;
}

export class AgentRegistry {
  private readonly byHash = new Map<string, Agent>();
  private readonly byIdMap = new Map<string, Agent>();

  constructor(configs: AgentConfig[]) {
    for (const c of configs) {
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(c.id)) throw new Error(`Agent id "${c.id}" must be lowercase letters, digits and dashes.`);
      if (!/^[0-9a-f]{64}$/.test(c.key_sha256)) throw new Error(`Agent ${c.id}: key_sha256 must be a SHA-256 hex digest.`);
      const agent = { id: c.id, name: c.name || c.id, orderCapCents: toCents(c.order_cap), dailyCapCents: toCents(c.daily_cap) };
      if (agent.orderCapCents > agent.dailyCapCents) throw new Error(`Agent ${c.id}: order_cap is above daily_cap.`);
      if (this.byIdMap.has(c.id)) throw new Error(`Agent id "${c.id}" is listed twice.`);
      this.byHash.set(c.key_sha256, agent);
      this.byIdMap.set(c.id, agent);
    }
  }

  /** Load every file that exists, later files adding to earlier ones. */
  static fromFiles(paths: string[]): AgentRegistry {
    const all: AgentConfig[] = [];
    for (const p of paths) if (existsSync(p)) all.push(...((JSON.parse(readFileSync(p, 'utf8')) as { agents: AgentConfig[] }).agents ?? []));
    return new AgentRegistry(all);
  }

  lookup(key: string | null | undefined): Agent | null {
    if (!key) return null;
    return this.byHash.get(sha256Hex(key.trim())) ?? null;
  }

  byId(id: string): Agent | null {
    return this.byIdMap.get(id) ?? null;
  }

  get size(): number {
    return this.byHash.size;
  }
}
