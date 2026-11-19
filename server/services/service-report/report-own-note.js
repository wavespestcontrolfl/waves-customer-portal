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
 *
 * What the trace holds a cleaned note to, word by word:
 *   - every word that states something is a word of the note: the same word
 *     in another form, a count written the other way (3 / three, exactly),
 *     two words written as one (letters only), one letter changed in a word
 *     of five letters or more (never a count), a short table of twins;
 *   - a denial or a plan covers the rest of its clause ("did not treat the
 *     kitchen", "will treat the kitchen"), and the cleaned note says plainly
 *     only what the note says plainly: "I treated the kitchen" needs "treat"
 *     and "kitchen" plain somewhere in the note. It may deny or plan a word
 *     the note says plainly;
 *   - work said as done keeps who did it ("customer sprayed" never becomes
 *     "I sprayed"), and "you told me" needs the customer speaking in the note
 *     ("I told the customer" is not);
 *   - "treated" or "a treatment" for another work word needs a plain work
 *     verb in the note ("sprayed", "baited"), not a noun ("bait station");
 *   - one to three sentences of plain text in the Latin script, read as
 *     NFKC, so the screens and the trace read the same letters.
 * It does not judge which words go together within one mode: "baited the
 * kitchen, sprayed the garage" may come out with the places swapped. The
 * technician reads the cleaned note before it is sent (owner pick *read
 * first*).
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
// The words that make the rest of their clause denied ("not treat", "no
// roaches"). "Nothing", "none" and "nowhere" deny themselves.
const SCOPED_NEGATIONS = new Set([...NEGATIONS].filter((word) => !['nothing', 'none', 'nowhere'].includes(word)));
// The words that make the rest of their clause a plan, not work done: "will
// treat", "need to treat", "next visit". "Next to" is a place.
const PLAN_WORDS = new Set(['will', 'would', 'should', 'shall', 'need', 'needs', 'plan', 'plans', 'planned',
  'recommend', 'recommends', 'recommended', 'schedule', 'scheduled', 'next']);
// A clause ends at a mark of punctuation, at a word that turns the sentence,
// and where a new subject starts: no mode reaches past it. Within a clause,
// a mode on an action ("not treat") ends at the next action ("did not treat
// the kitchen treated the garage"); one on a thing ("no roaches") at the
// first.
const CLAUSE_TURNS = new Set(['but', 'then', 'so', 'because', 'while', 'though', 'although', 'however', 'yet']);
const SUBJECTS = new Set(['i', 'we', 'you', 'he', 'she', 'they']);
// Words that stand before a noun: "the building", "any damaged wood".
const DETERMINERS = new Set(['a', 'an', 'the', 'any', 'some', 'no', 'this', 'that', 'these', 'those', 'my', 'your',
  'our', 'their', 'his', 'her', 'its', 'each', 'every', 'all']);
// Counts match exactly: "eighty" is one letter from "eight".
const NUMBER_WORD_RE = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen)s?$/;
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
// "Said" may become "told me" only when the note has the customer speaking or
// seeing: a word of speech or of seeing whose nearest doer is the customer
// ("cust said", "customer still seeing"). "Customer had ants" is not the
// customer speaking.
const SPEECH_WORDS = ['tell', 'say', 'mention', 'report', 'ask', 'complain'];
const CUSTOMER_WORDS = new Set(['customer', 'cust', 'homeowner', 'client', 'tenant', 'owner', 'resident', 'wife', 'husband', 'she', 'he', 'mr', 'mrs', 'ms']);
// A dropped product name leaves "a treatment", and "sprayed" may become
// "treated", only when the note itself says plainly that something was
// applied: a work verb in any form, or a word that is also a noun in its -ed
// or -ing form ("baited", never "bait station").
const WORK_WORDS = ['treat', 'apply', 'use', 'put', 'place', 'spread', 'product'];
const APPLIED_VERBS = ['spray', 'treat', 'apply', 'spread', 'drench', 'inject', 'broadcast', 'use', 'put', 'lay', 'granule', 'granular'];
const APPLIED_NOUNS = ['bait', 'gel', 'foam', 'dust', 'fog', 'mist', 'place'];
// More verbs the trace knows: each ends a denial in a note ("no ants inside
// sealed the gap"), and work said as done keeps who did it.
const ACTION_WORDS = ['seal', 'remove', 'inspect', 'sweep', 'clean', 'vacuum', 'install', 'replace', 'set', 'check',
  'caulk', 'mow', 'water', 'cut', 'trim', 'fertilize', 'cover', 'repair', 'fix', 'close', 'move', 'leave', 'kill'];

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
const APPLIED_VERB_STEMS = new Set(stemsOf(APPLIED_VERBS));
const APPLIED_NOUN_STEMS = new Set(stemsOf(APPLIED_NOUNS));
const ACTOR_STEMS = new Set([...SIGHT_STEMS, ...SPEECH_STEMS, ...WORK_STEMS, ...APPLIED_VERB_STEMS,
  ...APPLIED_NOUN_STEMS, ...stemsOf(ACTION_WORDS)]);

