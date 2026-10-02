/**
 * Series EXTENSION keeps riding the lawn (GATE_PEST_RIDES_LAWN_AT_ACCEPT,
 * owner rulings 2026-10-01/02) plus the ungated own-lawn-visit clash fix.
 * Real Postgres on the migrated schema, synthetic customers, every test rolled
 * back.
 *
 * Proves, through admin-schedule.js#extendSeriesOnceLocked (completion
 * auto-extend and top-up both go through it):
 *   - a rider series' next visit lands on the next lawn occurrence, takes that
 *     occurrence's CURRENT window start and technician, ends by the rider's own
 *     duration, and shares the lawn row's visit;
 *   - the placement is grouped-or-nothing: when maybeGroupRow cannot put the
 *     two in one visit the savepoint rolls back (no stray row) and the normal
 *     cadence walk runs;
 *   - blackout days and opted-out weekends are not ridden; gate off / no link
 *     keeps today's walk;
 *   - the customer's OWN visit at the candidate's stop is no longer a clash
 *     when the new row joins it; another customer's visit, or an own visit the
 *     row cannot join, still is;
 *   - post-commit work (coverage alerts, reminders) fires only for a KEPT row,
 *     and only after the caller's transaction commits.
 */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => (typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key]),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/appointment-reminders', () => ({
  ...jest.requireActual('../services/appointment-reminders'),
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/tech-visit-notifications', () => ({
  notifyTechVisitChange: async () => {}, notifyAssignmentChange: () => null,
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const { addETDays, etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');

const connection = process.env.DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(60000);

const GATE = 'GATE_PEST_RIDES_LAWN_AT_ACCEPT';
const addDays = (d, n) => etDateString(addETDays(parseETDateTime(`${d}T12:00`), n));
const dateOf = (v) => (v instanceof Date ? etDateString(v) : String(v).slice(0, 10));
const hhmm = (v) => (v ? String(v).slice(0, 5) : null);

postgres('series extension keeps riding the lawn', () => {
  let gates;
  let Admin;
  let Reminders;
  let Renewals;
  let originalVisitGroups;
  let originalGate;
  let ids;

  beforeAll(async () => {
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !privateQa) throw new Error('Use disposable CI or this worktree\'s private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    gates = require('../config/feature-gates').gates;
    Admin = require('../routes/admin-schedule');
    Reminders = require('../services/appointment-reminders');
    Renewals = require('../services/annual-prepay-renewals');
    const catalog = await mockPg('services').whereIn('service_key', ['lawn_care_6week', 'pest_general_quarterly']).select('id', 'service_key');
    ids = Object.fromEntries(catalog.map((r) => [r.service_key, r.id]));
  });

  beforeEach(() => {
    originalVisitGroups = gates.visitGroups;
    originalGate = process.env[GATE];
    Object.assign(gates, { visitGroups: true });
    process.env[GATE] = 'true';
    Reminders.registerAppointment.mockClear();
  });

  afterEach(() => {
    Object.assign(gates, { visitGroups: originalVisitGroups });
    if (originalGate === undefined) delete process.env[GATE];
    else process.env[GATE] = originalGate;
  });

  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  function weekdayBack(days) {
    let d = addETDays(new Date(), -days);
    while ([0, 6].includes(etParts(d).dayOfWeek)) d = addETDays(d, -1);
    return etDateString(d);
  }

  async function technician(trx) {
    const id = randomUUID();
    await trx('technicians').insert({
      id, name: 'Synthetic Technician', email: `${id}@example.invalid`,
      password_hash: 'synthetic-not-a-login-hash', role: 'technician', active: true,
      employment_status: 'active', field_dispatchable: true,
    });
    return id;
  }

  async function customer(trx, { autopay = false } = {}) {
    const customerId = randomUUID();
    const propertyId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Extension',
      email: `${customerId}@example.invalid`, phone: '+19415550188', active: true,
      property_type: 'residential', address_line1: '400 Example Court', city: 'Parrish',
      state: 'FL', zip: '34219', pipeline_stage: 'active_customer', autopay_enabled: autopay,
    });
    await trx('customer_properties').insert({
      id: propertyId, customer_id: customerId, is_primary: true, active: true,
      address_line1: '400 Example Court', city: 'Parrish', state: 'FL', zip: '34219', source: 'estimate_accept',
    });
    return { customerId, propertyId };
  }

  // A lawn series (6-week, finished first visit D0, pending children every 42
  // days) and a quarterly pest series whose first visit D0 is also finished,
  // linked to the lawn through rides_parent_id (or not).
  async function world(trx, {
    autopay = false, rides = true, pestTech = null, lawnTech = null, pestSkipWeekends = false,
    pestWindow = ['09:00', '10:00'], lawnWindow = ['09:00', '10:00'], pestExtra = {},
  } = {}) {
    const base = await customer(trx, { autopay });
    const techLawn = lawnTech || await technician(trx);
    const d0 = weekdayBack(7);
    const lawnRow = (extra) => ({
      customer_id: base.customerId, property_id: base.propertyId, technician_id: techLawn,
      service_id: ids.lawn_care_6week, service_type: 'Every 6 Weeks Lawn Care Service',
      service_key_snapshot: 'lawn_care_6week', window_start: lawnWindow[0], window_end: lawnWindow[1],
      estimated_duration_minutes: 60, estimated_price: 60, recurring_pattern: 'every_6_weeks',
      is_recurring: true, recurring_ongoing: true, ...extra,
    });
    const [lawnParent] = await trx('scheduled_services').insert(lawnRow({ scheduled_date: d0, status: 'completed' })).returning('*');
    const lawnChildren = [];
    for (let k = 1; k <= 12; k++) {
      const [child] = await trx('scheduled_services').insert(lawnRow({
        scheduled_date: addDays(d0, 42 * k), status: 'pending', recurring_parent_id: lawnParent.id,
      })).returning('*');
      lawnChildren.push(child);
    }
    const [pestParent] = await trx('scheduled_services').insert({
      customer_id: base.customerId, property_id: base.propertyId, technician_id: pestTech,
      service_id: ids.pest_general_quarterly, service_type: 'Quarterly Pest Control Service',
      service_key_snapshot: 'pest_general_quarterly', scheduled_date: d0, status: 'completed',
      window_start: pestWindow[0], window_end: pestWindow[1], estimated_duration_minutes: 60,
      estimated_price: 120, recurring_pattern: 'quarterly', is_recurring: true, recurring_ongoing: true,
      create_invoice_on_complete: true, skip_weekends: pestSkipWeekends, rides_parent_id: rides ? lawnParent.id : null, ...pestExtra,
    }).returning('*');
    return {
      ...base, d0, techLawn, lawnParent, lawnChildren, pestParent,
    };
  }

  async function extend(trx, parentId) {
    const cols = await trx('scheduled_services').columnInfo();
    const parent = await trx('scheduled_services').where({ id: parentId }).first();
    return Admin._test.extendSeriesOnceLocked(trx, parent, parentId, cols, parent);
  }

  // Where the plain cadence walk would put the next visit: the same extension
  // with the gate off, inside a savepoint that is thrown away.
  async function cadenceDate(trx, parentId) {
    const saved = process.env[GATE];
    process.env[GATE] = 'false';
    let found = null;
    try {
      await trx.transaction(async (sp) => {
        const spawned = await extend(sp, parentId);
        found = spawned && spawned.scheduledDate;
        throw new Error('probe rollback');
      });
    } catch (err) { if (err.message !== 'probe rollback') throw err; }
    process.env[GATE] = saved;
    return found;
  }

  const extensionRows = (trx, parentId) => trx('scheduled_services').where({ recurring_parent_id: parentId }).orderBy('scheduled_date');

  test('rides the next lawn occurrence, takes its CURRENT window and technician, ends by the rider duration, shares the visit', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx, { pestTech: await technician(trx) }); // template tech differs from the crew
      const moved = await technician(trx);
      const target = w.lawnChildren[1]; // D0 + 84
      // Dispatch moved this lawn visit and its crew; it is longer than the rider.
      await trx('scheduled_services').where({ id: target.id }).update({
        window_start: '10:00', window_end: '12:00', estimated_duration_minutes: 120, technician_id: moved,
      });
      const spawned = await extend(trx, w.pestParent.id);
      expect(spawned).toBeTruthy();
      const [row] = await extensionRows(trx, w.pestParent.id);
      expect(dateOf(row.scheduled_date)).toBe(addDays(w.d0, 84));
      expect(hhmm(row.window_start)).toBe('10:00');
      expect(hhmm(row.window_end)).toBe('11:00'); // the pest's 60 minutes, not the lawn's 120
      expect(row.technician_id).toBe(moved);
      const host = await trx('scheduled_services').where({ id: target.id }).first();
      expect(row.visit_id).not.toBeNull();
      expect(row.visit_id).toBe(host.visit_id);
      expect(spawned.scheduledServiceId).toBe(row.id);
      expect(spawned.windowStart).toBe('10:00');
    } finally { await trx.rollback(); }
  });

  test('an off-hour lawn start is floored to the hour for the rider and still shares the visit', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx, { lawnWindow: ['10:30', '11:30'] });
      await extend(trx, w.pestParent.id);
      const [row] = await extensionRows(trx, w.pestParent.id);
      expect(dateOf(row.scheduled_date)).toBe(addDays(w.d0, 84));
      expect([hhmm(row.window_start), hhmm(row.window_end)]).toEqual(['10:00', '11:00']);
      const host = await trx('scheduled_services').where({ id: w.lawnChildren[1].id }).first();
      expect(row.visit_id).toBe(host.visit_id);
    } finally { await trx.rollback(); }
  });

  test('an unplaceable ride window is skipped: the cadence walk runs, nothing lands on the lawn date', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx);
      await trx('scheduled_services').where({ id: w.lawnChildren[1].id }).update({ window_start: '20:00', window_end: '21:00' });
      const expected = await cadenceDate(trx, w.pestParent.id);
      await extend(trx, w.pestParent.id);
      const rows = await extensionRows(trx, w.pestParent.id);
      expect(rows.map((r) => dateOf(r.scheduled_date))).toEqual([expected]);
      expect(expected).not.toBe(addDays(w.d0, 84));
    } finally { await trx.rollback(); }
  });

  test('a lawn occurrence that cannot group rolls the savepoint back: no stray row, the cadence walk runs', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx, { autopay: true }); // visit groups refuse an autopay customer
      const expected = await cadenceDate(trx, w.pestParent.id);
      const before = await trx('scheduled_services').where({ customer_id: w.customerId }).count('* as n').first();
      const spawned = await extend(trx, w.pestParent.id);
      expect(spawned && spawned.scheduledDate).toBe(expected);
      const rows = await extensionRows(trx, w.pestParent.id);
      expect(rows.map((r) => dateOf(r.scheduled_date))).toEqual([expected]);
      expect(rows[0].visit_id).toBeNull();
      const after = await trx('scheduled_services').where({ customer_id: w.customerId }).count('* as n').first();
      expect(Number(after.n)).toBe(Number(before.n) + 1);
      expect(await trx('scheduled_services').where({ customer_id: w.customerId, scheduled_date: addDays(w.d0, 84), service_id: ids.pest_general_quarterly }).first()).toBeUndefined();
    } finally { await trx.rollback(); }
  });

  test('visit groups off: the attempt cannot group, so today\'s walk runs untouched', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx);
      const expected = await cadenceDate(trx, w.pestParent.id);
      Object.assign(gates, { visitGroups: false });
      await extend(trx, w.pestParent.id);
      const rows = await extensionRows(trx, w.pestParent.id);
      expect(rows.map((r) => dateOf(r.scheduled_date))).toEqual([expected]);
    } finally { await trx.rollback(); }
  });

  test('a blacked-out lawn date is not ridden', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx);
      const day = addDays(w.d0, 84);
      await trx('schedule_blackout_dates').insert({ date: day, reason: 'synthetic closure' });
      await extend(trx, w.pestParent.id);
      const rows = await extensionRows(trx, w.pestParent.id);
      expect(rows).toHaveLength(1);
      expect(dateOf(rows[0].scheduled_date)).not.toBe(day);
      expect(rows[0].visit_id).toBeNull();
    } finally { await trx.rollback(); }
  });

  test('a weekend lawn date is not ridden by a rider who opted out of weekends', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx, { pestSkipWeekends: true });
      // Isolate the rider's own weekend opt-out from the owner's weekly closure.
      await trx('system_settings').where({ key: 'schedule_weekly_days_off' }).update({ value: '[]' });
      const target = w.lawnChildren[1];
      let saturday = addDays(w.d0, 84);
      while (etParts(parseETDateTime(`${saturday}T12:00`)).dayOfWeek !== 6) saturday = addDays(saturday, 1);
      await trx('scheduled_services').where({ id: target.id }).update({ scheduled_date: saturday });
      await extend(trx, w.pestParent.id);
      const rows = await extensionRows(trx, w.pestParent.id);
      expect(rows).toHaveLength(1);
      expect(dateOf(rows[0].scheduled_date)).not.toBe(saturday);
    } finally { await trx.rollback(); }
  });

  test('gate off, or no rides_parent_id: the cadence walk is unchanged', async () => {
    const trx = await mockPg.transaction();
    try {
      const unlinked = await world(trx, { rides: false });
      const expectedUnlinked = await cadenceDate(trx, unlinked.pestParent.id);
      await extend(trx, unlinked.pestParent.id);
      expect((await extensionRows(trx, unlinked.pestParent.id)).map((r) => dateOf(r.scheduled_date))).toEqual([expectedUnlinked]);
      expect(expectedUnlinked).not.toBe(addDays(unlinked.d0, 84));

      const linked = await world(trx);
      const expectedLinked = await cadenceDate(trx, linked.pestParent.id);
      process.env[GATE] = 'false';
      await extend(trx, linked.pestParent.id);
      expect((await extensionRows(trx, linked.pestParent.id)).map((r) => dateOf(r.scheduled_date))).toEqual([expectedLinked]);
      expect(expectedLinked).not.toBe(addDays(linked.d0, 84));
    } finally { await trx.rollback(); }
  });

  test('the completion wrapper registers the reminder for the kept ride only, after the visit exists', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx);
      await Admin.runRecurringSeriesMaintenance(trx, w.pestParent);
      const [row] = await extensionRows(trx, w.pestParent.id);
      expect(dateOf(row.scheduled_date)).toBe(addDays(w.d0, 84));
      expect(Reminders.registerAppointment).toHaveBeenCalledTimes(1);
      expect(Reminders.registerAppointment.mock.calls[0][0]).toBe(row.id);
    } finally { await trx.rollback(); }
  });

  test('a ride that cannot group registers no reminder for the discarded row (only the walk\'s own row)', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx, { autopay: true });
      await Admin.runRecurringSeriesMaintenance(trx, w.pestParent);
      const rows = await extensionRows(trx, w.pestParent.id);
      expect(rows).toHaveLength(1);
      expect(Reminders.registerAppointment).toHaveBeenCalledTimes(1);
      expect(Reminders.registerAppointment.mock.calls[0][0]).toBe(rows[0].id);
    } finally { await trx.rollback(); }
  });

  test('top-up rides successive lawn dates (each kept, grouped)', async () => {
    const trx = await mockPg.transaction();
    try {
      const w = await world(trx);
      const result = await Admin.topUpRecurringSeriesWithLocks(trx, w.pestParent.id, { horizonDays: 300 });
      expect(result.skipped).toBeNull();
      expect(result.spawnedVisits.length).toBeGreaterThanOrEqual(2);
      const rows = await extensionRows(trx, w.pestParent.id);
      expect(rows.map((r) => dateOf(r.scheduled_date)).slice(0, 2)).toEqual([addDays(w.d0, 84), addDays(w.d0, 168)]);
      for (const row of rows.slice(0, 2)) {
        const host = await trx('scheduled_services')
          .where({ recurring_parent_id: w.lawnParent.id, scheduled_date: row.scheduled_date }).first();
        expect(row.visit_id).not.toBeNull();
        expect(row.visit_id).toBe(host.visit_id);
      }
    } finally { await trx.rollback(); }
  });

  describe('own lawn visit on the candidate date is not a clash (ungated)', () => {
    async function alignedPest(trx, opts = {}) {
      const w = await world(trx, { rides: false, ...opts });
      const date = await cadenceDate(trx, w.pestParent.id);
      return { w, date };
    }
    const lawnVisit = (trx, w, date, extra = {}) => trx('scheduled_services').insert({
      customer_id: w.customerId, property_id: w.propertyId, technician_id: w.techLawn,
      service_id: ids.lawn_care_6week, service_type: 'Every 6 Weeks Lawn Care Service',
      service_key_snapshot: 'lawn_care_6week', scheduled_date: date, status: 'pending',
      window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60, ...extra,
    }).returning('*');

    test('lands on the date and groups with the customer\'s own lawn visit', async () => {
      process.env[GATE] = 'false'; // proves the fix is ungated
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        const [lawn] = await lawnVisit(trx, w, date);
        const spawned = await extend(trx, w.pestParent.id);
        expect(spawned && spawned.scheduledDate).toBe(date);
        const [row] = await extensionRows(trx, w.pestParent.id);
        expect(dateOf(row.scheduled_date)).toBe(date);
        const host = await trx('scheduled_services').where({ id: lawn.id }).first();
        expect(row.visit_id).not.toBeNull();
        expect(row.visit_id).toBe(host.visit_id);
      } finally { await trx.rollback(); }
    });

    test('another customer\'s visit on the date still pushes the extension', async () => {
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        const other = await customer(trx);
        await trx('scheduled_services').insert({
          customer_id: other.customerId, property_id: other.propertyId, technician_id: w.techLawn,
          service_id: ids.lawn_care_6week, service_type: 'Every 6 Weeks Lawn Care Service',
          scheduled_date: date, status: 'pending', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
        });
        await extend(trx, w.pestParent.id);
        const rows = await extensionRows(trx, w.pestParent.id);
        expect(rows).toHaveLength(1);
        expect(dateOf(rows[0].scheduled_date)).not.toBe(date);
      } finally { await trx.rollback(); }
    });

    test('an own visit it cannot join (different technician) still pushes it and leaves no row behind', async () => {
      const trx = await mockPg.transaction();
      try {
        const pestTech = await technician(trx);
        const { w, date } = await alignedPest(trx, { pestTech });
        await lawnVisit(trx, w, date); // lawn tech differs from the pest template's tech
        const before = await trx('scheduled_services').where({ customer_id: w.customerId }).count('* as n').first();
        await extend(trx, w.pestParent.id);
        const rows = await extensionRows(trx, w.pestParent.id);
        expect(rows).toHaveLength(1);
        expect(dateOf(rows[0].scheduled_date)).not.toBe(date);
        const after = await trx('scheduled_services').where({ customer_id: w.customerId }).count('* as n').first();
        expect(Number(after.n)).toBe(Number(before.n) + 1);
        expect(await trx('scheduled_services').where({ customer_id: w.customerId, scheduled_date: date, service_id: ids.pest_general_quarterly }).first()).toBeUndefined();
      } finally { await trx.rollback(); }
    });

    test('an own visit plus a hold on the date is a clash (not own-only)', async () => {
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        await lawnVisit(trx, w, date);
        await trx('scheduled_services').insert({
          customer_id: null, scheduled_date: date, status: 'pending', service_type: 'Hold',
          window_start: '09:00', window_end: '10:00', reservation_expires_at: new Date(Date.now() + 3600e3),
        });
        await extend(trx, w.pestParent.id);
        const rows = await extensionRows(trx, w.pestParent.id);
        expect(rows).toHaveLength(1);
        expect(dateOf(rows[0].scheduled_date)).not.toBe(date);
      } finally { await trx.rollback(); }
    });

    test('top-up (advisory overlap) keeps inserting on the cadence date and still groups', async () => {
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        const [lawn] = await lawnVisit(trx, w, date);
        const result = await Admin.topUpRecurringSeriesWithLocks(trx, w.pestParent.id, { horizonDays: 120 });
        expect(result.skipped).toBeNull();
        const first = (await extensionRows(trx, w.pestParent.id))[0];
        expect(dateOf(first.scheduled_date)).toBe(date);
        const host = await trx('scheduled_services').where({ id: lawn.id }).first();
        expect(first.visit_id).toBe(host.visit_id);
      } finally { await trx.rollback(); }
    });
  });

  describe('post-commit work waits for a KEPT row and the outer commit', () => {
    // A controllable "outer commit": the caller's transaction promise.
    function controlledCommit(trx) {
      let commit;
      let rollback;
      const outer = new Promise((resolve, reject) => { commit = resolve; rollback = reject; });
      outer.catch(() => {});
      Object.defineProperty(trx, 'executionPromise', { value: outer, configurable: true });
      return { commit, rollback };
    }
    const settle = () => new Promise((resolve) => setImmediate(resolve));

    async function prepaidWorld(trx, opts) {
      const w = await world(trx, opts);
      const [term] = await trx('annual_prepay_terms').insert({
        customer_id: w.customerId, plan_label: 'Synthetic Prepay', monthly_rate: 30, prepay_amount: 360,
        term_start: addDays(w.d0, -1), term_end: addDays(w.d0, 400), status: 'active',
        coverage_service_type: 'Quarterly Pest Control', coverage_visit_count: 4, coverage_cadence: 'quarterly',
      }).returning('*');
      await trx('scheduled_services').where({ id: w.pestParent.id }).update({ annual_prepay_term_id: term.id });
      return w;
    }

    function spies() {
      const apply = jest.spyOn(Renewals, 'applyPrepaidCoverageForTerm').mockRejectedValue(new Error('coverage boom'));
      const fired = [];
      const file = jest.spyOn(Renewals._private, 'fileCoverageExceptionAfterCommit')
        .mockImplementation(async (scope) => {
          // The real gate: file only when the scope's promise resolves.
          scope.executionPromise.then(() => fired.push('filed'), () => {});
        });
      return { apply, fired, file };
    }

    test('a kept ride files its alert only after the outer commit', async () => {
      const trx = await mockPg.transaction();
      const { apply, fired, file } = spies();
      try {
        const w = await prepaidWorld(trx);
        const outer = controlledCommit(trx);
        const spawned = await extend(trx, w.pestParent.id);
        expect(dateOf(spawned.scheduledDate)).toBe(addDays(w.d0, 84));
        expect(apply).toHaveBeenCalled();
        await settle();
        expect(fired).toEqual([]); // kept, but the caller has not committed
        outer.commit();
        await settle();
        expect(fired).toEqual(['filed']);
      } finally { apply.mockRestore(); file.mockRestore(); await trx.rollback(); }
    });

    test('a rolled-back ride files nothing, even when the outer transaction commits', async () => {
      const trx = await mockPg.transaction();
      const { apply, fired, file } = spies();
      try {
        const w = await prepaidWorld(trx, { autopay: true }); // the ride cannot group -> rolled back
        const outer = controlledCommit(trx);
        const scopes = [];
        file.mockImplementation(async (scope) => {
          scopes.push(scope);
          scope.executionPromise.then(() => fired.push(String(scopes.length)), () => {});
        });
        await extend(trx, w.pestParent.id);
        outer.commit();
        await settle();
        // Two coverage passes ran (the thrown-away ride attempt, then the
        // walk's own insert); only the walk's alert may ever fire.
        expect(scopes.length).toBe(2);
        expect(fired).toEqual(['2']);
      } finally { apply.mockRestore(); file.mockRestore(); await trx.rollback(); }
    });

    test('a thrown-away own-lawn clash attempt files nothing; the pushed row\'s alert follows the commit', async () => {
      const trx = await mockPg.transaction();
      const { apply, fired, file } = spies();
      try {
        const pestTech = await technician(trx);
        const w = await prepaidWorld(trx, { rides: false, pestTech });
        process.env[GATE] = 'false';
        const date = await cadenceDate(trx, w.pestParent.id);
        await trx('scheduled_services').insert({
          customer_id: w.customerId, property_id: w.propertyId, technician_id: w.techLawn,
          service_id: ids.lawn_care_6week, service_type: 'Every 6 Weeks Lawn Care Service',
          scheduled_date: date, status: 'pending', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
        });
        const outer = controlledCommit(trx);
        const scopes = [];
        file.mockImplementation(async (scope) => {
          scopes.push(scope);
          scope.executionPromise.then(() => fired.push(String(scopes.length)), () => {});
        });
        const spawned = await extend(trx, w.pestParent.id);
        expect(spawned.scheduledDate).not.toBe(date);
        outer.commit();
        await settle();
        expect(scopes.length).toBe(2);
        expect(fired).toEqual(['2']);
      } finally { apply.mockRestore(); file.mockRestore(); await trx.rollback(); }
    });
  });
});
