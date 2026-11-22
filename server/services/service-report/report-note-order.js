/**
 * The same-order check for a tidied technician note (owner 2026-11-21, *same
 * order*): is a text the note's own words, in the note's order?
 *
 * A report's text is the note the technician gave, tidied by a model (a later
 * PR). orderRejection(text, note, refused, names) answers null when
 *   - every word of the text is a word of the note, in the note's order, or
 *     one of a few small words the grammar needs;
 *   - the text has one sentence for each sentence of the note it keeps: none
 *     joined, none cut, a question still a question;
 *   - what the text leaves out is a small word, a word the report's screens
 *     refuse, or a whole part of the note that is not for the customer.
 * It reads the two strings and nothing else about the visit. The caller gives
 * the report's word screen (`refused`) and the product names the note holds
 * (`names`): report-own-note.js will (the next PR). Nothing calls this
 * module yet.
 *
 * Known limits, by design (the technician reads the text before it is sent):
 *   - a typing or dictation error stays as written, unless ALSO_WRITTEN
 *     knows it;
 *   - a note with no marks is one sentence and one part: the text is one
 *     sentence, and a remark for the office inside it cannot be left out, so
 *     the caller falls back to its fixed sentence;
 *   - a part the screens refuse goes whole, with what else it says ("found
 *     rats by the gate"); so does a part where a word for the office has
 *     another sense ("paid attention to the ant trail");
 *   - a present-tense note reads as work done ("treat shed" as "I treated
 *     the shed"): technicians write both ways;
 *   - a name is no person to the check: "Sam and I sprayed" passes where
 *     "the neighbor and I sprayed" does not.
 */

