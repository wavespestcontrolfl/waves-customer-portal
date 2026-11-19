/**
 * Pest Insider copy check. Deterministic, no model.
 *
 * Every word an issue carries is fixed, reviewed text: the lead fact's
 * `lead` sentences and title from the fact bank, and the species entry's
 * reviewed `copy.fact` from the portal species catalog. Nothing is written
 * per issue, so a sentence cannot say the opposite of its source (a
 * deterministic check cannot judge free wording; codex pre-push round 3).
 * This check runs on
 * that copy before every render, and on the whole bank in the tests:
 *
 * - numbers (with their units), month and season words, and proper names
 *   must all appear in the fact's own statement or quotes;
 * - a sentence that states a number or a month must copy one source unit
 *   word for word (a quote sentence, the statement, or a part of it);
 * - a publisher a sentence names must be the one whose quote it restates;
 * - the banned words, the hallucination tripwires and the shared claim
 *   register the send validator runs apply to every sentence.
 *
 * Nothing is cut or reworded: any problem fails the issue. The build then
 * runs the send validator itself on the rendered issue (index.js).
 */
'use strict';

const { findHallucinatedClaims } = require('../newsletter-validator');
const { findUnverifiedClaims } = require('../email-division/fact-register');
const { getVoiceProfile } = require('../../config/voice-profiles');
const { FACTS, sourceLabel, attributedQuotes, LEAD_MIN: MIN_LEAD_SENTENCES, LEAD_MAX: MAX_LEAD_SENTENCES } = require('./facts');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = { jan: 'january', feb: 'february', mar: 'march', apr: 'april', jun: 'june', jul: 'july', aug: 'august', sep: 'september', sept: 'september', oct: 'october', nov: 'november', dec: 'december' };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  ...TENS, twice: 2, thrice: 3,
};
// Every spelled-out number counts, so a sentence that states one must copy
// its source (pre-push round 12: "thirty days" passed unread against a
// source that says 12 days). A compound ("twenty-five", "thirty five") is
// one number, never a range, so it becomes digits before any number is read.
const COMPOUND_NUMBER = new RegExp(`\\b(${Object.keys(TENS).join('|')})[-\\s]+(one|two|three|four|five|six|seven|eight|nine)\\b`, 'g');
const compoundDigits = (lower) => lower.replace(COMPOUND_NUMBER, (m, tens, unit) => String(TENS[tens] + NUMBER_WORDS[unit]));
const FRACTION_DEN = { half: 2, halves: 2, third: 3, thirds: 3, fourth: 4, fourths: 4, quarter: 4, quarters: 4, fifth: 5, fifths: 5 };
const SCALE_WORDS = /\b(hundred|thousand|million|billion|dozen)s?\b/g;

// Words that are not claims: the brand and the region the email is written for.
const ALLOWED_NAMES = new Set(['waves', 'florida', 'southwest', 'swfl', 'uf', 'ifas', 'uf/ifas', 'i', 'today', "what's", 'what']);

// Pesticide actives, product and brand names, and DIY-ingredient words. The
// copy uses none; a hit fails the issue.
const BRAND_AND_PRODUCT = [
  'termidor', 'talstar', 'talak', 'sentricon', 'demand cs', 'taurus', 'fipronil', 'bifenthrin', 'permethrin', 'cypermethrin',
  'deltamethrin', 'cyhalothrin', 'imidacloprid', 'dinotefuran', 'chlorantraniliprole', 'acephate', 'carbaryl', 'malathion',
  'diazinon', 'glyphosate', 'roundup', 'atrazine', 'dicamba', 'prodiamine', 'pendimethalin', 'trifluralin', 'celsius',
  'advion', 'maxforce', 'terro', 'raid', 'black flag', 'hot shot', 'ortho', 'spectracide', 'bayer', 'scotts', 'bonide', 'sevin',
  'deet', 'borax', 'boric acid', 'diatomaceous', 'bleach', 'ammonia', 'vinegar', 'pyrethrin', 'pyrethroid', 'neem',
  'insecticide', 'pesticide', 'herbicide', 'fungicide', 'rodenticide', 'poison', 'amazon',
];
const BRAND_RE = new RegExp(`(?:^|[^a-z])(?:${BRAND_AND_PRODUCT.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})s?(?![a-z])`, 'i');

