/**
 * The same-order check for a tidied technician note (owner 2026-11-21, *same
 * order*): is a text the note's own words, in the note's order?
 *
 * A report's text is the note the technician gave, tidied by a model (a later
 * PR). orderRejection(text, note, screen) answers null when
 *   - every word of the text is a word of the note, letter for letter and in
 *     the note's order, or one of a few small words the grammar needs;
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
 *   - a clause of the note that names no one is read as the technician's
 *     work: the text may add "I" there. After a person the note names, in
 *     the same part, the text adds no "I" ("customer inspected and treated
 *     shed" is not "You inspected and I treated the shed"). A name is no
 *     person to the check ("Sam inspected and I treated the shed" passes).
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
// The text adds "I" only as the first word of a sentence or after one of
// these, and never after a person the note names in that part (PERSONS).
// "You said I saw roaches" is not "customer said saw roaches", with or
// without a comma the text puts in.
const CLAUSE_OPENERS = new Set('and so but then because when while since'.split(' '));
// A part that opens with a condition qualifies the rest of its sentence
// ("if ants return, ...", "when the gate is open, ...", "..., unless it
// rains"). A condition further in belongs to its own part ("keep pets off
// until dry").
const CONDITIONS = new Set('if unless until except when whenever once while after before since because provided'.split(' '));
const CONDITION_LEADS = new Set('but only or even not so'.split(' '));
// The parts tried out of sight one set at a time (64 walks at most).
const MAX_HIDDEN_PARTS = 6;
const NOTHING_GOES = () => false;
// After one of these in a part of the note, the text adds no "I": the note
// says who acted, or leaves it open, and so does the text.
const PERSONS = new Set(`customer cust you she he they we her his them their homeowner client tenant owner resident wife husband son
daughter mom dad kid kids neighbor neighbors landlord manager guy lady man woman contractor housekeeper office tech technician
company crew`.split(/\s+/));
// A pronoun of the note is "you" in the text only when the last person the
// note names before it is the customer: "neighbor said he treated shed" is
// not "Neighbor said you treated shed".
const CUSTOMER = new Set(['customer', 'cust', 'homeowner', 'client', 'tenant']);
const PRONOUNS = new Set(['she', 'he', 'they', 'them', 'her', 'his', 'their']);
// A word of the note and what the text may write for it: a technician's short
// form and its full word, the customer as "you" with the verb form "you"
// takes, and what phone dictation writes for a word of the trade. Every
// other word stays letter for letter.
const ALSO_WRITTEN = new Map(Object.entries({
  cust: ['customer', 'you', 'your'], customer: ['you', 'your'], homeowner: ['you'], client: ['you'], tenant: ['you'],
  she: ['you'], he: ['you'], they: ['you'], them: ['you'], her: ['you', 'your'], his: ['your'], their: ['your'],
  has: ['have'], does: ['do'], wants: ['want'], needs: ['need'], thinks: ['think'], sees: ['see'], says: ['say', 'said', 'told'], said: ['told'],
  ext: ['exterior', 'outside'], int: ['interior', 'inside'], perim: ['perimeter'],
  roach: ['cockroach'], roaches: ['cockroaches'], cockroach: ['roach'], cockroaches: ['roaches'],
  bath: ['bathroom'], baths: ['bathrooms'], fridge: ['refrigerator'],
  eves: ['eaves'], cinch: ['chinch'], pimento: ['palmetto'], pomento: ['palmetto'],
}));
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const NUMBER_TWINS = new Map(NUMBER_WORDS.flatMap((word, n) => [[word, String(n)], [String(n), word]]));
// Words as the check reads them: lower case, "didn't" as "did not", "she's
// been" as "she has been", "I'd" as "I would" (never dropped: "I'd treat" is
// not "I treated"), a possessive dropped, "1,200" as 1200, split on anything
// that is not a letter or a digit. A mark on a number stays in the word:
// "1.5" is not 15, "1/2" is not "1-2", "≤5" and "5%" are not 5.
const markWord = (mark) => `mark${mark.codePointAt(0)}mark`;
const numberMark = (_, digit, mark) => `${digit}${mark === '.' ? 'point' : markWord(mark)}`;
const SIGN_BEFORE_NUMBER = /(^|\s)(?:([<>≤≥≈~±+=#$])\s*|(-))(?=\p{N})/gu;
// ".5 oz" is 0.5 oz: without the zero the point reads as a sentence end and
// the figure as 5.
const leadingZero = (text) => String(text || '').replace(/(^|[^\p{L}\p{N}.])\.(?=\p{N})/gu, '$10.');
function noteWords(text) {
  return leadingZero(text).normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/(\p{N}),(?=\p{N}{3}(?!\p{N}))/gu, '$1').replace(/(\p{N})\s*([/-])\s*(?=\p{N})/gu, '$1$2')
    .replace(/(\p{N})([^\p{L}\p{N}\s])(?=\p{N})/gu, numberMark)
    .replace(SIGN_BEFORE_NUMBER, (_, lead, sign, minus) => `${lead}${markWord(sign || minus)}`)
    .replace(/(\p{N})([+%°])/gu, (_, digit, mark) => `${digit}${markWord(mark)}`)
    .replace(/\bcan't\b|\bcannot\b/g, 'can not').replace(/\bwon't\b/g, 'will not').replace(/n't\b/g, ' not')
    .replace(/'ll\b/g, ' will').replace(/'d\b/g, ' would')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s (been|got)\b/g, '$1 has $2')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s\b/g, '$1 is')
    .replace(/\b(you|we|they|i)'ve\b/g, '$1 have')
    .replace(/'(?:ve|re|m|s)\b/g, ' ')
    .match(/[\p{L}\p{N}]+/gu) || [];
}
const isCount = (word) => /\p{N}/u.test(word) || NUMBER_WORDS.includes(word);

// A word of the text is a word of the note: the same word letter for letter,
// what ALSO_WRITTEN says the note's word may be written as, or a count
// written the other way. No other form: "taped" is not "tapped", "ants" is
// not "ant", "treat" is not "treated".
const sameWord = (textWord, noteWord) => textWord === noteWord
  || (ALSO_WRITTEN.get(noteWord) || []).includes(textWord) || NUMBER_TWINS.get(noteWord) === textWord;

// ── The note, read ─────────────────────────────────────────────────────
// A colon ends no part: what follows a label goes with it ("billing: ...").
const PART_MARKS = /,+/;
// A mark inside a number ends no sentence and no part ("2.5 gallons"): it is
// hidden while the text is split, and put back in each piece.
const hideNumberMarks = (text) => leadingZero(text).replace(/(\p{N})([.,])(?=\p{N})/gu, (_, digit, mark) => `${digit}${mark === '.' ? '\u0001' : '\u0002'}`);
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
// whether the word opens the sentence, and whether a comma comes before it.
const readText = (text) => sentencesOf(text).flatMap(({ text: sentence, asks }, id) => {
  let seen = 0;
  return hideNumberMarks(sentence).split(PART_MARKS).flatMap((piece, pieceAt) => noteWords(showNumberMarks(piece)).map((word, at) => {
    seen += 1;
    return { word, id, asks, opens: seen === 1, afterMark: pieceAt > 0 && at === 0 };
  }));
});

// What the text may leave out: `single[i]` for one word of the note, `leans`
// for a word that goes only when the word it leans on goes, `groups` for
// words that go together or not at all, `whole` for the parts that may go
// whole, of which the `conditional` ones go only with their whole sentence.
// The report's screens say which words, pairs and parts (`screen`).
function leaveOutRules({ words, parts }, { wordGoes, pairGoes, partGoes, names }) {
  const note = words.map((entry) => entry.word);
  const samePart = (i, j) => Boolean(words[j]) && words[i].part === words[j].part;
  // Every word of a product name ("Borlux SC"), and two words the screens
  // pair ("no issues", a figure and its unit).
  const groups = [];
  names.map(noteWords).filter((name) => name.length).forEach((name) => note.forEach((_, i) => {
    if (name.every((word, offset) => note[i + offset] === word && samePart(i, i + offset))) groups.push(name.map((__, offset) => i + offset));
  }));
  note.forEach((word, i) => {
    if (samePart(i, i + 1) && pairGoes(word, note[i + 1])) groups.push([i, i + 1]);
  });
  const grouped = new Set(groups.flat());
  const named = note.map((word, i) => grouped.has(i) || (!NEVER_LEFT_OUT.has(word) && Boolean(wordGoes(word))));
  // A word that only leads into what goes ("in" before "two weeks", "with"
  // before a product name), and "of" right after it ("2 gallons of bait").
  const leans = new Map();
  note.forEach((word, i) => {
    const next = note.findIndex((later, j) => j > i && !SMALL.has(later));
    if (LEAD_INS.has(word) && samePart(i, next) && named[next]) leans.set(i, next);
    else if (word === 'of' && samePart(i, i - 1) && named[i - 1]) leans.set(i, i - 1);
  });
  const single = note.map((word, i) => named[i] || (!NEVER_LEFT_OUT.has(word) && SMALL.has(word)));
  const [whole, conditional] = [new Set(), new Set()];
  parts.forEach((raw, id) => {
    const partWords = words.filter((entry) => entry.part === id).map((entry) => entry.word);
    if (partWords.length && partGoes(raw)) whole.add(id);
    if (CONDITIONS.has(partWords.find((word) => !SMALL.has(word) && !CONDITION_LEADS.has(word)))) conditional.add(id);
  });
  // The second word of each group, by its first: see placeInNote.
  const follows = new Map(groups.filter((group) => group.length > 1).map((group) => [group[0], group[1]]));
  return { single, leans, groups, follows, whole, conditional };
}

// ── Same order ─────────────────────────────────────────────────────────
// Where word `k` of the text sits in the note at or after `from`, or -1: the
// first place that holds the same word in a sentence of the note this
// sentence of the text may take (`fits`), else the first place at all. The
// first of the words that go together is no place unless the text goes on
// with the second ("no issues, no ants": "No ants." takes the second "no").
function placeInNote(out, k, note, from, follows, fits) {
  const places = note.flatMap((word, j) => (j >= from && sameWord(out[k], word)
    && !(follows.has(j) && !sameWord(out[k + 1] || '', note[follows.get(j)])) ? [j] : []));
  return places.find(fits) ?? places[0] ?? -1;
}

// A word the text adds: a small word; "I" where a sentence starts (`opens`)
// or after a joining word (walkNote then looks for a person before it);
// "you" and "me" beside a word of speech ("You said you", "You told me").
function addedWordAllowed(out, k, opens) {
  const word = out[k];
  if (word === 'i') return opens || CLAUSE_OPENERS.has(out[k - 1]);
  if (ADDABLE.has(word)) return true;
  if (word === 'me') return out[k - 1] === 'told';
  return word === 'you' && ['said', 'told', 'me'].includes(out[k - 1]);
}

// Why word `k` of the text may not take the note's word at `place`, or null.
// `last` is the place and the text word the walk found before this one.
function placeReason(textWords, k, place, last, read, { noteSentenceOf, textSentenceOf }) {
  const { word, id, asks, afterMark } = textWords[k];
  const { word: noteWord, sentence, part } = read.words[place];
  // A pronoun is "you" only when the last person named before it is the
  // customer.
  const named = read.words.slice(0, place).map((entry) => entry.word).filter((earlier) => PERSONS.has(earlier) && !PRONOUNS.has(earlier));
  if (PRONOUNS.has(noteWord) && word !== noteWord && !CUSTOMER.has(named.pop())) return 'not_in_note';
  // Two parts of one sentence of the note meet in the text with a comma or a
  // joining word between them: "No, ants were found" is not "No ants were
  // found".
  const before = last && last.k === k - 1 ? read.words[last.place] : null;
  const meets = Boolean(before) && before.sentence === sentence && before.part !== part;
  if (meets && !afterMark && !CLAUSE_OPENERS.has(word) && word !== 'or') return 'run_together';
  // One sentence of the text for one sentence of the note, both ways.
  if ((noteSentenceOf.get(id) ?? sentence) !== sentence) return 'joined';
  if ((textSentenceOf.get(sentence) ?? id) !== id) return 'split';
  return read.words[place].asks === asks ? null : 'question';
}

// The text walked along the note: the text's sentence that uses each word
// of the note (-1 = not used), or the rejection that stops the walk. The
// walk does not see the words of the `hidden` parts.
function walkNote(textWords, read, rules, hidden) {
  const out = textWords.map((entry) => entry.word);
  const noteList = read.words.map((entry) => (hidden.has(entry.part) ? '' : entry.word));
  const usedIn = noteList.map(() => -1);
  const [noteSentenceOf, textSentenceOf, saysSomething] = [new Map(), new Map(), new Set()];
  const stop = (reason, k) => ({ rejection: { reason, words: [out[k]] } });
  // A person the note names before place `at`, in the same part.
  const personBefore = (at) => read.words.some((entry, j) => j < at && entry.part === read.words[at].part && PERSONS.has(entry.word));
  let from = 0;
  // The "I" the text added last, until the walk finds the word it goes with.
  let addedI = -1;
  // The place and the text word of the last word the walk found.
  let last = null;
  for (let k = 0; k < out.length; k += 1) {
    const { id } = textWords[k];
    const fits = (j) => (textSentenceOf.get(read.words[j].sentence) ?? id) === id
      && (noteSentenceOf.get(id) ?? read.words[j].sentence) === read.words[j].sentence;
    const place = placeInNote(out, k, noteList, from, rules.follows, fits);
    // A small word that sits further on in the note, past words the text may
    // not leave out, is a word the text added here.
    const jumpsOver = place >= 0 && noteList.slice(from, place)
      .some((word, offset) => word && !rules.single[from + offset] && !rules.leans.has(from + offset));
    if ((place < 0 || jumpsOver) && addedWordAllowed(out, k, textWords[k].opens)) {
      if (out[k] === 'i') addedI = k;
      continue;
    }
    if (place < 0) return stop(noteList.some((word) => sameWord(out[k], word)) ? 'out_of_order' : 'not_in_note', k);
    if (addedI >= 0 && personBefore(place)) return stop('not_in_note', addedI);
    addedI = -1;
    const reason = placeReason(textWords, k, place, last, read, { noteSentenceOf, textSentenceOf });
    if (reason) return stop(reason, k);
    last = { place, k };
    const { sentence } = read.words[place];
    noteSentenceOf.set(id, sentence);
    textSentenceOf.set(sentence, id);
    if (!SMALL.has(noteList[place])) saysSomething.add(id);
    usedIn[place] = id;
    from = place + 1;
  }
  // A sentence made of added and small words says what the note did not.
  const empty = textWords.findIndex((entry) => !saysSomething.has(entry.id));
  return empty >= 0 ? stop('not_in_note', empty) : { usedIn };
}

// What the text left out and may not: some of the words that go together,
// or a word that is no small word, no word the screens let go, no word that
// leans on a word that went, and in no part that goes whole.
function leftOutRejection(usedIn, out, read, rules) {
  const noteList = read.words.map((entry) => entry.word);
  const used = (i) => usedIn[i] >= 0;
  const usedParts = new Set(read.words.filter((_, i) => used(i)).map((entry) => entry.part));
  const usedSentences = new Set(read.words.filter((_, i) => used(i)).map((entry) => entry.sentence));
  const broken = rules.groups.find((group) => group.some(used) && !group.every(used));
  if (broken) return { reason: 'left_out', words: [noteList[broken.find((i) => !used(i))]] };
  const leansOnGone = (i) => rules.leans.has(i) && !used(rules.leans.get(i));
  // A whole part goes when the rules name it and the text uses none of it. A
  // part that opens with a condition goes only with its whole sentence.
  const partGoes = ({ part, sentence }) => rules.whole.has(part) && !usedParts.has(part)
    && !(rules.conditional.has(part) && usedSentences.has(sentence));
  const missing = noteList.findIndex((word, i) => !used(i) && !rules.single[i] && !leansOnGone(i) && !partGoes(read.words[i]));
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
 *   'run_together' two parts of the note meet in the text with no comma and
 *                  no joining word between them,
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
