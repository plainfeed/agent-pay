// Test helpers: a fresh in-memory gateway in mock mode, and a tiny request helper. No network.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, type App, type AppOptions } from '../src/api/app.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEMO_KEY = 'demo-agent-key-not-secret';
export const TIGHT_KEY = 'tight-agent-key-not-secret';
export const BASE = 'http://gateway.test';

export function tempDir(prefix = 'agentpay-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A settable clock. */
export function clock(start = '2026-10-22T12:00:00.000Z') {
  let t = new Date(start).getTime();
  return {
    now: () => new Date(t),
    set: (iso: string) => {
      t = new Date(iso).getTime();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

export function makeApp(over: Partial<AppOptions> = {}): App {
  return buildApp({
    env: {},
    publicUrl: BASE,
    statePath: null,
    ledgerPath: null,
    receiptSecret: 'test-receipt-secret-0123456789',
    mockWebhookDelayMs: null,
    log: () => {},
    ...over,
  });
}

export interface Res {
  status: number;
  headers: Headers;
  body: any;
  text: string;
}

export async function call(app: App, method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string>; form?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.key) headers['x-agent-key'] = opts.key;
  let body: string | undefined;
  if (opts.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await app.handler(new Request(BASE + path, { method, headers, body }));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* HTML or empty */
  }
  return { status: res.status, headers: res.headers, body: parsed, text };
}

/** Quote, check out and approve, ready for capture. Returns the quote id and PayPal order id. */
export async function approvedQuote(app: App, calls: string[], key = DEMO_KEY): Promise<{ quoteId: string; orderId: string }> {
  const q = await call(app, 'POST', '/pay/quotes', { key, body: { calls } });
  if (q.status !== 201) throw new Error(`quote failed: ${q.text}`);
  const c = await call(app, 'POST', `/pay/quotes/${q.body.quote_id}/checkout`, { key });
  if (c.status !== 200) throw new Error(`checkout failed: ${c.text}`);
  app.mock?.approve(c.body.paypal.order_id);
  return { quoteId: q.body.quote_id, orderId: c.body.paypal.order_id };
}

/** Font families a page loads from Google Fonts. */
export function webFonts(html: string): string[] {
  return [...html.matchAll(/fonts\.googleapis\.com\/css2\?([^"']+)/g)].flatMap((m) => [...new URLSearchParams(m[1]).getAll('family')].map((f) => f.split(':')[0].replace(/ /g, '+')));
}
