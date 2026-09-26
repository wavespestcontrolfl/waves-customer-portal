/**
 * 20260927000002 — prep.rodent: the "follow-up visits are part of the
 * service" line becomes the 2-visit rule (owner ruling 2026-09-26: $350
 * trapping covers setup + 1 trap check; more checks are billed). Only that
 * line changes; the effective v3 content (latest chain file) is the input.
 */
const v3 = require('../models/migrations/20260924000007_prep_guide_content_v3_codex_r6');
const migration = require('../models/migrations/20260927000002_prep_guide_rodent_trap_check_copy');

const { OLD_LINE, NEW_LINE, MIGRATION_MARKER } = migration;
const rodentBlocks = () => v3.TEMPLATES.find((t) => t.key === 'prep.rodent').blocks;

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const rowsNow = () => db[table] || [];
    const match = (r) => filters.every((f) => f(r));
    let order = null;
    const q = {
      where(cond) { filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      whereNot(cond) { filters.push((r) => !Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      orderBy(col, dir) { order = { col, dir }; return q; },
      first: async () => {
        let rows = rowsNow().filter(match);
        if (order) rows = [...rows].sort((a, b) => (order.dir === 'desc' ? b[order.col] - a[order.col] : a[order.col] - b[order.col]));
        return rows[0] ? { ...rows[0] } : undefined;
      },
      update: async (patch) => { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      insert(row) {
        const created = { id: `v${rowsNow().length + 1}`, ...row };
        (db[table] = rowsNow()).push(created);
        return { returning: async () => [{ ...created }] };
      },
    };
    // version_number '<' filter used by down()
    const origWhere = q.where;
    q.where = (a, op, val) => {
      if (typeof a === 'string' && op === '<') { filters.push((r) => r[a] < val); return q; }
      return origWhere(a);
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => t in db };
  return knex;
}

const seed = (blocks = rodentBlocks()) => ({
  email_templates: [{ id: 't1', template_key: 'prep.rodent', active_version_id: 'v1' }],
  email_template_versions: [{ id: 'v1', template_id: 't1', version_number: 1, status: 'active', subject: 'S', preview_text: 'P', blocks: JSON.stringify(blocks), validation_snapshot: JSON.stringify({ source: 'migration:20260924000007' }) }],
});

describe('20260927000002 prep.rodent trap check copy', () => {
  test('the effective v3 guide still carries the line being replaced', () => {
    expect(JSON.stringify(rodentBlocks())).toContain(JSON.stringify(OLD_LINE));
  });

  test('new line keeps the guide compliance rules (no price, no "per visit", no "safe")', () => {
    expect(NEW_LINE).not.toMatch(/\$|\d+ ?dollars/);
    expect(NEW_LINE).not.toMatch(/per visit/i);
    expect(NEW_LINE).not.toMatch(/\bsafe\b/i);
    expect(NEW_LINE).not.toMatch(/unlimited/i);
  });

  test('up() publishes a new active version with only that line swapped; down() restores the prior', async () => {
    const db = seed();
    await migration.up(fakeKnex(db));
    const tpl = db.email_templates[0];
    expect(tpl.active_version_id).not.toBe('v1');
    const next = db.email_template_versions.find((v) => v.id === tpl.active_version_id);
    expect(next.status).toBe('active');
    expect(next.version_number).toBe(2);
    expect(JSON.parse(next.validation_snapshot).source).toBe(MIGRATION_MARKER);
    const blocks = JSON.parse(next.blocks);
    const expected = JSON.parse(JSON.stringify(rodentBlocks()).split(JSON.stringify(OLD_LINE)).join(JSON.stringify(NEW_LINE)));
    expect(blocks).toEqual(expected);
    expect(db.email_template_versions.find((v) => v.id === 'v1').status).toBe('archived');

    await migration.down(fakeKnex(db));
    expect(db.email_templates[0].active_version_id).toBe('v1');
    expect(db.email_template_versions.find((v) => v.id === 'v1').status).toBe('active');
  });

  test('an admin-rewritten guide (line absent) is left alone', async () => {
    const db = seed([{ type: 'paragraph', content: 'Custom rodent guide' }]);
    await migration.up(fakeKnex(db));
    expect(db.email_template_versions).toHaveLength(1);
    expect(db.email_templates[0].active_version_id).toBe('v1');
  });
});
