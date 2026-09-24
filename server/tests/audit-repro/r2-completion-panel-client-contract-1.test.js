/**
 * Audit repro r2-completion-panel-client-contract-1: a termite bait-station
 * visit closed as "Customer declined" (no application performed, tech never
 * opened a station) that carries the panel's zero-tap default
 * termiteStations [{id, status:'ok'}, ...] must NOT mint "checked OK"
 * termite_station_checks rows. The server only skips the station sync for
 * visitOutcome === 'incomplete' (complete-scheduled-service.js:7902), so
 * declined visits write a full "all stations checked OK" history.
 *
 * Asserts the CORRECT behaviour (zero check rows on a not-performed
 * outcome), so it FAILS on current code if the bug is real. CONTROL cases
 * prove the harness: 'completed' writes the rows, 'incomplete' does not.
 *
 * Runs only against a private waves_audit_* Postgres clone:
 *   DATABASE_URL=postgres://wavespestcontrol@localhost:5432/waves_audit_<slug>
 * Wiring copied from tests/audit-repro/r2-completion-live-money-tail-2.test.js.
 */
jest.mock('../../models/marker-db', () => () => require('../../models/db'));
jest.mock('../../models/db', () => {
  const db = (table, ...args) => mockPg(table, ...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../services/weather-forecast', () => ({
  ...jest.requireActual('../../services/weather-forecast'), getDailyRainOutlookBounded: jest.fn(async () => null),
}));
jest.mock('../../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn(() => false),
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => null),
}));
jest.mock('../../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../../services/admin-unread', () => ({ getUnreadCountForAdmin: jest.fn(async () => ({ count: 0, at: Date.now() })) }));
jest.mock('../../services/customer-card', () => ({ ensureCardForCompletion: jest.fn(async () => {}) }));
jest.mock('../../services/tree-shrub-assessment', () => ({
  ...jest.requireActual('../../services/tree-shrub-assessment'),
  scoreAndStoreTreeShrubAssessment: jest.fn(async () => null),
}));
jest.mock('../../services/referral-engine', () => ({ creditReferralOnFirstService: jest.fn(async () => {}) }));
jest.mock('../../services/new-recurring-welcome-sms', () => ({
  isNewRecurringSignupCandidate: jest.fn(async () => false), sendNewRecurringWelcome: jest.fn(async () => {}),
}));
jest.mock('../../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => {}), sendMembershipRenewalReminder: jest.fn(async () => {}) }));
jest.mock('../../services/tech-visit-notifications', () => ({ notifyTechVisitChange: jest.fn(async () => {}) }));
jest.mock('../../services/email-template-library', () => ({
  sendTemplate: jest.fn(), loadTemplateByKey: jest.fn(async () => null), activeSuppressionFor: jest.fn(async () => null),
}));
jest.mock('../../services/review-request', () => ({ enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));

const knex = require('knex');
const { randomUUID } = require('crypto');

const connection = process.env.DATABASE_URL;
const postgres = connection && /\/waves_audit_/.test(connection) ? describe : describe.skip;
let mockPg;
jest.setTimeout(90000);

async function seedTermiteVisit() {
  const { etDateString } = require('../../utils/datetime-et');
  const today = etDateString();
  const f = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), serviceId: randomUUID(),
    serviceKey: `fixture_termite_${randomUUID().slice(0, 8)}`, stationIds: [randomUUID(), randomUUID()] };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'TermiteBond', phone: '+12025550177',
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('services').insert({ id: f.catalogId, name: `Fixture Termite Monitoring ${f.serviceKey}`, service_key: f.serviceKey, is_active: true });
  // A termite_bait_station-profiled service (same shape as the seeded
  // termite_monitoring / termite_bait rows) so the server resolves the
  // termite station program for this visit.
  await mockPg('service_completion_profiles').insert({ service_key: f.serviceKey, service_name_snapshot: 'Fixture Termite Monitoring',
    completion_mode: 'service_report', project_type: 'termite_bait_station', active: true });
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, technician_id: f.techId, service_id: f.catalogId,
    service_type: `Fixture Termite Monitoring ${f.serviceKey}`, scheduled_date: today, window_start: '09:00', window_end: '10:00', status: 'confirmed',
    estimated_price: 0, estimated_duration_minutes: 60, create_invoice_on_complete: false });
  // Two existing pins on the property — the panel preloads these and posts
  // { id, status: 'ok' } for each one the tech never touches.
  for (let i = 0; i < f.stationIds.length; i += 1) {
    await mockPg('termite_stations').insert({ id: f.stationIds[i], customer_id: f.customerId, station_number: i + 1, program: 'termite',
      geometry_image: JSON.stringify({ type: 'circle', cx: 0.2 + i * 0.3, cy: 0.5, r: 0.02 }), is_active: true, owned_by: 'customer' });
  }
  return f;
}

