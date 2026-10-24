#!/usr/bin/env node
/**
 * Queue the Waves post a tip's subject still lacks (tech-tip-blog-seeder;
 * tips with facts, owner 2026-10-24, decisions 2 and 3).
 *
 * Usage:
 *   node server/scripts/seed-tech-tip-blogs.js                        # dry run: every tip with a topic, and what the queue would answer
 *   node server/scripts/seed-tech-tip-blogs.js --only a,b             # dry run of those tips
 *   node server/scripts/seed-tech-tip-blogs.js --only a,b --execute   # queue them
 *
 * Every queued topic is written and published by the autonomous blog chain,
 * so a write needs a hand-pick (--only, at most five tips a run) and
 * GATE_BLOG_SEARCH_SUGGEST=true. The dry run writes nothing.
 *
 * Prod dry run: railway run -- node server/scripts/seed-tech-tip-blogs.js
 */
const args = process.argv.slice(2);
const execute = args.includes('--execute');
let only = [];
const unknown = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--execute') continue;
  if (arg === '--only' && args[i + 1] && !args[i + 1].startsWith('--')) { only = args[i + 1].split(','); i += 1; continue; }
  if (arg.startsWith('--only=')) { only = arg.slice('--only='.length).split(','); continue; }
  unknown.push(arg);
}
if (unknown.length) {
  console.error(`seed-tech-tip-blogs: unknown argument(s) ${unknown.map((a) => JSON.stringify(a)).join(', ')}; known: --only <tipId,...>, --execute`);
  process.exit(1);
}

(async function main() {
  const db = require('../models/db');
  let code = 0;
  try {
    const rows = await require('../services/service-report/tech-tip-blog-seeder').seedTechTipBlogs(db, { only, execute });
    const prefix = execute ? '' : '[dry-run] ';
    for (const row of rows) {
      console.log(`${prefix}${row.tipId}  ${JSON.stringify(row.topic)}${row.post ? `  live: ${row.post.url}` : ''}  -> ${row.outcome}`);
    }
    const count = (outcome) => rows.filter((row) => row.outcome === outcome).length;
    console.log(`${prefix}${rows.length} tip(s): ${count('live')} live, ${execute ? `${count('queued')} queued` : `${count('would_queue')} would queue`}.`);
  } catch (err) {
    console.error(`seed-tech-tip-blogs: ${err && err.message ? err.message : err}`);
    code = 1;
  } finally {
    try { await db.destroy(); } catch { /* already closed */ }
  }
  process.exit(code);
})();
