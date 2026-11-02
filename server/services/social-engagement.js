const db = require('../models/db');
const logger = require('./logger');

// =============================================================================
// Social engagement ingest — likes/comments/shares for OUR published posts,
// per platform, pulled from the platform APIs into social_post_engagement.
// Feeds the analytics "top posts" ranking (which was most-recent-first
// before this existed) so formats can be judged on what actually gets
// engagement, not on delivery.
//
// Metrics are likes / comments / shares. Reach and views are stored too, but
// only while GATE_SOCIAL_REACH_INGEST is on (owner 2026-11-01, for the weekly
// series job's Sunday numbers) and only for Facebook page posts and Instagram
// media, from the per-post insights endpoints (free Graph reads):
//   Facebook  /{post-id}/insights?metric=post_total_media_view_unique,post_media_view
//             reach = post_total_media_view_unique, views = post_media_view
//             (post_impressions* were removed by Meta in 2025). A Facebook
//             Video node (mediaType 'video') does not support these: not measured.
//   Instagram /{media-id}/insights?metric=reach,views
//             (impressions / plays / video_views are deprecated).
// Not measured is NULL, never zero: an unsupported metric, a missing scope
// (read_insights / pages_read_engagement, instagram_manage_insights) or any
// provider error on the insights call leaves reach / views NULL (the prior
// measured value is kept), never fails the likes / comments fetch, and is
// reported as ONE warning per sweep. Gate off = no insights calls for reach
// and no reach / views columns touched.
//
// Sources: Facebook Graph (page posts + videos), Instagram Graph (media +
// shares insight), LinkedIn socialActions (likes/comments on the page's own
// posts; needs the r_organization_social_feed grant — a token without it is
// skipped for the whole sweep with one warning, see linkedinEngagementReady).
// GBP exposes no per-post metrics.
// Fail-soft per target: a provider error records last_error on that row and
// the sweep continues; nothing here can affect publishing.
// =============================================================================

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const FETCH_TIMEOUT_MS = 10_000;
const ENGAGEMENT_PLATFORMS = new Set(['facebook', 'instagram', 'linkedin']);

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Same weights the competitor swipe file uses (social-content-studio
// engagementScore, minus its views term) — kept inline to avoid pulling the
// studio module into the cron path; the test pins both to the same numbers.
function scoreCounts({ likes = 0, comments = 0, shares = 0 } = {}) {
  return toCount(likes) + toCount(comments) * 3 + toCount(shares) * 5;
}

// ── pure parsers (unit-tested) ──────────────────────────────────────────────

// platforms_posted is the fan-out result array publishToAll persisted
// ({ platform, postId, success, mediaType?, ... }). Only successful entries
// with an id on a platform that exposes metrics become fetch targets.
function engagementTargets(post) {
  const raw = post?.platforms_posted;
  let list = [];
  try {
    list = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  const seen = new Set();
  const targets = [];
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    const platform = String(entry.platform || '').toLowerCase();
    if (!ENGAGEMENT_PLATFORMS.has(platform) || entry.success !== true) continue;
    const platformPostId = String(entry.postId || '').trim();
    if (!platformPostId || seen.has(platform)) continue;
    seen.add(platform);
    targets.push({ platform, platformPostId, mediaType: entry.mediaType || null });
  }
  return targets;
}

function parseFacebookEngagement(json = {}) {
  return {
    likes: toCount(json?.likes?.summary?.total_count),
    comments: toCount(json?.comments?.summary?.total_count),
    shares: toCount(json?.shares?.count),
  };
}

// Instagram media object carries likes/comments; shares come from the
// separate Media Insights call (parseInstagramShares) — null here means
// "not measured in this fetch", never zero.
function parseInstagramEngagement(json = {}) {
  return {
    likes: toCount(json?.like_count),
    comments: toCount(json?.comments_count),
    shares: null,
  };
}

// /{media-id}/insights?metric=shares → { data: [{ name: 'shares',
// values: [{ value }] }] } (or total_value.value on newer API versions).
// null when the metric is absent (unsupported media type / API version).
function parseInstagramShares(json = {}) {
  return insightValue(json, 'shares');
}

// Facebook and Instagram insights share one shape: { data: [{ name, values:
// [{ value }] }] } (or total_value.value). null = the metric is absent.
function insightValue(json, name) {
  const entry = (Array.isArray(json?.data) ? json.data : []).find((d) => d?.name === name);
  if (!entry) return null;
  const raw = entry.total_value?.value ?? entry.values?.[0]?.value;
  return raw == null ? null : toCount(raw);
}

// Facebook post insights → { reach, views } (each null when absent).
function parseFacebookReach(json = {}) {
  return { reach: insightValue(json, 'post_total_media_view_unique'), views: insightValue(json, 'post_media_view') };
}

// Instagram media insights → { reach, views } (each null when absent).
function parseInstagramReach(json = {}) {
  return { reach: insightValue(json, 'reach'), views: insightValue(json, 'views') };
}

// LinkedIn socialActions: likes + comments. Reshares are not exposed by this
// endpoint, so shares is null (not measured), never zero.
function parseLinkedInEngagement(json = {}) {
  return {
    likes: toCount(json?.likesSummary?.totalLikes),
    comments: toCount(json?.commentsSummary?.aggregatedTotalComments ?? json?.commentsSummary?.totalFirstLevelComments),
    shares: null,
  };
}

// ── fetchers ────────────────────────────────────────────────────────────────

async function fetchGraph(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  // A 2xx with an unparseable body is a FAILED fetch, not an all-zero
  // result — a truncated response must not erase the last good counts.
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`Graph ${res.status}: malformed response body`);
  }
  if (!res.ok || body?.error) {
    // Never echo the URL (it carries the access token) — message only.
    throw new Error(`Graph ${res.status}: ${String(body?.error?.message || 'request failed').slice(0, 200)}`);
  }
  return body;
}

