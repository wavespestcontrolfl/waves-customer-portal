/**
 * 20261010130000 corrects two staff-facing catalog notes that state limits the enforced rules do not have (Codex round 9
 * on #6135): Snapshot "two applications a year" (the rule is 4 in 12 months, 60 days apart) and Acelepryn "(April)" (the rule
 * is once in 12 months, any month). Only a note that still equals the text 20261008200000 wrote is rewritten.
 */
const migration = require('../models/migrations/20261010130000_area_addon_catalog_notes_fix');
const first = require('../models/migrations/20261008200000_area_addon_catalog_rows');
const { AREA_ADDONS } = require('../services/pricing-engine/constants');

function fakeKnex(services, settings = []) {
  const tables = { services, system_settings: settings };
  const knex = (table) => {
    const preds = [];
    let updated = 0;
    const q = {
      where(cond) { preds.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      first() { return Promise.resolve(tables[table].find((r) => preds.every((p) => p(r)))); },
      async update(patch) { for (const r of tables[table].filter((x) => preds.every((p) => p(x)))) { Object.assign(r, patch); updated += 1; } return updated; },
      insert(row) { tables[table].push({ ...row }); return Promise.resolve(); },
      async del() { for (const r of tables[table].filter((x) => preds.every((p) => p(x)))) tables[table].splice(tables[table].indexOf(r), 1); },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => !!tables[t] };
  knex.tables = tables;
  return knex;
}

describe('the corrected notes state the enforced rules', () => {
  test('the new text matches AREA_ADDONS (4 in 12 months, 60 days apart; once in 12 months, any month)', () => {
    const snap = migration.NOTES.find((n) => n.serviceKey === 'area_addon_bed_pre_emergent');
    const acel = migration.NOTES.find((n) => n.serviceKey === 'area_addon_lawn_insect_preventive');
    expect(AREA_ADDONS.items.bed_pre_emergent).toMatchObject({ maxPerYear: 4, minDaysApart: 60 });
    expect(snap.after).toContain('4 applications');
    expect(snap.after).toContain('at least 60 days apart');
    expect(snap.after).not.toMatch(/two applications/);
    expect(AREA_ADDONS.items.lawn_insect_preventive.maxPerYear).toBe(1);
    expect(acel.after).toContain('once in 12 months, any month');
    expect(acel.after).toContain('April is the best time, not a limit');
    expect(acel.after).not.toMatch(/once a year \(April\)/);
  });

  test('the "before" text is exactly what the first migration wrote', () => {
    const src = require('fs').readFileSync(require.resolve('../models/migrations/20261008200000_area_addon_catalog_rows'), 'utf8');
    for (const note of migration.NOTES) expect(src).toContain(note.before);
    expect(first).toBeDefined();
  });
});

describe('up and down', () => {
  const rows = () => migration.NOTES.map((n, i) => ({ id: `s${i}`, service_key: n.serviceKey, internal_notes: n.before }));

  test('rewrites a note that still equals the original, records the keys, is idempotent', async () => {
    const knex = fakeKnex(rows());
    await migration.up(knex);
    await migration.up(knex);
    expect(knex.tables.services.map((r) => r.internal_notes)).toEqual(migration.NOTES.map((n) => n.after));
    expect(JSON.parse(knex.tables.system_settings[0].value).services).toEqual(migration.NOTES.map((n) => n.serviceKey));
  });

  test('a note staff already edited is never touched, and not recorded', async () => {
    const data = rows();
    data[0].internal_notes = 'Edited by staff.';
    const knex = fakeKnex(data);
    await migration.up(knex);
    expect(knex.tables.services[0].internal_notes).toBe('Edited by staff.');
    expect(JSON.parse(knex.tables.system_settings[0].value).services).toEqual(['area_addon_lawn_insect_preventive']);
  });

  test('down restores only the notes it changed, and only while they still hold the corrected text', async () => {
    const knex = fakeKnex(rows());
    await migration.up(knex);
    knex.tables.services[1].internal_notes = 'Edited after the fix.';
    await migration.down(knex);
    expect(knex.tables.services[0].internal_notes).toBe(migration.NOTES[0].before);
    expect(knex.tables.services[1].internal_notes).toBe('Edited after the fix.');
    expect(knex.tables.system_settings).toEqual([]);
  });

  test('a missing services table is skipped', async () => {
    const knex = fakeKnex(rows());
    knex.schema = { hasTable: async () => false };
    await migration.up(knex);
    await migration.down(knex);
    expect(knex.tables.services[0].internal_notes).toBe(migration.NOTES[0].before);
  });
});
