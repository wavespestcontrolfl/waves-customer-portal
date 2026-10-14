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

// Is this tokenless lead POST one the webhook may HOLD for the office
// (services/lead-unverified-hold) instead of refusing? Both conditions are
// independent of the Turnstile secret configuration:
//
//   1. The token is genuinely ABSENT: both token fields are missing, null or
//      a blank string. A non-string value ({} / [] / a number) is a crafted
//      credential, not a slow widget, even though the verifier reads it as
//      empty.
//   2. The browser-set Origin (else Referer) header names a site in the
//      explicit fleet list. Body fields (page_url, landing_url, domain) are
//      caller-supplied and never count, and a catch-all single-secret widget
//      "owning" every host does not count either.
//
// A non-browser client can still forge Origin; what that buys is one
// customer-less lead and one bell per phone per day, inside the rate limits.
function tokenFieldAbsent(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}
function isHoldableTokenlessPost(req) {
  const body = (req && req.body) || {};
  if (!tokenFieldAbsent(body.turnstile_token) || !tokenFieldAbsent(body['cf-turnstile-response'])) return false;
  const headers = (req && req.headers) || {};
  const host = (hostFromUrl(headers.origin) || hostFromUrl(headers.referer)).replace(/^www\./, '');
  // Lazy: spoke-sites pulls the content-astro config, not needed at load.
  const { SPOKE_SITE_KEYS } = require('../services/content-astro/spoke-sites');
  return !!host && SPOKE_SITE_KEYS.includes(host);
}

module.exports = { isHoneypotTripped, resolveSubmitHost, isHoldableTokenlessPost };
