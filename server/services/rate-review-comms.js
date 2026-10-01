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
const PriceChangeNotices = require('./price-change-notices');

const TEMPLATE_KEY = 'billing.rate_review_notice';
const LINE_SLOTS = 4;
const MIN_NOTICE_DAYS = PriceChangeNotices.MIN_NOTICE_DAYS;
const SEND_CONCURRENCY = 5;
const CLAIM_STALE_MS = 15 * 60 * 1000;
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
  too_late: `Effective date is under ${MIN_NOTICE_DAYS} days away — reschedule the notices`,
  invalid_amount: 'New rate is not above the current rate',
  unsupported_line: 'Service line has no letter wording',
  too_many_lines: `More than ${LINE_SLOTS} reviewed lines on one account`,
  no_contact: 'No email or phone on file',
  in_flight: 'A send for this customer is in progress',
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

function firstName(customer) {
  return String(customer?.first_name || '').trim().split(/\s+/)[0] || 'there';
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

// "Why your rate specifically" — only stored facts: the ranking row's
// usable visits and treatment minutes, and today's new-customer list price.
function whyFor(notice, snapshot) {
  const parts = [];
  const visits = Number(snapshot?.usable_visits) || 0;
  const minutes = Math.round(Number(snapshot?.treatment_minutes_median) || 0);
  if (visits >= 2 && minutes > 0) {
    parts.push(`Over the past year our records show ${visits} applications at your home, about ${minutes} minutes of treatment each.`);
  }
  const unit = unitFor(notice);
  const current = Number(snapshot?.current_rate_cents) || 0;
  const proposed = Number(snapshot?.proposed_rate_cents) || 0;
  const list = Number(snapshot?.list_rate_cents) || 0;
  const perUnit = unit === 'year' ? 'application' : unit;
  if (list > 0 && current > 0 && perUnit === 'application') {
    if (current < list) {
      parts.push(`At ${money(current)} per application, that is below what we charge a new customer for the same service today (${money(list)}).`);
      if (proposed === list) parts.push('The new rate brings you to that number, and not a dollar over it.');
      else if (proposed < list) parts.push(`I am moving it part of the way this year, to ${money(proposed)}, and you stay under the new-customer rate.`);
      else parts.push(`The new rate of ${money(proposed)} keeps pace with the costs above.`);
    } else {
      parts.push(`Your current rate of ${money(current)} per application is in line with what we charge a new customer for the same service today (${money(list)}). This change keeps pace with the costs above.`);
    }
  } else {
    parts.push('This change keeps pace with the costs above.');
  }
  return parts.join(' ');
}

function lineFor(notice, snapshot, customer, firstVisitDay) {
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
    // The stored first visit only while it is still a live visit on or
    // after the effective date (the apply reprices exactly those); else
    // the date the rule itself states.
    first: firstVisitDay ? dateLabel(firstVisitDay) : `on or after ${dateLabel(effective)}`,
    why: whyFor(notice, snapshot),
  };
}

