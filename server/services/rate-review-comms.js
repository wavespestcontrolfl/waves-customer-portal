'use strict';

/**
 * Annual rate review — COMMS lane (plan
 * ~/.claude/plans/annual-rate-review-2026-09-30.md, build step 4; stacked on
 * the apply lane, services/rate-review-apply.js).
 *
 * The apply lane's scheduleNoticeRows leaves one DRAFT price_change_notices
 * row per approved plan line. This module turns a batch's drafts into the
 * customer's letter and sends it — only from the authenticated Rate review
 * screen (POST /api/admin/rate-review/batches/:key/send, against the digest
 * of the send preview). There is no email-reply approval: CLAUDE.md rule 14
 * forbids extending it to customer comms or money.
 *
 *   sendPreview(batchKey)          who would get what: one entry per
 *     customer (ONE letter for all of a customer's reviewed lines in the
 *     batch), the channels on file, and every suppression with its reason;
 *     plus a digest over the sendable set AND the owner's cost block, so a
 *     list or wording change between preview and send refuses the send.
 *   letterPreview(batchKey, rowId) the rendered email (subject + html) for
 *     one ranking row's customer, exactly as it would send. Sends nothing.
 *   sendBatch(batchKey, { expectedDigest })  claims each customer's draft
 *     rows (draft → sending), sends the email letter
 *     (billing.rate_review_notice) and the SMS pointer (the existing
 *     price_change_notice template), then stamps sent_at — the DELIVERY
 *     timestamp the apply lane's 30-day rule counts from — and moves the
 *     ranking rows approved → sent. The letter's words are frozen onto the
 *     notice (metadata.letter) at send, so the public page shows exactly
 *     what was sent even if the cost block is edited later.
 *
 * Every letter slot is a stored, deterministic fact (the ranking row, the
 * notice row, the owner's hand-written cost block) — no generated text on
 * money copy. A missing cost block refuses every send (never invented).
 *
 * Fail closed: dark behind GATE_RATE_REVIEW (re-read before each customer —
 * flipping it off mid-batch stops the rest); a notice whose effective date
 * is under 30 days from today (31 for a prepaid renewal, the apply lane's
 * own rule) is suppressed, never sent late.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { rateReviewLive } = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const { formatDisplayDate } = require('../utils/date-only');
const { portalUrl } = require('../utils/portal-url');
const { propertyStreetLine } = require('../utils/property-display');
const { getInvoiceEmailRecipients } = require('./customer-contact');
const { lockCustomerComms, lockCustomerEmail, withSmsConsentLock } = require('../utils/customer-comms-lock');
const { toE164 } = require('../utils/phone');
const PriceChangeNotices = require('./price-change-notices');

const TEMPLATE_KEY = 'billing.rate_review_notice';
const LINE_SLOTS = 4;
const MIN_NOTICE_DAYS = PriceChangeNotices.MIN_NOTICE_DAYS;
const SEND_CONCURRENCY = 5;
const CLAIM_STALE_MS = 15 * 60 * 1000;
const UNCERTAIN = 'send_uncertain';
const BATCH_KEY_RE = /^\d{4}-\d{2}$/;
const DAY_MS = 86400000;

const SERVICE_LABELS = Object.freeze({
  pest_control: 'Pest control',
  lawn_care: 'Lawn care',
  tree_shrub: 'Tree & shrub care',
  mosquito: 'Mosquito control',
  rodent: 'Rodent control',
});

// Suppression reasons the preview reports (and the send honours).
const REASONS = Object.freeze({
  customer_inactive: 'Customer is inactive or deleted',
  not_approved: 'Ranking row is no longer approved',
  too_late: `Effective date is under ${MIN_NOTICE_DAYS} days away (${MIN_NOTICE_DAYS + 2} for a prepaid renewal) — reschedule the notices`,
  invalid_amount: 'New rate is not above the current rate',
  unsupported_line: 'Service line has no letter wording',
  too_many_lines: `More than ${LINE_SLOTS} reviewed lines on one account`,
  no_contact: 'No email or phone on file',
  in_flight: 'A send for this customer is in progress',
  send_uncertain: 'An earlier send may have reached the customer — check the email log before anything else is sent',
  renewal_declined: 'Customer declined to renew the prepaid plan',
  lane_changed: 'Billing changed since the notice was prepared — prepare it again',
  rate_moved: 'The rate on file is no longer the one in the notice — prepare it again',
  line_gone: 'No open application left on this plan line, or one was repriced since the notice was prepared',
  apply_hold: 'The plan line has a structure the nightly rate change cannot carry out (add-ons, a discount, prepaid money, a parked reschedule, more than one series, a replaced plan) — fix it before sending',
});

function badInput(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseJson(value, fallback) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || ''); } catch { return fallback; }
}

function ymd(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function daysBetween(fromDay, toDay) {
  return Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / DAY_MS);
}

function money(centsValue) {
  return PriceChangeNotices.formatMoney(Number(centsValue) || 0);
}

const byEffective = (a, b) => String(a.effectiveDate).localeCompare(String(b.effectiveDate));

function dateLabel(day) {
  return formatDisplayDate(day, { fallback: day || '' });
}

function unitFor(notice) {
  if (notice.billing_lane === 'annual_prepay') return 'year';
  return notice.cadence_label === 'month' ? 'month' : 'application';
}

// The name the email greets: the billing recipient's, exactly as
// sendNoticeEmail resolves it (the invoice recipient's name, else the
// customer's first name). The preview, the digest, the frozen letter and the
// delivered email all take it from here, so they share one greeting.
function greetingName(customer, prefs) {
  const [recipient] = getInvoiceEmailRecipients(customer || {}, prefs || {});
  return String(recipient?.name || customer?.first_name || '').trim().split(/\s+/)[0] || 'there';
}

async function loadCostBlock(dbh = db) {
  // rate_review_config.cost_block is the owner's once-a-year paragraph
  // (the admin screen's Cost block field). Read via select('*') so a
  // database without the column reads as "not written" (refuse), never
  // throws.
  const row = await dbh('rate_review_config').where({ id: 1 }).first().catch(() => null);
  const text = String(row?.cost_block || '').trim();
  return text || null;
}

// ── facts → letter ─────────────────────────────────────────────────────

const KEEPS_PACE = 'This change keeps pace with the costs above.';

// The new-customer comparison, only for an engine-priced list (today's
// new-customer price for this home). A book-mode fallback (cadence_mode)
// is existing customers' rates and is never stated to the customer as one.
function listComparison({ current, proposed, list, source }) {
  if (['none', 'cadence_mode'].includes(source) || !(list > 0 && current > 0)) return KEEPS_PACE;
  if (current >= list) return `Your current rate of ${money(current)} per application is in line with what we charge a new customer for the same service today (${money(list)}). ${KEEPS_PACE}`;
  const below = `At ${money(current)} per application, that is below what we charge a new customer for the same service today (${money(list)}).`;
  if (proposed === list) return `${below} The new rate brings you to that number, and not a dollar over it.`;
  if (proposed < list) return `${below} I am moving it part of the way this year, to ${money(proposed)}, and you stay under the new-customer rate.`;
  return `${below} The new rate of ${money(proposed)} keeps pace with the costs above.`;
}

// "Why your rate specifically" — only stored facts: the ranking row's
// usable visits and treatment minutes, and today's new-customer list price
// (per application; a monthly line states the costs only).
function whyFor(notice, snapshot) {
  const visits = Number(snapshot?.usable_visits) || 0;
  const minutes = Math.round(Number(snapshot?.treatment_minutes_median) || 0);
  const facts = visits >= 2 && minutes > 0
    ? `Over the past year our records show ${visits} applications at your home, about ${minutes} minutes of treatment each. `
    : '';
  const comparison = unitFor(notice) === 'month' ? KEEPS_PACE : listComparison({
    current: Number(snapshot?.current_rate_cents) || 0,
    proposed: Number(snapshot?.proposed_rate_cents) || 0,
    list: Number(snapshot?.list_rate_cents) || 0,
    source: String(snapshot?.list_rate_source || 'none'),
  });
  return `${facts}${comparison}`;
}

function lineFor(notice, snapshot, customer) {
  const meta = parseJson(notice.metadata, {});
  const service = SERVICE_LABELS[notice.family_key];
  const street = propertyStreetLine(customer || {});
  const effective = ymd(notice.effective_date);
  const unit = unitFor(notice);
  const current = Number(notice.noticed_current_cents ?? notice.current_amount_cents);
  const next = Number(notice.noticed_new_cents ?? notice.new_amount_cents);
  const base = {
    noticeId: notice.id,
    familyKey: notice.family_key,
    service: [service, street].filter(Boolean).join(' · '),
    serviceLabel: service || null,
    unit,
    currentCents: current,
    newCents: next,
    effectiveDate: effective,
  };
  if (unit === 'year') {
    const perAppNow = Number(meta.per_application_current_cents) || 0;
    const perAppNew = Number(meta.per_application_new_cents) || 0;
    const termEnd = ymd(meta.term_end);
    return {
      ...base,
      now: `${money(current)} per year${perAppNow ? ` (${money(perAppNow)} per application)` : ''}`,
      newLabel: `From your renewal on ${dateLabel(effective)}`,
      new: `${money(next)} per year${perAppNew ? ` (${money(perAppNew)} per application)` : ''} (up ${money(next - current)})`,
      firstLabel: 'Your current prepaid year',
      first: termEnd ? `unchanged through ${dateLabel(termEnd)}` : 'unchanged until renewal',
      perApplicationCurrentCents: perAppNow || null,
      perApplicationNewCents: perAppNew || null,
      termEnd,
      why: whyFor(notice, snapshot),
    };
  }
  return {
    ...base,
    now: `${money(current)} per ${unit}`,
    newLabel: `From ${dateLabel(effective)}`,
    new: `${money(next)} per ${unit} (up ${money(next - current)})`,
    firstLabel: unit === 'month' ? 'First month at the new rate' : 'First application at the new rate',
    // The rule itself, never one visit's date: the apply reprices every
    // eligible application from the effective date, whichever comes first.
    first: `on or after ${dateLabel(effective)}`,
    why: whyFor(notice, snapshot),
  };
}

// The email payload (and the frozen page content) for one customer's lines.
function letterPayload({ customer, prefs = null, lines, costBlock, noticeUrl }) {
  const ordered = [...lines].sort(byEffective);
  const payload = {
    first_name: greetingName(customer, prefs),
    effective_date: dateLabel(ordered[0].effectiveDate),
    cost_block: costBlock,
    notice_url: noticeUrl,
    prepay_note: ordered.some((l) => l.unit === 'year')
      ? 'Your prepaid year stays exactly as it is. The new amount applies only when your plan renews.'
      : '',
  };
  ordered.forEach((l, i) => {
    const n = i + 1;
    const prefix = ordered.length > 1 && l.serviceLabel ? `${l.serviceLabel}: ` : '';
    Object.assign(payload, {
      [`line${n}_service`]: l.service,
      [`line${n}_now`]: l.now,
      [`line${n}_new_label`]: l.newLabel,
      [`line${n}_new`]: l.new,
      [`line${n}_first_label`]: l.firstLabel,
      [`line${n}_first`]: l.first,
      [`line${n}_why`]: `${prefix}${l.why}`,
    });
  });
  return payload;
}

// Notices whose rate on file is no longer the noticed current rate — read
// the way the nightly apply reads it, so a letter never announces a change
// the apply would refuse (rate_moved_since_notice): monthly the family's
// ledger slices or the dues; per application the first visit's stamped
// price; prepaid the live term's amount. An unreadable rate counts as moved.
async function ratesMovedFor(dbh, notices, { customers, visitById, today }) {
  const customerById = new Map(customers.map((c) => [String(c.id), c]));
  const moved = new Set();
  const monthly = notices.filter((n) => n.billing_lane === 'monthly_membership');
  const ok = new Set();
  for (const n of monthly) {
    if (!(await monthlyRefused(dbh, n, customerById.get(String(n.customer_id)), today))) ok.add(String(n.id));
  }
  for (const n of notices) {
    const meta = parseJson(n.metadata, {});
    if (n.billing_lane === 'monthly_membership' && !ok.has(String(n.id))) moved.add(String(n.id));
    // The pinned live term, the renewal day, the amounts and visit count the
    // letter quoted, a recorded successor, a renewal reminder already out ...:
    // the apply's own prepaid checks (rate-review-apply.js prepayChecks).
    if (n.billing_lane === 'annual_prepay' && await prepayRefused(dbh, n, customerById.get(String(n.customer_id)), today)) moved.add(String(n.id));
    if (n.billing_lane === 'per_application') {
      const visit = visitById.get(String(meta.first_visit_id || ''));
      if (visit && ['pending', 'confirmed'].includes(String(visit.status)) && Math.round(Number(visit.estimated_price) * 100) !== noticedCurrent(n)) moved.add(String(n.id));
    }
  }
  return moved;
}

function noticedCurrent(n) {
  return Number(n.noticed_current_cents ?? n.current_amount_cents);
}

// True when applyPrepay would refuse this notice (see prepayChecks). Unreadable = refused.
async function prepayRefused(dbh, notice, customer, today) {
  if (!customer) return true;
  const { prepayChecks } = require('./rate-review-apply')._private;
  try {
    return !!(await prepayChecks(dbh, { notice, customer, today, metadata: parseJson(notice.metadata, {}) })).refusal;
  } catch (err) {
    logger.warn(`[rate-review-comms] prepaid eligibility unreadable for notice ${notice.id}: ${err.message}`);
    return true;
  }
}

// True when applyMonthly would refuse this notice (the rate on file moved,
// the scalar/ledger structure changed, the plan was replaced or never
// recorded): the apply's OWN function decides (rate-review-apply.js
// monthlyRefusal), so the send preflight and the upcoming-charge projection
// cannot drift from the writer. Unreadable = refused (held).
async function monthlyRefused(dbh, notice, customer, today) {
  if (!customer) return true;
  const { monthlyRefusal } = require('./rate-review-apply')._private;
  try {
    return !!(await monthlyRefusal(dbh, { notice, customer, metadata: parseJson(notice.metadata, {}), today }));
  } catch (err) {
    logger.warn(`[rate-review-comms] monthly eligibility unreadable for notice ${notice.id}: ${err.message}`);
    return true;
  }
}

// Per-application notices the apply could not carry out: the plan line has
// no open application on or after the effective date, an application was
// repriced away from the noticed price, or the line's structure is one the
// apply refuses (a parked reschedule, a statusless visit, add-ons, a
// discount, prepaid money, several series, a replaced plan, an unrecorded
// series, a first visit already under way ...). The apply's OWN pure
// predicate decides (rate-review-apply.js perApplicationStructuralRefusal),
// so the two cannot drift. Returns Map(noticeId → the apply's hold reason);
// 'visits_unreadable' when the rows could not be read (held).
async function linesGoneFor(dbh, notices, { snapshots, today }) {
  const { loadLineOpenVisits, perApplicationStructuralRefusal, perApplicationTemplateRefusal } = require('./rate-review-apply')._private;
  const cadenceByNotice = new Map((snapshots || []).map((s) => [String(s.notice_id), s.cadence]));
  const gone = new Map();
  // An active plan hold that still covers the start day: the apply answers
  // plan_on_hold (every lane), so no start date is announced until it clears.
  const { planHoldCovers, addDaysYmd } = require('./rate-review-apply')._private;
  const customerIds = [...new Set(notices.map((n) => n.customer_id))];
  try {
    const holds = customerIds.length ? await dbh('plan_holds').whereIn('customer_id', customerIds).where({ status: 'active' }).select('customer_id', 'resume_on') : [];
    for (const n of notices) {
      // A prepaid amount is recorded the night after delivery and must be on the
      // term before the 30-day renewal reminder goes out (after that the apply
      // refuses with renewal_notice_already_sent), so a hold blocks it if it
      // lasts to that reminder day; every other lane starts on its effective date.
      const coverDay = n.billing_lane === 'annual_prepay' ? addDaysYmd(ymd(n.effective_date), -(MIN_NOTICE_DAYS + 1)) : ymd(n.effective_date);
      if (holds.some((h) => String(h.customer_id) === String(n.customer_id) && planHoldCovers(h, coverDay))) gone.set(String(n.id), 'plan_on_hold');
    }
  } catch (err) {
    logger.warn(`[rate-review-comms] plan holds unreadable: ${err.message}`);
    for (const n of notices) gone.set(String(n.id), 'visits_unreadable');
  }
  for (const n of notices.filter((x) => x.billing_lane === 'per_application' && !gone.has(String(x.id)))) {
    try {
      const meta = parseJson(n.metadata, {});
      const visits = (await loadLineOpenVisits(dbh, { customerId: n.customer_id, familyKey: n.family_key, cadence: cadenceByNotice.get(String(n.id)) || null, fromDate: ymd(n.effective_date) }))
        .filter((v) => !v.is_callback);
      const ids = visits.map((v) => v.id);
      const addonRows = ids.length ? await dbh('scheduled_service_addons').whereIn('scheduled_service_id', ids).select('scheduled_service_id') : [];
      const addonCounts = new Map();
      for (const a of addonRows) addonCounts.set(String(a.scheduled_service_id), (addonCounts.get(String(a.scheduled_service_id)) || 0) + 1);
      const linkedTermIds = [...new Set(visits.map((v) => v.annual_prepay_term_id).filter(Boolean))];
      const liveTermIds = new Set(linkedTermIds.length
        ? (await require('./annual-prepay-renewals').coveredTermsAsOf(dbh, today).whereIn('t.id', linkedTermIds).select('t.id')).map((t) => String(t.id))
        : []);
      const firstVisit = meta.first_visit_id ? await dbh('scheduled_services').where({ id: meta.first_visit_id }).first('id', 'status') : null;
      let reason = perApplicationStructuralRefusal({
        visits, addonCounts, liveTermIds, noticedCurrentCents: noticedCurrent(n), noticedRoot: meta.series_root_id, firstVisit, effectiveDate: ymd(n.effective_date),
      });
      // ...and the series template: the price-override gate, and a parent whose
      // recurring add-ons or discount would spawn later visits off the noticed price.
      if (!reason) {
        reason = await perApplicationTemplateRefusal(dbh, {
          visits, noticedNew: Number(n.noticed_new_cents ?? n.new_amount_cents), schedule: require('../routes/admin-schedule')._test,
        });
      }
      if (reason) gone.set(String(n.id), reason);
    } catch (err) {
      logger.warn(`[rate-review-comms] open visits unreadable for notice ${n.id}: ${err.message}`);
      gone.set(String(n.id), 'visits_unreadable');
    }
  }
  return gone;
}

// The live lane per unsent notice; an unreadable lane reads as null (held).
async function liveLanesFor(dbh, notices, { snapshots, customers, today, includeSent = false }) {
  const { resolveLiveLane } = require('./rate-review-apply')._private;
  const snapshotByNotice = new Map(snapshots.map((s) => [String(s.notice_id), s]));
  const customerById = new Map(customers.map((c) => [String(c.id), c]));
  const out = new Map();
  for (const n of notices) {
    if (n.sent_at && !includeSent) continue;
    const customer = customerById.get(String(n.customer_id));
    try {
      out.set(String(n.id), customer ? await resolveLiveLane(dbh, { customer, familyKey: n.family_key, cadence: snapshotByNotice.get(String(n.id))?.cadence || null, today }) : null);
    } catch (err) {
      logger.warn(`[rate-review-comms] live lane unreadable for notice ${n.id}: ${err.message}`);
      out.set(String(n.id), null);
    }
  }
  return out;
}

// ── batch read ─────────────────────────────────────────────────────────

// Only a notice no attempt ever handed to a provider is sendable. A send
// is single-shot: an attempt whose outcome is uncertain (the provider may
// have accepted it) is never retried automatically — it is held for the
// owner (send_uncertain, or a 'sending' claim gone stale after a crash).
const SENDABLE_STATUSES = ['draft', 'viewed', 'unreachable'];
function sendOutcomeUncertain(notice, now) {
  if (String(notice.status) === UNCERTAIN) return true;
  return String(notice.status) === 'sending' && new Date(notice.updated_at).getTime() < now.getTime() - CLAIM_STALE_MS;
}

function hasContact(customer, prefs) {
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {});
  const email = String(recipient?.email || '').trim();
  // A customer who turned texts off (notification_prefs.sms_enabled false)
  // has no text channel: the canonical sender would block it.
  return { email: email.includes('@'), sms: !!String(customer?.phone || '').trim() && prefs?.sms_enabled !== false };
}

// The notices' stored first visits (rate checks read their stamped price).
async function visitsById(dbh, notices) {
  const ids = notices.map((n) => parseJson(n.metadata, {}).first_visit_id).filter(Boolean);
  const visits = ids.length ? await dbh('scheduled_services').whereIn('id', ids).select('id', 'scheduled_date', 'status', 'estimated_price') : [];
  return new Map(visits.map((v) => [String(v.id), v]));
}

// Everything the line rules read for a set of notices and their ranking
// rows, fresh from the database. Used by the preview/send list (the whole
// batch) and by the send itself (one letter's claimed lines, re-read after
// the claim).
async function loadLineContext(dbh, { snapshots, notices, today }) {
  const customerIds = [...new Set(notices.map((n) => n.customer_id))];
  const customers = customerIds.length ? await dbh('customers').whereIn('id', customerIds) : [];
  const prefs = customerIds.length ? await dbh('notification_prefs').whereIn('customer_id', customerIds).catch(() => []) : [];
  const visitById = await visitsById(dbh, notices);
  const unsent = notices.filter((n) => !n.sent_at);
  return {
    snapshots: new Map(snapshots.map((s) => [String(s.notice_id), s])),
    notices,
    customers: new Map(customers.map((c) => [String(c.id), c])),
    prefs: new Map((prefs || []).map((p) => [String(p.customer_id), p])),
    declinedTerms: await declinedPrepayTermIds(dbh, notices),
    liveLanes: await liveLanesFor(dbh, notices, { snapshots, customers, today }),
    ratesMoved: await ratesMovedFor(dbh, unsent, { customers, visitById, today }),
    linesGone: await linesGoneFor(dbh, unsent, { snapshots, today }),
  };
}

async function loadBatch(dbh, batchKey, today) {
  const snapshots = await dbh('rate_review_snapshots').where({ batch_key: batchKey }).whereNotNull('notice_id');
  const approvedUnscheduled = await dbh('rate_review_snapshots')
    .where({ batch_key: batchKey, status: 'approved' })
    .whereNull('notice_id')
    .where('delta_cents', '>', 0)
    .select('id');
  const noticeIds = snapshots.map((s) => s.notice_id);
  const notices = noticeIds.length ? await dbh('price_change_notices').whereIn('id', noticeIds) : [];
  return { ...(await loadLineContext(dbh, { snapshots, notices, today })), unscheduled: approvedUnscheduled.length };
}

// Ordered suppression rules — the first that matches holds the line (or,
// for the account rules, the whole letter).
const LINE_RULES = [
  ['not_approved', ({ snapshot }) => !snapshot || String(snapshot.status) !== 'approved'],
  ['unsupported_line', ({ notice }) => !SERVICE_LABELS[notice.family_key]],
  ['renewal_declined', ({ notice, declinedTerms }) => declinedTerms.has(String(parseJson(notice.metadata, {}).term_id || ''))],
  // The account's live billing lane (rate-review-apply.js resolveLiveLane
  // — billing-lane.js resolveBillingLane plus the prepaid term) must still
  // be the lane the notice was priced for; anything else would announce a
  // change the apply refuses.
  ['lane_changed', ({ notice, liveLanes }) => liveLanes.get(String(notice.id)) !== notice.billing_lane],
  ['rate_moved', ({ notice, ratesMoved }) => ratesMoved.has(String(notice.id))],
  ['line_gone', ({ notice, linesGone }) => ['no_future_visit', 'rate_moved_since_notice', 'visits_unreadable'].includes(linesGone.get(String(notice.id)))],
  // Any other structure the apply's own guards refuse (see linesGoneFor):
  // the line would be announced and then held, so it is held here instead.
  ['apply_hold', ({ notice, linesGone }) => linesGone.has(String(notice.id))],
  ['invalid_amount', ({ line }) => !(line.currentCents > 0 && line.newCents > line.currentCents)],
  ['send_uncertain', ({ notice, now }) => sendOutcomeUncertain(notice, now)],
  ['in_flight', ({ notice }) => !SENDABLE_STATUSES.includes(String(notice.status))],
  // At least 30 days out from today, the delivery day; a prepaid renewal
  // 32 (the apply lane's own rule: the nightly apply must write the
  // successor amount before the 30-day renewal reminder goes out).
  ['too_late', ({ line, today }) => !line.effectiveDate || daysBetween(today, line.effectiveDate) < MIN_NOTICE_DAYS + (line.unit === 'year' ? 2 : 0)],
];
const ACCOUNT_RULES = [
  ['customer_inactive', ({ customer }) => !customer || !!customer.deleted_at || customer.active === false],
  ['too_many_lines', ({ entry }) => entry.lines.length > LINE_SLOTS],
  ['no_contact', ({ entry }) => !entry.channels.email && !entry.channels.sms],
];
const firstMatch = (rules, ctx) => (rules.find(([, test]) => test(ctx)) || [null])[0];

function planEntry(data, customerId, notices, { today, now }) {
  const customer = data.customers.get(customerId) || null;
  const entry = { customerId, customer, prefs: data.prefs.get(customerId) || null, name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer', lines: [], alreadySent: [], suppressedLines: [], reason: null, channels: { email: false, sms: false } };
  for (const notice of notices) {
    if (notice.sent_at) { entry.alreadySent.push(notice.id); continue; }
    const snapshot = data.snapshots.get(String(notice.id)) || null;
    const line = lineFor(notice, snapshot, customer);
    const reason = firstMatch(LINE_RULES, { notice, snapshot, line, today, now, declinedTerms: data.declinedTerms, liveLanes: data.liveLanes, ratesMoved: data.ratesMoved, linesGone: data.linesGone });
    if (reason) entry.suppressedLines.push({ noticeId: notice.id, reason, label: REASONS[reason], service: line.service, effectiveDate: line.effectiveDate, ...(reason === 'apply_hold' ? { applyReason: data.linesGone.get(String(notice.id)) } : {}) });
    else entry.lines.push({ ...line, notice });
  }
  // One order everywhere: the email, the frozen letter and the page.
  entry.lines.sort(byEffective);
  if (!entry.lines.length) return entry;
  if (customer) entry.channels = hasContact(customer, data.prefs.get(customerId));
  entry.reason = firstMatch(ACCOUNT_RULES, { customer, entry });
  return entry;
}

// One entry per customer. Lines whose own state bars them (late, already
// sent) are split out; the rest send together as one letter.
function planBatch(data, { today, now }) {
  const byCustomer = new Map();
  for (const notice of data.notices) {
    const key = String(notice.customer_id);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(notice);
  }
  return [...byCustomer].map(([customerId, notices]) => planEntry(data, customerId, notices, { today, now }))
    .sort((a, b) => a.customerId.localeCompare(b.customerId));
}

// The digest the send must match: per sendable letter, the exact words it
// would render now (cost block, dates, first application), the channels it
// goes out on, and the active template's content.
function digestFor(entries, costBlock, templateHash = null) {
  const h = crypto.createHash('sha256');
  h.update(`cost:${costBlock || ''}\ntemplate:${templateHash || ''}\n`);
  for (const e of entries) {
    if (e.reason || !e.lines.length) continue;
    const payload = letterPayload({ customer: e.customer, prefs: e.prefs, lines: e.lines, costBlock, noticeUrl: noticeUrlFor(e.lines) });
    const ids = e.lines.map((l) => `${l.noticeId}:${l.currentCents}:${l.newCents}:${l.effectiveDate}`).sort();
    h.update(`${e.customerId}|${ids.join(',')}|${e.channels.email ? 'E' : ''}${e.channels.sms ? 'S' : ''}|${JSON.stringify(payload)}\n`);
  }
  return h.digest('hex');
}

function summarize(entries) {
  const sendable = entries.filter((e) => !e.reason && e.lines.length);
  return {
    letters: sendable.length,
    lines: sendable.reduce((s, e) => s + e.lines.length, 0),
    email: sendable.filter((e) => e.channels.email).length,
    sms: sendable.filter((e) => e.channels.sms).length,
    suppressedCustomers: entries.filter((e) => e.reason && e.lines.length).length,
    suppressedLines: entries.reduce((s, e) => s + e.suppressedLines.length + (e.reason ? e.lines.length : 0), 0),
    alreadySent: entries.reduce((s, e) => s + e.alreadySent.length, 0),
  };
}

function assertBatchKey(batchKey) {
  if (!BATCH_KEY_RE.test(String(batchKey || ''))) throw badInput('batchKey must be YYYY-MM');
}

async function sendPreview(batchKey, { dbh = db, now = new Date() } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  assertBatchKey(batchKey);
  const [data, costBlock, templateHash] = await Promise.all([loadBatch(dbh, batchKey, etDateString(now)), loadCostBlock(dbh), letterTemplateHash()]);
  const entries = planBatch(data, { today: etDateString(now), now });
  return {
    ok: true,
    batchKey,
    digest: digestFor(entries, costBlock, templateHash),
    costBlockReady: !!costBlock,
    unscheduled: data.unscheduled,
    counts: summarize(entries),
    customers: entries.map((e) => ({
      customerId: e.customerId,
      name: e.name,
      channels: e.channels,
      reason: e.reason,
      reasonLabel: e.reason ? REASONS[e.reason] : null,
      lines: e.lines.map((l) => ({ noticeId: l.noticeId, service: l.service, now: l.now, new: l.new, effectiveDate: l.effectiveDate })),
      suppressedLines: e.suppressedLines,
      alreadySent: e.alreadySent.length,
      // The last attempt reached no channel (every leg blocked or no
      // contact): sendable again once the contact or preferences are fixed.
      lastAttemptUnreachable: e.lines.some((l) => String(l.notice.status) === 'unreachable'),
    })),
  };
}

// ── render ─────────────────────────────────────────────────────────────

// The active letter template's content hash: bound into the send digest
// and handed to the email library, which refuses a send whose template
// changed since the owner reviewed it. null = not installed.
async function letterTemplateHash() {
  const EmailTemplateLibrary = require('./email-template-library');
  const loaded = await EmailTemplateLibrary.loadTemplateByKey(TEMPLATE_KEY);
  if (!loaded?.template || String(loaded.template.status) !== 'active' || !loaded.activeVersion) return null;
  return EmailTemplateLibrary.templateContentHash(loaded.template, loaded.activeVersion);
}

async function renderLetter(payload) {
  const EmailTemplateLibrary = require('./email-template-library');
  const loaded = await EmailTemplateLibrary.loadTemplateByKey(TEMPLATE_KEY);
  const template = loaded?.template;
  const version = loaded?.activeVersion;
  if (!template || String(template.status) !== 'active' || !version) throw badInput('The rate review letter template is not installed', 503);
  const rendered = EmailTemplateLibrary.renderTemplate({ template, version, payload: { ...payload, company_phone: payload.company_phone || require('../constants/business').WAVES_SUPPORT_PHONE_DISPLAY } });
  return { subject: rendered.subject, html: rendered.html, text: rendered.text };
}

function noticeUrlFor(lines) {
  const primary = [...lines].sort((a, b) => (a.effectiveDate < b.effectiveDate ? -1 : 1))[0];
  return portalUrl(`/price-change/${primary.notice.notice_token}`);
}

/**
 * The letter for one ranking row's customer, rendered exactly as it would
 * send (all of the customer's sendable lines in the batch). 404 when the
 * row has no scheduled notice yet. Sends nothing.
 */
