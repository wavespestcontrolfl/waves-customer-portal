/**
 * The review ask after Fast Complete's fixed pest re-service text (GATE_FAST_COMPLETE_WRAP_UP; owner 2026-10-10 "show on"),
 * through the real completeScheduledService transaction. Fixed mode is honored (GATE_RESERVICE_FAST_COMPLETE and
 * GATE_FAST_COMPLETE_RECAP on, the pest_re_service profile, a performed visit). Gate off, fixed mode never asks for a
 * review; gate on, the body's requestReview decides, and the ask goes through enrollPostService as its own message, never
 * inside the fixed text (that text is byte-identical in every case). The sheets' marker (`wrapUpReviewAsk`) makes an ask
 * depend on the gate being live at completion time, so a gate turned off under an open sheet stops it; a body without the
 * marker (the full form) is untouched. Runs against a migrated, private Postgres; the SMS send
 * and the review scheduler are mocked, nothing real is sent.
 *
 * Wiring copied from complete-scheduled-service-invoiced-visit-postgres.test.js.
 */
// Read when the gates module first loads: set before any require.
process.env.GATE_RESERVICE_FAST_COMPLETE = 'true';
process.env.GATE_FAST_COMPLETE_RECAP = 'true';
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
jest.mock('../services/review-request', () => ({
  enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined),
  createInline: jest.fn(async () => ({ url: 'https://example.test/review-link', requestId: 'rr-fixture' })), markInlineDelivered: jest.fn(async () => {}),
}));


const knex = require('knex');
const { etDateString } = require('../utils/datetime-et');
const { randomUUID } = require('crypto');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
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
    throw new Error('Fixed re-service review Postgres tests require their own waves_invoiced_fast_test or CI\'s waves_test.');
  }
}
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);

const RESERVICE_TYPE = 'Pest Control Re-Service';

// A free pest re-service (the pest_re_service catalog row) for a customer with a phone.
async function seedReservice() {
  const f = { customerId: randomUUID(), techId: randomUUID(), serviceId: randomUUID() };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'Reservice', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  const catalog = await mockPg('services').where({ service_key: 'pest_re_service' }).first('id')
    || (await mockPg('services').insert({ id: randomUUID(), name: RESERVICE_TYPE, service_key: 'pest_re_service', is_active: true }).returning('id'))[0];
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: catalog.id || catalog,
    service_type: RESERVICE_TYPE, scheduled_date: etDateString(new Date()), window_start: '09:00', window_end: '10:00', status: 'confirmed',
    is_callback: true, estimated_duration_minutes: 30 });
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
}

// The two body shapes a re-service closes with. `fixed`: the short form's fixed text. `plain`: no fixed mode (the pest report
// flow, the lawn re-service sheet and the full form post the template text and these same customer-text keys).
const BODIES = {
  fixed: { includePayLink: false, customerRecapMode: 'reservice_fixed' },
  plain: { includePayLink: false },
};
async function complete(f, shape, extra) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { visitOutcome: 'completed', products: [], areasServiced: ['Outside'], technicianNotes: 'Treated the entry points.',
      sendCompletionSms: true, ...BODIES[shape], ...extra } });
}
const completionTexts = () => sendCustomerMessage.mock.calls.map(([input]) => input).filter((input) => input?.purpose === 'service_completion');
const normalized = (text) => text.replace(/\/(?:l|report|r)\/[A-Za-z0-9_-]+/g, '/LINK');

