// Pay-after-first-visit consent variants (GATE_PAY_AFTER_FIRST_VISIT, owner
// ruling 2026-09-30). They landed beside the v12 rate-review sentence
// (#5434): every after-visit text carries RATE_IN_EFFECT_SENTENCE and is
// recorded under the shared v12_2026-09-30 label.
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const consentText = require('../services/payment-method-consent-text');
const {
  CONSENT_VERSION, AFTER_VISIT_CONSENT_VERSION, RATE_IN_EFFECT_SENTENCE, PREPAY_CONSENT_MARKER, getConsentText, consentVersionForVariant,
  CARD_CONSENT_TEXT, ACH_CONSENT_TEXT, PREPAY_CARD_CONSENT_TEXT, PREPAY_ACH_CONSENT_TEXT,
  AFTER_VISIT_CARD_CONSENT_TEXT, AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT, AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT,
} = consentText;
const { recordConsent, consentVersionQualifiesForEnrollment } = require('../services/payment-method-consents');

describe('after-visit consent variants', () => {
  test('the after-visit label is the shared v12_2026-09-30 (every variant carries the rate sentence)', () => {
    expect(CONSENT_VERSION).toBe('v12_2026-09-30');
    expect(AFTER_VISIT_CONSENT_VERSION).toBe(CONSENT_VERSION);
    // payment_method_consents.consent_text_version is varchar(20)
    expect(AFTER_VISIT_CONSENT_VERSION.length).toBeLessThanOrEqual(20);
    expect(consentVersionQualifiesForEnrollment(AFTER_VISIT_CONSENT_VERSION)).toBe(true);
  });

  test('base texts are unchanged for every existing variant', () => {
    expect(getConsentText('card')).toBe(CARD_CONSENT_TEXT);
    expect(getConsentText('card', { variant: 'prepay_card' })).toBe(PREPAY_CARD_CONSENT_TEXT);
    expect(getConsentText('us_bank_account')).toBe(ACH_CONSENT_TEXT);
    expect(getConsentText('ach', { variant: 'prepay_card' })).toBe(PREPAY_ACH_CONSENT_TEXT);
    expect(CARD_CONSENT_TEXT).toContain('charge it for future service visits and invoices');
    expect(PREPAY_CARD_CONSENT_TEXT).toContain('charge it now');
  });

  test('variant routing by method family', () => {
    expect(getConsentText('card', { variant: 'after_visit_card' })).toBe(AFTER_VISIT_CARD_CONSENT_TEXT);
    expect(getConsentText('card', { variant: 'after_visit_prepay' })).toBe(AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT);
    expect(getConsentText('us_bank_account', { variant: 'after_visit_prepay' })).toBe(AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT);
    expect(getConsentText('ach', { variant: 'after_visit_prepay' })).toBe(AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT);
    // after_visit_card has no bank-specific copy: the base ACH text covers it.
    expect(getConsentText('us_bank_account', { variant: 'after_visit_card' })).toBe(ACH_CONSENT_TEXT);
  });

  test('every after-visit text says nothing is charged today and the charge follows the first completed visit', () => {
    for (const t of [AFTER_VISIT_CARD_CONSENT_TEXT, AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT, AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT]) {
      expect(t).toMatch(/Nothing is (charged|debited) today/);
      expect(t).toContain('first service visit is completed');
      expect(t).not.toMatch(/charge it now|debit .* now/);
      expect(t).toContain('billing@wavespestcontrol.com');
    }
  });

  test('every after-visit text discloses the rate review (v12 sentence) and never reads as an immediate prepay charge', () => {
    for (const t of [AFTER_VISIT_CARD_CONSENT_TEXT, AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT, AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT]) {
      expect(t).toContain(RATE_IN_EFFECT_SENTENCE);
      // The immediate-charge marker the prepay recovery sweep matches on
      // must not match a consent that charges nothing today.
      expect(t).not.toContain(PREPAY_CONSENT_MARKER);
    }
  });

  test('prepay variants bind the 12-month total, allow a LOWER amount (credit), never a higher one', () => {
    for (const t of [AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT, AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT]) {
      expect(t).toContain('12-month annual prepay invoice');
      expect(t).toContain('exact total shown before I confirm');
      expect(t).toContain('lower amount if account credit applies, never a higher');
    }
  });

  test('card variants keep the surcharge disclosure; the ACH variant keeps the 3-business-day revocation', () => {
    expect(AFTER_VISIT_CARD_CONSENT_TEXT).toContain('surcharge of up to 2.9%');
    expect(AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT).toContain('surcharge of up to 2.9%');
    expect(AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT).toContain('at least 3 business days');
  });

  test('consentVersionForVariant: v12 only where after-visit copy is what gets stored', () => {
    expect(consentVersionForVariant(null)).toBe(CONSENT_VERSION);
    expect(consentVersionForVariant('prepay_card')).toBe(CONSENT_VERSION);
    expect(consentVersionForVariant('after_visit_card')).toBe(AFTER_VISIT_CONSENT_VERSION);
    expect(consentVersionForVariant('after_visit_prepay')).toBe(AFTER_VISIT_CONSENT_VERSION);
    expect(consentVersionForVariant('after_visit_prepay', 'us_bank_account')).toBe(AFTER_VISIT_CONSENT_VERSION);
    // after_visit_card on a bank stores the base ACH text, so it keeps the global label.
    expect(consentVersionForVariant('after_visit_card', 'us_bank_account')).toBe(CONSENT_VERSION);
  });
});

