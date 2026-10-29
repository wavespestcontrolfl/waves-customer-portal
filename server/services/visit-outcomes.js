/**
 * Visit outcomes that perform no application.
 *
 * ONE definition, read by the completion route (complete-scheduled-service.js:
 * visitPerformed, which gates the completion invoice AND the auto-charge of an
 * existing open invoice) and by the Intelligence Bar billing type card (which
 * words the per-application line from the same list).
 */
const NON_PERFORMED_VISIT_OUTCOMES = Object.freeze(['inspection_only', 'customer_declined']);

const visitWasPerformed = (visitOutcome) => !NON_PERFORMED_VISIT_OUTCOMES.includes(visitOutcome);

// Closeout outcomes after which a saved-card charge must not run: the two non-performed outcomes plus 'incomplete'.
const NON_CHARGEABLE_CLOSEOUT_OUTCOMES = Object.freeze([...NON_PERFORMED_VISIT_OUTCOMES, 'incomplete']);

/**
 * Whether a visit's CURRENT closeout (its latest service_records row: status, structured_notes) is a performed
 * visit a saved-card charge may rest on (stripe.js chargeInvoiceWithSavedCard requirePerformedVisit). Pure.
 * - the record must be completed, and its visitOutcome must not be inspection_only, customer_declined or incomplete;
 * - a backfill closeout never counts (the completion route moves no money for one), with ONE opt-in exception:
 *   issuedCloseoutInvoiceId names the invoice being charged, and the record is the issued-invoice closeout job's own
 *   (visitOutcome 'completed', backfill true, structured_notes.issuedInvoiceCloseout.invoiceId = that invoice).
 *   A manual backfill without that marker, or a marker for another invoice, still does not count.
 */
function closeoutPerformedForCharge(record, { issuedCloseoutInvoiceId = null } = {}) {
  if (!record || String(record.status || '') !== 'completed') return false;
  let notes = record.structured_notes;
  if (typeof notes === 'string') { try { notes = JSON.parse(notes); } catch { notes = null; } }
  const outcome = String(notes?.visitOutcome || '');
  if (NON_CHARGEABLE_CLOSEOUT_OUTCOMES.includes(outcome)) return false;
  if (String(notes?.backfill || '') !== 'true') return true;
  return issuedCloseoutInvoiceId != null && outcome === 'completed'
    && String(notes?.issuedInvoiceCloseout?.invoiceId || '') === String(issuedCloseoutInvoiceId);
}

module.exports = { NON_PERFORMED_VISIT_OUTCOMES, visitWasPerformed, closeoutPerformedForCharge };
