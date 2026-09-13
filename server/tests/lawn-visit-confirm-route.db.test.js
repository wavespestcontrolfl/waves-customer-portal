const SKIP = !process.env.DATABASE_URL;
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const { migrations } = require('./helpers/lawn-visit-db');

let mockKnex;
jest.mock('../models/db', () => mockKnex);
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_req, _res, next) => next(), requireTechOrAdmin: (_req, _res, next) => next() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/knowledge-bridge', () => ({ generateAssessmentRecommendations: jest.fn() }));
jest.mock('../services/lawn-intelligence', () => ({
  attachWeather: jest.fn(), recordTechCalibration: jest.fn(), emitHealthSignal: jest.fn(),
  sendAssessmentNotification: jest.fn(), generateServiceReport: jest.fn(), trackAssessmentCompletion: jest.fn(),
}));
jest.mock('../services/lawn-visit-delivery', () => ({ deliverConfirmedAssessment: jest.fn() }));
jest.mock('../services/agronomic-wiki', () => ({ linkTreatmentOutcome: jest.fn() }));
jest.mock('../services/photos', () => null);

const COMPLETE = { turf_density: 80, weed_suppression: 82, color_health: 76, fungus_control: 85, thatch_level: 90, stress_damage: 85 };
const UNKNOWN = Object.fromEntries(Object.keys(COMPLETE).map((key) => [key, null]));
const MODEL_TEXT = 'Nutsedge is visible near the front edge.';

