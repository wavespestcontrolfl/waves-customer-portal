/** Canonical completion writes against a migrated, private nonproduction database. */
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../models/db', () => {
  const db = (table, ...args) => {
    const query = mockPg(table, ...args);
    // Isolate the notification recipient fixture from other seeded QA staff.
    return table === 'technicians' && mockNotificationRecipientId
      ? query.where({ id: mockNotificationRecipientId }) : query;
  };
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
  // The canonical sender's locked-handoff contract: the caller's claim runs
  // inside withSmsHandoff and its verdict decides whether anything sends.
  sendCustomerMessage: jest.fn(async ({ withSmsHandoff }) => {
    const verdict = withSmsHandoff ? await withSmsHandoff(async () => ({ ok: true })) : { ok: true };
    return verdict.ok === true ? { sent: true } : { sent: false, blocked: true, code: verdict.code, retryable: verdict.retryable === true };
  }),
}));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn(),
  savedCardChargeSuppressesAlternateCollection: jest.fn((...args) =>
    jest.requireActual('../services/stripe').savedCardChargeSuppressesAlternateCollection(...args)),
  assertNoInvoiceChargeReconciliationPending: (...args) =>
    jest.requireActual('../services/stripe').assertNoInvoiceChargeReconciliationPending(...args),
}));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async (_ids, _build, { beforeDispatch } = {}) => (
  beforeDispatch && (await beforeDispatch()) === false ? { subscriptions: 1, sent: 0, superseded: true } : { sent: 1 })) }));
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
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => {}) }));
jest.mock('../services/tech-visit-notifications', () => ({ notifyTechVisitChange: jest.fn(async () => {}) }));

jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  // The summary handoff rechecks the suppression ledger through the library.
  loadTemplateByKey: jest.fn(async () => ({ template: { template_key: 'service.visit_summary' } })),
  activeSuppressionFor: jest.fn(async () => null),
}));
jest.mock('../services/review-request', () => ({ enrollPostService: jest.fn(async () => ({ started: true })), completionReviewDelay: jest.fn(() => undefined) }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const fs = require('node:fs');
const path = require('node:path');
const { saveVisitCompletionPacket, runVisitCompletionPacketEffects, runVisitCompletionPacketMemberEffects, resumePendingVisitCompletions } = require('../services/visit-completion-packets');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');
const { stopBaseKey, dateOnly } = require('../services/visit-groups');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const { acquireScheduledInvoiceMintLock, mintScheduledServiceInvoiceWithDeposit } = require('../services/scheduled-invoice-mint');
const { createVisitCompletionInvoice } = require('../services/visit-completion-invoice');
const { collectVisitCompletionInvoice, assertVisitCompletionCharge } = require('../services/visit-completion-payment');
const EstimateConverter = require('../services/estimate-converter');
const { reserveSlot, commitReservation } = require('../services/slot-reservation');
const { resolveCatalogSlotProfile } = require('../services/estimate-slot-availability');
const { signSlotOffer, appendOfferToSlotId } = require('../utils/slot-offer-token');
const { itemizeFirstApplication } = require('../services/estimate-first-application-invoice');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const originalPestRecap = process.env.PEST_RECAP;
const postgres = connection ? describe : describe.skip;
let mockPg;
let fixture;
let mockNotificationRecipientId;
const originalSummaryKey = process.env.DATA_HYGIENE_VAULT_KEY;
const originalCloseoutGate = process.env.GATE_VISIT_CLOSEOUT;
jest.setTimeout(90000);

function submission(overrides = {}) {
  return {
    visitId: fixture.visitId, idempotencyKey: fixture.key,
    actor: { techRole: 'technician', technicianId: fixture.techId },
    items: fixture.serviceIds.map((serviceId) => ({ serviceId, body: {
      customerRecap: 'The scheduled service was completed.', visitOutcome: 'completed',
      products: [], areasTreated: [], sendCompletionSms: true, requestReview: true,
    } })),
    ...overrides,
  };
}

function acceptanceInvoiceNotes(estimateId, detail = '$99.00 setup fee plus first application') {
  return `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — ${detail}.`;
}

async function prepareAcceptanceInvoice({ coverage = 'exact', status = 'draft', withAdjustments = false } = {}) {
  const estimateId = randomUUID();
  fixture.estimateIds.push(estimateId);
  await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted',
    accepted_at: mockPg.fn.now() });
  const [pestId, lawnId] = fixture.serviceIds;
  await mockPg('scheduled_services').where({ id: pestId }).update({ source_estimate_id: estimateId,
    service_type: 'Quarterly Pest Control', estimated_price: withAdjustments ? 110 : 120, recurring_parent_id: null });
  await mockPg('scheduled_services').where({ id: lawnId }).update({ source_estimate_id: estimateId,
    service_type: 'Lawn Care', estimated_price: withAdjustments ? 112 : 100, recurring_parent_id: null });

  const primary = [
    { client_id: `scheduled_${pestId}_primary`, description: 'Quarterly Pest Control', quantity: 1,
      unit_price: 120, accepted_service_type: 'Quarterly Pest Control', accepted_service_id: fixture.catalogId },
    { client_id: `scheduled_${lawnId}_primary`, description: 'Lawn Care', quantity: 1,
      unit_price: withAdjustments ? 120 : 100, accepted_service_type: 'Lawn Care', accepted_service_id: fixture.catalogId },
  ];
  if (coverage === 'aggregate') primary.splice(0, primary.length,
    { description: 'First service application', quantity: 1, unit_price: 220 });
  if (coverage === 'partial') primary.pop();
  if (coverage === 'foreign') primary[1].accepted_service_id = randomUUID();
  const lineItems = [
    { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: 99 },
    ...primary,
    ...(withAdjustments ? [{ _kind: 'discount', description: 'Accepted plan credit', quantity: 1, unit_price: -18 }] : []),
  ];
  let deposit = null;
  if (withAdjustments) {
    [deposit] = await mockPg('estimate_deposits').insert({ estimate_id: estimateId,
      customer_id: fixture.customerId, amount: 50, status: 'received',
      stripe_payment_intent_id: `pi_fixture_${randomUUID()}` }).returning('*');
  }
  const invoice = await InvoiceService.create({ database: mockPg, customerId: fixture.customerId,
    scheduledServiceId: pestId, title: 'WaveGuard Membership Setup + First Application',
    notes: acceptanceInvoiceNotes(estimateId), lineItems,
    ...(deposit ? { depositCredit: { amount: 50, estimateId } } : {}), dueDate: etDateString() });
  if (deposit) {
    await mockPg('estimate_deposits').where({ id: deposit.id }).update({ credited_amount: 50,
      credited_invoice_id: invoice.id });
    deposit = await mockPg('estimate_deposits').where({ id: deposit.id }).first();
  }
  if (status !== 'draft') {
    await mockPg('invoices').where({ id: invoice.id }).update({ status });
    invoice.status = status;
  }
  return { estimateId, invoice, deposit, pestId, lawnId };
}

// Inject a real failed SQL statement; a JS rejection cannot prove transaction recovery.
async function withReadFailure(matches, run) {
  const shared = mockPg;
  // Keep one root connection so the fault reaches the coordinator's OWN
  // transaction, without wrapping the packet in a caller-owned savepoint.
  mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  const pgConnection = await mockPg.client.acquireConnection();
  const execute = pgConnection.query;
  let failed = false;
  const querySpy = jest.spyOn(pgConnection, 'query').mockImplementation(function (query, callback) {
    if (!failed && matches({ sql: query.text, bindings: query.values || [] })) {
      failed = true;
      return execute.call(this, { ...query, text: 'SELECT 1 / 0', values: [] }, callback);
    }
    return execute.call(this, query, callback);
  });
  await mockPg.client.releaseConnection(pgConnection);
  try {
    await run(mockPg);
    expect(failed).toBe(true);
    // The same connection remains usable after the real commit or rollback.
    await mockPg('customers').where({ id: fixture.customerId }).update({ first_name: 'Recovered' });
    expect(await mockPg('customers').where({ id: fixture.customerId }).first('first_name'))
      .toEqual({ first_name: 'Recovered' });
  } finally {
    querySpy.mockRestore();
    await mockPg.destroy();
    mockPg = shared;
  }
}

