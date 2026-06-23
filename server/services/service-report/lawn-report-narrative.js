/**
 * Lawn Report V2 — narrative humanizer.
 *
 * The deterministic builders (lawn-visual-diagnosis / lawn-report-insights /
 * lawn-report-v2) decide WHAT is true: which insights exist, their priority/status,
 * the scores, the products applied, the water/mowing facts. That structure is the
 * GROUNDING and the safety FALLBACK.
 *
 * This layer rewrites only the PROSE through the VOICE model so the copy varies from
 * one visit to the next and never reads canned. Every produced string is run through
 * the same banned-copy guard as the other customer-facing AI copy; any field that is
 * empty or fails the guard falls back to the deterministic sentence. So the report is
 * always safe and complete even if the model is unavailable.
 *
 * Generation is keyed by a hash of the grounding facts, so the same visit yields the
 * same copy across report re-views (report tokens are permanent), while a different
 * visit gets different copy. (Process-local cache here; persisting at completion is a
 * noted follow-up.)
 */

const crypto = require('crypto');
const MODELS = require('../../config/models');
const logger = require('../logger');
const { callAnthropic } = require('../llm/call');
const { findBannedCustomerCopy } = require('./activity-indicators');

const PROMPT_VERSION = 'lawn_report_v2_narrative_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _cache = new Map();

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// Only the FACTS that should drive copy — not the deterministic prose itself, so the
// model writes fresh rather than paraphrasing our fallback sentences.
function groundingFacts(v2, ctx) {
  return {
    overallScore: v2.snapshot?.overallScore ?? null,
    overallStatus: v2.snapshot?.status ?? null,
    grassLabel: ctx.grassLabel || 'lawn',
    diagnosis: (v2.diagnosis || []).map((d) => ({ key: d.key, label: d.label, score: d.score, status: d.status })),
    water: v2.water ? { status: v2.water.status, rain: v2.water.rainInches, irrigation: v2.water.irrigationInches, total: v2.water.totalInches, target: v2.water.targetInches, confidence: v2.water.confidence } : null,
    mowing: v2.mowing ? { status: v2.mowing.status, measured: v2.mowing.measuredHeightInches, idealMin: v2.mowing.idealMinInches, idealMax: v2.mowing.idealMaxInches } : null,
    treatment: v2.treatment ? { focus: v2.treatment.focus, products: (v2.treatment.products || []).map((p) => ({ name: p.name, activeIngredient: p.activeIngredient, kind: p.kind, whatItDoes: p.whatItDoes, targets: p.targets })) } : null,
    trendDirection: trendDirection(v2.trends?.overall),
    insights: (v2.insights || []).map((i) => ({ category: i.category, status: i.status, priority: i.priority })),
    observations: String(ctx.observations || '').slice(0, 600),
    customerConcern: String(ctx.customerConcern || '').slice(0, 300),
  };
}

function trendDirection(points) {
  const pts = (points || []).map((p) => Number(p.value)).filter(Number.isFinite);
  if (pts.length < 2) return 'none';
  const delta = pts[pts.length - 1] - pts[0];
  if (delta >= 4) return 'up';
  if (delta <= -4) return 'down';
  return 'flat';
}

const SYSTEM_PROMPT = `# LAWN REPORT V2 — CUSTOMER COPY (VOICE)

You rewrite the customer-facing copy for a post-service LAWN report for Waves Pest Control & Lawn Care (Southwest Florida). You are given the STRUCTURED FACTS for ONE visit. Turn them into warm, precise, plain-English copy that reads written for THIS exact visit.

## VARIATION (the whole point)
- Vary your wording, sentence openings, and rhythm every time. Two different visits must never read the same.
- Do NOT reuse stock phrases. Nothing generic, nothing templated. If a sentence could be pasted onto another customer's report unchanged, rewrite it.
- Lead from whatever is most specific to this visit (the named issue, the product, the score that moved).

## HARD CONSTRAINTS (override everything)
1. Only state what the FACTS support. Never invent a finding, product, number, weed, or pest.
2. No overpromising: never "eliminate", "guarantee", "100%", "pest-free", "cure". Use "reduce", "manage", "support".
3. Photo AI shows PATTERNS, not confirmed diagnoses. Never assert a specific disease or insect as confirmed — say "signals"/"patterns we're watching" unless a fact marks it tech-confirmed.
4. Never say the lawn is "improving"/"recovering"/"better" unless trendDirection is "up". If "down", be honest but calm; if "none", don't reference a trend.
5. Water: if water.status is "balanced" or "high", do NOT tell the customer to water more — point to coverage or easing back. Only suggest more water when status is "low".
6. Mowing: Waves does NOT mow. Frame mowing as how the lawn is being kept and a suggestion to the customer; never say Waves will fix it.
7. Use active-ingredient names or plain descriptions for products — never hype.
8. Plain text only. No markdown, no emojis, no headers inside values.

## OUTPUT — JSON ONLY, exactly this shape (no prose outside it):
{
  "statusHeadline": "<=8 words, the one-line state for the hero",
  "mainWatch": "one sentence: the main thing to watch (or empty if nothing)",
  "customerAction": "one sentence: the single next step for the customer (or empty)",
  "categories": { "<categoryKey>": "one short sentence per category key you were given" },
  "water": "2-3 sentences explaining the water picture for this visit",
  "mowing": "1-2 sentences on mowing height (only if mowing facts given)",
  "treatmentSummary": "1 sentence on what was applied and why (only if products given)",
  "insights": [ { "headline": "...", "whatWeSaw": "...", "whyItMatters": "...", "wavesAction": "...", "customerAction": "...", "nextVisitPlan": "..." } ]
}
The "insights" array MUST be the same length and order as the input insights. For each, fill customerAction OR nextVisitPlan to match which the input had (leave the other "").`;

