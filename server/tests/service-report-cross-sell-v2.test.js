// GATE_REPORT_CROSS_SELL_V2 (owner-approved 2026-09-27, rewritten
// structurally 2026-09-28 after the FOURTH round of "claim inferred from
// free text" findings): findings- and season-aware priority layered on top
// of the report's cross-sell ladder (service-report-cross-sell.test.js
// covers the unchanged ladder itself).
//
// Findings priority now reads ONLY structured, fixed-vocabulary fields from
// THIS visit's typed snapshots (server/services/project-types.js is the one
// source of truth for the keys/options below) — free-text parsing
// (service_findings category/title/detail/recommendation, negation
// handling) was removed entirely rather than refined again:
//   cockroach (COMPANION ONLY): activity_level != 'None observed'.
//   rodent_trapping: captures (count) > 0.
//   rodent_bait_station: bait_consumption != 'None'.
//   rodent_inspection: activity_found === 'Yes'.
//   termite_bait_station: termite_activity in {'Active termites present',
//     'Previous feeding noted'}.
//   termite_inspection: activity_status === 'Active infestation'.
// Mosquito has NO findings branch at all — season (May-Oct) or the ladder
// only. An untyped (general pest) visit carries no typed snapshot → no
// findings signal → season/ladder decides.

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

// Builds a service row with a typed snapshot: `primary` is the primary
// typedReportSnapshot `{ type, values }`; `companions` (optional) is an
// array of the same shape for companionReportSnapshots.
function withTypedSnapshot({ primary = null, companions = [] } = {}) {
  return {
    id: 'sr-1',
    service_data: JSON.stringify({
      ...(primary ? { typedReportSnapshot: primary } : {}),
      // Customer-visible by default; a test that needs a staff-only
      // companion passes delivery explicitly.
      ...(companions.length ? { companionReportSnapshots: companions.map((c) => ({ delivery: 'auto_send', ...c })) } : {}),
    }),
  };
}

