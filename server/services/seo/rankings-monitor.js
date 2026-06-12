/**
 * rankings-monitor.js — per-page position-before/position-now comparison
 * with change annotations: what we shipped on each page, and when.
 *
 * Two equal GSC windows: current = the last `periodDays` ET days, prior =
 * the `periodDays` before that. Pages are keyed on the canonical URL
 * (tracking-query variants collapsed — mirrors gsc-opportunity-miner's
 * CANON_URL_SQL) plus domain, so spoke pages that share a path don't merge.
 *
 * Annotations are read-only joins from the "we changed this page" sources:
 *   META     rewrite_title_meta — seo_url_experiments + published
 *            autonomous_runs
 *   CONTENT  page refresh / new page — experiments, published runs,
 *            blog_posts Astro merges
 *   LINKS    inbound internal links pointed AT the page —
 *            content_internal_link_tasks merged/deployed/verified/applied
 *   SCHEMA   add_schema experiments
 *
 * Every fetcher is best-effort: an annotation-source failure degrades to
 * "no chips", never a 500 — the position table is the load-bearing part.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

// chr(63) is '?' — a literal '?' inside a knex raw fragment collides with
// knex's positional-binding syntax (same trap documented in
// gsc-opportunity-miner.js; keep the two in sync).
const CANON_URL_SQL = 'split_part(page_url, chr(63), 1)';

const HUB_HOST = 'wavespestcontrol.com';
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_MIN_IMPRESSIONS = 10;
const MAX_ANNOTATIONS_PER_PAGE = 6;
// Positions jitter run-to-run; only a move past this threshold counts as a
// win/loss instead of flat.
const MOVEMENT_EPSILON = 0.5;

const ACTION_CHIP = {
  rewrite_title_meta: 'META',
  refresh_existing_page: 'CONTENT',
  refresh_content: 'CONTENT',
  new_supporting_blog: 'CONTENT',
  create_or_refresh_city_service_page: 'CONTENT',
  create_customer_question_page: 'CONTENT',
  expand_local_proof: 'CONTENT',
  add_internal_links: 'LINKS',
  internal_linking: 'LINKS',
  add_schema: 'SCHEMA',
};

function chipForAction(actionType) {
  return ACTION_CHIP[String(actionType || '').trim()] || null;
}

// ── URL join key (pure) ─────────────────────────────────────────────
//
// host + path, lowercased, www/query/hash/trailing-slash stripped. Path-only
// inputs (internal-link target_url) need assumeHost — those tasks are
// hub-only by construction. Returns null when the URL can't be keyed.
function urlJoinKey(url, { assumeHost = null } = {}) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let host;
  let path;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  } else if (raw.startsWith('/')) {
    if (!assumeHost) return null;
    host = assumeHost;
    path = raw.replace(/[?#].*$/, '');
  } else {
    // 'host/path' form (normalize-url output).
    try {
      const u = new URL(`https://${raw}`);
      host = u.hostname;
      path = u.pathname;
    } catch {
      return null;
    }
  }
  host = host.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.')) return null;
  path = path.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return `${host}${path || '/'}`;
}

// ── date helpers (pure-ish) ─────────────────────────────────────────
//
// Two deliberately different converters (waves-db skill, trap #2):
//  - DATE columns: pg may hand back 'YYYY-MM-DD' strings or a Date parsed
//    at LOCAL midnight. Running an ET conversion on the latter shifts the
//    calendar day on a UTC host — read the local components instead.
//  - timestamptz columns: real instants — convert to the ET calendar day.
function dateColToString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${m}-${d}`;
  }
  return null;
}

function timestampToETDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return etDateString(d);
}

// Calendar-day arithmetic on 'YYYY-MM-DD' strings (UTC-pinned — these are
// pure dates, no timezone in play).
function addDaysToDateString(dateString, days) {
  const [y, m, d] = String(dateString || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/**
 * Both windows anchor on the LATEST SYNCED GSC date, not today — GSC
 * publishes with a ~2-3 day lag, so an ends-today current window would
 * hold period-minus-lag days of data against a full prior period and make
 * every delta look falsely negative (worst on the 7-day view).
 *
 * current = (anchor - period, anchor], prior = the equal window before it.
 */
