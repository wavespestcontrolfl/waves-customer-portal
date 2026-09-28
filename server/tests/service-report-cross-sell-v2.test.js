// GATE_REPORT_CROSS_SELL_V2 (owner-approved 2026-09-27): findings- and
// season-aware priority layered on top of the report's cross-sell ladder
// (service-report-cross-sell.test.js covers the unchanged ladder itself).
// Covers: each priority branch (roach → cockroach_control, rodent →
// rodent_bait, termite activity → termite, heavy mosquito → mosquito),
// owned-service exclusion, the inactive/non-public catalog skip for
// cockroach_control, season boundaries by ET month, and gate off →
// identical to today's ladder output.

jest.mock('../services/property-lookup/lookup-cache', () => ({
  hasVerifiedOverrides: jest.fn(async () => false),
}));
jest.mock('../utils/datetime-et', () => ({
  ...jest.requireActual('../utils/datetime-et'),
  etDateString: jest.fn(),
}));

const { buildReportCrossSell, _private } = require('../services/service-report/cross-sell');
const { etDateString } = require('../utils/datetime-et');
const { detectReportFindingsSignal, buildCockroachFindingsOffer, resolveReportCrossSellV2 } = _private;

afterEach(() => {
  delete process.env.GATE_REPORT_CROSS_SELL_V2;
  etDateString.mockReset();
});

// ============================================================
// Unit level: detectReportFindingsSignal — reads ONLY service_findings
// (structured, staff/AI-reviewed rows) and the typed companion identity,
// never technician_notes (AGENTS.md raw-note rule).
// ============================================================
function fakeDb(tables = {}) {
  return (table) => {
    let rows = [...(tables[table] || [])];
    const query = {
      where(criteria) {
        if (criteria && typeof criteria === 'object') {
          rows = rows.filter((row) => Object.entries(criteria).every(([k, v]) => row[k] === v));
        }
        return query;
      },
      select: () => Promise.resolve(rows),
      first: () => Promise.resolve(rows[0] || null),
    };
    return query;
  };
}

describe('detectReportFindingsSignal', () => {
  test('roach text signal fires on a service_findings row mentioning "roach"', async () => {
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', category: 'observation', title: 'Active German roach activity in kitchen cabinets' }] });
    const signal = await detectReportFindingsSignal({ id: 'sr-1', service_data: '{}' }, db);
    expect(signal.roachesIndoors).toBe(true);
  });

  test('roach companion-typed signal fires when a companion snapshot (not the primary) is cockroach', async () => {
    const db = fakeDb({ service_findings: [] });
    const service = {
      id: 'sr-1',
      service_data: JSON.stringify({
        typedReportSnapshot: { type: 'pest' },
        companionReportSnapshots: [{ type: 'cockroach' }],
      }),
    };
    const signal = await detectReportFindingsSignal(service, db);
    expect(signal.roachesIndoors).toBe(true);
  });

  test('a cockroach-PRIMARY report (already mid-program today) is NOT itself the roach signal without a text mention', async () => {
    const db = fakeDb({ service_findings: [] });
    const service = { id: 'sr-1', service_data: JSON.stringify({ typedReportSnapshot: { type: 'cockroach' } }) };
    const signal = await detectReportFindingsSignal(service, db);
    expect(signal.roachesIndoors).toBe(false);
  });

  test('rodent evidence fires on "rat"/"mice" mentions', async () => {
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', category: 'observation', title: 'Signs of mice in the garage' }] });
    const signal = await detectReportFindingsSignal({ id: 'sr-1', service_data: '{}' }, db);
    expect(signal.rodentEvidence).toBe(true);
  });

  test('termite activity fires on swarmers / mud tubes / wood damage', async () => {
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', category: 'observation', title: 'Mud tubes observed on the exterior foundation' }] });
    const signal = await detectReportFindingsSignal({ id: 'sr-1', service_data: '{}' }, db);
    expect(signal.termiteActivity).toBe(true);
  });

  test('heavy mosquito needs at least two mentions — one mention is not "heavy"', async () => {
    const one = await detectReportFindingsSignal(
      { id: 'sr-1', service_data: '{}' },
      fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Customer mentioned mosquitoes in the backyard' }] }),
    );
    expect(one.heavyMosquito).toBe(false);
    const two = await detectReportFindingsSignal(
      { id: 'sr-1', service_data: '{}' },
      fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Heavy mosquito activity', detail: 'Standing water breeding mosquitoes near the shed' }] }),
    );
    expect(two.heavyMosquito).toBe(true);
  });

  test('never reads technician_notes — a raw-note-only mention is not a signal (AGENTS.md raw-note rule)', async () => {
    const db = fakeDb({ service_findings: [] });
    const service = { id: 'sr-1', service_data: '{}', technician_notes: '[Found] Roaches everywhere in the kitchen' };
    const signal = await detectReportFindingsSignal(service, db);
    expect(signal.roachesIndoors).toBe(false);
  });
});

