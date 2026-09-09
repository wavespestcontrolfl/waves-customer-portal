// Real PostgreSQL: the lawn_assessment_runs migration and the run writers of
// services/lawn-visit-assessment.js, in a test-owned schema cloned from the
// dev database (same pattern as tests/helpers/lawn-history-db.js). Skipped
// without DATABASE_URL; CI runs it against the migrated CI database.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
// Every migration the run writers depend on, in order: the table, then the
// scores_adjusted column recordRun always writes (Codex #4149 r5 — the fixture
// applied only the first and CI's real-PostgreSQL run failed on the insert).
const migrations = [
  require('../models/migrations/20260908000010_lawn_assessment_runs'),
];

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ ...jest.requireActual('../services/llm/call'), dispatchWithFallback: jest.fn() }));
const visit = require('../services/lawn-visit-assessment');

async function createRunsDb() {
  const schema = `lawn_visit_${randomUUID().replace(/-/g, '')}`;
  const knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
  await knex.raw('CREATE SCHEMA ??', [schema]);
  for (const table of ['customers', 'technicians', 'scheduled_services', 'lawn_assessments', 'lawn_assessment_photos']) {
    await knex.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING ALL)', [schema, table, table]);
  }
  for (const step of migrations) await step.up(knex);
  return { knex, schema, async dispose() { await knex.raw('DROP SCHEMA ?? CASCADE', [schema]); await knex.destroy(); } };
}

const analysis = (overrides = {}) => ({
  status: 'complete', reason: null, provider: 'gemini', model: 'gemini-3.8-flash', fallbackUsed: false, failures: [],
  promptVersion: visit.PROMPT_VERSION, contextHash: 'a'.repeat(64), latencyMs: 812,
  photoQuality: [{ photo: 1, quality: 'adequate', issue: '' }],
  findings: [{ finding_id: 'F1', name: 'Irregular browning along the driveway edge', confidence: 'moderate', severity: 'moderate', urgency: 'follow_up', spread_risk: 'moderate', observed_evidence: ['x'], inferred_context: [], negative_evidence: [], confirmation_step: 'float test', customer_wording: 'w', photo_refs: [1], zone: 'front', label: 'thinning turf', source: 'model' }],
  severities: { fungal_activity: { level: 'minor', evidence: 'e', confidence: 'moderate' } },
  scores: { turf_density: 72, weed_coverage: 15, color_health: null },
  observations: 'obs', raw: { ok: true }, usage: { input_tokens: 9000, output_tokens: 4000, reasoning_tokens: 1500 },
  ...overrides,
});

