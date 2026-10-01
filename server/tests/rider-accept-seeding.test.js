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
  beforeEach(() => { process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT = 'true'; });
  afterEach(() => {
    if (originalGate === undefined) delete process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT;
    else process.env.GATE_PEST_RIDES_LAWN_AT_ACCEPT = originalGate;
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

  test.each([
    ['a different first date', { scheduled_date: '2098-01-06' }],
    ['a different property', { property_id: 'prop2' }],
    ['a different customer', { customer_id: 'c2' }],
  ])('%s falls back to the normal walk', async (_, over) => {
    const ctx = RiderAccept.createContext();
    expect(await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'lawn' }), lawnPlan)).toBeNull();
    expect(ctx.lawn.parent.id).toBe('lawn');
    expect(await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'pest', service_type: 'Quarterly Pest Control', ...over }), pestPlan)).toBeNull();
  });

  test('a bi-monthly pest or a mosquito line is not a rider of the recorded lawn', async () => {
    const ctx = RiderAccept.createContext();
    await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'lawn' }), lawnPlan);
    expect(await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'b' }), { ...pestPlan, pattern: 'bimonthly' })).toBeNull();
    expect(await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'm' }), { ...pestPlan, family: 'mosquito' })).toBeNull();
  });

  test('a failure while planning fails open to the normal walk (never throws into the accept)', async () => {
    const ctx = RiderAccept.createContext();
    await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'lawn' }), lawnPlan);
    const spy = jest.spyOn(Seeder, 'planFollowUpSeedDates').mockRejectedValue(new Error('db down'));
    try {
      expect(await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'pest', service_type: 'Quarterly Pest Control' }), pestPlan)).toBeNull();
    } finally { spy.mockRestore(); }
  });

  test('a lawn that starts the same day at the same stop yields the 84-day rider dates, three follow-ups', async () => {
    const ctx = RiderAccept.createContext();
    await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'lawn' }), lawnPlan);
    const lawnFollowUps = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
      const d = new Date(Date.UTC(2098, 0, 5, 12));
      d.setUTCDate(d.getUTCDate() + 42 * i);
      return d.toISOString().slice(0, 10);
    });
    const spy = jest.spyOn(Seeder, 'planFollowUpSeedDates').mockResolvedValue(lawnFollowUps);
    try {
      const rider = await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'pest', service_type: 'Quarterly Pest Control' }), pestPlan);
      expect(rider.hostParentId).toBe('lawn');
      expect(rider.overrideDates).toEqual(['2098-03-30', '2098-06-22', '2098-09-14']);
    } finally { spy.mockRestore(); }
  });

  const lawnDates = (n) => Array.from({ length: n }, (_, k) => {
    const d = new Date(Date.UTC(2098, 0, 5, 12));
    d.setUTCDate(d.getUTCDate() + 42 * (k + 1));
    return d.toISOString().slice(0, 10);
  });

  test.each([
    ['no lawn follow-ups at all', 0],
    ['too few lawn follow-ups (the rule would fall back to its own +84 dates)', 3],
  ])('%s: not a ride, the normal walk seeds and nothing links', async (_, n) => {
    const ctx = RiderAccept.createContext();
    await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'lawn' }), lawnPlan);
    const spy = jest.spyOn(Seeder, 'planFollowUpSeedDates').mockResolvedValue(lawnDates(n));
    try {
      expect(await RiderAccept.beforeSeed(ctx, {}, parent({ id: 'pest', service_type: 'Quarterly Pest Control' }), pestPlan)).toBeNull();
    } finally { spy.mockRestore(); }
  });

  test('a rider planned on PROJECTED lawn dates is unlinked when the lawn seeds different dates', async () => {
    const updates = [];
    const conn = (table) => ({
      where: (w) => ({ update: async (u) => { updates.push({ table, w, u }); return 1; } }),
    });
    const ctx = RiderAccept.createContext();
    RiderAccept.noteLawn(ctx, parent({ id: 'lawn' }), lawnPlan);
    const spy = jest.spyOn(Seeder, 'planFollowUpSeedDates').mockResolvedValue(lawnDates(8));
    let rider;
    try {
      rider = await RiderAccept.beforeSeed(ctx, conn, parent({ id: 'pest', service_type: 'Quarterly Pest Control' }), pestPlan);
    } finally { spy.mockRestore(); }
    expect(rider.projected).toBe(true);
    await RiderAccept.afterSeed(ctx, conn, parent({ id: 'pest' }), rider, { insertedRows: [] });
    expect(updates).toEqual([{ table: 'scheduled_services', w: { id: 'pest' }, u: { rides_parent_id: 'lawn' } }]);
    // The lawn then seeds nothing (e.g. its series was kept elsewhere).
    await RiderAccept.afterSeed(ctx, conn, parent({ id: 'lawn' }), null, { insertedRows: [] });
    expect(updates[1]).toEqual({ table: 'scheduled_services', w: { id: 'pest' }, u: { rides_parent_id: null } });
  });

  test('a rider planned on projected dates stays linked when the lawn seeds exactly those dates', async () => {
    const updates = [];
    const conn = (table) => ({ where: (w) => ({ update: async (u) => { updates.push({ table, w, u }); return 1; } }) });
    const ctx = RiderAccept.createContext();
    RiderAccept.noteLawn(ctx, parent({ id: 'lawn' }), lawnPlan);
    const spy = jest.spyOn(Seeder, 'planFollowUpSeedDates').mockResolvedValue(lawnDates(8));
    let rider;
    try {
      rider = await RiderAccept.beforeSeed(ctx, conn, parent({ id: 'pest', service_type: 'Quarterly Pest Control' }), pestPlan);
    } finally { spy.mockRestore(); }
    await RiderAccept.afterSeed(ctx, conn, parent({ id: 'pest' }), rider, { insertedRows: [] });
    await RiderAccept.afterSeed(ctx, conn, parent({ id: 'lawn' }), null, {
      insertedRows: lawnDates(8).map((d) => ({ scheduled_date: d })),
    });
    expect(updates).toHaveLength(1);
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
