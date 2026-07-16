const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const BlogWriter = require('../services/content/blog-writer');
const BlogAuditor = require('../services/content/blog-auditor');
const logger = require('../services/logger');
const MODELS = require('../config/models');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { invalidSpokeSites } = require('../services/content-astro/spoke-sites');
const autonomousReviewQueue = require('../services/content/autonomous-review-queue');
const internalLinkReviewQueue = require('../services/content/internal-link-review-queue');
const { isEnabled } = require('../config/feature-gates');

router.use(adminAuthenticate, requireAdmin);

const aiContentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `tech_${req.technicianId || req.ip}`,
  message: { error: 'Too many AI content requests in the last hour. Try again later.' },
});

const CONTENT_LIMITS = {
  bulkGenerateMax: 10,
  ideaCountMax: 50,
  topicMaxChars: 500,
};

const ALLOWED_CONTENT_TYPES = new Set(['blog_post', 'page_refresh', 'pest_pressure', 'gbp_post', 'service_page']);
const ALLOWED_TARGET_CITIES = new Set(['Lakewood Ranch', 'Parrish', 'Bradenton', 'Sarasota', 'Venice', 'North Port', 'Palmetto', 'Port Charlotte']);
const HUB_BLOG_TARGET_SITES = ['wavespestcontrol.com'];

const BLOG_UPDATE_FIELDS = new Set([
  'title',
  'content',
  'meta_description',
  'keyword',
  'tag',
  'status',
  'author_slug',
  'reviewer_slug',
  'technically_reviewed_at',
  'fact_checked_at',
  'category',
  'post_type',
  'service_areas_tag',
  'related_services',
  'target_sites',
  'hero_image_alt',
]);

// Full persisted set: the blog_content migration documents
// idea/queued/draft/wp_draft/scheduled/published, and the archive flow
// (scripts/archive-stale-blog-rows.js) writes 'archived'. The editor always
// sends the row's current status on save, so a narrower allowlist would 400
// every edit of a row in the missing state.
const BLOG_STATUS_VALUES = new Set(['idea', 'queued', 'draft', 'wp_draft', 'scheduled', 'published', 'archived']);

// Astro states in which the row's content is load-bearing outside this table
// (an open PR, a merged commit, or a live page hangs off it) — destructive
// row operations must go through the astro lifecycle endpoints instead.
// build_failed keeps its open PR/branch; publish_failed can too when the
// failure landed after PR creation — and publishAstro can fail AFTER
// creating a branch but BEFORE the PR exists, leaving astro_branch_name as
// the row's ONLY reference to the surviving branch (the scheduler reclaims
// it rather than retrying blind). So both external markers count as active,
// not just the PR number.
const ASTRO_PIPELINE_ACTIVE = new Set(['pr_open', 'build_failed', 'merged', 'live', 'unpublish_pending']);

function astroActivePost(post) {
  return Boolean(post && (
    ASTRO_PIPELINE_ACTIVE.has(post.astro_status) || post.astro_pr_number || post.astro_branch_name
  ));
}

// Atomic variant of the same predicate for WHERE clauses — the read-side
// check alone is a check-then-act race (a publisher can open a PR between
// the read and the destructive write). NULL semantics: whereNotIn excludes
// NULL astro_status rows, hence the orWhereNull.
// Manual-publish claim window: a publish_claimed_at younger than this owns
// the row (the manual /publish-astro lane sets it; pages-poll never reads
// it, so it can't be mistaken for scheduler auto-merge authorization).
// Older claims are crashed publishes — staleness is inherent, no sweep.
const PUBLISH_CLAIM_STALE_MS = 30 * 60 * 1000;

function publishClaimActive(post) {
  if (!post || !post.publish_claimed_at) return false;
  const at = new Date(post.publish_claimed_at).getTime();
  return Number.isFinite(at) && (Date.now() - at) < PUBLISH_CLAIM_STALE_MS;
}

function whereNoLivePublishClaim(query) {
  return query.where((q) => q.whereNull('publish_claimed_at')
    .orWhere('publish_claimed_at', '<', new Date(Date.now() - PUBLISH_CLAIM_STALE_MS)));
}

function whereNotAstroActive(query) {
  return whereNoLivePublishClaim(
    query
      .whereNull('astro_pr_number')
      .whereNull('astro_branch_name')
      // Mid-publish scheduler claim: markers don't exist yet but a publisher
      // owns the row.
      .where((q) => q.whereNull('publish_status').orWhereNot('publish_status', 'publishing'))
      .where((q) => q.whereNull('astro_status').orWhereNotIn('astro_status', Array.from(ASTRO_PIPELINE_ACTIVE))),
  );
}

const BLOG_SORT_COLUMNS = new Set([
  'publish_date', 'created_at', 'updated_at', 'title', 'status', 'city', 'tag', 'word_count', 'seo_score',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// blog_posts.id is a uuid PK — junk ids previously reached Postgres and
// crashed as 22P02 500s instead of a clean 404.
function assertBlogPostId(id) {
  if (!UUID_RE.test(String(id || ''))) {
    const err = new Error('Post not found');
    err.isOperational = true;
    err.statusCode = 404;
    throw err;
  }
}

function pickAllowedBlogUpdates(body) {
  const updates = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (BLOG_UPDATE_FIELDS.has(key)) updates[key] = value;
  }
  return updates;
}

function normalizeBlogUpdates(body) {
  const updates = pickAllowedBlogUpdates(body);
  if (Object.prototype.hasOwnProperty.call(updates, 'target_sites')) {
    const invalid = invalidSpokeSites(updates.target_sites);
    if (invalid.length > 0) {
      throw operationalBadRequest(`target_sites contains unsupported domains: ${invalid.join(', ')}`);
    }
    updates.target_sites = [...HUB_BLOG_TARGET_SITES];
  }
  return updates;
}

function operationalBadRequest(message) {
  const err = new Error(message);
  err.isOperational = true;
  err.statusCode = 400;
  return err;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function imageExtFromMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  return null;
}

function imageExtFromSource(value) {
  const dataMatch = String(value || '').match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  return imageExtFromMime(dataMatch?.[1]?.toLowerCase()) || 'webp';
}

function blogSlug(post) {
  return String(post.slug || slugify(post.title)).replace(/^\/+|\/+$/g, '');
}

function hasPublishedAstroHero(post) {
  return post.astro_status === 'live';
}

function publicBlogImageUrl(post) {
  for (const raw of [post.featured_image_url, post.image_url, post.og_image]) {
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) return raw;
    if (raw.startsWith('/')) return `https://www.wavespestcontrol.com${raw}`;
    if (/^data:image\//i.test(raw) && hasPublishedAstroHero(post)) {
      const slug = blogSlug(post);
      if (slug) return `https://www.wavespestcontrol.com/images/blog/${slug}/hero.${imageExtFromSource(raw)}`;
    }
  }
  return undefined;
}

