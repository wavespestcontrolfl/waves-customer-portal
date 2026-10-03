/**
 * 20261003140000: the letter's subject becomes {{subject_line}} (dated for a single-date
 * letter, neutral for a multi-date one — supplied by rate-review-comms.js). Exact-match on
 * the seeded subject, so an operator-edited subject is left alone; down() restores it.
 */
const seed = require('../models/migrations/20261001200000_rate_review_letter_email_template');
const migration = require('../models/migrations/20261003140000_rate_review_letter_subject_line');

const { OLD_SUBJECT, NEW_SUBJECT, VAR } = migration._private;

function fakeKnex(subject = OLD_SUBJECT, shape = 'string') {
  const all = [...seed._private.TEMPLATE.required, ...seed._private.TEMPLATE.optional];
  const opt = seed._private.TEMPLATE.optional;
  const enc = (a) => (shape === 'string' ? JSON.stringify(a) : a);
  const store = {
    email_templates: [{ id: 't1', template_key: 'billing.rate_review_notice', active_version_id: 'v1', allowed_variables: enc(all), required_variables: enc(seed._private.TEMPLATE.required), optional_variables: enc(opt) }],
    email_template_versions: [{ id: 'v1', subject }],
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

describe('rate review letter — subject_line migration', () => {
  test('the seeded subject is the dated one; the new one is the variable', () => {
    expect(seed._private.TEMPLATE.subject).toBe(OLD_SUBJECT);
    expect(NEW_SUBJECT).toBe('{{subject_line}}');
  });

  test.each(['string', 'array'])('up swaps the active subject and allows the variable (%s columns); down restores both exactly', async (shape) => {
    const knex = fakeKnex(OLD_SUBJECT, shape);
    await migration.up(knex);
    expect(knex.store.email_template_versions[0].subject).toBe(NEW_SUBJECT);
    expect(list(knex.store.email_templates[0].allowed_variables)).toContain(VAR);
    // the template no longer references effective_date, so it is optional and subject_line is required
    const t = knex.store.email_templates[0];
    expect(list(t.required_variables)).toContain(VAR);
    expect(list(t.required_variables)).not.toContain('effective_date');
    expect(list(t.optional_variables)).toContain('effective_date');
    expect(list(t.allowed_variables)).toEqual(expect.arrayContaining([VAR, 'effective_date']));
    await migration.up(knex); // idempotent
    expect(list(knex.store.email_templates[0].allowed_variables).filter((v) => v === VAR)).toHaveLength(1);
    await migration.down(knex);
    expect(knex.store.email_template_versions[0].subject).toBe(OLD_SUBJECT);
    expect(list(knex.store.email_templates[0].allowed_variables)).not.toContain(VAR);
    expect(list(knex.store.email_templates[0].optional_variables)).toEqual(seed._private.TEMPLATE.optional);
    expect([...list(knex.store.email_templates[0].required_variables)].sort()).toEqual([...seed._private.TEMPLATE.required].sort());
  });

  test('an operator-edited subject is left alone (no match, no write)', async () => {
    const knex = fakeKnex('Our own subject {{effective_date}}');
    await migration.up(knex);
    expect(knex.store.email_template_versions[0].subject).toBe('Our own subject {{effective_date}}');
    expect(list(knex.store.email_templates[0].allowed_variables)).not.toContain(VAR);
    await migration.down(knex);
    expect(knex.store.email_template_versions[0].subject).toBe('Our own subject {{effective_date}}');
  });

  test('a missing template or version is a no-op', async () => {
    const knex = fakeKnex();
    knex.store.email_templates[0].active_version_id = null;
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });
});
