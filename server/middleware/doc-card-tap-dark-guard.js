/**
 * The receipt and tracker card taps (GATE_DOC_CROSS_SELL, owner 2026-11-21)
 * must read as Not Found while the gate is dark — even for an IP that has
 * exhausted the global /api/ limiter (AGENTS.md: a dark route skips its
 * limiter so a probe never sees a revealing 429). Mounted in server/index.js
 * AHEAD of that limiter, like the payer-statement and lawn-assessment guards.
 * With the gate on it does nothing; the routes' own token gate, eligibility
 * check and per-token limiter apply.
 */
const CARD_TAP_PATH_RE = /^\/[^/]+\/(cross-sell|referral-link)\/?$/;

// Called from inline wrappers in index.js (the public-route scanner must be
// able to prove a mounted handler is not a router).
function docCardTapDarkGuard(notFoundBody, req, res, next) {
  if (req.method === 'POST' && CARD_TAP_PATH_RE.test(req.path || '')
    && !require('../config/feature-gates').isEnabled('docCrossSell')) {
    // The routes' bearer-token privacy headers, on the dark answer too.
    res.set('Cache-Control', 'private, no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Referrer-Policy', 'no-referrer');
    return res.status(404).json(notFoundBody);
  }
  return next();
}

module.exports = { docCardTapDarkGuard };
