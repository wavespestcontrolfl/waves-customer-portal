jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { hasConsentFor, hasEnrollmentScopedConsent, consentVersionQualifiesForEnrollment, findConsentedChargeableCard } = require('../services/payment-method-consents');

function qb(rows) {
  const q = {};
  q.where = jest.fn(() => q);
  q.select = jest.fn(async () => rows);
  return q;
}

// Enrollment authority requires the v8+ copy (the version whose text
// authorizes charging "for future service visits and invoices as agreed").
// Legacy versions and the backfill's implicit rows are audit anchors only
// (Codex #2507 P1 round-3).
describe('consentVersionQualifiesForEnrollment', () => {
  test('v8+ versions qualify', () => {
    expect(consentVersionQualifiesForEnrollment('v8_2026-06-17')).toBe(true);
    expect(consentVersionQualifiesForEnrollment('v9_2027-01-01')).toBe(true);
    expect(consentVersionQualifiesForEnrollment('v12_2028-05-05')).toBe(true);
  });

  test('legacy, implicit, and malformed versions do NOT qualify', () => {
    expect(consentVersionQualifiesForEnrollment('v0_implicit_pre_consent')).toBe(false);
    expect(consentVersionQualifiesForEnrollment('v7_2026-01-02')).toBe(false);
    expect(consentVersionQualifiesForEnrollment('v1')).toBe(false);
    expect(consentVersionQualifiesForEnrollment('')).toBe(false);
    expect(consentVersionQualifiesForEnrollment(null)).toBe(false);
    expect(consentVersionQualifiesForEnrollment('version8')).toBe(false);
  });
});

describe('hasConsentFor', () => {
  beforeEach(() => jest.clearAllMocks());

  test('true when ANY row for the pm carries qualifying copy', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v0_implicit_pre_consent' },
      { consent_text_version: 'v8_2026-06-17' },
    ]));
    expect(await hasConsentFor('cust-1', 'pm_x')).toBe(true);
  });

  test('false when only legacy/implicit rows exist (webhook-first race must fail closed)', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v0_implicit_pre_consent' },
      { consent_text_version: 'v7_2026-01-02' },
    ]));
    expect(await hasConsentFor('cust-1', 'pm_x')).toBe(false);
  });

  test('false with no rows or missing args', async () => {
    db.mockImplementation(() => qb([]));
    expect(await hasConsentFor('cust-1', 'pm_x')).toBe(false);
    expect(await hasConsentFor(null, 'pm_x')).toBe(false);
    expect(await hasConsentFor('cust-1', null)).toBe(false);
  });
});

// The auto-satisfy authority (findConsentedChargeableCard) requires an
// ENROLLMENT-SCOPED consent: the card-hold capture UI only authorizes the
// specific visit's completion charge + no-show fee, so its rows must never
// let a later recurring accept skip the Auto Pay checkbox (Codex #2680 r5).
describe('hasEnrollmentScopedConsent', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a v8+ estimate_card_hold row alone does NOT qualify', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v8_2026-06-17', source: 'estimate_card_hold' },
    ]));
    expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(false);
  });

  test('a v8+ consent from any save-and-charge surface qualifies', async () => {
    for (const source of ['pay_page', 'portal_add_card', 'estimate_accept', 'onboarding']) {
      db.mockImplementation(() => qb([{ consent_text_version: 'v9_2026-07-12', source }]));
      expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(true);
    }
  });

  test('a hold row does not poison a pm that ALSO carries a real consent', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v8_2026-06-17', source: 'estimate_card_hold' },
      { consent_text_version: 'v8_2026-06-17', source: 'pay_page' },
    ]));
    expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(true);
  });

  test('legacy versions never qualify regardless of source', async () => {
    db.mockImplementation(() => qb([
      { consent_text_version: 'v7_2026-01-02', source: 'pay_page' },
    ]));
    expect(await hasEnrollmentScopedConsent('cust-1', 'pm_x')).toBe(false);
  });
});

// A prior Auto Pay OPT-OUT blocks the auto-satisfy entirely (Codex #2681
// r6 P1): disabling keeps the saved cards, so an old consent row must not
// silently re-enroll the customer. Never-enrolled customers (no toggle
// history) still flow through to the card/consent checks.
describe('findConsentedChargeableCard — Auto Pay opt-out is sacred', () => {
  beforeEach(() => jest.clearAllMocks());

  function tableDb(map) {
    db.mockImplementation((table) => {
      const rows = map[table] || [];
      const q = {};
      q.where = jest.fn(() => q);
      q.whereIn = jest.fn(() => q);
      q.whereNotNull = jest.fn(() => q);
      q.orderBy = jest.fn(() => q);
      q.first = jest.fn(async () => rows[0] || null);
      q.select = jest.fn(async () => rows);
      q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return q;
    });
  }

  test('latest toggle = autopay_disabled -> returns null before touching cards', async () => {
    tableDb({
      autopay_log: [{ event_type: 'autopay_disabled' }],
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_x', method_type: 'card', exp_month: 12, exp_year: 2031 }],
      payment_method_consents: [{ consent_text_version: 'v9_2026-07-12', source: 'pay_page' }],
    });
    expect(await findConsentedChargeableCard('cust-1')).toBe(null);
  });

  test('latest toggle = autopay_enabled -> auto-satisfy proceeds to the card checks', async () => {
    tableDb({
      autopay_log: [{ event_type: 'autopay_enabled' }],
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_x', method_type: 'card', exp_month: 12, exp_year: 2031 }],
      payment_method_consents: [{ consent_text_version: 'v9_2026-07-12', source: 'pay_page' }],
    });
    const pm = await findConsentedChargeableCard('cust-1');
    expect(pm).toMatchObject({ id: 'pm-1' });
  });

  test('no toggle history (never enrolled) -> gate does not block', async () => {
    tableDb({
      autopay_log: [],
      payment_methods: [{ id: 'pm-1', stripe_payment_method_id: 'pm_x', method_type: 'card', exp_month: 12, exp_year: 2031 }],
      payment_method_consents: [{ consent_text_version: 'v9_2026-07-12', source: 'portal_add_card' }],
    });
    const pm = await findConsentedChargeableCard('cust-1');
    expect(pm).toMatchObject({ id: 'pm-1' });
  });
});
