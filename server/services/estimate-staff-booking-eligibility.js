/**
 * Can a staff booking accept this open (sent/viewed) estimate? The row-only
 * refusals POST /admin/schedule applies to a linked estimate before it creates
 * any rows, evaluated with the same predicates so the New Appointment form
 * offers its "Link it" button only for a quote the booking would accept:
 *
 *   - a portal plan-start quote (only the customer can accept it),
 *   - a bill-by-invoice proposal that is not won yet,
 *   - a gated add-on whose gate is off, or an area add-on a recurring accept
 *     would drop (persistedAddOnRefusal, standard billing term),
 *   - the retired 4x/quarterly tree-and-shrub cadence.
 *
 * Not covered here, because they depend on the booking being made: the area
 * add-on yearly limits on the booked day and a quote priced for another
 * property (the form already lists only the quotes for the chosen address).
 * Those still refuse at save with the server's own message. Pure; no writes.
 */

function parsedEstimateData(estimate) {
  let data = estimate?.estimate_data || {};
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { data = {}; }
  }
  return data;
}

function staffBookingRefusalForOpenEstimate(estimate) {
  if (!estimate) return { code: 'missing', message: 'No estimate.' };
  const manual = require('./estimate-manual-acceptance');
  const planStart = manual.planStartManualAcceptRefusal(estimate);
  if (planStart) return { code: planStart.code, message: planStart.message };
  const { billByInvoiceProposalAwaitingWin } = require('./bill-by-invoice');
  if (billByInvoiceProposalAwaitingWin(estimate)) return { code: 'proposal_not_won', message: 'Mark this proposal won before booking from it.' };
  const addOn = manual.persistedAddOnRefusal(estimate, { action: 'booking from it', billingTerm: 'standard', checkRecurring: estimate.status !== 'accepted' });
  if (addOn) return { code: addOn.code, message: addOn.message };
  const { recurringTreeShrubRowAtRetiredCadence } = require('../routes/estimate-public');
  if (estimate.status !== 'accepted' && recurringTreeShrubRowAtRetiredCadence(parsedEstimateData(estimate))) {
    return { code: 'RETIRED_TREE_SHRUB_CADENCE', message: 'Retired tree and shrub schedule.' };
  }
  return null;
}

// Fail closed: an unexpected error reads as "not bookable", so no button shows.
function estimateBookableByStaff(estimate) {
  try {
    return staffBookingRefusalForOpenEstimate(estimate) === null;
  } catch {
    return false;
  }
}

module.exports = { staffBookingRefusalForOpenEstimate, estimateBookableByStaff };
