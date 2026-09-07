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
const { saveVisitCompletionPacket } = require('../services/visit-completion-packets');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');
const { stopBaseKey, dateOnly } = require('../services/visit-groups');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { chargeInvoiceWithSavedCard } = require('../services/stripe');
const InvoiceService = require('../services/invoice');
const { acquireScheduledInvoiceMintLock, mintScheduledServiceInvoiceWithDeposit } = require('../services/scheduled-invoice-mint');
const { createVisitCompletionInvoice } = require('../services/visit-completion-invoice');
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
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockPg.schema.hasTable('visit_completion_packets'))) throw new Error('Run the repository migrations first');
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => {
    jest.clearAllMocks();
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
    // Only the synthetic fixture's rows; the private database's seeded catalog
    // and migration data remain intact for later billing/UI verification.
    await mockPg('invoices').where({ customer_id: fixture.customerId }).del();
    if (fixture.estimateIds.length) {
      await mockPg('scheduled_services').whereIn('id', fixture.serviceIds).update({ source_estimate_id: null });
      await mockPg('estimate_deposits').whereIn('estimate_id', fixture.estimateIds).del();
      await mockPg('estimates').whereIn('id', fixture.estimateIds).del();
    }
    // Clear movements before cascading customer/service-product deletion.
    await mockPg('product_inventory_movements').where({ product_id: fixture.productId }).del();
    await mockPg('turf_height_readings').where({ customer_id: fixture.customerId }).del();
    await mockPg('activity_log').where({ customer_id: fixture.customerId }).del();
    await mockPg('customers').where({ id: fixture.customerId }).del();
    if (fixture.discountId) await mockPg('discounts').where({ id: fixture.discountId }).del();
    if (fixture.payerId) await mockPg('payers').where({ id: fixture.payerId }).del();
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
      if (['not performed', 'unpriced'].includes(shape)) {
        expect(invoices).toHaveLength(1);
        expect(Number(invoices[0].total)).toBe(120);
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
});
