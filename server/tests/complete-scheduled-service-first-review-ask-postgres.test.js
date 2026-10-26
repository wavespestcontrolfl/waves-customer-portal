/**
 * First review ask (GATE_REVIEW_FIRST_ASK_LOCK; owner 2026-10-26, option B), through the real completeScheduledService
 * transaction. A customer never asked for a review (no review request texted or emailed, not marked as reviewed) keeps the
 * ask when the tech turns it off WITHOUT the "Complaint on site" reason; with that reason the ask is off and the reason is
 * saved on the record. Gate off, asked-before and already-reviewed customers, re-service visits and a sheet that pins every
 * text off are all as before. Runs against a migrated, private Postgres; the SMS send and the review enrollment are mocked,
 * nothing real is sent.
 *
 * Wiring copied from complete-scheduled-service-reservice-review-postgres.test.js.
 */
// Read when the gates module first loads: set before any require.
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
jest.mock('../services/review-request', () => ({ ...jest.requireActual('../services/review-request'), reportTextAnchorForRecord: jest.fn(async () => null), reportTextAnchorForVisit: jest.fn(async () => null),
  enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined),
  createInline: jest.fn(async () => ({ url: 'https://example.test/review-link', requestId: 'rr-fixture' })), markInlineDelivered: jest.fn(async () => {}),
}));



const knex = require('knex');
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');
const ReviewService = require('../services/review-request');

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
    throw new Error('First review ask Postgres tests require their own waves_invoiced_fast_test or CI\'s waves_test.');
  }
}
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const PEST_TYPE = 'General Pest Control';

