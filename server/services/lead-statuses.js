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
// analytics overview, its rolling median, calculateSourceROI): not a
// non-engaged status, and not a SECOND WIN — a wizard repeat that took the
// booking or accept win keeps its ancestry marker (lead-estimate-link.js),
// and when its original is ALSO won that is one deal credited twice
// (pre-push P1 on #3834 r13). A won repeat whose original is anything else
// (lost by staff, another customer's, vanished) is the only won row the
// deal has and counts (codex #3834 r14 P2); a suppressed repeat is already
// out by status. NULL-safe: no marker, or a marker naming nothing, never
// excludes. Applied through knex .modify() on an unaliased `leads` query.
const SECOND_WIN_SQL = "(leads.status IS DISTINCT FROM 'won' OR NOT EXISTS (SELECT 1 FROM leads o WHERE o.id::text = leads.extracted_data->>'duplicate_of_lead_id' AND o.status = 'won' AND o.deleted_at IS NULL))";
function scopeToProspects(qb) {
  return qb.whereNotIn('status', NON_ENGAGED_LEAD_STATUSES).whereRaw(SECOND_WIN_SQL);
}

module.exports = { NON_ENGAGED_LEAD_STATUSES, OPEN_LEAD_STATUSES, scopeToProspects };
