// READ-ONLY: capture the SEARCH/TRAFFIC HALF of the pre-activation baseline the
// affiliate pilot requires (docs/affiliate-links-pilot.md — "Baseline first: 90
// days of GSC + GA4 per candidate URL ... recorded before any link activates").
//
// ⚠️ PARTIAL BASELINE — not sufficient to activate links on its own. The pilot
// spec also names estimate starts, calls, CTA clicks and geography. Those are
// portal-side conversion signals needing URL-to-conversion attribution, which
// is NOT built here. The documented stop rule ("STOP a page if its local
// service conversion drops >10% vs baseline") cannot be evaluated from this
// output alone: it measures traffic, not leads. Capture the conversion half
// separately before any link activates.
//
// Pulls per-URL Search Console performance and GA4 pageviews for a window,
// keeps blog-lane URLs only, and flags the topic classes the pilot excludes.
// Writes NOTHING: it calls searchanalytics.query directly rather than the
// service's syncPages(), which upserts into gsc_pages.
//
// The 90 days is a DATA requirement, not a waiting one — GSC serves ~16 months
// of history, so a full baseline can be pulled today for articles that already
// exist. Re-run with the same --end to reproduce a snapshot exactly.
//
// Usage (repo root):
//   railway run node ops/agents/affiliate-baseline.js
//   railway run node ops/agents/affiliate-baseline.js --days=90 --end=2026-08-31
//   railway run node ops/agents/affiliate-baseline.js --json > baseline.json
//   railway run node ops/agents/affiliate-baseline.js --url=/blog/rain-gauge
//
// Flags:
//   --days=N      window length, default 90
//   --end=DATE    last day of window (YYYY-MM-DD), default 3 days ago
//                 (GSC finalises data on a ~2-3 day lag)
//   --limit=N     max URLs to print, default 40
//   --url=SUBSTR  restrict to URLs containing SUBSTR (repeatable)
//   --all         skip the blog-lane filter and show every URL
//   --json        emit JSON only, no table

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => args.includes(`--${name}`);

const DAYS = parseInt(flag('days', '90'), 10);
const LIMIT = parseInt(flag('limit', '40'), 10);
const JSON_ONLY = has('json');
const SHOW_ALL = has('all');
const URL_FILTERS = args
  .filter((a) => a.startsWith('--url='))
  .map((a) => a.slice(6).toLowerCase());

if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  console.error(
    'GOOGLE_SERVICE_ACCOUNT_JSON is not set — run via: railway run node ops/agents/affiliate-baseline.js'
  );
  process.exit(1);
}

// Topic classes the pilot excludes from affiliate placement. These are matched
// on the URL slug, so they are a FLAG for operator review, not proof: the
// authoritative gate is the astro frontmatter post_type, which is not visible
// from a URL. A page flagged here should not be a pilot candidate.
const EXCLUDED_TOPICS = [
  [/termite|wdo|wood.?destroying/, 'termite/WDO'],
  [/german.?(roach|cockroach)/, 'German cockroach'],
  [/bed.?bug/, 'bed bug'],
  [/rodenticide|rat.?bait|mouse.?bait/, 'rodenticide'],
  [/emergency|urgent|infestation.?help/, 'emergency/health-anxiety'],
  [/\bcost\b|\bprice|pricing|how.?much/, 'cost post type'],
  [/\bvs\b|versus|compare|comparison/, 'comparison post type'],
  [/case.?study/, 'case-study post type'],
  [/near.?me|\bin-[a-z]+-fl\b/, 'location intent'],
];

const classifyExclusion = (path) => {
  for (const [pattern, label] of EXCLUDED_TOPICS) {
    if (pattern.test(path)) return label;
  }
  return null;
};

const fmt = (d) => d.toISOString().slice(0, 10);