async function letterPreview(batchKey, rowId, { dbh = db, now = new Date() } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  assertBatchKey(batchKey);
  const row = await dbh('rate_review_snapshots').where({ id: rowId, batch_key: batchKey }).first();
  if (!row) throw badInput('Rate review row not found', 404);
  if (!row.notice_id) throw badInput('This row has no scheduled notice yet', 404);
  const [data, costBlock] = await Promise.all([loadBatch(dbh, batchKey, etDateString(now)), loadCostBlock(dbh)]);
  const entry = planBatch(data, { today: etDateString(now), now }).find((e) => e.customerId === String(row.customer_id));
  // A line already sent previews from its own (unsent) siblings; when none
  // is left to send, preview the row's own line so the owner still sees it.
  let lines = entry ? entry.lines : [];
  if (!lines.length) {
    const notice = data.notices.find((n) => String(n.id) === String(row.notice_id));
    if (!notice) throw badInput('This row has no scheduled notice yet', 404);
    lines = [{ ...lineFor(notice, row, data.customers.get(String(row.customer_id))), notice }];
  }
  const customer = data.customers.get(String(row.customer_id));
  const payload = letterPayload({ customer, prefs: data.prefs.get(String(row.customer_id)), lines, costBlock: costBlock || '[Cost block not written yet: write it in Settings before sending.]', noticeUrl: noticeUrlFor(lines) });
  const rendered = await renderLetter(payload);
  return { ok: true, subject: rendered.subject, html: rendered.html, costBlockReady: !!costBlock, suppressed: entry ? entry.reason : null };
}