function parseBoundedInt(value, { defaultValue, min, max, name }) {
  const raw = value == null || value === '' ? defaultValue : value;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw operationalBadRequest(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeGenerateBody(body = {}) {
  const topic = String(body.topic || '').trim();
  if (!topic) throw operationalBadRequest('Topic is required');
  if (topic.length > CONTENT_LIMITS.topicMaxChars) {
    throw operationalBadRequest(`Topic must be ${CONTENT_LIMITS.topicMaxChars} characters or fewer`);
  }

  const contentType = body.contentType || 'blog_post';
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw operationalBadRequest(`contentType must be one of: ${Array.from(ALLOWED_CONTENT_TYPES).join(', ')}`);
  }

  const targetCity = body.targetCity || 'Lakewood Ranch';
  if (!ALLOWED_TARGET_CITIES.has(targetCity)) {
    throw operationalBadRequest(`targetCity must be one of: ${Array.from(ALLOWED_TARGET_CITIES).join(', ')}`);
  }

  return { topic, contentType, targetCity };
}

// ── Gemini hero-image generator ─────────────────────────────────────
//
// Shared between POST /generate (initial draft creation) and POST
// /blog/:id/regenerate-image (operator-triggered retry). Returns a
// `data:` URL on success; throws a typed Error otherwise so the
// caller can surface the reason to the UI instead of silent-failing.
//
// Call sites are expected to wrap this in try/catch and store the
// error string alongside the post for display.
async function generateFeaturedImage({ title, topic, keyword }) {
  // Delegates to the provider-chained image-generator (gpt-image-2 →
  // gpt-image-1.5 → gpt-image-1 → gemini by default; override via
  // BLOG_IMAGE_PROVIDER env). Gemini is still in the chain by default
  // so this keeps working with only GEMINI_API_KEY set.
  const imageGenerator = require('../services/content/image-generator');
  try {
    const result = await imageGenerator.generate({ title, topic, keyword, mode: 'blog-hero' });
    logger.info(`[content] Generated featured image for "${title}" via ${result.model}`);
    return result.dataUrl;
  } catch (err) {
    // Match the legacy throw contract — single-line Error the
    // /blog/:id/regenerate-image handler stores against the post.
    const attempts = (err.attempts || [])
      .map((a) => `${a.provider}:${a.result.status || a.result.reason || (a.result.dataUrl ? 'ok' : 'unknown')}`)
      .join(', ');
    throw new Error(`image-generator: ${err.message}${attempts ? ` (attempts: ${attempts})` : ''}`);
  }
}

// =========================================================================
// AUTHORS — read-through to the Astro `authors` collection (cached)
// =========================================================================
//
// The admin Blog editor populates its Author + Reviewer dropdowns from
// here. The data lives in wavespestcontrol-astro/src/content/authors so
// bylines, photos, and FDACS license metadata stay in one place; this
// endpoint hits a 5-minute cache via author-service.js. Keep this above
// the /blog routes so it can never be shadowed by a parametric route.
router.get('/authors', async (_req, res) => {
  try {
    const authorService = require('../services/content-astro/author-service');
    const authors = await authorService.listAuthors();
    res.json({ authors });
  } catch (err) {
    logger.warn(`[content] authors list failed: ${err.message}`);
    res.json({ authors: [], error: err.message });
  }
});

// =========================================================================
// AUTONOMOUS CONTENT REVIEW QUEUE
// =========================================================================

// GET /api/admin/content/autonomous/review?status=pending_review&limit=50
router.get('/autonomous/review', async (req, res, next) => {
  try {
    const review = await autonomousReviewQueue.listReviewItems({
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json(review);
  } catch (err) { next(err); }
});

// GET /api/admin/content/autonomous/review/:id
router.get('/autonomous/review/:id', async (req, res, next) => {
  try {
    const item = await autonomousReviewQueue.getReviewItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Review item not found' });
    res.json({ item });
  } catch (err) { next(err); }
});

// POST /api/admin/content/autonomous/review/:id/decision
// Body: { decision: "requeue" | "dismiss" | "approve_trust_build", note?: string }
router.post('/autonomous/review/:id/decision', async (req, res, next) => {
  try {
    const item = await autonomousReviewQueue.decideReviewItem(req.params.id, {
      decision: req.body?.decision,
      note: req.body?.note,
      reviewer: req.technicianId || 'admin',
      expectedRunId: req.body?.run_id || null,
    });
    if (!item) return res.status(404).json({ error: 'Review item not found' });
    res.json({ success: true, item });
  } catch (err) { next(err); }
});

// GET /api/admin/content/autonomous/impact?limit=100
// Closed-loop "proof of ranking" view over content_optimization_impact: one
// row per published optimization with its frozen target-query cohort, the
// 14d/21d before/after query positions, clicks earned, and the diff-in-diff
// verdict. Read-only reporting — verdict math lives in the impact tracker.
router.get('/autonomous/impact', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 250);
    const rows = await db('content_optimization_impact as i')
      .leftJoin('autonomous_runs as r', 'i.run_id', 'r.id')
      .leftJoin('content_briefs as b', 'r.brief_id', 'b.id')
      .orderBy(db.raw('COALESCE(i.deployed_at, i.created_at)'), 'desc')
      .limit(limit)
      .select(
        'i.*',
        'r.action_type',
        'r.draft_payload',
        'b.target_keyword as brief_target_keyword',
      );

    const items = rows.map(shapeImpactItem);

    // Totals cover the WHOLE impact corpus, not the limited page above — an
    // unbounded query over just the columns the totals need (one row per
    // published optimization, so this stays small).
    const totalRows = await db('content_optimization_impact')
      .select('verdict', 'checked_14d_at', 'checked_21d_at', 'metrics_14d', 'metrics_21d');
    const verdictCounts = { improved: 0, neutral: 0, regressed: 0, insufficient_data: 0 };
    let measuredCount = 0;
    let windowClicks = 0;
    let windowImpressions = 0;
    for (const row of totalRows) {
      const latest = row.checked_21d_at
        ? parseMaybeJson(row.metrics_21d, null)
        : row.checked_14d_at ? parseMaybeJson(row.metrics_14d, null) : null;
      if (!latest) continue;
      measuredCount += 1;
      if (row.verdict && verdictCounts[row.verdict] != null) verdictCounts[row.verdict] += 1;
      windowClicks += Number(latest.clicks) || 0;
      windowImpressions += Number(latest.impressions) || 0;
    }
    const totals = {
      tracked: totalRows.length,
      measured: measuredCount,
      awaiting_measurement: totalRows.length - measuredCount,
      verdicts: verdictCounts,
      window_clicks: windowClicks,
      window_impressions: windowImpressions,
    };
    res.json({ items, totals });
  } catch (err) { next(err); }
});

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function shapeImpactItem(row) {
  const draft = parseMaybeJson(row.draft_payload, {});
  const cohort = parseMaybeJson(row.query_cohort, []);
  const metrics21 = row.checked_21d_at ? parseMaybeJson(row.metrics_21d, null) : null;
  const metrics14 = row.checked_14d_at ? parseMaybeJson(row.metrics_14d, null) : null;
  const latest = metrics21 || metrics14;
  const primaryQuery = (Array.isArray(cohort) && cohort[0]?.query) || row.brief_target_keyword || null;

  return {
    id: row.id,
    run_id: row.run_id,
    page_url: row.page_url,
    title: draft?.title || draft?.frontmatter?.title || null,
    action_type: row.action_type || null,
    bucket: row.bucket || null,
    deployed_at: row.deployed_at,
    measurement_start: row.measurement_start,
    target_query: primaryQuery,
    target_queries: latest?.target_queries || [],
    baseline: {
      position: row.baseline_position == null ? null : Number(row.baseline_position),
      clicks: Number(row.baseline_clicks) || 0,
      impressions: Number(row.baseline_impressions) || 0,
    },
    latest_window: latest
      ? {
        days: metrics21 ? 21 : 14,
        position: latest.position == null ? null : Number(latest.position),
        clicks: Number(latest.clicks) || 0,
        impressions: Number(latest.impressions) || 0,
      }
      : null,
    verdict: row.verdict || null,
    verdict_confidence: row.verdict_confidence == null ? null : Number(row.verdict_confidence),
    estimated_lift_position: row.estimated_lift_position == null ? null : Number(row.estimated_lift_position),
    estimated_lift_clicks_pct: row.estimated_lift_clicks_pct == null ? null : Number(row.estimated_lift_clicks_pct),
  };
}

