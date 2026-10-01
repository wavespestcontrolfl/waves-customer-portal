// GATE_PAF_EXISTING_CUSTOMERS (owner ruling 2026-10-01, GitHub Codex #5481):
// the ONE answer to "when is this selection billed, and what does the customer
// authorize?" for an existing customer on the pay-after-first-visit rail. Every
// estimate-page surface that describes payment timing (payment options, the
// capture form, the capture modal, the review line) and the accept attestation
// read this object, never their own flags, so they cannot disagree.
//
// Inputs: the server's cohort flags (/data recurringCardPolicy), the selection's
// invoice shape, and the accept's per-selection answer when it refused a
// confirm (409 PAYMENT_TIMING_REFRESH / CONSENT_VARIANT_STALE): `timingAnswer`
// `{ key, deferred }`, honored only for the selection it was given for.
//
// Returns null outside the cohort (annual prepay, one-time, any customer the
// sub-gate did not move), where every surface keeps its existing copy.

export const FIRST_INVOICE_AT_CONFIRM_COPY = 'Your first invoice is sent when you confirm, with a link to pay it.';

// The held cohorts, in precedence order (a customer can be both paused and
// opted out; the paused copy wins).
const HELD_FLAGS = [['afterVisitPaused', 'paused'], ['afterVisitAutopayOff', 'off']];

// When the first standard invoice goes out, first matching rule wins: at
// confirm (the accept said so, or a setup-only invoice, minted unattached with
// its pay link), after the first visit (the accept said so, or a
// first-application invoice attached to it), else there is none to describe.
const FIRST_INVOICE_RULES = [
  [(answer, shape) => answer === false || (answer === null && shape.setupOnly === true), 'at_confirm'],
  [(answer, shape) => answer === true || shape.hasFirstVisitInvoice === true, 'after_visit'],
];

export function resolvePaymentTiming({
  policy, paymentPreference, serviceMode, invoiceShape, selectionKey = '', timingAnswer,
} = {}) {
  if (paymentPreference === 'prepay_annual' || serviceMode === 'one_time') return null;
  const flags = policy || {};
  const answer = timingAnswer?.key === selectionKey ? timingAnswer.deferred === true : null;
  if (flags.afterVisitExisting !== true && answer !== true) return null;
  const held = HELD_FLAGS.find(([flag]) => flags[flag] === true)?.[1] || null;
  const firstInvoice = FIRST_INVOICE_RULES.find(([applies]) => applies(answer, invoiceShape || {}))?.[1] || 'none';
  return {
    held,
    firstInvoice,
    // The "charged after your first visit" card authorization: only a fresh
    // card capture the server offered it for, never a held cohort, never when
    // the first invoice goes out at confirm.
    consentVariant: !held && firstInvoice !== 'at_confirm' && flags.afterVisitConsent === true
      ? 'after_visit_card' : null,
    // The accept verifies this attestation against the invoice it really
    // defers (PAYMENT_TIMING_REFRESH on any difference).
    attestTiming: firstInvoice === 'after_visit',
  };
}

// The capture surfaces' (InlineAutoPayCapture / RecurringCardModal) props,
// derived from the one answer so they cannot drift from it.
export function captureTimingProps(timing) {
  return {
    afterVisit: timing?.consentVariant === 'after_visit_card',
    paused: timing?.held === 'paused',
    autopayOff: timing?.held === 'off',
    firstInvoiceNow: timing?.firstInvoice === 'at_confirm',
  };
}
