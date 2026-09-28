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
// When the customer shares a signer's first name, that name after a closer or
// on its own line may be how the text addresses them ("See you soon, Adam."),
// so those ambiguous forms skip it. A dash-set name ("- Adam") and a full
// name-and-company block are sign-offs whoever the customer is.
const SIGNER = `(?:${SIGNATURE_BLOCK}|${PERSON}|${COMPANY})`;
function buildSignatureTailRes(addresseeKey) {
  const people = Object.entries(PEOPLE).filter(([key]) => key !== addresseeKey).map(([, re]) => re);
  const ambiguousSigner = `(?:${SIGNATURE_BLOCK}|${people.length ? `(?:${people.join('|')})|` : ''}${COMPANY})`;
  return [
    new RegExp(`${DASH_SIGNOFF}${CLOSER},?\\s+${SIGNER}${TAIL}`, 'iu'),
    new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE})${CLOSER},?\\s+${ambiguousSigner}${TAIL}`, 'iu'),
    // A signer's own name is never the valediction ("Adam,\nVirginia" lists names).
    new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE})(?!${SIGNER}\\s*,)${VALEDICTION}[ \\t]*\\n\\s*${ambiguousSigner}${TAIL}`, 'iu'),
    new RegExp(`${DASH_SIGNOFF}${SIGNER}${TAIL}`, 'iu'),
    new RegExp(`${AFTER_SENTENCE_LINE}${ambiguousSigner}${TAIL}`, 'iu'),
    new RegExp(`(?:^|(?<=[.!?])\\s+)${SIGNATURE_BLOCK}${TAIL}`, 'iu'),
  ];
}
const SIGNATURE_TAIL_RES = { '': buildSignatureTailRes('') };
for (const key of Object.keys(PEOPLE)) SIGNATURE_TAIL_RES[key] = buildSignatureTailRes(key);

