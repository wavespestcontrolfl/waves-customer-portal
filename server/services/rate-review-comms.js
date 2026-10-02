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
  too_late: `Effective date is under ${MIN_NOTICE_DAYS} days away — reschedule the notices`,
  invalid_amount: 'New rate is not above the current rate',
  unsupported_line: 'Service line has no letter wording',
  too_many_lines: `More than ${LINE_SLOTS} reviewed lines on one account`,
  no_contact: 'No email or phone on file',
  in_flight: 'A send for this customer is in progress',
  send_uncertain: 'An earlier send may have reached the customer — check the email log before anything else is sent',
  renewal_declined: 'Customer declined to renew the prepaid plan',
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
    declinedTerms: await declinedPrepayTermIds(dbh, notices),
    unscheduled: approvedUnscheduled.length,
  };
}

// Ordered suppression rules — the first that matches holds the line (or,
// for the account rules, the whole letter).
const LINE_RULES = [
  ['not_approved', ({ snapshot }) => !snapshot || String(snapshot.status) !== 'approved'],
  ['unsupported_line', ({ notice }) => !SERVICE_LABELS[notice.family_key]],
  ['renewal_declined', ({ notice, declinedTerms }) => declinedTerms.has(String(parseJson(notice.metadata, {}).term_id || ''))],
  ['invalid_amount', ({ line }) => !(line.currentCents > 0 && line.newCents > line.currentCents)],
  ['send_uncertain', ({ notice, now }) => sendOutcomeUncertain(notice, now)],
  ['in_flight', ({ notice }) => !SENDABLE_STATUSES.includes(String(notice.status))],
  // At least 30 days out from today, the delivery day (31 for a prepaid
  // renewal, the apply lane's own rule).
  ['too_late', ({ line, today }) => !line.effectiveDate || daysBetween(today, line.effectiveDate) < MIN_NOTICE_DAYS + (line.unit === 'year' ? 1 : 0)],
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
    const reason = firstMatch(LINE_RULES, { notice, snapshot, line, today, now, declinedTerms: data.declinedTerms });
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

// The digest the send must match: per sendable letter, the exact words it
// would render now (cost block, dates, first application), the channels it
// goes out on, and the active template's content.
function digestFor(entries, costBlock, templateHash = null) {
  const h = crypto.createHash('sha256');
  h.update(`cost:${costBlock || ''}\ntemplate:${templateHash || ''}\n`);
  for (const e of entries) {
    if (e.reason || !e.lines.length) continue;
    const payload = letterPayload({ customer: e.customer, lines: e.lines, costBlock, noticeUrl: noticeUrlFor(e.lines) });
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
  const [data, costBlock, templateHash] = await Promise.all([loadBatch(dbh, batchKey), loadCostBlock(dbh), letterTemplateHash()]);
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

function claimKeyFor(noticeIds) {
  return crypto.createHash('sha256').update([...noticeIds].map(String).sort().join(',')).digest('hex').slice(0, 16);
}

async function claimLines(dbh, lines) {
  const claimed = [];
  for (const l of lines) {
    const n = await dbh('price_change_notices')
      .where({ id: l.noticeId })
      .whereNull('sent_at')
      .whereIn('status', SENDABLE_STATUSES)
      .update({ status: 'sending', updated_at: new Date() });
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

async function settleLines(dbh, entry, { status, keepFrozen, frozen }) {
  for (const l of entry.lines) {
    const { pending_letter: _p, ...meta } = parseJson(l.notice.metadata, {});
    await dbh('price_change_notices').where({ id: l.noticeId, status: 'sending' }).update({
      status, metadata: JSON.stringify(keepFrozen ? { ...meta, pending_letter: frozen } : meta), updated_at: new Date(),
    });
  }
}

async function sendEntry(dbh, entry, { batchKey, costBlock, templateHash, actorId }) {
  const claimed = await claimLines(dbh, entry.lines);
  if (!claimed) return { outcome: 'in_flight' };
  const customer = entry.customer;
  const claimKey = claimKeyFor(claimed);
  const payload = letterPayload({ customer, lines: entry.lines, costBlock, noticeUrl: noticeUrlFor(entry.lines) });
  const frozen = { key: claimKey, payload, letter: frozenLetter(entry, payload, costBlock) };
  await freezeLetter(dbh, entry, frozen);
  const email = await PriceChangeNotices.sendNoticeEmail({
    customer,
    idempotencyKeyBase: `rate_review:${batchKey}:${entry.customerId}:${claimKey}`,
    vars: payload,
    templateKey: TEMPLATE_KEY,
    categories: ['billing', 'rate_review_notice'],
    expectedContentHash: templateHash,
  });
  const sms = await PriceChangeNotices.sendNoticeSms({
    customer,
    vars: { effective_date: payload.effective_date, price_change_url: payload.notice_url },
    actorId,
    hasEmailLeg: email.sent,
    operatorInitiated: true,
  });
  if (!email.sent && !sms.sent) {
    // Never handed to a provider (no contact, every leg policy-blocked):
    // definitively unsent — parks as unreachable, words dropped, retirable
    // and sendable again. Attempted (a provider or template failure that
    // may still have delivered): held as send_uncertain with its words, for
    // the owner — never auto-retried, never retired.
    const attempted = email.attempted || sms.attempted;
    await settleLines(dbh, entry, { status: attempted ? UNCERTAIN : 'unreachable', keepFrozen: attempted, frozen });
    return { outcome: attempted ? 'uncertain' : 'unreachable' };
  }
  const sentAt = new Date();
  // Every line of one letter is stamped together.
  await dbh.transaction(async (trx) => {
    for (const l of entry.lines) {
      const { pending_letter: _p, ...meta } = parseJson(l.notice.metadata, {});
      await trx('price_change_notices').where({ id: l.noticeId, status: 'sending' }).update({
        status: 'sent', sent_at: sentAt, email_sent: !!email.sent, sms_sent: !!sms.sent,
        metadata: JSON.stringify({ ...meta, letter: { ...frozen.letter, sent_on: etDateString(sentAt) } }), updated_at: sentAt,
      });
      await trx('rate_review_snapshots').where({ notice_id: l.noticeId, status: 'approved' }).update({ status: 'sent', updated_at: sentAt });
    }
  });
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
  const [data, costBlock, templateHash] = await Promise.all([loadBatch(dbh, batchKey), loadCostBlock(dbh), letterTemplateHash()]);
  if (!costBlock) return { ok: false, reason: 'cost_block_missing' };
  if (!templateHash) throw badInput('The rate review letter template is not installed', 503);
  const entries = planBatch(data, { today: etDateString(now), now });
  if (String(expectedDigest || '') !== digestFor(entries, costBlock, templateHash)) return { ok: false, reason: 'list_changed' };
  const sendable = entries.filter((e) => !e.reason && e.lines.length);
  if (!sendable.length) return { ok: false, reason: 'nothing_to_send' };
  await renderLetter(letterPayload({ customer: sendable[0].customer, lines: sendable[0].lines, costBlock, noticeUrl: portalUrl('/') })); // template installed?

  const summary = { sent: 0, emailed: 0, texted: 0, unreachable: 0, uncertain: 0, failed: 0, inFlight: 0, stoppedByGate: 0, suppressed: entries.filter((e) => e.reason && e.lines.length).length };
  for (let i = 0; i < sendable.length; i += SEND_CONCURRENCY) {
    await Promise.all(sendable.slice(i, i + SEND_CONCURRENCY).map(async (entry) => {
      if (!rateReviewLive()) { summary.stoppedByGate += 1; return; }
      try {
        const res = await sendEntry(dbh, entry, { batchKey, costBlock, templateHash, actorId });
        if (res.outcome === 'sent') {
          summary.sent += 1;
          if (res.email) summary.emailed += 1;
          if (res.sms) summary.texted += 1;
        } else if (res.outcome === 'in_flight') summary.inFlight += 1;
        else if (res.outcome === 'unreachable') summary.unreachable += 1;
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
async function applicableMonthly(dbh, rows, customer) {
  const monthly = rows.filter((n) => n.billing_lane === 'monthly_membership');
  if (!monthly.length) return [];
  const { loadFamilySlices, sumSlices, cents } = require('./rate-review-apply')._private;
  const out = [];
  for (const n of monthly) {
    const source = parseJson(n.metadata, {}).current_rate_source;
    const live = source === 'ledger_slice'
      ? cents(sumSlices((await loadFamilySlices(dbh, n.customer_id, n.family_key)).family))
      : cents(customer?.monthly_rate);
    // ...and the delivery preceded the effective date by the 30 days the
    // apply enforces from sent_at (a later stamp holds there).
    const noticedInTime = n.sent_at && daysBetween(etDateString(new Date(n.sent_at)), ymd(n.effective_date)) >= MIN_NOTICE_DAYS;
    if (noticedInTime && live === Number(n.noticed_current_cents ?? n.current_amount_cents)) out.push(n);
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
  const customer = rows.length ? await dbh('customers').where({ id: customerId }).first('monthly_rate', 'billing_day') : null;
  const declinedTerms = await declinedPrepayTermIds(dbh, rows);
  const pending = rows.filter((n) => (!n.applied_at || n.billing_lane === 'annual_prepay')
    && !declinedTerms.has(String(parseJson(n.metadata, {}).term_id || '')));
  const monthly = await applicableMonthly(dbh, pending, customer);
  return pending.map((n) => ({
    service: SERVICE_LABELS[n.family_key] || null,
    unit: unitFor(n),
    current: money(n.noticed_current_cents ?? n.current_amount_cents),
    next: money(n.noticed_new_cents ?? n.new_amount_cents),
    ...chargeAtNewRate(n, { monthly, customer }),
    effectiveDate: ymd(n.effective_date),
    noticePath: `/price-change/${n.notice_token}`,
  }));
}

// A prepaid term the customer declined to renew (renewal_decision cancel,
// or the term cancelled) never renews at the new rate — not upcoming.
async function declinedPrepayTermIds(dbh, rows) {
  const termIds = rows.filter((n) => n.billing_lane === 'annual_prepay').map((n) => parseJson(n.metadata, {}).term_id).filter(Boolean);
  if (!termIds.length) return new Set();
  const terms = await dbh('annual_prepay_terms').whereIn('id', termIds).select('id', 'status', 'renewal_decision');
  return new Set(terms.filter((t) => String(t.renewal_decision) === 'cancel' || String(t.status) === 'cancelled').map((t) => String(t.id)));
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
