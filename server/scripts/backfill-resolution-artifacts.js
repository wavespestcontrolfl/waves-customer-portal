#!/usr/bin/env node
/**
 * Backfill resolution_artifacts from historical calls + visits (lane B).
 *
 * DRY-RUN BY DEFAULT: counts what would map without writing. --execute
 * runs the real sweep in batches until the backlog drains (the sweep is
 * incremental + idempotent — safe to re-run, resumes where it left off).
 *
 *   node server/scripts/backfill-resolution-artifacts.js              # dry-run
 *   node server/scripts/backfill-resolution-artifacts.js --execute
 *   node server/scripts/backfill-resolution-artifacts.js --execute --limit 200
 *
 * Embedding of the new artifacts happens via the nightly knowledge-index
 * sync (or scripts/backfill-knowledge-embeddings.js --execute).
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const limitFlag = args.indexOf('--limit');
const BATCH = limitFlag >= 0 ? parseInt(args[limitFlag + 1], 10) : 500;
if (limitFlag >= 0 && (!Number.isInteger(BATCH) || BATCH <= 0)) {
  console.error(`--limit must be a positive integer, got: ${args[limitFlag + 1]}`);
  process.exit(1);
}

(async () => {
  const db = require('../models/db');

  if (!EXECUTE) {
    const [{ count: calls }] = await db('call_log as c')
      .whereNotNull('c.ai_extraction_enriched')
      .whereNotExists(function () {
        this.select(db.raw('1')).from('resolution_artifacts as ra')
          .whereRaw("ra.source = 'call'").whereRaw('ra.source_id = c.id');
      })
      .count('c.id as count');
    const [{ count: visits }] = await db('service_records as sr')
      .whereExists(function () {
        this.select(db.raw('1')).from('service_findings as sf')
          .whereRaw('sf.service_record_id = sr.id').whereNotNull('sf.recommendation');
      })
      .whereNotExists(function () {
        this.select(db.raw('1')).from('resolution_artifacts as ra')
          .whereRaw("ra.source = 'visit'").whereRaw('ra.source_id = sr.id');
      })
      .count('sr.id as count');
    console.log(`DRY RUN (pass --execute to write).\n  unmapped calls with extractions: ${calls}\n  unmapped visits with recommendations: ${visits}`);
    await db.destroy();
    return;
  }

  const { syncResolutionArtifacts } = require('../services/knowledge-index/resolution-sync');
  const total = { calls: 0, visits: 0, skipped: 0 };
  for (;;) {
    const { calls, visits } = await syncResolutionArtifacts({ limit: BATCH });
    total.calls += calls.mapped;
    total.visits += visits.mapped;
    total.skipped += calls.skipped + visits.skipped;
    console.log(`  batch: calls +${calls.mapped} (${calls.skipped} skipped) / visits +${visits.mapped} (${visits.skipped} skipped)`);
    if (calls.exhausted && visits.exhausted) break;
  }
  console.log(`DONE: ${total.calls} call artifacts, ${total.visits} visit artifacts (${total.skipped} skipped as no-knowledge)`);
  await db.destroy();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
