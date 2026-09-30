/**
 * Owner ruling 2026-09-30, the COMPLETION side of the dispute-hold rule: while a
 * customer has an active collections DISPUTE hold, the completion text goes
 * report-only and the invoice whose pay link it would have carried is HANDED to
 * the scheduled-invoice sender (queued); the sender - the one chokepoint -
 * holds it while the dispute stands and sends it after the release.
 *
 * Runs the real completeScheduledService against a migrated nonproduction
 * Postgres (COLLECTION_HOLD_TEST_DATABASE_URL, else CI's
 * REPAIR_TEST_DATABASE_URL; skipped without either). Wiring copied from
 * complete-scheduled-service-first-visit-rating-default-postgres.test.js.
 * Synthetic names only; nothing leaves the process (the customer-message
 * boundary is a recording stub).
 */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'), getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/messaging/send-window', () => ({
  ...jest.requireActual('../services/messaging/send-window'), isWithinSendWindowET: jest.fn(() => true),
}));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => false),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => null),
}));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
jest.mock('../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => {}) }));
jest.mock('../services/tree-shrub-assessment', () => ({
  ...jest.requireActual('../services/tree-shrub-assessment'),
  scoreAndStoreTreeShrubAssessment: jest.fn(async () => null),
}));
jest.mock('../services/referral-engine', () => ({ creditReferralOnFirstService: jest.fn(async () => {}) }));
jest.mock('../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: jest.fn(async () => false), sendNewRecurringWelcome: jest.fn(async () => {}),
}));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => {}), sendMembershipRenewalReminder: jest.fn(async () => {}) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: jest.fn(async () => {}) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(), loadTemplateByKey: jest.fn(async () => null), activeSuppressionFor: jest.fn(async () => null),
}));
jest.mock('../services/review-request', () => ({ enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));

const knex = require('knex');
const { randomUUID } = require('crypto');

const connection = process.env.COLLECTION_HOLD_TEST_DATABASE_URL || process.env.REPAIR_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
jest.setTimeout(120000);

const DISPUTE_REASON = 'dispute on call: synthetic billing question';

async function seedVisit({ phone = true } = {}) {
  const { etDateString } = require('../utils/datetime-et');
  const today = etDateString();
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(),
    serviceKey: `fixture_pest_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'HoldHandover',
    phone: phone ? `+1305555${Math.floor(Math.random() * 9000 + 1000)}` : '',
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture General Pest Control ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture General Pest Control ${f.serviceKey}`, scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 89, estimated_duration_minutes: 60, create_invoice_on_complete: true });
  return f;
}

async function cleanup(f) {
  await mockPg('dispatch_alerts').where({ job_id: f.serviceId }).del().catch(() => {});
  await mockPg('sms_log').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('collections_flags').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ id: f.serviceId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

function body(overrides = {}) {
  return {
    customerRecap: 'Visit closed out.', visitOutcome: 'completed', products: [], areasServiced: [],
    sendCompletionSms: true, requestReview: false, ...overrides,
  };
}

async function complete(f, overrides = {}, idempotencyKey = randomUUID()) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey,
    actor: { techRole: 'admin', technicianId: f.techId, technician: null }, body: body(overrides) });
}

const placeHold = async (f) => (await mockPg('collections_flags')
  .insert({ customer_id: f.customerId, flag: 'collection_hold', reason: DISPUTE_REASON, created_by: 'test' }).returning('id'))[0].id;
const releaseViaOpsScript = (f) => require('../services/collections/outbound-voice/flags')
  .releaseFlag({ customerId: f.customerId, flag: 'collection_hold' });
const invoiceFor = (f) => mockPg('invoices').where({ customer_id: f.customerId }).first();
const recordFor = (f) => mockPg('service_records').where({ customer_id: f.customerId }).first();

