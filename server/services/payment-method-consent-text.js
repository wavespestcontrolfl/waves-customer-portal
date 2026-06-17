/**
 * Single source of truth for the saved-payment-method authorization copy.
 *
 * Split by method family because card-on-file and ACH have different
 * regulatory floors:
 *   - Card-on-file: card-network rules + TILA/Reg Z. The card variant
 *     covers scope, revocation, and surcharge.
 *   - ACH (us_bank_account): NACHA Operating Rules + Reg E (12 CFR 1005.10).
 *     The ACH variant adds explicit ACH debit language, amount + frequency,
 *     the 3-business-day revocation timing, and a copy-of-authorization
 *     promise.
 *
 * If you edit either text you MUST bump CONSENT_VERSION. Old consent rows
 * store the version string + a verbatim snapshot so they remain
 * interpretable forever.
 *
 * The client mirror lives at
 *   client/src/lib/paymentMethodConsentText.js
 * and must stay in sync with this file.
 */

const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const CONSENT_VERSION = 'v8_2026-06-17';

const CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it for future service visits and invoices as',
  'agreed, until I revoke authorization in writing or by calling',
  `${WAVES_SUPPORT_PHONE_DISPLAY}. A credit card surcharge of up to 2.9% may apply;`,
  'the exact surcharge and total will be shown before payment. Debit cards,',
  'prepaid cards, and bank transfers have no added card surcharge.',
  'I can manage or remove saved payment methods anytime in my customer portal.',
].join(' ');

const ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate electronic ACH debits from the bank account identified',
  'above for each invoice in the amount of that invoice, on or after',
  'its due date (or on the Auto Pay billing day I have selected),',
  'until I revoke this authorization. I may revoke by writing to',
  `contact@wavespestcontrol.com or calling ${WAVES_SUPPORT_PHONE_DISPLAY} at least`,
  '3 business days before the next scheduled debit. I may request a',
  'copy of this authorization at any time by contacting Waves at the',
  'email or phone above. I can manage or remove saved payment methods',
  'anytime in my customer portal.',
].join(' ');

// Back-compat alias. Anything that imports CONSENT_TEXT without knowing
// the method type defaults to the card variant — keeps onboarding and
// contract code working without a forced refactor in this PR.
const CONSENT_TEXT = CARD_CONSENT_TEXT;

function getConsentText(methodType) {
  // Accept both Stripe-style ('us_bank_account') and DB-style ('ach')
  // to be forgiving at call sites.
  if (methodType === 'us_bank_account' || methodType === 'ach') {
    return ACH_CONSENT_TEXT;
  }
  return CARD_CONSENT_TEXT;
}

module.exports = {
  CONSENT_TEXT,
  CARD_CONSENT_TEXT,
  ACH_CONSENT_TEXT,
  CONSENT_VERSION,
  getConsentText,
};
