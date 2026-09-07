/** Invoice issued ⇒ visit completed, driven through the CANONICAL completion against a migrated database. */
process.env.GATE_INVOICE_ISSUED_CLOSES_VISIT = 'true'; // the gate table is built at module load
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
// Annual-prepay coverage is stamped rows + a live term; one test forces the
// coverage verdict to exercise the settlement branch without that fixture.
const mockAnnualPrepay = { covers: false };
jest.mock('../services/annual-prepay-renewals', () => {
  const actual = jest.requireActual('../services/annual-prepay-renewals');
  return { ...actual, annualPrepayCoversVisit: async (...args) => (mockAnnualPrepay.covers ? true : actual.annualPrepayCoversVisit(...args)) };
});

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString } = require('../utils/datetime-et');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const { closeOutVisitForIssuedInvoice } = require('../services/invoice-issued-closeout');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg; // the per-test transaction while a test runs; the pool between tests
let f;
jest.setTimeout(90000);

describe('source contracts', () => {
  const fs = require('fs');
  const path = require('path');
  test('the issued invoice is re-checked LOCKED inside the record transaction and a miss 409s without committing', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    expect(source).toMatch(/const persistRecord = async \(trx\) => \{[\s\S]{0,6000}if \(issuedInvoiceCloseout\) \{\s*\n\s*const issuedNow = await trx\('invoices'\)\.where\(\{ id: issuedInvoiceCloseout\.invoiceId \}\)\.forUpdate\(\)/);
    expect(source).toMatch(/if \(err && err\.code === 'issued_invoice_not_reusable'\) \{\s*\n\s*await CompletionAttempts\.markCompletionAttemptFailed\(completionAttempt, err, db\);/);
  });
  test('the operator\'s resend-receipt route is the reachable retry for the payment-triggered closeout, ahead of both legs', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/admin-invoices.js'), 'utf8');
    expect(source).toMatch(/router\.post\('\/:id\/send-receipt'[\s\S]{0,1200}receipt can only be sent for paid invoices[\s\S]{0,900}closeOutVisitForIssuedInvoice\(\{ invoiceId: id, trigger: 'paid', actorTechnicianId: req\.technicianId \|\| null \}\);[\s\S]{0,400}const \{ sendReceiptEmail \} = require/);
  });
  test('the recovered-delivery branch of sendViaSMS runs the closeout too — a recovered send is a durable send', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');
    expect(source).toMatch(/if \(smsDelivered\) \{[\s\S]{0,5000}?closeOutVisitForIssuedInvoice\(\{ invoiceId, trigger: "sent", actorTechnicianId \}\);[\s\S]{0,600}?return \{ sent: true, payUrl, finalizeError: err\.message \};/);
  });
  test('the issued-invoice recheck locks the invoice AFTER the customer and visit rows (customer → visit → invoice)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const visitLockAt = source.indexOf("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();");
    const invoiceLockAt = source.indexOf("const issuedNow = await trx('invoices').where({ id: issuedInvoiceCloseout.invoiceId }).forUpdate()");
    expect(visitLockAt).toBeGreaterThan(-1);
    expect(invoiceLockAt).toBeGreaterThan(visitLockAt);
  });
});

postgres('invoice issued ⇒ visit completed through the canonical completion (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    mockPg = database;
  });
  // Every fixture graph (customer, technician, catalog row, visit, invoice,
  // and whatever the completion writes) lives inside one transaction that
  // is rolled back — the catalog row in particular must never outlive the
  // test: the serial CI run's completion-lane coverage contract reads the
  // migrated catalog next and fails on a leaked `fixture_*` service.
  beforeEach(async () => { mockPg = await database.transaction(); });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  async function fixture({ serviceType, category = 'pest_control', profile = null }) {
    f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), invoiceId: randomUUID(), key: `fixture_${randomUUID().slice(0, 8)}` };
    const date = etDateString();
    await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Issued', phone: '+12025550123',
      email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
    await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
    await mockPg('services').insert({ id: f.catalogId, name: serviceType, service_key: f.key, category, is_active: true });
    if (profile) await mockPg('service_completion_profiles').insert({ service_key: f.key, ...profile });
    await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
      service_type: serviceType, scheduled_date: date, window_start: '09:00', window_end: '10:00', status: 'confirmed',
      estimated_price: 117, estimated_duration_minutes: 60, create_invoice_on_complete: true });
    await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId, invoice_number: `TST-${f.invoiceId.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'sent', total: 117, subtotal: 117, service_date: date, service_type: serviceType,
      sent_at: new Date(), line_items: JSON.stringify([{ description: serviceType, amount: 117, quantity: 1, unit_price: 117 }]) });
    return f;
  }

  async function expectQuietCompletion(out) {
    expect(out).toMatchObject({ closed: true, visitId: f.serviceId, resumed: false });
    const visit = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
    expect(visit.status).toBe('completed');
    // Same-day closeout: the visit ended at the closeout itself, never at an
    // ET noon still hours away (GitHub r2 P2).
    const completedAt = new Date(visit.completed_at).getTime();
    expect(completedAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(completedAt).toBeGreaterThan(Date.now() - 5 * 60 * 1000);
    const records = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
    expect(records).toHaveLength(1);
    expect(records[0].structured_notes).toMatchObject({ backfill: true, issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'sent' } });
    // No customer report exists for a closeout without findings: delivery
    // frozen disabled, no report token / PDF / HTML on the record.
    expect(records[0].structured_notes).toMatchObject({ typedReportDelivery: 'disabled' });
    expect(records[0].report_view_token).toBeFalsy();
    expect(records[0].report_pdf_url).toBeFalsy();
    expect(records[0].report_html_storage_key).toBeFalsy();
    // The sent invoice is the visit's invoice — reused and back-linked, none minted.
    const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
    expect(invoices).toHaveLength(1);
    expect(invoices[0].service_record_id).toBe(records[0].id);
    expect(invoices[0].status).toBe('sent');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  }

  test('a pest visit closes quietly on its sent invoice', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a Tree & Shrub visit closes without the closeout form (no tree_shrub_closeout_lockout)', async () => {
    await fixture({ serviceType: 'Tree & Shrub Care Service', category: 'tree_shrub' });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a typed-findings service (rodent trapping) closes without its findings form', async () => {
    await fixture({ serviceType: 'Fixture Rodent Trapping Service', category: 'rodent',
      profile: { completion_mode: 'service_report', project_type: 'rodent_trapping', creates_service_record: true } });
    // The panel path still demands the typed form for this profile…
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    const panel = await completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', sendCompletionSms: false, requestReview: false, idempotencyKey: randomUUID() },
      actor: { techRole: 'admin', technicianId: f.techId, technician: null } });
    expect(panel).toMatchObject({ status: 422, body: { code: 'typed_findings_required' } });
    // …while the issued-invoice closeout records the billed visit as done.
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a profile with companion sections closes without them (no companion_findings_required)', async () => {
    await fixture({ serviceType: 'Fixture Rodent Trapping Service', category: 'rodent',
      profile: { completion_mode: 'service_report', project_type: 'rodent_trapping', creates_service_record: true,
        companion_types: JSON.stringify([{ type: 'rodent_exclusion' }]) } });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a delivery finalized through markDeliverySent (deferred / report-with-invoice rails) closes the visit too', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'sending', sent_at: null });
    const InvoiceService = require('../services/invoice');
    await InvoiceService.markDeliverySent(f.invoiceId, { sms: true, source: 'scheduled_send' });
    const visit = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
    expect(visit.status).toBe('completed');
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).status).toBe('sent');
    const records = await mockPg('service_records').where({ scheduled_service_id: f.serviceId });
    expect(records).toHaveLength(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // An automated trigger closes the visit out as the system: the visit's
    // technician is neither the transition actor nor the audit actor
    // (GitHub r2 P2) — the service record still carries the technician.
    const transition = await mockPg('job_status_history').where({ job_id: f.serviceId, to_status: 'completed' }).first();
    expect(transition).toBeTruthy();
    expect(transition.transitioned_by).toBeNull();
    expect(records[0].technician_id).toBe(f.techId);
    expect(await mockPg('audit_log').where({ resource_id: f.serviceId, action: 'visit.completed_on_invoice_issued' }).first()).toMatchObject({ actor_type: 'system', actor_id: null });
  });

  test('an annual-prepay-covered visit keeps its SENT invoice intact — add-ons and all; the closeout never settles or voids it', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const lines = [
      { description: 'Fixture Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 },
      { description: 'Wasp nest removal (add-on)', amount: 45, quantity: 1, unit_price: 45 },
    ];
    await mockPg('invoices').where({ id: f.invoiceId }).update({ line_items: JSON.stringify(lines), subtotal: 162, total: 162 });
    mockAnnualPrepay.covers = true;
    try {
      const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
      expect(out).toMatchObject({ closed: true, visitId: f.serviceId });
    } finally {
      mockAnnualPrepay.covers = false;
    }
    const inv = await mockPg('invoices').where({ id: f.invoiceId }).first();
    expect(inv.status).toBe('sent');
    expect(Number(inv.total)).toBe(162);
    const items = typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : inv.line_items;
    expect(items).toHaveLength(2);
    expect(inv.service_record_id).toBe((await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first()).id);
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
  });

  test('with two live invoices linked to the visit, the ISSUED one is reused and back-linked — never the newest draft', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const draftId = randomUUID();
    await mockPg('invoices').insert({ id: draftId, customer_id: f.customerId, scheduled_service_id: f.serviceId, invoice_number: `TST-${draftId.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: 'draft', total: 45, subtotal: 45, service_date: etDateString(), service_type: 'Fixture Quarterly Pest Control Service',
      created_at: new Date(Date.now() + 60 * 1000), line_items: JSON.stringify([{ description: 'Add-on', amount: 45, quantity: 1, unit_price: 45 }]) });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(out).toMatchObject({ closed: true, visitId: f.serviceId });
    const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
    expect((await mockPg('invoices').where({ id: f.invoiceId }).first()).service_record_id).toBe(record.id);
    expect((await mockPg('invoices').where({ id: draftId }).first()).service_record_id).toBeNull();
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(2);
  });

  test('an invoice voided after the send never closes the visit and never mints a replacement', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await mockPg('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
    const out = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(out).toMatchObject({ closed: false, reason: 'no_invoice' });
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('confirmed');
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
  });

  test('an invoice re-pointed away from the visit between the send and the closeout is refused before any write', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    await mockPg('invoices').where({ id: f.invoiceId }).update({ scheduled_service_id: null });
    const result = await completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', backfill: true, sendCompletionSms: false, requestReview: false, invoiceAlreadySent: true, idempotencyKey: randomUUID() },
      actor: { techRole: 'admin', technicianId: f.techId, technician: null }, issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'sent' } });
    expect(result).toMatchObject({ status: 409, body: { code: 'issued_invoice_not_reusable' } });
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('confirmed');
    expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(1);
  });

  test('a lawn visit with an unconfirmed assessment closes — the assessment form gate is a panel gate', async () => {
    await fixture({ serviceType: 'Fixture Monthly Lawn Care Service', category: 'lawn' });
    await mockPg('lawn_assessments').insert({ id: randomUUID(), customer_id: f.customerId, service_id: f.serviceId, service_date: etDateString(), confirmed_by_tech: false });
    // The panel path is blocked by the unconfirmed assessment…
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    const panel = await completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      body: { visitOutcome: 'completed', sendCompletionSms: false, requestReview: false, idempotencyKey: randomUUID() },
      actor: { techRole: 'admin', technicianId: f.techId, technician: null } });
    expect(panel).toMatchObject({ status: 400, body: { code: 'lawn_assessment_unconfirmed' } });
    // …while the issued-invoice closeout records the billed visit as done.
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
  });

  test('a second send is idempotent — the visit is already completed, nothing else changes', async () => {
    await fixture({ serviceType: 'Fixture Quarterly Pest Control Service' });
    await expectQuietCompletion(await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg }));
    const again = await closeOutVisitForIssuedInvoice({ invoiceId: f.invoiceId, trigger: 'sent', actorTechnicianId: f.techId, conn: mockPg });
    expect(again).toMatchObject({ closed: false, reason: 'visit_completed' });
    expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(1);
  });
});
