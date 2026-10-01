// Guards 20261001010000: Chelated Iron Plus (12-0-0, urea N) must not stay a
// default product in any Apr-Sep operating-layer window, and the High Mn Combo
// lines protocols.json now prescribes exist. Runs up()/down() against a tiny
// in-memory knex (no DB). Real-Postgres behaviour was verified separately over
// the real seed chain (see the PR notes).
const mig = require('../models/migrations/20261001010000_lawn_summer_micro_zero_n.js');

function makeKnex(seedData, { tables } = {}) {
  const state = {
    lawn_protocols: seedData.protocols.map((p) => ({ ...p })),
    lawn_protocol_windows: seedData.windows.map((w) => ({ ...w })),
    lawn_protocol_products: seedData.products.map((p) => ({ ...p })),
    lawn_protocol_product_actuals: (seedData.actuals || []).map((a) => ({ ...a })),
    products_catalog: [
      { id: 'cat-iron', name: 'LESCO 12-0-0 Chelated Iron Plus' },
      { id: 'cat-highmn', name: 'LESCO High Manganese Combo AM 1% Mg' },
      { id: 'cat-am', name: 'LESCO Chelated AM + Micros Turf & Ornamental' },
      { id: 'cat-celsius', name: 'Celsius WG Herbicide' },
    ],
    product_aliases: [{ product_id: 'cat-highmn', alias_name: 'High Mn Combo' }],
  };
  let nextId = 1000;
  const knex = (table) => {
    const q = { cond: {} };
    const rows = () => state[table].filter((r) => Object.entries(q.cond).every(([k, v]) => r[k] === v)
      && (!q.statuses || q.statuses.includes(r.status)));
    const api = {
      where(c) { q.cond = { ...q.cond, ...c }; return api; },
      whereIn(col, vals) { q.statuses = vals; return api; },
      select() { return Promise.resolve(rows().map((r) => ({ ...r }))); },
      first() { const r = rows()[0]; return Promise.resolve(r ? { ...r } : undefined); },
      update(patch) { rows().forEach((r) => Object.assign(r, patch)); return Promise.resolve(1); },
      del() { const dead = new Set(rows()); state[table] = state[table].filter((r) => !dead.has(r)); return Promise.resolve(dead.size); },
      insert(row) { state[table].push({ id: `new-${nextId++}`, ...row }); return Promise.resolve([1]); },
    };
    return api;
  };
  const present = tables || Object.keys(state);
  knex.schema = {
    hasTable: async (t) => present.includes(t),
    hasColumn: async (t) => present.includes(t),
  };
  knex.fn = { now: () => 'NOW()' };
  knex.state = state;
  return knex;
}

function seed() {
  const row = (id, win, name, extra = {}) => ({
    id, lawn_protocol_window_id: win, product_name: name, default_in_plan: true, gates: '{}', sort_order: 0, ...extra,
  });
  return {
    protocols: [
      { id: 'z', grass_track: 'zoysia', status: 'active' },
      { id: 'b', grass_track: 'bahia', status: 'active' },
      { id: 'sa', grass_track: 'st_augustine', status: 'active' },
      { id: 'be', grass_track: 'bermuda', status: 'active' },
      { id: 'zdraft', grass_track: 'zoysia', status: 'draft' },
      { id: 'zold', grass_track: 'zoysia', status: 'archived' },
    ],
    windows: [
      { id: 'z-feb', lawn_protocol_id: 'z', window_key: 'feb_micros_frac' },
      { id: 'z-may', lawn_protocol_id: 'z', window_key: 'may_final_n' },
      { id: 'z-oct', lawn_protocol_id: 'z', window_key: 'oct_final_n_lp_required' },
      { id: 'b-may', lawn_protocol_id: 'b', window_key: 'may_micros_crabgrass' },
      { id: 'sa-may', lawn_protocol_id: 'sa', window_key: 'may_final_n_or_zero_np' },
      { id: 'sa-jun', lawn_protocol_id: 'sa', window_key: 'jun_blackout_stress' },
      { id: 'sa-apr', lawn_protocol_id: 'sa', window_key: 'apr_insect_preventive' },
      { id: 'sa-sep', lawn_protocol_id: 'sa', window_key: 'sep_blackout_closeout' },
      { id: 'be-apr', lawn_protocol_id: 'be', window_key: 'apr_insect_preventive' },
      { id: 'be-may', lawn_protocol_id: 'be', window_key: 'may_final_n' },
      { id: 'zd-may', lawn_protocol_id: 'zdraft', window_key: 'may_final_n' },
      { id: 'zold-may', lawn_protocol_id: 'zold', window_key: 'may_final_n' },
    ],
    products: [
      row('p1', 'z-feb', 'Chelated Iron Plus'), // Feb is outside Apr-Sep: untouched
      row('p2', 'z-may', 'Chelated Iron Plus', { default_in_plan: false, sort_order: 7, gates: '{"x":1}' }),
      row('p2b', 'z-may', 'CarbonPro-L', { sort_order: 3 }),
      row('p3', 'z-oct', 'Chelated Iron Plus'), // Oct: untouched
      row('p4', 'b-may', 'Chelated Iron Plus', { gates: '{"irrigatedOnly":false}' }),
      row('p5', 'b-may', 'Chelated AM + Micros', { sort_order: 4 }),
      row('p5b', 'b-may', 'K-Flow 0-0-25', { sort_order: 9, default_in_plan: false }),
      row('sa1', 'sa-may', 'Liquid SRN', { sort_order: 2 }),
      row('sa2', 'sa-jun', 'Fe/Mn Micros'),
      row('sa3', 'sa-apr', 'Acelepryn Xtra', { sort_order: 2 }),
      row('sa4', 'sa-sep', 'K-Flow 0-0-25', { sort_order: 2, default_in_plan: false }),
      row('be1', 'be-may', 'Primo Maxx', { sort_order: 5 }),
      row('zd1', 'zd-may', 'Chelated Iron Plus'), // draft protocol: converted too
      row('p6', 'zold-may', 'Chelated Iron Plus'), // archived protocol: untouched
    ],
    actuals: [
      { id: 'a-z', protocol_product_id: 'p2' },
      { id: 'a-b', protocol_product_id: 'p4' },
      { id: 'a-b2', protocol_product_id: 'p5' },
      { id: 'a-none', protocol_product_id: null },
      { id: 'a-z-feb', protocol_product_id: 'p1' },
    ],
  };
}

