export const DEFAULT_FDACS_LICENSE_NUMBER = 'JB351547';

export function normalizeFdacsLicense(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/JB\d{4,}/i);
  return match ? match[0].toUpperCase() : DEFAULT_FDACS_LICENSE_NUMBER;
}

export const WAVES_FDACS_LICENSE_NUMBER = normalizeFdacsLicense(
  import.meta.env.VITE_WAVES_FDACS_LICENSE
);
export const WAVES_FL_LICENSE_LINE = `FL License #${WAVES_FDACS_LICENSE_NUMBER}`;

export const WAVES_SUPPORT_PHONE_DISPLAY = '(941) 297-5749';
export const WAVES_SUPPORT_PHONE_TEL = 'tel:+19412975749';
export const WAVES_SUPPORT_SMS_TEL = 'sms:+19412975749';

// Commercial account manager (owner 2026-08-08: proposals name Adam, not a
// faceless "your Waves account manager"). Keep in sync with
// ACCOUNT_MANAGER_FIRST_NAME in server/routes/estimate-public.js (SSR
// proposal banner) — the client bundle can't import server constants.
export const WAVES_ACCOUNT_MANAGER_FIRST_NAME = 'Adam';

// Registered business address — keep in sync with WAVES_ADDRESS_LINE in
// server/constants/business.js (the client bundle can't import it).
export const WAVES_ADDRESS_LINE = '13649 Luxe Ave #110, Bradenton, FL 34211';

// Marketing-site Products & Safety page — what we apply, re-entry guidance,
// household/pet notes. Keep in sync with server/constants/business.js.
export const WAVES_PRODUCTS_SAFETY_URL = 'https://www.wavespestcontrol.com/products-and-safety/';