// POST /api/admin/content/autonomous/run-now
// Owner-triggered single cycle of the autonomous content engine on the
// deployed server (which has DB + GitHub + Anthropic creds) — the same work
// the 7:30am miner + 9am runner crons do, but on demand. Mines fresh
// opportunities first (so the facts-readiness boost is applied), then claims +
// runs the top pending item via runNext. Publishing is still fully gated by
// SHADOW_MODE_* / trust-build / all content gates; this only triggers a cycle.
// Body: { mine?: boolean (default true), minScore?: number, periodDays?: number }
router.post('/autonomous/run-now', aiContentLimiter, async (req, res, next) => {
  try {
    if (!isEnabled('autonomousContentEngine')) {
      return res.status(409).json({ error: 'Autonomous content engine is disabled (GATE_AUTONOMOUS_CONTENT).' });
    }
    const runner = require('../services/content/autonomous-runner');
    const miner = require('../services/seo/gsc-opportunity-miner');
    const doMine = req.body?.mine !== false;
    // parseInt NaN passthrough: minScore=NaN silently claims nothing
    // (numeric NaN sorts above everything in Postgres) and periodDays=NaN
    // poisons the miner's date math — bound both instead.
    const minScore = req.body?.minScore != null
      ? parseBoundedInt(req.body.minScore, { defaultValue: undefined, min: 0, max: 100, name: 'minScore' })
      : undefined;
    const periodDays = req.body?.periodDays != null
      ? parseBoundedInt(req.body.periodDays, { defaultValue: 28, min: 1, max: 365, name: 'periodDays' })
      : 28;

    let mined = null;
    if (doMine) {
      const result = await miner.mineAll({ periodDays, persist: true });
      mined = { persisted: result.persisted, counts: result.counts, errors: result.errors };
    }

    // run-now publishes when SHADOW_MODE_* is live, so serialize it behind the
    // same engine lock the daily cron + CLI live run use — an admin triggering
    // this while a batch is in flight must not race the per-day/week caps.
    const run = await runner._withEngineLock('admin-run-now', () => runner.runNext({ minScore }));
    logger.info(`[content] manual run-now by ${req.technicianId || 'admin'}: outcome=${run.outcome} action=${run.action_type || '-'} opp=${run.opportunity_id || '-'} pr=${run.astro_pr_url || '-'}`);
    res.json({ success: true, mined, run });
  } catch (err) { next(err); }
});

// GET /api/admin/content/internal-links?status=patch_candidate&limit=100
router.get('/internal-links', async (req, res, next) => {
  try {
    const review = await internalLinkReviewQueue.listTasks({
      status: req.query.status,
      limit: req.query.limit,
    });
    res.json(review);
  } catch (err) { next(err); }
});

// GET /api/admin/content/internal-links/:id
router.get('/internal-links/:id', async (req, res, next) => {
  try {
    const item = await internalLinkReviewQueue.getTask(req.params.id);
    if (!item) return res.status(404).json({ error: 'Internal-link task not found' });
    res.json({ item });
  } catch (err) { next(err); }
});

// POST /api/admin/content/internal-links/:id/decision
// Body: { decision: "requeue" | "dismiss" | "verify_now", note?: string }
router.post('/internal-links/:id/decision', async (req, res, next) => {
  try {
    const item = await internalLinkReviewQueue.decideTask(req.params.id, {
      decision: req.body?.decision,
      note: req.body?.note,
      reviewer: req.technicianId || 'admin',
    });
    if (!item) return res.status(404).json({ error: 'Internal-link task not found' });
    res.json({ success: true, item });
  } catch (err) { next(err); }
});

// =========================================================================
// BLOG POSTS — CRUD + FILTERING
// =========================================================================

// GET /api/admin/content/blog?status=queued&tag=Pest+Control&city=Bradenton&sort=publish_date
router.get('/blog', async (req, res, next) => {
  try {
    const { status, tag, city, sort = 'publish_date', order = 'asc', search, limit } = req.query;

    // sort went raw into orderBy (unknown column → 42703 → 500 killed the
    // list view) and limit=NaN made knex silently drop the limit (full-table
    // dump including all content).
    const sortColumn = BLOG_SORT_COLUMNS.has(String(sort)) ? String(sort) : 'publish_date';
    const sortOrder = String(order).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const boundedLimit = parseBoundedInt(limit, { defaultValue: 200, min: 1, max: 500, name: 'limit' });

    let query = db('blog_posts');
    if (status) query = query.where('status', status);
    if (tag) query = query.where('tag', tag);
    if (city) query = query.where('city', city);
    if (search) query = query.where(function () {
      this.where('title', 'ilike', `%${search}%`).orWhere('keyword', 'ilike', `%${search}%`);
    });

    const posts = await query.orderBy(sortColumn, sortOrder).limit(boundedLimit);

    // Counts by status
    const statusCounts = await db('blog_posts').select('status').count('* as count').groupBy('status');
    const counts = {};
    statusCounts.forEach(s => { counts[s.status] = parseInt(s.count); });

    res.json({ posts, counts, total: posts.length });
  } catch (err) { next(err); }
});

// ── Named blog routes (must be before /:id to avoid being shadowed) ──

// GET /api/admin/content/blog/audit
router.get('/blog/audit', async (req, res, next) => {
  try {
    const recent = await db('ai_audits')
      .where('audit_type', 'blog_content')
      .orderBy('audit_date', 'desc')
      .first();

    if (recent && (Date.now() - new Date(recent.audit_date).getTime()) < 3600000) {
      return res.json({
        audit: typeof recent.report_data === 'string' ? JSON.parse(recent.report_data) : recent.report_data,
        cached: true,
        auditDate: recent.audit_date,
      });
    }

    const audit = await BlogAuditor.runFullAudit();
    await db('ai_audits').insert({
      audit_type: 'blog_content',
      audit_date: new Date(),
      report_data: JSON.stringify(audit),
      recommendation_count: audit.recommendations?.length || 0,
      critical_issues: audit.duplicates?.length || 0,
      status: 'completed',
    });

    res.json({ audit, cached: false, auditDate: new Date() });
  } catch (err) { next(err); }
});

