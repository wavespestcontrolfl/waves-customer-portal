jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const logger = require('../services/logger');
const {
  coverageSeriesSlot, seriesSlotAbsentDays, seriesSlotPatch, seriesSlotHandoff,
} = require('../services/annual-prepay-series-slot');

// A knex-shaped conn: scheduled_services resolves to `visits`, technicians to `.first()`.
function makeConn({ visits = [], tech = undefined, absences = [], isTransaction = false, throwOn = null } = {}) {
  const calls = { forShare: 0, tables: [], whereNotIn: null };
  const conn = jest.fn((table) => {
    calls.tables.push(table);
    if (throwOn === table) throw new Error(`boom ${table}`);
    const q = {};
    ['where', 'whereNotNull', 'whereBetween', 'whereIn', 'whereNull'].forEach((m) => { q[m] = jest.fn(() => q); });
    q.whereNotIn = jest.fn((col, list) => { calls.whereNotIn = [col, list]; return q; });
    q.forShare = jest.fn(() => { calls.forShare += 1; return q; });
    q.first = jest.fn(async () => tech);
    q.select = jest.fn(async () => (table === 'technician_absences' ? absences : visits));
    return q;
  });
  conn.isTransaction = isTransaction;
  return { conn, calls };
}

const normalize = (v) => String(v || '').trim().replace(/\s+/g, ' ') || null;
const activeTech = { id: 'tech-1', employment_status: 'active', field_dispatchable: true };
const base = { customerId: 'cust-1', coverageServiceType: 'Monthly Pest Control', propertyId: null, today: '2026-11-01', normalize };
const visit = (over) => ({
  id: 'v1', service_type: 'Monthly Pest Control', property_id: null, scheduled_date: '2026-10-20',
  technician_id: 'tech-1', window_start: '09:00:00', ...over,
});

describe('coverageSeriesSlot', () => {
  beforeEach(() => jest.clearAllMocks());

  test('copies the technician and time of the latest past visit of the same service', async () => {
    const { conn } = makeConn({
      visits: [
        visit({ id: 'old', scheduled_date: '2026-09-20', window_start: '08:00' }),
        visit({ id: 'new', scheduled_date: '2026-10-20', window_start: '10:30:00' }),
        visit({ id: 'future', scheduled_date: '2026-12-20', window_start: '13:00' }),
        visit({ id: 'other', service_type: 'Lawn Care', scheduled_date: '2026-10-25', window_start: '15:00' }),
      ],
      tech: activeTech,
    });
    await expect(coverageSeriesSlot(conn, base)).resolves.toEqual({ technicianId: 'tech-1', windowStart: '10:30' });
  });

  test('with no past visit it takes the earliest future one', async () => {
    const { conn } = makeConn({
      visits: [visit({ id: 'f2', scheduled_date: '2026-12-20', window_start: '13:00' }), visit({ id: 'f1', scheduled_date: '2026-11-20', window_start: '11:00' })],
      tech: activeTech,
    });
    await expect(coverageSeriesSlot(conn, base)).resolves.toEqual({ technicianId: 'tech-1', windowStart: '11:00' });
  });

  test('a visit dated today counts as past', async () => {
    const { conn } = makeConn({
      visits: [visit({ id: 'today', scheduled_date: new Date('2026-11-01T00:00:00Z'), window_start: '07:00' }), visit({ id: 'f', scheduled_date: '2026-11-05', window_start: '12:00' })],
      tech: activeTech,
    });
    await expect(coverageSeriesSlot(conn, base)).resolves.toEqual({ technicianId: 'tech-1', windowStart: '07:00' });
  });

  test('excludes dead statuses in the query and other-property visits in the filter', async () => {
    const { conn, calls } = makeConn({
      visits: [visit({ id: 'p2', property_id: 'prop-2', window_start: '08:00' }), visit({ id: 'p1', property_id: 'prop-1', scheduled_date: '2026-10-01', window_start: '14:00' })],
      tech: activeTech,
    });
    await expect(coverageSeriesSlot(conn, { ...base, propertyId: 'prop-1' })).resolves.toEqual({ technicianId: 'tech-1', windowStart: '14:00' });
    expect(calls.whereNotIn).toEqual(['status', ['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled']]);
  });

  test('a visit with no property matches a known property', async () => {
    const { conn } = makeConn({ visits: [visit({ property_id: null })], tech: activeTech });
    await expect(coverageSeriesSlot(conn, { ...base, propertyId: 'prop-1' })).resolves.toMatchObject({ technicianId: 'tech-1' });
  });

  test('no source visit gives null', async () => {
    const { conn } = makeConn({ visits: [visit({ service_type: 'Lawn Care' })], tech: activeTech });
    await expect(coverageSeriesSlot(conn, base)).resolves.toBeNull();
  });

  test('a technician who is not assignable is not copied; the time still is', async () => {
    const { conn } = makeConn({ visits: [visit()], tech: { ...activeTech, employment_status: 'inactive' } });
    await expect(coverageSeriesSlot(conn, base)).resolves.toEqual({ technicianId: null, windowStart: '09:00' });
    const missing = makeConn({ visits: [visit()], tech: undefined });
    await expect(coverageSeriesSlot(missing.conn, base)).resolves.toEqual({ technicianId: null, windowStart: '09:00' });
  });

  test('reads the technician FOR SHARE inside a transaction only', async () => {
    const trx = makeConn({ visits: [visit()], tech: activeTech, isTransaction: true });
    await coverageSeriesSlot(trx.conn, base);
    expect(trx.calls.forShare).toBe(1);
    const plain = makeConn({ visits: [visit()], tech: activeTech });
    await coverageSeriesSlot(plain.conn, base);
    expect(plain.calls.forShare).toBe(0);
  });

  test('never throws: a failed read warns and gives null', async () => {
    const { conn } = makeConn({ throwOn: 'scheduled_services' });
    await expect(coverageSeriesSlot(conn, base)).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom scheduled_services'));
  });
});

