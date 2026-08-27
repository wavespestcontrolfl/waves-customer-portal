const db = require('../models/db');
const logger = require('./logger');

// =============================================================================
// Social engagement ingest — likes/comments/shares/views for OUR published
// posts, per platform, pulled from the platform APIs into
// social_post_engagement. Feeds the analytics "top posts" ranking (which was
// most-recent-first before this existed) so formats can be judged on what
// actually gets engagement, not on delivery.
//
// Sources: Facebook Graph (page posts + videos), Instagram Graph (media),
// LinkedIn socialActions (share/ugcPost URNs). GBP exposes no per-post
// metrics. Fail-soft per target: a provider error records last_error on that
// row and the sweep continues; nothing here can affect publishing.
// =============================================================================

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const FETCH_TIMEOUT_MS = 10_000;
const ENGAGEMENT_PLATFORMS = new Set(['facebook', 'instagram', 'linkedin']);

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// Same formula the competitor swipe file uses (social-content-studio
// engagementScore) — kept inline to avoid pulling the studio module into
// the cron path; the studio test pins both to the same numbers.
function scoreCounts({ likes = 0, comments = 0, shares = 0, views = 0 } = {}) {
  return Math.round(toCount(likes) + toCount(comments) * 3 + toCount(shares) * 5 + toCount(views) / 100);
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
    views: 0,
  };
}

function parseInstagramEngagement(json = {}) {
  return {
    likes: toCount(json?.like_count),
    comments: toCount(json?.comments_count),
    shares: 0,
    views: 0,
  };
}

function parseLinkedInEngagement(json = {}) {
  return {
    likes: toCount(json?.likesSummary?.totalLikes),
    comments: toCount(json?.commentsSummary?.aggregatedTotalComments ?? json?.commentsSummary?.totalFirstLevelComments),
    shares: 0,
    views: 0,
  };
}

// ── fetchers ────────────────────────────────────────────────────────────────

async function fetchGraph(url, fetchFn) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) {
    // Never echo the URL (it carries the access token) — message only.
    throw new Error(`Graph ${res.status}: ${String(body?.error?.message || 'request failed').slice(0, 200)}`);
  }
  return body;
}

async function fetchEngagement(target, { fetchFn = fetch } = {}) {
  if (target.platform === 'facebook' || target.platform === 'instagram') {
    const token = process.env.FACEBOOK_ACCESS_TOKEN;
    if (!token) throw new Error('FACEBOOK_ACCESS_TOKEN not configured');
    const fields = target.platform === 'facebook'
      ? 'likes.summary(true),comments.summary(true),shares'
      : 'like_count,comments_count';
    const url = `${GRAPH_BASE}/${encodeURIComponent(target.platformPostId)}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
    const body = await fetchGraph(url, fetchFn);
    return target.platform === 'facebook' ? parseFacebookEngagement(body) : parseInstagramEngagement(body);
  }
  if (target.platform === 'linkedin') {
    const linkedin = require('./linkedin');
    if (!linkedin.configured) throw new Error('LinkedIn not configured');
    return parseLinkedInEngagement(await linkedin.fetchSocialActions(target.platformPostId));
  }
  throw new Error(`no engagement source for ${target.platform}`);
}

// ── sweep ───────────────────────────────────────────────────────────────────

async function upsertEngagement(postId, target, counts, error = null) {
  const row = {
    post_id: postId,
    platform: target.platform,
    platform_post_id: target.platformPostId,
    fetched_at: new Date(),
    updated_at: new Date(),
    last_error: error ? String(error).slice(0, 500) : null,
  };
  if (counts) {
    Object.assign(row, {
      likes_count: toCount(counts.likes),
      comments_count: toCount(counts.comments),
      shares_count: toCount(counts.shares),
      views_count: toCount(counts.views),
      engagement_score: scoreCounts(counts),
    });
  }
  // On a fetch error keep the last good counts (merge only touches the
  // columns present in `row`), so one bad day doesn't zero a post's history.
  await db('social_post_engagement').insert(row).onConflict(['post_id', 'platform']).merge();
}

// Sweep-style (safe under runExclusive's skip-on-contention): every
// published post inside the lookback window is refreshed each run. Idempotent.
async function syncRecentEngagement({ lookbackDays = 30, limit = 200, fetchFn = fetch } = {}) {
  const summary = { posts: 0, targets: 0, synced: 0, failed: 0, skipped: 0 };
  if (!(await db.schema.hasTable('social_post_engagement'))) {
    return { ...summary, skipped: 1, reason: 'social_post_engagement table missing' };
  }
  const since = new Date(Date.now() - Math.max(1, Math.min(365, Number(lookbackDays) || 30)) * 86400000);
  const posts = await db('social_media_posts')
    .where({ status: 'published' })
    .where((qb) => qb.where('published_at', '>=', since).orWhere((q) => q.whereNull('published_at').andWhere('created_at', '>=', since)))
    .orderBy('published_at', 'desc')
    .limit(Math.max(1, Math.min(1000, Number(limit) || 200)))
    .select('id', 'platforms_posted');
  summary.posts = posts.length;

  for (const post of posts) {
    for (const target of engagementTargets(post)) {
      summary.targets += 1;
      try {
        const counts = await fetchEngagement(target, { fetchFn });
        await upsertEngagement(post.id, target, counts);
        summary.synced += 1;
      } catch (err) {
        summary.failed += 1;
        await upsertEngagement(post.id, target, null, err.message).catch(() => {});
        logger.warn(`[social-engagement] ${target.platform} fetch failed for post ${post.id}: ${err.message}`);
      }
    }
  }
  logger.info(`[social-engagement] sweep: ${summary.synced}/${summary.targets} targets across ${summary.posts} posts (${summary.failed} failed)`);
  return summary;
}

// Per-post rollup for the analytics endpoint: { [post_id]: { likes, comments,
// shares, views, score, platforms: { fb: {...} } } } for the given post ids.
async function engagementByPost(postIds = []) {
  const out = {};
  if (!postIds.length || !(await db.schema.hasTable('social_post_engagement'))) return out;
  const rows = await db('social_post_engagement').whereIn('post_id', postIds);
  for (const r of rows) {
    const agg = out[r.post_id] || (out[r.post_id] = { likes: 0, comments: 0, shares: 0, views: 0, score: 0, platforms: {}, fetchedAt: null });
    const counts = { likes: r.likes_count, comments: r.comments_count, shares: r.shares_count, views: r.views_count };
    agg.likes += counts.likes; agg.comments += counts.comments; agg.shares += counts.shares; agg.views += counts.views;
    agg.score += r.engagement_score;
    agg.platforms[r.platform] = { ...counts, score: r.engagement_score, error: r.last_error || null };
    if (!agg.fetchedAt || new Date(r.fetched_at) > new Date(agg.fetchedAt)) agg.fetchedAt = r.fetched_at;
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
  parseLinkedInEngagement,
  scoreCounts,
  syncRecentEngagement,
};
