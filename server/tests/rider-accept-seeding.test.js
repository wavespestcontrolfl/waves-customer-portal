/**
 * Pest rides the lawn from accept (GATE_PEST_RIDES_LAWN_AT_ACCEPT): the pure
 * halves — the seeder's overrideDates, the host/rider pairing table, and the
 * rider context's fall-back decisions. The converter and extension behavior
 * against real Postgres lives in rider-accept-path-postgres.test.js.
 */
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const Seeder = require('../services/recurring-appointment-seeder');
const Preview = require('../services/rider-series-preview');
const { riderHostKind, riderPairingEnabled } = require('../services/rider-series-preview');
const RiderAccept = require('../services/rider-accept-seeding');
const { pestRidesLawnAtAcceptLive } = require('../config/feature-gates');

describe('seeder overrideDates', () => {
  const parent = {
    id: 'p1', customer_id: 'c1', scheduled_date: '2098-01-05', service_type: 'Quarterly Pest Control',
    recurring_pattern: 'quarterly',
  };

  test('supplied dates replace the pattern walk; count and every other field are unchanged', () => {
    const walked = Seeder.buildRecurringFollowUpRows(parent, { pattern: 'quarterly', visitsPerYear: 4, skipWeekends: true });
    const riding = Seeder.buildRecurringFollowUpRows(parent, {
      pattern: 'quarterly', visitsPerYear: 4, skipWeekends: true,
      overrideDates: ['2098-03-30', '2098-06-22', '2098-09-14'],
    });
    expect(riding.map((r) => r.scheduled_date)).toEqual(['2098-03-30', '2098-06-22', '2098-09-14']);
    expect(riding).toHaveLength(walked.length);
    const strip = ({ scheduled_date, ...rest }) => rest;
    expect(riding.map(strip)).toEqual(walked.map(strip));
    expect(riding.every((r) => r.recurring_pattern === 'quarterly' && r.service_type === 'Quarterly Pest Control')).toBe(true);
  });

  test('never exceeds the planned count, and skips a date the series already holds', () => {
    const rows = Seeder.buildRecurringFollowUpRows(parent, {
      pattern: 'quarterly', visitsPerYear: 4, existingDates: ['2098-03-30'],
      overrideDates: ['2098-01-05', '2098-03-30', '2098-06-22', '2098-09-14', '2098-12-07', '2099-03-01'],
    });
    expect(rows.map((r) => r.scheduled_date)).toEqual(['2098-06-22', '2098-09-14']);
  });

  test('without overrideDates the walk is untouched', () => {
    const rows = Seeder.buildRecurringFollowUpRows(parent, { pattern: 'quarterly', visitsPerYear: 4 });
    expect(rows).toHaveLength(3);
  });
});