postgres('visit completion packet records on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockPg.schema.hasTable('visit_completion_packets'))) throw new Error('Run the repository migrations first');
  });
  afterAll(async () => {
    if (originalSummaryKey === undefined) delete process.env.DATA_HYGIENE_VAULT_KEY;
    else process.env.DATA_HYGIENE_VAULT_KEY = originalSummaryKey;
    if (originalCloseoutGate === undefined) delete process.env.GATE_VISIT_CLOSEOUT;
    else process.env.GATE_VISIT_CLOSEOUT = originalCloseoutGate;
    if (mockPg) await mockPg.destroy();
  });
  beforeEach(async () => {
    mockNotificationRecipientId = null;
    jest.restoreAllMocks();
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    jest.clearAllMocks();
    chargeInvoiceWithSavedCard.mockReset();
    require('../services/stripe').savedCardChargeSuppressesAlternateCollection.mockImplementation((err) => err?.code === 'STRIPE_AMBIGUOUS_OUTCOME');
    // The canonical sender's locked handoff: the caller's claim runs inside
    // withSmsHandoff and its verdict decides whether anything sends.
    sendCustomerMessage.mockImplementation(async (input) => {
      const allowed = await input.withSmsHandoff(async () => ({ ok: true }));
      return allowed.ok ? { sent: true, providerMessageId: 'fixture-sms' } : { blocked: true, code: allowed.code };
    });
    // The email library's equivalent boundary around its provider request.
    require('../services/email-template-library').sendTemplate.mockImplementation(async (input) => {
      let dispatched = false;
      const allowed = await input.withProviderHandoff(async () => { dispatched = true; });
      return dispatched && allowed.ok ? { sent: true } : { sent: false, aborted: true };
    });

    require('../services/notification-triggers').triggerNotification.mockReset().mockResolvedValue({ suppressed: true });
    fixture = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), productId: randomUUID(),
      visitId: randomUUID(), serviceIds: [randomUUID(), randomUUID()].sort(), key: randomUUID(), estimateIds: [] };
    const date = etDateString();
    await mockPg('customers').insert({ id: fixture.customerId, first_name: 'Fixture', phone: '+12025550123',
      email: `${fixture.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false,
      billing_mode: 'per_application' });
    await mockPg('technicians').insert({ id: fixture.techId, name: 'Fixture Technician', role: 'technician', active: true });
    await mockPg('services').insert({ id: fixture.catalogId, name: 'Fixture General Pest Control',
      service_key: `fixture_${fixture.catalogId}`, is_active: true });
    await mockPg('products_catalog').insert({ id: fixture.productId, name: 'Fixture Test Material',
      category: 'other', active: true, inventory_on_hand: 10, inventory_unit: 'oz' });
    await mockPg('service_visits').insert({ id: fixture.visitId, customer_id: fixture.customerId,
      technician_id: fixture.techId, scheduled_date: date, window_start: '09:00', window_end: '11:00',
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: date }), created_by: 'test' });
    await mockPg('scheduled_services').insert(fixture.serviceIds.map((id, index) => ({
      id, customer_id: fixture.customerId, technician_id: fixture.techId, service_id: fixture.catalogId,
      visit_id: fixture.visitId, service_type: 'Fixture General Pest Control', scheduled_date: date,
      window_start: `${9 + index}:00`, window_end: `${10 + index}:00`, status: 'on_site',
      estimated_price: 120, estimated_duration_minutes: 60,
    })));
  });
  afterEach(async () => {
    if (!fixture) return;
    jest.restoreAllMocks();
    if (fixture.httpServer) await new Promise((resolve) => fixture.httpServer.close(resolve));
    if (originalPestRecap === undefined) delete process.env.PEST_RECAP;
    else process.env.PEST_RECAP = originalPestRecap;
    // Only the synthetic fixture's rows; the private database's seeded catalog
    // and migration data remain intact for later billing/UI verification.
    await mockPg('stripe_orphan_charges').where({ customer_id: fixture.customerId }).del();
    await mockPg('payment_plans').where({ customer_id: fixture.customerId }).del();
    await mockPg('invoices').where({ customer_id: fixture.customerId }).del();
    if (fixture.emailMessageId) await mockPg('email_messages').where({ id: fixture.emailMessageId }).del();
    if (fixture.estimateIds.length) {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: null });
      await mockPg('estimate_deposits').whereIn('estimate_id', fixture.estimateIds).del();
      await mockPg('estimates').whereIn('id', fixture.estimateIds).del();
    }
    // Clear movements before cascading customer/service-product deletion.
    await mockPg('product_inventory_movements').where({ product_id: fixture.productId }).del();
    await mockPg('turf_height_readings').where({ customer_id: fixture.customerId }).del();
    await mockPg('activity_log').where({ customer_id: fixture.customerId }).del();
    await mockPg('notifications').whereIn(mockPg.raw("metadata->'payload'->>'serviceId'"), fixture.serviceIds).del();
    await mockPg('product_limits').where({ product_id: fixture.productId }).del();
    await mockPg('customers').where({ id: fixture.customerId }).del();
    if (fixture.formTemplateId) await mockPg('job_form_templates').where({ id: fixture.formTemplateId }).del();
    if (fixture.discountId) await mockPg('discounts').where({ id: fixture.discountId }).del();
    if (fixture.payerId) await mockPg('payers').where({ id: fixture.payerId }).del();
    await mockPg('notification_preferences').where({ admin_user_id: fixture.techId }).del();
    await mockPg('push_subscriptions').where({ admin_user_id: fixture.techId }).del();
    if (fixture.historyTechId) await mockPg('technicians').where({ id: fixture.historyTechId }).del();
    await mockPg('technicians').where({ id: fixture.techId }).del();
    await mockPg('service_completion_profiles').where({ service_key: `fixture_${fixture.catalogId}` }).del();
    await mockPg('services').where({ id: fixture.catalogId }).del();
    await mockPg('products_catalog').where({ id: fixture.productId }).del();
  });

  test('two canonical records commit together and their effects remain pending', async () => {
    const result = await saveVisitCompletionPacket(submission());
    expect(result).toMatchObject({ status: 202, body: { state: 'records_saved', replayed: false } });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((row) => row.status === 'completed')).toBe(true);
    expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds))
      .toEqual(expect.arrayContaining(result.body.items.map((item) => expect.objectContaining({
        service_id: item.serviceId, service_record_id: item.serviceRecordId, status: 'side_effects_pending',
      }))));
    expect(await mockPg('job_status_history').whereIn('job_id', fixture.serviceIds)).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId }).first()).toMatchObject({
      service_type: 'Combined service visit', tech_notes: null, products_applied: [], service_photos: [],
    });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('freezes one server-measured visit duration and replays its proportional allocation', async () => {
    const arrivedAt = new Date(Date.now() - 59 * 60000);
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ arrived_at: arrivedAt });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({
      arrived_at: arrivedAt, actual_start_time: arrivedAt, estimated_duration_minutes: 60,
    });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({
      estimated_duration_minutes: 30,
    });
    const input = submission();
    input.items.forEach((entry) => { entry.body.timeOnSite = '0:59:00'; });

    const saved = await saveVisitCompletionPacket(input);
    expect(saved).toMatchObject({ status: 202, body: { replayed: false } });
    const packet = await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first('payload');
    const allocation = packet.payload.durationAllocation;
    expect(allocation).toMatchObject({ version: 1, source: 'visit_arrived_at', totalMinutes: 59 });
    expect(allocation.items.map((entry) => entry.allocatedMinutes)).toEqual([39, 20]);
    expect(allocation.items.reduce((sum, entry) => sum + entry.allocatedMinutes, 0)).toBe(allocation.totalMinutes);

    const services = await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).orderBy('id');
    const records = await mockPg('service_records').whereIn('scheduled_service_id', fixture.serviceIds)
      .orderBy('scheduled_service_id');
    expect(services.map((row) => row.actual_duration_minutes)).toEqual([39, 20]);
    expect(services[1]).toMatchObject({ arrived_at: null, actual_start_time: null, check_in_time: null });
    expect(records.map((row) => row.structured_notes.visitDurationAllocation.allocatedMinutes)).toEqual([39, 20]);
    expect(records.every((row) => row.structured_notes.visitDurationAllocation.packetId === saved.body.packetId)).toBe(true);

    const changedTimer = structuredClone(input);
    changedTimer.items.forEach((entry) => { entry.body.timeOnSite = '9:59:00'; });
    expect(await saveVisitCompletionPacket(changedTimer)).toMatchObject({
      status: 202, body: { replayed: true, packetId: saved.body.packetId },
    });
    expect((await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first('payload')).payload.durationAllocation)
      .toEqual(allocation);
  });

  test('same-stop retained work reserves recorded minutes and drive cost across save and replay', async () => {
    const [retainedId, liveId] = fixture.serviceIds;
    const start = new Date(Date.now() - 60 * 60000);
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ arrived_at: start });
    await mockPg('scheduled_services').where({ id: retainedId }).update({
      status: 'completed', actual_start_time: start,
      actual_end_time: new Date(start.getTime() + 20 * 60000),
      service_time_minutes: 20, actual_duration_minutes: 20,
    });
    await mockPg('service_records').insert({
      customer_id: fixture.customerId, technician_id: fixture.techId, scheduled_service_id: retainedId,
      service_date: etDateString(), service_type: 'Fixture General Pest Control', status: 'completed',
      structured_notes: JSON.stringify({ timeOnSite: 20 }),
    });
    const { calculateJobCost } = require('../services/job-costing');
    const priorCost = await calculateJobCost(retainedId, mockPg);
    const priorRecord = await mockPg('service_records').where({ scheduled_service_id: retainedId }).first();
    const input = submission();
    input.items = input.items.filter((item) => item.serviceId === liveId);
    const saved = await saveVisitCompletionPacket(input);
    expect(saved.status).toBe(202);
    const packet = await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first();
    expect(packet.payload.durationAllocation).toMatchObject({
      totalMinutes: 60, retainedMinutes: 20, driveCostOwnerServiceId: retainedId,
      items: [{ serviceId: liveId, allocatedMinutes: 40 }],
    });
    await runVisitCompletionPacketMemberEffects(saved.body.packetId);
    expect((await calculateJobCost(liveId, mockPg)).drive_cost).toBe(0);
    const retainedRecord = await mockPg('service_records').where({ scheduled_service_id: retainedId }).first();
    expect(retainedRecord).toEqual({ ...priorRecord, structured_notes: {
      ...priorRecord.structured_notes,
      visitDriveCostAllocation: { version: 1, packetId: saved.body.packetId, ownerServiceId: retainedId },
    } });
    expect((await mockPg('scheduled_services').where({ id: liveId }).first()).actual_duration_minutes).toBe(40);
    // Later row edits cannot change the saved packet's accounting decisions.
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ arrived_at: new Date() });
    expect((await saveVisitCompletionPacket(input)).body.replayed).toBe(true);
    expect((await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first()).payload.durationAllocation)
      .toEqual(packet.payload.durationAllocation);
    const ledger = await mockPg('job_costs').whereIn('scheduled_service_id', fixture.serviceIds);
    expect(ledger.reduce((sum, row) => sum + Number(row.drive_cost), 0)).toBe(priorCost.drive_cost);
  });

  test('multiple retained same-stop reports reconcile to one drive charge atomically', async () => {
    const liveId = randomUUID();
    await mockPg('scheduled_services').insert({ id: liveId, customer_id: fixture.customerId,
      technician_id: fixture.techId, service_id: fixture.catalogId, visit_id: fixture.visitId,
      service_type: 'Fixture General Pest Control', scheduled_date: etDateString(),
      window_start: '11:00', window_end: '12:00', status: 'on_site', estimated_price: 120,
      estimated_duration_minutes: 60 });
    const retainedIds = [...fixture.serviceIds];
    fixture.serviceIds.push(liveId);
    fixture.serviceIds.sort();
    const start = new Date(Date.now() - 60 * 60000);
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ arrived_at: start });
    const { calculateJobCost } = require('../services/job-costing');
    const priorCosts = [];
    for (const id of retainedIds) {
      await mockPg('scheduled_services').where({ id }).update({ status: 'completed',
        actual_start_time: start, actual_end_time: new Date(start.getTime() + 20 * 60000),
        service_time_minutes: 20, actual_duration_minutes: 20 });
      await mockPg('service_records').insert({ customer_id: fixture.customerId,
        technician_id: fixture.techId, scheduled_service_id: id, service_date: etDateString(),
        service_type: 'Fixture General Pest Control', status: 'completed',
        structured_notes: JSON.stringify({ timeOnSite: 20 }) });
      priorCosts.push(await calculateJobCost(id, mockPg));
    }
    expect(priorCosts.every((cost) => cost.drive_cost > 0)).toBe(true);
    const input = submission();
    input.items = input.items.filter((item) => item.serviceId === liveId);
    await withReadFailure(({ sql }) => sql.startsWith('update "job_costs"'), async () => {
      await expect(saveVisitCompletionPacket(input)).rejects.toThrow();
      expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId }).first()).toBeUndefined();
      const records = await mockPg('service_records').whereIn('scheduled_service_id', retainedIds);
      expect(records.every((record) => !record.structured_notes.visitDriveCostAllocation)).toBe(true);
      expect(records.every((record) => Number(record.drive_cost) === priorCosts[0].drive_cost)).toBe(true);
    });
    const saved = await saveVisitCompletionPacket(input);
    expect(saved.status).toBe(202);
    const packet = await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first();
    expect(packet.payload.durationAllocation).toMatchObject({ retainedMinutes: 40,
      driveCostOwnerServiceId: retainedIds[0], items: [{ serviceId: liveId, allocatedMinutes: 20 }] });
    await runVisitCompletionPacketMemberEffects(saved.body.packetId);
    for (const id of [...fixture.serviceIds].reverse()) await calculateJobCost(id, mockPg);
    expect((await saveVisitCompletionPacket(input)).body.replayed).toBe(true);
    const ledger = await mockPg('job_costs').whereIn('scheduled_service_id', fixture.serviceIds);
    const records = await mockPg('service_records').whereIn('scheduled_service_id', fixture.serviceIds);
    expect(records.every((record) => record.structured_notes.visitDriveCostAllocation.ownerServiceId === retainedIds[0])).toBe(true);
    expect(ledger.reduce((sum, row) => sum + Number(row.drive_cost), 0)).toBe(priorCosts[0].drive_cost);
    expect(records.reduce((sum, row) => sum + Number(row.drive_cost), 0)).toBe(priorCosts[0].drive_cost);
  });

  test('a retained backfill consumes neither current minutes nor the current stop drive charge', async () => {
    const [retainedId, liveId] = fixture.serviceIds;
    const start = new Date(Date.now() - 60 * 60000);
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ arrived_at: start });
    await mockPg('scheduled_services').where({ id: retainedId }).update({
      status: 'completed', actual_start_time: start, actual_end_time: new Date(), service_time_minutes: 20,
    });
    await mockPg('service_records').insert({
      customer_id: fixture.customerId, technician_id: fixture.techId, scheduled_service_id: retainedId,
      service_date: etDateString(), service_type: 'Fixture General Pest Control', status: 'completed',
      structured_notes: JSON.stringify({ backfill: true, timeOnSite: 20 }),
    });
    const input = submission();
    input.items = input.items.filter((item) => item.serviceId === liveId);
    const saved = await saveVisitCompletionPacket(input);
    expect(saved.status).toBe(202);
    const packet = await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first();
    expect(packet.payload.durationAllocation).toMatchObject({ retainedWork: [], retainedMinutes: 0,
      driveCostOwnerServiceId: liveId, items: [{ serviceId: liveId, allocatedMinutes: 60 }],
    });
    const record = await mockPg('service_records').where({ scheduled_service_id: liveId }).first();
    expect(record.structured_notes.visitDriveCostAllocation.ownerServiceId).toBe(liveId);
  });

  test('new live members share one durable drive charge even with an explicit admin duration', async () => {
    const input = submission({ actor: { techRole: 'admin', technicianId: fixture.techId } });
    input.items[0].body.timeOnSite = 20;
    const saved = await saveVisitCompletionPacket(input);
    expect(saved.status).toBe(202);
    const { calculateJobCost } = require('../services/job-costing');
    const owner = fixture.serviceIds[0];
    const records = await mockPg('service_records').whereIn('scheduled_service_id', fixture.serviceIds);
    expect(records.every((record) => record.structured_notes.visitDriveCostAllocation.ownerServiceId === owner)).toBe(true);
    const first = await calculateJobCost(owner, mockPg);
    expect(first.drive_cost).toBeGreaterThan(0);
    expect((await calculateJobCost(fixture.serviceIds[1], mockPg)).drive_cost).toBe(0);
    await runVisitCompletionPacketMemberEffects(saved.body.packetId);
    // Recalculate in reverse order: the drive charge cannot move or multiply.
    for (const id of [...fixture.serviceIds].reverse()) await calculateJobCost(id, mockPg);
    const ledger = await mockPg('job_costs').whereIn('scheduled_service_id', fixture.serviceIds);
    const updated = await mockPg('service_records').whereIn('scheduled_service_id', fixture.serviceIds);
    expect(ledger.reduce((sum, row) => sum + Number(row.drive_cost), 0)).toBe(first.drive_cost);
    expect(updated.reduce((sum, row) => sum + Number(row.drive_cost), 0)).toBe(first.drive_cost);
  });

  test('a visit with no server-side start freezes unknown duration instead of duplicating row spans', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const packet = await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first('payload');
    expect(packet.payload.durationAllocation).toMatchObject({
      source: 'unavailable', startedAt: null, totalMinutes: null,
      items: expect.arrayContaining(fixture.serviceIds.map((serviceId) => expect.objectContaining({
        serviceId, allocatedMinutes: null,
      }))),
    });
    const services = await mockPg('scheduled_services').whereIn('id', fixture.serviceIds);
    const records = await mockPg('service_records').whereIn('scheduled_service_id', fixture.serviceIds);
    expect(services.every((row) => row.service_time_minutes == null && row.actual_duration_minutes == null)).toBe(true);
    expect(records.every((row) => row.structured_notes.visitDurationAllocation.allocatedMinutes === null)).toBe(true);
  });

  test('preserves a recordless member correction and allocates only the remaining visit minutes', async () => {
    const start = new Date(Date.now() - 60 * 60000);
    const end = new Date();
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ arrived_at: start });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({
      status: 'completed', actual_start_time: start, actual_end_time: end, completed_at: end,
    });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({
      time_on_site_adjusted_minutes: 20, time_on_site_correction_seq: 1,
      actual_duration_minutes: 20, service_time_minutes: 20,
      actual_end_time: new Date(start.getTime() + 20 * 60000),
    });
    const input = submission();
    input.items.forEach((entry) => { entry.body.timeOnSite = '1:00:00'; });
    const saved = await saveVisitCompletionPacket(input);
    expect(saved.status).toBe(202);
    const packet = await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first('payload');
    expect(packet.payload.durationAllocation).toMatchObject({
      totalMinutes: 60, explicitMinutes: 20,
      items: [{ serviceId: fixture.serviceIds[1], allocatedMinutes: 40 }],
    });
    const record = await mockPg('service_records').where({ scheduled_service_id: fixture.serviceIds[0] }).first();
    expect(record.structured_notes).toMatchObject({ timeOnSite: 20, timeOnSiteAdjusted: true });
    expect(record.structured_notes.visitDurationAllocation).toBeUndefined();
    await runVisitCompletionPacketMemberEffects(saved.body.packetId);
    const services = await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).orderBy('id');
    expect(services.map((row) => row.actual_duration_minutes)).toEqual([20, 40]);
  });

  test.each([0, null])('tracker recovery preserves a saved %s allocation after its first transition fails', async (minutes) => {
    if (minutes === 0) {
      await mockPg('service_visits').where({ id: fixture.visitId }).update({ arrived_at: new Date() });
    }
    const saved = await saveVisitCompletionPacket(submission());
    // A subsequently repaired shared start must not become per-member labor.
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({
      actual_start_time: new Date(Date.now() - 59 * 60000),
    });
    const transitions = require('../services/track-transitions');
    const markComplete = transitions.markComplete;
    const failed = new Set();
    jest.spyOn(transitions, 'markComplete').mockImplementation((id, options) => {
      if (!failed.has(id)) {
        failed.add(id);
        return Promise.reject(new Error('Synthetic first tracker transition outage'));
      }
      return markComplete(id, options);
    });
    expect(await runVisitCompletionPacketMemberEffects(saved.body.packetId)).toMatchObject({
      status: 202, body: { state: 'member_effects_ready' },
    });
    const services = await mockPg('scheduled_services').whereIn('id', fixture.serviceIds);
    expect(services).toHaveLength(2);
    for (const service of services) {
      expect(service).toMatchObject({
        track_state: 'complete', service_time_minutes: minutes, actual_duration_minutes: minutes,
      });
    }
  });

  test('an implausibly large item array is refused before any per-item lock is taken', async () => {
    const input = submission();
    const flood = Array.from({ length: 51 }, () => ({ serviceId: randomUUID(), body: { ...input.items[0].body } }));
    const execute = mockPg.client.constructor.prototype._query;
    const spy = jest.spyOn(mockPg.client.constructor.prototype, '_query').mockImplementation(function record(connection, query) {
      return execute.call(this, connection, query);
    });
    try {
      expect(await saveVisitCompletionPacket({ ...input, items: flood })).toMatchObject({ status: 400, body: { code: 'visit_closeout_members_invalid' } });
      expect(spy.mock.calls.some(([, query]) => /advisory/i.test(query.sql))).toBe(false);
    } finally {
      jest.restoreAllMocks();
    }
  });

  test('resuming effects re-applies the technician scope on the locked members', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved).toMatchObject({ status: 202 });
    const technician = { techRole: 'technician', technicianId: fixture.techId };
    // A whole-visit reassignment that committed after the route's preflight.
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ technician_id: null });
    expect(await runVisitCompletionPacketEffects(saved.body.packetId, undefined, { actor: technician }))
      .toMatchObject({ status: 409, body: { code: 'visit_out_of_scope' } });
    expect(await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first()).toMatchObject({ status: 'processing' });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ technician_id: fixture.techId });
    expect(await runVisitCompletionPacketEffects(saved.body.packetId, undefined, { actor: technician })).toMatchObject({ status: 200 });
  });

  test('status-only completed members still require canonical closeout forms', async () => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ status: 'completed' });
    const input = submission();
    expect(await saveVisitCompletionPacket({ ...input, items: input.items.slice(1) }))
      .toMatchObject({ status: 409, body: { code: 'visit_members_changed' } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202 });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId }).first()).toMatchObject({ total: '240.00' });
  });

  test.each([true, false])('staff scope excludes completed history only with a canonical record: %s', async (hasRecord) => {
    const [historyId, liveId] = fixture.serviceIds;
    fixture.historyTechId = randomUUID();
    const authFields = { role: 'technician', active: true, employment_status: 'active', auth_token_version: 1, must_change_password: false };
    await mockPg('technicians').insert({ id: fixture.historyTechId, name: 'Fixture Former Technician', ...authFields });
    await mockPg('technicians').where({ id: fixture.techId }).update(authFields);
    const { addETDays } = require('../utils/datetime-et');
    await mockPg('scheduled_services').where({ id: historyId }).update({ status: 'completed',
      technician_id: fixture.historyTechId, scheduled_date: etDateString(addETDays(new Date(), -8)) });
    if (hasRecord) await mockPg('service_records').insert({ customer_id: fixture.customerId,
      technician_id: fixture.historyTechId, scheduled_service_id: historyId, service_date: etDateString(),
      service_type: 'Fixture General Pest Control', status: 'completed' });
    const app = require('express')();
    app.use(require('express').json());
    app.use('/api/admin/visit-closeouts', require('../routes/admin-visit-closeouts'));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    fixture.httpServer = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const request = async (technicianId, method = 'GET') => {
      const token = require('jsonwebtoken').sign({ technicianId, type: 'access', tokenVersion: 1 }, require('../config').jwt.secret);
      const response = await fetch(`http://127.0.0.1:${fixture.httpServer.address().port}/api/admin/visit-closeouts/${fixture.visitId}`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': fixture.key },
        ...(method === 'POST' ? { body: JSON.stringify({ items: submission().items.slice(1) }) } : {}),
      });
      return { status: response.status, body: await response.json() };
    };
    expect((await request(fixture.historyTechId)).status).toBe(403);
    const read = await request(fixture.techId);
    expect(read.status).toBe(hasRecord ? 200 : 403);
    if (hasRecord) expect(read.body.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: historyId, requiresForm: false }),
      expect.objectContaining({ id: liveId, requiresForm: true }),
    ]));
    expect((await request(fixture.techId, 'POST')).status).toBe(hasRecord ? 200 : 403);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(hasRecord ? 2 : 0);
    const invoices = await mockPg('invoices').where({ customer_id: fixture.customerId });
    expect(invoices).toHaveLength(hasRecord ? 1 : 0);
    if (hasRecord) expect(invoices[0].total).toBe('120.00');
  });

  test.each([false, true])('staff routes preserve combined closeout after the gate closes (created with full behavior: %s)', async (fullBehavior) => {
    if (fullBehavior) {
      const methodId = randomUUID();
      await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
        processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
        is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
      await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ visit_id: null });
      await mockPg('service_visits').where({ id: fixture.visitId }).del();
      await mockPg('services').where({ id: fixture.catalogId }).update({ groupable: true, group_family: 'recurring_property_service' });
      const visit = await require('../services/visit-groups').createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' });
      expect(visit.behavior_version).toBe(2);
      fixture.visitId = visit.id;
      chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId, selectedMethod, options) => {
        expect(selectedMethod).toBe(methodId);
        await mockPg.transaction(async (trx) => {
          const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
          await trx('customers').where({ id: fixture.customerId }).forUpdate().first();
          await require('../services/visit-completion-payment').assertVisitCompletionCharge(trx, invoice, options.requireVisitCompletionPacketId);
          await trx('invoices').where({ id: invoiceId }).update({ status: 'paid', stripe_payment_intent_id: 'pi_fixture_visit' });
        });
      });
      process.env.GATE_VISIT_CLOSEOUT = 'false';
      expect(await require('../services/visit-groups').ensureLegacyCompletable(fixture.serviceIds[0]))
        .toMatchObject({ ok: false, reason: 'visit_closeout_required' });
      expect(await completeScheduledService({ serviceId: fixture.serviceIds[0], idempotencyKey: randomUUID(),
        actor: submission().actor, body: submission().items[0].body }))
        .toMatchObject({ status: 409, body: { code: 'visit_grouped' } });
      expect(await require('../services/visit-groups').dissolveForLegacyCompletion(fixture.visitId)).toBe(false);
      expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds)).toHaveLength(0);
    }
    const app = require('express')();
    app.use(require('express').json());
    app.use('/api/admin/visit-closeouts', require('../routes/admin-visit-closeouts'));
    app.use('/api/visit-summary', require('../routes/visit-summary-public'));
    app.use('/api/admin/schedule', require('../routes/admin-schedule'));
    app.use('/api/admin/dispatch', require('../routes/admin-dispatch'));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    fixture.httpServer = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(server));
    });
    const request = async (path, { method = 'GET', auth = {}, body } = {}) => {
      const response = await fetch(`http://127.0.0.1:${fixture.httpServer.address().port}${path}`, {
        method, headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': fixture.key },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
    };
    await mockPg('technicians').where({ id: fixture.techId }).update({ employment_status: 'active', auth_token_version: 1, must_change_password: false });
    const token = require('jsonwebtoken').sign({ technicianId: fixture.techId, type: 'access', tokenVersion: 1 }, require('../config').jwt.secret);
    const path = `/api/admin/visit-closeouts/${fixture.visitId}`;
    const auth = { Authorization: `Bearer ${token}` };
    expect((await request(path)).status).toBe(401);
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ technician_id: null });
    expect((await request(path, { method: 'POST', auth, body: { ...submission(), actor: { techRole: 'admin' } } })).status).toBe(403);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ technician_id: fixture.techId });
    const assignedMember = await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).first();
    const { addETDays, etDateString } = require('../utils/datetime-et');
    await mockPg('scheduled_services').where({ id: assignedMember.id }).update({ scheduled_date: etDateString(addETDays(new Date(), -8)) });
    expect((await request(path, { auth })).status).toBe(404);
    expect((await request(path, { method: 'POST', auth, body: { items: submission().items } })).status).toBe(404);
    expect((await request(`${path}/resume`, { method: 'POST', auth, body: {} })).status).toBe(404);
    await mockPg('technicians').where({ id: fixture.techId }).update({ role: 'admin' });
    expect((await request(path, { auth })).status).toBe(200);
    await mockPg('technicians').where({ id: fixture.techId }).update({ role: 'technician' });
    await mockPg('scheduled_services').where({ id: assignedMember.id }).update({ scheduled_date: assignedMember.scheduled_date });
    // A retained cancelled sibling is history, not a gate: the technician
    // still reaches the closeout for the live member, and a form for the
    // retained child is refused by the saver's own membership rule.
    await mockPg('scheduled_services').where({ id: assignedMember.id }).update({ status: 'cancelled', technician_id: null });
    expect((await request(path, { auth })).status).toBe(200);
    expect((await request(path, { method: 'POST', auth, body: { items: submission().items } })).body.code).toBe('visit_members_changed');
    await mockPg('scheduled_services').where({ id: assignedMember.id }).update({ status: assignedMember.status, technician_id: fixture.techId });
    // A rescheduled sibling the frozen visit kept is history too: it is
    // outside the technician's current scope, so it must not gate the
    // closeout as a "current" member, and it is not one of the forms.
    await mockPg('scheduled_services').where({ id: assignedMember.id }).update({ status: 'rescheduled' });
    expect((await request(path, { auth })).status).toBe(200);
    expect((await request(path, { auth })).body.members.map((member) => member.status)).toContain('rescheduled');
    expect((await request(path, { method: 'POST', auth, body: { items: submission().items } })).body.code).toBe('visit_members_changed');
    await mockPg('scheduled_services').where({ id: assignedMember.id }).update({ status: assignedMember.status });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    if (fullBehavior) {
      expect((await request(`/api/admin/dispatch/${fixture.serviceIds[0]}/completion-status`, { auth })).status).toBe(409);
      delete process.env.DATA_HYGIENE_VAULT_KEY;
      expect((await request(path, { method: 'POST', auth, body: { items: submission().items } })).status).toBe(503);
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
      process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    }
    const date = dateOnly((await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).first()).scheduled_date);
    const gateBeforeReadinessCheck = process.env.GATE_VISIT_CLOSEOUT;
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    const unavailableWeek = await request(`/api/admin/schedule/week?start=${date}`, { auth });
    expect(unavailableWeek.status).toBe(200);
    expect(unavailableWeek.body.visitCloseout).toBe(false);
    expect(unavailableWeek.body.days.flatMap((day) => day.services)).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitCloseoutEnabled: fullBehavior })
    ))));
    const unavailableDay = await request(`/api/admin/schedule?date=${date}`, { auth });
    expect(unavailableDay.status).toBe(200);
    expect(unavailableDay.body.visitCloseout).toBe(false);
    expect(unavailableDay.body.services).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitCloseoutEnabled: fullBehavior })
    ))));
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    process.env.GATE_VISIT_CLOSEOUT = gateBeforeReadinessCheck;
    const week = await request(`/api/admin/schedule/week?start=${date}`, { auth });
    expect(week.status).toBe(200);
    expect(week.body.days.flatMap((day) => day.services)).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitId: fixture.visitId, visitCloseoutEnabled: true, visitCloseoutPacket: null })
    ))));
    const day = await request(`/api/admin/schedule?date=${date}`, { auth });
    expect(day.status).toBe(200);
    expect(day.body.services).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitId: fixture.visitId, visitCloseoutEnabled: true })
    ))));
    const result = await request(path, { method: 'POST', auth, body: { items: submission().items } });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ state: 'done', payment: { state: fullBehavior ? 'paid' : 'payment_needed' } });
    expect(result.headers['cache-control']).toContain('no-store');
    process.env.GATE_VISIT_CLOSEOUT = 'false';
    const savedWeek = await request(`/api/admin/schedule/week?start=${date}`, { auth });
    expect(savedWeek.status).toBe(200);
    expect(savedWeek.body.days.flatMap((day) => day.services)).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitId: fixture.visitId, visitCloseoutEnabled: true,
        visitCloseoutPacket: { id: result.body.packetId, status: 'done' } })
    ))));
    const savedDay = await request(`/api/admin/schedule?date=${date}`, { auth });
    expect(savedDay.status).toBe(200);
    expect(savedDay.body.services).toEqual(expect.arrayContaining(fixture.serviceIds.map((id) => (
      expect.objectContaining({ id, visitId: fixture.visitId, visitCloseoutEnabled: true,
        visitCloseoutPacket: { id: result.body.packetId, status: 'done' } })
    ))));
    const detail = await request(path, { auth });
    expect(detail.body).toMatchObject({ packet: { status: 'done' }, invoice: { total: 240, status: fullBehavior ? 'paid' : 'scheduled' } });
    expect((await request(`${path}/resume`, { method: 'POST', auth, body: { items: [], actor: { techRole: 'admin' } } })).status).toBe(200);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(require('../services/email-template-library').sendTemplate).toHaveBeenCalledTimes(1);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(fullBehavior ? 1 : 0);
    const summaryPath = result.body.summaryUrl.replace('/visit/', '/api/visit-summary/');
    const summary = await request(summaryPath);
    expect(summary.status).toBe(200);
    expect(summary.body.services).toHaveLength(2);
    expect(summary.headers['referrer-policy']).toBe('no-referrer');
    expect(summary.headers['x-robots-tag']).toContain('noindex');
    expect(summary.headers['cache-control']).toContain('no-store');
    expect((await request(`${path}/revoke-summary`, { method: 'POST', auth, body: {} })).status).toBe(403);
    await mockPg('technicians').where({ id: fixture.techId }).update({ role: 'admin' });
    expect((await request(path, { auth })).body.canRevokeSummary).toBe(true);
    expect((await request(`${path}/revoke-summary`, { method: 'POST', auth, body: {} })).body).toEqual({ revoked: true });
    const revoked = await request(summaryPath);
    const malformed = await request('/api/visit-summary/not-a-token');
    expect(revoked.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(revoked.body).toEqual(malformed.body);

    const claimToken = randomUUID();
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' })
      .update({ status: 'claimed', claim_token: claimToken, claimed_at: mockPg.fn.now() });
    expect(await require('../services/visit-groups').beginVisitNotificationDispatch(fixture.visitId, 'completion_sms', claimToken)).toBe(false);
    await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_sms' }).update({ status: 'sent' });
    const resumed = await request(`${path}/resume`, { method: 'POST', auth, body: {} });
    expect(resumed.status).toBe(200);
    expect(resumed.body.summaryUrl).toBeNull();
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(require('../services/email-template-library').sendTemplate).toHaveBeenCalledTimes(1);
  });

  test('new closeouts require the creation gate and summary key before any record commits', async () => {
    process.env.GATE_VISIT_CLOSEOUT = 'false';
    expect(await saveVisitCompletionPacket(submission()))
      .toMatchObject({ status: 404, body: { code: 'visit_closeout_disabled' } });
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    expect(await saveVisitCompletionPacket(submission()))
      .toMatchObject({ status: 503, body: { code: 'visit_closeout_unavailable' } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('Auto Pay grouping becomes eligible only with the full closeout gate and summary key', async () => {
    const { createOrJoinVisit } = require('../services/visit-groups');
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ visit_id: null });
    await mockPg('service_visits').where({ id: fixture.visitId }).del();
    await mockPg('services').where({ id: fixture.catalogId }).update({ groupable: true, group_family: 'recurring_property_service' });
    process.env.GATE_VISIT_CLOSEOUT = 'false';
    await expect(createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' })).rejects.toThrow('autopay_enrolled');
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    delete process.env.DATA_HYGIENE_VAULT_KEY;
    await expect(createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' })).rejects.toThrow('autopay_enrolled');
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    expect(await createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' })).toMatchObject({ behavior_version: 2 });
    // The staff grouping route's fast path renders the same decision.
    const { groupingRefusedByAutopay } = require('../services/visit-groups');
    expect(await groupingRefusedByAutopay(fixture.customerId)).toBe(false);
    process.env.GATE_VISIT_CLOSEOUT = 'false';
    expect(await groupingRefusedByAutopay(fixture.customerId)).toBe(true);
    process.env.GATE_VISIT_CLOSEOUT = 'true';
  });

  test('a technician cannot close a visit that left their current window after the preflight read', async () => {
    const { memberInTechnicianScope } = require('../services/visit-completion-packets');
    const actor = { techRole: 'technician', technicianId: fixture.techId };
    const today = etDateString();
    expect(memberInTechnicianScope({ technician_id: fixture.techId, status: 'on_site', scheduled_date: today }, actor)).toBe(true);
    expect(memberInTechnicianScope({ technician_id: fixture.techId, status: 'rescheduled', scheduled_date: today }, actor)).toBe(false);
    expect(memberInTechnicianScope({ technician_id: fixture.techId, status: 'on_site', scheduled_date: '2026-01-01' }, actor)).toBe(false);
    expect(memberInTechnicianScope({ technician_id: fixture.techId, status: 'on_site', scheduled_date: '2026-01-01' }, { techRole: 'admin' })).toBe(true);
    // The locked save re-applies the predicate: the whole visit moved to an old date.
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ scheduled_date: '2026-01-01' });
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ scheduled_date: '2026-01-01',
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: '2026-01-01' }) });
    expect(await saveVisitCompletionPacket(submission({ actor }))).toMatchObject({ status: 409, body: { code: 'visit_out_of_scope' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('member recovery keeps forms, reports and operational records without collecting or delivering', async () => {
    fixture.formTemplateId = randomUUID();
    await mockPg('job_form_templates').insert({ id: fixture.formTemplateId,
      service_type: 'Fixture General Pest Control', name: 'Fixture completion checklist',
      sections: JSON.stringify([{ fields: [{ id: 'checked', required: true }] }]), is_active: true });
    const input = submission();
    for (const item of input.items) item.body.formResponses = { checked: true };
    const saved = await saveVisitCompletionPacket(input);
    expect(await mockPg('job_form_submissions').where({ customer_id: fixture.customerId })).toHaveLength(2);
    await Promise.all([runVisitCompletionPacketMemberEffects(saved.body.packetId), runVisitCompletionPacketMemberEffects(saved.body.packetId)]);
    expect(await runVisitCompletionPacketMemberEffects(saved.body.packetId)).toMatchObject({
      status: 202, body: { state: 'member_effects_ready' },
    });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((record) => /^[a-f0-9]{32}$/.test(record.report_view_token))).toBe(true);
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect((await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds))
      .every((attempt) => attempt.status === 'succeeded')).toBe(true);
    // Simulate losing the response after the canonical attempt succeeded.
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[1] }).update({ status: 'processing' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('job_form_submissions').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(require('../services/customer-card').ensureCardForCompletion).not.toHaveBeenCalled();
    expect(require('../services/referral-engine').creditReferralOnFirstService).not.toHaveBeenCalled();
  });

  test.each([true, false])('a visible report-token failure remains resumable with SMS requested=%s and no phone', async (sendSms) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ phone: '' });
    const input = submission();
    for (const item of input.items) item.body.sendCompletionSms = sendSms;
    const saved = await saveVisitCompletionPacket(input);
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValueOnce(new Error('Synthetic token outage'));
    expect(await runVisitCompletionPacketMemberEffects(saved.body.packetId)).toMatchObject({
      status: 202, body: { state: 'service_effects_pending', code: 'service_report_token_mint_failed' },
    });
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[0] }).first()).toMatchObject({ status: 'processing' });
    expect(await mockPg('service_completion_attempts').where({ service_id: fixture.serviceIds[0] }).first())
      .toMatchObject({ status: 'side_effects_pending' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((record) => /^[a-f0-9]{32}$/.test(record.report_view_token))).toBe(true);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an internal-only report does not block completion on token mint failure', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('service_records').where({ customer_id: fixture.customerId }).update({
      structured_notes: mockPg.raw("structured_notes || ?::jsonb", [JSON.stringify({ typedReportDelivery: 'internal_only' })]),
    });
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValue(new Error('Synthetic token outage'));
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a newly rejected immutable photo caption creates one office exception and leaves the retry queue', async () => {
    const input = submission();
    // Packet photos must upload at save time (main #4011); the caption is
    // what the deferred effects-phase screen rejects.
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    input.items[0].body.completionPhotos = [{ data: 'data:image/png;base64,Zml4dHVyZQ==', name: 'fixture.png', caption: 'Fixture observation' }];
    let saved;
    try {
      saved = await saveVisitCompletionPacket(input);
    } finally {
      config.s3.bucket = priorBucket;
    }
    const indicators = require('../services/service-report/activity-indicators');
    const screen = indicators.findBannedCustomerCopy;
    jest.spyOn(indicators, 'findBannedCustomerCopy').mockImplementation((value) =>
      value === 'Fixture observation' ? ['synthetic_caption_rule'] : screen(value));
    expect(await runVisitCompletionPacketMemberEffects(saved.body.packetId)).toMatchObject({
      status: 200, body: { state: 'office_required', code: 'photo_caption_banned_copy' },
    });
    expect(await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first()).toMatchObject({ status: 'failed' });
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[0] }).first()).toMatchObject({ status: 'failed' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('office_required');
    await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).update({ updated_at: new Date(Date.now() - 120000) });
    const attemptCount = (await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId })
      .orderBy('scheduled_service_id')).map((item) => item.attempt_count);
    await resumePendingVisitCompletions();
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId })
      .orderBy('scheduled_service_id')).map((item) => item.attempt_count)).toEqual(attemptCount);
    expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review', job_id: fixture.serviceIds[0] })).toHaveLength(1);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).billing_hold).toBe(true);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('a packet whose members carry photo bytes still resumes through effects', async () => {
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    const input = submission();
    for (const item of input.items) item.body.completionPhotos = [{ data: 'data:image/png;base64,Zml4dHVyZQ==', name: 'fixture.png', caption: 'Work area' }];
    let saved;
    try {
      saved = await saveVisitCompletionPacket(input);
    } finally {
      config.s3.bucket = priorBucket;
    }
    // The saved form no longer holds bytes; the member attempt hash must match it.
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }))
      .every((item) => item.status === 'done')).toBe(true);
    expect(await mockPg('service_photos').whereIn('service_record_id', saved.body.items.map((item) => item.serviceRecordId)))
      .toHaveLength(2);
    // The replay never re-uploads the byte-less form; the pre-commit counts stay frozen.
    const records = await mockPg('service_records').whereIn('id', saved.body.items.map((item) => item.serviceRecordId));
    expect(records.map((record) => record.structured_notes.completionPhotos)).toEqual([
      expect.objectContaining({ uploaded: 1, failed: 0 }), expect.objectContaining({ uploaded: 1, failed: 0 }),
    ]);
  });

  test('an interrupted first effects claim still writes its operational activity', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[0] }).update({ attempt_count: 2 });
    await mockPg('service_completion_attempts').where({ service_id: fixture.serviceIds[0] }).update({
      status: 'side_effects_running', updated_at: new Date(Date.now() - 2 * require('../services/completion-attempts').STALE_SIDE_EFFECTS_MS),
    });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect(require('../services/notification-triggers').triggerNotification).toHaveBeenCalledWith('job_complete',
      expect.objectContaining({ serviceId: fixture.serviceIds[0], customerId: fixture.customerId }),
      expect.objectContaining({ dedupeKey: expect.any(String) }));
  });

  test('a database failure reloading a claimed saved record remains resumable', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const recordId = saved.body.items.find((item) => item.serviceId === fixture.serviceIds[0]).serviceRecordId;
    const execute = mockPg.client._query;
    let interrupted = false;
    jest.spyOn(mockPg.client, '_query').mockImplementation(function failRecordReload(connection, query) {
      if (!interrupted && query.sql.startsWith('select * from "service_records" where "id" =')
          && query.bindings.includes(recordId)) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic record reload outage'));
      }
      return execute.call(this, connection, query);
    });
    await expect(runVisitCompletionPacketMemberEffects(saved.body.packetId)).rejects.toThrow('Synthetic record reload outage');
    expect(interrupted).toBe(true);
    expect(await mockPg('service_completion_attempts').where({ service_id: fixture.serviceIds[0] }).first())
      .toMatchObject({ status: 'side_effects_pending' });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
  });

  test('member recovery does not enqueue individually approvable pest recap sends', async () => {
    process.env.PEST_RECAP = 'true';
    const enqueue = jest.spyOn(require('../services/service-report/recap-pipeline'), 'enqueueRecap').mockResolvedValue({ queued: true });
    const saved = await saveVisitCompletionPacket(submission());
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect((await mockPg('service_records').where({ customer_id: fixture.customerId })).every((record) => record.service_line === 'pest')).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('backfilled packet recovery stays quiet when report tokens are unavailable', async () => {
    const date = etDateString(new Date(Date.now() - 86400000));
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ scheduled_date: date,
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: date }) });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ scheduled_date: date });
    const input = submission({ actor: { techRole: 'admin', technicianId: fixture.techId } });
    for (const item of input.items) item.body.backfill = true;
    const saved = await saveVisitCompletionPacket(input);
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValue(new Error('Synthetic token outage'));
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(require('../services/customer-card').ensureCardForCompletion).not.toHaveBeenCalled();
    expect(require('../services/referral-engine').creditReferralOnFirstService).not.toHaveBeenCalled();
  });

  test.each([true, false])('interruption after an admin notification does not duplicate activity or push (bell=%s)', async (bell) => {
    mockNotificationRecipientId = fixture.techId;
    await mockPg('notification_preferences').insert({ admin_user_id: fixture.techId, trigger_key: 'job_complete',
      bell_enabled: bell, push_enabled: true, sound_enabled: false });
    jest.spyOn(require('../services/notification-bell-policy'), 'isBellPolicyEnabled').mockReturnValue(false);
    require('../services/notification-triggers').triggerNotification.mockImplementation(
      jest.requireActual('../services/notification-triggers').triggerNotification);
    const saved = await saveVisitCompletionPacket(submission());
    jest.spyOn(require('../services/completion-attempts'), 'markCompletionAttemptSucceeded')
      .mockRejectedValueOnce(new Error('Synthetic interruption after notification'));
    await expect(runVisitCompletionPacketMemberEffects(saved.body.packetId)).rejects.toThrow('Synthetic interruption');
    const pushSends = async () => (await Promise.all(require('../services/push-notifications').sendToAdminUsers.mock.results
      .map((call) => call.value))).map((result) => result.sent);
    expect(await pushSends()).toEqual([1]);
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    // The interrupted member's push was already claimed: the provider is
    // consulted again but refuses at the post-lookup claim, so nothing
    // buzzes twice.
    expect(await pushSends()).toEqual([1, 0, 1]);
    expect(await mockPg('activity_log').where({ customer_id: fixture.customerId, action: 'service_completed' })).toHaveLength(2);
    expect(await mockPg('notifications').whereIn(mockPg.raw("metadata->'payload'->>'serviceId'"), fixture.serviceIds))
      .toHaveLength(bell ? 2 : 0);
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }))
      .every((item) => item.notification_push_started_at)).toBe(true);
  });

  test('a profile cut over to a project flow after the records commit still resumes the saved members', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('service_completion_profiles').insert({ service_key: `fixture_${fixture.catalogId}`,
      service_name_snapshot: 'Fixture General Pest Control', completion_mode: 'project_required',
      project_type: 'fixture_project', active: true });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first()).toMatchObject({ status: 'processing' });
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
    expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }))
      .every((item) => item.status === 'done')).toBe(true);
    // A fresh single-service completion of a project-backed profile is still refused.
    const [serviceId] = fixture.serviceIds;
    await mockPg('service_completion_attempts').where({ service_id: serviceId }).del();
    await mockPg('service_records').where({ scheduled_service_id: serviceId }).del();
    await mockPg('scheduled_services').where({ id: serviceId }).update({ visit_id: null, status: 'on_site' });
    expect((await completeScheduledService({ serviceId, idempotencyKey: randomUUID(),
      body: submission().items[0].body, actor: { techRole: 'technician', technicianId: fixture.techId } })).body.code)
      .toBe('project_required_completion');
  });

  test.each([
    ['a treatment whose profile cuts over to internal_only', false],
    ['a consultation whose profile cuts back to a treatment', true],
  ])('%s replays its effects from the frozen internal-only decision', async (_label, frozenInternalOnly) => {
    const profile = { service_key: `fixture_${fixture.catalogId}`,
      service_name_snapshot: 'Fixture General Pest Control', completion_mode: 'internal_only', active: true };
    if (frozenInternalOnly) await mockPg('service_completion_profiles').insert(profile);
    const saved = await saveVisitCompletionPacket(submission());
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.structured_notes.internalOnlyCompletion === frozenInternalOnly)).toBe(true);
    if (frozenInternalOnly) await mockPg('service_completion_profiles').where({ service_key: profile.service_key }).del();
    else await mockPg('service_completion_profiles').insert(profile);
    const supplies = jest.spyOn(require('../services/supplies-consumption'), 'consumeCompletionSupplies').mockResolvedValue(undefined);
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(supplies).toHaveBeenCalledTimes(2);
    expect(supplies.mock.calls.every(([, args]) => args.isInternalOnlyCompletion === frozenInternalOnly)).toBe(true);
  });

  test('a specialty lane cut over after the records commit does not re-judge the committed observations', async () => {
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'Bed Bug Treatment' });
    await mockPg('services').where({ id: fixture.catalogId }).update({ service_key: 'bed_bug' });
    const input = submission();
    for (const item of input.items) item.body.structuredObservations = ['Initial inspection'];
    const saved = await saveVisitCompletionPacket(input);
    expect(saved).toMatchObject({ status: 202, body: { state: 'records_saved' } });
    // The catalog key now resolves to no specialty lane: the same observation
    // would be refused at intake, but these records are committed.
    await mockPg('services').where({ id: fixture.catalogId }).update({ service_key: `fixture_${fixture.catalogId}` });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first()).toMatchObject({ status: 'processing' });
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).billing_hold).toBe(false);
    expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
  });

  // A cancelled child loses its assignment; a rescheduled child keeps a
  // stale date and window while it awaits re-placement. Neither is this
  // visit's work, so neither reaches the ownership or compatibility checks.
  // The retained child carries the lexicographically FIRST id: the packet's
  // effects must pick their owner from the recorded member, not from the
  // visit's first child, or the history row's stale tuple detaches every
  // claim and the visit never closes.
  test.each([
    ['cancelled', { status: 'cancelled', technician_id: null }],
    ['rescheduled', { status: 'rescheduled', scheduled_date: '2000-01-01', window_start: '14:00', window_end: '16:00' }],
  ])('a retained %s child does not block the live member or own its effects', async (status, changes) => {
    const [retainedId, liveId] = fixture.serviceIds;
    await mockPg('scheduled_services').where({ id: retainedId }).update(changes);
    expect(await saveVisitCompletionPacket(submission())).toMatchObject({ status: 409, body: { code: 'visit_members_changed' } });
    const input = submission({ items: submission().items.filter((item) => item.serviceId === liveId) });
    const saved = await saveVisitCompletionPacket(input);
    expect(saved).toMatchObject({ status: 202, body: { state: 'records_saved' } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(1);
    const packet = await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId }).first();
    expect(packet.payload.retainedMembers).toEqual([{ serviceId: retainedId, status }]);
    expect(await runVisitCompletionPacketEffects(saved.body.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
    const effects = await mockPg('visit_effects').where({ visit_id: fixture.visitId }).select('effect_type', 'status');
    expect(effects.map((effect) => effect.effect_type).sort()).toEqual(expect.arrayContaining(['completion_email', 'completion_sms', 'visit_payment']));
    expect(effects.every((effect) => !['pending', 'claimed'].includes(effect.status))).toBe(true);
  });

  test('a member another runner finished first is accepted instead of failing the packet', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const completion = require('../services/complete-scheduled-service');
    const real = completion.completeScheduledService;
    let raced = false;
    jest.spyOn(completion, 'completeScheduledService').mockImplementation(async (input, context) => {
      if (!raced && context?.phase === 'effects') {
        raced = true;
        // The sweep read this item as processing; a Resume tap finished it first.
        await mockPg('visit_completion_packet_items').where({ id: context.itemId })
          .update({ status: 'done', completed_at: mockPg.fn.now() });
      }
      return real(input, context);
    });
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(raced).toBe(true);
    expect(await mockPg('visit_completion_packets').where({ id: saved.body.packetId }).first()).toMatchObject({ status: 'processing' });
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).billing_hold).toBe(false);
    expect(await mockPg('dispatch_alerts').where({ type: 'visit_closeout_review' }).whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }))
      .every((item) => item.status === 'done')).toBe(true);
  });

  test('a Tree & Shrub member scores its assessment from the durable photos on replay', async () => {
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'Tree & Shrub Care' });
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    const input = submission();
    for (const item of input.items) {
      item.body.completionPhotos = [
        { data: 'data:image/png;base64,Zml4dHVyZQ==', name: 'one.png', caption: 'Front bed' },
        { data: 'data:image/png;base64,c2Vjb25k', name: 'two.png', caption: 'Palms' },
      ];
      item.body.treeShrubCompletion = { ordinanceZone: 'sarasota_venice', bedSqft: 2400, palmCount: 3, palmRootZoneSqft: 600,
        plantInventory: 'Palms, ixora, hibiscus', pollinatorStatus: 'no_blooms_or_no_bees', targetPestOrDisease: 'Scale crawlers',
        pestLifeStage: 'crawler', iracFracLogged: true, snapshotAppliedYtd: 2, fertilizerAppliedYtd: 'January palm fert',
        customerNote: 'Beds treated and palms inspected.' };
    }
    const score = require('../services/tree-shrub-assessment').scoreAndStoreTreeShrubAssessment;
    score.mockReset().mockResolvedValue({ id: randomUUID() });
    const stored = jest.spyOn(require('../services/photos'), 'getPhotoBase64').mockResolvedValue({ data: 'Zml4dHVyZQ==', mimeType: 'image/png' });
    let saved;
    try {
      saved = await saveVisitCompletionPacket(input);
      expect(saved).toMatchObject({ status: 202, body: { state: 'records_saved' } });
      expect(score).not.toHaveBeenCalled();
      expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    } finally {
      config.s3.bucket = priorBucket;
    }
    expect(score).toHaveBeenCalledTimes(2);
    for (const [call] of score.mock.calls) {
      expect(call.photos.map((photo) => photo.caption)).toEqual(['Front bed', 'Palms']);
      expect(call.photos.every((photo) => photo.s3Key && !photo.data)).toBe(true);
      expect(await call.loadImage(call.photos[0])).toEqual({ base64: 'Zml4dHVyZQ==', mimeType: 'image/png' });
    }
    expect(stored).toHaveBeenCalledWith(score.mock.calls[0][0].photos[0].s3Key);
  });

  test('a push subscription lookup outage keeps the member retryable and the push unclaimed', async () => {
    mockNotificationRecipientId = fixture.techId;
    await mockPg('notification_preferences').insert({ admin_user_id: fixture.techId, trigger_key: 'job_complete',
      bell_enabled: false, push_enabled: true, sound_enabled: false });
    await mockPg('push_subscriptions').insert({ admin_user_id: fixture.techId, role: 'technician', platform: 'web',
      subscription_data: JSON.stringify({ endpoint: 'https://push.invalid/fixture', keys: {} }), staff_token_version: 1, active: true });
    jest.spyOn(require('../services/notification-bell-policy'), 'isBellPolicyEnabled').mockReturnValue(false);
    require('../services/notification-triggers').triggerNotification.mockImplementation(
      jest.requireActual('../services/notification-triggers').triggerNotification);
    require('../services/push-notifications').sendToAdminUsers.mockImplementation((...args) => (
      jest.requireActual('../services/push-notifications').sendToAdminUsers(...args)));
    const saved = await saveVisitCompletionPacket(submission());
    const execute = mockPg.client._query;
    let interrupted = false;
    jest.spyOn(mockPg.client, '_query').mockImplementation(function failSubscriptionLookup(connection, query) {
      if (!interrupted && query.sql.includes('from "push_subscriptions"')) {
        interrupted = true;
        return Promise.reject(new Error('Synthetic subscription lookup outage'));
      }
      return execute.call(this, connection, query);
    });
    await expect(runVisitCompletionPacketMemberEffects(saved.body.packetId)).rejects.toThrow('remains pending');
    expect(interrupted).toBe(true);
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }))
      .every((item) => item.status === 'processing' && !item.notification_push_started_at)).toBe(true);
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect((await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }))
      .every((item) => item.status === 'done' && item.notification_push_started_at)).toBe(true);
  });

  test('inspection-credit receipts and recovery recognize a non-anchor billed member', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoice = await mockPg('invoices').where({ customer_id: fixture.customerId }).first();
    const member = fixture.serviceIds.find((id) => id !== invoice.scheduled_service_id);
    const offerId = randomUUID();
    const recordedAt = new Date(Date.now() - 11 * 60 * 1000);
    await mockPg('inspection_credit_offers').insert({ id: offerId, customer_id: fixture.customerId,
      source_scheduled_service_id: member,
      source_service_record_id: saved.body.items.find((item) => item.serviceId === member).serviceRecordId,
      amount: 75, status: 'offered', expires_at: new Date(Date.now() + 7 * 86400000),
      created_at: recordedAt, updated_at: recordedAt });
    const invoiceEmail = require('../services/invoice-email');
    const inspection = require('../services/inspection-credit');
    expect(await invoiceEmail.inspectionCreditMemoForInvoice(invoice)).toContain('$75.00 service credit');
    const notify = jest.spyOn(require('../services/notification-service'), 'notifyAdmin').mockResolvedValue({ id: randomUUID() });
    let observe;
    try {
      await new Promise((resolve) => {
        observe = (_rows, query) => {
          if (query.sql.includes('"status" not in') && query.sql.includes('from "invoices"')
              && query.bindings.includes(member)) resolve();
        };
        mockPg.on('query-response', observe);
        inspection.queueCreditReceiptResend({ scheduledServiceId: member, offerId, attempt: 1 });
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(notify).not.toHaveBeenCalled();
    } finally { mockPg.removeListener('query-response', observe); }
    await mockPg('invoices').where({ id: invoice.id }).update({ status: 'paid', paid_at: new Date() });
    let deliver;
    const receipt = new Promise((resolve) => { deliver = resolve; });
    const sendReceipt = jest.spyOn(invoiceEmail, 'sendReceiptEmail').mockImplementation(async (...args) => {
      deliver(args);
      return { ok: true };
    });
    inspection.queueCreditReceiptResend({ scheduledServiceId: member, offerId, attempt: 1 });
    expect(await receipt).toEqual([invoice.id, { idempotencyKey: `inspection-credit-offer-${offerId}` }]);
    fixture.emailMessageId = randomUUID();
    await mockPg('email_messages').insert({ id: fixture.emailMessageId,
      recipient_email_snapshot: `${fixture.customerId}@example.invalid`, recipient_id: fixture.customerId,
      status: 'sent', trigger_event_id: `invoice_receipt:${invoice.id}`, sent_at: new Date() });
    sendReceipt.mockClear();
    const sweepReads = [];
    const onResult = (rows, query) => {
      if (query.sql.includes('"o"."source_scheduled_service_id" as "visit_id"')) sweepReads.push(rows);
    };
    mockPg.on('query-response', onResult);
    try {
      expect(await inspection.sweepInspectionCreditRedemptions()).not.toHaveProperty('error');
      expect(sweepReads).toHaveLength(2);
      expect(sweepReads.flat()).toEqual([]);
      expect(sendReceipt).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    } finally { mockPg.removeListener('query-response', onResult); }
  });

  test('MOA alerts are persisted once when report-token recovery reruns the member', async () => {
    await mockPg('products_catalog').where({ id: fixture.productId }).update({ moa_group: 'fixture_moa' });
    await mockPg('product_limits').insert({ product_id: fixture.productId, limit_type: 'moa_rotation_max',
      limit_value: 0, severity: 'warning' });
    const input = submission();
    for (const item of input.items) item.body.products = [{ productId: fixture.productId, totalAmount: 1, amountUnit: 'oz',
      applicationMethod: 'bait_placement', areaValue: 1000, areaUnit: 'sqft' }];
    const saved = await saveVisitCompletionPacket(input);
    jest.spyOn(require('../routes/reports-public'), 'ensureReportToken').mockRejectedValueOnce(new Error('Synthetic token outage'));
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('service_effects_pending');
    expect(await mockPg('dispatch_alerts').where({ type: 'moa_violation', job_id: fixture.serviceIds[0] })).toHaveLength(1);
    expect((await runVisitCompletionPacketMemberEffects(saved.body.packetId)).body.state).toBe('member_effects_ready');
    expect(await mockPg('dispatch_alerts').where({ type: 'moa_violation' }).whereIn('job_id', fixture.serviceIds)).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(8);
  });

  test.each(['per_application', 'monthly_membership', 'annual_prepay'])('%s recap-only records need no invoice or billing hold', async (billingMode) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: billingMode });
    const input = submission();
    for (const item of input.items) item.body.oneTimeRecapOnly = true;
    const saved = await saveVisitCompletionPacket(input);
    expect(saved.body.billing).toMatchObject({ state: 'no_charge', invoiceId: null });
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: false });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect((await saveVisitCompletionPacket(input)).body.billing).toMatchObject({ state: 'no_charge' });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'no_charge' });
  });

  test.each([
    ['deposit', false], ['deposit', true], ['discount', false], ['discount', true],
  ])('%s covering the whole invoice settles without collection (Auto Pay %s)', async (coverage, autopay) => {
    if (autopay) {
      const methodId = randomUUID();
      await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
        processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
        is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
      await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    }
    if (coverage === 'deposit') {
      const estimateId = randomUUID();
      fixture.estimateIds.push(estimateId);
      await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted' });
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: estimateId });
      await mockPg('estimate_deposits').insert({ estimate_id: estimateId, customer_id: fixture.customerId,
        amount: 240, status: 'received', stripe_payment_intent_id: `pi_fixture_${randomUUID()}` });
    } else {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({
        primary_line_price: 120, discount_type: 'fixed_amount', discount_amount: 120,
        discount_dollars: 120, discount_name: 'Synthetic full discount',
      });
    }
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved.body.billing).toMatchObject({ state: 'invoice_ready', total: 0 });
    const invoiceId = saved.body.billing.invoiceId;
    // Billing starts only after the member-effect stage has finished each
    // record. This prerequisite exercises that persisted boundary directly.
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const attempts = await Promise.all([
      collectVisitCompletionInvoice(saved.body.packetId), collectVisitCompletionInvoice(saved.body.packetId),
    ]);
    // A competing claim can still hold the stop when the owner reaches its
    // invoice lock. NOWAIT releases that attempt for the existing retry path.
    expect(attempts.every((result) => ['prepaid', 'payment_pending'].includes(result.state))).toBe(true);
    if (attempts.every((result) => result.state === 'payment_pending')) {
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
        .toMatchObject({ status: 'failed', last_error: 'payment_pending' });
    }
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'prepaid', invoiceId });
    const invoice = await mockPg('invoices').where({ id: invoiceId }).first();
    expect(invoice).toMatchObject({ status: 'prepaid', prepaid_prev_status: 'draft', stripe_payment_intent_id: null, scheduled_send_at: null });
    expect(Number(invoice.credit_applied)).toBe(0);
    expect(invoice.paid_at).not.toBeNull();
    expect(await mockPg('payments').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('customer_credit_ledger').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(1);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
      .toMatchObject({ status: 'sent' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    if (coverage === 'deposit') {
      expect(Number((await mockPg('estimate_deposits').where({ estimate_id: fixture.estimateIds[0] }).first()).credited_amount)).toBe(240);
      await InvoiceService.voidInvoice(invoiceId);
      expect(Number((await mockPg('estimate_deposits').where({ estimate_id: fixture.estimateIds[0] }).first()).credited_amount)).toBe(0);
      expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required' });
    }
  });

  test.each([[0, 240, 'payment_needed'], [240, 0, 'prepaid']])(
    'the locked balance overrides a stale snapshot (%s to %s)', async (before, after, expectedState) => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('invoices').where({ id: invoiceId }).update({ total: before });
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const editor = await mockPg.transaction();
    await editor('invoices').where({ id: invoiceId }).forUpdate().first();
    let observed;
    const waiting = new Promise((resolve) => { observed = resolve; });
    const onQuery = (query) => {
      if (/select.*"invoices".*for update/i.test(query.sql)) observed();
    };
    mockPg.on('query', onQuery);
    const collection = collectVisitCompletionInvoice(saved.body.packetId);
    try {
      await Promise.race([waiting, collection.then(() => { throw new Error('Collection finished before acquiring the invoice lock'); })]);
      await editor('invoices').where({ id: invoiceId }).update({ total: after });
      await editor.commit();
      expect(await collection).toMatchObject({ state: expectedState });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect((await mockPg('invoices').where({ id: invoiceId }).first()).status).toBe(after === 0 ? 'prepaid' : 'draft');
    } finally {
      mockPg.off('query', onQuery);
      if (!editor.isCompleted()) await editor.rollback();
      await collection;
    }
  });

  test('zero settlement waits for a reminder handoff, then completes its sequence atomically', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0 });
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const [sequence] = await mockPg('invoice_followup_sequences').insert({
      invoice_id: invoiceId, customer_id: fixture.customerId, status: 'active',
      touch_claimed_at: new Date(), next_touch_at: new Date(),
    }).returning('*');
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
    expect((await mockPg('invoices').where({ id: invoiceId }).first()).status).toBe('draft');
    expect((await mockPg('invoice_followup_sequences').where({ id: sequence.id }).first()).status).toBe('active');
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(0);
    await mockPg('invoice_followup_sequences').where({ id: sequence.id }).update({ touch_claimed_at: new Date(Date.now() - 11 * 60 * 1000) });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'prepaid' });
    expect(await mockPg('invoice_followup_sequences').where({ id: sequence.id }).first())
      .toMatchObject({ status: 'completed', touch_claimed_at: null, next_touch_at: null });
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([0, 240])('an active invoice send delays a %s balance until delivery finishes', async (total) => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sending', total, discount_amount: 240 - total });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending', invoiceId });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' })).toHaveLength(0);
    // The locked guard also protects an initial snapshot read before the send
    // claim, including the canonical saved-card caller's second check.
    await expect(mockPg.transaction(async (trx) => {
      const locked = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
      await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
      await assertVisitCompletionCharge(trx, locked, saved.body.packetId);
    })).rejects.toMatchObject({ code: 'VISIT_PAYMENT_SEND_IN_FLIGHT' });
    expect(await mockPg('invoices').where({ id: invoiceId }).first('status')).toEqual({ status: 'sending' });
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first('billing_hold')).toEqual({ billing_hold: false });

    await mockPg('invoices').where({ id: invoiceId }).update({ status: 'sent' });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({
      state: total === 0 ? 'prepaid' : 'payment_needed', invoiceId,
    });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('positive shared-invoice collection remains singular and replays its paid state', async () => {
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
      is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    let providerSubmissions = 0;
    chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId, selectedMethod, options) => {
      expect(selectedMethod).toBe(methodId);
      expect(options).toMatchObject({ requireAutopayForCustomerId: fixture.customerId, refuseWhenDunningStopped: true });
      await mockPg.transaction(async (trx) => {
        const invoice = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
        require('../services/invoice-helpers').assertInvoiceCollectible(invoice);
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first();
        await assertVisitCompletionCharge(trx, invoice, options.requireVisitCompletionPacketId);
        providerSubmissions += 1;
        await trx('invoices').where({ id: invoiceId }).update({ status: 'paid', stripe_payment_intent_id: 'pi_fixture_visit' });
      });
    });
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await Promise.all([collectVisitCompletionInvoice(saved.body.packetId), collectVisitCompletionInvoice(saved.body.packetId)]);
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'paid' });
    // Another collection's stop claim can refuse the first invocation before
    // submission. A retry may enter the rail again, but money moves only once.
    expect(providerSubmissions).toBe(1);
    await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds).update({ status: 'succeeded' });
    const status = await require('../services/closeout-status').getCloseoutStatus(fixture.serviceIds[1], { knex: mockPg });
    expect(status.facts.invoice).toMatchObject({ state: 'done', invoiceId: saved.body.billing.invoiceId, status: 'paid' });
    await mockPg('invoices').where({ id: saved.body.billing.invoiceId }).update({ status: 'refunded' });
    expect((await require('../services/closeout-status').getCloseoutStatus(fixture.serviceIds[1], { knex: mockPg })).facts.invoice)
      .toMatchObject({ reason: 'parked_manual_reversed_packet_invoice', invoiceId: saved.body.billing.invoiceId, status: 'refunded' });
  });

  test.each(['active', 'completed', 'cancelled'])('the %s installment plan is checked even without a reminder sequence', async (planStatus) => {
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_plan',
      is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await mockPg('payment_plans').insert({ customer_id: fixture.customerId, invoice_id: invoiceId,
      total_balance: 240, payment_amount: 60, payment_frequency: 'weekly',
      plan_start_date: etDateString(), next_payment_date: etDateString(new Date(Date.now() + 7 * 86400000)),
      status: planStatus });
    expect(await mockPg('invoice_followup_sequences').where({ invoice_id: invoiceId })).toHaveLength(0);
    let providerSubmissions = 0;
    chargeInvoiceWithSavedCard.mockImplementation(async (id, _method, options) => {
      await mockPg.transaction(async (trx) => {
        const invoice = await trx('invoices').where({ id }).forUpdate().first();
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await assertVisitCompletionCharge(trx, invoice, options.requireVisitCompletionPacketId);
        providerSubmissions += 1;
        await trx('invoices').where({ id }).update({ status: 'paid', stripe_payment_intent_id: 'pi_fixture_plan' });
      });
    });
    const expectedState = planStatus === 'active' ? 'office_required' : 'paid';
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: expectedState });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: expectedState });
    expect(providerSubmissions).toBe(planStatus === 'active' ? 0 : 1);
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
      .toMatchObject({ status: planStatus === 'active' ? 'suppressed' : 'sent' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an interrupted accepted ACH payment recovers without a second collection', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const groups = require('../services/visit-groups');
    const member = await mockPg('scheduled_services').where({ visit_id: fixture.visitId }).orderBy('id').first();
    expect(await groups.claimVisitNotification(member, 'visit_payment')).toMatchObject({ state: 'owner' });
    await mockPg('invoices').where({ id: saved.body.billing.invoiceId })
      .update({ status: 'processing', stripe_payment_intent_id: 'pi_fixture_ach_processing' });
    await mockPg('payments').insert({ customer_id: fixture.customerId, amount: 240,
      payment_date: etDateString(), status: 'processing', processor: 'stripe',
      stripe_payment_intent_id: 'pi_fixture_ach_processing', metadata: { invoice_id: saved.body.billing.invoiceId } });
    for (let replay = 0; replay < 2; replay++) {
      expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'processing' });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first())
        .toMatchObject({ payment_intent_id: 'pi_fixture_ach_processing' });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
        .toMatchObject({ status: 'sent' });
    }
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each(['paid', 'prepaid', 'processing'])('a recovered %s invoice waits for payment-effect finalization', async (status) => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const groups = require('../services/visit-groups');
    const member = await mockPg('scheduled_services').where({ visit_id: fixture.visitId }).orderBy('id').first();
    expect(await groups.claimVisitNotification(member, 'visit_payment')).toMatchObject({ state: 'owner' });
    const paymentIntentId = status === 'prepaid' ? null : `pi_fixture_recovered_${status}`;
    await mockPg('invoices').where({ id: invoiceId }).update({ status, stripe_payment_intent_id: paymentIntentId });
    if (status === 'processing') await mockPg('payments').insert({ customer_id: fixture.customerId, amount: 240,
      payment_date: etDateString(), status: 'processing', processor: 'stripe',
      stripe_payment_intent_id: paymentIntentId, metadata: { invoice_id: invoiceId } });
    const finalizer = jest.spyOn(groups, 'finalizeVisitNotification').mockResolvedValueOnce({ ok: false });
    try {
      expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending', invoiceId });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
        .toMatchObject({ status: 'claimed' });
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first())
        .toMatchObject({ payment_intent_id: null });
      for (let replay = 0; replay < 2; replay++) {
        expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: status, invoiceId });
        expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
          .toMatchObject({ status: 'sent' });
        expect(await mockPg('service_visits').where({ id: fixture.visitId }).first())
          .toMatchObject({ payment_intent_id: paymentIntentId });
      }
    } finally {
      finalizer.mockRestore();
    }
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an office hold retries a lost payment-effect finalization before reporting reconciliation', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0, stripe_payment_intent_id: 'pi_fixture_existing' });
    const groups = require('../services/visit-groups');
    const finalizer = jest.spyOn(groups, 'finalizeVisitNotification')
      .mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: false });
    try {
      // First the guard persists the hold; then a recovery sees that hold.
      // Both must remain retryable while their ledger finalization fails.
      for (let retry = 0; retry < 2; retry++) {
        expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending', invoiceId });
        expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: true });
        expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
          .toMatchObject({ status: 'claimed' });
      }
      for (let replay = 0; replay < 2; replay++) {
        expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required', invoiceId });
        expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
          .toMatchObject({ status: 'suppressed' });
      }
    } finally {
      finalizer.mockRestore();
    }
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each([null, 'pi_fixture_ambiguous'])('processing with an ambiguous PI (%s) waits for matching payment evidence', async (paymentIntentId) => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const groups = require('../services/visit-groups');
    const member = await mockPg('scheduled_services').where({ visit_id: fixture.visitId }).orderBy('id').first();
    expect(await groups.claimVisitNotification(member, 'visit_payment')).toMatchObject({ state: 'owner' });
    await jest.requireActual('../services/stripe').parkInvoiceForSavedCardReconciliation({ invoiceId,
      error: { code: 'STRIPE_AMBIGUOUS_OUTCOME', stripePaymentIntentId: paymentIntentId } });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
    const [payment] = await mockPg('payments').insert({ customer_id: fixture.customerId, amount: 240,
      payment_date: etDateString(), status: 'processing', processor: 'stripe',
      stripe_payment_intent_id: 'pi_fixture_other_payment', metadata: { invoice_id: invoiceId } }).returning('*');
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
    const resolvedIntentId = paymentIntentId || 'pi_fixture_late_reconciliation';
    await mockPg('invoices').where({ id: invoiceId }).update({ stripe_payment_intent_id: resolvedIntentId });
    await mockPg('payments').where({ id: payment.id }).update({ stripe_payment_intent_id: resolvedIntentId, status: 'failed' });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
    await mockPg('payments').where({ id: payment.id }).update({ status: 'processing', amount: 120 });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
      .toMatchObject({ status: 'claimed' });
    await mockPg('payments').where({ id: payment.id }).update({ amount: 240 });
    for (let replay = 0; replay < 2; replay++) {
      expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'processing' });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
        .toMatchObject({ status: 'sent', provider_id: resolvedIntentId, last_error: null });
    }
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each(['claimed', 'ambiguous', 'orphan', 'legacy_ambiguous'])('zero settlement respects the %s reconciliation fence', async (fence) => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0 });
    const metadata = { invoice_id: invoiceId, ambiguous_outcome: true };
    if (fence === 'orphan') {
      await mockPg('stripe_orphan_charges').insert({ customer_id: fixture.customerId, invoice_id: invoiceId,
        stripe_payment_intent_id: `pi_fixture_orphan_${fixture.key}`, amount: 240, original_db_error: 'Synthetic write interruption' });
    } else if (fence === 'legacy_ambiguous') {
      await mockPg('payments').insert({ customer_id: fixture.customerId, amount: 240,
        payment_date: etDateString(), status: 'failed', processor: 'stripe', metadata });
    } else {
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: invoiceId,
        stripe_payment_method_id: 'pm_fixture_pending', idempotency_key: fixture.key,
        status: fence, submitted_at: new Date() });
    }
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending', invoiceId });
    expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'draft' });
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(0);
    if (fence === 'orphan') {
      await mockPg('stripe_orphan_charges').where({ invoice_id: invoiceId }).update({ resolved: true, resolved_at: new Date() });
    } else if (fence === 'legacy_ambiguous') {
      await mockPg('payments').where({ customer_id: fixture.customerId }).update({ metadata: { ...metadata, ambiguous_outcome: false } });
    } else {
      await mockPg('stripe_invoice_charge_attempts').where({ invoice_id: invoiceId }).update({ status: 'failed', resolved_at: new Date() });
    }
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'prepaid', invoiceId });
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a crash after decline finalization preserves its terminal reason without another charge', async () => {
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
      is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    chargeInvoiceWithSavedCard.mockImplementation(async () => {
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: invoiceId, payment_method_id: methodId,
        stripe_payment_method_id: 'pm_fixture_visit', idempotency_key: fixture.key, status: 'failed',
        submitted_at: new Date(), resolved_at: new Date() });
      throw Object.assign(new Error('Synthetic provider decline'), { wavesCardDecline: true });
    });
    const groups = require('../services/visit-groups');
    const realFinalize = groups.finalizeVisitNotification;
    const finalizer = jest.spyOn(groups, 'finalizeVisitNotification').mockImplementationOnce(async (...args) => {
      expect(await realFinalize(...args)).toMatchObject({ ok: true, status: 'suppressed' });
      throw new Error('Synthetic exit after terminal write');
    });
    try {
      await expect(collectVisitCompletionInvoice(saved.body.packetId)).rejects.toThrow('Synthetic exit after terminal write');
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
        .toMatchObject({ status: 'suppressed', last_error: 'payment_failed' });
      for (let replay = 0; replay < 2; replay++) {
        expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_failed', invoiceId });
      }
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    } finally {
      finalizer.mockRestore();
    }
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each(['payment_needed', 'payment_failed'])('terminal %s can settle a later zero balance without reopening collection', async (reason) => {
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_terminal',
      is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    if (reason === 'payment_failed') {
      await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    }
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    chargeInvoiceWithSavedCard.mockImplementation(async () => {
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: invoiceId, payment_method_id: methodId,
        stripe_payment_method_id: 'pm_fixture_terminal', idempotency_key: fixture.key, status: 'failed',
        submitted_at: new Date(), resolved_at: new Date() });
      throw Object.assign(new Error('Synthetic provider decline'), { wavesCardDecline: true });
    });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: reason });
    const providerCalls = chargeInvoiceWithSavedCard.mock.calls.length;
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: reason });
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0 });
    const [sequence] = await mockPg('invoice_followup_sequences').insert({
      invoice_id: invoiceId, customer_id: fixture.customerId, status: 'active',
      touch_claimed_at: new Date(), next_touch_at: new Date(),
    }).returning('*');
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
      .toMatchObject({ status: 'suppressed', last_error: reason });
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 240 });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: reason });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(providerCalls);
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0 });
    await mockPg('invoice_followup_sequences').where({ id: sequence.id }).update({ touch_claimed_at: new Date(0) });
    const groups = require('../services/visit-groups');
    const finalizer = jest.spyOn(groups, 'finalizeVisitNotification').mockResolvedValueOnce({ ok: false });
    try {
      expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'payment_pending' });
      expect(await mockPg('invoices').where({ id: invoiceId }).first()).toMatchObject({ status: 'prepaid' });
      expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'prepaid' });
    } finally { finalizer.mockRestore(); }
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
      .toMatchObject({ status: 'sent', last_error: null });
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(providerCalls);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test.each(['member', 'stop', 'visit', 'packet'])('collection never waits on a %s while an editor waits on its invoice', async (heldLock) => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const collection = await mockPg.transaction();
    const editor = await mockPg.transaction();
    let editInvoice;
    try {
      const invoice = await collection('invoices').where({ id: invoiceId }).forUpdate().first();
      await collection('customers').where({ id: fixture.customerId }).forUpdate().first('id');
      if (heldLock === 'member') await editor('scheduled_services').where({ id: fixture.serviceIds[1] }).forUpdate().first();
      if (heldLock === 'stop') {
        const visit = await editor('service_visits').where({ id: fixture.visitId }).first();
        await require('../services/visit-groups').lockStop(editor, visit.stop_base_key);
      }
      if (heldLock === 'visit') await editor('service_visits').where({ id: fixture.visitId }).forUpdate().first();
      if (heldLock === 'packet') await editor('visit_completion_packets').where({ id: saved.body.packetId }).forUpdate().first();
      editInvoice = editor('invoices').where({ id: invoiceId }).forUpdate().first()
        .then(() => ({ locked: true }), (error) => ({ error }));
      await expect(assertVisitCompletionCharge(collection, invoice, saved.body.packetId))
        .rejects.toMatchObject({ code: heldLock === 'stop' ? 'visit_busy' : '55P03' });
      await collection.rollback();
      expect(await editInvoice).toEqual({ locked: true });
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    } finally {
      if (!collection.isCompleted()) await collection.rollback();
      if (!editor.isCompleted()) await editor.rollback();
      if (editInvoice) await editInvoice;
    }
  });

  test('a moved non-anchor member prevents collection until its saved stop is restored', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const invoice = await mockPg('invoices').where({ id: saved.body.billing.invoiceId }).first();
    const secondaryId = fixture.serviceIds.find((id) => id !== invoice.scheduled_service_id);
    const original = await mockPg('scheduled_services').where({ id: secondaryId }).first();
    const propertyId = randomUUID();
    await mockPg('customer_properties').insert({ id: propertyId, customer_id: fixture.customerId });
    const guarded = () => mockPg.transaction(async (trx) => {
      const locked = await trx('invoices').where({ id: invoice.id }).forUpdate().first();
      await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
      await assertVisitCompletionCharge(trx, locked, saved.body.packetId);
    });
    for (const changes of [{ technician_id: null }, { property_id: propertyId },
      { scheduled_date: '2099-12-31' }, { window_start: '15:00', window_end: '16:00' }]) {
      await mockPg('scheduled_services').where({ id: secondaryId }).update(changes);
      await expect(guarded()).rejects.toMatchObject({ code: 'VISIT_PAYMENT_REVIEW_REQUIRED', reason: 'member_stop_changed' });
      await mockPg('scheduled_services').where({ id: secondaryId })
        .update(Object.fromEntries(Object.keys(changes).map((key) => [key, original[key]])));
    }
    await expect(guarded()).resolves.toBeUndefined();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('positive collection waits for the existing reminder handoff', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await mockPg('invoice_followup_sequences').insert({ invoice_id: saved.body.billing.invoiceId,
      customer_id: fixture.customerId, status: 'active', touch_claimed_at: new Date() });
    const guarded = () => mockPg.transaction(async (trx) => {
      const invoice = await trx('invoices').where({ id: saved.body.billing.invoiceId }).forUpdate().first();
      await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
      await assertVisitCompletionCharge(trx, invoice, saved.body.packetId);
    });
    await expect(guarded()).rejects.toMatchObject({ code: 'VISIT_PAYMENT_FOLLOWUP_IN_FLIGHT' });
    await mockPg('invoice_followup_sequences').where({ invoice_id: saved.body.billing.invoiceId }).update({ touch_claimed_at: null });
    await expect(guarded()).resolves.toBeUndefined();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each(['void', 'canceled', 'cancelled', 'refunded'])('a %s packet invoice remains an office exception for every member', async (status) => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('invoices').where({ id: saved.body.billing.invoiceId }).update({ status });
    await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds).update({ status: 'succeeded' });
    for (const serviceId of fixture.serviceIds) {
      const facts = (await require('../services/closeout-status').getCloseoutStatus(serviceId, { knex: mockPg })).facts;
      expect(facts.invoice).toMatchObject({ state: 'pending', reason: 'parked_manual_reversed_packet_invoice',
        invoiceId: saved.body.billing.invoiceId, status });
      const issues = require('../services/closeout-alerts').__private.moneyCommsIssues(facts);
      expect(issues).toEqual(expect.arrayContaining([expect.objectContaining({
        reason: 'parked_manual_reversed_packet_invoice', summary: expect.stringContaining('review the existing invoice'),
      })]));
      expect(JSON.stringify(issues)).not.toContain('never minted');
    }
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required', invoiceId: saved.body.billing.invoiceId });
    expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' }).first())
      .toMatchObject({ status: 'suppressed' });
  });

  test.each(['charging', 'charge_review', 'released'])('a %s card hold is rechecked at collection', async (status) => {
    const saved = await saveVisitCompletionPacket(submission());
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const estimateId = randomUUID();
    fixture.estimateIds.push(estimateId);
    await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted' });
    await mockPg('estimate_card_holds').insert({ estimate_id: estimateId, customer_id: fixture.customerId,
      scheduled_service_id: fixture.serviceIds[1], status });
    const guarded = mockPg.transaction(async (trx) => {
      const invoice = await trx('invoices').where({ id: saved.body.billing.invoiceId }).forUpdate().first();
      await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
      await assertVisitCompletionCharge(trx, invoice, saved.body.packetId);
    });
    if (status === 'released') await expect(guarded).resolves.toBeUndefined();
    else await expect(guarded).rejects.toMatchObject({ code: 'VISIT_PAYMENT_REVIEW_REQUIRED', reason: 'competing_card_consent' });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each([true, false])('a lost decline finalizer uses durable submission evidence (%s)', async (submitted) => {
    const methodId = randomUUID();
    await mockPg('payment_methods').insert({ id: methodId, customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_visit',
      is_default: true, autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, autopay_payment_method_id: methodId });
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    const provider = jest.fn();
    chargeInvoiceWithSavedCard.mockImplementation(async (id, selectedMethod, options) => {
      await mockPg.transaction(async (trx) => {
        const invoice = await trx('invoices').where({ id }).forUpdate().first();
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await assertVisitCompletionCharge(trx, invoice, options.requireVisitCompletionPacketId);
      });
      provider();
      await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: id, payment_method_id: selectedMethod,
        stripe_payment_method_id: 'pm_fixture_visit', idempotency_key: randomUUID(), status: 'failed',
        submitted_at: submitted ? new Date() : null, resolved_at: new Date() });
      throw Object.assign(new Error('Synthetic collection refusal'), { wavesCardDecline: true });
    });
    const groups = require('../services/visit-groups');
    const finalizer = jest.spyOn(groups, 'finalizeVisitNotification').mockRejectedValueOnce(new Error('Synthetic finalizer outage'));
    try {
      await expect(collectVisitCompletionInvoice(saved.body.packetId)).rejects.toThrow('Synthetic finalizer outage');
      await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'visit_payment' })
        .update({ claimed_at: new Date(Date.now() - 11 * 60 * 1000) });
      expect(await collectVisitCompletionInvoice(saved.body.packetId))
        .toMatchObject({ state: submitted ? 'office_required' : 'payment_failed', invoiceId });
      expect(provider).toHaveBeenCalledTimes(submitted ? 1 : 2);
      expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ billing_hold: submitted });
      expect(await collectVisitCompletionInvoice(saved.body.packetId))
        .toMatchObject({ state: submitted ? 'office_required' : 'payment_failed' });
      expect(provider).toHaveBeenCalledTimes(submitted ? 1 : 2);
    } finally {
      finalizer.mockRestore();
    }
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a zero balance with an existing payment session stays for office reconciliation', async () => {
    const saved = await saveVisitCompletionPacket(submission());
    const invoiceId = saved.body.billing.invoiceId;
    await mockPg('invoices').where({ id: invoiceId }).update({ total: 0, stripe_payment_intent_id: 'pi_fixture_existing' });
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required', invoiceId });
    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({ state: 'office_required', invoiceId });
    expect((await mockPg('invoices').where({ id: invoiceId }).first()).status).toBe('draft');
    expect(await mockPg('audit_log').where({ resource_id: invoiceId, action: 'invoice.zero_balance_settled' })).toHaveLength(0);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each([false, true])('reviewed packet prices use one connection and preserve estimate lock order (stale=%p)', async (stale) => {
    const pricing = require('../services/completion-pricing');
    const estimateIds = [randomUUID(), randomUUID()];
    const input = submission();
    for (const [index, item] of input.items.entries()) {
      await mockPg('estimates').insert({ id: estimateIds[index], customer_id: fixture.customerId,
        status: 'accepted', address: '100 Synthetic Test Lane, Bradenton, FL 34201', estimate_data: {} });
      await mockPg('scheduled_services').where({ id: item.serviceId }).update({ source_estimate_id: estimateIds[index],
        service_address_line1: '100 Synthetic Test Lane', service_address_city: 'Bradenton', service_address_zip: '34201' });
      const plan = await pricing.loadCompletionPricing(item.serviceId, { database: mockPg, role: 'technician' });
      expect(plan.source.estimate.id).toBe(estimateIds[index]);
      item.body.pricingReview = { witness: plan.view.witness, applyDiscounts: false };
    }
    if (stale) input.items[1].body.pricingReview.witness = '0'.repeat(64);
    const { gates } = require('../config/feature-gates');
    const priorPricingGate = gates.completionServicePricing;
    gates.completionServicePricing = true;
    const shared = mockPg;
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 2000 });
    const queries = [];
    mockPg.on('query', (query) => queries.push(query));
    try {
      if (stale) {
        await expect(saveVisitCompletionPacket(input)).rejects.toMatchObject({ code: 'completion_pricing_changed' });
        expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
        expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      } else {
        expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202, body: { state: 'records_saved' } });
        const customerLock = queries.findIndex((query) => query.sql.includes('from "customers"') && query.sql.includes('for no key update'));
        const earlyEstimates = queries.slice(0, customerLock).filter((query) => query.sql.includes('from "estimates"') && query.sql.includes('for share'));
        expect(earlyEstimates.map((query) => query.bindings[0])).toEqual([...estimateIds].sort());
        expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202, body: { replayed: true } });
        expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      }
    } finally {
      gates.completionServicePricing = priorPricingGate;
      await mockPg.destroy();
      mockPg = shared;
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: null });
      await mockPg('estimates').whereIn('id', estimateIds).del();
    }
  });

  test('a rejected second form rolls back the first record, status and claim', async () => {
    const input = submission();
    const photoKey = `fixture/${fixture.serviceIds[0]}/before.png`;
    await mockPg('scheduled_service_photo_staging').insert({
      scheduled_service_id: fixture.serviceIds[0], technician_id: fixture.techId,
      photo_type: 'before', s3_key: photoKey, image_sha256: '0'.repeat(64),
    });
    input.items[1].body.clientPestRating = 99;
    const result = await saveVisitCompletionPacket(input);
    expect(result).toMatchObject({ status: 400, body: { code: 'client_pest_rating_invalid', serviceId: fixture.serviceIds[1] } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds)).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect(await mockPg('job_status_history').whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).status).toBe('open');
    expect((await mockPg('scheduled_services').whereIn('id', fixture.serviceIds)).every((row) => row.status === 'on_site')).toBe(true);
    expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(1);
    expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(0);
    expect((await saveVisitCompletionPacket(submission())).status).toBe(202);
    expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(0);
    expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(1);
  });

  test('concurrent double taps converge on one packet and one record per service', async () => {
    const results = await Promise.all([saveVisitCompletionPacket(submission()), saveVisitCompletionPacket(submission())]);
    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(new Set(results.map((result) => result.body.packetId)).size).toBe(1);
    expect(results.filter((result) => result.body.replayed)).toHaveLength(1);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    const invoices = await mockPg('invoices').where({ customer_id: fixture.customerId });
    expect(invoices).toHaveLength(1);
    expect(new Set(results.map((result) => result.body.billing.invoiceId))).toEqual(new Set([invoices[0].id]));
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: results[0].body.packetId }).pluck('invoice_id'))
      .toEqual([invoices[0].id, invoices[0].id]);
  });

  test('a retry cannot change saved outcomes or use a new key', async () => {
    const first = await saveVisitCompletionPacket(submission());
    expect(first.status).toBe(202);
    const changed = submission();
    changed.items[1].body.visitOutcome = 'incomplete';
    expect(await saveVisitCompletionPacket(changed)).toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
    expect(await saveVisitCompletionPacket(submission({ idempotencyKey: randomUUID() })))
      .toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
  });

  test('an individual endpoint cannot claim a saved member for billing and delivery', async () => {
    expect((await saveVisitCompletionPacket(submission())).status).toBe(202);
    const input = submission();
    const result = await completeScheduledService({ serviceId: fixture.serviceIds[0], body: input.items[0].body,
      actor: input.actor, idempotencyKey: randomUUID() });
    expect(result).toMatchObject({ status: 409, body: { code: 'visit_grouped' } });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an incomplete member keeps its own outcome beside a completed service', async () => {
    const input = submission();
    for (const item of input.items) item.body.products = [{
      productId: fixture.productId, totalAmount: 2, amountUnit: 'oz',
      applicationMethod: 'bait_placement', areaValue: 1000, areaUnit: 'sqft',
    }];
    input.items[1].body.visitOutcome = 'incomplete';
    input.items[1].body.incompleteReason = 'Postponed at customer request';
    expect((await saveVisitCompletionPacket(input)).status).toBe(202);
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId }).orderBy('scheduled_service_id');
    expect(records.map((record) => record.status)).toEqual(['completed', 'incomplete']);
    expect(records[1].structured_notes).toMatchObject({ visitOutcome: 'incomplete' });
    const invoice = await mockPg('invoices').where({ customer_id: fixture.customerId }).first();
    expect(Number(invoice.total)).toBe(120);
    expect(invoice.line_items.filter((line) => line.amount > 0)).toHaveLength(1);
    expect(await mockPg('service_products').whereIn('service_record_id', records.map((record) => record.id))).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(6);
    expect(await mockPg('product_inventory_movements').where({ product_id: fixture.productId })).toHaveLength(2);
    expect((await saveVisitCompletionPacket(input)).body.replayed).toBe(true);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(6);
  });

  test('a late product validator rolls back earlier inventory deductions too', async () => {
    const input = submission();
    input.items[0].body.products = [{ productId: fixture.productId, totalAmount: 2, amountUnit: 'oz',
      applicationMethod: 'bait_placement', areaValue: 1000, areaUnit: 'sqft' }];
    input.items[1].body.products = [{ productId: fixture.productId, totalAmount: 2, amountUnit: 'invalid_fixture_unit' }];
    await expect(saveVisitCompletionPacket(input)).rejects.toMatchObject({ isOperational: true, statusCode: 400 });
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(10);
    expect(await mockPg('product_inventory_movements').where({ product_id: fixture.productId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('a missing form or another technician cannot freeze the visit', async () => {
    expect(await saveVisitCompletionPacket(submission({ actor: { techRole: 'technician', technicianId: randomUUID() } })))
      .toMatchObject({ status: 403 });
    const input = submission();
    input.items[1].serviceId = randomUUID();
    expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 409, body: { code: 'visit_members_changed' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('one invoice preserves each stored service discount and its member identity', async () => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ estimated_price: 90, primary_line_price: 100 });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ estimated_price: 150, primary_line_price: 175 });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'invoice_ready', total: 240 });
    const invoice = await mockPg('invoices').where({ id: result.body.billing.invoiceId }).first();
    expect(Number(invoice.subtotal)).toBe(275);
    expect(Number(invoice.discount_amount)).toBe(35);
    expect(Number(invoice.tax_amount)).toBe(0);
    expect(invoice.line_items.filter((line) => line.amount > 0).map((line) => line.client_id))
      .toEqual(fixture.serviceIds.map((id) => `scheduled_${id}_primary`));
    expect(invoice.visit_completion_packet_id).toBe(result.body.packetId);
    expect(dateOnly(invoice.due_date)).toBe(etDateString());
    expect((await createVisitCompletionInvoice(result.body.packetId)).invoiceId).toBe(invoice.id);
  });

  test.each([0, 102])('a reviewed application discount reaches the shared invoice with a %s fixed adjustment', async (adjustment) => {
    const estimateId = randomUUID();
    fixture.estimateIds.push(estimateId);
    const key = `fixture_${fixture.catalogId}`;
    await mockPg('customers').where({ id: fixture.customerId }).update({ per_application_fee: 120 });
    await mockPg('services').where({ id: fixture.catalogId }).update({ frequency: 'quarterly', billing_type: 'recurring', visits_per_year: 4 });
    await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted',
      address: '100 Synthetic Test Lane, Bradenton, FL 34201', estimate_data: { result: { recurring: { services: [{
        service: 'pest_control', serviceKey: key, name: 'Fixture General Pest Control', perTreatment: 120,
        priceAfterDiscount: 102, visitsPerYear: 4, frequency: 'quarterly', discount: { effectiveDiscount: 0.15 },
      }] } } } });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: estimateId,
      service_address_line1: '100 Synthetic Test Lane', service_address_city: 'Bradenton', service_address_zip: '34201' });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({
      is_recurring: true, recurring_pattern: 'quarterly', primary_line_price: 120, estimated_price: 120 - adjustment,
    });
    if (adjustment) {
      fixture.discountId = randomUUID();
      await mockPg('discounts').insert({ id: fixture.discountId, discount_key: `fixture_${fixture.discountId}`,
        name: 'Synthetic fixed adjustment', discount_type: 'fixed_amount', amount: adjustment, is_stackable: true });
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ discount_id: fixture.discountId,
        discount_name: 'Synthetic fixed adjustment', discount_type: 'fixed_amount', discount_amount: adjustment, discount_dollars: adjustment });
    }
    const { gates } = require('../config/feature-gates');
    const prior = [gates.completionServicePricing, gates.editApptPriceServiceScope];
    gates.completionServicePricing = true;
    gates.editApptPriceServiceScope = true;
    try {
      const plan = await require('../services/completion-pricing').loadCompletionPricing(fixture.serviceIds[0], { database: mockPg, role: 'admin' });
      expect(plan.view).toMatchObject({ canApply: true, proposedAmount: 102 - adjustment });
      const input = submission({ actor: { techRole: 'admin', technicianId: fixture.techId } });
      input.items[0].body.pricingReview = { witness: plan.view.witness, applyDiscounts: true };
      const result = await saveVisitCompletionPacket(input);
      expect(result.body.billing).toMatchObject({ state: 'invoice_ready', total: 222 - adjustment });
      const record = await mockPg('service_records').where({ scheduled_service_id: fixture.serviceIds[0] }).first();
      expect(record.structured_notes.completionPricing.amountCents).toBe((102 - adjustment) * 100);
      expect((await saveVisitCompletionPacket(input)).body.billing.invoiceId).toBe(result.body.billing.invoiceId);
      expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    } finally {
      [gates.completionServicePricing, gates.editApptPriceServiceScope] = prior;
    }
  });

  test.each(['per_application', 'per_visit', 'one_time'])('an unflagged callback stays free in the %s lane', async (billingMode) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: billingMode });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ is_callback: true });
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved.body.billing).toMatchObject({ state: 'invoice_ready', total: 120 });
    expect(await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).whereNotNull('invoice_id'))
      .toEqual([expect.objectContaining({ scheduled_service_id: fixture.serviceIds[0] })]);
  });

  test('the explicit invoice-on-complete callback override keeps its canonical charge', async () => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({
      is_callback: true, create_invoice_on_complete: true,
    });
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved.body.billing).toMatchObject({ state: 'invoice_ready', total: 240 });
  });

  test.each([
    ['draft', 'completed'], ['void', 'completed'], ['refunded', 'completed'],
    ['paid', 'inspection_only'], ['paid', 'customer_declined'],
  ])('billing recovery recognizes the %s shared invoice for a %s member', async (status, outcome) => {
    const input = submission();
    input.items[1].body.visitOutcome = outcome;
    const saved = await saveVisitCompletionPacket(input);
    await mockPg('invoices').where({ id: saved.body.billing.invoiceId }).update({ status });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ completed_at: mockPg.fn.now() });
    const router = require('../routes/admin-billing-recovery');
    const handler = router.stack.find((layer) => layer.route?.path === '/leaks').route.stack.at(-1).handle;
    const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    await handler({ query: { days: 1 } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain(fixture.customerId);
    // Positive control: without the packet's secondary-member link, this
    // exact completed work really would enter the existing recovery queue.
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId,
      scheduled_service_id: fixture.serviceIds[1] }).update({ service_record_id: null });
    res.json.mockClear();
    await handler({ query: { days: 1 } }, res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].needs_review)
      .toEqual(expect.arrayContaining([expect.objectContaining({ scheduled_service_id: fixture.serviceIds[1] })]));
  });
  test.each(['pest', 'lawn'])('concurrent submissions need only their transaction connection for %s helpers', async (lane) => {
    if (lane === 'lawn') {
      await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ service_type: 'WaveGuard Lawn Care' });
    }
    await mockPg('customers').where({ id: fixture.customerId }).update({
      property_type: 'commercial', autopay_enabled: true,
    });
    const normalPool = mockPg;
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 30000 });
    const flags = require('../services/feature-flags').isUserFeatureEnabled;
    const context = require('../services/recap-visit-context').buildRecapVisitContext;
    flags.mockImplementation(jest.requireActual('../services/feature-flags').isUserFeatureEnabled);
    context.mockImplementation(jest.requireActual('../services/recap-visit-context').buildRecapVisitContext);
    const recap = jest.spyOn(require('../services/completion-recap'), 'generateRecap')
      .mockResolvedValue({ recap: 'The service record is ready.', source: 'fixture' });
    try {
      const input = submission();
      for (const item of input.items) delete item.body.customerRecap;
      const results = await Promise.allSettled([saveVisitCompletionPacket(input), saveVisitCompletionPacket(input)]);
      expect(results).toEqual([
        expect.objectContaining({ status: 'fulfilled', value: expect.objectContaining({ status: 202 }) }),
        expect.objectContaining({ status: 'fulfilled', value: expect.objectContaining({ status: 202 }) }),
      ]);
      expect(new Set(results.map((result) => result.value.body.packetId)).size).toBe(1);
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      expect(context).toHaveBeenCalled();
    } finally {
      recap.mockRestore();
      flags.mockImplementation(async () => false);
      context.mockImplementation(async () => '');
      await mockPg.destroy();
      mockPg = normalPool;
    }
  });

  test('grouped completion and lawn baseline confirmation keep the same lock order', async () => {
    const originalGate = process.env.GATE_LAWN_PROPERTY_HISTORY;
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    const baseline = await mockPg.transaction();
    const { lockCustomerBaseline } = require('../services/lawn-assessment');
    let pending;
    let observe;
    try {
      await lockCustomerBaseline(fixture.customerId, baseline);
      let reachedBaseline;
      const waiting = new Promise((resolve) => { reachedBaseline = resolve; });
      observe = (query) => {
        if (query.bindings?.includes('lawn-baseline')) reachedBaseline();
      };
      mockPg.on('query', observe);
      pending = saveVisitCompletionPacket(submission()).then(
        (value) => ({ value }), (error) => ({ error }),
      );
      await Promise.race([waiting, pending.then((result) => {
        throw result.error || new Error('Completion returned before acquiring the baseline lock');
      })]);
      // Confirmation holds the baseline fence before it locks the customer.
      // A packet waiting for that fence must not already own the customer row.
      await baseline.raw("SET LOCAL lock_timeout = '2s'");
      await baseline('customers').where({ id: fixture.customerId }).forNoKeyUpdate().first('id');
      await baseline.commit();
      const result = await pending;
      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject({ status: 202, body: { state: 'records_saved' } });
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    } finally {
      if (observe) mockPg.removeListener('query', observe);
      if (!baseline.isCompleted()) await baseline.rollback();
      if (pending) await pending;
      if (originalGate === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY;
      else process.env.GATE_LAWN_PROPERTY_HISTORY = originalGate;
    }
  });

  test('commercial tax and an estimate deposit settle once on the same invoice', async () => {
    const estimateId = randomUUID();
    fixture.estimateIds.push(estimateId);
    await mockPg('customers').where({ id: fixture.customerId }).update({ property_type: 'business', zip: '34209' });
    await mockPg('estimates').insert({ id: estimateId, customer_id: fixture.customerId, status: 'accepted' });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: estimateId });
    await mockPg('estimate_deposits').insert({ estimate_id: estimateId, customer_id: fixture.customerId,
      amount: 70, status: 'received', stripe_payment_intent_id: `pi_fixture_${randomUUID()}` });
    const result = await saveVisitCompletionPacket(submission());
    const invoice = await mockPg('invoices').where({ id: result.body.billing.invoiceId }).first();
    expect(Number(invoice.subtotal)).toBe(240);
    const tax = await require('../services/tax-calculator').calculateTax(fixture.customerId, 'Fixture General Pest Control', 240);
    expect(Number(invoice.tax_amount)).toBe(tax.amount);
    expect(Number(invoice.total)).toBe(Math.round((240 + tax.amount - 70) * 100) / 100);
    const deposit = await mockPg('estimate_deposits').where({ estimate_id: estimateId }).first();
    expect(Number(deposit.credited_amount)).toBe(70);
    expect(deposit.credited_invoice_id).toBe(invoice.id);
    expect(invoice.line_items.find((line) => line.category === 'deposit_credit')).toMatchObject({ amount: -70, estimate_id: estimateId });
    expect((await saveVisitCompletionPacket(submission())).body.billing.invoiceId).toBe(invoice.id);
    expect(Number((await mockPg('estimate_deposits').where({ estimate_id: estimateId }).first()).credited_amount)).toBe(70);
  });

  test('individual scheduled, record-linked and recovery mints refuse packet-owned members', async () => {
    const result = await saveVisitCompletionPacket(submission());
    for (const item of result.body.items) {
      const common = { customerId: fixture.customerId, lineItems: [{ description: 'Fixture service', quantity: 1, unit_price: 120 }] };
      await expect(InvoiceService.create({ ...common, scheduledServiceId: item.serviceId }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
      await expect(InvoiceService.create({ ...common, serviceRecordId: item.serviceRecordId }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
      const svc = await mockPg('scheduled_services').where({ id: item.serviceId }).first();
      await expect(mintScheduledServiceInvoiceWithDeposit({ svc, buildCreateParams: () => ({ ...common, scheduledServiceId: svc.id }) }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
      await expect(InvoiceService.createFromService(item.serviceRecordId, { amount: 120, useScheduledReplay: true }))
        .rejects.toMatchObject({ code: 'VISIT_PACKET_OWNS_BILLING', status: 409 });
    }
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('adopts the exact acceptance invoice without repricing its setup fee, discount or deposit', async () => {
    const { invoice: created, deposit, pestId } = await prepareAcceptanceInvoice({ withAdjustments: true });
    const before = await mockPg('invoices').where({ id: created.id }).first();

    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'invoice_ready', invoiceId: created.id, total: 271 });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    const after = await mockPg('invoices').where({ id: created.id }).first();
    expect(after).toMatchObject({ scheduled_service_id: pestId,
      visit_completion_packet_id: result.body.packetId,
      service_record_id: result.body.items.find((item) => item.serviceId === pestId).serviceRecordId,
      status: 'draft', subtotal: '339.00', discount_amount: '18.00', total: '271.00' });
    // Financial content was frozen at acceptance. Adoption changes only the
    // packet and service-record ownership links.
    expect(after.line_items).toEqual(before.line_items);
    expect(after.line_items).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'WaveGuard Membership — one-time setup fee', amount: 99 }),
      expect.objectContaining({ client_id: `scheduled_${fixture.serviceIds[0]}_primary`, amount: 120,
        accepted_service_type: 'Quarterly Pest Control', accepted_service_id: fixture.catalogId }),
      expect.objectContaining({ client_id: `scheduled_${fixture.serviceIds[1]}_primary`, amount: 120,
        accepted_service_type: 'Lawn Care', accepted_service_id: fixture.catalogId }),
      expect.objectContaining({ description: 'Accepted plan credit', amount: -18 }),
      expect.objectContaining({ category: 'deposit_credit', amount: -50 }),
    ]));
    expect(await mockPg('estimate_deposits').where({ id: deposit.id }).first()).toEqual(deposit);
    expect((await mockPg('visit_completion_packets').where({ id: result.body.packetId }).first()).payload.billingSnapshot)
      .toMatchObject({ invoiceId: created.id, totalCents: 27100, netSubtotalCents: 32100,
        billedServiceIds: expect.arrayContaining(fixture.serviceIds) });
  });

  test.each([
    ['historical aggregate', 'aggregate'],
    ['partial member coverage', 'partial'],
    ['foreign accepted-service identity', 'foreign'],
  ])('rejects an acceptance invoice with %s', async (_label, coverage) => {
    const { invoice } = await prepareAcceptanceInvoice({ coverage });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ id: invoice.id }).first()).toMatchObject({
      visit_completion_packet_id: null, service_record_id: null, status: 'draft',
    });
  });

  test('rejects a paid acceptance invoice', async () => {
    const { invoice } = await prepareAcceptanceInvoice({ status: 'paid' });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ id: invoice.id }).first()).toMatchObject({
      visit_completion_packet_id: null, service_record_id: null, status: 'paid',
    });
  });

  test('rejects adoption after an in-place service conversion changes the accepted identity', async () => {
    const { invoice, lawnId } = await prepareAcceptanceInvoice();
    await mockPg('scheduled_services').where({ id: lawnId }).update({ service_type: 'Mosquito Control' });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ id: invoice.id }).first()).toMatchObject({
      visit_completion_packet_id: null, service_record_id: null,
    });
  });

  test('rejects an acceptance invoice with any prior charge attempt', async () => {
    const { invoice } = await prepareAcceptanceInvoice();
    await mockPg('stripe_invoice_charge_attempts').insert({ invoice_id: invoice.id,
      stripe_payment_method_id: 'pm_fixture_acceptance_attempt', idempotency_key: fixture.key,
      status: 'claimed', submitted_at: new Date() });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ id: invoice.id }).first()).toMatchObject({
      visit_completion_packet_id: null, service_record_id: null,
    });
  });

  test('rejects acceptance adoption when an extra member invoice exists', async () => {
    const { invoice, lawnId } = await prepareAcceptanceInvoice();
    await InvoiceService.create({ database: mockPg, customerId: fixture.customerId,
      scheduledServiceId: lawnId, title: 'Existing lawn invoice',
      lineItems: [{ description: 'Lawn Care', quantity: 1, unit_price: 100 }], dueDate: etDateString() });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(await mockPg('invoices').where({ id: invoice.id }).first()).toMatchObject({
      visit_completion_packet_id: null, service_record_id: null,
    });
  });

  test('the adopted invoice charge fence rejects a service conversion after the packet snapshot', async () => {
    const { invoice, lawnId } = await prepareAcceptanceInvoice();
    const [method] = await mockPg('payment_methods').insert({ customer_id: fixture.customerId,
      processor: 'stripe', method_type: 'card', stripe_payment_method_id: 'pm_fixture_acceptance_fence',
      is_default: true, autopay_enabled: true, exp_month: 12,
      exp_year: new Date().getUTCFullYear() + 1 }).returning('*');
    await mockPg('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true,
      autopay_payment_method_id: method.id });
    const saved = await saveVisitCompletionPacket(submission());
    expect(saved.body.billing).toMatchObject({ state: 'invoice_ready', invoiceId: invoice.id });
    await mockPg('visit_completion_packet_items').where({ packet_id: saved.body.packetId }).update({ status: 'done' });
    await mockPg('scheduled_services').where({ id: lawnId }).update({ service_type: 'Mosquito Control' });
    let providerSubmissions = 0;
    chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId, selectedMethod, options) => {
      expect(selectedMethod).toBe(method.id);
      await mockPg.transaction(async (trx) => {
        const locked = await trx('invoices').where({ id: invoiceId }).forUpdate().first();
        await trx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
        await assertVisitCompletionCharge(trx, locked, options.requireVisitCompletionPacketId);
        providerSubmissions += 1;
      });
    });

    expect(await collectVisitCompletionInvoice(saved.body.packetId)).toMatchObject({
      state: 'office_required', invoiceId: invoice.id,
    });
    expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
    expect(providerSubmissions).toBe(0);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).billing_hold).toBe(true);
  });

  test.each(['paid', 'refunded', 'draft', 'void'])('a member with a %s invoice parks billing without creating another invoice', async (status) => {
    const prior = await InvoiceService.create({ customerId: fixture.customerId, scheduledServiceId: fixture.serviceIds[0],
      lineItems: [{ description: 'Fixture service', quantity: 1, unit_price: 120 }] });
    await mockPg('invoices').where({ id: prior.id }).update({ status });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).billing_hold).toBe(true);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test.each(['annual_prepay', 'monthly_membership'])('the %s lane keeps its existing financial contract', async (billingMode) => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: billingMode });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'covered_billing_lane' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('a missing member price cannot inherit a whole-plan per-application fee', async () => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ billing_mode: 'per_application', per_application_fee: 240 });
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[1] }).update({ estimated_price: null });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'member_price_missing' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('no performed applications means no invoice, including on replay', async () => {
    const input = submission();
    for (const item of input.items) item.body.visitOutcome = 'inspection_only';
    expect((await saveVisitCompletionPacket(input)).body.billing).toEqual({ state: 'no_charge', invoiceId: null });
    expect((await saveVisitCompletionPacket(input)).body.billing).toEqual({ state: 'no_charge', invoiceId: null });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('a granted retention offer consumes one charge for its family across the group', async () => {
    await mockPg('services').where({ id: fixture.catalogId }).update({ engine_keys: JSON.stringify(['pest_control']) });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ is_recurring: true });
    const [offer] = await mockPg('retention_offers').insert({ customer_id: fixture.customerId,
      family_key: 'pest_control', percent_off: 15, max_charges: 2, cap_amount: 75, status: 'granted' }).returning('*');
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'invoice_ready', total: 204 });
    const saved = await mockPg('retention_offers').where({ id: offer.id }).first();
    expect(saved.charges_applied).toBe(1);
    expect(Number(saved.amount_applied)).toBe(36);
    expect(saved.applied_invoice_ids).toEqual([result.body.billing.invoiceId]);
    await saveVisitCompletionPacket(submission());
    expect((await mockPg('retention_offers').where({ id: offer.id }).first()).charges_applied).toBe(1);
  });

  test('a failure after invoice insertion rolls back the invoice and every service record', async () => {
    const create = InvoiceService.create;
    const fault = jest.spyOn(InvoiceService, 'create').mockImplementation(async (...args) => {
      await create.apply(InvoiceService, args);
      throw new Error('Injected failure after durable invoice insert');
    });
    try {
      await expect(saveVisitCompletionPacket(submission())).rejects.toThrow('Injected failure');
    } finally { fault.mockRestore(); }
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).status).toBe('open');
    expect((await saveVisitCompletionPacket(submission())).body.billing.state).toBe('invoice_ready');
  });

  test('reversing the shared invoice parks replay and cannot mint a replacement', async () => {
    const result = await saveVisitCompletionPacket(submission());
    await mockPg('invoices').where({ id: result.body.billing.invoiceId }).update({ status: 'refunded' });
    expect((await saveVisitCompletionPacket(submission())).body.billing).toMatchObject({
      state: 'office_required', reason: 'shared_invoice_reversed', invoiceId: result.body.billing.invoiceId,
    });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
  });

  test('a per-job payer and a prepaid member keep homeowner billing held', async () => {
    const [payer] = await mockPg('payers').insert({ display_name: 'Fixture Bill-To', ap_email: 'fixture@example.invalid' }).returning('id');
    fixture.payerId = payer.id;
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ payer_id: payer.id });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'payer_billed_member' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('a partial prepaid stamp cannot be charged again through the group', async () => {
    await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ prepaid_amount: 70, prepaid_method: 'cash' });
    const result = await saveVisitCompletionPacket(submission());
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'prepaid_member' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('a concurrent legacy mint that wins the shared lock is seen before group billing', async () => {
    const trx = await mockPg.transaction();
    let closeout;
    try {
      await acquireScheduledInvoiceMintLock(trx, fixture.serviceIds[0]);
      closeout = saveVisitCompletionPacket(submission());
      // The invoice writer owns the same lock the closeout is waiting for.
      await InvoiceService.create({ database: trx, customerId: fixture.customerId,
        scheduledServiceId: fixture.serviceIds[0], lineItems: [{ description: 'Fixture service', quantity: 1, unit_price: 120 }] });
      await trx.commit();
    } catch (error) { await trx.rollback(); throw error; }
    const result = await closeout;
    expect(result.body.billing).toMatchObject({ state: 'office_required', reason: 'existing_member_invoice' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
  });

  test('the database refuses a second invoice for the same packet', async () => {
    const result = await saveVisitCompletionPacket(submission());
    await expect(mockPg.transaction((trx) => InvoiceService.create({
      database: trx, customerId: fixture.customerId, scheduledServiceId: fixture.serviceIds[0],
      lineItems: [{ description: 'Fixture duplicate', quantity: 1, unit_price: 120 }],
    }, { packetId: result.body.packetId }))).rejects.toMatchObject({ code: '23505', constraint: 'invoices_visit_packet_owner_unique' });
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
  });
  test('a second lawn member sees the first member’s uncommitted nitrogen and inventory use', async () => {
    await mockPg('customers').where({ id: fixture.customerId }).update({ waveguard_tier: 'Bronze' });
    await mockPg('services').where({ id: fixture.catalogId }).update({ name: 'Fixture Lawn Care' });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'WaveGuard Lawn Care' });
    await mockPg('customer_turf_profiles').insert({ customer_id: fixture.customerId,
      grass_type: 'st_augustine', lawn_sqft: 1000, annual_n_budget_target: 0.15, active: true });
    await mockPg('products_catalog').where({ id: fixture.productId }).update({
      analysis_n: 10, category: 'fertilizer', inventory_unit: 'lb', inventory_on_hand: 1.5,
    });
    const input = submission();
    for (const item of input.items) item.body.products = [{ productId: fixture.productId,
      totalAmount: 1, amountUnit: 'lb', applicationMethod: 'broadcast', areaValue: 1000, areaUnit: 'sqft' }];
    const result = await saveVisitCompletionPacket(input);
    expect(result).toMatchObject({ status: 202, body: { state: 'records_saved' } });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId }).orderBy('scheduled_service_id');
    expect(records[1].structured_notes.waveguardNLimitApproval).toMatchObject({
      advisory: true, annualN: { used: 0.1 },
      blocks: expect.arrayContaining([expect.objectContaining({ code: 'actual_annual_n_budget_exceeded' })]),
    });
    expect(await mockPg('property_nutrient_ledger').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(-0.5);
    expect((await saveVisitCompletionPacket(input)).body.replayed).toBe(true);
    expect(await mockPg('property_nutrient_ledger').where({ customer_id: fixture.customerId })).toHaveLength(2);
  });

  test.each([1, 2])('automatic grouping ignores an open version-%s visit after the closeout gate changes', async (previousVersion) => {
    const groups = require('../services/visit-groups');
    jest.replaceProperty(require('../config/feature-gates').gates, 'visitGroups', true);
    process.env.GATE_VISIT_CLOSEOUT = previousVersion === 1 ? 'true' : 'false';
    const propertyId = randomUUID();
    await mockPg('customer_properties').insert({ id: propertyId, customer_id: fixture.customerId });
    await mockPg('services').where({ id: fixture.catalogId }).update({ groupable: true, group_family: 'recurring_property_service' });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ property_id: propertyId, status: 'confirmed' });
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ property_id: propertyId,
      behavior_version: previousVersion, group_family: 'recurring_property_service',
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, propertyId, scheduledDate: etDateString() }) });
    const unattached = [randomUUID(), randomUUID()];
    await mockPg('scheduled_services').insert(unattached.map((id) => ({ id, customer_id: fixture.customerId,
      property_id: propertyId, technician_id: fixture.techId, service_id: fixture.catalogId,
      service_type: 'Fixture General Pest Control', scheduled_date: etDateString(),
      window_start: '09:00', window_end: '11:00', status: 'confirmed' })));

    const grouped = await groups.maybeGroupRow(unattached[0], { createdBy: 'test' });
    expect(grouped).toMatchObject({ behavior_version: previousVersion === 1 ? 2 : 1 });
    expect(grouped.id).not.toBe(fixture.visitId);
    expect(await mockPg('scheduled_services').where({ visit_id: grouped.id }).pluck('id')).toEqual(expect.arrayContaining(unattached));
    expect(await mockPg('scheduled_services').where({ visit_id: fixture.visitId }).pluck('id')).toEqual(expect.arrayContaining(fixture.serviceIds));
  });

  test('joining under the closeout gate cannot rewrite an existing legacy visit contract', async () => {
    await mockPg('services').where({ id: fixture.catalogId }).update({ groupable: true, group_family: 'recurring_property_service' });
    await expect(require('../services/visit-groups').createOrJoinVisit({ rows: fixture.serviceIds, createdBy: 'test' }))
      .rejects.toThrow('closeout behavior differs');
    expect(await mockPg('service_visits').where({ id: fixture.visitId }).first()).toMatchObject({ behavior_version: 1, status: 'open' });
    expect(await mockPg('scheduled_services').where({ visit_id: fixture.visitId })).toHaveLength(2);
  });

  test('a transient email dispatch-claim failure retries the same email instead of suppressing it', async () => {
    const groups = require('../services/visit-groups');
    const begin = groups.beginVisitNotificationDispatch;
    let fail = true;
    const dispatch = jest.spyOn(groups, 'beginVisitNotificationDispatch').mockImplementation(async (...args) => {
      if (args[1] === 'completion_email' && fail) { fail = false; throw new Error('Synthetic database interruption'); }
      return begin(...args);
    });
    try {
      const saved = await saveVisitCompletionPacket(submission());
      expect(await runVisitCompletionPacketEffects(saved.body.packetId)).toMatchObject({ status: 202, body: { state: 'effects_pending' } });
      expect(await mockPg('visit_effects').where({ visit_id: fixture.visitId, effect_type: 'completion_email' }).first())
        .toMatchObject({ status: 'failed' });
      expect(await runVisitCompletionPacketEffects(saved.body.packetId)).toMatchObject({ status: 200, body: { state: 'done' } });
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      const email = require('../services/email-template-library').sendTemplate;
      expect(email).toHaveBeenCalledTimes(2);
      expect(email.mock.calls[1][0].idempotencyKey).toBe(email.mock.calls[0][0].idempotencyKey);
    } finally { dispatch.mockRestore(); }
  });

  test('a caller-owned transaction is rejected before any packet query or upload', async () => {
    const outer = await mockPg.transaction();
    const query = jest.fn();
    outer.on('query', query);
    const send = jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    const input = submission();
    input.items[0].body.completionPhotos = [{ data: 'data:image/png;base64,Zml4dHVyZQ==', name: 'fixture.png' }];
    try {
      await expect(saveVisitCompletionPacket(input, outer))
        .rejects.toThrow('Visit completion requires a root database connection');
      expect(query).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
      await outer.rollback();
    }
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test.each(['cancelled', 'skipped', 'completed', 'no_show'])
  ('a frozen visit retains its %s history while its last active service records and replays', async (status) => {
    const retainedId = fixture.serviceIds[0];
    await mockPg('service_visits').where({ id: fixture.visitId }).update({ summary_token_issued_at: mockPg.fn.now() });
    await mockPg('scheduled_services').where({ id: retainedId }).update({ status });
    const priorRecords = status === 'completed' ? await mockPg('service_records').insert({
      customer_id: fixture.customerId, technician_id: fixture.techId, scheduled_service_id: retainedId,
      service_date: etDateString(), service_type: 'Fixture General Pest Control', status: 'completed',
    }).returning('*') : [];
    expect(await require('../services/visit-groups').handleChildTerminal(retainedId)).toBe(false);
    const input = submission();
    input.items = input.items.filter((item) => item.serviceId !== retainedId);
    const first = await saveVisitCompletionPacket(input);
    expect(first).toMatchObject({ status: 202, body: { state: 'records_saved', replayed: false } });
    expect(first.body.items).toHaveLength(1);
    expect(first.body.billing).toMatchObject({ state: 'invoice_ready', total: 120 });
    const invoice = await mockPg('invoices').where({ id: first.body.billing.invoiceId }).first();
    expect(invoice.scheduled_service_id).toBe(input.items[0].serviceId);
    expect(invoice.line_items.filter((line) => line.amount > 0)).toHaveLength(1);
    expect(await mockPg('scheduled_services').where({ id: retainedId }).first('status', 'visit_id'))
      .toEqual({ status, visit_id: fixture.visitId });
    const packet = await mockPg('visit_completion_packets').where({ id: first.body.packetId }).first();
    expect(packet.payload.retainedMembers).toEqual([{ serviceId: retainedId, status }]);
    expect(await mockPg('service_completion_attempts').where({ service_id: retainedId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ scheduled_service_id: retainedId })).toEqual(priorRecords);
    expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202, body: { replayed: true, items: first.body.items } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(1 + priorRecords.length);
    await mockPg('visit_completion_packet_items').where({ packet_id: first.body.packetId }).update({ status: 'done' });
    // A later full discount settles only the newly billed service; retained
    // terminal history does not require another completion record or charge.
    await mockPg('invoices').where({ id: invoice.id }).update({ discount_amount: 120, total: 0 });
    expect(await collectVisitCompletionInvoice(first.body.packetId)).toMatchObject({ state: 'prepaid', invoiceId: invoice.id });
    expect(await mockPg('invoices').where({ id: invoice.id }).first()).toMatchObject({ status: 'prepaid' });
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('allowing one active form never permits omitting another active member', async () => {
    const input = submission();
    input.items.pop();
    expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 409, body: { code: 'visit_members_changed' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('the unique key constraint refuses a key already owned by a different visit', async () => {
    const otherVisitId = randomUUID();
    await mockPg('service_visits').insert({ id: otherVisitId, customer_id: fixture.customerId,
      technician_id: fixture.techId, scheduled_date: '2000-01-01', window_start: '09:00', window_end: '10:00',
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: '2000-01-01' }), created_by: 'test' });
    await mockPg('visit_completion_packets').insert({ visit_id: otherVisitId, idempotency_key: fixture.key,
      request_hash: '0'.repeat(64), payload: JSON.stringify({ items: [] }), status: 'failed' });
    expect(await saveVisitCompletionPacket(submission())).toMatchObject({ status: 409, body: { code: 'visit_closeout_key_reused' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('packets saved before retained-member snapshots still replay completed records', async () => {
    const input = submission();
    const first = await saveVisitCompletionPacket(input);
    const packet = await mockPg('visit_completion_packets').where({ id: first.body.packetId }).first();
    delete packet.payload.retainedMembers;
    await mockPg('visit_completion_packets').where({ id: packet.id }).update({ payload: JSON.stringify(packet.payload) });
    expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202, body: { replayed: true, items: first.body.items } });
  });

  test.each(['completionPhotos', 'gaugePhoto'])('%s bytes are uploaded once and hashed without remaining in the packet snapshot', async (field) => {
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    const send = jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    const input = submission();
    const data = `data:image/png;base64,${Buffer.from('synthetic photo bytes').toString('base64')}`;
    const photo = { data, name: 'fixture.png', caption: 'Work area' };
    const metadata = { name: 'fixture.png', caption: 'Work area' };
    const flags = require('../services/feature-flags').isUserFeatureEnabled;
    if (field === 'gaugePhoto') {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'WaveGuard Lawn Care' });
      flags.mockImplementation(async (_id, flag) => flag === 'turf-height-capture');
    }
    for (const item of input.items) item.body[field] = field === 'completionPhotos' ? [{ ...photo }] : { ...photo };
    try {
      const first = await saveVisitCompletionPacket(input);
      expect(first.status).toBe(202);
      const packet = await mockPg('visit_completion_packets').where({ id: first.body.packetId }).first();
      for (const item of packet.payload.items) {
        expect(item.body[field]).toEqual(field === 'completionPhotos' ? [metadata] : metadata);
      }
      expect(JSON.stringify(packet.payload)).not.toContain(data);
      const submittedPhoto = field === 'completionPhotos' ? input.items[0].body[field][0] : input.items[0].body[field];
      expect(submittedPhoto.data).toBe(data);
      expect(await mockPg('service_photos').whereIn('service_record_id', first.body.items.map((item) => item.serviceRecordId)))
        .toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202, body: { replayed: true } });
      expect(send).toHaveBeenCalledTimes(2);
      submittedPhoto.data = `data:image/png;base64,${Buffer.from('changed photo').toString('base64')}`;
      expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
    } finally {
      send.mockRestore();
      config.s3.bucket = priorBucket;
      flags.mockImplementation(async () => false);
    }
  });

  test.each(['completionPhotos', 'gaugePhoto'])('deduplicated staged %s survive rollback and retry', async (field) => {
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    const send = jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    const flags = require('../services/feature-flags').isUserFeatureEnabled;
    const input = submission();
    const bytes = Buffer.from('synthetic staged photo');
    const photo = { data: `data:image/png;base64,${bytes.toString('base64')}`, name: 'fixture.png' };
    const photoKey = `fixture/${fixture.serviceIds[0]}/staged.png`;
    if (field === 'gaugePhoto') {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'WaveGuard Lawn Care' });
      flags.mockImplementation(async (_id, flag) => flag === 'turf-height-capture');
    }
    try {
      await mockPg('scheduled_service_photo_staging').insert({
        scheduled_service_id: fixture.serviceIds[0], technician_id: fixture.techId,
        photo_type: 'progress', s3_key: photoKey,
        image_sha256: require('crypto').createHash('sha256').update(bytes).digest('hex'),
      });
      input.items[0].body[field] = field === 'completionPhotos' ? [photo] : photo;
      input.items[1].body.clientPestRating = 99;
      expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 400, body: { code: 'client_pest_rating_invalid' } });
      expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(1);
      expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(0);
      expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();

      delete input.items[1].body.clientPestRating;
      expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 202 });
      expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(0);
      expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(1);
      expect(send).not.toHaveBeenCalled();
    } finally {
      send.mockRestore();
      config.s3.bucket = priorBucket;
      flags.mockImplementation(async () => false);
    }
  });

  test.each(['completionPhotos', 'gaugePhoto'])('a later %s upload failure rolls back the packet and cleans up earlier objects', async (field) => {
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    const send = jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send')
      .mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Fixture upload unavailable')).mockResolvedValue({});
    const input = submission();
    const flags = require('../services/feature-flags').isUserFeatureEnabled;
    if (field === 'gaugePhoto') {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'WaveGuard Lawn Care' });
      flags.mockImplementation(async (_id, flag) => flag === 'turf-height-capture');
    }
    const photo = {
      data: `data:image/png;base64,${Buffer.from('synthetic photo').toString('base64')}`, name: 'fixture.png',
    };
    for (const item of input.items) item.body[field] = field === 'completionPhotos' ? [{ ...photo }] : { ...photo };
    try {
      await expect(saveVisitCompletionPacket(input))
        .rejects.toMatchObject({ code: 'visit_completion_photos_upload_failed', statusCode: 503 });
      expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(await mockPg('turf_height_readings').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds)).toHaveLength(0);
      const commands = send.mock.calls.map(([command]) => command);
      expect(commands.map((command) => command.constructor.name)).toEqual(['PutObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand']);
      expect(commands[2].input.Key).toBe(commands[0].input.Key);
      expect((await mockPg('scheduled_services').whereIn('id', fixture.serviceIds)).every((row) => row.status === 'on_site')).toBe(true);
      const retried = await saveVisitCompletionPacket(input);
      expect(retried).toMatchObject({ status: 202, body: { replayed: false } });
      expect(await mockPg('service_photos').whereIn('service_record_id', retried.body.items.map((item) => item.serviceRecordId)))
        .toHaveLength(2);
    } finally {
      send.mockRestore();
      config.s3.bucket = priorBucket;
      flags.mockImplementation(async () => false);
    }
  });

  test.each(['disabled flag', 'SQL failure'])('a gauge capture %s rolls back earlier photos and permits a complete retry', async (mode) => {
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    const send = jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    const flags = require('../services/feature-flags').isUserFeatureEnabled;
    let checks = 0;
    flags.mockImplementation(async (_id, flag, _fallback, database) => {
      if (flag !== 'turf-height-capture') return false;
      checks += 1;
      if (checks !== 2) return true;
      if (mode === 'SQL failure') await database.raw('SELECT 1 / 0');
      return false;
    });
    await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ service_type: 'WaveGuard Lawn Care' });
    const input = submission();
    for (const item of input.items) item.body.gaugePhoto = {
      data: `data:image/png;base64,${Buffer.from('synthetic gauge photo').toString('base64')}`, name: 'fixture.png',
    };
    try {
      expect(await saveVisitCompletionPacket(input)).toMatchObject({ status: 409, body: {
        code: 'visit_gauge_photo_unavailable', serviceId: fixture.serviceIds[1],
      } });
      expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(await mockPg('turf_height_readings').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
      const commands = send.mock.calls.map(([command]) => command);
      expect(commands.map((command) => command.constructor.name)).toEqual(['PutObjectCommand', 'DeleteObjectCommand']);
      expect(commands[1].input.Key).toBe(commands[0].input.Key);

      flags.mockImplementation(async (_id, flag) => flag === 'turf-height-capture');
      const retried = await saveVisitCompletionPacket(input);
      expect(retried).toMatchObject({ status: 202, body: { replayed: false } });
      expect(await mockPg('service_photos').whereIn('service_record_id', retried.body.items.map((item) => item.serviceRecordId)))
        .toHaveLength(2);
      expect((await saveVisitCompletionPacket(input)).body.replayed).toBe(true);
      expect(send.mock.calls.map(([command]) => command.constructor.name))
        .toEqual(['PutObjectCommand', 'DeleteObjectCommand', 'PutObjectCommand', 'PutObjectCommand']);
    } finally {
      send.mockRestore();
      config.s3.bucket = priorBucket;
      flags.mockImplementation(async () => false);
    }
  });

  test.each(['profile', 'Auto Pay', 'turf profile', 'Pest Pressure table', 'Pest Pressure config', 'customer snapshot'])
  ('a packet records every member after a recoverable %s read failure', async (helper) => {
    const matches = {
      profile: (query) => query.sql.includes('information_schema.tables') && query.bindings.includes('service_completion_profiles'),
      'Auto Pay': (query) => query.sql.includes('from "payment_methods"'),
      'turf profile': (query) => query.sql.includes('from "customer_turf_profiles"'),
      'Pest Pressure table': (query) => query.sql.includes('information_schema.tables') && query.bindings.includes('pest_pressure_configs'),
      'Pest Pressure config': (query) => query.sql.includes('from "pest_pressure_configs"'),
      'customer snapshot': (query) => query.sql.startsWith('select "waveguard_tier", "monthly_rate"'),
    };
    await withReadFailure(matches[helper], async (database) => {
      await database('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true, waveguard_tier: 'Bronze' });
      const input = submission();
      for (const item of input.items) item.body.clientPestRating = 3;
      const result = await saveVisitCompletionPacket(input, database);
      expect(result).toMatchObject({ status: 202, body: { state: 'records_saved' } });
      const records = await database('service_records').where({ customer_id: fixture.customerId });
      expect(records).toHaveLength(2);
      expect(records.every((record) => record.service_tier === 'Bronze')).toBe(true);
      expect(result.body.billing).toMatchObject({ state: 'invoice_ready' });
      expect(await database('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });
  });

  test.each(['rows', 'catalog', 'profiles'])('add-on %s read failures preserve the packet and per-line snapshot fallback', async (read) => {
    const key = `fixture_${fixture.catalogId}`;
    await mockPg('service_completion_profiles').insert({ service_key: key, completion_mode: 'service_report', active: true });
    await mockPg('scheduled_service_addons').insert([
      { scheduled_service_id: fixture.serviceIds[0], service_id: fixture.catalogId,
        service_name: 'Fixture Frozen Add-on', service_key_snapshot: key },
      { scheduled_service_id: fixture.serviceIds[0], service_id: fixture.catalogId,
        service_name: 'Fixture Live Add-on', service_key_snapshot: null },
    ]);
    const matches = {
      rows: (query) => query.sql.startsWith('select "service_id", "service_name", "service_key_snapshot" from "scheduled_service_addons"'),
      catalog: (query) => query.sql.startsWith('select "id", "service_key" from "services"'),
      profiles: (query) => query.sql.startsWith('select "service_key", "project_type" from "service_completion_profiles"'),
    };
    await withReadFailure(matches[read], async (database) => {
      expect(await saveVisitCompletionPacket(submission(), database)).toMatchObject({ status: 202 });
      const records = await database('service_records').where({ customer_id: fixture.customerId }).orderBy('scheduled_service_id');
      expect(records).toHaveLength(2);
      const lines = records[0].service_data.completedAddonLines;
      if (read === 'rows') expect(lines).toBeUndefined();
      else {
        expect(lines).toHaveLength(2);
        expect(lines.find((line) => line.serviceName === 'Fixture Live Add-on')).not.toHaveProperty('serviceKey');
        const frozen = lines.find((line) => line.serviceName === 'Fixture Frozen Add-on');
        if (read === 'catalog') expect(frozen).toMatchObject({ serviceKey: key, findingsType: null });
        else expect(frozen).not.toHaveProperty('serviceKey');
      }
    });
  });

  test.each(['recap only', 'not performed', 'unpriced', 'billable'])
  ('payer SQL failure preserves the %s completion contract', async (shape) => {
    const input = submission();
    if (shape === 'recap only') input.items[0].body.oneTimeRecapOnly = true;
    if (shape === 'not performed') input.items[0].body.visitOutcome = 'inspection_only';
    if (shape === 'unpriced') await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ estimated_price: 0 });
    await withReadFailure((query) => query.sql.includes('select "payer_id", "po_number"'), async (database) => {
      const result = saveVisitCompletionPacket(input, database);
      if (shape === 'billable') {
        await expect(result).rejects.toMatchObject({ code: '22012' });
        expect(await database('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
        expect(await database('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      } else {
        expect(await result).toMatchObject({ status: 202, body: { state: 'records_saved' } });
        expect(await database('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      }
      const invoices = await database('invoices').where({ customer_id: fixture.customerId });
      if (shape !== 'billable') {
        expect(invoices).toHaveLength(1);
        expect(Number(invoices[0].total)).toBe(120);
        expect(invoices[0].scheduled_service_id).toBe(fixture.serviceIds[1]);
      } else expect(invoices).toHaveLength(0);
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test('the termite station-cap fallback leaves its transaction usable after a failed read', async () => {
    const { stationCapWouldOverflow } = require('../services/termite-stations');
    await withReadFailure((query) => query.sql.includes('from "termite_stations"'), async (database) => {
      await database.transaction(async (trx) => {
        expect(await stationCapWouldOverflow(trx, fixture.customerId, [{ shape: { type: 'circle', cx: 0.5, cy: 0.5, r: 0.01 } }]))
          .toBe(false);
        await trx('customers').where({ id: fixture.customerId }).update({ first_name: 'Recovered' });
        expect(await trx('customers').where({ id: fixture.customerId }).first('first_name')).toEqual({ first_name: 'Recovered' });
      });
    });
  });

  test('connected combined booking converts, arrives, closes, charges and replays as one stop', async () => {
    const pool = mockPg;
    const trx = await pool.transaction();
    const baseline = { visitId: fixture.visitId, serviceIds: fixture.serviceIds, key: fixture.key,
      estimateIds: fixture.estimateIds, httpServer: fixture.httpServer };
    const gateNames = ['GATE_SCHEDULING_CAPACITY', 'GATE_VISIT_COMBINED_CAPACITY',
      'GATE_SEPARATE_COMBO_VISITS', 'GATE_VISIT_GROUPS', 'GATE_CUSTOMER_PROPERTIES'];
    const originalEnv = Object.fromEntries(gateNames.map((name) => [name, process.env[name]]));
    const gates = require('../config/feature-gates').gates;
    const originalGates = { visitGroups: gates.visitGroups, visitCombinedCapacity: gates.visitCombinedCapacity,
      separateComboVisits: gates.separateComboVisits };
    const artifactPath = path.resolve(__dirname, '../../.tmp/qa/combined-stop/backend-journey.json');
    let coordsSpy;
    let server;
    mockPg = trx;
    Object.assign(process.env, Object.fromEntries(gateNames.map((name) => [name, 'true'])));
    process.env.GATE_SCHEDULING_CAPACITY = 'false';
    Object.assign(gates, { visitGroups: true, visitCombinedCapacity: true, separateComboVisits: true });
    try {
      // Remove the generic beforeEach stop inside this rollback-only case.
      // Every later ID comes from this reservation and its conversion.
      await trx('scheduled_services').whereIn('id', baseline.serviceIds).del();
      await trx('service_visits').where({ id: baseline.visitId }).del();
      await trx('customers').where({ id: fixture.customerId }).update({ last_name: 'Connected',
        address_line1: '100 Connected Court', city: 'Parrish', state: 'FL', zip: '34219',
        pipeline_stage: 'active_customer', active: true, property_type: 'residential', billing_mode: 'per_application' });
      await trx('technicians').where({ id: fixture.techId }).update({ email: `${fixture.techId}@example.invalid`,
        employment_status: 'active', field_dispatchable: true, auth_token_version: 1, must_change_password: false });
      const propertyId = randomUUID();
      await trx('customer_properties').insert({ id: propertyId, customer_id: fixture.customerId,
        is_primary: true, active: true, address_line1: '100 Connected Court', city: 'Parrish',
        state: 'FL', zip: '34219', source: 'estimate_accept' });

      const services = [
        { service: 'pest_control', name: 'Quarterly Pest Control', visitsPerYear: 4, frequency: 'quarterly',
          annual: 480, mo: 40, perTreatment: 120, catalog: 'pest_general_quarterly' },
        { service: 'lawn_care', name: 'Lawn Care', visitsPerYear: 6, frequency: 'bimonthly',
          annual: 720, mo: 60, perTreatment: 120, catalog: 'lawn_care_recurring' },
      ];
      const catalogs = await trx('services').whereIn('service_key', services.map((service) => service.catalog));
      expect(catalogs).toHaveLength(2);
      expect(catalogs.every((catalog) => catalog.is_active && catalog.groupable && catalog.group_family)).toBe(true);
      const { addETDays, etParts } = require('../utils/datetime-et');
      let future = addETDays(new Date(), 45);
      while ([0, 6].includes(etParts(future).dayOfWeek)) future = addETDays(future, 1);
      const reservedDate = etDateString(future);
      const estimateId = randomUUID();
      fixture.estimateIds = [estimateId];
      await trx('estimates').insert({ id: estimateId, customer_id: fixture.customerId, property_id: propertyId,
        status: 'sent', token: randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', ''),
        category: 'RESIDENTIAL', address: '100 Connected Court, Parrish, FL 34219',
        monthly_total: 100, annual_total: 1200,
        estimate_data: { result: { recurring: { services } } } });
      const estimate = await trx('estimates').where({ id: estimateId }).first();
      const estimatePublic = require('../routes/estimate-public');
      const firstApplicationAmount = estimatePublic.sameDayVisitTotalForPricingFrequency(
        { perServiceTreatments: services }, { services },
      );
      const visitEstimatedPrice = estimatePublic.acceptVisitEstimatedPrice({
        billingTerm: 'standard', firstApplicationInvoiceAmount: firstApplicationAmount,
      });
      expect({ firstApplicationAmount, visitEstimatedPrice }).toEqual({
        firstApplicationAmount: 240, visitEstimatedPrice: 240,
      });
      const profile = await resolveCatalogSlotProfile(estimate, {}, trx);
      expect(profile.services.map((service) => service.service)).toEqual(['pest_control', 'lawn_care']);
      expect(profile.durationMinutes).toBe(120);
      expect(profile.reservationServiceMix).toMatchObject({ version: 1, durationMinutes: 120 });
      coordsSpy = jest.spyOn(require('../services/estimate-slot-availability'), 'resolveEstimateCoords')
        .mockResolvedValue(require('../services/route-optimizer').HQ);
      const offer = signSlotOffer({ surface: 'estimate', scopeId: estimateId, date: reservedDate,
        startMinutes: 540, technicianId: fixture.techId, durationMinutes: profile.durationMinutes });
      const held = await reserveSlot({ estimateId,
        slotId: appendOfferToSlotId(`${reservedDate}_09-00_${fixture.techId}`, offer) });
      expect(await trx('scheduled_services').where({ id: held.scheduledServiceId }).first())
        .toMatchObject({ customer_id: null, source_estimate_id: estimateId,
          estimated_duration_minutes: profile.durationMinutes,
          reservation_service_mix: { version: 1, durationMinutes: 120 } });
      await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: fixture.customerId,
        estimatedPrice: visitEstimatedPrice, trx });
      await trx('estimates').where({ id: estimateId }).update({ status: 'accepted', accepted_at: trx.fn.now() });
      await EstimateConverter.convertEstimate(estimateId, { skipSetupInvoice: true, autoSendInvoice: false,
        skipMembershipEmail: true, deferFollowUpReminderRegistration: true,
        deferCommercialScheduleNotification: true,
        firstApplicationRowAmounts: services.map((service) => ({
          service: service.service, name: service.name, amount: service.perTreatment,
        })),
        database: trx });
      // The public acceptance route calls this real post-commit coordinator;
      // it stamps the converted booking, then forms the physical stop.
      expect(await require('../services/estimate-property-linkage').linkAcceptedEstimateProperty({
        estimateId, customerId: fixture.customerId, database: trx,
      })).toMatchObject({ propertyId });
      const parents = await trx('scheduled_services').where({ source_estimate_id: estimateId })
        .whereNull('recurring_parent_id').orderBy('id');
      expect(parents).toHaveLength(2);
      expect(parents.map((row) => Number(row.estimated_price)).sort((a, b) => a - b)).toEqual([0, 240]);
      expect(parents.reduce((sum, row) => sum + Number(row.estimated_duration_minutes), 0)).toBe(120);
      expect(parents.map((row) => [row.window_start, row.window_end]).sort())
        .toEqual([['09:00:00', '10:00:00'], ['10:00:00', '11:00:00']]);
      expect(new Set(parents.map((row) => row.visit_id)).size).toBe(1);
      expect(parents.every((row) => row.property_id === propertyId && row.visit_id)).toBe(true);
      const visitId = parents[0].visit_id;
      expect(await trx('scheduled_services').where({ visit_id: visitId })).toHaveLength(2);

      // Reach the booked day, then exercise the real technician arrival route
      // so its stop fan-out moves both converted members on site.
      const serviceDate = etDateString();
      await trx('scheduled_services').whereIn('id', parents.map((row) => row.id)).update({ scheduled_date: serviceDate });
      await trx('service_visits').where({ id: visitId }).update({ scheduled_date: serviceDate,
        stop_base_key: stopBaseKey({ propertyId, scheduledDate: serviceDate }) });
      fixture.visitId = visitId;
      fixture.serviceIds = parents.map((row) => row.id).sort();
      fixture.key = randomUUID();
      const methodId = randomUUID();
      await trx('payment_methods').insert({ id: methodId, customer_id: fixture.customerId, processor: 'stripe',
        method_type: 'card', stripe_payment_method_id: 'pm_connected_combined', is_default: true,
        autopay_enabled: true, exp_month: 12, exp_year: new Date().getUTCFullYear() + 1 });
      await trx('customers').where({ id: fixture.customerId })
        .update({ autopay_enabled: true, autopay_payment_method_id: methodId });
      // The standard public accept freezes member-owned first-application
      // lines and canonical provenance notes on the reserved parent. The card
      // lane leaves this one draft invoice for completion to adopt and collect.
      const acceptanceLines = await itemizeFirstApplication({ estimateId, customerId: fixture.customerId,
        scheduledServiceId: held.scheduledServiceId,
        rowAmounts: services.map((service) => ({ service: service.service, name: service.name,
          amount: service.perTreatment })),
        line: { description: 'First service application', quantity: 1, unit_price: firstApplicationAmount },
      }, trx);
      const acceptedInvoice = await InvoiceService.create({ database: trx, customerId: fixture.customerId,
        scheduledServiceId: held.scheduledServiceId, title: 'First Service Application',
        notes: acceptanceInvoiceNotes(estimateId, 'first application only'), lineItems: acceptanceLines,
        dueDate: etDateString() });
      expect(await trx('invoices').where({ customer_id: fixture.customerId })).toHaveLength(1);
      let providerSubmissions = 0;
      chargeInvoiceWithSavedCard.mockImplementation(async (invoiceId, selectedMethod, options) => {
        expect(selectedMethod).toBe(methodId);
        await mockPg.transaction(async (chargeTrx) => {
          const invoice = await chargeTrx('invoices').where({ id: invoiceId }).forUpdate().first();
          require('../services/invoice-helpers').assertInvoiceCollectible(invoice);
          await chargeTrx('customers').where({ id: fixture.customerId }).forUpdate().first('id');
          await assertVisitCompletionCharge(chargeTrx, invoice, options.requireVisitCompletionPacketId);
          providerSubmissions += 1;
          await chargeTrx('invoices').where({ id: invoiceId }).update({ status: 'paid',
            paid_at: chargeTrx.fn.now(), stripe_payment_intent_id: 'pi_connected_combined' });
        });
      });
      const app = require('express')();
      app.use(require('express').json());
      app.use('/api/tech/services', require('../routes/tech-track'));
      app.use('/api/admin/visit-closeouts', require('../routes/admin-visit-closeouts'));
      app.use('/api/visit-summary', require('../routes/visit-summary-public'));
      app.use((err, req, res, next) => res.status(500).json({ error: err.message, code: err.code }));
      server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      });
      fixture.httpServer = server;
      const token = require('jsonwebtoken').sign({ technicianId: fixture.techId, type: 'access', tokenVersion: 1 },
        require('../config').jwt.secret);
      const request = async (requestPath, { method = 'GET', body, idempotencyKey } = {}) => {
        const response = await fetch(`http://127.0.0.1:${server.address().port}${requestPath}`, { method,
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, body: await response.json() };
      };
      expect(await request(`/api/tech/services/${fixture.serviceIds[0]}/on-site`, { method: 'POST' }))
        .toMatchObject({ status: 200, body: { state: 'on_property' } });
      expect((await trx('scheduled_services').whereIn('id', fixture.serviceIds).pluck('status')).sort())
        .toEqual(['on_site', 'on_site']);
      await trx('service_visits').where({ id: visitId }).update({ arrived_at: trx.raw("NOW() - INTERVAL '60 minutes'") });

      const closeoutPath = `/api/admin/visit-closeouts/${visitId}`;
      const closeoutBody = { items: submission().items };
      const completed = await request(closeoutPath,
        { method: 'POST', body: closeoutBody, idempotencyKey: fixture.key });
      expect(completed).toMatchObject({ status: 200,
        body: { state: 'done', payment: { state: 'paid' }, delivery: { state: 'delivered' } } });
      const invoice = await trx('invoices').where({ customer_id: fixture.customerId }).first();
      const packet = await trx('visit_completion_packets').where({ id: completed.body.packetId }).first();
      const records = await trx('service_records').whereIn('scheduled_service_id', fixture.serviceIds);
      const costs = await trx('job_costs').whereIn('scheduled_service_id', fixture.serviceIds);
      const effects = await trx('visit_effects').where({ visit_id: visitId })
        .whereIn('effect_type', ['completion_sms', 'completion_email']);
      expect(records).toHaveLength(2);
      expect(costs).toHaveLength(2);
      expect(packet.payload.durationAllocation).toMatchObject({ totalMinutes: 60,
        items: expect.arrayContaining(fixture.serviceIds.map((serviceId) =>
          expect.objectContaining({ serviceId, allocatedMinutes: expect.any(Number) }))) });
      expect(packet.payload.durationAllocation.items.reduce((sum, item) => sum + item.allocatedMinutes, 0)).toBe(60);
      expect(invoice).toMatchObject({ id: acceptedInvoice.id, status: 'paid',
        subtotal: '240.00', discount_amount: '0.00', total: '240.00' });
      expect(invoice.line_items.map((line) => Number(line.amount))).toEqual([120, 120]);
      const financials = await trx('company_financials').orderBy('effective_date', 'desc').first();
      expect(costs.reduce((sum, row) => sum + Number(row.drive_cost), 0)).toBe(Number(financials.drive_cost_per_stop));
      expect(costs.reduce((sum, row) => sum + Number(row.labor_cost), 0)).toBe(Number(financials.loaded_labor_rate));
      expect(effects).toEqual(expect.arrayContaining([
        expect.objectContaining({ effect_type: 'completion_sms', status: 'sent' }),
        // The test's provider stub exercises the handoff but deliberately
        // creates no email_messages ledger row, so the aggregate settles this
        // leg as suppressed rather than treating a return value as send proof.
        expect.objectContaining({ effect_type: 'completion_email', status: 'suppressed' }),
      ]));
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(require('../services/email-template-library').sendTemplate).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(providerSubmissions).toBe(1);
      const summary = await request(completed.body.summaryUrl.replace('/visit/', '/api/visit-summary/'));
      expect(summary.status).toBe(200);
      expect(summary.body.services).toHaveLength(2);

      const counts = async () => Object.fromEntries(await Promise.all([
        ['records', trx('service_records').whereIn('scheduled_service_id', fixture.serviceIds).count({ count: '*' }).first()],
        ['invoices', trx('invoices').where({ customer_id: fixture.customerId }).count({ count: '*' }).first()],
        ['packets', trx('visit_completion_packets').where({ visit_id: visitId }).count({ count: '*' }).first()],
        ['items', trx('visit_completion_packet_items').where({ packet_id: packet.id }).count({ count: '*' }).first()],
        ['effects', trx('visit_effects').where({ visit_id: visitId }).count({ count: '*' }).first()],
      ].map(async ([name, query]) => [name, Number((await query).count)])));
      const beforeRetry = await counts();
      expect(beforeRetry).toMatchObject({ records: 2, invoices: 1, packets: 1, items: 2 });
      const replay = await request(closeoutPath,
        { method: 'POST', body: closeoutBody, idempotencyKey: fixture.key });
      expect(replay).toMatchObject({ status: 200, body: { packetId: packet.id, state: 'done',
        payment: { state: 'paid' }, summaryUrl: completed.body.summaryUrl } });
      expect(await counts()).toEqual(beforeRetry);
      expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
      expect(require('../services/email-template-library').sendTemplate).toHaveBeenCalledTimes(1);
      expect(chargeInvoiceWithSavedCard).toHaveBeenCalledTimes(1);
      expect(providerSubmissions).toBe(1);

      const observations = { estimateId, reservationId: held.scheduledServiceId, visitId,
        serviceIds: fixture.serviceIds, packetId: packet.id, invoiceId: invoice.id,
        gates: { schedulingCapacity: false, visitCombinedCapacity: true,
          separateComboVisits: true, visitGroups: true, customerProperties: true },
        acceptedPricing: { billingTerm: 'standard', rowAmounts: services.map((service) => service.perTreatment),
          firstApplicationAmount, visitEstimatedPrice },
        reservedMix: profile.reservationServiceMix,
        reservedMinutes: profile.durationMinutes,
        allocatedMinutes: packet.payload.durationAllocation.items.map((item) =>
          ({ serviceId: item.serviceId, minutes: item.allocatedMinutes })),
        rowCounts: beforeRetry,
        invoice: { lineAmounts: invoice.line_items.map((line) => Number(line.amount)),
          subtotal: Number(invoice.subtotal), discount: Number(invoice.discount_amount), total: Number(invoice.total) },
        jobCosts: { labor: costs.reduce((sum, row) => sum + Number(row.labor_cost), 0),
          drive: costs.reduce((sum, row) => sum + Number(row.drive_cost), 0),
          total: costs.reduce((sum, row) => sum + Number(row.total_cost), 0) },
        invocations: { successfulCharges: providerSubmissions, smsSummaries: sendCustomerMessage.mock.calls.length,
          emailSummaries: require('../services/email-template-library').sendTemplate.mock.calls.length },
        retry: { samePacket: replay.body.packetId === packet.id, rowCountsUnchanged: true } };
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, `${JSON.stringify(observations, null, 2)}\n`);
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      fixture.httpServer = null;
      if (coordsSpy) coordsSpy.mockRestore();
      mockPg = pool;
      await trx.rollback();
      Object.assign(fixture, baseline);
      for (const name of gateNames) {
        if (originalEnv[name] === undefined) delete process.env[name];
        else process.env[name] = originalEnv[name];
      }
      Object.assign(gates, originalGates);
    }
  });
});
