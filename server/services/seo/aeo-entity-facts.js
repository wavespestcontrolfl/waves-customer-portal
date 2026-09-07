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
    re: new RegExp(def.pattern, flags),
    unlessRe: def.unless ? new RegExp(def.unless, flags) : null,
  };
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
  const answer = String(text || '');
  const expected = {};
  for (const key of question.expect) expected[key] = FACTS[key].re.test(answer);
  const forbidden = {};
  for (const key of new Set([...cohort.global_forbid, ...question.forbid])) {
    const claim = CLAIMS[key];
    forbidden[key] = claim.re.test(answer) && !(claim.unlessRe && claim.unlessRe.test(answer));
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
