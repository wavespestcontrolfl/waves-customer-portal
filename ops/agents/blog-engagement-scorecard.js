// READ-ONLY: weekly blog engagement scorecard — do blog readers keep going?
//
// Reads Cloudflare Web Analytics (RUM) for the wavespestcontrol.com hub and
// reports, per blog post: page views, entries (views that began a visit, i.e.
// arrived from outside the site), onward page views (views of another page of
// the site whose referrer path is that post), onward views per post view, and
// where they went. Both sides are page views, so a visit that reads two posts
// counts two post views and up to two onward views. Only fresh navigations
// count (link clicks, including cached, prefetched and prerendered ones):
// reloads, back/forward, bfcache restores and client-side route changes are
// skipped, and so is a post referring to itself.
//
// Cloudflare RUM is cookieless and counts every visitor (GA4 and PostHog only
// see visitors who accept cookies), but it samples, so small counts are
// approximate. Baseline 2026-07-17 → 2026-09-23: ~8,220 post views, ~100
// onward views (1.2% per post view).
//
// Read depth (research item E2, counting since 2026-09-27 10:37 AM ET): when
// DATABASE_PUBLIC_URL is in the environment too, the report adds each post's
// cookie-free read-depth counts from blog_read_depth_daily (hub rows; the
// portal's POST /api/public/blog-read-depth) for the same Eastern days: how
// many page loads reached 25/50/75/100% of the article and the "keep reading"
// row — loads, not people: with no visitor identifier a reload counts again —
// plus the half-read and keep-reading rates per page load that runs the
// counter (reloads included, bfcache restores not). Rates are left out of a
// window that began before counting did, since its loads include uncounted
// days. Beacon counts are exact while Cloudflare loads are sampled, so a small
// post's rates are rough.
//
// Traffic-source breakdown (research item E3): every fresh navigation onto a
// blog post from outside the site gets classified by its referrer host —
// Google (any google.* host, including news.google.com and google.co.uk, so
// both organic search and other Google properties count; a lookalike like
// notgoogle.com does not), Facebook (facebook.com, www.facebook.com,
// m.facebook.com, l.facebook.com, lm.facebook.com, fb.me), Other (any other
// external host), or Direct/none (no referrer at all) — with its page-load
// count and share of all blog landings. Cloudflare RUM carries no visitor
// id, so an onward click can't be traced back to the referrer that landed
// that reader: the breakdown reports volume only, never a per-source
// engagement rate (an estimate from per-post rates would present post mix
// as source behavior).
// Investigated and not used: the Facebook in-app browser
// is not its own `userAgentBrowser` value in this account's RUM data — it
// reports the underlying rendering engine (MobileSafari, ChromeMobileWebview,
// …), same as any other embedded browser — so it is classified by referrer
// host like everything else, with no separate bucket.
//
// Writes nothing. Needs CF_API_TOKEN (Account Analytics read) and CF_ACCOUNT_ID
// from the environment; CF_RUM_SITE_TAG overrides the site lookup. Read depth
// also needs DATABASE_PUBLIC_URL (the Postgres service's public proxy; the
// query runs in a read-only transaction). Without it the report says so.
//
// Usage (repo root):
//   railway run --service waves-customer-portal node ops/agents/blog-engagement-scorecard.js
//   railway run --service waves-customer-portal node ops/agents/blog-engagement-scorecard.js --days 28 --end 2026-09-26 --top 30
//   railway run --service waves-customer-portal node ops/agents/blog-engagement-scorecard.js --json
//   # with read depth (outer run adds DATABASE_PUBLIC_URL, inner adds the Cloudflare credentials):
//   railway run --service Postgres -- railway run --service waves-customer-portal node ops/agents/blog-engagement-scorecard.js
//
// Flags:
//   --days=N      window length in days, default 7
//   --end=DATE    first Eastern-time day AFTER the window (YYYY-MM-DD, exclusive),
//                 default today (ET); windows run ET midnight to ET midnight
//   --top=N       posts listed in the markdown table, default 20
//   --json        print the full summary as JSON instead of markdown

