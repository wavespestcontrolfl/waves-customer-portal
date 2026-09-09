// Real PostgreSQL regression checks; only isolated QA or CI databases.
// Owner alerts are doubles; lead/customer reads, locks and database writes are real.
// SMS handoff coverage belongs to the separate real canonical-pipeline suite.
const { randomUUID } = require('node:crypto');
const mockSend = jest.fn();
const mockMessage = jest.fn();
jest.mock('../services/twilio', () => ({ sendSMS: mockSend }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: mockMessage }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn() }));

const SKIP = !process.env.DATABASE_URL;
(SKIP ? describe.skip : describe)('lead tool integrity (PostgreSQL)', () => {
  let db;
  let executeLeadTool;
  const customerId = randomUUID();
  const foreignCustomerId = randomUUID();
  const leadId = randomUUID();
  const context = { customerId, leadId, sessionId: randomUUID(), toolUseId: randomUUID() };
  const input = { reason: 'QA review', draft_response: 'Synthetic draft', urgency: 'normal' };
  const previousPhone = process.env.ADAM_PHONE;

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const expected = `/waves_qa_${(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    const managedQa = process.env.WAVES_LOCAL_DEV === '1' && !!process.env.WAVES_WORKTREE_ID && url.pathname === expected;
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!managedQa && !ciTest) throw new Error('Use the managed worktree-owned QA database or the isolated CI database for PostgreSQL tests.');
    db = require('../models/db');
    ({ executeLeadTool } = require('../services/lead-response-tools'));
    await db.transaction(async trx => {
      await trx('customers').insert([customerId, foreignCustomerId].map(id => ({
        id, first_name: 'QA', last_name: 'Integrity', active: true,
        email: `qa-integrity-${id}@example.invalid`, phone: '+19415550100',
      })));
      await trx('leads').insert({ id: leadId, customer_id: customerId, first_name: 'QA', phone: '+19415550100' });
    });
    process.env.ADAM_PHONE = '+19415550101';
  }, 30000);

  beforeEach(async () => {
    mockSend.mockReset();
    mockMessage.mockReset().mockResolvedValue({ sent: false, blocked: true, code: 'QA_BLOCKED' });
    mockSend.mockImplementation(async () => {
      // The alert must observe committed data from its separate DB connection.
      expect(await db('lead_activities').where({ lead_id: leadId, activity_type: 'draft_queued' }).first()).toBeTruthy();
      return { success: true, sid: 'SM_qa_integrity' };
    });
    await db('customer_interactions').whereIn('customer_id', [customerId, foreignCustomerId]).del();
    await db('estimates').where({ customer_id: customerId, source: 'lead_agent' }).del();
    await db('customers').whereIn('id', [customerId, foreignCustomerId]).update({ pipeline_stage: 'new_lead' });
    await db('lead_activities').where({ lead_id: leadId }).del();
    await db('lead_agent_responses').where({ lead_id: leadId }).del();
    await db('leads').where({ id: leadId }).update({ customer_id: customerId, deleted_at: null });
  });

  afterAll(async () => {
    if (previousPhone === undefined) delete process.env.ADAM_PHONE;
    else process.env.ADAM_PHONE = previousPhone;
    if (!db) return;
    try {
      await db.transaction(async trx => {
        await trx('customer_interactions').whereIn('customer_id', [customerId, foreignCustomerId]).del();
        await trx('estimates').where({ customer_id: customerId, source: 'lead_agent' }).del();
        await trx('lead_agent_responses').where({ lead_id: leadId }).del();
        await trx('lead_activities').where({ lead_id: leadId }).del();
        await trx('leads').where({ id: leadId }).del();
        await trx('customers').whereIn('id', [customerId, foreignCustomerId])
          .where('email', 'like', 'qa-integrity-%@example.invalid').del();
      });
      expect(await db('leads').where({ id: leadId }).first()).toBeUndefined();
      expect(await db('customers').whereIn('id', [customerId, foreignCustomerId])).toHaveLength(0);
    } finally { await db.destroy(); }
  }, 30000);

  test('concurrent replays commit one draft and alert once', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => executeLeadTool('queue_for_adam', input, context)));
    expect(results.every(result => result.queued)).toBe(true);
    expect(new Set(results.map(result => result.activityId)).size).toBe(1);
    expect(results.filter(result => result.replayed)).toHaveLength(5);
    expect(results.find(result => !result.replayed).alertStatus).toBe('sent');
    expect(await db('lead_activities').where({ lead_id: leadId, activity_type: 'draft_queued' })).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
  }, 30000);

  test('distinct invocations remain distinct under concurrency', async () => {
    const results = await Promise.all([context, { ...context, toolUseId: randomUUID() }, { ...context, sessionId: randomUUID() }]
      .map(assigned => executeLeadTool('queue_for_adam', input, assigned)));
    expect(new Set(results.map(result => result.activityId)).size).toBe(3);
    expect(results.every(result => result.alertStatus === 'sent')).toBe(true);
    expect(await db('lead_activities').where({ lead_id: leadId })).toHaveLength(3);
    expect(mockSend).toHaveBeenCalledTimes(3);
  }, 30000);

  test('PostgreSQL insert rejection leaves no draft or alert, then retry succeeds', async () => {
    // PostgreSQL text rejects NUL; this exercises an actual failed statement.
    await expect(executeLeadTool('queue_for_adam', { ...input, reason: 'QA\u0000reject' }, context)).rejects.toThrow();
    expect(await db('lead_activities').where({ lead_id: leadId })).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(await executeLeadTool('queue_for_adam', input, context)).toMatchObject({ queued: true, alertStatus: 'sent' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  test('alert failure preserves the draft and retry records delivery before closing replay', async () => {
    mockSend.mockRejectedValueOnce(new Error('QA provider unavailable'));
    const first = await executeLeadTool('queue_for_adam', input, context);
    expect(first).toMatchObject({ queued: true, alertStatus: 'failed', failed: true, retryable: true });
    expect(await executeLeadTool('queue_for_adam', input, context)).toMatchObject({ queued: true, replayed: true, activityId: first.activityId, alertStatus: 'sent' });
    expect(await executeLeadTool('queue_for_adam', input, context)).toMatchObject({ queued: true, replayed: true, alertStatus: 'sent' });
    expect(await db('lead_activities').where({ lead_id: leadId })).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  test.each(['before_send', 'abandoned_claim'])('a retry recovers a process exit at %s', async crash => {
    const metadata = { sessionId: context.sessionId, toolUseId: context.toolUseId, draftResponse: input.draft_response, reason: input.reason };
    if (crash === 'abandoned_claim') Object.assign(metadata, { alertClaimToken: randomUUID(), alertLeaseUntil: new Date(Date.now() - 1000).toISOString() });
    await db('lead_activities').insert({ lead_id: leadId, activity_type: 'draft_queued', description: 'Synthetic abandoned draft', metadata: JSON.stringify(metadata) });
    expect(await executeLeadTool('queue_for_adam', input, context)).toMatchObject({ queued: true, replayed: true, alertStatus: 'sent' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    const saved = await db('lead_activities').where({ lead_id: leadId }).first();
    expect(saved.metadata.alertStatus).toBe('sent');
    expect(saved.metadata.alertClaimToken).toBeUndefined();
  });

  test('foreign, deleted and reassigned subjects cannot create a draft', async () => {
    expect(await executeLeadTool('queue_for_adam', { ...input, customer_id: foreignCustomerId }, context)).toHaveProperty('error');
    await db('leads').where({ id: leadId }).update({ deleted_at: new Date() });
    expect(await executeLeadTool('queue_for_adam', input, context)).toHaveProperty('error');
    await db('leads').where({ id: leadId }).update({ deleted_at: null, customer_id: foreignCustomerId });
    expect(await executeLeadTool('queue_for_adam', input, context)).toHaveProperty('error');
    expect(await db('lead_activities').where({ lead_id: leadId })).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  test.each(['queue_for_adam', 'update_lead_pipeline', 'flag_for_estimate', 'save_lead_response_report']
    .flatMap(tool => ['reassign', 'archive'].map(change => [tool, change])))(
    '%s refuses %s while waiting for the lead lock', async (tool, change) => {
    const holder = await db.transaction();
    let started;
    let timer;
    let pending;
    const waiting = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Queue did not attempt its lead row lock')), 10000);
      started = query => {
        if (query.sql.includes('"leads"') && /for (?:no key )?update/.test(query.sql)) resolve();
      };
    });
    try {
      await holder('leads').where({ id: leadId }).forUpdate().first();
      db.on('query', started);
      pending = executeLeadTool(tool, { ...input, stage: 'won', message: 'Synthetic reply' }, context);
      await waiting;
      await holder('leads').where({ id: leadId }).update(change === 'reassign' ? { customer_id: foreignCustomerId } : { deleted_at: new Date() });
      await holder.commit();
      expect(await pending).toHaveProperty('error');
      expect(await db('lead_activities').where({ lead_id: leadId })).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
      expect(mockMessage).not.toHaveBeenCalled();
      expect(await db('lead_agent_responses').where({ lead_id: leadId })).toHaveLength(0);
      expect(await db('estimates').where({ customer_id: customerId, source: 'lead_agent' })).toHaveLength(0);
      expect((await db('customers').where({ id: customerId }).first()).pipeline_stage).toBe('new_lead');
    } finally {
      clearTimeout(timer);
      db.removeListener('query', started);
      if (!holder.isCompleted()) await holder.rollback();
      if (pending) await pending.catch(() => {});
    }
  }, 30000);

  test.each(['update_lead_pipeline'])('%s follows Customer 360 customer-before-lead lock order', async tool => {
    const editor = await db.transaction();
    let started;
    let timer;
    let pending;
    const waiting = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Tool did not attempt its customer lock')), 10000);
      started = query => { if (query.sql.includes('"customers"') && query.sql.includes('for no key update')) resolve(); };
    });
    try {
      await editor('customers').where({ id: customerId }).forUpdate().first();
      db.on('query', started);
      pending = executeLeadTool(tool, { stage: 'won', message: 'Synthetic reply' }, context);
      await waiting;
      await editor.raw("SET LOCAL lock_timeout = '1s'");
      await editor('leads').where({ id: leadId }).update({ first_name: 'QA updated' });
      await editor.commit();
      expect(await pending).toMatchObject({ updated: true });
      expect((await db('leads').where({ id: leadId }).first()).first_name).toBe('QA updated');
      expect((await db('customers').where({ id: customerId }).first()).pipeline_stage).toBe('won');
    } finally {
      clearTimeout(timer);
      db.removeListener('query', started);
      if (!editor.isCompleted()) await editor.rollback();
      if (pending) await pending.catch(() => {});
    }
  }, 30000);

  test('pipeline and interaction writes roll back with a rejected note, then commit together', async () => {
    const logger = require('../services/logger');
    logger.info.mockClear();
    await expect(executeLeadTool('update_lead_pipeline', { stage: 'won', note: 'QA\u0000reject' }, context)).rejects.toThrow();
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringMatching(/^Pipeline:/));
    expect((await db('customers').where({ id: customerId }).first()).pipeline_stage).toBe('new_lead');
    expect(await db('customer_interactions').where({ customer_id: customerId })).toHaveLength(0);
    expect(await executeLeadTool('update_lead_pipeline', { stage: 'won', note: 'QA transition' }, context)).toMatchObject({ updated: true });
    expect((await db('customers').where({ id: customerId }).first()).pipeline_stage).toBe('won');
    expect(await db('customer_interactions').where({ customer_id: customerId })).toHaveLength(1);
    expect(await db('lead_activities').where({ lead_id: leadId, activity_type: 'pipeline_update' })).toHaveLength(1);
  });

  test('a failed report insert reports unsaved and a valid retry persists once', async () => {
    const report = { action_taken: 'queued_for_adam', response_message: 'Synthetic response', triage_summary: 'QA' };
    expect(await executeLeadTool('save_lead_response_report', { ...report, triage_summary: 'QA\u0000reject' }, context))
      .toMatchObject({ saved: false });
    expect(await db('lead_agent_responses').where({ lead_id: leadId })).toHaveLength(0);
    expect(await executeLeadTool('save_lead_response_report', report, context)).toEqual({ saved: true });
    expect(await db('lead_agent_responses').where({ lead_id: leadId, customer_id: customerId })).toHaveLength(1);
  });
});
