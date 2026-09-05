/**
 * DB-backed concurrency check for the run ledger's start path
 * (services/agent-control/runs.js): two starts on one source key at the
 * same moment — on a new key, on a run whose worker's lease lapsed, and
 * through runManaged — open exactly ONE attempt; the other is held. The
 * start transaction locks the run row (SELECT … FOR UPDATE), so the second
 * start re-reads the row the first committed instead of both passing the
 * lease check (pre-push audit on Codex r15). The mocked suite can only
 * start handles sequentially; this proves the lock on PostgreSQL.
 *
 * Self-skips without DATABASE_URL (run after `knex migrate:latest`) — the
 * same convention as llm-dispatch-log-schema.test.js.
 */
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

const SRC = '__runs_concurrency__';

describeOrSkip('agent runs: concurrent starts on PostgreSQL', () => {
  let db;
  let runs;
  const originalGate = process.env.GATE_AGENT_RUNS;

  const cleanup = async () => {
    const ids = (await db('agent_runs').where({ source_system: SRC }).pluck('id'));
    if (ids.length) {
      for (const table of ['run_events', 'run_artifacts', 'agent_run_steps', 'agent_attempts']) await db(table).whereIn('run_id', ids).del();
      await db('agent_runs').whereIn('id', ids).del();
    }
    await db('work_items').where({ source_system: SRC }).del();
  };

  beforeAll(async () => {
    process.env.GATE_AGENT_RUNS = 'true';
    db = require('../models/db');
    runs = require('../services/agent-control/runs');
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    if (originalGate === undefined) delete process.env.GATE_AGENT_RUNS; else process.env.GATE_AGENT_RUNS = originalGate;
    await db.destroy();
  });

  const args = (sourceRunId) => ({ laneId: 'blog_draft', sourceSystem: SRC, sourceRunId, idempotencyKey: `k-${sourceRunId}`, maxAttempts: 3 });
  const live = (handles) => handles.filter((h) => !h.inert);
  const held = (handles) => handles.filter((h) => h.held);

  test('a new key: exactly one of two simultaneous starts opens attempt 1, the other is held — and the loser leaves no work item (each supplied its own)', async () => {
    const both = await Promise.all([
      runs.startRun({ ...args('new'), workItem: { sourceRef: 'new-a', title: 'A' } }),
      runs.startRun({ ...args('new'), workItem: { sourceRef: 'new-b', title: 'B' } }),
    ]);
    expect(live(both)).toHaveLength(1);
    expect(held(both)).toHaveLength(1);
    expect(held(both)[0].held).toMatchObject({ reason: 'in_progress', runId: live(both)[0].id, attemptNo: 1 });
    const row = await db('agent_runs').where({ source_system: SRC, source_run_id: 'new' }).first();
    expect(row).toMatchObject({ attempts: 1, lifecycle: 'running' });
    expect(await db('agent_attempts').where({ run_id: row.id }).count({ n: '*' }).first()).toMatchObject({ n: '1' });
    // the work item is minted only once the start owns the run: the loser's never exists (Codex r17)
    const items = await db('work_items').where({ source_system: SRC });
    expect(items).toHaveLength(1);
    expect(row.work_item_id).toBe(items[0].id);
    await live(both)[0].finish({ result: 'succeeded' });
  });

  test('a lapsed lease: two simultaneous restarts open exactly one attempt 2', async () => {
    const a = await runs.startRun(args('lapsed'));
    expect(a.inert).toBeFalsy();
    await db('agent_runs').where({ id: a.id }).update({ lease_expires_at: new Date(Date.now() - 1000) });
    const both = await Promise.all([runs.startRun(args('lapsed')), runs.startRun(args('lapsed'))]);
    expect(live(both)).toHaveLength(1);
    expect(live(both)[0].attemptNo).toBe(2);
    expect(held(both)).toHaveLength(1);
    expect(held(both)[0].held).toMatchObject({ reason: 'in_progress', runId: a.id, attemptNo: 2 });
    const attempts = await db('agent_attempts').where({ run_id: a.id }).orderBy('attempt_no');
    expect(attempts.map((x) => [x.attempt_no, x.error_code])).toEqual([[1, 'superseded'], [2, null]]);
    await live(both)[0].finish({ result: 'succeeded' });
  });

  test('one NEW idempotency key under two source ids: exactly one run exists, the other start is refused — never an inert handle whose body runs', async () => {
    const shared = { laneId: 'blog_draft', sourceSystem: SRC, idempotencyKey: 'k-shared', maxAttempts: 3 };
    const body = jest.fn(async () => { await new Promise((r) => setTimeout(r, 30)); return 'ran'; });
    const results = await Promise.allSettled([runs.runManaged({ ...shared, sourceRunId: 'shared-a' }, body), runs.runManaged({ ...shared, sourceRunId: 'shared-b' }, body)]);
    expect(body).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused.reason).toMatchObject({ code: 'run_idempotency_conflict', held: { reason: 'idempotency_conflict' } });
    expect(await db('agent_runs').where({ source_system: SRC, idempotency_key: 'k-shared' })).toHaveLength(1);
  });

  test('runManaged: one body runs, the other is refused with run_in_progress', async () => {
    const body = jest.fn(async () => { await new Promise((r) => setTimeout(r, 50)); return 'ran'; });
    const results = await Promise.allSettled([runs.runManaged(args('managed'), body), runs.runManaged(args('managed'), body)]);
    expect(body).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 'fulfilled').map((r) => r.value)).toEqual(['ran']);
    const refused = results.find((r) => r.status === 'rejected');
    expect(refused.reason).toMatchObject({ code: 'run_in_progress' });
  });
});
