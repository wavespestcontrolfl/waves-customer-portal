'use strict';

// Category stamped on an estimate follow-up email that carries the monthly average
// (GATE_ESTIMATE_FOLLOWUP_MONTHLY_AVERAGE). The stored copy of such an email goes stale
// when the estimate's price changes, so neither stored-copy rail may re-send it:
// transactional-email-provider-retry.js (scheduling, claim and retry) and
// email-bounce-recovery.js (corrected-address replay) skip rows that carry it. The
// follow-up sender releases its stage claim on a provider rejection instead, and the
// next sweep re-runs the touch with fresh copy.
const ESTIMATE_FOLLOWUP_AVERAGE_CATEGORY = 'estimate_followup_monthly_average';

module.exports = { ESTIMATE_FOLLOWUP_AVERAGE_CATEGORY };
