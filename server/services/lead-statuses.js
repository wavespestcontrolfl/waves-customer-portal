// Statuses that aren't real lead engagement opportunities — exclude them from
// any conversion-rate denominator or "needs action" queue. `lost` and
// `abandoned` are KEPT on purpose: those represent real prospects we worked
// and didn't close, and excluding them would inflate rates. Shared by the
// dashboard KPIs (routes/admin-dashboard.js) and the alerts service
// (services/dashboard-alerts.js) so the definitions can't drift.
const NON_ENGAGED_LEAD_STATUSES = ['cancelled', 'spam', 'duplicate'];

// Statuses still being WORKED — the Pipeline table's default view and the
// population every "needs action" queue draws from. The inverse of the
// closed set (won/lost/unresponsive/disqualified + non-engaged): a queue
// built as whereNotIn(closed-ish) silently re-includes any status it forgot
// (codex P2 on the builder-warranty queue — unresponsive/disqualified leads
// were nagging as action items). Positive membership can't drift that way.
// Shared with routes/admin-leads.js, which expands the virtual `status=open`
// filter to exactly this set.
const OPEN_LEAD_STATUSES = ['new', 'contacted', 'estimate_sent', 'estimate_viewed'];

// Rows counted as prospects by every lead-volume denominator (the leads
// analytics overview and its rolling median, the dashboard lead KPIs, the
// unattributed-leads nag, calculateSourceROI): not a non-engaged status,
// and not a SECOND WIN — a wizard repeat that took the booking or accept
// win keeps its ancestry marker (lead-estimate-link.js), and when the root
// of that ancestry is ALSO won that is one deal credited twice (pre-push P1
// on #3834 r13). A won repeat whose root is anything else (lost by staff,
// another customer's, vanished) is the only won row the deal has and counts
// (codex #3834 r14 P2); a suppressed repeat is already out by status.
// The marker can chain (B → A → O when two repeats raced), so the walk is
// the same bounded, cycle-safe hop-by-hop resolution followDuplicateLink
// does: through live 'duplicate' hops only — a deleted hop or a dead
// marker ends it with no root (pre-push P1 on r14). NULL-safe: no marker,
// or a marker naming nothing, never excludes; a malformed marker fails the
// uuid guard rather than the cast. Applied through knex .modify() on an
// unaliased `leads` query.
const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
const markerUuid = (extracted) => `(CASE WHEN ${extracted}->>'duplicate_of_lead_id' ~ '${UUID_RE}' THEN (${extracted}->>'duplicate_of_lead_id')::uuid END)`;
const SECOND_WIN_SQL = `(leads.status IS DISTINCT FROM 'won' OR NOT EXISTS (
  WITH RECURSIVE chain AS (
    SELECT o.status, o.deleted_at, ${markerUuid('o.extracted_data')} AS parent_id, 1 AS depth
    FROM leads o
    WHERE o.id = ${markerUuid('leads.extracted_data')}
    UNION ALL
    SELECT p.status, p.deleted_at, ${markerUuid('p.extracted_data')}, chain.depth + 1
    FROM chain JOIN leads p ON p.id = chain.parent_id
    WHERE chain.status = 'duplicate' AND chain.deleted_at IS NULL AND chain.depth < 8
  )
  SELECT 1 FROM chain WHERE chain.status = 'won' AND chain.deleted_at IS NULL
))`;
function scopeToProspects(qb) {
  return qb.whereNotIn('status', NON_ENGAGED_LEAD_STATUSES).whereRaw(SECOND_WIN_SQL);
}

module.exports = {
  NON_ENGAGED_LEAD_STATUSES,
  OPEN_LEAD_STATUSES,
  scopeToProspects,
  // exported for tests
  SECOND_WIN_SQL,
};
