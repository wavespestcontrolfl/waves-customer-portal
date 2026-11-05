'use strict';

// Emailed invoices not paid with Spark: one standing office bell (owner 2026-11-05:
// "if we have an invoice in email, that isn't linked to Spark, we should have an admin
// notification for it"; the business uses Spark only for expenses, plus the business
// debit card).
//
// services/email/invoice-processor.js books each emailed vendor invoice as an
// `expenses` row (linked by emails.expense_id). services/bank-import.js later links the
// card or bank line that paid it (bank_transactions.matched_expense_id, exact cents,
// +/- 5 days). This job lists the emailed expenses whose paying line is on the wrong
// account, or was not found at all, grouped by vendor so a vendor with many small
// charges is one line, not many.
//
// Same shape as services/unbilled-visits-list.js (docs/admin-notifications.md section
// 1): ONE needs-you bell row, refreshed every day, rings again only when a VENDOR joins
// the list (or the list comes back after it was empty), and closes itself (done) when
// the list is empty. A person's own done stays done until a new vendor joins. It reads
// expenses, emails and bank_transactions and writes only that one admin alert row: no
// customer message, no expense edit, no bank row edit, no paid API call.
//
// Window: expenses dated 14 days ago through 3 days ago (ET calendar days). The 3-day
// grace lets the card charge post and the hourly matcher link it.
//
// GATE_INVOICE_NOT_ON_SPARK (strict 'true', read at call time) and
// INVOICE_OK_ACCOUNT_LABELS (comma list of bank_transactions.account_label values that
// count as paid the right way). Gate off or the list unset = the daily cron does
// nothing: the accounts are never guessed in code.

const db = require('../models/db');
const logger = require('./logger');
const { invoiceNotOnSparkLive, alertEpisodesLive } = require('../config/feature-gates');
const { MAX_WHY_CHARS, breaksAlertRules, composeAdminAlert, raiseAdminAlert } = require('./admin-alert-compose');
const { shortDateET } = require('./admin-alert-names');
const { etDateString, addETDays } = require('../utils/datetime-et');

const DEDUPE_KEY = 'invoice-not-on-spark';
const CATEGORY = 'tax';
// Same Tax page route the tax-deadline bells use, opened on its Expenses tab.
const LINK = '/admin/tax?tab=expenses';
const GRACE_DAYS = 3;
const WINDOW_DAYS = 14;
const UNKNOWN_VENDOR = 'Unknown vendor';
const DETAIL_MAX_LINES = 25;
const ITEM_KEYS_MAX = 200;

