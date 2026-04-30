/**
 * DB-backed tests for PR 0.4's drift sweep.
 *
 * Three insert paths that were silently failing in the confirm-route
 * setImmediate fanout get exercised end-to-end against the real schema:
 *
 *   1. recordTechCalibration(assessmentId, aiScores, techScores)
 *      — the whole row including bias_direction must land.
 *   2. trackAssessmentCompletion(date)
 *      — the scheduled_services lookup must not blow up on a
 *      non-existent assigned_tech_id column.
 *   3. /assess photo-storage shape
 *      — every column the route writes to lawn_assessment_photos
 *      must exist (schema-presence test).
 *
 * Plus generateServiceReport's best-photo lookup once is_best_photo
 * exists.
 *
 * Self-skips without DATABASE_URL so the rest of the unit suite runs
 * on a developer box without Postgres.
 */

const path = require('path');
const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

describeOrSkip('PR 0.4 drift sweep — DB-backed integration', () => {
  let knex;
  let LawnIntel;

  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    // require AFTER knex env is set, in case lawn-intelligence pulls
    // any module-time DB config.
    LawnIntel = require('../services/lawn-intelligence');
  });

  afterAll(async () => {
    if (knex) await knex.destroy();
  });

  // ── tech_calibration.bias_direction ───────────────────────────────────
  describe('tech_calibration', () => {
    test('bias_direction column exists, nullable, with CHECK', async () => {
      const cols = await knex('tech_calibration').columnInfo();
      expect(cols).toHaveProperty('bias_direction');
      expect(cols.bias_direction.nullable).toBe(true);

      // CHECK constraint should reject an out-of-range value.
      // Use a transaction so the failed insert doesn't pollute the suite.
      await expect(
        knex.transaction(async (trx) => {
          await trx('tech_calibration').insert({
            assessment_id: '00000000-0000-0000-0000-000000000001',
            technician_id: '00000000-0000-0000-0000-000000000002',
            bias_direction: 'sideways', // not in (higher|lower|mixed|null)
          });
        })
      ).rejects.toThrow(/check|constraint|bias_direction/i);
    });

    test('recordTechCalibration inserts a complete row including bias_direction', async () => {
      const tech = await knex('technicians').select('id').first();
      const customer = await knex('customers').select('id').first();
      if (!tech || !customer) {
        // eslint-disable-next-line no-console
        console.warn('[drift-sweep] missing tech/customer fixtures — skipping');
        return;
      }

      const [a] = await knex('lawn_assessments')
        .insert({
          customer_id: customer.id,
          technician_id: tech.id,
          service_date: new Date(),
          composite_scores: JSON.stringify({
            turf_density: 80, weed_suppression: 70, color_health: 75,
            fungus_control: 85, thatch_level: 65,
          }),
        })
        .returning(['id']);
      const assessmentId = a.id;

      try {
        const aiScores = {
          turf_density: 80, weed_suppression: 70, color_health: 75,
          fungus_control: 85, thatch_level: 65,
        };
        const techScores = {
          turf_density: 75, // tech says lower
          weed_suppression: 80, // tech says higher
          color_health: 75,  // same
          fungus_control: 90, // higher
          thatch_level: 60,  // lower
        };

        const result = await LawnIntel.recordTechCalibration(assessmentId, aiScores, techScores);
        expect(result).toBeTruthy();

        const row = await knex('tech_calibration')
          .where({ assessment_id: assessmentId })
          .first();
        expect(row).toBeTruthy();
        expect(row.ai_turf_density).toBe(80);
        expect(row.tech_turf_density).toBe(75);
        // 2 higher, 2 lower, 1 same → mixed
        expect(row.bias_direction).toBe('mixed');
        // avg_delta = (5 + 10 + 0 + 5 + 5) / 5 = 5.0
        expect(parseFloat(row.avg_delta)).toBe(5);
      } finally {
        await knex('tech_calibration').where({ assessment_id: assessmentId }).del();
        await knex('lawn_assessments').where({ id: assessmentId }).del();
      }
    });
  });

  // ── lawn_assessment_photos shape ──────────────────────────────────────
  describe('lawn_assessment_photos', () => {
    // Single source of truth for the columns the /assess route
    // expects. If a future change adds another field to that insert,
    // the developer ALSO needs to add it here — and to a migration.
    const REQUIRED_COLUMNS = [
      'assessment_id',
      'customer_id',
      's3_key',
      'filename',
      'mime_type',
      'file_size_bytes',
      'photo_type',
      'photo_order',
      'turf_density',
      'weed_coverage',
      'color_health',
      'fungal_activity',
      'thatch_visibility',
      'observations',
      'quality_score',
      'quality_gate_passed',
      'quality_issues',
      'customer_visible',
      'is_best_photo',
      'taken_at',
    ];

    test('every column /assess writes exists in the schema', async () => {
      const cols = await knex('lawn_assessment_photos').columnInfo();
      for (const c of REQUIRED_COLUMNS) {
        expect(cols).toHaveProperty(c);
      }
    });

    test('full /assess insert payload succeeds against the real table', async () => {
      const tech = await knex('technicians').select('id').first();
      const customer = await knex('customers').select('id').first();
      if (!tech || !customer) return;

      const [a] = await knex('lawn_assessments')
        .insert({
          customer_id: customer.id,
          technician_id: tech.id,
          service_date: new Date(),
        })
        .returning(['id']);
      const assessmentId = a.id;

      try {
        // Mirror admin-lawn-assessment.js photo insert verbatim.
        const [photo] = await knex('lawn_assessment_photos').insert({
          assessment_id: assessmentId,
          customer_id: customer.id,
          s3_key: `pending/${assessmentId}/test.jpg`,
          filename: `lawn_${customer.id}_test.jpg`,
          mime_type: 'image/jpeg',
          file_size_bytes: 12345,
          photo_type: 'front_yard',
          photo_order: 0,
          turf_density: 78,
          weed_coverage: 22,
          color_health: 7.5,
          fungal_activity: 'absent',
          thatch_visibility: 'normal',
          observations: 'test',
          quality_score: 78,
          quality_gate_passed: true,
          quality_issues: JSON.stringify([]),
          customer_visible: true,
          is_best_photo: false,
          taken_at: new Date(),
        }).returning('*');

        expect(photo).toBeTruthy();
        expect(photo.is_best_photo).toBe(false);
        expect(photo.quality_gate_passed).toBe(true);

        // generateServiceReport-style best-photo lookup must not blow up.
        // Mark this row as best, then look it up.
        await knex('lawn_assessment_photos').where({ id: photo.id }).update({ is_best_photo: true });
        const best = await knex('lawn_assessment_photos')
          .where({ assessment_id: assessmentId, is_best_photo: true })
          .first();
        expect(best).toBeTruthy();
        expect(best.id).toBe(photo.id);
      } finally {
        await knex('lawn_assessment_photos').where({ assessment_id: assessmentId }).del();
        await knex('lawn_assessments').where({ id: assessmentId }).del();
      }
    });
  });

  // ── scheduled_services lookup must not reference assigned_tech_id ─────
  describe('trackAssessmentCompletion', () => {
    test('completes without erroring on the scheduled_services query', async () => {
      // Don't assert specific data — just that the query doesn't blow
      // up the way it did before the assigned_tech_id reference was
      // removed. trackAssessmentCompletion catches its own errors and
      // returns null, so we observe by sniffing the logger.
      const logger = require('../services/logger');
      const errors = [];
      const origError = logger.error;
      logger.error = (msg) => { errors.push(String(msg)); origError && origError(msg); };

      try {
        await LawnIntel.trackAssessmentCompletion(new Date().toISOString().slice(0, 10));
      } finally {
        logger.error = origError;
      }

      const droppedColumnErrors = errors.filter((e) =>
        /column "assigned_tech_id" does not exist/.test(e)
      );
      expect(droppedColumnErrors).toEqual([]);
    });
  });
});
