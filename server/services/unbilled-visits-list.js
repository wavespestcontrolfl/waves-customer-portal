'use strict';

// Unbilled visits: one standing office bell (owner 2026-10-25, Air Jobs Plan step 3).
//
// It replaces the c02 "Unbilled completions" check that ran on the owner's
// MacBook Air (~/waves-ops/ops-crons). That check was an Aug 25 SQL copy of the
// Billing recovery leak query and never got the later fixes: it priced a Waves
// Assessment at the per-application fee, kept prepay-covered, sibling-covered
// and billed-elsewhere visits, and its "re service" match also caught "Lawn Care
// Service". This job reads the Billing recovery page's own list
// (routes/admin-billing-recovery.js listUninvoicedLeaks), so the bell and the
// page can never disagree.
//
// A standing list is a standing condition (docs/admin-notifications.md
// section 1): ONE needs-you Billing bell row, refreshed every day, rings again
// only when a visit joins the list (or the list comes back after it was empty),
// and closes itself (done) once no visit in the window waits. A person's own
// done stays done until a new visit joins. It bills nothing, sends nothing to a
// customer and changes no visit or invoice.
//
// Window: visits completed in the last 30 days (the page opens on 90). Both of
// the page's lists count: the one-click leaks and the needs-review rows.
//
// GATE_UNBILLED_VISITS_LIST (strict 'true', read at call time). Off = the daily
// cron returns before any read.

const db = require('../models/db');
const { unbilledVisitsListLive, alertEpisodesLive } = require('../config/feature-gates');
const { MAX_WHY_CHARS, breaksAlertRules, composeAdminAlert, raiseAdminAlert } = require('./admin-alert-compose');
const { fitAction, shortDateET } = require('./admin-alert-names');

const DEDUPE_KEY = 'unbilled-visits';
const CATEGORY = 'billing';
const WINDOW_DAYS = 30;
const LINK = '/admin/billing-recovery';
// The bell's "Show full text" lists at most this many visits (oldest first).
const DETAIL_MAX_LINES = 25;
// ops-digest's own itemKeys cap; far above any real list.
const ITEM_KEYS_MAX = 200;

