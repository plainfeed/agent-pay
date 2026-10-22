// Server-rendered pages: the mock checkout (stands in for the PayPal sandbox approval screen in mock
// mode) and the pages a buyer lands on after approving or cancelling. Deliberately plain, no PayPal
// branding: the mock must never look like the real PayPal.

export const PAGE_CSS = `
:root{--bg:#f6f5f1;--panel:#ffffff;--ink:#1b1d1f;--muted:#5d6166;--line:#dcdad3;--accent:#0b6b55;--accent-ink:#ffffff;--warn:#8a4b00;--warn-bg:#fff3df;--ok-bg:#e5f4ee;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--mono:"B612 Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#141516;--panel:#1d1f21;--ink:#ecebe6;--muted:#a3a7ab;--line:#33363a;--accent:#3fbf98;--accent-ink:#0d1512;--warn:#ffc46b;--warn-bg:#2d2414;--ok-bg:#15291f}}
:root[data-theme="dark"]{--bg:#141516;--panel:#1d1f21;--ink:#ecebe6;--muted:#a3a7ab;--line:#33363a;--accent:#3fbf98;--accent-ink:#0d1512;--warn:#ffc46b;--warn-bg:#2d2414;--ok-bg:#15291f}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 var(--sans)}
main{max-width:560px;margin:0 auto;padding:32px 16px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:22px;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted)}
.banner{background:var(--warn-bg);color:var(--warn);border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:16px}
.ok{background:var(--ok-bg);border-radius:8px;padding:10px 12px}
table{width:100%;border-collapse:collapse;margin:16px 0}td{padding:8px 0;border-bottom:1px solid var(--line);vertical-align:top}
td.amt{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;padding-left:12px}
tr.total td{font-weight:700;border-bottom:none}
.mono{font-family:var(--mono);font-size:13px;word-break:break-all}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:16px}
button{font:inherit;border-radius:8px;padding:10px 18px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
a{color:var(--accent)}
`;

const FONT_LINK = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=B612+Mono:wght@400;700&display=swap" rel="stylesheet">';

export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONT_LINK}<style>${PAGE_CSS}</style></head><body><main>${body}</main></body></html>`;
}

interface Line {
  description: string;
  price: string;
}

function lines(items: Line[], total: string): string {
  return `<table>${items.map((i) => `<tr><td>${esc(i.description)}</td><td class="amt">$${esc(i.price)}</td></tr>`).join('')}<tr class="total"><td>Total</td><td class="amt">$${esc(total)} USD</td></tr></table>`;
}

/** Mock mode only: the screen a buyer sees instead of PayPal's sandbox approval page. */
export function mockCheckoutPage(o: { orderId: string; agentName: string; items: Line[]; total: string; status: string }): string {
  const waiting = o.status === 'PAYER_ACTION_REQUIRED' || o.status === 'CREATED';
  return page(
    'Mock checkout',
    `<div class="panel">
<div class="banner">Mock mode. This page stands in for the PayPal sandbox approval screen. No PayPal account, no money. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to use the real sandbox.</div>
<h1>Approve a payment for your agent</h1>
<p class="muted">${esc(o.agentName)} wants to buy this data from Plainfeed.</p>
${lines(o.items, o.total)}
<p class="muted">Order <span class="mono">${esc(o.orderId)}</span></p>
${
  waiting
    ? `<div class="row"><form method="post" action="/mock-paypal/approve"><input type="hidden" name="token" value="${esc(o.orderId)}"><button class="primary" type="submit">Approve $${esc(o.total)}</button></form>
<form method="post" action="/mock-paypal/cancel"><input type="hidden" name="token" value="${esc(o.orderId)}"><button type="submit">Cancel</button></form></div>`
    : `<p class="ok">This order is ${esc(o.status.toLowerCase().replace(/_/g, ' '))}.</p>`
}
</div>`,
  );
}

export function returnPage(o: { ok: boolean; title: string; message: string; items?: Line[]; total?: string; orderId?: string; captureId?: string; receiptId?: string }): string {
  return page(
    o.title,
    `<div class="panel">
<h1>${esc(o.title)}</h1>
<p${o.ok ? ' class="ok"' : ''}>${esc(o.message)}</p>
${o.items && o.total ? lines(o.items, o.total) : ''}
${o.orderId ? `<p class="muted">PayPal order <span class="mono">${esc(o.orderId)}</span></p>` : ''}
${o.captureId ? `<p class="muted">Capture <span class="mono">${esc(o.captureId)}</span></p>` : ''}
${o.receiptId ? `<p class="muted">Receipt <span class="mono">${esc(o.receiptId)}</span></p>` : ''}
<p class="muted">You can close this tab and go back to your agent. <a href="/ledger">See the ledger</a>.</p>
</div>`,
  );
}
