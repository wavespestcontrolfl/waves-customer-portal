'use strict';

// Tree & Shrub Mix Amounts: each field-guide product carries `mixRates` rows (the shape of server/config/protocols.json
// rows). A per-gallon row is multiplied for each sprayer on screen; a granular or per-plant row is a dose as written; a
// product with no verified label rate shows "Label rate not on file", never an amount.
const guide = require('../config/tree-shrub-field-guide.json');
const protocols = require('../config/protocols.json');
const { treeShrubFieldGuide } = require('../services/tree-shrub-field-guide');

// The card's own tanks (field-guide equipment ids): the table sizes each from the card's TANKS (rig 110 gal).
const SPRAYERS = ['bg', 'flowzone', 'rig'];
const products = Object.entries(guide.products);
const rowsOf = (key) => guide.products[key].mixRates;
const perGallon = (key, where) => rowsOf(key).find((row) => row.perGallon && (!where || row.where === where)).perGallon;

describe('tree & shrub mix rates', () => {
  test('every product has rows; each is a per-gallon rate for all three sprayers, a dose, or no label rate', () => {
    for (const [key, product] of products) {
      expect([key, Array.isArray(product.mixRates) && product.mixRates.length > 0]).toEqual([key, true]);
      for (const row of product.mixRates) {
        const at = `${key} ${row.where}`;
        expect([at, typeof row.product, typeof row.where]).toEqual([at, 'string', 'string']);
        if (row.perGallon) {
          expect([at, row.perGallon.amount > 0, ['fl oz', 'oz'].includes(row.perGallon.unit)]).toEqual([at, true, true]);
          if (row.perGallon.amountMax != null) expect([at, row.perGallon.amountMax > row.perGallon.amount]).toEqual([at, true]);
          expect([at, row.sprayers]).toEqual([at, SPRAYERS]);
          // A registration, or a distributor sub-registration (TriStar 8033-106-1001).
          expect([at, /^\d+-\d+(-\d+)?$/.test(row.epa)]).toEqual([at, true]);
        } else if (row.dose) {
          expect([at, row.sprayers]).toEqual([at, undefined]);
        } else {
          expect([at, row.labelRateMissing]).toEqual([at, true]);
        }
      }
    }
  });

  test('only the products with no verified label rate show "Label rate not on file"', () => {
    const missing = products.filter(([, p]) => p.mixRates.some((row) => row.labelRateMissing)).map(([key]) => key);
    // Copper names no exact product; Sequestar's verified label directions are a dose row (Codex #8696 r1).
    expect(missing.sort()).toEqual(['copper']);
    for (const key of missing) expect(rowsOf(key).every((row) => !row.perGallon && !row.dose)).toBe(true);
  });

  test('a product whose card lists verified label rates never shows "Label rate not on file"', () => {
    const seq = products.find(([key]) => key === 'sequestar')[1];
    expect(seq.rates.length).toBeGreaterThan(0);
    expect(seq.mixRates).toEqual([expect.objectContaining({ dose: expect.stringContaining('2 oz per inch of trunk diameter') })]);
    for (const [key, product] of products) {
      const verified = (product.rates || []).some(([text]) => !/label needed/i.test(String(text)));
      if (verified) expect([key, product.mixRates.some((row) => row.labelRateMissing)]).toEqual([key, false]);
    }
  });

  test("a per-gallon row agrees with the product's declared rate (mix, or each target in mixes)", () => {
    let compared = 0;
    for (const [key, product] of products) {
      const declared = product.mixes || (product.mix ? [[null, ...product.mix]] : []);
      const rows = product.mixRates.filter((row) => row.perGallon && row.perGallon.unit === 'fl oz');
      if (!declared.length) continue;
      expect([key, rows.length]).toEqual([key, declared.length]);
      declared.forEach(([, lo, hi], index) => {
        const { amount, amountMax } = rows[index].perGallon;
        expect([key, amount, amountMax ?? amount]).toEqual([key, lo, hi]);
        compared += 1;
      });
    }
    expect(compared).toBeGreaterThanOrEqual(11);
    // The two with a rate only in their label text: DiPel ½ to 1 lb per 100 gal, Conserve 0.06 fl oz per gal.
    expect(guide.products.dipel.rates[0][0]).toBe('½–1 lb / 100 gal');
    expect(perGallon('dipel')).toEqual({ amount: 8 / 100, amountMax: 16 / 100, unit: 'oz' });
    expect(guide.products.conserve.rates[0][0]).toBe('Caterpillar table: 0.06 fl oz / gal');
    expect(perGallon('conserve')).toEqual({ amount: 0.06, unit: 'fl oz' });
  });

  test('label caps the rates must respect', () => {
    // TriStar 8.5 SL: aphids 4.0, mealybugs 8.5, whitefly and soft scale 8.5 to 16.5 fl oz per 100 gal.
    expect(perGallon('tristar', 'Aphids').amount * 100).toBeCloseTo(4, 9);
    expect(perGallon('tristar', 'Mealybugs').amount * 100).toBeCloseTo(8.5, 9);
    expect(rowsOf('tristar').every((row) => (row.perGallon.amountMax ?? row.perGallon.amount) * 100 <= 16.5 + 1e-9)).toBe(true);
    // Distance whitefly: 8 fl oz per 100 gal at most (12 is the scale rate, which is on hold).
    expect(perGallon('distance').amountMax * 100).toBeLessThanOrEqual(8);
    expect(perGallon('acelepryn').amountMax * 100).toBeLessThanOrEqual(16);
    expect(perGallon('floramite').amountMax * 100).toBeLessThanOrEqual(8);
    expect(perGallon('mainspring').amountMax * 100).toBeLessThanOrEqual(8);
    expect(perGallon('zylam').amountMax * 100).toBeLessThanOrEqual(16);
    // Conserve: label maximum 0.2 fl oz per gal. Reliant: 2 to 4 tsp per gal (6 tsp = 1 fl oz).
    expect(perGallon('conserve').amount).toBeLessThanOrEqual(0.2);
    expect(perGallon('reliant').amountMax * 6).toBeCloseTo(4, 9);
    // TriTek: 1 to 2 gal per 100 gal water = 1.28 to 2.56 fl oz per gal.
    for (const key of ['tritek', 'tritek15']) {
      expect(perGallon(key).amount).toBeGreaterThanOrEqual(1.28);
      expect(perGallon(key).amount).toBeLessThanOrEqual(2.56);
    }
    // Merit is a soil drench dosed by trunk or shrub size, never per gallon.
    expect(rowsOf('merit').some((row) => row.perGallon)).toBe(false);
    expect(rowsOf('merit')[0].dose).toMatch(/per inch of trunk diameter, or per foot of shrub height/);
    // Granulars: a rate per 1,000 sq ft, per 100 sq ft or per plant, the hand-spread note, and no tank.
    for (const key of ['snapshot', 'f8012', 'f0016', 'f13013', 'mnsulfate']) {
      const [row] = rowsOf(key);
      expect([key, row.perGallon, row.sprayers]).toEqual([key, undefined, undefined]);
      expect([key, /by hand/.test(row.note)]).toEqual([key, true]);
    }
    expect(rowsOf('snapshot')[0].dose).toMatch(/^2\.3, 3\.45 or 4\.6 lb per 1,000 sq ft/);
  });

  test('bed doses stay at or under the 1 lb nitrogen per 1,000 sq ft limit the guide states', () => {
    // [product, the bed dose's top lb per 100 sq ft, nitrogen share]: lb per 100 sq ft x 10 x N = lb N per 1,000 sq ft.
    for (const [key, top, n] of [['f8012', '1¼', 0.08], ['f13013', '0.75', 0.13]]) {
      const { dose } = rowsOf(key)[0];
      expect([key, dose.includes(`${top} lb per 100 sq ft`)]).toEqual([key, true]);
      expect(Number(top.replace('1¼', '1.25')) * 10 * n).toBeLessThanOrEqual(1);
    }
    // The 8-0-12 bag's 1½ lb top is named as over the limit, never given as the dose.
    expect(rowsOf('f8012')[0].dose).toMatch(/Beds: 1 to 1¼ lb per 100 sq ft \(Waves cap.*the bag's 1½ lb is over it\)/);
  });

  test("the card's own label limits stay: Distance's repeat window and TriStar's distributor registration", () => {
    expect(rowsOf('distance')[0].limit).toContain('6 fl oz followed by 6 fl oz 21 to 28 days later');
    expect(guide.products.distance.limits.some((line) => line.includes('21 to 28 days later'))).toBe(true);
    expect(guide.products.tristar.source).toContain('EPA 8033-106-1001');
    for (const row of rowsOf('tristar')) expect(row.epa).toBe('8033-106-1001');
  });

  test("each month's table carries every visit line's rows, routine first, each with that line's own condition", () => {
    for (const visit of protocols.tree_shrub.visits.filter((v) => v.fieldGuide)) {
      const payload = treeShrubFieldGuide(visit);
      const expected = [
        ...visit.fieldGuide.routine.map((line) => ['Routine when due', line]),
        ...visit.fieldGuide.conditional.map((line) => ['If you find', line]),
      ].flatMap(([title, line]) => rowsOf(line.key).map((row) => ({ ...row, condition: `${title}: ${line.where}` })));
      expect([visit.month, payload.mixRates]).toEqual([visit.month, expected]);
    }
    // August: TriTek only on live finds before 9 AM, never just "ornamentals".
    const aug = treeShrubFieldGuide(protocols.tree_shrub.visits.find((v) => v.month === 'Aug'));
    expect(aug.mixRates.find((row) => row.product === 'TriTek 1%').condition).toBe('If you find: Live scale crawlers, nymphs or mites, before 9 AM');
  });
});
