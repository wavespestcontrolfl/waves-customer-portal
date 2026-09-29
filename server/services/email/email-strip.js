'use strict';

// Strips quoted history and signature blocks from a plain-text email body
// BEFORE it reaches the extractor — the grounding check in sms-operational-
// extractor.js's groundExtraction requires every quoted obligation/fact to
// be a literal substring of the text the model saw, so this must produce
// the SAME text passed as message_body to extractSmsOperations, never a
// second, separately-stripped copy (coordinator correction #7).
//
// Owner diagnostic, 2026-09-29 (production dry run, 9 real emails, 0
// obligations found): real Gmail plain-text bodies do NOT wrap the quoted
// history/signature onto their own lines the way a hand-written fixture
// does — the whole thing (customer's reply, "On ... wrote:", the quoted
// thread, Waves' own multi-line signature) runs together as ONE long
// paragraph with no reliable line breaks, and the "On ... wrote:" marker
// itself is HTML-entity-encoded (`&lt;`/`&gt;` around the quoted sender's
// address). Every marker below is therefore matched INLINE (never
// line-anchored `^...$`), against text that has ALREADY been through
// decodeEntities. A real body ran 10k-20k+ chars raw; without a real cut
// here every one of them blew past extractSmsOperations' 6000-char email
// ceiling and was silently dropped before any model call ever ran.
//
// Heuristic, not exhaustive: erring toward stripping too much only means an
// obligation is missed (the existing "a missed bell is the worse failure"
// posture elsewhere in this codebase is reversed here on purpose — a
// stripped-away sentence never reaches the model, so nothing is captured
// from it; under-stripping risks extracting a quoted OLDER message as if it
// were said today, which is worse). Known gap: an unusual client's quote
// header or a free-form signature this does not recognize passes through
// unstripped; extractSmsOperations' own 600/6000-char body cap and the
// model's own read of "the CURRENT message" are the remaining backstops.
const ENTITIES = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const ENTITY_RE = /&lt;|&gt;|&amp;|&quot;|&#39;|&nbsp;/g;
function decodeEntities(text) {
  return String(text || '').replace(ENTITY_RE, (m) => ENTITIES[m]);
}

// Every pattern is searched INLINE (no `^`/`$` anchors that would require a
// real line break) — matches only its OWN cut point; the earliest match
// across all of them wins.
const CUT_PATTERNS = [
  // Gmail/most clients, weekday OR numeric-date form, decoded-entity email
  // address tolerated: "On Tue, Sep 22, 2026 at 3:21 PM, Jane <jane@x.com>
  // wrote:" / "On 09/09/2026 8:29 AM, Jane <jane@x.com> wrote:". Bounded gap
  // so an unrelated later "wrote:" elsewhere in a long body never anchors here.
  /\bOn\s.{0,150}?\swrote:/i,
  // Outlook: a long underscore rule immediately before the quoted header
  // block, e.g. "________________________________\nFrom: Jane <jane@x.com>".
  /_{10,}\s*From:/i,
  /-{2,}\s*Original Message\s*-{2,}/i,
  /-{2,}\s*Forwarded message\s*-{2,}/i,
  // A quote marker: a line starting with '>' (optional leading whitespace),
  // or an inline " > " — real bodies run the quote marker directly into the
  // "On ... wrote:" text with no line break at all ("...1563 > On 09/09...").
  /(?:^[ \t]*>|[ \t]>[ \t])/m,
  // Waves' own signature block (the office phone line), so a staff reply's
  // own boilerplate never rides along as part of a captured promise's quote.
  /\*?\s*Office:\s*\(941\)/i,
  // RFC 3676 signature delimiter — a line that is exactly "--".
  /^[ \t]*--[ \t]*$/m,
];
// Mobile client sign-off — removed outright (not a cut point: it is
// typically the very last line already, so slicing before it and removing
// it read the same either way, but this stays a removal for a signature
// that appears mid-body on some clients).
const SENT_FROM = /^[ \t]*Sent from my (?:iPhone|iPad|Android|Galaxy|Samsung|Waves).*$/im;

function stripQuotedAndSignature(bodyText) {
  const decoded = decodeEntities(bodyText).replace(/\r\n/g, '\n');
  const indices = CUT_PATTERNS.map((re) => {
    const m = re.exec(decoded);
    return m ? m.index : null;
  }).filter((i) => i != null);
  let text = decoded;
  if (indices.length) {
    const cut = Math.min(...indices);
    // A cut this early would leave almost nothing — likely a misfire on a
    // very short message; keep the whole (decoded) text instead.
    if (cut >= 2) text = decoded.slice(0, cut);
  }
  // A trailing run of '>'-quoted lines the cut above did not reach (a
  // bottom-poster's own new text always precedes these).
  const lines = text.split('\n');
  while (lines.length && /^[ \t]*>/.test(lines[lines.length - 1])) lines.pop();
  text = lines.join('\n').replace(SENT_FROM, '');
  return text.trim();
}

module.exports = { stripQuotedAndSignature, decodeEntities };
