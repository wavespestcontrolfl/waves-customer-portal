/**
 * Lawn visit assessment name referee (owner ruling 2026-09-29, dark behind
 * GATE_LAWN_ASSESSMENT_REFEREE): the Sol second opinion on an "unsure or
 * serious" Gemini read, and the Fable tie-break on a NAME disagreement only.
 * llm/call.js is mocked whole: dispatchWithFallback is the Gemini -> Sol chain,
 * dispatch is every single-route call (the Sol second opinion and Fable).
 */
jest.mock('../services/logger', () => ({
  warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(), dispatch: jest.fn() }));

const { dispatchWithFallback, dispatch } = require('../services/llm/call');
const { analyzeVisit } = require('../services/lawn-visit-assessment');
const input = require('../services/lawn-visit-input');
const referee = require('../services/lawn-visit-referee');
const { runRowFor, billedUsage } = require('../services/lawn-visit-runs');
const MODELS = require('../config/models');
const { lawnAssessmentRefereeLive } = require('../config/feature-gates');
const { photo, answer, finding, sig } = require('./helpers/lawn-visit-fixtures');

const photos = [photo('YQ==', 'front'), photo('Yg==')];
const GATE = 'GATE_LAWN_ASSESSMENT_REFEREE';
const savedGate = process.env[GATE];
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
});

const ok = (json, extra = {}) => ({
  ok: true, json, provider: 'gemini', model: MODELS.GEMINI_VISION_BEST, fallbackUsed: false,
  usage: { input_tokens: 9000, output_tokens: 4000, reasoning_tokens: 1500 }, failures: [], ...extra,
});
const solOk = (json) => ({ ok: true, json, model: MODELS.OPENAI_LAWN_ASSESSMENT, usage: { input_tokens: 8000, output_tokens: 3000, reasoning_tokens: 900 } });
const fableOk = (answers) => ({ ok: true, json: { answers }, model: MODELS.LAWN_ASSESSMENT_REFEREE, usage: { input_tokens: 12000, output_tokens: 5000, reasoning_tokens: 4000 } });

// A finding that names a cause and is determinable (a real naming vote).
const named = (name, overrides = {}) => finding({
  name, confidence: 'moderate', severity: 'mild', photo_refs: [1], zone: 'front', can_determine: true,
  confirmation_step: `check for ${name}`, customer_wording: `wording for ${name}`, ...overrides,
});
// Gemini's read, unsure-or-serious by default (a low-confidence finding present).
const gemini = (overrides = {}) => answer({ findings: [named('Chinch bug damage', { confidence: 'high' }), named('Thinning turf', { confidence: 'low', photo_refs: [2], zone: 'unknown' })], ...overrides });
const sol = (overrides = {}) => answer({ findings: [named('Brown patch', { confidence: 'moderate' })], ...overrides });
const cleanGemini = () => answer({
  findings: [named('No major visible stress', { confidence: 'high', severity: 'mild' })],
  severities: { ...answer().severities, insect_damage: sig('none') },
});

beforeEach(() => {
  dispatchWithFallback.mockReset();
  dispatch.mockReset();
  delete process.env[GATE];
});

const strip = (result) => {
  const { latencyMs, referee: r, ...rest } = result; // eslint-disable-line no-unused-vars
  return rest;
};

describe('gate off or unset', () => {
  test.each([[undefined], ['false'], ['TRUE'], ['1'], ['']])('GATE_LAWN_ASSESSMENT_REFEREE=%p leaves analyzeVisit exactly as it was', async (value) => {
    if (value === undefined) delete process.env[GATE]; else process.env[GATE] = value;
    expect(lawnAssessmentRefereeLive()).toBe(false);
    const json = gemini();
    dispatchWithFallback.mockResolvedValue(ok(json));
    const result = await analyzeVisit({ photos });
    // Even an unsure-or-serious read draws no extra call and carries no new key.
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect('referee' in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual([
      'contextHash', 'failures', 'fallbackUsed', 'findings', 'grassType', 'latencyMs', 'model', 'observations', 'photoQuality',
      'promptVersion', 'provider', 'raw', 'reason', 'scores', 'severities', 'status', 'technicianNotesPresent', 'usage', 'visionContext',
    ]);
    expect(result.raw).toBe(json);
    expect(dispatchWithFallback.mock.calls[0][1]).toMatchObject({ system: input.SYSTEM_PROMPT, promptVersion: input.PROMPT_VERSION });
  });

  test('an unavailable result has no referee key either', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [] });
    const result = await analyzeVisit({ photos });
    expect(result.status).toBe('unavailable');
    expect('referee' in result).toBe(false);
  });

  test('the gate is exactly the string true, read at call time', () => {
    process.env[GATE] = 'true';
    expect(lawnAssessmentRefereeLive()).toBe(true);
    delete process.env[GATE];
    expect(lawnAssessmentRefereeLive()).toBe(false);
  });
});

