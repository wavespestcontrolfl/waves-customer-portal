/**
 * Cohort filtering — query-contract + fixture coverage (Codex P1, round 4).
 *
 * The graduation engine's promise is that superseded-version and NULL-version
 * evidence never reaches autonomous-send readiness. The pure-logic suite
 * can't see the knex filters, so these tests (a) run mixed-version fixture
 * rows through rollupSuggestOutcomes — the exact aggregation /intent-modes
 * uses — and (b) assert both fetchers actually apply the version filters to
 * their queries via a capturing fake knex.
 */
const {
  rollupSuggestOutcomes,
  fetchSuggestOutcomes,
  fetchLiveJudgeSignals,
} = require('../services/sms-graduation');

const CURRENT = 'house_voice_v8';
const PRIOR = 'house_voice_v7';

describe('rollupSuggestOutcomes — mixed current/prior/NULL fixtures', () => {
  const rows = [
    { intent: 'billing_question_needs_review', status: 'accepted', prompt_version: CURRENT, count: 5 },
    { intent: 'billing_question_needs_review', status: 'pending_review', prompt_version: CURRENT, count: 2 },
    { intent: 'billing_question_needs_review', status: 'accepted', prompt_version: PRIOR, count: 90 },
    { intent: 'billing_question_needs_review', status: 'corrected', prompt_version: PRIOR, count: 3 },
    { intent: 'billing_question_needs_review', status: 'accepted', prompt_version: null, count: 7 },
    { intent: 'billing_question_needs_review', status: 'ignored', prompt_version: CURRENT, count: 1 },
  ];

  test('display telemetry stays all-time (every version, NULL included)', () => {
    const e = rollupSuggestOutcomes(rows, [CURRENT]).get('billing_question_needs_review');
    expect(e.display.suggested).toBe(108); // every decision ever published
    expect(e.display.accepted).toBe(102); // 5 + 90 + 7
    expect(e.display.corrected).toBe(3);
    expect(e.display.pending).toBe(2);
  });

  test('readiness cohort counts ONLY current-version rows — prior accepts cannot qualify a new prompt', () => {
    const e = rollupSuggestOutcomes(rows, [CURRENT]).get('billing_question_needs_review');
    expect(e.cohort).toEqual({ accepted: 5, corrected: 0, ignored: 1 });
  });

  test('NULL prompt_version rows are evidence for no version (fail closed)', () => {
    const e = rollupSuggestOutcomes(rows, [CURRENT, PRIOR]).get('billing_question_needs_review');
    expect(e.cohort.accepted).toBe(95); // 5 + 90, never the 7 NULL-version rows
  });

  test("a null cohort (all_live) restores pre-cohort behavior — everything counts", () => {
    const e = rollupSuggestOutcomes(rows, null).get('billing_question_needs_review');
    expect(e.cohort.accepted).toBe(102);
  });

  test('statuses split per version still sum, never overwrite (groupBy prompt_version regression)', () => {
    const e = rollupSuggestOutcomes(rows, null).get('billing_question_needs_review');
    // 'accepted' appears in three rows; assignment instead of accumulation
    // would keep only the last row's count.
    expect(e.display.accepted).toBe(102);
  });
});

/**
 * Capturing fake knex: chainable, thenable, records every filter call —
 * including ones made inside function-style where(fn) groups, which is how
 * fetchLiveJudgeSignals applies its cohort filter.
 */
function makeFakeDb(rows = []) {
  const calls = [];
  const builder = {};
  const record = (name) => (...args) => {
    if (name === 'where' && typeof args[0] === 'function') {
      args[0].call(builder); // run the group so its inner filters are captured
    } else {
      calls.push([name, args]);
    }
    return builder;
  };
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'join', 'from', 'select', 'count', 'groupBy', 'orderBy']) {
    builder[m] = record(m);
  }
  builder.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  const dbi = () => builder;
  dbi.raw = (sql) => sql;
  dbi.with = (_name, cb) => {
    cb(builder);
    return builder;
  };
  dbi.calls = calls;
  return dbi;
}

