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
jest.mock('../services/review-request', () => ({ reportTextAnchorForRecord: jest.fn(async () => null), reportTextAnchorForVisit: jest.fn(async () => null), enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));


const knex = require('knex');
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const ReviewService = require('../services/review-request');

// Verified private clone only — never a shared or production URL. Accepts this suite's own
// waves_invoiced_fast_test clone or CI's isolated waves_test. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the marker the CI "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_invoiced_fast_test';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Invoiced-visit Postgres tests require their own waves_invoiced_fast_test or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
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

async function complete(f, invoiceFields) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
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
  });
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
      expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record).toBeTruthy();
      // GATE_REVIEW_ASK_AT_VISIT off: no marker, so the payment still starts the ask.
      expect(record.structured_notes.reviewAskAtVisit).toBeUndefined();
      expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status).toBe('completed');
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

  test('GATE_REVIEW_ASK_AT_VISIT on (owner 2026-11-01): the unpaid invoice no longer holds the review ask, and the record freezes the marker the payment reads', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    process.env.GATE_REVIEW_ASK_AT_VISIT = 'true';
    try {
      const out = await complete(f, {});
      expect(out.status).toBe(200);
      // The customer still gets the one pay-link report text.
      expect(textsWithPayLink()).toHaveLength(1);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record.structured_notes.reviewAskAtVisit).toBe(true);
      expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
      expect(ReviewService.enrollPostService.mock.calls[0][0]).toMatchObject({ customerId: f.customerId, serviceRecordId: record.id });
    } finally { delete process.env.GATE_REVIEW_ASK_AT_VISIT; await cleanup(f); }
  });

  test.each([
    ['a passing failure (plan_resolution_failed) turns the marker off: the payment stays the recovery', { started: false, reason: 'plan_resolution_failed' }, false],
    ['a final skip (recently asked) keeps the marker: the payment asks nothing', { started: false, reason: 'manual_ask_recent' }, true],
  ])('GATE_REVIEW_ASK_AT_VISIT on, the visit-time enrollment does not start: %s', async (_label, outcome, marker) => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    process.env.GATE_REVIEW_ASK_AT_VISIT = 'true';
    ReviewService.enrollPostService.mockResolvedValueOnce(outcome);
    try {
      expect((await complete(f, {})).status).toBe(200);
      expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(1);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record.structured_notes.reviewAskAtVisit).toBe(marker);
    } finally { delete process.env.GATE_REVIEW_ASK_AT_VISIT; await cleanup(f); }
  });

  test('GATE_REVIEW_ASK_AT_VISIT on, a completion that posts no requestReview: no visit-time ask, so the marker turns off and the payment keeps its ask', async () => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'sent' });
    process.env.GATE_REVIEW_ASK_AT_VISIT = 'true';
    try {
      expect((await complete(f, { requestReview: undefined })).status).toBe(200);
      expect(ReviewService.enrollPostService).not.toHaveBeenCalled();
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      // The stored intent still reads "ask" (the payment path's reading), and the marker no longer skips it.
      expect(record.structured_notes.requestReview).toBe(true);
      expect(record.structured_notes.reviewAskAtVisit).toBe(false);
    } finally { delete process.env.GATE_REVIEW_ASK_AT_VISIT; await cleanup(f); }
  });

  test.each([
    ['the visit-time ask runs: the marker stays on, so a later paid event asks nothing', {}, 1, true],
    ['no requestReview posted: no visit-time ask, so the marker turns off and a paid event keeps its old ask', { requestReview: undefined }, 0, false],
  ])('GATE_REVIEW_ASK_AT_VISIT on, a paid invoice: %s', async (_label, fields, asks, marker) => {
    const f = await seedInvoicedVisit({ invoiceStatus: 'paid' });
    process.env.GATE_REVIEW_ASK_AT_VISIT = 'true';
    try {
      expect((await complete(f, fields)).status).toBe(200);
      expect(ReviewService.enrollPostService).toHaveBeenCalledTimes(asks);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(record.structured_notes.reviewAskAtVisit).toBe(marker);
    } finally { delete process.env.GATE_REVIEW_ASK_AT_VISIT; await cleanup(f); }
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
