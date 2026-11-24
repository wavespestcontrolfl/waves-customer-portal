/**
 * Can a staff booking accept this open (sent/viewed) estimate? The row-only
 * refusals POST /admin/schedule applies to a linked estimate before it creates
 * any rows, evaluated with the same predicates so the New Appointment form
 * offers its "Link it" button only for a quote the booking would accept:
 *
 *   - a price-locked open row, and any commercial estimate or proposal (linked by hand),
 *   - a portal plan-start quote (only the customer can accept it),
 *   - a bill-by-invoice proposal that is not won yet,
 *   - a gated add-on whose gate is off, or an area add-on a recurring accept
 *     would drop (persistedAddOnRefusal, standard billing term),
 *   - the refusals the accept-on-book runs AFTER the visit is committed, which
 *     would leave the visit booked and the estimate unwon: manualAcceptRowRefusal
 *     (unresolved manager approval, lapsed bid date, missing business type, ...)
 *     and manualAcceptLockedRowRefusal (the retired 4x/quarterly tree-and-shrub
 *     cadence, a non-proposal invoice-mode quote, a one-time option, no owner),
 *     and rowQuarantineRefusal (an active re-price hold, or a call-linkage
 *     correction marker; the call-log reads of assertNotQuarantined stay with the accept).
 *
 * Not covered here, because they depend on the booking being made: the area
 * add-on yearly limits on the booked day and a quote priced for another
 * property (the form already lists only the quotes for the chosen address).
 * Those still refuse at save with the server's own message. Pure; no writes.
 */

function staffBookingRefusalForOpenEstimate(estimate) {
  if (!estimate) return { code: 'missing', message: 'No estimate.' };
  const manual = require('./estimate-manual-acceptance');
  const planStart = manual.planStartManualAcceptRefusal(estimate);
  if (planStart) return { code: planStart.code, message: planStart.message };
  const { billByInvoiceProposalAwaitingWin } = require('./bill-by-invoice');
  if (billByInvoiceProposalAwaitingWin(estimate)) return { code: 'proposal_not_won', message: 'Mark this proposal won before booking from it.' };
  const addOn = manual.persistedAddOnRefusal(estimate, { action: 'booking from it', billingTerm: 'standard', checkRecurring: estimate.status !== 'accepted' });
  if (addOn) return { code: addOn.code, message: addOn.message };
  // The accept-on-book's own row predicates, for a quote that is not accepted yet.
  if (estimate.status !== 'accepted') {
    // A price-locked open row is already claimed by an accept in flight or by a finished one.
    if (estimate.price_locked_at) return { code: 'price_locked', message: 'This estimate is price-locked.' };
    // Commercial quotes and proposals are linked by hand, as before: their win carries invoice terms and a
    // first invoice that the quick link in the booking form does not set up.
    if (String(estimate.category || '').toUpperCase() === 'COMMERCIAL' || manual.isCommercialProposalEstimate(estimate)) {
      return { code: 'commercial', message: 'Commercial estimates are linked by hand.' };
    }
    const accept = manual.manualAcceptRowRefusal(estimate, { billingTerm: 'standard' }) || manual.manualAcceptLockedRowRefusal(estimate);
    if (accept) return { code: accept.code || 'accept_refused', message: accept.message };
    // A re-price hold or a call-linkage correction marker on the row: assertNotQuarantined refuses it after the visit
    // commits. Only the row-only part runs here; the call-log reads stay with the accept.
    const quarantine = manual.rowQuarantineRefusal(estimate);
    if (quarantine) return { code: 'quarantined', message: quarantine.message };
  }
  return null;
}

// Fail closed: an unexpected error reads as "not bookable", so no button shows. `schedulableLineCount`, when given,
// is how many service lines the quote yields in the booking form; a quote with none (quote-required-only items)
// would fill nothing, so it is not offered.
function estimateBookableByStaff(estimate, { schedulableLineCount } = {}) {
  try {
    if (schedulableLineCount === 0) return false;
    return staffBookingRefusalForOpenEstimate(estimate) === null;
  } catch {
    return false;
  }
}

// For a quote tied to no property but carrying a street of its own: the ids of the saved properties that street
// matches (the estimate-vs-property matcher the accept path uses). null when the quote is tied to a property or has no
// address (nothing to contradict); [] when it matches none, or the match cannot be read (unknown = not offered).
function quotedAddressPropertyIds(estimate, propertyRows) {
  if (!estimate || estimate.property_id || !String(estimate.address || '').trim()) return null;
  try {
    const { estimateQuotesCustomerAddress } = require('./estimate-property-linkage');
    return (propertyRows || []).filter((row) => estimateQuotesCustomerAddress(estimate.address, row)).map((row) => String(row.id));
  } catch {
    return [];
  }
}

module.exports = { staffBookingRefusalForOpenEstimate, estimateBookableByStaff, quotedAddressPropertyIds };