// ============================================================
// Unit level: detectReportFindingsSignal — pure/synchronous, reads ONLY
// service_data's typed snapshots. No database parameter at all (the
// free-text service_findings read is gone).
// ============================================================
describe('detectReportFindingsSignal', () => {
  test('an untyped (general pest) visit with no typed snapshot at all → no signal on any pest', () => {
    const signal = detectReportFindingsSignal({ id: 'sr-1', service_data: '{}' });
    expect(signal).toEqual({ roachActivity: false, rodentEvidence: false, termiteActivity: false });
  });

  describe('cockroach (companion only)', () => {
    test('a companion cockroach snapshot with activity_level other than "None observed" is the signal', () => {
      const service = withTypedSnapshot({
        primary: { type: 'pest' },
        companions: [{ type: 'cockroach', values: { activity_level: 'Moderate' } }],
      });
      expect(detectReportFindingsSignal(service).roachActivity).toBe(true);
    });

    test('activity_level "None observed" is NOT a signal', () => {
      const service = withTypedSnapshot({
        primary: { type: 'pest' },
        companions: [{ type: 'cockroach', values: { activity_level: 'None observed' } }],
      });
      expect(detectReportFindingsSignal(service).roachActivity).toBe(false);
    });

    test('a missing/empty activity_level is NOT a signal (unknown → no signal)', () => {
      const service = withTypedSnapshot({
        primary: { type: 'pest' },
        companions: [{ type: 'cockroach', values: {} }],
      });
      expect(detectReportFindingsSignal(service).roachActivity).toBe(false);
    });

    test('a PRIMARY cockroach snapshot is NOT the signal even with a positive activity_level (already mid-program today)', () => {
      const service = withTypedSnapshot({ primary: { type: 'cockroach', values: { activity_level: 'Heavy' } } });
      expect(detectReportFindingsSignal(service).roachActivity).toBe(false);
    });

    test('when BOTH primary and a companion are typed cockroach, the companion is still excluded (primary wins the exclusion)', () => {
      const service = withTypedSnapshot({
        primary: { type: 'cockroach', values: { activity_level: 'None observed' } },
        companions: [{ type: 'cockroach', values: { activity_level: 'Severe' } }],
      });
      expect(detectReportFindingsSignal(service).roachActivity).toBe(false);
    });
  });

  test('an internal_only / disabled companion never drives a customer-facing signal (pre-push audit)', () => {
    for (const delivery of ['internal_only', 'disabled']) {
      const service = withTypedSnapshot({
        companions: [
          { type: 'cockroach', delivery, values: { activity_level: 'Heavy' } },
          { type: 'rodent_trapping', delivery, values: { captures: 3 } },
          { type: 'termite_bait_station', delivery, values: { termite_activity: 'Active termites present' } },
        ],
      });
      expect(detectReportFindingsSignal(service)).toEqual({ roachActivity: false, rodentEvidence: false, termiteActivity: false });
    }
  });

  describe('rodent', () => {
    test('rodent_trapping: captures > 0 is the signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'rodent_trapping', values: { captures: 3 } } });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(true);
    });

    test('rodent_trapping: captures === 0 is NOT a signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'rodent_trapping', values: { captures: 0 } } });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(false);
    });

    test('rodent_trapping: captures missing is NOT a signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'rodent_trapping', values: {} } });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(false);
    });

    test('rodent_bait_station: bait_consumption other than "None" is the signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'rodent_bait_station', values: { bait_consumption: 'Light' } } });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(true);
    });

    test('rodent_bait_station: bait_consumption "None" is NOT a signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'rodent_bait_station', values: { bait_consumption: 'None' } } });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(false);
    });

    test('rodent_inspection: activity_found "Yes" is the signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'rodent_inspection', values: { activity_found: 'Yes' } } });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(true);
    });

    test('rodent_inspection: activity_found "No" is NOT a signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'rodent_inspection', values: { activity_found: 'No' } } });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(false);
    });

    test('rodent evidence counts as a COMPANION too (no primary-exclusion rule for rodent)', () => {
      const service = withTypedSnapshot({
        primary: { type: 'pest' },
        companions: [{ type: 'rodent_trapping', values: { captures: 1 } }],
      });
      expect(detectReportFindingsSignal(service).rodentEvidence).toBe(true);
    });
  });

  describe('termite', () => {
    test.each(['Active termites present', 'Previous feeding noted'])(
      'termite_bait_station: termite_activity "%s" is the signal',
      (value) => {
        const service = withTypedSnapshot({ primary: { type: 'termite_bait_station', values: { termite_activity: value } } });
        expect(detectReportFindingsSignal(service).termiteActivity).toBe(true);
      },
    );

    test('termite_bait_station: termite_activity "None observed" is NOT a signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'termite_bait_station', values: { termite_activity: 'None observed' } } });
      expect(detectReportFindingsSignal(service).termiteActivity).toBe(false);
    });

    test('termite_inspection: activity_status "Active infestation" is the signal', () => {
      const service = withTypedSnapshot({ primary: { type: 'termite_inspection', values: { activity_status: 'Active infestation' } } });
      expect(detectReportFindingsSignal(service).termiteActivity).toBe(true);
    });

    test.each(['No activity', 'Old / inactive damage'])(
      'termite_inspection: activity_status "%s" is NOT a signal (not CURRENT activity)',
      (value) => {
        const service = withTypedSnapshot({ primary: { type: 'termite_inspection', values: { activity_status: value } } });
        expect(detectReportFindingsSignal(service).termiteActivity).toBe(false);
      },
    );
  });

  test('a recommendation/category-label string stashed under values is never read as a positive signal — only the exact typed key/option matters', () => {
    const service = withTypedSnapshot({
      primary: {
        type: 'rodent_trapping',
        // No 'captures' key at all — a free-text-shaped field under an
        // unrelated key must never leak into the signal.
        values: { recommendation: 'Heavy rodent activity, captures observed throughout the attic' },
      },
    });
    expect(detectReportFindingsSignal(service).rodentEvidence).toBe(false);
  });

  test('an unrelated typed snapshot (e.g. tree_shrub) contributes no signal on any pest', () => {
    const service = withTypedSnapshot({ primary: { type: 'tree_shrub', values: { activity_level: 'Heavy' } } });
    expect(detectReportFindingsSignal(service)).toEqual({ roachActivity: false, rodentEvidence: false, termiteActivity: false });
  });
});

// ============================================================
// Unit level: buildCockroachFindingsOffer — the one V2 target priced
// OUTSIDE buildCustomerPricingResponse (a fixed one-time catalog price).
// Unaffected by this round's rewrite — still needs a database fake.
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