describe('second-opinion trigger (unsure or serious)', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('a confident, mild read draws no extra call', async () => {
    dispatchWithFallback.mockResolvedValue(ok(cleanGemini()));
    const result = await analyzeVisit({ photos });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.referee).toMatchObject({ triggered: false, outcome: 'skipped', reason: 'not_unsure_or_serious', secondOpinion: { called: false } });
  });

  test.each([
    ['a low-confidence finding', { findings: [named('Chinch bug damage', { confidence: 'low' })] }, 'low_confidence_finding'],
    ['an unknown-confidence finding', { findings: [named('Chinch bug damage', { confidence: 'unknown' })] }, 'low_confidence_finding'],
    ['a moderate-severity finding', { findings: [named('Chinch bug damage', { confidence: 'high', severity: 'moderate' })] }, 'serious_finding'],
    ['a severe finding', { findings: [named('Chinch bug damage', { confidence: 'high', severity: 'severe' })] }, 'serious_finding'],
    ['an unknown grass type', { findings: [named('Chinch bug damage', { confidence: 'high' })], grass_type: 'unknown' }, 'grass_type_unknown'],
  ])('%s draws the Sol second opinion (same prompt, images, schema)', async (label, overrides, reason) => {
    dispatchWithFallback.mockResolvedValue(ok(answer(overrides), { model: 'gemini-x' }));
    dispatch.mockResolvedValue(solOk(answer(overrides)));
    const result = await analyzeVisit({ photos, thinkingLevel: 'LOW' });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [route, payload] = dispatch.mock.calls[0];
    expect(route).toBe(MODELS.TEXT_POLICIES.lawnVisitAssessment.fallback);
    expect(route).toEqual({ provider: 'openai', model: MODELS.OPENAI_LAWN_ASSESSMENT });
    expect(payload).toMatchObject({
      system: input.SYSTEM_PROMPT, jsonMode: true, jsonSchema: input.RESPONSE_SCHEMA, maxTokens: input.MAX_OUTPUT_TOKENS,
      laneId: 'lawn_visit_assessment', promptVersion: `${input.PROMPT_VERSION}:second-opinion`, timeoutMs: referee.SECOND_OPINION_MAX_MS,
    });
    expect(payload.images).toEqual(dispatchWithFallback.mock.calls[0][1].images);
    expect(payload.text).toBe(dispatchWithFallback.mock.calls[0][1].text);
    expect(payload.thinkingLevel).toBeUndefined();
    expect(result.referee.secondOpinion).toMatchObject({ called: true, ok: true, reasons: [reason] });
    expect(result.referee).toMatchObject({ triggered: false, outcome: 'skipped', reason: 'no_dispute' });
  });

  test('a Gemini miss that the OpenAI backup answered is never second-guessed', async () => {
    dispatchWithFallback.mockResolvedValue(ok(gemini(), { provider: 'openai', model: MODELS.OPENAI_LAWN_ASSESSMENT, fallbackUsed: true }));
    const result = await analyzeVisit({ photos });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.referee).toMatchObject({ outcome: 'skipped', reason: 'gemini_fallback' });
  });

  test('both providers missing stays unavailable with a skipped referee', async () => {
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [] });
    const result = await analyzeVisit({ photos });
    expect(result.status).toBe('unavailable');
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.referee).toMatchObject({ outcome: 'skipped', reason: 'gemini_unavailable' });
  });
});