(async () => {
  const gsc = require('../../server/services/seo/search-console');
  const ga4 = require('../../server/services/analytics/google-analytics');

  const ok = await gsc.init();
  if (!ok || !gsc.webmasters) {
    console.error('GSC init failed — check GOOGLE_SERVICE_ACCOUNT_JSON and GSC_SITE_URL.');
    process.exit(1);
  }

  const endDate = flag('end') || fmt(new Date(Date.now() - 3 * 86400000));
  const startDate = fmt(new Date(new Date(endDate).getTime() - (DAYS - 1) * 86400000));
  const siteUrl = process.env.GSC_SITE_URL || 'https://wavespestcontrol.com';

  // ── Search Console: per-page totals over the window (read-only query) ──
  // Row limits are applied API-side, BEFORE the blog/--url filters below, so a
  // candidate outside the global top set would silently vanish. Both limits are
  // set well above the site's page count and truncation is reported loudly
  // rather than left to be discovered as a missing row.
  const GSC_ROW_LIMIT = 5000;
  const GA4_ROW_LIMIT = 5000;

  const gscRes = await gsc.webmasters.searchanalytics.query({
    siteUrl,
    requestBody: {
      startDate,
      endDate,
      dimensions: ['page'],
      rowLimit: GSC_ROW_LIMIT,
      type: 'web',
    },
  });
  const gscTruncated = (gscRes.data.rows || []).length >= GSC_ROW_LIMIT;

  const pages = (gscRes.data.rows || []).map((row) => {
    const pageUrl = row.keys[0];
    let path = pageUrl;
    try { path = new URL(pageUrl).pathname; } catch { /* keep raw */ }
    return {
      url: pageUrl,
      path,
      pageType: (() => { try { return gsc.classifyPageType(pageUrl); } catch { return 'unknown'; } })(),
      clicks: row.clicks || 0,
      impressions: row.impressions || 0,
      ctr: row.ctr || 0,
      position: row.position || 0,
      excludedBecause: classifyExclusion(path.toLowerCase()),
    };
  });

  // ── GA4: pageviews per path over the same window ──
  // Not every GA4 property exposes per-page history; a miss degrades the row
  // to GSC-only rather than failing the run.
  const ga4Res = await ga4.getTopPages(startDate, endDate, GA4_ROW_LIMIT).catch((e) => ({
    configured: false, data: [], error: e.message,
  }));
  const ga4Rows = ga4Res.data || [];
  const ga4Truncated = ga4Rows.length >= GA4_ROW_LIMIT;

  // getTopPages groups by pagePath AND pageTitle, so one path yields several
  // rows when its title changed inside the window. Summing is required —
  // keying a Map by path alone would keep whichever row happened to come last
  // and understate the baseline in an order-dependent way.
  const ga4ByPath = new Map();
  for (const r of ga4Rows) {
    const prev = ga4ByPath.get(r.pagePath);
    const views = r.pageviews || 0;
    if (!prev) {
      ga4ByPath.set(r.pagePath, {
        pageviews: views,
        bounceWeighted: (r.bounceRate || 0) * views,
        durWeighted: (r.avgSessionDuration || 0) * views,
        pageTitle: r.pageTitle,
        titleVariants: 1,
      });
    } else {
      prev.pageviews += views;
      prev.bounceWeighted += (r.bounceRate || 0) * views;
      prev.durWeighted += (r.avgSessionDuration || 0) * views;
      prev.titleVariants += 1;
    }
  }
  // Collapse the weighted sums into pageview-weighted averages.
  for (const v of ga4ByPath.values()) {
    v.bounceRate = v.pageviews ? +(v.bounceWeighted / v.pageviews).toFixed(4) : null;
    v.avgSessionDuration = v.pageviews ? +(v.durWeighted / v.pageviews).toFixed(2) : null;
    delete v.bounceWeighted;
    delete v.durWeighted;
  }

  // ── Merge, filter, rank ──
  let rows = pages.map((p) => {
    const g = ga4ByPath.get(p.path) || null;
    return {
      ...p,
      pageviews: g ? g.pageviews : null,
      bounceRate: g ? g.bounceRate : null,
      avgSessionDuration: g ? g.avgSessionDuration : null,
      title: g ? g.pageTitle : null,
    };
  });

  if (!SHOW_ALL) rows = rows.filter((r) => r.pageType === 'blog');

  // A --url the API never returned is a SILENT MISS, not an empty result: the
  // page may exist but sit outside the window, the blog lane, or a truncated
  // response. Name it rather than printing a short table.
  const unmatchedFilters = URL_FILTERS.filter(
    (f) => !rows.some((r) => r.url.toLowerCase().includes(f))
  );
  if (URL_FILTERS.length) {
    rows = rows.filter((r) => URL_FILTERS.some((f) => r.url.toLowerCase().includes(f)));
  }
  rows.sort((a, b) => b.impressions - a.impressions);

  // A path GSC returned but GA4 did not: the traffic half of that row is blank,
  // so it is not a complete baseline for that URL.
  const missingGa4 = rows.filter((r) => r.pageviews === null).map((r) => r.path);

  const eligible = rows.filter((r) => !r.excludedBecause);
  const excluded = rows.filter((r) => r.excludedBecause);

  const warnings = [];
  if (gscTruncated) warnings.push(`GSC hit the ${GSC_ROW_LIMIT}-row cap — some pages are missing from this baseline.`);
  if (ga4Truncated) warnings.push(`GA4 hit the ${GA4_ROW_LIMIT}-row cap — some pageview figures are missing.`);
  for (const f of unmatchedFilters) warnings.push(`--url=${f} matched no returned page — NOT captured.`);
  if (missingGa4.length) warnings.push(`${missingGa4.length} page(s) have GSC data but no GA4 pageviews (GSC-only rows).`);

  const payload = {
    window: { startDate, endDate, days: DAYS },
    siteUrl,
    capturedAt: new Date().toISOString(),
    partialBaseline: 'search/traffic only — estimate starts, calls, CTA clicks and geography are NOT captured here',
    sources: {
      gsc: { rows: pages.length, rowLimit: GSC_ROW_LIMIT, truncated: gscTruncated },
      ga4: {
        configured: ga4Res.configured !== false,
        rows: ga4Rows.length,
        rowLimit: GA4_ROW_LIMIT,
        truncated: ga4Truncated,
        pathsAfterTitleMerge: ga4ByPath.size,
        error: ga4Res.error || null,
      },
    },
    warnings,
    missingGa4,
    counts: { blogLane: rows.length, eligible: eligible.length, excluded: excluded.length },
    eligible: eligible.slice(0, LIMIT),
    excluded: excluded.slice(0, LIMIT),
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const pad = (s, n) => String(s ?? '—').padEnd(n).slice(0, n);
  const num = (v, n) => String(v ?? '—').padStart(n);

  console.log(`\nAffiliate pilot baseline — ${siteUrl}`);
  console.log(`Window: ${startDate} → ${endDate} (${DAYS} days)   captured ${payload.capturedAt}`);
  console.log(`GSC rows: ${pages.length}   GA4: ${payload.sources.ga4.configured ? `${payload.sources.ga4.rows} pages` : 'NOT CONFIGURED'}`);
  if (payload.sources.ga4.error) console.log(`GA4 error: ${payload.sources.ga4.error}`);
  if (!SHOW_ALL) console.log(`Filter: blog lane only (service/city pages are structurally excluded from the pilot)`);

  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} warning(s) — this snapshot is incomplete:`);
    for (const w of warnings) console.log(`   • ${w}`);
  }

  console.log(`\n── Eligible candidates (${eligible.length}) ──`);
  console.log(`${pad('PATH', 52)} ${num('CLICKS', 7)} ${num('IMPR', 8)} ${num('POS', 6)} ${num('VIEWS', 7)}`);
  for (const r of eligible.slice(0, LIMIT)) {
    console.log(`${pad(r.path, 52)} ${num(r.clicks, 7)} ${num(r.impressions, 8)} ${num(r.position.toFixed(1), 6)} ${num(r.pageviews, 7)}`);
  }

  if (excluded.length) {
    console.log(`\n── Excluded by pilot rules (${excluded.length}) ──`);
    for (const r of excluded.slice(0, LIMIT)) {
      console.log(`${pad(r.path, 52)} ${pad(r.excludedBecause, 24)}`);
    }
  }

  console.log(`\nPilot needs 6: 2 nonchemical prevention, 2 lawn/irrigation measurement, 2 field-tool/equipment.`);
  console.log(`Theme selection is a human call — this ranks by search demand, it does not read the articles.`);
  console.log(`Re-run with --json to store the snapshot before any link activates.`);
  console.log(`PARTIAL: estimate starts, calls, CTA clicks and geography are NOT captured here — the`);
  console.log(`stop rule ("service conversion drops >10% vs baseline") needs that half captured separately.\n`);
})().catch((e) => {
  console.error(`affiliate-baseline failed: ${e.message}`);
  process.exit(1);
});