async function seedVisit({ callback = false, asked = false, reviewed = false } = {}) {
  const f = { customerId: randomUUID(), techId: randomUUID(), serviceId: randomUUID(), catalogId: randomUUID(), serviceKey: `fixture_pest_${randomUUID().slice(0, 8)}` };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'FirstAsk', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, has_left_google_review: reviewed });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `${PEST_TYPE} ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: PEST_TYPE, scheduled_date: etDateString(new Date()), window_start: '09:00', window_end: '10:00', status: 'confirmed',
    is_callback: callback, estimated_duration_minutes: 30 });
  if (asked) {
    const when = new Date(Date.now() - 40 * 86400000);
    await mockPg('review_requests').insert({ customer_id: f.customerId, token: randomUUID().replace(/-/g, ''), status: 'sent',
      ...(asked === 'email' ? { sent_at: when } : asked === 'unsent' ? {} : { sms_sent_at: when }) });
  }
  return f;
}

async function cleanup(f) {
  const records = await mockPg('service_records').where({ customer_id: f.customerId }).pluck('id').catch(() => []);
  await mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).del().catch(() => {});
  await mockPg('property_application_history').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_products').whereIn('service_record_id', records).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('review_requests').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('customer_properties').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

async function complete(f, extra) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { visitOutcome: 'completed', products: [], areasServiced: ['Outside'], technicianNotes: 'Treated the entry points.',
      sendCompletionSms: true, includePayLink: true, ...extra } });
}

postgres('the first review ask lock', () => {
  const lockWas = process.env.GATE_REVIEW_FIRST_ASK_LOCK;
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 4 } });
  });
  afterEach(() => { if (lockWas === undefined) delete process.env.GATE_REVIEW_FIRST_ASK_LOCK; else process.env.GATE_REVIEW_FIRST_ASK_LOCK = lockWas; });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  // One completion. Returns how many review asks were enrolled and the saved record's notes.
  async function run({ gate = true, seed, extra }) {
    ReviewService.enrollPostService.mockClear();
    if (gate) process.env.GATE_REVIEW_FIRST_ASK_LOCK = 'true'; else delete process.env.GATE_REVIEW_FIRST_ASK_LOCK;
    const f = await seedVisit(seed);
    try {
      const out = await complete(f, extra);
      expect(out.status).toBe(200);
      const record = await mockPg('service_records').where({ scheduled_service_id: f.serviceId }).first('structured_notes');
      const notes = typeof record.structured_notes === 'string' ? JSON.parse(record.structured_notes) : record.structured_notes;
      return { asks: ReviewService.enrollPostService.mock.calls.length, notes };
    } finally { await cleanup(f); }
  }
  const OFF = { requestReview: false };
  const COMPLAINT = { requestReview: false, reviewOptOutReason: 'complaint_on_site' };

  test('gate off, never asked, box off: no ask and nothing recorded (unchanged)', async () => {
    const out = await run({ gate: false, extra: COMPLAINT });
    expect(out.asks).toBe(0);
    expect(out.notes.requestReview).toBe(false);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, never asked, box off with no reason: the ask stays on and the record says so', async () => {
    const out = await run({ extra: OFF });
    expect(out.asks).toBe(1);
    expect(out.notes.requestReview).toBe(true);
    expect(out.notes.reviewFirstAskLock).toEqual({ neverAsked: true, forcedOn: true, optOutReason: null });
  });

  test('gate on, never asked, box off with another reason: the ask stays on', async () => {
    const out = await run({ extra: { requestReview: false, reviewOptOutReason: 'customer_busy' } });
    expect(out.asks).toBe(1);
    expect(out.notes.reviewFirstAskLock.forcedOn).toBe(true);
  });

  test('gate on, never asked, box off with the complaint reason: no ask and the reason is saved', async () => {
    const out = await run({ extra: COMPLAINT });
    expect(out.asks).toBe(0);
    expect(out.notes.requestReview).toBe(false);
    expect(out.notes.reviewFirstAskLock).toEqual({ neverAsked: true, forcedOn: false, optOutReason: 'complaint_on_site' });
  });

  test('gate on, never asked, box left on: asks as before and adds nothing to the record', async () => {
    const out = await run({ extra: { requestReview: true } });
    expect(out.asks).toBe(1);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, asked before: box off is honored, no marker', async () => {
    const out = await run({ seed: { asked: true }, extra: OFF });
    expect(out.asks).toBe(0);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, asked before by email only: box off is honored', async () => {
    const out = await run({ seed: { asked: 'email' }, extra: OFF });
    expect(out.asks).toBe(0);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, an ask row that was created but never texted or emailed is not an ask', async () => {
    const out = await run({ seed: { asked: 'unsent' }, extra: OFF });
    expect(out.asks).toBe(1);
    expect(out.notes.reviewFirstAskLock.forcedOn).toBe(true);
  });

  test('gate on, marked as already reviewed: box off is honored, no marker', async () => {
    const out = await run({ seed: { reviewed: true }, extra: OFF });
    expect(out.asks).toBe(0);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, a re-service (callback) visit stays off', async () => {
    const out = await run({ seed: { callback: true }, extra: OFF });
    expect(out.asks).toBe(0);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, a sheet that pins every customer text off sends nothing and asks for nothing', async () => {
    const out = await run({ extra: { sendCompletionSms: false, includePayLink: false, requestReview: false } });
    expect(out.asks).toBe(0);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, a customer concern keeps its own suppression and is not overridden', async () => {
    const out = await run({ extra: { requestReview: false, reviewSuppression: 'customer_concern' } });
    expect(out.asks).toBe(0);
    expect(out.notes.reviewFirstAskLock).toBeUndefined();
  });

  test('gate on, forced on: a custom time left in the form does not block the completion', async () => {
    const out = await run({ extra: { requestReview: false, reviewTiming: 'custom', reviewScheduledFor: '2020-01-01T08:00', reviewDelayMinutes: 5 } });
    expect(out.asks).toBe(1);
    expect(out.notes.reviewFirstAskLock.forcedOn).toBe(true);
    expect(out.notes.reviewTiming).toBeNull();
  });
});