describe('agreement, and a second opinion that cannot help, never draw Fable', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('Gemini and Sol agree on every name (even at low confidence) -> no referee call', async () => {
    const g = gemini();
    dispatchWithFallback.mockResolvedValue(ok(g));
    dispatch.mockResolvedValue(solOk(answer({ findings: [named('Chinch bugs', { confidence: 'low' })], grass_type: g.grass_type })));
    const result = await analyzeVisit({ photos });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.referee).toMatchObject({ triggered: false, outcome: 'skipped', reason: 'no_dispute', disputes: [] });
    expect(strip(result)).toEqual(strip(await withGateOff(g)));
  });

  test.each([
    ['Sol returns a provider failure', { ok: false, reason: 'openai_timeout' }, 'openai_timeout'],
    ['Sol returns a malformed answer', { ok: true, json: { findings: [] } }, 'malformed_assessment'],
  ])('%s -> Gemini unchanged, no Fable call', async (label, solResult, reason) => {
    const g = gemini();
    dispatchWithFallback.mockResolvedValue(ok(g));
    dispatch.mockResolvedValue(solResult);
    const result = await analyzeVisit({ photos });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(result.referee).toMatchObject({ triggered: false, outcome: 'skipped', reason: 'second_opinion_failed', secondOpinion: { called: true, ok: false, reason } });
    expect(strip(result)).toEqual(strip(await withGateOff(g)));
  });

  test('a thrown Sol dispatch is contained', async () => {
    const g = gemini();
    dispatchWithFallback.mockResolvedValue(ok(g));
    dispatch.mockRejectedValue(new Error('socket hang up'));
    const result = await analyzeVisit({ photos });
    expect(result.referee).toMatchObject({ outcome: 'skipped', reason: 'second_opinion_failed', secondOpinion: { ok: false, reason: 'error' } });
    expect(strip(result)).toEqual(strip(await withGateOff(g)));
  });
});

// The same Gemini answer through analyzeVisit with the gate off: the baseline
// an unsettled referee must equal exactly.
async function withGateOff(json) {
  const saved = process.env[GATE];
  delete process.env[GATE];
  const before = dispatchWithFallback.getMockImplementation();
  dispatchWithFallback.mockResolvedValueOnce(ok(json));
  const result = await analyzeVisit({ photos });
  if (saved !== undefined) process.env[GATE] = saved;
  if (before) dispatchWithFallback.mockImplementation(before);
  return result;
}

