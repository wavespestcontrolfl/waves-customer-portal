/** Real isolated Postgres tests for the task/receipt ledger. No model, domain
 * send, or provider is called; recorded outcomes below are synthetic fixtures. */
const crypto = require('crypto');
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite('IB task recovery and retained approval proof in isolated Postgres', () => {
  let db, Tasks, Pending;
  const actorId = crypto.randomUUID(), sessionId = crypto.randomUUID();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const begin = (request = { prompt: 'Synthetic ledger request' }, requestKey = crypto.randomUUID(), pageContext = {}) =>
    Tasks.begin({ actorId, sessionId, requestKey, request, pageContext });
  const proposal = (task, step = 'first') => Pending.createPendingAction({
    toolName: 'send_sms', requestedBy: actorId, taskId: task.id, runnerToken: task.runner_token, stepKey: step,
    summary: 'Synthetic ledger proposal only', params: { phone: '+15550101234', message: 'Synthetic fixture; never sent',
      _ib_task_context: { targets: [], explicitPhones: ['5550101234'], requestPhrase: 'Private full request',
        candidates: [{ label: 'Private candidate', address: 'Private address' }], page: { records: { detail: 'Private page data' } } } },
  });
  const expireLease = id => db('ib_tasks').where('id', id).update({ lease_expires_at: new Date(Date.now() - 1000) });

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    const ciDatabase = process.env.CI === 'true' && parsed.hostname === 'localhost' && parsed.pathname === '/waves_test';
    if (!ciDatabase && !/^\/waves_ib_platform_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    process.env.DATABASE_URL = databaseUrl;
    db = require('../models/db');
    if (!(await db.schema.hasTable('ib_tasks'))) throw new Error('Apply the task migration to the isolated database first');
    Tasks = require('../services/intelligence-bar/tasks');
    Pending = require('../services/intelligence-bar/pending-actions');
  }, 30000);
  afterAll(async () => {
    if (db) {
      await db('ib_pending_actions').where('requested_by', actorId).del();
      await db('ib_tasks').where('actor_id', actorId).del();
      await db.destroy();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  test('request identity dedupes replay, rejects changed details and scopes reads by actor/session', async () => {
    const request = { prompt: 'Synthetic identity request', thread_id: crypto.randomUUID(), thread_seq: 4 };
    const key = crypto.randomUUID();
    const first = await begin(request, key), repeated = await begin(request, key);
    expect(first.created).toBe(true);
    expect(repeated).toMatchObject({ created: false, task: { id: first.task.id } });
    expect((await begin({ ...request, prompt: 'Changed request' }, key)).code).toBe('request_changed');
    expect((await Tasks.get(first.task.id, actorId, sessionId)).request).toMatchObject(request);
    expect(await Tasks.get(first.task.id, crypto.randomUUID(), sessionId)).toBeUndefined();
    expect(await Tasks.get(first.task.id, actorId, crypto.randomUUID())).toBeUndefined();
  });

  test('request replay rejects changed page context but accepts the same context with reordered keys', async () => {
    const key = crypto.randomUUID(), customer = crypto.randomUUID(), other = crypto.randomUUID();
    const request = { prompt: 'Update this customer' };
    const first = await begin(request, key, { customer_id: customer, pathname: '/admin/customers' });
    expect((await begin(request, key, { pathname: '/admin/customers', customer_id: customer })).task.id).toBe(first.task.id);
    expect((await begin(request, key, { customer_id: other, pathname: '/admin/customers' })).code).toBe('request_changed');
    const stored = await Tasks.get(first.task.id, actorId, sessionId);
    expect(stored.page_context.customer_id).toBe(customer);
    expect((await db('ib_tasks').where({ actor_id: actorId, request_key: key })).length).toBe(1);
  });

  test('one task cannot propose a dependent write before a successful recorded predecessor', async () => {
    const { task } = await begin();
    const first = await proposal(task);
    expect((await proposal(task)).id).toBe(first.id);
    await expect(proposal(task, 'second')).rejects.toThrow(/preceding action/);
    await Pending.claimForConfirm(first.id, actorId);
    expect((await Pending.getActionReceipt(first.id, actorId)).outcome).toBe('outcome_unknown');
    await expect(proposal(task, 'second')).rejects.toThrow(/preceding action/);
    await Pending.recordResult(first.id, { state: 'provider_accepted', providerMessageId: 'synthetic-ledger-receipt' });
    const next = await proposal(task, 'second');
    expect(next.id).not.toBe(first.id);
    expect((await Pending.claimForConfirm(first.id, actorId)).error).toBe('already_used');
  });

  test('resumed SMS aliases return the accepted receipt, including a legacy domestic step key', async () => {
    const { task } = await begin();
    const params = { phone: '5550101234', message: 'Synthetic dedupe; never sent' };
    const create = (runner, phone) => Pending.createPendingAction({
      toolName: 'send_sms', requestedBy: actorId, taskId: task.id, runnerToken: runner.runner_token,
      stepKey: Pending.stepKey('send_sms', { ...params, phone }), params: { ...params, phone },
    });
    const original = await create(task, params.phone);
    // Existing persisted keys used domestic digits; they must still reconcile.
    const legacyKey = Pending.paramsHash('send_sms', { ...params, message_type: 'manual' });
    await db('ib_pending_actions').where('id', original.id).update({ step_key: legacyKey });
    await Pending.claimForConfirm(original.id, actorId);
    await Pending.recordResult(original.id, { state: 'provider_accepted', providerMessageId: 'synthetic-sms-receipt' });
    await expireLease(task.id);
    const resumed = await Tasks.claimResume(task.id, actorId, sessionId);
    for (const phone of ['+15550101234', '1 (555) 010-1234', '555-010-1234']) {
      const duplicate = await create(resumed.task, phone);
      expect(duplicate.id).toBe(original.id);
      expect(Pending.actionReceipt(duplicate).outcome).toBe('provider_accepted');
    }
    expect(await Pending.forTask(task.id, actorId)).toHaveLength(1);
    expect((await Pending.claimForConfirm(original.id, actorId)).error).toBe('already_used');
    expect(Pending.stepKey('send_sms', { ...params, phone: '+445550101234' }))
      .not.toBe(Pending.stepKey('send_sms', params));
  });

  test('persisted proposal proof omits resolution PII and survives the confirmation hash check', async () => {
    const { task } = await begin();
    const pending = await proposal(task);
    const row = await db('ib_pending_actions').where('id', pending.id).first();
    expect(JSON.stringify(row.params._ib_task_context)).not.toMatch(/Private|5550101234/);
    expect(row.params_hash).toBe(Pending.paramsHash(row.tool_name, row.params));
    expect((await Pending.claimForConfirm(row.id, actorId)).action.id).toBe(row.id);
    const Context = require('../services/intelligence-bar/task-context');
    expect(await Context.validateRecordTarget(row.params, row.params._ib_task_context, { toolName: row.tool_name })).toBeNull();
    expect((await Context.validateRecordTarget({ ...row.params, phone: '+15550105678' }, row.params._ib_task_context,
      { toolName: row.tool_name })).code).toBe('target_changed');
  });

  test('only one runner can resume; old runners cannot checkpoint or propose another action', async () => {
    const { task } = await begin();
    await expireLease(task.id);
    const attempts = await Promise.all([Tasks.claimResume(task.id, actorId, sessionId), Tasks.claimResume(task.id, actorId, sessionId)]);
    expect(attempts.filter(result => result.task)).toHaveLength(1);
    await expect(Tasks.checkpoint(task.id, actorId, { runnerToken: task.runner_token, state: 'responded' })).rejects.toThrow(/superseded/);
    await expect(proposal(task)).rejects.toThrow(/superseded/);
    for (const runnerToken of [undefined, '', 'invalid']) {
      await expect(Tasks.checkpoint(task.id, actorId, { runnerToken, state: 'responded',
        response: { response: 'Stale overwrite' } })).rejects.toThrow(/runner token/);
    }
    const current = attempts.find(result => result.task).task;
    expect((await Tasks.get(task.id, actorId, sessionId)).response).toBeNull();
    await Tasks.checkpoint(task.id, actorId, { runnerToken: current.runner_token, state: 'responded',
      response: { response: 'Current runner' } });
    expect((await Tasks.get(task.id, actorId, sessionId)).response).toMatchObject({ response: 'Current runner' });
  });

  test('finished reads and lost first-checkpoint images are not offered as resumable work', async () => {
    const { task: completed } = await begin();
    await Tasks.checkpoint(completed.id, actorId, { runnerToken: completed.runner_token, state: 'responded', response: { response: 'Synthetic read result' } });
    expect((await Tasks.snapshot(await Tasks.get(completed.id, actorId, sessionId), actorId)).canContinue).toBe(false);
    expect((await Tasks.claimResume(completed.id, actorId, sessionId)).code).toBe('not_resumable');
    const { task: attached } = await begin({ prompt: 'Synthetic attachment request', images: [{ data: 'ephemeral-fixture' }] });
    expect(attached.request.images).toBeUndefined();
    expect(attached.request.had_images).toBe(true);
    await expireLease(attached.id);
    expect((await Tasks.claimResume(attached.id, actorId, sessionId)).code).toBe('attachments_required');
  });

  test('expired legacy context is scrubbed even on orphaned receipts; live approval hashes and unknown outcomes survive', async () => {
    const { task: expired } = await begin(), { task: active } = await begin();
    const closed = await proposal(expired), live = await proposal(active);
    await Pending.claimForConfirm(closed.id, actorId);
    await Pending.recordResult(closed.id, { outcome_unknown: true, code: 'synthetic_timeout' });
    const past = new Date(Date.now() - 1000);
    const legacy = { phone: '+15550101234', message: 'Synthetic fixture', _ib_task_context: { requestPhrase: 'Private old context' } };
    await db('ib_pending_actions').where('id', closed.id).update({ params: JSON.stringify(legacy), expires_at: past, task_id: null });
    await db('ib_tasks').where('id', expired.id).update({ expires_at: past, lease_expires_at: past });
    const beforeLive = await db('ib_pending_actions').where('id', live.id).first();
    await Tasks.purgeExpiredTasks();
    const retained = await db('ib_pending_actions').where('id', closed.id).first();
    expect(retained.params).toEqual({ phone: legacy.phone, message: legacy.message });
    expect(retained.result).toMatchObject({ outcome_unknown: true });
    expect((await Pending.getActionReceipt(closed.id, actorId)).outcome).toBe('outcome_unknown');
    expect(await Pending.getActionReceipt(closed.id, crypto.randomUUID())).toBeNull();
    const afterLive = await db('ib_pending_actions').where('id', live.id).first();
    expect(afterLive.params).toEqual(beforeLive.params);
    expect(afterLive.params_hash).toBe(beforeLive.params_hash);
    expect((await Pending.claimForConfirm(live.id, actorId)).action.id).toBe(live.id);
    expect(await db('ib_tasks').where('id', expired.id).first()).toBeUndefined();
    expect(await db('ib_tasks').where('id', active.id).first()).toBeTruthy();
  });
});
