import { describe, expect, it } from 'vitest';
import { pestDefaultMixSelections } from './pest-default-mix';
import {
  applyTaurusYearlyLimit,
  isTaurusProduct,
  taurusLeftOutLine,
  taurusOverLimitWarning,
  taurusYearlyCountOf,
  taurusYearlyNote,
} from './taurus-yearly-limit';

const CATALOG = [
  { id: 't', name: 'Taurus SC' },
  { id: 'c', name: 'LESCO Crosscheck Plus' },
  { id: 's', name: 'LESCO 90/10 Nonionic Surfactant' },
];
const names = (selections) => selections.map(({ product }) => product.name);

describe('applyTaurusYearlyLimit', () => {
  const mix = pestDefaultMixSelections(CATALOG);

  it('leaves Taurus out at 4 or more, keeping Crosscheck and the surfactant', () => {
    expect(names(applyTaurusYearlyLimit(mix, 4))).toEqual(['LESCO Crosscheck Plus', 'LESCO 90/10 Nonionic Surfactant']);
    expect(names(applyTaurusYearlyLimit(mix, 5))).toEqual(['LESCO Crosscheck Plus', 'LESCO 90/10 Nonionic Surfactant']);
  });

  it('keeps the whole mix under 4', () => {
    expect(names(applyTaurusYearlyLimit(mix, 3))).toEqual(['Taurus SC', 'LESCO Crosscheck Plus', 'LESCO 90/10 Nonionic Surfactant']);
    expect(names(applyTaurusYearlyLimit(mix, 0))).toHaveLength(3);
  });

  it('keeps the whole mix when the count is unknown', () => {
    expect(applyTaurusYearlyLimit(mix, null)).toHaveLength(3);
    expect(applyTaurusYearlyLimit(mix, undefined)).toHaveLength(3);
  });

  it('does not touch the amounts of the rows it keeps', () => {
    expect(applyTaurusYearlyLimit(mix, 4).map((row) => row.totalAmount)).toEqual(mix.slice(1).map((row) => row.totalAmount));
  });
});

describe('taurusYearlyCountOf', () => {
  it('reads the server count, and says unknown for anything else', () => {
    expect(taurusYearlyCountOf({ count: 2, limit: 4, year: 2026 })).toBe(2);
    expect(taurusYearlyCountOf({ count: 0 })).toBe(0);
    expect(taurusYearlyCountOf(null)).toBeNull();
    expect(taurusYearlyCountOf(undefined)).toBeNull();
    expect(taurusYearlyCountOf({ count: '4' })).toBeNull();
    expect(taurusYearlyCountOf({ count: -1 })).toBeNull();
  });
});

describe('notes', () => {
  it('names the left-out line only at the limit', () => {
    expect(taurusLeftOutLine(4)).toBe('Taurus left out: 4 of 4 this year at this home (label limit).');
    expect(taurusLeftOutLine(3)).toBeNull();
    expect(taurusLeftOutLine(null)).toBeNull();
  });

  it('warns on a manual Taurus over the limit, by the next application number', () => {
    expect(taurusOverLimitWarning(4, [{ name: 'Taurus SC' }])).toBe("5th Taurus this year at this home: over the label's 4.");
    expect(taurusOverLimitWarning(5, [{ name: 'Taurus SC' }])).toBe("6th Taurus this year at this home: over the label's 4.");
    expect(taurusOverLimitWarning(10, [{ name: 'Taurus SC' }])).toMatch(/^11th /);
  });

  it('does not warn without Taurus selected, under the limit, or with an unknown count', () => {
    expect(taurusOverLimitWarning(4, [{ name: 'LESCO Crosscheck Plus' }])).toBeNull();
    expect(taurusOverLimitWarning(3, [{ name: 'Taurus SC' }])).toBeNull();
    expect(taurusOverLimitWarning(null, [{ name: 'Taurus SC' }])).toBeNull();
    expect(taurusOverLimitWarning(4, undefined)).toBeNull();
  });

  it('shows the warning in place of the left-out line once Taurus is back on the list', () => {
    expect(taurusYearlyNote(4, [])).toMatch(/^Taurus left out/);
    expect(taurusYearlyNote(4, [{ name: 'Taurus SC' }])).toMatch(/^5th Taurus/);
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
