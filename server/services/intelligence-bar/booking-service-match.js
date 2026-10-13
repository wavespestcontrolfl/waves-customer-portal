// Close-name resolution of a service for create_appointment.
//
// The owner dictates a service the way he says it ("a pre-slab termite
// treatment"), not as the catalog spells it ("Slab Pre-Treat Termite
// Service"). The exact-name resolver in tools.js (resolveBookingCatalogRow)
// stays the first and only authority for an exact name; this module is its
// fallback, asked ONLY when the exact resolver found nothing. A wrong service
// on a booking card is worse than a question, so it never guesses.
//
// The rule, by accounting for words (pure, no I/O):
//   1. Every non-generic word the operator said must match a word of the
//      service's name (or short name). A word the service lacks puts that
//      service out. "annual pest control" fits no row that has no annual word.
//   2. A match is an equal stem, or one wrong letter in a word of 6+ letters
//      (a misspelling). A cadence word (one-time, quarterly, monthly,
//      bi-monthly, annual, ...) is first turned into one canonical token and
//      must be EQUAL: "bi-monthly" never matches "monthly".
//   3. Two spoken words may join to one name word and the reverse
//      ("pre treat" / "pretreat"; name "Pre-Treat" / said "pretreat").
//   4. Generic words (a, the, service, treatment, visit, job, appointment,
//      for, at, today ...) are ignored on both sides.
//   5. Several rows fit: return them as choices. One row fits: it resolves
//      unless the service's FULL identity carries a cadence the operator did
//      not say ("pest control" must not become the one-time service, "a lawn
//      care treatment" not the bi-monthly one); then the call returns
//      nothing. The identity is the union of the cadence words in the name,
//      in the short name and in the services.frequency column, whichever
//      alias the operator's words matched.
//
// "Defining" words are found from the catalog by the fit itself, with no list:
// a word the operator said that a row lacks puts that row out, and the rows
// left are the ones that share everything he said, so a word that still
// differs between them (a cadence, a service line, a treatment type) shows up
// as several choices. The one place a single fit is not enough is cadence,
// which is the word a catalog most often drops (a retired or missing row),
// so an unsaid cadence is checked directly. Only cadence wording is
// normalized, because its synonyms ("single", "yearly") and hyphenated
// forms ("bi-monthly") are the ones that collide.

const { levenshtein } = require('./name-match');

const MAX_CANDIDATES = 5;
const MIN_FUZZY_LENGTH = 6;

const GENERIC_WORDS = new Set([
  'a', 'an', 'the', 'and', 'of', 'for', 'at', 'on', 'today', 'please', 'new',
  'service', 'treat', 'treatment', 'visit', 'job', 'appointment',
]);

// Phrase -> canonical cadence token; the first match wins, so "bi-monthly" is
// taken before "monthly" and "semi-annual" before "annual".
const CADENCE_PATTERNS = [
  [/\bbi[\s-]?monthly\b|\bevery (?:other|2|two) months?\b/g, 'cad:bimonthly'],
  [/\bbi[\s-]?weekly\b|\bevery (?:other|2|two) weeks?\b/g, 'cad:biweekly'],
  [/\bsemi[\s-]?annual(?:ly)?\b|\btwice (?:a|per) year\b/g, 'cad:semiannual'],
  [/\bone[\s-]?time\b|\bonce\b|\bsingle\b/g, 'cad:onetime'],
  [/\bquarterly\b/g, 'cad:quarterly'],
  [/\bmonthly\b/g, 'cad:monthly'],
  [/\bweekly\b/g, 'cad:weekly'],
  [/\bannual(?:ly)?\b|\byearly\b|\bevery year\b/g, 'cad:annual'],
  [/\bseasonal\b/g, 'cad:seasonal'],
  [/\bevery[\s-]?(\d+)[\s-]?(day|week|month)s?\b/g, 'cad:every$1$2'],
];
// Long cadence words a dictation may misspell by one letter ("quartely").
const MISSPELLABLE_CADENCE = ['quarterly', 'bimonthly', 'biweekly', 'semiannual', 'annually'];

const ONE_TIME_CADENCE = 'cad:onetime';
const isCadence = (token) => token.startsWith('cad:');

function repairCadenceSpelling(text) {
  return text.replace(/[a-z]{8,}/g, (word) => MISSPELLABLE_CADENCE.find((c) => levenshtein(word, c) === 1) || word);
}

