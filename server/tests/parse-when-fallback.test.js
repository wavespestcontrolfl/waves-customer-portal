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

  it('resolves "next <weekday>" to the coming one, the first such day after today', () => {
    // From Sunday May 31 the coming Tuesday is June 2 (it used to skip to June 9).
    expect(fallbackParse('next tuesday', NOW)).toMatchObject({ dateFrom: '2026-06-02', dateTo: '2026-06-02' });
    // From Friday Nov 6 2026 (the walk's case) it is Tue Nov 10, and the search keeps its time of day.
    const friday = new Date('2026-11-06T17:00:00Z');
    expect(fallbackParse('next tuesday afternoon', friday)).toMatchObject({ dateFrom: '2026-11-10', dateTo: '2026-11-10', timeOfDay: 'afternoon' });
    // Asked on that weekday, "next" never means today: it is a week out. A bare weekday still means today.
    const tuesday = new Date('2026-11-10T17:00:00Z');
    expect(fallbackParse('next tuesday', tuesday)).toMatchObject({ dateFrom: '2026-11-17' });
    expect(fallbackParse('tuesday', tuesday)).toMatchObject({ dateFrom: '2026-11-10' });
  });

  it('resolves "this week", "next weekend", and "next week" consistently (Mon–Sun weeks)', () => {
    const friday = new Date('2026-11-06T17:00:00Z');
    expect(fallbackParse('this week', friday)).toMatchObject({ dateFrom: '2026-11-06', dateTo: '2026-11-08' });
    expect(fallbackParse('next weekend', friday)).toMatchObject({ dateFrom: '2026-11-14', dateTo: '2026-11-15' });
    expect(fallbackParse('next week', friday)).toMatchObject({ dateFrom: '2026-11-09', dateTo: '2026-11-15' });
    const monday = new Date('2026-11-09T17:00:00Z');
    expect(fallbackParse('next week', monday)).toMatchObject({ dateFrom: '2026-11-16', dateTo: '2026-11-22' });
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

  it('does not treat "early <month>" as a morning preference', () => {
    // "early" modifies the date, not the time — afternoon slots must survive.
    expect(fallbackParse('early july', NOW).timeOfDay).toBe('any');
    expect(fallbackParse('early next week', NOW).timeOfDay).toBe('any');
  });

  it('returns understood=false with no date when nothing is recognized', () => {
    expect(fallbackParse('sometime soon please', NOW)).toMatchObject({
      dateFrom: null, dateTo: null, understood: false,
    });
  });

  it('parses explicit calendar dates (month+day, M/D, ISO) and rejects impossible dates', () => {
    const nov27 = new Date('2026-11-27T17:00:00Z');
    expect(fallbackParse('Dec 3', nov27)).toMatchObject({
      dateFrom: '2026-12-03', dateTo: '2026-12-03', timeOfDay: 'any', understood: true,
    });
    expect(fallbackParse('December 3rd afternoon', nov27)).toMatchObject({
      dateFrom: '2026-12-03', dateTo: '2026-12-03', timeOfDay: 'afternoon', understood: true,
    });
    expect(fallbackParse('3rd of December morning', nov27)).toMatchObject({
      dateFrom: '2026-12-03', dateTo: '2026-12-03', timeOfDay: 'morning', understood: true,
    });
    expect(fallbackParse('12/3', nov27)).toMatchObject({
      dateFrom: '2026-12-03', dateTo: '2026-12-03', understood: true,
    });
    expect(fallbackParse('2026-12-03', nov27)).toMatchObject({
      dateFrom: '2026-12-03', dateTo: '2026-12-03', understood: true,
    });
    // Jan 15 asked on Nov 27 rolls into next calendar year (2027-01-15).
    expect(fallbackParse('Jan 15', nov27)).toMatchObject({
      dateFrom: '2027-01-15', dateTo: '2027-01-15', understood: true,
    });
    // Impossible calendar dates must stop as ununderstood instead of falling through to a full month.
    expect(fallbackParse('2026-02-30', nov27)).toMatchObject({ dateFrom: null, dateTo: null, understood: false });
    expect(fallbackParse('Feb 30', nov27)).toMatchObject({ dateFrom: null, dateTo: null, understood: false });
    expect(fallbackParse('2/30', nov27)).toMatchObject({ dateFrom: null, dateTo: null, understood: false });
  });
});

