// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// GATE_VISIT_HOLD (owner 2026-11-27, "build hold"): a visit the customer asked us to hold. This suite proves the
// writers, the series close (skipped, no make-up visit, no text), the single day-14 bell, the occupancy and day-feed
// filters, the rebooker backstop and the customer-message guard against real tables. The gate is read at call time.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

const { etDateString, addETDays } = require('../utils/datetime-et');

// Fixture dates come from the Eastern calendar, the zone the sweep and the release check compare in.
const ymdOffset = (days) => etDateString(addETDays(new Date(), days));

postgres('visit on hold on PostgreSQL', () => {
  let database;
  let trx;
  let hold;
  let customerId;
  const priorGate = process.env.GATE_VISIT_HOLD;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
    hold = require('../services/visit-hold');
  });

  beforeEach(async () => {
    process.env.GATE_VISIT_HOLD = 'true';
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Hold', email: `${customerId}@example.invalid`,
      phone: `fixture-${customerId.slice(0, 8)}`,
    });
  });

  afterEach(async () => {
    if (trx) await trx.rollback();
    if (priorGate === undefined) delete process.env.GATE_VISIT_HOLD; else process.env.GATE_VISIT_HOLD = priorGate;
  });
  afterAll(async () => { await database?.destroy(); });

  async function visit(over = {}) {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: ymdOffset(5), service_type: 'Quarterly Pest Control',
      status: 'confirmed', window_start: '09:00', window_end: '11:00', ...over,
    });
    return id;
  }
  const row = (id) => trx('scheduled_services').where({ id }).first();

  const seriesOf = async (heldDate, nextDate, { nextStatus = 'confirmed' } = {}) => {
    const parent = randomUUID();
    await trx('scheduled_services').insert({
      id: parent, customer_id: customerId, scheduled_date: heldDate, service_type: 'Quarterly Pest Control', status: 'confirmed',
      is_recurring: true, recurring_pattern: 'quarterly',
    });
    const next = await visit({
      scheduled_date: nextDate, status: nextStatus, is_recurring: true, recurring_parent_id: parent, recurring_pattern: 'quarterly',
    });
    return { held: parent, next };
  };

  describe('putVisitOnHold and releaseVisitHold', () => {
    test('a hold stamps the four columns, trims the note, and a second hold changes nothing', async () => {
      const id = await visit();
      const first = await hold.putVisitOnHold({ visitId: id, note: `  will call ${'x'.repeat(400)}  ` });
      expect(first.changed).toBe(true);
      const held = await row(id);
      expect(held.held_at).not.toBeNull();
      expect(held.hold_released_at).toBeNull();
      expect(held.hold_note.length).toBe(280);
      expect(held.hold_note.startsWith('will call')).toBe(true);
      const again = await hold.putVisitOnHold({ visitId: id, note: 'other' });
      expect(again.changed).toBe(false);
      expect((await row(id)).hold_note).toBe(held.hold_note);
    });

    test('only a pending or confirmed visit can be held', async () => {
      for (const status of ['completed', 'cancelled', 'en_route', 'on_site', 'skipped']) {
        const id = await visit({ status });
        await expect(hold.putVisitOnHold({ visitId: id })).rejects.toMatchObject({ status: 409, code: 'not_holdable' });
      }
    });

    test('gate off: the writers answer 404 and no reader looks at the column', async () => {
      const id = await visit();
      process.env.GATE_VISIT_HOLD = 'false';
      await expect(hold.putVisitOnHold({ visitId: id })).rejects.toMatchObject({ status: 404, code: 'visit_hold_off' });
      await trx('scheduled_services').where({ id }).update({ held_at: new Date() });
      expect(hold.rowIsHeld(await row(id))).toBe(false);
      expect(await hold.isVisitHeld(id)).toBe(false);
      expect(hold.excludeHeld(trx('scheduled_services as ss'), 'ss').toQuery()).not.toMatch(/held_at/);
      expect(hold.heldSqlGuard('ss')).toBe('');
    });

    test('release clears the hold, keeps the date, and is idempotent', async () => {
      const id = await visit();
      const date = (await row(id)).scheduled_date;
      await hold.putVisitOnHold({ visitId: id, note: 'x' });
      expect((await hold.releaseVisitHold({ visitId: id })).changed).toBe(true);
      const released = await row(id);
      expect(released.held_at).toBeNull();
      expect(released.hold_released_at).not.toBeNull();
      expect(released.scheduled_date).toEqual(date);
      expect(released.status).toBe('confirmed');
      expect((await hold.releaseVisitHold({ visitId: id })).changed).toBe(false);
    });

    test('a technician hold re-checks ownership on the locked row: another technician is refused, the owner is let in', async () => {
      const techA = randomUUID();
      const techB = randomUUID();
      await trx('technicians').insert([{ id: techA, name: 'Tech A' }, { id: techB, name: 'Tech B' }]);
      const id = await visit({ technician_id: techB });
      const asTech = (technicianId) => ({ techRole: 'technician', technicianId });
      await expect(hold.putVisitOnHold({ visitId: id, scopeReq: asTech(techA) })).rejects.toMatchObject({ status: 404 });
      expect((await row(id)).held_at).toBeNull();
      expect((await hold.putVisitOnHold({ visitId: id, scopeReq: asTech(techB) })).changed).toBe(true);
      const other = await visit({ technician_id: techB });
      expect((await hold.putVisitOnHold({ visitId: other, scopeReq: { techRole: 'admin' } })).changed).toBe(true);
    });

    test('release refuses a slot booked while the visit was held, and keeps it held; a free slot releases', async () => {
      const date = ymdOffset(8);
      const id = await visit({ scheduled_date: date, window_start: '09:00', window_end: '11:00' });
      await hold.putVisitOnHold({ visitId: id });
      const other = await visit({ scheduled_date: date, window_start: '10:00', window_end: '12:00' });
      await expect(hold.releaseVisitHold({ visitId: id })).rejects.toMatchObject({ status: 409, code: 'SLOT_TAKEN' });
      expect((await row(id)).held_at).not.toBeNull();
      await trx('scheduled_services').where({ id: other }).update({ status: 'cancelled' });
      expect((await hold.releaseVisitHold({ visitId: id })).changed).toBe(true);
    });

    test('the projection helper names held_at only while the gate is live', () => {
      expect(hold.heldColumn()).toEqual(['held_at']);
      expect(hold.heldColumn('ss.')).toEqual(['ss.held_at']);
      process.env.GATE_VISIT_HOLD = 'false';
      expect(hold.heldColumn()).toEqual([]);
    });

    test('release uses the booking span of a visit with no end time: a start plus its duration blocks an overlapping booking', async () => {
      const date = ymdOffset(8);
      const id = await visit({ scheduled_date: date, window_start: '09:00', window_end: null, estimated_duration_minutes: 120 });
      await hold.putVisitOnHold({ visitId: id });
      const other = await visit({ scheduled_date: date, window_start: '10:00', window_end: '11:00' });
      await expect(hold.releaseVisitHold({ visitId: id })).rejects.toMatchObject({ status: 409, code: 'SLOT_TAKEN' });
      await trx('scheduled_services').where({ id: other }).update({ status: 'cancelled' });
      expect((await hold.releaseVisitHold({ visitId: id })).changed).toBe(true);
    });

    test('release refuses when the visit changed between the unlocked read and the lock', async () => {
      const occupancy = require('../services/scheduling/occupancy');
      const id = await visit({ scheduled_date: ymdOffset(8) });
      await hold.putVisitOnHold({ visitId: id });
      const real = occupancy.acquireOccupancyLock;
      jest.spyOn(occupancy, 'acquireOccupancyLock').mockImplementation(async (...args) => {
        await real(...args);
        await trx('scheduled_services').where({ id }).update({ held_at: new Date(Date.now() + 1000), window_start: '13:00', window_end: '15:00' });
      });
      try {
        await expect(hold.releaseVisitHold({ visitId: id })).rejects.toMatchObject({ status: 409, code: 'hold_changed' });
      } finally { occupancy.acquireOccupancyLock.mockRestore(); }
      expect((await row(id)).held_at).not.toBeNull();
    });

    test('with multi-technician confirm on, another technician\'s booking does not block the release', async () => {
      const techA = randomUUID();
      const techB = randomUUID();
      await trx('technicians').insert([{ id: techA, name: 'Tech A' }, { id: techB, name: 'Tech B' }]);
      const date = ymdOffset(8);
      const id = await visit({ scheduled_date: date, technician_id: techA });
      await hold.putVisitOnHold({ visitId: id });
      await visit({ scheduled_date: date, technician_id: techB });
      const prior = process.env.GATE_MULTI_TECH_CONFIRM;
      process.env.GATE_MULTI_TECH_CONFIRM = 'true';
      try {
        expect((await hold.releaseVisitHold({ visitId: id })).changed).toBe(true);
      } finally { if (prior === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM; else process.env.GATE_MULTI_TECH_CONFIRM = prior; }
    });

    test('an unclaimed estimate reservation cannot be held; an address-only visit can', async () => {
      const reservation = await visit({ customer_id: null, reservation_expires_at: new Date(Date.now() + 3600000) });
      await expect(hold.putVisitOnHold({ visitId: reservation })).rejects.toMatchObject({ status: 409, code: 'not_holdable' });
      const addressOnly = await visit({ customer_id: null });
      expect((await hold.putVisitOnHold({ visitId: addressOnly })).changed).toBe(true);
    });

    test('the office list reads held visits oldest first', async () => {
      const a = await visit();
      const b = await visit();
      await trx('scheduled_services').where({ id: b }).update({ held_at: new Date(Date.now() - 3 * 86400000), hold_note: 'older' });
      await trx('scheduled_services').where({ id: a }).update({ held_at: new Date() });
      const list = await hold.listHeldVisits({ conn: trx });
      const mine = list.filter((r) => [a, b].includes(r.id));
      expect(mine.map((r) => r.id)).toEqual([b, a]);
      expect(mine[0]).toMatchObject({ holdNote: 'older', daysOnHold: 3, customerName: 'Synthetic Hold' });
    });
  });

  describe('readers', () => {
    test('a held visit blocks no time slot', async () => {
      const { findConflictingVisits } = require('../services/scheduling/occupancy');
      const date = ymdOffset(6);
      const id = await visit({ scheduled_date: date, window_start: '09:00', window_end: '11:00' });
      const probe = () => findConflictingVisits({ db: trx, date, windowStart: '09:00', windowEnd: '11:00' });
      expect((await probe()).map((r) => r.id)).toContain(id);
      await hold.putVisitOnHold({ visitId: id });
      expect((await probe()).map((r) => r.id)).not.toContain(id);
      await hold.releaseVisitHold({ visitId: id });
      expect((await probe()).map((r) => r.id)).toContain(id);
    });

    test('the estimate slot picker offers the hour of a held visit', async () => {
      const { filterCollidingSlots } = require('../services/estimate-slot-availability');
      const date = ymdOffset(9);
      const id = await visit({ scheduled_date: date, window_start: '09:00', window_end: '11:00' });
      const slot = { date, windowStart: '09:00', windowEnd: '11:00', techId: null };
      const offered = async () => (await filterCollidingSlots([slot], { dateFrom: date, dateTo: date, conn: trx })).length;
      expect(await offered()).toBe(0);
      await hold.putVisitOnHold({ visitId: id });
      expect(await offered()).toBe(1);
    });

    test('the day-stops scaffold used by route views and the optimizer skips a held visit', async () => {
      const { dayStopsQuery } = require('../services/scheduling/day-stops');
      const date = ymdOffset(7);
      const id = await visit({ scheduled_date: date });
      const stops = () => dayStopsQuery(trx, { dateStr: date, excludeStatuses: ['cancelled'], select: ['scheduled_services.id'] });
      expect((await stops()).map((r) => r.id)).toContain(id);
      await hold.putVisitOnHold({ visitId: id });
      expect((await stops()).map((r) => r.id)).not.toContain(id);
    });
  });

  describe('the mover backstop', () => {
    test('the tracker never goes en route or on property for a held visit', async () => {
      const { markEnRoute, markOnProperty } = require('../services/track-transitions');
      const techId = randomUUID();
      await trx('technicians').insert({ id: techId, name: 'Tech T' });
      const id = await visit({ scheduled_date: ymdOffset(0), technician_id: techId });
      await hold.putVisitOnHold({ visitId: id });
      expect(await markEnRoute(id, { allowFutureDate: true })).toMatchObject({ ok: false, reason: 'visit_on_hold' });
      expect(await markOnProperty(id, { allowFutureDate: true })).toMatchObject({ ok: false, reason: 'visit_on_hold' });
      expect((await row(id)).track_state).toBe('scheduled');
    });

    test('a visit moving into a held visit\'s hour is not refused by the technician-overlap probe', async () => {
      const SmartRebooker = require('../services/rebooker');
      const techId = randomUUID();
      await trx('technicians').insert({ id: techId, name: 'Tech T', employment_status: 'active', field_dispatchable: true, active: true });
      const date = ymdOffset(10);
      const heldId = await visit({ scheduled_date: date, technician_id: techId, window_start: '09:00', window_end: '11:00' });
      await hold.putVisitOnHold({ visitId: heldId });
      const moving = await visit({ scheduled_date: ymdOffset(6), technician_id: techId, window_start: '13:00', window_end: '15:00' });
      await SmartRebooker.reschedule(moving, date, { start: '09:00', end: '11:00' }, 'admin', 'admin', { seriesPolicy: 'single' });
      expect((await row(moving)).window_start).toMatch(/^09:00/);
      expect((await row(heldId)).held_at).not.toBeNull();
    });

    test('a hold placed after the no-show scan, read under the row lock, is no customer no-show', async () => {
      const missedAppointment = require('../services/workflows/missed-appointment');
      const id = await visit({ scheduled_date: ymdOffset(0) });
      const scanned = await row(id);
      await hold.putVisitOnHold({ visitId: id });
      expect(await missedAppointment.onSkip(id, 'no_show', trx, { scanned })).toEqual({ action: 'stale_candidate' });
      expect(await trx('reschedule_log').where({ scheduled_service_id: id }).count('* as n').first()).toMatchObject({ n: '0' });
    });

    test('the next-visit preview skips a held sibling the writer would not move', async () => {
      const { loadNextVisitSweep } = require('../services/rebooker');
      const { held: parent, next: first } = await seriesOf(ymdOffset(20), ymdOffset(110));
      const second = await visit({ scheduled_date: ymdOffset(200), is_recurring: true, recurring_parent_id: parent, recurring_pattern: 'quarterly' });
      expect((await loadNextVisitSweep(trx, parent)).next.id).toBe(first);
      await trx('scheduled_services').where({ id: first }).update({ held_at: new Date() });
      expect((await loadNextVisitSweep(trx, parent)).next.id).toBe(second);
    });

    test('the guard refuses an automatic move and writes nothing; a person\'s move is let through still held', async () => {
      const id = await visit();
      await hold.putVisitOnHold({ visitId: id, note: 'keep' });
      await expect(hold.guardHeldMove(id, { releaseHold: false })).rejects.toMatchObject({ status: 409, code: 'VISIT_ON_HOLD' });
      expect(await hold.guardHeldMove(id, { releaseHold: true })).toBe(true);
      expect((await row(id)).held_at).not.toBeNull();
      expect(await hold.guardHeldMove(await visit(), { releaseHold: true })).toBe(false);
    });

    test('a person\'s reschedule releases the hold in the same write; a refused one leaves it held', async () => {
      const SmartRebooker = require('../services/rebooker');
      const id = await visit();
      await hold.putVisitOnHold({ visitId: id, note: 'keep' });
      await expect(SmartRebooker.reschedule(id, ymdOffset(-3), { start: '09:00', end: '11:00' }, 'admin', 'admin', { releaseHold: true }))
        .rejects.toMatchObject({ code: 'INVALID_DATE' });
      expect((await row(id)).held_at).not.toBeNull();
      const target = ymdOffset(12);
      await SmartRebooker.reschedule(id, target, { start: '13:00', end: '15:00' }, 'admin', 'admin', { releaseHold: true, seriesPolicy: 'single' });
      const moved = await row(id);
      expect(moved.held_at).toBeNull();
      expect(moved.hold_released_at).not.toBeNull();
      expect(String(moved.scheduled_date.toISOString?.().slice(0, 10) || moved.scheduled_date).slice(0, 10)).toBe(target);
    });

    test('the move write fences held_at: a hold that commits after the guard read stops an automatic move', async () => {
      const SmartRebooker = require('../services/rebooker');
      const id = await visit();
      const realGuard = hold.guardHeldMove;
      // the guard reads "not held", then the technician's hold commits before the move's own UPDATE
      jest.spyOn(hold, 'guardHeldMove').mockImplementation(async (...args) => {
        const out = await realGuard(...args);
        await hold.putVisitOnHold({ visitId: id });
        return out;
      });
      try {
        await expect(SmartRebooker.reschedule(id, ymdOffset(12), { start: '13:00', end: '15:00' }, 'auto_dispatch', 'auto_dispatch', { seriesPolicy: 'single' }))
          .rejects.toBeTruthy();
      } finally { hold.guardHeldMove.mockRestore(); }
      const after = await row(id);
      expect(after.held_at).not.toBeNull();
      expect(String(after.scheduled_date.toISOString?.().slice(0, 10) || after.scheduled_date).slice(0, 10)).toBe(ymdOffset(5));
    });

    test('an office move through the Intelligence Bar ends the hold, and stamps the release only on a held visit', async () => {
      const { writeMovedStop } = require('../services/intelligence-bar/schedule-tools')._private;
      const move = async (id, dateStr) => {
        const s = await row(id);
        const c = { s, observedDate: ymdOffset(5), oldDate: ymdOffset(5), wasLive: false, liveReset: {} };
        await writeMovedStop(trx, c, dateStr, null, undefined);
      };
      const heldId = await visit();
      await hold.putVisitOnHold({ visitId: heldId });
      await move(heldId, ymdOffset(11));
      const freed = await row(heldId);
      expect(freed.held_at).toBeNull();
      expect(freed.hold_released_at).not.toBeNull();
      const plainId = await visit();
      await move(plainId, ymdOffset(11));
      expect((await row(plainId)).hold_released_at).toBeNull();
    });

    test('a held non-anchor sibling is counted but never moved by a series sweep', () => {
      const rows = [{ id: 'a', status: 'confirmed', held_at: null }, { id: 'b', status: 'confirmed', held_at: new Date() }, { id: 'c', status: 'pending', held_at: new Date() }];
      const marked = hold.markHeldSiblings(rows, 'c');
      expect(marked.map((r) => r.status)).toEqual(['confirmed', hold.HELD_SIBLING_STATUS, 'pending']);
    });

    test('the status writer refuses en_route, on_site and completed for a held visit; skipped and cancelled stay open', async () => {
      const { transitionJobStatus } = require('../services/job-status');
      const id = await visit();
      await hold.putVisitOnHold({ visitId: id });
      for (const toStatus of ['en_route', 'on_site', 'completed']) {
        await expect(transitionJobStatus({ jobId: id, fromStatus: 'confirmed', toStatus, transitionedBy: null, trx }))
          .rejects.toMatchObject({ code: 'VISIT_ON_HOLD' });
      }
      expect((await row(id)).status).toBe('confirmed');
    });
  });

  describe('the customer-message guard', () => {
    const { _internals } = require('../services/messaging/send-customer-message');
    const input = (over = {}) => ({ audience: 'customer', purpose: 'appointment_reminder_24h', channel: 'sms', metadata: {}, ...over });

    test('blocks an automated message about a held visit, not about another visit', async () => {
      const heldId = await visit();
      const otherId = await visit();
      await hold.putVisitOnHold({ visitId: heldId });
      expect(await _internals.visitHoldBlocksSend(input({ appointmentId: heldId }))).toBe(true);
      expect(await _internals.visitHoldBlocksSend(input({ purpose: 'billing', metadata: { scheduled_service_id: heldId } }))).toBe(true);
      expect(await _internals.visitHoldBlocksSend(input({ metadata: { linked_scheduled_service_ids: [otherId, heldId] } }))).toBe(true);
      expect(await _internals.visitHoldBlocksSend(input({ appointmentId: otherId }))).toBe(false);
      expect(await _internals.visitHoldBlocksSend(input({}))).toBe(false);
    });

    test('a cancellation notice, a typed text and an internal message still go', async () => {
      const heldId = await visit();
      await hold.putVisitOnHold({ visitId: heldId });
      expect(await _internals.visitHoldBlocksSend(input({ purpose: 'appointment_cancellation', appointmentId: heldId }))).toBe(false);
      expect(await _internals.visitHoldBlocksSend(input({ appointmentId: heldId, metadata: { humanAuthored: true } }))).toBe(false);
      expect(await _internals.visitHoldBlocksSend(input({ appointmentId: heldId, audience: 'internal' }))).toBe(false);
    });

    test('gate off: nothing is held', async () => {
      const heldId = await visit();
      await hold.putVisitOnHold({ visitId: heldId });
      process.env.GATE_VISIT_HOLD = 'false';
      expect(await _internals.visitHoldBlocksSend(input({ appointmentId: heldId }))).toBe(false);
    });
  });

  describe('the daily sweep', () => {

    test('the next plan visit reaching its date closes the held visit as skipped: no make-up visit, no text, a note', async () => {
      const { held, next } = await seriesOf(ymdOffset(-20), ymdOffset(0));
      await trx('scheduled_services').where({ id: held }).update({ held_at: new Date(Date.now() - 10 * 86400000) });
      const before = Number((await trx('scheduled_services').where({ customer_id: customerId }).count('* as n').first()).n);
      const out = await hold.runVisitHoldSweep({ conn: trx });
      expect(out).toMatchObject({ skipped: false, closed: 1 });
      const closed = await row(held);
      expect(closed.status).toBe('skipped');
      expect(closed.held_at).toBeNull();
      expect(closed.hold_released_at).not.toBeNull();
      expect((await row(next)).status).toBe('confirmed');
      expect(Number((await trx('scheduled_services').where({ customer_id: customerId }).count('* as n').first()).n)).toBe(before);
      const history = await trx('job_status_history').where({ job_id: held, to_status: 'skipped' }).first();
      expect(history.notes).toBe('hold expired');
    });

    test('a completed next visit closes it too; a future next visit does not; a one-time visit never closes', async () => {
      const done = await seriesOf(ymdOffset(-40), ymdOffset(-5), { nextStatus: 'completed' });
      const waiting = await seriesOf(ymdOffset(-3), ymdOffset(60));
      const oneTime = await visit({ scheduled_date: ymdOffset(-30) });
      for (const id of [done.held, waiting.held, oneTime]) await trx('scheduled_services').where({ id }).update({ held_at: new Date(Date.now() - 2 * 86400000) });
      await hold.runVisitHoldSweep({ conn: trx });
      expect((await row(done.held)).status).toBe('skipped');
      expect((await row(waiting.held)).held_at).not.toBeNull();
      expect((await row(oneTime)).held_at).not.toBeNull();
      expect((await row(oneTime)).status).toBe('confirmed');
    });

    test('a booster month is no series visit: a held booster never closes, and a due booster never closes a held plan visit', async () => {
      const { held, next } = await seriesOf(ymdOffset(-20), ymdOffset(60));
      await trx('scheduled_services').where({ id: held }).update({ held_at: new Date(Date.now() - 2 * 86400000) });
      const booster = await visit({ scheduled_date: ymdOffset(-1), status: 'confirmed', is_recurring: false, recurring_parent_id: held });
      await hold.runVisitHoldSweep({ conn: trx });
      expect((await row(held)).held_at).not.toBeNull();
      expect((await row(booster)).status).toBe('confirmed');
      expect((await row(next)).status).toBe('confirmed');
      await trx('scheduled_services').where({ id: booster }).update({ held_at: new Date(), scheduled_date: ymdOffset(-30) });
      await hold.runVisitHoldSweep({ conn: trx });
      expect((await row(booster)).held_at).not.toBeNull();
      expect((await row(booster)).status).toBe('confirmed');
    });

    test('the close re-checks under the row locks: a re-placed hold, a moved or held successor ends it', async () => {
      const { held, next } = await seriesOf(ymdOffset(-20), ymdOffset(0));
      const heldAt = new Date(Date.now() - 3 * 86400000);
      await trx('scheduled_services').where({ id: held }).update({ held_at: heldAt });
      const stale = { id: held, held_at: new Date(heldAt.getTime() - 5000) };
      expect(await hold._private.closeHeldVisitAsSkipped(stale, ymdOffset(0), { conn: trx })).toBeNull();
      await trx('scheduled_services').where({ id: next }).update({ scheduled_date: ymdOffset(30) });
      expect(await hold._private.closeHeldVisitAsSkipped({ id: held, held_at: heldAt }, ymdOffset(0), { conn: trx })).toBeNull();
      await trx('scheduled_services').where({ id: next }).update({ scheduled_date: ymdOffset(0), held_at: new Date() });
      expect(await hold._private.closeHeldVisitAsSkipped({ id: held, held_at: heldAt }, ymdOffset(0), { conn: trx })).toBeNull();
      expect((await row(held)).status).toBe('confirmed');
      await trx('scheduled_services').where({ id: next }).update({ held_at: null });
      expect(await hold._private.closeHeldVisitAsSkipped({ id: held, held_at: heldAt }, ymdOffset(0), { conn: trx })).toMatchObject({ id: next });
      expect((await row(held)).status).toBe('skipped');
    });

    test('day 14 rings ONE bell, never again, and the bell closes when the hold ends', async () => {
      const id = await visit({ scheduled_date: ymdOffset(-1) });
      await trx('scheduled_services').where({ id }).update({ held_at: new Date(Date.now() - 15 * 86400000), hold_note: 'x' });
      const young = await visit();
      await trx('scheduled_services').where({ id: young }).update({ held_at: new Date(Date.now() - 5 * 86400000) });
      const bells = () => trx('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [`visit-hold-day14:${id}`]);
      const first = await hold.runVisitHoldSweep({ conn: trx });
      expect(first.rang).toBe(1);
      const rows = await bells();
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toMatch(/^Schedule — call Synthetic Hold to rebook/);
      expect(rows[0].body).toMatch(/still on hold since/);
      expect(rows[0].done_at).toBeNull();
      expect(await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`visit-hold-day14:${young}`])).toHaveLength(0);
      const second = await hold.runVisitHoldSweep({ conn: trx });
      expect(second.rang).toBe(0);
      expect(await bells()).toHaveLength(1);
      await hold.releaseVisitHold({ visitId: id, conn: trx });
      const after = await bells();
      expect(after).toHaveLength(1);
      expect(after[0].done_at).not.toBeNull();
      // released and re-held later: the same visit never rings a second bell
      await hold.putVisitOnHold({ visitId: id, conn: trx });
      await trx('scheduled_services').where({ id }).update({ held_at: new Date(Date.now() - 20 * 86400000) });
      await hold.runVisitHoldSweep({ conn: trx });
      expect(await bells()).toHaveLength(1);
    });

    test('gate off: the sweep does nothing', async () => {
      const { held } = await seriesOf(ymdOffset(-20), ymdOffset(0));
      await trx('scheduled_services').where({ id: held }).update({ held_at: new Date(Date.now() - 20 * 86400000) });
      process.env.GATE_VISIT_HOLD = 'false';
      expect(await hold.runVisitHoldSweep({ conn: trx })).toEqual({ skipped: true });
      expect((await row(held)).status).toBe('confirmed');
    });
  });
});
