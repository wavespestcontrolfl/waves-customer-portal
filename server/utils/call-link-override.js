// The operator's customer link on a call (call_log.metadata.customer_link_override,
// written by PUT /admin/call-recordings/calls/:id/customer). An EXPLICIT UNLINK is
// an override whose customer_id is null: call_log.customer_id is NULL on purpose,
// and every automatic re-attribution — the hourly call-log relink sweep, ads
// attribution recovery — must leave that decision alone. One predicate, so the
// two readers cannot drift (Codex #3764 r1 P1 + r2 P2).
const NOT_EXPLICITLY_UNLINKED_SQL = "((metadata -> 'customer_link_override') IS NULL OR (metadata -> 'customer_link_override' ->> 'customer_id') IS NOT NULL)";

module.exports = { NOT_EXPLICITLY_UNLINKED_SQL };
