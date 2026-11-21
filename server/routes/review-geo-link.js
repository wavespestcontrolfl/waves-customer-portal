/**
 * Printed-card review link. Mounted at /rv — the QR code on a Waves business
 * card points here, and a scan must land straight on the Google review form
 * of the nearest Waves office, with no page and no tap in between (owner
 * 2026-11-21: "less clicks to give reviews is always better").
 *
 *   GET /rv   → 302 to that office's Google review form
 *
 * The office comes from Cloudflare's visitor-location request headers
 * (cf-ipcountry, cf-iplatitude, cf-iplongitude: an IP-based estimate; zone
 * Managed Transform "Add visitor location headers"), the same headers
 * public-pest-forecast.js /nearest reads. PRIVACY: the location values are
 * read, turned into an office id, and dropped. This route never logs, stores
 * or forwards them. The only thing it records is which office was picked: one
 * click on the reserved `review-<office id>` short code, with no IP, no IP
 * hash and no user agent. (The app-wide access log writes its usual line for
 * this request as for any other; that line has no location header and no
 * redirect target.)
 *
 * Fails open: anything that goes wrong still answers 302 to the fallback
 * office's review form. The redirect target ALWAYS comes from
 * config/locations.js, never from a short_codes row, so a missing counting row
 * changes nothing.
 *
 * /go was already taken (outbound-redirect.js, GET /go/:code), and
 * /review/:token is a client route, so this uses the short free root /rv.
 */

const express = require('express');
const router = express.Router();
const logger = require('../services/logger');
const { WAVES_LOCATIONS, haversineMiles, nearestLocation } = require('../config/locations');
const { resolveShortCode } = require('../services/short-url');
const { isBotUserAgent } = require('../utils/bot-ua');
const { shouldRecord } = require('../services/customer-page-views');

// The fallback office. Its id is `bradenton` (a stable cross-system key) but
// its Google profile is branded "Waves Pest Control Lakewood Ranch".
const REVIEW_GEO_FALLBACK_OFFICE_ID = 'bradenton';

// A visitor whose nearest office is farther than this gets the fallback
// office. Carrier IPs often resolve to Tampa, about 26 miles from the Parrish
// office, and Waves does not serve Tampa.
const REVIEW_GEO_MAX_MILES = 20;

const OFFICE_BY_ID = new Map(WAVES_LOCATIONS.map((loc) => [loc.id, loc]));

// A header or number to a finite number, else null. Blank strings, booleans,
// arrays and NaN are "missing" (Number('') is 0, which would read as a point
// off the African coast instead of no value).
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pick the office whose review form a visitor should land on. Pure: returns an
 * office id from WAVES_LOCATIONS and never throws.
 */
function pickReviewOfficeId({ country, latitude, longitude } = {}) {
  const countryCode = typeof country === 'string' ? country.trim().toUpperCase() : '';
  if (countryCode && countryCode !== 'US') return REVIEW_GEO_FALLBACK_OFFICE_ID;

  const lat = toFiniteNumber(latitude);
  const lng = toFiniteNumber(longitude);
  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return REVIEW_GEO_FALLBACK_OFFICE_ID;
  }

  // The shared nearest-office lookup, then this route's own distance cap.
  const best = nearestLocation(lat, lng);
  if (!best) return REVIEW_GEO_FALLBACK_OFFICE_ID;
  const miles = haversineMiles({ latitude: lat, longitude: lng }, best);
  return miles > REVIEW_GEO_MAX_MILES ? REVIEW_GEO_FALLBACK_OFFICE_ID : best.id;
}

// The reserved short code that counts clicks for one office. Rows are created
// by hand in production; a missing row is a silent no-op.
function reviewShortCodeForOffice(officeId) {
  return `review-${officeId}`;
}

function reviewUrlForOffice(officeId) {
  const office = OFFICE_BY_ID.get(officeId) || OFFICE_BY_ID.get(REVIEW_GEO_FALLBACK_OFFICE_ID);
  return office.googleReviewUrl;
}

// Every response (302, 429) carries the same headers, set BEFORE the limiter
// so its 429 does not skip them. The redirect differs per visitor, so it is
// never cached anywhere.
router.use((req, res, next) => {
  res.set({
    'Cache-Control': 'private, no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
  next();
});

// Same budget and key as /l: outside the global /api/ limiter, so it carries
// its own. 120/min per key is far above any human scan rate, and carrier-NAT
// IPs aggregate many customers.
const reviewGeoLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: require('../middleware/rate-limit-key').unauthenticatedAuthLimitKey,
  handler: (req, res) => res.status(429).type('text').send('Too many requests'),
});
router.use(reviewGeoLimiter);

router.get('/', (req, res) => {
  let officeId = REVIEW_GEO_FALLBACK_OFFICE_ID;
  try {
    officeId = pickReviewOfficeId({
      country: req.get('cf-ipcountry'),
      latitude: req.get('cf-iplatitude'),
      longitude: req.get('cf-iplongitude'),
    });

    // Count the pick fire-and-forget. Bots and unfurlers (the QR is also
    // pasted into chats) are filtered HERE and not counted, staff previews
    // bump the aggregate only (recordClick), and nothing here can change the
    // redirect. Neither the IP nor the user agent is passed on: the counter
    // would store them (last_click_ip / last_click_ua, and ip_hash /
    // user_agent on the click row), and only the office pick may be recorded.
    if (req.method === 'GET' && !isBotUserAgent(req.headers['user-agent'])) {
      Promise.resolve()
        .then(() => resolveShortCode(reviewShortCodeForOffice(officeId), {
          recordClick: shouldRecord(req),
        }))
        .catch(() => { /* counting never blocks the redirect; resolveShortCode logs its own errors */ });
    }
  } catch (err) {
    logger.error(`[review-geo-link] pick failed: ${err.message}`);
    officeId = REVIEW_GEO_FALLBACK_OFFICE_ID;
  }
  return res.redirect(302, reviewUrlForOffice(officeId));
});

module.exports = router;
module.exports.pickReviewOfficeId = pickReviewOfficeId;
module.exports.reviewShortCodeForOffice = reviewShortCodeForOffice;
module.exports.REVIEW_GEO_MAX_MILES = REVIEW_GEO_MAX_MILES;
module.exports.REVIEW_GEO_FALLBACK_OFFICE_ID = REVIEW_GEO_FALLBACK_OFFICE_ID;
