/**
 * 20260903000020 — office-only rows (Tier C) leave the public quote menu; the
 * public products next to them stay; admin re-selections survive reruns;
 * down() is a no-op.
 */
const hide = require('../models/migrations/20260903000020_public_quote_menu_tier_c_hide');
const selectable = require('../models/migrations/20260829000020_services_public_quote_selectable');
const { FORMERLY_PUBLIC_KEYS } = require('../services/public-services-menu');

function fakeKnex(db) {
  const knex = (table) => {
    const rows = () => (db[table] = db[table] || []);
    const filters = [];
    const matches = (r) => filters.every((f) => f(r));
    const q = {
      where(cond, val) {
        if (typeof cond === 'string') filters.push((r) => r[cond] === val);
        else filters.push((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
        return q;
      },
      whereIn(col, vals) { filters.push((r) => vals.includes(r[col])); return q; },
      select() { return Promise.resolve(rows().filter(matches).map((r) => ({ ...r }))); },
      async first() { const r = rows().find(matches); return r ? { ...r } : null; },
      async update(patch) { let n = 0; for (const r of rows()) if (matches(r)) { Object.assign(r, patch); n++; } return n; },
      async del() { const keep = rows().filter((r) => !matches(r)); const n = rows().length - keep.length; db[table] = keep; return n; },
      async insert(row) { rows().push({ ...row }); return [row]; },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => t === 'services' || t === 'system_settings',
    hasColumn: async () => true,
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const svc = (key, id, selectable = true) => ({ id, service_key: key, public_quote_selectable: selectable });

// The public products that must survive next to each hidden group.
const STAYS = [
  'pest_general_quarterly', 'pest_general_bimonthly', 'pest_general_monthly', 'one_time_pest_control',
  'cockroach_control', 'german_roach',
  'lawn_care_recurring', 'lawn_care_6week', 'lawn_care_monthly', 'lawn_care_one_time', 'lawn_pest_knockdown',
  'dethatching', 'plugging', 'top_dressing',
  'mosquito_seasonal', 'mosquito_monthly', 'mosquito_one_time',
  'tree_shrub_quarterly', 'tree_shrub_program', 'tree_shrub_6week', 'palm_injection',
  'termite_bait', 'termite_liquid', 'termite_trenching', 'termite_slab_pretreat', 'bora_care',
  'rodent_inspection', 'rodent_trapping', 'rodent_bait_quarterly', 'rodent_exclusion',
  'flea_tick', 'bed_bug_treatment', 'bee_wasp_removal', 'fire_ant', 'wildlife_trapping', 'wdo_inspection',
];

describe('20260903000020 Tier C rows leave the public quote menu', () => {
  test('every hidden key is a real 2026-08-29 selectable key (no typos hide nothing silently)', () => {
    for (const k of hide.HIDE_KEYS) expect({ k, known: selectable.SELECTABLE_KEYS.includes(k) }).toEqual({ k, known: true });
  });

  test('CONTRACT: every hidden key stays accepted on /calculate as quote-on-request (cached pages, stale snapshot)', () => {
    expect([...FORMERLY_PUBLIC_KEYS].sort()).toEqual([...hide.HIDE_KEYS].sort());
  });

  test('flips exactly the ruled rows; every public product beside them stays selectable', async () => {
    let id = 0;
    const db = {
      services: [...hide.HIDE_KEYS, ...STAYS].map((k) => svc(k, ++id)),
      system_settings: [],
    };
    await hide.up(fakeKnex(db));
    const flag = (k) => db.services.find((r) => r.service_key === k).public_quote_selectable;
    for (const k of hide.HIDE_KEYS) expect({ k, selectable: flag(k) }).toEqual({ k, selectable: false });
    for (const k of STAYS) expect({ k, selectable: flag(k) }).toEqual({ k, selectable: true });
    expect(JSON.parse(db.system_settings[0].value).hiddenIds).toHaveLength(hide.HIDE_KEYS.length);
  });

  test('a rerun never re-hides a row an admin re-selected; down() is a no-op', async () => {
    const db = { services: [svc('pest_general_semiannual', 1), svc('german_roach_initial', 2)], system_settings: [] };
    const knex = fakeKnex(db);
    await hide.up(knex);
    db.services[0].public_quote_selectable = true; // admin re-selected in the Service Library
    await hide.up(knex);
    expect(db.services[0].public_quote_selectable).toBe(true);
    expect(db.services[1].public_quote_selectable).toBe(false);
    await hide.down(knex);
    expect(db.services[1].public_quote_selectable).toBe(false);
    expect(db.system_settings).toHaveLength(1);
  });
});
