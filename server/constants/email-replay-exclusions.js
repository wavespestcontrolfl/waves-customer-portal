'use strict';

// Category stamped on an estimate follow-up email that carries the monthly average
// (GATE_ESTIMATE_FOLLOWUP_MONTHLY_AVERAGE). The stored copy of such an email goes stale
// when the estimate's price changes, so neither stored-copy rail may re-send it:
// transactional-email-provider-retry.js (scheduling, claim and retry) and
// email-bounce-recovery.js (corrected-address replay) skip rows that carry it. The
// follow-up sender releases its stage claim on a provider rejection instead, and the
// next sweep re-runs the touch with fresh copy.
const ESTIMATE_FOLLOWUP_AVERAGE_CATEGORY = 'estimate_followup_monthly_average';

// Category stamped on a reschedule or cancellation email (GATE_MOVE_NOTICE_EMAIL,
// appointment-email.js). Its copy is true only while the visit stays as it says
// (still at the quoted slot, or still cancelled under the same notice), which the
// sender proves at its own dispatch boundary. A stored copy re-sent later would
// skip that proof, so neither stored-copy rail re-sends it: a blocked or bounced
// one settles as not sent, and the visit's later reminders carry the current details.
const MOVE_NOTICE_CATEGORY = 'appointment_move_notice';

// Category stamped on an email sent with a CC (email-template-library.js sendTemplate `cc`,
// the invoice Send's copy to a second address). The stored-copy rails replay to one address,
// so a replay would quietly drop the copy: neither rail re-sends it.
const CARBON_COPY_CATEGORY = 'email_cc';

// Every category whose stored copy is never re-sent, with the reason a stopped
// provider retry records.
const NO_STORED_COPY_REPLAY = new Map([
  [ESTIMATE_FOLLOWUP_AVERAGE_CATEGORY, 'Not re-sent from stored copy (monthly average may be stale).'],
  [MOVE_NOTICE_CATEGORY, 'Not re-sent from stored copy (the visit may have changed since).'],
  [CARBON_COPY_CATEGORY, 'Not re-sent from stored copy (it was copied to a second address).'],
]);

// The stop reason for a message's categories (an array), or null when its stored copy may be re-sent.
function staleStoredCopyReason(categories) {
  const hit = categories.find((category) => NO_STORED_COPY_REPLAY.has(category));
  return hit ? NO_STORED_COPY_REPLAY.get(hit) : null;
}

module.exports = { ESTIMATE_FOLLOWUP_AVERAGE_CATEGORY, MOVE_NOTICE_CATEGORY, CARBON_COPY_CATEGORY, NO_STORED_COPY_REPLAY, staleStoredCopyReason };