describe('seriesSlotAbsentDays', () => {
  test('reads the technician absences over the seeded date range', async () => {
    const { conn } = makeConn({ absences: [{ technician_id: 'tech-1', absence_date: '2026-12-15' }] });
    const days = await seriesSlotAbsentDays(conn, { technicianId: 'tech-1' }, ['2027-01-15', '2026-11-15', '2026-12-15']);
    expect(days.has('tech-1:2026-12-15')).toBe(true);
  });

  test('no technician means no read', async () => {
    const { conn, calls } = makeConn();
    expect((await seriesSlotAbsentDays(conn, { technicianId: null }, ['2026-12-15'])).size).toBe(0);
    expect(calls.tables).toEqual([]);
  });

  test('a failed read leaves the seeds unassigned', async () => {
    const { conn } = makeConn({ throwOn: 'technician_absences' });
    const days = await seriesSlotAbsentDays(conn, { technicianId: 'tech-1' }, ['2026-12-15']);
    expect(days.has('tech-1:2026-12-15')).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('seriesSlotPatch', () => {
  const slot = { technicianId: 'tech-1', windowStart: '09:00' };
  afterEach(() => { delete process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF; });

  test('hand-off gate off: technician only, no time', () => {
    expect(seriesSlotPatch(slot, { scheduledDate: '2026-12-15' })).toEqual({ technicianId: 'tech-1', windowStart: null });
  });

  test('hand-off gate on: technician and time', () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    expect(seriesSlotPatch(slot, { scheduledDate: '2026-12-15' })).toEqual({ technicianId: 'tech-1', windowStart: '09:00' });
  });

  test('a day the technician is out drops the technician and keeps the time', () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    const patch = seriesSlotPatch(slot, { scheduledDate: '2026-12-15', absentDays: new Set(['tech-1:2026-12-15']) });
    expect(patch).toEqual({ technicianId: null, windowStart: '09:00' });
  });

  test('a timed seed never takes the time', () => {
    process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
    expect(seriesSlotPatch(slot, { scheduledDate: '2026-12-15', timed: true })).toEqual({ technicianId: 'tech-1', windowStart: null });
  });
});

describe('seriesSlotHandoff', () => {
  const PlanTakenHour = require('../services/scheduling/plan-taken-hour');
  afterEach(() => jest.restoreAllMocks());

  test('a row without a time is never probed', async () => {
    const spy = jest.spyOn(PlanTakenHour, 'takenHourHandoff');
    await expect(seriesSlotHandoff({}, { scheduled_date: '2026-12-15', window_start: null })).resolves.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  test('a taken hour returns the windowless fields with the due date', async () => {
    jest.spyOn(PlanTakenHour, 'takenHourHandoff').mockResolvedValue(true);
    const fields = await seriesSlotHandoff({}, { scheduled_date: '2026-12-15', window_start: '09:00' }, { cols: { window_start: {}, window_end: {}, recurring_dispatch_due_date: {} } });
    expect(fields).toEqual({ window_start: null, window_end: null, recurring_dispatch_due_date: '2026-12-15' });
  });

  test('a free hour returns null', async () => {
    jest.spyOn(PlanTakenHour, 'takenHourHandoff').mockResolvedValueOnce(false);
    await expect(seriesSlotHandoff({}, { scheduled_date: '2026-12-15', window_start: '09:00' })).resolves.toBeNull();
  });

  test('a failed probe counts as a taken hour: handed off from 4 days out, the copied hour kept nearer', async () => {
    const now = new Date('2026-11-01T15:00:00Z');
    const cols = { window_start: {}, window_end: {}, recurring_dispatch_due_date: {} };
    jest.spyOn(PlanTakenHour, 'takenHourHandoff').mockRejectedValue(new Error('probe boom'));
    await expect(seriesSlotHandoff({}, { scheduled_date: '2026-12-15', window_start: '09:00' }, { cols, now }))
      .resolves.toEqual({ window_start: null, window_end: null, recurring_dispatch_due_date: '2026-12-15' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('seeding without a time for the night tool'));
    await expect(seriesSlotHandoff({}, { scheduled_date: '2026-11-03', window_start: '09:00' }, { cols, now })).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('keeping the copied time'));
  });
});
