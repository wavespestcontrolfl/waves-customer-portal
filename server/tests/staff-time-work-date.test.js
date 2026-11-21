const fs = require('fs');
const path = require('path');

const {
  STAFF_TIME_ZONE,
  STAFF_WORK_DATE_SQL,
  addStaffWorkDays,
  staffWeekRange,
  staffWeekStartForWorkDate,
  staffWorkDate,
  staffWorkDateSql,
} = require('../utils/staff-time-work-date');

describe('Staff payroll work-date semantics', () => {
  test('matches the rollout audit PostgreSQL expression exactly', () => {
    expect(STAFF_TIME_ZONE).toBe('America/New_York');
    expect(STAFF_WORK_DATE_SQL).toBe(
      "(clock_in::timestamptz AT TIME ZONE 'America/New_York')::date",
    );
    expect(staffWorkDateSql('time_entries.clock_in')).toBe(
      "(time_entries.clock_in::timestamptz AT TIME ZONE 'America/New_York')::date",
    );
    expect(() => staffWorkDateSql('clock_in); DROP TABLE time_entries')).toThrow(
      /Invalid Staff time column/,
    );
  });

  test('assigns post-8 PM Eastern instants to the ET date, not the next UTC date', () => {
    expect(staffWorkDate(new Date('2026-07-14T00:30:00.000Z'))).toBe('2026-07-13');
    expect(staffWorkDate(new Date('2026-01-02T02:00:00.000Z'))).toBe('2026-01-01');
  });

  test('stays correct across both DST boundaries', () => {
    // 11:30 PM EST before the spring-forward boundary, then 3:30 AM EDT.
    expect(staffWorkDate(new Date('2026-03-08T04:30:00.000Z'))).toBe('2026-03-07');
    expect(staffWorkDate(new Date('2026-03-08T07:30:00.000Z'))).toBe('2026-03-08');

    // Both occurrences of 1:30 AM on the fall-back day belong to Nov 1.
    expect(staffWorkDate(new Date('2026-11-01T05:30:00.000Z'))).toBe('2026-11-01');
    expect(staffWorkDate(new Date('2026-11-01T06:30:00.000Z'))).toBe('2026-11-01');
  });

  test('builds ET calendar weeks across DST without UTC date arithmetic', () => {
    expect(staffWeekRange('2026-03-02')).toEqual({
      start: '2026-03-02',
      end: '2026-03-08',
    });
    expect(staffWeekRange('2026-10-26')).toEqual({
      start: '2026-10-26',
      end: '2026-11-01',
    });
    expect(staffWeekStartForWorkDate('2026-03-08')).toBe('2026-03-02');
    expect(staffWeekStartForWorkDate('2026-11-01')).toBe('2026-10-26');
  });

  test('a kept answer is the same as the first one, and both match the plain calendar, across DST and the year end', () => {
    // the plain calendar answer, worked out with no time zone at all
    const plain = (date, days) => {
      const [year, month, day] = date.split('-').map(Number);
      return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
    };
    const monday = (date) => plain(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
    // the weeks around the spring-forward day (Mar 8), the fall-back day (Nov 1) and the year end
    const dates = [];
    for (const [from, to] of [['2026-03-02', '2026-03-15'], ['2026-10-26', '2026-11-08'], ['2026-12-25', '2027-01-07']]) {
      for (let date = from; date <= to; date = plain(date, 1)) dates.push(date);
    }
    for (const pass of [1, 2]) { // the second pass reads the kept answers
      for (const date of dates) {
        expect([pass, date, staffWeekStartForWorkDate(date)]).toEqual([pass, date, monday(date)]);
        for (const days of [-11, -1, 6, 60]) {
          expect([pass, date, days, addStaffWorkDays(date, days)]).toEqual([pass, date, days, plain(date, days)]);
        }
      }
    }
  });

  test('checks the date on every call, whether or not an answer is kept', () => {
    expect(staffWeekStartForWorkDate('2026-06-03')).toBe('2026-06-01');
    expect(addStaffWorkDays('2026-06-03', 1)).toBe('2026-06-04');
    for (const bad of ['2026-02-30', '2026-6-3', '', null, undefined, new Date('2026-06-03T12:00:00Z')]) {
      for (let pass = 0; pass < 2; pass += 1) {
        expect(() => staffWeekStartForWorkDate(bad)).toThrow(/Staff work date/);
        expect(() => addStaffWorkDays(bad, 1)).toThrow(/Staff work date/);
      }
    }
  });

  test('works a date out once, drops the oldest answer at the cap, and never keeps a number of days that is not whole', () => {
    // The time zone helpers are stubbed here, so only the keeping is tested (and 5,000 dates cost nothing).
    jest.isolateModules(() => {
      const addETDays = jest.fn((anchor, days) => `${anchor}+${days}`);
      const etWeekStart = jest.fn((anchor) => `week of ${anchor}`);
      jest.doMock('../utils/datetime-et', () => ({
        TZ: 'America/New_York', parseETDateTime: (text) => text, etDateString: (value) => value, addETDays, etWeekStart,
      }));
      const fresh = require('../utils/staff-time-work-date');
      expect(fresh.addStaffWorkDays('2026-06-03', 1)).toBe('2026-06-03T12:00+1');
      expect(fresh.addStaffWorkDays('2026-06-03', 1)).toBe('2026-06-03T12:00+1');
      expect(addETDays).toHaveBeenCalledTimes(1); // the second call read the kept answer
      expect(fresh.addStaffWorkDays('2026-06-04', 1)).toBe('2026-06-04T12:00+1'); // another date is another answer
      expect(fresh.addStaffWorkDays('2026-06-03', -1)).toBe('2026-06-03T12:00+-1');
      expect(addETDays).toHaveBeenCalledTimes(3);
      for (let days = 2; days <= 4998; days += 1) fresh.addStaffWorkDays('2026-06-03', days); // 5,000 answers: the cap
      expect(addETDays).toHaveBeenCalledTimes(5000);
      fresh.addStaffWorkDays('2026-06-03', 1);
      expect(addETDays).toHaveBeenCalledTimes(5000); // still kept
      fresh.addStaffWorkDays('2026-06-03', 4999); // one more answer: the oldest one is dropped
      fresh.addStaffWorkDays('2026-06-03', 1);
      expect(addETDays).toHaveBeenCalledTimes(5002); // worked out again, with the same result
      expect(fresh.addStaffWorkDays('2026-06-03', 1)).toBe('2026-06-03T12:00+1');
      // not a whole number of days: worked out on every call
      fresh.addStaffWorkDays('2026-06-03', 1.5);
      fresh.addStaffWorkDays('2026-06-03', 1.5);
      fresh.addStaffWorkDays('2026-06-03', '2');
      fresh.addStaffWorkDays('2026-06-03', '2');
      expect(addETDays).toHaveBeenCalledTimes(5006);
      // the week start is kept by date, apart from the day sums
      expect(fresh.staffWeekStartForWorkDate('2026-06-03')).toBe('week of 2026-06-03T12:00');
      expect(fresh.staffWeekStartForWorkDate('2026-06-03')).toBe('week of 2026-06-03T12:00');
      expect(etWeekStart).toHaveBeenCalledTimes(1);
      // a date that is not valid throws before anything is worked out or kept
      expect(() => fresh.staffWeekStartForWorkDate('2026-02-30')).toThrow(/valid calendar date/);
      expect(() => fresh.addStaffWorkDays('2026-02-30', 1)).toThrow(/valid calendar date/);
      expect([addETDays.mock.calls.length, etWeekStart.mock.calls.length]).toEqual([5006, 1]);
    });
    jest.dontMock('../utils/datetime-et');
  });

  test('all Staff entry-date predicates route through the shared ET expression', () => {
    const relativeFiles = [
      '../services/time-tracking.js',
      '../services/time-tracking-crons.js',
      '../services/timesheet-approval.js',
    ];
    const sources = relativeFiles.map((relativeFile) => fs.readFileSync(
      path.join(__dirname, relativeFile),
      'utf8',
    ));

    for (const source of sources) {
      expect(source).not.toMatch(/DATE\(clock_in\)/);
      expect(source).not.toMatch(/new Date\([^)]*clock_in[^)]*\)\.toISOString\(\)/);
    }
    expect(sources.join('\n')).toMatch(/STAFF_WORK_DATE_SQL/);
    expect(sources.join('\n')).toMatch(/staffWorkDate\(/);
  });
});
