#!/usr/bin/env node
/**
 * Manual trigger for the backlink outreach drafter (on-demand / first reviewed
 * batch). The cron runs it nightly when GATE_OUTREACH_DRAFTER is on; this lets an
 * operator run it directly.
 *
 *   --dry-run     draft + print, write nothing
 *   --limit=N     batch size (default 10)
 *
 * Uses the shared models/db (the worker's claim/report), so run with
 * NODE_ENV=production + DATABASE_URL=<Railway public URL> for the prod SSL config:
 *   NODE_ENV=production DATABASE_URL=… ANTHROPIC_API_KEY=… \
 *     node scripts/backlink-outreach-draft.js --dry-run --limit=3
 */

require('dotenv').config();
const drafter = require('../server/services/seo/backlink-outreach-drafter');
const db = require('../server/models/db');

function parseArgs() {
  const a = { dryRun: false, batchSize: 10 };
  for (const x of process.argv.slice(2)) {
    if (x === '--dry-run') a.dryRun = true;
    else if (x.startsWith('--limit=')) a.batchSize = parseInt(x.split('=')[1], 10) || 10;
  }
  return a;
}

(async () => {
  const a = parseArgs();
  console.log(`backlink-outreach-draft dryRun=${a.dryRun} batchSize=${a.batchSize}`);
  try {
    const r = await drafter.run({ batchSize: a.batchSize, dryRun: a.dryRun });
    // Dry-run previews print to STDOUT here (operator terminal), never via the app
    // logger — recipient emails/bodies must not land in Railway's plain-text logs.
    for (const s of r.samples || []) {
      console.log(`\n── ${s.domain}  (T${s.tier ?? '?'} ${s.link_type})  → ${s.to_email}`);
      console.log(`   SUBJECT: ${s.subject}`);
      console.log(s.body.split('\n').map((l) => `   ${l}`).join('\n'));
    }
    console.log(`\nclaimed=${r.claimed} drafted=${r.drafted} skipped=${r.skipped} failed=${r.failed}${r.note ? ` note=${r.note}` : ''}`);
  } catch (err) {
    console.error(`\n[outreach-draft] FAILED: ${err.stack || err.message}`);
    process.exitCode = 1;
  } finally {
    await db.destroy();
  }
})();
