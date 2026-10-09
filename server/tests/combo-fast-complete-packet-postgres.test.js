/**
 * GATE_COMBO_FAST_COMPLETE (PR 1): a visit-closeout packet whose two items are a pest Fast Complete body
 * and a lawn Fast Complete body, against a migrated, private nonproduction database (CI-only unless
 * VISIT_PACKET_TEST_DATABASE_URL names one). The packet must record what the same two visits record when
 * completed one by one through the canonical completion, bill ONE invoice for the stop, and send no
 * customer text of its own. Synthetic data only.
 */
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
const { saveVisitCompletionPacket, runVisitCompletionPacketEffects } = require('../services/visit-completion-packets');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { buildLawnFastContext } = require('../services/lawn-fast-complete');
const { buildRecapContext } = require('../services/pest-recap');
const { etDateString } = require('../utils/datetime-et');
const { stopBaseKey } = require('../services/visit-groups');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

// Jest runs the services in a separate realm, where the identity check's `instanceof Date` is false for a
// driver Date; a date column read as 'YYYY-MM-DD' keeps the sheet's scheduledDate comparison meaningful here.
require('pg').types.setTypeParser(1082, (value) => value);
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
let mockNotificationRecipientId;
const GATES = ['GATE_COMBO_FAST_COMPLETE', 'GATE_LAWN_FAST_COMPLETE', 'GATE_VISIT_CLOSEOUT', 'DATA_HYGIENE_VAULT_KEY'];
const savedEnv = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));
jest.setTimeout(120000);

const REPORT = [
  'WHAT WE FOUND', 'Ghost ants were trailing along the counter, with light activity.', '',
  'WHAT WE DID AND WHY', 'We placed bait along the counter edge and treated around the outside of the house.', '',
  'WHAT TO EXPECT', 'You may see a few more ants near the bait for a few days.', '',
  "WHAT'S NEXT", 'Keeping the counters wiped helps the bait work.',
].join('\n');
const SCORES = { turf_density: 80, weed_suppression: 70, color_health: 60, stress_damage: 50 };

