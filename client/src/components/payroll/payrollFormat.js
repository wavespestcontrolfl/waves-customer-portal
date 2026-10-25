import { etDateString, etStartOfWeek } from '../../lib/timezone';
import { addStaffCalendarDays } from '../../lib/staffTimeDate';

// Small date and money helpers shared by the Payroll tab and the pay runs.
// Dates stay 'YYYY-MM-DD' text; day math is the Staff page's addStaffCalendarDays.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!match) return '';
  return `${MONTHS[Number(match[2]) - 1]} ${Number(match[3])}, ${match[1]}`;
}

export function dollars(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '';
}

export const centsToDollars = cents => dollars(Number(cents || 0) / 100);

// The Monday of the last staff week that has ended (Monday-Sunday, ET).
export const lastFinishedWeekStart = (today = etDateString(new Date())) => addStaffCalendarDays(etStartOfWeek(today), -7);

// The Friday after the week ends.
export const defaultPayDate = weekStart => addStaffCalendarDays(weekStart, 11);

export const weekLabel = weekStart => `${dayLabel(weekStart)} to ${dayLabel(addStaffCalendarDays(weekStart, 6))}`;