// Opt-in `anySigner`: a sign-off by a name the patterns above do not know
// ("— Sarah", "Thanks,\nSarah", "Talk soon!\nSarah"), for callers whose text a
// model writes from arbitrary input. A bare capitalized final line is not
// enough on its own — "Call Today", "Schedule Online" and "Reply YES" have the
// same shape as "Sarah Jones" — so only sign-off-marked shapes count:
//  - a dash-set name: the dash starts its own line (not under a value word,
//    trailing spaces included: "Your technician is \n— Sarah" is an answer),
//    follows a sentence ending in . or ! on the same line, or is the whole
//    text. The name is one word in any case or script, or two capitalized
//    words on one line, optionally ", <Company>" in capitalized words or
//    "from Waves";
//  - a known closer on its own line with the name under it ("Thanks,\nSarah")
//    — a closer from CLOSER, never any comma-ended line ("Here are the
//    options,\nLawn Care" is a list);
//  - a name alone on the last line right under a closer line ("Talk
//    soon!\nSarah"): the closer line stays, the name goes;
//  - a closer and the name on one line ("We can help. Thanks, Sarah") only
//    when the customer's first name is known and is not that name — thanking
//    the customer by name looks the same.
// A name that is the customer's own first name is the addressee, so it stays;
// a dash after a question on the same line may be the answer, so it stays too.
// The patterns below are compiled without `i` (under it \p{Lu} also matches
// lowercase, and "Tuesday works" would read as a capitalized name), so the
// lowercase-only word lists are made case-insensitive by hand.
function anyCase(source) {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { out += ch + source[i + 1]; i += 1; } else if (/[a-z]/.test(ch)) out += `[${ch}${ch.toUpperCase()}]`;
    else out += ch;
  }
  return out;
}
const ANY_TOKEN = "\\p{L}[\\p{L}'\\u2019-]*";
const CAP_TOKEN = "\\p{Lu}[\\p{L}'\\u2019-]*";
// After the name: ", Waves Team" in capitalized words, or the company joined
// by from/at/with ("— Sarah from Waves") as SIGNATURE_BLOCK joins it.
// A signature is one line, so the name's words and this suffix are joined by
// spaces only: a line break never makes "- Lawn Care\nTuesday" or "- Lawn
// Care,\nTuesday" a name. Two name words at most: "Call Us Today" and
// "Schedule Online Today" have a three-word name's shape.
const CAP_COMPANY = `(?:[ \\t]*,[ \\t]*${CAP_TOKEN}(?:[ \\t]+${CAP_TOKEN}){0,3}|[ \\t]+${anyCase(`(?:from|at|with)[ \\t]+${COMPANY}`)})?`;
const CAP_NAME = `(?<name>${CAP_TOKEN}(?:[ \\t]+${CAP_TOKEN})?)${CAP_COMPANY}`;
const DASH_NAME = `(?<name>${CAP_TOKEN}[ \\t]+${CAP_TOKEN}|${ANY_TOKEN})${CAP_COMPANY}`;
const VALUE_WORD = anyCase('(?:is|are|was|were|be|as|named|called|by)');
const ANY_CLOSER = anyCase(CLOSER);
// mode: 'always' strips regardless of the customer; 'keepAddressee' keeps the
// customer's own first name; 'otherThanAddressee' strips only when the
// customer's first name is known and differs.
const ANY_SIGNER_RES = [
  // (?<![ \t]) starts the line-break alternative at the first trailing space,
  // so the value-word lookbehind sees the word itself, not a space after it.
  { re: new RegExp(`(?:^|(?<=[.!]["'\\u201D\\u2019]?)[ \\t]*|(?<!\\b${VALUE_WORD}[ \\t]*)(?<![ \\t])[ \\t]*\\n\\s*)${DASH}\\s*${DASH_NAME}${TAIL}`, 'u'), mode: 'always' },
  { re: new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE})${ANY_CLOSER},?[ \\t]*\\n\\s*${CAP_NAME}${TAIL}`, 'u'), mode: 'keepAddressee' },
  { re: new RegExp(`(?<=(?:^|[.!?\\n])\\s*${ANY_CLOSER}[!.]?)[ \\t]*\\n\\s*${CAP_NAME}${TAIL}`, 'u'), mode: 'keepAddressee' },
  { re: new RegExp(`(?:^|(?<=[.!?])\\s+|${OWN_LINE})${ANY_CLOSER},?[ \\t]+${CAP_NAME}${TAIL}`, 'u'), mode: 'otherThanAddressee' },
];
// A dash can also set a value on its own line: under a label ("Your
// technician:\n— Sarah", "Which service:\n— Lawn Care"), under an information
// question ("Who will be coming?\n— Sarah", "Where are you located?\n—
// Lakewood Ranch") or as the next item of a dashed or bulleted list. Such a
// text keeps its tail through both passes. Under a question a Waves signer
// (Adam, Virginia, the company) is the exception: a dashed Waves name after
// any question is a sign-off, as it is for every other caller ("When works
// best for you?\n— Adam", "Who will be coming?\n— Adam"). A yes/no closing
// question ("Would you like to schedule?\n— Sarah") takes no dashed answer,
// and a dashed line set off by a blank line or carrying a company ("— Adam,
// Waves Pest Control") is never one.
const WH_QUESTION = anyCase('(?:who|whom|whose|what|which|where|when|why|how)');
const WAVES_SIGNER = anyCase(SIGNER);
const DASHED_LINE = `\\n[ \\t]*${DASH}[ \\t]*`;
const DASH_VALUE_TAIL_RE = new RegExp(
  `(?:^|\\n)(?:(?:[^\\n]*:[ \\t]*|[ \\t]*(?:${DASH}|[\\u2022*])[^\\n]*)${DASHED_LINE}`
  + `|[^\\n]*\\b${WH_QUESTION}\\b[^.!?\\n]*\\?[ \\t]*${DASHED_LINE}(?!${WAVES_SIGNER}${TAIL}))`
  + `(?:${CAP_TOKEN}[ \\t]+${CAP_TOKEN}|${ANY_TOKEN})${TAIL}`,
  'u',
);

function stripAnySignerOnce(text, addresseeFirstName) {
  const addressee = String(addresseeFirstName || '').trim().toLowerCase();
  return ANY_SIGNER_RES.reduce((current, { re, mode }) => current.replace(re, (...args) => {
    const { name } = args[args.length - 1];
    const isAddressee = Boolean(addressee) && String(name || '').split(/\s+/)[0].toLowerCase() === addressee;
    if (mode === 'keepAddressee' && isAddressee) return args[0];
    if (mode === 'otherThanAddressee' && (!addressee || isAddressee)) return args[0];
    return '';
  }), text).trim();
}

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

// A whole text that only thanks the customer by their own name ("Thanks,
// Adam!" to a customer named Adam) is the message, not a sign-off.
const THANKS_BY_NAME_RES = Object.fromEntries(Object.entries(PEOPLE).map(([key, re]) => [
  key,
  new RegExp(`^(?:thanks(?:\\s+again)?|many\\s+thanks|thank\\s+you),?\\s+${re}${TAIL}`, 'iu'),
]));

// Returns the text without its trailing sign-off. A text with no sign-off
// comes back exactly as given (quotes and all). Pass the customer's first
// name when known, so a text addressed to a customer named Adam keeps it,
// and `anySigner: true` to also strip a dash sign-off by any name (above).
function stripTrailingSignature(message, { addresseeFirstName, anySigner = false } = {}) {
  const key = addresseeKey(addresseeFirstName);
  const res = SIGNATURE_TAIL_RES[key];
  const original = String(message || '').trim();
  if (key && THANKS_BY_NAME_RES[key].test(original)) return original;
  let text = original;
  // Checked before each pass on the text that pass sees: stripping a
  // signature can expose a dashed value ("Options:\n- Lawn Care\n\n— Adam").
  const keepsValue = (t) => anySigner && DASH_VALUE_TAIL_RE.test(t);
  for (let i = 0; i < 3; i += 1) {
    let next = keepsValue(text) ? text : stripOnce(text, res);
    if (anySigner && !keepsValue(next)) next = stripAnySignerOnce(next, addresseeFirstName);
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
