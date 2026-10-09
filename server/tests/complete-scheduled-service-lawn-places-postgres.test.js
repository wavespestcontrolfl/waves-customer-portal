/**
 * The place of a spot treatment through the real completeScheduledService transaction (GATE_LAWN_TROUBLE_AREAS, owner
 * 2026-10-09): the product record and the application ledger carry the place, the lawn's trouble-area store is written
 * from the spot rows, and the closeout's after-the-fact limit audit judges a spot application at its place (a second place
 * is not flagged, the same place is). Gate off: nothing stored, nothing changes. Runs against a migrated, private Postgres.
 *
 * Wiring copied from complete-scheduled-service-application-limits-postgres.test.js.
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
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');

// Verified private clone only — never a shared or production URL. Accepts this worktree's own
// waves_trouble_areas_test clone or CI's isolated waves_test. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the marker the CI "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_trouble_areas_test';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Lawn place closeout Postgres tests require this worktree\'s own waves_trouble_areas_test or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const LAWN_TYPE = 'Every 6 Weeks Lawn Care Service';
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TROUBLE_AREAS'];

async function seedLawnVisit() {
  const today = etDateString();
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), serviceKey: `fixture_lawn_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Places', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  f.propertyId = property.id;
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `${LAWN_TYPE} ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: LAWN_TYPE, scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
  f.celsius = await mockPg('products_catalog').where({ name: 'Celsius WG' }).first();
  return f;
}

// Two earlier Celsius spot applications this year, both at one place (or none), as the ledger holds them.
async function priorCelsius(f, place) {
  const year = etDateString().slice(0, 4);
  for (const date of [`${year}-01-02`, `${year}-01-03`]) {
    const [past] = await mockPg('scheduled_services').insert({ customer_id: f.customerId, property_id: f.propertyId, scheduled_date: date, service_type: 'Lawn fixture', status: 'completed' }).returning('*');
    const [record] = await mockPg('service_records').insert({ customer_id: f.customerId, scheduled_service_id: past.id, service_date: date, service_type: 'Lawn fixture' }).returning('*');
    await mockPg('property_application_history').insert({ customer_id: f.customerId, property_id: f.propertyId, product_id: f.celsius.id, application_date: date, application_rate: 0.085, rate_unit: 'oz', service_record_id: record.id, treated_place: place });
  }
}

async function cleanup(f) {
  const records = await mockPg('service_records').where({ customer_id: f.customerId }).pluck('id').catch(() => []);
  await mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).del().catch(() => {});
  await mockPg('lawn_trouble_areas').where({ customer_id: f.customerId }).del().catch(() => {});
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

const spot = (f, overrides = {}) => ({ productId: f.celsius.id, rate: 0.085, rateUnit: 'oz', totalAmount: 1, amountUnit: 'oz', applicationMethod: 'spot_treatment', areaValue: 500, areaUnit: 'sqft', ...overrides });

async function complete(f, overrides = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { customerRecap: 'Visit closed out.', visitOutcome: 'completed', products: [], areasServiced: [], sendCompletionSms: false, requestReview: false, ...overrides } });
}

const ledgerOf = (f, recordId) => mockPg('property_application_history').where({ customer_id: f.customerId, service_record_id: recordId }).first();
const recordOf = (f) => mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
const areasOf = (f) => mockPg('lawn_trouble_areas').where({ customer_id: f.customerId });

postgres('closeout: the place of a spot treatment', () => {
  const saved = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
  const gates = (on) => { for (const name of GATES) { if (on) process.env[name] = 'true'; else delete process.env[name]; } };
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  beforeEach(() => { gates(true); require('../config/lawn-v13-count-caps').resetV13CapIdentity(); });
  afterEach(() => {
    for (const name of GATES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    jest.restoreAllMocks();
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('a 3rd Celsius spot of the year at ANOTHER place: recorded with its place on the product record and the ledger, the store gets the area, no limit flag', async () => {
    const f = await seedLawnVisit();
    try {
      await priorCelsius(f, 'front');
      const out = await complete(f, { products: [spot(f, { areaPlace: 'back' })] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([]);
      const record = await recordOf(f);
      expect(await mockPg('service_products').where({ service_record_id: record.id }).first()).toMatchObject({ treated_place: 'back', application_method: 'spot_treatment' });
      expect(await ledgerOf(f, record.id)).toMatchObject({ treated_place: 'back', property_id: f.propertyId });
      const [area] = await areasOf(f);
      expect(area).toMatchObject({ property_id: f.propertyId, place: 'back', type: 'weeds', status: 'active', source: 'tech_tap', first_service_record_id: record.id, last_service_record_id: record.id });
    } finally { await cleanup(f); }
  });

  test('a 3rd Celsius spot of the year at the SAME place is recorded and flagged for the office (the closeout never refuses)', async () => {
    const f = await seedLawnVisit();
    try {
      await priorCelsius(f, 'front');
      const out = await complete(f, { products: [spot(f, { areaPlace: 'front' })] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([expect.stringMatching(/^Recorded\. The office will review: Celsius WG is over its yearly application limit\.$/)]);
      expect(await ledgerOf(f, (await recordOf(f)).id)).toMatchObject({ treated_place: 'front' });
    } finally { await cleanup(f); }
  });

  test('history with no place on record counts at every place: a spot at the back is flagged too', async () => {
    const f = await seedLawnVisit();
    try {
      await priorCelsius(f, null);
      const out = await complete(f, { products: [spot(f, { areaPlace: 'back' })] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([expect.stringMatching(/over its yearly application limit/)]);
    } finally { await cleanup(f); }
  });

  test('the sheet\'s type hint writes the area as that type; a place off the list, or a whole-lawn row, stores no place and no area', async () => {
    const f = await seedLawnVisit();
    try {
      const out = await complete(f, { products: [spot(f, { areaPlace: 'front', troubleType: 'chinch', troubleSource: 'guide_card' })] });
      expect(out.status).toBe(200);
      const [area] = await areasOf(f);
      expect(area).toMatchObject({ place: 'front', type: 'chinch', source: 'guide_card' });
    } finally { await cleanup(f); }
    const g = await seedLawnVisit();
    try {
      const out = await complete(g, { products: [spot(g, { areaPlace: 'roof' })] });
      expect(out.status).toBe(200);
      expect(await mockPg('service_products').where({ service_record_id: (await recordOf(g)).id }).first()).toMatchObject({ treated_place: null });
      expect(await areasOf(g)).toEqual([]);
    } finally { await cleanup(g); }
    const h = await seedLawnVisit();
    try {
      const out = await complete(h, { products: [spot(h, { applicationMethod: 'broadcast_spray', areaPlace: 'front' })] });
      expect(out.status).toBe(200);
      expect(await mockPg('service_products').where({ service_record_id: (await recordOf(h)).id }).first()).toMatchObject({ treated_place: null });
      expect(await areasOf(h)).toEqual([]);
    } finally { await cleanup(h); }
  });

  test('a failed store write never fails the completion: the visit and the ledger are saved', async () => {
    const f = await seedLawnVisit();
    try {
      jest.spyOn(require('../services/lawn-trouble-areas'), 'recordFromCompletion').mockRejectedValue(new Error('synthetic store failure'));
      const out = await complete(f, { products: [spot(f, { areaPlace: 'front' })] });
      expect(out.status).toBe(200);
      expect(await mockPg('scheduled_services').where({ id: f.serviceId }).first('status')).toMatchObject({ status: 'completed' });
      expect(await ledgerOf(f, (await recordOf(f)).id)).toMatchObject({ treated_place: 'front' });
      expect(await areasOf(f)).toEqual([]);
    } finally { await cleanup(f); }
  });

  test('a shared active-ingredient cap broken at the chosen place stays an advisory: /complete accepts, the closeout reports it as before the gate', async () => {
    const f = await seedLawnVisit();
    const ai = `Zzfixtureine${randomUUID().slice(0, 6)}`;
    const [shared] = await mockPg('products_catalog').insert({
      name: `Shared cap fixture ${ai}`, category: 'herbicide', active_ingredient: ai, default_rate_per_1000: 0.5, rate_unit: 'oz', label_verified_at: new Date(),
      inventory_on_hand: 1000, inventory_unit: 'oz', active: true,
    }).returning('*');
    try {
      await mockPg('product_limits').insert({ product_id: shared.id, match_type: 'active_ingredient', match_value: ai, limit_type: 'annual_max_rate', limit_value: 1, limit_unit: 'oz/1000sf/year', severity: 'hard_block', description: 'fixture' });
      const year = etDateString().slice(0, 4);
      const [past] = await mockPg('scheduled_services').insert({ customer_id: f.customerId, property_id: f.propertyId, scheduled_date: `${year}-01-02`, service_type: 'Lawn fixture', status: 'completed' }).returning('*');
      const [prior] = await mockPg('service_records').insert({ customer_id: f.customerId, scheduled_service_id: past.id, service_date: `${year}-01-02`, service_type: 'Lawn fixture' }).returning('*');
      await mockPg('property_application_history').insert({ customer_id: f.customerId, property_id: f.propertyId, product_id: shared.id, application_date: `${year}-01-02`, application_rate: 1, rate_unit: 'oz', active_ingredient: ai, service_record_id: prior.id, treated_place: 'front' });
      const row = spot(f, { productId: shared.id, areaPlace: 'front', rate: 0.5 });
      // The shared cap is already broken for this product at the front ...
      const checked = await require('../services/application-limits').checkLimits(f.customerId, shared.id, new Date(), mockPg, { propertyId: f.propertyId, place: 'front', proposal: true });
      expect(checked.blocks.map((b) => b.matchType)).toContain('active_ingredient');
      // ... and the places preflight does not refuse on it.
      const svc = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
      expect(await require('../services/lawn-trouble-areas').preflightPlaces({ knex: mockPg, svc, products: [row] })).toBeNull();
      // The completion accepts, and the shared-cap advisory and the office alert are raised as ever.
      const out = await complete(f, { products: [row] });
      expect(out.status).toBe(200);
      expect(await ledgerOf(f, (await recordOf(f)).id)).toMatchObject({ treated_place: 'front' });
      expect(await mockPg('dispatch_alerts').where({ type: 'application_limit', job_id: f.serviceId }).whereRaw("payload->>'active_ingredient' = ?", [ai])).toHaveLength(1);
    } finally {
      await mockPg('dispatch_alerts').where({ job_id: f.serviceId }).del().catch(() => {});
      await cleanup(f);
      await mockPg('product_limits').where({ product_id: shared.id }).del().catch(() => {});
      await mockPg('products_catalog').where({ id: shared.id }).del().catch(() => {});
    }
  });

  test('gate off: the place is not stored anywhere, no area is written, and the lawn-wide flag is raised as before', async () => {
    const f = await seedLawnVisit();
    try {
      await priorCelsius(f, 'front');
      gates(false);
      process.env.GATE_LAWN_V13 = 'true';
      const out = await complete(f, { products: [spot(f, { areaPlace: 'back' })] });
      expect(out.status).toBe(200);
      expect(out.body.completionAdvisories).toEqual([expect.stringMatching(/over its yearly application limit/)]);
      const record = await recordOf(f);
      expect(await mockPg('service_products').where({ service_record_id: record.id }).first()).toMatchObject({ treated_place: null });
      expect(await ledgerOf(f, record.id)).toMatchObject({ treated_place: null });
      expect(await areasOf(f)).toEqual([]);
    } finally { await cleanup(f); }
  });
});
