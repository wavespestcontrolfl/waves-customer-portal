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
  require('../models/migrations/20260908000020_lawn_assessment_runs_scores_adjusted'),
  require('../models/migrations/20260908000030_lawn_assessment_runs_pipeline'),
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
    for (const column of ['assessment_id', 'status', 'provider', 'fallback_used', 'failures', 'unavailable_reason', 'prompt_version', 'context_hash', 'photo_ids', 'findings', 'severities', 'scores_raw', 'scores_adjusted', 'raw_response', 'tokens_reasoning', 'latency_ms', 'reviewed_findings', 'added_details', 'reconciliation', 'reviewed_at', 'reviewed_by_technician_id']) {
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

  test('two first confirms for one customer serialize on the baseline lock: only the first becomes the legacy baseline', async () => {
    const { customerId, assessment } = await seed();
    const [later] = await db.knex('lawn_assessments').insert({ customer_id: customerId, service_date: '2026-09-09', turf_density: 70 }).returning('*');
    const run = { id: 'run' };
    const seen = [];
    const confirm = (row, tag, hold) => db.knex.transaction(async (trx) => {
      const fields = await visit.legacyBaselineFields({ assessment: row, run, confirmed: true, propertyHistoryEnabled: false }, trx);
      seen.push(`${tag}:${fields.is_baseline ? 'baseline' : 'none'}`);
      await hold;
      await trx('lawn_assessments').where({ id: row.id }).update({ ...fields, confirmed_by_tech: true });
    });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const first = confirm(assessment, 'first', held);
    while (!seen.length) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = confirm(later, 'second', Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The second confirm is waiting on the lock: it has not read yet.
    expect(seen).toEqual(['first:baseline']);
    release();
    await Promise.all([first, second]);
    expect(seen).toEqual(['first:baseline', 'second:none']);
    const baselines = await db.knex('lawn_assessments').where({ customer_id: customerId, is_baseline: true });
    expect(baselines.map((row) => row.id)).toEqual([assessment.id]);
  });

  test('claimConfirm is one-shot: two concurrent confirms of one row serialize on its lock and only the first may confirm', async () => {
    const { assessment } = await seed();
    const seen = [];
    const confirm = (tag, hold) => db.knex.transaction(async (trx) => {
      const claimed = await visit.claimConfirm(assessment.id, trx);
      seen.push(`${tag}:${!!claimed}`);
      await hold;
      if (claimed) await trx('lawn_assessments').where({ id: assessment.id }).update({ confirmed_by_tech: true, turf_density: 55 });
      return claimed;
    });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const first = confirm('first', held);
    while (!seen.length) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = confirm('second', Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen).toEqual(['first:true']); // the second is waiting on the row lock
    release();
    const [firstClaim, secondClaim] = await Promise.all([first, second]);
    // The claim is the LOCKED row — the confirm derives its update from it, never from a pre-lock snapshot.
    expect(firstClaim).toMatchObject({ id: assessment.id, confirmed_by_tech: false, turf_density: 72 });
    expect(secondClaim).toBeNull();
    expect(seen).toEqual(['first:true', 'second:false']);
    // A retry after the completing confirm sees the confirmed row: no claim, nothing to rewrite.
    expect(await db.knex.transaction((trx) => visit.claimConfirm(assessment.id, trx))).toBeNull();
    expect(await db.knex.transaction((trx) => visit.claimConfirm(randomUUID(), trx))).toBeNull();
  });

  test('claimConfirm hands back the row as it is under the lock: a partial confirm that committed while this one waited is what the next derivation reads', async () => {
    const { assessment } = await seed();
    const seen = [];
    const partial = (tag, hold, update) => db.knex.transaction(async (trx) => {
      const locked = await visit.claimConfirm(assessment.id, trx);
      seen.push(`${tag}:${locked?.turf_density ?? 'null'}:${locked?.color_health ?? 'null'}`);
      await hold;
      await trx('lawn_assessments').where({ id: assessment.id }).update(update); // still pending: confirmed_by_tech stays false
      return locked;
    });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const first = partial('first', held, { color_health: 80 });
    while (!seen.length) await new Promise((resolve) => setTimeout(resolve, 10));
    const second = partial('second', Promise.resolve(), { thatch_level: 60 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(seen).toEqual(['first:72:null']);
    release();
    await Promise.all([first, second]);
    // The second claim saw the first's saved score, so its own derivation merges instead of overwriting.
    expect(seen).toEqual(['first:72:null', 'second:72:80']);
    expect(await db.knex('lawn_assessments').where({ id: assessment.id }).first()).toMatchObject({ confirmed_by_tech: false, turf_density: 72, color_health: 80, thatch_level: 60 });
  });

  test('claimPipeline is a durable one-shot claim on the delivery: once per run, resumable only when stale and incomplete, complete blocks it for good', async () => {
    const { assessment } = await seed();
    await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [] }, db.knex);
    // Two concurrent claims: exactly one wins.
    expect(await Promise.all([visit.claimPipeline(assessment.id, db.knex), visit.claimPipeline(assessment.id, db.knex)])).toEqual(expect.arrayContaining([true, false]));
    expect(await visit.claimPipeline(assessment.id, db.knex)).toBe(false);
    // A stale, incomplete claim (the process died mid-delivery) is resumable.
    await db.knex('lawn_assessment_runs').where({ assessment_id: assessment.id }).update({ pipeline_claimed_at: new Date(Date.now() - visit.PIPELINE_STALE_MS - 1000) });
    expect(await visit.claimPipeline(assessment.id, db.knex)).toBe(true);
    // A completed delivery is never resumed, however old its claim.
    await visit.completePipeline(assessment.id, db.knex);
    await db.knex('lawn_assessment_runs').where({ assessment_id: assessment.id }).update({ pipeline_claimed_at: new Date(Date.now() - visit.PIPELINE_STALE_MS - 1000) });
    expect(await visit.claimPipeline(assessment.id, db.knex)).toBe(false);
    expect((await db.knex('lawn_assessment_runs').where({ assessment_id: assessment.id }).first()).pipeline_completed_at).not.toBeNull();
    // A row with no run has nothing to claim; a database without the columns delivers as before.
    expect(await visit.claimPipeline(randomUUID(), db.knex)).toBe(false);
    await migrations[2].down(db.knex);
    expect(await visit.claimPipeline(assessment.id, db.knex)).toBe(true);
    await expect(visit.completePipeline(assessment.id, db.knex)).resolves.toBeUndefined();
    await migrations[2].up(db.knex);
  });

  test('priorAssessmentCount against the real table: a pending run-backed row is not a prior assessment', async () => {
    const { customerId, assessment } = await seed(); // seed() inserts one unconfirmed row with no run
    expect(await visit.priorAssessmentCount(customerId, db.knex)).toBe(1);
    await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [] }, db.knex); // now pending + run-backed
    expect(await visit.priorAssessmentCount(customerId, db.knex)).toBe(0);
    await db.knex('lawn_assessments').where({ id: assessment.id }).update({ confirmed_by_tech: true });
    expect(await visit.priorAssessmentCount(customerId, db.knex)).toBe(1);
  });

  test('deleting the assessment cascades to its run', async () => {
    const { assessment } = await seed();
    await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [] }, db.knex);
    await db.knex('lawn_assessments').where({ id: assessment.id }).del();
    expect(await visit.loadRun(assessment.id, db.knex)).toBeUndefined();
  });
});
