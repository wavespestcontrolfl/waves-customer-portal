// Tokenized public surfaces (pay, receipt, contract, review, reschedule,
// document share) return financial/personal data keyed only by a bearer
// token in the URL. Without explicit headers those responses are cacheable
// by shared browsers and intermediaries and eligible for indexing — the
// reports/tracking routers already set this trio; this middleware is the
// shared version so the remaining token routers match that pattern.
function noStore(req, res, next) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
  next();
}

module.exports = { noStore };
