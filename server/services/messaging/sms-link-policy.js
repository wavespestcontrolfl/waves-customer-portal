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
function foldLinkChars(s) {
  let out = s.normalize('NFKC');
  out = out.replace(/[\u3002\uFF0E\uFF61]/g, '.');
  out = out.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  return out;
}

function normalizeForLinkCheck(raw) {
  let out = foldLinkChars(String(raw));
  // Decode CONTIGUOUS valid escape runs with decodeURIComponent so
  // multibyte UTF-8 sequences (%EF%BC%8E = fullwidth dot) decode to the
  // real character instead of byte-wise mojibake; a malformed run is kept
  // verbatim, and an unrelated literal percent ("Save 50% today") never
  // aborts canonicalization (Codex #3348 x2). The fold reapplies after
  // each decode pass - a decoded fullwidth dot must still become '.'.
  for (let i = 0; i < 3; i++) {
    const decoded = out.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try { return decodeURIComponent(run); } catch { return run; }
    });
    if (decoded === out) break;
    out = foldLinkChars(decoded);
  }
  return out;
}

module.exports = { SCHEMELESS_SMS_HOSTS, normalizeForLinkCheck };
