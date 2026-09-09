jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lawn-intelligence', () => ({}));
jest.mock('../services/knowledge-bridge', () => ({}));

const visit = require('../services/lawn-visit-assessment');
const delivery = require('../services/lawn-visit-delivery');

// A minimal knex stand-in: knex(table).where(...).first(...) resolves the row in `rows[table]`.
function fakeKnex(rows) {
  return jest.fn((table) => ({ where: () => ({ first: async () => rows[table] ?? null }) }));
}
function intelMocks() {
  return {
    LawnIntel: { attachWeather: jest.fn(async () => null), recordTechCalibration: jest.fn(async () => ({})), emitHealthSignal: jest.fn(async () => null), sendAssessmentNotification: jest.fn(async () => null), generateServiceReport: jest.fn(async () => null), trackAssessmentCompletion: jest.fn(async () => null) },
    KnowledgeBridge: { generateAssessmentRecommendations: jest.fn(async () => ({ summary: 's' })) },
  };
}
const snapshot = JSON.stringify({ turf_density: 70, weed_suppression: 80, color_health: 70, fungus_control: 75, thatch_level: 60, stress_damage: 60 });
const confirmedRow = (overrides = {}) => ({ id: 'a1', customer_id: 'c1', service_id: null, service_date: '2026-09-08', confirmed_by_tech: true, turf_density: 72, weed_suppression: 80, color_health: 70, fungus_control: 75, thatch_level: 60, stress_damage: 55, recommendations: null, report_auto_generated: false, report_id: null, notification_sent: false, ...overrides });

