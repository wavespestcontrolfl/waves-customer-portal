'use strict';
// ONE list of the card brands Stripe can write to payments.card_brand / payment_methods.card_brand (the webhook stores
// `charge.payment_method_details.card.brand` — visa, mastercard, amex, discover, diners, jcb, unionpay, plus the regional
// eftpos_au / cartes_bancaires — upper-cased by some writers and spelled out by others). Everything that NAMES a brand — the
// customer-facing label (billing-email-details), the commitment tender text (sms-commitment-fulfillment), and the SMS drafter's
// tender vocabulary / row-brand canonicalizer (Codex round-42 P1, PR #5331) — derives from this table, so a brand one renderer
// can print can never be missing from the claim parser: an unlisted brand degrades "Your Discover card payment cleared" to a
// generic "card" claim that ANY card row (a Mastercard) then grounds.
//   id      canonical key (what cardBrandOfRow returns and 'card:<id>' tender labels carry)
//   name    the customer-facing spelling
//   spoken  words a customer or a reply names the brand with (longest first within a brand)
//   stored  extra spellings a writer may have stored (compared after lower-casing and dropping non-letters)
const CARD_BRANDS = Object.freeze([
  { id: 'visa', name: 'Visa', spoken: ['visa'], stored: [] },
  { id: 'mastercard', name: 'Mastercard', spoken: ['mastercard', 'master card'], stored: ['master'] },
  { id: 'amex', name: 'American Express', spoken: ['american express', 'amex'], stored: ['americanexpress'] },
  { id: 'discover', name: 'Discover', spoken: ['discover'], stored: [] },
  { id: 'diners', name: 'Diners Club', spoken: ['diners club', 'diners'], stored: ['dinersclub'] },
  { id: 'jcb', name: 'JCB', spoken: ['jcb'], stored: [] },
  { id: 'unionpay', name: 'UnionPay', spoken: ['union pay', 'unionpay'], stored: [] },
  { id: 'eftpos_au', name: 'EFTPOS', spoken: ['eftpos'], stored: ['eftposau'] },
  { id: 'cartes_bancaires', name: 'Cartes Bancaires', spoken: ['cartes bancaires'], stored: ['cartesbancaires'] },
]);

const squash = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^a-z]/g, '');
const BY_SQUASHED = new Map();
for (const b of CARD_BRANDS) {
  for (const k of [b.id, b.name, ...b.spoken, ...b.stored]) BY_SQUASHED.set(squash(k), b);
}

// A stored / spoken brand string -> its canonical id, or null (unknown / blank / not a listed brand).
function canonicalCardBrand(raw) {
  const b = BY_SQUASHED.get(squash(raw));
  return b ? b.id : null;
}
// A stored brand's customer-facing name; the raw text itself when it is not a listed brand ('' when blank).
function cardBrandDisplayName(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  const b = BY_SQUASHED.get(squash(text));
  return b ? b.name : text;
}
// Every spoken word, longest first (alternation order), for tender vocabularies / regexes.
const CARD_BRAND_SPOKEN = Object.freeze(
  CARD_BRANDS.flatMap((b) => b.spoken.map((word) => ({ word, id: b.id }))).sort((a, b) => b.word.length - a.word.length),
);
const CARD_BRAND_WORD_ALT = CARD_BRAND_SPOKEN.map((s) => s.word.replace(/ /g, '\\s+')).join('|');

module.exports = { CARD_BRANDS, CARD_BRAND_SPOKEN, CARD_BRAND_WORD_ALT, canonicalCardBrand, cardBrandDisplayName };
