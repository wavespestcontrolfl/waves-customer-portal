import { describe, expect, it } from 'vitest';
import { pestDefaultMixSelections } from './pest-default-mix';
import {
  applyTaurusYearlyLimit,
  isHighTaurusRate,
  isTaurusProduct,
  taurusLeftOutLine,
  taurusOverLimitWarning,
  taurusYearlyNote,
  taurusYearlyOf,
} from './taurus-yearly-limit';

const CATALOG = [
  { id: 't', name: 'Taurus SC' },
  { id: 'c', name: 'LESCO Crosscheck Plus' },
  { id: 's', name: 'LESCO 90/10 Nonionic Surfactant' },
];
const names = (selections) => selections.map(({ product }) => product.name);
const ROOM = { high: 0, low: 3, count: 3, eligible: true, year: 2026 };
const FULL = { high: 0, low: 4, count: 4, eligible: false, year: 2026 };
const TWO_HIGH = { high: 2, low: 0, count: 2, eligible: false, year: 2026 };
const WITHOUT_TAURUS = ['LESCO Crosscheck Plus', 'LESCO 90/10 Nonionic Surfactant'];
const UNKNOWN_LINE = "Taurus left out: this year's count is unavailable. Add it only if this home is still within the label's yearly limit.";

describe('applyTaurusYearlyLimit', () => {
  const mix = pestDefaultMixSelections(CATALOG);

  it('keeps the whole mix only when the home has room under the label', () => {
    expect(names(applyTaurusYearlyLimit(mix, ROOM))).toEqual(['Taurus SC', ...WITHOUT_TAURUS]);
  });

  it('leaves Taurus out when no application fits (4 at 0.03%, or the 0.06% scenarios), keeping Crosscheck and the surfactant', () => {
    expect(names(applyTaurusYearlyLimit(mix, FULL))).toEqual(WITHOUT_TAURUS);
    expect(names(applyTaurusYearlyLimit(mix, TWO_HIGH))).toEqual(WITHOUT_TAURUS);
  });

  it('leaves Taurus out when the answer is unknown (label eligibility not known)', () => {
    for (const unknown of [null, undefined, {}, { count: 1 }, { eligible: 'yes' }]) {
      expect(names(applyTaurusYearlyLimit(mix, unknown))).toEqual(WITHOUT_TAURUS);
    }
  });

  it('does not touch the amounts of the rows it keeps', () => {
    expect(applyTaurusYearlyLimit(mix, FULL).map((row) => row.totalAmount)).toEqual(mix.slice(1).map((row) => row.totalAmount));
  });
});

describe('taurusYearlyOf', () => {
  it('returns the server answer when it says whether another application fits, and unknown for anything else', () => {
    expect(taurusYearlyOf(ROOM)).toBe(ROOM);
    expect(taurusYearlyOf(FULL)).toBe(FULL);
    expect(taurusYearlyOf(null)).toBeNull();
    expect(taurusYearlyOf(undefined)).toBeNull();
    expect(taurusYearlyOf({ count: 2 })).toBeNull();
    expect(taurusYearlyOf({ eligible: 1 })).toBeNull();
  });
});

