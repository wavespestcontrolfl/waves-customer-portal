/**
 * ContextAggregator arrival-window derivation — pure-logic coverage.
 * No DB, no LLM. Guards the v6 data-grounding fix (Codex P2): the real
 * window lives in window_start/window_end (Postgres `time`, ET wall clock),
 * NOT window_display, so the drafter must see the actual time.
 */
const aggregator = require('../services/context-aggregator');

describe('ContextAggregator.formatClockTime', () => {
  test("'HH:MM:SS' ET wall clock → 12-hour label", () => {
    expect(aggregator.formatClockTime('13:00:00')).toBe('1:00 PM');
    expect(aggregator.formatClockTime('08:30:00')).toBe('8:30 AM');
    expect(aggregator.formatClockTime('00:15:00')).toBe('12:15 AM');
    expect(aggregator.formatClockTime('12:00:00')).toBe('12:00 PM');
  });

  test('unparseable shapes return null (so deriveWindow falls through, never guesses)', () => {
    expect(aggregator.formatClockTime(null)).toBeNull();
    expect(aggregator.formatClockTime('')).toBeNull();
    expect(aggregator.formatClockTime('not a time')).toBeNull();
  });
});

describe('ContextAggregator.UPCOMING_SERVICE_STATUSES (Codex P2: no phantom visits)', () => {
  const statuses = aggregator.UPCOMING_SERVICE_STATUSES;

  test('is an allow-list of confidently-stateable upcoming statuses', () => {
    expect(statuses).toEqual(['pending', 'confirmed', 'en_route', 'on_site']);
  });

  test("excludes 'rescheduled' (stale date until SmartRebooker) and 'skipped' (terminal)", () => {
    // The bug: a deny-list of cancelled/completed would announce these as
    // real visits — rescheduled with the OLD date, skipped as if happening.
    expect(statuses).not.toContain('rescheduled');
    expect(statuses).not.toContain('skipped');
    expect(statuses).not.toContain('no_show');
    expect(statuses).not.toContain('cancelled');
    expect(statuses).not.toContain('completed');
  });
});

describe('ContextAggregator.deriveWindow', () => {
  test('customer-facing window = window_start + 2 HOURS, never the job block (owner directive)', () => {
    // 545/545 upcoming prod rows have window_start. window_end is the
    // internal job-duration block that drives scheduling — quoting it to a
    // customer contradicts the confirmation SMS (which says start+2h).
    expect(aggregator.deriveWindow({ window_start: '13:00:00', window_end: '14:00:00' }))
      .toBe('1:00 PM–3:00 PM');
    expect(aggregator.deriveWindow({ window_start: '08:30:00', window_end: '11:45:00' }))
      .toBe('8:30 AM–10:30 AM');
  });

  test('an explicit window_display wins when present', () => {
    expect(aggregator.deriveWindow({ window_display: '8-10am', window_start: '13:00:00', window_end: '14:00:00' }))
      .toBe('8-10am');
  });

  test('time_window is the coarse fallback, title-cased', () => {
    expect(aggregator.deriveWindow({ time_window: 'morning' })).toBe('Morning');
  });

  test('a genuinely empty window returns null — drafter shows "no arrival window set"', () => {
    expect(aggregator.deriveWindow({})).toBeNull();
    expect(aggregator.deriveWindow({ window_display: '   ', window_start: null, window_end: null, time_window: null }))
      .toBeNull();
  });

  test('a lone start time still yields the full start+2h range', () => {
    expect(aggregator.deriveWindow({ window_start: '15:00:00', window_end: null })).toBe('3:00 PM–5:00 PM');
  });
});

describe('ContextAggregator.calendarDay (v8 TODAY marker)', () => {
  test('pg DATE (Date at local midnight) → its local calendar day, never the UTC-shifted prior day', () => {
    expect(aggregator.calendarDay(new Date(2026, 6, 4))).toBe('2026-07-04');
    expect(aggregator.calendarDay(new Date(2026, 0, 1))).toBe('2026-01-01');
  });

  test('string dates pass through their date prefix', () => {
    expect(aggregator.calendarDay('2026-07-04')).toBe('2026-07-04');
    expect(aggregator.calendarDay('2026-07-04T00:00:00.000Z')).toBe('2026-07-04');
  });

  test('unparseable values return null, never a guess', () => {
    expect(aggregator.calendarDay(null)).toBeNull();
    expect(aggregator.calendarDay('')).toBeNull();
    expect(aggregator.calendarDay('soon')).toBeNull();
  });
});
