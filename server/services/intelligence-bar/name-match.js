// Sound-alike / close-spelling ranking for customer name search.
//
// The Intelligence Bar is driven by voice dictation, so a name reaches
// query_customers misspelled ("Phoebe" for "Fybi", "S-I-V-I" spelled out).
// This module is the pure scoring half of the fallback that runs when the
// exact ILIKE search finds nothing: it scores a light candidate list
// (id + name columns) in Node, because pg_trgm / fuzzystrmatch are not
// installed and a migration is not worth it for a rescue path.
//
// No dependencies, no I/O.

const MAX_RESULTS = 5;
const MIN_SCORE = 0.75; // mean token score a customer needs to be returned
const MIN_TOKEN_SCORE = 0.5; // every search word needs at least this much
const PHONETIC_EQUAL = 0.9; // same sound, different spelling
const PHONETIC_PARTIAL = 0.85; // scaled by how close the sound keys are

// Words that say nothing about who the customer is.
const STOPWORDS = new Set(['llc', 'inc', 'co', 'corp', 'company', 'ltd', 'the', 'and', 'of']);

function stripAccents(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// "S-I-V-I", "s i v i", "F.I.B.I" -> one word. Needs three or more single
// letters in a row so "J R Smith" style initials are only joined when long.
function collapseSpelledLetters(text) {
  return text.replace(/\b[a-z](?:[\s.-]+[a-z]){2,}\b/g, (run) => run.replace(/[\s.-]+/g, ''));
}

function tokenize(text) {
  const lowered = stripAccents(text).toLowerCase();
  const tokens = collapseSpelledLetters(lowered).split(/[^a-z0-9]+/).filter(Boolean);
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  return meaningful.length ? meaningful : tokens;
}

// True when the text looks like a name, not a phone, email or address.
function isNameLikeSearch(search) {
  const text = String(search || '');
  if (!text.trim() || text.includes('@')) return false;
  const letters = (text.match(/[a-z]/gi) || []).length;
  const digits = (text.match(/\d/g) || []).length;
  return letters >= 2 && digits <= letters;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest ? 1 - levenshtein(a, b) / longest : 1;
}

// Ordered spelling-to-sound rewrites (a small Metaphone). 'X' stands for the
// "sh" / "ch" sound so it cannot be confused with a written x.
const SOUND_RULES = [
  [/^(?:kn|gn|pn)/, 'n'], [/^wr/, 'r'], [/^wh/, 'w'], [/^x/, 's'],
  [/ph/g, 'f'], [/ght/g, 't'], [/ck/g, 'k'], [/dg/g, 'j'], [/sch/g, 'sk'],
  [/ch(?=r)/g, 'k'], [/tch|sh|ch/g, 'X'], [/th/g, 't'], [/c(?=[eiy])/g, 's'],
  [/[cq]/g, 'k'], [/z/g, 's'], [/x/g, 'ks'], [/v/g, 'f'],
];

// Consonant skeleton: "Phoebe" and "Fybi" both become "fb".
function phoneticKey(word) {
  let w = stripAccents(word).toLowerCase().replace(/[^a-z]/g, '');
  for (const [pattern, replacement] of SOUND_RULES) w = w.replace(pattern, replacement);
  let key = '';
  for (let i = 0; i < w.length; i += 1) {
    const c = w[i];
    const vowel = 'aeiou'.includes(c);
    const soft = 'hyw'.includes(c); // only sounded at the start of a word
    if (vowel) key += i === 0 ? 'a' : '';
    else if (soft) key += i === 0 && 'aeiou'.includes(w[1] || '') ? c : '';
    else if (c !== key[key.length - 1]) key += c;
  }
  return key;
}

function phoneticSimilarity(keyA, keyB) {
  if (!keyA || !keyB) return 0;
  if (keyA === keyB) return keyA.length > 1 ? PHONETIC_EQUAL : PHONETIC_EQUAL * 0.6;
  if (Math.min(keyA.length, keyB.length) < 2) return 0;
  return PHONETIC_PARTIAL * similarity(keyA, keyB);
}

// How well one search word matches one customer word, 0..1.
// Words of three letters or fewer match on spelling only when equal; one
// wrong letter is too large a share of a short word.
function wordSimilarity(a, b, keyOf) {
  if (a === b) return 1;
  const spelled = Math.max(a.length, b.length) <= 3 ? 0 : similarity(a, b);
  return Math.max(spelled, phoneticSimilarity(keyOf(a), keyOf(b)));
}

function customerTokens(candidate) {
  return tokenize([candidate.first_name, candidate.last_name, candidate.company_name].filter(Boolean).join(' '));
}

function scoreCandidate(searchTokens, tokens, keyOf) {
  let total = 0;
  for (const word of searchTokens) {
    let best = 0;
    for (const token of tokens) best = Math.max(best, wordSimilarity(word, token, keyOf));
    if (best < MIN_TOKEN_SCORE) return 0;
    total += best;
  }
  return total / searchTokens.length;
}

// Rank candidates ({ id, first_name, last_name, company_name }) against a
// dictated search string. Returns [{ id, score }] best first, at most
// `limit`, each at or above `minScore`.
function rankNameMatches(search, candidates, { limit = MAX_RESULTS, minScore = MIN_SCORE } = {}) {
  const searchTokens = tokenize(search);
  if (!searchTokens.length) return [];
  const keys = new Map();
  const keyOf = (word) => {
    if (!keys.has(word)) keys.set(word, phoneticKey(word));
    return keys.get(word);
  };
  const scored = [];
  for (const candidate of candidates) {
    const score = scoreCandidate(searchTokens, customerTokens(candidate), keyOf);
    if (score >= minScore) scored.push({ id: candidate.id, score: Math.round(score * 1000) / 1000 });
  }
  return scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

module.exports = {
  MAX_RESULTS, MIN_SCORE, tokenize, isNameLikeSearch, phoneticKey, levenshtein, wordSimilarity, rankNameMatches,
};
