// Unit tests for the time-off bank math (services/payroll-time-off-bank.js): what a week earns,
// what the bank pays, the 120 hour cap, the day-90 rule and the payout at leaving. No database. The pay run flow is in
// payroll-time-off-bank-postgres.test.js.
const {
  CAP_HOURS, USE_AFTER_DAYS, EARLY_ILLNESS_HOURS, fullWeekHundredths, usableFromOf, settleWeek, unpaidReason, toUnits, hoursText,
} = require('../services/payroll-time-off-bank');

// Hundredths of a minute in one hour.
const H = 6000;
const hours = (n) => Math.round(n * H);
// Day 1 of the job; the bank opens for any day 90 days later.
const HIRED = '2027-01-04';
const USABLE_FROM = '2027-04-04';
const AFTER = '2027-06-01';
const BEFORE = '2027-03-01';
const week = (patch = {}) => settleWeek({
  hoursPerYear: 80, bankBefore: 0, earlyPaidBefore: 0, hireDate: HIRED, usableFrom: USABLE_FROM, entries: [], regular: hours(40), holiday: 0, ...patch,
});
const day = (workDate, n, illness = false) => ({ workDate, units: hours(n), illness });

describe('the handbook numbers', () => {
  it('keeps the cap, the wait and the early illness hours the handbook states', () => {
    expect([CAP_HOURS, USE_AFTER_DAYS, EARLY_ILLNESS_HOURS]).toEqual([120, 90, 16]);
  });

  it('earns the yearly hours / 52 for a full week, rounded to a hundredth of an hour', () => {
    expect(fullWeekHundredths(80)).toBe(154);
    expect(fullWeekHundredths(120)).toBe(231);
    expect(fullWeekHundredths('40.00')).toBe(77);
    expect(fullWeekHundredths(0)).toBe(0);
  });

  it('opens the bank 90 days after the hire date, and has no date without one', () => {
    expect(usableFromOf('2027-01-04')).toBe('2027-04-04');
    expect(usableFromOf(null)).toBeNull();
  });

  it('reads numeric(10,2) minutes without drift', () => {
    expect(toUnits('92.40')).toBe(9240);
    expect(toUnits(null)).toBe(0);
    expect(hoursText(9240)).toBe('1.54');
  });
});

describe('earning', () => {
  it('adds 1.54 hours for a full 40 hour week', () => {
    expect(week()).toEqual({ paid: 0, earlyPaid: 0, unpaid: 0, unpaidBeforeHire: 0, unpaidByRule: 0, earned: 9240, payout: 0, notPaidOut: 0, after: 9240, paidDays: [] });
  });

  it('earns a part week in proportion to its paid straight hours', () => {
    expect(week({ regular: hours(20) }).earned).toBe(77 * 60);
    expect(week({ regular: hours(34) }).earned).toBe(131 * 60);
    expect(week({ regular: 0 }).earned).toBe(0);
  });

  it('counts holiday hours and hours the bank paid, and never more than 40 in a week', () => {
    expect(week({ regular: hours(30), holiday: hours(10) }).earned).toBe(9240);
    expect(week({ regular: hours(40), holiday: hours(10) }).earned).toBe(9240);
    const used = week({ regular: hours(30), bankBefore: hours(20), entries: [day(AFTER, 10)] });
    expect(used).toMatchObject({ paid: hours(10), earlyPaid: 0, unpaid: 0, earned: 9240, after: hours(10) + 9240 });
  });

  it('does not earn on time off the bank could not pay', () => {
    const short = week({ regular: hours(30), bankBefore: hours(4), entries: [day(AFTER, 10)] });
    expect(short).toEqual({
      paid: hours(4), earlyPaid: 0, unpaid: hours(6), unpaidBeforeHire: 0, unpaidByRule: 0, earned: 131 * 60, payout: 0, notPaidOut: 0, after: 131 * 60,
      paidDays: [{ workDate: AFTER, units: hours(4) }],
    });
  });

  it('pauses at 120 hours, and earns again after hours are used', () => {
    expect(week({ bankBefore: hours(119.5) })).toMatchObject({ earned: hours(0.5), after: hours(120) });
    expect(week({ bankBefore: hours(120) })).toMatchObject({ earned: 0, after: hours(120) });
    const used = week({ regular: hours(30), bankBefore: hours(120), entries: [day(AFTER, 10)] });
    expect(used).toMatchObject({ paid: hours(10), earned: 9240, after: hours(110) + 9240 });
  });
});