// ============================================================
// Unit level: buildCockroachFindingsOffer — the one V2 target priced
// OUTSIDE buildCustomerPricingResponse (a fixed one-time catalog price).
// ============================================================
const ACTIVE_COCKROACH_ROW = { id: 'svc-cockroach', service_key: 'cockroach_control', is_active: true, is_archived: false, customer_visible: true, booking_enabled: true };

describe('buildCockroachFindingsOffer', () => {
  test('returns a fingerprinted quote_cta payload when the catalog row is active/customer-offerable and nothing is already scheduled', async () => {
    const db = fakeDb({ services: [ACTIVE_COCKROACH_ROW], scheduled_services: [] });
    const offer = await buildCockroachFindingsOffer({ id: 'sr-1', customer_id: 'cust-1' }, db);
    expect(offer.fullPayload.serviceKey).toBe('cockroach_control');
    expect(offer.fullPayload.mode).toBe('quote_cta');
    expect(offer.fullPayload.option).toBeNull();
    expect(offer.fullPayload.reason).toMatch(/roach/i);
    expect(typeof offer.fullPayload.fingerprint).toBe('string');
  });

  test.each([
    ['inactive', { ...ACTIVE_COCKROACH_ROW, is_active: false }],
    ['archived', { ...ACTIVE_COCKROACH_ROW, is_archived: true }],
    ['not customer_visible', { ...ACTIVE_COCKROACH_ROW, customer_visible: false }],
    ['not booking_enabled', { ...ACTIVE_COCKROACH_ROW, booking_enabled: false }],
  ])('skips the offer when the catalog row is %s', async (label, row) => {
    const db = fakeDb({ services: [row], scheduled_services: [] });
    const offer = await buildCockroachFindingsOffer({ id: 'sr-1', customer_id: 'cust-1' }, db);
    expect(offer).toBeNull();
  });

  test('skips the offer when the catalog row does not exist at all', async () => {
    const db = fakeDb({ services: [], scheduled_services: [] });
    const offer = await buildCockroachFindingsOffer({ id: 'sr-1', customer_id: 'cust-1' }, db);
    expect(offer).toBeNull();
  });

  test('already scheduled (an open linked visit) suppresses the offer — never re-pitch a mid-program customer', async () => {
    const db = fakeDb({
      services: [ACTIVE_COCKROACH_ROW],
      scheduled_services: [{ id: 'sched-1', customer_id: 'cust-1', service_id: 'svc-cockroach', status: 'confirmed' }],
    });
    const offer = await buildCockroachFindingsOffer({ id: 'sr-1', customer_id: 'cust-1' }, db);
    expect(offer).toBeNull();
  });

  test('a COMPLETED/CANCELLED linked visit is not "already scheduled" — the offer still renders', async () => {
    const db = fakeDb({
      services: [ACTIVE_COCKROACH_ROW],
      scheduled_services: [{ id: 'sched-1', customer_id: 'cust-1', service_id: 'svc-cockroach', status: 'completed' }],
    });
    const offer = await buildCockroachFindingsOffer({ id: 'sr-1', customer_id: 'cust-1' }, db);
    expect(offer).not.toBeNull();
  });
});

