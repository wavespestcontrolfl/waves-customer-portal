/** Synthetic Postgres acceptance: scripted model -> real auth/route/domain ->
 * persisted property/audit/receipt. Never uses production or live providers. */
const crypto = require('crypto');
const mockModel = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
function propertyDbFixture() {
  let db, server, origin, token, actor, customerA, customerB, nameA;
  const sessionId = crypto.randomUUID();
  const originalEnv = { ...process.env };
  const call = (name, input, id) => ({ content: [{ type: 'tool_use', name, input, id }], usage: {} });
  async function api(path, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${origin}${path}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  async function propose(name, input, prompt) {
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(call('discover_capabilities', { query: name.replaceAll('_', ' ') }, 'discover'))
      .mockResolvedValueOnce(call(name, input, 'property'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'The property change is ready for confirmation.' }], usage: {} });
    return api('/api/admin/intelligence-bar/query', { prompt: `${prompt} for ${nameA}`, context: 'estimates', session_id: sessionId,
      request_key: crypto.randomUUID(), pageData: { route: '/admin/estimates', customerId: customerB } });
  }
  async function confirm(proposed) {
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    return api('/api/admin/intelligence-bar/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
  }
  const address = (number, label = null) => ({ address_line1: `${number} Example Grove`, address_line2: null,
    city: 'Sarasota', state: 'FL', zip: '34201', occupancy_type: 'unknown', label });
  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    Object.assign(process.env, { DATABASE_URL: databaseUrl, NODE_ENV: 'test', JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      ANTHROPIC_API_KEY: 'scripted-model-only', GATE_IB_PLATFORM: 'true', GATE_IB_THREADS: 'false', GATE_IB_WRITES_DISABLED: 'false' });
    db = require('../../models/db');
    if (!await db.schema.hasColumn('invoices', 'customer_address_snapshot')) throw new Error('Apply the invoice address migration to the isolated database first');
    actor = crypto.randomUUID(); customerA = crypto.randomUUID(); customerB = crypto.randomUUID();
    nameA = `Fixture Alder${customerA.slice(0, 8)}`;
    await db('technicians').insert({ id: actor, name: 'Synthetic property operator', role: 'admin', active: true, auth_token_version: 1 });
    await db('customers').insert([
      { id: customerA, first_name: 'Fixture', last_name: `Alder${customerA.slice(0, 8)}`, ...address(100) },
      { id: customerB, first_name: 'Fixture', last_name: `Birch${customerB.slice(0, 8)}`, ...address(200) },
    ].map(({ label, occupancy_type, ...customer }) => ({ ...customer, phone: `+15550${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}` })));
    await require('../../services/customer-properties').ensurePrimaryProperty(customerA);
    await require('../../services/customer-properties').ensurePrimaryProperty(customerB);
    token = require('jsonwebtoken').sign({ type: 'access', tokenVersion: 1, technicianId: actor }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const express = require('express'); const app = express(); app.use(express.json());
    app.use('/api/admin/intelligence-bar', require('../../routes/admin-intelligence-bar'));
    app.use('/api/admin/customers', require('../../routes/admin-customers'));
    app.use('/api/admin/triage', require('../../routes/admin-triage'));
    app.use('/api/receipt', require('../../routes/receipt-v2'));
    app.use(require('../../middleware/errors').errorHandler);
    server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.destroy();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });
  afterEach(() => { process.env.GATE_IB_PLATFORM = 'true'; delete process.env.GATE_CALL_PROPERTY_ROLE; });

  return { api, propose, confirm, address, call, mockModel, sessionId,
    get db() { return db; }, get actor() { return actor; }, get customerA() { return customerA; },
    get customerB() { return customerB; }, get nameA() { return nameA; } };
}
module.exports = { databaseUrl, propertyDbFixture };
