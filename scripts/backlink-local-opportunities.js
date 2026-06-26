#!/usr/bin/env node
/**
 * Local-opportunity prospecting → prospect board.
 *
 * PROACTIVE complement to backlink-deep-harvest.js. Where the deep harvest mines
 * domains that already link to our COMPETITORS, this runs curated local-intent
 * SERP queries ("<city> little league sponsors", "<city> 5k run sponsors",
 * "<city> chamber of commerce member directory", "<city> community calendar",
 * "<city> podcast") across our markets and drops the result domains onto the SAME
 * seo_link_prospects board — scored, contact-found, and lane-routed by the existing
 * prospect-scorer. Sponsorships/charities/podcasts → OUTREACH lane (the drafter
 * pitches them); chambers/member-directories → SIGNUP lane (the citation runner /
 * classifier handles them). Nothing is sent — new rows sit inert until the owner
 * acts on GATE_OUTREACH_DRAFTER / GATE_SIGNUP_RUNNER, exactly like harvested rows.
 *
 *   --dry-run         discover + score + print everything, write NOTHING
 *   --limit=N         cap the scoring step to the top-N discovered domains
 *   --per-query=N     SERP results to read per query per market (default 10)
 *   --promote-min=N   composite-score floor to promote a discovered domain (default 35;
 *                     lower than the harvest's 50 because these queries are pre-qualified)
 *
 * Connects via DATABASE_URL (export the Railway *public* URL). Run with NODE_ENV
 * unset so the seoIntelligence gate is dev-open; needs DATAFORSEO_LOGIN/PASSWORD
 * and ANTHROPIC_API_KEY in the environment.
 *
 *   DATABASE_URL=… DATAFORSEO_LOGIN=… DATAFORSEO_PASSWORD=… ANTHROPIC_API_KEY=… \
 *     node scripts/backlink-local-opportunities.js --dry-run
 */

require('dotenv').config();
const knex = require('knex');

const { etDateString } = require('../server/utils/datetime-et');
const dataforseo = require('../server/services/seo/dataforseo');
const scorer = require('../server/services/seo/prospect-scorer');
const prospector = require('../server/services/seo/local-opportunity-prospector');

const HOME = 'https://wavespestcontrol.com/';

function parseArgs(argv) {
  const a = { dryRun: false, limit: null, perQuery: 10, promoteMin: 35 };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg.startsWith('--limit=')) a.limit = parseInt(arg.split('=')[1], 10) || null;
    else if (arg.startsWith('--per-query=')) a.perQuery = parseInt(arg.split('=')[1], 10) || 10;
    else if (arg.startsWith('--promote-min=')) a.promoteMin = Number(arg.split('=')[1]) || 35;
  }
  return a;
}

function makeDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  return knex({
    client: 'pg',
    connection: { connectionString: url, ssl: url.includes('localhost') ? false : { rejectUnauthorized: false } },
    pool: { min: 0, max: 4 },
  });
}

const todayTag = () => etDateString().replace(/-/g, ''); // America/New_York, not UTC

