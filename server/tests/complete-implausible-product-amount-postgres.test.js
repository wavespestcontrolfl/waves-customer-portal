/**
 * A technician's product amount no visit uses is refused (422 IMPLAUSIBLE_PRODUCT_AMOUNT) on a FRESH completion only, before
 * the first service write, against a FIXED per-dimension limit (no usage history is read). A malformed amount is a 400 for every
 * role. A same-key replay of a committed completion is never judged again and replays the success.
 * Runs the real completeScheduledService against a private migrated clone (wiring copied from
 * complete-scheduled-service-first-visit-rating-default-postgres.test.js).
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
jest.mock('../services/review-request', () => ({ reportTextAnchorForRecord: jest.fn(async () => null), reportTextAnchorForVisit: jest.fn(async () => null), enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));

const knex = require('knex');
const { randomUUID } = require('crypto');

// Private clone only: this worktree's own waves_qa_implausible_20261031 or CI's isolated waves_test.
// The literal line below is the marker the CI "DB-gated suites" step greps for.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_qa_implausible_20261031';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Implausible-amount Postgres tests require this worktree\'s own waves_qa_implausible_20261031 or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

async function seedPestVisit() {
  const { etDateString } = require('../utils/datetime-et');
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), productId: randomUUID(),
    serviceKey: `fixture_pest_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Implausible', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture General Pest Control ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('products_catalog').insert({ id: f.productId, name: `Fixture Celsius WG ${f.serviceKey}`, category: 'herbicide', active: true,
    inventory_on_hand: 500, inventory_unit: 'lb' });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture General Pest Control ${f.serviceKey}`, scheduled_date: etDateString(), window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
  return f;
}

async function cleanup(f) {
  await mockPg('product_inventory_movements').where('product_id', f.productId).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  const records = await mockPg('service_records').where({ customer_id: f.customerId }).select('id').catch(() => []);
  for (const r of records) await mockPg('service_products').where('service_record_id', r.id).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ id: f.serviceId }).del().catch(() => {});
  await mockPg('products_catalog').where({ id: f.productId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

const bodyFor = (f, totalAmount) => ({
  customerRecap: 'Visit closed out.', visitOutcome: 'completed', areasServiced: [], sendCompletionSms: false, requestReview: false,
  products: [{ productId: f.productId, name: 'Celsius WG', totalAmount, amountUnit: 'lb' }],
});

async function complete(f, { role, totalAmount, key = randomUUID() }) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: key,
    actor: { techRole: role, technicianId: f.techId, technician: null }, body: bodyFor(f, totalAmount) });
}

const writesFor = async (f) => ({
  records: (await mockPg('service_records').where({ customer_id: f.customerId })).length,
  serviceProducts: Number((await mockPg('service_products as sp').join('service_records as sr', 'sr.id', 'sp.service_record_id').where('sr.customer_id', f.customerId).count('* as n').first()).n),
  ownMovements: Number((await mockPg('product_inventory_movements').where({ product_id: f.productId, service_record_id: null }).count('* as n').first()).n),
  allMovements: Number((await mockPg('product_inventory_movements').where({ product_id: f.productId }).count('* as n').first()).n),
  stock: Number((await mockPg('products_catalog').where({ id: f.productId }).first()).inventory_on_hand),
});

postgres('technician implausible product amount', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('a fresh technician over-ceiling submit answers 422 and writes nothing; the claim is released', async () => {
    const f = await seedPestVisit();
    try {
      const out = await complete(f, { role: 'technician', totalAmount: 406 });
      expect(out.status).toBe(422);
      expect(out.body).toMatchObject({ code: 'IMPLAUSIBLE_PRODUCT_AMOUNT', error: expect.stringMatching(/^406 lb of Fixture Celsius WG .* is far more than one visit uses\. Check the amount and submit again\.$/) });
      expect(await writesFor(f)).toEqual({ records: 0, serviceProducts: 0, ownMovements: 0, allMovements: 0, stock: 500 });
      const attempts = await mockPg('service_completion_attempts').where('service_id', f.serviceId);
      expect(attempts.every((a) => a.status === 'failed')).toBe(true);
      // The corrected amount then goes through.
      expect((await complete(f, { role: 'technician', totalAmount: 4 })).status).toBe(200);
      expect(await writesFor(f)).toMatchObject({ records: 1, serviceProducts: 1, allMovements: 1, stock: 496 });
    } finally { await cleanup(f); }
  });

  test('an under-ceiling technician submit is unchanged', async () => {
    const f = await seedPestVisit();
    try {
      expect((await complete(f, { role: 'technician', totalAmount: 100 })).status).toBe(200);
      expect(await writesFor(f)).toMatchObject({ records: 1, serviceProducts: 1, allMovements: 1, stock: 400 });
    } finally { await cleanup(f); }
  });

  test('an admin over-ceiling submit keeps the advisory path: line recorded, stock untouched', async () => {
    const f = await seedPestVisit();
    try {
      const out = await complete(f, { role: 'admin', totalAmount: 600 });
      expect(out.status).toBe(200);
      expect(await writesFor(f)).toMatchObject({ records: 1, serviceProducts: 1, allMovements: 0, stock: 500 });
    } finally { await cleanup(f); }
  });

  test('a malformed amount is a 400 for a technician and an admin, with nothing written and the claim released', async () => {
    for (const role of ['technician', 'admin']) {
      const f = await seedPestVisit();
      try {
        const out = await complete(f, { role, totalAmount: '99999junk' });
        expect(out.status).toBe(400);
        expect(out.body).toMatchObject({ code: 'INVALID_PRODUCT_AMOUNT' });
        expect(await writesFor(f)).toEqual({ records: 0, serviceProducts: 0, ownMovements: 0, allMovements: 0, stock: 500 });
        const attempts = await mockPg('service_completion_attempts').where('service_id', f.serviceId);
        expect(attempts.every((a) => a.status === 'failed')).toBe(true);
      } finally { await cleanup(f); }
    }
  });

  test('a numeric string amount is stored as that number', async () => {
    const f = await seedPestVisit();
    try {
      expect((await complete(f, { role: 'technician', totalAmount: '12.5' })).status).toBe(200);
      const row = await mockPg('service_products as sp').join('service_records as sr', 'sr.id', 'sp.service_record_id').where('sr.customer_id', f.customerId).first('sp.total_amount');
      expect(Number(row.total_amount)).toBe(12.5);
      expect((await writesFor(f)).stock).toBe(487.5);
    } finally { await cleanup(f); }
  });

  test('an identical retry of a committed completion replays the success (a replay is never judged again)', async () => {
    const f = await seedPestVisit();
    try {
      const key = randomUUID();
      const first = await complete(f, { role: 'technician', totalAmount: 100, key });
      expect(first.status).toBe(200);
      const retry = await complete(f, { role: 'technician', totalAmount: 100, key });
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({ replayed: true, serviceRecordId: first.body.serviceRecordId });
      expect(await writesFor(f)).toMatchObject({ records: 1, serviceProducts: 1 });
    } finally { await cleanup(f); }
  });
});
