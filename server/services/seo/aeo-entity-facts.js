/**
 * Entity-accuracy cohort (AEO) — what the answer engines say ABOUT Waves.
 *
 * The citation benchmark measures whether Waves is retrieved and linked for
 * prospect questions. This cohort measures the next rung: when an engine is
 * asked who Waves is, does it state the owner-approved facts (founder, year,
 * license, footprint) and avoid the claims the owner ruled out (a franchise,
 * fumigation, damage-repair coverage inferred from the termite bond)?
 *
 * Every question, its approved answer, source, expected facts and forbidden
 * claims live in `server/data/aeo-entity-cohort-v1.json` (owner decision 6,
 * 2026-09-07). Scoring is deterministic regex over the stored answer text so a
 * fact check never spends a model call and never varies between runs.
 */

const cohort = require('../../data/aeo-entity-cohort-v1.json');
const { MEASUREMENT_VERSION } = require('./aeo-measurement');

// `{{other_entities}}` in a pattern expands to the competitor list, matched
// in any letter case even inside a case-sensitive pattern (the owner pattern
// keeps its capitalized-name shape for unknown parties).
const OTHER_ENTITY_ALTERNATION = cohort.other_entities
  .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[a-z]/g, c => `[${c.toUpperCase()}${c}]`))
  .join('|');

function compile(def) {
  const flags = typeof def.flags === 'string' ? def.flags : 'i';
  return {
    label: def.label,
    scanRe: new RegExp(def.pattern.replace(/\{\{other_entities\}\}/g, OTHER_ENTITY_ALTERNATION), flags.includes('g') ? flags : `${flags}g`),
    rejectValue: typeof def.reject_value === 'string' ? def.reject_value : undefined,
    // A captured value matching this (case-insensitive, anchors allowed) is
    // an approved value, not a wrong claim: "based in Lakewood Ranch".
    rejectRe: typeof def.reject_pattern === 'string' ? new RegExp(def.reject_pattern, 'i') : undefined,
    // 'prose' (default) matches the answer text with URLs removed; 'any' also
    // matches the collected URLs (a site or tel: link satisfies website/phone).
    scope: def.scope === 'any' ? 'any' : 'prose',
  };
}

// Facts and claims are both ASSERTIONS: a match counts only when its clause
// carries no negation. "Was not founded in 2024" earns no credit for the
// founding-year fact; "does not cover termite damage" and "fumigation is not
// offered" are correct denials, not wrong claims. The clause is bounded by
// sentence punctuation or a contrastive conjunction, so "not a franchise, but
// it offers fumigation" still flags fumigation. "no-contract" and "not only"
// are not negations.
const NEGATION_RE = /\b(?:not(?! only)|no(?!-)|never|none|nor|without|except|excluding|other than|aside from|outside of|rather than|instead of|doesn'?t|does not|do not|don'?t|isn'?t|is not|aren'?t|are not|wasn'?t|was not|cannot|can'?t|won'?t|will not|shouldn'?t|should not|neither)\b/i;
// Clause boundaries: sentence punctuation, a contrastive conjunction, or a
// coordinating "and"/"or" that starts a new predicate ("is a franchise and
// does not offer fumigation"). A bare "or" inside a noun list ("insulation or
// fumigation") is not a boundary, so a negated list stays negated.
const PREDICATE_VERB = '(?:is|are|was|were|does|do|did|offers?|provides?|has|have|will|can|covers?|includes?|charges?|treats?|serves?|handles?|performs?|operates?|holds?|specializ(?:es|e)|focus(?:es)?|excels?|delivers?|carr(?:ies|y)|sells?|uses?|maintains?|guarantees?|promises?|claims?|states?|says?|remains?|continues?|employs?|runs?|owns?|works?|also)';
const CLAUSE_BOUNDARY_RE = new RegExp(`[.!?;\\n]|,?\\s+(?:but|however|whereas|although|though|yet)\\b|,?\\s+(?:and|or)\\s+(?=(?:\\w+\\s+){0,2}${PREDICATE_VERB}\\b)`, 'i');
// "does not offer: fumigation, insulation" — a negated verb right before a
// colon governs the list that follows; "is not a franchise: it offers …" does not.
// Active ("does not offer:") and passive ("Services not offered:") intros.
const LIST_INTRO_RE = /\b(?:offer|offers|offered|include|includes|included|provide|provides|provided|cover|covers|covered|do|does|perform|performs|performed|treat|treats|treated|handle|handles|handled|sell|sells|sold|service|services|serviced|available|are|is)\s*(?:(?:any of |all of )?(?:the following|these|those|the below|this list))?\s*$/i;

