import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { GENESIS, Ledger } from '../src/pay/ledger.ts';
import { tempDir } from './helpers.ts';

function fill(l: Ledger) {
  l.append({ type: 'order_created', text: 'Agent asked to pay $0.07.', agent_id: 'a', amount: '0.07', paypal_order_id: 'O1' });
  l.append({ type: 'payment_captured', text: 'Paid: $0.07 from Agent through PayPal.', agent_id: 'a', amount: '0.07', paypal_order_id: 'O1', paypal_capture_id: 'C1' });
  l.append({ type: 'cap_blocked', text: 'Blocked: over the limit. No money moved.', agent_id: 'b', amount: '0.60' });
}

describe('ledger', () => {
  it('chains every entry to the one before it', () => {
    const l = new Ledger(null, () => new Date('2026-10-22T10:00:00Z'));
    fill(l);
    const e = l.entries();
    assert.deepEqual(
      e.map((x) => x.seq),
      [1, 2, 3],
    );
    assert.equal(e[0].prev, GENESIS);
    assert.equal(e[1].prev, e[0].hash);
    assert.equal(e[2].prev, e[1].hash);
    assert.match(e[0].hash, /^[0-9a-f]{64}$/);
    assert.equal(e[0].at, '2026-10-22T10:00:00.000Z');
    assert.deepEqual(l.verify(), { ok: true, entries: 3, broken_at: null, reason: null });
  });

  it('keeps the chain going across restarts', () => {
    const path = join(tempDir(), 'ledger.jsonl');
    fill(new Ledger(path));
    const again = new Ledger(path);
    const e = again.append({ type: 'refunded', text: 'Refunded: $0.07.', amount: '0.07' });
    assert.equal(e.seq, 4);
    assert.equal(again.verify().ok, true);
    assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 4);
  });

  it('detects a changed entry and says which one', () => {
    const path = join(tempDir(), 'ledger.jsonl');
    fill(new Ledger(path));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    lines[1] = lines[1].replace('"amount":"0.07"', '"amount":"0.01"');
    writeFileSync(path, lines.join('\n') + '\n');
    const c = Ledger.check(Ledger.readFile(path));
    assert.equal(c.ok, false);
    assert.equal(c.broken_at, 2);
    assert.match(c.reason ?? '', /changed/);
  });

  it('detects a removed entry', () => {
    const path = join(tempDir(), 'ledger.jsonl');
    fill(new Ledger(path));
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, [lines[0], lines[2]].join('\n') + '\n');
    const c = Ledger.check(Ledger.readFile(path));
    assert.equal(c.ok, false);
    assert.equal(c.broken_at, 2);
  });

  it('refuses to append to a ledger that fails its check', () => {
    const path = join(tempDir(), 'ledger.jsonl');
    fill(new Ledger(path));
    writeFileSync(path, readFileSync(path, 'utf8').replace('No money moved', 'Money moved'));
    assert.throws(() => new Ledger(path), /fails its chain check at entry 3/);
  });
});
