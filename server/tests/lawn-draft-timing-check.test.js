// Lawn technician-draft result-timing check (owner 2026-10-03): a fast model
// answers, per sentence, whether it says when a result will show. It closes
// the pattern screen's watering-clause gap and fails OPEN. The model is
// injected: no provider is called.

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const {
  lawnDraftTimingRejection, lawnDraftTimingCheckLive, _test,
} = require('../services/service-report/lawn-draft-timing-check');
const { lawnResultTimingViolation } = require('../services/service-report/report-writer-rules');

const DRAFT = [
  'WHAT WE DID',
  'Today we applied a selective weed control to the broadleaf weeds along the front beds.',
  'WHAT WE FOUND',
  'The lawn should green up within two weeks with regular watering. Water twice a week on your assigned days.',
].join('\n');

const answering = (verdicts) => ({ dispatch: jest.fn(async () => ({ ok: true, json: { sentences: verdicts } })) });

describe('lawnDraftTimingRejection', () => {
  test('the gap it closes: the pattern screen accepts a watering-phrased result promise', () => {
    expect(lawnResultTimingViolation(DRAFT)).toBe(false);
  });

  test('section titles are dropped and each sentence is numbered for the model', async () => {
    expect(_test.sentencesOf(DRAFT)).toEqual([
      'Today we applied a selective weed control to the broadleaf weeds along the front beds.',
      'The lawn should green up within two weeks with regular watering.',
      'Water twice a week on your assigned days.',
    ]);
    const deps = answering([]);
    await lawnDraftTimingRejection(DRAFT, deps);
    const [policy, payload] = deps.dispatch.mock.calls[0];
    expect(policy.name).toBe('fastStructured');
    expect(payload.laneId).toBe('lawn_draft_timing_check');
    expect(payload.text).toContain('"index":1');
    expect(payload.system).toMatch(/instructions about watering, irrigation or mowing/);
  });

  test('an explicit yes for a sentence in the draft rejects it', async () => {
    const deps = answering([
      { index: 0, states_result_timing: false },
      { index: 1, states_result_timing: true },
      { index: 2, states_result_timing: false },
    ]);
    expect(await lawnDraftTimingRejection(DRAFT, deps)).toBe('lawn_timing_ai');
  });

  test('all no: the draft passes (the watering instruction is not result timing)', async () => {
    const deps = answering([0, 1, 2].map((index) => ({ index, states_result_timing: false })));
    expect(await lawnDraftTimingRejection(DRAFT, deps)).toBeNull();
  });

  test('fails open: an unavailable checker, a thrown call, a malformed answer or an out-of-range index accepts the draft', async () => {
    expect(await lawnDraftTimingRejection(DRAFT, { dispatch: async () => ({ ok: false, reason: 'timeout' }) })).toBeNull();
    expect(await lawnDraftTimingRejection(DRAFT, { dispatch: async () => { throw new Error('boom'); } })).toBeNull();
    expect(await lawnDraftTimingRejection(DRAFT, { dispatch: async () => ({ ok: true, json: { nope: true } }) })).toBeNull();
    expect(await lawnDraftTimingRejection(DRAFT, answering([{ index: 9, states_result_timing: true }]))).toBeNull();
    expect(await lawnDraftTimingRejection(DRAFT, answering([{ index: 1, states_result_timing: 'true' }]))).toBeNull();
  });

  test('an unusable answer (empty, partial or out-of-range verdicts) is accepted AND logged', async () => {
    const logger = require('../services/logger');
    logger.warn.mockClear();
    expect(await lawnDraftTimingRejection(DRAFT, answering([]))).toBeNull();
    expect(await lawnDraftTimingRejection(DRAFT, answering([{ index: 9, states_result_timing: true }]))).toBeNull();
    expect(await lawnDraftTimingRejection(DRAFT, answering([{ index: 0, states_result_timing: false }]))).toBeNull();
    expect(logger.warn.mock.calls.filter(([line]) => /unusable answer/.test(line))).toHaveLength(3);
    logger.warn.mockClear();
    await lawnDraftTimingRejection(DRAFT, answering([0, 1, 2].map((index) => ({ index, states_result_timing: false }))));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('the check never outlives the caller\'s deadline: its timeout is capped, and no budget means no call', async () => {
    const deps = answering([0, 1, 2].map((index) => ({ index, states_result_timing: false })));
    await lawnDraftTimingRejection(DRAFT, { ...deps, remainingMs: 3000 });
    expect(deps.dispatch.mock.calls[0][1].timeoutMs).toBe(3000);
    await lawnDraftTimingRejection(DRAFT, { ...deps, remainingMs: 60000 });
    expect(deps.dispatch.mock.calls[1][1].timeoutMs).toBe(8000);
    const none = answering([{ index: 1, states_result_timing: true }]);
    expect(await lawnDraftTimingRejection(DRAFT, { ...none, remainingMs: 400 })).toBeNull();
    expect(none.dispatch).not.toHaveBeenCalled();
  });

  test('a draft over twenty sentences is refused, never silently skipped', async () => {
    const deps = answering([]);
    const long = Array.from({ length: 21 }, (_, i) => `Sentence number ${i} about the lawn.`).join(' ');
    expect(await lawnDraftTimingRejection(long, deps)).toBe('lawn_draft_too_long');
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  test('both providers share the ceiling (the fallback keeps real time when the primary stalls)', async () => {
    const deps = answering([0, 1, 2].map((index) => ({ index, states_result_timing: false })));
    await lawnDraftTimingRejection(DRAFT, deps);
    expect(deps.dispatch.mock.calls[0][2]).toEqual({ hardDeadline: true, reserveFallbackBudget: true });
  });

  test('onUnchecked fires for every accepted-without-a-verdict path, and never for a judged draft', async () => {
    const run = async (deps) => { const onUnchecked = jest.fn(); await lawnDraftTimingRejection(DRAFT, { ...deps, onUnchecked }); return onUnchecked.mock.calls.length; };
    expect(await run({ dispatch: async () => ({ ok: false, reason: 'timeout' }) })).toBe(1);
    expect(await run({ dispatch: async () => { throw new Error('boom'); } })).toBe(1);
    expect(await run(answering([]))).toBe(1);
    expect(await run({ ...answering([]), remainingMs: 400 })).toBe(1);
    expect(await run(answering([0, 1, 2].map((index) => ({ index, states_result_timing: false }))))).toBe(0);
    expect(await run(answering([{ index: 1, states_result_timing: true }]))).toBe(0);
  });

  test('the prompt has the checker read sentences in context (a promise split across two sentences)', () => {
    expect(_test.SYSTEM).toMatch(/Read each sentence IN CONTEXT/);
    expect(_test.SYSTEM).not.toMatch(/Judge only the sentence's own words/);
  });

  test('an empty draft asks no model', async () => {
    const deps = answering([]);
    expect(await lawnDraftTimingRejection('WHAT WE DID\n', deps)).toBeNull();
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});

describe('lawnDraftTimingCheckLive', () => {
  const ENV = ['LAWN_DRAFT_TIMING_CHECK', 'GATE_LAWN_REPORT_COPY_V6', 'GATE_LAWN_REPORT_LEAD'];
  const saved = {};
  beforeEach(() => { ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }); });
  afterEach(() => { ENV.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }); });

  test('on only under the v6 gate, and off by its own kill switch', () => {
    expect(lawnDraftTimingCheckLive()).toBe(false);
    process.env.GATE_LAWN_REPORT_COPY_V6 = 'true';
    process.env.GATE_LAWN_REPORT_LEAD = 'true';
    expect(lawnDraftTimingCheckLive()).toBe(true);
    for (const off of ['off', 'false', '0', 'OFF']) {
      process.env.LAWN_DRAFT_TIMING_CHECK = off;
      expect(lawnDraftTimingCheckLive()).toBe(false);
    }
  });
});

describe('generate-report runs the check on lawn drafts that carried the timing rule', () => {
  test('the route awaits the hook and gates it on the rule, the kill switch and the pattern screen passing first', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../routes/admin-schedule.js'), 'utf8');
    expect(source).toMatch(/await extraRejection\(report, \{ remainingMs: deadline - Date\.now\(\) \}\)/);
    // Cheap screens first; then the check, told the chain's remaining budget.
    expect(source).toMatch(/if \(cheap \|\| !lawnTimingCheckOn\) return cheap;/);
    expect(source).toMatch(/lawnDraftTimingRejection\(text, \{ remainingMs, onUnchecked: \(\) => \{ lawnTimingUnchecked = true; \} \}\)/);
    // The last-resort copy: cheap screens first, then the check, inside the chain's deadline.
    expect(source).toMatch(/const fallbackScreened = report && \(screenTradeNames\(report\) \|\| writerRulesScreen\(report\)\);/);
    expect(source).toMatch(/const fallbackTiming = report && !fallbackScreened && lawnTimingCheckOn\s+\? await lawnDraftTimingRejection\(report, \{ remainingMs: reportChainDeadline - Date\.now\(\) \}\)/);
    // The check's state is part of the cache identity, and an unjudged draft is never cached.
    expect(source).toMatch(/\.update\(lawnTimingCheckOn \? '\|lawn-timing-check:1' : ''\)/);
    expect(source).toMatch(/if \(!lawnTimingUnchecked\) reportCopyCacheSet\(cacheKey, report\);/);
  });
});
