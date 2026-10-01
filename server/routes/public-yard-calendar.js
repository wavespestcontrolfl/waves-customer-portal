/**
 * Public SWFL Yard Pressure Calendar API (no auth) — monthly lawn / shrubs &
 * trees / weeds guide derived from the owner-approved species catalog.
 *
 * Mounted at /api/public/yard-calendar. Read-only GET: no DB, no LLM, no
 * cookies, no PII. Like the pest-forecast widget it is embeddable on other
 * sites, so CORS (`Access-Control-Allow-Origin: *` + OPTIONS preflight) is
 * handled at the app level in server/index.js, above the credentialed cors().
 *
 *   GET /api/public/yard-calendar?month=10&grass=sta
 *
 * month 1-12 (default: the current ET month); grass all|sta|bah|zoy|ber
 * (default all). Anything else is a 400. The content changes monthly, so
 * responses are CDN-cacheable.
 */

const express = require('express');
const router = express.Router();
const { etParts } = require('../utils/datetime-et');
const { buildYardCalendar, GRASS_FILTERS } = require('../services/pest-forecast/landscape-calendar');

function singleParam(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

router.get('/', (req, res) => {
  const monthParam = singleParam(req.query.month);
  const grassParam = singleParam(req.query.grass);

  if (req.query.month !== undefined && !/^(?:[1-9]|1[0-2])$/.test(monthParam || '')) {
    return res.status(400).json({ error: 'invalid_month', message: 'month must be an integer from 1 to 12' });
  }
  if (req.query.grass !== undefined && !GRASS_FILTERS.includes(grassParam)) {
    return res.status(400).json({ error: 'invalid_grass', message: `grass must be one of ${GRASS_FILTERS.join(', ')}` });
  }

  const explicitMonth = monthParam !== undefined;
  const month = explicitMonth ? Number(monthParam) : etParts().month;

  // An explicit month never changes, so the shared cache keeps it a day. The
  // defaulted month flips at ET midnight on the 1st, so it stays short-lived.
  res.set('Cache-Control', explicitMonth
    ? 'public, max-age=3600, s-maxage=86400'
    : 'public, max-age=300, s-maxage=900');
  res.json(buildYardCalendar({ month, grass: grassParam || 'all' }));
});

module.exports = router;
