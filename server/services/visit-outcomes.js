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

module.exports = { NON_PERFORMED_VISIT_OUTCOMES, visitWasPerformed };
