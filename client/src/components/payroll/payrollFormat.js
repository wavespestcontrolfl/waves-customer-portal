import { etDateString, etStartOfWeek } from '../../lib/timezone';

// Small date and money helpers shared by the Payroll tab and the pay runs.
// Dates stay 'YYYY-MM-DD' text; day math runs in UTC so no time zone moves a day.

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

export function addDays(dateText, days) {
  const [y, m, d] = String(dateText).split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

// The Monday of the last staff week that has ended (Monday-Sunday, ET).
export const lastFinishedWeekStart = (today = etDateString(new Date())) => addDays(etStartOfWeek(today), -7);

// The Friday after the week ends.
export const defaultPayDate = weekStart => addDays(weekStart, 11);

export const weekLabel = weekStart => `${dayLabel(weekStart)} to ${dayLabel(addDays(weekStart, 6))}`;
