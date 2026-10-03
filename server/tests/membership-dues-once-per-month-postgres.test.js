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

async function complete(f, serviceId, overrides = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId, idempotencyKey: randomUUID(),
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
