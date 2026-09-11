const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');
const { createLawnVisitDb } = require('./helpers/lawn-visit-db');
const { reviewRun, loadRun } = require('../services/lawn-visit-runs');
const { NO_OBSERVATIONS } = require('../services/lawn-visit-customer-copy');
const { etDateString } = require('../utils/datetime-et');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const MODEL_TEXT = 'Nutsedge is visible near the front edge.';
const finding = (finding_id) => ({ finding_id, name: 'Weed pressure', label: 'weed pressure', confidence: 'moderate', severity: 'moderate', urgency: 'monitor' });

(SKIP ? describe.skip : describe)('atomic lawn review publication (real PostgreSQL)', () => {
  let db;
  beforeAll(async () => { db = await createLawnVisitDb(); }, 60000);
  afterAll(async () => { if (db) await db.dispose(); });

  async function seed(reconciliation = { published_observations: NO_OBSERVATIONS, stress_damage_override: 63 }) {
    const customerId = randomUUID();
    await db.knex('customers').insert({ id: customerId, first_name: 'Review fixture', phone: `+1555${String(parseInt(customerId.slice(0, 6), 16) % 10000000).padStart(7, '0')}` });
    const [assessment] = await db.knex('lawn_assessments').insert({ customer_id: customerId, service_date: etDateString(), observations: NO_OBSERVATIONS }).returning('*');
    const [run] = await db.knex('lawn_assessment_runs').insert({
      assessment_id: assessment.id, customer_id: customerId, status: 'complete',
      prompt_version: 'review-fixture', context_hash: 'a'.repeat(64),
      observations: MODEL_TEXT, findings: JSON.stringify([finding('F1'), finding('F2')]),
      reconciliation: JSON.stringify(reconciliation),
    }).returning('*');
    return { assessment, run };
  }

  const addSpecies = (assessmentId, extra = {}, knex = db.knex) => reviewRun({ assessmentId, review: { addedDetails: [{ text: 'Nutsedge confirmed at the front edge' }] }, ...extra }, knex);
  const readAssessment = (id) => db.knex('lawn_assessments').where({ id }).first();

  test('adding then removing the supporting detail updates both text and ownership across partial reviews', async () => {
    const { assessment } = await seed();
    const first = await addSpecies(assessment.id);
    expect(first.assessment.observations).toBe(MODEL_TEXT);
    expect(first.run.reconciliation).toMatchObject({ published_observations: MODEL_TEXT, stress_damage_override: 63, technician_finding_high_water: 1 });
    const second = await reviewRun({ assessmentId: assessment.id, review: { addedDetails: [] } }, db.knex);
    expect(second.assessment.observations).toBe(NO_OBSERVATIONS);
    expect(second.run.reconciliation).toMatchObject({ published_observations: NO_OBSERVATIONS, stress_damage_override: 63, technician_finding_high_water: 1 });
    expect((await readAssessment(assessment.id)).observations).toBe(NO_OBSERVATIONS);
    expect((await loadRun(assessment.id, db.knex)).added_details).toEqual([]);
  });

  test.each(['Technician-authored text', MODEL_TEXT, NO_OBSERVATIONS, '', null])(
    'explicit text edits clear ownership even for identical generated text: %s', async (observationEdit) => {
      const { assessment } = await seed();
      await addSpecies(assessment.id);
      const edited = await reviewRun({ assessmentId: assessment.id, observationEdit }, db.knex);
      expect(edited.assessment.observations).toBe(observationEdit);
      expect(edited.run.reconciliation.published_observations).toBeNull();
      const removed = await reviewRun({ assessmentId: assessment.id, review: { addedDetails: [] } }, db.knex);
      const restored = await addSpecies(assessment.id);
      for (const result of [removed, restored]) {
        expect(result.assessment.observations).toBe(observationEdit);
        expect(result.run.reconciliation.published_observations).toBeNull();
      }
    },
  );

  test('a text edit in the same request as the review wins and does not claim generated ownership', async () => {
    const { assessment } = await seed();
    const result = await addSpecies(assessment.id, { observationEdit: 'Technician summary' });
    expect(result.assessment.observations).toBe('Technician summary');
    expect(result.run.reviewed_at).toBeInstanceOf(Date);
    expect(result.run.reconciliation.published_observations).toBeNull();
  });

  test('missing provenance and edits by another writer never acquire publication ownership', async () => {
    const missing = await seed({});
    const mismatched = await seed();
    await db.knex('lawn_assessments').where({ id: mismatched.assessment.id }).update({ observations: 'Edited through another path' });
    for (const { assessment } of [missing, mismatched]) {
      const current = await readAssessment(assessment.id);
      const result = await addSpecies(assessment.id);
      expect(result.assessment.observations).toBe(current.observations);
      expect(result.run.reconciliation.published_observations).toBeNull();
    }
  });

  test('text and score-only saves leave review stamps untouched and preserve or clear the stress override explicitly', async () => {
    const { assessment, run } = await seed();
    expect((await reviewRun({ assessmentId: assessment.id }, db.knex)).run).toEqual(run);
    const textOnly = await reviewRun({ assessmentId: assessment.id, observationEdit: NO_OBSERVATIONS, stressOverride: 77 }, db.knex);
    expect(textOnly.run).toMatchObject({ reviewed_at: null, reviewed_by_technician_id: null, reviewed_findings: null });
    const reviewed = await addSpecies(assessment.id);
    expect(reviewed.run.reconciliation.stress_damage_override).toBe(77);
    const cleared = await reviewRun({ assessmentId: assessment.id, stressOverride: null }, db.knex);
    expect(cleared.run.reconciliation.stress_damage_override).toBeNull();
    expect(cleared.run.reviewed_at).toEqual(reviewed.run.reviewed_at);
  });

  test('invalid review, missing rows and invalid edits fail without a partial write', async () => {
    const { assessment, run } = await seed();
    await expect(reviewRun({ assessmentId: assessment.id, observationEdit: 'Must not save', review: { reviewedFindings: [{ finding_id: 'foreign' }] } }, db.knex)).rejects.toMatchObject({ status: 400 });
    await expect(reviewRun({ assessmentId: assessment.id, observationEdit: {} }, db.knex)).rejects.toThrow(TypeError);
    await expect(reviewRun({ assessmentId: assessment.id, stressOverride: NaN }, db.knex)).rejects.toThrow(TypeError);
    await expect(reviewRun({ assessmentId: randomUUID() }, db.knex)).rejects.toMatchObject({ status: 404 });
    expect(await loadRun(assessment.id, db.knex)).toEqual(run);
    expect(await readAssessment(assessment.id)).toEqual(assessment);
    await db.knex('lawn_assessment_runs').where({ id: run.id }).del();
    await expect(addSpecies(assessment.id)).rejects.toMatchObject({ status: 409 });
    expect(await readAssessment(assessment.id)).toEqual(assessment);
  });

  test('a failed assessment text write rolls back the earlier run update and leaves the caller transaction usable', async () => {
    const { assessment, run } = await seed();
    const rollback = new Error('restore fixture constraint');
    await expect(db.knex.transaction(async (trx) => {
      await trx.raw('ALTER TABLE lawn_assessments ADD CONSTRAINT review_text_failure CHECK (observations IS NULL) NOT VALID');
      await expect(addSpecies(assessment.id, {}, trx)).rejects.toMatchObject({ code: '23514' });
      expect(await loadRun(assessment.id, trx)).toEqual(run);
      expect((await trx('lawn_assessments').where({ id: assessment.id }).first()).observations).toBe(NO_OBSERVATIONS);
      throw rollback;
    })).rejects.toBe(rollback);
  });

  test('a later failure in the outer confirmation transaction rolls both rows back', async () => {
    const { assessment, run } = await seed();
    const rollback = new Error('confirmation failed after review');
    await expect(db.knex.transaction(async (trx) => {
      await addSpecies(assessment.id, {}, trx);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await loadRun(assessment.id, db.knex)).toEqual(run);
    expect(await readAssessment(assessment.id)).toEqual(assessment);
  });

  test('overlapping partial reviews retain both decisions after waiting for the assessment lock', async () => {
    const { assessment } = await seed();
    const first = await db.knex.transaction();
    const secondConnection = await db.knex.transaction();
    const { rows: [{ pid }] } = await secondConnection.raw('SELECT pg_backend_pid() AS pid');
    let second;
    try {
      await reviewRun({ assessmentId: assessment.id, review: { reviewedFindings: [{ finding_id: 'F1', keep: false }] } }, first);
      second = reviewRun({ assessmentId: assessment.id, review: { reviewedFindings: [{ finding_id: 'F2', name: 'general lawn stress' }] } }, secondConnection);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const { rows: [{ blockers }] } = await db.knex.raw('SELECT cardinality(pg_blocking_pids(?)) AS blockers', [pid]);
        blocked = blockers > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await first.commit();
      const result = await second;
      await secondConnection.commit();
      expect(result.run.reviewed_findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ finding_id: 'F1', keep: false }),
        expect.objectContaining({ finding_id: 'F2', name: 'general lawn stress', renamed: true }),
      ]));
    } finally {
      if (!first.isCompleted()) await first.rollback();
      if (second) await second;
      if (!secondConnection.isCompleted()) await secondConnection.rollback();
    }
  });
});