const BLOG_CATEGORIES = new Set(['pest-control', 'lawn-care', 'termite', 'mosquito', 'seasonal', 'tree-shrub']);
const HUB_HOSTS = new Set(['wavespestcontrol.com', 'www.wavespestcontrol.com']);
const ESTIMATE_ROOTS = new Set(['pest-control-calculator', 'estimate', 'quote', 'book', 'contact']);
// Generic (non-city) service pages on the hub; city pages end in -fl and lawn
// service pages end in a lawn/tree service suffix.
const SERVICE_HUBS = new Set([
  'pest-control-services',
  'pest-inspection',
  'inspections',
  'termite-control',
  'termite-inspection',
  'cockroach-control',
  'mosquito-control',
  'mosquito-misting-systems',
  'rodent-control',
  'commercial',
  'waveguard-memberships',
]);
const LAWN_SERVICE_RE = /(?:^|-)(?:lawn-care|lawn-aeration|lawn-fertilization|lawn-pest-control|lawn-weed-control|tree-shrub-care)$/;

const CLASS_LABELS = {
  'blog-post': 'Another blog post',
  'blog-index': 'Blog home',
  'blog-category': 'Blog category page',
  home: 'Home page',
  estimate: 'Estimate, quote or contact',
  service: 'Service or city page',
  'pest-library': 'Pest library',
  'pest-identifier': 'Pest identifier',
  tools: 'Tools',
  other: 'Other',
};

function pathSegments(path) {
  const clean = String(path || '').split(/[?#]/)[0];
  return clean.split('/').filter(Boolean);
}

function normalizePath(path) {
  const segs = pathSegments(path);
  return segs.length ? `/${segs.join('/')}/` : '/';
}

function classifyPath(path) {
  const segs = pathSegments(path);
  if (segs.length === 0) return 'home';
  const [first] = segs;
  if (first === 'blog') return segs[1] === 'category' ? 'blog-category' : 'blog-index';
  if (BLOG_CATEGORIES.has(first)) {
    // /{category}/ and its /{category}/page/N/ listing pages are category pages;
    // a post is exactly /{category}/{slug}/; anything deeper is not a post.
    if (segs.length === 1 || segs[1] === 'page') return 'blog-category';
    return segs.length === 2 ? 'blog-post' : 'other';
  }
  if (first === 'pest-library') return 'pest-library';
  if (first === 'pest-identifier') return 'pest-identifier';
  if (first === 'tools') return 'tools';
  if (ESTIMATE_ROOTS.has(first) || first.startsWith('pest-control-quote')) return 'estimate';
  if (SERVICE_HUBS.has(first) || /-fl$/.test(first) || LAWN_SERVICE_RE.test(first)) return 'service';
  return 'other';
}

// Cloudflare's navigation types (developers.cloudflare.com/web-analytics/
// data-metrics/dimensions/#navigation-types). A fresh navigation is a link
// click or form submit, whether the document came from the network, the HTTP
// cache, a prefetch (cached or not) or a prerender; "unknown" is a browser that reports
// no type. Reloads, back/forward, bfcache restores and client-side route
// changes (soft navigation / routing APIs: in-page jumps on this static site)
// re-show or re-address a page and are not new page views.
const COUNTED_NAVIGATION_TYPES = new Set([
  'navigate',
  'navigate-cache',
  'navigate-prefetch',
  'navigate-prefetch-cache',
  'prerender',
  'unknown',
]);

function countsAsPageView(navigationType) {
  if (navigationType == null || navigationType === '') return true;
  const key = String(navigationType).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return COUNTED_NAVIGATION_TYPES.has(key);
}

// Navigation types that do NOT run a page's scripts from scratch: a bfcache
// restore brings the page (and the read-depth milestones it already sent)
// back as it was, and in-page route changes load nothing. Every other type —
// reloads and ordinary back/forward loads included — runs the read-depth
// counter again, so those loads belong in the denominator of read-depth
// rates even though summarize() leaves them out of fresh views.
const NON_LOADING_NAVIGATION_TYPES = new Set(['back-forward-cache', 'routing-apis', 'soft-navigation']);

function runsPageScripts(navigationType) {
  if (navigationType == null || navigationType === '') return true;
  const key = String(navigationType).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return !NON_LOADING_NAVIGATION_TYPES.has(key);
}

/** Per blog post, the page loads that can send read-depth beacons. */
function blogPostLoads(groups) {
  const byPath = new Map();
  let total = 0;
  for (const g of groups || []) {
    const n = toCount(g.views);
    if (!n || !runsPageScripts(g.navigationType)) continue;
    const path = normalizePath(g.path);
    if (classifyPath(path) !== 'blog-post') continue;
    byPath.set(path, (byPath.get(path) || 0) + n);
    total += n;
  }
  return { byPath, total };
}

function isInternalHost(host) {
  return HUB_HOSTS.has(String(host || '').trim().toLowerCase());
}

// Facebook's own web + link-shim hosts (owner-supplied list); the in-app
// browser is not separately detectable (see the file header) so it is not
// included here.
const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'l.facebook.com',
  'lm.facebook.com',
  'fb.me',
]);

