/**
 * post-publish-visibility-worker.js
 *
 * Runs after an Astro PR reaches live production. It records the
 * practical visibility checks the content engine needs before learning
 * from a page: live status, canonical, indexability, sitemap presence,
 * IndexNow submission, and AI/crawler readiness.
 */

const db = require('../../models/db');
const logger = require('../logger');
const SitemapManager = require('../seo/sitemap-manager');
const IndexNow = require('../seo/indexnow-submit');
const AiVisibilityGate = require('./ai-visibility-gate');
const { normalizeUrl } = require('../../utils/normalize-url');

async function runForPost(post = {}, options = {}) {
  const url = post.astro_live_url || post.live_url || post.url;
  if (!url) return { ok: false, skipped: true, reason: 'missing_live_url' };
  return runForUrl(url, {
    post,
    contentRegistryMatch: { db_blog_id: post.id },
    ...options,
  });
}

async function runForUrl(url, options = {}) {
  const {
    post = null,
    fetchFn = fetch,
    sitemap = SitemapManager,
    indexNow = IndexNow,
    aiGate = AiVisibilityGate,
    forceIndexNow = false,
    internalInboundLinks = null,
  } = options;

  const checkedAt = new Date();
  const live = await fetchHtml(url, fetchFn);
  const robotsTxt = await fetchRobotsTxt(url, fetchFn);
  const canonicalUrl = live.html ? aiGate._internals.extractCanonical(live.html) : null;
  const robotsMeta = live.html ? aiGate._internals.extractRobotsMeta(live.html) : { raw: '', noindex: false };
  const inferredInboundLinks = internalInboundLinks == null
    ? await countPendingInboundLinks(url).catch(() => 0)
    : internalInboundLinks;

  let sitemapResult = { present: false, error: 'sitemap_manager_unavailable' };
  if (sitemap?.hasUrl) {
    sitemap.invalidate?.();
    sitemapResult = await sitemap.hasUrl(url).catch((err) => ({ present: false, error: err.message }));
  }

  let indexNowResult = { ok: false, status: 'skipped', error: 'indexnow_unavailable' };
  if (indexNow?.submit) {
    indexNowResult = await indexNow.submit(url, { force: forceIndexNow }).catch((err) => ({
      ok: false,
      status: 'error',
      error: err.message,
    }));
  }

  const aiResult = aiGate.evaluate({
    url,
    html: live.html || '',
    canonicalUrl,
    robotsTxt,
    internalInboundLinks: inferredInboundLinks,
    targetKeyword: post?.target_keyword || post?.primary_keyword,
    title: post?.title,
  });

  const snapshot = {
    checked_at: checkedAt.toISOString(),
    url,
    http_status: live.status || null,
    live_ok: live.ok,
    canonical_url: canonicalUrl,
    canonical_matches: canonicalUrl ? aiGate._internals.canonicalsMatch(canonicalUrl, url) : true,
    indexable: live.ok && !robotsMeta.noindex && aiResult.blocked_bots.length === 0,
    robots_meta: robotsMeta.raw || null,
    robots_txt_fetch: robotsTxt ? 'ok' : 'missing_or_unavailable',
    main_content_present: Boolean(aiGate._internals.visibleText(live.html || '').length >= 300),
    sitemap_present: !!sitemapResult.present,
    sitemap_error: sitemapResult.error || null,
    indexnow_status: indexNowResult.status || null,
    indexnow_error: indexNowResult.error || null,
    internal_inbound_links: inferredInboundLinks,
    ai_visibility: aiResult,
  };

  await upsertContentIndexStatus(url, {
    checkedAt,
    sitemapResult,
    indexNowResult,
    aiResult,
    snapshot,
    canonicalUrl,
  });
  await updateContentRegistry(url, {
    post,
    snapshot,
    contentRegistryMatch: options.contentRegistryMatch,
  });

  if (!snapshot.live_ok || aiResult.summary.p0 > 0) {
    logger.warn(`[post-publish-visibility] ${url} visibility issues: http=${snapshot.http_status} p0=${aiResult.summary.p0}`);
    await maybeAlertVisibilityFailure(url, snapshot, aiResult, post).catch((err) => {
      logger.warn(`[post-publish-visibility] visibility alert failed for ${url}: ${err.message}`);
    });
  } else {
    logger.info(`[post-publish-visibility] ${url} live=${snapshot.live_ok} sitemap=${snapshot.sitemap_present} indexnow=${snapshot.indexnow_status}`);
  }

  return { ok: snapshot.live_ok && aiResult.summary.p0 === 0, snapshot };
}

