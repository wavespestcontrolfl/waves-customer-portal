// Month -> suggested T&S products, resolved against synthetic catalog rows.
const {
  PROTOCOL_PRODUCTS, NON_PRODUCT_LINE, primaryLines, visitMonthET, resolveMonthProducts,
} = require('../services/tree-shrub-month-products');
const protocols = require('../config/protocols.json');

const row = (id, name, extra = {}) => ({ id, name, active: true, ...extra });

// Names as the prod catalog carries them (verified read-only 2026-10-01).
const CATALOG = [
  row('snapshot', 'Snapshot 2.5TG'),
  // Palm SKUs as #5089's migration seeds them (owner 2026-10-01 palm program).
  row('palm', 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer (#511542)'),
  row('palm16', 'LESCO 0-0-16 Palm & Tropical Ornamental Fertilizer (#510513)'),
  // The lawn winterizer shares the 0-0-16 analysis and must never stand in.
  row('winterizer', 'LESCO 0-0-16 Winterizer'),
  row('orn', 'LESCO 13-0-13 60% PolyPlus Landscape'),
  row('tritek', 'TriTek Spray Oil Emulsion (OMRI)'),
  row('iron', 'LESCO Chelated Iron Plus'),
  row('kontos', 'Kontos Insecticide/Miticide'),
  row('mainspring', 'Mainspring GNL Insecticide'),
  row('distance', 'Distance IGR'),
  row('kphite', 'KPHITE 7LP Systemic Fungicide'),
  row('copper', 'Southern Ag Copper Fungicide 27.15%'),
  row('cytogro', 'Cytogro Liquid Biostimulant'),
  row('talus', 'Talus 70 DF IGR'),
  row('espoma', 'Espoma Organic Soil Acidifier'),
  row('sequestar', 'Sequestar 6% Fe EDDHA Soluble Micronutrient'),
  row('nr-1gal', 'Arborjet NUTRIROOT 1 gal'),
  row('nr-1qt', 'Arborjet NUTRIROOT 1 qt'),
  row('nr-25gal', 'Arborjet NUTRIROOT 2.5 gal'),
];

const ids = (date, rows = CATALOG) => resolveMonthProducts(date, rows).map((entry) => entry.productId);

describe('resolveMonthProducts', () => {
  test('every month matches the protocol primary list; the ambiguous NutriRoot entry is skipped', () => {
    expect(ids('2026-01-15')).toEqual(['snapshot', 'palm', 'orn']);
    expect(ids('2026-02-10')).toEqual(['tritek']);
    // KPHITE and Sequestar lines say their method is unverified: withheld.
    expect(ids('2026-03-10')).toEqual(['mainspring', 'distance']);
    expect(ids('2026-04-10')).toEqual(['snapshot', 'palm', 'orn']);
    expect(ids('2026-05-10')).toEqual(['mainspring', 'palm', 'orn']);
    // June's "Fe/Mn micros" line is not a suggestion: Iron Plus is 12-0-0 N.
    expect(ids('2026-06-10')).toEqual(['tritek', 'copper']);
    // The summer palm feeding is the 0-0-16 palm SKU, never the lawn winterizer.
    expect(ids('2026-07-10')).toEqual(['snapshot', 'palm16']);
    expect(ids('2026-08-10')).toEqual(['mainspring', 'distance', 'tritek', 'cytogro']);
    // Sep Talus is "(held: … prohibits residential use)" — never suggested.
    expect(ids('2026-09-10')).toEqual(['distance', 'tritek']);
    expect(ids('2026-10-01')).toEqual(['snapshot', 'palm', 'orn']);
    expect(ids('2026-11-10')).toEqual(['tritek', 'espoma']);
    expect(ids('2026-12-10')).toEqual(['palm', 'cytogro']);
  });

  test('each entry carries the application method', () => {
    const october = Object.fromEntries(resolveMonthProducts('2026-10-01', CATALOG).map((e) => [e.productId, e.method]));
    expect(october).toEqual({ snapshot: 'granular_broadcast', palm: 'granular_broadcast', orn: 'granular_broadcast' });
    const november = Object.fromEntries(resolveMonthProducts('2026-11-10', CATALOG).map((e) => [e.productId, e.method]));
    expect(november.espoma).toBe('granular_broadcast');
  });

  test('a line whose method is unverified is never suggested, even with an exact catalog row', () => {
    expect(NON_PRODUCT_LINE.test('KPHITE 7LP: verify container label and method; foliar and soil rates differ; FRAC P07')).toBe(true);
    expect(NON_PRODUCT_LINE.test('Sequestar EDDHA: exact container label needed; no verified dose or injector recipe')).toBe(true);
    // A held DOSE with a known method still suggests (no amount is ever pre-filled).
    expect(NON_PRODUCT_LINE.test('13-0-13 ornamental fertilizer: exact bag label needed; hold dose')).toBe(false);
  });

  test('NutriRoot resolves when the catalog carries exactly one active row', () => {
    const single = CATALOG.filter((r) => !r.id.startsWith('nr-')).concat(row('nr', 'Arborjet NUTRIROOT'));
    expect(resolveMonthProducts('2026-02-10', single)).toContainEqual({ productId: 'nr', method: 'soil_drench' });
  });

  test('zero matches: the entry is skipped, never substituted', () => {
    expect(ids('2026-07-10', CATALOG.filter((r) => r.id !== 'snapshot'))).toEqual(['palm16']);
    // A broad lookalike must not stand in for the missing exact row.
    expect(ids('2026-07-10', [row('x', 'Snapshot Lawn Pre-Emergent 2.5 TG blend')])).toEqual([]);
  });

  test('multiple active matches: skipped, not first-wins', () => {
    const dup = [...CATALOG, row('snapshot-2', 'Snapshot 2.5TG')];
    expect(ids('2026-07-10', dup)).toEqual(['palm16']);
  });

  test('inactive rows do not count: an inactive near-duplicate neither matches nor makes the entry ambiguous', () => {
    const withInactiveDup = [...CATALOG, row('tritek-old', 'TriTek Spray Oil Emulsion', { active: false })];
    expect(ids('2026-02-10', withInactiveDup)).toEqual(['tritek']);
    expect(ids('2026-07-10', CATALOG.map((r) => (r.id === 'snapshot' ? { ...r, active: false } : r)))).toEqual(['palm16']);
  });

  test('a lawn 0-0-16 winterizer alone never fills the palm feeding', () => {
    expect(ids('2026-07-10', [row('winterizer', 'LESCO 0-0-16 Winterizer')])).toEqual([]);
  });

  test('Iron Plus is never suggested in any month (owner 2026-10-01: 12-0-0 N, dropped from T&S)', () => {
    const months = ['01-15', '02-10', '03-10', '04-10', '05-10', '06-10', '07-10', '08-10', '09-10', '10-01', '11-10', '12-10'];
    const withIron = [...CATALOG, row('iron', 'LESCO Chelated Iron Plus')];
    for (const m of months) expect(ids(`2026-${m}`, withIron)).not.toContain('iron');
  });

  test('names match case-insensitively and anchored at the start', () => {
    expect(ids('2026-07-10', [row('s', 'snapshot 2.5tg')])).toEqual(['s']);
    expect(ids('2026-07-10', [row('s', 'Old Snapshot 2.5TG')])).toEqual([]);
  });

  test('no catalog rows or a bad date resolves nothing', () => {
    expect(resolveMonthProducts('2026-07-10', [])).toEqual([]);
    expect(resolveMonthProducts('2026-07-10', null)).toEqual([]);
    expect(resolveMonthProducts(null, CATALOG)).toEqual([]);
  });

  test('suggestions follow the canonical protocol: an edited primary line changes them', () => {
    const edited = { tree_shrub: { visits: [{ month: 'Jan', primary: 'Kontos: 1.7-3.4 fl oz/100 gal\nScout palms', secondary: 'Snapshot 2.5TG if needed' }] } };
    // Secondary ("if needed") lines are never suggestions.
    expect(resolveMonthProducts('2027-01-12', CATALOG, edited).map((e) => e.productId)).toEqual(['kontos']);
  });

  test('a non-product line naming a product (the December report) suggests nothing', () => {
    const report = { tree_shrub: { visits: [{ month: 'Dec', primary: 'Annual health report with photos, IRAC/FRAC history, Snapshot history' }] } };
    expect(resolveMonthProducts('2026-12-10', CATALOG, report)).toEqual([]);
  });
});

describe('protocols.json tree_shrub drift guard', () => {
  test('there is a visit for every month', () => {
    expect(protocols.tree_shrub.visits.map((v) => v.month)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  test('every primary line names a product the sheet can place, or is a known non-product line', () => {
    const unplaced = [];
    for (const visit of protocols.tree_shrub.visits) {
      for (const line of primaryLines(visit)) {
        if (!NON_PRODUCT_LINE.test(line) && !PROTOCOL_PRODUCTS.some((p) => p.token.test(line))) unplaced.push(`${visit.month}: ${line}`);
      }
    }
    // A new product in a month's primary text needs a PROTOCOL_PRODUCTS entry
    // (token + exact catalog pattern) or it silently drops off the sheet.
    expect(unplaced).toEqual([]);
  });
});

describe('visitMonthET', () => {
  test('a calendar-day string and a DATE read back at UTC midnight give the same month', () => {
    expect(visitMonthET('2026-10-01')).toBe(10);
    expect(visitMonthET(new Date('2026-10-01T00:00:00.000Z'))).toBe(10);
    expect(visitMonthET('2026-09-30')).toBe(9);
    expect(visitMonthET(new Date('2026-09-30T00:00:00.000Z'))).toBe(9);
  });

  test('a real instant is read on the ET calendar, not UTC', () => {
    // 02:00Z on Oct 1 is 10 PM Sep 30 in New York.
    expect(visitMonthET(new Date('2026-10-01T02:00:00.000Z'))).toBe(9);
    // 05:00Z on Oct 1 is 1 AM Oct 1 in New York.
    expect(visitMonthET(new Date('2026-10-01T05:00:00.000Z'))).toBe(10);
    // Year end: 03:00Z Jan 1 is still Dec 31 in New York.
    expect(visitMonthET(new Date('2027-01-01T03:00:00.000Z'))).toBe(12);
  });

  test('a missing date has no month', () => {
    expect(visitMonthET(null)).toBeNull();
    expect(visitMonthET(undefined)).toBeNull();
  });
});
