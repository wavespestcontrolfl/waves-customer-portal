'use strict';

// "Send to Claude" (owner 2026-11-02, GATE_ALERT_SEND_TO_CLAUDE): "for the stuff that needs to be fixed, like that broken
// property ID ... we need to be able to send that back to terminal, open a terminal session, to have Claude fix that";
// scope answer "All but customer contact".
//
// The bell's "What to do" panel (admin-alert-explainer.js, GATE_ALERT_EXPLAINER) carries a button that moves one open
// bell row into Claude's queue: Activity-only (it leaves the bell), who 'claude', class 'sent-to-claude', and a
// `sentToClaude` stamp with when, who sent it, the customer it is about (read from the record, never guessed) and the
// plain-words summary the owner saw. The Mac launcher (com.waves.notif-dispatch, outside this repo) opens one terminal
// tab per sent row, and the tab closes the row when its fix is live. A refresh of the same alert keeps it in Claude's
// queue while it is open (admin-alert-routing.js keepSentToClaude).
//
// Only an alert whose words our own code wrote can be sent (owner 2026-11-02, "A", after Codex found customer-written
// alerts that carry no contact mark: a service request typed in the portal). A Claude terminal tab can change code, so a
// customer's own words must never reach it. Offered on (writtenByOurCode): a system alert with no customer record, an
// alert the code marks Claude's (who 'claude', severity 'broken', or a registry rule that says who 'claude'), and the
// reviewed checks on a customer's records in CHECK_CLASSES, which still name the customer. Never on customer contact or
// a follow-up we owe a customer, whatever else the row says. Everything else stays with the owner. Sends nothing to
// anyone; the one write is the row's own metadata.
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { CUSTOMER_CONTACT_CATEGORIES, SENT_TO_CLAUDE_CLASS } = require('./admin-alert-routing');
const { alertRecordRefs, customersForAlerts } = require('./admin-alert-customer');

// Beyond the contact categories: a review alert quotes the customer's review, and the general internal alert can carry a
// forwarded customer text.
const CONTACT_CATEGORIES = new Set([...CUSTOMER_CONTACT_CATEGORIES, 'review']);
const CONTACT_TRIGGERS = new Set(['internal_admin_alert']);

// A customer contact or a follow-up we owe a customer, as the row or its registry type declares it (docs/admin-notifications.md,
// "Customer declaration"). A registry event's row stores only its trigger key, so the type's own rule is read too: a
// self-booked re-service request is category `schedule`, but its rule says contact. Read at call time; an unreadable
// registry refuses nothing extra (the categories above still hold).
function declaredContact(meta) {
  if (meta.contact === true || meta.promise === true) return true;
  if (!meta.triggerKey) return false;
  try {
    const rule = require('./notification-triggers').TRIGGER_REGISTRY?.[meta.triggerKey]?.rule;
    return rule?.contact === true || rule?.promise === true;
  } catch { return false; }
}

// System alerts: their words come from our code and the Mac ops checks. Offered only when no customer record is named.
const SYSTEM_CATEGORIES = new Set(['system', 'ops_digest', 'inventory', 'llm_cost', 'agents', 'token_alert']);
// Checks on a customer's records, by dedupe-key class. Each emitter was read on 2026-11-02: its headline, why and detail
// come from record fields (the customer's name, dates, services, prices, products), never from a note, a message or a
// request the customer wrote. A new class joins only after the same read. The AI schedule proofreader is left out: a model
// writes its text from visit data.
const CHECK_CLASSES = Object.freeze([
  'auto-dispatch-needs-person:', // auto-dispatch/needs-person-notice.js: a visit auto-dispatch cannot place
  'recurring-dispatch:', // auto-dispatch/audit.js: a recurring visit due with no slot
  'recurring-no-window:', // auto-dispatch/audit.js: a recurring visit with no time window
  'auto-dispatch-missing-geo:', // auto-dispatch/audit.js: a visit with no map location
  'accepted-schedule:', // schedule-integrity-watchdog.js: an accepted plan whose visits do not match it
  'prepay-coverage:', // schedule-integrity-watchdog.js: prepaid coverage needs a review before billing
  'unpriced-series:', // schedule-integrity-watchdog.js: a recurring series with no price
  'combined-booking-check:', // combined-booking-check.js: a combined booking that did not book as accepted
  'rain-pass:', // auto-dispatch/rain-pass.js: a visit the forecast says to move
  'lawn-watering-no-instruction:', // service-report/lawn-watering-sms.js: a lawn visit froze no watering instruction
  'series-price-guard:', // series-price-guards.js: a series price over the last paid price
  'unbilled-completion:', // series-price-guards.js: a completed visit with no invoice
  'first_application_sibling_divergence:', // first-application-sibling-split.js: first-application invoices disagree
]);

