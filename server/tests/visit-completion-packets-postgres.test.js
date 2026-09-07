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

// Inject a REAL failed PostgreSQL statement at a selected read. A rejected
// JavaScript mock cannot prove that the caller recovers an aborted transaction.
async function withReadFailure(matches, run) {
  const trx = await mockPg.transaction();
  // Intercept the connection, so nested Knex transactions see the same fault.
  const connection = await trx.client.acquireConnection();
  const execute = connection.query;
  let failed = false;
  const querySpy = jest.spyOn(connection, 'query').mockImplementation(function (query, callback) {
    if (!failed && matches({ sql: query.text, bindings: query.values || [] })) {
      failed = true;
      return execute.call(this, { ...query, text: 'SELECT 1 / 0', values: [] }, callback);
    }
    return execute.call(this, query, callback);
  });
  try {
    await run(trx);
    expect(failed).toBe(true);
    // Both reads AND writes must remain available after the fallback/rethrow.
    await trx('customers').where({ id: fixture.customerId }).update({ first_name: 'Recovered' });
    expect(await trx('customers').where({ id: fixture.customerId }).first('first_name'))
      .toEqual({ first_name: 'Recovered' });
  } finally {
    querySpy.mockRestore();
    await trx.rollback();
  }
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
    // Movements first: the customer cascade would otherwise SET NULL a
    // movement's customer while its service_product is deleted in the same
    // statement, and that row's re-check fails the service_product FK.
    await mockPg('product_inventory_movements').where({ product_id: fixture.productId }).del();
    await mockPg('customers').where({ id: fixture.customerId }).del();
    await mockPg('technicians').where({ id: fixture.techId }).del();
    await mockPg('services').where({ id: fixture.catalogId }).del();
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
        await expect(saveVisitCompletionRecords(input)).rejects.toMatchObject({ code: 'completion_pricing_changed' });
        expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
        expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      } else {
        expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 202, body: { state: 'records_saved' } });
        const customerLock = queries.findIndex((query) => query.sql.includes('from "customers"') && query.sql.includes('for no key update'));
        const earlyEstimates = queries.slice(0, customerLock).filter((query) => query.sql.includes('from "estimates"') && query.sql.includes('for share'));
        expect(earlyEstimates.map((query) => query.bindings[0])).toEqual([...estimateIds].sort());
        expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 202, body: { replayed: true } });
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
    const first = await saveVisitCompletionRecords(input);
    expect(first).toMatchObject({ status: 202, body: { state: 'records_saved', replayed: false } });
    expect(first.body.items).toHaveLength(1);
    expect(await mockPg('scheduled_services').where({ id: retainedId }).first('status', 'visit_id'))
      .toEqual({ status, visit_id: fixture.visitId });
    const packet = await mockPg('visit_completion_packets').where({ id: first.body.packetId }).first();
    expect(packet.payload.retainedMembers).toEqual([{ serviceId: retainedId, status }]);
    expect(await mockPg('service_completion_attempts').where({ service_id: retainedId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ scheduled_service_id: retainedId })).toEqual(priorRecords);
    expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 202, body: { replayed: true, items: first.body.items } });
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(1 + priorRecords.length);
  });

  test('allowing one active form never permits omitting another active member', async () => {
    const input = submission();
    input.items.pop();
    expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 409, body: { code: 'visit_members_changed' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
  });

  test('the unique key constraint refuses a key already owned by a different visit', async () => {
    const otherVisitId = randomUUID();
    await mockPg('service_visits').insert({ id: otherVisitId, customer_id: fixture.customerId,
      technician_id: fixture.techId, scheduled_date: '2000-01-01', window_start: '09:00', window_end: '10:00',
      stop_base_key: stopBaseKey({ customerId: fixture.customerId, scheduledDate: '2000-01-01' }), created_by: 'test' });
    await mockPg('visit_completion_packets').insert({ visit_id: otherVisitId, idempotency_key: fixture.key,
      request_hash: '0'.repeat(64), payload: JSON.stringify({ items: [] }), status: 'failed' });
    expect(await saveVisitCompletionRecords(submission())).toMatchObject({ status: 409, body: { code: 'visit_closeout_key_reused' } });
    expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
    expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
  });

  test('packets saved before retained-member snapshots still replay completed records', async () => {
    const input = submission();
    const first = await saveVisitCompletionRecords(input);
    const packet = await mockPg('visit_completion_packets').where({ id: first.body.packetId }).first();
    delete packet.payload.retainedMembers;
    await mockPg('visit_completion_packets').where({ id: packet.id }).update({ payload: JSON.stringify(packet.payload) });
    expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 202, body: { replayed: true, items: first.body.items } });
  });

  test('photo bytes are uploaded once and hashed for retry without remaining in the packet snapshot', async () => {
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    const send = jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send').mockResolvedValue({});
    const input = submission();
    const data = `data:image/png;base64,${Buffer.from('synthetic photo bytes').toString('base64')}`;
    for (const item of input.items) item.body.completionPhotos = [{ data, name: 'fixture.png', caption: 'Work area' }];
    try {
      const first = await saveVisitCompletionRecords(input);
      expect(first.status).toBe(202);
      const packet = await mockPg('visit_completion_packets').where({ id: first.body.packetId }).first();
      for (const item of packet.payload.items) {
        expect(item.body.completionPhotos).toEqual([{ name: 'fixture.png', caption: 'Work area' }]);
      }
      expect(JSON.stringify(packet.payload)).not.toContain(data);
      expect(input.items[0].body.completionPhotos[0].data).toBe(data);
      expect(await mockPg('service_photos').whereIn('service_record_id', first.body.items.map((item) => item.serviceRecordId)))
        .toHaveLength(2);
      expect(send).toHaveBeenCalledTimes(2);
      expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 202, body: { replayed: true } });
      expect(send).toHaveBeenCalledTimes(2);
      input.items[0].body.completionPhotos[0].data = `data:image/png;base64,${Buffer.from('changed photo').toString('base64')}`;
      expect(await saveVisitCompletionRecords(input)).toMatchObject({ status: 409, body: { code: 'visit_closeout_payload_mismatch' } });
    } finally {
      send.mockRestore();
      config.s3.bucket = priorBucket;
    }
  });

  test('a later photo upload failure rolls back the packet and cleans up earlier uploaded objects', async () => {
    const config = require('../config');
    const priorBucket = config.s3.bucket;
    config.s3.bucket = 'fixture-photo-bucket';
    const send = jest.spyOn(require('@aws-sdk/client-s3').S3Client.prototype, 'send')
      .mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Fixture upload unavailable')).mockResolvedValue({});
    const input = submission();
    for (const item of input.items) item.body.completionPhotos = [{
      data: `data:image/png;base64,${Buffer.from('synthetic photo').toString('base64')}`, name: 'fixture.png',
    }];
    try {
      await expect(saveVisitCompletionRecords(input))
        .rejects.toMatchObject({ code: 'visit_completion_photos_upload_failed', statusCode: 503 });
      expect(await mockPg('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      expect(await mockPg('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(await mockPg('service_completion_attempts').whereIn('service_id', fixture.serviceIds)).toHaveLength(0);
      const commands = send.mock.calls.map(([command]) => command);
      expect(commands.map((command) => command.constructor.name)).toEqual(['PutObjectCommand', 'PutObjectCommand', 'DeleteObjectCommand']);
      expect(commands[2].input.Key).toBe(commands[0].input.Key);
      expect((await mockPg('scheduled_services').whereIn('id', fixture.serviceIds)).every((row) => row.status === 'on_site')).toBe(true);
    } finally {
      send.mockRestore();
      config.s3.bucket = priorBucket;
    }
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
      const results = await Promise.allSettled([saveVisitCompletionRecords(input), saveVisitCompletionRecords(input)]);
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

  test.each(['profile', 'Auto Pay'])('a packet records every member after a recoverable %s read failure', async (helper) => {
    const matches = helper === 'profile'
      ? (query) => query.sql.includes('information_schema.tables') && query.bindings.includes('service_completion_profiles')
      : (query) => query.sql.includes('from "payment_methods"');
    await withReadFailure(matches, async (trx) => {
      await trx('customers').where({ id: fixture.customerId }).update({ autopay_enabled: true });
      const result = await saveVisitCompletionRecords(submission(), trx);
      expect(result).toMatchObject({ status: 202, body: { state: 'records_saved' } });
      expect(await trx('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      expect(await trx('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
    });
  });

  test.each(['recap only', 'not performed', 'unpriced', 'billable'])
  ('payer SQL failure preserves the %s completion contract', async (shape) => {
    const input = submission();
    if (shape === 'recap only') input.items[0].body.oneTimeRecapOnly = true;
    if (shape === 'not performed') input.items[0].body.visitOutcome = 'inspection_only';
    if (shape === 'unpriced') await mockPg('scheduled_services').where({ id: fixture.serviceIds[0] }).update({ estimated_price: 0 });
    await withReadFailure((query) => query.sql.includes('select "payer_id", "po_number"'), async (trx) => {
      const result = saveVisitCompletionRecords(input, trx);
      if (shape === 'billable') {
        await expect(result).rejects.toMatchObject({ code: '22012' });
        expect(await trx('service_records').where({ customer_id: fixture.customerId })).toHaveLength(0);
        expect(await trx('visit_completion_packets').where({ visit_id: fixture.visitId })).toHaveLength(0);
      } else {
        expect(await result).toMatchObject({ status: 202, body: { state: 'records_saved' } });
        expect(await trx('service_records').where({ customer_id: fixture.customerId })).toHaveLength(2);
      }
      expect(await trx('invoices').where({ customer_id: fixture.customerId })).toHaveLength(0);
      expect(chargeInvoiceWithSavedCard).not.toHaveBeenCalled();
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });
});
