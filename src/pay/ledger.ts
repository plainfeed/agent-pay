// The ledger: one plain-English line for every payment event, appended and never rewritten.
//
// Stored as JSON Lines. Each entry carries the SHA-256 hash of the entry before it, so editing or
// deleting any past line breaks the chain from that point on, and verify() says exactly where.
// The file is only ever opened for appending. With no path the ledger lives in memory (tests).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';

export type LedgerType =
  | 'order_created'
  | 'payment_captured'
  | 'capture_pending'
  | 'paypal_confirmed'
  | 'payment_declined'
  | 'cap_blocked'
  | 'cancelled'
  | 'refunded'
  | 'mismatch';

export interface LedgerInput {
  type: LedgerType;
  text: string;
  agent_id?: string;
  agent_name?: string;
  quote_id?: string;
  amount?: string;
  currency?: string;
  paypal_order_id?: string;
  paypal_capture_id?: string;
  paypal_event_id?: string;
}

export interface LedgerEntry extends LedgerInput {
  seq: number;
  at: string;
  prev: string;
  hash: string;
}

export const GENESIS = '0'.repeat(64);

function hashOf(entry: Omit<LedgerEntry, 'hash'>): string {
  return sha256Hex(canonicalJson(entry));
}

export interface ChainCheck {
  ok: boolean;
  entries: number;
  /** seq of the first entry that does not match, if any. */
  broken_at: number | null;
  reason: string | null;
}

export class Ledger {
  private readonly path: string | null;
  private readonly now: () => Date;
  private memory: LedgerEntry[] = [];
  private lastHash = GENESIS;
  private lastSeq = 0;

  constructor(path: string | null, now: () => Date = () => new Date()) {
    this.path = path;
    this.now = now;
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      const existing = Ledger.readFile(path);
      const check = Ledger.check(existing);
      if (!check.ok) throw new Error(`Ledger ${path} fails its chain check at entry ${check.broken_at}: ${check.reason}. Refusing to append.`);
      const last = existing[existing.length - 1];
      if (last) {
        this.lastHash = last.hash;
        this.lastSeq = last.seq;
      }
    }
  }

  append(input: LedgerInput): LedgerEntry {
    const base = { ...input, seq: this.lastSeq + 1, at: this.now().toISOString(), prev: this.lastHash };
    const entry: LedgerEntry = { ...base, hash: hashOf(base) };
    if (this.path) appendFileSync(this.path, JSON.stringify(entry) + '\n', { flag: 'a' });
    else this.memory.push(entry);
    this.lastHash = entry.hash;
    this.lastSeq = entry.seq;
    return entry;
  }

  entries(): LedgerEntry[] {
    return this.path ? Ledger.readFile(this.path) : [...this.memory];
  }

  verify(): ChainCheck {
    return Ledger.check(this.entries());
  }

  static readFile(path: string): LedgerEntry[] {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l, i) => {
        try {
          return JSON.parse(l) as LedgerEntry;
        } catch {
          return { seq: i + 1, at: '', type: 'mismatch', text: '(unreadable line)', prev: '', hash: 'unreadable' } as LedgerEntry;
        }
      });
  }

  static check(entries: LedgerEntry[]): ChainCheck {
    let prev = GENESIS;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.seq !== i + 1) return { ok: false, entries: entries.length, broken_at: i + 1, reason: `expected entry number ${i + 1}, found ${e.seq}` };
      if (e.prev !== prev) return { ok: false, entries: entries.length, broken_at: e.seq, reason: 'it does not point to the entry before it (a line was removed or reordered)' };
      const { hash, ...rest } = e;
      if (hashOf(rest) !== hash) return { ok: false, entries: entries.length, broken_at: e.seq, reason: 'its contents were changed after it was written' };
      prev = hash;
    }
    return { ok: true, entries: entries.length, broken_at: null, reason: null };
  }
}
