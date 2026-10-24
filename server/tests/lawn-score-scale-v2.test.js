/**
 * Lawn score scale 2 (GATE_LAWN_SCORE_SCALE_V2, owner 2026-10-24, lawn scoring
 * review): the visit read asks for four 0-100 ratings against written anchors,
 * the server keeps them as read with no season multiplier, each row carries its
 * scale, and every visit-to-visit comparison stays on one scale. Gate off: the
 * prompt, schema, version, digest, hash and scores are what they were.
 * No provider call: llm/call is mocked. Synthetic ids only.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(), dispatch: jest.fn(), rejectCall: jest.fn() }));

const Ajv = require('ajv');
const { dispatchWithFallback } = require('../services/llm/call');
const input = require('../services/lawn-visit-input');
const result = require('../services/lawn-visit-result');
const visitScores = require('../services/lawn-visit-scores');
const history = require('../services/lawn-assessment-history');
const guide = require('../services/lawn-treatment-guide');
const evalLib = require('../services/eval/lawn-visit-assessment-eval');
const { lastVisitScores } = require('../services/lawn-last-visit-scores');
const { analyzeVisit } = require('../services/lawn-visit-assessment');
const { lawnScoreScaleV2Live } = require('../config/feature-gates');
const MODELS = require('../config/models');
const { photo, answer } = require('./helpers/lawn-visit-fixtures');

const ENV = ['GATE_LAWN_SCORE_SCALE_V2', 'GATE_LAWN_VISIT_ASSESSMENT', 'GATE_LAWN_PROPERTY_HISTORY', 'GATE_LAWN_LIGHTING', 'GATE_LAWN_ASSESSMENT_REFEREE'];
const saved = {};
beforeEach(() => {
  dispatchWithFallback.mockReset();
  ENV.forEach((name) => { saved[name] = process.env[name]; delete process.env[name]; });
});
afterEach(() => {
  ENV.forEach((name) => { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; });
  jest.restoreAllMocks();
});
const on = () => {
  process.env.GATE_LAWN_SCORE_SCALE_V2 = 'true';
  process.env.GATE_LAWN_VISIT_ASSESSMENT = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
};

const rating = (value) => ({ determinable: true, value });
const scale2Scores = { turf_density: rating(82), weed_control: rating(78), color_health: rating(85), condition: rating(90) };
const scale2Answer = (overrides = {}) => answer({ scores: scale2Scores, ...overrides });
const okOutcome = (json) => ({ ok: true, json, provider: 'gemini', model: MODELS.GEMINI_LAWN_ASSESSMENT, fallbackUsed: false, usage: null, failures: [] });
const MODES = [{}, { shotList: true }, { lighting: true }, { shotList: true, lighting: true }];

function strictSchemaProblems(node, path = 'root', problems = []) {
  if (!node || typeof node !== 'object') return problems;
  if (Array.isArray(node.type)) problems.push(`${path}: type array`);
  if (node.type === 'object') {
    if (node.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
    if (JSON.stringify(node.required || []) !== JSON.stringify(Object.keys(node.properties || {}))) problems.push(`${path}: required != keys`);
    for (const [key, child] of Object.entries(node.properties || {})) strictSchemaProblems(child, `${path}.${key}`, problems);
  }
  if (node.items) strictSchemaProblems(node.items, `${path}[]`, problems);
  return problems;
}

describe('the gate', () => {
  test('is on only for exactly "true" with the visit assessment and property history gates on, read at call time', () => {
    expect(lawnScoreScaleV2Live()).toBe(false);
    on();
    expect(lawnScoreScaleV2Live()).toBe(true);
    process.env.GATE_LAWN_SCORE_SCALE_V2 = '1';
    expect(lawnScoreScaleV2Live()).toBe(false);
    on();
    delete process.env.GATE_LAWN_VISIT_ASSESSMENT;
    expect(lawnScoreScaleV2Live()).toBe(false);
    on();
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
    expect(lawnScoreScaleV2Live()).toBe(false);
  });
});

describe('prompt variants', () => {
  test('scale 1 is untouched in every capture and light mode', () => {
    expect(input.promptFor({ scale2: false })).toEqual(input.promptFor());
    expect(input.promptFor().digest).toBe(input.PROMPT_DIGEST);
    expect(input.promptFor({ shotList: true }).digest).toBe(input.SHOT_LIST_PROMPT_DIGEST);
    expect(input.promptFor({ lighting: true }).digest).toBe(input.LIGHTING_PROMPT_DIGEST);
    expect(input.promptFor({ shotList: true, lighting: true }).digest).toBe(input.SHOT_LIST_LIGHTING_PROMPT_DIGEST);
    expect(input.variantOfVersion('lawn-visit-v1-lighting')).toEqual({ shotList: false, lighting: true });
  });

  test('scale 2 has its own version and digest in every mode, and each version maps back to its variant', () => {
    const versions = MODES.map((mode) => input.promptFor({ ...mode, scale2: true }).version);
    expect(versions).toEqual(['lawn-visit-v1-scale2', 'lawn-visit-v1-shot-list-scale2', 'lawn-visit-v1-lighting-scale2', 'lawn-visit-v1-shot-list-lighting-scale2']);
    for (const mode of MODES) {
      const v1 = input.promptFor(mode);
      const v2 = input.promptFor({ ...mode, scale2: true });
      expect(v2.digest).not.toBe(v1.digest);
      expect(input.variantOfVersion(v2.version)).toEqual({ shotList: !!mode.shotList, lighting: !!mode.lighting, scale2: true });
      expect(input.promptFor(input.variantOfVersion(v2.version)).digest).toBe(v2.digest);
    }
  });

  test('scale 2 asks four anchored 0-100 ratings, never a weed share, and changes nothing else in the prompt', () => {
    const v1 = input.promptFor();
    const v2 = input.promptFor({ scale2: true });
    expect(v2.system).toContain('four 0-100 ratings');
    expect(v2.system).toContain('90 a few scattered weeds');
    expect(v2.system).toContain('Count thatch only where a photo shows the thatch layer');
    expect(v2.system).not.toContain('share of the visible lawn carrying weeds');
    expect(v1.system).toContain('share of the visible lawn carrying weeds');
    // Everything before and after the SCORES block is the scale-1 text.
    const around = (system) => {
      const start = system.indexOf('# SCORES');
      const end = system.indexOf('\n#', start + 1);
      return [system.slice(0, start), end < 0 ? '' : system.slice(end)];
    };
    expect(around(v2.system)).toEqual(around(v1.system));
    const shot = input.promptFor({ shotList: true, scale2: true });
    expect(shot.system).toContain('Area scores (turf_density, weed_control, color_health)');
    expect(shot.system).toContain('severities) and the condition score: the worst across all photos');
  });

  test('the scale-2 schema is strict, holds the four ratings 0-100, and is otherwise the scale-1 schema', () => {
    for (const mode of MODES) {
      const v1 = input.promptFor(mode);
      const v2 = input.promptFor({ ...mode, scale2: true });
      expect(strictSchemaProblems(v2.schema)).toEqual([]);
      expect(Object.keys(v2.schema.properties.scores.properties)).toEqual(['turf_density', 'weed_control', 'color_health', 'condition']);
      expect({ ...v2.schema.properties, scores: null }).toEqual({ ...v1.schema.properties, scores: null });
    }
    const validate = new Ajv().compile(input.promptFor({ scale2: true }).schema.properties.scores.properties.color_health);
    for (const value of [0, 100]) expect(validate({ determinable: true, value })).toBe(true);
    for (const value of [-1, 101, 7.5, '80', null]) expect(validate({ determinable: true, value })).toBe(false);
  });

  test('the input hash differs between the scales for the same photos and context', () => {
    const args = { photos: [photo('YQ==', 'front')], photoZones: ['front'], visionContext: { month: 10 } };
    expect(input.contextHash({ ...args, scale2: false })).toBe(input.contextHash(args));
    expect(input.contextHash({ ...args, scale2: true })).not.toBe(input.contextHash(args));
  });
});

describe('answer check and normalization', () => {
  test('each scale accepts only its own scores shape', () => {
    expect(result.validateAssessmentJson({ json: scale2Answer() }, 2, { scale2: true })).toBeNull();
    expect(result.validateAssessmentJson({ json: answer() }, 2, { scale2: true })).toBe('malformed_assessment');
    expect(result.validateAssessmentJson({ json: scale2Answer() }, 2)).toBe('malformed_assessment');
    const lit = scale2Answer({ photo_quality: [1, 2].map((n) => ({ photo: n, quality: 'adequate', issue: '', lighting: 'full_sun', hard_shadows: 'no' })) });
    expect(result.validateAssessmentJson({ json: lit }, 2, { lighting: true, scale2: true })).toBeNull();
    expect(result.validateAssessmentJson({ json: lit }, 2, { scale2: true })).toBe('malformed_assessment');
  });

  test('scale 2 keeps the four ratings as read and marks the scale; an undeterminable rating is null', () => {
    const out = result.normalizeAssessment(scale2Answer({ scores: { ...scale2Scores, condition: { determinable: false, value: 50 } } }), 2, [], { scale2: true });
    expect(out.scores).toEqual({ turf_density: 82, weed_control: 78, color_health: 85, condition: null });
    expect(out.scoreScale).toBe(2);
    expect(result.normalizeAssessment(answer(), 2)).not.toHaveProperty('scoreScale');
    const composite = result.compositeFor(result.normalizeAssessment(scale2Answer(), 2, [], { scale2: true }));
    expect(composite).toMatchObject({ score_scale: 2, turf_density: 82, weed_control: 78, color_health: 85, condition: 90, weed_coverage: null });
  });
});

describe('scores kept as read', () => {
  const scale1 = () => result.normalizeAssessment(answer(), 2);
  const scale2 = () => result.normalizeAssessment(scale2Answer(), 2, [], { scale2: true });

  test('the stored columns are the ratings; fungus and thatch still come from the severity words', () => {
    const derived = visitScores.deriveLegacyScores(scale2());
    const legacy = visitScores.deriveLegacyScores(scale1());
    expect(derived).toMatchObject({ turf_density: 82, weed_suppression: 78, color_health: 85, stress_damage: 90 });
    expect(derived.fungus_control).toBe(legacy.fungus_control);
    expect(derived.thatch_level).toBe(legacy.thatch_level);
    // Scale 1 is unchanged: weed = 100 - share, Condition = the worst word.
    expect(legacy.weed_suppression).toBe(85);
    expect(legacy.stress_damage).toBeLessThanOrEqual(legacy.thatch_level);
  });

  test('no season multiplier on a scale-2 read; scale 1 still takes it', () => {
    const boost = (scores) => ({ ...scores, turf_density: Math.min(100, Math.round(scores.turf_density * 1.1)) });
    const overall = jest.fn(() => 77);
    const two = visitScores.scoreVisit(scale2(), { seasonAdjust: boost, calculateOverallScore: overall });
    expect(two.adjustedScores).toEqual(two.displayScores);
    expect(two.adjustedScores.turf_density).toBe(82);
    expect(overall).toHaveBeenCalledWith(two.displayScores);
    expect(two.mergedComposite.score_scale).toBe(2);
    const one = visitScores.scoreVisit(scale1(), { seasonAdjust: boost, calculateOverallScore: overall });
    expect(one.adjustedScores.turf_density).toBe(79);
  });

  test('confirm never derives a scale-2 Condition from the severity words: unrated, it stays unknown and the row stays pending', () => {
    const scoreValue = (value) => Math.max(0, Math.min(100, Math.round(Number(value))));
    const options = { scoreValue, calculateOverallScore: () => 77 };
    const read = { turf_density: 82, weed_suppression: 78, color_health: 85, fungus_control: 95, thatch_level: 60, stress_damage: null };
    const run = { status: 'complete', severities: {}, scores_adjusted: { ...read } };
    const two = visitScores.confirmScores({ ...read, score_scale: 2 }, run, {}, options);
    expect(two).toMatchObject({ confirmed: false, missing: ['stress_damage'], overallScore: null });
    expect(two.finalScores.stress_damage).toBeNull();
    // The technician's entry completes it.
    expect(visitScores.confirmScores({ ...read, score_scale: 2 }, run, { stress_damage: 88 }, options))
      .toMatchObject({ confirmed: true, finalScores: { stress_damage: 88 } });
    // Scale 1 keeps the worst-component derivation.
    expect(visitScores.confirmScores({ ...read }, run, {}, options)).toMatchObject({ confirmed: true, finalScores: { stress_damage: 60 } });
  });

  test('the eval scores a scale-2 replay as read', () => {
    const scored = evalLib.scoreResult({ assessmentId: 'a', visitDate: '2026-10-01', photos: [{}, {}], month: 12, confirmed: {}, legacyAi: {} },
      { ...scale2(), provider: 'gemini', model: 'm', raw: scale2Answer(), promptVersion: 'lawn-visit-v1-scale2' });
    expect(scored.adjusted).toEqual(scored.derived);
    expect(scored.derived.weed_suppression).toBe(78);
  });
});

describe('analyzeVisit', () => {
  test('gate on: reads under the scale-2 variant, checks its shape, and returns the ratings as read', async () => {
    on();
    dispatchWithFallback.mockResolvedValue(okOutcome(scale2Answer()));
    const out = await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==')] });
    const variant = input.promptFor({ scale2: true });
    const [, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(payload).toMatchObject({ system: variant.system, jsonSchema: variant.schema, promptVersion: 'lawn-visit-v1-scale2' });
    expect(options.validate({ json: answer() })).toBe('malformed_assessment');
    expect(options.validate({ json: scale2Answer() })).toBeNull();
    expect(out).toMatchObject({ promptVersion: 'lawn-visit-v1-scale2', scoreScale: 2, scores: { turf_density: 82, weed_control: 78, color_health: 85, condition: 90 } });
    expect(out.contextHash).toBe(input.contextHash({ photos: [photo('YQ==', 'front'), photo('Yg==')], photoZones: ['front', null], visionContext: {}, scale2: true }));
  });

  test('gate on, both providers miss: the unavailable read still carries scale 2', async () => {
    on();
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'gemini_timeout', failures: [{ provider: 'gemini', reason: 'gemini_timeout' }] });
    const out = await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==')] });
    expect(out).toMatchObject({ status: 'unavailable', promptVersion: 'lawn-visit-v1-scale2', scoreScale: 2 });
  });

  test('gate off, or on without property history: the scale-1 read', async () => {
    dispatchWithFallback.mockResolvedValue(okOutcome(answer()));
    expect((await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==')] })).promptVersion).toBe('lawn-visit-v1');
    on();
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
    const out = await analyzeVisit({ photos: [photo('YQ==', 'front'), photo('Yg==')] });
    expect(out.promptVersion).toBe('lawn-visit-v1');
    expect(out).not.toHaveProperty('scoreScale');
  });
});

describe('history holds one score scale', () => {
  const SCOPE = { customerId: 'customer-a', propertyId: 'property-a' };
  const row = (id, date, scale) => ({
    id, customer_id: 'customer-a', service_id: `visit-${id}`, property_id: 'property-a',
    history_visit_id: `visit-${id}`, history_visit_customer_id: 'customer-a', history_visit_property_id: 'property-a',
    history_visit_date: date, service_date: date, confirmed_by_tech: true, created_at: `${date}T12:00:00Z`,
    ...(scale === undefined ? {} : { score_scale: scale }),
  });
  const rows = [row('jun', '2026-06-10'), row('aug', '2026-08-10', null), row('nov', '2026-11-10', 2), row('dec', '2026-12-10', 2)];
  const ids = (list) => list.map((r) => r.id);

  test('no scale-2 row: the history is unchanged', async () => {
    const legacy = rows.slice(0, 2);
    expect(ids(history.sameScoreScale(legacy))).toEqual(['jun', 'aug']);
    expect(ids(await history.propertyHistory({ customerId: 'customer-a', scope: SCOPE, rows: legacy }))).toEqual(['jun', 'aug']);
  });

  test('the newest row decides without a current visit; a current visit decides for itself; a named scale wins', async () => {
    expect(ids(await history.propertyHistory({ customerId: 'customer-a', scope: SCOPE, rows }))).toEqual(['nov', 'dec']);
    expect(ids(await history.propertyHistory({ customerId: 'customer-a', scope: SCOPE, rows, current: rows[3] }))).toEqual(['nov', 'dec']);
    expect(ids(await history.propertyHistory({ customerId: 'customer-a', scope: SCOPE, rows, current: rows[1] }))).toEqual(['jun', 'aug']);
    expect(ids(await history.propertyHistory({ customerId: 'customer-a', scope: SCOPE, rows, scoreScale: 1 }))).toEqual(['jun', 'aug']);
    expect(ids(await history.propertyHistory({ customerId: 'customer-a', scope: SCOPE, rows: rows.slice(0, 2), scoreScale: 2 }))).toEqual([]);
  });

  test('progress at the first scale-2 visit has no previous and its own baseline', async () => {
    const current = rows[2];
    const list = await history.propertyHistory({ customerId: 'customer-a', scope: SCOPE, rows, current });
    expect(ids(list)).toEqual(['nov']);
    const scored = list.map((r) => ({ ...r, turf_density: 80, weed_suppression: 80, color_health: 80, stress_damage: 80 }));
    expect(history.progress(scored, scored[0])).toMatchObject({ previousScore: null, previousDelta: null, baselineDelta: 0 });
  });

  test('the Last visit row asks the history for the scale of the visit being read', async () => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    const spy = jest.spyOn(history, 'historyBeforeVisit').mockResolvedValue({ previous: null });
    const visit = { id: 'visit-x', customer_id: 'customer-a', scheduled_date: '2026-12-20' };
    expect(await lastVisitScores(visit, {}, { scoreScale: 2 })).toBeNull();
    expect(spy).toHaveBeenCalledWith({ customerId: 'customer-a', scheduledService: visit, throughVisitDate: '2026-12-20', scoreScale: 2 }, {});
    await lastVisitScores(visit, {});
    expect(spy.mock.calls[1][0]).toMatchObject({ scoreScale: undefined });
  });
});

describe('treatment guide weed card', () => {
  const WEEDS = { names: ['dollarweed'], note: null, productIds: ['product-a'], items: [] };
  const cards = (signals) => guide.buildCards({ signals: { fungus: 'none', insect: 'none', drought: 'none', ...signals }, month: 10, offers: {}, weeds: WEEDS });

  test('a scale-2 row carries its rating, never a share of the lawn', () => {
    expect(guide.signalsFromAssessment({ weed_suppression: 82, score_scale: 2 }, { scores_raw: { weed_control: 70 } }))
      .toMatchObject({ weedCoverage: null, weedControl: 82 });
    expect(guide.signalsFromAssessment({ weed_suppression: 82 })).toMatchObject({ weedCoverage: 18 });
    expect(guide.signalsFromAssessment({ weed_suppression: 82 })).not.toHaveProperty('weedControl');
  });

  test('the card shows at the same line, named as the rating', () => {
    expect(cards({ weedControl: 82 }).map((card) => card.finding)).toEqual(['Weed control scored 82 today.']);
    expect(cards({ weedControl: 90 }).map((card) => card.finding)).toEqual(['Weed control scored 90 today.']);
    expect(cards({ weedControl: 91 })).toEqual([]);
    expect(cards({ weedCoverage: 18 }).map((card) => card.finding)).toEqual(['Photos show weeds on about 18% of the lawn.']);
  });
});
