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
    const stripped = a.slice(2);
    // Split on FIRST '=' only — values can legitimately contain '='
    // (signed URLs, query params like ?sig=a=b). The previous split('=')
    // truncated those silently.
    const eq = stripped.indexOf('=');
    if (eq === -1) return [stripped, true];
    return [stripped.slice(0, eq), stripped.slice(eq + 1)];
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
    // listUrls returns raw <loc> values (host + scheme preserved), so
    // www-verified GSC properties stay in-property. Honors SITEMAP_URL
    // env override too — the previous hardcoded cache key returned [] on
    // any non-default sitemap.
    return sitemap.listUrls({ limit: LIMIT });
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

    const fn = PERSIST ? monitor.inspectMany.bind(monitor) : async (us, { delayMs = 0 } = {}) => {
      // Mirror inspectMany's pacing — Google's URL Inspection quota is
      // ~600 QPM/property. The previous tight loop ignored delayMs and
      // could burst large batches into 429s on --no-persist.
      const out = [];
      for (const u of us) {
        out.push({ url: u, result: await monitor.inspect(u) });
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
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
