import { expect, it } from 'vitest';
import { BED_FEED_CAP_LB_PER_1000, bedFeedCountyLimitLine, bedFeedRatePer1000 } from './bed-feed-rate';

it('reads a total over the treated area, converting oz and g to lb', () => {
  expect(bedFeedRatePer1000({ totalAmount: 9, amountUnit: 'lb', areaValue: 1200 })).toBe(7.5);
  expect(bedFeedRatePer1000({ totalAmount: 192, amountUnit: 'oz', areaValue: 1200 })).toBe(10);
  expect(bedFeedRatePer1000({ totalAmount: 4082.328, amountUnit: 'g', areaValue: 1200 })).toBeCloseTo(7.5, 3);
});

it('takes the higher of the entered rate and the total over area, and null when neither reads', () => {
  expect(bedFeedRatePer1000({ rate: 7.5, rateUnit: 'lb', totalAmount: 12, amountUnit: 'lb', areaValue: 1200 })).toBe(10);
  expect(bedFeedRatePer1000({ rate: 9, rateUnit: 'lb', totalAmount: 6, amountUnit: 'lb', areaValue: 1200 })).toBe(9);
  expect(bedFeedRatePer1000({ totalAmount: 9, amountUnit: 'lb' })).toBeNull();
  expect(bedFeedRatePer1000({ totalAmount: 9, amountUnit: 'lb', areaValue: 1200, areaUnit: 'linear_ft' })).toBeNull();
  expect(bedFeedRatePer1000({ totalAmount: 9, amountUnit: 'fl_oz', areaValue: 1200 })).toBeNull();
});

it('the county-limit line shows only over 7.5 lb/1k and never says label max', () => {
  expect(BED_FEED_CAP_LB_PER_1000).toBe(7.5);
  expect(bedFeedCountyLimitLine('LESCO 13-0-13', 7.5)).toBeNull();
  expect(bedFeedCountyLimitLine('LESCO 13-0-13', null)).toBeNull();
  const line = bedFeedCountyLimitLine('LESCO 13-0-13', 10);
  expect(line).toBe('LESCO 13-0-13 rate 10 lb/1k is over the county limit of 7.5 lb/1k (0.75 lb per 100 sq ft). It will be recorded and the office will review it.');
  expect(line).not.toMatch(/label max/);
});

it('compares the raw rate to the cap and rounds only the shown number: 9.005 lb over 1,200 sq ft is over the cap and shows 7.5', () => {
  const rate = bedFeedRatePer1000({ totalAmount: 9.005, amountUnit: 'lb', areaValue: 1200 });
  expect(rate).toBeCloseTo(7.5042, 4);
  expect(bedFeedCountyLimitLine('LESCO 13-0-13', rate)).toBe('LESCO 13-0-13 rate 7.5 lb/1k is over the county limit of 7.5 lb/1k (0.75 lb per 100 sq ft). It will be recorded and the office will review it.');
  expect(bedFeedCountyLimitLine('LESCO 13-0-13', bedFeedRatePer1000({ totalAmount: 9, amountUnit: 'lb', areaValue: 1200 }))).toBeNull();
});
