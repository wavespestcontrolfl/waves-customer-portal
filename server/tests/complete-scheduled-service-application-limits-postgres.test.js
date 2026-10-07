/**
 * The closeout never refuses for a hard product count limit (yearly applications, minimum
 * interval): the plan keeps the block, the closeout records every submitted product (the actuals
 * and the compliance ledger) and FLAGS an over-limit application for the office. This runs the real
 * completeScheduledService transaction against a migrated, private Postgres clone.
 *
 * Wiring copied from complete-scheduled-service-first-visit-rating-default-postgres.test.js.
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

// Verified private clone only — never a shared or production URL. Accepts this worktree's own
// waves_qa_count_caps clone or CI's isolated waves_test. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the marker the CI "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_qa_count_caps';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Application-limit closeout Postgres tests require this worktree\'s own waves_qa_count_caps or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const LAWN_TYPE = 'Every 6 Weeks Lawn Care Service';

async function seedLawnVisit({ priorApplications = 2 } = {}) {
  const { etDateString } = require('../utils/datetime-et');
  const today = etDateString();
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), serviceKey: `fixture_lawn_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'CountCaps', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  f.propertyId = property.id;
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `${LAWN_TYPE} ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: LAWN_TYPE, scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
  f.celsius = await mockPg('products_catalog').where({ name: 'Celsius WG' }).first();
  f.appliedBefore = [];
  for (let i = 0; i < priorApplications; i += 1) {
    const date = `${today.slice(0, 4)}-0${i + 1}-02`;
    const [past] = await mockPg('scheduled_services').insert({ customer_id: f.customerId, property_id: property.id, scheduled_date: date, service_type: 'Lawn fixture', status: 'completed' }).returning('*');
    const [record] = await mockPg('service_records').insert({ customer_id: f.customerId, scheduled_service_id: past.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
    await mockPg('property_application_history').insert({ customer_id: f.customerId, product_id: f.celsius.id, application_date: date, application_rate: 0.085, rate_unit: 'oz', service_record_id: record.id });
    f.appliedBefore.push(past.id);
  }
  return f;
}

async function cleanup(f) {
  const records = await mockPg('service_records').where({ customer_id: f.customerId }).pluck('id').catch(() => []);
  await mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).del().catch(() => {});
  await mockPg('property_application_history').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_products').whereIn('service_record_id', records).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('customer_properties').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

const product = (f, overrides = {}) => ({ productId: f.celsius.id, rate: 0.085, rateUnit: 'oz', totalAmount: 1, amountUnit: 'oz', applicationMethod: 'broadcast', areaValue: 1000, areaUnit: 'sqft', ...overrides });

function body(overrides = {}) {
  return { customerRecap: 'Visit closed out.', visitOutcome: 'completed', products: [], areasServiced: [], sendCompletionSms: false, requestReview: false, ...overrides };
}

async function complete(f, overrides = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null }, body: body(overrides) });
}

const recordedLedger = (f) => mockPg('property_application_history').where({ customer_id: f.customerId, product_id: f.celsius.id }).whereNull('retracted_at');
const bells = (f) => mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).whereRaw("metadata->>'code' LIKE 'application_limit%'");

postgres('closeout: a hard product count limit flags, never refuses', () => {
  const savedGate = process.env.GATE_LAWN_V13;
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; });
  afterEach(() => { if (savedGate === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = savedGate; jest.restoreAllMocks(); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('a 3rd Celsius application in the year (limit 2): the visit completes, the product is recorded, the completion carries the flag, the office is notified once', async () => {
    const f = await seedLawnVisit({ priorApplications: 2 });
    try {
      const out = await complete(f, { products: [product(f)] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([expect.stringMatching(/^Recorded\. The office will review: Celsius WG is over its yearly application limit\.$/)]);
      expect(out.body.completionAdvisories.join(' ')).not.toMatch(/remove|delete/i);
      // Recorded normally: the actual and the compliance-ledger row exist.
      expect(await mockPg('scheduled_services').where({ id: f.serviceId }).first('status')).toMatchObject({ status: 'completed' });
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      expect(await mockPg('service_products').where({ service_record_id: record.id })).toHaveLength(1);
      expect(await recordedLedger(f)).toHaveLength(3);
      // One office notification, carrying the finding.
      const rows = await bells(f);
      expect(rows).toHaveLength(1);
      expect(typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata).toMatchObject({ code: 'application_limit_exceeded', productName: 'Celsius WG', limitType: 'annual_max_apps', current: 2, max: 2, serviceRecordId: record.id });
    } finally { await cleanup(f); }
  });

  test('the same 3rd application at another property of the customer is not flagged (the cap is per lawn)', async () => {
    const f = await seedLawnVisit({ priorApplications: 2 });
    try {
      const [other] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: false }).returning('*');
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({ property_id: other.id });
      const out = await complete(f, { products: [product(f)] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([]);
      expect(await bells(f)).toHaveLength(0);
      expect(await recordedLedger(f)).toHaveLength(3);
    } finally { await cleanup(f); }
  });

  test('a visit under its limit (1 prior) completes with no flag and no notification', async () => {
    const f = await seedLawnVisit({ priorApplications: 1 });
    try {
      const out = await complete(f, { products: [product(f)] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([]);
      expect(await bells(f)).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  test('a limits read that fails never blocks recording: the visit completes, the product is recorded, and the unavailable flag + notification are raised', async () => {
    const f = await seedLawnVisit({ priorApplications: 2 });
    try {
      jest.spyOn(require('../services/application-limits'), 'checkLimits').mockRejectedValue(new Error('synthetic read failure'));
      const out = await complete(f, { products: [product(f)] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([expect.stringMatching(/^Recorded\. The office will review: product limits could not be checked for this visit\.$/)]);
      expect(await recordedLedger(f)).toHaveLength(3);
      const rows = await bells(f);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].metadata)).toMatch(/application_limit_check_unavailable/);
    } finally { await cleanup(f); }
  });

  test('the ledger lookup failing after the record commits is the same unavailable flag: the visit is recorded, the advisory is present, one deduped bell', async () => {
    const f = await seedLawnVisit({ priorApplications: 2 });
    const real = mockPg;
    // Every plain (non-transaction) read of the ledger table through the shared connection fails.
    mockPg = new Proxy(real, {
      apply(target, thisArg, args) {
        if (args[0] === 'property_application_history') throw new Error('synthetic ledger lookup failure');
        return Reflect.apply(target, thisArg, args);
      },
    });
    try {
      const out = await complete(f, { products: [product(f)] });
      mockPg = real;
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([expect.stringMatching(/^Recorded\. The office will review: product limits could not be checked for this visit\.$/)]);
      expect(await mockPg('scheduled_services').where({ id: f.serviceId }).first('status')).toMatchObject({ status: 'completed' });
      expect(await recordedLedger(f)).toHaveLength(3);
      const rows = await bells(f);
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows[0].metadata)).toMatch(/application_limit_check_unavailable/);
    } finally { mockPg = real; await cleanup(f); }
  });

  test('more than 200 raw products is a 400 before any write', async () => {
    const f = await seedLawnVisit({ priorApplications: 0 });
    try {
      const out = await complete(f, { products: Array.from({ length: 201 }, () => product(f)) });
      expect(out).toMatchObject({ status: 400, body: { code: 'too_many_submitted_products', max: 200 } });
      expect(await mockPg('service_records').where({ customer_id: f.customerId, scheduled_service_id: f.serviceId })).toHaveLength(0);
      expect(await mockPg('scheduled_services').where({ id: f.serviceId }).first('status')).toMatchObject({ status: 'confirmed' });
    } finally { await cleanup(f); }
  });
});