const TRAFFIC_SOURCE_LABELS = {
  google: 'Google',
  facebook: 'Facebook',
  other: 'Other',
  direct: 'Direct/none',
};

/**
 * True for any google.* host — google.com, google.co.uk, news.google.com,
 * etc. — using the Public Suffix List so the registrable domain must be
 * exactly "google" + a real public suffix. Lookalikes (notgoogle.com,
 * googleusercontent.com) and hosts with "google" only as a subdomain label
 * (google.example.com, google.com.evil.example) are not Google.
 */
function isGoogleHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  const parsed = psl.parse(h);
  return Boolean(parsed && !parsed.error && parsed.listed && parsed.sld === 'google');
}

/**
 * Which traffic-source bucket an EXTERNAL referrer host belongs to: 'google',
 * 'facebook', 'other', or 'direct' for no referrer at all. Only meaningful
 * for a non-internal host — call isInternalHost first for on-site referrals,
 * which are not a traffic source.
 */
function classifyTrafficSource(host) {
  const h = String(host || '').trim();
  if (!h) return 'direct';
  if (isGoogleHost(h)) return 'google';
  if (FACEBOOK_HOSTS.has(h.toLowerCase())) return 'facebook';
  return 'other';
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Onward page views per post view: of the page views of blog posts, how many
 * page views of other pages on the site they referred. Numerator and
 * denominator are both page views, so a journey that reads two posts
 * (Google -> A -> B -> contact) is 2 post views and 2 onward views, never
 * 2 clicks against 1 entry. One reader opening several links from one post
 * counts each, so a single post can exceed 100%. Only fresh navigations count
 * (see COUNTED_NAVIGATION_TYPES); a post referring to itself is skipped too.
 *
 * @param {Array<{path: string, refererHost?: string, refererPath?: string, views: number}>} groups
 */
function summarize(groups) {
  const posts = new Map();
  const destinations = new Map();
  // External blog-post landings by traffic source (volume only).
  const sourceViews = { google: 0, facebook: 0, other: 0, direct: 0 };
  let blogEntries = 0;
  let blogViews = 0;
  let onwardClicks = 0;

  const post = (path) => {
    if (!posts.has(path)) posts.set(path, { path, entries: 0, views: 0, onward: 0, toEstimateOrService: 0 });
    return posts.get(path);
  };

  for (const g of groups || []) {
    const views = toCount(g.views);
    if (!views || !countsAsPageView(g.navigationType)) continue;
    const dest = normalizePath(g.path);
    const destClass = classifyPath(dest);
    const internal = isInternalHost(g.refererHost);
    const from = internal ? normalizePath(g.refererPath) : null;
    // A post referring to itself is a reload or an in-page hop: neither a new
    // view of the post nor an onward click.
    if (internal && from === dest) continue;
    if (destClass === 'blog-post') {
      const target = post(dest);
      target.views += views;
      blogViews += views;
      if (!internal) {
        target.entries += views;
        blogEntries += views;
        const source = classifyTrafficSource(g.refererHost);
        sourceViews[source] += views;
      }
    }
    if (!internal || classifyPath(from) !== 'blog-post') continue;
    const source = post(from);
    source.onward += views;
    if (destClass === 'estimate' || destClass === 'service') source.toEstimateOrService += views;
    onwardClicks += views;
    destinations.set(destClass, (destinations.get(destClass) || 0) + views);
  }

  const rows = [...posts.values()]
    .map((p) => ({ ...p, rate: p.views > 0 ? p.onward / p.views : null }))
    .sort((a, b) => b.views - a.views || b.onward - a.onward || a.path.localeCompare(b.path));

  // Volume by source only: no visitor id ties an onward click back to the
  // referrer that landed that reader, so there is no per-source rate.
  const landingTotal = Object.values(sourceViews).reduce((n, v) => n + v, 0);
  const sources = Object.keys(sourceViews).map((key) => {
    const views = sourceViews[key];
    return { source: key, label: TRAFFIC_SOURCE_LABELS[key], views, share: landingTotal > 0 ? views / landingTotal : null };
  });

  return {
    totals: {
      blogEntries,
      blogViews,
      onwardClicks,
      onwardRate: blogViews > 0 ? onwardClicks / blogViews : null,
    },
    destinations: [...destinations.entries()]
      .map(([cls, views]) => ({ cls, label: CLASS_LABELS[cls] || cls, views }))
      .sort((a, b) => b.views - a.views || a.cls.localeCompare(b.cls)),
    posts: rows,
    sources,
  };
}

function pct(rate) {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

const READ_DEPTH_SITE = 'wavespestcontrol.com';
// First Eastern day with read-depth counts (counting began mid-morning).
const READ_DEPTH_LIVE_SINCE = '2026-09-27';
const MILESTONE_KEYS = { 25: 'r25', 50: 'r50', 75: 'r75', 100: 'r100', next: 'next' };

function emptyDepth() {
  return { r25: 0, r50: 0, r75: 0, r100: 0, next: 0 };
}

/**
 * Joins the window's read-depth counts — rows of { path, milestone, count }
 * summed from blog_read_depth_daily (hub only) — onto the posts from
 * summarize(). Rates are per page load that runs the counter (`loads` from
 * blogPostLoads: reloads included, bfcache restores not), so both sides count
 * the same population; beacon counts are exact while Cloudflare loads are
 * sampled, so a small post's rates are still rough. Counts for posts
 * Cloudflare did not sample still reach the count totals, never the rates. `start`/`end` are the
 * window's Eastern days (`end` exclusive): a window that ends on or before
 * the first counted day has no coverage at all, never zeros, and one that
 * starts on or before it gets counts but no rates.
 */
function addReadDepth(summary, depthRows, { start, end, loads } = {}) {
  let coverage = 'full';
  if (end != null && end <= READ_DEPTH_LIVE_SINCE) coverage = 'none';
  else if (start != null && start <= READ_DEPTH_LIVE_SINCE) coverage = 'partial';
  if (coverage === 'none') return { liveSince: READ_DEPTH_LIVE_SINCE, coverage, totals: null, posts: [] };

  const byPath = new Map();
  const totals = emptyDepth();
  for (const row of depthRows || []) {
    const key = MILESTONE_KEYS[row.milestone];
    const count = toCount(row.count);
    if (!key || !count) continue;
    const path = normalizePath(row.path);
    if (!byPath.has(path)) byPath.set(path, emptyDepth());
    byPath.get(path)[key] += count;
    totals[key] += count;
  }
  // A partly covered window's loads include days before counting began, so
  // its rates would read low: counts only.
  const rate = (n, d) => (coverage === 'full' && d > 0 ? n / d : null);
  const postLoads = (p) => (loads ? loads.byPath.get(p.path) || 0 : p.views);
  const totalLoads = loads ? loads.total : summary.totals.blogViews;
  // Rate numerators come only from posts that have loads in the denominator:
  // a post Cloudflare did not sample keeps its counts in the totals but
  // cannot lift the rates (codex r3).
  const sampledPaths = loads ? new Set(loads.byPath.keys()) : new Set(summary.posts.map((p) => p.path));
  const rated = emptyDepth();
  for (const [path, d] of byPath) {
    if (!sampledPaths.has(path)) continue;
    for (const k of Object.keys(rated)) rated[k] += d[k];
  }
  return {
    liveSince: READ_DEPTH_LIVE_SINCE,
    coverage,
    totals: { ...totals, loads: totalLoads, halfRate: rate(rated.r50, totalLoads), nextRate: rate(rated.next, totalLoads) },
    posts: summary.posts.map((p) => {
      const d = byPath.get(p.path) || emptyDepth();
      const n = postLoads(p);
      return { path: p.path, loads: n, ...d, halfRate: rate(d.r50, n), nextRate: rate(d.next, n) };
    }),
  };
}

function formatReadDepth(lines, readDepth, top) {
  lines.push('');
  if (!readDepth) {
    lines.push('Read depth: not included (needs DATABASE_PUBLIC_URL; see the usage header).');
    return;
  }
  if (readDepth.coverage === 'none') {
    lines.push(`Read depth: none for this window (counting began ${readDepth.liveSince}, Eastern).`);
    return;
  }
  const t = readDepth.totals;
  lines.push('### Read depth (cookie-free counts, hub)');
  lines.push('');
  if (readDepth.coverage === 'partial') {
    lines.push(`- Counting began ${readDepth.liveSince} (Eastern), partway through this window: counts cover only the days since, and rates are left out.`);
  }
  lines.push(`- Page loads reaching 25 / 50 / 75 / 100% of a post: ${t.r25} / ${t.r50} / ${t.r75} / ${t.r100}; reaching the keep-reading row: ${t.next} (loads, not people: a reload counts again)`);
  if (readDepth.coverage === 'full') {
    lines.push(`- Half-read: ${pct(t.halfRate)} of ${t.loads} post loads; reached keep reading: ${pct(t.nextRate)} (over the posts Cloudflare sampled, so approximate)`);
  }
  lines.push('');
  lines.push(`| Post (top ${top} by views) | Loads | 25% | 50% | 75% | 100% | Keep reading | Half-read | Reached keep reading |`);
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const p of readDepth.posts.slice(0, top)) {
    lines.push(`| ${p.path} | ${p.loads} | ${p.r25} | ${p.r50} | ${p.r75} | ${p.r100} | ${p.next} | ${pct(p.halfRate)} | ${pct(p.nextRate)} |`);
  }
}

function formatMarkdown(summary, { start, end, top = 20, readDepth } = {}) {
  const { totals, destinations, posts, sources } = summary;
  const googleSource = (sources || []).find((s) => s.source === 'google') || { views: 0, share: null };
  const lines = [];
  lines.push(`## Blog engagement scorecard, ${start} to ${end}`);
  lines.push('');
  lines.push('Cloudflare Web Analytics: cookieless, every visitor, sampled (small counts are approximate).');
  lines.push('');
  lines.push(`- Blog post views (fresh navigations): ${totals.blogViews}, of which ${totals.blogEntries} began a visit`);
  lines.push(`- Onward page views referred by a post: ${totals.onwardClicks} (${pct(totals.onwardRate)} per post view)`);
  lines.push(`- Blog landings from Google: ${googleSource.views} (${pct(googleSource.share)} of blog landings)`);
  lines.push('- Baseline 2026-07-17 to 2026-09-23: 1.2% (about 100 onward views per 8,220 post views)');
  lines.push('');
  lines.push('| Where onward clicks went | Views |');
  lines.push('|---|---:|');
  if (destinations.length === 0) lines.push('| (none) | 0 |');
  for (const d of destinations) lines.push(`| ${d.label} | ${d.views} |`);
  lines.push('');
  lines.push('### Traffic source (blog-post landings)');
  lines.push('');
  lines.push('| Source | Page loads | Share |');
  lines.push('|---|---:|---:|');
  for (const s of sources || []) lines.push(`| ${s.label} | ${s.views} | ${pct(s.share)} |`);
  lines.push('');
  lines.push("Volume only: Cloudflare RUM carries no visitor id, so onward clicks can't be attributed to the source that landed the reader.");
  lines.push('');
  lines.push(`| Post (top ${top} by views) | Views | Entries | Onward | Rate | To estimate/service |`);
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const p of posts.slice(0, top)) {
    lines.push(`| ${p.path} | ${p.views} | ${p.entries} | ${p.onward} | ${pct(p.rate)} | ${p.toEstimateOrService} |`);
  }
  // undefined: the caller didn't ask for read depth (section omitted);
  // null: asked but unavailable (one line says how to include it).
  if (readDepth !== undefined) formatReadDepth(lines, readDepth, top);
  return `${lines.join('\n')}\n`;
}

