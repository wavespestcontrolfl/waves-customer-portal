/**
 * New-customer billing lane at public accept — ROUTE-LEVEL, real migrated
 * Postgres (real router, real EstimateConverter.convertEstimate).
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
  notifyAdmin: jest.fn(async () => ({})),
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
jest.mock('../services/appointment-tagger', () => ({
  onServiceScheduled: jest.fn(async () => ({})),
}));
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

suite('public accept — billing lane of the customer the accept creates', () => {
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

  beforeEach(async () => { mockTransaction = await db.transaction(); });
  afterEach(async () => { await mockTransaction?.rollback(); mockTransaction = null; });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db?.destroy();
    await require('../models/db').destroy?.();
  });

  // Quarterly pest: 4 visits/yr at $45 = $180/yr = $15/mo, so the
  // per-application fee the converter stamps is exactly $45.
  const PEST_PER_VISIT = 45;
  const RECURRING_DATA = {
    customerSelection: { frequency: 'quarterly' },
    // Frozen "no setup fee disclosed" quote: the accept bills only the first
    // application, keeping the fixture on the plain per-application path.
    setupFeeQuote: { amount: 0, waived: true },
    result: {
      totals: { year2mo: 15, year2: 180 },
      results: { pestTiers: [{ label: 'Quarterly', mo: 15, ann: 180, apps: 4, pa: PEST_PER_VISIT }] },
      recurring: {
        discount: 0,
        monthlyTotal: 15,
        grandTotal: 15,
        services: [{
          name: 'Pest Control', service: 'pest_control', mo: 15,
          visitsPerYear: 4, perTreatment: PEST_PER_VISIT,
        }],
      },
      oneTime: { items: [], membershipFee: 0 },
    },
  };
  // Structural one-time-only: no recurring line at all.
  const ONE_TIME_DATA = {
    result: {
      recurring: { discount: 0, services: [] },
      oneTime: { items: [{ name: 'Wasp Nest Removal', price: 85 }], membershipFee: 0 },
    },
  };

  // Estimate with NO customer_id (phone unmatched → the accept mints the
  // customer) unless `linkedCustomer` is given.
  async function estimateFixture(trx, { estimateData = RECURRING_DATA, linkedCustomer = null, monthly = 15, annual = 180, onetime = 0, phone: phoneOverride = null } = {}) {
    const estimateId = randomUUID();
    const token = randomUUID().replace(/-/g, '');
    const tag = estimateId.slice(0, 8);
    const phone = phoneOverride || `+1941555${String(parseInt(tag, 16)).slice(-4).padStart(4, '0')}`;
    if (linkedCustomer) await trx('customers').insert(linkedCustomer);
    await trx('estimates').insert({
      id: estimateId,
      customer_id: linkedCustomer ? linkedCustomer.id : null,
      status: 'sent',
      token,
      customer_name: 'Synthetic Newlane',
      customer_phone: linkedCustomer ? linkedCustomer.phone : phone,
      customer_email: `qa-${tag}@example.test`,
      address: '123 Synthetic Ave, Bradenton, FL 34205',
      monthly_total: monthly,
      annual_total: annual,
      onetime_total: onetime,
      waveguard_tier: 'Bronze',
      show_one_time_option: false,
      bill_by_invoice: false,
      category: 'RESIDENTIAL',
      estimate_data: JSON.stringify(estimateData),
    });
    return { estimateId, token, phone };
  }

  const putAccept = (token, body = {}) => fetch(`${baseUrl}/api/estimates/${token}/accept`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function customerForEstimate(estimateId) {
    const est = await mockTransaction('estimates').where({ id: estimateId }).first();
    expect(est.customer_id).toBeTruthy();
    return mockTransaction('customers').where({ id: est.customer_id }).first();
  }

  function existingCustomer(overrides = {}) {
    const id = randomUUID();
    return {
      id,
      first_name: 'Synthetic',
      last_name: 'Existinglane',
      phone: `qa-${id.slice(0, 8)}`,
      email: `qa-${id.slice(0, 8)}@example.test`,
      active: true,
      ...overrides,
    };
  }

  test('(a) a customer minted by the accept converts per_application with the per-application fee', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction);

    const res = await putAccept(token);
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    const customer = await customerForEstimate(estimateId);
    expect(customer.billing_mode).toBe('per_application');
    expect(Number(customer.per_application_fee)).toBe(PEST_PER_VISIT);
    expect(customer.pipeline_stage).toBe('active_customer');
    // The auto-scheduled first visit exists (the draft first-visit invoice's
    // completion charge reads the fee stamped above).
    const visits = await mockTransaction('scheduled_services').where({ source_estimate_id: estimateId });
    expect(visits.length).toBeGreaterThan(0);
  });

  test('(a) parity: the created customer lands on the SAME lane as a pre-existing non-member accepting the same quote', async () => {
    const created = await estimateFixture(mockTransaction);
    const nonMember = existingCustomer({ pipeline_stage: 'lead' });
    const existing = await estimateFixture(mockTransaction, { linkedCustomer: nonMember });

    expect((await putAccept(created.token)).status).toBe(200);
    expect((await putAccept(existing.token)).status).toBe(200);

    const a = await customerForEstimate(created.estimateId);
    const b = await customerForEstimate(existing.estimateId);
    expect(a.billing_mode).toBe('per_application');
    expect(a.billing_mode).toBe(b.billing_mode);
    expect(Number(a.per_application_fee)).toBe(Number(b.per_application_fee));
    expect(a.pipeline_stage).toBe(b.pipeline_stage);
    expect(Number(a.monthly_rate)).toBe(Number(b.monthly_rate));
  });

  test('(b) an EXISTING monthly member accepting an add-on keeps the monthly lane (billing_mode and fee untouched)', async () => {
    const member = existingCustomer({
      pipeline_stage: 'active_customer', monthly_rate: 60, waveguard_tier: 'Bronze',
    });
    const { estimateId, token } = await estimateFixture(mockTransaction, { linkedCustomer: member });

    const res = await putAccept(token);
    expect(res.status).toBe(200);

    const customer = await customerForEstimate(estimateId);
    expect(customer.billing_mode == null).toBe(true);
    expect(customer.per_application_fee == null).toBe(true);
  });

  test('(c) a one-time accept that creates the customer is unaffected (no per-application lane, no membership rate)', async () => {
    const { estimateId, token } = await estimateFixture(mockTransaction, {
      estimateData: ONE_TIME_DATA, monthly: 0, annual: 0, onetime: 85,
    });

    const res = await putAccept(token);
    expect(res.status).toBe(200);

    const customer = await customerForEstimate(estimateId);
    expect(customer.billing_mode == null).toBe(true);
    expect(customer.per_application_fee == null).toBe(true);
    expect(customer.monthly_rate == null).toBe(true);
    expect(customer.waveguard_tier).toBe('One-Time');
  });
  // ---------------------------------------------------------------------
  // Round 1 (#5311): identity-scoped exemption + parked minted customer.
  // ---------------------------------------------------------------------
  describe('converter: createdCustomerId is honored only for that same, still-unstamped row', () => {
    const EstimateConverter = () => require('../services/estimate-converter');
    const convertOpts = { skipSetupInvoice: true, skipAutoSchedule: true, autoSendInvoice: false, skipMembershipEmail: true };

    async function linkedFixture(customerOverrides) {
      const customer = existingCustomer({
        pipeline_stage: 'active_customer', monthly_rate: 15, waveguard_tier: 'Bronze', ...customerOverrides,
      });
      const fx = await estimateFixture(mockTransaction, { linkedCustomer: customer });
      // convertEstimate requires an accepted estimate (the route stamps this at accept).
      await mockTransaction('estimates').where({ id: fx.estimateId }).update({ status: 'accepted', accepted_at: new Date() });
      return { ...fx, customerId: customer.id };
    }
    const reread = (customerId) => mockTransaction('customers').where({ id: customerId }).first();

    test('same customer id + billing_mode NULL: converts like a non-member (per_application + fee)', async () => {
      const { estimateId, customerId } = await linkedFixture({});
      await EstimateConverter().convertEstimate(estimateId, { database: mockTransaction, ...convertOpts, createdCustomerId: customerId });
      const row = await reread(customerId);
      expect(row.billing_mode).toBe('per_application');
      expect(Number(row.per_application_fee)).toBe(PEST_PER_VISIT);
    });

    test('control: no option — the same row is read as an existing monthly member (predicate unchanged)', async () => {
      const { estimateId, customerId } = await linkedFixture({});
      await EstimateConverter().convertEstimate(estimateId, { database: mockTransaction, ...convertOpts });
      const row = await reread(customerId);
      expect(row.billing_mode == null).toBe(true);
      expect(row.per_application_fee == null).toBe(true);
    });

    test('a DIFFERENT customer id (minted profile merged/repointed to an existing member) is NOT honored', async () => {
      const { estimateId, customerId } = await linkedFixture({});
      await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction, ...convertOpts, createdCustomerId: randomUUID(),
      });
      const row = await reread(customerId);
      expect(row.billing_mode == null).toBe(true);
      expect(row.per_application_fee == null).toBe(true);
    });

    test('same id but billing_mode already stamped monthly_membership since the park is NOT honored and the lane is kept', async () => {
      const { estimateId, customerId } = await linkedFixture({ billing_mode: 'monthly_membership' });
      await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction, ...convertOpts, createdCustomerId: customerId,
      });
      const row = await reread(customerId);
      expect(row.billing_mode).toBe('monthly_membership');
      expect(row.per_application_fee == null).toBe(true);
    });

    test('a legacy boolean customerCreatedAtAccept opt is ignored (status-quo predicate)', async () => {
      const { estimateId, customerId } = await linkedFixture({});
      await EstimateConverter().convertEstimate(estimateId, {
        database: mockTransaction, ...convertOpts, customerCreatedAtAccept: true,
      });
      const row = await reread(customerId);
      expect(row.billing_mode == null).toBe(true);
    });

    test('prepay_annual call site: the same-id exemption is honored there too (per_application + fee, never the NULL monthly lane); a different id is not', async () => {
      const prepayOpts = {
        ...convertOpts, billingTerm: 'prepay_annual', prepayInvoiceAmount: 180, allowFirstApplicationFallback: false,
      };
      const same = await linkedFixture({});
      await EstimateConverter().convertEstimate(same.estimateId, {
        database: mockTransaction, ...prepayOpts, createdCustomerId: same.customerId,
      });
      const sameRow = await reread(same.customerId);
      expect(sameRow.billing_mode).toBe('per_application');
      expect(Number(sameRow.per_application_fee)).toBe(PEST_PER_VISIT);

      const other = await linkedFixture({});
      await EstimateConverter().convertEstimate(other.estimateId, {
        database: mockTransaction, ...prepayOpts, createdCustomerId: randomUUID(),
      });
      const otherRow = await reread(other.customerId);
      expect(otherRow.billing_mode == null).toBe(true);
    });
  });

  describe('termite-annual sign-before-pay park (bundled estimate)', () => {
    const TERMITE_BUNDLE = {
      commercialEstimatedPricing: true, // bypasses the slot requirement so the accept reaches the park
      result: {
        lineItems: [{ service: 'termite_bait', plan: 'annual_protection', annual: 250 }],
        recurring: {
          discount: 0,
          monthlyTotal: 15,
          services: [
            { name: 'Termite Bait Stations', service: 'termite_bait', annual: 250 },
            { name: 'Pest Control', service: 'pest_control', mo: 15, visitsPerYear: 4, perTreatment: PEST_PER_VISIT },
          ],
        },
        oneTime: { items: [], membershipFee: 0 },
      },
    };
    const gates = ['GATE_TERMITE_ANNUAL_PLAN', 'GATE_CANCEL_FLOW_V2'];
    const savedGates = {};
    beforeAll(() => { gates.forEach((g) => { savedGates[g] = process.env[g]; process.env[g] = 'true'; }); });
    afterAll(() => { gates.forEach((g) => { if (savedGates[g] === undefined) delete process.env[g]; else process.env[g] = savedGates[g]; }); });

    test('the minted customer parks with monthly_rate NULL, is outside billing-cron\'s selection, and a second accept on that phone converts per_application', async () => {
      const first = await estimateFixture(mockTransaction, {
        estimateData: TERMITE_BUNDLE, monthly: 15, annual: 430,
      });
      const res = await putAccept(first.token, { paymentMethodPreference: 'prepay_annual' });
      const body = await res.clone().json();
      expect(res.status).toBe(200);
      const parkedEst = await mockTransaction('estimates').where({ id: first.estimateId }).first();
      expect(parkedEst.annual_plan_activation_status).toBe('awaiting_signature');
      const minted = await customerForEstimate(first.estimateId);
      expect(body).toBeTruthy();
      expect(minted.monthly_rate == null).toBe(true);
      expect(minted.billing_mode == null).toBe(true);

      // billing-cron's monthly sweep selection (services/billing-cron.js processMonthlyBilling)
      const swept = await mockTransaction('customers')
        .where({ active: true })
        .where('monthly_rate', '>', 0)
        .whereNull('service_paused_at')
        .whereNull('deleted_at')
        .where({ id: minted.id });
      expect(swept).toHaveLength(0);

      // A second accept in the park window phone-matches the minted profile
      // and must NOT read it as an existing monthly member.
      const second = await estimateFixture(mockTransaction, { phone: first.phone });
      expect((await putAccept(second.token)).status).toBe(200);
      const after = await customerForEstimate(second.estimateId);
      expect(after.id).toBe(minted.id);
      expect(after.billing_mode).toBe('per_application');
      expect(Number(after.per_application_fee)).toBe(PEST_PER_VISIT);
    });
  });
});
