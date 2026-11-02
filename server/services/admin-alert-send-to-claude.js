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
// Never offered on customer contact: a row a customer reached us through or that carries a customer's own words (texts,
// emails, calls, voicemails, new leads, reviews, a declared contact, the general internal alert that can forward a text).
// Those stay with the owner. Sends nothing to anyone; the one write is the row's own metadata.
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { CUSTOMER_CONTACT_CATEGORIES, SENT_TO_CLAUDE_CLASS } = require('./admin-alert-routing');
const { customersForAlerts } = require('./admin-alert-customer');

// Beyond the contact categories: a review alert quotes the customer's review, and the general internal alert can carry a
// forwarded customer text.
const CONTACT_CATEGORIES = new Set([...CUSTOMER_CONTACT_CATEGORIES, 'review']);
const CONTACT_TRIGGERS = new Set(['internal_admin_alert']);

const metaOf = (value) => {
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return value && typeof value === 'object' ? value : {};
};

// Why this row cannot be sent, or null when it can. Pure.
function sendRefusal(row) {
  if (!row || String(row.id || '').startsWith('live:')) return 'not_found';
  const meta = metaOf(row.metadata);
  if (CONTACT_CATEGORIES.has(row.category) || CONTACT_TRIGGERS.has(meta.triggerKey) || meta.contact === true) return 'customer_contact';
  if (row.done_at != null) return 'done';
  // Already off the bell: sent before, routed to Claude's queue, or an Activity-only report.
  if (meta.feed === 'activity') return 'not_in_bell';
  return null;
}

// GATE_ALERT_SEND_TO_CLAUDE, read at call time; a missing or throwing reader reads as off.
function sendToClaudeLive() {
  try { return require('../config/feature-gates').alertSendToClaudeLive?.() === true; } catch { return false; }
}

// The fields a sent row carries. `was` keeps the row's own who and severity for the record. An fyi row becomes work:
// the owner asked for it to be worked.
function sentPatch(row, { by, customer, summary, at = new Date() }) {
  const meta = metaOf(row.metadata);
  return {
    feed: 'activity',
    who: 'claude',
    severity: meta.severity === 'broken' ? 'broken' : 'needs-you',
    claudeQueue: SENT_TO_CLAUDE_CLASS,
    sentToClaude: {
      at: at.toISOString(),
      by: by == null ? null : String(by),
      customer: customer ? { id: customer.id || null, name: customer.name } : null,
      summary: summary ? { happened: summary.happened, steps: summary.steps } : null,
      was: { who: meta.who ?? null, severity: meta.severity ?? null },
    },
  };
}

// The send for one row the admin saw at `version`: { status, body }. 404 when the row is gone or out of scope, 422 when
// it cannot be sent (customer contact, done, already off the bell), 409 when its text changed since the bell read it.
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

module.exports = { sendAdminAlertToClaude, sendRefusal, sendToClaudeLive, sentPatch, CONTACT_CATEGORIES, CONTACT_TRIGGERS };
