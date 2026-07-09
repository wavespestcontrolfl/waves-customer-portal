jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { hasConsentFor, consentVersionQualifiesForEnrollment } = require('../services/payment-method-consents');

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