function claimKeyFor(noticeIds) {
  return crypto.createHash('sha256').update([...noticeIds].map(String).sort().join(',')).digest('hex').slice(0, 16);
}

async function claimLines(dbh, entry) {
  const lines = entry.lines;
  const claimed = [];
  for (const l of lines) {
    // Under the shared notice-event lock (price-change-notices.js
    // lockNoticeEvent — the legacy batch and the scheduler take it too).
    // ...and the customer-comms fence (merge / merge-undo repoint notices
    // under it): the claim only lands while the notice still belongs to the
    // customer this letter was built for. Not held through the provider
    // call — the SMS sender takes the same fence on its own connection.
    const n = await dbh.transaction(async (trx) => {
      await lockCustomerComms(trx, entry.customerId);
      await PriceChangeNotices.lockNoticeEvent(trx, { customerId: l.notice.customer_id, effectiveDate: l.effectiveDate, currentCents: l.notice.current_amount_cents, newCents: l.notice.new_amount_cents });
      return trx('price_change_notices')
        .where({ id: l.noticeId, customer_id: entry.customerId })
        .whereNull('sent_at')
        .whereIn('status', SENDABLE_STATUSES)
        .update({ status: 'sending', updated_at: new Date() });
    });
    if (!n) {
      if (claimed.length) await dbh('price_change_notices').whereIn('id', claimed).where({ status: 'sending' }).update({ status: 'draft', updated_at: new Date() });
      return null;
    }
    claimed.push(l.noticeId);
  }
  return claimed;
}

