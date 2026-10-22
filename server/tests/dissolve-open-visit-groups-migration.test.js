/**
 * 20261022130000 — dissolve the open visit groups. DB-backed (self-skips
 * without DATABASE_URL): the migration takes the stop advisory lock and reads
 * the canDissolve blockers in SQL, so a fake knex would prove nothing about
 * the statements that actually run. Everything executes inside a transaction
 * that is rolled back. Synthetic data only.
 *
 * Pins: a group nothing has started is dissolved and its rows detached with
 * date, window and status untouched; a group that has started (grouped text
 * sent, tech arrived, a service record on a member) stays open with its rows;
 * a pending effect does not count as started; the members' reminder rows are
 * not written; a second run changes nothing.
 */
const path = require('path');

const knexConfig = require(path.join(__dirname, '..', 'knexfile.js'));
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const migration = require('../models/migrations/20261022130000_dissolve_open_visit_groups');

describeOrSkip('20261022130000 dissolve open visit groups (DB-backed)', () => {
  let knex;
  beforeAll(() => {
    knex = require('knex')(knexConfig[process.env.NODE_ENV === 'production' ? 'production' : 'development']);
  });
  afterAll(async () => { await knex.destroy(); });

  test('dissolves only groups nothing has started, sends nothing, and is idempotent', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    await expect(knex.transaction(async (trx) => {
      const [cust] = await trx('customers').insert({
        first_name: 'Dissolve',
        last_name: 'Proof',
        email: `dissolve-proof-${Date.now()}@example.invalid`,
        phone: '+19410000000',
      }).returning('id');
      const customerId = cust.id || cust;

      let day = 0;
      // One visit with two member rows on its own future date (its own stop key).
      const group = async (visitFields = {}) => {
        day += 1;
        const date = `2027-03-${String(day).padStart(2, '0')}`;
        const [visit] = await trx('service_visits').insert({
          customer_id: customerId,
          scheduled_date: date,
          window_start: '10:00',
          window_end: '12:00',
          stop_base_key: `${customerId}:${date}`,
          behavior_version: 2,
          created_by: 'regroup-sweep',
          ...visitFields,
        }).returning('id');
        const visitId = visit.id || visit;
        const rows = await trx('scheduled_services').insert([
          { customer_id: customerId, scheduled_date: date, window_start: '10:00', service_type: 'Quarterly Pest Control Service', status: 'pending', visit_id: visitId },
          { customer_id: customerId, scheduled_date: date, window_start: '11:00', service_type: 'Every 6 Weeks Lawn Care Service', status: 'confirmed', visit_id: visitId },
        ]).returning('id');
        return { visitId, rowIds: rows.map((r) => r.id || r) };
      };

      const clean = await group();
      const pendingOnly = await group();
      await trx('visit_effects').insert({ visit_id: pendingOnly.visitId, effect_type: 'reminder_72h', dedupe_key: 'pending-only', status: 'pending' });
      const textSent = await group();
      await trx('visit_effects').insert({ visit_id: textSent.visitId, effect_type: 'reminder_72h', dedupe_key: 'text-sent', status: 'sent' });
      const arrived = await group({ arrived_at: trx.fn.now() });
      const recorded = await group();
      await trx('service_records').insert({
        customer_id: customerId,
        service_date: '2027-03-05',
        service_type: 'Quarterly Pest Control Service',
        status: 'completed',
        scheduled_service_id: recorded.rowIds[0],
      });

      const [reminder] = await trx('appointment_reminders').insert({
        customer_id: customerId,
        scheduled_service_id: clean.rowIds[0],
        appointment_time: '2027-03-01T15:00:00Z',
        source: 'test',
        confirmation_sent: true,
      }).returning('*');

      const rowsOf = (ids) => trx('scheduled_services').whereIn('id', ids)
        .orderBy('window_start').select('id', 'visit_id', 'scheduled_date', 'window_start', 'status');
      const before = await rowsOf(clean.rowIds);

      await migration.up(trx);

      for (const dissolved of [clean, pendingOnly]) {
        const visit = await trx('service_visits').where({ id: dissolved.visitId }).first('status', 'close_reason', 'closed_at');
        expect(visit).toMatchObject({ status: 'dissolved', close_reason: 'grouping_retired' });
        expect(visit.closed_at).not.toBeNull();
        expect((await rowsOf(dissolved.rowIds)).map((r) => r.visit_id)).toEqual([null, null]);
      }
      // Only the pointer moved: same date, window and status, so no
      // reschedule or status trigger had anything to react to.
      expect(await rowsOf(clean.rowIds)).toEqual(before.map((r) => ({ ...r, visit_id: null })));

      for (const started of [textSent, arrived, recorded]) {
        const visit = await trx('service_visits').where({ id: started.visitId }).first('status', 'close_reason');
        expect(visit).toEqual({ status: 'open', close_reason: null });
        expect((await rowsOf(started.rowIds)).map((r) => r.visit_id)).toEqual([started.visitId, started.visitId]);
      }

      // The member's reminder row is untouched: nothing armed or re-sent.
      expect(await trx('appointment_reminders').where({ id: reminder.id }).first()).toEqual(reminder);

      // A second run finds nothing more to do.
      const snapshot = await trx('service_visits').where({ customer_id: customerId }).orderBy('scheduled_date')
        .select('id', 'status', 'closed_at');
      await migration.up(trx);
      expect(await trx('service_visits').where({ customer_id: customerId }).orderBy('scheduled_date')
        .select('id', 'status', 'closed_at')).toEqual(snapshot);

      await migration.down(trx);

      throw new Error('rollback-on-purpose');
    })).rejects.toThrow('rollback-on-purpose');
    log.mockRestore();
  });
});
