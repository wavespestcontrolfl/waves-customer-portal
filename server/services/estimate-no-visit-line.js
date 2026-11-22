'use strict';

/**
 * How Waves quotes without a visit, in one sentence (owner 2026-11-21, his exact words).
 *
 * In the four weeks to Nov 15, 9 of 16 calls about how the estimate works asked whether someone comes out to quote.
 * Two places say the sentence:
 *   - the office's call script line (services/csr/weekly-call-outcomes.js), and
 *   - the estimate email, as the payload variable {{estimate_no_visit_line}} that migration 20261122030000 put in a
 *     paragraph under the price rows of estimate.delivery.
 *
 * The email carries it for a home estimate only. estimate.delivery also goes out for a commercial estimate that has
 * no proposal, and the sentence speaks of a home and yard. The renderer drops a paragraph whose content renders
 * blank, so an estimate that is not a home estimate gets the email it got before.
 *
 * The rule reads the ESTIMATE, never the account: a business owner's quote for their own house is a home estimate.
 * Measured on the estimates sent in the 90 days to Nov 21: 176 of the 183 residential ones get the line. The other
 * seven are six condos and one row with a commercial mark.
 */

const logger = require('./logger');

const NO_VISIT_QUOTE_LINE = 'We measure your home and yard from county records and satellite images, so most quotes need no visit.';
const NO_VISIT_LINE_VARIABLE = 'estimate_no_visit_line';

// The sentence for a home estimate, '' for every other one. Fails closed, in three steps:
// - a proposal gets none;
// - a row whose category is not RESIDENTIAL (the column default) gets none;
// - a row that says commercial anywhere gets none. isCommercialEstimateRow (plan-start-eligibility.js) is the one
//   full reading of that: the tier, the service label, a proposal or its scaffold, and every commercial mark or
//   commercial service key in the estimate data (the scans of the save and of the booking path are inside it).
//   It gets the estimate data as the row holds it: the check parses a serialized payload itself, and it reads a
//   payload that is one plain text (a bare service key such as "commercial_pest") too.
//   It is asked with a manager present (its strictest reading), because the role of the contact is on the customer
//   and an optional line does not earn a customer lookup in the send path. Under that reading a condo says
//   commercial whoever the contact is: a condo's contact can be its property manager, and a condo has no yard.
//   A single-family home, a townhome, a duplex and a mobile home read as homes under both readings.
// The line is optional and the estimate email is not: a row that cannot be read gets no line, never a failed send.
function noVisitLineFor(estimate = {}, { proposalMode = false } = {}) {
  if (proposalMode) return '';
  if (String(estimate?.category || '').trim().toUpperCase() !== 'RESIDENTIAL') return '';
  try {
    const { isCommercialEstimateRow } = require('./plan-start-eligibility');
    const row = { ...estimate, estimate_data: estimate.estimate_data ?? estimate.estimateData };
    return isCommercialEstimateRow(row, true) ? '' : NO_VISIT_QUOTE_LINE;
  } catch (err) {
    logger.warn(`[estimate-no-visit-line] estimate ${estimate?.id || '(no id)'} could not be read as home or commercial; no line: ${err.message}`);
    return '';
  }
}

module.exports = { NO_VISIT_QUOTE_LINE, NO_VISIT_LINE_VARIABLE, noVisitLineFor };
