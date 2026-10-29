/**
 * Annual prepay coverage for a lawn 9x rounds series (GATE_LAWN_9X_ROUNDS, owner
 * 2026-10-28). A term that covers a lawn_rounds_9 series stores coverage_cadence
 * 'lawn_rounds_9', and its covered visits are placed on the round calendar:
 * lawnRoundDate(anchor, i) for i = 0..count-1, the same dates the series is
 * seeded with, so attach-by-date matches the seeded rows and no duplicate
 * visit is ever seeded. Every other cadence keeps its dates byte for byte.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipRenewalReminder: jest.fn() }));

const { _private } = require('../services/annual-prepay-renewals');
const { lawnRoundDate, lawnRoundDateFrom, roundOf } = require('../services/lawn-rounds');
const { etParts, parseETDateTime } = require('../utils/datetime-et');

const {
  coverageScheduleDates, coverageCadenceSchedule, inferCoverageCadence, normalizeCoverageCadence,
} = _private;

const ymd = (d) => d.toISOString().slice(0, 10);
const weekday = (dateStr) => etParts(parseETDateTime(`${dateStr}T12:00`)).dayOfWeek;

// Every Mon-Fri date in program years 2027-2029, every 4th day (a spread over
// every round and weekday).
function anchors() {
  const out = [];
  const start = Date.UTC(2027, 0, 1, 12);
  const end = Date.UTC(2029, 11, 31, 12);
  for (let t = start; t <= end; t += 4 * 86400000) {
    const d = ymd(new Date(t));
    const wd = weekday(d);
    if (wd >= 1 && wd <= 5) out.push(d);
  }
  return out;
}

describe('coverageCadenceSchedule / normalizeCoverageCadence — lawn_rounds_9', () => {
  test('the exact token is a rounds schedule; nothing else is aliased to it', () => {
    expect(normalizeCoverageCadence('lawn_rounds_9')).toBe('lawn_rounds_9');
    expect(coverageCadenceSchedule('lawn_rounds_9')).toEqual({ unit: 'rounds', value: 1, cadence: 'lawn_rounds_9' });
    for (const other of ['lawn', 'lawn_rounds', 'rounds', 'lawn_rounds_10', 'every_9_rounds', 'nine_rounds']) {
      expect(normalizeCoverageCadence(other)).toBeNull();
    }
  });

  test('other cadences keep their schedules', () => {
    expect(coverageCadenceSchedule('every_6_weeks')).toEqual({ unit: 'days', value: 42, cadence: 'every_6_weeks' });
    expect(coverageCadenceSchedule('monthly')).toEqual({ unit: 'months', value: 1, cadence: 'monthly' });
    expect(coverageCadenceSchedule('quarterly')).toEqual({ unit: 'months', value: 3, cadence: 'quarterly' });
    expect(coverageCadenceSchedule('seasonal_feb_oct')).toBeNull();
  });
});

describe('inferCoverageCadence', () => {
  test('nine visits stay every_6_weeks unless the term says rounds', () => {
    expect(inferCoverageCadence({ coverage_visit_count: 9 })).toBe('every_6_weeks');
    expect(inferCoverageCadence({ coverage_visit_count: 9, coverage_service_type: 'Lawn Care' })).toBe('every_6_weeks');
    expect(inferCoverageCadence({ coverage_visit_count: 9, coverage_cadence: 'lawn_rounds_9' })).toBe('lawn_rounds_9');
    expect(inferCoverageCadence({ coverage_visit_count: 9, coverage_cadence: 'every_6_weeks' })).toBe('every_6_weeks');
  });
});

describe('coverageScheduleDates — lawn_rounds_9', () => {
  const all = anchors();

  test('covers every round of the 2027-2029 program years on the anchor weekday', () => {
    expect(all.length).toBeGreaterThan(150);
    for (const anchor of all) {
      const dates = coverageScheduleDates(anchor, 9, 'lawn_rounds_9');
      expect(dates).toHaveLength(9);
      expect(dates).toEqual(Array.from({ length: 9 }, (_, i) => lawnRoundDate(anchor, i)));
      expect(dates[0]).toBe(anchor);
      // One visit in each of nine consecutive rounds, all on the anchor's weekday.
      const rounds = dates.map((d) => roundOf(d));
      for (let i = 1; i < 9; i++) {
        const prev = rounds[i - 1];
        const expectedRound = (prev.round % 9) + 1;
        expect(rounds[i].round).toBe(expectedRound);
        expect(weekday(dates[i])).toBe(weekday(anchor));
      }
    }
  });

  test('truncates at term_end exactly as every other cadence does', () => {
    const anchor = '2027-06-15';
    const full = coverageScheduleDates(anchor, 9, 'lawn_rounds_9');
    for (let cut = 1; cut < 9; cut++) {
      expect(coverageScheduleDates(anchor, 9, 'lawn_rounds_9', full[cut])).toEqual(full.slice(0, cut + 1));
      const dayBefore = ymd(new Date(Date.parse(`${full[cut]}T12:00:00Z`) - 86400000));
      expect(coverageScheduleDates(anchor, 9, 'lawn_rounds_9', dayBefore)).toEqual(full.slice(0, cut));
    }
  });

  test('a promised first visit and the paid-day floor anchor the series like any other cadence', () => {
    // The promise (a Thursday) is the anchor; the series follows it.
    const promised = coverageScheduleDates('2027-03-01', 9, 'lawn_rounds_9', null, { firstVisitDate: '2027-03-25' });
    expect(promised).toEqual(Array.from({ length: 9 }, (_, i) => lawnRoundDate('2027-03-25', i)));
    // A floor later than the term start moves the anchor forward.
    const floored = coverageScheduleDates('2027-03-01', 9, 'lawn_rounds_9', null, { notBefore: '2027-03-10' });
    expect(floored).toEqual(Array.from({ length: 9 }, (_, i) => lawnRoundDate('2027-03-10', i)));
  });

  test('a stored series round anchor places the dates from that anchor (lawnRoundDateFrom)', () => {
    const roundAnchor = '2027-01-12'; // a Tuesday near the start of round 1
    const base = '2027-08-10';
    const dates = coverageScheduleDates(base, 4, 'lawn_rounds_9', null, { roundAnchor });
    expect(dates).toEqual(Array.from({ length: 4 }, (_, i) => lawnRoundDateFrom(roundAnchor, base, i)));
    expect(dates[0]).toBe(base);
    // Without it, the plain anchor walk.
    expect(coverageScheduleDates(base, 4, 'lawn_rounds_9')).toEqual(Array.from({ length: 4 }, (_, i) => lawnRoundDate(base, i)));
  });

  test('a roundAnchor option is ignored by every other cadence', () => {
    for (const cadence of ['every_6_weeks', 'monthly', 'quarterly']) {
      expect(coverageScheduleDates('2027-03-02', 4, cadence, null, { roundAnchor: '2027-01-12' }))
        .toEqual(coverageScheduleDates('2027-03-02', 4, cadence));
    }
  });

  test('every_6_weeks, monthly, quarterly and semiannual dates are unchanged', () => {
    expect(coverageScheduleDates('2026-06-16', 9, 'every_6_weeks')).toEqual([
      '2026-06-16', '2026-07-28', '2026-09-08', '2026-10-20', '2026-12-01', '2027-01-12', '2027-02-23', '2027-04-06', '2027-05-18',
    ]);
    expect(coverageScheduleDates('2026-06-15', 4, 'quarterly')).toEqual(['2026-06-15', '2026-09-15', '2026-12-15', '2027-03-15']);
    expect(coverageScheduleDates('2026-01-31', 3, 'monthly')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(coverageScheduleDates('2026-06-15', 2, 'semiannual')).toEqual(['2026-06-15', '2026-12-15']);
    // No cadence: inferred from the count, rounds is never inferred.
    expect(coverageScheduleDates('2026-06-16', 9, null)).toEqual(coverageScheduleDates('2026-06-16', 9, 'every_6_weeks'));
  });
});
