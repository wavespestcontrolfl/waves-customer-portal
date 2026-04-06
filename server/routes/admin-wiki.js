/**
 * Admin Agronomic Wiki Routes
 *
 * Browse, search, and manage the AI-maintained agronomic knowledge base.
 */

const express = require('express');
const router = express.Router();
const { adminAuthenticate } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const wiki = require('../services/agronomic-wiki');

router.use(adminAuthenticate);

// =========================================================================
// GET / — list all pages (filterable by category)
// =========================================================================
router.get('/', async (req, res, next) => {
  try {
    const { category, staleOnly, orderBy, orderDir, limit, offset } = req.query;
    const pages = await wiki.listPages(category || null, {
      staleOnly: staleOnly === 'true',
      orderBy,
      orderDir,
      limit: limit ? parseInt(limit) : undefined,
      offset: offset ? parseInt(offset) : undefined,
    });
    res.json({ pages });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /search?q=... — full-text search
// =========================================================================
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || !q.trim()) return res.json({ results: [] });
    const results = await wiki.searchWiki(q);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /stats — dashboard stats
// =========================================================================
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await wiki.getStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /log — recent update log
// =========================================================================
router.get('/log', async (req, res, next) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 50;
    const log = await wiki.getLog(limit);
    res.json({ log });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// GET /:slug(*) — get single page (slug can contain slashes like product/celsius-wg)
// =========================================================================
router.get('/:slug(*)', async (req, res, next) => {
  try {
    const page = await wiki.getPage(req.params.slug);
    if (!page) return res.status(404).json({ error: 'Page not found' });
    res.json({ page });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /update/:slug(*) — trigger manual update for a page
// =========================================================================
router.post('/update/:slug(*)', async (req, res, next) => {
  try {
    const page = await wiki.getPage(req.params.slug);
    if (!page) return res.status(404).json({ error: 'Page not found' });

    let updated;
    if (page.category === 'product') {
      const productName = page.title.replace(/^Product:\s*/i, '');
      updated = await wiki.updateProductPage(productName);
    } else if (page.category === 'track') {
      const trackId = page.slug.replace('track/', '');
      updated = await wiki.updateTrackPage(trackId);
    } else if (page.category === 'condition') {
      const conditionName = page.title.replace(/^Condition:\s*/i, '');
      updated = await wiki.updateConditionPage(conditionName);
    } else if (page.category === 'seasonal') {
      const monthNames = ['january','february','march','april','may','june','july','august','september','october','november','december'];
      const monthSlug = page.slug.replace('seasonal/', '');
      const monthIdx = monthNames.indexOf(monthSlug);
      if (monthIdx >= 0) {
        updated = await wiki.updateSeasonalPage(monthIdx + 1);
      }
    }

    if (!updated) {
      return res.status(400).json({ error: 'Could not update page — no data or unsupported category' });
    }

    res.json({ success: true, page: updated });
  } catch (err) {
    next(err);
  }
});

// =========================================================================
// POST /generate — generate a new page
// Body: { category, subject }
// =========================================================================
router.post('/generate', async (req, res, next) => {
  try {
    const { category, subject } = req.body;
    if (!category || !subject) {
      return res.status(400).json({ error: 'category and subject are required' });
    }

    let page;
    if (category === 'product') {
      page = await wiki.updateProductPage(subject);
    } else if (category === 'condition') {
      page = await wiki.updateConditionPage(subject);
    } else if (category === 'track') {
      page = await wiki.updateTrackPage(subject);
    } else if (category === 'seasonal') {
      const monthNum = parseInt(subject);
      if (monthNum >= 1 && monthNum <= 12) {
        page = await wiki.updateSeasonalPage(monthNum);
      } else {
        return res.status(400).json({ error: 'For seasonal category, subject must be a month number (1-12)' });
      }
    } else {
      // Generic page generation
      const slug = `${category}/${subject.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      page = await wiki.generatePage(slug, category, { outcomes: [] }, subject);
    }

    if (!page) {
      return res.status(400).json({ error: 'Could not generate page — no data available' });
    }

    res.json({ success: true, page });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
