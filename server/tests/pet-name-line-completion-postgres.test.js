/**
 * The WaveGuard pet line (GATE_PET_NAME_TEXT, services/pet-name-line.js) through the real completeScheduledService
 * transaction: a lawn visit with a spray product, completed with the customer text on, for a customer whose pets are on
 * file in the customer app's Pets editor. Pins that the line rides the text the provider is handed (after the template
 * body), built from the record the closeout just wrote, and that the gate off, an indoor-only pet and a visit with no
 * product leave the text exactly as it was. Runs against a migrated, private Postgres.
 *
 * Wiring copied from complete-scheduled-service-invoiced-visit-postgres.test.js.
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
jest.mock('../services/review-request', () => ({ reportTextAnchorForRecord: jest.fn(async () => null), reportTextAnchorForVisit: jest.fn(async () => null), enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));



const knex = require('knex');
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

// Verified private clone only — never a shared or production URL. Accepts this suite's own waves_pet_line_test clone
// or CI's isolated waves_test. The literal `const SKIP = !process.env.DATABASE_URL` line is the marker the CI
// "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_pet_line_test';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Pet line closeout Postgres tests require their own waves_pet_line_test or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const LAWN_TYPE = 'Every 6 Weeks Lawn Care Service';

async function seedLawnVisit(pets, { tier = 'Gold', stampedLine1 = null, stampedLine2 = null, homeLine2 = null } = {}) {
  const today = etDateString(new Date());
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), serviceKey: `fixture_lawn_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Petline', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, waveguard_tier: tier,
    address_line1: '100 Fixture Street', address_line2: homeLine2, city: 'Fixture City', zip: '34201' });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `${LAWN_TYPE} ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: LAWN_TYPE, scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false,
    ...(stampedLine1 ? { service_address_line1: stampedLine1, service_address_line2: stampedLine2, service_address_city: 'Fixture City', service_address_zip: '34201' } : {}) });
  if (pets) await mockPg('property_preferences').insert({ customer_id: f.customerId, pet_count: pets.length, pets_structured: JSON.stringify(pets) });
  f.celsius = await mockPg('products_catalog').where({ name: 'Celsius WG' }).first();
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
  await mockPg('property_preferences').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('customer_properties').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

const spray = (f) => ({ productId: f.celsius.id, rate: 0.085, rateUnit: 'oz', totalAmount: 1, amountUnit: 'oz', applicationMethod: 'spot_treatment', areaValue: 500, areaUnit: 'sqft' });

async function complete(f, products) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { customerRecap: 'Visit closed out.', visitOutcome: 'completed', products, areasServiced: [], sendCompletionSms: true, includePayLink: false, requestReview: false } });
}

const completionText = () => sendCustomerMessage.mock.calls.map(([input]) => input).find((input) => input?.purpose === 'service_completion');
const LAWN_LINE = 'Biscuit can go back on the lawn once it is dry.';

postgres('closeout: the pet-named line in the completion text', () => {
  const saved = process.env.GATE_PET_NAME_TEXT;
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  beforeEach(() => { sendCustomerMessage.mockClear(); process.env.GATE_PET_NAME_TEXT = 'true'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_PET_NAME_TEXT; else process.env.GATE_PET_NAME_TEXT = saved;
    jest.restoreAllMocks();
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('a named dog and a sprayed lawn: the text carries the line as its own paragraph after the template body, and stores it', async () => {
    const f = await seedLawnVisit([{ name: 'biscuit', type: 'Dog', indoor: 'Both' }]);
    try {
      expect((await complete(f, [spray(f)])).status).toBe(200);
      const text = completionText();
      expect(text.body).toContain(`\n\n${LAWN_LINE}`);
      expect(text.body.indexOf(LAWN_LINE)).toBeGreaterThan(text.body.indexOf('Fixture'));
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      const notes = typeof record.structured_notes === 'string' ? JSON.parse(record.structured_notes) : record.structured_notes;
      expect(notes.completionSmsBody).toContain(LAWN_LINE);
    } finally { await cleanup(f); }
  });

  test('gate off: the same visit texts exactly the template, no pet line', async () => {
    delete process.env.GATE_PET_NAME_TEXT;
    const f = await seedLawnVisit([{ name: 'Biscuit', type: 'Dog' }]);
    try {
      expect((await complete(f, [spray(f)])).status).toBe(200);
      expect(completionText().body).not.toMatch(/Biscuit/);
    } finally { await cleanup(f); }
  });

  test('a member perk at the member\'s home: a non-member, and a member\'s visit at another address, get no line', async () => {
    const nonMember = await seedLawnVisit([{ name: 'Biscuit', type: 'Dog' }], { tier: null });
    try {
      expect((await complete(nonMember, [spray(nonMember)])).status).toBe(200);
      expect(completionText().body).not.toMatch(/Biscuit/);
    } finally { await cleanup(nonMember); }
    sendCustomerMessage.mockClear();
    const elsewhere = await seedLawnVisit([{ name: 'Biscuit', type: 'Dog' }], { stampedLine1: '200 Other Road' });
    try {
      expect((await complete(elsewhere, [spray(elsewhere)])).status).toBe(200);
      expect(completionText().body).not.toMatch(/Biscuit/);
    } finally { await cleanup(elsewhere); }
    sendCustomerMessage.mockClear();
    // Another unit at the same street is elsewhere.
    const unit = await seedLawnVisit([{ name: 'Biscuit', type: 'Dog' }], { homeLine2: 'Apt 3', stampedLine1: '100 Fixture Street', stampedLine2: 'Apt 4' });
    try {
      expect((await complete(unit, [spray(unit)])).status).toBe(200);
      expect(completionText().body).not.toMatch(/Biscuit/);
    } finally { await cleanup(unit); }
    sendCustomerMessage.mockClear();
    // The same address typed on the visit is still the home.
    const home = await seedLawnVisit([{ name: 'Biscuit', type: 'Dog' }], { stampedLine1: '100 Fixture Street' });
    try {
      expect((await complete(home, [spray(home)])).status).toBe(200);
      expect(completionText().body).toContain(LAWN_LINE);
    } finally { await cleanup(home); }
  });

  test('an indoor-only cat is not told to go back on the lawn; a visit with no product gets no line', async () => {
    const indoor = await seedLawnVisit([{ name: 'Luna', type: 'Cat', indoor: 'Indoor' }]);
    try {
      expect((await complete(indoor, [spray(indoor)])).status).toBe(200);
      expect(completionText().body).not.toMatch(/Luna/);
    } finally { await cleanup(indoor); }
    sendCustomerMessage.mockClear();
    const bare = await seedLawnVisit([{ name: 'Biscuit', type: 'Dog' }]);
    try {
      expect((await complete(bare, [])).status).toBe(200);
      expect(completionText().body).not.toMatch(/Biscuit/);
    } finally { await cleanup(bare); }
  });
});
