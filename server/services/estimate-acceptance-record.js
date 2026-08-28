/**
 * Customer-facing acceptance record for an accepted estimate whose
 * `estimates.terms_version` proves one was committed (GATE_ESTIMATE_ACCEPTANCE_TERMS).
 * ONE helper for every surface that shows or prints it — the public /data
 * payload (page + browser-rendered document), the customer /pdf fallback and
 * the admin PDF download — so no accepted document can omit its record.
 *
 * Deliberately NOT gated: the gate governs display/collection going forward,
 * never evidence already recorded. Masks the IP to two octets and reduces
 * the user-agent to a family label. Null when there is none.
 *
 * `strict` (document generation): a read failure, or a MISSING row where
 * terms_version says one exists, THROWS so the caller fails the document
 * instead of producing an accepted document without its record. Non-strict
 * (the ordinary page): fail-soft, the page still renders, the miss is logged.
 */

const db = require('../models/db');
const logger = require('./logger');
const { maskIpForCustomer, deviceLabelFromUserAgent } = require('./acceptance-terms-text');

async function acceptanceRecordForEstimate(estimate, { strict = false } = {}) {
  if (!estimate || estimate.status !== 'accepted' || !estimate.terms_version) return null;
  try {
    const row = await db('estimate_acceptances')
      .where({ estimate_id: estimate.id })
      .orderBy('accepted_at', 'desc')
      .first();
    if (!row) {
      if (strict) throw new Error(`acceptance record missing for estimate ${estimate.id} (terms_version ${estimate.terms_version})`);
      return null;
    }
    return {
      recordId: `ACC-${String(row.id).slice(0, 8).toUpperCase()}`,
      termsVersion: row.terms_version,
      termsText: row.terms_text,
      acceptedAt: row.accepted_at,
      ipMasked: maskIpForCustomer(row.ip),
      device: deviceLabelFromUserAgent(row.user_agent),
    };
  } catch (e) {
    if (strict) throw e;
    logger.warn(`[estimate-acceptance] record read failed for estimate ${estimate.id}: ${e.message}`);
    return null;
  }
}

/**
 * A phoneless one-time accept commits with NO customer row; when the /book
 * flow later creates the customer and proves ownership of that estimate
 * (phone/email correlation), fan the acceptance ownership out to them:
 * estimates.customer_id, estimate_acceptances.customer_id and the
 * customer-level accepted_terms_version (never downgraded). Idempotent;
 * no-op unless the estimate is accepted with a record and still unowned
 * (GH Codex #3574 r4 P2). Never throws — the booking must not fail on it.
 */
async function attachAcceptanceOwnership(dbh, { estimateId, customerId }) {
  if (!estimateId || !customerId) return false;
  try {
    const estimate = await dbh('estimates').where({ id: estimateId }).first('id', 'status', 'customer_id', 'terms_version');
    if (!estimate || estimate.status !== 'accepted' || !estimate.terms_version || estimate.customer_id) return false;
    await dbh('estimates').where({ id: estimateId }).whereNull('customer_id').update({ customer_id: customerId });
    await dbh('estimate_acceptances').where({ estimate_id: estimateId }).whereNull('customer_id').update({ customer_id: customerId });
    await dbh('customers').where({ id: customerId })
      .where((q) => q.whereNull('accepted_terms_version').orWhere('accepted_terms_version', '<', estimate.terms_version))
      .update({ accepted_terms_version: estimate.terms_version });
    return true;
  } catch (e) {
    logger.warn(`[estimate-acceptance] ownership attach failed for estimate ${estimateId} → customer ${customerId}: ${e.message}`);
    return false;
  }
}

module.exports = { acceptanceRecordForEstimate, attachAcceptanceOwnership };
