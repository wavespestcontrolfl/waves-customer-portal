// Real PostgreSQL: the lawn_assessment_runs migration and the run writers of
// services/lawn-visit-runs.js, in a test-owned schema cloned from the
// dev database (same pattern as tests/helpers/lawn-history-db.js). Skipped
// without DATABASE_URL; CI runs it against the migrated CI database.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const { createLawnVisitDb, migrations, promptContextMigration } = require('./helpers/lawn-visit-db');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
const visit = require('../services/lawn-visit-runs');
const { PROMPT_VERSION } = require('../services/lawn-visit-input');
const { UNAVAILABLE_OBSERVATIONS } = require('../services/lawn-visit-result');
const { NO_OBSERVATIONS } = require('../services/lawn-visit-customer-copy');


const analysis = (overrides = {}) => ({
  status: 'complete', reason: null, provider: 'gemini', model: 'gemini-3.8-flash', fallbackUsed: false, failures: [],
  promptVersion: PROMPT_VERSION, contextHash: 'a'.repeat(64), latencyMs: 812, visionContext: { season: 'peak', month: 9 }, technicianNotesPresent: false,
  photoQuality: [{ photo: 1, quality: 'adequate', issue: '' }],
  findings: [{ finding_id: 'F1', name: 'Irregular browning along the driveway edge', confidence: 'moderate', severity: 'moderate', urgency: 'follow_up', spread_risk: 'moderate', observed_evidence: ['x'], inferred_context: [], negative_evidence: [], confirmation_step: 'float test', customer_wording: 'w', photo_refs: [1], zone: 'front', label: 'thinning turf', source: 'model' }],
  severities: { fungal_activity: { level: 'minor', evidence: 'e', confidence: 'moderate' } },
  scores: { turf_density: 72, weed_coverage: 15, color_health: null },
  observations: 'obs', raw: { ok: true }, usage: { input_tokens: 9000, output_tokens: 4000, reasoning_tokens: 1500 },
  ...overrides,
});

