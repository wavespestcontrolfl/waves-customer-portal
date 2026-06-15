function isServiceOutlinePath(reqPath = '') {
  return /^\/service-outlines\/[A-Za-z0-9_-]{43}\/?$/.test(String(reqPath || ''));
}

// Public tokenized lawn diagnostic report — 32-hex token, customer-facing.
function isLawnReportPath(reqPath = '') {
  return /^\/lawn-report\/[a-f0-9]{32}\/?$/.test(String(reqPath || ''));
}

function applySensitiveSpaHeaders(reqPath, res) {
  if (isServiceOutlinePath(reqPath)) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Referrer-Policy', 'no-referrer');
    return;
  }
  if (isLawnReportPath(reqPath)) {
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Cache-Control', 'no-store');
  }
}

module.exports = {
  applySensitiveSpaHeaders,
  isServiceOutlinePath,
  isLawnReportPath,
};
