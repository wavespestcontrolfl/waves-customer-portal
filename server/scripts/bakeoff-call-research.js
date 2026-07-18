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
 *   node server/scripts/bakeoff-call-research.js                    # 20 calls, locked route vs gemini-2.5-pro
 *   node server/scripts/bakeoff-call-research.js --sample 30
 *   node server/scripts/bakeoff-call-research.js --models openai:gpt-5.6-sol,gemini:gemini-2.5-pro,anthropic:claude-opus-4-8
 *
 * Arms are provider:model pairs. Lock the winner via CALL_RESEARCH_PROVIDER
 * / CALL_RESEARCH_MODEL before the backfill; re-run at major model GAs and
 * bump only on a win — do not backfill on a losing model.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const sampleFlag = args.indexOf('--sample');
const SAMPLE = sampleFlag >= 0 ? parseInt(args[sampleFlag + 1], 10) : 20;
const modelsFlag = args.indexOf('--models');
const ARM_SPECS = modelsFlag >= 0
  ? String(args[modelsFlag + 1] || '').split(',').map((m) => m.trim()).filter(Boolean)
  : null; // null = default arms resolved after requires (locked route vs runner-up)
if (!Number.isInteger(SAMPLE) || SAMPLE <= 0 || (ARM_SPECS && ARM_SPECS.length < 2)) {
  console.error('Usage: bakeoff-call-research.js [--sample N] [--models provider:model,provider:model]');
  process.exit(1);
}
const DETAIL_CALLS = 5; // full chunk detail printed for the first N calls

(async () => {
  const db = require('../models/db');
  const { eligibleCallsQuery, extractResearchChunks, CALL_RESEARCH_ROUTE } = require('../services/call-research-miner');

  const specs = ARM_SPECS || [
    `${CALL_RESEARCH_ROUTE.primary.provider}:${CALL_RESEARCH_ROUTE.primary.model}`,
    'gemini:gemini-2.5-pro', // bake-off runner-up — the standing challenger
  ];
  const ARMS = specs.map((spec) => {
    const idx = spec.indexOf(':');
    const provider = idx > 0 ? spec.slice(0, idx) : null;
    const model = idx > 0 ? spec.slice(idx + 1) : null;
    if (!['openai', 'anthropic', 'gemini'].includes(provider) || !model) {
      console.error(`Bad arm "${spec}" — use provider:model (openai|anthropic|gemini).`);
      process.exit(1);
    }
    return { label: spec, route: { primary: { provider, model } } };
  });
  const KEY_FOR = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };
  const missing = [...new Set(ARMS.map((a) => KEY_FOR[a.route.primary.provider]))]
    .filter((k) => !process.env[k] && !(k === 'GEMINI_API_KEY' && process.env.GOOGLE_API_KEY));
  if (missing.length) {
    console.error(`Missing keys for requested arms: ${missing.join(', ')}`);
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
  ARMS.forEach((a) => {
    stats[a.label] = { ok: 0, request_failed: 0, schema_failed: 0, unlabeled: 0, chunks: 0, dropped_not_verbatim: 0, tags: {} };
  });

  console.log(`Bake-off: ${calls.length} sampled calls × ${ARMS.map((a) => a.label).join(' vs ')}\n`);

  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const customer = customerById.get(call.customer_id) || null;
    const line = [`call ${i + 1}/${calls.length} (${new Date(call.created_at).toISOString().slice(0, 10)}, ${call.duration_seconds || '?'}s)`];

    for (const arm of ARMS) {
      const result = await extractResearchChunks(call, customer, { route: arm.route });
      const s = stats[arm.label];
      s[result.status] = (s[result.status] || 0) + 1;
      s.chunks += result.chunks.length;
      s.dropped_not_verbatim += (result.dropped && result.dropped.quote_not_verbatim) || 0;
      result.chunks.forEach((c) => { s.tags[c.tag] = (s.tags[c.tag] || 0) + 1; });
      line.push(`${arm.label}: ${result.status === 'ok' ? `${result.chunks.length} chunks [${result.chunks.map((c) => c.tag).join(', ')}]` : result.status}`);

      if (i < DETAIL_CALLS && result.chunks.length) {
        console.log(`  ── ${arm.label} ──`);
        result.chunks.forEach((c) => {
          console.log(`    [${c.tag}|${c.speaker}] "${c.quote}"${c.topics.length ? ` (${c.topics.join(', ')})` : ''}`);
        });
      }
    }
    console.log(`${line.join('\n    ')}\n`);
  }

  console.log('═══ AGGREGATES ═══');
  for (const arm of ARMS) {
    const s = stats[arm.label];
    const attempted = calls.length;
    const kept = s.chunks;
    const extractedRaw = kept + s.dropped_not_verbatim;
    const verbatimRate = extractedRaw ? Math.round((kept / extractedRaw) * 100) : 100;
    console.log(`\n${arm.label}`);
    console.log(`  ok ${s.ok}/${attempted} · request_failed ${s.request_failed} · schema_failed ${s.schema_failed} · unlabeled ${s.unlabeled}`);
    console.log(`  chunks kept ${kept} (avg ${(kept / Math.max(1, s.ok)).toFixed(1)}/ok-call) · verbatim pass ${verbatimRate}% (${s.dropped_not_verbatim} dropped)`);
    console.log(`  tags: ${JSON.stringify(s.tags)}`);
  }
  console.log('\nSpot-check the detailed chunks above for quote fidelity + tag accuracy, then lock the winner via CALL_RESEARCH_PROVIDER / CALL_RESEARCH_MODEL.');
  await db.destroy();
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
