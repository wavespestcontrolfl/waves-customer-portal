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
  // sealed runs are stamped with the sealed identity, not the live cohort
  SEALED_EXAM_VERSION: 'house_voice_v9_test',
  generateGroundedDraft: jest.fn(),
  // effective profile = none unless a test overrides — keeps the pin inert
  resolveEffectiveVoiceProfile: jest.fn(async () => null),
}));
jest.mock('../services/sms-shadow-judge', () => ({
  judgeOne: jest.fn(),
}));
// Only the terminal stuck-tail rule's control probe reaches llm/call from
// this module — mock it so no probe ever leaves the test process.
jest.mock('../services/llm/call', () => ({
  dispatch: jest.fn(),
}));

const drafter = require('../services/sms-shadow-drafter');
const judge = require('../services/sms-shadow-judge');
const llmCall = require('../services/llm/call');
const sealedEval = require('../services/sms-sealed-eval');

function makeRunnerDb({ runs = [], items = [], results = [], voiceProfiles = [], insertErrorCode = null } = {}) {
  const state = {
    runsById: new Map(runs.map((r) => [r.id, { ...r }])),
    items: items.map((i) => ({ ...i })),
    results: results.map((r) => ({ ...r })),
    voiceProfiles: voiceProfiles.map((v) => ({ ...v })),
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
      if (name === 'limit') b._limit = args[0];
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
          const rows = state.results.filter(matches);
          out = b._first ? rows[0] : rows;
        }
      } else if (tableKey === 'sms_sealed_eval_items') {
        const active = state.items.filter((i) => i.active !== false);
        if (b._joined) {
          const pending = active.filter(
            (i) => !state.results.some((r) => r.item_id === i.id && r.run_id === state.lastLoadedRunId)
          );
          // Counts see the FULL pending set; row fetches honor .limit —
          // the runner pages by 25 while the terminal-rule cap check counts
          // the whole tail, and that distinction is load-bearing.
          out = b._count
            ? [{ count: String(pending.length) }]
            : (b._limit ? pending.slice(0, b._limit) : pending);
        } else {
          const rows = active.filter(matches);
          out = b._count ? [{ count: String(rows.length) }] : (b._first ? rows[0] : rows);
        }
      } else if (tableKey === 'voice_profiles') {
        const all = state.voiceProfiles.filter(matches);
        out = b._first ? all[0] : all;
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
  drafter.resolveEffectiveVoiceProfile.mockClear(); // keep the default null impl, drop call history
  // Control probe answers by default — outage-shaped probes are per-test.
  llmCall.dispatch.mockReset().mockResolvedValue({ ok: true, text: 'OK' });
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
    await expect(sealedEval.createExamRun({ providerLeg: 'mistral', dbi }))
      .rejects.toThrow(/unknown sealed-eval provider leg/);
  });

  test('measurement legs (gemini/sol/opus/fable) are valid, but autonomy rides only on the live legs', async () => {
    // the exam accepts every candidate…
    for (const leg of ['gemini', 'luna', 'opus', 'fable']) expect(sealedEval.EXAM_LEGS).toContain(leg);
    const dbi = makeRunnerDb({ runs: [], items: [item('i1')] });
    const run = await sealedEval.createExamRun({ providerLeg: 'gemini', dbi });
    expect(run.provider_leg).toBe('gemini');
    // …while the graduation gate and the nightly auto-sweep are pinned to
    // the two LIVE SMS providers — an experimental leg must neither block
    // autonomy nor auto-spend.
    expect(sealedEval.LIVE_EXAM_LEGS).toEqual(['anthropic', 'openai']);
  });

  test('stamps the RUNNING drafter version and defaults the baseline to the latest complete different-version same-leg run', async () => {
    const dbi = makeRunnerDb({
      runs: [
        // model must MATCH the leg's current model (codex r12) — a
        // different-model prior is not a valid baseline
        { id: 'r-old-other-model', status: 'complete', provider_leg: 'anthropic', prompt_version: 'house_voice_v8', model: 'claude-old-model' },
        { id: 'r-old', status: 'complete', provider_leg: 'anthropic', prompt_version: 'house_voice_v8', model: 'claude-sonnet-5' },
        { id: 'r-other-leg', status: 'complete', provider_leg: 'openai', prompt_version: 'house_voice_v8', model: 'gpt-5.6-sol' },
        { id: 'r-same-version', status: 'complete', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test', model: 'claude-sonnet-5' },
      ],
      items: [item('i1'), item('i2')],
    });
    const run = await sealedEval.createExamRun({ providerLeg: 'anthropic', dbi });
    expect(run.prompt_version).toBe('house_voice_v9_test'); // from the drafter, never a caller param
    expect(run.items_total).toBe(2);
    expect(run.baseline_run_id).toBe('r-old'); // same leg, different version, SAME model
    expect(run.model).toBe('claude-sonnet-5'); // runs stamp their drafting model (codex r12)
    expect(run.status).toBe('running');
    expect(run.voice_profile_version).toBeNull(); // effective profile = none in the default mock
  });

  test('stamps the EFFECTIVE voice-profile version at creation (Codex r2 pin)', async () => {
    drafter.resolveEffectiveVoiceProfile.mockResolvedValueOnce({ version: 4, profile_text: 'Warm.' });
    const dbi = makeRunnerDb({ runs: [], items: [item('i1')] });
    const run = await sealedEval.createExamRun({ providerLeg: 'anthropic', dbi });
    expect(run.voice_profile_version).toBe(4);
  });
});

