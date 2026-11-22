/**
 * The same-order check for a tidied technician note (owner 2026-11-21, *same
 * order*): is a text the note's own words, in the note's order?
 *
 * A report's text is the note the technician gave, tidied by a model (a later
 * PR). orderRejection(text, note, screen) answers null when
 *   - every word of the text is a word of the note, in the note's order, or
 *     one of a few small words the grammar needs;
 *   - the text has one sentence for each sentence of the note it keeps: none
 *     joined, none cut, a question still a question;
 *   - what the text leaves out is a small word, or what the report's screens
 *     refuse: a word, two words together, or a whole part of the note.
 * It reads the two strings and nothing else about the visit, and it holds no
 * list of what a report may not say. That is the caller's `screen`:
 *   wordGoes(word)           may this one word of the note go?
 *   pairGoes(first, second)  do these two words go together, or not at all
 *                            ("no issues", a figure and its unit)?
 *   partGoes(part)           may this whole part of the note go?
 *   names                    the product names the note holds
 * report-own-note.js builds it from the report's own screens (the next PR),
 * so what may go is what no report text may hold. Nothing calls this module
 * yet.
 *
 * Known limits, by design (the technician reads the text before it is sent):
 *   - a typing or dictation error stays as written, unless ALSO_WRITTEN
 *     knows it;
 *   - a note with no marks is one sentence and one part: the text is one
 *     sentence, and a remark for the office inside it cannot be left out, so
 *     the caller falls back to its fixed sentence;
 *   - a part the screens refuse goes whole, with what else it says ("found
 *     rats by the gate");
 *   - the check does not ask how the rest reads without what went, past the
 *     words in NEVER_LEFT_OUT and the rule for a part that opens with a
 *     condition;
 *   - a present-tense note reads as work done ("treat shed" as "I treated
 *     the shed"): technicians write both ways;
 *   - a name is no person to the check: "Sam and I sprayed" passes where
 *     "the neighbor and I sprayed" does not.
 */

// ── The words ──────────────────────────────────────────────────────────
// Small words the text may add where the grammar needs them. "I" has its
// own rule (addedWordAllowed). Not "have": "ants in kitchen" is not "I have
// ants in the kitchen".
const ADDABLE = new Set('the a an and also was were is are it there'.split(' '));
// Small words the text may leave out: an article, a pointer, a form of "is"
// (the text may change the tense), a joining word, a filler. Not "have",
// "had", "do", "to", "been" or "of": "had to treat" is not "treated".
const SMALL = new Set('a an the this that these those it its am is are was were and also then too um uh'.split(' '));
// Words the text never leaves out by themselves: a denial, a plan, a
// condition, a doubt, a person. Leaving one out changes what the note says.
const NEVER_LEFT_OUT = new Set(`no not never none nothing nowhere neither nor without cannot will would should shall need needs
recommend recommends recommended next plan plans customer cust homeowner client tenant owner resident wife husband she he
if unless until except or but only before after may might could can maybe probably likely want wants wanted
i we you they them their`.split(/\s+/));
// A word that only leads into what goes, goes with it: "in" before "two
// weeks", "with" before a product name. So does "of" right after it ("2
// gallons of bait").
const LEAD_INS = new Set('in for at on by with of about within every per each'.split(' '));
// The text adds "I" only where a clause starts: as the first word of a
// sentence, after a comma, or after one of these. "You said I saw roaches"
// is not "customer said saw roaches".
const CLAUSE_OPENERS = new Set('and so but then because when while since'.split(' '));
// A part that opens with a condition qualifies the rest of its sentence
// ("if ants return, ...", "..., unless it rains"). A condition further in
// belongs to its own part ("keep pets off until dry").
const CONDITIONS = new Set(['if', 'unless', 'until', 'except']);
const CONDITION_LEADS = new Set('but only or even not so'.split(' '));
// The parts tried out of sight one set at a time (64 walks at most).
const MAX_HIDDEN_PARTS = 6;
const NOTHING_GOES = () => false;
// A part that names only places may open with "I serviced".
const PLACES = new Set(`kitchen garage bathroom bathrooms bath baths exterior interior ext int outside inside perimeter perim lanai
attic yard front back side sides eaves house home only both master laundry bedroom bedrooms porch patio pool cage shed fence
driveway`.split(/\s+/));
const PERSONS = new Set(`customer cust you she he they we homeowner client tenant owner resident wife husband son daughter
neighbor neighbors landlord manager`.split(/\s+/));
// A word of the note and what the text may write for it: a technician's short
// form and its full word, the customer as "you", and what phone dictation
// writes for a word of the trade.
const ALSO_WRITTEN = new Map(Object.entries({
  cust: ['customer', 'you'], customer: ['you'], homeowner: ['you'], client: ['you'], tenant: ['you'],
  she: ['you'], he: ['you'], they: ['you'], them: ['you'], her: ['you', 'your'], his: ['your'], their: ['your'],
  ext: ['exterior', 'outside'], int: ['interior', 'inside'], perim: ['perimeter'],
  roach: ['cockroach'], roaches: ['cockroaches'], cockroach: ['roach'], cockroaches: ['roaches'], bath: ['bathroom'], fridge: ['refrigerator'],
  said: ['told'], says: ['said', 'told'],
  eves: ['eaves'], cinch: ['chinch'], pimento: ['palmetto'], pomento: ['palmetto'],
}));
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const NUMBER_TWINS = new Map(NUMBER_WORDS.flatMap((word, n) => [[word, String(n)], [String(n), word]]));
// Forms the suffix rules below cannot reach, each with its base word.
const SAME_WORD = new Map(Object.entries({
  saw: 'see', seen: 'see', found: 'find', told: 'tell', said: 'say', left: 'leave', caught: 'catch', swept: 'sweep',
  laid: 'lay', mice: 'mouse', has: 'have', had: 'have',
}));

