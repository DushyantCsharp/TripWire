// Public ids: a type prefix plus the row's UUID in lowercase Crockford base32, e.g.
// inc_01k7a3x9m2q8r4t6v0w5y7z9b1. REST and GraphQL use them; the database stores the plain UUID.

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const PUBLIC_ID = /^([a-z]{3})_([0-9a-hjkmnp-tv-z]{26})$/;

export type IdPrefix = 'act' | 'alr' | 'apr' | 'inc' | 'ing' | 'run';

export function toPublicId(prefix: IdPrefix, uuid: string): string {
  let value = BigInt(`0x${uuid.replaceAll('-', '')}`);
  let encoded = '';
  for (let i = 0; i < 26; i++) {
    encoded = ALPHABET.charAt(Number(value & 31n)) + encoded;
    value >>= 5n;
  }
  return `${prefix}_${encoded}`;
}

/** The UUID behind a public id, or undefined when `id` isn't a valid id of this type. */
export function fromPublicId(prefix: IdPrefix, id: string): string | undefined {
  const match = PUBLIC_ID.exec(id);
  if (match?.[1] !== prefix || match[2] === undefined) return undefined;
  let value = 0n;
  for (const char of match[2]) value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  // 26 characters carry 130 bits; a UUID has 128.
  if (value >> 128n !== 0n) return undefined;
  const hex = value.toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
