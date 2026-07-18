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
  test('an active cohort applies whereIn(prompt_version) (NULL rows drop out by SQL semantics)', async () => {
    const dbi = makeFakeDb([{ status: 'accepted', count: '4' }]);
    const out = await fetchSuggestOutcomes({ intent: 'x', dbi, cohortVersions: [CURRENT] });
    expect(filterCalls(dbi, 'whereIn', 'prompt_version')).toEqual([['whereIn', ['prompt_version', [CURRENT]]]]);
    expect(out).toEqual({ accepted: 4, corrected: 0, ignored: 0 });
  });

  test('all_live (null cohort) applies no version filter', async () => {
    const dbi = makeFakeDb([]);
    await fetchSuggestOutcomes({ intent: 'x', dbi, cohortVersions: null });
    expect(filterCalls(dbi, 'whereIn', 'prompt_version')).toEqual([]);
  });
});

describe('fetchLiveJudgeSignals — cohort filter reaches the queries', () => {
  test('an active cohort filters BOTH the totals and the recent backstop to md.prompt_version', async () => {
    const dbi = makeFakeDb([]);
    await fetchLiveJudgeSignals(dbi, { cohortVersions: [CURRENT] });
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
    await fetchLiveJudgeSignals(dbi, { cohortVersions: null });
    expect(filterCalls(dbi, 'whereIn', 'md.prompt_version')).toEqual([]);
    expect(filterCalls(dbi, 'whereNotIn', 'md.prompt_version')).toEqual([]);
    expect(dbi.calls.some(([m, args]) => m === 'whereRaw' && /NOT LIKE '%backfill'/.test(args[0]))).toBe(true);
  });
});
