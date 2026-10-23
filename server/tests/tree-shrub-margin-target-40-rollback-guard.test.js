/**
 * 20261021010000 down(): reverting the Tree & Shrub margin target to 0.45 only
 * when this migration's own audit row is still the LATEST activity on
 * `global_margin_target_ts`. The current value alone cannot prove ownership:
 * an admin who tuned the row after the migration and later deliberately set
 * it back to 0.40 keeps their choice (Codex #6398 r12). The real migration
 * runs against a tiny in-memory knex (pricing_config + pricing_config_audit +
 * pricing_changelog).
 */
const migration = require('../models/migrations/20261021010000_tree_shrub_margin_target_40');
const truth = require('../models/migrations/20261022000000_tree_shrub_margin_changelog_truth');

const KEY = 'global_margin_target_ts';
const TAG = 'migration:20261021010000_tree_shrub_margin_target_40';

function fakeKnex(db) {
  let seq = 0;
  const knex = (table) => {
    const preds = [];
    let order = null;
    const test = (r) => preds.every((p) => p(r));
    const matches = () => {
      const hits = db[table].filter(test);
      if (order) hits.sort((a, b) => (order.dir === 'desc' ? b[order.col] - a[order.col] : a[order.col] - b[order.col]));
      return hits;
    };
    const q = {
      where(a, b) {
        if (typeof a === 'string') preds.push((r) => r[a] === b);
        else preds.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        return q;
      },
      whereRaw(sql, bindings = []) {
        const m = sql.match(/summary LIKE '(.+)%'/);
        const prefix = m ? m[1] : String(bindings[0] || '').replace(/%$/, '');
        preds.push((r) => String(r.summary || '').startsWith(prefix));
        return q;
      },
      orderBy(col, dir) { order = { col, dir }; return q; },
      first: async (...cols) => {
        const hit = matches()[0];
        if (!hit) return undefined;
        return cols.length ? Object.fromEntries(cols.map((c) => [c, hit[c]])) : { ...hit };
      },
      update: async (patch) => { const hits = matches(); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const before = db[table].length; db[table] = db[table].filter((r) => !test(r)); return before - db[table].length; },
      insert: async (row) => { db[table].push({ id: ++seq, ...row }); },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t) };
  knex.fn = { now: () => new Date('2026-10-21T12:00:00Z') };
  return knex;
}

function freshDb() {
  return {
    pricing_config: [{ config_key: KEY, data: JSON.stringify({ value: 0.45, semantics: 'margin_admin_inclusive' }) }],
    pricing_config_audit: [],
    pricing_changelog: [],
  };
}
const value = (db) => JSON.parse(db.pricing_config[0].data).value;
async function adminSets(knex, db, v) {
  const data = JSON.parse(db.pricing_config[0].data);
  await knex('pricing_config').where({ config_key: KEY }).update({ data: JSON.stringify({ ...data, value: v }) });
  await knex('pricing_config_audit').insert({ config_key: KEY, old_value: db.pricing_config[0].data, new_value: JSON.stringify({ ...data, value: v }), changed_by: 'admin:adam', reason: 'tuned in /admin pricing' });
}

describe('20261021010000 Tree & Shrub margin target rollback', () => {
  test('up moves the v4.6 row to 0.40 and down reverts it while the migration is the latest edit', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    expect(value(db)).toBe(0.40);
    expect(db.pricing_changelog).toHaveLength(1);
    await migration.down(knex);
    expect(value(db)).toBe(0.45);
    expect(db.pricing_changelog).toHaveLength(0);
    expect(db.pricing_config_audit.map((r) => r.changed_by)).toEqual([TAG, TAG]);
  });

  test('an admin who tuned the row after the migration and returned it to 0.40 keeps their value on rollback', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    await adminSets(knex, db, 0.42);
    await adminSets(knex, db, 0.40);
    await migration.down(knex);
    expect(value(db)).toBe(0.40);
    expect(db.pricing_config_audit.filter((r) => r.changed_by === TAG)).toHaveLength(1);
  });

  test('the changelog-truth migration trusts the UP audit only while it is the latest activity (Codex #6398 r21)', async () => {
    // Straight deploy: moved, audit is latest → changelog untouched.
    const clean = freshDb();
    const k1 = fakeKnex(clean);
    await migration.up(k1);
    await truth.up(k1);
    expect(clean.pricing_changelog[0].summary).toMatch(/^Tree & Shrub margin target 0\.45 -> 0\.40 \(admin-inclusive\)/);
    // Moved, admin tuned afterwards, stack rolled back (value preserved) and
    // re-applied: 20261021010000 preserves 0.42 but re-inserts the "cut"
    // changelog while its historical UP audit still exists — the truth
    // migration must rewrite that fresh row to the preserved wording.
    const replayed = freshDb();
    const k2 = fakeKnex(replayed);
    await migration.up(k2);
    await adminSets(k2, replayed, 0.42);
    await truth.down(k2);
    await migration.down(k2);
    expect(value(replayed)).toBe(0.42);
    await migration.up(k2);
    await truth.up(k2);
    expect(value(replayed)).toBe(0.42);
    expect(replayed.pricing_changelog).toHaveLength(1);
    expect(replayed.pricing_changelog[0].summary).toContain('(0.42) was preserved and still governs live pricing');
  });

  test('an admin value other than 0.40 is never touched; up skips a row an admin already tuned', async () => {
    const db = freshDb();
    const knex = fakeKnex(db);
    await adminSets(knex, db, 0.38);
    await migration.up(knex);
    expect(value(db)).toBe(0.38);
    await migration.down(knex);
    expect(value(db)).toBe(0.38);
  });
});
