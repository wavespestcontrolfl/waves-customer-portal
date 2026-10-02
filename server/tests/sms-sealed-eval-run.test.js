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
  // This file never manipulates GATE_SMS_REAL_ANSWERS — currentPromptVersion()
  // is what createExamRun/resume/summary actually call now, so it must match
  // PROMPT_VERSION here for every existing "same version" fixture to hold.
  currentPromptVersion: jest.fn(() => 'house_voice_v9_test'),
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
  // Matches the mocked PROMPT_VERSION/currentPromptVersion() above — every
  // run fixture actually reaching examOneItem in this file is pinned to
  // 'house_voice_v9_test', so this must agree or the new prompt-version
  // mismatch guard (pre-push audit P1) would refuse every item.
  promptVersion: 'house_voice_v9_test',
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

  test('refuses a v12 run when every active item predates GATE_SMS_REAL_ANSWERS (Codex r3 fail-fast)', async () => {
    // currentPromptVersion() resolves a v12 real-answers version, but the
    // only active item's frozen facts_block carries no FOLLOW-UP SLA RIGHT
    // NOW line — every gate-on facts block stamps that line unconditionally,
    // so its absence means the item was frozen before the gate existed.
    // Starting the run would grade nothing; refuse instead of running dark.
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v12_real_answers');
    const dbi = makeRunnerDb({ runs: [], items: [item('i1')] });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi }))
      .rejects.toThrow(/no sealed coverage for house_voice_v12_real_answers: only 0 of 1/);
  });

  // Pre-push audit P1 (r4): the bar is the exam gate's own coverage rule —
  // at least half the active pool — so a run that could never pass is not
  // started (and the nightly sweep cannot call the version examined while
  // the freezer is still replenishing).
  test('refuses a v12 run while fewer than half the active items are v12-compatible', async () => {
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v12_real_answers');
    const V12 = 'FROZEN FACTS\nFOLLOW-UP SLA RIGHT NOW: within the hour';
    const dbi = makeRunnerDb({ runs: [], items: [item('i1'), item('i2'), item('i3'), item('i4', { facts_block: V12 })] });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi }))
      .rejects.toThrow(/only 1 of 4 active items .* \(need 2\)/);
  });

  test('a v12 run with at least half the pool v12-compatible is created normally', async () => {
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v12_real_answers');
    const dbi = makeRunnerDb({
      runs: [],
      items: [
        item('i1'), // pre-v12 — excluded later, but doesn't block creation
        item('i2', { facts_block: 'FROZEN FACTS for i2\nFOLLOW-UP SLA RIGHT NOW: reply within 1 business hour, 8am-8pm ET.' }),
      ],
    });
    const run = await sealedEval.createExamRun({ providerLeg: 'anthropic', dbi });
    expect(run.prompt_version).toBe('house_voice_v12_real_answers');
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

  test('stamps currentPromptVersion(), not the static PROMPT_VERSION (pre-push audit P1)', async () => {
    // Prove the create path reads the DYNAMIC resolver, not the frozen
    // constant: point currentPromptVersion() at a different value than
    // PROMPT_VERSION and confirm the run stamps (and baselines against)
    // the DYNAMIC one — exactly what happens for real once
    // GATE_SMS_REAL_ANSWERS flips PROMPT_VERSION and currentPromptVersion()
    // apart.
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v12_real_answers');
    const dbi = makeRunnerDb({
      runs: [{ id: 'r-v11', status: 'complete', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test', model: 'claude-sonnet-5' }],
      // v12-compatible facts_block (Codex r3 fail-fast guard): unrelated to
      // what this test proves, but createExamRun now refuses to start a v12
      // run with zero v12-compatible active items.
      items: [item('i1', { facts_block: 'FROZEN FACTS for i1\nFOLLOW-UP SLA RIGHT NOW: reply within 1 business hour, 8am-8pm ET.' })],
    });
    const run = await sealedEval.createExamRun({ providerLeg: 'anthropic', dbi });
    expect(run.prompt_version).toBe('house_voice_v12_real_answers');
    // the v9_test run is a DIFFERENT version from the dynamic current one,
    // so it's a valid default baseline
    expect(run.baseline_run_id).toBe('r-v11');
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

  test('a run whose draft used a DIFFERENT prompt version than the run is pinned to fails instead of mixing evidence (pre-push audit P1)', async () => {
    // Same "static per run" contract as the voice-profile pin above, but for
    // the prompt version itself: generateGroundedDraft reads
    // GATE_SMS_REAL_ANSWERS live on every call, so a gate flip mid-sitting
    // could otherwise draft a later item under a version the run's own
    // prompt_version column disagrees with — mixing v11 and v12 evidence
    // inside one run.
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test' }],
      items: [item('i1')],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ ...goodDraft(), promptVersion: 'house_voice_v12_real_answers' });
    judge.judgeOne.mockResolvedValue(judgment());
    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('failed');
    // no result row was recorded under the mismatched version
    expect(dbi.state.results.filter((r) => r.run_id === 'r1')).toHaveLength(0);
  });

  test('a run whose draft used the SAME prompt version as the run completes normally', async () => {
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'openai', prompt_version: 'house_voice_v9_test' }],
      items: [item('i1')],
    });
    drafter.generateGroundedDraft.mockResolvedValue(goodDraft());
    judge.judgeOne.mockResolvedValue(judgment());
    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('complete');
    expect(dbi.state.results.filter((r) => r.run_id === 'r1')).toHaveLength(1);
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

// Codex r3 (PR #5119): a v12 real-answers run replaying items frozen BEFORE
// GATE_SMS_REAL_ANSWERS existed would grade scheduling/cancellation/handoff
// replies against instructions (OPEN TIMES, the FOLLOW-UP SLA RIGHT NOW
// handoff wording) whose facts the frozen snapshot never carries. These lock
// the exclusion: a v12 run skips an incompatible item without calling the
// drafter or judge, records it as an 'ungradable' sentinel (same shape as
// the terminal no-progress rule), and the run still completes; a compatible
// item, and any v11 run regardless of the item's facts, are unaffected.
describe('examOneItem — v12 facts-compatibility exclusion (Codex r3)', () => {
  test('v12 run + pre-v12 item (facts_block lacks FOLLOW-UP SLA RIGHT NOW): excluded, drafter/judge never called, run still completes', async () => {
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v12_real_answers');
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'anthropic', prompt_version: 'house_voice_v12_real_answers', baseline_run_id: null }],
      items: [item('i1')], // default fixture facts_block has no SLA line
    });

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });

    expect(out.status).toBe('complete');
    expect(drafter.generateGroundedDraft).not.toHaveBeenCalled();
    expect(judge.judgeOne).not.toHaveBeenCalled();
    const result = dbi.state.results.find((r) => r.run_id === 'r1' && r.item_id === 'i1');
    expect(result).toMatchObject({ verdict: 'ungradable' });
    expect(result.notes).toMatch(/outside the fact contract of house_voice_v12_real_answers \(items must carry "FOLLOW-UP SLA RIGHT NOW:" and lack "COMPANY FACTS \(owner-approved; state these plainly\):" \+ "LABEL FACTS \(" \+ "VISIT STATUS & OPEN LOOPS:" \+ "FREE RE-SERVICE:"\)/);
    const finalPatch = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'complete');
    expect(finalPatch).toBeTruthy();
    // Excluded — never counted as graded (same rule the terminal no-progress
    // sentinel already relies on in finalizeRun).
    expect(finalPatch.patch.items_judged).toBe(0);
  });

  test('v12 run + v12-compatible item (facts_block carries FOLLOW-UP SLA RIGHT NOW): examined as today', async () => {
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v12_real_answers');
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'anthropic', prompt_version: 'house_voice_v12_real_answers', baseline_run_id: null }],
      items: [item('i1', { facts_block: 'FROZEN FACTS for i1\nFOLLOW-UP SLA RIGHT NOW: reply within 1 business hour, 8am-8pm ET.' })],
    });
    drafter.generateGroundedDraft.mockResolvedValue({ ...goodDraft(), promptVersion: 'house_voice_v12_real_answers' });
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });

    expect(out.status).toBe('complete');
    expect(drafter.generateGroundedDraft).toHaveBeenCalledTimes(1);
    expect(judge.judgeOne).toHaveBeenCalledTimes(1);
    const result = dbi.state.results.find((r) => r.run_id === 'r1' && r.item_id === 'i1');
    expect(result.verdict).toBe('equivalent');
    const finalPatch = dbi.state.runPatches.find((p) => p.id === 'r1' && p.patch.status === 'complete');
    expect(finalPatch.patch.items_judged).toBe(1);
  });

  test('v11 run + pre-v12 item (facts_block lacks FOLLOW-UP SLA RIGHT NOW): examined as today, unchanged', async () => {
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v9_test');
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'anthropic', prompt_version: 'house_voice_v9_test', baseline_run_id: null }],
      items: [item('i1')], // default fixture facts_block has no SLA line either — irrelevant for a v11 run
    });
    drafter.generateGroundedDraft.mockResolvedValue(goodDraft());
    judge.judgeOne.mockResolvedValue(judgment('equivalent', { safety: 9, voice: 7, actions: 8, overall: 8 }));

    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });

    expect(out.status).toBe('complete');
    expect(drafter.generateGroundedDraft).toHaveBeenCalledTimes(1);
    expect(judge.judgeOne).toHaveBeenCalledTimes(1);
    const result = dbi.state.results.find((r) => r.run_id === 'r1' && r.item_id === 'i1');
    expect(result.verdict).toBe('equivalent');
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