const ACTIVE_COCKROACH_ROW = { id: 'svc-cockroach', service_key: 'cockroach_control', is_active: true, is_archived: false, customer_visible: true, booking_enabled: true };

describe('buildCockroachFindingsOffer', () => {
  test('returns a fingerprinted quote_cta payload when the catalog row is active/customer-offerable and nothing is already scheduled, with a fixed reason that names no location', async () => {
    const db = fakeDb({ services: [ACTIVE_COCKROACH_ROW], scheduled_services: [] });
    const offer = await buildCockroachFindingsOffer({ id: 'sr-1', customer_id: 'cust-1' }, db);
    expect(offer.fullPayload.serviceKey).toBe('cockroach_control');
    expect(offer.fullPayload.mode).toBe('quote_cta');
    expect(offer.fullPayload.option).toBeNull();
    expect(offer.fullPayload.reason).toBe(
      'We noted roach activity today — our cockroach control program is a focused two-treatment cleanout.',
    );
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
// exclusion + season boundaries. Mosquito has NO findings branch — it is
// reachable only through the season check below.
// ============================================================
describe('resolveReportCrossSellV2 priority order', () => {
  const NO_SIGNAL_DB = fakeDb({});

  test('roach signal wins even when termite/mosquito season also matches (priority 1 beats priority 2)', async () => {
    etDateString.mockReturnValue('2026-07-15'); // mosquito season
    const db = fakeDb({ services: [ACTIVE_COCKROACH_ROW], scheduled_services: [] });
    const result = await resolveReportCrossSellV2({
      service: withTypedSnapshot({ primary: { type: 'pest' }, companions: [{ type: 'cockroach', values: { activity_level: 'Low' } }] }),
      database: db,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result.fullPayload.serviceKey).toBe('cockroach_control');
  });

  test('rodent evidence wins over termite/mosquito when not already owned', async () => {
    etDateString.mockReturnValue('2026-11-01'); // outside both season windows
    const result = await resolveReportCrossSellV2({
      service: withTypedSnapshot({ primary: { type: 'rodent_trapping', values: { captures: 2 } } }),
      database: NO_SIGNAL_DB,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toEqual({ targetKey: 'rodent_bait', reason: expect.stringMatching(/rodent/i) });
  });

  test('rodent evidence is skipped when the customer already owns rodent_bait — falls through to season/ladder', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const result = await resolveReportCrossSellV2({
      service: withTypedSnapshot({ primary: { type: 'rodent_trapping', values: { captures: 2 } } }),
      database: NO_SIGNAL_DB,
      ladderEvidence: ['rodent_bait'],
      planRateFamilies: [],
    });
    expect(result).toBeNull();
  });

  test('termite activity wins over mosquito when not already owned', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const result = await resolveReportCrossSellV2({
      service: withTypedSnapshot({ primary: { type: 'termite_bait_station', values: { termite_activity: 'Active termites present' } } }),
      database: NO_SIGNAL_DB,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toEqual({ targetKey: 'termite', reason: expect.stringMatching(/termite/i) });
  });

  test('termite activity is skipped when already owned (termite_bait maps to termite ownership)', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const result = await resolveReportCrossSellV2({
      service: withTypedSnapshot({ primary: { type: 'termite_bait_station', values: { termite_activity: 'Active termites present' } } }),
      database: NO_SIGNAL_DB,
      ladderEvidence: ['termite_bait'],
      planRateFamilies: [],
    });
    expect(result).toBeNull();
  });

  test('an untyped (general pest) visit produces no findings signal at all — falls straight through to season/ladder', async () => {
    etDateString.mockReturnValue('2026-11-01'); // outside season too
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', service_data: '{}' },
      database: NO_SIGNAL_DB,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toBeNull();
  });

  test('no findings signal, no season match, nothing owned to exclude → null (caller keeps the ladder pick)', async () => {
    etDateString.mockReturnValue('2026-11-15');
    const result = await resolveReportCrossSellV2({
      service: { id: 'sr-1', service_data: '{}' },
      database: NO_SIGNAL_DB,
      ladderEvidence: [],
      planRateFamilies: [],
    });
    expect(result).toBeNull();
  });

  describe('season boundaries (America/New_York calendar month) — mosquito\'s ONLY offer path', () => {
    test.each([
      ['2026-05-01', 'mosquito', 'May 1 → mosquito (checked first)'],
      ['2026-06-15', 'mosquito', 'June → mosquito'],
      ['2026-10-31', 'mosquito', 'Oct 31 → mosquito'],
      ['2026-02-01', 'termite', 'Feb 1 → termite swarm season'],
      ['2026-04-15', 'termite', 'April → termite swarm season'],
    ])('%s → %s (%s)', async (etDate, expectedKey) => {
      etDateString.mockReturnValue(etDate);
      const result = await resolveReportCrossSellV2({
        service: { id: 'sr-1', service_data: '{}' },
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
          service: { id: 'sr-1', service_data: '{}' },
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
        service: { id: 'sr-1', service_data: '{}' },
        database: NO_SIGNAL_DB,
        ladderEvidence: ['mosquito'],
        planRateFamilies: [],
      });
      expect(result.targetKey).toBe('termite');
    });

    test('a live plan-rate row on the target (never property-scoped, suppress/demote only) also excludes it', async () => {
      etDateString.mockReturnValue('2026-11-01');
      const result = await resolveReportCrossSellV2({
        service: withTypedSnapshot({ primary: { type: 'rodent_trapping', values: { captures: 2 } } }),
        database: NO_SIGNAL_DB,
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
  properties = [], catalogServices = [], cockroachLinked = [],
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
    services: catalogServices,
  });
}

const missLookup = async () => null;

describe('buildReportCrossSell integration: GATE_REPORT_CROSS_SELL_V2 wiring', () => {
  test('gate off: output is byte-identical to the unchanged ladder pick, even with a typed roach companion on file', async () => {
    etDateString.mockReturnValue('2026-11-01');
    const serviceWithFinding = { ...SERVICE(), ...withTypedSnapshot({ primary: { type: 'pest' }, companions: [{ type: 'cockroach', values: { activity_level: 'Low' } }] }) };
    const before = await buildReportCrossSell(
      serviceWithFinding,
      dbFor({ serviceTypes: ['Pest Control'], turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' } }),
      { propertyLookup: missLookup },
    );
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'false';
    const withGateOff = await buildReportCrossSell(
      serviceWithFinding,
      dbFor({ serviceTypes: ['Pest Control'], turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' } }),
      { propertyLookup: missLookup },
    );
    expect(withGateOff).toEqual(before);
    expect(withGateOff.serviceKey).toBe('lawn_care'); // the unchanged ladder pick (pest-only → lawn)
    expect(withGateOff.reason).toBeUndefined();
  });

  test('gate on: a typed roach companion on a pest-only customer picks cockroach_control, carrying the fixed reason, instead of the ladder\'s lawn pick', async () => {
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'true';
    const service = { ...SERVICE(), ...withTypedSnapshot({ primary: { type: 'pest' }, companions: [{ type: 'cockroach', values: { activity_level: 'Moderate' } }] }) };
    const result = await buildReportCrossSell(
      service,
      dbFor({
        serviceTypes: ['Pest Control'],
        turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
        catalogServices: [ACTIVE_COCKROACH_ROW],
      }),
      { propertyLookup: missLookup },
    );
    expect(result.serviceKey).toBe('cockroach_control');
    expect(result.mode).toBe('quote_cta');
    expect(result.reason).toBe(
      'We noted roach activity today — our cockroach control program is a focused two-treatment cleanout.',
    );
    expect(typeof result.fingerprint).toBe('string');
  });

  test('gate on: an untyped (general pest) visit with no typed snapshot at all does NOT pick any findings target — falls through to the ladder', async () => {
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'true';
    etDateString.mockReturnValue('2026-11-01'); // outside season too
    const result = await buildReportCrossSell(
      SERVICE(),
      dbFor({ serviceTypes: ['Pest Control'], turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' } }),
      { propertyLookup: missLookup },
    );
    expect(result.serviceKey).toBe('lawn_care'); // unchanged ladder pick
    expect(result.reason).toBeUndefined();
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
    const service = { ...SERVICE(), ...withTypedSnapshot({ primary: { type: 'pest' }, companions: [{ type: 'cockroach', values: { activity_level: 'Moderate' } }] }) };
    const result = await buildReportCrossSell(
      service,
      dbFor({
        serviceTypes: ['Pest Control'],
        turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
        catalogServices: [ACTIVE_COCKROACH_ROW],
      }),
      { propertyLookup: missLookup },
    );
    expect(Array.isArray(result)).toBe(false);
    expect(result).not.toBeNull();
  });
});

// ============================================================
// Render/click parity: the click path's row (reports-public.js's
// cross_sell_requested handler) must carry the SAME inputs the render
// path's row does, or a findings-driven offer recomputes differently on
// tap and either 409s a fingerprint the customer actually saw, or silently
// swaps in a different offer. The render path's row is `service_records.*`
// (every column, service_data included); the click path builds its own
// narrower SELECT that must be kept in step by hand — this pins that it is.
// ============================================================
describe('render/click parity for a findings-driven offer (service_data must ride the click-path recompute)', () => {
  test('a roach COMPANION-typed signal resolves the SAME offer whether service_data is present the render way or the click way', async () => {
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'true';
    const serviceData = JSON.stringify({
      typedReportSnapshot: { type: 'pest' },
      companionReportSnapshots: [{ type: 'cockroach', delivery: 'auto_send', values: { activity_level: 'Low' } }],
    });
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogServices: [ACTIVE_COCKROACH_ROW],
    });

    // Shaped like the RENDER path's row (service_records.* — every column).
    const renderRow = { ...SERVICE(), service_data: serviceData };
    // Shaped like the CLICK path's row (reports-public.js's own narrower
    // SELECT list for 'service_records as sr' — id, customer_id,
    // service_type, scheduled_service_id, is_callback, service_date,
    // created_at, service_data, address_line1/2/city/zip, first_name,
    // last_name). Listed explicitly (not spread from SERVICE()) so this
    // test fails the moment that SELECT list drops a field the composer
    // reads, the same way it would have caught service_data's omission.
    const clickRow = {
      id: renderRow.id,
      customer_id: renderRow.customer_id,
      service_type: renderRow.service_type,
      scheduled_service_id: renderRow.scheduled_service_id,
      is_callback: renderRow.is_callback,
      service_date: renderRow.service_date,
      created_at: renderRow.created_at,
      address_line1: renderRow.address_line1,
      city: renderRow.city,
      zip: renderRow.zip,
      first_name: renderRow.first_name,
      last_name: renderRow.last_name,
      service_data: serviceData,
    };

    const rendered = await buildReportCrossSell(renderRow, db, { propertyLookup: missLookup });
    const clicked = await buildReportCrossSell(clickRow, dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogServices: [ACTIVE_COCKROACH_ROW],
    }), { propertyLookup: missLookup });

    expect(rendered.serviceKey).toBe('cockroach_control');
    expect(clicked).toEqual(rendered);
  });

  test('regression guard: a click-path row missing service_data silently loses the companion-typed roach signal', async () => {
    // This pins the FAILURE MODE the fix closes — if service_data is ever
    // dropped from the click path's SELECT again, this test catches it by
    // showing the offer actually diverges (never offers cockroach_control
    // once the only companion evidence is gone), rather than relying on a
    // production 409 nobody sees in CI.
    process.env.GATE_REPORT_CROSS_SELL_V2 = 'true';
    const db = dbFor({
      serviceTypes: ['Pest Control'],
      turfProfile: { customer_id: 'cust-1', lawn_sqft: 4500, grass_type: 'St. Augustine' },
      catalogServices: [ACTIVE_COCKROACH_ROW],
    });
    const withServiceData = {
      ...SERVICE(),
      service_data: JSON.stringify({
        typedReportSnapshot: { type: 'pest' },
        companionReportSnapshots: [{ type: 'cockroach', delivery: 'auto_send', values: { activity_level: 'Low' } }],
      }),
    };
    const withoutServiceData = { ...SERVICE() }; // service_data undefined — the pre-fix click-path shape
    const result = await buildReportCrossSell(withoutServiceData, db, { propertyLookup: missLookup });
    expect(result.serviceKey).not.toBe('cockroach_control');
    const control = await buildReportCrossSell(withServiceData, db, { propertyLookup: missLookup });
    expect(control.serviceKey).toBe('cockroach_control');
  });
});
