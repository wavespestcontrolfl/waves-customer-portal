/**
 * ONE dunning clock per customer (owner ruling 2026-08-28): the account's
 * open invoices are collected as ONE balance, and every age/tier decision
 * is anchored to the OLDEST unpaid invoice's due date — never the invoice
 * that happened to trigger a rail. Pure helpers shared by the contact
 * policy, the shadow sweep and the outbound conversation so all three agree.
 */
const { etCalendarDayOf, etDateString } = require('../../utils/datetime-et');

const DAY_MS = 24 * 60 * 60 * 1000;

/** Due reference for an invoice: due_date, else created_at (the rails' rule). */
function dueValueOf(invoice) {
  return invoice ? (invoice.due_date || invoice.created_at || null) : null;
}

/** Whole ET calendar days between the due value and `now` (negative = not yet due). */
function daysOverdueOn(now, dueValue) {
  if (!dueValue) return 0;
  const dueStr = etCalendarDayOf(dueValue);
  const nowStr = etDateString(now);
  const [dy, dm, dd] = dueStr.split('-').map(Number);
  const [ny, nm, nd] = nowStr.split('-').map(Number);
  return Math.round((Date.UTC(ny, nm - 1, nd) - Date.UTC(dy, dm - 1, dd)) / DAY_MS);
}

/** The oldest-due invoice of a set (ties: earliest created_at). null on empty. */
function anchorInvoiceOf(invoices = []) {
  let anchor = null;
  for (const inv of invoices) {
    if (!inv) continue;
    if (!anchor) { anchor = inv; continue; }
    const a = String(etCalendarDayOf(dueValueOf(anchor)));
    const b = String(etCalendarDayOf(dueValueOf(inv)));
    if (b < a || (b === a && String(inv.created_at || '') < String(anchor.created_at || ''))) anchor = inv;
  }
  return anchor;
}

/** Days overdue of the ACCOUNT = of its anchor invoice. */
function accountDaysOverdue(now, invoices = []) {
  const anchor = anchorInvoiceOf(invoices);
  return anchor ? daysOverdueOn(now, dueValueOf(anchor)) : 0;
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

module.exports = { dueValueOf, daysOverdueOn, anchorInvoiceOf, accountDaysOverdue, dunningTierForOverdue, registerForTier };