describe('runSealedExam — voice-profile pin (Codex r2)', () => {
  test('a pinned run drafts every item under the FROZEN profile text, not the current effective one', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test', voice_profile_version: 4 }],
      items: [item('i1')],
      voiceProfiles: [{ version: 4, profile_text: 'Warm and brief.' }],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ ...goodDraft(), voiceProfileVersion: 4 });
    judge.judgeOne.mockResolvedValue(judgment());
    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('complete');
    expect(drafter.generateGroundedDraft).toHaveBeenCalledWith(
      expect.objectContaining({ voiceProfile: expect.objectContaining({ version: 4, profile_text: 'Warm and brief.' }) })
    );
    // and the run never consulted the CURRENT effective profile — the run row is the pin
    expect(drafter.resolveEffectiveVoiceProfile).not.toHaveBeenCalled();
  });

  test('an unpinned run drafts explicitly profile-free (voiceProfile null, never undefined)', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test', voice_profile_version: null }],
      items: [item('i1')],
    });
    drafter.generateGroundedDraft.mockResolvedValue(goodDraft());
    judge.judgeOne.mockResolvedValue(judgment());
    await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(drafter.generateGroundedDraft).toHaveBeenCalledWith(
      expect.objectContaining({ voiceProfile: null })
    );
  });

  test('a pinned run whose drafts fell back to the BASE prompt fails instead of reporting a phantom-profile exam (codex r4)', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test', voice_profile_version: 4 }],
      items: [item('i1')],
      voiceProfiles: [{ version: 4, profile_text: 'Warm and brief.' }],
    });
    // the drafter reports the profile never reached the prompt (stamp null)
    drafter.generateGroundedDraft.mockResolvedValue({ ...goodDraft(), voiceProfileVersion: null });
    judge.judgeOne.mockResolvedValue(judgment());
    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('failed');
    // no result row was recorded under the phantom profile
    expect(dbi.state.results.filter((r) => r.run_id === 'r1')).toHaveLength(0);
  });

  test('createExamRun refuses when the effective profile moved past the caller\'s expected pin (codex r4 sweep freeze)', async () => {
    drafter.resolveEffectiveVoiceProfile.mockResolvedValueOnce({ version: 5, profile_text: 'x' });
    const dbi = makeRunnerDb({ runs: [], items: [item('i1')] });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', expectedVoiceProfileVersion: 4, dbi }))
      .rejects.toMatchObject({ code: 'PROFILE_CHANGED' });
    // matching pin creates normally
    drafter.resolveEffectiveVoiceProfile.mockResolvedValueOnce({ version: 4, profile_text: 'x' });
    const run = await sealedEval.createExamRun({ providerLeg: 'anthropic', expectedVoiceProfileVersion: 4, dbi });
    expect(run.voice_profile_version).toBe(4);
  });

  test('a pinned run whose profile row vanished is FINALIZED failed — never drafts unpinned, never wedges the one-running index (codex r3)', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test', voice_profile_version: 9 }],
      items: [item('i1')],
      voiceProfiles: [],
    });
    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/voice profile v9, which no longer exists/);
    // the row must leave 'running' (the partial unique index keys on it) —
    // a pre-try throw would have stranded it and blocked every future exam
    const failedPatch = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'failed');
    expect(failedPatch).toBeTruthy();
    expect(drafter.generateGroundedDraft).not.toHaveBeenCalled();
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

  test('resume refuses a run from a superseded drafter version AND retires a stranded running row', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v8_old' }],
    });
    await expect(sealedEval.runSealedExam({ runId: 'r1', dbi }))
      .rejects.toThrow(/start a new run/);
    // Without this the one-running unique index would block every new run
    // forever — the stale row must flip to failed as part of the refusal.
    const retired = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'failed');
    expect(retired).toBeTruthy();
    expect(retired.patch.error).toMatch(/superseded/);
  });

  test('a stale FAILED run is refused without touching its status (already unwedged)', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'failed', provider_leg: 'openai', prompt_version: 'house_voice_v8_old' }],
    });
    await expect(sealedEval.runSealedExam({ runId: 'r1', dbi }))
      .rejects.toThrow(/start a new run/);
    expect(dbi.state.runPatches).toHaveLength(0);
  });

  test('a create that loses the insert race surfaces RUN_IN_PROGRESS (one-running unique index)', async () => {
    const dbi = makeRunnerDb({ runs: [], items: [item('i1')], insertErrorCode: '23505' });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi }))
      .rejects.toMatchObject({ code: 'RUN_IN_PROGRESS' });
  });

  test('an explicit baseline must be a COMPLETE run on the SAME leg', async () => {
    const runs = [
      { id: 'r-failed', status: 'failed', provider_leg: 'anthropic', prompt_version: 'v7' },
      { id: 'r-other-leg', status: 'complete', provider_leg: 'openai', prompt_version: 'v7' },
      { id: 'r-good', status: 'complete', provider_leg: 'anthropic', prompt_version: 'v7' },
    ];
    for (const bad of ['r-failed', 'r-other-leg', 'r-missing']) {
      const dbi = makeRunnerDb({ runs, items: [item('i1')] });
      await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', baselineRunId: bad, dbi }))
        .rejects.toMatchObject({ code: 'INVALID_BASELINE' });
    }
    const dbi = makeRunnerDb({ runs, items: [item('i1')] });
    const run = await sealedEval.createExamRun({ providerLeg: 'anthropic', baselineRunId: 'r-good', dbi });
    expect(run.baseline_run_id).toBe('r-good');
  });
});