function leadClause(text) {
  const clause = text.split(CLAUSE_BOUNDARY_RE).pop();
  const colon = clause.lastIndexOf(':');
  if (colon < 0) return clause;
  const head = clause.slice(0, colon);
  const list = clause.slice(colon + 1);
  return LIST_INTRO_RE.test(head) && NEGATION_RE.test(head.slice(-40)) ? `${head.slice(-40)} ${list}` : list;
}

// Text after the match up to the clause end. A colon normally starts a new
// clause ("is a franchise: it does not …"), except in label-value form where
// the match IS the label ("Fumigation: not offered by Waves").
function trailClause(text, matchIsLabel) {
  const clause = text.split(CLAUSE_BOUNDARY_RE)[0];
  return matchIsLabel ? clause.replace(/^\s*:/, ' ') : clause.split(':')[0];
}

// A negation AFTER the match denies it only as its own predicate ("fumigation
// is not offered", "does not own"), within two words and before any comma. A
// later contrastive exclusion ("…, not fumigation") or a negated modifier
// ("at no additional cost") does not reach back to the match.
// Also a bare negative label value ("Fumigation: No") and an unavailable /
// excluded predicate ("fumigation is unavailable").
// A prepositional qualifier on the service name ("fumigation for drywood
// termites is not offered") sits between the match and its predicate.
const QUALIFIER = "(?:(?:for|of|in|on|to|against|with|under)\\s+(?:(?!(?:and|or|but|not|no|is|are|was|were|does|do|did)\\b)[\\w'-]+\\s+){1,4})?";
const AFTER_NEGATION_RE = new RegExp(`^\\s*${QUALIFIER}(?:(?:(?!(?:and|or|but)\\b)[\\w']+\\s+){0,2}(?:not(?! only)|never|neither|nor|cannot)\\b|(?:(?!(?:and|or|but)\\b)[\\w']+\\s+){0,1}\\w+n't\\b|no\\b|(?:(?:is|are|was|were|remains?|stays?)\\s+)?(?:unavailable|excluded|off the (?:menu|table)|discontinued)\\b)`, 'i');

// A numbered marker is 1–3 digits: "2024. Waves was …" is a year, not item 2024.
const LIST_MARKER_RE = /^[ \t]*(?:[-*+\u2022]|\d{1,3}[.)])[ \t]+/;

const URL_RE = /https?:\/\/[^\s)<>\]"']+|\btel:\+?[\d-]+|\bmailto:[^\s)>]+/gi;

