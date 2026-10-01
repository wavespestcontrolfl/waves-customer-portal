#!/usr/bin/env node
/**
 * Read-only preview of the cited-page ranking (server/services/seo/cited-pages.js):
 * the third-party pages answer engines cite, ranked page by page, first the
 * ones cited in current provider answers that do not name Waves, then the
 * before/after recheck of every placement live on a cited page. Writes nothing.
 *
 *   --days=N     lookback window in ET days (default 30)
 *   --limit=N    pages to print (default 50)
 *
 *   NODE_ENV=production DATABASE_URL=… node scripts/cited-pages.js --limit=20
 */

require('dotenv').config();
const { loadCitedPages, loadPlacementRechecks, DEFAULT_LOOKBACK_DAYS, DEFAULT_LIMIT } = require('../server/services/seo/cited-pages');
const db = require('../server/models/db');

function parseArgs() {
  const a = { lookbackDays: DEFAULT_LOOKBACK_DAYS, limit: DEFAULT_LIMIT };
  for (const x of process.argv.slice(2)) {
    if (x.startsWith('--days=')) a.lookbackDays = parseInt(x.split('=')[1], 10) || DEFAULT_LOOKBACK_DAYS;
    else if (x.startsWith('--limit=')) a.limit = parseInt(x.split('=')[1], 10) || DEFAULT_LIMIT;
  }
  return a;
}

(async () => {
  const a = parseArgs();
  try {
    const r = await loadCitedPages(db, a);
    console.log(`cited pages since ${r.since}: ${r.scanned} measured answer(s) scanned, ${r.pages.length} page(s) shown`);
    for (const p of r.pages) {
      const why = p.currentMisses > 0 ? `${p.currentMisses} current miss(es) via ${p.missEngines.join('/')}` : p.tier === 2 ? 'current, Waves named' : 'earlier in window';
      console.log(`\n${String(p.rank).padStart(3)}. [T${p.tier}] ${p.url}`);
      console.log(`      ${p.category}${p.subtype ? `:${p.subtype}` : ''} · ${why} · cited ${p.citations}x · named in ${p.namedIn}${p.priorityCity ? ' · priority city' : ''}`);
      for (const q of p.questions.slice(0, 4)) {
        console.log(`      ${q.miss ? '✗' : q.current ? '·' : ' '} ${q.id ? `${q.id}: ` : ''}"${q.query}" (${q.engines.join('/')})`);
      }
    }
    const rechecks = await loadPlacementRechecks(db);
    console.log(`\nplacements live on a cited page: ${rechecks.length}`);
    for (const r of rechecks) {
      console.log(`  ${r.host} live since ${r.liveOn} (${r.daysLive}d) · ${r.verdict}`);
      console.log(`      before: Waves named in ${r.before.named}/${r.before.answers} · after: ${r.after.named}/${r.after.answers}, named in ${r.after.namedWhenCiting}/${r.after.citingPage} answers citing the page`);
    }
  } catch (err) {
    console.error(`[cited-pages] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