function moneyCents(amount) {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function moneyWhole(amount) {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

// The page's two lists as one list of visits, oldest completion first (pure).
function listItems(result) {
  const rows = [
    ...(Array.isArray(result?.leaks) ? result.leaks.map((r) => ({ r, review: false })) : []),
    ...(Array.isArray(result?.needs_review) ? result.needs_review.map((r) => ({ r, review: true })) : []),
  ];
  const items = [];
  for (const { r, review } of rows) {
    const completedAt = new Date(r.completed_at);
    if (!r.scheduled_service_id || Number.isNaN(completedAt.getTime())) continue;
    items.push({
      visitId: String(r.scheduled_service_id),
      customerName: String(r.customer || '').trim() || 'Unknown customer',
      serviceType: String(r.service_type || '').trim() || 'Service',
      price: Number(r.price) || 0,
      completedAt,
      review,
      billable: r.billable !== false,
      voidedInvoiceNumber: r.voided_invoice_number || null,
      billedElsewhereInvoiceNumber: r.billed_elsewhere_invoice_number || null,
    });
  }
  return items.sort((a, b) => a.completedAt - b.completedAt || a.visitId.localeCompare(b.visitId));
}

// What the office reads beside each visit (the detail list only).
function nextStepWords(item) {
  const parts = [];
  if (!item.billable) parts.push('finish its completion first');
  else parts.push(item.review ? 'check, then bill or mark free' : 'bill or mark free');
  if (item.voidedInvoiceNumber) parts.push(`invoice ${item.voidedInvoiceNumber} was voided`);
  if (item.billedElsewhereInvoiceNumber) parts.push(`it was marked billed on ${item.billedElsewhereInvoiceNumber}, which is no longer live`);
  return parts.join('; ');
}

// One visit names its customer; a name the rule cannot carry falls back to the plain wording.
function whyFor(items, total) {
  const oldest = items[0];
  if (items.length > 1) return `${items.length} visits have no invoice, ${moneyWhole(total)} in all; the oldest was done ${shortDateET(oldest.completedAt)}.`;
  const named = `${oldest.customerName}'s ${oldest.serviceType} on ${shortDateET(oldest.completedAt)} has no invoice; ${moneyCents(total)} is not billed.`;
  if (named.length <= MAX_WHY_CHARS && !breaksAlertRules(named)) return named;
  return `One visit done ${shortDateET(oldest.completedAt)} has no invoice; ${moneyCents(total)} is not billed.`;
}

// The bell for a non-empty list (pure): the composeAdminAlert spec plus the
// detail text and the ring stamps.
function composeList(items) {
  const count = items.length;
  const total = items.reduce((sum, item) => sum + item.price, 0);
  const plural = count === 1 ? '' : 's';
  // One visit names its customer in the headline. A name the rule cannot carry
  // (brackets, an exclamation mark, an emoji, a second sentence) would make
  // composeAdminAlert throw and fail every run, so it falls back to the count.
  const named = count === 1
    ? fitAction('Billing', items[0].customerName, [(name) => `bill or mark free ${name}'s visit`, (name) => `bill ${name}'s visit`])
    : null;
  const action = named && !breaksAlertRules(`Billing — ${named}`) ? named : `bill or mark free ${count} unbilled visit${plural}`;
  const toReview = items.filter((item) => item.review).length;
  const lines = items.slice(0, DETAIL_MAX_LINES).map((item) => (
    `${item.customerName} · ${item.serviceType} · done ${shortDateET(item.completedAt)} · ${moneyCents(item.price)} · ${nextStepWords(item)}`
  ));
  if (count > DETAIL_MAX_LINES) lines.push(`…and ${count - DETAIL_MAX_LINES} more.`);
  const detail = [
    `${count} visit${plural} done in the last ${WINDOW_DAYS} days ${count === 1 ? 'has' : 'have'} no invoice, ${moneyCents(total)} in all.${toReview ? ` ${toReview} need${toReview === 1 ? 's' : ''} a check first (a monthly plan, a prepay, a per-application customer or an inspection or rodent visit).` : ''} This check billed nothing and sent nothing.`,
    'Oldest first:',
    ...lines,
    'Open Billing recovery to bill each visit or mark it free.',
  ].join('\n');
  const spec = {
    area: 'Billing',
    action,
    why: whyFor(items, total),
    severity: 'needs-you',
    link: LINK,
    subject: { type: 'check', id: DEDUPE_KEY },
    doneWhen: 'count_zero',
    who: 'person',
  };
  const itemKeys = items.map((item) => item.visitId).sort().slice(0, ITEM_KEYS_MAX);
  return { spec, detail, itemKeys, count, total: Math.round(total * 100) / 100 };
}

// A refresh rings only when a visit joins the list. (A comeback after the row
// was closed rings through raiseAdminAlertWithReopen, which ignores this.)
function ringOnNewVisit(itemKeys) {
  return (_existing, existingMeta) => {
    const prior = new Set(Array.isArray(existingMeta?.itemKeys) ? existingMeta.itemKeys.map(String) : []);
    return itemKeys.some((key) => !prior.has(key));
  };
}

async function raiseList(composed, dedupeKey) {
  const opts = {
    dedupeKey,
    // GATE_ADMIN_BELL_POLICY admits a billing row only when the site asks: ring
    // unless the owner silenced the category (notification-bell-policy.js).
    bellDefault: true,
    refreshOnDedupe: true,
    ringOnRefresh: ringOnNewVisit(composed.itemKeys),
    // A refresh that rings moves the row to the top of the newest-first bell.
    bumpOnRefresh: true,
    detail: composed.detail,
    metadata: { itemKeys: composed.itemKeys, count: composed.count, totalUnbilled: composed.total },
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
    resolution: `No visit from the last ${WINDOW_DAYS} days is waiting to be billed`,
  });
}

// The Billing recovery page's own list (lazy: the route module loads at call time).
function loadPageList(days) {
  return require('../routes/admin-billing-recovery').listUninvoicedLeaks(days);
}

/**
 * Daily cron entry point. Returns { skipped } when the gate is off, otherwise
 * { count, total, outcome }: raised | refreshed | unchanged | suppressed |
 * closed | clear. A read failure throws (runExclusive records it in
 * job_health) and never closes the row. `loadList` is the list source and
 * `dedupeKey` the row's key (tests set both).
 */
async function runUnbilledVisitsList({ database = db, gateEnabled, loadList = loadPageList, dedupeKey = DEDUPE_KEY } = {}) {
  if (!(gateEnabled ?? unbilledVisitsListLive())) return { skipped: 'disabled' };
  const items = listItems(await loadList(WINDOW_DAYS));
  if (!items.length) {
    const closed = Number(await closeList(database, dedupeKey)) || 0;
    return { count: 0, outcome: closed ? 'closed' : 'clear' };
  }
  const composed = composeList(items);
  const result = await raiseList(composed, dedupeKey);
  if (!result) throw new Error('unbilled visits bell was not written');
  let outcome = 'unchanged';
  // The owner silenced billing bells: the bell policy wrote nothing.
  if (result.suppressed) outcome = 'suppressed';
  else if (!result.deduped) outcome = 'raised';
  else if (result.refreshed) outcome = result.rung === false ? 'refreshed' : 'raised';
  return { count: composed.count, total: composed.total, outcome };
}

module.exports = {
  runUnbilledVisitsList,
  DEDUPE_KEY,
  _private: { listItems, composeList, ringOnNewVisit, nextStepWords, whyFor, WINDOW_DAYS, DETAIL_MAX_LINES },
};
