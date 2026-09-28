/**
 * business-name-confirmer.js — decides which of a draft's uncurated
 * business-name CANDIDATES are actual companies (owner rulings 2026-09-27
 * D2 + 2026-09-28: an unattended competitor blog may name only the six
 * owner-approved competitors).
 *
 * Division of labor (the footprint-claim-classifier pattern): the
 * comparison-table gate's businessNameCandidates() is the cheap,
 * deterministic, HIGH-RECALL pre-filter ("Acme Pest Solutions", "Biological
 * Pest Control", a link to acme-pest-solutions.com); this module is one
 * structured FAST-tier call per draft that answers "which of these phrases
 * name a real business?" ("Acme Pest Solutions competes with Orkin" → yes;
 * "Biological Pest Control offers a way to reduce chemical use" → no).
 * New phrasing lands in this prompt, never as new word lists in the gate.
 *
 * Failure posture: any provider failure, oversized candidate list, or
 * answer that does not cover exactly the candidates asked returns
 * { ok: false } — the verdict (namedCompetitorListVerdict) then skips THAT
 * draft as named_competitor_unverified_names. A draft with no candidates
 * never calls this module.
 *
 * Reuse: the result carries `key` (businessNameCandidatesKey of the exact
 * candidates + sentences judged). A stored result whose key still matches
 * is returned as-is, so the merge-time poller never re-calls and a Codex
 * fix that leaves the candidates untouched reuses the run's confirmation.
 */

const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');
const { businessNameCandidatesKey } = require('./comparison-table-gate');

// One call per draft. A wall of candidates is not a subtle judgement —
// fail closed instead of sending an unbounded prompt.
const MAX_CANDIDATES = 20;
const CALL_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT = [
  'You review blog copy for Waves Pest Control, a Florida pest control and lawn care company.',
  'You are given candidate phrases found in a draft, each with the sentence (or link) it came from.',
  'For each candidate, answer whether it names an actual company or business (a pest control, lawn care, or any other firm — a competitor, supplier, franchise, or brand), as used in that sentence.',
  'NOT a business (false): a pest control method or concept ("Biological Pest Control", "Integrated Pest Management"), a service category or topic ("Home Pest Control", "Yard Mosquito Control"), a guide, heading, program, publication, government agency, university, extension service, law, or regulation.',
  'A business (true): a specific company name ("Acme Pest Solutions competes with Orkin", "Bob Smith Lawn Care LLC", a link to a company website).',
  'When a phrase could be either, answer true if the sentence treats it as a specific company.',
  'Answer every candidate exactly once, copying the candidate text exactly.',
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['candidate', 'is_business'],
        properties: {
          candidate: { type: 'string' },
          is_business: { type: 'boolean' },
        },
      },
    },
  },
};

function answersCover(json, candidates) {
  const rows = Array.isArray(json?.candidates) ? json.candidates : null;
  if (!rows || rows.length !== candidates.length) return false;
  const asked = new Set(candidates.map((c) => c.name));
  const seen = new Set();
  for (const r of rows) {
    if (typeof r?.is_business !== 'boolean' || !asked.has(r.candidate) || seen.has(r.candidate)) return false;
    seen.add(r.candidate);
  }
  return true;
}

/**
 * confirmBusinessNames(candidates, { prior }) →
 *   { ok: true,  key, companies: [name…], checked_at }
 *   { ok: false, key, reason }
 * Never throws. `prior` — a stored result; reused when its key matches.
 */
async function confirmBusinessNames(candidates, { prior = null } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const key = businessNameCandidatesKey(list);
  if (prior && prior.ok === true && prior.key === key && Array.isArray(prior.companies)) return prior;
  if (!list.length) return { ok: true, key, companies: [], checked_at: new Date().toISOString() };
  if (list.length > MAX_CANDIDATES) {
    return { ok: false, key, reason: `too_many_candidates:${list.length}` };
  }
  try {
    const result = await dispatchWithFallback(
      MODELS.TEXT_POLICIES.fastStructured,
      {
        laneId: 'business_name_confirm',
        maxTokens: 60 * list.length + 200,
        jsonMode: true,
        jsonSchema: RESPONSE_SCHEMA,
        timeoutMs: CALL_TIMEOUT_MS,
        system: SYSTEM_PROMPT,
        text: list.map((c, i) => `${i + 1}. CANDIDATE: ${c.name}\n   CONTEXT: ${c.sentence}`).join('\n'),
      },
      { validate: (r) => (answersCover(r?.json, list) ? null : 'answers_do_not_cover_candidates') },
    );
    if (!result?.ok || !answersCover(result.json, list)) {
      const reason = result?.reason || 'invalid_json';
      logger.warn(`[business-name-confirmer] confirmation failed (${reason}) — draft fails closed`);
      return { ok: false, key, reason: String(reason).slice(0, 200) };
    }
    const companies = result.json.candidates.filter((r) => r.is_business).map((r) => r.candidate).sort();
    return { ok: true, key, companies, checked_at: new Date().toISOString() };
  } catch (err) {
    logger.warn(`[business-name-confirmer] confirmation threw (${err.message}) — draft fails closed`);
    return { ok: false, key, reason: `threw:${String(err.message).slice(0, 180)}` };
  }
}

module.exports = {
  confirmBusinessNames,
  _internals: { SYSTEM_PROMPT, MAX_CANDIDATES, answersCover },
};