function frozenLetter(entry, payload, costBlock) {
  return {
    first_name: payload.first_name,
    cost_block: costBlock,
    lines: entry.lines.map((l) => ({
      notice_id: l.noticeId, family_key: l.familyKey, service: l.serviceLabel, unit: l.unit,
      current_cents: l.currentCents, new_cents: l.newCents, effective_date: l.effectiveDate,
      first_label: l.firstLabel, first: l.first, why: l.why,
      per_application_current_cents: l.perApplicationCurrentCents || null, per_application_new_cents: l.perApplicationNewCents || null,
      term_end: l.termEnd || null,
    })),
  };
}

// Freeze the letter on the claimed rows BEFORE any provider call: if the
// outcome turns out uncertain, the public page still shows exactly what
// that email said (only a delivered message carries the token).
async function freezeLetter(dbh, entry, frozen) {
  for (const l of entry.lines) {
    const meta = parseJson(l.notice.metadata, {});
    await dbh('price_change_notices').where({ id: l.noticeId, status: 'sending' }).update({ metadata: JSON.stringify({ ...meta, pending_letter: frozen }) });
  }
}

// hold: a named reason the send was refused before any provider took it
// (recorded on each line as metadata.send_hold; the next attempt clears it).
async function settleLines(dbh, entry, { status, keepFrozen, frozen, hold = null }) {
  for (const l of entry.lines) {
    const { pending_letter: _p, send_hold: _h, ...meta } = parseJson(l.notice.metadata, {});
    const next = { ...meta, ...(keepFrozen ? { pending_letter: frozen } : {}), ...(hold ? { send_hold: { reason: hold, at: new Date().toISOString() } } : {}) };
    await dbh('price_change_notices').where({ id: l.noticeId, status: 'sending' }).update({
      status, metadata: JSON.stringify(next), updated_at: new Date(),
    });
  }
}

