const SERVICE_ESTIMATE_SLUGS = require('../config/service-estimate-slugs');

function isServiceOutlinePath(reqPath = '') {
  return /^\/service-outlines\/[A-Za-z0-9_-]{43}\/?$/.test(String(reqPath || ''));
}

// Public tokenized lawn diagnostic report — 32-hex token, customer-facing.
function isLawnReportPath(reqPath = '') {
  return /^\/lawn-report\/[a-f0-9]{32}\/?$/.test(String(reqPath || ''));
}

// Public tokenized post-service report shells: the customer report
// (/report/<32-hex token>) and the project report
// (/report/project/<slug>-<token prefix>). The token is a bearer credential in
// the URL, so these document pages must never be indexed/archived.
function isServiceReportPath(reqPath = '') {
  const value = String(reqPath || '');
  return /^\/report\/[a-f0-9]{32}\/?$/i.test(value)
    || /^\/report\/project\/[a-z0-9-]+\/?$/i.test(value)
    // Recap player carries the same bearer report token in the URL.
    || /^\/recap\/[a-f0-9]{32}\/?$/i.test(value);
}

// Public tokenized customer estimate page. The token is a bearer credential in
// the URL and the page renders the customer's address + quoted pricing, so the
// React-served estimate must carry the same noindex the legacy server-HTML page
// set via its <meta name="robots" content="noindex">. Estimate tokens come in
// multiple formats — 32-hex (randomBytes(16), admin) AND slug-style
// `${nameSlug}-${shortId}` (SMS/lead intake) — so matching a token SHAPE would
// miss formats and leak. Instead, treat ANY single-segment /estimate/<x> as a
// sensitive customer quote EXCEPT the known public marketing service slugs
// (routed to QuotePage). Over-noindexing a marketing page is a minor SEO cost;
// under-noindexing a real estimate leaks address + pricing, so default to
// noindex.
function isEstimatePath(reqPath = '') {
  const match = /^\/estimate\/([^/]+)\/?$/.exec(String(reqPath || ''));
  if (!match) return false;
  return !SERVICE_ESTIMATE_SLUGS.has(match[1].toLowerCase());
}

function applySensitiveSpaHeaders(reqPath, res) {
  if (isServiceOutlinePath(reqPath)) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Referrer-Policy', 'no-referrer');
    return;
  }
  if (isLawnReportPath(reqPath) || isServiceReportPath(reqPath) || isEstimatePath(reqPath)) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
  }
}

module.exports = {
  applySensitiveSpaHeaders,
  isServiceOutlinePath,
  isLawnReportPath,
  isServiceReportPath,
  isEstimatePath,
};
