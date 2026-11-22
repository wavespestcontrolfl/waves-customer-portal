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
 */

const NO_VISIT_QUOTE_LINE = 'We measure your home and yard from county records and satellite images, so most quotes need no visit.';
const NO_VISIT_LINE_VARIABLE = 'estimate_no_visit_line';

function parsed(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// The sentence for a home estimate, '' for every other one. Fails closed: a row that does not say RESIDENTIAL
// (the column default), a proposal, or estimate data that carries any commercial marker gets no line.
function noVisitLineFor(estimate = {}, { proposalMode = false } = {}) {
  if (proposalMode) return '';
  if (String(estimate?.category || '').trim().toUpperCase() !== 'RESIDENTIAL') return '';
  const { isCommercialEstimateData } = require('./estimate-delivery-options');
  if (isCommercialEstimateData(parsed(estimate.estimate_data ?? estimate.estimateData))) return '';
  return NO_VISIT_QUOTE_LINE;
}

module.exports = { NO_VISIT_QUOTE_LINE, NO_VISIT_LINE_VARIABLE, noVisitLineFor };
