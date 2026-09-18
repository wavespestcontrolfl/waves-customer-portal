'use strict';

// Chokepoint rule (delivery-guards slice, re-cut of #4569): no estimate
// sender rechecks annual-offer eligibility itself; every sender passes
// estimateId(s) through to the send library instead, and the two send
// chokepoints (send-customer-message.js, email-template-library.js) are the
// only places that call this guard. #4569 added the same recheck at each
// sender one at a time and never converged (16 open findings across five
// rounds) because the guard lived in the callers. One guard, two callers.

const { annualPlanPublicReplayBlocked } = require('./estimate-offer-version');

// Every column annualPlanOfferFingerprint/annualPlanPublicReplayBlocked read
// (estimate-offer-version.js), plus the id/status/expires_at/estimate_data
// the verdict and callers need. Keep this list in sync with that module's
// fingerprint field list — a column missing here reads as `undefined` on the
// row, which silently narrows the fingerprint rather than erroring.
const FINGERPRINT_COLUMNS = [
  'customer_id', 'property_id', 'estimate_group_id', 'customer_name', 'customer_phone',
  'customer_email', 'address', 'notes', 'monthly_total', 'annual_total', 'onetime_total',
  'show_one_time_option', 'bill_by_invoice', 'waveguard_tier', 'service_interest', 'category', 'source',
];

const ROW_COLUMNS = ['id', 'status', 'expires_at', 'estimate_data', ...FINGERPRINT_COLUMNS];

// The ONE loader every chokepoint (and any future caller) reads the row
// through. `db` may be a knex instance or an open transaction; pass the
// caller's trx to read inside its lock, or nothing for a fresh connection
// read. `forUpdate` locks the row for a caller that is about to mutate it in
// the same transaction (estimate-auto-renew.js's renewal UPDATE); every
// chokepoint recheck itself asks for a fresh, unlocked read instead.
async function loadAnnualOfferRow(db, estimateId, { forUpdate = false } = {}) {
  let query = db('estimates').where({ id: estimateId });
  if (forUpdate) query = query.forUpdate();
  return query.first(...ROW_COLUMNS);
}

// A missing/unknown estimate is not this guard's job to fail on — the
// caller's own required-row checks own that. Only a row that actually
// selects the annual plan and fails annualPlanPublicReplayBlocked's gate/
// fingerprint test is withheld.
function annualOfferVerdict(row) {
  if (!row) return { withheld: false, reason: null };
  const withheld = annualPlanPublicReplayBlocked(row);
  return { withheld, reason: withheld ? 'annual_offer_withheld' : null };
}

// The chokepoint entry point: build once per send with the ids the send
// carries, call immediately before the provider handoff. Rereads every id
// fresh (no lock — a chokepoint recheck must never contend with a sender's
// own transaction) so a fingerprint change or gate flip that lands after the
// caller queued the send is still caught at the actual handoff. Any single
// withheld id blocks the whole send: a grouped/multi-id send shares one
// provider call, so one bad sibling must stop it. Loader errors are not
// caught here — they propagate to the caller, which must treat a guard
// failure as a send failure, never as an allowed send.
function annualHandoffGuard({ db, estimateIds }) {
  const ids = (Array.isArray(estimateIds) ? estimateIds : [estimateIds]).filter((id) => id != null);
  return async () => {
    for (const estimateId of ids) {
      const row = await loadAnnualOfferRow(db, estimateId);
      const verdict = annualOfferVerdict(row);
      if (verdict.withheld) return { blocked: true, reason: verdict.reason, estimateId };
    }
    return { blocked: false, reason: null, estimateId: null };
  };
}

module.exports = { loadAnnualOfferRow, annualOfferVerdict, annualHandoffGuard };
