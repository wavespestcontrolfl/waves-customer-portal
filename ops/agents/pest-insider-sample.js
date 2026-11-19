/**
 * pest-insider-sample.js — READ-ONLY (no model call, no database, no send)
 *
 * Builds sample "Pest Insider" issues (server/services/pest-insider) for the
 * given send dates and writes the finished email to files. It sends nothing,
 * schedules nothing and writes no database rows: DATABASE_URL is removed from
 * the process before any portal module loads. The build itself calls no
 * model: every lead sentence is the fact bank's reviewed copy.
 *
 *   node ops/agents/pest-insider-sample.js <outDir> [YYYY-MM-DD ...] [--assume-live] [--assume-tools]
 *
 *     <outDir>        where the files go (created if missing)
 *     dates           send dates (ET); default 2026-12-03 and 2026-12-17
 *     --assume-live   count every reviewed blog post as live (no web request)
 *     --assume-tools  count every reviewed tool as live (this script checks no Amazon page)
 *
 * Each issue links its lead fact's blog post, so a fact leads only when its
 * post is live. The script first asks the website for every reviewed post
 * (read-only GET requests, posts.checkLivePosts), as a send does;
 * --assume-live skips those requests, for a run with no network.
 *
 * "A tool we'd use" shows only a tool whose Amazon page passed a live check.
 * Amazon refuses plain page requests, so this script checks no tool page:
 * without --assume-tools the samples have no tool. With a tool, it also
 * writes the opted-in reader's copy (<date>.optin.html and .txt); the shared
 * copy, which the archive serves, never has the tool. Each run replaces a
 * date's earlier files: a date that now builds without a tool, or does not
 * build, keeps no older copy (pre-push PR 3 r2).
 *
 * Dates run in order: each issue's fact and species count as "recent" for the
 * next one, the way the real schedule will. So each date must be a real
 * calendar day and later than the one before it (no repeats), and every date
 * is checked before any file is written: a repeated date would write a second
 * issue over the first one's files. No recheck is recorded here, so a fact
 * marked recheck_before_send never leads a sample.
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

const usage = (why) => {
  if (why) console.error(`pest-insider-sample: ${why}`);
  console.error('usage: node ops/agents/pest-insider-sample.js <outDir> [YYYY-MM-DD ...] [--assume-live] [--assume-tools]  (each date once, in order)');
  process.exit(2);
};
const assumeLive = flags.delete('--assume-live');
const assumeTools = flags.delete('--assume-tools');
if (!outDir || flags.size || dates.some((d) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) usage();
// A repeated or earlier date would count its own issue as recent and write
// over another issue's files (pre-push round 23).
dates.forEach((d, i) => { if (i > 0 && d <= dates[i - 1]) usage(`${d} does not come after ${dates[i - 1]}`); });

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
const { sendDateET } = require('../../server/services/pest-insider/facts');
const { wrapIssueHtml, withToolBlock } = require('../../server/services/pest-insider/render');
const { RECENT_WINDOW } = require('../../server/services/pest-insider/plan');
const { POSTS, POST_URLS, postUrl, checkLivePosts } = require('../../server/services/pest-insider/posts');
const { TOOLS, TOOL_PROBLEMS } = require('../../server/services/pest-insider/tools');

// An impossible day (2027-02-30) is refused here too, before any file is written.
for (const d of dates) {
  try { sendDateET(d); } catch (err) { usage(err.message); }
}

function saveIssue(sendDate, issue) {
  const base = path.join(outDir, `pest-insider-${sendDate}`);
  const html = wrapIssueHtml(issue, { unsubscribeUrl: '{{unsubscribe_url}}' });
  fs.writeFileSync(`${base}.html`, `<!-- subject: ${issue.subject.replace(/--/g, '- -')} -->\n${html}`);
  fs.writeFileSync(`${base}.txt`, `Subject: ${issue.subject}\nPreview: ${issue.preview}\n\n${issue.text_body}`);
  return base;
}

async function main() {
  const livePostFactIds = assumeLive ? Object.keys(POSTS) : await checkLivePosts();
  // Facts can share a post (D02 and D03), so posts and facts are counted apart.
  const livePosts = new Set(livePostFactIds.map(postUrl)).size;
  console.log(`blog posts: ${livePosts} of ${POST_URLS.length} reviewed posts ${assumeLive ? 'counted as live (--assume-live)' : 'answered as live'}; ${livePostFactIds.length} of ${Object.keys(POSTS).length} linked facts can lead`);
  fs.mkdirSync(outDir, { recursive: true });
  const liveToolIds = assumeTools ? TOOLS.map((t) => t.productId) : [];
  console.log(`tools: ${liveToolIds.length} of ${TOOLS.length} reviewed tools ${assumeTools ? 'counted as live (--assume-tools)' : 'live (this script checks no Amazon page)'}`);
  for (const p of TOOL_PROBLEMS) console.log(`tool left out: ${p}`);
  const recent = { factIds: [], speciesSlugs: [], toolIds: [] };
  let failed = 0;
  for (const sendDate of dates) {
    // This run's files for the date replace any earlier run's (pre-push PR 3 r2).
    for (const ext of ['.html', '.txt', '.optin.html', '.optin.txt']) fs.rmSync(path.join(outDir, `pest-insider-${sendDate}${ext}`), { force: true });
    const result = buildIssue({
      sendDate,
      livePostFactIds,
      liveToolIds,
      recent: { factIds: recent.factIds.slice(-RECENT_WINDOW), speciesSlugs: recent.speciesSlugs.slice(-RECENT_WINDOW), toolIds: recent.toolIds.slice(-RECENT_WINDOW) },
    });
    const d = result.diagnostics;
    console.log(`\n== ${sendDate}  fact ${d.factId}  species ${d.speciesSlug}  tool ${d.toolId || 'none'}`);
    if (result.ok) {
      console.log(`   subject: ${result.issue.subject}\n   preview: ${result.issue.preview}`);
      console.log(`   wrote ${saveIssue(sendDate, result.issue)}.html and .txt`);
      if (result.toolId) console.log(`   wrote ${saveIssue(`${sendDate}.optin`, withToolBlock(result.issue, result.toolId))}.html and .txt (opted-in readers: + "A tool we'd use")`);
      // Only a built issue counts toward the rotation, like a sent one will.
      recent.factIds.push(d.factId);
      recent.speciesSlugs.push(d.speciesSlug);
      if (d.toolId) recent.toolIds.push(d.toolId);
    } else {
      failed += 1;
      console.log(`   NOT BUILT: ${result.reason}`);
    }
    for (const p of d.problems) console.log(`   PROBLEM (${p.part}): ${p.reason}${p.text ? ` | ${p.text}` : ''}`);
  }
  return failed ? 1 : 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(`pest-insider-sample: ${err.message}`);
  process.exit(1);
});
