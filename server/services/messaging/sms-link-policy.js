/**
 * Hosts whose links go BARE (scheme-less) in SMS — owner directive
 * 2026-08-01: dropping "https://" saves 8 characters per link and SMS
 * clients autolink a bare domain they recognize. Deliberately scoped to
 * hosts we own; every third-party link keeps its scheme (an unfamiliar
 * bare host may not render tappable).
 *
 * Single source of truth: the SMS template renderer
 * (routes/admin-sms-templates.js stripPortalUrlScheme) strips schemes with
 * this list, and comms-lint exempts the same hosts from its bare-host
 * rule — importing from here is what keeps the renderer and the lint from
 * ever disagreeing about which side of the rule a host is on.
 */
const SCHEMELESS_SMS_HOSTS = [
  'portal.wavespestcontrol.com',
  'waves-customer-portal-production.up.railway.app',
];

// Textual link checks miss hosts hidden behind encodings that a URL parser
// (or a tapping thumb) canonicalizes back to the real hostname: `bit%2ely`,
// fullwidth `ｂｉｔ．ｌｙ`, ideographic-dot `bit。ly`, zero-width joins
// (codex PR P1, originally in rain-out.js — moved here so every SMS link
// check shares one canonicalizer). NFKC fold, unicode dot forms → '.',
// zero-width chars stripped, then bounded percent-decode.
function normalizeForLinkCheck(raw) {
  let out = String(raw).normalize('NFKC');
  out = out.replace(/[\u3002\uFF0E\uFF61]/g, '.');
  out = out.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  for (let i = 0; i < 3; i++) {
    let decoded;
    try { decoded = decodeURIComponent(out); } catch { break; }
    if (decoded === out) break;
    out = decoded;
  }
  return out;
}

module.exports = { SCHEMELESS_SMS_HOSTS, normalizeForLinkCheck };
