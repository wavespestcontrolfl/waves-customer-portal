// Owner ruling (Adam, 2026-07-30): no emojis in admin notification titles or
// bodies — the notification icon column carries the pictogram; emoji inside
// the text is noise. Shared by notification-service.js (bell rows) and
// notification-triggers.js (Web Push payloads) so every admin surface renders
// the same clean text. Strips the emoji blocks plus variation selectors and
// zero-width joiners, then tidies the whitespace left behind. Deliberately
// leaves arrows, dashes, and other plain typography alone.
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

function stripEmoji(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(EMOJI_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+|[ \t]+$/gm, '');
}

module.exports = { stripEmoji };
