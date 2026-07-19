const DEFAULT_FDACS_LICENSE_NUMBER = 'JB351547';

function normalizeFdacsLicense(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/JB\d{4,}/i);
  return match ? match[0].toUpperCase() : DEFAULT_FDACS_LICENSE_NUMBER;
}

const WAVES_FDACS_LICENSE_NUMBER = normalizeFdacsLicense(
  process.env.WAVES_FDACS_LICENSE || process.env.WAVES_FDACS_LICENSE_NUMBER
);

const WAVES_BUSINESS_NAME = 'Waves Pest Control, LLC';
const WAVES_BRAND_NAME = 'Waves Pest Control';
const WAVES_WEBSITE_HOST = 'wavespestcontrol.com';
const WAVES_WEBSITE_URL = 'https://wavespestcontrol.com';
const WAVES_ADDRESS_LINE = '13649 Luxe Ave #110, Bradenton, FL 34211';
const WAVES_SUPPORT_PHONE_DISPLAY = '(941) 297-5749';
const WAVES_SUPPORT_PHONE_E164 = '+19412975749';
const WAVES_SUPPORT_PHONE_TEL = `tel:${WAVES_SUPPORT_PHONE_E164}`;
const WAVES_SUPPORT_SMS_TEL = `sms:${WAVES_SUPPORT_PHONE_E164}`;
const WAVES_FL_LICENSE_LINE = `FL License #${WAVES_FDACS_LICENSE_NUMBER}`;
const WAVES_FDACS_SHORT_LINE = `FDACS LIC. ${WAVES_FDACS_LICENSE_NUMBER}`;
// Marketing-site Products & Safety page — what we apply, re-entry guidance,
// household/pet notes. Keep in sync with client/src/constants/business.js.
const WAVES_PRODUCTS_SAFETY_URL = 'https://www.wavespestcontrol.com/products-and-safety/';

module.exports = {
  DEFAULT_FDACS_LICENSE_NUMBER,
  normalizeFdacsLicense,
  WAVES_FDACS_LICENSE_NUMBER,
  WAVES_BUSINESS_NAME,
  WAVES_BRAND_NAME,
  WAVES_WEBSITE_HOST,
  WAVES_WEBSITE_URL,
  WAVES_ADDRESS_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_E164,
  WAVES_SUPPORT_PHONE_TEL,
  WAVES_SUPPORT_SMS_TEL,
  WAVES_FL_LICENSE_LINE,
  WAVES_FDACS_SHORT_LINE,
  WAVES_PRODUCTS_SAFETY_URL,
};
