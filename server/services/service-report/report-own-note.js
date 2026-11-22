/**
 * The technician's own note as the report text: what code lets out (owner
 * 2026-11-19, "GO" on the report speed plan: *note I* and *read first*;
 * owner 2026-11-21: *same order*).
 *
 * A report's text is the note the technician gave, tidied: the technician's
 * sentences, with the technician's words in the technician's order. A model
 * call tidies the note (a later PR). This module decides whether a tidied
 * text may go out:
 *   - shape: plain text on one line, no sign-off, at most 600 characters
 *     (no sentence limit: the text has the note's sentences);
 *   - the report's own word screens: the screen the report reader runs again
 *     on every read (noteRecordCopyViolations), product, brand and
 *     active-ingredient names, the writer rules, a line that asks for contact;
 *   - same order (report-note-order.js orderRejection): the text's words
 *     are the note's words in the note's order, one sentence of the text for
 *     each sentence of the note it keeps.
 * A text that fails gets the fixed sentence (fixedReportNote).
 *
 * Known limits: report-note-order.js lists them. One more: a code that is a
 * plain word has no shape, so the stored-code check belongs to the code that
 * writes the note.
 *
 * The checks read the note, the text and the product catalog, and nothing
 * else about the visit, so a completion can run them again on the text the
 * technician read (reportNoteRejection) and get the same answer.
 */
const { redactAccessCodes } = require('../context-aggregator');
const CompletionRecap = require('../completion-recap');
const { noteRecordCopyViolations, CODE_SHAPED_NUMBER_RE } = require('./technician-report-copy');
const { writerRulesRejectionDetail, lowercaseGermanRoach } = require('./report-writer-rules');
const {
  orderRejection, noteWords, isCount, hideNumberMarks, showNumberMarks,
} = require('./report-note-order');

// The reader (technician-report-copy.js reportNoteCustomerCopy) allows more.
const MAX_OWN_NOTE_CHARS = 600;

// What is for the office alone: billing, the calendar, a remark about the
// customer. A text never holds one of these words, so a part of the note
// that holds one goes whole (the order check asks this screen), or the note
// gets the fixed sentence.
const OFFICE_ONLY_WORDS = new Set(`billing invoice invoiced payment paid reschedule rescheduled scheduled booked appointment
rude angry upset vacation`.split(/\s+/));

