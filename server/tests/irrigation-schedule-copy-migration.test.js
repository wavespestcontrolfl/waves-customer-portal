/**
 * 20260825000001 — {{schedule_ask}} / {{schedule_note}} callouts.
 * Pins: publish-a-new-version (never overwrite), exact-content idempotency,
 * a staff-reworded callout is left alone, variables land as OPTIONAL (a
 * required variable would fail the old sender closed in the deploy window),
 * and down() restores only its own version.
 */
const migration = require('../models/migrations/20260825000001_irrigation_schedule_copy_variables');

const { TARGETS } = migration.__private;

function makeKnex(initial, { tables } = {}) {
  const db = JSON.parse(JSON.stringify(initial));
  let nextId = 5000;
  const match = (row, where) => Object.entries(where || {}).every(([k, v]) => row[k] === v);
  function table(name) {
    const rows = db[name] || [];
    const state = { where: {} };
    const api = {
      where(w) { state.where = { ...state.where, ...w }; return api; },
      select() { return api; },
      max(expr) {
        const [col] = String(expr).split(' as ');
        const sel = rows.filter((r) => match(r, state.where));
        return { first: async () => ({ max: sel.length ? Math.max(...sel.map((r) => Number(r[col]) || 0)) : null }) };
      },
      async first() { return rows.find((r) => match(r, state.where)) || undefined; },
      async update(patch) { rows.filter((r) => match(r, state.where)).forEach((r) => Object.assign(r, patch)); return 1; },
      insert(row) { const c = { id: `id-${nextId += 1}`, ...row }; rows.push(c); return { returning: async () => [c] }; },
      then(resolve) { return Promise.resolve(rows.filter((r) => match(r, state.where))).then(resolve); },
    };
    return api;
  }
  const knex = (n) => table(n);
  knex.schema = { hasTable: async (n) => (tables ? tables.includes(n) : n in db) };
  knex.__db = db;
  return knex;
}

const seededBlocks = (target) => [
  { type: 'heading', content: 'Your weekly lawn water check-in, {{first_name}}' },
  { type: 'callout', content: target.seededCallout },
  { type: 'signature', content: '— The Waves Team' },
];

const fixture = () => ({
  email_templates: TARGETS.map((t, i) => ({
    id: `t${i}`, template_key: t.key, active_version_id: `v${i}`,
    allowed_variables: JSON.stringify(['first_name']), optional_variables: JSON.stringify([]), required_variables: JSON.stringify(['first_name']),
  })),
  email_template_versions: TARGETS.map((t, i) => ({
    id: `v${i}`, template_id: `t${i}`, version_number: 3, status: 'active',
    subject: 'S', preview_text: 'P', blocks: JSON.stringify(seededBlocks(t)), text_body: null,
  })),
  email_template_fixtures: [{ id: 'f0', template_id: 't0', payload: JSON.stringify({ first_name: 'Sam' }) }],
});

describe('irrigation schedule-copy migration', () => {
  test('publishes a new active version per template with the callout swapped for the variable; original retained', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    for (const [i, target] of TARGETS.entries()) {
      const tpl = knex.__db.email_templates[i];
      const versions = knex.__db.email_template_versions.filter((v) => v.template_id === tpl.id);
      expect(versions).toHaveLength(2);
      const old = versions.find((v) => v.id === `v${i}`);
      expect(old.status).toBe('archived');
      expect(JSON.parse(old.blocks)).toEqual(seededBlocks(target));
      const published = versions.find((v) => v.id !== `v${i}`);
      expect(published.status).toBe('active');
      expect(published.version_number).toBe(4);
      expect(tpl.active_version_id).toBe(published.id);
      expect(JSON.parse(published.blocks)[1]).toEqual({ type: 'callout', content: `{{${target.variable}}}` });
      expect(JSON.parse(tpl.allowed_variables)).toContain(target.variable);
      expect(JSON.parse(tpl.optional_variables)).toContain(target.variable);
      expect(JSON.parse(tpl.required_variables)).not.toContain(target.variable);
    }
    expect(JSON.parse(knex.__db.email_template_fixtures[0].payload).schedule_ask).toBe(TARGETS[0].fixtureValue);
  });

  test('is idempotent', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    await migration.up(knex);
    expect(knex.__db.email_template_versions).toHaveLength(4);
  });

  test('a staff-reworded callout is left alone (allowlist still lands)', async () => {
    const f = fixture();
    const blocks = seededBlocks(TARGETS[0]);
    blocks[1].content = 'Reworded by staff.';
    f.email_template_versions[0].blocks = JSON.stringify(blocks);
    const knex = makeKnex(f);
    await migration.up(knex);
    expect(knex.__db.email_template_versions.filter((v) => v.template_id === 't0')).toHaveLength(1);
    expect(JSON.parse(knex.__db.email_templates[0].allowed_variables)).toContain('schedule_ask');
  });

  test('down() restores its own predecessor and declines when edited on top', async () => {
    const knex = makeKnex(fixture());
    await migration.up(knex);
    await migration.down(knex);
    for (const [i] of TARGETS.entries()) {
      expect(knex.__db.email_templates[i].active_version_id).toBe(`v${i}`);
      expect(knex.__db.email_template_versions.find((v) => v.id === `v${i}`).status).toBe('active');
    }
    // Fixture values survive rollback: up() preserves a pre-existing value,
    // so down() cannot tell staff-authored data from its own seed — it
    // leaves both (an extra key on an optional variable renders nothing).
    expect(JSON.parse(knex.__db.email_template_fixtures[0].payload).schedule_ask).toBe(TARGETS[0].fixtureValue);

    const knex2 = makeKnex(fixture());
    await migration.up(knex2);
    const active = knex2.__db.email_template_versions.find((v) => v.template_id === 't0' && v.status === 'active');
    const edited = JSON.parse(active.blocks); edited.push({ type: 'paragraph', content: 'staff addition' });
    active.blocks = JSON.stringify(edited);
    await migration.down(knex2);
    expect(knex2.__db.email_templates[0].active_version_id).toBe(active.id);
  });

  test('down() finds the true predecessor past an unpublished draft holding an intermediate version number', async () => {
    // Active v3 + staff draft v4 → up() publishes v5. version_number - 1
    // would land on the draft; the structural search must restore v3.
    const f = fixture();
    f.email_template_versions.push({
      id: 'draft0', template_id: 't0', version_number: 4, status: 'draft',
      subject: 'S', preview_text: 'P', blocks: JSON.stringify([{ type: 'paragraph', content: 'WIP rewrite' }]), text_body: null,
    });
    const knex = makeKnex(f);
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.__db.email_templates[0].active_version_id).toBe('v0');
    expect(knex.__db.email_template_versions.find((v) => v.id === 'v0').status).toBe('active');
    expect(knex.__db.email_template_versions.find((v) => v.id === 'draft0').status).toBe('draft');
  });

  test('no-ops when the tables are absent', async () => {
    const knex = makeKnex(fixture(), { tables: [] });
    await migration.up(knex);
    expect(knex.__db.email_template_versions).toHaveLength(2);
  });
});
