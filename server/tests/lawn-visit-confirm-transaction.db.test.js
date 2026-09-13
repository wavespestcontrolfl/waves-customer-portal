const SKIP = !process.env.DATABASE_URL;
const { createLawnHistoryDb, fixture } = require('./helpers/lawn-history-db');
const { migrations } = require('./helpers/lawn-visit-db');
const { confirmRun, loadRun } = require('../services/lawn-visit-runs');
const { NO_OBSERVATIONS } = require('../services/lawn-visit-customer-copy');

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const COMPLETE = { turf_density: 80, weed_suppression: 82, color_health: 76, fungus_control: 85, thatch_level: 90, stress_damage: 85 };
const UNKNOWN = Object.fromEntries(Object.keys(COMPLETE).map((key) => [key, null]));
const MODEL_TEXT = 'Nutsedge is visible near the front edge.';
const SCORING = {
  scoreValue: (value) => Math.max(0, Math.min(100, Math.round(Number(value)))),
  calculateOverallScore: (s) => Math.round(s.turf_density * 0.3 + s.weed_suppression * 0.25 + s.color_health * 0.25 + s.stress_damage * 0.2),
};

(SKIP ? describe.skip : describe)('run confirmation transaction (real PostgreSQL)', () => {
  let db;
  beforeAll(async () => {
    db = await createLawnHistoryDb();
    await db.knex.raw('CREATE TABLE ??.technicians (LIKE public.technicians INCLUDING ALL)', [db.schema]);
    for (const migration of migrations) await migration.up(db.knex);
  }, 60000);
  afterAll(async () => { if (db) await db.dispose(); });

  async function seed(scores = {}, runFields = {}, customer = null) {
    const f = customer || await fixture(db.knex);
    const visit = await f.visit();
    const assessment = await f.assessment(visit, {
      ...UNKNOWN, ...scores, confirmed_by_tech: false, confirmed_at: null, is_baseline: false,
      observations: NO_OBSERVATIONS, adjusted_scores: JSON.stringify({ ...UNKNOWN, ...scores, observations: NO_OBSERVATIONS }),
    });
    const [run] = await db.knex('lawn_assessment_runs').insert({
      assessment_id: assessment.id, customer_id: f.customerId, status: 'complete',
      prompt_version: 'confirm-fixture', context_hash: 'b'.repeat(64),
      observations: MODEL_TEXT, scores_adjusted: JSON.stringify(COMPLETE),
      findings: JSON.stringify(['F1', 'F2'].map((finding_id) => ({ finding_id, name: 'Weed pressure', label: 'weed pressure', confidence: 'moderate', severity: 'moderate', urgency: 'monitor' }))),
      reconciliation: JSON.stringify({ published_observations: NO_OBSERVATIONS, stress_damage_override: null }),
      ...runFields,
    }).returning('*');
    return { assessment, run, f };
  }
  const save = (assessmentId, args = {}, knex = db.knex) => confirmRun({ assessmentId, ...SCORING, ...args }, knex);
  const read = (id) => db.knex('lawn_assessments').where({ id }).first();

  test('partial scores stay pending with NULL gaps, no baseline or finding-review stamp', async () => {
    const { assessment } = await seed();
    const result = await save(assessment.id, { adjustedScores: { turf_density: 68 } });
    expect(result).toMatchObject({ confirmed: false, alreadyConfirmed: false, missingScores: ['weed_suppression', 'color_health', 'stress_damage', 'fungus_control', 'thatch_level'] });
    expect(result.assessment).toMatchObject({ turf_density: 68, color_health: null, confirmed_by_tech: false, confirmed_at: null, overall_score: null, is_baseline: false });
    expect(result.run.reviewed_at).toBeNull();
    expect(result.run.reconciliation.confirmation).toBeUndefined();
  });

  test('the completing save freezes the adjusted AI comparison and final scores', async () => {
    const { assessment } = await seed();
    await save(assessment.id, { adjustedScores: { turf_density: 68 } });
    const result = await save(assessment.id, { adjustedScores: { ...COMPLETE, turf_density: 68 }, review: { reviewedFindings: [] } });
    expect(result).toMatchObject({ confirmed: true, missingScores: [] });
    expect(result.assessment).toMatchObject({ confirmed_by_tech: true, is_baseline: true, turf_density: 68 });
    expect(result.run.reviewed_at).toBeInstanceOf(Date);
    expect(result.run.reconciliation.confirmation).toEqual({ final_scores: { ...COMPLETE, turf_density: 68 }, ai_scores: COMPLETE, calibration_eligible: true, technician_id: null });
    expect(result.run.scores_adjusted).toEqual(COMPLETE);
  });

  test.each([{ status: 'unavailable', scores_adjusted: null }, { scores_adjusted: null }])(
    'a run without an immutable AI baseline never records a calibration comparison: %j', async (runFields) => {
      const { assessment } = await seed({}, runFields);
      const result = await save(assessment.id, { adjustedScores: COMPLETE });
      expect(result.confirmed).toBe(true);
      expect(result.run.reconciliation.confirmation).toMatchObject({ ai_scores: {}, calibration_eligible: false });
    },
  );

  test('confirmation without a new score payload still captures the stored comparison', async () => {
    const { assessment } = await seed({ ...COMPLETE, turf_density: 64 });
    const result = await save(assessment.id);
    expect(result.run.reconciliation.confirmation).toMatchObject({
      ai_scores: COMPLETE, final_scores: { ...COMPLETE, turf_density: 64 }, calibration_eligible: true,
    });
  });

  test('follow-up review withdraws prose in the row and adjusted snapshot before final confirmation', async () => {
    const { assessment } = await seed();
    const first = await save(assessment.id, { review: { addedDetails: [{ text: 'Nutsedge confirmed at the front edge' }] } });
    expect(first.confirmed).toBe(false);
    expect(first.assessment.observations).toBe(MODEL_TEXT);
    expect(first.assessment.adjusted_scores.observations).toBe(MODEL_TEXT);
    const second = await save(assessment.id, {
      review: { addedDetails: [] }, adjustedScores: { ...COMPLETE, observations: MODEL_TEXT },
    });
    expect(second.confirmed).toBe(true);
    expect(second.assessment.observations).toBe(NO_OBSERVATIONS);
    expect(second.assessment.adjusted_scores.observations).toBe(NO_OBSERVATIONS);
    expect(second.run.reconciliation.published_observations).toBe(NO_OBSERVATIONS);
  });

  test.each([MODEL_TEXT, '', null])('an explicit text edit survives review and is mirrored to the adjusted snapshot: %s', async (observationEdit) => {
    const { assessment } = await seed();
    await save(assessment.id, { review: { addedDetails: [{ text: 'Nutsedge confirmed at the front edge' }] } });
    await save(assessment.id, { observationEdit });
    const result = await save(assessment.id, { adjustedScores: COMPLETE, review: { addedDetails: [] } });
    expect(result.assessment.observations).toBe(observationEdit);
    expect(result.assessment.adjusted_scores.observations).toBe(observationEdit);
    expect(result.run.reconciliation.published_observations).toBeNull();
  });

  test('stress overrides survive partial saves and clear when a component changes without an explicit stress edit', async () => {
    const { assessment } = await seed({ fungus_control: 60, thatch_level: 80 });
    await save(assessment.id, { adjustedScores: { stress_damage: 73 } });
    const second = await save(assessment.id, { adjustedScores: { turf_density: 66 } });
    expect(second.assessment.stress_damage).toBe(73);
    expect(second.run.reconciliation.stress_damage_override).toBe(73);
    const third = await save(assessment.id, { adjustedScores: { fungus_control: 88 } });
    expect(third.assessment.stress_damage).toBe(80);
    expect(third.run.reconciliation.stress_damage_override).toBeNull();
  });

  test('retries return the frozen assessment and review without repeating protocol writes', async () => {
    const { assessment } = await seed(COMPLETE);
    const persistChecks = jest.fn(async (row, trx) => {
      await trx('lawn_assessments').where({ id: row.id }).update({ protocol_field_checks: JSON.stringify({ checked: true }) });
    });
    const first = await save(assessment.id, { adjustedScores: COMPLETE, persistChecks, review: { reviewedFindings: [{ finding_id: 'F1', keep: false }] } });
    const committed = await read(assessment.id);
    expect(first.assessment).toEqual(committed);
    const retry = await save(assessment.id, { adjustedScores: { turf_density: 1 }, observationEdit: 'Retry text', persistChecks, review: { reviewedFindings: [{ finding_id: 'F1', keep: true }] } });
    expect(retry.alreadyConfirmed).toBe(true);
    expect(retry.assessment).toEqual(committed);
    expect(retry.run).toEqual(first.run);
    expect(persistChecks).toHaveBeenCalledTimes(1);
  });

  test('a protocol write failure rolls back review, scores, confirmation and baseline', async () => {
    const { assessment, run } = await seed();
    await expect(save(assessment.id, {
      adjustedScores: COMPLETE, review: { addedDetails: [{ text: 'Nutsedge confirmed' }] },
      persistChecks: async (row, trx) => trx('lawn_assessments').where({ id: row.id }).update({ customer_id: null }),
    })).rejects.toMatchObject({ code: '23502' });
    expect(await read(assessment.id)).toEqual(assessment);
    expect(await loadRun(assessment.id, db.knex)).toEqual(run);
  });

  test('a surrounding rollback also rolls back a successful nested confirmation', async () => {
    const { assessment, run } = await seed();
    const failure = new Error('outer completion failed');
    await expect(db.knex.transaction(async (trx) => {
      await save(assessment.id, { adjustedScores: COMPLETE }, trx);
      throw failure;
    })).rejects.toBe(failure);
    expect(await read(assessment.id)).toEqual(assessment);
    expect(await loadRun(assessment.id, db.knex)).toEqual(run);
  });

  test('invalid review and a missing run fail without confirming or invoking protocol writes', async () => {
    const { assessment, run } = await seed(COMPLETE);
    const persistChecks = jest.fn();
    await expect(save(assessment.id, { review: { reviewedFindings: [{ finding_id: 'missing', keep: false }] }, persistChecks })).rejects.toMatchObject({ status: 400 });
    expect(await read(assessment.id)).toEqual(assessment);
    expect(await loadRun(assessment.id, db.knex)).toEqual(run);
    await db.knex('lawn_assessment_runs').where({ id: run.id }).del();
    await expect(save(assessment.id, { persistChecks })).rejects.toMatchObject({ status: 409 });
    expect(persistChecks).not.toHaveBeenCalled();
  });

  // Every throw in this flow carries `{ status }` — the shape the assertions
  // above rely on — but lawn-assessment throws `{ statusCode }`. Without a
  // translation at that delegation boundary a legitimate 409 from the
  // property-history path reaches the caller with no `.status` and surfaces
  // as a 500.
  test('a delegated baseline error surfaces with this flow\'s error shape', async () => {
    const { assessment, run } = await seed(COMPLETE);
    const persistChecks = jest.fn();
    const lawnAssessment = require('../services/lawn-assessment');
    const spy = jest.spyOn(lawnAssessment, 'installConfirmedBaseline')
      .mockRejectedValueOnce(Object.assign(new Error('Assessment ownership changed'), { statusCode: 409 }));
    try {
      await expect(save(assessment.id, { propertyHistoryEnabled: true, persistChecks }))
        .rejects.toMatchObject({ status: 409, statusCode: 409 });
    } finally {
      spy.mockRestore();
    }
    // The failure rolls the transaction back and short-circuits before any
    // protocol write, exactly like the other failure paths above.
    expect(persistChecks).not.toHaveBeenCalled();
    expect(await read(assessment.id)).toEqual(assessment);
    expect(await loadRun(assessment.id, db.knex)).toEqual(run);
  });

  test('property history installs only a completed row and preserves the existing property baseline', async () => {
    const { assessment, f } = await seed();
    const first = await save(assessment.id, { propertyHistoryEnabled: true, adjustedScores: { turf_density: 55 } });
    expect(first.assessment.is_baseline).toBe(false);
    const completed = await save(assessment.id, { propertyHistoryEnabled: true, adjustedScores: COMPLETE });
    expect(completed.assessment).toMatchObject({ is_baseline: true, property_id: f.property.id });
    const later = await seed(COMPLETE, {}, f);
    await save(later.assessment.id, { propertyHistoryEnabled: true });
    expect(await db.knex('lawn_assessments').where({ customer_id: f.customerId, is_baseline: true })).toHaveLength(1);
    expect((await read(assessment.id)).is_baseline).toBe(true);
  });

  test('overlapping partial confirms merge fresh scores and finding decisions after waiting on the baseline lock', async () => {
    const { assessment } = await seed({ ...COMPLETE, turf_density: null, color_health: null });
    const first = await db.knex.transaction();
    const other = await db.knex.transaction();
    const { rows: [{ pid }] } = await other.raw('SELECT pg_backend_pid() AS pid');
    let pending;
    try {
      await save(assessment.id, { adjustedScores: { turf_density: 61 }, review: { reviewedFindings: [{ finding_id: 'F1', keep: false }] } }, first);
      pending = save(assessment.id, { adjustedScores: { color_health: 72 }, review: { reviewedFindings: [{ finding_id: 'F2', keep: false }] } }, other);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const { rows: [{ blockers }] } = await db.knex.raw('SELECT cardinality(pg_blocking_pids(?)) AS blockers', [pid]);
        blocked = blockers > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await first.commit();
      const result = await pending;
      await other.commit();
      expect(result.assessment).toMatchObject({ turf_density: 61, color_health: 72, confirmed_by_tech: true });
      expect(result.run.reviewed_findings).toEqual(expect.arrayContaining([
        expect.objectContaining({ finding_id: 'F1', keep: false }), expect.objectContaining({ finding_id: 'F2', keep: false }),
      ]));
    } finally {
      if (!first.isCompleted()) await first.rollback();
      if (pending) await pending;
      if (!other.isCompleted()) await other.rollback();
    }
  });

  test('concurrent first confirmations install a single legacy baseline for their customer', async () => {
    const first = await seed(COMPLETE);
    const second = await seed(COMPLETE, {}, first.f);
    await Promise.all([save(first.assessment.id), save(second.assessment.id)]);
    expect(await db.knex('lawn_assessments').where({ customer_id: first.f.customerId, is_baseline: true })).toHaveLength(1);
  });

  test.each([false, true])('a property writer can finish while protocol confirmation waits on its fence (history: %s)', async (propertyHistoryEnabled) => {
    const { assessment, f } = await seed(COMPLETE);
    const { withTurfProfileFence } = require('../services/customer-pricing-ai');
    const propertyWriter = await db.knex.transaction();
    const confirmConnection = await db.knex.transaction();
    const { rows: [{ pid }] } = await confirmConnection.raw('SELECT pg_backend_pid() AS pid');
    let pending;
    try {
      await withTurfProfileFence(propertyWriter, f.customerId, async () => {});
      pending = save(assessment.id, {
        propertyHistoryEnabled,
        persistChecks: (row, trx) => trx('customer_turf_profiles')
          .insert({ customer_id: row.customer_id, irrigation_inches_per_week: 1.25 })
          .onConflict('customer_id').merge({ irrigation_inches_per_week: 1.25 }),
      }, confirmConnection);
      let blocked = false;
      for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
        const { rows: [{ blockers }] } = await db.knex.raw('SELECT cardinality(pg_blocking_pids(?)) AS blockers', [pid]);
        blocked = blockers > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      // Taking the assessment lock before the property fence would deadlock
      // here: each connection would hold the lock the other is waiting for.
      await propertyWriter('lawn_assessments').where({ id: assessment.id }).update({ turf_density: 67 });
      await propertyWriter.commit();
      const result = await pending;
      await confirmConnection.commit();
      expect(result.assessment).toMatchObject({ turf_density: 67, confirmed_by_tech: true });
    } finally {
      if (!propertyWriter.isCompleted()) await propertyWriter.rollback();
      if (pending) await pending;
      if (!confirmConnection.isCompleted()) await confirmConnection.rollback();
    }
  });
});