describe('a name disagreement draws Fable', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  // Gemini: chinch (high, severity moderate) + a low symptom; Sol: brown patch on the same photo.
  const setup = (fable, { solOverrides = {}, geminiJson = gemini() } = {}) => {
    dispatchWithFallback.mockResolvedValue(ok(geminiJson));
    dispatch.mockResolvedValueOnce(solOk(sol(solOverrides)));
    if (fable instanceof Function) dispatch.mockImplementationOnce(fable); else dispatch.mockResolvedValueOnce(fable);
    return geminiJson;
  };

  test('the Fable call: one small strict schema, the same photos, the disputed names, a 60 s cap', async () => {
    setup(fableOk([{ id: 'd1', pick: 'b' }]));
    await analyzeVisit({ photos });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const [route, payload] = dispatch.mock.calls[1];
    expect(route).toBe(MODELS.ROUTES.lawnAssessmentReferee);
    expect(route).toEqual({ provider: 'anthropic', model: MODELS.LAWN_ASSESSMENT_REFEREE, effort: 'high' });
    expect(payload).toMatchObject({
      jsonMode: true, jsonSchema: referee.REFEREE_SCHEMA, laneId: 'lawn_assessment_referee',
      promptVersion: `${input.PROMPT_VERSION}:referee`, timeoutMs: referee.REFEREE_MAX_MS, maxTokens: 8192,
    });
    expect(referee.REFEREE_MAX_MS).toBe(60 * 1000);
    expect(payload.images).toEqual(dispatchWithFallback.mock.calls[0][1].images);
    expect(payload.system).toContain('TWO EARLIER READS DISAGREED ON');
    expect(payload.system).toContain('d1: what the finding in photo 1 is — A: "Chinch bug damage"; B: "Brown patch"');
    expect(payload.text).toContain('Assess the lawn in the 2 numbered photos');
  });

  test('pick b (Sol side): the name swaps, confidence caps at moderate, scores and severities never move', async () => {
    const g = setup(fableOk([{ id: 'd1', pick: 'b' }]), { solOverrides: { scores: { turf_density: { determinable: true, value: 5 }, weed_coverage: { determinable: true, value: 90 }, color_health: { determinable: true, value: 1 } }, severities: { ...answer().severities, insect_damage: sig('severe', 'high') } } });
    const baseline = await withGateOff(g);
    const result = await analyzeVisit({ photos });
    expect(result.findings[0]).toMatchObject({
      name: 'Brown patch', confidence: 'moderate', severity: 'mild', urgency: 'follow_up',
      customer_wording: 'wording for Brown patch', confirmation_step: 'check for Brown patch', label: 'large patch (fungal) activity',
    });
    // The untouched finding, scores, severities and grass are exactly Gemini's.
    expect(result.findings[1]).toEqual(baseline.findings[1]);
    expect(result.scores).toEqual(baseline.scores);
    expect(result.severities).toEqual(baseline.severities);
    expect(result.grassType).toBe(baseline.grassType);
    expect(result.observations).toBe(baseline.observations);
    expect(result.raw).toBe(g); // the provider's own answer is never rewritten
    expect(g.findings[0].name).toBe('Chinch bug damage');
    expect(result.referee).toMatchObject({ triggered: true, outcome: 'settled', disputes: [{ id: 'd1', kind: 'finding', geminiName: 'Chinch bug damage', solName: 'Brown patch', pick: 'b', settled: true }] });
  });

  test('pick a (Gemini side): the name stays, confidence caps at moderate', async () => {
    const g = setup(fableOk([{ id: 'd1', pick: 'a' }]));
    const baseline = await withGateOff(g);
    const result = await analyzeVisit({ photos });
    expect(baseline.findings[0]).toMatchObject({ name: 'Chinch bug damage', confidence: 'high' });
    expect(result.findings[0]).toEqual({ ...baseline.findings[0], confidence: 'moderate', label: result.findings[0].label });
    expect(result.findings[0].name).toBe('Chinch bug damage');
    expect(result.findings[0].confidence).toBe('moderate');
    expect(result.findings[1]).toEqual(baseline.findings[1]);
    expect(result.referee).toMatchObject({ outcome: 'settled', disputes: [{ pick: 'a', settled: true }] });
  });

  test('a cap never RAISES a lower confidence', async () => {
    const g = gemini({ findings: [named('Chinch bug damage', { confidence: 'low' })] });
    setup(fableOk([{ id: 'd1', pick: 'b' }]), { geminiJson: g });
    const result = await analyzeVisit({ photos });
    expect(result.findings[0]).toMatchObject({ confidence: 'low' });
  });

  test.each([
    ['neither', fableOk([{ id: 'd1', pick: 'neither' }]), 'no_majority', null],
    ['an unknown id and pick', fableOk([{ id: 'd9', pick: 'a' }, { id: 'd1', pick: 'maybe' }]), 'unavailable', 'schema_invalid'],
    ['a malformed answer', { ok: true, json: { answers: 'a' } }, 'unavailable', 'schema_invalid'],
    ['a provider failure', { ok: false, reason: 'anthropic_timeout' }, 'unavailable', 'anthropic_timeout'],
  ])('%s leaves the result EXACTLY as Gemini read it', async (label, fable, outcome, reason) => {
    const g = setup(fable);
    const baseline = await withGateOff(g);
    const result = await analyzeVisit({ photos });
    expect(strip(result)).toEqual(strip(baseline));
    expect(result.referee).toMatchObject({ triggered: true, outcome, reason });
  });

  test('a thrown Fable dispatch is contained', async () => {
    const g = setup(() => Promise.reject(new Error('boom')));
    const baseline = await withGateOff(g);
    const result = await analyzeVisit({ photos });
    expect(strip(result)).toEqual(strip(baseline));
    expect(result.referee).toMatchObject({ triggered: true, outcome: 'unavailable', reason: 'error' });
  });

  describe('timeouts', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('a Fable call that never returns is abandoned at the cap and Gemini stands', async () => {
      const g = setup(() => new Promise(() => {}));
      dispatchWithFallback.mockResolvedValue(ok(g));
      const pending = analyzeVisit({ photos });
      await jest.advanceTimersByTimeAsync(referee.REFEREE_MAX_MS + 6000);
      const result = await pending;
      expect(result.findings[0]).toMatchObject({ name: 'Chinch bug damage', confidence: 'high' });
      expect(result.referee).toMatchObject({ triggered: true, outcome: 'unavailable', reason: 'timeout' });
    });

    test('a Sol call that never returns is abandoned at its cap and Gemini stands', async () => {
      const g = gemini();
      dispatchWithFallback.mockResolvedValue(ok(g));
      dispatch.mockImplementation(() => new Promise(() => {}));
      const pending = analyzeVisit({ photos });
      await jest.advanceTimersByTimeAsync(referee.SECOND_OPINION_MAX_MS + 6000);
      const result = await pending;
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(result.referee).toMatchObject({ outcome: 'skipped', reason: 'second_opinion_failed', secondOpinion: { ok: false, reason: 'timeout' } });
    });
  });

  test('grass type: pick b takes Sol\'s grass; pick a keeps Gemini\'s; no confidence to cap', async () => {
    const g = answer({ grass_type: 'bahia', findings: [named('Thinning turf', { confidence: 'low' })] });
    const s = answer({ grass_type: 'st_augustine', findings: [named('Thinning turf', { confidence: 'low' })] });
    dispatchWithFallback.mockResolvedValue(ok(g));
    dispatch.mockResolvedValueOnce(solOk(s)).mockResolvedValueOnce(fableOk([{ id: 'd1', pick: 'b' }]));
    const settled = await analyzeVisit({ photos });
    expect(settled.grassType).toBe('st_augustine');
    expect(dispatch.mock.calls[1][1].system).toContain('d1: the grass type — A: "bahia"; B: "st_augustine"');
    expect(settled.referee.disputes[0]).toMatchObject({ kind: 'grass_type', pick: 'b', settled: true });

    dispatch.mockReset();
    dispatch.mockResolvedValueOnce(solOk(s)).mockResolvedValueOnce(fableOk([{ id: 'd1', pick: 'a' }]));
    const kept = await analyzeVisit({ photos });
    expect(kept.grassType).toBe('bahia');
  });

  test('two disputes settle independently: one matched, one a third answer', async () => {
    const g = answer({ grass_type: 'bahia', findings: [named('Chinch bug damage', { confidence: 'moderate', severity: 'moderate' })] });
    const s = answer({ grass_type: 'zoysia', findings: [named('Grub damage', { confidence: 'moderate' })] });
    dispatchWithFallback.mockResolvedValue(ok(g));
    dispatch.mockResolvedValueOnce(solOk(s)).mockResolvedValueOnce(fableOk([{ id: 'd1', pick: 'neither' }, { id: 'd2', pick: 'b' }]));
    const result = await analyzeVisit({ photos });
    expect(result.grassType).toBe('bahia');
    expect(result.findings[0]).toMatchObject({ name: 'Grub damage', confidence: 'moderate' });
    expect(result.referee).toMatchObject({ outcome: 'settled' });
    expect(result.referee.disputes.map((d) => [d.kind, d.pick, d.settled])).toEqual([['grass_type', 'neither', false], ['finding', 'b', true]]);
  });

  test('every Fable-settled result stays internal: referee never reaches findings, customer copy, or the run row', async () => {
    setup(fableOk([{ id: 'd1', pick: 'b' }]));
    const result = await analyzeVisit({ photos });
    expect(JSON.stringify([result.findings, result.observations, result.photoQuality, result.severities, result.scores])).not.toMatch(/referee|geminiName|second_opinion/i);
    const row = runRowFor({ assessment: { id: 'a1', customer_id: 'c1' }, analysis: result, photoRecords: [] });
    expect(JSON.stringify(row)).not.toMatch(/referee|geminiName|solName/i);
    expect(Object.keys(row)).not.toContain('referee');
    // The extra calls' tokens ARE billed to the run.
    const solTokens = 8000; const fableTokens = 12000; const geminiTokens = 9000;
    expect(billedUsage(result).input_tokens).toBe(geminiTokens + solTokens + fableTokens);
    expect(row.tokens_in).toBe(geminiTokens + solTokens + fableTokens);
    expect(row.tokens_reasoning).toBe(1500 + 900 + 4000);
  });
});

