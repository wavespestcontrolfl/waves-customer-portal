#!/usr/bin/env node
/**
 * Manual trigger / preview for the weekly `ai_citation` registry discovery
 * feeder (link-registry-ai-citation-ingest.js). Runs Sundays ~4:10 AM ET
 * inside the backlink-scan lock (server/services/scheduler.js) alongside the
 * other registry feeders; this script is the owner's on-demand preview and
 * manual-run path.
 *
 *   --dry-run          preview the classification summary and what WOULD be
 *                       enqueued — no writes, safe to run any time.
 *   --days=N            lookback window in days (default 30).
 *
 * Only `listing` + `editorial` candidates are ever sent to the registry.
 * `owned` / `reference` / `competitor` / `community_video` / `other` are
 * printed in the summary but never enqueued. DISCOVERY NEVER GRANTS
 * AUTHORITY (owner ruling 2026-09-27) — an ai_citation-discovered domain can
 * never be auto-submitted; it always routes to the owner queue. That guard
 * lives in link-authority-policy.js / link-execution-authority.js, not here.
 *
 *   node scripts/ai-citation-feeder.js --dry-run
 *   NODE_ENV=production DATABASE_URL=… node scripts/ai-citation-feeder.js --dry-run
 */

require('dotenv').config();
const { runAiCitationFeeder, DEFAULT_LOOKBACK_DAYS } = require('../server/services/seo/link-registry-ai-citation-ingest');
const db = require('../server/models/db');

function parseArgs() {
  const a = { dryRun: false, lookbackDays: DEFAULT_LOOKBACK_DAYS };
  for (const x of process.argv.slice(2)) {
    if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--days=')) a.lookbackDays = parseInt(x.split('=')[1], 10) || DEFAULT_LOOKBACK_DAYS;
  }
  return a;
}

function printCandidate(c) {
  const platforms = (c.platforms || []).join('/');
  const local = c.locallyRelevant ? ' [local]' : '';
  const subtype = c.subtype ? ` [${c.subtype}]` : '';
  const existing = c.existing === true ? ' (existing domain — touch only)' : c.existing === false ? ' (new domain)' : '';
  console.log(`  ${c.domain}  [${c.category}]${subtype}  ${c.citationCount}x via ${platforms}${local}${existing}`);
  for (const q of c.questions.slice(0, 3)) {
    console.log(`      ← ${q.id ? `${q.id}: ` : ''}"${q.query}"${q.city ? ` (${q.city}${q.service ? `/${q.service}` : ''})` : ''}`);
  }
  for (const u of c.sampleUrls.slice(0, 3)) console.log(`      ${u}`);
}

(async () => {
  const a = parseArgs();
  console.log(`ai-citation-feeder dryRun=${a.dryRun} lookbackDays=${a.lookbackDays}`);
  try {
    const r = await runAiCitationFeeder(db, { dryRun: a.dryRun, lookbackDays: a.lookbackDays });
    if (r.gated) {
      console.log('GATED — GATE_SEO_INTELLIGENCE is off. No reads, no writes.');
      return;
    }
    console.log(`\nscanned ${r.scanned} measured mention row(s) → ${r.domains} distinct cited domain(s)`);
    console.log('by category:');
    for (const [cat, n] of Object.entries(r.byCategory).sort((x, y) => y[1] - x[1])) console.log(`  ${cat.padEnd(16)} ${n}`);
    console.log(`\n${a.dryRun ? 'would enqueue' : 'enqueued'} ${r.enqueued} listing/editorial candidate(s):`);
    for (const c of r.candidates) printCandidate(c);
    console.log(`\ninserted=${r.inserted} touched=${r.touched} existing=${r.existing}${a.dryRun ? ' (DRY-RUN — no writes)' : ''}`);
  } catch (err) {
    console.error(`\n[ai-citation-feeder] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