// An order to the customer, by what the part says. The first group always
// opens one. The second does only before what it acts on ("keep pets off",
// "water the lawn"): "water in the basement" is a finding, and "sprayed to
// keep the ants out" is the technician's own work. "Do not" opens one only
// before such a verb: "do not see activity in the attic" is a finding.
const ORDER_VERBS = new Set('avoid stay wait please remember'.split(' '));
const ORDER_VERBS_WITH_OBJECT = new Set('keep vacuum mop wipe mow water wash clean leave use open close lock'.split(' '));
const ORDER_OBJECT_LEADS = new Set('the your all any it them off away out pets kids children dogs'.split(' '));
const ORDER_TELLS = new Set('told advised advise asked recommend recommended need needs reminded'.split(' '));
function orderToCustomer(partWords) {
  const orderVerb = (word) => ORDER_VERBS.has(word) || ORDER_VERBS_WITH_OBJECT.has(word);
  const opensOrder = (i) => ORDER_VERBS.has(partWords[i])
    || (ORDER_VERBS_WITH_OBJECT.has(partWords[i]) && ORDER_OBJECT_LEADS.has(partWords[i + 1]));
  const leadsIn = (word, i) => ['should', 'must', 'please'].includes(word)
    || (word === 'to' && partWords.slice(0, i).some((earlier) => ORDER_TELLS.has(earlier)));
  return opensOrder(0) || (partWords[0] === 'do' && partWords[1] === 'not' && orderVerb(partWords[2]))
    || partWords.some((word, i) => leadsIn(word, i) && opensOrder(i + 1));
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
// "Pass phrase" is one word too: the redactor knows it only that way.
const dollarweedAsOneWord = (text) => text.replace(/\b(dollar)[ -](weeds?)\b/gi, '$1$2');
const passPhraseAsOneWord = (text) => text.replace(/\b(pass)[ -](phrases?|words?|codes?)\b/gi, '$1$2');
// A number shaped like a code is masked too, with no code word beside it
// ("used 4471 at the side"): the reader refuses it in any text, so no text
// loses a word it could keep, and no model reads it.
const CODE_SHAPED_RE = new RegExp(CODE_SHAPED_NUMBER_RE.source, 'giu');
const noteAsRead = (note) => dollarweedAsOneWord(redactAccessCodes(passPhraseAsOneWord(String(note || '')
  .replace(/[^\S\n]+/g, ' ').replace(/ ?\n[\n ]*/g, '\n').trim()))).replace(CODE_SHAPED_RE, '[redacted]');
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
// A word for the office alone.
const TIME_WORD_RE = /\b(?:minutes?|hours?|days?|weeks?|months?|years?|today|tonight|tomorrow|yesterday|overnight|daily|weekly|monthly|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|mornings?|afternoons?|evenings?|nights?|nightly|noon|midnight)\b/i;
const ORDER_OPENERS = new Set(`use wait keep stay avoid leave make remember try please do call contact enter press open close lock
vacuum wash mop wipe mow`.split(/\s+/));
const PASS_PHRASE_RE = /\bpass\s?phrases?\b|\bprompt(?:s|ed|ing)?\b/i;
function writeTimeRejection(text) {
  const time = TIME_WORD_RE.exec(text);
  if (time) return { reason: 'time', words: [time[0]] };
  if (PASS_PHRASE_RE.test(text)) return { reason: 'access_code' };
  const office = noteWords(text).find((word) => OFFICE_ONLY_WORDS.has(word));
  if (office) return { reason: 'not_for_customer', words: [office] };
  const order = hideNumberMarks(text).split(/[.;!?,:\n]+/).map((part) => noteWords(showNumberMarks(part)))
    .find((partWords) => ORDER_OPENERS.has(partWords[0]) || orderToCustomer(partWords));
  return order ? { reason: 'instruction', words: [order[0]] } : null;
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

// What the text may leave out of the note is what no report text may hold:
// the same screens, asked about one word, two words, or one whole part.
//   - One word goes when it names a thing the report never names: a product,
//     an active ingredient, a word of access, a word of time. A word that
//     states a result ("gone", "eliminated", "safe") never goes alone:
//     "roaches eliminated in kitchen" is not "roaches in kitchen". Its part
//     goes whole.
//   - Two words go together: a refused pair, a figure with its unit or period.
//   - A part goes whole when the screens refuse it as a text, when it holds a
//     removed code, or when it is an order to the customer. Not for the
//     screen that reads how a part opens: "open gap under the sink" is a
//     finding.
const GOES_ALONE = new Set(['trade_name', 'active_ingredient', 'access_code', 'time']);
// The words of a product name that go together. A name that ends in plain
// report words the product screen lets stand ("Advion Gel") goes by its own
// words, and the plain word stays: "put down some advion gel" may be "I put
// down some gel".
function nameThatGoes(name) {
  const words = noteWords(name);
  const own = words.filter((word) => !CompletionRecap.REPORT_GENERIC_PRODUCT_TOKENS.has(word));
  return own.length && own.every((word, i) => word === words[i]) ? own.join(' ') : name;
}
const REFUSED_PAIRS = ['no issues', 'no issue', 'no problems', 'no problem', 'pest free', 'non toxic'];
const PERIOD_RE = /^(?:minutes?|hours?|days?|weeks?|months?|years?)$/;
function whatMayGo(screens, names) {
  const reasonOf = (fragment) => wordRejection(fragment, screens)?.reason || null;
  const figure = (word) => word.replace('point', '.').replace(/mark(\d+)mark/g, (_, code) => String.fromCodePoint(Number(code)));
  return {
    wordGoes: (word) => word === 'redacted' || GOES_ALONE.has(reasonOf(word)),
    pairGoes: (first, second) => REFUSED_PAIRS.includes(`${first} ${second}`)
      || (isCount(first) && !isCount(second) && (PERIOD_RE.test(second) || reasonOf(`${figure(first)} ${second}`) === 'amount')),
    partGoes: (part) => {
      const reason = reasonOf(part);
      return REDACTED_RE.test(part) || (Boolean(reason) && reason !== 'instruction') || orderToCustomer(noteWords(part));
    },
    names,
  };
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
    || orderRejection(tidied, said, whatMayGo(screens, mentioned.names.map(nameThatGoes)));
}

// The sentence code writes when there is no note to send: today's fallback
// recap, from the service name, the areas and the visit outcome on the record
// (an inspection or a declined visit never reads as a treatment).
function fixedReportNote({ serviceType, areasServiced, visitOutcome } = {}) {
  return CompletionRecap.deterministicRecap({ serviceType, areasTreated: areasServiced, visitOutcome });
}

module.exports = {
  reportNoteRejection,
  fixedReportNote,
  ownNoteText,
  noteAsRead,
  MAX_OWN_NOTE_CHARS,
};