function windowBounds(periodDays, anchorDateString) {
  const current_since = addDaysToDateString(anchorDateString, -(periodDays - 1));
  return {
    current_since,
    current_to: anchorDateString,
    prior_since: addDaysToDateString(anchorDateString, -(periodDays * 2 - 1)),
  };
}

// ── row assembly (pure) ─────────────────────────────────────────────

function toMetric(row) {
  const clicks = parseInt(row.clicks || 0, 10);
  const impressions = parseInt(row.impressions || 0, 10);
  return {
    clicks,
    impressions,
    position: row.avg_position == null ? null : Math.round(parseFloat(row.avg_position) * 10) / 10,
    ctr: impressions > 0 ? Math.round((clicks / impressions) * 10000) / 100 : 0,
  };
}

function classifyMovement(change, hasPrior) {
  if (!hasPrior) return 'new';
  if (change == null) return 'flat';
  if (change <= -MOVEMENT_EPSILON) return 'win';
  if (change >= MOVEMENT_EPSILON) return 'loss';
  return 'flat';
}

/**
 * Aggregate one window's rows by `${domain}|${urlJoinKey}` — GSC can report
 * the same page as /foo/ and /foo (or a case/www variant) across a
 * canonical change, and the raw URL would split it into a phantom
 * new-page + lost-page pair. Positions combine impression-weighted; the
 * higher-impression variant's URL wins for display.
 */
function mergeWindowRows(rows = []) {
  const byKey = new Map();
  for (const row of rows) {
    const joinKey = urlJoinKey(row.page_url);
    if (!joinKey) continue;
    const mapKey = `${row.domain || ''}|${joinKey}`;
    const metric = toMetric(row);
    const existing = byKey.get(mapKey);
    if (!existing) {
      byKey.set(mapKey, {
        page_url: row.page_url,
        domain: row.domain || null,
        page_type: row.page_type || null,
        join_key: joinKey,
        clicks: metric.clicks,
        impressions: metric.impressions,
        weighted_pos: metric.position != null ? metric.position * metric.impressions : 0,
        weight: metric.position != null ? metric.impressions : 0,
      });
      continue;
    }
    if (metric.impressions > existing.impressions) {
      existing.page_url = row.page_url;
      existing.page_type = row.page_type || existing.page_type;
    }
    existing.clicks += metric.clicks;
    existing.impressions += metric.impressions;
    if (metric.position != null) {
      existing.weighted_pos += metric.position * metric.impressions;
      existing.weight += metric.impressions;
    }
  }
  for (const entry of byKey.values()) {
    entry.position = entry.weight > 0 ? Math.round((entry.weighted_pos / entry.weight) * 10) / 10 : null;
    entry.ctr = entry.impressions > 0 ? Math.round((entry.clicks / entry.impressions) * 10000) / 100 : 0;
  }
  return byKey;
}

/**
 * Join the two windows into page rows on the canonical key. Pages below
 * the impressions floor in BOTH windows are dropped — single-impression
 * pages produce junk position math. Pages present in the prior window but
 * ABSENT from the current one (GSC only returns rows for pages that got
 * impressions) are emitted as movement='lost' — those are the hardest
 * ranking drops and must not vanish from the monitor.
 */
