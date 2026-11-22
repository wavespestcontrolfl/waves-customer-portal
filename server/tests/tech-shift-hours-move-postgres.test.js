/**
 * GATE_TECH_SHIFT_HOURS at a move: the real rebooker over real rows, in a
 * synthetic private schema. The offers keep to each technician's shift
 * (tech-shift-hours-postgres.test.js) and so do the commits
 * (tech-shift-hours-commit-postgres.test.js). These cases move a booked visit
 * and prove an automatic move cannot leave it outside the kept technician's
 * shift, while the office's own move still can.
 */
const { createCapacityDbFixture, describeDb } = require('./helpers/scheduling-capacity-db');

jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
  normalizeRecipient: (phone) => phone,
}));
jest.mock('../services/reschedule-link', () => ({ buildRescheduleLink: jest.fn() }));
jest.setTimeout(30000);

describeDb('technician shift hours at a move (PostgreSQL)', () => {
  const f = createCapacityDbFixture('tech_shift_move');
  const SmartRebooker = require('../services/rebooker');
  const nextDay = new Date(Date.parse(`${f.date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const setShift = (start, end) => f.db('technicians').where({ id: f.ids.technician }).update({ shift_start: start, shift_end: end });
  const rowOf = (id) => f.db('scheduled_services').where({ id })
    .first('window_start', 'window_end', 'technician_id', f.db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"));
  const seed = async (extra = {}) => {
    const stop = f.baseStop({ window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, ...extra });
    await f.db('scheduled_services').insert(stop);
    return stop.id;
  };
  // A customer's own reschedule: automatic, like a rain-out or an auto-dispatch move.
  const move = (id, date, window, by = 'customer', options = {}) => SmartRebooker.reschedule(id, date, window, 'customer_request', by, options);
  const refused = { status: 409, statusCode: 409, code: 'SLOT_TAKEN' };
  const asSeeded = { day: f.date, window_start: '09:00:00', window_end: '10:00:00', technician_id: f.ids.technician };

  beforeAll(async () => {
    for (const table of ['time_entries', 'reschedule_log', 'job_status_history', 'appointment_reminders', 'scheduled_service_addons']) {
      await f.db.raw('CREATE TABLE ?? (LIKE public.?? INCLUDING ALL)', [table, table]);
    }
  });
  beforeEach(async () => {
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    await setShift('08:00', '12:00');
  });
  afterEach(async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    await setShift(null, null);
  });

  test('an automatic move to another day inside the shift lands; one that ends after the shift, or starts before it, is refused and writes nothing', async () => {
    const inside = await seed();
    expect(await move(inside, nextDay, { start: '10:00', end: '11:00' })).toMatchObject({ success: true });
    expect(await rowOf(inside)).toMatchObject({ day: nextDay, window_start: '10:00:00', window_end: '11:00:00' });

    const late = await seed();
    await expect(move(late, nextDay, { start: '11:30', end: '12:30' })).rejects.toMatchObject(refused);
    expect(await rowOf(late)).toEqual(asSeeded);

    const early = await seed();
    await expect(move(early, nextDay, { start: '07:30', end: '08:30' })).rejects.toMatchObject(refused);
    expect(await rowOf(early)).toEqual(asSeeded);
  });

  test('an automatic move that changes only the hours, same day and technician, is checked too', async () => {
    const id = await seed();
    await expect(move(id, f.date, { start: '11:30', end: '12:30' })).rejects.toMatchObject(refused);
    expect(await rowOf(id)).toEqual(asSeeded);
    // A new end alone, and a new start alone, are hours moves too.
    await expect(move(id, f.date, { start: '09:00', end: '12:30' })).rejects.toMatchObject(refused);
    await expect(move(id, f.date, { start: '07:30', end: '10:00' })).rejects.toMatchObject(refused);
    expect(await rowOf(id)).toEqual(asSeeded);
    expect(await move(id, f.date, { start: '11:00', end: '12:00' })).toMatchObject({ success: true });
    expect(await rowOf(id)).toMatchObject({ day: f.date, window_start: '11:00:00', window_end: '12:00:00' });
  });

  test('the block is the later of the window end and the stored length: a long job in a short window is refused', async () => {
    const id = await seed({ estimated_duration_minutes: 150 });
    // 10:00 + 150 minutes ends at 12:30, after the 12:00 shift end, though the window ends at 11:00.
    await expect(move(id, nextDay, { start: '10:00', end: '11:00' })).rejects.toMatchObject(refused);
    expect(await move(id, nextDay, { start: '09:00', end: '10:00' })).toMatchObject({ success: true });
  });

  test('the office\'s own move outside the shift lands: it is not checked here', async () => {
    const id = await seed();
    expect(await move(id, nextDay, { start: '13:00', end: '14:00' }, 'admin', { overlapAdvisory: true })).toMatchObject({ success: true });
    expect(await rowOf(id)).toMatchObject({ day: nextDay, window_start: '13:00:00', window_end: '14:00:00' });
  });

  // A visit group moves each member through reschedule (skipVisitSeam) and may name a technician
  // that call does not see. The group is judged as one unit, so a member is not judged alone here.
  test('a visit group\'s member move is not judged alone here', async () => {
    const id = await seed();
    expect(await move(id, nextDay, { start: '13:00', end: '14:00' }, 'customer', { visitPolicy: 'single', skipVisitSeam: true })).toMatchObject({ success: true });
    expect(await rowOf(id)).toMatchObject({ day: nextDay, window_start: '13:00:00', window_end: '14:00:00' });
  });

  // The move reads the visit before it takes a lock, and the shift check judges that read: its
  // technician and its length. A dispatch edit that lands between the read and the write (here:
  // made on another connection, at the move's own pre-move hook) must not be written over.
  describe('a dispatch edit between the move\'s read and its write', () => {
    const otherShift = (start, end) => f.db('technicians').where({ id: f.ids.otherTech }).update({ shift_start: start, shift_end: end });
    const edit = (id, patch) => ({ beforeMove: async () => { await f.db('scheduled_services').where({ id }).update(patch); } });
    afterEach(() => otherShift(null, null));

    test('a reassignment: the move is refused as a concurrent change, and the visit stays where dispatch left it', async () => {
      // The read technician has no set hours, so 13:00 passes for them. The new one is on shift 08:00 to 12:00.
      await setShift(null, null);
      await otherShift('08:00', '12:00');
      const id = await seed();
      await expect(move(id, nextDay, { start: '13:00', end: '14:00' }, 'customer', edit(id, { technician_id: f.ids.otherTech })))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(await rowOf(id)).toEqual({ ...asSeeded, technician_id: f.ids.otherTech });
    });

    test('a longer job: the move is refused as a concurrent change', async () => {
      const id = await seed();
      // 10:00 to 11:00 fits the 12:00 shift end for the 60 minutes that were read, not for 240.
      await expect(move(id, nextDay, { start: '10:00', end: '11:00' }, 'customer', edit(id, { estimated_duration_minutes: 240 })))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(await rowOf(id)).toEqual(asSeeded);
    });

    test('an unassigned visit has no shift to judge; a technician assigned in between ends the move as a concurrent change', async () => {
      await otherShift('08:00', '12:00');
      const free = await seed({ technician_id: null });
      expect(await move(free, nextDay, { start: '13:00', end: '14:00' })).toMatchObject({ success: true });
      expect(await rowOf(free)).toEqual({ day: nextDay, window_start: '13:00:00', window_end: '14:00:00', technician_id: null });
      const id = await seed({ technician_id: null });
      await expect(move(id, nextDay, { start: '15:00', end: '16:00' }, 'customer', edit(id, { technician_id: f.ids.otherTech })))
        .rejects.toMatchObject({ statusCode: 409 });
      expect(await rowOf(id)).toEqual({ ...asSeeded, technician_id: f.ids.otherTech });
    });

    test('gate off: the same two edits do not stop the move, as before', async () => {
      delete process.env.GATE_TECH_SHIFT_HOURS;
      await otherShift('08:00', '12:00');
      const reassigned = await seed();
      expect(await move(reassigned, nextDay, { start: '13:00', end: '14:00' }, 'customer', edit(reassigned, { technician_id: f.ids.otherTech })))
        .toMatchObject({ success: true });
      expect(await rowOf(reassigned)).toEqual({ day: nextDay, window_start: '13:00:00', window_end: '14:00:00', technician_id: f.ids.otherTech });
      const longer = await seed();
      expect(await move(longer, nextDay, { start: '10:00', end: '11:00' }, 'customer', edit(longer, { estimated_duration_minutes: 240 })))
        .toMatchObject({ success: true });
      expect(await rowOf(longer)).toMatchObject({ day: nextDay, window_start: '10:00:00', window_end: '11:00:00' });
    });
  });

  test('gate off, or a technician without set hours: the same automatic moves land, as before', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    const off = await seed();
    expect(await move(off, nextDay, { start: '13:00', end: '14:00' })).toMatchObject({ success: true });
    expect(await move(off, nextDay, { start: '15:00', end: '16:00' })).toMatchObject({ success: true });

    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    await setShift(null, null);
    const noHours = await seed();
    expect(await move(noHours, nextDay, { start: '17:00', end: '18:00' })).toMatchObject({ success: true });
  });
});
