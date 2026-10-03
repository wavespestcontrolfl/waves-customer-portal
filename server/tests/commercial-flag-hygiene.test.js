/**
 * Commercial flag hygiene:
 *   - canonicalStoredPropertyType: 'Commercial' typed in the admin customer
 *     form must be stored as the exact lowercase literal the tax / invoice /
 *     triage readers match on, and nothing else may change.
 *   - the one-off migration lowercases only case/whitespace variants of
 *     commercial | business, on both tables, and copies nothing between them.
 *   - leadCommercialSignalFromReadiness: the webhook's lead row records the
 *     readiness gate's commercial verdict.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { canonicalStoredPropertyType } = require('../services/pricing-engine/commercial-helpers');
const { evaluateLeadEstimateAutomationReadiness } = require('../services/lead-estimate-automation');
const migration = require('../models/migrations/20261003120000_property_type_commercial_lowercase');

describe('canonicalStoredPropertyType', () => {
  test.each([
    ['Commercial', 'commercial'],
    ['COMMERCIAL', 'commercial'],
    ['  commercial ', 'commercial'],
    ['Business', 'business'],
    ['commercial', 'commercial'],
  ])('%j → %j', (input, expected) => {
    expect(canonicalStoredPropertyType(input)).toBe(expected);
  });

  test.each([
    ['single_family'],
    ['Single Family'],
    ['townhome'],
    ['office'],
    ['Restaurant'],
    ['commercial suite'],
    [''],
  ])('leaves %j untouched (no subtype widening — that would switch tax on)', (input) => {
    expect(canonicalStoredPropertyType(input)).toBe(input);
  });

  test('passes null / undefined through so a clear stays a clear', () => {
    expect(canonicalStoredPropertyType(null)).toBeNull();
    expect(canonicalStoredPropertyType(undefined)).toBeUndefined();
  });
});

describe('20261003120000_property_type_commercial_lowercase', () => {
  function fakeKnex({ tables = ['customers', 'customer_properties'] } = {}) {
    const raw = jest.fn().mockResolvedValue({});
    return {
      raw,
      schema: {
        hasTable: jest.fn(async (t) => tables.includes(t)),
        hasColumn: jest.fn(async () => true),
      },
    };
  }

  test('updates both tables, fenced to case/whitespace variants of commercial | business', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(2);
    const sqls = knex.raw.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' '));
    expect(sqls[0]).toContain('UPDATE customers SET property_type = LOWER(TRIM(property_type))');
    expect(sqls[1]).toContain('UPDATE customer_properties SET property_type = LOWER(TRIM(property_type))');
    for (const sql of sqls) {
      expect(sql).toContain("WHERE LOWER(TRIM(property_type)) IN ('commercial', 'business')");
      expect(sql).toContain('AND property_type <> LOWER(TRIM(property_type))');
      // Never a cross-table copy: the never-mirror-commercial fence stays.
      expect(sql).not.toMatch(/\bFROM\b|\bJOIN\b/i);
    }
  });

  test('skips a table that does not exist', async () => {
    const knex = fakeKnex({ tables: ['customers'] });
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
  });

  test('down is a no-op', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});

describe('leadCommercialSignalFromReadiness', () => {
  const { leadCommercialSignalFromReadiness } = require('../routes/lead-webhook')._test;

  test('true only when the readiness review carries the commercial marker', () => {
    expect(leadCommercialSignalFromReadiness({ review: ['commercial_signal_on_residential_intake'] })).toBe(true);
    expect(leadCommercialSignalFromReadiness({ review: ['email_missing_sms_only'] })).toBe(false);
    expect(leadCommercialSignalFromReadiness({ review: [] })).toBe(false);
    expect(leadCommercialSignalFromReadiness({})).toBe(false);
    expect(leadCommercialSignalFromReadiness(null)).toBe(false);
  });

  test('survives the automation-gate-off wrapper (review is kept, status disabled)', () => {
    expect(leadCommercialSignalFromReadiness({
      status: 'disabled', ready: false, disabled: true,
      review: ['commercial_signal_on_residential_intake'],
    })).toBe(true);
  });

  test('a form that states commercial outright produces the marker', () => {
    const prev = process.env.GATE_UNIT_SCOPE_GUARDRAILS;
    process.env.GATE_UNIT_SCOPE_GUARDRAILS = 'true';
    try {
      const readiness = evaluateLeadEstimateAutomationReadiness({
        intake: { address: '100 Example Plaza Dr', serviceInterest: 'Pest Control' },
        customer: { city: 'Bradenton', zip: '34202' },
        body: { isCommercial: 'yes' },
        phone: '+19415550100',
        serviceInterest: 'Pest Control',
      });
      expect(leadCommercialSignalFromReadiness(readiness)).toBe(true);
      const residential = evaluateLeadEstimateAutomationReadiness({
        intake: { address: '100 Example Palm Ct', serviceInterest: 'Pest Control' },
        customer: { city: 'Bradenton', zip: '34202' },
        body: {},
        phone: '+19415550100',
        serviceInterest: 'Pest Control',
      });
      expect(leadCommercialSignalFromReadiness(residential)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GATE_UNIT_SCOPE_GUARDRAILS;
      else process.env.GATE_UNIT_SCOPE_GUARDRAILS = prev;
    }
  });
});