/**
 * Daily cron sweep: re-run visibility checks for recently-published content.
 *
 * pages-poll fires runForPost exactly once at the merged→live flip, and the
 * autonomous PR poller completes runs at merge time — but a check that ran
 * minutes after deploy can miss slow-propagating problems (sitemap lag,
 * canonical/noindex regressions from a later deploy). This sweep re-checks
 * everything published in the last few days:
 *   - blog_posts rows that reached astro_status='live' recently
 *     (scheduler/admin-driven posts), and
 *   - autonomous_runs completed_published rows (no blog_posts row exists for
 *     those — published_url is the only handle).
 * Batch is bounded (limit per source) and every failure logs without
 * throwing, so the cron can never crash on one bad URL. IndexNow inside
 * runForUrl is 24h-throttled, so a daily re-check does not spam submissions.
 *
 * runPost/runUrl are injectable for tests (same options-injection style as
 * runForUrl itself).
 */
async function sweepRecentlyPublished({
  days = 3,
  limit = 10,
  runPost = runForPost,
  runUrl = runForUrl,
} = {}) {
  const cutoff = new Date(Date.now() - days * 86400000);
  const results = [];

  let posts = [];
  try {
    posts = await db('blog_posts')
      .where('astro_status', 'live')
      .whereNotNull('astro_live_url')
      .where('astro_published_at', '>=', cutoff)
      .orderBy('astro_published_at', 'desc')
      .limit(limit)
      .select('id', 'slug', 'title', 'keyword', 'astro_live_url');
  } catch (err) {
    logger.warn(`[post-publish-visibility] sweep blog_posts query failed: ${err.message}`);
  }
  for (const post of posts) {
    try {
      const r = await runPost(post);
      results.push({ source: 'blog_post', id: post.id, url: post.astro_live_url, ok: r?.ok ?? false });
    } catch (err) {
      logger.warn(`[post-publish-visibility] sweep check failed for blog ${post.id}: ${err.message}`);
      results.push({ source: 'blog_post', id: post.id, url: post.astro_live_url, error: err.message });
    }
  }

  let runs = [];
  try {
    runs = await db('autonomous_runs')
      .where('outcome', 'completed_published')
      .whereNotNull('published_url')
      .where('completed_at', '>=', cutoff)
      .orderBy('completed_at', 'desc')
      .limit(limit)
      .select('id', 'published_url');
  } catch (err) {
    logger.warn(`[post-publish-visibility] sweep autonomous_runs query failed: ${err.message}`);
  }
  for (const run of runs) {
    try {
      const r = await runUrl(run.published_url);
      results.push({ source: 'autonomous_run', id: run.id, url: run.published_url, ok: r?.ok ?? false });
    } catch (err) {
      logger.warn(`[post-publish-visibility] sweep check failed for run ${run.id}: ${err.message}`);
      results.push({ source: 'autonomous_run', id: run.id, url: run.published_url, error: err.message });
    }
  }

  logger.info(`[post-publish-visibility] daily sweep checked ${results.length} URL(s) (${posts.length} blog, ${runs.length} autonomous)`);
  return { checked: results.length, results };
}