// The email payload (and the frozen page content) for one customer's lines.
function letterPayload({ customer, lines, costBlock, noticeUrl }) {
  const ordered = [...lines].sort(byEffective);
  const payload = {
    first_name: firstName(customer),
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

// ── batch read ─────────────────────────────────────────────────────────

function claimable(notice, now) {
  if (notice.sent_at) return false;
  if (['draft', 'viewed', 'unreachable'].includes(String(notice.status))) return true;
  return String(notice.status) === 'sending' && new Date(notice.updated_at).getTime() < now.getTime() - CLAIM_STALE_MS;
}

function hasContact(customer, prefs) {
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {});
  const email = String(recipient?.email || '').trim();
  return { email: email.includes('@'), sms: !!String(customer?.phone || '').trim() };
}

async function loadBatch(dbh, batchKey) {
  const snapshots = await dbh('rate_review_snapshots').where({ batch_key: batchKey }).whereNotNull('notice_id');
  const approvedUnscheduled = await dbh('rate_review_snapshots')
    .where({ batch_key: batchKey, status: 'approved' })
    .whereNull('notice_id')
    .where('delta_cents', '>', 0)
    .select('id');
  const noticeIds = snapshots.map((s) => s.notice_id);
  const notices = noticeIds.length ? await dbh('price_change_notices').whereIn('id', noticeIds) : [];
  const customerIds = [...new Set(notices.map((n) => n.customer_id))];
  const customers = customerIds.length ? await dbh('customers').whereIn('id', customerIds) : [];
  const prefs = customerIds.length ? await dbh('notification_prefs').whereIn('customer_id', customerIds).catch(() => []) : [];
  const visitIds = notices.map((n) => parseJson(n.metadata, {}).first_visit_id).filter(Boolean);
  const visits = visitIds.length ? await dbh('scheduled_services').whereIn('id', visitIds).select('id', 'scheduled_date', 'status') : [];
  const visitById = new Map(visits.map((v) => [String(v.id), v]));
  const firstVisits = new Map();
  for (const n of notices) {
    const v = visitById.get(String(parseJson(n.metadata, {}).first_visit_id || ''));
    const day = v && ['pending', 'confirmed'].includes(String(v.status)) ? ymd(v.scheduled_date) : null;
    if (day && day >= ymd(n.effective_date)) firstVisits.set(String(n.id), day);
  }
  return {
    snapshots: new Map(snapshots.map((s) => [String(s.notice_id), s])),
    notices,
    customers: new Map(customers.map((c) => [String(c.id), c])),
    prefs: new Map((prefs || []).map((p) => [String(p.customer_id), p])),
    firstVisits,
    unscheduled: approvedUnscheduled.length,
  };
}

// Ordered suppression rules — the first that matches holds the line (or,
// for the account rules, the whole letter).
const LINE_RULES = [
  ['not_approved', ({ snapshot }) => !snapshot || String(snapshot.status) !== 'approved'],
  ['unsupported_line', ({ notice }) => !SERVICE_LABELS[notice.family_key]],
  ['invalid_amount', ({ line }) => !(line.currentCents > 0 && line.newCents > line.currentCents)],
  ['too_late', ({ line, today }) => !line.effectiveDate || daysBetween(today, line.effectiveDate) < MIN_NOTICE_DAYS + (line.unit === 'year' ? 1 : 0)],
  ['in_flight', ({ notice, now }) => !claimable(notice, now)],
];
const ACCOUNT_RULES = [
  ['customer_inactive', ({ customer }) => !customer || !!customer.deleted_at || customer.active === false],
  ['too_many_lines', ({ entry }) => entry.lines.length > LINE_SLOTS],
  ['no_contact', ({ entry }) => !entry.channels.email && !entry.channels.sms],
];
const firstMatch = (rules, ctx) => (rules.find(([, test]) => test(ctx)) || [null])[0];

function planEntry(data, customerId, notices, { today, now }) {
  const customer = data.customers.get(customerId) || null;
  const entry = { customerId, customer, name: [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || 'Customer', lines: [], alreadySent: [], suppressedLines: [], reason: null, channels: { email: false, sms: false } };
  for (const notice of notices) {
    if (notice.sent_at) { entry.alreadySent.push(notice.id); continue; }
    const snapshot = data.snapshots.get(String(notice.id)) || null;
    const line = lineFor(notice, snapshot, customer, data.firstVisits.get(String(notice.id)));
    const reason = firstMatch(LINE_RULES, { notice, snapshot, line, today, now });
    if (reason) entry.suppressedLines.push({ noticeId: notice.id, reason, label: REASONS[reason], service: line.service, effectiveDate: line.effectiveDate });
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

function digestFor(entries, costBlock) {
  const h = crypto.createHash('sha256');
  h.update(`cost:${costBlock || ''}\n`);
  for (const e of entries) {
    if (e.reason || !e.lines.length) continue;
    for (const l of [...e.lines].sort((a, b) => String(a.noticeId).localeCompare(String(b.noticeId)))) {
      h.update(`${e.customerId}:${l.noticeId}:${l.currentCents}:${l.newCents}:${l.effectiveDate}\n`);
    }
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
  const [data, costBlock] = await Promise.all([loadBatch(dbh, batchKey), loadCostBlock(dbh)]);
  const entries = planBatch(data, { today: etDateString(now), now });
  return {
    ok: true,
    batchKey,
    digest: digestFor(entries, costBlock),
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
    })),
  };
}

// ── render ─────────────────────────────────────────────────────────────

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
  const [data, costBlock] = await Promise.all([loadBatch(dbh, batchKey), loadCostBlock(dbh)]);
  const entry = planBatch(data, { today: etDateString(now), now }).find((e) => e.customerId === String(row.customer_id));
  // A line already sent previews from its own (unsent) siblings; when none
  // is left to send, preview the row's own line so the owner still sees it.
  let lines = entry ? entry.lines : [];
  if (!lines.length) {
    const notice = data.notices.find((n) => String(n.id) === String(row.notice_id));
    if (!notice) throw badInput('This row has no scheduled notice yet', 404);
    lines = [{ ...lineFor(notice, row, data.customers.get(String(row.customer_id)), data.firstVisits.get(String(notice.id))), notice }];
  }
  const customer = data.customers.get(String(row.customer_id));
  const payload = letterPayload({ customer, lines, costBlock: costBlock || '[Cost block not written yet: write it in Settings before sending.]', noticeUrl: noticeUrlFor(lines) });
  const rendered = await renderLetter(payload);
  return { ok: true, subject: rendered.subject, html: rendered.html, costBlockReady: !!costBlock, suppressed: entry ? entry.reason : null };
}

// ── send ───────────────────────────────────────────────────────────────

async function claimLines(dbh, lines, now) {
  const claimed = [];
  for (const l of lines) {
    let n = await dbh('price_change_notices')
      .where({ id: l.noticeId })
      .whereNull('sent_at')
      .whereIn('status', ['draft', 'viewed', 'unreachable'])
      .update({ status: 'sending', updated_at: new Date() });
    if (!n) {
      n = await dbh('price_change_notices')
        .where({ id: l.noticeId, status: 'sending' })
        .whereNull('sent_at')
        .where('updated_at', '<', new Date(now.getTime() - CLAIM_STALE_MS))
        .update({ status: 'sending', updated_at: new Date() });
    }
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

// The letter for this claim. A reclaim of a crashed attempt (same notice
// set) reuses the words that attempt froze BEFORE it sent — the email leg
// dedupes on its idempotency key, so the page must show what that email
// said, never a rebuild from data edited since.
async function letterForClaim(dbh, entry, { claimKey, costBlock }) {
  const pending = entry.lines.map((l) => parseJson(l.notice.metadata, {}).pending_letter);
  if (pending.every((p) => p && p.key === claimKey)) return pending[0];
  const payload = letterPayload({ customer: entry.customer, lines: entry.lines, costBlock, noticeUrl: noticeUrlFor(entry.lines) });
  const frozen = { key: claimKey, payload, letter: frozenLetter(entry, payload, costBlock) };
  for (const l of entry.lines) {
    const meta = parseJson(l.notice.metadata, {});
    await dbh('price_change_notices').where({ id: l.noticeId, status: 'sending' }).update({ metadata: JSON.stringify({ ...meta, pending_letter: frozen }) });
  }
  return frozen;
}

async function sendEntry(dbh, entry, { batchKey, costBlock, actorId, now }) {
  const claimed = await claimLines(dbh, entry.lines, now);
  if (!claimed) return { outcome: 'in_flight' };
  const customer = entry.customer;
  const claimKey = crypto.createHash('sha256').update([...claimed].sort().join(',')).digest('hex').slice(0, 16);
  const { payload, letter } = await letterForClaim(dbh, entry, { claimKey, costBlock });
  const email = await PriceChangeNotices.sendNoticeEmail({
    customer,
    idempotencyKeyBase: `rate_review:${batchKey}:${entry.customerId}:${claimKey}`,
    vars: payload,
    templateKey: TEMPLATE_KEY,
    categories: ['billing', 'rate_review_notice'],
  });
  const sms = await PriceChangeNotices.sendNoticeSms({
    customer,
    vars: { effective_date: payload.effective_date, price_change_url: payload.notice_url },
    actorId,
    hasEmailLeg: email.sent,
    operatorInitiated: true,
  });
  if (!email.sent && !sms.sent) {
    const status = (email.attempted || sms.attempted) ? 'draft' : 'unreachable';
    await dbh('price_change_notices').whereIn('id', claimed).where({ status: 'sending' }).update({ status, updated_at: new Date() });
    return { outcome: status === 'draft' ? 'failed' : 'unreachable' };
  }
  const sentAt = new Date();
  for (const l of entry.lines) {
    const { pending_letter: _pending, ...meta } = parseJson(l.notice.metadata, {});
    await dbh('price_change_notices').where({ id: l.noticeId, status: 'sending' }).update({
      status: 'sent', sent_at: sentAt, email_sent: !!email.sent, sms_sent: !!sms.sent,
      metadata: JSON.stringify({ ...meta, letter: { ...letter, sent_on: etDateString(sentAt) } }), updated_at: sentAt,
    });
    await dbh('rate_review_snapshots').where({ notice_id: l.noticeId, status: 'approved' }).update({ status: 'sent', updated_at: sentAt });
  }
  return { outcome: 'sent', email: !!email.sent, sms: !!sms.sent };
}

/**
 * Send a batch's letters. Refuses unless the digest matches the preview the
 * owner reviewed (same customers, lines, amounts, dates and cost block).
 * Returns { ok, sent, emailed, texted, unreachable, failed, inFlight,
 * suppressed, stoppedByGate }.
 */
async function sendBatch(batchKey, { expectedDigest, actorId = null, dbh = db, now = new Date() } = {}) {
  if (!rateReviewLive()) return { ok: false, reason: 'gate_off' };
  assertBatchKey(batchKey);
  const [data, costBlock] = await Promise.all([loadBatch(dbh, batchKey), loadCostBlock(dbh)]);
  if (!costBlock) return { ok: false, reason: 'cost_block_missing' };
  const entries = planBatch(data, { today: etDateString(now), now });
  if (String(expectedDigest || '') !== digestFor(entries, costBlock)) return { ok: false, reason: 'list_changed' };
  const sendable = entries.filter((e) => !e.reason && e.lines.length);
  if (!sendable.length) return { ok: false, reason: 'nothing_to_send' };
  await renderLetter(letterPayload({ customer: sendable[0].customer, lines: sendable[0].lines, costBlock, noticeUrl: portalUrl('/') })); // template installed?

  const summary = { sent: 0, emailed: 0, texted: 0, unreachable: 0, failed: 0, inFlight: 0, stoppedByGate: 0, suppressed: entries.filter((e) => e.reason && e.lines.length).length };
  for (let i = 0; i < sendable.length; i += SEND_CONCURRENCY) {
    await Promise.all(sendable.slice(i, i + SEND_CONCURRENCY).map(async (entry) => {
      if (!rateReviewLive()) { summary.stoppedByGate += 1; return; }
      try {
        const res = await sendEntry(dbh, entry, { batchKey, costBlock, actorId, now });
        if (res.outcome === 'sent') {
          summary.sent += 1;
          if (res.email) summary.emailed += 1;
          if (res.sms) summary.texted += 1;
        } else if (res.outcome === 'in_flight') summary.inFlight += 1;
        else if (res.outcome === 'unreachable') summary.unreachable += 1;
        else summary.failed += 1;
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
      description: `Rate review ${batchKey}: ${summary.sent} letter(s) sent (${summary.emailed} emailed, ${summary.texted} texted), ${summary.unreachable} unreachable, ${summary.failed} failed, ${summary.suppressed} suppressed.`,
      metadata: JSON.stringify({ batch_key: batchKey, summary }),
    });
  } catch (logErr) {
    logger.warn(`[rate-review-comms] activity log failed for ${batchKey}: ${logErr.message}`);
  }
  logger.info(`[rate-review-comms] ${batchKey}: ${JSON.stringify(summary)}`);
  return { ok: summary.failed === 0 && summary.stoppedByGate === 0, batchKey, ...summary };
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
  const letter = parseJson(notice.metadata, {}).letter;
  if (!notice.sent_at || !letter || !Array.isArray(letter.lines) || !letter.lines.length) return { unavailable: true };
  const lines = publicLines(letter);
  return {
    firstName: letter.first_name || null,
    costBlock: letter.cost_block || null,
    lines,
    hasPrepay: lines.some((l) => l.unit === 'year'),
  };
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
  return rows.filter((n) => !n.applied_at || n.billing_lane === 'annual_prepay').map((n) => {
    const unit = unitFor(n);
    return {
      service: SERVICE_LABELS[n.family_key] || null,
      unit,
      current: money(n.noticed_current_cents ?? n.current_amount_cents),
      next: money(n.noticed_new_cents ?? n.new_amount_cents),
      nextCents: Number(n.noticed_new_cents ?? n.new_amount_cents),
      effectiveDate: ymd(n.effective_date),
      noticePath: `/price-change/${n.notice_token}`,
    };
  });
}

module.exports = {
  TEMPLATE_KEY,
  sendPreview,
  letterPreview,
  sendBatch,
  publicReview,
  upcomingRateChanges,
  _private: { whyFor, lineFor, letterPayload, planBatch, digestFor, REASONS, SERVICE_LABELS, LINE_SLOTS },
};
