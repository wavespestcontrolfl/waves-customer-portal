'use strict';

// Owner ruling 2026-09-26: customer texts are never signed ("— Adam, Waves
// Pest Control" or any sign-off). Prompts forbid it; this strips a trailing
// sign-off a model adds anyway, or copies from earlier signed history:
//   - a known closer plus signer, same line or not: "Thanks, Adam", "Warm regards, Adam",
//     "All the best, Adam", "Sincerely yours, Adam"
//   - ANY short comma-ended valediction on its own line above the signer
//     ("All the best,\nAdam", "Sincerely yours,\nAdam") — the two-line block shape,
//     so a sentence addressed to a customer named Adam ("See you Tuesday, Adam.")
//     is never mistaken for one
//   - a signer set off by a dash: "— Adam" (not after "is"/"as" and the like:
//     "Your technician is - Adam" is an answer)
//   - a signer on its own line under a FINISHED sentence (ends in . or ! or an
//     emoji): "Talk soon!\nAdam". After a question, a colon or an unfinished
//     sentence the name is the answer ("Who will be coming?\nAdam",
//     "Your technician will be\nAdam", "Your technician is:\nAdam").
//   - a full name-and-company block that is its own final sentence:
//     "Talk soon. Adam, Waves Pest Control", or the whole text (a lone name or company there may
//     answer the sentence before it: "Who will be coming? Adam.")
// even when the whole text is wrapped in quotes or emoji or a keyboard
// emoticon (":)") trail the name.
// Signers are the people whose texts the models learn from (Adam, Virginia)
// and the company.
// Not sign-offs, so they stay: "Waves Pest Control here" mid-message,
// "...choosing Waves Pest Control", "Hi Adam, ...", "Your technician is Adam."
// and a closer that ends its own sentence ("Talk soon.").
const DASH = '[-\\u2013\\u2014]{1,2}';
const CLOSER = '(?:thanks(?:\\s+again)?|many\\s+thanks|thank\\s+you|all\\s+the\\s+best|best(?:\\s+wishes)?|warm(?:est)?\\s+wishes|(?:(?:best|warm|kind(?:est)?)\\s+)?regards|cheers|sincerely(?:\\s+yours)?|yours\\s+(?:truly|sincerely)|warmly|respectfully|with\\s+(?:gratitude|thanks|appreciation)|talk\\s+soon|see\\s+you\\s+soon|take\\s+care)';
// Any 1–4 word phrase ending in a comma — only ever matched as its own line.
// Words are joined by spaces only, so it can never reach up into the line above.
const VALEDICTION = "\\p{L}[\\p{L}'\\u2019]*(?:[ \\t]+\\p{L}[\\p{L}'\\u2019]*){0,3},";
const COMPANY = '(?:the\\s+)?waves(?:\\s+pest\\s+control)?(?:\\s+team)?';
const PEOPLE = {
  adam: 'adam(?:\\s+(?:benetti|b\\b\\.?))?',
  virginia: 'virginia',
};
const PERSON = `(?:${Object.values(PEOPLE).join('|')})`;
const SIGNATURE_BLOCK = `${PERSON}\\s*,?\\s*(?:(?:from|at|with)\\s+)?${COMPANY}`;
// A line break that is not the value side of a "Label:" line.
const OWN_LINE = '(?<![:\\s])[ \\t]*\\n\\s*';
// After the signer: optional end punctuation, then only whitespace, quote
// marks or whole emoji sequences — skin tones, ZWJ joins, flags (regional
// indicator pairs and tag sequences) and keycaps.
const EMOJI_PART = '\\p{Extended_Pictographic}|\\p{Emoji_Modifier}|\\p{Regional_Indicator}|[#*0-9]\\uFE0F?\\u20E3|[\\u{E0020}-\\u{E007F}]|\\uFE0F|\\u200D';
// Keyboard emoticons: :) :-) ;) :D :P =) <3 ^^ and the like.
const EMOTICON = "[:;=8]['\\-^]?[)(\\]\\[DPp3*|/]+|<3+|\\^_?\\^";
const TAIL = `\\s*[.!]?(?:[\\s"'\\u201C\\u201D\\u2018\\u2019]|${EMOJI_PART}|${EMOTICON})*$`;
// A line break under a finished sentence: the line above ends in . or ! (a
// quote mark may close it) or an emoji. A bare name after anything else
// answers that line instead of signing it.
const AFTER_SENTENCE_LINE = `(?<=(?:[.!]["'\\u201D\\u2019]?|${EMOJI_PART}))[ \\t]*\\n\\s*`;

