/**
 * Pest Insider claim check. Deterministic, no model.
 *
 * The writer may only restate the lead fact and the species entry it was
 * given. Every lead sentence is checked against that fact's own statement and
 * quotes: its numbers, month and season words, and proper names must all
 * appear there. A sentence that fails is CUT, never rewritten. The issue
 * passes only with at least MIN_LEAD_SENTENCES kept sentences and a passing
 * id_item.
 *
 * Known limit: a Latin name that opens a sentence is not recognised as a name
 * (the first word of any sentence is capitalized anyway). The writer prompt
 * tells the model not to open a sentence with one.
 */
'use strict';

const { findHallucinatedClaims } = require('../newsletter-validator');
const { findUnverifiedClaims } = require('../email-division/fact-register');
const { getVoiceProfile } = require('../../config/voice-profiles');

const MIN_LEAD_SENTENCES = 2;
const MAX_LEAD_SENTENCES = 4;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = { jan: 'january', feb: 'february', mar: 'march', apr: 'april', jun: 'june', jul: 'july', aug: 'august', sep: 'september', sept: 'september', oct: 'october', nov: 'november', dec: 'december' };
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const FRACTION_DEN = { half: 2, halves: 2, third: 3, thirds: 3, fourth: 4, fourths: 4, quarter: 4, quarters: 4, fifth: 5, fifths: 5 };
const SCALE_WORDS = /\b(hundred|thousand|million|billion|dozen)s?\b/g;

// Words that are not claims: the brand and the region the email is written for.
const ALLOWED_NAMES = new Set(['waves', 'florida', 'southwest', 'swfl', 'uf', 'ifas', 'uf/ifas', 'i', 'today', "what's", 'what']);

// Pesticide actives, product and brand names, and DIY-ingredient words. The
// writer is told to use none; a hit cuts the sentence.
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
  { re: /\$/, reason: 'dollar sign' },
  { re: /\b(?:dollars|bucks|prices?|pricing|discounts?|coupons?|cheap(?:er|est)?)\b/i, reason: 'price word' },
  { re: /\b(?:un)?safe(?:ly|r|st|ty)?\b/i, reason: 'the word "safe"' },
  { re: /\bguarantee[sd]?\b|\bwarrant(?:y|ies)\b/i, reason: 'guarantee' },
  { re: /\bpromis(?:e[sd]?|ing)\b/i, reason: 'promise' },
];
// A Waves line explains; it never sells.
const SELLING_RE = /\b(?:book|booking|schedule|call|contact|quote|estimate|free|offer|buy|hire|order|sign\s*up|subscribe|plans?|packages?)\b/i;
const WAVES_RE = /\bwaves\b/i;
const REPEAT_WORDS_RE = /\b(?:second|another|again|repeat\w*|twice|once\s+more|storms?|hurricanes?|post[-\s]?storms?|tropical)\b/i;

// Words a sentence opens with that are not part of a name that follows them ("The CDC says ...").
const OPENERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'in', 'on', 'at', 'by', 'for', 'from', 'with', 'when', 'while', 'if', 'it', 'they', 'we', 'our', 'your', 'here', 'there', 'some', 'many', 'most', 'each', 'every', 'after', 'before', 'during', 'unlike', 'like', 'as', 'so', 'but', 'and', 'or', 'now', 'according']);

const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

function bannedReason(text) {
  for (const { re, reason } of BANNED_RULES) if (re.test(text)) return reason;
  if (BRAND_RE.test(text)) return 'pesticide or brand name';
  const tripwire = findHallucinatedClaims(text)[0];
  if (tripwire) return `tripwire: ${/\(([^)]*)\)/.exec(tripwire)?.[1] || 'claim'}`;
  // The register's termite rule reads any June-or-later swarm month as a false
  // claim, which also catches UF's own April-to-June Formosan window. The month
  // check below already pins months to the source, so that rule only applies
  // when the sentence also speaks of a repeat or a storm.
  const unverified = findUnverifiedClaims(text).find((u) => u.rule !== 'termite_second_swarm' || REPEAT_WORDS_RE.test(text));
  if (unverified) return `tripwire: ${unverified.rule}`;
  return null;
}

