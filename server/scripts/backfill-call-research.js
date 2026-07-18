#!/usr/bin/env node
/**
 * Backfill call_research_chunks from historical call transcripts.
 *
 * DRY-RUN BY DEFAULT: counts what would mine without writing (and without
 * spending Gemini calls). --execute runs the real miner in batches until
 * the backlog drains — the sweep is incremental + idempotent (claims via
 * call_log.research_mined_at), so it is safe to re-run and resumes where
 * it left off. Requires GEMINI_API_KEY; ~625 historical transcripts is a
 * few dollars one-time.
 *
 *   node server/scripts/backfill-call-research.js              # dry-run
 *   node server/scripts/backfill-call-research.js --execute
 *   node server/scripts/backfill-call-research.js --execute --limit 25
 *
 * Run the pre-backfill model bake-off (bakeoff-call-research.js) FIRST and
 * lock the winning model via GEMINI_CALL_RESEARCH_MODEL before executing.
 * Embedding of the new chunks happens via the nightly knowledge-index sync.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const limitFlag = args.indexOf('--limit');
const BATCH = limitFlag >= 0 ? parseInt(args[limitFlag + 1], 10) : 50;
if (limitFlag >= 0 && (!Number.isInteger(BATCH) || BATCH <= 0)) {
  console.error(`--limit must be a positive integer, got: ${args[limitFlag + 1]}`);
  process.exit(1);
}

(async () => {
  const db = require('../models/db');
  const { eligibleCallsQuery, mineCallResearch, GEMINI_CALL_RESEARCH_MODEL } = require('../services/call-research-miner');

  if (!EXECUTE) {
    const [{ count }] = await eligibleCallsQuery().count('call_log.id as count');
    console.log(`DRY RUN (pass --execute to write).\n  unmined eligible transcripts: ${count}\n  extraction model: ${GEMINI_CALL_RESEARCH_MODEL}`);
    await db.destroy();
    return;
  }

  // Same advisory lock as the nightly cron so backfill and the 3:05 run
  // can't mine concurrently; no job_health row for manual runs.
  const { runExclusive } = require('../utils/cron-lock');
  const result = await runExclusive('call-research-miner', async () => {
    const total = { examined: 0, mined: 0, chunks: 0 };
    for (;;) {
      const batch = await mineCallResearch({ limit: BATCH });
      total.examined += batch.examined;
      total.mined += batch.mined;
      total.chunks += batch.chunksInserted;
      console.log(`  batch: ${batch.mined}/${batch.examined} calls mined, +${batch.chunksInserted} chunks, skipped ${JSON.stringify(batch.skipped)}`);
      if (batch.skipped.no_gemini_key || batch.skipped.consent_column_missing) return total;
      if (batch.exhausted) return total;
      if (batch.mined === 0) {
        // Failed extractions are deliberately left unstamped for the nightly
        // retry — but that means a full batch of failures would re-select
        // the SAME calls here and spend Gemini calls forever. Zero progress
        // in a full batch = stop and let the nightly sweep chip at it.
        console.log('  no calls stamped this batch (failures retry nightly) — stopping to avoid re-spending on the same calls');
        return total;
      }
    }
  }, { recordHealth: false });

  if (result && result.skipped === true) {
    console.error(`Another call-research run holds the lease (${result.reason}) — try again later.`);
  } else {
    console.log(`DONE: ${result.mined}/${result.examined} calls mined, ${result.chunks} chunks inserted`);
  }
  await db.destroy();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
