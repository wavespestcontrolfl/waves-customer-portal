/**
 * Everyday-word vocabulary for discover_capabilities (owner IB history
 * 2026-10-12: "book a visit", "upgrade him to gold", "put a note on his
 * account", "change the tech on Friday" and "what did he say on the call"
 * all missed the tool that exists, because the matcher scored exact word
 * overlap with the tool's id, domain and description).
 *
 * Two small pieces, both applied to the query AND to each tool's words so the
 * two sides always agree:
 *   - stem(): plural s/es, -ing, -ed and a trailing e. It only has to be
 *     consistent; the stems are never shown to anyone.
 *   - SYNONYMS: one table from an everyday word to the words the tool names
 *     and descriptions actually use. Every target below was checked against
 *     the real tool ids and descriptions in action-policy.json and the tool
 *     modules. A word with no tool behind it stays out (there is no SMS
 *     template tool, so "template" is not listed): a synonym must never make
 *     an unsupported capability look supported.
 */

// Plural forms: queries -> query, boxes -> box, moves -> move.
function singular(word) {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (/(ss|us|is)$/.test(word)) return word;
  if (/(ch|sh|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

// One stem for the base, -ing and -ed forms of a verb: move, moving and moved
// all land on "move"; schedule, scheduling and scheduled on "schedul". A base
// word loses a trailing e only when it has five or more letters; an inflected
// form whose stem is left with three letters or fewer gets the e back (mov ->
// move, not -> note), so a short verb cannot split in two or collide with
// "not". The stems are never shown to anyone, they only have to agree.
function stem(word) {
  if (word.length <= 3 || /\d/.test(word)) return word;
  const s = singular(word);
  const ending = /(ing|ed)$/.exec(s);
  if (ending && s.length > (ending[1] === 'ing' ? 5 : 4)) {
    const base = s.slice(0, -ending[1].length);
    if (/([^aeioul])\1$/.test(base)) return base.slice(0, -1);
    return base.length <= 3 ? `${base}e` : base;
  }
  return s.length > 4 && s.endsWith('e') ? s.slice(0, -1) : s;
}

// everyday word(s) -> words used by tool ids and descriptions.
const SYNONYM_GROUPS = [
  ['book visit job', 'appointment create'],
  ['schedule', 'appointment'],
  ['move push bump', 'reschedule appointment'],
  ['tier gold silver bronze platinum upgrade downgrade', 'update customer waveguard tier'],
  ['note', 'update customer'],
  ['change edit fix correct', 'update'],
  ['text message', 'sms'],
  ['card autopay', 'payment method'],
  ['tech', 'technician assign'],
  ['property address house', 'property'],
  ['call recording transcript', 'call log transcript'],
  ['estimate quote proposal', 'estimate'],
  ['invoice bill', 'invoice'],
  ['lead prospect', 'lead'],
  ['stock inventory product', 'stock'],
  ['client homeowner account', 'customer'],
];

const SYNONYMS = new Map();
for (const [keys, targets] of SYNONYM_GROUPS) {
  const stems = targets.split(' ').map(stem);
  for (const key of keys.split(' ')) SYNONYMS.set(stem(key), stems);
}

function words(text) {
  return String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
}

// Stemmed word set of a tool (or any text), for exact whole-word comparison.
function stemmedWordSet(text) {
  return new Set(words(text).map(stem));
}

// Query terms (stopwords already removed by the caller) plus their synonyms.
function expandTerms(terms) {
  const out = new Set();
  for (const term of terms) {
    const stemmed = stem(term);
    out.add(stemmed);
    for (const target of SYNONYMS.get(stemmed) || []) out.add(target);
  }
  return out;
}

module.exports = { stem, stemmedWordSet, expandTerms, words, SYNONYMS, SYNONYM_GROUPS };
