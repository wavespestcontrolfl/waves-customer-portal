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

suite('IB target resolution against isolated PostgreSQL', () => {
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
    }
  });

  test('an unresolved prepositional name refuses the actual viewed customer after lookup', async () => {
    for (const prompt of ['Send to Targtefixture using this customer', 'Send an SMS to Targtefixture using this customer', 'Update customer Targtefixture using this customer']) {
      const task = await Context.resolve({ prompt, pageData: { customer_id: customerId } });
      expect(task.page.customer.customer_id).toBe(customerId);
      expect(task.targets).toEqual([]);
      expect((await Context.validateRecordTarget({ customer_id: customerId }, task, { toolName: 'send_sms' })).code).toBe('target_clarification_required');
    }
  });
});
