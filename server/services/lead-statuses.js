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
// marker ends it with no root (pre-push P1 on r14). A won root counts only
// when it is the same opportunity by the rule the accept path applies
// (leadMatchesEstimateContact): the same customer when both rows are
// linked, otherwise the root's CURRENT phone or email still matches the
// repeat's — a repeat promoted BECAUSE its root is another customer's
// already-won lead (a shared household contact), or an unlinked root whose
// contact staff corrected since, is that customer's own conversion (codex
// #3834 r15 P2, r16 P2) — and never through a DIFFERENT estimate: a root
// won on estimate X while the repeat was won on estimate Y is a different
// deal, exactly as the accept path promotes it (r17 P2). NULL-safe: no
// marker, or a marker naming nothing,
// never excludes; a malformed marker fails the uuid guard rather than the
// cast. Applied through knex .modify() on a `leads` query — unaliased, or
// with the alias passed (`scopeToProspects(qb, 'l')`, the dashboard
// breakdowns, codex #3834 r18 P2) — or spliced raw (PROSPECT_SCOPE_SQL)
// into a correlated subquery over an unaliased `leads`.
const UUID_RE = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
// Last 10 digits — the phone identity the wizard lookup and the link
// resolver's normalizePhone agree on (a leading country code drops away).
const phoneDigits = (col) => `right(regexp_replace(COALESCE(${col}, ''), '[^0-9]', '', 'g'), 10)`;
const markerUuid = (extracted) => `(CASE WHEN ${extracted}->>'duplicate_of_lead_id' ~ '${UUID_RE}' THEN (${extracted}->>'duplicate_of_lead_id')::uuid END)`;
const secondWinSql = (t) => `(${t}.status IS DISTINCT FROM 'won' OR NOT EXISTS (
  WITH RECURSIVE chain AS (
    SELECT o.status, o.deleted_at, o.customer_id, o.estimate_id, o.phone, o.email, ${markerUuid('o.extracted_data')} AS parent_id, 1 AS depth
    FROM leads o
    WHERE o.id = ${markerUuid(`${t}.extracted_data`)}
    UNION ALL
    SELECT p.status, p.deleted_at, p.customer_id, p.estimate_id, p.phone, p.email, ${markerUuid('p.extracted_data')}, chain.depth + 1
    FROM chain JOIN leads p ON p.id = chain.parent_id
    WHERE chain.status = 'duplicate' AND chain.deleted_at IS NULL AND chain.depth < 8
  )
  SELECT 1 FROM chain
  WHERE chain.status = 'won' AND chain.deleted_at IS NULL
    AND NOT (chain.estimate_id IS NOT NULL AND ${t}.estimate_id IS NOT NULL AND chain.estimate_id <> ${t}.estimate_id)
    AND CASE
      WHEN chain.customer_id IS NOT NULL AND ${t}.customer_id IS NOT NULL THEN chain.customer_id = ${t}.customer_id
      ELSE (${phoneDigits('chain.phone')} <> '' AND ${phoneDigits('chain.phone')} = ${phoneDigits(`${t}.phone`)})
        OR (LOWER(TRIM(COALESCE(chain.email, ''))) <> '' AND LOWER(TRIM(chain.email)) = LOWER(TRIM(${t}.email)))
    END
))`;
const SECOND_WIN_SQL = secondWinSql('leads');
// The same scope as a raw fragment, for the correlated COUNT subqueries the
// sources summary builds over an unaliased `leads` (GET /leads/sources).
const PROSPECT_SCOPE_SQL = `leads.status NOT IN (${NON_ENGAGED_LEAD_STATUSES.map((s) => `'${s}'`).join(', ')}) AND ${SECOND_WIN_SQL}`;
function scopeToProspects(qb, alias = 'leads') {
  return qb.whereNotIn(alias === 'leads' ? 'status' : `${alias}.status`, NON_ENGAGED_LEAD_STATUSES).whereRaw(secondWinSql(alias));
}

module.exports = {
  NON_ENGAGED_LEAD_STATUSES,
  OPEN_LEAD_STATUSES,
  scopeToProspects,
  PROSPECT_SCOPE_SQL,
  // exported for tests
  SECOND_WIN_SQL,
};
