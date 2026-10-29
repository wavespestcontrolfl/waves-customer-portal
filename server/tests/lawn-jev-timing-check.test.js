/**
 * GATE_LAWN_JEV_TIMING_CHECK (owner 2026-10-28/29): the Jev result-timing check
 * on the model-written lawn DIAGNOSIS summary (contract.customer_summary).
 * Off changes nothing; shadow changes nothing stored and records after the
 * insert; enforce drops flagged sentences before storage. No provider, no database.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const logger = require('../services/logger');
const {
  checkDiagnosisSummary, lawnJevTimingVerdict, recordLawnJevVerdict, aggregateAnswers, PACKAGE_ID, JEV_TIMING_CHECK_TIMEOUT_MS,
} = require('../services/service-report/lawn-jev-timing-check');
const { lawnJevTimingCheckMode } = require('../config/feature-gates');
const { PACKAGES, packageHash } = require('../services/typed-decisions/packages');
const { lawnDiagnosisSubjectHash } = require('../services/typed-decisions/subject-hash');
const { GENERIC_LOW_CONFIDENCE_SUMMARY } = require('../services/lawn-diagnostic-report');

const GATE = 'GATE_LAWN_JEV_TIMING_CHECK';
const saved = process.env[GATE];
afterAll(() => { if (saved === undefined) delete process.env[GATE]; else process.env[GATE] = saved; });

const DIAGNOSIS_ID = '55555555-5555-4555-8555-555555555555';
const S1 = 'Your lawn shows thinning along the sunny edge near the driveway.';
// The word list passes this one (it is one of the five it missed in the replay).
const S2 = 'By mid-November the color should be much better.';
const S3 = 'We will keep watching the area on each visit.';
const SUMMARY = `${S1} ${S2} ${S3}`;
const PACKAGE_HASH = packageHash(PACKAGES[PACKAGE_ID]);

const answer = (p, confident = true) => ({ p, yes: p >= 0.5, confident });
function scriptedAsk({ flagged = [], fail = [], hang = [] } = {}) {
  return async (packageId, state) => {
    if (hang.includes(state.sentence)) return new Promise(() => {});
    if (fail.includes(state.sentence)) return { ok: false, reason: 'error', packageId, packageHash: PACKAGE_HASH, provider: 'typesafe' };
    return {
      ok: true, answers: { states_result_timing: answer(flagged.includes(state.sentence) ? 0.97 : 0.02) },
      servedModel: 'jev-1.13.0', packageId, packageHash: PACKAGE_HASH, provider: 'typesafe',
    };
  };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const contractOf = (summary = SUMMARY) => ({ customer_summary: summary, watch_items: ['x'] });

beforeEach(() => { logger.info.mockClear(); logger.warn.mockClear(); delete process.env[GATE]; });

describe('lawnJevTimingCheckMode', () => {
  test.each([
    [undefined, 'off'], ['', 'off'], ['off', 'off'], ['true', 'off'], ['on', 'off'], ['act', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['enforce', 'enforce'], ['ENFORCE', 'enforce'],
  ])('%j reads as %s', (value, mode) => {
    if (value === undefined) delete process.env[GATE]; else process.env[GATE] = value;
    expect(lawnJevTimingCheckMode()).toBe(mode);
  });
});

describe('lawnJevTimingVerdict', () => {
  test('asks every sentence in parallel, folds the answers into one and names the flagged sentences', async () => {
    const ask = jest.fn(scriptedAsk({ flagged: [S2] }));
    const verdict = await lawnJevTimingVerdict(SUMMARY, { ask });
    expect(ask.mock.calls).toEqual([[PACKAGE_ID, { sentence: S1 }], [PACKAGE_ID, { sentence: S2 }], [PACKAGE_ID, { sentence: S3 }]]);
    expect(verdict).toMatchObject({ flagged: true, flaggedSentences: [S2], answer: { p: 0.97, yes: true, confident: true } });
    expect(verdict.result).toMatchObject({ ok: true, packageId: PACKAGE_ID, packageHash: PACKAGE_HASH, servedModel: 'jev-1.13.0', provider: 'typesafe' });
    expect(verdict.result.answers.states_result_timing).toEqual(verdict.answer);
  });

  test('no flag: not flagged, aggregate is the largest p, confident needs every sentence', async () => {
    const verdict = await lawnJevTimingVerdict(SUMMARY, { ask: scriptedAsk() });
    expect(verdict).toMatchObject({ flagged: false, flaggedSentences: [], answer: { p: 0.02, yes: false, confident: true } });
    expect(aggregateAnswers([answer(0.1), answer(0.4, false)])).toEqual({ p: 0.4, yes: false, confident: false });
    expect(aggregateAnswers([answer(0.5), answer(0.1, false)])).toEqual({ p: 0.5, yes: true, confident: false });
  });

  test('a failed or throwing sentence call gives no verdict (fails open)', async () => {
    expect(await lawnJevTimingVerdict(SUMMARY, { ask: scriptedAsk({ flagged: [S2], fail: [S3] }) })).toBeNull();
    expect(await lawnJevTimingVerdict(SUMMARY, { ask: async () => { throw new Error('boom'); } })).toBeNull();
  });

  test('a call that does not answer inside the step timeout gives no verdict', async () => {
    expect(JEV_TIMING_CHECK_TIMEOUT_MS).toBe(3000);
    expect(await lawnJevTimingVerdict(SUMMARY, { ask: scriptedAsk({ flagged: [S2], hang: [S3] }), timeoutMs: 20 })).toBeNull();
  });

  test('an empty text, or one over the sentence cap, is not asked', async () => {
    const ask = jest.fn(scriptedAsk());
    expect(await lawnJevTimingVerdict('', { ask })).toBeNull();
    expect(await lawnJevTimingVerdict(Array.from({ length: 21 }, (_v, i) => `Sentence number ${i}.`).join(' '), { ask })).toBeNull();
    expect(ask).not.toHaveBeenCalled();
  });
});

describe('checkDiagnosisSummary', () => {
  const deps = (script, record = jest.fn(async () => ({ recorded: 1 }))) => ({ ask: jest.fn(scriptedAsk(script)), recordDecisions: record });

  test('off: the very same contract comes back, nothing is asked or recorded', async () => {
    const contract = contractOf();
    const d = deps({ flagged: [S2] });
    const out = await checkDiagnosisSummary(contract, { modelWritten: true }, d);
    expect(out.contract).toBe(contract);
    out.afterInsert('row-1');
    await flush();
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.recordDecisions).not.toHaveBeenCalled();
  });

  test.each(['shadow', 'enforce'])('%s: a summary no model wrote (or an empty one) is never asked', async (mode) => {
    process.env[GATE] = mode;
    const d = deps({ flagged: [S2] });
    for (const [contract, modelWritten] of [[contractOf(), false], [contractOf(''), true], [{}, true]]) {
      const out = await checkDiagnosisSummary(contract, { modelWritten }, d);
      expect(out.contract).toBe(contract);
      out.afterInsert('row-1');
    }
    await flush();
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.recordDecisions).not.toHaveBeenCalled();
  });

  test('shadow: no wait and no change before the insert; the verdict is asked and recorded after it', async () => {
    process.env[GATE] = 'shadow';
    const contract = contractOf();
    const d = deps({ flagged: [S2], hang: [] });
    const out = await checkDiagnosisSummary(contract, { modelWritten: true }, d);
    expect(out.contract).toBe(contract);
    expect(d.ask).not.toHaveBeenCalled();
    out.afterInsert(DIAGNOSIS_ID);
    for (let i = 0; i < 20 && !d.recordDecisions.mock.calls.length; i += 1) await flush();
    expect(d.ask).toHaveBeenCalledTimes(3);
    const [rec] = d.recordDecisions.mock.calls[0];
    expect(rec).toMatchObject({
      capability: 'lawn_result_timing', provider: 'typesafe', subjectType: 'lawn_diagnostics', subjectId: DIAGNOSIS_ID,
      baselines: { states_result_timing: { production: false } }, subjectHash: lawnDiagnosisSubjectHash(SUMMARY),
    });
    expect(rec.pkg.id).toBe(PACKAGE_ID);
    expect(rec.result.answers.states_result_timing).toEqual({ p: 0.97, yes: true, confident: true });
  });

  test('shadow: a hung Jev call or a throwing recorder never reaches the request', async () => {
    process.env[GATE] = 'shadow';
    const hung = await checkDiagnosisSummary(contractOf(), { modelWritten: true }, { ask: () => new Promise(() => {}), recordDecisions: jest.fn() });
    hung.afterInsert(DIAGNOSIS_ID);
    const throwing = deps({}, jest.fn(async () => { throw new Error('db down'); }));
    const out = await checkDiagnosisSummary(contractOf(), { modelWritten: true }, throwing);
    expect(() => out.afterInsert(DIAGNOSIS_ID)).not.toThrow();
    await flush();
  });

  test('enforce: the flagged sentence is dropped before storage, the rest stays, nothing is recorded', async () => {
    process.env[GATE] = 'enforce';
    const d = deps({ flagged: [S2] });
    const out = await checkDiagnosisSummary(contractOf(), { modelWritten: true }, d);
    expect(out.contract.customer_summary).toBe(`${S1} ${S3}`);
    expect(out.contract.watch_items).toEqual(['x']);
    out.afterInsert(DIAGNOSIS_ID);
    await flush();
    expect(d.recordDecisions).not.toHaveBeenCalled();
    const logged = logger.info.mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toMatch(/dropped 1 flagged sentence/);
    expect(logged).not.toContain('mid-November');
  });

  test('enforce: a flagged sentence on its own line is still dropped (Jev splits on line breaks, the egress does not)', async () => {
    process.env[GATE] = 'enforce';
    const LINE = 'Thin turf near the driveway';
    const out = await checkDiagnosisSummary(contractOf(`${LINE}\n${S2} ${S3}`), { modelWritten: true }, deps({ flagged: [S2] }));
    expect(out.contract.customer_summary).not.toContain('mid-November');
    expect(out.contract.customer_summary).toContain(S3);
  });

  test('enforce: every sentence flagged reads as the generic summary, like the read-time egress', async () => {
    process.env[GATE] = 'enforce';
    const out = await checkDiagnosisSummary(contractOf(), { modelWritten: true }, deps({ flagged: [S1, S2, S3] }));
    expect(out.contract.customer_summary).toBe(GENERIC_LOW_CONFIDENCE_SUMMARY);
  });

  test('enforce: no flag keeps the very same contract and records the verdict after the insert', async () => {
    process.env[GATE] = 'enforce';
    const contract = contractOf();
    const d = deps({});
    const out = await checkDiagnosisSummary(contract, { modelWritten: true }, d);
    expect(out.contract).toBe(contract);
    out.afterInsert(DIAGNOSIS_ID);
    for (let i = 0; i < 20 && !d.recordDecisions.mock.calls.length; i += 1) await flush();
    expect(d.recordDecisions.mock.calls[0][0].result.answers.states_result_timing).toEqual({ p: 0.02, yes: false, confident: true });
  });

  test.each([
    ['a failed call', { fail: [S3], flagged: [S2] }],
    ['a call that never answers', { hang: [S3], flagged: [S2] }],
  ])('enforce: %s keeps the text (fails open) and records nothing', async (_name, script) => {
    process.env[GATE] = 'enforce';
    const contract = contractOf();
    const d = deps(script);
    const out = await checkDiagnosisSummary(contract, { modelWritten: true }, { ...d, timeoutMs: 30 });
    expect(out.contract).toBe(contract);
    out.afterInsert(DIAGNOSIS_ID);
    await flush();
    expect(d.recordDecisions).not.toHaveBeenCalled();
  });
});

describe('the recorded aggregate is the shape the recorder writes', () => {
  test('one decision_reviews row for states_result_timing, against the diagnosis, with the summary digest', async () => {
    const { recordDecisions } = jest.requireActual('../services/typed-decisions/shadow-recorder');
    let inserted;
    const chain = {
      insert: (rows) => { inserted = rows; return chain; },
      onConflict: () => chain, merge: () => chain, where: () => chain, whereRaw: () => chain,
      returning: async () => inserted.map((row) => ({ sampled_for: row.sampled_for })),
    };
    const conn = Object.assign(() => chain, { raw: (sql, bindings) => ({ sql, bindings }) });
    process.env.GATE_TYPED_DECISIONS = 'true';
    try {
      const verdict = await lawnJevTimingVerdict(SUMMARY, { ask: scriptedAsk({ flagged: [S2] }) });
      const written = await recordLawnJevVerdict(
        { diagnosticId: DIAGNOSIS_ID, summary: SUMMARY, verdict },
        { recordDecisions: (args) => recordDecisions({ ...args, conn }) },
      );
      expect(written.recorded).toBe(1);
      expect(inserted[0]).toMatchObject({
        capability: 'lawn_result_timing', package_id: PACKAGE_ID, package_hash: PACKAGE_HASH, provider: 'typesafe',
        served_model: 'jev-1.13.0', subject_type: 'lawn_diagnostics', subject_id: DIAGNOSIS_ID, question_id: 'states_result_timing',
        subject_hash: lawnDiagnosisSubjectHash(SUMMARY),
      });
      expect(JSON.parse(inserted[0].jev_answer)).toEqual({ p: 0.97, yes: true, confident: true });
      expect(JSON.parse(inserted[0].baseline_answers)).toEqual({ production: false });
    } finally {
      delete process.env.GATE_TYPED_DECISIONS;
    }
  });
});
