/**
 * Pay after the first visit (PR-C) — the monthly-tier setup fee rides the
 * first PERFORMED visit. The accept (estimate-public.js, GATE_PAF_SETUP_FEE)
 * stamps scheduled_services.pending_setup_fee on the first visit's series
 * parent instead of minting a payable unattached invoice; these tests run the
 * REAL completeScheduledService transaction against a migrated private
 * Postgres clone and check what the stamp does at completion:
 *
 *  - the first performed completion adds the setup fee as a line of the
 *    visit's own invoice (one invoice) and charges the saved card ONCE, under
 *    the cap (the claim-backed setup allowance);
 *  - the obligation detector (GATE_UNMINTED_SETUP_FEE_PARK) does NOT park
 *    that first visit for manual billing — a live stamp is "deferred", not
 *    "never minted" — while the same visit WITHOUT a stamp still parks;
 *  - a visit that performed nothing (customer_declined) bills nothing and
 *    leaves the stamp for the next performed visit;
 *  - a fee the first performed visit cannot bill on its own invoice is PARKED
 *    for the office (stamp cleared, one setup_fee_office_billing alert, no
 *    invoice, no claim) and no later visit bills it again;
 *  - the second visit never bills the fee again;
 *  - a cancelled series is never billed (the stamp is inert).
 *
 * Wiring copied from complete-scheduled-service-first-visit-rating-default-
 * postgres.test.js.
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
    throw new Error('Pay-after-first-visit setup-fee Postgres tests require this lane\'s own waves_qa_paf_setup or CI\'s waves_test.');
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
  await mockPg('dispatch_alerts').whereIn('job_id', ids).del().catch(() => {});
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

async function complete(f, serviceId, overrides = {}, idempotencyKey = randomUUID()) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId, idempotencyKey,
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
// The durable owed-fee record of a setup fee parked for the office (owner
// ruling 2026-10-01): one setup_fee_office_billing alert per parked stamp.
const officeFeeAlerts = (f) => mockPg('dispatch_alerts').where({ type: 'setup_fee_office_billing', job_id: f.parentId });
const parkAlerts = (f) => mockPg('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`unminted_setup_fee_manual_billing:${f.estimateId}`]);

postgres('PAF setup fee — the stamped fee rides the first performed visit', () => {
  const savedEnv = {};
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 6 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(() => {
    for (const k of ['GATE_UNMINTED_SETUP_FEE_PARK']) savedEnv[k] = process.env[k];
    // The detector is what would wrongly park a deferred first visit.
    process.env.GATE_UNMINTED_SETUP_FEE_PARK = 'true';
    require('../services/stripe').chargeInvoiceWithSavedCard.mockClear();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  test('first performed completion: ONE invoice carries the visit and the setup fee, the card is charged ONCE under the cap, the stamp is retired, the visit is not parked', async () => {
    const f = await seed();
    try {
      const out = await complete(f, f.parentId);
      expect(out).toMatchObject({ status: 200 });

      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices).toHaveLength(1);
      const [inv] = invoices;
      expect(setupLines(inv)).toHaveLength(1);
      expect(Number(setupLines(inv)[0].unit_price ?? setupLines(inv)[0].amount)).toBe(SETUP_FEE);
      expect(Number(inv.subtotal)).toBe(VISIT_PRICE + SETUP_FEE);

      // The claim-backed setup allowance keeps the charge under the cap.
      const { chargeInvoiceWithSavedCard } = require('../services/stripe');
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard.mock.calls[0][0]).toBe(inv.id);
      expect(chargeInvoiceWithSavedCard.mock.calls[0][2].maxAuthorizedSubtotal).toBe(VISIT_PRICE + SETUP_FEE);

      // Stamp retired + immutable claim recorded (idempotency across retries).
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee');
      expect(parent.pending_setup_fee).toBeNull();
      const claims = await mockPg('setup_fee_claims').where({ invoice_id: inv.id });
      expect(claims).toHaveLength(1);
      expect(Number(claims[0].amount)).toBe(SETUP_FEE);

      // The obligation detector treated the stamp as "deferred": nothing parked.
      expect(await parkAlerts(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  test('without the stamp the SAME visit is parked for manual billing (proves the detector change is what lets the stamped visit through)', async () => {
    const f = await seed({ stamp: null, withDeferredMarker: false });
    try {
      const out = await complete(f, f.parentId);
      expect(out).toMatchObject({ status: 200 });
      const { chargeInvoiceWithSavedCard } = require('../services/stripe');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(await parkAlerts(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a visit that performed nothing (customer_declined) bills nothing and leaves the stamp for the next performed visit', async () => {
    const f = await seed();
    try {
      const out = await complete(f, f.parentId, { visitOutcome: 'customer_declined' });
      expect(out).toMatchObject({ status: 200 });
      expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(0);
      const { chargeInvoiceWithSavedCard } = require('../services/stripe');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee');
      expect(Number(parent.pending_setup_fee)).toBe(SETUP_FEE);
      expect(await mockPg('setup_fee_claims').where({ scheduled_service_id: f.parentId })).toHaveLength(0);

      // The next performed visit of the series carries it.
      await makeDue(f.childIds[0]);
      const next = await complete(f, f.childIds[0]);
      expect(next).toMatchObject({ status: 200 });
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices).toHaveLength(1);
      expect(setupLines(invoices[0])).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  // Owner ruling 2026-10-01 ("decide at the visit"): annual prepay waives the
  // WaveGuard setup fee. While a live prepay year covers the visit the deferred
  // fee is neither billed nor parked (the stamp waits); once no prepay covers a
  // performed visit, that visit bills it as normal. No switch bookkeeping.
  test('a live annual-prepay year covering the visit waives the deferred fee at the visit; it bills once coverage ends', async () => {
    const f = await seed();
    const { etDateString } = require('../utils/datetime-et');
    const termStart = etDateString(new Date(Date.now() - 30 * 86400000));
    const termEnd = etDateString(new Date(Date.now() + 300 * 86400000));
    const [term] = await mockPg('annual_prepay_terms')
      .insert({ customer_id: f.customerId, term_start: termStart, term_end: termEnd, status: 'active' }).returning('id');
    const termId = term.id || term;
    // The term's coverage is stamped on the visits it covers (applyPrepaidCoverageForTerm).
    await mockPg('scheduled_services').whereIn('id', [f.parentId, ...f.childIds])
      .update({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100, annual_prepay_term_id: termId });
    const visitRow = () => mockPg('scheduled_services').where({ id: f.parentId }).first();
    try {
      const Obligation = require('../services/setup-fee-obligation');
      expect(await Obligation.prepayWaivesDeferredSetupFee(mockPg, { seriesId: f.parentId, visit: await visitRow() })).toBe(true);
      // The office is never handed a waived fee, and the stamp is left waiting.
      const performed = await visitRow();
      const parked = await mockPg.transaction((trx) => Obligation.parkSetupFeeStampForOffice(trx, {
        parentId: f.parentId, rawAmount: SETUP_FEE, customerId: f.customerId, estimateId: f.estimateId, origin: 'test', visit: performed,
      }));
      expect(parked).toBeNull();
      expect(await officeFeeAlerts(f)).toHaveLength(0);
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(SETUP_FEE);

      // A performed visit while covered: no setup line anywhere, nothing parked, the stamp waits.
      expect(await complete(f, f.parentId)).toMatchObject({ status: 200 });
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(0);
      expect(await officeFeeAlerts(f)).toHaveLength(0);
      expect(await parkAlerts(f)).toHaveLength(0);
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(SETUP_FEE);

      // Coverage ends (the prepay was refunded): the next performed visit bills it.
      await mockPg('annual_prepay_terms').where({ id: termId }).update({ status: 'cancelled', renewal_decision: null });
      await makeDue(f.childIds[0]);
      const child = await mockPg('scheduled_services').where({ id: f.childIds[0] }).first();
      expect(await Obligation.prepayWaivesDeferredSetupFee(mockPg, { seriesId: f.parentId, visit: child })).toBe(false);
      expect(await complete(f, f.childIds[0])).toMatchObject({ status: 200 });
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(1);
    } finally {
      await mockPg('annual_prepay_terms').where({ id: termId }).del().catch(() => {});
      await cleanup(f);
    }
  });

  test('an UNPAID prepay quote (payment_pending, no coverage stamp on the visit) does not waive the deferred fee', async () => {
    const f = await seed();
    const { etDateString } = require('../utils/datetime-et');
    const [term] = await mockPg('annual_prepay_terms').insert({
      customer_id: f.customerId, term_start: etDateString(new Date(Date.now() - 86400000)),
      term_end: etDateString(new Date(Date.now() + 300 * 86400000)), status: 'payment_pending',
    }).returning('id');
    try {
      const visit = await mockPg('scheduled_services').where({ id: f.parentId }).first();
      expect(await require('../services/setup-fee-obligation').prepayWaivesDeferredSetupFee(mockPg, { seriesId: f.parentId, visit })).toBe(false);
    } finally {
      await mockPg('annual_prepay_terms').where({ id: term.id || term }).del().catch(() => {});
      await cleanup(f);
    }
  });

  test('the at-visit prepay waiver never applies to a fee no pay-after-first-visit accept deferred', async () => {
    const f = await seed({ withDeferredMarker: false });
    const { etDateString } = require('../utils/datetime-et');
    const [term] = await mockPg('annual_prepay_terms').insert({
      customer_id: f.customerId, term_start: etDateString(new Date(Date.now() - 86400000)),
      term_end: etDateString(new Date(Date.now() + 300 * 86400000)), status: 'active',
    }).returning('id');
    try {
      await mockPg('scheduled_services').where({ id: f.parentId })
        .update({ prepaid_method: 'annual_prepay_invoice', prepaid_amount: 100, annual_prepay_term_id: term.id || term });
      const visit = await mockPg('scheduled_services').where({ id: f.parentId }).first();
      expect(await require('../services/setup-fee-obligation').prepayWaivesDeferredSetupFee(mockPg, { seriesId: f.parentId, visit })).toBe(false);
    } finally {
      await mockPg('annual_prepay_terms').where({ id: term.id || term }).del().catch(() => {});
      await cleanup(f);
    }
  });

  test('a PRICED non-recurring booster completing after a declined first visit bills its own work without the plan fee', async () => {
    const f = await seed();
    try {
      expect(await complete(f, f.parentId, { visitOutcome: 'customer_declined' })).toMatchObject({ status: 200 });
      const child = await mockPg('scheduled_services').where({ id: f.childIds[0] }).first();
      const { randomUUID: uuid } = require('crypto');
      const { etDateString } = require('../utils/datetime-et');
      const boosterId = uuid();
      f.childIds.push(boosterId);
      await mockPg('scheduled_services').insert({
        id: boosterId, customer_id: child.customer_id, technician_id: child.technician_id, service_id: child.service_id,
        service_type: child.service_type, scheduled_date: etDateString(), window_start: '11:00', window_end: '12:00',
        status: 'confirmed', estimated_price: 45, estimated_duration_minutes: 30, source_estimate_id: child.source_estimate_id,
        recurring_parent_id: f.parentId, is_recurring: false,
      });
      expect(await complete(f, boosterId)).toMatchObject({ status: 200 });
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(0);
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(SETUP_FEE);
    } finally { await cleanup(f); }
  });

  test('adopted child declined -> a sibling bills the fee -> refund: the PAF fee is never restored (series-wide provenance)', async () => {
    const f = await seed({ childCount: 2 });
    try {
      // Older/unlinked parent; only child 0 (the adopted appointment) carries the estimate.
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ source_estimate_id: null, status: 'completed' });
      await mockPg('scheduled_services').where({ id: f.childIds[1] }).update({ source_estimate_id: null });
      await makeDue(f.childIds[0]);
      expect(await complete(f, f.childIds[0], { visitOutcome: 'customer_declined' })).toMatchObject({ status: 200 });
      await makeDue(f.childIds[1]);
      expect(await complete(f, f.childIds[1])).toMatchObject({ status: 200 });
      const inv = (await mockPg('invoices').where({ customer_id: f.customerId })).find((row) => setupLines(row).length);
      expect(inv).toBeTruthy();
      await mockPg('invoices').where({ id: inv.id }).update({ status: 'refunded' });
      const refunded = await mockPg('invoices').where({ id: inv.id }).first();
      expect(await require('../services/invoice').restoreRodentSetupObligationForReversedInvoice(mockPg, refunded)).toBeNull();
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
    } finally { await cleanup(f); }
  });

  test('a setup fee staff already billed by hand on a series invoice is not handed to the office again (claim recorded, stamp retired)', async () => {
    const f = await seed();
    const Obligation = require('../services/setup-fee-obligation');
    try {
      const byHand = await require('../services/invoice').create({
        customerId: f.customerId, scheduledServiceId: f.parentId, title: 'Office bill',
        lineItems: [
          { description: 'Visit', quantity: 1, unit_price: VISIT_PRICE },
          { description: 'One-time setup fee', quantity: 1, unit_price: SETUP_FEE },
        ],
      });
      const visit = await mockPg('scheduled_services').where({ id: f.parentId }).first();
      const parked = await mockPg.transaction((trx) => Obligation.parkSetupFeeStampForOffice(trx, {
        parentId: f.parentId, rawAmount: SETUP_FEE, customerId: f.customerId, estimateId: f.estimateId, origin: 'test', visit,
      }));
      expect(parked).toBeNull();
      expect(await officeFeeAlerts(f)).toHaveLength(0);
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
      expect(await mockPg('setup_fee_claims').where({ invoice_id: byHand.id, scheduled_service_id: f.parentId })).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a VOIDED first-visit invoice (never collected) puts the setup fee back; the next visit bills it (a refund would not)', async () => {
    const f = await seed();
    try {
      expect(await complete(f, f.parentId)).toMatchObject({ status: 200 });
      const [inv] = await mockPg('invoices').where({ customer_id: f.customerId });
      await mockPg('invoices').where({ id: inv.id }).update({ status: 'void' });
      const voided = await mockPg('invoices').where({ id: inv.id }).first();
      expect(await require('../services/invoice').restoreRodentSetupObligationForReversedInvoice(mockPg, voided))
        .toEqual({ scheduledServiceId: f.parentId, amount: SETUP_FEE });
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(SETUP_FEE);
      await makeDue(f.childIds[0]);
      expect(await complete(f, f.childIds[0])).toMatchObject({ status: 200 });
      const live = (await mockPg('invoices').where({ customer_id: f.customerId })).filter((row) => row.status !== 'void');
      expect(live.flatMap(setupLines)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a voided fee on a DEAD series is handed to the office (tagged with the invoice); un-void closes an open handoff and refuses one the office acted on', async () => {
    const f = await seed();
    try {
      expect(await complete(f, f.parentId)).toMatchObject({ status: 200 });
      const [inv] = await mockPg('invoices').where({ customer_id: f.customerId });
      // The series ends: no visit can bill a restored stamp.
      await mockPg('scheduled_services').whereIn('id', f.childIds).update({ status: 'cancelled' });
      await mockPg('invoices').where({ id: inv.id }).update({ status: 'void' });
      const Invoices = require('../services/invoice');
      await Invoices.restoreRodentSetupObligationForReversedInvoice(mockPg, await mockPg('invoices').where({ id: inv.id }).first());
      const [handoff] = await officeFeeAlerts(f);
      expect(handoff).toBeTruthy();
      expect(handoff.payload).toMatchObject({ sourceInvoiceId: String(inv.id), amount: SETUP_FEE });
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();

      // Un-void while the office has not acted: the handoff is closed.
      await Invoices.retireRodentSetupObligationForReinstatedInvoice(mockPg, inv.id, { strict: true });
      expect((await mockPg('dispatch_alerts').where({ id: handoff.id }).first('resolved_at')).resolved_at).not.toBeNull();

      // Had the office already acted on it, a strict un-void refuses (no double bill).
      await mockPg('dispatch_alerts').where({ id: handoff.id }).update({ resolved_at: new Date(Date.now() - 1000) });
      await expect(Invoices.retireRodentSetupObligationForReinstatedInvoice(mockPg, inv.id, { strict: true }))
        .rejects.toThrow(/handed to the office after it was voided/);
    } finally { await cleanup(f); }
  });

  test('a free CALLBACK completing on a dues-covered series never hands the stranded setup fee to the office', async () => {
    const f = await seed();
    try {
      await mockPg('customers').where({ id: f.customerId }).update({ billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 45 });
      await makeDue(f.childIds[0]);
      await mockPg('scheduled_services').where({ id: f.childIds[0] }).update({ is_callback: true, estimated_price: 0 });
      expect(await complete(f, f.childIds[0])).toMatchObject({ status: 200 });
      expect(await officeFeeAlerts(f)).toHaveLength(0);
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(SETUP_FEE);
    } finally { await cleanup(f); }
  });

  // Terminal Codex pass 1 (P2): a NON-recurring booster/add-on under the plan
  // parent is not a plan application, so its completion never takes (or parks)
  // the plan's queued first-visit fee.
  test('a zero-priced non-recurring booster completing after a declined first visit leaves the plan fee queued (nothing parked)', async () => {
    const f = await seed();
    try {
      expect(await complete(f, f.parentId, { visitOutcome: 'customer_declined' })).toMatchObject({ status: 200 });
      const child = await mockPg('scheduled_services').where({ id: f.childIds[0] }).first();
      const { randomUUID: uuid } = require('crypto');
      const { etDateString } = require('../utils/datetime-et');
      const boosterId = uuid();
      f.childIds.push(boosterId);
      await mockPg('scheduled_services').insert({
        id: boosterId, customer_id: child.customer_id, technician_id: child.technician_id, service_id: child.service_id,
        service_type: child.service_type, scheduled_date: etDateString(), window_start: '11:00', window_end: '12:00',
        status: 'confirmed', estimated_price: 0, estimated_duration_minutes: 30, source_estimate_id: child.source_estimate_id,
        recurring_parent_id: f.parentId, is_recurring: false,
      });
      expect(await complete(f, boosterId)).toMatchObject({ status: 200 });
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(SETUP_FEE);
      expect(await officeFeeAlerts(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  test('a no-show first visit charges nothing and keeps the stamp for the next performed visit', async () => {
    const f = await seed();
    try {
      const { transitionJobStatus } = require('../services/job-status');
      await transitionJobStatus({
        jobId: f.parentId, fromStatus: 'confirmed', toStatus: 'no_show', transitionedBy: f.techId, suppressTechNotice: true,
      });
      const parent = await mockPg('scheduled_services').where({ id: f.parentId }).first('status', 'pending_setup_fee');
      expect(parent.status).toBe('no_show');
      expect(Number(parent.pending_setup_fee)).toBe(SETUP_FEE);
      expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(0);
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();

      // The series' next performed visit still carries the fee, once.
      await makeDue(f.childIds[0]);
      const next = await complete(f, f.childIds[0]);
      expect(next).toMatchObject({ status: 200 });
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices).toHaveLength(1);
      expect(setupLines(invoices[0])).toHaveLength(1);
      expect(await parkAlerts(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  test('the second performed visit never bills the fee again', async () => {
    const f = await seed();
    try {
      await complete(f, f.parentId);
      await makeDue(f.childIds[0]);
      const second = await complete(f, f.childIds[0]);
      expect(second).toMatchObject({ status: 200 });
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId }).orderBy('created_at');
      expect(invoices).toHaveLength(2);
      expect(invoices.flatMap(setupLines)).toHaveLength(1);
      expect(await mockPg('setup_fee_claims').whereIn('invoice_id', invoices.map((i) => i.id))).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('refund-then-next-completion: a deliberately REFUNDED first invoice does not make the next visit read the fee as never invoiced (no park, no second setup line)', async () => {
    const f = await seed();
    try {
      await complete(f, f.parentId);
      const [first] = await mockPg('invoices').where({ customer_id: f.customerId });
      await mockPg('invoices').where({ id: first.id }).update({ status: 'refunded' });
      await makeDue(f.childIds[0]);
      const next = await complete(f, f.childIds[0]);
      expect(next).toMatchObject({ status: 200 });
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices).toHaveLength(2);
      expect(invoices.flatMap(setupLines)).toHaveLength(1);
      expect(await parkAlerts(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  test('a double-submitted first completion (two requests racing on the same visit) bills the fee exactly once', async () => {
    const f = await seed();
    try {
      const results = await Promise.all([complete(f, f.parentId), complete(f, f.parentId)]);
      expect(results.some((r) => r.status === 200)).toBe(true);
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices.flatMap(setupLines)).toHaveLength(1);
      expect(await mockPg('setup_fee_claims').whereIn('invoice_id', invoices.map((i) => i.id))).toHaveLength(1);
      const { chargeInvoiceWithSavedCard } = require('../services/stripe');
      expect(chargeInvoiceWithSavedCard.mock.calls.length).toBeLessThanOrEqual(1);
    } finally { await cleanup(f); }
  });

  test('a cancelled series is never billed: the stamp is inert and the detector no longer reads it as "deferred"', async () => {
    const f = await seed();
    try {
      await mockPg('scheduled_services').whereIn('id', [f.parentId, ...f.childIds]).update({ status: 'cancelled' });
      // Nothing can complete a cancelled series, so nothing is minted or charged.
      expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(0);
      const { chargeInvoiceWithSavedCard } = require('../services/stripe');
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      const { seriesCanStillConsume } = require('../services/secure-appointment-plans');
      const root = await mockPg('scheduled_services').where({ id: f.parentId }).first('id', 'status', 'pending_setup_fee');
      expect(await seriesCanStillConsume(mockPg, root)).toBe(false);
      const { findUnmintedSetupFeeObligation } = require('../services/setup-fee-obligation');
      const verdict = await findUnmintedSetupFeeObligation({ sourceEstimateId: f.estimateId, customerId: f.customerId }, mockPg);
      expect(verdict.deferredToFirstVisit).toBeUndefined();
    } finally { await cleanup(f); }
  });

  test('combined-visit packet: any still-queued setup claim on the series (PAF marker or not) sends the closeout to the office (the packet mint carries no setup line); no stamp does not', async () => {
    const f = await seed();
    try {
      const { deferredSetupClaimStillQueued } = require('../services/visit-completion-invoice');
      const member = { id: f.parentId, recurring_parent_id: null, source_estimate_id: f.estimateId };
      expect(await deferredSetupClaimStillQueued(mockPg, member)).toBe(true);
      // A child member resolves its series parent's claim.
      expect(await deferredSetupClaimStillQueued(mockPg, { id: f.childIds[0], recurring_parent_id: f.parentId, source_estimate_id: f.estimateId })).toBe(true);
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: -SETUP_FEE });
      expect(await deferredSetupClaimStillQueued(mockPg, member)).toBe(true);
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: null });
      expect(await deferredSetupClaimStillQueued(mockPg, member)).toBe(false);
      // Keyed on the STAMP itself, not the PAF estimate marker: a secure
      // plan-choice stamp (gate-off, no setupFeeDeferredToFirstVisit marker)
      // is the same durable claim.
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: SETUP_FEE });
      await mockPg('estimates').where({ id: f.estimateId }).update({ estimate_data: JSON.stringify({ acceptedSetupFeeAmount: SETUP_FEE }) });
      expect(await deferredSetupClaimStillQueued(mockPg, member)).toBe(true);
    } finally { await cleanup(f); }
  });

  test('detector: a live stamp (positive or the negative in-progress marker) at the frozen fee is deferred; a different amount is not', async () => {
    const f = await seed();
    try {
      const { findUnmintedSetupFeeObligation } = require('../services/setup-fee-obligation');
      const run = () => findUnmintedSetupFeeObligation({ sourceEstimateId: f.estimateId, customerId: f.customerId, excludeScheduledServiceId: f.parentId }, mockPg);
      expect(await run()).toMatchObject({ owed: false, deferredToFirstVisit: true });
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: -SETUP_FEE });
      expect(await run()).toMatchObject({ owed: false, deferredToFirstVisit: true });
      // The stamp IS the fee: any live stamp on this estimate's own series is
      // deferred (a cents mismatch must neither park the visit for a manual bill
      // nor leave the stamp armed to bill on top of it).
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: 49 });
      expect(await run()).toMatchObject({ owed: false, deferredToFirstVisit: true });
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: null });
      expect((await run()).deferredToFirstVisit).toBeUndefined();
    } finally { await cleanup(f); }
  });

  // A stamp at another amount is still THE fee: completion bills it, and the
  // next completion must read the immutable claim as billed (not re-demand the
  // full frozen $99 through a manual-billing alert).
  test('a lower-valued stamp ($49 on a $99 estimate) bills at $49 through collection, and the NEXT completion neither alerts nor bills a second fee', async () => {
    const f = await seed({ stamp: 49 });
    try {
      const first = await complete(f, f.parentId);
      expect(first).toMatchObject({ status: 200 });
      let invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices).toHaveLength(1);
      expect(setupLines(invoices[0])).toHaveLength(1);
      expect(Number(setupLines(invoices[0])[0].unit_price ?? setupLines(invoices[0])[0].amount)).toBe(49);
      expect(await parkAlerts(f)).toHaveLength(0);

      await makeDue(f.childIds[0]);
      const next = await complete(f, f.childIds[0]);
      expect(next).toMatchObject({ status: 200 });
      invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices).toHaveLength(2);
      expect(invoices.flatMap(setupLines)).toHaveLength(1);
      expect(await parkAlerts(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  // Codex round 2 P2: a first performed visit repriced to $0 bills nothing, so
  // its queued fee has no invoice to ride. It is PARKED for the office (owner
  // ruling 2026-10-01) instead of sliding to a later visit (or being lost): no
  // draft invoice, no claim, one owed-fee alert.
  test('a first performed visit repriced to $0 parks the queued fee for the office (no invoice); the next priced visit does not bill it again', async () => {
    const f = await seed();
    try {
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ estimated_price: 0 });
      const first = await complete(f, f.parentId);
      expect(first).toMatchObject({ status: 200 });
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
      expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(0);
      expect(await mockPg('setup_fee_claims').whereIn('scheduled_service_id', [f.parentId, ...f.childIds])).toHaveLength(0);
      const alerts = await officeFeeAlerts(f);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ severity: 'warn', resolved_at: null });
      expect(alerts[0].payload).toMatchObject({ amount: SETUP_FEE, seriesId: f.parentId, estimateId: f.estimateId, customerId: f.customerId, visitId: f.parentId });
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(await parkAlerts(f)).toHaveLength(0);

      await makeDue(f.childIds[0]);
      const next = await complete(f, f.childIds[0]);
      expect(next).toMatchObject({ status: 200 });
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(0);
      expect(await officeFeeAlerts(f)).toHaveLength(1);
      expect(await parkAlerts(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  // Pre-push audit P1: an invoice already on the first visit (Charge Now, an
  // office bill) keeps the completion mint from running, so the mint never
  // consumes the queued fee. It is parked for the office, never left armed for
  // a later visit (the fallback reads the stamp after the mint, so a reviewed
  // 100% discount takes the same path).
  test('a first performed visit that already has a fee-less invoice parks the queued fee for the office; the next visit does not bill it again', async () => {
    const f = await seed();
    try {
      const existing = await require('../services/invoice').create({
        customerId: f.customerId, scheduledServiceId: f.parentId, title: 'Office bill',
        lineItems: [{ description: 'Visit', quantity: 1, unit_price: VISIT_PRICE }],
      });
      const first = await complete(f, f.parentId);
      expect(first).toMatchObject({ status: 200 });
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices.map((inv) => inv.id)).toEqual([existing.id]);
      expect(invoices.flatMap(setupLines)).toHaveLength(0);
      expect(await mockPg('setup_fee_claims').whereIn('scheduled_service_id', [f.parentId, ...f.childIds])).toHaveLength(0);
      expect(await officeFeeAlerts(f)).toHaveLength(1);

      await makeDue(f.childIds[0]);
      const next = await complete(f, f.childIds[0]);
      expect(next).toMatchObject({ status: 200 });
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(0);
      expect(await officeFeeAlerts(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  // Owner ruling 2026-10-01 + Codex #5485 round 4 P1: when the park cannot be
  // persisted the stamp is still armed, so the completion must NOT finalize.
  // It releases the attempt for resume (503 setup_fee_park_failed) and leaves
  // the stamp queued; the resume parks it.
  test('a park failure in the post-mint fallback returns 503 setup_fee_park_failed and leaves the stamp queued; the resume parks it', async () => {
    const f = await seed();
    const Alerts = require('../services/dispatch-alerts');
    const realCreateAlert = Alerts.createAlert;
    let failPark = true;
    const alertSpy = jest.spyOn(Alerts, 'createAlert').mockImplementation((args) => (
      failPark && args?.type === 'setup_fee_office_billing'
        ? Promise.reject(new Error('alert write failed'))
        : realCreateAlert(args)));
    try {
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ estimated_price: 0 });
      const key = randomUUID();
      const first = await complete(f, f.parentId, {}, key);
      expect(first).toMatchObject({ status: 503, body: { code: 'setup_fee_park_failed' } });
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(SETUP_FEE);
      expect(await officeFeeAlerts(f)).toHaveLength(0);
      expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(0);

      failPark = false;
      const resumed = await complete(f, f.parentId, {}, key);
      expect(resumed).toMatchObject({ status: 200 });
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
      expect(await officeFeeAlerts(f)).toHaveLength(1);
    } finally { alertSpy.mockRestore(); await cleanup(f); }
  });

  // Codex #5485 r3 P1: the refund path's rodent-setup restoration must never
  // re-arm a pay-after-first-visit fee (a refunded claim-backed fee stays
  // resolved; the next completion must not bill it again).
  test('a refunded first invoice does NOT re-arm the PAF setup fee through the rodent restoration path', async () => {
    const f = await seed();
    try {
      expect(await complete(f, f.parentId)).toMatchObject({ status: 200 });
      const [inv] = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(setupLines(inv)).toHaveLength(1);
      await mockPg('invoices').where({ id: inv.id }).update({ status: 'refunded' });
      const refunded = await mockPg('invoices').where({ id: inv.id }).first();
      const restored = await require('../services/invoice').restoreRodentSetupObligationForReversedInvoice(mockPg, refunded);
      expect(restored).toBeNull();
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
    } finally { await cleanup(f); }
  });

  test('adopted child: refunding the child\'s invoice does not re-arm the fee stamped on the other-series parent', async () => {
    const f = await seed();
    try {
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ source_estimate_id: null, status: 'completed' });
      await makeDue(f.childIds[0]);
      expect(await complete(f, f.childIds[0])).toMatchObject({ status: 200 });
      const inv = (await mockPg('invoices').where({ customer_id: f.customerId })).find((row) => setupLines(row).length);
      expect(inv).toBeTruthy();
      const claim = await mockPg('setup_fee_claims').where({ invoice_id: inv.id }).first();
      expect(String(claim.estimate_id)).toBe(String(f.estimateId));
      await mockPg('invoices').where({ id: inv.id }).update({ status: 'refunded' });
      const refunded = await mockPg('invoices').where({ id: inv.id }).first();
      expect(await require('../services/invoice').restoreRodentSetupObligationForReversedInvoice(mockPg, refunded)).toBeNull();
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
    } finally { await cleanup(f); }
  });

  // Codex #5485 r3 P1: an accept that adopted an existing appointment leaves
  // source_estimate_id on the CHILD and stamps the fee on its series parent
  // (an older / unlinked series). The detector must find that stamp, or the
  // first completion is parked while the claim stays armed.
  test('a stamp on the parent of a source-linked child (adopted appointment) is read as deferred: the child completion bills it, nothing parked', async () => {
    const f = await seed();
    try {
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ source_estimate_id: null, status: 'completed' });
      await makeDue(f.childIds[0]);
      expect(await complete(f, f.childIds[0])).toMatchObject({ status: 200 });
      expect(await parkAlerts(f)).toHaveLength(0);
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
      expect((await mockPg('invoices').where({ customer_id: f.customerId })).flatMap(setupLines)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  // Reviewer P2-B/P2-D: a stamp on a customer whose lane never runs the
  // completion mint (monthly membership: dues cover the visit) can never be
  // consumed. The detector must not call it a deferral (the fee would be
  // silently lost). And a stamp is never cleared into nothing: it is PARKED for
  // the office (owner ruling 2026-10-01): one setup_fee_office_billing alert is
  // the durable owed-fee record, no invoice and no claim row are written, and
  // the detector reads the alert as covered.
  test('a live stamp on a monthly_membership customer is not a deferral: owed, the stamp is reported, and parking it clears the stamp + writes one office alert, no invoice (CAS on the exact value)', async () => {
    const f = await seed();
    try {
      await mockPg('customers').where({ id: f.customerId }).update({ billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 45 });
      const { findUnmintedSetupFeeObligation, parkSetupFeeStampForOffice } = require('../services/setup-fee-obligation');
      const args = { sourceEstimateId: f.estimateId, customerId: f.customerId, excludeScheduledServiceId: f.parentId };
      const verdict = await findUnmintedSetupFeeObligation(args, mockPg);
      expect(verdict.owed).toBe(true);
      expect(verdict.deferredToFirstVisit).toBeUndefined();
      expect(verdict.unconsumableStamps).toEqual([{ parentId: f.parentId, rawAmount: expect.anything(), amount: SETUP_FEE }]);
      const [stamp] = verdict.unconsumableStamps;
      const ctx = { parentId: stamp.parentId, rawAmount: stamp.rawAmount, customerId: f.customerId, estimateId: f.estimateId, origin: 'test' };

      // A stamp that moved since the read is left alone: no alert, no invoice.
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: 49 });
      expect(await mockPg.transaction((trx) => parkSetupFeeStampForOffice(trx, ctx))).toBeNull();
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(49);
      expect(await officeFeeAlerts(f)).toHaveLength(0);
      // A negative (in-flight) stamp is never touched.
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: -SETUP_FEE });
      expect(await mockPg.transaction((trx) => parkSetupFeeStampForOffice(trx, { ...ctx, rawAmount: -SETUP_FEE }))).toBeNull();
      expect(Number((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee)).toBe(-SETUP_FEE);
      await mockPg('scheduled_services').where({ id: f.parentId }).update({ pending_setup_fee: SETUP_FEE });

      const parked = await mockPg.transaction((trx) => parkSetupFeeStampForOffice(trx, ctx));
      expect(parked).toMatchObject({ parentId: f.parentId, amount: SETUP_FEE, alertId: expect.any(String) });
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
      expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(0);
      expect(await mockPg('setup_fee_claims').where({ scheduled_service_id: f.parentId })).toHaveLength(0);
      const alerts = await officeFeeAlerts(f);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].payload).toMatchObject({ amount: SETUP_FEE, seriesId: f.parentId, estimateId: f.estimateId, customerId: f.customerId, origin: 'test' });
      // The detector reads the office-owned fee as covered, open or resolved.
      expect(await findUnmintedSetupFeeObligation(args, mockPg)).toMatchObject({ owed: false, deferredToFirstVisit: true });
      await mockPg('dispatch_alerts').where({ id: alerts[0].id }).update({ resolved_at: new Date() });
      expect(await findUnmintedSetupFeeObligation(args, mockPg)).toMatchObject({ owed: false, deferredToFirstVisit: true });
    } finally { await cleanup(f); }
  });

  test('hold -> parked for the office -> next completion: a stranded stamp is parked at the hold, so the setup fee is never billed by the system and never parked twice', async () => {
    const f = await seed();
    try {
      // Visit 1 completes on a lane that never runs the completion mint.
      await mockPg('customers').where({ id: f.customerId }).update({ billing_mode: 'monthly_membership', waveguard_tier: 'Bronze', monthly_rate: 45 });
      const first = await complete(f, f.parentId);
      expect(first).toMatchObject({ status: 200 });
      // The completion's obligation check found the stamp stranded and PARKED
      // it: the stamp is cleared, one owed-fee alert stands, NO invoice and no
      // claim were created, and nothing is parked for a second manual bill.
      expect((await mockPg('scheduled_services').where({ id: f.parentId }).first('pending_setup_fee')).pending_setup_fee).toBeNull();
      expect(await mockPg('invoices').where({ customer_id: f.customerId })).toHaveLength(0);
      expect(await mockPg('setup_fee_claims').whereIn('scheduled_service_id', [f.parentId, ...f.childIds])).toHaveLength(0);
      const alerts = await officeFeeAlerts(f);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].payload).toMatchObject({ amount: SETUP_FEE, seriesId: f.parentId, visitId: f.parentId });
      expect(await parkAlerts(f)).toHaveLength(0);
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();

      // The customer's lane flips to per-application; the next completion mints
      // its own invoice. A still-armed stamp would add a setup line.
      await mockPg('customers').where({ id: f.customerId }).update({ billing_mode: 'per_application' });
      await makeDue(f.childIds[0]);
      const next = await complete(f, f.childIds[0]);
      expect(next).toMatchObject({ status: 200 });
      const invoices = await mockPg('invoices').where({ customer_id: f.customerId });
      expect(invoices.flatMap(setupLines)).toHaveLength(0);
      expect(await mockPg('setup_fee_claims').whereIn('scheduled_service_id', [f.parentId, ...f.childIds])).toHaveLength(0);
      expect(await officeFeeAlerts(f)).toHaveLength(1);
      expect(await parkAlerts(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });
});
