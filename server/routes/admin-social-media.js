const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SocialMediaService = require('../services/social-media');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /status — platform connection status
router.get('/status', async (req, res, next) => {
  try {
    res.json({
      platforms: {
        facebook: { configured: !!process.env.FACEBOOK_ACCESS_TOKEN, pageId: process.env.FACEBOOK_PAGE_ID || '110336442031847' },
        instagram: { configured: !!process.env.FACEBOOK_ACCESS_TOKEN, accountId: process.env.INSTAGRAM_ACCOUNT_ID || '17841465266249854' },
        linkedin: { configured: !!process.env.LINKEDIN_ACCESS_TOKEN, companyId: process.env.LINKEDIN_COMPANY_ID || '89173265' },
        gbp: { configured: true, locations: 4 },
        gemini: { configured: !!process.env.GEMINI_API_KEY },
        ai: { configured: !!process.env.ANTHROPIC_API_KEY },
      },
      rssFeed: 'https://www.wavespestcontrol.com/feed/',
    });
  } catch (err) { next(err); }
});

// GET /rss — fetch latest RSS items
router.get('/rss', async (req, res, next) => {
  try {
    const url = req.query.url || 'https://www.wavespestcontrol.com/feed/';
    const items = await SocialMediaService.getRSSItems(url);
    // Mark which have been posted
    for (const item of items) {
      const posted = await db('social_media_posts').where({ source_url: item.link }).first();
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

// POST /publish — publish to all platforms
router.post('/publish', async (req, res, next) => {
  try {
    const { title, description, link, guid, imageUrl, customContent } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const result = await SocialMediaService.publishToAll({
      title, description, link, guid, source: 'manual', imageUrl, customContent,
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
    const url = req.body.feedUrl || 'https://www.wavespestcontrol.com/feed/';
    const result = await SocialMediaService.checkAndPublish(url);
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

// GET /health — credential health for social media platforms
router.get('/health', async (req, res, next) => {
  try {
    const tokenHealth = require('../services/token-health');
    const platforms = ['facebook', 'instagram', 'linkedin', 'gbp_lwr', 'gbp_parrish', 'gbp_sarasota', 'gbp_venice'];
    const results = [];
    for (const p of platforms) {
      const r = await tokenHealth.checkSingle(p);
      results.push(r);
    }
    res.json({ credentials: results });
  } catch (err) { next(err); }
});

module.exports = router;