describe('paying time off from the bank', () => {
  it('pays nothing at zero: the day is unpaid', () => {
    expect(week({ regular: hours(30), entries: [day(AFTER, 10)] })).toMatchObject({ paid: 0, unpaid: hours(10) });
  });

  it('pays the days in date order until the bank is empty', () => {
    const result = week({
      regular: hours(20), bankBefore: hours(12),
      entries: [day('2027-06-03', 10), day('2027-06-01', 10)],
    });
    expect(result).toMatchObject({ paid: hours(12), unpaid: hours(8) });
  });

  it('keeps what it paid on each day: the first day in full, the next in part, a later day not at all', () => {
    const result = week({
      regular: 0, bankBefore: hours(12),
      entries: [day('2027-06-03', 8), day('2027-06-01', 8), day('2027-06-04', 8)],
    });
    expect(result.paidDays).toEqual([{ workDate: '2027-06-01', units: hours(8) }, { workDate: '2027-06-03', units: hours(4) }]);
    // Up to day 90 a day that is not an illness day is not paid, and a later illness day is.
    const early = week({ bankBefore: hours(12), entries: [day('2027-03-01', 8), day('2027-03-02', 8, true)] });
    expect(early.paidDays).toEqual([{ workDate: '2027-03-02', units: hours(8) }]);
  });

  it('pays nothing from a bank below zero, and the week still earns', () => {
    const result = week({ bankBefore: -hours(5), entries: [day(AFTER, 2)] });
    expect(result).toMatchObject({ paid: 0, unpaid: hours(2), unpaidByRule: 0, earned: 9240, after: -hours(5) + 9240 });
  });
});