// Words as the trace reads them: lower case, "didn't" as "did not", a
// possessive or "'ll" dropped, split on anything that is not a letter or a
// digit in any script ("spot-treated" is two words), so no word goes unread.
function traceWords(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\bcan't\b/g, 'can not')
    .replace(/\bwon't\b/g, 'will not')
    .replace(/n't\b/g, ' not')
    .replace(/'(?:ll|ve|re|d|m|s)\b/g, ' ')
    .match(/[\p{L}\p{N}]+/gu) || [];
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

const withTwins = (stem) => [stem, ...(ALSO_SAID_STEMS.get(stem) || [])];
const statesSomething = (word) => !GLUE_WORDS.has(word) && !NEGATIONS.has(word);
const isCount = (word) => /\d/.test(word) || NUMBER_WORD_RE.test(word);
const isLetters = (word) => /^\p{L}+$/u.test(word);
const MODE_RANK = { plain: 0, planned: 1, denied: 2 };

// The mode a word opens for the rest of its clause, if any.
function opensMode(words, i) {
  if (SCOPED_NEGATIONS.has(words[i])) return 'denied';
  if (PLAN_WORDS.has(words[i]) && !(words[i] === 'next' && ['to', 'door'].includes(words[i + 1]))) return 'planned';
  return null;
}

// Whether a word is an action, on one side of the trace. In a note: a known
// verb ("treat", "swept"), so a note's denial runs to its next known verb
// and is never cut short. In a cleaned note also a word in -ed or -ing that
// does not follow a determiner ("pulled", never "the building" or "any
// damaged wood"), so a cleaned note's denial ends early and no claim hides
// in it.
function isAction(words, i, side) {
  if (ACTOR_STEMS.has(traceStem(words[i]))) return true;
  return side === 'text' && words[i].length > 4 && /(?:ed|ing)$/.test(words[i]) && !DETERMINERS.has(words[i - 1]);
}

// An action joined by "or" or "nor" shares the mode before it ("did not
// spray or bait"). In a note, so does a verb in its base form after "and"
// ("did not spray and bait"; "did not spray and baited" ends it).
function sharesMode(words, i, side) {
  const word = words[i];
  if (['or', 'nor'].includes(words[i - 1])) return true;
  return side === 'note' && words[i - 1] === 'and' && !/(?:ed|ing|s)$/.test(word) && !SAME_WORD[word];
}

// Who a clause names as the doer of an action: the nearest of the customer
// ("cust", "she", "you") and the technician ("I", "we") just before it.
function doerBefore(words, i, reach) {
  for (let at = i - 1; at >= Math.max(0, i - reach); at -= 1) {
    if (CUSTOMER_WORDS.has(words[at]) || words[at] === 'you') return 'customer';
    if (words[at] === 'i' || words[at] === 'we') return 'tech';
  }
  return null;
}

// Each word of one clause with its mode and, for an action, its doer. A
// stronger mode wins (denied over planned over plain). A subject right
// after an opener stays in its mode ("recommended they fix the leak").
function clauseWords(clause, side) {
  const words = traceWords(clause);
  let mode = 'plain';
  let headIsAction = false;
  return words.map((word, i) => {
    if (CLAUSE_TURNS.has(word) || (SUBJECTS.has(word) && !opensMode(words, i - 1))) mode = 'plain';
    else if (mode !== 'plain' && isAction(words, i, side) && !sharesMode(words, i, side)) {
      if (headIsAction) headIsAction = false;
      else mode = 'plain';
    }
    const opened = opensMode(words, i);
    if (opened && MODE_RANK[opened] >= MODE_RANK[mode]) {
      mode = opened;
      const head = words.findIndex((next, at) => at > i && statesSomething(next));
      headIsAction = head > 0 && isAction(words, head, side);
    }
    const stem = traceStem(word);
    return { word, stem, mode, doer: ACTOR_STEMS.has(stem) ? doerBefore(words, i, side === 'note' ? 2 : 3) : null };
  });
}

// A text's words, clause by clause; side is 'note' or 'text'.
const wordsInClauses = (text, side) => String(text || '').normalize('NFKC').split(/[.,;:!?()]+/)
  .flatMap((clause) => clauseWords(clause, side));

const appliedWord = ({ word, stem }) => APPLIED_VERB_STEMS.has(stem) || (APPLIED_NOUN_STEMS.has(stem) && /(?:ed|ing)$/.test(word));

// What the note said, as the trace needs it: each stem with the modes and
// doers the note gives it.
function readNote(note) {
  const words = wordsInClauses(note, 'note');
  const stems = new Map();
  // An action with no doer named is the technician's: the note is theirs.
  const add = (stem, { mode, doer }) => withTwins(stem).forEach((also) => {
    const entry = stems.get(also) || { modes: new Set(), doers: new Set() };
    entry.modes.add(mode);
    entry.doers.add(doer || 'tech');
    stems.set(also, entry);
  });
  // Stems a fixed error may sit one letter away from: the note's own words
  // that state something, never a count.
  const close = new Set();
  const applied = { modes: new Set(), doers: new Set() };
  words.forEach((entry, i) => {
    add(entry.stem, entry);
    if (statesSomething(entry.word) && entry.stem.length >= 4 && !isCount(entry.word)) close.add(entry.stem);
    // Two words the clean-up may write as one ("web worms", "webworms").
    const next = words[i + 1]?.word;
    if (next && isLetters(entry.word) && isLetters(next)) add(traceStem(`${entry.word}${next}`), entry);
    if (NUMBER_TWINS.has(entry.word)) add(traceStem(NUMBER_TWINS.get(entry.word)), entry);
    if (appliedWord(entry)) {
      applied.modes.add(entry.mode);
      applied.doers.add(entry.doer || 'tech');
    }
  });
  return {
    stems,
    close: [...close],
    hasContent: words.some((entry) => statesSomething(entry.word)),
    denies: words.some((entry) => NEGATIONS.has(entry.word)),
    // The customer speaking or seeing: "cust said", "customer still seeing",
    // "customer not seeing"; never "customer did not mention".
    customerSpoke: words.some((entry) => entry.doer === 'customer'
      && (SIGHT_STEMS.has(entry.stem) || (SPEECH_STEMS.has(entry.stem) && entry.mode === 'plain'))),
    applied: applied.modes.size ? applied : null,
  };
}

// Any mode and either doer: words that need no more than to be there.
const FREE = { modes: new Set(Object.keys(MODE_RANK)), doers: new Set(['tech', 'customer']) };

// The note's entry a word of the cleaned note traces to, or null.
function tracedEntry(words, i, said) {
  const { word, stem } = words[i];
  if (GLUE_WORDS.has(word)) return FREE;
  if (NEGATIONS.has(word)) return said.denies ? FREE : null;
  if (SIGHT_STEMS.has(stem) || SPEECH_STEMS.has(stem)) return heardOrSeenEntry(words[i], said);
  if (said.stems.has(stem)) return said.stems.get(stem);
  if (WORK_STEMS.has(stem) && said.applied) return said.applied;
  return respelledEntry(words, i, said);
}

// Seeing is how the technician knows the note: "ants in the kitchen" may
// become "I saw ants in the kitchen". The customer's words or seeing need the
// customer speaking or seeing in the note ("cust said", "customer still
// seeing"); the technician's words need the technician's own ("told them to
// vacuum").
function heardOrSeenEntry({ stem, doer }, said) {
  if (doer === 'customer') return said.customerSpoke ? FREE : null;
  if (SIGHT_STEMS.has(stem)) return FREE;
  return said.stems.get(stem) || (doer === null && said.customerSpoke ? FREE : null);
}

// The note's entry for a word the clean-up spelled another way: one word of
// the note written as two ("webworms", "web worms"; letters only, so "2-3"
// never becomes "23"), or one letter changed in a word of five letters or
// more, never a count.
function respelledEntry(words, i, said) {
  const { word, stem } = words[i];
  const pairs = [[word, words[i + 1]?.word], [words[i - 1]?.word, word]];
  const joined = pairs.find(([a, b]) => a && b && isLetters(a) && isLetters(b) && said.stems.has(traceStem(`${a}${b}`)));
  if (joined) return said.stems.get(traceStem(joined.join('')));
  if (stem.length < 5 || isCount(word)) return null;
  const near = said.close.find((other) => withinOneEdit(stem, other));
  return near ? said.stems.get(near) : null;
}

// The modes of the note a word of the cleaned note may stand on, by its own
// mode: said plainly only what the note says plainly; denied or planned also
// what the note says plainly.
const MODES_ALLOWED = { plain: ['plain'], planned: ['planned', 'plain'], denied: ['denied', 'plain'] };

// The words of a cleaned note that are not in the note, that say plainly
// what the note denies or plans, or that give work said as done to another
// doer. Empty = it adds none.
function untracedWords(text, note) {
  const said = readNote(note);
  const words = wordsInClauses(text, 'text');
  return [...new Set(words.filter((entry, i) => {
    const traced = tracedEntry(words, i, said);
    if (!traced) return true;
    if (!statesSomething(entry.word)) return false;
    if (!MODES_ALLOWED[entry.mode].some((mode) => traced.modes.has(mode))) return true;
    return entry.mode === 'plain' && Boolean(entry.doer) && !traced.doers.has(entry.doer);
  }).map((entry) => entry.word))];
}

// ── The screens ────────────────────────────────────────────────────────
// The report page has Ask Waves: the note never asks the customer to reach us.
const CONTACT_LINE_RE = /\b(?:text|call|contact|email|message)\s+(?:or\s+(?:text|call|email)\s+)?(?:us|me|the\s+office)\b|\breach\s+out\b|\bget\s+in\s+touch\b|\blet\s+(?:us|me)\s+know\b|\bgive\s+(?:us|me)\s+a\s+(?:call|text|ring)\b/i;
// The report adds the signature: "- Waves" or a name at the end is not text.
const SIGN_OFF_RE = /\s[-–—]\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\.?$/;
const REDACTED_RE = /\bredacted\b/i;
// Latin letters, digits, spaces, plain punctuation and the marks a field
// note uses (85°, 50%, station #4): no other symbol, emoji or script the
// screens cannot read.
const PLAIN_TEXT_RE = /^[\p{Script=Latin}\p{N}\s.,;:!?'’"“”()&/%#°–—-]+$/u;
const MAX_OWN_NOTE_SENTENCES = 3;

const oneLine = (value) => String(value || '').replace(/\s+/g, ' ').trim();
// The note as the trace reads it: an access code is redacted first, so a code
// can never trace.
const noteAsRead = (note) => redactAccessCodes(oneLine(String(note || '').normalize('NFKC')));
// The cleaned note as stored and screened. A line break stays in, so the
// shape screen refuses it.
function ownNoteText(value) {
  // NFKC first: the screens read the letters the trace reads ("ｓａｆｅ" is "safe").
  const text = String(value || '').normalize('NFKC').trim().replace(/[^\S\r\n]+/g, ' ').replace(/^["“”']+|["“”']+$/g, '').trim();
  // The weed is one word; written as two, the price screen reads "dollar".
  return lowercaseGermanRoach(text).replace(/\b(dollar)[ -](weeds?)\b/gi, '$1$2');
}

function shapeRejection(text) {
  if (!text) return { reason: 'empty' };
  if (REDACTED_RE.test(text)) return { reason: 'access_code' };
  if (/[\r\n]/.test(text) || SIGN_OFF_RE.test(text) || !PLAIN_TEXT_RE.test(text)) return { reason: 'shape' };
  if (text.length > MAX_OWN_NOTE_CHARS) return { reason: 'too_long' };
  // At least one sentence that states something, at most three.
  if (!traceWords(text).some(statesSomething)) return { reason: 'empty' };
  const sentences = text.split(/[.!?]+/).filter((sentence) => /[\p{L}\p{N}]/u.test(sentence));
  return sentences.length > MAX_OWN_NOTE_SENTENCES ? { reason: 'sentences' } : null;
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
  // A note with no word that states something gives a clean-up nothing to
  // trace: every text is refused, and the caller sends the fixed sentence.
  const noteHasContent = readNote(said).hasContent;
  return (value) => {
    if (!noteHasContent) return { reason: 'no_note' };
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
// recap, from the service name and the areas on the record. Those are free
// text, so the customer-copy screens run on it too; a sentence they refuse
// gives way to the one sentence that names neither.
const PLAIN_FIXED_NOTE = 'Today we completed your service.';
function fixedReportNote({ serviceType, areasServiced } = {}) {
  const text = CompletionRecap.deterministicRecap({ serviceType, areasTreated: areasServiced });
  return text && !customerCopyViolations(text).length ? text : PLAIN_FIXED_NOTE;
}

module.exports = {
  reportNoteRejection,
  fixedReportNote,
  ownNoteText,
  untracedWords,
  MAX_OWN_NOTE_CHARS,
};