(SKIP ? describe.skip : describe)('visit confirmation and reload routes (real PostgreSQL)', () => {
  let owned;
  let confirm;
  let reload;
  let runs;
  let copy;
  let delivery;
  let intel;
  let wiki;
  let scheduled;
  const oldVisitGate = process.env.GATE_LAWN_VISIT_ASSESSMENT;
  const oldHistoryGate = process.env.GATE_LAWN_PROPERTY_HISTORY;

  beforeAll(async () => {
    owned = await createLawnHistoryDb();
    mockKnex = owned.knex;
    await mockKnex.raw('CREATE TABLE ??.technicians (LIKE public.technicians INCLUDING ALL)', [owned.schema]);
    for (const migration of migrations) await migration.up(mockKnex);
    runs = require('../services/lawn-visit-runs');
    copy = require('../services/lawn-visit-customer-copy');
    delivery = require('../services/lawn-visit-delivery').deliverConfirmedAssessment;
    intel = require('../services/lawn-intelligence');
    wiki = require('../services/agronomic-wiki').linkTreatmentOutcome;
    confirm = require('../routes/admin-lawn-assessment').stack.find((layer) => layer.route?.path === '/confirm').route.stack[0].handle;
    reload = require('../routes/admin-lawn-assessment').stack.find((layer) => layer.route?.path === '/service/:serviceId').route.stack[0].handle;
  }, 60000);
  beforeEach(() => {
    process.env.GATE_LAWN_VISIT_ASSESSMENT = 'false';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'false';
    jest.clearAllMocks();
    scheduled = [];
    // Drain only this route's scheduled work; every external effect is stubbed.
    jest.spyOn(global, 'setImmediate').mockImplementation((work) => { scheduled.push(work); });
    delivery.mockResolvedValue({ done: [], gaps: [] });
    wiki.mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (oldVisitGate === undefined) delete process.env.GATE_LAWN_VISIT_ASSESSMENT; else process.env.GATE_LAWN_VISIT_ASSESSMENT = oldVisitGate;
    if (oldHistoryGate === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY; else process.env.GATE_LAWN_PROPERTY_HISTORY = oldHistoryGate;
    if (owned) await owned.dispose();
  });

  async function seed(scores = {}, { run = true, service = false } = {}) {
    const f = await fixture(mockKnex);
    const visit = service ? await f.visit() : null;
    const assessment = await f.assessment(visit, {
      ...UNKNOWN, ...scores, confirmed_by_tech: false, confirmed_at: null, is_baseline: false,
      observations: copy.NO_OBSERVATIONS,
      adjusted_scores: JSON.stringify({ ...UNKNOWN, ...scores, observations: copy.NO_OBSERVATIONS }),
    });
    if (run) await mockKnex('lawn_assessment_runs').insert({
      assessment_id: assessment.id, customer_id: f.customerId, status: 'complete',
      prompt_version: 'route-fixture', context_hash: 'c'.repeat(64),
      observations: MODEL_TEXT, scores_adjusted: JSON.stringify(COMPLETE),
      findings: JSON.stringify([{ finding_id: 'F1', name: 'Weed pressure', label: 'weed pressure', confidence: 'moderate', severity: 'moderate', urgency: 'monitor' }]),
      reconciliation: JSON.stringify({ published_observations: copy.NO_OBSERVATIONS, stress_damage_override: null }),
    });
    return { assessment, f, visit };
  }
  async function request(assessmentId, body = {}, technicianId = null) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await confirm({ body: { assessmentId, ...body }, technicianId }, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return { status: res.status.mock.calls[0]?.[0] || 200, body: res.json.mock.calls[0][0] };
  }
  const drain = async () => { for (const work of scheduled.splice(0)) await work(); };
  const read = (id) => mockKnex('lawn_assessments').where({ id }).first();

  async function reloadService(serviceId) {
    const res = { json: jest.fn() };
    const next = jest.fn();
    await reload({ params: { serviceId } }, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return JSON.parse(JSON.stringify(res.json.mock.calls[0][0]));
  }

  test('reopening a partial review restores decisions, stable IDs and unknown scores with the gate off', async () => {
    const { assessment, visit } = await seed({}, { service: true });
    const [photo] = await mockKnex('lawn_assessment_photos').insert({
      assessment_id: assessment.id, customer_id: assessment.customer_id,
      s3_key: 'fixture/review-photo.jpg', photo_order: 0,
    }).returning('*');
    await mockKnex('lawn_assessment_runs').where({ assessment_id: assessment.id }).update({
      raw_response: JSON.stringify({ private: 'provider payload' }),
      vision_context: JSON.stringify({ priorSummary: 'Internal prompt context' }), tokens_in: 123,
    });
    const saved = await request(assessment.id, {
      adjustedScores: { turf_density: 61 },
      reviewedFindings: [{ finding_id: 'F1', keep: false, tech_note: 'Not seen during inspection' }],
      addedDetails: [{ text: 'Nutsedge confirmed at the front edge', zone: 'front' }],
      observationEdit: 'Technician inspection summary',
    });
    const before = await runs.loadRun(assessment.id, mockKnex);
    const result = await reloadService(visit.id);
    expect(result.assessment).toMatchObject({ id: assessment.id, confirmed_by_tech: false, turf_density: 61, color_health: null, observations: 'Technician inspection summary', photo_records: [{ id: photo.id }] });
    expect(result.visitAssessment).toEqual(JSON.parse(JSON.stringify(saved.body.visitAssessment)));
    expect(result.visitAssessment).toMatchObject({ findings: [{ finding_id: 'F1' }], reviewedFindings: [{ finding_id: 'F1', keep: false, tech_note: 'Not seen during inspection' }], addedDetails: [{ finding_id: expect.any(String), zone: 'front' }] });
    for (const key of ['raw_response', 'vision_context', 'context_hash', 'tokens_in', 'failures']) {
      expect(result.visitAssessment).not.toHaveProperty(key);
    }
    expect(await runs.loadRun(assessment.id, mockKnex)).toEqual(before);
    expect(scheduled).toHaveLength(0);
    expect(delivery).not.toHaveBeenCalled();
  });

  test('reopening an unavailable run preserves its reason, photo quality and null scores', async () => {
    const { assessment, visit } = await seed({}, { service: true });
    await mockKnex('lawn_assessment_runs').where({ assessment_id: assessment.id }).update({
      status: 'unavailable', unavailable_reason: 'all_providers_failed', findings: '[]',
      photo_quality: JSON.stringify([{ photo: 1, quality: 'poor', issue: 'blur' }]),
    });
    expect(await reloadService(visit.id)).toMatchObject({
      assessment: { confirmed_by_tech: false, turf_density: null, color_health: null },
      visitAssessment: { status: 'unavailable', unavailableReason: 'all_providers_failed', findings: [], photoQuality: [{ photo: 1, quality: 'poor', issue: 'blur' }], reviewedFindings: null },
    });
  });

  test('the selected latest assessment cannot inherit an older assessment run from the same visit', async () => {
    const { assessment, f, visit } = await seed({}, { service: true });
    const newer = await f.assessment(visit, { created_at: new Date(new Date(assessment.created_at).getTime() + 1000) });
    const result = await reloadService(visit.id);
    expect(result.assessment.id).toBe(newer.id);
    expect(result.visitAssessment).toBeNull();
  });

  test.each([false, true])('legacy reload works when the optional run table is missing: %s', async (missingTable) => {
    const { assessment, visit } = await seed(COMPLETE, { service: true, run: false });
    if (missingTable) await mockKnex.schema.renameTable('lawn_assessment_runs', 'temporarily_missing_runs');
    try {
      expect(await reloadService(visit.id)).toMatchObject({ assessment: { id: assessment.id, turf_density: 80, photo_records: [] }, visitAssessment: null });
    } finally { if (missingTable) await mockKnex.schema.renameTable('temporarily_missing_runs', 'lawn_assessment_runs'); }
  });

  test('a visit without an assessment retains the empty response', async () => {
    const f = await fixture(mockKnex);
    const visit = await f.visit();
    expect(await reloadService(visit.id)).toEqual({ assessment: null });
  });

  test('unexpected run-store errors are surfaced instead of appearing to be a legacy assessment', async () => {
    const { visit } = await seed({}, { service: true });
    await mockKnex.schema.alterTable('lawn_assessment_runs', (table) => table.renameColumn('assessment_id', 'unavailable_assessment_id'));
    try {
      await expect(reloadService(visit.id)).rejects.toMatchObject({ code: '42703' });
    } finally {
      await mockKnex.schema.alterTable('lawn_assessment_runs', (table) => table.renameColumn('unavailable_assessment_id', 'assessment_id'));
    }
  });

  test('a stored run remains pending with the visit gate off and produces no delivery or wiki work', async () => {
    const { assessment } = await seed();
    const { body } = await request(assessment.id, { adjustedScores: { turf_density: 61 }, stress_flags: { drought_stress: true } });
    expect(body).toMatchObject({ success: true, confirmed: false, assessment: { turf_density: 61, color_health: null, confirmed_by_tech: false, overall_score: null, is_baseline: false, stress_flags: { drought_stress: true } } });
    expect(body.missingScores).toContain('color_health');
    expect(body.visitAssessment.reviewedAt).toBeNull();
    expect(body.visitAssessment).not.toHaveProperty('raw_response');
    expect(body.visitAssessment).not.toHaveProperty('context_hash');
    expect(scheduled).toHaveLength(0);
    expect(wiki).not.toHaveBeenCalled();
    expect(delivery).not.toHaveBeenCalled();
  });

  test('a following review withdraws generated text and ownership together before confirmation', async () => {
    const { assessment } = await seed();
    const first = await request(assessment.id, { addedDetails: [{ text: 'Nutsedge confirmed at the front edge' }] });
    expect(first.body.assessment.observations).toBe(MODEL_TEXT);
    const second = await request(assessment.id, { addedDetails: [], adjustedScores: { ...COMPLETE, observations: MODEL_TEXT } });
    expect(second.body).toMatchObject({ confirmed: true, missingScores: [], assessment: { observations: copy.NO_OBSERVATIONS, adjusted_scores: { observations: copy.NO_OBSERVATIONS } } });
    expect((await runs.loadRun(assessment.id, mockKnex)).reconciliation.published_observations).toBe(copy.NO_OBSERVATIONS);
    expect(delivery).not.toHaveBeenCalled();
    await drain();
    expect(delivery).toHaveBeenCalledWith({ assessmentId: assessment.id });
    expect(intel.sendAssessmentNotification).not.toHaveBeenCalled();
  });

  test.each([MODEL_TEXT, '', null])('an explicit observation edit clears ownership even for %s', async (observationEdit) => {
    const { assessment } = await seed();
    await request(assessment.id, { addedDetails: [{ text: 'Nutsedge confirmed at the front edge' }] });
    await request(assessment.id, { observationEdit });
    const result = await request(assessment.id, { addedDetails: [], adjustedScores: COMPLETE });
    expect(result.body.assessment.observations).toBe(observationEdit);
    expect(result.body.assessment.adjusted_scores.observations).toBe(observationEdit);
    expect((await runs.loadRun(assessment.id, mockKnex)).reconciliation.published_observations).toBeNull();
  });

  test('pending scores, real protocol checks and the turf profile commit together', async () => {
    const { assessment } = await seed();
    const { body } = await request(assessment.id, { adjustedScores: { color_health: 62 }, protocol_field_checks: { irrigation_inches_per_week: 1.25 } });
    expect(body).toMatchObject({ confirmed: false, assessment: { color_health: 62, protocol_field_checks: { irrigation_inches_per_week: 1.25 } } });
    const profile = await mockKnex('customer_turf_profiles').where({ customer_id: assessment.customer_id }).first();
    expect(Number(profile.irrigation_inches_per_week)).toBe(1.25);
    expect(profile.last_protocol_assessment_id).toBe(assessment.id);
  });

  test('a protocol profile failure rolls back scores, confirmation, review, text and baseline', async () => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
    const { assessment } = await seed({}, { service: true });
    const beforeRun = await runs.loadRun(assessment.id, mockKnex);
    await mockKnex.raw('ALTER TABLE customer_turf_profiles ADD CONSTRAINT reject_confirm CHECK (false) NOT VALID');
    try {
      await expect(request(assessment.id, { adjustedScores: COMPLETE, addedDetails: [{ text: 'Nutsedge confirmed at the front edge' }], protocol_field_checks: { irrigation_inches_per_week: 1 } })).rejects.toMatchObject({ code: '23514' });
      expect(await read(assessment.id)).toEqual(assessment);
      expect(await runs.loadRun(assessment.id, mockKnex)).toEqual(beforeRun);
      expect(scheduled).toHaveLength(0);
      expect(wiki).not.toHaveBeenCalled();
    } finally { await mockKnex.raw('ALTER TABLE customer_turf_profiles DROP CONSTRAINT reject_confirm'); }
  });

  test.each([
    { observationEdit: {} }, { stress_flags: { drought_stress: 'yes' } },
    { protocol_field_checks: { irrigation_status: 'invalid' } },
    { reviewedFindings: [{ finding_id: 'missing', keep: true }] },
  ])('invalid confirmation input writes nothing: %j', async (body) => {
    const { assessment } = await seed();
    expect((await request(assessment.id, body)).status).toBe(400);
    expect(await read(assessment.id)).toEqual(assessment);
    expect((await runs.loadRun(assessment.id, mockKnex)).reviewed_at).toBeNull();
    expect(scheduled).toHaveLength(0);
  });

  test.each([false, true])('a confirmed retry preserves the first snapshot while linking a service record (property history: %s)', async (propertyHistoryEnabled) => {
    process.env.GATE_LAWN_PROPERTY_HISTORY = String(propertyHistoryEnabled);
    const { assessment, f, visit } = await seed(COMPLETE, { service: true });
    const record = await f.record(visit);
    const [tech] = await mockKnex('technicians').insert({ name: 'Confirm fixture technician' }).returning('*');
    const first = await request(assessment.id, {}, tech.id);
    const originalRun = await runs.loadRun(assessment.id, mockKnex);
    expect(first.body).toMatchObject({ confirmed: true, assessment: { is_baseline: true, service_record_id: record.id } });
    const retry = await request(assessment.id, { adjustedScores: { turf_density: 1 }, observationEdit: 'Retry text', reviewedFindings: [{ finding_id: 'missing', keep: true }], protocol_field_checks: { irrigation_inches_per_week: 2 } });
    expect(retry.body.assessment).toEqual(first.body.assessment);
    expect(await runs.loadRun(assessment.id, mockKnex)).toEqual(originalRun);
    expect(originalRun.reconciliation.confirmation).toMatchObject({ technician_id: tech.id, final_scores: COMPLETE, ai_scores: COMPLETE });
    expect(wiki).toHaveBeenCalledWith(record.id);
    await drain();
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(intel.attachWeather).not.toHaveBeenCalled();
  });

  test('delivery rejection is logged after the committed response and can retry later', async () => {
    const { assessment } = await seed(COMPLETE);
    delivery.mockRejectedValueOnce(new Error('fixture delivery unavailable'));
    const first = await request(assessment.id);
    expect(first.body.confirmed).toBe(true);
    const originalRun = await runs.loadRun(assessment.id, mockKnex);
    expect(delivery).not.toHaveBeenCalled();
    await drain();
    expect((await read(assessment.id)).confirmed_by_tech).toBe(true);
    expect(require('../services/logger').error).toHaveBeenCalledWith(expect.stringContaining('Intelligence pipeline failed'));
    const retry = await request(assessment.id, { adjustedScores: { turf_density: 1 } });
    expect(retry.body.assessment).toEqual(first.body.assessment);
    expect(await runs.loadRun(assessment.id, mockKnex)).toEqual(originalRun);
    await drain();
    expect(delivery).toHaveBeenCalledTimes(2);
    expect(delivery).toHaveBeenLastCalledWith({ assessmentId: assessment.id });
    expect(require('../services/logger').error).toHaveBeenCalledTimes(1);
  });

  test.each([false, true])('legacy confirmation works when the optional run table is missing: %s', async (missingTable) => {
    const { assessment } = await seed(COMPLETE, { run: false });
    if (missingTable) await mockKnex.schema.renameTable('lawn_assessment_runs', 'temporarily_missing_runs');
    try {
      const result = await request(assessment.id, { adjustedScores: { turf_density: 72, observations: 'Technician legacy text' } });
      expect(result.body).toMatchObject({ success: true, assessment: { confirmed_by_tech: true, turf_density: 72, observations: 'Technician legacy text' } });
      expect(result.body).not.toHaveProperty('confirmed');
      await drain();
      expect(delivery).not.toHaveBeenCalled();
      expect(intel.sendAssessmentNotification).toHaveBeenCalledWith(assessment.id);
    } finally { if (missingTable) await mockKnex.schema.renameTable('temporarily_missing_runs', 'lawn_assessment_runs'); }
  });
});