/**
 * GATE-002: the AI-visibility gate can only run on the LIVE page, so it
 * stays post-publish — but a freshly auto-published blog that lands with a
 * P0 (noindex, robots block, canonical-elsewhere, content not rendered) was
 * previously only logged + flagged 'visibility_review' with nobody notified.
 * With unattended auto-publish live, text the operator so it can be fixed or
 * reverted fast. Default ON for a safety gate on an unattended publisher — set
 * AUTONOMOUS_CONTENT_VISIBILITY_ALERT=false to explicitly silence it. Scoped to
 * engine-published posts, routed as internal_alert (honors OWNER_SMS_DISABLED).
 */
async function maybeAlertVisibilityFailure(url, snapshot, aiResult, post) {
  if (process.env.AUTONOMOUS_CONTENT_VISIBILITY_ALERT === 'false') return;
  if (!post) return; // only engine-published content, not ad-hoc URL audits
  const p0Codes = (aiResult.findings || [])
    .filter((f) => f.severity === 'P0')
    .map((f) => f.code)
    .slice(0, 4);
  const reason = !snapshot.live_ok
    ? `not live (http ${snapshot.http_status || 'n/a'})`
    : `P0 ${p0Codes.join(', ') || 'visibility'}`;
  const body = `Waves content: auto-published page has a visibility problem — ${reason}. ${url}`;
  const twilio = require('../twilio');
  const ownerPhone = process.env.OWNER_PHONE || '+19413187612';
  await twilio.sendSMS(ownerPhone, body, { messageType: 'internal_alert', link: '/admin/seo' });
  logger.info(`[post-publish-visibility] visibility alert sent for ${url}`);
}

async function fetchHtml(url, fetchFn) {
  try {
    const res = await fetchWithTimeout(url, fetchFn, {
      method: 'GET',
      headers: {
        Accept: 'text/html',
        'Cache-Control': 'no-cache',
        'User-Agent': 'WavesContentVisibilityWorker/1.0',
      },
    });
    const html = await res.text().catch(() => '');
    return { ok: res.status >= 200 && res.status < 300, status: res.status, html };
  } catch (err) {
    return { ok: false, status: null, html: '', error: err.message };
  }
}

async function fetchRobotsTxt(url, fetchFn) {
  try {
    const parsed = new URL(url);
    const robotsUrl = `${parsed.origin}/robots.txt`;
    const res = await fetchWithTimeout(robotsUrl, fetchFn, {
      method: 'GET',
      headers: { Accept: 'text/plain', 'User-Agent': 'WavesContentVisibilityWorker/1.0' },
    });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  }
}

