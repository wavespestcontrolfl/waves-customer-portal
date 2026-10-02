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
 * Nothing here writes. `scheduled_services.rides_parent_id` (migration
 * 20260928220000_scheduled_services_rides_parent) is written only by
 * accept-time rider seeding (rider-accept-seeding.js, behind
 * GATE_PEST_RIDES_LAWN_AT_ACCEPT); every candidate pair below is still found
 * by this script's OWN heuristic, never by reading that column, and
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
const { findCandidatePairs, LAWN_PATTERN, PEST_PATTERN } = require('../server/services/rider-series-candidates');

const json = process.argv.includes('--json');
const eligibleOnly = process.argv.includes('--eligible-only');

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
    if (preview.beyondSchedule && preview.beyondSchedule.length) process.stdout.write(`  beyond lawn schedule (${preview.beyondSchedule.length}): ${preview.beyondSchedule.map((r) => `${r.id}@${r.date}`).join(', ')}\n`);
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
          eligible: false, reasons: ['error'], error: err.message, anchor: null, plan: [], keep: [], move: [], insert: [], cancel: [], retained: [], beyondSchedule: [], pinned: [],
        };
      }
      // Reasons this script's OWN candidate-finding decided
      // (property_unresolved when neither root's scope resolves,
      // host_ambiguous/rider_ambiguous when a root is compatible with more
      // than one counterpart) — previewRiderPair has no way to
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