const psl = require('psl');
const { cfRequest } = require('../../server/services/intelligence-bar/cloudflare-ops-tools');
const {
  addETDays,
  etDateString,
  parseETDateTime,
  validCalendarDate,
} = require('../../server/utils/datetime-et');

const HUB_HOST = 'wavespestcontrol.com';
const SLICE_DAYS = 7;
const GROUP_LIMIT = 5000;

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[raw] = next;
      i += 1;
    } else {
      out[raw] = true;
    }
  }
  return out;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function shiftETDate(dateStr, days) {
  return etDateString(addETDays(parseETDateTime(`${dateStr}T12:00`), days));
}

function etMidnight(dateStr) {
  return parseETDateTime(`${dateStr}T00:00`);
}

/**
 * The report window in Eastern time: `days` ET calendar days ending the day
 * BEFORE `end` (exclusive; default today ET), queried in 7-day slices that each
 * run ET midnight to ET midnight (DST-safe via parseETDateTime).
 */
function resolveWindow({ days, end } = {}) {
  let endStr;
  if (end == null) {
    endStr = etDateString();
  } else {
    endStr = typeof end === 'string' ? validCalendarDate(end) : null;
    if (!endStr) throw new Error(`--end must be a valid calendar date in YYYY-MM-DD format, got "${end}"`);
  }
  const startStr = shiftETDate(endStr, -days);
  const slices = [];
  for (let from = startStr; from < endStr;) {
    const next = shiftETDate(from, SLICE_DAYS);
    const to = next < endStr ? next : endStr;
    slices.push({ fromStr: from, from: etMidnight(from), to: etMidnight(to) });
    from = to;
  }
  return { startStr, endStr, lastDayStr: shiftETDate(endStr, -1), slices };
}

