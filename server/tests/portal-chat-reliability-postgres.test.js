// Portal chat retry/serialization against an isolated PostgreSQL schema.
// The suite is opt-in and never falls back to an application's DATABASE_URL.
const knexFactory = require('knex');
const { createHash, randomUUID } = require('node:crypto');

let mockApp;
let mockTransactionCalls = 0;
jest.mock('../models/db', () => {
  const database = (...args) => mockApp(...args);
  database.transaction = (...args) => {
    mockTransactionCalls += 1;
    return mockApp.transaction(...args);
  };
  database.raw = (...args) => mockApp.raw(...args);
  Object.defineProperty(database, 'fn', { get: () => mockApp.fn });
  Object.defineProperty(database, 'client', { get: () => mockApp.client });
  return database;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const migration = require('../models/migrations/20261002230000_portal_chat_requests');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');
const { runPortalTurn, turnScopeKey } = require('../services/ai-assistant/portal-turn');

const url = process.env.PORTAL_CHAT_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const schema = `portal_chat_${randomUUID().replaceAll('-', '')}`;
const customerId = randomUUID();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

jest.setTimeout(30_000);
postgres('portal chat durable turns (PostgreSQL)', () => {
  let admin;

  beforeAll(async () => {
    const target = new URL(url);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true'
      && ['localhost', '127.0.0.1'].includes(target.hostname)
      && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');

    admin = knexFactory({ client: 'pg', connection: url, pool: { min: 0, max: 1 } });
    await admin.schema.createSchema(schema);
    mockApp = knexFactory({ client: 'pg', connection: url, searchPath: [schema], pool: { min: 0, max: 3 } });
    await mockApp.schema.createTable('customers', (t) => {
      t.uuid('id').primary();
    });
    await mockApp.schema.createTable('agent_sessions', (t) => {
      t.uuid('id').primary().defaultTo(mockApp.raw('gen_random_uuid()'));
    });
    await mockApp.schema.createTable('agent_messages', (t) => {
      t.uuid('id').primary().defaultTo(mockApp.raw('gen_random_uuid()'));
      t.uuid('conversation_id').references('id').inTable('agent_sessions').onDelete('CASCADE');
      t.string('role');
    });
    await mockApp.schema.createTable('ai_escalations', (t) => {
      t.uuid('id').primary().defaultTo(mockApp.raw('gen_random_uuid()'));
      t.uuid('conversation_id').references('id').inTable('agent_sessions').onDelete('CASCADE');
      t.uuid('customer_id').references('id').inTable('customers').onDelete('SET NULL');
    });
    await mockApp('customers').insert({ id: customerId });
    await migration.up(mockApp);
  });

  beforeEach(async () => {
    await mockApp('ai_escalations').del();
    await mockApp('agent_messages').del();
    await mockApp('portal_chat_requests').del();
    mockTransactionCalls = 0;
  });

  afterAll(async () => {
    if (mockApp) await mockApp.destroy();
    if (admin) {
      await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
      await admin.destroy();
    }
  });

  const args = (requestId, processTurn, extra = {}) => ({
    requestId,
    customerId,
    channelIdentifier: 'browser-session',
    message: 'Please help',
    processTurn,
    budgetMs: 4_000,
    ...extra,
  });

  test('same request retry replays one response and creates one escalation', async () => {
    const requestId = randomUUID();
    let calls = 0;
    const processTurn = async (turn) => {
      calls += 1;
      await pause(80);
      await turn.transaction('test escalation', (trx) => trx('ai_escalations').insert({
        customer_id: customerId,
        portal_chat_request_id: turn.requestRowId,
      }));
      return { reply: 'Saved for the team.', escalated: true, escalationId: 'synthetic' };
    };

    const [first, retry] = await Promise.all([
      runPortalTurn(args(requestId, processTurn)),
      runPortalTurn(args(requestId, processTurn)),
    ]);

    expect(first).toEqual(retry);
    expect(first.requestId).toBe(requestId);
    expect(calls).toBe(1);
    expect(await mockApp('ai_escalations').count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('different requests in one conversation never run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const processTurn = (name) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${name}`);
      if (name === 'one') markFirstStarted();
      await pause(90);
      order.push(`end:${name}`);
      active -= 1;
      return { reply: name, escalated: false };
    };

    const one = runPortalTurn(args(randomUUID(), processTurn('one')));
    await firstStarted;
    const two = runPortalTurn(args(randomUUID(), processTurn('two'), { message: 'Second question' }));
    expect((await Promise.all([one, two])).map((r) => r.reply)).toEqual(['one', 'two']);
    expect(maxActive).toBe(1);
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  test('a deadline fences a late continuation before it can write', async () => {
    const requestId = randomUUID();
    const response = await runPortalTurn(args(requestId, async (turn) => {
      await pause(2_600);
      await turn.query(mockApp('ai_escalations').insert({
        customer_id: customerId,
        portal_chat_request_id: turn.requestRowId,
      }), 'late escalation');
      return { reply: 'late', escalated: true };
    }, { budgetMs: 3_000 }));

    expect(response.reply).toMatch(/trouble getting that answer/);
    expect(response.reply).toContain(WAVES_SUPPORT_PHONE_DISPLAY);
    await pause(150);
    expect(await mockApp('ai_escalations').count('* as n').first()).toMatchObject({ n: '0' });
    const receipt = await mockApp('portal_chat_requests').where({ request_id: requestId }).first();
    expect(receipt.state).toBe('completed');
  });

  test('a timed-out statement rolls back and its connection is released only after cancellation', async () => {
    const requestId = randomUUID();
    const started = Date.now();
    const response = await runPortalTurn(args(requestId, async (turn) => {
      await turn.transaction('slow guarded write', async (trx) => {
        await trx.raw('SELECT pg_sleep(3)');
        await trx('ai_escalations').insert({
          customer_id: customerId,
          portal_chat_request_id: turn.requestRowId,
        });
      });
      return { reply: 'late', escalated: true };
    }, { budgetMs: 2_000 }));

    expect(response.reply).toMatch(/trouble getting that answer/);
    expect(Date.now() - started).toBeLessThan(2_500);
    await pause(100);
    expect(await mockApp('ai_escalations').count('* as n').first()).toMatchObject({ n: '0' });
    for (let attempt = 0; attempt < 10 && mockApp.client.pool.numUsed() > 0; attempt += 1) {
      await pause(50);
    }
    expect(mockApp.client.pool.numUsed()).toBe(0);
    expect(mockApp.client.pool.numPendingAcquires()).toBe(0);
  });

  test('a claim transaction carries a server deadline through commit', async () => {
    const requestId = randomUUID();
    await mockApp.schema.createTable('portal_claim_deadlines', (table) => table.text('value'));
    await mockApp.raw(`
      CREATE FUNCTION record_portal_claim_commit_deadline() RETURNS trigger AS $$
      BEGIN
        INSERT INTO portal_claim_deadlines (value) VALUES (current_setting('statement_timeout'));
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE CONSTRAINT TRIGGER record_portal_claim_commit_deadline_trigger
      AFTER UPDATE ON portal_chat_requests
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      WHEN (NEW.state = 'processing' AND OLD.state = 'pending')
      EXECUTE FUNCTION record_portal_claim_commit_deadline()
    `);

    try {
      const response = await runPortalTurn(args(requestId, async () => ({ reply: 'bounded claim', escalated: false })));
      expect(response).toMatchObject({ reply: 'bounded claim', requestId });
      const recorded = await mockApp('portal_claim_deadlines').first('value');
      expect(recorded.value).toMatch(/^\d+ms$/);
      expect(recorded.value).not.toBe('0ms');
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS record_portal_claim_commit_deadline_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS record_portal_claim_commit_deadline()');
      await mockApp.schema.dropTableIfExists('portal_claim_deadlines');
    }
  });

  test('method-style transaction builders use the current turn deadline', async () => {
    const requestId = randomUUID();
    let firstTimeout;
    let secondTimeout;
    let cancelOnTimeout;
    const response = await runPortalTurn(args(requestId, async (turn) => {
      await turn.transaction('method-style bounded query', async (trx) => {
        const first = trx.select(mockApp.raw('1 AS value'));
        firstTimeout = first._timeout;
        cancelOnTimeout = first._cancelOnTimeout;
        await first;
        await pause(150);
        const second = trx.select(mockApp.raw('2 AS value'));
        secondTimeout = second._timeout;
        await second;
      });
      return { reply: 'bounded', escalated: false };
    }, { budgetMs: 2_500 }));

    expect(response).toMatchObject({ reply: 'bounded', requestId });
    expect(firstTimeout).toBeGreaterThan(0);
    expect(secondTimeout).toBeLessThan(firstTimeout);
    expect(cancelOnTimeout).toBe(true);
  });

  test('a card completed before the next model round hangs rides the timeout reply', async () => {
    let cardBuilt = false;
    const response = await runPortalTurn(args(randomUUID(), async (turn) => {
      const actions = [{ type: 'tab', label: 'Open Billing', tab: 'billing' }];
      const cards = [{ type: 'payments', title: 'Your most recent payment', rows: [{ id: 'p1' }] }];
      turn.registerFallbackExtras(() => ({ actions, cards }));
      cardBuilt = true;
      await turn.waitFor(() => new Promise(() => {}), 'next model round');
      return { reply: 'late', escalated: false };
    }, { budgetMs: 2_000 }));

    expect(cardBuilt).toBe(true);
    expect(response.reply).toMatch(/trouble getting that answer/);
    expect(response.actions).toEqual([{ type: 'tab', label: 'Open Billing', tab: 'billing' }]);
    expect(response.cards).toEqual([expect.objectContaining({ type: 'payments' })]);
  });

  test('a normal result survives failed receipt completion and replays without rerunning', async () => {
    const requestId = randomUUID();
    let processCalls = 0;
    const normal = {
      reply: 'Your next service is Tuesday morning.',
      conversationId: null,
      escalated: false,
      generated: true,
      actions: [{ type: 'tab', label: 'Open Schedule', tab: 'schedule' }],
    };
    await mockApp.raw(`
      CREATE FUNCTION reject_normal_reply_completion() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'completed' AND OLD.state <> 'completed' THEN
          RAISE EXCEPTION 'synthetic normal completion failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE TRIGGER reject_normal_reply_completion_trigger
      BEFORE UPDATE ON portal_chat_requests
      FOR EACH ROW EXECUTE FUNCTION reject_normal_reply_completion()
    `);

    try {
      const first = await runPortalTurn(args(requestId, async () => {
        processCalls += 1;
        return normal;
      }));
      expect(first).toEqual({ ...normal, requestId });
      expect(processCalls).toBe(1);

      const checkpoint = await mockApp('portal_chat_requests').where({ request_id: requestId }).first();
      expect(checkpoint.state).toBe('processing');
      expect(checkpoint.response).toEqual({ ...normal, requestId });
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS reject_normal_reply_completion_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS reject_normal_reply_completion()');
    }

    const replay = await runPortalTurn(args(requestId, async () => {
      processCalls += 1;
      return { reply: 'must not rerun', escalated: false };
    }));
    expect(replay).toEqual({ ...normal, requestId });
    expect(processCalls).toBe(1);
    expect((await mockApp('portal_chat_requests').where({ request_id: requestId }).first()).state)
      .toBe('completed');
  });

  test('a successful result survives an unavailable receipt checkpoint', async () => {
    const requestId = randomUUID();
    let processCalls = 0;
    const normal = {
      reply: 'This exact successful answer must still be returned.',
      conversationId: null,
      escalated: false,
      generated: true,
    };
    await mockApp.raw(`
      CREATE FUNCTION reject_portal_reply_checkpoint() RETURNS trigger AS $$
      BEGIN
        IF NEW.response IS NOT NULL AND OLD.response IS NULL THEN
          RAISE EXCEPTION 'synthetic checkpoint failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE TRIGGER reject_portal_reply_checkpoint_trigger
      BEFORE UPDATE ON portal_chat_requests
      FOR EACH ROW EXECUTE FUNCTION reject_portal_reply_checkpoint()
    `);

    try {
      const response = await runPortalTurn(args(requestId, async () => {
        processCalls += 1;
        return normal;
      }));
      expect(response).toEqual({ ...normal, requestId });
      expect(response).not.toHaveProperty('retryable');
      expect(processCalls).toBe(1);

      const receipt = await mockApp('portal_chat_requests').where({ request_id: requestId }).first();
      expect(receipt.state).toBe('processing');
      expect(receipt.response).toBeNull();
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS reject_portal_reply_checkpoint_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS reject_portal_reply_checkpoint()');
    }
  });

  test('a reclaimed attempt cannot publish its unfenced local result', async () => {
    const requestId = randomUUID();
    let processCalls = 0;
    await mockApp.raw(`
      CREATE FUNCTION delay_stale_portal_reply_checkpoint() RETURNS trigger AS $$
      BEGIN
        IF NEW.response->>'reply' = 'stale local answer' THEN
          -- Outlast the 2 s turn budget by a full second: the checkpoint must
          -- still be asleep when the deadline cancel reaches it, however late.
          PERFORM pg_sleep(3);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE TRIGGER delay_stale_portal_reply_checkpoint_trigger
      BEFORE UPDATE ON portal_chat_requests
      FOR EACH ROW EXECUTE FUNCTION delay_stale_portal_reply_checkpoint()
    `);

    try {
      const firstPromise = runPortalTurn(args(requestId, async () => {
        processCalls += 1;
        return { reply: 'stale local answer', escalated: false, generated: true };
      }, { budgetMs: 2_000 }));
      await pause(2_050);
      const retryPromise = runPortalTurn(args(requestId, async () => {
        processCalls += 1;
        return { reply: 'authoritative retry', escalated: false, generated: true };
      }, { budgetMs: 4_000 }));

      const [first, retry] = await Promise.all([firstPromise, retryPromise]);
      expect(first).toMatchObject({ retryable: true, requestId });
      expect(first.reply).not.toBe('stale local answer');
      expect(retry).toMatchObject({ reply: 'authoritative retry', requestId });
      expect(processCalls).toBe(2);
      expect(await mockApp('portal_chat_requests').where({ request_id: requestId }).first())
        .toMatchObject({ state: 'completed', response: expect.objectContaining({ reply: 'authoritative retry' }) });
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS delay_stale_portal_reply_checkpoint_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS delay_stale_portal_reply_checkpoint()');
    }
  });

  test('queue polling that reaches its work deadline returns pending and retryable', async () => {
    const blockerId = randomUUID();
    const requestId = randomUUID();
    const scopeKey = turnScopeKey({ customerId, channelIdentifier: 'browser-session', propertyId: null });
    await mockApp('portal_chat_requests').insert({
      request_id: blockerId,
      customer_id: customerId,
      channel_identifier: 'browser-session',
      scope_key: scopeKey,
      message_hash: createHash('sha256').update('blocking turn').digest('hex'),
      state: 'processing',
      attempt_id: randomUUID(),
      lease_expires_at: new Date(Date.now() + 10_000),
    });

    let processCalls = 0;
    const response = await runPortalTurn(args(requestId, async () => {
      processCalls += 1;
      return { reply: 'must not run', escalated: false };
    }, { budgetMs: 4_000 }));

    expect(response).toMatchObject({ pending: true, retryable: true, requestId });
    expect(response.reply).toMatch(/still finishing/);
    expect(processCalls).toBe(0);
    expect(mockTransactionCalls).toBeLessThanOrEqual(10);
    expect(await mockApp('portal_chat_requests').where({ request_id: requestId }).first())
      .toMatchObject({ state: 'pending', response: null });
  });

  test('a claim that finishes after the work deadline remains retryable and never runs the turn', async () => {
    const requestId = randomUUID();
    let processCalls = 0;
    await mockApp.raw(`
      CREATE FUNCTION delay_portal_claim_past_work_deadline() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'processing' AND OLD.state = 'pending' THEN
          PERFORM pg_sleep(GREATEST(
            0,
            EXTRACT(EPOCH FROM (NEW.lease_expires_at - clock_timestamp())) - 0.6
          ));
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE TRIGGER delay_portal_claim_past_work_deadline_trigger
      BEFORE UPDATE ON portal_chat_requests
      FOR EACH ROW EXECUTE FUNCTION delay_portal_claim_past_work_deadline()
    `);

    let receipt;
    try {
      const first = await runPortalTurn(args(requestId, async () => {
        processCalls += 1;
        return { reply: 'must not run', escalated: false };
      }, { budgetMs: 3_000 }));
      expect(first).toMatchObject({ pending: true, retryable: true, requestId });
      expect(first.reply).toMatch(/still finishing/);
      expect(processCalls).toBe(0);

      receipt = await mockApp('portal_chat_requests').where({ request_id: requestId }).first();
      expect(receipt.state).toBe('processing');
      expect(receipt.response).toBeNull();
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS delay_portal_claim_past_work_deadline_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS delay_portal_claim_past_work_deadline()');
    }

    await pause(Math.max(0, new Date(receipt.lease_expires_at).getTime() - Date.now()) + 50);
    const retry = await runPortalTurn(args(requestId, async () => {
      processCalls += 1;
      return { reply: 'completed on retry', escalated: false };
    }));
    expect(retry.reply).toBe('completed on retry');
    expect(processCalls).toBe(1);
    expect((await mockApp('portal_chat_requests').where({ request_id: requestId }).first()).state)
      .toBe('completed');
  });

  test('a committed handoff survives hanging optional work, lost finish acknowledgement, and retry', async () => {
    const requestId = randomUUID();
    let processCalls = 0;
    await mockApp.raw(`
      CREATE FUNCTION delay_portal_finish() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'completed' AND OLD.state <> 'completed' THEN
          PERFORM pg_sleep(3);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE TRIGGER delay_portal_finish_trigger
      BEFORE UPDATE ON portal_chat_requests
      FOR EACH ROW EXECUTE FUNCTION delay_portal_finish()
    `);

    const handoff = {
      reply: "I've saved your request for our team.",
      conversationId: null,
      escalated: true,
      escalationId: 'synthetic-escalation',
      teamNotified: true,
      generated: false,
      actions: [{ type: 'tab', label: 'Open Billing', tab: 'billing' }],
      cards: [{ type: 'payments', title: 'Your most recent payment', rows: [{ id: 'p1' }] }],
    };

    try {
      const first = await runPortalTurn(args(requestId, async (turn) => {
        processCalls += 1;
        const committed = await turn.transaction('synthetic committed handoff', async (trx) => {
          await trx('ai_escalations').insert({
            customer_id: customerId,
            portal_chat_request_id: turn.requestRowId,
          });
          await turn.persistCommittedResult(trx, handoff);
          return handoff;
        });
        turn.rememberCommittedResult(committed);
        // Models/notifications after the core handoff are optional. Simulate
        // one that ignores cancellation forever; the coordinator must return
        // the committed truth even though its completion UPDATE also loses
        // the acknowledgement to the trigger above.
        await turn.waitFor(() => new Promise(() => {}), 'optional notification');
        return committed;
      }, { budgetMs: 2_500 }));

      expect(first).toEqual({ ...handoff, requestId });
      expect(processCalls).toBe(1);
      const checkpoint = await mockApp('portal_chat_requests').where({ request_id: requestId }).first();
      expect(checkpoint.state).toBe('processing');
      expect(checkpoint.response).toMatchObject({ escalated: true, cards: handoff.cards });
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS delay_portal_finish_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS delay_portal_finish()');
    }

    const retry = await runPortalTurn(args(requestId, async () => {
      processCalls += 1;
      return { reply: 'must not rerun', escalated: false };
    }, { budgetMs: 2_500 }));

    expect(retry).toEqual({ ...handoff, requestId });
    expect(processCalls).toBe(1);
    expect((await mockApp('portal_chat_requests').where({ request_id: requestId }).first()).state).toBe('completed');
    expect(await mockApp('ai_escalations').count('* as n').first()).toMatchObject({ n: '1' });
  });

  test('a retry polling before the checkpoint replays it after the first finish fails', async () => {
    const requestId = randomUUID();
    const handoff = {
      reply: "I've saved your request for our team.",
      conversationId: null,
      escalated: true,
      escalationId: 'raced-escalation',
      teamNotified: true,
      generated: false,
    };
    let processCalls = 0;
    let markFirstStarted;
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });

    await mockApp.raw('CREATE SEQUENCE raced_portal_finish_calls');
    await mockApp.raw(`
      CREATE FUNCTION reject_first_raced_portal_finish() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'completed' AND OLD.state <> 'completed'
          AND nextval('raced_portal_finish_calls') = 1 THEN
          RAISE EXCEPTION 'synthetic first finish failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE TRIGGER reject_first_raced_portal_finish_trigger
      BEFORE UPDATE ON portal_chat_requests
      FOR EACH ROW EXECUTE FUNCTION reject_first_raced_portal_finish()
    `);

    try {
      const first = runPortalTurn(args(requestId, async (turn) => {
        processCalls += 1;
        markFirstStarted();
        // The retry below is already polling while this attempt still has no
        // response. Checkpoint only after that interleaving is established.
        await pause(90);
        const committed = await turn.transaction('raced handoff checkpoint', async (trx) => {
          await turn.persistCommittedResult(trx, handoff);
          return handoff;
        });
        turn.rememberCommittedResult(committed);
        return committed;
      }, { budgetMs: 4_000 }));
      await firstStarted;
      const retry = runPortalTurn(args(requestId, async () => {
        processCalls += 1;
        return { reply: 'must not rerun', escalated: false };
      }, { budgetMs: 8_000 }));

      const [firstResponse, retryResponse] = await Promise.all([first, retry]);
      expect(firstResponse).toEqual({ ...handoff, requestId });
      expect(retryResponse).toEqual({ ...handoff, requestId });
      expect(processCalls).toBe(1);
      expect((await mockApp('portal_chat_requests').where({ request_id: requestId }).first()).state)
        .toBe('processing');
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS reject_first_raced_portal_finish_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS reject_first_raced_portal_finish()');
      await mockApp.raw('DROP SEQUENCE IF EXISTS raced_portal_finish_calls');
    }

    // Once the database accepts cleanup, a later retry finishes the receipt
    // without rerunning the turn whose response was already checkpointed.
    const cleaned = await runPortalTurn(args(requestId, async () => {
      processCalls += 1;
      return { reply: 'must not rerun', escalated: false };
    }, { budgetMs: 4_000 }));
    expect(cleaned).toEqual({ ...handoff, requestId });
    expect(processCalls).toBe(1);
    expect((await mockApp('portal_chat_requests').where({ request_id: requestId }).first()).state)
      .toBe('completed');
  });

  test('recovery reads a durable response after another request completes its receipt', async () => {
    const requestId = randomUUID();
    const nextId = randomUUID();
    const durable = {
      reply: 'durable answer before acknowledgement loss',
      conversationId: null,
      escalated: false,
      generated: true,
    };
    let markCheckpointed;
    const checkpointed = new Promise((resolve) => { markCheckpointed = resolve; });
    let releaseFirst;
    const secondClaimed = new Promise((resolve) => { releaseFirst = resolve; });

    const first = runPortalTurn(args(requestId, async (turn) => {
      await turn.transaction('durable response before acknowledgement loss', async (trx) => {
        await turn.persistCommittedResult(trx, durable);
      });
      markCheckpointed();
      await secondClaimed;
      throw new Error('synthetic response acknowledgement loss');
    }));
    await checkpointed;

    const next = runPortalTurn(args(nextId, async () => {
      releaseFirst();
      return { reply: 'next answer after cleanup', escalated: false };
    }, { message: 'next question' }));

    const [firstResponse, nextResponse] = await Promise.all([first, next]);
    expect(firstResponse).toEqual({ ...durable, requestId });
    expect(nextResponse).toMatchObject({ reply: 'next answer after cleanup', requestId: nextId });
    expect(await mockApp('portal_chat_requests').where({ request_id: requestId }).first())
      .toMatchObject({ state: 'completed', attempt_id: null, response: expect.objectContaining(durable) });
  });

  test('a resolved fallback cannot overwrite a handoff checkpoint after a lost commit acknowledgement', async () => {
    const requestId = randomUUID();
    const handoff = {
      reply: "I've saved your request for our team.",
      conversationId: null,
      escalated: true,
      escalationId: 'committed-before-ack-loss',
      teamNotified: true,
      generated: false,
    };

    const response = await runPortalTurn(args(requestId, async (turn) => {
      try {
        await turn.transaction('handoff with lost commit acknowledgement', async (trx) => {
          await turn.persistCommittedResult(trx, handoff);
        });
        throw new Error('synthetic acknowledgement loss');
      } catch {
        // Matches processMessage converting an answerWithTools failure into a
        // normal resolved fallback after the handoff transaction committed.
        return { reply: 'generic fallback', escalated: false };
      }
    }));

    expect(response).toEqual({ ...handoff, requestId });
    const receipt = await mockApp('portal_chat_requests').where({ request_id: requestId }).first();
    expect(receipt.state).toBe('completed');
    expect(receipt.response).toMatchObject({ escalated: true, escalationId: handoff.escalationId });
  });

  test('a replay already read from the receipt survives cleanup failure', async () => {
    const requestId = randomUUID();
    const attemptId = randomUUID();
    const scopeKey = turnScopeKey({ customerId, channelIdentifier: 'browser-session', propertyId: null });
    const handoff = {
      reply: "I've saved your request for our team.",
      conversationId: null,
      escalated: true,
      escalationId: 'cleanup-failure-escalation',
      teamNotified: true,
      generated: false,
      requestId,
    };
    await mockApp('portal_chat_requests').insert({
      request_id: requestId,
      customer_id: customerId,
      channel_identifier: 'browser-session',
      scope_key: scopeKey,
      message_hash: createHash('sha256').update('Please help').digest('hex'),
      state: 'processing',
      attempt_id: attemptId,
      lease_expires_at: new Date(Date.now() + 10_000),
      response: handoff,
    });
    await mockApp.raw(`
      CREATE FUNCTION reject_portal_replay_cleanup() RETURNS trigger AS $$
      BEGIN
        IF NEW.state = 'completed' AND OLD.state <> 'completed' THEN
          RAISE EXCEPTION 'synthetic cleanup failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await mockApp.raw(`
      CREATE TRIGGER reject_portal_replay_cleanup_trigger
      BEFORE UPDATE ON portal_chat_requests
      FOR EACH ROW EXECUTE FUNCTION reject_portal_replay_cleanup()
    `);

    let processCalls = 0;
    try {
      const response = await runPortalTurn(args(requestId, async () => {
        processCalls += 1;
        return { reply: 'must not run', escalated: false };
      }));
      expect(response).toEqual(handoff);
      expect(processCalls).toBe(0);
      expect((await mockApp('portal_chat_requests').where({ request_id: requestId }).first()).state)
        .toBe('processing');
    } finally {
      await mockApp.raw('DROP TRIGGER IF EXISTS reject_portal_replay_cleanup_trigger ON portal_chat_requests');
      await mockApp.raw('DROP FUNCTION IF EXISTS reject_portal_replay_cleanup()');
    }
  });

  test('a checkpointed active receipt releases its scope for the next request', async () => {
    const completedId = randomUUID();
    const nextId = randomUUID();
    const scopeKey = turnScopeKey({ customerId, channelIdentifier: 'browser-session', propertyId: null });
    await mockApp('portal_chat_requests').insert({
      request_id: completedId,
      customer_id: customerId,
      channel_identifier: 'browser-session',
      scope_key: scopeKey,
      message_hash: createHash('sha256').update('earlier turn').digest('hex'),
      state: 'processing',
      attempt_id: randomUUID(),
      lease_expires_at: new Date(Date.now() + 10_000),
      response: { reply: 'earlier durable answer', escalated: false, requestId: completedId },
    });

    let processCalls = 0;
    const response = await runPortalTurn(args(nextId, async () => {
      processCalls += 1;
      return { reply: 'next answer', escalated: false };
    }, { message: 'next turn' }));

    expect(response).toMatchObject({ reply: 'next answer', requestId: nextId });
    expect(processCalls).toBe(1);
    expect(await mockApp('portal_chat_requests').where({ request_id: completedId }).first())
      .toMatchObject({ state: 'completed', attempt_id: null, lease_expires_at: null });
  });

  test('an exhausted pool leaves no queued acquisition or delayed receipt write', async () => {
    const held = await Promise.all(Array.from({ length: 3 }, () => mockApp.client.acquireConnection()));
    const requestId = randomUUID();
    try {
      const started = Date.now();
      const result = await runPortalTurn(args(requestId, async () => ({ reply: 'must not run' }), { budgetMs: 120 }));
      expect(result.retryable).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(mockApp.client.pool.numPendingAcquires()).toBe(0);
    } finally {
      await Promise.all(held.map((connection) => mockApp.client.releaseConnection(connection)));
    }
    await pause(100);
    expect(await mockApp('portal_chat_requests').where({ request_id: requestId })).toHaveLength(0);
  });

  test('request ids are bound to message and authenticated property scope', async () => {
    const requestId = randomUUID();
    await runPortalTurn(args(requestId, async () => ({ reply: 'ok', escalated: false }), { propertyId: randomUUID() }));
    await expect(runPortalTurn(args(requestId, async () => ({ reply: 'wrong', escalated: false }), {
      propertyId: randomUUID(),
    }))).rejects.toMatchObject({ status: 409, code: 'PORTAL_CHAT_REQUEST_MISMATCH' });
  });

  test('lease expiry is based on the database clock instead of the application wall clock', async () => {
    const requestId = randomUUID();
    const actualNow = Date.now.bind(Date);
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => actualNow() + 300_000);
    let leaseDeltaMs;
    try {
      const response = await runPortalTurn(args(requestId, async () => {
        const receipt = await mockApp('portal_chat_requests').where({ request_id: requestId }).first();
        const databaseNow = (await mockApp.raw('SELECT CURRENT_TIMESTAMP AS now')).rows[0].now;
        leaseDeltaMs = new Date(receipt.lease_expires_at).getTime() - new Date(databaseNow).getTime();
        return { reply: 'clock-safe', escalated: false };
      }));
      expect(response).toMatchObject({ reply: 'clock-safe', requestId });
    } finally {
      nowSpy.mockRestore();
    }
    expect(leaseDeltaMs).toBeGreaterThan(0);
    expect(leaseDeltaMs).toBeLessThan(5_000);
  });

  test('an abandoned pending receipt stops blocking the queue and can still be retried', async () => {
    const abandonedId = randomUUID();
    const scopeKey = turnScopeKey({ customerId, channelIdentifier: 'browser-session', propertyId: null });
    await mockApp('portal_chat_requests').insert({
      request_id: abandonedId,
      customer_id: customerId,
      channel_identifier: 'browser-session',
      scope_key: scopeKey,
      message_hash: createHash('sha256').update('Please help').digest('hex'),
      state: 'pending',
      lease_expires_at: new Date(Date.now() - 1_000),
    });

    const newer = await runPortalTurn(args(randomUUID(), async () => ({ reply: 'newer', escalated: false })));
    expect(newer.reply).toBe('newer');
    expect((await mockApp('portal_chat_requests').where({ request_id: abandonedId }).first()).state).toBe('expired');

    const retried = await runPortalTurn(args(abandonedId, async () => ({ reply: 'retried', escalated: false })));
    expect(retried.reply).toBe('retried');
  });

  test('the migration rolls back and reapplies cleanly', async () => {
    await migration.down(mockApp);
    expect(await mockApp.schema.hasTable('portal_chat_requests')).toBe(false);
    expect(await mockApp.schema.hasColumn('agent_messages', 'portal_chat_request_id')).toBe(false);
    expect(await mockApp.schema.hasColumn('ai_escalations', 'portal_chat_request_id')).toBe(false);
    await migration.up(mockApp);
    expect(await mockApp.schema.hasTable('portal_chat_requests')).toBe(true);
  });
});
