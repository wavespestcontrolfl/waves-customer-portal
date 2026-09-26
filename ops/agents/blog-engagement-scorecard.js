// READ-ONLY: weekly blog engagement scorecard — do blog readers keep going?
//
// Reads Cloudflare Web Analytics (RUM) for the wavespestcontrol.com hub and
// reports, per blog post, how many visits began on it (entries: views that
// arrived from outside the site), how many clicked on to another page of the
// site (onward clicks: views whose referrer path is that post), and where those
// clicks went. A post referring to itself (a reload) is not an onward click.
//
// Cloudflare RUM is cookieless and counts every visitor (GA4 and PostHog only
// see visitors who accept cookies), but it samples, so small counts are
// approximate. Baseline 2026-07-17 → 2026-09-23: ~8,280 blog entries, ~100
// onward clicks (1.2%).
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
//   --end=DATE    first day AFTER the window (YYYY-MM-DD, exclusive), default today (UTC)
//   --top=N       posts listed in the markdown table, default 20
//   --json        print the full summary as JSON instead of markdown

const BLOG_CATEGORIES = new Set(['pest-control', 'lawn-care', 'termite', 'mosquito', 'seasonal', 'tree-shrub']);
const HUB_HOSTS = new Set(['wavespestcontrol.com', 'www.wavespestcontrol.com']);
const ESTIMATE_ROOTS = new Set(['pest-control-calculator', 'estimate', 'quote', 'book', 'contact']);
const SERVICE_HUBS = new Set([
  'pest-control-services',
  'termite-control',
  'termite-inspection',
  'mosquito-control',
  'rodent-control',
  'waveguard-memberships',
]);

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
  if (BLOG_CATEGORIES.has(first)) return segs.length === 1 ? 'blog-category' : 'blog-post';
  if (first === 'pest-library') return 'pest-library';
  if (first === 'pest-identifier') return 'pest-identifier';
  if (first === 'tools') return 'tools';
  if (ESTIMATE_ROOTS.has(first) || first.startsWith('pest-control-quote')) return 'estimate';
  if (SERVICE_HUBS.has(first) || /-fl$/.test(first)) return 'service';
  return 'other';
}