async function fetchWithTimeout(url, fetchFn, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetchFn(url, { ...options, redirect: 'follow', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function countPendingInboundLinks(url) {
  const variants = inboundLinkTargetVariants(url);
  const row = await db('content_internal_link_tasks')
    .whereIn('target_url', variants)
    .whereIn('status', ['pending', 'queued', 'patch_candidate', 'approved', 'applied'])
    .count('id as count')
    .first();
  return Number(row?.count || 0);
}

function inboundLinkTargetVariants(url) {
  const raw = String(url || '').trim();
  const normalized = normalizeUrl(raw);
  const variants = new Set([raw, normalized].filter(Boolean));

  if (normalized) {
    variants.add(`https://${normalized}`);
    variants.add(`https://${normalized}/`);
  }

  const rawHostPath = hostPathFromUrl(raw);
  if (rawHostPath) {
    variants.add(rawHostPath);
    variants.add(rawHostPath.replace(/\/$/, ''));
    variants.add(`https://${rawHostPath.replace(/\/$/, '')}`);
    variants.add(`https://${rawHostPath.replace(/\/$/, '')}/`);
  }

  const relativePath = relativePathFromUrl(raw, normalized);
  if (relativePath) {
    variants.add(relativePath);
    variants.add(relativePath.replace(/\/$/, '') || '/');
    if (!relativePath.endsWith('/')) variants.add(`${relativePath}/`);
  }

  return [...variants].filter(Boolean);
}

function hostPathFromUrl(raw) {
  try {
    const parsed = new URL(String(raw || '').trim());
    return `${parsed.host}${parsed.pathname || '/'}`;
  } catch {
    return null;
  }
}

function relativePathFromUrl(raw, normalized) {
  const value = String(raw || '').trim();
  if (value.startsWith('/')) return value.split(/[?#]/)[0] || '/';
  try {
    const parsed = new URL(value);
    return parsed.pathname || '/';
  } catch {
    const candidate = String(normalized || '').replace(/^[^/]*/, '') || '';
    return candidate || null;
  }
}

async function upsertContentIndexStatus(url, payload) {
  const {
    checkedAt,
    sitemapResult,
    indexNowResult,
    aiResult,
    snapshot,
    canonicalUrl,
  } = payload;

  const existing = await db('content_index_status').where('url', url).first().catch(() => null);
  const rawInspection = mergeRawInspection(existing?.raw_inspection, { post_publish_visibility: snapshot });
  const updates = {
    sitemap_checked_at: checkedAt,
    in_sitemap: !!sitemapResult.present,
    canonical_url: canonicalUrl || existing?.canonical_url || null,
    canonical_matches: aiResult._canonical_matches !== false && (!canonicalUrl || AiVisibilityGate._internals.canonicalsMatch(canonicalUrl, url)),
    indexing_state: snapshot.indexable ? 'INDEXING_ALLOWED' : 'BLOCKED_OR_UNVERIFIED',
    verdict: snapshot.live_ok && aiResult.summary.p0 === 0 ? 'PASS' : 'FAIL',
    raw_inspection: rawInspection,
    updated_at: checkedAt,
  };

  if (indexNowResult.status && indexNowResult.status !== 'skipped') {
    updates.indexnow_status = indexNowResult.status;
    updates.indexnow_last_error = indexNowResult.error || null;
    if (indexNowResult.ok) updates.indexnow_submitted_at = checkedAt;
  }

  if (existing) {
    await db('content_index_status').where('url', url).update(updates);
  } else {
    await db('content_index_status').insert({
      url,
      ...updates,
      indexnow_submit_count: indexNowResult.status && indexNowResult.status !== 'skipped' ? 1 : 0,
    });
  }
}

async function updateContentRegistry(url, { post, snapshot, contentRegistryMatch } = {}) {
  const liveStatus = snapshot.live_ok && snapshot.ai_visibility.summary.p0 === 0 ? 'live_visible' : 'visibility_review';
  const updates = {
    live_url: url,
    http_status: snapshot.http_status ? String(snapshot.http_status) : 'unknown',
    live_status: liveStatus,
    canonical_target_url: snapshot.canonical_url || null,
    noindex_detected: snapshot.robots_meta ? /\bnoindex\b/i.test(snapshot.robots_meta) : false,
    sitemap_present: snapshot.sitemap_present,
    sitemap_status: snapshot.sitemap_present ? 'present' : 'missing',
    last_synced_at: new Date(snapshot.checked_at),
    metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) || ?::jsonb`, [JSON.stringify({ post_publish_visibility: snapshot })]),
    updated_at: new Date(snapshot.checked_at),
  };

  let query = db('content_registry');
  if (contentRegistryMatch?.db_blog_id || post?.id) {
    query = query.where('db_blog_id', contentRegistryMatch?.db_blog_id || post.id);
  } else {
    const normalized = normalizeUrl(url);
    query = query.where((builder) => {
      builder.where('live_url', url)
        .orWhere('canonical_url_normalized', normalized)
        .orWhere('canonical_url', url);
    });
  }
  await query.update(updates).catch((err) => {
    logger.warn(`[post-publish-visibility] content_registry update skipped for ${url}: ${err.message}`);
  });
}

function mergeRawInspection(existing, patch) {
  const base = parseJsonObject(existing);
  return { ...base, ...patch };
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = {
  runForPost,
  runForUrl,
  sweepRecentlyPublished,
  _internals: {
    fetchHtml,
    fetchRobotsTxt,
    inboundLinkTargetVariants,
    mergeRawInspection,
    parseJsonObject,
    updateContentRegistry,
    upsertContentIndexStatus,
  },
};
