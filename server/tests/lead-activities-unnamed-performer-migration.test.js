/**
 * 20261030220000: lead history rows whose performer was built from
 * technicians.first_name / last_name (columns the table does not have) read
 * "undefined " or "". They get a plain label; every other row is untouched.
 * Synthetic data only.
 */
const migration = require('../models/migrations/20261030220000_lead_activities_unnamed_performer');

function fakeKnex(db, { hasTable = true, hasColumn = true } = {}) {
  const knex = (table) => {
    let values = null;
    let column = null;
    const rows = () => db[table] || [];
    const q = {
      whereIn(col, list) { column = col; values = list; return q; },
      update: async (patch) => {
        const hits = rows().filter((r) => values.includes(r[column]));
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async () => hasTable, hasColumn: async () => hasColumn };
  return knex;
}

const seededDb = () => ({
  lead_activities: [
    { id: 1, activity_type: 'updated', performed_by: 'undefined ' },
    { id: 2, activity_type: 'deleted', performed_by: 'undefined ' },
    { id: 3, activity_type: 'status_change', performed_by: '' },
    { id: 4, activity_type: 'ai_triage', performed_by: 'system' },
    { id: 5, activity_type: 'note', performed_by: 'Robin Sample' },
    { id: 6, activity_type: 'linked_estimate', performed_by: 'Admin' },
    { id: 7, activity_type: 'email_received', performed_by: null },
  ],
});

test('labels only the "undefined " and empty performers', async () => {
  const db = seededDb();
  await migration.up(fakeKnex(db));
  expect(db.lead_activities.map((r) => r.performed_by)).toEqual([
    migration.UNNAMED_PERFORMER_LABEL,
    migration.UNNAMED_PERFORMER_LABEL,
    migration.UNNAMED_PERFORMER_LABEL,
    'system',
    'Robin Sample',
    'Admin',
    null,
  ]);
});

test('the label fits lead_activities.performed_by (varchar 100)', () => {
  expect(migration.UNNAMED_PERFORMER_LABEL.length).toBeLessThanOrEqual(100);
});

test('a second run changes nothing', async () => {
  const db = seededDb();
  await migration.up(fakeKnex(db));
  const after = JSON.stringify(db);
  await migration.up(fakeKnex(db));
  expect(JSON.stringify(db)).toBe(after);
});

test.each([
  ['no lead_activities table', { hasTable: false }],
  ['no performed_by column', { hasColumn: false }],
])('%s: writes nothing', async (_name, shape) => {
  const db = seededDb();
  await migration.up(fakeKnex(db, shape));
  expect(db).toEqual(seededDb());
});
