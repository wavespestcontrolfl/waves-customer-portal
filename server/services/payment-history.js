'use strict';
// Is ANY of one customer's own money still IN FLIGHT? (PR #5331.) Feeds context-aggregator's `billing.hasProcessingPayment`, which
// keeps the payment-status contract from rendering "no balance due" / "no payments" while a payment or invoice is processing.
// (The authoritative-history reader that used to ground free-text absence claims is gone: payment status now reaches a customer only
// as a sentence rendered from the display window - payment-status-contract.js.)
const db = require('../models/db');
const { loadLivePayerLinkage } = require('./payer-linkage');
const logger = require('./logger');

// Codex round-13 P1: is ANY of this customer's own money still IN FLIGHT? An
// EXISTENCE query over the whole table — deliberately independent of the 3/5-row
// display window (an older processing payment must still block "you're paid up"
// when five newer rows push it out of view). Own = not payer-owned: payments with
// payer_id NULL whose metadata invoice is not a payer-billed one; invoices with
// payer_id NULL. true when a payment is pending/processing/requires_action OR an
// invoice is processing. Returns null when the read fails (unknown => callers
// fail closed). payments.metadata is JSONB, so ->> is total.
// Codex round-29 P2: "own" money is judged by the SAME shared payer-linkage predicate as the history (services/
// payer-linkage.js) — not just metadata.invoice_id: candidate in-flight payments come back from SQL (payer_id NULL,
// pending / processing / requires_action, capped) and are filtered in JS through every linkage; a processing INVOICE
// counts only if it is the homeowner's (payer_id NULL and not withdrawn to a payer by stamp).
const IN_FLIGHT_PAYMENTS_LIMIT = 200;
// Codex round-71 P2: not only pending / processing / requires_action - ANY status outside the renderer's resolved set (disputed, an
// unknown status) is unresolved money, so an old dispute pushed out of the display window still blocks "no balance due". An
// 'upcoming' autopay row is a FUTURE charge, never attempted (Codex round-72 P2): excluded, as the context reader does.
const { RESOLVED_PAYMENT_STATUSES } = require('./payment-status-contract');
const RESOLVED_STATUS_SQL_LIST = [...RESOLVED_PAYMENT_STATUSES].map((s) => `'${s}'`).join(', ');
const IN_FLIGHT_PAYMENTS_SQL = `SELECT id, metadata, stripe_payment_intent_id, stripe_charge_id, description
  FROM payments
  WHERE customer_id = ? AND payer_id IS NULL
    AND lower(coalesce(status, '')) NOT IN (${RESOLVED_STATUS_SQL_LIST}, 'upcoming')
  LIMIT ${IN_FLIGHT_PAYMENTS_LIMIT}`;
// Processing invoices come back as ids (capped) and are judged through the LIVE payer verdict in JS (Codex round-41 P1): a processing
// invoice that resolves to a payer today is the payer's money in flight, not the homeowner's.
const IN_FLIGHT_INVOICE_SQL = `SELECT id FROM invoices
  WHERE customer_id = ? AND payer_id IS NULL AND payer_statement_id IS NULL AND lower(status) = 'processing'
    AND (scheduled_send_error IS NULL OR scheduled_send_error NOT LIKE 'payer_billed:%')
  LIMIT ${IN_FLIGHT_PAYMENTS_LIMIT}`;
const rowsOf = (res) => (res && (res.rows || (Array.isArray(res) ? res : []))) || [];
// `linkage` (Codex round-55 P2): a caller that already holds the live payer linkage (the context aggregator) passes it, so one context
// read makes ONE bounded ownership pass and every fact it builds sees the same ownership snapshot.
async function hasInFlightMoney(customerId, dbh = db, { linkage: knownLinkage = null } = {}) {
  if (!customerId) return null;
  try {
    // LIVE ownership (Codex round-41 P1): same shared verdict as the history and the invoice facts.
    const linkage = knownLinkage || await loadLivePayerLinkage(customerId, dbh);
    if (linkage.failed) return null; // ownership unknown => unknown (callers read null as in flight)
    const candidates = rowsOf(await dbh.raw(IN_FLIGHT_PAYMENTS_SQL, [customerId]));
    if (candidates.some((p) => !linkage.isPayerLinked(p))) return true;
    // every candidate was payer-linked but the read was FULL: rows beyond the cap are unseen => unknown, not "clear"
    if (candidates.length >= IN_FLIGHT_PAYMENTS_LIMIT) return null;
    const processing = rowsOf(await dbh.raw(IN_FLIGHT_INVOICE_SQL, [customerId]));
    if (processing.some((r) => !linkage.liveOwnedIds.has(String(r.id)))) return true;
    // every processing invoice seen is live payer-owned but the read was FULL: unseen rows => unknown, not "clear"
    if (processing.length >= IN_FLIGHT_PAYMENTS_LIMIT) return null;
    return false;
  } catch (err) {
    logger.warn(`[payment-history] in-flight read failed for customer ${customerId}: ${err.message}`);
    return null;
  }
}

module.exports = { hasInFlightMoney, IN_FLIGHT_PAYMENTS_SQL, IN_FLIGHT_INVOICE_SQL };
