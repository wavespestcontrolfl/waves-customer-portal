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
const ADDON2 = 25;

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
    process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'true';
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
  afterAll(async () => {
    delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
    await database?.destroy();
  });

  async function coveredVisit({ discountDollars = null, invoiceLines = null, invoiceStatus = 'draft', daysAgo = 0, depositDollars = null, secondAddon = false } = {}) {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const today = daysAgo ? etDateString(addETDays(new Date(), -daysAgo)) : etDateString();
    const f = {
      customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(),
      termId: randomUUID(), addonId: randomUUID(), addon2Id: randomUUID(), invoiceId: null,
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
      estimated_price: BASE + ADDON + (secondAddon ? ADDON2 : 0) - (discountDollars || 0), primary_line_price: BASE, estimated_duration_minutes: 60,
      create_invoice_on_complete: true,
      prepaid_method: 'annual_prepay_invoice', prepaid_amount: BASE, annual_prepay_term_id: f.termId,
      ...(discountDollars ? { discount_dollars: discountDollars, discount_name: 'Synthetic visit discount', discount_type: 'fixed_amount', discount_amount: discountDollars } : {}) });
    await trx('scheduled_service_addons').insert({ id: f.addonId, scheduled_service_id: f.serviceId,
      service_name: 'Wasp nest removal', estimated_price: ADDON, base_price: ADDON });
    if (secondAddon) {
      await trx('scheduled_service_addons').insert({ id: f.addon2Id, scheduled_service_id: f.serviceId,
        service_name: 'Fire ant mound treatment', estimated_price: ADDON2, base_price: ADDON2 });
    }
    if (depositDollars) {
      f.estimateId = randomUUID();
      await trx('estimates').insert({ id: f.estimateId, customer_id: f.customerId, status: 'accepted' });
      await trx('scheduled_services').where({ id: f.serviceId }).update({ source_estimate_id: f.estimateId });
      await trx('estimate_deposits').insert({ estimate_id: f.estimateId, customer_id: f.customerId,
        amount: depositDollars, status: 'received', stripe_payment_intent_id: `pi_fixture_${randomUUID()}` });
    }
    if (invoiceLines) {
      f.invoiceId = randomUUID();
      const lines = invoiceLines(f);
      const total = lines.reduce((sum, li) => sum + li.amount, 0);
      await trx('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.serviceId,
        invoice_number: `TEST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: invoiceStatus,
        total, subtotal: total, service_date: today, line_items: JSON.stringify(lines),
        // The office's invoice predates the closeout, as in production (a
        // shared transaction stamps every row with the same now()).
        created_at: new Date(Date.now() - 86400000),
        ...(invoiceStatus === 'prepaid' ? { annual_prepay_covered_term_id: f.termId } : {}) });
    }
    return f;
  }

  const baseLine = (f) => ({ client_id: `scheduled_${f.serviceId}_primary`, description: 'Synthetic Quarterly Pest Control', amount: BASE, quantity: 1, unit_price: BASE });
  const addonLine = (f) => ({ client_id: `scheduled_${f.serviceId}_addon_${f.addonId}`, description: 'Wasp nest removal', amount: ADDON, quantity: 1, unit_price: ADDON });

  async function complete(f, body = {}, { idempotencyKey = randomUUID() } = {}) {
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    return completeScheduledService({ serviceId: f.serviceId, idempotencyKey,
      actor: { techRole: 'admin', technicianId: f.techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false, ...body } });
  }

  const liveInvoices = (f) => trx('invoices').where({ customer_id: f.customerId }).whereNotIn('status', ['void']);
  const linesOf = (invoice) => (typeof invoice.line_items === 'string' ? JSON.parse(invoice.line_items) : invoice.line_items) || [];
  // What a crash after the commit leaves behind: the attempt handed back
  // for a same-key retry to resume.
  const releaseForResume = (f) => trx('service_completion_attempts').where({ service_id: f.serviceId })
    .update({ status: 'side_effects_pending' });
  const officeAddonDiscount = (x) => ({ client_id: `discount_office_${x.addonId}`, _kind: 'discount', discount_for: addonLine(x).client_id,
    description: 'Office courtesy', amount: -10, quantity: 1, unit_price: -10 });
  // The office bell fails to save for these dedupe keys (notifyAdmin's
  // null return); every other notification lands as usual.
  function failAlerts(matches) {
    const NotificationService = require('../services/notification-service');
    const realNotify = NotificationService.notifyAdmin.bind(NotificationService);
    return jest.spyOn(NotificationService, 'notifyAdmin').mockImplementation(async (...args) => (
      matches(String(args[3]?.dedupeKey || '')) ? null : realNotify(...args)));
  }
  // The R13 classifier's read of the visit's add-on rows fails (a Proxy
  // over the test transaction, matched on the reading function's frame);
  // every other query runs as usual.
  function failAddonRowReads() {
    const dbMock = require('../models/db');
    const real = dbMock.connection;
    dbMock.connection = new Proxy(real, {
      apply(target, thisArg, args) {
        if (args[0] === 'scheduled_service_addons' && /annualPrepayAddonRows/.test(new Error().stack)) {
          throw new Error('synthetic add-on read failure');
        }
        return Reflect.apply(target, thisArg, args);
      },
    });
    return () => { dbMock.connection = real; };
  }
  const PAID_TEXTS = ['service_complete_annual_prepay', 'service_complete_prepaid', 'service_complete_paid_receipt'];
  const attemptStatus = async (f) => (await trx('service_completion_attempts').where({ service_id: f.serviceId }).first('status'))?.status;
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

  test('an office invoice that discounted the add-on its own way is voided but not re-billed at list — the office reconciles', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x),
      { client_id: `discount_office_${x.addonId}`, _kind: 'discount', discount_for: addonLine(x).client_id, description: 'Office courtesy', amount: -10, quantity: 1, unit_price: -10 },
    ] });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
    expect(await liveInvoices(f)).toHaveLength(0);
    expect(await addonsAlert(f)).toBeTruthy();
  });

  test('a base-only office invoice settles as covered and the add-ons it never carried are still billed', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)] });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('prepaid');
    const bills = (await liveInvoices(f)).filter((i) => i.id !== f.invoiceId);
    expect(bills).toHaveLength(1);
    expect(Number(bills[0].total)).toBe(ADDON);
    expect(await addonsAlert(f)).toBeUndefined();
  });

  test('an invoice that already bills only the add-ons is kept as the bill (no void, no second invoice)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [addonLine(x)] });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    const invoices = await liveInvoices(f);
    expect(invoices.map((i) => i.id)).toEqual([f.invoiceId]);
    expect(out.body?.invoiceId).toBe(f.invoiceId);
  });

  test('an office invoice that is not provably add-ons-only is voided, the add-ons re-billed, and its other charge flagged', async () => {
    const f = await coveredVisit({ invoiceLines: () => [
      { description: 'Quarterly pest treatment', amount: BASE, quantity: 1, unit_price: BASE },
    ] });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
    const invoices = await liveInvoices(f);
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].total)).toBe(ADDON);
    expect(await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).first()).toBeTruthy();
  });

  test('priced add-ons that build no invoice lines alert the office instead of reading as "nothing owed"', async () => {
    const f = await coveredVisit();
    const InvoiceService = require('../services/invoice');
    const build = jest.spyOn(InvoiceService, 'buildLineItemsForScheduledService').mockResolvedValue({ lineItems: [], discountIds: [] });
    try {
      const out = await complete(f);
      expect(out).toMatchObject({ status: 200 });
    } finally {
      build.mockRestore();
    }
    expect(await liveInvoices(f)).toHaveLength(0);
    expect(await addonsAlert(f)).toBeTruthy();
  });

  test('a covered visit without add-ons still bills nothing', async () => {
    const f = await coveredVisit();
    await trx('scheduled_service_addons').where({ id: f.addonId }).del();
    await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
  });

  test('a retry after the covered base was settled but before its add-ons were billed still bills them (P0 resume)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'prepaid' });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('prepaid');
    const bills = (await liveInvoices(f)).filter((i) => i.id !== f.invoiceId);
    expect(bills).toHaveLength(1);
    expect(Number(bills[0].total)).toBe(ADDON);
    expect(linesOf(bills[0]).map((li) => li.client_id)).toEqual([`scheduled_${f.serviceId}_addon_${f.addonId}`]);
    expect(out.body?.invoiceId).toBe(bills[0].id);
  });

  test('a retry that finds the add-ons sibling already minted beside the settled base adopts it, never a second bill', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'prepaid' });
    const siblingId = randomUUID();
    await trx('invoices').insert({ id: siblingId, customer_id: f.customerId, scheduled_service_id: f.serviceId,
      invoice_number: `TEST-${siblingId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
      total: ADDON, subtotal: ADDON, line_items: JSON.stringify([addonLine(f)]), created_at: new Date(Date.now() + 1000) });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    const bills = (await liveInvoices(f)).filter((i) => i.id !== f.invoiceId);
    expect(bills.map((i) => i.id)).toEqual([siblingId]);
  });

  test('an add-ons bill partly funded by the estimate deposit is recognised as the add-ons bill and kept', async () => {
    const f = await coveredVisit({ depositDollars: 10 });
    // The bill an earlier pass minted: add-on line + ledger-backed deposit credit.
    const InvoiceService = require('../services/invoice');
    const bill = await InvoiceService.create({ database: trx, customerId: f.customerId, scheduledServiceId: f.serviceId,
      title: 'Synthetic Quarterly Pest Control', lineItems: [addonLine(f)],
      depositCredit: { amount: 10, estimateId: f.estimateId }, dueDate: require('../utils/datetime-et').etDateString() });
    expect(Number(bill.applied_deposit_credit)).toBe(10);
    await trx('estimate_deposits').where({ estimate_id: f.estimateId }).update({ credited_amount: 10, credited_invoice_id: bill.id });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: bill.id }).first('status')).status).not.toBe('void');
    expect((await liveInvoices(f)).map((i) => i.id)).toEqual([bill.id]);
    expect(out.body?.invoiceId).toBe(bill.id);
    expect(await addonsAlert(f)).toBeUndefined();
  });

  test('a live completion rolls the estimate deposit onto the add-ons bill', async () => {
    const f = await coveredVisit({ depositDollars: 10 });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    const [bill] = await liveInvoices(f);
    expect(Number(bill.total)).toBe(ADDON - 10);
    expect(linesOf(bill).some((li) => li.category === 'deposit_credit')).toBe(true);
  });

  test('a quiet backfill completion bills the add-ons at face value, due today, and leaves the deposit on its ledger', async () => {
    const f = await coveredVisit({ depositDollars: 10, daysAgo: 3 });
    const out = await complete(f, { backfill: true, timeOnSite: 45 });
    expect(out).toMatchObject({ status: 200 });
    const invoices = await liveInvoices(f);
    expect(invoices).toHaveLength(1);
    const [bill] = invoices;
    expect(Number(bill.total)).toBe(ADDON);
    expect(linesOf(bill).some((li) => li.category === 'deposit_credit')).toBe(false);
    const { etDateString } = require('../utils/datetime-et');
    expect(String(bill.due_date instanceof Date ? bill.due_date.toISOString() : bill.due_date).slice(0, 10)).toBe(etDateString());
    const deposit = await trx('estimate_deposits').where({ estimate_id: f.estimateId }).first();
    expect(Number(deposit.credited_amount || 0)).toBe(0);
  });

  test('a retry after a crash past the void still prices the add-ons against the voided office invoice — never re-billed at list (pre-push P0 r2)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x), officeAddonDiscount(x)] });
    const idempotencyKey = randomUUID();
    expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
    // The crash: the void committed, the office-pricing check never ran.
    await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_addons_unbilled:${f.serviceId}`]).del();
    await releaseForResume(f);
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
    expect(await addonsAlert(f)).toBeTruthy();
  });

  test('a retry after a crash past the void of a list-priced office invoice bills the add-ons and flags its other charges', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x),
      { description: 'Synthetic trip charge', amount: 15, quantity: 1, unit_price: 15 }] });
    const idempotencyKey = randomUUID();
    expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    // The crash: the void committed; no alert, no add-ons bill yet.
    await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).del();
    await trx('invoices').where({ customer_id: f.customerId }).whereNot({ id: f.invoiceId }).del();
    await releaseForResume(f);
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    const invoices = await liveInvoices(f);
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].total)).toBe(ADDON);
    expect(await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).first()).toBeTruthy();
  });

  test('a void that throws after it committed still bills the add-ons (the invoice IS void)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
    const InvoiceService = require('../services/invoice');
    const realVoid = InvoiceService.voidInvoice.bind(InvoiceService);
    const spy = jest.spyOn(InvoiceService, 'voidInvoice').mockImplementation(async (id) => {
      await realVoid(id);
      throw new Error('voided, but its annual-prepay/setup restorations failed');
    });
    let out;
    try {
      out = await complete(f);
    } finally {
      spy.mockRestore();
    }
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
    const invoices = await liveInvoices(f);
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].total)).toBe(ADDON);
    expect(out.body?.invoiceId).toBe(invoices[0].id);
  });

  test('a resumed completion that finds the add-ons bill beside the settled base still collects it — not "all paid" (pre-push P1 r2)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)] });
    const idempotencyKey = randomUUID();
    const first = await complete(f, {}, { idempotencyKey });
    expect(first).toMatchObject({ status: 200 });
    const [bill] = (await liveInvoices(f)).filter((i) => i.id !== f.invoiceId);
    expect(bill).toBeTruthy();
    expect(first.body?.invoicePaymentActionRequired).toBe(true);
    await releaseForResume(f);
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(retry.body?.invoiceId).toBe(bill.id);
    expect(retry.body?.invoicePaymentActionRequired).toBe(true);
    expect((await liveInvoices(f)).filter((i) => i.id !== f.invoiceId).map((i) => i.id)).toEqual([bill.id]);
  });

  test('an add-ons alert that is not recorded leaves the closeout unfinalized, and the retry raises it (pre-push P1 r3)', async () => {
    const f = await coveredVisit({ discountDollars: 9 });
    const idempotencyKey = randomUUID();
    const spy = failAlerts((key) => key === `annual_prepay_addons_unbilled:${f.serviceId}`);
    let first;
    try {
      first = await complete(f, {}, { idempotencyKey });
    } finally {
      spy.mockRestore();
    }
    expect(first).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_alert_failed' } });
    expect(await attemptStatus(f)).toBe('side_effects_pending');
    expect(await addonsAlert(f)).toBeUndefined();
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(await addonsAlert(f)).toBeTruthy();
    expect(await liveInvoices(f)).toHaveLength(0);
  });

  test('a voided-invoice alert that is not recorded holds the add-ons bill until the retry raises it', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x),
      { description: 'Synthetic trip charge', amount: 15, quantity: 1, unit_price: 15 }] });
    const reconcileAlert = () => trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).first();
    const idempotencyKey = randomUUID();
    const spy = failAlerts((key) => key === `annual_prepay_invoice_reconcile:${f.serviceId}`);
    let first;
    try {
      first = await complete(f, {}, { idempotencyKey });
    } finally {
      spy.mockRestore();
    }
    expect(first).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_alert_failed' } });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
    expect(await liveInvoices(f)).toHaveLength(0);
    expect(await reconcileAlert()).toBeUndefined();
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(await reconcileAlert()).toBeTruthy();
    const invoices = await liveInvoices(f);
    expect(invoices).toHaveLength(1);
    expect(Number(invoices[0].total)).toBe(ADDON);
  });

  test('an add-on read that fails while checking an existing invoice leaves the closeout unfinalized and the invoice untouched; the retry collects it (pre-push P1 r4)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [addonLine(x)] });
    const idempotencyKey = randomUUID();
    const restore = failAddonRowReads();
    let first;
    try {
      first = await complete(f, { sendCompletionSms: true }, { idempotencyKey });
    } finally {
      restore();
    }
    expect(first).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
    expect(await attemptStatus(f)).toBe('side_effects_pending');
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('draft');
    const retry = await complete(f, { sendCompletionSms: true }, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(retry.body?.invoiceId).toBe(f.invoiceId);
    expect(retry.body?.invoicePaymentActionRequired).toBe(true);
    expect(PAID_TEXTS).not.toContain(retry.body?.completionSmsType);
  });

  test('an office invoice that cannot be voided stays for normal handling, the office is alerted, and the text does not say "all paid"', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
    const InvoiceService = require('../services/invoice');
    const spy = jest.spyOn(InvoiceService, 'voidInvoice').mockRejectedValue(new Error('Invoice status changed while voiding — re-check and retry'));
    let out;
    try {
      out = await complete(f, { sendCompletionSms: true });
    } finally {
      spy.mockRestore();
    }
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('draft');
    expect(await addonsAlert(f)).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  // An add-ons bill another writer saved earlier than the settled base, so
  // the completion reaches it through the mint's in-lock adoption.
  async function olderAddonsSibling(f, lines) {
    const id = randomUUID();
    const total = lines.reduce((sum, li) => sum + li.amount, 0);
    await trx('invoices').insert({ id, customer_id: f.customerId, scheduled_service_id: f.serviceId,
      invoice_number: `TEST-${id.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
      total, subtotal: total, line_items: JSON.stringify(lines), created_at: new Date(Date.now() - 2 * 86400000) });
    return id;
  }

  test('an office invoice that bills only some of the add-ons stays owed with its pay link, and the office reconciles the rest (GitHub r1 P1)', async () => {
    const f = await coveredVisit({ secondAddon: true, invoiceLines: (x) => [addonLine(x)] });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
    expect(out.body?.invoiceId).toBe(f.invoiceId);
    expect(out.body?.invoicePaymentActionRequired).toBe(true);
    expect(await addonsAlert(f)).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  test('an office invoice that bills the add-on at a stale price is not taken as the whole remainder (GitHub r1 P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [{ ...addonLine(x), amount: 35, unit_price: 35 }] });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
    expect(await addonsAlert(f)).toBeTruthy();
  });

  test('an adopted add-ons bill that is the whole remainder is delivered with its pay link (GitHub r1 P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'prepaid' });
    const siblingId = await olderAddonsSibling(f, [addonLine(f)]);
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect(out.body?.invoiceId).toBe(siblingId);
    expect(out.body?.completionSmsType).toMatch(/with_invoice$/);
    expect(await addonsAlert(f)).toBeUndefined();
    // Back-linked to this completion record like every adoption path, so
    // its payment reads as the visit's completion invoice (GitHub r4 P1).
    expect((await trx('invoices').where({ id: siblingId }).first('service_record_id')).service_record_id).toBe(out.body.serviceRecordId);
    expect((await liveInvoices(f)).map((i) => i.id).sort()).toEqual([f.invoiceId, siblingId].sort());
  });

  test('an adopted add-ons bill that covers only some of the add-ons is not taken as this bill — the office reconciles (GitHub r1 P1)', async () => {
    const f = await coveredVisit({ secondAddon: true, invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'prepaid' });
    const siblingId = await olderAddonsSibling(f, [addonLine(f)]);
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect(await addonsAlert(f)).toBeTruthy();
    expect((await liveInvoices(f)).map((i) => i.id).sort()).toEqual([f.invoiceId, siblingId].sort());
  });

  test('an adopted invoice that bills the covered base beside the exact add-ons is never taken as this bill — no second charge for the base (pre-push P0)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'prepaid' });
    const mixedId = await olderAddonsSibling(f, [baseLine(f), addonLine(f)]);
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect(out.body?.invoiceId).not.toBe(mixedId);
    expect(out.body?.invoicePaymentActionRequired).not.toBe(true);
    expect(out.body?.completionSmsType || '').not.toMatch(/with_invoice$/);
    expect(await addonsAlert(f)).toBeTruthy();
  });

  test('a retry that finds the add-ons bill already paid still owes the voided invoice\'s other charges — never "all paid" (pre-push P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x),
      { description: 'Synthetic trip charge', amount: 15, quantity: 1, unit_price: 15 }] });
    const idempotencyKey = randomUUID();
    expect(await complete(f, { sendCompletionSms: true }, { idempotencyKey })).toMatchObject({ status: 200 });
    const [bill] = await liveInvoices(f);
    expect(Number(bill.total)).toBe(ADDON);
    // The customer pays the add-ons bill; the closeout's side effects resume.
    await trx('invoices').where({ id: bill.id }).update({ status: 'paid', paid_at: new Date() });
    await releaseForResume(f);
    const retry = await complete(f, { sendCompletionSms: true }, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(PAID_TEXTS).not.toContain(retry.body?.completionSmsType);
  });

  test('an office invoice already paid for only one of two add-ons stays paid, and the office is told about the other — never "all paid" (pre-push P1)', async () => {
    const f = await coveredVisit({ secondAddon: true, invoiceLines: (x) => [addonLine(x)], invoiceStatus: 'paid' });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('paid');
    expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
    expect(await addonsAlert(f)).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  test('an office invoice already paid for exactly the add-ons needs nothing more', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [addonLine(x)], invoiceStatus: 'paid' });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
    expect(await addonsAlert(f)).toBeUndefined();
  });

  test('a later pass that hits a different reason refreshes the office alert instead of leaving the first one standing (pre-push P1)', async () => {
    const f = await coveredVisit();
    const ScheduledInvoiceMint = require('../services/scheduled-invoice-mint');
    const mint = jest.spyOn(ScheduledInvoiceMint, 'mintScheduledServiceInvoiceWithDeposit').mockRejectedValue(new Error('synthetic mint outage'));
    const idempotencyKey = randomUUID();
    try {
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    } finally {
      mint.mockRestore();
    }
    expect((await addonsAlert(f)).body).toMatch(/could not be created/);
    // The visit gains a visit-wide discount; the closeout's side effects resume.
    await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE + ADDON - 9,
      discount_dollars: 9, discount_name: 'Synthetic visit discount', discount_type: 'fixed_amount', discount_amount: 9 });
    await releaseForResume(f);
    expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    const alerts = await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_addons_unbilled:${f.serviceId}`]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toMatch(/visit-wide discount/);
    expect(alerts[0].read_at).toBeNull();
  });

  test('a covered visit with a refunded invoice alerts the office to bill the add-ons once the refund is final (GitHub r1 P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)], invoiceStatus: 'refunded' });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ customer_id: f.customerId })).map((i) => i.id)).toEqual([f.invoiceId]);
    expect(await addonsAlert(f)).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  test('a voided office invoice\'s other charges are owed: the text does not say "all paid" even with no add-ons to bill (GitHub r1 P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), { description: 'Synthetic trip charge', amount: 15, quantity: 1, unit_price: 15 }] });
    await trx('scheduled_service_addons').where({ id: f.addonId }).del();
    await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
    expect(await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).first()).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  test('an invoice-issued closeout whose invoice was voided since never gets a replacement add-ons bill', async () => {
    const f = await coveredVisit({ daysAgo: 3, invoiceStatus: 'sent', invoiceLines: (x) => [baseLine(x), addonLine(x)] });
    const idempotencyKey = `invoice-issued:${f.invoiceId}`;
    const issuedCloseout = () => {
      const { completeScheduledService } = require('../services/complete-scheduled-service');
      return completeScheduledService({ serviceId: f.serviceId, idempotencyKey,
        body: { visitOutcome: 'completed', backfill: true, sendCompletionSms: false, requestReview: false, invoiceAlreadySent: true, idempotencyKey },
        actor: { techRole: 'admin', technicianId: f.techId, technician: null }, issuedInvoiceCloseout: { invoiceId: f.invoiceId, trigger: 'sent' } });
    };
    expect(await issuedCloseout()).toMatchObject({ status: 200 });
    // The office voids the issued invoice after the closeout committed; the
    // closeout's side effects then resume.
    await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
    await releaseForResume(f);
    expect(await issuedCloseout()).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
  });

  test('a retry resumes a gate-on attempt\'s add-ons bill even after the gate is turned off — never voided (GitHub r2 P1)', async () => {
    const f = await coveredVisit();
    const idempotencyKey = randomUUID();
    expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    const [bill] = await liveInvoices(f);
    expect(Number(bill.total)).toBe(ADDON);
    // A later step handed the attempt back for a retry; the kill switch is
    // flipped before it runs.
    await releaseForResume(f);
    delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING;
    let retry;
    try {
      retry = await complete(f, {}, { idempotencyKey });
    } finally {
      process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'true';
    }
    expect(retry).toMatchObject({ status: 200 });
    expect((await trx('invoices').where({ id: bill.id }).first('status')).status).not.toBe('void');
    expect(retry.body?.invoiceId).toBe(bill.id);
  });

  test('a retry that cannot re-read the invoice it voided holds the closeout instead of losing its other charges (GitHub r2 P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x),
      { description: 'Synthetic trip charge', amount: 15, quantity: 1, unit_price: 15 }] });
    const idempotencyKey = randomUUID();
    expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    // The crash: the void committed; no alert, no add-ons bill yet.
    await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).del();
    await trx('invoices').where({ customer_id: f.customerId }).whereNot({ id: f.invoiceId }).del();
    await releaseForResume(f);
    // The retry's re-read of the voided invoice fails once.
    const dbMock = require('../models/db');
    const real = dbMock.connection;
    dbMock.connection = new Proxy(real, {
      apply(target, thisArg, args) {
        if (args[0] === 'invoices' && /reconcileNoInvoice/.test(new Error().stack)) throw new Error('synthetic invoice read failure');
        return Reflect.apply(target, thisArg, args);
      },
    });
    let held;
    try {
      held = await complete(f, {}, { idempotencyKey });
    } finally {
      dbMock.connection = real;
    }
    expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
    expect(await liveInvoices(f)).toHaveLength(0);
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).first()).toBeTruthy();
    expect(Number((await liveInvoices(f))[0].total)).toBe(ADDON);
  });

  test('a recorded void that never landed is not trusted by a later pass — no "we voided it" alert, the add-ons billed plainly (pre-push P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x),
      { description: 'Synthetic trip charge', amount: 15, quantity: 1, unit_price: 15 }] });
    const InvoiceService = require('../services/invoice');
    const voidSpy = jest.spyOn(InvoiceService, 'voidInvoice').mockRejectedValue(new Error('Invoice status changed while voiding — re-check and retry'));
    const idempotencyKey = randomUUID();
    try {
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    } finally {
      voidSpy.mockRestore();
    }
    // The marker was saved, the void never landed; the office then cancels the invoice itself.
    await trx('invoices').where({ id: f.invoiceId }).update({ status: 'cancelled' });
    await releaseForResume(f);
    expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
    expect(await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_invoice_reconcile:${f.serviceId}`]).first()).toBeUndefined();
    const bills = (await liveInvoices(f)).filter((i) => i.id !== f.invoiceId);
    expect(bills.map((i) => Number(i.total))).toEqual([ADDON]);
  });

  test('handed a void invoice, the covered-visit decision treats it as none and bills the add-ons (pre-push P1)', async () => {
    // The completion's lookups never pass a void row; the module is driven
    // directly so its dispatch stays total.
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)], invoiceStatus: 'void' });
    const { reconcileCoveredVisitInvoice } = require('../services/annual-prepay-addon-billing');
    const svc = await trx('scheduled_services').where({ id: f.serviceId }).first();
    const [record] = await trx('service_records').insert({ id: randomUUID(), customer_id: f.customerId,
      scheduled_service_id: f.serviceId, technician_id: f.techId, service_type: svc.service_type, service_date: svc.scheduled_date,
      status: 'completed' }).returning('*');
    const outcome = await reconcileCoveredVisitInvoice({
      svc, record, invoice: await trx('invoices').where({ id: f.invoiceId }).first(), payUrl: null, alreadyPaid: false, invoiceCreated: false,
      issuedInvoiceCloseout: null, recapReviewOnly: false, visitPerformed: true, terminalCompletionInvoice: null, packetEffects: null,
      quietBackfill: false, serviceDate: String(svc.scheduled_date instanceof Date ? svc.scheduled_date.toISOString() : svc.scheduled_date).slice(0, 10),
      portalUrl: 'https://portal.example.invalid', mergeRecordNotesKeys: async () => {},
    });
    expect(outcome.hold).toBeNull();
    expect(outcome.invoice.id).not.toBe(f.invoiceId);
    expect(Number(outcome.invoice.total)).toBe(ADDON);
    expect(outcome.extrasCollectible).toBe(true);
  });

  test('an estimate deposit covering the whole add-ons bill settles it — no $0 pay link or collection prompt (GitHub r3 P1)', async () => {
    const f = await coveredVisit({ depositDollars: 60 });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    const [bill] = await liveInvoices(f);
    expect(Number(bill.total)).toBe(0);
    expect(bill.status).toBe('prepaid');
    expect(out.body?.invoicePaymentActionRequired).not.toBe(true);
    expect(out.body?.completionSmsType || '').not.toMatch(/with_invoice$/);
  });

  test('a gate freeze that cannot be saved holds the closeout before any billing (GitHub r3 P1)', async () => {
    const f = await coveredVisit();
    const idempotencyKey = randomUUID();
    const dbMock = require('../models/db');
    const real = dbMock.connection;
    dbMock.connection = new Proxy(real, {
      apply(target, thisArg, args) {
        if (args[0] === 'service_records' && /resolveGate/.test(new Error().stack)) throw new Error('synthetic freeze write failure');
        return Reflect.apply(target, thisArg, args);
      },
    });
    let held;
    try {
      held = await complete(f, {}, { idempotencyKey });
    } finally {
      dbMock.connection = real;
    }
    expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
    expect(await liveInvoices(f)).toHaveLength(0);
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(Number((await liveInvoices(f))[0].total)).toBe(ADDON);
  });

  test('a quiet backfill mints the add-ons bill off any payer statement (skipAccrual), like the main backfill invoice (GitHub r3 P1)', async () => {
    const f = await coveredVisit({ daysAgo: 3 });
    const InvoiceService = require('../services/invoice');
    const create = jest.spyOn(InvoiceService, 'create');
    let calls;
    try {
      expect(await complete(f, { backfill: true, timeOnSite: 45 })).toMatchObject({ status: 200 });
      calls = create.mock.calls.map(([args]) => args);
    } finally {
      create.mockRestore();
    }
    const addonsCreate = calls.find((args) => String(args?.notes || '').startsWith('Add-ons beyond'));
    expect(addonsCreate).toMatchObject({ skipAccrual: true });
  });

  test('an add-on still awaiting its price is flagged to the office, never read as free — the priced one still bills (GitHub r3 P1)', async () => {
    const f = await coveredVisit({ secondAddon: true });
    await trx('scheduled_service_addons').where({ id: f.addon2Id }).update({ base_price: null, estimated_price: null });
    await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE + ADDON });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect((await liveInvoices(f)).map((i) => Number(i.total))).toEqual([ADDON]);
    expect(await addonsAlert(f)).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  test('a covered visit whose only add-on awaits its price bills nothing and alerts the office', async () => {
    const f = await coveredVisit();
    await trx('scheduled_service_addons').where({ id: f.addonId }).update({ base_price: null, estimated_price: null });
    await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
    expect(await addonsAlert(f)).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  test('a failed add-on read on the billing path holds the closeout for the retry instead of a permanent office alert (pre-push P1)', async () => {
    const f = await coveredVisit();
    const idempotencyKey = randomUUID();
    const dbMock = require('../models/db');
    const real = dbMock.connection;
    dbMock.connection = new Proxy(real, {
      apply(target, thisArg, args) {
        if (args[0] === 'scheduled_service_addons' && /currentExtras/.test(new Error().stack)) throw new Error('synthetic add-on read failure');
        return Reflect.apply(target, thisArg, args);
      },
    });
    let held;
    try {
      held = await complete(f, {}, { idempotencyKey });
    } finally {
      dbMock.connection = real;
    }
    expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
    expect(await addonsAlert(f)).toBeUndefined();
    const retry = await complete(f, {}, { idempotencyKey });
    expect(retry).toMatchObject({ status: 200 });
    expect(Number((await liveInvoices(f))[0].total)).toBe(ADDON);
    expect(await addonsAlert(f)).toBeUndefined();
  });

  test('a paid office invoice that billed the covered base and every add-on flags only the base overpayment — never a second bill for the add-ons (GitHub r4 P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)], invoiceStatus: 'paid' });
    const out = await complete(f);
    expect(out).toMatchObject({ status: 200 });
    expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
    expect(await addonsAlert(f)).toBeUndefined();
    expect(await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_covered_base_paid:${f.serviceId}`]).first()).toBeTruthy();
  });

  test('a base-only invoice whose payment is in flight leaves the add-ons with the office, not unbilled and unflagged (GitHub r4 P1)', async () => {
    const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'processing' });
    const out = await complete(f, { sendCompletionSms: true });
    expect(out).toMatchObject({ status: 200 });
    expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
    expect(await addonsAlert(f)).toBeTruthy();
    expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
  });

  describe('dark (GATE_ANNUAL_PREPAY_ADDON_BILLING off): today\'s behavior', () => {
    beforeEach(() => { delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING; });
    afterEach(() => { process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'true'; });

    test('a covered visit with a priced add-on and no invoice bills nothing and alerts no one', async () => {
      const f = await coveredVisit();
      const out = await complete(f);
      expect(out).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeUndefined();
    });

    test('an office invoice mixing the covered base with the add-on is voided and nothing is re-billed or saved for a retry', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
      const out = await complete(f);
      expect(out).toMatchObject({ status: 200 });
      expect((await trx('invoices').where({ id: f.invoiceId }).first('status')).status).toBe('void');
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeUndefined();
      const record = await trx('service_records').where({ id: out.body.serviceRecordId }).first('structured_notes');
      const notes = typeof record.structured_notes === 'string' ? JSON.parse(record.structured_notes) : record.structured_notes;
      expect(notes?.annualPrepayVoidedInvoiceId).toBeUndefined();
    });
  });

  test('a visit that performed no application bills no add-ons', async () => {
    const f = await coveredVisit();
    const out = await complete(f, { visitOutcome: 'inspection_only' });
    expect(out).toMatchObject({ status: 200 });
    expect(await liveInvoices(f)).toHaveLength(0);
  });
});