describe('recordConsent stores the variant snapshot under its own label', () => {
  function stubInsert() {
    const insert = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'row-1' }]) }));
    db.mockImplementation(() => ({ insert }));
    return insert;
  }
  beforeEach(() => jest.clearAllMocks());

  const base = { customerId: 'c1', paymentMethodId: 'pm-1', stripePaymentMethodId: 'pm_x', source: 'estimate_accept' };

  test('no variant: the global label + base card text', async () => {
    const insert = stubInsert();
    await recordConsent({ ...base });
    expect(insert.mock.calls[0][0]).toMatchObject({ consent_text_version: CONSENT_VERSION, consent_text_snapshot: CARD_CONSENT_TEXT });
  });

  test('prepay_card: the global label + prepay card text', async () => {
    const insert = stubInsert();
    await recordConsent({ ...base, consentVariant: 'prepay_card' });
    expect(insert.mock.calls[0][0]).toMatchObject({ consent_text_version: CONSENT_VERSION, consent_text_snapshot: PREPAY_CARD_CONSENT_TEXT });
  });

  test('after_visit_card: the v12 label + after-visit card text', async () => {
    const insert = stubInsert();
    await recordConsent({ ...base, consentVariant: 'after_visit_card' });
    expect(insert.mock.calls[0][0]).toMatchObject({ consent_text_version: AFTER_VISIT_CONSENT_VERSION, consent_text_snapshot: AFTER_VISIT_CARD_CONSENT_TEXT });
  });

  test('after_visit_prepay card and ACH: the v12 label + the matching text', async () => {
    const insert = stubInsert();
    await recordConsent({ ...base, consentVariant: 'after_visit_prepay' });
    await recordConsent({ ...base, methodType: 'us_bank_account', consentVariant: 'after_visit_prepay' });
    expect(insert.mock.calls[0][0]).toMatchObject({ consent_text_version: AFTER_VISIT_CONSENT_VERSION, consent_text_snapshot: AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT });
    expect(insert.mock.calls[1][0]).toMatchObject({ consent_text_version: AFTER_VISIT_CONSENT_VERSION, consent_text_snapshot: AFTER_VISIT_PREPAY_ACH_CONSENT_TEXT });
  });

  test('an explicit consentTextVersion (agreement-backed consent) still wins', async () => {
    const insert = stubInsert();
    await recordConsent({
      ...base, consentTextSnapshot: 'signed text', consentTextVersion: 'agreement_v3', evidenceContractId: 'ct-1',
    });
    expect(insert.mock.calls[0][0]).toMatchObject({ consent_text_version: 'agreement_v3', consent_text_snapshot: 'signed text' });
  });
});
