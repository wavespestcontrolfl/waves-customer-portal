// Guards the bahia broadleaf/CarbonPro correction migration (20260701000001) with a
// stateful mock knex (no DB): asserts the catalog label add, the CarbonPro rate, the
// bahia SpeedZone re-rate/gate, and the March SpeedZone insert.
const mig = require('../models/migrations/20260701000001_bahia_broadleaf_and_carbonpro_corrections.js');

function makeKnex(state) {
  function qb(table) {
    const conds = [];
    let rawLike = null;
    function rows() {
      let list = state[table] || [];
      for (const c of conds) {
        if (c.__in) { const [col, vals] = c.__in; list = list.filter((r) => vals.includes(r[col])); }
        else { list = list.filter((r) => Object.entries(c).every(([k, v]) => r[k] === v)); }
      }
      if (rawLike) { const p = rawLike.replace(/%/g, '').toLowerCase(); list = list.filter((r) => String(r.name || '').toLowerCase().includes(p)); }
      return list;
    }
    const b = {
      where(c) { conds.push(c); return b; },
      whereRaw(_sql, params) { rawLike = params[0]; return b; },
      whereIn(col, vals) { conds.push({ __in: [col, vals] }); return b; },
      orderBy() { return b; },
      select() { return Promise.resolve(rows()); },
      first() { return Promise.resolve(rows()[0] || null); },
      update(u) { const m = rows(); m.forEach((r) => Object.assign(r, u)); return Promise.resolve(m.length); },
      insert(row) { state[table].push({ id: `new-${state[table].length}`, ...row }); return Promise.resolve([1]); },
      then(res, rej) { return Promise.resolve(rows()).then(res, rej); },
    };
    return b;
  }
  const knex = (t) => qb(t);
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'NOW()' };
  return knex;
}

function seed() {
  const bahiaWindows = ['jan_pre_m_irrigation_class', 'mar_n1_pre_m', 'apr_insect_fire_ant', 'sep_blackout_crabgrass', 'nov_winter_k']
    .map((k) => ({ id: `w-${k}`, window_key: k, lawn_protocol_id: 'bahia-p' }));
  return {
    products_catalog: [{ id: 'sz', name: 'SpeedZone Southern', labeled_turf_species: JSON.stringify(['bermuda', 'zoysia', 'st_augustine_select_cultivars']) }],
    lawn_protocols: [{ id: 'bahia-p', grass_track: 'bahia', status: 'active', effective_from: '2026-06-30', created_at: '2026-06-30' }],
    lawn_protocol_windows: bahiaWindows,
    lawn_protocol_products: [
      { id: 'c1', product_name: 'CarbonPro-L', gates: JSON.stringify({}), lawn_protocol_window_id: 'bz-may' },
      { id: 'c2', product_name: 'CarbonPro-L', gates: JSON.stringify({ premiumTier: true }), lawn_protocol_window_id: 'bz-dec' },
      { id: 's-jan', product_name: 'SpeedZone Southern + NIS', lawn_protocol_window_id: 'w-jan_pre_m_irrigation_class', gates: JSON.stringify({ gateProduct: 'SpeedZone', maxTempF: 90, bahiaLabelUnverified: true }) },
      { id: 's-sep', product_name: 'SpeedZone Southern + NIS', lawn_protocol_window_id: 'w-sep_blackout_crabgrass', gates: JSON.stringify({ gateProduct: 'SpeedZone', maxTempF: 90, bahiaLabelUnverified: true }) },
    ],
  };
}

describe('bahia broadleaf + CarbonPro correction migration', () => {
  let state;
  beforeAll(async () => { state = seed(); await mig.up(makeKnex(state)); });

  test('A) SpeedZone catalog now labels bahia (Drive/Celsius unaffected)', () => {
    const labeled = JSON.parse(state.products_catalog[0].labeled_turf_species);
    expect(labeled).toContain('bahia');
    // idempotent shape: existing entries preserved, no duplicate
    expect(labeled.filter((t) => t === 'bahia')).toHaveLength(1);
    expect(labeled).toContain('bermuda');
  });

  test('B) CarbonPro-L rate is 1.375 with label range on the gate, premium flag preserved', () => {
    const carbon = state.lawn_protocol_products.filter((p) => p.product_name === 'CarbonPro-L');
    expect(carbon).toHaveLength(2);
    carbon.forEach((p) => {
      expect(p.rate_per_1000).toBe(1.375);
      const g = JSON.parse(p.gates);
      expect(g.minLabelRate).toBe(1.0);
      expect(g.maxLabelRate).toBe(2.0);
    });
    expect(JSON.parse(state.lawn_protocol_products.find((p) => p.id === 'c2').gates).premiumTier).toBe(true);
  });

  test('C) bahia SpeedZone re-rated to 1.0, label-unverified flag dropped, spot cap added', () => {
    const sz = state.lawn_protocol_products.filter((p) => p.product_name === 'SpeedZone Southern + NIS'
      && p.lawn_protocol_window_id.startsWith('w-'));
    expect(sz.length).toBeGreaterThanOrEqual(2);
    sz.forEach((p) => {
      expect(p.rate_per_1000).toBe(1.0);
      const g = JSON.parse(p.gates);
      expect(g.bahiaLabelUnverified).toBeUndefined();
      expect(g.spotAreaCapSqFtPerAcre).toBe(1000);
      expect(g.establishedTurfOnly).toBe(true);
      expect(g.maxTempF).toBe(90);
    });
  });

  test('D) March broadleaf-cleanup SpeedZone row inserted (conditional, mapped, spot-capped)', () => {
    const mar = state.lawn_protocol_products.find((p) => p.lawn_protocol_window_id === 'w-mar_n1_pre_m'
      && p.product_name === 'SpeedZone Southern + NIS');
    expect(mar).toBeTruthy();
    expect(mar.default_in_plan).toBe(false);
    expect(mar.product_id).toBe('sz');
    expect(mar.rate_per_1000).toBe(1.0);
    expect(JSON.parse(mar.gates).trigger).toBe('broadleaf_heavy');
    expect(JSON.parse(mar.gates).spotAreaCapSqFtPerAcre).toBe(1000);
  });
});