describe('findDisputes: the deterministic name rule', () => {
  const f = (name, extra = {}) => named(name, extra);
  const read = (findings, grass = 'unknown') => ({ grass_type: grass, findings });

  test('same cause under different words agrees, whatever the confidence', () => {
    for (const [a, b] of [['Chinch bug damage', 'chinch bugs'], ['Brown patch', 'Large patch disease'], ['Gray leaf spot', 'grey leaf spot'], ['Rhizoctonia', 'brown patch']]) {
      expect(referee.findDisputes(read([f(a, { confidence: 'high' })]), read([f(b, { confidence: 'low' })])).disputes).toEqual([]);
    }
  });

  test('different causes on the same photo dispute; the cause catalog is the production one', () => {
    for (const [a, b] of [['Chinch bug damage', 'Brown patch'], ['Drought stress', 'Grub activity'], ['Dollar spot', 'Gray leaf spot'], ['Nutsedge', 'Armyworm damage']]) {
      const { disputes } = referee.findDisputes(read([f(a)]), read([f(b)]));
      expect(disputes).toHaveLength(1);
      expect(disputes[0]).toMatchObject({ kind: 'finding', geminiIndex: 0, solIndex: 0, geminiName: a, solName: b });
    }
  });

  test('a generic fungal name is compatible with a specific fungal one, not with an insect', () => {
    expect(referee.findDisputes(read([f('Fungal disease')]), read([f('Large patch')])).disputes).toEqual([]);
    expect(referee.findDisputes(read([f('Fungal disease')]), read([f('Chinch bugs')])).disputes).toHaveLength(1);
  });

  test('symptom-only, clean, negated and unmapped names commit to no cause -> no dispute', () => {
    for (const name of ['Thinning turf', 'Color stress', 'No major visible stress', 'No chinch bugs observed', 'Irregular browning along the driveway edge']) {
      expect(referee.causeLabelsOf(name).size).toBe(0);
      expect(referee.findDisputes(read([f(name)]), read([f('Brown patch')])).disputes).toEqual([]);
      expect(referee.findDisputes(read([f('Brown patch')]), read([f(name)])).disputes).toEqual([]);
    }
  });

  test('a name that lists several causes is ambiguous, never a dispute', () => {
    expect([...referee.causeLabelsOf('Chinch bugs and drought stress')].sort()).toEqual(['chinch bug activity', 'drought stress']);
    const result = referee.findDisputes(read([f('Chinch bugs and drought stress')]), read([f('Brown patch')]));
    expect(result.disputes).toEqual([]);
    // ...and a Sol finding that also names Gemini's cause counts as agreement.
    expect(referee.findDisputes(read([f('Chinch bugs')]), read([f('Chinch bugs and drought stress'), f('Grub damage')])).disputes).toEqual([]);
  });

  test('pairing: a photo overlap is needed, or the same known zone when a side cites no photo', () => {
    expect(referee.findDisputes(read([f('Chinch bugs', { photo_refs: [1] })]), read([f('Brown patch', { photo_refs: [2] })])).disputes).toEqual([]);
    expect(referee.findDisputes(read([f('Chinch bugs', { photo_refs: [1, 2] })]), read([f('Brown patch', { photo_refs: [2] })])).disputes).toHaveLength(1);
    expect(referee.findDisputes(read([f('Chinch bugs', { photo_refs: [], zone: 'front' })]), read([f('Brown patch', { photo_refs: [], zone: 'front' })])).disputes).toHaveLength(1);
    expect(referee.findDisputes(read([f('Chinch bugs', { photo_refs: [], zone: 'unknown' })]), read([f('Brown patch', { photo_refs: [], zone: 'unknown' })])).disputes).toEqual([]);
    expect(referee.findDisputes(read([f('Chinch bugs', { photo_refs: [], zone: 'front' })]), read([f('Brown patch', { photo_refs: [], zone: 'trouble' })])).disputes).toEqual([]);
  });

  test('an ambiguous pairing draws no dispute and is counted', () => {
    // One Gemini finding overlapping two conflicting Sol findings.
    const one = referee.findDisputes(read([f('Chinch bugs', { photo_refs: [1, 2] })]), read([f('Brown patch', { photo_refs: [1] }), f('Grub damage', { photo_refs: [2] })]));
    expect(one).toEqual({ disputes: [], ambiguous: 1 });
    // Two Gemini findings overlapping one Sol finding.
    const two = referee.findDisputes(read([f('Chinch bugs', { photo_refs: [1] }), f('Drought stress', { photo_refs: [1, 2] })]), read([f('Brown patch', { photo_refs: [1] })]));
    expect(two.disputes).toEqual([]);
    expect(two.ambiguous).toBeGreaterThan(0);
  });

  test('either side agreeing with ANY overlapping read is agreement (extra Sol findings do not create a dispute)', () => {
    expect(referee.findDisputes(read([f('Chinch bugs')]), read([f('Chinch bugs', { confidence: 'low' }), f('Brown patch')])).disputes).toEqual([]);
  });

  test('an undeterminable or unknown-confidence finding is not a naming vote', () => {
    expect(referee.findDisputes(read([f('Chinch bugs', { can_determine: false })]), read([f('Brown patch')])).disputes).toEqual([]);
    expect(referee.findDisputes(read([f('Chinch bugs')]), read([f('Brown patch', { confidence: 'unknown' })])).disputes).toEqual([]);
    expect(referee.findDisputes(read([f('Chinch bugs', { confidence: 'unknown' })]), read([f('Brown patch')])).disputes).toEqual([]);
  });

  test('grass type disputes only between two definite, different values', () => {
    const dispute = (g, s) => referee.findDisputes(read([], g), read([], s)).disputes.map((d) => d.kind);
    expect(dispute('bahia', 'st_augustine')).toEqual(['grass_type']);
    expect(dispute('bahia', 'bahia')).toEqual([]);
    expect(dispute('unknown', 'bahia')).toEqual([]);
    expect(dispute('bahia', 'unknown')).toEqual([]);
    expect(dispute('mixed', 'bahia')).toEqual([]);
    expect(dispute('bahia', 'centipede')).toEqual([]);
  });
});

