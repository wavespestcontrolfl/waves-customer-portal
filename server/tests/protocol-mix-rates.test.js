'use strict';

// A card's `mixRates` rows feed the Mix Amounts table on the Protocols tab. Each row holds one per-gallon rate; the
// screen multiplies it for each sprayer. A row must never disagree with the rate the same card already declares for
// the close-out (lineMeta.labelRatePerGallon / tankRatePerGallon).
const protocols = require('../config/protocols.json');

const SPRAYERS = new Set(['bg_1_gal', 'flowzone_4_gal', 'rig_100_gal']);
const UNITS = new Set(['fl oz', 'g', 'oz']);

function cards() {
  const out = [];
  for (const [program, data] of Object.entries(protocols)) {
    for (const visit of data?.visits || []) {
      if (visit.mixRates) out.push({ program, visit });
    }
  }
  return out;
}

describe('protocol card mix rates', () => {
  test('cards carry mix rates', () => {
    const keys = cards().map(({ program, visit }) => `${program}/${visit.visit}`);
    expect(keys).toEqual(expect.arrayContaining(['pest/1', 'pest/3', 'cockroach/1', 'flea/1', 'bed_bug/2', 'mosquito/1', 'termite/3']));
  });

  test('every row is a per-gallon rate with sprayers, or a direct dose', () => {
    for (const { program, visit } of cards()) {
      expect(Array.isArray(visit.mixRates)).toBe(true);
      for (const row of visit.mixRates) {
        const at = `${program}/${visit.visit} ${row.product}`;
        expect(typeof row.product).toBe('string');
        expect(row.product.length).toBeGreaterThan(2);
        expect(typeof row.where).toBe('string');
        if (row.perGallon) {
          expect([at, row.perGallon.amount > 0]).toEqual([at, true]);
          expect([at, UNITS.has(row.perGallon.unit)]).toEqual([at, true]);
          if (row.perGallon.amountMax != null) expect(row.perGallon.amountMax).toBeGreaterThan(row.perGallon.amount);
          expect([at, row.sprayers.length > 0 && row.sprayers.every((key) => SPRAYERS.has(key))]).toEqual([at, true]);
          expect([at, typeof row.sprayVolume]).toEqual([at, 'string']);
        } else {
          expect([at, typeof row.dose]).toEqual([at, 'string']);
          expect(row.sprayers).toBeUndefined();
        }
        expect([at, /^\d+-\d+$/.test(row.epa)]).toEqual([at, true]);
      }
    }
  });

  test('a row agrees with the rate the card declares for the close-out', () => {
    let compared = 0;
    for (const { program, visit } of cards()) {
      for (const meta of Object.values(visit.lineMeta || {})) {
        const declared = meta.labelRatePerGallon || meta.tankRatePerGallon;
        if (!declared) continue;
        for (const hint of meta.catalogProductHints || []) {
          const row = visit.mixRates.find((r) => r.perGallon && (r.product === hint || r.product.startsWith(hint) || hint.startsWith(r.product)));
          if (!row) continue;
          compared += 1;
          const at = `${program}/${visit.visit} ${row.product}`;
          expect([at, row.perGallon.amount]).toEqual([at, Number(declared.amount)]);
          expect([at, row.perGallon.unit.replace(' ', '_')]).toEqual([at, String(declared.unit).replace(' ', '_')]);
          if (declared.epa) expect([at, row.epa]).toEqual([at, declared.epa]);
        }
      }
    }
    expect(compared).toBeGreaterThanOrEqual(6);
  });

  test('label caps that the rate must respect', () => {
    const row = (program, num, product) => protocols[program].visits.find((v) => v.visit === num).mixRates.find((r) => r.product === product);
    // Crosscheck Plus: no more than 1 fl oz per 1,000 sq ft; the band goes out at 1.5625 gal per 1,000 sq ft.
    expect(row('pest', 1, 'LESCO Crosscheck Plus').perGallon.amount * 1.5625).toBeLessThanOrEqual(1);
    // Taurus SC at 0.03% (0.4 fl oz per gal) is the four-a-year schedule; 0.8 is two a year.
    expect(row('pest', 1, 'Taurus SC').perGallon.amount).toBe(0.4);
    // Termite trenching is never weaker than 0.06% (0.8 fl oz per gal).
    expect(row('termite', 3, 'Termidor SC').perGallon.amount).toBe(0.8);
    expect(row('termite', 3, 'Taurus SC').perGallon.amount).toBe(0.8);
  });
});