describe('runSealedExam — terminal no-progress rule', () => {
  const noProgressError = 'no progress in a full batch — aborting run';

  test('a resume of a no-progress-failed run excludes the still-stuck tail as ungradable and COMPLETES', async () => {
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: noProgressError, started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i1'), item('i2')],
      results: [{ run_id: 'r1', item_id: 'i1', verdict: 'equivalent', draft_response: 'Happy to check on that for you!', scores: JSON.stringify({ safety: 9, voice: 7, actions: 8, overall: 8 }) }],
    });
    // The stuck item keeps failing deterministically on this sitting too —
    // while the judge control probe (re-judging i1) still parses.
    drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('complete');

    const sentinel = dbi.state.results.find((r) => r.run_id === 'r1' && r.item_id === 'i2');
    expect(sentinel).toMatchObject({ verdict: 'ungradable' });
    expect(sentinel.notes).toMatch(/terminal no-progress rule/);

    // The sentinel holds the completion slot but is NOT judged: it shows in
    // verdict_counts yet stays out of items_judged (the graduation gate's
    // unsafeRate denominator).
    const complete = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'complete');
    expect(complete).toBeTruthy();
    expect(complete.patch.items_judged).toBe(1);
    expect(JSON.parse(complete.patch.verdict_counts)).toMatchObject({ equivalent: 1, ungradable: 1 });
  });

  test('a resume of a run that failed for any OTHER reason does not arm the rule — it aborts again instead of excluding', async () => {
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: 'run r1 is pinned to voice profile v3, which no longer exists', started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i2')],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });

    const out = await sealedExamExpectFailed(dbi);
    expect(out.error).toMatch(/no progress/);
    expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);
  });

  test('a consecutive-failures abort ALSO arms the rule — a tail of exactly MAX_CONSECUTIVE_FAILURES items completes on the second sitting instead of looping forever', async () => {
    // 5 stuck items behind one graded item: the first sitting can only die
    // on the consecutive bail (it fires mid-batch, before the no-progress
    // check can run), so the terminal rule must arm on that abort shape too.
    // The graded item doubles as the judge control probe's material.
    const stuck = ['s1', 's2', 's3', 's4', 's5'];
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: '5 consecutive item failures — anthropic leg unavailable?', started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i-graded'), ...stuck.map((id) => item(id))],
      results: [{ run_id: 'r1', item_id: 'i-graded', verdict: 'equivalent', draft_response: 'Happy to check on that for you!', scores: null }],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('complete');
    for (const id of stuck) {
      expect(dbi.state.results.find((r) => r.item_id === id)).toMatchObject({ verdict: 'ungradable' });
    }
  });

  test('an ALL-stuck cohort has no judge-control material — it stays failed for manual diagnosis instead of completing on zero graded items', async () => {
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: noProgressError, started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i-stuck')],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });

    const out = await sealedExamExpectFailed(dbi);
    expect(out.error).toMatch(/no progress/);
    expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);
  });

  test('a judge that no longer parses on previously-graded material blocks exclusion — a regressed judge is pipeline breakage, not item pathology', async () => {
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: noProgressError, started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i-graded'), item('i-stuck')],
      results: [{ run_id: 'r1', item_id: 'i-graded', verdict: 'equivalent', draft_response: 'Happy to check on that for you!', scores: null }],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });
    judge.judgeOne.mockResolvedValue(null); // control re-judge is unparseable

    const out = await sealedExamExpectFailed(dbi);
    expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);
  });

  test('a stuck prefix ahead of healthy items converges in two sittings — the deferred bail grades the healthy remainder, then the true tail is excluded', async () => {
    // 5 stuck items sealed FIRST (they lead every batch), 3 healthy behind
    // them. Without the deferred bail, the fifth consecutive failure aborts
    // mid-batch every night and the healthy items are never even attempted.
    const stuck = ['s1', 's2', 's3', 's4', 's5'];
    const healthy = ['h1', 'h2', 'h3'];
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: '5 consecutive item failures — anthropic leg unavailable?', started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [...stuck.map((id) => item(id)), ...healthy.map((id) => item(id))],
    });
    drafter.generateGroundedDraft.mockImplementation(async ({ factsBlock }) => (
      stuck.some((id) => factsBlock.includes(id))
        ? { parsed: null, passes: 1, converged: false, model: null }
        : goodDraft()
    ));
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    // Sitting 1 (armed): grades the healthy remainder, then aborts on the
    // true tail — real progress happened, so nothing is excluded yet.
    const first = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(first.status).toBe('failed');
    expect(first.processed).toBe(healthy.length);
    expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);

    // Sitting 2 (armed again): pending is exactly the stuck tail — excluded,
    // run completes.
    const second = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(second.status).toBe('complete');
    for (const id of stuck) {
      expect(dbi.state.results.find((r) => r.item_id === id)).toMatchObject({ verdict: 'ungradable' });
    }
    const complete = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'complete');
    expect(complete.patch.items_judged).toBe(healthy.length);
  });

  test('a dead provider on the armed sitting keeps the abort — two zero-progress nights are NOT proof of item pathology without a live-provider probe', async () => {
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: noProgressError, started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i-stuck')],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });
    llmCall.dispatch.mockResolvedValue({ ok: false, reason: 'anthropic_529' });

    const out = await sealedExamExpectFailed(dbi);
    expect(out.error).toMatch(/no progress/);
    expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);
    // The probe went to the run's own draft leg.
    expect(llmCall.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'anthropic' }),
      expect.objectContaining({ jsonMode: false }),
    );
  });

  test('an ok-but-empty (or truncated) probe response is NOT provider health — that is the empty-output failure mode itself', async () => {
    for (const probeResult of [
      { ok: true, text: '   ' },
      { ok: true, text: 'OK', response: { stop_reason: 'max_tokens' } },
    ]) {
      const dbi = makeRunnerDb({
        runs: [{
          id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
          baseline_run_id: null, error: noProgressError, started_at: new Date('2026-07-18T00:00:00Z'),
        }],
        items: [item('i-stuck')],
      });
      drafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });
      llmCall.dispatch.mockResolvedValue(probeResult);

      const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
      expect(out.status).toBe('failed');
      expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);
    }
  });

  test('the cap is checked against the FULL pending tail — a cap at/above the page size cannot gut an outage cohort page by page', async () => {
    const prevEnv = process.env.SEALED_EVAL_STUCK_EXCLUDE_MAX;
    process.env.SEALED_EVAL_STUCK_EXCLUDE_MAX = '30';
    try {
      let se;
      let isolatedDrafter;
      // isolateModules (NOT resetModules): the module tree re-instantiates
      // inside the sandbox so envNum re-reads the override, while the outer
      // registry — and every top-level module reference the other tests
      // hold — stays intact.
      jest.isolateModules(() => {
        se = require('../services/sms-sealed-eval');
        isolatedDrafter = require('../services/sms-shadow-drafter');
      });
      isolatedDrafter.generateGroundedDraft.mockResolvedValue({ parsed: null, passes: 1, converged: false, model: null });

      // 31 pending stuck items: the first PAGE is 25 (≤ the misconfigured
      // cap of 30) but the full tail is 31 (> cap) — exclusion must refuse.
      const dbi = makeRunnerDb({
        runs: [{
          id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
          baseline_run_id: null, error: noProgressError, started_at: new Date('2026-07-18T00:00:00Z'),
        }],
        items: Array.from({ length: 31 }, (_, i) => item(`s${i}`)),
      });

      const out = await se.runSealedExam({ runId: 'r1', dbi });
      expect(out.status).toBe('failed');
      expect(out.error).toMatch(/no progress/);
      expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);
    } finally {
      if (prevEnv === undefined) delete process.env.SEALED_EVAL_STUCK_EXCLUDE_MAX;
      else process.env.SEALED_EVAL_STUCK_EXCLUDE_MAX = prevEnv;
    }
  });

  test('exclusion requires ZERO progress on the resume — a fresh tail failing after real progress aborts instead of being excluded on its first sitting', async () => {
    const dbi = makeRunnerDb({
      runs: [{
        id: 'r1', status: 'failed', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test',
        baseline_run_id: null, error: noProgressError, started_at: new Date('2026-07-18T00:00:00Z'),
      }],
      items: [item('i-fine'), item('i-stuck')],
    });
    // i-fine now drafts (the prior blocker cleared); i-stuck keeps failing.
    drafter.generateGroundedDraft.mockImplementation(async ({ factsBlock }) => (
      factsBlock.includes('i-fine')
        ? goodDraft()
        : { parsed: null, passes: 1, converged: false, model: null }
    ));
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    const out = await sealedExamExpectFailed(dbi);
    expect(out.error).toMatch(/no progress/);
    // The item that failed once on THIS sitting is left pending, not branded.
    expect(dbi.state.results.some((r) => r.verdict === 'ungradable')).toBe(false);
  });

  test('ungradable sentinels are invisible to significance on BOTH sides of the pairing', () => {
    const scores = JSON.stringify({ safety: 9, voice: 7, actions: 8, overall: 8 });
    const out = sealedEval.computeSignificance({
      candidateResults: [
        { item_id: 'i1', verdict: 'equivalent', scores },
        { item_id: 'i2', verdict: 'ungradable', scores: null }, // baseline had it unsafe — must NOT count as newly safe
      ],
      baselineResults: [
        { item_id: 'i1', verdict: 'equivalent', scores },
        { item_id: 'i2', verdict: 'draft_unsafe', scores },
        { item_id: 'i3', verdict: 'ungradable', scores: null },
      ],
    });
    expect(out.pairedItems).toBe(1);
    expect(out.newlySafe).toBe(0);
    expect(out.newlyUnsafe).toBe(0);
  });

  async function sealedExamExpectFailed(dbi) {
    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('failed');
    return out;
  }
});

