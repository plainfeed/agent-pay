// Builds the whole gateway from settings. Mode is decided here:
//   mock     no PayPal keys: a local fake of the PayPal API (src/paypal/mock.ts). Default.
//   sandbox  PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET set: the real PayPal sandbox at api-m.sandbox.paypal.com.
// There is no live mode on purpose: the hackathon runs on the sandbox only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newSecret } from '../lib/crypto.ts';
import { PayPalClient, SANDBOX_API, type FetchLike } from '../paypal/client.ts';
import { MockPayPal } from '../paypal/mock.ts';
import { SampleSource, UpstreamSource, type DataSource } from '../data/source.ts';
import { AgentRegistry } from '../pay/agents.ts';
import { Catalog } from '../pay/catalog.ts';
import { Gateway } from '../pay/gateway.ts';
import { Ledger } from '../pay/ledger.ts';
import { ReceiptSigner } from '../pay/receipts.ts';
import { StateStore } from '../pay/store.ts';
import { createHandler, type Handler } from './handler.ts';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export interface AppOptions {
  env?: Record<string, string | undefined>;
  /** Base URL that browsers use to reach this server. */
  publicUrl: string;
  /** null keeps state and ledger in memory (tests). Defaults come from STATE_PATH / LEDGER_PATH or .local/. */
  statePath?: string | null;
  ledgerPath?: string | null;
  receiptSecret?: string;
  /** Override the PayPal fetch (tests of sandbox mode). */
  paypalFetch?: FetchLike;
  /** Override the upstream fetch (tests of upstream mode). */
  upstreamFetch?: FetchLike;
  /** Deliver mock webhooks automatically this many ms after they are queued. Default 300; null turns it off. */
  mockWebhookDelayMs?: number | null;
  now?: () => Date;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface App {
  gateway: Gateway;
  handler: Handler;
  mock: MockPayPal | null;
  environment: 'mock' | 'sandbox';
  source: DataSource;
  ledger: Ledger;
}

function receiptSecretFrom(env: Record<string, string | undefined>, explicit?: string): string {
  if (explicit) return explicit;
  if (env.RECEIPT_SECRET) return env.RECEIPT_SECRET;
  const file = join(ROOT, '.local/receipt-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const s = newSecret('rs');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, s + '\n', { mode: 0o600 });
  return s;
}

export function buildApp(opts: AppOptions): App {
  const env = opts.env ?? process.env;
  const publicUrl = opts.publicUrl.replace(/\/+$/, '');
  const log = opts.log ?? ((l: string) => console.error(l));
  const id = env.PAYPAL_CLIENT_ID?.trim();
  const secret = env.PAYPAL_CLIENT_SECRET?.trim();
  if (!!id !== !!secret) throw new Error('Set both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for sandbox mode, or neither for mock mode.');

  let mock: MockPayPal | null = null;
  let paypal: PayPalClient;
  let webhookId: string | undefined;
  if (id && secret) {
    paypal = new PayPalClient({ clientId: id, clientSecret: secret, baseUrl: SANDBOX_API, fetch: opts.paypalFetch, log, sleep: opts.sleep });
    webhookId = env.PAYPAL_WEBHOOK_ID?.trim() || undefined;
  } else {
    const m = new MockPayPal({ approvalPageUrl: `${publicUrl}/mock-paypal/checkoutnow`, webhookUrl: `${publicUrl}/paypal/webhook`, now: opts.now });
    mock = m;
    const delay = opts.mockWebhookDelayMs === undefined ? 300 : opts.mockWebhookDelayMs;
    // Like PayPal, deliver webhooks a moment after the capture, outside the request that caused them.
    const mockFetch: FetchLike =
      delay === null
        ? m.fetch
        : async (url, init) => {
            const res = await m.fetch(url, init);
            if (m.outbox.length && m.webhookSink) {
              const t = setTimeout(() => void m.deliverWebhooks().catch((e) => log(`mock webhook delivery failed: ${(e as Error).message}`)), delay);
              t.unref?.();
            }
            return res;
          };
    paypal = new PayPalClient({ clientId: m.clientId, clientSecret: m.clientSecret, baseUrl: m.baseUrl, fetch: mockFetch, log, sleep: opts.sleep ?? (async () => {}) });
    webhookId = m.webhookId;
  }

  const source: DataSource = env.UPSTREAM_URL
    ? new UpstreamSource(env.UPSTREAM_URL, env.UPSTREAM_API_KEY ?? '', opts.upstreamFetch)
    : new SampleSource(join(ROOT, 'data/sample-cities.json'));

  const statePath = opts.statePath === undefined ? (env.STATE_PATH ?? join(ROOT, '.local/state.json')) : opts.statePath;
  const ledgerPath = opts.ledgerPath === undefined ? (env.LEDGER_PATH ?? join(ROOT, '.local/ledger.jsonl')) : opts.ledgerPath;
  const ledger = new Ledger(ledgerPath, opts.now);

  const gateway = new Gateway({
    paypal,
    environment: mock ? 'mock' : 'sandbox',
    catalog: Catalog.fromFile(join(ROOT, 'config/prices.json')),
    agents: AgentRegistry.fromFiles([join(ROOT, 'config/agents.json'), join(ROOT, 'config/agents.local.json')]),
    source,
    ledger,
    store: new StateStore(statePath),
    receipts: new ReceiptSigner(receiptSecretFrom(env, opts.receiptSecret), publicUrl),
    publicUrl,
    webhookId,
    brandName: 'Plainfeed',
    now: opts.now,
    log,
  });

  const handler = createHandler(gateway, { mock });

  if (mock) mock.webhookSink = handler;

  return { gateway, handler, mock, environment: mock ? 'mock' : 'sandbox', source, ledger };
}
