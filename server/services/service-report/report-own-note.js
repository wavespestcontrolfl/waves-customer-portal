/**
 * The technician's own note as the report text (owner 2026-11-19, "GO" on the
 * report speed plan: *note I*): what code lets out.
 *
 * A report's text is the note the technician gave, cleaned up: one to three
 * sentences in the first person, no titles. Whatever wrote the cleaned text,
 * code decides whether it may go out:
 *   - the report's own word screens run on it (banned copy, access codes, the
 *     writer rules, product, brand and active-ingredient names);
 *   - a trace: every word of the cleaned note that states something is a word
 *     of the note. A clean-up may fix a word. It never adds one.
 * When no text passes, or the technician gave no note, the report gets the
 * fixed sentence code writes from the service name and the areas on the record.
 *
 * The screens read the note, the text and the product catalog, and nothing
 * else about the visit, so the same text gets the same answer wherever it is
 * checked.
 */
const { redactAccessCodes } = require('../context-aggregator');
const CompletionRecap = require('../completion-recap');
const { customerCopyViolations } = require('./technician-report-copy');
const { writerRulesRejectionDetail, lowercaseGermanRoach } = require('./report-writer-rules');

// The reader (technician-report-copy.js reportNoteCustomerCopy) allows more.
const MAX_OWN_NOTE_CHARS = 600;

// ── The trace ──────────────────────────────────────────────────────────
// Words that state nothing by themselves: articles, pronouns, the verbs "be",
// "have" and "do", modals, plain prepositions and joining words. Every other
// word of a cleaned note has to come from the note. Words that carry a place
// ("inside", "under", "behind", "front"), an amount ("all", "more", "very"),
// a time ("still", "again") or a denial are not here on purpose.
const GLUE_WORDS = new Set(`a an the this that these those some any
i me my we us our you your yours it its they them their there here
am is are was were be been being have has had having do does did will would can could should may might must
of to for with by at in on from as into onto about during up down out off
and or but so also then too if while when where which who what than because since
today visit service serviced`.split(/\s+/));
// A denial in the cleaned note needs a denial in the note.
const NEGATIONS = new Set(`no not never none nothing nowhere neither nor without
didnt dont doesnt wasnt werent isnt arent couldnt cant wont wouldnt hasnt havent hadnt shouldnt`.split(/\s+/));
// Forms the suffix rules below cannot reach, each with its base word.
const SAME_WORD = Object.freeze({
  saw: 'see', seen: 'see', found: 'find', went: 'go', gone: 'go', goes: 'go', going: 'go', came: 'come',
  told: 'tell', said: 'say', left: 'leave', caught: 'catch', took: 'take', taken: 'take', gave: 'give',
  given: 'give', made: 'make', ran: 'run', got: 'get', gotten: 'get', kept: 'keep', heard: 'hear',
  brought: 'bring', swept: 'sweep', laid: 'lay', dug: 'dig', hung: 'hang', used: 'use', uses: 'use',
  using: 'use', mice: 'mouse', dead: 'die', died: 'die', dying: 'die', dies: 'die',
  treatment: 'treat', treatments: 'treat', application: 'apply', applications: 'apply',
  inspection: 'inspect', inspections: 'inspect', activity: 'active', activities: 'active',
  removal: 'remove', replacement: 'replace', replacements: 'replace', installation: 'install',
  recommendation: 'recommend', recommendations: 'recommend',
});
// A word of the note that also stands for another: a technician's short form
// and its full word, or two everyday names of one thing.
const ALSO_SAID = Object.freeze({
  roach: ['cockroach'], cockroach: ['roach'],
  outside: ['exterior'], exterior: ['outside'], ext: ['exterior', 'outside'],
  inside: ['interior'], interior: ['inside'], int: ['interior', 'inside'],
  house: ['home'], home: ['house'],
  igr: ['insect', 'growth', 'regulator'],
  perim: ['perimeter'], cust: ['customer'], bath: ['bathroom'], fridge: ['refrigerator'],
  // What phone dictation writes for a word of the trade.
  eves: ['eaves'],
});
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
const NUMBER_TWINS = new Map(NUMBER_WORDS.flatMap((word, n) => [[word, String(n)], [String(n), word]]));
// Seeing is how a technician knows anything in the note: "ants in the kitchen"
// may become "I saw ants in the kitchen".
const SIGHT_WORDS = ['see', 'find', 'notice'];
// "Said" may become "told me", only when the note has the customer speaking.
const SPEECH_WORDS = ['tell', 'say', 'mention', 'report', 'ask'];
const CUSTOMER_WORDS = new Set(['customer', 'cust', 'homeowner', 'client', 'tenant', 'owner', 'resident', 'wife', 'husband', 'she', 'he', 'mr', 'mrs', 'ms']);
// A dropped product name leaves "a treatment", and "sprayed" may become
// "treated", only when the note itself says something was applied.
const WORK_WORDS = ['treat', 'apply', 'use', 'put', 'place', 'spread', 'product'];
const APPLIED_WORDS = ['spray', 'treat', 'apply', 'dust', 'bait', 'gel', 'foam', 'granule', 'granular', 'spread', 'fog', 'mist', 'drench', 'inject', 'broadcast', 'use', 'put', 'place', 'lay'];

