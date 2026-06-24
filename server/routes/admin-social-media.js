const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SocialMediaService = require('../services/social-media');
const { SOCIAL_FLAGS, isPausedByAdmin, normalizeUrl } = require('../services/social-media');
const linkedin = require('../services/linkedin');
const SocialContentStudio = require('../services/social-content-studio');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// The Social Content Studio kill switch (SOCIAL_AUTONOMOUS_STUDIO_ENABLED) must
// disable the WHOLE feature, not just the autonomous cron. Guard every studio
// endpoint that writes to the DB or spends image credits so flipping the switch
// off is a true single-point kill — manual admin writes included. Read-only
// preview/context/list endpoints stay open (no DB write, no image render).
function requireStudioEnabled(req, res, next) {
  if (!SocialContentStudio.AUTONOMOUS_FLAGS.enabled) {
    return res.status(503).json({
      error: 'Social Content Studio is disabled',
      detail: 'Set SOCIAL_AUTONOMOUS_STUDIO_ENABLED=true to enable studio writes.',
    });
  }
  next();
}

// GET /status — platform connection status + feature flags
router.get('/status', async (req, res, next) => {
  try {
    const paused = await isPausedByAdmin();
    const linkedinStatus = await linkedin.getStatus();
    res.json({
      platforms: {
        facebook: { configured: !!process.env.FACEBOOK_ACCESS_TOKEN, enabled: SOCIAL_FLAGS.facebookEnabled, pageId: process.env.FACEBOOK_PAGE_ID || '' },
        instagram: { configured: !!process.env.FACEBOOK_ACCESS_TOKEN, enabled: SOCIAL_FLAGS.instagramEnabled, accountId: process.env.INSTAGRAM_ACCOUNT_ID || '' },
        linkedin: { configured: linkedinStatus.configured, connected: linkedinStatus.connected, enabled: SOCIAL_FLAGS.linkedinEnabled, companyId: linkedinStatus.companyId || '' },
        gbp: { configured: true, enabled: SOCIAL_FLAGS.gbpEnabled, locations: 4 },
        gemini: { configured: !!process.env.GEMINI_API_KEY },
        ai: { configured: !!process.env.ANTHROPIC_API_KEY },
      },
      automation: {
        enabled: SOCIAL_FLAGS.automationEnabled,
        paused,
        dryRun: SOCIAL_FLAGS.dryRun,
        rssAutopublish: SOCIAL_FLAGS.rssAutopublish,
        scheduledPosts: SOCIAL_FLAGS.scheduledPosts,
        newsletterAutoshare: SOCIAL_FLAGS.newsletterAutoshare,
      },
      rssFeed: 'https://www.wavespestcontrol.com/feed.xml',
    });
  } catch (err) { next(err); }
});

// POST /pause — toggle admin pause
router.post('/pause', async (req, res, next) => {
  try {
    const { paused } = req.body;
    const value = paused ? 'true' : 'false';
    const existing = await db('system_settings').where('key', 'social_automation_paused').first();
    if (existing) {
      await db('system_settings').where('key', 'social_automation_paused').update({ value, updated_at: new Date() });
    } else {
      await db('system_settings').insert({ key: 'social_automation_paused', value, updated_at: new Date() });
    }
    logger.info(`[social] Automation ${paused ? 'paused' : 'resumed'} by admin`);
    res.json({ paused: !!paused });
  } catch (err) { next(err); }
});

// GET /rss — fetch latest RSS items
router.get('/rss', async (req, res, next) => {
  try {
    const url = req.query.url || 'https://www.wavespestcontrol.com/feed.xml';
    const items = await SocialMediaService.getRSSItems(url);
    // Mark which have been posted
    for (const item of items) {
      const posted = await db('social_media_posts').where({ source_url: normalizeUrl(item.link) || item.link }).first();
      item.posted = !!posted;
      item.postId = posted?.id;
    }
    res.json({ items, feedUrl: url });
  } catch (err) { next(err); }
});

// POST /preview — generate AI content preview for all platforms
router.post('/preview', async (req, res, next) => {
  try {
    const { title, description, link } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const content = await SocialMediaService.previewContent({ title, description, link });
    res.json(content);
  } catch (err) { next(err); }
});

// GET /campaign-builder/context — source facts for local GBP/social campaigns
router.get('/campaign-builder/context', async (req, res, next) => {
  try {
    const context = await SocialContentStudio.getCampaignContext({
      topic: req.query.topic,
      city: req.query.city,
      service: req.query.service,
    });
    res.json(context);
  } catch (err) { next(err); }
});

// POST /campaign-builder/preview — template-grade campaign drafts
router.post('/campaign-builder/preview', async (req, res, next) => {
  try {
    const result = await SocialContentStudio.previewCampaign(req.body || {});
    res.json(result);
  } catch (err) { next(err); }
});