async function hubSiteTag(accountId) {
  if (process.env.CF_RUM_SITE_TAG) return process.env.CF_RUM_SITE_TAG;
  const body = await cfRequest(`/accounts/${accountId}/rum/site_info/list?per_page=100`);
  const site = (body.result || []).find((s) => [s.host, s.ruleset?.zone_name].includes(HUB_HOST));
  if (!site) throw new Error(`No Cloudflare Web Analytics site found for ${HUB_HOST}`);
  return site.site_tag;
}

const QUERY = `query($acct: string!, $tag: string!, $from: Time!, $to: Time!) {
  viewer { accounts(filter: { accountTag: $acct }) {
    rumPageloadEventsAdaptiveGroups(filter: { siteTag: $tag, datetime_geq: $from, datetime_lt: $to }, limit: ${GROUP_LIMIT}, orderBy: [count_DESC]) {
      count dimensions { requestPath refererHost refererPath navigationType }
    } } } }`;

async function fetchGroups(accountId, siteTag, slices) {
  const groups = [];
  for (const slice of slices) {
    const body = await cfRequest('/graphql', {
      method: 'POST',
      body: {
        query: QUERY,
        variables: { acct: accountId, tag: siteTag, from: slice.from.toISOString(), to: slice.to.toISOString() },
      },
    });
    if (Array.isArray(body.errors) && body.errors.length) throw new Error(`Cloudflare analytics: ${body.errors[0].message}`);
    const rows = body.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
    if (rows.length >= GROUP_LIMIT) {
      console.warn(`warning: the slice starting ${slice.fromStr} hit the ${GROUP_LIMIT}-group limit; totals may be low`);
    }
    for (const r of rows) {
      groups.push({
        path: r.dimensions.requestPath,
        refererHost: r.dimensions.refererHost,
        refererPath: r.dimensions.refererPath,
        navigationType: r.dimensions.navigationType,
        views: r.count,
      });
    }
  }
  return groups;
}

