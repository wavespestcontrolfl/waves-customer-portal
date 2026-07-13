/**
 * Single source of truth for the cross-origin allowlist.
 *
 * Both the Express HTTP server and the Socket.io server consume this
 * list. Defining it twice is how production breaks at 11pm on a Friday
 * when a new domain gets added — keep it in one file.
 *
 * config.clientUrl is included so dev (localhost:5173) and any
 * environment-specific override (CLIENT_URL on Railway) automatically
 * flow through.
 *
 * The marketing fleet (hub + every spoke in content-astro/spoke-sites.js)
 * is DERIVED, not hand-listed: every fleet site's lead forms — quote
 * wizard, estimate calculator, hero slider — POST cross-origin to
 * /api/public/estimator/property-lookup, /api/public/quote/calculate and
 * /api/leads. An origin missing here makes the cors() middleware answer
 * the preflight without Access-Control-Allow-Origin, so the browser kills
 * the POST as "Failed to fetch" — which is how every spoke silently lost
 * quote submissions until 2026-07 (only the hub was listed). Deriving from
 * the fleet registry means a future spoke gets lead capture the moment it
 * ships, with no second list to forget.
 *
 * Both www and apex are listed per domain: customers land on www (apex
 * 301s there), but the apex entries keep a redirect misconfiguration from
 * ALSO breaking lead capture.
 */
const config = require('./');
const { SPOKE_SITE_KEYS } = require('../services/content-astro/spoke-sites');

const allowedOrigins = [
  ...new Set([
    config.clientUrl,
    'https://portal.wavespestcontrol.com',
    // Marketing fleet — SPOKE_SITE_KEYS includes the hub (wavespestcontrol.com).
    ...SPOKE_SITE_KEYS.flatMap((domain) => [
      `https://${domain}`,
      `https://www.${domain}`,
    ]),
  ]),
];

module.exports = { allowedOrigins };
