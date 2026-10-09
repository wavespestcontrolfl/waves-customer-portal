'use strict';

/**
 * Store for the pin suggestions made by the daily pin check (pin-parked-check.js, GATE_PIN_PARKED_CHECK).
 *
 * One OPEN suggestion per customer (a partial unique index enforces it). A suggestion ends in one of three ways,
 * and the row is kept as history in every case:
 *   applied     staff used the truck's spot through the existing verify_pin action
 *   dismissed   staff said the pin is right; the check does not raise the same pin again
 *   superseded  the system closed it: the pin was verified or changed, a later stop landed inside the arrival
 *               radius, or the customer is gone
 * Closing a suggestion also closes its admin notification (closeAdminAlertKeys), so the bell never keeps a card
 * for a pin that is settled.
 *
 * This module never writes a pin. The only pin write is verify_pin in customer-geocode-review-actions.js.
 */
const db = require('../models/db');
const logger = require('./logger');
const { closeAdminAlertKeys } = require('./admin-alert-episodes');

const alertKey = (suggestionId) => `pin-suggestion:${suggestionId}`;
const SOURCE = 'site_visit';
const COLUMNS = ['id', 'customer_id', 'scheduled_service_id', 'technician_id', 'visit_date', 'pin_lat', 'pin_lng',
  'parked_lat', 'parked_lng', 'distance_m', 'stop_minutes', 'stop_started_at', 'status', 'notified_at', 'created_at'];

const same7 = (a, b) => a != null && b != null && Number(a).toFixed(7) === Number(b).toFixed(7);

// 'YYYY-MM-DD' (or a Date from the date column) as the ET calendar day it names.
function dayText(value) {
  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value || '').slice(0, 10);
}

/** The wording the panel puts in the verify_pin evidence box. */
function evidenceText(row) {
  const day = new Date(`${dayText(row.visit_date)}T12:00:00Z`)
    .toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  return `Truck parked here during the completed visit on ${day} (Bouncie GPS). Pin was ${row.distance_m} m away.`;
}

/** What the review endpoint sends to the panel. */
function publicShape(row) {
  return {
    id: row.id,
    visit_date: dayText(row.visit_date),
    latitude: Number(row.parked_lat),
    longitude: Number(row.parked_lng),
    distance_m: Number(row.distance_m),
    stop_minutes: Number(row.stop_minutes),
    source: SOURCE,
    evidence: evidenceText(row),
  };
}

async function openForCustomer(customerId, conn = db) {
  return (await conn('customer_pin_suggestions').where({ customer_id: customerId, status: 'open' }).first(COLUMNS)) || null;
}

/**
 * The suggestion to show for a review detail, or null. A GET never writes, so a suggestion that is already
 * settled (the pin was verified, or moved since) is simply not shown; the daily job closes it.
 */
function visibleSuggestion(detail, row) {
  if (!row || !detail?.customer) return null;
  if (['verified', 'outside_area'].includes(detail.review?.status)) return null;
  if (!same7(detail.customer.latitude, row.pin_lat) || !same7(detail.customer.longitude, row.pin_lng)) return null;
  return publicShape(row);
}

/**
 * The per-customer lock that serializes everything that creates, rings or closes this customer's suggestion:
 * the daily run's insert, the bell post, and apply / dismiss / supersede. Transaction-scoped, so it is released
 * at commit and is re-entrant for a caller that already holds it. `trx` must be a transaction.
 */
async function lockCustomer(trx, customerId) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['pin-parked-check', String(customerId)]);
}

// Errors propagate: inside the close transaction a failed bell close must roll the close back (the suggestion stays
// open and is retried), never leave a closed suggestion beside a live bell.
async function closeBell(id, reason, resolution, conn = db) {
  await closeAdminAlertKeys(conn, [alertKey(id)], reason, { resolution });
}

/**
 * Moves an OPEN suggestion to a final status. Takes the customer's lock first, so it cannot interleave with the
 * bell being posted: either the bell is posted first and is closed here, or the close comes first and the bell
 * post finds the suggestion no longer open and posts nothing. The status test is in the UPDATE, so two callers can
 * never both close it. The bell is closed in the same transaction. Returns the closed row, or null when it was
 * not open any more.
 */
async function closeSuggestion(id, status, { actorId = null, reason, resolution, conn = db } = {}) {
  return conn.transaction(async (trx) => {
    const current = await trx('customer_pin_suggestions').where({ id }).first('customer_id');
    if (!current) return null;
    await lockCustomer(trx, current.customer_id);
    const [row] = await trx('customer_pin_suggestions').where({ id, status: 'open' })
      .update({ status, resolved_at: trx.fn.now(), resolved_by: actorId, updated_at: trx.fn.now() })
      .returning(COLUMNS);
    if (row) await closeBell(row.id, reason || status, resolution, trx);
    return row || null;
  });
}

/**
 * A customer merge: the loser's open suggestion is retired (superseded, its bell closed) rather than moved to the
 * survivor, whose pin and visits are what the next daily run judges. Run inside the merge transaction, before the
 * rows are repointed, so two open suggestions can never meet on the one-open-per-customer index. Returns the count.
 */
async function retireOnMerge(trx, loserId) {
  await lockCustomer(trx, loserId);
  const rows = await trx('customer_pin_suggestions').where({ customer_id: loserId, status: 'open' })
    .update({ status: 'superseded', resolved_at: trx.fn.now(), updated_at: trx.fn.now() }).returning('id');
  for (const { id } of rows) {
    await closeBell(id, 'merged', 'Closed: the customer was merged into another account', trx);
  }
  return rows.length;
}

/** Closes the customer's open suggestion (if any) as superseded. */
async function supersedeOpen(customerId, reason, conn = db) {
  const open = await openForCustomer(customerId, conn);
  if (!open) return null;
  return closeSuggestion(open.id, 'superseded', {
    reason, resolution: 'Closed: the pin was checked or changed by another route', conn,
  });
}

/** Staff pressed Dismiss. Returns the closed row, or null when it was not open (or not this customer's). */
async function dismiss(customerId, suggestionId, actorId, conn = db) {
  const row = await conn('customer_pin_suggestions').where({ id: suggestionId, customer_id: customerId, status: 'open' })
    .first('id');
  if (!row) return null;
  return closeSuggestion(row.id, 'dismissed', {
    actorId, reason: 'dismissed', resolution: 'Dismissed: staff said the pin is right', conn,
  });
}

/**
 * A verify_pin just succeeded for this customer. The suggestion the form was filled from becomes `applied`; any
 * other open suggestion becomes `superseded` (the pin was verified without it). Never throws.
 */
async function closeAfterVerify(customerId, { suggestionId = null, actorId = null, conn = db } = {}) {
  try {
    const open = await openForCustomer(customerId, conn);
    if (!open) return null;
    if (suggestionId && String(open.id) === String(suggestionId)) {
      return await closeSuggestion(open.id, 'applied', {
        actorId, reason: 'applied', resolution: 'Fixed: staff verified the pin', conn,
      });
    }
    return await closeSuggestion(open.id, 'superseded', {
      reason: 'pin_verified', resolution: 'Closed: staff verified the pin', conn,
    });
  } catch (err) {
    logger.warn('[pin-suggestions] could not close after verify_pin', { customerId, error: err.code || err.name });
    return null;
  }
}

module.exports = {
  alertKey, lockCustomer, evidenceText, publicShape, openForCustomer, visibleSuggestion, closeSuggestion, supersedeOpen, retireOnMerge, dismiss,
  closeAfterVerify, closeBell, same7, dayText, SOURCE, COLUMNS,
};
