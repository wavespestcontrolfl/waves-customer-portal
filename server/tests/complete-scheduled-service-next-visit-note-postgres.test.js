/**
 * The next-visit adjustment note (owner decision 2026-10-12, "store it"), through the real completeScheduledService
 * transaction: the note lands as one "[From M/D visit] ..." line on the NEXT visit's scheduled_services.notes, once
 * (a replayed completion adds nothing), only on the same customer's later live visit, and never fails the completion.
 * Runs against a migrated, private Postgres; the SMS send and the review scheduler are mocked, nothing real is sent.
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
jest.mock('../services/review-request', () => ({
  enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined),
  createInline: jest.fn(async () => ({ url: 'https://example.test/review-link', requestId: 'rr-fixture' })), markInlineDelivered: jest.fn(async () => {}),
}));


const knex = require('knex');
const { etDateString, addETDays } = require('../utils/datetime-et');
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
    throw new Error('Next-visit note Postgres tests require their own waves_invoiced_fast_test or CI\'s waves_test.');
  }
}
const postgres = SKIP ? describe.skip : describe;
let mockPg;
jest.setTimeout(90000);


const RESERVICE_TYPE = 'Pest Control Re-Service';
const inDays = (n) => etDateString(addETDays(new Date(), n));

// A free pest re-service (the pest_re_service catalog row) for a customer with a phone.
async function seedVisit() {
  const f = { customerId: randomUUID(), techId: randomUUID(), serviceId: randomUUID(), extraCustomerIds: [] };
  await mockPg('customers').insert({ id: f.customerId, first_name: 'Fixture', last_name: 'NextNote', phone: `+1305555${Math.floor(Math.random() * 9000 + 1000)}`,
    email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
  const [property] = await mockPg('customer_properties').insert({ customer_id: f.customerId, address_line1: '100 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('*');
  await mockPg('technicians').insert({ id: f.techId, name: 'Fixture Technician', role: 'technician', active: true });
  f.catalogId = (await mockPg('services').where({ service_key: 'pest_re_service' }).first('id')
    || (await mockPg('services').insert({ id: randomUUID(), name: RESERVICE_TYPE, service_key: 'pest_re_service', is_active: true }).returning('id'))[0]);
  f.catalogId = f.catalogId.id || f.catalogId;
  f.propertyId = property.id;
  await mockPg('scheduled_services').insert({ id: f.serviceId, customer_id: f.customerId, property_id: property.id, technician_id: f.techId, service_id: f.catalogId,
    service_type: RESERVICE_TYPE, scheduled_date: etDateString(new Date()), window_start: '09:00', window_end: '10:00', status: 'confirmed',
    is_callback: true, estimated_duration_minutes: 30 });
  return f;
}

// Another visit on the same customer's books (or another customer's, with its own customer row).
async function addVisit(f, { date, status = 'confirmed', notes = null, otherCustomer = false } = {}) {
  let customerId = f.customerId;
  let propertyId = f.propertyId;
  if (otherCustomer) {
    customerId = randomUUID();
    f.extraCustomerIds.push(customerId);
    await mockPg('customers').insert({ id: customerId, first_name: 'Fixture', last_name: 'OtherNote', phone: `+1305556${Math.floor(Math.random() * 9000 + 1000)}`,
      email: `${customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
    propertyId = (await mockPg('customer_properties').insert({ customer_id: customerId, address_line1: '200 Fixture Street', city: 'Fixture City', zip: '34201', is_primary: true }).returning('id'))[0].id;
  }
  const id = randomUUID();
  await mockPg('scheduled_services').insert({ id, customer_id: customerId, property_id: propertyId, technician_id: f.techId, service_id: f.catalogId,
    service_type: 'Pest Control', scheduled_date: date, window_start: '09:00', window_end: '10:00', status, notes, estimated_duration_minutes: 30 });
  return id;
}
const notesOf = async (id) => (await mockPg('scheduled_services').where({ id }).first('notes')).notes;

async function cleanup(f) {
  const all = [f.customerId, ...f.extraCustomerIds];
  const records = await mockPg('service_records').whereIn('customer_id', all).pluck('id').catch(() => []);
  await mockPg('notifications').whereRaw("metadata->>'customerId' = ?", [f.customerId]).del().catch(() => {});
  await mockPg('property_application_history').where({ customer_id: f.customerId }).del().catch(() => {});
  await mockPg('service_products').whereIn('service_record_id', records).del().catch(() => {});
  await mockPg('service_completion_attempts').where('service_id', f.serviceId).del().catch(() => {});
  await mockPg('service_records').whereIn('customer_id', all).del().catch(() => {});
  await mockPg('scheduled_services').whereIn('customer_id', all).del().catch(() => {});
  await mockPg('customer_properties').whereIn('customer_id', all).del().catch(() => {});
  await mockPg('technicians').where({ id: f.techId }).del().catch(() => {});
  await mockPg('customers').whereIn('id', all).del().catch(() => {});
}

async function complete(f, extra, { idempotencyKey = randomUUID(), actor } = {}) {
  const { completeScheduledService } = require('../services/complete-scheduled-service');
  return completeScheduledService({ serviceId: f.serviceId, idempotencyKey,
    actor: actor || { techRole: 'admin', technicianId: f.techId, technician: null },
    body: { visitOutcome: 'completed', products: [], areasServiced: ['Outside'], technicianNotes: 'Treated the entry points.',
      sendCompletionSms: false, includePayLink: false, ...extra } });
}

postgres('the next-visit adjustment note', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    mockPg = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 4 } });
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });

  // Seeds a visit and runs `fn(fixture)`; always cleans up.
  async function withVisit(fn) {
    const f = await seedVisit();
    try { return await fn(f); } finally { await cleanup(f); }
  }
  const line = (text) => `[From ${Number(etDateString(new Date()).slice(5, 7))}/${Number(etDateString(new Date()).slice(8, 10))} visit] ${text}`;

  test('a note with the card\'s visit id lands as one dated line on that visit; its existing note is kept', () => withVisit(async (f) => {
    const nextId = await addVisit(f, { date: inDays(30), notes: 'Dog in back yard' });
    const laterId = await addVisit(f, { date: inDays(60), notes: 'untouched' });
    const out = await complete(f, { nextVisitAdjustmentNote: '  Gate code changed ', nextVisitId: nextId });
    expect(out.status).toBe(200);
    expect(await notesOf(nextId)).toBe(`Dog in back yard\n${line('Gate code changed')}`);
    expect(await notesOf(laterId)).toBe('untouched');
    const done = await mockPg('scheduled_services').where({ id: f.serviceId }).first('status', 'notes');
    expect(done.status).toBe('completed');
    expect(done.notes).toBeNull();
  }));

  test('an empty note on the target visit gets just the line', () => withVisit(async (f) => {
    const nextId = await addVisit(f, { date: inDays(30) });
    expect((await complete(f, { nextVisitAdjustmentNote: 'Call first', nextVisitId: nextId })).status).toBe(200);
    expect(await notesOf(nextId)).toBe(line('Call first'));
  }));

  test('the same completion replayed adds nothing more', () => withVisit(async (f) => {
    const nextId = await addVisit(f, { date: inDays(30), notes: 'Dog in back yard' });
    const key = randomUUID();
    const body = { nextVisitAdjustmentNote: 'Gate code changed', nextVisitId: nextId };
    expect((await complete(f, body, { idempotencyKey: key })).status).toBe(200);
    expect((await complete(f, body, { idempotencyKey: key })).status).toBe(200);
    expect((await notesOf(nextId)).split('\n').filter((l) => l === line('Gate code changed'))).toHaveLength(1);
    expect(await notesOf(nextId)).toBe(`Dog in back yard\n${line('Gate code changed')}`);
  }));

  test('another customer\'s visit id is never written to: the customer\'s own next visit takes the note', () => withVisit(async (f) => {
    const foreignId = await addVisit(f, { date: inDays(10), otherCustomer: true, notes: 'theirs' });
    const ownNext = await addVisit(f, { date: inDays(30) });
    await addVisit(f, { date: inDays(60), notes: 'later' });
    expect((await complete(f, { nextVisitAdjustmentNote: 'Gate code changed', nextVisitId: foreignId })).status).toBe(200);
    expect(await notesOf(foreignId)).toBe('theirs');
    expect(await notesOf(ownNext)).toBe(line('Gate code changed'));
  }));

  test('another customer\'s visit id and no visit of the customer\'s own: nothing is written and the visit completes', () => withVisit(async (f) => {
    const foreignId = await addVisit(f, { date: inDays(10), otherCustomer: true, notes: 'theirs' });
    expect((await complete(f, { nextVisitAdjustmentNote: 'Gate code changed', nextVisitId: foreignId })).status).toBe(200);
    expect(await notesOf(foreignId)).toBe('theirs');
  }));

  test('no id posted: the earliest live future visit takes it, skipping a cancelled one and an earlier one', () => withVisit(async (f) => {
    const cancelled = await addVisit(f, { date: inDays(5), status: 'cancelled' });
    const nextId = await addVisit(f, { date: inDays(30) });
    expect((await complete(f, { nextVisitAdjustmentNote: 'Skip the lanai' })).status).toBe(200);
    expect(await notesOf(cancelled)).toBeNull();
    expect(await notesOf(nextId)).toBe(line('Skip the lanai'));
  }));

  test('a posted id that is the completed visit itself, or not on the books, falls back to the real next visit', () => withVisit(async (f) => {
    const nextId = await addVisit(f, { date: inDays(30) });
    expect((await complete(f, { nextVisitAdjustmentNote: 'Skip the lanai', nextVisitId: f.serviceId })).status).toBe(200);
    expect(await notesOf(nextId)).toBe(line('Skip the lanai'));
    expect((await mockPg('scheduled_services').where({ id: f.serviceId }).first('notes')).notes).toBeNull();
  }));

  test('no future visit: nothing is written and the completion succeeds', () => withVisit(async (f) => {
    const out = await complete(f, { nextVisitAdjustmentNote: 'Gate code changed', nextVisitId: randomUUID() });
    expect(out.status).toBe(200);
    expect((await mockPg('scheduled_services').where({ customer_id: f.customerId })).map((r) => r.notes)).toEqual([null]);
  }));

  test('no note: nothing is written, with or without an id', () => withVisit(async (f) => {
    const nextId = await addVisit(f, { date: inDays(30), notes: 'Dog in back yard' });
    expect((await complete(f, { nextVisitId: nextId, nextVisitAdjustmentNote: '   ' })).status).toBe(200);
    expect(await notesOf(nextId)).toBe('Dog in back yard');
  }));

  test('a note that would pass the 2000-character cap leaves the next visit alone and the completion succeeds', () => withVisit(async (f) => {
    const full = 'x'.repeat(1990);
    const nextId = await addVisit(f, { date: inDays(30), notes: full });
    expect((await complete(f, { nextVisitAdjustmentNote: 'Gate code changed', nextVisitId: nextId })).status).toBe(200);
    expect(await notesOf(nextId)).toBe(full);
  }));

  test('a technician\'s completion writes only to a visit assigned to that technician', () => withVisit(async (f) => {
    const otherTech = randomUUID();
    await mockPg('technicians').insert({ id: otherTech, name: 'Fixture Other Technician', role: 'technician', active: true });
    try {
      const theirs = await addVisit(f, { date: inDays(30) });
      await mockPg('scheduled_services').where({ id: theirs }).update({ technician_id: otherTech });
      const mine = await addVisit(f, { date: inDays(60) });
      const out = await complete(f, { nextVisitAdjustmentNote: 'Gate code changed', nextVisitId: theirs },
        { actor: { techRole: 'technician', technicianId: f.techId, technician: { id: f.techId, name: 'Fixture Technician' } } });
      expect(out.status).toBe(200);
      expect(await notesOf(theirs)).toBeNull();
      expect(await notesOf(mine)).toBe(line('Gate code changed'));
    } finally {
      await mockPg('scheduled_services').where({ customer_id: f.customerId }).del();
      await mockPg('service_records').where({ customer_id: f.customerId }).del().catch(() => {});
      await mockPg('technicians').where({ id: otherTech }).del().catch(() => {});
    }
  }));

  test('an incomplete visit stores the note too (the form offers the box on every outcome)', () => withVisit(async (f) => {
    const nextId = await addVisit(f, { date: inDays(30) });
    const out = await complete(f, { visitOutcome: 'incomplete', incompleteReason: 'Locked gate', nextVisitAdjustmentNote: 'Bring the key', nextVisitId: nextId });
    expect(out.status).toBe(200);
    expect(await notesOf(nextId)).toBe(line('Bring the key'));
  }));
});
