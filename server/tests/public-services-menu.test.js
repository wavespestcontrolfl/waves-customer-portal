/**
 * C2 — public services menu + keyed leads.
 *  - the menu is built ONLY from active, non-archived, public_quote_selectable rows;
 *  - items carry service_key / catalog name / family / mode / cadence /
 *    public_instant_quote and NEVER an engine key;
 *  - Rodent Inspection is instant ($75 flat, owner ruling 2026-08-29);
 *  - lead intake accepts an optional serviceKey, shape-checked, and the
 *    handler keeps it only when the catalog says it is publicly selectable.
 */
const { loadPublicServicesMenu, isPublicSelectableServiceKey, publicSelectableService, menuItem, PUBLIC_INSTANT_QUOTE_KEYS } = require('../services/public-services-menu');

function fakeConn(rows, { hasColumn = true, throws = false } = {}) {
  const conn = () => {
    let filters = {};
    const q = {
      where(cond) { filters = { ...filters, ...cond }; return q; },
      orderBy() { return q; },
      async select() { if (throws) throw new Error('db down'); return rows.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)).map((r) => ({ ...r })); },
      async first() { if (throws) throw new Error('db down'); const r = rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v)); return r ? { id: r.id, service_key: r.service_key, name: r.name } : null; },
    };
    return q;
  };
  conn.schema = { hasColumn: async () => hasColumn };
  return conn;
}
const row = (o) => ({ id: 'id-' + o.service_key, is_active: true, is_archived: false, public_quote_selectable: true, category: 'pest_control', billing_type: 'one_time', frequency: null, visits_per_year: null, description: null, engine_keys: ['secret_engine_key'], ...o });