function isInternalHost(host) {
  return HUB_HOSTS.has(String(host || '').trim().toLowerCase());
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {Array<{path: string, refererHost?: string, refererPath?: string, views: number}>} groups
 */
function summarize(groups) {
  const posts = new Map();
  const destinations = new Map();
  let blogEntries = 0;
  let onwardClicks = 0;

  const post = (path) => {
    if (!posts.has(path)) posts.set(path, { path, entries: 0, onward: 0, toEstimateOrService: 0 });
    return posts.get(path);
  };

  for (const g of groups || []) {
    const views = toCount(g.views);
    if (!views) continue;
    const dest = normalizePath(g.path);
    const destClass = classifyPath(dest);
    if (!isInternalHost(g.refererHost)) {
      if (destClass === 'blog-post') {
        post(dest).entries += views;
        blogEntries += views;
      }
      continue;
    }
    const from = normalizePath(g.refererPath);
    // A post referring to itself is a reload or an in-page hop, not an onward click.
    if (classifyPath(from) !== 'blog-post' || from === dest) continue;
    const p = post(from);
    p.onward += views;
    if (destClass === 'estimate' || destClass === 'service') p.toEstimateOrService += views;
    onwardClicks += views;
    destinations.set(destClass, (destinations.get(destClass) || 0) + views);
  }

  const rows = [...posts.values()]
    .map((p) => ({ ...p, rate: p.entries > 0 ? p.onward / p.entries : null }))
    .sort((a, b) => b.entries - a.entries || b.onward - a.onward || a.path.localeCompare(b.path));

  return {
    totals: {
      blogEntries,
      onwardClicks,
      onwardRate: blogEntries > 0 ? onwardClicks / blogEntries : null,
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
  lines.push(`- Blog entries (visits that began on a post): ${totals.blogEntries}`);
  lines.push(`- Onward clicks from posts to another page: ${totals.onwardClicks} (${pct(totals.onwardRate)})`);
  lines.push('- Baseline 2026-07-17 to 2026-09-23: 1.2% (about 100 of 8,280)');
  lines.push('');
  lines.push('| Where onward clicks went | Views |');
  lines.push('|---|---:|');
  if (destinations.length === 0) lines.push('| (none) | 0 |');
  for (const d of destinations) lines.push(`| ${d.label} | ${d.views} |`);
  lines.push('');
  lines.push(`| Post (top ${top} by entries) | Entries | Onward | Rate | To estimate/service |`);
  lines.push('|---|---:|---:|---:|---:|');
  for (const p of posts.slice(0, top)) {
    lines.push(`| ${p.path} | ${p.entries} | ${p.onward} | ${pct(p.rate)} | ${p.toEstimateOrService} |`);
  }
  return `${lines.join('\n')}\n`;
}

const CF_API = process.env.CF_API_BASE || 'https://api.cloudflare.com/client/v4';
const HUB_HOST = 'wavespestcontrol.com';
const DAY_MS = 86400000;
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

function utcMidnight(dateStr) {
  if (dateStr && !/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr))) {
    throw new Error(`--end must be YYYY-MM-DD, got "${dateStr}"`);
  }
  const base = dateStr ? new Date(`${dateStr}T00:00:00Z`) : new Date();
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
}

async function cf(path, init = {}) {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Cloudflare ${path} returned HTTP ${res.status}${body.errors?.[0]?.message ? `: ${body.errors[0].message}` : ''}`);
  }
  return body;
}

async function hubSiteTag(accountId) {
  if (process.env.CF_RUM_SITE_TAG) return process.env.CF_RUM_SITE_TAG;
  const body = await cf(`/accounts/${accountId}/rum/site_info/list?per_page=100`);
  const site = (body.result || []).find((s) => [s.host, s.ruleset?.zone_name].includes(HUB_HOST));
  if (!site) throw new Error(`No Cloudflare Web Analytics site found for ${HUB_HOST}`);
  return site.site_tag;
}

const QUERY = `query($acct: String!, $tag: String!, $from: Time!, $to: Time!, $limit: Int!) {
  viewer { accounts(filter: { accountTag: $acct }) {
    rumPageloadEventsAdaptiveGroups(filter: { siteTag: $tag, datetime_geq: $from, datetime_lt: $to }, limit: $limit, orderBy: [count_DESC]) {
      count dimensions { requestPath refererHost refererPath }
    } } } }`;

async function fetchGroups(accountId, siteTag, start, end) {
  const groups = [];
  for (let from = start; from < end; from = new Date(from.getTime() + SLICE_DAYS * DAY_MS)) {
    const to = new Date(Math.min(end.getTime(), from.getTime() + SLICE_DAYS * DAY_MS));
    const body = await cf('/graphql', {
      method: 'POST',
      body: JSON.stringify({
        query: QUERY,
        variables: { acct: accountId, tag: siteTag, from: from.toISOString(), to: to.toISOString(), limit: GROUP_LIMIT },
      }),
    });
    if (Array.isArray(body.errors) && body.errors.length) throw new Error(`Cloudflare analytics: ${body.errors[0].message}`);
    const rows = body.data?.viewer?.accounts?.[0]?.rumPageloadEventsAdaptiveGroups || [];
    if (rows.length >= GROUP_LIMIT) {
      console.warn(`warning: ${from.toISOString().slice(0, 10)} slice hit the ${GROUP_LIMIT}-group limit; totals may be low`);
    }
    for (const r of rows) {
      groups.push({
        path: r.dimensions.requestPath,
        refererHost: r.dimensions.refererHost,
        refererPath: r.dimensions.refererPath,
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
  const days = positiveInt(args.days, 7);
  const end = utcMidnight(typeof args.end === 'string' ? args.end : null);
  const start = new Date(end.getTime() - days * DAY_MS);
  const siteTag = await hubSiteTag(accountId);
  const summary = summarize(await fetchGroups(accountId, siteTag, start, end));
  const startStr = start.toISOString().slice(0, 10);
  const lastDay = new Date(end.getTime() - DAY_MS).toISOString().slice(0, 10);
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ start: startStr, end: lastDay, ...summary }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMarkdown(summary, { start: startStr, end: lastDay, top: positiveInt(args.top, 20) }));
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
  formatMarkdown,
  isInternalHost,
  normalizePath,
  parseArgs,
  summarize,
  utcMidnight,
};