// PR #5119 follow-up #4: compatibility is the full fact contract of the
// prompt version — a category tag requires that category's fact line too.
describe('category-aware sealed compatibility', () => {
  const { requiredFactMarkers, itemCompatibleWith } = require('../services/sms-sealed-eval');
  const SLA = 'FOLLOW-UP SLA RIGHT NOW: within the hour';
  const RS = 'FREE RE-SERVICE: not eligible';

  test('requiredFactMarkers: v11 none; v12 the SLA line; +c adds the FREE RE-SERVICE line; other tags add nothing', () => {
    expect(requiredFactMarkers('house_voice_v11')).toEqual([]);
    expect(requiredFactMarkers('house_voice_v12_real_answers')).toEqual(['FOLLOW-UP SLA RIGHT NOW:']);
    expect(requiredFactMarkers('house_voice_v12_real_answers+c')).toEqual(['FOLLOW-UP SLA RIGHT NOW:', 'FREE RE-SERVICE:']);
    expect(requiredFactMarkers('house_voice_v12_real_answers+bclm')).toEqual(['FOLLOW-UP SLA RIGHT NOW:', 'FREE RE-SERVICE:']);
    expect(requiredFactMarkers('house_voice_v12_real_answers+bl')).toEqual(['FOLLOW-UP SLA RIGHT NOW:']);
  });

  test('itemCompatibleWith: an item frozen under plain v12 is compatible with v12 but NOT with +c; one frozen under +c is compatible ONLY with +c', () => {
    expect(itemCompatibleWith(`X\n${SLA}\n`, 'house_voice_v12_real_answers')).toBe(true);
    expect(itemCompatibleWith(`X\n${SLA}\n`, 'house_voice_v12_real_answers+c')).toBe(false);
    expect(itemCompatibleWith(`X\n${SLA}\n${RS}\nBILLING:\n`, 'house_voice_v12_real_answers+c')).toBe(true);
    // EXACT contract (#5194 r1 P1): a category fact the version does not carry must be absent
    expect(itemCompatibleWith(`X\n${SLA}\n${RS}\nBILLING:\n`, 'house_voice_v12_real_answers')).toBe(false);
    expect(itemCompatibleWith(`X\n${SLA}\n${RS}\nBILLING:\n`, 'house_voice_v12_real_answers+bl')).toBe(false);
    expect(itemCompatibleWith('CUSTOMER: old', 'house_voice_v11')).toBe(true);
    // #5194 r7 P1: v11's contract forbids the v12 lines (a rollback)
    expect(itemCompatibleWith(`X\n${SLA}\n`, 'house_voice_v11')).toBe(false);
    expect(itemCompatibleWith(`X\n${SLA}\n${RS}\nBILLING:\n`, 'house_voice_v11')).toBe(false);
  });

  test('a v11 rollback run refuses a pool frozen under v12, and excludes a v12 item from its exam', async () => {
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v11');
    const v12Pool = makeRunnerDb({ runs: [], items: [item('i1', { facts_block: `FROZEN\n${SLA}` }), item('i2', { facts_block: `FROZEN\n${SLA}` })] });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi: v12Pool }))
      .rejects.toThrow(/no sealed coverage for house_voice_v11: only 0 of 2 active items lack "FOLLOW-UP SLA RIGHT NOW:" \+ "COMPANY FACTS \(owner-approved; state these plainly\):" \+ "LABEL FACTS \(" \+ "VISIT STATUS & OPEN LOOPS:" \+ "FREE RE-SERVICE:"/);
    const dbi = makeRunnerDb({
      runs: [{ id: 'r1', status: 'running', provider_leg: 'anthropic', prompt_version: 'house_voice_v11', baseline_run_id: null }],
      items: [item('i1', { facts_block: `FROZEN\n${SLA}` })],
    });
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v11');
    const out = await sealedEval.runSealedExam({ runId: 'r1', dbi });
    expect(out.status).toBe('complete');
    expect(drafter.generateGroundedDraft).not.toHaveBeenCalled();
    expect(dbi.state.results.find((r) => r.item_id === 'i1')).toMatchObject({ verdict: 'ungradable' });
  });

  test('createExamRun under +c refuses when the pool was sealed under plain v12 (no FREE RE-SERVICE line)', async () => {
    drafter.currentPromptVersion.mockReturnValueOnce('house_voice_v12_real_answers+c');
    const dbi = makeRunnerDb({ runs: [], items: [item('i1', { facts_block: `FROZEN\n${SLA}` }), item('i2', { facts_block: `FROZEN\n${SLA}` })] });
    await expect(sealedEval.createExamRun({ providerLeg: 'anthropic', dbi }))
      .rejects.toThrow(/only 0 of 2 active items carry "FOLLOW-UP SLA RIGHT NOW:" \+ "FREE RE-SERVICE:"/);
  });
});