// The same word in another form gets the same stem: "sprayed", "spraying" and
// "sprays". A stem is a key, not a word.
function ruleStem(word) {
  let stem = word;
  if (stem.length > 4 && stem.endsWith('ies')) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 4 && /(?:ch|sh|x|z|ss)es$/.test(stem)) stem = stem.slice(0, -2);
  else if (stem.length > 3 && stem.endsWith('s') && !stem.endsWith('ss')) stem = stem.slice(0, -1);
  if (stem.length > 5 && stem.endsWith('ing') && /[aeiouy]/.test(stem.slice(0, -3))) stem = stem.slice(0, -3);
  else if (stem.length > 4 && stem.endsWith('ied')) stem = `${stem.slice(0, -3)}y`;
  else if (stem.length > 4 && stem.endsWith('ed')) stem = stem.slice(0, -2);
  if (stem.length > 3 && stem.endsWith('e')) stem = stem.slice(0, -1);
  return stem.replace(/([b-df-hj-np-tv-z])\1$/, '$1');
}
const stemOf = (word) => ruleStem(SAME_WORD.get(word) || word);

// Words as the check reads them: lower case, "didn't" as "did not", "she's
// been" as "she has been", "I'd" as "I would" (never dropped: "I'd treat" is
// not "I treated"), a possessive dropped, "1,200" as 1200, "1.5" as one word
// that is not 15, split on anything that is not a letter or a digit.
function noteWords(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'")
    .replace(/(\p{N}),(?=\p{N}{3}(?!\p{N}))/gu, '$1').replace(/(\p{N})\.(?=\p{N})/gu, '$1point')
    .replace(/\bcan't\b|\bcannot\b/g, 'can not').replace(/\bwon't\b/g, 'will not').replace(/n't\b/g, ' not')
    .replace(/'ll\b/g, ' will').replace(/'d\b/g, ' would')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s (been|got)\b/g, '$1 has $2')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s\b/g, '$1 is')
    .replace(/\b(you|we|they|i)'ve\b/g, '$1 have')
    .replace(/'(?:ve|re|m|s)\b/g, ' ')
    .match(/[\p{L}\p{N}]+/gu) || [];
}
const isCount = (word) => /\p{N}/u.test(word) || NUMBER_WORDS.includes(word);

// A denial, a condition, a doubt or a pronoun is the same word only as
// written: a stem would make "note" the word "not".
const WRITTEN_EXACT = new Set(`no not never none nothing nowhere neither nor without will would should shall
if unless until except or but only before after may might could can maybe probably likely
i we you they them their it`.split(/\s+/));

// A word of the text is a word of the note: the same word, what the note's
// word may be written as, a count written the other way, or another form of
// the word (never for a count or a WRITTEN_EXACT word). A spelling the list
// above does not know stays as the technician wrote it.
function sameWord(textWord, noteWord) {
  if (textWord === noteWord) return true;
  if ((ALSO_WRITTEN.get(noteWord) || []).some((written) => written === textWord || stemOf(written) === stemOf(textWord))) return true;
  if (NUMBER_TWINS.get(noteWord) === textWord) return true;
  if ([textWord, noteWord].some((word) => WRITTEN_EXACT.has(word) || isCount(word))) return false;
  return stemOf(textWord) === stemOf(noteWord);
}

// ── The note, read ─────────────────────────────────────────────────────
// A colon ends no part: what follows a label goes with it ("billing: ...").
const PART_MARKS = /,+/;
// A mark inside a number ends no sentence and no part ("2.5 gallons"): it is
// hidden while the text is split, and put back in each piece.
const hideNumberMarks = (text) => String(text || '').replace(/(\p{N})([.,])(?=\p{N})/gu, (_, digit, mark) => `${digit}${mark === '.' ? '\u0001' : '\u0002'}`);
const showNumberMarks = (piece) => piece.replace(/\u0001/g, '.').replace(/\u0002/g, ',');

// The sentences of a text, each with whether it asks ("?").
function sentencesOf(text) {
  const pieces = hideNumberMarks(text).split(/([.;!?\n]+)/);
  return pieces.filter((_, i) => i % 2 === 0)
    .map((piece, i) => ({ text: showNumberMarks(piece), asks: (pieces[2 * i + 1] || '').includes('?') }));
}
// Each word of the note with its sentence and its part (from one mark to the
// next), and each part's own text.
function readNote(note) {
  const words = [];
  const parts = [];
  sentencesOf(note).forEach(({ text, asks }, sentence) => {
    hideNumberMarks(text).split(PART_MARKS).map(showNumberMarks).forEach((raw) => {
      noteWords(raw).forEach((word) => words.push({ word, part: parts.length, sentence, asks }));
      parts.push(raw);
    });
  });
  return { words, parts };
}
// Each word of the text with its sentence (`id`), whether the sentence asks,
// and whether the word opens a clause (the first word after a mark).
const readText = (text) => sentencesOf(text).flatMap(({ text: sentence, asks }, id) => hideNumberMarks(sentence).split(PART_MARKS)
  .flatMap((piece) => noteWords(showNumberMarks(piece)).map((word, at) => ({ word, id, asks, opens: at === 0 }))));

// What the text may leave out: `single[i]` for one word of the note, `pairs`
// for two words that go together or not at all, `whole` for the parts that
// may go whole, of which the `conditional` ones go only with their whole
// sentence. The report's screens say which words, pairs and parts (`screen`).
function leaveOutRules({ words, parts }, { wordGoes, pairGoes, partGoes, names }) {
  const note = words.map((entry) => entry.word);
  const samePart = (i, j) => Boolean(words[j]) && words[i].part === words[j].part;
  // Every word of a product name goes with it ("Borlux SC").
  const inName = new Set();
  names.map(noteWords).forEach((name) => note.forEach((_, i) => {
    if (name.every((word, offset) => note[i + offset] === word)) name.forEach((__, offset) => inName.add(i + offset));
  }));
  const pairs = note.flatMap((word, i) => (samePart(i, i + 1) && pairGoes(word, note[i + 1]) ? [i] : []));
  const named = note.map((word, i) => pairs.includes(i) || pairs.includes(i - 1)
    || (!NEVER_LEFT_OUT.has(word) && (inName.has(i) || Boolean(wordGoes(word)))));
  const leadsIn = (i) => {
    const next = note.findIndex((word, j) => j > i && !SMALL.has(word));
    return LEAD_INS.has(note[i]) && samePart(i, next) && named[next];
  };
  const trails = (i) => note[i] === 'of' && samePart(i, i - 1) && named[i - 1];
  const single = note.map((word, i) => named[i] || (!NEVER_LEFT_OUT.has(word) && SMALL.has(word)) || leadsIn(i) || trails(i));
  const [whole, conditional] = [new Set(), new Set()];
  parts.forEach((raw, id) => {
    const partWords = words.filter((entry) => entry.part === id).map((entry) => entry.word);
    if (partWords.length && partGoes(raw)) whole.add(id);
    if (CONDITIONS.has(partWords.find((word) => !SMALL.has(word) && !CONDITION_LEADS.has(word)))) conditional.add(id);
  });
  return { single, pairs, whole, conditional };
}

// ── Same order ─────────────────────────────────────────────────────────
// Where a word of the text sits in the note at or after `from`: the first
// word that is the same, or two words of one part of the note that the text
// writes as one ("web worms", "webworms"). null = nowhere.
function placeInNote(textWord, note, from, partOf) {
  for (let j = from; j < note.length; j += 1) {
    const joined = /^\p{L}+$/u.test(note[j]) && /^\p{L}+$/u.test(note[j + 1] || '') && !NEVER_LEFT_OUT.has(note[j])
      && partOf[j] === partOf[j + 1] && `${note[j]}${note[j + 1]}` === textWord;
    if (joined) return { at: j, width: 2 };
    if (sameWord(textWord, note[j])) return { at: j, width: 1 };
  }
  return null;
}

// A word the text adds: a small word; "I" where a clause starts (`opens`),
// never after "<person> and" (the note did not put the technician there);
// "you" and "me" beside a word of speech ("You said you", "You told me");
// "I serviced" before a part of the note that names only places.
function addedWordAllowed(out, k, read, from, opens) {
  const word = out[k];
  if (word === 'i') return (opens || CLAUSE_OPENERS.has(out[k - 1])) && !(out[k - 1] === 'and' && PERSONS.has(out[k - 2]));
  if (ADDABLE.has(word)) return true;
  if (word === 'me') return out[k - 1] === 'told';
  if (word === 'you') return ['said', 'told', 'me'].includes(out[k - 1]);
  if (word !== 'serviced' || out[k - 1] !== 'i') return false;
  const next = read.words.findIndex((entry, j) => j >= from && out.slice(k + 1).some((later) => sameWord(later, entry.word)));
  return next >= 0 && read.words.filter((entry) => entry.part === read.words[next].part)
    .every((entry) => PLACES.has(entry.word) || SMALL.has(entry.word));
}

// The text walked along the note: the text's sentence that uses each word
// of the note (-1 = not used), or the rejection that stops the walk. The
// walk does not see the words of the `hidden` parts.
function walkNote(textWords, read, rules, hidden) {
  const out = textWords.map((entry) => entry.word);
  const noteList = read.words.map((entry) => (hidden.has(entry.part) ? '' : entry.word));
  const partOf = read.words.map((entry) => entry.part);
  const usedIn = noteList.map(() => -1);
  // One sentence of the text for one sentence of the note, both ways.
  const [noteSentenceOf, textSentenceOf, saysSomething] = [new Map(), new Map(), new Set()];
  const stop = (reason, k) => ({ rejection: { reason, words: [out[k]] } });
  let from = 0;
  for (let k = 0; k < out.length; k += 1) {
    const place = placeInNote(out[k], noteList, from, partOf);
    if (!place) {
      if (addedWordAllowed(out, k, read, from, textWords[k].opens)) continue;
      return stop(noteList.some((word) => sameWord(out[k], word)) ? 'out_of_order' : 'not_in_note', k);
    }
    // A small word that sits further on in the note, past words the text may
    // not leave out, is a word the text added here.
    const jumpsOver = noteList.slice(from, place.at).some((word, offset) => word && !rules.single[from + offset]);
    if (jumpsOver && addedWordAllowed(out, k, read, from, textWords[k].opens)) continue;
    const { sentence, asks } = read.words[place.at];
    const { id } = textWords[k];
    if ((noteSentenceOf.get(id) ?? sentence) !== sentence) return stop('joined', k);
    if ((textSentenceOf.get(sentence) ?? id) !== id) return stop('split', k);
    if (asks !== textWords[k].asks) return stop('question', k);
    noteSentenceOf.set(id, sentence);
    textSentenceOf.set(sentence, id);
    if (!SMALL.has(noteList[place.at])) saysSomething.add(id);
    for (let j = place.at; j < place.at + place.width; j += 1) usedIn[j] = id;
    from = place.at + place.width;
  }
  // A sentence made of added and small words says what the note did not.
  const empty = textWords.findIndex((entry) => !saysSomething.has(entry.id));
  return empty >= 0 ? stop('not_in_note', empty) : { usedIn };
}

// What the text left out and may not: half of a pair, or a word that is no
// small word, no word the screens let go and in no part that goes whole.
function leftOutRejection(usedIn, out, read, rules) {
  const noteList = read.words.map((entry) => entry.word);
  const used = (i) => usedIn[i] >= 0;
  const usedParts = new Set(read.words.filter((_, i) => used(i)).map((entry) => entry.part));
  const usedSentences = new Set(read.words.filter((_, i) => used(i)).map((entry) => entry.sentence));
  const brokenPair = rules.pairs.find((i) => used(i) !== used(i + 1));
  if (brokenPair !== undefined) return { reason: 'left_out', words: [noteList[used(brokenPair) ? brokenPair + 1 : brokenPair]] };
  // A whole part goes when the rules name it and the text uses none of it. A
  // part that opens with a condition goes only with its whole sentence.
  const partGoes = ({ part, sentence }) => rules.whole.has(part) && !usedParts.has(part)
    && !(rules.conditional.has(part) && usedSentences.has(sentence));
  const missing = noteList.findIndex((word, i) => !used(i) && !rules.single[i] && !partGoes(read.words[i]));
  if (missing < 0) return null;
  return { reason: out.some((word) => sameWord(word, noteList[missing])) ? 'out_of_order' : 'left_out', words: [noteList[missing]] };
}

/**
 * The same-order check: null when the text's words are the note's words in
 * the note's order, else { reason, words: [word] } with reason
 *   'not_in_note'  the text has a word the note does not have, or a sentence
 *                  that uses no word of the note,
 *   'out_of_order' the text uses a word of the note out of its place,
 *   'left_out'     the text leaves out a word it may not leave out,
 *   'joined'       one sentence of the text holds two sentences of the note,
 *   'split'        two sentences of the text hold one sentence of the note,
 *   'question'     a question became a statement, or a statement a question.
 * `screen` is what the report's own screens say may go (see leaveOutRules).
 */
function orderRejection(text, note, { wordGoes = NOTHING_GOES, pairGoes = NOTHING_GOES, partGoes = NOTHING_GOES, names = [] } = {}) {
  const read = readNote(note);
  const rules = leaveOutRules(read, { wordGoes, pairGoes, partGoes, names });
  const textWords = readText(text);
  const out = textWords.map((entry) => entry.word);
  const check = (hidden) => {
    const { usedIn, rejection } = walkNote(textWords, read, rules, hidden);
    return rejection || leftOutRejection(usedIn, out, read, rules);
  };
  // A part that goes may share a word with a part that stays ("no activity
  // inside. no ants in the kitchen"), and the walk takes the first place it
  // finds. So the note is read with each set of those parts out of sight,
  // all of them first; the answer with none hidden is the one given back.
  const mayGo = [...rules.whole].filter((part) => !rules.conditional.has(part)).slice(0, MAX_HIDDEN_PARTS);
  let rejection = null;
  for (let set = 2 ** mayGo.length - 1; set >= 0; set -= 1) {
    rejection = check(new Set(mayGo.filter((_, bit) => Math.floor(set / 2 ** bit) % 2 === 1)));
    if (!rejection) return null;
  }
  return rejection;
}

module.exports = {
  orderRejection,
  noteWords,
  isCount,
  hideNumberMarks,
  showNumberMarks,
};
