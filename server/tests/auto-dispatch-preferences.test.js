const { normalizePreferences } = require('../services/auto-dispatch/preferences');
const { classifyServiceCategory, defaultTimeWindow, TIME_WINDOWS } = require('../services/auto-dispatch/service-category');

describe('service category classification', () => {
  test.each([
    ['Quarterly Pest Control', 'general'],
    ['German Roach Cleanout', 'general'],
    ['Lawn Care Visit #3', 'lawn'],
    ['Fertilization & Weed Control', 'lawn'],
    ['Tree & Shrub', 'lawn'],
    ['WaveGuard Mosquito Treatment', 'mosquito'],
    ['Rodent Exclusion', 'rodent'],
    ['Termite WDO Inspection', 'termite'],
    ['', 'general'],
  ])('%s → %s', (input, expected) => {
    expect(classifyServiceCategory(input)).toBe(expected);
  });
});

describe('service-type default time-of-day (owner rule)', () => {
  test('pest-family services default to EARLY morning', () => {
    expect(defaultTimeWindow('Quarterly Pest Control')).toBe(TIME_WINDOWS.early_morning);
    expect(defaultTimeWindow('Rodent Exclusion')).toBe(TIME_WINDOWS.early_morning);
    expect(defaultTimeWindow('Termite Inspection')).toBe(TIME_WINDOWS.early_morning);
  });
  test('lawn services default to MID/LATE morning', () => {
    expect(defaultTimeWindow('Lawn Care Visit')).toBe(TIME_WINDOWS.late_morning);
  });
});

describe('normalizePreferences', () => {
  test('no row → service-type default time window, no explicit prefs', () => {
    const p = normalizePreferences(null, 'Quarterly Pest Control');
    expect(p.has_explicit_prefs).toBe(false);
    expect(p.preferred_days).toEqual([]);
    expect(p.preferred_time_window).toBeNull();
    expect(p.effective_time_window).toBe(TIME_WINDOWS.early_morning);
    expect(p.blackout).toBeNull();
  });

  test('explicit preferred_day + preferred_time become soft signals', () => {
    const p = normalizePreferences(
      { preferred_day: 'tuesday', preferred_time: 'morning', blackout_start: null, blackout_end: null },
      'Lawn Care',
    );
    expect(p.preferred_days).toEqual(['tuesday']);
    expect(p.preferred_day_indexes).toEqual([2]);
    expect(p.preferred_time_window).toBe(TIME_WINDOWS.morning);
    expect(p.effective_time_window).toBe(TIME_WINDOWS.morning); // explicit overrides default
    expect(p.has_explicit_prefs).toBe(true);
    expect(p.strict).toBe(false);
  });

  test('no_preference values are ignored (fall back to default)', () => {
    const p = normalizePreferences({ preferred_day: 'no_preference', preferred_time: 'no_preference' }, 'Lawn Care');
    expect(p.preferred_days).toEqual([]);
    expect(p.effective_time_window).toBe(TIME_WINDOWS.late_morning);
    expect(p.has_explicit_prefs).toBe(false);
  });

  test('blackout window is captured and normalized to YYYY-MM-DD', () => {
    const p = normalizePreferences(
      { preferred_day: 'no_preference', preferred_time: 'no_preference', blackout_start: '2026-08-01T00:00:00.000Z', blackout_end: '2026-08-10' },
      'Pest Control',
    );
    expect(p.blackout).toEqual({ start: '2026-08-01', end: '2026-08-10' });
    expect(p.has_explicit_prefs).toBe(true);
  });
});