// Codex round-20 P2 (PR #5336): FREE RE-SERVICE is required only by the numeric identity token "2"+; every
// older identity keeps its HISTORICAL contract, so an exam created before the deploy stays gradable.
describe('sealed fact contract — historical identities vs the current 2_cf identity', () => {
  const { requiredFactMarkers, forbiddenFactMarkers } = require('../services/sms-sealed-eval');
  const SLA = 'FOLLOW-UP SLA RIGHT NOW:';
  const RS = 'FREE RE-SERVICE:';
  const CF = 'COMPANY FACTS (owner-approved; state these plainly):';
  const LBL = 'LABEL FACTS (';
  const VL = 'VISIT STATUS & OPEN LOOPS:'; // '_cflv' (SMS facts-gap PR 1); contract order is SLA, CF, LBL, VL, RS
  const contract = (v) => ({ required: requiredFactMarkers(v), forbidden: forbiddenFactMarkers(v) });

  test('historical bare and _cf identities: FREE RE-SERVICE only with the complaints tag, forbidden otherwise', () => {
    expect(contract('house_voice_v12_real_answers')).toEqual({ required: [SLA], forbidden: [CF, LBL, VL, RS] });
    expect(contract('house_voice_v12_real_answers+bl')).toEqual({ required: [SLA], forbidden: [CF, LBL, VL, RS] });
    expect(contract('house_voice_v12_real_answers+c')).toEqual({ required: [SLA, RS], forbidden: [CF, LBL, VL] });
    expect(contract('house_voice_v12_real_answers_cf')).toEqual({ required: [SLA, CF], forbidden: [LBL, VL, RS] });
    expect(contract('house_voice_v12_real_answers_cf+c')).toEqual({ required: [SLA, CF, RS], forbidden: [LBL, VL] });
  });

  test('the numeric token 2+ requires FREE RE-SERVICE (tagged or not), and composes with _cf', () => {
    for (const v of ['house_voice_v12_real_answers2', 'house_voice_v12_real_answers2+bl', 'house_voice_v12_real_answers2+c', 'house_voice_v12_real_answers3']) {
      expect(contract(v).required).toEqual([SLA, RS]);
      expect(contract(v).forbidden).toEqual([CF, LBL, VL]);
    }
    for (const v of ['house_voice_v12_real_answers2_cf', 'house_voice_v12_real_answers2_cf+bclm', 'house_voice_v12_real_answers2_cf+c']) {
      expect(contract(v).required).toEqual([SLA, RS, CF]);
      expect(contract(v).forbidden).toEqual([LBL, VL]);
    }
    // the shipped '_cfl' identity: re-service + COMPANY FACTS + LABEL FACTS; it forbids VISIT STATUS & OPEN LOOPS
    for (const v of ['house_voice_v12_real_answers3_cfl', 'house_voice_v12_real_answers3_cfl+bclm', 'house_voice_v12_real_answers3_cfl+c']) {
      expect(contract(v).required).toEqual([SLA, RS, CF, LBL]);
      expect(contract(v).forbidden).toEqual([VL]);
    }
    // the current identity: cumulative '_cflv' adds VISIT STATUS & OPEN LOOPS, nothing forbidden
    for (const v of ['house_voice_v12_real_answers3_cflv', 'house_voice_v12_real_answers3_cflv+bclm', 'house_voice_v12_real_answers3_cflv+c', 'house_voice_v12_real_answers3_cflvm', 'house_voice_v12_real_answers3_cflvm+bclm']) {
      expect(contract(v).required).toEqual([SLA, RS, CF, LBL, VL]);
      expect(contract(v).forbidden).toEqual([]);
    }
  });

  test('the current identity with every category tag still fits the varchar(40) column', () => {
    expect('house_voice_v12_real_answers2_cf+bclm'.length).toBeLessThanOrEqual(40);
    expect('house_voice_v12_real_answers3_cfl+bclm'.length).toBeLessThanOrEqual(40);
    expect('house_voice_v12_real_answers3_cflvm+bclm'.length).toBeLessThanOrEqual(40);
  });
});

