#!/usr/bin/env node
/**
 * Queue a blog post for each tech tip whose Waves post is not live
 * (tech-tip-blog-seeder; owner 2026-10-24, "tips with facts").
 *
 * Usage:
 *   node server/scripts/seed-tech-tip-blogs.js             # dry run: scan + print, no writes
 *   node server/scripts/seed-tech-tip-blogs.js --execute   # queue the gaps' topics
 *
 * Gated: writes need GATE_TECH_TIP_SOURCES=true (the dry run always scans).
 * Idempotent: a live post writes nothing; a topic already queued answers
 * already_queued; one the chain skipped stays skipped.
 *
 * Prod: railway run -- node server/scripts/seed-tech-tip-blogs.js
 */
const KNOWN = new Set(['--execute']);
const unknown = process.argv.slice(2).filter((arg) => !KNOWN.has(arg));
if (unknown.length) {
  console.error(`seed-tech-tip-blogs: unknown argument(s) ${unknown.map((a) => JSON.stringify(a)).join(', ')} — known: --execute`);
  process.exit(1);
}
const dryRun = !process.argv.includes('--execute');

(async function main() {
  const db = require('../models/db');
  try {
    const { rows, summary } = await require('../services/service-report/tech-tip-blog-seeder').seedAll(db, { dryRun });
    for (const row of rows) {
      console.log(`${dryRun ? '[dry-run] ' : ''}${row.tipId}  ${row.path}  ${row.post ? `live: ${row.post.url}` : `topic: ${JSON.stringify(row.topic)}`}  -> ${row.outcome}`);
    }
    console.log(`${dryRun ? '[dry-run] ' : ''}${summary.scanned} tip(s) name a post: ${summary.live} live, ${summary.gaps} gap(s)${dryRun ? '' : `, ${summary.queued} topic(s) queued`}.`);
    process.exit(0);
  } catch (err) {
    console.error(`seed-tech-tip-blogs: ${err && err.message ? err.message : err}`);
    process.exit(1);
  } finally {
    try { await db.destroy(); } catch { /* already closed */ }
  }
})();
