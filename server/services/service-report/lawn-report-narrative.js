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

const { HUMAN_PROSE_RULES } = require('../llm/human-prose-rules');
const crypto = require('crypto');
const MODELS = require('../../config/models');
const logger = require('../logger');
const { dispatchWithFallback } = require('../llm/call');
const { findBannedCustomerCopy } = require('./activity-indicators');

const PROMPT_VERSION = 'lawn_report_v2_narrative_v4'; // v4: rain window rule — weekly total, never "since the last visit" (owner audit 07-30)
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
    water: v2.water ? { status: v2.water.status, rain: v2.water.rainInches, irrigation: v2.water.irrigationInches, total: v2.water.totalInches, target: v2.water.targetInches, confidence: v2.water.confidence, rainWindow: 'past 7 days ending on the visit date' } : null,
    mowing: v2.mowing && v2.mowing.measuredHeightInches != null ? { status: v2.mowing.status, measured: v2.mowing.measuredHeightInches, idealMin: v2.mowing.idealMinInches, idealMax: v2.mowing.idealMaxInches } : null,
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

${HUMAN_PROSE_RULES}


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
5b. The rain number is a PAST-7-DAYS total ending on the visit date. Describe the window as "this week" or "the past week" — NEVER "since the last visit", "this cycle", "between visits", or any wording tied to the visit schedule (visits are not weekly), and never present it as a single day's rain.
6. Mowing: Waves does NOT mow. Frame mowing as how the lawn is being kept and a suggestion to the customer; never say Waves will fix it.
7. Use active-ingredient names or plain descriptions for products — never hype. Lead with the product's plain-language role and never make a bare chemical name the subject of an instruction to the homeowner ("water in the clothianidin" → "water in today's treatment").
8. Plain text only. No markdown, no emojis, no headers inside values.
9. A product's "targets" list is what it is designed to control — NOT what was observed. Never say a pest or disease was found/observed unless the observations say so; frame targeted products as seasonal protection otherwise.

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

// The rain figure is a past-7-days total — model output that reframes the
// window as the visit interval ("since the last visit", "this cycle") or as
// a single day's rain is factually wrong whenever visits aren't weekly, and
// the prompt rule alone doesn't guarantee compliance (codex P1 #3093 r3:
// exactly this framing shipped on a live report).
const RAIN_WINDOW_PHRASES = new RegExp([
  // visit-interval framings
  '\\bsince\\s+(?:your|the|our)\\s+(?:last|previous)\\s+(?:visit|service|appointment|application|stop)\\b',
  '\\bsince\\s+we\\s+(?:last\\s+)?(?:visited|serviced|were|came|stopped)\\b',
  '\\bthis\\s+(?:service\\s+)?cycle\\b',
  '\\bbetween\\s+(?:visits|services|appointments)\\b',
  // single-day / sub-weekly framings — verb-first AND day-first orders
  // ("rain yesterday", "yesterday's rain" — codex P2 r27)
  '\\brain(?:fall)?\\s+(?:today|yesterday|overnight|last\\s+night)\\b',
  // named-weekday allocations — "Monday brought 4.23 inches of rain"
  // fabricates a daily measurement from the weekly total (codex P2 r41)
  // gap admits decimals ("4.23") but still stops at sentence enders
  '\\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\\b(?:\\d\\.\\d|[^.!?]){0,30}\\b(?:rain(?:fall)?|inch(?:es)?|precipitation)\\b',
  '\\b(?:rain(?:fall)?|inch(?:es)?|precipitation)\\b(?:\\d\\.\\d|[^.!?]){0,30}\\b(?:on\\s+)?(?:mon|tues|wednes|thurs|fri|satur|sun)day\\b',
  // amount-first day framing — "4.23 inches yesterday" (codex P2 r36)
  '\\binch(?:es)?\\b[^.!?]{0,25}\\b(?:today|yesterday|overnight|last\\s+night)\\b',
  '\\b(?:today|yesterday|overnight|last\\s+night)\\b[^.!?]{0,25}\\binch(?:es)?\\b',
  "\\b(?:today|yesterday|last\\s+night|overnight)[\u2019']s\\s+rain(?:fall)?\\b",
  '\\b(?:last|past)\\s+(?:\\d+|one|two|three|four|five|six|couple\\s+of|few)\\s+(?:day|days|hour|hours|hrs)\\b',
  '\\b(?:over|in|during)\\s+the\\s+(?:last|past)\\s+(?:day|\\d+\\s*hours)\\b',
].join('|'), 'i');

