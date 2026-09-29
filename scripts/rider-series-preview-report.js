#!/usr/bin/env node
/**
 * pest-rides-the-lawn-rhythm — READ-ONLY PREVIEW REPORT.
 *
 * Owner decision 2026-09-28 (see ~/lawn-pest-rhythm-scope-20260928.md): ship
 * a read-only preview first, ahead of the write engine (PR #5268, paused
 * after five non-converging Codex rounds). This script finds every
 * candidate pair — same customer, same property, an active ongoing lawn
 * every-6-weeks series plus an active ongoing quarterly pest series — and
 * prints what services/rider-series-preview.js#previewRiderPair says the
 * pairing would do: whether it's eligible, why (or why not), and the plan.
 *
 * Nothing here writes. `scheduled_services.rides_parent_id` is a schema-only
 * column (migration 20260928220000_scheduled_services_rides_parent) that
 * nothing in this repository sets — every candidate pair below is found by
 * this script's OWN heuristic, never by reading that column, and
 * `previewRiderPair` is called with an explicit hostParentId so it never
 * needs the link to already exist. The whole run is one
 * SET TRANSACTION READ ONLY snapshot.
 *
 * Prints customer/series ids only — never a customer name (matches
 * server/scripts/dunning-adopt-orphans-dry-run.js's own convention: "Prints
 * invoice/customer ids only — never a customer name").
 *
 * Usage (repo root):
 *   node scripts/rider-series-preview-report.js            # human-readable
 *   node scripts/rider-series-preview-report.js --json      # machine-readable
 *   node scripts/rider-series-preview-report.js --eligible-only
 */
require('dotenv').config();

const db = require('../server/models/db');
const { previewRiderPair, resolveSeriesPropertyScope, seriesPropertyVerdict } = require('../server/services/rider-series-preview');
const { familyOfServiceRow } = require('../server/services/cancellation-processor');
const { overlayRecurringTemplateOverrides } = require('../server/services/recurring-template-overrides');
const { EXCLUDED_ROOT_STATUSES } = require('../server/services/recurring-appointment-seeder');
const { normalizedPattern } = require('../server/services/secure-appointment-plans');

const json = process.argv.includes('--json');
const eligibleOnly = process.argv.includes('--eligible-only');

const LAWN_PATTERN = 'every_6_weeks';
const PEST_PATTERN = 'quarterly';