const BANNED_RULES = [
  // The text lands in HTML (body and preheader): no markup, ever.
  { re: /[<>]/, reason: 'markup character' },
  { re: /\$/, reason: 'dollar sign' },
  { re: /\b(?:dollars|bucks|prices?|pricing|discounts?|coupons?|cheap(?:er|est)?)\b/i, reason: 'price word' },
  { re: /\b(?:un)?safe(?:ly|r|st|ty)?\b/i, reason: 'the word "safe"' },
  { re: /\bguarantee[sd]?\b|\bwarrant(?:y|ies)\b/i, reason: 'guarantee' },
  { re: /\bpromis(?:e[sd]?|ing)\b/i, reason: 'promise' },
];
// Lead copy restates its sources; it never speaks for Waves.
const WAVES_RE = /\bwaves\b/i;

// Words a sentence opens with that are not part of a name that follows them ("The CDC says ...").
const OPENERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'when', 'while', 'if', 'it', 'they', 'we', 'our', 'your', 'here', 'there', 'some', 'many', 'most', 'each', 'every', 'after', 'before', 'during', 'unlike', 'like', 'as', 'so', 'but', 'and', 'or', 'now', 'according', 'why', 'how', 'never']);

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

function bannedReason(text) {
  for (const { re, reason } of BANNED_RULES) if (re.test(text)) return reason;
  if (BRAND_RE.test(text)) return 'pesticide or brand name';
  const tripwire = findHallucinatedClaims(text)[0];
  if (tripwire) return `tripwire: ${/\(([^)]*)\)/.exec(tripwire)?.[1] || 'claim'}`;
  // The same shared register the send validator runs (newsletter-validator.js),
  // so copy that passes here is not blocked there.
  const unverified = findUnverifiedClaims(text)[0];
  if (unverified) return `tripwire: ${unverified.rule}`;
  return null;
}

// ── numbers, months, seasons ────────────────────────────────────────────
function numberTokens(text) {
  let t = compoundDigits(norm(text).toLowerCase());
  const tokens = new Set();
  t = t.replace(/\b(one|two|three|four|a)[-\s]+(half|halves|thirds?|fourths?|quarters?|fifths?)\b/g, (m, n, d) => {
    tokens.add(`${n === 'a' ? 1 : NUMBER_WORDS[n]}/${FRACTION_DEN[d]}`);
    return ' ';
  });
  t = t.replace(/\b(half|halves)\b/g, () => { tokens.add('1/2'); return ' '; });
  t = t.replace(/\d+\/\d+/g, (m) => { tokens.add(m); return ' '; });
  t = t.replace(/\d+(?:,\d{3})*(?:\.\d+)?/g, (m) => { tokens.add(String(Number(m.replace(/,/g, '')))); return ' '; });
  t = t.replace(SCALE_WORDS, (m, w) => { tokens.add(`scale:${w}`); return ' '; });
  for (const w of t.match(/[a-z]+/g) || []) if (NUMBER_WORDS[w]) tokens.add(String(NUMBER_WORDS[w]));
  if (/%|\bpercent\b/i.test(text)) tokens.add('percent');
  return tokens;
}

// A number with its unit ("8 months", "7-10 days", "eight feet") must appear
// with the SAME unit in the source: "10 months" fails against a source that
// only has "8 months" and "7-10 days", although 10 occurs there.
const UNITS = {
  second: 'second', minute: 'minute', hour: 'hour', day: 'day', week: 'week', month: 'month', year: 'year', decade: 'decade',
  inch: 'inch', inches: 'inch', foot: 'foot', feet: 'foot', yard: 'yard', mile: 'mile', block: 'block',
  meter: 'meter', metre: 'meter', millimeter: 'millimeter', centimeter: 'centimeter', kilometer: 'kilometer',
  percent: 'percent', degree: 'degree', pound: 'pound', ounce: 'ounce', gallon: 'gallon', acre: 'acre',
  hundred: 'hundred', thousand: 'thousand', million: 'million', billion: 'billion', dozen: 'dozen',
  generation: 'generation', time: 'time',
};
const unitOf = (word) => UNITS[word] || UNITS[word.replace(/(?:es|s)$/, '')] || UNITS[word.replace(/s$/, '')] || null;
const RANGE_WORDS = new Set(['to', 'through', 'thru', 'and', 'or', '-']);

