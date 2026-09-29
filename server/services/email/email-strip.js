'use strict';

// Strips quoted history and signature blocks from a plain-text email body
// BEFORE it reaches the extractor — the grounding check in sms-operational-
// extractor.js's groundExtraction requires every quoted obligation/fact to
// be a literal substring of the text the model saw, so this must produce
// the SAME text passed as message_body to extractSmsOperations, never a
// second, separately-stripped copy (coordinator correction #7).
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
const QUOTE_HEADERS = [
  /^\s*On .{0,120}wrote:\s*$/im, // Gmail/most clients: "On Mon, Sep 28, 2026 at 3:00 PM, Jane <jane@x.com> wrote:"
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im, // Outlook
  /^\s*-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  /^\s*From:\s*.+\nSent:\s*.+\nTo:\s*.+/im, // Outlook's header block with no "On ... wrote:" line
];
const SIG_DELIMITER = /^\s*--\s*$/m; // RFC 3676 signature delimiter
const SENT_FROM = /^\s*Sent from my (?:iPhone|iPad|Android|Galaxy|Samsung|Waves).*$/im;

function stripQuotedAndSignature(bodyText) {
  let text = String(bodyText || '').replace(/\r\n/g, '\n');
  for (const header of QUOTE_HEADERS) {
    const match = header.exec(text);
    if (match) text = text.slice(0, match.index);
  }
  // A trailing run of '>'-quoted lines the header cut above did not catch
  // (a bottom-poster's own new text always precedes these).
  const lines = text.split('\n');
  while (lines.length && /^\s*>/.test(lines[lines.length - 1])) lines.pop();
  text = lines.join('\n');
  const sig = SIG_DELIMITER.exec(text);
  if (sig) text = text.slice(0, sig.index);
  text = text.replace(SENT_FROM, '');
  return text.trim();
}

module.exports = { stripQuotedAndSignature };
