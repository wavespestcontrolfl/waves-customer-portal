// GET /api/public/services/menu — the catalog-derived product menu the
// website quote form renders from (quote-to-estimate alignment C2). Public,
// read-only, cacheable; see services/public-services-menu.js for the contract.
const express = require('express');
const router = express.Router();
const { loadPublicServicesMenu } = require('../services/public-services-menu');

router.get('/menu', async (req, res, next) => {
  try {
    const items = await loadPublicServicesMenu();
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ generated_at: new Date().toISOString(), items });
  } catch (err) {
    res.set('Cache-Control', 'no-store');
    next(err);
  }
});

module.exports = router;
