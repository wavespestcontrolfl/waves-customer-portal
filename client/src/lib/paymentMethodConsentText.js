// Client mirror of server/services/payment-method-consent-text.js.
// Keep in sync — when the server version bumps, update this too.
import { WAVES_SUPPORT_PHONE_DISPLAY } from '../constants/business';

export const CONSENT_VERSION = 'v12_2026-09-30';

// Rendered-version attestation (codex #5434 r1 P1): every request that
// captures a payment-method consent sends the CONSENT_VERSION of the text
// THIS bundle rendered beside its checkbox. The server refuses a capture
// whose version is not its current one (409 CONSENT_VERSION_STALE — the
// text changed under an open tab) before any Stripe work or ledger write,
// so a tab left open across a copy change can never be recorded as
// agreeing to text it never showed. Spread into the request body.
export const CONSENT_VERSION_STALE_CODE = 'CONSENT_VERSION_STALE';
export function consentAttestation() {
  return { consentTextVersion: CONSENT_VERSION };
}

// The refresh prompt the capture UIs show for that 409 (the server's own
// message when it sent one).
export const CONSENT_VERSION_STALE_MESSAGE = 'The payment authorization text was updated. Please refresh the page and try again.';
export function isConsentVersionStale(body) {
  return body?.code === CONSENT_VERSION_STALE_CODE;
}

// v12: the rate sentence shared by every variant — mirror of the server's
// RATE_IN_EFFECT_SENTENCE.
export const RATE_IN_EFFECT_SENTENCE = 'Each invoice is billed at the rate then in effect, including rates changed on at least 30 days’ written notice.';

export const CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it for future service visits and invoices as',
  'agreed, until I revoke authorization.',
  RATE_IN_EFFECT_SENTENCE,
  'I can revoke anytime — email',
  `billing@wavespestcontrol.com, call ${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the`,
  'card in the Waves app or my customer portal. A credit card surcharge',
  'of up to 2.9% may apply; the exact surcharge and total will be shown',
  'before payment. Debit cards, prepaid cards, and bank transfers have',
  'no added card surcharge.',
].join(' ');

export const ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate electronic ACH debits from the bank account identified',
  'above for each invoice in the amount of that invoice, on or after',
  'its due date (or on the Auto Pay billing day I have selected),',
  'until I revoke this authorization.',
  RATE_IN_EFFECT_SENTENCE,
  'I may revoke by writing to',
  `billing@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY} at least`,
  '3 business days before the next scheduled debit. I may request a',
  'copy of this authorization at any time by contacting Waves at the',
  'email or phone above. I can manage or remove saved payment methods',
  'anytime in my customer portal.',
].join(' ');

// Annual-prepay card capture (GATE_PREPAY_CARD_AND_CHARGE): the accept
// charges the 12-month prepay invoice immediately after booking — mirror of
// the server's PREPAY_CARD_CONSENT_TEXT.
export const PREPAY_CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card, charge it now for my 12-month annual prepay invoice at the',
  'exact total shown before I confirm, and charge it for future invoices',
  'as agreed (including plan renewals), until I revoke authorization.',
  RATE_IN_EFFECT_SENTENCE,
  'I can revoke anytime — email billing@wavespestcontrol.com, call',
  `${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the card in the Waves app or my customer`,
  'portal. A credit card surcharge of up to 2.9% may apply; the exact',
  'surcharge and total will be shown before payment. Debit cards, prepaid',
  'cards, and bank transfers have no added card surcharge.',
].join(' ');

// Annual-prepay immediate debit on an already-saved BANK method (Codex
// #3492 r11) — mirror of the server's PREPAY_ACH_CONSENT_TEXT.
export const PREPAY_ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate an electronic ACH debit from my saved bank account now for',
  'my 12-month annual prepay invoice at the exact total shown before I',
  'confirm, and to initiate electronic ACH debits from that account for',
  'future invoices as agreed (including plan renewals), each in the',
  'amount of that invoice, until I revoke this authorization.',
  RATE_IN_EFFECT_SENTENCE,
  `I may revoke by writing to billing@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY}`,
  'at least 3 business days before the next scheduled debit. I may',
  'request a copy of this authorization at any time by contacting Waves',
  'at the email or phone above. I can manage or remove saved payment',
  'methods anytime in my customer portal. Bank transfers have no added',
  'card surcharge.',
].join(' ');

// Back-compat alias. Anything that imports CONSENT_TEXT without a method
// type falls back to the card variant.
export const CONSENT_TEXT = CARD_CONSENT_TEXT;

export function getConsentText(methodType, { variant = null } = {}) {
  if (methodType === 'us_bank_account' || methodType === 'ach') {
    if (variant === 'prepay_card') return PREPAY_ACH_CONSENT_TEXT;
    return ACH_CONSENT_TEXT;
  }
  if (variant === 'prepay_card') return PREPAY_CARD_CONSENT_TEXT;
  return CARD_CONSENT_TEXT;
}