describe('public services menu', () => {
  test('only active, non-archived, selectable rows; engine keys never on the wire', async () => {
    const items = await loadPublicServicesMenu(fakeConn([
      row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service', category: 'inspection' }),
      row({ service_key: 'pest_re_service', name: 'Pest Control Re-Service', public_quote_selectable: false }),
      row({ service_key: 'termite_inspection', name: 'Termite Inspection Service', category: 'inspection', is_archived: true, is_active: false }),
      row({ service_key: 'pest_general_bimonthly', name: 'Bi-Monthly Pest Control Service', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6 }),
    ]));
    expect(items.map((i) => i.service_key)).toEqual(['wdo_inspection', 'pest_general_bimonthly']);
    for (const i of items) { expect(JSON.stringify(i)).not.toContain('engine'); expect(i.name).toMatch(/Service$/); expect(i).not.toHaveProperty('description'); }
  });
  test('modes, cadence and family labels', () => {
    expect(menuItem(row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service', category: 'inspection' }))).toMatchObject({ mode: 'inspection', family: 'Inspections', public_instant_quote: false });
    expect(menuItem(row({ service_key: 'pest_general_bimonthly', name: 'Bi-Monthly Pest Control Service', billing_type: 'recurring', frequency: 'bimonthly', visits_per_year: 6 })))
      .toMatchObject({ mode: 'recurring', family: 'Pest Control', cadence: { key: 'bimonthly', label: 'Bi-Monthly', visits_per_year: 6 }, public_instant_quote: true });
    expect(menuItem(row({ service_key: 'termite_liquid', name: 'Termite Liquid Treatment Service', category: 'termite' }))).toMatchObject({ mode: 'one_time', family: 'Termite', public_instant_quote: false });
  });
  test('Rodent Inspection is instant ($75 flat); WDO is quote-on-request', () => {
    expect(PUBLIC_INSTANT_QUOTE_KEYS.has('rodent_inspection')).toBe(true);
    expect(PUBLIC_INSTANT_QUOTE_KEYS.has('wdo_inspection')).toBe(false);
  });
  test('menu is empty (not an error) before the column exists', async () => {
    expect(await loadPublicServicesMenu(fakeConn([row({ service_key: 'x', name: 'X Service' })], { hasColumn: false }))).toEqual([]);
  });
});

describe('keyed leads', () => {
  const { _test } = require('../routes/lead-webhook');
  test('serviceKey is shape-checked on intake', () => {
    expect(_test.normalizeLeadServiceKey({ serviceKey: 'WDO_Inspection' })).toBe('wdo_inspection');
    expect(_test.normalizeLeadServiceKey({ service_key: 'pest_general_bimonthly' })).toBe('pest_general_bimonthly');
    expect(_test.normalizeLeadServiceKey({ serviceKey: 'drop table;' })).toBeNull();
    expect(_test.normalizeLeadServiceKey({})).toBeNull();
  });
  test('only a publicly selectable, active key is accepted; failures fail closed', async () => {
    const rows = [row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service' }), row({ service_key: 'pest_re_service', name: 'Re', public_quote_selectable: false })];
    expect(await isPublicSelectableServiceKey('wdo_inspection', fakeConn(rows))).toBe(true);
    expect(await isPublicSelectableServiceKey('pest_re_service', fakeConn(rows))).toBe(false);
    expect(await isPublicSelectableServiceKey('nope', fakeConn(rows))).toBe(false);
    expect(await isPublicSelectableServiceKey('wdo_inspection', fakeConn(rows, { throws: true }))).toBe(false);
    expect(await isPublicSelectableServiceKey('wdo_inspection', fakeConn(rows, { hasColumn: false }))).toBe(false);
  });
  test('a keyed lead derives its label from the catalog name (identity wins over the submitted label)', async () => {
    const rows = [row({ service_key: 'wdo_inspection', name: 'WDO Inspection Service' })];
    expect(await publicSelectableService('wdo_inspection', fakeConn(rows))).toEqual({ service_key: 'wdo_inspection', name: 'WDO Inspection Service' });
    expect(await publicSelectableService('pest_re_service', fakeConn(rows))).toBeNull();
  });
});

describe('instant-quote set stays in step with the public quote engine', () => {
  const { PUBLIC_QUOTE_SERVICE_KEYS } = require('../routes/public-quote');
  // service_key → the /calculate service key that prices it
  const PATH_FOR = {
    pest_general_quarterly: 'pest', pest_general_bimonthly: 'pest', pest_general_monthly: 'pest', pest_general_semiannual: 'pest',
    one_time_pest_control: 'oneTimePest', pest_initial_cleanout: 'oneTimePest',
    lawn_care_quarterly: 'lawn', lawn_care_recurring: 'lawn', lawn_care_6week: 'lawn', lawn_care_monthly: 'lawn', lawn_care_one_time: 'oneTimeLawn',
    dethatching: 'dethatching', plugging: 'plugging', top_dressing: 'topDressing',
    mosquito_monthly: 'mosquito', mosquito_seasonal: 'mosquito',
    tree_shrub_quarterly: 'treeShrub', tree_shrub_program: 'treeShrub', tree_shrub_6week: 'treeShrub', palm_injection: 'palm',
    rodent_bait_quarterly: 'rodentBait', rodent_trapping: 'rodentTrapping', rodent_exclusion_only: 'exclusion',
    rodent_sanitation_light: 'sanitation', rodent_sanitation_standard: 'sanitation', rodent_sanitation_heavy: 'sanitation',
    flea_tick: 'flea', bed_bug_treatment: 'bedBug', bee_wasp_removal: 'stinging',
    termite_bait: 'termite', termite_trenching: 'trenching', termite_slab_pretreat: 'preSlab',
    rodent_inspection: 'rodentInspection',
  };
  test('every instant service_key maps to a /calculate service key the route accepts', () => {
    for (const key of PUBLIC_INSTANT_QUOTE_KEYS) {
      const path = PATH_FOR[key];
      expect({ key, path }).toEqual({ key, path: expect.any(String) });
      expect({ key, accepted: PUBLIC_QUOTE_SERVICE_KEYS.includes(path) }).toEqual({ key, accepted: true });
    }
  });
  test('a product with no public engine path is never advertised as instant', () => {
    expect(PUBLIC_INSTANT_QUOTE_KEYS.has('mosquito_one_time')).toBe(false);
    expect(PUBLIC_INSTANT_QUOTE_KEYS.has('wdo_inspection')).toBe(false);
  });
});