// The same word in another form gets the same stem: "sprayed", "spraying" and
// "sprays"; "place", "placed" and "places". A stem is a key, not a word.
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
const SAME_STEM = new Map(Object.entries(SAME_WORD).map(([word, base]) => [word, ruleStem(base)]));
const traceStem = (word) => SAME_STEM.get(word) || ruleStem(word);
const stemsOf = (words) => words.map(traceStem);
const ALSO_SAID_STEMS = new Map(Object.entries(ALSO_SAID).map(([word, also]) => [traceStem(word), stemsOf(also)]));
const SIGHT_STEMS = new Set(stemsOf(SIGHT_WORDS));
const SPEECH_STEMS = new Set(stemsOf(SPEECH_WORDS));
const WORK_STEMS = new Set(stemsOf(WORK_WORDS));
const APPLIED_STEMS = stemsOf(APPLIED_WORDS);

// Words as the trace reads them: lower case, "didn't" as "did not", a
// possessive or "'ll" dropped, split on anything that is not a letter or a
// digit ("spot-treated" is two words).
function traceWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\bcan't\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/n't\b/g, ' not')
    .replace(/'(?:ll|ve|re|d|m|s)\b/g, ' ')
    .match(/[a-z0-9]+/g) || [];
}

// One letter changed, added, dropped or swapped with its neighbour: what a
// fixed dictation or typing error looks like ("cinch" to "chinch").
function withinOneEdit(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let at = 0;
  while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
  const restA = a.slice(at);
  const restB = b.slice(at);
  if (a.length !== b.length) return a.length > b.length ? restA.slice(1) === restB : restB.slice(1) === restA;
  return restA.slice(1) === restB.slice(1)
    || (restA.length >= 2 && restA[0] === restB[1] && restA[1] === restB[0] && restA.slice(2) === restB.slice(2));
}

// What the note said, as the trace needs it.
function readNote(note) {
  const words = traceWords(note);
  const stems = new Set();
  // Stems a fixed error may sit one letter away from: the note's own words
  // that state something, never a number.
  const close = new Set();
  const add = (stem) => {
    stems.add(stem);
    (ALSO_SAID_STEMS.get(stem) || []).forEach((also) => stems.add(also));
  };
  words.forEach((word, i) => {
    const stem = traceStem(word);
    add(stem);
    if (!GLUE_WORDS.has(word) && stem.length >= 4 && !/\d/.test(stem)) close.add(stem);
    // Two words the clean-up may write as one ("web worms", "webworms").
    if (i + 1 < words.length) add(traceStem(`${word}${words[i + 1]}`));
    if (NUMBER_TWINS.has(word)) add(traceStem(NUMBER_TWINS.get(word)));
  });
  return {
    stems,
    close: [...close],
    denies: words.some((word) => NEGATIONS.has(word)),
    customerSpoke: words.some((word) => CUSTOMER_WORDS.has(word)) || [...SPEECH_STEMS].some((stem) => stems.has(stem)),
    appliedWork: APPLIED_STEMS.some((stem) => stems.has(stem)),
  };
}

function wordTraces(words, i, said) {
  const word = words[i];
  if (GLUE_WORDS.has(word)) return true;
  if (NEGATIONS.has(word)) return said.denies;
  const stem = traceStem(word);
  if (said.stems.has(stem) || SIGHT_STEMS.has(stem)) return true;
  if (SPEECH_STEMS.has(stem) && said.customerSpoke) return true;
  if (WORK_STEMS.has(stem) && said.appliedWork) return true;
  // One word of the note written as two ("webworms", "web worms").
  if (i + 1 < words.length && said.stems.has(traceStem(`${word}${words[i + 1]}`))) return true;
  if (i > 0 && said.stems.has(traceStem(`${words[i - 1]}${word}`))) return true;
  return stem.length >= 5 && !/\d/.test(stem) && said.close.some((other) => withinOneEdit(stem, other));
}

