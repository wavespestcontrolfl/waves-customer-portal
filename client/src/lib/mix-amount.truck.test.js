import { expect, test } from 'vitest';
import { formatMeasuredAmount, formatMeasuredRange } from './mix-amount';
const truck = { truckMeasures: true };
test('oil cup measures round down at one, four and 110 gallons', () => {
  expect(formatMeasuredAmount(1.28, 'fl oz', truck)).toBe('≈ 1¼ fl oz');
  expect(formatMeasuredAmount(5.12, 'fl oz', truck)).toBe('≈ 5 fl oz');
  expect(formatMeasuredAmount(140.8, 'fl oz', truck)).toBe('≈ 140¾ fl oz');
  expect(formatMeasuredAmount(211.2, 'fl oz', truck)).toBe('≈ 211 fl oz');
  expect(formatMeasuredAmount(5.12, 'fl oz')).toBe('5.12 fl oz');
});
test('label ranges use inward cup bounds and prefer quarter teaspoons', () => {
  expect(formatMeasuredRange(0.04, 0.08, 'fl oz', truck)).toBe('¼ tsp');
  expect(formatMeasuredRange(0.16, 0.32, 'fl oz', truck)).toBe('1 tsp – 1¾ tsp');
  expect(formatMeasuredRange(4.4, 8.8, 'fl oz', truck)).toBe('4½ fl oz – 8¾ fl oz');
  expect(formatMeasuredRange(7.975, 17.6, 'fl oz', truck)).toBe('8 fl oz – 17½ fl oz');
  expect(formatMeasuredRange(0.015, 0.025, 'fl oz', truck)).toBe('⅛ tsp');
  expect(formatMeasuredRange(2.31, 2.4, 'fl oz', truck)).toBe('2.31 fl oz – 2.4 fl oz');
});
