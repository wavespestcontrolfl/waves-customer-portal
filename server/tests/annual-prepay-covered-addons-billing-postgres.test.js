// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// ADMIN-BUG-R13 (owner ruling 2026-09-26: auto-bill; an office alert when the
// amount is unclear): completing an annual-prepay-covered visit that carries
// a priced add-on billed nothing, said "all paid", and alerted no one. Now a
// visit with no invoice history gets its add-ons billed alone through the
// shared scheduled-invoice mint (the covered base never is), and a visit that
// already has any other invoice — or an unclear amount — gets one office
// alert naming it; the completion text never says "all paid" over either.
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
    const spy = jest.spyOn(NotificationService, 'notifyAdmin').mockImplementation(async (...args) => (
      matches(String(args[3]?.dedupeKey || '')) ? null : realNotify(...args)));
    return () => spy.mockRestore();
  }
  // One query fails — a Proxy over the test transaction, matched on the table
  // and on a closeout method's name in the stack (Jest's source maps print
  // it as "[as <method>]"); every other query runs as usual.
  function failQuery(table, frame) {
    const dbMock = require('../models/db');
    const real = dbMock.connection;
    dbMock.connection = new Proxy(real, {
      apply(target, thisArg, args) {
        if (args[0] === table && frame.test(new Error().stack)) throw new Error(`synthetic ${table} failure`);
        return Reflect.apply(target, thisArg, args);
      },
    });
    return () => { dbMock.connection = real; };
  }
  async function withFailure(restore, fn) {
    try {
      return await fn();
    } finally {
      restore();
    }
  }
  // Wrap the shared mint: `before` runs ahead of the real mint's first call.
  function aroundMint(before) {
    const ScheduledInvoiceMint = require('../services/scheduled-invoice-mint');
    const realMint = ScheduledInvoiceMint.mintScheduledServiceInvoiceWithDeposit;
    let first = true;
    const spy = jest.spyOn(ScheduledInvoiceMint, 'mintScheduledServiceInvoiceWithDeposit').mockImplementation(async (args) => {
      if (first) {
        first = false;
        await before();
      }
      return realMint(args);
    });
    return () => spy.mockRestore();
  }
  const PAID_TEXTS = ['service_complete_annual_prepay', 'service_complete_prepaid', 'service_complete_paid_receipt'];
  const attemptStatus = async (f) => (await trx('service_completion_attempts').where({ service_id: f.serviceId }).first('status'))?.status;
  const addonsAlert = (f) => trx('notifications').where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_addons_unbilled:${f.serviceId}`]).first();

  const recordNotes = async (serviceRecordId) => {
    const row = await trx('service_records').where({ id: serviceRecordId }).first('structured_notes');
    return (typeof row.structured_notes === 'string' ? JSON.parse(row.structured_notes) : row.structured_notes) || {};
  };
  const tripCharge = { description: 'Synthetic trip charge', amount: 15, quantity: 1, unit_price: 15 };
  const settledCovered = async (f) => (await trx('invoices').where({ id: f.invoiceId }).first('status')).status;

  describe('no invoice history: the add-ons are billed alone', () => {
    test('the add-ons are billed alone, the covered base is not, and the bill is recorded as this closeout\'s own', async () => {
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
      expect(out.body?.invoicePaymentActionRequired).toBe(true);
      expect((await recordNotes(out.body.serviceRecordId)).annualPrepayAddonsInvoiceId).toBe(bill.id);
      expect(await addonsAlert(f)).toBeUndefined();
    });

    test('a visit-wide discount makes the add-ons\' share unclear — the office is alerted, nothing is guessed, and the text does not say "all paid"', async () => {
      const f = await coveredVisit({ discountDollars: 9, secondAddon: true });
      // One add-on still awaits its price: the alert names both reasons.
      await trx('scheduled_service_addons').where({ id: f.addon2Id }).update({ base_price: null, estimated_price: null });
      await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE + ADDON - 9 });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
      const { body } = await addonsAlert(f);
      expect(body).toMatch(/no price yet/);
      expect(body).toMatch(/visit-wide discount/);
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('priced add-ons that build no invoice lines alert the office instead of reading as "nothing owed"', async () => {
      const f = await coveredVisit();
      const InvoiceService = require('../services/invoice');
      const build = jest.spyOn(InvoiceService, 'buildLineItemsForScheduledService').mockResolvedValue({ lineItems: [], discountIds: [] });
      try {
        expect(await complete(f)).toMatchObject({ status: 200 });
      } finally {
        build.mockRestore();
      }
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('a covered visit without add-ons bills nothing', async () => {
      const f = await coveredVisit();
      await trx('scheduled_service_addons').where({ id: f.addonId }).del();
      await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE });
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeUndefined();
    });

    test('a visit that performed no application bills no add-ons', async () => {
      const f = await coveredVisit();
      expect(await complete(f, { visitOutcome: 'inspection_only' })).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
    });

    test('the estimate deposit rolls onto the add-ons bill', async () => {
      const f = await coveredVisit({ depositDollars: 10 });
      expect(await complete(f)).toMatchObject({ status: 200 });
      const [bill] = await liveInvoices(f);
      expect(Number(bill.total)).toBe(ADDON - 10);
      expect(linesOf(bill).some((li) => li.category === 'deposit_credit')).toBe(true);
    });

    test('a deposit covering the whole add-ons bill settles it — no $0 pay link or collection prompt', async () => {
      const f = await coveredVisit({ depositDollars: 60 });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      const [bill] = await liveInvoices(f);
      expect(Number(bill.total)).toBe(0);
      expect(bill.status).toBe('prepaid');
      expect(out.body?.invoicePaymentActionRequired).not.toBe(true);
      expect(out.body?.completionSmsType || '').not.toMatch(/with_invoice$/);
    });

    test('a quiet backfill bills the add-ons at face value, due today, off any payer statement, and leaves the deposit on its ledger', async () => {
      const f = await coveredVisit({ depositDollars: 10, daysAgo: 3 });
      const InvoiceService = require('../services/invoice');
      const create = jest.spyOn(InvoiceService, 'create');
      let calls;
      try {
        expect(await complete(f, { backfill: true, timeOnSite: 45 })).toMatchObject({ status: 200 });
        calls = create.mock.calls.map(([args]) => args);
      } finally {
        create.mockRestore();
      }
      const [bill] = await liveInvoices(f);
      expect(Number(bill.total)).toBe(ADDON);
      expect(linesOf(bill).some((li) => li.category === 'deposit_credit')).toBe(false);
      const { etDateString } = require('../utils/datetime-et');
      expect(String(bill.due_date instanceof Date ? bill.due_date.toISOString() : bill.due_date).slice(0, 10)).toBe(etDateString());
      expect(Number((await trx('estimate_deposits').where({ estimate_id: f.estimateId }).first()).credited_amount || 0)).toBe(0);
      expect(calls.find((args) => String(args?.notes || '').startsWith('Add-ons beyond'))).toMatchObject({ skipAccrual: true });
    });

    test('an add-on still awaiting its price is flagged to the office, never read as free — the priced one still bills', async () => {
      const f = await coveredVisit({ secondAddon: true });
      await trx('scheduled_service_addons').where({ id: f.addon2Id }).update({ base_price: null, estimated_price: null });
      await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE + ADDON });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect((await liveInvoices(f)).map((i) => Number(i.total))).toEqual([ADDON]);
      expect(await addonsAlert(f)).toBeTruthy();
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('a visit whose only add-on awaits its price bills nothing and alerts the office', async () => {
      const f = await coveredVisit();
      await trx('scheduled_service_addons').where({ id: f.addonId }).update({ base_price: null, estimated_price: null });
      await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeTruthy();
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('an add-on replaced at the same price while billing is caught under the mint lock — the bill names the current add-on (GitHub r5 P1)', async () => {
      const f = await coveredVisit();
      const replacementId = randomUUID();
      const restore = aroundMint(async () => {
        await trx('scheduled_service_addons').where({ id: f.addonId }).del();
        await trx('scheduled_service_addons').insert({ id: replacementId, scheduled_service_id: f.serviceId,
          service_name: 'Fire ant mound treatment', estimated_price: ADDON, base_price: ADDON });
      });
      const out = await withFailure(restore, () => complete(f));
      expect(out).toMatchObject({ status: 200 });
      const [bill] = await liveInvoices(f);
      expect(linesOf(bill).map((li) => li.client_id)).toEqual([`scheduled_${f.serviceId}_addon_${replacementId}`]);
    });

    test('an invoice that appears on the visit while billing is never taken as this bill — the office decides', async () => {
      const f = await coveredVisit();
      const appearedId = randomUUID();
      const restore = aroundMint(() => trx('invoices').insert({ id: appearedId, customer_id: f.customerId, scheduled_service_id: f.serviceId,
        invoice_number: `TEST-${appearedId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
        total: ADDON, subtotal: ADDON, line_items: JSON.stringify([addonLine(f)]) }));
      const out = await withFailure(restore, () => complete(f));
      expect(out).toMatchObject({ status: 200 });
      expect((await liveInvoices(f)).map((i) => i.id)).toEqual([appearedId]);
      expect(out.body?.invoiceId).not.toBe(appearedId);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('a later pass that hits a different reason refreshes the office alert instead of leaving the first one standing', async () => {
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
  });

  describe('retries and holds', () => {
    test('a resumed completion takes back its own add-ons bill — collected, never a second one', async () => {
      const f = await coveredVisit();
      const idempotencyKey = randomUUID();
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      const [bill] = await liveInvoices(f);
      await releaseForResume(f);
      const retry = await complete(f, {}, { idempotencyKey });
      expect(retry).toMatchObject({ status: 200 });
      expect(retry.body?.invoiceId).toBe(bill.id);
      expect(retry.body?.invoicePaymentActionRequired).toBe(true);
      expect((await liveInvoices(f)).map((i) => i.id)).toEqual([bill.id]);
      expect(await addonsAlert(f)).toBeUndefined();
    });

    test('a retry resumes a gate-on attempt\'s own bill even after the gate is turned off — never voided', async () => {
      const f = await coveredVisit();
      const idempotencyKey = randomUUID();
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      const [bill] = await liveInvoices(f);
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

    test('a bill minted but not recorded on the record is never billed twice — the retry leaves it to the office', async () => {
      const f = await coveredVisit();
      const idempotencyKey = randomUUID();
      const first = await withFailure(failQuery('service_records', /\bmint\b/), () => complete(f, {}, { idempotencyKey }));
      expect(first).toMatchObject({ status: 200 });
      const [bill] = await liveInvoices(f);
      await releaseForResume(f);
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      expect((await liveInvoices(f)).map((i) => i.id)).toEqual([bill.id]);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('a gate freeze that cannot be saved holds the closeout before any billing', async () => {
      const f = await coveredVisit();
      const idempotencyKey = randomUUID();
      const held = await withFailure(failQuery('service_records', /resolveGate/), () => complete(f, {}, { idempotencyKey }));
      expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      expect(Number((await liveInvoices(f))[0].total)).toBe(ADDON);
    });

    test('a failed add-on read on the billing path holds the closeout for the retry — never a permanent office alert', async () => {
      const f = await coveredVisit();
      const idempotencyKey = randomUUID();
      const held = await withFailure(failQuery('scheduled_service_addons', /billableExtras/), () => complete(f, {}, { idempotencyKey }));
      expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
      expect(await attemptStatus(f)).toBe('side_effects_pending');
      expect(await addonsAlert(f)).toBeUndefined();
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      expect(Number((await liveInvoices(f))[0].total)).toBe(ADDON);
    });

    test('an unreadable invoice history holds the closeout rather than billing blind', async () => {
      const f = await coveredVisit();
      const idempotencyKey = randomUUID();
      const held = await withFailure(failQuery('invoices', /otherInvoices/), () => complete(f, {}, { idempotencyKey }));
      expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      expect(Number((await liveInvoices(f))[0].total)).toBe(ADDON);
    });

    test('an office alert that is not recorded leaves the closeout unfinalized, and the retry raises it', async () => {
      const f = await coveredVisit({ discountDollars: 9 });
      const idempotencyKey = randomUUID();
      const held = await withFailure(failAlerts((key) => key === `annual_prepay_addons_unbilled:${f.serviceId}`), () => complete(f, {}, { idempotencyKey }));
      expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_alert_failed' } });
      expect(await attemptStatus(f)).toBe('side_effects_pending');
      expect(await addonsAlert(f)).toBeUndefined();
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      expect(await addonsAlert(f)).toBeTruthy();
      expect(await liveInvoices(f)).toHaveLength(0);
    });
  });

  describe('an invoice already on the visit: the office decides what is still owed', () => {
    test('an office invoice mixing the covered base with the add-on is voided and the office re-bills — nothing billed at a guess', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('void');
      expect(await liveInvoices(f)).toHaveLength(0);
      expect((await addonsAlert(f)).body).toMatch(/voided/);
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('an office invoice that discounted the add-on its own way is voided, and the office re-bills it', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x), officeAddonDiscount(x)] });
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('void');
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('a base-only office invoice settles as covered, and the add-ons it never carried go to the office', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)] });
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('prepaid');
      expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('an office invoice billing only the add-ons stays owed with its pay link, and the office checks it covers them all', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [addonLine(x)] });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
      expect(out.body?.invoiceId).toBe(f.invoiceId);
      expect(out.body?.invoicePaymentActionRequired).toBe(true);
      expect(await addonsAlert(f)).toBeTruthy();
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('an office invoice that is not provably add-ons-only is voided, and the office re-bills what it charged', async () => {
      const f = await coveredVisit({ invoiceLines: () => [{ description: 'Quarterly pest treatment', amount: BASE, quantity: 1, unit_price: BASE }] });
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('void');
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('a voided office invoice\'s other charges are the office\'s to re-bill — never "all paid" even with no add-ons', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), tripCharge] });
      await trx('scheduled_service_addons').where({ id: f.addonId }).del();
      await trx('scheduled_services').where({ id: f.serviceId }).update({ estimated_price: BASE });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('void');
      expect((await addonsAlert(f)).body).toMatch(/anything else it charged/);
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('an office invoice already paid is kept, and the office bills whatever of the add-ons it did not charge', async () => {
      for (const lines of [(x) => [addonLine(x)], (x) => [baseLine(x), addonLine(x)]]) {
        const f = await coveredVisit({ invoiceLines: lines, invoiceStatus: 'paid' });
        const out = await complete(f);
        expect(out).toMatchObject({ status: 200 });
        expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
        expect(await settledCovered(f)).toBe('paid');
        expect((await addonsAlert(f)).body).toMatch(/does not already charge/);
      }
    });

    test('a covered base already settled — a retry after the base settled or an office settlement — leaves the add-ons to the office, never billed beside it', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'prepaid' });
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('a base-only invoice whose payment is in flight leaves the add-ons with the office', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)], invoiceStatus: 'processing' });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect((await liveInvoices(f)).map((i) => i.id)).toEqual([f.invoiceId]);
      expect(await addonsAlert(f)).toBeTruthy();
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('a covered visit with a refunded invoice alerts the office to bill the add-ons once the refund is final', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)], invoiceStatus: 'refunded' });
      const out = await complete(f, { sendCompletionSms: true });
      expect(out).toMatchObject({ status: 200 });
      expect((await trx('invoices').where({ customer_id: f.customerId })).map((i) => i.id)).toEqual([f.invoiceId]);
      expect(await addonsAlert(f)).toBeTruthy();
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('a retry after a crash past the void finds the voided invoice and leaves the add-ons to the office — never re-billed at list', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x), officeAddonDiscount(x)] });
      const idempotencyKey = randomUUID();
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      // The crash: the void committed, the alert never landed.
      await trx('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`annual_prepay_addons_unbilled:${f.serviceId}`]).del();
      await releaseForResume(f);
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeTruthy();
    });

    test('a void that throws after it committed counts as voided — the office re-bills', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
      const InvoiceService = require('../services/invoice');
      const realVoid = InvoiceService.voidInvoice.bind(InvoiceService);
      const spy = jest.spyOn(InvoiceService, 'voidInvoice').mockImplementation(async (id) => {
        await realVoid(id);
        throw new Error('voided, but its annual-prepay/setup restorations failed');
      });
      const out = await withFailure(() => spy.mockRestore(), () => complete(f));
      expect(out).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('void');
      expect(await liveInvoices(f)).toHaveLength(0);
      expect((await addonsAlert(f)).body).toMatch(/voided/);
    });

    test('an office invoice that cannot be voided stays for normal handling, the office is alerted, and the text does not say "all paid"', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
      const InvoiceService = require('../services/invoice');
      const spy = jest.spyOn(InvoiceService, 'voidInvoice').mockRejectedValue(new Error('Invoice status changed while voiding — re-check and retry'));
      const out = await withFailure(() => spy.mockRestore(), () => complete(f, { sendCompletionSms: true }));
      expect(out).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('draft');
      expect(await addonsAlert(f)).toBeTruthy();
      expect(PAID_TEXTS).not.toContain(out.body?.completionSmsType);
    });

    test('an add-on read that fails while checking an existing invoice holds the closeout with the invoice untouched', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [addonLine(x)] });
      const idempotencyKey = randomUUID();
      const held = await withFailure(failQuery('scheduled_service_addons', /reconcileWithOfficeInvoices/), () => complete(f, {}, { idempotencyKey }));
      expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_lookup_failed' } });
      expect(await settledCovered(f)).toBe('draft');
      const retry = await complete(f, {}, { idempotencyKey });
      expect(retry).toMatchObject({ status: 200 });
      expect(retry.body?.invoiceId).toBe(f.invoiceId);
    });

    test('an office alert that is not recorded after a void holds the closeout; the retry raises it and still bills nothing', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x), tripCharge] });
      const idempotencyKey = randomUUID();
      const held = await withFailure(failAlerts((key) => key === `annual_prepay_addons_unbilled:${f.serviceId}`), () => complete(f, {}, { idempotencyKey }));
      expect(held).toMatchObject({ status: 503, body: { code: 'annual_prepay_addons_alert_failed' } });
      expect(await settledCovered(f)).toBe('void');
      expect(await complete(f, {}, { idempotencyKey })).toMatchObject({ status: 200 });
      expect(await addonsAlert(f)).toBeTruthy();
      expect(await liveInvoices(f)).toHaveLength(0);
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
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await releaseForResume(f);
      expect(await issuedCloseout()).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
    });
  });

  describe('dark (GATE_ANNUAL_PREPAY_ADDON_BILLING off): today\'s behavior', () => {
    beforeEach(() => { delete process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING; });
    afterEach(() => { process.env.GATE_ANNUAL_PREPAY_ADDON_BILLING = 'true'; });

    test('a covered visit with a priced add-on and no invoice bills nothing and alerts no one', async () => {
      const f = await coveredVisit();
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeUndefined();
    });

    test('an office invoice mixing the covered base with the add-on is voided, nothing re-billed or alerted, nothing frozen', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x), addonLine(x)] });
      const out = await complete(f);
      expect(out).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('void');
      expect(await liveInvoices(f)).toHaveLength(0);
      expect(await addonsAlert(f)).toBeUndefined();
      const notes = await recordNotes(out.body.serviceRecordId);
      expect(notes.annualPrepayAddonBilling).toBeUndefined();
    });

    test('a base-only office invoice settles as covered, as before', async () => {
      const f = await coveredVisit({ invoiceLines: (x) => [baseLine(x)] });
      expect(await complete(f)).toMatchObject({ status: 200 });
      expect(await settledCovered(f)).toBe('prepaid');
      expect(await addonsAlert(f)).toBeUndefined();
    });
  });
});
