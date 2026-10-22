// Where the data being sold comes from.
//   SampleSource    a tiny bundled dataset (data/sample-cities.json), so the repo runs on its own
//   UpstreamSource  forwards each paid call to a real Plainfeed feed, adding the seller's own feed key.
//                   The feed's code and data stay private; buyers never see the key.

import { readFileSync } from 'node:fs';
import type { PricedCall } from '../pay/catalog.ts';

export interface SourceResult {
  status: number;
  body: unknown;
}

export interface DataSource {
  readonly name: string;
  get(call: PricedCall): Promise<SourceResult>;
}

interface SampleCity {
  id: string;
  name: string;
  country: string;
  lodging: number;
  meals_incidentals: number;
}

function norm(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export class SampleSource implements DataSource {
  readonly name = 'sample';
  private readonly cities: SampleCity[];
  private readonly note: string;

  constructor(path: string) {
    const d = JSON.parse(readFileSync(path, 'utf8')) as { note: string; cities: SampleCity[] };
    this.cities = d.cities;
    this.note = d.note;
  }

  private view(c: SampleCity) {
    return { id: c.id, name: c.name, country: c.country, currency: 'USD', lodging: c.lodging, meals_incidentals: c.meals_incidentals, per_diem: c.lodging + c.meals_incidentals, sample: true };
  }

  private find(q: string): SampleCity | undefined {
    const n = norm(q);
    return this.cities.find((c) => c.id === q.toLowerCase()) ?? this.cities.find((c) => norm(c.name) === n) ?? this.cities.find((c) => norm(c.name).startsWith(n));
  }

  async get(call: PricedCall): Promise<SourceResult> {
    switch (call.product.id) {
      case 'sources':
        return { status: 200, body: { sample: true, note: this.note, records: this.cities.length, live_feed: 'https://citycost.plainfeed.workers.dev/v1/sources' } };
      case 'cities.search': {
        const q = call.query.q ? norm(call.query.q) : '';
        const country = call.query.country ? norm(call.query.country) : '';
        const limit = Math.min(50, Math.max(1, Number(call.query.limit) || 10));
        const items = this.cities.filter((c) => (!q || norm(c.name).includes(q) || c.id.includes(q)) && (!country || norm(c.country) === country)).slice(0, limit);
        return { status: 200, body: { total: items.length, items: items.map((c) => this.view(c)), note: this.note } };
      }
      case 'cities.get': {
        const c = this.find(call.pathParams.id ?? '');
        if (!c) return { status: 404, body: { error: { code: 'not_found', message: `No city matches "${call.pathParams.id}".` } } };
        return { status: 200, body: { ...this.view(c), note: this.note } };
      }
      case 'cities.compare': {
        const a = this.find(call.query.a ?? '');
        const b = this.find(call.query.b ?? '');
        if (!a || !b) return { status: 404, body: { error: { code: 'not_found', message: `No city matches "${!a ? call.query.a : call.query.b}".` } } };
        const va = this.view(a);
        const vb = this.view(b);
        const pct = Math.round((va.per_diem / vb.per_diem - 1) * 100);
        const rel = pct === 0 ? 'the same as' : pct > 0 ? `${pct}% more than` : `${-pct}% less than`;
        return {
          status: 200,
          body: {
            a: va,
            b: vb,
            ratio: Number((va.per_diem / vb.per_diem).toFixed(3)),
            summary: `A travel day in ${a.name} costs $${va.per_diem}, ${rel} ${b.name} at $${vb.per_diem} (sample numbers).`,
            note: this.note,
          },
        };
      }
      default:
        return { status: 404, body: { error: { code: 'not_found', message: `The sample dataset has nothing for ${call.call}.` } } };
    }
  }
}

export class UpstreamSource implements DataSource {
  readonly name = 'upstream';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly doFetch: (url: string, init?: RequestInit) => Promise<Response>;

  constructor(baseUrl: string, apiKey: string, doFetch: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)) {
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('UPSTREAM_URL must start with http:// or https://');
    if (!apiKey) throw new Error('UPSTREAM_API_KEY is required with UPSTREAM_URL.');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.doFetch = doFetch;
  }

  async get(call: PricedCall): Promise<SourceResult> {
    let res: Response;
    try {
      res = await this.doFetch(this.baseUrl + call.call, {
        headers: { 'x-api-key': this.apiKey, accept: 'application/json', 'user-agent': 'plainfeed-agent-pay/0.1' },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      return { status: 502, body: { error: { code: 'upstream_unreachable', message: `The data feed did not answer: ${(e as Error).message}` } } };
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { code: 'upstream_bad_response', message: text.slice(0, 200) } };
    }
    // The seller's own key problems are the seller's, not the buyer's: report them as a gateway fault.
    if (res.status === 401 || res.status === 403 || res.status === 429) return { status: 502, body: { error: { code: 'upstream_refused', message: `The data feed refused the gateway's key (HTTP ${res.status}).` } } };
    return { status: res.status, body };
  }
}