function canonicalCadence(text) {
  return CADENCE_PATTERNS.reduce((acc, [pattern, token]) => acc.replace(pattern, ` ${token} `), repairCadenceSpelling(text));
}

// "treatment" -> "treat", "pretreatment" -> "pretreat", "shrubs" -> "shrub".
function stem(token) {
  if (isCadence(token)) return token;
  if (token.length > 7 && token.endsWith('ment')) return token.slice(0, -4);
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function phraseTokens(text) {
  return canonicalCadence(String(text || '').toLowerCase()).split(/[^a-z0-9:]+/).filter(Boolean).map(stem);
}

function sameWord(a, b) {
  if (a === b) return true;
  if (isCadence(a) || isCadence(b)) return false;
  return Math.min(a.length, b.length) >= MIN_FUZZY_LENGTH && levenshtein(a, b) <= 1;
}

// The words a phrase offers to match against: its non-generic words plus every
// pair of neighbours joined ("pre" + "treat" -> "pretreat").
function matchUnits(tokens) {
  const singles = tokens.filter((t) => !GENERIC_WORDS.has(t));
  const joined = tokens.slice(1).map((t, i) => tokens[i] + t).filter((pair) => !pair.includes(':'));
  return [...singles, ...joined];
}

// Per word of `tokens`: is it accounted for by the words of `other`? Generic
// words always are. A joined pair that matches marks both of its words.
function accountedWords(tokens, other) {
  const units = matchUnits(other);
  const found = (word) => units.some((unit) => sameWord(word, unit));
  const done = tokens.map((t) => GENERIC_WORDS.has(t));
  tokens.forEach((t, i) => {
    if (found(t)) done[i] = true;
    const next = tokens[i + 1];
    if (next !== undefined && !isCadence(t) && !isCadence(next) && found(t + next)) { done[i] = true; done[i + 1] = true; }
  });
  return done;
}

// The name words the search left out, or null when the search has a word the
// name lacks (the row is out).
function unsaidWords(searchTokens, nameTokens) {
  if (!accountedWords(searchTokens, nameTokens).every(Boolean)) return null;
  const done = accountedWords(nameTokens, searchTokens);
  return nameTokens.filter((_, i) => !done[i]);
}

// A row answers to its name and its short name; the closer one counts.
function rowUnsaid(searchTokens, row) {
  const fits = [row.name, row.short_name].filter(Boolean)
    .map((name) => unsaidWords(searchTokens, phraseTokens(name))).filter((words) => words !== null);
  return fits.length ? fits.reduce((best, words) => (words.length < best.length ? words : best)) : null;
}

// The cadences a service is sold at: the cadence words of its name and short
// name, plus the services.frequency column ("quarterly", "every_6_weeks").
// "one_time" in the column adds nothing (a slab pre-treat has no cadence to
// omit); a One-Time in the NAME is a cadence the operator must have said.
function identityCadences(row) {
  const fromColumn = row.frequency ? phraseTokens(String(row.frequency).replace(/_/g, ' ')).filter((t) => t !== ONE_TIME_CADENCE) : [];
  return new Set([row.name, row.short_name].flatMap(phraseTokens).concat(fromColumn).filter(isCadence));
}

// True when the service is sold at a cadence the operator did not say.
function hasUnsaidCadence(searchTokens, row) {
  return [...identityCadences(row)].some((t) => !searchTokens.includes(t));
}

// Returns { row } for one safe match, { candidates: [row, ...] } when several
// services fit what was said, or { row: null } when none does.
function resolveCloseCatalogService(services, serviceType) {
  const search = phraseTokens(serviceType);
  if (!Array.isArray(services) || search.every((t) => GENERIC_WORDS.has(t))) return { row: null };
  const fits = services
    .map((row) => ({ row, unsaid: rowUnsaid(search, row) }))
    .filter((fit) => fit.unsaid !== null)
    .sort((a, b) => a.unsaid.length - b.unsaid.length || String(a.row.name).localeCompare(String(b.row.name)));
  if (fits.length > 1) return { candidates: fits.slice(0, MAX_CANDIDATES).map((fit) => fit.row) };
  return fits.length === 1 && !hasUnsaidCadence(search, fits[0].row) ? { row: fits[0].row } : { row: null };
}

module.exports = { resolveCloseCatalogService, phraseTokens, MAX_CANDIDATES, MIN_FUZZY_LENGTH };