describe('up to day 90', () => {
  it('pays no day that is not marked illness: the rule refuses it, not the bank', () => {
    expect(week({ bankBefore: hours(12), entries: [day(BEFORE, 10)] }))
      .toMatchObject({ paid: 0, earlyPaid: 0, unpaid: hours(10), unpaidByRule: hours(10) });
  });

  it('pays an illness day from the hours the bank holds', () => {
    expect(week({ bankBefore: hours(12), entries: [day(BEFORE, 10, true)] }))
      .toMatchObject({ paid: hours(10), earlyPaid: hours(10), unpaid: 0, unpaidByRule: 0 });
    // The bank is short: that is not the rule's doing.
    expect(week({ bankBefore: hours(3), entries: [day(BEFORE, 10, true)] }))
      .toMatchObject({ paid: hours(3), earlyPaid: hours(3), unpaid: hours(7), unpaidByRule: 0 });
  });

  it('pays at most 16 illness hours in all, counting the early illness hours of earlier checks', () => {
    const two = week({ bankBefore: hours(30), entries: [day('2027-03-01', 10, true), day('2027-03-02', 10, true)] });
    expect(two).toMatchObject({ paid: hours(16), earlyPaid: hours(16), unpaid: hours(4), unpaidByRule: hours(4) });
    const later = week({ bankBefore: hours(30), earlyPaidBefore: hours(10), entries: [day(BEFORE, 10, true)] });
    expect(later).toMatchObject({ paid: hours(6), earlyPaid: hours(6), unpaid: hours(4), unpaidByRule: hours(4) });
    const spent = week({ bankBefore: hours(30), earlyPaidBefore: hours(16), entries: [day(BEFORE, 10, true)] });
    expect(spent).toMatchObject({ paid: 0, unpaid: hours(10), unpaidByRule: hours(10) });
  });

  it('splits an unpaid day between the 16 hour limit and a short bank', () => {
    // 6 of the 16 hours are left and the bank holds 2: the rule refuses 4, the bank is short by 4.
    const both = week({ bankBefore: hours(2), earlyPaidBefore: hours(10), entries: [day(BEFORE, 10, true)] });
    expect(both).toMatchObject({ paid: hours(2), earlyPaid: hours(2), unpaid: hours(8), unpaidByRule: hours(4) });
  });

  it('counts only the early part of a week that crosses the first open date', () => {
    const crossing = week({ bankBefore: hours(30), entries: [day('2027-04-02', 10, true), day('2027-04-05', 10)] });
    expect(crossing).toMatchObject({ paid: hours(20), earlyPaid: hours(10), unpaid: 0 });
  });

  it('pays no day before the hire date, an illness day included, and such a day uses none of the 16 hours', () => {
    const before = week({ bankBefore: hours(30), entries: [day('2027-01-03', 8, true), day('2027-01-02', 4)] });
    expect(before).toMatchObject({ paid: 0, earlyPaid: 0, unpaid: hours(12), unpaidBeforeHire: hours(12), unpaidByRule: 0 });
    // The hire date is day 1 of the job: an illness day on it is paid, and the day before it is not.
    const dayOne = week({ bankBefore: hours(30), entries: [day('2027-01-03', 8, true), day(HIRED, 8, true), day('2027-01-05', 8, true)] });
    expect(dayOne).toMatchObject({ paid: hours(16), earlyPaid: hours(16), unpaid: hours(8), unpaidBeforeHire: hours(8), unpaidByRule: 0 });
  });

  it('pays any day in full from the first open date, with no 16 hour limit', () => {
    const open = week({ bankBefore: hours(30), earlyPaidBefore: hours(16), entries: [day(USABLE_FROM, 10), day('2027-04-05', 10, true)] });
    expect(open).toMatchObject({ paid: hours(20), earlyPaid: 0, unpaid: 0, unpaidByRule: 0 });
    const lastEarly = week({ bankBefore: hours(30), entries: [day('2027-04-03', 10)] });
    expect(lastEarly).toMatchObject({ paid: 0, unpaid: hours(10) });
  });
});

