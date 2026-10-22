// Print the ledger in plain English and check its hash chain.
//   npm run ledger            print every entry
//   npm run ledger:check    only check the chain (exit code 1 if broken)

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from '../src/pay/ledger.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const path = process.env.LEDGER_PATH ?? join(ROOT, '.local/ledger.jsonl');
const entries = Ledger.readFile(path);
const check = Ledger.check(entries);
if (!process.argv.includes('--check')) {
  if (!entries.length) console.log(`No entries yet in ${path}.`);
  for (const e of entries) console.log(`#${e.seq}  ${e.at.replace('T', ' ').slice(0, 19)} UTC  ${e.text}`);
  console.log('');
}
console.log(check.ok ? `Chain check: OK, ${check.entries} entries, nothing changed or removed.` : `Chain check: BROKEN at entry ${check.broken_at}: ${check.reason}.`);
process.exit(check.ok ? 0 : 1);
