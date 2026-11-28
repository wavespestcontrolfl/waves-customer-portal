const { noStore } = require('./no-store');

// A path segment that does not percent-decode (`/%E0%A4%A`) makes Express throw while it decodes the route param. The error
// handler then logs the raw segment (a bearer token, on these mounts) and answers 500. Mounted in server/index.js on the token
// mounts BEFORE the global /api/ limiter, this answers the generic 404 a LIVE well-formed unknown token gets on the mount
// instead (same body and headers), so the request is never counted, never logged, and never reads differently from a
// malformed token. Only a path that cannot decode is touched: every other request calls next().
const NOT_FOUND = {
  '/api/estimates': { error: 'Estimate not found' },
  '/api/pay': { error: 'Invoice not found' },
  '/api/public/secure-card': { error: 'Not found' }, // its privacy headers are stamped by the mount just above this one
  '/api/public/estimates': { error: 'Not found' },
  '/api/public/reschedule': { error: 'Not found' },
  '/api/public/reservice': { error: 'Not found' },
};

// The one generic header pair an undecodable-path answer carries on every mount, whichever guard answers it (this one or a
// route's own dark guard): a cache must never keep a URL with a bearer token in it. A header an earlier guard already stamped
// (the secure-card or map privacy set) stays.
function stampUndecodablePathHeaders(res) {
  if (!res.get('Cache-Control')) res.set('Cache-Control', 'no-store');
  if (!res.get('Referrer-Policy')) res.set('Referrer-Policy', 'no-referrer');
}

function rejectUndecodablePath(req, res, next) {
  // Express matches a mount case-insensitively and keeps the request's casing in baseUrl: look the mount up lower-cased.
  const base = req.baseUrl.toLowerCase().replace(/\/+$/, '');
  const body = NOT_FOUND[base];
  if (!body) return next();
  try { decodeURIComponent(req.path); } catch {
    // /api/pay/statement has its own router and its own error answer.
    if (base === '/api/pay' && /^\/statement(\/|$)/i.test(req.path)) return next();
    if (base === '/api/pay') return noStore(req, res, () => res.status(404).json(body));
    stampUndecodablePathHeaders(res);
    return res.status(404).json(body);
  }
  return next();
}

module.exports = { rejectUndecodablePath, stampUndecodablePathHeaders };
