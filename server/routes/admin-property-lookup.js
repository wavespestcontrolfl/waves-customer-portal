const express = require('express');
const router = express.Router();
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');

router.use(adminAuthenticate, requireTechOrAdmin);

const RENTCAST_KEY = process.env.RENTCAST_API_KEY || '6dfcb2eaa9f34bf285e101b74e1a3ef6';
const GOOGLE_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyCvzQ84QWUKMby5YcbM8MhDBlEZ2oF7Bsk';
const SATELLITE_WEBHOOK = process.env.SATELLITE_WEBHOOK_URL || 'https://hooks.zapier.com/hooks/catch/18868815/unk1e8d/';

// GET /api/admin/lookup/property?address=...
router.get('/property', async (req, res, next) => {
  try {
    const { address } = req.query;
    if (!address) return res.status(400).json({ error: 'Address required' });

    // RentCast lookup
    const rcResp = await fetch(`https://api.rentcast.io/v1/properties?address=${encodeURIComponent(address)}`, {
      headers: { 'X-Api-Key': RENTCAST_KEY, 'Accept': 'application/json' },
    });

    let property = null;
    if (rcResp.ok) {
      const rcData = await rcResp.json();
      property = Array.isArray(rcData) ? rcData[0] : rcData;
    }

    // Google Geocode for satellite
    let satellite = null;
    try {
      const gResp = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_KEY}`);
      const gData = await gResp.json();
      if (gData.status === 'OK' && gData.results?.length) {
        const loc = gData.results[0].geometry.location;
        if (loc.lat >= 24 && loc.lat <= 32 && loc.lng >= -88 && loc.lng <= -79) {
          satellite = {
            lat: loc.lat, lng: loc.lng,
            imageUrl: `https://maps.googleapis.com/maps/api/staticmap?center=${loc.lat},${loc.lng}&zoom=20&size=640x640&maptype=satellite&format=png&key=${GOOGLE_KEY}`,
          };
        }
      }
    } catch (e) { logger.error(`Geocode error: ${e.message}`); }

    res.json({ property, satellite });
  } catch (err) { next(err); }
});

// POST /api/admin/lookup/satellite-ai — dual-vision satellite analysis (Claude + Gemini)
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
