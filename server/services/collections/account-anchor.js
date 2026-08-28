/**
 * ONE dunning clock per customer (owner ruling 2026-08-28): the account's
 * open invoices are collected as ONE balance, and every age/tier decision
 * is anchored to the OLDEST unpaid invoice's due date — never the invoice
 * that happened to trigger a rail. Pure helpers shared by the contact
 * policy, the shadow sweep and the outbound conversation so all three agree.
 */
const { etCalendarDayOf, etDateString } = require('../../utils/datetime-et');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ET due DAY of an invoice ('YYYY-MM-DD'): due_date (a DATE column —
 * literal), else created_at (a timestamptz — its America/New_York calendar
 * day; a UTC-midnight instant is the PREVIOUS day in ET, so it is never
 * read as date-only). Field-aware on purpose (hook r6): the rails' fallback
 * rule, with the timezone discipline applied per column type.
 */
function dueDayOf(invoice) {
  if (!invoice) return null;
  if (invoice.due_date) return etCalendarDayOf(invoice.due_date);
  if (invoice.created_at) {
    const t = new Date(invoice.created_at);
    return Number.isNaN(t.getTime()) ? null : etDateString(t);
  }
  return null;
}

/** Whole ET calendar days between a due DAY ('YYYY-MM-DD' / DATE) and `now` (negative = not yet due). */
function daysOverdueOn(now, dueDay) {
  if (!dueDay) return 0;
  const dueStr = etCalendarDayOf(dueDay);
  const nowStr = etDateString(now);
  const [dy, dm, dd] = dueStr.split('-').map(Number);
  const [ny, nm, nd] = nowStr.split('-').map(Number);
  return Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(dy, dm - 1, dd)) / DAY_MS);
}

/** Epoch ms of a timestamp column (string or Date); unparseable sorts LAST. */
function epochOf(value) {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** Days overdue of ONE invoice by its field-aware due day. */
function invoiceDaysOverdue(now, invoice) {
  const day = dueDayOf(invoice);
  return day ? daysOverdueOn(now, day) : 0;
}

/**
 * Sorted COPY, oldest-due first (ties: earliest created_at — compared as
 * instants: Postgres returns Date objects and String(Date) is not
 * chronological). The ONE ordering the policy, sweep and disclosure share.
 */
function orderByDue(invoices = []) {
  return invoices.filter(Boolean).slice().sort((x, y) => {
    const a = dueDayOf(x) || '9999-99-99'; // missing sorts last
    const b = dueDayOf(y) || '9999-99-99';
    if (a !== b) return a < b ? -1 : 1;
    return epochOf(x.created_at) - epochOf(y.created_at);
  });
}

/** The oldest-due invoice of a set. null on empty. */
function anchorInvoiceOf(invoices = []) {
  return orderByDue(invoices)[0] || null;
}

/** Days overdue of the ACCOUNT = of its anchor invoice. */
function accountDaysOverdue(now, invoices = []) {
  const anchor = anchorInvoiceOf(invoices);
  return anchor ? invoiceDaysOverdue(now, anchor) : 0;
}

// Same escalation boundaries as the late-payment tiers (7/14/30/60/90); the
// pilot window (14–60 days) means shadow cases land on 14/30/60.
function dunningTierForOverdue(daysSince) {
  if (daysSince < 14) return 7;
  if (daysSince < 30) return 14;
  if (daysSince < 60) return 30;
  if (daysSince < 90) return 60;
  return 90;
}

// The three spoken registers (owner ruling 2026-08-28): friendly at 14,
// firm at 30, final at 60+. Below 14 there is no automated call.
function registerForTier(tier) {
  if (tier >= 60) return 'final';
  if (tier >= 30) return 'firm';
  return 'friendly';
}

module.exports = { dueDayOf, daysOverdueOn, invoiceDaysOverdue, orderByDue, anchorInvoiceOf, accountDaysOverdue, dunningTierForOverdue, registerForTier };
