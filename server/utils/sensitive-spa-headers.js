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

function applySensitiveSpaHeaders(reqPath, res) {
  if (isServiceOutlinePath(reqPath)) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Referrer-Policy', 'no-referrer');
    return;
  }
  if (isLawnReportPath(reqPath) || isServiceReportPath(reqPath)) {
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
};