const names = (k, win) => k.state.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === win).map((r) => r.product_name).sort();
const byId = (k, id) => k.state.lawn_protocol_products.find((r) => r.id === id);
const actual = (k, id) => k.state.lawn_protocol_product_actuals.find((r) => r.id === id);

describe('summer Chelated Iron Plus -> 0-N micro', () => {
  it('converts a non-bahia Iron Plus row in place, preserving id, default_in_plan, sort_order and gates', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    expect(names(k, 'z-may')).toEqual(['CarbonPro-L', 'High Mn Combo']);
    expect(byId(k, 'p2')).toMatchObject({
      product_name: 'High Mn Combo', role: 'micronutrients', rate_per_1000: 0.1975, rate_unit: 'fl_oz',
      carrier_gal_per_1000: 1, product_id: 'cat-highmn',
      default_in_plan: false, sort_order: 7, gates: '{"x":1}',
    });
    // the completion-ledger link survives because the row id is unchanged
    expect(actual(k, 'a-z').protocol_product_id).toBe('p2');
    // draft protocols are converted too
    expect(names(k, 'zd-may')).toEqual(['High Mn Combo']);
  });

  it('bahia duplicate case: repoints actuals to the retained target row, then deletes Iron Plus', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    expect(names(k, 'b-may')).toEqual(['Chelated AM + Micros', 'K-Flow 0-0-25']);
    expect(byId(k, 'p4')).toBeUndefined();
    expect(actual(k, 'a-b').protocol_product_id).toBe('p5');
    expect(actual(k, 'a-b2').protocol_product_id).toBe('p5');
    expect(actual(k, 'a-none').protocol_product_id).toBeNull();
    // the retained row is untouched (id, default, sort order)
    expect(byId(k, 'p5')).toMatchObject({ product_name: 'Chelated AM + Micros', default_in_plan: true, sort_order: 4 });
  });

  it('a bahia window with Iron Plus and no target converts in place to Chelated AM + Micros', async () => {
    const s = seed();
    s.products = s.products.filter((r) => r.id !== 'p5');
    const k = makeKnex(s);
    await mig.up(k);
    expect(byId(k, 'p4')).toMatchObject({ product_name: 'Chelated AM + Micros', rate_per_1000: 2, product_id: 'cat-am', gates: '{"irrigatedOnly":false}' });
    expect(actual(k, 'a-b').protocol_product_id).toBe('p4');
  });

  it('extra Iron Plus rows in a window keep one row and repoint the rest onto it', async () => {
    const s = seed();
    s.products.push({ id: 'p2c', lawn_protocol_window_id: 'z-may', product_name: 'Chelated Iron Plus', default_in_plan: true, gates: '{}', sort_order: 8 });
    s.actuals.push({ id: 'a-extra', protocol_product_id: 'p2c' });
    const k = makeKnex(s);
    await mig.up(k);
    expect(names(k, 'z-may')).toEqual(['CarbonPro-L', 'High Mn Combo']);
    expect(actual(k, 'a-extra').protocol_product_id).toBe('p2');
  });

  it('inserts High Mn Combo for St. Augustine May (default) and Bermuda May (conditional)', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    const sa = k.state.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === 'sa-may' && r.product_name === 'High Mn Combo');
    expect(sa).toHaveLength(1);
    expect(sa[0]).toMatchObject({ default_in_plan: true, rate_per_1000: 0.1975, rate_unit: 'fl_oz', product_id: 'cat-highmn', sort_order: 3, role: 'micronutrients' });
    const be = k.state.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === 'be-may' && r.product_name === 'High Mn Combo');
    expect(be).toHaveLength(1);
    expect(be[0]).toMatchObject({ default_in_plan: false, sort_order: 6, gates: '{}' });
    // St. Augustine June is not a prescribed High Mn window
    expect(names(k, 'sa-jun')).toEqual(['Fe/Mn Micros']);
  });

  it('inserts a conditional spot Celsius WG row in St. Augustine April and September', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    for (const win of ['sa-apr', 'sa-sep']) {
      const cel = k.state.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === win && r.product_name === 'Celsius WG');
      expect(cel).toHaveLength(1);
      expect(cel[0]).toMatchObject({
        role: 'post_emergent_spot', application_mode: 'spot', rate_per_1000: 0.057, rate_unit: 'oz',
        carrier_gal_per_1000: 1, default_in_plan: false, product_id: 'cat-celsius', sort_order: 3,
      });
      expect(JSON.parse(cel[0].gates)).toEqual({ trigger: 'broadleaf_present', noAdjuvantAboveF: 90, annualCounter: 'celsius_oz_per_1000' });
      expect(JSON.parse(cel[0].annual_counter)).toEqual({ counter: 'celsius_oz_per_1000' });
    }
    // other St. Augustine windows and other tracks get no Celsius row
    expect(names(k, 'sa-may')).not.toContain('Celsius WG');
    expect(names(k, 'sa-jun')).not.toContain('Celsius WG');
    expect(names(k, 'be-apr')).not.toContain('Celsius WG');
  });

  it('does not add a second Celsius WG when the window already has one', async () => {
    const s = seed();
    s.products.push({ id: 'sa-cel', lawn_protocol_window_id: 'sa-apr', product_name: 'Celsius WG', default_in_plan: true, gates: '{"x":1}', sort_order: 1 });
    const k = makeKnex(s);
    await mig.up(k);
    expect(names(k, 'sa-apr').filter((n) => n === 'Celsius WG')).toHaveLength(1);
    expect(byId(k, 'sa-cel')).toMatchObject({ default_in_plan: true, gates: '{"x":1}' });
  });

  it('leaves non-summer windows and archived protocols alone', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    expect(names(k, 'z-feb')).toEqual(['Chelated Iron Plus']);
    expect(names(k, 'z-oct')).toEqual(['Chelated Iron Plus']);
    expect(names(k, 'zold-may')).toEqual(['Chelated Iron Plus']);
    expect(actual(k, 'a-z-feb').protocol_product_id).toBe('p1');
  });

  it('is idempotent', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    const once = JSON.stringify([k.state.lawn_protocol_products, k.state.lawn_protocol_product_actuals]);
    await mig.up(k);
    expect(JSON.stringify([k.state.lawn_protocol_products, k.state.lawn_protocol_product_actuals])).toBe(once);
  });

  it('does not insert a second High Mn Combo when the window already has one', async () => {
    const s = seed();
    s.products.push({ id: 'sa-hm', lawn_protocol_window_id: 'sa-may', product_name: 'High Mn Combo', default_in_plan: false, gates: '{}', sort_order: 1 });
    const k = makeKnex(s);
    await mig.up(k);
    expect(names(k, 'sa-may').filter((n) => n === 'High Mn Combo')).toHaveLength(1);
    expect(byId(k, 'sa-hm').default_in_plan).toBe(false);
  });

  it('runs without the actuals table', async () => {
    const k = makeKnex(seed(), { tables: ['lawn_protocols', 'lawn_protocol_windows', 'lawn_protocol_products', 'products_catalog', 'product_aliases'] });
    await mig.up(k);
    expect(names(k, 'b-may')).toEqual(['Chelated AM + Micros', 'K-Flow 0-0-25']);
  });

  it('returns early when a lawn protocol table is missing', async () => {
    const k = makeKnex(seed(), { tables: ['lawn_protocols', 'lawn_protocol_windows'] });
    const before = JSON.stringify(k.state.lawn_protocol_products);
    await mig.up(k);
    expect(JSON.stringify(k.state.lawn_protocol_products)).toBe(before);
  });

  it('down() is a no-op', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    const after = JSON.stringify([k.state.lawn_protocol_products, k.state.lawn_protocol_product_actuals]);
    await mig.down(k);
    expect(JSON.stringify([k.state.lawn_protocol_products, k.state.lawn_protocol_product_actuals])).toBe(after);
  });
});
