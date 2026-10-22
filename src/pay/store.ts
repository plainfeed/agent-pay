// Gateway state: quotes and the webhook events already handled. Kept in memory and, when a path is
// given, saved to a JSON file after every change (write to a temp file, then rename, so a crash never
// leaves half a file). The ledger is separate and is the record of truth for money.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Cents } from '../lib/money.ts';
import type { Receipt } from './receipts.ts';

export type QuoteStatus =
  | 'open' // priced, no PayPal order yet
  | 'awaiting_approval' // PayPal order created, buyer has not approved (or we have not captured yet)
  | 'pending_capture' // captured, but PayPal holds the money for review; data waits for PAYMENT.CAPTURE.COMPLETED
  | 'paid'
  | 'declined'
  | 'cancelled'
  | 'refused' // a spending limit stopped it
  | 'expired'
  | 'refunded';

export interface QuoteItem {
  product: string;
  call: string;
  description: string;
  price_cents: Cents;
}

export interface Quote {
  id: string;
  agent_id: string;
  agent_name: string;
  created_at: string;
  expires_at: string;
  status: QuoteStatus;
  currency: 'USD';
  total_cents: Cents;
  items: QuoteItem[];
  /** Data fetched when the quote was made. Only shown after payment. */
  results: Array<{ call: string; status: number; body: unknown }>;
  paypal?: {
    order_id: string;
    approve_url: string;
    capture_id?: string;
    capture_status?: string;
    payer_id?: string;
    fee?: string;
    net?: string;
  };
  receipt?: Receipt;
  paid_at?: string;
  note?: string;
}

interface Saved {
  quotes: Quote[];
  events: string[];
}

export class StateStore {
  readonly quotes = new Map<string, Quote>();
  private readonly events = new Set<string>();
  private readonly path: string | null;

  constructor(path: string | null = null) {
    this.path = path;
    if (path && existsSync(path)) {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Saved;
      for (const q of saved.quotes ?? []) this.quotes.set(q.id, q);
      for (const e of saved.events ?? []) this.events.add(e);
    }
  }

  save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ quotes: [...this.quotes.values()], events: [...this.events] } satisfies Saved));
    renameSync(tmp, this.path);
  }

  put(q: Quote): void {
    this.quotes.set(q.id, q);
    this.save();
  }

  byOrderId(orderId: string): Quote | undefined {
    for (const q of this.quotes.values()) if (q.paypal?.order_id === orderId) return q;
    return undefined;
  }

  byCaptureId(captureId: string): Quote | undefined {
    for (const q of this.quotes.values()) if (q.paypal?.capture_id === captureId) return q;
    return undefined;
  }

  /** Record a webhook event id. Returns false if it was already handled. */
  markEvent(id: string): boolean {
    if (this.events.has(id)) return false;
    this.events.add(id);
    this.save();
    return true;
  }

  forAgent(agentId: string): Quote[] {
    return [...this.quotes.values()].filter((q) => q.agent_id === agentId);
  }
}
