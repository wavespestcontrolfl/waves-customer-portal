// The sticky-stop rule for people a caller named (owner 2026-11-27), as SQL text only: no database access here, so the
// senders (call-visit-recipient.js) and the tracker's final read (track-public.js) share one rule.

// The customer and every record merged into it (a merge that was not undone), at any depth. A merge leaves the list on
// the old record, so a stop saved there still counts for the record that took its visits.
function lineageSql(customerExpr) {
  return `WITH RECURSIVE lineage(id) AS (SELECT (${customerExpr})::uuid UNION SELECT j.loser_customer_id FROM customer_merge_journal j `
    + 'JOIN lineage l ON j.winner_customer_id = l.id WHERE j.undone_at IS NULL) SELECT id FROM lineage';
}

/**
 * The stop rule, as one SQL condition (the senders and the tracker's final read use the same text): a stop on the
 * customer's own list always counts; a stop on the list of a record merged into it counts when it was saved AFTER the
 * customer's own last Restart of that number.
 * A Restart writes only the customer's own row (texts_restarted_at), so undoing a merge leaves the old record's stop as
 * it was. customerExpr / phoneExpr: SQL for the customer id and the 10-digit phone key.
 */
function stoppedSql(customerExpr, phoneExpr) {
  return `EXISTS (SELECT 1 FROM customer_reminder_contacts st WHERE st.phone_key = ${phoneExpr} AND st.texts_stopped_at IS NOT NULL `
    + `AND st.customer_id IN (${lineageSql(customerExpr)}) `
    + `AND (st.customer_id = (${customerExpr})::uuid OR st.texts_stopped_at > COALESCE((SELECT o.texts_restarted_at FROM customer_reminder_contacts o `
    + `WHERE o.customer_id = (${customerExpr})::uuid AND o.phone_key = ${phoneExpr}), '-infinity'::timestamptz)))`;
}

module.exports = { lineageSql, stoppedSql };
