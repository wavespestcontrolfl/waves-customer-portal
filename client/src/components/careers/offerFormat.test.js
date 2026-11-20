import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  dateRequestProblem,
  formatExpiry,
  formatLongDate,
  formatLongInstant,
  formatSentOn,
  hasOfferFacts,
  payLine,
  signedNameValid,
  tomorrowET,
} from './offerFormat';

afterEach(() => vi.useRealTimers());

describe('offerFormat', () => {
  const facts = {
    jobTitle: 'Pest Control Technician',
    startDate: '2027-01-04',
    hourlyRate: 23,
    stepRate: '25.00',
    stepEffectiveOn: '2027-04-05',
    hoursLine: '40 paid hours each full week',
    reportTo: 'Sam Carter, owner',
    payDayLine: 'Every Friday',
  };

  it('signs only an offer that carries every term it shows', () => {
    expect(hasOfferFacts(facts)).toBe(true);
    expect(hasOfferFacts({ ...facts, stepRate: null, stepEffectiveOn: null })).toBe(true);
    expect(hasOfferFacts({ ...facts, stepRate: '', stepEffectiveOn: '' })).toBe(true);
    for (const missing of [
      { jobTitle: '' }, { hoursLine: null }, { reportTo: '  ' }, { payDayLine: undefined },
      { startDate: null }, { startDate: '2027-02-30' }, { startDate: 'soon' },
      { hourlyRate: null }, { hourlyRate: '' }, { hourlyRate: 0 }, { hourlyRate: '-1' }, { hourlyRate: true },
      { hourlyRate: 'twenty' }, { stepRate: 'x' }, { stepEffectiveOn: null }, { stepEffectiveOn: '2027-13-01' },
    ]) {
      expect(hasOfferFacts({ ...facts, ...missing })).toBe(false);
    }
  });

  it('formats pay with and without a step', () => {
    expect(payLine({ hourlyRate: '23.00', stepRate: '25.00', stepEffectiveOn: '2027-04-05' })).toBe('$23.00 an hour, $25.00 from Apr 5');
    expect(payLine({ hourlyRate: 23, stepRate: null, stepEffectiveOn: null })).toBe('$23.00 an hour');
  });

  it('keeps the calendar day of date values and reads instants in Eastern time', () => {
    expect(formatLongDate('2027-01-04')).toBe('Mon, Jan 4, 2027');
    expect(formatLongDate('2027-01-04T00:00:00.000Z')).toBe('Mon, Jan 4, 2027');
    expect(formatSentOn('2026-12-11')).toBe('Dec 11, 2026');
    // 2026-12-19 03:30Z is still Fri Dec 18 in Eastern time.
    expect(formatExpiry('2026-12-19T03:30:00.000Z')).toBe('Fri, Dec 18');
    expect(formatLongDate('2026-12-13T02:00:00.000Z')).toBe('Sat, Dec 12, 2026');
    expect(formatLongInstant('2026-12-13T00:00:00.000Z')).toBe('Sat, Dec 12, 2026');
  });

  it('needs two words to sign', () => {
    expect(signedNameValid('Jordan')).toBe(false);
    expect(signedNameValid('  Jordan  ')).toBe(false);
    expect(signedNameValid('Jordan Rivera')).toBe(true);
    expect(signedNameValid(`Jordan ${'a'.repeat(130)}`)).toBe(false);
  });

  it('accepts only future Monday to Thursday dates', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-12-14T15:00:00Z')); // Mon Dec 14, 10 AM ET
    expect(tomorrowET()).toBe('2026-12-15');
    expect(dateRequestProblem('')).toBe('Pick a date.');
    expect(dateRequestProblem('2026-12-14')).toMatch(/future/);
    expect(dateRequestProblem('2026-12-19')).toMatch(/Monday to Thursday/); // Sat
    expect(dateRequestProblem('2026-12-18')).toMatch(/Monday to Thursday/); // Fri
    expect(dateRequestProblem('2026-12-17')).toBeNull(); // Thu
    expect(dateRequestProblem('2026-12-21')).toBeNull(); // Mon
    // Not a calendar date: Feb 30 would roll over to Mar 2 (a Tuesday) in a hand-made Date.
    expect(dateRequestProblem('2027-02-30')).toBe('Pick a date.');
    // 11:30 PM ET on Dec 14 is Dec 15 in UTC: tomorrow is still the Eastern Dec 15.
    expect(tomorrowET(new Date('2026-12-15T04:30:00Z'))).toBe('2026-12-15');
  });
});