describe('secondOpinionReasons', () => {
  test('none for a confident, mild read with a known grass', () => {
    expect(referee.secondOpinionReasons(cleanGemini())).toEqual([]);
    expect(referee.secondOpinionReasons({ grass_type: 'mixed', findings: [named('Dollar spot', { confidence: 'high' })] })).toEqual([]);
  });
  test('malformed input never throws', () => {
    expect(referee.secondOpinionReasons(null)).toEqual([]);
    expect(referee.secondOpinionReasons({ findings: 'x' })).toEqual([]);
  });
});

describe('registry wiring', () => {
  test('the route is single-leg Anthropic Fable at effort high, override via MODEL_LAWN_ASSESSMENT_REFEREE', () => {
    expect(MODELS.ROUTES.lawnAssessmentReferee).toEqual({ provider: 'anthropic', model: MODELS.LAWN_ASSESSMENT_REFEREE, effort: 'high' });
    expect(MODELS.LAWN_ASSESSMENT_REFEREE).toBe(process.env.MODEL_LAWN_ASSESSMENT_REFEREE || 'claude-fable-5-1');
    expect(MODELS.MODEL_CATALOG[MODELS.LAWN_ASSESSMENT_REFEREE].requires).toBe('deep');
    // The visit's own two-provider policy is untouched.
    expect(MODELS.TEXT_POLICIES.lawnVisitAssessment.fallback).toEqual({ provider: 'openai', model: MODELS.OPENAI_LAWN_ASSESSMENT });
  });
});
