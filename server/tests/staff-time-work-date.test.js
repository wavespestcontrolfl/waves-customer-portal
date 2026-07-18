const fs = require('fs');
const path = require('path');

const {
  STAFF_TIME_ZONE,
  STAFF_WORK_DATE_SQL,
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
