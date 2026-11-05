/**
 * The day-60 second handover run (second-tech-handover.js --weekend-move) on real PostgreSQL: weekend customers move to the
 * hire, their visits on the hire's days off move to the nearest work day, month-based series are re-anchored so the series'
 * own top-up (admin-schedule extendSeriesOnceLocked) keeps the new weekday, nothing is sent, and the rollback file (version 2)
 * puts back dates, technician and the parents' anchors. Synthetic rows only, removed afterwards. 2099-07-11 is a Saturday.
 *
 * DB-gated: skips without DATABASE_URL, runs in CI against the migrated database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(120000);
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
// The test database may carry weekly days off (Saturday / Sunday) in system_settings; this suite is about the series dates.
jest.mock('../services/scheduling/blackout-dates', () => ({
  ...jest.requireActual('../services/scheduling/blackout-dates'),
  getBlackoutLayers: async () => ({ dates: new Set(), weeklyDaysOff: new Set(), closedHolidays: new Set() }),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({
  ...jest.requireActual('../services/appointment-reminders'),
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyTechVisitChange: async () => {}, notifyAssignmentChange: () => null,
}));

let mockPg;

describeDb('second-tech-handover --weekend-move on PostgreSQL', () => {
  let knex;
  let handover;
  let exec;
  let Admin;
  let outDir;
  let catalogId;
  const run = randomUUID().slice(0, 8);
  const START = '2099-07-06';
  const TODAY = '2099-06-30';
  const NOW = new Date('2099-07-01T16:00:00Z');
  const created = { techs: [], customers: [], plans: [] };
  let priorGate;

  const tech = (id, extra = {}) => ({
    id, name: `Synthetic ${run} ${id.slice(0, 4)}`, email: `${id}@example.invalid`, password_hash: 'synthetic-not-a-login-hash',
    role: 'technician', active: true, employment_status: 'active', field_dispatchable: true, ...extra,
  });
  const makeTech = async (extra) => {
    const id = randomUUID();
    await knex('technicians').insert(tech(id, extra));
    created.techs.push(id);
    return id;
  };
  const customer = async () => {
    const customerId = randomUUID();
    const propertyId = randomUUID();
    await knex('customers').insert({
      id: customerId, first_name: `Syn${run}`, last_name: 'Weekend', email: `${customerId}@example.invalid`, phone: '+19415550177', active: true,
      property_type: 'residential', address_line1: '400 Example Court', city: 'Parrish', state: 'FL', zip: '34219', pipeline_stage: 'active_customer',
    });
    await knex('customer_properties').insert({
      id: propertyId, customer_id: customerId, is_primary: true, active: true,
      address_line1: '400 Example Court', city: 'Parrish', state: 'FL', zip: '34219', source: 'estimate_accept',
    });
    created.customers.push(customerId);
    return { customerId, propertyId };
  };
  const base = (c, ownerId, o) => ({
    customer_id: c.customerId, property_id: c.propertyId, technician_id: ownerId, service_id: catalogId, service_type: 'Quarterly Pest Control Service',
    service_key_snapshot: 'pest_general_quarterly', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, estimated_price: 120,
    recurring_pattern: 'quarterly', is_recurring: true, recurring_ongoing: true, skip_weekends: false, ...o,
  });
  // A quarterly series: a finished first visit on Saturday 2099-04-04 (o.parentDate: another day) and three pending Saturdays.
  async function weekendSeries(ownerId, c, o = {}) {
    const [parent] = await knex('scheduled_services').insert(base(c, ownerId, { scheduled_date: o.parentDate || '2099-04-04', status: 'completed' })).returning('*');
    const kids = [];
    for (const date of o.dates || ['2099-07-11', '2099-10-10', '2100-01-09']) {
      const [k] = await knex('scheduled_services').insert(base(c, ownerId, { scheduled_date: date, status: 'pending', recurring_parent_id: parent.id, route_order: 7, ...(o.kidExtra || {}) })).returning('*');
      kids.push(k);
    }
    return { parent, kids };
  }
  // A weekly series with no visit ahead: only its finished first visit, on `date` (before TODAY).
  const pastWeekly = (ownerId, c, date) => knex('scheduled_services').insert(base(c, ownerId, { scheduled_date: date, status: 'completed', recurring_pattern: 'weekly' }));
  const get = (id) => knex('scheduled_services').where({ id }).first();
  const day = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10));
  const dow = (d) => new Date(`${day(d)}T12:00:00Z`).getUTCDay();
  const args = (w, o = {}) => ({ from: w.ownerId, to: w.hireId, start: START, today: TODAY, now: NOW, weekendMove: true, ...o });
  const plan = (w, o) => handover.planHandover(knex, args(w, o));
  const execute = async (w, p, o = {}) => {
    created.plans.push(p.planId);
    return exec.executeHandover(knex, { ...args(w), planId: p.planId, outDir, refresh: jest.fn().mockResolvedValue({ status: 'refreshed' }), ...o });
  };
  const world = async () => ({ ownerId: await makeTech(), hireId: await makeTech({ work_days: [1, 2, 3, 4] }) });
  const extend = async (parentId) => {
    const trx = await mockPg.transaction();
    try {
      const cols = await trx('scheduled_services').columnInfo();
      const parent = await trx('scheduled_services').where({ id: parentId }).first();
      const spawned = await Admin._test.extendSeriesOnceLocked(trx, parent, parentId, cols, parent);
      return spawned && spawned.scheduledDate;
    } finally { await trx.rollback(); }
  };

  beforeAll(async () => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a disposable CI or private QA database');
    mockPg = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 6 } });
    knex = mockPg;
    handover = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover.js'));
    exec = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover-execute.js'));
    Admin = require('../routes/admin-schedule');
    // The day-60 run happens with two technicians: the occupancy probe counts only the hire's own rows (GATE_MULTI_TECH_CONFIRM).
    priorGate = process.env.GATE_MULTI_TECH_CONFIRM;
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), `handover-wk-${run}-`));
    catalogId = (await knex('services').where({ service_key: 'pest_general_quarterly' }).first('id')).id;
  });

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM; else process.env.GATE_MULTI_TECH_CONFIRM = priorGate;
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
    if (!knex) return;
    await knex('audit_log').whereIn('action', ['schedule.handover.execute', 'schedule.handover.rollback']).whereRaw("metadata->>'plan_id' = ANY(?)", [created.plans]).del();
    await knex('tech_notifications').whereIn('technician_id', created.techs).del();
    if (created.customers.length) {
      await knex('appointment_reminders').whereIn('customer_id', created.customers).del();
      await knex('scheduled_services').whereIn('customer_id', created.customers).update({ visit_id: null });
      await knex('scheduled_services').whereIn('customer_id', created.customers).del();
      await knex('customer_properties').whereIn('customer_id', created.customers).del();
      await knex('property_preferences').whereIn('customer_id', created.customers).del();
      await knex('customers').whereIn('id', created.customers).del();
    }
    await knex('technician_absences').whereIn('technician_id', created.techs).del();
    await knex('technicians').whereIn('id', created.techs).del();
    await knex.destroy();
  });

  test('a Saturday quarterly series moves to Thursday, is re-anchored, sends nothing, and its next top-up child lands on a Thursday', async () => {
    const w = await world();
    const c = await customer();
    const s = await weekendSeries(w.ownerId, c);
    // The control: an identical untouched series grows its next child on the parent's Saturday (why the move needs the re-anchor).
    const controlOwner = await makeTech();
    const control = await weekendSeries(controlOwner, await customer());
    expect(dow(await extend(control.parent.id))).toBe(6);
    // A reminder row for the first visit: the trigger moves it, nothing sends.
    await knex('appointment_reminders').insert({ scheduled_service_id: s.kids[0].id, customer_id: c.customerId, appointment_time: '2099-07-11T13:00:00Z', source: 'test' });
    const smsBefore = (await knex('sms_log').where({ customer_id: c.customerId }).count('* as n').first()).n;
    const emailsBefore = (await knex('emails').where({ customer_id: c.customerId }).count('* as n').first()).n;
    const cardsBefore = (await knex('tech_notifications').where({ technician_id: w.hireId }).count('* as n').first()).n;

    const p = await plan(w);
    expect(p.date_changes).toMatchObject({ visits: 3, customers: 1, by_change: { 'Sat -> Thu': 3 } });
    expect(p.ids.anchors).toEqual([expect.objectContaining({ series_id: s.parent.id, nth: 2, weekday: 4 })]);
    expect(p.ids.kept).toEqual([]);
    const result = await execute(w, p);
    expect(result).toMatchObject({ series: 1, visits: 3, customers: 1, dayChanges: 3, anchors: 1, cardSent: true });

    // Dates (the 2nd Thursdays), technician, route number cleared; window and status kept; never a date exception.
    expect((await Promise.all(s.kids.map(async (k) => day((await get(k.id)).scheduled_date))))).toEqual(['2099-07-09', '2099-10-08', '2100-01-14']);
    for (const k of s.kids) {
      const row = await get(k.id);
      expect(row).toMatchObject({ technician_id: w.hireId, route_order: null, status: 'pending', date_exception: false });
      expect(String(row.window_start).slice(0, 5)).toBe('09:00');
      expect(String(row.window_end).slice(0, 5)).toBe('10:00');
      expect(row.recurring_dispatch_due_date).toBeNull();
    }
    expect(await get(s.parent.id)).toMatchObject({ recurring_technician_id: w.hireId, recurring_technician_override: true, recurring_nth: 2, recurring_weekday: 4 });

    // Top-up through the real extension path: the next child is a Thursday.
    const next = await extend(s.parent.id);
    expect(dow(next)).toBe(4);
    expect(next > '2100-01-14').toBe(true);

    // Sends nothing: the reminder follows the new day, armed and unsent; no text, no email; one card to the hire.
    const reminder = await knex('appointment_reminders').where({ scheduled_service_id: s.kids[0].id }).first();
    expect(reminder.appointment_time.toISOString()).toBe('2099-07-09T13:00:00.000Z');
    expect(reminder).toMatchObject({ reminder_72h_sent: false, reminder_24h_sent: false, confirmation_sent: false });
    expect((await knex('sms_log').where({ customer_id: c.customerId }).count('* as n').first()).n).toBe(smsBefore);
    expect((await knex('emails').where({ customer_id: c.customerId }).count('* as n').first()).n).toBe(emailsBefore);
    const cards = await knex('tech_notifications').where({ technician_id: w.hireId }).orderBy('created_at', 'desc');
    expect(Number(cards.length) - Number(cardsBefore)).toBe(1);
    expect(cards[0].message).toBe('You now have 3 visits across 1 customer. They are on your schedule. 3 visits changed day.');
    expect(await knex('tech_notifications').whereIn('technician_id', [w.hireId, w.ownerId]).whereIn('type', ['visit_assigned', 'visit_unassigned']).count('* as n').first()).toMatchObject({ n: '0' });

    // Rollback (version 2) puts dates, technician, route number and the parent's anchor back.
    const file = JSON.parse(fs.readFileSync(result.rollbackFile, 'utf8'));
    expect(file.version).toBe(2);
    expect(file.anchors).toHaveLength(1);
    expect(file.visits.find((v) => v.id === s.kids[0].id)).toMatchObject({ date: '2099-07-11', to_date: '2099-07-09', route_order: 7 });
    const undo = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: NOW, refresh: jest.fn().mockResolvedValue({ status: 'refreshed' }) });
    expect(undo).toMatchObject({ seriesRestored: 1, visitsRestored: 3, skipped: { visits: [], anchors: [] } });
    expect((await Promise.all(s.kids.map(async (k) => day((await get(k.id)).scheduled_date))))).toEqual(['2099-07-11', '2099-10-10', '2100-01-09']);
    expect(await get(s.kids[0].id)).toMatchObject({ technician_id: w.ownerId, route_order: 7 });
    expect(await get(s.parent.id)).toMatchObject({ recurring_nth: null, recurring_weekday: null, recurring_technician_override: false });
    expect(dow(await extend(s.parent.id))).toBe(6);
  });

  test('rollback keeps the new anchor while a moved visit could not be put back', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer());
    const p = await plan(w);
    const result = await execute(w, p);
    // The hire hands one moved visit to someone else: it cannot be restored, so the anchor that keeps the series on cadence stays.
    const third = await makeTech();
    await knex('scheduled_services').where({ id: s.kids[1].id }).update({ technician_id: third });
    const undo = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: NOW, refresh: jest.fn() });
    expect(undo.skipped).toMatchObject({ visits: [s.kids[1].id], anchors: [s.parent.id] });
    expect(await get(s.parent.id)).toMatchObject({ recurring_nth: 2, recurring_weekday: 4 });
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-11');
  });

  test('rollback puts a day back only when it is still safe: a booking in the freed window, a confirmation or a lock keeps the visit with the hire', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer());
    const result = await execute(w, await plan(w));
    // The owner booked the freed Saturday hour (another customer, held by --from); the customer confirmed the second new day;
    // staff locked the third.
    await knex('scheduled_services').insert(base(await customer(), w.ownerId, { scheduled_date: '2099-07-11', status: 'confirmed', recurring_pattern: null, is_recurring: false }));
    await knex('scheduled_services').where({ id: s.kids[1].id }).update({ customer_confirmed: true });
    await knex('scheduled_services').where({ id: s.kids[2].id }).update({ auto_dispatch_locked: true });
    const undo = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: NOW, refresh: jest.fn() });
    expect(undo.visitsRestored).toBe(0);
    expect(new Set(undo.skipped.visits)).toEqual(new Set(s.kids.map((k) => k.id)));
    expect(undo.skipped.anchors).toEqual([s.parent.id]);
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-09');
    expect(await get(s.kids[0].id)).toMatchObject({ technician_id: w.hireId });
  });

  test('rollback keeps the new anchor when the series\' top-up has created a child since the run', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer());
    const result = await execute(w, await plan(w));
    // The nightly top-up commits the next child on the new Thursday cadence.
    const trx = await mockPg.transaction();
    const cols = await trx('scheduled_services').columnInfo();
    const parent = await trx('scheduled_services').where({ id: s.parent.id }).first();
    const spawned = await Admin._test.extendSeriesOnceLocked(trx, parent, s.parent.id, cols, parent);
    await trx.commit();
    expect(dow(spawned.scheduledDate)).toBe(4);
    const undo = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: NOW, refresh: jest.fn() });
    expect(undo.visitsRestored).toBe(3);
    expect(undo.skipped.anchors).toEqual([s.parent.id]);
    expect(await get(s.parent.id)).toMatchObject({ recurring_nth: 2, recurring_weekday: 4 });
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-11');
  });

  test('rollback leaves a date move alone while the visit\'s current day is inside the freeze, with or without a reminder row', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    const result = await execute(w, await plan(w));
    // 2099-07-07 12:00Z: the old Saturday (07-11) is 4 days out, but Thursday 07-09 09:00 is 49 hours out. No reminder row exists.
    const early = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: new Date('2099-07-07T12:00:00Z'), refresh: jest.fn() });
    expect(early.visitsRestored).toBe(0);
    expect(early.skipped.visits).toEqual([s.kids[0].id]);
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-09');
  });

  test('rollback leaves a date move alone once the old day is inside the freeze margin', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    const result = await execute(w, await plan(w));
    // Thursday 07-09 is still ahead, but the Saturday it came from (07-11) is inside the 4-day margin from 07-08.
    const late = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: new Date('2099-07-08T16:00:00Z'), refresh: jest.fn() });
    expect(late.visitsRestored).toBe(0);
    expect(late.skipped.visits).toEqual([s.kids[0].id]);
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-09');
  });

  test('rollback keeps a date exception or a pending reschedule request recorded since the run', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer());
    const result = await execute(w, await plan(w));
    await knex('scheduled_services').where({ id: s.kids[1].id }).update({ date_exception: true });
    await knex('scheduled_services').where({ id: s.kids[2].id }).update({ status: 'rescheduled' });
    const undo = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: NOW, refresh: jest.fn() });
    expect(undo.visitsRestored).toBe(1);
    expect(new Set(undo.skipped.visits)).toEqual(new Set([s.kids[1].id, s.kids[2].id]));
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-11');
    expect(day((await get(s.kids[1].id)).scheduled_date)).toBe('2099-10-08');
  });

  test('a confirmation or lock that lands after the plan was read stops the run: the plan is re-read under the locks', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    const p = await plan(w);
    await knex('scheduled_services').where({ id: s.kids[0].id }).update({ customer_confirmed: true });
    created.plans.push(p.planId);
    await expect(exec.executeHandover(knex, { ...args(w), planId: p.planId, outDir, refresh: jest.fn() })).rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-11');
  });

  test('a customer stays whole when the hire is out on the only legal days, or a visit is confirmed; nothing of theirs changes', async () => {
    const w = await world();
    const out = await weekendSeries(w.ownerId, await customer());
    // Absent on every legal candidate day for the first visit.
    for (const date of ['2099-07-06', '2099-07-07', '2099-07-08', '2099-07-09', '2099-07-13', '2099-07-14', '2099-07-15', '2099-07-16']) {
      await knex('technician_absences').insert({ technician_id: w.hireId, absence_date: date, reason: 'synthetic' });
    }
    // A later Saturday (the absences above do not reach its candidate days) whose visit the customer confirmed.
    const confirmed = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-25'] });
    await knex('scheduled_services').where({ id: confirmed.kids[0].id }).update({ customer_confirmed: true });
    const p = await plan(w);
    expect(new Map(p.ids.kept.map((k) => [k.customer_id, k.reason])).size).toBe(2);
    expect(p.ids.retemplate).toEqual([]);
    expect(p.date_changes.visits).toBe(0);
    const reasons = Object.keys(p.skipped).filter((r) => r.startsWith('weekend_kept_')).sort();
    expect(reasons).toEqual(['weekend_kept_absence', 'weekend_kept_held']);
    expect(p.skipped.off_day_customer).toBeUndefined();
    await execute(w, p, {}).catch(() => {});
    for (const k of [...out.kids, ...confirmed.kids]) expect(await get(k.id)).toMatchObject({ technician_id: w.ownerId });
  });

  test("a customer's preferred day (a Friday, a day off) and a busy hour keep the customer whole; a reminder already sent too", async () => {
    const w = await world();
    const pref = await customer();
    await weekendSeries(w.ownerId, pref);
    // The portal only offers Monday-Friday: a Friday preference is a day off for the hire, so no clean move exists.
    await knex('property_preferences').insert({ customer_id: pref.customerId, preferred_day: 'friday' });
    // A Monday preference is a work day: the move goes to Monday, not to the nearer Thursday.
    const monday = await customer();
    const mondaySeries = await weekendSeries(w.ownerId, monday, { dates: ['2099-07-11'] });
    await knex('property_preferences').insert({ customer_id: monday.customerId, preferred_day: 'monday' });
    const sent = await customer();
    const sentSeries = await weekendSeries(w.ownerId, sent, { dates: ['2099-07-18'] });
    await knex('appointment_reminders').insert({ scheduled_service_id: sentSeries.kids[0].id, customer_id: sent.customerId, appointment_time: '2099-07-18T13:00:00Z', reminder_72h_sent: true, source: 'test' });
    const p = await plan(w);
    const kept = new Map(p.ids.kept.map((k) => [k.customer_id, k.reason]));
    expect(kept.get(pref.customerId)).toBe('preferred_day');
    expect(kept.get(sent.customerId)).toBe('reminder_sent');
    expect(kept.has(monday.customerId)).toBe(false);
    expect(p.ids.moves.find((m) => m.visit_id === mondaySeries.kids[0].id).to_date).toBe('2099-07-13');
  });

  test('a weekend customer that stays whole gives back its weekday hour: the next customer may take it', async () => {
    const w = await world();
    // K stays whole (a reminder already went out for its Saturday), so its Thursday 09:00 visit stays with the owner.
    const k = await customer();
    const kSat = await weekendSeries(w.ownerId, k, { dates: ['2099-07-18'] });
    await knex('appointment_reminders').insert({ scheduled_service_id: kSat.kids[0].id, customer_id: k.customerId, appointment_time: '2099-07-18T13:00:00Z', reminder_72h_sent: true, source: 'test' });
    const kThu = await weekendSeries(w.ownerId, k, { dates: ['2099-07-09'], parentDate: '2099-04-09' }); // a Thursday series
    // A's Saturday 07-11 09:00: Thursday 07-09 is the nearest work day, and K's Thursday visit no longer holds that hour.
    const a = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    const p = await plan(w);
    expect(p.ids.kept).toEqual([{ customer_id: k.customerId, reason: 'reminder_sent' }]);
    expect(p.ids.moves.find((m) => m.visit_id === a.kids[0].id).to_date).toBe('2099-07-09');
    expect(p.ids.moves.some((m) => m.visit_id === kThu.kids[0].id)).toBe(false); // K's Thursday stays with the owner
  });

  test('a series that walks a Saturday keeps its weekend customer whole, though its visits sit on weekdays; so does a past Saturday base', async () => {
    const w = await world();
    const pm = { kidExtra: { window_start: '13:00', window_end: '14:00' } };
    // A: a Saturday series to re-date, and a quarterly series with one Thursday visit whose parent walks Saturdays (its own date,
    // no stored weekday): top-up would grow the hire's next visit of it on a Saturday.
    const a = await customer();
    const aSat = await weekendSeries(w.ownerId, a, { dates: ['2099-07-11'] });
    const aThu = await weekendSeries(w.ownerId, a, { dates: ['2099-07-16'], ...pm });
    // B: a Saturday series, and a weekly series with no visit ahead whose latest row is a finished Saturday (06-27).
    const b = await customer();
    const bSat = await weekendSeries(w.ownerId, b, { dates: ['2099-07-18'] });
    await pastWeekly(w.ownerId, b, '2099-06-27');
    // The controls: C as A with a parent that walks Thursdays (04-09), D as B with a finished Thursday (06-25).
    const c = await customer();
    const cSat = await weekendSeries(w.ownerId, c, { dates: ['2099-07-25'] });
    await weekendSeries(w.ownerId, c, { dates: ['2099-07-30'], parentDate: '2099-04-09', ...pm });
    const d = await customer();
    const dSat = await weekendSeries(w.ownerId, d, { dates: ['2099-08-01'] });
    await pastWeekly(w.ownerId, d, '2099-06-25');
    const p = await plan(w);
    expect(p.ids.kept).toHaveLength(2);
    expect(p.ids.kept).toEqual(expect.arrayContaining([
      { customer_id: a.customerId, reason: 'top_up_day_off' }, { customer_id: b.customerId, reason: 'top_up_day_off' },
    ]));
    expect(p.skipped.weekend_kept_top_up_day_off.customers).toBe(2);
    for (const s of [aSat, aThu, bSat]) expect(p.ids.moves.some((m) => m.visit_id === s.kids[0].id)).toBe(false);
    expect(p.ids.moves.find((m) => m.visit_id === cSat.kids[0].id).to_date).toBe('2099-07-23');
    expect(p.ids.moves.find((m) => m.visit_id === dSat.kids[0].id).to_date).toBe('2099-07-30');
  });

  test('a busy hour keeps the customer whole: the hire already holds 09:00 on every legal day', async () => {
    const w = await world();
    const c = await customer();
    await weekendSeries(w.ownerId, c, { dates: ['2099-07-11'] });
    const other = await customer();
    for (const date of ['2099-07-06', '2099-07-07', '2099-07-08', '2099-07-09', '2099-07-13', '2099-07-14', '2099-07-15', '2099-07-16']) {
      await knex('scheduled_services').insert(base(other, w.hireId, { scheduled_date: date, status: 'confirmed', recurring_pattern: null, is_recurring: false }));
    }
    const p = await plan(w);
    expect(p.ids.kept).toEqual([{ customer_id: c.customerId, reason: 'busy' }]);
    expect(p.ids.retemplate).toEqual([]);
  });

  test('a visit with a start but no end still meets the occupancy probe: the hire\'s 09:30 visit blocks a 09:00 start with a 60-minute duration', async () => {
    const w = await world();
    const c = await customer();
    await weekendSeries(w.ownerId, c, { dates: ['2099-07-11'], kidExtra: { window_end: null } });
    const other = await customer();
    for (const date of ['2099-07-06', '2099-07-07', '2099-07-08', '2099-07-09', '2099-07-13', '2099-07-14', '2099-07-15', '2099-07-16']) {
      await knex('scheduled_services').insert(base(other, w.hireId, { scheduled_date: date, status: 'confirmed', recurring_pattern: null, is_recurring: false, window_start: '09:30', window_end: '10:30' }));
    }
    expect((await plan(w)).ids.kept).toEqual([{ customer_id: c.customerId, reason: 'busy' }]);
  });

  test('two weekend customers on one hour do not land on the same day and hour; --start under 4 days out is refused', async () => {
    const w = await world();
    const a = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    const b = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    const p = await plan(w);
    const dates = [a.kids[0].id, b.kids[0].id].map((id) => p.ids.moves.find((m) => m.visit_id === id).to_date);
    expect(new Set(dates).size).toBe(2);
    await expect(handover.planHandover(knex, args(w, { start: '2099-07-03' }))).rejects.toMatchObject({ code: 'START_TOO_SOON' });
    created.plans.push(p.planId);
    await expect(exec.executeHandover(knex, { ...args(w), start: '2099-07-03', planId: p.planId, outDir })).rejects.toMatchObject({ code: 'START_TOO_SOON' });
  });

  test('a cleared absence does not block its day: the hire marked out on Thursday, then cleared, takes the Thursday', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    // Clearing keeps the row and stamps cleared_at (tech-out clearTechOut).
    await knex('technician_absences').insert({ technician_id: w.hireId, absence_date: '2099-07-09', reason: 'synthetic', cleared_at: new Date('2099-06-29T15:00:00Z') });
    const p = await plan(w);
    expect(p.ids.kept).toEqual([]);
    expect(p.ids.moves.find((m) => m.visit_id === s.kids[0].id).to_date).toBe('2099-07-09');
    // The control: the same absence, not cleared, blocks Thursday and the visit takes the Monday.
    await knex('technician_absences').where({ technician_id: w.hireId, absence_date: '2099-07-09' }).update({ cleared_at: null });
    expect((await plan(w)).ids.moves.find((m) => m.visit_id === s.kids[0].id).to_date).toBe('2099-07-13');
  });

  test('a stale plan writes nothing: a changed date after the dry run refuses the run', async () => {
    const w = await world();
    const s = await weekendSeries(w.ownerId, await customer(), { dates: ['2099-07-11'] });
    const p = await plan(w);
    await knex('technician_absences').insert({ technician_id: w.hireId, absence_date: '2099-07-09', reason: 'synthetic' });
    created.plans.push(p.planId);
    await expect(exec.executeHandover(knex, { ...args(w), planId: p.planId, outDir, refresh: jest.fn() })).rejects.toMatchObject({ code: 'PLAN_MISMATCH' });
    expect(day((await get(s.kids[0].id)).scheduled_date)).toBe('2099-07-11');
    expect((await get(s.kids[0].id)).technician_id).toBe(w.ownerId);
  });
});
