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

function compile(def) {
  const flags = typeof def.flags === 'string' ? def.flags : 'i';
  return {
    label: def.label,
    scanRe: new RegExp(def.pattern, flags.includes('g') ? flags : `${flags}g`),
    rejectValue: typeof def.reject_value === 'string' ? def.reject_value : undefined,
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
const CLAUSE_BOUNDARY_RE = /[.!?;\n]|,?\s+(?:but|however|whereas|although|though|yet)\b|,?\s+(?:and|or)\s+(?=(?:\w+\s+){0,2}(?:is|are|was|were|does|do|did|offers?|provides?|has|have|will|can|covers?|includes?|charges?|treats?|serves?|handles?|performs?|operates?|holds?)\b)/i;
// "does not offer: fumigation, insulation" — a negated verb right before a
// colon governs the list that follows; "is not a franchise: it offers …" does not.
const LIST_INTRO_RE = /\b(?:offer|offers|include|includes|provide|provides|cover|covers|do|does|perform|performs|treat|treats|handle|handles|sell|sells|service|services|are|is)\s*$/i;
const CLAUSE_WINDOW = 80;

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

const LIST_MARKER_RE = /^[ \t]*(?:[-*+\u2022]|\d+[.)])[ \t]+/;

// Engines answer in Markdown with typographic quotes. Scoring reads plain
// prose: emphasis and headings are stripped and a link keeps its text AND its
// URL. List items stay on their own lines (each item is its own assertion)
// EXCEPT under a negated list intro ("does not offer:"), whose items are
// joined into one comma list so the intro governs every one of them.
function normalizeAnswer(text) {
  const flat = String(text || '')
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')
    .replace(/[*`~]+/g, '')
    .replace(/(^|[\s(])_+|_+(?=[\s).,;:!?]|$)/g, '$1');
  const lines = [];
  let governed = false;
  for (const raw of flat.split('\n')) {
    const isItem = LIST_MARKER_RE.test(raw);
    const line = raw.replace(LIST_MARKER_RE, '').trim();
    if (!line) { governed = false; continue; }
    if (isItem && governed) { lines[lines.length - 1] += `, ${line}`; continue; }
    if (!isItem) {
      const intro = line.replace(/:\s*$/, '');
      governed = /:\s*$/.test(line) && LIST_INTRO_RE.test(intro) && NEGATION_RE.test(intro.slice(-40));
      lines.push(governed ? `${intro}:` : line);
      continue;
    }
    lines.push(line);
  }
  return lines.join('\n').replace(/:\n/g, ': ').replace(/:,\s*/g, ': ');
}

// A claim only counts against Waves when Waves (or a pronoun standing for it)
// is the subject. "Unlike Orkin, a franchise, Waves is independently owned"
// and "Orkin is a franchise" describe another company.
const OTHER_ENTITY_RE = new RegExp(`\\b(?:${cohort.other_entities.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i');
const WAVES_SUBJECT_RE = /\bwaves\b|\badam\b|\bbenetti\b|\bwe\b|\bour\b|\bit\b|\bits\b|\bthey\b|\btheir\b|\bthe (?:company|business|firm|llc|operator)\b/i;
const COMPARISON_INTRO_RE = /\b(?:unlike|like|such as|compared (?:to|with)|versus|vs\.?|rather than|instead of)\s+[A-Z][\w'&-]+(?:\s+[A-Z][\w'&-]+){0,2},?\s*$/;

function aboutAnotherEntity(before) {
  if (COMPARISON_INTRO_RE.test(before)) return true;
  return OTHER_ENTITY_RE.test(before) && !WAVES_SUBJECT_RE.test(before);
}

function asserted(compiled, answer, { attributed = false } = {}) {
  for (const match of answer.matchAll(compiled.scanRe)) {
    if (compiled.rejectValue !== undefined && match[1] === compiled.rejectValue) continue;
    const start = match.index;
    const end = start + match[0].length;
    const before = leadClause(answer.slice(Math.max(0, start - CLAUSE_WINDOW), start));
    const after = trailClause(answer.slice(end, end + CLAUSE_WINDOW), before.trim() === '');
    if (attributed && aboutAnotherEntity(before)) continue;
    // A negation INSIDE the match ("bond is not optional") also denies it,
    // unless the pattern deliberately matched a negated phrase from its first
    // word ("not a franchise" as evidence of independence).
    const inner = NEGATION_RE.exec(match[0]);
    if ((inner && inner.index > 0) || NEGATION_RE.test(before) || NEGATION_RE.test(after)) continue;
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
  const answer = normalizeAnswer(text);
  const expected = {};
  for (const key of question.expect) expected[key] = asserted(FACTS[key], answer);
  const forbidden = {};
  for (const key of new Set([...cohort.global_forbid, ...question.forbid])) {
    forbidden[key] = asserted(CLAIMS[key], answer, { attributed: true });
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
