/**
 * Multi-program recurring accept (B06 / B17) — ROUTE-LEVEL, real migrated
 * Postgres (real router, real EstimateConverter.convertEstimate).
 *
 * Bug this pins: a no-slot accept of MORE THAN ONE recurring service left
 * every auto-scheduled row (parents AND seeded follow-ups) unpriced.
 *   B06: an existing per-application customer adding a service completed the
 *        new service's visits at the customer's OLD single-plan fee.
 *   B17: a brand-new customer's whole schedule completed with no invoice and
 *        nobody was told.
 * Now every unit's follow-ups bill that unit's own quoted per-visit amount
 * (the accept route's per-service amounts); the parents stay unpriced on
 * purpose (the combined first-application invoice covers their first visit).
 * When the amounts cannot be matched to the units one-to-one, nothing is
 * priced by guess and the office is alerted (one bell per estimate).
 *
 * Bug this pins: PUT /api/estimates/:token/accept on an estimate with NO
 * customer_id mints the customer itself. That insert leaves pipeline_stage on
 * the column default ('active_customer') and writes monthly_rate = the quoted
 * monthly total, which is exactly what customerPreservesMonthlyMembership()
 * reads as "existing legacy monthly member". The converter therefore kept
 * billing_mode NULL and per_application_fee NULL for a brand-new customer:
 * the first-visit draft invoice was never charged at completion and no later
 * completion billed anything. A customer created BY the accept must convert
 * exactly like a pre-existing non-member (per_application + fee), while an
 * existing monthly member adding on and a one-time accept are unchanged.
 *
 * Run with SIBLING_RESPLIT_TEST_DATABASE_URL (+ DATABASE_URL, same value)
 * pointing to a disposable local, managed worktree QA, or isolated CI
 * database. Every fixture rolls back.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
jest.setTimeout(60000);
const { randomUUID } = require('crypto');

const testUrl = process.env.SIBLING_RESPLIT_TEST_DATABASE_URL;
const local = testUrl && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname)
  && new URL(testUrl).pathname.includes('sibling_resplit');
const managed = testUrl && process.env.WAVES_LOCAL_DEV === '1' && process.env.WAVES_WORKTREE_ID
  && testUrl === process.env.DATABASE_URL
  && new URL(testUrl).pathname === `/waves_qa_${process.env.WAVES_WORKTREE_ID.replaceAll('-', '')}`;
const ci = testUrl && process.env.CI === 'true' && testUrl === process.env.DATABASE_URL
  && ['localhost', '127.0.0.1'].includes(new URL(testUrl).hostname) && new URL(testUrl).pathname === '/waves_test';
if (testUrl && !local && !managed && !ci) {
  throw new Error('New-customer billing-mode accept tests require a dedicated local sibling_resplit, managed worktree QA, or isolated CI database.');
}
const suite = local || managed || ci ? describe : describe.skip;

let mockTransaction;
jest.mock('../models/db', () => {
  const database = (...args) => mockTransaction(...args);
  database.transaction = (...args) => mockTransaction.transaction(...args);
  database.raw = (...args) => mockTransaction.raw(...args);
  database.fn = { now: () => new Date() };
  // Several routes (this one included) probe db.schema (hasColumn/hasTable)
  // to decide whether a migration has landed — without mirroring it the
  // probe throws and the route silently falls back to legacy behavior.
  Object.defineProperty(database, 'schema', { get: () => mockTransaction.schema });
  return database;
});

// Side-effect modules only (SMS/email/Stripe-adjacent/short-url/logger/
// notifications) — EstimateConverter and InvoiceService run for REAL.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
  createShortCode: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  createTrackedShortLink: jest.fn(async (url) => ({ code: 'abc12', shortUrl: url })),
  resolveShortCode: jest.fn(async () => null),
  invoiceShortCodePrefix: jest.fn(() => 'inv'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 1 })),
  notifyCustomer: jest.fn(async () => ({})),
}));
jest.mock('../services/account-membership-email', () => ({
  sendMembershipStarted: jest.fn(async () => ({})),
}));
// NOT mocked: '../services/new-recurring-welcome-sms' — estimate-converter.js
// destructure-imports isNewRecurringSignupCandidate from it directly (a bare
// stub with only sendNewRecurringWelcome breaks that real call), and its own
// send path already routes through the mocked sendCustomerMessage below (it
// only ever QUEUES a DB row for the scheduler to deliver later — no network
// call happens inside the accept transaction either way).
jest.mock('../services/estimate-accepted-email', () => ({
  sendEstimateAcceptedOnboarding: jest.fn(async () => ({})),
}));
// Real tagger helpers (the follow-up seeder classifies each child through it);
// only the outbound scheduling hook is stubbed.
jest.mock('../services/appointment-tagger', () => {
  const tagger = jest.requireActual('../services/appointment-tagger');
  tagger.onServiceScheduled = jest.fn(async () => ({}));
  return tagger;
});
jest.mock('../services/lead-estimate-link', () => ({
  markLinkedLeadEstimateAccepted: jest.fn(async () => ({})),
  markLinkedLeadEstimateViewed: jest.fn(async () => ({})),
}));
jest.mock('../services/estimate-card-holds', () => ({
  resolveCardHoldPolicy: jest.fn(() => ({ required: false, enforced: false })),
  verifyCardHoldIntent: jest.fn(async () => ({ ok: false })),
  recordCardHoldHeld: jest.fn(async () => ({})),
  attachCardHoldPaymentMethod: jest.fn(async () => ({})),
  cardHoldNoShowFee: jest.fn(() => 49),
  cardHoldCancelWindowHours: jest.fn(() => 24),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({})),
}));
// NOT mocked: '../services/payer' — DB-only (no network side effects), and
// several real callers (services/invoice.js's InvoiceService.create among
// them) destructure its resolved object directly, so a bare `null` stub
// throws inside the real invoice mint this suite needs to run for real.

const express = require('express');
const knex = require('knex');

suite('multi-program no-slot accept — per-unit follow-up pricing + office alert (B06 / B17)', () => {
  let db;
  let server;
  let baseUrl;

  beforeAll(async () => {
    db = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 2 } });
    if (!await db.schema.hasTable('knex_migrations')) throw new Error('Run development migrations first');
    const router = require('../routes/estimate-public');
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', router);
    app.use((err, req, res, next) => {
      res.status(err.status || err.statusCode || 500).json({ error: err.message });
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(async () => {
    mockTransaction = await db.transaction();
    require('../services/notification-service').notifyAdmin.mockClear();
  });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  // Quarterly pest $45/visit + monthly mosquito $30/visit (synthetic).
  const PEST_PER_VISIT = 45;
  const MOSQUITO_PER_VISIT = 30;
  const pestLine = { name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 4, perTreatment: PEST_PER_VISIT };
  const mosquitoLine = {
    name: 'Mosquito Control', service: 'mosquito', frequency: 'monthly', mo: 30, visitsPerYear: 12, perTreatment: MOSQUITO_PER_VISIT,
  };
  const dataFor = (services) => ({
    customerSelection: { frequency: 'quarterly' },
    setupFeeQuote: { amount: 0, waived: true },
    result: {
      totals: { year2mo: 45, year2: 540 },
      results: { pestTiers: [{ label: 'Quarterly', mo: 15, ann: 180, apps: 4, pa: PEST_PER_VISIT }] },
      recurring: { discount: 0, monthlyTotal: 45, grandTotal: 45, services },
      oneTime: { items: [], membershipFee: 0 },
    },
  });
  const MULTI_DATA = dataFor([pestLine, mosquitoLine]);
  const PEST_ONLY_DATA = dataFor([pestLine]);

  async function estimateFixture(trx, { estimateData = MULTI_DATA, linkedCustomer = null, monthly = 45, annual = 540 } = {}) {
    const estimateId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    const tag = estimateId.slice(0, 8);
    const phone = `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`;
    if (linkedCustomer) await trx('customers').insert(linkedCustomer);
    await trx('estimates').insert({
      id: estimateId,
      customer_id: linkedCustomer ? linkedCustomer.id : null,
      status: 'sent',
      token,
      customer_name: 'Synthetic Multiunit',
      customer_phone: linkedCustomer ? linkedCustomer.phone : phone,
      customer_email: `qa-${tag}@example.com`,
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: monthly,
      annual_total: annual,
      onetime_total: 0,
      waveguard_tier: 'Bronze',
      show_one_time_option: false,
      bill_by_invoice: false,
      category: 'RESIDENTIAL',
      estimate_data: JSON.stringify(estimateData),
    });
    return { estimateId, token };
  }

  const putAccept = (token, body = {}) => fetch(`${baseUrl}/api/estimates/${token}/accept`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  function perAppCustomer(overrides = {}) {
    const id = randomUUID();
    return {
      id,
      first_name: 'Synthetic',
      last_name: 'Peraplane',
      phone: `qa-${id.slice(0, 8)}`,
      email: `qa-${id.slice(0, 8)}@example.com`,
      active: true,
      pipeline_stage: 'active_customer',
      billing_mode: 'per_application',
      per_application_fee: 120,
      ...overrides,
    };
  }

  async function customerForEstimate(estimateId) {
    const est = await mockTransaction('estimates').where({ id: estimateId }).first();
    expect(est.customer_id).toBeTruthy();
    return mockTransaction('customers').where({ id: est.customer_id }).first();
  }

  // Parents (series heads) and their follow-up children, per service family.
  async function seriesRows(estimateId) {
    const rows = await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId });
    const parents = rows.filter((r) => !r.recurring_parent_id);
    const bucket = (re) => {
      const parent = parents.find((p) => re.test(String(p.service_type)));
      return {
        parent,
        children: parent ? rows.filter((r) => String(r.recurring_parent_id) === String(parent.id)) : [],
      };
    };
    return { pest: bucket(/pest/i), mosquito: bucket(/mosquito/i), all: rows };
  }

  const unresolvedAlertCalls = (estimateId) => require('../services/notification-service').notifyAdmin.mock.calls
    .filter(([, , , options]) => options?.dedupeKey === `per-application-fee-unresolved:${estimateId}`);

  test('B17: a NEW customer accepting pest + mosquito with no slot gets every follow-up priced at its own quoted amount', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);
    const res = await putAccept(token);
    expect(res.status).toBe(200);

    const { pest, mosquito } = await seriesRows(estimateId);
    expect(pest.parent).toBeTruthy();
    expect(mosquito.parent).toBeTruthy();
    // Parents stay unpriced on purpose: the combined first-application
    // invoice covers each program's first visit (the stamp verifies NULL).
    expect(pest.parent.estimated_price == null).toBe(true);
    expect(mosquito.parent.estimated_price == null).toBe(true);
    expect(pest.children.length).toBeGreaterThan(0);
    expect(mosquito.children.length).toBeGreaterThan(0);
    for (const child of pest.children) expect(Number(child.estimated_price)).toBe(PEST_PER_VISIT);
    for (const child of mosquito.children) expect(Number(child.estimated_price)).toBe(MOSQUITO_PER_VISIT);
    // Renewal anchor: auto-extend keeps billing the quoted per-visit amount.
    expect(Number(pest.parent.recurring_template_overrides?.anchored_split_per_visit)).toBe(PEST_PER_VISIT);
    expect(Number(mosquito.parent.recurring_template_overrides?.anchored_split_per_visit)).toBe(MOSQUITO_PER_VISIT);
    // No customer-level fee is invented, and nothing needs the office.
    const customer = await customerForEstimate(estimateId);
    expect(customer.per_application_fee == null).toBe(true);
    expect(unresolvedAlertCalls(estimateId)).toHaveLength(0);
  });

  test('B06: an EXISTING per-application customer adding mosquito bills the quoted amount, never the old fee', async () => {
    const existing = perAppCustomer();
    const { estimateId, token } = await estimateFixture(mockTransaction, { linkedCustomer: existing });
    const res = await putAccept(token);
    expect(res.status).toBe(200);

    const { mosquito, pest } = await seriesRows(estimateId);
    expect(mosquito.children.length).toBeGreaterThan(0);
    const { completionInvoiceAmount } = require('../services/billing-lane');
    for (const child of mosquito.children) {
      expect(Number(child.estimated_price)).toBe(MOSQUITO_PER_VISIT);
      // What completion bills for that visit, with the customer's real fee.
      expect(completionInvoiceAmount({
        estimatedPrice: child.estimated_price, isCallback: false, perApplicationBilling: true,
        perApplicationFee: 120, monthlyRate: null, billingMode: 'per_application',
      })).toBe(MOSQUITO_PER_VISIT);
    }
    for (const child of pest.children) expect(Number(child.estimated_price)).toBe(PEST_PER_VISIT);
    // Customer-level fee semantics unchanged for existing callers.
    const customer = await customerForEstimate(estimateId);
    expect(Number(customer.per_application_fee)).toBe(120);
    expect(unresolvedAlertCalls(estimateId)).toHaveLength(0);
  });

  test('single-unit accept is unchanged: the one series carries the plan amount and no alert is raised', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction, {
      estimateData: PEST_ONLY_DATA, monthly: 15, annual: 180,
    });
    expect((await putAccept(token)).status).toBe(200);
    const { pest } = await seriesRows(estimateId);
    expect(Number(pest.parent.estimated_price)).toBe(PEST_PER_VISIT);
    for (const child of pest.children) expect(Number(child.estimated_price)).toBe(PEST_PER_VISIT);
    const customer = await customerForEstimate(estimateId);
    expect(Number(customer.per_application_fee)).toBe(PEST_PER_VISIT);
    expect(unresolvedAlertCalls(estimateId)).toHaveLength(0);
  });

  describe('converter: amounts that cannot be matched one-to-one price nothing and alert the office once', () => {
    const EstimateConverter = () => require('../services/estimate-converter');
    const convertOpts = {
      skipSetupInvoice: true, autoSendInvoice: false, skipMembershipEmail: true,
    };
    const rowAmounts = [
      { service: 'pest_control', name: 'Pest Control', amount: PEST_PER_VISIT },
      { service: 'mosquito', name: 'Mosquito Control', amount: MOSQUITO_PER_VISIT },
    ];

    async function acceptedFixture(customer = null) {
      const fx = await estimateFixture(mockTransaction, { linkedCustomer: customer });
      await mockTransaction('estimates').where({ id: fx.estimateId }).update({ status: 'accepted', accepted_at: new Date() });
      return fx;
    }

    test('B17: a new customer with no route amounts — rows stay unpriced and ONE bell is raised (fires inline, deduped per estimate)', async () => {
      const customer = perAppCustomer({ billing_mode: null, per_application_fee: null, pipeline_stage: 'lead' });
      const { estimateId } = await acceptedFixture(customer);
      await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction, ...convertOpts, createdCustomerId: customer.id,
      });
      const { pest, mosquito } = await seriesRows(estimateId);
      expect(pest.parent).toBeTruthy();
      expect(pest.children.length).toBeGreaterThan(0);
      expect(mosquito.children.length).toBeGreaterThan(0);
      for (const row of [pest.parent, mosquito.parent, ...pest.children, ...mosquito.children]) {
        expect(row.estimated_price == null).toBe(true);
      }
      const calls = unresolvedAlertCalls(estimateId);
      expect(calls).toHaveLength(1);
      const [type, title, body, options] = calls[0];
      expect(type).toBe('billing');
      expect(title.startsWith('Billing — ')).toBe(true);
      expect(`${title} ${body}`).toMatch(/no invoice|no per-application price/i);
      expect(options.bell).toBe(true);
      expect(options.link).toBe(`/admin/customers?customerId=${customer.id}`);
      // Canonical eight-part stamp (docs/admin-notifications.md).
      expect(options.metadata).toMatchObject({
        area: 'Billing', severity: 'needs-you', who: 'person',
        subject: { type: 'estimate', id: String(estimateId) }, doneWhen: 'per_application_price_set',
      });
      expect(options.metadata.scheduledServiceIds).toEqual(expect.arrayContaining([pest.parent.id, mosquito.parent.id]));
    });

    test('B06: an existing per-application customer with no route amounts — the office is told the old fee would bill; the fee is untouched', async () => {
      const customer = perAppCustomer();
      const { estimateId } = await acceptedFixture(customer);
      await EstimateConverter().convertEstimate(estimateId, { database: mockTransaction, ...convertOpts });
      const { mosquito } = await seriesRows(estimateId);
      expect(mosquito.children.length).toBeGreaterThan(0);
      for (const child of mosquito.children) expect(child.estimated_price == null).toBe(true);
      const calls = unresolvedAlertCalls(estimateId);
      expect(calls).toHaveLength(1);
      expect(`${calls[0][1]} ${calls[0][2]}`).toMatch(/existing/i);
      expect(`${calls[0][1]} ${calls[0][2]}`).toContain('$120.00');
    });

    test('deferred callers get the payload back (not fired) and the route-rows path prices every unit with NO alert', async () => {
      const customer = perAppCustomer();
      const withoutRows = await acceptedFixture(customer);
      const unresolved = await EstimateConverter().convertEstimate(withoutRows.estimateId, {
        database: mockTransaction, ...convertOpts, deferCommercialScheduleNotification: true,
      });
      expect(unresolved.perApplicationFeeNotification?.options?.dedupeKey)
        .toBe(`per-application-fee-unresolved:${withoutRows.estimateId}`);
      expect(unresolvedAlertCalls(withoutRows.estimateId)).toHaveLength(0);

      const other = perAppCustomer();
      const withRows = await acceptedFixture(other);
      const priced = await EstimateConverter().convertEstimate(withRows.estimateId, {
        database: mockTransaction, ...convertOpts, deferCommercialScheduleNotification: true,
        firstApplicationRowAmounts: rowAmounts,
      });
      expect(priced.perApplicationFeeNotification == null).toBe(true);
      const { mosquito } = await seriesRows(withRows.estimateId);
      expect(mosquito.children.length).toBeGreaterThan(0);
      for (const child of mosquito.children) expect(Number(child.estimated_price)).toBe(MOSQUITO_PER_VISIT);
    });

    test('rows that do not match the units one-to-one (an extra or a missing service) price NOTHING — no guess', async () => {
      const customer = perAppCustomer();
      const { estimateId } = await acceptedFixture(customer);
      await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction, ...convertOpts,
        firstApplicationRowAmounts: [...rowAmounts, { service: 'lawn_care', name: 'Lawn Care', amount: 60 }],
      });
      const { pest, mosquito } = await seriesRows(estimateId);
      expect(pest.children.length).toBeGreaterThan(0);
      expect(mosquito.children.length).toBeGreaterThan(0);
      for (const row of [...pest.children, ...mosquito.children]) expect(row.estimated_price == null).toBe(true);
      expect(unresolvedAlertCalls(estimateId)).toHaveLength(1);
    });
  });
});
