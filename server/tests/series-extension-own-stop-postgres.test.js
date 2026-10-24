/**
 * Series EXTENSION and a visit already on the cadence date. Grouping is
 * retired (2026-10-22) and a clash never skips a cadence slot (2026-10-23), so
 * admin-schedule.js#extendSeriesOnceLocked puts the new row on its cadence
 * date and joins nothing: the customer's own stop at the same place keeps the
 * hour (one trip); another customer's stop in the hour hands it off without a
 * time (GATE_PLAN_TAKEN_HOUR_HANDOFF) or, gate off, books through with the
 * overlap logged. Real Postgres on the migrated schema, synthetic customers,
 * every test rolled back.
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
  let Admin;
  let Renewals;
  let ids;

  beforeAll(async () => {
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!localCI && !privateQa) throw new Error('Use disposable CI or this worktree\'s private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    Admin = require('../routes/admin-schedule');
    Renewals = require('../services/annual-prepay-renewals');
    const catalog = await mockPg('services').whereIn('service_key', ['lawn_care_6week', 'pest_general_quarterly']).select('id', 'service_key');
    ids = Object.fromEntries(catalog.map((r) => [r.service_key, r.id]));
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


  describe('a visit on the candidate date never moves the extension', () => {
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
    const otherCustomersVisit = async (trx, w, date) => {
      const other = await customer(trx);
      await trx('scheduled_services').insert({
        customer_id: other.customerId, property_id: other.propertyId, technician_id: w.techLawn,
        service_id: ids.lawn_care_6week, service_type: 'Every 6 Weeks Lawn Care Service',
        scheduled_date: date, status: 'pending', window_start: '09:00', window_end: '10:00', estimated_duration_minutes: 60,
      });
    };
    afterEach(() => { delete process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF; });

    test('books the date of the customer\'s own lawn visit, keeps the hour (one trip) and joins nothing', async () => {
      process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        const [lawn] = await lawnVisit(trx, w, date);
        const spawned = await extend(trx, w.pestParent.id);
        expect(spawned && spawned.scheduledDate).toBe(date);
        const rows = await extensionRows(trx, w.pestParent.id);
        expect(rows).toHaveLength(1);
        expect(dateOf(rows[0].scheduled_date)).toBe(date);
        expect(String(rows[0].window_start).slice(0, 5)).toBe('09:00');
        expect(rows[0].visit_id).toBeNull();
        expect((await trx('scheduled_services').where({ id: lawn.id }).first()).visit_id).toBeNull();
        expect(await trx('service_visits').where({ customer_id: w.customerId }).first()).toBeUndefined();
      } finally { await trx.rollback(); }
    });

    test('another customer\'s visit in the hour, hand-off off: books through on the cadence date with the hour', async () => {
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        await otherCustomersVisit(trx, w, date);
        await extend(trx, w.pestParent.id);
        const rows = await extensionRows(trx, w.pestParent.id);
        expect(rows).toHaveLength(1);
        expect(dateOf(rows[0].scheduled_date)).toBe(date);
        expect(String(rows[0].window_start).slice(0, 5)).toBe('09:00');
      } finally { await trx.rollback(); }
    });

    test('another customer\'s visit in the hour, hand-off on: the cadence date without a time, due that date', async () => {
      process.env.GATE_PLAN_TAKEN_HOUR_HANDOFF = 'true';
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        await otherCustomersVisit(trx, w, date);
        await extend(trx, w.pestParent.id);
        const rows = await extensionRows(trx, w.pestParent.id);
        expect(rows).toHaveLength(1);
        expect(dateOf(rows[0].scheduled_date)).toBe(date);
        expect(rows[0].window_start).toBeNull();
        expect(dateOf(rows[0].recurring_dispatch_due_date)).toBe(date);
      } finally { await trx.rollback(); }
    });

    test('top-up keeps inserting on the cadence date, ungrouped', async () => {
      const trx = await mockPg.transaction();
      try {
        const { w, date } = await alignedPest(trx);
        await lawnVisit(trx, w, date);
        const result = await Admin.topUpRecurringSeriesWithLocks(trx, w.pestParent.id, { horizonDays: 120 });
        expect(result.skipped).toBeNull();
        const first = (await extensionRows(trx, w.pestParent.id))[0];
        expect(dateOf(first.scheduled_date)).toBe(date);
        expect(first.visit_id).toBeNull();
      } finally { await trx.rollback(); }
    });
  });

  describe('post-commit work waits for the outer commit', () => {
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

    test('an own lawn visit on the date files one alert, for the new row on that date, after the commit', async () => {
      const trx = await mockPg.transaction();
      const { apply, fired, file } = spies();
      try {
        const w = await prepaidWorld(trx);
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
        expect(spawned.scheduledDate).toBe(date);
        outer.commit();
        await settle();
        // One coverage pass: the new row's, on the cadence date.
        expect(scopes.length).toBe(1);
        expect(fired).toEqual(['1']);
      } finally { apply.mockRestore(); file.mockRestore(); await trx.rollback(); }
    });
  });
});
