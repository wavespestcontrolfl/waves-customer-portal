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
// Writes nothing. Needs CF_API_TOKEN (Account Analytics read) and CF_ACCOUNT_ID
// from the environment; CF_RUM_SITE_TAG overrides the site lookup.
//
// Usage (repo root):
//   railway run --service waves-customer-portal node ops/agents/blog-engagement-scorecard.js
//   railway run --service waves-customer-portal node ops/agents/blog-engagement-scorecard.js --days 28 --end 2026-09-26 --top 30
//   railway run --service waves-customer-portal node ops/agents/blog-engagement-scorecard.js --json
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
  if (first === 'blog') return 'blog-index';
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
// cache, the prefetch cache or a prerender; "unknown" is a browser that reports
// no type. Reloads, back/forward, bfcache restores and client-side route
// changes (soft navigation / routing APIs: in-page jumps on this static site)
// re-show or re-address a page and are not new page views.
const COUNTED_NAVIGATION_TYPES = new Set([
  'navigate',
  'navigate-cache',
  'navigate-prefetch-cache',
  'prerender',
  'unknown',
]);

function countsAsPageView(navigationType) {
  if (navigationType == null || navigationType === '') return true;
  const key = String(navigationType).trim().toLowerCase().replace(/[\s_]+/g, '-');
  return COUNTED_NAVIGATION_TYPES.has(key);
}

function isInternalHost(host) {
  return HUB_HOSTS.has(String(host || '').trim().toLowerCase());
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
  };
}

function pct(rate) {
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function formatMarkdown(summary, { start, end, top = 20 } = {}) {
  const { totals, destinations, posts } = summary;
  const lines = [];
  lines.push(`## Blog engagement scorecard, ${start} to ${end}`);
  lines.push('');
  lines.push('Cloudflare Web Analytics: cookieless, every visitor, sampled (small counts are approximate).');
  lines.push('');
  lines.push(`- Blog post views (fresh navigations): ${totals.blogViews}, of which ${totals.blogEntries} began a visit`);
  lines.push(`- Onward page views referred by a post: ${totals.onwardClicks} (${pct(totals.onwardRate)} per post view)`);
  lines.push('- Baseline 2026-07-17 to 2026-09-23: 1.2% (about 100 onward views per 8,220 post views)');
  lines.push('');
  lines.push('| Where onward clicks went | Views |');
  lines.push('|---|---:|');
  if (destinations.length === 0) lines.push('| (none) | 0 |');
  for (const d of destinations) lines.push(`| ${d.label} | ${d.views} |`);
  lines.push('');
  lines.push(`| Post (top ${top} by views) | Views | Entries | Onward | Rate | To estimate/service |`);
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const p of posts.slice(0, top)) {
    lines.push(`| ${p.path} | ${p.views} | ${p.entries} | ${p.onward} | ${pct(p.rate)} | ${p.toEstimateOrService} |`);
  }
  return `${lines.join('\n')}\n`;
}

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

async function main() {
  const args = parseArgs();
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!process.env.CF_API_TOKEN || !accountId) {
    throw new Error('CF_API_TOKEN and CF_ACCOUNT_ID are required (run under `railway run --service waves-customer-portal`).');
  }
  const window = resolveWindow({ days: positiveInt(args.days, 7), end: args.end });
  const siteTag = await hubSiteTag(accountId);
  const summary = summarize(await fetchGroups(accountId, siteTag, window.slices));
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ start: window.startStr, end: window.lastDayStr, timezone: 'America/New_York', ...summary }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMarkdown(summary, { start: window.startStr, end: window.lastDayStr, top: positiveInt(args.top, 20) }));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`blog-engagement-scorecard: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  classifyPath,
  countsAsPageView,
  formatMarkdown,
  isInternalHost,
  normalizePath,
  parseArgs,
  resolveWindow,
  summarize,
};