// GET /api/admin/content/blog/analytics
router.get('/blog/analytics', async (req, res, next) => {
  try {
    const all = await db('blog_posts');

    const byStatus = {};
    const byTag = {};
    const byCity = {};
    const bySource = {};

    for (const p of all) {
      byStatus[p.status] = (byStatus[p.status] || 0) + 1;
      if (p.tag) byTag[p.tag] = (byTag[p.tag] || 0) + 1;
      if (p.city) byCity[p.city] = (byCity[p.city] || 0) + 1;
      bySource[p.source || 'unknown'] = (bySource[p.source || 'unknown'] || 0) + 1;
    }

    const published = all.filter(p => p.status === 'published');
    const avgSEO = published.filter(p => p.seo_score).reduce((s, p) => s + p.seo_score, 0) / (published.filter(p => p.seo_score).length || 1);
    const avgWordCount = published.filter(p => p.word_count).reduce((s, p) => s + p.word_count, 0) / (published.filter(p => p.word_count).length || 1);

    const today = etDateString();
    const weekOut = etDateString(addETDays(new Date(), 7));
    const upcoming = await db('blog_posts')
      .where('publish_date', '>=', today)
      .where('publish_date', '<=', weekOut)
      .orderBy('publish_date', 'asc');

    res.json({
      total: all.length,
      byStatus,
      byTag: Object.entries(byTag).sort((a, b) => b[1] - a[1]),
      byCity: Object.entries(byCity).sort((a, b) => b[1] - a[1]),
      bySource,
      avgSEOScore: Math.round(avgSEO),
      avgWordCount: Math.round(avgWordCount),
      upcoming,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/content/blog/overlap-check
router.get('/blog/overlap-check', async (req, res, next) => {
  try {
    const queued = await db('blog_posts').where('status', 'queued');
    const published = await db('blog_posts').where('status', 'published');
    const overlaps = [];

    for (const q of queued) {
      const qkw = (q.keyword || '').toLowerCase();
      if (!qkw || qkw.length < 5) continue;
      for (const p of published) {
        const pkw = (p.keyword || '').toLowerCase();
        if (pkw && (qkw.includes(pkw) || pkw.includes(qkw))) {
          overlaps.push({
            queued: { id: q.id, title: q.title, keyword: q.keyword, city: q.city },
            existing: { id: p.id, title: p.title, keyword: p.keyword, city: p.city },
          });
        }
      }
    }

    res.json({ overlaps, count: overlaps.length });
  } catch (err) { next(err); }
});

// GET /api/admin/content/blog/:id
router.get('/blog/:id', async (req, res, next) => {
  try {
    assertBlogPostId(req.params.id);
    const post = await db('blog_posts').where('id', req.params.id).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Parse optimization_suggestions if string; a corrupt value must not
    // 500 the whole editor load.
    if (post.optimization_suggestions && typeof post.optimization_suggestions === 'string') {
      try {
        post.optimization_suggestions = JSON.parse(post.optimization_suggestions);
      } catch {
        post.optimization_suggestions = null;
      }
    }

    res.json({ post });
  } catch (err) { next(err); }
});

// PUT /api/admin/content/blog/:id
router.put('/blog/:id', async (req, res, next) => {
  try {
    assertBlogPostId(req.params.id);
    const existing = await db('blog_posts').where('id', req.params.id).first();
    if (!existing) return res.status(404).json({ error: 'Post not found' });
    // A publisher owns the row mid-publish (scheduler claim or manual claim):
    // editing now would leave the opened PR and the database source divergent.
    if (existing.publish_status === 'publishing' || publishClaimActive(existing)) {
      return res.status(409).json({ error: 'Post is being published right now — retry after it finishes.' });
    }

    const updates = { ...normalizeBlogUpdates(req.body), updated_at: new Date() };
    if (updates.status !== undefined) {
      if (!BLOG_STATUS_VALUES.has(updates.status)) {
        throw operationalBadRequest(`status must be one of: ${Array.from(BLOG_STATUS_VALUES).join(', ')}`);
      }
      // 'published' is stamped by the astro merge path (applyMergeEffect);
      // setting it here would mark a post published with no live page behind
      // it. Saving an already-published post keeps working.
      if (updates.status === 'published' && existing.status !== 'published') {
        throw operationalBadRequest('status cannot be set to published directly — publish via the Astro pipeline');
      }
    }
    if (updates.content) {
      updates.word_count = updates.content.split(/\s+/).filter(Boolean).length;
    }
    // CAS on the status the no-jump rule was validated against — a concurrent
    // unpublish (published→draft) must not let this write re-publish the row —
    // AND on the publisher claims, so a publish acquired between the read
    // above and this write can't have its captured source edited under it.
    const [post] = await whereNoLivePublishClaim(
      db('blog_posts')
        .where('id', req.params.id)
        .where('status', existing.status)
        .where((q) => q.whereNull('publish_status').orWhereNot('publish_status', 'publishing')),
    )
      .update(updates)
      .returning('*');
    if (!post) return res.status(409).json({ error: 'Post state changed underneath this request — reload and retry.' });
    res.json({ post });
  } catch (err) { next(err); }
});

// DELETE /api/admin/content/blog/:id
router.delete('/blog/:id', async (req, res, next) => {
  try {
    assertBlogPostId(req.params.id);
    // A row whose PR/page is live outside this table can't be hard-deleted:
    // deleting a pr_open post orphans an open astro PR forever (pages-poll
    // only iterates existing rows), and deleting a live post strands the
    // live page with no unpublish path. The guard lives INSIDE the delete's
    // WHERE (not a separate read) so a publisher opening a PR mid-request
    // can't slip between check and delete.
    // status != published: legacy published rows (pre-astro; astro_status
    // defaulted to 'draft', no PR/branch markers) represent externally
    // published content too — require an explicit un-publish (status change
    // or unpublish-astro) before a hard delete.
    const deleted = await whereNotAstroActive(
      db('blog_posts').where('id', req.params.id).whereNot('status', 'published'),
    ).del();
    if (!deleted) {
      const post = await db('blog_posts').where('id', req.params.id).first();
      if (!post) return res.status(404).json({ error: 'Post not found' });
      const why = (post.publish_status === 'publishing' || publishClaimActive(post))
        ? 'Post is being published right now (publisher claim) — retry after it finishes.'
        : post.status === 'published' && !astroActivePost(post)
          ? "Post is published — un-publish it first (set status to draft, or unpublish-astro if it has a live page), then delete."
          : `Post has Astro state '${post.astro_status || 'pending'}'${post.astro_pr_number ? ` (PR #${post.astro_pr_number})` : ''} — unpublish it first (unpublish-astro), then delete.`;
      return res.status(409).json({ error: why });
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT GENERATION
// =========================================================================

// POST /api/admin/content/blog/:id/generate — generate AI content for a post
router.post('/blog/:id/generate', aiContentLimiter, async (req, res, next) => {
  try {
    assertBlogPostId(req.params.id);
    const post = await db('blog_posts').where('id', req.params.id).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    // generatePost overwrites `content` and forces status back to draft —
    // on a published/live post that irreversibly destroys the live
    // article's source text (no versioning exists). This read-side check
    // gives the friendly 409; generatePost's own CAS'd final write closes
    // the race where the state changes during the long AI call.
    if (post.status === 'published' || post.publish_status === 'publishing' || publishClaimActive(post) || astroActivePost(post)) {
      const why = post.status === 'published' ? 'published'
        : (post.publish_status === 'publishing' || publishClaimActive(post)) ? 'being published right now (publisher claim)'
          : `in Astro state '${post.astro_status || 'pending'}'`;
      return res.status(409).json({
        error: `Post is ${why} — generating would overwrite its content. Unpublish it first.`,
      });
    }
    const result = await BlogWriter.generatePost(req.params.id);
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/:id/optimize — generate optimization suggestions
router.post('/blog/:id/optimize', aiContentLimiter, async (req, res, next) => {
  try {
    const result = await BlogWriter.optimizeExistingPost(req.params.id);
    res.json({ optimization: result });
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/:id/regenerate-image — Gemini retry.
//
// The create path silent-falls-back when the first image-gen attempt
// fails (missing API key, Gemini safety block, network blip). This
// lets the operator retry from the editor without re-running the
// whole content pipeline.
router.post('/blog/:id/regenerate-image', aiContentLimiter, async (req, res) => {
  try {
    assertBlogPostId(req.params.id);
    const post = await db('blog_posts').where('id', req.params.id).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });
    // A publisher owns the row mid-publish: publishAstro has already read
    // featured_image_url for its hero resolve — swapping it now would ship
    // a PR hero different from the DB record. Editing while a PR is merely
    // OPEN stays allowed (that's the edit→Refresh-PR lane).
    if (post.publish_status === 'publishing' || publishClaimActive(post)) {
      return res.status(409).json({ error: 'Post is being published right now — retry after it finishes.' });
    }

    const url = await generateFeaturedImage({
      title: post.title,
      topic: post.meta_description,
      keyword: post.keyword,
    });

    // Same predicates ATOMICALLY on the write (the image call above is slow —
    // a publish can start during it).
    const [updated] = await whereNoLivePublishClaim(
      db('blog_posts')
        .where('id', req.params.id)
        .where((q) => q.whereNull('publish_status').orWhereNot('publish_status', 'publishing')),
    )
      .update({ featured_image_url: url, updated_at: new Date() })
      .returning('*');
    if (!updated) return res.status(409).json({ error: 'Post is being published right now — retry after it finishes.' });

    res.json({ success: true, post: updated });
  } catch (err) {
    logger.warn(`[content] regenerate-image failed: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

// POST /api/admin/content/blog/bulk-generate — generate content for next N posts
router.post('/blog/bulk-generate', aiContentLimiter, async (req, res, next) => {
  try {
    const count = parseBoundedInt(req.body.count, {
      defaultValue: 5,
      min: 1,
      max: CONTENT_LIMITS.bulkGenerateMax,
      name: 'count',
    });
    const posts = await db('blog_posts')
      .where('status', 'queued')
      .whereNull('content')
      .orderBy('publish_date', 'asc')
      .limit(count);

    const results = [];
    for (const post of posts) {
      try {
        const result = await BlogWriter.generatePost(post.id);
        results.push({ id: post.id, title: post.title, wordCount: result.wordCount, success: true });
      } catch (err) {
        results.push({ id: post.id, title: post.title, error: err.message, success: false });
      }
    }

    res.json({ results, generated: results.filter(r => r.success).length });
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/ideas — generate new ideas
router.post('/blog/ideas', aiContentLimiter, async (req, res, next) => {
  try {
    const count = parseBoundedInt(req.body.count, {
      defaultValue: 20,
      min: 1,
      max: CONTENT_LIMITS.ideaCountMax,
      name: 'count',
    });
    const ideas = await BlogWriter.generateNewIdeas(count);
    res.json({ ideas, count: ideas.length });
  } catch (err) { next(err); }
});

// =========================================================================
// PUBLISH TO SITE
// =========================================================================

// POST /api/admin/content/blog/:id/publish — publish to wavespestcontrol.com
router.post('/blog/:id/publish', async (req, res, next) => {
  res.status(410).json({
    error: 'Legacy direct blog publish is retired. Use /blog/:id/publish-astro to open an Astro PR, then merge after preview review.',
  });
});

// POST /api/admin/content/blog/:id/publish-astro — create branch + PR
router.post('/blog/:id/publish-astro', async (req, res, next) => {
  // Atomic manual-lane claim: publishAstro runs a long external
  // branch/commit/PR workflow and only persists astro markers at the END —
  // without a claim, DELETE could remove the row (orphaning the PR about to
  // open) and generate/PUT could change the content the publisher had
  // already captured. publish_claimed_at is lane-neutral: pages-poll never
  // reads it, so an admin PR can NEVER be mistaken for the scheduler's
  // publishing+pr_open auto-merge authorization (that marker stays the
  // scheduler's alone). A crashed publish self-expires via the claim window.
  let claimStamp = null;
  let renewTimer = null;
  let renewInFlight = null;
  try {
    assertBlogPostId(req.params.id);
    // claimStamp doubles as the release token: only the request that wrote
    // this exact timestamp may clear it, so a >30m-stale publish finishing
    // late can't release a NEWER publisher's lease. The scheduler lane is
    // excluded symmetrically (its CAS also refuses a live claim).
    const stamp = new Date();
    // Claim-specific predicate: retryable failed states (build_failed and
    // publish_failed, markers or not) MAY claim — publishAstro itself
    // reconciles the stale PR/branch on republish, and that path is the
    // admin Retry button. Healthy open PRs and merged/live/unpublish states
    // go through their own lifecycle endpoints; the scheduler marker and a
    // live manual claim exclude concurrent publishers.
    const CLAIM_BLOCKING_ASTRO = ['pr_open', 'merged', 'live', 'unpublish_pending'];
    const got = await whereNoLivePublishClaim(
      db('blog_posts')
        .where('id', req.params.id)
        .where((q) => q.whereNull('publish_status').orWhereNot('publish_status', 'publishing'))
        .where((q) => q.whereNull('astro_status').orWhereNotIn('astro_status', CLAIM_BLOCKING_ASTRO)),
    ).update({ publish_claimed_at: stamp, updated_at: new Date() });
    if (!got) {
      const post = await db('blog_posts').where('id', req.params.id).first();
      if (!post) return res.status(404).json({ error: 'Post not found' });
      const why = CLAIM_BLOCKING_ASTRO.includes(post.astro_status)
        ? `Post already has Astro state '${post.astro_status}'${post.astro_pr_number ? ` (PR #${post.astro_pr_number})` : ''} — use refresh/merge/unpublish instead.`
        : 'Post is already being published.';
      return res.status(409).json({ error: why });
    }
    claimStamp = stamp;

    // Lease heartbeat: publishAstro has no total timeout (GitHub/LLM/image
    // calls can stall), and a lease that silently expires at 30m would let a
    // second publisher take over while this one is still alive and later
    // persists PR markers over the newer attempt's state. Renewing at a
    // third of the window keeps a LIVE request owner for as long as it
    // runs (awaited I/O leaves the event loop free to fire the timer);
    // only a dead process stops renewing and expires. Renewal is CAS'd on
    // our current stamp — if we ever lose the lease anyway, stop renewing
    // rather than fight the new owner.
    // Serialized heartbeat: renewals never overlap each other (an in-flight
    // renewal skips the tick) and the finally below AWAITS the last one, so
    // the release always targets the stamp that is actually in the DB. If a
    // renewal observes the lease lost (0 rows), we stop renewing, null the
    // stamp so the release no-ops, and log loudly — publishAstro itself is
    // NOT fenced mid-flight (same boundary as the scheduler lane's
    // 'publishing' claim): reaching that state requires the DB rejecting
    // renewals for a full window while GitHub/LLM calls kept succeeding.
    renewTimer = setInterval(() => {
      if (renewInFlight) return;
      renewInFlight = (async () => {
        try {
          const next = new Date();
          const renewed = await db('blog_posts')
            .where('id', req.params.id)
            .where('publish_claimed_at', claimStamp)
            .update({ publish_claimed_at: next, updated_at: new Date() });
          if (renewed) {
            claimStamp = next;
          } else {
            clearInterval(renewTimer);
            claimStamp = null;
            logger.error(`[content] publish-astro LOST its publish lease for ${req.params.id} mid-flight — a newer publisher owns the row; this attempt's external writes are unfenced`);
          }
        } catch (e) {
          logger.warn(`[content] publish-astro lease renewal failed for ${req.params.id}: ${e.message}`);
        } finally {
          renewInFlight = null;
        }
      })();
    }, Math.floor(PUBLISH_CLAIM_STALE_MS / 3));
    if (typeof renewTimer.unref === 'function') renewTimer.unref();

    const AstroPublisher = require('../services/content-astro/astro-publisher');
    const result = await AstroPublisher.publishAstro(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[content] publish-astro failed: ${err.message}`);
    // Content-policy rejections are the author's to fix — 400, not 500
    // (a 500 here reads as a server failure and can trip error alerting).
    const isClientErr = err.code === 'BLOG_FRONTMATTER_INVALID'
      || err.code === 'BLOG_GUARDRAILS_FAILED'
      || err.code === 'BLOG_COMPARISON_GATE_FAILED';
    res.status(isClientErr ? 400 : 500).json({ error: err.message, details: err.details });
  } finally {
    if (renewTimer) clearInterval(renewTimer);
    // Settle any in-flight renewal so claimStamp reflects the DB before the
    // tokenized release (otherwise the release could CAS on a stale stamp,
    // affect zero rows, and leave the post blocked for a full window).
    if (renewInFlight) { try { await renewInFlight; } catch (_) { /* logged above */ } }
    if (claimStamp) {
      try {
        await db('blog_posts')
          .where('id', req.params.id)
          .where('publish_claimed_at', claimStamp)
          .update({ publish_claimed_at: null, updated_at: new Date() });
      } catch (e) {
        logger.warn(`[content] publish-astro claim release failed for ${req.params.id}: ${e.message} (claim self-expires in 30m)`);
      }
    }
  }
});

// POST /api/admin/content/blog/:id/merge-astro — approve preview → prod
router.post('/blog/:id/merge-astro', async (req, res, next) => {
  try {
    const AstroPublisher = require('../services/content-astro/astro-publisher');
    const result = await AstroPublisher.mergeAstro(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[content] merge-astro failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/content/blog/:id/unpublish-astro — open a revert PR that
// deletes the markdown + hero from the astro repo. Merging the PR flips
// the post back to draft in the portal.
router.post('/blog/:id/unpublish-astro', async (req, res, next) => {
  try {
    const AstroPublisher = require('../services/content-astro/astro-publisher');
    const result = await AstroPublisher.unpublishAstro(req.params.id);
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[content] unpublish-astro failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/content/blog/:id/refresh-astro — ask CF Pages for the
// latest preview-build status right now (UI button next to the state pill).
router.post('/blog/:id/refresh-astro', async (req, res, next) => {
  try {
    const PagesPoll = require('../services/content-astro/pages-poll');
    const post = await db('blog_posts').where({ id: req.params.id }).first();
    if (!post) return res.status(404).json({ error: 'post not found' });
    // allowMerge:false — this button is a STATUS refresh. pollPost's default
    // otherwise runs the scheduler-lane auto-merge, so an admin click racing
    // the 2-min cron tick could double-run a merge chain and sidestep the
    // per-poll merge cap. Merging stays with the cron tick (or the explicit
    // merge-astro endpoint).
    const result = await PagesPoll.pollPost(post, { allowMerge: false });
    const refreshed = await db('blog_posts').where({ id: post.id }).first();
    res.json({ success: true, result, post: refreshed });
  } catch (err) {
    logger.error(`[content] refresh-astro failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/content/blog/:id/share-social — share published post to all social platforms
router.post('/blog/:id/share-social', async (req, res, next) => {
  try {
    const post = await db('blog_posts').where({ id: req.params.id }).first();
    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Live-status gate (shared with the content-agent's distribute tool):
    // a non-live post shares a dead 404 link to every enabled platform.
    const { blogPostShareability } = require('../services/content/blog-share-gate');
    const shareable = blogPostShareability(post);
    if (!shareable.ok) return res.status(409).json({ error: shareable.reason });

    const link = post.astro_live_url || post.url || `https://www.wavespestcontrol.com/${post.slug}`;
    const title = post.title;
    const description = post.meta_description || (post.content || '').replace(/[#*_\[\]]/g, '').substring(0, 300);

    const SocialMediaService = require('../services/social-media');
    const result = await SocialMediaService.publishToAll({
      title, description, link,
      guid: `blog_${post.id}`,
      source: 'blog',
      imageUrl: publicBlogImageUrl(post),
    });

    // Mark post as shared
    try {
      await db('blog_posts').where({ id: post.id }).update({ shared_to_social: true, shared_at: new Date() });
    } catch { /* column may not exist */ }

    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// HYPER-LOCAL CONTENT GENERATION
// =========================================================================

// GET /api/admin/content/weather — FAWN weather snapshot + active signals
router.get('/weather', async (req, res, next) => {
  try {
    // Attempt to pull live FAWN data (Florida Automated Weather Network)
    let weather = {};
    try {
      const fawnRes = await fetch('https://fawn.ifas.ufl.edu/controller.php/lastObservation/summary/');
      if (fawnRes.ok) {
        const fawnData = await fawnRes.json();
        // Find Manatee or Sarasota County station
        const station = (fawnData || []).find(s =>
          (s.StationName || '').toLowerCase().includes('manatee') ||
          (s.StationName || '').toLowerCase().includes('sarasota') ||
          (s.StationName || '').toLowerCase().includes('myakka')
        ) || fawnData?.[0];
        if (station) {
          weather = {
            temp: station.AirTemp_Avg || station.t2m_avg,
            humidity: station.RelHum_Avg || station.rh_avg,
            rainfall: station.Rain_Tot || station.rain_sum,
            soilTemp: station.SoilTemp4_Avg || station.ts4_avg,
            station: station.StationName || 'FAWN SWFL',
            timestamp: new Date().toISOString(),
          };
        }
      }
    } catch { /* FAWN unavailable — return defaults */ }

    // Active content signals based on date/season
    const month = new Date().getMonth();
    const signals = [];
    if (month >= 3 && month <= 9) signals.push('Mosquito season active — high search volume');
    if (month >= 4 && month <= 8) signals.push('Chinch bug pressure peak in SWFL');
    if (month >= 5 && month <= 8) signals.push('Nitrogen blackout in effect (Sarasota + Manatee counties)');
    if (month >= 2 && month <= 4) signals.push('Termite swarm season — swarmer reports trending');
    if (month >= 5 && month <= 9) signals.push('Afternoon thunderstorms — reschedule content relevant');
    if (month >= 0 && month <= 2) signals.push('Pre-emergent window — lawn content peak');
    if (month >= 9 && month <= 11) signals.push('Rodent season ramping — attic entry point content');

    res.json({ weather, signals });
  } catch (err) { next(err); }
});

// POST /api/admin/content/generate — hyper-local content generation
router.post('/generate', aiContentLimiter, async (req, res, next) => {
  try {
    const { topic, contentType, targetCity } = normalizeGenerateBody(req.body);

    // Get voice config
    const voice = await db('blog_voice_config').where('active', true).first();
    const voiceDesc = voice?.voice_description || '';
    const sampleTitles = (typeof voice?.sample_titles === 'string' ? JSON.parse(voice.sample_titles) : voice?.sample_titles) || [];

    // Pull weather data for the prompt
    let weatherContext = '';
    try {
      const fawnRes = await fetch('https://fawn.ifas.ufl.edu/controller.php/lastObservation/summary/');
      if (fawnRes.ok) {
        const fawnData = await fawnRes.json();
        const station = (fawnData || []).find(s =>
          (s.StationName || '').toLowerCase().includes('manatee') ||
          (s.StationName || '').toLowerCase().includes('myakka')
        );
        if (station) {
          weatherContext = `Current FAWN data (${station.StationName}): Air temp ${station.AirTemp_Avg || '?'}F, Humidity ${station.RelHum_Avg || '?'}%, Soil temp ${station.SoilTemp4_Avg || '?'}F, Rain ${station.Rain_Tot || '?'}". Timestamp: ${new Date().toISOString()}`;
        }
      }
    } catch { weatherContext = 'FAWN data unavailable — use seasonal SWFL defaults.'; }

    // Content type parameters
    const typeConfig = {
      blog_post: { wordRange: '800–1200', format: 'H2 subheadings every 200–300 words, short paragraphs, 1–2 pro tip callouts, FAQ section with 3 questions at the end using schema-ready format' },
      pest_pressure: { wordRange: '400–600', format: 'This week format: conditions → active pests → what homeowners should do → when to call. Include FAWN data timestamp.' },
      gbp_post: { wordRange: '150–300', format: 'Google Business Profile post format: hook line, 2–3 short paragraphs, soft CTA. No headers.' },
      service_page: { wordRange: '1500–2000', format: 'Comprehensive landing page: hero section, problem/solution, process steps, FAQ (5+ questions), service area mention, trust signals, CTA sections.' },
    };
    const config = typeConfig[contentType] || typeConfig.blog_post;

    // Check for existing content overlap
    const existing = await db('blog_posts')
      .where('status', 'published')
      .where(function () {
        const words = topic.toLowerCase().split(/\s+/).filter(w => w.length > 4).slice(0, 3);
        for (const w of words) {
          this.orWhere('title', 'ilike', `%${w}%`);
        }
      })
      .select('title', 'city')
      .limit(5);

    const overlapNote = existing.length > 0
      ? `\n\nEXISTING CONTENT (differentiate from these):\n${existing.map(e => `- "${e.title}" (${e.city})`).join('\n')}`
      : '';

    // Generate via Claude if available, otherwise return a structured outline
    let content, title, metaDesc, keyword;

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 4000,
        system: `You write hyper-local pest control and lawn care content for Waves Pest Control in Southwest Florida.

VOICE: ${voiceDesc}

SAMPLE TITLES FOR TONE:
${sampleTitles.slice(0, 5).map(t => `• "${t}"`).join('\n')}

REQUIREMENTS FOR EVERY ARTICLE:
1. Include timestamped FAWN weather data from the station provided
2. Cite at least one UF/IFAS source with EDIS publication ID (e.g., ENY-2006, SS-AGR-417)
3. Reference a specific neighborhood or landmark in ${targetCity}
4. Include a real field observation (phrase it as "Our techs are seeing..." or "On recent inspections in ${targetCity}...")
5. If lawn/fertilizer related, mention county fertilizer ordinance compliance
6. End with a WaveGuard CTA tied to the specific problem discussed

FORMAT: ${config.wordRange} words. ${config.format}
CITY: ${targetCity} — mention it by name multiple times, reference local conditions.`,
        messages: [{
          role: 'user',
          content: `Write a ${contentType.replace(/_/g, ' ')} about: ${topic}

Target city: ${targetCity}

FAWN WEATHER: ${weatherContext || 'Use seasonal SWFL defaults for current month.'}
${overlapNote}

Return the content in markdown. Before the content, on the first 3 lines provide:
TITLE: [the article title]
META: [meta description, max 160 chars]
KEYWORD: [primary SEO keyword]

Then a blank line, then the full content.`
        }]
      });

      const raw = response.content[0].text;

      // Parse title/meta/keyword from the header
      const titleMatch = raw.match(/^TITLE:\s*(.+)/m);
      const metaMatch = raw.match(/^META:\s*(.+)/m);
      const kwMatch = raw.match(/^KEYWORD:\s*(.+)/m);

      title = titleMatch?.[1]?.trim() || topic;
      metaDesc = metaMatch?.[1]?.trim() || '';
      keyword = kwMatch?.[1]?.trim() || '';
      content = raw.replace(/^TITLE:.*\n?/m, '').replace(/^META:.*\n?/m, '').replace(/^KEYWORD:.*\n?/m, '').trim();
    } catch (aiErr) {
      // Fallback — create the post record without generated content
      title = topic;
      metaDesc = '';
      keyword = '';
      content = null;
      logger.warn(`Content generation AI unavailable: ${aiErr.message}`);
    }

    // Auto-detect tag from content
    const TAG_RULES = [
      { tag: 'Lawn Pests', patterns: ['chinch bug', 'grub', 'sod webworm', 'mole cricket', 'armyworm', 'lawn pest'] },
      { tag: 'Lawn Care', patterns: ['lawn care', 'fertiliz', 'mowing', 'irrigation', 'turf', 'grass', 'aeration', 'weed control', 'herbicide', 'st. augustine', 'sod'] },
      { tag: 'Termites', patterns: ['termite', 'wdo', 'wood-destroying', 'subterranean', 'drywood'] },
      { tag: 'Mosquitoes', patterns: ['mosquito'] },
      { tag: 'Rodents', patterns: ['rodent', 'rat', 'mouse', 'mice'] },
      { tag: 'Ants', patterns: ['ant ', 'ants', 'fire ant', 'carpenter ant', 'ghost ant'] },
      { tag: 'Cockroaches', patterns: ['cockroach', 'roach'] },
      { tag: 'Bed Bugs', patterns: ['bed bug', 'bedbug'] },
      { tag: 'Spiders', patterns: ['spider', 'arachnid', 'brown recluse', 'black widow'] },
      { tag: 'Fleas', patterns: ['flea', 'tick'] },
      { tag: 'Flying Insects', patterns: ['fly ', 'flies', 'wasp', 'bee ', 'hornet', 'yellow jacket', 'flying insect'] },
      { tag: 'Insects', patterns: ['insect', 'bug'] },
      { tag: 'Pest Control', patterns: ['pest control', 'exterminator', 'pest management', 'ipm'] },
    ];

    const combined = `${title} ${keyword} ${topic} ${(content || '').substring(0, 500)}`.toLowerCase();
    let autoTag = null;
    for (const rule of TAG_RULES) {
      if (rule.patterns.some(p => combined.includes(p))) {
        autoTag = rule.tag;
        break;
      }
    }
    if (!autoTag && contentType === 'pest_pressure') autoTag = 'Pest Control';

    // Generate featured image via Gemini.
    let featuredImageUrl = null;
    let featuredImageError = null;
    try {
      featuredImageUrl = await generateFeaturedImage({ title, topic, keyword });
    } catch (imgErr) {
      featuredImageError = imgErr.message || String(imgErr);
      logger.warn(`[content] Featured image generation failed: ${featuredImageError}`);
    }

    // Create the blog post record
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 80);
    const wordCount = content ? content.split(/\s+/).filter(Boolean).length : 0;

    const insertData = {
      title,
      keyword,
      meta_description: metaDesc,
      slug,
      city: targetCity,
      tag: autoTag,
      status: content ? 'draft' : 'queued',
      content,
      word_count: wordCount,
      source: 'ai_generated',
      // Default new posts to hub-only so a fresh AI-generated draft
      // doesn't surprise-publish to all 15 domains on the next merge.
      // Author picks additional spokes intentionally in the editor.
      target_sites: JSON.stringify(['wavespestcontrol.com']),
    };
    if (featuredImageUrl) insertData.featured_image_url = featuredImageUrl;

    let post;
    try {
      [post] = await db('blog_posts').insert(insertData).returning('*');
    } catch (insErr) {
      // featured_image_url or target_sites columns may not exist on
      // older DBs that haven't run the migrations yet. Drop the
      // optional columns and retry.
      delete insertData.featured_image_url;
      delete insertData.target_sites;
      [post] = await db('blog_posts').insert(insertData).returning('*');
    }

    res.json({ post, wordCount, contentType, hasContent: !!content, tag: autoTag, hasImage: !!featuredImageUrl });
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT CALENDAR + SCHEDULING
// =========================================================================

const ContentScheduler = require('../services/content-scheduler');

// GET /api/admin/content/calendar?start=2026-04-01&end=2026-04-30
router.get('/calendar', async (req, res, next) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) return res.status(400).json({ error: 'start and end query params required' });
    const calendar = await ContentScheduler.getCalendar(start, end);
    res.json({ calendar, count: calendar.length });
  } catch (err) { next(err); }
});

// POST /api/admin/content/schedule-blog/:id — schedule a blog post for auto-publish
router.post('/schedule-blog/:id', async (req, res, next) => {
  try {
    const { publishAt, autoShareSocial } = req.body;
    if (!publishAt) return res.status(400).json({ error: 'publishAt is required' });
    // Owner rule: customer-facing sends are opt-IN. Scheduling a publish
    // previously defaulted autoShareSocial to true — a silent social share
    // for anyone who didn't notice the checkbox (2026-07-15 audit, owner
    // decision 2026-07-16). Only an explicit true shares.
    const post = await ContentScheduler.scheduleBlogPost(req.params.id, publishAt, autoShareSocial === true);
    res.json({ success: true, post });
  } catch (err) { next(err); }
});

// POST /api/admin/content/schedule-social — schedule a new social media post
router.post('/schedule-social', async (req, res, next) => {
  try {
    const { title, description, link, platforms, scheduledFor, customContent } = req.body;
    if (!title || !scheduledFor) return res.status(400).json({ error: 'title and scheduledFor are required' });
    const post = await ContentScheduler.scheduleSocialPost({ title, description, link, platforms, scheduledFor, customContent });
    res.json({ success: true, post });
  } catch (err) { next(err); }
});

// DELETE /api/admin/content/schedule/:id — unschedule a post (blog or social)
router.delete('/schedule/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // Try blog first
    const blog = await db('blog_posts').where('id', id).first();
    if (blog) {
      await db('blog_posts').where('id', id).update({
        scheduled_publish_at: null,
        publish_status: null,
        updated_at: new Date(),
      });
      return res.json({ success: true, type: 'blog', id });
    }

    // Try social
    const social = await db('social_media_posts').where('id', id).first();
    if (social) {
      await db('social_media_posts').where('id', id).update({
        scheduled_for: null,
        publish_status: null,
        status: 'draft',
      });
      return res.json({ success: true, type: 'social', id });
    }

    return res.status(404).json({ error: 'Post not found' });
  } catch (err) { next(err); }
});

// =========================================================================
// CONTENT AGENT — Managed Agent autonomous content production
// =========================================================================

// POST /api/admin/content/agent/run — run the content agent for a single topic
router.post('/agent/run', async (req, res, next) => {
  try {
    const ContentAgent = require('../services/content/content-agent');
    const { topic, city, angle, publishDraft, distributeSocial } = req.body;

    if (!topic) return res.status(400).json({ error: 'topic is required' });

    // Run async — return immediately with session tracking
    const runPromise = ContentAgent.run({
      topic,
      city: city || null,
      angle: angle || null,
      publishDraft: publishDraft !== false,
      // opt-in only (same owner rule as schedule-blog)
      distributeSocial: distributeSocial === true,
    });

    // If the client wants to wait for completion (long-running)
    if (req.query.wait === 'true') {
      const result = await runPromise;
      return res.json(result);
    }

    // Otherwise fire-and-forget, return immediately
    runPromise
      .then(result => logger.info(`[content-agent] Completed: "${result.title}" (${result.durationSeconds}s)`))
      .catch(err => logger.error(`[content-agent] Failed: ${err.message}`));

    res.json({
      status: 'started',
      topic,
      city,
      message: 'Content agent is running. Check /api/admin/content/agent/runs for results.',
    });
  } catch (err) { next(err); }
});

// POST /api/admin/content/agent/batch — run the content agent for multiple topics
router.post('/agent/batch', async (req, res, next) => {
  try {
    const ContentAgent = require('../services/content/content-agent');
    const { topics, publishDraft, distributeSocial } = req.body;

    if (!topics || !Array.isArray(topics) || topics.length === 0) {
      return res.status(400).json({ error: 'topics array is required' });
    }

    if (topics.length > 10) {
      return res.status(400).json({ error: 'Max 10 topics per batch' });
    }

    // Fire-and-forget
    const batchPromise = ContentAgent.runBatch(topics, {
      publishDraft: publishDraft !== false,
      // opt-in only (same owner rule as schedule-blog)
      distributeSocial: distributeSocial === true,
    });

    batchPromise
      .then(results => {
        const success = results.filter(r => r.success).length;
        logger.info(`[content-agent] Batch complete: ${success}/${results.length} succeeded`);
      })
      .catch(err => logger.error(`[content-agent] Batch failed: ${err.message}`));

    res.json({
      status: 'started',
      count: topics.length,
      message: 'Content agent batch running. Check /api/admin/content/agent/runs for results.',
    });
  } catch (err) { next(err); }
});

// GET /api/admin/content/agent/runs — get content agent run history
router.get('/agent/runs', async (req, res, next) => {
  try {
    const { limit = 20 } = req.query;
    const runs = await db('content_agent_runs')
      .leftJoin('blog_posts', 'content_agent_runs.blog_post_id', 'blog_posts.id')
      .select(
        'content_agent_runs.*',
        'blog_posts.title as post_title',
        'blog_posts.url',
        'blog_posts.status as post_status'
      )
      .orderBy('content_agent_runs.created_at', 'desc')
      .limit(parseInt(limit));

    res.json({
      runs: runs.map(r => ({
        id: r.id,
        sessionId: r.session_id,
        topic: r.topic,
        city: r.city,
        status: r.status,
        title: r.post_title,
        wordCount: r.word_count,
        qaScore: r.qa_score,
        siteUrl: r.url,
        postStatus: r.post_status,
        toolsExecuted: typeof r.tools_executed === 'string' ? JSON.parse(r.tools_executed) : r.tools_executed,
        durationSeconds: r.duration_seconds,
        createdAt: r.created_at,
      })),
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.CONTENT_LIMITS = CONTENT_LIMITS;
module.exports.parseBoundedInt = parseBoundedInt;
module.exports.normalizeGenerateBody = normalizeGenerateBody;
module.exports.normalizeBlogUpdates = normalizeBlogUpdates;