async function stillOwned(dbh, noticeIds, customerId) {
  const rows = await dbh('price_change_notices').whereIn('id', noticeIds).select('id', 'customer_id');
  return rows.length === noticeIds.length && rows.every((r) => String(r.customer_id) === String(customerId));
}

// The text pointer's named holds: the canonical sender's refusal code from the
// ownership/recipient re-read held through its provider request.
const SMS_HOLD_REASONS = {
  NOTICE_REPOINTED: 'notice_repointed',
  RECIPIENT_PHONE_CHANGED: 'recipient_phone_changed',
  RECIPIENT_UNAVAILABLE: 'recipient_unavailable',
};

const phoneKey = (p) => { const e = toE164(String(p || '').trim()); return e ? String(e).replace(/\D/g, '') : ''; };

// Run INSIDE the customer-comms + phone fence, immediately before the Twilio
// request: the notice must still belong to the letter's customer and that
// customer must still own the number being texted. null = clear to send.
async function smsHandoffRefusal(trx, noticeIds, customerId, phone) {
  if (!(await stillOwned(trx, noticeIds, customerId))) {
    return { ok: false, code: 'NOTICE_REPOINTED', reason: 'the notice no longer belongs to this customer', retryable: false };
  }
  const live = await trx('customers').where({ id: customerId }).first();
  if (!live || live.deleted_at || live.active === false) {
    return { ok: false, code: 'RECIPIENT_UNAVAILABLE', reason: 'the customer is no longer active', retryable: false };
  }
  if (!phoneKey(phone) || phoneKey(live.phone) !== phoneKey(phone)) {
    return { ok: false, code: 'RECIPIENT_PHONE_CHANGED', reason: 'the number on file is no longer the one this text was built for', retryable: false };
  }
  return null;
}

// Rules about the notice's send state, not its eligibility: a claimed line
// is 'sending' by construction.
const CLAIM_STATE_RULES = new Set(['send_uncertain', 'in_flight']);

// After the claim lands, the line rules run again against the CURRENT rows
// (the same loaders the preview used): a plan, rate, lane or structure
// change that committed between the preview read and the claim holds the
// letter instead of being sent on stale amounts. ok:false → the reason to
// release the claim with; ok:true → the lines rebuilt from the fresh rows.
async function revalidateClaimed(dbh, entry, claimed, { today, now }) {
  const notices = await dbh('price_change_notices').whereIn('id', claimed);
  const snapshots = await dbh('rate_review_snapshots').whereIn('notice_id', claimed);
  const ctx = await loadLineContext(dbh, { snapshots, notices, today });
  const customer = ctx.customers.get(String(entry.customerId)) || null;
  const rules = LINE_RULES.filter(([name]) => !CLAIM_STATE_RULES.has(name));
  const lines = [];
  for (const planned of entry.lines) {
    const notice = notices.find((n) => String(n.id) === String(planned.noticeId));
    if (!notice || String(notice.customer_id) !== String(entry.customerId)) return { ok: false, reason: 'notice_repointed' };
    const snapshot = ctx.snapshots.get(String(notice.id)) || null;
    const line = lineFor(notice, snapshot, customer);
    const reason = firstMatch(rules, { notice, snapshot, line, today, now, declinedTerms: ctx.declinedTerms, liveLanes: ctx.liveLanes, ratesMoved: ctx.ratesMoved, linesGone: ctx.linesGone });
    if (reason) return { ok: false, reason };
    // The reviewed words: amounts and date must be the ones the owner's
    // preview digest covered.
    if (line.currentCents !== planned.currentCents || line.newCents !== planned.newCents || line.effectiveDate !== planned.effectiveDate) return { ok: false, reason: 'line_changed' };
    lines.push({ ...line, notice });
  }
  lines.sort(byEffective);
  return { ok: true, entry: { ...entry, lines } };
}

