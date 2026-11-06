/**
 * The record's spelling for a customer name heard in staff dictation.
 *
 * The transcriber can write the common spelling of a name ("Dina") when the
 * customer on screen spells it another way ("Dena"), even with that name at the
 * top of its word list (owner 2026-11-06). respellRecordName() puts the record's
 * spelling back on such a word. This is NOT identity matching
 * (utils/name-match.js owns that, and there a near-spelling is never the same
 * person): the caller already knows which customer the words are about, and
 * this only re-spells the name the words greet that customer by. A word is
 * re-spelled only when every rule holds:
 *   - it greets someone: it follows "Hi", "Hey", "Hello", "Dear", "Thanks",
 *     "Thank you" or "Good morning/afternoon/evening" (a title such as "Mrs"
 *     may sit between), or it is the surname right after such a first name.
 *     A name said in passing ("Tom will come") may be someone else, and a
 *     period ends the greeting except after a title ("Thanks. Don't worry");
 *   - it is not a contraction ("Don't"); a possessive ("Dina's") is a name;
 *   - it is Capitalized (ALL CAPS is an acronym), has 3+ letters, and starts
 *     with the record name's letter and shares its sound code (Soundex over
 *     the whole word, not cut to 4);
 *   - it is one spelling edit from the record name (two when the name has 6+
 *     letters). Adding or dropping a letter counts only for an h or a doubled
 *     letter (Sara / Sarah, Philip / Phillip); any other added letter makes
 *     another name (Eric / Erica, Paul / Paula), so that word stays;
 *   - it is not a word said for something else: `keep` (staff names,
 *     products, services, our cities and pest words), a month or a weekday;
 *   - a greeted first name is not followed by a different surname
 *     ("Hi Dina Smith" greets someone else);
 *   - it is not already one of the record's own name words.
 */
const { normalizeNameFolded } = require('./name-match');