function buildRows(currentRows = [], priorRows = [], { minImpressions = DEFAULT_MIN_IMPRESSIONS } = {}) {
  const current = mergeWindowRows(currentRows);
  const prior = mergeWindowRows(priorRows);
  const out = [];
  for (const [mapKey, now] of current) {
    const before = prior.get(mapKey) || null;
    if (now.impressions < minImpressions && (!before || before.impressions < minImpressions)) continue;
    const change = before && before.position != null && now.position != null
      ? Math.round((now.position - before.position) * 10) / 10
      : null;
    out.push({
      page_url: now.page_url,
      domain: now.domain,
      page_type: now.page_type,
      join_key: now.join_key,
      pos_before: before ? before.position : null,
      pos_now: now.position,
      change,
      movement: classifyMovement(change, Boolean(before)),
      clicks_before: before ? before.clicks : null,
      clicks_now: now.clicks,
      impressions_before: before ? before.impressions : null,
      impressions_now: now.impressions,
      ctr_before: before ? before.ctr : null,
      ctr_now: now.ctr,
      annotations: [],
    });
  }
  for (const [mapKey, before] of prior) {
    if (current.has(mapKey)) continue;
    if (before.impressions < minImpressions) continue;
    out.push({
      page_url: before.page_url,
      domain: before.domain,
      page_type: before.page_type,
      join_key: before.join_key,
      pos_before: before.position,
      pos_now: null,
      change: null,
      movement: 'lost',
      clicks_before: before.clicks,
      clicks_now: 0,
      impressions_before: before.impressions,
      impressions_now: 0,
      ctr_before: before.ctr,
      ctr_now: 0,
      annotations: [],
    });
  }
  return out;
}

/**
 * Merge raw annotations (same page + chip type + day from several sources
 * collapse into one chip), then attach to page rows by join key, most
 * recent first, capped.
 */
function attachAnnotations(rows = [], annotations = []) {
  const merged = new Map();
  for (const ann of annotations) {
    if (!ann?.key || !ann.type || !ann.date) continue;
    const mapKey = `${ann.key}|${ann.type}|${ann.date}`;
    const existing = merged.get(mapKey);
    if (!existing) {
      merged.set(mapKey, { ...ann, count: ann.count || 1, sources: [ann.source].filter(Boolean) });
      continue;
    }
    existing.count += ann.count || 1;
    if (ann.source && !existing.sources.includes(ann.source)) existing.sources.push(ann.source);
    // Experiments carry the verdict — prefer their status over a bare event.
    if (ann.status && (!existing.status || ann.source === 'experiment')) existing.status = ann.status;
  }
  const byPage = new Map();
  for (const ann of merged.values()) {
    if (!byPage.has(ann.key)) byPage.set(ann.key, []);
    byPage.get(ann.key).push(ann);
  }
  for (const row of rows) {
    const anns = byPage.get(row.join_key);
    if (!anns) continue;
    row.annotations = anns
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, MAX_ANNOTATIONS_PER_PAGE)
      .map(({ key, sources, ...rest }) => ({ ...rest, sources }));
  }
  return rows;
}

function summarize(rows = []) {
  const sum = {
    clicks_now: 0, clicks_before: 0,
    impressions_now: 0, impressions_before: 0,
    weighted_pos_now: 0, weighted_pos_before: 0,
    pages_now: 0, pages_before: 0,
    wins: 0, losses: 0, flat: 0, new_pages: 0, lost: 0,
  };
  for (const row of rows) {
    sum.clicks_now += row.clicks_now;
    sum.impressions_now += row.impressions_now;
    if (row.pos_now != null) sum.weighted_pos_now += row.pos_now * row.impressions_now;
    if (row.movement !== 'lost') sum.pages_now += 1;
    if (row.pos_before != null) {
      sum.clicks_before += row.clicks_before || 0;
      sum.impressions_before += row.impressions_before || 0;
      sum.weighted_pos_before += row.pos_before * (row.impressions_before || 0);
      sum.pages_before += 1;
    }
    if (row.movement === 'win') sum.wins += 1;
    else if (row.movement === 'loss') sum.losses += 1;
    else if (row.movement === 'lost') sum.lost += 1;
    else if (row.movement === 'new') sum.new_pages += 1;
    else sum.flat += 1;
  }
  const avgNow = sum.impressions_now > 0 ? Math.round((sum.weighted_pos_now / sum.impressions_now) * 10) / 10 : null;
  const avgBefore = sum.impressions_before > 0 ? Math.round((sum.weighted_pos_before / sum.impressions_before) * 10) / 10 : null;
  return {
    clicks: sum.clicks_now,
    clicks_delta: sum.clicks_now - sum.clicks_before,
    impressions: sum.impressions_now,
    impressions_delta: sum.impressions_now - sum.impressions_before,
    avg_position: avgNow,
    avg_position_delta: avgNow != null && avgBefore != null ? Math.round((avgNow - avgBefore) * 10) / 10 : null,
    pages_tracked: sum.pages_now,
    pages_tracked_delta: sum.pages_now - sum.pages_before,
    wins: sum.wins,
    losses: sum.losses,
    lost: sum.lost,
    flat: sum.flat,
    new_pages: sum.new_pages,
  };
}

