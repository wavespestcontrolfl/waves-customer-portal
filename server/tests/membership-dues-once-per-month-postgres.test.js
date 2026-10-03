/**
 * B08 — membership dues are owed ONCE per ET month, not once per plan visit.
 *
 * A monthly-membership customer whose autopay cannot collect (expired card,
 * paused, off) used to get a full monthly_rate invoice on EVERY unpriced plan
 * visit: nothing month-scoped recognized the dues invoice an earlier
 * completion had already minted (monthlyDuesCollected matched only the
 * cron's own payment stamp). The completion mint now stamps the visit's
 * month on the dues invoice's primary line (membership_dues_month) and
 * monthlyDuesCollected reads it: a live (paid / processing / open) dues
 * invoice covers the month's other plan visits; void / refunded / canceled
 * covers nothing.
 *
 * Runs the real completeScheduledService transaction and the real
 * InvoiceService mint against a migrated, private Postgres clone. Wiring
 * copied from complete-scheduled-service-first-visit-rating-default-postgres.
 */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn', 'client']) Object.defineProperty(db, name, { get: () => mockPg[name] });
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
jest.mock('../services/stripe', () => ({ charge: jest.fn(), chargeOneTime: jest.fn(), chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => false),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => null),
}));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => { req.technicianId = null; req.techRole = 'admin'; return next(); },
  requireAdmin: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
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

// Verified private clone only — never a shared or production URL. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the exact marker the CI
// "DB-gated suites" step greps for (.github/workflows/tests.yml) to discover
// and run this file.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_qa_b08_dues';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Membership dues once-per-month Postgres tests require this worktree\'s own waves_qa_b08_dues or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const { etDateString } = require('../utils/datetime-et');

function monthOf(dateText) { return dateText.slice(0, 7); }
// A day in the PREVIOUS ET month (the 15th, so no calendar edge). Completion
// refuses a future-dated visit, so "another month" is exercised with the
// earlier month's visit completing first.
function previousMonthDay() {
  const [y, m] = etDateString().split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-15`;
}

async function seedMember({ autopay = false, monthlyRate = 49 } = {}) {
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(),
    serviceKey: `fixture_dues_${randomUUID().slice(0, 8)}`, visitIds: [] };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'DuesMember',
    phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`, email: `${f.customerId}@example.invalid`,
    property_type: 'residential', waveguard_tier: 'Silver', monthly_rate: monthlyRate, billing_mode: 'monthly_membership',
    autopay_enabled: autopay });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture Plan Service ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  if (autopay) {
    await mockPg('payment_methods').insert({ id: randomUUID(), customer_id: f.customerId, processor: 'stripe',
      stripe_payment_method_id: `pm_fixture_${f.serviceKey}`, stripe_customer_id: `cus_fixture_${f.serviceKey}`,
      card_brand: 'visa', last_four: '4242', exp_month: 12, exp_year: new Date().getFullYear() + 3,
      method_type: 'card', is_default: true, autopay_enabled: true });
  }
  return f;
}

