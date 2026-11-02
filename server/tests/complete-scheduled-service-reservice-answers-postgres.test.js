/**
 * Re-service answers frozen onto the record (step S2a, GATE_RESERVICE_ASKS), through the real completeScheduledService
 * transaction: gate on, a pest re-service freezes `service_data.reserviceAsks` (what the customer told us, the tech's
 * checked answers, the office-only reasons apart); a wrong answer is a 400 with nothing written; gate off, a visit that
 * is not a re-service, and a backdated backlog closeout carry no key. Runs against a migrated, private Postgres
 * (CI provides one); nothing real is sent.
 *
 * Wiring copied from complete-scheduled-service-reservice-review-postgres.test.js.
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
  sendCustomerMessage: jest.fn(async () => ({ sent: true, channel: 'sms', providerMessageId: 'SM-fixture', sid: 'SM-fixture' })),
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
jest.mock('../services/review-request', () => ({ reportTextAnchorForRecord: jest.fn(async () => null), reportTextAnchorForVisit: jest.fn(async () => null),
  enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined),
  createInline: jest.fn(async () => ({ url: 'https://example.test/review-link', requestId: 'rr-fixture' })), markInlineDelivered: jest.fn(async () => {}),
}));


const knex = require('knex');
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');

// Verified private clone only. The literal `const SKIP = !process.env.DATABASE_URL` line is the marker the CI
// "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_invoiced_fast_test';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Re-service answers Postgres tests require their own waves_invoiced_fast_test or CI\'s waves_test.');
  }
}
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const REQUEST_WORDS = 'Ants keep coming back near the kitchen sink';

// A pest re-service (the pest_re_service catalog row, a callback) with the customer's booking words on file. `ordinary`
// makes it a plain recurring-style visit instead; `daysAgo` dates it in the past.
async function seedVisit({ ordinary = false, daysAgo = 0 } = {}) {
  const f = { customerId: randomUUID(), techId: randomUUID(), serviceId: randomUUID() };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Answers', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  const key = ordinary ? `fixture_ordinary_${randomUUID().slice(0, 8)}` : 'pest_re_service';
  const type = ordinary ? `Fixture Ordinary Visit ${key}` : 'Pest Control Re-Service';
  let catalog = await mockPg('services').where({ service_key: key }).first('id');
  if (!catalog) [catalog] = await mockPg('services').insert({ id: randomUUID(), name: type, service_key: key, is_active: true }).returning('id');
  f.catalogId = catalog.id; f.ordinaryKey = ordinary ? key : null; f.createdCatalog = ordinary;
  const date = new Date(Date.now() - daysAgo * 86400000);
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: type, scheduled_date: etDateString(date), window_start: '09:00', window_end: '10:00', status: 'confirmed',
    is_callback: !ordinary, estimated_duration_minutes: 30, customer_request: REQUEST_WORDS, customer_request_source: 'picker' });
  return f;
}

async function cleanup(f) {
  const records = await mockPg('service_records').where({ customer_id: f.customerId }).pluck('id').catch(() => []);
  await mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).del().catch(() => {});
  await mockPg('property_application_history').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_products').whereIn('service_record_id', records).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('customer_properties').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
  if (f.createdCatalog) await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
}

async function complete(f, body, actor = { techRole: 'admin', technicianId: f.techId, technician: null }) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(), actor,
    body: { visitOutcome: 'completed', products: [], areasServiced: ['Outside'], technicianNotes: 'Treated the entry points.',
      sendCompletionSms: false, includePayLink: false, requestReview: false, ...body } });
}
const savedServiceData = async (f) => {
  const record = await mockPg('service_records').where({ customer_id: f.customerId }).first('service_data');
  if (!record) return null;
  return typeof record.service_data === 'string' ? JSON.parse(record.service_data) : (record.service_data || {});
};

postgres('re-service answers frozen on /complete', () => {
  const gateWas = process.env.GATE_RESERVICE_ASKS;
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 4 } });
  });
  afterEach(() => { if (gateWas === undefined) delete process.env.GATE_RESERVICE_ASKS; else process.env.GATE_RESERVICE_ASKS = gateWas; });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  // One completion on a fresh fixture; returns the result, the service_data the record stored (null: no record), the
  // visit's status and its completion attempt.
  async function run({ gate = true, seed, body, actor }) {
    if (gate) process.env.GATE_RESERVICE_ASKS = 'true'; else delete process.env.GATE_RESERVICE_ASKS;
    const f = await seedVisit(seed);
    try {
      const result = await complete(f, body, actor);
      const status = (await mockPg('scheduled_services').where({ id: f.serviceId }).first('status')).status;
      const attempt = await mockPg('service_completion_attempts').where('service_id', f.serviceId).first('status', 'error');
      return { result, data: await savedServiceData(f), status, attempt };
    } finally { await cleanup(f); }
  }
  const ANSWERS = { items: [
    { itemId: 'ignored-in-assert', answer: 'noted' },
  ] };

  test('gate on, valid answers: the asks, the answers and the office reasons freeze apart', async () => {
    process.env.GATE_RESERVICE_ASKS = 'true';
    const f = await seedVisit();
    try {
      const gather = require('../services/reservice-asks');
      const gathered = await gather.gatherReserviceAsks(f.serviceId);
      expect(gathered.ok).toBe(true);
      const bookingId = gathered.items[0].id;
      const result = await complete(f, { reserviceAnswers: { items: [
        { itemId: bookingId, answer: 'not_today', reason: 'Dog in the yard' },
        { itemId: 'sms:not-gathered', answer: 'noted' },
      ] } });
      expect(result.status).toBe(200);
      const data = await savedServiceData(f);
      expect(data.reserviceAsks).toMatchObject({
        version: 1, lane: 'pest',
        answers: { [bookingId]: { answer: 'not_today' } },
        officeNotes: { [bookingId]: 'Dog in the yard' },
      });
      expect(data.reserviceAsks.items.map((item) => item.id)).toContain(bookingId);
      expect(data.reserviceAsks.items.every((item) => typeof item.printable === 'boolean')).toBe(true);
      expect(Object.keys(data.reserviceAsks.answers)).toEqual([bookingId]);
      expect(Date.parse(data.reserviceAsks.gatheredAt)).not.toBeNaN();
    } finally { await cleanup(f); }
  });

  test('gate on, no answers: the record still keeps what the customer said', async () => {
    const { result, data } = await run({ body: {} });
    expect(result.status).toBe(200);
    expect(data.reserviceAsks).toMatchObject({ version: 1, lane: 'pest', answers: {}, officeNotes: {} });
    expect(data.reserviceAsks.items.length).toBeGreaterThan(0);
  });

  test('gate on, a wrong answer: 400 reservice_answer_invalid, the attempt marked failed, no record, the visit stays open', async () => {
    const { result, data, status, attempt } = await run({ body: { reserviceAnswers: { items: [{ itemId: 'x', answer: 'treated', productIds: ['not-on-this-visit'] }] } } });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('reservice_answer_invalid');
    expect(data).toBeNull();
    expect(status).toBe('confirmed');
    expect(attempt).toEqual({ status: 'failed', error: 'reservice_answer_invalid' });
  });

  test('gate off: the field is ignored and the record has no key', async () => {
    const { result, data } = await run({ gate: false, body: { reserviceAnswers: { items: [{ itemId: 'x', answer: 'treated', productIds: ['not-on-this-visit'] }] } } });
    expect(result.status).toBe(200);
    expect(data).not.toHaveProperty('reserviceAsks');
  });

  test('gate on, a visit that is not a re-service: the field is ignored and the record has no key', async () => {
    const { result, data } = await run({ seed: { ordinary: true }, body: { reserviceAnswers: ANSWERS } });
    expect(result.status).toBe(200);
    expect(data).not.toHaveProperty('reserviceAsks');
  });

  test('gate on, a backdated backlog closeout never freezes', async () => {
    const { result, data } = await run({ seed: { daysAgo: 5 }, body: { backfill: true, reserviceAnswers: ANSWERS } });
    expect(result.status).toBe(200);
    expect(data).not.toHaveProperty('reserviceAsks');
  });
});