// ── numbers, months, seasons ────────────────────────────────────────────
function numberTokens(text) {
  let t = norm(text).toLowerCase();
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
    // a lone sentence-opening word is just a capital letter
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
  const haveTime = timeTokens(source.facts);
  for (const m of timeTokens(text)) if (!haveTime.has(m)) return `month or season not in the source: ${m}`;
  const name = unknownName(text, source.names);
  if (name) return `name not in the source: ${name}`;
  return null;
}

const factSource = (fact) => ({
  facts: [fact.statement, ...fact.quotes].join(' '),
  names: [fact.title, fact.statement, ...fact.quotes, ...fact.sources.map((s) => `${s.publisher} ${s.title}`)].join(' '),
});

const speciesSource = (species) => ({
  facts: [species.fact, species.note].join(' '),
  names: [species.name, species.category, species.fact, species.note].join(' '),
});

const joinSources = (...sources) => ({ facts: sources.map((s) => s.facts).join(' '), names: sources.map((s) => s.names).join(' ') });

function leadSentenceProblem(sentence, leadFact, source, state) {
  if (!sentence || typeof sentence.text !== 'string' || !sentence.text.trim()) return 'empty sentence';
  if (sentence.fact_id !== leadFact.id) return `fact_id ${sentence.fact_id} is not the lead fact ${leadFact.id}`;
  const problem = sentenceProblem(sentence.text, source);
  if (problem) return problem;
  if (WAVES_RE.test(sentence.text)) {
    if (state.wavesLines >= 1) return 'more than one Waves line';
    if (SELLING_RE.test(sentence.text)) return 'Waves line sells';
    state.wavesLines += 1;
  }
  return null;
}

function checkLead(sentences, leadFact, source) {
  const state = { wavesLines: 0 };
  const lead = [];
  const cut = [];
  for (const s of sentences.slice(0, MAX_LEAD_SENTENCES + 2)) {
    const reason = leadSentenceProblem(s, leadFact, source, state);
    if (reason) cut.push({ text: String(s?.text ?? ''), reason });
    else if (lead.length >= MAX_LEAD_SENTENCES) cut.push({ text: s.text, reason: `more than ${MAX_LEAD_SENTENCES} sentences` });
    else lead.push({ text: tidy(s.text), fact_id: s.fact_id });
  }
  return { lead, cut };
}

// Headline, subject and preview are short display strings: a failing one is
// replaced by the bank's own title or left out (the caller supplies a stand-in),
// never reworded.
function checkDisplay(draft, leadFact, source, withSpecies) {
  const fallbacks = [];
  const headlineText = tidy(draft?.lead?.headline);
  const headline = headlineText && !sentenceProblem(headlineText, source) ? headlineText : leadFact.title;
  if (headline !== headlineText) fallbacks.push('headline');
  const subjectText = tidy(draft?.subject);
  const subject = subjectText && !subjectFormatProblem(subjectText) && !sentenceProblem(subjectText, withSpecies) ? subjectText : null;
  if (!subject) fallbacks.push('subject');
  const previewText = tidy(draft?.preview);
  const preview = previewText && !sentenceProblem(previewText, withSpecies) ? previewText : null;
  if (!preview) fallbacks.push('preview');
  return { headline, subject, preview, fallbacks };
}

/**
 * Check a writer draft against the plan.
 * @param {{ draft: object, leadFact: object, idItem: object }} input
 * @returns {{ ok: boolean, lead: Array<{text:string,fact_id:string}>, cut: Array<{text:string,reason:string}>,
 *   headline: string, subject: string|null, preview: string|null, idItem: {ok:boolean,text:string,reason:string|null},
 *   fallbacks: string[] }}
 */
function checkClaims({ draft, leadFact, idItem }) {
  const source = factSource(leadFact);
  const sentences = Array.isArray(draft?.lead?.sentences) ? draft.lead.sentences : [];
  const { lead, cut } = checkLead(sentences, leadFact, source);
  const display = checkDisplay(draft, leadFact, source, joinSources(source, speciesSource(idItem)));
  const idText = tidy(draft?.id_item?.text);
  const idProblem = idText ? sentenceProblem(idText, speciesSource(idItem)) : 'empty id_item';
  const id = { ok: !idProblem, text: idText, reason: idProblem };
  return { ok: lead.length >= MIN_LEAD_SENTENCES && id.ok, lead, cut, ...display, idItem: id };
}

module.exports = { checkClaims, sentenceProblem, subjectFormatProblem, bannedReason, factSource, speciesSource, MIN_LEAD_SENTENCES, MAX_LEAD_SENTENCES };
