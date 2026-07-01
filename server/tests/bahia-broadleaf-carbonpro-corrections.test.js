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
      del() { const m = rows(); const ids = new Set(m.map((r) => r.id)); state[table] = (state[table] || []).filter((r) => !ids.has(r.id)); return Promise.resolve(m.length); },
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
  // stale B1 windows that still name Drive XLR8 / Celsius in title/goal/tasks
  const STALE = {
    may_micros_crabgrass: { title: 'May Micros + K (Irrigated) + Crabgrass Curative', goal: 'crabgrass curative Drive XLR8 if breakthrough.', tasks: ['route_by_ordinance_zone', 'crabgrass_curative_gate', 'irrigation_status_product_load'] },
    jul_seed_head: { title: 'July Blackout + Seed Head Customer Talk', goal: 'Celsius app 2; structured seed-head talk.', tasks: ['blackout_zero_np', 'seed_head_customer_talk', 'heat_stress_herbicide_gate'] },
    sep_blackout_crabgrass: { title: 'September Blackout Closeout + Crabgrass Curative', goal: 'SpeedZone weather-gated; crabgrass curative Drive XLR8.', tasks: ['blackout_zero_np', 'crabgrass_curative_gate', 'speedzone_weather_gate'] },
  };
  const bahiaWindows = ['jan_pre_m_irrigation_class', 'mar_n1_pre_m', 'apr_insect_fire_ant', 'may_micros_crabgrass', 'jul_seed_head', 'sep_blackout_crabgrass', 'nov_winter_k']
    .map((k) => {
      const s = STALE[k];
      return {
        id: `w-${k}`, window_key: k, lawn_protocol_id: 'bahia-p',
        title: s ? s.title : 'title', goal: s ? s.goal : 'goal',
        required_tasks: JSON.stringify(s ? s.tasks : []),
        assessment_bridge: JSON.stringify({ writeExpectedWindow: true, requiredTasks: s ? s.tasks : [] }),
        service_report_context: JSON.stringify({ title: s ? s.title : k, goal: s ? s.goal : 'goal' }),
      };
    });
  return {
    lawn_protocol_gates: [
      { id: 'g-heat', lawn_protocol_id: 'bahia-p', gate_key: 'speedzone_heat_gate', rule_text: 'Do not apply SpeedZone Southern above 90°F; use Celsius WG for hot-season broadleaf.' },
      { id: 'g-cel', lawn_protocol_id: 'bahia-p', gate_key: 'celsius_annual_rate', rule_text: 'Track total Celsius WG per 365 days; block when annual maximum would be exceeded.' },
    ],
    products_catalog: [{ id: 'sz', name: 'SpeedZone Southern', labeled_turf_species: JSON.stringify(['bermuda', 'zoysia', 'st_augustine_select_cultivars']) }],
    lawn_protocols: [{ id: 'bahia-p', grass_track: 'bahia', status: 'active', effective_from: '2026-06-30', created_at: '2026-06-30' }],
    lawn_protocol_windows: bahiaWindows,
    lawn_protocol_products: [
      { id: 'c1', product_name: 'CarbonPro-L', gates: JSON.stringify({}), lawn_protocol_window_id: 'bz-may' },
      { id: 'c2', product_name: 'CarbonPro-L', gates: JSON.stringify({ premiumTier: true }), lawn_protocol_window_id: 'bz-dec' },
      { id: 's-jan', product_name: 'SpeedZone Southern + NIS', lawn_protocol_window_id: 'w-jan_pre_m_irrigation_class', rate_per_1000: 1.1, gates: JSON.stringify({ gateProduct: 'SpeedZone', maxTempF: 90, bahiaLabelUnverified: true }) },
      { id: 's-sep', product_name: 'SpeedZone Southern + NIS', lawn_protocol_window_id: 'w-sep_blackout_crabgrass', rate_per_1000: 1.1, gates: JSON.stringify({ gateProduct: 'SpeedZone', maxTempF: 90, bahiaLabelUnverified: true }) },
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

  test('C) bahia SpeedZone keeps catalog rate 1.1; label-unverified dropped; spot cap + preferred-rate metadata', () => {
    const sz = state.lawn_protocol_products.filter((p) => p.product_name === 'SpeedZone Southern + NIS'
      && p.lawn_protocol_window_id.startsWith('w-'));
    expect(sz.length).toBeGreaterThanOrEqual(2);
    sz.forEach((p) => {
      expect(p.rate_per_1000).toBe(1.1); // unchanged — mix math reads the catalog rate
      const g = JSON.parse(p.gates);
      expect(g.bahiaLabelUnverified).toBeUndefined();
      expect(g.spotAreaCapSqFtPerAcre).toBe(1000);
      expect(g.establishedTurfOnly).toBe(true);
      expect(g.maxTempF).toBe(90);
      expect(g.bahiaPreferredRatePer1000).toBe(1.0); // owner default recorded as metadata
    });
  });

  test('D) March + July SpeedZone conditional rows inserted (mapped, spot-capped, catalog rate)', () => {
    ['w-mar_n1_pre_m', 'w-jul_seed_head'].forEach((wid) => {
      const row = state.lawn_protocol_products.find((p) => p.lawn_protocol_window_id === wid
        && p.product_name === 'SpeedZone Southern + NIS');
      expect(row).toBeTruthy();
      expect(row.default_in_plan).toBe(false);
      expect(row.product_id).toBe('sz');
      expect(row.rate_per_1000).toBe(1.1); // catalog rate (mix math); preferred 1.0 is metadata
      const g = JSON.parse(row.gates);
      expect(g.spotAreaCapSqFtPerAcre).toBe(1000);
      expect(g.bahiaPreferredRatePer1000).toBe(1.0);
    });
    // July uses the <90°F broadleaf trigger; March the broadleaf-heavy trigger
    const jul = state.lawn_protocol_products.find((p) => p.lawn_protocol_window_id === 'w-jul_seed_head' && p.product_name === 'SpeedZone Southern + NIS');
    expect(JSON.parse(jul.gates).trigger).toBe('broadleaf_below_90f');
  });

  test('E) bahia windows fully corrected: title/goal/tasks no longer name Drive/Celsius or a curative', () => {
    ['may_micros_crabgrass', 'sep_blackout_crabgrass'].forEach((wk) => {
      const w = state.lawn_protocol_windows.find((r) => r.window_key === wk);
      expect(w.title).toMatch(/Scout/);
      expect(w.title).not.toMatch(/Crabgrass Curative/i);
      expect(w.goal).not.toMatch(/Drive XLR8|Celsius/i);
      const tasks = JSON.parse(w.required_tasks);
      expect(tasks).not.toContain('crabgrass_curative_gate');
      expect(tasks).toContain('crabgrass_scout_no_curative');
      // derived fields stay in sync
      expect(JSON.parse(w.assessment_bridge).requiredTasks).toEqual(tasks);
      expect(JSON.parse(w.wiki_refs)).toContain('protocols/lawn/crabgrass_scout_no_curative');
      expect(JSON.parse(w.service_report_context).title).toBe(w.title);
      expect(JSON.parse(w.service_report_context).goal).toBe(w.goal);
    });
    // July goal no longer says "Celsius app 2"; untouched window keeps its goal
    expect(state.lawn_protocol_windows.find((r) => r.window_key === 'jul_seed_head').goal).not.toMatch(/Celsius/i);
    expect(state.lawn_protocol_windows.find((r) => r.window_key === 'jan_pre_m_irrigation_class').goal).toBe('goal');
  });

  test('F) bahia SpeedZone heat gate defers (no Celsius fallback); Celsius annual gate removed', () => {
    const heat = state.lawn_protocol_gates.find((g) => g.gate_key === 'speedzone_heat_gate');
    expect(heat.rule_text).not.toMatch(/use Celsius|Celsius WG/i);
    expect(heat.rule_text).toMatch(/DEFER/i);
    expect(state.lawn_protocol_gates.find((g) => g.gate_key === 'celsius_annual_rate')).toBeUndefined();
  });
});
