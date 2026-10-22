import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toCents, toValue, usd } from '../src/lib/money.ts';
import { canonicalJson } from '../src/lib/crypto.ts';

describe('money', () => {
  it('parses decimal strings to whole cents', () => {
    assert.equal(toCents('0.05'), 5);
    assert.equal(toCents('1'), 100);
    assert.equal(toCents('12.5'), 1250);
    assert.equal(toCents(' 2.00 '), 200);
  });
  it('rejects anything that is not a plain amount', () => {
    for (const bad of ['-1', '1.234', 'abc', '', '1e3', '0.0.1']) assert.throws(() => toCents(bad), /Not a money amount/);
  });
  it('formats cents the way PayPal expects', () => {
    assert.equal(toValue(5), '0.05');
    assert.equal(toValue(0), '0.00');
    assert.equal(toValue(123456), '1234.56');
    assert.equal(usd(9), '$0.09');
    assert.throws(() => toValue(1.5));
    assert.throws(() => toValue(-1));
  });
  it('round-trips without float drift', () => {
    for (let c = 0; c < 1000; c += 7) assert.equal(toCents(toValue(c)), c);
  });
});

describe('canonical JSON', () => {
  it('sorts keys at every level and drops undefined', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  });
});
