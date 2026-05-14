// Client mirror of server/services/payment-method-consent-text.js.
// Keep in sync — when the server version bumps, update this too.

export const CONSENT_VERSION = 'v5_2026-05-14';

export const CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it for future service visits and invoices as',
  'agreed, until I revoke authorization in writing or by calling',
  '(941) 318-7612. Credit and debit card payments include a 3.99%',
  'processing fee. I can manage or remove saved payment methods anytime',
  'in my customer portal.',
].join(' ');

export const ACH_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to',
  'initiate electronic ACH debits from the bank account identified',
  'above for each invoice in the amount of that invoice, on or after',
  'its due date (or on the Auto Pay billing day I have selected),',
  'until I revoke this authorization. I may revoke by writing to',
  'contact@wavespestcontrol.com or calling (941) 318-7612 at least',
  '3 business days before the next scheduled debit. A copy of this',
  'authorization will be emailed to me for my records. I can manage',
  'or remove saved payment methods anytime in my customer portal.',
].join(' ');

// Back-compat alias. Anything that imports CONSENT_TEXT without a method
// type falls back to the card variant.
export const CONSENT_TEXT = CARD_CONSENT_TEXT;

export function getConsentText(methodType) {
  if (methodType === 'us_bank_account' || methodType === 'ach') {
    return ACH_CONSENT_TEXT;
  }
  return CARD_CONSENT_TEXT;
}
