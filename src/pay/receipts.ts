// Signed receipts. After a payment is captured the agent gets a receipt it can keep, show its owner,
// or hand to another service. The signature (HMAC-SHA256 over canonical JSON) proves the gateway issued
// it and that nothing in it was changed. POST /pay/receipts/verify checks one.

import { canonicalJson, hmac, safeEqual } from '../lib/crypto.ts';

export interface Receipt {
  receipt_id: string;
  quote_id: string;
  agent_id: string;
  agent_name: string;
  items: Array<{ call: string; description: string; price: string }>;
  total: string;
  currency: 'USD';
  paypal: { environment: 'mock' | 'sandbox'; order_id: string; capture_id: string; capture_status: string; payer_id?: string };
  paid_at: string;
  ledger_seq: number;
  issuer: string;
  signature: string;
}

export class ReceiptSigner {
  private readonly secret: string;
  readonly issuer: string;

  constructor(secret: string, issuer: string) {
    if (!secret || secret.length < 16) throw new Error('Receipt secret must be at least 16 characters.');
    this.secret = secret;
    this.issuer = issuer;
  }

  sign(fields: Omit<Receipt, 'signature' | 'issuer'>): Receipt {
    const unsigned = { ...fields, issuer: this.issuer };
    return { ...unsigned, signature: hmac(this.secret, canonicalJson(unsigned)) };
  }

  verify(receipt: unknown): boolean {
    if (!receipt || typeof receipt !== 'object') return false;
    const { signature, ...rest } = receipt as Record<string, unknown>;
    if (typeof signature !== 'string') return false;
    return safeEqual(signature, hmac(this.secret, canonicalJson(rest)));
  }
}