describe('notes', () => {
  it('names the count in the left-out line when the home has no room', () => {
    expect(taurusLeftOutLine(FULL)).toBe("Taurus left out: this home reached the label's yearly limit (4 this year).");
    expect(taurusLeftOutLine(TWO_HIGH)).toBe("Taurus left out: this home reached the label's yearly limit (2 this year).");
    expect(taurusLeftOutLine(ROOM)).toBeNull();
  });

  it('says the count is unavailable when it is unknown', () => {
    expect(taurusLeftOutLine(null)).toBe(UNKNOWN_LINE);
    expect(taurusLeftOutLine(undefined)).toBe(UNKNOWN_LINE);
  });

  it('warns on a manual Taurus when no application fits', () => {
    expect(taurusOverLimitWarning(FULL, [{ name: 'Taurus SC' }])).toBe("Over the label's yearly Taurus limit at this home.");
    expect(taurusOverLimitWarning(TWO_HIGH, [{ name: 'Taurus SC' }])).toBe("Over the label's yearly Taurus limit at this home.");
  });

  it('judges a manual Taurus row mixed above 0.4 fl_oz/gal (0.06%) by whether another 0.06% application fits', () => {
    // Three at 0.03%: another 0.03% fits, another 0.06% does not.
    const THREE_LOW = { high: 0, low: 3, count: 3, eligible: true, eligibleHigh: false, year: 2026 };
    const strong = { name: 'Taurus SC', rate: '0.8', rateUnit: 'fl_oz/gal' };
    expect(taurusOverLimitWarning(THREE_LOW, [strong])).toBe("Over the label's yearly Taurus limit at this home.");
    expect(taurusOverLimitWarning(THREE_LOW, [{ name: 'Taurus SC', rate: '0.4', rateUnit: 'fl_oz/gal' }])).toBeNull();
    expect(taurusOverLimitWarning(THREE_LOW, [{ name: 'Taurus SC', rate: '1.6', rateUnit: 'oz' }])).toBeNull();
    expect(taurusOverLimitWarning(THREE_LOW, [{ name: 'Taurus SC' }])).toBeNull();
    // Room for a 0.06% application (none at 0.03%, one 0.06%): the strong row is fine too.
    const ONE_HIGH = { high: 1, low: 0, count: 1, eligible: true, eligibleHigh: true, year: 2026 };
    expect(taurusOverLimitWarning(ONE_HIGH, [strong])).toBeNull();
    // An older server without eligibleHigh falls back to `eligible`.
    expect(taurusOverLimitWarning(ROOM, [strong])).toBeNull();
    expect(taurusOverLimitWarning(FULL, [strong])).toBe("Over the label's yearly Taurus limit at this home.");
    // The left-out line and the house-mix filter still follow the low-rate answer.
    expect(taurusLeftOutLine(THREE_LOW)).toBeNull();
    expect(names(applyTaurusYearlyLimit(pestDefaultMixSelections(CATALOG), THREE_LOW))).toEqual(['Taurus SC', ...WITHOUT_TAURUS]);
  });

  it('does not warn without Taurus selected, with room under the label, or with an unknown answer', () => {
    expect(taurusOverLimitWarning(FULL, [{ name: 'LESCO Crosscheck Plus' }])).toBeNull();
    expect(taurusOverLimitWarning(ROOM, [{ name: 'Taurus SC' }])).toBeNull();
    expect(taurusOverLimitWarning(null, [{ name: 'Taurus SC' }])).toBeNull();
    expect(taurusOverLimitWarning(FULL, undefined)).toBeNull();
  });

  it('shows the warning in place of the left-out line once Taurus is back on the list', () => {
    expect(taurusYearlyNote(FULL, [], { mixVisit: true })).toMatch(/^Taurus left out: this home reached/);
    expect(taurusYearlyNote(FULL, [{ name: 'Taurus SC' }], { mixVisit: true })).toMatch(/^Over the label's yearly Taurus limit/);
  });

  it('shows the left-out line only on a house-mix visit with Taurus off the list', () => {
    expect(taurusYearlyNote(FULL, [])).toBeNull();
    expect(taurusYearlyNote(null, [], { mixVisit: true })).toBe(UNKNOWN_LINE);
    // Added by hand while the answer is unknown: no warning (nothing to compare), and no "left out" line either.
    expect(taurusYearlyNote(null, [{ name: 'Taurus SC' }], { mixVisit: true })).toBeNull();
    expect(taurusYearlyNote(ROOM, [], { mixVisit: true })).toBeNull();
  });
});

describe('isTaurusProduct', () => {
  it('matches the catalog name, not other products', () => {
    expect(isTaurusProduct({ name: ' Taurus SC ' })).toBe(true);
    expect(isTaurusProduct({ productName: 'taurus sc' })).toBe(true);
    expect(isTaurusProduct({ name: 'LESCO Crosscheck Plus' })).toBe(false);
    expect(isTaurusProduct(null)).toBe(false);
  });
});

describe('isHighTaurusRate (the same rule the server applies to a saved ledger row)', () => {
  it('lets a fl_oz/gal rate decide when the row has one', () => {
    expect(isHighTaurusRate({ rate: '0.8', rateUnit: 'fl_oz/gal' })).toBe(true);
    expect(isHighTaurusRate({ rate: '0.4', rateUnit: 'fl_oz/gal', totalAmount: 3.2, amountUnit: 'fl_oz' })).toBe(false);
  });

  it('reads a bare oz rate or an amount above the 1.6 fl oz house mix as the old 0.06% tank', () => {
    expect(isHighTaurusRate({ rate: '3.2', rateUnit: 'oz' })).toBe(true);
    expect(isHighTaurusRate({ rate: '1.6', rateUnit: 'oz', totalAmount: 3.2, amountUnit: 'fl_oz' })).toBe(true);
    expect(isHighTaurusRate({ totalAmount: 3.2 })).toBe(true);
    expect(isHighTaurusRate({ rate: '1.6', rateUnit: 'oz', totalAmount: 1.6, amountUnit: 'fl_oz' })).toBe(false);
    expect(isHighTaurusRate({ totalAmount: 3.2, amountUnit: 'gal' })).toBe(false);
    expect(isHighTaurusRate({ name: 'Taurus SC' })).toBe(false);
  });

  it('reads an oz/gal rate like fl_oz/gal, and converts a teaspoon amount to fl oz first', () => {
    expect(isHighTaurusRate({ rate: '0.8', rateUnit: 'oz/gal' })).toBe(true);
    expect(isHighTaurusRate({ rate: '0.4', rateUnit: 'oz/gal', totalAmount: 3.2, amountUnit: 'fl_oz' })).toBe(false);
    expect(isHighTaurusRate({ totalAmount: 19.2, amountUnit: 'tsp' })).toBe(true);
    expect(isHighTaurusRate({ totalAmount: 9.6, amountUnit: 'tsp' })).toBe(false);
    expect(isHighTaurusRate({ rate: 9.6, rateUnit: 'tsp' })).toBe(false);
  });

  it('warns when a 3.2 oz edit is made after three 0.03% applications (no 0.06% slot left after them)', () => {
    const threeLow = { high: 0, low: 3, count: 3, eligible: true, eligibleHigh: false, year: 2026 };
    expect(taurusOverLimitWarning(threeLow, [{ name: 'Taurus SC', rate: '1.6', rateUnit: 'oz' }])).toBeNull();
    expect(taurusOverLimitWarning(threeLow, [{ name: 'Taurus SC', rate: '3.2', rateUnit: 'oz' }])).toBe("Over the label's yearly Taurus limit at this home.");
  });
});
