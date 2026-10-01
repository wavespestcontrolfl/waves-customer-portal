/**
 * Rider-series candidate discovery (shared): finds every (lawn every-6-weeks
 * parent, pest quarterly parent) pair for the same customer at the same
 * resolved property — the pairing heuristic behind
 * scripts/rider-series-preview-report.js, extracted verbatim so the one-time
 * apply script (scripts/rider-series-apply-approved.js) re-runs the SAME
 * discovery inside its transaction instead of a copy. Read-only: plain
 * SELECTs on the caller's connection. Optional `customerId` narrows the root
 * scan to one customer (the per-customer grouping is unchanged).
 */
const { resolveSeriesPropertyScope, seriesPropertyVerdict } = require('./rider-series-preview');
const { familyOfServiceRow } = require('./cancellation-processor');
const { overlayRecurringTemplateOverrides } = require('./recurring-template-overrides');
const { EXCLUDED_ROOT_STATUSES } = require('./recurring-appointment-seeder');
const { normalizedPattern } = require('./secure-appointment-plans');

const LAWN_PATTERN = 'every_6_weeks';
const PEST_PATTERN = 'quarterly';

// Classifies ONE candidate root by its CURRENT template (Codex P2 round on
// PR #5290): a series reassigned via recurring_template_overrides (an
// admin edit under GATE_EDIT_APPT_PRICE_SERVICE_SCOPE — overlayRecurringTemplateOverrides
// is itself a no-op when that gate is off, same as everywhere else it's
// applied) is classified by its FUTURE service, not its original one —
// the same rule findActiveRecurringSeries's own duplicate-series scan
// applies to both sides of ITS compare. When the override redirects
// service_id, the catalog identity (service_key/name) is re-resolved from
// the NEW service via `serviceMap` rather than the row's original join,
// since familyOfServiceRow reads the catalog fields, not the id.
function classifyCandidate(row, serviceMap) {
  const overlaid = overlayRecurringTemplateOverrides(row, { recurring_template_overrides: true });
  let serviceKey = row.service_key;
  let serviceName = row.service_name;
  // Any change of effective service_id (including to null, a static
  // fallback service) drops the historical join's catalog identity, so
  // familyOfServiceRow can't classify the series under its old family.
  if (String(overlaid.service_id ?? '') !== String(row.service_id ?? '')) {
    const svc = overlaid.service_id != null ? serviceMap.get(String(overlaid.service_id)) : null;
    serviceKey = svc ? svc.service_key : null;
    serviceName = svc ? svc.name : null;
  }
  const family = familyOfServiceRow({ ...overlaid, service_key: serviceKey, service_name: serviceName });
  return family;
}

// Finds every (lawn every-6-weeks parent, pest quarterly parent) pair for
// the same customer at the SAME resolved property — the scope doc's "who's
// in scope" — from ONE read of every ongoing series-root row of either
// pattern. Every qualifying root is kept, and every compatible lawn/pest
// combination is emitted; a root compatible with more than one counterpart
// is reported `host_ambiguous` / `rider_ambiguous` rather than one pair
// picked arbitrarily (see pairsForCustomer).
//
// Property scope is resolved with the SAME mechanism (and the SAME
// comparator) previewRiderPair's own different_property gate uses —
// resolveSeriesPropertyScope / seriesPropertyVerdict
// (services/rider-series-preview.js), built on the duplicate-series
// guard's own address resolution (admin-schedule.js#topUpScopeInput) — so
// a pair this script emits can never fail the preview's own
// gate as a different property, or the reverse (Codex P1 round on PR
// #5290: the old key collapsed every null-property root into one
// 'unstamped' bucket per customer, which the preview's OLD narrower gate
// then never caught as different_property either). A root whose scope
// cannot be resolved at all (no property_id anywhere, no parseable address
// — not even the customer's own primary) is never paired with a resolved
// root; it pairs only with other unresolved roots, reported as
// `property_unresolved` rather than dropped.
// Every qualifying root, classified and grouped by customer (Codex P2 round
// on PR #5290 — findCandidatePairs' own complexity). Keeps EVERY qualifying
// root, not just the last one seen — the caller decides ambiguity.
function classifyAndGroupByCustomer(rows, serviceMap) {
  const byCustomer = new Map();
  for (const row of rows) {
    const family = classifyCandidate(row, serviceMap);
    if (family !== 'lawn_care' && family !== 'pest_control') continue;
    // The admin modal stores every-6-weeks as 'custom' + 42 days; the shared
    // normalizer maps it, as the prepay-on-book path does.
    const pattern = normalizedPattern(row);
    if (family === 'lawn_care' && pattern !== LAWN_PATTERN) continue;
    if (family === 'pest_control' && pattern !== PEST_PATTERN) continue;
    const key = String(row.customer_id);
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push({ row, family });
  }
  return byCustomer;
}

