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

// The deposit wording for a "bank saved, now verify it" notice, by Stripe's
// verification type (the SetupIntent's next_action.verify_with_microdeposits
// .microdeposit_type): `descriptor_code` sends ONE deposit whose description
// carries a 6-character code starting with “SM”; `amounts` sends TWO deposits
// whose amounts the customer confirms. An unknown type (a row read back from
// the server, a redirect return) gets wording that is true for both.
// `linkLabel` / `arrival` word the "verify here" link the same way, and
// `actionLabel` a button that starts verification.
export function microdepositSavedPhrases(microdepositType) {
  if (microdepositType === 'descriptor_code') {
    return {
      deposits: 'one small deposit',
      confirmStep: 'enter the 6-character code starting with “SM” from its description',
      linkLabel: 'Enter the code here',
      arrival: 'once it arrives',
      actionLabel: 'Enter the code',
    };
  }
  if (microdepositType === 'amounts') {
    return {
      deposits: 'two small deposits',
      confirmStep: 'confirm the two amounts',
      linkLabel: 'Confirm the deposits here',
      arrival: 'once they arrive',
      actionLabel: 'Confirm the deposits',
    };
  }
  return {
    deposits: 'a small deposit (or two)',
    confirmStep: 'verify your account',
    linkLabel: 'Verify your account here',
    arrival: 'when the deposit information appears',
    actionLabel: 'Verify your account',
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
