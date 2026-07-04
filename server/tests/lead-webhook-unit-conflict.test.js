// Codex rd11: /api/leads fails closed (400) on contradictory inline vs
// dedicated units BEFORE any lead/customer mutation — same guard as
// /public/quote/calculate and /property-lookup. The route reads
// normalizedAddress.unitConflict off the intake; pin that propagation here
// (the flag's own semantics are covered in address-normalizer.test.js).

jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); return db; });
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { _test } = require('../routes/lead-webhook');
const { buildLeadWebhookIntake } = _test;

describe('buildLeadWebhookIntake — unit conflict flag (codex rd11)', () => {
  test('disagreeing inline + dedicated units surface unitConflict on the intake', () => {
    const intake = buildLeadWebhookIntake({
      address: '123 Main St Apt A, Sarasota, FL 34236',
      address_line2: 'Apt B',
    });
    expect(intake.normalizedAddress.unitConflict).toBe(true);
  });

  test('agreeing units (any notation) and unit-less submissions do not flag', () => {
    expect(buildLeadWebhookIntake({
      address: '123 Main St Apt A, Sarasota, FL 34236',
      address_line2: '#A',
    }).normalizedAddress.unitConflict).toBe(false);
    expect(buildLeadWebhookIntake({
      address: '123 Main St, Sarasota, FL 34236',
    }).normalizedAddress.unitConflict).toBe(false);
  });
});