// The words of a cleaned note that are not in the note. Empty = it adds none.
function untracedWords(text, note) {
  const said = readNote(note);
  const words = traceWords(text);
  return [...new Set(words.filter((word, i) => !wordTraces(words, i, said)))];
}

// ── The screens ────────────────────────────────────────────────────────
// The report page has Ask Waves: the note never asks the customer to reach us.
const CONTACT_LINE_RE = /\b(?:text|call|contact|email|message)\s+(?:or\s+(?:text|call|email)\s+)?(?:us|me|the\s+office)\b|\breach\s+out\b|\bget\s+in\s+touch\b|\blet\s+(?:us|me)\s+know\b|\bgive\s+(?:us|me)\s+a\s+(?:call|text|ring)\b/i;
// The report adds the signature: "- Waves" or a name at the end is not text.
const SIGN_OFF_RE = /\s[-–—]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\.?$/;
const REDACTED_RE = /\bredacted\b/i;

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();
// The note as the trace reads it: an access code is redacted first, so a code
// can never trace.
const noteAsRead = (note) => redactAccessCodes(oneLine(note));
// The cleaned note as stored and screened. A line break stays in, so the
// shape screen refuses it.
function ownNoteText(value) {
  const text = String(value || '').trim().replace(/[^\S\r\n]+/g, ' ').replace(/^["“”']+|["“”']+$/g, '').trim();
  // The weed is one word; written as two, the price screen reads "dollar".
  return lowercaseGermanRoach(text).replace(/\b(dollar)[ -](weeds?)\b/gi, '$1$2');
}

function shapeRejection(text) {
  if (!text) return { reason: 'empty' };
  if (/[\r\n]/.test(text) || SIGN_OFF_RE.test(text)) return { reason: 'shape' };
  if (text.length > MAX_OWN_NOTE_CHARS) return { reason: 'too_long' };
  return REDACTED_RE.test(text) ? { reason: 'access_code' } : null;
}

function wordRejection(text, { namesProduct, activeIngredients }) {
  const banned = customerCopyViolations(text);
  if (banned.includes('access_code')) return { reason: 'access_code' };
  if (banned.length) {
    // Only the banned words the text itself holds are reported.
    const words = banned.filter((word) => text.toLowerCase().includes(String(word).toLowerCase())).slice(0, 6);
    return { reason: 'banned', ...(words.length ? { words } : {}) };
  }
  if (namesProduct(text)) return { reason: 'trade_name' };
  const rule = writerRulesRejectionDetail(text, { activeIngredients });
  if (rule) return { reason: rule.reason, ...(rule.match ? { words: [rule.match] } : {}) };
  return CONTACT_LINE_RE.test(text) ? { reason: 'contact_line' } : null;
}

/**
 * The screen for one note: screen(text) answers null when the cleaned text may
 * go out, else { reason, words? }. Built from the note and the product catalog
 * alone. Throws when the catalog cannot be read: the caller then uses the
 * fixed sentence.
 */
async function ownNoteScreen({ note, catalogRows = null, db = null } = {}) {
  const said = noteAsRead(note);
  const rows = catalogRows || await CompletionRecap.readCatalogScreenRows(db);
  // A product the note names is screened in full, with its active
  // ingredient; every other catalog product by its brand (wholeCatalog).
  const mentioned = CompletionRecap.catalogScreensForPrompt(rows, said);
  const namesProduct = await CompletionRecap.buildReportTradeNameScreen({
    products: [], extraNames: mentioned.names, wholeCatalog: true, catalogRows: rows, mentionedText: said,
  });
  return (value) => {
    const text = ownNoteText(value);
    const refused = shapeRejection(text) || wordRejection(text, { namesProduct, activeIngredients: mentioned.actives });
    if (refused) return refused;
    const added = untracedWords(text, said);
    return added.length ? { reason: 'not_in_note', words: added.slice(0, 8) } : null;
  };
}

// The check of a cleaned text against the note it was made from.
async function reportNoteRejection({ note, text, catalogRows = null, db = null } = {}) {
  return (await ownNoteScreen({ note, catalogRows, db }))(text);
}

// The sentence code writes when there is no note to send: today's fallback
// recap, from the service name and the areas on the record.
function fixedReportNote({ serviceType, areasServiced } = {}) {
  return CompletionRecap.deterministicRecap({ serviceType, areasTreated: areasServiced });
}

module.exports = {
  reportNoteRejection,
  fixedReportNote,
  ownNoteText,
  untracedWords,
  MAX_OWN_NOTE_CHARS,
};
