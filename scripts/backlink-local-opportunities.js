#!/usr/bin/env node
/**
 * Local-opportunity prospecting → prospect board (CLI).
 *
 * PROACTIVE complement to backlink-deep-harvest.js. Where the deep harvest mines
 * domains that already link to our COMPETITORS, this runs curated local-intent SERP
 * queries ("<city> little league sponsors", "<city> 5k run sponsors", "<city> chamber
 * of commerce member directory", "<city> community calendar", "<city> podcast") across
 * our markets and drops the result domains onto the SAME seo_link_prospects board —
 * scored, contact-found, and lane-routed. Sponsorships/charities/podcasts → OUTREACH
 * lane (the drafter pitches them); chambers/member-directories → SIGNUP lane. Nothing is
 * sent — new rows sit inert until the owner arms GATE_LINK_OUTREACH / GATE_SIGNUP_RUNNER.
 *
 * This is a thin wrapper: the orchestration lives in
 * server/services/seo/local-opportunity-promoter.js, shared with the weekly cron.
 *
 *   --dry-run         discover + score + print everything, write NOTHING
 *   --limit=N         cap the scoring step to the top-N discovered domains
 *   --per-query=N     SERP results to read per query per market (default 10)
 *   --promote-min=N   composite-score floor to promote (default 35)
 *
 * Connects via DATABASE_URL (export the Railway *public* URL). Run with NODE_ENV unset
 * so the seoIntelligence gate is dev-open; needs DATAFORSEO_LOGIN/PASSWORD and
 * ANTHROPIC_API_KEY in the environment.
 *
 *   DATABASE_URL=… DATAFORSEO_LOGIN=… DATAFORSEO_PASSWORD=… ANTHROPIC_API_KEY=… \
 *     node scripts/backlink-local-opportunities.js --dry-run
 */

require('dotenv').config();
const knex = require('knex');

const dataforseo = require('../server/services/seo/dataforseo');
const promoter = require('../server/services/seo/local-opportunity-promoter');

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

(async () => {
  const args = parseArgs(process.argv);
  console.log(`backlink-local-opportunities dryRun=${args.dryRun} limit=${args.limit ?? '∞'} promoteMin=${args.promoteMin}`);
  if (!dataforseo.configured) { console.error('DATAFORSEO_LOGIN/PASSWORD not set'); process.exitCode = 1; return; }
  // Lane routing depends on a reliable LLM classification; without ANTHROPIC_API_KEY the
  // scorer falls back to the heuristic and the promoter holds those rows back, so a live
  // run would write nothing useful. Fail fast (the dry-run still previews heuristically).
  if (!args.dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY required for a live run (lane routing needs reliable LLM classification); re-run with --dry-run to preview');
    process.exitCode = 1; return;
  }

  const db = makeDb();
  try {
    const r = await promoter.run({ db, dryRun: args.dryRun, limit: args.limit, perQuery: args.perQuery, promoteMin: args.promoteMin });
    console.log(`\n[local-opp] discovered=${r.discovered} excludedOwned=${r.excludedOwned} scored=${r.scored}; promotable=${r.promotable}${r.heldBack ? ` (held heuristic=${r.heldBack})` : ''} by lane ${JSON.stringify(r.byLane)}`);
    console.log('[local-opp] top promotable:');
    r.items.slice().sort((a, b) => b.score - a.score).slice(0, 25).forEach((it) => console.log(
      `   ${String(it.score).padStart(5)}  T${it.tier}  ${String(it.lane).padEnd(8)} ${String(it.intent).padEnd(10)} ${it.domain.padEnd(34)} [${it.opportunity_type}] x${it.appearances}/${it.markets}mkt  contact=${it.contact}`));
    if (args.dryRun) console.log('\n[local-opp] DRY-RUN — no writes.');
    else console.log(`\n[local-opp] promoted ${r.promoted} new prospects to the board (${r.dupes} already present, skipped).`);
  } catch (err) {
    console.error(`\n[local-opp] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
