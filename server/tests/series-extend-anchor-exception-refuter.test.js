/**
 * AUDIT REPRO r2-reschedule-move-engine-reminders-2 — the ongoing-series
 * auto-extend (runRecurringSeriesMaintenance -> latestLiveSeriesVisit ->
 * seriesExtendAnchor -> nextRecurringDate) anchors on the tail visit's RAW
 * scheduled_date, ignoring date_exception_cadence_date. After a "this visit
 * only" move of the sole upcoming visit, the next seeded visit inherits the
 * exception's delta (day-gap cadences) or its month (month cadences).
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Asserts the
 * EXPECTED behaviour (the extension continues from the series' cadence
 * position, as rebooker.readSiblings / recurring-schedule-audit define it),
 * so it FAILS on current code if the bug is real.
 *
 * Dates are computed relative to "today" (not hardcoded literals) so the
 * suite never expires as the calendar advances.
 */
const { randomUUID } = require('crypto');
const mockRegister = jest.fn(async () => {});
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: mockRegister, alertRegistrationFailure: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.setTimeout(60000);

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

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('ongoing auto-extend after a this-visit-only move of the tail (real PG)', () => {
  let db;
  let maintain;
  let service;
  const customerId = randomUUID();

  beforeAll(async () => {
    db = require('../models/db');
    maintain = require('../routes/admin-schedule').runRecurringSeriesMaintenance;
    service = await db('services').where({ service_key: 'pest_general_quarterly', is_active: true }).first();
    if (!service) throw new Error('Migrated general pest catalog is required.');
    await db('customers').insert({ id: customerId, first_name: 'Audit', last_name: 'ExtendAnchor', phone: '+19415550177',
      email: `audit-extend-${customerId}@example.invalid`, active: true, pipeline_stage: 'active_customer' });
  });

  afterAll(async () => {
    if (!db) return;
    await db('scheduled_services').where({ customer_id: customerId }).del();
    await db('customers').where({ id: customerId }).del();
    await db.destroy();
  });

  async function seedSeries({ pattern, parentDate, tailCadenceDate, tailMovedDate }) {
    const parentId = randomUUID();
    const tailId = randomUUID();
    const base = {
      customer_id: customerId, service_id: service.id, service_type: service.name,
      window_start: '09:00:00', window_end: '10:00:00', is_recurring: true, recurring_ongoing: true,
      recurring_pattern: pattern, estimated_price: 99, estimated_duration_minutes: 60,
    };
    await db('scheduled_services').insert({ ...base, id: parentId, scheduled_date: parentDate, status: 'completed' });
    // The sole upcoming visit, moved "this visit only" by the customer web
    // reschedule / rain-out single fallback / dispatch quick move — the
    // stamp rebooker.dateExceptionStamp writes (rebooker.js:323-334).
    await db('scheduled_services').insert({
      ...base, id: tailId, recurring_parent_id: parentId, scheduled_date: tailMovedDate, status: 'confirmed',
      date_exception: true, date_exception_source: 'customer_self_serve', date_exception_at: new Date(),
      date_exception_cadence_date: tailCadenceDate,
    });
    return { parentId, tailId };
  }

  async function seededChild(parentId, exclude) {
    const rows = await db('scheduled_services').where({ recurring_parent_id: parentId }).whereNotIn('id', exclude)
      .select(db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date"), 'date_exception');
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  test('quarterly: tail cadence slot moved once (this visit only) into the next month must still extend 3 months after the cadence month, not the moved month', async () => {
    const cadenceDate = nextWeekday(14, 2); // a Tuesday, comfortably future
    const cp = etParts(noon(cadenceDate));
    // Exactly one calendar month after the cadence slot (day clamped to 28
    // so this never skips a short month) — a fixed +N-day offset can cross
    // TWO month boundaries when cadenceDate falls late in a long month
    // (e.g. Jan 26 + 35 days lands in March, not February).
    const movedDate = etDateString(new Date(Date.UTC(cp.year, cp.month, Math.min(cp.day, 28), 16)));
    expect(ymdMonth(movedDate)).toBe(ymdMonth(cadenceDate) + 1);
    // Parent completed 3 months before the cadence slot, same day-of-month
    // (quarterly re-anchors on the parent's nth-weekday, so only the MONTH
    // of the anchor matters for this assertion — see the primary reproducer
    // series-extend-anchor-ignores-exception.test.js for the same method).
    const parentDate = etDateString(new Date(Date.UTC(cp.year, cp.month - 1 - 3, Math.min(cp.day, 28), 16)));
    const { parentId, tailId } = await seedSeries({
      pattern: 'quarterly', parentDate, tailCadenceDate: cadenceDate, tailMovedDate: movedDate,
    });
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    await maintain(db, parent);
    const child = await seededChild(parentId, [tailId]);
    // Expected: cadence month + 3. Bug: moved month + 3 (= cadence month + 4).
    expect(ymdMonth(child.scheduled_date)).toBe(ymdMonth(cadenceDate) + 3);
  });

  test('biweekly: tail cadence slot moved once (this visit only) a few days later must still extend from the cadence weekday, not the moved one', async () => {
    const cadenceDate = nextWeekday(14, 2); // a Tuesday, comfortably future
    const movedDate = plusDays(cadenceDate, 3); // moved to Friday, this visit only
    const parentDate = plusDays(cadenceDate, -14);
    const { parentId, tailId } = await seedSeries({
      pattern: 'biweekly', parentDate, tailCadenceDate: cadenceDate, tailMovedDate: movedDate,
    });
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    await maintain(db, parent);
    const child = await seededChild(parentId, [tailId]);
    // Expected: cadence position + 14 days (same Tuesday). Bug: moved date + 14 (Friday).
    expect(child.scheduled_date).toBe(plusDays(cadenceDate, 14));
    expect(dow(child.scheduled_date)).toBe(2);
  });
});
