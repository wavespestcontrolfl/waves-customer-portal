/**
 * 20260927000003: every non-1 rodent_trapping.included_followups becomes 1,
 * and the prep.rodent line from 000002 becomes version-neutral (the guide is
 * shared by grandfathered jobs whose checks are all included).
 */
const v3 = require('../models/migrations/20260924000007_prep_guide_content_v3_codex_r6');
const prep2 = require('../models/migrations/20260927000002_prep_guide_rodent_trap_check_copy');
const migration = require('../models/migrations/20260927000003_rodent_trap_check_followups_and_neutral_prep');

const { PRIOR_LINE, NEUTRAL_LINE, MIGRATION_MARKER } = migration;
const rodentBlocks = () => v3.TEMPLATES.find((t) => t.key === 'prep.rodent').blocks;

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((f) => f(r));
    let order = null;
    const q = {
      where(a, op, val) {
        if (typeof a === 'string' && op === '<') filters.push((r) => r[a] < val);
        else filters.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        return q;
      },
      forUpdate() { return q; },
      whereNot(cond) { filters.push((r) => !Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      orderBy(col, dir) { order = { col, dir }; return q; },
      first: async () => {
        let rows = rowsNow().filter(match);
        if (order) rows = [...rows].sort((x, y) => (order.dir === 'desc' ? y[order.col] - x[order.col] : x[order.col] - y[order.col]));
        return rows[0] ? { ...rows[0] } : undefined;
      },
      update: async (patch) => { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      insert(row) {
        const created = { id: `${table}-${rowsNow().length + 1}`, ...row };
        (db[table] = rowsNow()).push(created);
        const p = Promise.resolve([1]);
        p.returning = async () => [{ ...created }];
        return p;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t in db };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const seed = (includedFollowups) => ({
  pricing_config: [{ config_key: 'rodent_trapping', data: JSON.stringify({ included_followups: includedFollowups, emergency_multiplier: 1.2 }) }],
  pricing_config_audit: [],
  system_settings: [],
  email_templates: [{ id: 't1', template_key: 'prep.rodent', active_version_id: 'v1' }],
  email_template_versions: [{ id: 'v1', template_id: 't1', version_number: 1, status: 'active', subject: 'S', preview_text: 'P', blocks: JSON.stringify(rodentBlocks()), validation_snapshot: JSON.stringify({ source: 'migration:20260924000007' }) }],
});
const cfg = (db) => JSON.parse(db.pricing_config[0].data);
const activeBlocks = (db) => db.email_template_versions.find((v) => v.id === db.email_templates[0].active_version_id).blocks;

describe('20260927000003 rodent trap check follow-ups + neutral prep', () => {
  test('supersedes exactly the 000002 line', () => {
    expect(PRIOR_LINE).toBe(prep2.NEW_LINE);
  });

  test('neutral line: no price, no "per visit", no "billed", no "unlimited"', () => {
    expect(NEUTRAL_LINE).not.toMatch(/\$|\d+ ?dollars/);
    expect(NEUTRAL_LINE).not.toMatch(/per visit/i);
    expect(NEUTRAL_LINE).not.toMatch(/billed|unlimited|\bsafe\b/i);
  });

  test('a numeric allowance becomes 1 with an audit row; down() restores it', async () => {
    const db = seed(3);
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(cfg(db)).toMatchObject({ included_followups: 1, emergency_multiplier: 1.2 });
    expect(db.pricing_config_audit).toHaveLength(1);
    await migration.down(knex);
    expect(cfg(db).included_followups).toBe(3);
    expect(db.system_settings).toHaveLength(0);
  });

  test('an allowance already at 1 is untouched', async () => {
    const db = seed(1);
    await migration.up(fakeKnex(db));
    expect(db.pricing_config_audit).toHaveLength(0);
  });

  test('after 000002, the guide line becomes neutral; down() restores the 000002 version', async () => {
    const db = seed(1);
    const knex = fakeKnex(db);
    await prep2.up(knex);
    const after2 = db.email_templates[0].active_version_id;
    await migration.up(knex);
    const blocks = activeBlocks(db);
    expect(blocks).toContain(JSON.stringify(NEUTRAL_LINE).slice(1, -1));
    expect(blocks).not.toContain(JSON.stringify(PRIOR_LINE).slice(1, -1));
    const active = db.email_template_versions.find((v) => v.id === db.email_templates[0].active_version_id);
    expect(JSON.parse(active.validation_snapshot).source).toBe(MIGRATION_MARKER);

    await migration.down(knex);
    expect(db.email_templates[0].active_version_id).toBe(after2);
  });

  test('a guide without the 000002 line is left alone', async () => {
    const db = seed(1);
    await migration.up(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(1);
  });
});
