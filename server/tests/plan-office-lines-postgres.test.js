/**
 * GATE_TECH_SHIFT_HOURS (D4 part 3c): the office's Edit save is told about the plan's
 * OTHER visits from the rows it leaves (services/scheduling/plan-office-lines.js), on
 * REAL Postgres rows: the plan query, the savepoint reads on the save's transaction,
 * and the real line readers (technician-eligibility dayWarningsFor).
 *
 * Each test is one save as the module sees it: the rows before, the save's writes
 * (plain UPDATEs and INSERTs here), the lines after. The transaction is rolled back.
 * The Edit save itself is run on real rows in admin-arrival-window-save-db.test.js.
 *
 * Runs in the DB-gated CI step (DATABASE_URL on the migrated waves_test database) or a
 * local scratch Postgres; it skips without one. Fixtures are fictitious. Every row it
 * makes is removed in afterAll.
 */
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { randomUUID } = require('node:crypto');

jest.setTimeout(60000);

// 2031-03-03 is a Monday.
const [MON, TUE, WED, THU, FRI, SAT] = ['2031-03-03', '2031-03-04', '2031-03-05', '2031-03-06', '2031-03-07', '2031-03-08'];
const NEXT_FRI = '2031-03-14';
const MON_THU = [1, 2, 3, 4];

