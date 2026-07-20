import { describe, expect, test } from 'vitest';
import { formatETDateOnly } from './timezone';

// A Postgres `date` column (next_service_date) serializes to UTC midnight over
// JSON; formatting it in ET without an anchor slips it to the previous calendar
// day (2026-07-19 rendered "Jul 18"). formatETDateOnly must preserve the day.
describe('formatETDateOnly', () => {
  test('a UTC-midnight date-only value keeps its calendar day in ET', () => {
    expect(
      formatETDateOnly('2026-07-19T00:00:00.000Z', { month: 'short', day: 'numeric' }),
    ).toBe('Jul 19');
  });

  test('accepts a bare YYYY-MM-DD string', () => {
    expect(
      formatETDateOnly('2026-01-01', { month: 'short', day: 'numeric' }),
    ).toBe('Jan 1');
  });

  test('honors format options (year)', () => {
    expect(
      formatETDateOnly('2026-12-31T00:00:00.000Z', { month: 'short', day: 'numeric', year: 'numeric' }),
    ).toBe('Dec 31, 2026');
  });

  test('empty / invalid input returns an empty string', () => {
    expect(formatETDateOnly(null)).toBe('');
    expect(formatETDateOnly('')).toBe('');
    expect(formatETDateOnly('not-a-date')).toBe('');
  });
});
