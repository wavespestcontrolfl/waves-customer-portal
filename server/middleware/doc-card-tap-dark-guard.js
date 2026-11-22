/**
 * The receipt and tracker card taps (GATE_DOC_CROSS_SELL, owner 2026-11-21),
 * decided ahead of every limiter and body parser. Mounted in server/index.js
 * AHEAD of the global /api/ limiter, like the payer-statement and
 * lawn-assessment guards.
 *
 * - Gate dark: a tap reads as Not Found, even for an IP that has used up the
 *   global limiter (AGENTS.md: a dark route skips its limiter so a probe
 *   never sees a revealing 429).
 * - Gate on: a tap whose token has the wrong shape is the same Not Found,
 *   before the limiter and before its body is parsed.
 * - Every answer to a tap carries the bearer-token privacy headers, a later
 *   limiter 429 included.
 *
 * The path match follows Express's own: route names match in any letter
 * case, with or without a closing slash.
 */
const { TRACK_TOKEN_RE } = require('./track-public-preparser');

const CARD_TAP_PATH_RE = /^\/([^/]+)\/(?:cross-sell|referral-link)\/?$/i;

// One entry per surface: the route's own not-found body and its token shape
// (receipt: the pay route's, current 64-hex and legacy 25-32 url-safe;
// tracker: 64-hex). The routes read their token shape from here.
const CARD_TAP_SURFACES = Object.freeze({
  receipt: Object.freeze({ notFoundBody: { error: 'Receipt not found' }, tokenRe: /^[A-Za-z0-9_-]{20,64}$/ }),
  track: Object.freeze({ notFoundBody: { error: 'Not found' }, tokenRe: TRACK_TOKEN_RE }),
});

// Express hands a route its :token percent-decoded; a segment it cannot
// decode never matches a token shape.
function decodedSegment(segment) {
  try { return decodeURIComponent(segment); } catch { return ''; }
}

// Called from inline wrappers in index.js (the public-route scanner must be
// able to prove a mounted handler is not a router).
function docCardTapDarkGuard(surface, req, res, next) {
  const tap = req.method === 'POST' ? CARD_TAP_PATH_RE.exec(req.path || '') : null;
  if (!tap) return next();
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  if (!require('../config/feature-gates').isEnabled('docCrossSell')
    || !surface.tokenRe.test(decodedSegment(tap[1]))) {
    return res.status(404).json(surface.notFoundBody);
  }
  return next();
}

module.exports = { docCardTapDarkGuard, CARD_TAP_SURFACES };
