/**
 * Commercial flag hygiene:
 *   - canonicalStoredPropertyType: 'Commercial' typed in the admin customer
 *     form must be stored as the exact lowercase literal the tax / invoice /
 *     triage readers match on, and nothing else may change.
 *   - the one-off migration lowercases only case/whitespace variants of
 *     commercial | business, on both tables, copies nothing between them,
 *     and writes one audit_log row per changed record.
 *   - leadCommercialSignalFromReadiness: the webhook's lead row records the
 *     readiness gate's commercial verdict.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { canonicalStoredPropertyType } = require('../services/pricing-engine/commercial-helpers');
const { evaluateLeadEstimateAutomationReadiness } = require('../services/lead-estimate-automation');
const migration = require('../models/migrations/20261003121500_commercial_property_type_lowercase_audited');

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

describe('20261003121500_commercial_property_type_lowercase_audited', () => {
  // Minimal in-memory knex: two tables + audit_log, enough for the
  // select-for-update / update-by-id / insert / delete shapes the migration uses.
  function fakeKnex(seed, { audit = true } = {}) {
    const data = {
      customers: (seed.customers || []).map((r) => ({ ...r })),
      customer_properties: (seed.customer_properties || []).map((r) => ({ ...r })),
      audit_log: [],
    };
    const isVariant = (v) => typeof v === 'string'
      && ['commercial', 'business'].includes(v.trim().toLowerCase())
      && v !== v.trim().toLowerCase();
    const builder = (table) => {
      let rows = data[table];
      const qb = {
        whereRaw: jest.fn((sql) => {
          expect(sql).toBe(migration._test.VARIANT_WHERE);
          rows = rows.filter((r) => isVariant(r.property_type));
          return qb;
        }),
        where: jest.fn((cond) => {
          rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
          return qb;
        }),
        forUpdate: jest.fn(() => qb),
        select: jest.fn(async () => rows.map((r) => ({ ...r }))),
        update: jest.fn(async (patch) => { rows.forEach((r) => Object.assign(r, patch)); return rows.length; }),
        insert: jest.fn(async (row) => { data[table].push({ ...row }); }),
        del: jest.fn(async () => {
          const gone = new Set(rows);
          data[table] = data[table].filter((r) => !gone.has(r));
          return gone.size;
        }),
      };
      return qb;
    };
    const trx = jest.fn(builder);
    const knex = {
      schema: {
        hasTable: jest.fn(async (t) => (t === 'audit_log' ? audit : t in data)),
        hasColumn: jest.fn(async () => true),
      },
      transaction: jest.fn(async (fn) => fn(trx)),
    };
    return { knex, data };
  }

  const seed = {
    customers: [
      { id: 'c1', property_type: 'Commercial' },
      { id: 'c2', property_type: 'commercial' },
      { id: 'c3', property_type: null },
      { id: 'c4', property_type: 'Single Family' },
      { id: 'c5', property_type: ' BUSINESS ' },
      { id: 'c6', property_type: 'Office' },
    ],
    customer_properties: [
      { id: 'p1', property_type: 'Commercial' },
      { id: 'p2', property_type: 'commercial' },
      { id: 'p3', property_type: null },
    ],
  };

  test('lowercases only case/whitespace variants, on both tables, copying nothing across', async () => {
    const { knex, data } = fakeKnex(seed);
    await migration.up(knex);
    expect(data.customers.map((r) => r.property_type))
      .toEqual(['commercial', 'commercial', null, 'Single Family', 'business', 'Office']);
    // p3 stays NULL: no value is mirrored from customers to properties or back.
    expect(data.customer_properties.map((r) => r.property_type)).toEqual(['commercial', 'commercial', null]);
  });

  test('writes one audit row per changed record with before/after', async () => {
    const { knex, data } = fakeKnex(seed);
    await migration.up(knex);
    expect(data.audit_log.map((r) => [r.actor_type, r.action, r.resource_type, r.resource_id, r.metadata]))
      .toEqual([
        ['system:migration', migration._test.AUDIT_ACTION, 'customer', 'c1', { field: 'property_type', before: 'Commercial', after: 'commercial' }],
        ['system:migration', migration._test.AUDIT_ACTION, 'customer', 'c5', { field: 'property_type', before: ' BUSINESS ', after: 'business' }],
        ['system:migration', migration._test.AUDIT_ACTION, 'customer_properties', 'p1', { field: 'property_type', before: 'Commercial', after: 'commercial' }],
      ]);
  });

  test('a second run changes nothing and records nothing', async () => {
    const { knex, data } = fakeKnex(seed);
    await migration.up(knex);
    await migration.up(knex);
    expect(data.audit_log).toHaveLength(3);
  });

  test('the predicate is fenced to commercial | business variants', () => {
    const sql = migration._test.VARIANT_WHERE.replace(/\s+/g, ' ');
    expect(sql).toBe("LOWER(TRIM(property_type)) IN ('commercial', 'business') AND property_type <> LOWER(TRIM(property_type))");
  });

  test('down restores the recorded spelling only where the value is still ours, and appends — never deletes — audit rows', async () => {
    const { knex, data } = fakeKnex(seed);
    await migration.up(knex);
    data.customers.find((r) => r.id === 'c5').property_type = 'single_family'; // edited since
    await migration.down(knex);
    expect(data.customers.find((r) => r.id === 'c1').property_type).toBe('Commercial');
    expect(data.customers.find((r) => r.id === 'c5').property_type).toBe('single_family');
    expect(data.customer_properties.find((r) => r.id === 'p1').property_type).toBe('Commercial');
    const rollbacks = data.audit_log.filter((r) => r.action === migration._test.AUDIT_ROLLBACK_ACTION);
    expect(data.audit_log.filter((r) => r.action === migration._test.AUDIT_ACTION)).toHaveLength(3);
    expect(rollbacks.map((r) => [r.resource_type, r.resource_id, r.metadata])).toEqual([
      ['customer', 'c1', { field: 'property_type', before: 'commercial', after: 'Commercial' }],
      ['customer_properties', 'p1', { field: 'property_type', before: 'commercial', after: 'Commercial' }],
    ]);
    // A second down finds nothing still holding our value.
    await migration.down(knex);
    expect(data.audit_log).toHaveLength(5);
  });

  test('without audit_log the rows are still corrected', async () => {
    const { knex, data } = fakeKnex(seed, { audit: false });
    await migration.up(knex);
    expect(data.customers[0].property_type).toBe('commercial');
    expect(data.audit_log).toHaveLength(0);
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

describe('commercialLeadFields (fresh insert + attached call lead)', () => {
  const { commercialLeadFields } = require('../routes/lead-webhook')._test;

  test('a commercial verdict promotes the row', () => {
    expect(commercialLeadFields({ review: ['commercial_signal_on_residential_intake'] }))
      .toEqual({ is_commercial: true, is_residential: false });
  });

  test('a residential verdict writes nothing, so it cannot clear an attached lead\'s flag', () => {
    expect(commercialLeadFields({ review: [] })).toEqual({});
    expect(commercialLeadFields(null)).toEqual({});
  });

  test('the columns survive the phone-attach merge filter (false is kept)', () => {
    const merged = {};
    for (const [k, v] of Object.entries(commercialLeadFields({ review: ['commercial_signal_on_residential_intake'] }))) {
      if (v === null || v === undefined || v === '') continue;
      merged[k] = v;
    }
    expect(merged).toEqual({ is_commercial: true, is_residential: false });
  });
});

describe('syncPrimaryPropertyType', () => {
  const { syncPrimaryPropertyType } = require('../services/customer-properties');

  function fakeConn() {
    const qb = {
      where: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      update: jest.fn().mockResolvedValue(1),
    };
    const conn = jest.fn(() => qb);
    return { conn, qb };
  }

  test('writes the type to the active primary property only when it differs', async () => {
    const { conn, qb } = fakeConn();
    await expect(syncPrimaryPropertyType('cust-1', 'commercial', conn)).resolves.toBe(1);
    expect(conn).toHaveBeenCalledWith('customer_properties');
    expect(qb.where).toHaveBeenCalledWith({ customer_id: 'cust-1', is_primary: true, active: true });
    expect(qb.whereRaw).toHaveBeenCalledWith("COALESCE(property_type, '') <> ?", ['commercial']);
    expect(qb.update).toHaveBeenCalledWith(expect.objectContaining({ property_type: 'commercial' }));
  });

  test.each([[null], [undefined], [''], ['   ']])('a blank (%j) is never propagated', async (blank) => {
    const { conn } = fakeConn();
    await expect(syncPrimaryPropertyType('cust-1', blank, conn)).resolves.toBe(0);
    expect(conn).not.toHaveBeenCalled();
  });

  test('no customer id → no write', async () => {
    const { conn } = fakeConn();
    await expect(syncPrimaryPropertyType(null, 'commercial', conn)).resolves.toBe(0);
    expect(conn).not.toHaveBeenCalled();
  });
});
