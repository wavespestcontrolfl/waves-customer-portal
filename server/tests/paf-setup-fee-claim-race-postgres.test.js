/**
 * Setup-fee claim consumption is atomic across concurrent completions of the
 * SAME series (Codex P1 on #5485). The stamped fee (scheduled_services.
 * pending_setup_fee on the series parent) is claimed by flipping it NEGATIVE
 * while a completion mints; the orphaned-claim recovery used to adopt a
 * negative claim on an updated_at compare-and-swap with NO lease age, so a
 * second visit of the series that read the in-flight claim between the first
 * visit's claim and its mint adopted it too, and both minted + charged a setup
 * line. These tests run the REAL completeScheduledService transaction against
 * a migrated private Postgres clone:
 *
 *  - two DIFFERENT visits of one series completing concurrently, many times:
 *    exactly one setup line, one claim record and one fee-carrying charge;
 *  - a FRESH negative marker (a completion mid-mint) is never adopted;
 *  - a STALE negative marker (a dead worker) is still adopted once, so a
 *    crashed completion cannot strand the fee.
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
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../services/stripe', () => ({
  // A successful off-session charge settles the invoice inline, like the real
  // saved-card rail.
  chargeInvoiceWithSavedCard: jest.fn(async (invoiceId) => {
    await mockPg('invoices').where({ id: invoiceId }).update({ status: 'paid', paid_at: new Date() });
    return { ok: true };
  }),
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

// Verified private clone only — never a shared or production URL. Accepts this
// lane's own waves_qa_paf_setup clone or CI's isolated waves_test. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the marker the CI
// "DB-gated suites" step greps for to discover and run this file.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_qa_paf_setup';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Setup-fee claim race Postgres tests require this lane\'s own waves_qa_paf_setup or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const SETUP_FEE = 99;
const VISIT_PRICE = 50;

async function seed({ stamp = SETUP_FEE, withDeferredMarker = true, childCount = 1 } = {}) {
  const { etDateString } = require('../utils/datetime-et');
  const today = etDateString();
  const f = {
    customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), estimateId: randomUUID(),
    pmId: randomUUID(), parentId: randomUUID(), childIds: [], serviceKey: `fixture_pest_${randomUUID().slice(0, 8)}`,
  };
  await mockPg('customers').insert({
    id: f.customerId, first_name: 'Fixture', last_name: 'PafSetup', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', billing_mode: 'per_application',
    autopay_enabled: true, waveguard_tier: 'Bronze', active: true,
  });
  await mockPg('payment_methods').insert({
    id: f.pmId, customer_id: f.customerId, processor: 'stripe', stripe_payment_method_id: `pm_${f.pmId.slice(0, 12)}`,
    method_type: 'card', is_default: true, autopay_enabled: true, exp_month: 12, exp_year: 2099, card_brand: 'visa', last_four: '4242',
  });
  await mockPg('customers').where({ id: f.customerId }).update({ autopay_payment_method_id: f.pmId });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture General Pest Control ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('estimates').insert({
    id: f.estimateId, customer_id: f.customerId, status: 'accepted', accepted_at: new Date(), price_locked_by: 'customer_accept',
    monthly_total: 45, waveguard_tier: 'Bronze',
    estimate_data: JSON.stringify({
      recurring: { services: [{ name: 'Pest Control', service: 'pest_control', frequency: 'quarterly', mo: 45 }] },
      acceptedSetupFeeAmount: SETUP_FEE,
      ...(withDeferredMarker ? { setupFeeDeferredToFirstVisit: true, recurringCardLaneAccepted: true } : {}),
    }),
  });
  await mockPg('activity_log').insert({
    customer_id: f.customerId, action: 'estimate_converted',
    description: `Estimate #${f.estimateId} converted: Fixture PafSetup → WaveGuard Bronze at $45.00/mo (1 combined qualifying services, 1 from this estimate, 2 scheduled)`,
  });
  const visitBase = {
    customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture General Pest Control ${f.serviceKey}`, scheduled_date: today, window_start: '09:00', window_end: '10:00',
    status: 'confirmed', estimated_price: VISIT_PRICE, estimated_duration_minutes: 60, source_estimate_id: f.estimateId,
    is_recurring: true, recurring_pattern: 'quarterly',
  };
  await mockPg('scheduled_services').insert({ ...visitBase, id: f.parentId, pending_setup_fee: stamp });
  for (let i = 0; i < childCount; i += 1) {
    const id = randomUUID();
    f.childIds.push(id);
    await mockPg('scheduled_services').insert({
      ...visitBase, id, recurring_parent_id: f.parentId, status: 'pending', scheduled_date: etDateString(new Date(Date.now() + (i + 1) * 90 * 86400000)),
    });
  }
  return f;
}

async function cleanup(f) {
  const ids = [f.parentId, ...f.childIds];
  await mockPg('setup_fee_claims').whereIn('scheduled_service_id', ids).del().catch(() => {});
  await mockPg('service_completion_attempts').whereIn('service_id', ids).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`unminted_setup_fee_manual_billing:${f.estimateId}`]).del().catch(() => {});
  await mockPg('scheduled_services').whereIn('id', f.childIds).del().catch(() => {});
  await mockPg('scheduled_services').where({ id: f.parentId }).del().catch(() => {});
  await mockPg('activity_log').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('estimates').where({ id: f.estimateId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).update({ autopay_payment_method_id: null }).catch(() => {});
  await mockPg('payment_methods').where({ id: f.pmId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

function body(overrides = {}) {
  return {
    customerRecap: 'Visit closed out.', visitOutcome: 'completed', products: [], areasServiced: [],
    sendCompletionSms: false, requestReview: false, ...overrides,
  };
}

async function complete(f, serviceId, overrides = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null }, body: body(overrides) });
}

// A series child is seeded for a future date; the completion route refuses a
// future-dated visit, so bring it to today (and live) before completing it.
async function makeDue(id) {
  const { etDateString } = require('../utils/datetime-et');
  await mockPg('scheduled_services').where({ id }).update({ status: 'confirmed', scheduled_date: etDateString() });
}



const lines = (inv) => (typeof inv.line_items === 'string' ? JSON.parse(inv.line_items) : inv.line_items) || [];
const setupLines = (inv) => lines(inv).filter((l) => /one-time setup fee/i.test(String(l.description || '')));

postgres('PAF setup fee — claim consumption is atomic across concurrent visits of one series', () => {
  const savedEnv = {};
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 10 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(() => {
    for (const k of ['GATE_UNMINTED_SETUP_FEE_PARK']) savedEnv[k] = process.env[k];
    process.env.GATE_UNMINTED_SETUP_FEE_PARK = 'true';
    require('../services/stripe').chargeInvoiceWithSavedCard.mockClear();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('two DIFFERENT visits of one series completing concurrently (20 iterations): exactly one setup line, one claim record, one fee-carrying charge', async () => {
    const ITERATIONS = 20;
    for (let i = 0; i < ITERATIONS; i += 1) {
      const f = await seed();
      try {
        await makeDue(f.childIds[0]);
        const { chargeInvoiceWithSavedCard } = require('../services/stripe');
        chargeInvoiceWithSavedCard.mockClear();
        // Alternate which visit is dispatched first so neither ordering is favored.
        const order = i % 2 === 0 ? [f.parentId, f.childIds[0]] : [f.childIds[0], f.parentId];
        const results = await Promise.all(order.map((id) => complete(f, id)));
        // A completion that met the other one's FRESH in-flight fee marker
        // refuses retryably (503 setup_fee_claim_in_flight) instead of minting
        // without the fee; its retry, after the owner committed, finalizes.
        for (let k = 0; k < results.length; k += 1) {
          for (let attempt = 0; results[k].status === 503 && attempt < 3; attempt += 1) {
            expect(results[k].body).toMatchObject({ code: 'setup_fee_claim_in_flight' });
            results[k] = await complete(f, order[k]);
          }
        }
        results.forEach((r) => expect(r).toMatchObject({ status: 200 }));

        const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
        const feeLines = invoices.flatMap(setupLines);
        expect(feeLines).toHaveLength(1);
        const claims = await mockPg('setup_fee_claims').whereIn('scheduled_service_id', [f.parentId, ...f.childIds]);
        expect(claims).toHaveLength(1);
        // Every visit's invoice is charged once; only ONE charge may carry the
        // fee (the claim-backed setup allowance on the cap).
        const feeCharges = chargeInvoiceWithSavedCard.mock.calls
          .filter((call) => call[2]?.maxAuthorizedSubtotal === VISIT_PRICE + SETUP_FEE);
        expect(feeCharges).toHaveLength(1);
        const settledFeeInvoices = invoices.filter((inv) => Number(inv.subtotal) === VISIT_PRICE + SETUP_FEE);
        expect(settledFeeInvoices).toHaveLength(1);
        // The fee is billed or still queued, never both and never twice.
        const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee');
        expect(parent.pending_setup_fee).toBeNull();
      } finally { await cleanup(f); }
    }
  }, 300000);

  test('a FRESH negative marker (a completion mid-mint) is never adopted, and the visit is not finalized without it (retryable 503, then adopted once the lease lapses)', async () => {
    const f = await seed({ stamp: -SETUP_FEE });
    try {
      // The in-progress marker was written just now by another completion that
      // has not minted yet (or by a crashed attempt this retry replaced): this
      // visit must neither adopt it nor mint and finalize WITHOUT the fee — it
      // releases for resume (503) and leaves the claim alone.
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ updated_at: new Date() });
      await makeDue(f.childIds[0]);
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: -SETUP_FEE, updated_at: new Date() });
      const out = await complete(f, f.childIds[0]);
      expect(out).toMatchObject({ status: 503, body: { code: 'setup_fee_claim_in_flight' } });
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(0);
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee');
      expect(Number(parent.pending_setup_fee)).toBe(-SETUP_FEE);
      // Once the lease lapses (its owner died), the retry adopts the claim and
      // bills the fee exactly once.
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000) });
      const retried = await complete(f, f.childIds[0]);
      expect(retried).toMatchObject({ status: 200 });
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(1);
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
    } finally { await cleanup(f); }
  });

  test('a STALE negative marker (a dead worker) is still adopted exactly once, so a crash cannot strand the fee', async () => {
    const f = await seed({ stamp: -SETUP_FEE });
    try {
      await makeDue(f.childIds[0]);
      await mockPg('scheduled_services').where({ id: f.parentId })
        .update({ pending_setup_fee: -SETUP_FEE, updated_at: new Date(Date.now() - 6 * 60 * 60 * 1000) });
      const out = await complete(f, f.childIds[0]);
      expect(out).toMatchObject({ status: 200 });
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices.flatMap(setupLines)).toHaveLength(1);
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee');
      expect(parent.pending_setup_fee).toBeNull();
      expect(await mockPg('setup_fee_claims').whereIn('scheduled_service_id', [f.parentId, ...f.childIds])).toHaveLength(1);
    } finally { await cleanup(f); }
  });
});
