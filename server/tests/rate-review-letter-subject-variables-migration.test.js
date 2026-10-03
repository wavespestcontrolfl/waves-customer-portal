/**
 * 20261003150000: after the subject moved to {{subject_line}} (20261003140000), subject_line
 * is required and effective_date optional; down() restores; an operator-edited subject is
 * left alone.
 */
const seed = require('../models/migrations/20261001200000_rate_review_letter_email_template');
const subject = require('../models/migrations/20261003140000_rate_review_letter_subject_line');
const migration = require('../models/migrations/20261003150000_rate_review_letter_subject_variables');

const { VAR, DATE_VAR, SUBJECT } = migration._private;
const T = seed._private.TEMPLATE;

// the template as 20261003140000 leaves it
function fakeKnex(subjectText = SUBJECT, shape = 'string') {
  const enc = (a) => (shape === 'string' ? JSON.stringify(a) : a);
  const store = {
    email_templates: [{ id: 't1', template_key: 'billing.rate_review_notice', active_version_id: 'v1', allowed_variables: enc([...T.required, ...T.optional, VAR]), required_variables: enc(T.required), optional_variables: enc([...T.optional, VAR]) }],
    email_template_versions: [{ id: 'v1', subject: subjectText }],
  };
  const knex = (table) => {
    let filter = () => true;
    const q = {
      where(cond) { filter = (r) => Object.entries(cond).every(([k, v]) => r[k] === v); return q; },
      first: async () => store[table].find(filter),
      update: async (patch) => { store[table].filter(filter).forEach((r) => Object.assign(r, patch)); return 1; },
    };
    return q;
  };
  knex.schema = { hasTable: async () => true };
  knex.store = store;
  return knex;
}
const list = (v) => (Array.isArray(v) ? v : JSON.parse(v));

test('the subject step leaves exactly the shape this step starts from', () => {
  expect(subject._private.NEW_SUBJECT).toBe(SUBJECT);
});

test.each(['string', 'array'])('up makes subject_line required and effective_date optional; down restores both (%s columns)', async (shape) => {
  const knex = fakeKnex(SUBJECT, shape);
  await migration.up(knex);
  const t = knex.store.email_templates[0];
  expect(list(t.required_variables)).toContain(VAR);
  expect(list(t.required_variables)).not.toContain(DATE_VAR);
  expect(list(t.optional_variables)).toContain(DATE_VAR);
  expect(list(t.optional_variables)).not.toContain(VAR);
  expect(list(t.allowed_variables)).toEqual(expect.arrayContaining([VAR, DATE_VAR]));
  const once = JSON.stringify(t);
  await migration.up(knex); // idempotent
  expect(JSON.stringify(knex.store.email_templates[0])).toBe(once);
  await migration.down(knex);
  const back = knex.store.email_templates[0];
  expect([...list(back.required_variables)].sort()).toEqual([...T.required].sort());
  expect([...list(back.optional_variables)].sort()).toEqual([...T.optional, VAR].sort());
});

test('an operator-edited subject (or the subject step not applied) leaves the lists alone', async () => {
  for (const text of ['Our own subject', T.subject]) {
    const knex = fakeKnex(text);
    const before = JSON.stringify(knex.store.email_templates[0]);
    await migration.up(knex);
    await migration.down(knex);
    expect(JSON.stringify(knex.store.email_templates[0])).toBe(before);
  }
});

test('a missing template or version is a no-op', async () => {
  const knex = fakeKnex();
  knex.store.email_templates[0].active_version_id = null;
  await expect(migration.up(knex)).resolves.toBeUndefined();
  await expect(migration.down(knex)).resolves.toBeUndefined();
});