function sortById(rows) {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

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
// pattern. Every qualifying root is kept (not just the last one seen per
// bucket): a customer with more than one qualifying lawn or pest root at
// the same resolved property is reported `host_ambiguous` / `rider_ambiguous`
// for every combination, rather than one pair picked arbitrarily (Codex P2
// round on PR #5290).
//
// Property scope is resolved with the SAME mechanism (and the SAME
// comparator) previewRiderPair's own different_property gate uses —
// resolveSeriesPropertyScope / seriesPropertyVerdict
// (services/rider-series-preview.js), built on the duplicate-series
// guard's own address resolution (admin-schedule.js#topUpScopeInput) — so
// a pair this script buckets together can never fail the preview's own
// gate as a different property, or the reverse (Codex P1 round on PR
// #5290: the old key collapsed every null-property root into one
// 'unstamped' bucket per customer, which the preview's OLD narrower gate
// then never caught as different_property either). A root whose scope
// cannot be resolved at all (no property_id anywhere, no parseable address
// — not even the customer's own primary) never silently joins another
// root's bucket: it gets its own per-customer `property_unresolved`
// bucket, reported rather than dropped.
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

// Clusters ONE customer's qualifying roots into property buckets: a
// RESOLVED root joins the first bucket its scope matches
// (seriesPropertyVerdict === 'same'); an UNRESOLVED root always gets the
// customer's one shared unresolved bucket (conservative — never guessed
// into, or out of, a resolved bucket). Order is deterministic (root id).
async function clusterIntoPropertyBuckets(trx, group) {
  // Sequential: every read shares one transaction connection, and pg
  // rejects concurrent queries on one client (deprecated now, an error in pg 9).
  const scoped = [];
  for (const c of group) scoped.push({ ...c, scope: await resolveSeriesPropertyScope(trx, c.row) });
  const ordered = scoped.sort((a, b) => String(a.row.id).localeCompare(String(b.row.id)));
  const buckets = [];
  let unresolvedBucket = null;
  for (const c of ordered) {
    let bucket = null;
    if (!c.scope.resolved) {
      if (!unresolvedBucket) { unresolvedBucket = { unresolved: true, lawn: [], pest: [] }; buckets.push(unresolvedBucket); }
      bucket = unresolvedBucket;
    } else {
      // A root joins a bucket only when it matches EVERY member's scope, not
      // just the first one's: a street-only scope treats a missing city/ZIP
      // as a wildcard, so matching the first member alone could merge roots
      // from two explicitly different cities, depending on id order.
      bucket = buckets.find((b) => !b.unresolved && b.scopes.every((sc) => seriesPropertyVerdict(sc, c.scope) === 'same'));
      if (!bucket) { bucket = { scope: c.scope, scopes: [], lawn: [], pest: [] }; buckets.push(bucket); }
      bucket.scopes.push(c.scope);
    }
    bucket[c.family === 'lawn_care' ? 'lawn' : 'pest'].push(c.row);
    c.bucket = bucket;
  }
  // A street-only scope treats a missing city/ZIP as a wildcard, so one root
  // can match two buckets that explicitly differ. Never pick one: flag every
  // bucket such a root could belong to as property_ambiguous.
  for (const c of ordered) {
    if (!c.scope.resolved) continue;
    for (const other of buckets) {
      if (other === c.bucket || other.unresolved) continue;
      if (other.scopes.every((sc) => seriesPropertyVerdict(sc, c.scope) === 'same')) {
        other.ambiguous = true;
        c.bucket.ambiguous = true;
        // Join that bucket too, so every compatible pairing is emitted
        // (all flagged property_ambiguous), not just the first bucket's.
        const side = other[c.family === 'lawn_care' ? 'lawn' : 'pest'];
        if (!side.some((r) => String(r.id) === String(c.row.id))) side.push(c.row);
      }
    }
  }
  return buckets;
}

// Every lawn×pest combination for ONE property bucket (finding: keep every
// qualifying root, emit every combination), tagged with every extra reason
// this script's own bucketing decided — property_unresolved for the
// customer's shared unresolved bucket, host_ambiguous/rider_ambiguous when
// the bucket holds more than one qualifying root on either side.
function pairsFromBucket(bucket, customerId) {
  if (!bucket.lawn.length || !bucket.pest.length) return [];
  const extraReasons = [];
  if (bucket.unresolved) extraReasons.push('property_unresolved');
  if (bucket.ambiguous) extraReasons.push('property_ambiguous');
  if (bucket.lawn.length > 1) extraReasons.push('host_ambiguous');
  if (bucket.pest.length > 1) extraReasons.push('rider_ambiguous');
  const propertyId = bucket.unresolved ? null : (bucket.scopes.find((sc) => sc.propertyId)?.propertyId || null);
  const pairs = [];
  for (const lawn of sortById(bucket.lawn)) {
    for (const pest of sortById(bucket.pest)) {
      pairs.push({
        lawnParentId: lawn.id, pestParentId: pest.id, customerId, propertyId, extraReasons,
      });
    }
  }
  return pairs;
}

async function findCandidatePairs(trx) {
  const rows = await trx('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .whereNull('s.recurring_parent_id')
    .where('s.is_recurring', true)
    .where('s.recurring_ongoing', true)
    // Same non-cancelled-root predicate findActiveRecurringSeries applies
    // to ITS own candidate set (Codex P2 round #2 on PR #5290) — a
    // cancelled root's recurring_ongoing flag can still read true (nothing
    // clears it on cancel), so without this a cancelled series still
    // surfaced as a candidate pair.
    // Null-safe: a legacy root with a NULL status is live, and a bare
    // NOT IN would drop it.
    .where((q) => { q.whereNull('s.status').orWhereNotIn('s.status', EXCLUDED_ROOT_STATUSES); })
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
  for (const [customerId, group] of [...byCustomer.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const buckets = await clusterIntoPropertyBuckets(trx, group);
    for (const bucket of buckets) pairs.push(...pairsFromBucket(bucket, customerId));
  }
  return pairs;
}

function printHuman(pair, preview) {
  const propertyLabel = pair.propertyId || 'unstamped';
  process.stdout.write(`\npair  lawn=${pair.lawnParentId}  pest=${pair.pestParentId}  customer=${pair.customerId}  property=${propertyLabel}\n`);
  process.stdout.write(`  eligible: ${preview.eligible}\n`);
  if (preview.reasons.length) process.stdout.write(`  reasons: ${preview.reasons.join(', ')}\n`);
  if (preview.error) process.stdout.write(`  error: ${preview.error}\n`);
  if (preview.anchor) {
    process.stdout.write(`  anchor: ${preview.anchor}  planFloor: ${preview.planFloor}  horizon: ${preview.horizon}\n`);
    process.stdout.write(`  plan (${preview.plan.length}): ${preview.plan.join(', ') || '(none)'}\n`);
    if (preview.keep.length) process.stdout.write(`  keep (${preview.keep.length}): ${preview.keep.map((r) => `${r.id}@${r.date}`).join(', ')}\n`);
    if (preview.move.length) process.stdout.write(`  move (${preview.move.length}): ${preview.move.map((r) => `${r.id} ${r.from} -> ${r.to}`).join(', ')}\n`);
    if (preview.insert.length) process.stdout.write(`  insert (${preview.insert.length}): ${preview.insert.join(', ')}\n`);
    if (preview.cancel.length) process.stdout.write(`  cancel (${preview.cancel.length}): ${preview.cancel.map((r) => `${r.id}@${r.date}`).join(', ')}\n`);
    if (preview.retained && preview.retained.length) process.stdout.write(`  retained (${preview.retained.length}): ${preview.retained.map((r) => `${r.id}@${r.date}`).join(', ')}\n`);
  }
  // Outside the anchor branch: a no_anchor preview can still carry live
  // pinned work (e.g. a rescheduled_pending parent).
  if (preview.pinned.length) process.stdout.write(`  pinned (${preview.pinned.length}): ${preview.pinned.map((r) => `${r.id}@${r.date || '?'} (${r.why})`).join(', ')}\n`);
}

async function main() {
  const report = await db.transaction(async (trx) => {
    await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await trx.raw("SET LOCAL statement_timeout = '30s'");
    const pairs = await findCandidatePairs(trx);
    const results = [];
    for (const pair of pairs) {
      // Sequential — one small, bounded set of candidate pairs, and each
      // preview shares this transaction's own snapshot.
      // Own savepoint per pair: a failed read in one preview rolls back to
      // here and never aborts the shared READ ONLY transaction (25P02),
      // which would otherwise turn every later pair into 'error'.
      let preview;
      try {
        preview = await trx.transaction(async (sp) => {
          const result = await previewRiderPair(sp, {
            riderParentId: pair.pestParentId,
            hostParentId: pair.lawnParentId,
          });
          // previewRiderPair reports a failed read instead of throwing;
          // throw here so the savepoint actually rolls back.
          if (result.error) throw Object.assign(new Error(result.error), { preview: result });
          return result;
        });
      } catch (err) {
        preview = err.preview || {
          eligible: false, reasons: ['error'], error: err.message, anchor: null, plan: [], keep: [], move: [], insert: [], cancel: [], retained: [], pinned: [],
        };
      }
      // Bucket-level reasons this script's OWN candidate-finding decided
      // (property_unresolved when the bucket couldn't be resolved at all,
      // host_ambiguous/rider_ambiguous when the bucket held more than one
      // qualifying root on either side) — previewRiderPair has no way to
      // know about sibling roots, so these are merged in here rather than
      // computed inside the pair-level preview.
      if (pair.extraReasons?.length) {
        preview = {
          ...preview,
          eligible: false,
          reasons: [...new Set([...preview.reasons, ...pair.extraReasons])],
        };
      }
      results.push({ pair, preview });
    }
    return results;
  });

  const shown = eligibleOnly ? report.filter((r) => r.preview.eligible) : report;

  if (json) {
    process.stdout.write(`${JSON.stringify({
      generatedAt: new Date().toISOString(),
      candidatePairs: report.length,
      eligible: report.filter((r) => r.preview.eligible).length,
      results: shown.map((r) => ({ ...r.pair, ...r.preview })),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`[rider-series-preview] ${report.length} candidate pair(s) found (lawn ${LAWN_PATTERN} + pest ${PEST_PATTERN}, same customer + property), ${report.filter((r) => r.preview.eligible).length} eligible\n`);
    for (const { pair, preview } of shown) printHuman(pair, preview);
    if (!report.length) {
      process.stdout.write('[rider-series-preview] no candidate pairs (no ongoing lawn every-6-weeks + pest quarterly series share a customer/property)\n');
    }
  }
}

main()
  .catch((e) => { console.error('[rider-series-preview] failed:', e.message); process.exitCode = 1; })
  .finally(() => db.destroy());
