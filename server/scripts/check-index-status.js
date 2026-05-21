#!/usr/bin/env node
/**
 * check-index-status.js — runs the URL Inspection monitor against a
 * batch of URLs. Read-only. Persists results to content_index_status
 * unless --no-persist is passed.
 *
 * Quota: URL Inspection API limits to ~600/min/property. Default
 * 200ms inter-call delay keeps us well under.
 *
 * Usage:
 *   node server/scripts/check-index-status.js --url=https://www.wavespestcontrol.com/pest-control-bradenton-fl/
 *   node server/scripts/check-index-status.js --from-sitemap --limit=20
 *   node server/scripts/check-index-status.js --from-gsc-pages --limit=10 --no-persist
 *
 * For prod:
 *   railway run -- bash -c '
 *     node server/scripts/check-index-status.js --from-sitemap --limit=10
 *   '
 */

const db = require('../models/db');
const monitor = require('../services/seo/index-status-monitor');
const sitemap = require('../services/seo/sitemap-manager');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const LIMIT = parseInt(ARGS.limit || 5, 10);
const PERSIST = !ARGS['no-persist'];
const URL = ARGS.url || null;
const FROM_SITEMAP = !!ARGS['from-sitemap'];
const FROM_GSC = !!ARGS['from-gsc-pages'];

async function loadUrls() {
  if (URL) return [URL];
  if (FROM_SITEMAP) {
    // Pull the first LIMIT URLs from the live sitemap. Uses sitemap-manager's
    // cache transparently.
    const r = await sitemap.hasUrl('https://www.wavespestcontrol.com/'); // primes cache
    if (r.error) throw new Error(`sitemap fetch failed: ${r.error}`);
    // Re-fetch via internal — there's no public "list all URLs" call,
    // so we walk the cache directly.
    const cached = sitemap._cache.get('https://www.wavespestcontrol.com/sitemap.xml');
    if (!cached) return [];
    const urls = Array.from(cached.urls).slice(0, LIMIT)
      .map((u) => `https://${u}`); // re-add scheme stripped by normalize
    return urls;
  }
  if (FROM_GSC) {
    const rows = await db('gsc_pages')
      .select('page_url')
      .sum('impressions as imp')
      .groupBy('page_url')
      .orderBy('imp', 'desc')
      .limit(LIMIT);
    return rows.map((r) => r.page_url);
  }
  throw new Error('pass --url=…, --from-sitemap, or --from-gsc-pages');
}

(async function main() {
  try {
    const urls = await loadUrls();
    if (!urls.length) { console.log('No URLs to check.'); await db.destroy(); return; }

    console.log(`\nChecking ${urls.length} URL(s) via Google URL Inspection…\n`);

    const fn = PERSIST ? monitor.inspectMany.bind(monitor) : async (us) => {
      const out = [];
      for (const u of us) out.push({ url: u, result: await monitor.inspect(u) });
      return out;
    };

    const results = await fn(urls, { delayMs: 250 });

    for (const r of results) {
      const url = r.url;
      const x = r.result;
      console.log(url);
      if (!x.ok) { console.log(`  ✗ ${x.error}`); console.log(''); continue; }
      console.log(`  coverage:  ${x.coverage_state}`);
      console.log(`  indexing:  ${x.indexing_state}`);
      console.log(`  verdict:   ${x.verdict}`);
      if (x.canonical_url) {
        console.log(`  canonical: ${x.canonical_url} ${x.canonical_matches ? '✓' : '⚠ mismatch'}`);
      }
      console.log('');
    }

    await db.destroy();
  } catch (err) {
    console.error('check-index-status failed:', err.message);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