// ── annotation fetchers (DB, best-effort) ───────────────────────────

async function fetchExperimentAnnotations(sinceDateString) {
  const rows = await db('seo_url_experiments')
    .where('publish_date', '>=', sinceDateString)
    .select('url', 'action_type', 'publish_date', 'status');
  const out = [];
  for (const row of rows) {
    const type = chipForAction(row.action_type);
    const key = urlJoinKey(row.url);
    const date = dateColToString(row.publish_date);
    if (!type || !key || !date) continue;
    out.push({ key, type, date, source: 'experiment', status: row.status || null });
  }
  return out;
}

async function fetchAutonomousRunAnnotations(sinceDate) {
  const rows = await db('autonomous_runs')
    .where('outcome', 'completed_published')
    .whereNotNull('published_url')
    .where('completed_at', '>=', sinceDate)
    .select('published_url', 'action_type', 'completed_at');
  const out = [];
  for (const row of rows) {
    const type = chipForAction(row.action_type);
    const key = urlJoinKey(row.published_url);
    const date = timestampToETDate(row.completed_at);
    if (!type || !key || !date) continue;
    out.push({ key, type, date, source: 'autonomous_run' });
  }
  return out;
}

async function fetchInternalLinkAnnotations(sinceDate) {
  // A task can merge before the window cutoff but deploy/verify inside it —
  // match on ANY lifecycle timestamp in the window, and chip the date the
  // link actually became live (deploy when known, else merge).
  const rows = await db('content_internal_link_tasks')
    .whereIn('status', ['merged', 'deployed', 'verified', 'applied'])
    .where((builder) => {
      builder
        .where('merged_at', '>=', sinceDate)
        .orWhere('deployed_at', '>=', sinceDate)
        .orWhere('verified_at', '>=', sinceDate)
        .orWhere('applied_at', '>=', sinceDate);
    })
    .select('target_url', 'status', 'merged_at', 'deployed_at', 'verified_at', 'applied_at');
  const out = [];
  for (const row of rows) {
    const key = urlJoinKey(row.target_url, { assumeHost: HUB_HOST });
    const date = timestampToETDate(row.deployed_at || row.merged_at || row.applied_at || row.verified_at);
    if (!key || !date) continue;
    out.push({ key, type: 'LINKS', date, source: 'internal_link' });
  }
  return out;
}

async function fetchBlogPublishAnnotations(sinceDate) {
  const rows = await db('blog_posts')
    .whereNotNull('astro_live_url')
    .where('astro_merged_at', '>=', sinceDate)
    .select('astro_live_url', 'astro_merged_at');
  const out = [];
  for (const row of rows) {
    const key = urlJoinKey(row.astro_live_url);
    const date = timestampToETDate(row.astro_merged_at);
    if (!key || !date) continue;
    out.push({ key, type: 'CONTENT', date, source: 'blog' });
  }
  return out;
}

async function fetchAllAnnotations({ sinceDateString, sinceDate }) {
  const sources = [
    ['experiments', () => fetchExperimentAnnotations(sinceDateString)],
    ['autonomous_runs', () => fetchAutonomousRunAnnotations(sinceDate)],
    ['internal_links', () => fetchInternalLinkAnnotations(sinceDate)],
    ['blog_posts', () => fetchBlogPublishAnnotations(sinceDate)],
  ];
  const out = [];
  for (const [name, fn] of sources) {
    try {
      out.push(...await fn());
    } catch (err) {
      logger.warn(`[rankings-monitor] annotation source ${name} failed: ${err.message}`);
    }
  }
  return out;
}

