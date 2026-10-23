// A catalog match must rest on a word that identifies the product, never only on a word that names its kind or its
// seller. Product names are real; the rows are synthetic fixtures.
process.env.NODE_ENV = 'test';
const { matchCatalogProduct } = require('../services/waveguard-plan-engine');
const { _test: { linesFromProtocolText } } = require('../services/job-card');

const row = (id, name, extra = {}) => ({ id, name, category: 'fertilizer', cost_per_unit: 1, ...extra });
const CATALOG = [
  row('spz', 'SpeedZone Southern', { category: 'herbicide' }),
  row('mn', 'Southern Ag Manganese Sulfate'),
  row('cu', 'Southern Ag Copper Fungicide 27.15%', { category: 'fungicide' }),
  row('hw', 'Headway Fungicide', { category: 'fungicide' }),
  row('kp', 'KPHITE 7LP Systemic Fungicide', { category: 'fungicide' }),
  row('pj', 'Arborjet PHOSPHO-Jet Systemic Fungicide', { category: 'fungicide' }),
  row('lm', 'LESCO High Manganese Combo AM 1% Mg 5.75% S 3% Fe 4% Mn Chelated Micronutrient Liquid Fertilizer'),
  row('l24', 'LESCO 24-0-11 with PolyPlus OPTI'),
  row('l15', 'LESCO 15-0-15 30% PolyPlus 1% Fe'),
  row('hy', 'Hydretain Liquid'),
  row('t6', 'LESCO 6-0-0 Liquid'),
  row('bs', 'Blindside Herbicide', { category: 'herbicide' }),
  row('gf', 'LESCO Green Flo 6-0-0 10% Ca'),
  row('bc', 'Bora-Care', { category: 'insecticide' }),
  row('ij10', 'Arborjet Ima-Jet 10', { category: 'insecticide' }),
  row('ijs', 'Arborjet Ima-Jet Systemic Insecticide', { category: 'insecticide' }),
];
const match = (raw) => matchCatalogProduct({ raw }, CATALOG)?.name || null;

describe('catalog match needs a distinctive word', () => {
  test('a spelled name in a different order still finds its row, not a row sharing the seller word', () => {
    expect(match('Manganese sulfate (Southern Ag): palms with frizzle-top on new fronds only; label size class, spread under the canopy'))
      .toBe('Southern Ag Manganese Sulfate');
  });

  test('a product the catalog does not hold stays unmatched, not a same-kind stand-in', () => {
    expect(match('Reliant Systemic Fungicide (phosphite) only on beds with root-rot history or repeat decline')).toBeNull();
  });

  test('a line that only names a kind of product attaches no product', () => {
    expect(match('Large patch: fungicide window closing')).toBeNull();
    expect(match('IF forecast >85F: DEFER broadleaf (no bahia-safe herbicide when hot)')).toBeNull();
    expect(match('Liquid Perimeter / Trench and Rod')).toBeNull();
    expect(match('K-Flow 0-0-25 liquid K')).toBeNull();
  });

  test('correct matches stay: full names, brand-first, analysis-led and kind-plus-brand lines', () => {
    expect(match('Headway Fungicide for large patch')).toBe('Headway Fungicide');
    expect(match('KPHITE 7LP Systemic Fungicide root-rot support')).toBe('KPHITE 7LP Systemic Fungicide');
    expect(match('Arborjet PHOSPHO-Jet Systemic Fungicide injection')).toBe('Arborjet PHOSPHO-Jet Systemic Fungicide');
    expect(match('Southern Ag Copper Fungicide 27.15% spot spray')).toBe('Southern Ag Copper Fungicide 27.15%');
    expect(match('SpeedZone Southern on broadleaf')).toBe('SpeedZone Southern');
    expect(match('LESCO 24-0-11 fert ($8.68)')).toBe('LESCO 24-0-11 with PolyPlus OPTI');
    expect(match('LESCO 24-0-11 75% PolyPlus fert ($8.68)')).toBe('LESCO 24-0-11 with PolyPlus OPTI');
    expect(match('Bora-Care scope based on finding location')).toBe('Bora-Care');
  });

  test('an exact full name outranks a longer row that only spells all its words', () => {
    expect(match('Arborjet Ima-Jet 10')).toBe('Arborjet Ima-Jet 10');
    expect(match('Arborjet Ima-Jet Systemic Insecticide')).toBe('Arborjet Ima-Jet Systemic Insecticide');
  });

  test('a number the line carries, or the name needs, keeps an all-words match out', () => {
    const noExact = CATALOG.filter((p) => p.id !== 'ij10');
    // "Ima-Jet 10" is a different product and rate from the Systemic Insecticide row.
    expect(matchCatalogProduct({ raw: 'Ima-Jet 10 trunk injection' }, noExact)?.name).not.toBe('Arborjet Ima-Jet Systemic Insecticide');
    // A name with a number the line lacks ("10%") is not spelled by the line.
    expect(match('Green Flo 6-0-0 Ca ($1.39)')).not.toBe('LESCO Green Flo 6-0-0 10% Ca');
  });

  test('the job card follows: the Manganese line gets its fertilizer card, the Reliant line none', () => {
    const lines = linesFromProtocolText({
      primary: 'Distance placeholder line with no product',
      secondary: [
        'Manganese sulfate (Southern Ag): palms with frizzle-top on new fronds only; label size class',
        'Reliant Systemic Fungicide (phosphite) only on beds with root-rot history',
      ].join('\n'),
    }, CATALOG);
    expect(lines.map((l) => l.product.name)).toEqual(['Southern Ag Manganese Sulfate']);
  });
});
