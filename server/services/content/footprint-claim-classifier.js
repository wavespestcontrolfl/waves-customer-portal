/**
 * footprint-claim-classifier.js — async LLM refinement for the deterministic
 * off-footprint service-claim gate in content-guardrails.
 *
 * Division of labor (owner-directed 2026-07-24, ending the heuristic
 * round-trading on the footprint gate):
 *   - content-guardrails' regex layer stays the cheap, deterministic
 *     PRE-FILTER: high recall on "out-of-area city + service-claim context".
 *     It runs everywhere evaluate() runs (sync callers included) and its
 *     verdict alone is always fail-closed.
 *   - THIS module is the publish-time refinement: each flagged
 *     (city, rendered clause) pair is put to a small cross-provider model
 *     ("does this text claim Waves serves that city?"), and a finding whose
 *     every pair the model rejects is dismissed as a false positive.
 *     New linguistic nuance lands HERE (one prompt), not as new regex arms
 *     duplicated across the portal and astro gates.
 *
 * Failure posture: any LLM failure, oversized evidence list, or malformed
 * verdict keeps the deterministic finding — refinement can only DISMISS a
 * false positive, never create a publish window the regex layer closed.
 */

const crypto = require('node:crypto');
const logger = require('../logger');
const MODELS = require('../../config/models');
const { dispatchWithFallback } = require('../llm/call');

// Refinement is for pinpoint findings; a draft with a wall of flagged pairs
// is not a subtle false positive. Skip refinement entirely (fail closed).
const MAX_EVIDENCE_PAIRS = 8;
const CACHE_MAX = 500;
const CALL_TIMEOUT_MS = 20_000;

// (city|clause) → verdict. Content re-evaluates on every remediation loop;
// identical clauses must not re-bill or wobble between rounds.
const verdictCache = new Map();

function cacheKey(city, clause) {
  return crypto.createHash('sha256').update(`${city}|${clause}`).digest('hex');
}

function footprintLists() {
  let served = [];
  try {
    const { CITY_TO_LOCATION } = require('../../config/locations');
    served = Object.keys(CITY_TO_LOCATION || {});
  } catch { served = []; }
  let outOfArea = [];
  try {
    ({ OUT_OF_AREA_CITY_CANDIDATES: outOfArea } = require('./content-guardrails'));
  } catch { outOfArea = []; }
  return { served, outOfArea: [...outOfArea] };
}

function systemPrompt() {
  const { served, outOfArea } = footprintLists();
  return [
    'You audit marketing copy for Waves Pest Control, a Florida pest control and lawn care company.',
    served.length ? `Cities Waves ACTUALLY serves: ${served.join(', ')}.` : '',
    outOfArea.length ? `Cities OUTSIDE the Waves service footprint: ${outOfArea.join(', ')}.` : '',
    'You are given ONE rendered sentence/clause from site copy and ONE out-of-footprint city named in it.',
    'Answer whether a typical reader would understand the text as claiming, offering, or implying that Waves provides service in that city.',
    'NOT service claims (false): honest disclaimers ("Naples is outside our service area"), negations ("we do not serve Tampa"), factual/educational/editorial mentions (pest research, weather, geography, travel, news), directions or distance references, competitor or third-party mentions.',
    'Service claims (true): "we serve/treat/cover/inspect …", CTA framing ("call us for a quote in Cape Coral"), availability claims, and SEO-style service packaging with no explicit verb ("Naples pest control guide", "Need mosquito control in Cape Coral?").',
    'Reply with JSON only: {"is_service_claim": true|false, "reason": "<one short sentence>"}',
  ].filter(Boolean).join('\n');
}

/**
 * Classify one (city, clause) pair. Returns { is_service_claim, reason }
 * or null on any failure (missing keys, provider outage, malformed output).
 */
async function classifyFootprintEvidence({ city, clause } = {}) {
  const c = String(city || '').trim();
  const text = String(clause || '').trim();
  if (!c || !text) return null;
  const key = cacheKey(c, text);
  if (verdictCache.has(key)) return verdictCache.get(key);

  const result = await dispatchWithFallback(
    MODELS.TEXT_POLICIES.fastStructured,
    {
      maxTokens: 200,
      jsonMode: true,
      timeoutMs: CALL_TIMEOUT_MS,
      system: systemPrompt(),
      text: `CITY: ${c}\nRENDERED COPY: ${text}\n\nDoes this copy claim Waves provides service in ${c}?`,
    },
    {
      validate: (r) => (typeof r?.json?.is_service_claim === 'boolean' ? null : 'missing_is_service_claim'),
    },
  );
  if (!result?.ok || typeof result.json?.is_service_claim !== 'boolean') {
    logger.warn(`[footprint-classifier] classification failed for "${c}" (${result?.reason || 'invalid_json'}) — deterministic finding stands`);
    return null;
  }
  const verdict = {
    is_service_claim: result.json.is_service_claim,
    reason: String(result.json.reason || '').slice(0, 200),
  };
  if (verdictCache.size >= CACHE_MAX) {
    verdictCache.delete(verdictCache.keys().next().value);
  }
  verdictCache.set(key, verdict);
  return verdict;
}

/**
 * Publish-time refinement over a guardrails findings list. Returns the same
 * list, minus an OFF_FOOTPRINT_CITY_CLAIM finding whose EVERY evidence pair
 * the classifier rejected as a non-claim. Anything short of a unanimous,
 * successful rejection keeps the finding (fail closed). Never throws.
 */
async function refineFootprintFindings(findings) {
  if (!Array.isArray(findings)) return findings;
  const idx = findings.findIndex(
    (f) => f?.code === 'OFF_FOOTPRINT_CITY_CLAIM' && Array.isArray(f.evidence) && f.evidence.length > 0,
  );
  if (idx === -1) return findings;
  const target = findings[idx];
  if (target.evidence.length > MAX_EVIDENCE_PAIRS) {
    logger.info(`[footprint-classifier] ${target.evidence.length} flagged pairs exceeds refinement bound (${MAX_EVIDENCE_PAIRS}) — deterministic finding stands`);
    return findings;
  }
  try {
    const verdicts = [];
    for (const pair of target.evidence) {
      // Sequential on purpose: lists are ≤MAX_EVIDENCE_PAIRS and the cache
      // absorbs remediation-loop repeats; parallel fan-out here just spikes
      // provider rate limits during bulk republish sweeps.
      verdicts.push(await classifyFootprintEvidence(pair));
    }
    if (verdicts.some((v) => !v)) return findings;
    if (verdicts.every((v) => v.is_service_claim === false)) {
      logger.info(`[footprint-classifier] dismissed OFF_FOOTPRINT_CITY_CLAIM as non-claim copy: ${target.evidence.map((p, i) => `"${p.city}" (${verdicts[i].reason})`).join('; ')}`);
      return findings.filter((_, i) => i !== idx);
    }
    return findings;
  } catch (err) {
    logger.warn(`[footprint-classifier] refinement threw (${err.message}) — deterministic finding stands`);
    return findings;
  }
}

module.exports = {
  classifyFootprintEvidence,
  refineFootprintFindings,
  _internals: { verdictCache, cacheKey, systemPrompt, MAX_EVIDENCE_PAIRS },
};
