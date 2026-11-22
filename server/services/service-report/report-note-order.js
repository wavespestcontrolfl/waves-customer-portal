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
 *   wordGoes(word)           may this one word of the note go? The answer
 *                            'time' means a word of time: it carried the
 *                            tense of its part (addedTenseRejection).
 *   pairGoes(first, second)  do these two words go together, or not at all
 *                            ("no issues", a figure and its unit)?
 *   partGoes(part)           may this whole part of the note go? The
 *                            answer 'time' means it goes for a time the
 *                            screen reads in more than one word ("on
 *                            11/22", "on March 4"): it carried a tense too.
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
 *     condition or holds a word of QUALIFIERS;
 *   - a clause of the note that names no one is read as the technician's
 *     work: the text may add "I" there. After a person the note names, in
 *     the same part, the text adds no "I" ("customer inspected and treated
 *     shed" is not "You inspected and I treated the shed"). A name is no
 *     person to the check ("Sam inspected and I treated the shed" passes);
 *   - a small word the text adds can change how the note reads. The check
 *     knows two cases (addedSmallRefused): "and" between two actions done
 *     that stand side by side, and a form of "is" between a person and a
 *     word of treatment. It does not judge the others ("customer advised"
 *     may be "You were advised").
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
// Two parts of the note meet in the text with a comma or one of these.
const JOINERS = new Set([...CLAUSE_OPENERS, 'or']);
// A part that opens with a condition qualifies the rest of its sentence
// ("if ants return, ...", "when the gate is open, ...", "..., unless it
// rains"). A condition further in belongs to its own part ("keep pets off
// until dry").
const CONDITIONS = new Set('if unless until except when whenever once while after before since because provided'.split(' '));
const CONDITION_LEADS = new Set('but only or even not so'.split(' '));
// A word that makes its part a condition wherever it stands ("will treat
// outside, weather permitting tomorrow"). The screens refuse that part for
// its word of time, and without it the plan reads as a promise. A list on
// purpose: a part with a word of time is most often no condition ("sprayed
// perimeter, back in 2 weeks").
const QUALIFIERS = new Set('permitting depending assuming barring'.split(' '));
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
// Words of treatment. Between a person of the note and one of these the text
// adds no form of "is": "neighbor sprayed outside" is not "The neighbor was
// sprayed outside". Other words stay open: "customer advised to keep pets
// off" may be "You were advised to keep pets off".
const TREATMENTS = new Set('sprayed treated baited dusted fogged misted trapped poisoned fumigated'.split(' '));
const FORMS_OF_IS = new Set(['was', 'were', 'is', 'are']);
// Words that name no one, between a person and what the person did:
// "customer never personally sprayed outside".
const DENIALS = new Set(['not', 'never', 'just', 'already', 'ever', 'even']);
const namesNoOne = (word) => SMALL.has(word) || DENIALS.has(word) || word.endsWith('ly');
const AND = new Set(['and']);
// Words that end in "ed" and say no action done ("treated shed sealed gap").
const NOT_DONE = new Set('shed bed weed seed feed need'.split(' '));
// A word of the note and what the text may write for it: a technician's short
// form and its full word, the customer as "you" with the verb form "you"
// takes, and what phone dictation writes for a word of the trade. Every
// other word stays letter for letter.
const ALSO_WRITTEN = new Map(Object.entries({
  cust: ['customer', 'you', 'your'], customer: ['you', 'your'], homeowner: ['you'], client: ['you'], tenant: ['you'],
  she: ['you'], he: ['you'], they: ['you'], them: ['you'], her: ['you', 'your'], his: ['your'], their: ['your'],
  has: ['have'], does: ['do'], wants: ['want'], needs: ['need'], thinks: ['think'], sees: ['see'], says: ['say', 'said'],
  was: ['were'], is: ['are'],
  ext: ['exterior', 'outside'], int: ['interior', 'inside'], perim: ['perimeter'],
  roach: ['cockroach'], roaches: ['cockroaches'], cockroach: ['roach'], cockroaches: ['roaches'],
  bath: ['bathroom'], baths: ['bathrooms'], fridge: ['refrigerator'],
  eves: ['eaves'], cinch: ['chinch'], pimento: ['palmetto'], pomento: ['palmetto'],
}));
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const NUMBER_TWINS = new Map(NUMBER_WORDS.flatMap((word, n) => [[word, String(n)], [String(n), word]]));
// Words as the check reads them: lower case, "didn't" as "did not", "she's
// been" as "she has been", "I'd" as "I would" (never dropped: "I'd treat" is
// not "I treated"), "1,200" as 1200, split on anything that is not a letter
// or a digit. A mark on a number stays in the word: "1.5" is not 15, "1/2"
// is not "1-2", "≤5", "5%" and "5 %" are not 5, "1½" is not "11/2", and 5'
// (feet) is not 5" (inches), with a straight mark, a curly one or a prime. So does the 's of a word that
// is no pronoun: "the customer's neighbor" is not "the customer and neighbor".
const markWord = (mark) => `mark${mark.codePointAt(0)}mark`;
const OWNER_FORM = `${markWord("'")}s`;
const ownerForm = (word) => `${word}${OWNER_FORM}`;
// "customer's" names the customer; "customer's dog" may be written "your dog".
const personOf = (word) => (word.endsWith(OWNER_FORM) ? word.slice(0, -OWNER_FORM.length) : word);
CUSTOMER.forEach((word) => ALSO_WRITTEN.set(ownerForm(word), ['your', ownerForm('customer')]));
const numberMark = (_, digit, mark) => `${digit}${mark === '.' ? 'point' : markWord(mark)}`;
// A text with its letter forms made one, before anything is read: a
// full-width "？" is a question mark, a prime is a foot mark, "½" is 1/2.
// A fraction sign after a digit stays on it first: "1½" is not "11/2".
const FRACTION_ON_DIGIT = /(\p{Nd})\s?([\u00BC-\u00BE\u2150-\u215E])/gu;
const plain = (text) => String(text || '').replace(FRACTION_ON_DIGIT, (_, digit, mark) => `${digit}${markWord(mark)}`)
  .replace(/[″“”]/g, '"').replace(/′/g, "'").normalize('NFKC').replace(/\u2044/g, '/').replace(/\u3002/g, '.');
const SIGN_BEFORE_NUMBER = /([<>≤≥≈~±+=#$]+)\s*(-?)(?=\p{N})|(^|[^\p{L}\p{N}])(-)(?=\p{N})/gu;
// Every sign of a run stays: "<=5" is not ">=5".
const signWords = (_, run, runMinus, lead, minus) => (run ? [...run, ...runMinus].map(markWord).join('') : `${lead}${markWord(minus)}`);
// ".5 oz" is 0.5 oz: without the zero the point reads as a sentence end and
// the figure as 5.
const leadingZero = (text) => String(text || '').replace(/(^|[^\p{L}\p{N}.])\.(?=\p{N})/gu, '$10.');
function noteWords(text) {
  return leadingZero(plain(text)).toLowerCase().replace(/[‘’]/g, "'").replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/(\p{N}),(?=\p{N}{3}(?!\p{N}))/gu, '$1').replace(/(\p{N})\s*([/-])\s*(?=\p{N})/gu, '$1$2')
    .replace(/(\p{N})([^\p{L}\p{N}\s])(?=\p{N})/gu, numberMark)
    .replace(SIGN_BEFORE_NUMBER, signWords)
    .replace(/(\p{N})\s+(?=%)/gu, '$1').replace(/(\p{N})([+%°'"])/gu, (_, digit, mark) => `${digit}${markWord(mark)}`)
    .replace(/\bcan't\b|\bcannot\b/g, 'can not').replace(/\bwon't\b/g, 'will not').replace(/n't\b/g, ' not')
    .replace(/'ll\b/g, ' will').replace(/'d\b/g, ' would')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s (been|got)\b/g, '$1 has $2')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s\b/g, '$1 is')
    .replace(/\b(you|we|they|i)'ve\b/g, '$1 have')
    .replace(/(\p{L})'s\b/gu, (_, letter) => ownerForm(letter)).replace(/'m\b/g, ' am').replace(/'re\b/g, ' are').replace(/'ve\b/g, ' ')
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
  const pieces = hideNumberMarks(plain(text)).split(/([.;!?\n]+)/);
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
// whole, of which the `conditional` ones go only with their whole sentence
// (a part that opens with a condition, or holds a word of QUALIFIERS).
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
  // A form of "is" between a person and a word of treatment says who was
  // treated, so it stays: "customer was sprayed outside" is not "You sprayed
  // outside".
  // Whatever stands between it and the treatment ("was never sprayed"), and
  // with a denial or an adverb before it ("customer already was sprayed").
  const saysWhoWasTreated = (i) => {
    if (!FORMS_OF_IS.has(note[i])) return false;
    let before = i - 1;
    while (samePart(i, before) && namesNoOne(note[before])) before -= 1;
    return samePart(i, before) && isActor(note[before]) && note.some((word, j) => j > i && samePart(i, j) && TREATMENTS.has(word));
  };
  const single = note.map((word, i) => named[i] || (!NEVER_LEFT_OUT.has(word) && SMALL.has(word) && !saysWhoWasTreated(i)));
  const timed = note.map((word) => wordGoes(word) === 'time');
  const [whole, conditional, timedParts] = [new Set(), new Set(), new Set()];
  parts.forEach((raw, id) => {
    const partWords = words.filter((entry) => entry.part === id).map((entry) => entry.word);
    const goes = partWords.length && partGoes(raw);
    if (goes) whole.add(id);
    if (goes === 'time') timedParts.add(id);
    const opensWith = partWords.find((word) => !SMALL.has(word) && !CONDITION_LEADS.has(word));
    if (CONDITIONS.has(opensWith) || partWords.some((word) => QUALIFIERS.has(word))) conditional.add(id);
  });
  // The second word of each group by its first, and each later word by the
  // word before it: see placeInNote.
  const follows = new Map(groups.filter((group) => group.length > 1).map((group) => [group[0], group[1]]));
  const continues = new Map(groups.flatMap((group) => group.slice(1).map((at, n) => [at, group[n]])));
  return { single, leans, groups, follows, continues, whole, conditional, timed, timedParts };
}

// ── Same order ─────────────────────────────────────────────────────────
// Where word `k` of the text sits in the note at or after `from`, or -1: the
// first place that holds the same word in a sentence of the note this
// sentence of the text may take (`fits`), else the first place at all. The
// first of the words that go together is no place unless the text goes on
// with the second ("no issues, no ants": "No ants." takes the second "no").
// A later one is no place unless the text took the word before it (`taken`;
// "no issues, issues remain": "Issues remain." takes the second "issues").
function placeInNote(out, k, note, from, { follows, continues }, fits, taken) {
  const open = (j) => !(follows.has(j) && !sameWord(out[k + 1] || '', note[follows.get(j)]))
    && !(continues.has(j) && !taken(continues.get(j)));
  const places = note.flatMap((word, j) => (j >= from && sameWord(out[k], word) && open(j) ? [j] : []));
  return places.find(fits) ?? places[0] ?? -1;
}

// Why word `k` of the text has no place in the note at or after `from`.
function noPlaceRejection(out, k, note, from, { continues }, taken) {
  // Its place is a later one of the words that go together, and the text
  // left out the word before it.
  const half = note.findIndex((word, j) => j >= from && sameWord(out[k], word) && continues.has(j) && !taken(continues.get(j)));
  if (half >= 0) return { reason: 'left_out', words: [note[continues.get(half)]] };
  return { reason: note.some((word) => sameWord(out[k], word)) ? 'out_of_order' : 'not_in_note', words: [out[k]] };
}

// A word the text adds: a small word; "I" where a sentence starts (`opens`)
// or after a joining word (walkNote then looks for a person before it);
// "am" right after "I" ("I'm seeing ants": addedTenseRejection refuses it
// where a word of time went);
// "you" after a word of speech ("You said you"; walkNote then looks for
// the customer). Never "me": "neighbor said" is not "Neighbor told me".
function addedWordAllowed(out, k, opens) {
  const word = out[k];
  if (word === 'i') return opens || CLAUSE_OPENERS.has(out[k - 1]);
  if (word === 'am') return out[k - 1] === 'i';
  if (ADDABLE.has(word)) return true;
  return word === 'you' && ['said', 'told', 'me'].includes(out[k - 1]);
}

// A person of the note, the technician ("I") among them.
const isActor = (word) => word === 'i' || PERSONS.has(personOf(word));
// The last person the note names before place `at`, by a word that is no
// pronoun. With `speaker`, the technician's "I" is one of them: after "I
// said", the customer is not the one who spoke.
const lastNamed = (read, at, speaker = false) => read.words.slice(0, at).map((entry) => personOf(entry.word))
  .filter((word) => (PERSONS.has(word) && !PRONOUNS.has(word)) || (speaker && word === 'i')).pop();

// The "I" or "you" the text added before the note's word at `place` and the
// note does not bear out: its place in the text, or -1. No "I" before or
// after a person the note names in that part ("the neighbor sprayed" is not
// "I and the neighbor sprayed"). No "you" unless the last person the note
// names is the customer ("I said treated shed" is not "I said you treated
// the shed"), and none before a person the note names there ("customer said
// I treated the shed" is not "You said you and I treated the shed").
function addedActorRefused(added, place, read, sameSentence) {
  // The added word goes with a word of its own sentence of the text.
  const stray = [added.i, added.you].find((at) => at >= 0 && !sameSentence(at));
  if (stray !== undefined) return stray;
  const personInPart = read.words.some((entry, j) => j <= place && entry.part === read.words[place].part && PERSONS.has(personOf(entry.word)));
  if (added.i >= 0 && personInPart) return added.i;
  if (added.you < 0) return -1;
  return isActor(read.words[place].word) || !CUSTOMER.has(lastNamed(read, place, true)) ? added.you : -1;
}

// The small word the text added between the word the walk found last
// (`last`) and the note's word at `place`, and the note does not bear out:
// its place in the text, or -1.
//   - "and" between two words of the note that stand side by side (a small
//     word between them or none) and both say an action done. The second
//     may be what the first was done to: "inspected damaged traps" is not
//     "I inspected and damaged traps".
//   - a form of "is" between a person and a word of treatment (TREATMENTS),
//     also with a denial or an adverb between them ("customer never
//     personally sprayed outside" is not "You were never personally sprayed
//     outside").
// `placedAt` is the text word that took each word of the note (-1 = none).
function addedSmallRefused(textWords, k, place, last, read, placedAt) {
  if (!last) return -1;
  const taken = new Set(placedAt);
  const added = (words, after = last.k) => textWords.findIndex((entry, at) => at > after && at < k && !taken.has(at) && words.has(entry.word));
  const [before, here] = [read.words[last.place], read.words[place]];
  const done = (word) => word.endsWith('ed') && !NOT_DONE.has(word);
  const sideBySide = read.words.slice(last.place + 1, place).every((entry) => SMALL.has(entry.word));
  if (sideBySide && before.part === here.part && done(before.word) && done(here.word) && added(AND) >= 0) return added(AND);
  if (!TREATMENTS.has(here.word)) return -1;
  let actor = place - 1;
  while (actor >= 0 && read.words[actor].part === here.part && namesNoOne(read.words[actor].word)) actor -= 1;
  if (actor < 0 || read.words[actor].part !== here.part || !isActor(read.words[actor].word)) return -1;
  return added(FORMS_OF_IS, placedAt[actor] >= 0 ? placedAt[actor] : last.k);
}

// Why the commas of the text do not fit the note between the word the walk
// found last (`last`: its place in the note and in the text) and word `k`,
// which takes the note's word at `place`. Null when they fit.
function commaReason(textWords, k, place, last, read) {
  const [before, here] = [last ? read.words[last.place] : null, read.words[place]];
  if (!before || before.sentence !== here.sentence) return null;
  // Two sentences of the text for one of the note: placeReason says "split".
  if (textWords[last.k].id !== textWords[k].id) return null;
  // The text has a comma only where the note has one: "no ants were found"
  // is not "No, ants were found".
  const between = textWords.slice(last.k + 1, k + 1);
  const comma = between.some((entry) => entry.afterMark);
  if (before.part === here.part) return comma ? 'cut' : null;
  // Two parts of one sentence of the note meet in the text with a comma or a
  // joining word between them, whatever else the text adds there: "No, ants
  // were found" is not "No ants were found", and "None, found inside" is not
  // "None were found inside".
  return comma || between.some((entry) => JOINERS.has(entry.word)) ? null : 'run_together';
}

// Why word `k` of the text may not take the note's word at `place`, or null.
// `last` is the place and the text word the walk found before this one.
function placeReason(textWords, k, place, last, read, { noteSentenceOf, textSentenceOf }) {
  const { word, id, asks } = textWords[k];
  const { word: noteWord, sentence } = read.words[place];
  // A pronoun is "you" only when the last person named before it is the
  // customer.
  if (PRONOUNS.has(noteWord) && word !== noteWord && !CUSTOMER.has(lastNamed(read, place))) return 'not_in_note';
  const commas = commaReason(textWords, k, place, last, read);
  if (commas) return commas;
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
  const placedAt = noteList.map(() => -1);
  const [noteSentenceOf, textSentenceOf, saysSomething] = [new Map(), new Map(), new Set()];
  const stop = (reason, k) => ({ rejection: { reason, words: [out[k]] } });
  const taken = (j) => usedIn[j] >= 0;
  let from = 0;
  // The "I" and the "you" the text added last, until the walk finds the word
  // they go with.
  let added = { i: -1, you: -1 };
  // The place and the text word of the last word the walk found.
  let last = null;
  for (let k = 0; k < out.length; k += 1) {
    const { id } = textWords[k];
    const fits = (j) => (textSentenceOf.get(read.words[j].sentence) ?? id) === id
      && (noteSentenceOf.get(id) ?? read.words[j].sentence) === read.words[j].sentence;
    const place = placeInNote(out, k, noteList, from, rules, fits, taken);
    // A small word that sits further on in the note, past words the text may
    // not leave out, is a word the text added here.
    const jumpsOver = place >= 0 && noteList.slice(from, place)
      .some((word, offset) => word && !rules.single[from + offset] && !rules.leans.has(from + offset));
    if ((place < 0 || jumpsOver) && addedWordAllowed(out, k, textWords[k].opens)) {
      if (out[k] === 'i' || out[k] === 'you') added[out[k]] = k;
      continue;
    }
    if (place < 0) return { rejection: noPlaceRejection(out, k, noteList, from, rules, taken) };
    const actor = addedActorRefused(added, place, read, (at) => textWords[at].id === id);
    const wrong = actor >= 0 ? actor : addedSmallRefused(textWords, k, place, last, read, placedAt);
    if (wrong >= 0) return stop('not_in_note', wrong);
    // A small word of the note does not say whose work it is: the added
    // word waits for the next word.
    if (!SMALL.has(noteList[place])) added = { i: -1, you: -1 };
    const reason = placeReason(textWords, k, place, last, read, { noteSentenceOf, textSentenceOf });
    if (reason) return stop(reason, k);
    last = { place, k };
    const { sentence } = read.words[place];
    noteSentenceOf.set(id, sentence);
    textSentenceOf.set(sentence, id);
    if (!SMALL.has(noteList[place])) saysSomething.add(id);
    usedIn[place] = id;
    placedAt[place] = k;
    from = place + 1;
  }
  // An added "I" or "you" with no word of the note after it ("Neighbor told
  // you."), and a sentence made of added and small words, say what the note
  // did not.
  const empty = Math.max(added.i, added.you, textWords.findIndex((entry) => !saysSomething.has(entry.id)));
  return empty >= 0 ? stop('not_in_note', empty) : { usedIn, placedAt };
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

// A word of time carries the tense of its part: "treating outside tomorrow"
// is a plan. Where one went, the text adds no form of "is" before a word in
// "-ing" of that part ("I was treating outside." is past work, "I am
// treating outside." is work now), also with words of the part between the
// two ("I was spot treating outside."). A contracted form is a form too
// ("I'm treating outside."). A part the screen refuses for a time counts
// as words of time ("on 11/22", "on March 4"). What a lost word of time
// speaks for:
//   - its own part;
//   - every part of its sentence, when its part went whole ("treating
//     outside, in two weeks", "treating outside, hopefully tomorrow"). The
//     safe side: after "ants trailing in kitchen, back in 2 weeks" the text
//     may say "Ants trailing in the kitchen." and not "Ants were trailing";
//   - the parts beside its part, across a sentence mark too, when the part
//     holds nothing but the time ("treating outside. In two weeks.").
const SETS_A_TENSE = new Set([...FORMS_OF_IS, 'am']);
const LEADS_TO_A_TIME = new Set('in on at by for next this last until till after before within about around every each coming following'.split(' '));
function addedTenseRejection(textWords, placedAt, read, rules) {
  const parts = [...new Set(read.words.map((entry) => entry.part))];
  const everyWordOf = (part, test) => read.words.every((entry, i) => entry.part !== part || test(entry.word, i));
  const wentWhole = (part) => everyWordOf(part, (_, i) => placedAt[i] < 0);
  const onlyTime = (part) => everyWordOf(part, (word, i) => rules.timed[i] || SMALL.has(word) || isCount(word) || LEADS_TO_A_TIME.has(word));
  const lostTime = new Set();
  read.words.forEach((entry, i) => {
    if (placedAt[i] >= 0 || !(rules.timed[i] || rules.timedParts.has(entry.part))) return;
    lostTime.add(entry.part);
    if (!wentWhole(entry.part)) return;
    read.words.filter((other) => other.sentence === entry.sentence).forEach((other) => lostTime.add(other.part));
    const at = parts.indexOf(entry.part);
    if (onlyTime(entry.part)) [parts[at - 1], parts[at + 1]].forEach((part) => lostTime.add(part));
  });
  // The part of the note each text word took; a text word with none was added.
  const partOf = new Map(read.words.map((entry, i) => [placedAt[i], entry.part]));
  const addedIsBefore = (at, part) => {
    for (let k = at - 1; k >= 0 && (!partOf.has(k) || partOf.get(k) === part); k -= 1) {
      if (!partOf.has(k) && SETS_A_TENSE.has(textWords[k].word)) return k;
    }
    return -1;
  };
  for (const [i, entry] of read.words.entries()) {
    const wrong = placedAt[i] >= 0 && lostTime.has(entry.part) && entry.word.endsWith('ing') ? addedIsBefore(placedAt[i], entry.part) : -1;
    if (wrong >= 0) return { reason: 'not_in_note', words: [textWords[wrong].word] };
  }
  return null;
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
 *   'cut'          the text has a comma inside one part of the note,
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
    const { usedIn, placedAt, rejection } = walkNote(textWords, read, rules, hidden);
    return rejection || leftOutRejection(usedIn, out, read, rules) || addedTenseRejection(textWords, placedAt, read, rules);
  };
  // A part that goes may share a word with a part that stays ("no activity
  // inside. no ants in the kitchen"), and the walk takes the first place it
  // finds. So the note is read with each set of those parts out of sight,
  // all of them first; the answer with none hidden is the one given back.
  // So is a part whose every word may go by the word rules ("no issues. no
  // issues found": "No issues found." is the second sentence).
  const wordsGo = (part) => !rules.whole.has(part) && read.words.some((entry) => entry.part === part)
    && read.words.every((entry, i) => entry.part !== part || rules.single[i] || rules.leans.has(i));
  const mayGo = [...rules.whole, ...read.parts.map((_, part) => part).filter(wordsGo)]
    .filter((part) => !rules.conditional.has(part)).slice(0, MAX_HIDDEN_PARTS);
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