// ── The words ──────────────────────────────────────────────────────────
// Small words the text may add where the grammar needs them.
const ADDABLE = new Set('i the a an and also was were is are it has have there'.split(' '));
// Small words the text may leave out.
const SMALL = new Set(`a an the this that these those it its there here am is are was were be been being have has had do does did
of to and also then too um uh`.split(/\s+/));
// Words the text never leaves out by themselves: a denial, a plan, a
// condition, a doubt, a person. Leaving one out changes what the note says.
const NEVER_LEFT_OUT = new Set(`no not never none nothing nowhere neither nor without cannot will would should shall need needs
recommend recommends recommended next plan plans customer cust homeowner client tenant owner resident wife husband she he
if unless until except or but only before after may might could can maybe probably likely want wants wanted
i we you they them their`.split(/\s+/));
// Words the LEAVE OUT rules name that no screen refuses as one word: units of
// an amount, words of a time or a date, and the mark of a removed code.
const LEFT_OUT_WORDS = new Set(`redacted oz ounce ounces gallon gallons gal ml percent sq ft feet foot square lb lbs pound pounds
week weeks day days month months today tomorrow yesterday monday tuesday wednesday thursday friday saturday sunday
am pm morning afternoon evening`.split(/\s+/));
const LEAD_INS = new Set('in for at on by with about within every per each'.split(' '));
// Two words the report refuses together. The text leaves out both or neither.
const REFUSED_PAIRS = [['no', 'issues'], ['no', 'issue'], ['no', 'problems'], ['no', 'problem'], ['pest', 'free'], ['non', 'toxic']];
// A part that holds a condition qualifies the rest of its sentence.
const CONDITIONS = new Set(['if', 'unless', 'until', 'except']);
// An order to the customer. The first group always opens one. The second
// does only before what it acts on ("water the lawn"; "water in the
// basement" is a finding, "keep seeing ants" is the customer's report).
const ORDER_VERBS = new Set('avoid stay wait please remember'.split(' '));
const ORDER_VERBS_WITH_OBJECT = new Set('keep vacuum mop wipe mow water wash clean leave use open close lock'.split(' '));
const ORDER_OBJECT_LEADS = new Set('the your all any it them off away out pets kids children dogs'.split(' '));
const ORDER_TELLS = new Set('told advised advise asked recommend recommended need needs reminded'.split(' '));
function orderToCustomer(partWords) {
  const opensOrder = (i) => ORDER_VERBS.has(partWords[i])
    || (ORDER_VERBS_WITH_OBJECT.has(partWords[i]) && ORDER_OBJECT_LEADS.has(partWords[i + 1]));
  const leadsIn = (word, i) => ['should', 'must', 'please'].includes(word)
    || (word === 'to' && partWords.slice(0, i).some((earlier) => ORDER_TELLS.has(earlier)));
  return opensOrder(0) || (partWords[0] === 'do' && partWords[1] === 'not')
    || partWords.some((word, i) => leadsIn(word, i) && opensOrder(i + 1));
}
// A part that names only places may open with "I serviced".
const PLACES = new Set(`kitchen garage bathroom bathrooms bath baths exterior interior ext int outside inside perimeter perim lanai
attic yard front back side sides eaves house home only both master laundry bedroom bedrooms porch patio pool cage shed fence
driveway`.split(/\s+/));
const PERSONS = new Set(`customer cust you she he they we homeowner client tenant owner resident wife husband son daughter
neighbor neighbors landlord manager`.split(/\s+/));
// A word of the note and what the text may write for it: a technician's short
// form and its full word, the customer as "you", and what phone dictation
// writes for a word of the trade.
const ALSO_WRITTEN = Object.freeze({
  cust: ['customer', 'you'], customer: ['you'], homeowner: ['you'], client: ['you'], tenant: ['you'],
  she: ['you'], he: ['you'], they: ['you'], them: ['you'], her: ['you', 'your'], his: ['your'], their: ['your'],
  ext: ['exterior', 'outside'], int: ['interior', 'inside'], perim: ['perimeter'],
  roach: ['cockroach'], roaches: ['cockroaches'], cockroach: ['roach'], cockroaches: ['roaches'], bath: ['bathroom'], fridge: ['refrigerator'],
  said: ['told'], says: ['said', 'told'],
  eves: ['eaves'], cinch: ['chinch'], pimento: ['palmetto'], pomento: ['palmetto'],
});
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const NUMBER_TWINS = new Map(NUMBER_WORDS.flatMap((word, n) => [[word, String(n)], [String(n), word]]));
// Forms the suffix rules below cannot reach, each with its base word.
const SAME_WORD = Object.freeze({
  saw: 'see', seen: 'see', found: 'find', told: 'tell', said: 'say', left: 'leave', caught: 'catch', swept: 'sweep',
  laid: 'lay', mice: 'mouse', has: 'have', had: 'have',
});

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
const stemOf = (word) => ruleStem(SAME_WORD[word] || word);

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
  if ((ALSO_WRITTEN[noteWord] || []).some((written) => written === textWord || stemOf(written) === stemOf(textWord))) return true;
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
// The text's sentence for each of its words.
const textSentences = (text) => sentencesOf(text).flatMap(({ text: sentence, asks }, id) => noteWords(sentence).map(() => ({ id, asks })));

const NOTHING_SEEN_WORDS = new Set(`no nothing none activity signs sign pests bugs issues seen found inside outside home house
today at in the all any`.split(/\s+/));
const SIGHT_WORDS = new Set(['find', 'found', 'see', 'saw', 'seen', 'spot']);
// A part that says nothing was seen and names no room or spot ("no activity
// inside", "couldn't find a nest"): the LEAVE OUT rules name it.
function unscopedNothingSeen(partWords) {
  if (['no', 'nothing', 'none'].includes(partWords[0]) && partWords.every((word) => NOTHING_SEEN_WORDS.has(word))) return true;
  return partWords.includes('not') && partWords.some((word) => SIGHT_WORDS.has(word)) && !partWords.some((word) => PLACES.has(word));
}

