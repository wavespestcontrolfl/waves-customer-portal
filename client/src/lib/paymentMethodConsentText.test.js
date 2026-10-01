// Client mirror parity for the pay-after-first-visit consent variants
// (GATE_PAY_AFTER_FIRST_VISIT). The server module is the source of truth.
import { describe, it, expect } from 'vitest';
import * as client from './paymentMethodConsentText';
import serverConsent from '../../../server/services/payment-method-consent-text';

describe('paymentMethodConsentText client mirror: after-visit variants', () => {
  it('versions match (global label unchanged, after-visit label v12)', () => {
    expect(client.CONSENT_VERSION).toBe(serverConsent.CONSENT_VERSION);
    expect(client.AFTER_VISIT_CONSENT_VERSION).toBe(serverConsent.AFTER_VISIT_CONSENT_VERSION);
    expect(client.AFTER_VISIT_CONSENT_VERSION).toBe('v12_2026-09-30');
  });

  it('every text is byte-identical to the server canonical', () => {
    expect(client.CARD_CONSENT_TEXT).toBe(serverConsent.CARD_CONSENT_TEXT);
    expect(client.ACH_CONSENT_TEXT).toBe(serverConsent.ACH_CONSENT_TEXT);
    expect(client.PREPAY_CARD_CONSENT_TEXT).toBe(serverConsent.PREPAY_CARD_CONSENT_TEXT);
    expect(client.PREPAY_ACH_CONSENT_TEXT).toBe(serverConsent.PREPAY_ACH_CONSENT_TEXT);
    expect(client.AFTER_VISIT_CARD_CONSENT_TEXT).toBe(serverConsent.AFTER_VISIT_CARD_CONSENT_TEXT);
    expect(client.AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT).toBe(serverConsent.AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT);
    expect(client.AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT).toBe(serverConsent.AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT);
  });

  it('getConsentText and consentVersionForVariant route identically to the server for every variant and family', () => {
    for (const methodType of ['card', 'us_bank_account', 'ach']) {
      for (const variant of [null, 'prepay_card', 'after_visit_card', 'after_visit_prepay']) {
        expect(client.getConsentText(methodType, { variant })).toBe(serverConsent.getConsentText(methodType, { variant }));
        expect(client.consentVersionForVariant(variant, methodType)).toBe(serverConsent.consentVersionForVariant(variant, methodType));
      }
    }
  });
});