async function sendEntry(dbh, originalEntry, { batchKey, costBlock, templateHash, actorId, clock }) {
  let entry = originalEntry;
  const claimed = await claimLines(dbh, entry);
  if (!claimed) return { outcome: 'in_flight' };
  // The recipient is re-read after the claim (a corrected address or phone
  // since the preview is the one used): the letter and both legs are built
  // from the live row. A customer gone inactive meanwhile releases the
  // claim untouched.
  const customer = await dbh('customers').where({ id: entry.customerId }).first();
  if (!customer || customer.deleted_at || customer.active === false) {
    await dbh('price_change_notices').whereIn('id', claimed).where({ status: 'sending' }).update({ status: 'draft', updated_at: new Date() });
    return { outcome: 'in_flight' };
  }
  // The ET delivery day is read NOW, not at batch start: a batch that crosses
  // Eastern midnight must judge the 30-day floor (and everything else) on the
  // day this letter is actually handed to a provider, the day the apply will
  // measure from sent_at.
  const now = clock();
  const today = etDateString(now);
  const fresh = await revalidateClaimed(dbh, entry, claimed, { today, now });
  if (!fresh.ok) {
    await settleLines(dbh, entry, { status: 'draft', keepFrozen: false, frozen: null, hold: fresh.reason });
    return { outcome: 'in_flight', holdReason: fresh.reason };
  }
  entry = fresh.entry;
  const claimKey = claimKeyFor(claimed);
  // The billing recipient is resolved BEFORE the payload is built, digested
  // and frozen, so the greeting in the frozen letter and the public page is the
  // one the email carries.
  const prefs = await dbh('notification_prefs').where({ customer_id: entry.customerId }).first().catch(() => null);
  const payload = letterPayload({ customer, prefs, lines: entry.lines.map((l) => ({ ...l, service: [l.serviceLabel, propertyStreetLine(customer)].filter(Boolean).join(' · ') })), costBlock, noticeUrl: noticeUrlFor(entry.lines) });
  const frozen = { key: claimKey, payload, letter: frozenLetter(entry, payload, costBlock) };
  await freezeLetter(dbh, entry, frozen);
  // Ownership is re-read right before each provider leg: a merge undo
  // that repointed a claimed notice stops the send (the fence itself can't
  // be held across the call — the SMS sender takes it on its own
  // connection, which would deadlock).
  if (!(await stillOwned(dbh, claimed, entry.customerId))) {
    await settleLines(dbh, entry, { status: 'draft', keepFrozen: false, frozen });
    return { outcome: 'in_flight' };
  }
  // Last look at the clock before the first provider call: crossing ET midnight
  // between the revalidation and here still holds a line exactly at the floor.
  {
    const dispatchDay = etDateString(clock());
    if (dispatchDay !== today) {
      const late = entry.lines.find((l) => daysBetween(dispatchDay, l.effectiveDate) < MIN_NOTICE_DAYS + (l.unit === 'year' ? 2 : 0));
      if (late) {
        await settleLines(dbh, entry, { status: 'draft', keepFrozen: false, frozen, hold: 'too_late' });
        return { outcome: 'in_flight', holdReason: 'too_late' };
      }
    }
  }
  // Set when the handoff refused before dispatch: the request never left, so
  // the letter is definitively unsent (a named hold, not an uncertain send).
  let emailHold = null;
  const email = await PriceChangeNotices.sendNoticeEmail({
    customer,
    idempotencyKeyBase: `rate_review:${batchKey}:${entry.customerId}:${claimKey}`,
    vars: payload,
    templateKey: TEMPLATE_KEY,
    categories: ['billing', 'rate_review_notice'],
    sendOptions: {
      expectedContentHash: templateHash,
      // The email leg's provider call runs under the customer-comms fence,
      // with notice ownership AND the recipient address re-read inside it: a
      // merge undo can never repoint a notice, and a corrected email or
      // billing contact can never be overtaken, between that check and the
      // dispatch. `to` is the address this send resolved.
      withProviderHandoff: (dispatch, { to } = {}) => dbh.transaction(async (trx) => {
        await lockCustomerComms(trx, entry.customerId);
        if (!(await stillOwned(trx, claimed, entry.customerId))) { emailHold = 'notice_repointed'; return { ok: false, reason: 'notice_repointed' }; }
        // Rows first (a contact writer holds the customer row, then the
        // address key), then the address key, held through the request.
        const live = await trx('customers').where({ id: entry.customerId }).whereNull('deleted_at').forShare().first();
        const prefs = await trx('notification_prefs').where({ customer_id: entry.customerId }).forShare().first();
        if (!live || live.active === false) { emailHold = 'recipient_unavailable'; return { ok: false, reason: 'recipient_unavailable' }; }
        if (!to) { emailHold = 'recipient_changed'; return { ok: false, reason: 'recipient_changed' }; }
        await lockCustomerEmail(trx, to);
        const [recipient] = getInvoiceEmailRecipients(live, prefs || {});
        if (!to || String(recipient?.email || '').trim().toLowerCase() !== String(to).trim().toLowerCase()) { emailHold = 'recipient_changed'; return { ok: false, reason: 'recipient_changed' }; }
        await dispatch(trx);
        return { ok: true };
      }),
    },
  });
  const smsPhone = String(customer.phone || '').trim();
  const sms = await PriceChangeNotices.sendNoticeSms({
    customer,
    // Delivery evidence is provider acceptance only: a sender that answers
    // sent with deliveryOutcome not_sent (SMS gate off, owner silence) or
    // uncertain must not stamp sent_at — the nightly apply reads that as
    // the customer having been told.
    requireAccepted: true,
    vars: { effective_date: payload.effective_date, price_change_url: payload.notice_url },
    actorId,
    // Whether the customer HAS an email leg (an address on file), not whether
    // it succeeded: the canonical consent gate enforces an email-only channel
    // choice only when the paired email leg is declared, so a failed email
    // must never open the fallback text for an email-preferring customer.
    hasEmailLeg: hasContact(customer, prefs).email,
    operatorInitiated: true,
    sendOptions: {
      // Marks the lane for the canonical sender's locked SMS handoff.
      metadata: { rate_review_letter: true },
      // Early, cheap abort before provider preparation (not the last word).
      preDispatchCheck: async () => ((await stillOwned(dbh, claimed, entry.customerId))
        ? { ok: true } : { ok: false, code: 'NOTICE_REPOINTED', reason: 'the notice no longer belongs to this customer' }),
      // The authoritative check: the customer-comms + phone fence (the order
      // every SMS authority takes) is held through the Twilio request, and
      // notice ownership plus the recipient phone are re-read inside it. A
      // merge undo or a number change that commits first fails the send
      // closed with a named code; one that arrives later waits for the
      // request. A notice token therefore never texts a previous customer.
      withSmsHandoff: (dispatch) => withSmsConsentLock(dbh, { phone: smsPhone, customerId: entry.customerId }, async (trx) => {
        const refusal = await smsHandoffRefusal(trx, claimed, entry.customerId, smsPhone);
        return refusal || dispatch(trx);
      }),
    },
  });
  const smsHold = SMS_HOLD_REASONS[sms.blockedCode] || null;
  if (smsHold) logger.warn(`[rate-review-comms] text pointer withheld for customer ${entry.customerId}: ${smsHold}`);
  if (!email.sent && !sms.sent) {
    // Never handed to a provider (no contact, every leg policy-blocked):
    // definitively unsent — parks as unreachable, words dropped, retirable
    // and sendable again. Attempted (a provider or template failure that
    // may still have delivered): held as send_uncertain with its words, for
    // the owner — never auto-retried, never retired.
    // A definite rejection from the email library (unconfigured, a hard
    // provider refusal) is a certain non-send: retryable, not ambiguous.
    const emailRejected = !!email.definiteNonSend && !emailHold;
    // ...and so is a text that failed in preparation (template missing or
    // inactive, rendering threw): the sender was never called.
    const smsNotPrepared = !!sms.definiteNonSend;
    const attempted = (email.attempted && !emailHold && !emailRejected) || (sms.attempted && !smsNotPrepared);
    const holdReason = emailHold || (emailRejected ? 'email_rejected' : null) || (smsNotPrepared ? 'sms_not_prepared' : null) || smsHold;
    // Nothing reached a provider and a leg was refused inside the fence
    // because the notice moved or the recipient changed: released to draft
    // with the named reason (the preview recomputes who it belongs to) —
    // never parked unreachable.
    if (holdReason && !attempted) {
      await settleLines(dbh, entry, { status: 'draft', keepFrozen: false, frozen, hold: holdReason });
      return { outcome: emailRejected || smsNotPrepared ? 'rejected' : 'in_flight', holdReason };
    }
    await settleLines(dbh, entry, { status: attempted ? UNCERTAIN : 'unreachable', keepFrozen: attempted, frozen, hold: holdReason });
    return { outcome: attempted ? 'uncertain' : 'unreachable' };
  }
  const sentAt = clock();
  // Every line of one letter is stamped together, under the customer-comms
  // fence: a merge or merge undo (which repoints notices under it) either
  // commits before the stamp, which then sees it, or waits for the stamp.
  const orphaned = [];
  await dbh.transaction(async (trx) => {
    await lockCustomerComms(trx, entry.customerId);
    for (const l of entry.lines) {
      const { pending_letter: _p, send_hold: _h, ...meta } = parseJson(l.notice.metadata, {});
      const stamped = await trx('price_change_notices').where({ id: l.noticeId, status: 'sending', customer_id: entry.customerId }).update({
        status: 'sent', sent_at: sentAt, email_sent: !!email.sent, sms_sent: !!sms.sent,
        metadata: JSON.stringify({ ...meta, ...(smsHold ? { sms_withheld: smsHold } : {}), letter: { ...frozen.letter, sent_on: etDateString(sentAt) } }), updated_at: sentAt,
      });
      if (stamped) {
        await trx('rate_review_snapshots').where({ notice_id: l.noticeId, status: 'approved' }).update({ status: 'sent', updated_at: sentAt });
      } else {
        orphaned.push(l);
      }
    }
    // Delivered, but the notice moved to another customer after the provider
    // took it (a merge undo): never reported sent and never left 'sending' —
    // held as send_uncertain with the words and the fact recorded, for the owner.
    for (const l of orphaned) {
      const { pending_letter: _p, send_hold: _h, ...meta } = parseJson(l.notice.metadata, {});
      await trx('price_change_notices').where({ id: l.noticeId, status: 'sending' }).update({
        status: UNCERTAIN, updated_at: sentAt,
        metadata: JSON.stringify({ ...meta, pending_letter: frozen, delivered_repointed: { at: sentAt.toISOString(), letter_customer_id: String(entry.customerId) } }),
      });
    }
  });
  if (orphaned.length) {
    logger.error(`[rate-review-comms] letter to customer ${entry.customerId} was delivered but ${orphaned.length} notice(s) moved to another customer before the stamp — held as ${UNCERTAIN}`);
    return { outcome: 'uncertain', holdReason: 'delivered_repointed', delivered: entry.lines.length - orphaned.length };
  }
  return { outcome: 'sent', email: !!email.sent, sms: !!sms.sent };
}