// An UNPRICED recurring plan visit (estimated_price NULL — inherits the plan).
async function seedVisit(f, { scheduledDate = etDateString(), label = 'Lawn Care', estimatedPrice = null } = {}) {
  const id = randomUUID();
  await mockPg('scheduled_services').insert({ id, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture ${label} ${f.serviceKey}`, scheduled_date: scheduledDate, window_start: '09:00', window_end: '10:00',
    status: 'confirmed', estimated_price: estimatedPrice, estimated_duration_minutes: 60, is_recurring: true,
    create_invoice_on_complete: false });
  f.visitIds.push(id);
  return id;
}

async function cleanup(f) {
  await mockPg('service_completion_attempts').whereIn('service_id', f.visitIds).del().catch(() => {});
  await mockPg('payments').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('payment_methods').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

async function complete(f, serviceId, overrides = {}, idempotencyKey = randomUUID()) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId, idempotencyKey,
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { customerRecap: 'Visit closed out.', visitOutcome: 'completed', products: [], areasServiced: [],
      sendCompletionSms: false, requestReview: false, ...overrides } });
}

const invoicesFor = (f) => mockPg('invoices').where({ customer_id: f.customerId }).orderBy('created_at', 'asc');
const liveInvoicesFor = (f) => mockPg('invoices').where({ customer_id: f.customerId })
  .whereNotIn('status', ['void', 'refunded', 'canceled', 'cancelled']);

postgres('membership dues are owed once per ET month (B08)', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  afterEach(() => { jest.restoreAllMocks(); });

  test('(a) dead-autopay member: the first unpriced plan visit mints the month\'s dues, the second mints nothing', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      expect(await complete(f, lawn)).toMatchObject({ status: 200 });
      const [first] = await invoicesFor(f);
      expect(Number(first.total)).toBe(49);
      const stamped = first.line_items.find((li) => li.membership_dues_month);
      expect(stamped).toMatchObject({ membership_dues_month: monthOf(etDateString()), amount: 49 });
      expect(await complete(f, pest)).toMatchObject({ status: 200 });
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('(b) the first month\'s dues invoice was PAID: a second plan visit still mints nothing', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      await complete(f, lawn);
      await mockPg('invoices').where({ customer_id: f.customerId }).update({ status: 'paid', paid_at: new Date() });
      await complete(f, pest);
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('(b2) the first dues invoice is still OPEN (sent, unpaid): the month is billed once', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      await complete(f, lawn);
      await mockPg('invoices').where({ customer_id: f.customerId }).update({ status: 'overdue' });
      await complete(f, pest);
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('(c) the first dues invoice was VOIDED: the next plan visit mints the month\'s dues', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      await complete(f, lawn);
      await mockPg('invoices').where({ customer_id: f.customerId }).update({ status: 'void' });
      await complete(f, pest);
      expect(await invoicesFor(f)).toHaveLength(2);
      const live = await liveInvoicesFor(f);
      expect(live).toHaveLength(1);
      expect(Number(live[0].total)).toBe(49);
    } finally { await cleanup(f); }
  });

  test('(d) a visit in ANOTHER month mints that month\'s dues (the earlier month\'s invoice covers only its own month)', async () => {
    const f = await seedMember();
    try {
      const lastMonth = await seedVisit(f, { label: 'Lawn Care', scheduledDate: previousMonthDay() });
      const thisMonth = await seedVisit(f, { label: 'Pest Control' });
      expect(await complete(f, lastMonth)).toMatchObject({ status: 200 });
      expect(await complete(f, thisMonth)).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(2);
      const months = rows.map((r) => r.line_items.find((li) => li.membership_dues_month).membership_dues_month).sort();
      expect(months).toEqual([monthOf(previousMonthDay()), monthOf(etDateString())].sort());
    } finally { await cleanup(f); }
  });

  test('(e) a month the cron already collected: unchanged — no dues invoice on any plan visit', async () => {
    const f = await seedMember();
    try {
      await mockPg('payments').insert({ customer_id: f.customerId, amount: 49, status: 'paid', payment_date: etDateString(),
        description: 'Silver WaveGuard Monthly — Fixture', metadata: JSON.stringify({ billed_month: monthOf(etDateString()) }) });
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      await complete(f, lawn);
      expect(await invoicesFor(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  test('(f) autopay-active member: unchanged — nothing is invoiced, nothing is stamped', async () => {
    const f = await seedMember({ autopay: true });
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      await complete(f, lawn);
      await complete(f, pest);
      expect(await invoicesFor(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  // Two plan visits of one customer completing at the same instant: the mint
  // locks are visit-scoped, so both used to pass the pre-lock coverage read
  // and each mint the full monthly rate. The barrier holds BOTH completions
  // at the mint (after their pre-lock decisions, before any lock), so the
  // per customer + month dues lock is what decides.
  test('concurrent completions of two plan visits in one month mint exactly ONE dues invoice, and the loser still completes', async () => {
    const InvoiceService = require('../services/invoice');
    const original = InvoiceService.createFromService;
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      let arrived = 0;
      let release;
      const barrier = new Promise((resolve) => { release = resolve; });
      jest.spyOn(InvoiceService, 'createFromService').mockImplementation(async (...args) => {
        arrived += 1;
        if (arrived === 2) release();
        await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 8000))]);
        return original.apply(InvoiceService, args);
      });
      const [first, second] = await Promise.all([
        complete(f, lawn, { sendCompletionSms: true }),
        complete(f, pest, { sendCompletionSms: true }),
      ]);
      expect(arrived).toBe(2);
      expect(first).toMatchObject({ status: 200 });
      expect(second).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total)).toBe(49);
      expect(rows[0].line_items.find((li) => li.membership_dues_month)).toBeTruthy();
      // Both visits closed out; only one carries the dues invoice.
      const records = await mockPg('service_records').where({ customer_id: f.customerId });
      expect(records).toHaveLength(2);
      const visits = await mockPg('scheduled_services').whereIn('id', [lawn, pest]);
      expect(visits.map((v) => v.status)).toEqual(['completed', 'completed']);
    } finally { await cleanup(f); }
  });

  // The SCHEDULED_PRICE_MOVED retry re-mints at the moved price. The stamp
  // must describe the invoice actually written, so provenance is judged under
  // the mint lock from the locked rows — not from the pre-lock decision.
  test('a visit repriced between the decision and the mint (SCHEDULED_PRICE_MOVED retry) mints an UNSTAMPED invoice; the next plan visit still mints the month\'s dues', async () => {
    const InvoiceService = require('../services/invoice');
    const original = InvoiceService.createFromService;
    const f = await seedMember();
    try {
      // estimated_price 0 with no primary line price reads as "unpriced": the
      // decision bills the monthly rate and requests a dues stamp.
      const lawn = await seedVisit(f, { label: 'Lawn Care', estimatedPrice: 0 });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      let firstCall = true;
      jest.spyOn(InvoiceService, 'createFromService').mockImplementation(async (...args) => {
        if (firstCall) {
          firstCall = false;
          await mockPg('scheduled_services').where({ id: lawn }).update({ estimated_price: 85 });
        }
        return original.apply(InvoiceService, args);
      });
      expect(await complete(f, lawn)).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total)).toBe(85);
      expect(rows[0].line_items.some((li) => li.membership_dues_month)).toBe(false);
      jest.restoreAllMocks();
      expect(await complete(f, pest)).toMatchObject({ status: 200 });
      const after = await invoicesFor(f);
      expect(after).toHaveLength(2);
      const dues = after.find((r) => Number(r.total) === 49);
      expect(dues.line_items.find((li) => li.membership_dues_month)).toMatchObject({ membership_dues_month: monthOf(etDateString()) });
    } finally { await cleanup(f); }
  });

  // The coverage re-read under the dues lock must fail CLOSED. The failure is
  // injected at the pg driver for exactly the stamped-invoice coverage query,
  // so it hits the pre-lock read too (which defaults to "not covered" and
  // lets the decision reach the mint) — the in-lock read is what decides.
  function failCoverageReads() {
    // Transaction clients are built from the driver CLASS, so patch its prototype.
    const client = Object.getPrototypeOf(mockPg.client);
    const original = client._query;
    client._query = function patched(connection, obj) {
      if (String(obj?.sql || '').includes('line_items::jsonb @>')) {
        return Promise.reject(new Error('canceling statement due to statement timeout (injected)'));
      }
      return original.call(this, connection, obj);
    };
    return () => { client._query = original; };
  }

  async function insertStampedDuesInvoice(f, visitId, status) {
    const id = randomUUID();
    await mockPg('invoices').insert({ id, token: randomUUID().replace(/-/g, ''), invoice_number: `B08-${id.slice(0, 8)}`,
      customer_id: f.customerId, scheduled_service_id: visitId, status, total: 49, subtotal: 49,
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 49, amount: 49, membership_dues_month: monthOf(etDateString()) }]) });
    return id;
  }

  test('a month ALREADY billed + an unreadable coverage lookup under the lock → no second dues invoice; the retry finds it covered', async () => {
    const f = await seedMember();
    let restore = null;
    try {
      const billed = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      await insertStampedDuesInvoice(f, billed, 'sent');
      restore = failCoverageReads();
      const key = randomUUID();
      const out = await complete(f, pest, {}, key);
      expect(out).toMatchObject({ status: 503, body: { code: 'membership_dues_coverage_unverified' } });
      expect(await invoicesFor(f)).toHaveLength(1);
      restore(); restore = null;
      // Retryable: the same closeout, coverage readable again → covered, still one invoice.
      expect(await complete(f, pest, {}, key)).toMatchObject({ status: 200 });
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { if (restore) restore(); await cleanup(f); }
  });

  test('a month NOTHING covered + an unreadable lookup → no invoice now, and the retry mints the dues exactly once', async () => {
    const f = await seedMember();
    let restore = null;
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      restore = failCoverageReads();
      const key = randomUUID();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 503, body: { code: 'membership_dues_coverage_unverified' } });
      expect(await invoicesFor(f)).toHaveLength(0);
      restore(); restore = null;
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total)).toBe(49);
      expect(rows[0].line_items.find((li) => li.membership_dues_month)).toBeTruthy();
      // A repeat of the same closeout adds nothing.
      await complete(f, lawn, {}, key);
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { if (restore) restore(); await cleanup(f); }
  });

  test('a visit with its OWN stamped price is not a dues visit: its invoice carries no month stamp', async () => {
    const f = await seedMember();
    try {
      // Non-recurring one-off with its own price: bills its price, never dues.
      const oneOff = await seedVisit(f, { label: 'Add-on Treatment', estimatedPrice: 85 });
      await mockPg('scheduled_services').where({ id: oneOff }).update({ is_recurring: false });
      await complete(f, oneOff);
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total)).toBe(85);
      expect(rows[0].line_items.some((li) => li.membership_dues_month)).toBe(false);
      // …and it does not cover the month: the next unpriced plan visit mints the dues.
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      await complete(f, lawn);
      expect(await invoicesFor(f)).toHaveLength(2);
    } finally { await cleanup(f); }
  });
});

// The collectors (monthly cron, retry sweep, Charge now) and the completion's
// dues mint must agree on one bill per customer + month. The collectors hold a
// SESSION lock across the Stripe charge, so the completion never waits on it:
// it claims the same key without blocking and, if a collector holds it,
// refuses retryably.
postgres('completion dues mint vs the monthly collectors (B08)', () => {
  const { withCustomerBillingLock } = require('../utils/customer-billing-lock');
  const { classifyFailedPaymentRetry, loadRetryContext, REASONS, DISPOSITIONS } = require('../services/retry-collectibility');
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('a collector mid-collection for the customer → the completion mints nothing and is retryable; once released the retry mints exactly once', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const key = randomUUID();
      let during;
      await withCustomerBillingLock(f.customerId, async () => {
        during = await complete(f, lawn, {}, key);
      });
      expect(during).toMatchObject({ status: 503, body: { code: 'membership_dues_coverage_unverified' } });
      expect(await invoicesFor(f)).toHaveLength(0);
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 200 });
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a completion mid-mint holds the collectors\' key: a collector refuses (held elsewhere) instead of charging past it', async () => {
    const { tryClaimCustomerCollectionInTrx } = require('../utils/customer-billing-lock');
    const f = await seedMember();
    const trx = await mockPg.transaction();
    try {
      expect(await tryClaimCustomerCollectionInTrx(trx, f.customerId)).toBe(true);
      await expect(withCustomerBillingLock(f.customerId, async () => 'charged'))
        .rejects.toMatchObject({ code: 'BILLING_CLAIM_HELD_ELSEWHERE' });
      await trx.commit();
      await expect(withCustomerBillingLock(f.customerId, async () => 'charged')).resolves.toBe('charged');
    } finally { await trx.rollback().catch(() => {}); await cleanup(f); }
  });

  // Invoice paid -> autopay restored -> the armed monthly retry for the same
  // month. Real rows, real classifier.
  async function armedMonthlyRow(f) {
    const id = randomUUID();
    await mockPg('payments').insert({ id, customer_id: f.customerId, amount: 49, status: 'failed', retry_count: 1,
      next_retry_at: new Date(), stripe_payment_intent_id: `pi_${id.slice(0, 8)}`, payment_date: etDateString(),
      description: 'Silver WaveGuard Monthly — Fixture DuesMember — FAILED',
      metadata: JSON.stringify({ type: 'monthly_autopay', billed_month: monthOf(etDateString()) }) });
    return mockPg('payments').where({ id }).first();
  }
  async function duesInvoice(f, status) {
    const id = randomUUID();
    await mockPg('invoices').insert({ id, token: randomUUID().replace(/-/g, ''), invoice_number: `B08-${id.slice(0, 8)}`,
      customer_id: f.customerId, status, total: 49, subtotal: 49,
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 49, amount: 49, membership_dues_month: monthOf(etDateString()) }]) });
    return id;
  }
  const classify = async (f, row) => {
    const customer = await mockPg('customers').where({ id: f.customerId }).first();
    return classifyFailedPaymentRetry({ payment: row, customer, ctx: loadRetryContext() });
  };

  test('stamped dues invoice PAID, autopay restored → the armed monthly retry is resolved against the payment that paid it, never charged', async () => {
    const f = await seedMember({ autopay: true });
    try {
      const row = await armedMonthlyRow(f);
      const invoiceId = await duesInvoice(f, 'paid');
      const paymentId = randomUUID();
      await mockPg('payments').insert({ id: paymentId, customer_id: f.customerId, amount: 49, status: 'paid', payment_date: etDateString(),
        description: 'Lawn Care', metadata: JSON.stringify({ invoice_id: invoiceId }) });
      expect(await classify(f, row)).toMatchObject({
        reason: REASONS.ALREADY_COLLECTED, disposition: DISPOSITIONS.SUPERSEDE_BY_COLLECTOR,
        collectedByPaymentId: paymentId, collectedByInvoiceId: invoiceId,
      });
    } finally { await cleanup(f); }
  });

  test('stamped dues invoice OPEN → the retry only defers (stays armed); then PAID → resolved; VOID → collectible again', async () => {
    const f = await seedMember({ autopay: true });
    try {
      const row = await armedMonthlyRow(f);
      const invoiceId = await duesInvoice(f, 'sent');
      expect(await classify(f, row)).toMatchObject({
        collectible: false, reason: REASONS.DUES_INVOICE_OPEN, disposition: DISPOSITIONS.SKIP_ARMED, collectedByInvoiceId: invoiceId,
      });
      // Still open on the next sweep: still deferred, the row unchanged (never superseded).
      expect(await classify(f, row)).toMatchObject({ reason: REASONS.DUES_INVOICE_OPEN, disposition: DISPOSITIONS.SKIP_ARMED });
      expect(await mockPg('payments').where({ id: row.id }).first()).toMatchObject({ superseded_by_payment_id: null, retry_count: 1 });
      // Paid → resolved as already collected.
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'paid' });
      expect(await classify(f, row)).toMatchObject({ reason: REASONS.ALREADY_COLLECTED, disposition: DISPOSITIONS.SUPERSEDE_BY_COLLECTOR });
      // Voided or refunded → the invoice stops matching and the row is collectible again.
      for (const status of ['void', 'refunded']) {
        await mockPg('invoices').where({ id: invoiceId }).update({ status });
        expect(await classify(f, row)).toMatchObject({ collectible: true, disposition: DISPOSITIONS.CHARGE });
      }
    } finally { await cleanup(f); }
  });
});

// Charge now (the admin button) runs the same shared lookup inside its
// customer lock; real SQL, the real route.
postgres('Charge now vs a stamped membership-dues invoice (B08)', () => {
  const express = require('express');
  const StripeService = require('../services/stripe');
  let server;
  let baseUrl;
  beforeAll(async () => {
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    const app = express();
    app.use(express.json());
    app.use('/admin', require('../routes/admin-billing-health'));
    app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
    server = app.listen(0);
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => server.close(r)); if (mockPg) await mockPg.destroy(); });
  beforeEach(() => {
    StripeService.charge.mockReset().mockResolvedValue({ id: randomUUID(), status: 'paid', amount: '49.00', metadata: null });
    StripeService.chargeOneTime.mockReset().mockResolvedValue({ id: randomUUID(), status: 'paid', amount: '25.00', metadata: null });
  });
  const chargeNow = (f, body = {}) => fetch(`${baseUrl}/admin/customers/${f.customerId}/charge-now`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  async function stampedInvoice(f, status) {
    const id = randomUUID();
    await mockPg('invoices').insert({ id, token: randomUUID().replace(/-/g, ''), invoice_number: `B08-${id.slice(0, 8)}`,
      customer_id: f.customerId, status, total: 49, subtotal: 49,
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 49, amount: 49, membership_dues_month: monthOf(etDateString()) }]) });
    return id;
  }

  test.each(['sent', 'overdue', 'paid'])('a %s stamped dues invoice for the month → refused 409 already_collected, no Stripe call', async (status) => {
    const f = await seedMember({ autopay: true });
    try {
      const invoiceId = await stampedInvoice(f, status);
      if (status === 'paid') {
        // Its payment carries invoice_id, not billed_month — invisible to the payments check.
        await mockPg('payments').insert({ id: randomUUID(), customer_id: f.customerId, amount: 49, status: 'paid',
          payment_date: etDateString(), description: 'Lawn Care', metadata: JSON.stringify({ invoice_id: invoiceId }) });
      }
      const res = await chargeNow(f);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ already_collected: true, dues_invoice_id: invoiceId });
      expect(StripeService.charge).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
  });

  test('a VOIDED stamped dues invoice charges the month; an explicit amount charges regardless of a live invoice', async () => {
    const f = await seedMember({ autopay: true });
    try {
      const invoiceId = await stampedInvoice(f, 'void');
      expect((await chargeNow(f)).status).toBe(200);
      expect(StripeService.charge).toHaveBeenCalledTimes(1);
      await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sent' });
      expect((await chargeNow(f, { amount: 25, description: 'Add-on' })).status).toBe(200);
      expect(StripeService.chargeOneTime).toHaveBeenCalledTimes(1);
    } finally { await cleanup(f); }
  });
});

// The stamp's lifetime after the mint: it can be kept or removed, never
// created or left lying about on an invoice that no longer is the month's
// dues, and a voided stamped invoice cannot be restored beside its replacement.
postgres('membership-dues stamp lifetime — void/unvoid and edits (B08)', () => {
  const InvoiceService = require('../services/invoice');
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  async function mintDues(f, label) {
    const visit = await seedVisit(f, { label });
    expect(await complete(f, visit)).toMatchObject({ status: 200 });
    const rows = await invoicesFor(f);
    return { visit, invoice: rows.find((r) => r.scheduled_service_id === visit) };
  }
  const stampedOf = (inv) => (inv.line_items || []).find((li) => li.membership_dues_month);
  const reload = (id) => mockPg('invoices').where({ id }).first();

  test('void A, a replacement B bills the month → unvoid A is refused naming B; void A with nothing else → unvoid allowed and A covers the month again', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      await mockPg('invoices').where({ id: a.invoice.id }).update({ status: 'void' });
      // Nothing else bills the month: restoring A is allowed and A covers it again.
      await InvoiceService.unvoidInvoice(a.invoice.id);
      expect((await reload(a.invoice.id)).status).toBe('draft');
      const { monthlyDuesCollected } = require('../services/billing-lane');
      expect(await monthlyDuesCollected(mockPg, f.customerId, new Date())).toBe(true);
      // Void again; a later plan visit bills the month (B)…
      await mockPg('invoices').where({ id: a.invoice.id }).update({ status: 'void' });
      const b = await mintDues(f, 'Pest Control');
      expect(b.invoice.id).not.toBe(a.invoice.id);
      // …so restoring A would bill it twice.
      await expect(InvoiceService.unvoidInvoice(a.invoice.id)).rejects.toThrow(new RegExp(`already billed on invoice ${b.invoice.invoice_number}`));
      expect((await reload(a.invoice.id)).status).toBe('void');
    } finally { await cleanup(f); }
  });

  test('void A, the cron collected the month → unvoid A is refused naming the payment', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      await mockPg('invoices').where({ id: a.invoice.id }).update({ status: 'void' });
      const paymentId = randomUUID();
      await mockPg('payments').insert({ id: paymentId, customer_id: f.customerId, amount: 49, status: 'paid', payment_date: etDateString(),
        description: 'Silver WaveGuard Monthly — Fixture', metadata: JSON.stringify({ billed_month: monthOf(etDateString()) }) });
      await expect(InvoiceService.unvoidInvoice(a.invoice.id)).rejects.toThrow(new RegExp(`already collected \\(payment ${paymentId}\\)`));
      expect((await reload(a.invoice.id)).status).toBe('void');
    } finally { await cleanup(f); }
  });

  // A stamped invoice IS the month's dues: an edit that would change its dues
  // line set is REFUSED (never stripped), so coverage is released only by an
  // explicit void. Judged against the locked stored invoice.
  const lockedRefusal = /membership dues; its dues line cannot be changed/;
  test.each([
    ['AMOUNT', (li) => ({ ...li, unit_price: 60, amount: 60 })],
    ['CATEGORY', (li) => ({ ...li, category: 'Other' })],
  ])('editing a stamped line\'s %s is refused: invoice unchanged, month still covered, the next visit mints nothing', async (_name, change) => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const before = await reload(a.invoice.id);
      const lines = a.invoice.line_items.map((li) => (li.membership_dues_month ? change(li) : li));
      await expect(InvoiceService.update(a.invoice.id, { line_items: lines })).rejects.toMatchObject({
        code: 'MEMBERSHIP_DUES_LINE_LOCKED', statusCode: 409, isOperational: true,
      });
      await expect(InvoiceService.update(a.invoice.id, { line_items: lines })).rejects.toThrow(lockedRefusal);
      const after = await reload(a.invoice.id);
      expect(after.line_items).toEqual(before.line_items);
      expect(Number(after.total)).toBe(Number(before.total));
      expect(stampedOf(after)).toBeDefined();
      await mintDues(f, 'Pest Control');
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('automated rewrites that leave the dues set intact never trip the refusal: a tax-rate-only retotal and a notes/due-date edit keep the stamp', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      await InvoiceService.update(a.invoice.id, { tax_rate: 0 });
      await InvoiceService.update(a.invoice.id, { notes: 'office note', due_date: etDateString() });
      expect(stampedOf(await reload(a.invoice.id))).toMatchObject({ membership_dues_month: monthOf(etDateString()), amount: 49 });
    } finally { await cleanup(f); }
  });

  test('removing the dues line is refused too', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const lines = [...a.invoice.line_items.filter((li) => !li.membership_dues_month), { description: 'Other work', quantity: 1, unit_price: 20, amount: 20, category: 'Other' }];
      await expect(InvoiceService.update(a.invoice.id, { line_items: lines })).rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_LINE_LOCKED' });
      expect(stampedOf(await reload(a.invoice.id))).toBeDefined();
    } finally { await cleanup(f); }
  });

  test('a client that DROPS the hidden marker on an otherwise unchanged dues set is accepted, and the server keeps the marker', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const noMarker = [...a.invoice.line_items.map(({ membership_dues_month: _m, ...li }) => li),
        { description: 'Gate fee', quantity: 1, unit_price: 10, amount: 10, category: 'Fee' }];
      await InvoiceService.update(a.invoice.id, { line_items: noMarker });
      expect(stampedOf(await reload(a.invoice.id))).toMatchObject({ membership_dues_month: monthOf(etDateString()), amount: 49 });
      await mintDues(f, 'Pest Control');
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a DESCRIPTION-only edit keeps the marker', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const lines = a.invoice.line_items.map((li) => (li.membership_dues_month ? { ...li, description: 'Lawn Care (September visit)' } : li));
      await InvoiceService.update(a.invoice.id, { line_items: lines });
      expect(stampedOf(await reload(a.invoice.id))).toMatchObject({ membership_dues_month: monthOf(etDateString()), description: 'Lawn Care (September visit)' });
    } finally { await cleanup(f); }
  });

  test('the rate changes after the mint and staff add an unrelated fee, dues line untouched → the stamp is kept and the month stays covered', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      await mockPg('customers').where({ id: f.customerId }).update({ monthly_rate: 59 });
      const lines = [...a.invoice.line_items, { description: 'Gate fee', quantity: 1, unit_price: 10, amount: 10, category: 'Fee' }];
      await InvoiceService.update(a.invoice.id, { line_items: lines });
      expect(stampedOf(await reload(a.invoice.id))).toMatchObject({ membership_dues_month: monthOf(etDateString()), amount: 49 });
      const { monthlyDuesCollected } = require('../services/billing-lane');
      expect(await monthlyDuesCollected(mockPg, f.customerId, new Date())).toBe(true);
    } finally { await cleanup(f); }
  });

  test('an edit that leaves the dues line intact (an extra line added) keeps the marker', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const lines = [...a.invoice.line_items, { description: 'Gate fee', quantity: 1, unit_price: 10, amount: 10, category: 'Fee' }];
      await InvoiceService.update(a.invoice.id, { line_items: lines });
      expect(stampedOf(await reload(a.invoice.id))).toMatchObject({ membership_dues_month: monthOf(etDateString()), amount: 49 });
      await mintDues(f, 'Pest Control').catch(() => {});
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a marker naming a DIFFERENT month on an unchanged dues set is normalized back to the stored month (the server owns it)', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const lines = a.invoice.line_items.map((li) => (li.membership_dues_month ? { ...li, membership_dues_month: '2099-01' } : li));
      await InvoiceService.update(a.invoice.id, { line_items: lines });
      expect(stampedOf(await reload(a.invoice.id)).membership_dues_month).toBe(monthOf(etDateString()));
    } finally { await cleanup(f); }
  });

  test('a client-supplied marker is ignored: never ADDED by an edit, never kept by create()', async () => {
    const f = await seedMember();
    try {
      const priced = await seedVisit(f, { label: 'Add-on Treatment', estimatedPrice: 49 });
      await mockPg('scheduled_services').where({ id: priced }).update({ is_recurring: false });
      await complete(f, priced);
      const [plain] = await invoicesFor(f);
      expect(stampedOf(plain)).toBeUndefined();
      const forged = plain.line_items.map((li) => ({ ...li, membership_dues_month: monthOf(etDateString()) }));
      await InvoiceService.update(plain.id, { line_items: forged });
      expect(stampedOf(await reload(plain.id))).toBeUndefined();
      const created = await InvoiceService.create({
        customerId: f.customerId,
        lineItems: [{ description: 'Manual', quantity: 1, unit_price: 49, amount: 49, membership_dues_month: monthOf(etDateString()) }],
      });
      expect(stampedOf(await reload(created.id))).toBeUndefined();
      const { monthlyDuesCollected } = require('../services/billing-lane');
      expect(await monthlyDuesCollected(mockPg, f.customerId, new Date())).toBe(false);
    } finally { await cleanup(f); }
  });
});

// Round 2: covered-skip vs removal serialization, the reconciled dues SET, and
// the locked visit month.
postgres('membership dues — serialization, reconciled shape, locked month (B08 round 2)', () => {
  const InvoiceService = require('../services/invoice');
  const { acquireMembershipDuesMonthLock } = require('../services/billing-lane');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 10 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  // A failing assertion must never strand a held lock (every later test would wait on it).
  const holds = [];
  afterEach(async () => {
    jest.restoreAllMocks();
    while (holds.length) await holds.pop().rollback().catch(() => {});
  });
  async function holdDuesLock(customerId) {
    const trx = await mockPg.transaction();
    holds.push(trx);
    await acquireMembershipDuesMonthLock(trx, customerId, monthOf(etDateString()));
    return trx;
  }
  const stampedOf = (inv) => (inv.line_items || []).find((li) => li.membership_dues_month);
  const reload = (id) => mockPg('invoices').where({ id }).first();
  const settled = (p) => Promise.race([p.then(() => 'done', () => 'done'), sleep(700).then(() => 'pending')]);

  async function mintDues(f, label, visitOver = {}) {
    const visit = await seedVisit(f, { label });
    if (Object.keys(visitOver).length) await mockPg('scheduled_services').where({ id: visit }).update(visitOver);
    expect(await complete(f, visit)).toMatchObject({ status: 200 });
    const rows = await invoicesFor(f);
    return { visit, invoice: rows.find((r) => r.scheduled_service_id === visit) };
  }

  // ── Finding 1: removal vs covered-skip ────────────────────────────────────
  test('a covered completion confirms under the dues-month lock: the stamp stripped before the lock → it mints (one stamped bill)', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const pest = await seedVisit(f, { label: 'Pest Control' });
      const hold = await holdDuesLock(f.customerId);
      // Its pre-lock read sees A's stamp (covered); the confirmation then waits on the lock.
      const pending = complete(f, pest);
      expect(await settled(pending)).toBe('pending');
      // The "edit" wins: coverage removed and committed while the lock is held.
      await hold('invoices').where({ id: a.invoice.id }).update({
        line_items: JSON.stringify(a.invoice.line_items.map(({ membership_dues_month: _m, ...li }) => li)),
      });
      await hold.commit();
      expect(await pending).toMatchObject({ status: 200 });
      const stamped = (await liveInvoicesFor(f)).filter((r) => stampedOf(r));
      expect(stamped).toHaveLength(1);
      expect(stamped[0].scheduled_service_id).toBe(pest);
    } finally { await cleanup(f); }
  });

  test('the same race with no removal: the covered completion mints nothing and the original stays the one stamped bill', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const pest = await seedVisit(f, { label: 'Pest Control' });
      const hold = await holdDuesLock(f.customerId);
      const pending = complete(f, pest);
      expect(await settled(pending)).toBe('pending');
      await hold.commit();
      expect(await pending).toMatchObject({ status: 200 });
      const stamped = (await liveInvoicesFor(f)).filter((r) => stampedOf(r));
      expect(stamped.map((r) => r.id)).toEqual([a.invoice.id]);
    } finally { await cleanup(f); }
  });

  test('an edit of a stamped invoice and a void each WAIT for the dues-month lock (they take it before committing)', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const hold = await holdDuesLock(f.customerId);
      const lines = [...a.invoice.line_items, { description: 'Gate fee', quantity: 1, unit_price: 10, amount: 10, category: 'Fee' }];
      const edit = InvoiceService.update(a.invoice.id, { line_items: lines });
      expect(await settled(edit)).toBe('pending');
      expect((await reload(a.invoice.id)).line_items).toHaveLength(a.invoice.line_items.length);
      await hold.commit();
      await edit;
      expect((await reload(a.invoice.id)).line_items).toHaveLength(a.invoice.line_items.length + 1);

      const b = await mintDues(f, 'Pest Control').catch(() => null);
      expect(b).not.toBeUndefined();
      const hold2 = await holdDuesLock(f.customerId);
      const voiding = InvoiceService.voidInvoice(a.invoice.id);
      expect(await settled(voiding)).toBe('pending');
      expect((await reload(a.invoice.id)).status).not.toBe('void');
      await hold2.commit();
      await voiding;
      expect((await reload(a.invoice.id)).status).toBe('void');
    } finally { await cleanup(f); }
  });

  // The stamp decision is made from the LOCKED row, never the pre-read: an edit
  // that read stamped A, paused, and resumes after A was voided and a completion
  // billed the month on B must not bring A back or put its stamp back.
  test('a preserving edit paused before its transaction cannot revive A after A was voided and B billed the month (void → replacement B → edit resumes)', async () => {
    const f = await seedMember();
    // Pause the NEXT BEGIN (the preserving edit's transaction); every other BEGIN passes.
    const driver = Object.getPrototypeOf(mockPg.client);
    const originalQuery = driver._query;
    let release;
    const gate = new Promise((r) => { release = r; });
    let armed = false;
    let paused = false;
    driver._query = function patched(connection, obj) {
      if (armed && /^\s*begin/i.test(String(obj?.sql || ''))) {
        armed = false;
        paused = true;
        return gate.then(() => originalQuery.call(this, connection, obj));
      }
      return originalQuery.call(this, connection, obj);
    };
    try {
      const a = await mintDues(f, 'Lawn Care');
      const renamed = a.invoice.line_items.map((li) => (li.membership_dues_month ? { ...li, description: 'Lawn Care (renamed)' } : li));
      armed = true;
      const preserving = InvoiceService.update(a.invoice.id, { line_items: renamed });
      for (let i = 0; i < 40 && !paused; i += 1) await sleep(50);
      expect(paused).toBe(true);
      // Meanwhile: A is voided, and a completion bills the month on B.
      await InvoiceService.voidInvoice(a.invoice.id);
      const b = await mintDues(f, 'Pest Control');
      expect(stampedOf(b.invoice)).toBeDefined();
      // The edit resumes against the locked, now-void A and is refused.
      release();
      await expect(preserving).rejects.toThrow();
      expect((await reload(a.invoice.id)).status).toBe('void');
      const stamped = (await liveInvoicesFor(f)).filter((r) => stampedOf(r));
      expect(stamped.map((r) => r.id)).toEqual([b.invoice.id]);
    } finally { release(); driver._query = originalQuery; await cleanup(f); }
  });

  test('a forged marker naming ANOTHER month: the edit locks only the stored month and the server keeps the stored one', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      // Hold the forged month's lock: an edit that (wrongly) took it would block.
      const hold = await mockPg.transaction();
      holds.push(hold);
      await acquireMembershipDuesMonthLock(hold, f.customerId, '2099-01');
      const forged = a.invoice.line_items.map((li) => (li.membership_dues_month ? { ...li, membership_dues_month: '2099-01' } : li));
      const edit = InvoiceService.update(a.invoice.id, { line_items: forged });
      expect(await settled(edit)).toBe('done');
      expect(stampedOf(await reload(a.invoice.id)).membership_dues_month).toBe(monthOf(etDateString()));
    } finally { await cleanup(f); }
  });

  test('a preserving edit with no interference keeps the stamp, and a stamped invoice\'s notes-only edit still works', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const renamed = a.invoice.line_items.map((li) => (li.membership_dues_month ? { ...li, description: 'Lawn Care (renamed)' } : li));
      await InvoiceService.update(a.invoice.id, { line_items: renamed });
      expect(stampedOf(await reload(a.invoice.id))).toMatchObject({ description: 'Lawn Care (renamed)' });
      await InvoiceService.update(a.invoice.id, { notes: 'office note' });
      expect(stampedOf(await reload(a.invoice.id))).toBeDefined();
    } finally { await cleanup(f); }
  });

  // ── Finding 2: the reconciled dues set ───────────────────────────────────
  test.each([
    ['a stale positive primary line price below the rate (a top-up line reaches the rate)', 30],
    ['a stale positive primary line price above the rate (a negative adjustment reaches the rate)', 60],
  ])('%s → mints stamped on the primary line, and the next same-month visit is covered', async (_name, stalePrimary) => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care', { primary_line_price: stalePrimary });
      expect(Number(a.invoice.total)).toBe(49);
      expect(a.invoice.line_items.length).toBeGreaterThan(1);
      const stamped = a.invoice.line_items.filter((li) => li.membership_dues_month);
      expect(stamped).toHaveLength(1);
      expect(stamped[0].client_id).toMatch(/_primary$/);
      await mintDues(f, 'Pest Control');
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('editing a top-up invoice: a fee added keeps the stamp; changing the top-up or the primary is refused', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care', { primary_line_price: 30 });
      await InvoiceService.update(a.invoice.id, { line_items: [...a.invoice.line_items, { description: 'Gate fee', quantity: 1, unit_price: 10, amount: 10, category: 'Fee' }] });
      expect(stampedOf(await reload(a.invoice.id))).toBeDefined();
      const withFee = (await reload(a.invoice.id)).line_items;
      await expect(InvoiceService.update(a.invoice.id, {
        line_items: withFee.map((li) => (/^scheduled_price_topup_/.test(li.client_id || '') ? { ...li, unit_price: 5, amount: 5 } : li)),
      })).rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_LINE_LOCKED' });
      await expect(InvoiceService.update(a.invoice.id, {
        line_items: withFee.map((li) => (li.membership_dues_month ? { ...li, unit_price: 31, amount: 31 } : li)),
      })).rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_LINE_LOCKED' });
      expect(stampedOf(await reload(a.invoice.id))).toBeDefined();
    } finally { await cleanup(f); }
  });

  // ── Finding 3: the locked visit's month ──────────────────────────────────
  test('a visit moved to another month between the decision and the lock → no wrong-month stamp; the retry bills the month the visit is actually in', async () => {
    const InvoiceSvc = require('../services/invoice');
    const original = InvoiceSvc.createFromService;
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const moved = previousMonthDay();
      let first = true;
      jest.spyOn(InvoiceSvc, 'createFromService').mockImplementation(async (...args) => {
        if (first) { first = false; await mockPg('scheduled_services').where({ id: lawn }).update({ scheduled_date: moved }); }
        return original.apply(InvoiceSvc, args);
      });
      const key = randomUUID();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 503, body: { code: 'membership_dues_coverage_unverified' } });
      expect(await invoicesFor(f)).toHaveLength(0);
      jest.restoreAllMocks();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(stampedOf(rows[0]).membership_dues_month).toBe(monthOf(moved));
      // The current month was never stamped or covered: a visit today bills it.
      await mintDues(f, 'Pest Control');
      const months = (await invoicesFor(f)).map((r) => stampedOf(r).membership_dues_month).sort();
      expect(months).toEqual([monthOf(moved), monthOf(etDateString())].sort());
    } finally { await cleanup(f); }
  });
});

// Why a requested stamp may not hold is split by cause on the locked visit plus
// the customer row read in the mint transaction: a visit that is no longer a
// dues visit mints unstamped (genuine reprice, existing test); a dues visit
// whose derived amount no longer matches the customer row is refused, retryably.
postgres('membership dues — stale rate or lane at the mint, and Charge now (B08 round 3)', () => {
  const InvoiceSvc = require('../services/invoice');
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  afterEach(() => { jest.restoreAllMocks(); });
  const stampedOf = (inv) => (inv.line_items || []).find((li) => li.membership_dues_month);

  function beforeFirstMint(fn) {
    const original = InvoiceSvc.createFromService;
    let first = true;
    jest.spyOn(InvoiceSvc, 'createFromService').mockImplementation(async (...args) => {
      if (first) { first = false; await fn(); }
      return original.apply(InvoiceSvc, args);
    });
  }

  test('the monthly rate changed between decision and mint → 503 and nothing inserted; the retry mints one stamped invoice at the NEW rate', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      beforeFirstMint(() => mockPg('customers').where({ id: f.customerId }).update({ monthly_rate: 59 }));
      const key = randomUUID();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 503, body: { code: 'membership_dues_coverage_unverified' } });
      expect(await invoicesFor(f)).toHaveLength(0);
      jest.restoreAllMocks();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total)).toBe(59);
      expect(stampedOf(rows[0])).toMatchObject({ membership_dues_month: monthOf(etDateString()), amount: 59 });
    } finally { await cleanup(f); }
  });

  test('rate changed AND the month got a stamped invoice meanwhile → the retry finds it covered and mints nothing', async () => {
    const f = await seedMember();
    try {
      const other = await seedVisit(f, { label: 'Pest Control' });
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      beforeFirstMint(async () => {
        await mockPg('customers').where({ id: f.customerId }).update({ monthly_rate: 59 });
        await mockPg('invoices').insert({ id: randomUUID(), token: randomUUID().replace(/-/g, ''), invoice_number: `B08-${randomUUID().slice(0, 8)}`,
          customer_id: f.customerId, scheduled_service_id: other, status: 'sent', total: 49, subtotal: 49,
          line_items: JSON.stringify([{ description: 'Pest Control', quantity: 1, unit_price: 49, amount: 49, membership_dues_month: monthOf(etDateString()) }]) });
      });
      const key = randomUUID();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 503 });
      jest.restoreAllMocks();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 200 });
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('the customer left the membership lane between decision and mint → no dues invoice is inserted, and the retry follows the lane that now applies', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      beforeFirstMint(() => mockPg('customers').where({ id: f.customerId }).update({ billing_mode: 'per_visit' }));
      const key = randomUUID();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 503, body: { code: 'membership_dues_coverage_unverified' } });
      expect(await invoicesFor(f)).toHaveLength(0);
      jest.restoreAllMocks();
      // per_visit: an unpriced visit bills nothing on the dues rate.
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 200 });
      expect(await invoicesFor(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  // Charge now's pre-mint can produce a member's dues-shaped invoice; it goes
  // through the same stamp + coverage check.
  async function loadSvc(visitId) {
    return mockPg('scheduled_services').where('scheduled_services.id', visitId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.monthly_rate as cust_monthly_rate', 'customers.waveguard_tier as cust_waveguard_tier',
        'customers.billing_mode as cust_billing_mode', 'customers.property_type as cust_property_type')
      .first();
  }

  test('Charge now / prepaid-receipt pre-mint of an unpriced member visit mints a STAMPED dues invoice; the next visit and a second pre-mint see the month covered', async () => {
    const { mintOrReuseScheduledServiceInvoice } = require('../routes/admin-schedule')._test;
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      const minted = await mintOrReuseScheduledServiceInvoice(await loadSvc(lawn));
      expect(minted.invoice).toBeTruthy();
      expect(stampedOf(await mockPg('invoices').where({ id: minted.invoice.id }).first())).toMatchObject({ membership_dues_month: monthOf(etDateString()) });
      // A second visit's pre-mint is refused as already covered…
      expect(await mintOrReuseScheduledServiceInvoice(await loadSvc(pest))).toEqual({ invoice: null, reason: 'membership_dues_covered' });
      // …and its completion mints nothing.
      expect(await complete(f, pest)).toMatchObject({ status: 200 });
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a priced visit\'s pre-mint is not a dues mint: no stamp', async () => {
    const { mintOrReuseScheduledServiceInvoice } = require('../routes/admin-schedule')._test;
    const f = await seedMember();
    try {
      const priced = await seedVisit(f, { label: 'Add-on Treatment', estimatedPrice: 85 });
      await mockPg('scheduled_services').where({ id: priced }).update({ is_recurring: false });
      const minted = await mintOrReuseScheduledServiceInvoice(await loadSvc(priced));
      expect(Number(minted.invoice.total)).toBe(85);
      expect(stampedOf(await mockPg('invoices').where({ id: minted.invoice.id }).first())).toBeUndefined();
    } finally { await cleanup(f); }
  });
});

// Round 4: customer billing terms locked through the mint; the covered-skip
// verdict committed under the dues-month lock; a void alerts the office.
postgres('membership dues — locked terms, covered-skip commit, void alert (B08 round 4)', () => {
  const InvoiceSvc = require('../services/invoice');
  const { acquireMembershipDuesMonthLock } = require('../services/billing-lane');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const holds = [];
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 10 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  afterEach(async () => {
    jest.restoreAllMocks();
    while (holds.length) await holds.pop().rollback().catch(() => {});
  });
  const stampedOf = (inv) => (inv.line_items || []).find((li) => li.membership_dues_month);
  const reload = (id) => mockPg('invoices').where({ id }).first();

  async function mintDues(f, label) {
    const visit = await seedVisit(f, { label });
    expect(await complete(f, visit)).toMatchObject({ status: 200 });
    const rows = await invoicesFor(f);
    return { visit, invoice: rows.find((r) => r.scheduled_service_id === visit) };
  }

  // Run `fn` just before the completion's service_record INSERT (inside its
  // transaction, ahead of the status flip and commit), once.
  function beforeRecordInsert(fn) {
    const driver = Object.getPrototypeOf(mockPg.client);
    const originalQuery = driver._query;
    let armed = true;
    driver._query = function patched(connection, obj) {
      if (armed && /insert into "service_records"/i.test(String(obj?.sql || ''))) {
        armed = false;
        return Promise.resolve(fn()).then(() => originalQuery.call(this, connection, obj));
      }
      return originalQuery.call(this, connection, obj);
    };
    return () => { driver._query = originalQuery; };
  }

  // ── Finding 1 ────────────────────────────────────────────────────────────
  test('a concurrent change of the customer\'s billing terms cannot slip between the mint\'s read and its insert: the mint waits on it, sees the new rate and refuses', async () => {
    const InvoiceService = InvoiceSvc;
    const original = InvoiceService.createFromService;
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      jest.spyOn(InvoiceService, 'createFromService').mockImplementation(async (...args) => {
        // An UPDATE of the rate, uncommitted, is in flight when the mint starts; it commits shortly after.
        const trx = await mockPg.transaction();
        await trx('customers').where({ id: f.customerId }).update({ monthly_rate: 59 });
        setTimeout(() => trx.commit().catch(() => {}), 500);
        return original.apply(InvoiceService, args);
      });
      const key = randomUUID();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 503, body: { code: 'membership_dues_coverage_unverified' } });
      expect(await invoicesFor(f)).toHaveLength(0);
      jest.restoreAllMocks();
      expect(await complete(f, lawn, {}, key)).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total)).toBe(59);
    } finally { await cleanup(f); }
  });

  // ── Finding 2 ────────────────────────────────────────────────────────────
  test('the covered-skip verdict is committed under the dues-month lock: a lock held by a remover at the commit refuses the closeout to retry, committing nothing', async () => {
    const f = await seedMember();
    let restore;
    try {
      const a = await mintDues(f, 'Lawn Care');
      const pest = await seedVisit(f, { label: 'Pest Control' });
      restore = beforeRecordInsert(async () => {
        const trx = await mockPg.transaction();
        holds.push(trx);
        await acquireMembershipDuesMonthLock(trx, f.customerId, monthOf(etDateString()));
      });
      await expect(complete(f, pest)).rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_COVERAGE_CHANGED', statusCode: 409, isOperational: true });
      restore(); restore = null;
      expect((await mockPg('scheduled_services').where({ id: pest }).first()).status).not.toBe('completed');
      expect(await mockPg('service_records').where({ scheduled_service_id: pest })).toHaveLength(0);
      while (holds.length) await holds.pop().rollback();
      // The retry, nothing held, is still covered by A and mints nothing.
      expect(await complete(f, pest)).toMatchObject({ status: 200 });
      expect((await liveInvoicesFor(f)).map((r) => r.id)).toEqual([a.invoice.id]);
    } finally { if (restore) restore(); await cleanup(f); }
  });

  test('the covering invoice voided before the closeout commits: the closeout is refused, and its retry mints the month (one stamped live bill)', async () => {
    const f = await seedMember();
    let restore;
    try {
      const a = await mintDues(f, 'Lawn Care');
      const pest = await seedVisit(f, { label: 'Pest Control' });
      restore = beforeRecordInsert(() => InvoiceSvc.voidInvoice(a.invoice.id));
      await expect(complete(f, pest)).rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_COVERAGE_CHANGED', statusCode: 409 });
      restore(); restore = null;
      expect(await complete(f, pest)).toMatchObject({ status: 200 });
      const stamped = (await liveInvoicesFor(f)).filter((r) => stampedOf(r));
      expect(stamped).toHaveLength(1);
      expect(stamped[0].scheduled_service_id).toBe(pest);
    } finally { if (restore) restore(); await cleanup(f); }
  });

  async function dueAlertRows(invoiceId) {
    return mockPg('notifications').whereRaw('metadata::text LIKE ?', [`%dues_coverage_released:${invoiceId}%`]);
  }

  test('voiding the dues invoice after a visit was completed as covered by it raises ONE office alert; nothing is billed automatically', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      await mintDues(f, 'Pest Control'); // covered: completed with no invoice of its own
      expect(await invoicesFor(f)).toHaveLength(1);
      await InvoiceSvc.voidInvoice(a.invoice.id);
      const alerts = await dueAlertRows(a.invoice.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0].title || alerts[0].body).toMatch(/rebill|dues/i);
      expect(await invoicesFor(f)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a backdated closeout (completed_at before the dues invoice existed) still raises the alert when that invoice is voided', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const pest = await seedVisit(f, { label: 'Pest Control' });
      expect(await complete(f, pest)).toMatchObject({ status: 200 }); // covered by A
      await mockPg('scheduled_services').where({ id: pest })
        .update({ completed_at: mockPg.raw("(SELECT created_at - interval '2 hours' FROM invoices WHERE id = ?)", [a.invoice.id]) });
      await InvoiceSvc.voidInvoice(a.invoice.id);
      expect(await dueAlertRows(a.invoice.id)).toHaveLength(1);
    } finally { await cleanup(f); }
  });

  test('a recurring plan visit with a positive display price, covered by the dues invoice, is named by the void alert; a callback and an independently invoiced visit are not', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const priced = await seedVisit(f, { label: 'Pest Control', estimatedPrice: 85 });
      expect(await complete(f, priced)).toMatchObject({ status: 200 }); // recurring + priced: covered by the dues, no invoice
      const callback = await seedVisit(f, { label: 'Callback Visit' });
      await mockPg('scheduled_services').where({ id: callback }).update({ is_callback: true });
      expect(await complete(f, callback)).toMatchObject({ status: 200 });
      const billed = await seedVisit(f, { label: 'One-off Treatment', estimatedPrice: 120 });
      await mockPg('scheduled_services').where({ id: billed }).update({ is_recurring: false });
      expect(await complete(f, billed)).toMatchObject({ status: 200 }); // not covered: bills on its own invoice
      expect(await mockPg('invoices').where({ scheduled_service_id: priced })).toHaveLength(0);
      expect((await mockPg('invoices').where({ scheduled_service_id: billed })).length).toBeGreaterThan(0);
      await InvoiceSvc.voidInvoice(a.invoice.id);
      const alerts = await dueAlertRows(a.invoice.id);
      expect(alerts).toHaveLength(1);
      const text = JSON.stringify(alerts[0]);
      expect(text).toContain(priced);
      expect(text).not.toContain(callback);
      expect(text).not.toContain(billed);
    } finally { await cleanup(f); }
  });

  test('void, restore, cover another visit, void again: the restore closes the standing alert and the second void raises it again with the new details', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const first = await seedVisit(f, { label: 'Pest Control' });
      expect(await complete(f, first)).toMatchObject({ status: 200 });
      await InvoiceSvc.voidInvoice(a.invoice.id);
      let rows = await dueAlertRows(a.invoice.id);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).toContain(first);

      await InvoiceSvc.unvoidInvoice(a.invoice.id);
      rows = await dueAlertRows(a.invoice.id);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].metadata)).toContain('autoCleared');
      expect(rows[0].read_at).not.toBeNull();

      const second = await seedVisit(f, { label: 'Mosquito' });
      expect(await complete(f, second)).toMatchObject({ status: 200 }); // covered by the restored A
      await InvoiceSvc.voidInvoice(a.invoice.id);
      rows = await dueAlertRows(a.invoice.id);
      const open = rows.filter((r) => r.read_at == null);
      expect(open).toHaveLength(1);
      const text = JSON.stringify(open[0]);
      expect(text).toContain(second);
      expect(text).toContain(first);
    } finally { await cleanup(f); }
  });

  test('no alert when nothing was unbilled by the void: no other covered visit, or the month is still covered by another stamped invoice', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      await InvoiceSvc.voidInvoice(a.invoice.id);
      expect(await dueAlertRows(a.invoice.id)).toHaveLength(0);
      const b = await mintDues(f, 'Pest Control'); // bills the month again on B
      const c = await seedVisit(f, { label: 'Mosquito' });
      expect(await complete(f, c)).toMatchObject({ status: 200 }); // covered by B
      await InvoiceSvc.voidInvoice(b.invoice.id);
      // B voided: the month is uncovered and visit c relied on it → one alert for B.
      expect(await dueAlertRows(b.invoice.id)).toHaveLength(1);
    } finally { await cleanup(f); }
  });
});

// The stamp goes only on the line the builder marks as the visit's primary
// service line. Scheduled add-ons that total at least the monthly rate leave no
// primary line (the builder emits add-on lines plus a price adjustment down to
// the rate): that invoice must NOT be stamped as the month's dues.
postgres('membership dues — add-ons totaling the rate never carry the dues stamp (B08)', () => {
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  afterEach(() => { jest.restoreAllMocks(); });
  const stampedOf = (inv) => (inv.line_items || []).find((li) => li.membership_dues_month);

  test('an unpriced plan visit whose scheduled add-on is at least the rate mints UNSTAMPED (no primary line), and the next plan visit still bills the month (stamped)', async () => {
    const f = await seedMember(); // rate 49
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      // One add-on of 60: no primary line is emitted (49 - 60 < 0) and a -11 price adjustment brings the
      // invoice to 49, so add-on + adjustment equals the rate: the shape the old position-based pick stamped.
      await mockPg('scheduled_service_addons').insert({ id: randomUUID(), scheduled_service_id: lawn, service_name: 'Big Add-on', estimated_price: 60 });
      expect(await complete(f, lawn)).toMatchObject({ status: 200 });
      let rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].total)).toBe(49);
      expect(rows.filter((r) => stampedOf(r))).toHaveLength(0);
      // The month is not marked covered: the next plan visit bills it.
      const pest = await seedVisit(f, { label: 'Pest Control' });
      expect(await complete(f, pest)).toMatchObject({ status: 200 });
      rows = await invoicesFor(f);
      const stamped = rows.filter((r) => stampedOf(r));
      expect(stamped).toHaveLength(1);
      expect(stamped[0].scheduled_service_id).toBe(pest);
      expect(Number(stamped[0].total)).toBe(49);
    } finally {
      await mockPg('scheduled_service_addons').whereIn('scheduled_service_id', f.visitIds).del().catch(() => {});
      await cleanup(f);
    }
  });

  test('a plain unpriced plan visit stamps its PRIMARY service line (identified by client_id), not another line', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      expect(await complete(f, lawn)).toMatchObject({ status: 200 });
      const rows = await invoicesFor(f);
      expect(rows).toHaveLength(1);
      expect(stampedOf(rows[0])).toMatchObject({ client_id: `scheduled_${lawn}_primary` });
    } finally { await cleanup(f); }
  });
});

// Round 6: prepaid markers, refunds, payer resolution, owner re-read, completion copy.
postgres('membership dues — prepaid marker, refund alert, payer, merge, copy (B08 round 6)', () => {
  const InvoiceSvc = require('../services/invoice');
  const { duesInvoiceCoveringPlanVisit, recordPrepaidUnderDuesLock, duesCoversPrepaidRefusal } = require('../routes/admin-schedule')._test;
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 10 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  afterEach(() => { jest.restoreAllMocks(); });
  async function mintDues(f, label) {
    const visit = await seedVisit(f, { label });
    expect(await complete(f, visit)).toMatchObject({ status: 200 });
    return { visit, invoice: await mockPg('invoices').where({ customer_id: f.customerId, scheduled_service_id: visit }).first() };
  }
  async function alertRows(invoiceId) {
    return mockPg('notifications').whereRaw('metadata::text LIKE ?', [`%dues_coverage_released:${invoiceId}%`]);
  }

  // ── Finding 1: a prepaid marker on a covered plan visit ──
  test('a second same-month plan visit is covered by the dues invoice: the prepaid pre-check names that invoice; the dues invoice\'s own visit, a priced visit and a month with no dues invoice are not refused', async () => {
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const second = await seedVisit(f, { label: 'Pest Control' });
      const covering = await duesInvoiceCoveringPlanVisit(second);
      expect(covering).toMatchObject({ id: a.invoice.id });
      const refusal = duesCoversPrepaidRefusal(covering);
      expect(refusal).toMatchObject({ code: 'membership_dues_invoice_covers', invoice_id: a.invoice.id, invoice_number: a.invoice.invoice_number });
      expect(refusal.error).toContain(a.invoice.invoice_number);
      expect(await duesInvoiceCoveringPlanVisit(a.visit)).toBeNull(); // its own invoice is not "covering" it
      const priced = await seedVisit(f, { label: 'Add-on Treatment', estimatedPrice: 85 });
      await mockPg('scheduled_services').where({ id: priced }).update({ is_recurring: false });
      expect(await duesInvoiceCoveringPlanVisit(priced)).toBeNull();
      await mockPg('invoices').where({ id: a.invoice.id }).update({ status: 'void' });
      expect(await duesInvoiceCoveringPlanVisit(second)).toBeNull();
    } finally { await cleanup(f); }
  });

  // ── The prepaid marker is recorded atomically with the coverage decision ──
  const writeMarker = (serviceId, amount = 49) => (conn) => conn('scheduled_services').where({ id: serviceId })
    .update({ prepaid_amount: amount, prepaid_method: 'cash', prepaid_note: null, prepaid_at: mockPg.fn.now() })
    .returning(['id', 'prepaid_amount', 'prepaid_method', 'prepaid_note', 'prepaid_at']);
  const prepaidOf = async (id) => (await mockPg('scheduled_services').where({ id }).first('prepaid_amount')).prepaid_amount;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settled = (p) => Promise.race([p.then(() => 'done', () => 'done'), sleep(600).then(() => 'pending')]);

  test('uncovered month: the marker is written; covered month: refused naming the invoice, nothing written', async () => {
    const f = await seedMember();
    try {
      const first = await seedVisit(f, { label: 'Lawn Care' });
      const written = await recordPrepaidUnderDuesLock(first, { amount: 49, writeStamp: writeMarker(first) });
      expect(written.covering).toBeUndefined();
      expect(written.updated).toHaveLength(1);
      expect(Number(await prepaidOf(first))).toBe(49);
      await mockPg('scheduled_services').where({ id: first }).update({ prepaid_amount: null, prepaid_method: null, prepaid_at: null });
      const a = await mintDues(f, 'Pest Control');
      const second = await seedVisit(f, { label: 'Mosquito' });
      const refused = await recordPrepaidUnderDuesLock(second, { amount: 49, writeStamp: writeMarker(second) });
      expect(refused.covering).toMatchObject({ id: a.invoice.id });
      expect(await prepaidOf(second)).toBeNull();
    } finally { await cleanup(f); }
  });

  test('a sibling dues invoice committing while the marker waits on the month lock is SEEN: refused, no marker (no receipt request involved)', async () => {
    const f = await seedMember();
    try {
      const marked = await seedVisit(f, { label: 'Lawn Care' });
      const sibling = await seedVisit(f, { label: 'Pest Control' });
      const { acquireMembershipDuesMonthLock } = require('../services/billing-lane');
      const hold = await mockPg.transaction(); // plays the sibling's dues mint: holds the lock, inserts the stamped invoice, then commits
      try {
        await acquireMembershipDuesMonthLock(hold, f.customerId, monthOf(etDateString()));
        const pending = recordPrepaidUnderDuesLock(marked, { amount: 49, writeStamp: writeMarker(marked) });
        expect(await settled(pending)).toBe('pending'); // it WAITS (first lock of its transaction)
        expect(await prepaidOf(marked)).toBeNull();
        await hold('invoices').insert({ id: randomUUID(), token: randomUUID().replace(/-/g, ''), invoice_number: `B08-${randomUUID().slice(0, 8)}`,
          customer_id: f.customerId, scheduled_service_id: sibling, status: 'sent', total: 49, subtotal: 49,
          line_items: JSON.stringify([{ description: 'Pest Control', quantity: 1, unit_price: 49, amount: 49, membership_dues_month: monthOf(etDateString()) }]) });
        await hold.commit();
        const result = await pending;
        expect(result.covering).toBeTruthy();
        expect(await prepaidOf(marked)).toBeNull();
      } finally { await hold.rollback().catch(() => {}); }
    } finally { await cleanup(f); }
  });

  test('the visit moved to another month between the unlocked scope read and the marker write: retryable refusal, the marker is rolled back', async () => {
    const f = await seedMember();
    let restore;
    try {
      const visit = await seedVisit(f, { label: 'Lawn Care' });
      const driver = Object.getPrototypeOf(mockPg.client);
      const originalQuery = driver._query;
      let armed = true;
      driver._query = function patched(connection, obj) {
        if (armed && /pg_advisory_xact_lock/i.test(String(obj?.sql || '')) && JSON.stringify(obj?.bindings || []).includes('membership.dues_month')) {
          armed = false; // after the scope read, before the lock: the visit is rescheduled to another month
          return mockPg('scheduled_services').where({ id: visit }).update({ scheduled_date: previousMonthDay() })
            .then(() => originalQuery.call(this, connection, obj));
        }
        return originalQuery.call(this, connection, obj);
      };
      restore = () => { driver._query = originalQuery; };
      await expect(recordPrepaidUnderDuesLock(visit, { amount: 49, writeStamp: writeMarker(visit) })).rejects.toMatchObject({ status: 409 });
      restore(); restore = null;
      expect(await prepaidOf(visit)).toBeNull();
    } finally { if (restore) restore(); await cleanup(f); }
  });

  test('marker first, then a sibling dues mint (reverse order, no receipt): the month is billed once; the prepaid visit mints no invoice of its own and its cash stays on the visit (stated limit)', async () => {
    const f = await seedMember();
    try {
      const marked = await seedVisit(f, { label: 'Lawn Care' });
      await recordPrepaidUnderDuesLock(marked, { amount: 49, writeStamp: writeMarker(marked) });
      const sibling = await mintDues(f, 'Pest Control');
      expect(await complete(f, marked)).toMatchObject({ status: 200 });
      const live = await mockPg('invoices').where({ customer_id: f.customerId }).whereNotIn('status', ['void', 'refunded', 'canceled', 'cancelled']);
      expect(live.map((r) => r.id)).toEqual([sibling.invoice.id]); // billed once, nothing double-billed
      expect(Number(await prepaidOf(marked))).toBe(49); // the cash is on the visit, not applied to the sibling's invoice
      expect(sibling.invoice.status).not.toBe('paid');
    } finally { await cleanup(f); }
  });

  // ── Round 7: owner re-read, refund vs completion, void vs collector ──
  test('the stamp refuses a visit whose owner changed after the caller read the service record (a merge): retryable, nothing locked for the old customer', async () => {
    const f = await seedMember();
    const g = await seedMember();
    let visit;
    try {
      visit = await seedVisit(f, { label: 'Lawn Care' });
      await mockPg('scheduled_services').where({ id: visit }).update({ customer_id: g.customerId });
      const lines = [{ client_id: `scheduled_${visit}_primary`, description: 'Lawn', quantity: 1, unit_price: 49, amount: 49 }];
      await expect(mockPg.transaction((trx) => InvoiceSvc.stampMembershipDuesUnderLock(trx, {
        customerId: f.customerId, scheduledServiceId: visit, month: monthOf(etDateString()), lineItems: lines, derivedAmount: 49,
      }))).rejects.toMatchObject({ code: 'SCHEDULED_BILLING_SOURCE_MOVED' });
    } finally {
      if (visit) await mockPg('scheduled_services').where({ id: visit }).update({ customer_id: f.customerId }).catch(() => {});
      await cleanup(g);
      await cleanup(f);
    }
  });

  test('a full refund of a stamped dues invoice while a covered completion holds the month lock is refused retryably (invoice stays paid); once released it goes through', async () => {
    const { returnAppliedCreditOnRefund } = require('../services/customer-credit');
    const { acquireMembershipDuesMonthLock } = require('../services/billing-lane');
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      await mockPg('invoices').where({ id: a.invoice.id }).update({ status: 'paid', paid_at: new Date() });
      const completion = await mockPg.transaction(); // plays a completion that confirmed coverage and has not committed
      try {
        await acquireMembershipDuesMonthLock(completion, f.customerId, monthOf(etDateString()));
        await expect(mockPg.transaction((trx) => returnAppliedCreditOnRefund({ invoiceId: a.invoice.id }, trx)))
          .rejects.toMatchObject({ code: 'MEMBERSHIP_DUES_MONTH_BUSY' });
        expect((await mockPg('invoices').where({ id: a.invoice.id }).first()).status).toBe('paid');
        await completion.commit();
      } finally { await completion.rollback().catch(() => {}); }
      await mockPg.transaction((trx) => returnAppliedCreditOnRefund({ invoiceId: a.invoice.id }, trx));
      expect((await mockPg('invoices').where({ id: a.invoice.id }).first()).status).toBe('refunded');
    } finally { await cleanup(f); }
  });

  test('a void (and the cancelled-visit void) while a collector holds the customer collection claim is refused retryably: the invoice stays live; after the collector finishes the void goes through', async () => {
    const { withCustomerBillingLock } = require('../utils/customer-billing-lock');
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      let voidError = null;
      let cancelResult = null;
      await withCustomerBillingLock(f.customerId, async () => {
        voidError = await InvoiceSvc.voidInvoice(a.invoice.id).then(() => null, (e) => e);
        cancelResult = await InvoiceSvc.voidOpenInvoicesForCancelledService(a.visit);
      });
      expect(voidError).toMatchObject({ code: 'MEMBERSHIP_DUES_COLLECTION_IN_PROGRESS' });
      expect(cancelResult).toEqual([]);
      expect((await mockPg('invoices').where({ id: a.invoice.id }).first()).status).not.toBe('void');
      await InvoiceSvc.voidInvoice(a.invoice.id);
      expect((await mockPg('invoices').where({ id: a.invoice.id }).first()).status).toBe('void');
    } finally { await cleanup(f); }
  });

  // ── Finding 2: a full refund releases coverage like a void ──
  test('a fully refunded stamped dues invoice raises the rebill alert for the visits it covered, once the refund transaction commits', async () => {
    const { returnAppliedCreditOnRefund } = require('../services/customer-credit');
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const covered = await seedVisit(f, { label: 'Pest Control' });
      expect(await complete(f, covered)).toMatchObject({ status: 200 });
      await mockPg('invoices').where({ id: a.invoice.id }).update({ status: 'paid', paid_at: new Date() });
      await mockPg.transaction(async (trx) => { await returnAppliedCreditOnRefund({ invoiceId: a.invoice.id }, trx); });
      for (let i = 0; i < 40 && !(await alertRows(a.invoice.id)).length; i += 1) await new Promise((r) => setTimeout(r, 100));
      const rows = await alertRows(a.invoice.id);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0])).toContain(covered);
      expect(JSON.stringify(rows[0])).toMatch(/refunded/);
    } finally { await cleanup(f); }
  });

  // ── Finding 3: payer ownership is resolved like completion does ──
  test('a covered visit whose payer is INACTIVE is self-pay and is named by the void alert; one with an ACTIVE payer is not', async () => {
    const f = await seedMember();
    const payerIds = [];
    try {
      const a = await mintDues(f, 'Lawn Care');
      const inactiveVisit = await seedVisit(f, { label: 'Pest Control' });
      const activeVisit = await seedVisit(f, { label: 'Mosquito' });
      expect(await complete(f, inactiveVisit)).toMatchObject({ status: 200 });
      expect(await complete(f, activeVisit)).toMatchObject({ status: 200 });
      const mkPayer = async (active) => {
        const [{ id }] = await mockPg('payers').insert({ display_name: `Fixture Payer ${randomUUID().slice(0, 6)}`, active }).returning('id');
        payerIds.push(id);
        return id;
      };
      await mockPg('scheduled_services').where({ id: inactiveVisit }).update({ payer_id: await mkPayer(false) });
      await mockPg('scheduled_services').where({ id: activeVisit }).update({ payer_id: await mkPayer(true) });
      await InvoiceSvc.voidInvoice(a.invoice.id);
      const rows = await alertRows(a.invoice.id);
      expect(rows).toHaveLength(1);
      const text = JSON.stringify(rows[0]);
      expect(text).toContain(inactiveVisit);
      expect(text).not.toContain(activeVisit);
    } finally {
      await mockPg('scheduled_services').where({ customer_id: f.customerId }).update({ payer_id: null }).catch(() => {});
      await cleanup(f);
      await mockPg('payers').whereIn('id', payerIds).del().catch(() => {});
    }
  });

  // ── Finding 4: the month lock follows the invoice's CURRENT owner ──
  // Run `fn` once, just before the void's first dues-month lock statement: after the
  // writer's pre-transaction read and the transaction's own unlocked owner read.
  function beforeFirstMonthLock(fn) {
    const driver = Object.getPrototypeOf(mockPg.client);
    const originalQuery = driver._query;
    let armed = true;
    driver._query = function patched(connection, obj) {
      if (armed && /pg_advisory_xact_lock/i.test(String(obj?.sql || ''))
        && JSON.stringify(obj?.bindings || []).includes('membership.dues_month')) {
        armed = false;
        return Promise.resolve(fn()).then(() => originalQuery.call(this, connection, obj));
      }
      return originalQuery.call(this, connection, obj);
    };
    return () => { driver._query = originalQuery; };
  }

  test('a customer merge that repoints the invoice after the void took the lock: the void refuses retryably and voids nothing; the retry locks the NEW owner\'s month and voids', async () => {
    const f = await seedMember();
    const g = await seedMember();
    let restore;
    try {
      const a = await mintDues(f, 'Lawn Care');
      // (the merge also drops the visit link here so the void's linked-visit guards stay out of this test)
      restore = beforeFirstMonthLock(() => mockPg('invoices').where({ id: a.invoice.id }).update({ customer_id: g.customerId, scheduled_service_id: null }));
      await expect(InvoiceSvc.voidInvoice(a.invoice.id)).rejects.toThrow(/ownership changed/i);
      restore(); restore = null;
      expect((await mockPg('invoices').where({ id: a.invoice.id }).first()).status).not.toBe('void');
      // The retry reads the new owner and takes THAT customer's month lock: held elsewhere, it waits.
      const { acquireMembershipDuesMonthLock } = require('../services/billing-lane');
      const hold = await mockPg.transaction();
      try {
        await acquireMembershipDuesMonthLock(hold, g.customerId, monthOf(etDateString()));
        let state = 'pending';
        const voiding = InvoiceSvc.voidInvoice(a.invoice.id).then(() => { state = 'done'; }, () => { state = 'failed'; });
        await new Promise((r) => setTimeout(r, 700));
        expect(state).toBe('pending');
        await hold.commit();
        await voiding;
        expect(state).toBe('done');
      } finally { await hold.rollback().catch(() => {}); }
      expect((await mockPg('invoices').where({ id: a.invoice.id }).first()).status).toBe('void');
    } finally {
      if (restore) restore();
      await cleanup(g);
      await cleanup(f);
    }
  });

  // ── Finding 5: covered is not settled ──
  // The completion text picks the paid template only for SETTLED dues coverage;
  // the settled test is this lookup (openInvoiceCovers: false). The wiring itself
  // is pinned in admin-dispatch-autoinvoice-gate.test.js.
  test('an OPEN stamped dues invoice covers the month but is not settled; a paid / prepaid / processing one is', async () => {
    const { monthlyDuesCollected } = require('../services/billing-lane');
    const f = await seedMember();
    try {
      const a = await mintDues(f, 'Lawn Care');
      const now = new Date();
      const covered = () => monthlyDuesCollected(mockPg, f.customerId, now);
      const settled = () => monthlyDuesCollected(mockPg, f.customerId, now, { openInvoiceCovers: false });
      expect(await covered()).toBe(true);
      expect(await settled()).toBe(false);
      for (const status of ['paid', 'prepaid', 'processing']) {
        await mockPg('invoices').where({ id: a.invoice.id }).update({ status });
        expect(await settled()).toBe(true);
      }
    } finally { await cleanup(f); }
  });
});

// The dues-month lock rule (billing-lane.js, THE LOCK RULE): a transaction that
// already holds a customer / visit / mint lock never WAITS on the month lock.
// The deadlock this pins: a credit-applied stamped invoice's void takes the
// month lock first and then wants the customer FOR UPDATE for its credit
// restore, while a sibling same-month mint holds the customer FOR SHARE and (as
// a blocking take) waited for the month lock. Now the mint polls the try form
// for a bounded time and refuses retryably.
postgres('membership dues — a void returning applied credit vs a sibling same-month mint (B08 lock rule)', () => {
  const InvoiceSvc = require('../services/invoice');
  const { mintOrReuseScheduledServiceInvoice } = require('../routes/admin-schedule')._test;
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 10 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  afterEach(() => { jest.restoreAllMocks(); delete process.env.MEMBERSHIP_DUES_MINT_WAIT_MS; });
  const stampedOf = (inv) => (inv.line_items || []).find((li) => li.membership_dues_month);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function loadSvc(visitId) {
    return mockPg('scheduled_services').where('scheduled_services.id', visitId)
      .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
      .select('scheduled_services.*', 'customers.monthly_rate as cust_monthly_rate', 'customers.waveguard_tier as cust_waveguard_tier',
        'customers.billing_mode as cust_billing_mode', 'customers.property_type as cust_property_type')
      .first();
  }

  // Run `fn` once, inside the mint's transaction, just before its FIRST try of
  // the dues-month lock: at that point the mint already holds the customer FOR
  // SHARE and the visit row.
  function beforeMintTakesMonthLock(fn) {
    const driver = Object.getPrototypeOf(mockPg.client);
    const originalQuery = driver._query;
    let armed = true;
    driver._query = function patched(connection, obj) {
      if (armed && /pg_try_advisory_xact_lock/i.test(String(obj?.sql || ''))
        && JSON.stringify(obj?.bindings || []).includes('membership.dues_month')) {
        armed = false;
        return Promise.resolve(fn()).then(() => originalQuery.call(this, connection, obj));
      }
      return originalQuery.call(this, connection, obj);
    };
    return () => { driver._query = originalQuery; };
  }

  // True once some backend is queued on a row lock of a customers statement
  // (the void's credit restore waiting on the mint's FOR SHARE).
  async function waitForCustomerLockWaiter() {
    for (let i = 0; i < 100; i += 1) {
      const { rows } = await mockPg.raw(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%customers%'",
      );
      if (rows[0].n > 0) return true;
      await sleep(50);
    }
    return false;
  }

  const runners = [
    ['voidInvoice', (a) => InvoiceSvc.voidInvoice(a.invoice.id)],
    ['the cancelled-visit void', (a) => InvoiceSvc.voidOpenInvoicesForCancelledService(a.visit)],
  ];
  test.each(runners)('credit-applied stamped invoice voided (%s) while a sibling mint holds the customer share lock: no deadlock, the void commits and returns the credit, the mint refuses retryably and its retry bills the month', async (_name, runVoid) => {
    process.env.MEMBERSHIP_DUES_MINT_WAIT_MS = '600';
    const f = await seedMember();
    let restore;
    try {
      const a = await (async () => {
        const visit = await seedVisit(f, { label: 'Lawn Care' });
        expect(await complete(f, visit)).toMatchObject({ status: 200 });
        return { visit, invoice: (await mockPg('invoices').where({ customer_id: f.customerId, scheduled_service_id: visit }).first()) };
      })();
      expect(stampedOf(a.invoice)).toBeTruthy();
      await mockPg('invoices').where({ id: a.invoice.id }).update({ credit_applied: 10 });
      const creditBefore = Number((await mockPg('customers').where({ id: f.customerId }).first()).account_credits || 0);
      const pest = await seedVisit(f, { label: 'Pest Control' });

      let voiding;
      let waiterSeen = false;
      restore = beforeMintTakesMonthLock(async () => {
        // The void starts now (it takes the month lock, then queues for the customer row the mint shares).
        voiding = runVoid(a);
        voiding.catch(() => {});
        waiterSeen = await waitForCustomerLockWaiter();
      });
      const minted = await mintOrReuseScheduledServiceInvoice(await loadSvc(pest));
      restore(); restore = null;

      expect(waiterSeen).toBe(true);
      // The mint did not wait on the month lock while holding the customer lock: retryable refusal, nothing inserted.
      expect(minted).toEqual({ invoice: null, reason: 'membership_dues_unverified' });
      // The void was not aborted as a deadlock victim: it committed and returned the credit.
      await expect(voiding).resolves.toBeDefined();
      expect((await mockPg('invoices').where({ id: a.invoice.id }).first())).toMatchObject({ status: 'void' });
      expect(Number((await mockPg('invoices').where({ id: a.invoice.id }).first()).credit_applied)).toBe(0);
      const creditAfter = Number((await mockPg('customers').where({ id: f.customerId }).first()).account_credits || 0);
      expect(creditAfter).toBeCloseTo(creditBefore + 10, 2);
      expect(await mockPg('customer_credit_ledger').where({ customer_id: f.customerId, invoice_id: a.invoice.id })).toHaveLength(1);

      // The retry finds the month uncovered and bills it once, stamped.
      const retry = await mintOrReuseScheduledServiceInvoice(await loadSvc(pest));
      expect(retry.invoice).toBeTruthy();
      const live = (await mockPg('invoices').where({ customer_id: f.customerId })
        .whereNotIn('status', ['void', 'refunded', 'canceled', 'cancelled']));
      expect(live.map((r) => r.id)).toEqual([retry.invoice.id]);
      expect(stampedOf(live[0])).toMatchObject({ membership_dues_month: monthOf(etDateString()) });
    } finally {
      if (restore) restore();
      await mockPg('customer_credit_ledger').where({ customer_id: f.customerId }).del().catch(() => {});
      await cleanup(f);
    }
  });

  test('two sibling mints still serialize: the second waits (polls) for the first to commit, then re-reads coverage and is refused as covered', async () => {
    const f = await seedMember();
    try {
      const lawn = await seedVisit(f, { label: 'Lawn Care' });
      const pest = await seedVisit(f, { label: 'Pest Control' });
      const [first, second] = await Promise.all([
        mintOrReuseScheduledServiceInvoice(await loadSvc(lawn)),
        mintOrReuseScheduledServiceInvoice(await loadSvc(pest)),
      ]);
      const results = [first, second];
      expect(results.filter((r) => r.invoice)).toHaveLength(1);
      expect(results.filter((r) => !r.invoice).map((r) => r.reason)).toEqual(['membership_dues_covered']);
      const live = await mockPg('invoices').where({ customer_id: f.customerId }).whereNotIn('status', ['void', 'refunded', 'canceled', 'cancelled']);
      expect(live).toHaveLength(1);
    } finally { await cleanup(f); }
  });
});

// The month key itself, straight against the helper: a visit instant late on
// the last ET day is that month's, even though UTC has already rolled over.
postgres('monthlyDuesCollected — ET month attribution of a stamped dues invoice (B08)', () => {
  const { monthlyDuesCollected, MEMBERSHIP_DUES_LINE_KEY } = require('../services/billing-lane');
  let f;
  beforeAll(() => { mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 2 } }); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => { f = await seedMember(); });
  afterEach(async () => { await cleanup(f); });

  async function insertDuesInvoice(month, status = 'sent', scheduledServiceId = null) {
    const id = randomUUID();
    await mockPg('invoices').insert({ id, token: randomUUID().replace(/-/g, ''), invoice_number: `B08-${id.slice(0, 8)}`,
      customer_id: f.customerId, scheduled_service_id: scheduledServiceId, status, total: 49, subtotal: 49,
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 49, amount: 49, [MEMBERSHIP_DUES_LINE_KEY]: month }]) });
    return id;
  }

  test('(g) 11:30 PM ET on the last day of September is September, though UTC is already October', async () => {
    await insertDuesInvoice('2026-09');
    const lastNight = new Date('2026-10-01T03:30:00Z'); // 11:30 PM EDT, Sept 30
    expect(etDateString(lastNight)).toBe('2026-09-30');
    await expect(monthlyDuesCollected(mockPg, f.customerId, lastNight)).resolves.toBe(true);
    // 12:30 AM ET Oct 1 is October: September's invoice no longer covers it.
    const justAfter = new Date('2026-10-01T04:30:00Z');
    expect(etDateString(justAfter)).toBe('2026-10-01');
    await expect(monthlyDuesCollected(mockPg, f.customerId, justAfter)).resolves.toBe(false);
  });

  test('a void / refunded / canceled dues invoice covers nothing; paid, processing, draft and open all do', async () => {
    for (const status of ['void', 'refunded', 'canceled', 'cancelled']) {
      const id = await insertDuesInvoice('2026-09', status);
      await expect(monthlyDuesCollected(mockPg, f.customerId, new Date('2026-09-10T16:00:00Z'))).resolves.toBe(false);
      await mockPg('invoices').where({ id }).del();
    }
    for (const status of ['draft', 'sent', 'viewed', 'overdue', 'processing', 'paid']) {
      const id = await insertDuesInvoice('2026-09', status);
      await expect(monthlyDuesCollected(mockPg, f.customerId, new Date('2026-09-10T16:00:00Z'))).resolves.toBe(true);
      await mockPg('invoices').where({ id }).del();
    }
  });

  test('only a PAID/processing dues invoice reads as collected when open invoices are not allowed to cover', async () => {
    const open = await insertDuesInvoice('2026-09', 'sent');
    const day = new Date('2026-09-10T16:00:00Z');
    await expect(monthlyDuesCollected(mockPg, f.customerId, day, { openInvoiceCovers: false })).resolves.toBe(false);
    await mockPg('invoices').where({ id: open }).update({ status: 'paid' });
    await expect(monthlyDuesCollected(mockPg, f.customerId, day, { openInvoiceCovers: false })).resolves.toBe(true);
  });

  test('a visit\'s OWN dues invoice never covers that visit, another visit\'s does; another customer\'s never does', async () => {
    const visit = await seedVisit(f);
    const otherVisit = await seedVisit(f, { label: 'Pest Control' });
    const invoiceId = await insertDuesInvoice('2026-09', 'sent', visit);
    const day = new Date('2026-09-10T16:00:00Z');
    await expect(monthlyDuesCollected(mockPg, f.customerId, day, { excludeScheduledServiceId: visit })).resolves.toBe(false);
    await expect(monthlyDuesCollected(mockPg, f.customerId, day, { excludeScheduledServiceId: otherVisit })).resolves.toBe(true);
    await expect(monthlyDuesCollected(mockPg, randomUUID(), day)).resolves.toBe(false);
    await mockPg('invoices').where({ id: invoiceId }).del();
  });

  test('an invoice minted before the stamp (no marker) is never recognized', async () => {
    await mockPg('invoices').insert({ id: randomUUID(), token: randomUUID().replace(/-/g, ''), invoice_number: `B08-${randomUUID().slice(0, 8)}`,
      customer_id: f.customerId, status: 'sent', total: 49, subtotal: 49,
      line_items: JSON.stringify([{ description: 'Lawn Care', quantity: 1, unit_price: 49, amount: 49 }]) });
    await expect(monthlyDuesCollected(mockPg, f.customerId, new Date('2026-09-10T16:00:00Z'))).resolves.toBe(false);
  });
});
