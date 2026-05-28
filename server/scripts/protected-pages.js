#!/usr/bin/env node
/**
 * protected-pages.js — manage the do-not-auto-optimize registry.
 *
 * Usage:
 *   node server/scripts/protected-pages.js list
 *   node server/scripts/protected-pages.js auto            # populate from gsc_pages
 *   node server/scripts/protected-pages.js auto --threshold=3000 --days=28
 *   node server/scripts/protected-pages.js add /some-url/ --reason=strategic --notes="..."
 *   node server/scripts/protected-pages.js remove /some-url/
 *
 * For prod data:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/protected-pages.js auto
 *   '
 */

const db = require('../models/db');
const pp = require('../services/content/protected-pages');

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case 'list': {
      const rows = await pp.list({ db });
      console.log(`\n${rows.length} protected page(s):`);
      for (const r of rows) console.log(`  [${r.reason}] ${r.page_url}  (${r.added_by})${r.notes ? ` — ${r.notes}` : ''}`);
      break;
    }
    case 'auto': {
      const threshold = parseInt(arg('threshold', String(pp.DEFAULT_IMPRESSION_THRESHOLD)), 10);
      const days = parseInt(arg('days', '28'), 10);
      const res = await pp.autoPopulate({ db, impressionThreshold: threshold, periodDays: days });
      console.log('autoPopulate:', JSON.stringify(res));
      break;
    }
    case 'add': {
      const url = process.argv[3];
      if (!url) throw new Error('usage: add <url> [--reason=] [--notes=]');
      const row = await pp.add({ db, pageUrl: url, reason: arg('reason', 'manual'), addedBy: 'cli', notes: arg('notes') });
      console.log('added:', JSON.stringify({ page_url: row.page_url, reason: row.reason }));
      break;
    }
    case 'remove': {
      const url = process.argv[3];
      if (!url) throw new Error('usage: remove <url>');
      const n = await pp.remove({ db, pageUrl: url });
      console.log(`removed ${n} row(s) for ${url}`);
      break;
    }
    default:
      console.log('commands: list | auto [--threshold= --days=] | add <url> [--reason= --notes=] | remove <url>');
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('protected-pages failed:', err.message);
  process.exit(1);
});