describe('evaluateExamGate — graded-coverage fail-closed', () => {
  // Both live legs healthy unless a test overrides one — isolates the leg
  // under test to a single expected blocker.
  const healthyRun = {
    unsafeRate: 0, itemsJudged: 41, itemsTotal: 41, significance: null,
  };
  const summaryWith = (anthropicRun) => async () => ({
    currentVersion: 'house_voice_v9_test',
    items: { active: 41 },
    legs: { anthropic: anthropicRun, openai: { ...healthyRun } },
  });

  test('a completed run that graded ZERO items blocks — completion alone is not exam evidence', async () => {
    // All-ungradable completion: unsafeRate is null, so without the coverage
    // check the unsafe-rate cap silently never applies and the leg passes.
    const blockers = await sealedEval.evaluateExamGate({
      summaryFn: summaryWith({ unsafeRate: null, itemsJudged: 0, itemsTotal: 4, significance: null }),
    });
    expect(blockers).toEqual([expect.stringMatching(/anthropic.*only 0 of 4 items graded/)]);
  });

  test('a completed run graded under half its cohort blocks', async () => {
    const blockers = await sealedEval.evaluateExamGate({
      summaryFn: summaryWith({ unsafeRate: 0, itemsJudged: 20, itemsTotal: 41, significance: null }),
    });
    expect(blockers).toEqual([expect.stringMatching(/anthropic.*only 20 of 41 items graded/)]);
  });

  test('normal sentinel-tail coverage passes — the unsafe-rate cap still applies after it', async () => {
    const clean = await sealedEval.evaluateExamGate({
      summaryFn: summaryWith({ unsafeRate: 0, itemsJudged: 39, itemsTotal: 41, significance: null }),
    });
    expect(clean).toEqual([]);
    const unsafe = await sealedEval.evaluateExamGate({
      summaryFn: summaryWith({ unsafeRate: 0.5, itemsJudged: 39, itemsTotal: 41, significance: null }),
    });
    expect(unsafe).toEqual([expect.stringMatching(/anthropic.*unsafe rate/)]);
  });
});
