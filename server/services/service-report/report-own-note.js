/**
 * The technician's own note as the report text: what code lets out (owner
 * 2026-11-19, "GO" on the report speed plan: *note I* and *read first*;
 * owner 2026-11-21: *same order*).
 *
 * A report's text is the note the technician gave, tidied: one to three
 * sentences, the technician's words in the technician's order. A model call
 * tidies the note (a later PR). This module decides whether a tidied text
 * may go out:
 *   - shape: plain text on one line, no sign-off, not too long;
 *   - the report's own word screens: the screen the report reader runs again
 *     on every read (noteRecordCopyViolations), product, brand and
 *     active-ingredient names, the writer rules, a line that asks for contact;
 *   - same order (orderRejection): the text's words are the note's words in
 *     the note's order. It may add a few small words. It may leave out a
 *     small word, a word the screens refuse, or a whole part of the note that
 *     is not for the customer. It never moves a word, never adds one that
 *     states something, and never joins two sentences of the note.
 * A text that fails gets the fixed sentence (fixedReportNote).
 *
 * The checks read the note, the text and the product catalog, and nothing
 * else about the visit, so a completion can run them again on the text the
 * technician read (reportNoteRejection) and get the same answer.
 */
const { redactAccessCodes } = require('../context-aggregator');
const CompletionRecap = require('../completion-recap');
const { noteRecordCopyViolations } = require('./technician-report-copy');
const { writerRulesRejectionDetail, lowercaseGermanRoach } = require('./report-writer-rules');

