/**
 * Away Watch closeout photo minimum (GATE_AWAY_WATCH, owner approved 2026-10-31), through the real
 * completeScheduledService transaction: a performed visit whose own scheduled day is inside the member's away window
 * needs 3 uploaded photos, refused the way the Tree & Shrub minimum is refused. Not performed outcomes, a visit outside
 * the window and the gate off are not held to it. Only the S3 upload is replaced (it returns what it was handed).
 * Runs against a migrated, private Postgres.
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
jest.mock('../services/service-photos', () => ({
  ...jest.requireActual('../services/service-photos'),
  uploadServicePhotoDataUrls: jest.fn(async ({ photos = [] }) => ({ uploaded: photos.length, uniqueUploaded: photos.length, failed: 0, errors: [], photos: [] })),
}));
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
const { etDateString, addETDays } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');

// Verified private clone only — never a shared or production URL. Accepts this suite's own
// waves_away_watch_test clone or CI's isolated waves_test. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the marker the CI "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_away_watch_test';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Away Watch Postgres tests require their own waves_away_watch_test or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const PEST_TYPE = 'Quarterly Pest Control Service';
const day = (offset) => etDateString(addETDays(new Date(), offset));
const PHOTO = { data: 'data:image/jpeg;base64,aGVsbG8=', name: 'outside.jpg' };
const photos = (n) => Array.from({ length: n }, (_, i) => ({ ...PHOTO, name: `outside-${i + 1}.jpg` }));

// A pest visit today for a member whose Away Watch window is [from, until).
async function seedAwayVisit({ from = day(-3), until = day(20), window = true } = {}) {
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(), serviceKey: `fixture_pest_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Away', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `${PEST_TYPE} ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: PEST_TYPE, scheduled_date: day(0), window_start: '09:00', window_end: '10:00', status: 'confirmed', estimated_price: 0, estimated_duration_minutes: 45 });
  if (window) await mockPg('property_preferences').insert({ customer_id: f.customerId, away_watch_from: from, away_watch_until: until });
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

async function complete(f, fields = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { customerRecap: 'Visit closed out.', visitOutcome: 'completed', products: [], areasServiced: [], ...fields } });
}

const statusOf = async (f) => (await mockPg('scheduled_services').where({ id: f.serviceId }).first()).status;
const REFUSED = { code: 'away_watch_closeout_photos_upload_required', statusCode: 400, isOperational: true };

postgres('Away Watch closeout photo minimum', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  beforeEach(() => { process.env.GATE_AWAY_WATCH = 'true'; });
  afterEach(() => { delete process.env.GATE_AWAY_WATCH; jest.clearAllMocks(); });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test.each([0, 1, 2])('gate on, performed visit inside the window with %i photos: refused, nothing written, the visit stays open', async (count) => {
    const f = await seedAwayVisit();
    try {
      await expect(complete(f, { completionPhotos: photos(count) })).rejects.toMatchObject(REFUSED);
      expect(await statusOf(f)).toBe('confirmed');
      expect(await mockPg('service_records').where({ scheduled_service_id: f.serviceId })).toHaveLength(0);
    } finally { await cleanup(f); }
  });

  test('gate on, performed visit inside the window with 3 photos: closes, and the tally records the minimum', async () => {
    const f = await seedAwayVisit();
    try {
      const out = await complete(f, { completionPhotos: photos(3) });
      expect(out.status).toBe(200);
      expect(await statusOf(f)).toBe('completed');
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();
      const notes = typeof record.structured_notes === 'string' ? JSON.parse(record.structured_notes) : record.structured_notes;
      expect(notes.completionPhotos).toMatchObject({ uniqueUploaded: 3, requiredMinimum: 3 });
    } finally { await cleanup(f); }
  });

  test.each([
    ['customer_declined', { visitOutcome: 'customer_declined' }],
    ['inspection_only', { visitOutcome: 'inspection_only' }],
    ['incomplete', { visitOutcome: 'incomplete', incompleteReason: 'Gate locked, no access' }],
  ])('gate on, %s inside the window with no photos: not held to the minimum', async (_label, fields) => {
    const f = await seedAwayVisit();
    try {
      const out = await complete(f, fields);
      expect(out.status).toBe(200);
    } finally { await cleanup(f); }
  });

  test('gate on, a visit on the back day (the window ends before it): no minimum', async () => {
    const f = await seedAwayVisit({ from: day(-10), until: day(0) });
    try {
      expect((await complete(f)).status).toBe(200);
    } finally { await cleanup(f); }
  });

  test('gate on, a member with no away dates: no minimum', async () => {
    const f = await seedAwayVisit({ window: false });
    try {
      expect((await complete(f)).status).toBe(200);
    } finally { await cleanup(f); }
  });

  test('gate off: the same visit closes with no photos', async () => {
    delete process.env.GATE_AWAY_WATCH;
    const f = await seedAwayVisit();
    try {
      expect((await complete(f)).status).toBe(200);
      expect(await statusOf(f)).toBe('completed');
    } finally { await cleanup(f); }
  });
});
