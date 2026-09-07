/** Real Postgres identity/version proof. Synthetic customers are rolled back;
 * no model, message adapter, or external provider is called. */
jest.mock('../models/db', () => new Proxy((...args) => mockDb(...args), {
  get: (_, key) => typeof mockDb[key] === 'function' ? mockDb[key].bind(mockDb) : mockDb[key],
}));
const knex = require('knex');
const { randomUUID } = require('node:crypto');
const Context = require('../services/intelligence-bar/task-context');
const connection = process.env.IB_TEST_DATABASE_URL;
const suite = connection ? describe : describe.skip;
let mockDb, database, customerId;
jest.setTimeout(30000);

suite('IB target validation against isolated PostgreSQL', () => {
  beforeAll(() => {
    const parsed = new URL(connection);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 3 } });
  });
  beforeEach(async () => {
    mockDb = await database.transaction();
    customerId = randomUUID();
    await mockDb('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Targetfixture',
      phone: '+1555' + Date.now().toString().slice(-7), address_line1: '100 Test Street',
      updated_at: '2026-09-01T12:00:00.123456Z' });
  });
  afterEach(async () => { await mockDb?.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  test('fresh page, explicit selection, full-name and single-name lookups preserve exact database versions', async () => {
    const { version } = await mockDb('customers').where('id', customerId).first(mockDb.raw('updated_at::text AS version'));
    expect(version).toContain('.123456');
    const requests = [
      { prompt: 'Update this customer', pageData: { customer_id: customerId } },
      { prompt: 'Update the customer', pageData: {}, selectedTarget: { customer_id: customerId } },
      { prompt: 'Send to Synthetic Targetfixture using this customer', pageData: {} },
      { prompt: 'Send a message to Targetfixture using this customer', pageData: {} },
    ];
    for (const request of requests) {
      const result = await Context.resolve(request);
      expect(result.target).toMatchObject({ customer_id: customerId, version });
      expect(await Context.validateRecordTarget({ customer_id: customerId.toUpperCase() }, result)).toBeNull();
    }
  });

  test('an unresolved prepositional name refuses the actual viewed customer after lookup', async () => {
    for (const prompt of ['Send to Targtefixture using this customer', 'Send an SMS to Targtefixture using this customer', 'Update customer Targtefixture using this customer', ...['Reschedule', 'Move', 'Call', 'Remind', 'Cancel', 'Book'].map(verb => `${verb} Targtefixture using this customer`)]) {
      const task = await Context.resolve({ prompt, pageData: { customer_id: customerId } });
      expect(task.page.customer.customer_id).toBe(customerId);
      expect(task.targets).toEqual([]);
      expect((await Context.validateRecordTarget({ customer_id: customerId }, task, { toolName: 'send_sms' })).code).toBe('target_clarification_required');
    }
  });

  test('this/that/selected property pins the persisted row, not another property of the same customer', async () => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('customer_properties').insert(ids.map((id, i) => ({ id, customer_id: customerId,
      label: `Synthetic ${i}`, address_line1: `${100 + i} Test Street` })));
    for (const word of ['this', 'that', 'selected']) {
      const task = await Context.resolve({ prompt: `Update ${word} property label`, pageData: { property_id: ids[0] } });
      expect(await Context.validateRecordTarget({ property_id: ids[0] }, task)).toBeNull();
      expect(await Context.validateRecordTarget({ customer_id: customerId.toUpperCase(), property_id: ids[0].toUpperCase() }, task)).toBeNull();
      expect((await Context.validateRecordTarget({ property_id: ids[1] }, task)).code).toBe('target_clarification_required');
    }
    const missing = await Context.resolve({ prompt: 'Update this property label', pageData: { customer_id: customerId } });
    expect((await Context.validateRecordTarget({ property_id: ids[1] }, missing)).code).toBe('target_clarification_required');
    const explicit = await Context.resolve({ prompt: 'Update Synthetic Targetfixture property label', pageData: { property_id: ids[0] } });
    expect(await Context.validateRecordTarget({ property_id: ids[1] }, explicit)).toBeNull();
    const uppercase = await Context.resolve({ prompt: 'Update this property label', pageData: { property_id: ids[0].toUpperCase() } });
    expect(await Context.validateRecordTarget({ property_id: ids[0] }, uppercase)).toBeNull();
  });

  test('SMS name-only proposals refuse while canonical recipients use fresh phone data', async () => {
    const task = await Context.resolve({ prompt: 'Text this customer', pageData: { customer_id: customerId } });
    for (const customer_name of ['Synthetic Targetfixture', 'Synthetic Otherfixture', 'Targtefixture']) {
      expect((await Context.validateRecordTarget({ customer_name }, task, { toolName: 'send_sms' })).code).toBe('target_clarification_required');
    }
    const customer = await Context.customerById(customerId);
    const params = { customer_id: customerId, phone: customer.phone, message: 'Synthetic confirmation only' };
    expect(await Context.validateRecordTarget(params, task, { toolName: 'send_sms' })).toBeNull();
    await mockDb('customers').where('id', customerId).update({ phone: '+15550109876', updated_at: mockDb.fn.now() });
    expect((await Context.validateRecordTarget(params, task, { toolName: 'send_sms' })).code).toBe('target_relationship_mismatch');
  });

  test('a viewed call resolves its owner and cannot be swapped for a sibling call or body reference', async () => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('call_log').insert(ids.map(id => ({ id, customer_id: customerId, twilio_call_sid: `fixture-${id}`,
      direction: 'inbound', from_phone: '+15550101234', to_phone: '+15550104321' })));
    for (const word of ['this', 'that', 'selected']) {
      const task = await Context.resolve({ prompt: `Update ${word} call`, pageData: { call_id: ids[0] } });
      expect(task.target.customer_id).toBe(customerId);
      expect(await Context.validateRecordTarget({ call_id: ids[0] }, task)).toBeNull();
      expect((await Context.validateRecordTarget({ call_id: ids[1] }, task)).code).toBe('target_clarification_required');
    }
    const content = await Context.resolve({ prompt: 'Add a note saying this call needs attention', pageData: { call_id: ids[0] } });
    expect(content.targets).toEqual([]);
    expect((await Context.validateRecordTarget({ call_id: ids[0] }, content)).code).toBe('target_clarification_required');
    await mockDb('customers').where('id', customerId).update({ deleted_at: mockDb.fn.now() });
    expect((await Context.resolve({ prompt: 'Update this call', pageData: { call_id: ids[0] } })).code).toBe('record_unavailable');
  });

  test.each([['lead', 'leads'], ['estimate', 'estimates']])('a fresh duplicate unlinked %s invalidates name authority for either model ID', async (noun, table) => {
    const ids = [randomUUID(), randomUUID()];
    const name = table === 'leads' ? { first_name: 'Synthetic', last_name: 'Duplicatefixture' }
      : { customer_name: 'Synthetic Duplicatefixture' };
    await mockDb(table).insert({ id: ids[0], ...name, customer_id: null });
    const task = await Context.resolve({ prompt: 'Update Synthetic Duplicatefixture', pageData: {} });
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: ids[0] }, task)).toBeNull();
    await mockDb(table).insert({ id: ids[1], ...name, customer_id: null });
    // Validation must re-read after resolution instead of retaining a unique-name claim.
    for (const id of ids) expect((await Context.validateRecordTarget({ [`${noun}_id`]: id }, task)).code).toBe('target_clarification_required');
    const selected = await Context.resolve({ prompt: `Update this ${noun}`, pageData: { [`${noun}_id`]: ids[0] } });
    expect(await Context.validateRecordTarget({ [`${noun}_id`]: ids[0] }, selected)).toBeNull();
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: ids[1] }, selected)).code).toBe('target_clarification_required');
    if (table === 'leads') {
      await mockDb(table).where('id', ids[1]).update({ deleted_at: mockDb.fn.now() });
      expect(await Context.validateRecordTarget({ lead_id: ids[0] }, task)).toBeNull();
      await mockDb(table).where('id', ids[1]).update({ deleted_at: null, customer_id: customerId });
    } else await mockDb(table).where('id', ids[1]).update({ status: 'accepted', customer_id: customerId });
    expect((await Context.validateRecordTarget({ [`${noun}_id`]: ids[0] }, task)).code).toBe('target_clarification_required');
  });

  test.each([
    ["Synthetic O’Neill", "SYNTHETIC O'Neill"],
    ['Synthetic   Hyphen-Fixture', 'synthetic Hyphen-Fixture'],
    ['Synthetic, Punctuation', 'Synthetic Punctuation'],
    ["Synthetic Owner's", 'Synthetic Owner'],
    ['Synthetic José', 'synthetic José'],
    ['Synthetic\u00a0Spacefixture', 'Synthetic Spacefixture'],
  ])('equivalent normalized unlinked names cannot hide a duplicate: %s', async (first, second) => {
    const ids = [randomUUID(), randomUUID()];
    await mockDb('estimates').insert({ id: ids[0], customer_name: first });
    const task = await Context.resolve({ prompt: `Update ${first}`, pageData: {} });
    expect(await Context.validateRecordTarget({ estimate_id: ids[0] }, task)).toBeNull();
    await mockDb('estimates').insert({ id: ids[1], customer_name: second });
    for (const id of ids) expect((await Context.validateRecordTarget({ estimate_id: id }, task)).code).toBe('target_clarification_required');
  });

});