// The reader (technician-report-copy.js reportNoteCustomerCopy) allows more.
const MAX_OWN_NOTE_CHARS = 600;

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
// A part of the note (from one mark to the next) that holds one of these is
// for the office, is a remark about the customer, or tells the customer to
// do something: the text may leave the whole part out.
const LEFT_OUT_PART_WORDS = new Set(`office billing bill charge charged invoice pay paid payment price reschedule rescheduled
schedule scheduled booked appointment call text email redacted rude nice mean difficult angry upset complained complaining
traveling travelling vacation vacuum clean wash mop water watering avoid stay`.split(/\s+/));
// A part that names only places may open with "I serviced".
const PLACES = new Set(`kitchen garage bathroom bathrooms bath baths exterior interior ext int outside inside perimeter perim lanai
attic yard front back side sides eaves house home only both master laundry bedroom bedrooms porch patio pool cage shed fence
driveway`.split(/\s+/));
const PERSONS = new Set('customer cust you she he they we homeowner client tenant'.split(' '));
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
// been" as "she has been", a possessive dropped, a decimal as one number,
// split on anything that is not a letter or a digit.
function noteWords(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'")
    .replace(/(\p{N})[.,](?=\p{N})/gu, '$1')
    .replace(/\bcan't\b|\bcannot\b/g, 'can not').replace(/\bwon't\b/g, 'will not').replace(/n't\b/g, ' not')
    .replace(/'ll\b/g, ' will')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s (been|got)\b/g, '$1 has $2')
    .replace(/\b(she|he|it|that|there|what|who|where|here)'s\b/g, '$1 is')
    .replace(/\b(you|we|they|i)'ve\b/g, '$1 have')
    .replace(/'(?:ve|re|d|m|s)\b/g, ' ')
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
const SENTENCE_MARKS = /[.;!?\n]+/;
const PART_MARKS = /[,:]+/;
// A stop inside a number is no sentence mark ("2.5 gallons").
const withoutNumberMarks = (text) => String(text || '').replace(/(\p{N})[.,](?=\p{N})/gu, '$1');

// Each word of the note with its sentence and its part (from one mark to the
// next), and each part's own text.
function readNote(note) {
  const words = [];
  const parts = [];
  withoutNumberMarks(note).split(SENTENCE_MARKS).forEach((sentence, sentenceId) => {
    sentence.split(PART_MARKS).forEach((raw) => {
      noteWords(raw).forEach((word) => words.push({ word, part: parts.length, sentence: sentenceId }));
      parts.push(raw);
    });
  });
  return { words, parts };
}
// The text's sentence for each of its words.
function textSentences(text) {
  const out = [];
  withoutNumberMarks(text).split(SENTENCE_MARKS).forEach((sentence, id) => noteWords(sentence).forEach(() => out.push(id)));
  return out;
}

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
// for the parts it may leave out whole. `refused(fragment)` is the report's
// word screen: the reason a customer text may not hold the fragment, or null.
// One word is left out for what it is, never for where it stands: "open" and
// "use" open an order to the customer, and are plain words elsewhere.
function leaveOutRules({ words, parts }, refused) {
  const note = words.map((entry) => entry.word);
  const nearRemovedCode = (i) => note.slice(Math.max(0, i - 2), i + 3).includes('redacted');
  // The figure of an amount or a period: "2 gallons", "two weeks".
  const amountFigure = (i) => isCount(note[i]) && LEFT_OUT_WORDS.has(note[i + 1] || '');
  const refusedWord = (word) => { const reason = refused(word); return Boolean(reason) && reason !== 'instruction'; };
  const named = note.map((word, i) => !NEVER_LEFT_OUT.has(word)
    && (LEFT_OUT_WORDS.has(word) || amountFigure(i) || nearRemovedCode(i) || refusedWord(word)));
  // A word that only leads into what is left out goes with it: "in" before
  // "two weeks", "with" before a product name.
  const leadsIn = (i) => LEAD_INS.has(note[i]) && named[note.findIndex((word, j) => j > i && !SMALL.has(word))];
  const single = note.map((word, i) => named[i] || (!NEVER_LEFT_OUT.has(word) && SMALL.has(word)) || Boolean(leadsIn(i)));
  const pairs = [];
  note.forEach((word, i) => {
    if (REFUSED_PAIRS.some(([first, second]) => word === first && note[i + 1] === second)) pairs.push(i);
  });
  const whole = new Set();
  parts.forEach((raw, id) => {
    const partWords = words.filter((entry) => entry.part === id).map((entry) => entry.word);
    if (!partWords.length) return;
    if (partWords.some((word) => LEFT_OUT_PART_WORDS.has(word)) || unscopedNothingSeen(partWords) || refused(raw)) whole.add(id);
  });
  return { single, pairs, whole };
}

// ── Same order ─────────────────────────────────────────────────────────
// Where the text's word `k` sits in the note at or after `from`: the first
// word that is the same, or two words of the note the text writes as one
// ("web worms", "webworms"). -1 = nowhere.
function placeInNote(textWord, note, from) {
  for (let j = from; j < note.length; j += 1) {
    const joined = /^\p{L}+$/u.test(note[j]) && /^\p{L}+$/u.test(note[j + 1] || '') && `${note[j]}${note[j + 1]}` === textWord;
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

/**
 * The same-order check: null when the text's words are the note's words in
 * the note's order, else { reason, words: [word] } with reason
 *   'not_in_note'  the text has a word the note does not have,
 *   'out_of_order' the text uses a word of the note out of its place,
 *   'left_out'     the text leaves out a word it may not leave out,
 *   'joined'       one sentence of the text holds two sentences of the note.
 * `refused(fragment)` is the report's word screen (see leaveOutRules).
 */
function orderRejection(text, note, refused = () => null) {
  const read = readNote(note);
  const noteList = read.words.map((entry) => entry.word);
  const rules = leaveOutRules(read, refused);
  const out = noteWords(text);
  const sentenceOfTextWord = textSentences(text);
  const noteSentenceOf = new Map();
  const used = noteList.map(() => false);
  const usedParts = new Set();
  let from = 0;
  for (let k = 0; k < out.length; k += 1) {
    const place = placeInNote(out[k], noteList, from);
    if (!place) {
      if (addedWordAllowed(out, k, read, from)) continue;
      return { reason: noteList.some((word) => sameWord(out[k], word)) ? 'out_of_order' : 'not_in_note', words: [out[k]] };
    }
    // A small word that sits further on in the note, past words the text may
    // not leave out, is a word the text added here.
    const jumpsOver = noteList.slice(from, place.at).some((_, offset) => !rules.single[from + offset]);
    if (jumpsOver && addedWordAllowed(out, k, read, from)) continue;
    for (let j = place.at; j < place.at + place.width; j += 1) {
      used[j] = true;
      usedParts.add(read.words[j].part);
    }
    const noteSentence = read.words[place.at].sentence;
    const had = noteSentenceOf.get(sentenceOfTextWord[k]);
    if (had !== undefined && had !== noteSentence) return { reason: 'joined', words: [out[k]] };
    noteSentenceOf.set(sentenceOfTextWord[k], noteSentence);
    from = place.at + place.width;
  }
  const brokenPair = rules.pairs.find((i) => used[i] !== used[i + 1]);
  if (brokenPair !== undefined) return { reason: 'left_out', words: [noteList[used[brokenPair] ? brokenPair + 1 : brokenPair]] };
  const pairWord = (i) => rules.pairs.some((first) => i === first || i === first + 1);
  const missing = noteList.findIndex((word, i) => !used[i] && !rules.single[i] && !pairWord(i)
    && !(rules.whole.has(read.words[i].part) && !usedParts.has(read.words[i].part)));
  if (missing < 0) return null;
  return { reason: out.some((word) => sameWord(word, noteList[missing])) ? 'out_of_order' : 'left_out', words: [noteList[missing]] };
}

// ── The screens ────────────────────────────────────────────────────────
// The report page has Ask Waves: the note never asks the customer to reach us.
const CONTACT_LINE_RE = /\b(?:text|call|contact|email|message)\s+(?:or\s+(?:text|call|email)\s+)?(?:us|me|the\s+office)\b|\breach\s+out\b|\bget\s+in\s+touch\b|\blet\s+(?:us|me)\s+know\b|\bgive\s+(?:us|me)\s+a\s+(?:call|text|ring)\b/i;
// The report adds the signature: "- Waves" or a name at the end is not text.
const SIGN_OFF_RE = /\s[-–—]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\.?$/;
const REDACTED_RE = /\bredacted\b/i;

// The note as the model and the checks read it: access codes never reach a
// provider and can never be a word of the text. Line breaks stay: a break
// ends a sentence of the note.
// The weed is one word; written as two, the price screen reads "dollar".
const dollarweedAsOneWord = (text) => text.replace(/\b(dollar)[ -](weeds?)\b/gi, '$1$2');
const noteAsRead = (note) => dollarweedAsOneWord(redactAccessCodes(String(note || '').replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\n ]*/g, '\n').trim()));
// The tidied note as stored and screened. A line break stays in, so the
// shape screen refuses it.
function ownNoteText(value) {
  const text = String(value || '').trim().replace(/[^\S\r\n]+/g, ' ').replace(/^["“”']+|["“”']+$/g, '').trim();
  return dollarweedAsOneWord(lowercaseGermanRoach(text));
}

// What the reader's screen lets stand and a saved note must not hold (owner
// 2026-11-20, *A*: each wording today's screens miss is refused where the
// note is written). A word of time: the report gives no day, date or period
// ("Wait a day before stepping onto the grass.", "Drying time? Two days.",
// "Foot traffic can resume on Monday."). A part that opens with an order to
// the customer ("Use rose at the back."). A pass phrase, and a prompt for one.
const TIME_WORD_RE = /\b(?:minutes?|hours?|days?|weeks?|months?|years?|today|tonight|tomorrow|yesterday|overnight|daily|weekly|monthly|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|mornings?|afternoons?|evenings?|nights?|nightly|noon|midnight)\b/i;
const ORDER_OPENERS = new Set(`use wait keep stay avoid leave make remember try please do call contact enter press open close lock
vacuum wash mop wipe mow`.split(/\s+/));
const PASS_PHRASE_RE = /\bpass\s?phrases?\b|\bprompt(?:s|ed|ing)?\b/i;
function writeTimeRejection(text) {
  const time = TIME_WORD_RE.exec(text);
  if (time) return { reason: 'time', words: [time[0]] };
  if (PASS_PHRASE_RE.test(text)) return { reason: 'access_code' };
  const order = withoutNumberMarks(text).split(/[.;!?,:\n]+/).map((part) => noteWords(part)[0]).find((word) => ORDER_OPENERS.has(word));
  return order ? { reason: 'instruction', words: [order] } : null;
}

function shapeRejection(text) {
  if (!text) return { reason: 'empty' };
  if (/[\r\n]/.test(text) || SIGN_OFF_RE.test(text)) return { reason: 'shape' };
  if (text.length > MAX_OWN_NOTE_CHARS) return { reason: 'too_long' };
  return REDACTED_RE.test(text) ? { reason: 'access_code' } : null;
}

// The report's word screen for one text or one fragment of the note.
function wordRejection(text, { namesProduct, activeIngredients }) {
  const refusedBy = noteRecordCopyViolations(text);
  if (refusedBy.some((entry) => /access_code$/.test(entry))) return { reason: 'access_code' };
  if (refusedBy.includes('note_record_time')) return { reason: 'time' };
  if (refusedBy.length) {
    // Only what the text itself holds is named back to the writer.
    const words = refusedBy.filter((word) => text.toLowerCase().includes(String(word).toLowerCase())).slice(0, 6);
    return { reason: 'banned', ...(words.length ? { words } : {}) };
  }
  if (namesProduct(text)) return { reason: 'trade_name' };
  const rule = writerRulesRejectionDetail(text, { activeIngredients });
  if (rule) return { reason: rule.reason, ...(rule.match ? { words: [rule.match] } : {}) };
  return CONTACT_LINE_RE.test(text) ? { reason: 'contact_line' } : writeTimeRejection(text);
}

/**
 * The completion's check of the text the technician read, against the note it
 * saves, and the clean-up's check of the model's answer: null when the text
 * may go out, else { reason, words? }. Built from the note and the product
 * catalog alone. Throws when the catalog cannot be read: the caller then
 * uses the fixed sentence.
 */
async function reportNoteRejection({ note, text, catalogRows = null, db = null } = {}) {
  const said = noteAsRead(note);
  const rows = catalogRows || await CompletionRecap.readCatalogScreenRows(db);
  // A product the note names is screened in full, with its active
  // ingredient; every other catalog product by its brand (wholeCatalog).
  const mentioned = CompletionRecap.catalogScreensForPrompt(rows, said);
  const namesProduct = await CompletionRecap.buildReportTradeNameScreen({
    products: [], extraNames: mentioned.names, wholeCatalog: true, catalogRows: rows, mentionedText: said,
  });
  const screens = { namesProduct, activeIngredients: mentioned.actives };
  const tidied = ownNoteText(text);
  return shapeRejection(tidied)
    || wordRejection(tidied, screens)
    || orderRejection(tidied, said, (fragment) => wordRejection(fragment, screens)?.reason || null);
}

// The sentence code writes when there is no note to send: today's fallback
// recap, from the service name and the areas on the record.
function fixedReportNote({ serviceType, areasServiced } = {}) {
  return CompletionRecap.deterministicRecap({ serviceType, areasTreated: areasServiced });
}

module.exports = {
  reportNoteRejection,
  orderRejection,
  fixedReportNote,
  ownNoteText,
  noteAsRead,
  MAX_OWN_NOTE_CHARS,
};
