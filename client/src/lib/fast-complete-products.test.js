// "Same as last time" fills the very amount the picker shows the tech
// (lib/fast-complete-products.js usualAmountFor / usualAmountText).
import { describe, expect, test } from 'vitest';
import { amountText, usualAmountFor, usualAmountText } from './fast-complete-products';

const liquid = { id: 'p1', name: 'Taurus SC', category: 'Insecticide' };
const gel = { id: 'p2', name: 'Advion Ant Bait Gel', category: 'Bait' };

describe('usualAmountFor', () => {
  test.each([
    [liquid, { usualAmount: 4, usualUnit: 'fl_oz' }],
    [liquid, { usualAmount: 0.25, usualUnit: 'fl_oz' }],
    [liquid, { usualAmount: 30, usualUnit: 'ml' }],
    [gel, { usualAmount: 5, usualUnit: 'g' }],
  ])('reads as the picker writes it: %o %o', (product, common) => {
    const text = usualAmountText(product, common);
    const usual = usualAmountFor(product, common);
    // whatever the picker shows, the filled amount words the same
    if (usual) expect(amountText(usual.amount, usual.unit)).toBe(text);
    else expect(text == null || usual === null).toBe(true);
  });

  test('a sub-ounce liquid fills in the spoon unit the tile shows, never fl oz', () => {
    const usual = usualAmountFor(liquid, { usualAmount: 0.25, usualUnit: 'fl_oz' });
    expect(usual?.unit).toBe('tsp');
  });

  test('nothing known is null', () => {
    expect(usualAmountFor(liquid, null)).toBeNull();
    expect(usualAmountFor(liquid, { usualAmount: 0, usualUnit: 'fl_oz' })).toBeNull();
  });
});