// Engines answer in Markdown with typographic quotes. Scoring reads plain
// prose: emphasis and headings are stripped, and every URL (link destination
// or bare link) is lifted out so a path like /fumigation/ can never become an
// assertion; the URLs are returned separately for scope:'any' facts. List
// items stay on their own lines (each item is its own assertion) EXCEPT under
// a negated list intro ("does not offer:"), whose items are joined into one
// comma list so the intro governs every one of them.
function stripEmphasis(line) {
  return line
    .replace(/^[ \t]*#{1,6}[ \t]+/, '')
    .replace(/[*`~]+/g, '')
    .replace(/(^|[\s(])_+|_+(?=[\s).,;:!?]|$)/g, '$1');
}

function normalizeAnswer(text) {
  const urls = [];
  const flat = String(text || '')
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, href) => { urls.push(href); return label; })
    .replace(URL_RE, url => { urls.push(url); return ' '; });
  const lines = [];
  let governed = false;
  for (const raw of flat.split('\n')) {
    // Detect the list marker BEFORE stripping emphasis: "* item" is a bullet.
    const isItem = LIST_MARKER_RE.test(raw);
    const line = stripEmphasis(raw.replace(LIST_MARKER_RE, '')).trim();
    // A blank line between an intro and its items, or between items, does
    // not end the governed list; only a following non-item line does.
    if (!line) continue;
    // Items under a negated intro join as one comma list; an item's own
    // trailing period must not end the clause the intro governs.
    if (isItem && governed) { lines[lines.length - 1] += `, ${line.replace(/[.;!?]+$/, '')}`; continue; }
    if (!isItem) {
      const intro = line.replace(/:\s*$/, '');
      governed = /:\s*$/.test(line) && LIST_INTRO_RE.test(intro) && NEGATION_RE.test(intro.slice(-40));
      lines.push(governed ? `${intro}:` : line);
      continue;
    }
    lines.push(line);
  }
  return { prose: lines.join('\n').replace(/:\n/g, ': ').replace(/:,\s*/g, ': '), urls: urls.join('\n') };
}

// An assertion only counts for or against Waves when Waves is its subject.
// The subject is the last NAMED party before the match (Waves / Adam / a
// competitor from `other_entities`), read after comparison phrases are
// removed ("Unlike Waves, Orkin offers fumigation" is about Orkin). A
// pronoun ("it", "they") or a subject-less coordinated clause ("… and is a
// franchise") inherits that last named subject, across sentences. With no
// named party at all the answer is taken to be about Waves.
const OTHER_ENTITY_RE = new RegExp(`\\b(?:${cohort.other_entities.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi');
const WAVES_NAMED_RE = /\bwaves\b|\badam\b|\bbenetti\b|\bwe\b|\bour\b/gi;
// Sentence-initial capitalization is accepted for the intro word; the
// compared party must still be a proper name.
// A compared party that governs a following relative clause ("unlike Orkin,
// which was founded in 1901") stays in the text as that clause's subject.
const COMPARISON_PHRASE_RE = /\b(?:[Uu]nlike|[Ll]ike|[Ss]uch as|[Cc]ompared (?:to|with)|[Vv]ersus|[Vv]s\.?|[Rr]ather than|[Ii]nstead of)\s+[A-Z][\w'&-]+\b(?:\s+[A-Z][\w'&-]+\b){0,2},?(?!\s*,?\s*(?:which|who|that|whose)\b)/g;
const COMPARISON_INTRO_RE = /\b(?:[Uu]nlike|[Ll]ike|[Ss]uch as|[Cc]ompared (?:to|with)|[Vv]ersus|[Vv]s\.?|[Rr]ather than|[Ii]nstead of)\s+[A-Z][\w'&-]+(?:\s+[A-Z][\w'&-]+){0,2},?\s*$/;

const REFERRAL_RE = new RegExp(`\\b(?:contact|call|try|use|see|hire|choose|consider|recommends?|refer(?:s|red)? (?:you )?to|ask)\\s+(?:\\w+\\s+){0,2}(?:${cohort.other_entities.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');

function lastIndexOfMatch(re, text) {
  let last = -1;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) last = m.index;
  return last;
}

// A competitor named as an OBJECT ("not affiliated with Orkin", "owned by
// Orkin", "rather than Orkin") is not the subject a later pronoun inherits;
// only a competitor in subject position is.
const OBJECT_INTRO_RE = /\b(?:with|by|to|from|of|than|against|as|not|nor|or|and|including|includes?|versus|vs\.?)\s+(?:the\s+|a\s+|an\s+)?$/i;

function lastSubjectIndex(re, text) {
  let last = -1;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) if (!OBJECT_INTRO_RE.test(text.slice(0, m.index))) last = m.index;
  return last;
}

function aboutAnotherEntity(beforeClause, answerPrefix) {
  if (COMPARISON_INTRO_RE.test(beforeClause)) return true;
  const named = answerPrefix.replace(COMPARISON_PHRASE_RE, ' ');
  return lastSubjectIndex(OTHER_ENTITY_RE, named) > lastIndexOfMatch(WAVES_NAMED_RE, named);
}

function matchesAnywhere(compiled, text) {
  compiled.scanRe.lastIndex = 0;
  const hit = compiled.scanRe.test(text);
  compiled.scanRe.lastIndex = 0;
  return hit;
}

// A claim that captures a value ("founded in 2019", "based in Tampa") is
// not wrong when the captured value is the approved one.
function approvedValue(compiled, captured) {
  return (compiled.rejectValue !== undefined && captured.includes(compiled.rejectValue))
    || (compiled.rejectRe !== undefined && compiled.rejectRe.test(captured));
}

function asserted(compiled, answer) {
  for (const match of answer.matchAll(compiled.scanRe)) {
    // The captured value is the first defined group (a pattern may capture in
    // any one of its alternatives).
    if (approvedValue(compiled, (match.slice(1).find(v => v !== undefined) || '').trim())) continue;
    const start = match.index;
    let end = start + match[0].length;
    // A pattern may stop mid-word ("fumigat"); the assertion is the whole word.
    while (end < answer.length && /[\w-]/.test(answer[end])) end++;
    // Hyphenated negation: "non-fumigation", "non-franchised", "fumigation-free".
    if (/\bnon-?$/i.test(answer.slice(Math.max(0, start - 4), start))) continue;
    if (/-(?:free|less)$/i.test(answer.slice(start, end))) continue;
    // Clause boundaries are found on the full text, never a fixed window: a
    // governed list can run well past 80 characters before its last item.
    // A standalone "Yes," / "No," opener answers the question; it does not
    // negate the assertion that follows ("No, they are not the same company").
    const before = leadClause(answer.slice(0, start)).replace(/^\s*(?:yes|no)\s*[,.!:;-]\s*/i, '');
    const after = trailClause(answer.slice(end), before.trim() === '');
    // Facts and claims alike must be about Waves: "Orkin serves Manatee"
    // earns no footprint credit and "Orkin is a franchise" is no wrong claim.
    if (aboutAnotherEntity(before, answer.slice(0, start))) continue;
    // Passive attribution after the match: "fumigation is offered by Orkin".
    const agent = after.match(/^\s*(?:is|are|was|were|gets?|comes)?\s*\w*\s*(?:by|from|through)\s+([A-Z][\w'&-]+(?:\s+[A-Z][\w'&-]+){0,2})/);
    if (agent && lastIndexOfMatch(OTHER_ENTITY_RE, agent[1]) >= 0 && lastIndexOfMatch(WAVES_NAMED_RE, agent[1]) < 0) continue;
    // A referral in the same sentence ("For fumigation services, contact
    // Orkin") is about the competitor, not a Waves service.
    const sentence = answer.slice(0, start).split(/[.!?;\n]/).pop() + answer.slice(start).split(/[.!?;\n]/)[0];
    if (REFERRAL_RE.test(sentence)) continue;
    // A negation INSIDE the match ("bond is not optional") also denies it,
    // unless the pattern deliberately matched a negated phrase from its first
    // word ("not a franchise" as evidence of independence). Only the match's
    // final clause counts: "bond is not optional but renews annually" still
    // asserts annual renewal.
    const innerClause = match[0].split(CLAUSE_BOUNDARY_RE).pop();
    const inner = NEGATION_RE.exec(innerClause);
    const innerAtStart = inner && inner.index === 0 && innerClause === match[0];
    if ((inner && !innerAtStart) || NEGATION_RE.test(before) || AFTER_NEGATION_RE.test(after)) continue;
    return true;
  }
  return false;
}

const FACTS = Object.fromEntries(Object.entries(cohort.facts).map(([key, def]) => [key, compile(def)]));
const CLAIMS = Object.fromEntries(Object.entries(cohort.claims).map(([key, def]) => [key, compile(def)]));
const questionByQuery = new Map(cohort.questions.map(q => [q.query, q]));

for (const question of cohort.questions) {
  for (const key of question.expect) if (!FACTS[key]) throw new Error(`aeo entity cohort: ${question.id} expects unknown fact "${key}"`);
  for (const key of question.forbid) if (!CLAIMS[key]) throw new Error(`aeo entity cohort: ${question.id} forbids unknown claim "${key}"`);
}
for (const key of cohort.global_forbid) if (!CLAIMS[key]) throw new Error(`aeo entity cohort: global_forbid names unknown claim "${key}"`);

function entityQuestion(query) {
  return questionByQuery.get(query) || null;
}

function isEntityQuestion(query) {
  return questionByQuery.has(query);
}

/**
 * Score one answer against its cohort question. Returns null for queries
 * outside the cohort so callers can store the result as-is.
 */
function scoreEntityAnswer(query, text) {
  const question = entityQuestion(query);
  if (!question) return null;
  const { prose, urls } = normalizeAnswer(text);
  const expected = {};
  for (const key of question.expect) {
    const fact = FACTS[key];
    expected[key] = asserted(fact, prose) || (fact.scope === 'any' && matchesAnywhere(fact, urls));
  }
  const forbidden = {};
  for (const key of new Set([...cohort.global_forbid, ...question.forbid])) {
    forbidden[key] = asserted(CLAIMS[key], prose);
  }
  const right = Object.values(expected).filter(Boolean).length;
  return {
    cohort: cohort.version,
    id: question.id,
    expected,
    forbidden,
    right,
    missing: question.expect.length - right,
    wrong: Object.values(forbidden).filter(Boolean).length,
  };
}

function asEntityFacts(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

/** A fact score needs an answer; it does not need resolved citations. */
function isScorableAnswer(row) {
  return row.measurement_version === MEASUREMENT_VERSION && row.answer_available === true && !!asEntityFacts(row.entity_facts);
}

function topLabels(counts, dictionary, limit = 3) {
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([key, count]) => ({ key, label: dictionary[key]?.label || key, count }));
}

function summarizeEntityObservations(rows) {
  const scored = rows.filter(isScorableAnswer).map(row => asEntityFacts(row.entity_facts));
  let right = 0;
  let missing = 0;
  let withWrong = 0;
  const missingCounts = new Map();
  const wrongCounts = new Map();
  for (const facts of scored) {
    right += Number(facts.right) || 0;
    missing += Number(facts.missing) || 0;
    if ((Number(facts.wrong) || 0) > 0) withWrong++;
    for (const [key, present] of Object.entries(facts.expected || {})) {
      if (!present) missingCounts.set(key, (missingCounts.get(key) || 0) + 1);
    }
    for (const [key, hit] of Object.entries(facts.forbidden || {})) {
      if (hit) wrongCounts.set(key, (wrongCounts.get(key) || 0) + 1);
    }
  }
  const checked = right + missing;
  return {
    total: rows.length,
    observed: scored.length,
    factsRight: right,
    factsMissing: missing,
    factAccuracy: checked ? Math.round(100 * right / checked) : null,
    wrongClaims: withWrong,
    wrongClaimRate: scored.length ? Math.round(100 * withWrong / scored.length) : null,
    missingMostOften: topLabels(missingCounts, FACTS),
    wrongMostOften: topLabels(wrongCounts, CLAIMS),
  };
}

function groupEntityObservations(rows, keyFor) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups].map(([key, observations]) => ({ key, ...summarizeEntityObservations(observations) }));
}

/**
 * Dashboard block over the latest observation per question × engine × model.
 * `grid` is the prober's current grid; only cohort questions are read.
 */
function buildEntityDashboard(grid, queries) {
  const rows = grid.filter(row => questionByQuery.has(row.query));
  const managed = new Set(queries.map(q => q.query));
  return {
    version: cohort.version,
    questions: cohort.questions.length,
    activeQuestions: cohort.questions.filter(q => managed.has(q.query)).length,
    observedQuestions: new Set(rows.filter(isScorableAnswer).map(row => row.query)).size,
    ...summarizeEntityObservations(rows),
    byPlatform: groupEntityObservations(rows, row => `${row.llm_platform} · ${row.model_version || 'legacy'}`),
    byQuestion: cohort.questions.map(question => ({
      key: `${question.id} · ${question.query}`,
      id: question.id,
      query: question.query,
      kind: question.kind,
      ...summarizeEntityObservations(rows.filter(row => row.query === question.query)),
    })),
  };
}

module.exports = {
  ENTITY_COHORT: cohort,
  entityQuestion,
  isEntityQuestion,
  scoreEntityAnswer,
  asEntityFacts,
  isScorableAnswer,
  summarizeEntityObservations,
  buildEntityDashboard,
};
