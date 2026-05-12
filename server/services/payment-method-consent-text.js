/**
 * Single source of truth for the "save card" authorization copy.
 *
 * If you edit CONSENT_TEXT you MUST bump CONSENT_VERSION. Old consent
 * rows store the version string + a verbatim snapshot so they remain
 * interpretable forever.
 *
 * The client mirror lives at
 *   client/src/lib/paymentMethodConsentText.js
 * and must stay in sync with this file.
 */

const CONSENT_VERSION = 'v4_2026-05-12';

const CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this payment method and charge it for future service visits and',
  'invoices as agreed, until I revoke authorization in writing or by',
  'calling (941) 318-7612. Credit and debit card payments include a',
  '3.99% processing fee. I can manage or remove saved payment methods anytime in',
  'my customer portal.',
].join(' ');

module.exports = { CONSENT_TEXT, CONSENT_VERSION };
