// Client mirror of server/services/payment-method-consent-text.js.
// Keep in sync — when the server version bumps, update this too.
import { WAVES_SUPPORT_PHONE_DISPLAY } from '../constants/business';

export const CONSENT_VERSION = 'v8_2026-06-17';

export const CARD_CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this card and charge it for future service visits and invoices as',
  'agreed, until I revoke authorization in writing or by calling',
  `${WAVES_SUPPORT_PHONE_DISPLAY}. A credit card surcharge of up to 2.9% may apply;`,
  'the exact surcharge and total will be shown before payment. Debit cards,',
  'prepaid cards, and bank transfers have no added card surcharge.',
  'I can manage or remove saved payment methods anytime in my customer portal.',
].join(' ');

export const ACH_CONSENT_TEXT = [
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

// Back-compat alias. Anything that imports CONSENT_TEXT without a method
// type falls back to the card variant.
export const CONSENT_TEXT = CARD_CONSENT_TEXT;

export function getConsentText(methodType) {
  if (methodType === 'us_bank_account' || methodType === 'ach') {
    return ACH_CONSENT_TEXT;
  }
  return CARD_CONSENT_TEXT;
}
