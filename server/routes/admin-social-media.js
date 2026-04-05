const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const SocialMediaService = require('../services/social-media');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /status — platform connection status
router.get('/status', async (req, res) => {
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

module.exports = router;