// Read-only: the window's read-depth rows, or null when DATABASE_PUBLIC_URL is
// not in the environment. Same Eastern days as the Cloudflare window.
async function fetchReadDepth(window) {
  if (!process.env.DATABASE_PUBLIC_URL) return null;
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_PUBLIC_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only = on');
    const { rows } = await client.query(
      `SELECT path, milestone, SUM(count)::int AS count
         FROM blog_read_depth_daily
        WHERE site = $1 AND day >= $2::date AND day < $3::date
        GROUP BY path, milestone`,
      [READ_DEPTH_SITE, window.startStr, window.endStr],
    );
    return rows;
  } finally {
    await client.end();
  }
}

async function main() {
  const args = parseArgs();
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!process.env.CF_API_TOKEN || !accountId) {
    throw new Error('CF_API_TOKEN and CF_ACCOUNT_ID are required (run under `railway run --service waves-customer-portal`).');
  }
  const window = resolveWindow({ days: positiveInt(args.days, 7), end: args.end });
  const siteTag = await hubSiteTag(accountId);
  const groups = await fetchGroups(accountId, siteTag, window.slices);
  const summary = summarize(groups);
  let readDepth = null;
  try {
    const depthRows = await fetchReadDepth(window);
    if (depthRows) readDepth = addReadDepth(summary, depthRows, { start: window.startStr, end: window.endStr, loads: blogPostLoads(groups) });
  } catch (err) {
    // The Cloudflare half still prints; say why read depth is missing.
    console.warn(`warning: read depth unavailable (${err.code || err.message})`);
  }
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ start: window.startStr, end: window.lastDayStr, timezone: 'America/New_York', ...summary, readDepth }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMarkdown(summary, { start: window.startStr, end: window.lastDayStr, top: positiveInt(args.top, 20), readDepth }));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`blog-engagement-scorecard: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  addReadDepth,
  blogPostLoads,
  classifyPath,
  classifyTrafficSource,
  countsAsPageView,
  formatMarkdown,
  isInternalHost,
  normalizePath,
  parseArgs,
  resolveWindow,
  summarize,
};
