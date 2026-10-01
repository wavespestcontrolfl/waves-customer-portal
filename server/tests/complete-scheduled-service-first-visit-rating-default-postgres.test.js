/**
 * Owner ruling 2026-09-29: the first-visit default pest rating (owner ruling
 * 2026-09-24 — server/services/pest-pressure/first-visit.js, #4741 / #4767)
 * must be flagged on write so email-division's activity averages can
 * exclude it later. This runs the real completeScheduledService transaction
 * (complete-scheduled-service.js ~6607-6627) against a migrated, private
 * Postgres clone and checks the written service_records row directly.
 *
 * Wiring copied from complete-scheduled-service-declined-station-checks.test.js.
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

// Verified private clone only — never a shared or production URL. Accepts
// this worktree's own waves_qa_rating_default clone (see the PR body for the
// createdb -T recipe) or CI's isolated waves_test, matching the guard
// convention email-division-postgres.test.js uses. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the exact marker the CI
// "DB-gated suites" step greps for (.github/workflows/tests.yml) to
// discover and run this file — without it CI silently skips it forever.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_qa_rating_default';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('First-visit rating default-flag Postgres tests require this worktree\'s own waves_qa_rating_default or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

async function seedPestVisit() {
  const { etDateString } = require('../utils/datetime-et');
  const today = etDateString();
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(),
    serviceKey: `fixture_pest_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'RatingDefault', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture General Pest Control ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  // Deliberately NO service_completion_profiles row: the resolver falls back
  // to DEFAULT_SERVICE_REPORT_PROFILE (untyped, completion_mode
  // 'service_report', findingsType null) — an ordinary recurring pest visit.
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture General Pest Control ${f.serviceKey}`, scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
  return f;
}

async function cleanup(f) {
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ id: f.serviceId }).del().catch(() => {});
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

async function complete(f, overrides = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null }, body: body(overrides) });
}

async function recordFor(f) {
  return mockPg('service_records').where({ customer_id: f.customerId }).first();
}

postgres('completion write — client_pest_rating_defaulted (owner ruling 2026-09-29)', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('untouched first-visit prefill (5, clientPestRatingPrefilled) writes client_pest_rating_defaulted = true', async () => {
    const f = await seedPestVisit();
    try {
      const out = await complete(f, { clientPestRating: 5, clientPestRatingPrefilled: true });
      expect(out).toMatchObject({ status: 200 });
      const record = await recordFor(f);
      expect(record.client_pest_rating).toBe(5);
      expect(record.client_pest_rating_source).toBe('technician');
      expect(record.client_pest_rating_defaulted).toBe(true);
    } finally { await cleanup(f); }
  });

  test('a technician-chosen 5 (not the untouched prefill) writes client_pest_rating_defaulted = false', async () => {
    const f = await seedPestVisit();
    try {
      // No clientPestRatingPrefilled: true — this is the tech's own submit,
      // even though the value happens to equal the default's.
      const out = await complete(f, { clientPestRating: 5 });
      expect(out).toMatchObject({ status: 200 });
      const record = await recordFor(f);
      expect(record.client_pest_rating).toBe(5);
      expect(record.client_pest_rating_source).toBe('technician');
      expect(record.client_pest_rating_defaulted).toBe(false);
    } finally { await cleanup(f); }
  });

  test('any other technician rating writes client_pest_rating_defaulted = false', async () => {
    const f = await seedPestVisit();
    try {
      const out = await complete(f, { clientPestRating: 2 });
      expect(out).toMatchObject({ status: 200 });
      const record = await recordFor(f);
      expect(record.client_pest_rating).toBe(2);
      expect(record.client_pest_rating_defaulted).toBe(false);
    } finally { await cleanup(f); }
  });

  test('with the column absent (pre-migration compatibility) the completion still writes the rating and does not fail', async () => {
    const f = await seedPestVisit();
    try {
      await mockPg.schema.alterTable('service_records', (t) => t.dropColumn('client_pest_rating_defaulted'));
      const out = await complete(f, { clientPestRating: 5, clientPestRatingPrefilled: true });
      expect(out).toMatchObject({ status: 200 });
      const record = await recordFor(f);
      expect(record.client_pest_rating).toBe(5);
      expect(record.client_pest_rating_source).toBe('technician');
      expect(record).not.toHaveProperty('client_pest_rating_defaulted');
    } finally {
      await mockPg.schema.alterTable('service_records', (t) => t.boolean('client_pest_rating_defaulted'));
      await cleanup(f);
    }
  });
});