// Positive requirement for the water explanation (codex P1 r9: enumerating
// every invalid phrasing is unwinnable): the copy must NAME the weekly
// window, or it falls back to the deterministic sentence.
const WEEKLY_PHRASE_SRC = "(?:this\\s+(?:past\\s+)?week|the\\s+past\\s+week|past\\s+week|over\\s+the\\s+(?:past\\s+)?week|(?:last|past)\\s+(?:7|seven)\\s+days|weekly|for\\s+the\\s+week|week[’']s\\s+(?:rain|water))";
const RAIN_CLAIM_SRC = '(?:rain(?:fall)?|precipitation|inch(?:es)?|\\d+(?:\\.\\d+)?\\s*(?:in|\"))';
// The weekly phrase must QUALIFY the rain claim itself — "keep your weekly
// watering schedule" must not launder "4.23 inches yesterday" into a pass
// (codex P2 r36). Bounded same-clause gap, both word orders.
const WEEKLY_WINDOW_PHRASES = new RegExp(
  `\\b${RAIN_CLAIM_SRC}[^.!?]{0,60}\\b${WEEKLY_PHRASE_SRC}\\b|\\b${WEEKLY_PHRASE_SRC}\\b[^.!?]{0,60}${RAIN_CLAIM_SRC}`,
  'i',
);
const RAIN_TERMS = /\brain|\binch|\bprecipitation|\bwater/i;

// Replace a deterministic string with the model's version only if it's a
// non-empty, non-banned string that doesn't tie a rain/water amount to the
// wrong window. The window check applies to EVERY merged field (mainWatch,
// diagnosis explanations, insights — codex P1 r4), but only when the text
// also talks about rain/water: a trend claim like "weeds are down since the
// last visit" is legitimate (the prior visit IS the trend anchor).
function safeText(modelValue, fallback) {
  const t = typeof modelValue === 'string' ? modelValue.trim() : '';
  if (!t) return fallback;
  if (findBannedCustomerCopy(t).length) return fallback;
  if (RAIN_WINDOW_PHRASES.test(t) && RAIN_TERMS.test(t)) return fallback;
  return t;
}

// The water explanation is ALWAYS about the rain window — reject window
// phrases unconditionally there AND require the weekly window to be named
// (deny + affirm: the denylist catches known-bad framings, the positive
// check catches everything the list doesn't enumerate).
function safeWaterText(modelValue, fallback) {
  const t = safeText(modelValue, fallback);
  if (t === fallback) return t;
  if (RAIN_WINDOW_PHRASES.test(t)) return fallback;
  if (!WEEKLY_WINDOW_PHRASES.test(t)) return fallback;
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
  if (next.water) next.water.explanation = safeWaterText(out.water, next.water.explanation);
  // Photo-only rows have no measured height/status — don't let the model fill an
  // ungrounded mowing recommendation under the photo (Codex P1).
  if (next.mowing && next.mowing.measuredHeightInches != null) next.mowing.recommendation = safeText(out.mowing, next.mowing.recommendation);
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

  const callModel = deps.callModel || ((payload) => dispatchWithFallback(
    MODELS.TEXT_POLICIES.customerCopy,
    { jsonMode: true, maxTokens: 1300, ...payload },
  ));

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
  _test: { groundingFacts, mergeNarrative, trendDirection, safeText, safeWaterText, SYSTEM_PROMPT, buildUserMessage, PROMPT_VERSION },
};
