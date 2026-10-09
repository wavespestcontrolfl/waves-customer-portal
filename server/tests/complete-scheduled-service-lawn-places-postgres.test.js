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
const GATES = ['GATE_LAWN_V13', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_TROUBLE_AREAS', 'GATE_LAWN_TREATMENT_GUIDE'];

async function seedLawnVisit({ daysAgo = 0, unlinked = false, otherProperty = false } = {}) {
  const today = etDateString(new Date(Date.now() - daysAgo * 86400000));
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), serviceKey: `fixture_lawn_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Places', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  f.propertyId = property.id;
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `${LAWN_TYPE} ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: unlinked ? null : property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: LAWN_TYPE, scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
  if (otherProperty) await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '200 Fixture Avenue', city: 'Fixture City', zip: '34202', is_primary: false });
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
      // A chinch claim stands only for a rung of the ladder (the server confirms); here the ladder holds the product.
      jest.spyOn(require('../services/lawn-fast-complete'), 'troubleTypeIdsFor').mockResolvedValue({ takeAll: new Set(), chinch: new Set([f.celsius.id.toLowerCase()]) });
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

  // A take-all fungicide is added through Search and cataloged as a fungicide: the sheet says take_all, the server confirms it.
  test.each([
    ['the server confirms it is a take-all row', (id) => new Set([id.toLowerCase()]), 'take_all'],
    ['the server does not (a claim on any other fungicide)', () => new Set(), 'fungus'],
    ['the take-all lookup fails (nothing is stored for the row; the application is)', null, null],
  ])('a take_all claim on a placed spot row: %s', async (_label, resolve, type) => {
    const f = await seedLawnVisit();
    const [fungicide] = await mockPg('products_catalog').insert({ name: `Take-all fixture ${randomUUID().slice(0, 6)}`, category: 'fungicide', default_rate_per_1000: 0.5, rate_unit: 'oz', label_verified_at: new Date(), inventory_on_hand: 1000, inventory_unit: 'oz', active: true }).returning('*');
    try {
      const lookup = jest.spyOn(require('../services/lawn-fast-complete'), 'troubleTypeIdsFor')
        .mockImplementation(async () => { if (!resolve) throw new Error('plan unavailable'); return { takeAll: resolve(fungicide.id), chinch: new Set(), chinchOnly: new Set() }; });
      const out = await complete(f, { products: [spot(f, { productId: fungicide.id, areaPlace: 'front', troubleType: 'take_all' })] });
      expect(out.status).toBe(200);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect((await areasOf(f)).map((a) => [a.place, a.type])).toEqual(type ? [['front', type]] : []);
      expect(await mockPg('service_products').where({ service_record_id: (await recordOf(f)).id, treated_place: 'front' })).toHaveLength(1);
    } finally {
      await cleanup(f);
      await mockPg('products_catalog').where({ id: fungicide.id }).del().catch(() => {});
    }
  });

  // The deliberate Search path maps a NEW take-all area: accepted at an unmapped place, the area created with source tech_tap; a card row there is refused.
  test('a take-all row: Search at an unmapped place is accepted and maps it (tech_tap); the card row at that place is refused and nothing is stored', async () => {
    const f = await seedLawnVisit();
    const [fungicide] = await mockPg('products_catalog').insert({ name: `Take-all fixture ${randomUUID().slice(0, 6)}`, category: 'fungicide', default_rate_per_1000: 0.5, rate_unit: 'oz', label_verified_at: new Date(), inventory_on_hand: 1000, inventory_unit: 'oz', active: true }).returning('*');
    try {
      jest.spyOn(require('../services/lawn-fast-complete'), 'troubleTypeIdsFor').mockResolvedValue({ takeAll: new Set([fungicide.id.toLowerCase()]), chinch: new Set() });
      const svc = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
      const row = (source) => spot(f, { productId: fungicide.id, areaPlace: 'front', troubleType: 'take_all', troubleSource: source });
      const areas = require('../services/lawn-trouble-areas');
      expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [row('guide_card')] })).toMatchObject({ status: 400, payload: { code: 'lawn_place_not_mapped' } });
      expect(await areasOf(f)).toEqual([]);
      expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [row('tech_tap')] })).toBeNull();
      const out = await complete(f, { products: [row('tech_tap')] });
      expect(out.status).toBe(200);
      expect((await areasOf(f)).map((a) => [a.place, a.type, a.source])).toEqual([['front', 'take_all', 'tech_tap']]);
      // The place is now mapped: the card row passes there.
      expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [row('guide_card')] })).toBeNull();
    } finally {
      await cleanup(f);
      await mockPg('products_catalog').where({ id: fungicide.id }).del().catch(() => {});
    }
  });

  test('the property resolver fails inside the completion transaction: the places are off for the visit and the completion still commits', async () => {
    const f = await seedLawnVisit({ unlinked: true });
    try {
      await mockPg.raw('ALTER TABLE property_preferences RENAME TO property_preferences_away');
      let out;
      try {
        out = await complete(f, { products: [spot(f, { areaPlace: 'back' })] });
      } finally {
        await mockPg.raw('ALTER TABLE property_preferences_away RENAME TO property_preferences');
      }
      expect(out.status).toBe(200);
      const record = await recordOf(f);
      expect(await mockPg('service_products').where({ service_record_id: record.id })).toMatchObject([{ treated_place: null }]);
      expect(await ledgerOf(f, record.id)).toMatchObject({ treated_place: null, property_id: null });
      expect(await areasOf(f)).toEqual([]);
    } finally { await cleanup(f); }
  });

  // A visit whose nullable property_id is unset: the places work on the property the property-area flow resolves (the one shared resolver),
  // and are off for the visit when it cannot be resolved.
  describe('a visit with no property link', () => {
    const otherProductsOf = async (f) => ({
      products: await mockPg('service_products').where({ service_record_id: (await recordOf(f)).id }),
      ledger: await mockPg('property_application_history').where({ customer_id: f.customerId }).orderBy('created_at'),
    });

    test('the sole property resolves: the area is stored on it, the limits are judged per place on it, and the ledger freezes it on the placed row only', async () => {
      const f = await seedLawnVisit({ unlinked: true });
      const granular = await mockPg('products_catalog').insert({ name: `Granular fixture ${randomUUID().slice(0, 6)}`, category: 'herbicide', default_rate_per_1000: 1, rate_unit: 'lb', label_verified_at: new Date(), inventory_on_hand: 1000, inventory_unit: 'lb', active: true }).returning('*').then(([row]) => row);
      try {
        await priorCelsius(f, 'front');
        const svc = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
        expect(svc.property_id).toBeNull();
        const areas = require('../services/lawn-trouble-areas');
        expect(await areas.propertyOf(mockPg, svc)).toBe(f.propertyId);
        // The context block exists, and the closed place is judged on the resolved property (the front is at its count, the back is not).
        const block = await areas.buildContextBlock({ knex: mockPg, svc, seed: { products: [{ id: f.celsius.id, name: 'Celsius WG' }], rows: new Map() }, readFailures: new Set() });
        expect(Object.keys(block.troubleAreas.blocked[f.celsius.id])).toEqual(['front']);
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [spot(f, { areaPlace: 'front' })] })).toMatchObject({ status: 400, payload: { code: 'lawn_place_limit', place: 'front' } });
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [spot(f, { areaPlace: 'back' })] })).toBeNull();
        const out = await complete(f, { products: [spot(f, { areaPlace: 'back' }), { productId: granular.id, rate: 1, rateUnit: 'lb', totalAmount: 1, amountUnit: 'lb', applicationMethod: 'granular_broadcast', areaValue: 500, areaUnit: 'sqft' }] });
        expect(out.status).toBe(200);
        expect((await areasOf(f)).map((a) => [a.property_id, a.place, a.type])).toEqual([[f.propertyId, 'back', 'weeds']]);
        const { products, ledger } = await otherProductsOf(f);
        expect(products.map((p) => p.treated_place).sort()).toEqual(['back', null]);
        const recordId = (await recordOf(f)).id;
        const current = ledger.filter((row) => row.service_record_id === recordId);
        // The placed row is frozen on the resolved property; the whole-lawn row keeps what it always had on an unlinked visit (no property).
        expect(current.find((row) => row.treated_place === 'back').property_id).toBe(f.propertyId);
        expect(current.find((row) => !row.treated_place).property_id).toBeNull();
      } finally { await cleanup(f); await mockPg('products_catalog').where({ id: granular.id }).del().catch(() => {}); }
    });

    test('the property cannot be resolved (two active properties, no link): the places are off for the visit, as with the gate off', async () => {
      const f = await seedLawnVisit({ unlinked: true, otherProperty: true });
      try {
        const svc = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
        const areas = require('../services/lawn-trouble-areas');
        expect(await areas.propertyOf(mockPg, svc)).toBeNull();
        expect(await areas.buildContextBlock({ knex: mockPg, svc, seed: { products: [], rows: new Map() }, readFailures: new Set() })).toEqual({});
        // No place is asked for, and none is judged.
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [spot(f)] })).toBeNull();
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [spot(f, { areaPlace: 'front' })] })).toBeNull();
        // A completion that names a place records none, stores no area, and freezes no property: exactly the gate-off completion.
        const out = await complete(f, { products: [spot(f, { areaPlace: 'back' })] });
        expect(out.status).toBe(200);
        const { products, ledger } = await otherProductsOf(f);
        expect(products.map((p) => p.treated_place)).toEqual([null]);
        expect(ledger.map((row) => [row.treated_place, row.property_id])).toEqual([[null, null]]);
        expect(await areasOf(f)).toEqual([]);
      } finally { await cleanup(f); }
    });
  });

  // The server's own staged sets classify the special products, whatever the sheet said (no hint at all, or a wrong one).
  describe('the server classifies placed rows from its own staged sets', () => {
    const insecticide = (name) => mockPg('products_catalog').insert({ name: `${name} ${randomUUID().slice(0, 6)}`, category: 'insecticide', default_rate_per_1000: 0.5, rate_unit: 'oz', label_verified_at: new Date(), inventory_on_hand: 1000, inventory_unit: 'oz', active: true }).returning('*').then(([row]) => row);
    const fungicide = () => mockPg('products_catalog').insert({ name: `Fungicide fixture ${randomUUID().slice(0, 6)}`, category: 'fungicide', default_rate_per_1000: 0.5, rate_unit: 'oz', label_verified_at: new Date(), inventory_on_hand: 1000, inventory_unit: 'oz', active: true }).returning('*').then(([row]) => row);
    const sets = (value) => jest.spyOn(require('../services/lawn-fast-complete'), 'troubleTypeIdsFor').mockImplementation(async () => { if (!value) throw new Error('plan unavailable'); return { takeAll: new Set(), chinch: new Set(), chinchOnly: new Set(), ...value }; });
    const typesOf = async (f) => (await areasOf(f)).map((a) => [a.place, a.type]);

    test('a take-all fungicide sent as plain fungus (no hint, or the generic one) is stored as take_all', async () => {
      const f = await seedLawnVisit();
      const product = await fungicide();
      try {
        const lookup = sets({ takeAll: new Set([product.id.toLowerCase()]) });
        expect((await complete(f, { products: [spot(f, { productId: product.id, areaPlace: 'front' })] })).status).toBe(200);
        expect(await typesOf(f)).toEqual([['front', 'take_all']]);
        expect(lookup).toHaveBeenCalledTimes(1);
        await mockPg('lawn_trouble_areas').where({ customer_id: f.customerId }).del();
        await mockPg('service_completion_attempts').where('service_id', f.serviceId).del();
      } finally { await cleanup(f); await mockPg('products_catalog').where({ id: product.id }).del().catch(() => {}); }
    });

    test('the chinch-only first rung is chinch with no hint; the shared rung is chinch only when the sheet says so', async () => {
      const f = await seedLawnVisit();
      const first = await insecticide('Chinch first rung');
      const shared = await insecticide('Shared rung');
      try {
        sets({ chinch: new Set([first.id.toLowerCase(), shared.id.toLowerCase()]), chinchOnly: new Set([first.id.toLowerCase()]) });
        const out = await complete(f, { products: [
          spot(f, { productId: first.id, areaPlace: 'front' }),
          spot(f, { productId: shared.id, areaPlace: 'back' }),
        ] });
        expect(out.status).toBe(200);
        expect((await typesOf(f)).sort()).toEqual([['back', 'other_insect'], ['front', 'chinch']]);
      } finally { await cleanup(f); await mockPg('products_catalog').whereIn('id', [first.id, shared.id]).del().catch(() => {}); }
    });

    test('the shared rung with the sheet\'s chinch hint is chinch (confirmed); a read that fails stores no area for the insecticide row and keeps the application', async () => {
      const f = await seedLawnVisit();
      const shared = await insecticide('Shared rung');
      try {
        sets({ chinch: new Set([shared.id.toLowerCase()]) });
        expect((await complete(f, { products: [spot(f, { productId: shared.id, areaPlace: 'front', troubleType: 'chinch' })] })).status).toBe(200);
        expect(await typesOf(f)).toEqual([['front', 'chinch']]);
      } finally { await cleanup(f); }
      const g = await seedLawnVisit();
      try {
        sets(null);
        const out = await complete(g, { products: [spot(g, { productId: shared.id, areaPlace: 'front', troubleType: 'chinch' })] });
        expect(out.status).toBe(200);
        expect(await typesOf(g)).toEqual([]);
        expect(await mockPg('service_products').where({ service_record_id: (await recordOf(g)).id })).toHaveLength(1);
        expect(await ledgerOf(g, (await recordOf(g)).id)).toMatchObject({ treated_place: 'front' });
      } finally { await cleanup(g); await mockPg('products_catalog').where({ id: shared.id }).del().catch(() => {}); }
    });

    test('a failed read for a fungicide row with no hint stores no area (never a generic fungus one); a herbicide row is stored without any read', async () => {
      const f = await seedLawnVisit();
      const product = await fungicide();
      try {
        const lookup = sets(null);
        expect((await complete(f, { products: [spot(f, { productId: product.id, areaPlace: 'front' }), spot(f, { areaPlace: 'back' })] })).status).toBe(200);
        expect(await typesOf(f)).toEqual([['back', 'weeds']]);
        expect(lookup).toHaveBeenCalledTimes(1);
      } finally { await cleanup(f); await mockPg('products_catalog').where({ id: product.id }).del().catch(() => {}); }
    });

    // A store read that fails INSIDE the completion's transaction must abort only its savepoint: the other completion writes still commit.
    test('the take-all area lookup fails inside the transaction (the table is missing): the completion still commits its record, product rows and ledger', async () => {
      const f = await seedLawnVisit();
      const product = await fungicide();
      try {
        sets({ takeAll: new Set([product.id.toLowerCase()]) });
        await mockPg.raw('ALTER TABLE lawn_trouble_areas RENAME TO lawn_trouble_areas_away');
        let out;
        try {
          out = await complete(f, { products: [spot(f, { productId: product.id, areaPlace: 'front', troubleSource: 'guide_card' })] });
        } finally {
          await mockPg.raw('ALTER TABLE lawn_trouble_areas_away RENAME TO lawn_trouble_areas');
        }
        expect(out.status).toBe(200);
        const record = await recordOf(f);
        expect(record).toBeTruthy();
        expect(await mockPg('service_products').where({ service_record_id: record.id, treated_place: 'front' })).toHaveLength(1);
        expect(await ledgerOf(f, record.id)).toMatchObject({ treated_place: 'front' });
        expect(await typesOf(f)).toEqual([]);
      } finally { await cleanup(f); await mockPg('products_catalog').where({ id: product.id }).del().catch(() => {}); }
    });

    test('the mapped-place rule follows the server and the source, not the sheet\'s tag: an untagged card row at an unmapped place is refused; a failed read refuses nothing and stores nothing at the unmapped place', async () => {
      const f = await seedLawnVisit();
      const product = await fungicide();
      try {
        const lookup = sets({ takeAll: new Set([product.id.toLowerCase()]) });
        const svc = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
        const areas = require('../services/lawn-trouble-areas');
        const card = (extra = {}) => spot(f, { productId: product.id, areaPlace: 'front', troubleSource: 'guide_card', ...extra });
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [card()] })).toMatchObject({ status: 400, payload: { code: 'lawn_place_not_mapped' } });
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [card({ troubleType: 'fungus' })] })).toMatchObject({ status: 400, payload: { code: 'lawn_place_not_mapped' } });
        // A row from Search maps its place; a row with no source is the Search path too.
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [spot(f, { productId: product.id, areaPlace: 'front' })] })).toBeNull();
        lookup.mockRestore();
        sets(null);
        expect(await areas.preflightPlaces({ knex: mockPg, svc, products: [card()] })).toBeNull();
        // The read succeeded at record time but failed at the preflight: the card row still maps nothing new.
        sets({ takeAll: new Set([product.id.toLowerCase()]) });
        expect((await complete(f, { products: [card()] })).status).toBe(200);
        expect(await typesOf(f)).toEqual([]);
      } finally { await cleanup(f); await mockPg('products_catalog').where({ id: product.id }).del().catch(() => {}); }
    });
  });

  test('no take_all claim: the take-all lookup is not made', async () => {
    const f = await seedLawnVisit();
    try {
      const lookup = jest.spyOn(require('../services/lawn-fast-complete'), 'troubleTypeIdsFor').mockResolvedValue({ takeAll: new Set(), chinch: new Set() });
      await complete(f, { products: [spot(f, { areaPlace: 'front' })] });
      expect(lookup).not.toHaveBeenCalled();
    } finally { await cleanup(f); }
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

  // The customer's service-detail route returns product rows: exactly the columns the table had before the place column, whatever
  // the gate says (the place is a technician and office fact).
  test.each([['on', true], ['off', false]])('GET /api/services/:id never returns treated_place (gate %s)', async (_label, gateOn) => {
    const f = await seedLawnVisit();
    try {
      const out = await complete(f, { products: [spot(f, { areaPlace: 'back' })] });
      expect(out.status).toBe(200);
      gates(gateOn);
      process.env.GATE_LAWN_V13 = 'true';
      const record = await recordOf(f);
      expect(await mockPg('service_products').where({ service_record_id: record.id }).first()).toHaveProperty('treated_place');
      const router = require('../routes/services');
      const layer = router.stack.find((l) => l.route && l.route.path === '/:id' && l.route.methods.get);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
      await handler({ params: { id: record.id }, query: {}, customerId: f.customerId }, res, (err) => { throw err; });
      expect(res.statusCode).toBe(200);
      expect(res.body.products).toHaveLength(1);
      expect(res.body.products[0]).not.toHaveProperty('treated_place');
      // Byte-identical to before the column: the table's other columns, no more and no fewer.
      const columns = Object.keys(await mockPg('service_products').columnInfo()).filter((c) => c !== 'treated_place').sort();
      expect(Object.keys(res.body.products[0]).sort()).toEqual(columns);
    } finally { await cleanup(f); }
  });

  // The rule for a backdated completion: recorded and flagged, never refused, because the application already happened. The history the
  // preflight reads stops at the visit's own day; the closeout audit judges both sides of the date.
  describe('a visit completed late, after a later application at the same place', () => {
    const lateArena = async (priorPlace) => {
      const f = await seedLawnVisit({ daysAgo: 40 });
      const arena = await mockPg('products_catalog').where({ name: 'Arena 50 WDG' }).first();
      const later = etDateString(new Date(Date.now() - 10 * 86400000));
      const [past] = await mockPg('scheduled_services').insert({ customer_id: f.customerId, property_id: f.propertyId, scheduled_date: later, service_type: 'Lawn fixture', status: 'completed' }).returning('*');
      const [prior] = await mockPg('service_records').insert({ customer_id: f.customerId, scheduled_service_id: past.id, service_date: later, service_type: 'Lawn fixture' }).returning('*');
      await mockPg('property_application_history').insert({ customer_id: f.customerId, property_id: f.propertyId, product_id: arena.id, application_date: later, application_rate: 0.147, rate_unit: 'oz', service_record_id: prior.id, treated_place: priorPlace });
      return { f, arena, row: spot(f, { productId: arena.id, areaPlace: 'front', rate: 0.147, rateUnit: 'oz' }) };
    };

    test('October Arena at the front first, then the September front visit completed late: /complete accepts, the row keeps its place, the audit flags it', async () => {
      const { f, row } = await lateArena('front');
      try {
        const svc = await mockPg('scheduled_services').where({ id: f.serviceId }).first();
        expect(await require('../services/lawn-trouble-areas').preflightPlaces({ knex: mockPg, svc, products: [row] })).toBeNull();
        const out = await complete(f, { products: [row] });
        expect(out.status).toBe(200);
        expect(await ledgerOf(f, (await recordOf(f)).id)).toMatchObject({ treated_place: 'front' });
        // 30 days from the other application, inside Arena's 56: the closeout audit reads both sides of the date and flags it.
        expect(out.body.completionAdvisories).toEqual([expect.stringMatching(/^Recorded\. The office will review: Arena 50 WDG is over its minimum days between applications\.$/)]);
      } finally { await cleanup(f); }
    });

    test('the same late visit when the later application was at ANOTHER place: nothing to flag (the audit is judged at the place)', async () => {
      const { f, row } = await lateArena('back');
      try {
        const out = await complete(f, { products: [row] });
        expect(out.status).toBe(200);
        expect(out.body.completionAdvisories).toEqual([]);
      } finally { await cleanup(f); }
    });
  });

  // Two visits of one lawn, the same product at the same place, both past the preflight before either commits: both are recorded (the
  // application already happened); the audit runs after each commit, so the later-committing completion sees both rows and flags it.
  describe('two visits completing back to back, each passing the preflight on the data from before the other committed', () => {
    const twoVisits = async () => {
      const a = await seedLawnVisit({ daysAgo: 20 });
      const arena = await mockPg('products_catalog').where({ name: 'Arena 50 WDG' }).first();
      const bId = randomUUID();
      const bDate = etDateString(new Date(Date.now() - 5 * 86400000));
      await mockPg('scheduled_services').insert({ id: bId, customer_id: a.customerId, property_id: a.propertyId, technician_id: a.techId, service_id: a.catalogId,
        service_type: LAWN_TYPE, scheduled_date: bDate, window_start: '09:00', window_end: '10:00', status: 'confirmed', estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
      return { a, b: { ...a, serviceId: bId }, arena };
    };

    test.each([['A then B', false], ['B then A', true]])('%s: both preflights pass, both complete 200, the later commit raises the advisory, and either visit audited afterwards flags it', async (_label, reversed) => {
      const { a, b, arena } = await twoVisits();
      try {
        const areas = require('../services/lawn-trouble-areas');
        const rowFor = (f) => spot(f, { productId: arena.id, areaPlace: 'front', rate: 0.147, rateUnit: 'oz' });
        const svcOf = (f) => mockPg('scheduled_services').where({ id: f.serviceId }).first();
        // Both preflights are computed before either completion commits.
        expect(await areas.preflightPlaces({ knex: mockPg, svc: await svcOf(a), products: [rowFor(a)] })).toBeNull();
        expect(await areas.preflightPlaces({ knex: mockPg, svc: await svcOf(b), products: [rowFor(b)] })).toBeNull();
        const [first, second] = reversed ? [b, a] : [a, b];
        const one = await complete(first, { products: [rowFor(first)] });
        const two = await complete(second, { products: [rowFor(second)] });
        expect([one.status, two.status]).toEqual([200, 200]);
        expect(await mockPg('property_application_history').where({ customer_id: a.customerId, product_id: arena.id, treated_place: 'front' }).whereNull('retracted_at')).toHaveLength(2);
        expect(one.body.completionAdvisories).toEqual([]);
        expect(two.body.completionAdvisories).toEqual([expect.stringMatching(/^Recorded\. The office will review: Arena 50 WDG is over its minimum days between applications\.$/)]);
        // The earlier-committing visit, audited now that the other row exists, flags it as well: the audit reads both sides of the date.
        const limits = require('../services/application-limits');
        for (const f of [a, b]) {
          const svc = await svcOf(f);
          const violations = await limits.auditHardCountLimits(f.customerId, arena.id, etDateString(svc.scheduled_date), mockPg, { propertyId: f.propertyId, excludeScheduledServiceId: f.serviceId, place: 'front' });
          expect(violations.map((v) => v.type)).toContain('min_interval_days');
        }
      } finally {
        await mockPg('service_completion_attempts').where('service_id', b.serviceId).del().catch(() => {});
        await cleanup(a);
      }
    });
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
