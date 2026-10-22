// For the demo video: the "Budget bot" demo agent ($0.10 per payment) asks a running gateway for
// $0.15 of data and gets blocked. The block shows up on the ledger page.
//   npm run demo:overspend            (GATEWAY_URL defaults to http://localhost:8787)

const base = (process.env.GATEWAY_URL ?? 'http://localhost:8787').replace(/\/+$/, '');
const calls = ['/v1/compare?a=paris&b=berlin', '/v1/compare?a=tokyo&b=taipei', '/v1/compare?a=london&b=new-york'];
console.log(`Budget bot asks ${base} for ${calls.length} comparisons ($0.15) with a $0.10 limit per payment.`);
let res: Response;
try {
  res = await fetch(`${base}/pay/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-key': 'tight-agent-key-not-secret' },
    body: JSON.stringify({ calls }),
  });
} catch {
  console.error(`Could not reach the gateway at ${base}. Start it first with: npm start`);
  process.exit(1);
}
const body = (await res.json()) as { error?: { message: string }; quote_id?: string };
console.log(`HTTP ${res.status}: ${body.error?.message ?? `quote ${body.quote_id} created`}`);
