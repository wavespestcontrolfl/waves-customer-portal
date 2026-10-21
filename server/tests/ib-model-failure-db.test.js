// The Intelligence Bar model failure notice against real PostgreSQL
// (GATE_IB_MODEL_FAILURE_NOTICE): one quiet gap row per code, one admin bell in a
// rolling hour however many failures land, and a saved change read back from the
// task's real receipts. The route wiring is pinned in
// admin-intelligence-bar-model-failure.test.js.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

postgres('model failure notice against PostgreSQL', () => {
  let db;
  let ModelFailure;
  const ACTOR = `model-failure-test-${Date.now()}`;
  const SESSION = '7e1c2f7a-1111-2222-3333-deadbeef0002';
  const error = () => Object.assign(new Error('400 usage limit'), { status: 400 });
  let taskId;

  const bells = () => db('notifications').where({ recipient_type: 'admin' }).whereRaw("metadata->>'dedupeKey' = ?", [`${ModelFailure.BELL_DEDUPE_KEY}:admin`]);
  const gapRows = () => db('agent_gap_reports').where({ source: ModelFailure.GAP_SOURCE });

  async function clean() {
    await db('ib_pending_actions').where({ requested_by: ACTOR }).del();
    await db('ib_tasks').where({ actor_id: ACTOR }).del();
    const gapIds = (await gapRows().select('id')).map((r) => r.id);
    if (gapIds.length) await db('agent_gap_report_sightings').whereIn('gap_id', gapIds).del();
    await gapRows().del();
    await bells().del();
  }

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a disposable local database');
    db = require('../models/db');
    ModelFailure = require('../services/intelligence-bar/model-failure');
    await clean();
  }, 30000);

  beforeEach(async () => {
    await clean();
    [{ id: taskId }] = await db('ib_tasks').insert({
      actor_id: ACTOR, session_id: SESSION, request_key: `key-${Date.now()}-${Math.random()}`, request_hash: 'h'.repeat(64),
      runner_token: '7e1c2f7a-1111-2222-3333-deadbeef0003', lease_expires_at: new Date(Date.now() + 120000),
      request: JSON.stringify({ prompt: 'synthetic' }), expires_at: new Date(Date.now() + 86400000),
    }).returning('id');
  });

  afterAll(async () => { await clean(); await db?.destroy(); });

  test('two failures in the hour leave one gap row (counted twice), one bell, no gap bell', async () => {
    const first = await ModelFailure.handleModelFailure({ err: error(), activeTask: null, actorId: ACTOR });
    const second = await ModelFailure.handleModelFailure({ err: error(), activeTask: null, actorId: ACTOR });
    expect(first.code).toBe('anthropic_400');
    expect(second.answer).toContain('Nothing was changed.');

    const gaps = await gapRows();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual(expect.objectContaining({ kind: 'blocked', status: 'new', occurrences: 2 }));
    expect(gaps[0].belled_at).not.toBeNull(); // stamped, so no "build gap N" bell ever follows

    const rows = await bells();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('System — check why the AI model is not answering');
    expect(rows[0].category).toBe('agents');
    const metadata = typeof rows[0].metadata === 'string' ? JSON.parse(rows[0].metadata) : rows[0].metadata;
    expect(metadata).toEqual(expect.objectContaining({ severity: 'needs-you', who: 'person', code: 'anthropic_400' }));
    // The gap's own bell would carry `agent-gap:<id>:...` as its key.
    expect(await db('notifications').whereRaw("metadata->>'dedupeKey' like ?", [`agent-gap:${gaps[0].id}:%`])).toHaveLength(0);
  });

  test('a failure after the hour window rings again', async () => {
    await ModelFailure.handleModelFailure({ err: error(), activeTask: null, actorId: ACTOR });
    await db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`${ModelFailure.BELL_DEDUPE_KEY}:admin`]).update({ created_at: new Date(Date.now() - 61 * 60 * 1000) });
    await ModelFailure.handleModelFailure({ err: error(), activeTask: null, actorId: ACTOR });
    expect(await bells()).toHaveLength(2);
  });

  test('a different error code is its own gap row', async () => {
    await ModelFailure.handleModelFailure({ err: error(), activeTask: null, actorId: ACTOR });
    await ModelFailure.handleModelFailure({ err: Object.assign(new Error('overloaded'), { status: 529 }), activeTask: null, actorId: ACTOR });
    expect((await gapRows()).map((g) => g.occurrences)).toEqual([1, 1]);
  });

  test('a confirmed change in the task\'s receipts is reported, and the task state follows it', async () => {
    await db('ib_pending_actions').insert({
      tool_name: 'update_customer', params: JSON.stringify({}), params_hash: 'p'.repeat(64), summary: 'Update the synthetic customer phone',
      requested_by: ACTOR, status: 'confirmed', expires_at: new Date(Date.now() + 600000), consumed_at: new Date(),
      result: JSON.stringify({ success: true }), task_id: taskId, step_key: 'step-1',
    });
    const handled = await ModelFailure.handleModelFailure({ err: error(), activeTask: { id: taskId }, actorId: ACTOR });
    expect(handled.answer).toContain('Before the error, this was already saved: Update the synthetic customer phone.');
    expect(handled.answer).not.toMatch(/Nothing was changed/);
    expect(handled.taskState).toBe('outcome_unknown');
  });

  test('a task with no receipts ends failed', async () => {
    const handled = await ModelFailure.handleModelFailure({ err: error(), activeTask: { id: taskId }, actorId: ACTOR });
    expect(handled.answer).toContain('Nothing was changed.');
    expect(handled.taskState).toBe('failed');
  });
});
