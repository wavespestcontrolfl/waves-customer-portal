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

describe('ContextAggregator.deriveWindow', () => {
  test('window_start/window_end (the populated columns) become the stated window', () => {
    // 545/545 upcoming prod rows have these times; only 1 has window_display.
    expect(aggregator.deriveWindow({ window_start: '13:00:00', window_end: '14:00:00' }))
      .toBe('1:00 PM–2:00 PM');
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

  test('a lone start time still surfaces rather than collapsing to null', () => {
    expect(aggregator.deriveWindow({ window_start: '15:00:00', window_end: null })).toBe('3:00 PM');
  });
});