/**
 * Send a batch's letters. Refuses unless the digest matches the preview the
 * owner reviewed (same customers, lines, amounts, dates and cost block).
 * Returns { ok, sent, emailed, texted, unreachable, failed, inFlight,
 * suppressed, stoppedByGate }.
 */
async function sendBatch(batchKey, { expectedDigest, actorId = null, dbh = db, now: suppliedNow = null, clock: suppliedClock = null } = {}) {
  // `now` pins the clock (tests, replays); otherwise each letter reads the real
  // clock when it is dispatched. `clock` lets a caller supply its own.
  const clock = suppliedClock || (suppliedNow ? () => suppliedNow : () => new Date());
  const now = clock();
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  assertBatchKey(batchKey);
  const [data, costBlock, templateHash] = await Promise.all([loadBatch(dbh, batchKey, etDateString(now)), loadCostBlock(dbh), letterTemplateHash()]);
  if (!costBlock) return { ok: false, reason: 'cost_block_missing' };
  if (!templateHash) throw badInput('The rate review letter template is not installed', 503);
  const entries = planBatch(data, { today: etDateString(now), now });
  if (String(expectedDigest || '') !== digestFor(entries, costBlock, templateHash)) return { ok: false, reason: 'list_changed' };
  const sendable = entries.filter((e) => !e.reason && e.lines.length);
  if (!sendable.length) return { ok: false, reason: 'nothing_to_send' };
  await renderLetter(letterPayload({ customer: sendable[0].customer, prefs: sendable[0].prefs, lines: sendable[0].lines, costBlock, noticeUrl: portalUrl('/') })); // template installed?

  const summary = { sent: 0, emailed: 0, texted: 0, unreachable: 0, uncertain: 0, failed: 0, inFlight: 0, stoppedByGate: 0, suppressed: entries.filter((e) => e.reason && e.lines.length).length };
  for (let i = 0; i < sendable.length; i += SEND_CONCURRENCY) {
    await Promise.all(sendable.slice(i, i + SEND_CONCURRENCY).map(async (entry) => {
      if (!rateReviewLive()) { summary.stoppedByGate += 1; return; }
      try {
        const res = await sendEntry(dbh, entry, { batchKey, costBlock, templateHash, actorId, clock });
        if (res.outcome === 'sent') {
          summary.sent += 1;
          if (res.email) summary.emailed += 1;
          if (res.sms) summary.texted += 1;
        } else if (res.outcome === 'in_flight') summary.inFlight += 1;
        else if (res.outcome === 'rejected') {
          // A definite provider refusal: nothing was sent and the lines are back to draft with the reason.
          summary.failed += 1;
          logger.error(`[rate-review-comms] email letter rejected for customer ${entry.customerId}: ${res.holdReason}`);
        } else if (res.outcome === 'unreachable') summary.unreachable += 1;
        else summary.uncertain += 1;
      } catch (err) {
        summary.failed += 1;
        logger.error(`[rate-review-comms] letter failed for customer ${entry.customerId}: ${err.message}`);
      }
    }));
  }

  try {
    await dbh('activity_log').insert({
      admin_user_id: actorId || null,
      action: 'rate_review_letters_sent',
      description: `Rate review ${batchKey}: ${summary.sent} letter(s) sent (${summary.emailed} emailed, ${summary.texted} texted), ${summary.unreachable} unreachable, ${summary.uncertain} uncertain (held for review), ${summary.failed} failed, ${summary.suppressed} suppressed.`,
      metadata: JSON.stringify({ batch_key: batchKey, summary }),
    });
  } catch (logErr) {
    logger.warn(`[rate-review-comms] activity log failed for ${batchKey}: ${logErr.message}`);
  }
  logger.info(`[rate-review-comms] ${batchKey}: ${JSON.stringify(summary)}`);
  return { ok: summary.failed === 0 && summary.uncertain === 0 && summary.stoppedByGate === 0, batchKey, ...summary };
}

// ── customer surfaces ──────────────────────────────────────────────────

// The frozen letter's lines as the public page and the portal show them.
function publicLines(letter) {
  return (letter?.lines || []).map((l) => ({
    service: l.service || null,
    unit: l.unit,
    current: money(l.current_cents),
    next: money(l.new_cents),
    change: money(Number(l.new_cents) - Number(l.current_cents)),
    perApplicationCurrent: l.per_application_current_cents ? money(l.per_application_current_cents) : null,
    perApplicationNext: l.per_application_new_cents ? money(l.per_application_new_cents) : null,
    effectiveDate: dateLabel(l.effective_date),
    firstLabel: l.first_label || null,
    first: l.first || null,
    why: l.why || null,
  }));
}

/**
 * Notice page v2 payload for a rate-review notice (null for a legacy
 * monthly-batch notice). Only a DELIVERED notice renders — a draft's letter
 * is not customer-facing yet.
 */
function publicReview(notice) {
  if (!notice?.rate_review_row_id) return null;
  const meta = parseJson(notice.metadata, {});
  // Delivered: the letter frozen at send. Not stamped but handed to a
  // provider (send_uncertain / a claim mid-send): the words frozen before
  // the provider call — only a delivered message carries this token, so
  // the link the customer holds keeps working. Anything else is a 404.
  const letter = notice.sent_at ? meta.letter : meta.pending_letter?.letter;
  if (!notice.sent_at && !letter) return { unavailable: true };
  // Delivered without a frozen letter (a notice stamped by another
  // sender): the plain notice page, never a 404 for a received link.
  if (!letter || !Array.isArray(letter.lines) || !letter.lines.length) return notice.sent_at ? null : { unavailable: true };
  const lines = publicLines(letter);
  return {
    firstName: letter.first_name || null,
    costBlock: letter.cost_block || null,
    lines,
    hasPrepay: lines.some((l) => l.unit === 'year'),
    delivered: !!notice.sent_at,
  };
}

