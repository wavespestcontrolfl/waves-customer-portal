'use strict';
/**
 * Pre-parser guard for /api/public/track, mounted in server/index.js AHEAD of
 * the global /api/ limiter and the shared express.json/urlencoded parsers.
 *
 * 1. Privacy headers on EVERY outcome (incl. a global-limiter 429) — the URL
 *    carries a bearer track token. Values mirror track-public PRIVACY_HEADERS.
 * 2. POST /:token/view ignores its body (route contract). A malformed token is
 *    the same generic 404 the route answers, decided here before any body
 *    parsing, and the request's Content-Type is dropped so the shared JSON
 *    parser never reads the body: a malformed or oversized body can never turn
 *    the view beacon's 404/204 into a 400/413.
 */
const TRACK_TOKEN_RE = /^[a-f0-9]{64}$/;
const VIEW_PATH_RE = /^\/([^/]+)\/view\/?$/;

function trackPublicPreparser(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  if (req.method === 'POST') {
    const m = VIEW_PATH_RE.exec(req.path || '');
    if (m) {
      if (!TRACK_TOKEN_RE.test(m[1])) return res.status(404).json({ error: 'Not found' });
      delete req.headers['content-type'];
    }
  }
  return next();
}

module.exports = { trackPublicPreparser, TRACK_TOKEN_RE };
