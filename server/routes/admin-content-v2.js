const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const BlogWriter = require('../services/content/blog-writer');
const BlogAuditor = require('../services/content/blog-auditor');
const logger = require('../services/logger');
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

// ── Hero-image generator ────────────────────────────────────────────
//
// Used by POST /blog/:id/regenerate-image (operator-triggered retry).
// Returns a `data:` URL on success; throws a typed Error otherwise so the
// caller can surface the reason to the UI instead of silent-failing.
//
// Goes through the publisher's generatePlannedImage so an admin hero gets
// the same per-post variation plan (seeded by the row's slug, so it never
// shares a style with the body slots planned at publish time) and the same
// text/logo screen + one retry as an autonomous hero (Codex r4 P2 on
// #3964). The row keeps only the data URL — publishAstro treats it as
// curated — so a screen still flagged after the retry is logged here for
// the operator, who sees the picture in the editor and can regenerate.
//
// Call sites are expected to wrap this in try/catch and store the
// error string alongside the post for display.
async function generateFeaturedImage({ title, topic, keyword, slug }) {
  const AstroPublisher = require('../services/content-astro/astro-publisher');
  try {
    const hero = await AstroPublisher.generatePlannedImage({ title, topic, keyword, mode: 'blog-hero', slug, index: 0 });
    logger.info(`[content] Generated featured image for "${title}" via ${hero.model} (${hero.plan.style}, ${String(hero.plan.setting).split(',')[0]})`);
    if (hero.screen?.checked && !hero.screen.ok) {
      logger.warn(`[content] Featured image for "${title}" still failed the text/logo screen after a retry (${hero.screen.reasons.join('; ')}) — operator review`);
    }
    // The row keeps only the data URL: stamp the logo-reference and/or
    // van-wrap-reference markers on it so the publish-time re-screen allows
    // the uniform logo and/or the van wrap (see astro-publisher
    // stampLogoReference / stampVanWrapReference). generatePlannedImage
    // opts every yard-plan hero into both references, so a plan that places
    // a van in frame can come back with vanWrapReference: true here just
    // like an autonomous hero (Codex r2 P2 on #4785 — this marker was
    // previously dropped, so an admin-generated van-wrap hero re-screened
    // at publish time without allowVanWrap and its own legitimate branding
    // was reported as forbidden).
    let dataUrl = hero.dataUrl;
    if (hero.logoReference) dataUrl = AstroPublisher._internals.stampLogoReference(dataUrl);
    if (hero.vanWrapReference) dataUrl = AstroPublisher._internals.stampVanWrapReference(dataUrl);
    return dataUrl;
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
      offset: req.query.offset,
      actionType: ['new_supporting_blog', 'other'].includes(req.query.actionType) ? req.query.actionType : null,
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
    // Terminal writer: the run ends with the same after-run step the daily
    // batch takes (clean up a draft this run took, bring the waiting-drafts
    // item up to date), inside the lock: a click that finds the lock held
    // settles nothing, and the item is never rebuilt beside a running batch.
    const run = await runner._withEngineLock('admin-run-now', async () => {
      const finished = await runner.runNext({ minScore });
      await runner.settleTerminalWork([finished]);
      return finished;
    });
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
    const { status, tag, city, sort = 'publish_date', order = 'asc', search, limit, offset } = req.query;

    // sort went raw into orderBy (unknown column → 42703 → 500 killed the
    // list view) and limit=NaN made knex silently drop the limit (full-table
    // dump including all content).
    const sortColumn = BLOG_SORT_COLUMNS.has(String(sort)) ? String(sort) : 'publish_date';
    const sortOrder = String(order).toLowerCase() === 'desc' ? 'desc' : 'asc';
    const boundedLimit = parseBoundedInt(limit, { defaultValue: 200, min: 1, max: 500, name: 'limit' });
    const boundedOffset = parseBoundedInt(offset, { defaultValue: 0, min: 0, max: 1000000, name: 'offset' });

    const filtered = () => {
      let query = db('blog_posts');
      if (status) query = query.where('status', status);
      if (tag) query = query.where('tag', tag);
      if (city) query = query.where('city', city);
      if (search) query = query.where(function () {
        this.where('title', 'ilike', `%${search}%`).orWhere('keyword', 'ilike', `%${search}%`);
      });
      return query;
    };

    // id breaks sort ties so a page boundary never repeats or skips a row.
    const posts = await filtered().orderBy([{ column: sortColumn, order: sortOrder }, { column: 'id', order: 'asc' }])
      .offset(boundedOffset).limit(boundedLimit);
    // total = every row that matches the filters, so the list can page past
    // the first response (audit BLOG-12).
    const matching = await filtered().count('* as count').first();

    // Counts by status
    const statusCounts = await db('blog_posts').select('status').count('* as count').groupBy('status');
    const counts = {};
    statusCounts.forEach(s => { counts[s.status] = parseInt(s.count); });

    res.json({ posts, counts, total: Number(matching?.count) || 0, offset: boundedOffset });
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

// POST /api/admin/content/blog/:id/optimize — generate optimization suggestions
router.post('/blog/:id/optimize', aiContentLimiter, async (req, res, next) => {
  try {
    const result = await BlogWriter.optimizeExistingPost(req.params.id);
    res.json({ optimization: result });
  } catch (err) { next(err); }
});

// POST /api/admin/content/blog/:id/regenerate-image — Gemini retry.
//
// Lets the operator replace a missing or rejected hero from the editor
// (missing API key, Gemini safety block, network blip on an earlier try).
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
      slug: blogSlug(post),
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
    // An admin's publish click is a human decision (the owner-list
    // chokepoint defers to it; the PR still waits for an admin merge).
    const result = await AstroPublisher.publishAstro(req.params.id, { humanApproved: true });
    res.json({ success: true, ...result });
  } catch (err) {
    logger.error(`[content] publish-astro failed: ${err.message}`);
    // Content-policy rejections are the author's to fix — 400, not 500
    // (a 500 here reads as a server failure and can trip error alerting).
    const isClientErr = err.code === 'BLOG_FRONTMATTER_INVALID'
      || err.code === 'BLOG_GUARDRAILS_FAILED'
      || err.code === 'BLOG_COMPARISON_GATE_FAILED'
      || err.code === 'BLOG_TOPIC_TARGETING_BLOCKED'
      // The final-text comparison scan (hero / body-image alts included).
      || err.code === 'BLOG_OWNER_LIST_BLOCKED';
    // An earlier topic-blocked PR still awaiting its close: try again once
    // pages-poll has retired it — 409, not a server failure.
    const status = isClientErr ? 400 : err.code === 'BLOG_PR_RETIRE_PENDING' ? 409 : 500;
    res.status(status).json({ error: err.message, details: err.details });
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
    // The editor applies the row as it stands after the merge: a removal
    // PR leaves a draft with cleared links, a publish PR leaves it merged.
    // The PR is merged by now, so a failed read must not report a failure.
    let post = null;
    try {
      post = await db('blog_posts').where({ id: req.params.id }).first();
    } catch (readErr) {
      logger.warn(`[content] merge-astro post-merge read failed for ${req.params.id}: ${readErr.message}`);
    }
    res.json({ success: true, ...result, post });
  } catch (err) {
    logger.error(`[content] merge-astro failed: ${err.message}`);
    // The merge-time topic-targeting recheck is an author-correctable policy
    // rejection (branch targeting or live-corpus ownership changed) — 400 with
    // the findings, like publish-astro; everything else is a server failure.
    const status = err.code === 'BLOG_TOPIC_TARGETING_BLOCKED' ? 400
      : err.code === 'TOPIC_MERGE_LOCK_BUSY' ? 409
        : 500;
    res.status(status).json({ error: err.message, details: err.details });
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
    let result;
    if (req.body?.force === true) {
      // Explicit owner re-share: the button was clicked AGAIN after the UI
      // said this URL already went out — deliberate double-post is the
      // owner's call (e.g. boosting a post a week later).
      result = await SocialMediaService.publishToAll({
        title, description, link,
        guid: `blog_${post.id}`,
        source: 'blog',
        imageUrl: publicBlogImageUrl(post),
        // GBP posts only from the explicit GBP image channel (no shared-image
        // fallback — AI provenance is unknowable there). The blog hero IS the
        // sanctioned GBP image, so pass it explicitly or the re-share posts
        // GBP text-only.
        gbpImageUrl: publicBlogImageUrl(post),
      });
    } else {
      // Default path dedupes via shareUrlOnce — with the live-flip auto-share
      // now posting every post the moment it goes live, a Share click minutes
      // later would otherwise silently double-post the same URL.
      result = await SocialMediaService.shareUrlOnce({
        title, description, link,
        source: 'blog',
        noAiImage: true,
      });
      if (result?.skipped === 'already_posted') {
        return res.status(409).json({
          alreadyShared: true,
          blocking_status: result.blocking_status || null,
          error: 'This post already went out to social (or has studio copy drafted for it). Re-run with force to share again.',
        });
      }
      if (result?.skipped) {
        return res.status(409).json({ error: `Share skipped: ${result.skipped}` });
      }
    }

    // Mark post as shared
    try {
      await db('blog_posts').where({ id: post.id }).update({ shared_to_social: true, shared_at: new Date() });
    } catch { /* column may not exist */ }

    res.json(result);
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
    const post = await ContentScheduler.scheduleBlogPost(req.params.id, publishAt, autoShareSocial !== false);
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
      distributeSocial: distributeSocial !== false,
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
      distributeSocial: distributeSocial !== false,
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
module.exports.parseBoundedInt = parseBoundedInt;
module.exports.normalizeBlogUpdates = normalizeBlogUpdates;
module.exports._internals = { generateFeaturedImage };
