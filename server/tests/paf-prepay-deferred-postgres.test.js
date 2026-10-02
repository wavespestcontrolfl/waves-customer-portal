// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Pay after the first visit, annual prepay (GATE_PAF_PREPAY, PR-D; owner
// rulings 2026-09-30 / 2026-10-01). The accept defers the year's charge: the
// durable job waits as 'awaiting_first_visit' and, until the year is paid,
// the plan's visits are held (covered), never billed per visit. The first
// PERFORMED visit releases the job; the sweep then charges the bound method
// for the acknowledged total or less (R1). A decline after visit 1 keeps the
// later visits held and rings the office (R2); no performed visit in 14 days
// rings the office (R8); a year voided before any visit charges nothing.
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
jest.mock('../services/stripe', () => ({
  chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => false),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => null),
}));
jest.mock('../services/weather-forecast', () => ({
  ...jest.requireActual('../services/weather-forecast'), getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
jest.mock('../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => {}) }));
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
jest.mock('../services/autopay-enrollment', () => ({
  ...jest.requireActual('../services/autopay-enrollment'),
  enrollConsentedMethod: jest.fn(async () => ({ enrolled: false, reason: 'already_enrolled' })),
}));
jest.mock('../services/payer', () => ({
  ...jest.requireActual('../services/payer'),
  resolveForInvoice: jest.fn(async () => ({ payerId: null })),
}));
jest.mock('../services/inspection-credit', () => ({
  ...jest.requireActual('../services/inspection-credit'),
  redeemInspectionCreditForBooking: jest.fn(async () => ({ redeemed: 0, reason: 'no_open_offer' })),
}));
jest.mock('../services/invoice', () => ({
  ...jest.requireActual('../services/invoice'),
  sendViaSMSAndEmail: jest.fn(async () => ({ ok: true, payUrl: '/pay/synthetic' })),
}));
// The real rule check runs on every alert (docs/admin-notifications.md), so an
// over-long headline or why fails here; only the write is faked.
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async (category, spec) => { actual.composeAdminAlert(spec); return { id: 'alert' }; }) };
});

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

const TOTAL_CENTS = 48000;

