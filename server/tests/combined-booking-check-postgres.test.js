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
  .where({ recipient_type: 'admin', category: 'ops_digest' }).whereRaw("metadata->>'estimateId' = ?", [estimateId]);

const dayOf = (row) => String(row.scheduled_date instanceof Date ? row.scheduled_date.toISOString() : row.scheduled_date).slice(0, 10);

// What the office does to a bad booking: a time and technician on every visit,
// the accepted per-visit prices on later visits, one shared first-day invoice.
async function repair(trx, { customerId, estimateId }) {
  const rows = await rowsOf(trx, estimateId);
  const technicianId = randomUUID();
  await trx('technicians').insert({ id: technicianId, name: 'Synthetic Technician',
    email: `${technicianId}@example.invalid`, password_hash: 'synthetic-not-a-login-hash', role: 'technician',
    active: true, employment_status: 'active', field_dispatchable: true });
  const invoice = await require('../services/invoice').create({ database: trx, customerId, title: 'First Service Application',
    lineItems: [{ description: 'First service application', quantity: 1, unit_price: 250 }], dueDate: '2026-10-04' });
  const day0 = rows.map(dayOf).sort()[0];
  for (const row of rows) {
    const firstDayParent = dayOf(row) === day0 && !row.recurring_parent_id;
    await trx('scheduled_services').where({ id: row.id }).update({
      window_start: '10:00', window_end: '11:00', technician_id: technicianId,
      estimated_price: firstDayParent ? null : (/lawn/i.test(row.service_type) ? 100 : 150),
      first_application_invoice_id: firstDayParent ? invoice.id : null,
    });
  }
}

postgres('combined-booking check through the real conversion', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!local && !/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use the verified private dev database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('a pest + lawn accept with unassigned companions rings once, stays quiet on re-check, and clears when fixed', async () => {
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
      expect(alert.title).toBe('Combined booking needs a look');
      expect(alert.body).toMatch(/^J\. Sample — .*missing time\/tech/);
      expect(alert.body.length).toBeLessThanOrEqual(110);
      expect(alert.link).toBe(`/admin/customers?customerId=${customerId}`);
      expect(alert.read_at).toBeNull();
      expect(alert.metadata).toMatchObject({ checkResult: 'problem', quiet: false, feed: null });
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
      expect(third).toMatchObject({ checked: 1, ok: 1, problems: 0, failed: 0 });
      const [cleared] = await alertsOf(trx, estimateId);
      expect(cleared.id).toBe(alert.id);
      expect(cleared.title).toBe('Combined booking OK');
      expect(cleared.read_at).not.toBeNull();
      expect(cleared.metadata).toMatchObject({ checkResult: 'ok', resolved: true });

      // An OK verdict is final: the next sweep does not look at it again.
      const fourth = await runCombinedBookingCheck({ conn: trx });
      expect(fourth.checked).toBe(0);
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
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ checked: 0, skipped: 1, problems: 0, failed: 0 });
      const rows = await alertsOf(trx, estimateId);
      expect(rows).toHaveLength(1);
      expect(rows[0].read_at).not.toBeNull();
      expect(rows[0].metadata.resolved).toBe(true);
      expect(rows[0].metadata.dedupeKey).toBeUndefined();

      // The same problem coming back rings a fresh bell, never the retired row.
      await trx('scheduled_services').whereIn('id', (await rowsOf(trx, estimateId)).map((row) => row.id)).update({ status: 'pending' });
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ problems: 1, failed: 0 });
      const again = await alertsOf(trx, estimateId);
      expect(again).toHaveLength(2);
      const fresh = again.find((row) => row.id !== rung.id);
      expect(fresh.read_at).toBeNull();
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
        .findAcceptedRecurringScheduleGaps({ settleMs: 0, estimateIds: [est.estimateId], coverage }, trx);
      expect(gaps.map((gap) => gap.serviceFamily)).toEqual(['pest_control']);
      // Judged, with no family skipped.
      expect([...coverage.get(String(est.estimateId))]).toEqual([]);
      // The watchdog's own 24h-settled call does not see a 20-minute-old accept yet.
      expect(await require('../services/recurring-schedule-audit').findAcceptedRecurringScheduleGaps({}, trx)
        .then((all) => all.filter((gap) => gap.estimateId === est.estimateId))).toEqual([]);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ checked: 0, deferred: 1, problems: 0, ok: 0, failed: 0 });
      expect(await alertsOf(trx, est.estimateId)).toHaveLength(0);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('a standing problem never starves a newer accept: only newly posted rows count against the cap', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const older = [await acceptedEstimate(trx, lines), await acceptedEstimate(trx, lines)];
      expect(await runCombinedBookingCheck({ conn: trx, maxNew: 1 })).toMatchObject({ problems: 1 });
      expect(await runCombinedBookingCheck({ conn: trx, maxNew: 1 })).toMatchObject({ problems: 2 });
      const newest = await acceptedEstimate(trx, lines);
      expect(await alertsOf(trx, newest.estimateId)).toHaveLength(0);
      // Two older problems are re-checked first and are NOT counted; the newest still posts.
      expect(await runCombinedBookingCheck({ conn: trx, maxNew: 1 })).toMatchObject({ problems: 3 });
      expect(await alertsOf(trx, newest.estimateId)).toHaveLength(1);
      for (const est of older) expect(await alertsOf(trx, est.estimateId)).toHaveLength(1);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });

  test('OK results: the first rings once, later ones go to the Activity feed quietly', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    mockPg = trx;
    try {
      const first = await acceptedEstimate(trx, lines);
      await repair(trx, first);
      const second = await acceptedEstimate(trx, lines);
      await repair(trx, second);
      expect(await runCombinedBookingCheck({ conn: trx })).toMatchObject({ checked: 2, ok: 2, problems: 0, failed: 0 });
      const rows = await trx('notifications').where({ recipient_type: 'admin', category: 'ops_digest' })
        .whereRaw("metadata->>'alertClass' = 'combined-booking-check'").orderBy('created_at').orderBy('id');
      expect(rows).toHaveLength(2);
      const rang = rows.filter((row) => row.metadata.feed == null && row.metadata.quiet === false);
      const quiet = rows.filter((row) => row.metadata.feed === 'activity' && row.metadata.quiet === true);
      expect(rang).toHaveLength(1);
      expect(quiet).toHaveLength(1);
      expect(rang[0].title).toBe('Combined booking OK');
      expect(rang[0].body).toMatch(/^J\. Sample \u2014 Pest \+ Lawn \u00b7 \w{3} \w{3} \d+ 10:00 \u00b7 Synthetic \u00b7 \$250\.00 first visit$/);
    } finally {
      mockPg = pool;
      await trx.rollback();
    }
  });
});
