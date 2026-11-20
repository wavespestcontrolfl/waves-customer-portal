/**
 * A visit already invoiced from the payment flow, completed from a Fast Complete sheet (GATE_FAST_COMPLETE_INVOICED_VISITS,
 * owner 2026-10-09), through the real completeScheduledService transaction. The sheets post the same POST /complete as the
 * full form, with the same invoice field the full form posts for such a visit (`invoiceAlreadySent: true` when the visit
 * carries completionInvoiceAlreadySent, nothing else). This pins what the server does with it: no second invoice, no
 * pay-link text, the review ask held while the invoice is unpaid, a paid invoice left paid. It also pins the day a
 * completion form sent after the tech's arrival writes (owner 2026-10-31). Runs against a migrated, private Postgres.
 *
 * Wiring copied from complete-scheduled-service-lawn-places-postgres.test.js.
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
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, channel: 'sms', providerMessageId: 'SM-fixture', sid: 'SM-fixture' })),
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
jest.mock('../services/review-request', () => ({ firstAskLockVisit: jest.fn(async () => null), reportTextAnchorForRecord: jest.fn(async () => null), reportTextAnchorForVisit: jest.fn(async () => null), enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));


const knex = require('knex');
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const ReviewService = require('../services/review-request');

// Verified private clone only — never a shared or production URL. Accepts this suite's own
// waves_invoiced_fast_test clone, this worktree's private QA database, or CI's isolated waves_test. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the marker the CI "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const worktreeQa = `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
  const ownedQA = localHost && (url.pathname === '/waves_invoiced_fast_test'
    || (process.env.WAVES_LOCAL_DEV === '1' && url.pathname === worktreeQa));
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Invoiced-visit Postgres tests require their own waves_invoiced_fast_test or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
let completeScheduledService;
jest.setTimeout(90000);

const LAWN_TYPE = 'Every 6 Weeks Lawn Care Service';
const PRICE = 80;

// A priced visit that would mint its own completion invoice (create_invoice_on_complete) and already has an invoice
// from the payment flow: sent and unpaid, or paid. `invoiceDay` dates the invoice to another day, as an invoice made
// before the visit keeps the day it was minted with when the visit is moved. `invoiceStatus: null` seeds no invoice;
// `visitDay` and `arrivedAt` place the visit and the tech's arrival stamp on an earlier day.
async function seedInvoicedVisit({ invoiceStatus = 'sent', invoiceDay = null, visitDay = null, arrivedAt = null } = {}) {
  const today = etDateString(new Date());
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), invoiceId: randomUUID(), serviceKey: `fixture_lawn_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Invoiced', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  f.propertyId = property.id;
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `${LAWN_TYPE} ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: LAWN_TYPE, scheduled_date: visitDay || today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: PRICE, estimated_duration_minutes: 60, create_invoice_on_complete: true,
    ...(arrivedAt ? { arrived_at: arrivedAt, check_in_time: arrivedAt } : {}) });
  if (!invoiceStatus) return f;
  const paid = invoiceStatus === 'paid';
  await mockPg('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId, invoice_number: `TST-${f.invoiceId.slice(0, 8)}`,
    token: randomUUID().replace(/-/g, ''), status: invoiceStatus, total: PRICE, subtotal: PRICE, service_date: invoiceDay || today, service_type: LAWN_TYPE,
    ...(invoiceStatus === 'draft' ? {} : { sent_at: new Date() }), ...(paid ? { paid_at: new Date() } : {}),
    line_items: JSON.stringify([{ description: LAWN_TYPE, amount: PRICE, quantity: 1, unit_price: PRICE }]) });
  return f;
}

async function cleanup(f) {
  const records = await mockPg('service_records').where({ customer_id: f.customerId }).pluck('id').catch(() => []);
  await mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).del().catch(() => {});
  await mockPg('property_application_history').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_products').whereIn('service_record_id', records).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('payments').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('customer_properties').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

// What a Fast Complete sheet posts for the customer text and the review, beside the invoice field (the lawn sheet's own
// flags); the full form posts the same names.
const SHEET_FLAGS = { sendCompletionSms: true, includePayLink: true, requestReview: true, reviewTiming: 'auto' };

async function complete(f, invoiceFields, { idempotencyKey = randomUUID() } = {}) {
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey,
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { customerRecap: 'Visit closed out.', visitOutcome: 'completed', products: [], areasServiced: [], ...SHEET_FLAGS, ...invoiceFields } });
}

const invoicesOf = (f) => mockPg('invoices').where({ customer_id: f.customerId });
const completionTexts = () => sendCustomerMessage.mock.calls.map(([input]) => input).filter((input) => input?.purpose === 'service_completion');
const textsWithPayLink = () => completionTexts().filter((input) => /\/pay\/|pay_url|[?&]pay=|invoice/i.test(`${input.body} ${input.metadata?.templateKey || ''}`));

postgres('completing a visit that is already invoiced, from a Fast Complete sheet', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    ({ completeScheduledService } = require('../services/complete-scheduled-service'));
  }, 180000);
  beforeEach(() => { sendCustomerMessage.mockClear(); ReviewService.enrollPostService.mockClear(); });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('an invoice already sent (invoiceAlreadySent: true): no second invoice, no pay-link text, the invoice stays as it was, no review ask while it is unpaid', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    const emailed = jest.spyOn(require('../services/invoice-email'), 'sendInvoiceEmail');
    try {
      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(emailed).not.toHaveBeenCalled();
      const invoices = await invoicesOf(f);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ id: f.invoiceId, status: 'sent' });
      expect(Number(invoices[0].total)).toBe(PRICE);
      expect(textsWithPayLink()).toEqual([]);
      // The customer still gets the report text, and only that one.
      expect(completionTexts().map((t) => t.metadata.templateKey)).toEqual(['service_complete']);
      // The sheet opens no second in-person payment prompt either: the response says no payment is required.
      expect(out.body.invoicePaymentActionRequired).toBe(false);
      // The unpaid invoice does not hold the review ask: it follows as its own text, and the record carries the marker.
      expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record).toBeTruthy();
      expect(record.structured_notes.reviewAskedAtVisit).toBe(true);
      expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('completed');
    } finally { await cleanup(f); }
  });

  test('completion applies only the cash top-up still due after prior visit allocation and account credit', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 100,
        prepaid_method: 'cash',
        prepaid_note: 'fixture top-up',
        prepaid_at: new Date(),
      });
      // Charge Now already allocated $60 and reduced the invoice gross to
      // $40. A separate $20 account credit leaves only $20 actually due.
      await mockPg('invoices').where({ id: f.invoiceId }).update({ total: 40, credit_applied: 20 });
      await mockPg('payments').insert({
        customer_id: f.customerId,
        amount: 60,
        status: 'paid',
        payment_date: etDateString(),
        metadata: JSON.stringify({
          source: 'scheduled_service_prepaid',
          invoice_id: f.invoiceId,
          scheduled_service_id: f.serviceId,
          method: 'cash',
        }),
      });

      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(await mockPg('invoices').where({ id: f.invoiceId }).first('status', 'total', 'credit_applied'))
        .toMatchObject({ status: 'paid', total: '20.00', credit_applied: '20.00' });
      const allocations = await mockPg('payments')
        .where({ customer_id: f.customerId, status: 'paid' })
        .whereRaw("metadata::jsonb ->> 'invoice_id' = ?", [f.invoiceId])
        .whereRaw("metadata::jsonb ->> 'scheduled_service_id' = ?", [f.serviceId])
        .orderBy('created_at');
      expect(allocations.map((row) => Number(row.amount))).toEqual([60, 20]);
    } finally { await cleanup(f); }
  });

  test('completion rereads the locked visit marker before recording its cash amount and method', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 100,
        prepaid_method: 'cash',
        prepaid_note: 'stale marker',
        prepaid_at: new Date(),
      });
      require('../services/stripe').assertNoInvoiceChargeReconciliationPending
        .mockImplementationOnce(async (_invoiceId, connection) => {
          await connection('scheduled_services').where({ id: f.serviceId }).update({
            prepaid_amount: 60,
            prepaid_method: 'check',
            prepaid_note: 'locked marker',
          });
        });

      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(await mockPg('invoices').where({ id: f.invoiceId }).first('status', 'total', 'payment_method', 'payment_reference'))
        .toMatchObject({ status: 'sent', total: '20.00', payment_method: 'check', payment_reference: 'locked marker' });
      const allocation = await mockPg('payments').where({ customer_id: f.customerId }).first('amount', 'metadata');
      expect(Number(allocation.amount)).toBe(60);
      expect(allocation.metadata).toMatchObject({
        invoice_id: f.invoiceId,
        scheduled_service_id: f.serviceId,
        method: 'check',
        note: 'locked marker',
      });
    } finally { await cleanup(f); }
  });

  test('completion leaves the invoice and cash ledger untouched while an earlier saved-card attempt is fenced', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const StripeService = require('../services/stripe');
      const siblingId = randomUUID();
      StripeService.retrievePaymentIntent.mockClear();
      StripeService.cancelPaymentIntent.mockClear();
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 80,
        prepaid_method: 'cash',
        prepaid_at: new Date(),
      });
      await mockPg('invoices').where({ id: f.invoiceId }).update({ stripe_payment_intent_id: 'pi_held_completion' });
      await mockPg('invoices').insert({
        id: siblingId,
        customer_id: f.customerId,
        invoice_number: `TST-${siblingId.slice(0, 8)}`,
        token: randomUUID().replace(/-/g, ''),
        status: 'sent',
        total: 25,
        subtotal: 25,
        service_date: etDateString(),
        service_type: LAWN_TYPE,
        sent_at: new Date(),
        stripe_payment_intent_id: 'pi_held_completion',
        line_items: JSON.stringify([{ description: LAWN_TYPE, amount: 25, quantity: 1, unit_price: 25 }]),
      });
      StripeService.assertNoInvoiceChargeReconciliationPending.mockRejectedValueOnce(
        Object.assign(new Error('earlier card payment awaits verification'), {
          code: 'STRIPE_CHARGE_IN_PROGRESS',
          statusCode: 409,
          savedCardPending: true,
        }),
      );

      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(require('../services/stripe').assertNoInvoiceChargeReconciliationPending)
        .toHaveBeenCalledWith(f.invoiceId, expect.anything(), { checkout: true });
      expect(await mockPg('invoices').where({ id: f.invoiceId }).first('status', 'total', 'stripe_payment_intent_id'))
        .toMatchObject({ status: 'sent', total: '80.00', stripe_payment_intent_id: 'pi_held_completion' });
      expect(await mockPg('invoices').where({ id: siblingId }).first('status', 'stripe_payment_intent_id'))
        .toMatchObject({ status: 'sent', stripe_payment_intent_id: 'pi_held_completion' });
      expect(await mockPg('payments').where({ customer_id: f.customerId })).toHaveLength(0);
      expect(StripeService.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
  });

  test('completion retires a shared checkout before posting partial cash, and a retry cannot overcollect', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const StripeService = require('../services/stripe');
      const idempotencyKey = randomUUID();
      const siblingId = randomUUID();
      StripeService.retrievePaymentIntent.mockClear();
      StripeService.cancelPaymentIntent.mockClear();
      StripeService.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_short_completion',
        status: 'requires_payment_method',
      });
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 40,
        prepaid_method: 'cash',
        prepaid_at: new Date(),
      });
      await mockPg('invoices').where({ id: f.invoiceId }).update({
        stripe_payment_intent_id: 'pi_short_completion',
        processor: 'stripe',
      });
      await mockPg('invoices').insert({
        id: siblingId,
        customer_id: f.customerId,
        invoice_number: `TST-${siblingId.slice(0, 8)}`,
        token: randomUUID().replace(/-/g, ''),
        status: 'sent',
        total: 25,
        subtotal: 25,
        service_date: etDateString(),
        service_type: LAWN_TYPE,
        sent_at: new Date(),
        stripe_payment_intent_id: 'pi_short_completion',
        processor: 'stripe',
        line_items: JSON.stringify([{ description: LAWN_TYPE, amount: 25, quantity: 1, unit_price: 25 }]),
      });

      const out = await complete(f, { invoiceAlreadySent: true }, { idempotencyKey });
      expect(out.status).toBe(200);
      expect(await mockPg('invoices').where({ id: f.invoiceId })
        .first('status', 'total', 'stripe_payment_intent_id', 'processor'))
        .toMatchObject({ status: 'sent', total: '40.00', stripe_payment_intent_id: null, processor: null });
      expect(await mockPg('invoices').where({ id: siblingId }).first('status', 'stripe_payment_intent_id', 'processor'))
        .toMatchObject({ status: 'sent', stripe_payment_intent_id: null, processor: 'stripe' });
      expect((await mockPg('payments').where({ customer_id: f.customerId })).map((row) => Number(row.amount)))
        .toEqual([40]);
      expect(StripeService.retrievePaymentIntent).toHaveBeenCalledTimes(1);
      expect(StripeService.cancelPaymentIntent).toHaveBeenCalledTimes(1);
      expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith(
        'pi_short_completion',
        { cancellation_reason: 'abandoned' },
      );

      // A delivery retry of the same completion returns its recorded result.
      const retried = await complete(f, { invoiceAlreadySent: true }, { idempotencyKey });
      expect(retried.status).toBe(200);
      expect(retried.body).toEqual({ ...out.body, replayed: true });
      expect(await mockPg('invoices').where({ id: f.invoiceId })
        .first('status', 'total', 'stripe_payment_intent_id', 'processor'))
        .toMatchObject({ status: 'sent', total: '40.00', stripe_payment_intent_id: null, processor: null });
      expect((await mockPg('payments').where({ customer_id: f.customerId })).map((row) => Number(row.amount)))
        .toEqual([40]);
      expect(StripeService.retrievePaymentIntent).toHaveBeenCalledTimes(1);
      expect(StripeService.cancelPaymentIntent).toHaveBeenCalledTimes(1);
    } finally { await cleanup(f); }
  });

  test('completion reports overlapping cash when checkout money is already moving', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const StripeService = require('../services/stripe');
      const alert = jest.spyOn(require('../services/admin-alert-compose'), 'raiseAdminAlert')
        .mockResolvedValue({ id: 'fixture-alert' });
      const siblingId = randomUUID();
      StripeService.retrievePaymentIntent.mockClear();
      StripeService.cancelPaymentIntent.mockClear();
      StripeService.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_moving_completion',
        status: 'processing',
      });
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 40,
        prepaid_method: 'cash',
        prepaid_at: new Date(),
      });
      await mockPg('invoices').where({ id: f.invoiceId }).update({
        stripe_payment_intent_id: 'pi_moving_completion',
        processor: 'stripe',
      });
      await mockPg('invoices').insert({
        id: siblingId,
        customer_id: f.customerId,
        invoice_number: `TST-${siblingId.slice(0, 8)}`,
        token: randomUUID().replace(/-/g, ''),
        status: 'sent',
        total: 25,
        subtotal: 25,
        service_date: etDateString(),
        service_type: LAWN_TYPE,
        sent_at: new Date(),
        stripe_payment_intent_id: 'pi_moving_completion',
        processor: 'stripe',
        line_items: JSON.stringify([{ description: LAWN_TYPE, amount: 25, quantity: 1, unit_price: 25 }]),
      });

      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(await mockPg('invoices').where({ id: f.invoiceId })
        .first('status', 'total', 'stripe_payment_intent_id', 'processor'))
        .toMatchObject({ status: 'sent', total: '80.00', stripe_payment_intent_id: 'pi_moving_completion', processor: 'stripe' });
      expect(await mockPg('invoices').where({ id: siblingId }).first('status', 'stripe_payment_intent_id', 'processor'))
        .toMatchObject({ status: 'sent', stripe_payment_intent_id: 'pi_moving_completion', processor: 'stripe' });
      expect(await mockPg('payments').where({ customer_id: f.customerId })).toHaveLength(0);
      expect(StripeService.retrievePaymentIntent).toHaveBeenCalledWith('pi_moving_completion');
      expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
      expect(alert).toHaveBeenCalledWith('billing', expect.objectContaining({
        area: 'Billing',
        severity: 'needs-you',
        subject: { type: 'invoice', id: f.invoiceId },
        doneWhen: 'payment_reconciled',
      }), expect.objectContaining({
        bell: true,
        dedupeKey: `completion-prepaid-reconciliation:${f.invoiceId}:pi_moving_completion`,
        metadata: expect.objectContaining({
          customerId: f.customerId,
          invoiceId: f.invoiceId,
          reason: 'payment_in_flight',
          piStatus: 'processing',
          prepaidCents: 4000,
        }),
      }));
    } finally { await cleanup(f); }
  });

  test('completion preserves a shared checkout when the locked invoice becomes processing', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const StripeService = require('../services/stripe');
      const PayCombined = require('../services/pay-combined');
      const siblingId = randomUUID();
      StripeService.retrievePaymentIntent.mockClear();
      StripeService.cancelPaymentIntent.mockClear();
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 80,
        prepaid_method: 'cash',
        prepaid_at: new Date(),
      });
      await mockPg('invoices').where({ id: f.invoiceId }).update({
        stripe_payment_intent_id: 'pi_processing_completion',
        processor: 'stripe',
      });
      await mockPg('invoices').insert({
        id: siblingId,
        customer_id: f.customerId,
        invoice_number: `TST-${siblingId.slice(0, 8)}`,
        token: randomUUID().replace(/-/g, ''),
        status: 'sent',
        total: 25,
        subtotal: 25,
        service_date: etDateString(),
        service_type: LAWN_TYPE,
        sent_at: new Date(),
        stripe_payment_intent_id: 'pi_processing_completion',
        line_items: JSON.stringify([{ description: LAWN_TYPE, amount: 25, quantity: 1, unit_price: 25 }]),
      });
      const originalStableLock = PayCombined.lockCombinedCustomerStable;
      jest.spyOn(PayCombined, 'lockCombinedCustomerStable').mockImplementationOnce(async (trx, ...args) => {
        const ownerId = await originalStableLock(trx, ...args);
        await trx('invoices').where({ id: f.invoiceId }).update({ status: 'processing' });
        return ownerId;
      });

      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(await mockPg('invoices').where({ id: f.invoiceId })
        .first('status', 'total', 'stripe_payment_intent_id'))
        .toMatchObject({
          status: 'processing',
          total: '80.00',
          stripe_payment_intent_id: 'pi_processing_completion',
        });
      expect(await mockPg('invoices').where({ id: siblingId }).first('status', 'stripe_payment_intent_id'))
        .toMatchObject({ status: 'sent', stripe_payment_intent_id: 'pi_processing_completion' });
      expect(await mockPg('payments').where({ customer_id: f.customerId })).toHaveLength(0);
      expect(StripeService.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
  });

  test('completion retry preserves an open checkout after the visit cash was already allocated', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const StripeService = require('../services/stripe');
      StripeService.retrievePaymentIntent.mockClear();
      StripeService.cancelPaymentIntent.mockClear();
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 60,
        prepaid_method: 'cash',
        prepaid_at: new Date(),
      });
      await mockPg('invoices').where({ id: f.invoiceId }).update({
        total: 20,
        stripe_payment_intent_id: 'pi_retry_completion',
      });
      await mockPg('payments').insert({
        customer_id: f.customerId,
        amount: 60,
        status: 'paid',
        payment_date: etDateString(),
        metadata: JSON.stringify({
          source: 'scheduled_service_prepaid',
          invoice_id: f.invoiceId,
          scheduled_service_id: f.serviceId,
          method: 'cash',
        }),
      });

      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(await mockPg('invoices').where({ id: f.invoiceId }).first('status', 'total', 'stripe_payment_intent_id'))
        .toMatchObject({ status: 'sent', total: '20.00', stripe_payment_intent_id: 'pi_retry_completion' });
      expect(await mockPg('payments').where({ customer_id: f.customerId })).toHaveLength(1);
      expect(StripeService.retrievePaymentIntent).not.toHaveBeenCalled();
      expect(StripeService.cancelPaymentIntent).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
  });

  test('completion retires the locked checkout only after current cash can settle the balance', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const StripeService = require('../services/stripe');
      StripeService.retrievePaymentIntent.mockClear();
      StripeService.cancelPaymentIntent.mockClear();
      StripeService.retrievePaymentIntent.mockResolvedValueOnce({
        id: 'pi_settled_completion',
        status: 'requires_payment_method',
      });
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({
        prepaid_amount: 80,
        prepaid_method: 'cash',
        prepaid_at: new Date(),
      });
      await mockPg('invoices').where({ id: f.invoiceId }).update({
        stripe_payment_intent_id: 'pi_settled_completion',
        processor: 'stripe',
      });

      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      expect(await mockPg('invoices').where({ id: f.invoiceId })
        .first('status', 'total', 'stripe_payment_intent_id', 'processor'))
        .toMatchObject({
          status: 'paid',
          total: '0.00',
          stripe_payment_intent_id: null,
          processor: null,
        });
      expect((await mockPg('payments').where({ customer_id: f.customerId })).map((row) => Number(row.amount)))
        .toEqual([80]);
      expect(StripeService.retrievePaymentIntent).toHaveBeenCalledWith('pi_settled_completion');
      expect(StripeService.cancelPaymentIntent).toHaveBeenCalledWith(
        'pi_settled_completion',
        { cancellation_reason: 'abandoned' },
      );
    } finally { await cleanup(f); }
  });

  test('control: the same sent invoice WITHOUT the invoice field is reused, not duplicated, but the customer is texted the pay link again', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const out = await complete(f, {});
      expect(out.status).toBe(200);
      expect(await invoicesOf(f)).toHaveLength(1);
      // This is what the invoice field prevents: the second pay-link text and the second in-person payment prompt.
      expect(textsWithPayLink()).toHaveLength(1);
      expect(completionTexts()[0].metadata.templateKey).toBe('service_complete_with_invoice');
      expect(out.body.invoicePaymentActionRequired).toBe(true);
    } finally { await cleanup(f); }
  });

  test('the unpaid invoice does not hold the review ask, and once it answered the record carries the marker the payment reads', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      const out = await complete(f, {});
      expect(out.status).toBe(200);
      // The customer still gets the one pay-link report text.
      expect(textsWithPayLink()).toHaveLength(1);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record.structured_notes.reviewAskedAtVisit).toBe(true);
      expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
      expect(ReviewService.enrollPostService.mock.calls[0][0]).toMatchObject({ customerId: f.customerId, serviceRecordId: record.id });
    } finally { await cleanup(f); }
  });

  test.each([
    ['a passing failure (plan_resolution_failed) writes no marker: the payment stays the recovery', { started: false, reason: 'plan_resolution_failed' }, undefined],
    ['a final skip (recently asked) writes the marker: the payment asks nothing', { started: false, reason: 'manual_ask_recent' }, true],
  ])('the visit-time enrollment does not start: %s', async (_label, outcome, marker) => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    ReviewService.enrollPostService.mockResolvedValueOnce(outcome);
    try {
      expect((await complete(f, {})).status).toBe(200);
      expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record.structured_notes.reviewAskedAtVisit).toBe(marker);
    } finally { await cleanup(f); }
  });

  test('a completion that posts no requestReview: no visit-time ask, so no marker and the payment keeps its ask', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      expect((await complete(f, { requestReview: undefined })).status).toBe(200);
      expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      // The stored intent still reads "ask" (the payment path's reading), and no marker skips it.
      expect(record.structured_notes.requestReview).toBe(true);
      expect(record.structured_notes.reviewAskedAtVisit).toBeUndefined();
    } finally { await cleanup(f); }
  });

  test.each([
    ['the visit-time ask runs: the marker is written, so a later paid event asks nothing', {}, 1, true],
    ['no requestReview posted: no visit-time ask, so no marker and a paid event keeps its old ask', { requestReview: undefined }, 0, undefined],
  ])('a paid invoice: %s', async (_label, fields, asks, marker) => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'paid' });
    try {
      expect((await complete(f, fields)).status).toBe(200);
      expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(asks);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record.structured_notes.reviewAskedAtVisit).toBe(marker);
    } finally { await cleanup(f); }
  });

  test('a paid invoice (a charge taken at the door, no invoice field posted): it stays paid, no second invoice, no pay-link text', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'paid' });
    try {
      const out = await complete(f, {});
      expect(out.status).toBe(200);
      const invoices = await invoicesOf(f);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ id: f.invoiceId, status: 'paid' });
      expect(textsWithPayLink()).toEqual([]);
      expect(completionTexts().map((t) => t.metadata.templateKey)).toHaveLength(1);
      expect(out.body.invoicePaymentActionRequired).toBe(false);
    } finally { await cleanup(f); }
  });

  test('a paid invoice with the invoice field posted too: the same outcome', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'paid' });
    try {
      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      const invoices = await invoicesOf(f);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ id: f.invoiceId, status: 'paid' });
      expect(textsWithPayLink()).toEqual([]);
    } finally { await cleanup(f); }
  });

  test('extra form fields beside the invoice field do not change the branch (the full form posts more than a sheet does)', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    try {
      // The full form posts the same flags plus its own form fields; the invoice field is the one both carry.
      const out = await complete(f, { invoiceAlreadySent: true, offerInspectionCredit: true, reviewDelayMinutes: null });
      expect(out.status).toBe(200);
      expect(await invoicesOf(f)).toHaveLength(1);
      expect(textsWithPayLink()).toEqual([]);
      expect(out.body.invoicePaymentActionRequired).toBe(false);
    } finally { await cleanup(f); }
  });

  // An invoice made before the visit (the estimate-accept first application) keeps the day it was minted with when the
  // visit is moved. Completion reuses it, so without a redate the charge and the receipt read the old day.
  const fiveDaysAgo = () => etDateString(new Date(Date.now() - 5 * 24 * 60 * 60 * 1000));
  const dayOf = async (table, where) => (await mockPg(table).where(where).first(mockPg.raw('service_date::text AS day'))).day;

  test('a sent invoice still dated before the move takes the service record\'s day; still one invoice, same total and status', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent', invoiceDay: fiveDaysAgo() });
    try {
      const out = await complete(f, { invoiceAlreadySent: true });
      expect(out.status).toBe(200);
      const recordDay = await dayOf('service_records', { scheduled_service_id: f.serviceId });
      expect(recordDay).toBe(etDateString(new Date()));
      const invoices = await invoicesOf(f);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ id: f.invoiceId, status: 'sent' });
      expect(Number(invoices[0].total)).toBe(PRICE);
      expect(await dayOf('invoices', { id: f.invoiceId })).toBe(recordDay);
    } finally { await cleanup(f); }
  });

  test('a draft dated before the move (an estimate-accept invoice not sent yet) takes the service record\'s day', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'draft', invoiceDay: fiveDaysAgo() });
    try {
      const out = await complete(f, {});
      expect(out.status).toBe(200);
      expect(await invoicesOf(f)).toHaveLength(1);
      expect(await dayOf('invoices', { id: f.invoiceId }))
        .toBe(await dayOf('service_records', { scheduled_service_id: f.serviceId }));
    } finally { await cleanup(f); }
  });

  test('a paid invoice dated before the move keeps its day: only an invoice an edit could still rewrite is redated', async () => {
    const oldDay = fiveDaysAgo();
    const f = await seedInvoicedVisit({ invoiceStatus: 'paid', invoiceDay: oldDay });
    try {
      const out = await complete(f, {});
      expect(out.status).toBe(200);
      const invoices = await invoicesOf(f);
      expect(invoices).toHaveLength(1);
      expect(invoices[0]).toMatchObject({ id: f.invoiceId, status: 'paid' });
      expect(await dayOf('invoices', { id: f.invoiceId })).toBe(oldDay);
    } finally { await cleanup(f); }
  });
});

// A completion form sent days after the tech's arrival (owner 2026-10-31): the record takes the arrival day, every
// invoice on the visit carries that day, and an invoice minted from the backdated record is due from today.
const daysAgo = (n) => etDateString(new Date(Date.now() - n * 24 * 60 * 60 * 1000));
const arrivalOn = (day) => new Date(`${day}T14:00:00Z`); // 10 AM EDT or 9 AM EST: the same Eastern day
const recordDayOf = (f) => mockPg('service_records').where({ scheduled_service_id: f.serviceId })
  .first(mockPg.raw('service_date::text AS day')).then((row) => row.day);
const invoiceDaysOf = (f) => mockPg('invoices').where({ customer_id: f.customerId })
  .select(mockPg.raw('service_date::text AS day'), mockPg.raw('due_date::text AS due'));

postgres('a completion form sent days after the tech arrived', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  beforeEach(() => { sendCustomerMessage.mockClear(); });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('the record takes the arrival day; the invoice the completion mints carries it and is due today, not overdue', async () => {
    const arrivalDay = daysAgo(3);
    const f = await seedInvoicedVisit({ invoiceStatus: null, visitDay: arrivalDay, arrivedAt: arrivalOn(arrivalDay) });
    try {
      const out = await complete(f, { timeOnSite: 30 });
      expect(out.status).toBe(200);
      expect(await recordDayOf(f)).toBe(arrivalDay);
      expect(await invoiceDaysOf(f)).toEqual([{ day: arrivalDay, due: etDateString(new Date()) }]);
    } finally { await cleanup(f); }
  });

  test('an invoice made before the visit and dated earlier still takes the arrival day', async () => {
    const arrivalDay = daysAgo(3);
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent', invoiceDay: daysAgo(8), visitDay: arrivalDay, arrivedAt: arrivalOn(arrivalDay) });
    try {
      const out = await complete(f, { invoiceAlreadySent: true, timeOnSite: 30 });
      expect(out.status).toBe(200);
      expect(await recordDayOf(f)).toBe(arrivalDay);
      expect((await invoiceDaysOf(f)).map((row) => row.day)).toEqual([arrivalDay]);
    } finally { await cleanup(f); }
  });

  test('control: a past visit with no arrival stamp keeps the form day', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent', visitDay: daysAgo(3) });
    try {
      const out = await complete(f, { invoiceAlreadySent: true, timeOnSite: 30 });
      expect(out.status).toBe(200);
      expect(await recordDayOf(f)).toBe(etDateString(new Date()));
    } finally { await cleanup(f); }
  });
});
