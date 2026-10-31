/**
 * Heat index for tech safety (owner 2026-10-31). The NWS equation
 * (https://www.wpc.ncep.noaa.gov/html/heatindex_equation.shtml) is checked against NWS heat index chart cells
 * within 2°F; the levels are OSHA's "Using the Heat Index: A Guide for Employers" bands.
 */
const { heatIndexF, heatLevel, heatSafetyFromRows } = require('../services/heat-index');

describe('heatIndexF (NWS equation)', () => {
  test.each([
    // [air °F, RH %, NWS chart °F]
    [90, 70, 106],
    [90, 60, 100],
    [100, 50, 118],
    [96, 65, 121],
    [85, 90, 102],
    [80, 40, 80],
    [110, 40, 136],
    [86, 100, 112],
  ])('%i°F at %i%% RH reads about %i°F', (t, rh, chart) => {
    expect(Math.abs(heatIndexF(t, rh) - chart)).toBeLessThanOrEqual(2);
  });

  test('cool or mild air uses the simple formula (no regression below 80°F)', () => {
    expect(heatIndexF(70, 50)).toBeCloseTo(69.0, 1);
    expect(heatIndexF(75, 60)).toBeLessThan(80);
  });

  test('the dry-air adjustment lowers the regression (RH < 13%, 80-112°F)', () => {
    const dry = heatIndexF(95, 10);
    // Without the adjustment the regression gives 95 + about 3; the NWS lowers it.
    expect(dry).toBeGreaterThan(85);
    expect(dry).toBeLessThan(92);
  });

  test('the humid-air adjustment raises the regression (RH > 85%, 80-87°F)', () => {
    expect(heatIndexF(85, 95)).toBeGreaterThan(heatIndexF(85, 85));
    expect(Math.abs(heatIndexF(85, 95) - 107)).toBeLessThanOrEqual(3);
  });

  test('a missing or non-numeric reading gives null, never a number from null', () => {
    expect(heatIndexF(90, null)).toBeNull();
    expect(heatIndexF(null, 60)).toBeNull();
    expect(heatIndexF(undefined, undefined)).toBeNull();
    expect(heatIndexF('hot', 60)).toBeNull();
  });
});

describe('heatLevel (OSHA bands)', () => {
  test('nothing below 103°F; High 103-115; extreme above 115', () => {
    expect(heatLevel(102.9)).toBeNull();
    expect(heatLevel(103)).toBe('high');
    expect(heatLevel(115)).toBe('high');
    expect(heatLevel(115.1)).toBe('extreme');
    expect(heatLevel(NaN)).toBeNull();
    expect(heatLevel(null)).toBeNull();
  });
});

describe('heatSafetyFromRows', () => {
  const label = (row) => row.label;
  const rowAt = (l, temperatureF, relativeHumidity) => ({ label: l, temperatureF, relativeHumidity });

  test('High: the worst hour, the tech text', () => {
    const out = heatSafetyFromRows([rowAt('2 pm', 90, 60), rowAt('3 pm', 91, 72)], label);
    expect(out).toEqual({ heatIndexF: 111, at: '3 pm', level: 'high', text: 'Heat index 111°F at 3 pm. Drink water every 15 minutes. Rest in the shade.' });
  });

  test('extreme above 115°F', () => {
    const out = heatSafetyFromRows([rowAt('2 pm', 100, 50)], label);
    expect(out).toMatchObject({ heatIndexF: 118, at: '2 pm', level: 'extreme' });
    expect(out.text).toBe('Heat index 118°F at 2 pm — extreme heat. Drink water every 15 minutes. Rest in the shade often. Watch each other for heat illness.');
  });

  test('no line below High, with no humidity, or with no rows', () => {
    expect(heatSafetyFromRows([rowAt('2 pm', 90, 50)], label)).toBeNull();
    expect(heatSafetyFromRows([rowAt('2 pm', 100, null), rowAt('3 pm', null, 70)], label)).toBeNull();
    expect(heatSafetyFromRows([], label)).toBeNull();
  });

  test('an hour with both readings still counts when the other hour has a gap', () => {
    expect(heatSafetyFromRows([rowAt('2 pm', 100, null), rowAt('3 pm', 100, 50)], label)).toMatchObject({ at: '3 pm', level: 'extreme' });
  });

  test('the band follows the whole number the tech reads', () => {
    // 89°F / 87% RH -> 115.04: reads "115°F", which OSHA puts in High, not extreme.
    expect(heatSafetyFromRows([rowAt('2 pm', 89, 87)], label)).toMatchObject({ heatIndexF: 115, level: 'high' });
    // 85°F / 92% RH -> 102.89: reads "103°F", the first High number, so the line shows.
    expect(heatSafetyFromRows([rowAt('2 pm', 85, 92)], label)).toMatchObject({ heatIndexF: 103, level: 'high' });
  });
});
