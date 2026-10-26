/**
 * GATE_UNASSIGNED_VISIT_GUARD (census H5 + M13, owner 2026-10-25) against real PostgreSQL.
 *
 *  - H5: the office Auto technician choice (services/scheduling/office-auto-technician.js)
 *    reads the real technicians, absences, work days and capabilities. Each case runs in a
 *    transaction that is rolled back, with every other technician set inactive inside it.
 *  - M13: the daily check for timed visits with no technician tomorrow through 3 days out
 *    (services/unassigned-timed-visits-check.js) through the real notification service and
 *    alert episodes: counts only timed, unassigned, live visits in range; rings on a new
 *    member only; clears at zero; leaves out visits the combined-booking check owns.
 *
 * Skipped without DATABASE_URL. Synthetic names only; fixtures are deleted in afterAll.
 */
jest.setTimeout(60000);

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
const { randomUUID } = require('node:crypto');

const ROLLBACK = new Error('rollback');
// A Friday in 2098: no other suite books that far out.
const FRIDAY = '2098-03-14';

afterAll(async () => { if (!SKIP) await require('../models/db').destroy(); });

maybeDescribe('office Auto technician choice (live Postgres)', () => {
  let db;
  let resolve;
  let picker;
  beforeAll(() => {
    db = require('../models/db');
    resolve = require('../services/scheduling/office-auto-technician').resolveOfficeAutoTechnician;
    picker = require('../services/scheduling/pick-technician');
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.GATE_TECH_WORK_DAYS;
  });

  // Runs `fn(trx, helpers)` and always rolls the transaction back.
  async function inRolledBackTrx(fn) {
    try {
      await db.transaction(async (trx) => {
        await trx('technicians').update({ employment_status: 'inactive' });
        await fn(trx);
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }
  }
  const tech = async (trx, name, over = {}) => (await trx('technicians').insert({
    name, role: 'technician', employment_status: 'active', field_dispatchable: true, ...over,
  }).returning('id'))[0].id;
  const auto = (trx, over = {}) => resolve({
    conn: trx, date: FRIDAY, windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60,
    serviceType: 'General Pest Control', customerId: null, ...over,
  });

  test('exactly one assignable technician takes it (inactive and non-dispatchable staff do not count)', async () => {
    await inRolledBackTrx(async (trx) => {
      const only = await tech(trx, 'Synthetic Tech One');
      await tech(trx, 'Synthetic Office Only', { field_dispatchable: false });
      await tech(trx, 'Synthetic Former Tech', { employment_status: 'inactive' });
      await expect(auto(trx)).resolves.toEqual({ technicianId: only, result: 'assigned', reason: 'only_assignable' });
    });
  });

  test('nobody assignable leaves the visit unassigned', async () => {
    await inRolledBackTrx(async (trx) => {
      await expect(auto(trx)).resolves.toEqual({ technicianId: null, result: 'unassigned', reason: 'none_assignable' });
    });
  });

  test('two assignable technicians and no active scheduling pick: unassigned, and it says why', async () => {
    await inRolledBackTrx(async (trx) => {
      await tech(trx, 'Synthetic Tech One');
      await tech(trx, 'Synthetic Tech Two');
      jest.spyOn(picker, 'pickTechnicianActive').mockReturnValue(false);
      const pick = jest.spyOn(picker, 'pickTechnicianForVisit');
      await expect(auto(trx)).resolves.toEqual({ technicianId: null, result: 'unassigned', reason: 'several_assignable' });
      expect(pick).not.toHaveBeenCalled();
    });
  });

  test('two assignable technicians and an active pick: the pick decides, and only among those assignable', async () => {
    await inRolledBackTrx(async (trx) => {
      const one = await tech(trx, 'Synthetic Tech One');
      const two = await tech(trx, 'Synthetic Tech Two');
      jest.spyOn(picker, 'pickTechnicianActive').mockReturnValue(true);
      const pick = jest.spyOn(picker, 'pickTechnicianForVisit').mockResolvedValue({ active: true, technician: { id: two, name: 'x' }, reason: 'closest_route' });
      await expect(auto(trx, { customerId: 'cust-1' })).resolves.toEqual({ technicianId: two, result: 'assigned', reason: 'scheduling_pick' });
      expect(pick).toHaveBeenCalledWith(expect.objectContaining({ conn: trx, date: FRIDAY, windowStart: '09:00', windowEnd: '10:00', customerId: 'cust-1' }));

      pick.mockResolvedValue({ active: true, technician: null, reason: 'none_free' });
      await expect(auto(trx)).resolves.toEqual({ technicianId: null, result: 'unassigned', reason: 'none_free' });
      pick.mockResolvedValue({ active: false, technician: null, reason: 'no_window' });
      await expect(auto(trx, { windowStart: null, windowEnd: null })).resolves.toEqual({ technicianId: null, result: 'unassigned', reason: 'several_assignable' });
      // A pick naming someone outside the assignable list is never trusted.
      pick.mockResolvedValue({ active: true, technician: { id: randomUUID(), name: 'x' }, reason: 'closest_route' });
      await expect(auto(trx)).resolves.toMatchObject({ technicianId: null, result: 'unassigned' });
      expect([one, two]).toHaveLength(2);
    });
  });

  test('a technician marked out that day is not chosen', async () => {
    await inRolledBackTrx(async (trx) => {
      const out = await tech(trx, 'Synthetic Tech Out');
      const here = await tech(trx, 'Synthetic Tech Here');
      await trx('technician_absences').insert({ technician_id: out, absence_date: FRIDAY, reason: 'sick' });
      await expect(auto(trx)).resolves.toEqual({ technicianId: here, result: 'assigned', reason: 'only_assignable' });
      // A cleared absence counts as present again.
      await trx('technician_absences').where({ technician_id: out }).update({ cleared_at: new Date() });
      jest.spyOn(picker, 'pickTechnicianActive').mockReturnValue(false);
      await expect(auto(trx)).resolves.toMatchObject({ reason: 'several_assignable' });
    });
  });

  test('a technician who does not work that weekday is skipped while GATE_TECH_WORK_DAYS is on, and counted while it is off', async () => {
    await inRolledBackTrx(async (trx) => {
      const monThu = await tech(trx, 'Synthetic Tech MonThu', { work_days: [1, 2, 3, 4] });
      const allWeek = await tech(trx, 'Synthetic Tech AllWeek');
      process.env.GATE_TECH_WORK_DAYS = 'true';
      await expect(auto(trx)).resolves.toEqual({ technicianId: allWeek, result: 'assigned', reason: 'only_assignable' });
      await trx('technicians').where({ id: allWeek }).update({ work_days: [1, 2, 3, 4] });
      await expect(auto(trx)).resolves.toEqual({ technicianId: null, result: 'unassigned', reason: 'none_assignable' });
      delete process.env.GATE_TECH_WORK_DAYS;
      jest.spyOn(picker, 'pickTechnicianActive').mockReturnValue(false);
      await expect(auto(trx)).resolves.toMatchObject({ reason: 'several_assignable' });
      expect(monThu).toBeTruthy();
    });
  });

  test('a technician switched Off for the visit\'s service category is not chosen; "needs review" still counts', async () => {
    await inRolledBackTrx(async (trx) => {
      const off = await tech(trx, 'Synthetic Tech NoPest');
      const ok = await tech(trx, 'Synthetic Tech Pest');
      await trx('technician_capabilities').insert([
        { technician_id: off, service_category: 'general', capability_level: 'review_required', active: false },
        { technician_id: ok, service_category: 'general', capability_level: 'review_required', active: true },
        // Off for lawn does not matter to a pest visit.
        { technician_id: ok, service_category: 'lawn', capability_level: 'review_required', active: false },
      ]);
      await expect(auto(trx)).resolves.toEqual({ technicianId: ok, result: 'assigned', reason: 'only_assignable' });
      // For a lawn visit the roles flip.
      await expect(auto(trx, { serviceType: 'Lawn Fertilization' })).resolves.toEqual({ technicianId: off, result: 'assigned', reason: 'only_assignable' });
    });
  });

  test('a failed read leaves the visit unassigned instead of throwing', async () => {
    const boom = jest.fn(() => { throw new Error('db down'); });
    await expect(resolve({ conn: boom, date: FRIDAY, serviceType: 'General Pest Control' }))
      .resolves.toEqual({ technicianId: null, result: 'unassigned', reason: 'lookup_failed' });
  });
});

maybeDescribe('unassigned timed visits check (live Postgres)', () => {
  let db;
  let check;
  const created = { customers: [], visits: [], estimates: [], techs: [] };
  // "Now" is the evening of 2098-03-10: the window is 03-11 (tomorrow) through 03-13.
  const NOW = new Date('2098-03-10T22:10:00Z');
  const rows = () => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", ['unassigned-timed-visits']);
  const run = (over = {}) => check.runUnassignedTimedVisitsCheck({ now: NOW, gateEnabled: true, ...over });
  const customer = async (first = 'Synthetic', last = 'Visitor') => {
    const id = randomUUID();
    await db('customers').insert({ id, first_name: first, last_name: last, phone: `+1555${id.slice(0, 7)}`, active: true });
    created.customers.push(id);
    return id;
  };
  const visit = async (customerId, over = {}) => {
    const id = randomUUID();
    await db('scheduled_services').insert({
      id, customer_id: customerId, scheduled_date: '2098-03-11', window_start: '09:00', window_end: '10:00',
      service_type: 'General Pest Control', status: 'pending', technician_id: null, ...over,
    });
    created.visits.push(id);
    return id;
  };

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    db = require('../models/db');
    check = require('../services/unassigned-timed-visits-check');
  });
  afterAll(async () => {
    if (!db) return;
    await rows().del();
    await db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' LIKE 'combined-booking-check:synthetic-guard-%'").del();
    if (created.visits.length) await db('scheduled_services').whereIn('id', created.visits).del();
    if (created.techs.length) await db('technicians').whereIn('id', created.techs).del();
    if (created.estimates.length) await db('estimates').whereIn('id', created.estimates).del();
    if (created.customers.length) await db('customers').whereIn('id', created.customers).del();
  });

  test('gate off: no query and no row', async () => {
    const conn = { transaction: jest.fn() };
    await expect(check.runUnassignedTimedVisitsCheck({ now: NOW, conn, gateEnabled: false })).resolves.toEqual({ skipped: 'disabled' });
    expect(conn.transaction).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(0);
  });

  test('counts only timed, unassigned, live visits tomorrow through 3 days out; rings on a new member only; clears at zero', async () => {
    const custA = await customer('Pat', 'Synthetic');
    const custB = await customer('Kim', 'Sample');
    const [tech] = (await db('technicians').insert({ name: 'Synthetic Guard Tech', role: 'technician', employment_status: 'active', field_dispatchable: true }).returning('id'));
    created.techs.push(tech.id);
    const counted1 = await visit(custA, { scheduled_date: '2098-03-11', window_start: '09:00', window_end: '10:00' });
    const counted2 = await visit(custB, { scheduled_date: '2098-03-13', window_start: '14:00', window_end: '15:00', status: 'confirmed' });
    // Not counted: today, 4 days out, untimed, assigned, cancelled, completed, an estimate hold.
    await visit(custA, { scheduled_date: '2098-03-10' });
    await visit(custA, { scheduled_date: '2098-03-14' });
    await visit(custA, { scheduled_date: '2098-03-12', window_start: null, window_end: null });
    await visit(custA, { scheduled_date: '2098-03-12', technician_id: tech.id });
    await visit(custA, { scheduled_date: '2098-03-12', status: 'cancelled' });
    await visit(custA, { scheduled_date: '2098-03-12', status: 'completed' });
    await visit(custA, { scheduled_date: '2098-03-12', reservation_expires_at: new Date('2098-03-12T00:00:00Z') });

    // 1. First run: one unread Schedule row naming the earliest visit, with both visits as item keys.
    await expect(run()).resolves.toEqual({ count: 2, outcome: 'raised' });
    let all = await rows();
    expect(all).toHaveLength(1);
    let row = all[0];
    expect(row.title).toBe('Schedule — assign a technician to 2 visits');
    expect(row.body).toContain('Tue Mar 11 at 9:00 AM');
    expect(row.body).toContain('Pat Synthetic');
    expect(row.link).toBe('/admin/schedule?date=2098-03-11');
    expect(row.read_at).toBeNull();
    expect(row.metadata).toMatchObject({ itemKeys: [counted1, counted2].sort(), count: 2, area: 'Schedule', severity: 'needs-you', doneWhen: 'count_zero' });
    expect(row.detail).toContain('Kim Sample');
    const firstId = row.id;

    // 2. The same set again changes nothing.
    await expect(run()).resolves.toEqual({ count: 2, outcome: 'unchanged' });

    // 3. A person reads it; the office assigns one visit: a quiet refresh that keeps the read.
    await db('notifications').where({ id: firstId }).update({ read_at: new Date('2098-03-10T22:11:00Z') });
    await db('scheduled_services').where({ id: counted1 }).update({ technician_id: tech.id });
    await expect(run()).resolves.toEqual({ count: 1, outcome: 'refreshed' });
    row = (await rows())[0];
    expect(row.id).toBe(firstId);
    expect(row.read_at).not.toBeNull();
    expect(row.title).toBe('Schedule — assign a technician to 1 visit');
    expect(row.link).toBe('/admin/schedule?date=2098-03-13');

    // 4. A new visit joins: it rings again (unread).
    const joined = await visit(custA, { scheduled_date: '2098-03-12', window_start: '11:00', window_end: '12:00' });
    await expect(run()).resolves.toEqual({ count: 2, outcome: 'raised' });
    row = (await rows())[0];
    expect(row.read_at).toBeNull();
    expect(row.metadata.itemKeys).toEqual([counted2, joined].sort());

    // 5. Everything assigned: the row closes itself (done), and a second zero run is quiet.
    await db('scheduled_services').whereIn('id', [counted2, joined]).update({ technician_id: tech.id });
    await expect(run()).resolves.toEqual({ count: 0, outcome: 'closed' });
    row = (await rows())[0];
    expect(row.done_at).not.toBeNull();
    expect(row.resolution).toMatch(/every timed visit/i);
    await expect(run()).resolves.toEqual({ count: 0, outcome: 'clear' });

    // 6. A comeback rings a fresh bell.
    await db('scheduled_services').where({ id: joined }).update({ technician_id: null });
    await expect(run()).resolves.toEqual({ count: 1, outcome: 'raised' });
    row = (await rows())[0];
    expect(row.done_at).toBeNull();
    expect(row.read_at).toBeNull();

    await db('scheduled_services').where({ id: joined }).update({ technician_id: tech.id });
    await run();
  });

  test('a visit the combined-booking check already rings for is left out; its other kinds of problem do not hide it', async () => {
    await rows().del();
    const cust = await customer('Dee', 'Combo');
    const [est] = await db('estimates').insert({ customer_id: cust }).returning('id');
    created.estimates.push(est.id);
    const owned = await visit(cust, { source_estimate_id: est.id, scheduled_date: '2098-03-12', window_start: '10:00', window_end: '11:00' });
    const other = await visit(cust, { scheduled_date: '2098-03-12', window_start: '13:00', window_end: '14:00' });
    const bell = (problemCodes, extra = {}) => db('notifications').insert({
      recipient_type: 'admin', category: 'alert', title: 'Schedule — fix a combined booking', body: 'x',
      metadata: JSON.stringify({ dedupeKey: `combined-booking-check:synthetic-guard-${est.id}`, estimateId: est.id, problemCodes, ...extra }),
    });

    await bell(['price_mismatch']);
    // A price problem is not this visit's missing technician: it still counts.
    await expect(run()).resolves.toMatchObject({ count: 2 });
    await db('notifications').whereRaw("metadata->>'dedupeKey' LIKE 'combined-booking-check:synthetic-guard-%'").del();

    await bell(['missing_time_tech']);
    await expect(run()).resolves.toMatchObject({ count: 1 });
    expect((await rows())[0].metadata.itemKeys).toEqual([other]);

    // Once that bell clears itself, the visit counts again.
    await db('notifications').whereRaw("metadata->>'dedupeKey' LIKE 'combined-booking-check:synthetic-guard-%'")
      .update({ metadata: db.raw("metadata || '{\"autoCleared\": true}'::jsonb") });
    await expect(run()).resolves.toMatchObject({ count: 2 });
    expect((await rows())[0].metadata.itemKeys).toEqual([owned, other].sort());
  });
});
