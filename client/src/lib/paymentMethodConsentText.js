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

// Redirect-return latch (codex #5434 r2 P1): a Stripe confirm that redirects
// (3DS, bank authorization) unloads the tab that rendered the consent, and
// the return may load a NEWER bundle whose text the customer never saw. The
// version the customer actually authorized under is latched here right
// before confirmSetup and read on the return: a restored capture whose
// latched version is not this bundle's (or has none — a bundle from before
// the latch) is NOT restored, so the customer re-authorizes under the current
// text instead of this bundle attesting its own version for that capture.
// Keyed by page path (one capture flow per page), sessionStorage so it dies
// with the tab; every access is guarded (private mode, blocked storage).
const CONSENT_LATCH_PREFIX = 'waves-ccv:';
function consentLatchKey(scope) {
  return `${CONSENT_LATCH_PREFIX}${scope || (typeof window !== 'undefined' ? window.location.pathname : '')}`;
}
export function latchConsentVersion(scope) {
  try { sessionStorage.setItem(consentLatchKey(scope), CONSENT_VERSION); } catch { /* storage unavailable — the return re-authorizes */ }
}
export function clearLatchedConsentVersion(scope) {
  try { sessionStorage.removeItem(consentLatchKey(scope)); } catch { /* nothing latched */ }
}
export function latchedConsentVersionIsCurrent(scope) {
  try { return sessionStorage.getItem(consentLatchKey(scope)) === CONSENT_VERSION; } catch { return false; }
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

// Mirror of the server's AFTER_VISIT_CONSENT_VERSION (GATE_PAY_AFTER_FIRST_VISIT):
// the after-visit variants carry RATE_IN_EFFECT_SENTENCE like every other
// variant and share the v12 label.
export const AFTER_VISIT_CONSENT_VERSION = CONSENT_VERSION;

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

// Pay-after-first-visit card capture (GATE_PAY_AFTER_FIRST_VISIT): nothing is
// charged at approval; the saved card is charged for the first visit's
// invoice (incl. any one-time setup fee) once that visit is completed, and
// for future invoices as agreed.
export const AFTER_VISIT_CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it after my first service visit is completed for',
  'that visit\'s invoice (including any one-time setup fee), and for future',
  'service visits and invoices as agreed, until I revoke authorization.',
  'Nothing is charged today.',
  RATE_IN_EFFECT_SENTENCE,
  'I can revoke anytime — email',
  `billing@wavespestcontrol.com, call ${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the`,
  'card in the Waves app or my customer portal. A credit card surcharge',
  'of up to 2.9% may apply; the exact surcharge and total will be shown',
  'before payment. Debit cards, prepaid cards, and bank transfers have',
  'no added card surcharge.',
].join(' ');

// Annual prepay, card, charged after the first visit. The amount is the
// exact total shown at approval, or LOWER if account credit applies by then
// — never higher.
export const AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and, after my first service visit is completed, charge it for',
  'my 12-month annual prepay invoice at the exact total shown before I',
  'confirm (or a lower amount if account credit applies, never a higher',
  'amount), and charge it for future invoices as agreed (including plan',
  'renewals), until I revoke authorization. Nothing is charged today.',
  RATE_IN_EFFECT_SENTENCE,
  'I can revoke anytime — email billing@wavespestcontrol.com, call',
  `${WAVES_SUPPORT_PHONE_DISPLAY}, or remove the card in the Waves app or my customer`,
  'portal. A credit card surcharge of up to 2.9% may apply; the exact',
  'surcharge and total will be shown before payment. Debit cards, prepaid',
  'cards, and bank transfers have no added card surcharge.',
].join(' ');

// Annual prepay, saved BANK method, debited after the first visit.
export const AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate an electronic ACH debit from my saved bank account after my',
  'first service visit is completed for my 12-month annual prepay invoice',
  'at the exact total shown before I confirm (or a lower amount if',
  'account credit applies, never a higher amount), and to initiate',
  'electronic ACH debits from that account for future invoices as agreed',
  '(including plan renewals), each in the amount of that invoice, until I',
  'revoke this authorization. Nothing is debited today.',
  RATE_IN_EFFECT_SENTENCE,
  'I may revoke by',
  `writing to billing@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY}`,
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
    if (variant === 'after_visit_prepay') return AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT;
    // after_visit_card has no bank-specific copy (base ACH text covers it).
    return ACH_CONSENT_TEXT;
  }
  if (variant === 'prepay_card') return PREPAY_CARD_CONSENT_TEXT;
  if (variant === 'after_visit_prepay') return AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT;
  if (variant === 'after_visit_card') return AFTER_VISIT_CARD_CONSENT_TEXT;
  return CARD_CONSENT_TEXT;
}

const AFTER_VISIT_VARIANTS = new Set(['after_visit_prepay', 'after_visit_card']);
export function consentVersionForVariant(variant, methodType = 'card') {
  if (!AFTER_VISIT_VARIANTS.has(variant)) return CONSENT_VERSION;
  const isBank = methodType === 'us_bank_account' || methodType === 'ach';
  if (isBank && variant === 'after_visit_card') return CONSENT_VERSION;
  return AFTER_VISIT_CONSENT_VERSION;
}
