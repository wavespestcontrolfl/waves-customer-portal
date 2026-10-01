// Guards 20260930230000: Chelated Iron Plus (12-0-0, urea N) must not stay a
// default product in any Apr-Sep operating-layer window. Runs up()/down()
// against a tiny in-memory knex (no DB). Real-Postgres behaviour was verified
// separately by running the bzb seed + this migration on a scratch database.
const mig = require('../models/migrations/20260930230000_lawn_summer_iron_plus_to_zero_n_micro.js');

function makeKnex(seed) {
  const state = {
    lawn_protocols: seed.protocols.map((p) => ({ ...p })),
    lawn_protocol_windows: seed.windows.map((w) => ({ ...w })),
    lawn_protocol_products: seed.products.map((p) => ({ ...p })),
    products_catalog: [
      { id: 'cat-iron', name: 'LESCO 12-0-0 Chelated Iron Plus' },
      { id: 'cat-highmn', name: 'LESCO High Manganese Combo AM 1% Mg' },
      { id: 'cat-am', name: 'LESCO Chelated AM + Micros Turf & Ornamental' },
    ],
    product_aliases: [{ product_id: 'cat-highmn', alias_name: 'High Mn Combo' }],
  };
  let nextId = 1000;
  const knex = (table) => {
    const q = { cond: {}, ins: null };
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
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'NOW()' };
  knex.state = state;
  return knex;
}

function seed() {
  const row = (id, win, name, extra = {}) => ({
    id, lawn_protocol_window_id: win, product_name: name, default_in_plan: true, gates: '{}', ...extra,
  });
  return {
    protocols: [
      { id: 'z', grass_track: 'zoysia', status: 'active' },
      { id: 'b', grass_track: 'bahia', status: 'active' },
      { id: 'zold', grass_track: 'zoysia', status: 'archived' },
    ],
    windows: [
      { id: 'z-feb', lawn_protocol_id: 'z', window_key: 'feb_micros_frac' },
      { id: 'z-may', lawn_protocol_id: 'z', window_key: 'may_final_n' },
      { id: 'z-oct', lawn_protocol_id: 'z', window_key: 'oct_final_n_lp_required' },
      { id: 'b-may', lawn_protocol_id: 'b', window_key: 'may_micros_crabgrass' },
      { id: 'zold-may', lawn_protocol_id: 'zold', window_key: 'may_final_n' },
    ],
    products: [
      row('p1', 'z-feb', 'Chelated Iron Plus'), // Feb is outside Apr-Sep: untouched
      row('p2', 'z-may', 'Chelated Iron Plus'),
      row('p3', 'z-oct', 'Chelated Iron Plus'), // Oct: untouched
      row('p4', 'b-may', 'Chelated Iron Plus', { gates: '{"irrigatedOnly":false}' }),
      row('p5', 'b-may', 'Chelated AM + Micros'),
      row('p6', 'zold-may', 'Chelated Iron Plus'), // archived protocol: untouched
    ],
  };
}

const names = (k, win) => k.state.lawn_protocol_products.filter((r) => r.lawn_protocol_window_id === win).map((r) => r.product_name).sort();

describe('summer Chelated Iron Plus -> 0-N micro', () => {
  it('swaps zoysia May to High Mn Combo in place and drops the bahia duplicate', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    expect(names(k, 'z-may')).toEqual(['High Mn Combo']);
    const hm = k.state.lawn_protocol_products.find((r) => r.id === 'p2');
    expect(hm).toMatchObject({ role: 'micronutrients', rate_per_1000: 0.1975, rate_unit: 'fl_oz', product_id: 'cat-highmn', default_in_plan: true });
    expect(names(k, 'b-may')).toEqual(['Chelated AM + Micros']);
  });

  it('leaves non-summer windows and archived protocols alone', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    expect(names(k, 'z-feb')).toEqual(['Chelated Iron Plus']);
    expect(names(k, 'z-oct')).toEqual(['Chelated Iron Plus']);
    expect(names(k, 'zold-may')).toEqual(['Chelated Iron Plus']);
  });

  it('is idempotent', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    const once = JSON.stringify(k.state.lawn_protocol_products);
    await mig.up(k);
    expect(JSON.stringify(k.state.lawn_protocol_products)).toBe(once);
  });

  it('down() restores the seeded Iron Plus rows', async () => {
    const k = makeKnex(seed());
    await mig.up(k);
    await mig.down(k);
    expect(names(k, 'z-may')).toEqual(['Chelated Iron Plus']);
    expect(names(k, 'b-may')).toEqual(['Chelated AM + Micros', 'Chelated Iron Plus']);
    await mig.down(k); // second down is a no-op
    expect(names(k, 'z-may')).toEqual(['Chelated Iron Plus']);
    expect(names(k, 'b-may')).toEqual(['Chelated AM + Micros', 'Chelated Iron Plus']);
  });
});
