/**
 * Exam runner — createExamRun guards, the replay loop (pinned route, frozen
 * facts), resume semantics, failure bail-out, and finalize aggregates +
 * significance vs baseline. Drafter/judge are module doubles; the DB is a
 * stateful routing fake keyed by table.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ mocked: true })));
jest.mock('../services/sms-shadow-drafter', () => ({
  PROMPT_VERSION: 'house_voice_v9_test',
  generateGroundedDraft: jest.fn(),
}));
jest.mock('../services/sms-shadow-judge', () => ({
  judgeOne: jest.fn(),
}));

const drafter = require('../services/sms-shadow-drafter');
const judge = require('../services/sms-shadow-judge');
const sealedEval = require('../services/sms-sealed-eval');

function makeRunnerDb({ runs = [], items = [], results = [], insertErrorCode = null } = {}) {
  const state = {
    runsById: new Map(runs.map((r) => [r.id, { ...r }])),
    items: items.map((i) => ({ ...i })),
    results: results.map((r) => ({ ...r })),
    runPatches: [],
    calls: [],
    lastLoadedRunId: null,
    nextRunSeq: 1,
  };
  const dbi = (table) => {
    const tableKey = typeof table === 'object' ? Object.values(table)[0] : table;
    const b = {
      _t: tableKey, _wheres: [], _whereNots: [], _kvWheres: [],
      _count: false, _first: false, _insert: null, _update: null, _joined: false,
    };
    const rec = (name) => (...args) => {
      state.calls.push([name, args, tableKey]);
      if ((name === 'where' || name === 'whereNull') && typeof args[0] === 'function') {
        args[0].call(b);
        return b;
      }
      if (name === 'where' && typeof args[0] === 'object') b._wheres.push(args[0]);
      if (name === 'where' && typeof args[0] === 'string' && args.length === 2) b._kvWheres.push([args[0], args[1]]);
      if (name === 'whereNot') b._whereNots.push(args);
      if (name === 'count') b._count = true;
      if (name === 'first') b._first = true;
      if (name === 'insert') b._insert = args[0];
      if (name === 'update') b._update = args[0];
      if (name === 'leftJoin') b._joined = true;
      return b;
    };
    for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'whereNot',
      'join', 'leftJoin', 'select', 'count', 'groupBy', 'orderBy', 'limit', 'insert', 'onConflict', 'ignore',
      'first', 'update', 'returning']) {
      b[m] = rec(m);
    }
    const matches = (row) => {
      for (const w of b._wheres) for (const [k, v] of Object.entries(w)) if (row[k] !== v) return false;
      for (const [k, v] of b._kvWheres) if (row[k] !== v) return false;
      for (const [k, v] of b._whereNots) if (row[k] === v) return false;
      return true;
    };
    b.then = (resolve, reject) => Promise.resolve().then(() => {
      let out;
      if (tableKey === 'sms_sealed_eval_runs') {
        if (b._insert) {
          if (insertErrorCode) {
            const e = new Error('duplicate key value violates unique constraint');
            e.code = insertErrorCode;
            throw e;
          }
          const row = { id: `run-new-${state.nextRunSeq += 1}`, started_at: new Date('2026-07-18T00:00:00Z'), ...b._insert };
          state.runsById.set(row.id, row);
          out = [row];
        } else if (b._update) {
          const target = [...state.runsById.values()].find(matches);
          if (target) {
            Object.assign(target, b._update);
            state.runPatches.push({ id: target.id, patch: b._update });
          }
          out = target ? 1 : 0;
        } else {
          const all = [...state.runsById.values()].filter(matches);
          if (b._first) {
            out = all[0];
            if (out) state.lastLoadedRunId = out.id;
          } else out = all;
        }
      } else if (tableKey === 'sms_sealed_eval_results') {
        if (b._insert) {
          const rows = Array.isArray(b._insert) ? b._insert : [b._insert];
          for (const r of rows) {
            if (!state.results.some((x) => x.run_id === r.run_id && x.item_id === r.item_id)) state.results.push(r);
          }
          out = [];
        } else {
          out = state.results.filter(matches);
        }
      } else if (tableKey === 'sms_sealed_eval_items') {
        const active = state.items.filter((i) => i.active !== false);
        if (b._joined) {
          const pending = active.filter(
            (i) => !state.results.some((r) => r.item_id === i.id && r.run_id === state.lastLoadedRunId)
          );
          out = b._count ? [{ count: String(pending.length) }] : pending;
        } else {
          out = b._count ? [{ count: String(active.length) }] : active;
        }
      } else {
        out = [];
      }
      return out;
    }).then(resolve, reject);
    return b;
  };
  dbi.raw = (sql) => sql;
  dbi.state = state;
  return dbi;
}

const item = (id, over = {}) => ({
  id,
  customer_id: `cust-${id}`,
  intent: 'general',
  inbound_message: 'when is my service?',
  facts_block: `FROZEN FACTS for ${id}`,
  context_summary: 'sum',
  human_reply_text: 'Thursday 1-3pm!',
  human_reply_sms_id: `sms-${id}`,
  scheduling_intent: false,
  active: true,
  sealed_at: '2026-07-10T00:00:00Z',
  ...over,
});

const goodDraft = (reply = 'Happy to check on that for you!') => ({
  parsed: { reply, intended_actions: [], auto_send_safe: true, missing_info: null },
  passes: 1,
  converged: true,
  model: 'test-model',
});

const judgment = (verdict, scores) => ({
  verdict,
  scores: scores ? JSON.stringify(scores) : null,
  notes: 'test note',
  model: 'judge-model',
});

beforeEach(() => {
  drafter.generateGroundedDraft.mockReset();
  judge.judgeOne.mockReset();
});

describe('createExamRun — guards and stamps', () => {
  test('refuses while any run is status=running (resume, never a parallel row)', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r-live', status: 'running', provider_leg: 'openai' }],
      items: [item('i1')],
    });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi }))
      .rejects.toMatchObject({ code: 'RUN_IN_PROGRESS', runId: 'r-live' });
  });

  test('refuses with no active sealed items', async () => {
    const dbi = makeRunnerDb({ runs: [], items: [item('i1', { active: false })] });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi }))
      .rejects.toThrow(/no active sealed items/);
  });

  test('unknown leg is rejected before any DB work', async () => {
    const dbi = makeRunnerDb({});
    await expect(sealedEval.createExamRun({ providerLeg: 'gemini', dbi }))
      .rejects.toThrow(/unknown sealed-eval provider leg/);
  });

  test('stamps the RUNNING drafter version and defaults the baseline to the latest complete different-version same-leg run', async () => {
    const dbi = makeRunnerDb({
      runs: [
        { id: 'r-old', status: 'complete', provider_leg: 'anthropic', prompt_version: 'house_voice_v8' },
        { id: 'r-other-leg', status: 'complete', provider_leg: 'openai', prompt_version: 'house_voice_v8' },
        { id: 'r-same-version', status: 'complete', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test' },
      ],
      items: [item('i1'), item('i2')],
    });
    const run = await sealedEval.createExamRun({ providerLeg: 'anthropic', dbi });
    expect(run.prompt_version).toBe('house_voice_v9_test'); // from the drafter, never a caller param
    expect(run.items_total).toBe(2);
    expect(run.baseline_run_id).toBe('r-old'); // same leg, different version
    expect(run.status).toBe('running');
  });
});

describe('runSealedExam — replay loop', () => {
  test('replays every item with the FROZEN facts and the run row\'s pinned leg, judges against the frozen reply, finalizes with aggregates + significance', async () => {
    const dbi = makeRunnerDb({
      runs: [
        {
          id: 'r-base', status: 'complete', provider_leg: 'openai', prompt_version: 'house_voice_v8',
        },
        {
          id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test', baseline_run_id: 'r-base',
        },
      ],
      items: [item('i1'), item('i2')],
      results: [
        { run_id: 'r-base', item_id: 'i1', verdict: 'draft_unsafe', scores: JSON.stringify({ safety: 3, voice: 6, overall: 4 }) },
        { run_id: 'r-base', item_id: 'i2', verdict: 'equivalent', scores: JSON.stringify({ safety: 9, voice: 7, overall: 8 }) },
      ],
    });
    drafter.generateGroundedDraft.mockResolvedValue(goodDraft());
    judge.judgeOne
      .mockResolvedValueOnce(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }))
      .mockResolvedValueOnce(judgment('draft_better', { safety: 10, voice: 8, actions: 9, overall: 9 }));

    // Caller passes the WRONG leg on resume — the run row must win.
    const out = await sealedEval.runSealedExam({ runId: 'r1', providerLeg: 'anthropic', dbi });
    expect(out.status).toBe('complete');
    expect(out.processed).toBe(2);

    // Every draft call replayed the frozen snapshot on the run's own leg.
    expect(drafter.generateGroundedDraft).toHaveBeenCalledTimes(2);
    for (const call of drafter.generateGroundedDraft.mock.calls) {
      expect(call[0].factsBlock).toMatch(/^FROZEN FACTS/);
      expect(call[0].routeOverride).toBe(sealedEval.EXAM_LEG_ROUTES.openai);
      expect(call[0].context).toBeUndefined(); // frozen replay never builds live context
    }
    // The judge graded against the frozen human reply, deterministically paired.
    expect(judge.judgeOne.mock.calls[0][1]).toMatchObject({ message_body: 'Thursday 1-3pm!' });

    // Finalize: aggregates + McNemar vs baseline (i1 improved, i2 no change).
    const finalPatch = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'complete');
    expect(finalPatch).toBeTruthy();
    expect(finalPatch.patch.items_judged).toBe(2);
    expect(finalPatch.patch.unsafe_count).toBe(0);
    expect(finalPatch.patch.avg_safety).toBeCloseTo(9.5, 5);
    const sig = JSON.parse(finalPatch.patch.significance);
    expect(sig).toMatchObject({ method: 'mcnemar_exact', newlySafe: 1, newlyUnsafe: 0, direction: 'improved' });
    expect(sig.significant).toBe(false); // one flipped item is not evidence
  });

  test('resume skips items that already have results (anti-join re-entry)', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test', baseline_run_id: null }],
      items: [item('i1'), item('i2')],
      results: [{ run_id: 'r1', item_id: 'i1', verdict: 'equivalent', scores: null }],
    });
    drafter.generateGroundedDraft.mockResolvedValue(goodDraft());
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('complete');
    expect(out.processed).toBe(1);
    expect(drafter.generateGroundedDraft).toHaveBeenCalledTimes(1);
    expect(drafter.generateGroundedDraft.mock.calls[0][0].factsBlock).toBe('FROZEN FACTS for i2');
  });

  test('a leg that produces nothing marks the run failed instead of looping forever', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test', baseline_run_id: null }],
      items: [item('i1'), item('i2')],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('failed');
    const failPatch = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'failed');
    expect(failPatch.patch.error).toMatch(/no progress|consecutive/);
  });

  test('a completed run is not resumable', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'complete', provider_leg: 'openai', prompt_version: 'x' }],
    });
    await expect(sealedEval.runSealedExam({ runId: 'r1', dbi })).rejects.toThrow(/not resumable/);
  });

  test('the pending-item queries freeze run membership to items sealed at-or-before run creation', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test', baseline_run_id: null, started_at: new Date('2026-07-18T00:00:00Z') }],
      items: [item('i1')],
    });
    drafter.generateGroundedDraft.mockResolvedValue(goodDraft());
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));
    await sealedEval.runSealedExam({ runId: 'r1', dbi });
    const freezeWheres = dbi.state.calls.filter(
      ([m, args, t]) => t === 'sms_sealed_eval_items' && m === 'where' && args[0] === 'si.sealed_at' && args[1] === '<='
    );
    // Both the runner sweep and the finalizer pending-count apply the freeze.
    expect(freezeWheres.length).toBeGreaterThanOrEqual(2);
    for (const [, args] of freezeWheres) expect(args[2]).toBeInstanceOf(Date);
  });

  test('a FAILED run reopens on resume, keeps its paid results, and completes', async () => {
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'openai', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: 'provider blip', started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i1'), item('i2')],
      results: [{ run_id: 'r1', item_id: 'i1', verdict: 'equivalent', scores: null }],
    });
    drafter.generateGroundedDraft.mockResolvedValue(goodDraft());
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('complete');
    expect(out.processed).toBe(1); // only i2 — i1's result was kept, not re-billed
    const reopen = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'running');
    expect(reopen).toBeTruthy();
    expect(reopen.patch.error).toBeNull();
    expect(dbi.state.runPatches.some((p) => p.id === 'r1' && p.patch.status === 'complete')).toBe(true);
  });

  test('resume refuses a run from a superseded drafter version (one run = one version)', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v8_old' }],
    });
    await expect(sealedEval.runSealedExam({ runId: 'r1', dbi }))
      .rejects.toThrow(/start a new run/);
  });

  test('a create that loses the insert race surfaces RUN_IN_PROGRESS (one-running unique index)', async () => {
    const dbi = makeRunnerDb({ runs: [], items: [item('i1')], insertErrorCode: '23505' });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi }))
      .rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
  });
});
