/**
 * Series EXTENSION and the customer's own stop: when the next cadence date
 * already holds the customer's OWN visit, admin-schedule.js#extendSeriesOnceLocked
 * tries to land the new row in that visit (grouped-or-nothing); another
 * customer's visit, a hold, two technicians, or a visit the row cannot join
 * still push it to a later date. Real Postgres on the migrated schema,
 * synthetic customers, every test rolled back. Moved out of the retired rider
 * suite (rider-extension-path-postgres.test.js) because this path is not a
 * rider path.
 *
 * Also: post-commit work (coverage alerts) fires only for a KEPT row, and
 * only after the caller's transaction commits (deferredCommitScope).
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

const addDays = (d, n) => etDateString(addETDays(parseETDateTime(`${d}T12:00`), n));
const dateOf = (v) => (v instanceof Date ? etDateString(v) : String(v).slice(0, 10));

postgres('series extension and the customer\'s own stop', () => {
  let gates;
  let Admin;
  let Renewals;
  let originalVisitGroups;
  let ids;

  beforeAll(async () => {
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !privateQa) throw new Error('Use disposable CI or this worktree\'s private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    gates = require('../config/feature-gates').gates;
    Admin = require('../routes/admin-schedule');
    Renewals = require('../services/annual-prepay-renewals');
    const catalog = await mockPg('services').whereIn('service_key', ['lawn_care_6week', 'pest_general_quarterly']).select('id', 'service_key');
    ids = Object.fromEntries(catalog.map((r) => [r.service_key, r.id]));
  });


  beforeEach(() => {
    originalVisitGroups = gates.visitGroups;
    Object.assign(gates, { visitGroups: true });
  });

  afterEach(() => {
    Object.assign(gates, { visitGroups: originalVisitGroups });
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
  // days) and a quarterly pest series whose first visit D0 is also finished.
  async function world(trx, {
    autopay = false, pestTech = null, lawnTech = null, pestSkipWeekends = false,
    pestWindow = ['09:00', '10:00'], lawnWindow = ['09:00', '10:00'], pestExtra = {},
    // d0Back: how long ago the (completed) first visits were; lawnDates: explicit
    // lawn child dates instead of every 42 days; lawnParentExtra / lawnChildExtra:
    // extra columns on the lawn root / each lawn child.
    d0Back = 7, lawnDates = null, lawnParentExtra = {}, lawnChildExtra = {}, base: passedBase = null,
  } = {}) {
    const base = passedBase || await customer(trx, { autopay });
    const techLawn = lawnTech || await technician(trx);
    const d0 = weekdayBack(d0Back);
    const lawnRow = (extra) => ({
      customer_id: base.customerId, property_id: base.propertyId, technician_id: techLawn,
      service_id: ids.lawn_care_6week, service_type: 'Every 6 Weeks Lawn Care Service',
      service_key_snapshot: 'lawn_care_6week', window_start: lawnWindow[0], window_end: lawnWindow[1],
      estimated_duration_minutes: 60, estimated_price: 60, recurring_pattern: 'every_6_weeks',
      is_recurring: true, recurring_ongoing: true, ...extra,
    });
    const [lawnParent] = await trx('scheduled_services').insert(lawnRow({
      scheduled_date: d0, status: 'completed', ...lawnParentExtra,
    })).returning('*');
    const lawnChildren = [];
    for (const date of lawnDates || Array.from({ length: 12 }, (_, i) => addDays(d0, 42 * (i + 1)))) {
      const [child] = await trx('scheduled_services').insert(lawnRow({
        scheduled_date: date, status: 'pending', recurring_parent_id: lawnParent.id, ...lawnChildExtra,
      })).returning('*');
      lawnChildren.push(child);
    }
    const [pestParent] = await trx('scheduled_services').insert({
      customer_id: base.customerId, property_id: base.propertyId, technician_id: pestTech,
      service_id: ids.pest_general_quarterly, service_type: 'Quarterly Pest Control Service',
      service_key_snapshot: 'pest_general_quarterly', scheduled_date: d0, status: 'completed',
      window_start: pestWindow[0], window_end: pestWindow[1], estimated_duration_minutes: 60,
      estimated_price: 120, recurring_pattern: 'quarterly', is_recurring: true, recurring_ongoing: true,
      create_invoice_on_complete: true, skip_weekends: pestSkipWeekends, ...pestExtra,
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

  // Where the plain cadence walk would put the next visit: the same extension,
  // inside a savepoint that is thrown away.
  async function cadenceDate(trx, parentId) {
    let found = null;
    try {
      await trx.transaction(async (sp) => {
        const spawned = await extend(sp, parentId);
        found = spawned && spawned.scheduledDate;
        throw new Error('probe rollback');
      });
    } catch (err) { if (err.message !== 'probe rollback') throw err; }
    return found;
  }

  const extensionRows = (trx, parentId) => trx('scheduled_services').where({ recurring_parent_id: parentId }).orderBy('scheduled_date');


  describe('own lawn visit on the candidate date is not a clash', () => {
    async function alignedPest(trx, opts = {}) {
      const w = await world(trx, opts);
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

    test('an own visit on a different technician than the template: joins that stop on the STOP\'s technician (nobody re-assigned)', async () => {
      const trx = await mockPg.transaction();
      try {
        const pestTech = await technician(trx);
        const { w, date } = await alignedPest(trx, { pestTech });
        const [lawn] = await lawnVisit(trx, w, date); // lawn tech differs from the pest template's tech
        await extend(trx, w.pestParent.id);
        const [row] = await extensionRows(trx, w.pestParent.id);
        expect(dateOf(row.scheduled_date)).toBe(date);
        expect(String(row.technician_id)).toBe(String(lawn.technician_id));
        const host = await trx('scheduled_services').where({ id: lawn.id }).first();
        expect(row.visit_id).toBeTruthy();
        expect(String(row.visit_id)).toBe(String(host.visit_id));
        expect(String(host.technician_id)).toBe(String(lawn.technician_id)); // the lawn visit kept its tech
      } finally { await trx.rollback(); }
    });

    test('own visits on two different technicians are not one stop: still a clash, no row left behind', async () => {
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        await lawnVisit(trx, w, date);
        const otherTech = await technician(trx);
        await lawnVisit(trx, w, date, { technician_id: otherTech, window_start: '09:30', window_end: '10:30' });
        await extend(trx, w.pestParent.id);
        const rows = await extensionRows(trx, w.pestParent.id);
        expect(rows).toHaveLength(1);
        expect(dateOf(rows[0].scheduled_date)).not.toBe(date);
        expect(await trx('scheduled_services').where({ customer_id: w.customerId, scheduled_date: date, service_id: ids.pest_general_quarterly }).first()).toBeUndefined();
      } finally { await trx.rollback(); }
    });

    test('an own visit it cannot join (grouping refused for an autopay customer) still pushes it and leaves no row behind', async () => {
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx, { autopay: true });
        await lawnVisit(trx, w, date);
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

    test('deferredCommitScope: a kept scope inside a savepoint that later ROLLS BACK never fires, even when the root commits', async () => {
      const { deferredCommitScope } = require('../utils/trx-commit-promise');
      const state = (p) => Promise.race([p.then(() => 'fired', () => 'dropped'), settle().then(() => 'waiting')]);
      // Kept, then the enclosing savepoint rolls back.
      const root = await mockPg.transaction();
      try {
        const mid = await root.transaction();
        const scope = deferredCommitScope(mid);
        scope.keep();
        await mid.rollback(new Error('enclosing work failed'));
        expect(await state(scope.executionPromise)).toBe('dropped');
      } finally { await root.rollback().catch(() => {}); }
      // Kept, then the enclosing savepoint is rolled back WITHOUT an error —
      // knex resolves (not rejects) that promise; it must still be dropped.
      const root1 = await mockPg.transaction();
      try {
        const mid1 = await root1.transaction();
        const scope1 = deferredCommitScope(mid1);
        scope1.keep();
        await mid1.rollback();
        await root1.commit();
        expect(await state(scope1.executionPromise)).toBe('dropped');
      } finally { await root1.rollback().catch(() => {}); }
      // Kept, savepoint released: still waits for the root, then fires on its commit.
      const root2 = await mockPg.transaction();
      const mid2 = await root2.transaction();
      const scope2 = deferredCommitScope(mid2);
      scope2.keep();
      await mid2.commit();
      expect(await state(scope2.executionPromise)).toBe('waiting');
      await root2.commit();
      expect(await state(scope2.executionPromise)).toBe('fired');
    });

    test('a thrown-away own-lawn clash attempt files nothing; the pushed row\'s alert follows the commit', async () => {
      const trx = await mockPg.transaction();
      const { apply, fired, file } = spies();
      try {
        // Visit groups refuse an autopay customer, so the own-lawn attempt is thrown away.
        const w = await prepaidWorld(trx, { autopay: true });
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
