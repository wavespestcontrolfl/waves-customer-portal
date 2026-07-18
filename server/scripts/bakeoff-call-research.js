#!/usr/bin/env node
/**
 * Pre-backfill model bake-off for the call-research miner — READ-ONLY.
 *
 * Runs the v1 research prompt over a random sample of eligible transcripts
 * with each candidate model side-by-side and prints quality aggregates
 * (request/schema failure rates, verbatim pass rate, chunk counts, tag
 * distribution) plus per-call chunk output for manual spot-checking of
 * quote fidelity and tag accuracy. Writes NOTHING to the database; all
 * printed quotes are redacted.
 *
 *   node server/scripts/bakeoff-call-research.js                         # 20 calls, 3.5-flash vs 2.5-pro
 *   node server/scripts/bakeoff-call-research.js --sample 30
 *   node server/scripts/bakeoff-call-research.js --models gemini-3.5-flash,gemini-2.5-pro
 *
 * Lock the winner via GEMINI_CALL_RESEARCH_MODEL before the backfill. At
 * gemini-3.5-pro GA, re-run and bump only if Pro wins. If both Gemini arms
 * disappoint, wire an Anthropic third arm through llm/call.js before
 * deciding — do not backfill on a losing model.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const sampleFlag = args.indexOf('--sample');
const SAMPLE = sampleFlag >= 0 ? parseInt(args[sampleFlag + 1], 10) : 20;
const modelsFlag = args.indexOf('--models');
const MODELS = modelsFlag >= 0
  ? String(args[modelsFlag + 1] || '').split(',').map((m) => m.trim()).filter(Boolean)
  : ['gemini-3.5-flash', 'gemini-2.5-pro'];
if (!Number.isInteger(SAMPLE) || SAMPLE <= 0 || MODELS.length < 2) {
  console.error('Usage: bakeoff-call-research.js [--sample N] [--models a,b]');
  process.exit(1);
}
const DETAIL_CALLS = 5; // full chunk detail printed for the first N calls

(async () => {
  const db = require('../models/db');
  const { eligibleCallsQuery, extractResearchChunks } = require('../services/call-research-miner');

  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.error('GEMINI_API_KEY not configured.');
    process.exit(1);
  }

  // Sample ANY eligible transcript (mined or not) — the bake-off runs
  // pre-backfill and never writes, so claims are irrelevant here.
  const calls = await eligibleCallsQuery({ onlyUnmined: false })
    .orderByRaw('random()')
    .limit(SAMPLE)
    .select('id', 'customer_id', 'transcription', 'transcript_structured', 'ai_extraction_enriched', 'created_at', 'duration_seconds');
  if (!calls.length) {
    console.log('No eligible transcripts found.');
    await db.destroy();
    return;
  }

  const customerIds = [...new Set(calls.map((c) => c.customer_id).filter(Boolean))];
  const customerById = new Map();
  if (customerIds.length) {
    const customers = await db('customers').whereIn('id', customerIds).select('id', 'first_name', 'last_name', 'phone');
    customers.forEach((c) => customerById.set(c.id, c));
  }

  const stats = {};
  MODELS.forEach((m) => {
    stats[m] = { ok: 0, request_failed: 0, schema_failed: 0, unlabeled: 0, chunks: 0, dropped_not_verbatim: 0, tags: {} };
  });

  console.log(`Bake-off: ${calls.length} sampled calls × ${MODELS.join(' vs ')}\n`);

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const customer = customerById.get(call.customer_id) || null;
    const line = [`call ${i + 1}/${calls.length} (${new Date(call.created_at).toISOString().slice(0, 10)}, ${call.duration_seconds || '?'}s)`];

    for (const model of MODELS) {
      const result = await extractResearchChunks(call, customer, { model });
      const s = stats[model];
      s[result.status] = (s[result.status] || 0) + 1;
      s.chunks += result.chunks.length;
      s.dropped_not_verbatim += (result.dropped && result.dropped.quote_not_verbatim) || 0;
      result.chunks.forEach((c) => { s.tags[c.tag] = (s.tags[c.tag] || 0) + 1; });
      line.push(`${model}: ${result.status === 'ok' ? `${result.chunks.length} chunks [${result.chunks.map((c) => c.tag).join(', ')}]` : result.status}`);

      if (i < DETAIL_CALLS && result.chunks.length) {
        console.log(`  ── ${model} ──`);
        result.chunks.forEach((c) => {
          console.log(`    [${c.tag}|${c.speaker}] "${c.quote}"${c.topics.length ? ` (${c.topics.join(', ')})` : ''}`);
        });
      }
    }
    console.log(`${line.join('\n    ')}\n`);
  }

  console.log('═══ AGGREGATES ═══');
  for (const model of MODELS) {
    const s = stats[model];
    const attempted = calls.length;
    const kept = s.chunks;
    const extractedRaw = kept + s.dropped_not_verbatim;
    const verbatimRate = extractedRaw ? Math.round((kept / extractedRaw) * 100) : 100;
    console.log(`\n${model}`);
    console.log(`  ok ${s.ok}/${attempted} · request_failed ${s.request_failed} · schema_failed ${s.schema_failed} · unlabeled ${s.unlabeled}`);
    console.log(`  chunks kept ${kept} (avg ${(kept / Math.max(1, s.ok)).toFixed(1)}/ok-call) · verbatim pass ${verbatimRate}% (${s.dropped_not_verbatim} dropped)`);
    console.log(`  tags: ${JSON.stringify(s.tags)}`);
  }
  console.log('\nSpot-check the detailed chunks above for quote fidelity + tag accuracy, then lock the winner via GEMINI_CALL_RESEARCH_MODEL.');
  await db.destroy();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
