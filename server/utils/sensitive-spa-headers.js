function isServiceOutlinePath(reqPath = '') {
  return /^\/service-outlines\/[A-Za-z0-9_-]{43}\/?$/.test(String(reqPath || ''));
}

function applySensitiveSpaHeaders(reqPath, res) {
  if (!isServiceOutlinePath(reqPath)) return;
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('Referrer-Policy', 'no-referrer');
}

module.exports = {
  applySensitiveSpaHeaders,
  isServiceOutlinePath,
};