function moneyWords(amount) {
  const cents = Math.round(amount * 100);
  const text = (Math.abs(cents) / 100).toLocaleString('en-US', cents % 100 === 0
    ? { maximumFractionDigits: 0 }
    : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${cents < 0 ? '-' : ''}$${text}`;
}

// The accounts that count as paid the right way, from the env list (pure).
function parseOkLabels(raw = process.env.INVOICE_OK_ACCOUNT_LABELS) {
  return new Set(String(raw || '').split(',').map((label) => label.trim()).filter(Boolean));
}

// The first and last expense_date to list, as ET calendar-day strings (pure).
function windowFor(now = new Date()) {
  return {
    from: etDateString(addETDays(now, -WINDOW_DAYS)),
    to: etDateString(addETDays(now, -GRACE_DAYS)),
  };
}

const vendorKeyOf = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase() || UNKNOWN_VENDOR.toLowerCase();
const vendorNameOf = (name) => String(name || '').trim().replace(/\s+/g, ' ') || UNKNOWN_VENDOR;

// "••3098" from a label like 'capital-one-card-3098'; a label with no digits reads as another account.
function accountWords(label) {
  const digits = String(label || '').match(/(\d{4})\D*$/);
  return digits ? `••${digits[1]}` : 'another account';
}

// Group the expense rows into one entry per vendor (pure). `rows` are
// { expense_id, vendor_name, amount, expense_date: 'YYYY-MM-DD', account_label | null }.
// An expense in the window with no linked line is 'no_charge'; one linked to an account
// outside okLabels is 'other_account'; one linked to an OK account is dropped. The date,
// amount and expense-id checks run here too, so a loose query cannot widen the list.
function buildVendorList(rows, { okLabels, from, to }) {
  const seen = new Set();
  const vendors = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row.expense_id ?? '');
    const date = String(row.expense_date || '').slice(0, 10);
    const amount = Number(row.amount);
    if (!id || seen.has(id) || !(amount > 0) || date < from || date > to) continue;
    seen.add(id);
    const label = row.account_label ? String(row.account_label) : '';
    if (label && okLabels.has(label)) continue;
    const key = vendorKeyOf(row.vendor_name);
    let vendor = vendors.get(key);
    if (!vendor) {
      vendor = { key, name: vendorNameOf(row.vendor_name), count: 0, cents: 0, noCharge: 0, accounts: new Set(), newest: '' };
      vendors.set(key, vendor);
    }
    vendor.count += 1;
    vendor.cents += Math.round(amount * 100);
    if (label) vendor.accounts.add(accountWords(label)); else vendor.noCharge += 1;
    if (date >= vendor.newest) { vendor.newest = date; vendor.name = vendorNameOf(row.vendor_name); }
  }
  return [...vendors.values()]
    .map((v) => ({
      key: v.key,
      name: v.name,
      count: v.count,
      total: v.cents / 100,
      noCharge: v.noCharge,
      kinds: [...(v.noCharge ? ['no_charge'] : []), ...(v.accounts.size ? ['other_account'] : [])],
      accounts: [...v.accounts].sort(),
      newest: v.newest,
    }))
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
}

// How one vendor's invoices were paid, in plain words.
function paidWords(vendor) {
  const parts = [];
  if (vendor.accounts.length) parts.push(`paid from ${vendor.accounts.join(', ')}`);
  if (vendor.noCharge) parts.push('no card charge found');
  return parts.join(' and ');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function vendorPhrase(vendor) {
  return `${vendor.name}: ${plural(vendor.count, 'invoice')} (${moneyWords(vendor.total)}) ${paidWords(vendor)}`;
}

// The why: as many of the biggest vendors as fit and read clean, else the counts (pure).
function whyFor(vendors) {
  const parts = [];
  for (const vendor of vendors) {
    const next = [...parts, vendorPhrase(vendor)].join('; ');
    if (next.length > MAX_WHY_CHARS || breaksAlertRules(next)) break;
    parts.push(vendorPhrase(vendor));
  }
  if (parts.length) {
    const more = vendors.length - parts.length;
    const withMore = more > 0 ? `${parts.join('; ')}; and ${more} more` : parts.join('; ');
    return withMore.length <= MAX_WHY_CHARS ? withMore : parts.join('; ');
  }
  const invoices = vendors.reduce((sum, v) => sum + v.count, 0);
  const total = vendors.reduce((sum, v) => sum + v.total, 0);
  return `${plural(invoices, 'invoice')} worth ${moneyWords(total)} from ${plural(vendors.length, 'vendor')} were not paid with Spark`;
}

// The bell for a non-empty list (pure): the composeAdminAlert spec plus the detail
// text and the ring stamps.
function composeList(vendors) {
  const count = vendors.length;
  const invoices = vendors.reduce((sum, v) => sum + v.count, 0);
  const total = Math.round(vendors.reduce((sum, v) => sum + v.total, 0) * 100) / 100;
  const action = count === 1 ? "check one vendor's invoices not paid with Spark" : `check ${count} vendors' invoices not paid with Spark`;
  const lines = vendors.slice(0, DETAIL_MAX_LINES).map((v) => (
    `${v.name} · ${plural(v.count, 'invoice')} · ${moneyWords(v.total)} · ${paidWords(v)} · newest ${shortDateET(new Date(`${v.newest}T12:00:00Z`))}`
  ));
  if (count > DETAIL_MAX_LINES) lines.push(`…and ${count - DETAIL_MAX_LINES} more.`);
  const detail = [
    `${plural(invoices, 'emailed vendor invoice')}, ${moneyWords(total)} in all, dated ${GRACE_DAYS} to ${WINDOW_DAYS} days ago ${invoices === 1 ? 'was' : 'were'} not paid with the Spark card or the business debit card. This check changed nothing and sent nothing.`,
    'Biggest first:',
    ...lines,
    'Open the Tax page, Expenses tab, to see each invoice and the bank line it matched.',
  ].join('\n');
  const spec = {
    area: 'Billing',
    action,
    why: whyFor(vendors),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: DEDUPE_KEY },
    doneWhen: 'count_zero',
    who: 'person',
  };
  const itemKeys = vendors.map((v) => v.key).sort().slice(0, ITEM_KEYS_MAX);
  return { spec, detail, itemKeys, count, invoices, total };
}