function quantityTokens(text) {
  return compoundDigits(norm(text).toLowerCase())
    .replace(/(\d)\s*%/g, '$1 percent ')
    .replace(/(\d)\s*[-\u2013\u2014]\s*(?=\d)/g, '$1 - ')
    .replace(/(\d)-(?=[a-z])/g, '$1 ')
    .replace(/°\s*f\b/g, ' degree ')
    .match(/\d+(?:,\d{3})*(?:\.\d+)?|[a-z]+|-/g) || [];
}

const tokenNumber = (tok) => (/^\d/.test(tok) ? String(Number(tok.replace(/,/g, ''))) : (NUMBER_WORDS[tok] ? String(NUMBER_WORDS[tok]) : null));

/** "number unit" pairs; a range ("7 to 10 days") gives the unit to every number in it. */
function quantityPairs(text) {
  const toks = quantityTokens(text);
  const pairs = new Set();
  let run = [];
  let expectNumber = false;
  for (const tok of toks) {
    const n = tokenNumber(tok);
    if (n !== null && (run.length === 0 || expectNumber)) { run.push(n); expectNumber = false; continue; }
    if (run.length && !expectNumber && RANGE_WORDS.has(tok)) { expectNumber = true; continue; }
    if (run.length && !expectNumber && /^(?:up|more|than|about|nearly|almost|over|under|less|least|most|at)$/.test(tok)) continue;
    const unit = run.length && !expectNumber ? unitOf(tok) : null;
    if (unit) for (const v of run) pairs.add(`${v} ${unit}`);
    run = n !== null ? [n] : [];
    expectNumber = false;
  }
  return pairs;
}

const SEASON_RES = [
  ['winter', /\bwinter(?:time)?\b/i], ['spring', /\bspring(?:time)?\b/i], ['summer', /\bsummer(?:time)?\b/i],
  ['fall', /\b(?:this|the|in|every|each|last|early|late|next)\s+fall\b|\bfall\s+(?:season|months?)\b|\bautumn\b/i],
  ['dry season', /\bdry\s+season\b/i], ['rainy season', /\brainy\s+season\b/i], ['hurricane season', /\bhurricane\s+season\b/i],
];

function timeTokens(text) {
  const t = norm(text);
  const out = new Set();
  for (const m of t.matchAll(/\b([A-Z][a-z]+)\b(\.?)(?=\s|[,.;:)]|$)/g)) {
    const word = m[1].toLowerCase();
    if (MONTHS.includes(word) && word !== 'may') out.add(word);
    else if (MONTH_ABBR[word] && m[2] === '.') out.add(MONTH_ABBR[word]);
  }
  // "May" is also a verb: it is a month only when capitalized mid-sentence or
  // in front of a date or range word.
  if (/(?<!^)(?<=[a-z,;:]\s)May\b|(?:^|[.!?]\s)May\s+(?:\d|through|to|and|until|is|brings)\b|\bMay\s+\d/.test(t)) out.add('may');
  for (const [name, re] of SEASON_RES) if (re.test(t)) out.add(name);
  return out;
}

