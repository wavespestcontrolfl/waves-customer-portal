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
    'We measured 4.2 inches in the last 24 hours.',
    'Rainfall over the past day has been heavy.',
    'Since we last visited, about 2 inches of rain fell.',
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

  test('other narrative fields reject rain claims tied to the wrong window', () => {
    const det = 'A few faint blotchy spots after the recent rain.';
    const v2 = { water: null, snapshot: { mainWatch: det }, diagnosis: [], insights: [] };
    const merged = _test.mergeNarrative(v2, { mainWatch: 'We saw 4 inches of rain since the last visit, so watch the damp spots.' });
    expect(merged.snapshot.mainWatch).toBe(det);
  });

  test('non-rain trend claims about the last visit still pass in other fields', () => {
    const det = 'Weed pressure is being watched.';
    const v2 = { water: null, snapshot: { mainWatch: det }, diagnosis: [], insights: [] };
    const merged = _test.mergeNarrative(v2, { mainWatch: 'Weed pressure has eased since the last visit.' });
    expect(merged.snapshot.mainWatch).toBe('Weed pressure has eased since the last visit.');
  });
});
