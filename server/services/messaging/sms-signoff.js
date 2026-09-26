'use strict';

// Owner ruling 2026-09-26: customer texts are never signed ("— Adam, Waves
// Pest Control" or any sign-off). Prompts forbid it; this strips a trailing
// sign-off a model adds anyway, or copies from earlier signed history:
//   - a known closer plus signer, same line or not: "Thanks, Adam", "Warm regards, Adam"
//   - ANY short comma-ended valediction on its own line above the signer
//     ("All the best,\nAdam", "Sincerely yours,\nAdam") — the two-line block shape,
//     so a sentence addressed to a customer named Adam ("See you Tuesday, Adam.")
//     is never mistaken for one
//   - a signer set off by a dash or its own line: "— Adam", "\nWaves Pest Control"
//     (not after a colon: "Your technician is:\nAdam" is an answer, not a sign-off)
//   - a full name-and-company block that is its own final sentence:
//     "Talk soon. Adam, Waves Pest Control" (a lone name or company there may
//     answer the sentence before it: "Who will be coming? Adam.")
// even when the whole text is wrapped in quotes or emoji trail the name.
// Signers are the people whose texts the models learn from (Adam, Virginia)
// and the company.
// Not sign-offs, so they stay: "Waves Pest Control here" mid-message,
// "...choosing Waves Pest Control", "Hi Adam, ...", "Your technician is Adam."
// and a closer that ends its own sentence ("Talk soon.").
const DASH = '[-\\u2013\\u2014]{1,2}';
const CLOSER = '(?:thanks|thank\\s+you|best(?:\\s+wishes)?|(?:(?:best|warm|kind)\\s+)?regards|cheers|sincerely|talk\\s+soon|see\\s+you\\s+soon|take\\s+care)';
// Any 1–4 word phrase ending in a comma — only ever matched as its own line.
const VALEDICTION = "\\p{L}[\\p{L}'\\u2019]*(?:\\s+\\p{L}[\\p{L}'\\u2019]*){0,3},";
const COMPANY = '(?:the\\s+)?waves(?:\\s+pest\\s+control)?(?:\\s+team)?';
const PERSON = '(?:adam(?:\\s+(?:benetti|b\\b\\.?))?|virginia)';
const SIGNATURE_BLOCK = `${PERSON}\\s*,?\\s*(?:(?:from|at|with)\\s+)?${COMPANY}`;
const SIGNER = `(?:${SIGNATURE_BLOCK}|${PERSON}|${COMPANY})`;
// A line break that is not the value side of a "Label:" line.
const OWN_LINE = '(?<![:\\s])[ \\t]*\\n\\s*';
// After the signer: optional end punctuation, then only whitespace, quote
// marks or whole emoji sequences — skin tones, ZWJ joins, flags (regional
// indicator pairs and tag sequences) and keycaps.
const EMOJI_PART = '\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|[#*0-9]\\uFE0F?\\u20E3|[\\u{E0020}-\\u{E007F}]|\\uFE0F|\\u200D';
const TAIL = `\\s*[.!]?(?:[\\s"'\\u201C\\u201D\\u2018\\u2019]|${EMOJI_PART})*$`;

// Closer + signer first, so "Best,\nAdam" goes as one unit instead of
// leaving a dangling "Best,".
const SIGNATURE_TAIL_RES = [
  new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE}|\\s*${DASH}\\s*)${CLOSER},?\\s+${SIGNER}${TAIL}`, 'iu'),
  new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE})${VALEDICTION}[ \\t]*\\n\\s*${SIGNER}${TAIL}`, 'iu'),
  new RegExp(`(?:\\s*${DASH}\\s*|${OWN_LINE})${SIGNER}${TAIL}`, 'iu'),
  new RegExp(`(?<=[.!?])\\s+${SIGNATURE_BLOCK}${TAIL}`, 'iu'),
];

const DOUBLE_QUOTES = '"“”';
const SINGLE_QUOTES = "'‘’";
// A quote WRAPPER has no other quote of its kind inside it; a text that merely
// starts and ends with two separate quoted phrases is not one.
const WRAPPED_RE = /^(?:["“]([^"“”]*)["”]|['‘]([^'‘’]*)['’])$/;

function stripOnce(text) {
  return SIGNATURE_TAIL_RES.reduce((current, re) => current.replace(re, ''), text).trim();
}

// A wrapped text's closing quote goes out with the sign-off ('"See you Tuesday.
// - Adam"'), leaving its opener behind. Drop that opener only — never a quote
// that still has its partner, like the one in '"Gold plan" covers ants.'.
function dropOrphanOpener(text, removed) {
  const family = DOUBLE_QUOTES.includes(text[0]) ? DOUBLE_QUOTES
    : SINGLE_QUOTES.includes(text[0]) ? SINGLE_QUOTES : null;
  if (!family || ![...removed].some((ch) => family.includes(ch))) return text;
  const unpaired = family === DOUBLE_QUOTES
    // Double quotes pair up, so an odd count means the opener lost its partner.
    ? [...text].filter((ch) => family.includes(ch)).length % 2 === 1
    // Apostrophes spoil a count; the opener is orphaned unless the text still
    // ends on its partner.
    : text.length === 1 || !family.includes(text[text.length - 1]);
  return unpaired ? text.slice(1).trim() : text;
}

// Returns the text without its trailing sign-off. A text with no sign-off
// comes back exactly as given (quotes and all).
function stripTrailingSignature(message) {
  const original = String(message || '').trim();
  let text = original;
  for (let i = 0; i < 3; i += 1) {
    const next = stripOnce(text);
    if (next === text) break;
    text = next;
  }
  if (text === original) return original;
  // Stripping only ever removes a tail, so the rest of the original is it.
  text = dropOrphanOpener(text, original.slice(text.length));
  const wrapped = WRAPPED_RE.exec(text);
  return wrapped ? (wrapped[1] ?? wrapped[2]).trim() : text;
}

module.exports = { stripTrailingSignature };
