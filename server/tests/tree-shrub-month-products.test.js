// Month -> suggested T&S products, resolved against synthetic catalog rows.
const { MONTH_PRODUCTS, visitMonthET, resolveMonthProducts } = require('../services/tree-shrub-month-products');

const row = (id, name, extra = {}) => ({ id, name, active: true, ...extra });

// Names as the prod catalog carries them (verified read-only 2026-10-01).
const CATALOG = [
  row('snapshot', 'Snapshot 2.5TG'),
  row('palm', 'LESCO 8-2-12 100% Poly Plus OPTI Kieserite Palm & Tropical Ornamental Granular Fertilizer'),
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
    expect(ids('2026-02-10')).toEqual(['tritek', 'iron']);
    expect(ids('2026-03-10')).toEqual(['kontos', 'mainspring', 'distance', 'kphite']);
    expect(ids('2026-04-10')).toEqual(['snapshot', 'palm', 'orn']);
    expect(ids('2026-05-10')).toEqual(['kontos', 'mainspring', 'iron', 'palm', 'orn']);
    expect(ids('2026-06-10')).toEqual(['tritek', 'kphite', 'copper', 'iron']);
    expect(ids('2026-07-10')).toEqual(['snapshot']);
    expect(ids('2026-08-10')).toEqual(['mainspring', 'distance', 'tritek', 'cytogro']);
    expect(ids('2026-09-10')).toEqual(['talus', 'distance', 'iron', 'tritek']);
    expect(ids('2026-10-01')).toEqual(['snapshot', 'palm', 'orn', 'kphite']);
    expect(ids('2026-11-10')).toEqual(['tritek', 'espoma', 'sequestar']);
    expect(ids('2026-12-10')).toEqual(['palm', 'cytogro', 'sequestar']);
  });

  test('each entry carries the application method', () => {
    const october = Object.fromEntries(resolveMonthProducts('2026-10-01', CATALOG).map((e) => [e.productId, e.method]));
    expect(october).toEqual({ snapshot: 'granular_broadcast', palm: 'granular_broadcast', orn: 'granular_broadcast', kphite: 'foliar_spray' });
    const november = Object.fromEntries(resolveMonthProducts('2026-11-10', CATALOG).map((e) => [e.productId, e.method]));
    expect(november.sequestar).toBe('soil_drench');
    expect(november.espoma).toBe('granular_broadcast');
  });

  test('NutriRoot resolves when the catalog carries exactly one active row', () => {
    const single = CATALOG.filter((r) => !r.id.startsWith('nr-')).concat(row('nr', 'Arborjet NUTRIROOT'));
    expect(resolveMonthProducts('2026-02-10', single)).toContainEqual({ productId: 'nr', method: 'soil_drench' });
  });

  test('zero matches: the entry is skipped, never substituted', () => {
    expect(ids('2026-07-10', CATALOG.filter((r) => r.id !== 'snapshot'))).toEqual([]);
    // A broad lookalike must not stand in for the missing exact row.
    expect(ids('2026-07-10', [row('x', 'Snapshot Lawn Pre-Emergent 2.5 TG blend')])).toEqual([]);
  });

  test('multiple active matches: skipped, not first-wins', () => {
    const dup = [...CATALOG, row('snapshot-2', 'Snapshot 2.5TG')];
    expect(ids('2026-07-10', dup)).toEqual([]);
  });

  test('inactive rows do not count: an inactive near-duplicate neither matches nor makes the entry ambiguous', () => {
    const withInactiveDup = [...CATALOG, row('iron-old', 'LESCO Chelated Iron Plus', { active: false })];
    expect(ids('2026-02-10', withInactiveDup)).toEqual(['tritek', 'iron']);
    expect(ids('2026-07-10', CATALOG.map((r) => (r.id === 'snapshot' ? { ...r, active: false } : r)))).toEqual([]);
  });

  test('the Iron Plus pattern is exact: a longer near-duplicate name does not match', () => {
    expect(ids('2026-02-10', [row('iron-x', 'LESCO Chelated Iron Plus Granular'), row('tritek', 'TriTek Spray Oil Emulsion (OMRI)')])).toEqual(['tritek']);
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

  test('the table covers all twelve months', () => {
    expect(Object.keys(MONTH_PRODUCTS).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
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