// ============================================================
// Unit level: resolveReportCrossSellV2 — priority order + owned-family
// exclusion + season boundaries.
// ============================================================
describe('resolveReportCrossSellV2 priority order', () => {
  const NO_SIGNAL_DB = fakeDb({ service_findings: [] });

  test('roach signal wins even when termite/mosquito season also matches (priority 1 beats priority 2)', async () => {
    etDateString.mockReturnValue('2026-07-15'); // mosquito season
    const db = fakeDb({
      service_findings: [{ service_record_id: 'sr-1', title: 'Roach activity found in the kitchen' }],
      services: [ACTIVE_COCKROACH_ROW],
      scheduled_services: [],
    });
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
      database: db,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result.fullPayload.serviceKey).toBe('cockroach_control');
  });

  test('rodent evidence wins over termite/mosquito when not already owned', async () => {
    etDateString.mockReturnValue('2026-11-01'); // outside both season windows
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Signs of rats in the attic' }] });
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
      database: db,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toEqual({ targetKey: 'rodent_bait', reason: expect.stringMatching(/rodent/i) });
  });

  test('rodent evidence is skipped when the customer already owns rodent_bait — falls through to season/ladder', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Signs of rats in the attic' }] });
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
      database: db,
      ladderEvidence: ['rodent_bait'],
      planRateFamilies: [],
    });
    expect(result).toBeNull();
  });

  test('termite activity wins over mosquito when not already owned', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Swarmers observed near the foundation' }] });
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
      database: db,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toEqual({ targetKey: 'termite', reason: expect.stringMatching(/termite/i) });
  });

  test('termite activity is skipped when already owned (termite_bait maps to termite ownership)', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Swarmers observed near the foundation' }] });
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
      database: db,
      ladderEvidence: ['termite_bait'],
      planRateFamilies: [],
    });
    expect(result).toBeNull();
  });

  test('heavy mosquito mention wins when not already owned', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Heavy mosquito pressure reported, mosquitoes everywhere in the yard' }] });
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
      database: db,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toEqual({ targetKey: 'mosquito', reason: expect.stringMatching(/mosquito/i) });
  });

  test('no findings signal, no season match, nothing owned to exclude → null (caller keeps the ladder pick)', async () => {
    etDateString.mockReturnValue('2026-11-15');
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
      database: NO_SIGNAL_DB,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toBeNull();
  });

  describe('season boundaries (America/New_York calendar month)', () => {
    test.each([
      ['2026-05-01', 'mosquito', 'May 1 → mosquito (checked first)'],
      ['2026-06-15', 'mosquito', 'June → mosquito'],
      ['2026-10-31', 'mosquito', 'Oct 31 → mosquito'],
      ['2026-02-01', 'termite', 'Feb 1 → termite swarm season'],
      ['2026-04-15', 'termite', 'April → termite swarm season'],
    ])('%s → %s (%s)', async (etDate, expectedKey) => {
      etDateString.mockReturnValue(etDate);
      const result = await resolveReportCrossSellV2({
        service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
        database: NO_SIGNAL_DB,
        ladderEvidence: [],
        planRateFamilies: [],
      });
      expect(result.targetKey).toBe(expectedKey);
    });

    test('November and December: neither season window — null', async () => {
      for (const etDate of ['2026-11-01', '2026-12-15']) {
        etDateString.mockReturnValue(etDate);
        const result = await resolveReportCrossSellV2({
          service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
          database: NO_SIGNAL_DB,
          ladderEvidence: [],
          planRateFamilies: [],
        });
        expect(result).toBeNull();
      }
    });

    test('May, already owning mosquito: falls through to termite swarm season', async () => {
      etDateString.mockReturnValue('2026-05-10');
      const result = await resolveReportCrossSellV2({
        service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
        database: NO_SIGNAL_DB,
        ladderEvidence: ['mosquito'],
        planRateFamilies: [],
      });
      expect(result.targetKey).toBe('termite');
    });

    test('a live plan-rate row on the target (never property-scoped, suppress/demote only) also excludes it', async () => {
      etDateString.mockReturnValue('2026-11-01');
      const db = fakeDb({ service_findings: [{ service_record_id: 'sr-1', title: 'Signs of rats in the attic' }] });
      const result = await resolveReportCrossSellV2({
        service: { id: 'sr-1', customer_id: 'cust-1', service_data: '{}' },
        database: db,
        ladderEvidence: [],
        planRateFamilies: ['rodent_bait'],
      });
      expect(result).toBeNull();
    });
  });
});

// ============================================================
// Integration level: buildReportCrossSell wiring — gate off is
// byte-identical to the ladder; gate on picks the V2 target and carries
// the reason; the card is still capped at one (the return shape is a
// single object, never an array).
// ============================================================
function dbForTables(tables = {}) {
  const dbFn = (table) => {
    const rows = tables[table] || [];
    const filtered = [];
    const applyFilter = (criteria) => {
      if (table !== 'customer_properties' || !criteria || typeof criteria !== 'object') return;
      filtered.push(criteria);
    };
    const visible = () => rows.filter((row) => filtered.every(
      (criteria) => Object.entries(criteria).every(([key, value]) => (
        key === 'customer_id' ? true : row[key] === value
      ))
    ));
    const q = {
      where(criteria) { applyFilter(criteria); return q; },
      whereNotIn() { return q; },
      orWhereNull() { return q; },
      leftJoin() { return q; },
      orderBy() { return q; },
      select() { return visible(); },
      limit() { return q; },
      first(col) { void col; return visible()[0] || null; },
      whereNotNull() { return q; },
      distinct() { return visible(); },
      columnInfo() {
        return table === 'scheduled_services'
          ? {
            is_recurring: {},
            service_address_line1: {},
            service_address_line2: {},
            service_address_city: {},
            service_address_zip: {},
          }
          : {};
      },
    };
    return q;
  };
  dbFn.schema = { hasTable: async (name) => Object.prototype.hasOwnProperty.call(tables, name) };
  return dbFn;
}