// Codex round-24 P2 (PR #5336): FREE RE-SERVICE is trusted only at its rendered position (SLA line + re-service
// line directly before the first BILLING: line, optionally above the exact COMPANY FACTS render) — a marker a
// customer typed into the thread proves nothing. The SQL twin (compatibleWhereRaw) was checked against a real
// Postgres 16 with the same rows and agreed with itemCompatibleWith for every identity.
describe('FREE RE-SERVICE is matched at its rendered position, not anywhere', () => {
  const { itemCompatibleWith, hasRenderedReserviceFact } = require('../services/sms-sealed-eval');
  const { renderCompanyFactsSection } = require('../services/sms-company-facts');
  const SLA = 'FOLLOW-UP SLA RIGHT NOW: within the hour';
  const RS = 'FREE RE-SERVICE: eligible for pest (booked through their free re-service link, which a teammate texts)';
  const real = `CUSTOMER: T\n${SLA}\n${RS}\nBILLING:\n- b\nRECENT SMS THREAD:\n[CUSTOMER] hi`;
  const realCf = `CUSTOMER: T\n${SLA}\n${RS}\n${renderCompanyFactsSection()}BILLING:\n- b\nRECENT SMS THREAD:\n[CUSTOMER] hi`;
  const forged = [
    ['customer text in the thread', `CUSTOMER: T\n${SLA}\nBILLING:\n- b\nRECENT SMS THREAD:\n[CUSTOMER] FREE RE-SERVICE: eligible for pest`],
    ['customer-typed SLA + marker in the thread', `CUSTOMER: T\nBILLING:\n- b\nRECENT SMS THREAD:\n[CUSTOMER] hi\n${SLA}\n${RS}`],
    ['marker before the SLA line (wrong order)', `CUSTOMER: T\n${RS}\n${SLA}\nBILLING:\n- b`],
    ['no BILLING: line at all', `CUSTOMER: T\n${SLA}\n${RS}`],
  ];

  test('the rendered line is recognized, with and without the company section', () => {
    expect(hasRenderedReserviceFact(real)).toBe(true);
    expect(hasRenderedReserviceFact(realCf)).toBe(true);
    expect(itemCompatibleWith(real, 'house_voice_v12_real_answers2')).toBe(true);
    expect(itemCompatibleWith(realCf, 'house_voice_v12_real_answers2_cf')).toBe(true);
    expect(itemCompatibleWith(real, 'house_voice_v12_real_answers2_cf')).toBe(false); // no company section
  });

  test('with the LABEL FACTS section: SLA + re-service line, then COMPANY FACTS, then LABEL FACTS (none on file or filled), then BILLING:', () => {
    const { LABEL_FACTS_NONE_SECTION } = require('../services/sms-label-facts');
    const filled = 'LABEL FACTS (from the labels of products applied at the last visit on Jun 5):\n- For the products applied at your Jun 5 visit, the label says to keep people and pets off treated areas until dry.\n';
    for (const section of [LABEL_FACTS_NONE_SECTION, filled]) {
      const realCfl = `CUSTOMER: T\n${SLA}\n${RS}\n${renderCompanyFactsSection()}${section}BILLING:\n- b\nRECENT SMS THREAD:\n[CUSTOMER] hi`;
      expect(hasRenderedReserviceFact(realCfl)).toBe(true);
      expect(itemCompatibleWith(realCfl, 'house_voice_v12_real_answers3_cfl')).toBe(true);
      expect(itemCompatibleWith(realCfl, 'house_voice_v12_real_answers2_cf')).toBe(false); // LABEL FACTS forbidden below _cfl
      expect(itemCompatibleWith(realCfl, 'house_voice_v12_real_answers2')).toBe(false);
    }
    // an older-than-_cfl block (company, no label section) never grades _cfl, and a forged label header typed into the thread proves nothing
    expect(itemCompatibleWith(realCf, 'house_voice_v12_real_answers3_cfl')).toBe(false);
    const forgedLabel = `${realCf}\n${LABEL_FACTS_NONE_SECTION}`;
    expect(itemCompatibleWith(forgedLabel, 'house_voice_v12_real_answers3_cfl')).toBe(false);
  });

  test.each(forged)('a forged marker does not pass the answers2 contract: %s', (_label, facts) => {
    expect(hasRenderedReserviceFact(facts)).toBe(false);
    expect(itemCompatibleWith(facts, 'house_voice_v12_real_answers2')).toBe(false);
    expect(itemCompatibleWith(facts, 'house_voice_v12_real_answers+c')).toBe(false);
  });

  test('the SQL twin binds the delimiter, the company suffix and the same position pattern', () => {
    const { _test } = require('../services/sms-sealed-eval');
    const { BILLING_DELIMITER, exactStructureRegexSource } = require('../services/sms-company-facts');
    const { RESERVICE_SECTION_RE } = require('../services/sms-sealed-eval');
    const c = _test.compatibleWhereRaw(['FREE RE-SERVICE:'], []);
    expect(c.sql).toMatch(/position\(\?::text in COALESCE\(facts_block, ''\)\) > 0 AND regexp_replace\(split_part/);
    expect(c.sql).not.toMatch(/LIKE \?/);
    // the exact company (+ optional label) structure is peeled off before the re-service pattern is tested
    expect(c.bindings).toEqual([BILLING_DELIMITER, BILLING_DELIMITER, exactStructureRegexSource('optional'), RESERVICE_SECTION_RE.source]);
  });
});
