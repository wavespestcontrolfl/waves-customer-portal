/**
 * Real accept-side conversion on the migrated schema, then the combined-booking
 * sweep over what it wrote. Each case rolls back.
 */
jest.mock('../models/db', () => new Proxy((...args) => mockPg(...args), {
  get: (_, key) => typeof mockPg[key] === 'function' ? mockPg[key].bind(mockPg) : mockPg[key],
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: async () => false, sendNewRecurringWelcome: jest.fn(),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn() }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: async () => {} }));
jest.mock('../services/inspection-credit', () => ({ markBookingForInspectionCredit: async () => {} }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  isBlackoutDate: async () => false, getBlackoutLayers: async () => ({ dates: new Set() }),
  lockClosureState: jest.requireActual('../services/scheduling/blackout-dates').lockClosureState,
}));
jest.mock('../services/slot-zone', () => ({ resolveEstimateZone: async () => null, zoneSlugOf: () => null }));
const mockTestCustomerIds = new Set();
jest.mock('../services/internal-test-customers', () => ({
  ...jest.requireActual('../services/internal-test-customers'),
  isInternalTestCustomerId: (id) => mockTestCustomerIds.has(String(id)),
}));

const knex = require('knex');
const { randomUUID } = require('node:crypto');
const converter = require('../services/estimate-converter');
const { runCombinedBookingCheck } = require('../services/combined-booking-check');

const connection = process.env.COMBINED_VISIT_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(120000);