const filterCalls = (dbi, name, column) => dbi.calls.filter(([m, args]) => m === name && args[0] === column);

describe('fetchSuggestOutcomes — cohort filter reaches the query', () => {
  test('an active cohort applies whereIn(a.prompt_version) (NULL rows drop out by SQL semantics)', async () => {
    const dbi = makeFakeDb([{ status: 'accepted', count: '4' }]);
    const out = await fetchSuggestOutcomes({ intent: 'x', dbi, cohortVersions: [CURRENT], voiceProfileVersion: null });
    expect(filterCalls(dbi, 'whereIn', 'a.prompt_version')).toEqual([['whereIn', ['a.prompt_version', [CURRENT]]]]);
    expect(out).toEqual({ accepted: 4, corrected: 0, ignored: 0 });
  });

  test('all_live (null cohort) applies no version filter', async () => {
    const dbi = makeFakeDb([]);
    await fetchSuggestOutcomes({ intent: 'x', dbi, cohortVersions: null, voiceProfileVersion: null });
    expect(filterCalls(dbi, 'whereIn', 'a.prompt_version')).toEqual([]);
  });

  test('joins the stamped draft and pins to the active voice profile (Codex r2)', async () => {
    const dbi = makeFakeDb([]);
    await fetchSuggestOutcomes({ intent: 'x', dbi, cohortVersions: [CURRENT], voiceProfileVersion: 7 });
    // the human-decision cohort rides the draft's stamp via entity_id
    expect(dbi.calls.some(([m, args]) => m === 'join' && JSON.stringify(args).includes('entity_id'))).toBe(true);
    const pins = dbi.calls.filter(([m, args]) => m === 'whereRaw' && /voice_profile_version/.test(args[0]));
    expect(pins).toHaveLength(1);
    expect(pins[0][1][1]).toEqual(['7']);
  });

  test('no-profile state pins to the sentinel; resolution failure propagates', async () => {
    const dbi = makeFakeDb([]);
    await fetchSuggestOutcomes({ intent: 'x', dbi, cohortVersions: null, voiceProfileVersion: null });
    const pins = dbi.calls.filter(([m, args]) => m === 'whereRaw' && /voice_profile_version/.test(args[0]));
    expect(pins[0][1][1]).toEqual(['__none__']);
    // omitted pin forces resolution via the drafter's effective-profile
    // resolver, whose builder chain (.first) this fake lacks — must throw,
    // so the executor gate fails closed rather than silently unpinning.
    const dbi2 = makeFakeDb([]);
    await expect(fetchSuggestOutcomes({ intent: 'x', dbi: dbi2, cohortVersions: null })).rejects.toThrow();
  });
});

describe('rollupSuggestOutcomes — voice-profile pin on the readiness slice (Codex r2)', () => {
  const rows = [
    { intent: 'i', status: 'accepted', prompt_version: CURRENT, voice_profile_version: '7', count: 5 },
    { intent: 'i', status: 'accepted', prompt_version: CURRENT, voice_profile_version: '6', count: 90 },
    { intent: 'i', status: 'accepted', prompt_version: CURRENT, voice_profile_version: null, count: 3 },
  ];

  test('cohort slice counts only rows drafted under the pinned profile; display stays all-time', () => {
    const e = rollupSuggestOutcomes(rows, [CURRENT], 7).get('i');
    expect(e.cohort.accepted).toBe(5);
    expect(e.display.accepted).toBe(98);
  });

  test('null pin (no profile) matches only unprofiled rows', () => {
    const e = rollupSuggestOutcomes(rows, [CURRENT], null).get('i');
    expect(e.cohort.accepted).toBe(3);
  });

  test("the '__unresolved__' sentinel empties readiness evidence (fail closed) without touching display", () => {
    const e = rollupSuggestOutcomes(rows, [CURRENT], '__unresolved__').get('i');
    expect(e.cohort.accepted).toBe(0);
    expect(e.display.accepted).toBe(98);
  });

  test('undefined pin keeps the pre-pin behavior (display-only callers)', () => {
    const e = rollupSuggestOutcomes(rows, [CURRENT]).get('i');
    expect(e.cohort.accepted).toBe(98);
  });
});

