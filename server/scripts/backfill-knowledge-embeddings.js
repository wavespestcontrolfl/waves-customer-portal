#!/usr/bin/env node
/**
 * Backfill/rebuild the knowledge_embeddings index (lane A2).
 *
 * DRY-RUN BY DEFAULT: prints per-corpus doc/chunk counts and the estimated
 * embedding spend without writing anything. Pass --execute to run the real
 * sync (connector upserts + embedding of pending chunks).
 *
 *   node server/scripts/backfill-knowledge-embeddings.js                # dry-run
 *   node server/scripts/backfill-knowledge-embeddings.js --execute
 *   node server/scripts/backfill-knowledge-embeddings.js --execute --max-embeds 500
 *
 * Requires DATABASE_URL; --execute additionally wants OPENAI_API_KEY (without
 * it, chunks sync for full-text and stay pending for the nightly cron).
 * Prod runs are owner-authorized: `railway run node server/scripts/...`.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const maxFlag = args.indexOf('--max-embeds');
const MAX_EMBEDS = maxFlag >= 0 ? parseInt(args[maxFlag + 1], 10) : undefined;

(async () => {
  const db = require('../models/db');
  const { CONNECTORS, loadCorpus } = require('../services/knowledge-index/connectors');
  const { chunkDocument } = require('../services/knowledge-index/chunker');

  if (!EXECUTE) {
    console.log('DRY RUN (pass --execute to write). Corpus preview:\n');
    let totalChunks = 0;
    let totalChars = 0;
    for (const connector of CONNECTORS) {
      const docs = await loadCorpus(connector);
      if (docs === null) { console.log(`  ${connector.source}: LOAD FAILED (see logs)`); continue; }
      const chunks = docs.flatMap((d) => chunkDocument(d));
      const chars = chunks.reduce((sum, c) => sum + c.text.length, 0);
      totalChunks += chunks.length;
      totalChars += chars;
      console.log(`  ${connector.source}: ${docs.length} docs → ${chunks.length} chunks (${Math.round(chars / 1000)}k chars)`);
    }
    const tokens = Math.round(totalChars / 4);
    console.log(`\n  TOTAL: ${totalChunks} chunks ≈ ${Math.round(tokens / 1000)}k tokens ≈ $${(tokens / 1e6 * 0.02).toFixed(3)} (text-embedding-3-small)`);
    await db.destroy();
    return;
  }

  const { syncKnowledgeIndex } = require('../services/knowledge-index/ingest');
  const summary = await syncKnowledgeIndex({ maxEmbeds: MAX_EMBEDS });
  for (const s of summary.perSource) {
    console.log(s.skipped
      ? `  ${s.source}: SKIPPED (connector error)`
      : `  ${s.source}: ${s.docs} docs / ${s.chunks} chunks — +${s.added} ~${s.updated} -${s.deleted} =${s.unchanged}`);
  }
  const e = summary.embeds;
  console.log(`  embeds: ${e.embedded} embedded, ${e.pending} pending${e.reason ? ` (stopped: ${e.reason})` : ''}`);
  await db.destroy();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
