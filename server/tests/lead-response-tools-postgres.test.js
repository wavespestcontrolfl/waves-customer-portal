// Real PostgreSQL regression checks; only isolated QA or CI databases.
// Provider delivery is a double; lead/customer reads, locks and writes are real.
const { randomUUID } = require('node:crypto');
const mockSend = jest.fn();
jest.mock('../services/twilio', () => ({ sendSMS: mockSend }));
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
    mockSend.mockImplementation(async () => {
      // The alert must observe committed data from its separate DB connection.
      expect(await db('lead_activities').where({ lead_id: leadId, activity_type: 'draft_queued' }).first()).toBeTruthy();
      return { success: true, sid: 'SM_qa_integrity' };
    });
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

  test('alert failure preserves the committed draft and replay does not alert twice', async () => {
    mockSend.mockRejectedValue(new Error('QA provider unavailable'));
    const first = await executeLeadTool('queue_for_adam', input, context);
    expect(first).toMatchObject({ queued: true, alertStatus: 'failed' });
    expect(await executeLeadTool('queue_for_adam', input, context)).toMatchObject({ queued: true, replayed: true, activityId: first.activityId });
    expect(await db('lead_activities').where({ lead_id: leadId })).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(1);
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

  test('reassignment while the queue waits for its row lock rejects the stale subject', async () => {
    const holder = await db.transaction();
    let started;
    let timer;
    let pending;
    const waiting = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Queue did not attempt its lead row lock')), 10000);
      started = query => {
        if (query.sql.includes('"leads"') && query.sql.includes('for update')) resolve();
      };
    });
    try {
      await holder('leads').where({ id: leadId }).forUpdate().first();
      db.on('query', started);
      pending = executeLeadTool('queue_for_adam', input, context);
      await waiting;
      await holder('leads').where({ id: leadId }).update({ customer_id: foreignCustomerId });
      await holder.commit();
      expect(await pending).toHaveProperty('error');
      expect(await db('lead_activities').where({ lead_id: leadId })).toHaveLength(0);
      expect(mockSend).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      db.removeListener('query', started);
      if (!holder.isCompleted()) await holder.rollback();
      if (pending) await pending.catch(() => {});
    }
  }, 30000);

  test('a failed report insert reports unsaved and a valid retry persists once', async () => {
    const report = { action_taken: 'queued_for_adam', response_message: 'Synthetic response', triage_summary: 'QA' };
    expect(await executeLeadTool('save_lead_response_report', { ...report, triage_summary: 'QA\u0000reject' }, context))
      .toMatchObject({ saved: false });
    expect(await db('lead_agent_responses').where({ lead_id: leadId })).toHaveLength(0);
    expect(await executeLeadTool('save_lead_response_report', report, context)).toEqual({ saved: true });
    expect(await db('lead_agent_responses').where({ lead_id: leadId, customer_id: customerId })).toHaveLength(1);
  });
});
