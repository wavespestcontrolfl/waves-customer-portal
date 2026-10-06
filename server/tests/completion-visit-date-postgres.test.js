/**
 * GATE_COMPLETION_MOVES_DATE (owner "go" 2026-10-06): a certificate / project
 * closeout of a visit booked for a LATER day moves the visit to the day the
 * work was done. This runs the real completeProjectBackedService transaction
 * against a migrated, private Postgres clone and reads the rows back.
 *
 * Covers: the visit, its service record and its invoice share one date; the
 * booked day is kept in original_scheduled_date; a late closeout and the gate
 * off change nothing; a recurring visit keeps its series slot so the NEXT visit
 * does not shift; job costing finds the moved visit.
 *
 * Synthetic names only. Wiring copied from
 * complete-scheduled-service-first-visit-rating-default-postgres.test.js.
 */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));

const knex = require('knex');
const { randomUUID } = require('crypto');

// Verified private clone only — never a shared or production URL. Accepts this
// worktree's own waves_qa_completion_date clone or CI's isolated waves_test.
// The literal `const SKIP = !process.env.DATABASE_URL` line is the exact marker
// the CI "DB-gated suites" step greps for (.github/workflows/tests.yml).
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_qa_completion_date';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Completion visit-date Postgres tests require this worktree\'s own waves_qa_completion_date or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const { etDateString } = require('../utils/datetime-et');

function dayOffset(n) {
  const d = new Date(`${etDateString()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const day = (v) => (v == null ? null : String(v instanceof Date ? v.toISOString() : v).slice(0, 10));

const CERT_TYPE = 'pre_treatment_termite_certificate';

// One visit on a certificate service (a project-backed profile), booked
// `bookedOffset` days from today, with a project dated `projectOffset` days
// from today and a delivered invoice carrying the BOOKED date.
async function seed({ bookedOffset, projectOffset, recurring = false, invoiceDate = 'booked' } = {}) {
  const f = {
    customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(),
    projectId: randomUUID(), invoiceId: randomUUID(), serviceKey: `fixture_cert_${randomUUID().slice(0, 8)}`,
    booked: dayOffset(bookedOffset), work: dayOffset(projectOffset),
  };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'DateMove', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture Certificate ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('service_completion_profiles').insert({
    service_key: f.serviceKey, service_name_snapshot: `Fixture Certificate ${f.serviceKey}`, category: 'termite', billing_type: 'one_time',
    completion_mode: 'special_project', project_type: CERT_TYPE, portal_visibility: 'token_only', portal_attach_policy: 'never', active: true,
  });
  await mockPg('scheduled_services').insert({
    id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture Certificate ${f.serviceKey}`, scheduled_date: f.booked, window_start: '09:00', window_end: '10:00',
    status: 'confirmed', estimated_price: 350, estimated_duration_minutes: 60, create_invoice_on_complete: true,
    ...(recurring ? { is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true } : {}),
  });
  await mockPg('projects').insert({
    id: f.projectId, customer_id: f.customerId, scheduled_service_id: f.serviceId, project_type: CERT_TYPE,
    status: 'sent', sent_at: new Date(), title: 'Fixture certificate', created_by_tech_id: f.techId, project_date: f.work,
  });
  await mockPg('invoices').insert({
    id: f.invoiceId, token: randomUUID().replace(/-/g, '').slice(0, 24), invoice_number: `FX-${randomUUID().slice(0, 8)}`,
    customer_id: f.customerId, scheduled_service_id: f.serviceId, status: 'sent', sent_at: new Date(), total: 350,
    service_date: invoiceDate === 'booked' ? f.booked : invoiceDate,
  });
  return f;
}

async function cleanup(f) {
  const ids = [f.serviceId, ...(f.extraServiceIds || [])];
  await mockPg('job_costs').whereIn('scheduled_service_id', ids).del().catch(() => {});
  await mockPg('service_completion_attempts').whereIn('service_id', ids).del().catch(() => {});
  await mockPg('job_status_history').whereIn('job_id', ids).del().catch(() => {});
  await mockPg('projects').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('projects').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).whereNotNull('recurring_parent_id').del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_completion_profiles').where({ service_key: f.serviceKey }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

async function close(f) {
  const { completeProjectBackedService } = require('../services/project-completion');
  return completeProjectBackedService({ projectId: f.projectId, actorId: f.techId, knex: mockPg });
}
const visitRow = (f, id = f.serviceId) => mockPg('scheduled_services').where({ id }).first();
const recordRow = (f) => mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
const invoiceRow = (f) => mockPg('invoices').where({ id: f.invoiceId }).first();