// What the text may leave out: `single[i]` for one word of the note, `whole`
// for the parts it may leave out whole, of which the `conditional` ones go
// only with their whole sentence. `refused(fragment)` is the report's word
// screen: the reason a customer text may not hold the fragment, or null.
// `names` are the product names the note holds.
// One word goes for what it is, never for where it stands ("open" and "use"
// open an order, and are plain words elsewhere), and never because it is for
// the office: "not paid" must not leave "not" behind.
function leaveOutRules({ words, parts }, refused, names) {
  const note = words.map((entry) => entry.word);
  // Every word of a product name goes with it ("Borlux SC").
  const inName = new Set();
  names.map(noteWords).forEach((name) => note.forEach((_, i) => {
    if (name.every((word, offset) => note[i + offset] === word)) name.forEach((__, offset) => inName.add(i + offset));
  }));
  // The figure of an amount or a period: "2 gallons", "two weeks".
  const amountFigure = (i) => isCount(note[i]) && LEFT_OUT_WORDS.has(note[i + 1] || '');
  const refusedWord = (word) => { const reason = refused(word); return Boolean(reason) && !['instruction', 'not_for_customer'].includes(reason); };
  const named = note.map((word, i) => !NEVER_LEFT_OUT.has(word)
    && (LEFT_OUT_WORDS.has(word) || amountFigure(i) || inName.has(i) || refusedWord(word)));
  // A word that only leads into what is left out goes with it: "in" before
  // "two weeks", "with" before a product name.
  const leadsIn = (i) => LEAD_INS.has(note[i]) && named[note.findIndex((word, j) => j > i && !SMALL.has(word))];
  const single = note.map((word, i) => named[i] || (!NEVER_LEFT_OUT.has(word) && SMALL.has(word)) || Boolean(leadsIn(i)));
  const pairs = [];
  note.forEach((word, i) => {
    if (REFUSED_PAIRS.some(([first, second]) => word === first && note[i + 1] === second)) pairs.push(i);
  });
  const [whole, conditional] = [new Set(), new Set()];
  parts.forEach((raw, id) => {
    const partWords = words.filter((entry) => entry.part === id).map((entry) => entry.word);
    if (!partWords.length) return;
    // An order goes by what it says, not by how the screen reads its opener.
    const reason = refused(raw);
    if ((reason && reason !== 'instruction') || partWords.includes('redacted') || unscopedNothingSeen(partWords) || orderToCustomer(partWords)) whole.add(id);
    if (partWords.some((word) => CONDITIONS.has(word))) conditional.add(id);
  });
  return { single, pairs, whole, conditional };
}

// ── Same order ─────────────────────────────────────────────────────────
// Where the text's word `k` sits in the note at or after `from`: the first
// word that is the same, or two words of the note the text writes as one
// ("web worms", "webworms"). -1 = nowhere.
function placeInNote(textWord, note, from) {
  for (let j = from; j < note.length; j += 1) {
    const joined = /^\p{L}+$/u.test(note[j]) && /^\p{L}+$/u.test(note[j + 1] || '') && !NEVER_LEFT_OUT.has(note[j])
      && `${note[j]}${note[j + 1]}` === textWord;
    if (joined) return { at: j, width: 2 };
    if (sameWord(textWord, note[j])) return { at: j, width: 1 };
  }
  return null;
}

