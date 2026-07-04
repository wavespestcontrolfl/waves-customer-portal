const { resolveWeekRain } = require('../services/service-report/application-conditions');

// Guards the single-cell model-spike fallback: Open-Meteo's per-grid-cell daily
// precipitation can carry a spurious convective bullseye (e.g. a Nokomis property
// reading 8.29" the day the town gauge got ~0.5"). resolveWeekRain compares the
// property cell to the city (property + neighbour ring) and, on a spiked day, swaps
// the whole week to the city-collective series and flags it low confidence.
describe('resolveWeekRain — city-collective spike guard', () => {
  test('normal week (property cell tracks its neighbours) keeps the precise property read', () => {
    const prop = [0, 0, 0.12, 0.7, 0, 0.11, 0];
    const cells = [
      prop,
      [0, 0, 0.1, 0.6, 0, 0.1, 0],
      [0, 0, 0.15, 0.8, 0, 0.12, 0],
      [0, 0, 0.09, 0.65, 0, 0.1, 0],
    ];
    const out = resolveWeekRain(prop, cells);
    expect(out.suspect).toBe(false);
    expect(out.source).toBe('property_point');
    expect(out.series).toEqual(prop);
  });

  test('the John Ragsdale / Nokomis spike (8.29" cell vs ~0.5" city) falls back to the city median', () => {
    // Property cell caught the model bullseye; neighbours (the rest of the city) did not.
    const prop = [0, 0, 0.06, 8.29, 0, 0.11, 0];
    const cells = [
      prop,
      [0, 0, 0.05, 0.70, 0, 0.10, 0],
      [0, 0, 0.05, 0.54, 0, 0.10, 0],
      [0, 0, 0.06, 0.28, 0, 0.12, 0],
      [0, 0, 0.05, 0.06, 0, 0.11, 0],
    ];
    const out = resolveWeekRain(prop, cells);
    expect(out.suspect).toBe(true);
    expect(out.source).toBe('city_collective');
    // Wednesday is now the neighbourhood median (~0.41"), not the phantom 8.29".
    expect(out.series[3]).toBeLessThan(1);
    expect(out.series[3]).toBeGreaterThan(0);
    // The dry/quiet days are unchanged by the swap.
    expect(out.series[0]).toBe(0);
  });

  test('a genuinely wet week where neighbours AGREE is NOT flagged (real widespread rain survives)', () => {
    const prop = [0, 3.1, 2.8, 3.4, 0, 0.2, 0];
    const cells = [
      prop,
      [0, 2.9, 2.7, 3.2, 0, 0.2, 0],
      [0, 3.0, 2.9, 3.5, 0, 0.1, 0],
      [0, 3.2, 2.6, 3.3, 0, 0.2, 0],
    ];
    const out = resolveWeekRain(prop, cells);
    expect(out.suspect).toBe(false);
    expect(out.source).toBe('property_point');
  });

  test('a small day above the ratio but below the absolute floor is not treated as a spike', () => {
    // 0.6" is 6× the 0.1" median but under the 1.0" absolute minimum → left alone.
    const prop = [0, 0, 0, 0.6, 0, 0, 0];
    const cells = [prop, [0, 0, 0, 0.1, 0, 0, 0], [0, 0, 0, 0.1, 0, 0, 0]];
    const out = resolveWeekRain(prop, cells);
    expect(out.suspect).toBe(false);
  });

  test('no neighbours available (only the property cell) never fabricates a fallback', () => {
    const prop = [0, 0, 0, 8.29, 0, 0, 0];
    const out = resolveWeekRain(prop, [prop]);
    expect(out.suspect).toBe(false);
    expect(out.source).toBe('property_point');
  });
});
