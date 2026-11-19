/**
 * pest-insider-sample.js — READ-ONLY (no model call, no database, no send)
 *
 * Builds sample "Pest Insider" issues (server/services/pest-insider) for the
 * given send dates and writes the finished email to files. It sends nothing,
 * schedules nothing and writes no database rows: DATABASE_URL is removed from
 * the process before any portal module loads. The build itself calls no
 * model: every lead sentence is the fact bank's reviewed copy.
 *
 *   node ops/agents/pest-insider-sample.js <outDir> [YYYY-MM-DD ...] [--demo-blocks]
 *
 *     <outDir>        where the files go (created if missing)
 *     dates           send dates (ET); default 2026-12-03 and 2026-12-17
 *     --demo-blocks   fill the optional blocks (area line, tool, home) with synthetic text
 *
 * Dates run in order: each issue's fact and species count as "recent" for the
 * next one, the way the real schedule will.
 *
 * Per date it writes pest-insider-<date>.html (the body inside the newsletter
 * chrome, for opening in a browser) and pest-insider-<date>.txt, and prints
 * the subject, the chosen fact and species, and every copy problem found.
 * Exit code 1 when any issue did not build.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [outDir, ...dateArgs] = positional;
const dates = dateArgs.length ? dateArgs : ['2026-12-03', '2026-12-17'];
const unknown = [...flags].filter((f) => f !== '--demo-blocks');

if (!outDir || unknown.length || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) {
  console.error('usage: node ops/agents/pest-insider-sample.js <outDir> [YYYY-MM-DD ...] [--demo-blocks]');
  process.exit(2);
}

// No database for this process, so no write is possible:
// 1. no credentials: every name knexfile.js can rebuild DATABASE_URL from is
//    removed, and WAVES_LOCAL_DEV=1 stops config/load-env.js from reloading
//    them from the checkout's .env;
// 2. no client: server/models/db.js is replaced in the require cache by a stub
//    that throws on any use, before any portal module can load the real one.
for (const name of Object.keys(process.env)) {
  if (/^(DATABASE_|POSTGRES_|PG[A-Z]+$)/.test(name)) delete process.env[name];
}
process.env.WAVES_LOCAL_DEV = '1';
const dbPath = require.resolve('../../server/models/db');
const noDb = new Proxy(function noDatabase() {}, {
  get(target, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined;
    throw new Error(`pest-insider-sample: no database in this process (db.${String(prop)})`);
  },
  apply() { throw new Error('pest-insider-sample: no database in this process'); },
});
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: noDb };

const { buildIssue } = require('../../server/services/pest-insider');
const { wrapIssueHtml } = require('../../server/services/pest-insider/render');
const { RECENT_WINDOW } = require('../../server/services/pest-insider/plan');

// Synthetic text only: no real customer, address or product.
const DEMO = {
  areaLine: 'Sample line: crews are seeing more of this near the canals this week.',
  tool: { name: 'Sample garden hose nozzle', why: 'Sample line explaining why a crew keeps one in the truck.', url: 'https://www.example.com/sample-tool', disclosure: 'Sample disclosure line.' },
  home: { lastVisit: { date: '2026-11-04', areas: ['front beds', 'lanai'] }, nextVisit: { date: '2027-01-06', service: 'pest control' }, sinceDate: '2024-03-12', visitCount: 9 },
};

function saveIssue(sendDate, issue) {
  const base = path.join(outDir, `pest-insider-${sendDate}`);
  const html = wrapIssueHtml(issue, { unsubscribeUrl: '{{unsubscribe_url}}' });
  fs.writeFileSync(`${base}.html`, `<!-- subject: ${issue.subject.replace(/--/g, '- -')} -->\n${html}`);
  fs.writeFileSync(`${base}.txt`, `Subject: ${issue.subject}\nPreview: ${issue.preview}\n\n${issue.text_body}`);
  return base;
}

fs.mkdirSync(outDir, { recursive: true });
const recent = { factIds: [], speciesSlugs: [] };
let failed = 0;
for (const sendDate of dates) {
  const result = buildIssue({
    sendDate,
    recent: { factIds: recent.factIds.slice(-RECENT_WINDOW), speciesSlugs: recent.speciesSlugs.slice(-RECENT_WINDOW) },
    ...(flags.has('--demo-blocks') ? DEMO : {}),
  });
  const d = result.diagnostics;
  console.log(`\n== ${sendDate}  fact ${d.factId}  species ${d.speciesSlug}`);
  if (result.ok) {
    console.log(`   subject: ${result.issue.subject}\n   preview: ${result.issue.preview}`);
    console.log(`   wrote ${saveIssue(sendDate, result.issue)}.html and .txt`);
    // Only a built issue counts toward the rotation, like a sent one will.
    recent.factIds.push(d.factId);
    recent.speciesSlugs.push(d.speciesSlug);
  } else {
    failed += 1;
    console.log(`   NOT BUILT: ${result.reason}`);
  }
  for (const p of d.problems) console.log(`   PROBLEM (${p.part}): ${p.reason}${p.text ? ` | ${p.text}` : ''}`);
  if (d.fallbacks.length) console.log(`   fallbacks used: ${d.fallbacks.join(', ')}`);
}
process.exit(failed ? 1 : 0);
