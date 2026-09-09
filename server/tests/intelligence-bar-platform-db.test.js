/** Real Postgres + real bearer auth + real domain executors. Only the model
 * adapter is scripted and outbound Gmail is controlled. Run with IB_TEST_DATABASE_URL naming an isolated
 * waves_ib_platform_* database; no production/provider credentials are used.
 */
const crypto = require('crypto');
const mockModel = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ ...jest.requireActual('../services/email/gmail-client'), sendMessage: jest.fn() }));

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('platform IB outcomes against isolated Postgres (scripted model)', () => {
  let db, server, origin, token, actor, customerA, customerB, nameA;
  const sessionId = crypto.randomUUID();
  const originalEnv = { ...process.env };
  const tools = (name, input, id) => ({ content: [{ type: 'tool_use', name, input, id }], usage: {} });
  const answer = text => ({ content: [{ type: 'text', text }], usage: {} });
  const request = (prompt, extra = {}) => ({ prompt, context: 'estimates', session_id: sessionId,
    request_key: crypto.randomUUID(), pageData: { route: '/admin/estimates', customerId: customerB }, ...extra });
  async function api(path, body, auth = token) {
    const response = await fetch(`${origin}/api/admin/intelligence-bar${path}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  function proposeNote(customerId, note) {
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'update customer fields' }, 'discover'))
      .mockResolvedValueOnce(tools('update_customer', { customer_id: customerId, updates: { notes: note } }, 'note'))
      .mockResolvedValueOnce(answer('The note is awaiting confirmation.'));
  }
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
    process.env.GATE_IB_TOOL_ACTIVITY = 'true';
    process.env.GATE_IB_WRITES_DISABLED = 'false';
    process.env.GATE_EDIT_APPT_ADDRESS = 'true';
    db = require('../models/db');
    if (!(await db.schema.hasTable('ib_tasks'))) throw new Error('Apply the IB task migration to the isolated database first');
    actor = crypto.randomUUID(); customerA = crypto.randomUUID(); customerB = crypto.randomUUID();
    nameA = `Fixture Alder${customerA.slice(0, 8)}`;
    await db('technicians').insert({ id: actor, name: 'Synthetic IB operator', role: 'admin', active: true, auth_token_version: 1 });
    await db('customers').insert([
      { id: customerA, first_name: 'Fixture', last_name: `Alder${customerA.slice(0, 8)}`, phone: `+155501${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`, address_line1: '100 Example Grove', city: 'Sarasota' },
      { id: customerB, first_name: 'Fixture', last_name: `Birch${customerB.slice(0, 8)}`, phone: `+155502${Math.floor(Math.random() * 100000).toString().padStart(5, '0')}`, address_line1: '200 Example Grove', city: 'Sarasota' },
    ]);
    token = require('jsonwebtoken').sign({ type: 'access', tokenVersion: 1, technicianId: actor }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const express = require('express');
    const app = express(); app.use(express.json());
    app.use('/api/admin/intelligence-bar', require('../routes/admin-intelligence-bar'));
    app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
    server = await new Promise(resolve => { const running = app.listen(0, '127.0.0.1', () => resolve(running)); });
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  beforeEach(() => mockModel.mockReset());
  afterAll(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (db) await db.destroy();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  test('explicit customer A overrides viewed B; confirmation persists only A and read-back receipt matches', async () => {
    proposeNote(customerA, 'Synthetic targeting regression');
    const input = request(`Add a note for ${nameA}: Synthetic targeting regression`);
    const proposed = await api('/query', input);
    expect(proposed.status).toBe(200);
    expect(proposed.body.taskTarget.customer_id).toBe(customerA);
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain(card.id);
    const before = await db('customers').where('id', customerA).first('crm_notes');
    expect(before.crm_notes).not.toBe('Synthetic targeting regression');
    const confirmed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    expect(confirmed.body).toMatchObject({ success: true, outcome: 'completed' });
    expect((await db('customers').where('id', customerA).first('crm_notes')).crm_notes).toBe('Synthetic targeting regression');
    expect((await db('customers').where('id', customerB).first('crm_notes')).crm_notes).toBeNull();
    const receipt = await api(`/actions/${card.id}`);
    expect(receipt.body).toMatchObject({ id: card.id, success: true, outcome: 'completed' });
    const resumed = await api(`/tasks/${proposed.body.taskId}?session_id=${sessionId}`);
    expect(resumed.body.receipts[0].outcome).toBe('completed');
    expect(resumed.body.pendingActions).toHaveLength(0);
    expect(resumed.body.taskState).toBe('ready_to_continue');
    const listed = await api(`/tasks?session_id=${sessionId}`);
    expect(listed.body.tasks.find(task => task.id === proposed.body.taskId).state).toBe('ready_to_continue');
    const replay = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    expect(replay.status).toBe(409);
    const repeatedQuery = await api('/query', input);
    expect(repeatedQuery.body.taskId).toBe(proposed.body.taskId);
    expect(mockModel).toHaveBeenCalledTimes(3);
  }, 30000);

  test('model-tampered customer ID cannot propose a write to B for a request naming A', async () => {
    proposeNote(customerB, 'Must never be saved');
    const result = await api('/query', request(`Add a note for ${nameA}: Must never be saved`));
    expect(result.status).toBe(200);
    expect(result.body.pendingActions).toHaveLength(0);
    const inputs = JSON.stringify(mockModel.mock.calls);
    expect(inputs).toContain('target_clarification_required');
    expect((await db('customers').where('id', customerB).first('crm_notes')).crm_notes).toBeNull();
  }, 30000);

  test('record reads honor the resolved customer while broad lookup remains available', async () => {
    await db('customers').where('id', customerA).update({ crm_notes: 'Synthetic A read fact' });
    await db('customers').where('id', customerB).update({ crm_notes: 'Synthetic wrong-record private fact' });
    mockModel.mockResolvedValueOnce({ content: [
      { type: 'tool_use', name: 'get_customer_detail', input: { customer_id: customerB }, id: 'wrong-read' },
      { type: 'tool_use', name: 'get_customer_detail', input: { customer_id: customerA }, id: 'correct-read' },
      { type: 'tool_use', name: 'query_customers', input: { search: nameA }, id: 'lookup' },
    ], usage: {} }).mockResolvedValueOnce(answer('The selected customer details are loaded.'));
    const result = await api('/query', request(`Get customer details for ${nameA}`));
    expect(result.status).toBe(200);
    expect(result.body.taskTarget.customer_id).toBe(customerA);
    // A sibling read in the same round never answers another call's clarification
    // (r14): the wrong read stays open until a later-round corrected retry succeeds.
    expect(result.body.taskState).toBe('needs_information');
    const round = mockModel.mock.calls[1][0].messages.at(-1).content;
    expect(round.find(block => block.tool_use_id === 'wrong-read').content).toContain('target_clarification_required');
    expect(round.find(block => block.tool_use_id === 'correct-read').content).toContain('Synthetic A read fact');
    expect(round.find(block => block.tool_use_id === 'lookup').content).toContain(customerA);
    expect(JSON.stringify(round)).not.toContain('Synthetic wrong-record private fact');
    await db('customers').whereIn('id', [customerA, customerB]).update({ crm_notes: null });
  }, 30000);

  test('lead searches inside a customer-scoped task never return another customer or an unlinked lead', async () => {
    const own = crypto.randomUUID(), foreign = crypto.randomUUID(), unlinked = crypto.randomUUID();
    const stale = new Date(Date.now() - 72 * 3600000);
    await db('leads').insert([
      { id: own, customer_id: customerA, first_name: 'Synthetic', last_name: 'Ownlead', status: 'new', first_contact_at: stale, updated_at: stale },
      { id: foreign, customer_id: customerB, first_name: 'Synthetic', last_name: 'Foreignlead', status: 'new', first_contact_at: stale, updated_at: stale },
      { id: unlinked, customer_id: null, first_name: 'Synthetic', last_name: 'Unlinkedlead', status: 'new', first_contact_at: stale, updated_at: stale },
    ]);
    mockModel.mockResolvedValueOnce({ content: [
      { type: 'tool_use', name: 'discover_capabilities', input: { query: 'query leads' }, id: 'discover-leads' },
      { type: 'tool_use', name: 'discover_capabilities', input: { query: 'stale leads' }, id: 'discover-stale' },
    ], usage: {} }).mockResolvedValueOnce({ content: [
      { type: 'tool_use', name: 'query_leads', input: { search: 'Synthetic' }, id: 'leads' },
      { type: 'tool_use', name: 'get_stale_leads', input: {}, id: 'stale' },
      { type: 'tool_use', name: 'query_customers', input: { search: 'Fixture' }, id: 'customers' },
    ], usage: {} }).mockResolvedValueOnce(answer('The customer leads are loaded.'));
    const result = await api('/query', request(`Show ${nameA}'s leads`));
    expect(result.status).toBe(200);
    expect(result.body.taskTarget.customer_id).toBe(customerA);
    const results = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    for (const id of ['leads', 'stale']) {
      const content = results.find(block => block.type === 'tool_result' && block.tool_use_id === id).content;
      expect(content).toContain('Ownlead');
      expect(content).not.toContain('Foreignlead');
      expect(content).not.toContain('Unlinkedlead');
    }
    const customers = results.find(block => block.type === 'tool_result' && block.tool_use_id === 'customers').content;
    expect(customers).toContain(customerA);
    expect(customers).not.toContain(customerB);
  }, 30000);

  test('a clarification stays open past an unrelated successful read, and a refused preflight does not close the write frontier', async () => {
    const unlinkedCall = crypto.randomUUID();
    await db('call_log').insert({ id: unlinkedCall, customer_id: null, transcription: 'Foreign private parallel evidence', status: 'completed' });
    mockModel.mockResolvedValueOnce({ content: [
      { type: 'tool_use', name: 'get_call_log', input: { call_id: unlinkedCall }, id: 'unlinked-call' },
      { type: 'tool_use', name: 'query_customers', input: { search: nameA }, id: 'lookup' },
    ], usage: {} }).mockResolvedValueOnce(answer('One lookup succeeded.'));
    const parallel = await api('/query', request(`Read the call and details for ${nameA}`));
    expect(parallel.body.taskState).toBe('needs_information');
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain('Foreign private parallel evidence');
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'update customer fields' }, 'discover'))
      .mockResolvedValueOnce(tools('update_customer', { customer_id: customerA, updates: { not_a_customer_field: 'x' } }, 'bad'))
      .mockResolvedValueOnce(tools('update_customer', { customer_id: customerA, updates: { notes: 'Corrected after preflight' } }, 'good'))
      .mockResolvedValueOnce(answer('The corrected note awaits confirmation.'));
    const corrected = await api('/query', request(`Add a note for ${nameA}: Corrected after preflight`));
    const rounds = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    expect(JSON.parse(rounds.find(block => block.type === 'tool_result' && block.tool_use_id === 'bad').content)).toMatchObject({ error: expect.any(String) });
    expect(corrected.body.pendingActions).toHaveLength(1);
    expect(corrected.body.taskState).toBe('awaiting_approval');
    await api('/cancel-action', { pending_action_id: corrected.body.pendingActions[0].id });
  }, 30000);

  test('schedule reads inside a customer-scoped task never list another customer\'s appointment', async () => {
    const today = require('../utils/datetime-et').etDateString();
    const visitA = crypto.randomUUID(), visitB = crypto.randomUUID();
    await db('scheduled_services').insert([
      { id: visitA, customer_id: customerA, scheduled_date: today, service_type: 'Synthetic own visit', status: 'pending', notes: 'Own schedule note' },
      { id: visitB, customer_id: customerB, scheduled_date: today, service_type: 'Synthetic foreign visit', status: 'pending', notes: 'Foreign private schedule note' },
    ]);
    mockModel.mockResolvedValueOnce(tools('get_schedule_view', {}, 'schedule'))
      .mockResolvedValueOnce(answer('The schedule is loaded.'));
    const response = await api('/query', request(`Show ${nameA}'s schedule today`));
    expect(response.status).toBe(200);
    expect(response.body.taskTarget.customer_id).toBe(customerA);
    const result = mockModel.mock.calls.at(-1)[0].messages.at(-1).content.find(block => block.tool_use_id === 'schedule').content;
    expect(result).toContain(visitA);
    expect(result).toContain('Own schedule note');
    expect(result).not.toContain(visitB);
    expect(result).not.toContain('Foreign private schedule note');
    expect(result).not.toContain(customerB);
    // An explicitly named customer who did not resolve leaves no read scope: the schedule read fails closed
    // instead of listing every appointment.
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce({ content: [
      { type: 'tool_use', name: 'get_schedule_view', input: {}, id: 'schedule' },
      { type: 'tool_use', name: 'get_call_log', input: { days_back: 1 }, id: 'calls' },
      { type: 'tool_use', name: 'search_messages', input: { search: 'schedule' }, id: 'messages' },
    ], usage: {} }).mockResolvedValueOnce(answer('Correct the customer name first.'));
    const misspelled = await api('/query', request("Show Jhon Smyth's schedule and calls today"));
    expect(misspelled.status).toBe(200);
    expect(misspelled.body.taskTarget).toBeFalsy();
    const refusals = mockModel.mock.calls.at(-1)[0].messages.at(-1).content;
    for (const id of ['schedule', 'calls', 'messages']) {
      expect(JSON.parse(refusals.find(block => block.tool_use_id === id).content)).toMatchObject({ code: 'customer_scope_required' });
    }
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain(visitA);
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain('Foreign private schedule note');
    await db('scheduled_services').whereIn('id', [visitA, visitB]).del();
  }, 30000);

  test('broad customer-row readers are refused inside a customer-scoped task and stay open outside one', async () => {
    const foreignPhone = (await db('customers').where('id', customerB).first('phone')).phone;
    await db('sms_log').insert({ id: crypto.randomUUID(), direction: 'inbound', from_phone: foreignPhone, to_phone: '+15550000000',
      message_body: 'Foreign private unanswered message', customer_id: customerB, created_at: new Date() });
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'unanswered messages threads' }, 'discover'))
      .mockResolvedValueOnce(tools('get_unanswered_threads', { hours_back: 24 }, 'threads'))
      .mockResolvedValueOnce(answer('Only the task customer may be read.'));
    const scoped = await api('/query', request(`Show unanswered messages for ${nameA}`, { context: 'communications', pageData: { route: '/admin/communications' } }));
    expect(scoped.status).toBe(200);
    expect(scoped.body.taskTarget.customer_id).toBe(customerA);
    const refused = mockModel.mock.calls.at(-1)[0].messages.at(-1).content.find(block => block.tool_use_id === 'threads').content;
    expect(JSON.parse(refused)).toMatchObject({ code: 'customer_scope_required' });
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain('Foreign private unanswered message');
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'unanswered messages threads' }, 'discover'))
      .mockResolvedValueOnce(tools('get_unanswered_threads', { hours_back: 24 }, 'threads'))
      .mockResolvedValueOnce(answer('The unanswered threads are loaded.'));
    const broad = await api('/query', request('Show all unanswered messages', { context: 'communications', pageData: { route: '/admin/communications' } }));
    expect(broad.status).toBe(200);
    expect(broad.body.taskTarget).toBeFalsy();
    const listed = mockModel.mock.calls.at(-1)[0].messages.at(-1).content.find(block => block.tool_use_id === 'threads').content;
    expect(JSON.parse(listed).code).toBeUndefined();
    // An explicitly named customer that did not resolve keeps the request target-specific.
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'unanswered messages threads' }, 'discover'))
      .mockResolvedValueOnce(tools('get_unanswered_threads', { hours_back: 24 }, 'threads'))
      .mockResolvedValueOnce(answer('Select the customer first.'));
    const misspelled = await api('/query', request('Show unanswered messages for Jhon Smyth', { context: 'communications', pageData: { route: '/admin/communications' } }));
    expect(misspelled.status).toBe(200);
    expect(misspelled.body.taskTarget).toBeFalsy();
    const refusedAgain = mockModel.mock.calls.at(-1)[0].messages.at(-1).content.find(block => block.tool_use_id === 'threads').content;
    expect(JSON.parse(refusedAgain)).toMatchObject({ code: 'customer_scope_required' });
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain('Foreign private unanswered message');
  }, 30000);

  test('a later-round corrected retry answers the earlier clarification for the same operation', async () => {
    mockModel.mockResolvedValueOnce(tools('get_customer_detail', { customer_id: customerB }, 'wrong-read'))
      .mockResolvedValueOnce(tools('get_customer_detail', { customer_id: customerA }, 'corrected-read'))
      .mockResolvedValueOnce(answer('The corrected customer details are loaded.'));
    const result = await api('/query', request(`Get customer details for ${nameA}`));
    expect(result.status).toBe(200);
    expect(result.body.taskTarget.customer_id).toBe(customerA);
    const rounds = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
    expect(rounds.find(block => block.tool_use_id === 'wrong-read').content).toContain('target_clarification_required');
    expect(rounds.find(block => block.tool_use_id === 'corrected-read').content).toContain(customerA);
    expect(result.body.taskState).toBe('responded');
  }, 30000);

  test('a child-record clarification on a page-resolved customer does not park the task without a continuation path', async () => {
    const foreignCall = crypto.randomUUID();
    await db('call_log').insert({ id: foreignCall, customer_id: null, transcription: 'Foreign private page-scoped call', status: 'completed' });
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'call log' }, 'discover'))
      .mockResolvedValueOnce(tools('get_call_log', { call_id: foreignCall }, 'call'))
      .mockResolvedValueOnce(answer('That call is not this customer\'s; pick the call from their record.'));
    const response = await api('/query', request('Read this customer\'s last call', { pageData: { route: '/admin/customers', customerId: customerA } }));
    expect(response.status).toBe(200);
    expect(response.body.taskTarget.customer_id).toBe(customerA);
    const result = mockModel.mock.calls.at(-1)[0].messages.at(-1).content.find(block => block.tool_use_id === 'call').content;
    expect(JSON.parse(result)).toMatchObject({ code: 'target_clarification_required' });
    expect(result).not.toContain('Foreign private page-scoped call');
    // No customer to choose: the card cannot continue this, so it is not parked as needs_information.
    expect(response.body.taskState).toBe('responded');
  }, 30000);

  test('two same-tool calls in one round keep their own clarification markers', async () => {
    const unlinkedCall = crypto.randomUUID(), ownCall = crypto.randomUUID();
    await db('call_log').insert([
      { id: unlinkedCall, customer_id: null, transcription: 'Foreign private same-tool evidence', status: 'completed' },
      { id: ownCall, customer_id: customerA, transcription: 'Synthetic own call evidence', status: 'completed' },
    ]);
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'call log' }, 'discover'))
      .mockResolvedValueOnce({ content: [
        { type: 'tool_use', name: 'get_call_log', input: { call_id: unlinkedCall }, id: 'unlinked-call' },
        { type: 'tool_use', name: 'get_call_log', input: { call_id: ownCall }, id: 'own-call' },
      ], usage: {} }).mockResolvedValueOnce(answer('One call is loaded.'));
    const response = await api('/query', request(`Read the two calls for ${nameA}`));
    expect(response.status).toBe(200);
    const round = mockModel.mock.calls.at(-1)[0].messages.at(-1).content;
    expect(round.find(block => block.tool_use_id === 'own-call').content).toContain('Synthetic own call evidence');
    expect(JSON.parse(round.find(block => block.tool_use_id === 'unlinked-call').content)).toMatchObject({ code: 'target_clarification_required' });
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain('Foreign private same-tool evidence');
    // The other call succeeding never answers the unlinked call's clarification.
    expect(response.body.taskState).toBe('needs_information');
  }, 30000);

  test('resume restores tools a completed discovery loaded but the worker never invoked', async () => {
    mockModel.mockResolvedValueOnce({ content: [
      { type: 'tool_use', name: 'discover_capabilities', input: { query: 'update customer fields' }, id: 'discover-write' },
      { type: 'tool_use', name: 'discover_capabilities', input: { query: 'send sms' }, id: 'discover-sms' },
    ], usage: {} })
      .mockResolvedValueOnce(tools('update_customer', { customer_id: customerA, updates: { notes: 'Discovered-then-resumed note' } }, 'note'))
      .mockResolvedValueOnce(answer('The note is awaiting confirmation.'));
    const proposed = await api('/query', request(`Update the note for ${nameA}, then text that the note was updated`));
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    expect((await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash })).body.success).toBe(true);
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(tools('send_sms', { customer_id: customerA, message: 'Your note was updated.' }, 'sms'))
      .mockResolvedValueOnce(answer('The text is awaiting confirmation.'));
    const resumed = await api(`/tasks/${proposed.body.taskId}/resume`, { session_id: sessionId });
    expect(resumed.status).toBe(200);
    // send_sms was loaded by the checkpointed discovery, never invoked, and must not need a repeated discovery.
    expect(mockModel.mock.calls[0][0].tools.map(tool => tool.name)).toContain('send_sms');
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain('capability_not_loaded');
    expect(resumed.body.pendingActions).toHaveLength(1);
    expect(resumed.body.pendingActions[0].tool).toBe('send_sms');
    await api('/cancel-action', { pending_action_id: resumed.body.pendingActions[0].id });
  }, 30000);

  test('customer matching cannot describe another account inside a customer-scoped task', async () => {
    const other = await db('customers').where('id', customerB).first('phone');
    mockModel.mockResolvedValueOnce(tools('match_existing_customer', { phone: other.phone }, 'match'))
      .mockResolvedValueOnce(answer('The selected customer is already on file.'));
    const result = await api('/query', request(`Get customer details for ${nameA}`));
    expect(result.status).toBe(200);
    expect(result.body.taskTarget.customer_id).toBe(customerA);
    const round = mockModel.mock.calls[1][0].messages.at(-1).content;
    expect(JSON.parse(round.find(block => block.tool_use_id === 'match').content)).toMatchObject({ count: 0, ambiguous: true, matches: [] });
    expect(JSON.stringify(round)).not.toContain(customerB);
    expect(JSON.stringify(round)).not.toContain(other.phone);
  }, 30000);

  test('tasks still open for the operator stay listed beyond the latest twenty', async () => {
    const IbTasks = require('../services/intelligence-bar/tasks');
    const session = crypto.randomUUID();
    const ids = [];
    for (let index = 0; index < 26; index += 1) {
      const { task } = await IbTasks.begin({ actorId: actor, sessionId: session, requestKey: crypto.randomUUID(),
        request: { prompt: `Synthetic saved request ${index}` }, pageContext: {} });
      ids.push(task.id);
    }
    // Two older failures: a raw pre-model failure (resumable) and a failed
    // approval whose receipt is unresolved (not resumable).
    await db('ib_tasks').where('id', ids[4]).update({ state: 'failed', created_at: new Date(Date.now() - 160000) });
    await db('ib_tasks').where('id', ids[5]).update({ state: 'failed', created_at: new Date(Date.now() - 150000) });
    await db('ib_pending_actions').insert({ tool_name: 'update_customer', params: '{}', params_hash: 'synthetic-failed', requested_by: actor,
      status: 'failed', expires_at: new Date(Date.now() + 3600000), task_id: ids[5], step_key: 'synthetic-failed' });
    // Four older tasks beyond the latest twenty: still awaiting a choice, answered,
    // approval settled by cancellation, and awaiting an approval that was never proposed.
    await db('ib_tasks').where('id', ids[0]).update({ state: 'needs_information', created_at: new Date(Date.now() - 140000) });
    await db('ib_tasks').where('id', ids[1]).update({ state: 'responded', created_at: new Date(Date.now() - 130000) });
    await db('ib_tasks').where('id', ids[2]).update({ state: 'awaiting_approval', created_at: new Date(Date.now() - 120000) });
    await db('ib_pending_actions').insert({ tool_name: 'update_customer', params: '{}', params_hash: 'synthetic', requested_by: actor,
      status: 'cancelled', expires_at: new Date(Date.now() + 3600000), task_id: ids[2], step_key: 'synthetic-cancelled' });
    await db('ib_tasks').where('id', ids[3]).update({ state: 'awaiting_approval', created_at: new Date(Date.now() - 110000) });
    const listed = await api(`/tasks?session_id=${session}`);
    const listedIds = listed.body.tasks.map(task => task.id);
    expect(listedIds).toContain(ids[0]);
    expect(listedIds).toContain(ids[3]);
    expect(listedIds).not.toContain(ids[1]);
    expect(listedIds).not.toContain(ids[2]);
    expect(listedIds).toContain(ids[4]);
    expect(listedIds).not.toContain(ids[5]);
    expect(listed.body.tasks).toHaveLength(23);
    expect(listed.body.tasks.find(task => task.id === ids[0]).state).toBe('needs_information');
  }, 30000);

  test('retention removes expired recovery data with gates off and preserves pending-action reconciliation', async () => {
    const Tasks = require('../services/intelligence-bar/tasks');
    const Pending = require('../services/intelligence-bar/pending-actions');
    const makeTask = async () => (await Tasks.begin({ actorId: actor, sessionId, requestKey: crypto.randomUUID(),
      request: { prompt: 'Synthetic retention request' }, pageContext: {} })).task;
    const expired = await makeTask(), active = await makeTask(), fresh = await makeTask();
    const card = await Pending.createPendingAction({ toolName: 'update_customer', params: { customer_id: customerA },
      requestedBy: actor, taskId: expired.id, runnerToken: expired.runner_token, stepKey: 'retention-fixture' });
    await Pending.claimForConfirm(card.id, actor);
    await Pending.recordResult(card.id, { outcome_unknown: true, code: 'synthetic_interrupted' });
    const past = new Date(Date.now() - 1000);
    await db('ib_tasks').where('id', expired.id).update({ expires_at: past, lease_expires_at: past });
    await db('ib_tasks').where('id', active.id).update({ expires_at: past });
    process.env.GATE_IB_PLATFORM = 'false';
    try {
      expect(await Tasks.purgeExpiredTasks()).toBeGreaterThanOrEqual(1);
      expect(await db('ib_tasks').where('id', expired.id).first()).toBeUndefined();
      expect(await db('ib_tasks').where('id', active.id).first()).toBeTruthy();
      expect(await db('ib_tasks').where('id', fresh.id).first()).toBeTruthy();
      expect((await db('ib_pending_actions').where('id', card.id).first()).task_id).toBeNull();
      expect((await Pending.getActionReceipt(card.id, actor)).outcome).toBe('outcome_unknown');
      expect(await Pending.getActionReceipt(card.id, crypto.randomUUID())).toBeNull();
      await db('ib_tasks').where('id', active.id).update({ lease_expires_at: past });
      await Tasks.purgeExpiredTasks();
      expect(await db('ib_tasks').where('id', active.id).first()).toBeUndefined();
    } finally { process.env.GATE_IB_PLATFORM = 'true'; }
  }, 30000);

  test('record reads without a customer target still require a current-request record selection', async () => {
    const callId = crypto.randomUUID();
    await db('call_log').insert({ id: callId, customer_id: null, transcription: 'Synthetic unlinked private call', status: 'completed' });
    for (const prompt of ['Look up inventory', 'Read this call']) {
      mockModel.mockReset().mockResolvedValueOnce(tools('discover_capabilities', { query: 'call log' }, 'discover'))
        .mockResolvedValueOnce(tools('get_call_log', { call_id: callId }, 'call'))
        .mockResolvedValueOnce(answer('The call lookup is checked.'));
      const response = await api('/query', request(prompt, { pageData: { call_id: callId } }));
      expect(response.status).toBe(200);
      const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === 'call');
      if (prompt === 'Read this call') expect(result.content).toContain('Synthetic unlinked private call');
      else {
        expect(JSON.parse(result.content)).toMatchObject({ code: 'target_clarification_required' });
        expect(result.content).not.toContain('Synthetic unlinked private call');
      }
    }
  }, 30000);

  test('a misspelled current customer name cannot fall through to the customer open behind the bar', async () => {
    mockModel.mockResolvedValueOnce(tools('get_customer_detail', { customer_id: customerB }, 'read'))
      .mockResolvedValueOnce(answer('Choose the intended customer.'));
    const response = await api('/query', request(`Show Unmatched${crypto.randomUUID().slice(0, 8)}'s details`));
    expect(response.status).toBe(200);
    expect(response.body.taskTarget).toBeFalsy();
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'read');
    expect(JSON.parse(result.content)).toMatchObject({ code: 'target_clarification_required' });
    expect(result.content).not.toContain('200 Example Grove');
  }, 30000);

  test('stale selections on the query route cannot replace unmatched names or shrink complete cohorts', async () => {
    for (const prompt of ['Update Unmatched Syntheticperson', `Update both ${nameA} and Unmatched Syntheticperson`]) {
      const response = await api('/query', request(prompt, { selected_target: { customer_id: customerA } }));
      expect(response.body).toMatchObject({ taskState: 'needs_information', pendingActions: [] });
      expect(mockModel).not.toHaveBeenCalled();
      expect(await db('ib_pending_actions').where('task_id', response.body.taskId)).toEqual([]);
      const select = await api(`/tasks/${response.body.taskId}/select-target`, { session_id: sessionId, customer_id: customerA });
      expect(select.status).toBe(409);
    }
    // A named cohort is fail-closed (owner decision 2026-09-08): even with every name matching, the request has no targets and refuses a selection.
    const customer = await db('customers').where('id', customerB).first('first_name', 'last_name');
    const complete = await api('/query', request(`Update both ${nameA} and ${customer.first_name} ${customer.last_name}`, {
      selected_target: { customer_id: customerA },
    }));
    expect(complete.body).toMatchObject({ taskState: 'needs_information', pendingActions: [] });
    expect(mockModel).not.toHaveBeenCalled();
    const stored = await db('ib_tasks').where('id', complete.body.taskId).first('target');
    expect(stored.target).toMatchObject({ code: 'context_mismatch', selectable: true });
  }, 30000);

  test('a unique phone explicitly requested for a read permits that thread, without authorizing writes', async () => {
    const a = await db('customers').where('id', customerA).first();
    const b = await db('customers').where('id', customerB).first();
    await db('sms_log').insert({ customer_id: customerA, direction: 'inbound', from_phone: a.phone,
      to_phone: '+15555550199', message_body: 'Synthetic explicit-phone conversation' });
    for (const [prompt, phone, permitted, duplicate] of [
      [`Show the conversation with ${a.phone}`, a.phone, true],
      [`What did we say to the customer on ${a.phone}?`, a.phone, true],
      [`Show the conversation with ${a.phone}`, b.phone, false],
      [`Show inventory with a note containing show the conversation with ${a.phone}`, a.phone, false],
      [`Show the conversation with ${a.phone}`, a.phone, false, true],
    ]) {
      if (duplicate) await db('customers').where('id', customerB).update({ phone: a.phone.replace(/^\+1/, '') });
      mockModel.mockReset().mockResolvedValueOnce({ content: [
        { type: 'tool_use', name: 'discover_capabilities', input: { query: 'conversation thread' }, id: 'discover-read' },
        { type: 'tool_use', name: 'discover_capabilities', input: { query: 'update customer fields' }, id: 'discover-write' },
      ], usage: {} })
        .mockResolvedValueOnce(tools('get_conversation_thread', { phone }, 'thread'))
        .mockResolvedValueOnce(tools('update_customer', { customer_id: customerA, updates: { notes: 'Must not be saved by a read' } }, 'write'))
        .mockResolvedValueOnce(answer('The requested conversation was checked.'));
      const response = await api('/query', request(prompt));
      expect(response.status).toBe(200);
      expect(response.body.taskTarget).toBeFalsy();
      expect(response.body.pendingActions || []).toHaveLength(0);
      const results = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
      const result = results.find(block => block.type === 'tool_result' && block.tool_use_id === 'thread');
      if (permitted) expect(result.content).toContain('Synthetic explicit-phone conversation');
      else expect(JSON.parse(result.content)).toMatchObject({ code: 'target_clarification_required' });
      expect(JSON.parse(results.find(block => block.type === 'tool_result' && block.tool_use_id === 'write').content))
        .toMatchObject({ code: 'target_clarification_required' });
    }
    await db('customers').where('id', customerB).update({ phone: b.phone });
  }, 60000);

  test.each(['toggle_estimate_v2_view', 'toggle_show_one_time_option', 'set_estimate_presentation'])(
    '%s canonicalizes token and phone selectors before approval and preserves that ID', async toolName => {
      for (const selector of ['token', 'phone']) {
        const estimateId = crypto.randomUUID(), newerId = crypto.randomUUID(), estimateToken = crypto.randomBytes(32).toString('hex');
        const phone = `+15553${Math.floor(Math.random() * 1000000).toString().padStart(6, '0')}`;
        const estimateData = { engineResult: { lineItems: [{ service: 'pest_control', name: 'Pest Control', annual: 400, frequency: 4, perApp: 100 }] } };
        await db('estimates').insert({ id: estimateId, token: estimateToken, customer_id: customerA,
          customer_name: nameA, customer_phone: phone, status: 'draft', use_v2_view: false, show_one_time_option: false,
          annual_total: 400, estimate_data: JSON.stringify(estimateData) });
        const input = { estimate_identifier: selector === 'token' ? estimateToken : phone,
          ...(toolName === 'set_estimate_presentation'
            ? { service: 'pest_control', display_name: 'General Pest Control', reason: 'Synthetic operator label correction' }
            : { enabled: true }) };
        mockModel.mockReset().mockResolvedValueOnce(tools('discover_capabilities', { query: toolName.replaceAll('_', ' ') }, 'discover'))
          .mockResolvedValueOnce(tools(toolName, input, 'estimate'))
          .mockResolvedValueOnce(answer('Review the estimate change.'));
        const proposed = await api('/query', request(`Update the estimate for ${nameA}`));
        expect(proposed.body.pendingActions).toHaveLength(1);
        const card = proposed.body.pendingActions[0];
        const stored = await db('ib_pending_actions').where({ id: card.id }).first();
        expect(stored.params.estimate_identifier).toBe(estimateId);
        expect(stored.params._ib_step_key_version).toBe(2);
        expect(JSON.stringify(mockModel.mock.calls)).not.toContain('_ib_step_key_version');
        await db('estimates').insert({ id: newerId, token: crypto.randomUUID(), customer_id: customerA, customer_name: nameA,
          customer_phone: phone, status: 'draft', use_v2_view: false, show_one_time_option: false, annual_total: 400, estimate_data: JSON.stringify(estimateData),
          created_at: new Date(Date.now() + 60000) });
        const confirmed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
        expect(confirmed.body).toMatchObject({ success: true, outcome: 'completed' });
        const saved = await db('estimates').where({ id: estimateId }).first();
        const untouched = await db('estimates').where({ id: newerId }).first();
        if (toolName === 'set_estimate_presentation') {
          expect(saved.estimate_data.engineResult.lineItems[0].displayName).toBe(input.display_name);
          expect(untouched.estimate_data).toEqual(estimateData);
        } else {
          const flag = toolName === 'toggle_estimate_v2_view' ? 'use_v2_view' : 'show_one_time_option';
          expect(saved[flag]).toBe(true);
          expect(untouched[flag]).toBe(false);
        }
        expect((await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash })).status).toBe(409);
      }
    }, 60000);

  test('a customer task cannot propose moving an unrelated customerless reservation hold', async () => {
    const hold = crypto.randomUUID();
    const date = require('../utils/datetime-et').etDateString(new Date(Date.now() + 7 * 86400000));
    const nextDate = require('../utils/datetime-et').etDateString(new Date(Date.now() + 8 * 86400000));
    await db('scheduled_services').insert({ id: hold, customer_id: null, scheduled_date: date,
      service_type: 'Synthetic reservation', status: 'pending', window_start: '12:00:00', window_end: '14:00:00' });
    const before = await db('scheduled_services').where('id', hold).first();
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'move stops to day' }, 'discover'))
      .mockResolvedValueOnce(tools('move_stops_to_day', { service_ids: [hold], new_date: nextDate }, 'move'))
      .mockResolvedValueOnce(answer('The selected reservation does not belong to this customer.'));
    const proposed = await api('/query', request(`Move ${nameA}'s appointments to ${nextDate}`));
    expect(proposed.body.taskTarget.customer_id).toBe(customerA);
    expect(proposed.body.pendingActions || []).toHaveLength(0);
    const result = mockModel.mock.calls.at(-1)[0].messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'move');
    expect(JSON.parse(result.content)).toMatchObject({ code: 'target_clarification_required' });
    expect(await db('ib_pending_actions').where({ task_id: proposed.body.taskId })).toHaveLength(0);
    expect(await db('scheduled_services').where('id', hold).first()).toEqual(before);
  }, 30000);

  test('visit, call, name, phone and Gmail selectors cannot substitute another customer', async () => {
    const visitB = crypto.randomUUID(), callA = crypto.randomUUID(), callB = crypto.randomUUID();
    const emailA = crypto.randomUUID(), emailB = crypto.randomUUID(), mixedA = crypto.randomUUID(), mixedB = crypto.randomUUID();
    const replyA = crypto.randomUUID(), orphan = crypto.randomUUID();
    const a = await db('customers').where('id', customerA).first(), b = await db('customers').where('id', customerB).first();
    await db('scheduled_services').insert({ id: visitB, customer_id: customerB, scheduled_date: require('../utils/datetime-et').etDateString(), service_type: 'Synthetic visit', status: 'pending' });
    await db('call_log').insert([
      { id: callA, customer_id: customerA, transcription: 'Correct task call evidence', status: 'completed' },
      { id: callB, customer_id: customerB, transcription: 'Foreign private call evidence', status: 'completed' },
    ]);
    await db('sms_log').insert([
      { customer_id: customerA, direction: 'inbound', from_phone: a.phone, to_phone: '+15555550199', message_body: 'Correct task SMS evidence' },
      { customer_id: customerA, direction: 'inbound', from_phone: '+15555550198', to_phone: '+15555550199', message_body: 'Correct former-phone SMS evidence' },
      { customer_id: null, direction: 'inbound', from_phone: a.phone, to_phone: '+15555550199', message_body: 'Correct unlinked SMS evidence' },
      { customer_id: customerB, direction: 'inbound', from_phone: a.phone, to_phone: '+15555550199', message_body: 'Foreign private shared-phone evidence' },
    ]);
    await db('emails').insert([
      { id: emailA, customer_id: customerA, gmail_id: emailA, gmail_thread_id: emailA, from_address: 'fixture-a@example.test', from_name: nameA, body_text: 'Correct task email evidence' },
      { id: emailB, customer_id: customerB, gmail_id: emailB, gmail_thread_id: emailB, from_address: 'fixture-b@example.test', from_name: nameA, body_text: 'Foreign private email evidence', snippet: 'Foreign private email evidence' },
      { id: mixedA, customer_id: customerA, gmail_id: mixedA, gmail_thread_id: mixedA, from_address: 'fixture-a@example.test', body_text: 'Mixed task email evidence' },
      { id: mixedB, customer_id: customerB, gmail_id: mixedB, gmail_thread_id: mixedA, from_address: 'fixture-b@example.test', body_text: 'Foreign private mixed-thread evidence' },
      { id: replyA, gmail_id: replyA, gmail_thread_id: emailA, from_address: 'fixture-a@example.test', from_name: nameA, snippet: 'Correct unlinked thread reply' },
      { id: orphan, gmail_id: orphan, gmail_thread_id: orphan, from_address: 'fixture-a@example.test', from_name: nameA, snippet: 'Foreign private orphan evidence' },
    ].map(email => ({ ...email, received_at: new Date(), subject: 'Synthetic read binding' })));
    const selections = [
      ['get_closeout_status', { service_id: visitB }, false],
      ['get_call_log', { call_id: callB }, 'target_relationship_mismatch'],
      ['get_conversation_thread', { customer_name: `${b.first_name} ${b.last_name}` }, false],
      ['get_conversation_thread', { phone: b.phone }, false],
      ['get_email_thread', { thread_id: emailB }, false],
      ['get_email_thread', { thread_id: emailA }, 'Correct task email evidence'],
      ['get_email_thread', { thread_id: mixedA }, false],
      ['draft_email_reply', { thread_id: emailB }, false],
      ['get_call_log', { customer_name: nameA }, 'Correct task call evidence'],
      ['get_conversation_thread', { customer_name: nameA }, 'Correct task SMS evidence'],
      ['search_messages', { phone: a.phone }, 'Correct unlinked SMS evidence'],
      ['search_messages', { customer_name: nameA }, 'Correct former-phone SMS evidence'],
      ['match_existing_customer', { phone: a.phone }, customerA],
      ['get_partner_call_history', { phone: a.phone }, 'calls'],
      ['get_partner_call_history', { phone: b.phone }, false],
      ['check_email_suppression', { email: 'fixture-b@example.test' }, false],
      ['query_customers', {}, customerA],
      ['query_customers', { sort_by: 'name', limit: 50 }, customerA],
      ['search_emails', { from: nameA }, 'Correct unlinked thread reply'],
      ['search_emails', { from: 'fixture-b@example.test' }, '"total":0'],
    ];
    // Discover each actual schema, then execute the complete batch through the
    // real dispatcher. Foreign email drafting must never call its nested model.
    mockModel.mockResolvedValueOnce({ content: [...new Set(selections.map(([name]) => name))].map(name => ({
      type: 'tool_use', name: 'discover_capabilities', input: { query: name.replaceAll('_', ' ') }, id: `discover-${name}`,
    })), usage: {} }).mockResolvedValueOnce({ content: selections.map(([name, input], index) => ({ type: 'tool_use', name, input, id: `read-${index}` })), usage: {} })
      .mockResolvedValueOnce(answer('The selected customer records are loaded.'));
    const result = await api('/query', request(`Read records for ${nameA}`));
    expect(result.status).toBe(200);
    expect(mockModel).toHaveBeenCalledTimes(3);
    const results = mockModel.mock.calls[2][0].messages.at(-1).content;
    for (const [index, [, , expected]] of selections.entries()) {
      const content = results.find(block => block.tool_use_id === `read-${index}`).content;
      expect(content).toContain(expected || 'target_clarification_required');
    }
    expect(JSON.stringify(results)).not.toContain('Foreign private');
    // Bare and filter-only customer lists inside the task never list the other customer.
    expect(JSON.stringify(results)).not.toContain(customerB);
    // No entity scope: an operator can still search the entire inbox.
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'search emails' }, 'discover'))
      .mockResolvedValueOnce(tools('search_emails', { search: 'Synthetic read binding' }, 'inbox'))
      .mockResolvedValueOnce(answer('Inbox search complete.'));
    expect((await api('/query', request('Search inbox'))).status).toBe(200);
    expect(JSON.stringify(mockModel.mock.calls[2][0].messages.at(-1).content)).toContain('Foreign private');
  }, 60000);

  test('a model-proposed alternate name cannot replace the resolved SMS customer before approval', async () => {
    const b = await db('customers').where('id', customerB).first();
    const a = await db('customers').where('id', customerA).first();
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'send sms' }, 'discover'))
      .mockResolvedValueOnce(tools('send_sms', { customer_name: `${b.first_name} ${b.last_name}`, message: 'Synthetic preview only' }, 'sms'))
      .mockResolvedValueOnce(answer('The send awaits confirmation.'));
    const proposed = await api('/query', request('Text this customer: Synthetic preview only', { pageData: { customer_id: customerA } }));
    expect(proposed.body.taskTarget.customer_id).toBe(customerA);
    expect(proposed.body.pendingActions).toHaveLength(1);
    const stored = await db('ib_pending_actions').where('id', proposed.body.pendingActions[0].id).first();
    expect(stored.params).toMatchObject({ customer_id: customerA, customer_name: nameA, phone: a.phone });
    expect(stored.status).toBe('pending');
    expect(stored.consumed_at).toBeNull();
    expect(stored.result).toBeNull();
  }, 30000);

  test('a phone number inside message content cannot authorize an alternate recipient', async () => {
    const b = await db('customers').where('id', customerB).first();
    const propose = prompt => {
      mockModel.mockReset();
      mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'send sms' }, 'discover'))
        .mockResolvedValueOnce(tools('send_sms', { phone: b.phone, message: 'Synthetic reminder' }, 'sms'))
        .mockResolvedValueOnce(answer('The send requires a valid recipient.'));
      return api('/query', request(prompt, { pageData: { customerId: customerA } }));
    };
    for (const prompt of [`Text this customer: please call ${b.phone}`, `Text this customer a reminder to call ${b.phone}`, `Text this customer "please call ${b.phone}"`]) {
      const wrong = await propose(prompt);
      expect(wrong.body.taskTarget?.customer_id).toBe(customerA);
      expect(wrong.body.pendingActions).toHaveLength(0);
      expect(JSON.stringify(mockModel.mock.calls[2][0].messages.at(-1).content)).toContain('target_relationship_mismatch');
    }
    const explicit = await propose(`Text ${b.phone}: Synthetic reminder`);
    expect(explicit.body.pendingActions).toHaveLength(1);
    expect((await db('ib_pending_actions').where('id', explicit.body.pendingActions[0].id).first()).params.phone).toBe(b.phone);
    const Context = require('../services/intelligence-bar/task-context');
    for (const prompt of [`Save a note "text ${b.phone} a reminder"`, `Save a note asking the customer to text ${b.phone}`]) {
      expect((await Context.resolve({ prompt })).explicitPhones).toEqual([]);
    }
    const unknown = await propose(`Text Unknownsurname a reminder to text ${b.phone} for help`);
    expect(unknown.body.pendingActions).toHaveLength(0);
    expect(JSON.stringify(mockModel.mock.calls[2][0].messages.at(-1).content)).toContain('target_clarification_required');
    expect((await Context.resolve({ prompt: `Please send a message to ${b.phone}: Synthetic reminder` })).explicitPhones).toEqual([b.phone.replace(/\D/g, '').slice(-10)]);
    expect((await Context.resolve({ prompt: `Text ${b.phone} 12 applications remain` })).explicitPhones).toEqual([b.phone.replace(/\D/g, '').slice(-10)]);
    expect((await Context.resolve({ prompt: 'Save a note asking the customer to email fixture@example.test' })).explicitEmails).toEqual([]);
    expect((await Context.resolve({ prompt: 'Send an email to fixture@example.test: Synthetic reply' })).explicitEmails).toEqual(['fixture@example.test']);
  }, 30000);

  test('an exact surname resolves once; duplicate surnames and unknown names never select the viewed customer', async () => {
    const id = crypto.randomUUID();
    const surname = `Surname${id.replace(/-/g, '').replace(/[0-9]/g, n => String.fromCharCode(103 + Number(n)))}`;
    await db('customers').insert({ id, first_name: 'Synthetic', last_name: surname, phone: '+15555550197' });
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'send sms' }, 'discover'))
      .mockResolvedValueOnce(tools('send_sms', { customer_id: id, message: 'Synthetic reminder' }, 'sms'))
      .mockResolvedValueOnce(answer('Reminder awaiting confirmation.'));
    const found = await api('/query', request(`Text ${surname} reminder`));
    expect(found.body.taskTarget.customer_id).toBe(id);
    expect(found.body.pendingActions).toHaveLength(1);
    await db('customers').insert({ id: crypto.randomUUID(), first_name: 'Another', last_name: surname, phone: '+15555550196' });
    mockModel.mockReset();
    const duplicate = await api('/query', request(`Text ${surname} reminder`));
    expect(duplicate.body).toMatchObject({ taskState: 'needs_information', pendingActions: [] });
    expect(duplicate.body.candidates).toHaveLength(2);
    expect(mockModel).not.toHaveBeenCalled();
    proposeNote(customerB, 'Must not choose the viewed customer');
    const unknown = await api('/query', request(`Text Unknown${surname} reminder`));
    expect(unknown.body).toMatchObject({ taskState: 'needs_information', pendingActions: [] });
  }, 30000);

  test('a reply via SMS proposed with only the canonical customer id pins that recipient', async () => {
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'reply via sms' }, 'discover'))
      .mockResolvedValueOnce(tools('reply_via_sms', { customer_id: customerA, message: 'Synthetic reply' }, 'sms'))
      .mockResolvedValueOnce(answer('Reply awaiting confirmation.'));
    const result = await api('/query', request(`Reply to ${nameA} by text`));
    expect(result.body.taskTarget.customer_id).toBe(customerA);
    expect(result.body.pendingActions).toHaveLength(1);
    expect(result.body.pendingActions[0].tool).toBe('reply_via_sms');
  }, 30000);

  test('dependent writes cannot be proposed together or resumed after a failed prerequisite', async () => {
    const note = { type: 'tool_use', name: 'update_customer', input: { customer_id: customerA, updates: { notes: 'Frontier fixture' } }, id: 'first' };
    const sms = { type: 'tool_use', name: 'send_sms', input: { customer_id: customerA, message: 'Your note was updated.' }, id: 'second' };
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'update customer send sms' }, 'discover'))
      .mockResolvedValueOnce({ content: [note, sms], usage: {} })
      .mockResolvedValueOnce(answer('The first action is awaiting confirmation.'));
    const input = request(`Update the note for ${nameA}, then text that the note was updated`);
    const result = await api('/query', input);
    expect(result.body.pendingActions).toHaveLength(1);
    expect(result.body.pendingActions[0].tool).toBe('update_customer');
    expect(JSON.stringify(mockModel.mock.calls)).toContain('dependency_unresolved');
    const rows = await db('ib_pending_actions').where('task_id', result.body.taskId);
    expect(rows).toHaveLength(1);
    const Pending = require('../services/intelligence-bar/pending-actions');
    await Pending.claimForConfirm(rows[0].id, actor, { contractHash: rows[0].contract_hash });
    await Pending.recordResult(rows[0].id, { success: false, error: 'Injected prerequisite failure' });
    expect((await api(`/tasks/${result.body.taskId}?session_id=${sessionId}`)).body.taskState).toBe('failed');
    expect((await api(`/tasks/${result.body.taskId}/resume`, { session_id: sessionId })).body.code).toBe('steps_unresolved');
    await Pending.recordResult(rows[0].id, { success: true, state: 'provider_accepted', partial: true,
      providerMessageId: 'synthetic-provider-id', warning: 'Disclosed inbox update failed' });
    expect((await api(`/tasks/${result.body.taskId}?session_id=${sessionId}`)).body.taskState).toBe('partially_completed');
    expect((await api(`/tasks/${result.body.taskId}/resume`, { session_id: sessionId })).body.code).toBe('steps_unresolved');
    expect(await db('ib_pending_actions').where('task_id', result.body.taskId).count('* as count').first()).toEqual({ count: '1' });
  }, 30000);

  test('a stale customer approval cannot overwrite a newer edit', async () => {
    proposeNote(customerA, 'Old approved note');
    const proposed = await api('/query', request(`Add a note for ${nameA}: Old approved note`));
    const card = proposed.body.pendingActions[0];
    await db('customers').where('id', customerA).update({ crm_notes: 'Newer operator edit', updated_at: db.fn.now() });
    const confirmed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    expect(confirmed.status).toBe(409);
    expect(confirmed.body).toMatchObject({ code: 'target_changed' });
    expect((await db('customers').where('id', customerA).first('crm_notes')).crm_notes).toBe('Newer operator edit');
  }, 30000);

  test('revoked mutation permission records a blocked receipt after claiming the approval', async () => {
    const before = await db('customers').where('id', customerA).first('crm_notes');
    proposeNote(customerA, 'Must not survive permission revocation');
    const proposed = await api('/query', request(`Update the note for ${nameA}`));
    const card = proposed.body.pendingActions[0];
    await db('technicians').where('id', actor).update({ role: 'technician' });
    try {
      expect((await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash })).status).toBe(403);
      expect(await db('customers').where('id', customerA).first('crm_notes')).toEqual(before);
    } finally { await db('technicians').where('id', actor).update({ role: 'admin' }); }
    expect((await api(`/actions/${card.id}`)).body).toMatchObject({ outcome: 'blocked', result: { code: 'permission_denied' } });
    expect((await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash })).status).toBe(409);
  }, 30000);

  test('a saved visit may switch properties within its customer, never to another customer', async () => {
    const propertyA = crypto.randomUUID(), destination = crypto.randomUUID(), foreignProperty = crypto.randomUUID();
    const appointment = crypto.randomUUID();
    await db('customer_properties').insert([
      { id: propertyA, customer_id: customerA, address_line1: '100 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201', address_key: propertyA },
      { id: destination, customer_id: customerA, address_line1: '300 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201', address_key: destination },
      { id: foreignProperty, customer_id: customerB, address_line1: '400 Example Grove', city: 'Sarasota', state: 'FL', zip: '34201', address_key: foreignProperty },
    ]);
    const { addETDays, etDateString } = require('../utils/datetime-et');
    const date = etDateString(addETDays(new Date(), 10));
    await db('scheduled_services').insert({ id: appointment, customer_id: customerA, property_id: propertyA,
      scheduled_date: date, service_type: 'General Pest Control', status: 'pending', window_start: '09:00:00', window_end: '10:00:00' });
    const propose = propertyId => {
      mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'switch appointment property' }, 'discover'))
        .mockResolvedValueOnce(tools('switch_appointment_property', { appointment_id: appointment, property_id: propertyId }, 'switch'))
        .mockResolvedValueOnce(answer('The visit destination is ready for confirmation.'));
      return api('/query', request(`Change the appointment property for ${nameA} to the saved Example Grove property`));
    };
    const refused = await propose(foreignProperty);
    expect(refused.body.pendingActions).toHaveLength(0);
    const proposed = await propose(destination);
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    const confirmed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    expect(confirmed.body).toMatchObject({ success: true, outcome: 'completed' });
    expect(await db('scheduled_services').where('id', appointment).first('property_id', 'service_address_line1'))
      .toEqual({ property_id: destination, service_address_line1: '300 Example Grove' });
    expect((await db('customers').where('id', customerA).first('address_line1')).address_line1).toBe('100 Example Grove');
  }, 30000);

  test('completed reads cannot resume and interrupted attachment requests require their missing evidence', async () => {
    const Tasks = require('../services/intelligence-bar/tasks');
    mockModel.mockResolvedValueOnce(answer('The read is complete.'));
    const completed = await api('/query', request('Show an inventory summary'));
    const recovered = await api(`/tasks/${completed.body.taskId}?session_id=${sessionId}`);
    expect(recovered.body).toMatchObject({ taskState: 'responded', canContinue: false });
    const calls = mockModel.mock.calls.length;
    const refused = await api(`/tasks/${completed.body.taskId}/resume`, { session_id: sessionId });
    expect(refused).toMatchObject({ status: 409, body: { code: 'not_resumable' } });
    expect(mockModel).toHaveBeenCalledTimes(calls);
    const { task } = await Tasks.begin({ actorId: actor, sessionId, requestKey: crypto.randomUUID(),
      request: request('Use the attached measurement to prepare an estimate', { images: ['synthetic-ephemeral-image'] }), pageContext: {} });
    await db('ib_tasks').where({ id: task.id }).update({ lease_expires_at: new Date(Date.now() - 1000) });
    const missing = await api(`/tasks/${task.id}?session_id=${sessionId}`);
    expect(missing.body).toMatchObject({ canContinue: false, response: expect.stringContaining('Reattach') });
    expect((await api(`/tasks/${task.id}/resume`, { session_id: sessionId })).body.code).toBe('attachments_required');
    expect(mockModel).toHaveBeenCalledTimes(calls);
    expect(await db('ib_pending_actions').where({ task_id: task.id })).toHaveLength(0);
    const persisted = await db('ib_tasks').where({ id: task.id }).first();
    expect(persisted.request.images).toBeUndefined();
    expect(persisted.request.had_images).toBe(true);
  }, 30000);

  test('resume includes committed receipts even when the worker died before its first checkpoint', async () => {
    proposeNote(customerA, 'Recovered pre-checkpoint note');
    const proposed = await api('/query', request(`Add a note for ${nameA}: Recovered pre-checkpoint note`));
    const card = proposed.body.pendingActions[0];
    const confirmed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    expect(confirmed.body.success).toBe(true);
    await db('ib_tasks').where('id', proposed.body.taskId).update({ checkpoint: '[]' });
    mockModel.mockClear();
    mockModel.mockResolvedValueOnce(answer('The saved note is complete.'));
    const resumed = await api(`/tasks/${proposed.body.taskId}/resume`, { session_id: sessionId });
    expect(resumed.status).toBe(200);
    expect(resumed.body.receipts).toEqual([expect.objectContaining({ id: card.id, outcome: 'completed' })]);
    expect(resumed.body.pendingActions).toEqual([]);
    expect(resumed.body.canContinue).toBe(false);
    const modelInput = JSON.stringify(mockModel.mock.calls[0][0].messages);
    expect(modelInput).toContain('server-verified step outcomes');
    expect(modelInput).toContain('Recovered pre-checkpoint note');
    expect(modelInput).not.toContain(card.id);
    expect(await db('ib_pending_actions').where('task_id', proposed.body.taskId).count('* as count').first()).toEqual({ count: '1' });
  }, 30000);

  test('an explicitly addressed inbox sender can receive a reply preview without a customer link', async () => {
    const vendorEmail = crypto.randomUUID(), otherEmail = crypto.randomUUID();
    const vendorAddress = `fixture-${vendorEmail}@vendor.example`;
    await db('emails').insert([
      { id: vendorEmail, gmail_id: vendorEmail, gmail_thread_id: vendorEmail, from_address: vendorAddress, received_at: new Date(), subject: 'Synthetic supply inquiry' },
      { id: otherEmail, gmail_id: otherEmail, gmail_thread_id: otherEmail, from_address: 'another-supplier@vendor.example', received_at: new Date(), subject: 'Unrelated inquiry' },
    ]);
    const propose = emailId => {
      mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'send email reply' }, 'discover'))
        .mockResolvedValueOnce(tools('send_email_reply', { email_id: emailId, body: 'Thank you for the information.' }, 'reply'))
        .mockResolvedValueOnce(answer('The reply is awaiting confirmation.'));
      return api('/query', request(`Reply to ${vendorAddress} with thanks`));
    };
    expect((await propose(otherEmail)).body.pendingActions).toHaveLength(0);
    const valid = await propose(vendorEmail);
    expect(valid.body.pendingActions).toHaveLength(1);
    expect(valid.body.pendingActions[0].contract.pinned_recipient.email_masked).toBe('f***@vendor.example');
    expect((await db('ib_pending_actions').where('id', valid.body.pendingActions[0].id).first('params')).params.email_id).toBe(vendorEmail);
    const pending = valid.body.pendingActions[0];
    expect((await api('/cancel-action', { pending_action_id: pending.id })).body)
      .toMatchObject({ success: true, cancelled: true, outcome: 'canceled' });
    expect((await api(`/actions/${pending.id}`)).body.outcome).toBe('canceled');
    expect((await api(`/tasks/${valid.body.taskId}?session_id=${sessionId}`)).body.taskState).toBe('canceled');
    const listed = await api(`/tasks?session_id=${sessionId}`);
    expect(listed.body.tasks.find(task => task.id === valid.body.taskId).state).toBe('canceled');
  }, 30000);

  test('Gmail timeout produces a durable unknown receipt and blocks replay and dependent steps', async () => {
    const emailId = crypto.randomUUID();
    await db('emails').insert({ id: emailId, gmail_id: emailId, gmail_thread_id: emailId, customer_id: customerA,
      from_address: 'fixture-a@example.test', subject: 'Synthetic timeout', received_at: new Date() });
    const gmail = require('../services/email/gmail-client');
    gmail.sendMessage.mockReset().mockRejectedValue(Object.assign(new Error('Synthetic accepted-then-timeout'), { providerOutcome: { outcomeUnknown: true } }));
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'send email reply' }, 'discover'))
      .mockResolvedValueOnce(tools('send_email_reply', { email_id: emailId, body: 'Synthetic reply' }, 'send'))
      .mockResolvedValueOnce(answer('The reply awaits confirmation.'));
    const proposed = await api('/query', request(`Reply to ${nameA} with thanks, then add a follow-up`));
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    const confirm = () => api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    const result = await confirm();
    expect(result.body).toMatchObject({ success: false, outcome: 'outcome_unknown' });
    const receipt = (await api(`/actions/${card.id}`)).body;
    expect(receipt).toMatchObject({ outcome: 'outcome_unknown', retryAllowed: false });
    expect((await db('ib_pending_actions').where('id', card.id).first()).status).toBe('confirmed');
    expect((await confirm()).status).toBe(409);
    expect((await api(`/tasks/${proposed.body.taskId}/resume`, { session_id: sessionId })).body.code).toBe('steps_unresolved');
    expect(gmail.sendMessage).toHaveBeenCalledTimes(1);
  }, 30000);

  test('a server-selected bulk lead cohort is approved exactly; model fields and content cannot establish it', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    const old = new Date(Date.now() - 12001 * 86400000);
    // A previous failed synthetic run may have left eligible rows. The task
    // explicitly requests the whole current cohort, including those rows.
    const existingIds = await db('leads').where('status', 'unresponsive')
      .where('updated_at', '<', new Date(Date.now() - 12000 * 86400000)).pluck('id');
    await db('leads').insert(ids.map((id, index) => ({ id, first_name: 'Synthetic', last_name: `Bulk ${index}`,
      customer_id: index ? customerA : null, status: 'unresponsive', updated_at: old })));
    const params = { current_status: 'unresponsive', older_than_days: 12000, new_status: 'lost', lost_reason: 'Synthetic test' };
    const propose = (prompt, extra = {}, requestExtra = {}) => {
      mockModel.mockReset();
      mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'bulk update leads' }, 'discover'))
        .mockResolvedValueOnce(tools('bulk_update_leads', { ...params, ...extra }, 'bulk'))
        .mockResolvedValueOnce(answer('The selected lead changes await confirmation.'));
      return api('/query', request(prompt, requestExtra));
    };
    const prompt = 'Move all unresponsive leads older than 12000 days to lost';
    const Context = require('../services/intelligence-bar/task-context');
    expect((await Context.resolve({ prompt: 'Bulk update leads with status unresponsive to lost' })).bulkLeadRequest).toBe(true);
    for (const extra of [{ lead_ids: ids }, { _expect_full_set: true }, { _ib_task_context: { bulkLeadRequest: true } }]) {
      expect((await propose(prompt, extra)).body.pendingActions).toHaveLength(0);
    }
    for (const badPrompt of [`Update the note for ${nameA}: move all unresponsive leads to lost`, `Move all unresponsive leads for ${nameA} to lost`]) {
      expect((await propose(badPrompt)).body.pendingActions).toHaveLength(0);
    }
    expect((await propose('Show inbox', {}, { conversationHistory: [{ role: 'user', content: prompt }] })).body.pendingActions).toHaveLength(0);
    const proposed = await propose(prompt);
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    const stored = await db('ib_pending_actions').where('id', card.id).first();
    expect(new Set(stored.params.lead_ids)).toEqual(new Set([...existingIds, ...ids]));
    expect(stored.params._ib_task_context.targets).toEqual([]);
    for (const changed of [{ ...stored.params, lead_ids: [ids[0]] }, { ...stored.params, current_status: 'new' }]) {
      expect(await Context.validateRecordTarget(changed, stored.params._ib_task_context, { toolName: 'bulk_update_leads' }))
        .toMatchObject({ code: 'target_changed' });
    }
    expect(await Context.validateRecordTarget(stored.params, stored.params._ib_task_context, { toolName: 'bulk_update_customers' }))
      .toMatchObject({ code: 'target_changed' });
    const late = crypto.randomUUID();
    await db('leads').insert({ id: late, first_name: 'Synthetic', last_name: 'Late bulk', status: 'unresponsive', updated_at: old });
    const { previewBulkLeadUpdate } = require('../services/intelligence-bar/leads-tools');
    const recheck = await previewBulkLeadUpdate({ current_status: params.current_status,
      new_status: params.new_status, _approved_lead_ids: ids });
    expect(new Set(recheck.matched_ids)).toEqual(new Set(ids));
    const confirmed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash,
      params: { lead_ids: [late] } });
    expect(confirmed.body).toMatchObject({ success: true, outcome: 'completed', result: { updated: existingIds.length + 2 } });
    expect((await db('leads').whereIn('id', ids)).every(row => row.status === 'lost')).toBe(true);
    expect((await db('leads').where('id', late).first()).status).toBe('unresponsive');
    expect(Number((await db('lead_activities').whereIn('lead_id', ids).count('* as n').first()).n)).toBe(2);
    // Retire only this synthetic unmatched fixture so it cannot join later cohorts.
    await db('leads').where('id', late).update({ status: 'lost' });
    expect((await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash })).status).toBe(409);
  }, 60000);

  test('bulk lead versions are checked under the write locks after confirmation validation', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await db('leads').insert(ids.map(id => ({ id, first_name: 'Synthetic', last_name: 'Version bulk',
      status: 'unresponsive', updated_at: new Date(Date.now() - 13001 * 86400000) })));
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'bulk update leads' }, 'discover'))
      .mockResolvedValueOnce(tools('bulk_update_leads', { current_status: 'unresponsive', older_than_days: 13000, new_status: 'lost' }, 'bulk'))
      .mockResolvedValueOnce(answer('Bulk update awaiting approval.'));
    const proposed = await api('/query', request('Move all unresponsive leads older than 13000 days to lost'));
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    const Context = require('../services/intelligence-bar/task-context');
    const validate = Context.validateRecordTarget;
    const race = jest.spyOn(Context, 'validateRecordTarget').mockImplementationOnce(async (...args) => {
      const result = await validate(...args);
      // Keep status and age eligibility but invalidate the approved row version.
      await db('leads').where('id', ids[0]).update({ last_name: 'Changed after approval', updated_at: new Date(Date.now() - 13000.5 * 86400000) });
      return result;
    });
    try {
      const confirmed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
      expect(confirmed.body).toMatchObject({ success: false, outcome: 'failed', result: { preview_changed: true } });
    } finally { race.mockRestore(); }
    expect((await db('leads').whereIn('id', ids)).every(row => row.status === 'unresponsive')).toBe(true);
    expect(Number((await db('lead_activities').whereIn('lead_id', ids).count('* as n').first()).n)).toBe(0);
    await db('leads').whereIn('id', ids).update({ status: 'lost' });
  }, 30000);

  test('duplicate first names and an unrecognized spoken name require clarification before writing', async () => {
    proposeNote(customerA, 'Needs target choice');
    const ambiguous = await api('/query', request('Add a note for Fixture'));
    expect(ambiguous.body.taskState).toBe('needs_information');
    expect(ambiguous.body.candidates.length).toBeGreaterThanOrEqual(2);
    proposeNote(customerA, 'Needs target choice');
    const typo = await api('/query', request('Add a note for Fixturr Alderr'));
    expect(typo.body.taskState).toBe('needs_information');
    expect(ambiguous.body.pendingActions).toHaveLength(0);
    expect(typo.body.pendingActions).toHaveLength(0);
  }, 30000);

  test('an ambiguous read stops before a model can pick either customer', async () => {
    mockModel.mockResolvedValue(tools('get_customer_detail', { customer_id: customerA }, 'guessed-read'));
    const result = await api('/query', request("Show me Fixture's details"));
    expect(result.body.taskState).toBe('needs_information');
    expect(result.body.candidates.length).toBeGreaterThanOrEqual(2);
    expect(mockModel).not.toHaveBeenCalled();
  }, 30000);

  test('stale page hints allow unrelated and named requests, but cannot supply a pronoun target', async () => {
    const pageData = { customerId: crypto.randomUUID() };
    mockModel.mockResolvedValueOnce(answer('Revenue lookup fixture.'));
    expect((await api('/query', request('Show revenue summary', { pageData }))).body.taskState).toBe('responded');
    expect(mockModel).toHaveBeenCalledTimes(1);
    mockModel.mockClear();
    proposeNote(customerA, 'Named with stale page');
    const named = await api('/query', request(`Add a note for ${nameA}: Named with stale page`, { pageData }));
    expect(named.body.taskTarget.customer_id).toBe(customerA);
    expect(named.body.pendingActions).toHaveLength(1);
    mockModel.mockClear();
    const dependent = await api('/query', request('Read this customer', { pageData }));
    // A stale page record has no customer to choose: answered and closed, not parked (r16).
    expect(dependent.body).toMatchObject({ taskState: 'responded', candidates: [], pendingActions: [] });
    expect(dependent.body.response).toContain('unavailable');
    expect(mockModel).not.toHaveBeenCalled();
  }, 30000);

  test('request identity rejects changed payload; receipt and task recovery enforce current actor/session', async () => {
    mockModel.mockResolvedValueOnce(answer('No changes recorded.'));
    const input = request('Read this customer');
    const first = await api('/query', input);
    expect(first.status).toBe(200);
    const changed = await api('/query', { ...input, prompt: 'Change this customer' });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('request_changed');
    expect((await api(`/tasks/${first.body.taskId}?session_id=${crypto.randomUUID()}`)).status).toBe(404);
    await db('technicians').where('id', actor).update({ auth_token_version: 2 });
    expect((await api(`/tasks/${first.body.taskId}?session_id=${sessionId}`)).status).toBe(401);
    await db('technicians').where('id', actor).update({ auth_token_version: 1 });
  }, 30000);

  test('task-step dedupe, replay after worker replacement, and unknown outcomes are durable', async () => {
    const Tasks = require('../services/intelligence-bar/tasks');
    const Pending = require('../services/intelligence-bar/pending-actions');
    const started = await Tasks.begin({ actorId: actor, sessionId, requestKey: crypto.randomUUID(), request: { prompt: 'Synthetic task' } });
    const task = started.task;
    const options = { toolName: 'update_customer', params: { customer_id: customerA, updates: { notes: 'Synthetic' } },
      requestedBy: actor, taskId: task.id, runnerToken: task.runner_token, stepKey: 'synthetic-step' };
    const [one, two] = await Promise.all([Pending.createPendingAction(options), Pending.createPendingAction(options)]);
    expect(one.id).toBe(two.id);
    const claim = await Pending.claimForConfirm(one.id, actor);
    expect(claim.action.id).toBe(one.id);
    const receipt = await Pending.getActionReceipt(one.id, actor);
    expect(receipt).toMatchObject({ outcome: 'outcome_unknown', success: false, retryAllowed: false });
    expect((await Tasks.claimResume(task.id, actor, sessionId)).code).toBe('steps_unresolved');
    await db('ib_tasks').where('id', task.id).update({ runner_token: crypto.randomUUID() });
    await expect(Pending.createPendingAction({ ...options, stepKey: 'later-step' })).rejects.toThrow('superseded');
  }, 30000);

  test('direct and possessive names override the page; Mark and Bill used as verbs do not', async () => {
    const id = crypto.randomUUID();
    const firstName = `Avery${id.replace(/[^a-f]/g, '').slice(0, 12)}`;
    await db('customers').insert({ id, first_name: firstName, last_name: 'Synthetic', phone: `fixture-${id.slice(0, 8)}`, address_line1: '300 Example Grove' });
    await db('customers').insert(['Mark', 'Bill'].map(first_name => ({ first_name, last_name: 'Synthetic', phone: `fixture-${crypto.randomUUID().slice(0, 8)}` })));
    const Context = require('../services/intelligence-bar/task-context');
    for (const prompt of [`Email ${firstName} the details`, `Change ${firstName}’s address`]) {
      expect((await Context.resolve({ prompt, pageData: { customerId: customerB } })).target.customer_id).toBe(id);
    }
    for (const prompt of ['Mark this customer inactive', 'Bill this customer']) {
      expect((await Context.resolve({ prompt, pageData: { customerId: customerA } })).target.customer_id).toBe(customerA);
    }
    for (const prompt of [
      `Text this customer that ${nameA} is the technician scheduled to arrive tomorrow`,
      `Update this customer emergency contact name to ${nameA}`,
      `Add a note for this customer: email ${nameA} when arriving`,
    ]) {
      expect((await Context.resolve({ prompt, pageData: { customerId: customerB } })).target.customer_id).toBe(customerB);
    }
    expect((await Context.resolve({ prompt: `Update ${firstName} WrongSurname address`, pageData: { customerId: customerB } })).target).toBeNull();
  }, 30000);

  test('bulk customer IDs cannot bypass the task target', async () => {
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'bulk update customers' }, 'discover'))
      .mockResolvedValueOnce(tools('bulk_update_customers', { customer_ids: [customerB], updates: { notes: 'Must not write' } }, 'bulk'))
      .mockResolvedValueOnce(answer('Select the intended customer.'));
    const response = await api('/query', request(`Update notes for ${nameA}`));
    expect(response.body.taskState).toBe('needs_information');
    expect(response.body.pendingActions).toHaveLength(0);
  }, 30000);

  test('selecting a saved ambiguity candidate resumes the same task and original request', async () => {
    const first = await api('/query', request('Add the Selection regression note for Fixture', {
      conversationHistory: [{ role: 'user', content: 'Use the note draft from this conversation' },
        { role: 'assistant', content: 'Synthetic original note draft: Selection regression' }],
    }));
    expect(first.body.taskState).toBe('needs_information');
    expect(mockModel).not.toHaveBeenCalled();
    const selected = first.body.candidates[0].customer_id;
    proposeNote(selected, 'Selection regression');
    const resumed = await api(`/tasks/${first.body.taskId}/select-target`, { session_id: sessionId, customer_id: selected });
    expect(resumed.status).toBe(200);
    expect(resumed.body.taskId).toBe(first.body.taskId);
    expect(resumed.body.taskTarget.customer_id).toBe(selected);
    expect(resumed.body.pendingActions).toHaveLength(1);
    const stored = await db('ib_pending_actions').where('id', resumed.body.pendingActions[0].id).first('task_id');
    expect(stored.task_id).toBe(first.body.taskId);
    expect(JSON.stringify(mockModel.mock.calls.at(-1)[0].messages)).toContain('Selection regression');
    expect(JSON.stringify(mockModel.mock.calls[0][0].messages)).toContain('Synthetic original note draft');
  }, 30000);

  test('thread continuations preserve their cursor across model outages and refuse unseen concurrent appends', async () => {
    process.env.GATE_IB_THREADS = 'true';
    const Threads = require('../services/intelligence-bar/threads');
    const seed = await Threads.appendExchange({ actorId: actor, context: 'customers', userText: 'Synthetic seed', assistantText: 'Synthetic seed reply' });
    try {
      proposeNote(customerA, 'Thread note one');
      let result = await api('/query', request(`Add notes for ${nameA}`, { thread_id: seed.threadId, thread_seq: seed.lastSeq }));
      const taskId = result.body.taskId;
      expect(result.body).toMatchObject({ threadId: seed.threadId, threadSeq: 4 });
      const confirm = async response => {
        const card = response.body.pendingActions[0];
        expect((await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash })).body.outcome).toBe('completed');
      };
      await confirm(result);
      delete process.env.ANTHROPIC_API_KEY;
      expect((await api(`/tasks/${taskId}/resume`, { session_id: sessionId })).status).toBe(503);
      expect((await db('ib_tasks').where('id', taskId).first()).response).toMatchObject({ threadId: seed.threadId, threadSeq: 4 });
      process.env.ANTHROPIC_API_KEY = 'scripted-model-only';
      for (const [note, sequence] of [['Thread note two', 6], ['Thread note three', 8]]) {
        proposeNote(customerA, note);
        result = await api(`/tasks/${taskId}/resume`, { session_id: sessionId });
        expect(result.body).toMatchObject({ taskId, threadId: seed.threadId, threadSeq: sequence });
        await confirm(result);
      }
      // A continuation persists a distinct turn and returns history built on the delivered exchange:
      // the original request appears once, and the first reply is not dropped.
      const userTurns = await db('ib_thread_turns').where({ thread_id: seed.threadId, role: 'user' }).orderBy('seq');
      expect(userTurns.filter(turn => turn.content.startsWith(`Add notes for ${nameA}`))).toHaveLength(1);
      expect(userTurns.filter(turn => turn.content.startsWith('Continue the saved request'))).toHaveLength(2);
      const history = result.body.conversationHistory.map(turn => turn.content);
      expect(history.filter(content => content.startsWith(`Add notes for ${nameA}`))).toHaveLength(1);
      expect(history.filter(content => content.startsWith('Continue the saved request'))).toHaveLength(2);
      expect(history.some(content => content.includes('The note is awaiting confirmation.'))).toBe(true);
      const concurrent = await Threads.appendExchange({ actorId: actor, threadId: seed.threadId, expectedSeq: 8,
        context: 'customers', userText: 'Concurrent synthetic turn', assistantText: 'Another tab reply' });
      expect(concurrent.lastSeq).toBe(10);
      mockModel.mockResolvedValueOnce(answer('The requested notes are saved.'));
      const final = await api(`/tasks/${taskId}/resume`, { session_id: sessionId });
      expect(final.status).toBe(200);
      expect(final.body.threadId).toBeUndefined();
      expect(Number((await db('ib_thread_turns').where('thread_id', seed.threadId).max('seq as n').first()).n)).toBe(10);
    } finally {
      process.env.GATE_IB_THREADS = 'false'; process.env.ANTHROPIC_API_KEY = 'scripted-model-only';
    }
  }, 60000);

  test('review drafting and approval use the current customer and show identity without exposing execution pins', async () => {
    const own = crypto.randomUUID(), foreign = crypto.randomUUID();
    await db('google_reviews').insert([
      { id: own, google_review_id: own, customer_id: customerA, reviewer_name: 'Synthetic Own Review', location_id: 'bradenton', star_rating: 5, review_created_at: new Date(), review_text: 'Synthetic review' },
      { id: foreign, google_review_id: foreign, customer_id: customerB, reviewer_name: 'Synthetic Foreign Review', location_id: 'bradenton', star_rating: 5, review_created_at: new Date(), review_text: 'Foreign synthetic review' },
    ]);
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'draft review reply' }, 'discover'))
      .mockResolvedValueOnce(tools('draft_review_reply', { review_id: foreign }, 'draft'))
      .mockResolvedValueOnce(answer('That review does not belong to the selected customer.'));
    const refused = await api('/query', request(`Draft a review reply for ${nameA}`));
    expect(refused.body.pendingActions).toHaveLength(0);
    expect(mockModel).toHaveBeenCalledTimes(3); // No nested drafting model.
    expect(JSON.stringify(mockModel.mock.calls[2][0].messages.at(-1).content)).toContain('target_clarification_required');
    mockModel.mockReset();
    mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'submit review reply' }, 'discover'))
      .mockResolvedValueOnce(tools('submit_review_reply', { review_id: own, reply_text: 'Synthetic proposed reply', grounding_token: 'synthetic-no-provider-call' }, 'reply'))
      .mockResolvedValueOnce(answer('Review reply awaiting approval.'));
    const proposed = await api('/query', request(`Submit a review reply for ${nameA}`));
    expect(proposed.body.pendingActions).toHaveLength(1);
    const card = proposed.body.pendingActions[0];
    expect(JSON.stringify(card)).toContain('Synthetic Own Review');
    expect(JSON.stringify(card)).not.toContain('synthetic-no-provider-call');
    expect(JSON.stringify(mockModel.mock.calls)).not.toContain('_ib_review_pin');
    const pending = await db('ib_pending_actions').where('id', card.id).first();
    expect(pending.params._ib_review_pin.version).toBeTruthy();
    await db('google_reviews').where('id', own).update({ customer_id: customerB });
    const changed = await api('/confirm-action', { pending_action_id: card.id, contract_hash: card.contract_hash });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('target_changed');
    expect((await db('google_reviews').where('id', own).first()).review_reply).toBeNull();
  }, 30000);


  test('ambiguity selection before the first model call retains the original thread and sequence', async () => {
    process.env.GATE_IB_THREADS = 'true';
    const Threads = require('../services/intelligence-bar/threads');
    const seed = await Threads.appendExchange({ actorId: actor, context: 'customers', userText: 'Synthetic seed', assistantText: 'Synthetic seed reply' });
    const seeded = await Threads.appendExchange({ actorId: actor, threadId: seed.threadId, expectedSeq: seed.lastSeq,
      context: 'customers', userText: 'Synthetic second turn', assistantText: 'Synthetic second reply' });
    try {
      const first = await api('/query', request('Add a note for Fixture', { thread_id: seeded.threadId, thread_seq: seeded.lastSeq }));
      expect(first.body.taskState).toBe('needs_information');
      expect(mockModel).not.toHaveBeenCalled();
      const selected = first.body.candidates[0].customer_id;
      proposeNote(selected, 'Synthetic thread selection');
      const resumed = await api(`/tasks/${first.body.taskId}/select-target`, { session_id: sessionId, customer_id: selected });
      expect(resumed.body).toMatchObject({ taskId: first.body.taskId, threadId: seed.threadId, threadSeq: 6 });
      expect((await db('ib_tasks').where('id', first.body.taskId).first()).request)
        .toMatchObject({ thread_id: seed.threadId, thread_seq: 4 });
    } finally { process.env.GATE_IB_THREADS = 'false'; }
  }, 30000);

});
