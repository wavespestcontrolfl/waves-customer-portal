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
const { previewRiderPair } = require('../server/services/rider-series-preview');
const { familyOfServiceRow } = require('../server/services/cancellation-processor');

const json = process.argv.includes('--json');
const eligibleOnly = process.argv.includes('--eligible-only');

const LAWN_PATTERN = 'every_6_weeks';
const PEST_PATTERN = 'quarterly';

// Finds every (lawn every-6-weeks parent, pest quarterly parent) pair at the
// same customer + property — the scope doc's "who's in scope" — from ONE
// read of every ongoing series-root row of either pattern. Grouped by
// customer_id + property_id (an unstamped root's `property_id` is NULL; two
// unstamped roots for the SAME customer are still grouped together — an
// unstamped series lives at the customer's own primary address by
// convention elsewhere in this codebase, e.g.
// recurring-appointment-seeder.js#findActiveRecurringSeries's own duplicate
// scoping — but a stamped root is never matched against an unstamped one,
// since that would silently guess they're the same property).
async function findCandidatePairs(trx) {
  const rows = await trx('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .whereNull('s.recurring_parent_id')
    .where('s.is_recurring', true)
    .where('s.recurring_ongoing', true)
    .whereIn('s.recurring_pattern', [LAWN_PATTERN, PEST_PATTERN])
    .select(
      's.id', 's.customer_id', 's.property_id', 's.recurring_pattern', 's.service_type',
      'sv.service_key', 'sv.name as service_name',
    );

  const byKey = new Map();
  for (const row of rows) {
    const family = familyOfServiceRow({
      ...row, service_key: row.service_key, service_name: row.service_name,
    });
    if (family !== 'lawn_care' && family !== 'pest_control') continue;
    const key = `${row.customer_id}::${row.property_id || 'unstamped'}`;
    if (!byKey.has(key)) byKey.set(key, {});
    const bucket = byKey.get(key);
    if (family === 'lawn_care' && row.recurring_pattern === LAWN_PATTERN) bucket.lawn = row;
    if (family === 'pest_control' && row.recurring_pattern === PEST_PATTERN) bucket.pest = row;
  }

  const pairs = [];
  for (const bucket of byKey.values()) {
    if (bucket.lawn && bucket.pest) {
      pairs.push({
        lawnParentId: bucket.lawn.id,
        pestParentId: bucket.pest.id,
        customerId: bucket.lawn.customer_id,
        propertyId: bucket.lawn.property_id || null,
      });
    }
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
    if (preview.pinned.length) process.stdout.write(`  pinned (${preview.pinned.length}): ${preview.pinned.map((r) => `${r.id}@${r.date || '?'} (${r.why})`).join(', ')}\n`);
  }
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
          eligible: false, reasons: ['error'], error: err.message, anchor: null, plan: [], keep: [], move: [], insert: [], cancel: [], pinned: [],
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