postgres('annual prepay charged after the first visit', () => {
  let database;
  let trx;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    process.env.RECURRING_CARD_ON_FILE = 'true';
    process.env.GATE_PREPAY_CARD_AND_CHARGE = 'true';
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
  afterAll(async () => {
    delete process.env.RECURRING_CARD_ON_FILE;
    delete process.env.GATE_PREPAY_CARD_AND_CHARGE;
    await database?.destroy();
  });

  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = (offset) => etDateString(addETDays(new Date(), offset));

  // An accepted annual-prepay estimate whose charge is deferred: a draft year
  // invoice, a payment_pending term, a first visit (series parent) and a
  // second visit (child), and the awaiting job bound to a saved card.
  async function deferredAccept({ jobPatch = {}, termStatus = 'payment_pending', invoiceStatus = 'draft', acceptedDaysAgo = 1 } = {}) {
    const f = {
      customerId: randomUUID(), estimateId: randomUUID(), invoiceId: randomUUID(), termId: randomUUID(),
      parentId: randomUUID(), childId: randomUUID(), pmId: randomUUID(), pmStripeId: `pm_${randomUUID().slice(0, 8)}`,
    };
    await trx('customers').insert({ id: f.customerId, first_name: 'Synthetic', last_name: 'Deferred', phone: '+12025550188',
      email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: true });
    await trx('payment_methods').insert({ id: f.pmId, customer_id: f.customerId, stripe_payment_method_id: f.pmStripeId,
      method_type: 'card', last_four: '4242', is_default: true });
    await trx('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, invoice_number: `TEST-${f.invoiceId.slice(0, 8)}`,
      token: randomUUID().replace(/-/g, ''), status: invoiceStatus, total: TOTAL_CENTS / 100, subtotal: TOTAL_CENTS / 100,
      due_date: day(-acceptedDaysAgo), line_items: JSON.stringify([{ description: 'Annual prepay', amount: TOTAL_CENTS / 100, quantity: 1 }]) });
    const authorizedAt = new Date(Date.now() - acceptedDaysAgo * 86400000).toISOString();
    const job = {
      invoice_id: f.invoiceId, stripe_payment_method_id: f.pmStripeId, payment_method_row_id: f.pmId,
      method_key: 'k', authorized_total_cents: TOTAL_CENTS, authorized_base_cents: TOTAL_CENTS,
      authorized_at: authorizedAt, scheduled_service_id: f.parentId, payer_scope_scheduled_service_id: f.parentId,
      status: 'awaiting_first_visit', deferred_to_first_visit: true, created_at: authorizedAt,
      consent_text_version: require('../services/payment-method-consent-text').CONSENT_VERSION,
      consent_variant_version: require('../services/payment-method-consent-text').AFTER_VISIT_CONSENT_VERSION, ...jobPatch,
    };
    await trx('estimates').insert({ id: f.estimateId, customer_id: f.customerId, status: 'accepted',
      estimate_data: JSON.stringify({ prepayAutoChargeJob: job }) });
    await trx('annual_prepay_terms').insert({ id: f.termId, customer_id: f.customerId, status: termStatus, source_estimate_id: f.estimateId,
      prepay_invoice_id: f.invoiceId, term_start: day(0), term_end: day(364), prepay_amount: TOTAL_CENTS / 100,
      plan_label: 'Synthetic Annual', coverage_service_type: 'Quarterly Pest Control', coverage_visit_count: 4 });
    await trx('scheduled_services').insert({ id: f.parentId, customer_id: f.customerId, service_type: 'Quarterly Pest Control',
      scheduled_date: day(0), window_start: '09:00', window_end: '10:00', status: 'confirmed', estimated_price: 120,
      source_estimate_id: f.estimateId });
    await trx('scheduled_services').insert({ id: f.childId, customer_id: f.customerId, service_type: 'Quarterly Pest Control',
      scheduled_date: day(90), window_start: '09:00', window_end: '10:00', status: 'confirmed', estimated_price: 120,
      recurring_parent_id: f.parentId });
    return f;
  }

  // Closeout as completion does it: a visit the waiting year holds is stamped
  // with that term (paf_held_term_id) before it is marked done.
  async function perform(visitId, customerId, outcome = 'completed', notes = {}) {
    const visitRow = await trx('scheduled_services').where({ id: visitId }).first();
    const heldTerm = await require('../services/annual-prepay-renewals').pafDeferredHoldingTerm(visitRow, trx, { throwOnError: true });
    if (heldTerm) await trx('scheduled_services').where({ id: visitId }).update({ paf_held_term_id: heldTerm.id });
    await trx('scheduled_services').where({ id: visitId }).update({ status: 'completed', completed_at: new Date() });
    await trx('service_records').insert({ id: randomUUID(), customer_id: customerId, scheduled_service_id: visitId,
      service_type: 'Quarterly Pest Control', service_date: day(0), status: 'completed',
      structured_notes: JSON.stringify({ visitOutcome: outcome, ...notes }) });
  }

  const jobOf = async (f) => {
    const row = await trx('estimates').where({ id: f.estimateId }).first('estimate_data');
    const data = typeof row.estimate_data === 'string' ? JSON.parse(row.estimate_data) : row.estimate_data;
    return data.prepayAutoChargeJob;
  };
  const covers = (visitId) => trx('scheduled_services').where({ id: visitId }).first()
    .then((visit) => require('../services/annual-prepay-renewals').annualPrepayCoversVisit(visit, trx, { throwOnError: true }));
  const release = () => require('../services/paf-prepay-release').releaseDeferredPrepayCharges();
  const sweep = () => require('../services/recurring-card-on-file').sweepStrandedPrepayAutoCharges();

  describe('holding the plan\'s visits until the year is paid', () => {
    it('holds the first visit and a later child while the job waits', async () => {
      const f = await deferredAccept();
      expect(await covers(f.parentId)).toBe(true);
      expect(await covers(f.childId)).toBe(true);
    });

    it('keeps holding while the year sits with a third-party payer, unpaid', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'skipped', reason: 'payer_billed' } });
      expect(await covers(f.childId)).toBe(true);
      const voided = await deferredAccept({ jobPatch: { status: 'skipped', reason: 'invoice_void' } });
      expect(await covers(voided.childId)).toBe(false);
    });

    it('keeps holding later visits after a declined charge (R2)', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'delivered_fallback' } });
      expect(await covers(f.childId)).toBe(true);
    });

    it('bills normally once the job is cancelled, when the accept was not deferred, or when the job names another invoice', async () => {
      const cancelled = await deferredAccept({ jobPatch: { status: 'cancelled_before_visit' } });
      expect(await covers(cancelled.parentId)).toBe(false);
      const chargeNow = await deferredAccept({ jobPatch: { deferred_to_first_visit: false, status: 'pending' } });
      expect(await covers(chargeNow.parentId)).toBe(false);
      const otherInvoice = await deferredAccept({ jobPatch: { invoice_id: randomUUID() } });
      expect(await covers(otherInvoice.parentId)).toBe(false);
    });

    it('stops holding once a dispute suspends the paid year back to payment_pending', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'paid' } });
      await trx('annual_prepay_terms').where({ id: f.termId }).update({ dispute_suspended_at: new Date() });
      expect(await covers(f.childId)).toBe(false);
    });

    it('stops holding once the year invoice is voided, even before the term catches up', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'delivered_fallback' } });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      expect(await covers(f.childId)).toBe(false);
    });

    it('holds only the visits the year bought: an extra visit past the sold count bills', async () => {
      const f = await deferredAccept();
      await trx('annual_prepay_terms').where({ id: f.termId }).update({ coverage_visit_count: 1 });
      expect(await covers(f.parentId)).toBe(true);
      expect(await covers(f.childId)).toBe(false);
    });

    it('billing previews see the hold the completion applies', async () => {
      const f = await deferredAccept();
      const { annualCoverageVerdictForPrediction } = require('../services/annual-prepay-renewals');
      const visit = await trx('scheduled_services').where({ id: f.childId }).first();
      expect(await annualCoverageVerdictForPrediction(visit, trx)).toBe(true);
      const { deferredPrepayHoldCustomerIds } = require('../services/annual-prepay-renewals');
      const ids = await deferredPrepayHoldCustomerIds(trx, [f.customerId, randomUUID()]);
      expect([...ids]).toEqual([f.customerId]);
      expect(await annualCoverageVerdictForPrediction(visit, trx, { deferredCustomerIds: ids })).toBe(true);
      expect(await annualCoverageVerdictForPrediction(visit, trx, { deferredCustomerIds: new Set() })).toBeNull();
      await trx('estimates').where({ id: f.estimateId }).update({ estimate_data: JSON.stringify({}) });
      expect(await annualCoverageVerdictForPrediction(visit, trx)).toBeNull();
    });

    it('never holds a visit of a service the term does not cover', async () => {
      const f = await deferredAccept();
      await trx('scheduled_services').where({ id: f.childId }).update({ service_type: 'Lawn Fertilization' });
      expect(await covers(f.childId)).toBe(false);
    });
  });

  it('completing the first visit while the charge waits bills nothing for the visit', async () => {
    const f = await deferredAccept();
    const techId = randomUUID();
    const catalogId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Technician', role: 'technician', active: true });
    await trx('services').insert({ id: catalogId, name: 'Quarterly Pest Control', service_key: `synthetic_${catalogId}`, is_active: true });
    await trx('scheduled_services').where({ id: f.parentId })
      .update({ technician_id: techId, service_id: catalogId, create_invoice_on_complete: true, estimated_duration_minutes: 60 });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    await completeScheduledService({ serviceId: f.parentId, idempotencyKey: randomUUID(),
      actor: { techRole: 'admin', technicianId: techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false } });
    expect((await trx('scheduled_services').where({ id: f.parentId }).first('status')).status).toBe('completed');
    expect(await trx('invoices').where({ scheduled_service_id: f.parentId })).toEqual([]);
    expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(await release()).toMatchObject({ released: 1 });
  });

  it('a failed deferred-hold read leaves the closeout unfinished, never a per-visit bill', async () => {
    const f = await deferredAccept();
    const techId = randomUUID();
    const catalogId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Technician', role: 'technician', active: true });
    await trx('services').insert({ id: catalogId, name: 'Quarterly Pest Control', service_key: `synthetic_${catalogId}`, is_active: true });
    await trx('scheduled_services').where({ id: f.parentId })
      .update({ technician_id: techId, service_id: catalogId, create_invoice_on_complete: true, estimated_duration_minutes: 60 });
    const renewals = require('../services/annual-prepay-renewals');
    const spy = jest.spyOn(renewals, 'pafDeferredHoldingTerm').mockRejectedValueOnce(new Error('synthetic read failure'));
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    const result = await completeScheduledService({ serviceId: f.parentId, idempotencyKey: randomUUID(),
      actor: { techRole: 'admin', technicianId: techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false } });
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('deferred_prepay_lookup_failed');
    expect(await trx('invoices').where({ scheduled_service_id: f.parentId })).toEqual([]);
    spy.mockRestore();
  });

  it('completion stamps the held visit, and a closeout resumed after the year is paid stays covered (owner ruling: stamp + narrow)', async () => {
    const f = await deferredAccept();
    const techId = randomUUID();
    const catalogId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Technician', role: 'technician', active: true });
    await trx('services').insert({ id: catalogId, name: 'Quarterly Pest Control', service_key: `synthetic_${catalogId}`, is_active: true });
    await trx('scheduled_services').where({ id: f.parentId })
      .update({ technician_id: techId, service_id: catalogId, create_invoice_on_complete: true, estimated_duration_minutes: 60 });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    await completeScheduledService({ serviceId: f.parentId, idempotencyKey: randomUUID(),
      actor: { techRole: 'admin', technicianId: techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false } });
    expect((await trx('scheduled_services').where({ id: f.parentId }).first('paf_held_term_id')).paf_held_term_id).toBe(f.termId);
    expect(await trx('invoices').where({ scheduled_service_id: f.parentId })).toEqual([]);
    // The year is paid and activated: the live hold ends, the stamp still covers.
    await trx('invoices').where({ id: f.invoiceId }).update({ status: 'paid' });
    await trx('annual_prepay_terms').where({ id: f.termId }).update({ status: 'active' });
    expect(await covers(f.parentId)).toBe(true);
    // A reader whose query never selected the stamp (billing recovery's
    // narrow visit row) still sees it, through the prediction verdict too.
    const renewals = require('../services/annual-prepay-renewals');
    const narrow = { id: f.parentId, customer_id: f.customerId, service_type: 'Quarterly Pest Control' };
    expect(await renewals.annualCoverageVerdictForPrediction(narrow, trx, { deferredCustomerIds: new Set() })).toBe(true);
    // A paid year cancelled to end at term rides out its window (coveredTermsAsOf).
    await trx('annual_prepay_terms').where({ id: f.termId }).update({ status: 'cancelled', renewal_decision: 'cancel' });
    expect(await covers(f.parentId)).toBe(true);
    // A year voided after the fact no longer covers the stamped visit.
    await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
    expect(await covers(f.parentId)).toBe(false);
  });

  it('a closeout that finishes after the year was charged and activated is stamped and bills nothing (Codex r14)', async () => {
    const f = await deferredAccept({ jobPatch: { status: 'paid' } });
    await trx('invoices').where({ id: f.invoiceId }).update({ status: 'paid', paid_at: new Date() });
    await trx('annual_prepay_terms').where({ id: f.termId }).update({ status: 'active' });
    const techId = randomUUID();
    const catalogId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Technician', role: 'technician', active: true });
    await trx('services').insert({ id: catalogId, name: 'Quarterly Pest Control', service_key: `synthetic_${catalogId}`, is_active: true });
    await trx('scheduled_services').where({ id: f.parentId })
      .update({ technician_id: techId, service_id: catalogId, create_invoice_on_complete: true, estimated_duration_minutes: 60 });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    await completeScheduledService({ serviceId: f.parentId, idempotencyKey: randomUUID(),
      actor: { techRole: 'admin', technicianId: techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false } });
    expect((await trx('scheduled_services').where({ id: f.parentId }).first('paf_held_term_id')).paf_held_term_id).toBe(f.termId);
    expect(await trx('invoices').where({ scheduled_service_id: f.parentId })).toEqual([]);
  });

  it('a reopened held visit closed again as paid another way loses its stamp (Codex r16)', async () => {
    const f = await deferredAccept();
    const techId = randomUUID();
    const catalogId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Technician', role: 'technician', active: true });
    await trx('services').insert({ id: catalogId, name: 'Quarterly Pest Control', service_key: `synthetic_${catalogId}`, is_active: true });
    await trx('scheduled_services').where({ id: f.parentId }).update({ paf_held_term_id: f.termId, prepaid_method: 'cash', prepaid_amount: 120,
      technician_id: techId, service_id: catalogId, create_invoice_on_complete: true, estimated_duration_minutes: 60 });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    await completeScheduledService({ serviceId: f.parentId, idempotencyKey: randomUUID(),
      actor: { techRole: 'admin', technicianId: techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false } });
    expect((await trx('scheduled_services').where({ id: f.parentId }).first('paf_held_term_id')).paf_held_term_id).toBeNull();
  });

  it('a reopened visit completed again re-decides its stamp, never trusting a stale one (Codex r15)', async () => {
    const f = await deferredAccept();
    const techId = randomUUID();
    const catalogId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Synthetic Technician', role: 'technician', active: true });
    await trx('services').insert({ id: catalogId, name: 'Mosquito Control', service_key: `synthetic_${catalogId}`, is_active: true });
    // Stamped by an earlier closeout, then reopened and moved off the sold
    // coverage (a service the term does not cover).
    await trx('scheduled_services').where({ id: f.parentId }).update({ paf_held_term_id: f.termId, service_type: 'Mosquito Control',
      technician_id: techId, service_id: catalogId, create_invoice_on_complete: true, estimated_duration_minutes: 60 });
    const { completeScheduledService } = require('../services/complete-scheduled-service');
    await completeScheduledService({ serviceId: f.parentId, idempotencyKey: randomUUID(),
      actor: { techRole: 'admin', technicianId: techId, technician: null },
      body: { customerRecap: 'done', visitOutcome: 'completed', products: [], areasTreated: [], sendCompletionSms: false, requestReview: false } });
    expect((await trx('scheduled_services').where({ id: f.parentId }).first('paf_held_term_id')).paf_held_term_id).toBeNull();
  });

  describe('the first visit\'s completion text (owner ruling 2026-10-02)', () => {
    async function completeWithText(f, visitId, visitOutcome = 'completed') {
      const techId = randomUUID();
      const catalogId = randomUUID();
      await trx('technicians').insert({ id: techId, name: 'Synthetic Technician', role: 'technician', active: true });
      await trx('services').insert({ id: catalogId, name: 'Quarterly Pest Control', service_key: `synthetic_${catalogId}`, is_active: true });
      await trx('scheduled_services').where({ id: visitId })
        .update({ technician_id: techId, service_id: catalogId, create_invoice_on_complete: true, estimated_duration_minutes: 60 });
      const send = require('../services/messaging/send-customer-message').sendCustomerMessage;
      send.mockClear();
      send.mockResolvedValue({ sent: true, sid: 'SM_synthetic' });
      const { completeScheduledService } = require('../services/complete-scheduled-service');
      await completeScheduledService({ serviceId: visitId, idempotencyKey: randomUUID(),
        actor: { techRole: 'admin', technicianId: techId, technician: null },
        body: { customerRecap: 'done', visitOutcome, products: [], areasTreated: [], sendCompletionSms: true, requestReview: false } });
      return send.mock.calls.map((c) => c[0]?.body || '').join('\n');
    }

    it('the visit that releases the year says it is being charged now', async () => {
      const f = await deferredAccept();
      const text = await completeWithText(f, f.parentId);
      expect(text).toMatch(/Your Waves annual plan payment of \$480\.00 is being charged to your card on file now - receipt to follow\./);
      expect(text).not.toMatch(/nothing due today/);
    });

    it('account credit that lowers the charge makes the amount a ceiling (R1)', async () => {
      const f = await deferredAccept();
      await trx('customers').where({ id: f.customerId }).update({ auto_apply_account_credit: true, account_credits: 100 });
      const text = await completeWithText(f, f.parentId);
      expect(text).toMatch(/payment of up to \$480\.00 is being charged/);
    });

    it('account credit that covers the year keeps the "nothing due" text', async () => {
      const f = await deferredAccept();
      await trx('customers').where({ id: f.customerId }).update({ auto_apply_account_credit: true, account_credits: 1000 });
      const text = await completeWithText(f, f.parentId);
      expect(text).not.toMatch(/being charged/);
      expect(text).toMatch(/nothing (is )?due today/);
    });

    it('a second held visit done before the release pass keeps the regular text', async () => {
      const f = await deferredAccept();
      const facts = async (id) => require('../services/paf-prepay-release')
        .firstChargeCompletionFacts(await trx('scheduled_services').where({ id }).first(), trx);
      await trx('scheduled_services').where({ id: f.childId }).update({ paf_held_term_id: f.termId });
      expect(await facts(f.childId)).toMatchObject({ amount: '$480.00' });
      await perform(f.parentId, f.customerId);
      expect(await facts(f.childId)).toBeNull();
    });

    it('the announcement is reserved for one visit, and a year already paid gets none (Codex r9)', async () => {
      const facts = async (id) => require('../services/paf-prepay-release')
        .firstChargeCompletionFacts(await trx('scheduled_services').where({ id }).first(), trx);
      const f = await deferredAccept();
      await trx('scheduled_services').whereIn('id', [f.parentId, f.childId]).update({ paf_held_term_id: f.termId });
      expect(await facts(f.parentId)).toMatchObject({ amount: '$480.00' });
      expect(await facts(f.parentId)).toMatchObject({ amount: '$480.00' });
      expect(await facts(f.childId)).toBeNull();
      const paid = await deferredAccept({ invoiceStatus: 'paid' });
      await trx('scheduled_services').where({ id: paid.parentId }).update({ paf_held_term_id: paid.termId });
      expect(await facts(paid.parentId)).toBeNull();
      const unstamped = await deferredAccept();
      expect(await facts(unstamped.parentId)).toBeNull();
    });

    it('credit already applied to the year bill makes the amount a ceiling, even with no balance left (Codex r12)', async () => {
      const facts = async (id) => require('../services/paf-prepay-release')
        .firstChargeCompletionFacts(await trx('scheduled_services').where({ id }).first(), trx);
      const f = await deferredAccept();
      await trx('scheduled_services').where({ id: f.parentId }).update({ paf_held_term_id: f.termId });
      await trx('invoices').where({ id: f.invoiceId }).update({ credit_applied: 50 });
      expect(await facts(f.parentId)).toMatchObject({ amount: 'up to $480.00' });
    });

    it('a legacy bank alias reads as a saved bank account (Codex r13)', async () => {
      const facts = async (id) => require('../services/paf-prepay-release')
        .firstChargeCompletionFacts(await trx('scheduled_services').where({ id }).first(), trx);
      const f = await deferredAccept();
      await trx('scheduled_services').where({ id: f.parentId }).update({ paf_held_term_id: f.termId });
      await trx('payment_methods').where({ id: f.pmId }).update({ method_type: 'bank_account' });
      expect(await facts(f.parentId)).toMatchObject({ methodLine: 'saved bank account' });
    });

    it('a different Auto Pay method than the bound one keeps the regular text (Codex r15)', async () => {
      const facts = async (id) => require('../services/paf-prepay-release')
        .firstChargeCompletionFacts(await trx('scheduled_services').where({ id }).first(), trx);
      const f = await deferredAccept();
      await trx('scheduled_services').where({ id: f.parentId }).update({ paf_held_term_id: f.termId });
      const otherPm = randomUUID();
      await trx('payment_methods').insert({ id: otherPm, customer_id: f.customerId, stripe_payment_method_id: `pm_${otherPm.slice(0, 8)}`, method_type: 'card', last_four: '1111' });
      await trx('customers').where({ id: f.customerId }).update({ autopay_payment_method_id: otherPm });
      expect(await facts(f.parentId)).toBeNull();
    });

    it('a charge the sweep will not take automatically keeps the regular text (Codex r8)', async () => {
      const removed = await deferredAccept();
      await trx('payment_methods').where({ id: removed.pmId }).del();
      expect(await completeWithText(removed, removed.parentId)).not.toMatch(/being charged/);
      const optedOut = await deferredAccept();
      await trx('autopay_log').insert({ customer_id: optedOut.customerId, event_type: 'autopay_disabled', created_at: new Date() });
      expect(await completeWithText(optedOut, optedOut.parentId)).not.toMatch(/being charged/);
    });

    it('a later visit of a year already released keeps the regular text', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'pending' } });
      const text = await completeWithText(f, f.childId);
      expect(text).not.toMatch(/being charged/);
    });
  });

  describe('releasing the charge after the first performed visit', () => {
    it('leaves the job waiting while no visit is performed, and for an inspection-only visit', async () => {
      const f = await deferredAccept();
      expect(await release()).toMatchObject({ released: 0 });
      await perform(f.parentId, f.customerId, 'inspection_only');
      expect(await release()).toMatchObject({ released: 0 });
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
    });

    it('releases once on a performed visit and brings the invoice due today', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      expect(await release()).toMatchObject({ released: 1 });
      expect(await release()).toMatchObject({ released: 0 });
      const job = await jobOf(f);
      expect(job).toMatchObject({ status: 'pending', released_for_visit_id: f.parentId });
      // A DATE column read as text: a Date parsed at the server's midnight
      // would shift a day under a UTC CI clock.
      const invoice = await trx('invoices').where({ id: f.invoiceId }).first(trx.raw('due_date::text as due_date'));
      expect(invoice.due_date).toBe(day(0));
    });

    it('reaches a performed job behind a full page of jobs still waiting', async () => {
      const waiting = [];
      for (let i = 0; i < 3; i += 1) waiting.push(await deferredAccept());
      const performed = await deferredAccept();
      await perform(performed.parentId, performed.customerId);
      const summary = await require('../services/paf-prepay-release').releaseDeferredPrepayCharges({ pageSize: 2 });
      expect(summary).toMatchObject({ scanned: 4, released: 1 });
      expect((await jobOf(performed)).status).toBe('pending');
      for (const f of waiting) expect((await jobOf(f)).status).toBe('awaiting_first_visit');
    });

    it('a card payment still processing before any visit does not release the job', async () => {
      const f = await deferredAccept({ invoiceStatus: 'processing' });
      await trx('invoices').where({ id: f.invoiceId }).update({ payment_method: 'card' });
      expect(await release()).toMatchObject({ released: 0 });
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
      const bank = await deferredAccept({ invoiceStatus: 'processing' });
      await trx('invoices').where({ id: bank.invoiceId }).update({ payment_method: 'us_bank_account' });
      await release();
      expect((await jobOf(bank)).status).toBe('pending');
    });

    it('a quiet backfill closeout never releases the charge', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId, 'completed', { backfill: true });
      expect(await release()).toMatchObject({ released: 0 });
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
    });

    it('waits while the visit\'s completion billing is still finishing', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      const attemptId = randomUUID();
      await trx('service_completion_attempts').insert({ id: attemptId, service_id: f.parentId, idempotency_key: `k-${attemptId}`, status: 'side_effects_pending' });
      expect(await release()).toMatchObject({ released: 0 });
      await trx('service_completion_attempts').where({ id: attemptId }).update({ status: 'succeeded' });
      expect(await release()).toMatchObject({ released: 1 });
    });

    it('a bank debit returned between the first read and the lock does not release without a visit', async () => {
      const f = await deferredAccept({ invoiceStatus: 'processing' });
      await trx('invoices').where({ id: f.invoiceId }).update({ payment_method: 'us_bank_account' });
      const dbModule = require('../models/db');
      const spy = jest.spyOn(dbModule, 'transaction').mockImplementationOnce(async (fn) => {
        // The payment-failed webhook reopens the invoice just before the lock.
        await trx('invoices').where({ id: f.invoiceId }).update({ status: 'sent' });
        return trx.transaction(fn);
      });
      expect(await release()).toMatchObject({ released: 0 });
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
      spy.mockRestore();
    });

    it('a performed visit outside the sold coverage never releases the year', async () => {
      const f = await deferredAccept();
      await trx('annual_prepay_terms').where({ id: f.termId }).update({ coverage_visit_count: 1 });
      await perform(f.childId, f.customerId);
      expect(await release()).toMatchObject({ released: 0 });
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
      await perform(f.parentId, f.customerId);
      expect(await release()).toMatchObject({ released: 1 });
      expect(await jobOf(f)).toMatchObject({ released_for_visit_id: f.parentId, payer_scope_scheduled_service_id: f.parentId });
    });

    it('releases on a performed child visit of the series', async () => {
      const f = await deferredAccept();
      await perform(f.childId, f.customerId);
      expect(await release()).toMatchObject({ released: 1 });
      // The sweep's payer checks judge the visit that released the charge.
      expect(await jobOf(f)).toMatchObject({ released_for_visit_id: f.childId, payer_scope_scheduled_service_id: f.childId });
    });

    it('charges nothing when the year invoice was voided before any visit', async () => {
      const f = await deferredAccept({ invoiceStatus: 'void' });
      expect(await release()).toMatchObject({ cancelled: 1 });
      expect((await jobOf(f))).toMatchObject({ status: 'cancelled_before_visit', reason: 'invoice_void' });
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    it('rings the office once when no visit is performed within 14 days, and closes it once the job moves on (R8)', async () => {
      const f = await deferredAccept({ acceptedDaysAgo: 15 });
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      const episodes = require('../services/admin-alert-episodes');
      const closeSpy = jest.spyOn(episodes, 'closeAdminAlertKeys');
      expect(await release()).toMatchObject({ staleReserved: 1 });
      expect(await release()).toMatchObject({ staleReserved: 0 });
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      expect(raiseAdminAlert.mock.calls[0][1]).toMatchObject({ area: 'Billing', subject: { type: 'estimate', id: f.estimateId } });
      await perform(f.parentId, f.customerId);
      closeSpy.mockRejectedValueOnce(new Error('synthetic close failure'));
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'pending' });
      expect(await jobOf(f)).not.toHaveProperty('stale_alert_closed_at');
      await release();
      expect(closeSpy).toHaveBeenCalledTimes(2);
      expect(await jobOf(f)).toHaveProperty('stale_alert_closed_at');
      closeSpy.mockRestore();
    });

    it('a no-visit alert reserved just before a release is still closed', async () => {
      const f = await deferredAccept({ jobPatch: { stale_alert_reserved_at: new Date().toISOString() } });
      await perform(f.parentId, f.customerId);
      const episodes = require('../services/admin-alert-episodes');
      const closeSpy = jest.spyOn(episodes, 'closeAdminAlertKeys');
      await release();
      expect(closeSpy).toHaveBeenCalledWith(expect.anything(), [`paf-prepay-no-first-visit:${f.estimateId}`], 'resolved', expect.anything());
      expect(await jobOf(f)).toHaveProperty('stale_alert_closed_at');
      closeSpy.mockRestore();
    });

    it('a year cancelled after the first visit was performed rings the office to bill that visit', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_after_visit', performed_visit_id: f.parentId });
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      expect(raiseAdminAlert).toHaveBeenCalledWith('billing', expect.objectContaining({ subject: { type: 'visit', id: f.parentId } }),
        { dedupeKey: `paf-prepay-cancelled-after-visit:${f.estimateId}` });
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    it('waits while another visit of the plan is still finishing its completion (pre-push audit P0)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      const attemptId = randomUUID();
      await trx('service_completion_attempts').insert({ id: attemptId, service_id: f.childId, idempotency_key: `k-${attemptId}`, status: 'side_effects_running' });
      expect(await release()).toMatchObject({ released: 0 });
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
      await trx('service_completion_attempts').where({ id: attemptId }).update({ status: 'succeeded' });
      expect(await release()).toMatchObject({ released: 1 });
    });

    it('a crashed closeout that already stamped its visit still reaches the office when the year dies (pre-push audit)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      const attemptId = randomUUID();
      await trx('service_completion_attempts').insert({ id: attemptId, service_id: f.parentId, idempotency_key: `k-${attemptId}`, status: 'side_effects_running',
        updated_at: new Date(Date.now() - 30 * 60 * 1000) });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_after_visit', performed_visit_id: f.parentId });
    });

    it('a visit reopened and closed again as inspection only no longer counts as performed (pre-push audit)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      await trx('service_records').insert({ id: randomUUID(), customer_id: f.customerId, scheduled_service_id: f.parentId,
        service_type: 'Quarterly Pest Control', service_date: day(0), status: 'completed',
        structured_notes: JSON.stringify({ visitOutcome: 'inspection_only' }), created_at: new Date(Date.now() + 1000) });
      expect(await release()).toMatchObject({ released: 0 });
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
    });

    it('an abandoned closeout attempt past the stale window never blocks the release (Codex r15)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      const attemptId = randomUUID();
      await trx('service_completion_attempts').insert({ id: attemptId, service_id: f.childId, idempotency_key: `k-${attemptId}`, status: 'pending',
        updated_at: new Date(Date.now() - 30 * 60 * 1000) });
      expect(await release()).toMatchObject({ released: 1 });
    });

    it('a year voided while a held closeout is still finishing waits for it (pre-push audit P1)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      const attemptId = randomUUID();
      await trx('service_completion_attempts').insert({ id: attemptId, service_id: f.parentId, idempotency_key: `k-${attemptId}`, status: 'side_effects_running' });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
      await trx('service_completion_attempts').where({ id: attemptId }).update({ status: 'succeeded' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_after_visit', performed_visit_id: f.parentId });
    });

    it('a dead year never sends the office a visit already paid another way (Codex r10)', async () => {
      const f = await deferredAccept();
      await trx('scheduled_services').where({ id: f.parentId }).update({ prepaid_method: 'cash', prepaid_amount: 120 });
      await perform(f.parentId, f.customerId);
      expect((await trx('scheduled_services').where({ id: f.parentId }).first('paf_held_term_id')).paf_held_term_id).toBeNull();
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_before_visit', reason: 'invoice_void' });
    });

    it('a dead year never sends the office a visit it did not hold (a service the term does not cover)', async () => {
      const f = await deferredAccept();
      const otherId = randomUUID();
      await trx('scheduled_services').insert({ id: otherId, customer_id: f.customerId, service_type: 'Mosquito Control',
        scheduled_date: day(0), window_start: '11:00', window_end: '12:00', status: 'confirmed', estimated_price: 90,
        source_estimate_id: f.estimateId });
      await perform(otherId, f.customerId);
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_before_visit', reason: 'invoice_void' });
    });

    it('a visit billed to a payer assigned after the accept is not held and never releases the year (Codex r9)', async () => {
      const f = await deferredAccept();
      const payer = require('../services/payer');
      payer.resolveForInvoice.mockImplementation(async ({ scheduledServiceId }) => ({ payerId: scheduledServiceId === f.parentId ? 7 : null }));
      try {
        expect(await covers(f.parentId)).toBe(false);
        expect(await covers(f.childId)).toBe(true);
        await perform(f.parentId, f.customerId);
        expect(await release()).toMatchObject({ released: 0 });
        expect((await jobOf(f)).status).toBe('awaiting_first_visit');
      } finally {
        payer.resolveForInvoice.mockImplementation(async () => ({ payerId: null }));
      }
    });

    it('a deleted year invoice still hands the office the held visit already done (Codex r9)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      await trx('annual_prepay_terms').where({ id: f.termId }).update({ prepay_invoice_id: null });
      await trx('invoices').where({ id: f.invoiceId }).del();
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_after_visit', reason: 'invoice_missing', performed_visit_id: f.parentId });
    });

    it('a failed due-date update leaves the job waiting for the next pass', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      await trx.raw('SAVEPOINT due_fail');
      await trx.raw(`CREATE OR REPLACE FUNCTION paf_test_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$ LANGUAGE plpgsql`);
      await trx.raw('CREATE TRIGGER paf_test_fail BEFORE UPDATE OF due_date ON invoices FOR EACH ROW EXECUTE FUNCTION paf_test_fail()');
      expect(await release()).toMatchObject({ released: 0 });
      // The failed statement aborted the test transaction: undo to the
      // savepoint (dropping the trigger) and read what the pass left.
      await trx.raw('ROLLBACK TO SAVEPOINT due_fail');
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
      expect(await release()).toMatchObject({ released: 1 });
    });
  });

  describe('the charge after release', () => {
    it('charges the bound card with the acknowledged total as a ceiling, not an exact match (R1)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      const StripeService = require('../services/stripe');
      StripeService.chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId) => {
        await trx('invoices').where({ id: invoiceId }).update({ status: 'paid' });
        return { ok: true };
      });
      await sweep();
      expect(StripeService.chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      const [invoiceId, pmRowId, opts] = StripeService.chargeInvoiceWithSavedCard.mock.calls[0];
      expect([invoiceId, pmRowId]).toEqual([f.invoiceId, f.pmId]);
      expect(opts.maxAuthorizedTotalCents).toBe(TOTAL_CENTS);
      expect(opts).not.toHaveProperty('expectedTotal');
      expect((await jobOf(f)).status).toBe('paid');
      const consent = await trx('payment_method_consents').where({ customer_id: f.customerId }).first('consent_text_version', 'consent_text_snapshot');
      const ConsentText = require('../services/payment-method-consent-text');
      expect(consent.consent_text_snapshot).toBe(ConsentText.AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT);
      expect(consent.consent_text_version).toBe(ConsentText.AFTER_VISIT_CONSENT_VERSION);
    });

    it('consent text changed while the job waited: charges on the customer\'s own after-visit row, never a pay link', async () => {
      const ConsentText = require('../services/payment-method-consent-text');
      const f = await deferredAccept({ jobPatch: { consent_text_version: 'v0_synthetic_old' } });
      await trx('payment_method_consents').insert({ customer_id: f.customerId, stripe_payment_method_id: f.pmStripeId,
        source: 'estimate_accept', consent_text_version: ConsentText.AFTER_VISIT_CONSENT_VERSION,
        consent_text_snapshot: ConsentText.AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT, created_at: new Date() });
      await perform(f.parentId, f.customerId);
      const StripeService = require('../services/stripe');
      StripeService.chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId) => {
        await trx('invoices').where({ id: invoiceId }).update({ status: 'paid' });
        return { ok: true };
      });
      await sweep();
      expect(StripeService.chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect((await jobOf(f)).status).toBe('paid');
    });

    it('after-visit text changed while the job waited (bundle still current): charges only on the row recorded under the attested text (Codex r11)', async () => {
      const ConsentText = require('../services/payment-method-consent-text');
      const withRow = await deferredAccept({ jobPatch: { consent_variant_version: 'v0_old_after_visit' } });
      await trx('payment_method_consents').insert({ customer_id: withRow.customerId, stripe_payment_method_id: withRow.pmStripeId,
        source: 'estimate_accept', consent_text_version: 'v0_old_after_visit',
        consent_text_snapshot: ConsentText.AFTER_VISIT_PREPAY_CARD_CONSENT_TEXT, created_at: new Date() });
      await perform(withRow.parentId, withRow.customerId);
      const StripeService = require('../services/stripe');
      StripeService.chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId) => {
        await trx('invoices').where({ id: invoiceId }).update({ status: 'paid' });
        return { ok: true };
      });
      await sweep();
      expect(StripeService.chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      // No current-version snapshot was manufactured for that customer.
      const rows = await trx('payment_method_consents').where({ customer_id: withRow.customerId }).select('consent_text_version');
      expect(rows.map((r) => r.consent_text_version)).toEqual(['v0_old_after_visit']);
      StripeService.chargeInvoiceWithSavedCard.mockClear();
      const without = await deferredAccept({ jobPatch: { consent_variant_version: 'v0_old_after_visit' } });
      await perform(without.parentId, without.customerId);
      await sweep();
      expect(StripeService.chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });

    it('consent text changed and no after-visit row on record: pay link, never a charge', async () => {
      const f = await deferredAccept({ jobPatch: { consent_text_version: 'v0_synthetic_old' } });
      await perform(f.parentId, f.customerId);
      await sweep();
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect((await jobOf(f)).status).not.toBe('paid');
    });

    it('a first visit reopened after the release sends the job back to wait, never a charge or pay link (Codex r13)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      expect(await release()).toMatchObject({ released: 1 });
      await trx('scheduled_services').where({ id: f.parentId }).update({ status: 'confirmed' });
      const charge = require('../services/stripe').chargeInvoiceWithSavedCard;
      await require('../services/recurring-card-on-file').sweepStrandedPrepayAutoCharges();
      expect(charge).not.toHaveBeenCalled();
      expect(await jobOf(f)).toMatchObject({ status: 'awaiting_first_visit' });
      expect((await jobOf(f)).released_for_visit_id).toBeNull();
      expect(require('../services/invoice').sendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    it('a first visit reopened between the preflight and the charge lock requeues the job, never a pay link (pre-push audit)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      expect(await release()).toMatchObject({ released: 1 });
      const StripeService = require('../services/stripe');
      StripeService.chargeInvoiceWithSavedCard.mockRejectedValueOnce(
        Object.assign(new Error('The visit is no longer completed. Review before charging.'), { code: 'VISIT_NOT_COMPLETED' }));
      await sweep();
      expect(StripeService.chargeInvoiceWithSavedCard).toHaveBeenCalledWith(f.invoiceId, f.pmId, expect.objectContaining({ requireCompletedVisit: true, requirePerformedVisit: true }));
      expect(await jobOf(f)).toMatchObject({ status: 'awaiting_first_visit', released_for_visit_id: null });
      expect(require('../services/invoice').sendViaSMSAndEmail).not.toHaveBeenCalled();
    });

    it('a released first visit re-closed as declined before the charge sends the job back to wait (pre-push audit)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      expect(await release()).toMatchObject({ released: 1 });
      await trx('service_records').insert({ id: randomUUID(), customer_id: f.customerId, scheduled_service_id: f.parentId,
        service_type: 'Quarterly Pest Control', service_date: day(0), status: 'completed',
        structured_notes: JSON.stringify({ visitOutcome: 'customer_declined' }), created_at: new Date(Date.now() + 1000) });
      await sweep();
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
    });

    it('a year settled before any visit whose payment came back is never charged before a visit (pre-push audit P0)', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'pending', released_for_visit_id: null } });
      await sweep();
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(await jobOf(f)).toMatchObject({ status: 'awaiting_first_visit', charge_returned: true });
    });

    it('a closeout that starts after the release holds the charge until it finishes (Codex r13)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      expect(await release()).toMatchObject({ released: 1 });
      const attemptId = randomUUID();
      await trx('service_completion_attempts').insert({ id: attemptId, service_id: f.childId, idempotency_key: `k-${attemptId}`, status: 'pending' });
      const charge = require('../services/stripe').chargeInvoiceWithSavedCard;
      await require('../services/recurring-card-on-file').sweepStrandedPrepayAutoCharges();
      expect(charge).not.toHaveBeenCalled();
      expect((await jobOf(f)).status).toBe('awaiting_first_visit');
    });

    it('a failed R2 alert is raised on the next pass; none is raised once the year is paid', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      require('../services/stripe').chargeInvoiceWithSavedCard.mockRejectedValue(new Error('Your card was declined.'));
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      // notifyAdmin's own failure mode: a null return, not a throw.
      raiseAdminAlert.mockResolvedValueOnce(null);
      await sweep();
      expect((await jobOf(f)).status).toBe('delivered_fallback');
      expect(await jobOf(f)).not.toHaveProperty('charge_alert_raised_at');
      await release();
      expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
      expect(await jobOf(f)).toHaveProperty('charge_alert_raised_at');

      const paidLater = await deferredAccept();
      await perform(paidLater.parentId, paidLater.customerId);
      raiseAdminAlert.mockClear();
      raiseAdminAlert.mockRejectedValueOnce(new Error('synthetic alert failure'));
      await sweep();
      await trx('invoices').where({ id: paidLater.invoiceId }).update({ status: 'paid' });
      await release();
      expect(raiseAdminAlert.mock.calls.filter((c) => c[2]?.dedupeKey === `paf-prepay-charge-failed:${paidLater.estimateId}`)).toHaveLength(1);
      expect(await jobOf(paidLater)).toHaveProperty('charge_alert_closed_at');
    });

    it('closes the R2 alert once the year is paid even if its raised stamp never landed', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'delivered_fallback' } });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'paid' });
      const episodes = require('../services/admin-alert-episodes');
      const closeSpy = jest.spyOn(episodes, 'closeAdminAlertKeys');
      await release();
      expect(closeSpy).toHaveBeenCalledWith(expect.anything(), [`paf-prepay-charge-failed:${f.estimateId}`], 'resolved', expect.anything());
      expect(await jobOf(f)).toHaveProperty('charge_alert_closed_at');
      closeSpy.mockRestore();
    });

    it('a card intent parked processing neither closes nor raises the R2 alert', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'delivered_fallback', charge_alert_raised_at: new Date().toISOString() } });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'processing', payment_method: 'card' });
      const episodes = require('../services/admin-alert-episodes');
      const closeSpy = jest.spyOn(episodes, 'closeAdminAlertKeys');
      await release();
      expect(closeSpy).not.toHaveBeenCalledWith(expect.anything(), [`paf-prepay-charge-failed:${f.estimateId}`], expect.anything(), expect.anything());
      expect(await jobOf(f)).not.toHaveProperty('charge_alert_closed_at');
      closeSpy.mockRestore();
    });

    it('a returned bank debit goes to the pay link and the office alert, never a re-debit', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'processing' } });
      // Released by the performed first visit, then charged by bank debit.
      await perform(f.parentId, f.customerId);
      await trx('estimates').where({ id: f.estimateId }).update({
        estimate_data: trx.raw("jsonb_set(estimate_data, '{prepayAutoChargeJob,released_for_visit_id}', to_jsonb(?::text))", [f.parentId]),
      });
      // The payment-failed webhook reopened the invoice.
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'sent', payment_method: 'us_bank_account' });
      await sweep();
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(require('../services/invoice').sendViaSMSAndEmail).toHaveBeenCalledWith(f.invoiceId);
      expect(await jobOf(f)).toMatchObject({ status: 'delivered_fallback', charge_returned: true });
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      expect(raiseAdminAlert).toHaveBeenCalledWith('billing', expect.objectContaining({ subject: { type: 'invoice', id: f.invoiceId } }),
        { dedupeKey: `paf-prepay-charge-failed:${f.estimateId}` });
    });

    it('a bank payment on the pay link closes the R2 alert, and a returned one rings it again', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'delivered_fallback', charge_alert_raised_at: new Date().toISOString() } });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'processing', payment_method: 'us_bank_account' });
      const episodes = require('../services/admin-alert-episodes');
      const closeSpy = jest.spyOn(episodes, 'closeAdminAlertKeys');
      await release();
      expect(closeSpy).toHaveBeenCalledWith(expect.anything(), [`paf-prepay-charge-failed:${f.estimateId}`], 'resolved', expect.anything());
      expect(await jobOf(f)).toMatchObject({ charge_alert_round: 1 });
      expect(await jobOf(f)).not.toHaveProperty('charge_alert_closed_at');
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'sent' });
      await release();
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      expect(raiseAdminAlert).toHaveBeenCalledWith('billing', expect.anything(), { dedupeKey: `paf-prepay-charge-failed:${f.estimateId}:1` });
      closeSpy.mockRestore();
    });

    it('a year closed unpaid after a failed charge hands the held visits to the office', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'delivered_fallback', released_for_visit_id: null, charge_alert_raised_at: new Date().toISOString() } });
      await trx('estimates').where({ id: f.estimateId }).update({
        estimate_data: trx.raw("jsonb_set(estimate_data, '{prepayAutoChargeJob,released_for_visit_id}', to_jsonb(?::text))", [f.parentId]),
      });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_after_visit', performed_visit_id: f.parentId });
      expect(await covers(f.childId)).toBe(false);
      await release();
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      expect(raiseAdminAlert).toHaveBeenCalledWith('billing', expect.objectContaining({ subject: { type: 'visit', id: f.parentId } }),
        { dedupeKey: `paf-prepay-cancelled-after-visit:${f.estimateId}` });
    });

    it('a bank payment closes the R2 alert even without its raised stamp, and starts one new round', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'delivered_fallback' } });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'processing', payment_method: 'us_bank_account' });
      const episodes = require('../services/admin-alert-episodes');
      const closeSpy = jest.spyOn(episodes, 'closeAdminAlertKeys');
      await release();
      await release();
      expect(closeSpy).toHaveBeenCalledWith(expect.anything(), [`paf-prepay-charge-failed:${f.estimateId}`], 'resolved', expect.anything());
      expect(await jobOf(f)).toMatchObject({ charge_alert_round: 1 });
      closeSpy.mockRestore();
    });

    it('a released year handed to a payer that then dies unpaid raises the unbilled-visits alert', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'skipped', reason: 'payer_billed' } });
      await trx('estimates').where({ id: f.estimateId }).update({
        estimate_data: trx.raw("jsonb_set(estimate_data, '{prepayAutoChargeJob,released_for_visit_id}', to_jsonb(?::text))", [f.parentId]),
      });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_after_visit', performed_visit_id: f.parentId });
      await release();
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      expect(raiseAdminAlert).toHaveBeenCalledWith('billing', expect.anything(), { dedupeKey: `paf-prepay-cancelled-after-visit:${f.estimateId}` });
    });

    it('a released bank debit that returns, then a voided year, still hands the held visit to the office (pre-push audit P1)', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'processing', released_for_visit_id: null } });
      await trx('estimates').where({ id: f.estimateId }).update({
        estimate_data: trx.raw("jsonb_set(estimate_data, '{prepayAutoChargeJob,released_for_visit_id}', to_jsonb(?::text))", [f.parentId]),
      });
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'void' });
      await release();
      expect(await jobOf(f)).toMatchObject({ status: 'cancelled_after_visit', performed_visit_id: f.parentId });
    });

    it('an after-visit year whose payer still resolves is stamped to the payer before delivery, never the homeowner (pre-push audit)', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'pending', deferred_to_first_visit: false, after_visit_attested: true } });
      const payer = require('../services/payer');
      const credit = require('../services/customer-credit');
      const stampSpy = jest.spyOn(credit, 'reverseCreditAndStampPayer').mockResolvedValue({ reversed: 0 });
      payer.resolveForInvoice.mockImplementation(async () => ({ payerId: 7, snapshot: null }));
      try {
        await sweep();
        expect(stampSpy).toHaveBeenCalledWith(expect.objectContaining({ invoiceId: f.invoiceId, payerId: 7 }));
        expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      } finally {
        payer.resolveForInvoice.mockImplementation(async () => ({ payerId: null }));
        stampSpy.mockRestore();
      }
    });

    it('a year routed to a payer, authorized for after the first visit, is never charged to the card once the payer is gone (pre-push audit P0)', async () => {
      const f = await deferredAccept({ jobPatch: { status: 'pending', deferred_to_first_visit: false, after_visit_attested: true } });
      await sweep();
      expect(require('../services/stripe').chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect((await jobOf(f)).status).not.toBe('paid');
      // …and no authorization the customer never gave is recorded first.
      expect(await trx('payment_method_consents').where({ customer_id: f.customerId })).toEqual([]);
    });

    it('activating the year paid after visit 1 counts that visit: the plan gets exactly the visits sold', async () => {
      const f = await deferredAccept();
      await trx('annual_prepay_terms').where({ id: f.termId }).update({ first_visit_date: day(0) });
      await perform(f.parentId, f.customerId);
      const StripeService = require('../services/stripe');
      StripeService.chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId) => {
        await trx('invoices').where({ id: invoiceId }).update({ status: 'paid', paid_at: new Date() });
        return { ok: true };
      });
      await sweep();
      const paid = await trx('invoices').where({ id: f.invoiceId }).first();
      await require('../services/annual-prepay-renewals').syncTermForInvoicePayment(paid);
      const term = await trx('annual_prepay_terms').where({ id: f.termId }).first('status', 'coverage_visit_count');
      expect(term.status).toBe('active');
      const visits = await trx('scheduled_services').where({ customer_id: f.customerId })
        .whereNotIn('status', ['cancelled', 'canceled', 'skipped', 'rescheduled']);
      expect(visits).toHaveLength(term.coverage_visit_count);
      expect(await trx('invoices').where({ customer_id: f.customerId }).whereNot({ id: f.invoiceId })).toEqual([]);
    });

    it('a held visit billed only for its add-ons earns no visit credit when the year is paid', async () => {
      const f = await deferredAccept();
      await trx('annual_prepay_terms').where({ id: f.termId }).update({ first_visit_date: day(0) });
      await perform(f.parentId, f.customerId);
      // Completion billed only the add-on (annual-prepay-addon-billing), paid.
      const addonId = randomUUID();
      await trx('scheduled_service_addons').insert({ id: addonId, scheduled_service_id: f.parentId, service_name: 'Wasp nest removal', estimated_price: 20, base_price: 20 });
      await trx('invoices').insert({ id: randomUUID(), customer_id: f.customerId, scheduled_service_id: f.parentId,
        invoice_number: `TEST-ADDON-${f.parentId.slice(0, 6)}`, token: randomUUID().replace(/-/g, ''), status: 'paid', paid_at: new Date(),
        total: 20, subtotal: 20, line_items: JSON.stringify([{ client_id: `scheduled_${f.parentId}_addon_${addonId}`, description: 'Wasp nest removal', amount: 20, quantity: 1, unit_price: 20 }]) });
      // The add-ons are then edited: the editor deletes and reinserts the
      // rows, so their ids change (GitHub Codex #5567 r15).
      await trx('scheduled_service_addons').where({ id: addonId }).del();
      await trx('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: f.parentId, service_name: 'Wasp nest removal', estimated_price: 20, base_price: 20 });
      const credit = require('../services/customer-credit');
      const creditSpy = jest.spyOn(credit, 'postCreditMovement');
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'paid', paid_at: new Date() });
      const paid = await trx('invoices').where({ id: f.invoiceId }).first();
      await require('../services/annual-prepay-renewals').syncTermForInvoicePayment(paid);
      expect((await trx('annual_prepay_terms').where({ id: f.termId }).first('status')).status).toBe('active');
      expect(creditSpy).not.toHaveBeenCalled();
      creditSpy.mockRestore();
    });

    it('an office invoice with a free-text base line keeps its visit credit when the year is paid', async () => {
      const f = await deferredAccept();
      await trx('annual_prepay_terms').where({ id: f.termId }).update({ first_visit_date: day(0) });
      await perform(f.parentId, f.customerId);
      await trx('invoices').insert({ id: randomUUID(), customer_id: f.customerId, scheduled_service_id: f.parentId,
        invoice_number: `TEST-OFFICE-${f.parentId.slice(0, 6)}`, token: randomUUID().replace(/-/g, ''), status: 'paid', paid_at: new Date(),
        total: 120, subtotal: 120, line_items: JSON.stringify([{ description: 'Quarterly Pest Control', amount: 120, quantity: 1, unit_price: 120 }]) });
      const credit = require('../services/customer-credit');
      const creditSpy = jest.spyOn(credit, 'postCreditMovement');
      await trx('invoices').where({ id: f.invoiceId }).update({ status: 'paid', paid_at: new Date() });
      const paid = await trx('invoices').where({ id: f.invoiceId }).first();
      await require('../services/annual-prepay-renewals').syncTermForInvoicePayment(paid);
      expect(creditSpy).toHaveBeenCalled();
      creditSpy.mockRestore();
    });

    it('sends the pay link and rings the office on a decline, and keeps later visits held (R2)', async () => {
      const f = await deferredAccept();
      await perform(f.parentId, f.customerId);
      const StripeService = require('../services/stripe');
      StripeService.chargeInvoiceWithSavedCard.mockRejectedValue(new Error('Your card was declined.'));
      await sweep();
      expect(require('../services/invoice').sendViaSMSAndEmail).toHaveBeenCalledWith(f.invoiceId);
      expect((await jobOf(f)).status).toBe('delivered_fallback');
      const { raiseAdminAlert } = require('../services/admin-alert-compose');
      expect(raiseAdminAlert).toHaveBeenCalledWith('billing', expect.objectContaining({
        area: 'Billing', subject: { type: 'invoice', id: f.invoiceId },
      }), { dedupeKey: `paf-prepay-charge-failed:${f.estimateId}` });
      expect(await covers(f.childId)).toBe(true);
    });
  });
});