postgres('completion under a dispute hold: hand the invoice to the sender, text report-only (postgres)', () => {
  let sendCustomerMessage;
  let InvoiceService;
  let sendSpy;

  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    ({ sendCustomerMessage } = require('../services/messaging/send-customer-message'));
    InvoiceService = require('../services/invoice');
    sendSpy = jest.spyOn(InvoiceService, 'sendViaSMSAndEmail').mockImplementation(async (invoiceId) => {
      await mockPg('invoices').where({ id: invoiceId }).update({
        status: 'sent', sent_at: mockPg.fn.now(), scheduled_send_at: null, send_claim_token: null, updated_at: mockPg.fn.now(),
      });
      return { ok: true };
    });
  });
  afterAll(async () => { sendSpy.mockRestore(); if (mockPg) await mockPg.destroy(); });
  beforeEach(() => {
    jest.clearAllMocks();
    sendCustomerMessage.mockImplementation(async () => ({ sent: true, channel: 'sms', sid: `SM${randomUUID().replace(/-/g, '').slice(0, 32)}` }));
  });

  const bodies = () => sendCustomerMessage.mock.calls.map(([input]) => String(input.body || ''));
  // The with-invoice completion text carries the pay link on its own "Invoice:" line (short link).
  const payLinkIn = (text, inv) => /^Invoice:/im.test(text) || text.includes(inv.token) || /\/pay\//.test(text);
  const sentInvoiceIds = () => sendSpy.mock.calls.map((c) => c[0]);

  test('a hold queues the invoice onto the sender and the completion text is report-only', async () => {
    const f = await seedVisit();
    try {
      await placeHold(f);
      const out = await complete(f);
      expect(out).toMatchObject({ status: 200 });
      const inv = await invoiceFor(f);
      expect(inv).toBeTruthy();
      expect(inv).toMatchObject({ status: 'scheduled', scheduled_send_attempts: 0, scheduled_send_error: null });
      expect(inv.scheduled_send_at).not.toBeNull();
      expect(sendCustomerMessage).toHaveBeenCalled();
      for (const text of bodies()) expect(payLinkIn(text, inv)).toBe(false);
      expect((await recordFor(f)).structured_notes.invoiceSenderOwnsPayLinkFor).toBe(String(inv.id));
      // the sender holds it while the dispute stands, then sends it once after the release
      await InvoiceService.processScheduledSends();
      expect(sentInvoiceIds()).not.toContain(inv.id);
      await releaseViaOpsScript(f);
      await mockMakeDue(inv.id);
      await InvoiceService.processScheduledSends();
      expect(sentInvoiceIds().filter((x) => x === inv.id)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('no hold: the completion text carries the pay link and nothing is queued (unchanged behavior)', async () => {
    const f = await seedVisit();
    try {
      const out = await complete(f);
      expect(out).toMatchObject({ status: 200 });
      const inv = await invoiceFor(f);
      expect(bodies().some((text) => payLinkIn(text, inv))).toBe(true);
      expect(inv.status).not.toBe('scheduled');
      expect((await recordFor(f)).structured_notes.invoiceSenderOwnsPayLinkFor).toBeUndefined();
    } finally { await cleanup(f); }
  });

  test('includePayLink === false: no pay link would have gone out, so nothing is queued', async () => {
    const f = await seedVisit();
    try {
      await placeHold(f);
      expect(await complete(f, { includePayLink: false })).toMatchObject({ status: 200 });
      const inv = await invoiceFor(f);
      expect(inv).toMatchObject({ status: 'draft', scheduled_send_at: null });
      expect((await recordFor(f)).structured_notes.invoiceSenderOwnsPayLinkFor).toBeUndefined();
    } finally { await cleanup(f); }
  });

  test('sendCompletionSms false: no text would have gone out, so nothing is queued', async () => {
    const f = await seedVisit();
    try {
      await placeHold(f);
      expect(await complete(f, { sendCompletionSms: false })).toMatchObject({ status: 200 });
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(await invoiceFor(f)).toMatchObject({ status: 'draft', scheduled_send_at: null });
    } finally { await cleanup(f); }
  });

  test('a customer with no phone: no text would have gone out, so nothing is queued', async () => {
    const f = await seedVisit({ phone: false });
    try {
      await placeHold(f);
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect(await invoiceFor(f)).toMatchObject({ status: 'draft', scheduled_send_at: null });
    } finally { await cleanup(f); }
  });

  test('a queue write failure is never swallowed: 503 for retry, an office alert, no customer text; the retry then succeeds', async () => {
    const f = await seedVisit();
    const key = randomUUID();
    try {
      await placeHold(f);
      await mockPg.raw(`CREATE OR REPLACE FUNCTION b10_fail_handover() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'queue down (synthetic)'; END $$ LANGUAGE plpgsql`);
      // Scoped to this test's own customer: CI shares the database across workers.
      await mockPg.raw(`CREATE TRIGGER b10_fail_handover_trg BEFORE UPDATE ON invoices FOR EACH ROW WHEN (OLD.customer_id = '${f.customerId}' AND OLD.status = 'draft' AND NEW.status = 'scheduled') EXECUTE FUNCTION b10_fail_handover()`);
      let first;
      try {
        first = await complete(f, {}, key);
      } finally {
        await mockPg.raw('DROP TRIGGER IF EXISTS b10_fail_handover_trg ON invoices');
        await mockPg.raw('DROP FUNCTION IF EXISTS b10_fail_handover()');
      }
      expect(first).toMatchObject({ status: 503, body: { code: 'invoice_hold_handover_failed' } });
      expect(bodies().filter((text) => /Visit closed out|report/i.test(text))).toEqual([]);
      const alerts = await mockPg('dispatch_alerts').where({ type: 'collection_hold_invoice_queue_failed', job_id: f.serviceId });
      expect(alerts).toHaveLength(1);
      expect(await invoiceFor(f)).toMatchObject({ status: 'draft' });
      // retry, fault gone: queued, and the text is report-only
      const retry = await complete(f, {}, key);
      expect(retry).toMatchObject({ status: 200 });
      const inv = await invoiceFor(f);
      expect(inv.status).toBe('scheduled');
      for (const text of bodies()) expect(payLinkIn(text, inv)).toBe(false);
    } finally { await cleanup(f); }
  });

  test('a completion RETRY after the release sends no second pay link: the sender owns the invoice, the retry text is report-only', async () => {
    const f = await seedVisit();
    const key = randomUUID();
    try {
      await placeHold(f);
      // Attempt 1: the hold hands the invoice over, then the report-only text fails retryably.
      sendCustomerMessage.mockImplementationOnce(async () => ({ sent: false, blocked: false, code: 'PROVIDER_FAILURE', retryable: true, reason: 'provider down (synthetic)' }));
      const first = await complete(f, {}, key);
      expect(first.status).toBeGreaterThanOrEqual(500);
      const inv = await invoiceFor(f);
      expect(inv.status).toBe('scheduled');
      // Staff release the hold before the tech retries; the sender's next tick sends the invoice.
      await releaseViaOpsScript(f);
      await mockMakeDue(inv.id);
      await InvoiceService.processScheduledSends();
      expect(sentInvoiceIds().filter((x) => x === inv.id)).toHaveLength(1);
      // Attempt 2 (the tech retries): no hold now - the text must still be report-only.
      jest.clearAllMocks();
      sendCustomerMessage.mockImplementation(async () => ({ sent: true, channel: 'sms', sid: `SM${randomUUID().replace(/-/g, '').slice(0, 32)}` }));
      const retry = await complete(f, {}, key);
      expect(retry).toMatchObject({ status: 200 });
      expect(sendCustomerMessage).toHaveBeenCalled();
      for (const text of bodies()) expect(payLinkIn(text, inv)).toBe(false);
      // and the sender sends nothing more
      await InvoiceService.processScheduledSends();
      expect(sentInvoiceIds().filter((x) => x === inv.id)).toHaveLength(0);
    } finally { await cleanup(f); }
  });
});

const mockMakeDue = (id) => mockPg('invoices').where({ id }).update({ scheduled_send_at: new Date(Date.now() - 1000) });
