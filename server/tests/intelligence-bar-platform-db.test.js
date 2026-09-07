/** Real Postgres + real bearer auth + real domain executors. Only the model
 * adapter is scripted. Run with IB_TEST_DATABASE_URL naming an isolated
 * waves_ib_platform_* database; no production/provider credentials are used.
 */
const crypto = require('crypto');
const mockModel = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

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
    expect(confirmed.body).toMatchObject({ success: false, outcome: 'failed', result: { preview_changed: true } });
    expect((await db('customers').where('id', customerA).first('crm_notes')).crm_notes).toBe('Newer operator edit');
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
    const modelInput = JSON.stringify(mockModel.mock.calls[0][0].messages);
    expect(modelInput).toContain('server-verified step outcomes');
    expect(modelInput).toContain('Recovered pre-checkpoint note');
    expect(modelInput).not.toContain(card.id);
    expect(await db('ib_pending_actions').where('task_id', proposed.body.taskId).count('* as count').first()).toEqual({ count: '1' });
  }, 30000);

  test('an explicitly addressed inbox sender can receive a reply preview without a customer link', async () => {
    const vendorEmail = crypto.randomUUID(), otherEmail = crypto.randomUUID();
    await db('emails').insert([
      { id: vendorEmail, gmail_id: vendorEmail, gmail_thread_id: vendorEmail, from_address: 'fixture-supplier@vendor.example', received_at: new Date(), subject: 'Synthetic supply inquiry' },
      { id: otherEmail, gmail_id: otherEmail, gmail_thread_id: otherEmail, from_address: 'another-supplier@vendor.example', received_at: new Date(), subject: 'Unrelated inquiry' },
    ]);
    const propose = emailId => {
      mockModel.mockResolvedValueOnce(tools('discover_capabilities', { query: 'send email reply' }, 'discover'))
        .mockResolvedValueOnce(tools('send_email_reply', { email_id: emailId, body: 'Thank you for the information.' }, 'reply'))
        .mockResolvedValueOnce(answer('The reply is awaiting confirmation.'));
      return api('/query', request('Reply to fixture-supplier@vendor.example with thanks'));
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
    expect(dependent.body.taskState).toBe('needs_information');
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
});
