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
// A holder's tracker token (64 hex) or a visit text recipient's own (`vr_` + 48 hex): the same shapes track-public accepts.
const { isRecipientTrackToken } = require('../utils/recipient-track-token');
const TRACK_TOKEN_RE = /^(?:[a-f0-9]{64}|vr_[a-f0-9]{48})$/;
const VIEW_PATH_RE = /^\/([^/]+)\/view\/?$/;
const FIRST_SEGMENT_RE = /^\/([^/]+)/;

function recipientLinksLive() {
  const gates = require('../config/feature-gates');
  return typeof gates.callGivenVisitTextsLive === 'function' && gates.callGivenVisitTextsLive() === true;
}

function trackPublicPreparser(req, res, next) {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  res.set('Referrer-Policy', 'no-referrer');
  // A visit text recipient's token (`vr_` + 48 hex, GATE_CALL_GIVEN_VISIT_TEXTS) names nothing while that gate is off: the generic
  // 404 on all three routes (GET, stops-ahead, view), decided here by the token's shape, before any rate limiter, body parser or
  // database read. The gate is read per request, so unsetting it closes every recipient link at once.
  const first = FIRST_SEGMENT_RE.exec(req.path || '');
  if (first && isRecipientTrackToken(first[1]) && !recipientLinksLive()) return res.status(404).json({ error: 'Not found' });
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