async function run(db, args) {
  if (!dataforseo.configured) throw new Error('DATAFORSEO_LOGIN/PASSWORD not set');

  // 1. discover (read-only SERP)
  console.log(`\n[local-opp] querying ${prospector.MARKETS.map((m) => m.label).join(', ')} × ${prospector.OPPORTUNITY_QUERIES.length} opportunity queries (perQuery=${args.perQuery})…`);
  let candidates = await prospector.discoverLocalOpportunities({ perQuery: args.perQuery });
  const byType = {};
  candidates.forEach((c) => { byType[c.opportunity_type] = (byType[c.opportunity_type] || 0) + 1; });
  console.log(`[local-opp] ${candidates.length} unique candidate domains (by primary type: ${JSON.stringify(byType)})`);
  if (args.limit) { candidates = candidates.slice(0, args.limit); console.log(`[local-opp] limited to ${candidates.length} (most cross-market first)`); }
  if (!candidates.length) { console.log('[local-opp] nothing discovered — done.'); return; }

  // 2. score (LLM classify + contact-find + composite + lane gate). domain_rating is
  // left null (we don't spend a DR lookup here — it's only a 10% tiebreaker and these
  // are pre-qualified local targets); the opportunity_type seeds sample_anchors as a
  // weak hint, but the scorer classifies intent independently from the landed page.
  const scoreInput = candidates.map((c) => ({
    domain: c.domain,
    domain_rating: null,
    source_url: c.source_url || null,
    sample_anchors: [c.opportunity_type, c.title].filter(Boolean).slice(0, 2),
  }));
  console.log(`[local-opp] scoring ${scoreInput.length} domains (LLM classify + contact-find)…`);
  const scored = await scorer.scoreCandidates(scoreInput);

  // Promote any gate-passing prospect at/above the floor: outreach-lane rows that
  // surfaced a contact path (gate enforces it) AND signup-lane rows (chambers/
  // directories — exempt from the contact check, worked by the signup runner).
  // HARO platforms are join-not-email and excluded.
  const promotable = scored
    .map((s, i) => ({ s, cand: candidates[i] }))
    .filter(({ s }) => s.gate.ok && s.gate.lane !== 'haro_platform' && s.score >= args.promoteMin);

  const laneCounts = {};
  promotable.forEach(({ s }) => { laneCounts[s.gate.lane] = (laneCounts[s.gate.lane] || 0) + 1; });
  console.log(`\n[local-opp] scored ${scored.length}; ${promotable.length} promotable (score >= ${args.promoteMin}) by lane: ${JSON.stringify(laneCounts)}`);
  console.log('[local-opp] top promotable sample:');
  promotable.slice(0, 15).forEach(({ s, cand }) => console.log(
    `   ${String(s.score).padStart(5)}  T${s.tier}  ${s.gate.lane.padEnd(8)} ${s.intent_class.padEnd(10)} ${cand.domain.padEnd(34)} [${cand.opportunity_type}]  contact=${s.contact?.contact_email ? 'email' : s.contact?.contact_url ? 'form/url' : 'none'}`));

  if (args.dryRun) { console.log('\n[local-opp] DRY-RUN — no writes.'); return; }

  // 3. promote survivors onto the board (dedupe on target_domain+target_page; a domain
  // already on the board from the harvest is skipped, no duplicate).
  let promoted = 0, dupes = 0;
  for (const { s, cand } of promotable) {
    const dup = await db('seo_link_prospects').where({ target_domain: cand.domain, target_page: HOME }).first();
    if (dup) { dupes++; continue; }
    await db('seo_link_prospects').insert({
      target_domain: cand.domain, target_page: HOME,
      target_url: cand.source_url || null,
      anchor_planned: s.suggested_anchor || null, link_type: s.intent_class, priority: s.priority,
      domain_rating: null, score: s.score, tier: s.tier,
      contact_email: s.contact?.contact_email || null, contact_url: s.contact?.contact_url || null,
      contact_checked_at: s.contact ? new Date() : null,
      notes: `local opportunity (${cand.opportunity_type}); markets=${cand.markets.join('/')}; queries=${cand.queries.slice(0, 2).join(' | ')}`,
      quality_signals: JSON.stringify({
        relevance: s.relevance_0_100, lead_value_tier: s.lead_value_tier, is_local_swfl: s.is_local_swfl,
        intent_class: s.intent_class, opportunity_type: cand.opportunity_type, opportunity_types: cand.opportunity_types,
        scored_by: 'local_opportunity',
      }),
      source: `local_opportunity_${todayTag()}`, owner: 'strategy_agent',
    });
    promoted++;
  }
  console.log(`\n[local-opp] promoted ${promoted} new prospects to the board (${dupes} already present, skipped).`);
}

(async () => {
  const args = parseArgs(process.argv);
  console.log(`backlink-local-opportunities dryRun=${args.dryRun} limit=${args.limit ?? '∞'} promoteMin=${args.promoteMin}`);
  const db = makeDb();
  try {
    await run(db, args);
  } catch (err) {
    console.error(`\n[local-opp] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