// A word the text adds: a small word; "you" and "me" beside a word of speech
// ("You said you", "You told me"); "I serviced" before a part of the note
// that names only places. Never "I" after "<person> and": the note did not
// put the technician there.
function addedWordAllowed(out, k, read, from) {
  const word = out[k];
  if (word === 'i' && out[k - 1] === 'and' && PERSONS.has(out[k - 2])) return false;
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
function walkNote(out, textSentence, read, rules, hidden) {
  const noteList = read.words.map((entry) => (hidden.has(entry.part) ? '' : entry.word));
  const usedIn = noteList.map(() => -1);
  // One sentence of the text for one sentence of the note, both ways.
  const [noteSentenceOf, textSentenceOf, saysSomething] = [new Map(), new Map(), new Set()];
  const stop = (reason, k) => ({ rejection: { reason, words: [out[k]] } });
  let from = 0;
  for (let k = 0; k < out.length; k += 1) {
    const place = placeInNote(out[k], noteList, from);
    if (!place) {
      if (addedWordAllowed(out, k, read, from)) continue;
      return stop(noteList.some((word) => sameWord(out[k], word)) ? 'out_of_order' : 'not_in_note', k);
    }
    // A small word that sits further on in the note, past words the text may
    // not leave out, is a word the text added here.
    const jumpsOver = noteList.slice(from, place.at).some((word, offset) => word && !rules.single[from + offset]);
    if (jumpsOver && addedWordAllowed(out, k, read, from)) continue;
    const { sentence, asks } = read.words[place.at];
    const { id } = textSentence[k];
    if ((noteSentenceOf.get(id) ?? sentence) !== sentence) return stop('joined', k);
    if ((textSentenceOf.get(sentence) ?? id) !== id) return stop('split', k);
    if (asks !== textSentence[k].asks) return stop('question', k);
    noteSentenceOf.set(id, sentence);
    textSentenceOf.set(sentence, id);
    if (!SMALL.has(noteList[place.at])) saysSomething.add(id);
    for (let j = place.at; j < place.at + place.width; j += 1) usedIn[j] = id;
    from = place.at + place.width;
  }
  // A sentence made of added and small words says what the note did not.
  const empty = out.findIndex((_, k) => !saysSomething.has(textSentence[k].id));
  return empty >= 0 ? stop('not_in_note', empty) : { usedIn };
}

// What the text left out and may not: half of a refused pair, or a word that
// is no small word, no refused word and in no part that goes whole.
function leftOutRejection(usedIn, out, read, rules) {
  const noteList = read.words.map((entry) => entry.word);
  const used = (i) => usedIn[i] >= 0;
  const usedParts = new Set(read.words.filter((_, i) => used(i)).map((entry) => entry.part));
  const usedSentences = new Set(read.words.filter((_, i) => used(i)).map((entry) => entry.sentence));
  const brokenPair = rules.pairs.find((i) => used(i) !== used(i + 1));
  if (brokenPair !== undefined) return { reason: 'left_out', words: [noteList[used(brokenPair) ? brokenPair + 1 : brokenPair]] };
  const pairWord = (i) => rules.pairs.some((first) => i === first || i === first + 1);
  // A whole part goes when the rules name it and the text uses none of it. A
  // part with a condition qualifies its sentence: it goes only with all of it.
  const partGoes = ({ part, sentence }) => rules.whole.has(part) && !usedParts.has(part)
    && !(rules.conditional.has(part) && usedSentences.has(sentence));
  const missing = noteList.findIndex((word, i) => !used(i) && !rules.single[i] && !pairWord(i) && !partGoes(read.words[i]));
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
 * `refused(fragment)` is the report's word screen and `names` the product
 * names the note holds (see leaveOutRules).
 */
function orderRejection(text, note, refused = () => null, names = []) {
  const read = readNote(note);
  const rules = leaveOutRules(read, refused, names);
  const out = noteWords(text);
  const textSentence = textSentences(text);
  const check = (hidden) => {
    const { usedIn, rejection } = walkNote(out, textSentence, read, rules, hidden);
    return rejection || leftOutRejection(usedIn, out, read, rules);
  };
  // A text most often leaves out every part it may. The note is read without
  // those parts first, so a word one of them shares with a part that stays
  // ("no activity inside. no ants in the kitchen") is found where it stays.
  return check(new Set([...rules.whole].filter((part) => !rules.conditional.has(part)))) && check(new Set());
}

module.exports = {
  orderRejection,
  noteWords,
  orderToCustomer,
  hideNumberMarks,
  showNumberMarks,
};
