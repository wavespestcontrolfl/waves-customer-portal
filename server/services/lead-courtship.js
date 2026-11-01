/**
 * Whether a lead's courtship is still live: ONE predicate shared by the quote
 * wizard's repeat-run dedupe (routes/public-quote.js findPriorOpenWizardLeadId)
 * and the nightly lead repeat sweep (services/lead-repeat-sweep.js), so a lead
 * the wizard would treat as a fresh inquiry is never filed as a repeat at night.
 *
 * A lead whose FK-linked estimate already closed (expired / declined /
 * archived) is not a live courtship (codex #3834 r4 P1). A wizard draft is
 * mirrored through estimates.estimate_data.lead_id, not the FK (the FK is
 * rescued only at send/view), so a draft the office declined, or that expired
 * or was archived, closes the courtship the same way. That is judged on the
 * LATEST mirror: a newer open draft is the live courtship and an older closed
 * one is history (codex #3834 r24 P1, r26 P1). A lead with neither is live.
 *
 * Applied to an UNALIASED `leads` query (the SQL names `leads.id` and the bare
 * `estimate_id`); returns the query for chaining and .modify().
 */

const { OPEN_ESTIMATE_STATUSES } = require('./estimate-automation-duplicates');

function whereLiveCourtship(query) {
  return query
    .whereRaw(
      `(estimate_id IS NULL OR EXISTS (SELECT 1 FROM estimates e WHERE e.id = leads.estimate_id AND e.archived_at IS NULL AND e.status IN (${OPEN_ESTIMATE_STATUSES.map(() => '?').join(', ')})))`,
      OPEN_ESTIMATE_STATUSES,
    )
    .whereRaw(
      `NOT EXISTS (SELECT 1 FROM estimates e WHERE e.id = (SELECT n.id FROM estimates n WHERE n.estimate_data->>'lead_id' = leads.id::text ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AND (e.archived_at IS NOT NULL OR e.status NOT IN (${OPEN_ESTIMATE_STATUSES.map(() => '?').join(', ')})))`,
      OPEN_ESTIMATE_STATUSES,
    );
}

module.exports = { whereLiveCourtship };
