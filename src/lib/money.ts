// Money as whole cents. PayPal wants decimal strings like "0.05"; amounts never touch floats.

export type Cents = number;

/** "0.05" or "1" or "12.5" -> cents. Throws on anything that is not a plain non-negative amount. */
export function toCents(value: string): Cents {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!m) throw new Error(`Not a money amount: "${value}"`);
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

/** cents -> "0.05", the format PayPal expects for USD. */
export function toValue(cents: Cents): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`Bad cents value: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** cents -> "$0.05" for people. */
export function usd(cents: Cents): string {
  return `$${toValue(cents)}`;
}
