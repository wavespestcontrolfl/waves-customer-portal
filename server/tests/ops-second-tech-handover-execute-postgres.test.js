/**
 * ops/agents/second-tech-handover-execute.js on real PostgreSQL: the write half of the
 * second-technician handover. Synthetic rows only, keyed to technicians this suite creates and
 * removed afterwards. 2099-07-06 is a Monday.
 *
 * DB-gated: skips without DATABASE_URL, runs in CI against the migrated database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('node:crypto');

const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describeDb('second-tech-handover --execute on PostgreSQL', () => {
  let knex;
  let handover;
  let exec;
  let outDir;
  const run = randomUUID().slice(0, 8);
  const START = '2099-07-06'; // Monday
  const TODAY = '2099-06-30';
  const NOW = new Date('2099-07-01T16:00:00Z'); // a Wednesday noon, ET: outside every restart window
  const created = { techs: [], customers: [], groups: [], plans: [] };
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
    const id = randomUUID();
    await knex('customers').insert({ id, first_name: `Syn${run}`, last_name: 'Test', phone: `+1999${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}` });
    created.customers.push(id);
    return id;
  };
  const row = (ownerId, customerId, date, o = {}) => ({
    id: randomUUID(), customer_id: customerId, technician_id: ownerId, scheduled_date: date, service_type: 'Quarterly Pest Control',
    status: 'confirmed', window_start: '09:00', window_end: '10:00', ...o,
  });
  const series = async (ownerId, customerId, o = {}) => {
    const parent = row(ownerId, customerId, '2099-06-01', { is_recurring: true, recurring_ongoing: true, status: 'completed', ...o });
    await knex('scheduled_services').insert(parent);
    return parent;
  };
  const child = async (ownerId, parent, date, o = {}) => {
    const r = row(ownerId, parent.customer_id, date, { is_recurring: true, recurring_parent_id: parent.id, service_type: parent.service_type, ...o });
    await knex('scheduled_services').insert(r);
    return r;
  };
  const get = (id) => knex('scheduled_services').where({ id }).first();

  // One owner, one hire (Mon-Thu), one third technician, and the series the plan must handle.
  async function world() {
    const ownerId = await makeTech();
    const hireId = await makeTech({ work_days: [1, 2, 3, 4] });
    const otherId = await makeTech();
    const w = { ownerId, hireId, otherId };

    const pestCustomer = await customer();
    w.pest = await series(ownerId, pestCustomer);
    w.mon = await child(ownerId, w.pest, '2099-07-06', { route_order: 5 });
    w.tue = await child(ownerId, w.pest, '2099-07-07');
    w.wed = await child(ownerId, w.pest, '2099-07-08');
    w.thu = await child(ownerId, w.pest, '2099-07-09');
    w.fri = await child(ownerId, w.pest, '2099-10-09'); // the hire's day off, after the 13 weeks: stays
    w.done = await child(ownerId, w.pest, '2099-07-13', { status: 'completed' });
    w.early = await child(ownerId, w.pest, '2099-07-03'); // before --start
    w.theirs = await child(otherId, w.pest, '2099-07-14'); // held by someone else
    w.unassigned = await child(ownerId, w.pest, '2099-07-15', { technician_id: null });
    w.enRoute = await child(ownerId, w.pest, '2099-07-16', { track_state: 'en_route' });

    // A grouped stop on the owner's series: untouched.
    const groupId = randomUUID();
    await knex('service_visits').insert({ id: groupId, customer_id: pestCustomer, scheduled_date: '2099-07-20', stop_base_key: `syn-${run}:${groupId.slice(0, 4)}`, created_by: 'test', status: 'open' });
    created.groups.push(groupId);
    w.grouped = await child(ownerId, w.pest, '2099-07-20', { visit_id: groupId });

    // A termite-bait customer: the pest series and its visits all stay.
    const baitCustomer = await customer();
    w.bait = await series(ownerId, baitCustomer, { service_type: 'Quarterly Termite Active Bait Station Service' });
    w.baitVisit = await child(ownerId, w.bait, '2099-07-07', { service_type: w.bait.service_type });
    w.baitPest = await series(ownerId, baitCustomer);
    w.baitPestVisit = await child(ownerId, w.baitPest, '2099-07-08');

    // Lawn is never handed over.
    w.lawn = await series(ownerId, await customer(), { service_type: 'Lawn Care Program' });
    w.lawnVisit = await child(ownerId, w.lawn, '2099-07-07', { service_type: 'Lawn Care Program' });

    // A second pest series that only changes template (its one visit is on a day off after the 13 weeks).
    w.fridayOnly = await series(ownerId, await customer());
    w.fridayVisit = await child(ownerId, w.fridayOnly, '2099-10-09');

    // A weekend customer (owner 2026-10-28, question 1 = C): a Saturday in the 13 weeks keeps the whole customer.
    w.weekend = await series(ownerId, await customer());
    w.weekendMon = await child(ownerId, w.weekend, '2099-07-06');
    w.weekendSat = await child(ownerId, w.weekend, '2099-07-11');
    return w;
  }

  const dryRun = async (w, o = {}) => handover.planHandover(knex, { from: w.ownerId, to: w.hireId, start: START, today: TODAY, ...o });
  const go = async (w, o = {}) => {
    const plan = await dryRun(w);
    created.plans.push(plan.planId);
    return exec.executeHandover(knex, {
      from: w.ownerId, to: w.hireId, start: START, today: TODAY, now: NOW, planId: plan.planId, outDir, refresh: jest.fn().mockResolvedValue({ status: 'refreshed' }), ...o,
    });
  };
  const notices = (ids) => knex('tech_notifications').whereIn('technician_id', ids).select('technician_id', 'type', 'message', 'payload');

  beforeAll(async () => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    handover = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover.js'));
    exec = require(path.join(__dirname, '..', '..', 'ops', 'agents', 'second-tech-handover-execute.js'));
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), `handover-${run}-`));
    // The per-visit notice gate ON: the proof is that the run reaches no path that reads it.
    priorGate = process.env.GATE_TECH_VISIT_NOTIFICATIONS;
    process.env.GATE_TECH_VISIT_NOTIFICATIONS = 'true';
  });

  afterAll(async () => {
    if (priorGate === undefined) delete process.env.GATE_TECH_VISIT_NOTIFICATIONS; else process.env.GATE_TECH_VISIT_NOTIFICATIONS = priorGate;
    if (outDir) fs.rmSync(outDir, { recursive: true, force: true });
    if (!knex) return;
    await knex('audit_log').whereIn('action', ['schedule.handover.execute', 'schedule.handover.rollback']).whereRaw("metadata->>'plan_id' = ANY(?)", [created.plans]).del();
    await knex('tech_notifications').whereIn('technician_id', created.techs).del();
    await knex('technician_absences').whereIn('technician_id', created.techs).del();
    if (created.customers.length) {
      await knex('scheduled_services').whereIn('customer_id', created.customers).update({ visit_id: null });
      if (created.groups.length) await knex('service_visits').whereIn('id', created.groups).del();
      await knex('scheduled_services').whereIn('customer_id', created.customers).del();
      await knex('customers').whereIn('id', created.customers).del();
    }
    await knex('technicians').whereIn('id', created.techs).del();
    await knex.destroy();
  });

  test('moves the series templates and the Mon-Thu open visits, leaves everything else, sends ONE card, and rolls back', async () => {
    const w = await world();
    const before = await notices([w.ownerId, w.hireId, w.otherId]);
    const stable = [w.fri, w.done, w.early, w.theirs, w.unassigned, w.enRoute, w.grouped, w.baitVisit, w.baitPestVisit, w.lawnVisit, w.fridayVisit,
      w.weekendMon, w.weekendSat];
    const snapshot = async (ids) => Object.fromEntries(await Promise.all(ids.map(async (r) => [r.id, await get(r.id)])));
    const stableBefore = await snapshot(stable);
    const monBefore = await get(w.mon.id);
    const refresh = jest.fn().mockResolvedValue({ status: 'refreshed' });

    const result = await go(w, { refresh });

    expect(result).toMatchObject({ series: 2, visits: 4, customers: 1, cardSent: true, flush: { status: 'refreshed' } });
    // Series templates: the hire, override on; the bait and lawn series are untouched.
    for (const s of [w.pest, w.fridayOnly]) {
      expect(await get(s.id)).toMatchObject({ recurring_technician_id: w.hireId, recurring_technician_override: true });
    }
    for (const s of [w.bait, w.baitPest, w.lawn, w.weekend]) {
      expect(await get(s.id)).toMatchObject({ recurring_technician_id: null, recurring_technician_override: false });
    }
    // Mon-Thu open visits moved; route number cleared; date and window untouched.
    for (const v of [w.mon, w.tue, w.wed, w.thu]) {
      expect(await get(v.id)).toMatchObject({ technician_id: w.hireId, route_order: null });
    }
    const monAfter = await get(w.mon.id);
    expect(String(monAfter.scheduled_date)).toBe(String(monBefore.scheduled_date));
    expect(monAfter.window_start).toBe(monBefore.window_start);
    expect(monAfter.window_end).toBe(monBefore.window_end);
    expect(monAfter.status).toBe(monBefore.status);
    // Nothing else changed, byte for byte (updated_at included).
    expect(await snapshot(stable)).toEqual(stableBefore);

    // ONE message: the hire's summary card. No per-visit card, though the notice gate is on.
    const after = await notices([w.ownerId, w.hireId, w.otherId]);
    const added = after.filter((n) => !before.some((b) => b.technician_id === n.technician_id && b.type === n.type && b.message === n.message));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      technician_id: w.hireId,
      type: 'series_handover',
      message: 'You now have 4 visits across 1 customer. They are on your schedule.',
      payload: { headline: 'Visits moved to your schedule', visits: 4, customers: 1, series: 2 },
    });
    expect(await knex('tech_notifications').whereIn('technician_id', [w.ownerId, w.hireId, w.otherId]).whereIn('type', ['visit_assigned', 'visit_unassigned']).count('* as c').first()).toMatchObject({ c: '0' });

    // The app's post-change refresh ran once, with the days that changed.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh.mock.calls[0][0]).toEqual({ dates: ['2099-07-06', '2099-07-07', '2099-07-08', '2099-07-09'] });

    // The rollback file and the audit row.
    const file = JSON.parse(fs.readFileSync(result.rollbackFile, 'utf8'));
    expect(file).toMatchObject({ version: 1, plan_id: result.planId, from: w.ownerId, to: w.hireId });
    expect(file.series.map((s) => s.id).sort()).toEqual([w.pest.id, w.fridayOnly.id].sort());
    expect(file.visits.map((v) => v.id).sort()).toEqual([w.mon.id, w.tue.id, w.wed.id, w.thu.id].sort());
    expect(JSON.stringify(file)).not.toMatch(/Synthetic|example\.invalid/);
    const audit = await knex('audit_log').where({ action: 'schedule.handover.execute' }).whereRaw("metadata->>'plan_id' = ?", [result.planId]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ visits: 4, series: 2, customers: 1, from: w.ownerId, to: w.hireId });

    // Rollback: one visit changed since (the hire handed it to the third technician): skipped and listed.
    await knex('scheduled_services').where({ id: w.wed.id }).update({ technician_id: w.otherId });
    const cardsBefore = (await notices([w.ownerId, w.hireId, w.otherId])).length;
    const undo = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: NOW, refresh: jest.fn().mockResolvedValue({ status: 'refreshed' }) });
    expect(undo).toMatchObject({ seriesRestored: 2, visitsRestored: 3, skipped: { series: [], visits: [w.wed.id] } });
    for (const v of [w.mon, w.tue, w.thu]) expect(await get(v.id)).toMatchObject({ technician_id: w.ownerId });
    // The undo returns the route number the run cleared.
    expect((await get(w.mon.id)).route_order).toBe(5);
    expect((await get(w.wed.id)).technician_id).toBe(w.otherId);
    for (const s of [w.pest, w.fridayOnly]) {
      expect(await get(s.id)).toMatchObject({ recurring_technician_id: null, recurring_technician_override: false });
    }
    expect((await notices([w.ownerId, w.hireId, w.otherId])).length).toBe(cardsBefore); // rollback sends nothing
    expect(await knex('audit_log').where({ action: 'schedule.handover.rollback' }).whereRaw("metadata->>'plan_id' = ?", [result.planId])).toHaveLength(1);
  });

  test('a stale or wrong PLAN ID writes nothing and leaves no rollback file', async () => {
    const w = await world();
    const files = () => fs.readdirSync(outDir).length;
    const filesBefore = files();
    const wrong = await exec.executeHandover(knex, {
      from: w.ownerId, to: w.hireId, start: START, today: TODAY, now: NOW, planId: 'b'.repeat(64), outDir,
    }).catch((e) => e);
    expect(wrong).toMatchObject({ name: 'Refusal', code: 'PLAN_MISMATCH' });
    expect(wrong.message).toMatch(/Nothing was written/);

    // The plan the owner read, then the world moves: a visit is completed before he runs it.
    const read = await dryRun(w);
    created.plans.push(read.planId);
    await knex('scheduled_services').where({ id: w.mon.id }).update({ status: 'completed' });
    await expect(exec.executeHandover(knex, {
      from: w.ownerId, to: w.hireId, start: START, today: TODAY, now: NOW, planId: read.planId, outDir,
    })).rejects.toMatchObject({ code: 'PLAN_MISMATCH' });

    expect((await get(w.tue.id)).technician_id).toBe(w.ownerId);
    expect((await get(w.pest.id)).recurring_technician_id).toBeNull();
    expect(files()).toBe(filesBefore);
  });

  test('the target must be assignable with work days; the same technician and the restart windows are refused', async () => {
    const w = await world();
    const plan = await dryRun(w);
    const base = { from: w.ownerId, start: START, today: TODAY, now: NOW, planId: plan.planId, outDir };
    const prospective = await makeTech({ employment_status: 'prospective', work_days: [1, 2, 3, 4] });
    const noDays = await makeTech({ work_days: null });
    await expect(exec.executeHandover(knex, { ...base, to: prospective })).rejects.toMatchObject({ code: 'TARGET_NOT_ASSIGNABLE' });
    await expect(exec.executeHandover(knex, { ...base, to: noDays })).rejects.toMatchObject({ code: 'TARGET_NO_WORK_DAYS' });
    await expect(exec.executeHandover(knex, { ...base, to: randomUUID() })).rejects.toMatchObject({ code: 'TARGET_MISSING' });
    await expect(exec.executeHandover(knex, { ...base, to: w.ownerId })).rejects.toMatchObject({ code: 'SAME_TECHNICIAN' });
    await expect(exec.executeHandover(knex, { ...base, to: w.hireId, now: new Date('2099-07-06T06:50:00-04:00') })).rejects.toMatchObject({ code: 'RESTART_WINDOW' });
    expect((await get(w.tue.id)).technician_id).toBe(w.ownerId);
  });

  test('the run refuses while the auto-dispatch writer lock is held, and frees the lock when it ends', async () => {
    const w = await world();
    const holder = await knex.client.acquireConnection();
    try {
      const res = await holder.query({ text: 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', values: [exec.AUTO_DISPATCH_LOCK] });
      expect(res.rows[0].locked).toBe(true);
      await expect(go(w)).rejects.toMatchObject({ code: 'AUTO_DISPATCH_LOCK_HELD' });
      expect((await get(w.tue.id)).technician_id).toBe(w.ownerId);
    } finally {
      await holder.query({ text: 'SELECT pg_advisory_unlock(hashtext($1))', values: [exec.AUTO_DISPATCH_LOCK] });
      await knex.client.releaseConnection(holder);
    }
    await expect(go(w)).resolves.toMatchObject({ visits: 4 });
    // The lock is free again once the run is over.
    const probe = await knex.client.acquireConnection();
    try {
      const res = await probe.query({ text: 'SELECT pg_try_advisory_lock(hashtext($1)) AS locked', values: [exec.AUTO_DISPATCH_LOCK] });
      expect(res.rows[0].locked).toBe(true);
      await probe.query({ text: 'SELECT pg_advisory_unlock(hashtext($1))', values: [exec.AUTO_DISPATCH_LOCK] });
    } finally {
      await knex.client.releaseConnection(probe);
    }
  });

  test('a day the hire is marked out refuses the whole run: nothing moves, no card, no file', async () => {
    const w = await world();
    await knex('technician_absences').insert({ technician_id: w.hireId, absence_date: '2099-07-08', reason: 'synthetic' });
    const filesBefore = fs.readdirSync(outDir).length;
    await expect(go(w)).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });
    expect((await get(w.mon.id)).technician_id).toBe(w.ownerId);
    expect((await get(w.pest.id)).recurring_technician_override).toBe(false);
    expect(await notices([w.hireId])).toHaveLength(0);
    expect(fs.readdirSync(outDir).length).toBe(filesBefore);
  });

  test('rollback leaves a visit moved to another day, and a day the original technician cannot take, with the hire', async () => {
    const w = await world();
    const result = await go(w, { refresh: jest.fn().mockResolvedValue({ status: 'refreshed' }) });
    expect(result).toMatchObject({ visits: 4 });
    // Since the run: Tuesday's visit was moved to another day, and the owner is marked out on Wednesday.
    await knex('scheduled_services').where({ id: w.tue.id }).update({ scheduled_date: '2099-07-14' });
    await knex('technician_absences').insert({ technician_id: w.ownerId, absence_date: '2099-07-08', reason: 'synthetic' });

    const undo = await exec.rollbackHandover(knex, { file: result.rollbackFile, now: NOW, refresh: jest.fn().mockResolvedValue({ status: 'refreshed' }) });

    expect(undo).toMatchObject({ seriesRestored: 2, visitsRestored: 2 });
    expect(undo.skipped.visits.sort()).toEqual([w.tue.id, w.wed.id].sort());
    for (const v of [w.mon, w.thu]) expect((await get(v.id)).technician_id).toBe(w.ownerId);
    for (const v of [w.tue, w.wed]) expect((await get(v.id)).technician_id).toBe(w.hireId);
  });

  test('a failure after the first update rolls the whole run back', async () => {
    const w = await world();
    const plan = await dryRun(w);
    created.plans.push(plan.planId);
    // The audit row is the last write inside the transaction: make it fail.
    const audit = require('../services/audit-log');
    const spy = jest.spyOn(audit, 'recordAuditEvent').mockRejectedValueOnce(new Error('audit write failed'));
    try {
      await expect(exec.executeHandover(knex, {
        from: w.ownerId, to: w.hireId, start: START, today: TODAY, now: NOW, planId: plan.planId, outDir, refresh: jest.fn(),
      })).rejects.toThrow('audit write failed');
    } finally {
      spy.mockRestore();
    }
    expect((await get(w.mon.id)).technician_id).toBe(w.ownerId);
    expect((await get(w.pest.id))).toMatchObject({ recurring_technician_id: null, recurring_technician_override: false });
    expect(await notices([w.hireId])).toHaveLength(0);
  });
});