postgres('certificate closeout moves the visit to the work day (GATE_COMPLETION_MOVES_DATE)', () => {
  beforeAll(async () => {
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  afterEach(() => { delete process.env.GATE_COMPLETION_MOVES_DATE; });

  test('gate on, closed before the booked day: visit, record and invoice share the work day; booked day kept', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const f = await seed({ bookedOffset: 3, projectOffset: -1 });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toMatchObject({ moved: true, from: f.booked, to: f.work, invoicesDated: 1 });
      const visit = await visitRow(f);
      expect(visit.status).toBe('completed');
      expect(day(visit.scheduled_date)).toBe(f.work);
      expect(day(visit.original_scheduled_date)).toBe(f.booked);
      expect(day((await recordRow(f)).service_date)).toBe(f.work);
      expect(day((await invoiceRow(f)).service_date)).toBe(f.work);
    } finally { await cleanup(f); }
  });

  test('gate OFF: today\'s behavior exactly: visit and invoice keep the booked day, nothing written', async () => {
    const f = await seed({ bookedOffset: 3, projectOffset: -1 });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toBeNull();
      const visit = await visitRow(f);
      expect(visit.status).toBe('completed');
      expect(day(visit.scheduled_date)).toBe(f.booked);
      expect(visit.original_scheduled_date).toBeNull();
      expect(visit.date_exception).toBe(false);
      expect(day((await recordRow(f)).service_date)).toBe(f.work);
      expect(day((await invoiceRow(f)).service_date)).toBe(f.booked);
    } finally { await cleanup(f); }
  });

  test('gate on, LATE closeout (work day after the booked day): the visit keeps its booked day', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const f = await seed({ bookedOffset: -3, projectOffset: 0 });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toMatchObject({ moved: false, reason: 'late_completion' });
      const visit = await visitRow(f);
      expect(day(visit.scheduled_date)).toBe(f.booked);
      expect(visit.original_scheduled_date).toBeNull();
      expect(day((await invoiceRow(f)).service_date)).toBe(f.booked);
    } finally { await cleanup(f); }
  });

  test('gate on: an invoice whose service date was set on purpose is not overwritten', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const other = dayOffset(10);
    const f = await seed({ bookedOffset: 3, projectOffset: -1, invoiceDate: other });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toMatchObject({ moved: true, invoicesDated: 0 });
      expect(day((await invoiceRow(f)).service_date)).toBe(other);
    } finally { await cleanup(f); }
  });

  test('gate on, a RECURRING visit closed early: the series slot is kept and the next visit does not shift', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const f = await seed({ bookedOffset: 3, projectOffset: -1, recurring: true });
    const nextBooked = dayOffset(3 + 91);
    const nextId = randomUUID();
    f.extraServiceIds = [nextId];
    try {
      // The series' own extension anchor and next date, read with the REAL
      // admin-schedule helpers (latestLiveSeriesVisit + seriesExtendAnchor)
      // before the move: the visit is the series' only live row.
      const { seriesExtendAnchor, latestLiveSeriesVisit } = require('../routes/admin-schedule')._test;
      const { nextRecurringDate, recurrenceOrdinalOptions } = require('../services/rebooker');
      const extendFrom = async () => {
        const root = await visitRow(f);
        const latest = await latestLiveSeriesVisit(mockPg, f.serviceId);
        const rOpts = recurrenceOrdinalOptions(root.scheduled_date, { nth: root.recurring_nth, weekday: root.recurring_weekday });
        const anchor = seriesExtendAnchor(latest, 'quarterly', rOpts);
        return { anchor, next: nextRecurringDate(anchor, 'quarterly', 1, rOpts) };
      };
      const before = await extendFrom();
      expect(before.anchor).toBe(f.booked);

      await close(f);

      const moved = await visitRow(f);
      expect(day(moved.scheduled_date)).toBe(f.work);
      expect(day(moved.original_scheduled_date)).toBe(f.booked);
      expect(moved.date_exception).toBe(true);
      expect(moved.date_exception_source).toBe('completion_early');
      expect(day(moved.date_exception_cadence_date)).toBe(f.booked);
      // The root's pattern inputs were frozen from the booked day.
      expect(moved.recurring_nth).not.toBeNull();
      expect(moved.recurring_weekday).not.toBeNull();
      // The next date the series would extend to is unchanged by the move.
      expect(await extendFrom()).toEqual(before);

      // A sibling already booked behind it is untouched too.
      await mockPg('scheduled_services').insert({
        id: nextId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
        service_type: `Fixture Certificate ${f.serviceKey}`, scheduled_date: nextBooked, window_start: '09:00', window_end: '10:00',
        status: 'pending', estimated_price: 350, is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true,
        recurring_parent_id: f.serviceId,
      });
      expect(day((await visitRow(f, nextId)).scheduled_date)).toBe(nextBooked);
    } finally { await cleanup(f); }
  });

  test('job costing finds the moved visit; without the move its date soft join misses the early record', async () => {
    const JobCosting = require('../services/job-costing');
    // Legacy shape: the record has no scheduled_service_id link, so costing
    // resolves it through the (customer, service_date, service_type) soft join.
    const run = async (gateOn) => {
      if (gateOn) process.env.GATE_COMPLETION_MOVES_DATE = 'true'; else delete process.env.GATE_COMPLETION_MOVES_DATE;
      const f = await seed({ bookedOffset: 3, projectOffset: -1 });
      try {
        await close(f);
        const record = await recordRow(f);
        await mockPg('service_records').where({ id: record.id }).update({ scheduled_service_id: null });
        await JobCosting.calculateJobCost(f.serviceId, mockPg);
        const cost = await mockPg('job_costs').where({ scheduled_service_id: f.serviceId }).first();
        return { f, record, cost, visit: await visitRow(f) };
      } catch (err) { await cleanup(f); throw err; }
    };
    const on = await run(true);
    try {
      expect(on.cost.service_record_id).toBe(on.record.id);
      expect(day(on.cost.service_date)).toBe(on.f.work);
    } finally { await cleanup(on.f); }
    const off = await run(false);
    try {
      // Control: gate off keeps today's miss (the visit is dated the booked day, the record the work day).
      expect(off.cost.service_record_id).toBeNull();
      expect(day(off.cost.service_date)).toBe(off.f.booked);
    } finally { await cleanup(off.f); }
  });
});
