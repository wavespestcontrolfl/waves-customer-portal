// Sound-alike / close-spelling ranking for customer name search.
//
// The Intelligence Bar is driven by voice dictation, so a name reaches
// query_customers misspelled ("Phoebe" for "Fybi", "S-I-V-I" spelled out).
// This module is the pure scoring half of the fallback that runs when the
// exact ILIKE search finds nothing: it scores a light candidate list
// (id + name columns) in Node, because pg_trgm / fuzzystrmatch are not
// installed and a migration is not worth it for a rescue path.
//
// Accent / letter folding comes from the shared server/utils/name-match.js so
// there is one folding policy. No I/O.

const { foldNameLetters } = require('../../utils/name-match');
const { doubleMetaphone } = require('../../utils/double-metaphone');

const MAX_RESULTS = 5;
const MIN_SCORE = 0.75; // mean token score a customer needs to be returned
const MIN_TOKEN_SCORE = 0.5; // every search word needs at least this much
const PHONETIC_EQUAL = 0.9; // same sound, different spelling
const PHONETIC_PARTIAL = 0.85; // scaled by how close the sound keys are

// Name matcher v2 (GATE_NAME_MATCH_V2). The caller passes `v2: true`; this
// module never reads the gate, so off is the scoring above, untouched.
const MAX_RESULTS_V2 = 8;
const METAPHONE_PRIMARY = 0.9; // primary key equals primary key
const METAPHONE_ALTERNATE = 0.85; // primary equals the other word's secondary key
const TOLERANT_KEY = 0.8; // equal after the sound-alike tolerances below
const CONTEXT_FLOOR = 0.65; // a context bonus lets a weaker spelling through
const FIRST_TOKEN_FLOOR = 0.6; // the first search word matched exactly
const FIRST_TOKEN_OTHER_WORD = 0.3; // then the other words need only this much
const CONTEXT_BONUS = { on_screen: 0.15, visit_soon: 0.10, recent_contact: 0.05 };

// Words that say nothing about who the customer is.
const STOPWORDS = new Set(['llc', 'inc', 'co', 'corp', 'company', 'ltd', 'the', 'and', 'of']);

// "S-I-V-I", "s i v i", "F.I.B.I" -> one word. Needs three or more single
// letters in a row so "J R Smith" style initials are only joined when long.
function collapseSpelledLetters(text) {
  return text.replace(/\b[a-z](?:[\s.-]+[a-z]){2,}\b/g, (run) => run.replace(/[\s.-]+/g, ''));
}

