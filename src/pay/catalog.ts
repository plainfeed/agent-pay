// The price list: which API calls are for sale and what each one costs.
// A call is written the way an HTTP client would send it, for example "/v1/compare?a=lisbon&b=madrid".
// Each call is normalised (allowed parameters only, sorted) so the same request always gets the same price
// and the same line on the PayPal order.

import { readFileSync } from 'node:fs';
import { toCents, type Cents } from '../lib/money.ts';

export interface ProductConfig {
  id: string;
  path: string;
  price: string;
  label: string;
  /** How a call reads in plain English, with {param} placeholders. */
  describe: string;
  params?: string[];
  required?: string[];
}

export interface Product extends ProductConfig {
  priceCents: Cents;
  segments: string[];
}

export interface PricedCall {
  product: Product;
  /** Normalised call, for example "/v1/compare?a=lisbon&b=madrid". */
  call: string;
  path: string;
  query: Record<string, string>;
  pathParams: Record<string, string>;
  /** Plain English, for example "compare lisbon and madrid". */
  description: string;
  priceCents: Cents;
}

export class CallError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Catalog {
  readonly currency = 'USD' as const;
  readonly products: Product[];

  constructor(products: ProductConfig[]) {
    this.products = products.map((p) => ({ ...p, priceCents: toCents(p.price), segments: p.path.split('/').filter(Boolean) }));
  }

  static fromFile(path: string): Catalog {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { currency?: string; products: ProductConfig[] };
    if (cfg.currency && cfg.currency !== 'USD') throw new Error('Only USD prices are supported.');
    return new Catalog(cfg.products);
  }

  /** Price one call. Throws CallError for calls that are not for sale or have bad parameters. */
  price(rawCall: string): PricedCall {
    const s = String(rawCall ?? '').trim();
    if (!s.startsWith('/')) throw new CallError(400, 'bad_call', `A call must be a path such as "/v1/compare?a=lisbon&b=madrid", got "${s.slice(0, 80)}".`);
    let url: URL;
    try {
      url = new URL(s, 'http://gateway.invalid');
    } catch {
      throw new CallError(400, 'bad_call', `Not a valid call: "${s.slice(0, 80)}".`);
    }
    const segs = url.pathname.split('/').filter(Boolean).map((x) => decodeURIComponent(x));
    for (const product of this.products) {
      const pathParams = matchPath(product.segments, segs);
      if (!pathParams) continue;
      const allowed = new Set(product.params ?? []);
      const query: Record<string, string> = {};
      for (const [k, v] of url.searchParams) {
        if (!allowed.has(k)) throw new CallError(400, 'unknown_parameter', `"${k}" is not a parameter of ${product.path}. Allowed: ${[...allowed].join(', ') || 'none'}.`);
        if (v.trim()) query[k] = v.trim();
      }
      for (const r of product.required ?? []) if (!query[r]) throw new CallError(400, 'missing_parameter', `${product.path} needs "${r}".`);
      const keys = Object.keys(query).sort();
      const qs = keys.map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
      const path = '/' + segs.map((x) => encodeURIComponent(x)).join('/');
      const vars = { ...pathParams, ...query };
      const description = product.describe.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '').replace(/\s+/g, ' ').trim();
      return { product, call: qs ? `${path}?${qs}` : path, path, query, pathParams, description, priceCents: product.priceCents };
    }
    throw new CallError(404, 'not_for_sale', `Nothing is for sale at ${url.pathname}. See GET /v1/prices.`);
  }

  /** Public view of the price list. */
  list() {
    return {
      currency: this.currency,
      products: this.products.map((p) => ({ id: p.id, path: p.path, price: p.price, label: p.label, params: p.params ?? [], required: p.required ?? [], free: p.priceCents === 0 })),
    };
  }
}

function matchPath(template: string[], actual: string[]): Record<string, string> | null {
  if (template.length !== actual.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < template.length; i++) {
    const t = template[i];
    const m = /^\{(\w+)\}$/.exec(t);
    if (m) {
      if (!actual[i]) return null;
      out[m[1]] = actual[i];
    } else if (t !== actual[i]) return null;
  }
  return out;
}
