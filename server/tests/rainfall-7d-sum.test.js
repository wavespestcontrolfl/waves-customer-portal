const { sumTrailingPrecipInches } = require('../services/service-report/application-conditions');

// Open-Meteo daily.precipitation_sum with past_days=7 + forecast_days=1 returns
// 8 entries (7 completed days + today's forecast). The water-balance weekly
// total must drop the forecast day and sum the trailing completed days.
describe('sumTrailingPrecipInches', () => {
  test('drops the trailing forecast day and sums the 7 completed days', () => {
    expect(sumTrailingPrecipInches([0.1, 0.2, 0, 0.5, 0, 0.3, 0.1, 9.9])).toBe(1.2);
  });

  test('caps at the requested window length', () => {
    // 10 completed + 1 forecast → sum only the last 7 completed
    expect(sumTrailingPrecipInches([5, 5, 5, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 9.9], 7)).toBe(0.7);
  });

  test('tolerates nulls inside the window', () => {
    expect(sumTrailingPrecipInches([null, 0.2, null, 0.3, 0.5])).toBeCloseTo(0.5, 5); // drops 0.5 forecast → null+0.2+null+0.3
  });

  test('no usable data → null (caller degrades to rain_unknown)', () => {
    expect(sumTrailingPrecipInches([])).toBeNull();
    expect(sumTrailingPrecipInches(null)).toBeNull();
    expect(sumTrailingPrecipInches([0.5])).toBeNull(); // only a forecast day
  });
});
