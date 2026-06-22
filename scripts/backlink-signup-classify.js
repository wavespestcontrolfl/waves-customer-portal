#!/usr/bin/env node
/**
 * Manual trigger for the signup-lane classifier (Phase 1a). Triages the board's
 * directory/citation/social prospects into submit_free / pay_and_submit /
 * needs_account / skip so the operator can see what's auto-submittable for free.
 *
 *   --dry-run     classify + print, write nothing
 *   --limit=N     max prospects (default 100)
 *
 * Uses the shared models/db, so run with NODE_ENV=production + DATABASE_URL=<Railway
 * public URL> for the prod SSL config:
 *   NODE_ENV=production DATABASE_URL=… ANTHROPIC_API_KEY=… \
 *     node scripts/backlink-signup-classify.js --dry-run
 */

require('dotenv').config();
const classifier = require('../server/services/seo/signup-classifier');
const db = require('../server/models/db');

function parseArgs() {
  const a = { dryRun: false, limit: 100 };
  for (const x of process.argv.slice(2)) {
    if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--limit=')) a.limit = parseInt(x.split('=')[1], 10) || 100;
  }
  return a;
}

(async () => {
  const a = parseArgs();
  console.log(`signup-classify dryRun=${a.dryRun} limit=${a.limit}`);
  try {
    const r = await classifier.run({ limit: a.limit, dryRun: a.dryRun });
    for (const s of r.samples || []) {
      console.log(`  ${String(s.policy || '').padEnd(14)} ${String(s.domain).padEnd(30)} [${s.link_type} cat=${s.category} paid=${s.paid} acct=${s.account} rel=${s.rel} ${s.src}]`);
    }
    console.log(`\nclassified=${r.classified} byPolicy=${JSON.stringify(r.byPolicy)}`);
  } catch (err) {
    console.error(`\n[signup-classify] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
