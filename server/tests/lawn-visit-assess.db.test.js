const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');
const { answer, finding, photo } = require('./helpers/lawn-visit-fixtures');

let mockKnex;
jest.mock('../models/db', () => mockKnex);
jest.mock('../middleware/admin-auth', () => ({ adminAuthenticate: (_req, _res, next) => next(), requireTechOrAdmin: (_req, _res, next) => next() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../services/knowledge-bridge', () => ({}));
jest.mock('../services/lawn-intelligence', () => ({ assessPhotoQuality: jest.fn() }));
jest.mock('../services/photos', () => null);
jest.mock('../services/customer-pricing-ai', () => ({ withTurfProfileFence: (knex, _id, work) => knex.transaction(work) }));
jest.mock('../services/lawn-grass-context', () => ({
  ...jest.requireActual('../services/lawn-grass-context'),
  loadCustomerGrassContext: jest.fn(async () => ({ grassTypeLabel: 'St. Augustine', trackKey: 'st_augustine' })),
}));
jest.mock('../services/lawn-protocol-operating-layer', () => ({ getProtocolWindowContext: jest.fn(), summarizeProtocolContext: jest.fn() }));
jest.mock('../services/service-report/application-conditions', () => ({ fetchRecentMinTempF: jest.fn(async () => null) }));

(SKIP ? describe.skip : describe)('visit assessment route and provenance (real PostgreSQL)', () => {
  let owned;
  let assess;
  let runs;
  let lawn;
  let dispatch;
  let quality;
  let protocol;
  const oldVisitGate = process.env.GATE_LAWN_VISIT_ASSESSMENT;
  const oldHistoryGate = process.env.GATE_LAWN_PROPERTY_HISTORY;
  const photos = [photo('YQ==', 'front'), photo('Yg==', 'back'), photo('Yw==')];
  const complete = (extra = {}) => ({
    ...answer({ grass_type: 'unknown', findings: [finding({ photo_refs: [1, 3] })] }),
    photo_quality: [{ photo: 1, quality: 'adequate', issue: '' }, { photo: 2, quality: 'poor', issue: 'blurred' }, { photo: 3, quality: 'limited', issue: 'glare' }],
    ...extra,
  });

  beforeAll(async () => {
    owned = await createLawnVisitDb();
    mockKnex = owned.knex;
    for (const table of ['property_preferences', 'customer_turf_profiles']) {
      await mockKnex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [owned.schema, table, table]);
    }
    // Imports capture this test-owned database, never the application pool.
    lawn = require('../services/lawn-assessment');
    jest.spyOn(lawn, 'assessInsertFields').mockResolvedValue({});
    jest.spyOn(lawn, 'analyzePhoto');
    runs = require('../services/lawn-visit-runs');
    dispatch = require('../services/llm/call').dispatchWithFallback;
    quality = require('../services/lawn-intelligence').assessPhotoQuality;
    protocol = require('../services/lawn-protocol-operating-layer').getProtocolWindowContext;
    assess = require('../routes/admin-lawn-assessment').stack.find((layer) => layer.route?.path === '/assess').route.stack[0].handle;
  }, 60000);
  beforeEach(() => {
    process.env.GATE_LAWN_VISIT_ASSESSMENT = 'true';
    process.env.GATE_LAWN_PROPERTY_HISTORY = 'false';
    jest.clearAllMocks();
    dispatch.mockResolvedValue({ ok: true, json: complete(), provider: 'gemini', model: 'fixture-model', usage: {}, failures: [] });
    quality.mockResolvedValue({ passed: true, issues: [] });
    protocol.mockResolvedValue(null);
    lawn.analyzePhoto.mockResolvedValue({ composite: { turf_density: 70, weed_coverage: 10, color_health: 7, fungal_activity: 'none', thatch_visibility: 'low', grass_type: null }, divergenceFlags: [] });
  });
  afterAll(async () => {
    if (oldVisitGate === undefined) delete process.env.GATE_LAWN_VISIT_ASSESSMENT; else process.env.GATE_LAWN_VISIT_ASSESSMENT = oldVisitGate;
    if (oldHistoryGate === undefined) delete process.env.GATE_LAWN_PROPERTY_HISTORY; else process.env.GATE_LAWN_PROPERTY_HISTORY = oldHistoryGate;
    jest.restoreAllMocks();
    if (owned) await owned.dispose();
  });

  async function customer(knex = mockKnex) {
    const id = randomUUID();
    await knex('customers').insert({ id, first_name: 'Assess fixture', phone: `+1555${String(parseInt(id.slice(0, 6), 16) % 10000000).padStart(7, '0')}` });
    return id;
  }
  async function request(body) {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    const next = jest.fn();
    await assess({ body, technicianId: null }, res, next);
    if (next.mock.calls.length) throw next.mock.calls[0][0];
    return { status: res.status.mock.calls[0]?.[0] || 200, body: res.json.mock.calls[0][0] };
  }

  test('one visit call persists unknown scores, owned text, and index-aligned photo evidence', async () => {
    const customerId = await customer();
    const { body } = await request({ customerId, photos, technicianNotes: 'Private fixture note' });
    expect(require('../services/logger').error).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(quality).not.toHaveBeenCalled();
    expect(lawn.analyzePhoto).not.toHaveBeenCalled();
    expect(protocol).not.toHaveBeenCalled();
    const run = await runs.loadRun(body.assessment.id, mockKnex);
    const stored = await mockKnex('lawn_assessments').where({ id: body.assessment.id }).first();
    const photoRows = await mockKnex('lawn_assessment_photos').where({ assessment_id: stored.id }).orderBy('photo_order');
    expect(body).toMatchObject({ success: true, aiAvailable: true, isBaseline: false, analyzedCount: 3, photosStored: 3 });
    expect(stored).toMatchObject({ is_baseline: false, confirmed_by_tech: false, color_health: null, overall_score: null });
    expect(run).toMatchObject({ assessment_id: stored.id, status: 'complete', photo_ids: photoRows.map((row) => row.id), technician_notes_present: true });
    expect(run.reconciliation.published_observations).toBe(stored.observations);
    expect(body.visitAssessment).toEqual(runs.responseForRun(run));
    expect(body.visitAssessment).not.toHaveProperty('raw_response');
    expect(body.visitAssessment).not.toHaveProperty('vision_context');
    expect(photoRows.map((row) => row.photo_type)).toEqual(['front_yard', 'back_yard', 'general']);
    expect(photoRows.map((row) => row.zone)).toEqual(['front', 'back', null]);
    expect(photoRows.map((row) => row.customer_visible)).toEqual([true, false, true]);
    expect(photoRows.map((row) => row.is_best_photo)).toEqual([true, false, false]);
  });

  test('provider exhaustion stores a pending unavailable assessment with no healthy defaults', async () => {
    dispatch.mockResolvedValue({ ok: false, reason: 'all_providers_failed', failures: [{ provider: 'gemini', reason: 'timeout' }] });
    const { body } = await request({ customerId: await customer(), photos });
    expect(body).toMatchObject({ success: true, aiAvailable: false, overallScore: null, bestPhotoId: null, visitAssessment: { status: 'unavailable' } });
    for (const key of ['turf_density', 'weed_suppression', 'color_health', 'fungus_control', 'thatch_level', 'stress_damage']) expect(body.assessment[key]).toBeNull();
    expect((await mockKnex('lawn_assessment_photos').where({ assessment_id: body.assessment.id })).every((row) => !row.customer_visible)).toBe(true);
  });

  test('all-poor photos return the retake hold without writing an assessment or run', async () => {
    dispatch.mockResolvedValue({ ok: true, json: complete({ photo_quality: photos.map((_, index) => ({ photo: index + 1, quality: 'poor', issue: 'blurred' })) }) });
    const customerId = await customer();
    expect((await request({ customerId, photos })).body.success).toBe(false);
    expect(await mockKnex('lawn_assessments').where({ customer_id: customerId })).toEqual([]);
    expect(await mockKnex('lawn_assessment_runs').where({ customer_id: customerId })).toEqual([]);
  });

  test('bad photos and a service owned by another customer fail before paid analysis', async () => {
    const customerId = await customer();
    expect((await request({ customerId, photos: [photo('YQ==', 'garage')] })).status).toBe(400);
    const [service] = await mockKnex('scheduled_services').insert({ customer_id: await customer(), scheduled_date: '2026-06-08', service_type: 'lawn' }).returning('*');
    expect((await request({ customerId, photos, serviceId: service.id })).status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a run insert failure rolls back the assessment instead of leaving a legacy fallback row', async () => {
    const customerId = await customer();
    await mockKnex.raw('ALTER TABLE lawn_assessment_runs ADD CONSTRAINT fail_run_insert CHECK (false) NOT VALID');
    try {
      await expect(request({ customerId, photos })).rejects.toMatchObject({ code: '23514' });
      expect(await mockKnex('lawn_assessments').where({ customer_id: customerId })).toEqual([]);
      expect(await mockKnex('lawn_assessment_photos').where({ customer_id: customerId })).toEqual([]);
    } finally { await mockKnex.raw('ALTER TABLE lawn_assessment_runs DROP CONSTRAINT fail_run_insert'); }
  });

  test('a failed photo row leaves its prompt-position gap in the persisted run', async () => {
    await mockKnex.raw('ALTER TABLE lawn_assessment_photos ADD CONSTRAINT skip_middle_photo CHECK (photo_order <> 1) NOT VALID');
    try {
      const { body } = await request({ customerId: await customer(), photos });
      const run = await runs.loadRun(body.assessment.id, mockKnex);
      const rows = await mockKnex('lawn_assessment_photos').where({ assessment_id: body.assessment.id }).orderBy('photo_order');
      expect(run.photo_ids).toEqual([rows[0].id, null, rows[1].id]);
    } finally { await mockKnex.raw('ALTER TABLE lawn_assessment_photos DROP CONSTRAINT skip_middle_photo'); }
  });

  test('turning the visit gate off restores per-photo calls and ignores a pending run for the legacy baseline', async () => {
    const customerId = await customer();
    await request({ customerId, photos });
    expect(await runs.priorAssessmentCount(customerId, mockKnex)).toBe(0);
    process.env.GATE_LAWN_VISIT_ASSESSMENT = 'false';
    jest.clearAllMocks();
    const { body } = await request({ customerId, photos });
    expect(body.isBaseline).toBe(true);
    expect(body).not.toHaveProperty('visitAssessment');
    expect(dispatch).not.toHaveBeenCalled();
    expect(quality).toHaveBeenCalledTimes(3);
    expect(lawn.analyzePhoto).toHaveBeenCalledTimes(3);
    expect(await runs.loadRun(body.assessment.id, mockKnex)).toBeUndefined();
    expect(await runs.priorAssessmentCount(customerId, mockKnex)).toBe(1);
    await mockKnex('lawn_assessments').where({ customer_id: customerId }).update({ confirmed_by_tech: true });
    expect(await runs.priorAssessmentCount(customerId, mockKnex)).toBe(2);
  });

  test('the optional run table read leaves a caller transaction usable during migration lag', async () => {
    const legacy = await createLawnVisitDb(false);
    try {
      const customerId = await customer(legacy.knex);
      await legacy.knex.transaction(async (trx) => {
        await trx('lawn_assessments').insert({ customer_id: customerId, service_date: '2026-06-08' });
        expect(await runs.priorAssessmentCount(customerId, trx)).toBe(1);
        await trx('lawn_assessments').where({ customer_id: customerId }).update({ observations: 'Committed after missing run table' });
      });
      expect((await legacy.knex('lawn_assessments').where({ customer_id: customerId }).first()).observations).toBe('Committed after missing run table');
    } finally { await legacy.dispose(); }
  });

  test('concurrent legacy replacements install only one baseline after a pending visit run', async () => {
    const customerId = await customer();
    await request({ customerId, photos });
    process.env.GATE_LAWN_VISIT_ASSESSMENT = 'false';
    await Promise.all([request({ customerId, photos }), request({ customerId, photos })]);
    expect(await mockKnex('lawn_assessments').where({ customer_id: customerId, is_baseline: true })).toHaveLength(1);
  });

  test('an unrelated schema error is propagated without aborting the outer transaction', async () => {
    const customerId = await customer();
    const rollback = new Error('restore fixture column');
    await expect(mockKnex.transaction(async (trx) => {
      await trx.raw('ALTER TABLE lawn_assessment_runs RENAME COLUMN assessment_id TO missing_assessment_id');
      await expect(runs.priorAssessmentCount(customerId, trx)).rejects.toMatchObject({ code: '42703' });
      expect((await trx('customers').where({ id: customerId }).first()).id).toBe(customerId);
      throw rollback;
    })).rejects.toBe(rollback);
  });
});