(SKIP ? describe.skip : describe)('lawn_assessment_runs (real PostgreSQL)', () => {
  let db;
  beforeAll(async () => { db = await createRunsDb(); }, 60000);
  afterAll(async () => { if (db) await db.dispose(); });

  async function seed() {
    const customerId = randomUUID();
    await db.knex('customers').insert({ id: customerId, first_name: 'Run fixture', phone: `+1555${String(parseInt(customerId.slice(0, 6), 16) % 10000000).padStart(7, '0')}` });
    const [assessment] = await db.knex('lawn_assessments').insert({ customer_id: customerId, service_date: '2026-09-08', turf_density: 72 }).returning('*');
    const [photo] = await db.knex('lawn_assessment_photos').insert({ assessment_id: assessment.id, customer_id: customerId, s3_key: `pending/${assessment.id}/p1.jpg`, photo_order: 0 }).returning('*');
    return { customerId, assessment, photo };
  }

  test('the migration is idempotent and reversible; the table carries one run per assessment', async () => {
    expect(await db.knex.schema.hasTable('lawn_assessment_runs')).toBe(true);
    for (const step of migrations) await expect(step.up(db.knex)).resolves.toBeUndefined(); // hasTable / hasColumn guards
    const columns = await db.knex('lawn_assessment_runs').columnInfo();
    for (const column of ['assessment_id', 'status', 'provider', 'fallback_used', 'failures', 'unavailable_reason', 'prompt_version', 'context_hash', 'photo_ids', 'findings', 'severities', 'scores_raw', 'scores_adjusted', 'vision_context', 'technician_notes_present', 'raw_response', 'tokens_reasoning', 'latency_ms', 'reviewed_findings', 'added_details', 'reconciliation', 'reviewed_at', 'reviewed_by_technician_id']) {
      expect(columns[column]).toBeDefined();
    }
    expect(columns.assessment_id.nullable).toBe(false);
    expect(columns.status.nullable).toBe(false);
  });

  test('recordRun writes the provenance row; a second run for the same assessment is refused (UNIQUE)', async () => {
    const { customerId, assessment, photo } = await seed();
    const row = await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [photo] }, db.knex);
    expect(row).toMatchObject({ assessment_id: assessment.id, customer_id: customerId, service_id: null, status: 'complete', provider: 'gemini', requested_model: 'gemini-3.8-flash', fallback_used: false, prompt_version: visit.PROMPT_VERSION, tokens_in: 9000, tokens_reasoning: 1500, latency_ms: 812, reviewed_at: null });
    expect(row.photo_ids).toEqual([photo.id]);
    expect(row.findings[0].finding_id).toBe('F1');
    expect(row.scores_raw).toEqual({ turf_density: 72, weed_coverage: 15, color_health: null });
    expect(row.raw_response).toEqual({ ok: true });
    await expect(visit.recordRun({ assessment, analysis: analysis(), photoRecords: [] }, db.knex)).rejects.toThrow(/unique|duplicate/i);
    expect(await visit.loadRun(assessment.id, db.knex)).toMatchObject({ id: row.id });
    // The photo ids are attached after the photos are stored (the run itself is written with the assessment).
    const attached = await visit.attachRunPhotos(row.id, [photo.id, 'second'], db.knex);
    expect(attached.photo_ids).toEqual([photo.id, 'second']);
  });

  test('recordRun inside the assessment transaction: a failed run insert rolls the assessment back', async () => {
    const { customerId } = await seed();
    await expect(db.knex.transaction(async (trx) => {
      const [row] = await trx('lawn_assessments').insert({ customer_id: customerId, service_date: '2026-09-08', turf_density: 1 }).returning('*');
      await visit.recordRun({ assessment: row, analysis: analysis({ promptVersion: null }), photoRecords: [] }, trx); // NOT NULL violation
    })).rejects.toThrow();
    expect(await db.knex('lawn_assessments').where({ customer_id: customerId, turf_density: 1 }).first()).toBeUndefined();
  });

  test('loadRun reads "no run" from a database without the table (migration lag) and rethrows anything else', async () => {
    const schemaless = { ...db.knex };
    const missing = Object.assign(() => ({ where: () => ({ first: async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); } }) }), schemaless);
    expect(await visit.loadRun('x', missing)).toBeUndefined();
    const broken = () => ({ where: () => ({ first: async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); } }) });
    await expect(visit.loadRun('x', broken)).rejects.toThrow(/connection refused/);
  });

  test('an unavailable run records the reason with NULL provider, scores and raw output', async () => {
    const { assessment } = await seed();
    const row = await visit.recordRun({ assessment, analysis: analysis({ status: 'unavailable', reason: 'all_providers_failed', provider: null, model: null, failures: [{ provider: 'gemini', model: 'g', reason: 'gemini_503' }, { provider: 'openai', model: 'o', reason: 'openai_timeout' }], findings: [], severities: null, scores: null, raw: null, usage: null, observations: visit.UNAVAILABLE_OBSERVATIONS }), photoRecords: [] }, db.knex);
    expect(row).toMatchObject({ status: 'unavailable', unavailable_reason: 'all_providers_failed', provider: null, requested_model: null, severities: null, scores_raw: null, raw_response: null, tokens_in: null, observations: visit.UNAVAILABLE_OBSERVATIONS });
    expect(row.failures).toHaveLength(2);
    expect(row.findings).toEqual([]);
  });

  test('reviewRun stores the review, the reconciliation and who reviewed; re-reviewing overwrites', async () => {
    const { assessment, photo } = await seed();
    const run = await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [photo] }, db.knex);
    const { errors, review } = visit.validateReview({
      reviewedFindings: [{ finding_id: 'F1', name: 'weed pressure', tech_note: 'sedge' }],
      addedDetails: [{ text: 'Float test confirmed chinch bugs at the edge', zone: 'front' }],
      appliedProducts: [{ product_name: 'Bifen I/T', addresses_findings: ['T1'] }],
    }, run);
    expect(errors).toEqual([]);
    const reviewed = await visit.reviewRun({ run, review, technicianId: null }, db.knex);
    expect(reviewed.reviewed_at).toBeTruthy();
    expect(reviewed.reviewed_by_technician_id).toBeNull();
    expect(reviewed.reviewed_findings[0]).toMatchObject({ finding_id: 'F1', name: 'weed pressure', label: 'weed pressure', keep: true, tech_note: 'sedge' });
    expect(reviewed.added_details[0]).toMatchObject({ finding_id: 'T1', source: 'technician', confidence: 'moderate' });
    expect(reviewed.reconciliation.treatment_rationale[0]).toMatchObject({ product_name: 'Bifen I/T', addresses_findings: ['T1'] });
    expect(reviewed.reconciliation.flags.some((f) => f.type === 'untreated_condition' && f.finding_id === 'F1')).toBe(true);
    const again = await visit.reviewRun({ run, review: { reviewedFindings: [{ finding_id: 'F1', keep: false }], addedDetails: [], appliedProducts: [] }, technicianId: null }, db.knex);
    expect(again.reviewed_findings[0].keep).toBe(false);
    expect(again.reconciliation.flags).toEqual([]);
    expect(visit.responseForRun(again)).toMatchObject({ runId: run.id, status: 'complete', reviewedFindings: [expect.objectContaining({ keep: false })] });
  });

  test('deleting the assessment cascades to its run', async () => {
    const { assessment } = await seed();
    await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [] }, db.knex);
    await db.knex('lawn_assessments').where({ id: assessment.id }).del();
    expect(await visit.loadRun(assessment.id, db.knex)).toBeUndefined();
  });
});
