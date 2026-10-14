'use strict';

// PORTAL SELF-CANCEL fact for the texting AI (owner 2026-10-08; Codex #6152
// r1-r3). The portal's Plan tab shows Account Options → Cancel only when the
// shared hasCancellableWork verdict is true — the same verdict POST
// /api/requests enforces. The drafter must not approximate it from other
// facts (three proxies drifted in review), so this module asks the one
// predicate and renders one fixed line the prompt rule keys on.
//
// Fail closed: gate off, no customer, an inactive customer or a lookup error
// all read "not available", and the reply then never points at the control.

const db = require('../models/db');
const logger = require('./logger');

const PORTAL_CANCEL_FACT_LABEL = 'PORTAL SELF-CANCEL:';
const PORTAL_CANCEL_AVAILABLE_LINE = `${PORTAL_CANCEL_FACT_LABEL} available (customer portal, Plan tab, Account Options)`;
const PORTAL_CANCEL_UNAVAILABLE_LINE = `${PORTAL_CANCEL_FACT_LABEL} not available`;

/**
 * true only when the portal would render the cancel control for this customer
 * right now: an active, undeleted account (a cancelled account gets the
 * cancelled view, with no Account Options) that the shared verdict says has
 * something to cancel.
 */
async function fetchPortalCancelAvailable({ customerId, dbh = db } = {}) {
  if (!customerId) return false;
  try {
    const row = await dbh('customers').where({ id: customerId }).first('active', 'deleted_at');
    if (!row || row.active !== true || row.deleted_at) return false;
    const { hasCancellableWork } = require('./cancellation-eligibility');
    return (await hasCancellableWork(customerId)) === true;
  } catch (err) {
    logger.warn(`[sms-portal-cancel-fact] verdict unavailable for ${customerId}: ${err.message}`);
    return false;
  }
}

/** The one rendered line. Anything but an explicit true is "not available". */
function portalCancelFactLine(available) {
  return available === true ? PORTAL_CANCEL_AVAILABLE_LINE : PORTAL_CANCEL_UNAVAILABLE_LINE;
}

/** Reader for the rendered facts block (exact line, so a quoted customer text cannot forge it). */
function factsSayPortalCancelAvailable(factsBlock) {
  return String(factsBlock || '').split('\n').some((line) => line === PORTAL_CANCEL_AVAILABLE_LINE);
}

module.exports = {
  PORTAL_CANCEL_FACT_LABEL,
  PORTAL_CANCEL_AVAILABLE_LINE,
  PORTAL_CANCEL_UNAVAILABLE_LINE,
  fetchPortalCancelAvailable,
  portalCancelFactLine,
  factsSayPortalCancelAvailable,
};
