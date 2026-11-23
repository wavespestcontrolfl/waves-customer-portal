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

// Decode CONTIGUOUS valid escape runs with decodeURIComponent so
// multibyte UTF-8 sequences (%EF%BC%8E = fullwidth dot) decode to the
// real character instead of byte-wise mojibake; a malformed run is kept
// verbatim, and an unrelated literal percent ("Save 50% today") never
// aborts canonicalization (Codex #3348 x2).
function decodeEscapeRuns(s) {
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try { return decodeURIComponent(run); } catch { return run; }
  });
}

function normalizeForLinkCheck(raw) {
  let out = foldLinkChars(String(raw));
  // The fold reapplies after each decode pass - a decoded fullwidth dot
  // must still become '.'.
  for (let i = 0; i < 3; i++) {
    const decoded = decodeEscapeRuns(out);
    if (decoded === out) break;
    out = foldLinkChars(decoded);
  }
  return out;
}

// The stricter check's forms of a text, for a caller that keeps its own
// host decision (portal-messages.js answerCarriesLink: an office answer
// texted to the customer). The fold above, plus every default-ignorable
// character, tabs and line breaks dropped (a phone shows such a run as
// one link) and lowercase; then, pass after pass, escapes decoded and the
// send step's own form applied (stripSmsUrlScheme, then GSM punctuation:
// the scheme strip can join two parts into one host, as
// "portalhttps://.wavespestcontrol.com" becomes
// "portal.wavespestcontrol.com"), until nothing changes. Returns every
// form, in order (a host seen in any of them counts); null when the text
// still changes after STRICT_LINK_PASSES passes, so the caller fails
// closed.
const STRICT_LINK_PASSES = 12;
function strictLinkViews(raw) {
  const { normalizeGsmPunctuation } = require('./gsm-normalize');
  const fold = (s) => foldLinkChars(s).replace(/[\p{Default_Ignorable_Code_Point}\t\r\n]/gu, '').toLowerCase();
  const views = [fold(String(raw))];
  for (let pass = 0; pass < STRICT_LINK_PASSES; pass += 1) {
    const last = views[views.length - 1];
    const next = fold(normalizeGsmPunctuation(stripSmsUrlScheme(decodeEscapeRuns(last))));
    if (next === last) return views;
    views.push(next);
  }
  return null;
}

module.exports = { stripSmsUrlScheme, normalizeForLinkCheck, strictLinkViews };