function buildUserMessage(facts) {
  return `STRUCTURED FACTS for this visit (rewrite the copy from these — do not copy these words):\n\n${JSON.stringify(facts, null, 2)}\n\nReturn the JSON now.`;
}

// Replace a deterministic string with the model's version only if it's a non-empty,
// non-banned string. Otherwise keep the safe deterministic copy.
function safeText(modelValue, fallback) {
  const t = typeof modelValue === 'string' ? modelValue.trim() : '';
  if (!t) return fallback;
  if (findBannedCustomerCopy(t).length) return fallback;
  return t;
}

function mergeNarrative(v2, out) {
  if (!out || typeof out !== 'object') return v2;
  const next = JSON.parse(JSON.stringify(v2));

  if (next.snapshot) {
    next.snapshot.statusHeadline = safeText(out.statusHeadline, next.snapshot.statusHeadline);
    next.snapshot.mainWatch = next.snapshot.mainWatch ? safeText(out.mainWatch, next.snapshot.mainWatch) : next.snapshot.mainWatch;
    next.snapshot.customerAction = next.snapshot.customerAction ? safeText(out.customerAction, next.snapshot.customerAction) : next.snapshot.customerAction;
  }
  const cats = out.categories || {};
  next.diagnosis = (next.diagnosis || []).map((d) => {
    const v = safeText(cats[d.key], d.explanation || d.customerExplanation);
    return { ...d, explanation: v, customerExplanation: v };
  });
  if (next.water) next.water.explanation = safeText(out.water, next.water.explanation);
  if (next.mowing) next.mowing.recommendation = safeText(out.mowing, next.mowing.recommendation);
  if (next.treatment && typeof out.treatmentSummary === 'string') {
    next.treatment.summary = safeText(out.treatmentSummary, next.treatment.summary || '');
  }
  if (Array.isArray(out.insights) && Array.isArray(next.insights)) {
    next.insights = next.insights.map((ins, i) => {
      const m = out.insights[i] || {};
      return {
        ...ins,
        headline: safeText(m.headline, ins.headline),
        whatWeSaw: safeText(m.whatWeSaw, ins.whatWeSaw),
        whyItMatters: safeText(m.whyItMatters, ins.whyItMatters),
        wavesAction: safeText(m.wavesAction, ins.wavesAction),
        customerAction: ins.customerAction ? safeText(m.customerAction, ins.customerAction) : ins.customerAction,
        nextVisitPlan: ins.nextVisitPlan ? safeText(m.nextVisitPlan, ins.nextVisitPlan) : ins.nextVisitPlan,
      };
    });
  }
  return next;
}

/**
 * Overlay LLM-written copy onto a deterministic V2 report object. Best-effort:
 * returns the input unchanged on any miss. `callModel` is injectable for tests.
 *
 * @param {object} v2   buildLawnReportV2(...) output
 * @param {object} ctx  { grassLabel, observations, customerConcern }
 * @param {object} deps { callModel?: async ({system,text}) => ({ ok, json }) }
 */
async function applyLawnReportNarrative(v2, ctx = {}, deps = {}) {
  if (!v2) return v2;
  const facts = groundingFacts(v2, ctx);
  const cacheKey = crypto.createHash('sha256').update(`${PROMPT_VERSION}|${stableStringify(facts)}`).digest('hex');
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const callModel = deps.callModel || ((payload) => callAnthropic({ model: MODELS.VOICE, jsonMode: true, maxTokens: 1300, ...payload }));

  let merged = v2;
  try {
    const res = await callModel({ system: SYSTEM_PROMPT, text: buildUserMessage(facts) });
    if (res && res.ok && res.json) {
      merged = mergeNarrative(v2, res.json);
    } else {
      logger.warn(`[lawn-report-v2] narrative miss (${res && res.reason}); using deterministic copy`);
    }
  } catch (err) {
    logger.warn(`[lawn-report-v2] narrative failed: ${err.message}; using deterministic copy`);
  }

  _cache.set(cacheKey, { at: Date.now(), value: merged });
  if (_cache.size > 300) _cache.delete(_cache.keys().next().value);
  return merged;
}

module.exports = {
  applyLawnReportNarrative,
  // exported for tests
  _test: { groundingFacts, mergeNarrative, trendDirection, safeText, SYSTEM_PROMPT, buildUserMessage, PROMPT_VERSION },
};
