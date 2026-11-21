/**
 * GATE_TECH_SHIFT_HOURS at a commit: real estimate holds over real rows, in a
 * synthetic private schema. The offers already keep to each technician's shift
 * (tech-shift-hours-postgres.test.js). These cases change the hours, or the
 * job, after the offer and prove each commit point refuses a job the shift no
 * longer holds: the reserve, the accept and the extend.
 */
const { createCapacityDbFixture, describeDb } = require('./helpers/scheduling-capacity-db');
const { reserveSlot, commitReservation, extendReservation } = require('../services/slot-reservation');
const { shiftExcluding } = require('../services/technician-eligibility');
jest.setTimeout(30000);

describeDb('technician shift hours at a commit (PostgreSQL)', () => {
  const f = createCapacityDbFixture('tech_shift_commit');
  const [first, second] = f.ids.estimates;
  const setShift = (start, end) => f.db('technicians').where({ id: f.ids.technician }).update({ shift_start: start, shift_end: end });
  const holdRow = (id) => f.db('scheduled_services').where({ id }).first();
  const holdsOf = (estimateId) => f.db('scheduled_services').where({ source_estimate_id: estimateId });
  const unavailable = { code: 'SLOT_UNAVAILABLE', message: 'slot technician is not available' };

  // The reader also asks for today's clock-ins. The fixture date is two weeks out, so none apply.
  beforeAll(async () => { await f.db.raw('CREATE TABLE time_entries (LIKE public.time_entries INCLUDING ALL)'); });
  beforeEach(async () => {
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    await setShift('08:00', '12:00');
  });
  afterEach(async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    await setShift(null, null);
  });

  describe('the reserve', () => {
    test('a hold inside the shift is taken; one that starts before it, or ends after it, is refused and writes nothing', async () => {
      const held = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 30, '11:00') });
      expect(await holdRow(held.scheduledServiceId)).toMatchObject({ window_start: '11:00:00', window_end: '11:30:00', customer_id: null });
      const refused = (start) => expect(reserveSlot({ estimateId: second, slotId: f.signedSlot(second, 30, start) })).rejects.toMatchObject(unavailable);
      await refused('12:00');
      // 10:00 to 10:30 against a shift that ends at 10:15: the start fits, the end does not.
      await setShift('08:00', '10:15');
      await refused('10:00');
      // The same hold against a shift that starts at 10:15: the end fits, the start does not.
      await setShift('10:15', '18:00');
      await refused('10:00');
      expect(await holdsOf(second)).toEqual([]);
      // At the shift start and the shift end exactly, it is taken.
      await setShift('10:00', '10:30');
      const exact = await reserveSlot({ estimateId: second, slotId: f.signedSlot(second, 30, '10:00') });
      expect(await holdRow(exact.scheduledServiceId)).toMatchObject({ window_start: '10:00:00', window_end: '10:30:00' });
    });

    test('the same hour is held with the gate off, and for a technician without set hours', async () => {
      delete process.env.GATE_TECH_SHIFT_HOURS;
      const gateOff = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 30, '12:00') });
      expect(await holdRow(gateOff.scheduledServiceId)).toMatchObject({ window_start: '12:00:00' });
      process.env.GATE_TECH_SHIFT_HOURS = 'true';
      await setShift(null, null);
      const noHours = await reserveSlot({ estimateId: second, slotId: f.signedSlot(second, 30, '13:00') });
      expect(await holdRow(noHours.scheduledServiceId)).toMatchObject({ window_start: '13:00:00' });
    });
  });

  describe('the accept', () => {
    test('the office shortens the shift after the reserve: the accept is refused and the hold stays a hold', async () => {
      const held = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 30, '11:00') });
      await setShift('08:00', '11:00');
      await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer }))
        .rejects.toMatchObject(unavailable);
      expect(await holdRow(held.scheduledServiceId)).toMatchObject({ customer_id: null });
      await setShift('08:00', '11:30');
      const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer });
      expect(booked).toMatchObject({ window_start: '11:00:00', window_end: '11:30:00', reservation_expires_at: null });
    });

    test('hour mode, a job the accept lengthens: the final window is the one checked, not the held one', async () => {
      delete process.env.GATE_SCHEDULING_CAPACITY;
      const held = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 60, '10:00') });
      expect(await holdRow(held.scheduledServiceId)).toMatchObject({ window_start: '10:00:00', window_end: '11:00:00' });
      const accept = (durationMinutes) => commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, durationMinutes });
      // 10:00 plus 150 minutes ends at 12:30, after the 12:00 shift end. The held window (to 11:00) would pass.
      await expect(accept(150)).rejects.toMatchObject(unavailable);
      expect(await holdRow(held.scheduledServiceId)).toMatchObject({ customer_id: null, window_end: '11:00:00' });
      // 10:00 plus 120 minutes ends at the shift end.
      expect(await accept(120)).toMatchObject({ window_start: '10:00:00', window_end: '12:00:00', estimated_duration_minutes: 120 });
    });

    test('the accept reads the hours on its own transaction: a change that transaction has not committed counts', async () => {
      delete process.env.GATE_SCHEDULING_CAPACITY;
      const held = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 60, '10:00') });
      await expect(f.db.transaction(async (trx) => {
        await trx('technicians').where({ id: f.ids.technician }).update({ shift_end: '10:30' });
        return commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, trx });
      })).rejects.toMatchObject(unavailable);
      // Rolled back with the refusal: the hours are the committed ones again, and the hold is accepted.
      const booked = await f.db.transaction((trx) => commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, trx }));
      expect(booked).toMatchObject({ window_start: '10:00:00', window_end: '11:00:00', reservation_expires_at: null });
    });

    test('gate off: a hold outside the set hours is accepted, as before', async () => {
      const held = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 30, '11:00') });
      await setShift('08:00', '11:00');
      delete process.env.GATE_TECH_SHIFT_HOURS;
      const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer });
      expect(booked).toMatchObject({ window_start: '11:00:00', reservation_expires_at: null });
    });
  });

  describe('the rule on a transaction (shiftExcluding)', () => {
    const block = { startMin: 600, endMin: 660 };
    // A second connection changes the hours. It gives up after 300 ms when the row is held.
    const editHours = () => f.db.transaction(async (other) => {
      await other.raw("SET LOCAL lock_timeout = '300ms'");
      await other('technicians').where({ id: f.ids.technician }).update({ shift_start: '08:15', shift_end: '11:45' });
    });

    test('it holds the technician row until its transaction ends: an hours edit waits, also for a technician with no set hours', async () => {
      for (const hours of [['08:00', '12:00'], [null, null]]) {
        await setShift(...hours);
        await f.db.transaction(async (trx) => {
          expect(await shiftExcluding(trx, f.ids.technician, f.date, block)).toBeNull();
          await expect(editHours()).rejects.toMatchObject({ code: '55P03' });
        });
        await editHours();
        expect(await f.db('technicians').where({ id: f.ids.technician }).first('shift_start', 'shift_end')).toEqual({ shift_start: '08:15:00', shift_end: '11:45:00' });
      }
    });

    test('gate off: no row is held, and the hours can change beside the open transaction', async () => {
      delete process.env.GATE_TECH_SHIFT_HOURS;
      await f.db.transaction(async (trx) => {
        expect(await shiftExcluding(trx, f.ids.technician, f.date, block)).toBeNull();
        await editHours();
      });
    });
  });

  describe('the extend', () => {
    test('the office shortens the shift after the reserve: the extend is refused; with the hours back it extends', async () => {
      const held = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 30, '11:00') });
      await setShift('08:00', '11:00');
      await expect(extendReservation({ estimateId: first, scheduledServiceId: held.scheduledServiceId }))
        .rejects.toMatchObject(unavailable);
      await setShift('08:00', '12:00');
      const { expiresAt } = await extendReservation({ estimateId: first, scheduledServiceId: held.scheduledServiceId });
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    test('gate off: the extend keeps a hold outside the set hours, as before', async () => {
      const held = await reserveSlot({ estimateId: first, slotId: f.signedSlot(first, 30, '11:00') });
      await setShift('08:00', '11:00');
      delete process.env.GATE_TECH_SHIFT_HOURS;
      const { expiresAt } = await extendReservation({ estimateId: first, scheduledServiceId: held.scheduledServiceId });
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });
});