// American Soundex consonant classes. Vowels (and y) separate two letters of one class; h and w do not.
const SOUND_CLASS = Object.freeze({
  b: 1, f: 1, p: 1, v: 1,
  c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
  d: 3, t: 3, l: 4, m: 5, n: 5, r: 6,
});
// Capitalized and one letter from common names (June / Jane, May / Mae).
const CALENDAR_WORDS = new Set([
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);
const GREETINGS = new Set(['hi', 'hey', 'hello', 'dear', 'thanks', 'morning', 'afternoon', 'evening']);
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr']);
// A word: letters, with inner hyphens ("Smith-Jones"). An apostrophe ends it, so "Dina's" is "Dina".
const WORD_RE = /\p{L}+(?:-\p{L}+)*/gu;
const NEXT_WORD_RE = /^[ \t]+(\p{L}+(?:-\p{L}+)*)/u;
const LETTER_RE = /\p{L}/u;
const CAPITALIZED_RE = /^\p{Lu}\p{Ll}/u;
const MIN_LETTERS = 3;
const LONG_NAME_LETTERS = 6;
// What may sit between a greeting and the name: "Hi Dina", "Hi, Dina". A period may follow a title only.
const BETWEEN_WORDS = new Set([' ', '\t', ',']);
// "Don't", "Can't": a contraction is not a name. A possessive is ("Dina's").
const CONTRACTION_RE = /^['\u2019](?!s(?!\p{L}))\p{L}/u;

/** Lowercase, accent-folded letters of each word in `text` (the form every comparison here uses). */
function nameLetters(text) {
  return (String(text || '').match(WORD_RE) || []).map(normalizeNameFolded).filter(Boolean);
}

/** Soundex over the whole word: the first letter, then one digit per run of a consonant class. */
function soundCode(letters) {
  let code = letters.charAt(0);
  let previous = SOUND_CLASS[code] || 0;
  for (const ch of letters.slice(1)) {
    const digit = SOUND_CLASS[ch] || 0;
    if (digit && digit !== previous) code += digit;
    if (ch !== 'h' && ch !== 'w') previous = digit;
  }
  return code;
}

// An h, or a letter next to the same letter: adding or dropping it keeps the name (Sara / Sarah).
function softLetter(word, k) {
  return word[k] === 'h' || word[k] === word[k - 1] || word[k] === word[k + 1];
}

/**
 * True when `a` becomes `b` in at most `max` spelling edits: change a letter, swap two neighbors,
 * or add or drop a soft letter. Adding or dropping any other letter costs more than `max`.
 */
function spellingEdits(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  const addCost = (word, k) => (softLetter(word, k) ? 1 : max + 1);
  let before = null;
  let previous = [0];
  for (let j = 1; j <= b.length; j += 1) previous.push(previous[j - 1] + addCost(b, j - 1));
  for (let i = 1; i <= a.length; i += 1) {
    const row = [previous[0] + addCost(a, i - 1)];
    for (let j = 1; j <= b.length; j += 1) {
      let d = Math.min(previous[j] + addCost(a, i - 1), row[j - 1] + addCost(b, j - 1), previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (before && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2] + 1);
      row.push(d);
    }
    before = previous;
    previous = row;
  }
  return previous[b.length] <= max;
}

// "dena" or "DENA" on the record reads "Dena"; a name with its own capitals ("McDonald") is kept.
function recordSpelling(word) {
  if (/\p{Ll}/u.test(word) && /\p{Lu}/u.test(word)) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** The record's name words worth matching: [{ letters, sound, spelled, first }]. */
function recordWords(firstName, lastName) {
  const words = [];
  for (const [value, first] of [[firstName, true], [lastName, false]]) {
    for (const word of String(value || '').match(WORD_RE) || []) {
      const letters = normalizeNameFolded(word);
      if (letters.length >= MIN_LETTERS) words.push({ letters, sound: soundCode(letters), spelled: recordSpelling(word), first });
    }
  }
  return words;
}

function closeSpelling(letters, name) {
  if (letters.length < MIN_LETTERS || letters === name.letters || letters.charAt(0) !== name.letters.charAt(0)) return false;
  const maxEdits = name.letters.length >= LONG_NAME_LETTERS ? 2 : 1;
  return soundCode(letters) === name.sound && spellingEdits(letters, name.letters, maxEdits);
}

// The word that ends before `index` (only spaces, tabs or commas between): { lower, start, end }. A
// period ends the sentence, so the word before one counts only as a title ("Mrs. Exampleton").
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

// A greeting ends right before `index`, with at most a title between ("Hi Mrs", "Thank you").
function greeted(text, index) {
  let prev = wordBefore(text, index);
  if (TITLES.has(prev.lower)) prev = wordBefore(text, prev.start);
  if (GREETINGS.has(prev.lower)) return true;
  return prev.lower === 'you' && wordBefore(text, prev.start).lower === 'thank';
}

// The word at `index` greets the customer: a name right after a greeting ("Hi Dina", "Hi Mrs
// Exampleton"), or a surname one space after a greeted first name ("Hi Dina Exampleton").
function addressed(text, index, name, names) {
  if (greeted(text, index)) return true;
  if (name.first) return false;
  const prev = wordBefore(text, index);
  if (!/^[ \t]+$/.test(text.slice(prev.end, index))) return false;
  const prevLetters = normalizeNameFolded(prev.lower);
  return names.some((n) => n.first && (prevLetters === n.letters || closeSpelling(prevLetters, n))) && greeted(text, prev.start);
}

// "Hi Dina Smith": a capitalized word right after a greeted first name that is not the record's surname.
function followedByOtherSurname(text, end, surnames) {
  const next = NEXT_WORD_RE.exec(text.slice(end, end + 80));
  if (!next || !CAPITALIZED_RE.test(next[1])) return false;
  const letters = normalizeNameFolded(next[1]);
  return !surnames.some((name) => letters === name.letters || closeSpelling(letters, name));
}

/** The record name word `word` (at `index`) should be spelled as, or null to leave it as heard. */
function respellTarget(text, word, index, names, keep) {
  if (!CAPITALIZED_RE.test(word) || CONTRACTION_RE.test(text.slice(index + word.length, index + word.length + 3))) return null;
  const letters = normalizeNameFolded(word);
  if (CALENDAR_WORDS.has(letters) || keep.has(letters) || names.some((name) => name.letters === letters)) return null;
  const name = names.find((candidate) => closeSpelling(letters, candidate));
  if (!name || !addressed(text, index, name, names)) return null;
  if (name.first && followedByOtherSurname(text, index + word.length, names.filter((n) => !n.first))) return null;
  return name;
}

/**
 * `text` with the greeted customer's name put back to the record's spelling, plus the words
 * changed, in text order: { text, fixes: [{ heard, spelled }] }. `keep` holds lowercase words never
 * changed (nameLetters of staff, product, service and place names).
 */
function respellRecordName(text, { firstName, lastName, keep } = {}) {
  const source = String(text || '');
  const names = recordWords(firstName, lastName);
  if (!source || !names.length) return { text: source, fixes: [] };
  const keepSet = keep instanceof Set ? keep : new Set(keep || []);
  const fixes = [];
  const respelled = source.replace(WORD_RE, (word, index) => {
    const name = respellTarget(source, word, index, names, keepSet);
    if (!name) return word;
    fixes.push({ heard: word, spelled: name.spelled });
    return name.spelled;
  });
  return { text: respelled, fixes };
}

module.exports = { respellRecordName, nameLetters, _private: { soundCode, spellingEdits, greeted } };
