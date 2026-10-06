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
// from today and an invoice (delivered 'sent' by default: the closeout billing
// guard needs one) carrying the WORK day (as a project invoice minted with the gate on does; 'booked' = a pre-gate invoice).
async function seed({ bookedOffset, projectOffset, recurring = false, invoiceDate = 'work', invoiceStatus = 'sent', noInvoice = false } = {}) {
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
  if (!noInvoice) {
    await mockPg('invoices').insert({
      id: f.invoiceId, token: randomUUID().replace(/-/g, '').slice(0, 24), invoice_number: `FX-${randomUUID().slice(0, 8)}`,
      customer_id: f.customerId, scheduled_service_id: f.serviceId, status: invoiceStatus, total: 350,
      ...(invoiceStatus === 'draft' ? {} : { sent_at: new Date() }),
      service_date: { booked: f.booked, work: f.work }[invoiceDate] || invoiceDate,
    });
  }
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
      expect(out.visitDateMove).toMatchObject({ moved: true, from: f.booked, to: f.work });
      const visit = await visitRow(f);
      expect(visit.status).toBe('completed');
      expect(day(visit.scheduled_date)).toBe(f.work);
      expect(day(visit.original_scheduled_date)).toBe(f.booked);
      expect(day((await recordRow(f)).service_date)).toBe(f.work);
      // The invoice was minted with the work day and is never written by the closeout.
      expect(day((await invoiceRow(f)).service_date)).toBe(f.work);
    } finally { await cleanup(f); }
  });

  test('gate on: an invoice DELIVERED on the booked day (pre-gate or reused draft) keeps the whole visit on the booked day', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const f = await seed({ bookedOffset: 3, projectOffset: -1, invoiceDate: 'booked' });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toEqual({ moved: false, reason: 'invoice_date_mismatch' });
      const visit = await visitRow(f);
      expect(visit.status).toBe('completed');
      expect(day(visit.scheduled_date)).toBe(f.booked);
      expect(visit.original_scheduled_date).toBeNull();
      expect(day((await invoiceRow(f)).service_date)).toBe(f.booked);
    } finally { await cleanup(f); }
  });

  test('gate on: the project date edited AFTER the invoice was delivered keeps the visit where it is', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const f = await seed({ bookedOffset: 3, projectOffset: -1 });
    try {
      await mockPg('projects').where({ id: f.projectId }).update({ project_date: dayOffset(-2) });
      const out = await close(f);
      expect(out.visitDateMove).toMatchObject({ moved: false, reason: 'invoice_date_mismatch' });
      expect(day((await visitRow(f)).scheduled_date)).toBe(f.booked);
      expect(day((await invoiceRow(f)).service_date)).toBe(f.work);
    } finally { await cleanup(f); }
  });

  test('gate on: a date set on purpose, or a draft still on the booked day, also keeps the visit (nothing is ever re-dated)', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const { moveCompletedVisitToWorkDay } = require('../services/completion-visit-date');
    for (const seedArgs of [{ invoiceDate: dayOffset(10) }, { invoiceStatus: 'draft', invoiceDate: 'booked' }]) {
      const f = await seed({ bookedOffset: 3, projectOffset: -1, ...seedArgs });
      try {
        await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'completed' });
        const before = day((await invoiceRow(f)).service_date);
        const out = await mockPg.transaction((trx) => moveCompletedVisitToWorkDay(trx, {
          scheduledServiceId: f.serviceId, serviceRecord: { service_date: f.work }, workDate: f.work, previousStatus: 'confirmed',
        }));
        expect(out).toEqual({ moved: false, reason: 'invoice_date_mismatch' });
        expect(day((await invoiceRow(f)).service_date)).toBe(before);
        expect(day((await visitRow(f)).scheduled_date)).toBe(f.booked);
      } finally { await cleanup(f); }
    }
  });

  test('gate on: a row still attached to a visit group keeps its date even when every sibling is terminal', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const f = await seed({ bookedOffset: 3, projectOffset: -1 });
    const stopId = randomUUID();
    const partnerId = randomUUID();
    f.extraServiceIds = [partnerId];
    try {
      await mockPg('service_visits').insert({ id: stopId, customer_id: f.customerId, scheduled_date: f.booked, stop_base_key: `fx-${stopId}`, created_by: 'fixture' });
      await mockPg('scheduled_services').insert({
        id: partnerId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId, service_type: 'Fixture partner',
        scheduled_date: f.booked, window_start: '09:00', window_end: '10:00', status: 'cancelled', estimated_price: 50,
      });
      await mockPg('scheduled_services').whereIn('id', [f.serviceId, partnerId]).update({ visit_id: stopId });
      const out = await close(f);
      expect(out.visitDateMove).toEqual({ moved: false, reason: 'grouped_visit' });
      expect(day((await visitRow(f)).scheduled_date)).toBe(f.booked);
    } finally {
      await mockPg('scheduled_services').whereIn('id', [f.serviceId, partnerId]).update({ visit_id: null }).catch(() => {});
      await cleanup(f);
      await mockPg('service_visits').where({ id: stopId }).del().catch(() => {});
    }
  });

  test('gate turned OFF after the invoice was minted with the work day: the closeout finishes the started move', async () => {
    // seed's invoice is delivered on the work day (what the gate-on mint produced); the gate is off at closeout.
    const f = await seed({ bookedOffset: 3, projectOffset: -1 });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toMatchObject({ moved: true, from: f.booked, to: f.work });
      const visit = await visitRow(f);
      expect(day(visit.scheduled_date)).toBe(f.work);
      expect(day(visit.original_scheduled_date)).toBe(f.booked);
      expect(day((await invoiceRow(f)).service_date)).toBe(f.work);
    } finally { await cleanup(f); }
  });

  test('gate OFF with a work-day invoice still obeys every other rule: a late closeout and a grouped row stay put', async () => {
    const f = await seed({ bookedOffset: -3, projectOffset: 0 });
    try {
      expect((await close(f)).visitDateMove).toMatchObject({ moved: false, reason: 'late_completion' });
      expect(day((await visitRow(f)).scheduled_date)).toBe(f.booked);
    } finally { await cleanup(f); }
  });

  test('gate on: a service record corrected by hand to another day keeps the visit where it is (record_date_mismatch)', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const f = await seed({ bookedOffset: 3, projectOffset: -1 });
    try {
      const { moveCompletedVisitToWorkDay } = require('../services/completion-visit-date');
      const other = dayOffset(-5);
      const recordId = randomUUID();
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'completed' });
      await mockPg('service_records').insert({
        id: recordId, customer_id: f.customerId, scheduled_service_id: f.serviceId, service_date: other, service_type: 'Fixture', status: 'completed',
      });
      const out = await mockPg.transaction((trx) => moveCompletedVisitToWorkDay(trx, {
        scheduledServiceId: f.serviceId, serviceRecord: { id: recordId, service_date: other }, workDate: f.work, previousStatus: 'confirmed',
      }));
      expect(out).toEqual({ moved: false, reason: 'record_date_mismatch' });
      expect(day((await visitRow(f)).scheduled_date)).toBe(f.booked);
      expect(day((await mockPg('service_records').where({ id: recordId }).first()).service_date)).toBe(other);
    } finally { await cleanup(f); }
  });

  test('gate on: an invoice whose status is NULL counts as non-void and blocks a date mismatch; a void one does not', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const { moveCompletedVisitToWorkDay } = require('../services/completion-visit-date');
    const f = await seed({ bookedOffset: 3, projectOffset: -1, invoiceDate: 'booked' });
    const move = () => mockPg.transaction((trx) => moveCompletedVisitToWorkDay(trx, {
      scheduledServiceId: f.serviceId, serviceRecord: { service_date: f.work }, workDate: f.work, previousStatus: 'confirmed',
    }));
    try {
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'completed' });
      await mockPg('invoices').where({ id: f.invoiceId }).update({ status: null });
      expect(await move()).toEqual({ moved: false, reason: 'invoice_date_mismatch' });
      expect(day((await visitRow(f)).scheduled_date)).toBe(f.booked);
      await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      expect(await move()).toMatchObject({ moved: true });
    } finally { await cleanup(f); }
  });

  test('gate OFF: today\'s behavior exactly: visit and invoice keep the booked day, nothing written', async () => {
    const f = await seed({ bookedOffset: 3, projectOffset: -1, invoiceDate: 'booked' });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toEqual({ moved: false, reason: 'gate_off' });
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
    const f = await seed({ bookedOffset: -3, projectOffset: 0, invoiceDate: 'booked' });
    try {
      const out = await close(f);
      expect(out.visitDateMove).toMatchObject({ moved: false, reason: 'late_completion' });
      const visit = await visitRow(f);
      expect(day(visit.scheduled_date)).toBe(f.booked);
      expect(visit.original_scheduled_date).toBeNull();
      expect(day((await invoiceRow(f)).service_date)).toBe(f.booked);
    } finally { await cleanup(f); }
  });

  test('gate on: a delivered invoice on the work day (sent, viewed, paid) lets the visit move and is never written', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    for (const invoiceStatus of ['sent', 'viewed', 'paid']) {
      const f = await seed({ bookedOffset: 3, projectOffset: -1, invoiceStatus });
      try {
        const out = await close(f);
        expect(out.visitDateMove).toMatchObject({ moved: true });
        const after = await invoiceRow(f);
        expect(day(after.service_date)).toBe(f.work);
        expect(day((await visitRow(f)).scheduled_date)).toBe(f.work);
      } finally { await cleanup(f); }
    }
  });

  describe('the project invoice is dated before it is delivered', () => {
    const mint = async (f) => {
      const { resolveOrCreateProjectInvoice } = require('../routes/admin-projects')._private;
      const project = await mockPg('projects').where({ id: f.projectId }).first();
      const customer = await mockPg('customers').where({ id: f.customerId }).first();
      const { invoice } = await resolveOrCreateProjectInvoice({ project, customer });
      return mockPg('invoices').where({ id: invoice.id }).first();
    };

    test('gate on, early work day: the minted draft carries the work day; the later closeout leaves it alone', async () => {
      process.env.GATE_COMPLETION_MOVES_DATE = 'true';
      const f = await seed({ bookedOffset: 3, projectOffset: -1, noInvoice: true });
      try {
        const invoice = await mint(f);
        expect(day(invoice.service_date)).toBe(f.work);
        // Delivered before closeout, as the combined-send route does.
        await mockPg('invoices').where({ id: invoice.id }).update({ status: 'sent', sent_at: new Date() });
        const out = await close(f);
        expect(out.visitDateMove).toMatchObject({ moved: true, from: f.booked, to: f.work });
        expect(day((await mockPg('invoices').where({ id: invoice.id }).first()).service_date)).toBe(f.work);
        expect(day((await visitRow(f)).scheduled_date)).toBe(f.work);
      } finally { await cleanup(f); }
    });

    test('a draft minted before the gate (or reused by the send route) is NEVER re-dated: it keeps the booked day and so does the visit', async () => {
      process.env.GATE_COMPLETION_MOVES_DATE = 'true';
      const f = await seed({ bookedOffset: 3, projectOffset: -1, invoiceStatus: 'draft', invoiceDate: 'booked' });
      try {
        const { resolveOrCreateProjectInvoice } = require('../routes/admin-projects')._private;
        const project = await mockPg('projects').where({ id: f.projectId }).first();
        const customer = await mockPg('customers').where({ id: f.customerId }).first();
        const { invoice, created } = await resolveOrCreateProjectInvoice({ project, customer });
        expect(created).toBe(false);
        expect(invoice.id).toBe(f.invoiceId);
        expect(day((await invoiceRow(f)).service_date)).toBe(f.booked);
        // Delivered as-is; the closeout then leaves the visit on the booked day too.
        await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'sent', sent_at: new Date() });
        expect((await close(f)).visitDateMove).toMatchObject({ moved: false, reason: 'invoice_date_mismatch' });
        expect(day((await visitRow(f)).scheduled_date)).toBe(f.booked);
      } finally { await cleanup(f); }
    });

    test('gate on: a visit that is already closed (completed, cancelled, skipped, no_show) gets no early invoice date', async () => {
      process.env.GATE_COMPLETION_MOVES_DATE = 'true';
      for (const status of ['completed', 'cancelled', 'skipped', 'no_show']) {
        const f = await seed({ bookedOffset: 3, projectOffset: -1, noInvoice: true });
        try {
          await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status });
          // The mint itself refuses a cancelled / skipped / no-show visit; a completed one mints on its own date.
          if (status === 'completed') expect(day((await mint(f)).service_date)).toBe(f.booked);
          else await expect(mint(f)).rejects.toThrow(/refusing to mint/);
        } finally { await cleanup(f); }
      }
    });

    test('the creation date comes from the LOCKED project row, not the caller\'s earlier read', async () => {
      process.env.GATE_COMPLETION_MOVES_DATE = 'true';
      const f = await seed({ bookedOffset: 3, projectOffset: -1, noInvoice: true });
      try {
        const { resolveOrCreateProjectInvoice } = require('../routes/admin-projects')._private;
        const stale = await mockPg('projects').where({ id: f.projectId }).first();
        const customer = await mockPg('customers').where({ id: f.customerId }).first();
        // Edited after the route read the project (stale row still says f.work).
        const edited = dayOffset(-2);
        await mockPg('projects').where({ id: f.projectId }).update({ project_date: edited });
        const { invoice } = await resolveOrCreateProjectInvoice({ project: stale, customer });
        expect(day((await mockPg('invoices').where({ id: invoice.id }).first()).service_date)).toBe(edited);
      } finally { await cleanup(f); }
    });

    test('InvoiceService.create runs serviceDateResolver INSIDE the mint transaction, after the visit lock; an explicit serviceDate wins', async () => {
      const InvoiceService = require('../services/invoice');
      const f = await seed({ bookedOffset: 3, projectOffset: -1, noInvoice: true });
      try {
        const seen = [];
        const resolver = async (database, visitId) => {
          const locked = await database('scheduled_services').where({ id: visitId }).first('scheduled_date');
          seen.push({ inTransaction: !!database.isTransaction, visitId, booked: day(locked.scheduled_date) });
          return f.work;
        };
        const created = await InvoiceService.create({
          customerId: f.customerId, scheduledServiceId: f.serviceId, serviceDateResolver: resolver,
          lineItems: [{ description: 'Fixture', quantity: 1, unit_price: 100, amount: 100 }],
        });
        expect(seen).toEqual([{ inTransaction: true, visitId: f.serviceId, booked: f.booked }]);
        expect(day((await mockPg('invoices').where({ id: created.id }).first()).service_date)).toBe(f.work);
        const explicit = await InvoiceService.create({
          customerId: f.customerId, scheduledServiceId: f.serviceId, serviceDateResolver: resolver, serviceDate: f.booked,
          lineItems: [{ description: 'Fixture 2', quantity: 1, unit_price: 100, amount: 100 }],
        });
        expect(seen).toHaveLength(1);
        expect(day((await mockPg('invoices').where({ id: explicit.id }).first()).service_date)).toBe(f.booked);
      } finally { await cleanup(f); }
    });

    test('a visit rescheduled before the mint is judged on its CURRENT booked day (read under the lock)', async () => {
      process.env.GATE_COMPLETION_MOVES_DATE = 'true';
      const f = await seed({ bookedOffset: 3, projectOffset: -1, noInvoice: true });
      try {
        // The route read the visit at +3; a reschedule moves it to the work day itself before the mint:
        // there is no early move left, so the invoice keeps the (new) booked day.
        await mockPg('scheduled_services').where({ id: f.serviceId }).update({ scheduled_date: f.work });
        expect(day((await mint(f)).service_date)).toBe(f.work);
        await mockPg('invoices').where({ customer_id: f.customerId }).del();
        // ...and moved even earlier than the work day: late completion, default date.
        await mockPg('scheduled_services').where({ id: f.serviceId }).update({ scheduled_date: dayOffset(-4) });
        expect(day((await mint(f)).service_date)).toBe(dayOffset(-4));
      } finally { await cleanup(f); }
    });

    test('the WDO creation branch dates the invoice the same way (resolver under the lock)', async () => {
      process.env.GATE_COMPLETION_MOVES_DATE = 'true';
      const f = await seed({ bookedOffset: 3, projectOffset: -1, noInvoice: true });
      try {
        await mockPg('projects').where({ id: f.projectId }).update({ project_type: 'wdo_inspection' });
        const invoice = await mint(f);
        expect(invoice.title).toBe('WDO Inspection');
        expect(day(invoice.service_date)).toBe(f.work);
      } finally { await cleanup(f); }
    });

    test('gate OFF: the minted draft keeps the booked day (today\'s behavior)', async () => {
      const f = await seed({ bookedOffset: 3, projectOffset: -1, noInvoice: true });
      try {
        expect(day((await mint(f)).service_date)).toBe(f.booked);
      } finally { await cleanup(f); }
    });

    test('gate on, late work day: the minted draft keeps the booked day', async () => {
      process.env.GATE_COMPLETION_MOVES_DATE = 'true';
      const f = await seed({ bookedOffset: -3, projectOffset: 0, noInvoice: true });
      try {
        expect(day((await mint(f)).service_date)).toBe(f.booked);
      } finally { await cleanup(f); }
    });
  });

  test('gate on: a dispatch:job_update with the new date goes out after commit, and BOTH days are refreshed for route quality', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const dispatch = require('../services/dispatch-assignment');
    const spy = jest.spyOn(dispatch, 'emitDispatchJobUpdate').mockResolvedValue(null);
    const f = await seed({ bookedOffset: 3, projectOffset: -1 });
    try {
      await close(f);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ jobId: f.serviceId, previousDate: f.booked }));
    } finally { spy.mockRestore(); await cleanup(f); }
  });

  test('gate on: the board gets the moved stop (board_visible, address) and quality refresh covers the vacated day too', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const emitted = [];
    require('../sockets').getIo.mockReturnValue({ to: () => ({ emit: (event, payload) => emitted.push({ event, payload }) }) });
    const quality = require('../services/scheduling/quality-after-change');
    const refresh = jest.spyOn(quality, 'refreshScheduleQualityAfterChange').mockResolvedValue({ status: 'gate_off' });
    // Work day = today so the moved stop belongs on today's board.
    const f = await seed({ bookedOffset: 3, projectOffset: 0 });
    try {
      await close(f);
      const update = emitted.filter((e) => e.event === 'dispatch:job_update' && e.payload.job_id === f.serviceId).pop();
      expect(update.payload).toMatchObject({ scheduled_date: f.work, status: 'completed', board_visible: true });
      expect(update.payload).toHaveProperty('address');
      const call = refresh.mock.calls.map(([arg]) => arg).find((arg) => Array.isArray(arg?.dates) && arg.dates.includes(f.booked));
      expect(call.dates).toEqual(expect.arrayContaining([f.booked, f.work]));
    } finally {
      refresh.mockRestore();
      require('../sockets').getIo.mockReturnValue(null);
      await cleanup(f);
    }
  });

  test('gate on, no move (late closeout): no extra dispatch update', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const dispatch = require('../services/dispatch-assignment');
    const spy = jest.spyOn(dispatch, 'emitDispatchJobUpdate').mockResolvedValue(null);
    const f = await seed({ bookedOffset: -3, projectOffset: 0 });
    try {
      await close(f);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); await cleanup(f); }
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
      const ord = recurrenceOrdinalOptions(f.booked);
      expect(moved.recurring_nth).toBe(ord.nth);
      expect(moved.recurring_weekday).toBe(ord.weekday);
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
      // The gate-off control carries a booked-day invoice (a work-day one would finish the started move).
      const f = await seed({ bookedOffset: 3, projectOffset: -1, invoiceDate: gateOn ? 'work' : 'booked' });
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