const lines = [
  { service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly', annual: 600, mo: 50, perTreatment: 150, catalog: 'pest_general_quarterly' },
  { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6, frequency: 'bimonthly', annual: 600, mo: 50, perTreatment: 100, catalog: 'lawn_care_recurring' },
];
const options = { skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true,
  deferFollowUpReminderRegistration: true, deferCommercialScheduleNotification: true };

async function acceptedEstimate(trx, selected) {
  for (const line of selected) {
    if (!await trx('services').where({ service_key: line.catalog }).first('id')) {
      await trx('services').insert({ id: randomUUID(), service_key: line.catalog, name: line.name,
        category: line.service, billing_type: 'recurring', is_active: true, default_duration_minutes: 60 });
    }
  }
  const customerId = randomUUID();
  const estimateId = randomUUID();
  await trx('customers').insert({ id: customerId, first_name: 'Jordan', last_name: 'Sample',
    email: `${customerId}@example.invalid`, phone: '+19415550100', active: true, property_type: 'residential',
    address_line1: '100 Example Court', city: 'Parrish', state: 'FL', zip: '34219',
    pipeline_stage: 'active_customer', autopay_enabled: false });
  await trx('estimates').insert({ id: estimateId, customer_id: customerId, status: 'accepted',
    accepted_at: new Date(Date.now() - 20 * 60 * 1000), accepted_service_mode: 'recurring',
    token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
    category: 'RESIDENTIAL', monthly_total: selected.length * 50, annual_total: selected.length * 600,
    estimate_data: { customerSelection: { frequency: 'quarterly' },
      result: { recurring: { services: selected.map(({ catalog, ...line }) => line) } } } });
  await converter.convertEstimate(estimateId, { ...options, database: trx });
  return { customerId, estimateId };
}

const rowsOf = (trx, estimateId) => trx('scheduled_services').where({ source_estimate_id: estimateId })
  .orWhereIn('recurring_parent_id', trx('scheduled_services').select('id').where({ source_estimate_id: estimateId }));
const alertsOf = (trx, estimateId) => trx('notifications')
  .where({ recipient_type: 'admin', category: 'alert' }).whereRaw("metadata->>'estimateId' = ?", [estimateId]);


// What the office does to a bad booking: a time and technician on every visit.
async function repair(trx, { estimateId }) {
  const technicianId = randomUUID();
  await trx('technicians').insert({ id: technicianId, name: 'Synthetic Technician',
    email: `${technicianId}@example.invalid`, password_hash: 'synthetic-not-a-login-hash', role: 'technician',
    active: true, employment_status: 'active', field_dispatchable: true });
  await trx('scheduled_services').whereIn('id', (await rowsOf(trx, estimateId)).map((row) => row.id))
    .update({ window_start: '10:00', window_end: '11:00', technician_id: technicianId });
}

postgres('combined-booking check through the real conversion', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!local && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use the verified private dev database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('a pest + lawn accept with unassigned companions rings once, stays quiet on re-check, and closes as done when fixed', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const { estimateId, customerId } = await acceptedEstimate(trx, lines);
      const before = await rowsOf(trx, estimateId);
      expect(before.length).toBeGreaterThanOrEqual(10);

      const first = await runCombinedBookingCheck({ conn: trx });
      expect(first).toMatchObject({ checked: 1, problems: 1, ok: 0, failed: 0 });
      const [alert] = await alertsOf(trx, estimateId);
      expect(alert.title).toBe("Schedule — fix J. Sample's combined booking");
      expect(alert.body).toMatch(/missing time\/tech/);
      expect(alert.body.length).toBeLessThanOrEqual(110);
      expect(alert.link).toBe(`/admin/customers?customerId=${customerId}`);
      expect(alert.read_at).toBeNull();
      expect(alert.done_at).toBeNull();
      expect(alert.metadata).toMatchObject({ area: 'Schedule', severity: 'needs-you', who: 'person',
        doneWhen: 'combined_booking_verified', subject: { type: 'estimate', id: estimateId } });
      expect(alert.metadata.problemCodes).toContain('missing_time_tech');

      // Same state again: still one row, not re-rung.
      const second = await runCombinedBookingCheck({ conn: trx });
      expect(second.problems).toBe(1);
      const afterSecond = await alertsOf(trx, estimateId);
      expect(afterSecond).toHaveLength(1);
      expect(afterSecond[0].id).toBe(alert.id);
      expect(afterSecond[0].read_at).toBeNull();

      await repair(trx, { customerId, estimateId });
      const third = await runCombinedBookingCheck({ conn: trx });
      expect(third).toMatchObject({ checked: 0, ok: 1, problems: 0, closed: 1, failed: 0 });
      const closed = await alertsOf(trx, estimateId);
      expect(closed).toHaveLength(1); // an OK writes no row of its own
      expect(closed[0].id).toBe(alert.id);
      expect(closed[0].done_at).not.toBeNull();
      expect(closed[0].done_by).toBe('combined-booking-check');
      expect(closed[0].read_at).not.toBeNull();
      expect(closed[0].metadata.dedupeKey).toBeUndefined();

      // Next run: fixed and no open bell, so not even a candidate; nothing reopens.
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0, problems: 0, closed: 0 });
      expect(await alertsOf(trx, estimateId)).toHaveLength(1);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a single-service accept posts nothing', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const single = await acceptedEstimate(trx, lines.slice(0, 1));
      const result = await runCombinedBookingCheck({ conn: trx });
      expect(result).toMatchObject({ checked: 0, skipped: 1, problems: 0 });
      expect(await alertsOf(trx, single.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a plan the office cancelled posts nothing, and retires a bell it had already rung', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const { estimateId } = await acceptedEstimate(trx, lines);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      const [rung] = await alertsOf(trx, estimateId);
      expect(rung.read_at).toBeNull();
      await trx('scheduled_services').whereIn('id', (await rowsOf(trx, estimateId)).map((row) => row.id)).update({ status: 'cancelled' });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ checked: 0, skipped: 1, problems: 0, closed: 1, failed: 0 });
      const rows = await alertsOf(trx, estimateId);
      expect(rows).toHaveLength(1);
      expect(rows[0].read_at).not.toBeNull();
      expect(rows[0].done_at).not.toBeNull();
      expect(rows[0].metadata.resolved).toBe(true);
      expect(rows[0].metadata.dedupeKey).toBeUndefined();

      // The same problem coming back rings a fresh bell, never the retired row.
      await trx('scheduled_services').whereIn('id', (await rowsOf(trx, estimateId)).map((row) => row.id)).update({ status: 'pending' });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1, failed: 0 });
      const again = await alertsOf(trx, estimateId);
      expect(again).toHaveLength(2);
      const fresh = again.find((row) => row.id !== rung.id);
      expect(fresh.read_at).toBeNull();
      expect(fresh.done_at).toBeNull();
      expect(fresh.metadata.resolved).toBeUndefined();

      const churned = await acceptedEstimate(trx, lines);
      await trx('scheduled_services').whereIn('id', (await rowsOf(trx, churned.estimateId)).map((row) => row.id)).update({ status: 'cancelled' });
      await runCombinedBookingCheck({ conn: trx });
      expect(await alertsOf(trx, churned.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a schedule-shape gap is left to the accepted-schedule classifier: no second bell, no OK', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      const parents = await trx('scheduled_services').where({ source_estimate_id: est.estimateId }).whereNull('recurring_parent_id');
      await trx('scheduled_services').whereIn('recurring_parent_id', parents.filter((row) => /pest/i.test(row.service_type)).map((row) => row.id)).del();
      const coverage = new Map();
      const gaps = await require('../services/recurring-schedule-audit')
        .acceptedRecurringScheduleGaps(trx, { now: new Date(), cutoff: new Date(), estimateIds: [est.estimateId], coverage });
      expect(gaps.map((gap) => gap.serviceFamily)).toEqual(['pest_control']);
      // Judged, with no family skipped.
      expect([...coverage.get(String(est.estimateId)).skipped]).toEqual([]);
      expect([...coverage.get(String(est.estimateId)).onHold]).toEqual([]);
      // The watchdog's own 24h-settled call does not see a 20-minute-old accept yet.
      expect(await require('../services/recurring-schedule-audit').findAcceptedRecurringScheduleGaps({}, trx)
        .then((all) => all.filter((gap) => gap.estimateId === est.estimateId))).toEqual([]);
      // Every upcoming visit is timed: this check has nothing to say (the gap is the classifier's alert).
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0, problems: 0, ok: 0, failed: 0 });
      expect(await alertsOf(trx, est.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('every problem gets its own bell in the same run while the ring budget has room', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const all = [];
      for (let i = 0; i < 3; i += 1) all.push(await acceptedEstimate(trx, lines));
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 3, failed: 0 });
      for (const est of all) expect(await alertsOf(trx, est.estimateId)).toHaveLength(1);
      // A standing problem refreshes its own bell, never a second one.
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 3 });
      for (const est of all) expect(await alertsOf(trx, est.estimateId)).toHaveLength(1);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('past the ring budget a problem is left for a later run, where the same upcoming problem is found again', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const all = [];
      for (let i = 0; i < 3; i += 1) all.push(await acceptedEstimate(trx, lines));
      expect(await runCombinedBookingCheck({ conn: trx, ringBudget: 1 })).toMatchObject({ problems: 1, held: 2 });
      const bells = async () => (await Promise.all(all.map((est) => alertsOf(trx, est.estimateId)))).map((rows) => rows.length);
      expect((await bells()).reduce((a, b) => a + b, 0)).toBe(1);
      // Days later (accepted well past any window): the held ones still have the problem, so they ring now.
      await trx('estimates').whereIn('id', all.map((est) => est.estimateId)).update({ accepted_at: new Date(Date.now() - 100 * 3600 * 1000) });
      expect(await runCombinedBookingCheck({ conn: trx, ringBudget: 10 })).toMatchObject({ problems: 3, held: 0 });
      expect(await bells()).toEqual([1, 1, 1]);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('with no budget left a visit due TODAY still rings (tomorrow it is history); later ones wait', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const soon = await acceptedEstimate(trx, lines);
      const later = await acceptedEstimate(trx, lines);
      await repair(trx, soon);
      const today = require('../utils/datetime-et').etDateString(new Date());
      const lawnChild = (await rowsOf(trx, soon.estimateId)).find((row) => row.recurring_parent_id && /lawn/i.test(row.service_type));
      await trx('scheduled_services').where({ id: lawnChild.id }).update({ technician_id: null, scheduled_date: today });
      expect(await runCombinedBookingCheck({ conn: trx, ringBudget: 0 })).toMatchObject({ problems: 1, held: 1 });
      expect(await alertsOf(trx, soon.estimateId)).toHaveLength(1);
      expect(await alertsOf(trx, later.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('the hourly urgent pass rings a visit due tomorrow and leaves far-off problems to the daily run', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const { etDateString } = require('../utils/datetime-et');
      const tomorrow = etDateString(new Date(Date.now() + 86400000));
      const near = await acceptedEstimate(trx, lines);
      await repair(trx, near);
      const far = await acceptedEstimate(trx, lines);
      await repair(trx, far);
      const childOf = async (est) => (await rowsOf(trx, est.estimateId)).find((row) => row.recurring_parent_id && /lawn/i.test(row.service_type));
      await trx('scheduled_services').where({ id: (await childOf(near)).id }).update({ technician_id: null, scheduled_date: tomorrow });
      await trx('scheduled_services').where({ id: (await childOf(far)).id }).update({ technician_id: null, scheduled_date: '2099-06-01' });
      // A visit completed today with no technician recorded is finished work: not a candidate.
      const done = await acceptedEstimate(trx, lines);
      await repair(trx, done);
      await trx('scheduled_services').where({ id: (await childOf(done)).id })
        .update({ technician_id: null, status: 'completed', scheduled_date: etDateString(new Date()) });
      expect(await runCombinedBookingCheck({ conn: trx, urgentOnly: true })).toMatchObject({ candidates: 1, problems: 1 });
      expect(await alertsOf(trx, near.estimateId)).toHaveLength(1);
      expect(await alertsOf(trx, far.estimateId)).toHaveLength(0);
      // The daily run with no budget left: tomorrow's is already standing, the far one waits.
      expect(await runCombinedBookingCheck({ conn: trx, ringBudget: 0 })).toMatchObject({ held: 1 });
      expect(await alertsOf(trx, far.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a standing bell gaining a problem past the budget is left untouched until a run with room rings it', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    const { raiseAdminAlert } = jest.requireActual('../services/admin-alert-compose');
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      const rows = await rowsOf(trx, est.estimateId);
      const childOf = (pattern) => rows.find((row) => row.recurring_parent_id && pattern.test(row.service_type));
      await trx('scheduled_services').where({ id: childOf(/lawn/i).id }).update({ technician_id: null });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      const [before] = await alertsOf(trx, est.estimateId);
      expect(before.metadata.itemKeys).toEqual(['lawn_care']);
      await trx('notifications').where({ id: before.id }).update({ read_at: new Date() });
      // A new service family goes untimed (a pest visit) with no budget left.
      await trx('scheduled_services').where({ id: childOf(/pest/i).id }).update({ technician_id: null });
      expect(await runCombinedBookingCheck({ conn: trx, ringBudget: 0 })).toMatchObject({ held: 1 });
      expect((await alertsOf(trx, est.estimateId))[0].read_at).not.toBeNull(); // not refreshed in silence

      // A failed write is counted and logged; the problem is found again next run.
      const failing = jest.fn(async () => null);
      expect(await runCombinedBookingCheck({ conn: trx, ringBudget: 10, raise: failing })).toMatchObject({ failed: 1 });

      // With budget: it rings.
      expect(await runCombinedBookingCheck({ conn: trx, ringBudget: 10, raise: raiseAdminAlert })).toMatchObject({ problems: 1, held: 0 });
      const [after] = await alertsOf(trx, est.estimateId);
      expect(after.read_at).toBeNull();
      expect(after.metadata.itemKeys).toEqual(['pest_control', 'lawn_care']);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('an open bell keeps its estimate judged whenever it was accepted, so a later fix still closes it', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      await trx('estimates').where({ id: est.estimateId }).update({ accepted_at: new Date(Date.now() - 100 * 3600 * 1000) });
      await repair(trx, est);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ ok: 1, closed: 1 });
      expect((await alertsOf(trx, est.estimateId))[0].done_at).not.toBeNull();
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a booking with every upcoming visit timed is not even a candidate; a past untimed visit is history', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0 });
      const anyRow = (await rowsOf(trx, est.estimateId))[0];
      await trx('scheduled_services').where({ id: anyRow.id }).update({ technician_id: null, scheduled_date: '2020-01-06' });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0 });
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('an internal test customer is never judged', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      mockTestCustomerIds.add(est.customerId);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0, problems: 0 });
      expect(await alertsOf(trx, est.estimateId)).toHaveLength(0);
    } finally {
      mockTestCustomerIds.clear();
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a finding about a service that goes on hold stays on its bell; after the hold the service is judged again', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      const lawnChild = (await rowsOf(trx, est.estimateId)).find((row) => row.recurring_parent_id && /lawn/i.test(row.service_type));
      await trx('scheduled_services').where({ id: lawnChild.id }).update({ technician_id: null });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      const today = new Date().toISOString().slice(0, 10);
      const later = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const [hold] = await trx('plan_holds').insert({ customer_id: est.customerId, family_key: 'lawn_care',
        starts_on: new Date(Date.now() - 86400000).toISOString().slice(0, 10), resume_on: later, status: 'active' }).returning('id');
      // Lawn on hold, pest clean: the lawn finding is kept (marked), not closed as fixed.
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1, closed: 0 });
      const [held] = await alertsOf(trx, est.estimateId);
      expect(held.done_at).toBeNull();
      expect(held.body).toMatch(/on hold/);
      // The hold ends with the lawn visit fixed: the bell closes.
      await trx('plan_holds').where({ id: hold.id || hold }).update({ status: 'resumed', resumed_at: new Date(), resume_on: today });
      await trx('scheduled_services').where({ id: lawnChild.id }).update({ technician_id: (await rowsOf(trx, est.estimateId))[0].technician_id });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ ok: 1, closed: 1 });
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a booking corrected to a single service closes its open bell', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      const estimateRow = await trx('estimates').where({ id: est.estimateId }).first('estimate_data');
      const data = typeof estimateRow.estimate_data === 'string' ? JSON.parse(estimateRow.estimate_data) : estimateRow.estimate_data;
      data.result.recurring.services = data.result.recurring.services.slice(0, 1);
      await trx('estimates').where({ id: est.estimateId }).update({ estimate_data: JSON.stringify(data), annual_total: 600, monthly_total: 50 });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ skipped: 1, closed: 1 });
      expect((await alertsOf(trx, est.estimateId))[0].done_at).not.toBeNull();
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('visit prices: the converter\'s own prices pass; a visit priced off the accepted price rings', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      // As converted and assigned: no price finding (the converter priced every visit right, or left it unpriced).
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 0, failed: 0 });
      expect(await alertsOf(trx, est.estimateId)).toHaveLength(0);
      // One upcoming lawn visit at the wrong price.
      const lawnChild = (await rowsOf(trx, est.estimateId)).find((row) => row.recurring_parent_id && /lawn/i.test(row.service_type));
      await trx('scheduled_services').where({ id: lawnChild.id }).update({ estimated_price: 1 });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      const [alert] = await alertsOf(trx, est.estimateId);
      expect(alert.metadata.itemKeys).toEqual(['lawn_care']);
      expect(alert.body).toMatch(/lawn visits priced \$1\.00, accepted \$100\.00/);
      // Fixed: the bell closes.
      await trx('scheduled_services').where({ id: lawnChild.id }).update({ estimated_price: 100 });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 0, closed: 1 });
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a booking on ONE combined-route series (lawn + T&S) is still a price-check candidate, judged on both prices', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const tree = { service: 'tree_shrub', name: 'Tree & Shrub', visitsPerYear: 6, frequency: 'bimonthly', annual: 360, mo: 30, perTreatment: 60, catalog: 'tree_shrub_bimonthly' };
      const est = await acceptedEstimate(trx, [...lines, tree]);
      await trx('estimates').where({ id: est.estimateId }).update({ annual_total: 1560, monthly_total: 130 });
      await repair(trx, est);
      const rows = await rowsOf(trx, est.estimateId);
      // Leave a single series: the lawn one, made the lawn + tree & shrub combined route.
      const drop = rows.filter((row) => !/lawn/i.test(row.service_type)).map((row) => row.id);
      await trx('scheduled_services').whereIn('id', drop).del();
      const lawnIds = rows.filter((row) => /lawn/i.test(row.service_type)).map((row) => row.id);
      await trx('scheduled_services').whereIn('id', lawnIds).update({ service_id: null, service_key_snapshot: 'lawn_tree_shrub_combo' });
      const child = rows.find((row) => row.recurring_parent_id && lawnIds.includes(row.id));
      // The combined price ($100 lawn + $60 T&S) passes; $100 alone does not.
      await trx('scheduled_services').whereIn('id', lawnIds.filter((id) => id !== rows.find((r) => lawnIds.includes(r.id) && !r.recurring_parent_id)?.id))
        .update({ estimated_price: 160 });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 0 });
      await trx('scheduled_services').where({ id: child.id }).update({ estimated_price: 100 });
      const result = await runCombinedBookingCheck({ conn: trx });
      expect(result.candidates).toBeGreaterThanOrEqual(1);
      const [alert] = await alertsOf(trx, est.estimateId);
      expect(alert.metadata.problemCodes).toContain('price_mismatch');
      expect(alert.body).toMatch(/priced \$100\.00, accepted \$160\.00/);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a visit priced only through primary_line_price is a candidate and is checked on it', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      const lawnIds = (await rowsOf(trx, est.estimateId)).filter((row) => /lawn/i.test(row.service_type) && row.recurring_parent_id).map((row) => row.id);
      await trx('scheduled_services').whereIn('id', lawnIds).update({ estimated_price: null, primary_line_price: 100 });
      await trx('scheduled_services').where({ id: lawnIds[0] }).update({ primary_line_price: 90 });
      await runCombinedBookingCheck({ conn: trx });
      const [alert] = await alertsOf(trx, est.estimateId);
      expect(alert.body).toMatch(/1 lawn visits priced \$90\.00, accepted \$100\.00/);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a name-only combined-route series (no catalog row) is a price candidate too', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const tree = { service: 'tree_shrub', name: 'Tree & Shrub', visitsPerYear: 6, frequency: 'bimonthly', annual: 360, mo: 30, perTreatment: 60, catalog: 'tree_shrub_bimonthly' };
      const est = await acceptedEstimate(trx, [...lines, tree]);
      await trx('estimates').where({ id: est.estimateId }).update({ annual_total: 1560, monthly_total: 130 });
      await repair(trx, est);
      const rows = await rowsOf(trx, est.estimateId);
      await trx('scheduled_services').whereIn('id', rows.filter((row) => !/lawn/i.test(row.service_type)).map((row) => row.id)).del();
      const lawnIds = rows.filter((row) => /lawn/i.test(row.service_type)).map((row) => row.id);
      await trx('scheduled_services').whereIn('id', lawnIds)
        .update({ service_id: null, service_key_snapshot: null, service_type: 'Lawn + Tree & Shrub Service' });
      const child = rows.find((row) => row.recurring_parent_id && lawnIds.includes(row.id));
      await trx('scheduled_services').where({ id: child.id }).update({ estimated_price: 100, primary_line_price: null });
      await runCombinedBookingCheck({ conn: trx });
      const [alert] = await alertsOf(trx, est.estimateId);
      expect(alert.body).toMatch(/priced \$100\.00, accepted \$160\.00/);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('visits with no status are still live price candidates', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      const rows = await rowsOf(trx, est.estimateId);
      await trx('scheduled_services').whereIn('id', rows.map((row) => row.id)).update({ status: null });
      const lawnChild = rows.find((row) => row.recurring_parent_id && /lawn/i.test(row.service_type));
      await trx('scheduled_services').where({ id: lawnChild.id }).update({ estimated_price: 90 });
      await runCombinedBookingCheck({ conn: trx });
      const [alert] = await alertsOf(trx, est.estimateId);
      expect(alert.body).toMatch(/1 lawn visits priced \$90\.00, accepted \$100\.00/);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a one-time root beside one recurring series does not make a booking multi-service', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      const rows = await rowsOf(trx, est.estimateId);
      const lawnRoot = rows.find((row) => !row.recurring_parent_id && /lawn/i.test(row.service_type));
      await trx('scheduled_services').whereIn('id', rows.filter((row) => /lawn/i.test(row.service_type) && row.id !== lawnRoot.id).map((row) => row.id)).del();
      await trx('scheduled_services').where({ id: lawnRoot.id }).update({ is_recurring: false });
      const pestChild = rows.find((row) => row.recurring_parent_id && /pest/i.test(row.service_type));
      await trx('scheduled_services').where({ id: pestChild.id }).update({ estimated_price: 140 });
      await runCombinedBookingCheck({ conn: trx });
      expect(await alertsOf(trx, est.estimateId)).toHaveLength(0);
      // The same booking with the lawn root recurring is a candidate and rings.
      await trx('scheduled_services').where({ id: lawnRoot.id }).update({ is_recurring: true });
      await runCombinedBookingCheck({ conn: trx });
      expect(await alertsOf(trx, est.estimateId)).toHaveLength(1);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a booking that kept an existing series for one service is still price-checked on the new one', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      const rows = await rowsOf(trx, est.estimateId);
      // The duplicate-series guard kept the customer's older lawn series: this estimate seeded pest only.
      const lawnRows = rows.filter((row) => /lawn/i.test(row.service_type));
      const lawnParent = lawnRows.find((row) => !row.recurring_parent_id);
      await trx('scheduled_services').whereIn('id', lawnRows.map((row) => row.id)).update({ source_estimate_id: null });
      await trx('scheduled_services').whereIn('id', lawnRows.filter((row) => row.recurring_parent_id).map((row) => row.id)).del();
      await trx('activity_log').insert({ customer_id: est.customerId, action: 'recurring_series_skipped',
        description: 'kept existing lawn series', metadata: JSON.stringify({ estimateId: est.estimateId, existingParentId: lawnParent.id }) });
      const pestChild = rows.find((row) => row.recurring_parent_id && /pest/i.test(row.service_type));
      await trx('scheduled_services').where({ id: pestChild.id }).update({ estimated_price: 140 });
      await runCombinedBookingCheck({ conn: trx });
      const [alert] = await alertsOf(trx, est.estimateId);
      expect(alert.metadata.problemCodes).toEqual(['price_mismatch']);
      expect(alert.metadata.itemKeys).toEqual(['pest_control']);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('an OK result writes no row (an fyi fact)', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      await repair(trx, est);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0, problems: 0, failed: 0 });
      expect(await alertsOf(trx, est.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a churned customer\'s booking is the churned-live-work alert\'s: no repair bell, and a standing one closes', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const rung = await acceptedEstimate(trx, lines);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      await trx('customers').where({ id: rung.customerId }).update({ pipeline_stage: 'churned' });
      const fresh = await acceptedEstimate(trx, lines);
      await trx('customers').where({ id: fresh.customerId }).update({ pipeline_stage: 'churned' });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0, closed: 1, problems: 0 });
      expect((await alertsOf(trx, rung.estimateId))[0].done_at).not.toBeNull();
      expect(await alertsOf(trx, fresh.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a customer deactivated after a problem rang closes its bell as done', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const est = await acceptedEstimate(trx, lines);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1 });
      await trx('customers').where({ id: est.customerId }).update({ active: false });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ candidates: 0, closed: 1, failed: 0 });
      const [row] = await alertsOf(trx, est.estimateId);
      expect(row.done_at).not.toBeNull();
      expect(row.resolution).toMatch(/no longer active/);
      // Closed once: the next run finds nothing standing.
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ closed: 0 });
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });
});