// v2 only: "Richard's dump" is the possessive of a spoken name. Drop the 's
// (straight or curly apostrophe) so it is not a required search word of its own.
function stripPossessives(lowered) {
  return lowered.replace(/[\u2019\u2018`']s\b/g, '');
}

function tokenize(text, { v2 = false } = {}) {
  let lowered = foldNameLetters(text).toLowerCase();
  if (v2) lowered = stripPossessives(lowered);
  let tokens = collapseSpelledLetters(lowered).split(/[^a-z0-9]+/).filter(Boolean);
  // v2: a lone "s" is what dictation leaves of "Richard's" ("richard s dump").
  if (v2) tokens = tokens.filter((t) => t !== 's');
  const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
  return meaningful.length ? meaningful : tokens;
}

// True when the text looks like a name, not a phone, email or address.
// Any digit rules it out: dictated person and company names almost never
// carry one, and "123 Main St" has more letters than digits. The exact search
// still serves a name that does.
function isNameLikeSearch(search) {
  const text = String(search || '');
  if (text.includes('@') || /\d/.test(text)) return false;
  return (text.match(/[a-z]/gi) || []).length >= 2;
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
  let w = foldNameLetters(word).toLowerCase().replace(/[^a-z]/g, '');
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
  return Math.max(spelled, prefixSimilarity(a, b), phoneticSimilarity(keyOf(a), keyOf(b)));
}

// A short form shares its start with the full name ("Sam" / "Samuel" style
// pairs score low on edit distance). Needs three shared leading letters;
// scores 0.6 to 0.9 by how much of the shorter word they cover.
function prefixSimilarity(a, b) {
  const shorter = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < shorter && a[shared] === b[shared]) shared += 1;
  return shared >= 3 ? 0.6 + 0.3 * (shared / shorter) : 0;
}

function customerTokens(candidate, options) {
  return tokenize([candidate.first_name, candidate.last_name, candidate.company_name].filter(Boolean).join(' '), options);
}

// One-to-one: a customer word can satisfy at most one search word, so a
// short first name cannot also stand in for a longer last name that begins the
// same way. Pairs are taken best first; any search word left unmatched fails
// the customer.
function scoreCandidate(searchTokens, tokens, keyOf) {
  const pairs = [];
  searchTokens.forEach((word, i) => tokens.forEach((token, j) => {
    const score = wordSimilarity(word, token, keyOf);
    if (score >= MIN_TOKEN_SCORE) pairs.push({ score, i, j });
  }));
  pairs.sort((a, b) => b.score - a.score);
  const usedWords = new Set();
  const usedTokens = new Set();
  let total = 0;
  for (const { score, i, j } of pairs) {
    if (usedWords.has(i) || usedTokens.has(j)) continue;
    usedWords.add(i);
    usedTokens.add(j);
    total += score;
  }
  return usedWords.size === searchTokens.length ? total / searchTokens.length : 0;
}

// ─── Name matcher v2 ─────────────────────────────────────────────

// A short form or full form shares its end with the other word. Mirrors
// prefixSimilarity: three shared trailing letters, 0.6 to 0.9 by how much of
// the shorter word they cover.
function suffixSimilarity(a, b) {
  const shorter = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < shorter && a[a.length - 1 - shared] === b[b.length - 1 - shared]) shared += 1;
  return shared >= 3 ? 0.6 + 0.3 * (shared / shorter) : 0;
}

// Sound-alike classes for the tolerant key: a voiced and an unvoiced stop are
// one sound to a dictation engine (d/t, b/p, g/k, v/f, z/s), and the p/f pair
// joins them so "Stumpf" ("pf" said as "f") equals "dump".
const TOLERANT_CLASS = {
  D: 'T', B: 'P', V: 'P', F: 'P', G: 'K', Z: 'S',
};

// Spelling tolerances applied before the sound key: "pf" is said "f", and an
// initial s+consonant cluster may lose its s (Stumpf / Tumpf, School / Kool).
function tolerantKey(word) {
  let w = foldNameLetters(word).toLowerCase().replace(/[^a-z]/g, '');
  w = w.replace(/pf/g, 'f');
  if (/^st/.test(w) && w.length > 3) w = w.slice(1);
  else if (/^sch/.test(w) && w.length > 4) w = `k${w.slice(3)}`;
  const [primary] = doubleMetaphone(w);
  return primary.replace(/[DBVFGZ]/g, (c) => TOLERANT_CLASS[c]);
}

function tolerantSimilarity(keyA, keyB) {
  if (!keyA || !keyB) return 0;
  if (keyA === keyB) return keyA.length >= 2 ? TOLERANT_KEY : 0;
  const [shorter, longer] = keyA.length <= keyB.length ? [keyA, keyB] : [keyB, keyA];
  // A dropped final consonant or two ("Stump" for "Stumps").
  return shorter.length >= 3 && longer.length - shorter.length <= 2 && longer.startsWith(shorter) ? TOLERANT_KEY : 0;
}

// v2 word score: the v1 score, or a better one from Double Metaphone, the
// tolerant key, or a shared ending. `sounds` caches the keys per word.
function wordSimilarityV2(a, b, keyOf, soundsOf) {
  const base = wordSimilarity(a, b, keyOf);
  if (base >= 1) return base;
  let best = Math.max(base, suffixSimilarity(a, b));
  if (Math.min(a.length, b.length) >= 3) {
    const sa = soundsOf(a);
    const sb = soundsOf(b);
    if (sa.dm[0].length >= 2 && sb.dm[0].length >= 2) {
      if (sa.dm[0] === sb.dm[0]) best = Math.max(best, METAPHONE_PRIMARY);
      else if (sa.dm[0] === sb.dm[1] || sa.dm[1] === sb.dm[0] || sa.dm[1] === sb.dm[1]) best = Math.max(best, METAPHONE_ALTERNATE);
    }
    best = Math.max(best, tolerantSimilarity(sa.tolerant, sb.tolerant));
  }
  return best;
}

// "Mac Donald" / "McDonald", "Anne-Marie" / "Annemarie": the same words with
// one adjacent pair run together. Tried alongside the words as spoken. A run
// together word carries the MERGED marker so it is compared as a whole word
// (see mergedSimilarity), never by prefix: "richarddump" must not pass for "Rick".
const MERGED = '~';
function tokenVariants(tokens) {
  const variants = [tokens];
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    variants.push([...tokens.slice(0, i), MERGED + tokens[i].replace(MERGED, '') + tokens[i + 1].replace(MERGED, ''), ...tokens.slice(i + 2)]);
  }
  return variants;
}

// Whole-word match for a run together word: spelling, sound key, Double
// Metaphone or the tolerant key, but no prefix, suffix or dropped-consonant
// rule, and it must be a close match (0.8 or better) because one merged word
// counts as two spoken words.
const MERGED_MIN = 0.8;
function mergedSimilarity(a, b, keyOf, soundsOf) {
  if (a === b) return 1;
  let best = Math.max(similarity(a, b), phoneticSimilarity(keyOf(a), keyOf(b)));
  const sa = soundsOf(a);
  const sb = soundsOf(b);
  if (sa.dm[0].length >= 2 && sb.dm[0].length >= 2) {
    if (sa.dm[0] === sb.dm[0]) best = Math.max(best, METAPHONE_PRIMARY);
    else if (sa.dm[0] === sb.dm[1] || sa.dm[1] === sb.dm[0] || sa.dm[1] === sb.dm[1]) best = Math.max(best, METAPHONE_ALTERNATE);
  }
  if (sa.tolerant.length >= 2 && sa.tolerant === sb.tolerant) best = Math.max(best, TOLERANT_KEY);
  return best >= MERGED_MIN ? best : 0;
}

// Same one-to-one pairing as scoreCandidate. Also says whether the first
// search word matched a customer word exactly.
function scoreCandidateV2(searchTokens, tokens, simFn, minToken = MIN_TOKEN_SCORE) {
  const pairs = [];
  searchTokens.forEach((word, i) => tokens.forEach((token, j) => {
    const score = simFn(word, token);
    if (score >= minToken) pairs.push({ score, i, j });
  }));
  pairs.sort((a, b) => b.score - a.score);
  const usedWords = new Set();
  const usedTokens = new Set();
  let total = 0;
  let firstExact = false;
  for (const { score, i, j } of pairs) {
    if (usedWords.has(i) || usedTokens.has(j)) continue;
    usedWords.add(i);
    usedTokens.add(j);
    total += score;
    if (i === 0 && score >= 1) firstExact = true;
  }
  if (usedWords.size !== searchTokens.length) return { score: 0, firstExact: false };
  return { score: total / searchTokens.length, firstExact };
}

function contextHas(set, id) {
  return !!set && typeof set.has === 'function' && set.has(id);
}

// Which context bonuses a customer earns, as a list of reason names.
function contextReasons(context, id) {
  if (!context) return [];
  const reasons = [];
  if (context.onScreenCustomerId != null && String(context.onScreenCustomerId) === String(id)) reasons.push('on_screen');
  if (contextHas(context.visitTodayIds, id)) reasons.push('visit_soon');
  if (contextHas(context.recentContactIds, id)) reasons.push('recent_contact');
  return reasons;
}

// Work budget (Codex #6367 security P2): a spoken name is a few short words.
// A longer search is not a name and is not ranked; candidate names and words
// are clipped so one request cannot stall the process.
const MAX_SEARCH_CHARS = 120;
const MAX_SEARCH_TOKENS = 6;
const MAX_CANDIDATE_TOKENS = 8;
const MAX_WORD_CHARS = 32;
const clipWords = (tokens, max) => tokens.slice(0, max).map((t) => t.slice(0, MAX_WORD_CHARS));

function rankNameMatchesV2(search, candidates, { limit, minScore, context }) {
  if (typeof search !== 'string' || search.length > MAX_SEARCH_CHARS) return [];
  const searchTokens = tokenize(search, { v2: true });
  if (searchTokens.length > MAX_SEARCH_TOKENS) return [];
  const searchVariants = tokenVariants(clipWords(searchTokens, MAX_SEARCH_TOKENS));
  if (!searchVariants[0].length) return [];
  const keys = new Map();
  const keyOf = (word) => {
    if (!keys.has(word)) keys.set(word, phoneticKey(word));
    return keys.get(word);
  };
  const sounds = new Map();
  const soundsOf = (word) => {
    if (!sounds.has(word)) sounds.set(word, { dm: doubleMetaphone(word), tolerant: tolerantKey(word) });
    return sounds.get(word);
  };
  // Customer names repeat ("Smith"), so each word pair is scored once.
  const pairScores = new Map();
  const simFn = (a, b) => {
    const key = `${a}|${b}`;
    let score = pairScores.get(key);
    if (score === undefined) {
      score = a[0] === MERGED || b[0] === MERGED
        ? mergedSimilarity(a.replace(MERGED, ''), b.replace(MERGED, ''), keyOf, soundsOf)
        : wordSimilarityV2(a, b, keyOf, soundsOf);
      pairScores.set(key, score);
    }
    return score;
  };
  const floorWithContext = Math.min(minScore, CONTEXT_FLOOR);
  const floorFirstToken = Math.min(minScore, FIRST_TOKEN_FLOOR);
  const scored = [];
  for (const candidate of candidates) {
    const candidateVariants = tokenVariants(clipWords(customerTokens(candidate, { v2: true }), MAX_CANDIDATE_TOKENS));
    let base = 0;
    let firstExact = false;
    for (const sv of searchVariants) {
      for (const cv of candidateVariants) {
        const result = scoreCandidateV2(sv, cv, simFn);
        if (result.score > base) { base = result.score; firstExact = result.firstExact; }
      }
    }
    // The first word is exact but the rest is garbled: still worth a choice.
    const first = searchVariants[0];
    if (base < minScore && first.length > 1 && candidateVariants[0].includes(first[0])) {
      for (const cv of candidateVariants) {
        const loose = scoreCandidateV2(first, cv, simFn, FIRST_TOKEN_OTHER_WORD);
        if (loose.firstExact && loose.score > base) { base = loose.score; firstExact = true; }
      }
    }
    if (!base) continue;
    const reasons = contextReasons(context, candidate.id);
    const bonus = reasons.reduce((sum, r) => sum + CONTEXT_BONUS[r], 0);
    const qualifies = base >= minScore
      || (bonus > 0 && base >= floorWithContext)
      || (firstExact && first.length > 1 && base >= floorFirstToken);
    if (!qualifies) continue;
    const entry = { id: candidate.id, score: Math.round((base + bonus) * 1000) / 1000 };
    if (reasons.length) entry.reasons = reasons;
    scored.push(entry);
  }
  return scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, limit);
}

// Rank candidates ({ id, first_name, last_name, company_name }) against a
// dictated search string. Returns [{ id, score }] best first, at most
// `limit`, each at or above `minScore`.
//
// `v2: true` (GATE_NAME_MATCH_V2, passed by the caller) turns on the v2 word
// scoring, run-together words, possessives, the wider default `limit` of 8,
// and `context` ({ onScreenCustomerId, visitTodayIds: Set, recentContactIds:
// Set }): a bonus of +0.15 / +0.10 / +0.05 and a 0.65 floor for a customer
// with any bonus. A v2 entry with a bonus also carries `reasons`. Without
// `v2` the scoring is the original, whatever `context` holds.
function rankNameMatches(search, candidates, { limit, minScore = MIN_SCORE, v2 = false, context = null } = {}) {
  if (v2) return rankNameMatchesV2(search, candidates, { limit: limit || MAX_RESULTS_V2, minScore, context });
  const cap = limit === undefined ? MAX_RESULTS : limit;
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
  return scored.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id))).slice(0, cap);
}

module.exports = {
  MAX_RESULTS, MAX_RESULTS_V2, MIN_SCORE, tokenize, isNameLikeSearch, phoneticKey, levenshtein, wordSimilarity, rankNameMatches,
  wordSimilarityV2, suffixSimilarity, tolerantKey,
};
