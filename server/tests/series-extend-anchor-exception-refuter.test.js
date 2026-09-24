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
 */
const { randomUUID } = require('crypto');
const mockRegister = jest.fn(async () => {});
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: mockRegister, alertRegistrationFailure: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

jest.setTimeout(60000);

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

  test('quarterly: tail cadence slot Oct 27 (4th Tue) moved once to Nov 3 -> extension should seed Jan 26, not Feb 23', async () => {
    // Parent Jul 28 2026 = 4th Tuesday; quarterly cadence = 4th Tuesday of Oct, Jan, Apr...
    const { parentId, tailId } = await seedSeries({
      pattern: 'quarterly', parentDate: '2026-07-28', tailCadenceDate: '2026-10-27', tailMovedDate: '2026-11-03',
    });
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    await maintain(db, parent);
    const child = await seededChild(parentId, [tailId]);
    // Cadence position Oct 27 + 3 months = 4th Tuesday of Jan 2027 = Jan 26.
    expect(child.scheduled_date).toBe('2027-01-26');
  });

  test('biweekly: tail cadence slot Oct 6 moved once to Oct 9 -> extension should seed Oct 20, not Oct 23', async () => {
    const { parentId, tailId } = await seedSeries({
      pattern: 'biweekly', parentDate: '2026-09-22', tailCadenceDate: '2026-10-06', tailMovedDate: '2026-10-09',
    });
    const parent = await db('scheduled_services').where({ id: parentId }).first();
    await maintain(db, parent);
    const child = await seededChild(parentId, [tailId]);
    expect(child.scheduled_date).toBe('2026-10-20');
  });
});