describe('fetchLiveJudgeSignals — cohort filter reaches the queries', () => {
  test('an active cohort filters BOTH the totals and the recent backstop to md.prompt_version', async () => {
    const dbi = makeFakeDb([]);
    await fetchLiveJudgeSignals(dbi, { cohortVersions: [CURRENT], voiceProfileVersion: null });
    // liveOnly runs once for totals and once for the ranked-backstop CTE.
    expect(filterCalls(dbi, 'whereIn', 'md.prompt_version')).toEqual([
      ['whereIn', ['md.prompt_version', [CURRENT]]],
      ['whereIn', ['md.prompt_version', [CURRENT]]],
    ]);
    // The informational prior-version count excludes the cohort.
    expect(filterCalls(dbi, 'whereNotIn', 'md.prompt_version')).toEqual([['whereNotIn', ['md.prompt_version', [CURRENT]]]]);
    // Backfill exclusion is untouched by the cohort (applies in the group).
    expect(dbi.calls.some(([m, args]) => m === 'whereRaw' && /NOT LIKE '%backfill'/.test(args[0]))).toBe(true);
  });

  test('all_live keeps live-only semantics but drops the version filters', async () => {
    const dbi = makeFakeDb([]);
    await fetchLiveJudgeSignals(dbi, { cohortVersions: null, voiceProfileVersion: null });
    expect(filterCalls(dbi, 'whereIn', 'md.prompt_version')).toEqual([]);
    expect(filterCalls(dbi, 'whereNotIn', 'md.prompt_version')).toEqual([]);
    expect(dbi.calls.some(([m, args]) => m === 'whereRaw' && /NOT LIKE '%backfill'/.test(args[0]))).toBe(true);
  });
});

describe('fetchLiveJudgeSignals — voice-profile pin reaches the readiness queries (v9)', () => {
  const pinCalls = (dbi) => dbi.calls.filter(([m, args]) => m === 'whereRaw' && /voice_profile_version/.test(args[0]));

  test('a live approved profile pins totals AND recent backstop to its version', async () => {
    const dbi = makeFakeDb([]);
    await fetchLiveJudgeSignals(dbi, { cohortVersions: [CURRENT], voiceProfileVersion: 3 });
    const calls = pinCalls(dbi);
    // liveOnly runs once for totals, once for the ranked-backstop CTE
    expect(calls).toHaveLength(2);
    for (const [, args] of calls) expect(args[1]).toEqual(['3']);
  });

  test('no approved profile pins to the no-profile sentinel — profiled drafts drop out', async () => {
    const dbi = makeFakeDb([]);
    await fetchLiveJudgeSignals(dbi, { cohortVersions: [CURRENT], voiceProfileVersion: null });
    const calls = pinCalls(dbi);
    expect(calls).toHaveLength(2);
    for (const [, args] of calls) expect(args[1]).toEqual(['__none__']);
  });

  test('the informational prior-version count is NOT profile-pinned', async () => {
    const dbi = makeFakeDb([]);
    await fetchLiveJudgeSignals(dbi, { cohortVersions: [CURRENT], voiceProfileVersion: 3 });
    // exactly the two liveOnly applications — no third from the informational queries
    expect(pinCalls(dbi)).toHaveLength(2);
  });

  test('pin resolution failure propagates (callers fail closed to judgeAvailable=false)', async () => {
    const dbi = makeFakeDb([]);
    // omitting voiceProfileVersion forces resolution via getApprovedVoiceProfile,
    // whose builder chain (.first) the capturing fake deliberately lacks —
    // standing in for any resolver error. It must throw, not silently unpin.
    await expect(fetchLiveJudgeSignals(dbi, { cohortVersions: [CURRENT] })).rejects.toThrow();
  });
});
