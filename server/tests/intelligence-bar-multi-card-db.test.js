/** GATE_IB_MULTI_CARD against real Postgres + real bearer auth + the real card
 * store. Only the model adapter is scripted. Run with IB_TEST_DATABASE_URL
 * naming an isolated waves_ib_platform_* database (CI: waves_test).
 */
const crypto = require('crypto');
const mockModel = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ ...jest.requireActual('../services/email/gmail-client'), sendMessage: jest.fn() }));

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('several confirm cards in one answer (GATE_IB_MULTI_CARD, scripted model)', () => {
  let db, server, origin, ownerToken, owner, suiteStartedAt;
  const customers = [];
  const originalEnv = { ...process.env };
  const tools = (name, input, id) => ({ content: [{ type: 'tool_use', name, input, id }], usage: {} });
  const answer = text => ({ content: [{ type: 'text', text }], usage: {} });
  const edit = (customer, notes, id = `n-${customer.slice(0, 4)}`) => ({ type: 'tool_use', name: 'update_customer', input: { customer_id: customer, updates: { notes } }, id });
  const request = (prompt = 'Update the notes on these accounts') => ({ prompt, context: 'customers', session_id: crypto.randomUUID(), request_key: crypto.randomUUID(), pageData: { route: '/admin/customers' } });
  async function api(path, body) {
    const response = await fetch(`${origin}/api/admin/intelligence-bar${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  // One model message holding every call, then the closing answer.
  function script(...uses) {
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'update customer send sms bulk update' }, 'discover'))
      .mockResolvedValueOnce({ content: uses, usage: {} })
      .mockResolvedValueOnce(answer('Cards are awaiting confirmation.'));
  }
  // What the model was told about the calls of its second message.
  const toolResults = () => JSON.stringify(mockModel.mock.calls[2][0].messages.at(-1));
  const notesOf = async id => (await db('customers').where('id', id).first('crm_notes')).crm_notes;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
    process.env.ANTHROPIC_API_KEY = 'scripted-model-only';
    process.env.GATE_IB_PLATFORM = 'true';
    process.env.GATE_IB_THREADS = 'false';
    process.env.GATE_IB_WRITES_DISABLED = 'false';
    process.env.GATE_IB_OWNER_DIRECT = 'true';
    delete process.env.GATE_IB_MULTI_CARD;
    db = require('../models/db');
    suiteStartedAt = (await db.raw('SELECT now() AS t')).rows[0].t;
    if (!(await db.schema.hasTable('ib_tasks'))) throw new Error('Apply the IB task migration to the isolated database first');
    owner = crypto.randomUUID();
    const ownerEmail = `owner-${owner.slice(0, 8)}@synthetic.test`;
    process.env.IB_FULL_ACCESS_EMAILS = ownerEmail;
    await db('technicians').insert({ id: owner, name: 'Synthetic IB owner', email: ownerEmail, role: 'admin', active: true, auth_token_version: 1 });
    for (let i = 0; i < 6; i++) {
      const id = crypto.randomUUID();
      customers.push(id);
      await db('customers').insert({ id, first_name: 'MultiCard', last_name: `Fixture${i}${id.slice(0, 6)}`,
        phone: `+155503${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`, address_line1: `${300 + i} Example Street`, city: 'Bradenton', state: 'FL', zip: '34202',
        crm_notes: `Original note ${i}` });
    }
    ownerToken = require('jsonwebtoken').sign({ type: 'access', tokenVersion: 1, technicianId: owner }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api/admin/intelligence-bar', require('../routes/admin-intelligence-bar'));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  beforeEach(async () => {
    mockModel.mockReset();
    delete process.env.GATE_IB_MULTI_CARD;
    for (const [i, id] of customers.entries()) await db('customers').where('id', id).update({ crm_notes: `Original note ${i}` });
  });
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db && suiteStartedAt) {
      await db('notifications').where('category', 'agents').where('created_at', '>=', suiteStartedAt).whereRaw("metadata->>'gapId' IS NOT NULL").del();
    }
    if (db) await db.destroy();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  test('gate off: the second card in a request is refused with dependency_unresolved, as before', async () => {
    script(edit(customers[0], 'First'), edit(customers[1], 'Second'));
    const result = await api('/query', request());
    expect(result.status).toBe(200);
    expect(result.body.pendingActions).toHaveLength(1);
    expect(toolResults()).toContain('dependency_unresolved');
    expect(await db('ib_pending_actions').where('task_id', result.body.taskId).count('* as count').first()).toEqual({ count: '1' });
  }, 30000);

  test('gate on: two independent cards are minted in one answer, each with its own contract and expiry', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    script(edit(customers[0], 'First'), edit(customers[1], 'Second'));
    const result = await api('/query', request());
    expect(result.status).toBe(200);
    expect(result.body.pendingActions).toHaveLength(2);
    const [first, second] = result.body.pendingActions;
    expect(first.id).not.toBe(second.id);
    expect(first.contract_hash).not.toBe(second.contract_hash);
    expect(result.body.taskState).toBe('awaiting_approval');
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain(first.id);
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain(second.id);
    expect(JSON.stringify(mockModel.mock.calls[1][0].system)).toContain('SEVERAL CARDS IN ONE ANSWER');
    const rows = await db('ib_pending_actions').where('task_id', result.body.taskId).orderBy('created_at');
    expect(rows.map(row => row.status)).toEqual(['pending', 'pending']);
    // Both cards are on the saved task too, for a reload or another tab.
    const snapshot = await api(`/tasks/${result.body.taskId}?session_id=${rows[0] && (await db('ib_tasks').where('id', result.body.taskId).first('session_id')).session_id}`);
    expect(snapshot.body.pendingActions).toHaveLength(2);
    expect(snapshot.body.taskState).toBe('awaiting_approval');
    // Nothing is written until a Confirm.
    expect(await notesOf(customers[0])).toBe('Original note 0');
    expect(await notesOf(customers[1])).toBe('Original note 1');
  }, 30000);

  test('gate off: the prompt has no multi-card section', async () => {
    script(edit(customers[0], 'First'));
    await api('/query', request());
    expect(JSON.stringify(mockModel.mock.calls[1][0].system)).not.toContain('SEVERAL CARDS IN ONE ANSWER');
  }, 30000);

  test('gate on: confirming one card leaves the other pending and valid, and each saves only its own customer', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    script(edit(customers[0], 'First saved'), edit(customers[1], 'Second saved'));
    const result = await api('/query', request());
    const [first, second] = result.body.pendingActions;
    const confirmed = await api('/confirm-action', { pending_action_id: first.id, contract_hash: first.contract_hash });
    expect(confirmed.body).toMatchObject({ success: true, outcome: 'completed' });
    expect(await notesOf(customers[0])).toBe('First saved');
    expect(await notesOf(customers[1])).toBe('Original note 1');
    const stillPending = await db('ib_pending_actions').where('id', second.id).first();
    expect(stillPending.status).toBe('pending');
    expect(new Date(stillPending.expires_at).getTime()).toBeGreaterThan(Date.now());
    // The wrong hash for the other card is still refused: each card keeps its own contract.
    const crossed = await api('/confirm-action', { pending_action_id: second.id, contract_hash: first.contract_hash });
    expect(crossed.status).toBe(409);
    expect(await notesOf(customers[1])).toBe('Original note 1');
    const second_ = await api('/confirm-action', { pending_action_id: second.id, contract_hash: second.contract_hash });
    expect(second_.body).toMatchObject({ success: true, outcome: 'completed' });
    expect(await notesOf(customers[1])).toBe('Second saved');
    expect(await notesOf(customers[0])).toBe('First saved');
  }, 30000);

  test('gate on: a second card keeps its own frozen precondition; drift on one customer refuses only that card', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    script(edit(customers[0], 'Fresh A'), edit(customers[1], 'Fresh B'));
    const result = await api('/query', request());
    const [first, second] = result.body.pendingActions;
    await db('customers').where('id', customers[0]).update({ crm_notes: 'Edited elsewhere', updated_at: db.fn.now() });
    const stale = await api('/confirm-action', { pending_action_id: first.id, contract_hash: first.contract_hash });
    expect(stale.status).toBe(409);
    expect(await notesOf(customers[0])).toBe('Edited elsewhere');
    const fine = await api('/confirm-action', { pending_action_id: second.id, contract_hash: second.contract_hash });
    expect(fine.body).toMatchObject({ success: true, outcome: 'completed' });
    expect(await notesOf(customers[1])).toBe('Fresh B');
  }, 30000);

  test('gate on: a second proposal for the same customer is blocked, through any tool', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    script(edit(customers[0], 'First'), { type: 'tool_use', name: 'send_sms', input: { customer_id: customers[0], message: 'Your note changed.' }, id: 'sms' },
      edit(customers[0], 'Again', 'again'));
    const result = await api('/query', request());
    expect(result.body.pendingActions).toHaveLength(1);
    expect(toolResults().match(/same_record_card_open/g)).toHaveLength(2);
    expect(await db('ib_pending_actions').where('task_id', result.body.taskId).count('* as count').first()).toEqual({ count: '1' });
  }, 30000);

  test('gate on: a proposal that uses an earlier card\'s record id stays dependency_unresolved', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    script(edit(customers[0], 'First'), edit(customers[1], `Same as ${customers[0]}`));
    const result = await api('/query', request());
    expect(result.body.pendingActions).toHaveLength(1);
    expect(toolResults()).toContain('dependency_unresolved');
  }, 30000);

  test('gate on: closed actions never join a set, before or after an open card', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    // A price/rate change after an open card is refused...
    script(edit(customers[0], 'First'), { type: 'tool_use', name: 'update_customer', input: { customer_id: customers[1], updates: { monthly_rate: 99 } }, id: 'rate' });
    const priced = await api('/query', request());
    expect(priced.body.pendingActions).toHaveLength(1);
    expect(toolResults()).toContain('dependency_unresolved');
    // ...and so is an open edit after a closed (bulk) card.
    mockModel.mockReset();
    script({ type: 'tool_use', name: 'bulk_update_customers', input: { customer_ids: [customers[2]], updates: { lead_source: 'referral' } }, id: 'bulk' },
      edit(customers[3], 'After bulk'));
    const bulk = await api('/query', request());
    expect(bulk.body.pendingActions).toHaveLength(1);
    expect(bulk.body.pendingActions[0].tool).toBe('bulk_update_customers');
    expect(toolResults()).toContain('dependency_unresolved');
    expect(await notesOf(customers[3])).toBe('Original note 3');
  }, 30000);

  test('gate on: at most five cards in one request', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    script(...customers.map((id, i) => edit(id, `Note ${i}`)));
    const result = await api('/query', request());
    expect(result.body.pendingActions).toHaveLength(5);
    expect(toolResults()).toContain('card_limit_reached');
    expect(await db('ib_pending_actions').where('task_id', result.body.taskId).count('* as count').first()).toEqual({ count: '5' });
  }, 30000);

  test('gate on: cards from separate calls in one request join the same task, and a later request does not inherit the room', async () => {
    process.env.GATE_IB_MULTI_CARD = 'true';
    // Two model rounds: one card each.
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'update customer' }, 'discover'))
      .mockResolvedValueOnce({ content: [edit(customers[0], 'Round one')], usage: {} })
      .mockResolvedValueOnce({ content: [edit(customers[1], 'Round two')], usage: {} })
      .mockResolvedValueOnce(answer('Two cards.'));
    const result = await api('/query', request());
    expect(result.body.pendingActions).toHaveLength(2);
    // A fresh request in a new session starts with its own empty set of cards.
    mockModel.mockReset();
    script(edit(customers[2], 'Next'));
    const next = await api('/query', request());
    expect(next.body.pendingActions).toHaveLength(1);
  }, 30000);
});
