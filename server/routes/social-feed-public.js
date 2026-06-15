/**
 * Public social feed route — GET /api/public/social-feed.
 *
 * No auth. Read-only aggregate of recent Instagram + Facebook + Google +
 * YouTube posts, served to the marketing site's /social page. The payload is
 * cached in-memory (15 min) by the service, so this route is cheap. CORS is
 * handled by the global allowlist (www.wavespestcontrol.com is included).
 */
const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const logger = require('../services/logger');
const { getFeed } = require('../services/social-feed');

router.use(rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again in a minute.' },
}));

router.get('/', async (req, res) => {
  try {
    const feed = await getFeed();
    // Let the browser + Cloudflare cache briefly; the service already
    // dedupes upstream calls, this just trims request volume.
    res.set('Cache-Control', 'public, max-age=300');
    res.json(feed);
  } catch (err) {
    logger.error(`[social-feed] route error: ${err.message}`);
    // Never fail the marketing page — return an empty, well-formed payload.
    res.json({ posts: [], sources: {}, generatedAt: new Date().toISOString() });
  }
});

module.exports = router;
