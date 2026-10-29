/**
 * Migration 20261029100000: decision_reviews takes the 'lawn_diagnostics' subject
 * type (the lawn diagnosis summary a lawn_result_timing.v1 answer judged). The CHECK is
 * rebuilt from the values it holds now, so it is order-independent with the
 * other subject-type migrations; down refuses while a row uses the value.
 */
const migration = require('../models/migrations/20261029100000_decision_reviews_lawn_diagnostics_subject');

function stubKnex({ hasTable = true, def = null, used = null } = {}) {
  const raw = [];
  const knex = (table) => ({
    where: (where) => ({ first: async () => { knex.read = { table, where }; return used; } }),
  });
  knex.schema = { hasTable: async () => hasTable };
  knex.raw = async (sql) => {
    raw.push(sql);
    if (/pg_get_constraintdef/.test(sql)) return { rows: def ? [{ def }] : [] };
    return { rows: [] };
  };
  return { knex, raw };
}

const DEF = "CHECK ((subject_type = ANY (ARRAY['call_log'::text, 'sms_log'::text, 'social_post'::text, 'scheduled_services'::text])))";

describe('decision_reviews lawn_diagnostics subject migration', () => {
  test('up adds the value to what the CHECK holds now', async () => {
    const { knex, raw } = stubKnex({ def: DEF });
    await migration.up(knex);
    expect(raw.slice(1)).toEqual([
      'ALTER TABLE decision_reviews DROP CONSTRAINT IF EXISTS decision_reviews_subject_type_check',
      "ALTER TABLE decision_reviews ADD CONSTRAINT decision_reviews_subject_type_check CHECK (subject_type IN ('call_log','sms_log','social_post','scheduled_services','lawn_diagnostics'))",
    ]);
  });

  test('up is a no-op when the value is already allowed, and with no table', async () => {
    const has = stubKnex({ def: DEF.replace("'scheduled_services'::text", "'lawn_diagnostics'::text") });
    await migration.up(has.knex);
    expect(has.raw).toHaveLength(1);
    const none = stubKnex({ hasTable: false });
    await migration.up(none.knex);
    await migration.down(none.knex);
    expect(none.raw).toEqual([]);
  });

  test('a missing CHECK is rebuilt from the original two plus the new value', async () => {
    const { knex, raw } = stubKnex();
    await migration.up(knex);
    expect(raw[2]).toContain("subject_type IN ('call_log','sms_log','lawn_diagnostics')");
  });

  test('down removes only this value, after locking the table', async () => {
    const { knex, raw } = stubKnex({ def: DEF.replace("'scheduled_services'::text", "'lawn_diagnostics'::text") });
    await migration.down(knex);
    expect(knex.read).toEqual({ table: 'decision_reviews', where: { subject_type: 'lawn_diagnostics' } });
    expect(raw[0]).toBe('LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE');
    expect(raw[raw.length - 1]).toContain("subject_type IN ('call_log','sms_log','social_post')");
    expect(raw[raw.length - 1]).not.toContain('lawn_diagnostics');
  });

  test('down refuses, changing nothing, while a row uses the value', async () => {
    const { knex, raw } = stubKnex({ def: DEF, used: { id: 'r1' } });
    await expect(migration.down(knex)).rejects.toThrow(/lawn_diagnostics rows/);
    expect(raw).toEqual(['LOCK TABLE decision_reviews IN ACCESS EXCLUSIVE MODE']);
  });
});
