#!/usr/bin/env node
/**
 * run-serp-profiler.js — manual invocation wrapper for serp-profiler.
 *
 * Profiles N keywords against DataForSEO (live SERP fetch — costs
 * credits, roughly $0.005–$0.01 per advanced organic query). Sources:
 *
 *   --from=queue        pull top N pending opportunities from
 *                       opportunity_queue. DEFAULT.
 *   --from=gsc          pull top N striking-distance queries from
 *                       gsc_queries directly (works before opportunity
 *                       miner has been run).
 *   --keyword="X"       single ad-hoc keyword (use --city=Y to pair).
 *
 * Other flags:
 *   --limit=5           max keywords (cost cap). DEFAULT 5.
 *   --no-persist        do not write to serp_snapshots.
 *   --force             ignore the 14-day refetch cache.
 *   --json              raw JSON output instead of human-readable.
 *
 * Examples:
 *   node server/scripts/run-serp-profiler.js
 *   node server/scripts/run-serp-profiler.js --from=gsc --limit=3
 *   node server/scripts/run-serp-profiler.js --keyword="pest control bradenton" --city=Bradenton
 *
 * For prod:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *     DATAFORSEO_LOGIN=... DATAFORSEO_PASSWORD=... \
 *       node server/scripts/run-serp-profiler.js --limit=5 --no-persist
 *   '
 */

const db = require('../models/db');
const { etDateString, addETDays } = require('../utils/datetime-et');
const profiler = require('../services/seo/serp-profiler');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const FROM = ARGS.from || (ARGS.keyword ? 'keyword' : 'queue');
const LIMIT = parseInt(ARGS.limit || 5, 10);
const PERSIST = !ARGS['no-persist'];
const FORCE = !!ARGS.force;
const JSON_OUT = !!ARGS.json;

async function loadFromQueue() {
  try {
    const rows = await db('opportunity_queue')
      .where('status', 'pending')
      .whereNotNull('query')
      .orderBy('score', 'desc')
      .limit(LIMIT)
      .select('query', 'city');
    return rows.map((r) => ({ query: r.query, city: r.city }));
  } catch (e) {
    console.warn(`opportunity_queue not available (${e.message}); falling back to --from=gsc`);
    return loadFromGsc();
  }
}

async function loadFromGsc() {
  // ET-pinned per AGENTS.md; toISOString().slice(0,10) advances one day
  // early between 8pm and midnight ET because Railway runs UTC. Same fix
  // applied to gsc-opportunity-miner and the calibration script.
  const since = etDateString(addETDays(new Date(), -28));
  const rows = await db('gsc_queries')
    .where('date', '>=', since)
    .where('is_branded', false)
    .select('query', 'city_target')
    .sum('impressions as impressions')
    .avg('position as avg_position')
    .groupBy('query', 'city_target')
    .havingRaw('avg(position) BETWEEN 4 AND 15')
    .havingRaw('sum(impressions) >= 50')
    .orderBy('impressions', 'desc')
    .limit(LIMIT);
  return rows.map((r) => ({
    query: r.query,
    city: r.city_target && r.city_target !== 'local_intent' ? r.city_target : null,
  }));
}

(async function main() {
  try {
    let items = [];
    if (FROM === 'keyword') {
      items = [{ query: ARGS.keyword, city: ARGS.city || null }];
    } else if (FROM === 'gsc') {
      items = await loadFromGsc();
    } else {
      items = await loadFromQueue();
    }

    if (!items.length) {
      console.log('No keywords to profile.');
      await db.destroy();
      return;
    }

    console.log(`\nProfiling ${items.length} keyword(s) via DataForSEO (cost: ~$${(items.length * 0.0075).toFixed(2)})\n`);
    const results = await profiler.profileBatch(items, { force: FORCE, persist: PERSIST });

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(results, null, 2));
      await db.destroy();
      return;
    }

    for (const r of results) {
      console.log(`── ${r.query}${r.city ? ` [${r.city}]` : ''}`);
      if (r.error) { console.log(`   error: ${r.error}\n`); continue; }
      const p = r.profile;
      if (!p) { console.log('   no profile returned\n'); continue; }
      console.log(`   intent:        ${p.dominant_intent} (confidence ${p.confidence})`);
      console.log(`   page type:     ${p.dominant_page_type}`);
      console.log(`   recommend:     ${p.recommended_asset_type}`);
      console.log(`   local pack:    ${p.local_pack_present ? 'yes' : 'no'}`);
      console.log(`   AI Overview:   ${p.ai_overview_present ? 'yes' : 'no'}`);
      console.log(`   .gov/.edu top: ${p.public_resource_present ? 'yes' : 'no'}`);
      console.log(`   directories:   ${Math.round(p.directory_saturation * 100)}%`);
      const types = (p.payload.top_organic || []).map((t) => t.page_type).join(',');
      console.log(`   top10 types:   ${types}`);
      if (p.payload.competitor_cta_patterns?.length) {
        console.log(`   CTAs:          ${p.payload.competitor_cta_patterns.join(', ')}`);
      }
      if (p.payload.competitor_proof_patterns?.length) {
        console.log(`   proof:         ${p.payload.competitor_proof_patterns.join(', ')}`);
      }
      if (p.payload.paa_questions?.length) {
        console.log(`   PAA:           ${p.payload.paa_questions.slice(0, 3).join(' | ')}`);
      }
      if (p.payload.serp_gap) {
        console.log(`   gap:           ${p.payload.serp_gap}`);
      }
      if (p._cache_hit) console.log(`   (cache hit)`);
      console.log('');
    }

    await db.destroy();
  } catch (err) {
    console.error('Profiler failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
