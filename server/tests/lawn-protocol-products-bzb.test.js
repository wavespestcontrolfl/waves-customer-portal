// Guards the B/Z/B structured-product seed (20260630000002): runs up() against a
// mock knex (no DB) and asserts the inserts attach to real B1 windows with valid
// rates/gates. The B1 window_keys are duplicated here so a B1/B2 key drift fails.
const mig = require('../models/migrations/20260630000002_lawn_protocol_products_bzb.js');

const B1_WINDOW_KEYS = {
  bermuda: ['jan_pre_m_split_1', 'feb_greenup_n1', 'mar_pre_m_split_2_pgr', 'apr_insect_preventive', 'may_final_n', 'jun_blackout', 'jul_blackout_celsius', 'aug_scout_peak', 'sep_blackout_closeout', 'oct_final_n_sds_prevent', 'nov_sds_prevent_2_k', 'dec_dormancy_touchpoint'],
  zoysia: ['jan_pre_m_split_1', 'feb_micros_frac', 'mar_n1_pre_m_pgr', 'apr_insect_preventive', 'may_final_n', 'jun_blackout', 'jul_blackout_celsius', 'aug_scout', 'sep_blackout_lp_prep', 'oct_final_n_lp_required', 'nov_lp_frac_k', 'dec_touchpoint'],
  bahia: ['jan_pre_m_irrigation_class', 'feb_micros_mole_cricket', 'mar_n1_pre_m', 'apr_insect_fire_ant', 'may_micros_crabgrass', 'jun_blackout_mole_cricket', 'jul_seed_head', 'aug_scout_mole_cricket', 'sep_blackout_crabgrass', 'oct_final_n', 'nov_winter_k', 'dec_dormancy_touchpoint'],
};
const KEY_BY_PROTOCOL = { swfl_bermuda_10_10: 'bermuda', swfl_zoysia_10_10: 'zoysia', swfl_bahia_10_10: 'bahia' };

const CATALOG = [
  'Prodiamine 65 WDG', 'Acelepryn Xtra', 'Celsius WG', 'LESCO 24-0-11', 'LESCO 0-0-18 Bio KMAG 1% Fe',
  'Armada 50 WDG', 'Headway G', 'Medallion SC', 'Primo Maxx', 'SpeedZone Southern',
  'LESCO 12-0-0 Chelated Iron Plus', 'LESCO K-Flow 0-0-25', 'Velista',
].map((name, i) => ({ id: `cat-${i}`, name }));

function runMigration() {
  const products = [];
  const knex = (name) => {
    const ctx = {};
    return {
      where(cond) { ctx.cond = { ...ctx.cond, ...cond }; return this; },
      orderBy() { return this; },
      select() {
        if (name === 'products_catalog') return Promise.resolve(CATALOG);
        const track = ctx.cond && ctx.cond.lawn_protocol_id; // windows lookup
        return Promise.resolve((B1_WINDOW_KEYS[track] || []).map((k) => ({ id: `${track}-${k}`, window_key: k })));
      },
      async first() {
        if (name === 'lawn_protocols') {
          const track = KEY_BY_PROTOCOL[ctx.cond.protocol_key];
          return track && ctx.cond.version === '2026.06' ? { id: track, grass_track: track } : null;
        }
        return null; // products: not existing -> insert
      },
      async insert(row) { products.push(row); return [1]; },
      async del() { return 0; },
    };
  };
  knex.schema = { hasTable: async () => true };
  knex.fn = { now: () => 'NOW()' };
  return mig.up(knex).then(() => products);
}

describe('B/Z/B structured product seed', () => {
  let products;
  beforeAll(async () => { products = await runMigration(); });

  test('inserts products that all attach to a real B1 window', () => {
    expect(products.length).toBeGreaterThan(40);
    products.forEach((p) => {
      // window id is `${track}-${window_key}` — both parts must be valid B1 data
      expect(p.lawn_protocol_window_id).toMatch(/^(bermuda|zoysia|bahia)-/);
      const [, key] = p.lawn_protocol_window_id.match(/^[a-z]+-(.+)$/);
      const track = p.lawn_protocol_window_id.split('-')[0];
      expect(B1_WINDOW_KEYS[track]).toContain(key);
    });
  });

  test('every product has a numeric-or-null rate, a unit, carrier, and valid gates JSON', () => {
    products.forEach((p) => {
      expect(p.rate_per_1000 === null || typeof p.rate_per_1000 === 'number').toBe(true);
      expect(typeof p.rate_unit).toBe('string');
      expect([1, 2]).toContain(p.carrier_gal_per_1000);
      expect(typeof p.default_in_plan).toBe('boolean');
      expect(() => JSON.parse(p.gates)).not.toThrow();
      expect(() => JSON.parse(p.report_copy)).not.toThrow();
    });
  });

  test('owner-supplied curative rates are seeded exactly', () => {
    const byName = (n) => products.filter((p) => p.product_name === n);
    expect(byName('Dylox 420 SL').every((p) => p.rate_per_1000 === 6.9 && JSON.parse(p.gates).annualMaxApps === 3)).toBe(true);
    expect(byName('TopChoice')[0].rate_per_1000).toBe(2);
    expect(byName('Bifen I/T')[0].rate_per_1000).toBe(0.25);
    expect(byName('T-Storm')[0].rate_per_1000).toBe(1.75);
    // Drive XLR8 must NOT be seeded (contraindicated on bahiagrass)
    expect(byName('Drive XLR8')).toHaveLength(0);
    // chlorantraniliprole dropped as redundant
    expect(byName('chlorantraniliprole')).toHaveLength(0);
  });

  test('default products map to a catalog product_id; un-catalogued curatives stay conditional', () => {
    products.forEach((p) => {
      if (p.default_in_plan) {
        // a default product with no product_id is blocked by publish validation
        expect(p.product_id).not.toBeNull();
      }
    });
    // the curatives that aren't in the catalog must be conditional (default_in_plan=false)
    ['Dylox 420 SL', 'TopChoice', 'Bifen I/T', 'SedgeHammer Plus', 'CarbonPro-L', 'T-Storm']
      .forEach((n) => products.filter((p) => p.product_name === n).forEach((p) => {
        expect(p.product_id).toBeNull();
        expect(p.default_in_plan).toBe(false);
      }));
  });

  test('blackout-window products never push N/P (requiresZeroNP or non-fertilizer)', () => {
    const blackoutKeys = ['jun_blackout', 'jul_blackout_celsius', 'sep_blackout_closeout', 'sep_blackout_lp_prep', 'jun_blackout_mole_cricket', 'sep_blackout_crabgrass'];
    products
      .filter((p) => blackoutKeys.some((k) => p.lawn_protocol_window_id.endsWith(k)))
      .forEach((p) => {
        if (['nutrition', 'potassium'].includes(p.role)) {
          expect(JSON.parse(p.gates).requiresZeroNP).toBe(true);
        }
      });
  });
});
