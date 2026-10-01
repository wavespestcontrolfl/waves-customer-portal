jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
const mockDispatch = jest.fn();
const mockRejectCall = jest.fn();
jest.mock('../services/llm/call', () => ({ dispatch: (...a) => mockDispatch(...a), rejectCall: (...a) => mockRejectCall(...a) }));

const { askPackage, normaliseAnswer } = require('../services/typed-decisions/jev');
const { PACKAGES, packageHash } = require('../services/typed-decisions/packages');
const { ROUTES } = require('../config/models');
const gates = require('../config/feature-gates');

const CALL_STATE = { call_direction: 'inbound', duration_seconds: 80, transcript: 'synthetic call transcript' };
const answersFor = (pkg, p) => Object.fromEntries(Object.keys(pkg.questions).map((id) => [id, { type: 'noul', noul: p }]));

describe('typedDecisionsLive gate', () => {
  const original = process.env.GATE_TYPED_DECISIONS;
  afterEach(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });
  test('ships dark and is read at call time', () => {
    delete process.env.GATE_TYPED_DECISIONS;
    expect(gates.typedDecisionsLive()).toBe(false);
    process.env.GATE_TYPED_DECISIONS = 'false';
    expect(gates.typedDecisionsLive()).toBe(false);
    process.env.GATE_TYPED_DECISIONS = 'true';
    expect(gates.typedDecisionsLive()).toBe(true);
    delete process.env.GATE_TYPED_DECISIONS;
    expect(gates.typedDecisionsLive()).toBe(false);
  });
});