// One customer with a pest visit and a lawn visit on one date; `grouped` puts both on one stop.
async function makeStop({ grouped }) {
  const date = etDateString();
  const world = { customerId: randomUUID(), techId: randomUUID(), visitId: grouped ? randomUUID() : null, pestId: randomUUID(), lawnId: randomUUID(), productId: randomUUID(), lawnProductId: randomUUID(), assessmentId: randomUUID() };
  const pestCatalog = await mockPg('services').where({ service_key: 'pest_general_quarterly' }).first('id', 'name');
  const lawnCatalog = await mockPg('services').where({ service_key: 'lawn_care_monthly' }).first('id', 'name');
  await mockPg('customers').insert({ id: world.customerId, first_name: 'Fixture', last_name: 'Combo', phone: '+12025550123',
    email: `${world.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application', per_application_fee: 60,
    address_line1: '100 Synthetic Test Lane', city: 'Bradenton', state: 'FL', zip: '34201' });
  await mockPg('technicians').insert({ id: world.techId, name: 'Fixture Technician', role: 'technician', active: true });
  await mockPg('products_catalog').insert({ id: world.productId, name: 'Fixture Test Material', category: 'other', active: true, inventory_on_hand: 100, inventory_unit: 'fl_oz' });
  await mockPg('products_catalog').insert({ id: world.lawnProductId, name: 'Fixture Lawn Material', category: 'other', active: true, inventory_on_hand: 100, inventory_unit: 'fl_oz' });
  if (grouped) {
    await mockPg('service_visits').insert({ id: world.visitId, customer_id: world.customerId, technician_id: world.techId, scheduled_date: date,
      window_start: '09:00', window_end: '11:00', stop_base_key: stopBaseKey({ customerId: world.customerId, scheduledDate: date }), created_by: 'test' });
  }
  const row = (id, catalog, type, hour) => ({ id, customer_id: world.customerId, technician_id: world.techId, service_id: catalog.id,
    visit_id: world.visitId, service_type: type, scheduled_date: date, window_start: `${hour}:00`, window_end: `${hour + 1}:00`,
    status: 'on_site', estimated_price: 60, estimated_duration_minutes: 45 });
  await mockPg('scheduled_services').insert([row(world.pestId, pestCatalog, pestCatalog.name, 9), row(world.lawnId, lawnCatalog, lawnCatalog.name, 10)]);
  await mockPg('lawn_assessments').insert({ id: world.assessmentId, customer_id: world.customerId, service_id: world.lawnId, confirmed_by_tech: true,
    service_date: date, ...SCORES });
  return world;
}

// The two bodies the sheets build (pest report flow, lawn fast), from the identities their contexts give.
async function sheetBodies(world) {
  const pestCtx = await buildRecapContext(world.pestId);
  const lawnCtx = await buildLawnFastContext(world.lawnId, { allowGrouped: { stop: true } });
  expect(lawnCtx).toMatchObject({ ok: true, eligible: true });
  return {
    pest: {
      visitOutcome: 'completed', expectedVisit: pestCtx.service, traceSeen: null,
      products: [{ productId: world.productId, applicationMethod: 'spot_treatment', targets: ['ghost ants'], totalAmount: 4, amountUnit: 'fl_oz' }],
      areasServiced: ['Inside', 'Outside'], customerInteraction: 'tech_home_spoke_with_them', clientPestRating: 3,
      technicianNotes: REPORT, reportDraftBase: REPORT, photoCaptionsSeen: [], techTips: null,
      sendCompletionSms: true, includePayLink: true, requestReview: true,
    },
    lawn: {
      visitOutcome: 'completed', expectedVisit: lawnCtx.service, lawnFast: { visitType: lawnCtx.visitType }, lawnAssessmentId: world.assessmentId,
      products: [{ productId: world.lawnProductId, applicationMethod: 'broadcast_spray', totalAmount: 6, amountUnit: 'fl_oz', areaValue: 6000, areaUnit: 'sqft' }],
      technicianNotes: 'Synthetic lawn note', customerInteraction: 'tech_home_spoke_with_them', techTips: null,
      sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto',
    },
  };
}

// What a completed service left behind, as comparable facts (no ids, no timestamps).
async function recordOf(serviceId) {
  const record = await mockPg('service_records').where({ scheduled_service_id: serviceId }).first();
  const products = await mockPg('service_products').where({ service_record_id: record.id }).orderBy('product_name');
  const scores = await mockPg('lawn_assessments').where({ service_id: serviceId }).first(...Object.keys(SCORES), 'confirmed_by_tech');
  const service = await mockPg('scheduled_services').where({ id: serviceId }).first('status');
  return {
    status: service.status, serviceType: record.service_type, notes: record.technician_notes, recordStatus: record.status,
    aiReport: record.ai_report, interaction: record.customer_interaction, rating: record.client_pest_rating,
    areas: record.areas_serviced, flags: record.field_flags, callback: record.is_callback, line: record.service_line,
    // The report draft the tech read and the trace the report was judged against ride in the saved notes.
    notesBlock: JSON.parse(JSON.stringify(record.structured_notes || {}), (key, value) => (/(^id$|At$|_at$|Id$|Key$|Token$|hash|^completionSms|^revision|^serviceReportV1EmailStatus|^visitDriveCostAllocation|^visitDurationAllocation)/i.test(key) ? undefined : value)),
    products: products.map((p) => ({ name: p.product_name, amount: Number(p.total_amount), unit: p.amount_unit, method: p.application_method })),
    scores,
  };
}

postgres('a pest + lawn Fast Complete packet on PostgreSQL', () => {
  beforeAll(async () => {
    process.env.DATA_HYGIENE_VAULT_KEY = 'synthetic-visit-summary-test-key';
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname) && !(process.env.CI === 'true' && url.pathname === '/waves_test')) {
      throw new Error('Use a verified, task-private QA database or the isolated CI database');
    }
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockPg.schema.hasTable('visit_completion_packets'))) throw new Error('Run the repository migrations first');
  });
  afterAll(async () => {
    for (const name of GATES) { if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name]; }
    if (mockPg) await mockPg.destroy();
  });
  const worlds = [];
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_COMBO_FAST_COMPLETE = 'true';
    process.env.GATE_LAWN_FAST_COMPLETE = 'true';
    process.env.GATE_VISIT_CLOSEOUT = 'true';
    sendCustomerMessage.mockImplementation(async (input) => {
      const allowed = await input.withSmsHandoff(async () => ({ ok: true }));
      return allowed.ok ? { sent: true, providerMessageId: 'fixture-sms' } : { blocked: true, code: allowed.code };
    });
  });
  afterEach(async () => {
    while (worlds.length) {
      const world = worlds.pop();
      await mockPg('projects').where({ customer_id: world.customerId }).del();
      await mockPg('invoices').where({ customer_id: world.customerId }).del();
      await mockPg('product_inventory_movements').where({ product_id: world.productId }).del();
      await mockPg('lawn_assessments').where({ customer_id: world.customerId }).del();
      await mockPg('activity_log').where({ customer_id: world.customerId }).del();
      await mockPg('customers').where({ id: world.customerId }).del();
      await mockPg('technicians').where({ id: world.techId }).del();
      await mockPg('product_inventory_movements').where({ product_id: world.lawnProductId }).del();
      await mockPg('products_catalog').whereIn('id', [world.productId, world.lawnProductId]).del();
    }
  });

  test('records what the same two visits record one by one, one invoice, and no text of the packet\'s own', async () => {
    const grouped = await makeStop({ grouped: true });
    const single = await makeStop({ grouped: false });
    worlds.push(grouped, single);
    sendCustomerMessage.mockClear();
    const actor = { techRole: 'technician', technicianId: grouped.techId };

    // One by one, ungrouped: the canonical completion with the same bodies.
    const singleBodies = await sheetBodies(single);
    for (const [serviceId, body] of [[single.pestId, singleBodies.pest], [single.lawnId, singleBodies.lawn]]) {
      const done = await completeScheduledService({ serviceId, idempotencyKey: randomUUID(), body: structuredClone(body), actor: { ...actor, technicianId: single.techId } });
      if (done.status >= 300) throw new Error(`${serviceId === single.pestId ? 'pest' : 'lawn'} ${JSON.stringify(done.body)}`);
    }

    // The packet over the grouped stop with the same two bodies.
    sendCustomerMessage.mockClear();
    const bodies = await sheetBodies(grouped);
    const saved = await saveVisitCompletionPacket({
      visitId: grouped.visitId, idempotencyKey: randomUUID(), actor,
      items: [{ serviceId: grouped.pestId, body: bodies.pest }, { serviceId: grouped.lawnId, body: bodies.lawn }],
    });
    expect(saved.status).toBe(202);
    expect(saved.body.items).toHaveLength(2);
    const result = await runVisitCompletionPacketEffects(saved.body.packetId);
    expect(result.status).toBeLessThan(300);

    // Same records.
    expect(await recordOf(grouped.pestId)).toEqual(await recordOf(single.pestId));
    expect(await recordOf(grouped.lawnId)).toEqual(await recordOf(single.lawnId));
    // The reports were written for each member.
    expect(await mockPg('service_records').whereIn('scheduled_service_id', [grouped.pestId, grouped.lawnId])).toHaveLength(2);
    // ONE invoice for the stop.
    const invoices = await mockPg('invoices').where({ customer_id: grouped.customerId });
    expect(invoices).toHaveLength(1);
    // Texts: the same count as the same stop closed with the full form's bodies (the packet path sends no
    // per-member completion text for either shape).
    // (The one-by-one completions above may text each visit; the packet's members must not.)
    const fastTexts = sendCustomerMessage.mock.calls.length;
    sendCustomerMessage.mockClear();
    const full = await makeStop({ grouped: true });
    worlds.push(full);
    const fullSaved = await saveVisitCompletionPacket({
      visitId: full.visitId, idempotencyKey: randomUUID(), actor: { techRole: 'technician', technicianId: full.techId },
      items: [full.pestId, full.lawnId].map((serviceId) => ({ serviceId, body: {
        visitOutcome: 'completed', products: [], areasTreated: [], customerRecap: 'The scheduled service was completed.',
        sendCompletionSms: true, requestReview: true, includePayLink: true,
      } })),
    });
    expect(fullSaved.status).toBe(202);
    await runVisitCompletionPacketEffects(fullSaved.body.packetId);
    expect(fastTexts).toBe(sendCustomerMessage.mock.calls.length);
    // The notes keys the one-by-one path adds or the packet adds (stripped from the comparison above) are the same
    // for a Fast Complete packet and a full-form packet: they belong to the path, not to the body.
    const notesKeys = async (serviceId) => Object.keys((await mockPg('service_records').where({ scheduled_service_id: serviceId }).first('structured_notes')).structured_notes).sort();
    const packetOnly = (keys) => keys.filter((key) => /^(completionSms|serviceReportV1EmailStatus|visitDriveCostAllocation|visitDurationAllocation)/.test(key));
    expect(packetOnly(await notesKeys(grouped.pestId))).toEqual(packetOnly(await notesKeys(full.pestId)));
    expect(packetOnly(await notesKeys(grouped.lawnId))).toEqual(packetOnly(await notesKeys(full.lawnId)));
  });

  test('gate off: the same packet is refused for the lawn member and nothing is recorded', async () => {
    const grouped = await makeStop({ grouped: true });
    worlds.push(grouped);
    const bodies = await sheetBodies(grouped);
    process.env.GATE_COMBO_FAST_COMPLETE = 'false';
    const saved = await saveVisitCompletionPacket({
      visitId: grouped.visitId, idempotencyKey: randomUUID(), actor: { techRole: 'technician', technicianId: grouped.techId },
      items: [{ serviceId: grouped.pestId, body: bodies.pest }, { serviceId: grouped.lawnId, body: bodies.lawn }],
    });
    expect(saved.status).toBe(409);
    expect(saved.body).toMatchObject({ code: 'lawn_fast_not_eligible', reason: 'grouped_visit', serviceId: grouped.lawnId });
    expect(await mockPg('service_records').whereIn('scheduled_service_id', [grouped.pestId, grouped.lawnId])).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: grouped.visitId })).toHaveLength(0);
  });

  test('a project linked to a member after the bodies were built refuses the packet and records nothing', async () => {
    const grouped = await makeStop({ grouped: true });
    worlds.push(grouped);
    const bodies = await sheetBodies(grouped);
    await mockPg('projects').insert({ customer_id: grouped.customerId, scheduled_service_id: grouped.pestId, project_type: 'wdo_inspection', status: 'draft', created_by_tech_id: grouped.techId });
    const saved = await saveVisitCompletionPacket({
      visitId: grouped.visitId, idempotencyKey: randomUUID(), actor: { techRole: 'technician', technicianId: grouped.techId },
      items: [{ serviceId: grouped.pestId, body: bodies.pest }, { serviceId: grouped.lawnId, body: bodies.lawn }],
    });
    expect(saved.status).toBe(409);
    expect(saved.body).toMatchObject({ code: 'lawn_fast_not_eligible', reason: 'grouped_visit' });
    expect(await mockPg('visit_completion_packets').where({ visit_id: grouped.visitId })).toHaveLength(0);
    expect(await mockPg('service_records').whereIn('scheduled_service_id', [grouped.pestId, grouped.lawnId])).toHaveLength(0);
  });
});