// What a Claude tab reads about a sent alert is inert data (Codex security review on #7498): a customer sets their own name,
// and a record's text can carry a phone, an email or an address, so none of it reaches a terminal session as free text.
const NAME_MAX_WORDS = 4;
const NAME_MAX_CHARS = 40;
const TEXT_MAX = Object.freeze({ title: 200, body: 500, detail: 4000, summary: 300 });

// A customer's name reduced to letters, marks, spaces, apostrophes, hyphens and periods: at most four words, 40 characters.
function inertName(name) {
  const kept = String(name ?? '').normalize('NFKC').replace(/[^\p{L}\p{M} '.-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return kept.split(' ').slice(0, NAME_MAX_WORDS).join(' ').slice(0, NAME_MAX_CHARS).trim();
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const redact = (text) => require('./notification-triggers').__private.redactSensitiveText(text);

// One alert text as inert data: phones, emails and street addresses are masked as in every bell body; then the customer's
// name (whole, then each word of three or more letters, longest first, as whole words) becomes "[customer]"; control
// characters go; the length is capped. Null stays null.
function inertText(text, name, max) {
  if (text === null || text === undefined || text === '') return text ?? null;
  const raw = String(name ?? '').trim();
  const parts = [...new Set([raw, ...raw.split(/\s+/)])].filter((p) => p.length >= 3).sort((x, y) => y.length - x.length);
  let out = redact(String(text));
  for (const part of parts) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{M}])${escapeRegExp(part)}(?![\\p{L}\\p{M}])`, 'giu'), '[customer]');
  }
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  return out.length > max ? `${out.slice(0, max - 1)}\u2026` : out;
}

const metaOf = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
};

// A customer record the row names by id, top level, in its payload, or as its subject.
function namesCustomer(meta) {
  const payload = metaOf(meta.payload);
  const subject = meta.subject && typeof meta.subject === 'object' ? meta.subject : {};
  return subject.type === 'customer'
    || [meta.customerId, meta.customer_id, meta.threadId, meta.scopeCustomerId, payload.customerId, payload.customer_id,
      payload.threadId, payload.scopeCustomerId].some((v) => v !== undefined && v !== null && String(v).trim() !== '');
}

const registryRule = (meta) => {
  if (!meta.triggerKey) return null;
  try { return require('./notification-triggers').TRIGGER_REGISTRY?.[meta.triggerKey]?.rule || null; } catch { return null; }
};

// The allow-list (see the header): the code marks it Claude's, or it is a system alert with no customer, or a reviewed check.
function writtenByOurCode(row, meta) {
  if (meta.who === 'claude' || meta.severity === 'broken' || registryRule(meta)?.who === 'claude') return true;
  if (SYSTEM_CATEGORIES.has(row.category) && !namesCustomer(meta)) return true;
  const key = String(meta.dedupeKey || '');
  return CHECK_CLASSES.some((prefix) => key.startsWith(prefix));
}

// Why this row cannot be sent, or null when it can. Pure except for the registry read.
function sendRefusal(row) {
  if (!row || String(row.id || '').startsWith('live:')) return 'not_found';
  const meta = metaOf(row.metadata);
  if (CONTACT_CATEGORIES.has(row.category) || CONTACT_TRIGGERS.has(meta.triggerKey) || declaredContact(meta)) return 'customer_contact';
  if (row.done_at != null) return 'done';
  // Already off the bell: sent before, routed to Claude's queue, or an Activity-only report.
  if (meta.feed === 'activity') return 'not_in_bell';
  return writtenByOurCode(row, meta) ? null : 'not_system_written';
}

// GATE_ALERT_SEND_TO_CLAUDE, read at call time; a missing or throwing reader reads as off.
function sendToClaudeLive() {
  try { return require('../config/feature-gates').alertSendToClaudeLive?.() === true; } catch { return false; }
}

// The fields a sent row carries. `alert` is the inert copy of the row's text a Claude tab and needs-me read instead of the
// row's own words; `customer` and `summary` are inert too. `was` keeps the row's own who and severity for the record. An
// fyi row becomes work: the owner asked for it to be worked.
function sentPatch(row, { by, customer, summary, at = new Date() }) {
  const meta = metaOf(row.metadata);
  const name = customer?.name || '';
  return {
    feed: 'activity',
    who: 'claude',
    severity: meta.severity === 'broken' ? 'broken' : 'needs-you',
    claudeQueue: SENT_TO_CLAUDE_CLASS,
    sentToClaude: {
      at: at.toISOString(),
      by: by == null ? null : String(by),
      customer: customer ? { id: customer.id || null, name: inertName(name) } : null,
      alert: {
        title: inertText(row.title, name, TEXT_MAX.title),
        body: inertText(row.body, name, TEXT_MAX.body),
        detail: inertText(row.detail, name, TEXT_MAX.detail),
      },
      summary: summary ? {
        happened: inertText(summary.happened, name, TEXT_MAX.summary),
        steps: (summary.steps || []).map((step) => inertText(step, name, TEXT_MAX.summary)),
      } : null,
      was: { who: meta.who ?? null, severity: meta.severity ?? null },
    },
  };
}

// The send for one row the admin saw at `version`: { status, body }. 404 when the row is gone or out of scope, 422 when
// it cannot be sent (customer contact, not written by our code, done, already off the bell), 409 when its text changed
// since the bell read it, 503 when the row is linked to a record whose customer's name could not be read.
async function sendAdminAlertToClaude(id, { version, by, role, technicianId = null } = {}) {
  const row = await NotificationService.getAdminNotificationForExplainer(id, { role, technicianId });
  if (!row) return { status: 404, body: { error: 'not_found' } };
  const refusal = sendRefusal(row);
  if (refusal) return { status: 422, body: { error: refusal } };
  if (row.version !== version) return { status: 409, body: { error: 'changed' } };
  let customer = null;
  try { customer = (await customersForAlerts(db, [row])).get(String(row.id)) || null; } catch (err) {
    logger.warn(`[send-to-claude] customer not read: ${NotificationService.safeErrorSummary(err)}`);
  }
  // Fail closed: the name is what the inert copy masks, so a row linked to any record (a customer, visit, estimate,
  // invoice, lead or call) is sent only once its customer's name was read. A failed read (customersForAlerts turns a
  // database error into no name) or a record with no name answers 503 and the bell says to try again.
  if (Object.values(alertRecordRefs(row)).some(Boolean) && !customer?.name) {
    return { status: 503, body: { error: 'customer_unresolved' } };
  }
  const { servedExplainer } = require('./admin-alert-explainer');
  const summary = servedExplainer(row.explainer, row.version);
  const written = await NotificationService.markAdminSentToClaude(row.id, version, sentPatch(row, { by, customer, summary }));
  if (!written) {
    // Changed, closed or moved off the bell between the read and the write.
    const state = await NotificationService.getAdminNotificationState(row.id, { role, technicianId });
    if (!state) return { status: 404, body: { error: 'not_found' } };
    return { status: 409, body: { error: state.done ? 'done' : 'changed' } };
  }
  logger.info('[send-to-claude] sent', { id: row.id, category: row.category });
  return { status: 200, body: { sent: true, message: 'Sent to Claude. A terminal tab opens for it within about 10 minutes.' } };
}

module.exports = {
  sendAdminAlertToClaude, sendRefusal, sendToClaudeLive, sentPatch, inertName, inertText,
  CONTACT_CATEGORIES, CONTACT_TRIGGERS, SYSTEM_CATEGORIES, CHECK_CLASSES,
};
