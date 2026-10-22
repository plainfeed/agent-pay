// Local HTTP server: the gateway API plus the pages in site/ (/ and /ledger).
//   npm start                       http://localhost:8787, mock PayPal unless sandbox keys are set
// Settings (environment variables, all optional): see .env.example
//   PORT=8787  HOST=127.0.0.1  PUBLIC_URL=http://localhost:8787
//   PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET   switch to the PayPal sandbox
//   PAYPAL_WEBHOOK_ID                         verify sandbox webhooks (needs a public URL, for example a tunnel)
//   UPSTREAM_URL / UPSTREAM_API_KEY           sell a live Plainfeed feed instead of the sample data
//   STATE_PATH, LEDGER_PATH, RECEIPT_SECRET

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, ROOT, type App, type AppOptions } from './app.ts';

const SITE = join(ROOT, 'site');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const PAGES: Record<string, string> = { '/': 'index.html', '/ledger': 'ledger.html' };

function loadDotEnv(): void {
  // .env.local, if present, fills in variables that are not already set. No dependency needed.
  const f = join(ROOT, '.env.local');
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined && m[2] !== '') process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  return new Request(`${origin}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
}

async function send(res: ServerResponse, r: Response) {
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => (h[k] = v));
  res.writeHead(r.status, h);
  res.end(Buffer.from(await r.arrayBuffer()));
}

function staticFile(pathname: string): { body: Buffer; type: string } | null {
  const name = PAGES[pathname] ?? (pathname.startsWith('/assets/') ? pathname.slice(1) : null);
  if (!name) return null;
  const full = normalize(join(SITE, decodeURIComponent(name)));
  if (!full.startsWith(SITE) || !existsSync(full) || !statSync(full).isFile()) return null;
  return { body: readFileSync(full), type: MIME[extname(full)] ?? 'application/octet-stream' };
}

export async function startServer(opts: Partial<AppOptions> & { port?: number; host?: string } = {}) {
  const port = opts.port ?? Number(process.env.PORT ?? 8787);
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1';
  let app: App | null = null;
  const server = createServer(async (req, res) => {
    try {
      if (!app) throw new Error('not ready');
      const u = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET') {
        const f = staticFile(u.pathname);
        if (f) {
          res.writeHead(200, { 'content-type': f.type });
          res.end(f.body);
          return;
        }
      }
      const origin = `http://${req.headers.host ?? `localhost:${port}`}`;
      await send(res, await app.handler(await toRequest(req, origin)));
    } catch (e) {
      console.error(e);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"internal_error","message":"server error"}}');
    }
  });
  await new Promise<void>((r) => server.listen(port, host, r));
  const actualPort = (server.address() as { port: number }).port;
  const publicUrl = opts.publicUrl ?? process.env.PUBLIC_URL ?? `http://localhost:${actualPort}`;
  app = buildApp({ ...opts, publicUrl });
  return { server, port: actualPort, app, publicUrl, close: () => new Promise<void>((r) => server.close(() => r())) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  loadDotEnv();
  const { publicUrl, app } = await startServer();
  console.log(`Plainfeed agent pay gateway on ${publicUrl}`);
  console.log(`  PayPal: ${app.environment === 'mock' ? 'MOCK (local fake of the Orders API, no account needed)' : 'SANDBOX (api-m.sandbox.paypal.com)'}`);
  console.log(`  Data:   ${app.source.name === 'sample' ? 'sample dataset (data/sample-cities.json)' : `live feed at ${process.env.UPSTREAM_URL}`}`);
  console.log(`  Ledger: ${publicUrl}/ledger    Prices: ${publicUrl}/v1/prices    MCP: ${publicUrl}/mcp`);
  if (app.environment === 'sandbox' && !process.env.PAYPAL_WEBHOOK_ID) console.log('  Webhooks: off (set PAYPAL_WEBHOOK_ID and expose /paypal/webhook to turn them on). Payments still work.');
}
