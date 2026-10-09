/**
 * The Waves Assessment sheet's `consultationOutcome` through the real completeScheduledService transaction
 * (GATE_ASSESSMENT_FAST_COMPLETE, owner 2026-10-09): one write, so the read of the visit commits with the completion
 * and rolls back with it. A completion refused for a changed visit leaves no consultation_outcomes row; a successful one
 * writes both; the field is refused (nothing written) on a non-assessment visit or with the gate off; a converted (won)
 * consultation is not rewritten; a same-day assessment before its arrival window completes with its read. Runs against a
 * migrated, private Postgres (CI only).
 *
 * Wiring copied from complete-scheduled-service-lawn-places-postgres.test.js.
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

// Verified private clone only — never a shared or production URL. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the marker the CI "DB-gated suites" step greps.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_assessment_outcome_test';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Assessment outcome closeout Postgres tests require this worktree\'s own waves_assessment_outcome_test or CI\'s waves_test.');
  }
}
const connection = testUrl;
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const ASSESSMENT_KEY = 'lawn_inspection';

// The assessment's catalog row and internal-only profile, as the migrations leave them; inserted only when this
// database lacks them, and removed only then.
async function ensureAssessmentCatalog() {
  const made = { serviceId: null, profileKey: null };
  let service = await mockPg('services').where({ service_key: ASSESSMENT_KEY }).first();
  if (!service) {
    [service] = await mockPg('services').insert({ id: randomUUID(), name: 'Waves Assessment', service_key: ASSESSMENT_KEY, is_active: true, category: 'inspection', billing_type: 'one_time' }).returning('*');
    made.serviceId = service.id;
  }
  if (!(await mockPg('service_completion_profiles').where({ service_key: ASSESSMENT_KEY }).first())) {
    await mockPg('service_completion_profiles').insert({
      service_key: ASSESSMENT_KEY, service_name_snapshot: 'Waves Assessment', category: 'inspection', billing_type: 'one_time', followup_policy: 'none',
      completion_mode: 'internal_only', project_type: null, creates_service_record: true, portal_visibility: 'internal_only', portal_attach_policy: 'never', active: true,
    });
    made.profileKey = ASSESSMENT_KEY;
  }
  return { catalogId: service.id, made };
}

async function seedVisit({ type = 'Waves Assessment', catalogId, windowStart = '09:00' } = {}) {
  const f = { customerId: randomUUID(), techId: randomUUID(), serviceId: randomUUID() };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Assessment', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  f.propertyId = property.id;
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: catalogId || null,
    service_type: type, scheduled_date: etDateString(new Date()), window_start: windowStart, window_end: '23:59', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 45, create_invoice_on_complete: false });
  return f;
}

async function cleanup(f) {
  const records = await mockPg('service_records').where({ customer_id: f.customerId }).pluck('id').catch(() => []);
  await mockPg('consultation_outcomes').where({ scheduled_service_id: f.serviceId }).del().catch(() => {});
  await mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).del().catch(() => {});
  await mockPg('service_products').whereIn('service_record_id', records).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('customer_properties').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

const READ = { outcome: 'warm', interests: ['lawn', 'mosquito'], quoteNotes: 'Side yard ants' };

async function complete(f, overrides = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: {
      technicianNotes: 'Walked the yard with the owner.', visitOutcome: 'completed', sendCompletionSms: false, requestReview: false,
      expectedVisit: { customerId: f.customerId, propertyId: f.propertyId, serviceType: 'Waves Assessment', scheduledDate: etDateString(new Date()) },
      consultationOutcome: READ, ...overrides,
    } });
}

const outcomeOf = (f) => mockPg('consultation_outcomes').where({ scheduled_service_id: f.serviceId }).first();
const recordOf = (f) => mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first();

postgres('closeout: the Waves Assessment read of the visit rides the completion transaction', () => {
  const saved = process.env.GATE_ASSESSMENT_FAST_COMPLETE;
  let catalog;
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    catalog = await ensureAssessmentCatalog();
  });
  beforeEach(() => { process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true'; });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_ASSESSMENT_FAST_COMPLETE; else process.env.GATE_ASSESSMENT_FAST_COMPLETE = saved;
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    if (mockPg) {
      if (catalog?.made.profileKey) await mockPg('service_completion_profiles').where({ service_key: catalog.made.profileKey }).del().catch(() => {});
      if (catalog?.made.serviceId) await mockPg('services').where({ id: catalog.made.serviceId }).del().catch(() => {});
      await mockPg.destroy();
    }
  });

  test('a successful completion writes the service record and the consultation outcome', async () => {
    const f = await seedVisit({ catalogId: catalog.catalogId });
    try {
      const out = await complete(f);
      expect(out.status).toBe(200);
      expect(await recordOf(f)).toBeTruthy();
      expect(await outcomeOf(f)).toMatchObject({ outcome: 'warm', customer_id: f.customerId, technician_id: f.techId, quote_notes: 'Side yard ants' });
    } finally { await cleanup(f); }
  });

  test('a completion refused for a changed visit leaves no consultation outcome row', async () => {
    const f = await seedVisit({ catalogId: catalog.catalogId });
    try {
      const out = await complete(f, {
        expectedVisit: { customerId: f.customerId, propertyId: randomUUID(), serviceType: 'Waves Assessment', scheduledDate: etDateString(new Date()) },
      });
      expect(out.status).toBe(409);
      expect(out.body.code).toBe('visit_identity_changed');
      expect(await outcomeOf(f)).toBeUndefined();
      expect(await recordOf(f)).toBeUndefined();
    } finally { await cleanup(f); }
  });

  test('a refused outcome (a rescheduled visit) aborts the completion and writes nothing', async () => {
    const f = await seedVisit({ catalogId: catalog.catalogId });
    try {
      await mockPg('scheduled_services').where({ id: f.serviceId }).update({ status: 'rescheduled' });
      const out = await complete(f);
      expect(out.status).toBeGreaterThanOrEqual(400);
      expect(await outcomeOf(f)).toBeUndefined();
      expect(await recordOf(f)).toBeUndefined();
    } finally { await cleanup(f); }
  });

  test('a same-day assessment before its arrival window completes with its read', async () => {
    const f = await seedVisit({ catalogId: catalog.catalogId, windowStart: '23:58' });
    try {
      const out = await complete(f);
      expect(out.status).toBe(200);
      expect(await outcomeOf(f)).toMatchObject({ outcome: 'warm' });
    } finally { await cleanup(f); }
  });

  test('a consultation that already converted keeps its read; the completion goes on', async () => {
    const f = await seedVisit({ catalogId: catalog.catalogId });
    try {
      await mockPg('consultation_outcomes').insert({
        scheduled_service_id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, outcome: 'won',
        won_via: 'closeout_booking', won_at: new Date(), interests: '[]', recorded_at: new Date(), updated_at: new Date(),
      });
      const out = await complete(f, { consultationOutcome: { outcome: 'cold' } });
      expect(out.status).toBe(200);
      expect(await outcomeOf(f)).toMatchObject({ outcome: 'won' });
    } finally { await cleanup(f); }
  });

  test('the field on a visit that is not an assessment is refused (422) and writes nothing', async () => {
    const f = await seedVisit({ type: 'Quarterly Pest Control' });
    try {
      const out = await complete(f, { expectedVisit: undefined });
      expect(out.status).toBe(422);
      expect(out.body.code).toBe('consultation_outcome_not_allowed');
      expect(await outcomeOf(f)).toBeUndefined();
      expect(await recordOf(f)).toBeUndefined();
    } finally { await cleanup(f); }
  });

  test('the field with the gate off is refused (422) and writes nothing', async () => {
    delete process.env.GATE_ASSESSMENT_FAST_COMPLETE;
    const f = await seedVisit({ catalogId: catalog.catalogId });
    try {
      const out = await complete(f);
      expect(out.status).toBe(422);
      expect(out.body.code).toBe('consultation_outcome_not_allowed');
      expect(await outcomeOf(f)).toBeUndefined();
      expect(await recordOf(f)).toBeUndefined();
    } finally { await cleanup(f); }
  });
});