postgres('the plan\'s other visits, told from the rows an Edit save leaves (real Postgres)', () => {
  let db;
  let plan;
  let logger;
  const made = { techIds: [], visitIds: [], customerId: randomUUID() };
  let anyDay; // works every day, no set hours
  let monThu; // works Monday to Thursday, no set hours
  let morning; // works every day, on shift 08:00 to 12:00
  let weekMorning; // works Monday to Thursday, on shift 08:00 to 12:00

  async function makeTech(name, over) {
    const [row] = await db('technicians')
      .insert({ name: `${name} ${randomUUID().slice(0, 8)}`, role: 'technician', employment_status: 'active', field_dispatchable: true, active: true, ...over })
      .returning(['id', 'name']);
    made.techIds.push(row.id);
    return row;
  }

  // One visit, 09:00 to 10:00 for sixty minutes unless `over` says otherwise.
  const visitRow = (over) => ({
    id: randomUUID(), customer_id: made.customerId, service_type: 'Quarterly Pest Control', status: 'pending',
    window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, ...over,
  });
  async function makeVisit(over) {
    const row = visitRow(over);
    await db('scheduled_services').insert(row);
    made.visitIds.push(row.id);
    return row.id;
  }
  // A plan: its first visit on `days[0]` and one more visit on each other day, all on `technician`.
  async function makePlan(technician, days, over = {}) {
    const first = await makeVisit({ scheduled_date: days[0], technician_id: technician.id, is_recurring: true, recurring_pattern: 'weekly', ...over });
    const others = [];
    for (const day of days.slice(1)) {
      others.push(await makeVisit({ scheduled_date: day, technician_id: technician.id, is_recurring: true, recurring_parent_id: first, ...over }));
    }
    return { first, others, all: [first, ...others] };
  }

  // One save of `visitId`: the rows before, `writes` (the save's own), the lines after. Rolled back.
  async function save(visitId, writes) {
    const trx = await db.transaction();
    try {
      const before = await plan.planRowsBefore(trx, visitId);
      await writes(trx);
      return await plan.planOfficeLines(trx, visitId, before);
    } finally {
      await trx.rollback();
    }
  }
  const put = (ids, values) => (trx) => trx('scheduled_services').whereIn('id', [].concat(ids)).update(values);
  const offLine = (tech, days) => `${tech.name} does not work on ${days}.`;
  const shiftLine = (tech) => `${tech.name}'s shift is 8:00 AM to 12:00 PM. This visit is outside those hours.`;

  beforeAll(async () => {
    db = require('../models/db');
    plan = require('../services/scheduling/plan-office-lines');
    logger = require('../services/logger');
    anyDay = await makeTech('Synthetic Anyday', { work_days: null });
    monThu = await makeTech('Synthetic Weekday', { work_days: MON_THU });
    morning = await makeTech('Synthetic Morning', { work_days: null, shift_start: '08:00', shift_end: '12:00' });
    weekMorning = await makeTech('Synthetic Weekmorning', { work_days: MON_THU, shift_start: '08:00', shift_end: '12:00' });
    await db('customers').insert({
      id: made.customerId, first_name: 'Synthetic', last_name: 'Plan', active: true,
      email: `synthetic-plan-${made.customerId}@example.invalid`, phone: `+1941555${String(1000 + Math.floor(Math.random() * 9000))}`,
    });
  });

  beforeEach(() => {
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    process.env.GATE_TECH_WORK_DAYS = 'true';
    logger.warn.mockClear();
  });
  afterEach(() => { delete process.env.GATE_TECH_SHIFT_HOURS; delete process.env.GATE_TECH_WORK_DAYS; });

  afterAll(async () => {
    if (made.visitIds.length) await db('scheduled_services').whereIn('id', made.visitIds).del();
    await db('customers').where({ id: made.customerId }).del();
    if (made.techIds.length) await db('technicians').whereIn('id', made.techIds).del();
    await db.destroy();
  });

  describe('another technician for the plan (the assignment\'s scope)', () => {
    test('the other visit on a day the new technician does not work: the day-off line; the edited visit is left out', async () => {
      const p = await makePlan(anyDay, [MON, THU, FRI]);
      expect(await save(p.first, put(p.all, { technician_id: monThu.id }))).toEqual([offLine(monThu, 'Fridays')]);
      // Edited from the Friday visit: the same writes, and the Friday visit is the save's own to tell.
      expect(await save(p.others[1], put(p.all, { technician_id: monThu.id }))).toEqual([]);
    });

    test('the other visit outside the new technician\'s shift: the shift line; inside it, no line', async () => {
      const p = await makePlan(anyDay, [MON, TUE, THU]);
      await db('scheduled_services').where({ id: p.others[1] }).update({ window_start: '11:30', window_end: '12:30' });
      expect(await save(p.first, put(p.all, { technician_id: morning.id }))).toEqual([shiftLine(morning)]);
      expect(await save(p.first, put([p.first, p.others[0]], { technician_id: morning.id }))).toEqual([]);
    });

    test('the stored length counts: a visit whose hours end inside the shift and whose length ends after it is told', async () => {
      const p = await makePlan(anyDay, [MON, TUE], { window_start: '11:00', window_end: '12:00' });
      await db('scheduled_services').where({ id: p.others[0] }).update({ estimated_duration_minutes: 90 });
      expect(await save(p.first, put(p.all, { technician_id: morning.id }))).toEqual([shiftLine(morning)]);
    });

    test('each line comes back once, whatever the number of visits', async () => {
      const p = await makePlan(anyDay, [MON, FRI, NEXT_FRI, SAT]);
      expect(await save(p.first, put(p.all, { technician_id: monThu.id }))).toEqual([offLine(monThu, 'Fridays'), offLine(monThu, 'Saturdays')]);
      // Two visits outside the shift with two different blocks: one line.
      const q = await makePlan(anyDay, [MON, TUE, WED]);
      await db('scheduled_services').where({ id: q.others[0] }).update({ window_start: '11:30', window_end: '12:30' });
      await db('scheduled_services').where({ id: q.others[1] }).update({ window_start: '13:00', window_end: '14:00' });
      expect(await save(q.first, put(q.all, { technician_id: morning.id }))).toEqual([shiftLine(morning)]);
    });

    test('both gates on, onto a day off and outside the shift: the day-off line alone', async () => {
      const p = await makePlan(anyDay, [MON, FRI], { window_start: '13:00', window_end: '14:00' });
      expect(await save(p.first, put(p.all, { technician_id: weekMorning.id }))).toEqual([offLine(weekMorning, 'Fridays')]);
    });

    test('a visit left with no technician is not asked', async () => {
      const p = await makePlan(monThu, [MON, THU]);
      expect(await save(p.first, put(p.all, { technician_id: null, scheduled_date: FRI }))).toEqual([]);
    });
  });

  describe('another day for the plan\'s visits (the cadence rewrite)', () => {
    test('a visit the save leaves on a day its technician does not work is told; on a day the technician works, it is not', async () => {
      const p = await makePlan(monThu, [MON, TUE, THU]);
      expect(await save(p.first, put(p.others[1], { scheduled_date: FRI }))).toEqual([offLine(monThu, 'Fridays')]);
      expect(await save(p.first, put(p.others[1], { scheduled_date: WED }))).toEqual([]);
    });

    test('the line is about the day the visit has when the save ends, not a day it had on the way', async () => {
      const p = await makePlan(anyDay, [MON, FRI]);
      // The assignment's scope puts the Friday visit on the Monday-to-Thursday technician; the rewrite then moves it to Thursday.
      const writes = async (trx) => {
        await put(p.all, { technician_id: monThu.id })(trx);
        await put(p.others[0], { scheduled_date: THU })(trx);
      };
      expect(await save(p.first, writes)).toEqual([]);
    });

    test('a visit on a new day is asked the shift too, with the hours it has there', async () => {
      const p = await makePlan(morning, [MON, TUE], { window_start: '11:30', window_end: '12:30' });
      // Both visits are outside the shift before the save. The one that gets a new day is told; the one that does not is not.
      expect(await save(p.first, put(p.others[0], { scheduled_date: WED }))).toEqual([shiftLine(morning)]);
      expect(await save(p.first, put(p.others[0], { scheduled_date: WED, window_start: '09:00', window_end: '10:00' }))).toEqual([]);
    });
  });

  describe('a visit that keeps its day and its technician', () => {
    test('new hours outside the shift: the shift line; the same hours: not asked, although the shift does not hold them', async () => {
      const p = await makePlan(morning, [MON, TUE]);
      expect(await save(p.first, put(p.others[0], { window_start: '11:30', window_end: '12:30' }))).toEqual([shiftLine(morning)]);
      await db('scheduled_services').where({ id: p.others[0] }).update({ window_start: '11:30', window_end: '12:30' });
      expect(await save(p.first, put(p.others[0], { notes: 'a save that changes no hour' }))).toEqual([]);
      // An earlier start with the end kept is another block.
      expect(await save(p.first, put(p.others[0], { window_start: '11:00' }))).toEqual([shiftLine(morning)]);
    });

    test('a visit on a new day and a visit with new hours on its own day are two questions, although their hours are the same', async () => {
      // Monday to Thursday, 08:00 to 12:00. `moved` goes to a day off (the day-off line); `kept` stays on
      // its day off and gets new hours (the shift alone: no line). Asked in date order, either one first.
      const run = async ([keptDay, movedTo, days]) => {
        const p = await makePlan(weekMorning, [MON, keptDay, THU]);
        const writes = async (trx) => {
          await put(p.others[0], { window_start: '13:00', window_end: '14:00' })(trx);
          await put(p.others[1], { scheduled_date: movedTo, window_start: '13:00', window_end: '14:00' })(trx);
        };
        expect(await save(p.first, writes)).toEqual([offLine(weekMorning, days)]);
      };
      await run([FRI, SAT, 'Saturdays']);
      await run([SAT, FRI, 'Fridays']);
    });

    test('a longer stored length alone is a new block', async () => {
      const p = await makePlan(morning, [MON, TUE], { window_start: '11:00', window_end: '12:00' });
      expect(await save(p.first, put(p.others[0], { estimated_duration_minutes: 90 }))).toEqual([shiftLine(morning)]);
    });

    test('the block is the hours and the stored length: an end the save derives from the length is no change', async () => {
      const p = await makePlan(morning, [MON, TUE], { window_start: '11:30', window_end: null });
      expect(await save(p.first, put(p.others[0], { window_end: '12:30' }))).toEqual([]);
      expect(await save(p.first, put(p.others[0], { window_end: '13:00' }))).toEqual([shiftLine(morning)]);
    });

    test('it is asked the shift alone: new hours on a day the technician does not work give no line', async () => {
      const p = await makePlan(weekMorning, [MON, FRI]);
      expect(await save(p.first, put(p.others[0], { window_start: '13:00', window_end: '14:00' }))).toEqual([]);
    });
  });

  describe('which visits are the plan\'s', () => {
    test('a visit the save adds is told', async () => {
      const p = await makePlan(monThu, [MON, THU]);
      const added = visitRow({ scheduled_date: FRI, technician_id: monThu.id, is_recurring: true, recurring_parent_id: p.first });
      expect(await save(p.first, (trx) => trx('scheduled_services').insert(added))).toEqual([offLine(monThu, 'Fridays')]);
      // A one-time visit the save makes the first of a plan: the visits it adds name it as their plan.
      const single = await makeVisit({ scheduled_date: MON, technician_id: monThu.id });
      const child = visitRow({ scheduled_date: SAT, technician_id: monThu.id, is_recurring: true, recurring_parent_id: single });
      expect(await save(single, (trx) => trx('scheduled_services').insert(child))).toEqual([offLine(monThu, 'Saturdays')]);
    });

    test('edited from a later visit: the plan\'s first visit and the other later ones are the others', async () => {
      const p = await makePlan(anyDay, [FRI, MON, SAT]);
      expect(await save(p.others[0], put(p.all, { technician_id: monThu.id }))).toEqual([offLine(monThu, 'Fridays'), offLine(monThu, 'Saturdays')]);
    });

    test('a closed visit, and a visit the save closes, are not asked', async () => {
      const p = await makePlan(anyDay, [MON, FRI, SAT]);
      await db('scheduled_services').where({ id: p.others[0] }).update({ status: 'completed' });
      const writes = async (trx) => {
        await put(p.all, { technician_id: monThu.id })(trx);
        await put(p.others[1], { status: 'cancelled' })(trx);
      };
      expect(await save(p.first, writes)).toEqual([]);
    });

    test('another plan of the same customer, and a one-time visit, are not the plan\'s', async () => {
      const p = await makePlan(anyDay, [MON, THU]);
      const other = await makePlan(anyDay, [MON, FRI]);
      const single = await makeVisit({ scheduled_date: FRI, technician_id: anyDay.id });
      expect(await save(p.first, put([...p.all, ...other.all, single], { technician_id: monThu.id }))).toEqual([]);
      // A one-time visit has no other visit: its own change is the save's to tell.
      expect(await save(single, put(single, { technician_id: monThu.id }))).toEqual([]);
    });
  });

  describe('only the rows this save wrote', () => {
    // The statements one run sends, as text.
    const sent = async (run) => {
      const seen = [];
      const listener = (query) => seen.push(query.sql);
      db.on('query', listener);
      try {
        return { out: await run(), asked: seen.filter((sql) => /pg_xact_status/.test(sql)).length };
      } finally {
        db.removeListener('query', listener);
      }
    };
    // Another writer, on its own connection: its change is committed while the save's transaction is open.
    const otherWriter = (id, values) => db('scheduled_services').where({ id }).update(values);

    test('a change another writer commits during the save is not this save\'s: no line for it', async () => {
      // Monday to Thursday. Another writer puts one visit on a Friday; this save puts another on a Saturday.
      const p = await makePlan(monThu, [MON, TUE, WED]);
      const writes = async (trx) => {
        await otherWriter(p.others[0], { scheduled_date: FRI });
        await put(p.others[1], { scheduled_date: SAT })(trx);
      };
      expect(await save(p.first, writes)).toEqual([offLine(monThu, 'Saturdays')]);
      // The other writer's change alone, in a save that writes only the visit it edits: no line.
      const notesOnly = async (trx) => {
        await put(p.first, { notes: 'a notes-only save' })(trx);
        await otherWriter(p.others[1], { scheduled_date: FRI, technician_id: weekMorning.id, window_start: '13:00', window_end: '14:00' });
      };
      expect(await save(p.first, notesOnly)).toEqual([]);
    });

    test('a write the save makes inside a savepoint is this save\'s', async () => {
      const p = await makePlan(monThu, [MON, TUE, WED]);
      const writes = (trx) => trx.transaction(async (inner) => {
        await put(p.others[0], { scheduled_date: FRI })(inner);
        const added = visitRow({ scheduled_date: SAT, technician_id: monThu.id, is_recurring: true, recurring_parent_id: p.first });
        await inner('scheduled_services').insert(added);
      });
      expect(await save(p.first, writes)).toEqual([offLine(monThu, 'Fridays'), offLine(monThu, 'Saturdays')]);
    });

    test('who wrote the rows is asked once, and only when a visit is not as it was', async () => {
      const p = await makePlan(monThu, [MON, TUE]);
      expect(await sent(() => save(p.first, put(p.first, { scheduled_date: FRI })))).toEqual({ out: [], asked: 0 });
      expect(await sent(() => save(p.first, put(p.all, { scheduled_date: FRI })))).toEqual({ out: [offLine(monThu, 'Fridays')], asked: 1 });
    });
  });

  describe('gate off, and a read that fails', () => {
    const counted = async (run) => {
      const seen = [];
      const listener = (query) => seen.push(query.sql);
      db.on('query', listener);
      try {
        // Every statement counts: a savepoint for a read that is then not sent is a statement too.
        return { out: await run(), reads: seen.length };
      } finally {
        db.removeListener('query', listener);
      }
    };

    test('GATE_TECH_SHIFT_HOURS off: no statement is sent and no line comes back, with the work-days gate on', async () => {
      const p = await makePlan(anyDay, [MON, FRI]);
      delete process.env.GATE_TECH_SHIFT_HOURS;
      const trx = await db.transaction();
      try {
        const { out: before, reads } = await counted(() => plan.planRowsBefore(trx, p.first));
        expect({ before, reads }).toEqual({ before: null, reads: 0 });
        await put(p.all, { technician_id: monThu.id })(trx);
        expect(await counted(() => plan.planOfficeLines(trx, p.first, before))).toEqual({ out: [], reads: 0 });
        expect(logger.warn).not.toHaveBeenCalled();
      } finally {
        await trx.rollback();
      }
    });

    test('gate on: the two reads see the rows through the save\'s transaction', async () => {
      const p = await makePlan(anyDay, [MON, FRI]);
      const trx = await db.transaction();
      try {
        const before = await plan.planRowsBefore(trx, p.first);
        expect([...before.rows.keys()].sort()).toEqual(p.all.map(String).sort());
        expect(before.rows.get(p.others[0])).toMatchObject({ day: FRI, technician_id: anyDay.id });
        await put(p.all, { technician_id: monThu.id })(trx);
        // Another connection does not see the uncommitted writes; the save's own read does.
        expect((await db('scheduled_services').where({ id: p.others[0] }).first('technician_id')).technician_id).toBe(anyDay.id);
        expect(await plan.planOfficeLines(trx, p.first, before)).toEqual([offLine(monThu, 'Fridays')]);
      } finally {
        await trx.rollback();
      }
    });

    test('a read that fails is logged, gives no line, and leaves the save\'s transaction usable', async () => {
      const p = await makePlan(anyDay, [MON, FRI]);
      const trx = await db.transaction();
      try {
        // No such id can be read: PostgreSQL refuses the text as a uuid.
        expect(await plan.planRowsBefore(trx, 'not-a-visit-id')).toBeNull();
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rows before the save were not read'));
        expect(await plan.planOfficeLines(trx, p.first, null)).toEqual([]);
        expect(await plan.planOfficeLines(trx, p.first, { planIds: ['not-a-visit-id'], rows: new Map() })).toEqual([]);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('rows after the save were not read'));
        // The transaction still writes and reads.
        await put(p.first, { notes: 'still usable' })(trx);
        expect((await trx('scheduled_services').where({ id: p.first }).first('notes')).notes).toBe('still usable');
        // A visit that is gone: no plan to read.
        expect(await plan.planRowsBefore(trx, randomUUID())).toBeNull();
      } finally {
        await trx.rollback();
      }
    });
  });
});
