import { formatInvoiceDate, isInvoiceDueDateOverdue } from './invoiceDates';

// Only ever link customers to Stripe's own hosted micro-deposit verification
// page — anything else in that field is dropped and the copy falls back to
// "Stripe emailed you a link".
const STRIPE_HOSTED_PREFIX = 'https://payments.stripe.com/';

// Normalize a Stripe PI `next_action.verify_with_microdeposits` object (snake
// case, straight from confirmPayment) into the camel-case detail shape the
// server's 409 payload uses, so both sources feed the same rendering path.
export function microdepositDetailFromNextAction(vwm = {}) {
  const src = vwm || {};
  return {
    microdepositType: src.microdeposit_type || null,
    hostedVerificationUrl: src.hosted_verification_url || null,
    arrivalDate: src.arrival_date || null,
  };
}

// Copy building blocks for the "verify your bank to finish paying" state.
// `descriptor_code` sends ONE deposit carrying a 6-character SM-prefixed code;
// `amounts` sends TWO deposits the customer re-enters. Unknown type (older 409
// payloads, partial reads) gets neutral copy that is correct for both. All
// fields degrade on nulls — missing detail can never block the state itself.
export function microdepositGuidance(detail = {}) {
  const d = detail || {};
  const arrivalSecs = Number(d.arrivalDate);
  const arrivalMs = arrivalSecs > 0 ? arrivalSecs * 1000 : null;
  const arrival = arrivalMs ? formatInvoiceDate(new Date(arrivalMs)) : null;
  // A returning customer may land here AFTER the deposit arrived — "by <past
  // date>" would read as a miss, so shift to "by now".
  const arrivalPassed = !!arrival && isInvoiceDueDateOverdue(new Date(arrivalMs));
  const windowLabel = arrival
    ? (arrivalPassed ? 'by now' : `by ${arrival}`)
    : 'in the next 1–2 business days';
  const depositSentence = d.microdepositType === 'descriptor_code'
    ? 'your bank statement will show one small deposit from Stripe whose description contains a 6-character code starting with “SM” — enter that code to confirm your account and complete the payment.'
    : d.microdepositType === 'amounts'
      ? 'your bank statement will show two small deposits from Stripe — enter those amounts to confirm your account and complete the payment.'
      : 'your bank statement will show a small deposit (or two) from Stripe — use it to confirm your account and complete the payment.';
  const verifyUrl = typeof d.hostedVerificationUrl === 'string'
    && d.hostedVerificationUrl.startsWith(STRIPE_HOSTED_PREFIX)
    ? d.hostedVerificationUrl
    : null;
  return { windowLabel, depositSentence, verifyUrl };
}
