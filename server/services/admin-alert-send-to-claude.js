'use strict';

// "Send to Claude" (owner 2026-11-02, GATE_ALERT_SEND_TO_CLAUDE): "for the stuff that needs to be fixed, like that broken
// property ID ... we need to be able to send that back to terminal, open a terminal session, to have Claude fix that";
// scope answer "All but customer contact".
//
// The bell's "What to do" panel (admin-alert-explainer.js, GATE_ALERT_EXPLAINER) carries a button that moves one open
// bell row into Claude's queue: Activity-only (it leaves the bell), who 'claude', class 'sent-to-claude', and a
// `sentToClaude` stamp. The Mac launcher (com.waves.notif-dispatch, outside this repo) opens one terminal tab per sent
// row, and the tab closes the row when its fix is live. A refresh of the same alert keeps it in Claude's queue while it
// is open (admin-alert-routing.js keepSentToClaude).
//
// The handoff carries trusted facts only (Codex security reviews on #7498): when, who sent it, the alert's kind and the
// ids of the records it names, all written by our code. No alert text, no customer name, no summary: a customer sets their
// own name, and receipts, model output and record fields can carry any words, so none of it goes into a Claude tab's
// instructions. The tab reads the alert, its customer and its summary itself, read-only, as data.
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
const { SEVERITIES, WHO } = require('./admin-alert-compose');

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

// An alert's kind as our code named it: its registry trigger key, else its dedupe key's class (the part before the first
// colon). Only a plain lowercase name is kept; anything else is null.
const KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
function alertKind(meta) {
  const kind = meta.triggerKey || String(meta.dedupeKey || '').split(':')[0];
  return KIND_RE.test(String(kind || '')) ? kind : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : null);

// The fields a sent row carries. The stamp holds trusted facts only (see the header): `customerId` and `records` are ids
// read from the row and its records, `kind` is a name our code chose, `was` keeps the row's own who and severity for the
// record (known values only). An fyi row becomes work: the owner asked for it to be worked.
function sentPatch(row, { by, customerId = null, at = new Date() }) {
  const meta = metaOf(row.metadata);
  const { customerId: _named, ...records } = alertRecordRefs(row);
  return {
    feed: 'activity',
    who: 'claude',
    severity: meta.severity === 'broken' ? 'broken' : 'needs-you',
    claudeQueue: SENT_TO_CLAUDE_CLASS,
    sentToClaude: {
      at: at.toISOString(),
      by: uuidOrNull(by == null ? null : String(by)) || (by == null ? null : 'admin'),
      kind: alertKind(meta),
      customerId: uuidOrNull(customerId),
      records: Object.fromEntries(Object.entries(records).filter(([, id]) => uuidOrNull(id))),
      was: { who: WHO.includes(meta.who) ? meta.who : null, severity: SEVERITIES.includes(meta.severity) ? meta.severity : null },
    },
  };
}

// The send for one row the admin saw at `version`: { status, body }. 404 when the row is gone or out of scope, 422 when
// it cannot be sent (customer contact, not written by our code, done, already off the bell), 409 when its text changed
// since the bell read it.
async function sendAdminAlertToClaude(id, { version, by, role, technicianId = null } = {}) {
  const row = await NotificationService.getAdminNotificationForExplainer(id, { role, technicianId });
  if (!row) return { status: 404, body: { error: 'not_found' } };
  const refusal = sendRefusal(row);
  if (refusal) return { status: 422, body: { error: refusal } };
  if (row.version !== version) return { status: 409, body: { error: 'changed' } };
  // The customer's id, so the tab can read the customer: the row's own id, else the one behind the visit, estimate,
  // invoice, lead or call it names. A failed read leaves it to the row's own id (the tab can still follow the records).
  let customerId = alertRecordRefs(row).customerId;
  try { customerId = (await customersForAlerts(db, [row])).get(String(row.id))?.id || customerId; } catch (err) {
    logger.warn(`[send-to-claude] customer not read: ${NotificationService.safeErrorSummary(err)}`);
  }
  const written = await NotificationService.markAdminSentToClaude(row.id, version, sentPatch(row, { by, customerId }));
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
  sendAdminAlertToClaude, sendRefusal, sendToClaudeLive, sentPatch,
  CONTACT_CATEGORIES, CONTACT_TRIGGERS, SYSTEM_CATEGORIES, CHECK_CLASSES,
};