// POST /campaign-builder/save — save generated campaign as a social draft
router.post('/campaign-builder/save', requireStudioEnabled, async (req, res, next) => {
  try {
    const result = await SocialContentStudio.saveCampaignDraft(req.body || {});
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

// GET /autonomous/status — social content studio autonomous mode state
router.get('/autonomous/status', async (req, res, next) => {
  try {
    const status = await SocialContentStudio.autonomousStatus();
    res.json(status);
  } catch (err) { next(err); }
});

// GET /autonomous/runs — audit trail for autonomous social studio attempts
router.get('/autonomous/runs', async (req, res, next) => {
  try {
    const result = await SocialContentStudio.listAutonomousRuns({
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /autonomous/run — force or test an autonomous social run
router.post('/autonomous/run', requireStudioEnabled, async (req, res, next) => {
  try {
    const result = await SocialContentStudio.runAutonomous({
      force: req.body?.force === true,
      mode: req.body?.mode,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /review-graphics — privacy-safe Google review graphic queue
router.get('/review-graphics', async (req, res, next) => {
  try {
    const result = await SocialContentStudio.listReviewGraphicCandidates({
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /review-graphics — create or update a review graphic draft
router.post('/review-graphics', requireStudioEnabled, async (req, res, next) => {
  try {
    const graphic = await SocialContentStudio.createReviewGraphic(req.body || {});
    res.json({ success: true, graphic });
  } catch (err) { next(err); }
});

// POST /review-graphics/:id/approve — mark a review graphic approved
router.post('/review-graphics/:id/approve', requireStudioEnabled, async (req, res, next) => {
  try {
    const existing = await db('review_graphics').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'review graphic not found' });
    // Never approve a graphic with no rendered image — approving publishes it as
    // a "5-star review" card, and a blank card is worse than none.
    if (!existing.image_url) {
      return res.status(400).json({ error: 'review graphic has no rendered image; regenerate it before approving' });
    }
    const [graphic] = await db('review_graphics')
      .where({ id: req.params.id })
      .update({
        status: 'approved',
        approved_at: new Date(),
        updated_at: new Date(),
      })
      .returning('*');
    res.json({ success: true, graphic });
  } catch (err) { next(err); }
});

// GET /competitor-swipe — fastest-riser profiles and manual engagement captures
router.get('/competitor-swipe', async (req, res, next) => {
  try {
    const result = await SocialContentStudio.listCompetitorSwipeFile();
    res.json(result);
  } catch (err) { next(err); }
});

// POST /competitor-swipe/posts — manual competitor post engagement capture
router.post('/competitor-swipe/posts', requireStudioEnabled, async (req, res, next) => {
  try {
    const post = await SocialContentStudio.createCompetitorPost(req.body || {});
    res.json({ success: true, post });
  } catch (err) { next(err); }
});

// POST /publish — publish to all platforms
router.post('/publish', async (req, res, next) => {
  try {
    const { title, description, link, guid, imageUrl, customContent, channels, gbpLocationIds } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = await SocialMediaService.publishToAll({
      title, description, link, guid, source: 'manual', imageUrl, customContent, channels, gbpLocationIds,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /publish-single — post to one platform
router.post('/publish-single', async (req, res, next) => {
  try {
    const { platform, title, description, link, content, imageUrl, locationId } = req.body;
    if (!platform) return res.status(400).json({ error: 'platform required' });
    const result = await SocialMediaService.postToSingle(platform, {
      title, description, link, content, imageUrl, locationId,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /check-rss — check RSS feed and auto-publish new items
router.post('/check-rss', async (req, res, next) => {
  try {
    const url = req.body.feedUrl || 'https://www.wavespestcontrol.com/feed.xml';
    const result = await SocialMediaService.checkAndPublish(url, { manual: true });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /history — post history
router.get('/history', async (req, res, next) => {
  try {
    const { limit = 50, page = 1, status } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const posts = await SocialMediaService.getHistory({ limit: parseInt(limit), offset, status });
    const [{ count: total }] = await db('social_media_posts').count('* as count');
    res.json({ posts, total: parseInt(total), page: parseInt(page) });
  } catch (err) { next(err); }
});

// GET /stats — dashboard stats
router.get('/stats', async (req, res, next) => {
  try {
    const [totals] = await db('social_media_posts').select(
      db.raw("COUNT(*) as total"),
      db.raw("COUNT(*) FILTER (WHERE status = 'published') as published"),
      db.raw("COUNT(*) FILTER (WHERE status = 'failed') as failed"),
      db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') as last_7d"),
      db.raw("COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') as last_30d")
    );
    res.json({
      total: parseInt(totals.total),
      published: parseInt(totals.published),
      failed: parseInt(totals.failed),
      last7d: parseInt(totals.last_7d),
      last30d: parseInt(totals.last_30d),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/social-media/analytics — aggregated analytics
router.get('/analytics', async (req, res, next) => {
  try {
    // Posts grouped by platform (cap at 2000 most-recent to avoid unbounded scans)
    const posts = await db('social_media_posts').orderBy('created_at', 'desc').limit(2000);

    const byPlatform = {};
    const weeklyBuckets = {};

    for (const post of posts) {
      const platforms = post.platforms_posted || [];
      const platformList = Array.isArray(platforms) ? platforms : (typeof platforms === 'string' ? JSON.parse(platforms) : []);

      // If no platform info, use a generic bucket
      const effectivePlatforms = platformList.length > 0
        ? platformList.map(p => typeof p === 'string' ? p : (p.platform || 'unknown'))
        : ['unknown'];

      for (const platform of effectivePlatforms) {
        if (!byPlatform[platform]) {
          byPlatform[platform] = { total: 0, success: 0, failed: 0, draft: 0, scheduled: 0 };
        }
        byPlatform[platform].total++;
        if (post.status === 'published') byPlatform[platform].success++;
        else if (post.status === 'failed') byPlatform[platform].failed++;
        else if (post.status === 'draft') byPlatform[platform].draft++;
        else if (post.status === 'scheduled') byPlatform[platform].scheduled++;
      }

      // Weekly trend — bucket by ISO week
      const created = new Date(post.created_at);
      const weekStart = new Date(created);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekKey = weekStart.toISOString().split('T')[0];
      if (!weeklyBuckets[weekKey]) weeklyBuckets[weekKey] = { week: weekKey, total: 0, published: 0, failed: 0 };
      weeklyBuckets[weekKey].total++;
      if (post.status === 'published') weeklyBuckets[weekKey].published++;
      if (post.status === 'failed') weeklyBuckets[weekKey].failed++;
    }

    // Calculate overall stats
    const totalPosts = posts.length;
    const published = posts.filter(p => p.status === 'published').length;
    const successRate = totalPosts > 0 ? Math.round((published / totalPosts) * 100) : 0;

    // Posts per week (last 12 weeks)
    const twelveWeeksAgo = Date.now() - 12 * 7 * 86400000;
    const recentPosts = posts.filter(p => new Date(p.created_at).getTime() > twelveWeeksAgo);
    const postsPerWeek = recentPosts.length > 0 ? parseFloat((recentPosts.length / 12).toFixed(1)) : 0;

    // Most active platform
    let mostActivePlatform = null;
    let maxCount = 0;
    for (const [platform, stats] of Object.entries(byPlatform)) {
      if (stats.total > maxCount) { maxCount = stats.total; mostActivePlatform = platform; }
    }

    // Top posts (most recent published)
    const topPosts = posts
      .filter(p => p.status === 'published')
      .slice(0, 10)
      .map(p => ({
        id: p.id,
        title: p.title,
        platforms: p.platforms_posted,
        publishedAt: p.published_at,
        sourceUrl: p.source_url,
      }));

    const weeklyTrend = Object.values(weeklyBuckets)
      .sort((a, b) => a.week.localeCompare(b.week))
      .slice(-12);

    res.json({
      byPlatform,
      weeklyTrend,
      topPosts,
      summary: {
        totalPosts,
        published,
        successRate,
        postsPerWeek,
        mostActivePlatform,
      },
    });
  } catch (err) { next(err); }
});

// GET /health — credential health for social media platforms (cached 5 min)
let healthCache = null;
let healthCacheAt = 0;
const HEALTH_CACHE_TTL = 5 * 60 * 1000;

router.get('/health', async (req, res, next) => {
  try {
    const now = Date.now();
    if (healthCache && (now - healthCacheAt) < HEALTH_CACHE_TTL && !req.query.force) {
      return res.json(healthCache);
    }

    const tokenHealth = require('../services/token-health');
    // 'gemini' matches the /status gemini card directly (checkGemini → platform 'gemini').
    const platforms = ['facebook', 'instagram', 'linkedin', 'gemini', 'gbp_lwr', 'gbp_parrish', 'gbp_sarasota', 'gbp_venice'];
    const results = [];
    for (const p of platforms) {
      const r = await tokenHealth.checkSingle(p);
      results.push({ ...r, lastCheckedAt: new Date().toISOString() });
    }
    // The Social Media page's 'ai' card maps to Anthropic; checkAnthropic reports
    // platform 'anthropic', so relabel it to 'ai' to match the card key (otherwise
    // the card stays "Unknown" with no matching credential).
    const aiRes = await tokenHealth.checkSingle('anthropic');
    if (aiRes) results.push({ ...aiRes, platform: 'ai', lastCheckedAt: new Date().toISOString() });

    healthCache = { credentials: results, checkedAt: new Date().toISOString() };
    healthCacheAt = now;

    res.json(healthCache);
  } catch (err) { next(err); }
});

// GET /alerts — active social media alerts
router.get('/alerts', async (req, res, next) => {
  try {
    const row = await db('system_settings')
      .where('key', 'social_consecutive_failures_alert')
      .first();
    if (row) {
      const alert = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
      res.json({ alert, active: true });
    } else {
      res.json({ alert: null, active: false });
    }
  } catch (err) { next(err); }
});

// DELETE /alerts — dismiss social media alert
router.delete('/alerts', async (req, res, next) => {
  try {
    await db('system_settings')
      .where('key', 'social_consecutive_failures_alert')
      .del();
    res.json({ dismissed: true });
  } catch (err) { next(err); }
});

module.exports = router;
