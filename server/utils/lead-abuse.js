// Shared abuse helpers for the public, unauthenticated intake surfaces — the
// lead webhook, the property lookup (paid satellite + AI), and the quote
// calculator. Keeps the honeypot + submitting-host logic identical everywhere.

// Honeypot: the forms render a hidden, autocomplete-off `fax_number` field real
// users never fill. Any present non-empty value — a non-empty string OR any
// non-string JSON value a bot crafts (number/array/object) — means a bot
// populated it. Only an empty/whitespace string or an absent/null field passes.
function isHoneypotTripped(body) {
  if (!body || body.fax_number === undefined || body.fax_number === null) return false;
  const v = body.fax_number;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

function hostFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch (_e) { return ''; }
}

// The submitting host, used to select the token's owning Turnstile widget secret
// (utils/turnstile). Origin/Referer are browser-set and reliable on the
// cross-origin POST from the astro fleet; fall back to the page URL the client
// already sends in the body.
function resolveSubmitHost(req) {
  const headers = (req && req.headers) || {};
  const body = (req && req.body) || {};
  return hostFromUrl(headers.origin)
    || hostFromUrl(headers.referer)
    || hostFromUrl(body.page_url)
    || hostFromUrl(body.landing_url)
    || hostFromUrl(body.attribution && body.attribution.landing_url)
    || (typeof body.domain === 'string' ? body.domain.toLowerCase() : '');
}

module.exports = { isHoneypotTripped, resolveSubmitHost };