// A dash right after a word that introduces a value ("Your technician is -
// Adam", "The charge appears as - Waves Pest Control") sets off the answer.
const DASH_SIGNOFF = `(?<!\\b(?:is|are|was|were|be|as|named|called|by)\\s*)\\s*${DASH}\\s*`;

// Closer + signer first, so "Best,\nAdam" goes as one unit instead of
// leaving a dangling "Best,".
// When the customer shares a signer's first name, that name alone is how the
// text addresses them ("See you soon, Adam."), so it is no bare signer; a
// full name-and-company block still is.
function buildSignatureTailRes(addresseeKey) {
  const people = Object.entries(PEOPLE).filter(([key]) => key !== addresseeKey).map(([, re]) => re);
  const signer = `(?:${SIGNATURE_BLOCK}|${people.length ? `(?:${people.join('|')})|` : ''}${COMPANY})`;
  return [
    new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE}|${DASH_SIGNOFF})${CLOSER},?\\s+${signer}${TAIL}`, 'iu'),
    // A signer's own name is never the valediction ("Adam,\nVirginia" lists names).
    new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE})(?!(?:${SIGNATURE_BLOCK}|${PERSON}|${COMPANY})\\s*,)${VALEDICTION}[ \\t]*\\n\\s*${signer}${TAIL}`, 'iu'),
    new RegExp(`(?:${DASH_SIGNOFF}|${AFTER_SENTENCE_LINE})${signer}${TAIL}`, 'iu'),
    new RegExp(`(?:^|(?<=[.!?])\\s+)${SIGNATURE_BLOCK}${TAIL}`, 'iu'),
  ];
}
const SIGNATURE_TAIL_RES = { '': buildSignatureTailRes('') };
for (const key of Object.keys(PEOPLE)) SIGNATURE_TAIL_RES[key] = buildSignatureTailRes(key);

function addresseeKey(firstName) {
  const key = String(firstName || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PEOPLE, key) ? key : '';
}

const DOUBLE_QUOTES = '"“”';
const SINGLE_QUOTES = "'‘’";
// A quote WRAPPER has no other quote of its kind inside it; a text that merely
// starts and ends with two separate quoted phrases is not one.
const WRAPPED_RE = /^(?:["“]([^"“”]*)["”]|['‘]([^'‘’]*)['’])$/;

function stripOnce(text, res) {
  return res.reduce((current, re) => current.replace(re, ''), text).trim();
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

// A whole text that only thanks someone by name ("Thanks, Adam!") is talking
// to a customer with that name, not signing off.
const THANKS_BY_NAME_RE = new RegExp(`^(?:thanks(?:\\s+again)?|many\\s+thanks|thank\\s+you),?\\s+${PERSON}${TAIL}`, 'iu');

// Returns the text without its trailing sign-off. A text with no sign-off
// comes back exactly as given (quotes and all). Pass the customer's first
// name when known, so a text addressed to a customer named Adam keeps it.
function stripTrailingSignature(message, { addresseeFirstName } = {}) {
  const res = SIGNATURE_TAIL_RES[addresseeKey(addresseeFirstName)];
  const original = String(message || '').trim();
  if (THANKS_BY_NAME_RE.test(original)) return original;
  let text = original;
  for (let i = 0; i < 3; i += 1) {
    const next = stripOnce(text, res);
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
