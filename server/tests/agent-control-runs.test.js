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
  const state = { failNext: null, idSeq: 0 }; // failNext: table whose next op throws
  const uuid = () => `00000000-0000-4000-8000-${String(++state.idSeq).padStart(12, '0')}`;
  const matches = (row, where, whereNot) => Object.entries(where).every(([k, v]) => String(row[k]) === String(v))
    && Object.entries(whereNot || {}).every(([k, v]) => String(row[k]) !== String(v));
  const db = (table) => {
    if (!store[table]) store[table] = [];
    const st = { where: {}, whereNot: null, max: null, op: null, payload: null, returning: null, ignore: false, first: false };
    const chain = {
      insert(rows) { st.op = 'insert'; st.payload = rows; return chain; },
      onConflict() { return chain; },
      ignore() { st.ignore = true; return chain; },
      returning(col) { st.returning = col; return chain; },
      where(obj) { if (typeof obj === 'object') Object.assign(st.where, obj); return chain; },
      first() { st.first = true; return chain; },
      update(patch) { st.op = 'update'; st.payload = patch; return chain; },
      whereNot(col, val) { st.whereNot = { ...(st.whereNot || {}), [col]: val }; return chain; },
      max(expr) { st.max = expr; st.first = true; return chain; },
      then(resolve, reject) {
        try {
          if (state.failNext === table) { state.failNext = null; throw new Error(`fake ${table} down`); }
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
              if (!matches(r, st.where, st.whereNot)) continue;
              for (const [k, v] of Object.entries(st.payload)) {
                if (v && typeof v === 'object' && v.__merge) r[k] = { ...(r[k] || {}), ...v.__merge };
                else if (v && typeof v === 'object' && v.__inc) r[k] = Number(r[k] || 0) + 1;
                else r[k] = v;
              }
              out += 1;
            }
            if (st.returning) out = rows.filter((r) => matches(r, st.where, st.whereNot)).map((r) => ({ [st.returning]: r[st.returning] }));
          } else if (st.max) {
            const [col, alias] = String(st.max).split(' as ');
            const found = rows.filter((r) => matches(r, st.where, st.whereNot));
            out = { [alias]: found.length ? Math.max(...found.map((r) => Number(r[col] || 0))) : null };
          } else {
            const found = rows.filter((r) => matches(r, st.where, st.whereNot));
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
  db.transaction = async (fn) => fn(db);
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

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  state.failNext = null;
  state.idSeq = 0;
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
    const b = await runs.startRun(base);
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
    expect(store.agent_run_steps[0]).toMatchObject({ seq: 1, status: 'done', step_key: 'brief', attempt_id: h.attemptId });
    expect(runRow().progress_sequence).toBe(1);

    const boom = Object.assign(new Error('call 941-555-0100 failed'), { code: 'x' });
    await expect(h.step({ key: 'search', toolName: 'web_search' }, async () => { throw boom; })).rejects.toBe(boom);
    expect(store.agent_run_steps[1]).toMatchObject({ status: 'failed', tool_name: 'web_search', detail: 'call [redacted-number] failed' });
    expect(mockToolEvent).toHaveBeenCalledWith(expect.objectContaining({ source: 'agent_run', toolName: 'web_search', success: false, metadata: { run_id: h.id, step_id: store.agent_run_steps[1].id } }));
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

  test('budget: a step past max_steps records ONE budget_exceeded event and stamps the summary, never stops the caller', async () => {
    const h = await runs.startRun(base);
    const max = policyFor('blog_draft').budget.max_steps;
    for (let i = 0; i < max + 2; i += 1) await h.step({ key: `s${i}` }, async () => i);
    expect(events(h.id).filter((e) => e === 'budget_exceeded')).toHaveLength(1);
    expect(runRow().summary).toEqual({ budget_exceeded: 'steps' });
    expect(store.agent_run_steps).toHaveLength(max + 2);
  });
});

describe('concurrent starts', () => {
  test('two starts on one source key get distinct attempts, and the older handle no longer writes the run', async () => {
    const a = await runs.startRun({ ...base, workItem: { sourceRef: 'w' } });
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
    expect(mockWarn.mock.calls[0][0]).toBe('[agent-runs] run_events failed (Error)');
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
    const b = await runs.startRun(base);
    expect(runRow().progress_sequence).toBe(0);
    await b.heartbeat({ progress: true });
    expect(runRow().progress_sequence).toBe(1);
  });

  test('a work item supplied by a later start binds on the run row, not only the handle', async () => {
    const a = await runs.startRun(base);
    expect(a.workItemId).toBeNull();
    expect(runRow().work_item_id).toBeNull();
    await a.fail({ error: new Error('x'), errorCode: 'openai_500', retryable: false });
    const b = await runs.startRun({ ...base, workItem: { sourceRef: 'entity-9', entityType: 'lead', entityId: '9', title: 'Lead 9' } });
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
    const b = await runs.startRun({ laneId: 'blog_draft', sourceSystem: SRC, sourceRunId: 'mm', idempotencyKey: 'kmm', maxAttempts: 3 });
    expect(b.laneId).toBe(money);
    expect(runRow().lane_id).toBe(money);
    expect((await b.fail({ error: new Error('y'), retryable: true })).retry).toBe(false);
    expect(mockWarn.mock.calls.some((c) => /lane mismatch/.test(c[0]))).toBe(true);
  });

  test('an explicit failure class outside the taxonomy is classified from the code instead', async () => {
    const h = await runs.startRun({ ...base, sourceRunId: 'fc' });
    expect((await h.fail({ errorCode: 'openai_500', failureClass: 'typo' })).failureClass).toBe('provider');
  });

  test('no retry without an idempotency key, on a money / irreversible lane, or when not retryable', async () => {
    const noKey = await runs.startRun({ laneId: 'blog_draft', sourceSystem: SRC, sourceRunId: 'nk', maxAttempts: 3 });
    expect((await noKey.fail({ error: new Error('x'), retryable: true })).retry).toBe(false);
    const money = Object.entries(require('../services/agent-control/lane-policies').LANE_RUNTIME).find(([, p]) => runs.NO_RETRY_CLASSES.has(p.side_effect_class));
    expect(money).toBeDefined();
    const m = await runs.startRun({ laneId: money[0], sourceSystem: SRC, sourceRunId: 'm', idempotencyKey: 'km', maxAttempts: 3 });
    expect((await m.fail({ error: new Error('x'), retryable: true })).retry).toBe(false);
    const nr = await runs.startRun({ ...base, sourceRunId: 'nr', maxAttempts: 3 });
    expect((await nr.fail({ error: new Error('x'), retryable: false })).retry).toBe(false);
  });

  test('result follows the class: timeout → timed_out, budget_exhausted code → budget_exhausted; quality classes raise an eval candidate; messages are sanitized', async () => {
    const t = await runs.startRun({ ...base, sourceRunId: 't' });
    expect((await t.fail({ error: new Error('slow'), errorCode: 'timeout_budget_exhausted' })).result).toBe('timed_out');
    const b = await runs.startRun({ ...base, sourceRunId: 'b' });
    expect((await b.fail({ errorCode: 'budget_exhausted' })).result).toBe('budget_exhausted');
    const q = await runs.startRun({ ...base, sourceRunId: 'q' });
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
    const seen = await runs.runManaged({ laneId: 'blog_draft', sourceSystem: SRC, sourceRunId: 'rm' }, async (h) => ({ lane: context.current().laneId, handleLane: h.laneId }));
    expect(seen).toEqual({ lane: 'lead_triage', handleLane: 'lead_triage' });
  });

  test('a plain return finishes succeeded; a throw fails the run (retryable flag honoured) and re-throws unchanged', async () => {
    expect(await runs.runManaged({ ...base, sourceRunId: 'p' }, async () => 42)).toBe(42);
    const err = Object.assign(new Error('nope'), { code: 'openai_429', retryable: true });
    await expect(runs.runManaged({ ...base, sourceRunId: 'e', maxAttempts: 2 }, async () => { throw err; })).rejects.toBe(err);
    expect(store.agent_runs.find((r) => r.source_run_id === 'e')).toMatchObject({ lifecycle: 'queued', failure_class: 'provider', error_code: 'openai_429' });
  });

  test('gate off: runManaged still runs fn and returns / rethrows with nothing written', async () => {
    delete process.env.GATE_AGENT_RUNS;
    expect(await runs.runManaged(base, async (h) => h.inert)).toBe(true);
    await expect(runs.runManaged(base, async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(store.agent_runs).toBeUndefined();
  });
});