postgres('the review ask on a pest re-service', () => {
  const wrapUpWas = process.env.GATE_FAST_COMPLETE_WRAP_UP;
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 4 } });
  });
  afterEach(() => { if (wrapUpWas === undefined) delete process.env.GATE_FAST_COMPLETE_WRAP_UP; else process.env.GATE_FAST_COMPLETE_WRAP_UP = wrapUpWas; });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  // One completion. Returns the completion text the customer was sent (links normalized), how many review asks were
  // scheduled, and whether the text carries a bundled review link. `gate`: GATE_FAST_COMPLETE_WRAP_UP live at completion time.
  async function run({ gate, shape, extra }) {
    sendCustomerMessage.mockClear();
    ReviewService.enrollPostService.mockClear();
    ReviewService.createInline.mockClear();
    if (gate) process.env.GATE_FAST_COMPLETE_WRAP_UP = 'true'; else delete process.env.GATE_FAST_COMPLETE_WRAP_UP;
    const f = await seedReservice();
    try {
      const out = await complete(f, shape, extra);
      expect(out.status).toBe(200);
      const texts = completionTexts();
      return { texts, text: texts[0] ? normalized(texts[0].body) : null, asks: ReviewService.enrollPostService.mock.calls.length,
        bundled: texts.some((t) => /review-link/.test(t.body)) };
    } finally { await cleanup(f); }
  }
  const ASK = { requestReview: true };
  const MARKED = { requestReview: true, wrapUpReviewAsk: true };

  describe('fixed text (the short form)', () => {
    test('gate off, requestReview true: the fixed text goes and no review ask is scheduled', async () => {
      const off = await run({ gate: false, shape: 'fixed', extra: ASK });
      expect(off.asks).toBe(0);
      expect(off.text).toMatch(/^Your re-service is done\. We treated outside\./);
      expect(off.text).not.toMatch(/review|google/i);
    });

    test('gate on, marked requestReview true: one review ask through enrollPostService; the fixed text is byte-identical and has no review link', async () => {
      const off = await run({ gate: false, shape: 'fixed', extra: ASK });
      const on = await run({ gate: true, shape: 'fixed', extra: MARKED });
      expect(on.asks).toBe(1);
      expect(on.text).toBe(off.text);
      expect(on.bundled).toBe(false);
    });

    test('gate on, requestReview false: no review ask, same fixed text', async () => {
      const off = await run({ gate: false, shape: 'fixed', extra: ASK });
      const on = await run({ gate: true, shape: 'fixed', extra: { requestReview: false } });
      expect(on.asks).toBe(0);
      expect(on.text).toBe(off.text);
    });

    test('gate off, a marked ask from a sheet left open: refused, fixed text unchanged', async () => {
      const off = await run({ gate: false, shape: 'fixed', extra: ASK });
      const stale = await run({ gate: false, shape: 'fixed', extra: MARKED });
      expect(stale.asks).toBe(0);
      expect(stale.text).toBe(off.text);
    });

    test('fixed text asked for but not honored (GATE_FAST_COMPLETE_RECAP off server-side), marked, gate on: no completion text and no review ask', async () => {
      const featureGates = require('../config/feature-gates');
      const real = featureGates.isEnabled;
      jest.spyOn(featureGates, 'isEnabled').mockImplementation((gate) => (gate === 'fastCompleteRecap' ? false : real(gate)));
      try {
        const out = await run({ gate: true, shape: 'fixed', extra: MARKED });
        expect(out.texts).toEqual([]);
        expect(out.asks).toBe(0);
      } finally { jest.restoreAllMocks(); }
    });
  });

  describe('no fixed text (the pest report flow, the lawn re-service sheet and the full form)', () => {
    test('gate off, marked requestReview true (a sheet left open): no review ask and no review link in the completion text', async () => {
      const out = await run({ gate: false, shape: 'plain', extra: MARKED });
      expect(out.texts.length).toBeGreaterThan(0);
      expect(out.asks).toBe(0);
      expect(out.bundled).toBe(false);
    });

    test('gate on, marked requestReview true: the review ask goes (Automatic timing: its own message, not bundled)', async () => {
      const out = await run({ gate: true, shape: 'plain', extra: MARKED });
      expect(out.asks).toBe(1);
      expect(out.bundled).toBe(false);
    });

    test('timing Now: a report-lane re-service never bundles the ask into its text; gate on schedules it, gate off does not', async () => {
      const now = { ...MARKED, reviewTiming: 'now', reviewDelayMinutes: 0 };
      const on = await run({ gate: true, shape: 'plain', extra: now });
      expect(on.bundled).toBe(false);
      expect(on.asks).toBe(1);
      const stale = await run({ gate: false, shape: 'plain', extra: now });
      expect(stale.bundled).toBe(false);
      expect(stale.asks).toBe(0);
    });

    test('gate off, NO marker, requestReview true (the full form\'s body): the ask goes as it does on main', async () => {
      const out = await run({ gate: false, shape: 'plain', extra: ASK });
      expect(out.asks).toBe(1);
      expect(out.bundled).toBe(false);
    });
  });
});
