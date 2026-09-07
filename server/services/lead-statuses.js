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
// The estimate a won row's deal closed: the scope its conversion persisted
// (extracted_data.won_estimate_id — a deposit on estimate B converts an
// unlinked repeat), else its own link. Both walks judge "same deal" on this
// scope from BOTH sides: a repeat won on estimate B (unlinked, scope
// persisted) under a root won on estimate A is two deals whichever row is
// asked, before and after the root's own win (pre-push P1s).
const WON_SCOPE_TEXT = (r) => `COALESCE(${r}.extracted_data->>'won_estimate_id', ${r}.estimate_id::text)`;
const secondWinSql = (t) => `(${t}.status IS DISTINCT FROM 'won' OR NOT EXISTS (
  WITH RECURSIVE chain AS (
    SELECT o.status, o.deleted_at, o.customer_id, ${WON_SCOPE_TEXT('o')} AS won_scope, o.phone, o.email, ${markerUuid('o.extracted_data')} AS parent_id, 1 AS depth
    FROM leads o
    WHERE o.id = ${markerUuid(`${t}.extracted_data`)}
    UNION ALL
    SELECT p.status, p.deleted_at, p.customer_id, ${WON_SCOPE_TEXT('p')}, p.phone, p.email, ${markerUuid('p.extracted_data')}, chain.depth + 1
    FROM chain JOIN leads p ON p.id = chain.parent_id
    WHERE chain.status = 'duplicate' AND chain.deleted_at IS NULL AND chain.depth < 8
  )
  SELECT 1 FROM chain
  WHERE chain.status = 'won' AND chain.deleted_at IS NULL
    AND NOT (chain.won_scope IS NOT NULL AND ${WON_SCOPE_TEXT(t)} IS NOT NULL AND chain.won_scope <> ${WON_SCOPE_TEXT(t)})
    AND CASE
      WHEN chain.customer_id IS NOT NULL AND ${t}.customer_id IS NOT NULL THEN chain.customer_id = ${t}.customer_id
      ELSE (${phoneDigits('chain.phone')} <> '' AND ${phoneDigits('chain.phone')} = ${phoneDigits(`${t}.phone`)})
        OR (LOWER(TRIM(COALESCE(chain.email, ''))) <> '' AND LOWER(TRIM(chain.email)) = LOWER(TRIM(${t}.email)))
    END
))`;
const SECOND_WIN_SQL = secondWinSql('leads');
// The mirror of the second-win rule, from the root's side: an OPEN row whose
// ancestry holds a live won repeat of the same opportunity is that deal
// already counted — a repeat's conversion settles the win onto the root's
// funnel row and deliberately leaves the root's lead row open for the
// office to merge (funnel writes are funnel-table only), so without this
// the root and its won repeat are two prospects in every denominator
// (codex #3834 r35 P2). The walk descends the marker chain (a repeat of a
// repeat, B → A → O) through live 'duplicate' hops only, bounded and
// cycle-safe like the ascent; the won row qualifies by the same
// same-opportunity rule (customer link when both linked, else the root's
// current phone or email; never through a different estimate — judged on
// the scope the win persisted, won_estimate_id, else the repeat's link). A root
// staff closed themselves (lost, unresponsive) is left as it is — their
// decision, already excluded from open work. The reverse join is a plain
// text comparison on the marker key so the expression index on it
// (20260905000010) serves the lookup.
const MARKER_TEXT = (extracted) => `${extracted}->>'duplicate_of_lead_id'`;
const openStatusList = OPEN_LEAD_STATUSES.map((s) => `'${s}'`).join(', ');
const wonDescendantSql = (t) => `(${t}.status NOT IN (${openStatusList}) OR NOT EXISTS (
  WITH RECURSIVE down AS (
    SELECT d.id, d.status, d.deleted_at, d.customer_id, ${WON_SCOPE_TEXT('d')} AS won_scope, d.phone, d.email, 1 AS depth
    FROM leads d
    WHERE d.lead_type = 'quote_wizard' AND ${MARKER_TEXT('d.extracted_data')} = ${t}.id::text
    UNION ALL
    SELECT c.id, c.status, c.deleted_at, c.customer_id, ${WON_SCOPE_TEXT('c')}, c.phone, c.email, down.depth + 1
    FROM down JOIN leads c ON c.lead_type = 'quote_wizard' AND ${MARKER_TEXT('c.extracted_data')} = down.id::text
    WHERE down.status = 'duplicate' AND down.deleted_at IS NULL AND down.depth < 8
  )
  SELECT 1 FROM down
  WHERE down.status = 'won' AND down.deleted_at IS NULL
    AND NOT (down.won_scope IS NOT NULL AND ${t}.estimate_id IS NOT NULL AND down.won_scope <> ${t}.estimate_id::text)
    AND CASE
      WHEN down.customer_id IS NOT NULL AND ${t}.customer_id IS NOT NULL THEN down.customer_id = ${t}.customer_id
      ELSE (${phoneDigits('down.phone')} <> '' AND ${phoneDigits('down.phone')} = ${phoneDigits(`${t}.phone`)})
        OR (LOWER(TRIM(COALESCE(down.email, ''))) <> '' AND LOWER(TRIM(down.email)) = LOWER(TRIM(${t}.email)))
    END
))`;
const WON_DESCENDANT_SQL = wonDescendantSql('leads');
// The same scope as a raw fragment, for the correlated COUNT subqueries the
// sources summary builds over an unaliased `leads` (GET /leads/sources).
const PROSPECT_SCOPE_SQL = `leads.status NOT IN (${NON_ENGAGED_LEAD_STATUSES.map((s) => `'${s}'`).join(', ')}) AND ${SECOND_WIN_SQL} AND ${WON_DESCENDANT_SQL}`;
function scopeToProspects(qb, alias = 'leads') {
  return qb.whereNotIn(`${alias}.status`, NON_ENGAGED_LEAD_STATUSES).whereRaw(secondWinSql(alias)).whereRaw(wonDescendantSql(alias));
}

module.exports = {
  NON_ENGAGED_LEAD_STATUSES,
  OPEN_LEAD_STATUSES,
  scopeToProspects,
  PROSPECT_SCOPE_SQL,
  // exported for tests
  SECOND_WIN_SQL,
  WON_DESCENDANT_SQL,
};
