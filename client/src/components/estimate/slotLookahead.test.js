import { describe, expect, it } from 'vitest';
import { noTimeSoon } from './slotLookahead';

// 2099-10-01 12:00Z is 08:00 ET, so the horizon is 2099-10-08 (today + 7, inclusive).
const NOW = new Date('2099-10-01T12:00:00Z');
const at = (date) => ({ slotId: date, date });
const body = (extra = {}) => ({ primary: [], expander: [], metadata: {}, ...extra });

describe('noTimeSoon (estimate page text-or-call line)', () => {
  it('is true when every slot is after day 7 and no earlier open day is named', () => {
    expect(noTimeSoon(body({ metadata: { firstDayAvailability: { date: '2099-10-12' } } }), [at('2099-10-12')], NOW)).toBe(true);
  });

  it('counts day 7 itself as soon, day 8 as not', () => {
    expect(noTimeSoon(body(), [at('2099-10-08')], NOW)).toBe(false);
    expect(noTimeSoon(body(), [at('2099-10-09')], NOW)).toBe(true);
  });

  it('is false when firstDayAvailability names an open day inside 7 days', () => {
    expect(noTimeSoon(body({ metadata: { firstDayAvailability: { date: '2099-10-03' } } }), [at('2099-10-12')], NOW)).toBe(false);
  });

  it('a first day of today hides the line even with no today slot on screen: the capped list cannot prove days 2-7 empty', () => {
    expect(noTimeSoon(body({ metadata: { firstDayAvailability: { date: '2099-10-01' } } }), [at('2099-10-12')], NOW)).toBe(false);
  });

  it('is false with nothing on screen', () => {
    expect(noTimeSoon(body(), [], NOW)).toBe(false);
  });

  it.each(['reviewBeforeBooking', 'commercialManualScheduling', 'invoiceOnlyAcceptance'])('is false for a %s answer', (flag) => {
    expect(noTimeSoon(body({ [flag]: true }), [at('2099-10-12')], NOW)).toBe(false);
  });

  it('is false without an answer', () => {
    expect(noTimeSoon(null, [at('2099-10-12')], NOW)).toBe(false);
  });

  it('reads the horizon in ET: 11 pm ET on Oct 1 (03:00Z Oct 2) still has day 7 = Oct 8', () => {
    expect(noTimeSoon(body(), [at('2099-10-08')], new Date('2099-10-02T03:00:00Z'))).toBe(false);
    expect(noTimeSoon(body(), [at('2099-10-09')], new Date('2099-10-02T03:00:00Z'))).toBe(true);
  });
});
