// 20261009200000 moved Topchoice's rule from 'label' to 'owner' on any
// label-sourced water-in; only the seeded program default should have moved
// (codex P1 #6259). 20261012010000 puts an admin-edited rule back from that
// migration's own audit row.
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const first = require('../models/migrations/20261009200000_watering_rule_preemergent_label_window');
const guard = require('../models/migrations/20261012010000_watering_rule_topchoice_provenance_guard');
const fireAnt = require('../models/migrations/20261009100000_lawn_v13_fire_ant_granule');
const { validateRule } = require('../services/service-report/lawn-watering-rule');

const SEEDED = fireAnt.WATERING_RULE;
const EDITS = {
  amount: { ...SEEDED, water_in_inches: 0.5 },
  deadline: { ...SEEDED, water_in_by_hours: 48 },
  note: { ...SEEDED, label_note: 'Label re-read by the office.' },
  verification: { ...SEEDED, verified_at: '2026-10-09T15:00:00.000Z', verified_by: 'office' },
};

describe('Topchoice provenance guard (pure)', () => {
  test('the seeded rule is the one the first migration was written for: its rewrite stands', () => {
    expect(guard.SEEDED_RULE).toBe(SEEDED);
    expect(validateRule(SEEDED).valid).toBe(true);
    const after = first.topchoiceAfter(SEEDED);
    expect(after.source).toBe('owner');
    expect(guard.ruleToRestore({ before: SEEDED, after })).toBeNull();
    // Key order is not a difference (jsonb does not keep it).
    const reordered = Object.fromEntries(Object.entries(SEEDED).reverse());
    expect(guard.ruleToRestore({ before: reordered, after })).toBeNull();
  });

  test.each(Object.entries(EDITS))('an admin edit of the %s that kept source label is put back', (_field, edited) => {
    const after = first.topchoiceAfter(edited);
    expect(after).not.toBeNull();
    expect(guard.ruleToRestore({ before: edited, after })).toEqual({ before: edited, after });
  });

  test('an audit row without both rules restores nothing', () => {
    expect(guard.ruleToRestore(null)).toBeNull();
    expect(guard.ruleToRestore({})).toBeNull();
    expect(guard.ruleToRestore({ before: EDITS.note })).toBeNull();
    expect(guard.ruleToRestore({ before: 'x', after: [] })).toBeNull();
  });
});

describeDb('20261012010000 Topchoice provenance guard', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `topchoice_guard_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['products_catalog', 'audit_log']) {
      await knex.raw(`CREATE TABLE ??.${table} (LIKE public.${table} INCLUDING ALL)`, [schema]);
    }
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const insert = async (rule) => {
    const [created] = await knex('products_catalog')
      .insert({ id: randomUUID(), name: first.TOPCHOICE, post_application_watering: JSON.stringify(rule) })
      .returning('id');
    return created.id;
  };
  const rule = async (id) => (await knex('products_catalog').where({ id }).first()).post_application_watering;
  const restores = () => knex('audit_log').where('action', 'like', 'migration:20261012010000_%');

  test('the seeded rule stays owner-sourced; an edited rule gets its own values back; once, audited', async () => {
    const seeded = await insert(SEEDED);
    const edited = await insert(EDITS.verification);
    await first.up(knex);
    expect(await rule(seeded)).toMatchObject({ source: 'owner' });
    expect(await rule(edited)).toMatchObject({ source: 'owner', verified_by: 'owner-ruling-2026-10-09' });

    await guard.up(knex);
    await guard.up(knex); // idempotent
    expect(await rule(seeded)).toMatchObject({ source: 'owner', verified_by: 'owner-ruling-2026-10-09' });
    expect(await rule(edited)).toEqual(EDITS.verification);
    const audits = await restores();
    expect(audits.map((a) => a.resource_id)).toEqual([edited]);
    const metadata = typeof audits[0].metadata === 'string' ? JSON.parse(audits[0].metadata) : audits[0].metadata;
    expect(metadata).toMatchObject({ after: EDITS.verification, before: { source: 'owner' } });
    await guard.down(knex);
  });

  test('a rule edited again after the first migration is left alone', async () => {
    const edited = await insert(EDITS.note);
    await first.up(knex);
    const newer = { ...EDITS.note, source: 'owner', water_in_inches: 0.3 };
    await knex('products_catalog').where({ id: edited }).update({ post_application_watering: JSON.stringify(newer) });
    await guard.up(knex);
    expect(await rule(edited)).toEqual(newer);
    expect(await restores()).toHaveLength(0);
  });
});