describe('deliverConfirmedAssessment', () => {
  let loadRun; let completePipeline;
  beforeEach(() => {
    loadRun = jest.spyOn(visit, 'loadRun');
    completePipeline = jest.spyOn(visit, 'completePipeline').mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  test('a first delivery of a run-backed row runs every owed step once, calibrates from the request, tracks completion, and completes the claim', async () => {
    loadRun.mockResolvedValue({ status: 'complete', scores_adjusted: snapshot });
    const deps = { knex: fakeKnex({ lawn_assessments: confirmedRow(), tech_calibration: null }), ...intelMocks() };
    const out = await delivery.deliverConfirmedAssessment({ assessmentId: 'a1', calibrate: { aiScores: { turf_density: 70 }, finalScores: { turf_density: 72 } } }, deps);
    expect(out).toMatchObject({ firstAttempt: true, gaps: [] });
    expect(out.done).toEqual(['calibration', 'recommendations', 'notification', 'report']);
    expect(deps.LawnIntel.recordTechCalibration).toHaveBeenCalledWith('a1', { turf_density: 70 }, { turf_density: 72 });
    expect(deps.LawnIntel.trackAssessmentCompletion).toHaveBeenCalledWith('2026-09-08');
    expect(completePipeline).toHaveBeenCalledWith('a1', deps.knex);
  });

  test('a resumed delivery executes only the gaps: a delivered recommendation is never regenerated beside an already-generated report, completion is not tracked again, calibration is rebuilt from the run snapshot once', async () => {
    loadRun.mockResolvedValue({ status: 'complete', scores_adjusted: snapshot });
    const row = confirmedRow({ recommendations: JSON.stringify({ summary: 'tip', recommendations: [] }), report_auto_generated: true });
    const deps = { knex: fakeKnex({ lawn_assessments: row, tech_calibration: null }), ...intelMocks() };
    const out = await delivery.deliverConfirmedAssessment({ assessmentId: 'a1', calibrate: 'resume' }, deps);
    expect(out.done).toEqual(['calibration', 'notification']);
    expect(out.firstAttempt).toBe(false);
    expect(deps.KnowledgeBridge.generateAssessmentRecommendations).not.toHaveBeenCalled();
    expect(deps.LawnIntel.generateServiceReport).not.toHaveBeenCalled();
    expect(deps.LawnIntel.trackAssessmentCompletion).not.toHaveBeenCalled();
    // The rebuilt comparison: the run's snapshot against the scores the row confirmed with.
    expect(deps.LawnIntel.recordTechCalibration).toHaveBeenCalledWith('a1', JSON.parse(snapshot), { turf_density: 72, weed_suppression: 80, color_health: 70, fungus_control: 75, thatch_level: 60, stress_damage: 55 });
    // A calibration already recorded is never duplicated.
    const again = { knex: fakeKnex({ lawn_assessments: row, tech_calibration: { id: 'cal-1' } }), ...intelMocks() };
    await delivery.deliverConfirmedAssessment({ assessmentId: 'a1', calibrate: 'resume' }, again);
    expect(again.LawnIntel.recordTechCalibration).not.toHaveBeenCalled();
  });

  test('a lease left behind by a failed generation ({}) is a gap, not a delivered recommendation; a service-linked row owes no notification', async () => {
    expect(visit.completedRecommendations('{}')).toBe(false);
    expect(visit.completedRecommendations(JSON.stringify({ _generationRuns: { x: 1 } }))).toBe(false);
    expect(visit.completedRecommendations(JSON.stringify({ summary: 'tip' }))).toBe(true);
    expect(visit.completedRecommendations(JSON.stringify({ recommendations: [{ text: 't' }] }))).toBe(true);
    expect(visit.deliveryGaps(confirmedRow({ recommendations: '{}', report_id: 'r', service_id: 's1' }))).toEqual(['recommendations']);
    loadRun.mockResolvedValue({ status: 'complete', scores_adjusted: snapshot });
    const deps = { knex: fakeKnex({ lawn_assessments: confirmedRow({ recommendations: '{}', report_id: 'r', service_id: 's1' }), tech_calibration: null }), ...intelMocks() };
    const out = await delivery.deliverConfirmedAssessment({ assessmentId: 'a1' }, deps);
    expect(out.done).toEqual(['recommendations']);
    expect(deps.LawnIntel.sendAssessmentNotification).not.toHaveBeenCalled();
  });

  test('a legacy row (no run) delivers every step as before; an unconfirmed row delivers nothing', async () => {
    loadRun.mockResolvedValue(undefined);
    const deps = { knex: fakeKnex({ lawn_assessments: confirmedRow({ recommendations: JSON.stringify({ summary: 'old' }), report_auto_generated: true }), tech_calibration: null }), ...intelMocks() };
    const out = await delivery.deliverConfirmedAssessment({ assessmentId: 'a1' }, deps);
    expect(out.done).toEqual(['recommendations', 'notification', 'report']);
    expect(completePipeline).not.toHaveBeenCalled();
    const none = { knex: fakeKnex({ lawn_assessments: confirmedRow({ confirmed_by_tech: false }) }), ...intelMocks() };
    expect(await delivery.deliverConfirmedAssessment({ assessmentId: 'a1' }, none)).toMatchObject({ skipped: 'not_confirmed' });
    expect(none.LawnIntel.attachWeather).not.toHaveBeenCalled();
  });

  test('calibrationBaseline seeds a legacy stress floor; resumedCalibration is null without a comparable snapshot', () => {
    expect(delivery.calibrationBaseline(null, { adjusted_scores: JSON.stringify({ fungus_control: 70, thatch_level: 60 }) })).toEqual({ fungus_control: 70, thatch_level: 60, stress_damage: 60 });
    expect(delivery.calibrationBaseline({ turf_density: 70, stress_damage: 50 }, {})).toEqual({ turf_density: 70, stress_damage: 50 });
    expect(delivery.resumedCalibration(confirmedRow(), { status: 'complete', scores_adjusted: null })).toBeNull();
    expect(delivery.resumedCalibration(confirmedRow(), { status: 'unavailable' })).toBeNull();
  });
});

describe('sweepAbandonedDeliveries', () => {
  afterEach(() => jest.restoreAllMocks());

  test('claims and resumes each abandoned confirmed delivery, skipping a row another claimant took; a database without the columns has nothing to sweep', async () => {
    const claim = jest.spyOn(visit, 'claimPipeline').mockImplementation(async (id) => id !== 'a2');
    const resumed = [];
    const rows = [{ assessment_id: 'a1' }, { assessment_id: 'a2' }, { assessment_id: 'a3' }];
    const query = { join: () => query, where: () => query, whereNull: () => query, orderBy: () => query, limit: () => query, select: async () => rows };
    const knex = jest.fn(() => query);
    // deliverConfirmedAssessment is exercised above; here only its dispatch matters.
    const deliver = jest.fn(async ({ assessmentId, calibrate }) => { resumed.push([assessmentId, calibrate]); if (assessmentId === 'a3') throw new Error('boom'); });
    expect(await delivery.sweepAbandonedDeliveries({ knex, deliver })).toEqual({ candidates: 3, resumed: 1, failed: 1 });
    expect(resumed).toEqual([['a1', 'resume'], ['a3', 'resume']]);
    expect(claim).toHaveBeenCalledTimes(3);
    const broken = { join: () => broken, where: () => broken, whereNull: () => broken, orderBy: () => broken, limit: () => broken, select: async () => { throw Object.assign(new Error('no column'), { code: '42703' }); } };
    expect(await delivery.sweepAbandonedDeliveries({ knex: jest.fn(() => broken), deliver })).toEqual({ candidates: 0, resumed: 0, failed: 0 });
  });
});
