/** Canonical completion writes against a migrated, private nonproduction database. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchApplicationConditions: jest.fn(async () => null) }));
jest.mock('../services/recap-visit-context', () => ({ buildRecapVisitContext: jest.fn(async () => '') }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/stripe', () => ({ chargeInvoiceWithSavedCard: jest.fn() }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { saveVisitCompletionRecords } = require('../services/visit-completion-packets');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');
const { stopBaseKey } = require('../services/visit-groups');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const connection = process.env.VISIT_PACKET_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
let fixture;
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

postgres('visit completion packet records on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a verified, task-private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockPg.schema.hasTable('visit_completion_packets'))) throw new Error('Run the repository migrations first');
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), productId: randomUUID(),
      visitId: randomUUID(), serviceIds: [randomUUID(), randomUUID()].sort(), key: randomUUID() };
    const date = etDateString();
    await mockPg('customers').insert({ id: fixture.customerId, first_name: 'Fixture', phone: '+12025550123',
      email: `${fixture.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
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
    // Only the synthetic fixture's rows; the private database's seeded catalog
    // and migration data remain intact for later billing/UI verification.
    await mockPg('customers').where({ id: fixture.customerId }).del();
    await mockPg('technicians').where({ id: fixture.techId }).del();
    await mockPg('services').where({ id: fixture.catalogId }).del();
    await mockPg('product_inventory_movements').where({ product_id: fixture.productId }).del();
    await mockPg('products_catalog').where({ id: fixture.productId }).del();
  });

  test('two canonical records commit together and their effects remain pending', async () => {
    const result = await saveVisitCompletionRecords(submission());
    expect(result).toMatchObject({ status: 202, body: { state: 'records_saved', replayed: false } });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId });
    expect(records).toHaveLength(2);
    expect(records.every((row) => row.status === 'completed')).toBe(true);
    expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds))
      .toEqual(expect.arrayContaining(result.body.items.map((item) => expect.objectContaining({
        service_id: item.serviceId, service_record_id: item.serviceRecordId, status: 'side_effects_pending',
      }))));
    expect(await mockPg('job_status_history').whereIn('job_id', fixture.serviceIds)).toHaveLength(2);
    expect(await mockPg('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
  });

  test('a rejected second form rolls back the first record, status and claim', async () => {
    const input = submission();
    const photoKey = `fixture/${fixture.serviceIds[0]}/before.png`;
    await mockPg('scheduled_service_photo_staging').insert({
      scheduled_service_id: fixture.serviceIds[0], technician_id: fixture.techId,
      photo_type: 'before', s3_key: photoKey, image_sha256: '0'.repeat(64),
    });
    input.items[1].body.clientPestRating = 99;
    const result = await saveVisitCompletionRecords(input);
    expect(result).toMatchObject({ status: 400, body: { code: 'client_pest_rating_invalid', serviceId: fixture.serviceIds[1] } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds)).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect(await mockPg('job_status_history').whereIn('job_id', fixture.serviceIds)).toHaveLength(0);
    expect((await mockPg('service_visits').where({ id: fixture.visitId }).first()).status).toBe('open');
    expect((await mockPg('scheduled_services').whereIn('id', fixture.serviceIds)).every((row) => row.status === 'on_site')).toBe(true);
    expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(1);
    expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(0);
    expect((await saveVisitCompletionRecords(submission())).status).toBe(202);
    expect(await mockPg('scheduled_service_photo_staging').where({ s3_key: photoKey })).toHaveLength(0);
    expect(await mockPg('service_photos').where({ s3_key: photoKey })).toHaveLength(1);
  });

  test('concurrent double taps converge on one packet and one record per service', async () => {
    const results = await Promise.all([saveVisitCompletionRecords(submission()), saveVisitCompletionRecords(submission())]);
    expect(results.map((result) => result.status)).toEqual([202, 202]);
    expect(new Set(results.map((result) => result.body.packetId)).size).toBe(1);
    expect(results.filter((result) => result.body.replayed)).toHaveLength(1);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
  });

  test('a retry cannot change saved outcomes or use a new key', async () => {
    const first = await saveVisitCompletionRecords(submission());
    expect(first.status).toBe(202);
    const changed = submission();
    changed.items[1].body.visitOutcome = 'incomplete';
    expect(await saveVisitCompletionRecords(changed)).toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
    expect(await saveVisitCompletionRecords(submission({ idempotencyKey: randomUUID() })))
      .toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
  });

  test('an individual endpoint cannot claim a saved member for billing and delivery', async () => {
    expect((await saveVisitCompletionRecords(submission())).status).toBe(202);
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
    expect((await saveVisitCompletionRecords(input)).status).toBe(202);
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId }).orderBy('scheduled_service_id');
    expect(records.map((record) => record.status)).toEqual(['completed', 'incomplete']);
    expect(records[1].structured_notes).toMatchObject({ visitOutcome: 'incomplete' });
    expect(await mockPg('service_products').whereIn('service_record_id', records.map((record) => record.id))).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(6);
    expect(await mockPg('product_inventory_movements').where({ product_id: fixture.productId })).toHaveLength(2);
    expect((await saveVisitCompletionRecords(input)).body.replayed).toBe(true);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(6);
  });

  test('a late product validator rolls back earlier inventory deductions too', async () => {
    const input = submission();
    input.items[0].body.products = [{ productId: fixture.productId, totalAmount: 2, amountUnit: 'oz',
      applicationMethod: 'bait_placement', areaValue: 1000, areaUnit: 'sqft' }];
    input.items[1].body.products = [{ productId: fixture.productId, totalAmount: 2, amountUnit: 'invalid_fixture_unit' }];
    await expect(saveVisitCompletionRecords(input)).rejects.toMatchObject({ isOperational: true, statusCode: 400 });
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(10);
    expect(await mockPg('product_inventory_movements').where({ product_id: fixture.productId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('a missing form or another technician cannot freeze the visit', async () => {
    expect(await saveVisitCompletionRecords(submission({ actor: { techRole: 'technician', technicianId: randomUUID() } })))
      .toMatchObject({ status: 403 });
    const input = submission();
    input.items[1].serviceId = randomUUID();
    expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 409, body: { code: 'visit_members_changed' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
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
    const result = await saveVisitCompletionRecords(input);
    expect(result).toMatchObject({ status: 202, body: { state: 'records_saved' } });
    const records = await mockPg('service_records').where({ customer_id: fixture.customerId }).orderBy('scheduled_service_id');
    expect(records[1].structured_notes.waveguardNLimitApproval).toMatchObject({
      advisory: true, annualN: { used: 0.1 },
      blocks: expect.arrayContaining([expect.objectContaining({ code: 'actual_annual_n_budget_exceeded' })]),
    });
    expect(await mockPg('property_nutrient_ledger').where({ customer_id: fixture.customerId })).toHaveLength(2);
    expect(Number((await mockPg('products_catalog').where({ id: fixture.productId }).first()).inventory_on_hand)).toBe(-0.5);
    expect((await saveVisitCompletionRecords(input)).body.replayed).toBe(true);
    expect(await mockPg('property_nutrient_ledger').where({ customer_id: fixture.customerId })).toHaveLength(2);
  });
});
