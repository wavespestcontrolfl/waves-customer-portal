#!/usr/bin/env node
/**
 * Manual trigger for the citation submission runner (Phase 1b).
 *
 *   --dry-run            preview what WOULD be submitted (no browser, no writes)
 *   --limit=N            batch size (default 5)
 *   --allow=a.com,b.com  allowlist of domains to actually submit to (REQUIRED for a
 *                        live run — supervised-first). Dry-run ignores it.
 *
 * Live runs the browser, so run with NODE_ENV=production + DATABASE_URL=<Railway
 * public URL> + ANTHROPIC_API_KEY (+ S3 env for evidence). Watch the first runs.
 *   NODE_ENV=production DATABASE_URL=… ANTHROPIC_API_KEY=… \
 *     node scripts/backlink-signup-run.js --allow=citysquares.com --limit=1
 */

require('dotenv').config();
const runner = require('../server/services/seo/signup-runner');
const db = require('../server/models/db');

function parseArgs() {
  const a = { dryRun: false, batchSize: 5, allow: [] };
  for (const x of process.argv.slice(2)) {
    if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--limit=')) a.batchSize = parseInt(x.split('=')[1], 10) || 5;
    else if (x.startsWith('--allow=')) a.allow = x.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return a;
}

(async () => {
  const a = parseArgs();
  console.log(`signup-run dryRun=${a.dryRun} batchSize=${a.batchSize} allow=[${a.allow.join(',')}]`);
  try {
    const r = await runner.run({ batchSize: a.batchSize, dryRun: a.dryRun, allow: a.allow });
    for (const s of r.samples || []) console.log(`  would submit: ${s.domain}  → ${s.submitUrl}`);
    console.log(`\nclaimed=${r.claimed} placed=${r.placed} blocked=${r.blocked} failed=${r.failed} skipped=${r.skipped}${r.note ? ` note=${r.note}` : ''}`);
  } catch (err) {
    console.error(`\n[signup-run] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
