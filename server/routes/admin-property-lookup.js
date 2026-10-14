const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { performPropertyLookup } = require('./property-lookup-v2');
const { lookupOptionsFor } = require('../services/property-lookup/lookup-callers');

router.use(adminAuthenticate, requireTechOrAdmin);

// GET /api/admin/lookup/property?address=...
router.get('/property', async (req, res, next) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Address required' });

    // Scope decision: lookup-callers.js (admin_lookup_get: no answer surface).
    const lookup = await performPropertyLookup(address, lookupOptionsFor('admin_lookup_get'));

    res.json({
      property: lookup.propertyRecord || lookup.rentcast || null,
      satellite: lookup.satellite,
      enriched: lookup.enriched,
      aiAnalysis: lookup.aiAnalysis,
      errors: lookup.errors,
      meta: lookup.meta,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/lookup/satellite-ai — trio-vision satellite analysis (Claude + OpenAI + Gemini)
router.post('/satellite-ai', async (req, res, next) => {
  try {
    const { address, lat, lng } = req.body;
    if (!address && !lat) return res.status(400).json({ error: 'Address or coordinates required' });

    const SatelliteAnalyzer = require('../services/satellite-analyzer');
    const result = await SatelliteAnalyzer.analyze(address, lat ? parseFloat(lat) : null, lng ? parseFloat(lng) : null);

    res.json(result);
  } catch (err) {
    logger.error(`Satellite AI failed: ${err.message}`);
    res.json({ error: err.message });
  }
});

module.exports = router;
