// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// ADMIN-BUG-R13 (owner ruling 2026-09-26: auto-bill): completing an
// annual-prepay-covered visit that carries a priced add-on billed nothing,
// said "all paid", and alerted no one. The add-ons are now billed alone
// through the shared scheduled-invoice mint; the covered base never is, and
// an amount the visit-wide discounts make unclear goes to an office alert.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'), getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: jest.fn(),
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

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

const BASE = 50;
const ADDON = 40;

postgres('annual-prepay-covered visit add-ons are billed at completion', () => {
  let database;
  let trx;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    require('../models/db').connection = database;
    // Cold transforms of the completion module graph stay outside a test's timer.
    require('../services/complete-scheduled-service');
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    require('../models/db').connection = trx;
    require('../services/annual-prepay-renewals')._private.resetCachesForTests();
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function coveredVisit({ discountDollars = null, invoiceLines = null } = {}) {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const today = etDateString();
    const f = {
      customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(),
      termId: randomUUID(), addonId: randomUUID(), invoiceId: null,
    };
    await trx('customers').insert({ id: f.customerId, first_name: 'Synthetic', last_name: 'Prepay', phone: '+12025550123',
      email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'annual_prepay' });
    await trx('technicians').insert({ id: f.techId, name: 'Synthetic Technician', role: 'technician', active: true });
    await trx('services').insert({ id: f.catalogId, name: 'Synthetic Quarterly Pest Control', service_key: `synthetic_${f.catalogId}`, is_active: true });
    await trx('annual_prepay_terms').insert({ id: f.termId, customer_id: f.customerId, status: 'active',
      term_start: etDateString(addETDays(new Date(), -30)), term_end: etDateString(addETDays(new Date(), 335)),
      prepay_amount: 200, plan_label: 'Synthetic Annual' });
    await trx('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
      service_type: 'Synthetic Quarterly Pest Control', scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
      estimated_price: BASE + ADDON - (discountDollars || 0), primary_line_price: BASE, estimated_duration_minutes: 60,
      create_invoice_on_complete: true,
      prepaid_method: 'annual_prepay_invoice', prepaid_amount: BASE, annual_prepay_term_id: f.termId,
      ...(discountDollars ? { discount_dollars: discountDollars, discount_name: 'Synthetic visit discount', discount_type: 'fixed_amount', discount_amount: discountDollars } : {}) });
    await trx('scheduled_service_addons').insert({ id: f.addonId, scheduled_service_id: f.serviceId,
      service_name: 'Wasp nest removal', estimated_price: ADDON, base_price: ADDON });
    if (invoiceLines) {
      f.invoiceId = randomUUID();
      const lines = invoiceLines(f);
      const total = lines.reduce((sum, li) => sum + li.amount, 0);
      await trx('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId,
        invoice_number: `TEST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
        total, subtotal: total, service_date: today, line_items: JSON.stringify(lines) });
    }
    return f;
  }

  const baseLine = (f) => ({ client_id: `scheduled_${f.serviceId}_primary`, description: 'Synthetic Quarterly Pest Control', amount: BASE, quantity: 1, unit_price: BASE });
  const addonLine = (f) => ({ client_id: `scheduled_${f.serviceId}_addon_${f.addonId}`, description: 'Wasp nest removal', amount: ADDON, quantity: 1, unit_price: ADDON });

  async function complete(f, body = {}) {
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
      actor: { techRole: 'admin', technicianId: f.techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false, ...body } });
  }

  const liveInvoices = (f) => trx('invoices').where({ customer_id: f.customerId }).whereNotIn('status', ['void']);
  const linesOf = (invoice) => (typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items) || [];
  const addonsAlert = (f) => trx('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_addons_unbilled:${f.serviceId}`]).first();

  test('with no invoice yet, the add-ons are billed alone and the covered base is not', async () => {
    const f = await coveredVisit();
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });

    const invoices = await liveInvoices(f);
    expect(invoices).toHaveLength(1);
    const [bill] = invoices;
    expect(['draft', 'sent']).toContain(bill.status);
    expect(Number(bill.total)).toBe(ADDON);
    expect(linesOf(bill).map((li) => li.client_id)).toEqual([`scheduled_${f.serviceId}_addon_${f.addonId}`]);
    expect(out.body?.invoiceId).toBe(bill.id);
    expect(await addonsAlert(f)).toBeUndefined();
  });

  test('a visit-wide discount makes the add-ons\' share unclear — the office is alerted, nothing is guessed, and the text does not say "all paid"', async () => {
    const f = await coveredVisit({ discountDollars: 9 });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
    expect(await addonsAlert(f)).toBeTruthy();
    const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
    const smsTypes = sendCustomerMessage.mock.calls.map(([args]) => args?.metadata?.smsType || args?.messageType || args?.templateKey).filter(Boolean);
    expect(smsTypes).not.toContain('service_complete_annual_prepay');
    expect(smsTypes).not.toContain('service_complete_prepaid');
  });

  test('an office invoice mixing the covered base with the add-on is voided and the add-on billed alone', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
    const invoices = await liveInvoices(f);
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].total)).toBe(ADDON);
    expect(linesOf(invoices[0]).some((li) => String(li.client_id).endsWith('_primary'))).toBe(false);
  });

  test('an invoice that already bills only the add-ons is kept as the bill (no void, no second invoice)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [addonLine(x)] });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    const invoices = await liveInvoices(f);
    expect(invoices.map((i) => i.id)).toEqual([f.invoiceId]);
    expect(out.body?.invoiceId).toBe(f.invoiceId);
  });

  test('a covered visit without add-ons still bills nothing', async () => {
    const f = await coveredVisit();
    await trx('scheduled_service_addons').where({ id: f.addonId }).del();
    await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
  });

  test('a visit that performed no application bills no add-ons', async () => {
    const f = await coveredVisit();
    const out = await complete(f, { visitOutcome: 'inspection_only' });
    expect(out).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
  });
});
