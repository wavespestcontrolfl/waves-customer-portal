/**
 * 20260920000001_job_applications_interview_comms — sms_templates seeding is
 * INSERT-ONLY (never overwrites a pre-existing template_key, e.g. an
 * owner-edited row) and down() leaves sms_templates rows in place, only
 * reverting the job_applications columns/constraint it added.
 */
const migration = require('../models/migrations/20260920000001_job_applications_interview_comms');

const { _TEMPLATES: TEMPLATES } = migration;

function createKnex({ existingRows = {} } = {}) {
  const state = { rows: { ...existingRows }, inserted: [], deleted: [] };
  const knex = jest.fn((table) => {
    expect(table).toBe('sms_templates');
    const q = {
      criteria: null,
      where(criteria) { q.criteria = criteria; return q; },
      async first() { return state.rows[q.criteria.template_key]; },
      async insert(row) {
        state.rows[row.template_key] = row;
        state.inserted.push(row.template_key);
      },
      whereIn(col, keys) { q.inKeys = keys; return q; },
      async del() {
        for (const key of q.inKeys || []) {
          if (state.rows[key]) { delete state.rows[key]; state.deleted.push(key); }
        }
      },
    };
    return q;
  });
  // job_applications table absent in this fake — up()/down() skip that
  // whole block and only the sms_templates path under test runs.
  knex.schema = { hasTable: jest.fn(async (table) => table === 'sms_templates') };
  knex.__state = state;
  return knex;
}

describe('up() sms_templates seeding is insert-only', () => {
  test('an empty table gets all six seeded rows', async () => {
    const knex = createKnex();
    await migration.up(knex);
    expect(knex.__state.inserted.sort()).toEqual(TEMPLATES.map((t) => t.template_key).sort());
    expect(Object.keys(knex.__state.rows)).toHaveLength(TEMPLATES.length);
  });

  test('a pre-existing (owner-edited) row is left byte-identical — no update, no re-insert', async () => {
    const editedBody = 'Owner-edited copy the seed must never touch.';
    const knex = createKnex({
      existingRows: {
        job_application_received: {
          template_key: 'job_application_received',
          body: editedBody,
          name: 'Job Application Received',
          is_active: false, // owner paused it — must survive too
        },
      },
    });
    await migration.up(knex);

    expect(knex.__state.rows.job_application_received.body).toBe(editedBody);
    expect(knex.__state.rows.job_application_received.is_active).toBe(false);
    expect(knex.__state.inserted).not.toContain('job_application_received');
    // The other five (not pre-existing) still get seeded.
    expect(knex.__state.inserted).toHaveLength(TEMPLATES.length - 1);
  });
});

describe('down() leaves sms_templates rows in place', () => {
  test('every seeded row survives down() — nothing deleted from sms_templates', async () => {
    const knex = createKnex();
    await migration.up(knex);
    const beforeKeys = Object.keys(knex.__state.rows).sort();
    knex.mockClear();

    await migration.down(knex);

    expect(Object.keys(knex.__state.rows).sort()).toEqual(beforeKeys);
    expect(knex.__state.deleted).toEqual([]);
    // down() never even queries the sms_templates table.
    expect(knex).not.toHaveBeenCalled();
  });
});
