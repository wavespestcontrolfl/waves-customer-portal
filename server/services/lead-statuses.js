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

module.exports = { NON_ENGAGED_LEAD_STATUSES, OPEN_LEAD_STATUSES };
