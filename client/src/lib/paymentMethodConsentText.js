// Client mirror of server/services/payment-method-consent-text.js.
// Keep in sync — when the server version bumps, update this too.

export const CONSENT_VERSION = 'v2_2026-04-28';

export const CONSENT_TEXT = [
  'By checking this box, I authorize Waves Pest Control, LLC to save',
  'this payment method and charge it for future service visits and',
  'invoices as agreed, until I revoke authorization in writing or by',
  'calling (941) 297-5749. Credit and debit card payments include a',
  '3.99% processing fee. I can manage or remove saved cards anytime in',
  'my customer portal.',
].join(' ');
