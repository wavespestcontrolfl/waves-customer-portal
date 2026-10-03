/**
 * Migrations 20261003100000 + 20261003101000: the subject-type CHECK ends as
 * call_log, sms_log and social_post (the first cut widened it further and is
 * frozen; the second narrows it), and rolling the first back refuses while a
 * row of a new type exists.
 */
const migration = require('../models/migrations/20261003100000_decision_reviews_subject_types');
const narrow = require('../models/migrations/20261003101000_decision_reviews_subject_types_social_post_only');

function stubKnex({ hasTable = true, otherRow = null } = {}) {
  const raw = [];
  const knex = (table) => ({
    whereNotIn: (column, values) => ({ first: async () => { knex.read = { table, column, values }; return otherRow; } }),
  });
  knex.schema = { hasTable: async () => hasTable };
  knex.raw = async (sql) => { raw.push(sql); };
  return { knex, raw };
}

describe('decision_reviews subject types migration', () => {
  test('up replaces the CHECK with the original two types plus the six this wave needs', async () => {
    const { knex, raw } = stubKnex();
    await migration.up(knex);
    expect(raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_type_check',
      "ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_type_check CHECK (subject_type IN ('call_log', 'sms_log', 'social_post', 'service_photo', 'visit', 'call_turn', 'lead', 'google_review'))",
    ]);
  });

  test('the second cut leaves exactly the subjects the recorder writes', async () => {
    const { knex, raw } = stubKnex();
    await narrow.up(knex);
    expect(raw).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_type_check',
      "ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_type_check CHECK (subject_type IN ('call_log', 'sms_log', 'social_post'))",
    ]);
    // Read from the source: loading the recorder would open the database.
    const source = require('fs').readFileSync(require.resolve('../services/typed-decisions/shadow-recorder'), 'utf8');
    const recorded = JSON.parse(source.match(/const SUBJECT_TYPES = (\[[^\]]+\]);/)[1].replace(/'/g, '"'));
    expect(recorded).toEqual(narrow.SUBJECT_TYPES);
  });

  test('rolling the second cut back restores exactly what the first cut left', async () => {
    const first = stubKnex();
    await migration.up(first.knex);
    const second = stubKnex();
    await narrow.down(second.knex);
    expect(second.raw).toEqual(first.raw);
  });

  test('down locks the table, then restores the original CHECK when no row uses a new type', async () => {
    const { knex, raw } = stubKnex();
    await migration.down(knex);
    expect(knex.read).toEqual({ table: 'decision_reviews', column: 'subject_type', values: ['call_log', 'sms_log'] });
    expect(raw).toEqual([
      'LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE',
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_type_check',
      "ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_type_check CHECK (subject_type IN ('call_log', 'sms_log'))",
    ]);
  });

  test('down refuses, changing nothing, while a row of a new type exists', async () => {
    const { knex, raw } = stubKnex({ otherRow: { id: 'r1' } });
    await expect(migration.down(knex)).rejects.toThrow(/export or remove them/);
    expect(raw).toEqual(['LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE']);
  });

  test('a database without the table is left alone both ways', async () => {
    const { knex, raw } = stubKnex({ hasTable: false });
    await migration.up(knex);
    await migration.down(knex);
    await narrow.up(knex);
    await narrow.down(knex);
    expect(raw).toEqual([]);
  });
});
