jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lawn-visit-runs', () => ({
  ...jest.requireActual('../services/lawn-visit-runs'),
  loadRun: jest.fn(), confirmRun: jest.fn(),
}));
jest.mock('../services/lawn-visit-delivery', () => ({ deliverConfirmedAssessment: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/knowledge-bridge', () => ({ generateAssessmentRecommendations: jest.fn() }));
jest.mock('../services/lawn-intelligence', () => ({ attachWeather: jest.fn() }));
jest.mock('../services/agronomic-wiki', () => ({ linkTreatmentOutcome: jest.fn() }));
jest.mock('../services/photos', () => null);

const db = require('../models/db');
const runs = require('../services/lawn-visit-runs');
const delivery = require('../services/lawn-visit-delivery').deliverConfirmedAssessment;
const logger = require('../services/logger');
const confirm = require('../routes/admin-lawn-assessment').stack
  .find((layer) => layer.route?.path === '/confirm').route.stack[0].handle;

describe('visit confirmation HTTP boundary', () => {
  const assessment = { id: 'fixture-assessment', customer_id: 'fixture-customer', confirmed_by_tech: false };
  const run = { id: 'fixture-run', status: 'complete', raw_response: { private: true }, context_hash: 'private' };
  let scheduled;

  beforeEach(() => {
    jest.clearAllMocks();
    scheduled = [];
    jest.spyOn(global, 'setImmediate').mockImplementation((work) => { scheduled.push(work); });
    db.mockReturnValue({ where: jest.fn().mockReturnValue({ first: jest.fn().mockResolvedValue(assessment) }) });
    runs.loadRun.mockResolvedValue(run);
    runs.confirmRun.mockResolvedValue({ assessment, run, confirmed: false, missingScores: ['color_health'] });
    delivery.mockResolvedValue({ done: [], gaps: [] });
  });
  afterEach(() => jest.restoreAllMocks());

  async function request(body = {}) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await confirm({ body: { assessmentId: assessment.id, ...body }, technicianId: 'fixture-tech' }, res, next);
    return { res, next, body: res.json.mock.calls[0]?.[0] };
  }

  test('returns pending scores without scheduling delivery or exposing raw provenance', async () => {
    const result = await request({ adjustedScores: { turf_density: 61 }, observationEdit: '' });
    expect(result.next).not.toHaveBeenCalled();
    expect(result.body).toMatchObject({ success: true, confirmed: false, missingScores: ['color_health'], assessment, visitAssessment: { runId: run.id } });
    expect(result.body.visitAssessment).not.toHaveProperty('raw_response');
    expect(result.body.visitAssessment).not.toHaveProperty('context_hash');
    expect(runs.confirmRun).toHaveBeenCalledWith(expect.objectContaining({
      assessmentId: assessment.id, adjustedScores: { turf_density: 61 }, observationEdit: '', technicianId: 'fixture-tech',
    }), db);
    expect(scheduled).toHaveLength(0);
    expect(require('../services/agronomic-wiki').linkTreatmentOutcome).not.toHaveBeenCalled();
  });

  test('responds before delivery and a failed task does not turn confirmation into an HTTP error', async () => {
    runs.confirmRun.mockResolvedValue({ assessment: { ...assessment, confirmed_by_tech: true }, run, confirmed: true, missingScores: [] });
    delivery.mockRejectedValueOnce(new Error('fixture delivery unavailable'));
    const first = await request();
    expect(first.body).toMatchObject({ success: true, confirmed: true, missingScores: [] });
    expect(delivery).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(1);
    await scheduled.shift()();
    expect(first.next).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Intelligence pipeline failed'));

    const retry = await request();
    expect(retry.body).toEqual(first.body);
    await scheduled.shift()();
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(delivery).toHaveBeenLastCalledWith({ assessmentId: assessment.id });
    expect(require('../services/lawn-intelligence').attachWeather).not.toHaveBeenCalled();
  });

  test('a failed transaction reaches error middleware without a success response or delivery', async () => {
    const failure = Object.assign(new Error('fixture write failed'), { code: '23514' });
    runs.confirmRun.mockRejectedValueOnce(failure);
    const { res, next } = await request();
    expect(next).toHaveBeenCalledWith(failure);
    expect(res.json).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });

  test.each([400, 404, 409])('preserves expected transaction status %s at the HTTP boundary', async (status) => {
    const failure = Object.assign(new Error('Invalid visit assessment review'), { status, details: ['Unknown finding ID'] });
    runs.confirmRun.mockRejectedValueOnce(failure);
    const { res, next, body } = await request();
    expect(res.status).toHaveBeenCalledWith(status);
    expect(body).toEqual({ error: failure.message, details: failure.details });
    expect(next).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });

  test.each([
    { assessmentId: null }, { observationEdit: {} },
    { stress_flags: { drought_stress: 'yes' } },
    { protocol_field_checks: { irrigation_status: 'invalid' } },
  ])('rejects invalid input before reading or writing: %j', async (body) => {
    const { res, next } = await request(body);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
    expect(runs.confirmRun).not.toHaveBeenCalled();
    expect(scheduled).toHaveLength(0);
  });
});