// ── names ───────────────────────────────────────────────────────────────
function nameCandidates(sentence) {
  const words = norm(sentence).split(' ');
  // Openers: the first token with a letter (a leading emoji does not count) and
  // every token after a sentence end, for text of several sentences.
  const firstAt = words.findIndex((w) => /[A-Za-z]/.test(w));
  const isOpener = (i) => i === firstAt || (i > 0 && /[.!?]["')]*$/.test(words[i - 1]) && !/^(?:[A-Z][a-z]?\.|St\.|Dr\.|Mr\.|vs\.)$/.test(words[i - 1]));
  const phrases = [];
  let current = [];
  const flush = () => { if (current.length) phrases.push(current); current = []; };
  words.forEach((raw, i) => {
    const word = raw.replace(/^[("']+|[)"',.;:!?]+$/g, '').replace(/'s$/, '');
    const isMonth = MONTHS.includes(word.toLowerCase()) || /^(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.$/i.test(raw.replace(/[,;:]$/, ''));
    if (/^[A-Z]/.test(word) && !isMonth) {
      current.push({ word, first: isOpener(i) });
      if (/[.!?;:,]$/.test(raw)) flush();
    } else flush();
  });
  flush();
  return phrases
    .map((p) => p.filter((w) => !ALLOWED_NAMES.has(w.word.toLowerCase()) && !(w.first && OPENERS.has(w.word.toLowerCase()))))
    // a lone sentence-opening word is just a capital letter (openerProblem
    // checks the first word of a printed line)
    .filter((p) => p.length && !(p.length === 1 && p[0].first))
    .map((p) => p.map((w) => w.word).join(' '));
}

const hasWord = (corpus, phrase) => new RegExp(`(?:^|[^a-z])${phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(corpus);

function unknownName(sentence, namesCorpus) {
  const corpus = norm(namesCorpus).toLowerCase();
  const sci = norm(sentence).match(/\b[A-Z]\.\s?[a-z]{3,}\b/g) || [];
  for (const s of sci) if (!hasWord(corpus, s)) return s;
  for (const phrase of nameCandidates(sentence)) if (!hasWord(corpus, phrase)) return phrase;
  return null;
}

// ── numbers and months stay with their claim ───────────────────────────
// Pooled checks cannot tell "12 days with food but no water" from "42 days
// with water but no food" (R02): both numbers and both conditions are in the
// source. So a sentence that states a number or a month must COPY one source
// unit word for word: a sentence of a quote, the statement, or a part of the
// statement between semicolons or either side of ", and" / ", but". It may wrap that copy in "<publisher> says" or
// "According to <publisher>,". Case, punctuation, curly quotes and number
// words ("eight" = "8") do not count as differences. Anything looser fails.
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\b`, 'g');
const LEADING_CONNECTOR = /^(?:and|but|so|also|however|still|plus|in fact|did you (?:know|realize)(?: that)?)\s+/;
const ATTRIBUTION_VERBS = '(?:says|said|notes|noted|reports|reported|explains|found|finds|writes|adds|points out|tells us|warns)';

function canonical(text) {
  return compoundDigits(norm(text).toLowerCase())
    .replace(/[\u2013\u2014]/g, '-')
    .replace(NUMBER_WORD_RE, (w) => String(NUMBER_WORDS[w]))
    .replace(/(\d),(\d{3})/g, '$1$2')
    .replace(/[^a-z0-9%/\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Sentence split that keeps the original characters (curly quotes stay curly).
function splitSentences(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().split(/(?<=[.!?])["')\]]*\s+(?=["'(]?[A-Z0-9])/).map((t) => t.trim()).filter(Boolean);
}

// canonical unit -> the labels it may be credited to ('*' = any: our statement).
function sourceUnits(statement, attributed) {
  const units = new Map();
  const add = (text, label) => {
    const c = canonical(text);
    if (!c) return;
    for (const key of [c, c.replace(LEADING_CONNECTOR, '')]) {
      if (!units.has(key)) units.set(key, new Set());
      units.get(key).add(label);
    }
  };
  const whole = String(statement || '');
  add(whole, '*');
  // Our reviewed statement may also be quoted by its parts: between
  // semicolons, or either side of ", and" / ", but".
  for (const part of whole.split(/;\s*|,\s+(?:and|but)\s+/)) add(part, '*');
  for (const { text, label } of attributed) for (const sentence of splitSentences(text)) add(sentence, label);
  return units;
}

function stripAttribution(c, labels) {
  const names = labels.map((l) => canonical(l)).filter(Boolean).map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  if (!names) return c;
  return c
    .replace(new RegExp(`^(?:the )?(?:${names}) ${ATTRIBUTION_VERBS}(?: that)? `), '')
    .replace(new RegExp(`^according to (?:the )?(?:${names}) `), '')
    .replace(new RegExp(` (?:the )?(?:${names}) ${ATTRIBUTION_VERBS}$`), '');
}

const needsCopy = (text) => [...numberTokens(text)].some((t) => !t.startsWith('scale:')) || [...timeTokens(text)].some((t) => MONTHS.includes(t));

/** Why a number or month sentence is not a word-for-word copy of one source unit, or null. */
function copyProblem(text, units, labels) {
  if (!needsCopy(text)) return null;
  const c = stripAttribution(canonical(text), labels).replace(LEADING_CONNECTOR, '');
  const allowed = units.get(c);
  if (!allowed) return 'a number or month must keep its own claim: copy that source sentence word for word';
  if (allowed.has('*')) return null;
  const wrong = [...labelsNamed(text)].find((l) => !allowed.has(l));
  return wrong ? `credits ${wrong} for another source's text` : null;
}

// ── source credit ───────────────────────────────────────────────────────
// Every publisher name the bank uses, plus the long form of UF/IFAS. A
// sentence that names one of them must name a source of THIS fact, and the
// text it restates must come from that publisher's quotes, not another's.
const LABEL_ALIASES = { 'university of florida': 'UF/IFAS', uf: 'UF/IFAS' };
const BANK_LABELS = [...new Set(FACTS.flatMap((f) => f.sources.map(sourceLabel)))];
const STOP = new Set(['that', 'this', 'with', 'from', 'have', 'they', 'their', 'them', 'these', 'those', 'will', 'only', 'into', 'than', 'when', 'your', 'about', 'says', 'said', 'also', 'more', 'most', 'some', 'such', 'been', 'were', 'which', 'what', 'there', 'other', 'here', 'just', 'like', 'over', 'even', 'each', 'very', 'does', 'doesn']);
const contentWords = (text) => new Set((norm(text).toLowerCase().match(/[a-z]{4,}/g) || [])
  .filter((w) => !STOP.has(w)).map((w) => w.replace(/(?:es|s)$/, '')));
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const namesLabel = (text, label) => new RegExp(`(?:^|[^a-z/])${escapeRe(label.toLowerCase())}(?![a-z])`, 'i').test(norm(text));

function labelsNamed(text) {
  const named = new Set(BANK_LABELS.filter((l) => namesLabel(text, l)));
  for (const [alias, label] of Object.entries(LABEL_ALIASES)) if (namesLabel(text, alias)) named.add(label);
  return named;
}

function creditProblem(text, fact) {
  const named = labelsNamed(text);
  if (!named.size) return null;
  const groups = new Map();
  for (const { text: quote, label } of attributedQuotes(fact)) groups.set(label, `${groups.get(label) || ''} ${quote}`);
  for (const label of named) if (!groups.has(label)) return `credits ${label}, not a source of this fact`;
  if (groups.size < 2) return null;
  const labelWords = contentWords([...groups.keys()].join(' '));
  const words = [...contentWords(text)].filter((w) => !labelWords.has(w));
  const score = (label) => { const q = contentWords(groups.get(label)); return words.filter((w) => q.has(w)).length; };
  const best = Math.max(...[...groups.keys()].map(score));
  for (const label of named) if (score(label) < best) return `credits ${label} for another source's text`;
  return null;
}

// Subject rule from the newsletter voice profile: one leading emoji, max length.
function subjectFormatProblem(subject) {
  const max = getVoiceProfile('waves_phase_3_local').subjectLineRules.maxLength;
  if (subject.length > max) return `subject is ${subject.length} chars (max ${max})`;
  if (!/^\p{Extended_Pictographic}/u.test(subject) || (subject.match(/\p{Extended_Pictographic}/gu) || []).length !== 1) return 'subject needs exactly one leading emoji';
  return null;
}

// ── one sentence against its source text ────────────────────────────────
/**
 * @param {string} text
 * @param {{ facts: string, names: string }} source  facts = statement + quotes; names adds titles and publishers
 * @returns {string|null} the reason the sentence fails, or null
 */
function sentenceProblem(text, source) {
  const banned = bannedReason(text);
  if (banned) return banned;
  const have = numberTokens(source.facts);
  for (const n of numberTokens(text)) if (!have.has(n)) return `number not in the source: ${n}`;
  const havePairs = quantityPairs(source.facts);
  for (const q of quantityPairs(text)) if (!havePairs.has(q)) return `number and unit not in the source: ${q}`;
  const haveTime = timeTokens(source.facts);
  for (const m of timeTokens(text)) if (!haveTime.has(m)) return `month or season not in the source: ${m}`;
  const name = unknownName(text, source.names);
  if (name) return `name not in the source: ${name}`;
  return source.units ? copyProblem(text, source.units, source.labels) : null;
}

const factSource = (fact) => ({
  units: sourceUnits(fact.statement, attributedQuotes(fact)),
  labels: [...new Set([...fact.sources.map(sourceLabel), ...Object.keys(LABEL_ALIASES)])],
  facts: [fact.statement, ...fact.quotes].join(' '),
  // The fact's own title is not evidence: a name it adds must be in the
  // statement, a quote or a source's publisher or title (pre-push round 7).
  names: [fact.statement, ...fact.quotes, ...fact.sources.map((s) => `${s.publisher} ${s.title}`)].join(' '),
});

const speciesSource = (species) => ({
  units: sourceUnits('', [species.fact, species.note].map((text) => ({ text, label: '*' }))),
  labels: [],
  facts: [species.fact, species.note].join(' '),
  names: [species.name, species.category, species.fact, species.note].join(' '),
});

// A lone capitalized word that opens a printed line may be an ordinary word
// or a name ("Tampa mosquito eggs ..."), and nameCandidates cannot tell
// them apart, so the line passes only when that word is a plain opener or
// its source has the word in any case (pre-push round 7).
function openerProblem(text, source) {
  const first = norm(text).split(' ').find((w) => /[A-Za-z]/.test(w)) || '';
  const word = first.replace(/^[("']+|[)"',.;:!?]+$/g, '').replace(/'s$/, '');
  const lower = word.toLowerCase();
  if (!/^[A-Z]/.test(word) || OPENERS.has(lower) || ALLOWED_NAMES.has(lower)) return null;
  return hasWord(norm(source.names).toLowerCase(), word) ? null : `name not in the source: ${word}`;
}

// The subject is the fact's reviewed title behind its service emoji.
const SERVICE_EMOJI = { pest: '🐜', lawn: '🌱', tree_shrub: '🌴', mosquito: '🦟', termite: '🪵', rodent: '🐀' };

function leadLineProblem(text, fact, source) {
  if (!text) return 'empty sentence';
  if (WAVES_RE.test(text)) return 'a lead sentence restates the source; it does not speak for Waves';
  return sentenceProblem(text, source) || openerProblem(text, source) || creditProblem(text, fact);
}

// A title is a reviewed summary of the whole fact, not a copy of one quote,
// so it gets the pooled checks (numbers with their units, months, names,
// credit) without the word-for-word rule, plus the subject format.
function titleProblem(title, subject, fact, source) {
  return subjectFormatProblem(subject) || sentenceProblem(title, { ...source, units: null }) || openerProblem(title, source) || creditProblem(title, fact);
}

// "What's this?" is the species entry's own fact, checked a sentence at a time.
function idItemProblems(idText, species) {
  const source = speciesSource(species);
  const sentences = splitSentences(idText);
  if (!sentences.length) return [{ part: 'id_item', text: '', reason: 'empty species fact' }];
  return sentences
    .map((text) => ({ part: 'id_item', text, reason: sentenceProblem(text, source) }))
    .filter((p) => p.reason);
}

/**
 * Check one issue's fixed copy before it renders.
 * @param {{ leadFact: object, species: object }} input  the plan's lead fact and identifier species
 * @returns {{ ok: boolean, problems: Array<{ part: 'lead'|'title'|'id_item'|'preview', text: string, reason: string }>,
 *   subject: string, preview: string, headline: string, lead: string[], idText: string }}
 */
function checkIssueCopy({ leadFact, species }) {
  const source = factSource(leadFact);
  const problems = [];
  const lead = Array.isArray(leadFact.lead) ? leadFact.lead.map(tidy) : [];
  if (lead.length < MIN_LEAD_SENTENCES || lead.length > MAX_LEAD_SENTENCES) {
    problems.push({ part: 'lead', text: '', reason: `needs ${MIN_LEAD_SENTENCES} to ${MAX_LEAD_SENTENCES} lead sentences, has ${lead.length}` });
  }
  for (const text of lead) {
    const reason = leadLineProblem(text, leadFact, source);
    if (reason) problems.push({ part: 'lead', text, reason });
  }

  const headline = tidy(leadFact.title);
  const subject = `${SERVICE_EMOJI[leadFact.service]} ${headline}`;
  const titleReason = titleProblem(headline, subject, leadFact, source);
  if (titleReason) problems.push({ part: 'title', text: headline, reason: titleReason });

  const idText = tidy(species.fact);
  problems.push(...idItemProblems(idText, species));

  const preview = `What's this? ${tidy(species.name)}`;
  const previewReason = bannedReason(preview);
  if (previewReason) problems.push({ part: 'preview', text: preview, reason: previewReason });

  return { ok: problems.length === 0, problems, subject, preview, headline, lead, idText };
}

module.exports = {
  checkIssueCopy, sentenceProblem, creditProblem, quantityPairs, copyProblem, canonical, subjectFormatProblem, bannedReason, factSource, speciesSource,
  SERVICE_EMOJI, MIN_LEAD_SENTENCES, MAX_LEAD_SENTENCES,
};