async function cleanup(f) {
  await mockPg('notifications').whereRaw("metadata::text like ?", [`%${f.serviceId}%`]).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('termite_station_checks').whereIn('station_id', f.stationIds).del().catch(() => {});
  await mockPg('termite_stations').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).update({ service_record_id: null }).catch(() => {});
  await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('invoices').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('scheduled_services').where({ id: f.serviceId }).del().catch(() => {});
  await mockPg('service_completion_profiles').where({ service_key: f.serviceKey }).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('services').where({ id: f.catalogId }).del().catch(() => {});
  await mockPg('customers').where({ id: f.customerId }).del().catch(() => {});
}

// Exactly what CompletionPanel serializes for a typed termite visit with an
// untouched station map (SchedulePage.jsx:15735 — stationStatuses[id] || 'ok').
function body(f, visitOutcome) {
  return {
    customerRecap: 'Visit closed out.',
    visitOutcome,
    products: [],
    areasServiced: [],
    sendCompletionSms: false,
    requestReview: false,
    structuredFindings: { type: 'termite_bait_station', values: { stations_checked: '0', termite_activity: 'None observed', bait_consumption: 'None — bait intact' } },
    nextStepChips: ['Return when access available'],
    termiteStations: f.stationIds.map((id) => ({ id, status: 'ok' })),
  };
}

async function complete(f, visitOutcome) {
  const { completeScheduledService } = require('../../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey: randomUUID(),
    actor: { techRole: 'admin', technicianId: f.techId, technician: null }, body: body(f, visitOutcome) });
}

async function checksFor(f) {
  return mockPg('termite_station_checks').whereIn('station_id', f.stationIds).orderBy('station_id');
}

postgres('r2-completion-panel-client-contract-1: declined / inspection-only closeouts mint zero-tap "ok" station checks', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  test('CONTROL: a performed ("completed") visit writes one ok check per station (harness sees the sync)', async () => {
    const f = await seedTermiteVisit();
    try {
      const out = await complete(f, 'completed');
      expect(out).toMatchObject({ status: 200 });
      const checks = await checksFor(f);
      expect(checks.map((c) => c.status)).toEqual(['ok', 'ok']);
    } finally { await cleanup(f); }
  });

  test('CONTROL: an "incomplete" visit writes no station checks (the existing guard)', async () => {
    const f = await seedTermiteVisit();
    try {
      const out = await complete(f, 'incomplete');
      expect(out).toMatchObject({ status: 200 });
      expect(await checksFor(f)).toEqual([]);
    } finally { await cleanup(f); }
  });

  test.each(['customer_declined', 'inspection_only'])(
    'a "%s" closeout (visitPerformed=false) must not record a "checked OK" row for stations the tech never touched',
    async (visitOutcome) => {
      const f = await seedTermiteVisit();
      try {
        const out = await complete(f, visitOutcome);
        expect(out).toMatchObject({ status: 200 });
        const record = await mockPg('service_records').where({ customer_id: f.customerId }).first();
        expect(record).toBeTruthy();
        const checks = await checksFor(f);
        // Correct behaviour: no check history for a visit where nothing was
        // inspected (the same rule the server states for 'incomplete').
        expect(checks.map((c) => ({ status: c.status, serviceRecordId: c.service_record_id }))).toEqual([]);
      } finally { await cleanup(f); }
    },
  );
});