// Every compatible lawn/pest pair for ONE customer, found pairwise: a lawn
// root and a pest root pair when their resolved scopes match
// (seriesPropertyVerdict === 'same'), or when neither scope resolves
// (property_unresolved; an unresolved root is never paired with a resolved
// one). No buckets: a street-only scope is a wildcard for city/ZIP, so
// compatibility isn't transitive, and grouping roots first either merged
// incompatible roots or lost valid pairs. A root compatible with more than
// one counterpart flags host_ambiguous / rider_ambiguous. Order is by id.
async function pairsForCustomer(trx, group, customerId) {
  // Sequential: every read shares one transaction connection, and pg
  // rejects concurrent queries on one client (deprecated now, an error in pg 9).
  const scoped = [];
  for (const c of group) scoped.push({ ...c, scope: await resolveSeriesPropertyScope(trx, c.row) });
  const byId = (a, b) => String(a.row.id).localeCompare(String(b.row.id));
  const lawns = scoped.filter((c) => c.family === 'lawn_care').sort(byId);
  const pests = scoped.filter((c) => c.family === 'pest_control').sort(byId);
  const compatible = (l, p) => (l.scope.resolved && p.scope.resolved
    ? seriesPropertyVerdict(l.scope, p.scope) === 'same'
    : !l.scope.resolved && !p.scope.resolved);
  const edges = [];
  for (const l of lawns) for (const p of pests) if (compatible(l, p)) edges.push([l, p]);
  const count = (root) => edges.filter(([l, p]) => l === root || p === root).length;
  return edges.map(([l, p]) => {
    const extraReasons = [];
    if (!l.scope.resolved) extraReasons.push('property_unresolved');
    if (count(p) > 1) extraReasons.push('host_ambiguous');
    if (count(l) > 1) extraReasons.push('rider_ambiguous');
    return {
      lawnParentId: l.row.id,
      pestParentId: p.row.id,
      customerId,
      propertyId: l.scope.propertyId || p.scope.propertyId || null,
      extraReasons,
    };
  });
}

async function findCandidatePairs(trx, { customerId = null } = {}) {
  const rows = await trx('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .whereNull('s.recurring_parent_id')
    .where('s.is_recurring', true)
    .modify((q) => { if (customerId) q.where('s.customer_id', customerId); })
    .where('s.recurring_ongoing', true)
    // Same non-cancelled-root predicate findActiveRecurringSeries applies
    // to ITS own candidate set (Codex P2 round #2 on PR #5290) — a
    // cancelled root's recurring_ongoing flag can still read true (nothing
    // clears it on cancel), so without this a cancelled series still
    // surfaced as a candidate pair.
    // Null-safe: a legacy root with a NULL status is live, and a bare
    // NOT IN would drop it.
    .where((q) => { q.whereNull('s.status').orWhereNotIn('s.status', EXCLUDED_ROOT_STATUSES); })
    // A root the tracker already cancelled is gone even if its status sync
    // lagged (null-safe: no tracker state is fine).
    .where((q) => { q.whereNull('s.track_state').orWhereNot('s.track_state', 'cancelled'); })
    .where((q) => {
      q.whereIn('s.recurring_pattern', [LAWN_PATTERN, PEST_PATTERN])
        .orWhere((c) => { c.where('s.recurring_pattern', 'custom').where('s.recurring_interval_days', 42); });
    })
    .select(
      's.id', 's.customer_id', 's.property_id', 's.recurring_pattern', 's.recurring_interval_days', 's.service_type', 's.service_id',
      's.recurring_template_overrides', 's.source_estimate_id',
      // Codex P2 round #2 on PR #5290: resolveSeriesPropertyScope (via
      // topUpScopeInput) reads these stamped address fields too — omitting
      // them collapsed every root with a distinct visit-level address stamp
      // (never an unstamped root's own estimate/customer fallback) onto the
      // primary/customer address, mis-bucketing distinct properties as one.
      's.service_address_line1', 's.service_address_line2', 's.service_address_city',
      's.service_address_state', 's.service_address_zip',
      'sv.service_key', 'sv.name as service_name',
    );
  if (!rows.length) return [];

  const serviceMap = new Map((await trx('services').select('id', 'service_key', 'name'))
    .map((s) => [String(s.id), s]));
  const byCustomer = classifyAndGroupByCustomer(rows, serviceMap);

  const pairs = [];
  for (const [groupCustomerId, group] of [...byCustomer.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    pairs.push(...await pairsForCustomer(trx, group, groupCustomerId));
  }
  return pairs;
}

module.exports = { findCandidatePairs, LAWN_PATTERN, PEST_PATTERN };
