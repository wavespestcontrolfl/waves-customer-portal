/** Recoverable helper reads against a migrated, private nonproduction database. */
jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { randomUUID } = require('crypto');
const { etDateString } = require('../utils/datetime-et');
const connection = process.env.COMPLETION_READ_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let mockPg;
let fixture;
jest.setTimeout(90000);

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

postgres('recoverable completion reads on PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    if (!/^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Use a verified, task-private QA database');
    mockPg = knex({ client: 'pg', connection, pool: { min: 0, max: 8 } });
    if (!(await mockPg.schema.hasTable('lawn_protocol_products'))) throw new Error('Run the repository migrations first');
  });
  afterAll(async () => { if (mockPg) await mockPg.destroy(); });
  beforeEach(async () => {
    jest.clearAllMocks();
    fixture = { customerId: randomUUID(), techId: randomUUID(), catalogId: randomUUID(), productId: randomUUID(),
      serviceId: randomUUID() };
    const date = etDateString();
    await mockPg('customers').insert({ id: fixture.customerId, first_name: 'Fixture', phone: '+12025550123',
      email: `${fixture.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false });
    await mockPg('technicians').insert({ id: fixture.techId, name: 'Fixture Technician', role: 'technician', active: true });
    await mockPg('services').insert({ id: fixture.catalogId, name: 'Fixture General Pest Control',
      service_key: `fixture_${fixture.catalogId}`, is_active: true });
    await mockPg('products_catalog').insert({ id: fixture.productId, name: 'Fixture Test Material',
      category: 'other', active: true, inventory_on_hand: 10, inventory_unit: 'oz' });
    await mockPg('scheduled_services').insert({
      id: fixture.serviceId, customer_id: fixture.customerId, technician_id: fixture.techId, service_id: fixture.catalogId,
      service_type: 'Fixture General Pest Control', scheduled_date: date,
      window_start: '09:00', window_end: '10:00', status: 'on_site',
      estimated_price: 120, estimated_duration_minutes: 60,
    });
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

  test.each(['table probe', 'identity reload', 'short name'])('profile %s failures retain the fallback on a transaction', async (read) => {
    const matches = {
      'table probe': (query) => query.sql.includes('information_schema.tables')
        && query.bindings.includes('service_completion_profiles'),
      'identity reload': (query) => query.sql.includes('select "service_key_snapshot", "is_recurring"'),
      'short name': (query) => query.sql.includes('lower(short_name)'),
    };
    const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
    await withReadFailure(matches[read], async (trx) => {
      const row = read === 'table probe' ? { service_id: fixture.catalogId } : {
        id: fixture.serviceId, service_type: 'Unmatched Fixture Service',
      };
      const result = await resolveCompletionProfileForScheduledService(row, trx);
      expect(result).toMatchObject({ synthesized: true, companions: [] });
    });
  });

  test.each([false, true])('Auto Pay query failures retain the failClosed=%p contract', async (failClosed) => {
    const { customerOnAutopay } = require('../services/autopay-eligibility');
    await withReadFailure((query) => query.sql.includes('from "payment_methods"'), async (trx) => {
      const result = customerOnAutopay({ id: fixture.customerId, autopay_enabled: true }, { db: trx, failClosed });
      if (failClosed) await expect(result).rejects.toMatchObject({ code: '22012' });
      else await expect(result).resolves.toBe(false);
    });
  });

  test('Auto Pay customer lookup failure retains the eligible card fallback', async () => {
    const { customerOnAutopay } = require('../services/autopay-eligibility');
    await withReadFailure((query) => query.sql.includes('select "ach_status", "autopay_payment_method_id"'), async (trx) => {
      await trx('payment_methods').insert({ customer_id: fixture.customerId, processor: 'stripe',
        method_type: 'card', stripe_payment_method_id: `pm_fixture_${randomUUID()}`, is_default: true,
        autopay_enabled: true, exp_month: '12', exp_year: String(new Date().getUTCFullYear() + 5) });
      expect(await customerOnAutopay({ id: fixture.customerId, autopay_enabled: true }, { db: trx })).toBe(true);
    });
  });

  test('Auto Pay pointer lookup failure retains its no-method fallback', async () => {
    const { customerOnAutopay } = require('../services/autopay-eligibility');
    await withReadFailure((query) => query.sql.includes('from "payment_methods"') && query.sql.includes('limit'), async (trx) => {
      expect(await customerOnAutopay({ id: fixture.customerId, autopay_enabled: true,
        autopay_payment_method_id: randomUUID(), ach_status: null }, { db: trx })).toBe(false);
    });
  });

  test.each([true, false])('trade-name lookup failure preserves the name-present=%p copy guard', async (hasName) => {
    const { buildReportTradeNameScreen } = require('../services/completion-recap');
    await withReadFailure((query) => query.sql.includes('from "products_catalog"'), async (trx) => {
      const result = buildReportTradeNameScreen({ db: trx, products: [{ productId: fixture.productId,
        ...(hasName ? { name: 'FixtureBrand Material' } : {}) }] });
      if (!hasName) await expect(result).rejects.toMatchObject({ code: '22012' });
      else {
        const screen = await result;
        expect(screen('FixtureBrand Material was applied.')).toBe(true);
        expect(screen('The scheduled work was completed.')).toBe(false);
      }
    });
  });

  test.each(['products_catalog', 'product_aliases', 'lawn_protocol_product_substitutions',
    'lawn_assessments', 'equipment_calibrations', 'property_nutrient_ledger', 'service_products',
    'lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_gates', 'lawn_protocol_products'])
  ('lawn plan continues after a recoverable %s query failure', async (table) => {
    const { buildPlanForService } = require('../services/waveguard-plan-engine');
    await withReadFailure((query) => query.sql.includes(`from "${table}"`), async (trx) => {
      // The active protocol/window are private to this rolled-back transaction,
      // so the nested-read cases do not depend on the migration seed's calendar.
      await trx('lawn_protocols').where({ status: 'active', grass_track: 'st_augustine', region: 'swfl' })
        .update({ status: 'draft' });
      const [protocol] = await trx('lawn_protocols').insert({ protocol_key: `fixture_${randomUUID()}`,
        version: 'test', name: 'Fixture protocol', status: 'active', effective_from: etDateString(),
        grass_track: 'st_augustine', region: 'swfl' }).returning('id');
      await trx('lawn_protocol_windows').insert({ lawn_protocol_id: protocol.id,
        month: Number(etDateString().slice(5, 7)), window_key: 'fixture', title: 'Fixture window', visit_type: 'fixture' });
      const result = await buildPlanForService(fixture.serviceId, { db: trx });
      expect(result).toMatchObject({ serviceId: fixture.serviceId });
      expect(result.propertyGate).toHaveProperty('annualN');
    });
  });

  test('a strict lawn lookup rethrows the original SQL error and leaves its caller usable', async () => {
    const { buildPlanForService } = require('../services/waveguard-plan-engine');
    await withReadFailure((query) => query.sql.includes('from "product_aliases"'), async (trx) => {
      await expect(buildPlanForService(fixture.serviceId, { db: trx, strict: true }))
        .rejects.toMatchObject({ code: '22012' });
    });
  });

  test.each(['products_catalog', 'service_products', 'customer_turf_profiles'])
  ('lawn approval fallbacks recover a failed %s read before later queries', async (table) => {
    const { evaluateWaveGuardManagerApprovals } = require('../services/waveguard-approval-engine');
    await withReadFailure((query) => query.sql.includes(`from "${table}"`), async (trx) => {
      await trx('products_catalog').where({ id: fixture.productId }).update({ moa_group: 'fixture' });
      const result = await evaluateWaveGuardManagerApprovals(trx, { customerId: fixture.customerId,
        service: {}, plan: {}, products: [{ productId: fixture.productId }], serviceDate: etDateString() });
      expect(result.blocks).toEqual([]);
    });
  });

});
