/**
 * Deadline math for a technician's ID card and training (GATE_TECH_TRAINING_DATES, F.S. 482.091, rule 5E-14.1421).
 * Pure functions: the observable results are the dates and the done / due / due_soon / overdue statuses the Licenses
 * tab shows and the daily reminder sweep keys on. Regression guarded: Date day math on a date-only string, and month-end
 * overflow (Aug 31 + 6 months must be Feb 28, not Mar 3).
 */
const dates = require('../services/technician-training-dates');

describe('addDays and daysBetween', () => {
  test('30 days after hire crosses a month and a year without a Date parse of the date text', () => {
    expect(dates.addDays('2026-10-15', 30)).toBe('2026-11-14');
    expect(dates.addDays('2026-12-20', 30)).toBe('2027-01-19');
    expect(dates.addDays('2028-01-31', 30)).toBe('2028-03-01');
  });

  test('daysBetween is whole calendar days and signed', () => {
    expect(dates.daysBetween('2026-11-01', '2026-11-15')).toBe(14);
    expect(dates.daysBetween('2026-11-15', '2026-11-01')).toBe(-14);
    expect(dates.daysBetween('2026-03-07', '2026-03-09')).toBe(2); // across the spring-forward night
    expect(dates.daysBetween(null, '2026-11-01')).toBeNull();
  });
});

describe('statusOf at the 14-day edge', () => {
  const today = '2026-11-01';
  test.each([
    ['15 days left', '2026-11-16', 'due'],
    ['14 days left', '2026-11-15', 'due_soon'],
    ['due today', '2026-11-01', 'due_soon'],
    ['1 day past', '2026-10-31', 'overdue'],
  ])('%s', (_label, dueOn, expected) => {
    expect(dates.statusOf({ dueOn, doneOn: null, today })).toBe(expected);
  });

  test('a done date wins over every other state, and no due date means no status', () => {
    expect(dates.statusOf({ dueOn: '2026-01-01', doneOn: '2026-12-31', today })).toBe('done');
    expect(dates.statusOf({ dueOn: null, doneOn: null, today })).toBeNull();
  });
});

describe('idCardDeadline', () => {
  test('is due 30 days after hire; an application or an issued card closes it', () => {
    const open = dates.idCardDeadline({ hireDate: '2026-10-15', appliedOn: null, issuedOn: null, today: '2026-11-03' });
    expect(open).toEqual({ appliedOn: null, applicationDueOn: '2026-11-14', issuedOn: null, status: 'due_soon' });
    expect(dates.idCardDeadline({ hireDate: '2026-10-15', appliedOn: '2026-10-30', issuedOn: null, today: '2026-12-31' }).status).toBe('done');
    expect(dates.idCardDeadline({ hireDate: '2026-10-15', appliedOn: null, issuedOn: '2026-11-20', today: '2026-12-31' }).status).toBe('done');
    expect(dates.idCardDeadline({ hireDate: '2026-10-15', appliedOn: null, issuedOn: null, today: '2026-11-15' }).status).toBe('overdue');
  });

  test('reads a Date value the way pg hands back a DATE column (UTC midnight)', () => {
    const result = dates.idCardDeadline({ hireDate: new Date('2026-10-15T00:00:00Z'), appliedOn: null, issuedOn: null, today: '2026-10-16' });
    expect(result.applicationDueOn).toBe('2026-11-14');
  });
});

describe('classroomDeadline', () => {
  test('is due 6 months after the issue date, clamped at month end', () => {
    expect(dates.classroomDeadline({ issuedOn: '2026-08-31', doneOn: null, today: '2026-09-01' }).dueOn).toBe('2027-02-28');
    expect(dates.classroomDeadline({ issuedOn: '2027-08-31', doneOn: null, today: '2027-09-01' }).dueOn).toBe('2028-02-29');
    expect(dates.classroomDeadline({ issuedOn: '2026-10-15', doneOn: null, today: '2026-10-16' })).toEqual({ dueOn: '2027-04-15', doneOn: null, status: 'due' });
  });

  test('has no due date until the card is issued, and done still reads done', () => {
    expect(dates.classroomDeadline({ issuedOn: null, doneOn: null, today: '2026-10-16' })).toEqual({ dueOn: null, doneOn: null, status: null });
    expect(dates.classroomDeadline({ issuedOn: '2026-10-15', doneOn: '2026-11-02', today: '2028-01-01' }).status).toBe('done');
  });

  test('flags the 14-day window and overdue', () => {
    expect(dates.classroomDeadline({ issuedOn: '2026-10-15', doneOn: null, today: '2027-04-01' }).status).toBe('due_soon');
    expect(dates.classroomDeadline({ issuedOn: '2026-10-15', doneOn: null, today: '2027-04-16' }).status).toBe('overdue');
  });
});

describe('renewalTrainingDeadline', () => {
  test('counts only a date inside the current renewal year', () => {
    const base = { licenseExpiry: '2027-06-30', today: '2027-06-01' };
    expect(dates.renewalTrainingDeadline({ ...base, doneOn: '2027-02-10' })).toEqual({ dueBy: '2027-06-30', doneOn: '2027-02-10', status: 'done' });
    // Done last year (before the previous renewal): the new year starts open again.
    expect(dates.renewalTrainingDeadline({ ...base, doneOn: '2026-05-01' }).status).toBe('due');
    expect(dates.renewalTrainingDeadline({ ...base, doneOn: null }).status).toBe('due');
  });

  test('has no status without an expiry date', () => {
    expect(dates.renewalTrainingDeadline({ licenseExpiry: null, doneOn: null, today: '2027-06-01' }).status).toBeNull();
  });
});

describe('trainingSummary', () => {
  const row = (training_date, category, hours = 8) => ({ training_date, category, hours });

  test('counts distinct dates, sums hours, and needs 5 dates in ONE category for the 5-day check', () => {
    const mixed = [row('2026-10-01', 'GHP'), row('2026-10-02', 'GHP'), row('2026-10-03', 'L&O'), row('2026-10-04', 'L&O'), row('2026-10-05', 'Termite/WDO')];
    expect(dates.trainingSummary(mixed)).toEqual({ days: 5, hours: 40, categories: ['GHP', 'L&O', 'Termite/WDO'], fiveDaysDone: false, fortyHoursDone: true });
    const five = ['01', '02', '03', '04', '05'].map((d) => row(`2026-10-${d}`, 'GHP', '6.50'));
    expect(dates.trainingSummary(five)).toMatchObject({ days: 5, hours: 32.5, fiveDaysDone: true, fortyHoursDone: false });
  });

  test('two categories on one date are one day, and an empty log is all zeros', () => {
    const summary = dates.trainingSummary([row('2026-10-01', 'GHP', 4), row('2026-10-01', 'L&O', 4)]);
    expect(summary).toMatchObject({ days: 1, hours: 8, fiveDaysDone: false });
    expect(dates.trainingSummary([])).toEqual({ days: 0, hours: 0, categories: [], fiveDaysDone: false, fortyHoursDone: false });
  });
});