(SKIP ? describe.skip : describe)('lawn_assessment_runs (real PostgreSQL)', () => {
  let db;
  beforeAll(async () => { db = await createLawnVisitDb(); }, 60000);
  afterAll(async () => { if (db) await db.dispose(); });

  async function seed() {
    const customerId = randomUUID();
    await db.knex('customers').insert({ id: customerId, first_name: 'Run fixture', phone: `+1555${String(parseInt(customerId.slice(0, 6), 16) % 10000000).padStart(7, '0')}` });
    const [assessment] = await db.knex('lawn_assessments').insert({ customer_id: customerId, service_date: '2026-09-08', turf_density: 72, observations: NO_OBSERVATIONS }).returning('*');
    const [photo] = await db.knex('lawn_assessment_photos').insert({ assessment_id: assessment.id, customer_id: customerId, s3_key: `pending/${assessment.id}/p1.jpg`, photo_order: 0 }).returning('*');
    return { customerId, assessment, photo };
  }

  test('published migrations run up/down/up inside a transaction and leave no schema after rollback', async () => {
    const isolated = await createLawnVisitDb(false);
    const rollback = new Error('intentional migration dry-run rollback');
    try {
      await expect(isolated.knex.transaction(async (trx) => {
        for (const step of migrations) await step.up(trx);
        expect(await trx.schema.hasColumn('lawn_assessment_runs', 'vision_context')).toBe(true);
        for (const step of [...migrations].reverse()) await step.down(trx);
        expect(await trx.schema.hasTable('lawn_assessment_runs')).toBe(false);
        for (const step of migrations) await step.up(trx);
        expect(await trx.schema.hasColumn('lawn_assessment_runs', 'scores_adjusted')).toBe(true);
        throw rollback;
      })).rejects.toBe(rollback);
      expect(await isolated.knex.schema.hasTable('lawn_assessment_runs')).toBe(false);
    } finally {
      await isolated.dispose();
    }
  });

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

  test('prompt-context migration upgrades published schemas without rewriting old runs and rolls back only its own columns', async () => {
    const { customerId, assessment } = await seed();
    await promptContextMigration.down(db.knex);
    try {
      const [run] = await db.knex('lawn_assessment_runs').insert({
        assessment_id: assessment.id, customer_id: customerId, status: 'complete',
        prompt_version: 'legacy-test', context_hash: 'a'.repeat(64),
        scores_adjusted: JSON.stringify({ turf_density: 72 }),
      }).returning('*');
      await promptContextMigration.up(db.knex);
      expect(await visit.loadRun(assessment.id, db.knex)).toMatchObject({
        id: run.id, scores_adjusted: { turf_density: 72 }, vision_context: null, technician_notes_present: false,
      });
      const snapshot = { grassType: 'Zoysia', turfHeightIn: 3 };
      await db.knex('lawn_assessment_runs').where({ id: run.id }).update({ vision_context: JSON.stringify(snapshot), technician_notes_present: true });
      await promptContextMigration.up(db.knex);
      expect(await visit.loadRun(assessment.id, db.knex)).toMatchObject({ vision_context: snapshot, technician_notes_present: true });
      await promptContextMigration.down(db.knex);
      await promptContextMigration.down(db.knex);
      const rolledBack = await visit.loadRun(assessment.id, db.knex);
      expect(rolledBack).toMatchObject({ id: run.id, scores_adjusted: { turf_density: 72 } });
      expect(rolledBack).not.toHaveProperty('vision_context');
      expect(rolledBack).not.toHaveProperty('technician_notes_present');
    } finally {
      await promptContextMigration.up(db.knex);
    }
  });

  test('recordRun writes the provenance row; a second run for the same assessment is refused (UNIQUE)', async () => {
    const { customerId, assessment, photo } = await seed();
    const row = await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [photo] }, db.knex);
    expect(row).toMatchObject({ assessment_id: assessment.id, customer_id: customerId, service_id: null, status: 'complete', provider: 'gemini', requested_model: 'gemini-3.8-flash', fallback_used: false, prompt_version: PROMPT_VERSION, tokens_in: 9000, tokens_reasoning: 1500, latency_ms: 812, reviewed_at: null });
    expect(row.photo_ids).toEqual([photo.id]);
    expect(row.findings[0].finding_id).toBe('F1');
    expect(row.scores_raw).toEqual({ turf_density: 72, weed_coverage: 15, color_health: null });
    expect(row.raw_response).toEqual({ ok: true });
    expect(row.vision_context).toEqual({ season: 'peak', month: 9 });
    expect(row.reconciliation).toEqual({ published_observations: NO_OBSERVATIONS, stress_damage_override: null });
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

  test('missing-table migration lag does not abort an enclosing transaction; other database errors propagate', async () => {
    const rollback = new Error('restore table after migration-lag probe');
    await expect(db.knex.transaction(async (trx) => {
      await trx.schema.renameTable('lawn_assessment_runs', 'lawn_assessment_runs_hidden');
      expect(await visit.loadRun(randomUUID(), trx)).toBeUndefined();
      expect((await trx.raw('SELECT 1 AS healthy')).rows[0].healthy).toBe(1);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await db.knex.schema.hasTable('lawn_assessment_runs')).toBe(true);
    await expect(visit.loadRun('not-a-uuid', db.knex)).rejects.toMatchObject({ code: '22P02' });
  });

  test('stores immutable adjusted scores and note-free context while accounting for rejected billed answers', async () => {
    const { assessment } = await seed();
    const row = await visit.recordRun({
      assessment,
      analysis: analysis({
        visionContext: { month: 9, technicianNotes: 'Li left a spare key.', productsApplied: ['not perception'] },
        technicianNotesPresent: true,
        failures: [{ provider: 'gemini', reason: 'empty_findings', usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 20 } }],
      }),
      adjustedScores: { turf_density: 77, color_health: null, observations: 'excluded text' },
    }, db.knex);
    expect(row).toMatchObject({ tokens_in: 9100, tokens_out: 4050, tokens_reasoning: 1520, technician_notes_present: true });
    expect(row.vision_context).toEqual({ month: 9 });
    expect(row.scores_adjusted).toEqual({ turf_density: 77, color_health: null, weed_suppression: null, fungus_control: null, thatch_level: null, stress_damage: null });
    await db.knex('lawn_assessments').where({ id: assessment.id }).update({ turf_density: 95 });
    expect((await visit.loadRun(assessment.id, db.knex)).scores_adjusted.turf_density).toBe(77);
    expect(visit.replayContextForRun(row)).toMatchObject({ exactInputEligible: false, omitted: [{ field: 'technicianNotes', reason: 'intentionally_not_stored' }] });
  });

  test('an unavailable run records the reason with NULL provider, scores and raw output', async () => {
    const { assessment } = await seed();
    const row = await visit.recordRun({ assessment, analysis: analysis({ status: 'unavailable', reason: 'all_providers_failed', provider: null, model: null, failures: [{ provider: 'gemini', model: 'g', reason: 'gemini_503' }, { provider: 'openai', model: 'o', reason: 'openai_timeout' }], findings: [], severities: null, scores: null, raw: null, usage: null, observations: UNAVAILABLE_OBSERVATIONS }), photoRecords: [] }, db.knex);
    expect(row).toMatchObject({ status: 'unavailable', unavailable_reason: 'all_providers_failed', provider: null, requested_model: null, severities: null, scores_raw: null, raw_response: null, tokens_in: null, observations: UNAVAILABLE_OBSERVATIONS });
    expect(row.failures).toHaveLength(2);
    expect(row.findings).toEqual([]);
  });

  test('deleting the assessment cascades to its run', async () => {
    const { assessment } = await seed();
    await visit.recordRun({ assessment, analysis: analysis(), photoRecords: [] }, db.knex);
    await db.knex('lawn_assessments').where({ id: assessment.id }).del();
    expect(await visit.loadRun(assessment.id, db.knex)).toBeUndefined();
  });
});