// ── window queries ──────────────────────────────────────────────────

function pageWindowQuery({ since, until = null, domain = null, type = null }) {
  let query = db('gsc_pages')
    .where('date', '>=', since)
    .select(db.raw(`${CANON_URL_SQL} as page_url`), 'domain')
    .max('page_type as page_type')
    .sum('clicks as clicks')
    .sum('impressions as impressions')
    // GSC's own aggregate position is impression-weighted — an unweighted
    // avg() lets a 1-impression day at position 1 halve a page's reported
    // position and fabricate wins/losses.
    .select(db.raw('sum(position * impressions) / nullif(sum(impressions), 0) as avg_position'))
    .groupByRaw(`${CANON_URL_SQL}, domain`);
  if (until) query = query.where('date', '<', until);
  if (domain) query = query.where('domain', domain);
  if (type) query = query.where('page_type', type);
  return query;
}

// Latest date the GSC sync has actually written — the anchor both windows
// hang from (see windowBounds).
async function latestSyncedDate({ domain = null, type = null } = {}) {
  let query = db('gsc_pages').max('date as max_date');
  if (domain) query = query.where('domain', domain);
  if (type) query = query.where('page_type', type);
  const row = await query.first();
  return dateColToString(row?.max_date);
}

// ── entry point ─────────────────────────────────────────────────────

async function build({
  periodDays = 90,
  domain = null,
  type = null,
  limit = DEFAULT_LIMIT,
  minImpressions = DEFAULT_MIN_IMPRESSIONS,
  now = new Date(),
} = {}) {
  const anchor = (await latestSyncedDate({ domain, type })) || etDateString(now);
  const bounds = windowBounds(periodDays, anchor);
  const [currentRows, priorRows] = await Promise.all([
    pageWindowQuery({ since: bounds.current_since, domain, type }),
    pageWindowQuery({ since: bounds.prior_since, until: bounds.current_since, domain, type }),
  ]);

  const rows = buildRows(currentRows, priorRows, { minImpressions });
  // Annotations span both windows: a change made in the prior window is
  // exactly what explains movement between them. The timestamp boundary
  // tracks the anchored span (plus the sync lag days between anchor and
  // now, which only widens the net).
  const annotations = await fetchAllAnnotations({
    sinceDateString: bounds.prior_since,
    sinceDate: addETDays(now, -periodDays * 2),
  });
  attachAnnotations(rows, annotations);

  const summary = summarize(rows);
  // Movers first (biggest absolute change), then by current impressions —
  // the client partitions wins/losses/new from `movement`.
  rows.sort((a, b) => {
    const aChange = a.change == null ? 0 : Math.abs(a.change);
    const bChange = b.change == null ? 0 : Math.abs(b.change);
    if (bChange !== aChange) return bChange - aChange;
    return b.impressions_now - a.impressions_now;
  });

  const boundedLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  return {
    window: {
      period_days: periodDays,
      anchored_to: anchor,
      current: { from: bounds.current_since, to: bounds.current_to },
      prior: { from: bounds.prior_since, to: addDaysToDateString(bounds.current_since, -1) },
    },
    summary,
    pages: rows.slice(0, boundedLimit).map(({ join_key, ...rest }) => rest),
  };
}

module.exports = { build };
module.exports._internals = {
  CANON_URL_SQL,
  HUB_HOST,
  ACTION_CHIP,
  MOVEMENT_EPSILON,
  chipForAction,
  urlJoinKey,
  dateColToString,
  timestampToETDate,
  addDaysToDateString,
  windowBounds,
  toMetric,
  classifyMovement,
  mergeWindowRows,
  buildRows,
  attachAnnotations,
  summarize,
};
