import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AgentRegistry } from '../src/pay/agents.ts';
import { CallError, Catalog } from '../src/pay/catalog.ts';
import { sha256Hex } from '../src/lib/crypto.ts';
import { DEMO_KEY, ROOT } from './helpers.ts';

const catalog = Catalog.fromFile(join(ROOT, 'config/prices.json'));

function callError(fn: () => unknown): CallError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CallError) return e;
    throw e;
  }
  throw new Error('expected a CallError');
}

describe('price list', () => {
  it('prices a call and writes it in plain English', () => {
    const p = catalog.price('/v1/compare?b=madrid&a=lisbon');
    assert.equal(p.product.id, 'cities.compare');
    assert.equal(p.priceCents, 5);
    assert.equal(p.call, '/v1/compare?a=lisbon&b=madrid');
    assert.equal(p.description, 'Compare lisbon and madrid');
  });
  it('the same request always normalises to the same call', () => {
    assert.equal(catalog.price('/v1/compare?a=lisbon&b=madrid').call, catalog.price('/v1/compare?b=madrid&a=lisbon&').call);
  });
  it('reads path parameters', () => {
    const p = catalog.price('/v1/cities/pt-lisbon');
    assert.equal(p.product.id, 'cities.get');
    assert.deepEqual(p.pathParams, { id: 'pt-lisbon' });
    assert.equal(p.priceCents, 2);
  });
  it('marks free calls', () => {
    assert.equal(catalog.price('/v1/sources').priceCents, 0);
  });
  it('refuses unknown parameters, missing required ones, and things not for sale', () => {
    assert.equal(callError(() => catalog.price('/v1/compare?a=x&b=y&evil=1')).code, 'unknown_parameter');
    assert.equal(callError(() => catalog.price('/v1/compare?a=lisbon')).code, 'missing_parameter');
    const e = callError(() => catalog.price('/v1/export'));
    assert.equal(e.code, 'not_for_sale');
    assert.equal(e.status, 404);
    assert.equal(callError(() => catalog.price('compare lisbon')).code, 'bad_call');
  });
  it('lists prices publicly', () => {
    const l = catalog.list();
    assert.equal(l.currency, 'USD');
    assert.ok(l.products.some((p) => p.id === 'cities.compare' && p.price === '0.05' && !p.free));
  });
});

describe('agent registry', () => {
  it('finds agents by key hash, never by plain key', () => {
    const r = AgentRegistry.fromFiles([join(ROOT, 'config/agents.json')]);
    const a = r.lookup(DEMO_KEY);
    assert.equal(a?.id, 'demo-agent');
    assert.equal(a?.orderCapCents, 25);
    assert.equal(a?.dailyCapCents, 100);
    assert.equal(r.lookup('wrong'), null);
    assert.equal(r.lookup(null), null);
    assert.equal(r.byId('demo-agent')?.name, 'Trip planner (demo)');
  });
  it('rejects bad configs', () => {
    const ok = { id: 'x1', name: 'X', key_sha256: sha256Hex('k'), order_cap: '0.10', daily_cap: '1.00' };
    assert.throws(() => new AgentRegistry([{ ...ok, order_cap: '2.00' }]), /order_cap is above daily_cap/);
    assert.throws(() => new AgentRegistry([{ ...ok, key_sha256: 'plain' }]), /SHA-256/);
    assert.throws(() => new AgentRegistry([ok, { ...ok, key_sha256: sha256Hex('j') }]), /listed twice/);
  });
});
