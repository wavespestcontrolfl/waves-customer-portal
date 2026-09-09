// Owner directive: omit the leading https:// from every SMS link. This is
// display formatting only; URL builders, redirects, email, and provider
// callback/media URLs retain their original schemes.
function stripSmsUrlScheme(body) {
  if (typeof body !== 'string') return body;
  // Consume the entire URL, including an already-bare URL, so a second
  // pass cannot strip a nested https:// inside a signed query or path.
  return body.replace(
    /(?:https?:\/\/|(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+(?=[:/?#]))[^\s<>"']*/giu,
    (url) => url.replace(/^https:\/\//i, ''),
  );
}

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

module.exports = { stripSmsUrlScheme, normalizeForLinkCheck };