describe('askPackage', () => {
  const original = process.env.GATE_TYPED_DECISIONS;
  beforeEach(() => { mockDispatch.mockReset(); process.env.GATE_TYPED_DECISIONS = 'true'; });
  afterAll(() => { if (original === undefined) delete process.env.GATE_TYPED_DECISIONS; else process.env.GATE_TYPED_DECISIONS = original; });

  test('gate off -> gate_off, no dispatch', async () => {
    delete process.env.GATE_TYPED_DECISIONS;
    expect(await askPackage('call_judge.v2', CALL_STATE)).toEqual({ ok: false, reason: 'gate_off' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('unknown package -> unknown_package, no dispatch', async () => {
    expect(await askPackage('nope.v9', CALL_STATE)).toMatchObject({ ok: false, reason: 'unknown_package' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test.each([
    ['missing key', { call_direction: 'inbound', duration_seconds: 5 }],
    ['extra key', { ...CALL_STATE, caller_name: 'x' }],
    ['not an object', 'a transcript'],
    ['array', []],
    ['null', null],
  ])('bad state (%s) -> bad_state, no dispatch', async (_label, state) => {
    const result = await askPackage('call_judge.v2', state);
    expect(result).toMatchObject({ ok: false, reason: 'bad_state', packageId: 'call_judge.v2', packageHash: packageHash(PACKAGES['call_judge.v2']) });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  test('dispatches the typedDecision route with the package questions and lane labels, then normalises noul answers', async () => {
    const pkg = PACKAGES['call_judge.v2'];
    const answers = answersFor(pkg, 0.5);
    answers.is_lead = { type: 'noul', noul: 0.93 };
    answers.is_spam = { type: 'noul', noul: 0.04 };
    answers.complaint = { type: 'noul', noul: 0.15 };
    answers.quote_promised = { type: 'noul', noul: 0.85 };
    mockDispatch.mockResolvedValue({ ok: true, json: answers, servedModel: 'jev-1.13.0', usage: { input_tokens: 10, output_tokens: 2 } });

    const result = await askPackage('call_judge.v2', CALL_STATE);

    expect(mockDispatch).toHaveBeenCalledWith(ROUTES.typedDecision, { state: CALL_STATE, questions: pkg.questions, laneId: 'typed_decisions', promptVersion: 'call_judge.v2' });
    expect(result.ok).toBe(true);
    expect(result.servedModel).toBe('jev-1.13.0');
    expect(result.packageId).toBe('call_judge.v2');
    expect(result.packageHash).toBe(packageHash(pkg));
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(result.answers.is_lead).toEqual({ p: 0.93, yes: true, confident: true });
    expect(result.answers.is_spam).toEqual({ p: 0.04, yes: false, confident: true });
    expect(result.answers.complaint).toEqual({ p: 0.15, yes: false, confident: true }); // boundary is inclusive
    expect(result.answers.quote_promised).toEqual({ p: 0.85, yes: true, confident: true });
    expect(result.answers.appointment_agreed).toEqual({ p: 0.5, yes: true, confident: false });
    expect(Object.keys(result.answers)).toEqual(Object.keys(pkg.questions));
  });

  test('a caller-supplied laneId labels the call', async () => {
    mockDispatch.mockResolvedValue({ ok: true, json: answersFor(PACKAGES['sms_courtesy.v1'], 0.9) });
    await askPackage('sms_courtesy.v1', { previous_waves_text: 'a', customer_text: 'b' }, { laneId: 'typed_decisions_eval' });
    expect(mockDispatch.mock.calls[0][1].laneId).toBe('typed_decisions_eval');
  });

  test('dispatch failure -> ok:false with the reason, no answers', async () => {
    mockDispatch.mockResolvedValue({ ok: false, reason: 'typesafe_529' });
    expect(await askPackage('sms_reschedule.v1', { previous_waves_text: 'a', customer_text: 'b' })).toMatchObject({ ok: false, reason: 'typesafe_529', packageId: 'sms_reschedule.v1' });
  });

  test('a thrown dispatch never escapes', async () => {
    mockDispatch.mockRejectedValue(new Error('boom'));
    expect(await askPackage('sms_reschedule.v1', { previous_waves_text: 'a', customer_text: 'b' })).toMatchObject({ ok: false, reason: 'error' });
  });

  test('a missing or mistyped answer -> incomplete_answers', async () => {
    const pkg = PACKAGES['call_judge.v2'];
    const missing = answersFor(pkg, 0.9);
    delete missing.complaint;
    const filed = { ok: true, json: missing };
    mockDispatch.mockResolvedValueOnce(filed);
    expect(await askPackage('call_judge.v2', CALL_STATE)).toMatchObject({ ok: false, reason: 'incomplete_answers' });
    // The adapter filed the call as ok; the ledger row flips to invalid_output (Codex #5476 r1).
    expect(mockRejectCall).toHaveBeenCalledWith(filed, 'invalid_output');
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { ...answersFor(pkg, 0.9), is_lead: { type: 'choice', choice: 'x' } } });
    expect(await askPackage('call_judge.v2', CALL_STATE)).toMatchObject({ ok: false, reason: 'incomplete_answers' });
    mockDispatch.mockResolvedValueOnce({ ok: true, json: { ...answersFor(pkg, 0.9), is_lead: { type: 'noul', noul: 1.4 } } });
    expect(await askPackage('call_judge.v2', CALL_STATE)).toMatchObject({ ok: false, reason: 'incomplete_answers' });
  });
});

describe('normaliseAnswer', () => {
  const thresholds = { confident_low: 0.15, confident_high: 0.85 };
  test('choice answers keep choice, probabilities and confidence', () => {
    const q = { type: 'choice' };
    expect(normaliseAnswer(q, { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 }, thresholds))
      .toEqual({ choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 }, confident: true });
    expect(normaliseAnswer(q, { type: 'choice', choice: 'b', probabilities: {}, confidence: 0.4 }, thresholds).confident).toBe(false);
    expect(normaliseAnswer(q, { type: 'choice' }, thresholds)).toBeNull();
  });
  test('score answers keep score and legend', () => {
    expect(normaliseAnswer({ type: 'score' }, { type: 'score', score: 3, legend: 'fair', probabilities: { 3: 0.9 }, confidence: 0.9 }, thresholds))
      .toEqual({ score: 3, legend: 'fair', confidence: 0.9, probabilities: { 3: 0.9 }, confident: true });
  });
  test('a type mismatch is null', () => {
    expect(normaliseAnswer({ type: 'noul' }, { type: 'score', score: 1 }, thresholds)).toBeNull();
    expect(normaliseAnswer({ type: 'noul' }, undefined, thresholds)).toBeNull();
  });
});