describe('paying out the bank when the technician leaves', () => {
  it('pays out every hour the bank holds after the week, the hours that week earned included, and leaves zero', () => {
    expect(week({ bankBefore: hours(10), payOut: true })).toMatchObject({ paid: 0, earned: 9240, payout: hours(10) + 9240, after: 0 });
    // At the cap the week earns nothing, and the payout is the 120 hours.
    expect(week({ bankBefore: hours(120), payOut: true })).toMatchObject({ earned: 0, payout: hours(120), after: 0 });
  });

  it('earns nothing on the paid-out hours: the week earns what it earns without a payout', () => {
    const without = week({ regular: hours(20), bankBefore: hours(50) });
    const withPayout = week({ regular: hours(20), bankBefore: hours(50), payOut: true });
    expect([without.earned, withPayout.earned]).toEqual([77 * 60, 77 * 60]);
    expect(withPayout.payout).toBe(hours(50) + 77 * 60);
  });

  it('pays the time off of the week first, and pays out what is left', () => {
    const used = week({ regular: hours(30), bankBefore: hours(20), entries: [day(AFTER, 10)], payOut: true });
    expect(used).toMatchObject({ paid: hours(10), unpaid: 0, earned: 9240, payout: hours(10) + 9240, after: 0 });
    expect(used.paidDays).toEqual([{ workDate: AFTER, units: hours(10) }]);
  });

  it('pays out nothing from a bank that is still below zero after the week, and leaves it there', () => {
    expect(week({ bankBefore: -hours(5), payOut: true })).toMatchObject({ earned: 9240, payout: 0, after: -hours(5) + 9240 });
    // The week's earned hours bring a small debt above zero: only that part is paid out.
    expect(week({ bankBefore: -hours(1), payOut: true })).toMatchObject({ earned: 9240, payout: 9240 - hours(1), after: 0 });
  });

  it('pays out nothing without the instruction', () => {
    expect(week({ bankBefore: hours(10) })).toMatchObject({ payout: 0, after: hours(10) + 9240 });
  });

  // A catch-up check: a week before a payout, paid after it.
  const caught = { hoursPerYear: 80 };

  it('pays the wages only on a catch-up check: nothing earned into the bank, nothing paid out, the hours shown', () => {
    // The technician has left and the bank was paid out: the week would have earned 1.54 hours. They are shown.
    expect(week({ catchUp: caught })).toMatchObject({ paid: 0, earned: 0, payout: 0, notPaidOut: 9240, after: 0 });
    // A day off of that week is not paid again: the payout already paid every hour the bank held.
    expect(week({ regular: hours(20), entries: [day(AFTER, 10)], catchUp: caught }))
      .toMatchObject({ paid: 0, unpaid: hours(10), earned: 0, payout: 0, notPaidOut: 77 * 60, after: 0 });
    // The technician came back since, and the bank holds hours of the new stay: they stay in the bank, and they
    // pay no time off of the week before the payout.
    expect(week({ regular: hours(30), bankBefore: hours(20), entries: [day(AFTER, 10)], catchUp: caught }))
      .toMatchObject({ paid: 0, unpaid: hours(10), earned: 0, payout: 0, notPaidOut: 116 * 60, after: hours(20) });
    // A bank below zero stays as it was.
    expect(week({ bankBefore: -hours(5), catchUp: caught })).toMatchObject({ earned: 0, payout: 0, after: -hours(5) });
  });

  it('shows no hours on a check that is not a catch-up check', () => {
    expect(week({})).toMatchObject({ notPaidOut: 0 });
    expect(week({ bankBefore: hours(10), payOut: true })).toMatchObject({ notPaidOut: 0 });
  });

  it('pays the whole bank out when the week is the payout week', () => {
    expect(week({ bankBefore: hours(10), payOut: true })).toMatchObject({ payout: hours(10) + 9240, after: 0 });
  });
});

describe('the reason time off was not paid', () => {
  it('names a short bank, the day-90 rule, or both with the hours of each', () => {
    expect(unpaidReason(hours(2.31), 0)).toBe('2.31 hours of time off are not paid, because the time-off bank does not hold them.');
    expect(unpaidReason(hours(10), hours(10)))
      .toBe('10.00 hours of time off are not paid, because up to day 90 the time-off bank pays only illness days, up to 16 hours.');
    expect(unpaidReason(hours(8), hours(4))).toBe(
      '8.00 hours of time off are not paid: 4.00 because up to day 90 the time-off bank pays only illness days, up to 16 hours, '
      + 'and 4.00 because the time-off bank does not hold them.',
    );
    expect(unpaidReason(hours(8), 0, hours(8))).toBe('8.00 hours of time off are not paid, because the time off is before the hire date.');
    // On a catch-up check the bank is short because a payout emptied it.
    expect(unpaidReason(hours(1), 0, 0, true))
      .toBe('1.00 hours of time off are not paid, because the time-off bank was paid out before this paycheck, with every hour it held.');
    expect(unpaidReason(hours(10), hours(10), 0, true))
      .toBe('10.00 hours of time off are not paid, because up to day 90 the time-off bank pays only illness days, up to 16 hours.');
    expect(unpaidReason(hours(12), hours(4), hours(4))).toBe(
      '12.00 hours of time off are not paid: 4.00 because the time off is before the hire date, '
      + '4.00 because up to day 90 the time-off bank pays only illness days, up to 16 hours, and 4.00 because the time-off bank does not hold them.',
    );
  });
});
