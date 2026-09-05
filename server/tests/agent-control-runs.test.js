/**
 * Agent runs write API (S3). Invariants: the gate off (or a DB failure)
 * yields an inert handle and the wrapped work still runs; on, one work
 * item / run / attempt per (source_system, source_run_id) with a restart
 * joining the run as a new attempt; steps are timed, scoped and re-throw
 * the caller's error; finish / fail write the taxonomy vocabulary; retry
 * only when retryable ∧ attempts < max ∧ idempotency_key ∧ class ∉
 * {money, irreversible_external}; quality failures raise an eval
 * candidate; the ledger never throws into the business path.
 * No real DB: an in-memory knex fake with the conflict semantics used.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const UNIQUE = {
    work_items: ['source_system', 'source_ref'],
    agent_runs: ['source_system', 'source_run_id'],
    agent_attempts: ['run_id', 'attempt_no'],
  };
  const store = {};
  const state = { failNext: null, idSeq: 0, ops: [] }; // failNext: table whose next op throws; ops: every write in order (lock-order assertions)
  const uuid = () => `00000000-0000-4000-8000-${String(++state.idSeq).padStart(12, '0')}`;
  const matches = (row, where, whereNot, nulls = [], anyOf = []) => Object.entries(where).every(([k, v]) => String(row[k]) === String(v))
    && (whereNot || []).every(([k, v]) => String(row[k]) !== String(v))
    && nulls.every((k) => row[k] == null)
    // a grouped where((q) => q.whereNull(a).orWhere({ b })) — any branch matches
    && anyOf.every((group) => group.some((br) => (br.isNull ? row[br.isNull] == null : Object.entries(br.eq).every(([k, v]) => String(row[k]) === String(v)))));
  const db = (table) => {
    if (!store[table]) store[table] = [];
    const st = { where: {}, whereNot: null, nulls: [], anyOf: [], max: null, op: null, payload: null, returning: null, ignore: false, first: false };
    const chain = {
      insert(rows) { st.op = 'insert'; st.payload = rows; return chain; },
      onConflict() { return chain; },
      ignore() { st.ignore = true; return chain; },
      returning(col) { st.returning = col; return chain; },
      where(obj) {
        if (typeof obj === 'function') {
          const group = [];
          const sub = { whereNull(col) { group.push({ isNull: col }); return sub; }, orWhere(eq) { group.push({ eq }); return sub; } };
          obj(sub);
          st.anyOf.push(group);
        } else if (typeof obj === 'object') Object.assign(st.where, obj);
        return chain;
      },
      whereNull(col) { st.nulls.push(col); return chain; },
      first() { st.first = true; return chain; },
      forUpdate() { return chain; },
      update(patch) { st.op = 'update'; st.payload = patch; return chain; },
      whereNot(col, val) { st.whereNot = [...(st.whereNot || []), [col, val]]; return chain; },
      max(expr) { st.max = expr; st.first = true; return chain; },
      then(resolve, reject) {
        try {
          if (state.failNext === table) { state.failNext = null; throw new Error(`fake ${table} down`); }
          if (st.op) state.ops.push(`${table}:${st.op}`);
          const rows = store[table];
          let out;
          if (st.op === 'insert') {
            const list = Array.isArray(st.payload) ? st.payload : [st.payload];
            out = [];
            for (const r of list) {
              const key = UNIQUE[table];
              if (key && rows.some((x) => key.every((k) => String(x[k]) === String(r[k])))) continue;
              const row = { id: r.id || uuid(), created_at: new Date(), ...r };
              if (typeof row.summary === 'string') row.summary = JSON.parse(row.summary);
              rows.push(row);
              out.push(st.returning ? { [st.returning]: row[st.returning] } : row);
            }
          } else if (st.op === 'update') {
            out = 0;
            for (const r of rows) {
              if (!matches(r, st.where, st.whereNot, st.nulls, st.anyOf)) continue;
              for (const [k, v] of Object.entries(st.payload)) {
                if (v && typeof v === 'object' && v.__merge) r[k] = { ...(r[k] || {}), ...v.__merge };
                else if (v && typeof v === 'object' && v.__inc) r[k] = Number(r[k] || 0) + 1;
                else r[k] = v;
              }
              out += 1;
            }
            if (st.returning) out = rows.filter((r) => matches(r, st.where, st.whereNot, st.nulls, st.anyOf)).map((r) => ({ [st.returning]: r[st.returning] }));
          } else if (st.max) {
            const [col, alias] = String(st.max).split(' as ');
            const found = rows.filter((r) => matches(r, st.where, st.whereNot, st.nulls, st.anyOf));
            out = { [alias]: found.length ? Math.max(...found.map((r) => Number(r[col] || 0))) : null };
          } else {
            const found = rows.filter((r) => matches(r, st.where, st.whereNot, st.nulls, st.anyOf));
            out = st.first ? found[0] || null : found;
          }
          resolve(out);
        } catch (err) { reject(err); }
      },
    };
    return chain;
  };
  // summary || ?::jsonb → a merge marker the fake update applies
  db.raw = (sql, binds) => (/\|\|/.test(sql) ? { __merge: JSON.parse(binds[0]) } : /\+ 1$/.test(sql) ? { __inc: true } : { sql, binds });
  // rollback-aware: a callback that throws restores the store to its pre-transaction state
  db.transaction = async (fn) => {
    const snapshot = structuredClone(store);
    try { return await fn(db); } catch (err) {
      for (const k of Object.keys(store)) delete store[k];
      Object.assign(store, snapshot);
      throw err;
    }
  };
  db.__store = store;
  db.__state = state;
  return db;
});
const mockWarn = jest.fn();
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: (...a) => mockWarn(...a), error: jest.fn(), debug: jest.fn() }));
const mockToolEvent = jest.fn();
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: (...a) => mockToolEvent(...a) }));

const fakeDb = require('../models/db');
const store = fakeDb.__store;
const state = fakeDb.__state;
const runs = require('../services/agent-control/runs');
const context = require('../services/agent-control/context');
const { policyFor } = require('../services/agent-control/lane-policies');

const SRC = 'test_src';
const base = { laneId: 'blog_draft', sourceSystem: SRC, sourceRunId: 'r1', idempotencyKey: 'k1' };
const events = (runId) => store.run_events.filter((e) => e.run_id === runId).map((e) => e.event_type);
const runRow = () => store.agent_runs[0];
// the worker holding this run crashed: its lease lapsed (a live attempt refuses a second start — Codex r15)
const crash = (row = runRow()) => { row.lease_expires_at = new Date(Date.now() - 1); };

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  state.failNext = null;
  state.idSeq = 0;
  state.ops = [];
  mockWarn.mockClear();
  mockToolEvent.mockClear();
  process.env.GATE_AGENT_RUNS = 'true';
});
afterAll(() => { delete process.env.GATE_AGENT_RUNS; });

describe('gate and failure isolation', () => {
  test('gate off → inert handle: nothing written, step still runs its fn inside a step scope', async () => {
    delete process.env.GATE_AGENT_RUNS;
    const h = await runs.startRun(base);
    expect(h.inert).toBe(true);
    expect(h.id).toBeNull();
    const seen = await h.step({ key: 's' }, async () => context.current().stepId);
    expect(seen).toEqual(expect.any(String));
    await h.heartbeat({ progress: true });
    await h.finish({});
    expect(await h.fail({ error: new Error('x') })).toEqual({ retry: false });
    expect(store.agent_runs).toBeUndefined();
  });

  test('an unknown lane id is refused (inert + one warning): a misspelled money lane must not run under the unclassified default', async () => {
    const h = await runs.startRun({ ...base, laneId: 'blog_drafts' });
    expect(h.inert).toBe(true);
    expect(store.agent_runs || []).toHaveLength(0);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('unknown lane blog_drafts'));
    const r = await h.fail({ error: new Error('x'), retryable: true });
    expect(r.retry).toBe(false);
  });

  test('a workflow-only run (no lane) records with no side-effect class and no tier', async () => {
    const h = await runs.startRun({ workflowId: 'nightly_sweep', sourceSystem: SRC, sourceRunId: 'w1', workItem: { sourceRef: 'w' } });
    expect(h.inert).toBe(false);
    expect(runRow()).toMatchObject({ lane_id: null, workflow_id: 'nightly_sweep', side_effect_class: null, risk_tier: null });
    expect(store.work_items[0].risk_tier).toBeNull();
    await h.finish({});
    expect(runRow().lifecycle).toBe('terminal');
  });

  test('missing identity → inert with one warning; DB refusing the start → inert, never a throw; the start is one transaction', async () => {
    expect((await runs.startRun({ laneId: 'blog_draft' })).inert).toBe(true);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    state.failNext = 'agent_runs';
    const h = await runs.startRun(base);
    expect(h.inert).toBe(true);
    const trx = jest.spyOn(fakeDb, 'transaction');
    await runs.startRun(base);
    expect(trx).toHaveBeenCalledTimes(1);
    trx.mockRestore();
  });

  test('a write failing mid-run is swallowed (rate-limited warn) and the handle keeps working', async () => {
    const h = await runs.startRun(base);
    state.failNext = 'agent_run_steps';
    await expect(h.step({ key: 's' }, async () => 'ok')).resolves.toBe('ok');
    await h.finish({});
    expect(runRow().lifecycle).toBe('terminal');
  });
});

describe('start / step / finish', () => {
  test('startRun writes work item + run + attempt + started event with policy lease and risk tier', async () => {
    const h = await runs.startRun({ ...base, workItem: { sourceRef: 'opp-1', entityType: 'opportunity', entityId: '9', title: 'T' }, summary: { title: 'Run' } });
    expect(h.inert).toBe(false);
    const wi = store.work_items[0];
    expect(wi).toMatchObject({ source_system: SRC, source_ref: 'opp-1', lane_id: 'blog_draft', entity_type: 'opportunity' });
    const r = runRow();
    const policy = policyFor('blog_draft');
    expect(r).toMatchObject({ lifecycle: 'running', attempts: 1, work_item_id: wi.id, side_effect_class: policy.side_effect_class, idempotency_key: 'k1' });
    expect(r.lease_expires_at.getTime() - r.leased_at.getTime()).toBe(policy.stall_after_ms);
    expect(r.max_attempts).toBe(1 + policy.budget.max_retries);
    expect(store.agent_attempts).toHaveLength(1);
    expect(events(r.id)).toEqual(['started']);
    expect(h.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('a second startRun on the same source key joins the run as attempt 2 (resumed); a successful retry clears the earlier error', async () => {
    const a = await runs.startRun(base);
    await a.fail({ error: new Error('first'), errorCode: 'openai_500', retryable: false });
    store.agent_runs[0].verification = 'passed';
    store.work_items = [{ id: 'wi-1', status: 'done' }];
    store.agent_runs[0].work_item_id = 'wi-1';
    const b = await runs.startRun({ ...base, supersede: true }); // a replay of a terminal run is explicit (Codex r17)
    expect(b.id).toBe(a.id);
    expect(b.attemptNo).toBe(2);
    expect(b.traceId).toBe(a.traceId); // the persisted trace, not a fresh one
    // a new attempt is unjudged and its work item is open again
    expect(runRow().verification).toBe('unjudged');
    expect(store.work_items[0].status).toBe('open');
    expect(runRow()).toMatchObject({ lifecycle: 'running', finished_at: null, error_code: null, progress_sequence: 0 });
    // the retry's clock is its own: started_at moved to the reopen, not attempt 1's start
    expect(runRow().started_at.getTime()).toBeGreaterThanOrEqual(store.agent_attempts[1].started_at.getTime());
    expect(runRow().last_progress_at.getTime()).toBe(runRow().started_at.getTime());
    await b.finish({});
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', failure_class: null, error_code: null, error_message: null });
    expect(store.agent_attempts.map((x) => x.attempt_no)).toEqual([1, 2]);
    expect(events(a.id)).toEqual(['started', 'failed', 'resumed', 'finished']);
  });

  test('step: timed row, step scope with a span, done + progress on success; failed + rethrow on error; tool steps hit the tool ledger', async () => {
    const h = await runs.startRun(base);
    const scope = await h.step({ key: 'brief', label: 'Brief' }, async () => context.current());
    expect(scope.stepId).toBe(store.agent_run_steps[0].id);
    expect(scope.spanId).toBe(store.agent_run_steps[0].span_id);
    // a standalone handle (no runManaged) still scopes the step body to its run identity, so LLM calls inside correlate to the run; nothing leaks outside the step
    expect(scope).toMatchObject({ runId: h.id, attemptId: h.attemptId, workItemId: h.workItemId, traceId: h.traceId, laneId: 'blog_draft' });
    expect(context.current().runId).toBeNull();
    expect(store.agent_run_steps[0]).toMatchObject({ seq: 1, status: 'done', step_key: 'brief', attempt_id: h.attemptId });
    expect(runRow().progress_sequence).toBe(1);

    const boom = Object.assign(new Error('call 941-555-0100 failed'), { code: 'x' });
    await expect(h.step({ key: 'search', toolName: 'web_search' }, async () => { throw boom; })).rejects.toBe(boom);
    expect(store.agent_run_steps[1]).toMatchObject({ status: 'failed', tool_name: 'web_search', detail: 'call [redacted-number] failed' });
    expect(mockToolEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'agent_run', toolName: 'web_search', success: false, metadata: { run_id: h.id, step_id: store.agent_run_steps[1].id } }));
  });

  test('a resume after a human wait opens a fresh active span: started_at moves to the resume, the attempt keeps its own start', async () => {
    const h = await runs.startRun(base);
    const attemptStart = store.agent_attempts[0].started_at;
    runRow().started_at = new Date(Date.now() - 3 * 864e5); // a 3-day owner wait is not an instant hard timeout
    await h.wait('human', 'owner review');
    await h.resume('approved');
    expect(runRow().started_at.getTime()).toBeGreaterThan(Date.now() - 5000);
    expect(store.agent_attempts[0].started_at).toBe(attemptStart);
    expect(events(h.id)).toEqual(['started', 'waiting', 'resumed']);
  });

  test('wait / resume / checkpoint move the lifecycle and merge the summary; an unserialisable checkpoint never throws', async () => {
    const h = await runs.startRun(base);
    const bad = await runs.startRun({ ...base, sourceRunId: 'bad', idempotencyKey: 'kbad' });
    const cyclic = {}; cyclic.self = cyclic;
    await expect(bad.checkpoint(cyclic)).resolves.toBe(true);
    await expect(bad.finish({ summary: { big: BigInt(1) } })).resolves.toBe(true);
    expect(store.agent_runs.find((r) => r.source_run_id === 'bad')).toMatchObject({ lifecycle: 'terminal', summary: {} });
    await h.wait('human', 'owner reply');
    expect(runRow().lifecycle).toBe('waiting_human');
    await h.resume();
    expect(runRow().lifecycle).toBe('running');
    await h.checkpoint({ words: 5 });
    expect(runRow().summary).toEqual({ words: 5 });
    expect(events(h.id)).toEqual(['started', 'waiting', 'resumed', 'checkpoint']);
  });

  test('finish: terminal + result + disposition, artifacts, attempt closed, work item done, unknown values fall back', async () => {
    const h = await runs.startRun({ ...base, workItem: { sourceRef: 'w' } });
    await h.finish({ result: 'bogus', disposition: 'drafted', summary: { detail: 'd' }, artifacts: [{ kind: 'draft', label: 'Draft', content: 'x' }, { kind: 'url', ref: 'https://x' }, { kind: 'nope' }, null] });
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'drafted', summary: { detail: 'd' } });
    expect(runRow().lease_expires_at).toBeNull();
    // only CHECK-valid kinds reach the batch insert (one bad kind would reject the whole batch)
    expect(store.run_artifacts.map((a) => a.kind)).toEqual(['draft', 'url']);
    const migration = require('fs').readFileSync(require('path').join(__dirname, '..', 'models', 'migrations', '20260905000010_agent_runs.js'), 'utf8');
    const check = migration.match(/run_artifacts_kind_chk CHECK \(kind IN \(([^)]*)\)\)/)[1].match(/'([a-z_]+)'/g).map((k) => k.replace(/'/g, ''));
    expect([...runs.ARTIFACT_KINDS].sort()).toEqual(check.sort());
    expect(store.agent_attempts[0]).toMatchObject({ result: 'succeeded' });
    expect(store.work_items[0].status).toBe('done');
    expect(events(h.id)).toEqual(['started', 'finished', 'disposition']);
  });

  test('finish: a canceled run settles its work item canceled; an errored one leaves it open for the next attempt', async () => {
    const a = await runs.startRun({ ...base, workItem: { sourceRef: 'w' } });
    await a.finish({ result: 'canceled' });
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'canceled' });
    expect(store.work_items[0].status).toBe('canceled');
    // the CHECK vocabulary is the only thing a work item can be set to
    const migration = require('fs').readFileSync(require('path').join(__dirname, '..', 'models', 'migrations', '20260905000010_agent_runs.js'), 'utf8');
    const check = migration.match(/work_items_status_chk CHECK \(status IN \(([^)]*)\)\)/)[1].match(/'([a-z_]+)'/g).map((k) => k.replace(/'/g, ''));
    for (const s of Object.values(runs.WORK_ITEM_STATUS)) expect(check).toContain(s);
    store.work_items[0].status = 'open';
    const b = await runs.startRun({ ...base, workItem: { sourceRef: 'w' }, supersede: true });
    await b.finish({ result: 'errored' });
    expect(store.work_items[0].status).toBe('open');
  });

  test('budget: a step past max_steps records ONE budget_exceeded event and stamps the summary, never stops the caller', async () => {
    const h = await runs.startRun(base);
    const max = policyFor('blog_draft').budget.max_steps;
    for (let i = 0; i < max + 2; i += 1) await h.step({ key: `s${i}` }, async () => i);
    expect(events(h.id).filter((e) => e === 'budget_exceeded')).toHaveLength(1);
    expect(runRow().summary).toEqual({ budget_exceeded: 'steps' });
    expect(store.agent_run_steps).toHaveLength(max + 2);
  });

  test('budget: steps crossing the budget in parallel keep their own sequence numbers and share ONE marker (pre-push audit)', async () => {
    const h = await runs.startRun(base);
    const max = policyFor('blog_draft').budget.max_steps;
    for (let i = 0; i < max - 1; i += 1) await h.step({ key: `s${i}` }, async () => i);
    await Promise.all([h.step({ key: 'first' }, async () => 1), h.step({ key: 'second' }, async () => 2), h.step({ key: 'third' }, async () => 3)]);
    const bySeq = store.agent_run_steps.filter((s) => ['first', 'second', 'third'].includes(s.step_key)).map((s) => s.seq).sort((a, b) => a - b);
    expect(bySeq).toEqual([max, max + 1, max + 2]);
    expect(events(h.id).filter((e) => e === 'budget_exceeded')).toHaveLength(1);
  });

  test('budget: a marker whose write failed is retried by the next over-budget step, and still recorded once (Codex r13)', async () => {
    const h = await runs.startRun(base);
    const max = policyFor('blog_draft').budget.max_steps;
    for (let i = 0; i < max; i += 1) await h.step({ key: `s${i}` }, async () => i);
    state.failNext = 'agent_runs';
    await h.step({ key: 'over1' }, async () => 1);
    expect(events(h.id).filter((e) => e === 'budget_exceeded')).toHaveLength(0);
    expect(runRow().summary).toEqual({});
    await h.step({ key: 'over2' }, async () => 2);
    await h.step({ key: 'over3' }, async () => 3);
    expect(events(h.id).filter((e) => e === 'budget_exceeded')).toHaveLength(1);
    expect(runRow().summary).toEqual({ budget_exceeded: 'steps' });
  });
});

describe('concurrent starts', () => {
  test('a terminal run and a lapsed attempt at its cap are refused (completed / exhausted) until supersede; runManaged names the reason (Codex r17)', async () => {
    const a = await runs.startRun(base);
    await a.finish({ result: 'succeeded' });
    const again = await runs.startRun(base); // a repeated queue delivery
    expect(again.held).toMatchObject({ reason: 'completed', runId: a.id, lifecycle: 'terminal', result: 'succeeded' });
    expect(runRow().attempts).toBe(1);
    await expect(runs.runManaged(base, async () => 'ran')).rejects.toMatchObject({ code: 'run_completed', held: { reason: 'completed' } });
    expect((await runs.startRun({ ...base, supersede: true })).attemptNo).toBe(2);
    // at the cap: a lapsed attempt does not reopen — fail() would not have queued it either (max_attempts = 1 on an irreversible lane is the point)
    const one = await runs.startRun({ ...base, sourceRunId: 'one', idempotencyKey: 'k-one', maxAttempts: 1 });
    crash(store.agent_runs.find((r) => r.source_run_id === 'one'));
    expect((await runs.startRun({ ...base, sourceRunId: 'one', idempotencyKey: 'k-one', maxAttempts: 1 })).held).toMatchObject({ reason: 'exhausted', runId: one.id, attemptNo: 1 });
    await expect(runs.runManaged({ ...base, sourceRunId: 'one', idempotencyKey: 'k-one' }, async () => 'ran')).rejects.toMatchObject({ code: 'run_exhausted' });
    expect(store.agent_attempts.filter((x) => x.run_id === one.id)).toHaveLength(1);
  });

  test('an idempotency key already held by another source run refuses the start — never an inert handle whose body runs (Codex r17)', async () => {
    const a = await runs.startRun(base); // k1 on r1
    const body = jest.fn(async () => 'ran');
    await expect(runs.runManaged({ ...base, sourceRunId: 'r-other' }, body)).rejects.toMatchObject({ code: 'run_idempotency_conflict', held: { runId: a.id, reason: 'idempotency_conflict' } });
    expect(body).not.toHaveBeenCalled();
    expect(store.agent_runs).toHaveLength(1);
    // supersede replays THIS key's run; it never crosses to another source run's key
    expect((await runs.startRun({ ...base, sourceRunId: 'r-other', supersede: true })).held).toMatchObject({ reason: 'idempotency_conflict' });
    expect(mockWarn.mock.calls.some((c) => /refused \(idempotency_conflict\)/.test(c[0]))).toBe(true);
  });

  test('the work item is minted only after the start owns the run, so a refused start cannot leave one behind (Codex r17)', async () => {
    await runs.startRun({ ...base, workItem: { sourceRef: 'w' } });
    const runInsert = state.ops.indexOf('agent_runs:insert');
    expect(runInsert).toBeGreaterThan(-1);
    expect(state.ops.indexOf('work_items:insert')).toBeGreaterThan(runInsert);
    expect(runRow().work_item_id).toBe(store.work_items[0].id);
  });

  test('a refused start mints no work item for the live run; the same later start binds it once the attempt lapsed (Codex r16)', async () => {
    const a = await runs.startRun(base);
    expect(runRow().work_item_id).toBeNull();
    const b = await runs.startRun({ ...base, workItem: { sourceRef: 'late', title: 'Late' } });
    expect(b.held).toBeDefined();
    expect(store.work_items || []).toHaveLength(0);
    expect(runRow().work_item_id).toBeNull();
    crash();
    const c = await runs.startRun({ ...base, workItem: { sourceRef: 'late', title: 'Late' } });
    expect(c.attemptNo).toBe(2);
    expect(c.workItemId).toBe(store.work_items[0].id);
    expect(runRow().work_item_id).toBe(store.work_items[0].id);
    expect(a.id).toBe(c.id);
  });

  test('a workflow supplied by a later start binds once on the row, so the handle scope and the run report the same workflow (Codex r16)', async () => {
    const a = await runs.startRun(base);
    expect(runRow().workflow_id).toBeNull();
    expect(a.workflowId).toBeNull();
    await a.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: false });
    const b = await runs.startRun({ ...base, workflowId: 'nightly_sweep', supersede: true });
    expect(runRow().workflow_id).toBe('nightly_sweep');
    expect(b.workflowId).toBe('nightly_sweep');
    expect(await b.step({ key: 's' }, async () => context.current().workflowId)).toBe('nightly_sweep');
    await b.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: false });
    // the persisted workflow wins over a later request
    const c = await runs.startRun({ ...base, workflowId: 'other', supersede: true });
    expect(runRow().workflow_id).toBe('nightly_sweep');
    expect(c.workflowId).toBe('nightly_sweep');
  });

  test('a second start on a LIVE attempt is refused: a held inert handle, nothing written; runManaged refuses the body; supersede: true overrides (Codex r15)', async () => {
    const a = await runs.startRun({ ...base, workItem: { sourceRef: 'w' } });
    const ops = state.ops.length;
    const b = await runs.startRun(base);
    expect(b.inert).toBe(true);
    expect(b.held).toMatchObject({ runId: a.id, attemptNo: 1, workerId: runs.WORKER_ID });
    expect(b.held.leaseExpiresAt).toBeInstanceOf(Date);
    // nothing updated (the insert is the ON CONFLICT DO NOTHING probe), no attempt row, no event
    expect(state.ops.slice(ops).filter((o) => /:update$/.test(o))).toEqual([]);
    expect(store.agent_attempts).toHaveLength(1);
    expect(events(a.id)).toEqual(['started']);
    expect(mockWarn.mock.calls.some((c) => /refused \(in_progress\)/.test(c[0]))).toBe(true);
    // the held handle writes nothing, and its step still runs the wrapped work
    expect(await b.finish({ result: 'succeeded' })).toBeNull();
    expect(runRow()).toMatchObject({ lifecycle: 'running', attempts: 1 });
    // runManaged: the body never runs, the caller gets the code
    const body = jest.fn(async () => 'ran');
    await expect(runs.runManaged(base, body)).rejects.toMatchObject({ code: 'run_in_progress', held: { runId: a.id } });
    expect(body).not.toHaveBeenCalled();
    // a parked wait is held until an explicit signal — even after its (deliberately unextended) lease lapsed; a queued retry and a lapsed RUNNING lease reopen
    await a.wait('external', 'x');
    crash();
    expect((await runs.startRun(base)).held).toMatchObject({ runId: a.id, attemptNo: 1 });
    expect(mockWarn.mock.calls.some((c) => /is waiting_external on/.test(c[0]))).toBe(true);
    // explicit manual replay supersedes
    const c = await runs.startRun({ ...base, supersede: true });
    expect(c.attemptNo).toBe(2);
    expect(store.agent_attempts[0]).toMatchObject({ error_code: 'superseded' });
    await c.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: true });
    expect(runRow().lifecycle).toBe('queued');
    expect((await runs.startRun({ ...base, maxAttempts: 3 })).attemptNo).toBe(3);
  });

  test('a start on a crashed attempt (lease lapsed) supersedes it as attempt 2, and the older handle no longer writes the run', async () => {
    const a = await runs.startRun({ ...base, workItem: { sourceRef: 'w' } });
    crash();
    const b = await runs.startRun(base);
    expect(a.id).toBe(b.id);
    expect([a.attemptNo, b.attemptNo]).toEqual([1, 2]);
    expect(a.attemptId).not.toBe(b.attemptId);
    expect(store.agent_attempts.map((x) => x.attempt_no)).toEqual([1, 2]);
    // fenced transitions from the older handle move nothing and write no event
    expect(await a.wait('human', 'x')).toBe(false);
    expect(await a.resume()).toBe(false);
    expect(await a.checkpoint({ n: 1 })).toBe(false);
    expect(events(a.id)).toEqual(['started', 'resumed']);
    expect(await a.finish({ result: 'succeeded', disposition: 'applied' })).toBe(false);
    // fenced out: the run still belongs to attempt 2; no work-item / event side effects, only attempt 1 closed
    expect(runRow()).toMatchObject({ lifecycle: 'running', attempts: 2, result: null, disposition: null });
    expect(store.agent_attempts[0]).toMatchObject({ result: 'succeeded' });
    expect(store.work_items[0].status).not.toBe('done');
    expect(events(a.id)).toEqual(['started', 'resumed']);
    expect(await a.fail({ error: new Error('late'), errorCode: 'openai_500' })).toMatchObject({ retry: false, stale: true });
    expect(events(a.id)).toEqual(['started', 'resumed']);
    await a.heartbeat({ progress: true });
    expect(runRow().progress_sequence ?? 0).toBe(0);
    // spent: every later transition is a no-op
    expect(await a.wait('human', 'x')).toBeNull();
    expect(events(a.id)).toEqual(['started', 'resumed']);
    await b.fail({ error: new Error('x'), errorCode: 'openai_500' });
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'errored', attempts: 2 });
    expect(events(a.id)).toEqual(['started', 'resumed', 'failed']);
  });

  test('a write failure logs the operation and error code, never the driver message', async () => {
    const h = await runs.startRun(base);
    // step past the rate limiter's window (one warn per minute)
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    try {
      state.failNext = 'run_events';
      await h.checkpoint({ title: 'Jane Doe 941-555-0100' });
    } finally { nowSpy.mockRestore(); }
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toBe('[agent-runs] checkpoint failed (Error)'); // the transition, not the table
  });
});

describe('a spent handle', () => {
  test('after finish / fail the handle is one-shot: later calls are no-ops, the run and its artifacts / events stay as they were', async () => {
    const h = await runs.startRun({ ...base, workItem: { sourceRef: 'w' } });
    expect(await h.finish({ disposition: 'applied', artifacts: [{ kind: 'draft', content: 'x' }] })).toBe(true);
    const snapshot = JSON.stringify([runRow(), store.run_artifacts, store.run_events]);
    expect(await h.finish({ disposition: 'applied', artifacts: [{ kind: 'draft', content: 'again' }] })).toBe(false);
    expect(await h.fail({ error: new Error('late') })).toMatchObject({ retry: false, stale: true });
    await h.resume();
    await h.checkpoint({ n: 1 });
    await h.heartbeat({ progress: true });
    expect(await h.step({ key: 'late' }, async () => 'still runs')).toBe('still runs');
    expect(JSON.stringify([runRow(), store.run_artifacts, store.run_events])).toBe(snapshot);
    expect(store.agent_run_steps ?? []).toHaveLength(0);
  });

  test('a retry counts its progress from zero: the reopened row was reset, and the handle must not carry attempt 1\'s count', async () => {
    const a = await runs.startRun(base);
    await a.heartbeat({ progress: true });
    await a.heartbeat({ progress: true });
    expect(runRow().progress_sequence).toBe(2);
    await a.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: false });
    const b = await runs.startRun({ ...base, supersede: true });
    expect(runRow().progress_sequence).toBe(0);
    await b.heartbeat({ progress: true });
    expect(runRow().progress_sequence).toBe(1);
  });

  test('progress is incremented in the fenced update: a heartbeat whose write failed recorded no progress, so the next one lands at 1, not 2 (Codex r12)', async () => {
    const h = await runs.startRun(base);
    state.failNext = 'agent_runs';
    expect(await h.heartbeat({ progress: true })).toBeNull();
    expect(runRow().progress_sequence).toBe(0);
    await h.heartbeat({ progress: true });
    expect(runRow().progress_sequence).toBe(1);
  });

  test('a failed write inside finish / fail rolls the whole transition back: the run stays running and its attempt open', async () => {
    const a = await runs.startRun(base);
    state.failNext = 'run_events';
    expect(await a.finish({ result: 'succeeded' })).toBe(false);
    expect(runRow()).toMatchObject({ lifecycle: 'running', result: null, finished_at: null });
    expect(store.agent_attempts[0].finished_at).toBeUndefined();
    expect(store.run_artifacts || []).toHaveLength(0); // (the warn is rate-limited to one a minute across this file)
    // nothing persisted → the handle is NOT spent: closing again works
    expect(await a.finish({ result: 'succeeded' })).toBe(true);
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'succeeded' });
    expect(events(a.id)).toEqual(['started', 'finished']);
    // fail: the same — no half-persisted retry state
    const b = await runs.startRun({ ...base, sourceRunId: 'r2', idempotencyKey: 'k-r2', maxAttempts: 3 });
    state.failNext = 'run_events';
    const r = await b.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: true });
    expect(r).toEqual({ retry: false, failureClass: 'provider', result: null, stale: false, persisted: false });
    const row = store.agent_runs.find((x) => x.source_run_id === 'r2');
    expect(row).toMatchObject({ lifecycle: 'running', error_code: null });
    expect(store.agent_attempts.find((x) => x.run_id === row.id).finished_at).toBeUndefined();
    // … and the retry can be recorded on the next call
    expect((await b.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: true })).retry).toBe(true);
    expect(row.lifecycle).toBe('queued');
  });

  test('a reopen supersedes a crashed attempt (one open attempt at most); the old handle may still replace the placeholder, but a recorded outcome is never rewritten', async () => {
    const a = await runs.startRun(base);
    crash();
    const b = await runs.startRun(base); // a never finished: its worker crashed
    expect(store.agent_attempts[0]).toMatchObject({ result: 'canceled', error_code: 'superseded' });
    expect(store.agent_attempts[0].finished_at).toBeInstanceOf(Date);
    expect(store.agent_attempts[1].finished_at).toBeUndefined();
    // the crashed handle comes back: its real outcome replaces the placeholder (nothing else moves)
    expect(await a.finish({ result: 'succeeded' })).toBe(false);
    expect(store.agent_attempts[0]).toMatchObject({ result: 'succeeded', error_code: null });
    // a second terminal call racing on one handle: the first outcome stands
    const [f1, f2] = await Promise.all([b.finish({ result: 'succeeded' }), b.fail({ error: new Error('late'), errorCode: 'openai_500' })]);
    expect(f1).toBe(true);
    expect(f2).toMatchObject({ stale: true });
    expect(store.agent_attempts[1]).toMatchObject({ result: 'succeeded', error_code: null });
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'succeeded' });
  });

  test('lock order: every path that closes or reopens a run writes agent_runs before agent_attempts (a reopen racing a completion cannot deadlock)', async () => {
    const order = (from) => state.ops.slice(from).filter((o) => o.endsWith(':update') && /^agent_(runs|attempts):/.test(o)).map((o) => o.split(':')[0]);
    const a = await runs.startRun(base);
    let mark = state.ops.length;
    await a.finish({});
    expect(order(mark)).toEqual(['agent_runs', 'agent_attempts']);
    const b = await runs.startRun({ ...base, supersede: true }); // reopen: run first, then the open attempts, then the new attempt row
    expect(order(mark).slice(2, 4)).toEqual(['agent_runs', 'agent_attempts']);
    mark = state.ops.length;
    await b.fail({ error: new Error('x'), errorCode: 'openai_500' });
    expect(order(mark)).toEqual(['agent_runs', 'agent_attempts']);
  });

  test('a retryable fail racing a finish and another fail on one handle: the run is queued once, the attempt errored once, the others are stale', async () => {
    const h = await runs.startRun({ ...base, maxAttempts: 3 });
    const failure = { error: new Error('x'), errorCode: 'openai_500', retryable: true };
    const [r1, f, r2] = await Promise.all([h.fail(failure), h.finish({ result: 'succeeded' }), h.fail(failure)]);
    expect(r1.retry).toBe(true);
    expect(f).toBe(false);
    expect(r2).toMatchObject({ retry: false, stale: true });
    expect(runRow()).toMatchObject({ lifecycle: 'queued', attempts: 1, error_code: 'openai_500', result: null });
    expect(store.agent_attempts[0]).toMatchObject({ result: 'errored', error_code: 'openai_500' });
    expect(events(h.id)).toEqual(['started', 'retry_scheduled']);
  });

  test('runManaged retries a terminal write that rolled back once, then lets the handle go', async () => {
    await runs.runManaged(base, async () => { state.failNext = 'run_events'; return 1; });
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'succeeded' });
    expect(events(runRow().id)).toEqual(['started', 'finished']);
    await expect(runs.runManaged({ ...base, sourceRunId: 'r2', idempotencyKey: 'k-r2', maxAttempts: 3 }, async () => { state.failNext = 'run_events'; const e = new Error('x'); e.code = 'openai_500'; e.retryable = true; throw e; })).rejects.toThrow('x');
    expect(store.agent_runs.find((r) => r.source_run_id === 'r2')).toMatchObject({ lifecycle: 'queued', error_code: 'openai_500' });
  });

  test('a stale handle stepping past the budget stamps nothing and writes no budget event on the newer attempt', async () => {
    const a = await runs.startRun(base);
    crash();
    const b = await runs.startRun(base); // attempt 2: a is stale
    const max = policyFor('blog_draft').budget.max_steps;
    for (let i = 0; i <= max; i += 1) await a.step({ key: `a${i}` }, async () => i);
    expect(events(b.id)).not.toContain('budget_exceeded');
    expect(runRow().summary?.budget_exceeded).toBeUndefined();
    // nor may the stale handle narrate wait / resume / checkpoint on the newer attempt
    expect(await a.wait('human', 'x')).toBe(false);
    expect(await a.resume('y')).toBe(false);
    expect(await a.checkpoint({ k: 1 })).toBe(false);
    expect(events(b.id).filter((e) => ['waiting', 'checkpoint'].includes(e))).toEqual([]);
    expect(runRow().lifecycle).toBe('running');
    for (let i = 0; i <= max; i += 1) await b.step({ key: `b${i}` }, async () => i);
    expect(events(b.id).filter((e) => e === 'budget_exceeded')).toHaveLength(1);
    expect(runRow().summary.budget_exceeded).toBe('steps');
  });

  test('the agent version is the persisted run\'s: a reopen under another version keeps it (and scopes calls to it); a row without one binds a later start\'s', async () => {
    const a = await runs.startRun({ ...base, agentVersionId: 'ver-1' });
    expect(a.agentVersionId).toBe('ver-1');
    await a.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: false });
    let seen = null;
    await runs.runManaged({ ...base, agentVersionId: 'ver-2', supersede: true }, async (h) => { seen = { ctx: context.current().agentVersionId, handle: h.agentVersionId }; });
    expect(seen).toEqual({ ctx: 'ver-1', handle: 'ver-1' });
    expect(runRow().agent_version_id).toBe('ver-1');
    const c = await runs.startRun({ ...base, sourceRunId: 'r2', idempotencyKey: 'k-r2' });
    expect(c.agentVersionId).toBeNull();
    await c.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: false });
    const d = await runs.startRun({ ...base, sourceRunId: 'r2', idempotencyKey: 'k-r2', agentVersionId: 'ver-3', supersede: true });
    expect(d.agentVersionId).toBe('ver-3');
    expect(store.agent_runs.find((r) => r.source_run_id === 'r2').agent_version_id).toBe('ver-3');
  });

  test('a work item supplied by a later start binds on the run row, not only the handle', async () => {
    const a = await runs.startRun(base);
    expect(a.workItemId).toBeNull();
    expect(runRow().work_item_id).toBeNull();
    await a.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: false });
    const b = await runs.startRun({ ...base, workItem: { sourceRef: 'entity-9', entityType: 'lead', entityId: '9', title: 'Lead 9' }, supersede: true });
    expect(b.workItemId).toBe(store.work_items[0].id);
    expect(runRow().work_item_id).toBe(store.work_items[0].id);
    await b.finish({});
    expect(store.work_items[0].status).toBe('done');
  });

  test('a retry continues the step numbering, so the timeline orders across attempts', async () => {
    const a = await runs.startRun(base);
    await a.step({ key: 'one' }, async () => 1);
    await a.step({ key: 'two' }, async () => 2);
    await a.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: true });
    const b = await runs.startRun({ ...base, maxAttempts: 2 });
    await b.step({ key: 'three' }, async () => 3);
    expect(store.agent_run_steps.map((s) => [s.step_key, s.seq])).toEqual([['one', 1], ['two', 2], ['three', 3]]);
    // the budget counts THIS attempt's steps, not the timeline position
    const max = policyFor('blog_draft').budget.max_steps;
    for (let i = 0; i < max - 1; i += 1) await b.step({ key: `s${i}` }, async () => i);
    expect(events(b.id)).not.toContain('budget_exceeded');
    await b.step({ key: 'over' }, async () => 1);
    expect(events(b.id).filter((e) => e === 'budget_exceeded')).toHaveLength(1);
  });
});

describe('fail and retry', () => {
  test('retryable + idempotency + attempts left → queued for retry; the last attempt → terminal errored', async () => {
    const a = await runs.startRun({ ...base, maxAttempts: 2 });
    expect(await a.fail({ error: new Error('down'), errorCode: 'openai_500', retryable: true })).toEqual({ retry: true, failureClass: 'provider', result: null });
    expect(runRow()).toMatchObject({ lifecycle: 'queued', result: null, failure_class: 'provider', error_code: 'openai_500' });
    expect(events(a.id)).toEqual(['started', 'retry_scheduled']);
    const b = await runs.startRun(base);
    expect(b.attemptNo).toBe(2);
    // the reopened run carries a fresh lease and a clean current outcome; attempt 1 keeps its error
    expect(runRow()).toMatchObject({ lifecycle: 'running', result: null, finished_at: null, failure_class: null, error_code: null, error_message: null });
    expect(runRow().lease_expires_at.getTime() - runRow().leased_at.getTime()).toBe(policyFor('blog_draft').stall_after_ms);
    expect(store.agent_attempts[0]).toMatchObject({ result: 'errored', error_code: 'openai_500' });
    expect(await b.fail({ error: new Error('still'), errorCode: 'openai_500', retryable: true })).toMatchObject({ retry: false, result: 'errored' });
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'errored', attempts: 2 });
    expect(store.agent_attempts[1]).toMatchObject({ result: 'errored', error_code: 'openai_500' });
  });

  test('a reopen under a different lane keeps the persisted lane and its no-retry rule', async () => {
    const money = Object.entries(require('../services/agent-control/lane-policies').LANE_RUNTIME).find(([, p]) => runs.NO_RETRY_CLASSES.has(p.side_effect_class))[0];
    const a = await runs.startRun({ laneId: money, sourceSystem: SRC, sourceRunId: 'mm', idempotencyKey: 'kmm', maxAttempts: 3 });
    await a.fail({ error: new Error('x') });
    const b = await runs.startRun({ laneId: 'blog_draft', sourceSystem: SRC, sourceRunId: 'mm', idempotencyKey: 'kmm', maxAttempts: 3, supersede: true });
    expect(b.laneId).toBe(money);
    expect(runRow().lane_id).toBe(money);
    expect((await b.fail({ error: new Error('y'), retryable: true })).retry).toBe(false);
    expect(mockWarn.mock.calls.some((c) => /lane mismatch/.test(c[0]))).toBe(true);
  });

  test('an error code named like a prototype member resolves no result table entry', async () => {
    const h = await runs.startRun(base);
    const r = await h.fail({ error: new Error('x'), errorCode: 'constructor' });
    expect(r.result).toBe('errored');
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'errored', error_code: 'constructor' });
  });

  test('an explicit failure class outside the taxonomy is classified from the code instead', async () => {
    const h = await runs.startRun({ ...base, sourceRunId: 'fc', idempotencyKey: 'k-fc' });
    expect((await h.fail({ errorCode: 'openai_500', failureClass: 'typo' })).failureClass).toBe('provider');
  });

  test('no retry without an idempotency key, on a money / irreversible lane, or when not retryable', async () => {
    const noKey = await runs.startRun({ laneId: 'blog_draft', sourceSystem: SRC, sourceRunId: 'nk', maxAttempts: 3 });
    // a run that can never retry stores one attempt — the row never reads 1/3 (Codex r14)
    expect(store.agent_runs.find((r) => r.source_run_id === 'nk').max_attempts).toBe(1);
    expect((await noKey.fail({ error: new Error('x'), retryable: true })).retry).toBe(false);
    const money = Object.entries(require('../services/agent-control/lane-policies').LANE_RUNTIME).find(([, p]) => runs.NO_RETRY_CLASSES.has(p.side_effect_class));
    expect(money).toBeDefined();
    const m = await runs.startRun({ laneId: money[0], sourceSystem: SRC, sourceRunId: 'm', idempotencyKey: 'km', maxAttempts: 3 });
    expect(store.agent_runs.find((r) => r.source_run_id === 'm').max_attempts).toBe(1);
    expect((await m.fail({ error: new Error('x'), retryable: true })).retry).toBe(false);
    const nr = await runs.startRun({ ...base, sourceRunId: 'nr', idempotencyKey: 'k-nr', maxAttempts: 3 });
    expect((await nr.fail({ error: new Error('x'), retryable: false })).retry).toBe(false);
  });

  test('result follows the class: timeout → timed_out, budget_exhausted code → budget_exhausted; quality classes raise an eval candidate; messages are sanitized', async () => {
    const t = await runs.startRun({ ...base, sourceRunId: 't', idempotencyKey: 'k-t' });
    expect((await t.fail({ error: new Error('slow'), errorCode: 'timeout_budget_exhausted' })).result).toBe('timed_out');
    const b = await runs.startRun({ ...base, sourceRunId: 'b', idempotencyKey: 'k-b' });
    expect((await b.fail({ errorCode: 'budget_exhausted' })).result).toBe('budget_exhausted');
    const q = await runs.startRun({ ...base, sourceRunId: 'q', idempotencyKey: 'k-q' });
    await q.fail({ error: new Error('bad 941-555-0100'), failureClass: 'incorrect' });
    expect(events(q.id)).toEqual(['started', 'failed', 'eval_candidate']);
    expect(store.agent_runs.find((r) => r.source_run_id === 'q').error_message).toBe('bad [redacted-number]');
  });
});

describe('runManaged', () => {
  test('runs fn inside the run + lane scope, finishes from a shaped return, returns the value', async () => {
    const out = await runs.runManaged(base, async (h) => {
      const c = context.current();
      expect(c.runId).toBe(h.id);
      expect(c.laneId).toBe('blog_draft');
      expect(c.traceId).toBe(h.traceId);
      return { result: 'succeeded', disposition: 'applied', summary: { n: 1 } };
    });
    expect(out.disposition).toBe('applied');
    expect(runRow()).toMatchObject({ lifecycle: 'terminal', result: 'succeeded', disposition: 'applied', summary: { n: 1 } });
    expect(context.current().runId).toBeNull();
  });

  test('a reopened managed run scopes its work under the persisted lane, not the requested one', async () => {
    const a = await runs.startRun({ laneId: 'lead_triage', sourceSystem: SRC, sourceRunId: 'rm' });
    await a.finish({});
    const seen = await runs.runManaged({ laneId: 'blog_draft', sourceSystem: SRC, sourceRunId: 'rm', supersede: true }, async (h) => ({ lane: context.current().laneId, handleLane: h.laneId }));
    expect(seen).toEqual({ lane: 'lead_triage', handleLane: 'lead_triage' });
  });

  test('a plain return finishes succeeded; a throw fails the run (retryable flag honoured) and re-throws unchanged', async () => {
    expect(await runs.runManaged({ ...base, sourceRunId: 'p', idempotencyKey: 'k-p' }, async () => 42)).toBe(42);
    const err = Object.assign(new Error('nope'), { code: 'openai_429', retryable: true });
    await expect(runs.runManaged({ ...base, sourceRunId: 'e', idempotencyKey: 'k-e', maxAttempts: 2 }, async () => { throw err; })).rejects.toBe(err);
    expect(store.agent_runs.find((r) => r.source_run_id === 'e')).toMatchObject({ lifecycle: 'queued', failure_class: 'provider', error_code: 'openai_429' });
  });

  test('gate off: runManaged still runs fn and returns / rethrows with nothing written', async () => {
    delete process.env.GATE_AGENT_RUNS;
    expect(await runs.runManaged(base, async (h) => h.inert)).toBe(true);
    await expect(runs.runManaged(base, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(store.agent_runs).toBeUndefined();
  });
});