describe('parseWhen fast deterministic path and interactive AI policy', () => {
  const llmCall = require('../services/llm/call');
  const MODELS = require('../config/models');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['Tomorrow morning', { dateFrom: '2026-11-28', dateTo: '2026-11-28', timeOfDay: 'morning' }],
    ['This weekend', { dateFrom: '2026-11-28', dateTo: '2026-11-29', timeOfDay: 'any' }],
    ['Sunday', { dateFrom: '2026-11-29', dateTo: '2026-11-29', timeOfDay: 'any' }],
    ['Dec 3', { dateFrom: '2026-12-03', dateTo: '2026-12-03', timeOfDay: 'any' }],
    ['12/3 afternoon', { dateFrom: '2026-12-03', dateTo: '2026-12-03', timeOfDay: 'afternoon' }],
    ['next tuesday morning', { dateFrom: '2026-12-01', dateTo: '2026-12-01', timeOfDay: 'morning' }],
  ])('handles clean query %s deterministically without calling the LLM', async (query, expected) => {
    const spy = jest.spyOn(llmCall, 'dispatchWithFallback');
    const nov27 = new Date('2026-11-27T17:00:00Z');
    const res = await parseWhen(query, { now: nov27, minDaysOut: 0, maxDaysOut: 90, defaultWindowDays: 14 });
    expect(res).toMatchObject({ ...expected, understood: true, source: 'deterministic' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('routes complex phrasing to fastStructuredInteractive with a 4s timeout and rejects impossible AI dates', async () => {
    const spy = jest.spyOn(llmCall, 'dispatchWithFallback').mockResolvedValueOnce({
      ok: true,
      json: { date_from: '2026-12-01', date_to: '2026-12-04', time_of_day: 'afternoon', understood: true },
    });
    const nov27 = new Date('2026-11-27T17:00:00Z');
    const ok = await parseWhen('Next week afternoon', { now: nov27, minDaysOut: 0, maxDaysOut: 90 });
    expect(ok).toMatchObject({
      dateFrom: '2026-12-01', dateTo: '2026-12-04', timeOfDay: 'afternoon', understood: true, source: 'ai',
    });
    expect(spy).toHaveBeenCalledWith(
      MODELS.TEXT_POLICIES.fastStructuredInteractive,
      expect.objectContaining({ laneId: 'parse_when', timeoutMs: 4000 }),
    );

    // Impossible calendar date from AI (2026-02-30) is rejected and falls back.
    spy.mockResolvedValueOnce({
      ok: true,
      json: { date_from: '2026-02-30', date_to: '2026-02-30', time_of_day: 'any', understood: true },
    });
    const bad = await parseWhen('after 2pm except wednesday', { now: nov27, minDaysOut: 1, maxDaysOut: 90 });
    expect(bad.source).toBe('fallback');
    expect(bad.dateFrom).toBe('2026-11-28');
  });

  it.each([
    "Can't do Friday",
    '12/3 and 12/4',
    'Friday or Saturday morning',
    'Not Monday please',
  ])('sends partial/ambiguous/negated query %s to AI instead of fast-pathing a fragment', async (query) => {
    const spy = jest.spyOn(llmCall, 'dispatchWithFallback').mockResolvedValueOnce({
      ok: true,
      json: { date_from: '2026-12-03', date_to: '2026-12-04', time_of_day: 'any', understood: true },
    });
    const nov27 = new Date('2026-11-27T17:00:00Z');
    const res = await parseWhen(query, { now: nov27, minDaysOut: 0, maxDaysOut: 90 });
    expect(res.source).toBe('ai');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fallbackParse does not collapse negated, boundary, or multi-date phrases to one day', () => {
    const nov27 = new Date('2026-11-27T17:00:00Z');
    for (const phrase of ["Can't do Friday", "can't do next Friday", 'Friday or Saturday morning', 'any day except 12/3', 'after 12/3', '12/3 or 12/4']) {
      expect(fallbackParse(phrase, nov27)).toMatchObject({
        dateFrom: null, dateTo: null, understood: false,
      });
    }
  });

  it('keeps "Friday or Saturday morning" unresolved when AI times out', async () => {
    const spy = jest.spyOn(llmCall, 'dispatchWithFallback').mockResolvedValueOnce({ ok: false, json: null });
    const nov27 = new Date('2026-11-27T17:00:00Z');
    const res = await parseWhen('Friday or Saturday morning', { now: nov27, minDaysOut: 1, maxDaysOut: 90, defaultWindowDays: 14 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ source: 'fallback', understood: false, timeOfDay: 'morning', dateFrom: '2026-11-28', dateTo: '2026-12-11' });
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
