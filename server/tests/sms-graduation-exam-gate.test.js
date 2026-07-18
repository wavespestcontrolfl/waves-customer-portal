/**
 * GRAD_REQUIRE_SEALED_EXAM — the sealed-exam requirement must bind at the
 * gates that ACT (evaluateAutoSendEligibility: the executor's send-time
 * re-check and the mode-flip route) and mirror into the advisory surfaces
 * (computeReadiness rung blockers + autoSendHealth). Fail closed on an
 * errored exam fetch; completely inert while the flag is off (default).
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sms-sealed-eval', () => ({ evaluateExamGate: jest.fn() }));

const sealedEval = require('../services/sms-sealed-eval');
const { evaluateAutoSendEligibility, computeReadiness } = require('../services/sms-graduation');

// Chainable/thenable fake that satisfies fetchLiveJudgeSignals (incl. its
// CTE) and fetchSuggestOutcomes — every query resolves to no rows, which is
// exactly the "no evidence" state the exam blockers must layer onto.
function makeFakeDb() {
  const builder = {};
  const chain = () => builder;
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw',
    'join', 'from', 'select', 'count', 'groupBy', 'orderBy', 'first', 'limit']) {
    builder[m] = (...args) => {
      if (m === 'where' && typeof args[0] === 'function') args[0].call(builder);
      return builder;
    };
  }
  builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  const dbi = () => builder;
  dbi.raw = (sql) => sql;
  dbi.with = (_name, cb) => {
    cb(builder);
    return builder;
  };
  return dbi;
}

const INTENT = 'general_customer_sms_needs_review';
const priorFlag = process.env.GRAD_REQUIRE_SEALED_EXAM;

afterEach(() => {
  if (priorFlag === undefined) delete process.env.GRAD_REQUIRE_SEALED_EXAM;
  else process.env.GRAD_REQUIRE_SEALED_EXAM = priorFlag;
  sealedEval.evaluateExamGate.mockReset();
});

describe('evaluateAutoSendEligibility — the executor gate', () => {
  test('flag off (default): the exam is never consulted', async () => {
    delete process.env.GRAD_REQUIRE_SEALED_EXAM;
    const out = await evaluateAutoSendEligibility({ intent: INTENT, dbi: makeFakeDb() });
    expect(sealedEval.evaluateExamGate).not.toHaveBeenCalled();
    expect(out.blockers.join(' ')).not.toMatch(/Sealed exam/);
  });

  test('flag on + exam blockers → not eligible, blockers carried through to the executor', async () => {
    process.env.GRAD_REQUIRE_SEALED_EXAM = 'true';
    sealedEval.evaluateExamGate.mockResolvedValue(['Sealed exam: no completed openai run for house_voice_v8.']);
    const out = await evaluateAutoSendEligibility({ intent: INTENT, dbi: makeFakeDb() });
    expect(out.eligible).toBe(false);
    expect(out.blockers.some((b) => /Sealed exam: no completed openai run/.test(b))).toBe(true);
  });

  test('flag on + exam fetch error → fail closed with an explicit blocker', async () => {
    process.env.GRAD_REQUIRE_SEALED_EXAM = 'true';
    sealedEval.evaluateExamGate.mockRejectedValue(new Error('relation missing'));
    const out = await evaluateAutoSendEligibility({ intent: INTENT, dbi: makeFakeDb() });
    expect(out.eligible).toBe(false);
    expect(out.blockers.some((b) => /Sealed exam signal unavailable/.test(b))).toBe(true);
  });

  test('flag on + exam passes → exam adds nothing (live-signal blockers only)', async () => {
    process.env.GRAD_REQUIRE_SEALED_EXAM = 'true';
    sealedEval.evaluateExamGate.mockResolvedValue([]);
    const out = await evaluateAutoSendEligibility({ intent: INTENT, dbi: makeFakeDb() });
    expect(out.blockers.join(' ')).not.toMatch(/Sealed exam/);
  });
});

describe('computeReadiness — advisory surfaces mirror the executor gate', () => {
  const intents = (mode) => [{ intent: INTENT, mode, locked: false, suggest: { accepted: 0, corrected: 0, ignored: 0 } }];

  test('exam blockers append to the rung verdict and flip eligible off', async () => {
    process.env.GRAD_REQUIRE_SEALED_EXAM = 'true';
    sealedEval.evaluateExamGate.mockResolvedValue(['Sealed exam: significant regression vs baseline (p=0.01).']);
    const out = await computeReadiness({ intents: intents('shadow'), dbi: makeFakeDb() });
    const g = out.get(INTENT);
    expect(g.eligible).toBe(false);
    expect(g.blockers.some((b) => /significant regression/.test(b))).toBe(true);
  });

  test('an intent AT auto_send shows the exam blocker in autoSendHealth (matches what the executor will do)', async () => {
    process.env.GRAD_REQUIRE_SEALED_EXAM = 'true';
    sealedEval.evaluateExamGate.mockResolvedValue(['Sealed exam: no completed anthropic run for house_voice_v8.']);
    const out = await computeReadiness({ intents: intents('auto_send'), dbi: makeFakeDb() });
    const g = out.get(INTENT);
    expect(g.autoSendHealth.sendReady).toBe(false);
    expect(g.autoSendHealth.blockers.some((b) => /Sealed exam/.test(b))).toBe(true);
  });

  test('flag off: readiness output carries no exam text', async () => {
    delete process.env.GRAD_REQUIRE_SEALED_EXAM;
    const out = await computeReadiness({ intents: intents('shadow'), dbi: makeFakeDb() });
    expect(out.get(INTENT).blockers.join(' ')).not.toMatch(/Sealed exam/);
    expect(sealedEval.evaluateExamGate).not.toHaveBeenCalled();
  });
});
