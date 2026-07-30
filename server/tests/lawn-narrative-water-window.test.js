/**
 * Rain-window merge guard (codex P1 #3093 r3): the narrative model's water
 * copy must describe the past-7-days window — output reframing it as the
 * visit interval or a single day's rain falls back to the deterministic
 * sentence, because the prompt rule alone shipped "since the last visit"
 * on a live report.
 */

const { _test } = require('../services/service-report/lawn-report-narrative');

const FALLBACK = 'We picked up about 4.23 inches of rain this week, well over the target.';

describe('safeWaterText — rain window enforcement', () => {
  test.each([
    'We picked up about 4.23 inches of rain since the last visit.',
    'Rain brought about 1.39 inches this cycle, a bit over target.',
    'Roughly 2 inches fell between visits, so hold off on irrigation.',
    'About 1.9 inches of rain since your last service kept things damp.',
  ])('window-violating copy falls back: %s', (bad) => {
    expect(_test.safeWaterText(bad, FALLBACK)).toBe(FALLBACK);
  });

  test('weekly-window copy passes through', () => {
    const good = 'The past week brought about 4.23 inches of rain, well over what the lawn needs.';
    expect(_test.safeWaterText(good, FALLBACK)).toBe(good);
  });

  test('empty output keeps the deterministic fallback', () => {
    expect(_test.safeWaterText('', FALLBACK)).toBe(FALLBACK);
  });

  test('mergeNarrative applies the guard to water.explanation', () => {
    const v2 = { water: { explanation: FALLBACK }, snapshot: null, diagnosis: [], insights: [] };
    const merged = _test.mergeNarrative(v2, { water: 'About 3 inches of rain since the last visit.' });
    expect(merged.water.explanation).toBe(FALLBACK);
  });
});