// Graph errors that mean the shares insight will NEVER be available for
// this token/media (soft): a missing scope, or Meta rejecting the metric /
// media type. Everything else (timeouts, 5xx, malformed body, unknown 4xx)
// is transient or unknown → null → caller fails the target.
function classifyInsightError(err) {
  const msg = String(err?.message || '');
  if (/permission|#10\b|#200\b|OAuthException/i.test(msg)) return 'permission';
  if (/^Graph 400:/.test(msg) && /unsupported|invalid metric|not support|does not support|#100\b/i.test(msg)) return 'unsupported';
  return null;
}

// Reach + views for one Facebook post / Instagram media (gate on only).
// Never throws: every failure leaves both null ("not measured") and names the
// kind so the sweep can warn once — a reach problem must not fail the target.
async function fetchReachViews(target, { fetchFn }) {
  if (target.platform === 'facebook' && target.mediaType === 'video') return { reach: null, views: null, reachUnavailable: null };
  const id = encodeURIComponent(target.platformPostId);
  const auth = `access_token=${encodeURIComponent(process.env.FACEBOOK_ACCESS_TOKEN)}`;
  const facebook = target.platform === 'facebook';
  const metrics = facebook ? 'post_total_media_view_unique,post_media_view' : 'reach,views';
  try {
    const json = await fetchGraph(`${GRAPH_BASE}/${id}/insights?metric=${metrics}&${auth}`, fetchFn);
    return { ...(facebook ? parseFacebookReach(json) : parseInstagramReach(json)), reachUnavailable: null };
  } catch (err) {
    return { reach: null, views: null, reachUnavailable: classifyInsightError(err) || 'error' };
  }
}

async function fetchEngagement(target, { fetchFn = fetch } = {}) {
  if (target.platform === 'facebook' || target.platform === 'instagram') {
    const counts = await fetchFacebookFamily(target, { fetchFn });
    if (require('../config/feature-gates').socialReachIngestLive()) Object.assign(counts, await fetchReachViews(target, { fetchFn }));
    return counts;
  }
  if (target.platform === 'linkedin') {
    const linkedin = require('./linkedin');
    return parseLinkedInEngagement(await linkedin.fetchSocialActions(target.platformPostId));
  }
  throw new Error(`no engagement source for ${target.platform}`);
}

async function fetchFacebookFamily(target, { fetchFn }) {
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (!token) throw new Error('FACEBOOK_ACCESS_TOKEN not configured');
  const id = encodeURIComponent(target.platformPostId);
  const auth = `access_token=${encodeURIComponent(token)}`;
  if (target.platform === 'facebook') {
    // A Facebook VIDEO object (postToFacebookVideo persists the video id,
    // mediaType 'video') has likes/comments edges but no `shares` field —
    // asking for it rejects the whole query. Post objects get all three.
    const fields = target.mediaType === 'video'
      ? 'likes.summary(true),comments.summary(true)'
      : 'likes.summary(true),comments.summary(true),shares';
    const counts = parseFacebookEngagement(await fetchGraph(`${GRAPH_BASE}/${id}?fields=${fields}&${auth}`, fetchFn));
    if (target.mediaType === 'video') counts.shares = null; // not exposed on Video nodes
    return counts;
  }
  const counts = parseInstagramEngagement(await fetchGraph(`${GRAPH_BASE}/${id}?fields=like_count,comments_count&${auth}`, fetchFn));
  // Shares live in Media Insights (needs the instagram_manage_insights
  // scope on FACEBOOK_ACCESS_TOKEN — see the token procedure in
  // scripts/seed-knowledge-base.js). The metric is also not available for
  // every media type/version. A miss leaves shares null (retain prior
  // value) and is reported on the counts so the sweep can surface it.
  try {
    counts.shares = parseInstagramShares(await fetchGraph(`${GRAPH_BASE}/${id}/insights?metric=shares&${auth}`, fetchFn));
  } catch (err) {
    const kind = classifyInsightError(err);
    // Only a DEFINITIVE "can't have it" is soft (shares stays not-measured,
    // target still syncs). A transient failure — timeout, 5xx, malformed
    // body, network — throws through the normal target-failure path so the
    // row keeps last_error and job health sees it.
    if (!kind) throw err;
    logger.warn(`[social-engagement] instagram shares insight unavailable for ${target.platformPostId}: ${err.message}${kind === 'permission' ? ' — FACEBOOK_ACCESS_TOKEN lacks instagram_manage_insights; regenerate it with that scope' : ''}`);
    counts.shares = null;
    counts.sharesUnavailable = kind;
  }
  return counts;
}

// ── sweep ───────────────────────────────────────────────────────────────────

async function upsertEngagement(postId, target, counts, error = null) {
  const now = new Date();
  const base = {
    post_id: postId,
    platform: target.platform,
    platform_post_id: target.platformPostId,
    fetched_at: now,
    updated_at: now,
    last_error: error ? String(error).slice(0, 500) : null,
  };
  if (!counts) {
    // Failure: a brand-new row exists only to carry the error (its default
    // zero counts are NOT data — last_success_at stays NULL and the rollup
    // ignores it); an existing row keeps its last good counts and stamp.
    await db('social_post_engagement')
      .insert(base)
      .onConflict(['post_id', 'platform'])
      .merge(['fetched_at', 'updated_at', 'last_error']);
    return;
  }
  // A metric the provider did not expose in this fetch (shares === null)
  // keeps the row's previously measured value; with no prior measurement it
  // is stored as NULL — "not measured" never becomes a zero.
  let shares = counts.shares;
  if (shares == null) {
    const prior = await db('social_post_engagement')
      .where({ post_id: postId, platform: target.platform })
      .first('shares_count');
    shares = prior?.shares_count ?? null;
  }
  await db('social_post_engagement')
    .insert({
      ...base,
      likes_count: toCount(counts.likes),
      comments_count: toCount(counts.comments),
      shares_count: shares == null ? null : toCount(shares),
      engagement_score: scoreCounts({ likes: counts.likes, comments: counts.comments, shares: shares ?? 0 }),
      ...(await reachColumns(postId, target, counts)),
      last_success_at: now,
    })
    .onConflict(['post_id', 'platform'])
    .merge();
}

// reach / views columns for the upsert. Only present when this fetch tried
// them (GATE_SOCIAL_REACH_INGEST on): with the gate off the insert carries no
// reach / views at all, so a stored value is never touched. A metric Meta did
// not give (null) keeps the prior measured value, else stays NULL.
async function reachColumns(postId, target, counts) {
  if (counts.reach === undefined) return {};
  let { reach, views } = counts;
  if (reach == null || views == null) {
    const prior = await db('social_post_engagement')
      .where({ post_id: postId, platform: target.platform })
      .first('reach', 'views');
    if (reach == null) reach = prior?.reach ?? null;
    if (views == null) views = prior?.views ?? null;
  }
  return { reach: reach == null ? null : toCount(reach), views: views == null ? null : toCount(views) };
}

// Sweep-style (safe under runExclusive's skip-on-contention): EVERY
// published post inside the lookback window is refreshed each run, walked
// newest-first in keyset batches of `batchSize` so a long backfill window
// reaches its oldest posts (no fixed cap). Idempotent.
// onStart fires once preflight (table check + first batch query) has
// succeeded — the manual-sync route uses it to answer 202 only for a sweep
// that will actually fetch.
async function syncRecentEngagement({ lookbackDays = 30, batchSize = 200, fetchFn = fetch, onStart = null } = {}) {
  // sharesPermissionDenied: Instagram targets whose likes/comments synced
  // but whose shares insight was refused for lack of the
  // instagram_manage_insights scope — the sweep still succeeds, but the
  // count is logged so a missing scope is never invisible.
  const summary = { posts: 0, targets: 0, synced: 0, failed: 0, skippedTargets: 0, sharesPermissionDenied: 0 };
  // Reach / views counters exist only while GATE_SOCIAL_REACH_INGEST is on
  // (read once per sweep), so a gate-off summary is unchanged.
  if (require('../config/feature-gates').socialReachIngestLive()) {
    summary.reachNotMeasured = { permission: { facebook: 0, instagram: 0 }, unsupported: 0, error: 0 };
  }
  if (!(await db.schema.hasTable('social_post_engagement'))) {
    throw new Error('social_post_engagement table missing — run migrations');
  }
  const since = new Date(Date.now() - Math.max(1, Math.min(365, Number(lookbackDays) || 30)) * 86400000);
  const size = Math.max(1, Math.min(1000, Number(batchSize) || 200));
  // LinkedIn is skipped for the whole sweep (not failed per target) when the
  // stored grant can't read engagement — a pre-scope token or no connection.
  const linkedinReady = await require('./linkedin').linkedinEngagementReady();
  if (!linkedinReady.ready) logger.warn(`[social-engagement] LinkedIn targets skipped this sweep: ${linkedinReady.reason}`);
  const skipPlatforms = new Set(linkedinReady.ready ? [] : ['linkedin']);
  let cursor = null; // { ts, id } of the last row of the previous batch
  let started = false;
  for (;;) {
    const batch = await db('social_media_posts')
      .where({ status: 'published' })
      .where((qb) => qb.where('published_at', '>=', since).orWhere((q) => q.whereNull('published_at').andWhere('created_at', '>=', since)))
      // Keyset on the same fallback the predicate uses — a NULL published_at
      // (legacy / tech-authored rows) must not sort first and eat a batch.
      .modify((qb) => {
        if (cursor) qb.whereRaw('(COALESCE(published_at, created_at), id) < (?, ?)', [cursor.ts, cursor.id]);
      })
      .orderByRaw('COALESCE(published_at, created_at) DESC, id DESC')
      .limit(size)
      .select('id', 'platforms_posted', db.raw('COALESCE(published_at, created_at) AS sort_ts'));
    if (!started) { started = true; if (typeof onStart === 'function') onStart(); }
    if (!batch.length) break;
    summary.posts += batch.length;
    await sweepBatch(batch, { fetchFn, summary, skipPlatforms });
    if (batch.length < size) break;
    const last = batch[batch.length - 1];
    cursor = { ts: last.sort_ts, id: last.id };
  }
  logger.info(`[social-engagement] sweep: ${summary.synced}/${summary.targets} targets across ${summary.posts} posts (${summary.failed} failed)`);
  if (summary.sharesPermissionDenied > 0) {
    logger.warn(`[social-engagement] ${summary.sharesPermissionDenied} Instagram target(s) synced WITHOUT shares — FACEBOOK_ACCESS_TOKEN lacks instagram_manage_insights (regenerate per scripts/seed-knowledge-base.js)`);
  }
  warnReachNotMeasured(summary);
  // Per-target failures are soft, but a sweep where EVERY target failed (dead
  // token, provider down) must not read as a healthy run — throw after the
  // sweep so runExclusive's job_health records the failure streak.
  if (summary.targets > 0 && summary.synced === 0) {
    throw new Error(`engagement sweep refreshed 0/${summary.targets} targets — check FACEBOOK_ACCESS_TOKEN / provider status`);
  }
  return summary;
}

// ONE warning per sweep for every target whose reach / views came back not
// measured; a missing scope is named so it is never invisible.
function warnReachNotMeasured(summary) {
  const miss = summary.reachNotMeasured;
  if (!miss) return;
  const fbDenied = miss.permission.facebook;
  const igDenied = miss.permission.instagram;
  const total = fbDenied + igDenied + miss.unsupported + miss.error;
  if (total === 0) return;
  const notes = [];
  if (fbDenied) notes.push(`${fbDenied} Facebook target(s) refused for permission — FACEBOOK_ACCESS_TOKEN needs read_insights and pages_read_engagement`);
  if (igDenied) notes.push(`${igDenied} Instagram target(s) refused for permission — FACEBOOK_ACCESS_TOKEN needs instagram_manage_insights`);
  if (miss.unsupported) notes.push(`${miss.unsupported} unsupported by Meta`);
  if (miss.error) notes.push(`${miss.error} provider error(s)`);
  logger.warn(`[social-engagement] reach/views not measured for ${total} target(s) (stored as NULL): ${notes.join('; ')}`);
}

function tallyReachNotMeasured(summary, target, kind) {
  const miss = summary.reachNotMeasured;
  if (!miss || !kind) return;
  if (kind === 'permission') miss.permission[target.platform] += 1;
  else if (kind === 'unsupported') miss.unsupported += 1;
  else miss.error += 1;
}

async function sweepBatch(posts, { fetchFn, summary, skipPlatforms = new Set() }) {
  for (const post of posts) {
    for (const target of engagementTargets(post)) {
      if (skipPlatforms.has(target.platform)) { summary.skippedTargets += 1; continue; }
      summary.targets += 1;
      try {
        const counts = await fetchEngagement(target, { fetchFn });
        await upsertEngagement(post.id, target, counts);
        summary.synced += 1;
        if (counts.sharesUnavailable === 'permission') summary.sharesPermissionDenied += 1;
        tallyReachNotMeasured(summary, target, counts.reachUnavailable);
      } catch (err) {
        summary.failed += 1;
        await upsertEngagement(post.id, target, null, err.message).catch(() => {});
        logger.warn(`[social-engagement] ${target.platform} fetch failed for post ${post.id}: ${err.message}`);
      }
    }
  }
}

// Per-post rollup for the analytics endpoint: { [post_id]: { likes, comments,
// shares (null = not measured), score, platforms: { fb: {...} } } }.
async function engagementByPost(postIds = []) {
  const out = {};
  if (!postIds.length || !(await db.schema.hasTable('social_post_engagement'))) return out;
  // Only rows that have EVER fetched successfully count as data.
  const rows = await db('social_post_engagement').whereIn('post_id', postIds).whereNotNull('last_success_at');
  for (const r of rows) {
    // shares stays null until some platform row carries a measured value.
    const agg = out[r.post_id] || (out[r.post_id] = { likes: 0, comments: 0, shares: null, score: 0, platforms: {}, fetchedAt: null });
    const counts = { likes: r.likes_count, comments: r.comments_count, shares: r.shares_count };
    agg.likes += counts.likes; agg.comments += counts.comments;
    if (counts.shares != null) agg.shares = (agg.shares ?? 0) + counts.shares;
    agg.score += r.engagement_score;
    agg.platforms[r.platform] = { ...counts, score: r.engagement_score, error: r.last_error || null, lastSuccessAt: r.last_success_at };
    // Age of the DATA (last successful fetch), not of the last attempt —
    // a failed refresh advances fetched_at while the counts stay old.
    if (!agg.fetchedAt || new Date(r.last_success_at) > new Date(agg.fetchedAt)) agg.fetchedAt = r.last_success_at;
  }
  return out;
}

module.exports = {
  ENGAGEMENT_PLATFORMS,
  engagementByPost,
  engagementTargets,
  fetchEngagement,
  parseFacebookEngagement,
  parseInstagramEngagement,
  parseFacebookReach,
  parseInstagramReach,
  parseInstagramShares,
  parseLinkedInEngagement,
  classifyInsightError,
  scoreCounts,
  syncRecentEngagement,
};
