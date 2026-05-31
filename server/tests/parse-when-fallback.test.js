/**
 * Unit coverage for the deterministic fallback of the natural-language "when"
 * parser (server/services/scheduling/parse-when.js). The Claude path is the
 * primary route in production; this pins the regex fallback that runs when the
 * API key is missing or the model call fails, plus parseWhen's horizon clamp
 * and the shared summary phrasing.
 */
const { parseWhen, summarizeWindow, _internals } = require('../services/scheduling/parse-when');

const { fallbackParse } = _internals;

// Sunday, May 31 2026 — ~noon ET. dayOfWeek = 0.
const NOW = new Date('2026-05-31T16:00:00Z');

describe('fallbackParse', () => {
  it('resolves "today" and "tomorrow" to single days', () => {
    expect(fallbackParse('today', NOW)).toMatchObject({ dateFrom: '2026-05-31', dateTo: '2026-05-31' });
    expect(fallbackParse('tomorrow', NOW)).toMatchObject({ dateFrom: '2026-06-01', dateTo: '2026-06-01' });
  });

  it('resolves a bare weekday to the next upcoming one', () => {
    // From Sunday May 31, the next Tuesday is June 2.
    expect(fallbackParse('tuesday', NOW)).toMatchObject({ dateFrom: '2026-06-02', dateTo: '2026-06-02' });
  });

  it('resolves "next <weekday>" to the following week', () => {
    expect(fallbackParse('next tuesday', NOW)).toMatchObject({ dateFrom: '2026-06-09', dateTo: '2026-06-09' });
  });

  it('treats "this weekend" on a Sunday as just today', () => {
    expect(fallbackParse('this weekend', NOW)).toMatchObject({ dateFrom: '2026-05-31', dateTo: '2026-05-31' });
  });

  it('parses "early july" to the first ten days of July', () => {
    expect(fallbackParse('early july mornings', NOW)).toMatchObject({
      dateFrom: '2026-07-01', dateTo: '2026-07-10', timeOfDay: 'morning',
    });
  });

  it('extracts time-of-day independent of the date phrase', () => {
    expect(fallbackParse('friday afternoon', NOW).timeOfDay).toBe('afternoon');
    expect(fallbackParse('morning sometime', NOW).timeOfDay).toBe('morning');
    expect(fallbackParse('any time tuesday', NOW).timeOfDay).toBe('any');
  });

  it('returns understood=false with no date when nothing is recognized', () => {
    expect(fallbackParse('sometime soon please', NOW)).toMatchObject({
      dateFrom: null, dateTo: null, understood: false,
    });
  });
});

describe('parseWhen clamp + defaults', () => {
  it('falls back to a near-term window when no date is recognized', async () => {
    const r = await parseWhen('whenever works', { now: NOW, minDaysOut: 1, maxDaysOut: 90, defaultWindowDays: 14 });
    expect(r.dateFrom).toBe('2026-06-01'); // today + minDaysOut(1)
    expect(r.dateTo).toBe('2026-06-14');   // today + 14
    expect(r.understood).toBe(false);
  });

  it('clamps a far-out request to the max horizon', async () => {
    // "december" is well beyond 90 days from May 31 → clamped to the cap.
    const r = await parseWhen('sometime in december', { now: NOW, minDaysOut: 0, maxDaysOut: 90, defaultWindowDays: 14 });
    expect(r.dateTo <= '2026-08-29').toBe(true); // May 31 + 90d
    expect(r.dateFrom <= r.dateTo).toBe(true);
  });
});

describe('summarizeWindow', () => {
  it('messages an empty result with a call-to-action', () => {
    const msg = summarizeWindow({ dateFrom: '2026-06-09', dateTo: '2026-06-09', timeOfDay: 'afternoon' }, { count: 0, nearby: false });
    expect(msg).toMatch(/don't see an open afternoon window/);
    expect(msg).toMatch(/941/);
  });

  it('uses the soft route-density line when nothing is nearby', () => {
    const msg = summarizeWindow({ dateFrom: '2026-06-09', dateTo: '2026-06-09', timeOfDay: 'any' }, { count: 3, nearby: false });
    expect(msg).toMatch(/No route near you that day yet/);
    expect(msg).toMatch(/3 open times/);
  });

  it('confirms openings when a tech is nearby', () => {
    const msg = summarizeWindow({ dateFrom: '2026-06-09', dateTo: '2026-06-09', timeOfDay: 'any' }, { count: 1, nearby: true });
    expect(msg).toMatch(/Here is 1 open time/);
  });
});
