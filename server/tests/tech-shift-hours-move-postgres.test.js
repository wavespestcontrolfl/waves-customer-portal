/**
 * GATE_TECH_SHIFT_HOURS at a move: the real rebooker over real rows, in a
 * synthetic private schema. The offers keep to each technician's shift
 * (tech-shift-hours-postgres.test.js) and so do the commits
 * (tech-shift-hours-commit-postgres.test.js). These cases move a booked visit
 * and prove an automatic move cannot leave it outside the kept technician's
 * shift, while the office's own move still can.
 */
const { randomUUID } = require('node:crypto');
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

  // On main a same-day, same-technician move asks nothing about the technician. With the gate on it asks
  // about the shift, and only that: the technician's day off (GATE_TECH_WORK_DAYS) still does not refuse it.
  test('a move that changes only the hours is judged on the shift alone: the technician\'s day off does not refuse it', async () => {
    process.env.GATE_TECH_WORK_DAYS = 'true';
    const dayOfWeek = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();
    await f.db('technicians').where({ id: f.ids.technician }).update({ work_days: [dayOfWeek(nextDay)] });
    try {
      const id = await seed();
      expect(await move(id, f.date, { start: '10:00', end: '11:00' })).toMatchObject({ success: true });
      await expect(move(id, f.date, { start: '11:30', end: '12:30' })).rejects.toMatchObject(refused);
      expect(await rowOf(id)).toMatchObject({ day: f.date, window_start: '10:00:00', window_end: '11:00:00' });
      // A move to another day still asks the day's rules: two days on is a day off.
      const twoDaysOn = new Date(Date.parse(`${f.date}T12:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
      await expect(move(id, twoDaysOn, { start: '10:00', end: '11:00' })).rejects.toMatchObject(refused);
      expect(await move(id, nextDay, { start: '10:00', end: '11:00' })).toMatchObject({ success: true });
    } finally {
      delete process.env.GATE_TECH_WORK_DAYS;
      await f.db('technicians').where({ id: f.ids.technician }).update({ work_days: null });
    }
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

  // The rain-out day options keep the visit's technician. The sheet commits the offered start as a
  // one-hour window (probeSpanMinutes: 60; rain-out.js oneHourWindow), so the route check judges one
  // hour, while the move judges the later of that hour and the visit's stored length.
  describe('the rain-out day options (findRescheduleOptions)', () => {
    const rainOptions = (id) => SmartRebooker.findRescheduleOptions(id, 'weather_rain', { probeSpanMinutes: 60 });
    const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    const clock = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    const oneHour = (option) => ({ start: option.suggestedWindow.start, end: clock(minutes(option.suggestedWindow.start) + 60) });

    test('every offered day starts inside the shift and commits as a technician\'s own move', async () => {
      await setShift('10:00', '14:00');
      const id = await seed({ window_start: '11:00', window_end: '12:00' });
      const options = await rainOptions(id);
      expect(options.length).toBeGreaterThan(0);
      for (const option of options) {
        const window = oneHour(option);
        expect(minutes(window.start)).toBeGreaterThanOrEqual(600);
        expect(minutes(window.end)).toBeLessThanOrEqual(840);
        expect(await move(id, option.date, window, 'tech')).toMatchObject({ success: true });
      }
    });

    test('an hour the shift holds for one hour, but not for the visit\'s stored length, is not offered', async () => {
      // On shift 10:00 to 11:30 a 10:00 hour fits. A 120-minute visit there ends at 12:00: the move refuses it.
      await setShift('10:00', '11:30');
      const short = await seed({ window_start: '10:00', window_end: '11:00' });
      const offered = await rainOptions(short);
      expect(offered.length).toBeGreaterThan(0);
      const long = await seed({ window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 120 });
      await expect(move(long, offered[0].date, oneHour(offered[0]), 'tech')).rejects.toMatchObject(refused);
      expect(await rainOptions(long)).toEqual([]);
    });

    // The route-checked list places the visit with its stored length, inside the shift. The day list it
    // replaces (arrival-window routing off, or a day the check could not judge) offers the visit type's
    // fixed morning hour and reads no shift of its own.
    test('route check off: a fixed morning hour before the shift is not offered to a technician\'s rain-out; the office still lists it', async () => {
      const routeCheck = jest.spyOn(require('../services/scheduling/route-ranked-days'), 'routeRankedDaysLive').mockReturnValue(false);
      try {
        await setShift('10:00', '14:00');
        const id = await seed({ window_start: '11:00', window_end: '12:00' });
        const [forOffice] = await SmartRebooker.findRescheduleOptions(id);
        expect(minutes(forOffice.suggestedWindow.start)).toBeLessThan(600);
        // A technician's own move to that hour is refused, so the rain-out sheet is not offered it.
        await expect(move(id, forOffice.date, oneHour(forOffice), 'tech')).rejects.toMatchObject(refused);
        expect(await rainOptions(id)).toEqual([]);
        // The dispatch board's rain-out sheet commits as the office, which may place the visit there.
        const forBoard = await SmartRebooker.findRescheduleOptions(id, 'weather_rain', { probeSpanMinutes: 60, initiatedBy: 'admin' });
        expect(forBoard.map((option) => option.date)).toContain(forOffice.date);
      } finally {
        routeCheck.mockRestore();
      }
    });

    test('gate off: the same long visit is offered days, as before', async () => {
      delete process.env.GATE_TECH_SHIFT_HOURS;
      await setShift('10:00', '11:30');
      const long = await seed({ window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 120 });
      expect((await rainOptions(long)).length).toBeGreaterThan(0);
    });
  });

  // A grouped stop (two or more services at one address) moves as one unit (visit-groups
  // moveVisitAsUnit). The unit is judged before its first write: every member, as the move
  // leaves it. So a stop is never moved in part by a refusal of one member.
  describe('a grouped stop', () => {
    beforeAll(async () => {
      for (const table of ['service_visits', 'visit_effects', 'visit_completion_packets', 'service_completion_attempts', 'service_records', 'invoices']) {
        await f.db.raw('CREATE TABLE ?? (LIKE public.?? INCLUDING ALL)', [table, table]);
      }
    });
    afterEach(async () => { await f.db('service_visits').del(); });
    // Two services at one address, back to back: a 09:00 to 10:00, then b 10:00 to 11:00.
    const seedStop = async (b = {}) => {
      const visitId = randomUUID();
      await f.db('service_visits').insert({ id: visitId, customer_id: f.ids.customer, scheduled_date: f.date, window_start: '09:00', window_end: '11:00',
        stop_base_key: `${f.ids.customer}:${f.date}`, status: 'open', technician_id: f.ids.technician, created_by: 'shift_hours_fixture' });
      const a = f.baseStop({ visit_id: visitId, window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60 });
      const sibling = f.baseStop({ visit_id: visitId, window_start: '10:00', window_end: '11:00', estimated_duration_minutes: 60, ...b });
      await f.db('scheduled_services').insert([a, sibling]);
      return { a: a.id, b: sibling.id, visitId };
    };
    const stopOf = async (stop) => [await rowOf(stop.a), await rowOf(stop.b)];
    const whereSeeded = [
      { day: f.date, window_start: '09:00:00', window_end: '10:00:00' },
      { day: f.date, window_start: '10:00:00', window_end: '11:00:00' },
    ];
    // A technician's own rain-out move of the stop, from the first service.
    const moveStop = (stop, window, by = 'tech') => move(stop.a, nextDay, window, by, { overlapAdvisory: true });

    test('a technician\'s move that leaves the second service after the shift is refused, and neither service moves; one that fits moves both', async () => {
      const stop = await seedStop();
      // The first service fits 11:00 to 12:00. The second follows it and would end at 13:00.
      await expect(moveStop(stop, { start: '11:00', end: '12:00' })).rejects.toMatchObject({ ...refused, memberId: stop.b });
      expect(await stopOf(stop)).toMatchObject(whereSeeded);
      expect(await f.db('service_visits').where({ id: stop.visitId }).first(f.db.raw("to_char(scheduled_date, 'YYYY-MM-DD') as day"))).toMatchObject({ day: f.date });

      const moved = await moveStop(stop, { start: '10:00', end: '11:00' });
      expect(moved.visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
      expect(await stopOf(stop)).toMatchObject([
        { day: nextDay, window_start: '10:00:00', window_end: '11:00:00' },
        { day: nextDay, window_start: '11:00:00', window_end: '12:00:00' },
      ]);
    });

    test('a time sent with seconds: the first service\'s write keeps its stored hours, so those are judged', async () => {
      // The shift starts at 10:00. The rebooker reads a range in minutes only: asked "10:00:00" to "11:00:00", the
      // first service would stay at 09:00 on the new day, before the shift, while the second moved.
      await setShift('10:00', '13:00');
      const stop = await seedStop();
      await expect(moveStop(stop, { start: '10:00:00', end: '11:00:00' })).rejects.toMatchObject({ ...refused, memberId: stop.a });
      expect(await stopOf(stop)).toMatchObject(whereSeeded);
      // The same request in minutes is written as asked.
      expect((await moveStop(stop, { start: '10:00', end: '11:00' })).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
      expect(await stopOf(stop)).toMatchObject([
        { day: nextDay, window_start: '10:00:00', window_end: '11:00:00' },
        { day: nextDay, window_start: '11:00:00', window_end: '12:00:00' },
      ]);
    });

    test('each service is judged with its own stored length', async () => {
      // The second service is a two-hour job in a one-hour window: at 10:00 it ends at 12:00, at 11:00 at 13:00.
      const stop = await seedStop({ estimated_duration_minutes: 120 });
      await expect(moveStop(stop, { start: '10:00', end: '11:00' })).rejects.toMatchObject({ ...refused, memberId: stop.b });
      expect(await stopOf(stop)).toMatchObject(whereSeeded);
      expect((await moveStop(stop, { start: '09:00', end: '10:00' })).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
    });

    test('each service is judged on its own technician', async () => {
      // The second service is another technician's, who stops at 11:00.
      await f.db('technicians').where({ id: f.ids.otherTech }).update({ shift_start: '08:00', shift_end: '11:00' });
      try {
        const stop = await seedStop({ technician_id: f.ids.otherTech });
        await expect(moveStop(stop, { start: '10:00', end: '11:00' })).rejects.toMatchObject({ ...refused, memberId: stop.b });
        expect(await stopOf(stop)).toMatchObject(whereSeeded);
      } finally {
        await f.db('technicians').where({ id: f.ids.otherTech }).update({ shift_start: null, shift_end: null });
      }
    });

    test('the office\'s own move of the stop lands outside the shift: it is not checked here', async () => {
      const stop = await seedStop();
      expect((await moveStop(stop, { start: '11:00', end: '12:00' }, 'admin')).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
      expect(await stopOf(stop)).toMatchObject([
        { day: nextDay, window_start: '11:00:00', window_end: '12:00:00' },
        { day: nextDay, window_start: '12:00:00', window_end: '13:00:00' },
      ]);
    });

    // The tech app's rain-out sheet lists days through findRescheduleOptions. Route check off: the
    // list offers the visit type's fixed morning hour (09:00 here) and reads no shift of its own.
    test('the rain-out day options are not offered an hour the stop\'s move refuses, though the first service alone fits', async () => {
      const routeCheck = jest.spyOn(require('../services/scheduling/route-ranked-days'), 'routeRankedDaysLive').mockReturnValue(false);
      const rainOptions = (id) => SmartRebooker.findRescheduleOptions(id, 'weather_rain', { probeSpanMinutes: 60 });
      try {
        // 09:00 to 10:00 fits a shift that ends at 10:30. The second service would end at 11:00.
        await setShift('08:00', '10:30');
        const stop = await seedStop();
        const [forOffice] = await SmartRebooker.findRescheduleOptions(stop.a, 'weather_rain', { probeSpanMinutes: 60, initiatedBy: 'admin' });
        expect(forOffice.suggestedWindow.start).toBe('09:00');
        await expect(move(stop.a, forOffice.date, { start: '09:00', end: '10:00' }, 'tech', { overlapAdvisory: true })).rejects.toMatchObject({ ...refused, memberId: stop.b });
        expect(await rainOptions(stop.a)).toEqual([]);
        // A shift that holds both services: the same day is offered, and its move lands.
        await setShift('08:00', '11:00');
        const offered = await rainOptions(stop.a);
        expect(offered.map((option) => option.date)).toContain(forOffice.date);
        expect((await move(stop.a, offered[0].date, { start: '09:00', end: '10:00' }, 'tech', { overlapAdvisory: true })).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
      } finally {
        routeCheck.mockRestore();
      }
    });

    // The stop is judged under its lock, and each service then moves in its own write. A dispatch
    // edit that lands in between (here: on another connection, at the first service's pre-move hook)
    // must not be written over: each write pins the technician and the length its verdict used.
    describe('a dispatch edit after the stop was judged', () => {
      const lengthen = (id) => ({ overlapAdvisory: true, beforeMove: async () => { await f.db('scheduled_services').where({ id }).update({ estimated_duration_minutes: 240 }); } });

      test('the first service made longer: the move is refused as a concurrent change, and neither service moves', async () => {
        const stop = await seedStop();
        // 10:00 to 11:00 fits the 12:00 shift end for the 60 minutes that were judged, not for 240.
        await expect(move(stop.a, nextDay, { start: '10:00', end: '11:00' }, 'tech', lengthen(stop.a))).rejects.toMatchObject({ statusCode: 409 });
        expect(await stopOf(stop)).toMatchObject(whereSeeded);
      });

      test('the second service made longer: it does not move, and the move reports it', async () => {
        const stop = await seedStop();
        const out = await move(stop.a, nextDay, { start: '10:00', end: '11:00' }, 'tech', lengthen(stop.b));
        expect(out.visitMove.moved).toEqual([stop.a]);
        expect(out.visitMove.failed.map((x) => x.id)).toEqual([stop.b]);
        expect(await rowOf(stop.b)).toMatchObject(whereSeeded[1]);
      });

      // A caller's own fence drops the plan's fence of the first service. A move of the day alone carries the
      // stored hours to the new day, so the write pins the hours the verdict used all the same. The edit lands
      // after the plan and before the first service's own move reads its row (as the mover calls that move).
      describe('a move of the day alone, with a caller fence', () => {
        let spy = null;
        const editBeforeMemberMove = (id, patch) => {
          const real = SmartRebooker.reschedule;
          let done = false;
          spy = jest.spyOn(SmartRebooker, 'reschedule').mockImplementation(async function wrapped(...args) {
            if (!done && args[0] === id && args[5] && args[5].skipVisitSeam === true) { done = true; await f.db('scheduled_services').where({ id }).update(patch); }
            return real.apply(this, args);
          });
        };
        const dayOnly = (stop) => move(stop.a, nextDay, null, 'tech', { overlapAdvisory: true, expect: { technician_id: f.ids.technician } });
        afterEach(() => { if (spy) { spy.mockRestore(); spy = null; } });

        test('no edit: both services move and keep their hours', async () => {
          const stop = await seedStop();
          expect((await dayOnly(stop)).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
          expect(await stopOf(stop)).toMatchObject([{ day: nextDay, window_start: '09:00:00' }, { day: nextDay, window_start: '10:00:00' }]);
        });

        test('the first service\'s hours changed after the verdict: the move is refused as a concurrent change, and neither service moves', async () => {
          const stop = await seedStop();
          // The verdict was for 09:00 to 10:00. 13:00 to 14:00 is after the 12:00 shift end.
          editBeforeMemberMove(stop.a, { window_start: '13:00', window_end: '14:00' });
          await expect(dayOnly(stop)).rejects.toMatchObject({ statusCode: 409 });
          expect(await rowOf(stop.a)).toMatchObject({ day: f.date, window_start: '13:00:00' });
          expect(await rowOf(stop.b)).toMatchObject(whereSeeded[1]);
        });

        test('gate off: the same edit is carried to the new day, as before', async () => {
          delete process.env.GATE_TECH_SHIFT_HOURS;
          const stop = await seedStop();
          editBeforeMemberMove(stop.a, { window_start: '13:00', window_end: '14:00' });
          await dayOnly(stop).catch(() => null);
          expect(await rowOf(stop.a)).toMatchObject({ day: nextDay, window_start: '13:00:00' });
        });
      });

      // A unit that names a technician moves each service on its old technician, then assigns it in a
      // later write of its own. The edit lands on another connection as that assignment begins: after
      // the service's move, before the step's locks (at its first statement, the date's occupancy lock).
      describe('a unit that names a technician', () => {
        const occupancy = require('../services/scheduling/occupancy');
        let spy = null;
        const editAtAssignment = (id, patch) => {
          const real = occupancy.acquireOccupancyLock;
          let done = false;
          spy = jest.spyOn(occupancy, 'acquireOccupancyLock').mockImplementation(async (...args) => {
            if (!done && (await rowOf(id)).day === nextDay) { done = true; await f.db('scheduled_services').where({ id }).update(patch); }
            return real(...args);
          });
        };
        const lengthenAtAssignment = (id) => editAtAssignment(id, { estimated_duration_minutes: 240 });
        const toOtherTech = (stop) => move(stop.a, nextDay, { start: '10:00', end: '11:00' }, 'auto_dispatch', { overlapAdvisory: true, technicianId: f.ids.otherTech });
        // The fixture's stand-in for the technician cards lacks the "visit moved" card, which a refused assignment sends to the technician who keeps the service.
        beforeAll(() => { require('../services/tech-visit-notifications').notifyVisitRescheduled = jest.fn(); });
        beforeEach(() => f.db('technicians').where({ id: f.ids.otherTech }).update({ shift_start: '08:00', shift_end: '12:00' }));
        afterEach(async () => {
          if (spy) { spy.mockRestore(); spy = null; }
          await f.db('technicians').where({ id: f.ids.otherTech }).update({ shift_start: null, shift_end: null });
        });

        test('no edit: both services move and go to the named technician', async () => {
          const stop = await seedStop();
          expect((await toOtherTech(stop)).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
          expect(await stopOf(stop)).toMatchObject([
            { day: nextDay, window_start: '10:00:00', technician_id: f.ids.otherTech },
            { day: nextDay, window_start: '11:00:00', technician_id: f.ids.otherTech },
          ]);
        });

        test('a service made longer after its move is not assigned to the named technician; the move reports it', async () => {
          const stop = await seedStop();
          // 10:00 for 240 minutes ends at 14:00, after the named technician's 12:00 shift end.
          lengthenAtAssignment(stop.a);
          const out = await toOtherTech(stop);
          expect(out.visitMove.failed).toMatchObject([{ id: stop.a, code: 'SLOT_TAKEN', movedButUnassigned: true }]);
          expect(await stopOf(stop)).toMatchObject([
            { day: nextDay, window_start: '10:00:00', technician_id: f.ids.technician },
            { day: nextDay, window_start: '11:00:00', technician_id: f.ids.otherTech },
          ]);
        });

        test('a service dispatch moved to another hour after its move is not assigned: the plan is stale', async () => {
          const stop = await seedStop();
          // 08:00 to 09:00 fits the named technician's shift, but the verdict and the clash checks were for 10:00.
          editAtAssignment(stop.a, { window_start: '08:00', window_end: '09:00' });
          const out = await toOtherTech(stop);
          expect(out.visitMove.failed).toMatchObject([{ id: stop.a, code: 'ASSIGNMENT_STALE', movedButUnassigned: true }]);
          expect(await stopOf(stop)).toMatchObject([
            { day: nextDay, window_start: '08:00:00', technician_id: f.ids.technician },
            { day: nextDay, window_start: '11:00:00', technician_id: f.ids.otherTech },
          ]);
        });

        test('gate off: the same edits do not stop the assignment, as before', async () => {
          delete process.env.GATE_TECH_SHIFT_HOURS;
          const stop = await seedStop();
          lengthenAtAssignment(stop.a);
          expect((await toOtherTech(stop)).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
          expect(await f.db('scheduled_services').where({ id: stop.a }).first('estimated_duration_minutes')).toMatchObject({ estimated_duration_minutes: 240 });
          spy.mockRestore();
          expect((await stopOf(stop)).map((r) => r.technician_id)).toEqual([f.ids.otherTech, f.ids.otherTech]);
          await f.db('scheduled_services').del();
          await f.db('service_visits').del();
          const second = await seedStop();
          // The moved service is still assigned at this step; the stop's later steps report the stale plan, as before.
          editAtAssignment(second.a, { window_start: '08:00', window_end: '09:00' });
          await toOtherTech(second);
          expect(await rowOf(second.a)).toMatchObject({ day: nextDay, window_start: '08:00:00', technician_id: f.ids.otherTech });
        });
      });

      test('gate off: the same edits do not stop the move, as before', async () => {
        delete process.env.GATE_TECH_SHIFT_HOURS;
        const first = await seedStop();
        expect((await move(first.a, nextDay, { start: '10:00', end: '11:00' }, 'tech', lengthen(first.a))).visitMove).toMatchObject({ moved: [first.a, first.b], failed: [] });
        await f.db('scheduled_services').del();
        await f.db('service_visits').del();
        const second = await seedStop();
        expect((await move(second.a, nextDay, { start: '10:00', end: '11:00' }, 'tech', lengthen(second.b))).visitMove).toMatchObject({ moved: [second.a, second.b], failed: [] });
      });
    });

    test('gate off: the same move of the stop lands, as before', async () => {
      delete process.env.GATE_TECH_SHIFT_HOURS;
      const stop = await seedStop();
      expect((await moveStop(stop, { start: '11:00', end: '12:00' })).visitMove).toMatchObject({ moved: [stop.a, stop.b], failed: [] });
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