describe('host / rider pairing table', () => {
  const lawn = (over) => ({ service_type: 'Lawn Care', ...over });

  test.each([
    [{ recurring_pattern: 'every_6_weeks' }, 'lawn_6wk'],
    [{ recurring_pattern: 'custom', recurring_interval_days: 42, service_key_snapshot: 'lawn_care_6week' }, 'lawn_6wk'],
    [{ recurring_pattern: 'custom', recurring_interval_days: 42, service_key_snapshot: 'lawn_care_monthly' }, 'lawn_6wk'],
    [{ recurring_pattern: 'custom', recurring_interval_days: null, service_key_snapshot: 'lawn_care_6week' }, 'lawn_6wk'],
    [{ recurring_pattern: 'monthly' }, 'lawn_monthly'],
    [{ recurring_pattern: 'custom', recurring_interval_days: null, service_key_snapshot: 'lawn_care_monthly' }, null],
    [{ recurring_pattern: 'custom', recurring_interval_days: 30 }, null],
    [{ recurring_pattern: 'bimonthly' }, null],
  ])('lawn host %j is %s', (row, kind) => {
    expect(riderHostKind(lawn(row))).toBe(kind);
  });

  test('only lawn series are hosts', () => {
    expect(riderHostKind({ service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly' })).toBeNull();
    expect(riderHostKind(null)).toBeNull();
  });

  test('quarterly pest, tree & shrub and termite bait ride a 6-week or monthly lawn; nothing else does', () => {
    const six = lawn({ recurring_pattern: 'every_6_weeks' });
    const monthly = lawn({ recurring_pattern: 'monthly' });
    for (const family of ['pest_control', 'tree_shrub', 'termite_bait']) {
      expect(riderPairingEnabled(six, family, 'quarterly')).toBe(true);
      expect(riderPairingEnabled(monthly, family, 'quarterly')).toBe(true);
      expect(riderPairingEnabled(six, family, 'bimonthly')).toBe(false);
    }
    for (const family of ['mosquito', 'palm_injection', 'rodent_bait', 'termite_bond', 'lawn_care']) {
      expect(riderPairingEnabled(six, family, 'quarterly')).toBe(false);
    }
    expect(riderPairingEnabled(lawn({ recurring_pattern: 'bimonthly' }), 'pest_control', 'quarterly')).toBe(false);
  });
});

describe('rider context fall-backs', () => {
  const originalGate = process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT;
  const { gates } = require('../config/feature-gates');
  const originalVisitGroups = gates.visitGroups;
  const VisitGroups = require('../services/visit-groups');
  let groupSpy;
  let grouped;
  beforeEach(() => {
    process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT = 'true';
    gates.visitGroups = true;
    // Canonical grouping: the rider joins the lawn's visit unless a test says otherwise.
    grouped = true;
    groupSpy = jest.spyOn(VisitGroups, 'maybeGroupRow').mockImplementation(async () => (grouped ? { id: 'v1' } : null));
  });
  afterEach(() => {
    if (originalGate === undefined) delete process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT;
    else process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT = originalGate;
    gates.visitGroups = originalVisitGroups;
    groupSpy.mockRestore();
  });

  test('visit grouping off: no context, so nothing rides (riding means one stop)', () => {
    gates.visitGroups = false;
    expect(RiderAccept.createContext()).toBeNull();
  });

  const seedOpts = { pattern: 'quarterly', visitsPerYear: 4, skipWeekends: true, weekendShift: 'forward' };
  const lawnPlan = { family: 'lawn_care', pattern: 'every_6_weeks', seedOpts: { ...seedOpts, pattern: 'every_6_weeks', visitsPerYear: 9 } };
  const pestPlan = { family: 'pest_control', pattern: 'quarterly', seedOpts };
  const parent = (over) => ({
    id: 'x', customer_id: 'c1', property_id: 'prop1', scheduled_date: '2098-01-05', service_type: 'Lawn Care', ...over,
  });

  test('no context while the gate is off, and nothing happens without one', async () => {
    delete process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT;
    expect(RiderAccept.createContext()).toBeNull();
    expect(await RiderAccept.beforeSeed(null, {}, parent({ id: 'pest' }), pestPlan)).toBeNull();
    expect(RiderAccept.noteLawn(null, parent({ id: 'lawn' }), lawnPlan)).toBe(false);
  });

  test('a rider with no lawn recorded in this accept seeds the normal walk', async () => {
    const ctx = RiderAccept.createContext();
    expect(await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'pest' }), pestPlan)).toBeNull();
  });

  const lawnDates = (n) => Array.from({ length: n }, (_, k) => {
    const d = new Date(Date.UTC(2098, 0, 5, 12));
    d.setUTCDate(d.getUTCDate() + 42 * (k + 1));
    return d.toISOString().slice(0, 10);
  });
  // After maybeGroupRow ran and succeeded, both first visits read visit v1.
  const conn = Object.assign((table) => ({
    columnInfo: async () => ({}),
    whereIn: () => ({
      select: async () => (groupSpy.mock.calls.length && grouped
        ? [{ id: 'pest', visit_id: 'v1' }, { id: 'lawn', visit_id: 'v1' }] : []),
    }),
    where: (w) => (typeof w === 'function'
      // persistedRiderOnHost: the saved series rows.
      ? { where: () => ({ select: async () => conn.persisted }) }
      : { update: async (u) => { conn.updates.push({ table, w, u }); return 1; } }),
  }), { updates: [], persisted: [], transaction: async (fn) => fn(conn) });
  // The lawn seeds first in this accept, with these follow-up dates.
  // Saved lawn rows, each in its own visit v<date>.
  const lawnRows = (n) => [
    { id: 'lawn', recurring_parent_id: null, scheduled_date: '2098-01-05', visit_id: 'v2098-01-05' },
    ...lawnDates(n).map((d, i) => ({ id: `l${i}`, recurring_parent_id: 'lawn', scheduled_date: d, visit_id: `v${d}` })),
  ];
  async function seedLawn(ctx, n = 8, over = {}) {
    const lawn = parent({ id: 'lawn', ...over });
    expect(await RiderAccept.beforeSeed(ctx, conn, lawn, lawnPlan)).toBeNull();
    conn.persisted = lawnRows(n);
    await RiderAccept.afterSeed(ctx, conn, lawn, null, { insertedRows: [] });
  }
  const pest = (over) => parent({ id: 'pest', service_type: 'Quarterly Pest Control', ...over });
  let readerSpy;
  beforeEach(() => {
    conn.updates = []; conn.persisted = [];
    // The shared live plan-row reader serves the saved rows, applying the real
    // plan-row classifier (boosters etc. drop out).
    const { isPlanSeriesRow } = require('../services/recurring-series-cancel-reseed');
    readerSpy = jest.spyOn(Preview, 'livePlanSeriesRows')
      .mockImplementation(async (_c, ids) => conn.persisted.filter((r) => (ids.includes(r.id) || ids.includes(r.recurring_parent_id))
        && isPlanSeriesRow({ is_recurring: r.is_recurring ?? true, ...r })));
  });
  afterEach(() => { readerSpy.mockRestore(); });

  test.each([
    ['a different first date', { scheduled_date: '2098-01-06' }],
    ['a different property', { property_id: 'prop2' }],
    ['a different customer', { customer_id: 'c2' }],
  ])('%s falls back to the normal walk', async (_, over) => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    expect(await RiderAccept.beforeSeed(ctx, conn, pest(over), pestPlan)).toBeNull();
  });

  test('a bi-monthly pest or a mosquito line is not a rider of the recorded lawn', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    expect(await RiderAccept.beforeSeed(ctx, conn, parent({ id: 'b' }), { ...pestPlan, pattern: 'bimonthly' })).toBeNull();
    expect(await RiderAccept.beforeSeed(ctx, conn, parent({ id: 'm' }), { ...pestPlan, family: 'mosquito' })).toBeNull();
  });

  test('a failure while planning fails open to the normal walk (never throws into the accept)', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    groupSpy.mockRejectedValue(new Error('db down'));
    expect(await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan)).toBeNull();
  });

  test('a seeded lawn at the same stop yields the 84-day rider dates (three follow-ups) and the link', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    expect(rider.hostParentId).toBe('lawn');
    expect(rider.overrideDates).toEqual(['2098-03-30', '2098-06-22', '2098-09-14']);
    conn.persisted = [
      ...lawnRows(8),
      ...rider.overrideDates.map((d, i) => ({ id: `p${i}`, recurring_parent_id: 'pest', scheduled_date: d, visit_id: `v${d}` })),
    ];
    await RiderAccept.afterSeed(ctx, conn, pest(), rider, { insertedRows: [] });
    expect(conn.updates).toEqual([{ table: 'scheduled_services', w: { id: 'pest' }, u: { rides_parent_id: 'lawn' } }]);
  });

  // seedWithRide: overrides seeded in a savepoint, kept only when verified.
  const seedCalls = [];
  const seed = async (_c, overrideDates) => { seedCalls.push(overrideDates); return { insertedRows: [] }; };

  test('a rider follow-up on a lawn date but NOT in the lawn visit (its grouping failed): rolled back to the normal walk, not linked', async () => {
    seedCalls.length = 0;
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    conn.persisted = [
      ...lawnRows(8),
      ...rider.overrideDates.map((d, i) => ({ id: `p${i}`, recurring_parent_id: 'pest', scheduled_date: d, visit_id: i === 1 ? null : `v${d}` })),
    ];
    const ride = await RiderAccept.seedWithRide(conn, pest(), rider, seed);
    expect(ride.rides).toBe(false);
    expect(seedCalls).toEqual([rider.overrideDates, null]); // tried riding, then the normal walk
    await RiderAccept.afterSeed(ctx, conn, pest(), null, ride.seedResult);
    expect(conn.updates).toEqual([]);
  });

  test('every saved follow-up in its lawn visit: the ride is kept and linked', async () => {
    seedCalls.length = 0;
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    conn.persisted = [
      ...lawnRows(8),
      ...rider.overrideDates.map((d, i) => ({ id: `p${i}`, recurring_parent_id: 'pest', scheduled_date: d, visit_id: `v${d}` })),
    ];
    const ride = await RiderAccept.seedWithRide(conn, pest(), rider, seed);
    expect(ride.rides).toBe(true);
    expect(seedCalls).toEqual([rider.overrideDates]);
    await RiderAccept.afterSeed(ctx, conn, pest(), rider, ride.seedResult);
    expect(conn.updates).toEqual([{ table: 'scheduled_services', w: { id: 'pest' }, u: { rides_parent_id: 'lawn' } }]);
  });

  test('a ride missing one planned follow-up (a booster took its slot) is rolled back, not kept', async () => {
    seedCalls.length = 0;
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    conn.persisted = [
      ...lawnRows(8),
      // Only two of the three planned follow-ups were saved; both are grouped.
      ...rider.overrideDates.slice(0, 2).map((d, i) => ({ id: `p${i}`, recurring_parent_id: 'pest', scheduled_date: d, visit_id: `v${d}` })),
      { id: 'b0', recurring_parent_id: 'pest', is_recurring: false, scheduled_date: rider.overrideDates[2], visit_id: null },
    ];
    const ride = await RiderAccept.seedWithRide(conn, pest(), rider, seed);
    expect(ride.rides).toBe(false);
    expect(seedCalls).toEqual([rider.overrideDates, null]);
  });

  test('no rider: the plain seed runs once, no savepoint ride', async () => {
    seedCalls.length = 0;
    const ride = await RiderAccept.seedWithRide(conn, pest(), null, seed);
    expect(ride.rides).toBe(false);
    expect(seedCalls).toEqual([null]);
  });

  test('a resumed lawn seed that inserted nothing still hosts from its SAVED follow-ups', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx); // insertedRows: [] — the saved series supplies the dates
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    expect(rider.overrideDates).toEqual(['2098-03-30', '2098-06-22', '2098-09-14']);
  });

  test('a resumed accept with a saved rider follow-up OFF the lawn plan gets no overrides (no bunched visits)', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    conn.persisted = [...lawnRows(8), { id: 'p0', recurring_parent_id: 'pest', scheduled_date: '2098-04-06', visit_id: null }];
    expect(await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan)).toBeNull();
  });

  test('a booster on the rider series is not a cadence follow-up: it does not block the ride', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    conn.persisted = [...lawnRows(8), {
      id: 'b0', recurring_parent_id: 'pest', is_recurring: false, scheduled_date: '2098-04-06', visit_id: null,
    }];
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    expect(rider.overrideDates).toEqual(['2098-03-30', '2098-06-22', '2098-09-14']);
  });

  test('a resumed accept whose saved rider follow-ups are ON the lawn plan keeps riding', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    conn.persisted = [...lawnRows(8), { id: 'p0', recurring_parent_id: 'pest', scheduled_date: '2098-03-30', visit_id: 'v2098-03-30' }];
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    expect(rider.overrideDates).toEqual(['2098-03-30', '2098-06-22', '2098-09-14']);
  });

  test('a retried accept whose saved rider dates are NOT lawn dates: rolled back to the normal walk, not linked', async () => {
    seedCalls.length = 0;
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    const rider = await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan);
    // The seeder kept the series' existing quarterly-walk dates (inserted none).
    conn.persisted = [
      ...lawnRows(8),
      ...['2098-04-06', '2098-07-06', '2098-10-05'].map((d, i) => ({ id: `p${i}`, recurring_parent_id: 'pest', scheduled_date: d, visit_id: null })),
    ];
    const ride = await RiderAccept.seedWithRide(conn, pest(), rider, seed);
    expect(ride.rides).toBe(false);
    await RiderAccept.afterSeed(ctx, conn, pest(), null, ride.seedResult);
    expect(conn.updates).toEqual([]);
  });

  test('a lawn that has not seeded yet in this accept hosts nothing', async () => {
    const ctx = RiderAccept.createContext();
    expect(RiderAccept.noteLawn(ctx, parent({ id: 'lawn' }), lawnPlan)).toBe(true);
    expect(await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan)).toBeNull();
  });

  test('a rider whose first visit does NOT end up in the lawn\'s visit is not a ride (apply refused)', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    grouped = false;
    expect(await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan)).toBeNull();
  });

  test('a lawn row with a stale non-lawn label is still a host when its resolved family is lawn', () => {
    const ctx = RiderAccept.createContext();
    expect(RiderAccept.noteLawn(ctx, parent({ id: 'lawn', service_type: 'General Service' }), lawnPlan)).toBe(true);
    expect(ctx.lawn.parent.id).toBe('lawn');
  });

  test('a lawn whose seeding failed is forgotten: later riders seed their own walk', async () => {
    const ctx = RiderAccept.createContext();
    await seedLawn(ctx);
    RiderAccept.forgetLawn(ctx, parent({ id: 'lawn' }));
    expect(ctx.lawn).toBeNull();
    expect(await RiderAccept.beforeSeed(ctx, conn, pest(), pestPlan)).toBeNull();
  });
});

describe('gate reader', () => {
  const original = process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT;
  afterEach(() => {
    if (original === undefined) delete process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT;
    else process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT = original;
  });

  test('dark by default; only the exact string true opens it', () => {
    delete process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT;
    expect(pestRidesLawnAtAcceptLive()).toBe(false);
    for (const v of ['1', 'on', 'TRUE', 'false', '']) {
      process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT = v;
      expect(pestRidesLawnAtAcceptLive()).toBe(false);
    }
    process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT = 'true';
    expect(pestRidesLawnAtAcceptLive()).toBe(true);
  });
});