// A refresh rings only when a vendor joins the list. (A comeback after the row was
// closed rings through raiseAdminAlertWithReopen, which ignores this.)
function ringOnNewVendor(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

async function raiseList(composed, dedupeKey) {
  const opts = {
    dedupeKey,
    bellDefault: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewVendor(composed.itemKeys),
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { itemKeys: composed.itemKeys, count: composed.count, invoiceCount: composed.invoices, totalNotOnSpark: composed.total },
  };
  if (!alertEpisodesLive()) return raiseAdminAlert(CATEGORY, composed.spec, opts);
  const alert = composeAdminAlert(composed.spec);
  return require('./admin-alert-episodes').raiseAdminAlertWithReopen(CATEGORY, alert.headline, alert.why, {
    ...opts, link: alert.link, metadata: { ...opts.metadata, ...alert.metadata },
  });
}

async function closeList(database, dedupeKey) {
  if (!alertEpisodesLive()) return 0;
  return require('./admin-alert-episodes').closeAdminAlertKeys(database, [dedupeKey], 'count_zero', {
    resolution: 'Every emailed invoice from the last 14 days was paid with Spark or the business debit card',
  });
}

// Thin read: emailed expenses in the window, each with the account of the line that
// matched it (null = none). matched_expense_id is unique, so one expense is one row.
function loadRows(database, { from, to }) {
  return database('expenses as x')
    .leftJoin('bank_transactions as bt', 'bt.matched_expense_id', 'x.id')
    .whereExists(function emailBooked() { this.select(database.raw('1')).from('emails as e').whereRaw('e.expense_id = x.id'); })
    .where('x.amount', '>', 0)
    .whereRaw('x.expense_date between ?::date and ?::date', [from, to])
    .select('x.id as expense_id', 'x.vendor_name', 'x.amount', database.raw("to_char(x.expense_date, 'YYYY-MM-DD') as expense_date"), 'bt.account_label');
}

/**
 * Daily cron entry point. Returns { skipped } when the gate is off or no account list
 * is set (nothing is read), otherwise { count, invoices, total, outcome }: raised |
 * refreshed | unchanged | suppressed | closed | clear. A read failure throws
 * (runExclusive records it in job_health) and never closes the row. `rows` replaces
 * the read and `dedupeKey` is the row's key (tests set both).
 */
async function runInvoiceNotOnSpark({ database = db, gateEnabled, now = new Date(), okLabels = parseOkLabels(), rows, dedupeKey = DEDUPE_KEY } = {}) {
  if (!(gateEnabled ?? invoiceNotOnSparkLive())) return { skipped: 'disabled' };
  if (!okLabels.size) {
    logger.info('[invoice-not-on-spark] INVOICE_OK_ACCOUNT_LABELS is not set: nothing checked');
    return { skipped: 'no_ok_accounts' };
  }
  const window = windowFor(now);
  const vendors = buildVendorList(rows ?? await loadRows(database, window), { okLabels, ...window });
  if (!vendors.length) {
    const closed = Number(await closeList(database, dedupeKey)) || 0;
    return { count: 0, outcome: closed ? 'closed' : 'clear' };
  }
  const composed = composeList(vendors);
  const result = await raiseList(composed, dedupeKey);
  if (!result) throw new Error('invoice not on Spark bell was not written');
  let outcome = 'unchanged';
  // The owner silenced the category: the bell policy wrote nothing.
  if (result.suppressed) outcome = 'suppressed';
  else if (!result.deduped) outcome = 'raised';
  else if (result.refreshed) outcome = result.rung === false ? 'refreshed' : 'raised';
  return { count: composed.count, invoices: composed.invoices, total: composed.total, outcome };
}

module.exports = {
  runInvoiceNotOnSpark,
  DEDUPE_KEY,
  _private: { parseOkLabels, windowFor, buildVendorList, composeList, whyFor, ringOnNewVendor, accountWords, GRACE_DAYS, WINDOW_DAYS },
};
