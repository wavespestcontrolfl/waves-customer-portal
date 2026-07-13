import { describe, expect, test } from 'vitest';
import { addStaffCalendarDays, staffMondayET } from './staffTimeDate';

describe('Staff payroll calendar helpers', () => {
  test('uses the ET Monday while a west-coast browser is still on Sunday', () => {
    // Monday Jul 13 at 1:30 AM EDT is still Sunday at 10:30 PM PDT.
    const instant = new Date('2026-07-13T05:30:00.000Z');

    expect(staffMondayET(instant)).toBe('2026-07-13');
    expect(addStaffCalendarDays(staffMondayET(instant), -7)).toBe('2026-07-06');
  });

  test('handles month and year boundaries without browser-local time', () => {
    expect(addStaffCalendarDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addStaffCalendarDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});