// The next automatic charge at the new rate, when one can be stated
// exactly: only the monthly dues — the account's whole debit (its dues
// moved by every pending monthly increase in force by then, what
// applyMonthly writes) on the first billing day on/after the effective
// date (the cron charges on the CURRENT billing_day). A per-application
// charge depends on what else that visit bills (combined visit invoices)
// and a prepaid renewal is recorded by the office — neither is announced.
function chargeAtNewRate(notice, { monthly, customer }) {
  if (notice.billing_lane !== 'monthly_membership' || !monthly.some((o) => o.id === notice.id)) return { chargeCents: null, chargeDate: null };
  const dues = Math.round(Number(customer?.monthly_rate || 0) * 100);
  if (!(dues > 0)) return { chargeCents: null, chargeDate: null };
  const { nextBillingDayOnOrAfter } = require('./rate-review-apply')._private;
  const chargeDate = nextBillingDayOnOrAfter(ymd(notice.effective_date), customer.billing_day);
  // Every pending monthly increase in force by that debit moves the dues.
  const delta = monthly
    .filter((o) => ymd(o.effective_date) <= chargeDate)
    .reduce((sum, o) => sum + Number(o.noticed_new_cents ?? o.new_amount_cents) - Number(o.noticed_current_cents ?? o.current_amount_cents), 0);
  return { chargeCents: dues + delta, chargeDate };
}

// Monthly notices the nightly apply would still write: delivered in time,
// and the lane's live
// rate (re-read the way applyMonthly reads it — the family's ledger slices
// for a ledger-priced line, else the account dues) still equals the noticed
// current rate. A rate moved since the notice holds there, so no charge at
// the new rate is announced for it.
async function applicableMonthly(dbh, rows, customer, today) {
  const out = [];
  for (const n of rows.filter((r) => r.billing_lane === 'monthly_membership')) {
    // ...and the delivery preceded the effective date by the 30 days the
    // apply enforces from sent_at (a later stamp holds there).
    const noticedInTime = n.sent_at && daysBetween(etDateString(new Date(n.sent_at)), ymd(n.effective_date)) >= MIN_NOTICE_DAYS;
    if (noticedInTime && !(await monthlyRefused(dbh, n, customer, today))) out.push(n);
  }
  return out;
}

/**
 * Portal billing line: the customer's delivered, not-yet-applied rate
 * changes — the upcoming rate and the next charge at it. [] when the gate
 * is off or nothing is pending.
 */
async function upcomingRateChanges(customerId, { dbh = db, now = new Date() } = {}) {
  if (!rateReviewLive() || !customerId) return [];
  const today = etDateString(now);
  const rows = await dbh('price_change_notices')
    .where({ customer_id: customerId })
    .whereNotNull('rate_review_row_id')
    .whereNotNull('sent_at')
    .whereIn('status', ['sent', 'viewed'])
    .where('effective_date', '>=', today)
    .orderBy('effective_date', 'asc');
  // A prepaid notice is "applied" the night after delivery (the successor
  // term's amount is written then), but the customer's rate only changes at
  // renewal — it stays upcoming until its effective date. Every other lane
  // drops off once the nightly apply writes the new rate.
  const customer = rows.length ? await dbh('customers').where({ id: customerId }).first('id', 'monthly_rate', 'billing_day', 'billing_mode', 'waveguard_tier') : null;
  const declinedTerms = await declinedPrepayTermIds(dbh, rows);
  // A change the nightly apply is holding (apply_hold_reason) is not a
  // guaranteed rate — not shown until it applies or the hold clears.
  const pending = rows.filter((n) => !n.apply_hold_reason && (!n.applied_at || n.billing_lane === 'annual_prepay')
    && !declinedTerms.has(String(parseJson(n.metadata, {}).term_id || '')));
  // Every lane: the account's live billing lane must still be the notice's
  // (the apply's billing_lane_changed). Read first, so a notice the apply
  // would reject never counts toward another family's cumulative charge.
  // The linked ranking rows carry each notice's reviewed cadence: a second
  // same-family series at another cadence must not hide a delivered notice.
  const pendingIds = pending.map((n) => n.id);
  const snapshots = pendingIds.length ? await dbh('rate_review_snapshots').whereIn('notice_id', pendingIds).select('notice_id', 'cadence') : [];
  const lanes = await liveLanesFor(dbh, pending, { snapshots, customers: customer ? [customer] : [], today, includeSent: true });
  const laneEligible = pending.filter((n) => lanes.get(String(n.id)) === n.billing_lane);
  const monthly = await applicableMonthly(dbh, laneEligible, customer, today);
  // A change the apply would refuse is not upcoming at all: monthly (rate
  // moved, or delivered too late); per application (its first visit's
  // stamped price moved). A prepaid term's amount is checked by the apply
  // the night after delivery and holds there (apply_hold_reason above).
  const applicable = new Set(monthly.map((n) => String(n.id)));
  const perApp = pending.filter((n) => n.billing_lane === 'per_application');
  // A prepaid notice the nightly apply has not yet recorded is judged by the
  // same checks; once recorded (applied_at) it stays upcoming until renewal.
  const unappliedPrepay = pending.filter((n) => n.billing_lane === 'annual_prepay' && !n.applied_at);
  const moved = await ratesMovedFor(dbh, [...perApp, ...unappliedPrepay], { customers: customer ? [customer] : [], visitById: await visitsById(dbh, perApp), today });
  // Per-application structure, and (every lane) an active plan hold the apply
  // would answer with plan_on_hold. An applied prepaid notice is already recorded.
  const gone = await linesGoneFor(dbh, pending.filter((n) => !n.applied_at), { snapshots, today });
  for (const id of gone.keys()) moved.add(id);
  return pending.filter((n) => lanes.get(String(n.id)) === n.billing_lane && !(gone.get(String(n.id)) === 'plan_on_hold')
    && (n.billing_lane === 'monthly_membership' ? applicable.has(String(n.id)) : !moved.has(String(n.id)))).map((n) => ({
    service: SERVICE_LABELS[n.family_key] || null,
    unit: unitFor(n),
    current: money(n.noticed_current_cents ?? n.current_amount_cents),
    next: money(n.noticed_new_cents ?? n.new_amount_cents),
    ...chargeAtNewRate(n, { monthly, customer }),
    effectiveDate: ymd(n.effective_date),
    noticePath: `/price-change/${n.notice_token}`,
  }));
}

// A prepaid term with a renewal decision recorded, or cancelled, never
// renews at the noticed amount — not sent, not upcoming.
async function declinedPrepayTermIds(dbh, rows) {
  const termIds = rows.filter((n) => n.billing_lane === 'annual_prepay').map((n) => parseJson(n.metadata, {}).term_id).filter(Boolean);
  if (!termIds.length) return new Set();
  const terms = await dbh('annual_prepay_terms').whereIn('id', termIds).select('id', 'customer_id', 'status', 'renewal_decision', 'term_end', 'coverage_service_type');
  // Any recorded renewal decision (cancel, switch_plan, …) means the term
  // does not renew at the noticed amount — the apply holds on it too
  // (term_not_live).
  const { successorTermExists } = require('./rate-review-apply')._private;
  // The notice's own plan line is the family fallback for a legacy term
  // with no coverage label (the apply's own guard passes it too).
  const familyByTerm = new Map(rows.filter((n) => n.billing_lane === 'annual_prepay').map((n) => [String(parseJson(n.metadata, {}).term_id || ''), n.family_key]));
  const out = new Set();
  for (const t of terms) {
    // A successor term already on the books (a renewal recorded — at the
    // noticed amount or, through the staff override, another) is the
    // renewal: the notice is history, not an upcoming rate.
    if ((t.renewal_decision != null && String(t.renewal_decision) !== '') || String(t.status) === 'cancelled'
      || await successorTermExists(dbh, t, familyByTerm.get(String(t.id)) || null)) out.add(String(t.id));
  }
  return out;
}

module.exports = {
  TEMPLATE_KEY,
  sendPreview,
  letterPreview,
  sendBatch,
  publicReview,
  upcomingRateChanges,
  _private: { whyFor, lineFor, letterPayload, planBatch, digestFor, linesGoneFor, REASONS, SERVICE_LABELS, LINE_SLOTS },
};