const FUTURE_SCHEDULED_DATE = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);

const CUSTOMER = (overrides = {}) => ({
  id: 'cust-1', active: true, waveguard_tier: 'Bronze', monthly_rate: 55,
  property_sqft: 4500, lot_sqft: 7000, lawn_type: 'St. Augustine',
  address_line1: '123 Gulf Dr', city: 'Sarasota', state: 'FL', zip: '34236',
  ...overrides,
});

const SERVICE = (overrides = {}) => ({
  id: 'sr-1', customer_id: 'cust-1', address_line1: '123 Gulf Dr', city: 'Sarasota', zip: '34236',
  service_date: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10),
  service_data: '{}',
  ...overrides,
});

function recurringRows(serviceTypes) {
  return serviceTypes.map((service_type, index) => ({
    id: `svc-${index + 1}`, service_type, scheduled_date: FUTURE_SCHEDULED_DATE, status: 'scheduled', is_recurring: true,
  }));
}

function dbFor({
  customer = CUSTOMER(), serviceTypes = [], turfProfile = null, estimates = [], planRates = [],
  properties = [], serviceFindings = [], catalogServices = [], cockroachLinked = [],
} = {}) {
  const scheduled = recurringRows(serviceTypes);
  return dbForTables({
    customers: [customer],
    customer_properties: properties,
    scheduled_services: [...scheduled, ...cockroachLinked],
    'scheduled_services as s': scheduled,
    customer_turf_profiles: turfProfile ? [turfProfile] : [],
    estimates,
    customer_plan_rates: planRates,
    service_findings: serviceFindings,
    services: catalogServices,
  });
}

const missLookup = async () => null;

describe('buildReportCrossSell integration: GATE_REPORT_CROSS_SELL_V2 wiring', () => {
  test('gate off: output is byte-identical to the unchanged ladder pick, even with a roach finding on file', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const findings = [{ title: 'Roach activity found in the kitchen' }];
    const before = await buildReportCrossSell(
      SERVICE(),
      dbFor({ serviceTypes: ['Pest Control'], turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' }, serviceFindings: findings }),
      { propertyLookup: missLookup },
    );
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'false';
    const withGateOff = await buildReportCrossSell(
      SERVICE(),
      dbFor({ serviceTypes: ['Pest Control'], turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' }, serviceFindings: findings }),
      { propertyLookup: missLookup },
    );
    expect(withGateOff).toEqual(before);
    expect(withGateOff.serviceKey).toBe('lawn_care'); // the unchanged ladder pick (pest-only → lawn)
    expect(withGateOff.reason).toBeUndefined();
  });

  test('gate on: a roach finding on a pest-only customer picks cockroach_control, carrying the reason, instead of the ladder\'s lawn pick', async () => {
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'true';
    const result = await buildReportCrossSell(
      SERVICE(),
      dbFor({
        serviceTypes: ['Pest Control'],
        turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
        serviceFindings: [{ title: 'Roach activity found in the kitchen' }],
        catalogServices: [ACTIVE_COCKROACH_ROW],
      }),
      { propertyLookup: missLookup },
    );
    expect(result.serviceKey).toBe('cockroach_control');
    expect(result.mode).toBe('quote_cta');
    expect(result.reason).toMatch(/roach/i);
    expect(typeof result.fingerprint).toBe('string');
  });

  test('gate on, no findings/season signal: falls straight through to the unchanged ladder pick', async () => {
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'true';
    etDateString.mockReturnValue('2026-11-01');
    const result = await buildReportCrossSell(
      SERVICE(),
      dbFor({ serviceTypes: ['Pest Control'], turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' } }),
      { propertyLookup: missLookup },
    );
    expect(result.serviceKey).toBe('lawn_care');
    expect(result.reason).toBeUndefined();
  });

  test('the report is always one object, never an array — one card max holds under V2 too', async () => {
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'true';
    const result = await buildReportCrossSell(
      SERVICE(),
      dbFor({
        serviceTypes: ['Pest Control'],
        turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
        serviceFindings: [{ title: 'Roach activity found in the kitchen' }],
        catalogServices: [ACTIVE_COCKROACH_ROW],
      }),
      { propertyLookup: missLookup },
    );
    expect(Array.isArray(result)).toBe(false);
    expect(result).not.toBeNull();
  });
});
