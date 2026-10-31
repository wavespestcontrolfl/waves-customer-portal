// Lawn watering, late close (owner ruling 2026-10-27): a lawn visit closed on a later ET day than it was worked
// gets no watering steps, text or alert. Synthetic visits; times are ET unless named Z.
const { lawnVisitClosedLate, LATE_CLOSE_MIN_HOURS } = require('../services/service-report/lawn-watering-late-close');
const { lateCloseInstruction } = require('../services/service-report/lawn-watering-instruction');
const { buildReportWateringInstruction } = require('../services/service-report/report-data');

const late = (arrivals, scheduledDates, completedAt) => lawnVisitClosedLate({ arrivals, scheduledDates, completedAt });

describe('lawnVisitClosedLate', () => {
  test('a same-day visit is not late', () => {
    // Arrived 11:50 AM, closed 12:50 PM, Oct 26.
    expect(late(['2026-10-26T15:50:00Z'], ['2026-10-26'], '2026-10-26T16:50:59Z')).toBe(false);
  });

  test('a visit worked Oct 1 and closed Oct 26 by a close-out job is late', () => {
    expect(late(['2026-10-01T17:39:00Z'], ['2026-10-01'], '2026-10-26T13:38:00Z')).toBe(true);
  });

  test('a visit closed the next morning is late; one that ran past midnight is not', () => {
    // Arrived 4 PM Oct 25, closed 8 AM Oct 26: 16 hours, a day later.
    expect(late(['2026-10-25T20:00:00Z'], ['2026-10-25'], '2026-10-26T12:00:00Z')).toBe(true);
    // Arrived 11:40 PM Oct 25, closed 12:10 AM Oct 26: 30 minutes.
    expect(late(['2026-10-26T03:40:00Z'], ['2026-10-25'], '2026-10-26T04:10:00Z')).toBe(false);
    expect(LATE_CLOSE_MIN_HOURS).toBe(12);
  });

  test('a check-in from an earlier, aborted attempt before a reschedule is not a late close', () => {
    // The visit moved to Oct 26; the Oct 1 stamp predates its scheduled day, so the report drops it.
    expect(late(['2026-10-01T17:39:00Z'], ['2026-10-26'], '2026-10-26T16:50:00Z')).toBe(false);
    // With a real arrival the same day after the stale one, that arrival counts.
    expect(late(['2026-10-01T17:39:00Z', '2026-10-26T15:50:00Z'], ['2026-10-26'], '2026-10-26T16:50:00Z')).toBe(false);
  });

  test('no arrival stamp: the scheduled day decides', () => {
    expect(late([], ['2026-10-20'], '2026-10-26T14:00:00Z')).toBe(true);
    expect(late([null, ''], ['2026-10-26'], '2026-10-26T14:00:00Z')).toBe(false);
  });

  test('no scheduled day: the raw arrival decides, even one the 18-hour rule drops', () => {
    expect(late(['2026-10-23T14:00:00Z'], [], '2026-10-26T14:00:00Z')).toBe(true);
    expect(late(['2026-10-26T12:00:00Z'], [null], '2026-10-26T14:00:00Z')).toBe(false);
  });

  test('an early close-out of a future visit is not late', () => {
    expect(late(['2026-10-26T13:00:00Z'], ['2026-11-02'], '2026-10-26T15:00:00Z')).toBe(false);
    expect(late([], ['2026-11-02'], '2026-10-26T15:00:00Z')).toBe(false);
  });

  test('database shapes: Date stamps and a DATE column read as a Date', () => {
    expect(late([new Date('2026-10-03T19:44:00Z')], [new Date('2026-10-03T00:00:00Z')], new Date('2026-10-26T14:39:57Z'))).toBe(true);
    expect(late([new Date('2026-10-26T13:40:00Z')], [new Date('2026-10-26T00:00:00Z')], new Date('2026-10-26T14:39:57Z'))).toBe(false);
  });

  test('across the Nov 1 clock change: a day later and 25 hours is late; 2 hours past midnight is not', () => {
    // Sat Oct 31 9:00 AM EDT to Sun Nov 1 9:00 AM EST.
    expect(late(['2026-10-31T13:00:00Z'], ['2026-10-31'], '2026-11-01T14:00:00Z')).toBe(true);
    // Sat Oct 31 11:30 PM EDT to Sun Nov 1 12:30 AM EDT.
    expect(late(['2026-11-01T03:30:00Z'], ['2026-10-31'], '2026-11-01T05:30:00Z')).toBe(false);
  });

  test('no completion time, or nothing to judge by: never late', () => {
    expect(late(['2026-10-01T17:39:00Z'], ['2026-10-01'], null)).toBe(false);
    expect(late(['not a date'], [], 'garbage')).toBe(false);
    expect(lawnVisitClosedLate()).toBe(false);
    expect(late([], [], '2026-10-26T14:00:00Z')).toBe(false);
  });
});

describe('lateCloseInstruction', () => {
  test('the empty, state-null shape of every no claim, with its reason kept off the payload', () => {
    const instruction = lateCloseInstruction();
    expect(instruction).toMatchObject({ state: null, lines: [], expiresAt: null, completedAt: null, mowHold: null });
    expect(instruction.noClaim).toEqual({ reason: 'late_close', products: [] });
    expect(JSON.stringify(instruction)).not.toContain('late_close');
    expect(lateCloseInstruction()).not.toBe(instruction);
  });
});

describe('buildReportWateringInstruction with a late close', () => {
  test('no steps and no reads (no sprinkler settings, no catalog targets)', async () => {
    const knex = jest.fn(() => { throw new Error('must not read'); });
    const instruction = await buildReportWateringInstruction({
      products: [{ product_id: 'p1', product_name: 'LESCO Dimension 18-0-10', approved_report_product_facts: { wateringRule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } } }],
      service: { customer_id: 'c1' },
      completionTime: '2026-10-26T14:39:57Z',
      lawnAssessment: { waterContext: {} },
      knex,
      forCompletion: true,
      lateClose: true,
    });
    expect(instruction).toMatchObject({ state: null, lines: [] });
    expect(instruction.noClaim.reason).toBe('late_close');
    expect(knex).not.toHaveBeenCalled();
  });
});
