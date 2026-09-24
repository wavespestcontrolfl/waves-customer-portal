/**
 * Audit repro r2-reschedule-move-engine-reminders-2: the ongoing-series
 * auto-extend (runRecurringSeriesMaintenance) anchors on the latest live
 * row's RAW scheduled_date, so a "this visit only" move of the sole
 * upcoming visit (date_exception=true, date_exception_cadence_date = the
 * cadence slot it left) is projected forward as if it were the cadence,
 * and the series drifts by the exception delta.
 *
 * Runs only against a private waves_audit_* Postgres clone:
 *   DATABASE_URL=postgres://wavespestcontrol@localhost:5432/waves_audit_<slug>
 */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  resolveCommittedVisitTime: jest.fn(async (id, { date, windowStart } = {}) => (date ? { appointmentTime: `${date}T${windowStart || '08:00'}`, windowless: !windowStart } : null)),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));

const knex = require('knex');
const { randomUUID } = require('crypto');

const connection = process.env.DATABASE_URL;
const postgres = connection && /\/waves_audit_/.test(connection) ? describe : describe.skip;
let mockPg;
jest.setTimeout(90000);

const { etDateString, addETDays, etParts } = require('../utils/datetime-et');

const noon = (ymd) => new Date(`${ymd}T12:00:00-04:00`);
const plusDays = (ymd, n) => etDateString(addETDays(noon(ymd), n));
const dow = (ymd) => etParts(noon(ymd)).dayOfWeek;
// First date >= today+minOut that falls on `weekday` (0=Sun).
function nextWeekday(minOut, weekday) {
  let d = plusDays(etDateString(), minOut);
  while (dow(d) !== weekday) d = plusDays(d, 1);
  return d;
}
function ymdMonth(ymd) { const p = etParts(noon(ymd)); return p.year * 12 + p.month; }

async function seedSeries({ pattern, completedDate, cadenceDate, movedDate }) {
  const f = { customerId: randomUUID(), parentId: randomUUID(), childId: randomUUID(), catalogId: randomUUID() };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Cadence', phone: '+12025550177',
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
  await mockPg('services').insert({ id: f.catalogId, name: 'Fixture General Pest Control', service_key: `fixture_${f.catalogId}`,
    is_active: true });
  const base = { customer_id: f.customerId, service_id: f.catalogId, service_type: 'Fixture General Pest Control',
    window_start: '09:00', window_end: '10:00', estimated_price: 120, estimated_duration_minutes: 60,
    is_recurring: true, recurring_ongoing: true, recurring_pattern: pattern, skip_weekends: false };
  await mockPg('scheduled_services').insert({ ...base, id: f.parentId, scheduled_date: completedDate, status: 'completed' });
  // The sole upcoming cadence visit, moved "this visit only" exactly as
  // rebooker.dateExceptionStamp stamps it (rebooker.js:323-334).
  await mockPg('scheduled_services').insert({ ...base, id: f.childId, recurring_parent_id: f.parentId,
    scheduled_date: movedDate, status: 'confirmed',
    date_exception: true, date_exception_source: 'customer', date_exception_at: new Date(),
    date_exception_cadence_date: cadenceDate });
  return f;
}

async function cleanup(f) {
  const ids = (await mockPg('scheduled_services').where({ customer_id: f.customerId }).select('id')).map((r) => r.id);
  await mockPg('appointment_reminders').whereIn('scheduled_service_id', ids).del().catch(() => {});
  await mockPg('scheduled_service_addons').whereIn('scheduled_service_id', ids).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del();
  await mockPg('services').where({ id: f.catalogId }).del();
  await mockPg('customers').where({ id: f.customerId }).del();
}

async function extendedRows(f) {
  return mockPg('scheduled_services')
    .where({ recurring_parent_id: f.parentId }).whereNot('id', f.childId)
    .select('id', 'status', mockPg.raw("to_char(scheduled_date, 'YYYY-MM-DD') as d"))
    .orderBy('scheduled_date');
}

postgres('r2-reschedule-move-engine-reminders-2: auto-extend anchors on a this-visit-only exception date', () => {
  beforeAll(async () => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('CONTROL: no exception -> the next visit lands one cadence past the upcoming visit', async () => {
    const cadenceDate = nextWeekday(7, 1); // Monday
    const f = await seedSeries({ pattern: 'biweekly', completedDate: plusDays(cadenceDate, -14), cadenceDate, movedDate: cadenceDate });
    await mockPg('scheduled_services').where({ id: f.childId }).update({ date_exception: false, date_exception_source: null, date_exception_at: null, date_exception_cadence_date: null });
    try {
      const { runRecurringSeriesMaintenance } = require('../routes/admin-schedule');
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first();
      await runRecurringSeriesMaintenance(mockPg, parent);
      const rows = await extendedRows(f);
      expect(rows.map((r) => r.d)).toEqual([plusDays(cadenceDate, 14)]);
    } finally { await cleanup(f); }
  });

  test('biweekly Monday series: sole upcoming visit moved Mon->Wed "this visit only" must still extend on Monday', async () => {
    const cadenceDate = nextWeekday(7, 1); // Monday
    const movedDate = plusDays(cadenceDate, 2); // Wednesday, this visit only
    const f = await seedSeries({ pattern: 'biweekly', completedDate: plusDays(cadenceDate, -14), cadenceDate, movedDate });
    try {
      const { runRecurringSeriesMaintenance } = require('../routes/admin-schedule');
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first();
      await runRecurringSeriesMaintenance(mockPg, parent);
      const rows = await extendedRows(f);
      expect(rows).toHaveLength(1);
      // Expected: cadence position + 14 days (Monday). Bug: moved date + 14 (Wednesday).
      expect(rows[0].d).toBe(plusDays(cadenceDate, 14));
      expect(dow(rows[0].d)).toBe(1);
    } finally { await cleanup(f); }
  });

  test('quarterly series: sole upcoming visit pushed into the next month "this visit only" must still extend 3 months after the cadence month', async () => {
    const cadenceDate = nextWeekday(7, 2); // a Tuesday
    const cp = etParts(noon(cadenceDate));
    // Exactly one calendar month after the cadence slot (day clamped to 28
    // so this never skips a short month) — a fixed +N-day offset can cross
    // TWO month boundaries when cadenceDate falls late in a long month
    // (e.g. Jan 26 + 35 days lands in March, not February).
    const movedDate = etDateString(new Date(Date.UTC(cp.year, cp.month, Math.min(cp.day, 28), 16)));
    expect(ymdMonth(movedDate)).toBe(ymdMonth(cadenceDate) + 1);
    // Completed 3 months before the cadence slot.
    const completedDate = etDateString(new Date(Date.UTC(cp.year, cp.month - 1 - 3, Math.min(cp.day, 28), 16)));
    const f = await seedSeries({ pattern: 'quarterly', completedDate, cadenceDate, movedDate });
    try {
      const { runRecurringSeriesMaintenance } = require('../routes/admin-schedule');
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first();
      await runRecurringSeriesMaintenance(mockPg, parent);
      const rows = await extendedRows(f);
      expect(rows).toHaveLength(1);
      // Expected: cadence month + 3. Bug: moved month + 3 (= cadence month + 4).
      expect(ymdMonth(rows[0].d)).toBe(ymdMonth(cadenceDate) + 3);
    } finally { await cleanup(f); }
  });
});
