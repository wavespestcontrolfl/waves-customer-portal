/**
 * The record's spelling for the on-screen customer's first name in staff dictation.
 *
 * The transcriber can write another spelling of a first name ("Sarah") when the
 * customer on screen spells it another way ("Sara"), even with that name at the
 * top of its keyword list (owner 2026-11-06). respellRecordName() puts the
 * record's spelling back on a word that is a LISTED spelling of the record's
 * first name: spokenFirstNameSpellings() in utils/name-match.js, the list call
 * identity uses (owner 2026-10-08: listed pairs, no sound-alike rule). An
 * ordinary word is never a listed spelling, so it is never changed. The caller
 * already knows which customer the words are about. A word is re-spelled only
 * when every rule holds:
 *   - it is Capitalized and a listed spelling of a word of the record's first name;
 *   - a greeting opens the text or a sentence and ends right before it: "Hi",
 *     "Hey", "Hello", "Dear", "Thanks", "Thank you" or "Good morning/afternoon/
 *     evening", with at most a title between ("Hi Miss Sarah"). A name said in
 *     passing ("Mark will come") may be someone else;
 *   - the name ends the greeting: the text ends, or punctuation, a line break, a
 *     possessive ("Sarah's") or the record's surname comes next. "Hi Mark Smith"
 *     greets someone else.
 */
const { normalizeNameFolded, spokenFirstNameSpellings } = require('./name-match');

const GREETINGS = new Set(['hi', 'hey', 'hello', 'dear', 'thanks']);
// A greeting only after "Good": "This morning Mark called" names someone in passing.
const TIMES_OF_DAY = new Set(['morning', 'afternoon', 'evening']);
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr']);
// A word: letters, with inner hyphens ("Mary-Kate"). An apostrophe ends it, so "Sarah's" is "Sarah".
const WORD_RE = /\p{L}+(?:-\p{L}+)*/gu;
const LETTER_RE = /\p{L}/u;
const CAPITALIZED_RE = /^\p{Lu}\p{Ll}/u;
// What may sit between a greeting and the name: "Hi Sarah", "Hi, Sarah". A period may follow a title only.
const BETWEEN_WORDS = new Set([' ', '\t', ',']);
// After the name: the end of the text, or punctuation or a line break (spaces may sit between).
const NAME_END_RE = /^[ \t]*(?:$|[,.!?;:\r\n–—-])/u;
const POSSESSIVE_RE = /^['’]s(?!\p{L})/u;
const NEXT_WORD_RE = /^[ \t]+(\p{L}+(?:-\p{L}+)*)/u;

const wordsOf = (value) => String(value || '').match(WORD_RE) || [];

// "sara" or "SARA" on the record reads "Sara"; a name with its own capitals ("McKenzie") is kept.
function recordSpelling(word) {
  if (/\p{Ll}/u.test(word) && /\p{Lu}/u.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

// The words of the record's first name that have other listed spellings: [{ spellings, spelled }].
function respellableFirstNames(firstName) {
  return wordsOf(firstName)
    .map((word) => ({ spellings: spokenFirstNameSpellings(normalizeNameFolded(word)), spelled: recordSpelling(word) }))
    .filter((name) => name.spellings.length);
}

// The word that ends before `index` (only spaces, tabs or commas between): { lower, start, end }. A
// period ends the sentence, so the word before one counts only as a title ("Mrs. Sampleroe").
function wordBefore(text, index) {
  let end = index;
  while (end > 0 && BETWEEN_WORDS.has(text[end - 1])) end -= 1;
  const dotted = text[end - 1] === '.';
  if (dotted) end -= 1;
  let start = end;
  while (start > 0 && LETTER_RE.test(text[start - 1])) start -= 1;
  const lower = text.slice(start, end).toLowerCase();
  return { lower: dotted && !TITLES.has(lower) ? '' : lower, start, end };
}

// Only spaces or tabs lie between `index` and the start of the text or the end of a sentence.
function opensSentence(text, index) {
  const before = text.slice(0, index).replace(/[ \t]+$/, '');
  return before === '' || /[.!?\n]$/.test(before);
}

// A greeting that opens a sentence ends right before `index`, with at most a title between ("Hi
// Miss", "Good morning", "Thank you"). Mid-sentence ("Sounds good, thanks Sarah") is left alone.
function greeted(text, index) {
  let prev = wordBefore(text, index);
  if (TITLES.has(prev.lower)) prev = wordBefore(text, prev.start);
  let opener = prev;
  if (TIMES_OF_DAY.has(prev.lower) || prev.lower === 'you') {
    opener = wordBefore(text, prev.start);
    if (opener.lower !== (prev.lower === 'you' ? 'thank' : 'good')) return false;
  } else if (!GREETINGS.has(prev.lower)) {
    return false;
  }
  return opensSentence(text, opener.start);
}

// The name that ends at `end` closes the greeting: end of text, punctuation, a line break, a
// possessive, or the record's surname next ("Hi Sarah Sampleroe").
function endsGreeting(text, end, surnames) {
  const rest = text.slice(end, end + 80);
  if (NAME_END_RE.test(rest) || POSSESSIVE_RE.test(rest)) return true;
  const next = NEXT_WORD_RE.exec(rest);
  return Boolean(next) && surnames.has(normalizeNameFolded(next[1]));
}

/**
 * `text` with the greeted customer's first name put back to the record's spelling, plus the words
 * changed, in text order: { text, fixes: [{ heard, spelled }] }.
 */
function respellRecordName(text, { firstName, lastName } = {}) {
  const source = String(text || '');
  const names = respellableFirstNames(firstName);
  if (!source || !names.length) return { text: source, fixes: [] };
  const surnames = new Set(wordsOf(lastName).map(normalizeNameFolded));
  const fixes = [];
  const respelled = source.replace(WORD_RE, (word, index) => {
    if (!CAPITALIZED_RE.test(word)) return word;
    const letters = normalizeNameFolded(word);
    const name = names.find((candidate) => candidate.spellings.includes(letters));
    if (!name || !greeted(source, index) || !endsGreeting(source, index + word.length, surnames)) return word;
    fixes.push({ heard: word, spelled: name.spelled });
    return name.spelled;
  });
  return { text: respelled, fixes };
}

module.exports = { respellRecordName, _private: { greeted, endsGreeting } };
